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
    CATALOG_ENTRY_INVALID_GAP_TYPE,
    MAX_SCALE,
    load_catalog,
)
from reporting_agent.errors import CatalogUnusableError, ErrorCode

RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"

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
    assert catalog.catalog_version == "1.0.0"

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

    assert len(catalog.entries) == len(rt.metrics) + len(rt.derived) + len(
        rt.enhanced_counters
    )
