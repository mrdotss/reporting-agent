"""Per-local-day accumulation, folded during the same pass as the window statistics.

## Why the snapshot carries a day dimension at all

`timeseries_chart` plots one point per local day and every plotted point is a `Figure`
addressed by `snapshot_path` (Req 16.14, and the design's own rationale for re-running the
foundation's local-day property). That address has to resolve to something in the snapshot,
so the snapshot has to hold a per-day value. Without one the block compiles to a
no-values-recorded notice on every real run — which is exactly what it did, because Req 35.5
enumerated the per-resource, per-metric statistics with no day dimension and nothing ever
wrote `day_buckets[].statistics`.

`ResourceDayBucket` has carried the field since the foundation. This module is what fills it.

## It does not hold a series, and that is the whole constraint

Req 26.2's rule is that the collector retains, per `(resource, metric)` pair, an
accumulated sum, count, minimum and maximum plus a sketch — and holds **no complete series**,
because 200 resources at 6 metrics over 31 days is ~268,000 points per resource at `PT1M`.

A day fold multiplies the accumulator count by the number of local days in the window, not by
the number of points in it. For that same 200 × 6 × 31 shape it is ~37,000 four-value
accumulators, on the order of tens of megabytes against the ~6 GB the rule exists to prevent,
and it is **flat in the grain**: dropping to `PT15M` quadruples the points and changes this
structure not at all. Nothing here retains a data point past the fold that consumed it.

## No per-day sketch, deliberately

:func:`MetricAccumulator` is created here with `sketch=None`, so a day carries `avg`, `min`
and `max` and no percentile. Two reasons, and the second is the real one:

* A sketch is 1–2 KB per series; one per day per pair would be ~45 MB for the shape above,
  which *would* start to press on Req 26.2's intent.
* A p95 over the 24 hourly means of one day is an estimate of almost nothing. The window's
  p95 already carries an estimator label warning that it is computed over interval means
  (Req 28.12); a daily one would compound that over a population of 24 and still be printed
  as a percentile. The honest move is not to offer it.

## The fold and the replay run this same code

`verify/replay.py` re-aggregates the archived responses and asserts a bit-identical digest
(Req 31.1). It builds its own :class:`DayFold` from the stored snapshot's timezone and folds
through the same `azure/metrics.py` entry points, for the reason `collect/finalize.py` gives
about itself: a second implementation would make a mismatch mean "the two implementations
disagree" rather than "the aggregation is not deterministic".
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal

from reporting_agent.catalog.loader import DECLARED_AGGREGATIONS, LoadedCatalog, MetricEntry
from reporting_agent.collect.accumulate import MetricAccumulator
from reporting_agent.collect.buckets import TzInfo, local_day, local_hour_of_week
from reporting_agent.collect.snapshot import StatisticEntry, WeekBucket, exact_statistics
from reporting_agent.providers.base import PlainData, ResourceRecord, is_excluded_from_averages

__all__ = ["WEEK_FIDELITY_TIER", "DayFold", "week_declared", "week_pairs"]

WEEK_FIDELITY_TIER = "baseline"
"""The tier every hour-by-weekday cell carries; see :meth:`DayFold.week_buckets`."""


@dataclass(slots=True)
class DayFold:
    """One run's per-`(resource, metric, local_day)` accumulators.

    Created once per collection and handed to the fold entry points, which call
    :meth:`fold` for every interval they have already folded into the window accumulator.
    Two folds of one interval rather than one, because the two answer different questions
    and neither can be derived from the other: a day's average is not recoverable from a
    window's, and a window's is not the mean of its days'.

    `excluded` mirrors `MetricAccumulator.excluded` at the resource level — a resource
    already carrying a `deallocated` or `power_state_unknown` gap folds nothing here either,
    so a machine that was off all month produces no day values rather than a row of zeros.

    A day accumulator is built with the aggregation set :meth:`fold` is **handed**, which
    is the window accumulator's own set for that same `(resource, metric)` pair. Passed
    per call rather than held as a name-keyed mapping on this instance, and that is not a
    style choice: one `DayFold` serves the whole run across every resource type, and a
    metric name is not unique across types — `cpu_percent` is declared by both
    `Microsoft.Sql/servers/databases` and `Microsoft.DBforPostgreSQL/flexibleServers`. A
    name-keyed map would have to pick one set for both, and would be wrong for one of them
    the day the two declarations diverge. Taking it from the caller's accumulator makes the
    window fold and the day fold structurally incapable of disagreeing about one interval.

    Getting that wrong would have been silent: this fold discards the gap it is handed —
    correct, because the window fold already classified the interval — so a day accumulator
    defaulting to all four while its window accumulator used `Minimum`/`Maximum` would have
    produced window extremes and **no day buckets at all**, with nothing recorded anywhere.
    """

    tz: TzInfo
    excluded: frozenset[str] = frozenset()
    week: Mapping[str, tuple[str, frozenset[str]]] = field(default_factory=dict)
    """The hour-by-weekday fold's pairs: resource id -> its type and the metrics to fold.

    Empty unless a profile asked for a heatmap by hour (:func:`week_pairs` builds it from
    the request). Each cell folds **across the type's resources**, so it is keyed by type,
    not resource — see `collect/snapshot.py::WeekBucket` on why."""
    _by_day: dict[tuple[str, str, date], MetricAccumulator] = field(
        default_factory=dict, repr=False
    )
    _by_hour: dict[tuple[str, str, int, int], MetricAccumulator] = field(
        default_factory=dict, repr=False
    )

    # --- folding -------------------------------------------------------------------

    def fold(
        self,
        *,
        resource_id: str,
        metric: str,
        timestamp: object,
        total: PlainData,
        count: PlainData,
        minimum: PlainData | None,
        maximum: PlainData | None,
        aggregations: frozenset[str] = DECLARED_AGGREGATIONS,
    ) -> None:
        """Fold one interval into its local day.

        Silent on every malformed input, and that is the correct asymmetry: the window fold
        has already run over this same interval and has already recorded whatever gap it
        deserves (`interval_malformed`, `interval_counts_missing`). Recording a second gap
        here would double every one of them in the `collection_log` and make a reader think
        two intervals were bad.

        An unparsable or absent timestamp folds nothing. The window statistics are unaffected
        by it — they never needed the timestamp — so the day dimension degrades to missing
        rather than taking the whole pair down with it.

        `aggregations` is the set the caller's window accumulator carries for this pair, and
        it defaults to all four so an existing caller is unchanged. See the class docstring
        on why it travels per call rather than as a mapping on this instance.
        """
        if resource_id in self.excluded:
            return

        instant = self._instant_of(timestamp)
        if instant is None:
            return
        day = local_day(instant, self.tz)

        key = (resource_id, metric, day)
        accumulator = self._by_day.get(key)
        if accumulator is None:
            # `sketch=None` — see the module docstring on why a day carries no percentile.
            # The aggregation set comes from the catalog so a day classifies an absent
            # `count` exactly as the window fold did for this same interval.
            accumulator = MetricAccumulator(sketch=None, aggregations=aggregations)
            self._by_day[key] = accumulator

        accumulator.fold_interval(
            total=total,
            count=count,
            minimum=minimum,
            maximum=maximum,
            resource_id=resource_id,
            metric=metric,
        )

        pair = self.week.get(resource_id)
        if pair is None or metric not in pair[1]:
            return
        weekday, hour = local_hour_of_week(instant, self.tz)
        cell = (pair[0], metric, weekday, hour)
        week_accumulator = self._by_hour.get(cell)
        if week_accumulator is None:
            week_accumulator = MetricAccumulator(sketch=None, aggregations=aggregations)
            self._by_hour[cell] = week_accumulator
        week_accumulator.fold_interval(
            total=total,
            count=count,
            minimum=minimum,
            maximum=maximum,
            resource_id=resource_id,
            metric=metric,
        )

    def _instant_of(self, timestamp: object) -> datetime | None:
        """An interval's **start** instant (Req 25.3, 25.10), for its local day and hour.

        Placed through `collect/buckets.py#local_day`, so the assignment here and the
        window's day geometry cannot disagree about which day an hour belongs to — the one
        disagreement that would put a figure under the wrong date while every total stayed
        correct.
        """
        if not isinstance(timestamp, str) or not timestamp:
            return None
        try:
            return datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError:
            return None

    # --- finalizing ------------------------------------------------------------------

    def statistics_for(
        self,
        resource_id: str,
        *,
        declared: Mapping[str, MetricEntry],
        selected: Sequence[str],
        fidelity_tier: str,
        grain: str,
    ) -> dict[str, tuple[StatisticEntry, ...]]:
        """This resource's finalized statistics, keyed by local day in ISO form.

        **Only the days this resource actually folded a value for.** The window's day
        *geometry* — every local day the window covers, with the slot count that fell
        inside it (Req 25.11) — is `collect/pipeline.py`'s to produce, and it produces it
        already. Returning geometry from here would be a second derivation of the same
        calendar from the same window, and the two could then disagree about a partial edge
        day while every total stayed correct.

        So this returns data and the pipeline attaches it to its spine. A day the geometry
        carries and this map has no entry for is a real day with nothing measured in it,
        which is exactly what an empty `statistics` array on that bucket says.

        Statistics are ordered by metric in `selected` order, then by
        :func:`exact_statistics`' own fixed direction order, so two folds over one input
        emit the same array before any sort runs.
        """
        found: dict[str, tuple[StatisticEntry, ...]] = {}
        for day in sorted({key[2] for key in self._by_day if key[0] == resource_id}):
            entries = self._statistics(
                resource_id,
                day,
                declared=declared,
                selected=selected,
                fidelity_tier=fidelity_tier,
                grain=grain,
            )
            if entries:
                found[day.isoformat()] = entries
        return found

    def _statistics(
        self,
        resource_id: str,
        day: date,
        *,
        declared: Mapping[str, MetricEntry],
        selected: Sequence[str],
        fidelity_tier: str,
        grain: str,
    ) -> tuple[StatisticEntry, ...]:
        entries: list[StatisticEntry] = []
        for name in selected:
            accumulator = self._by_day.get((resource_id, name, day))
            metric = declared.get(name)
            if accumulator is None or metric is None:
                continue
            result, _ = accumulator.finalize(resource_id, name)
            # The gap is dropped on purpose. `no_samples` for a day with no interval is
            # ordinary — a VM started mid-month has empty days — and the window fold has
            # already recorded one for a pair that folded nothing at all. Recording it per
            # day would put thirty entries in the `collection_log` for one silent machine.
            if result is None:
                continue
            entries.extend(
                exact_statistics(
                    result, metric=metric, fidelity_tier=fidelity_tier, grain=grain
                )
            )
        return tuple(entries)

    def week_buckets(
        self,
        *,
        declared: Mapping[str, Mapping[str, MetricEntry]],
        grain: str,
    ) -> tuple[WeekBucket, ...]:
        """Every hour-by-weekday cell that folded a value, finalized. **Only** those: a cell
        nobody reported in is absent rather than zero, as a day is.

        `declared` is resource type -> metric name -> entry. Every cell is at the baseline
        tier: it folds platform metrics only, across resources whose own tiers may differ,
        so no one resource's tier describes it.
        """
        cells: dict[tuple[str, int, int], list[StatisticEntry]] = {}
        for (resource_type, metric_name, weekday, hour), accumulator in sorted(self._by_hour.items()):
            metric = declared.get(resource_type, {}).get(metric_name)
            if metric is None:
                continue
            result, _ = accumulator.finalize(resource_type, metric_name)
            if result is None:  # as for a day: the window fold recorded any gap already
                continue
            cells.setdefault((resource_type, weekday, hour), []).extend(
                exact_statistics(result, metric=metric, fidelity_tier=WEEK_FIDELITY_TIER, grain=grain)
            )
        return tuple(
            WeekBucket(resource_type=key[0], weekday=key[1], hour=key[2], statistics=tuple(entries))
            for key, entries in sorted(cells.items())
            if entries
        )

    # --- inspection ------------------------------------------------------------------

    def __len__(self) -> int:
        """How many `(resource, metric, day)` accumulators are live.

        Exposed so a test can assert the count grows with the number of **days** and not
        with the number of points, which is the property Req 26.2 turns on.
        """
        return len(self._by_day)

    def total_for(self, resource_id: str, metric: str, day: date) -> Decimal | None:
        """One cell's accumulated total, for tests that assert the fold's arithmetic."""
        accumulator = self._by_day.get((resource_id, metric, day))
        return None if accumulator is None else accumulator.total


def week_pairs(
    resources: Sequence[ResourceRecord],
    metrics_by_resource_type: Mapping[str, Sequence[str]],
) -> dict[str, tuple[str, frozenset[str]]]:
    """:attr:`DayFold.week` for one run: each resource of a type the request names, with
    that type's metrics. Types compare case-insensitively, as everywhere a type is matched.

    A stopped or deallocated machine is left out (`is_excluded_from_averages`), as the
    window's averages leave it out: a fleet's 3 a.m. mean is the running machines' mean.
    Read off the records alone, so a replay builds the same pairs from the stored ones.
    """
    wanted = {
        resource_type.casefold(): (resource_type, frozenset(metrics))
        for resource_type, metrics in metrics_by_resource_type.items()
        if metrics
    }
    pairs: dict[str, tuple[str, frozenset[str]]] = {}
    for resource in resources:
        match = wanted.get(resource["resource_type"].casefold())
        if match is not None and not is_excluded_from_averages(resource):
            pairs[resource["resource_id"]] = match
    return pairs


def week_declared(
    catalog: LoadedCatalog, metrics_by_resource_type: Mapping[str, Sequence[str]]
) -> dict[str, dict[str, MetricEntry]]:
    """:meth:`DayFold.week_buckets`' `declared` for the requested types, from the catalog the
    window fold reads, so a cell and a window value finalize one metric on one entry."""
    declared: dict[str, dict[str, MetricEntry]] = {}
    for resource_type in metrics_by_resource_type:
        entry = catalog.for_resource_type(resource_type)
        if entry is not None:
            declared[resource_type] = {metric.name: metric for metric in entry.metrics}
    return declared
