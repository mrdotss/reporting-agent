"""`verify/derived_counts.py`'s re-derivation of the two drift kinds task 3.11 adds
(`scope_added_count`, `scope_removed_count`).

No test file for this module existed before this task — a coverage gap independent of
this change, left as found rather than backfilled wholesale here. This file covers only
the two new kinds' re-derivation, which is what this task is responsible for verifying.
"""

from __future__ import annotations

from decimal import Decimal

from reporting_agent.catalog.loader import load_section_catalogue
from reporting_agent.collect.snapshot import ResourceSnapshot, SkuCapacity
from reporting_agent.compile.ast import DerivedCount
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.sections import AuthoredMatch
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.verify.derived_counts import check_derived_counts
from snapshot_factory import build as build_fixture
from snapshot_factory import exact
from snapshot_factory import resource_record as make_rec

VM_TYPE = "Microsoft.Compute/virtualMachines"


def _view(resource_ids: list[str]):
    resources = []
    for rid in resource_ids:
        name = rid.rsplit("/", 1)[-1]
        resources.append(
            ResourceSnapshot(
                record=make_rec(resource_id=rid, name=name),
                sku=SkuCapacity(
                    name="Standard_D2s_v5", vcpus_available=2,
                    memory_bytes=Decimal("8589934592"),
                ),
                statistics=(exact("Percentage CPU", "avg", "12.50"),),
                day_buckets=(),
                facts=(),
            )
        )
    doc = build_fixture(resources=resources)
    return build_snapshot_view(doc)


def _v3_definition(sections: list[dict]) -> dict:
    return {
        "schema_version": 3,
        "provider": "azure",
        "identity": {"language": "en", "customer_name": "Test", "report_title": "Test"},
        "sections": sections,
        "period": {"kind": "last_full_month"},
        "design": {"preset": "corporate"},
        "front_matter": {},
    }


def _compiled_with_drift():
    catalogue = load_section_catalogue()
    vm_ids = [
        "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01",
        "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-02",
    ]
    view = _view(vm_ids)
    definition = _v3_definition([
        {
            "id": "sec_sub",
            "type": "azure_subscription",
            "position": 0,
            "selection": {
                "resource_types": [], "resource_groups": [], "tag_filters": [],
                "top_n": None, "sort": None,
            },
            "metrics": [],
            "presentation": "table_only",
        },
        {
            "id": "sec_cov",
            "type": "coverage_and_verification",
            "position": 1,
            "selection": {
                "resource_types": [], "resource_groups": [], "tag_filters": [],
                "top_n": None, "sort": None,
            },
            "metrics": [],
            "presentation": "table_only",
        },
    ])
    authored_matches = {"sec_sub": AuthoredMatch(resource_ids=frozenset({vm_ids[0]}))}

    compiled = compile_document(
        definition, view=view, catalogue=catalogue, authored_matches=authored_matches
    )
    return compiled, definition, view, catalogue, authored_matches


def test_scope_added_count_re_derives_to_the_same_value_the_compiler_stored():
    compiled, definition, view, catalogue, authored_matches = _compiled_with_drift()

    result = check_derived_counts(
        compiled.ledger,
        definition=definition,
        view=view,
        catalogue=catalogue,
        authored_matches=authored_matches,
    )

    assert result.findings == ()
    assert result.counts_checked >= 1


def test_without_view_catalogue_or_authored_matches_the_drift_kinds_are_unresolvable():
    """The three new parameters default to None precisely so every existing
    caller of check_derived_counts is unaffected — but a real DerivedCount of
    kind scope_added_count/scope_removed_count encountered with any of them
    missing must be reported unresolvable, never silently trusted."""
    compiled, definition, _view_obj, _catalogue, _authored = _compiled_with_drift()

    result = check_derived_counts(compiled.ledger, definition=definition)

    assert len(result.findings) >= 1
    assert any(f.get("derivation_kind") == "scope_added_count" for f in result.findings)
    for finding in result.findings:
        assert finding.get("expected") == "<unresolvable>"


def test_a_stored_value_that_disagrees_with_re_derivation_is_a_mismatch_finding():
    """Mutation-style: hand-construct a DerivedCount whose stored value is
    wrong and confirm check_derived_counts names the mismatch rather than
    trusting it."""
    compiled, definition, view, catalogue, authored_matches = _compiled_with_drift()

    real_count = next(
        c for c in compiled.ledger.derived_counts().values()
        if isinstance(c, DerivedCount) and c.derivation_kind == "scope_added_count"
    )
    wrong = DerivedCount(
        path=real_count.path,
        formatted=str(int(real_count.formatted) + 1),
        derivation_kind="scope_added_count",
        block_id=real_count.block_id,
    )

    from reporting_agent.compile.figures import FigureLedger
    tampered_ledger = FigureLedger()
    tampered_ledger.insert_derived_count(wrong)

    result = check_derived_counts(
        tampered_ledger,
        definition=definition,
        view=view,
        catalogue=catalogue,
        authored_matches=authored_matches,
    )

    assert len(result.findings) == 1
    assert result.findings[0].get("stored") == wrong.formatted
    assert result.findings[0].get("expected") == real_count.formatted
