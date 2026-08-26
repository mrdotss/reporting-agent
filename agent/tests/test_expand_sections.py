"""Tests for compile/sections.py — the section expander and its determinism guards.

Two guards are the point of this module:

1. **Anchor stability:** expanding the SAME definition twice produces IDENTICAL block id
   sets. An expander whose ids depend on iteration order rather than resolved order breaks
   replay's bit-identical-ledger assertion intermittently.

2. **Full determinism:** two calls to ``expand_sections`` with the same definition+view
   produce IDENTICAL ``BlockSpec`` tuples (not just identical ids — identical everything).
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from reporting_agent.catalog.loader import (
    LoadedSectionCatalogue,
    load_section_catalogue,
)
from reporting_agent.collect.snapshot import (
    ResourceSnapshot,
    SkuCapacity,
)
from reporting_agent.compile.sections import expand_sections
from reporting_agent.compile.snapshot_view import SnapshotView, build_snapshot_view
from reporting_agent.errors import CompileFailedError
from snapshot_factory import (
    CPU,
    VM_TYPE,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_snapshot_document(resource_ids: list[str]) -> dict:
    """Build a minimal real snapshot document with the given VM resource ids."""
    from snapshot_factory import build as build_fixture
    from snapshot_factory import exact
    from snapshot_factory import resource_record as make_rec

    resources = []
    for rid in resource_ids:
        name = rid.rsplit("/", 1)[-1]
        rec = make_rec(resource_id=rid, name=name)
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


def _make_view(resource_ids: list[str]) -> SnapshotView:
    """Build a SnapshotView from a list of resource ids."""
    doc = _make_snapshot_document(resource_ids)
    return build_snapshot_view(doc)


def _make_catalogue() -> LoadedSectionCatalogue:
    """Load the real section catalogue."""
    return load_section_catalogue()


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

        result = expand_sections(definition, catalogue=catalogue, view=view)

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

        result = expand_sections(definition, catalogue=catalogue, view=view)

        # azure_subscription has 2 expands_to entries: heading + resource_table, both per:"section"
        assert len(result) == 2
        assert result[0].id == "sec_sub__0"
        assert result[0].type == "heading"
        assert result[1].id == "sec_sub__1"
        assert result[1].type == "resource_table"

    def test_per_resource_expansion(self) -> None:
        """A per:'resource' block expands once per matched resource."""
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

        result = expand_sections(definition, catalogue=catalogue, view=view)

        # vm_utilization expands_to:
        # - heading per:resource (3 VMs)
        # - timeseries_chart per:resource when chart_and_table (3 VMs)
        # - resource_table per:resource when chart_and_table (3 VMs)
        # - top_n_table per:section (1)
        # Total: 3 + 3 + 3 + 1 = 10
        assert len(result) == 10

        # Check per-resource ids have the __n suffix
        heading_ids = [s.id for s in result if s.type == "heading"]
        assert heading_ids == ["sec_util__0__0", "sec_util__0__1", "sec_util__0__2"]

        # Check the top_n_table is per:section
        top_n = [s for s in result if s.type == "top_n_table"]
        assert len(top_n) == 1
        assert "__" in top_n[0].id
        # per:section gets no __n suffix
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

        result = expand_sections(definition, catalogue=catalogue, view=view)

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

        result = expand_sections(definition, catalogue=catalogue, view=view)

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

        result = expand_sections(definition, catalogue=catalogue, view=view)

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

        result = expand_sections(definition, catalogue=catalogue, view=view)

        types = [s.type for s in result]
        assert "timeseries_chart" not in types
        assert "resource_table" in types

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

        result = expand_sections(definition, catalogue=catalogue, view=view)

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

        result_a = expand_sections(definition, catalogue=catalogue, view=view)
        result_b = expand_sections(definition, catalogue=catalogue, view=view)

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

        result_a = expand_sections(definition, catalogue=catalogue, view=view)
        result_b = expand_sections(definition, catalogue=catalogue, view=view)

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

        result_a = expand_sections(definition, catalogue=catalogue, view=view)
        result_b = expand_sections(definition, catalogue=catalogue, view=view)

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
        first_result = expand_sections(definition, catalogue=catalogue, view=view)
        for _ in range(9):
            result = expand_sections(definition, catalogue=catalogue, view=view)
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
            expand_sections(definition, catalogue=catalogue, view=view)

    def test_missing_sections_array_raises(self) -> None:
        catalogue = _make_catalogue()
        view = _make_view(["/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"])
        definition = {"schema_version": 3, "provider": "azure"}

        with pytest.raises(CompileFailedError, match="no sections array"):
            expand_sections(definition, catalogue=catalogue, view=view)

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
            expand_sections(definition, catalogue=catalogue, view=view)


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

        result = expand_sections(definition, catalogue=catalogue, view=view)

        for spec in result:
            assert spec.scope_override is not None
            assert VM_TYPE in spec.scope_override.resource_types
            assert "rg-prod" in spec.scope_override.resource_groups

    def test_per_resource_block_carries_ordinal_in_config(self) -> None:
        """per:'resource' blocks carry _resource_ordinal in config."""
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
        ])

        result = expand_sections(definition, catalogue=catalogue, view=view)

        # Find per-resource blocks (those with __n__m pattern)
        per_resource = [s for s in result if s.id.count("__") == 2]
        assert len(per_resource) > 0

        ordinals = [s.config.get("_resource_ordinal") for s in per_resource]
        # Should have ordinals 0 and 1 for each expansion block type
        assert 0 in ordinals
        assert 1 in ordinals
