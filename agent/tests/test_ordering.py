"""The order of events on the wire from the entrypoint — Req 14.4, 14.8, 14.9, 14.10,
14.13, 14.14.

`test_main.py` owns the pieces: routing, the session-id chain, the single egress and the
`StepTracker` invariants asserted in isolation. This file owns the **sequence** those
pieces produce, and it asserts it by driving `run_invocation` and `main.invoke` end to
end rather than by re-testing the tracker:

* `snapshot_ready` appears exactly once and before `done` (Req 14.9);
* `done` is the last event on **every** path — clean completion, a raised `AgentError`,
  an unfilled command seam, an orphan `progress`, a refused payload and an exception
  nobody anticipated — and nothing follows it, including through the heartbeat merge the
  entrypoint actually composes (Req 14.10, with 16.3);
* a `tool` step left open by a phase that raised is closed **before** `done`, innermost
  first (Req 14.14);
* a `progress` event naming an unknown, closed or regressing step never reaches the wire
  (Req 14.8);
* an unrecognised command, and a payload carrying no command at all, produce exactly
  `error` then `done` and nothing else (Req 14.4, 14.13).

**Why "rejected" means the run fails rather than the event being dropped.** Req 14.8 is
stated as a positive obligation — the runtime *shall* set `progress.id` to the id of a
step it opened and has not closed, and *shall* keep successive `done` values
non-decreasing — and neither it nor the design offers a lenient path for an event that
breaks it. The design puts the invariant in a `StepTracker` precisely "so a caller cannot
emit an orphan or a regression". So the implementation's choice is asserted here as
intended behaviour: the offending event never reaches the wire, and the invocation ends
as a terminal `INTERNAL_ERROR` followed by `done`. A silent drop would leave a
determinate bar frozen at a stale count on a run reported as successful, which is the
kind of plausible-looking stream that ships.

Req 14.9's *duplicate* `snapshot_ready` is the deliberate contrast and is asserted as
such: the snapshot is already written by then, so a second event is cosmetic and dropping
it satisfies "exactly one" without failing a run that succeeded.

`main` reads its configuration at import (Req 14.12), so the two required variables are
set before the import below — the same contract the container satisfies with its
environment.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from reporting_agent import main  # imported after the environment above, deliberately
from reporting_agent.errors import (
    EmptyScopeError,
    ErrorCode,
    PartialCoverageError,
)
from reporting_agent.events import (
    HEARTBEAT_EVENT_TYPE,
    TERMINAL_EVENT_TYPE,
)
from reporting_agent.heartbeat import merge_with_heartbeat
from reporting_agent.main import (
    CODE_COMMAND_UNIMPLEMENTED,
    CODE_INTERNAL_ERROR,
    CODE_INVALID_ACTOR,
    CODE_MISSING_COMMAND,
    CODE_UNSUPPORTED_COMMAND,
    COMMAND_GENERATE_REPORT,
    STATUS_COMPLETED,
    STATUS_FAILED,
    TOOL_COLLECT_INVENTORY,
    TOOL_COLLECT_METRICS,
    Invocation,
    StepTracker,
    derive_session_id,
    emit,
    parse_invocation,
    run_invocation,
)
from reporting_agent.progress import ProgressReporter
from reporting_agent.redaction import discard_secrets

Event = dict[str, Any]
Handler = Callable[[Invocation, StepTracker], AsyncIterator[Event]]

ACTOR = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID = "run_01HZX8QW9K7YB4T2C3M5N6P7QR"
PROGRESS_TOKEN = "b7e2d4c6a8f0192837465564738291a0b7e2d4c6a8f01928"
SNAPSHOT_ID = "9f2c1d" + "0" * 58

# Real seconds. A healthy drain finishes in milliseconds, so this only ever fires when the
# router stopped producing — and then it fails the test instead of hanging the suite.
WATCHDOG_S = 2.0


@pytest.fixture(autouse=True)
def _clear_secret_registry():
    """Parsing a context registers its secrets in a `ContextVar` (Req 15.1, 15.10), so a
    test must not leave the registry scrubbing the next test's output."""
    yield
    discard_secrets()


