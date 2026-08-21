"""The Metric_Catalog loader — one valid load, one fixture per invalid shape, and the
frozen guarantees `LoadedCatalog` makes (Req 32.3, 32.4, 32.5, 32.7, 32.8).

Every invalid-shape fixture below carries one otherwise-valid metric alongside the
broken entry, so each test proves two things at once: the broken entry lands in
`invalid_entries` tagged `catalog_entry_invalid`, and the entry next to it still loads
— per-entry validation degrades a resource type, it does not empty it (Req 32.5).
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

from reporting_agent.catalog.loader import (
    AGGREGATION_COUNT,
    AGGREGATION_TOTAL,
    AVERAGE_AGGREGATIONS,
    CATALOG_ENTRY_INVALID_GAP_TYPE,
    DECLARED_AGGREGATIONS,
    MAX_SCALE,
    MIN_SCALE,
    load_catalog,
)
from reporting_agent.errors import CatalogUnusableError, ErrorCode

RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"

CATALOG_VERSION = "1.1.0"
"""The shipped catalog's version, asserted as a literal here on purpose.

Req 1.3 requires the version to compare **greater** than the `1.0.0` the single-type
catalog declared, so the number is part of the contract rather than an incidental value:
`collect/snapshot.py` records it on every snapshot, and a report stays readable against the
catalog that produced it. A test reading it back out of the file it is checking would
assert nothing at all — see
:func:`test_the_shipped_catalog_version_is_greater_than_the_single_type_catalogs`, which
pins the ordering the criterion actually states."""

SEVEN_RESOURCE_TYPES = (
    "Microsoft.Compute/virtualMachines",
    "Microsoft.Sql/servers/databases",
    "Microsoft.Sql/managedInstances",
    "Microsoft.DBforPostgreSQL/flexibleServers",
    "Microsoft.Storage/storageAccounts",
    "Microsoft.Compute/disks",
    "Microsoft.Web/sites",
)
"""The seven types Req 1.1 enumerates, written out rather than read from the catalog.

