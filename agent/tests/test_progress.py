"""Unit tests for `progress.py` — the run-state callback.

Every test runs against a fake transport and an injected clock, so nothing here opens a
socket or waits on wall-clock time. What is asserted is the contract the run state
machine depends on: the token is in the header and nowhere else, a failure is retried
once and then abandoned without ending the run, and the throttle bounds in-phase
progress without ever delaying a transition or the terminal callback.

Task 5.9 owns the simulated-time throttle assertions alongside the heartbeat. The
throttle coverage here is the example-based floor: one refresh admitted, the next
suppressed, both guards exempt.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from reporting_agent.progress import (
    AGENT_PHASES,
    PROGRESS_MAX_ATTEMPTS,
    PROGRESS_THROTTLE_S,
    PROGRESS_TIMEOUT_S,
    TERMINAL_PHASES,
    TOKEN_HEADER,
    HttpxProgressTransport,
    ProgressReporter,
    ProgressTransport,
)
from reporting_agent.redaction import discard_secrets

RUN_ID = "run_01HZX8QW9K7YB4T2C3M5N6P7QR"
TOKEN = "a3f9c1d2e4b5a6978877665544332211a3f9c1d2e4b5a697"
URL = "https://app.example.test/api/internal/runs/" + RUN_ID + "/progress"


@pytest.fixture(autouse=True)
def _clear_secret_registry():
    """Constructing a reporter registers its token as a secret (Req 15.1).

    The registry is a `ContextVar`, so without this the token registered by one test
    would keep scrubbing later tests' output.
    """
    yield
    discard_secrets()


class FakeTransport:
    """Records every request and replays a scripted sequence of outcomes.

    An entry is either an `int` status code or an exception instance to raise. The last
    entry repeats once the script is exhausted, so a test that wants "always fails" gives
    one entry.
    """

    def __init__(self, script: list[object] | None = None) -> None:
        self.script: list[object] = list(script or [204])
        self.calls: list[dict[str, object]] = []

    async def post_json(self, url, *, body, headers, timeout) -> int:
        self.calls.append(
            {
                "url": url,
                "body": dict(body),
                "headers": dict(headers),
                "timeout": timeout,
            }
        )
        outcome = self.script[min(len(self.calls) - 1, len(self.script) - 1)]
        if isinstance(outcome, BaseException):
            raise outcome
        return int(outcome)  # type: ignore[arg-type]


class FakeClock:
    """A monotonic clock advanced by hand, so the throttle is tested in zero real time."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def reporter(
    transport: ProgressTransport | None = None,
    *,
    clock=None,
    progress_url: str | None = URL,
    progress_token: str | None = TOKEN,
    run_id: str | None = RUN_ID,
) -> ProgressReporter:
    return ProgressReporter(
        progress_url=progress_url,
        progress_token=progress_token,
        run_id=run_id,
        transport=transport if transport is not None else FakeTransport(),
        clock=clock if clock is not None else FakeClock(),
    )


async def _report_and_drain(target: ProgressReporter, *args, **kwargs) -> None:
    """`report` is fire-and-forget, so a test has to let the scheduled task finish."""
    await target.report(*args, **kwargs)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    pending = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


# --- the token: header only (Req 38.2, 15.7) -----------------------------------------


def test_token_travels_in_the_header():
    transport = FakeTransport()
    asyncio.run(_report_and_drain(reporter(transport), "collecting"))

    assert transport.calls[0]["headers"][TOKEN_HEADER] == TOKEN


def test_token_is_absent_from_the_request_target_and_the_body():
    transport = FakeTransport()

    async def scenario() -> None:
        target = reporter(transport)
        await _report_and_drain(target, "collecting", current=12, total=200, label="Inventory")
        await target.report_terminal("completed", snapshot_id="a" * 64, resource_count=200)

    asyncio.run(scenario())

    assert transport.calls, "no callback was sent"
    for call in transport.calls:
        assert TOKEN not in str(call["url"])
        assert TOKEN not in str(call["body"])
        assert not any(key.lower() == "token" for key in call["body"])


