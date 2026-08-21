"""**Property 5: Every catalog entry is evidenced.** Identifier `catalog_evidence`.

**Validates: Req 1.6, 2.2, 2.3, 2.4, 2.7, 2.9, 2.10**

## What is generated, and against what

`hypothesis` builds a **fixture set** — 1 to 7 resource types, each with 1 to 30 metric
definitions drawn from the Metric Definitions API's own unit vocabulary and 1 to 4 supported
aggregations — and then builds a **catalog** whose entries are drawn *from those fixtures*.
So the faithful case is faithful by construction, and every rejection below is a named
mutation applied to it.

The eight mutations are the eight ways an entry can be wrong: `none`, `rename`, `case-fold`,
`pad with whitespace`, `substitute a separator`, `change the unit`, `add an unsupported
aggregation`, and `remove the fixture`.

## Why this is a property and not a table

The guard runs against a hand-written catalog and seven hand-recorded fixtures. A table test
proves it works on those; it cannot prove the *rule* holds. The four mutants the design names
are each an implementation that passes a plausible table:

* comparing metric names **case-insensitively** accepts `Percentage Cpu`, and a
  case-insensitive comparison is the natural thing to reach for when the resource type
  lookup two lines away is deliberately case-folded;
* comparing **only names** accepts a metric declared in the wrong unit family, which sketches
  the wrong distribution and produces a percentile describing nothing;
* comparing the catalog's unit to the fixture's unit as **equal strings** fails every correct
  entry, because `Percent` and `percent` are two vocabularies;
* passing when a fixture is **missing** makes the guard vacuous for exactly the case it
  exists for — a newly added resource type.

## The one assertion that is not about a verdict

`test_the_verdict_is_identical_on_every_call` exists because the guard reads files and walks
mappings, and a set-iteration order leaking into the findings list would make the same
catalog pass and fail on different runs. A flaky evidence guard would be worked around rather
than fixed.
"""

from __future__ import annotations

from typing import Any, Final

from hypothesis import example, given, settings
from hypothesis import strategies as st

from reporting_agent.catalog.evidence import (
    UNIT_MAPPING,
    check_catalog_evidence,
)
from reporting_agent.catalog.loader import DECLARED_AGGREGATIONS, load_catalog

# The API's own unit vocabulary, which is **not** `DECLARED_UNITS` — that is the whole
# reason a mapping exists (Req 2.9). Restricted to the mapped names here, so the faithful
# case is genuinely faithful; `Count`, `Seconds` and `Unspecified` have their own rejection
# test in `tests/test_catalog_evidence.py` and would make every generated entry a rejection.
REPORTED_UNITS: Final[tuple[str, ...]] = tuple(sorted(UNIT_MAPPING))

AGGREGATIONS: Final[tuple[str, ...]] = tuple(sorted(DECLARED_AGGREGATIONS))

RESOURCE_TYPES: Final[tuple[str, ...]] = (
    "Microsoft.Compute/virtualMachines",
    "Microsoft.Sql/servers/databases",
    "Microsoft.Sql/managedInstances",
    "Microsoft.DBforPostgreSQL/flexibleServers",
    "Microsoft.Storage/storageAccounts",
    "Microsoft.Compute/disks",
    "Microsoft.Web/sites",
)

SEPARATORS: Final[tuple[str, ...]] = (" ", "_", "-", "/", ".")

MUTATIONS: Final[tuple[str, ...]] = (
    "none",
    "rename",
    "case_fold",
    "pad_whitespace",
    "substitute_separator",
    "change_unit",
    "unsupported_aggregation",
    "remove_fixture",
)

# Metric names built from words rather than from arbitrary text, so a generated name can
# actually *have* a separator to substitute and a case to fold. A random `st.text()` would
# generate mostly names for which five of the eight mutations are no-ops.
WORDS: Final[tuple[str, ...]] = (
    "Percentage",
    "CPU",
    "Available",
    "Memory",
    "Bytes",
    "Disk",
    "Read",
    "Write",
    "Network",
    "Total",
    "Operations",
    "Sec",
)


@st.composite
def metric_names(draw: st.DrawFn) -> str:
    parts = draw(st.lists(st.sampled_from(WORDS), min_size=2, max_size=4, unique=True))
    return " ".join(parts)


