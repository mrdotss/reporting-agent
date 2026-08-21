"""The Catalog_Evidence_Guard (Req 1.6, 2.1-2.4, 2.6, 2.7, 2.9-2.11).

## This module imports the guard, it does not reimplement it

`catalog/evidence.py` holds the rule; every test here calls it. A guard written twice —
once in `src/` for the image build and once here for the suite — proves the copy in the
test correct and says nothing about the one that ships. It is also what lets Property 5
(task 3.4) generate against the implementation.

## What the guard is for, restated because it decides the shape of these tests

A wrong catalog entry is **silent at run time**. Azure answers a request for a metric it
does not have with a per-resource error, the collector records a typed gap, the run
completes, verification passes, and the delivered document never mentions that metric. So
there is no run-time signal to test for; the only available control is a comparison against
recorded evidence, and the only useful tests are the ones that prove the comparison rejects
each way an entry can be wrong.

The four disagreements, each with its own test below: a **name** the fixture does not
report, a **unit** that is not the mapping's term for the reported one, an **aggregation**
the fixture does not report as supported, and a **missing fixture** entirely. Plus the
near-miss rule, which is about the *message* rather than the verdict — an exact-string
comparison already rejects `Percentage Cpu`, but calling it "absent" sends a reader looking
for a metric Azure does not have instead of at a typo.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from reporting_agent.catalog.evidence import (
    SECRET_FIELD_NAMES,
    UNIT_MAPPING,
    UNMAPPED_UNITS,
    assert_catalog_is_evidenced,
    check_catalog_evidence,
    evidence_directory,
    evidence_filename,
    load_fixture,
)
from reporting_agent.catalog.loader import (
    DECLARED_AGGREGATIONS,
    DECLARED_UNITS,
    load_catalog,
)

VM_TYPE = "Microsoft.Compute/virtualMachines"
ALL_FOUR = ["Total", "Count", "Minimum", "Maximum"]


def catalog_document(metrics: list[dict[str, Any]], *, resource_type: str = VM_TYPE) -> dict:
    return {
        "catalog_version": "1.1.0",
        "resource_types": {resource_type: {"metrics": metrics}},
    }


def fixture_document(
    definitions: list[dict[str, Any]], *, resource_type: str = VM_TYPE
) -> dict[str, Any]:
    return {
        "comment": "a synthetic fixture",
        "provenance": {
            "resource_type": resource_type,
            "region": "southeastasia",
            "captured_at": "2026-08-20T17:19:36Z",
        },
        "status": 200,
        "headers": {},
        "body": {"value": definitions},
    }


def definition(name: str, unit: str, aggregations: list[str]) -> dict[str, Any]:
    return {
        "namespace": VM_TYPE,
        "name": {"value": name},
        "unit": unit,
        "supportedAggregationTypes": aggregations,
    }


def loaded(tmp_path: Path, document: dict) -> Any:
    path = tmp_path / "metrics.v1.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return load_catalog(path)


def findings_for(
    tmp_path: Path,
    *,
    metrics: list[dict[str, Any]],
    definitions: list[dict[str, Any]] | None,
    resource_type: str = VM_TYPE,
):
    catalog = loaded(tmp_path, catalog_document(metrics, resource_type=resource_type))
    fixtures = (
        None
        if definitions is None
        else {resource_type: fixture_document(definitions, resource_type=resource_type)}
    )
    return check_catalog_evidence(catalog, fixtures=fixtures or {})


CPU_ENTRY = {
    "name": "Percentage CPU",
    "unit": "percent",
    "unit_family": "percentage",
    "aggregations": ALL_FOUR,
    "scale": 2,
}
CPU_REPORTED = definition("Percentage CPU", "Percent", ["Average", *ALL_FOUR])


# --- the shipped catalog (Req 1.6, 2.1) ---------------------------------------------


def test_the_shipped_catalog_agrees_with_its_evidence() -> None:
    """The assertion the image build makes. Every other test here proves this one can fail."""
    assert_catalog_is_evidenced()


def test_the_guard_checked_something() -> None:
    """A guard that scanned nothing reports no finding, which is why this is first.

    Both halves: the catalog declares metrics, and the evidence directory holds a fixture
    for each declared type. Either being empty would make the pass above vacuous.
    """
    catalog = load_catalog()
    declared_metrics = sum(len(entry.metrics) for entry in catalog.resource_types)

    assert declared_metrics > 0
    assert len(catalog.resource_types) > 0
    for entry in catalog.resource_types:
        path = evidence_directory() / evidence_filename(entry.resource_type)
        assert path.is_file(), f"{entry.resource_type} has no committed fixture at {path}"


def test_every_declared_type_has_exactly_one_fixture(tmp_path: Path) -> None:
    """Req 2.1 — one recorded response per declared resource type, not one per file that
    happens to be present."""
    catalog = load_catalog()
    directory = evidence_directory()

    expected = {evidence_filename(entry.resource_type) for entry in catalog.resource_types}
    present = {path.name for path in directory.glob("*.json")}

    assert expected <= present, sorted(expected - present)
    assert present - expected == set(), (
        f"these fixtures name no declared resource type, so nothing checks them: "
        f"{sorted(present - expected)}"
    )


def test_the_filename_derivation_round_trips_every_declared_type() -> None:
    """`/` becomes `__` rather than `_`, because a single underscore, a hyphen and a period
    all occur inside the segments themselves — so substituting one would let two distinct
    types collide on one filename."""
    names = {
        entry.resource_type: evidence_filename(entry.resource_type)
        for entry in load_catalog().resource_types
    }

    assert len(set(names.values())) == len(names), names
    assert names["Microsoft.Sql/servers/databases"] == "microsoft.sql__servers__databases.json"
    assert names[VM_TYPE] == "microsoft.compute__virtualmachines.json"


# --- the four disagreements (Req 2.2, 2.3, 2.4) --------------------------------------


def test_a_faithful_entry_produces_no_finding(tmp_path: Path) -> None:
    """Guard the guard: every rejection below has to be about the defect, not about the
    harness building something the guard refuses on other grounds."""
    assert findings_for(tmp_path, metrics=[CPU_ENTRY], definitions=[CPU_REPORTED]) == []


def test_a_name_the_fixture_does_not_report_is_rejected(tmp_path: Path) -> None:
    entry = {**CPU_ENTRY, "name": "Percentage CPU Utilisation"}

    findings = findings_for(tmp_path, metrics=[entry], definitions=[CPU_REPORTED])

    assert [(f.resource_type, f.metric, f.field) for f in findings] == [
        (VM_TYPE, "Percentage CPU Utilisation", "name")
    ]
    assert "reports no metric named" in findings[0].message


def test_a_unit_that_is_not_the_mappings_term_is_rejected(tmp_path: Path) -> None:
    """The fixture reports `Percent`, whose mapped term is `percent`. A catalog declaring
    `bytes` is wrong in the way that matters most: the unit family selects the sketch, so
    the percentile that comes out describes the wrong distribution."""
    entry = {**CPU_ENTRY, "unit": "bytes", "unit_family": "magnitude"}

    findings = findings_for(tmp_path, metrics=[entry], definitions=[CPU_REPORTED])

    assert [(f.metric, f.field) for f in findings] == [("Percentage CPU", "unit")]
    assert "'percent'" in findings[0].message


def test_an_unsupported_aggregation_is_rejected(tmp_path: Path) -> None:
    reported = definition("Percentage CPU", "Percent", ["Average", "Minimum", "Maximum"])

    findings = findings_for(tmp_path, metrics=[CPU_ENTRY], definitions=[reported])

    assert [(f.metric, f.field) for f in findings] == [("Percentage CPU", "aggregations")]
    assert "Total" in findings[0].message
    assert "Count" in findings[0].message


def test_a_resource_type_with_no_fixture_is_rejected(tmp_path: Path) -> None:
    """Req 2.4 — an entry cannot be added without the evidence it was derived from. This is
    the finding that keeps the whole guard from being vacuous for a newly added type."""
    findings = findings_for(tmp_path, metrics=[CPU_ENTRY], definitions=None)

    assert [(f.resource_type, f.field) for f in findings] == [(VM_TYPE, "fixture")]
    assert "no recorded Metric Definitions fixture" in findings[0].message


# --- the near-miss rule (Req 2.7) ----------------------------------------------------


@pytest.mark.parametrize(
    "declared",
    ["Percentage Cpu", " Percentage CPU", "Percentage_CPU", "Percentage-CPU", "percentage cpu"],
)
def test_a_near_miss_is_rejected_and_named_as_one(declared: str, tmp_path: Path) -> None:
    """Each of these is exactly how a portal display name differs from an API metric name.

    The verdict is the same as for an absent metric — both are rejections — so what this
    asserts is the **message**: a near miss says so and names the fixture's spelling, which
    is the difference between a five-minute fix and an afternoon spent looking for a metric
    Azure does not have.
    """
    findings = findings_for(
        tmp_path, metrics=[{**CPU_ENTRY, "name": declared}], definitions=[CPU_REPORTED]
    )

    assert len(findings) == 1
    assert findings[0].field == "name"
    assert "only by letter case, surrounding whitespace or a substituted separator" in (
        findings[0].message
    )
    assert "'Percentage CPU'" in findings[0].message


def test_a_genuinely_absent_metric_is_not_reported_as_a_near_miss(tmp_path: Path) -> None:
    """The other side of the same rule: the two messages have to be distinguishable, or the
    near-miss detection adds nothing."""
    findings = findings_for(
        tmp_path,
        metrics=[{**CPU_ENTRY, "name": "Available Memory Bytes"}],
        definitions=[CPU_REPORTED],
    )

    assert "only by letter case" not in findings[0].message
    assert "reports no metric named" in findings[0].message


# --- the unit mapping (Req 2.9, 2.10) ------------------------------------------------


def test_every_mapped_term_is_a_declared_unit() -> None:
    """Req 2.9 — the mapping's range is `DECLARED_UNITS` and nothing else, or it could map a
    reported unit to a term the loader then rejects."""
    assert set(UNIT_MAPPING.values()) <= DECLARED_UNITS


def test_bytes_per_second_maps_to_bytes_and_not_to_the_count_family() -> None:
    """Both names end in `PerSecond`, so a mapping written by pattern rather than by
    quantity would put a byte rate in the count family — and the family selects the
    sketch."""
    assert UNIT_MAPPING["BytesPerSecond"] == "bytes"
    assert UNIT_MAPPING["CountPerSecond"] == "count_per_second"


def test_the_mapping_and_the_unmapped_set_are_disjoint() -> None:
    """A unit in both would make the verdict depend on which check ran first."""
    assert set(UNIT_MAPPING) & set(UNMAPPED_UNITS) == set()


@pytest.mark.parametrize("reported_unit", sorted(UNMAPPED_UNITS))
def test_a_metric_reported_in_an_unmapped_unit_is_rejected(
    reported_unit: str, tmp_path: Path
) -> None:
    """Req 2.10. `Count`, `Seconds` and `Unspecified` have no honest term among `percent`,
    `bytes` and `count_per_second`, so a metric Azure reports in one of them cannot be
    declared — and the refusal names the unit and the reason rather than silently assigning
    the nearest-looking term."""
    reported = definition("Weird Metric", reported_unit, ALL_FOUR)
    entry = {**CPU_ENTRY, "name": "Weird Metric"}

    findings = findings_for(tmp_path, metrics=[entry], definitions=[reported])

    assert [(f.metric, f.field) for f in findings] == [("Weird Metric", "unit")]
    assert reported_unit in findings[0].message


def test_a_unit_in_neither_the_mapping_nor_the_unmapped_set_is_rejected(
    tmp_path: Path,
) -> None:
    """A unit the API invents next year must be an explicit decision, not a silent pass."""
    reported = definition("Weird Metric", "Furlongs", ALL_FOUR)

    findings = findings_for(
        tmp_path, metrics=[{**CPU_ENTRY, "name": "Weird Metric"}], definitions=[reported]
    )

    assert findings[0].field == "unit"
    assert "add it to one or the other explicitly" in findings[0].message


# --- the fixture exclusions (Req 2.5, 2.11) ------------------------------------------


def test_the_committed_fixtures_carry_no_identifier() -> None:
    """Req 2.5, 2.11 over the real files — the exclusion enforced rather than assumed."""
    for entry in load_catalog().resource_types:
        fixture = load_fixture(entry.resource_type)
        serialized = json.dumps(fixture)
        assert "/subscriptions/" not in serialized, entry.resource_type
        for field in ("resourceId", "resourceid", "subscriptionId", "tenantId"):
            assert f'"{field}"' not in serialized, (entry.resource_type, field)


@pytest.mark.parametrize("field", ["id", "resourceId", "subscriptionId", "tenantId"])
def test_a_fixture_carrying_an_identifier_field_is_rejected(
    field: str, tmp_path: Path
) -> None:
    reported = {**CPU_REPORTED, field: "/subscriptions/abc/resourceGroups/rg/x"}

    findings = findings_for(tmp_path, metrics=[CPU_ENTRY], definitions=[reported])

    assert findings, f"a fixture carrying {field!r} was accepted"
    assert any(field in finding.field or field in finding.message for finding in findings)


def test_a_fixture_carrying_a_guid_anywhere_is_rejected(tmp_path: Path) -> None:
    """Not only under a field name this module knows: a subscription id pasted into a
    description is the same leak."""
    reported = {
        **CPU_REPORTED,
        "displayDescription": "captured on 3f2b0000-0000-0000-0000-000000000000",
    }

    findings = findings_for(tmp_path, metrics=[CPU_ENTRY], definitions=[reported])

    assert any("GUID-shaped" in finding.message for finding in findings)


def test_every_secret_field_name_is_checked() -> None:
    """The list is what the check iterates, so an empty or truncated one would silently
    narrow it."""
    assert "resourceId" in SECRET_FIELD_NAMES
    assert "subscriptionId" in SECRET_FIELD_NAMES
    assert "id" in SECRET_FIELD_NAMES
    assert len(SECRET_FIELD_NAMES) >= 8


# --- provenance (Req 2.5) ------------------------------------------------------------


def test_the_committed_fixtures_record_their_provenance() -> None:
    for entry in load_catalog().resource_types:
        provenance = load_fixture(entry.resource_type)["provenance"]
        assert provenance["resource_type"] == entry.resource_type
        assert provenance["region"].strip()
        assert provenance["captured_at"].endswith("Z")


def test_a_fixture_whose_provenance_names_another_type_is_rejected(tmp_path: Path) -> None:
    """The file name is derived from `provenance.resource_type`, so a mismatch means the
    evidence for one type is filed under another."""
    directory = tmp_path / "evidence"
    directory.mkdir()
    fixture = fixture_document([CPU_REPORTED])
    fixture["provenance"]["resource_type"] = "Microsoft.Web/sites"
    (directory / evidence_filename(VM_TYPE)).write_text(json.dumps(fixture))

    catalog = loaded(tmp_path, catalog_document([CPU_ENTRY]))
    findings = check_catalog_evidence(catalog, directory=directory)

    assert any(finding.field == "provenance.resource_type" for finding in findings)


@pytest.mark.parametrize(
    "captured", ["2026-08-20T17:19:36+07:00", "2026-08-20T17:19:36.123Z", "2026-08-20", ""]
)
def test_a_capture_instant_that_is_not_a_whole_second_utc_instant_is_rejected(
    captured: str, tmp_path: Path
) -> None:
    directory = tmp_path / "evidence"
    directory.mkdir()
    fixture = fixture_document([CPU_REPORTED])
    fixture["provenance"]["captured_at"] = captured
    (directory / evidence_filename(VM_TYPE)).write_text(json.dumps(fixture))

    catalog = loaded(tmp_path, catalog_document([CPU_ENTRY]))
    findings = check_catalog_evidence(catalog, directory=directory)

    assert any(finding.field == "provenance.captured_at" for finding in findings)


# --- reporting (one fix pass clears the build) ---------------------------------------


def test_every_disagreement_is_reported_in_one_run(tmp_path: Path) -> None:
    """Not the first one. The same reason `render/themes.py` reports every missing
    `(theme, style)` pair at once: a guard that stops at the first failure turns one fix
    pass into as many builds as there are mistakes."""
    findings = findings_for(
        tmp_path,
        metrics=[
            {**CPU_ENTRY, "name": "Absent Metric"},
            {**CPU_ENTRY, "name": "Available Memory Bytes", "unit": "percent"},
        ],
        definitions=[
            CPU_REPORTED,
            definition("Available Memory Bytes", "Bytes", ALL_FOUR),
        ],
    )

    assert len(findings) == 2
    assert {finding.field for finding in findings} == {"name", "unit"}


def test_the_assertion_names_every_finding(tmp_path: Path) -> None:
    catalog = loaded(tmp_path, catalog_document([{**CPU_ENTRY, "name": "Absent Metric"}]))
    directory = tmp_path / "evidence"
    directory.mkdir()
    (directory / evidence_filename(VM_TYPE)).write_text(
        json.dumps(fixture_document([CPU_REPORTED]))
    )

    with pytest.raises(AssertionError, match="Absent Metric"):
        assert_catalog_is_evidenced(catalog, directory=directory)


def test_the_declared_aggregation_set_is_what_the_guard_compares_against() -> None:
    """The guard checks requested-against-supported, so the requested side has to be drawn
    from the loader's declared set or the comparison is against free text."""
    for entry in load_catalog().resource_types:
        for metric in entry.metrics:
            assert set(metric.aggregations) <= DECLARED_AGGREGATIONS
