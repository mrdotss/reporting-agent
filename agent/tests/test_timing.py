"""The heartbeat and the progress throttle, asserted over **one** simulated timeline.

Req 16.8 mandates a test that drives a phase emitting no other event for at least 45
seconds and asserts at least two `heartbeat` events, so that an emitter which never
starts fails the suite rather than a deployed run. This file is that test, and it carries
the two neighbouring stream-level assertions with it — nothing follows `done` (Req 16.3),
and consecutive heartbeat timestamps do not decrease (Req 16.7) — plus Req 16.2's
largest-permitted-gap claim measured over events of *every* type rather than over
heartbeats alone.

The progress throttle (Req 38.15) is asserted here too, and on the **same clock**. That
is the point of the file rather than an economy: the throttle's 5-second window and the
heartbeat's 15-second interval are two cadences a real run runs concurrently, and two
independent fakes would let each one look correct against a timeline the other never
saw. One clock means the 10 progress callbacks and the 3 heartbeats below are counted off
the same 46.5 simulated seconds.

`SimulatedClock` is a small virtual scheduler rather than a counter that jumps when
somebody sleeps on it, and the difference is load-bearing:

* **Time moves only when the driving phase advances it.** A sleeper registers a deadline
  and waits; `advance` wakes whatever is due. So the collector's folds are the motor and
  the heartbeat ticker is an observer, which is the real relationship — a ticker whose
  own `sleep` shoved the clock forward would be measuring a timeline it created.
* **Nothing advances the clock while the terminal callback is in flight**, which is what
  lets `test_the_terminal_callback_is_never_delayed_or_suppressed_by_the_throttle` assert
  the delivery instant *exactly* instead of within a tolerance.

Every test here runs 45+ seconds of simulated time in milliseconds of real time. The
`WATCHDOG_S` bound on each drain is real wall-clock, and it exists so that an
implementation which stops producing fails as an assertion rather than as a hung suite.
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import AsyncIterator
from typing import Any

import pytest

from reporting_agent.events import TERMINAL_EVENT_TYPE
from reporting_agent.heartbeat import (
    FIRST_HEARTBEAT_DEADLINE_S,
    HEARTBEAT_INTERVAL_S,
    HEARTBEAT_TOLERANCE_S,
    HEARTBEAT_TYPE,
    MAX_EVENT_GAP_S,
    merge_with_heartbeat,
)
from reporting_agent.progress import (
    AGENT_PHASES,
    PROGRESS_THROTTLE_S,
    TERMINAL_PHASES,
    TOKEN_HEADER,
    ProgressReporter,
)
from reporting_agent.redaction import discard_secrets

Event = dict[str, Any]
Arrival = tuple[float, Event]

# --- the simulated timeline ----------------------------------------------------------

# Req 16.8 asks for "at least 45 seconds". 46 is driven so the third heartbeat at 45 is
# inside the window rather than exactly on its edge.
SILENT_PHASE_S = 46.0
TICK_S = 1.0

# The collecting phase: one folded batch per simulated second, then the terminal
# callback half a second later — deliberately *inside* the throttle window that the last
# admitted refresh opened, so the terminal exemption is what carries it.
FOLDS = 46
FOLD_S = 1.0
TERMINAL_OFFSET_S = 0.5

# How many event-loop turns `advance` gives the woken tasks to reach their next
# suspension point. The ticker needs three (emit, fairness, re-register); the rest is
# headroom so the count is not a tuning knob.
SETTLE_TURNS = 8

# Real seconds. A healthy drain finishes in milliseconds, so this only ever fires when an
# implementation stopped producing — and then it fails the test instead of hanging it.
WATCHDOG_S = 2.0

RUN_ID = "run_01HZX8QW9K7YB4T2C3M5N6P7QR"
TOKEN = "b7e2d4c6a8f0192837465564738291a0b7e2d4c6a8f01928"
URL = "https://app.example.test/api/internal/runs/" + RUN_ID + "/progress"
SNAPSHOT_ID = "a" * 64

TOOL_START: Event = {
    "type": "tool",
    "phase": "start",
    "id": "s1",
    "name": "collect_metrics",
    "label": "Metrics",
    "status": "Pulling metrics",
}
DONE: Event = {"type": TERMINAL_EVENT_TYPE, "run_id": RUN_ID, "status": "completed"}


@pytest.fixture(autouse=True)
def _clear_secret_registry():
    """Constructing a reporter registers its token as a secret (Req 15.1).

    The registry is a `ContextVar`, so without this the token registered here would keep
    scrubbing later tests' output.
    """
    yield
    discard_secrets()


class SimulatedClock:
    """One timeline shared by the heartbeat ticker and the progress throttle.

    A sleeper registers a deadline and blocks; `advance` moves the clock and wakes
    whatever has come due. Time therefore moves only because the driving phase moved it,
    never as a side effect of somebody waiting.
    """

    def __init__(self, start: float = 0.0) -> None:
        self.now = start
        self.sleeps: list[float] = []
        self._waiters: list[tuple[float, asyncio.Event]] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        if seconds <= 0:
            await asyncio.sleep(0)
            return
        waiter = asyncio.Event()
        self._waiters.append((self.now + seconds, waiter))
        await waiter.wait()

    async def advance(self, seconds: float) -> None:
        self.now += seconds
        due = [waiter for deadline, waiter in self._waiters if deadline <= self.now]
        self._waiters = [
            (deadline, waiter)
            for deadline, waiter in self._waiters
            if deadline > self.now
        ]
        for waiter in due:
            waiter.set()
        await settle()


async def settle() -> None:
    """Let every runnable task reach its next suspension point."""
    for _ in range(SETTLE_TURNS):
        await asyncio.sleep(0)


class RecordingTransport:
    """A `ProgressTransport` that records the **simulated** instant of each request.

    Recording the clock at the moment the request reaches the transport is what makes
    "the terminal callback is not delayed" an assertion about a number rather than about
    the absence of a `sleep` call.
    """

    def __init__(self, clock: SimulatedClock) -> None:
        self._clock = clock
        self.calls: list[dict[str, Any]] = []

    async def post_json(self, url, *, body, headers, timeout) -> int:
        self.calls.append(
            {
                "at": self._clock(),
                "url": url,
                "body": dict(body),
                "headers": dict(headers),
            }
        )
        return 204


# --- sources ------------------------------------------------------------------------


async def silent_until(release: asyncio.Event) -> AsyncIterator[Event]:
    """A phase that says nothing at all until it is finished — Req 16.1's whole reason."""
    await release.wait()
    yield DONE


