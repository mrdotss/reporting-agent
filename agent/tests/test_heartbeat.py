"""Unit tests for the heartbeat merge — the module's own behaviour.

The stream-level assertions over simulated time (a silent phase of at least 45 seconds
producing two or more heartbeats, non-decreasing timestamps across a whole invocation,
and the progress throttle) belong to the dedicated timing test, not here. What this file
covers is the merge itself: what it forwards, what it refuses to forward, what it
rejects, and what it does when either half of it fails.

`VirtualClock` below moves only when something sleeps on it, which is the whole point of
injecting `clock` and `sleep`: a test that needs 15 seconds to pass takes microseconds,
and the interleaving is deterministic rather than dependent on a real timer.
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import AsyncIterator
from typing import Any

import pytest

from reporting_agent.events import (
    EMITTED_BY_FOUNDATION,
    EVENT_TYPES,
    TERMINAL_EVENT_TYPE,
)
from reporting_agent.heartbeat import (
    FIRST_HEARTBEAT_DEADLINE_S,
    HEARTBEAT_FIELDS,
    HEARTBEAT_INTERVAL_S,
    HEARTBEAT_TOLERANCE_S,
    HEARTBEAT_TYPE,
    MAX_EVENT_GAP_S,
    RELAY_INACTIVITY_WINDOW_FACTOR,
    RELAY_INACTIVITY_WINDOW_S,
    _Timestamps,
    heartbeat_event,
    is_terminal_event,
    merge_with_heartbeat,
)

Event = dict[str, Any]

TOOL_START: Event = {
    "type": "tool",
    "phase": "start",
    "id": "s1",
    "name": "collect_inventory",
    "label": "Inventory",
    "status": "Enumerating resources",
}
PROGRESS: Event = {"type": "progress", "id": "s1", "done": 142, "total": 200}
TOOL_END: Event = {
    "type": "tool",
    "phase": "end",
    "id": "s1",
    "name": "collect_inventory",
}
DONE: Event = {"type": TERMINAL_EVENT_TYPE, "run_id": "run_01HQ", "status": "completed"}


class VirtualClock:
    """A clock that advances only when something sleeps on it."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += max(0.0, seconds)
        await asyncio.sleep(0)


async def never(seconds: float) -> None:
    """A sleep that never returns, so the ticker never fires."""
    await asyncio.Event().wait()


async def explode(seconds: float) -> None:
    """A sleep that raises, standing in for a broken timer."""
    raise RuntimeError("the timer is broken")


async def yielding(*events: Event) -> AsyncIterator[Event]:
    for event in events:
        yield event


async def silent() -> AsyncIterator[Event]:
    """A phase that emits nothing at all — the case Req 16.1 exists for."""
    await asyncio.Event().wait()
    yield DONE


async def raising(*events: Event, exc: BaseException) -> AsyncIterator[Event]:
    for event in events:
        yield event
    raise exc


async def collect(source: AsyncIterator[Event], **kwargs: Any) -> list[Event]:
    return [event async for event in merge_with_heartbeat(source, **kwargs)]


# --- the declared numbers -----------------------------------------------------------


def test_the_interval_and_the_gap_are_the_declared_numbers() -> None:
    # Req 16.1 / 16.2. These are the contract, not tuning knobs.
    assert HEARTBEAT_INTERVAL_S == 15.0
    assert HEARTBEAT_TOLERANCE_S == 5.0
    assert MAX_EVENT_GAP_S == 30.0
    assert HEARTBEAT_INTERVAL_S + HEARTBEAT_TOLERANCE_S <= FIRST_HEARTBEAT_DEADLINE_S
    assert HEARTBEAT_INTERVAL_S + HEARTBEAT_TOLERANCE_S <= MAX_EVENT_GAP_S


def test_the_relay_inactivity_window_derives_from_the_one_gap_constant() -> None:
    # Req 16.2: the relay's window and the runtime's largest permitted gap cannot drift
    # to different numbers if only one of the two is written down as a number.
    assert RELAY_INACTIVITY_WINDOW_FACTOR >= 4
    assert RELAY_INACTIVITY_WINDOW_S == MAX_EVENT_GAP_S * RELAY_INACTIVITY_WINDOW_FACTOR
    assert RELAY_INACTIVITY_WINDOW_S == 120.0


# --- the event shape ----------------------------------------------------------------


def test_a_heartbeat_carries_only_a_timestamp() -> None:
    event = heartbeat_event(1234.567)

    # Req 16.6: no phase label, no resource count, no run id — nothing a client could
    # mistake for run state.
    assert event == {"type": HEARTBEAT_TYPE, "ts": 1234.567}
    assert set(event) == HEARTBEAT_FIELDS == {"type", "ts"}