# --------------------------------------------------------------------------- #
# Helpers — the same idiom as `test_main.py`
# --------------------------------------------------------------------------- #


class _Absent:
    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<absent>"


_ABSENT = _Absent()


def payload(
    command: object = COMMAND_GENERATE_REPORT,
    *,
    actor_id: object = ACTOR,
    include_command: bool = True,
    **context: Any,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "period": {"start": "2026-07-01", "end": "2026-07-31"},
        "context": {"subscription_id": "3f2b0000-0000-0000-0000-000000000000", **context},
    }
    if include_command:
        body["command"] = command
    if actor_id is not _ABSENT:
        body["context"]["actor_id"] = actor_id
    return body


def drain(stream: AsyncIterator[Event]) -> list[Event]:
    """Consume an async event stream to exhaustion, under a real-time watchdog."""

    async def go() -> list[Event]:
        collected: list[Event] = []
        async for event in stream:
            collected.append(event)
        return collected

    return asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))


def types_of(events: list[Event]) -> list[str]:
    return [event["type"] for event in events]


def one(events: list[Event], kind: str) -> Event:
    matches = [event for event in events if event["type"] == kind]
    assert len(matches) == 1, f"expected exactly one {kind}, got {types_of(events)}"
    return matches[0]


class RecordingTransport:
    """A `ProgressTransport` that records the callback bodies it was handed."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post_json(self, url, *, body, headers, timeout) -> int:
        self.calls.append({"url": url, "body": dict(body), "headers": dict(headers)})
        return 204


def invocation_for(
    command: str | None = COMMAND_GENERATE_REPORT,
    *,
    run_id: str | None = RUN_ID,
    transport: RecordingTransport | None = None,
    context: Mapping[str, Any] | None = None,
) -> Invocation:
    """An `Invocation` built directly, with the progress transport faked.

    `parse_invocation` builds a reporter over real HTTP, so a router test that wants a run
    row behind the invocation constructs it here instead.
    """
    reporter = ProgressReporter(
        progress_url=f"https://app.example.test/api/internal/runs/{run_id}/progress",
        progress_token=PROGRESS_TOKEN,
        run_id=run_id,
        transport=transport if transport is not None else RecordingTransport(),
    )
    return Invocation(
        command=command,
        actor_id=ACTOR,
        session_id=derive_session_id(ACTOR),
        run_id=run_id,
        payload={"command": command},
        context=dict(context or {}),
        progress=reporter,
    )


def snapshot_ready(**overrides: Any) -> Event:
    """A `snapshot_ready` carrying the five fields Req 14.9 declares."""
    return {
        "type": "snapshot_ready",
        "snapshot_id": SNAPSHOT_ID,
        "resource_count": 200,
        "window": {"start": "2026-07-01T00:00:00+07:00", "end": "2026-08-01T00:00:00+07:00"},
        "grain": "PT1H",
        "gaps": [],
    } | overrides


def index_of(events: list[Event], kind: str) -> int:
    return types_of(events).index(kind)


def assert_done_is_last(events: list[Event]) -> Event:
    """Req 14.10 — one `done`, last, and every event before it clears the egress.

    Running each event through `emit` is what makes this an assertion about the wire
    rather than about the router's internal list: a sequence containing something `emit`
    would refuse never reached a client in that order.
    """
    types = types_of(events)
    assert types, "the invocation produced no events at all"
    assert types[-1] == TERMINAL_EVENT_TYPE, f"`done` was not last: {types}"
    assert types.count(TERMINAL_EVENT_TYPE) == 1, f"more than one `done`: {types}"
    for event in events:
        assert emit(event) == event, event
    return events[-1]


def assert_no_open_steps_survive_done(events: list[Event]) -> None:
    """Req 14.14 — every `tool` `start` has its matching `end`, and every `end` precedes
    `done`."""
    done_at = index_of(events, TERMINAL_EVENT_TYPE)
    opened: list[str] = []
    closed: list[str] = []
    names: dict[str, str] = {}

    for position, event in enumerate(events):
        if event["type"] != "tool":
            continue
        assert position < done_at, f"a `tool` event followed `done`: {types_of(events)}"
        if event["phase"] == "start":
            opened.append(event["id"])
            names[event["id"]] = event["name"]
        else:
            closed.append(event["id"])
            # Req 14.7 — the pair repeats the same id and the same name.
            assert event["name"] == names.get(event["id"]), event

    assert sorted(closed) == sorted(opened), (
        f"opened {opened} but closed {closed}; a step left open spins on the timeline "
        "forever, which is indistinguishable from a run still working"
    )


# --------------------------------------------------------------------------- #
# Handler seams — the phases the router is driven over
# --------------------------------------------------------------------------- #


async def _clean_run(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
    """A phase that opens a step, reports progress, writes a snapshot and closes up."""
    started = steps.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="Enumerating")
    yield started
    yield steps.progress(started["id"], done=200, total=200, unit="resources")
    yield steps.end(started["id"])
    yield snapshot_ready()


async def _raises_agent_error(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    yield steps.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="Enumerating")
    raise EmptyScopeError("The requested scope resolved to zero resources.")


async def _raises_unexpected(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    yield steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="Pulling metrics")
    raise ZeroDivisionError("a bug nobody anticipated")


async def _raises_non_terminal(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    yield steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="Pulling metrics")
    raise PartialCoverageError("3 resources were not fully readable.")


async def _orphan_progress(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    """A `progress` event naming a step this invocation never opened (Req 14.8)."""
    yield steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="Pulling metrics")
    yield steps.progress("collect_metrics-99", done=1, total=200, unit="resources")


async def _progress_after_close(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    """A `progress` event arriving after its step collapsed (Req 14.8)."""
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="Pulling metrics")
    yield started
    yield steps.progress(started["id"], done=100, total=200, unit="resources")
    yield steps.end(started["id"])
    yield steps.progress(started["id"], done=200, total=200, unit="resources")


async def _regressing_progress(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    """A determinate bar running backwards (Req 14.8)."""
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="Pulling metrics")
    yield started
    yield steps.progress(started["id"], done=100, total=200, unit="resources")
    yield steps.progress(started["id"], done=99, total=200, unit="resources")


async def _leaves_two_steps_open(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    yield steps.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="Enumerating")
    yield steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="Pulling metrics")
    raise EmptyScopeError("zero resources")


async def _returns_with_a_step_open(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    """A phase that finished successfully but forgot to close its own step."""
    yield steps.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="Enumerating")
    yield snapshot_ready()


# --------------------------------------------------------------------------- #
# Req 14.9 — exactly one `snapshot_ready`, before `done`
# --------------------------------------------------------------------------- #


def test_snapshot_ready_precedes_done() -> None:
    """Req 14.9 — collection is immutable by the time the client sees it, and the client
    learns that before the turn ends rather than after."""
    transport = RecordingTransport()

    events = drain(
        run_invocation(
            invocation_for(transport=transport),
            handlers={COMMAND_GENERATE_REPORT: _clean_run},
        )
    )

    assert types_of(events) == ["tool", "progress", "tool", "snapshot_ready", "done"]
    assert index_of(events, "snapshot_ready") < index_of(events, TERMINAL_EVENT_TYPE)
    assert assert_done_is_last(events)["status"] == STATUS_COMPLETED
    assert one(events, "snapshot_ready")["snapshot_id"] == SNAPSHOT_ID
    assert_no_open_steps_survive_done(events)

    # The terminal callback is not an event: it does not land in the stream behind `done`.
    assert len(transport.calls) == 1
    assert transport.calls[0]["body"]["phase"] == STATUS_COMPLETED


def test_a_second_snapshot_ready_is_dropped_and_the_first_still_precedes_done(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Req 14.9 — exactly one per invocation.

    The contrast with Req 14.8 below is deliberate. The snapshot is already written by the
    time a duplicate arrives, so the second event is cosmetic: dropping it satisfies
    "exactly one" without failing a run that actually succeeded. An orphan `progress`
    event, by contrast, is a caller bug about state the client is being shown.
    """
    caplog.set_level(logging.WARNING)

    async def twice(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
        yield snapshot_ready()
        yield snapshot_ready(snapshot_id="b" * 64)

    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_GENERATE_REPORT: twice},
        )
    )

    assert types_of(events) == ["snapshot_ready", TERMINAL_EVENT_TYPE]
    assert one(events, "snapshot_ready")["snapshot_id"] == SNAPSHOT_ID
    assert assert_done_is_last(events)["status"] == STATUS_COMPLETED
    assert "snapshot_ready" in caplog.text


