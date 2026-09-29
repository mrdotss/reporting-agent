"""A slow narrator costs a paragraph, never the report.

Run 779dafa2 (29 Sep 2026) was failed by the reaper with "Phase compiling exceeded its
deadline". Every figure had compiled; the executive summary's model call had not answered.
Kimi K3 on Bedrock peaked at 165 seconds per call that hour, the client's defaults allowed
five 60-second read timeouts in a row, and narration runs inside the compiling phase, whose
deadline is 300 seconds. The runtime went on to render and verify a complete report that
the app had already failed.

Two bounds close it: the prose client gives up after two attempts, and a document stops
asking for prose once narration has spent `PROSE_BUDGET_S`.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from reporting_agent.compile.blocks import PROSE_BUDGET_S, _phase_two
from reporting_agent.compile.blocks.base import Deferred
from reporting_agent.narrate.summary import (
    PROSE_MAX_ATTEMPTS,
    PROSE_READ_TIMEOUT_S,
    prose_generator,
)


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class _SlowProvider:
    """Each call advances the clock by `seconds`, as a slow model would."""

    def __init__(self, clock: _Clock, seconds: float) -> None:
        self.clock = clock
        self.seconds = seconds
        self.asked: list[str] = []

    def narrate(self, request: SimpleNamespace) -> str:
        self.asked.append(request.block_id)
        self.clock.now += self.seconds
        return f"prose for {request.block_id}"


def _deferrals(*ids: str) -> list[Deferred]:
    return [
        Deferred(block_id=i, finish=lambda _p: (), prose_request=SimpleNamespace(block_id=i))
        for i in ids
    ]


def test_blocks_after_the_budget_render_without_prose(caplog: pytest.LogCaptureFixture) -> None:
    clock = _Clock()
    provider = _SlowProvider(clock, seconds=70)
    context = SimpleNamespace(prose=provider)

    with caplog.at_level(logging.WARNING):
        answers = _phase_two(
            context, _deferrals("a", "b", "c", "d"), clock=clock, budget_s=120  # type: ignore[arg-type]
        )

    # a starts at 0s, b at 70s (still inside), c at 140s: over, so c and d are not asked.
    assert provider.asked == ["a", "b"]
    assert answers == {"a": "prose for a", "b": "prose for b", "c": None, "d": None}
    budget_lines = [r for r in caplog.records if "narration used its" in r.getMessage()]
    assert len(budget_lines) == 1


def test_a_quick_narrator_is_never_cut_short() -> None:
    clock = _Clock()
    provider = _SlowProvider(clock, seconds=6)
    answers = _phase_two(
        SimpleNamespace(prose=provider), _deferrals("a", "b", "c"), clock=clock  # type: ignore[arg-type]
    )
    assert provider.asked == ["a", "b", "c"]
    assert all(answers[i] == f"prose for {i}" for i in "abc")


def test_the_budget_and_one_bounded_call_fit_inside_the_compiling_deadline() -> None:
    """The app's `PHASE_DEADLINE_SECONDS.compiling` is 300. The budget is checked before
    each call, so the worst case is the budget plus one call at its own bound."""
    worst_call = PROSE_READ_TIMEOUT_S * PROSE_MAX_ATTEMPTS
    assert PROSE_BUDGET_S + worst_call <= 250


def test_the_prose_client_bounds_its_read_timeout_and_retries() -> None:
    generator = prose_generator("test.prose-model", region="us-east-1")
    assert generator is not None
    config = generator.client.meta.config
    assert config.read_timeout == PROSE_READ_TIMEOUT_S
    assert config.retries == {"mode": "standard", "total_max_attempts": PROSE_MAX_ATTEMPTS}