@st.composite
def fixture_sets(draw: st.DrawFn) -> dict[str, dict[str, Any]]:
    """1-7 resource types, each carrying 1-30 metric definitions."""
    types = draw(
        st.lists(st.sampled_from(RESOURCE_TYPES), min_size=1, max_size=7, unique=True)
    )
    fixtures: dict[str, dict[str, Any]] = {}
    for resource_type in types:
        names = draw(
            st.lists(metric_names(), min_size=1, max_size=30, unique=True)
        )
        definitions = []
        for name in names:
            definitions.append(
                {
                    "namespace": resource_type,
                    "name": {"value": name},
                    "unit": draw(st.sampled_from(REPORTED_UNITS)),
                    "supportedAggregationTypes": draw(
                        st.lists(
                            st.sampled_from(AGGREGATIONS),
                            min_size=1,
                            max_size=4,
                            unique=True,
                        )
                    ),
                }
            )
        fixtures[resource_type] = {
            "provenance": {
                "resource_type": resource_type,
                "region": "southeastasia",
                "captured_at": "2026-08-20T17:19:36Z",
            },
            "status": 200,
            "headers": {},
            "body": {"value": definitions},
        }
    return fixtures


def faithful_catalog(fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """A catalog document every entry of which agrees with `fixtures`."""
    resource_types: dict[str, Any] = {}
    for resource_type, fixture in fixtures.items():
        metrics = []
        for definition in fixture["body"]["value"]:
            reported_unit = definition["unit"]
            metrics.append(
                {
                    "name": definition["name"]["value"],
                    "unit": UNIT_MAPPING[reported_unit],
                    "unit_family": (
                        "percentage" if UNIT_MAPPING[reported_unit] == "percent" else "magnitude"
                    ),
                    "aggregations": list(definition["supportedAggregationTypes"]),
                    "scale": 2,
                }
            )
        resource_types[resource_type] = {"metrics": metrics}
    return {"catalog_version": "1.1.0", "resource_types": resource_types}


def loaded(document: dict[str, Any], tmp_path) -> Any:
    import json

    path = tmp_path / "metrics.v1.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return load_catalog(path)


def other_unit(unit: str) -> str:
    """A declared unit term that is not `unit` — so `change_unit` always changes it."""
    return next(term for term in sorted(set(UNIT_MAPPING.values())) if term != unit)


def apply_mutation(
    catalog: dict[str, Any],
    fixtures: dict[str, dict[str, Any]],
    mutation: str,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]], str, str]:
    """`(catalog, fixtures, resource_type, metric)` after `mutation`.

    Mutates the **first** metric of the **first** resource type, so the expected finding is
    always about a known pair and the assertion can name it.
    """
    resource_type = next(iter(catalog["resource_types"]))
    entry = catalog["resource_types"][resource_type]["metrics"][0]
    name = entry["name"]

    if mutation == "none":
        return catalog, fixtures, resource_type, name
    if mutation == "rename":
        entry["name"] = f"{name} Utilisation Rate"
    elif mutation == "case_fold":
        entry["name"] = name.title() if name != name.title() else name.upper()
    elif mutation == "pad_whitespace":
        entry["name"] = f" {name}"
    elif mutation == "substitute_separator":
        entry["name"] = name.replace(" ", "_")
    elif mutation == "change_unit":
        entry["unit"] = other_unit(entry["unit"])
    elif mutation == "unsupported_aggregation":
        supported = set(
            fixtures[resource_type]["body"]["value"][0]["supportedAggregationTypes"]
        )
        absent = sorted(set(AGGREGATIONS) - supported)
        if not absent:  # every aggregation is supported; nothing to add
            return catalog, fixtures, resource_type, "none"
        entry["aggregations"] = [*entry["aggregations"], absent[0]]
    elif mutation == "remove_fixture":
        fixtures = {k: v for k, v in fixtures.items() if k != resource_type}
    return catalog, fixtures, resource_type, entry["name"]


PROPERTY_SETTINGS = settings(max_examples=100, deadline=None)
"""`deadline=None` and nothing else.

**No `suppress_health_check`**, deliberately, and `tests/test_property_hygiene.py` enforces
that: `HealthCheck.filter_too_much` and `HealthCheck.data_too_large` are the mechanism by
which hypothesis fails a property whose generators discard nearly every input, and
suppressing either would make this property's green meaningless in exactly the way the
generators here are most likely to go wrong — 7 resource types x 30 metrics is a large draw,
and a generator that kept overshooting is one that tested small catalogs and reported
success."""


# --- 5.1 a faithful entry is accepted -------------------------------------------------


@given(fixtures=fixture_sets())
@PROPERTY_SETTINGS
def test_a_faithful_catalog_is_accepted(fixtures, tmp_path_factory) -> None:
    """Every entry drawn from its own fixture, so the guard must find nothing.

    The direction that catches a guard which rejects correct entries — which is what
    comparing `Percent` to `percent` as equal strings does, and it would reject the whole
    shipped catalog.
    """
    catalog = loaded(faithful_catalog(fixtures), tmp_path_factory.mktemp("faithful"))

    assert check_catalog_evidence(catalog, fixtures=fixtures) == []