def test_a_failed_run_emits_no_snapshot_ready_at_all() -> None:
    """`snapshot_ready` says a snapshot exists. A run that raised before writing one must
    not claim otherwise, and `done` still ends the turn."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_GENERATE_REPORT: _raises_agent_error},
        )
    )

    assert "snapshot_ready" not in types_of(events)
    assert assert_done_is_last(events)["status"] == STATUS_FAILED


# --------------------------------------------------------------------------- #
# Req 14.10 — `done` last on every path
# --------------------------------------------------------------------------- #

# (label, payload-or-invocation factory, handler table, expected tail)
PATHS: list[tuple[str, Callable[[], Invocation], dict[str, Handler] | None, list[str]]] = [
    (
        "clean completion",
        lambda: parse_invocation(payload()),
        {COMMAND_GENERATE_REPORT: _clean_run},
        ["snapshot_ready", TERMINAL_EVENT_TYPE],
    ),
    (
        "a terminal AgentError",
        lambda: parse_invocation(payload()),
        {COMMAND_GENERATE_REPORT: _raises_agent_error},
        ["error", "tool", TERMINAL_EVENT_TYPE],
    ),
    (
        "a non-terminal AgentError",
        lambda: parse_invocation(payload()),
        {COMMAND_GENERATE_REPORT: _raises_non_terminal},
        ["error", "tool", TERMINAL_EVENT_TYPE],
    ),
    (
        "an unfilled command seam",
        lambda: parse_invocation(payload(COMMAND_GENERATE_REPORT)),
        None,
        ["error", TERMINAL_EVENT_TYPE],
    ),
    (
        "an orphan progress event",
        lambda: parse_invocation(payload()),
        {COMMAND_GENERATE_REPORT: _orphan_progress},
        ["error", "tool", TERMINAL_EVENT_TYPE],
    ),
    (
        "an unexpected exception",
        lambda: parse_invocation(payload()),
        {COMMAND_GENERATE_REPORT: _raises_unexpected},
        ["error", "tool", TERMINAL_EVENT_TYPE],
    ),
    (
        "an unrecognised command",
        lambda: parse_invocation(payload("compare_runs")),
        None,
        ["error", TERMINAL_EVENT_TYPE],
    ),
    (
        "no command at all",
        lambda: parse_invocation(payload(include_command=False)),
        None,
        ["error", TERMINAL_EVENT_TYPE],
    ),
    (
        "a blank actor id",
        lambda: parse_invocation(payload(actor_id="   ")),
        None,
        ["error", TERMINAL_EVENT_TYPE],
    ),
]


@pytest.mark.parametrize(
    ("build", "handlers", "tail"),
    [pytest.param(build, handlers, tail, id=label) for label, build, handlers, tail in PATHS],
)
def test_done_is_the_final_event_on_every_path(
    build: Callable[[], Invocation],
    handlers: dict[str, Handler] | None,
    tail: list[str],
) -> None:
    """Req 14.10 — nine paths, one terminal event, always last.

    The client ends its turn on `done`. A path that ends without one leaves a spinner
    running on a run that is over; a path that emits something after one leaves the client
    holding an event it has already stopped reading for.
    """
    events = drain(run_invocation(build(), handlers=handlers))

    assert types_of(events)[-len(tail) :] == tail, types_of(events)
    assert_done_is_last(events)
    assert_no_open_steps_survive_done(events)


def test_the_entrypoint_ends_with_done_through_the_heartbeat_merge() -> None:
    """Req 14.10 with 16.3 — and through the composition the entrypoint actually runs.

    The clock jumps a whole interval on every read, so the ticker is due on every turn
    and keep-alives are queued **while** the phase is still working. `done` still lands
    last, and the heartbeats the ticker enqueued behind it are never yielded: the merge
    stops reading at the terminal event rather than filtering what follows it.
    """
    interval = 1.0

    class RunawayClock:
        """A clock that advances a full interval on every read."""

        def __init__(self) -> None:
            self.now = 0.0

        def __call__(self) -> float:
            self.now += interval
            return self.now

    async def immediately(seconds: float) -> None:
        await asyncio.sleep(0)

    async def slow_phase(
        invocation: Invocation, steps: StepTracker
    ) -> AsyncIterator[Event]:
        """Opens a step, hands the loop several turns, then dies with it still open."""
        yield steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="Pulling metrics")
        for _ in range(6):
            await asyncio.sleep(0)
        raise EmptyScopeError("zero resources")

    async def scenario() -> tuple[list[Event], bool]:
        merged = merge_with_heartbeat(
            run_invocation(
                parse_invocation(payload()),
                handlers={COMMAND_GENERATE_REPORT: slow_phase},
            ),
            interval=interval,
            clock=RunawayClock(),
            sleep=immediately,
        )
        collected: list[Event] = []
        async for event in merged:
            collected.append(main.emit(event))
        exhausted = False
        try:
            await anext(merged)  # type: ignore[arg-type]
        except StopAsyncIteration:
            exhausted = True
        return collected, exhausted

    events, exhausted = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))
    types = types_of(events)

    assert HEARTBEAT_EVENT_TYPE in types, (
        "the ticker never ran, so this asserts nothing about what follows `done`"
    )
    assert_done_is_last(events)
    # Req 14.14 — the closure of the step the phase abandoned is *inside* the stream,
    # ahead of `done`, not behind it.
    assert types[-3:] == ["error", "tool", TERMINAL_EVENT_TYPE], types
    assert_no_open_steps_survive_done(events)
    assert exhausted, "the merged stream kept producing after `done`"


# --------------------------------------------------------------------------- #
# Req 14.14 — a step left open is closed before `done`
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("handler", "expected_code"),
    [
        pytest.param(_raises_agent_error, ErrorCode.EMPTY_SCOPE.value, id="AgentError"),
        pytest.param(_raises_unexpected, CODE_INTERNAL_ERROR, id="unexpected exception"),
        pytest.param(
            _raises_non_terminal, ErrorCode.PARTIAL_COVERAGE.value, id="non-terminal"
        ),
    ],
)
def test_a_step_left_open_by_a_raising_phase_is_closed_before_done(
    handler: Handler, expected_code: str
) -> None:
    """Req 14.14 — including a phase that ended by raising.

    A spinner left running is indistinguishable, on the timeline, from a phase still
    working, so the step closes whatever ended the phase.
    """
    events = drain(
        run_invocation(
            parse_invocation(payload()), handlers={COMMAND_GENERATE_REPORT: handler}
        )
    )

    assert types_of(events) == ["tool", "error", "tool", TERMINAL_EVENT_TYPE]
    opened, closed = events[0], events[2]
    assert opened["phase"] == "start"
    assert closed["phase"] == "end"
    assert closed["id"] == opened["id"]
    assert closed["name"] == opened["name"]
    assert one(events, "error")["code"] == expected_code
    assert_done_is_last(events)
    assert_no_open_steps_survive_done(events)


def test_every_open_step_is_closed_before_done_innermost_first() -> None:
    """Req 14.14 — a step opened inside another is nested inside it on the timeline, so a
    nested step outliving its parent reads as a bug."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_GENERATE_REPORT: _leaves_two_steps_open},
        )
    )

    assert types_of(events) == ["tool", "tool", "error", "tool", "tool", TERMINAL_EVENT_TYPE]
    outer, inner = events[0], events[1]
    assert [event["id"] for event in events[3:5]] == [inner["id"], outer["id"]]
    assert [event["phase"] for event in events[3:5]] == ["end", "end"]
    assert_done_is_last(events)
    assert_no_open_steps_survive_done(events)


