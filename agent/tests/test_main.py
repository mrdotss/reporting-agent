"""The entrypoint's routing, its session-id chain, its egress and its step tracker.

Four surfaces, all example-based:

* **Routing** — the two recognised commands reach their handler with no model in the
  loop, and the three refusals (unrecognised command, no command, unusable `actor_id`)
  each carry their own code, distinct from every collection-phase code.
* **The session-id chain** — `context.session_id`, then the request context's, then a
  derivation from `actor_id`, and the invocation continues in every case (Req 14.6).
* **The single egress** — `emit` validates the type against the declared vocabulary,
  refuses the types this spec has no emitter for, and scrubs registered secrets at every
  depth (Req 14.11, 14.15, 15.8).
* **`StepTracker`** — the `tool`/`progress` invariants of Req 14.7, 14.8 and 14.14.

**Event *ordering* is deliberately not asserted here.** `snapshot_ready` before `done`,
nothing after `done`, a raising phase's step closed before `done`, an orphan `progress`
event and "exactly `error` then `done`" belong to task 5.11, which owns the ordering
surface. What this file pins is the behaviour those orderings are built out of.

`main` reads its configuration at import (Req 14.12), so the two required variables are
set before the import below. That is the same contract the container satisfies with its
environment, expressed in three lines rather than skipped with a mock.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import logging
import os
from collections.abc import AsyncIterator, Mapping
from typing import Any

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from reporting_agent import main  # imported after the environment above, deliberately
from reporting_agent.errors import (
    APP_WRITTEN_CODES,
    EmptyScopeError,
    ErrorCode,
    PartialCoverageError,
)
from reporting_agent.events import EMITTED_BY_FOUNDATION, EVENT_TYPES
from reporting_agent.main import (
    CODE_COMMAND_UNIMPLEMENTED,
    CODE_INTERNAL_ERROR,
    CODE_INVALID_ACTOR,
    CODE_MISSING_COMMAND,
    CODE_UNSUPPORTED_COMMAND,
    COMMAND_GENERATE_REPORT,
    COMMAND_HANDLERS,
    COMMAND_PREFLIGHT,
    COMMANDS,
    INVOCATION_ERROR_CODES,
    SESSION_ID_MAX_LENGTH,
    SESSION_ID_MIN_LENGTH,
    TOOL_COLLECT_INVENTORY,
    TOOL_COLLECT_METRICS,
    CommandUnimplementedError,
    EmissionError,
    Invocation,
    StepInvariantError,
    StepTracker,
    derive_session_id,
    describe_invocation,
    emit,
    parse_invocation,
    resolve_actor_id,
    resolve_session_id,
    run_invocation,
)
from reporting_agent.progress import ProgressReporter
from reporting_agent.redaction import (
    SECRET_PLACEHOLDER,
    discard_secrets,
    register_secrets,
    registered_secret_count,
)

Event = dict[str, Any]

ACTOR = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID = "run_01HZX8QW9K7YB4T2C3M5N6P7QR"
CLIENT_SECRET = "Az~4.2*sEcReT+value(with)regex[chars]?"
PROGRESS_TOKEN = "b7e2d4c6a8f0192837465564738291a0b7e2d4c6a8f01928"
SUPPLIED_SESSION = "s" * 40
REQUEST_SESSION = "r" * 40
SNAPSHOT_ID = "9f2c1d" + "0" * 58

WATCHDOG_S = 2.0


@pytest.fixture(autouse=True)
def _clear_secret_registry():
    """The registry is a `ContextVar` (Req 15.10), so a test that registers a secret must
    not leave it scrubbing the next test's output."""
    yield
    discard_secrets()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


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


class _Absent:
    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<absent>"


_ABSENT = _Absent()


def drain(stream: AsyncIterator[Event]) -> list[Event]:
    """Consume an async event stream to exhaustion, under a real-time watchdog.

    The watchdog turns a router that stops producing into a failed assertion rather than
    a hung suite.
    """

    async def go() -> list[Event]:
        collected: list[Event] = []
        async for event in stream:
            collected.append(event)
        return collected

    async def bounded() -> list[Event]:
        return await asyncio.wait_for(go(), timeout=WATCHDOG_S)

    return asyncio.run(bounded())


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

    `parse_invocation` builds a reporter over real HTTP, so a router test that wants to
    observe the terminal callback constructs the invocation itself — which is the same
    injection seam tasks 6.2 and 11.9 will use.
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