async def done_then_hang(release: asyncio.Event) -> AsyncIterator[Event]:
    """Yields `done` and then never returns, so the ticker is still live behind it.

    A source that completes right after `done` would let a merge which forgot to stop
    reading pass anyway, on the sentinel its own exhaustion enqueues. Hanging here makes
    Req 16.3's "stop at the terminal event" the only thing that can end the stream.
    """
    await release.wait()
    yield DONE
    await asyncio.Event().wait()


async def drain(
    merged: AsyncIterator[Event], clock: SimulatedClock, out: list[Arrival]
) -> None:
    """Consume the merged stream, recording the simulated instant of every arrival."""
    async for event in merged:
        out.append((clock.now, event))


def heartbeats_of(arrivals: list[Arrival]) -> list[Event]:
    return [event for _, event in arrivals if event["type"] == HEARTBEAT_TYPE]


def assert_heartbeat_cadence(heartbeats: list[Event]) -> None:
    """The claims that hold of any run's heartbeats, wherever they were collected."""
    timestamps = [event["ts"] for event in heartbeats]

    # Req 16.7 — consecutive timestamps do not decrease.
    assert all(
        later >= earlier for earlier, later in itertools.pairwise(timestamps)
    ), f"heartbeat timestamps decreased: {timestamps}"

    # Req 16.1 — the first one lands inside its own deadline, and the interval holds to
    # its stated tolerance.
    assert timestamps[0] <= FIRST_HEARTBEAT_DEADLINE_S, timestamps[0]
    for earlier, later in itertools.pairwise(timestamps):
        assert abs((later - earlier) - HEARTBEAT_INTERVAL_S) <= HEARTBEAT_TOLERANCE_S, (
            f"interval {later - earlier} is outside the stated tolerance"
        )


def assert_no_gap_exceeds_the_maximum(arrivals: list[Arrival]) -> None:
    """Req 16.2 — over events of **every** type, from acceptance to the last event."""
    instants = [instant for instant, _ in arrivals]

    assert instants[0] <= MAX_EVENT_GAP_S, (
        f"the stream said nothing for {instants[0]}s after acceptance"
    )
    for earlier, later in itertools.pairwise(instants):
        assert later - earlier <= MAX_EVENT_GAP_S, (
            f"a {later - earlier}s gap between consecutive events exceeds "
            f"{MAX_EVENT_GAP_S}s"
        )


# --- Req 16.8: a silent phase over 45 simulated seconds ------------------------------