def test_a_step_left_open_by_a_phase_that_returned_normally_is_still_closed() -> None:
    """Req 14.14 says "ends without a matching end event", not "raises". A phase that
    simply forgot is the same defect from the client's side."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_GENERATE_REPORT: _returns_with_a_step_open},
        )
    )

    assert types_of(events) == ["tool", "snapshot_ready", "tool", TERMINAL_EVENT_TYPE]
    assert events[2]["phase"] == "end"
    assert events[2]["id"] == events[0]["id"]
    assert assert_done_is_last(events)["status"] == STATUS_COMPLETED
    assert_no_open_steps_survive_done(events)


# --------------------------------------------------------------------------- #
# Req 14.8 — an orphan, closed-step or regressing `progress` never reaches the wire
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("handler", "surviving_progress"),
    [
        pytest.param(_orphan_progress, 0, id="an id that was never opened"),
        pytest.param(_progress_after_close, 1, id="an id whose step has closed"),
        pytest.param(_regressing_progress, 1, id="a done value that went backwards"),
    ],
)
def test_a_progress_event_breaking_its_invariant_never_reaches_the_wire(
    handler: Handler, surviving_progress: int, caplog: pytest.LogCaptureFixture
) -> None:
    """Req 14.8 — rejected, and the run fails loudly rather than quietly.

    The offending event is absent from the stream and the invocation ends as a terminal
    `INTERNAL_ERROR` followed by `done`. Every legitimate `progress` emitted before the
    breach is still on the wire, so the client's bar shows the last count it was actually
    told about rather than a count invented to paper over the defect.
    """
    caplog.set_level(logging.ERROR)

    events = drain(
        run_invocation(
            parse_invocation(payload()), handlers={COMMAND_GENERATE_REPORT: handler}
        )
    )

    progress_events = [event for event in events if event["type"] == "progress"]
    assert len(progress_events) == surviving_progress, types_of(events)

    error = one(events, "error")
    assert error["code"] == CODE_INTERNAL_ERROR
    assert error["terminal"] is True
    assert assert_done_is_last(events)["status"] == STATUS_FAILED
    # Req 14.14 still holds on the way out: the step the phase had open is closed.
    assert_no_open_steps_survive_done(events)
    assert caplog.text, "a rejected progress event must be recorded in the runtime log"


def test_every_progress_event_that_does_reach_the_wire_names_an_open_step() -> None:
    """Req 14.8, stated as the positive obligation it is: each surviving `progress` sits
    between its step's `start` and its `end`, and its `done` never decreases."""

    async def two_steps(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
        inventory = steps.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="s")
        yield inventory
        yield steps.progress(inventory["id"], done=200, total=200, unit="resources")
        yield steps.end(inventory["id"])
        metrics = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")
        yield metrics
        for done in (0, 71, 71, 142, 200):
            yield steps.progress(metrics["id"], done=done, total=200, unit="resources")
        yield steps.end(metrics["id"])
        yield snapshot_ready()

    events = drain(
        run_invocation(
            parse_invocation(payload()), handlers={COMMAND_GENERATE_REPORT: two_steps}
        )
    )

    open_now: set[str] = set()
    last_done: dict[str, int] = {}
    for event in events:
        if event["type"] == "tool":
            if event["phase"] == "start":
                open_now.add(event["id"])
            else:
                open_now.discard(event["id"])
        elif event["type"] == "progress":
            assert event["id"] in open_now, f"{event} arrived outside its step"
            assert event["done"] <= event["total"], event
            assert event["done"] >= last_done.get(event["id"], 0), event
            last_done[event["id"]] = event["done"]

    assert last_done == {"collect_inventory-1": 200, "collect_metrics-2": 200}
    assert assert_done_is_last(events)["status"] == STATUS_COMPLETED