def test_the_heartbeat_type_is_one_the_foundation_declares_and_emits() -> None:
    assert HEARTBEAT_TYPE == "heartbeat"
    assert HEARTBEAT_TYPE in EVENT_TYPES
    assert HEARTBEAT_TYPE in EMITTED_BY_FOUNDATION


def test_only_done_is_treated_as_the_terminal_event() -> None:
    assert is_terminal_event(DONE) is True

    # A terminal `error` is followed by `done`, so stopping on the error would swallow
    # the event that ends the turn.
    terminal_error: Event = {"type": "error", "code": "EMPTY_SCOPE", "terminal": True}
    assert is_terminal_event(terminal_error) is False
    assert is_terminal_event(heartbeat_event(0.0)) is False
    assert is_terminal_event(TOOL_START) is False
    assert is_terminal_event("done") is False
    assert is_terminal_event(None) is False


# --- pass-through -------------------------------------------------------------------


def test_the_merge_forwards_every_event_unchanged_and_in_order() -> None:
    source = [TOOL_START, PROGRESS, TOOL_END, DONE]

    forwarded = asyncio.run(collect(yielding(*source), sleep=never))

    assert forwarded == source
    assert all(event["type"] != HEARTBEAT_TYPE for event in forwarded)


def test_the_merge_mutates_no_forwarded_event() -> None:
    original = dict(TOOL_START)

    forwarded = asyncio.run(collect(yielding(TOOL_START, DONE), sleep=never))

    assert forwarded[0] is TOOL_START
    assert TOOL_START == original


def test_an_empty_source_yields_nothing() -> None:
    assert asyncio.run(collect(yielding(), sleep=never)) == []


def test_a_non_positive_interval_is_rejected() -> None:
    async def run(interval: float) -> None:
        await collect(yielding(DONE), interval=interval, sleep=never)

    for interval in (0.0, -1.0):
        with pytest.raises(ValueError, match="positive"):
            asyncio.run(run(interval))


# --- the first heartbeat (Req 16.1) -------------------------------------------------


def test_the_first_heartbeat_arrives_without_any_source_event() -> None:
    clock = VirtualClock()

    async def run() -> Event:
        merged = merge_with_heartbeat(silent(), clock=clock, sleep=clock.sleep)
        try:
            return await anext(merged)
        finally:
            await merged.aclose()

    first = asyncio.run(run())

    # The phase has emitted nothing and never will, yet the stream is alive: the
    # ticker's first deadline is set at acceptance, not at the first phase transition.
    assert first == {"type": HEARTBEAT_TYPE, "ts": HEARTBEAT_INTERVAL_S}
    assert first["ts"] <= FIRST_HEARTBEAT_DEADLINE_S
    assert clock.slept == [HEARTBEAT_INTERVAL_S]


def test_the_first_deadline_is_measured_from_the_clock_the_merge_started_on() -> None:
    clock = VirtualClock(start=9_000.0)

    async def run() -> Event:
        merged = merge_with_heartbeat(silent(), clock=clock, sleep=clock.sleep)
        try:
            return await anext(merged)
        finally:
            await merged.aclose()

    first = asyncio.run(run())

    assert first["ts"] - 9_000.0 == HEARTBEAT_INTERVAL_S


# --- the terminal event (Req 16.3) --------------------------------------------------


def test_nothing_the_source_yields_after_done_is_forwarded() -> None:
    trailing: Event = {"type": "progress", "id": "s1", "done": 200, "total": 200}

    forwarded = asyncio.run(collect(yielding(TOOL_START, DONE, trailing), sleep=never))

    assert forwarded == [TOOL_START, DONE]


def test_no_heartbeat_follows_done_even_when_one_was_already_queued() -> None:
    clock = VirtualClock()

    async def source() -> AsyncIterator[Event]:
        yield TOOL_START
        # Long enough for several ticks to land in the queue behind this event.
        await clock.sleep(HEARTBEAT_INTERVAL_S * 3)
        yield DONE

    forwarded = asyncio.run(collect(source(), clock=clock, sleep=clock.sleep))

    # Req 16.3: heartbeats queued during the silent stretch are forwarded, but `done`
    # is last and nothing follows it.
    assert forwarded[0] == TOOL_START
    assert forwarded[-1] == DONE
    assert any(event["type"] == HEARTBEAT_TYPE for event in forwarded[1:-1])
    assert [event["type"] for event in forwarded].count(TERMINAL_EVENT_TYPE) == 1


