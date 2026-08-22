"""Per-metric aggregations: what is asked for, what an absent leaf means, and what a
metric that cannot produce an average produces instead (Req 1.2, 1.9, 23.11, 23.13, 27.8).

## The defect this closes

The Metric_Catalog has always carried an `aggregations` list per metric and **nothing read
it**. Every request sent `AGGREGATIONS` — `Total`, `Count`, `Minimum`, `Maximum` — for every
metric, which was correct for exactly as long as the catalog declared one resource type
whose every metric served all four.

Six of the seven types it now declares are not like that. Azure serves
`Microsoft.Sql/servers/databases`' `cpu_percent` as `Average`, `Minimum` and `Maximum`, and
`Microsoft.Web/sites`' `BytesReceived` as `Total` alone. Asking those for the four meant
asking for aggregations they do not have, and the response then carried intervals with no
`total` and no `count` — which the fold recorded as one `interval_counts_missing` gap **per
interval**, ~720 per pair per month, followed by `no_samples` and no statistic at all. A
report covering App Service and SQL Database would have named them and reported nothing,
with a `collection_log` of tens of thousands of gaps describing a subscription that was
answering correctly the whole time.

## What is asserted here, and why each part can fail on its own

Four independent things had to be true, and a test for any one of them passes while the
others are broken:

1. **The request carries the metric's own set** — asserted against `FakeMetricsPort`'s
   recorded calls, because a fold that behaved perfectly over a hand-built response would
   still have asked Azure the wrong question.
2. **An absent leaf that was never requested is not a gap** — the ~720-per-pair failure.
3. **A statistic is emitted anyway** — `min` and `max` for a metric with no average, `sum`
   for a metric with a total and no count. Without this the run is honest and empty, which
   is better than wrong and still useless.
4. **The day fold agrees with the window fold** — it builds its own accumulators, and one
   defaulting to all four while the window used the metric's real set produces window
   statistics and no day buckets, silently, because the day fold discards its gaps.
"""

from __future__ import annotations

import asyncio
import gzip
import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from fakes.azure_ports import (
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    facts_port_answering_nothing,
)
from fakes.object_store import InMemoryObjectStore
from reporting_agent.azure.metrics import (
    AGGREGATIONS,
    MetricsCollector,
    fold_batch_response,
    partition_by_aggregations,
)
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.azure.provider import provider_over_ports
from reporting_agent.azure.regions import RegionResolver
from reporting_agent.catalog.loader import (
    AGGREGATION_COUNT,
    AGGREGATION_MAXIMUM,
    AGGREGATION_MINIMUM,
    AGGREGATION_TOTAL,
    MetricEntry,
    load_catalog,
)
from reporting_agent.collect.accumulate import (
    STATISTIC_AVERAGE,
    STATISTIC_MAXIMUM,
    STATISTIC_MINIMUM,
    STATISTIC_SUM,
    MetricAccumulator,
    new_accumulator,
)
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.buckets import resolve_timezone, resolve_window
from reporting_agent.collect.dayfold import DayFold
from reporting_agent.collect.log import (
    GAP_TYPE_INTERVAL_COUNTS_MISSING,
    GAP_TYPE_INTERVAL_MALFORMED,
    GAP_TYPE_NO_SAMPLES,
)
from reporting_agent.collect.snapshot import (
    ESTIMATOR_EXACT_INTERVAL_TOTAL_SUM,
    ResourceSnapshot,
    SkuCapacity,
    build_snapshot,
    exact_statistics,
)
from reporting_agent.providers.base import CollectRequest, ScopeSpec

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
LOCATION = "southeastasia"
RESOURCE_TYPE = "Microsoft.Sql/servers/databases"
NAMESPACE = "microsoft.sql/servers/databases"
ACTOR_ID = "user_01HQZZZZZZZZZZZZZZZZZZZZZZ"
RUN_ID = "run_01HQZZZZZZZZZZZZZZZZZZZZZZ"
WINDOW = {"start_utc": "2026-07-01T00:00:00Z", "end_utc": "2026-07-01T02:00:00Z"}
JAKARTA = ZoneInfo("Asia/Jakarta")
DB_01 = (
    f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod-sea"
    f"/providers/Microsoft.Sql/servers/sql-prod/databases/appdb"
)

CPU_PERCENT = "cpu_percent"
BYTES_RECEIVED = "BytesReceived"

MIN_MAX = (AGGREGATION_MINIMUM, AGGREGATION_MAXIMUM)
TOTAL_ONLY = (AGGREGATION_TOTAL,)
TOTAL_MIN_MAX = (AGGREGATION_TOTAL, AGGREGATION_MINIMUM, AGGREGATION_MAXIMUM)


# --- helpers ------------------------------------------------------------------------


def batch_response(*, resource_id: str, metric: str, data: list[dict[str, Any]]):
    """One batch response carrying one resource's one metric over `data` intervals."""
    return RawHttpResponse(
        status=200,
        headers={},
        body={
            "values": [
                {
                    "resourceid": resource_id,
                    "value": [
                        {
                            "name": {"value": metric},
                            "errorCode": "Success",
                            "timeseries": [{"metadatavalues": [], "data": data}],
                        }
                    ],
                }
            ]
        },
    )


