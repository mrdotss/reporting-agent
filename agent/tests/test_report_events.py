"""The four event types the document phases add, and the ordering they promise (Req 42).

Two kinds of assertion live here, and they are separate on purpose.

The **ordering** assertions run against the router — `snapshot_ready` before any
`verification`, `report_file` only behind a `pass`, nothing after `done` — because the
router is where every event passes through, and a guarantee enforced anywhere else is a
guarantee one new emission site can bypass.

The **timing** assertions run against `merge_with_heartbeat` over a simulated clock. A
600-second verification phase with nothing to say would otherwise sit inside the relay's
120-second inactivity window with no event at all, and the run would be killed for being
slow rather than for being wrong. That failure is invisible to every test that does not
model time, which is why this one does.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from itertools import pairwise
from typing import Any, Final

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from reporting_agent.events import (
    EMITTED_BY_FOUNDATION,
    EMITTED_BY_REPORT_PIPELINE,
    EVENT_TYPES,
    TOOL_COMPILE_FIGURES,
    TOOL_RENDER_DOCUMENT,
    TOOL_UPLOAD_ARTIFACT,
    TOOL_VERIFY_DOCUMENT,
)
from reporting_agent.heartbeat import (
    HEARTBEAT_INTERVAL_S,
    HEARTBEAT_TOLERANCE_S,
    MAX_EVENT_GAP_S,
    merge_with_heartbeat,
)
from reporting_agent.main import (
    CODE_INTERNAL_ERROR,
    COMMAND_GENERATE_REPORT,
    COMMAND_LIST_INVENTORY,
    parse_invocation,
    run_invocation,
)

RUN_ID: Final[str] = "run_01HQZX8QW9K7YB4T2C3M5N6P7Q"
SILENT_VERIFY_S: Final[float] = 600.0


def payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "command": COMMAND_GENERATE_REPORT,
        "period": {"start": "2026-07-01", "end": "2026-07-31"},
        "context": {
            "actor_id": "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q",
            "subscription_id": "3f2b0000-0000-0000-0000-000000000000",
        },
    }
    body.update(overrides)
    return body


def handler_yielding(*events: dict[str, Any]):
    async def handler(invocation, steps) -> AsyncIterator[dict[str, Any]]:
        del invocation, steps
        for event in events:
            yield event

    return handler


def drain(source) -> list[dict[str, Any]]:
    async def go() -> list[dict[str, Any]]:
        return [event async for event in source]

    return asyncio.run(go())


def types_of(events: list[dict[str, Any]]) -> list[str]:
    return [event["type"] for event in events]


def run(*events: dict[str, Any]) -> list[dict[str, Any]]:
    return drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_GENERATE_REPORT: handler_yielding(*events)},
        )
    )


# --------------------------------------------------------------------------- #
# The vocabulary did not grow
# --------------------------------------------------------------------------- #


def test_this_spec_adds_emitters_and_no_event_type() -> None:
    """Req 42.1. `lib/events.ts` needs no edit and the cross-language mirror guard stays
    untouched, which is the whole reason the foundation declared ten and emitted six."""
    assert EMITTED_BY_REPORT_PIPELINE == frozenset(EVENT_TYPES)
    assert EMITTED_BY_FOUNDATION < EMITTED_BY_REPORT_PIPELINE
    assert EMITTED_BY_REPORT_PIPELINE - EMITTED_BY_FOUNDATION == {
        "delta",
        "chart",
        "verification",
        "report_file",
    }


def test_the_inventory_listing_command_adds_no_event_type_either() -> None:
    """Task 12.1 reports its whole result on `done`'s outcome mapping, so `events.py` and
    `app/lib/events.ts` are both untouched and `event-mirror.static.test.ts` needs no edit.
    Asserted here, beside the claim the document phases make, because this is the file that
    would have to change if either spec ever did grow a type.
    """
    async def handler(invocation, steps) -> AsyncIterator[dict[str, Any]]:
        del steps
        invocation.outcome.update(
            {
                "resource_types": {"values": ["Microsoft.Compute/virtualMachines"],
                                   "truncated": False},
                "resource_groups": {"values": [], "truncated": False},
                "tag_keys": {"values": [], "truncated": False},
                "tag_values": {"values": [], "truncated": True},
            }
        )
        for event in ():  # a handler with nothing to say still reaches `done`
            yield event
    events = drain(
        run_invocation(
            parse_invocation(payload(command=COMMAND_LIST_INVENTORY)),
            handlers={COMMAND_LIST_INVENTORY: handler},
        )
    )
    assert types_of(events) == ["done"], "nothing precedes and nothing follows `done`"
    done = one(events, "done")
    assert done["status"] == "completed"
    # The four dimension keys reach `done`, and every emitted type is still declared.
    assert {"resource_types", "resource_groups", "tag_keys", "tag_values"} <= set(done)
    assert done["tag_values"]["truncated"] is True
    for kind in types_of(events):
        assert kind in EVENT_TYPES
def test_the_four_new_step_names_are_declared_once_each() -> None:
    """A step name spelled twice is a step the timeline renders as two different things."""
    names = [
        TOOL_COMPILE_FIGURES,
        TOOL_RENDER_DOCUMENT,
        TOOL_VERIFY_DOCUMENT,
        TOOL_UPLOAD_ARTIFACT,
    ]

    assert names == ["compile_figures", "render_document", "verify_document",
                     "upload_artifact"]
    assert len(set(names)) == 4


# --------------------------------------------------------------------------- #
# Req 25.9, 42.2, 42.3 — the ordering, at the source
# --------------------------------------------------------------------------- #


def test_snapshot_ready_precedes_the_verification() -> None:
    events = run(
        {"type": "snapshot_ready", "snapshot_id": "a" * 64, "resource_count": 1},
        {"type": "verification", "status": "pass"},
    )
    kinds = types_of(events)

    assert kinds.index("snapshot_ready") < kinds.index("verification")


def test_report_file_is_relayed_only_behind_a_passing_verification() -> None:
    passing = run(
        {"type": "verification", "status": "pass"},
        {"type": "report_file", "key": "a/reports/r/report.pdf"},
    )
    failing = run(
        {"type": "verification", "status": "fail"},
        {"type": "report_file", "key": "a/reports/r/report.pdf"},
    )

    assert types_of(passing).count("report_file") == 1
    assert "report_file" not in types_of(failing)
    assert one(failing, "error")["code"] == CODE_INTERNAL_ERROR


def test_nothing_follows_done() -> None:
    """Req 42.7. `done` is the client's signal to stop reading, so anything after it is an
    event nobody sees — and a `report_file` nobody sees is a report nobody downloads."""
    events = run(
        {"type": "verification", "status": "pass"},
        {"type": "report_file", "key": "a/reports/r/report.pdf"},
    )

    assert types_of(events)[-1] == "done"
    assert types_of(events).count("done") == 1


def test_a_step_left_open_by_a_raising_phase_is_closed_before_done() -> None:
    """Req 14.14, through the document phases. A step left open is a spinner that never
    resolves, and the phase most likely to raise is the one that renders."""

    async def handler(invocation, steps) -> AsyncIterator[dict[str, Any]]:
        del invocation
        yield steps.start(TOOL_RENDER_DOCUMENT, label="Rendering", status="Emitting")
        raise RuntimeError("LibreOffice fell over")

    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_GENERATE_REPORT: handler},
        )
    )
    tools = [(e["name"], e["phase"]) for e in events if e["type"] == "tool"]

    assert tools == [(TOOL_RENDER_DOCUMENT, "start"), (TOOL_RENDER_DOCUMENT, "end")]
    assert types_of(events).index("error") < types_of(events).index("done")
    assert types_of(events)[-1] == "done"


def one(events: list[dict[str, Any]], kind: str) -> dict[str, Any]:
    matches = [event for event in events if event["type"] == kind]
    assert len(matches) == 1, f"expected exactly one {kind}, got {types_of(events)}"
    return matches[0]


# --------------------------------------------------------------------------- #
# Req 42.11 — a silent phase still speaks
# --------------------------------------------------------------------------- #


class SimulatedClock:
    """One timeline the ticker and the phase share; time moves only when advanced."""

    def __init__(self) -> None:
        self.now = 0.0
        self._waiters: list[tuple[float, asyncio.Event]] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        if seconds <= 0:
            await asyncio.sleep(0)
            return
        waiter = asyncio.Event()
        self._waiters.append((self.now + seconds, waiter))
        await waiter.wait()

    async def advance(self, seconds: float) -> None:
        self.now += seconds
        due = [w for deadline, w in self._waiters if deadline <= self.now]
        self._waiters = [(d, w) for d, w in self._waiters if d > self.now]
        for waiter in due:
            waiter.set()
        for _ in range(8):
            await asyncio.sleep(0)


def test_a_silent_ten_minute_verify_phase_emits_a_heartbeat_at_least_every_thirty_seconds() -> None:
    """Req 42.11, and the reason it is a requirement at all.

    Verification reads the whole document twice and has a 600-second budget. With nothing to
    say for ten minutes it would sit inside the relay's 120-second inactivity window and be
    killed for being slow rather than for being wrong — a healthy run, failed by its own
    silence. The ticker is what prevents that, and only a test that models time can see it.
    """
    clock = SimulatedClock()
    arrivals: list[tuple[float, str]] = []

    async def silent_verify() -> AsyncIterator[dict[str, Any]]:
        yield {"type": "tool", "name": TOOL_VERIFY_DOCUMENT, "phase": "start", "id": "v"}
        for _ in range(int(SILENT_VERIFY_S / HEARTBEAT_INTERVAL_S)):
            await clock.sleep(HEARTBEAT_INTERVAL_S)
        yield {"type": "verification", "status": "pass"}

    async def go() -> None:
        merged = merge_with_heartbeat(
            silent_verify(), clock=clock, sleep=clock.sleep
        ).__aiter__()

        async def pump() -> None:
            async for event in merged:
                arrivals.append((clock.now, event["type"]))

        task = asyncio.create_task(pump())
        for _ in range(int(SILENT_VERIFY_S / HEARTBEAT_INTERVAL_S) + 2):
            await clock.advance(HEARTBEAT_INTERVAL_S)
        await asyncio.wait_for(task, timeout=5.0)

    asyncio.run(asyncio.wait_for(go(), timeout=30.0))

    assert [kind for _, kind in arrivals].count("heartbeat") >= int(
        SILENT_VERIFY_S / (HEARTBEAT_INTERVAL_S + HEARTBEAT_TOLERANCE_S)
    )
    gaps = [later - earlier for (earlier, _), (later, _) in pairwise(arrivals)]
    assert gaps, arrivals
    assert max(gaps) <= MAX_EVENT_GAP_S, (
        f"a {max(gaps)}s gap opened during a silent verify phase; the relay's inactivity "
        f"window is 120s and Req 42.11 caps the gap at {MAX_EVENT_GAP_S}s"
    )


def test_the_declared_heartbeat_constants_bound_the_relays_window() -> None:
    """The arithmetic Req 42.11 rests on, asserted rather than assumed: one missed tick
    plus the tolerance must still fall inside the cap."""
    assert HEARTBEAT_INTERVAL_S == 15.0
    assert HEARTBEAT_TOLERANCE_S == 5.0
    assert HEARTBEAT_INTERVAL_S + HEARTBEAT_TOLERANCE_S <= MAX_EVENT_GAP_S
    assert MAX_EVENT_GAP_S <= 30.0