# --- 5.2-5.4 each disagreement is rejected, naming type, metric and field -------------


# The declared examples of Req 2.7 and Req 2.4, each pinned as a one-line `@example` over a
# named single-metric fixture. Written as plain `@example` rather than `@example(...).via(...)`
# to match the fourteen property modules already here — and because the hygiene ratchet counts
# `@example` decorators by their trailing name, so a `.via()` chain reads as zero examples and
# silently drops them from the retention gate.
def one_metric_fixture(
    name: str = "Percentage CPU",
    unit: str = "Percent",
    aggregations: tuple[str, ...] = ("Total", "Count"),
) -> dict[str, dict[str, Any]]:
    """One resource type carrying one metric — the smallest fixture a mutation can act on."""
    resource_type = "Microsoft.Compute/virtualMachines"
    return {
        resource_type: {
            "provenance": {
                "resource_type": resource_type,
                "region": "southeastasia",
                "captured_at": "2026-08-20T17:19:36Z",
            },
            "status": 200,
            "headers": {},
            "body": {
                "value": [
                    {
                        "namespace": resource_type,
                        "name": {"value": name},
                        "unit": unit,
                        "supportedAggregationTypes": list(aggregations),
                    }
                ]
            },
        }
    }


DECLARED_FIXTURE: Final[dict[str, dict[str, Any]]] = one_metric_fixture()
"""The fixture the four declared examples below mutate: a single `Percentage CPU` metric.

`Percentage CPU` specifically, because it is the metric whose portal display name and API
name differ — `Percentage Cpu` is what a reader copies off the portal, and it is the exact
near miss Req 2.7 exists for."""


@given(fixtures=fixture_sets(), mutation=st.sampled_from(MUTATIONS))
@PROPERTY_SETTINGS
# Req 2.7 — `Percentage Cpu` against a fixture's `Percentage CPU`: differs by case alone.
@example(fixtures=DECLARED_FIXTURE, mutation="case_fold")
# Req 2.7 — `Percentage_CPU`: differs by a substituted separator alone.
@example(fixtures=DECLARED_FIXTURE, mutation="substitute_separator")
# Req 2.7 — ` Percentage CPU`: differs by leading whitespace alone.
@example(fixtures=DECLARED_FIXTURE, mutation="pad_whitespace")
# Req 2.4 — an entry whose resource type has no recorded fixture at all, which is what makes
# the guard vacuous for a newly added type if it passes.
@example(fixtures=DECLARED_FIXTURE, mutation="remove_fixture")
def test_every_mutation_is_rejected_and_a_faithful_entry_is_not(
    fixtures, mutation, tmp_path_factory
) -> None:
    """The core of the property: `none` is accepted and each of the other seven is not.

    Both directions in one function on purpose. A rejection test alone passes for a guard
    that rejects everything, and an acceptance test alone passes for one that accepts
    everything; the claim is that the guard *discriminates*, which needs both over the same
    generated input.
    """
    document = faithful_catalog(fixtures)
    document, fixtures, resource_type, metric = apply_mutation(
        document, dict(fixtures), mutation
    )
    catalog = loaded(document, tmp_path_factory.mktemp("mutated"))

    findings = check_catalog_evidence(catalog, fixtures=fixtures)

    if mutation == "none" or metric == "none":
        assert findings == [], f"{mutation} produced {findings}"
        return

    assert findings, f"{mutation} was accepted"
    # Every finding names its resource type, and the one about the mutated pair names the
    # field that disagreed — Req 2.3's "naming the resource type, the metric name and the
    # disagreeing field" is what makes a failure actionable rather than a bare refusal.
    assert all(finding.resource_type for finding in findings)
    relevant = [
        finding
        for finding in findings
        if finding.resource_type == resource_type
    ]
    assert relevant, f"{mutation} produced no finding for {resource_type}"

    expected_field = {
        "rename": "name",
        "case_fold": "name",
        "pad_whitespace": "name",
        "substitute_separator": "name",
        "change_unit": "unit",
        "unsupported_aggregation": "aggregations",
        "remove_fixture": "fixture",
    }[mutation]
    assert any(finding.field == expected_field for finding in relevant), (
        f"{mutation} was rejected but no finding names the {expected_field!r} field: "
        f"{[f.field for f in relevant]}"
    )


# --- 5.5 a near miss is rejected AS a near miss ----------------------------------------