def handler_yielding(*events: Event):
    """A command-handler seam that yields the given events and returns."""

    async def handler(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
        for event in events:
            yield event

    return handler


# --------------------------------------------------------------------------- #
# Routing — Req 14.2, 14.3, 14.4, 14.5, 14.13
# --------------------------------------------------------------------------- #


def test_the_two_accepted_commands_are_the_routed_ones() -> None:
    """Req 14.3 — and every accepted command has a handler, so routing cannot dead-end."""
    assert COMMANDS == {COMMAND_GENERATE_REPORT, COMMAND_PREFLIGHT}
    assert set(COMMAND_HANDLERS) == COMMANDS


@pytest.mark.parametrize("command", sorted(COMMANDS))
def test_a_recognised_command_reaches_its_handler_and_its_prompt_is_ignored(
    command: str,
) -> None:
    """Req 14.2 — the deterministic pipeline runs and any `prompt` alongside it is not read.

    The handler records the payload it was given: the `prompt` is still *in* the payload
    (nothing rewrites the caller's request) and nothing in the routing path consults it.
    There is no model client in `main` to consult it with, which is what makes "no model
    invocation" structural rather than asserted.
    """
    seen: list[Invocation] = []

    async def handler(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
        seen.append(invocation)
        yield steps.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="Enumerating")

    body = payload(command) | {"prompt": "please make something up"}
    invocation = parse_invocation(body)
    assert invocation.rejection is None
    assert invocation.command == command

    events = drain(run_invocation(invocation, handlers={command: handler}))

    assert len(seen) == 1
    assert seen[0].payload["prompt"] == "please make something up"
    assert types_of(events) == ["tool", "tool", "done"]
    assert one(events, "done")["status"] == "completed"


@pytest.mark.parametrize(
    ("body", "expected_code"),
    [
        (payload("compare_runs"), CODE_UNSUPPORTED_COMMAND),
        (payload(""), CODE_UNSUPPORTED_COMMAND),
        (payload(42), CODE_UNSUPPORTED_COMMAND),
        (payload("GENERATE_REPORT"), CODE_UNSUPPORTED_COMMAND),
        (payload(include_command=False), CODE_MISSING_COMMAND),
        (payload(None), CODE_MISSING_COMMAND),
        ({}, CODE_MISSING_COMMAND),
        ("not a payload at all", CODE_MISSING_COMMAND),
        (payload(actor_id=_ABSENT), CODE_INVALID_ACTOR),
        (payload(actor_id=""), CODE_INVALID_ACTOR),
        (payload(actor_id="   \t\n "), CODE_INVALID_ACTOR),
        (payload(actor_id=12345), CODE_INVALID_ACTOR),
        (payload(actor_id=None), CODE_INVALID_ACTOR),
    ],
)
def test_a_refused_payload_carries_its_own_terminal_code(
    body: object, expected_code: str
) -> None:
    """Req 14.4, 14.5, 14.13 — three refusals, three codes, all terminal.

    The distinctions matter to the user: "this command does not exist" and "this run has
    no actor" are different mistakes with different fixes, and neither is a collection
    failure.
    """
    invocation = parse_invocation(body)
    assert invocation.rejection is not None
    assert invocation.rejection.code == expected_code

    events = drain(run_invocation(invocation))
    error = one(events, "error")

    assert error["code"] == expected_code
    assert error["terminal"] is True
    assert one(events, "done")["status"] == "failed"


def test_a_refused_payload_starts_no_collection() -> None:
    """Req 14.5 — no handler is entered for a rejected invocation."""
    entered: list[str] = []

    async def handler(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
        entered.append("yes")
        yield {"type": "heartbeat", "ts": 0.0}

    invocation = parse_invocation(payload(actor_id=""))
    events = drain(
        run_invocation(invocation, handlers={COMMAND_GENERATE_REPORT: handler})
    )

    assert entered == []
    assert types_of(events) == ["error", "done"]


def test_an_invocation_level_code_is_distinct_from_every_collection_phase_code() -> None:
    """Req 14.4 — and from the two codes only the web app writes.

    A refused payload read as a collection failure would send a consultant looking at a
    subscription's permissions for a mistake in a request body; a refused payload read as
    `TIMEOUT` would blame the reaper.
    """
    collection_codes = {code.value for code in ErrorCode}
    assert not INVOCATION_ERROR_CODES & collection_codes
    assert not INVOCATION_ERROR_CODES & APP_WRITTEN_CODES
    assert CODE_UNSUPPORTED_COMMAND in INVOCATION_ERROR_CODES


def test_an_unimplemented_seam_produces_a_well_formed_terminal_stream(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A recognised command whose handler has not landed still ends properly: from the
    client's side, an unhandled exception and a dead runtime are the same thing.

    Both of this spec's commands are wired now, so the unfilled seam is supplied as a
    handler rather than found in the registry. `compare_runs` and `verify_report` belong to
    the spec that adds the compile/render/verify pipeline, and this is the shape either one
    takes if it is registered before its pipeline exists.
    """
    caplog.set_level(logging.ERROR)

    async def unfilled(
        invocation: Invocation, steps: StepTracker
    ) -> AsyncIterator[Event]:
        raise CommandUnimplementedError(COMMAND_GENERATE_REPORT, "a later spec")
        yield  # pragma: no cover - unreachable; keeps this an async generator

    invocation = parse_invocation(payload(COMMAND_GENERATE_REPORT))

    events = drain(
        run_invocation(invocation, handlers={COMMAND_GENERATE_REPORT: unfilled})
    )

    assert types_of(events) == ["error", "done"]
    error = one(events, "error")
    assert error["code"] == CODE_COMMAND_UNIMPLEMENTED
    assert error["terminal"] is True
    assert "a later spec" in error["message"]
    assert one(events, "done")["status"] == "failed"


def test_both_handlers_are_registered_async_generators() -> None:
    """Both handlers keep the shape the router drives — `preflight` wired to
    `azure/preflight.py` and `generate_report` to `collect/pipeline.py` — so adding a third
    command is a registration rather than a change to how the router drives one."""
    for command, handler in COMMAND_HANDLERS.items():
        assert inspect.isasyncgenfunction(handler), command
        params = list(inspect.signature(handler).parameters)
        assert params == ["invocation", "steps"], (command, params)


def test_a_raised_agent_error_becomes_its_own_code_and_a_failed_run() -> None:
    """A collection-phase failure keeps its `ErrorCode`; the router adds no code of its own."""

    async def handler(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
        yield steps.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="Enumerating")
        raise EmptyScopeError("The requested scope resolved to zero resources.")

    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_GENERATE_REPORT: handler},
        )
    )

    error = one(events, "error")
    assert error["code"] == ErrorCode.EMPTY_SCOPE.value
    assert error["terminal"] is True
    assert one(events, "done")["status"] == "failed"


def test_a_non_terminal_agent_error_still_completes_the_run() -> None:
    """Req 29.5 — a run with recorded gaps completes; the error event carries `terminal`
    false. `PARTIAL_COVERAGE` is a description of an honest result, not a failure."""

    async def handler(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
        yield {"type": "heartbeat", "ts": 1.0}
        raise PartialCoverageError("3 resources were not fully readable.")

    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_GENERATE_REPORT: handler},
        )
    )

    assert one(events, "error")["terminal"] is False
    assert one(events, "done")["status"] == "completed"


def test_an_unexpected_exception_is_logged_in_full_and_summarised_in_the_event(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The traceback belongs in the runtime log, not in a browser (Req 15.5).

    The event names the exception class so the failure is identifiable, and carries no
    stack frame.
    """
    caplog.set_level(logging.ERROR)

    async def handler(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
        yield {"type": "heartbeat", "ts": 1.0}
        raise ZeroDivisionError("a bug nobody anticipated")

    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_GENERATE_REPORT: handler},
        )
    )

    error = one(events, "error")
    assert error["code"] == CODE_INTERNAL_ERROR
    assert error["terminal"] is True
    assert "ZeroDivisionError" in error["message"]
    assert "Traceback" not in error["message"]
    assert "a bug nobody anticipated" in caplog.text


def test_the_router_refuses_a_report_file_with_no_passing_verification() -> None:
    """Req 25.9, 42.3 — and it refuses it *inside* its own error handling, so the client
    still gets a terminal event instead of a truncated stream.

    The document phases gave `verification` and `report_file` emitters, so the old rule —
    this runtime emits neither — no longer holds. What replaces it is stronger: the
    artifacts are uploaded only behind a passing gate, and the router refuses to relay a
    `report_file` that arrived any other way. A client-side check would protect one client;
    this protects the contract.
    """
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={
                COMMAND_GENERATE_REPORT: handler_yielding({"type": "report_file"})
            },
        )
    )

    assert one(events, "error")["code"] == CODE_INTERNAL_ERROR
    assert one(events, "done")["status"] == "failed"
    assert "report_file" not in types_of(events)