def collect(
    *,
    responses,
    metric_names,
    aggregations_by_metric,
    accumulators,
    day_fold=None,
):
    port = FakeMetricsPort(batch_responses=responses)
    collector = MetricsCollector(
        region_resolver=RegionResolver(port=port),
        archive_writer=ArchiveWriter(store=InMemoryObjectStore()),
    )
    gaps = asyncio.run(
        collector.collect_group(
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            resource_type=RESOURCE_TYPE,
            resource_ids=[DB_01],
            metric_namespace=NAMESPACE,
            metric_names=metric_names,
            accumulators=accumulators,
            day_fold=day_fold,
            grain="PT1H",
            window=WINDOW,
            start_time=WINDOW["start_utc"],
            end_time=WINDOW["end_utc"],
            interval_count=2,
            aggregations_by_metric=aggregations_by_metric,
        )
    )
    return gaps, port


def accumulators_for(metric: str, aggregations) -> dict:
    accumulator, _ = new_accumulator(
        "percentage", resource_id=DB_01, metric=metric, aggregations=aggregations
    )
    return {(DB_01, metric): accumulator}


# --- 1. the request carries the metric's own set ------------------------------------


def test_the_request_asks_only_for_the_aggregations_the_catalog_declares() -> None:
    """The wire, not the fold. A metric served `Average`/`Minimum`/`Maximum` must not be
    asked for `Total` or `Count` — asking is what produced the empty answer in the first
    place, and a fold tested against a hand-built response cannot see it."""
    _gaps, port = collect(
        responses=[
            batch_response(
                resource_id=DB_01,
                metric=CPU_PERCENT,
                data=[{"timeStamp": "2026-07-01T00:00:00Z", "minimum": 5.0, "maximum": 30.0}],
            )
        ],
        metric_names=[CPU_PERCENT],
        aggregations_by_metric={CPU_PERCENT: MIN_MAX},
        accumulators=accumulators_for(CPU_PERCENT, MIN_MAX),
    )

    assert len(port.batch_calls) == 1
    assert port.batch_calls[0]["aggregations"] == MIN_MAX
    assert AGGREGATION_TOTAL not in port.batch_calls[0]["aggregations"]
    assert AGGREGATION_COUNT not in port.batch_calls[0]["aggregations"]


def test_a_metric_with_no_declared_set_still_asks_for_all_four() -> None:
    """The default, asserted rather than assumed: every caller that predates per-metric
    aggregations passes no mapping at all and must be unaffected."""
    _gaps, port = collect(
        responses=[
            batch_response(
                resource_id=DB_01,
                metric=CPU_PERCENT,
                data=[
                    {
                        "timeStamp": "2026-07-01T00:00:00Z",
                        "total": 60.0,
                        "count": 4,
                        "minimum": 5.0,
                        "maximum": 30.0,
                    }
                ],
            )
        ],
        metric_names=[CPU_PERCENT],
        aggregations_by_metric=None,
        accumulators={(DB_01, CPU_PERCENT): MetricAccumulator()},
    )

    assert port.batch_calls[0]["aggregations"] == AGGREGATIONS


def test_metrics_with_different_sets_are_split_across_requests() -> None:
    """One `aggregation` query parameter per call means one set per call, the same way one
    `metric_namespace` per call means one resource type. Two metrics whose sets differ
    cannot share a request, and the union would ask each of them for something Azure does
    not serve it."""
    responses = [
        batch_response(
            resource_id=DB_01,
            metric=CPU_PERCENT,
            data=[{"timeStamp": "2026-07-01T00:00:00Z", "minimum": 5.0, "maximum": 30.0}],
        ),
        batch_response(
            resource_id=DB_01,
            metric="availability",
            data=[
                {
                    "timeStamp": "2026-07-01T00:00:00Z",
                    "total": 100.0,
                    "count": 1,
                    "minimum": 100.0,
                    "maximum": 100.0,
                }
            ],
        ),
    ]
    accumulators = {
        **accumulators_for(CPU_PERCENT, MIN_MAX),
        **{
            (DB_01, "availability"): new_accumulator(
                "percentage",
                resource_id=DB_01,
                metric="availability",
                aggregations=AGGREGATIONS,
            )[0]
        },
    }

    _gaps, port = collect(
        responses=responses,
        metric_names=[CPU_PERCENT, "availability"],
        aggregations_by_metric={CPU_PERCENT: MIN_MAX, "availability": AGGREGATIONS},
        accumulators=accumulators,
    )

    assert len(port.batch_calls) == 2
    by_set = {call["aggregations"]: call["metric_names"] for call in port.batch_calls}
    assert by_set[MIN_MAX] == (CPU_PERCENT,)
    assert by_set[AGGREGATIONS] == ("availability",)


# --- partition_by_aggregations, the pure half ---------------------------------------


def test_partitioning_groups_by_set_and_keeps_declaration_order_within_a_partition() -> None:
    partitions = partition_by_aggregations(
        ["a", "b", "c", "d"],
        {"a": MIN_MAX, "b": AGGREGATIONS, "c": MIN_MAX, "d": TOTAL_ONLY},
    )

    assert dict(partitions) == {
        MIN_MAX: ("a", "c"),
        AGGREGATIONS: ("b",),
        TOTAL_ONLY: ("d",),
    }


