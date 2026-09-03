"""The emit-estimate mirror, agent half (task 3.8, Requirements 11.1-11.7).

`app/lib/profiles/emit.ts#estimateEmit` (TypeScript) and this file assert against
one committed corpus rather than against each other, because the two cannot be
compared by a static mirror — one is TypeScript, one is Python. The TS side
computes an estimate from a scan's resource-type counts; this file compiles a
REAL synthetic snapshot built from the SAME resource counts and asserts the real
compiler's `figure_count` (and block-type counts) match the corpus's
`expected` values. A change to the expansion arithmetic that moves the counts
fails on both sides or neither.

Every real-catalogue case here (`catalogue_entry` present in
`catalog/sections.v1.json`, `synthetic` absent or false) uses an entry whose
`expands_to` declares only `attribute`/`fact` columns — confirmed by inspection
that no shipped `resource_table`/`top_n_table` entry declares a metric-kind
column today, so every one of them compiles to ZERO figures regardless of the
section's own `metrics` selection. The `synthetic: true` cases use a hand-built
catalogue entry (not present in the shipped file) carrying a real metric-kind
`resource_table` column, so the matched-resources-times-metric-count arithmetic
is exercised on both sides by at least one case — see the corpus's own `note`.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from reporting_agent.catalog.loader import (
    LoadedSectionCatalogue,
    SectionCatalogueEntry,
    SectionExpansionBlock,
    load_section_catalogue,
)
from reporting_agent.collect.snapshot import FactEntry, ResourceSnapshot, SkuCapacity
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.snapshot_view import build_snapshot_view
from snapshot_factory import build as build_fixture
from snapshot_factory import exact
from snapshot_factory import resource_record as make_rec

CASES_PATH = Path(__file__).parent / "fixtures" / "emit-estimate" / "cases.json"

# The two hand-built entries the corpus's `synthetic: true` cases reference —
# mirror exactly what `app/lib/profiles/emit.test.ts`'s own `SYNTHETIC_ENTRIES`
# declares. Kept in sync by both reading the same corpus case names rather than
# by any shared code, since the two are different languages.
_SYNTHETIC_ENTRIES = {
    "synthetic_metric_table": SectionCatalogueEntry(
        key="synthetic_metric_table",
        number=9001,
        title_id="doc.section.azure_subscription",
        group="inventory",
        position="free",
        repeatable=False,
        needs_resource_types=("Microsoft.Compute/virtualMachines",),
        needs_fact_sources=(),
        metric_bearing=True,
        presets=(),
        expands_to=(
            SectionExpansionBlock(block="heading", per="section"),
            SectionExpansionBlock(
                block="resource_table",
                per="section",
                config=(
                    (
                        "columns",
                        [{"metric": "Percentage CPU", "statistic": "avg"}],
                    ),
                ),
            ),
        ),
    ),
    "synthetic_two_metric_table": SectionCatalogueEntry(
        key="synthetic_two_metric_table",
        number=9002,
        title_id="doc.section.azure_subscription",
        group="inventory",
        position="free",
        repeatable=False,
        needs_resource_types=("Microsoft.Compute/virtualMachines",),
        needs_fact_sources=(),
        metric_bearing=True,
        presets=(),
        expands_to=(
            SectionExpansionBlock(block="heading", per="section"),
            SectionExpansionBlock(
                block="resource_table",
                per="section",
                config=(
                    (
                        "columns",
                        [
                            {"metric": "Percentage CPU", "statistic": "avg"},
                            {"metric": "Percentage CPU", "statistic": "max"},
                        ],
                    ),
                ),
            ),
        ),
    ),
}


def _cases() -> list[dict[str, Any]]:
    document = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    cases = document["cases"]
    assert cases, "the emit-estimate corpus is empty"
    return list(cases)


def _catalogue_for(case: dict[str, Any]) -> LoadedSectionCatalogue:
    if case.get("synthetic"):
        entry = _SYNTHETIC_ENTRIES[case["catalogue_entry"]]
        return LoadedSectionCatalogue(
            catalogue_version="test-synthetic",
            entries=(entry,),
        )
    return load_section_catalogue()


def _metric_refs_for(catalogue: LoadedSectionCatalogue, section_type: str) -> list[tuple[str, str]]:
    """Every `{"metric": ..., "statistic": ...}` entry declared in the section
    type's own catalogue expansion — what the compiler actually reads to decide
    which statistics a resource needs to carry, since `expand_sections` never
    consults the section's own `metrics` field (see `emit.ts`'s module
    docstring for the same finding on the TypeScript side)."""
    entry = catalogue.by_key(section_type)
    if entry is None:
        return []

    refs: list[tuple[str, str]] = []
    for expansion in entry.expands_to:
        columns = dict(expansion.config).get("columns") if expansion.config else None
        if not isinstance(columns, list):
            continue
        for column in columns:
            if isinstance(column, dict) and "metric" in column and column.get("metric"):
                refs.append((column["metric"], column["statistic"]))
    return refs



def _declared_facts(resource_type: str) -> tuple[FactEntry, ...]:
    """One answered fact per key the catalogue declares for `resource_type`.

    A resource that answers none of its declared facts is a resource whose table now
    prints the no-data notice instead of a grid — correct behaviour, and not what these
    cases are about. The case named "matched count exceeds the 500-row table cap" has to
    produce a **table** for its cap to bite; with every fact unanswered it produced a
    one-row notice and no truncation figure, and the corpus disagreed with the estimator
    over a path neither was testing.

    The value is the same for every key on purpose: what these cases count is columns and
    rows, and a fact's content has no bearing on either.
    """
    from reporting_agent.catalog.loader import load_catalog

    declared = load_catalog().facts
    for entry in declared.resource_types:
        if entry.resource_type.casefold() != resource_type.casefold():
            continue
        return tuple(
            FactEntry(
                key=fact.key,
                value="present",
                value_kind="text",
                source="resource_graph",
                collected_at="2026-08-31T00:00:00Z",
                formatted="present",
            )
            for fact in entry.facts
            if fact.value_kind == "text"
        )
    return ()


def _snapshot_view_for(case: dict[str, Any]):
    """Build a real SnapshotView carrying exactly the resource counts the
    corpus case's `scan_type_counts` declares, with every metric the section
    type's catalogue expansion actually declares as a real statistic on every
    resource — the honest common case the estimator itself assumes (see
    `emit.ts`'s module docstring).

    `scan_distinct_counts` spreads those resources across that many resource
    groups. It exists because `inventory_summary` reports the estate *as* its
    groupings — one row and one figure per distinct resource group — and how many
    groups a set of resources falls across is not derivable from a count per
    resource type. The real scan records it (`report_scans.resource_groups`), the
    estimator reads it, and this builder has to honour it or the two halves would
    be counting rows of different tables.

    Absent, it is one group: what every case did before the field existed, so no
    existing case's counts move."""
    catalogue = _catalogue_for(case)
    metrics = _metric_refs_for(catalogue, case["section"]["type"])
    distinct = case.get("scan_distinct_counts") or {}
    group_count = max(1, int(distinct.get("resource_group", 1)))

    resources = []
    ordinal = 0
    for resource_type, count in case["scan_type_counts"].items():
        for _ in range(count):
            ordinal += 1
            group = f"rg-prod-{ordinal % group_count}" if group_count > 1 else "rg-prod"
            rid = f"/subscriptions/sub-1/resourceGroups/{group}/providers/{resource_type}/res-{ordinal}"
            statistics = tuple(
                exact(metric, statistic, "50.00")
                for metric, statistic in metrics
                # `exact()` only knows avg/min/max; a case using a statistic it
                # cannot mint would be a corpus bug, not a runtime one — let it
                # raise rather than silently drop the statistic.
            )
            resources.append(
                ResourceSnapshot(
                    record=make_rec(
                        resource_id=rid,
                        name=f"res-{ordinal}",
                        # Resource Graph's OWN casing, exactly as the real scan
                        # stores it — this is what makes the case-folding case
                        # in the corpus meaningful on this side too.
                        resource_type=resource_type,
                        resource_group=group,
                    ),
                    sku=SkuCapacity(
                        name="Standard_D2s_v5",
                        vcpus_available=2,
                        memory_bytes=Decimal("8589934592"),
                    ),
                    statistics=statistics,
                    day_buckets=(),
                    facts=_declared_facts(resource_type),
                )
            )

    doc = build_fixture(
        resources=resources,
        resource_types=list(case["scan_type_counts"].keys()) or ["Microsoft.Compute/virtualMachines"],
    )
    return build_snapshot_view(doc)


def _v3_definition_for(case: dict[str, Any]) -> dict[str, Any]:
    section = dict(case["section"])
    section["id"] = "sec"
    section.setdefault("position", 0)
    return {
        "schema_version": 3,
        "provider": "azure",
        "identity": {"language": "en", "customer_name": "Test", "report_title": "Test"},
        "sections": [section],
        "period": {"kind": "last_full_month"},
        "design": {"preset": "corporate"},
        "front_matter": {},
    }


@pytest.mark.parametrize("case", _cases(), ids=lambda case: case["name"])
def test_the_real_compiler_matches_the_shared_corpus(case: dict[str, Any]) -> None:
    catalogue = _catalogue_for(case)
    view = _snapshot_view_for(case)
    definition = _v3_definition_for(case)

    compiled = compile_document(definition, view=view, catalogue=catalogue)

    expected = case["expected"]

    # Every block this section's expansion emits is under the "sec__N" prefix.
    block_ids = [key for key in compiled.nodes_by_block if key.startswith("sec__")]
    headings = sum(
        1
        for key in block_ids
        for node in compiled.nodes_by_block[key]
        if node.__class__.__name__ == "Paragraph"
    )
    tables = sum(
        1
        for key in block_ids
        for node in compiled.nodes_by_block[key]
        if node.__class__.__name__ == "Table"
    )

    assert headings == expected["headings"], (
        f"expected {expected['headings']} heading(s), compiled {headings}"
    )
    assert tables == expected["tables"], (
        f"expected {expected['tables']} table(s), compiled {tables}"
    )
    assert compiled.figure_count == expected["figures"], (
        f"expected figure_count {expected['figures']}, compiled {compiled.figure_count}"
    )


def test_the_corpus_covers_both_a_zero_and_a_positive_figure_case() -> None:
    """A corpus of only-zero cases would pass against a compiler that never
    emitted a figure at all, and one of only-positive cases would pass against
    one that always emitted something — both have to be present for the
    parametrized test above to mean anything."""
    expectations = [case["expected"] for case in _cases()]

    assert any(e["figures"] == 0 for e in expectations)
    assert any(e["figures"] > 0 for e in expectations)


def test_the_corpus_exercises_the_500_row_table_cap() -> None:
    cases = _cases()
    assert any(
        sum(case["scan_type_counts"].values()) > 500 for case in cases
    ), "no case exceeds MAX_TABLE_ROWS, so the cap is never actually exercised"


def test_every_real_catalogue_entry_referenced_still_exists() -> None:
    """If this fails, the corpus has drifted from the catalogue it claims to
    test against."""
    catalogue = load_section_catalogue()
    known_keys = {entry.key for entry in catalogue.entries}

    for case in _cases():
        if case.get("synthetic"):
            continue
        assert case["catalogue_entry"] in known_keys, (
            f"corpus case {case['name']!r} names catalogue_entry "
            f"{case['catalogue_entry']!r}, which the shipped catalogue no "
            f"longer declares"
        )