def test_a_token_shaped_body_field_is_dropped():
    transport = FakeTransport()

    async def scenario() -> None:
        target = reporter(transport)
        # A caller reaching straight for the body builder must not be able to place a
        # credential in it.
        body = target._build_body("collecting", progress_token=TOKEN, current=1)
        assert "progress_token" not in body
        assert body["current"] == 1

    asyncio.run(scenario())


# --- the body (Req 38.1, 38.12) ------------------------------------------------------


def test_non_terminal_body_carries_run_id_phase_and_the_countable_fields():
    transport = FakeTransport()
    asyncio.run(
        _report_and_drain(
            reporter(transport), "collecting", current=142, total=200, label="Inventory"
        )
    )

    assert transport.calls[0]["body"] == {
        "run_id": RUN_ID,
        "phase": "collecting",
        "current": 142,
        "total": 200,
        "label": "Inventory",
    }


def test_a_phase_without_a_countable_unit_of_work_omits_the_counts():
    transport = FakeTransport()
    asyncio.run(_report_and_drain(reporter(transport), "collecting"))

    assert transport.calls[0]["body"] == {"run_id": RUN_ID, "phase": "collecting"}


def test_completed_carries_its_terminal_fields_and_no_progress_columns():
    transport = FakeTransport()

    async def scenario() -> None:
        await reporter(transport).report_terminal(
            "completed", snapshot_id="b" * 64, resource_count=200, gap_count=3
        )

    asyncio.run(scenario())

    assert transport.calls[0]["body"] == {
        "run_id": RUN_ID,
        "phase": "completed",
        "snapshot_id": "b" * 64,
        "resource_count": 200,
        "gap_count": 3,
    }


def test_failed_carries_its_own_terminal_fields_and_drops_the_other_phases():
    transport = FakeTransport()

    async def scenario() -> None:
        await reporter(transport).report_terminal(
            "failed",
            error_code="EMPTY_SCOPE",
            error_message="inventory resolved zero resources",
            snapshot_id="c" * 64,
        )

    asyncio.run(scenario())

    assert transport.calls[0]["body"] == {
        "run_id": RUN_ID,
        "phase": "failed",
        "error_code": "EMPTY_SCOPE",
        "error_message": "inventory resolved zero resources",
    }


def test_an_over_long_error_message_is_truncated_rather_than_refused():
    transport = FakeTransport()

    async def scenario() -> None:
        await reporter(transport).report_terminal(
            "failed", error_code="THROTTLED", error_message="x" * 5000
        )

    asyncio.run(scenario())

    body = transport.calls[0]["body"]
    assert len(body["error_message"]) == 2000
    assert body["error_code"] == "THROTTLED"


def test_an_over_long_label_is_truncated_and_the_transition_still_lands():
    transport = FakeTransport()
    asyncio.run(
        _report_and_drain(
            reporter(transport), "collecting", current=1, total=200, label="L" * 200
        )
    )

    body = transport.calls[0]["body"]
    assert len(body["label"]) == 64
    assert body["current"] == 1


def test_an_out_of_range_count_is_dropped_and_the_transition_still_lands():
    transport = FakeTransport()
    asyncio.run(
        _report_and_drain(reporter(transport), "collecting", current=-3, total=0, label="Metrics")
    )

    assert transport.calls[0]["body"] == {
        "run_id": RUN_ID,
        "phase": "collecting",
        "label": "Metrics",
    }


def test_a_presented_timeout_code_is_dropped_because_the_reaper_owns_it():
    transport = FakeTransport()

    async def scenario() -> None:
        await reporter(transport).report_terminal(
            "failed", error_code="TIMEOUT", error_message="phase expired"
        )

    asyncio.run(scenario())

    body = transport.calls[0]["body"]
    assert "error_code" not in body
    assert body["phase"] == "failed"


# --- retry, timeout and never ending a run (Req 38.3, 38.4) --------------------------


