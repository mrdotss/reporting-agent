"""Tests for compile/sections.py — the section expander and its determinism guards.

Two guards are the point of this module:

1. **Anchor stability:** expanding the SAME definition twice produces IDENTICAL block id
   sets. An expander whose ids depend on iteration order rather than resolved order breaks
   replay's bit-identical-ledger assertion intermittently.

2. **Full determinism:** two calls to ``expand_sections`` with the same definition+view
   produce IDENTICAL ``BlockSpec`` tuples (not just identical ids — identical everything).

Task 3.4 adds a third: ``compile_document`` must produce a byte-identical ledger and anchor
set whether the same ``resource_table`` block arrives via a v3 ``sections`` array or a v2
``blocks`` array — see ``TestCompileDocumentSchemaVersionBranch`` below, which is the claim
the whole "a section is invisible below the AST" design decision rests on, tested rather than
asserted in a paragraph.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from reporting_agent.catalog.loader import (
    LoadedSectionCatalogue,
    SectionCatalogueEntry,
    SectionExpansionBlock,
    load_section_catalogue,
)
from reporting_agent.collect.snapshot import (
    ResourceSnapshot,
    SkuCapacity,
)
from reporting_agent.compile.sections import (
    AuthoredMatch,
    SectionDrift,
    compute_section_drift,
    expand_sections,
)
from reporting_agent.compile.blocks.base import RESOURCE_ID_CONFIG_KEY
from reporting_agent.compile.snapshot_view import SnapshotView, build_snapshot_view
from reporting_agent.errors import CompileFailedError
from snapshot_factory import (
    CPU,
    VM_TYPE,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_snapshot_document(
    resource_ids: list[str], *, resource_type: str | None = None
) -> dict:
    """Build a minimal real snapshot document with the given resource ids.

    `resource_type` overrides the record's type, for a section that scopes to something
    other than a VM.
    """
    from snapshot_factory import build as build_fixture
    from snapshot_factory import exact
    from snapshot_factory import resource_record as make_rec

    resources = []
    for rid in resource_ids:
        name = rid.rsplit("/", 1)[-1]
        rec = make_rec(resource_id=rid, name=name)
        if resource_type is not None:
            rec = {**rec, "resource_type": resource_type}
        resources.append(
            ResourceSnapshot(
                record=rec,
                sku=SkuCapacity(
                    name="Standard_D2s_v5",
                    vcpus_available=2,
                    memory_bytes=Decimal("8589934592"),
                ),
                statistics=(
                    exact(CPU, "avg", "12.50"),
                ),
                day_buckets=(),
                facts=(),
            )
        )

    return build_fixture(resources=resources)


def _make_view(
    resource_ids: list[str], *, resource_type: str | None = None
) -> SnapshotView:
    """Build a SnapshotView from a list of resource ids."""
    doc = _make_snapshot_document(resource_ids, resource_type=resource_type)
    return build_snapshot_view(doc)


def _make_catalogue() -> LoadedSectionCatalogue:
    """Load the real section catalogue."""
    return load_section_catalogue()


def _make_messages():
    """Load the real English message catalogue, for resolving heading text."""
    from reporting_agent.compile.messages import load_messages

    return load_messages("en")


def _make_v3_definition(
    sections: list[dict],
) -> dict:
    """Build a minimal v3 definition."""
    return {
        "schema_version": 3,
        "provider": "azure",
        "sections": sections,
        "identity": {
            "language": "en",
            "customer_name": "Test Corp",
            "report_title": "Test Report",
        },
        "period": {"start": "2026-07-01", "end": "2026-07-31"},
        "design": {
            "theme_preset": "corporate",
            "accent_color": "#008080",
            "density": "normal",
            "table_style": "hairline",
            "page_size": "a4",
            "number_format": {"decimal_separator": ".", "thousands_separator": ","},
            "cover_page": True,
        },
        "front_matter": {
            "cover": {"title": "Test", "subtitle": ""},
            "document_control": {
                "document_name": "Test",
                "document_number_pattern": "RPT-{period}-{run}",
            },
            "approvers": [],
            "distribution": [],
            "confidentiality_notice_id": None,
        },
    }


# ---------------------------------------------------------------------------
# Test: basic expansion
# ---------------------------------------------------------------------------


class TestExpandSectionsBasic:
    """Basic expansion tests."""

    def test_empty_sections_produces_empty_tuple(self) -> None:
        catalogue = _make_catalogue()
        view = _make_view(["/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"])
        definition = _make_v3_definition(sections=[])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        assert result == ()

    def test_single_section_per_section_expansion(self) -> None:
        """A section with only per:'section' blocks expands once per block."""
        catalogue = _make_catalogue()
        view = _make_view(["/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"])
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_sub",
                "type": "azure_subscription",
                "position": 1,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        # azure_subscription has 2 expands_to entries: heading + inventory_summary,
        # both per:"section". It reports the subscription itself — its id and the three
        # counts that describe the estate — rather than listing the estate's resources,
        # which is what the resource_table it used to expand to did.
        assert len(result) == 2
        assert result[0].id == "sec_sub__0"
        assert result[0].type == "heading"
        assert result[1].id == "sec_sub__1"
        assert result[1].type == "inventory_summary"
        assert result[1].config["group_by"] == "subscription"

    def test_a_metric_section_expands_per_machine_and_narrows_each_block(self) -> None:
        """`vm_utilization` gives each machine its own heading, detail, chart and table.

        ## The bug that made this `per: "section"` for a while, and why it is safe now

        It expanded `per: "resource"` originally, and the expansion wrote a resource
        *ordinal* into each block's config that no compiler read — so all four blocks
        resolved the section's whole scope and three machines produced three identical
        charts and three identical tables. The fix at the time was to collapse the section
        to one chart and one fleet table.

        `BlockContext.resources_for` now narrows a per-resource block to the resource id
        the expansion wrote, and every compiler these blocks reach goes through it. So the
        per-machine shape the report actually wants — the artifact's "8.1 vm-amor", with
        that machine's size and OS above its own chart — is reachable again.

        This asserts both halves: the blocks are emitted per machine, **and** each one
        carries the id that narrows it. Asserting only the first would pass on exactly the
        bug that caused the collapse.
        """
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-02",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-03",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_util",
                "type": "vm_utilization",
                "position": 1,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [{"metric": CPU, "statistic": "avg"}],
                "presentation": "chart_and_table",
            },
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        # The section's own title, then four blocks per machine, then the fleet table.
        assert [spec.type for spec in result] == [
            "heading",
            *(
                block
                for _ in vm_ids
                for block in (
                    "heading",
                    "resource_table",
                    "timeseries_chart",
                    "metric_summary",
                )
            ),
            "top_n_table",
        ]

        section_heading = result[0]
        assert section_heading.config["level"] == 2
        assert section_heading.config["text"] == "Virtual Machine Utilization"
        assert section_heading.id.count("__") == 1, "a per:section block carries no ordinal"

        per_machine = result[1:-1]
        assert all(spec.id.count("__") == 2 for spec in per_machine), (
            "a per:resource block carries its resource ordinal in its id"
        )

        # The narrowing, asserted per block rather than per machine: every one of the four
        # blocks a machine gets must carry that machine's id, or it renders the fleet.
        for ordinal, resource_id in enumerate(vm_ids):
            for spec in per_machine[ordinal * 4 : ordinal * 4 + 4]:
                assert spec.config[RESOURCE_ID_CONFIG_KEY] == resource_id, (
                    f"{spec.type} for machine {ordinal} resolves the whole section scope"
                )

        # Each machine's own heading is titled by that machine, one level down.
        machine_headings = [s for s in per_machine if s.type == "heading"]
        assert [h.config["text"] for h in machine_headings] == [
            rid.rsplit("/", 1)[-1] for rid in vm_ids
        ]
        assert all(h.config["level"] == 3 for h in machine_headings)

        # The per-machine summary is transposed — one row per metric, for one machine.
        for summary in (s for s in per_machine if s.type == "metric_summary"):
            assert summary.config["orientation"] == "metric_major"
            assert summary.config["metrics"] == [{"metric": CPU, "statistic": "avg"}]

        # The detail table stacks its columns rather than spreading one row across seven.
        for detail in (s for s in per_machine if s.type == "resource_table"):
            assert detail.config["layout"] == "pairs"

        # The fleet comparison stays per:section — it is the one table about all of them.
        top_n = [s for s in result if s.type == "top_n_table"]
        assert len(top_n) == 1
        assert top_n[0].id.count("__") == 1


# ---------------------------------------------------------------------------
# Test: ordering
# ---------------------------------------------------------------------------


class TestExpandSectionsOrdering:
    """The ordering rules: group → position → catalogue number."""

    def test_group_ordering(self) -> None:
        """inventory sections come before utilisation, which comes before closing."""
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            # Put a utilisation section first in the definition
            {
                "id": "sec_util",
                "type": "vm_utilization",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [{"metric": CPU, "statistic": "avg"}],
                "presentation": "chart_and_table",
            },
            # Then an inventory section
            {
                "id": "sec_sub",
                "type": "azure_subscription",
                "position": 2,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        # First blocks should be from the inventory section (azure_subscription)
        assert result[0].id.startswith("sec_sub__")

    def test_fixed_position_ignores_stored_position(self) -> None:
        """Fixed sections use their catalogue-declared order, not stored position."""
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            # incident_report (number 13) with high stored position
            {
                "id": "sec_incident",
                "type": "incident_report",
                "position": 999,
                "selection": {"resource_types": [], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
            # backup_report (number 12) with low stored position
            {
                "id": "sec_backup",
                "type": "backup_report",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        # backup_report (fixed order 0) should come before incident_report (fixed order 1)
        backup_blocks = [s for s in result if s.id.startswith("sec_backup")]
        incident_blocks = [s for s in result if s.id.startswith("sec_incident")]
        assert backup_blocks and incident_blocks
        first_backup_idx = list(result).index(backup_blocks[0])
        first_incident_idx = list(result).index(incident_blocks[0])
        assert first_backup_idx < first_incident_idx

    def test_always_section_comes_last(self) -> None:
        """The always section (coverage_and_verification) appears after everything."""
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_cov",
                "type": "coverage_and_verification",
                "position": 1,
                "selection": {"resource_types": [], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
            {
                "id": "sec_sub",
                "type": "azure_subscription",
                "position": 2,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        # coverage_and_verification should be last
        cov_blocks = [s for s in result if s.id.startswith("sec_cov")]
        sub_blocks = [s for s in result if s.id.startswith("sec_sub")]
        assert cov_blocks and sub_blocks
        last_sub_idx = list(result).index(sub_blocks[-1])
        first_cov_idx = list(result).index(cov_blocks[0])
        assert first_cov_idx > last_sub_idx


# ---------------------------------------------------------------------------
# Test: presentation filtering
# ---------------------------------------------------------------------------


class TestPresentationFiltering:
    """when_presentation filters out blocks not matching the section's presentation."""

    def test_table_only_omits_charts(self) -> None:
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_util",
                "type": "vm_utilization",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [{"metric": CPU, "statistic": "avg"}],
                "presentation": "table_only",
            },
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        types = [s.type for s in result]
        assert "timeseries_chart" not in types
        # The tabular half of a metric section is `metric_summary` now — one row per
        # resource rather than one whole table per resource.
        assert "metric_summary" in types

    def test_chart_only_omits_tables(self) -> None:
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_util",
                "type": "vm_utilization",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [{"metric": CPU, "statistic": "avg"}],
                "presentation": "chart_only",
            },
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        types = [s.type for s in result]
        assert "resource_table" not in types
        assert "timeseries_chart" in types


