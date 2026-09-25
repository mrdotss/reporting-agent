"""The no-ai-slop writing rules, as this product's narrators and Ask apply them.

`vendor/style/no-ai-slop/SKILL.md` is written for an editor working with a person: it asks
for a draft, preserves the writer's voice, and returns a "What changed" section. None of
that applies to a model writing a report paragraph. What does apply is its two lists —
**Words to cut** and **Patterns to cut** — so those two sections are taken verbatim and
everything else is left out.

One of its principles is overridden rather than dropped silently: it tells a writer to prefer
"names, numbers, dates". Here no model writes a number — figures arrive as placeholders the
compiler fills and the verifier proves, and a digit the model typed withholds a report — so
the preface says the figure rules win.
"""

from __future__ import annotations

import functools
import re
from pathlib import Path
from typing import Final

__all__ = ["WRITING_RULES_HEADINGS", "writing_rules"]

SKILL_PATH: Final[Path] = Path(__file__).resolve().parent / "vendor" / "style" / "no-ai-slop" / "SKILL.md"

WRITING_RULES_HEADINGS: Final[tuple[str, ...]] = ("Words to cut", "Patterns to cut")

_PREFACE: Final[str] = (
    "WRITING STYLE (from the no-ai-slop guide). Write plain, specific, direct prose and "
    "avoid the words and patterns below. These rules never override the figure rules above: "
    "you still never type a number yourself, and you still use only the figures you are "
    "given, in the form you are given them."
)

_SECTION: Final[re.Pattern[str]] = re.compile(r"^## (.+?)\s*$", re.M)


@functools.cache
def writing_rules() -> str:
    """The two lists, under a preface stating that the figure rules take precedence."""
    text = SKILL_PATH.read_text(encoding="utf-8")
    headings = list(_SECTION.finditer(text))
    sections: list[str] = []
    for index, heading in enumerate(headings):
        if heading.group(1) not in WRITING_RULES_HEADINGS:
            continue
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        sections.append(text[heading.start() : end].strip())
    if len(sections) != len(WRITING_RULES_HEADINGS):
        raise RuntimeError(
            f"the vendored no-ai-slop skill no longer has the sections "
            f"{WRITING_RULES_HEADINGS}; re-vendor it and re-check the extraction"
        )
    return "\n\n".join([_PREFACE, *sections])