def test_partitioning_is_deterministic_regardless_of_which_metric_is_seen_first() -> None:
    """Two runs over the same catalog must plan byte-identical requests, so the partition
    order cannot depend on iteration order of the input."""
    declared = {"a": MIN_MAX, "b": AGGREGATIONS, "c": TOTAL_ONLY}

    first = partition_by_aggregations(["a", "b", "c"], declared)
    second = partition_by_aggregations(["c", "b", "a"], declared)

    assert [aggregations for aggregations, _ in first] == [
        aggregations for aggregations, _ in second
    ]


@pytest.mark.parametrize("declared", [None, {}, {"a": ()}])
def test_partitioning_falls_back_to_the_full_set(declared) -> None:
    assert partition_by_aggregations(["a"], declared) == [(AGGREGATIONS, ("a",))]


def test_partitioning_canonicalizes_the_set_so_two_spellings_are_one_partition() -> None:
    """A declared order of `("Maximum", "Minimum")` and one of `("Minimum", "Maximum")`
    describe the same request and must not become two calls."""
    partitions = partition_by_aggregations(
        ["a", "b"],
        {"a": (AGGREGATION_MAXIMUM, AGGREGATION_MINIMUM), "b": MIN_MAX},
    )

    assert partitions == [(MIN_MAX, ("a", "b"))]


# --- 2. an unrequested leaf is not a gap --------------------------------------------


def test_a_min_max_only_metric_records_no_gap_for_the_total_it_never_asked_for() -> None:
    """The ~720-gaps-per-pair failure, at two intervals instead of 720.

    Both intervals carry a minimum and a maximum and neither carries a total or a count,
    which is a complete and correct answer for this metric. Not one gap of any kind.
    """
    accumulators = accumulators_for(CPU_PERCENT, MIN_MAX)

    gaps, _port = collect(
        responses=[
            batch_response(
                resource_id=DB_01,
                metric=CPU_PERCENT,
                data=[
                    {"timeStamp": "2026-07-01T00:00:00Z", "minimum": 5.0, "maximum": 30.0},
                    {"timeStamp": "2026-07-01T01:00:00Z", "minimum": 7.5, "maximum": 42.5},
                ],
            )
        ],
        metric_names=[CPU_PERCENT],
        aggregations_by_metric={CPU_PERCENT: MIN_MAX},
        accumulators=accumulators,
    )

    assert [gap["gap_type"] for gap in gaps] == []

    result, gap = accumulators[(DB_01, CPU_PERCENT)].finalize(DB_01, CPU_PERCENT)
    assert gap is None, "a pair that folded two real intervals is not `no_samples`"
    assert result is not None


def test_a_requested_total_that_is_absent_is_still_a_gap() -> None:
    """The other half of the same rule, and the one that keeps the change from being a
    blanket loosening: a metric that **did** ask for a total and did not get one has a
    real hole, and it is still recorded — this is the 64-hour timestamp-only stretch."""
    accumulators = {(DB_01, "availability"): MetricAccumulator()}

    gaps, _port = collect(
        responses=[
            batch_response(
                resource_id=DB_01,
                metric="availability",
                data=[{"timeStamp": "2026-07-01T00:00:00Z"}],
            )
        ],
        metric_names=["availability"],
        aggregations_by_metric={"availability": AGGREGATIONS},
        accumulators=accumulators,
    )

    assert [gap["gap_type"] for gap in gaps] == [GAP_TYPE_INTERVAL_COUNTS_MISSING]
    assert gaps[0]["interval_start"] == "2026-07-01T00:00:00Z"


def test_a_total_only_metric_records_no_gap_for_the_absent_count() -> None:
    accumulator, _ = new_accumulator(
        "magnitude", resource_id=DB_01, metric=BYTES_RECEIVED, aggregations=TOTAL_ONLY
    )
    accumulators = {(DB_01, BYTES_RECEIVED): accumulator}

    gaps, _port = collect(
        responses=[
            batch_response(
                resource_id=DB_01,
                metric=BYTES_RECEIVED,
                data=[
                    {"timeStamp": "2026-07-01T00:00:00Z", "total": 1024.0},
                    {"timeStamp": "2026-07-01T01:00:00Z", "total": 2048.0},
                ],
            )
        ],
        metric_names=[BYTES_RECEIVED],
        aggregations_by_metric={BYTES_RECEIVED: TOTAL_ONLY},
        accumulators=accumulators,
    )

    assert gaps == []
    assert accumulator.total == Decimal("3072")


def test_a_total_only_metric_still_flags_an_interval_missing_its_total() -> None:
    """`Total` was requested, so an interval without one is a hole even though `Count`
    never was."""
    accumulator, _ = new_accumulator(
        "magnitude", resource_id=DB_01, metric=BYTES_RECEIVED, aggregations=TOTAL_ONLY
    )

    gaps, _port = collect(
        responses=[
            batch_response(
                resource_id=DB_01,
                metric=BYTES_RECEIVED,
                data=[{"timeStamp": "2026-07-01T00:00:00Z"}],
            )
        ],
        metric_names=[BYTES_RECEIVED],
        aggregations_by_metric={BYTES_RECEIVED: TOTAL_ONLY},
        accumulators={(DB_01, BYTES_RECEIVED): accumulator},
    )

    assert [gap["gap_type"] for gap in gaps] == [GAP_TYPE_INTERVAL_COUNTS_MISSING]


# --- 3. a statistic is emitted anyway -----------------------------------------------