# ---------------------------------------------------------------------------
# GUARD 1: Anchor stability — identical id sets across two expansions
# ---------------------------------------------------------------------------


class TestAnchorStabilityGuard:
    """Guard: expanding the SAME definition twice produces IDENTICAL block id sets.

    This is the guard against non-determinism from set/dict iteration order.
    """

    def test_identical_ids_across_two_calls(self) -> None:
        """Two calls with the same inputs produce identical id tuples."""
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-02",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-03",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_sub",
                "type": "azure_subscription",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
            {
                "id": "sec_util",
                "type": "vm_utilization",
                "position": 2,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [{"metric": CPU, "statistic": "avg"}],
                "presentation": "chart_and_table",
            },
        ])

        result_a = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())
        result_b = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        ids_a = tuple(spec.id for spec in result_a)
        ids_b = tuple(spec.id for spec in result_b)
        assert ids_a == ids_b, (
            f"Anchor instability: two expansions produced different id sequences.\n"
            f"  First:  {ids_a}\n"
            f"  Second: {ids_b}"
        )

    def test_anchor_ids_are_sets_identical(self) -> None:
        """id SETS (not just tuples) are identical — covers the set equality the task names."""
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-02",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_util",
                "type": "vm_utilization",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [{"metric": CPU, "statistic": "avg"}],
                "presentation": "chart_and_table",
            },
            {
                "id": "sec_sub",
                "type": "azure_subscription",
                "position": 2,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        result_a = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())
        result_b = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        set_a = frozenset(spec.id for spec in result_a)
        set_b = frozenset(spec.id for spec in result_b)
        assert set_a == set_b


