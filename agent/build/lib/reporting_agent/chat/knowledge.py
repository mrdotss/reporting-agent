"""Provider knowledge for one Ask question: which skills, which pages, and their text.

The chat session calls :func:`gather_knowledge` alongside its grounding. It narrows the
vendored skills to the clouds the attachments come from — an Azure report is answered with
Azure skills, never AWS ones, so no slash command is needed to say which — asks the router
which of them the question needs, and loads what they point at: an AWS skill's own guidance,
its reference files, and at most two documentation pages.

What comes back is shown in two places: :func:`knowledge_section` puts the text in the
grounding as reference material, and :func:`knowledge_sources` names what was read, so the
answer carries its sources and the timeline shows each skill and page as a step.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final, Protocol

from reporting_agent.chat.payload import ChatRequest
from reporting_agent.skills.catalogue import Skill, Topic, skills_for

__all__ = [
    "Knowledge",
    "KnowledgeItem",
    "SkillRouter",
    "gather_knowledge",
    "knowledge_section",
    "knowledge_sources",
    "providers_of",
]

MAX_FILE_CHARS: Final[int] = 12_000

_DEFUSE: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (re.compile(r"[⟦⟧]"), ""),
    (re.compile(r"\{\{|\}\}"), "{ "),
    (re.compile(r"<"), "‹"),
    (re.compile(r">"), "›"),
)
"""Documentation is full of angle brackets and braces. Inside the grounding they could read
as its own closing tag, a fact reference, or the answer's `<est>`/`<chart>` markup, so
they are replaced with look-alikes that mean nothing to the runtime."""


class SkillRouter(Protocol):
    async def choose_skills(self, *, question: str, skills: Sequence[tuple[str, str]]) -> tuple[str, ...]: ...

    async def choose_topics(
        self, *, question: str, titles: Sequence[str], groups: Sequence[int] | None = None
    ) -> tuple[int, ...]: ...


Fetch = Callable[..., Awaitable[Any]]


@dataclass(frozen=True, slots=True)
class KnowledgeItem:
    kind: str
    """`guide` (an AWS skill's own text), `file` (one of its reference files) or `page`."""
    skill: Skill
    title: str
    text: str
    url: str = ""


@dataclass(frozen=True, slots=True)
class Knowledge:
    skills: tuple[Skill, ...] = ()
    items: tuple[KnowledgeItem, ...] = ()


def providers_of(request: ChatRequest) -> frozenset[str]:
    """The clouds the attachments come from. A live pull is Azure Monitor's today."""
    providers = {run.provider for run in request.runs} | {scan.provider for scan in request.scans}
    if request.live:
        providers.add("azure")
    return frozenset(provider.lower() for provider in providers)


async def gather_knowledge(
    request: ChatRequest, *, router: SkillRouter, fetch: Fetch
) -> Knowledge:
    candidates = skills_for(providers_of(request))
    if not candidates:
        return Knowledge()
    question = request.prompt
    names = await router.choose_skills(
        question=question, skills=[(skill.name, skill.description) for skill in candidates]
    )
    chosen = tuple(skill for name in names for skill in candidates if skill.name == name)
    if not chosen:
        return Knowledge()

    items: list[KnowledgeItem] = [
        KnowledgeItem(kind="guide", skill=skill, title=skill.title, text=skill.body())
        for skill in chosen
        if skill.inline
    ]

    topics: list[tuple[Skill, Topic]] = [(skill, topic) for skill in chosen for topic in skill.topics]
    picks = await router.choose_topics(
        question=question,
        titles=[f"{skill.title}: {topic.title}" for skill, topic in topics],
        groups=[chosen.index(skill) for skill, _topic in topics],
    )
    selected = [topics[index] for index in picks]

    async def load(skill: Skill, topic: Topic) -> KnowledgeItem | None:
        if topic.file:
            try:
                text = skill.read_file(topic.file)[:MAX_FILE_CHARS]
            except (OSError, ValueError):
                return None
            return KnowledgeItem(kind="file", skill=skill, title=topic.title, text=text)
        page = await fetch(topic.url, fallback_title=topic.title)
        if page is None:
            return None
        return KnowledgeItem(kind="page", skill=skill, title=page.title, text=page.text, url=page.url)

    loaded = await asyncio.gather(*(load(skill, topic) for skill, topic in selected))
    items.extend(item for item in loaded if item is not None)
    return Knowledge(skills=chosen, items=tuple(items))


def _defuse(text: str) -> str:
    for pattern, replacement in _DEFUSE:
        text = pattern.sub(replacement, text)
    return text


def knowledge_section(knowledge: Knowledge) -> list[str]:
    """The grounding lines for what was read — empty when nothing was."""
    lines: list[str] = []
    for item in knowledge.items:
        source = item.url or f"{item.skill.name} skill"
        lines.append(f"--- {_defuse(item.title)} ({_defuse(source)})")
        lines.append(_defuse(item.text))
    return lines


def knowledge_sources(knowledge: Knowledge) -> list[dict[str, str]]:
    """What the answer drew on, for the reader: each skill used and each page read."""
    sources: list[dict[str, str]] = []
    for item in knowledge.items:
        entry = {"skill": item.skill.name, "provider": item.skill.provider, "title": item.title}
        if item.url:
            entry["url"] = item.url
        sources.append(entry)
    for skill in knowledge.skills:
        if not any(item.skill is skill for item in knowledge.items):
            sources.append({"skill": skill.name, "provider": skill.provider, "title": skill.title})
    return sources
