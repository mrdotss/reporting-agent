"""The historical trend's calendar: which months a run seeds, and over what windows.

The defect this file exists to prevent is a quiet one. A trend assembled from
UTC-aligned daily buckets — the obvious cheap way, and the one `collect/buckets.py`
refuses at `P1D` — would report a UTC+07:00 customer's month as running 07:00 to 07:00
local. Every figure would be plausible, none would be wrong by much, and the trend's
figure for the report's **own** month would disagree with the figure printed for the
period a few pages earlier, for a reason no reader could see.

So a month is resolved through `resolve_window` exactly as a report period is, and what
is asserted below is that the two really are the same construction.
"""

from __future__ import annotations

import os
from datetime import date, timedelta

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from reporting_agent.collect.buckets import (
    BASE_GRAIN,
    MAX_TREND_MONTHS,
    day_buckets,
    month_name,
    resolve_timezone,
    resolve_window,
    trend_months,
)

JAKARTA = resolve_timezone("Asia/Jakarta")  # UTC+07:00, no daylight saving
KATHMANDU = resolve_timezone("Asia/Kathmandu")  # UTC+05:45, a non-whole-hour offset
CHILE = resolve_timezone("America/Santiago")  # observes daylight saving
UTC_ZONE = resolve_timezone("UTC")


def july(tz=JAKARTA):
    return resolve_window(date(2026, 7, 1), date(2026, 7, 31), tz)


# --------------------------------------------------------------------------- #
# Which months
# --------------------------------------------------------------------------- #


def test_the_anchor_is_the_month_the_run_s_window_ends_in() -> None:
    """Not the month the run was enqueued in. A re-run of July in December produces the
    same three months the original did — which is what makes a re-run a revision of one
    document rather than a different document (Requirements line 1057)."""
    months = trend_months(july(), JAKARTA)

    assert [month.local_month for month in months] == ["2026-05", "2026-06", "2026-07"]


def test_the_months_are_oldest_first() -> None:
    months = trend_months(july(), JAKARTA)
    names = [month.local_month for month in months]

    assert names == sorted(names)


def test_the_walk_crosses_a_year_boundary() -> None:
    window = resolve_window(date(2026, 1, 1), date(2026, 1, 31), JAKARTA)
    months = trend_months(window, JAKARTA)

    assert [month.local_month for month in months] == ["2025-11", "2025-12", "2026-01"]


def test_the_walk_crosses_february_from_a_thirty_first() -> None:
    """A naive "subtract a month" that keeps the day-of-month lands on 31 February."""
    window = resolve_window(date(2026, 3, 31), date(2026, 3, 31), JAKARTA)
    months = trend_months(window, JAKARTA)

    assert [month.local_month for month in months] == ["2026-01", "2026-02", "2026-03"]
    february = months[1].window
    assert (february.local_start, february.local_end) == (
        date(2026, 2, 1),
        date(2026, 2, 28),
    )


def test_a_leap_february_gets_its_twenty_ninth_day() -> None:
    window = resolve_window(date(2028, 3, 1), date(2028, 3, 31), JAKARTA)
    february = trend_months(window, JAKARTA)[1].window

    assert february.local_end == date(2028, 2, 29)


def test_the_count_is_the_declared_bound_and_is_configurable_downward() -> None:
    assert len(trend_months(july(), JAKARTA)) == MAX_TREND_MONTHS
    assert len(trend_months(july(), JAKARTA, count=1)) == 1
    assert [m.local_month for m in trend_months(july(), JAKARTA, count=1)] == ["2026-07"]


@pytest.mark.parametrize("count", [0, -1, -12])
def test_a_non_positive_count_is_refused(count: int) -> None:
    """Zero months is a request for nothing, and a caller wanting no trend does not call
    this — returning `[]` would let a miscomputed count pass silently as "no trend"."""
    with pytest.raises(ValueError, match="count must be positive"):
        trend_months(july(), JAKARTA, count=count)


# --------------------------------------------------------------------------- #
# Over what windows — the same construction a report period uses
# --------------------------------------------------------------------------- #


def test_each_month_is_the_window_a_report_for_that_month_would_have_used() -> None:
    """The whole point. If these ever differ, the trend's July and the report's July are
    two different Julys printed in one document."""
    for month in trend_months(july(), JAKARTA):
        first = date.fromisoformat(f"{month.local_month}-01")
        last = month.window.local_end
        assert month.window == resolve_window(first, last, JAKARTA)


def test_the_report_s_own_month_resolves_to_the_report_s_own_window() -> None:
    period = july()
    anchor = trend_months(period, JAKARTA)[-1]

    assert anchor.local_month == "2026-07"
    assert anchor.window == period


@pytest.mark.parametrize("tz", [JAKARTA, KATHMANDU, CHILE, UTC_ZONE])
def test_a_month_starts_at_local_midnight_and_not_utc_midnight(tz) -> None:
    """Requirement 25.2, applied to the trend. Asserted across a whole-hour offset, a
    45-minute one and a daylight-saving zone, because a boundary that is only ever
    checked at UTC+07:00 is a boundary checked against one arithmetic."""
    for month in trend_months(july(tz), tz):
        assert month.window.start_utc.astimezone(tz).hour == 0
        assert month.window.start_utc.astimezone(tz).minute == 0
        assert month.window.start_utc.astimezone(tz).day == 1