# --------------------------------------------------------------------------- #
# Req 14.4, 14.13 — exactly `error` then `done`
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("body", "expected_code"),
    [
        pytest.param(payload("compare_runs"), CODE_UNSUPPORTED_COMMAND, id="unrecognised"),
        pytest.param(payload("verify_report"), CODE_UNSUPPORTED_COMMAND, id="not yet routed"),
        pytest.param(payload(include_command=False), CODE_MISSING_COMMAND, id="no command"),
        pytest.param(payload(actor_id=_ABSENT), CODE_INVALID_ACTOR, id="no actor"),
    ],
)
def test_a_refused_payload_emits_exactly_error_then_done(
    body: dict[str, Any], expected_code: str
) -> None:
    """Req 14.4, 14.13 — two events, in that order, and nothing else at all.

    No `tool`, no `progress`, no `snapshot_ready`: a refused payload started no phase, so
    a timeline with steps on it would be describing work that never happened.
    """
    events = drain(run_invocation(parse_invocation(body)))

    assert types_of(events) == ["error", TERMINAL_EVENT_TYPE]
    error, done = events
    assert error["code"] == expected_code
    assert error["terminal"] is True
    assert done["status"] == STATUS_FAILED
    assert assert_done_is_last(events) is done


def test_an_unrecognised_command_emits_exactly_error_then_done_from_the_entrypoint() -> None:
    """Req 14.4 end to end, through `invoke` and its heartbeat merge and egress.

    Driving the real entrypoint is what makes this an assertion about the wire: the merge
    forwards two events and stops, and neither is a keep-alive.
    """

    async def scenario() -> list[Event]:
        collected: list[Event] = []
        async for event in main.invoke(payload("generate_reports")):
            collected.append(event)
        return collected

    events = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert types_of(events) == ["error", TERMINAL_EVENT_TYPE]
    assert one(events, "error")["code"] == CODE_UNSUPPORTED_COMMAND
    assert assert_done_is_last(events) == {
        "type": TERMINAL_EVENT_TYPE,
        "run_id": None,
        "status": STATUS_FAILED,
    }