def test_a_min_max_only_metric_emits_min_and_max_and_no_average() -> None:
    accumulator, _ = new_accumulator(
        "percentage", resource_id=DB_01, metric=CPU_PERCENT, aggregations=MIN_MAX
    )
    for minimum, maximum in ((Decimal("5"), Decimal("30")), (Decimal("2"), Decimal("42"))):
        assert (
            accumulator.fold_interval(
                total=None,
                count=None,
                minimum=minimum,
                maximum=maximum,
                resource_id=DB_01,
                metric=CPU_PERCENT,
            )
            is None
        )

    result, gap = accumulator.finalize(DB_01, CPU_PERCENT)

    assert gap is None
    assert result is not None
    assert result.average is None, "no `Count` was served, so there is no average"
    assert result.total_sum is None, "no `Total` either, so there is nothing to sum"
    assert result.minimum == Decimal("2")
    assert result.maximum == Decimal("42")
    # Azure reported no sample count, so this is the number of intervals rolled up.
    assert result.sample_count == Decimal(2)


def test_a_total_only_metric_emits_a_sum_and_no_average() -> None:
    accumulator, _ = new_accumulator(
        "magnitude", resource_id=DB_01, metric=BYTES_RECEIVED, aggregations=TOTAL_ONLY
    )
    for total in (Decimal("1024"), Decimal("2048")):
        accumulator.fold_interval(
            total=total,
            count=None,
            minimum=None,
            maximum=None,
            resource_id=DB_01,
            metric=BYTES_RECEIVED,
        )

    result, gap = accumulator.finalize(DB_01, BYTES_RECEIVED)

    assert gap is None
    assert result is not None
    assert result.average is None
    assert result.total_sum == Decimal("3072")


def test_a_total_with_min_and_max_emits_all_three_and_no_average() -> None:
    """`Microsoft.Storage/storageAccounts`' `Egress` shape."""
    accumulator, _ = new_accumulator(
        "magnitude", resource_id=DB_01, metric="Egress", aggregations=TOTAL_MIN_MAX
    )
    accumulator.fold_interval(
        total=Decimal("1024"),
        count=None,
        minimum=Decimal("1"),
        maximum=Decimal("900"),
        resource_id=DB_01,
        metric="Egress",
    )

    result, _gap = accumulator.finalize(DB_01, "Egress")

    assert result is not None
    assert result.average is None
    assert result.total_sum == Decimal("1024")
    assert result.minimum == Decimal("1")
    assert result.maximum == Decimal("900")


def test_the_emitted_statistic_names_match_what_the_metric_can_produce() -> None:
    """Through `exact_statistics`, so this is what actually reaches a snapshot."""
    from reporting_agent.catalog.loader import MetricEntry

    def emitted(aggregations, folds) -> set[str]:
        accumulator, _ = new_accumulator(
            "magnitude", resource_id=DB_01, metric="m", aggregations=aggregations
        )
        for fold in folds:
            accumulator.fold_interval(resource_id=DB_01, metric="m", **fold)
        result, _ = accumulator.finalize(DB_01, "m")
        assert result is not None
        entry = MetricEntry(
            resource_type=RESOURCE_TYPE,
            name="m",
            unit="bytes",
            unit_family="magnitude",
            aggregations=tuple(aggregations),
            scale=0,
        )
        return {
            statistic.statistic
            for statistic in exact_statistics(
                result, metric=entry, fidelity_tier="baseline", grain="PT1H"
            )
        }

    full = emitted(
        AGGREGATIONS,
        [
            {
                "total": Decimal("100"),
                "count": Decimal("4"),
                "minimum": Decimal("10"),
                "maximum": Decimal("40"),
            }
        ],
    )
    assert full == {STATISTIC_AVERAGE, STATISTIC_MINIMUM, STATISTIC_MAXIMUM}

    extremes = emitted(
        MIN_MAX,
        [{"total": None, "count": None, "minimum": Decimal("10"), "maximum": Decimal("40")}],
    )
    assert extremes == {STATISTIC_MINIMUM, STATISTIC_MAXIMUM}

    summed = emitted(
        TOTAL_ONLY, [{"total": Decimal("100"), "count": None, "minimum": None, "maximum": None}]
    )
    assert summed == {STATISTIC_SUM}
    # `sum` and `avg` are mutually exclusive by construction: one interval's leaves cannot
    # yield both a count-weighted mean and a bare sum.
    assert STATISTIC_AVERAGE not in summed


def test_the_sum_statistic_carries_the_estimator_that_names_what_was_summed() -> None:
    from reporting_agent.catalog.loader import MetricEntry

    accumulator, _ = new_accumulator(
        "magnitude", resource_id=DB_01, metric=BYTES_RECEIVED, aggregations=TOTAL_ONLY
    )
    accumulator.fold_interval(
        total=Decimal("1024"),
        count=None,
        minimum=None,
        maximum=None,
        resource_id=DB_01,
        metric=BYTES_RECEIVED,
    )
    result, _ = accumulator.finalize(DB_01, BYTES_RECEIVED)
    assert result is not None

    entries = exact_statistics(
        result,
        metric=MetricEntry(
            resource_type="Microsoft.Web/sites",
            name=BYTES_RECEIVED,
            unit="bytes",
            unit_family="magnitude",
            aggregations=TOTAL_ONLY,
            scale=0,
        ),
        fidelity_tier="baseline",
        grain="PT1H",
    )

    assert [entry.statistic for entry in entries] == [STATISTIC_SUM]
    assert entries[0].estimator == ESTIMATOR_EXACT_INTERVAL_TOTAL_SUM