def test_the_ticker_and_the_pump_are_cancelled_once_done_is_forwarded() -> None:
    async def run() -> set[str]:
        before = {task.get_name() for task in asyncio.all_tasks()}
        await collect(yielding(DONE), sleep=never)
        await asyncio.sleep(0)
        return {task.get_name() for task in asyncio.all_tasks()} - before

    # No leaked pump or ticker task outlives the invocation.
    assert asyncio.run(run()) == set()


def test_a_consumer_that_stops_early_leaves_no_task_running() -> None:
    clock = VirtualClock()

    async def run() -> set[str]:
        before = {task.get_name() for task in asyncio.all_tasks()}
        merged = merge_with_heartbeat(silent(), clock=clock, sleep=clock.sleep)
        await anext(merged)
        await merged.aclose()
        await asyncio.sleep(0)
        return {task.get_name() for task in asyncio.all_tasks()} - before

    assert asyncio.run(run()) == set()


# --- timestamps never decrease (Req 16.7) -------------------------------------------


def test_a_clock_that_runs_backwards_cannot_produce_a_decreasing_pair() -> None:
    readings = iter([100.0, 40.0, 250.0])
    timestamps = _Timestamps(lambda: next(readings))

    emitted = [timestamps.emit() for _ in range(3)]

    # Req 16.7 is structural: the emitter clamps, so it does not rely on the injected
    # clock being monotonic to keep its own promise.
    assert emitted == [100.0, 100.0, 250.0]
    assert all(b >= a for a, b in itertools.pairwise(emitted))


def test_a_backwards_clock_is_logged_rather_than_hidden(
    caplog: pytest.LogCaptureFixture,
) -> None:
    readings = iter([100.0, 40.0])
    timestamps = _Timestamps(lambda: next(readings))

    with caplog.at_level("WARNING"):
        timestamps.emit()
        timestamps.emit()

    assert "backwards" in caplog.text


def test_an_emitted_timestamp_is_rounded_to_milliseconds() -> None:
    timestamps = _Timestamps(lambda: 12.3456789)

    assert timestamps.emit() == 12.346


# --- a failing ticker (Req 16.5) ----------------------------------------------------


def test_a_raising_ticker_is_logged_and_the_run_reaches_its_terminal_event(
    caplog: pytest.LogCaptureFixture,
) -> None:
    source = [TOOL_START, PROGRESS, TOOL_END, DONE]

    with caplog.at_level("WARNING"):
        forwarded = asyncio.run(collect(yielding(*source), sleep=explode))

    # Req 16.5: the invocation continues to its terminal event, the failure is a log
    # line, and nothing about the stream changes.
    assert forwarded == source
    assert "heartbeat ticker stopped" in caplog.text


def test_a_raising_ticker_produces_no_gap_bearing_and_no_error_event() -> None:
    forwarded = asyncio.run(collect(yielding(TOOL_START, DONE), sleep=explode))

    # Req 16.5: a heartbeat failure is not a collection gap. The merge emits no `error`
    # event and injects nothing carrying a gap — it only ever forwards or heartbeats.
    assert [event["type"] for event in forwarded] == ["tool", TERMINAL_EVENT_TYPE]
    assert all("gap" not in key for event in forwarded for key in event)
    assert all("gaps" not in event for event in forwarded)


def test_a_ticker_that_stops_early_does_not_stop_the_invocation() -> None:
    ticks = {"n": 0}

    async def sleep_then_stop(seconds: float) -> None:
        ticks["n"] += 1
        if ticks["n"] > 1:
            raise RuntimeError("the timer died mid-run")
        await asyncio.sleep(0)

    forwarded = asyncio.run(collect(yielding(TOOL_START, DONE), sleep=sleep_then_stop))

    assert forwarded[-1] == DONE


# --- a failing source ---------------------------------------------------------------


def test_an_exception_from_the_source_reaches_the_consumer() -> None:
    boom = RuntimeError("the collector fell over")

    async def run() -> list[Event]:
        return await collect(raising(TOOL_START, exc=boom), sleep=never)

    with pytest.raises(RuntimeError, match="fell over"):
        asyncio.run(run())


def test_events_yielded_before_the_source_raised_are_still_forwarded() -> None:
    forwarded: list[Event] = []

    async def run() -> None:
        source = raising(TOOL_START, PROGRESS, exc=RuntimeError("boom"))
        async for event in merge_with_heartbeat(source, sleep=never):
            forwarded.append(event)

    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(run())

    assert forwarded == [TOOL_START, PROGRESS]
