"""What Ask shows while the answer model is still thinking: the intent sentence and the
masked reasoning (`narrate/intent.py`, `chat/thinking.py`, `chat/session.py`).

Both exist so a question is not a silent spinner, and both sit outside the answer's
figure check — so the rule that no model produces a number is enforced on them here.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import pytest

from reporting_agent.chat.thinking import MASK, MAX_THINKING_CHARS, ThinkingMask, mask_numbers
from reporting_agent.narrate.chat import GUARDRAIL_INTERVENED
from reporting_agent.narrate.intent import (
    INTENT_MAX_CHARS,
    BedrockIntentWriter,
    bedrock_intent_writer,
    clean_intent,
    undigit,
)
from test_invoke_chat import FakePrices, _answer, _done, _payload, _seeded_store

# --------------------------------------------------------------------------- #
# The reasoning mask
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "shown"),
    [
        ("CPN-MCP averaged 12.48% against 0.18 %.", f"CPN-MCP averaged {MASK} against {MASK}."),
        ("Peak on 2026-07-14, total 3,187 hours.", f"Peak on {MASK}, total {MASK} hours."),
        ("In 2026.", f"In {MASK}."),
        ("cpn-app286 runs Standard_D2s_v3 on x86", "cpn-app286 runs Standard_D2s_v3 on x86"),
        ("see {{f12}} and {{ f3 }} here", "see  and  here"),
        ('<est>about 40</est> <chart kind="compare" facts="f1,f2"/>', f"about {MASK} "),
    ],
)
def test_the_mask_hides_numbers_and_markup_but_keeps_names(raw: str, shown: str) -> None:
    assert mask_numbers(raw) == shown


def test_a_number_split_across_chunks_is_still_masked() -> None:
    mask = ThinkingMask()
    chunks = ["CPU was 1", "2.4", "8% for x86", " hosts in 20", "26."]
    shown = "".join(mask.feed(chunk) for chunk in chunks) + mask.finish()
    assert shown == f"CPU was {MASK} for x86 hosts in {MASK}."


def test_no_digit_that_measures_anything_survives_any_chunking() -> None:
    text = "Averages 12.48%, 3,187 and 0.5 across 2026-07-01 to 2026-07-31 on vm-01."
    for size in range(1, len(text) + 1):
        mask = ThinkingMask()
        shown = "".join(mask.feed(text[i : i + size]) for i in range(0, len(text), size))
        shown += mask.finish()
        assert not any(ch.isdigit() for ch in shown.replace("vm-01", "")), (size, shown)


def test_the_reasoning_shown_is_capped() -> None:
    mask = ThinkingMask()
    shown = "".join(mask.feed("word " * 100) for _ in range(100)) + mask.finish()
    assert len(shown) == MAX_THINKING_CHARS


# --------------------------------------------------------------------------- #
# The intent sentence
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "shown"),
    [
        ("I'll compare CPU use across the machines.", "I'll compare CPU use across the machines."),
        ('"I\'ll look at the **July** report."', "I'll look at the July report."),
        ("I'll compare the 3 machines.", None),
        ("NONE", None),
        ("none.", None),
        ("   ", None),
    ],
)
def test_an_intent_with_a_digit_or_nothing_to_say_is_dropped(raw: str, shown: str | None) -> None:
    assert clean_intent(raw) == shown


def test_a_long_intent_is_cut_at_a_word() -> None:
    shown = clean_intent("I'll " + "carefully " * 60 + "look.")
    assert shown is not None and len(shown) <= INTENT_MAX_CHARS + 1 and shown.endswith("…")


def test_the_context_loses_every_token_with_a_digit() -> None:
    assert (
        undigit("Satu Data Labs report, August 2026, 3 VMs") == "Satu Data Labs report, August VMs"
    )


class RecordingConverse:
    def __init__(self, response: Mapping[str, Any] | Exception) -> None:
        self.response = response
        self.requests: list[dict[str, Any]] = []

    def converse(self, **request: Any) -> Mapping[str, Any]:
        self.requests.append(request)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def _said(text: str, stop: str = "end_turn") -> dict[str, Any]:
    return {"output": {"message": {"content": [{"text": text}]}}, "stopReason": stop}


def _write(client: RecordingConverse, **overrides: Any) -> str | None:
    writer = BedrockIntentWriter(
        client, model_id="moonshotai.kimi-k2.5", guardrail_id="gr-1", guardrail_version="2"
    )
    arguments = {
        "prompt": "Which VM was busiest?",
        "context": ["Satu Data Labs report, August 2026"],
        "language": "id",
    } | overrides
    return asyncio.run(writer(**arguments))


def test_the_writer_is_guarded_and_sees_no_digit() -> None:
    client = RecordingConverse(_said("I'll compare the machines in the August report."))
    assert _write(client) == "I'll compare the machines in the August report."

    request = client.requests[0]
    assert request["guardrailConfig"] == {"guardrailIdentifier": "gr-1", "guardrailVersion": "2"}
    assert "2026" not in request["messages"][0]["content"][0]["text"]
    assert "Indonesian" in request["system"][0]["text"]


@pytest.mark.parametrize(
    "response",
    [
        _said("RPT_CHAT_REFUSED", GUARDRAIL_INTERVENED),
        _said("I'll compare the", "max_tokens"),
        RuntimeError("throttled"),
    ],
)
def test_a_refused_cut_off_or_failed_intent_is_nothing(response: Any) -> None:
    assert _write(RecordingConverse(response)) is None


def test_no_intent_model_means_no_writer() -> None:
    assert (
        bedrock_intent_writer(model_id="", guardrail_id="g", guardrail_version="1", region=None)
        is None
    )


# --------------------------------------------------------------------------- #
# The turn
# --------------------------------------------------------------------------- #


class ThinkingModel:
    """Reasons, then answers, pausing so the intent writer's timing is controlled."""

    def __init__(self, *, pause: float = 0.0) -> None:
        self.pause = pause

    async def stream(
        self, *, system: str, messages: Sequence[Mapping[str, Any]]
    ) -> AsyncIterator[tuple[str, str]]:
        del system, messages
        yield ("reasoning", "The average is 8.06% for vm-mcp-prod-01, ")
        await asyncio.sleep(self.pause)
        yield ("reasoning", "so it is lightly used. ")
        yield ("text", "vm-mcp-prod-01 averaged {{f1}} CPU.")
        yield ("stop", "end_turn")