def test_a_pair_that_folded_nothing_is_still_no_samples() -> None:
    """The emptiness test moved from `count` to `folded_intervals`, so assert the case it
    used to catch still fails: nothing folded at all is `no_samples`, for a min/max-only
    metric exactly as for any other."""
    accumulator, _ = new_accumulator(
        "percentage", resource_id=DB_01, metric=CPU_PERCENT, aggregations=MIN_MAX
    )

    result, gap = accumulator.finalize(DB_01, CPU_PERCENT)

    assert result is None
    assert gap is not None
    assert gap["gap_type"] == GAP_TYPE_NO_SAMPLES


def test_a_zero_count_interval_still_folds_nothing_for_a_count_bearing_metric() -> None:
    """Unchanged behaviour, asserted because `folded_intervals` sits next to it: a valid
    interval whose count is exactly zero is a partial bucket with no samples, not an
    error, and it must not make the pair look non-empty."""
    accumulator = MetricAccumulator()

    gap = accumulator.fold_interval(
        total=Decimal("0"),
        count=Decimal("0"),
        minimum=Decimal("0"),
        maximum=Decimal("0"),
        resource_id=DB_01,
        metric=CPU_PERCENT,
    )

    assert gap is None
    assert accumulator.folded_intervals == 0
    result, no_samples = accumulator.finalize(DB_01, CPU_PERCENT)
    assert result is None
    assert no_samples is not None


def test_a_min_max_only_metric_folds_nothing_into_the_sketch() -> None:
    """The sketch is fed each interval's own average, so a metric with no count feeds it
    nothing — which is why the catalog declares no percentiles for one. Asserted rather
    than left implicit, because a sketch fed a bare total would produce a percentile of
    the wrong quantity under a correct-looking label."""
    accumulator, _ = new_accumulator(
        "percentage", resource_id=DB_01, metric=CPU_PERCENT, aggregations=MIN_MAX
    )
    assert accumulator.sketch is not None

    accumulator.fold_interval(
        total=None,
        count=None,
        minimum=Decimal("5"),
        maximum=Decimal("30"),
        resource_id=DB_01,
        metric=CPU_PERCENT,
    )

    assert accumulator.sketch.sample_count == 0


def test_a_malformed_leaf_is_still_malformed_when_it_was_requested() -> None:
    accumulator, _ = new_accumulator(
        "magnitude", resource_id=DB_01, metric=BYTES_RECEIVED, aggregations=TOTAL_ONLY
    )

    gap = accumulator.fold_interval(
        total="not a decimal",
        count=None,
        minimum=None,
        maximum=None,
        resource_id=DB_01,
        metric=BYTES_RECEIVED,
    )

    assert gap is not None
    assert gap["gap_type"] == GAP_TYPE_INTERVAL_MALFORMED


# --- 4. the day fold agrees with the window fold ------------------------------------


def test_a_min_max_only_metric_still_produces_day_buckets() -> None:
    """The silent failure this closes.

    A day accumulator defaulting to all four while the window accumulator used
    `Minimum`/`Maximum` would classify every interval malformed, fold nothing, and record
    nothing — the day fold discards its gaps on purpose, so there would be no trace.

    The observable is the **emitted day statistics**, not `len(day_fold)`. That distinction
    is the whole test: `DayFold.fold` inserts the accumulator into its map *before* folding
    into it, so a day whose every interval was rejected still counts towards the length. An
    assertion on the count passes against exactly the bug this test exists to catch.
    """
    accumulators = accumulators_for(CPU_PERCENT, MIN_MAX)
    day_fold = DayFold(tz=resolve_timezone("Asia/Jakarta"))

    gaps, _port = collect(
        responses=[
            batch_response(
                resource_id=DB_01,
                metric=CPU_PERCENT,
                data=[
                    {"timeStamp": "2026-07-01T00:00:00Z", "minimum": 5.0, "maximum": 30.0},
                    {"timeStamp": "2026-07-01T01:00:00Z", "minimum": 7.5, "maximum": 42.5},
                ],
            )
        ],
        metric_names=[CPU_PERCENT],
        aggregations_by_metric={CPU_PERCENT: MIN_MAX},
        accumulators=accumulators,
        day_fold=day_fold,
    )

    assert gaps == []

    declared = {
        CPU_PERCENT: MetricEntry(
            resource_type=RESOURCE_TYPE,
            name=CPU_PERCENT,
            unit="percent",
            unit_family="percentage",
            aggregations=MIN_MAX,
            scale=2,
        )
    }
    days = day_fold.statistics_for(
        DB_01,
        declared=declared,
        selected=[CPU_PERCENT],
        fidelity_tier="baseline",
        grain="PT1H",
    )

    # Both intervals fall in one Asia/Jakarta day, and that day carries the extremes
    # rolled up across them — 2 is the lower of the two minima, 42.5 the higher maximum.
    assert list(days) == ["2026-07-01"]
    emitted = {entry.statistic: entry.value for entry in days["2026-07-01"]}
    assert emitted == {
        STATISTIC_MINIMUM: Decimal("5"),
        STATISTIC_MAXIMUM: Decimal("42.5"),
    }