def test_the_router_refuses_a_report_file_behind_a_failing_verification() -> None:
    """The near miss: a `verification` did arrive, and it said `fail`."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={
                COMMAND_GENERATE_REPORT: handler_yielding(
                    {"type": "verification", "status": "fail"},
                    {"type": "report_file", "key": "a/reports/r/report.pdf"},
                )
            },
        )
    )

    assert "verification" in types_of(events)
    assert "report_file" not in types_of(events)
    assert one(events, "error")["code"] == CODE_INTERNAL_ERROR


def test_the_router_relays_a_report_file_behind_a_passing_verification() -> None:
    """Non-vacuity: the rule must admit the legitimate case, or it is a ban rather than an
    ordering."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={
                COMMAND_GENERATE_REPORT: handler_yielding(
                    {"type": "verification", "status": "pass"},
                    {"type": "report_file", "key": "a/reports/r/report.pdf"},
                )
            },
        )
    )

    assert types_of(events).count("report_file") == 1
    assert one(events, "done")["status"] == "completed"


def test_the_router_refuses_a_second_verification() -> None:
    """Req 42.2 — exactly one per invocation. Two would leave a client with two panels for
    one run and no rule for which is the record."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={
                COMMAND_GENERATE_REPORT: handler_yielding(
                    {"type": "verification", "status": "pass"},
                    {"type": "verification", "status": "fail"},
                )
            },
        )
    )

    assert types_of(events).count("verification") == 1
    assert one(events, "error")["code"] == CODE_INTERNAL_ERROR


def test_a_handler_may_not_emit_its_own_done() -> None:
    """The terminal event belongs to the router: a handler-emitted `done` would strand the
    step closures and the terminal callback behind an event the client treats as final."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={
                COMMAND_GENERATE_REPORT: handler_yielding(
                    {"type": "done", "run_id": RUN_ID, "status": "completed"}
                )
            },
        )
    )

    assert types_of(events) == ["error", "done"]
    assert one(events, "done")["status"] == "failed"


