"""The answer model's reasoning, made safe to show while it is still thinking.

Ask shows the reasoning live so a question is not a silent spinner. The reasoning is not
the answer: nothing in it passes :class:`~reporting_agent.chat.stream_filter.AnswerFilter`,
so nothing in it has been checked against a fact. The project's rule is that no model
produces a number, so every number in it is masked before it leaves the runtime:

- a standalone number — `12`, `12.48%`, `3,187`, `2026-07-01` — becomes `·`;
- a digit inside a name — `cpn-app286`, `vm-mcp-prod-01`, `Standard_D2s_v3`, `f12` — is
  left alone, because it names something rather than measuring it;
- the model's internal markup — `{{f12}}` fact references, `<est>`, `<chart …/>` — is
  removed, so the grounding's plumbing is not on show.

Chunks arrive split anywhere, including through the middle of a number, so the tail of
each chunk after its last whitespace is held back until the next one completes it.
"""

from __future__ import annotations

import re
from typing import Final

__all__ = ["MASK", "MAX_THINKING_CHARS", "ThinkingMask", "mask_numbers"]

MASK: Final[str] = "·"

MAX_THINKING_CHARS: Final[int] = 20_000
"""Past this the rest of the reasoning is not sent: the panel is a sign of life, not a
transcript, and a long reasoning trace would otherwise dominate the stream."""

_HOLD_LIMIT: Final[int] = 200
"""A tail this long with no whitespace in it is released rather than held indefinitely."""

_MARKUP: Final[re.Pattern[str]] = re.compile(
    r"\{\{\s*f\d{1,4}\s*\}\}|\{\{|\}\}|</?est>|<chart\b[^<>]*/?>|[⟦⟧]", re.I
)
_NUMBER: Final[re.Pattern[str]] = re.compile(
    r"(?<![A-Za-z_\d])(?<![A-Za-z_\d]-)\d(?:[\d.,:/-]*\d)?(?:\s?%)?"
)
_WHITESPACE: Final[re.Pattern[str]] = re.compile(r"\s")


def mask_numbers(text: str) -> str:
    """`text` with its markup removed and every standalone number masked."""
    return _NUMBER.sub(MASK, _MARKUP.sub("", text))


class ThinkingMask:
    """Feeds reasoning chunks in, and hands back masked text that is safe to send."""

    def __init__(self) -> None:
        self._held = ""
        self._sent = 0

    def feed(self, chunk: str) -> str:
        text = self._held + chunk
        last = max((match.end() for match in _WHITESPACE.finditer(text)), default=0)
        if last == 0 and len(text) < _HOLD_LIMIT:
            self._held = text
            return ""
        cut = last or len(text)
        self._held = text[cut:]
        return self._budget(mask_numbers(text[:cut]))

    def finish(self) -> str:
        text, self._held = self._held, ""
        return self._budget(mask_numbers(text))

    def _budget(self, text: str) -> str:
        room = MAX_THINKING_CHARS - self._sent
        if room <= 0:
            return ""
        text = text[:room]
        self._sent += len(text)
        return text