def test_a_failure_is_retried_exactly_once_then_abandoned():
    transport = FakeTransport([RuntimeError("connection reset")])

    async def scenario() -> None:
        await reporter(transport).report_terminal("completed", snapshot_id="d" * 64)

    asyncio.run(scenario())

    assert len(transport.calls) == PROGRESS_MAX_ATTEMPTS == 2


def test_a_non_success_status_is_retried_and_a_success_stops_the_retry():
    transport = FakeTransport([500, 204])

    async def scenario() -> None:
        await reporter(transport).report_terminal("completed", snapshot_id="e" * 64)

    asyncio.run(scenario())

    assert len(transport.calls) == 2


def test_a_first_attempt_success_is_not_retried():
    transport = FakeTransport([204])

    async def scenario() -> None:
        await reporter(transport).report_terminal("completed", snapshot_id="f" * 64)

    asyncio.run(scenario())

    assert len(transport.calls) == 1


def test_a_transport_that_never_completes_is_timed_out_and_raises_nothing(monkeypatch, caplog):
    """A transport ignoring its own timeout must still not hang the run (Req 38.3).

    The deadline is shortened rather than waited out: the assertion is that
    `asyncio.wait_for` bounds each attempt at all, not that the bound is five seconds —
    `test_the_declared_constants_match_the_contract` pins the number.

    The log line is asserted as well as the outcome, and deliberately so. `_deliver`
    swallows everything, so "raised nothing and retried twice" is equally true of the
    broad `except Exception` fallback below the timeout handler — an outcome assertion
    cannot tell the two arms apart. The message can: a timeout says *slow*, an exception
    says *broken*, and that distinction is the only operational signal a swallowed
    failure leaves behind. Asserting no record carries a formatted traceback is what
    holds the timeout on its own arm, because the fallback logs `scrub_exception`.
    """
    from reporting_agent import progress as progress_module

    monkeypatch.setattr(progress_module, "PROGRESS_TIMEOUT_S", 0.01)

    class HangingTransport:
        def __init__(self) -> None:
            self.calls = 0

        async def post_json(self, url, *, body, headers, timeout) -> int:
            self.calls += 1
            await asyncio.sleep(3600)
            return 204

    transport = HangingTransport()

    async def scenario() -> None:
        await reporter(transport).report_terminal("completed", snapshot_id="0" * 64)

    with caplog.at_level(logging.WARNING, logger="reporting_agent.progress"):
        asyncio.run(scenario())

    assert transport.calls == PROGRESS_MAX_ATTEMPTS

    messages = [record.getMessage() for record in caplog.records]
    timed_out = [message for message in messages if "did not complete within" in message]
    assert len(timed_out) == PROGRESS_MAX_ATTEMPTS, (
        "every timed-out attempt must be logged from the timeout handler, not from the "
        f"broad fallback below it; got {messages!r}"
    )
    assert not any("Traceback" in message for message in messages), (
        "a timeout was formatted as an exception, so it reached the `except Exception` "
        f"fallback instead of the timeout handler: {messages!r}"
    )
    assert any("abandoned" in message for message in messages)


def test_report_raises_nothing_when_the_transport_raises():
    transport = FakeTransport([RuntimeError("boom")])

    async def scenario() -> None:
        await _report_and_drain(reporter(transport), "collecting", current=1, total=2)

    # No exception escapes: a run must not die because it could not report its progress.
    asyncio.run(scenario())
    assert len(transport.calls) == PROGRESS_MAX_ATTEMPTS


def test_a_failure_is_logged_with_the_token_excluded(caplog):
    transport = FakeTransport([RuntimeError(f"upstream rejected token {TOKEN}")])

    async def scenario() -> None:
        await reporter(transport).report_terminal("completed", snapshot_id="1" * 64)

    with caplog.at_level(logging.WARNING, logger="reporting_agent.progress"):
        asyncio.run(scenario())

    assert caplog.records, "a failed callback logged nothing"
    for record in caplog.records:
        assert TOKEN not in record.getMessage()
    assert any("abandoned" in record.getMessage() for record in caplog.records)