def test_the_terminal_progress_callback_is_fired_from_the_snapshot_ready_event() -> None:
    """One source for the numbers on the row and in the event (Req 38.12).

    The completed callback's `snapshot_id`, `resource_count` and `gap_count` are read off
    `snapshot_ready` rather than passed separately, because two sources for one number is
    how the row and the stream stop agreeing.
    """
    transport = RecordingTransport()
    snapshot_ready: Event = {
        "type": "snapshot_ready",
        "snapshot_id": SNAPSHOT_ID,
        "resource_count": 200,
        "window": {"start": "2026-07-01", "end": "2026-07-31"},
        "grain": "PT1H",
        "gaps": [{"gap_type": "deallocated"}, {"gap_type": "not_emitted"}],
    }

    events = drain(
        run_invocation(
            invocation_for(transport=transport),
            handlers={COMMAND_GENERATE_REPORT: handler_yielding(snapshot_ready)},
        )
    )

    assert one(events, "done")["status"] == "completed"
    assert len(transport.calls) == 1
    body = transport.calls[0]["body"]
    assert body["phase"] == "completed"
    assert body["run_id"] == RUN_ID
    assert body["snapshot_id"] == SNAPSHOT_ID
    assert body["resource_count"] == 200
    assert body["gap_count"] == 2


def test_a_failed_run_presents_a_row_error_code_only_when_the_row_accepts_one() -> None:
    """An invocation-level code is dropped from the callback, not presented (Req 38.11).

    The progress endpoint refuses the whole callback on an out-of-set code — including the
    transition it carries — and losing the transition costs a false `TIMEOUT` on a run
    whose outcome is already known. So the label goes and the transition lands.
    """
    collection_transport = RecordingTransport()

    async def failing(invocation: Invocation, steps: StepTracker) -> AsyncIterator[Event]:
        yield {"type": "heartbeat", "ts": 1.0}
        raise EmptyScopeError("zero resources")

    drain(
        run_invocation(
            invocation_for(transport=collection_transport),
            handlers={COMMAND_GENERATE_REPORT: failing},
        )
    )
    body = collection_transport.calls[0]["body"]
    assert body["phase"] == "failed"
    assert body["error_code"] == ErrorCode.EMPTY_SCOPE.value

    routing_transport = RecordingTransport()
    unimplemented = invocation_for(COMMAND_GENERATE_REPORT, transport=routing_transport)
    drain(run_invocation(unimplemented))

    routed = routing_transport.calls[0]["body"]
    assert routed["phase"] == "failed"
    assert "error_code" not in routed
    assert routed["error_message"]


def test_an_invocation_with_no_run_row_reports_nothing_and_carries_a_null_run_id() -> None:
    """A `preflight` has no run behind it: the reporter is disabled and `done.run_id` is
    `None` rather than an identifier the app could not resolve."""
    invocation = parse_invocation(payload(COMMAND_PREFLIGHT))

    assert invocation.progress is not None
    assert invocation.progress.enabled is False

    events = drain(
        run_invocation(
            invocation,
            handlers={COMMAND_PREFLIGHT: handler_yielding({"type": "heartbeat", "ts": 1.0})},
        )
    )
    assert one(events, "done")["run_id"] is None


# --------------------------------------------------------------------------- #
# `actor_id` and the session-id chain — Req 14.5, 14.6
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "value", [None, 12345, 1.5, True, "", " ", "\t", "\n", "   \r\n  ", [], {}]
)
def test_an_unusable_actor_id_resolves_as_absent(value: object) -> None:
    """Req 14.5 — absent, non-string, empty and whitespace-only are one mistake."""
    assert resolve_actor_id({"actor_id": value}) is None
    assert resolve_actor_id({}) is None


def test_a_usable_actor_id_is_returned_verbatim() -> None:
    """It prefixes every artifact key this run writes, so trimming it here would write
    objects under a key the app cannot compute."""
    assert resolve_actor_id({"actor_id": ACTOR}) == ACTOR
    assert resolve_actor_id({"actor_id": " padded "}) == " padded "


def test_the_session_id_comes_from_the_payload_context_first() -> None:
    resolved = resolve_session_id(
        supplied=SUPPLIED_SESSION, fallback=REQUEST_SESSION, actor_id=ACTOR
    )
    assert resolved == SUPPLIED_SESSION


def test_the_session_id_falls_back_to_the_request_context() -> None:
    resolved = resolve_session_id(supplied=None, fallback=REQUEST_SESSION, actor_id=ACTOR)
    assert resolved == REQUEST_SESSION


