"""The per-local-day fold (Req 35.11) — the dimension `timeseries_chart` addresses.

Three claims, and the first two are the ones that matter:

* A day's value is **its own** count-weighted average, not the window's and not a share of
  it. :func:`test_two_days_of_one_metric_fold_to_their_own_averages`.
* The structure grows with the number of **days**, not with the number of points, which is
  what keeps Req 26.2's stream-reduce rule true.
  :func:`test_the_accumulator_count_is_flat_in_the_grain`.
* A day is assigned in the run's timezone, so the UTC+07:00 boundary lands where the
  customer's midnight is. That is the foundation's Property 6 applied one level down, and
  getting it wrong re-attributes every daily figure while every total stays correct.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Final
from zoneinfo import ZoneInfo

import pytest

from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.dayfold import DayFold

JAKARTA: Final[ZoneInfo] = ZoneInfo("Asia/Jakarta")
UTC: Final[ZoneInfo] = ZoneInfo("UTC")
CPU: Final[str] = "Percentage CPU"
VM: Final[str] = "Microsoft.Compute/virtualMachines"
RESOURCE: Final[str] = "/subscriptions/s/resourceGroups/g/providers/x/virtualMachines/a"


def declared() -> dict[str, Any]:
    catalog = load_catalog()
    resource_catalog = catalog.for_resource_type(VM)
    assert resource_catalog is not None
    return {metric.name: metric for metric in resource_catalog.metrics}


def fold_hours(
    fold: DayFold, hours: list[tuple[str, str]], *, metric: str = CPU
) -> None:
    """Fold `(timestamp, total)` pairs at one sample per interval."""
    for timestamp, total in hours:
        fold.fold(
            resource_id=RESOURCE,
            metric=metric,
            timestamp=timestamp,
            total=Decimal(total),
            count=Decimal(1),
            minimum=Decimal(total),
            maximum=Decimal(total),
        )


def statistics(fold: DayFold) -> dict[str, dict[str, str]]:
    """`{local_day: {statistic: value}}` for the CPU metric."""
    found = fold.statistics_for(
        RESOURCE,
        declared=declared(),
        selected=[CPU],
        fidelity_tier="baseline",
        grain="PT1H",
    )
    # Read through `to_plain_data`, which is what lands in the snapshot: it applies the
    # catalog's declared scale, and the scale is what makes a `formatted` string
    # deterministic. Asserting on the in-memory `Decimal` would pin a precision the
    # document never carries.
    return {
        day: {
            str(entry.to_plain_data()["statistic"]): str(entry.to_plain_data()["value"])
            for entry in entries
        }
        for day, entries in found.items()
    }


# --------------------------------------------------------------------------- #
# The arithmetic
# --------------------------------------------------------------------------- #


def test_two_days_of_one_metric_fold_to_their_own_averages() -> None:
    """A day's average is the day's, and it is not recoverable from the window's.

    Day one folds 10 and 30; day two folds 60 and 80. The window average is 45 and no day
    carries it — which is the whole reason the day dimension has to be folded during
    collection rather than derived from the snapshot afterwards.
    """
    fold = DayFold(tz=JAKARTA)
    fold_hours(
        fold,
        [
            # 2026-06-30T17:00Z is 2026-07-01T00:00 in Jakarta.
            ("2026-06-30T17:00:00Z", "10"),
            ("2026-06-30T18:00:00Z", "30"),
            ("2026-07-01T17:00:00Z", "60"),
            ("2026-07-01T18:00:00Z", "80"),
        ],
    )

    assert statistics(fold) == {
        "2026-07-01": {"avg": "20.00", "min": "10.00", "max": "30.00"},
        "2026-07-02": {"avg": "70.00", "min": "60.00", "max": "80.00"},
    }


def test_a_days_average_is_count_weighted_like_the_windows() -> None:
    """Req 27.1 one level down: `sum(total)/sum(count)`, never the mean of the interval
    averages. One interval of 100 samples averaging 10 and one of 1 sample at 100 average
    to 10.89, not to 55."""
    fold = DayFold(tz=JAKARTA)
    fold.fold(
        resource_id=RESOURCE,
        metric=CPU,
        timestamp="2026-06-30T17:00:00Z",
        total=Decimal(1000),
        count=Decimal(100),
        minimum=Decimal(10),
        maximum=Decimal(10),
    )
    fold.fold(
        resource_id=RESOURCE,
        metric=CPU,
        timestamp="2026-06-30T18:00:00Z",
        total=Decimal(100),
        count=Decimal(1),
        minimum=Decimal(100),
        maximum=Decimal(100),
    )

    assert statistics(fold)["2026-07-01"]["avg"] == "10.89"


def test_a_day_carries_no_percentile() -> None:
    """`sketch=None`, deliberately — see the module docstring. A p95 over 24 hourly means
    is an estimate of almost nothing, and it would be printed as a percentile."""
    fold = DayFold(tz=JAKARTA)
    fold_hours(fold, [("2026-06-30T17:00:00Z", "10")])

    for entries in statistics(fold).values():
        assert set(entries) == {"avg", "min", "max"}


# --------------------------------------------------------------------------- #
# The local-day boundary
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("timestamp", "jakarta_day", "utc_day"),
    [
        # The seven hours that separate the two calendars, from both sides.
        ("2026-06-30T16:59:59Z", "2026-06-30", "2026-06-30"),
        ("2026-06-30T17:00:00Z", "2026-07-01", "2026-06-30"),
        ("2026-07-01T16:59:59Z", "2026-07-01", "2026-07-01"),
        ("2026-07-01T17:00:00Z", "2026-07-02", "2026-07-01"),
    ],
)
def test_the_day_boundary_is_the_runs_midnight_not_utcs(
    timestamp: str, jakarta_day: str, utc_day: str
) -> None:
    """Req 25.3, 25.10 at the fold. Every one of these four instants lands on a different
    date depending on the zone, which is the whole reason `P1D` is excluded from every
    request — a "July" chart drawn on UTC days is offset seven hours for this customer."""
    for tz, expected in ((JAKARTA, jakarta_day), (UTC, utc_day)):
        fold = DayFold(tz=tz)
        fold_hours(fold, [(timestamp, "42")])
        assert list(statistics(fold)) == [expected], (tz, timestamp)


# --------------------------------------------------------------------------- #
# What it refuses to do
# --------------------------------------------------------------------------- #


def test_an_excluded_resource_folds_nothing() -> None:
    """A deallocated machine produces no day values rather than a row of zeros — the same
    distinction `MetricAccumulator.excluded` draws for the window (Req 20.6, 20.13)."""
    fold = DayFold(tz=JAKARTA, excluded=frozenset({RESOURCE}))
    fold_hours(fold, [("2026-06-30T17:00:00Z", "10")])

    assert statistics(fold) == {}
    assert len(fold) == 0


@pytest.mark.parametrize("timestamp", [None, "", "not-a-timestamp", 17, {"t": 1}])
def test_an_unreadable_timestamp_folds_nothing_and_raises_nothing(
    timestamp: object,
) -> None:
    """The window statistics never needed the timestamp, so the day dimension degrades to
    missing rather than taking the pair down with it."""
    fold = DayFold(tz=JAKARTA)
    fold.fold(
        resource_id=RESOURCE,
        metric=CPU,
        timestamp=timestamp,
        total=Decimal(10),
        count=Decimal(1),
        minimum=Decimal(10),
        maximum=Decimal(10),
    )

    assert statistics(fold) == {}


def test_a_malformed_interval_records_no_second_gap() -> None:
    """The window fold has already classified this interval. A day fold recording its own
    `interval_malformed` would double every one of them in the `collection_log` and make a
    reader think two intervals were bad."""
    fold = DayFold(tz=JAKARTA)

    # Returns `None`, not a gap — the signature has no gap channel at all, which is the
    # design rather than an omission.
    assert (
        fold.fold(
            resource_id=RESOURCE,
            metric=CPU,
            timestamp="2026-06-30T17:00:00Z",
            total=None,
            count=None,
            minimum=None,
            maximum=None,
        )
        is None
    )
    assert statistics(fold) == {}


def test_a_day_with_no_interval_is_absent_rather_than_zero() -> None:
    """An absent day and a day measured at zero are the two readings this pipeline exists
    to keep apart. `statistics_for` returns only the days that folded something; the
    window's geometry supplies the rest, with an empty array."""
    fold = DayFold(tz=JAKARTA)
    fold_hours(fold, [("2026-06-30T17:00:00Z", "10")])

    found = statistics(fold)
    assert list(found) == ["2026-07-01"]
    assert "2026-07-02" not in found