def test_report_is_fire_and_forget_and_does_not_await_the_response():
    started = asyncio.Event()
    released = asyncio.Event()

    class BlockingTransport:
        def __init__(self) -> None:
            self.calls = 0

        async def post_json(self, url, *, body, headers, timeout) -> int:
            self.calls += 1
            started.set()
            await released.wait()
            return 204

    transport = BlockingTransport()

    async def scenario() -> None:
        target = reporter(transport)
        await target.report("collecting", current=1, total=200)
        # The response is still blocked, yet `report` has already returned.
        assert not released.is_set()
        await asyncio.wait_for(started.wait(), timeout=1.0)
        released.set()
        await target.aclose()

    asyncio.run(scenario())
    assert transport.calls == 1


# --- the throttle and its two positive guards (Req 38.15) ---------------------------


def test_an_in_phase_refresh_inside_the_window_is_suppressed():
    transport = FakeTransport()
    clock = FakeClock()

    async def scenario() -> None:
        target = reporter(transport, clock=clock)
        await _report_and_drain(target, "collecting", current=1, total=200)
        clock.advance(PROGRESS_THROTTLE_S - 0.01)
        await _report_and_drain(target, "collecting", current=2, total=200)

    asyncio.run(scenario())

    assert len(transport.calls) == 1, "a refresh inside the 5s window was sent"


def test_an_in_phase_refresh_after_the_window_is_admitted():
    transport = FakeTransport()
    clock = FakeClock()

    async def scenario() -> None:
        target = reporter(transport, clock=clock)
        await _report_and_drain(target, "collecting", current=1, total=200)
        clock.advance(PROGRESS_THROTTLE_S)
        await _report_and_drain(target, "collecting", current=90, total=200)

    asyncio.run(scenario())

    assert len(transport.calls) == 2
    assert transport.calls[1]["body"]["current"] == 90


def test_many_folded_batches_inside_one_window_produce_one_request():
    transport = FakeTransport()
    clock = FakeClock()

    async def scenario() -> None:
        target = reporter(transport, clock=clock)
        for index in range(200):
            clock.advance(0.01)
            await _report_and_drain(target, "collecting", current=index, total=200)

    asyncio.run(scenario())

    # 200 folds over 2 simulated seconds: the transition plus nothing else.
    assert len(transport.calls) == 1


def test_a_phase_transition_is_sent_at_the_instant_it_occurs():
    transport = FakeTransport()
    clock = FakeClock()

    async def scenario() -> None:
        target = reporter(transport, clock=clock)
        await _report_and_drain(target, "collecting", current=1, total=200)
        # No time passes at all, so the throttle window is wide open.
        await target.report_terminal("completed", snapshot_id="2" * 64)

    asyncio.run(scenario())

    assert [call["body"]["phase"] for call in transport.calls] == ["collecting", "completed"]


def test_the_terminal_callback_is_sent_irrespective_of_the_limit():
    transport = FakeTransport()
    clock = FakeClock()

    async def scenario() -> None:
        target = reporter(transport, clock=clock)
        await _report_and_drain(target, "collecting", current=1, total=200)
        clock.advance(0.001)
        await target.report_terminal("failed", error_code="THROTTLED", error_message="429s")

    asyncio.run(scenario())

    assert len(transport.calls) == 2
    assert transport.calls[1]["body"]["phase"] == "failed"


# --- phase validation and the disabled reporter -------------------------------------


def test_a_phase_the_agent_may_not_present_is_not_sent():
    """`queued` and `claimed` belong to the Reaper — an agent presenting `claimed` is
    claiming to have done the claiming — and `TIMEOUT`'s phase likewise.

    `compiling`, `rendering` and `verifying` were here too until the document pipeline
    landed and `lib/runs/state.ts` gained their transitions. They are now sent, which the
    test below asserts, so this one keeps only the phases that remain the app's.
    """
    transport = FakeTransport()

    async def scenario() -> None:
        target = reporter(transport)
        for phase in ("queued", "claimed", "not_a_phase"):
            await _report_and_drain(target, phase)

    asyncio.run(scenario())

    assert transport.calls == []