@pytest.mark.parametrize(
    "unusable",
    [
        None,
        "",
        "   ",
        "too-short",
        "s" * (SESSION_ID_MIN_LENGTH - 1),
        "s" * (SESSION_ID_MAX_LENGTH + 1),
        12345,
        ["s" * 40],
    ],
)
def test_an_unusable_session_id_falls_through_to_the_derivation(unusable: object) -> None:
    """Req 14.6 — neither source supplied a value inside 33-128, so one is derived from
    `actor_id`, and the invocation **continues**. A session id that cannot be honoured
    costs continuity of memory; failing a twelve-minute run over it costs the run."""
    resolved = resolve_session_id(supplied=unusable, fallback=unusable, actor_id=ACTOR)
    assert resolved == derive_session_id(ACTOR)


def test_a_boundary_length_session_id_is_accepted_at_both_ends() -> None:
    for length in (SESSION_ID_MIN_LENGTH, SESSION_ID_MAX_LENGTH):
        candidate = "x" * length
        assert resolve_session_id(supplied=candidate, fallback=None, actor_id=ACTOR) == (
            candidate
        )


def test_a_supplied_session_id_is_used_with_surrounding_whitespace_stripped() -> None:
    """A trailing newline on a forwarded header is a real thing, and it is not a different
    session."""
    resolved = resolve_session_id(
        supplied=f"  {SUPPLIED_SESSION}\n", fallback=None, actor_id=ACTOR
    )
    assert resolved == SUPPLIED_SESSION


def test_the_derived_session_id_satisfies_the_length_bound_by_construction() -> None:
    """A SHA-256 digest is 64 hex characters for any input, so there is no input that
    could violate 33-128 and therefore no length check to forget."""
    for actor in ("a", ACTOR, "x" * 4096, "actor with spaces", "актор"):
        derived = derive_session_id(actor)
        assert len(derived) == 64
        assert SESSION_ID_MIN_LENGTH <= len(derived) <= SESSION_ID_MAX_LENGTH
        assert set(derived) <= set("0123456789abcdef")


def test_the_derivation_is_deterministic_and_distinguishes_actors() -> None:
    assert derive_session_id(ACTOR) == derive_session_id(ACTOR)
    assert derive_session_id(ACTOR) != derive_session_id(ACTOR + "x")
    # Namespaced, so it is not the bare digest of the actor id: a future change to the
    # derivation is a new namespace rather than a silent reinterpretation of ids in use.
    assert derive_session_id(ACTOR) != hashlib.sha256(ACTOR.encode()).hexdigest()


def test_the_request_context_supplies_the_session_id_when_the_payload_does_not() -> None:
    class RequestContext:
        session_id = REQUEST_SESSION

    invocation = parse_invocation(payload(), RequestContext())
    assert invocation.session_id == REQUEST_SESSION


def test_a_rejected_invocation_still_resolves_a_session_id_when_one_was_supplied() -> None:
    """`actor_id` is missing, so nothing can be derived — but a supplied id is still
    honoured, because the log line for the refusal is more useful with it."""
    invocation = parse_invocation(
        payload(actor_id=_ABSENT, session_id=SUPPLIED_SESSION)
    )
    assert invocation.rejection is not None
    assert invocation.session_id == SUPPLIED_SESSION

    without = parse_invocation(payload(actor_id=_ABSENT))
    assert without.session_id is None


# --------------------------------------------------------------------------- #
# The single egress — Req 14.11, 14.15, 15.8
# --------------------------------------------------------------------------- #


def test_emit_passes_a_declared_emitted_type_through_unchanged() -> None:
    event = {"type": "tool", "phase": "end", "id": "collect_inventory-1", "name": "x"}
    assert emit(event) == event


@pytest.mark.parametrize("kind", sorted(EMITTED_BY_FOUNDATION))
def test_emit_accepts_every_type_this_runtime_emits(kind: str) -> None:
    assert emit({"type": kind})["type"] == kind


@pytest.mark.parametrize("kind", sorted(EVENT_TYPES))
def test_emit_accepts_every_declared_type_now_that_every_one_has_an_emitter(
    kind: str,
) -> None:
    """Req 14.11, as it now stands.

    `emit` was the gate that refused `verification`, `report_file`, `chart` and `delta`
    while nothing produced them. The document phases produce all four, so the gate moved:
    `emit` still refuses an *undeclared* type, and the **ordering** screen in the router is
    what keeps a `report_file` from arriving without a passing `verification` before it.
    Two different guarantees; only the second one was ever the interesting one.
    """
    assert emit({"type": kind})["type"] == kind


@pytest.mark.parametrize(
    "event",
    [
        {},
        {"type": None},
        {"type": ""},
        {"type": "Done"},
        {"type": "snapshot"},
        {"type": 7},
        {"code": "EMPTY_SCOPE", "terminal": True},
        None,
        "done",
        ["done"],
        42,
    ],
)
def test_emit_refuses_anything_without_a_declared_type(event: object) -> None:
    """Req 14.15 — every event carries a `type`, and only declared types are emitted."""
    with pytest.raises(EmissionError):
        emit(event)