def test_the_day_fold_takes_the_set_from_the_accumulator_it_was_handed() -> None:
    """Per call rather than from a name-keyed mapping, because one `DayFold` serves the
    whole run and a metric name is not unique across resource types — `cpu_percent` is
    declared by both SQL Database and PostgreSQL flexible servers.

    Asserted on the folded state rather than on `len`, for the reason the test above
    records: the map gains its entry before the fold is attempted.
    """
    day_fold = DayFold(tz=resolve_timezone("Asia/Jakarta"))

    day_fold.fold(
        resource_id=DB_01,
        metric=CPU_PERCENT,
        aggregations=frozenset(MIN_MAX),
        timestamp="2026-07-01T00:00:00Z",
        total=None,
        count=None,
        minimum=Decimal("5"),
        maximum=Decimal("30"),
    )

    declared = {
        CPU_PERCENT: MetricEntry(
            resource_type=RESOURCE_TYPE,
            name=CPU_PERCENT,
            unit="percent",
            unit_family="percentage",
            aggregations=MIN_MAX,
            scale=2,
        )
    }
    days = day_fold.statistics_for(
        DB_01,
        declared=declared,
        selected=[CPU_PERCENT],
        fidelity_tier="baseline",
        grain="PT1H",
    )

    assert {entry.statistic for entry in days["2026-07-01"]} == {
        STATISTIC_MINIMUM,
        STATISTIC_MAXIMUM,
    }


def test_the_day_fold_defaults_to_all_four_when_handed_no_set() -> None:
    """The default is what makes the parameter additive, and it must stay wrong for a
    min/max-only interval — that is precisely why the caller has to pass the set. A
    default that silently accepted a countless interval would make the parameter
    decorative and the bug above unobservable."""
    day_fold = DayFold(tz=resolve_timezone("Asia/Jakarta"))

    day_fold.fold(
        resource_id=DB_01,
        metric=CPU_PERCENT,
        timestamp="2026-07-01T00:00:00Z",
        total=None,
        count=None,
        minimum=Decimal("5"),
        maximum=Decimal("30"),
    )

    declared = {
        CPU_PERCENT: MetricEntry(
            resource_type=RESOURCE_TYPE,
            name=CPU_PERCENT,
            unit="percent",
            unit_family="percentage",
            aggregations=MIN_MAX,
            scale=2,
        )
    }

    assert (
        day_fold.statistics_for(
            DB_01,
            declared=declared,
            selected=[CPU_PERCENT],
            fidelity_tier="baseline",
            grain="PT1H",
        )
        == {}
    )


# --- 5. the archive round trip, over a metric with no average -----------------------


def test_a_min_max_only_collection_replays_to_an_identical_digest() -> None:
    """The seam, proven by calling the fold from both sides (Req 31.1).

    This is the test the change most needed and the one a unit test cannot stand in for.
    `verify/replay.py` rebuilds its accumulators through `new_accumulator` from the pinned
    catalog, and if it did not pass the declared aggregations they would default to all
    four — while the collector used `Minimum`/`Maximum`. Every interval would then look
    incomplete to the replay alone: it would recompute ~720 `interval_counts_missing` gaps
    per pair that the snapshot does not carry, the recomputed `gaps` array would differ, and
    the digest would differ with it. `REPLAY_MISMATCH` on every subscription holding a SQL
    database, a PostgreSQL server, a storage account or an App Service site — a verification
    failure on a run that collected perfectly.

    Deliberately end to end across the archive boundary rather than two folds over one
    in-memory input: the collector writes the objects, they are gzipped, serialized and read
    back with a plain `json.loads`, and the fractional `minimum`/`maximum` values below are
    the shape that only survives a round trip if the numeric-leaf reader accepts a decimal
    **string**. Whole numbers would stay JSON integers and pass the bug this asserts against.
    """
    accumulators = accumulators_for(CPU_PERCENT, MIN_MAX)
    store = InMemoryObjectStore()
    port = FakeMetricsPort(
        batch_responses=[
            batch_response(
                resource_id=DB_01,
                metric=CPU_PERCENT,
                data=[
                    {"timeStamp": "2026-07-01T00:00:00Z", "minimum": 5.25, "maximum": 30.75},
                    {"timeStamp": "2026-07-01T01:00:00Z", "minimum": 7.125, "maximum": 42.5},
                ],
            )
        ]
    )
    collector = MetricsCollector(
        region_resolver=RegionResolver(port=port),
        archive_writer=ArchiveWriter(store=store),
    )
    collected_gaps = asyncio.run(
        collector.collect_group(
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            resource_type=RESOURCE_TYPE,
            resource_ids=[DB_01],
            metric_namespace=NAMESPACE,
            metric_names=[CPU_PERCENT],
            accumulators=accumulators,
            day_fold=None,
            grain="PT1H",
            window=WINDOW,
            start_time=WINDOW["start_utc"],
            end_time=WINDOW["end_utc"],
            interval_count=2,
            aggregations_by_metric={CPU_PERCENT: MIN_MAX},
        )
    )
    live_result, _ = accumulators[(DB_01, CPU_PERCENT)].finalize(DB_01, CPU_PERCENT)

    archived = [
        (ordinal, store.get(key).body)
        for ordinal, key in enumerate(sorted(k for k in store.keys() if "/raw/" in k))
    ]
    assert archived, "the collector archived nothing, so this proves nothing"

    # The replay side, built the way `verify/replay.py::_new_accumulators` builds it: the
    # same function, over the same catalog entry.
    replay_accumulators = accumulators_for(CPU_PERCENT, MIN_MAX)
    replay_gaps: list = []
    for _ordinal, payload in archived:
        document = json.loads(gzip.decompress(payload).decode("utf-8"))
        replay_gaps.extend(
            fold_batch_response(
                body=document["raw_response"],
                resource_ids=document["resource_ids"],
                metric_names=document["metric_names"],
                accumulators=replay_accumulators,
            )
        )
    replay_result, _ = replay_accumulators[(DB_01, CPU_PERCENT)].finalize(DB_01, CPU_PERCENT)

    assert [gap["gap_type"] for gap in replay_gaps] == [
        gap["gap_type"] for gap in collected_gaps
    ] == []
    assert replay_result == live_result
    assert live_result is not None
    assert live_result.minimum == Decimal("5.25")
    assert live_result.maximum == Decimal("42.5")