# ---------------------------------------------------------------------------
# GUARD 2: Full determinism — identical BlockSpec tuples
# ---------------------------------------------------------------------------


class TestFullDeterminismGuard:
    """Guard: two calls produce IDENTICAL BlockSpec tuples (not just ids — everything).

    This is the stronger guard: every field (id, type, config, scope_override) is identical.
    """

    def test_full_tuple_equality(self) -> None:
        """Two expansions with the same inputs produce byte-identical BlockSpec tuples."""
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-02",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-03",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_sub",
                "type": "azure_subscription",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
            {
                "id": "sec_util",
                "type": "vm_utilization",
                "position": 2,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [{"metric": CPU, "statistic": "avg"}],
                "presentation": "chart_and_table",
            },
            {
                "id": "sec_cov",
                "type": "coverage_and_verification",
                "position": 99,
                "selection": {"resource_types": [], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        result_a = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())
        result_b = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        assert len(result_a) == len(result_b)
        for idx, (a, b) in enumerate(zip(result_a, result_b, strict=True)):
            assert a.id == b.id, f"id mismatch at index {idx}: {a.id!r} vs {b.id!r}"
            assert a.type == b.type, f"type mismatch at index {idx}: {a.type!r} vs {b.type!r}"
            assert a.config == b.config, f"config mismatch at index {idx}"
            assert a.scope_override == b.scope_override, f"scope_override mismatch at index {idx}"
            assert a.columns == b.columns, f"columns mismatch at index {idx}"

    def test_determinism_with_multiple_resources_and_groups(self) -> None:
        """Multi-resource, multi-group scenario still deterministic."""
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-a",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-b",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-c",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-d",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_util_a",
                "type": "vm_utilization",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [{"metric": CPU, "statistic": "avg"}],
                "presentation": "chart_and_table",
            },
            {
                "id": "sec_sub",
                "type": "azure_subscription",
                "position": 2,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
            {
                "id": "sec_backup",
                "type": "backup_report",
                "position": 3,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        # Run 10 times to catch any iteration-order nondeterminism
        first_result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())
        for _ in range(9):
            result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())
            assert result == first_result


# ---------------------------------------------------------------------------
# Test: error handling
# ---------------------------------------------------------------------------