@given(fixtures=fixture_sets(), separator=st.sampled_from(SEPARATORS))
@PROPERTY_SETTINGS
def test_every_near_miss_form_is_rejected_and_named_as_one(
    fixtures, separator, tmp_path_factory
) -> None:
    """Req 2.7 over all five separators.

    The verdict is the same as for an absent metric, so what this asserts is the message: a
    portal display name differs from an API metric name by exactly case, whitespace and a
    substituted separator, and calling that "absent" sends a reader looking for a metric
    Azure does not have.
    """
    document = faithful_catalog(fixtures)
    resource_type = next(iter(document["resource_types"]))
    entry = document["resource_types"][resource_type]["metrics"][0]
    entry["name"] = entry["name"].replace(" ", separator).swapcase()
    catalog = loaded(document, tmp_path_factory.mktemp("nearmiss"))

    findings = check_catalog_evidence(catalog, fixtures=fixtures)
    name_findings = [
        finding
        for finding in findings
        if finding.resource_type == resource_type and finding.field == "name"
    ]

    assert name_findings, f"a {separator!r}-substituted, case-swapped name was accepted"
    assert any(
        "only by letter case, surrounding whitespace or a substituted separator"
        in finding.message
        for finding in name_findings
    ), [finding.message for finding in name_findings]


# --- 5.6 the unit mapping is applied, not compared as strings --------------------------


@given(fixtures=fixture_sets())
@PROPERTY_SETTINGS
def test_the_reported_unit_is_never_accepted_as_the_declared_one(
    fixtures, tmp_path_factory
) -> None:
    """A catalog declaring the **reported** spelling — `Percent` where `percent` belongs —
    must never end up an accepted, evidenced entry. That is the other half of the mapping:
    the two vocabularies are *associated*, not interchangeable.

    The claim is deliberately about the **outcome**, not about which layer refuses, because
    two layers legitimately can and the property must hold either way:

    * the loader's own per-entry validation refuses a unit outside `DECLARED_UNITS` and
      degrades that metric to an `InvalidEntry` — and if it was the only entry in scope, the
      whole catalog is `CATALOG_UNUSABLE` and no snapshot is written at all;
    * or the entry survives loading and the guard finds it.

    Asserting "the guard produced a finding" alone would fail on the first case, which is
    the *stronger* refusal — the entry never became a metric. So what is asserted is that no
    metric carrying the reported spelling is ever both loaded and evidenced.
    """
    from reporting_agent.errors import CatalogUnusableError

    document = faithful_catalog(fixtures)
    resource_type = next(iter(document["resource_types"]))
    entry = document["resource_types"][resource_type]["metrics"][0]
    reported = fixtures[resource_type]["body"]["value"][0]["unit"]
    entry["unit"] = reported  # the API's spelling, not the catalog's

    try:
        catalog = loaded(document, tmp_path_factory.mktemp("reportedunit"))
    except CatalogUnusableError:
        # Refused before any entry existed: the strongest available outcome.
        return

    declared = catalog.for_resource_type(resource_type)
    loaded_with_reported_unit = declared is not None and any(
        metric.unit == reported for metric in declared.metrics
    )
    if not loaded_with_reported_unit:
        # Degraded to an `InvalidEntry`, so it is not an accepted entry either.
        assert catalog.invalid_entries
        return

    assert check_catalog_evidence(catalog, fixtures=fixtures), (
        f"a metric declaring the reported spelling {reported!r} loaded as a valid entry "
        f"and the guard accepted it"
    )


def test_bytes_per_second_is_not_mapped_to_the_count_family() -> None:
    """A declared example rather than a generated one, because it is about a **specific
    pair**: both names end in `PerSecond`, so a mapping written by pattern instead of by
    quantity puts a byte rate in the count family — and the family selects the sketch, so
    the percentile that comes out describes the wrong distribution."""
    assert UNIT_MAPPING["BytesPerSecond"] == "bytes"
    assert UNIT_MAPPING["BytesPerSecond"] != "count_per_second"
    assert UNIT_MAPPING["CountPerSecond"] == "count_per_second"


# --- 5.7 the verdict is a function of its inputs ---------------------------------------


@given(fixtures=fixture_sets(), mutation=st.sampled_from(MUTATIONS))
@PROPERTY_SETTINGS
def test_the_verdict_is_identical_on_every_call(
    fixtures, mutation, tmp_path_factory
) -> None:
    """The guard walks mappings and reads files, so a set-iteration order leaking into the
    findings would make one catalog pass and fail on different runs — and a flaky evidence
    guard gets worked around rather than fixed."""
    document = faithful_catalog(fixtures)
    document, fixtures, _resource_type, _metric = apply_mutation(
        document, dict(fixtures), mutation
    )
    catalog = loaded(document, tmp_path_factory.mktemp("stable"))

    first = check_catalog_evidence(catalog, fixtures=fixtures)
    second = check_catalog_evidence(catalog, fixtures=fixtures)

    assert [str(finding) for finding in first] == [str(finding) for finding in second]