def test_every_document_phase_is_presented():
    """Req 41.10 — the agent drives `compiling`, `rendering` and `verifying`.

    Non-vacuity for the refusal above: a reporter that dropped everything would satisfy it
    while failing every run's transitions and leaving the Reaper to time each one out.
    """
    transport = FakeTransport()

    async def scenario() -> None:
        target = reporter(transport)
        for phase in ("compiling", "rendering", "verifying"):
            await _report_and_drain(target, phase)

    asyncio.run(scenario())

    assert [call["body"]["phase"] for call in transport.calls] == [
        "compiling",
        "rendering",
        "verifying",
    ]


def test_report_routes_a_terminal_phase_through_the_awaited_path():
    transport = FakeTransport()

    async def scenario() -> None:
        target = reporter(transport)
        # Awaiting `report` must not lose a terminal callback: losing it costs a false
        # TIMEOUT on a run that succeeded.
        await target.report("completed")

    asyncio.run(scenario())

    assert len(transport.calls) == 1
    assert transport.calls[0]["body"]["phase"] == "completed"


def test_nothing_is_sent_after_the_terminal_callback():
    transport = FakeTransport()

    async def scenario() -> None:
        target = reporter(transport)
        await target.report_terminal("completed", snapshot_id="3" * 64)
        await _report_and_drain(target, "collecting", current=5, total=200)

    asyncio.run(scenario())

    assert len(transport.calls) == 1


def test_a_reporter_without_a_run_is_disabled_and_sends_nothing():
    for kwargs in (
        {"progress_url": None},
        {"progress_token": None},
        {"run_id": None},
        {"progress_url": "   "},
    ):
        transport = FakeTransport()

        async def scenario(kwargs=kwargs, transport=transport) -> None:
            target = reporter(transport, **kwargs)
            assert target.enabled is False
            await _report_and_drain(target, "collecting", current=1, total=2)
            await target.report_terminal("completed", snapshot_id="4" * 64)

        asyncio.run(scenario())
        assert transport.calls == []


def test_a_non_terminal_phase_offered_to_report_terminal_sends_nothing():
    transport = FakeTransport()

    async def scenario() -> None:
        await reporter(transport).report_terminal("collecting")

    asyncio.run(scenario())

    assert transport.calls == []


# --- constants and the injected transport -------------------------------------------


def test_the_declared_constants_match_the_contract():
    assert PROGRESS_TIMEOUT_S == 5.0
    assert PROGRESS_MAX_ATTEMPTS == 2
    assert PROGRESS_THROTTLE_S == 5.0
    assert TOKEN_HEADER == "X-Rpt-Progress-Token"
    assert TERMINAL_PHASES == {"completed", "failed"}
    assert AGENT_PHASES == {
        "collecting",
        "compiling",
        "rendering",
        "verifying",
        "completed",
        "failed",
    }


def test_the_transport_timeout_is_passed_through():
    transport = FakeTransport()
    asyncio.run(_report_and_drain(reporter(transport), "collecting"))

    assert transport.calls[0]["timeout"] == PROGRESS_TIMEOUT_S


def test_the_fake_and_the_httpx_transport_both_satisfy_the_protocol():
    assert isinstance(FakeTransport(), ProgressTransport)
    assert isinstance(HttpxProgressTransport(), ProgressTransport)


def test_the_httpx_transport_posts_json_with_the_header_and_opens_no_socket():
    class RecordingClient:
        def __init__(self) -> None:
            self.posts: list[dict[str, object]] = []

        async def post(self, url, *, json, headers, timeout):
            self.posts.append(
                {"url": url, "json": json, "headers": headers, "timeout": timeout}
            )

            class Response:
                status_code = 204

            return Response()

        async def aclose(self) -> None:
            self.closed = True

    client = RecordingClient()
    transport = HttpxProgressTransport(client=client)

    async def scenario() -> None:
        target = reporter(transport)
        await target.report_terminal("completed", snapshot_id="5" * 64)

    asyncio.run(scenario())

    assert client.posts[0]["headers"][TOKEN_HEADER] == TOKEN
    assert client.posts[0]["json"]["phase"] == "completed"
    assert client.posts[0]["timeout"] == PROGRESS_TIMEOUT_S