def test_emit_scrubs_registered_secrets_at_every_depth() -> None:
    """Req 15.3, 15.8 — one scrub, on the way out, so a new emission site cannot bypass it."""
    register_secrets((CLIENT_SECRET, PROGRESS_TOKEN))

    emitted = emit(
        {
            "type": "error",
            "code": "AUTH_FAILED",
            "terminal": True,
            "message": f"rejected {CLIENT_SECRET}",
            "detail": {
                "nested": [f"token={PROGRESS_TOKEN}", {"deeper": CLIENT_SECRET}],
                CLIENT_SECRET: "a secret used as a key",
            },
        }
    )

    rendered = repr(emitted)
    assert CLIENT_SECRET not in rendered
    assert PROGRESS_TOKEN not in rendered
    assert SECRET_PLACEHOLDER in emitted["message"]
    assert emitted["detail"]["nested"][1]["deeper"] == SECRET_PLACEHOLDER
    assert SECRET_PLACEHOLDER in emitted["detail"]


def test_emit_leaves_the_callers_event_untouched() -> None:
    """The event is rebuilt, not mutated, so a caller holding a reference to what it
    emitted still sees what it built."""
    register_secrets((CLIENT_SECRET,))
    original = {"type": "error", "message": CLIENT_SECRET, "nested": {"v": CLIENT_SECRET}}

    emitted = emit(original)

    assert emitted["message"] == SECRET_PLACEHOLDER
    assert original["message"] == CLIENT_SECRET
    assert original["nested"]["v"] == CLIENT_SECRET