def _writer(sentence: str | None, *, delay: float = 0.0) -> Any:
    async def write(*, prompt: str, context: Sequence[str], language: str) -> str | None:
        del prompt, context, language
        await asyncio.sleep(delay)
        return sentence

    return write


def _with_intent(monkeypatch: pytest.MonkeyPatch, model: Any, writer: Any) -> list[dict[str, Any]]:
    from reporting_agent import main
    from reporting_agent.chat.session import ChatDependencies
    from reporting_agent.redaction import discard_secrets

    store = _seeded_store()
    monkeypatch.setattr(
        main,
        "_chat_dependencies",
        lambda: ChatDependencies(store=store, model=model, prices=FakePrices(), intent=writer),
    )
    discard_secrets()

    async def drain() -> list[dict[str, Any]]:
        return [event async for event in main.invoke(_payload())]

    return [e for e in asyncio.run(asyncio.wait_for(drain(), 60)) if e["type"] != "heartbeat"]


def test_the_intent_comes_first_and_the_reasoning_is_masked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _with_intent(
        monkeypatch, ThinkingModel(pause=0.2), _writer("I'll check how busy each machine was.")
    )
    kinds = [event["type"] for event in events]

    assert kinds.index("intent") < kinds.index("thinking") < kinds.index("delta")
    assert next(e for e in events if e["type"] == "intent")["text"] == (
        "I'll check how busy each machine was."
    )
    thought = "".join(e["text"] for e in events if e["type"] == "thinking")
    assert thought == f"The average is {MASK} for vm-mcp-prod-01, so it is lightly used. "
    assert "8.06" in _answer(events)
    assert _done(events)["thought_seconds"] >= 0


def test_an_intent_that_arrives_after_the_answer_started_is_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _with_intent(monkeypatch, ThinkingModel(), _writer("Too late.", delay=1.0))
    assert "intent" not in [event["type"] for event in events]
    assert _done(events)["status"] == "completed"


def test_no_sentence_means_no_intent_event(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _with_intent(monkeypatch, ThinkingModel(pause=0.1), _writer(None))
    assert "intent" not in [event["type"] for event in events]
    assert "8.06" in _answer(events)