def test_a_phase_silent_for_45_simulated_seconds_still_emits_two_heartbeats() -> None:
    clock = SimulatedClock()

    async def scenario() -> list[Arrival]:
        release = asyncio.Event()
        merged = merge_with_heartbeat(silent_until(release), clock=clock, sleep=clock.sleep)
        arrivals: list[Arrival] = []
        consumer = asyncio.create_task(drain(merged, clock, arrivals))
        # Let the merge be accepted before time moves, so `started_at` is the origin of
        # the timeline the assertions below are stated against.
        await settle()

        while clock.now < SILENT_PHASE_S:
            await clock.advance(TICK_S)

        release.set()
        try:
            await asyncio.wait_for(consumer, timeout=WATCHDOG_S)
        except TimeoutError:  # pragma: no cover - a stalled merge
            consumer.cancel()
            pytest.fail("the merge did not reach `done` after the phase released it")
        return arrivals

    arrivals = asyncio.run(scenario())
    heartbeats = heartbeats_of(arrivals)

    # Req 16.8 — the phase emitted nothing of its own for the whole window, and the
    # stream still carried keep-alives. An emitter that never starts fails here.
    assert clock.now >= 45.0, clock.now
    assert len(heartbeats) >= 2, (
        f"{len(heartbeats)} heartbeat(s) over {clock.now}s of a silent phase; "
        "the emitter never started"
    )
    assert [event["type"] for _, event in arrivals if event["type"] != HEARTBEAT_TYPE] == [
        TERMINAL_EVENT_TYPE
    ]

    assert_heartbeat_cadence(heartbeats)
    assert_no_gap_exceeds_the_maximum(arrivals)

    # The cadence is the declared one, counted off the shared timeline rather than
    # asserted as "some heartbeats happened".
    assert len(heartbeats) == int(clock.now // HEARTBEAT_INTERVAL_S)
    assert [event["ts"] for event in heartbeats] == [15.0, 30.0, 45.0]


# --- Req 16.3: nothing follows `done` -----------------------------------------------


def test_no_heartbeat_follows_done_and_the_stream_is_over() -> None:
    clock = SimulatedClock()

    async def scenario() -> tuple[list[Arrival], int]:
        release = asyncio.Event()
        merged = merge_with_heartbeat(
            done_then_hang(release), clock=clock, sleep=clock.sleep
        )
        arrivals: list[Arrival] = []
        consumer = asyncio.create_task(drain(merged, clock, arrivals))
        await settle()

        while clock.now < SILENT_PHASE_S:
            await clock.advance(TICK_S)

        release.set()
        try:
            await asyncio.wait_for(consumer, timeout=WATCHDOG_S)
        except TimeoutError:  # pragma: no cover - a merge that kept reading past `done`
            consumer.cancel()
            pytest.fail(
                "the merge kept reading after `done`; the terminal event must end the "
                "invocation (Req 16.3)"
            )

        at_terminal = len(arrivals)
        # A further minute of simulated time, with the stream already terminal.
        for _ in range(60):
            await clock.advance(TICK_S)
        with pytest.raises(StopAsyncIteration):
            await anext(merged)  # type: ignore[arg-type]
        return arrivals, at_terminal

    arrivals, at_terminal = asyncio.run(scenario())
    types = [event["type"] for _, event in arrivals]

    # Req 16.3 — `done` is the last event, exactly once, and 60 further simulated
    # seconds add nothing behind it.
    assert types[-1] == TERMINAL_EVENT_TYPE
    assert types.count(TERMINAL_EVENT_TYPE) == 1
    assert len(arrivals) == at_terminal
    assert HEARTBEAT_TYPE not in types[types.index(TERMINAL_EVENT_TYPE) :]

    # And it got there the hard way: the ticker was live and due throughout.
    heartbeats = heartbeats_of(arrivals)
    assert len(heartbeats) >= 2, len(heartbeats)
    assert_heartbeat_cadence(heartbeats)


# --- Req 38.15 on the same clock ----------------------------------------------------


def _collecting_run(
    clock: SimulatedClock, target: ProgressReporter
) -> AsyncIterator[Event]:
    """A collecting phase folding one batch per simulated second, then completing."""

    async def phase() -> AsyncIterator[Event]:
        yield TOOL_START
        # Entering the phase. A transition, and the only non-terminal one the agent may
        # present (asserted below), so it must be sent at the instant it occurs.
        await target.report("collecting", current=0, total=FOLDS, label="Metrics")
        for fold in range(1, FOLDS + 1):
            await clock.advance(FOLD_S)
            # One `report` per folded batch — the traffic Req 38.15 exists to bound.
            await target.report("collecting", current=fold, total=FOLDS)
        await clock.advance(TERMINAL_OFFSET_S)
        await target.report_terminal(
            "completed", snapshot_id=SNAPSHOT_ID, resource_count=FOLDS, gap_count=0
        )
        yield DONE

    return phase()


def _run_collecting_phase() -> tuple[SimulatedClock, RecordingTransport, list[Arrival]]:
    clock = SimulatedClock()
    transport = RecordingTransport(clock)
    target = ProgressReporter(
        progress_url=URL,
        progress_token=TOKEN,
        run_id=RUN_ID,
        transport=transport,
        clock=clock,
    )

    async def scenario() -> list[Arrival]:
        merged = merge_with_heartbeat(
            _collecting_run(clock, target), clock=clock, sleep=clock.sleep
        )
        arrivals: list[Arrival] = []
        await asyncio.wait_for(drain(merged, clock, arrivals), timeout=WATCHDOG_S)
        return arrivals

    return clock, transport, asyncio.run(scenario())


def test_the_throttle_admits_at_most_one_progress_callback_per_five_seconds() -> None:
    clock, transport, _ = _run_collecting_phase()

    in_phase = [call for call in transport.calls if call["body"]["phase"] == "collecting"]
    # One fold per simulated second, so a fold's `current` *is* its decision instant.
    decided_at = [call["body"]["current"] for call in in_phase]

    assert len(in_phase) >= 2, "the throttle suppressed the phase entirely"
    assert len(in_phase) < FOLDS, (
        f"{len(in_phase)} requests for {FOLDS} folded batches; the throttle admitted "
        "one request per fold"
    )
    # Req 38.15 — at most one per 5 seconds for this phase.
    for earlier, later in itertools.pairwise(decided_at):
        assert later - earlier >= PROGRESS_THROTTLE_S, (
            f"two in-phase callbacks {later - earlier}s apart, inside the "
            f"{PROGRESS_THROTTLE_S}s window"
        )
    assert len(in_phase) <= int(clock.now / PROGRESS_THROTTLE_S) + 1

    # The whole timeline, stated exactly: the transition at 0, then every fifth second.
    assert decided_at == [0, *range(5, FOLDS, 5)]


def test_the_phase_transition_is_sent_at_the_instant_it_occurs() -> None:
    _, transport, _ = _run_collecting_phase()

    # `collecting` is the only non-terminal phase the agent may present, so entering it
    # is the only non-terminal transition there is to exempt — and the terminal callback
    # below covers the other half of Req 38.15's two positive guards.
    assert AGENT_PHASES - TERMINAL_PHASES == {"collecting"}

    first = transport.calls[0]
    assert first["body"]["phase"] == "collecting"
    assert first["body"]["current"] == 0, (
        "the entry into the phase was withheld and a later refresh took its place"
    )
    assert first["at"] <= FOLD_S


def test_the_terminal_callback_is_never_delayed_or_suppressed_by_the_throttle() -> None:
    clock, transport, _ = _run_collecting_phase()

    terminal = [call for call in transport.calls if call["body"]["phase"] in TERMINAL_PHASES]
    in_phase = [call for call in transport.calls if call["body"]["phase"] == "collecting"]

    assert len(terminal) == 1, "the terminal callback was suppressed by the throttle"
    assert transport.calls[-1] is terminal[0]
    assert terminal[0]["body"]["snapshot_id"] == SNAPSHOT_ID

    # It was offered *inside* the window the last admitted refresh opened, which is what
    # makes the exemption load-bearing rather than incidental.
    last_admitted = in_phase[-1]["body"]["current"]
    assert clock.now - last_admitted < PROGRESS_THROTTLE_S

    # And it arrived at the instant it was offered: no simulated time passed between the
    # call and the request, so the limit delayed it by nothing.
    assert terminal[0]["at"] == clock.now == FOLDS * FOLD_S + TERMINAL_OFFSET_S


def test_the_two_cadences_are_counted_off_one_shared_timeline() -> None:
    clock, transport, arrivals = _run_collecting_phase()
    heartbeats = heartbeats_of(arrivals)
    in_phase = [call for call in transport.calls if call["body"]["phase"] == "collecting"]

    elapsed = FOLDS * FOLD_S + TERMINAL_OFFSET_S
    assert clock.now == elapsed

    # The heartbeat ran on the same seconds the throttle was measured against, and the
    # 5-second window therefore admits strictly more callbacks than the 15-second
    # interval produced keep-alives.
    assert len(heartbeats) == int(elapsed // HEARTBEAT_INTERVAL_S) == 3
    assert len(in_phase) > len(heartbeats)
    assert [event["ts"] for event in heartbeats] == [15.0, 30.0, 45.0]

    assert_heartbeat_cadence(heartbeats)
    assert_no_gap_exceeds_the_maximum(arrivals)
    assert arrivals[-1][1]["type"] == TERMINAL_EVENT_TYPE

    # Req 15.7 / 38.2 hold for every request on this timeline, not just the first.
    for call in transport.calls:
        assert call["headers"][TOKEN_HEADER] == TOKEN
        assert TOKEN not in str(call["url"])
        assert TOKEN not in str(call["body"])
