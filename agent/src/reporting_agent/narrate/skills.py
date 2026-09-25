"""Choosing which skill, and which of its pages, an Ask question needs.

Two short model calls, both on the fast model the intent sentence uses, both behind the chat
guardrail, and both answering in JSON the runtime validates:

1. **Which skills.** The model sees the question and the name and description of every
   skill for the attachments' clouds, and names at most two — or none, which is the common
   answer: most questions are about the attached data alone.
2. **Which pages.** For the chosen skills, the model sees at most forty topic titles —
   narrowed first by word overlap with the question, since a skill such as Azure Monitor
   lists close to two thousand — and names at most two.

Neither call can introduce anything: a name or a topic number that was not offered is
dropped, so the runtime only ever reads what a vendored skill already pointed at. A slow,
failed or refused call chooses nothing, and Ask answers from its grounding as before.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Sequence
from typing import Any, Final

from reporting_agent.narrate.chat import GUARDRAIL_INTERVENED

__all__ = ["MAX_SKILLS", "MAX_TOPICS", "BedrockSkillRouter", "bedrock_skill_router", "parse_choice"]

MAX_SKILLS: Final[int] = 2
MAX_TOPICS: Final[int] = 2
MAX_OFFERED_TOPICS: Final[int] = 40
_DESCRIPTION_CHARS: Final[int] = 320
_MAX_TOKENS: Final[int] = 1500
"""Room for a reasoning model's short thinking as well as the JSON."""

_JSON: Final[re.Pattern[str]] = re.compile(r"\{.*\}", re.S)
_WORD: Final[re.Pattern[str]] = re.compile(r"[a-z0-9]{3,}")
_STOPWORDS: Final[frozenset[str]] = frozenset(
    "the and for with what which how why this that from are was were our your their can could "
    "should would does did into about over under than then them they have has had not but all "
    "any per its via use using yang dan untuk dengan ini itu apa bagaimana".split()
)

_SKILLS_SYSTEM: Final[str] = (
    "You route questions for an assistant that answers about a customer's cloud estate from "
    "attached reports. Some questions also need the cloud provider's product knowledge: best "
    "practice, how to choose or size a service, what a setting or recommendation means, how "
    "to reduce cost, security or reliability guidance. Given the question and a list of "
    "skills, name the skills whose knowledge the answer needs — at most two, and none when "
    "the attached data alone answers it (most questions about figures, trends or which "
    "resource is busiest need none). Reply with JSON only: {\"skills\": [\"skill-name\"]}."
)

_TOPICS_SYSTEM: Final[str] = (
    "Given a question and numbered documentation topics, pick the topics whose pages would "
    "best help answer it — at most two, and none if no topic fits. Reply with JSON only: "
    "{\"topics\": [3, 17]}."
)


def parse_choice(text: str, key: str) -> list[Any]:
    """The list under `key` in the first JSON object in `text`, or `[]`."""
    match = _JSON.search(text)
    if match is None:
        return []
    try:
        value = json.loads(match.group(0)).get(key, [])
    except (ValueError, AttributeError):
        return []
    return value if isinstance(value, list) else []


def _stems(text: str) -> set[str]:
    """Words cut to their first five letters, a crude stem: `underused` and
    `underutilized` share `under`, `recommend` and `recommendations` share `recom`."""
    return {word[:5] for word in _WORD.findall(text.lower()) if word not in _STOPWORDS}