def test_the_entrypoint_scrubs_through_the_egress_and_tears_the_registry_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The whole path: `invoke` -> the heartbeat merge -> `emit` (Req 15.8, 15.10).

    A handler that put a credential into an event — an Azure error message quoting the
    secret it rejected is the realistic version — has it replaced on the way out, and the
    registry is empty once the terminal event has been yielded, so this invocation's
    secrets cannot scrub the next one's output.
    """
    monkeypatch.setitem(
        main.COMMAND_HANDLERS,
        COMMAND_PREFLIGHT,
        handler_yielding(
            {
                "type": "error",
                "code": "AUTH_FAILED",
                "terminal": False,
                "message": f"AADSTS7000215 rejected {CLIENT_SECRET}",
            }
        ),
    )
    body = payload(COMMAND_PREFLIGHT, client_secret=CLIENT_SECRET, progress_token=PROGRESS_TOKEN)

    async def scenario() -> tuple[list[Event], int]:
        collected: list[Event] = []
        async for event in main.invoke(body):
            collected.append(event)
        return collected, registered_secret_count()

    events, remaining = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert types_of(events) == ["error", "done"]
    assert CLIENT_SECRET not in repr(events)
    assert SECRET_PLACEHOLDER in one(events, "error")["message"]
    # Req 15.10 — discarded when the invocation emitted its terminal event.
    assert remaining == 0


def test_the_entrypoint_yields_sse_dictionaries_and_accepts_a_request_context() -> None:
    """Req 14.1 — an async generator of event dictionaries, taking the payload and the
    request context. The second parameter must be named `context`: that is how
    `BedrockAgentCoreApp` decides whether to hand the handler its request context, which
    is the second source Req 14.6 resolves a session id from."""

    class RequestContext:
        session_id = REQUEST_SESSION

    async def scenario() -> list[Event]:
        collected: list[Event] = []
        async for event in main.invoke(payload("nonsense"), RequestContext()):
            collected.append(event)
        return collected

    events = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))
    signature = list(inspect.signature(main.invoke).parameters)

    assert signature[1] == "context", signature
    assert all(isinstance(event, dict) for event in events)
    assert types_of(events) == ["error", "done"]
    assert one(events, "error")["code"] == CODE_UNSUPPORTED_COMMAND
    assert one(events, "done") == {"type": "done", "run_id": None, "status": "failed"}


def test_emit_scrubs_nothing_when_no_secret_is_registered() -> None:
    assert registered_secret_count() == 0
    event = {"type": "snapshot_ready", "snapshot_id": SNAPSHOT_ID, "gaps": []}
    assert emit(event) == event


# --------------------------------------------------------------------------- #
# Context parsing and the log-safe description — Req 15.1, 15.4
# --------------------------------------------------------------------------- #


def test_parsing_a_context_registers_the_secret_and_the_token_together() -> None:
    """Req 15.1 — identical sensitivity. The token authorizes writes to the run state
    machine, so a leak lets someone mark a run `completed`."""
    assert registered_secret_count() == 0

    parse_invocation(
        payload(client_secret=CLIENT_SECRET, progress_token=PROGRESS_TOKEN)
    )

    assert registered_secret_count() == 2
    scrubbed = emit({"type": "error", "message": f"{CLIENT_SECRET} {PROGRESS_TOKEN}"})
    assert CLIENT_SECRET not in scrubbed["message"]
    assert PROGRESS_TOKEN not in scrubbed["message"]


def test_parsing_registers_the_secrets_of_a_payload_it_goes_on_to_refuse() -> None:
    """Registration happens before any validation, so the refusal's own message and log
    line are already covered by the guard."""
    parse_invocation(
        payload(include_command=False, client_secret=CLIENT_SECRET, progress_token=PROGRESS_TOKEN)
    )
    assert registered_secret_count() == 2


def test_the_logged_description_carries_presence_markers_not_credentials() -> None:
    """Req 15.4 — no character of a secret reaches a log line."""
    invocation = parse_invocation(
        payload(
            client_secret=CLIENT_SECRET,
            progress_token=PROGRESS_TOKEN,
            tenant_id="7c9e0000-0000-0000-0000-000000000000",
            client_id="1f4a0000-0000-0000-0000-000000000000",
            timezone="Asia/Jakarta",
        )
    )

    described = describe_invocation(invocation)
    rendered = repr(described)

    assert CLIENT_SECRET not in rendered
    assert PROGRESS_TOKEN not in rendered
    assert "7c9e0000" not in rendered
    assert "1f4a0000" not in rendered
    assert described["client_secret"] == f"<set:{len(CLIENT_SECRET)}chars>"
    assert described["progress_token"] == f"<set:{len(PROGRESS_TOKEN)}chars>"
    # The non-secret facts are still legible, which is the point of the description.
    assert described["actor_id"] == ACTOR
    assert described["command"] == COMMAND_GENERATE_REPORT
    assert described["timezone"] == "Asia/Jakarta"
    assert described["rejected"] is None


def test_the_description_names_the_refusal_when_there_was_one() -> None:
    described = describe_invocation(parse_invocation(payload(actor_id="")))
    assert described["rejected"] == CODE_INVALID_ACTOR
    assert described["actor_id"] is None


def test_a_context_that_is_not_a_mapping_parses_as_an_empty_one() -> None:
    """A malformed payload is a refusal, not an exception: the client is owed a terminal
    `error` and a `done`, and a parse that raised would deny it both."""
    for body in ({"command": COMMAND_PREFLIGHT, "context": "nope"}, {"context": None}, []):
        invocation = parse_invocation(body)
        assert invocation.rejection is not None
        assert invocation.context == {}


# --------------------------------------------------------------------------- #
# StepTracker — Req 14.7, 14.8, 14.14
# --------------------------------------------------------------------------- #


def test_a_started_step_carries_the_five_declared_fields() -> None:
    """Req 14.7 — `phase` `start` carries `id`, `name`, `label` and `status`."""
    steps = StepTracker()
    event = steps.start(
        TOOL_COLLECT_INVENTORY, label="Inventory", status="Enumerating resources"
    )

    assert event == {
        "type": "tool",
        "phase": "start",
        "id": "collect_inventory-1",
        "name": TOOL_COLLECT_INVENTORY,
        "label": "Inventory",
        "status": "Enumerating resources",
    }
    assert steps.open_ids == ("collect_inventory-1",)
    assert steps.is_open("collect_inventory-1")


def test_an_ended_step_repeats_the_same_id_and_the_same_name() -> None:
    """Req 14.7 — the pair is matched by `id`, which is how the timeline collapses a step."""
    steps = StepTracker()
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="Pulling metrics")
    ended = steps.end(started["id"])

    assert ended == {
        "type": "tool",
        "phase": "end",
        "id": started["id"],
        "name": TOOL_COLLECT_METRICS,
    }
    assert steps.open_ids == ()
    assert not steps.is_open(started["id"])


def test_step_ids_are_deterministic_and_unique_within_an_invocation() -> None:
    """No random component: two runs of one pipeline produce the same ids, which is what
    makes a log comparable run to run."""
    first = StepTracker()
    second = StepTracker()
    ids = [
        first.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="s")["id"],
        first.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")["id"],
    ]
    assert ids == ["collect_inventory-1", "collect_metrics-2"]
    assert (
        second.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="s")["id"] == ids[0]
    )


def test_a_step_id_cannot_be_reused_even_after_it_was_closed() -> None:
    steps = StepTracker()
    steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s", step_id="met-1")
    steps.end("met-1")

    with pytest.raises(StepInvariantError, match="already been used"):
        steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s", step_id="met-1")


@pytest.mark.parametrize(
    ("name", "label", "status"),
    [
        ("", "Inventory", "s"),
        (None, "Inventory", "s"),
        (TOOL_COLLECT_INVENTORY, "", "s"),
        (TOOL_COLLECT_INVENTORY, "Inventory", ""),
        (TOOL_COLLECT_INVENTORY, "Inventory", "   "),
        (7, "Inventory", "s"),
    ],
)
def test_a_step_needs_a_name_a_label_and_a_status(
    name: object, label: object, status: object
) -> None:
    steps = StepTracker()
    with pytest.raises(StepInvariantError):
        steps.start(name, label=label, status=status)  # type: ignore[arg-type]


def test_an_unrecognised_step_name_is_permitted_and_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A name the timeline does not know degrades to a generic step, which is cosmetic.
    Refusing it would turn that into a failed run and would mean this module has to be
    edited before a later phase can open a step at all."""
    caplog.set_level(logging.WARNING)
    steps = StepTracker()

    event = steps.start("probe_fidelity", label="Preflight", status="Probing")

    assert event["name"] == "probe_fidelity"
    assert "probe_fidelity" in caplog.text