def test_the_replay_side_defaulting_to_all_four_would_be_visible() -> None:
    """Guard the guard for the test above.

    The failure mode is a replay accumulator built **without** the catalog's set. Simulated
    here rather than described: the same archived objects, folded into accumulators that
    defaulted to all four, produce a gap list the collection does not have. This is what
    makes the equality above an assertion about the seam rather than about two identical
    calls.
    """
    store = InMemoryObjectStore()
    port = FakeMetricsPort(
        batch_responses=[
            batch_response(
                resource_id=DB_01,
                metric=CPU_PERCENT,
                data=[
                    {"timeStamp": "2026-07-01T00:00:00Z", "minimum": 5.25, "maximum": 30.75},
                ],
            )
        ]
    )
    collector = MetricsCollector(
        region_resolver=RegionResolver(port=port),
        archive_writer=ArchiveWriter(store=store),
    )
    asyncio.run(
        collector.collect_group(
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            resource_type=RESOURCE_TYPE,
            resource_ids=[DB_01],
            metric_namespace=NAMESPACE,
            metric_names=[CPU_PERCENT],
            accumulators=accumulators_for(CPU_PERCENT, MIN_MAX),
            day_fold=None,
            grain="PT1H",
            window=WINDOW,
            start_time=WINDOW["start_utc"],
            end_time=WINDOW["end_utc"],
            interval_count=2,
            aggregations_by_metric={CPU_PERCENT: MIN_MAX},
        )
    )

    wrong = {(DB_01, CPU_PERCENT): MetricAccumulator()}  # the all-four default
    gaps: list = []
    for key in sorted(k for k in store.keys() if "/raw/" in k):
        document = json.loads(gzip.decompress(store.get(key).body).decode("utf-8"))
        gaps.extend(
            fold_batch_response(
                body=document["raw_response"],
                resource_ids=document["resource_ids"],
                metric_names=document["metric_names"],
                accumulators=wrong,
            )
        )

    assert [gap["gap_type"] for gap in gaps] == [GAP_TYPE_INTERVAL_COUNTS_MISSING]
    result, no_samples = wrong[(DB_01, CPU_PERCENT)].finalize(DB_01, CPU_PERCENT)
    assert result is None
    assert no_samples is not None and no_samples["gap_type"] == GAP_TYPE_NO_SAMPLES


def test_replays_accumulators_carry_the_pinned_catalogs_declared_set() -> None:
    """The seam asserted at the construction site itself.

    `_new_accumulators` is module-private and imported here anyway, deliberately. The two
    tests above prove the fold behaves correctly when it is *handed* the right set; this is
    the only assertion that the module which will hand it one in production actually does.
    Removing `aggregations=` from that one call is invisible to every other test in this
    suite — the accumulators simply default to all four — and its consequence is
    `REPLAY_MISMATCH` on every subscription holding a resource type whose metrics Azure
    serves no `Count` for, which is four of the seven the catalog declares.

    Read against the **shipped** catalog rather than a synthetic one, because the fact
    being asserted is that a real declaration reaches a real accumulator.
    """
    from reporting_agent.verify.replay import _new_accumulators, plan_from_snapshot

    catalog = load_catalog()
    resource_type = "Microsoft.Sql/servers/databases"
    declared = catalog.for_resource_type(resource_type)
    assert declared is not None
    min_max_only = [
        metric.name
        for metric in declared.metrics
        if AGGREGATION_COUNT not in metric.aggregations
    ]
    assert min_max_only, (
        "this resource type no longer declares a metric without a Count, so this test "
        "checks nothing — pick one that does"
    )

    record = {
        "resource_id": DB_01,
        "name": "appdb",
        "resource_type": resource_type,
        "location": LOCATION,
        "resource_group": "rg-prod-sea",
        "tags": {},
        "sku_name": "",
        "power_state_raw": "",
        "power_state": "unknown",
        "fidelity_tier": "baseline",
    }
    document = build_snapshot(
        run_id=RUN_ID,
        # See `tests/test_verify_replay.py` on the required-but-nullable keyword.
        invocation_started_at=None,
        scope=ScopeSpec(
            subscription_id=SUBSCRIPTION,
            resource_types=[resource_type],
            resource_groups=[],
            tag_filters={},
        ),
        scope_verified=True,
        collected_at=datetime(2026, 8, 1, tzinfo=UTC),
        timezone_name="Asia/Jakarta",
        tz=JAKARTA,
        window=resolve_window(date(2026, 7, 1), date(2026, 7, 2), JAKARTA),
        grain="PT1H",
        metrics_by_resource_type={resource_type: min_max_only},
        resources=[
            ResourceSnapshot(
                record=record,  # type: ignore[arg-type]
                sku=SkuCapacity(name=""),
                statistics=(),
                day_buckets=(),
            )
        ],
        gaps=[],
        catalog_version=catalog.catalog_version,
        raw_archive_complete=True,
        raw_archive_object_count=1,
    )

    plan = plan_from_snapshot(document, catalog=catalog)
    accumulators = _new_accumulators(plan)

    by_name = {metric.name: metric for metric in declared.metrics}
    for name in min_max_only:
        expected = frozenset(by_name[name].aggregations)
        assert accumulators[(DB_01, name)].aggregations == expected, name
        assert AGGREGATION_COUNT not in accumulators[(DB_01, name)].aggregations