def narrow_topics(
    question: str,
    titles: Sequence[str],
    groups: Sequence[int] | None = None,
    limit: int = MAX_OFFERED_TOPICS,
) -> list[int]:
    """The indices of the titles sharing the most word stems with the question, best first.

    A cheap first cut so the model chooses among forty rather than two thousand. `groups`
    says which skill each title belongs to; every skill gets an equal share of the forty,
    or a skill with six hundred topics would crowd out one with twenty that fits better.
    Ties keep each skill's own order, which lists its most general topics first.
    """
    words = _stems(question)
    group_of = list(groups) if groups is not None else [0] * len(titles)
    members: dict[int, list[tuple[int, int]]] = {}
    for index, title in enumerate(titles):
        members.setdefault(group_of[index], []).append((-len(words & _stems(title)), index))
    share = max(1, limit // max(1, len(members)))
    chosen: list[tuple[int, int]] = []
    for scored in members.values():
        scored.sort()
        matching = [entry for entry in scored if entry[0] < 0]
        chosen.extend((matching or scored)[:share])
    chosen.sort()
    return [index for _score, index in chosen[:limit]]


class BedrockSkillRouter:
    """The two choices, as guarded Converse calls on a fast model."""

    def __init__(
        self,
        client: Any,
        *,
        model_id: str,
        guardrail_id: str,
        guardrail_version: str,
        timeout_seconds: float = 20.0,
    ) -> None:
        self._client = client
        self._model_id = model_id
        self._guardrail = {"guardrailIdentifier": guardrail_id, "guardrailVersion": guardrail_version}
        self._timeout = timeout_seconds

    async def _ask(self, system: str, user: str) -> str:
        from reporting_agent.narrate.summary import inference_config

        request = {
            "modelId": self._model_id,
            "system": [{"text": system}],
            "messages": [{"role": "user", "content": [{"text": user}]}],
            "inferenceConfig": inference_config(self._model_id, max_tokens=_MAX_TOKENS, temperature=0.0),
            "guardrailConfig": self._guardrail,
        }
        try:
            response = await asyncio.wait_for(
                asyncio.to_thread(lambda: self._client.converse(**request)), self._timeout
            )
        except Exception:
            # Throttling, a timeout, a network fault: choosing nothing is always an answer.
            return ""
        if response.get("stopReason") in (GUARDRAIL_INTERVENED, "max_tokens"):
            return ""
        blocks = response.get("output", {}).get("message", {}).get("content", ())
        return "".join(block["text"] for block in blocks if isinstance(block.get("text"), str))

    async def choose_skills(
        self, *, question: str, skills: Sequence[tuple[str, str]]
    ) -> tuple[str, ...]:
        """At most two of the offered `(name, description)` skills, by name."""
        if not skills:
            return ()
        listing = "\n".join(f"- {name}: {description[:_DESCRIPTION_CHARS]}" for name, description in skills)
        text = await self._ask(_SKILLS_SYSTEM, f"Skills:\n{listing}\n\nQuestion:\n{question}")
        offered = {name for name, _ in skills}
        chosen: list[str] = []
        for name in parse_choice(text, "skills"):
            if isinstance(name, str) and name in offered and name not in chosen:
                chosen.append(name)
        return tuple(chosen[:MAX_SKILLS])

    async def choose_topics(
        self, *, question: str, titles: Sequence[str], groups: Sequence[int] | None = None
    ) -> tuple[int, ...]:
        """At most two indices into `titles`, from the forty that best match the question."""
        if not titles:
            return ()
        offered = narrow_topics(question, titles, groups)
        listing = "\n".join(f"{number}. {titles[index]}" for number, index in enumerate(offered, start=1))
        text = await self._ask(_TOPICS_SYSTEM, f"Topics:\n{listing}\n\nQuestion:\n{question}")
        chosen: list[int] = []
        for number in parse_choice(text, "topics"):
            if isinstance(number, int) and not isinstance(number, bool) and 1 <= number <= len(offered):
                index = offered[number - 1]
                if index not in chosen:
                    chosen.append(index)
        return tuple(chosen[:MAX_TOPICS])


def bedrock_skill_router(
    *, model_id: str, guardrail_id: str, guardrail_version: str, region: str | None
) -> BedrockSkillRouter | None:
    """The router, or `None` when no fast model is configured — Ask then uses no skills."""
    if not model_id or not guardrail_id or not guardrail_version:
        return None
    import boto3

    return BedrockSkillRouter(
        boto3.client("bedrock-runtime", region_name=region),
        model_id=model_id,
        guardrail_id=guardrail_id,
        guardrail_version=guardrail_version,
    )
