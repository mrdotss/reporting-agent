"""The configured prose model reaches the pipeline — Req 19.1.

`config.py` **requires** `RPT_PROSE_MODEL_ID`: a runtime without one refuses to start,
because "a silently substituted model id changes the wording of a delivered document
without appearing in any diff". That guard covers the value being *present*. It does not
cover the value being *spent*, and for four production runs it was not: `handle_generate_
report` passed every other configured field and omitted this one, so `run_generate_report`
fell back to its `prose_model_id: str = ""` default.

Nothing raised. `prose_generator("")` returned `None` on the one branch that logged
nothing, `_phase_two` skipped every deferred block on a condition that logged nothing, and
the delivered report carried "The historical commentary could not be written for this
report." with an empty `prose.json` beside it. Three layers each did the safe thing —
a missing narrator costs a paragraph, not a report — and the composition of three safe
silences was a feature that had never once run in production.

So the assertion here is deliberately about the **call**, not the output: the failure was
never in the narrator, and a test that mocked a model would have passed throughout.
"""

from __future__ import annotations

import os
import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from reporting_agent import main as main_module  # noqa: E402
from reporting_agent.main import CONFIG, Invocation, StepTracker  # noqa: E402
from reporting_agent.progress import ProgressReporter  # noqa: E402


def _invocation() -> Invocation:
    return Invocation(
        command="generate_report",
        actor_id="actor-1",
        session_id="s" * 33,
        run_id="run-1",
        payload={"command": "generate_report"},
        context={},
        progress=ProgressReporter(
            progress_url=None, progress_token=None, run_id=None
        ),
    )


async def _drive(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Run `handle_generate_report` with the pipeline replaced by a recorder."""
    seen: dict[str, Any] = {}

    async def recorder(**kwargs: Any) -> AsyncIterator[Any]:
        seen.update(kwargs)
        return
        yield  # pragma: no cover - never reached, makes this an async generator

    import reporting_agent.report_pipeline as pipeline

    monkeypatch.setattr(pipeline, "run_generate_report", recorder)
    invocation = _invocation()
    steps = StepTracker()
    async for _ in main_module.handle_generate_report(invocation, steps):
        pass
    return seen


def test_the_configured_prose_model_reaches_the_pipeline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The regression itself. Removing `prose_model_id=CONFIG.prose_model_id` from the
    call site fails here and nowhere else in the suite."""
    seen = asyncio.run(_drive(monkeypatch))
    assert seen["prose_model_id"] == CONFIG.prose_model_id


def test_what_reaches_the_pipeline_is_never_the_empty_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stronger than equality with `CONFIG`, and the assertion that actually bites: the
    empty string is the value that produced four narrative-less reports, and it is also
    what `CONFIG.prose_model_id` would equal if the configuration guard were ever relaxed
    to a default. Both routes to the outage are closed by this one line."""
    seen = asyncio.run(_drive(monkeypatch))
    assert seen["prose_model_id"], (
        "an empty prose model id makes `prose_generator` return None and every deferred "
        "block render its fallback"
    )


def test_an_empty_model_id_is_reported_rather_than_returning_a_silent_none(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The second half of the silence. `prose_generator` still returns `None` — a report
    with no narrative is a complete report and must not raise — but it now says so, which
    is what turns the next occurrence of this class of fault into one grep."""
    from reporting_agent.narrate.summary import prose_generator

    with caplog.at_level("WARNING"):
        assert prose_generator("") is None
    assert any(
        "no prose model id" in record.getMessage() for record in caplog.records
    ), [r.getMessage() for r in caplog.records]


def test_a_configured_model_id_logs_no_such_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Mutation guard: the warning must be conditional on the fault, not unconditional."""
    from reporting_agent.narrate.summary import prose_generator

    with caplog.at_level("WARNING"):
        prose_generator("test.prose-model", region="us-east-1")
    assert not any(
        "no prose model id" in record.getMessage() for record in caplog.records
    )