# --- 6. the production wiring sites, called rather than described --------------------


def test_the_provider_wires_the_catalogs_sets_into_both_the_request_and_the_fold() -> None:
    """`azure/provider.py` is the **only** production construction site for both halves,
    and every other test in this file drives `collect_group` directly with arguments it
    supplies itself — so none of them touches it.

    That is exactly the "an injected seam is an untested seam" shape: the provider passes
    `aggregations=` to `new_accumulator` and `aggregations_by_metric=` to `collect_group`,
    and deleting either is invisible to the whole suite while breaking every non-virtual-
    machine resource type in production. Deleting the first makes the fold treat a complete
    response as ~720 holes per pair; deleting the second asks Azure for aggregations it does
    not serve. This test calls the real `AzureProvider.collect` over a resource type whose
    metrics have no `Count` and asserts both outcomes.

    Driven through `provider_over_ports`, the same assembly `build_provider` uses, so the
    wiring under test is the wiring that ships.
    """
    catalog = load_catalog()
    resource_type = "Microsoft.Sql/servers/databases"
    declared = catalog.for_resource_type(resource_type)
    assert declared is not None
    by_name = {metric.name: metric for metric in declared.metrics}
    metric = by_name[CPU_PERCENT]
    assert AGGREGATION_COUNT not in metric.aggregations, (
        "this test needs a metric the catalog declares without a Count"
    )

    metrics_port = FakeMetricsPort(
        batch_responses=[
            batch_response(
                resource_id=DB_01,
                metric=CPU_PERCENT,
                data=[
                    {"timeStamp": "2026-07-01T00:00:00Z", "minimum": 5.25, "maximum": 30.75},
                    {"timeStamp": "2026-07-01T01:00:00Z", "minimum": 7.125, "maximum": 42.5},
                ],
            )
        ]
    )
    provider = provider_over_ports(
        inventory_port=FakeInventoryPort([]),
        sku_port=FakeSkuPort([]),
        # The provider probes metric definitions before selecting names, once per
        # `(resource_type, region)`. Answering with the one metric under test is what makes
        # it `selected` rather than a `metric_not_emitted` gap.
        definitions_port=FakeDefinitionsPort(
            [
                RawHttpResponse(
                    status=200,
                    headers={},
                    body={"value": [{"name": {"value": CPU_PERCENT}}]},
                )
            ]
        ),
        metrics_port=metrics_port,
        facts_port=facts_port_answering_nothing(),
        object_store=InMemoryObjectStore(),
        actor_id=ACTOR_ID,
        run_id=RUN_ID,
        catalog=catalog,
    )
    record = {
        "resource_id": DB_01,
        "name": "appdb",
        "resource_type": resource_type,
        "location": LOCATION,
        "resource_group": "rg-prod-sea",
        "tags": {},
        "sku_name": "",
        "power_state_raw": "",
        "power_state": "unknown",
        "fidelity_tier": "baseline",
    }

    collected = asyncio.run(
        provider.collect(
            CollectRequest(
                scope=ScopeSpec(
                    subscription_id=SUBSCRIPTION,
                    resource_types=[resource_type],
                    resource_groups=[],
                    tag_filters={},
                ),
                resources=[record],  # type: ignore[list-item]
                metrics_by_resource_type={resource_type: [CPU_PERCENT]},
                grain="PT1H",
                window=WINDOW,  # type: ignore[typeddict-item]
                timezone="Asia/Jakarta",
                utc_offset="+07:00",
            )
        )
    )

    # The request half: the wire carried the metric's own set, not all four.
    assert len(metrics_port.batch_calls) == 1
    assert metrics_port.batch_calls[0]["aggregations"] == metric.aggregations
    assert AGGREGATION_COUNT not in metrics_port.batch_calls[0]["aggregations"]

    # The fold half: a complete response produced statistics and not a gap per interval.
    assert [gap["gap_type"] for gap in collected["gaps"]] == []
    statistics = collected["statistics"][DB_01][CPU_PERCENT]
    assert set(statistics) == {STATISTIC_MINIMUM, STATISTIC_MAXIMUM}
    assert statistics[STATISTIC_MINIMUM]["value"] == "5.25"
    assert statistics[STATISTIC_MAXIMUM]["value"] == "42.50"
    assert STATISTIC_AVERAGE not in statistics
