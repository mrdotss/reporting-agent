"""The heartbeat — a 15-second keep-alive merged into the pipeline's event stream.

A pull-based async generator cannot emit on a timer: it only produces an event when
its consumer asks and its own body has something to yield. Inventory and metrics
collection run for minutes with nothing to say, so a run that is perfectly healthy
looks idle to every intermediary between the runtime and the browser — and an idle SSE
connection gets closed. `merge_with_heartbeat` therefore runs **two** tasks over one
`asyncio.Queue`:

* a **pump** draining `source` into the queue, and
* a **ticker** pushing `{"type": "heartbeat", "ts": ...}` every `interval`.

The consumer yields from the queue until the pump completes or the terminal event has
been forwarded, then cancels the ticker — so **nothing can follow `done`** (Req 16.3).
Stopping the read is what enforces that, not a check on the ticker: once the loop
breaks, a heartbeat already sitting in the queue is simply never yielded.

Four properties are structural rather than remembered:

* **The first heartbeat fires within 20 seconds of acceptance** (Req 16.1), because the
  ticker's first deadline is read from the clock when the merge starts — before either
  task is scheduled — rather than when the ticker itself first runs, and certainly not
  at the first phase transition. A run whose inventory takes four minutes must not look
  dead for four minutes.
* **A heartbeat carries only a timestamp** (Req 16.6). `heartbeat_event` is the only
  constructor and it writes exactly `type` and `ts` — no phase label, no counts, no run
  id — so no client can mistake a keep-alive for run state.
* **Timestamps never decrease** (Req 16.7). `_Timestamps` clamps against the last value
  it emitted, so even an injected clock that runs backwards cannot produce a decreasing
  pair.
* **A ticker that raises is logged and the invocation continues to its terminal event,
  recording no `collection_log` gap** (Req 16.5). This module constructs no gap record
  and imports nothing that could — a heartbeat failure is a transport failure, not a
  fact about a customer's resources, and recording it as a gap would put a defect in
  our own keep-alive into a document about their infrastructure.

`clock` and `sleep` are injected so the suite can drive 45 simulated seconds of a silent
phase in milliseconds (Req 16.8). The ticker schedules against **deadlines read from the
clock** rather than trusting that one `sleep(interval)` advanced time by exactly
`interval`; that makes the number of heartbeats a function of elapsed time rather than of
scheduling luck, which is precisely what Req 16.1 and Req 16.8 assert. The same choice
means a starved event loop catches up rather than silently skipping ticks, bounded by
`MAX_CATCH_UP_TICKS` so a long stall cannot flood the queue.

**One gap constant, two consumers.** `MAX_EVENT_GAP_S` is the number the relay's
inactivity window derives from (Req 16.2), so `RELAY_INACTIVITY_WINDOW_S` is computed
from it here instead of being written down twice. The row-derived relay and the runtime
stream cannot drift to different numbers if only one of them is a number.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Final

from reporting_agent.events import (
    EMITTED_BY_FOUNDATION,
    EVENT_TYPES,
    HEARTBEAT_EVENT_TYPE,
    TERMINAL_EVENT_TYPE,
)

__all__ = [
    "FIRST_HEARTBEAT_DEADLINE_S",
    "HEARTBEAT_FIELDS",
    "HEARTBEAT_INTERVAL_S",
    "HEARTBEAT_TOLERANCE_S",
    "HEARTBEAT_TYPE",
    "MAX_CATCH_UP_TICKS",
    "MAX_EVENT_GAP_S",
    "RELAY_INACTIVITY_WINDOW_FACTOR",
    "RELAY_INACTIVITY_WINDOW_S",
    "heartbeat_event",
    "is_terminal_event",
    "merge_with_heartbeat",
]

logger = logging.getLogger(__name__)

Event = dict[str, Any]
Clock = Callable[[], float]
Sleep = Callable[[float], Awaitable[None]]

HEARTBEAT_TYPE: Final[str] = HEARTBEAT_EVENT_TYPE
"""The keep-alive type, re-exported from `events.py` under this module's local name.

