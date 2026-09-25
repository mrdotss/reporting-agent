"""The vendored Azure and AWS skills, loaded once, for Ask to choose from.

A skill is its `SKILL.md` — front matter naming it and saying when it applies, then a body —
plus, for many, further Markdown files beside it. Two shapes, one per source:

* **Azure** skills are indexes: tables of `| Topic | https://learn.microsoft.com/… |` rows
  under a category heading, in `SKILL.md` and in the files it links. Their value is in the
  pages; their bodies are not worth a model's context on their own.
* **AWS** skills carry their guidance inline, and point at `references/*.md` files and
  docs.aws.amazon.com pages for depth.

Both reduce to the same :class:`Topic` list — a title and either a documentation URL or a
local file — which is what `narrate/skills.py` offers a model to pick from.
"""

from __future__ import annotations

import functools
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final

__all__ = [
    "DOC_HOSTS",
    "PROVIDERS",
    "Skill",
    "Topic",
    "load_skills",
    "skills_for",
]

VENDOR: Final[Path] = Path(__file__).resolve().parent / "vendor"

PROVIDERS: Final[tuple[str, ...]] = ("azure", "aws")

DOC_HOSTS: Final[dict[str, str]] = {
    "azure": "learn.microsoft.com",
    "aws": "docs.aws.amazon.com",
}
"""The one documentation host each provider's skills may point Ask at."""

_FRONT_MATTER: Final[re.Pattern[str]] = re.compile(r"\A---\n(.*?)\n---\n", re.S)
_TABLE_ROW: Final[re.Pattern[str]] = re.compile(r"^\|\s*([^|]+?)\s*\|\s*(https://[^\s|]+)\s*\|", re.M)
_LINK: Final[re.Pattern[str]] = re.compile(r"\[([^\]\n]{3,160})\]\((https://[^\s)]+)\)")
_HEADING: Final[re.Pattern[str]] = re.compile(r"^#{1,3} (.+?)\s*$", re.M)
_BODY_CHARS: Final[int] = 12_000
"""How much of an AWS skill's own guidance Ask is given — its opening, which is its rules."""


@dataclass(frozen=True, slots=True)
class Topic:
    """One thing a skill can point at: a documentation page, or a file of its own."""

    title: str
    url: str = ""
    file: str = ""


@dataclass(frozen=True, slots=True)
class Skill:
    provider: str
    name: str
    title: str
    description: str
    root: Path
    inline: bool
    """Whether the body is guidance worth giving a model (AWS), or only an index (Azure)."""

    def body(self) -> str:
        """The `SKILL.md` body without its front matter, trimmed for a prompt."""
        text = (self.root / "SKILL.md").read_text(encoding="utf-8")
        body = _FRONT_MATTER.sub("", text, count=1).strip()
        return body[:_BODY_CHARS]

    def read_file(self, relative: str) -> str:
        """One of the skill's own Markdown files, refusing any path that leaves the skill."""
        path = (self.root / relative).resolve()
        if self.root.resolve() not in path.parents or path.suffix != ".md":
            raise ValueError(f"{relative!r} is not a file of skill {self.name!r}")
        return path.read_text(encoding="utf-8")

    @property
    def topics(self) -> tuple[Topic, ...]:
        return _topics(self)


def _front_matter(text: str) -> dict[str, str]:
    match = _FRONT_MATTER.match(text)
    fields: dict[str, str] = {}
    if match is None:
        return fields
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and not line.startswith((" ", "\t")):
            fields[key.strip()] = value.strip().strip('"').strip("'")
    return fields


_TOP_HEADING: Final[re.Pattern[str]] = re.compile(r"^# (.+?)\s*$", re.M)
_GENERIC_TITLES: Final[frozenset[str]] = frozenset({"overview", "introduction", "summary"})


def _title(name: str, text: str) -> str:
    body = _FRONT_MATTER.sub("", text, count=1)
    heading = _TOP_HEADING.search(body)
    if heading is not None and heading.group(1).strip().lower() not in _GENERIC_TITLES:
        title = heading.group(1).strip()
        return title[: -len(" Skill")] if title.endswith(" Skill") else title
    return name.replace("-", " ").title()


@functools.cache
def _topics(skill: Skill) -> tuple[Topic, ...]:
    host = DOC_HOSTS[skill.provider]
    seen: set[str] = set()
    topics: list[Topic] = []
    for path in sorted(skill.root.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        for title, url in [*_TABLE_ROW.findall(text), *_LINK.findall(text)]:
            if f"//{host}/" in url and url not in seen and title.lower() not in {"topic", "url"}:
                seen.add(url)
                topics.append(Topic(title=title.strip(), url=url.rstrip(".,")))
        relative = path.relative_to(skill.root).as_posix()
        if skill.inline and relative != "SKILL.md":
            heading = _HEADING.search(text)
            topics.append(
                Topic(title=heading.group(1).strip() if heading else relative, file=relative)
            )
    return tuple(topics)


@functools.cache
def load_skills() -> tuple[Skill, ...]:
    """Every vendored Azure and AWS skill, in a stable order."""
    sources = json.loads((VENDOR / "SOURCES.json").read_text(encoding="utf-8"))
    skills: list[Skill] = []
    for provider in PROVIDERS:
        for name in sorted(sources[provider]["skills"]):
            root = VENDOR / provider / name
            text = (root / "SKILL.md").read_text(encoding="utf-8")
            fields = _front_matter(text)
            skills.append(
                Skill(
                    provider=provider,
                    name=fields.get("name", name),
                    title=_title(name, text),
                    description=fields.get("description", ""),
                    root=root,
                    inline=provider == "aws",
                )
            )
    return tuple(skills)


def skills_for(providers: frozenset[str]) -> tuple[Skill, ...]:
    """The skills for the clouds this conversation's attachments come from."""
    return tuple(skill for skill in load_skills() if skill.provider in providers)
