"""Model-specific request settings, for Kimi K3 on Bedrock.

Kimi K3 refuses `inferenceConfig.temperature` — the whole request is rejected — and it
reasons before it answers, returning `reasoningContent` blocks beside its text. Both were
observed against Bedrock before the runtime switched to it; each is pinned here where the
agent handles it, so a model change cannot quietly break every narrative and every Ask
answer.
"""

from __future__ import annotations

import asyncio
from typing import Any, Final

import pytest

from reporting_agent.compile.blocks.base import ProseRequest
from reporting_agent.narrate.chat import BedrockChatModel
from reporting_agent.narrate.review import review
from reporting_agent.narrate.summary import MAX_OUTPUT_TOKENS, generate, inference_config

KIMI_K3: Final[str] = "us.moonshotai.kimi-k3"

REQUEST: Final[ProseRequest] = ProseRequest(
    block_id="summary",
    report_title="July utilization",
    subscription_display_name="prod-sea",
    window="2026-07-01 to 2026-07-31",
    grain="PT1H",
    resource_count=37,
    figures=(("Percentage CPU avg", "12.48%"),),
)

REASONING: Final[dict[str, Any]] = {
    "reasoningContent": {"reasoningText": {"text": "The average is low, so the fleet is idle."}}
}


def _answer(*blocks: dict[str, Any], stop: str = "end_turn") -> dict[str, Any]:
    return {"output": {"message": {"role": "assistant", "content": list(blocks)}}, "stopReason": stop}


class RecordingModel:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    def converse(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return self.response


@pytest.mark.parametrize(
    "model_id", ["us.moonshotai.kimi-k3", "global.moonshotai.kimi-k3", "moonshotai.kimi-k3"]
)
def test_kimi_k3_is_never_sent_a_temperature(model_id: str) -> None:
    assert inference_config(model_id, max_tokens=800, temperature=0.2) == {"maxTokens": 800}


@pytest.mark.parametrize("model_id", ["zai.glm-5", "anthropic.claude-sonnet-4-5-20250929-v1:0"])
def test_other_models_keep_their_temperature(model_id: str) -> None:
    assert inference_config(model_id, max_tokens=800, temperature=0.2) == {
        "maxTokens": 800,
        "temperature": 0.2,
    }


def test_the_narrator_keeps_the_answer_and_never_the_reasoning() -> None:
    model = RecordingModel(_answer(REASONING, {"text": "Most machines sat idle through July."}))

    assert generate(REQUEST, client=model, model_id=KIMI_K3) == "Most machines sat idle through July."
    assert model.calls[0]["inferenceConfig"] == {"maxTokens": MAX_OUTPUT_TOKENS}


def test_a_narrative_cut_off_by_its_token_budget_is_dropped() -> None:
    model = RecordingModel(
        _answer(REASONING, {"text": "Most machines sat idle through"}, stop="max_tokens")
    )

    assert generate(REQUEST, client=model, model_id=KIMI_K3) == ""


def test_the_review_sends_kimi_k3_no_temperature() -> None:
    model = RecordingModel(_answer(REASONING, {"text": "[0] Reads clearly."}))

    outcome = asyncio.run(
        review(
            prose=["Most machines sat idle through July."],
            figures=[("Percentage CPU avg", "12.48%")],
            client=model,
            model_id=KIMI_K3,
        )
    )

    assert outcome.completed
    assert "temperature" not in model.calls[0]["inferenceConfig"]


def test_ask_sends_kimi_k3_no_temperature_and_keeps_its_reasoning_apart() -> None:
    class StreamingClient:
        def __init__(self) -> None:
            self.request: dict[str, Any] = {}

        def converse_stream(self, **kwargs: Any) -> dict[str, Any]:
            self.request = kwargs
            return {
                "stream": [
                    {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "Thinking."}}}},
                    {"contentBlockDelta": {"delta": {"text": "cpn-mcp is the busiest."}}},
                    {"messageStop": {"stopReason": "end_turn"}},
                ]
            }

    client = StreamingClient()
    model = BedrockChatModel(
        client, model_id=KIMI_K3, guardrail_id="gr-test", guardrail_version="2"
    )

    async def collect() -> list[tuple[str, str]]:
        return [
            item
            async for item in model.stream(
                system="Answer about the grounding.",
                messages=[{"role": "user", "content": [{"text": "Which VM is busiest?"}]}],
            )
        ]

    assert asyncio.run(collect()) == [
        ("reasoning", "Thinking."),
        ("text", "cpn-mcp is the busiest."),
        ("stop", "end_turn"),
    ]
    assert "temperature" not in client.request["inferenceConfig"]