def test_a_progress_event_carries_the_five_declared_fields() -> None:
    """Req 14.8 — `id`, `done`, `total`, `unit` and `label`, so the bar is determinate."""
    steps = StepTracker()
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")

    event = steps.progress(started["id"], done=142, total=200, unit="resources")

    assert event == {
        "type": "progress",
        "id": started["id"],
        "done": 142,
        "total": 200,
        "unit": "resources",
        "label": "Metrics",
    }


def test_progress_defaults_its_label_to_the_step_it_belongs_to() -> None:
    """One label per id, so the bar and the step it sits under cannot disagree."""
    steps = StepTracker()
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")

    assert steps.progress(started["id"], done=1, total=2, unit="r")["label"] == "Metrics"
    assert (
        steps.progress(started["id"], done=2, total=2, unit="r", label="Metrics (VMs)")[
            "label"
        ]
        == "Metrics (VMs)"
    )


def test_progress_must_reference_an_open_step() -> None:
    """Req 14.8 — an orphan bar points at a step the client never opened."""
    steps = StepTracker()
    with pytest.raises(StepInvariantError, match="does not reference an open"):
        steps.progress("met-1", done=1, total=2, unit="resources")


def test_progress_may_not_reference_a_step_that_has_been_closed() -> None:
    """Req 14.8 — "open" means started and not ended. A bar arriving after its step
    collapsed is as orphaned as one that never had a step."""
    steps = StepTracker()
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")
    steps.progress(started["id"], done=1, total=2, unit="resources")
    steps.end(started["id"])

    with pytest.raises(StepInvariantError, match="does not reference an open"):
        steps.progress(started["id"], done=2, total=2, unit="resources")


def test_progress_keeps_done_at_or_below_total() -> None:
    steps = StepTracker()
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")

    assert steps.progress(started["id"], done=200, total=200, unit="r")["done"] == 200
    with pytest.raises(StepInvariantError, match="at or below"):
        steps.progress(started["id"], done=201, total=200, unit="r")


def test_successive_done_values_for_one_id_do_not_decrease() -> None:
    """Req 14.8 — a determinate bar that runs backwards is worse than no bar."""
    steps = StepTracker()
    first = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")
    second = steps.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="s")

    steps.progress(first["id"], done=10, total=20, unit="r")
    steps.progress(first["id"], done=10, total=20, unit="r")  # equal is not a decrease
    steps.progress(first["id"], done=11, total=20, unit="r")

    with pytest.raises(StepInvariantError, match="went backwards"):
        steps.progress(first["id"], done=10, total=20, unit="r")

    # The invariant is per id: a second step starts from wherever it starts.
    assert steps.progress(second["id"], done=0, total=5, unit="r")["done"] == 0


@pytest.mark.parametrize(
    ("done", "total"),
    [(-1, 10), (1, 0), (1, -1), (True, 10), (1, True), ("1", 10), (1.5, 10), (None, 10)],
)
def test_progress_counts_must_be_non_negative_ints_with_a_positive_total(
    done: object, total: object
) -> None:
    """`bool` is a subclass of `int`, and `True` is not a resource count."""
    steps = StepTracker()
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")
    with pytest.raises(StepInvariantError):
        steps.progress(started["id"], done=done, total=total, unit="r")  # type: ignore[arg-type]


def test_progress_needs_a_unit() -> None:
    steps = StepTracker()
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")
    with pytest.raises(StepInvariantError):
        steps.progress(started["id"], done=1, total=2, unit="")


def test_ending_a_step_that_is_not_open_is_refused() -> None:
    steps = StepTracker()
    with pytest.raises(StepInvariantError, match="not open"):
        steps.end("met-1")

    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")
    steps.end(started["id"])
    with pytest.raises(StepInvariantError, match="not open"):
        steps.end(started["id"])


def test_close_all_closes_every_open_step_innermost_first() -> None:
    """Req 14.14 — and in the order that reads correctly on a timeline: a step opened
    inside another is nested inside it, so it closes first."""
    steps = StepTracker()
    outer = steps.start(TOOL_COLLECT_INVENTORY, label="Inventory", status="s")
    inner = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")

    closed = steps.close_all()

    assert [event["id"] for event in closed] == [inner["id"], outer["id"]]
    assert all(event["phase"] == "end" for event in closed)
    assert steps.open_ids == ()


def test_close_all_is_idempotent_and_empty_when_nothing_is_open() -> None:
    """It runs in the router's `finally` on every path, including the paths where every
    step was already closed properly."""
    steps = StepTracker()
    started = steps.start(TOOL_COLLECT_METRICS, label="Metrics", status="s")
    steps.end(started["id"])

    assert steps.close_all() == []
    assert steps.close_all() == []
