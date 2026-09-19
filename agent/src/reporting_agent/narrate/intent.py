"""The one sentence Ask shows while the answer is still being thought through.

The answer model reasons before it writes, so a question can sit for several seconds with
nothing but a spinner. A second, fast model — one with no reasoning phase — is asked in
parallel to say in a single sentence what the assistant is about to do ("I'll compare CPU
use across the machines in the July report"). It is a courtesy, never a substitute for
the answer, and three rules keep it one:

- **It may not state a number.** The project's rule is that no model produces a figure.
  The context it is given has every digit removed, and a sentence that still contains
  one is dropped rather than repaired.
- **It runs behind the chat guardrail.** A question the guardrail refuses gets no
  sentence at all, and the answer's own refusal follows as usual.
- **It fails quietly.** A slow, failed or empty call yields `None`; the answer carries on
  exactly as it would have without it.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Sequence
from typing import Any, Final

from reporting_agent.narrate.chat import GUARDRAIL_INTERVENED

__all__ = ["INTENT_MAX_CHARS", "BedrockIntentWriter", "clean_intent", "undigit"]

INTENT_MAX_TOKENS: Final[int] = 1500
"""Room for a reasoning model's short thinking as well as the sentence: Kimi K3 spends
about a hundred and fifty tokens on it."""
INTENT_MAX_CHARS: Final[int] = 240
"""A sentence, not a paragraph: anything longer is cut at the last word that fits."""

_LANGUAGE_NAMES: Final[dict[str, str]] = {"en": "English", "id": "Indonesian"}

_DIGITS: Final[re.Pattern[str]] = re.compile(r"\d")
_SPACES: Final[re.Pattern[str]] = re.compile(r"\s+")
_UNSAFE: Final[re.Pattern[str]] = re.compile(r"[<>⟦⟧`*_#]")
_NUMBERED: Final[re.Pattern[str]] = re.compile(r"\S*\d\S*")


def _system(language: str) -> str:
    name = _LANGUAGE_NAMES.get(language, _LANGUAGE_NAMES["en"])
    return (
        "You are the assistant of an infrastructure reporting app. Before the full answer "
        "is written, tell the user in ONE short sentence (at most 25 words) what you are "
        "about to do to answer their question, using the attached material named below. "
        f"Write in {name}. Speak in the first person about the next step, for example "
        '"I\'ll compare CPU use across the machines in the attached report." Do not answer '
        "the question, do not guess at results, and never write a digit or a number. If the "
        "question is not about the attached material or cloud infrastructure, write only: "
        "NONE"
    )


def undigit(text: str) -> str:
    """`text` without any whitespace-delimited token that contains a digit."""
    return _SPACES.sub(" ", _NUMBERED.sub("", text)).strip()


def clean_intent(raw: str) -> str | None:
    """The sentence to show, or `None` when there is nothing safe to show."""
    text = _SPACES.sub(" ", _UNSAFE.sub("", raw)).strip().strip('"').strip()
    if not text or text.upper().rstrip(".") == "NONE" or _DIGITS.search(text):
        return None
    if len(text) > INTENT_MAX_CHARS:
        text = text[:INTENT_MAX_CHARS].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return text


class BedrockIntentWriter:
    """Writes the intent sentence with one guarded, non-streaming Converse call."""

    def __init__(
        self,
        client: Any,
        *,
        model_id: str,
        guardrail_id: str,
        guardrail_version: str,
        timeout_seconds: float = 8.0,
    ) -> None:
        self._client = client
        self._model_id = model_id
        self._guardrail = {
            "guardrailIdentifier": guardrail_id,
            "guardrailVersion": guardrail_version,
        }
        self._timeout = timeout_seconds

    async def __call__(self, *, prompt: str, context: Sequence[str], language: str) -> str | None:
        from reporting_agent.narrate.summary import inference_config

        attached = "\n".join(f"- {undigit(line)}" for line in context if undigit(line))
        user = (
            f"Attached material:\n{attached or '- nothing attached'}\n\n"
            f"The user's question:\n{prompt}"
        )
        request = {
            "modelId": self._model_id,
            "system": [{"text": _system(language)}],
            "messages": [{"role": "user", "content": [{"text": user}]}],
            "inferenceConfig": inference_config(
                self._model_id, max_tokens=INTENT_MAX_TOKENS, temperature=0.2
            ),
            "guardrailConfig": self._guardrail,
        }
        try:
            response = await asyncio.wait_for(
                asyncio.to_thread(lambda: self._client.converse(**request)), self._timeout
            )
        except Exception:
            # Throttling, a timeout, a network fault: a courtesy line never fails the answer.
            return None
        if response.get("stopReason") in (GUARDRAIL_INTERVENED, "max_tokens"):
            return None
        blocks = response.get("output", {}).get("message", {}).get("content", ())
        text = "".join(block["text"] for block in blocks if isinstance(block.get("text"), str))
        return clean_intent(text)


def bedrock_intent_writer(
    *, model_id: str, guardrail_id: str, guardrail_version: str, region: str | None
) -> BedrockIntentWriter | None:
    """The writer, or `None` when no intent model is configured.

    The guardrail is the chat's own; chat refuses to run without one, so by the time this
    is built the pair is known to be set.
    """
    if not model_id or not guardrail_id or not guardrail_version:
        return None
    import boto3

    return BedrockIntentWriter(
        boto3.client("bedrock-runtime", region_name=region),
        model_id=model_id,
        guardrail_id=guardrail_id,
        guardrail_version=guardrail_version,
    )