# --------------------------------------------------------------------------- #
# Req 41.5 — the verification callback carries a pointer
# --------------------------------------------------------------------------- #


def _verification_reporter(transport):
    return ProgressReporter(
        progress_url=f"https://app.test/api/internal/runs/{RUN_ID}/progress",
        progress_token=TOKEN,
        run_id=RUN_ID,
        transport=transport,
    )


def test_the_verification_callback_goes_to_the_sibling_endpoint():
    """Derived from `progress_url` by replacing its last segment, rather than carried as
    a thirteenth context field — the two are one endpoint pair, and a context that could
    name them independently is a context that could name a mismatched pair."""
    transport = FakeTransport()

    asyncio.run(
        _verification_reporter(transport).report_verification(
            attempt_id="att-1",
            status="pass",
            figure_count=12,
            snapshot_sha256="a" * 64,
            docx_sha256="b" * 64,
            pdf_sha256="c" * 64,
            artifact_key="usr_1/reports/run_1/verification-att-1.json",
        )
    )

    assert len(transport.calls) == 1
    assert transport.calls[0]["url"] == (
        f"https://app.test/api/internal/runs/{RUN_ID}/verification"
    )


def test_the_verification_callback_carries_a_key_and_no_findings():
    """The whole point of the pointer design. A 1,000-finding list with 200-character
    excerpts is several hundred kilobytes, and a fire-and-forget POST abandoned after
    five seconds would fail most reliably on the run carrying the most findings."""
    transport = FakeTransport()

    asyncio.run(
        _verification_reporter(transport).report_verification(
            attempt_id="att-1",
            status="fail",
            figure_count=0,
            snapshot_sha256="a" * 64,
            docx_sha256="b" * 64,
            pdf_sha256="c" * 64,
            artifact_key="usr_1/reports/run_1/verification-att-1.json",
        )
    )

    body = transport.calls[0]["body"]
    assert body["artifact_key"].endswith("verification-att-1.json")
    assert set(body) == {
        "run_id",
        "attempt_id",
        "status",
        "figure_count",
        "snapshot_sha256",
        "docx_sha256",
        "pdf_sha256",
        "artifact_key",
    }
    assert "findings" not in body
    assert "counts" not in body
    assert TOKEN not in str(body), "the token travels in the header, never in the body"


def test_the_verification_callback_never_raises_and_never_fails_the_run():
    """A verification that did not land leaves the row short of its proof, and
    `verifying → completed` then refuses — which the reaper resolves as a TIMEOUT.

    Worse than a landed callback, and much better than a run that died trying to report
    itself.
    """

    class Broken:
        async def post_json(self, url, *, body, headers, timeout):
            raise RuntimeError("the app is down")

    asyncio.run(
        _verification_reporter(Broken()).report_verification(
            attempt_id="att-1",
            status="pass",
            figure_count=1,
            snapshot_sha256="a" * 64,
            docx_sha256="b" * 64,
            pdf_sha256="c" * 64,
            artifact_key="usr_1/reports/run_1/verification-att-1.json",
        )
    )


def test_a_disabled_reporter_sends_no_verification_callback():
    """A chat prompt carries no run, so there is nothing to record against."""
    transport = FakeTransport()
    disabled = ProgressReporter(
        progress_url=None, progress_token=None, run_id=None, transport=transport
    )

    asyncio.run(
        disabled.report_verification(
            attempt_id="att-1",
            status="pass",
            figure_count=1,
            snapshot_sha256="a" * 64,
            docx_sha256="b" * 64,
            pdf_sha256="c" * 64,
            artifact_key="k",
        )
    )

    assert transport.calls == []


async def _drain_pending() -> None:
    """Let every scheduled delivery finish, including ones chained behind others."""
    for _ in range(50):
        pending = [
            task
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task()
            and task.get_name().startswith("progress-callback-")
        ]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)
    raise AssertionError("progress callbacks did not settle")


