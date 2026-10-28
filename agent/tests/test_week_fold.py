"""The hour-by-weekday fold — the fleet cells an hour heatmap draws.

What must hold, and why each is here:

* a cell folds **every** running resource of its type in that local hour of that weekday,
  count-weighted like a day, because one heatmap reads the fleet;
* the hour is the run's local hour, so a UTC Sunday night is a Jakarta Monday morning;
* only the pairs a profile asked for fold, and a stopped machine folds nothing;
* the snapshot carries the request beside the cells, always, so a replay folds the same
  pairs and a run that asked for none still has the key;
* the compile reads each cell as a snapshot figure.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Final
from zoneinfo import ZoneInfo

import pytest

import snapshot_factory as sf
from reporting_agent.catalog.loader import load_catalog, load_section_catalogue
from reporting_agent.collect.dayfold import DayFold, week_declared, week_pairs
from reporting_agent.collect.pipeline import _week_metrics
from reporting_agent.collect.snapshot import StatisticEntry, WeekBucket
from reporting_agent.compile.sections import week_heatmap_metrics
from reporting_agent.compile.snapshot_view import build_snapshot_view

JAKARTA: Final[ZoneInfo] = ZoneInfo("Asia/Jakarta")
CPU: Final[str] = "Percentage CPU"
VM: Final[str] = "Microsoft.Compute/virtualMachines"
DISK: Final[str] = "Microsoft.Compute/disks"
RESOURCE: Final[str] = (
    f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/a"
)


def _record(resource_id: str, resource_type: str = VM, power_state_raw: str = "PowerState/running") -> dict[str, Any]:
    return {
        "resource_id": resource_id,
        "name": resource_id.rsplit("/", 1)[-1],
        "resource_type": resource_type,
        "location": "southeastasia",
        "resource_group": "rg",
        "tags": {},
        "power_state_raw": power_state_raw,
        "power_state": "running",
        "fidelity_tier": "baseline",
    }


def _fold(fold: DayFold, resource_id: str, timestamp: str, total: str, count: str = "1", *, metric: str = CPU) -> None:
    fold.fold(
        resource_id=resource_id,
        metric=metric,
        timestamp=timestamp,
        total=Decimal(total),
        count=Decimal(count),
        minimum=Decimal(total) / Decimal(count),
        maximum=Decimal(total) / Decimal(count),
    )


def _cells(fold: DayFold, wanted: dict[str, list[str]]) -> dict[tuple[str, int, int], dict[str, str]]:
    buckets = fold.week_buckets(declared=week_declared(load_catalog(), wanted), grain="PT1H")
    return {
        bucket.sort_key: {str(e.to_plain_data()["statistic"]): str(e.to_plain_data()["value"]) for e in bucket.statistics}
        for bucket in buckets
    }


def test_a_cell_folds_every_running_resource_of_its_type_count_weighted() -> None:
    """Two machines in Monday's 09:00: 100 samples at 10 and one sample at 100 average to
    10.89 across the fleet, not 55, and the cell's peak is the larger machine's."""
    records = [_record("/vm/a"), _record("/vm/b")]
    wanted = {VM: [CPU]}
    fold = DayFold(tz=JAKARTA, week=week_pairs(records, wanted))
    # 2026-07-06T02:00Z is Monday 09:00 in Jakarta.
    _fold(fold, "/vm/a", "2026-07-06T02:00:00Z", "1000", "100")
    _fold(fold, "/vm/b", "2026-07-06T02:00:00Z", "100", "1")

    assert _cells(fold, wanted) == {(VM, 1, 9): {"avg": "10.89", "min": "10.00", "max": "100.00"}}


def test_the_hour_is_the_runs_local_hour() -> None:
    """Sunday 23:00 UTC is Monday 06:00 in Jakarta; the cell says Monday."""
    records = [_record("/vm/a")]
    wanted = {VM: [CPU]}
    fold = DayFold(tz=JAKARTA, week=week_pairs(records, wanted))
    _fold(fold, "/vm/a", "2026-07-05T23:00:00Z", "40")

    assert list(_cells(fold, wanted)) == [(VM, 1, 6)]


def test_the_same_hour_on_two_mondays_is_one_cell() -> None:
    records = [_record("/vm/a")]
    wanted = {VM: [CPU]}
    fold = DayFold(tz=JAKARTA, week=week_pairs(records, wanted))
    _fold(fold, "/vm/a", "2026-07-06T02:00:00Z", "20")
    _fold(fold, "/vm/a", "2026-07-13T02:00:00Z", "40")

    assert _cells(fold, wanted) == {(VM, 1, 9): {"avg": "30.00", "min": "20.00", "max": "40.00"}}


def test_only_the_asked_pairs_fold_and_a_stopped_machine_folds_nothing() -> None:
    records = [
        _record("/vm/a"),
        _record("/vm/off", power_state_raw="PowerState/deallocated"),
        _record("/disk/d", resource_type=DISK),
    ]
    wanted = {VM: [CPU]}
    pairs = week_pairs(records, wanted)
    assert set(pairs) == {"/vm/a"}

    fold = DayFold(tz=JAKARTA, week=pairs)
    _fold(fold, "/vm/a", "2026-07-06T02:00:00Z", "20", metric="Available Memory Bytes")
    _fold(fold, "/vm/off", "2026-07-06T02:00:00Z", "0")
    _fold(fold, "/disk/d", "2026-07-06T02:00:00Z", "5")
    assert _cells(fold, wanted) == {}


def test_types_match_case_insensitively_and_keep_the_requests_spelling() -> None:
    records = [_record("/vm/a", resource_type=VM.lower())]
    wanted = {VM: [CPU]}
    fold = DayFold(tz=JAKARTA, week=week_pairs(records, wanted))
    _fold(fold, "/vm/a", "2026-07-06T02:00:00Z", "20")

    assert list(_cells(fold, wanted)) == [(VM, 1, 9)]


def test_a_run_folds_only_the_asked_pairs_it_also_fetches() -> None:
    requested = {VM: ["Percentage CPU", "Available Memory Bytes"]}
    asked = {VM.lower(): ["Percentage CPU", "Disk Read Bytes"], DISK: ["Composite Disk Read Bytes/sec"]}

    assert _week_metrics(asked, requested) == {VM: ["Percentage CPU"]}
    assert _week_metrics(None, requested) == {}


def test_the_snapshot_carries_the_request_and_its_cells_even_when_empty() -> None:
    empty = sf.build(resources=[sf.vm(resource_id=RESOURCE, name="a")])
    assert empty["week"] == {"metrics_by_resource_type": {}, "buckets": []}


def test_each_cell_is_a_snapshot_figure() -> None:
    """The view indexes `/week/buckets/<i>/statistics/<k>/value` by type, metric, statistic,
    weekday and hour, and an hour nothing folded in has no value."""
    statistic = StatisticEntry(
        metric=CPU, statistic="avg", value=Decimal("12.5"), unit="percent",
        estimator="exact_count_weighted", fidelity_tier="baseline", sample_count=4, scale=2,
    )
    document = sf.build(resources=[sf.vm(resource_id=RESOURCE, name="a")])
    document["week"] = {
        "metrics_by_resource_type": {VM: [CPU]},
        "buckets": [WeekBucket(resource_type=VM, weekday=1, hour=9, statistics=(statistic,)).to_plain_data()],
    }
    view = build_snapshot_view(document)

    cell = view.week_stat(VM.lower(), CPU, "avg", 1, 9)
    assert cell is not None and cell.pointer == "/week/buckets/0/statistics/0/value"
    assert view.week_stat(VM, CPU, "avg", 1, 10) is None


@pytest.mark.parametrize(
    ("weekday", "hour"), [(0, 9), (8, 9), (1, -1), (1, 24)]
)
def test_a_cell_outside_the_week_is_refused(weekday: int, hour: int) -> None:
    with pytest.raises(ValueError):
        WeekBucket(resource_type=VM, weekday=weekday, hour=hour)


def test_the_definition_asks_for_the_sections_types_and_metric() -> None:
    definition = {
        "schema_version": 4,
        "provider": "azure",
        "sections": [
            {
                "id": "sec_vm",
                "type": "vm_utilization",
                "position": 0,
                "selection": {"resource_types": [], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
                "metrics": [{"metric": CPU, "statistic": "max"}, {"metric": "Available Memory Bytes", "statistic": "avg"}],
                "blocks": [{"slot": "title"}, {"kind": "week_heatmap", "id": "w"}],
            }
        ],
    }
    catalogue = load_section_catalogue(provider="azure")

    assert week_heatmap_metrics(definition, catalogue=catalogue) == {VM: [CPU]}
    definition["sections"][0]["blocks"] = [{"slot": "title"}]
    assert week_heatmap_metrics(definition, catalogue=catalogue) == {}