class TestExpandSectionsErrors:
    """Error cases."""

    def test_unknown_catalogue_key_raises(self) -> None:
        catalogue = _make_catalogue()
        view = _make_view(["/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"])
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_bad",
                "type": "nonexistent_section_type",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        with pytest.raises(CompileFailedError, match="nonexistent_section_type"):
            expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

    def test_missing_sections_array_raises(self) -> None:
        catalogue = _make_catalogue()
        view = _make_view(["/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"])
        definition = {"schema_version": 3, "provider": "azure"}

        with pytest.raises(CompileFailedError, match="no sections array"):
            expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

    def test_section_with_no_id_raises(self) -> None:
        catalogue = _make_catalogue()
        view = _make_view(["/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"])
        definition = _make_v3_definition(sections=[
            {
                "id": "",
                "type": "azure_subscription",
                "position": 1,
                "selection": {"resource_types": [VM_TYPE], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        with pytest.raises(CompileFailedError, match="no usable id"):
            expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())


# ---------------------------------------------------------------------------
# Test: scope_override is carried through
# ---------------------------------------------------------------------------


class TestScopeOverride:
    """scope_override is the section's selection, propagated to every emitted block."""

    def test_scope_override_propagated(self) -> None:
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_sub",
                "type": "azure_subscription",
                "position": 1,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": ["rg-prod"],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "chart_and_table",
            },
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        for spec in result:
            assert spec.scope_override is not None
            assert VM_TYPE in spec.scope_override.resource_types
            assert "rg-prod" in spec.scope_override.resource_groups

    def test_per_resource_block_names_its_own_resource_in_config(self) -> None:
        """per:'resource' blocks carry `_resource_id` in config — one each, all distinct.

        Uses `network_security_groups`, because the metric sections no longer expand
        per-resource at all — they emit one `metric_summary` and one chart whatever the
        estate size.

        This is the address `BlockContext.resources_for` narrows by. It used to be an
        ordinal that nothing read, so every block of the expansion resolved the whole
        section scope and `network_security_groups` over three NSGs emitted three
        identical rule tables. The id is what makes each block about one resource; see
        `test_blocks.py` for the assertion that the tables then differ.
        """
        catalogue = _make_catalogue()
        nsg_type = "Microsoft.Network/networkSecurityGroups"
        nsg_ids = [
            f"/subscriptions/sub-1/resourceGroups/rg-prod/providers/{nsg_type}/nsg-0{n}"
            for n in (1, 2)
        ]
        view = _make_view(nsg_ids, resource_type=nsg_type)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_nsg",
                "type": "network_security_groups",
                "position": 1,
                "selection": {"resource_types": [nsg_type], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [],
                "presentation": "table_only",
            },
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view, messages=_make_messages())

        per_resource = [s for s in result if s.id.count("__") == 2]
        assert len(per_resource) > 0

        named = [s.config.get("_resource_id") for s in per_resource]
        assert all(name is not None for name in named), named
        # Every block names a resource the section actually resolved, and no two name the
        # same one — a repeated id would be the duplication this key exists to prevent,
        # wearing a different shape.
        assert set(named) == set(nsg_ids)
        assert len(named) == len(set(named))


# ---------------------------------------------------------------------------
# Task 3.4 — compile_document's schema_version branch produces a byte-identical
# ledger and anchor set whether the block sequence comes from expand_sections (v3)
# or _block_specs (v2), for the same block.
# ---------------------------------------------------------------------------


class TestCompileDocumentSchemaVersionBranch:
    """The claim design.md rests the whole restructure on: an anchor id is derived
    ONLY from a leaf block's own id, so a section is invisible below the AST. That is
    only true if `compile_document`'s v3 branch (`expand_sections`) and its v2 branch
    (`_block_specs`) produce identical downstream results for the same emitted block.

    `resource_table` with static `columns` and no `needs_resource_types` is used
    deliberately: it needs no resource resolution and no title-text resolution
    (`expand_sections` does not yet resolve a catalogue entry's `title_id` into a
    `heading` block's required `text` field — a real gap, out of scope for this task,
    which only wires the branch and does not complete section-to-block config
    translation). Every entry in the SHIPPED catalogue opens with a `heading`, so this
    test uses a synthetic single-entry catalogue carrying only the `resource_table`
    step, to isolate the mechanism task 3.4 owns (the schema_version branch and
    everything downstream of it) from that separate, already-known gap.
    """

    def test_v3_and_v2_definitions_compile_the_same_block_to_the_same_ledger(self) -> None:
        from reporting_agent.compile.blocks import compile_document

        # A synthetic single-entry catalogue, deliberately not the shipped one — see the
        # class docstring for why: every shipped entry opens with a `heading`, and
        # `expand_sections` does not resolve `title_id` into a heading's `text`, which is
        # a separate, already-known gap this test is not about.
        synthetic_entry = SectionCatalogueEntry(
            key="synthetic_table",
            number=1,
            title_id="doc.section.synthetic_table",
            group="inventory",
            position="free",
            repeatable=False,
            needs_resource_types=(),
            needs_fact_sources=(),
            metric_bearing=False,
            presets=(),
            expands_to=(
                SectionExpansionBlock(
                    block="resource_table",
                    per="section",
                    config=(
                        (
                            "columns",
                            [
                                {"kind": "attribute", "attribute": "resource_type"},
                                {"kind": "attribute", "attribute": "resource_group"},
                            ],
                        ),
                    ),
                ),
            ),
        )
        catalogue = LoadedSectionCatalogue(
            catalogue_version="test",
            entries=(synthetic_entry,),
        )
        view = _make_view([])

        v3_definition = _make_v3_definition(sections=[
            {
                "id": "sec_sub",
                "type": "synthetic_table",
                "position": 0,
                "selection": {
                    "resource_types": [],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])

        v3_compiled = compile_document(v3_definition, view=view, catalogue=catalogue)

        # A single-entry `expands_to`, so `expand_sections` derives the id as
        # `sec_sub__0` (expansion index 0 — the only expansion in this entry).
        v3_table_id = "sec_sub__0"
        assert v3_table_id in v3_compiled.nodes_by_block, (
            f"expected a resource_table block at {v3_table_id!r}; got "
            f"{sorted(v3_compiled.nodes_by_block)}"
        )

        v2_definition = {
            "schema_version": 1,
            "identity": {"name": "Test"},
            "scope": {
                "resource_types": [],
                "resource_groups": [],
                "tag_filters": [],
                "top_n": None,
                "sort": None,
            },
            "metrics": {},
            "blocks": [
                {
                    "id": v3_table_id,
                    "type": "resource_table",
                    "config": {
                        "columns": [
                            {"kind": "attribute", "attribute": "resource_type"},
                            {"kind": "attribute", "attribute": "resource_group"},
                        ],
                    },
                },
            ],
        }

        v2_compiled = compile_document(v2_definition, view=view)

        # The claim: identical block, identical id, identical ledger and anchor —
        # regardless of which array (`sections` or `blocks`) it arrived through.
        v3_nodes = v3_compiled.nodes_by_block[v3_table_id]
        v2_nodes = v2_compiled.nodes_by_block[v3_table_id]
        assert v3_nodes == v2_nodes, (
            "the same resource_table block compiled to different AST nodes depending "
            "on whether it arrived via expand_sections or _block_specs"
        )

        v3_table = v3_nodes[0]
        v2_table = v2_nodes[0]
        assert v3_table.anchor_id == v2_table.anchor_id, (
            "anchor ids differ between the v3 and v2 paths for the identical block — "
            "the design decision that a section is invisible below the AST is broken"
        )

    def test_a_v3_definition_with_no_catalogue_raises_rather_than_compiling_wrong(
        self,
    ) -> None:
        """`catalogue=None` (its default) with a v3 definition must refuse loudly. A v3
        definition silently falling through to `_block_specs` would raise on the
        missing `blocks` key anyway, but for the wrong reason — this asserts the RIGHT
        reason, naming the real requirement, so a future refactor that accidentally
        makes the fallback "succeed" (e.g. `definition.get("blocks", ())`) is caught."""
        from reporting_agent.compile.blocks import compile_document
        from reporting_agent.errors import CompileFailedError

        view = _make_view([])
        v3_definition = _make_v3_definition(sections=[])

        with pytest.raises(CompileFailedError, match="section catalogue"):
            compile_document(v3_definition, view=view)

    def test_v1_and_v2_definitions_still_compile_with_no_catalogue_argument(self) -> None:
        """Task 3.4's own bar: every existing caller and test compiles unchanged.
        `catalogue` must default to None with no behaviour change for schema_version < 3."""
        from reporting_agent.compile.blocks import compile_document

        view = _make_view([])
        v1_definition = {
            "schema_version": 1,
            "identity": {"name": "Test"},
            "scope": {
                "resource_types": [],
                "resource_groups": [],
                "tag_filters": [],
                "top_n": None,
                "sort": None,
            },
            "metrics": {},
            "blocks": [
                {"id": "brk", "type": "page_break", "config": {}},
            ],
        }

        compiled = compile_document(v1_definition, view=view)

        assert "brk" in compiled.nodes_by_block

    def test_the_real_catalogue_now_compiles_end_to_end_with_resolved_heading_text(
        self,
    ) -> None:
        """The real `sections.v1.json` no longer fails to compile.

        This is the outcome the title-resolution fix and the column-shape fix in
        `sections.v1.json` exist for: `azure_subscription` (section 1, the simplest
        entry — a `heading` then a `resource_table`) compiles through the REAL
        catalogue, not a synthetic one, and its heading carries the text resolved
        from `doc.section.azure_subscription`, not a placeholder or a raised error."""
        from reporting_agent.compile.blocks import compile_document

        catalogue = _make_catalogue()
        view = _make_view([])
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_sub",
                "type": "azure_subscription",
                "position": 0,
                "selection": {
                    "resource_types": [],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])

        compiled = compile_document(definition, view=view, catalogue=catalogue)

        heading = compiled.nodes_by_block["sec_sub__0"][0]
        assert heading.style == "Heading 2"
        assert len(heading.inlines) == 1
        assert heading.inlines[0].text == "Azure Subscription Overview"

        table = compiled.nodes_by_block["sec_sub__1"][0]
        assert table.__class__.__name__ == "Table"

    def test_a_headings_own_title_id_in_config_overrides_the_section_entrys(
        self,
    ) -> None:
        """`virtual_machines` (section 4) is the real catalogue's one entry with more
        than one heading — three subsection headings, each declaring its OWN `title_id`
        in the expansion's static config, distinct from the section's own `title_id`.
        Proves the override branch of `_resolve_heading_text`, not just the common
        one-heading-per-section path the previous test exercises."""
        from reporting_agent.compile.blocks import compile_document

        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_vms",
                "type": "virtual_machines",
                "position": 0,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])

        compiled = compile_document(definition, view=view, catalogue=catalogue)

        # Expansion order: heading(0, section's own title), heading(1, .inventory),
        # resource_table(2), heading(3, .network), resource_table(4),
        # heading(5, .disks), resource_table(6).
        section_heading = compiled.nodes_by_block["sec_vms__0"][0]
        assert section_heading.inlines[0].text == "Virtual Machines"

        inventory_heading = compiled.nodes_by_block["sec_vms__1"][0]
        assert inventory_heading.inlines[0].text == "Inventory"

        network_heading = compiled.nodes_by_block["sec_vms__3"][0]
        assert network_heading.inlines[0].text == "Network Configuration"

        disks_heading = compiled.nodes_by_block["sec_vms__5"][0]
        assert disks_heading.inlines[0].text == "Disks"

    def test_every_real_catalogue_entry_compiles_without_error(self) -> None:
        """The regression guard for both fixes at once, and now for a third (task
        7.3): every catalogue entry compiles through `compile_document` with no
        resolved resources — all fifteen, with no skip list, which is what Req 15.9
        asks for.

        `vm_utilization`, `historical_vm_utilization` and `database_utilization`
        were excluded here until task 7.3: their `top_n_table`/`historical_trend`
        expansions needed a per-run metric selection threaded from the section's own
        `metrics`/`selection` into the expansion, which `compile/sections.py`'s
        `_thread_metric_config` now does. `historical_vm_utilization` additionally
        needs `lookback` on the section itself (task 7.3's own ruling: author-set,
        no catalogue default, since it is a number the document prints and the
        verifier independently re-derives)."""
        from reporting_agent.compile.blocks import compile_document

        catalogue = _make_catalogue()
        view = _make_view([])

        for entry in catalogue.entries:
            metrics = (
                [{"metric": "Percentage CPU", "statistic": "avg"}]
                if entry.metric_bearing
                else []
            )
            section: dict[str, object] = {
                "id": "sec",
                "type": entry.key,
                "position": 0,
                "selection": {
                    "resource_types": [],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": metrics,
                "presentation": "table_only",
            }
            if entry.key == "historical_vm_utilization":
                section["lookback"] = 6

            definition = _make_v3_definition(sections=[section])

            compiled = compile_document(definition, view=view, catalogue=catalogue)

            # An entry whose FIRST expansion is `per: "resource"` (e.g.
            # `app_service_and_storage`) legitimately produces zero blocks with zero
            # resolved resources — that is correct behaviour, not a compile failure.
            # Every entry opening with a `per: "section"` expansion (the heading, at
            # minimum) must always produce at least one node regardless of scope.
            if entry.expands_to[0].per == "section":
                assert len(compiled.nodes_by_block) > 0, (
                    f"catalogue entry {entry.key!r} produced no compiled nodes"
                )


# ---------------------------------------------------------------------------
# Task 3.9 — a zero-resource section never vanishes, at v3 and at v1/v2 alike.
# ---------------------------------------------------------------------------


class TestZeroResourceSectionsAtCompileTime:
    """Req 11.5: a section (v3) or a block (v1/v2) whose scope resolves to zero
    resources emits the explicit "No resources matched this scope" row rather than
    disappearing. A disappeared section is indistinguishable from one never
    configured, in the builder and in the delivered document alike.

    This is not new compiler behaviour — `_resource_rows_table`'s empty-scope branch
    (in `compile/blocks/tables.py`) is unconditional and shared by both
    `compile_resource_table` and `compile_top_n_table`, regardless of whether the
    `BlockSpec` it receives arrived via `expand_sections` (v3) or `_block_specs`
    (v1/v2) — `expand_sections` produces ordinary `BlockSpec`s consumed by the
    identical `compile_block` dispatch, so there is no separate "v3 path" that
    could diverge from the v1/v2 one. This test exists to assert that fact
    directly rather than leave it as an inference from reading the source, and to
    catch a future change that accidentally makes the two paths disagree.
    """

    def test_a_v3_section_with_zero_matched_resources_emits_the_notice_row(
        self,
    ) -> None:
        from reporting_agent.compile.blocks import compile_document
        from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT
        from reporting_agent.compile.messages import load_messages

        catalogue = _make_catalogue()
        # An empty view: nothing in scope for any resource-typed section.
        view = _make_view([])
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_sub",
                "type": "virtual_machines",
                "position": 0,
                "selection": {
                    "resource_types": [],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])

        compiled = compile_document(definition, view=view, catalogue=catalogue)

        # sec_sub__2 is the first resource_table expansion of virtual_machines — its
        # `expands_to` is heading, heading, resource_table, … (see the earlier task-3.4
        # test for why the id is derived this way).
        #
        # `virtual_machines` rather than `azure_subscription`, which no longer expands a
        # resource_table at all: it reports the subscription's own counts, and "0 total
        # resources" is the honest thing for it to say about an empty estate — the notice
        # row belongs to a block that was going to list resources.
        table = compiled.nodes_by_block["sec_sub__2"][0]
        expected_text = load_messages("en").text(EMPTY_SCOPE_TEXT)

        assert table.rows[0].cells[0].text == expected_text
        # The block did not vanish: it is present in nodes_by_block with its own
        # anchor, exactly as a section with matched resources would be.
        assert "sec_sub__2" in compiled.nodes_by_block

    def test_a_v1_block_with_zero_matched_resources_still_emits_the_notice_row(
        self,
    ) -> None:
        """The existing v1/v2 behaviour, asserted directly rather than assumed
        unchanged — the whole point of this task is to prove the two paths agree,
        which requires actually running both, not just the v3 one."""
        from reporting_agent.compile.blocks import compile_document
        from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT
        from reporting_agent.compile.messages import load_messages

        view = _make_view([])
        v1_definition = {
            "schema_version": 1,
            "identity": {"name": "Test"},
            "scope": {
                "resource_types": [],
                "resource_groups": [],
                "tag_filters": [],
                "top_n": None,
                "sort": None,
            },
            "metrics": {},
            "blocks": [
                {
                    "id": "tbl",
                    "type": "resource_table",
                    "config": {
                        "columns": [
                            {"kind": "attribute", "attribute": "resource_type"},
                        ],
                    },
                    "scope_override": {
                        "resource_types": ["Microsoft.Sql/servers"],
                        "resource_groups": [],
                        "tag_filters": [],
                        "top_n": None,
                        "sort": None,
                    },
                },
            ],
        }

        compiled = compile_document(v1_definition, view=view)

        table = compiled.nodes_by_block["tbl"][0]
        expected_text = load_messages("en").text(EMPTY_SCOPE_TEXT)

        assert table.rows[0].cells[0].text == expected_text
        assert "tbl" in compiled.nodes_by_block

    def test_both_paths_produce_byte_identical_empty_scope_rows(self) -> None:
        """The two tests above each prove one path works. This proves they agree —
        the actual claim task 3.9 makes ("the existing zero-resource block
        behaviour is unchanged") is a claim about SAMENESS, not just that each
        side independently emits something plausible."""
        from reporting_agent.compile.blocks import compile_document

        catalogue = _make_catalogue()
        view = _make_view([])

        v3_definition = _make_v3_definition(sections=[
            {
                "id": "sec_sub",
                "type": "virtual_machines",
                "position": 0,
                "selection": {
                    "resource_types": [],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])
        v3_compiled = compile_document(v3_definition, view=view, catalogue=catalogue)
        # __2, not __1: `virtual_machines` expands a section heading and a subsection
        # heading before its first resource_table.
        v3_table = v3_compiled.nodes_by_block["sec_sub__2"][0]

        v1_definition = {
            "schema_version": 1,
            "identity": {"name": "Test"},
            "scope": {
                "resource_types": [],
                "resource_groups": [],
                "tag_filters": [],
                "top_n": None,
                "sort": None,
            },
            "metrics": {},
            "blocks": [
                {
                    # The id the v3 path derives, so the two paths' figure paths — which
                    # are rooted at the block id — compare equal too.
                    "id": "sec_sub__2",
                    "type": "resource_table",
                    "config": {
                        "columns": [
                            {"kind": "attribute", "attribute": "resource_type"},
                            {"kind": "fact", "fact_key": "count"},
                        ],
                    },
                },
            ],
        }
        v1_compiled = compile_document(v1_definition, view=view)
        v1_table = v1_compiled.nodes_by_block["sec_sub__2"][0]

        # Same notice row, same style, same structure — the empty-scope branch
        # does not know or care which schema version produced the BlockSpec it
        # received.
        assert v3_table.rows == v1_table.rows
        assert v3_table.style == v1_table.style


# ---------------------------------------------------------------------------
# Task 3.11 — compute_section_drift
# ---------------------------------------------------------------------------


class TestComputeSectionDrift:
    """`compute_section_drift` is the pure computation the coverage appendix's
    drift table (task 3.11) is built on. `authored_matches` arrives as a value —
    this module never touches a database — so every case here hand-builds the
    `AuthoredMatch` mapping a real caller would have read from
    `report_profile_authored_matches`.
    """

    def test_a_resource_added_since_authoring_is_reported_in_added(self) -> None:
        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-02",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_vm",
                "type": "vm_utilization",
                "position": 0,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])
        authored = {
            "sec_vm": AuthoredMatch(resource_ids=frozenset({vm_ids[0]})),
        }

        drifts = compute_section_drift(
            definition, catalogue=catalogue, view=view, authored_matches=authored
        )

        assert drifts == (
            SectionDrift(section_id="sec_vm", added=(vm_ids[1],), removed=()),
        )

    def test_a_resource_no_longer_matching_is_reported_in_removed(self) -> None:
        catalogue = _make_catalogue()
        vm_id = "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"
        view = _make_view([vm_id])
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_vm",
                "type": "vm_utilization",
                "position": 0,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])
        gone_id = "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-deleted"
        authored = {
            "sec_vm": AuthoredMatch(resource_ids=frozenset({vm_id, gone_id})),
        }

        drifts = compute_section_drift(
            definition, catalogue=catalogue, view=view, authored_matches=authored
        )

        assert drifts == (
            SectionDrift(section_id="sec_vm", added=(), removed=(gone_id,)),
        )

    def test_an_unchanged_match_reports_an_empty_drift_not_no_row_at_all(self) -> None:
        """Req 19.3: every matched resource is announced, never excluded silently.
        A section whose rule resolves to exactly what was authored must still
        appear in the result — the coverage appendix's row for it says "no
        drift", it does not omit the row."""
        catalogue = _make_catalogue()
        vm_id = "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"
        view = _make_view([vm_id])
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_vm",
                "type": "vm_utilization",
                "position": 0,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])
        authored = {"sec_vm": AuthoredMatch(resource_ids=frozenset({vm_id}))}

        drifts = compute_section_drift(
            definition, catalogue=catalogue, view=view, authored_matches=authored
        )

        assert drifts == (
            SectionDrift(section_id="sec_vm", added=(), removed=()),
        )

    def test_a_section_with_no_recorded_match_is_skipped_entirely(self) -> None:
        """A section never published before (or added since the last publish)
        has no AuthoredMatch to compare against — comparing against nothing
        would report everything as newly added, which is not a fact about
        drift. It must be absent from the result, not present with a
        misleading all-added drift."""
        catalogue = _make_catalogue()
        view = _make_view(["/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"])
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_vm",
                "type": "vm_utilization",
                "position": 0,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])

        drifts = compute_section_drift(
            definition, catalogue=catalogue, view=view, authored_matches={}
        )

        assert drifts == ()

    def test_results_are_ordered_deterministically_across_repeated_calls(self) -> None:
        catalogue = _make_catalogue()
        vm_ids = [
            f"/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-{n:02d}"
            for n in range(1, 6)
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_vm",
                "type": "vm_utilization",
                "position": 0,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])
        authored = {"sec_vm": AuthoredMatch(resource_ids=frozenset({vm_ids[0]}))}

        first = compute_section_drift(
            definition, catalogue=catalogue, view=view, authored_matches=authored
        )
        second = compute_section_drift(
            definition, catalogue=catalogue, view=view, authored_matches=authored
        )

        assert first == second
        # sorted, not insertion-order or set-iteration-order dependent
        assert list(first[0].added) == sorted(first[0].added)

    def test_compile_document_renders_drift_as_prose_with_a_verifiable_derived_count(
        self,
    ) -> None:
        """The end-to-end wiring: `authored_matches` reaches `compile_document`,
        drift is computed, and the coverage appendix's `gaps_and_coverage` block
        renders it as a real prose statement carrying a `DerivedCount` the
        verifier can independently re-derive — not just the pure function
        producing a plausible `SectionDrift` in isolation."""
        from reporting_agent.compile.ast import DerivedCount, Paragraph, Text
        from reporting_agent.compile.blocks import compile_document

        catalogue = _make_catalogue()
        vm_ids = [
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
            "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-02",
        ]
        view = _make_view(vm_ids)
        definition = _make_v3_definition(sections=[
            {
                "id": "sec_sub",
                "type": "virtual_machines",
                "position": 0,
                "selection": {
                    "resource_types": [],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
            {
                "id": "sec_cov",
                "type": "coverage_and_verification",
                "position": 1,
                "selection": {
                    "resource_types": [],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            },
        ])
        authored_matches = {
            "sec_sub": AuthoredMatch(resource_ids=frozenset({vm_ids[0]})),
        }

        compiled = compile_document(
            definition,
            view=view,
            catalogue=catalogue,
            authored_matches=authored_matches,
        )

        # coverage_and_verification's expands_to is heading, gaps_and_coverage,
        # verification_record, in that order per:section — so the gaps_and_coverage
        # block's derived id is sec_cov__1.
        cov_nodes = compiled.nodes_by_block["sec_cov__1"]
        paragraphs = [n for n in cov_nodes if isinstance(n, Paragraph)]
        assert paragraphs, "expected at least one drift statement paragraph"

        rendered_text = " ".join(
            inline.text for p in paragraphs for inline in p.inlines if isinstance(inline, Text)
        )
        assert vm_ids[1] in rendered_text
        assert "sec_sub" in rendered_text

        derived = compiled.ledger.derived_counts()
        added_counts = [
            c for c in derived.values()
            if isinstance(c, DerivedCount) and c.derivation_kind == "scope_added_count"
        ]
        assert len(added_counts) == 1
        assert added_counts[0].formatted == "1"


class TestPerResourceHeadingTitles:
    """A per-resource heading is titled by its resource, never by the catalogue."""

    def test_a_per_resource_heading_declaring_a_title_is_refused(self) -> None:
        """The combination has one rendering — the same string once per resource.

        That is the defect itself, so the catalogue is not allowed to express it: a
        heading wanting a fixed title is a `per: "section"` heading.
        """
        from reporting_agent.compile.sections import _assert_resource_heading_untitled

        catalogue = _make_catalogue()
        entry = catalogue.by_key("vm_utilization")
        assert entry is not None

        with pytest.raises(CompileFailedError, match="per-resource heading"):
            _assert_resource_heading_untitled(
                entry, {"level": 3, "title_id": "doc.section.vm_utilization"}
            )

    def test_an_untitled_per_resource_heading_is_accepted(self) -> None:
        from reporting_agent.compile.sections import _assert_resource_heading_untitled

        catalogue = _make_catalogue()
        entry = catalogue.by_key("vm_utilization")
        assert entry is not None

        _assert_resource_heading_untitled(entry, {"level": 3})


class TestCatalogueHeadingShape:
    """Every per-resource heading in the shipped catalogue is untitled, and every
    section that has one also carries a section-level heading above it.

    Read from `sections.v1.json` itself rather than restated, so a section added later
    with the old shape fails here rather than in a delivered document.
    """

    def test_no_shipped_per_resource_heading_declares_a_title(self) -> None:
        catalogue = _make_catalogue()
        for entry in catalogue.entries:
            for expansion in entry.expands_to:
                if expansion.block == "heading" and expansion.per == "resource":
                    assert "title_id" not in expansion.config, (
                        f"{entry.key}: a per-resource heading declares a fixed title"
                    )

    def test_a_section_with_per_resource_headings_titles_itself_too(self) -> None:
        catalogue = _make_catalogue()
        for entry in catalogue.entries:
            headings = [e for e in entry.expands_to if e.block == "heading"]
            if not any(h.per == "resource" for h in headings):
                continue
            assert headings and headings[0].per == "section", (
                f"{entry.key}: its first heading is per-resource, so the section's own "
                f"title never appears in the document or its table of contents"
            )


def test_no_section_expands_a_resource_blind_block_per_resource() -> None:
    """A `per: "resource"` expansion must be a block that reads its own resource.

    `historical_vm_utilization` declared `historical_trend` per resource, and that block
    plots one metric across prior **periods** — it has no resource dimension and never
    consults `_resource_id`. Three machines therefore produced three byte-identical trend
    blocks, each saying `0 of 3 prior periods plotted`, one after another.

    `BlockContext.resources_for` did not catch it the way it caught the NSG tables: that
    narrowing works by filtering a block's resolved scope, and a block which never resolves
    a scope has nothing to narrow.

    So the rule is declared here instead. A block type belongs in this set only if its
    compiler is genuinely blind to which resource it was expanded for.
    """
    import json
    from pathlib import Path

    resource_blind = {"historical_trend"}

    catalogue = json.loads(
        (
            Path(__file__).resolve().parent.parent
            / "src/reporting_agent/catalog/sections.v1.json"
        ).read_text()
    )
    offenders = []
    for provider, block in catalogue["providers"].items():
        for section in block["sections"]:
            for expansion in section.get("expands_to", ()):
                if expansion.get("per") == "resource" and expansion["block"] in resource_blind:
                    offenders.append(f"{provider}/{section['key']}/{expansion['block']}")

    assert offenders == [], (
        f"these expansions repeat a block that ignores its resource, once per resource: "
        f"{offenders}"
    )


# ---------------------------------------------------------------------------
# historical_trend_keys — the keys the pipeline fetches prior runs for
# ---------------------------------------------------------------------------


class TestHistoricalTrendKeys:
    """The keys a v3 definition's sections resolve to for historical selection.

    The defect these guard: the pipeline resolved trend keys by walking
    ``definition["blocks"]``, the v2 shape. Every profile the wizard writes is v3 and
    carries ``sections``, so the walk returned the empty set, no prior run was ever
    selected, and every ``historical_trend`` block printed "No prior verified period is
    available for this trend." against a database holding eleven passing prior runs.

    Nothing raised and no gate fired, because an empty trend is a state the block is
    *supposed* to be able to reach. Only comparing the keys against what
    ``expand_sections`` actually emits catches it — which is what these do.
    """

    @staticmethod
    def _definition() -> dict[str, object]:
        """The shipped `historical_vm_utilization` section as the wizard writes it."""
        return {
            "schema_version": 3,
            "provider": "azure",
            "sections": [
                {
                    "id": "sec_hist",
                    "type": "historical_vm_utilization",
                    "lookback": 3,
                    "presentation": "chart_and_table",
                    "metrics": [
                        {"metric": CPU, "statistic": "avg"},
                        {"metric": CPU, "statistic": "max"},
                    ],
                    "selection": {"resource_types": [VM_TYPE]},
                }
            ],
        }

    def test_a_v3_section_resolves_its_trend_key(self) -> None:
        from reporting_agent.compile.sections import historical_trend_keys

        keys = historical_trend_keys(
            self._definition(), catalogue=load_section_catalogue()
        )

        assert keys == {(CPU, "max", 3)}, (
            "the shipped historical section declares trend_metric Percentage CPU/max "
            "and a lookback of 3; an empty set here is the defect that emptied every trend"
        )

    def test_the_keys_match_what_expand_sections_emits(self) -> None:
        """The guard that keeps the two walkers from drifting.

        `historical_trend_keys` is a second reading of the same definition, made without
        a snapshot view. If it ever resolves a different metric, statistic or lookback
        than the block the expansion actually compiles, the pipeline fetches candidates
        under one key and the block looks them up under another — which presents exactly
        as this defect did: a correct-looking report with an empty trend.
        """
        from reporting_agent.compile.sections import historical_trend_keys

        definition = self._definition()
        catalogue = load_section_catalogue()
        view = _make_view(["/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-a"])

        specs = expand_sections(
            definition, catalogue=catalogue, view=view, messages=_make_messages()
        )
        emitted = {
            (
                spec.config["metric"],
                spec.config["statistic"],
                spec.config["lookback"],
            )
            for spec in specs
            if spec.type == "historical_trend"
        }
        assert emitted, "the fixture must expand a historical_trend block to guard anything"

        assert historical_trend_keys(definition, catalogue=catalogue) == emitted

    def test_a_table_only_section_emits_no_block_and_no_key(self) -> None:
        """Presentation gates both, or the pipeline loads snapshots nothing plots."""
        from reporting_agent.compile.sections import historical_trend_keys

        definition = self._definition()
        definition["sections"][0]["presentation"] = "table_only"  # type: ignore[index]
        catalogue = load_section_catalogue()
        view = _make_view(["/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-a"])

        specs = expand_sections(
            definition, catalogue=catalogue, view=view, messages=_make_messages()
        )
        assert not [s for s in specs if s.type == "historical_trend"]
        assert historical_trend_keys(definition, catalogue=catalogue) == set()

    def test_a_v2_definition_resolves_nothing_through_this_path(self) -> None:
        """`sections` absent is not an error — it is the v2 shape, handled by the
        pipeline's own `blocks` walk, which this function must not shadow."""
        from reporting_agent.compile.sections import historical_trend_keys

        assert (
            historical_trend_keys(
                {"schema_version": 2, "blocks": []}, catalogue=load_section_catalogue()
            )
            == set()
        )