The literal itself lives in `events.py` with the rest of the vocabulary; re-declaring
it here would be a second place the string could be edited. The alias stays because it
reads better at the use sites in this module and because the suite imports it.
"""

# Req 16.1 — 15 seconds, tolerance +/- 5 seconds, first one within 20.
HEARTBEAT_INTERVAL_S: Final[float] = 15.0
HEARTBEAT_TOLERANCE_S: Final[float] = 5.0
FIRST_HEARTBEAT_DEADLINE_S: Final[float] = 20.0

# Req 16.2 — the largest permitted gap between consecutive events of any type, and the
# one number the relay's inactivity window derives from.
MAX_EVENT_GAP_S: Final[float] = 30.0
RELAY_INACTIVITY_WINDOW_FACTOR: Final[int] = 4
RELAY_INACTIVITY_WINDOW_S: Final[float] = (
    MAX_EVENT_GAP_S * RELAY_INACTIVITY_WINDOW_FACTOR
)

# The only two keys a heartbeat may carry (Req 16.6).
HEARTBEAT_FIELDS: Final[frozenset[str]] = frozenset({"type", "ts"})

# Emitted timestamps are rounded to milliseconds: a keep-alive is never hashed and never
# rendered as a figure, and rounding a non-decreasing sequence keeps it non-decreasing.
TS_DECIMALS: Final[int] = 3

# A starved loop or a jumped clock is caught up to, not skipped past — but bounded, so a
# multi-minute stall enqueues a handful of keep-alives rather than hundreds. Three still
# leaves a 45-second silent phase well above the two heartbeats Req 16.8 requires.
MAX_CATCH_UP_TICKS: Final[int] = 3

# Sentinel: the pump has finished with `source`, for whatever reason.
_SOURCE_EXHAUSTED: Final[object] = object()


def heartbeat_event(ts: float) -> Event:
    """The one and only heartbeat constructor (Req 16.6).

    Exactly `type` and `ts`. Adding a phase, a count or a run id here is what would let
    a client treat a keep-alive as run state, so there is nowhere else to add one.
    """
    return {"type": HEARTBEAT_TYPE, "ts": ts}


def is_terminal_event(event: object) -> bool:
    """Is this the event after which nothing may be emitted (Req 16.3)?

    Only `done`. A terminal `error` is *followed* by `done` (Req 14.10), so stopping on
    the error would swallow the event the client waits for and leave the turn open.
    """
    return isinstance(event, dict) and event.get("type") == TERMINAL_EVENT_TYPE


class _Timestamps:
    """The clock reader that makes Req 16.7 structural.

    `read` is the raw clock, used for scheduling. `emit` is the value that reaches an
    event: rounded, and clamped against the last value emitted so no pair of
    consecutive heartbeats can decrease even under an injected clock that goes
    backwards.
    """

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._last: float | None = None

    def read(self) -> float:
        return float(self._clock())

    def emit(self) -> float:
        ts = round(self.read(), TS_DECIMALS)
        last = self._last
        if last is not None and ts < last:
            logger.warning(
                "the heartbeat clock went backwards (%r < %r); holding the last "
                "timestamp so consecutive heartbeats do not decrease",
                ts,
                last,
            )
            ts = last
        self._last = ts
        return ts


async def merge_with_heartbeat(
    source: AsyncIterator[Event],
    *,
    interval: float = HEARTBEAT_INTERVAL_S,
    clock: Clock = time.monotonic,
    sleep: Sleep = asyncio.sleep,
) -> AsyncIterator[Event]:
    """Yield everything `source` yields, with a `heartbeat` every `interval` seconds.

    The merge is transparent to the pipeline: events pass through unchanged and in
    order, and the terminal `done` stays last. An exception raised by `source` is
    re-raised to the consumer after the queue has drained; an exception raised by the
    ticker is logged and the invocation carries on (Req 16.5).
    """
    if interval <= 0:
        raise ValueError(f"a heartbeat interval must be positive, got {interval!r}")

    queue: asyncio.Queue[object] = asyncio.Queue()
    timestamps = _Timestamps(clock)
    failure: list[BaseException] = []

    # Req 16.1 — the first deadline is measured from *acceptance*, which is here, not
    # from whenever the event loop first gets round to running the ticker. The pump is
    # scheduled first and may advance the clock a long way in its first step (a source
    # that sleeps, or an injected clock that jumps), and a ticker that baselined itself
    # on its own first scheduling would silently forgive all of that elapsed time.
    started_at = timestamps.read()

    async def pump() -> None:
        try:
            async for event in source:
                queue.put_nowait(event)
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # handed on, not swallowed
            failure.append(exc)
        finally:
            queue.put_nowait(_SOURCE_EXHAUSTED)

    pump_task = asyncio.create_task(pump(), name="heartbeat-pump")
    ticker_task = asyncio.create_task(
        _ticker(
            queue,
            interval=interval,
            timestamps=timestamps,
            sleep=sleep,
            started_at=started_at,
        ),
        name="heartbeat-ticker",
    )

    try:
        while True:
            item = await queue.get()
            if item is _SOURCE_EXHAUSTED:
                break
            yield item  # type: ignore[misc]
            if is_terminal_event(item):
                # Req 16.3: stop reading. Whatever the ticker enqueued in the meantime
                # is never yielded, so `done` is the last event of the invocation.
                break
    finally:
        ticker_task.cancel()
        pump_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.gather(ticker_task, pump_task, return_exceptions=True)

    if failure:
        raise failure[0]


async def _ticker(
    queue: asyncio.Queue[object],
    *,
    interval: float,
    timestamps: _Timestamps,
    sleep: Sleep,
    started_at: float,
) -> None:
    """Push a heartbeat onto `queue` every `interval` seconds until cancelled.

    Every iteration reads the clock and acts **before** it yields for fairness. The
    reverse order costs the ticker a scheduling turn it cannot afford: the pump is
    scheduled first, so by the time a ticker that opened with `sleep(0)` looked at the
    clock, the pump may already have advanced time past a due deadline *and* enqueued
    the terminal event — and a heartbeat that lands behind `done` is never forwarded
    (Req 16.3 stops the read there). That is a silently missing keep-alive during
    exactly the silent stretch Req 16.1 exists for, and it also means a broken timer is
    never invoked, so Req 16.5's log line never happens.
    """
    try:
        next_due = started_at + interval
        caught_up = 0
        while True:
            now = timestamps.read()
            if now < next_due:
                await sleep(next_due - now)
                caught_up = 0
            else:
                queue.put_nowait(heartbeat_event(timestamps.emit()))
                next_due += interval
                caught_up += 1
                if caught_up >= MAX_CATCH_UP_TICKS and next_due <= now:
                    # The clock is far past the schedule: a stalled loop, or simulated
                    # time moving in one jump. Resync instead of emitting one keep-alive
                    # per missed interval for the whole stall.
                    next_due = now + interval
                    caught_up = 0

            # Fairness, once per iteration. The injected `sleep` may not yield to the
            # event loop at all — a fake that advances virtual time and returns is
            # perfectly reasonable — and a ticker that never yields starves the pump it
            # is merged with.
            await asyncio.sleep(0)
    except asyncio.CancelledError:
        raise
    except BaseException:  # Req 16.5
        # A heartbeat failure is a transport failure. Log it and stop ticking; the
        # invocation continues to its terminal event, and NO `collection_log` gap is
        # recorded, because nothing here observed anything about a customer resource.
        logger.warning("the heartbeat ticker stopped; the run continues", exc_info=True)


# Contradictions worth catching at import rather than at the first emission.
assert HEARTBEAT_TYPE in EVENT_TYPES, HEARTBEAT_TYPE
assert HEARTBEAT_TYPE in EMITTED_BY_FOUNDATION, HEARTBEAT_TYPE
assert set(heartbeat_event(0.0)) == HEARTBEAT_FIELDS, HEARTBEAT_FIELDS
# Req 16.1 with 16.2: the worst-case interval must stay inside the permitted gap, and
# the first heartbeat must land inside its own deadline.
assert HEARTBEAT_INTERVAL_S + HEARTBEAT_TOLERANCE_S <= FIRST_HEARTBEAT_DEADLINE_S
assert HEARTBEAT_INTERVAL_S + HEARTBEAT_TOLERANCE_S <= MAX_EVENT_GAP_S
# Req 16.2: the largest gap stays below the relay's window by a factor of at least four.
assert RELAY_INACTIVITY_WINDOW_FACTOR >= 4, RELAY_INACTIVITY_WINDOW_FACTOR
assert RELAY_INACTIVITY_WINDOW_S == 120.0, RELAY_INACTIVITY_WINDOW_S