The whole content of that criterion is *which* types are covered, so a test deriving the
set from the file under test would pass for any catalog at all — including the one-type
catalog this spec exists to replace."""

VALID_METRIC = {
    "name": "Percentage CPU",
    "unit": "percent",
    "unit_family": "percentage",
    "aggregations": ["Total", "Count", "Minimum", "Maximum"],
    "scale": 2,
}


def _write_catalog(tmp_path: Path, resource_types: dict[str, object]) -> Path:
    """Write a minimal catalog document — one `resource_types` object, no other
    top-level shape concerns — to a temp file and return its path."""
    document = {"catalog_version": "1.0.0", "resource_types": resource_types}
    path = tmp_path / "metrics.v1.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


# --- one fixture per invalid shape (Req 32.3, 32.4, 32.5) --------------------------


def test_metric_with_empty_name_is_invalid_and_the_sibling_metric_still_loads(
    tmp_path: Path,
) -> None:
    broken = {**VALID_METRIC, "name": ""}
    path = _write_catalog(
        tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC, broken]}}
    )

    catalog = load_catalog(path)

    assert len(catalog.invalid_entries) == 1
    invalid = catalog.invalid_entries[0]
    assert invalid.gap_type == CATALOG_ENTRY_INVALID_GAP_TYPE
    assert invalid.metric is None
    assert "name" in invalid.message

    rt = catalog.for_resource_type(RESOURCE_TYPE)
    assert rt is not None
    assert [m.name for m in rt.metrics] == ["Percentage CPU"]


def test_metric_with_unknown_unit_is_invalid_and_the_sibling_metric_still_loads(
    tmp_path: Path,
) -> None:
    broken = {**VALID_METRIC, "name": "Weird Metric", "unit": "kelvin"}
    path = _write_catalog(
        tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC, broken]}}
    )

    catalog = load_catalog(path)

    assert len(catalog.invalid_entries) == 1
    invalid = catalog.invalid_entries[0]
    assert invalid.gap_type == CATALOG_ENTRY_INVALID_GAP_TYPE
    assert invalid.metric == "Weird Metric"
    assert "unit" in invalid.message

    rt = catalog.for_resource_type(RESOURCE_TYPE)
    assert rt is not None
    assert [m.name for m in rt.metrics] == ["Percentage CPU"]


def test_metric_with_unknown_unit_family_is_invalid_and_the_sibling_metric_still_loads(
    tmp_path: Path,
) -> None:
    broken = {**VALID_METRIC, "name": "Weird Metric", "unit_family": "temperature"}
    path = _write_catalog(
        tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC, broken]}}
    )

    catalog = load_catalog(path)

    assert len(catalog.invalid_entries) == 1
    invalid = catalog.invalid_entries[0]
    assert invalid.gap_type == CATALOG_ENTRY_INVALID_GAP_TYPE
    assert invalid.metric == "Weird Metric"
    assert "unit family" in invalid.message

    rt = catalog.for_resource_type(RESOURCE_TYPE)
    assert rt is not None
    assert [m.name for m in rt.metrics] == ["Percentage CPU"]


def test_metric_with_no_valid_aggregation_is_invalid_and_the_sibling_metric_still_loads(
    tmp_path: Path,
) -> None:
    broken = {**VALID_METRIC, "name": "Weird Metric", "aggregations": []}
    path = _write_catalog(
        tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC, broken]}}
    )

    catalog = load_catalog(path)

    assert len(catalog.invalid_entries) == 1
    invalid = catalog.invalid_entries[0]
    assert invalid.gap_type == CATALOG_ENTRY_INVALID_GAP_TYPE
    assert invalid.metric == "Weird Metric"
    assert "aggregations" in invalid.message

    rt = catalog.for_resource_type(RESOURCE_TYPE)
    assert rt is not None
    assert [m.name for m in rt.metrics] == ["Percentage CPU"]


def test_metric_with_out_of_range_scale_is_invalid_and_the_sibling_metric_still_loads(
    tmp_path: Path,
) -> None:
    broken = {**VALID_METRIC, "name": "Weird Metric", "scale": MAX_SCALE + 1}
    path = _write_catalog(
        tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC, broken]}}
    )

    catalog = load_catalog(path)

    assert len(catalog.invalid_entries) == 1
    invalid = catalog.invalid_entries[0]
    assert invalid.gap_type == CATALOG_ENTRY_INVALID_GAP_TYPE
    assert invalid.metric == "Weird Metric"
    assert "scale" in invalid.message

    rt = catalog.for_resource_type(RESOURCE_TYPE)
    assert rt is not None
    assert [m.name for m in rt.metrics] == ["Percentage CPU"]


def test_duplicated_metric_name_is_invalid_and_the_first_occurrence_still_loads(
    tmp_path: Path,
) -> None:
    duplicate = dict(VALID_METRIC)
    path = _write_catalog(
        tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC, duplicate]}}
    )

    catalog = load_catalog(path)

    assert len(catalog.invalid_entries) == 1
    invalid = catalog.invalid_entries[0]
    assert invalid.gap_type == CATALOG_ENTRY_INVALID_GAP_TYPE
    assert invalid.metric == "Percentage CPU"
    assert "repeated" in invalid.message

    rt = catalog.for_resource_type(RESOURCE_TYPE)
    assert rt is not None
    assert [m.name for m in rt.metrics] == ["Percentage CPU"]


def test_derived_formula_identifier_absent_from_sources_is_invalid_and_the_metric_still_loads(
    tmp_path: Path,
) -> None:
    derived = {
        "statistic_id": "test_derived_pct",
        "unit": "percent",
        "unit_family": "percentage",
        "scale": 2,
        "formula": "bound_var + unbound_var",
        "sources": [
            {
                "kind": "metric",
                "name": "Percentage CPU",
                "statistic": "avg",
                "binds": "bound_var",
            }
        ],
    }
    path = _write_catalog(
        tmp_path,
        {RESOURCE_TYPE: {"metrics": [VALID_METRIC], "derived": [derived]}},
    )

    catalog = load_catalog(path)

    assert len(catalog.invalid_entries) == 1
    invalid = catalog.invalid_entries[0]
    assert invalid.gap_type == CATALOG_ENTRY_INVALID_GAP_TYPE
    assert invalid.metric == "test_derived_pct"
    assert "unbound_var" in invalid.message

    rt = catalog.for_resource_type(RESOURCE_TYPE)
    assert rt is not None
    assert [m.name for m in rt.metrics] == ["Percentage CPU"]
    assert rt.derived == ()


# --- whole-catalog unusability (Req 32.7) ------------------------------------------


def test_a_catalog_whose_every_entry_is_invalid_raises_catalog_unusable(
    tmp_path: Path,
) -> None:
    broken = {**VALID_METRIC, "unit": "kelvin"}
    path = _write_catalog(tmp_path, {RESOURCE_TYPE: {"metrics": [broken]}})

    with pytest.raises(CatalogUnusableError) as raised:
        load_catalog(path)

    assert raised.value.code is ErrorCode.CATALOG_UNUSABLE


def test_a_catalog_with_no_resource_types_at_all_raises_catalog_unusable(
    tmp_path: Path,
) -> None:
    path = _write_catalog(tmp_path, {})

    with pytest.raises(CatalogUnusableError):
        load_catalog(path)


# --- immutability of the loaded catalog (Req 32.8) ---------------------------------


def test_top_level_field_assignment_on_the_loaded_catalog_raises(
    tmp_path: Path,
) -> None:
    path = _write_catalog(tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC]}})
    catalog = load_catalog(path)

    with pytest.raises(dataclasses.FrozenInstanceError):
        catalog.catalog_version = "9.9.9"  # type: ignore[misc]


def test_a_metric_entry_nested_inside_the_catalog_still_rejects_mutation(
    tmp_path: Path,
) -> None:
    path = _write_catalog(tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC]}})
    catalog = load_catalog(path)
    metric = catalog.entries[0]

    with pytest.raises(dataclasses.FrozenInstanceError):
        metric.name = "renamed"  # type: ignore[misc]


def test_a_resource_type_catalog_nested_inside_the_catalog_still_rejects_mutation(
    tmp_path: Path,
) -> None:
    path = _write_catalog(tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC]}})
    catalog = load_catalog(path)
    rt = catalog.resource_types[0]

    with pytest.raises(dataclasses.FrozenInstanceError):
        rt.metrics = ()  # type: ignore[misc]


def test_the_entries_tuple_itself_rejects_item_assignment(tmp_path: Path) -> None:
    path = _write_catalog(tmp_path, {RESOURCE_TYPE: {"metrics": [VALID_METRIC]}})
    catalog = load_catalog(path)

    with pytest.raises(TypeError):
        catalog.entries[0] = catalog.entries[0]  # type: ignore[index]


# --- the happy path: the real shipped catalog (Req 32.1, 32.8) --------------------


def test_the_shipped_catalog_loads_clean_with_every_platform_metric_and_derived_entry() -> (
    None
):
    catalog = load_catalog()

    assert catalog.invalid_entries == ()
    assert catalog.catalog_version == CATALOG_VERSION

    rt = catalog.for_resource_type(RESOURCE_TYPE)
    assert rt is not None

    metric_names = {metric.name for metric in rt.metrics}
    assert metric_names == {
        "Percentage CPU",
        "Available Memory Bytes",
        "Disk Read Bytes",
        "Disk Write Bytes",
        "Disk Read Operations/Sec",
        "Disk Write Operations/Sec",
        "Network In Total",
        "Network Out Total",
    }

    derived_ids = {derived.statistic_id for derived in rt.derived}
    assert "memory_used_pct" in derived_ids

    enhanced_ids = {counter.statistic_id for counter in rt.enhanced_counters}
    assert "disk_free_pct" in enhanced_ids

    # `entries` flattens every kind across **every** resource type, so the sum is over
    # all of them. It equalled the virtual-machine counts alone only while the catalog
    # declared one type; keeping that form would have made this assertion a statement
    # about the catalog's breadth rather than about the flattening.
    assert len(catalog.entries) == sum(
        len(entry.metrics) + len(entry.derived) + len(entry.enhanced_counters)
        for entry in catalog.resource_types
    )


# --- the shipped catalog's breadth (Req 1.1, 1.2, 1.3, 1.6, 1.9) -------------------


def test_the_shipped_catalog_declares_exactly_the_seven_named_resource_types() -> None:
    """Req 1.1. A subscription of twenty-three resources produced a document about three
    of them because this set had one member; the criterion names which seven it must
    have, so the assertion names them too rather than counting them."""
    catalog = load_catalog()

    assert set(catalog.resource_type_names) == set(SEVEN_RESOURCE_TYPES)


def test_every_declared_resource_type_carries_a_namespace_and_at_least_one_metric() -> None:
    """Req 1.2. An entry declaring no metric is a resource type the report names and says
    nothing about, which is indistinguishable from the breadth problem this spec fixes."""
    catalog = load_catalog()

    for resource_type in SEVEN_RESOURCE_TYPES:
        declared = catalog.for_resource_type(resource_type)
        assert declared is not None, resource_type
        assert declared.metric_namespace.strip(), resource_type
        assert declared.metrics, f"{resource_type} declares no metric"
        for metric in declared.metrics:
            assert metric.name.strip()
            assert metric.unit
            assert metric.unit_family
            assert metric.aggregations
            assert MIN_SCALE <= metric.scale <= MAX_SCALE


def test_the_shipped_catalog_version_is_greater_than_the_single_type_catalogs() -> None:
    """Req 1.3, compared the way the criterion states it — component-wise as dotted
    decimal integers, not as strings. `"1.10.0" < "1.9.0"` lexicographically and the
    reverse numerically, so the comparison method is the assertion."""
    version = tuple(int(part) for part in load_catalog().catalog_version.split("."))

    assert version > (1, 0, 0)
    assert version == tuple(int(part) for part in CATALOG_VERSION.split("."))


def test_every_metric_emitting_an_average_requests_both_total_and_count() -> None:
    """Req 1.9, and the reason it is not merely bookkeeping.

    The average is count-weighted — the sum of interval totals over the sum of interval
    sample counts — so a metric requesting one of the two and not the other cannot
    produce one. This asserts the implication in the direction that can actually be
    violated: **if** `Total` and `Count` are both requested an average is derivable, and
    if either is absent the catalog must not be promising one.

    The converse is deliberately *not* asserted, because it is false by design and that
    is the whole of this spec's collector change: `Microsoft.Sql/servers/databases`'
    `cpu_percent` requests `Minimum` and `Maximum` only, because those are the
    aggregations Azure serves for it, and the honest result is exact extremes and no
    average rather than a dropped metric or a fabricated mean.

    Three of the four combinations are legitimate and one is not:

    * both — a count-weighted average, plus whichever extremes were requested;
    * `Total` alone — a **sum** of the interval totals, which is what
      `Microsoft.Web/sites`' `BytesReceived` means and all Azure serves for it;
    * neither — exact extremes only;
    * **`Count` alone — nothing derivable.** A sample count with no total is a
      denominator with no numerator: it can produce no average, no sum and no extreme, so
      a metric declaring it is requesting points that can only be discarded.
    """
    catalog = load_catalog()

    for entry in catalog.resource_types:
        for metric in entry.metrics:
            requested = set(metric.aggregations)
            assert requested <= DECLARED_AGGREGATIONS, (entry.resource_type, metric.name)
            assert not (
                AGGREGATION_COUNT in requested and AGGREGATION_TOTAL not in requested
            ), (
                f"{entry.resource_type} / {metric.name} requests {AGGREGATION_COUNT!r} "
                f"without {AGGREGATION_TOTAL!r}: a sample count with no total is a "
                f"denominator with no numerator and yields no statistic at all"
            )


def test_no_metric_declares_a_percentile_it_cannot_produce() -> None:
    """A percentile comes from the sketch, and the sketch is fed each interval's own
    average — so a metric with no `Count` folds nothing into it and a declared percentile
    would be unreachable configuration that silently emits nothing."""
    catalog = load_catalog()

    for entry in catalog.resource_types:
        for metric in entry.metrics:
            if not metric.percentiles:
                continue
            assert AVERAGE_AGGREGATIONS <= set(metric.aggregations), (
                f"{entry.resource_type} / {metric.name} declares percentiles "
                f"{list(metric.percentiles)} but requests {list(metric.aggregations)}, "
                f"which cannot feed the sketch"
            )
