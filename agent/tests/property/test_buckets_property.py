"""Property 6 — local-day bucketing is correct at every offset and every window edge.

**Validates: Requirements 25.1, 25.3, 25.5, 25.6, 25.7, 25.8, 25.11, 42.2, 42.4, 42.8**

The module under test, ``collect/buckets.py``, takes a bare ``datetime.tzinfo`` rather
than a zone name (see its own docstring), which is what lets this property drive it
with plain fixed-offset ``datetime.timezone`` instances instead of real IANA zones.
``zoneinfo.ZoneInfo`` accepts only IANA names — ``ZoneInfo("+05:45")`` raises — so the
nine declared offsets below are constructed directly as ``datetime.timezone`` values.
Every function this module exports reads only ``tzinfo.utcoffset(instant)``, so a
fixed offset with no daylight-saving transitions exercises the identical code path as
a transitioning IANA zone (see ``_offsets_across_window``'s docstring for why hourly
sampling is exact either way).

Four classes of failure a plausible implementation gets wrong, each with its own
assertion group below:

* **Direction.** A naive implementation buckets by the UTC calendar day. That is
  wrong in *both* directions depending on the sign of the offset — a positive offset
  needs evening UTC hours pulled forward a day, a negative offset needs early-morning
  UTC hours pulled back a day — so both directions are exercised as declared,
  generated cases (Req 25.3, Property 6.2), not as one hand-picked example that could
  coincidentally pass a one-directional bug.
* **The half-open edge.** An inclusive end instant adds a bucket that should not
  exist; a `00:00Z...23:59Z` window instead of the correct UTC instants misses part of
  the last local day. Both are killed by the declared July 2026 example (Property 6.9)
  and by the generic round-trip/bucket-count check (Property 6.6, 6.8) that runs over
  every generated range.
* **Grain selection.** Whole-hour offsets must select `PT1H`; the four non-whole-hour
  offsets in the declared set must select `PT15M`; nothing else is a valid return
  value (Req 25.5, 25.6, 25.8, Property 6.5).
* **Partial edge days.** `resolve_window` always aligns a window to local midnight at
  both ends, so a window built *through* it never actually produces a partial day at a
  fixed offset with no transitions — the window length divides evenly into whole
  local days every time. Req 25.11 / Property 6.4 is therefore tested by handing
  `day_buckets` a hand-constructed, deliberately misaligned `Window` directly, which
  is exactly the case the requirement is written for (a grain boundary that does not
  line up with a day boundary) rather than a case this module's own window builder
  can ever produce.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta, timezone
from datetime import tzinfo as TzInfo

from hypothesis import example, given
from hypothesis import strategies as st

from reporting_agent.collect.buckets import (
    BASE_GRAIN,
    FALLBACK_GRAIN,
    Window,
    choose_grain,
    day_buckets,
    local_day,
    resolve_window,
)

# --- the declared set of fixed-offset zones (Req 25.7 / Property 6.7) --------------
#
# (label, tzinfo, is_whole_hour). Constructed as `datetime.timezone`, never
# `zoneinfo.ZoneInfo` — see the module docstring above for why.

OFFSETS: list[tuple[str, TzInfo, bool]] = [
    ("+07:00", timezone(timedelta(hours=7)), True),
    ("+00:00", timezone(timedelta(hours=0)), True),
    ("+14:00", timezone(timedelta(hours=14)), True),
    ("-05:00", timezone(timedelta(hours=-5)), True),
    ("-11:00", timezone(timedelta(hours=-11)), True),
    ("+05:45", timezone(timedelta(hours=5, minutes=45)), False),
    ("+05:30", timezone(timedelta(hours=5, minutes=30)), False),
    ("+08:45", timezone(timedelta(hours=8, minutes=45)), False),
    ("-09:30", timezone(timedelta(hours=-9, minutes=-30)), False),
]

PLUS_SEVEN = next(tz for label, tz, _ in OFFSETS if label == "+07:00")
MINUS_FIVE = next(tz for label, tz, _ in OFFSETS if label == "-05:00")

_JULY_2026 = (date(2026, 7, 1), date(2026, 7, 31))
_LEAP_DAY_2028 = (date(2028, 2, 28), date(2028, 3, 1))

offsets = st.sampled_from(OFFSETS)


@st.composite
def local_ranges(draw: st.DrawFn) -> tuple[date, date]:
    """A local date range of 1-31 days (Req 25.7 / Property 6.7's declared range)."""
    start = draw(st.dates(min_value=date(2000, 1, 1), max_value=date(2100, 12, 1)))
    day_count = draw(st.integers(min_value=1, max_value=31))
    return start, start + timedelta(days=day_count - 1)


def _full_slot_count(grain: str) -> int:
    return 24 if grain == BASE_GRAIN else 96


def _slot_duration(grain: str) -> timedelta:
    return timedelta(hours=1) if grain == BASE_GRAIN else timedelta(minutes=15)


# --- Property 6.1, 6.3, 6.4 (full days), 6.5, 6.6, 6.7, 6.8, 6.9 --------------------


@given(offset=offsets, local_range=local_ranges())
@example(offset=("+07:00", PLUS_SEVEN, True), local_range=_JULY_2026)
@example(offset=("+07:00", PLUS_SEVEN, True), local_range=_LEAP_DAY_2028)
@example(offset=("-05:00", MINUS_FIVE, True), local_range=_JULY_2026)
def test_window_grain_and_buckets_agree_at_every_offset_and_range(
    offset: tuple[str, TzInfo, bool], local_range: tuple[date, date]
) -> None:
    """The window round-trips, the grain matches the offset's shape, and every full
    local day in the range comes back as one bucket at the full slot count for that
    grain — for every declared offset and every generated 1-31 day range.
    """
    _, tz, is_whole_hour = offset
    start, end = local_range

    window = resolve_window(start, end, tz)

    # Property 6.6 — the window round-trips: the start instant's local day is the
    # requested start date, and the end instant's local day is the day *after* the
    # requested end date (the half-open end, Req 25.7).
    assert local_day(window.start_utc, tz) == start
    assert local_day(window.end_utc, tz) == end + timedelta(days=1)
    assert window.end_utc - window.start_utc == timedelta(days=(end - start).days + 1)

    # Property 6.5 — grain selection is a pure function of the offset's shape, and no
    # third grain string is ever reachable.
    grain = choose_grain(window, tz)
    assert grain in (BASE_GRAIN, FALLBACK_GRAIN)
    assert grain == (BASE_GRAIN if is_whole_hour else FALLBACK_GRAIN)

    # Property 6.9 — the declared July 2026 case resolves to the exact UTC instants,
    # inclusive start / exclusive end, at +07:00.
    if offset[0] == "+07:00" and local_range == _JULY_2026:
        assert window.start_utc == datetime(2026, 6, 30, 17, 0, 0, tzinfo=UTC)
        assert window.end_utc == datetime(2026, 7, 31, 17, 0, 0, tzinfo=UTC)

    buckets = day_buckets(window, tz, grain)
    expected_days = (end - start).days + 1
    full = _full_slot_count(grain)

    # Property 6.8 — exactly one bucket per local day in the range. 31 for the
    # declared July 2026 case; never a 32nd from an inclusive end.
    assert len(buckets) == expected_days
    if offset[0] == "+07:00" and local_range == _JULY_2026:
        assert len(buckets) == 31

    # Buckets cover the range's local days in ascending order, with no gap and no
    # day outside [start, end].
    expected_local_days = [start + timedelta(days=i) for i in range(expected_days)]
    assert [b.local_day for b in buckets] == expected_local_days

    # Property 6.1, 6.4 (full-day half) — a fixed offset carries no daylight-saving
    # transition, so `resolve_window`'s local-midnight-aligned window divides evenly
    # into whole local days at either grain: every bucket here is a *full* day.
    assert all(b.slot_count == full for b in buckets)

    # Property 6.3 — half-open coverage: the total number of grain slots folded
    # equals the number of grain slots the window actually spans, which is exactly
    # what "the end instant is assigned to no bucket, the start instant is" means in
    # aggregate (an inclusive-end bug would fold one extra slot per day here).
    total_slots = sum(b.slot_count for b in buckets)
    assert total_slots == expected_days * full
    assert total_slots == (window.end_utc - window.start_utc) / _slot_duration(grain)


def test_the_declared_july_2026_window_resolves_to_the_exact_utc_instants() -> None:
    """Req 25.7, 25.9 / Property 6.9 — pinned down without hypothesis, so it runs
    deterministically even if the generator never draws this exact range."""
    window = resolve_window(date(2026, 7, 1), date(2026, 7, 31), PLUS_SEVEN)

    assert window.start_utc == datetime(2026, 6, 30, 17, 0, 0, tzinfo=UTC)
    assert window.end_utc == datetime(2026, 7, 31, 17, 0, 0, tzinfo=UTC)

    grain = choose_grain(window, PLUS_SEVEN)
    assert grain == BASE_GRAIN

    buckets = day_buckets(window, PLUS_SEVEN, grain)
    assert len(buckets) == 31
    assert buckets[0].local_day == date(2026, 7, 1)
    assert buckets[-1].local_day == date(2026, 7, 31)
    assert all(b.slot_count == 24 for b in buckets)


# --- Property 6.2 — direction, both signs -------------------------------------------


@given(
    base_date=st.dates(min_value=date(2000, 1, 1), max_value=date(2100, 12, 1)),
    hour=st.integers(min_value=17, max_value=23),
    minute=st.integers(min_value=0, max_value=59),
    second=st.integers(min_value=0, max_value=59),
)
@example(base_date=date(2026, 7, 15), hour=17, minute=0, second=0)
@example(base_date=date(2026, 7, 15), hour=23, minute=59, second=59)
def test_utc_evening_hours_land_on_the_next_local_day_at_plus_seven(
    base_date: date, hour: int, minute: int, second: int
) -> None:
    """Req 25.3 / Property 6.2 — UTC 17:00-23:59 at +07:00 is the *next* local day,
    which kills bucketing by the UTC calendar day."""
    instant = datetime(base_date.year, base_date.month, base_date.day, hour, minute, second, tzinfo=UTC)

    assert local_day(instant, PLUS_SEVEN) == base_date + timedelta(days=1)


@given(
    base_date=st.dates(min_value=date(2000, 1, 1), max_value=date(2100, 12, 1)),
    hour=st.integers(min_value=0, max_value=4),
    minute=st.integers(min_value=0, max_value=59),
    second=st.integers(min_value=0, max_value=59),
)
@example(base_date=date(2026, 7, 15), hour=0, minute=0, second=0)
@example(base_date=date(2026, 7, 15), hour=4, minute=59, second=59)
def test_utc_early_morning_hours_land_on_the_previous_local_day_at_minus_five(
    base_date: date, hour: int, minute: int, second: int
) -> None:
    """Req 25.3 / Property 6.2 — UTC 00:00-04:59 at -05:00 is the *previous* local
    day, killing the same bug in the opposite offset direction."""
    instant = datetime(base_date.year, base_date.month, base_date.day, hour, minute, second, tzinfo=UTC)

    assert local_day(instant, MINUS_FIVE) == base_date - timedelta(days=1)


# --- Property 6.4 — partial edge days, via a hand-constructed Window ---------------
#
# `resolve_window` always aligns both ends to local midnight, so a window built
# *through* it never has a partial day at a fixed, transition-free offset — the
# window's length divides evenly into whole local days every time. A sub-slot
# misalignment does not create one either: because the slot period always divides
# 24 hours evenly, any window starting strictly less than one slot period after
# local midnight still contains a full complement of slots before the next midnight
# (23h59m of hourly slots still yields 24 slot-starts). A genuine partial day needs
# the window to start (or end) a whole number of *slots* — not a fraction of one —
# into a local day, which is exactly the misaligned-`Window` case Req 25.11 is
# written for: a caller handing `day_buckets` a window whose bounds do not line up
# with local-day boundaries at all.


@st.composite
def misaligned_windows(draw: st.DrawFn) -> tuple[TzInfo, str, int, int]:
    """A `tzinfo`, a grain, a whole-slot offset into the first day, and a total slot
    count that together guarantee exactly one partial day (the first) followed by
    zero or more full days.
    """
    _, tz, _ = draw(offsets)
    grain = draw(st.sampled_from([BASE_GRAIN, FALLBACK_GRAIN]))
    full = _full_slot_count(grain)
    # Slots already elapsed in the first day before the window starts: 1..full-1, so
    # the first bucket is short of a full day but never empty.
    offset_slots = draw(st.integers(min_value=1, max_value=full - 1))
    extra_full_days = draw(st.integers(min_value=0, max_value=3))
    total_slots = (full - offset_slots) + full * extra_full_days
    return tz, grain, offset_slots, total_slots


@given(case=misaligned_windows())
@example(case=(PLUS_SEVEN, BASE_GRAIN, 1, 24 - 1))
@example(case=(PLUS_SEVEN, BASE_GRAIN, 23, (24 - 23) + 24 * 2))
@example(case=(MINUS_FIVE, FALLBACK_GRAIN, 95, (96 - 95) + 96))
def test_a_partial_edge_day_is_retained_with_its_contributing_slot_count(
    case: tuple[TzInfo, str, int, int],
) -> None:
    """Req 25.11 / Property 6.4 — a local day at the edge of the window that carries
    fewer than a full day's slots is still returned as a bucket, carrying exactly how
    many slots contributed to it (never 0, never silently completed to the full
    count), while every day strictly after the partial first day stays full.
    """
    tz, grain, offset_slots, total_slots = case
    slot_duration = _slot_duration(grain)
    full = _full_slot_count(grain)

    anchor_date = date(2027, 5, 10)
    aligned_midnight_utc = datetime.combine(anchor_date, time.min, tzinfo=tz).astimezone(UTC)
    start_utc = aligned_midnight_utc + offset_slots * slot_duration
    end_utc = start_utc + total_slots * slot_duration

    window = Window(
        local_start=anchor_date,
        local_end=anchor_date,
        start_utc=start_utc,
        end_utc=end_utc,
    )

    buckets = day_buckets(window, tz, grain)
    expected_first_count = full - offset_slots

    # Never dropped, never padded: the total folded matches exactly what was asked
    # for, and every bucket's count is a real, in-range slot count.
    assert sum(b.slot_count for b in buckets) == total_slots
    assert all(1 <= b.slot_count <= full for b in buckets)
    assert [b.local_day for b in buckets] == sorted(b.local_day for b in buckets)

    # The first bucket is the anchor day, genuinely partial: it carries exactly the
    # number of slots left in that day after `offset_slots` have already elapsed,
    # never the full 24 (PT1H) / 96 (PT15M) count Property 6.1 asserts for an aligned
    # day, and never 0.
    assert buckets[0].local_day == anchor_date
    assert buckets[0].slot_count == expected_first_count
    assert 1 <= buckets[0].slot_count < full

    # Every day after the partial first one is a full day, because the window was
    # constructed to end exactly on a local-midnight slot boundary.
    for later in buckets[1:]:
        assert later.slot_count == full