class TestCallbacksArriveInTheOrderTheyWereReported:
    """The endpoint advances a chain, so delivery order is not cosmetic.

    `collecting -> compiling -> rendering -> verifying -> completed`, and criterion 38.10
    refuses any hop that skips a link. Dispatch is concurrent by design — `report` must not
    block a collector fold on the app's response — but two POSTs in flight at once arrive in
    whatever order the network settles.

    Run `442b4a63` is what that costs. `compiling` and `rendering` were scheduled 34 ms
    apart; `rendering` landed first, was refused against a row still at `collecting`, and
    retried immediately against the same stale row. `compiling` landed after. The row stayed
    at `compiling` while the runtime rendered, verified and reported `completed` — each
    refused for the same reason — and the reaper failed a complete, verified run as
    `TIMEOUT` six minutes later.

    Intermittent, too: the very next run delivered in order and advanced normally. So a test
    that merely reports two phases and checks the order proves nothing — the bug needs the
    first POST to be **slower than the second**, which is what `_OutOfOrderTransport` forces.
    """

    class _OutOfOrderTransport:
        """Records arrival order, and delays the first request past the second.

        Without the delay both requests complete in scheduling order on the event loop and
        the assertion passes against the defect — the fixture would be too clean to express
        the failure, which is the shape this repository has been bitten by before.
        """

        def __init__(self, first_delay: float = 0.05) -> None:
            self.arrivals: list[str] = []
            self._first_delay = first_delay
            self._seen = 0

        async def post_json(self, url, *, body, headers, timeout) -> int:
            self._seen += 1
            if self._seen == 1:
                await asyncio.sleep(self._first_delay)
            self.arrivals.append(str(body["phase"]))
            return 204

    def test_a_slow_first_callback_does_not_let_the_second_overtake_it(self) -> None:
        async def scenario() -> None:
            transport = self._OutOfOrderTransport()
            target = reporter(transport, clock=FakeClock())

            await target.report("compiling")
            await target.report("rendering")
            await _drain_pending()

            assert transport.arrivals == ["compiling", "rendering"], (
                "the second callback overtook the first, so the endpoint sees a hop that "
                "skips a link and refuses it"
            )
        asyncio.run(scenario())

    def test_the_whole_chain_arrives_in_order(self) -> None:
        async def scenario() -> None:
            transport = self._OutOfOrderTransport()
            target = reporter(transport, clock=FakeClock())

            for phase in ("collecting", "compiling", "rendering", "verifying"):
                await target.report(phase)
            await _drain_pending()

            assert transport.arrivals == [
                "collecting",
                "compiling",
                "rendering",
                "verifying",
            ]
        asyncio.run(scenario())

    def test_the_terminal_callback_waits_behind_the_chain(self) -> None:
        async def scenario() -> None:
            """`completed` is reachable only from `verifying`, and losing it costs a false
            `TIMEOUT` on a finished run — the one callback whose ordering matters most."""
            transport = self._OutOfOrderTransport()
            target = reporter(transport, clock=FakeClock())

            await target.report("rendering")
            await target.report("verifying")
            await target.report_terminal("completed")

            assert transport.arrivals == ["rendering", "verifying", "completed"]
        asyncio.run(scenario())

    def test_a_refused_predecessor_does_not_stop_the_next_callback(self) -> None:
        async def scenario() -> None:
            """The chain orders delivery; it does not make one callback conditional on
            another. A predecessor the app refuses is still the reaper's problem, and the
            callbacks after it must still be attempted."""
            transport = FakeTransport([404, 204, 204])
            target = reporter(transport, clock=FakeClock())

            await target.report("compiling")
            await target.report("rendering")
            await _drain_pending()

            phases = [str(call["body"]["phase"]) for call in transport.calls]
            assert "rendering" in phases, (
                "a refused `compiling` stopped `rendering` from being sent at all"
            )
        asyncio.run(scenario())
