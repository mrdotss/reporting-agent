"""The Bucketer — local-day bucketing, the half-open collection window, and grain choice.

Four pure functions, over `datetime.tzinfo` rather than any zone-name string, so the
same code path handles a real IANA `ZoneInfo` and the property test's fixed-offset
`datetime.timezone` instances identically (Req 25.6's "no hardcoded zone list" is
easiest kept true by never special-casing a zone at all):

    resolve_window(start_date, end_date, tz) -> Window
    choose_grain(window, tz) -> str
    local_day(instant_utc, tz) -> date
    day_buckets(window, tz, grain) -> list[DayBucket]

Plus the one function that *does* know about zone names — :func:`resolve_timezone` —
which turns the invocation `context`'s raw `timezone` string into the `tzinfo` the four
functions above accept, applying the `Asia/Jakarta` default (Req 25.4) and raising on a
value that resolves to no IANA zone (Req 25.9).

**Why `P1D` is never requested.** Daily buckets are UTC-aligned, so a UTC+07:00
customer's reported "day" would silently span 07:00 to 07:00 local — peak-hour analysis
becomes meaningless and the month edges include and exclude the wrong data (Req 25.2).

**Why `PT1M` is never requested either.** 200 resources x 6 metrics x 31 days is
roughly 268,000 points per resource and ~6 GB of JSON at `PT1M`, against ~4,500 points
and ~110 MB at `PT1H` (Req 25.8). Grain, not resource count, is the scaling limit, and
`BASE_GRAIN` / `FALLBACK_GRAIN` are declared as the two grains that exist as far as this
module — and every caller of it — is concerned.

**Why the geometry functions take a bare `tzinfo` rather than a zone name.** Req 25.6
requires `choose_grain` to derive `PT1H` vs `PT15M` "from the UTC offsets it evaluated
across that run's collection window" and to "consult no hardcoded list of zone names."
The only way to make that a property of the code rather than a promise about it is to
give the function nothing a zone *name* could be extracted from — a `datetime.tzinfo`
answers `utcoffset(instant)` and nothing else this module reads. `zoneinfo.ZoneInfo`
and `datetime.timezone` are both `tzinfo` subclasses, so a fixed offset like `+05:45`
(Asia/Kathmandu, which has no daylight-saving transitions to speak of) exercises the
identical code path as a DST-observing IANA zone; there is no branch here that could
tell them apart.

**Interpreting a timestamp as UTC (Req 25.10).** `local_day` treats a naive
`datetime` as already representing a UTC wall-clock reading — Azure Monitor returns UTC
timestamps — rather than reinterpreting it in whatever zone the host process happens to
run in. That is what "identical under every host and process time zone setting" (Req
25.10) means operationally: this module never consults `time.tzname`, `datetime.now()`
or any other ambient clock/zone source.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from datetime import tzinfo as TzInfo
from typing import Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

__all__ = [
    "BASE_GRAIN",
    "DEFAULT_TIMEZONE",
    "FALLBACK_GRAIN",
    "DayBucket",
    "UnresolvableTimezoneError",
    "Window",
    "choose_grain",
    "day_buckets",
    "local_day",
    "resolve_timezone",
    "resolve_window",
]

# --- the only two grains this run ever requests (Req 25.1, 25.2, 25.5, 25.8) --------

BASE_GRAIN: Final[str] = "PT1H"
FALLBACK_GRAIN: Final[str] = "PT15M"

_SLOT_DURATION: Final[dict[str, timedelta]] = {
    BASE_GRAIN: timedelta(hours=1),
    FALLBACK_GRAIN: timedelta(minutes=15),
}

DEFAULT_TIMEZONE: Final[str] = "Asia/Jakarta"
"""Used whenever an invocation's `context` omits `timezone` or carries an empty one
(Req 25.4). UTC+07:00, no daylight saving."""


# --- resolving a zone name (Req 25.4, 25.9) -----------------------------------------


class UnresolvableTimezoneError(ValueError):
    """`timezone` resolves to no IANA time zone.

    Req 25.9 requires the *runtime* to respond to this by emitting a terminal `error`
    event, making no metric request and writing no snapshot — none of which this
    module has any means to do, since it holds no event egress and no run state. What
    this module owns is the narrower, checkable half: raising loudly and early rather
    than silently substituting a default or a guess, so that whatever calls
    :func:`resolve_timezone` first (the entrypoint's context parsing, or
    `collect/pipeline.py`, depending on where task 11.9 wires it in) has a single,
    unambiguous signal to translate into that terminal event before touching Azure.

    Deliberately a `ValueError` subclass, not an `errors.AgentError` subclass: every
    `AgentError` code is a fact about a *collection* that was attempted and failed
    partway (Req 36.6's ten-code partition), and this failure occurs before collection
    has anything to attempt — there is no grain, no window and therefore no batch to
    request. Wiring a terminal `error` event for this case is left to whichever later
    task owns that translation, so this module carries no opinion about which
    `error.code` string the event should carry.
    """

    def __init__(self, raw: object) -> None:
        super().__init__(
            f"{raw!r} resolves to no IANA time zone. An unresolvable zone would "
            f"silently change every local-day value this run computes, so no metric "
            f"request may be made and no snapshot may be written for it (Req 25.9)."
        )
        self.raw = raw


def resolve_timezone(raw: object) -> ZoneInfo:
    """The run's timezone as a `ZoneInfo`, applying the `Asia/Jakarta` default.

    `raw` is whatever an invocation's `context.timezone` happened to carry:

    * `None`, or a string that is empty or whitespace-only after stripping, resolves
      to :data:`DEFAULT_TIMEZONE` (Req 25.4) — omitting the field and sending `""`
      are one mistake with two spellings, and both get the same default.
    * A non-empty string is resolved against the IANA database. A name the database
      has never heard of raises :class:`UnresolvableTimezoneError` (Req 25.9).
    * Anything that is not a string at all (a payload that sent a number or an object
      where a zone name belongs) is treated the same way — it resolves to no IANA
      zone, because there is no string to look one up by.
    """
    if raw is None:
        candidate = DEFAULT_TIMEZONE
    elif isinstance(raw, str):
        candidate = raw if raw.strip() else DEFAULT_TIMEZONE
    else:
        raise UnresolvableTimezoneError(raw)

    try:
        return ZoneInfo(candidate)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        # `ValueError` covers zoneinfo's own input-shape rejections (an empty key, a
        # key escaping TZPATH via `..`, …) — every one of those is "not a zone name"
        # exactly as much as a `ZoneInfoNotFoundError` is, so both collapse to the one
        # terminal exception a caller has to handle.
        raise UnresolvableTimezoneError(candidate) from exc


# --- the half-open collection window (Req 25.7) -------------------------------------


@dataclass(frozen=True, slots=True)
class Window:
    """The collection window: local calendar dates plus the UTC instants they resolve
    to, half-open on the UTC side — `[start_utc, end_utc)` (Req 25.7).

    Distinct from `providers.base.Window`, which is the `TypedDict` of **strings**
    this same information takes when it crosses the provider boundary or lands in the
    snapshot document (`"2026-07-01"`, `"2026-06-30T17:00:00Z"`, …). This dataclass is
    the computable form the geometry functions in this module operate on; a caller
    serializing one into the other formats `start_utc` / `end_utc` as RFC 3339 and
    `local_start` / `local_end` as `YYYY-MM-DD` — a step this module does not take,
    because `resolve_window`'s callers include the property test, which asserts
    against `datetime` and `date` values directly rather than against their string
    encodings.
    """

    local_start: date
    """The requested local start date, inclusive."""

    local_end: date
    """The requested local end date, inclusive — the window still ends at UTC
    midnight of the day *after* this date (see `end_utc`)."""

    start_utc: datetime
    """`local_start` at 00:00:00 in the run's timezone, converted to UTC. Included in
    the window."""

    end_utc: datetime
    """00:00:00 on the local day *after* `local_end`, converted to UTC. Excluded from
    the window — this is what makes the window half-open."""


def resolve_window(start_date: date, end_date: date, tz: TzInfo) -> Window:
    """The half-open UTC window for the local calendar range `[start_date, end_date]`.

    Resolves the window start to 00:00:00 on `start_date` and the window end to
    00:00:00 on the local day following `end_date`, both in `tz`, and converts both to
    UTC (Req 25.7) — which is what makes a "2026-07-01 to 2026-07-31" request cover
    exactly 31 local days rather than 30 or 32.

    Raises `ValueError` if `end_date` precedes `start_date`: the day-after-`end_date`
    construction only defines a window at all when there is at least one local day to
    cover. The 1-to-31-day range itself is an enqueue-time policy (Req 37.10), not a
    fact this pure function enforces — a caller wanting that check makes it before
    calling this.
    """
    if end_date < start_date:
        raise ValueError(
            f"end_date {end_date.isoformat()} precedes start_date "
            f"{start_date.isoformat()}; a window needs at least one local day."
        )

    local_start_midnight = datetime.combine(start_date, time.min, tzinfo=tz)
    local_end_midnight = datetime.combine(
        end_date + timedelta(days=1), time.min, tzinfo=tz
    )

    return Window(
        local_start=start_date,
        local_end=end_date,
        start_utc=local_start_midnight.astimezone(UTC),
        end_utc=local_end_midnight.astimezone(UTC),
    )


# --- grain choice, derived from the offsets in effect (Req 25.5, 25.6) --------------


def _utc_offset_at(instant_utc: datetime, tz: TzInfo) -> timedelta:
    """The UTC offset `tz` has in effect at `instant_utc`."""
    offset = instant_utc.astimezone(tz).utcoffset()
    if offset is None:  # pragma: no cover - no stdlib tzinfo does this for an aware dt
        raise ValueError(f"{tz!r} produced no UTC offset for {instant_utc!r}")
    return offset


def _is_whole_hour(offset: timedelta) -> bool:
    return offset.total_seconds() % 3600 == 0


def _offsets_across_window(window: Window, tz: TzInfo) -> list[timedelta]:
    """Every UTC offset `tz` is in effect at across `window`: at the start instant, at
    the end instant, and at every whole-hour mark strictly between them.

    Req 25.5 asks for the offset "at the collection window's start instant, at the
    collection window's end instant, or at any offset transition falling between
    them." This module has no API that enumerates a `tzinfo`'s transition instants
    directly — none of `zoneinfo`, `datetime` or this module's own dependencies expose
    one — so it samples at hourly resolution instead, which is exact for every zone
    this run can be configured with: a zone offering a **non-whole-hour** offset (Nepal
    at `+05:45`, and the property test's declared `+05:45` / `+05:30` / `+08:45`
    fixtures) carries that offset with no daylight-saving transition to begin with, and
    a zone that **does** observe daylight saving in the real IANA database transitions
    between two **whole-hour** offsets, so hourly sampling never needs to catch a
    transition mid-hour to reach the correct whole-hour-or-not verdict either side of
    it. A transition that shifted a zone between two non-whole-hour offsets at a
    sub-hour instant is not representable in the current IANA database at all.
    """
    offsets = [_utc_offset_at(window.start_utc, tz)]

    step = timedelta(hours=1)
    current = window.start_utc + step
    while current < window.end_utc:
        offsets.append(_utc_offset_at(current, tz))
        current += step

    offsets.append(_utc_offset_at(window.end_utc, tz))
    return offsets


def choose_grain(window: Window, tz: TzInfo) -> str:
    """`PT1H` if every UTC offset `tz` holds across `window` is a whole number of
    hours, `PT15M` otherwise (Req 25.1, 25.5) — derived solely from those offsets, with
    no zone name ever inspected (Req 25.6).
    """
    if all(_is_whole_hour(offset) for offset in _offsets_across_window(window, tz)):
        return BASE_GRAIN
    return FALLBACK_GRAIN


# --- assigning one instant to a local day (Req 25.3, 25.10) -------------------------


def local_day(instant_utc: datetime, tz: TzInfo) -> date:
    """The local calendar date, in `tz`, containing `instant_utc`.

    `instant_utc` is interpreted as UTC regardless of whether it already carries
    `tzinfo` (Req 25.10): a naive value is treated as a UTC wall-clock reading — the
    shape Azure Monitor's own timestamps arrive in — rather than as the host process's
    local time, and an aware value is converted to UTC rather than re-read in its own
    zone. Either way the result depends only on the instant and `tz`, never on the
    host's or the process's own time zone setting.

    Used with an interval's **start** instant, never its end (Req 25.3): a point
    covering `[17:00, 18:00)` UTC belongs to whichever local day contains `17:00`,
    even if `18:00` falls in the next one.
    """
    aware = instant_utc if instant_utc.tzinfo is not None else instant_utc.replace(tzinfo=UTC)
    return aware.astimezone(tz).date()


# --- local-day buckets over a window, slot counts retained (Req 25.11) -------------


@dataclass(frozen=True, slots=True)
class DayBucket:
    """One local day's worth of slots inside a window, and how many of them there
    were (Req 25.11)."""

    local_day: date
    slot_count: int


def day_buckets(window: Window, tz: TzInfo, grain: str) -> list[DayBucket]:
    """Every local day touched by `window` at `grain`, each carrying the count of
    `grain`-sized slots that actually fell inside `window` and were assigned to it.

    A slot starts at `window.start_utc`, `window.start_utc + grain`,
    `window.start_utc + 2*grain`, and so on, up to but excluding `window.end_utc`
    (Req 25.7's half-open rule, applied to slots rather than restated for them) —
    every slot in a window `resolve_window` produced lines up with the grain's own
    boundaries because `resolve_window`'s start and end are both local midnights, but
    this function makes no such assumption about its `window` argument, so a caller
    can hand it an arbitrarily-bounded window and still get a correct, possibly
    partial, count per day.

    **Partial edge days are never dropped or padded to a full count** (Req 25.11): a
    local day at either edge of `window` that contains fewer slots than a full local
    day (24 at `PT1H`, 96 at `PT15M`) still appears in the returned list, with
    `slot_count` set to however many slots of it actually fell inside `window` — never
    silently completed to 24/96 and never omitted for being incomplete.

    Raises `ValueError` for any `grain` other than `BASE_GRAIN` or `FALLBACK_GRAIN`
    (Req 25.8) — this function has no notion of `P1D` or `PT1M` slots to count.

    Returned in ascending `local_day` order — produced, not inherited, matching every
    other array-order rule on the snapshot path (Req 34.8's principle applied here).
    """
    slot_duration = _SLOT_DURATION.get(grain)
    if slot_duration is None:
        raise ValueError(
            f"grain must be {BASE_GRAIN!r} or {FALLBACK_GRAIN!r}, got {grain!r}"
        )

    counts: dict[date, int] = {}
    current = window.start_utc
    while current < window.end_utc:
        day = local_day(current, tz)
        counts[day] = counts.get(day, 0) + 1
        current += slot_duration

    return [DayBucket(local_day=day, slot_count=counts[day]) for day in sorted(counts)]