@pytest.mark.parametrize("tz", [JAKARTA, KATHMANDU, CHILE, UTC_ZONE])
def test_consecutive_months_abut_with_no_gap_and_no_overlap(tz) -> None:
    """Half-open on the UTC side, so one month's end instant is the next one's start.
    An hour counted twice inflates a monthly average; an hour counted never deflates it."""
    months = trend_months(july(tz), tz)

    for earlier, later in zip(months, months[1:]):
        assert earlier.window.end_utc == later.window.start_utc


@pytest.mark.parametrize("tz", [JAKARTA, KATHMANDU, CHILE, UTC_ZONE])
def test_a_month_covers_exactly_its_own_local_days(tz) -> None:
    """Derived from `day_buckets` rather than from arithmetic on the window, so this
    asserts the same geometry the snapshot's own day dimension is built from."""
    for month in trend_months(july(tz), tz):
        buckets = day_buckets(month.window, tz, BASE_GRAIN)
        days = [bucket.local_day for bucket in buckets]

        assert days[0] == month.window.local_start
        assert days[-1] == month.window.local_end
        assert days == sorted(set(days))
        assert len(days) == (month.window.local_end - month.window.local_start).days + 1


def test_a_daylight_saving_month_is_not_padded_to_a_whole_number_of_hours() -> None:
    """Santiago's September holds a 23-hour day. The month still covers its own local
    days; it is the slot count that differs, and a trend that padded it would report a
    machine as busier for one month a year."""
    window = resolve_window(date(2026, 9, 1), date(2026, 9, 30), CHILE)
    month = trend_months(window, CHILE, count=1)[0]
    slots = sum(bucket.slot_count for bucket in day_buckets(month.window, CHILE, BASE_GRAIN))

    assert month.local_month == "2026-09"
    assert slots == 30 * 24 - 1


# --------------------------------------------------------------------------- #
# A month still in progress
# --------------------------------------------------------------------------- #


def test_the_current_month_is_clipped_to_today_rather_than_running_into_the_future() -> None:
    """A window extending past now is one Azure answers with empty intervals, and an
    average over "the month so far" divided by a whole month's slots reports a machine at
    a third of its real usage."""
    window = resolve_window(date(2026, 8, 1), date(2026, 8, 12), JAKARTA)
    months = trend_months(window, JAKARTA, today=date(2026, 8, 12))

    assert months[-1].local_month == "2026-08"
    assert months[-1].window.local_end == date(2026, 8, 12)


def test_a_clipped_month_is_kept_rather_than_dropped() -> None:
    """Two thirds of a month is a real observation and the slot count says so; omitting
    it would leave the trend one month shorter than it claims to be."""
    window = resolve_window(date(2026, 8, 1), date(2026, 8, 1), JAKARTA)
    months = trend_months(window, JAKARTA, today=date(2026, 8, 1))

    assert len(months) == MAX_TREND_MONTHS
    assert months[-1].window.local_start == months[-1].window.local_end


def test_a_finished_month_is_not_clipped_by_a_later_today() -> None:
    """`today` bounds a month that has not ended. A `today` in the future of every month
    must change nothing at all."""
    assert trend_months(july(), JAKARTA, today=date(2026, 12, 25)) == trend_months(
        july(), JAKARTA
    )


def test_earlier_months_are_never_clipped_by_today() -> None:
    """`today` bounds the anchor, not the history — a run on the 3rd still compares
    against two whole prior months."""
    window = resolve_window(date(2026, 8, 1), date(2026, 8, 3), JAKARTA)
    months = trend_months(window, JAKARTA, today=date(2026, 8, 3))

    assert months[0].window.local_end == date(2026, 6, 30)
    assert months[1].window.local_end == date(2026, 7, 31)


def test_omitting_today_treats_every_month_as_finished() -> None:
    """The right reading for a window that has already closed, and it keeps the function
    pure for every caller with no clock."""
    assert trend_months(july(), JAKARTA) == trend_months(
        july(), JAKARTA, today=date(2026, 7, 31)
    )


# --------------------------------------------------------------------------- #
# `month_name`
# --------------------------------------------------------------------------- #


def test_month_name_is_zero_padded_so_it_sorts_chronologically() -> None:
    """Every array order on the snapshot path is a code-point sort, so `2026-9` sorting
    after `2026-10` would put the trend's months in the wrong order in the document."""
    names = [month_name(date(2026, m, 15)) for m in range(1, 13)]

    assert names == sorted(names)
    assert names[8] == "2026-09"


def test_month_name_is_the_month_every_day_of_that_month_falls_in() -> None:
    day = date(2026, 2, 1)
    while day.month == 2:
        assert month_name(day) == "2026-02"
        day += timedelta(days=1)