# --------------------------------------------------------------------------- #
# Req 26.2 — the size claim, asserted
# --------------------------------------------------------------------------- #


def test_the_accumulator_count_is_flat_in_the_grain() -> None:
    """The structure this holds grows with **days**, not with points.

    That is the claim that makes a day fold compatible with Req 26.2's "hold no complete
    series": 96 quarter-hourly intervals over two days retain the same four accumulators
    as 48 hourly ones over the same two days, and 268,000 minute samples would retain the
    same four. Asserted rather than argued, because the requirement it reconciles with is
    load-bearing enough that a comment would not be enough.
    """
    hourly = DayFold(tz=JAKARTA)
    fold_hours(
        hourly,
        [(f"2026-06-30T{hour:02d}:00:00Z", "10") for hour in range(17, 24)]
        + [(f"2026-07-01T{hour:02d}:00:00Z", "20") for hour in range(0, 17)],
    )

    quarterly = DayFold(tz=JAKARTA)
    fold_hours(
        quarterly,
        [
            (f"2026-06-30T{hour:02d}:{minute:02d}:00Z", "10")
            for hour in range(17, 24)
            for minute in (0, 15, 30, 45)
        ]
        + [
            (f"2026-07-01T{hour:02d}:{minute:02d}:00Z", "20")
            for hour in range(0, 17)
            for minute in (0, 15, 30, 45)
        ],
    )

    # One local day, one metric, one resource — at either grain.
    # One local day, one metric, one resource — at either grain. The totals differ
    # because four times as many intervals were folded; the *structure* does not.
    assert len(hourly) == len(quarterly) == 1
    assert hourly.total_for(RESOURCE, CPU, date(2026, 7, 1)) == Decimal(7 * 10 + 17 * 20)
    assert quarterly.total_for(RESOURCE, CPU, date(2026, 7, 1)) == Decimal(
        28 * 10 + 68 * 20
    )


def test_the_accumulator_count_grows_with_days_and_metrics() -> None:
    """The other half of the same claim: it is `resources x metrics x days`, and nothing
    in it counts points."""
    fold = DayFold(tz=JAKARTA)
    for metric in (CPU, "Available Memory Bytes"):
        fold_hours(
            fold,
            [("2026-06-30T17:00:00Z", "10"), ("2026-07-01T17:00:00Z", "20")],
            metric=metric,
        )

    assert len(fold) == 2 * 2  # two metrics, two local days