def test_an_unfilled_seam_emits_exactly_error_then_done_from_the_entrypoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A recognised command whose handler has not landed still ends the turn properly:
    from the client's side an unhandled exception and a dead runtime are the same thing.

    Both of this spec's handlers are wired now — `preflight` to `azure/preflight.py` and
    `generate_report` to `collect/pipeline.py` — so the seam is staged rather than
    observed: a registered command whose handler raises
    :class:`~reporting_agent.main.CommandUnimplementedError` is exactly the shape a
    command added to `COMMANDS` ahead of its pipeline takes, and the router's translation
    of it is what this test is about.
    """

    async def unfilled(
        invocation: main.Invocation, steps: main.StepTracker
    ) -> AsyncIterator[Event]:
        raise main.CommandUnimplementedError(COMMAND_GENERATE_REPORT, "a later spec")
        yield  # pragma: no cover - unreachable; keeps this an async generator

    monkeypatch.setitem(main.COMMAND_HANDLERS, COMMAND_GENERATE_REPORT, unfilled)

    async def scenario() -> list[Event]:
        collected: list[Event] = []
        async for event in main.invoke(payload(COMMAND_GENERATE_REPORT)):
            collected.append(event)
        return collected

    events = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert types_of(events) == ["error", TERMINAL_EVENT_TYPE]
    assert one(events, "error")["code"] == CODE_COMMAND_UNIMPLEMENTED
    assert assert_done_is_last(events)["status"] == STATUS_FAILED
