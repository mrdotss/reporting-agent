"""The guarantee behind a chat answer: what the model writes is rewritten before it leaves.

A system prompt is a request. This is the enforcement (ask-chat Req 3):

- **Fact references become verified strings.** `{{f12}}` becomes `⟦fig:f12⟧8.06%⟦/fig⟧`,
  where `8.06%` is the string the fact was read with. An id this turn never issued is
  dropped.
- **A numeral the model typed itself is withheld.** Outside an estimate, a number that is
  not a fact's exact string, and not an identifier, a date or a small count, is replaced
  with an em dash. The masking algebra is `verify/masking.py`'s, imported, so the chat and
  the delivery gate cannot disagree about what counts as a number.
- **Estimates are labelled.** `<est>…</est>` becomes `⟦est⟧…⟦/est⟧`, which the UI renders
  as reasoning rather than as a figure.
- **A report proposal is allow-listed.** `<propose_report …/>` is removed from the text and
  kept only if it names a target the app offered and a well-formed month.
- **Marker characters are the runtime's alone.** `⟦` and `⟧` are stripped from model text
  before anything else, so a model — or text injected into its grounding — cannot forge a
  figure chip.

Text is released a sentence at a time, so a construct split across stream chunks is never
emitted half-rewritten.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Final

from reporting_agent.chat.grounding import Fact
from reporting_agent.verify.masking import mask_paragraph

__all__ = [
    "EST_CLOSE",
    "EST_OPEN",
    "FIG_CLOSE",
    "REFUSAL_SENTINEL",
    "WITHHELD",
    "AnswerFilter",
    "fig_open",
    "plain_text",
]

REFUSAL_SENTINEL: Final[str] = "RPT_CHAT_REFUSED"
"""The guardrail's blocked-input message. The guardrail is configured to answer with this
exact token, so a blocked turn is recognized deterministically and replaced with this
runtime's own refusal sentence in the user's language."""

EST_OPEN: Final[str] = "⟦est⟧"
EST_CLOSE: Final[str] = "⟦/est⟧"
FIG_CLOSE: Final[str] = "⟦/fig⟧"
WITHHELD: Final[str] = "—"
SMALL_COUNT_LIMIT: Final[int] = 31

_MARKER_CHARS: Final[dict[int, None]] = str.maketrans("", "", "⟦⟧")
_REF: Final[re.Pattern[str]] = re.compile(r"\{\{\s*(f\d{1,4})\s*\}\}")
_EST: Final[re.Pattern[str]] = re.compile(r"<est>(.*?)</est>", re.S)
_PROPOSAL: Final[re.Pattern[str]] = re.compile(
    r'<propose_report\s+target="([A-Za-z0-9_.:@+-]{1,128})"\s+period="(\d{4}-(?:0[1-9]|1[0-2]))"\s*/>'
)
_STRAY: Final[re.Pattern[str]] = re.compile(r"</?est>|<propose_report[^>]*>?|\{\{|\}\}")
_NUMBER: Final[re.Pattern[str]] = re.compile(r"\d+(?:[.,]\d+)*(?:\s?%)?")
_BOUNDARY: Final[re.Pattern[str]] = re.compile(r"(?<=[.!?:;])\s+|\n")
_MARKED_FIG: Final[re.Pattern[str]] = re.compile(r"⟦fig:f\d+⟧(.*?)⟦/fig⟧", re.S)


def fig_open(fact_id: str) -> str:
    return f"⟦fig:{fact_id}⟧"


def plain_text(marked: str) -> str:
    """A stored answer without its markers, for use as conversation history."""
    return _MARKED_FIG.sub(r"\1", marked).replace(EST_OPEN, "").replace(EST_CLOSE, "")


class AnswerFilter:
    """Incremental rewriter for one streamed answer."""

    def __init__(self, facts: Mapping[str, Fact], target_ids: frozenset[str]) -> None:
        self._facts = dict(facts)
        self._formatted = tuple(fact.formatted for fact in self._facts.values())
        self._targets = target_ids
        self._buffer = ""
        self._released = False
        self._used: list[str] = []
        self.proposal: dict[str, str] | None = None
        self.refused = False
        self.withheld = 0

    def feed(self, chunk: str) -> str:
        if self.refused:
            return ""
        self._buffer += chunk.translate(_MARKER_CHARS)
        if REFUSAL_SENTINEL in self._buffer:
            self.mark_refused()
            return ""
        if not self._released and len(self._buffer) < len(REFUSAL_SENTINEL):
            return ""
        cut = self._safe_cut()
        if cut == 0:
            return ""
        head, self._buffer = self._buffer[:cut], self._buffer[cut:]
        self._released = True
        return self._render(head)

    def finish(self) -> str:
        if self.refused:
            return ""
        head, self._buffer = self._buffer, ""
        if REFUSAL_SENTINEL in head:
            self.mark_refused()
            return ""
        return self._render(head)

    def mark_refused(self) -> None:
        self.refused = True
        self._buffer = ""
        self.proposal = None

    def citations(self) -> dict[str, dict[str, str]]:
        return {fact_id: self._facts[fact_id].citation(fact_id) for fact_id in self._used}

    # --- internals -------------------------------------------------------------------

    def _safe_cut(self) -> int:
        text = self._buffer
        best = 0
        for match in _BOUNDARY.finditer(text):
            end = match.end()
            if _balanced(text[:end]):
                best = end
        return best

    def _render(self, text: str) -> str:
        for match in _PROPOSAL.finditer(text):
            target, period = match.group(1), match.group(2)
            if self.proposal is None and target in self._targets:
                self.proposal = {"target_id": target, "period": period}
        text = _PROPOSAL.sub("", text)

        pieces: list[str] = []
        position = 0
        for match in _EST.finditer(text):
            pieces.append(self._with_refs(text[position : match.start()], mask=True))
            inner = self._with_refs(match.group(1), mask=False)
            if inner.strip():
                pieces.append(EST_OPEN + inner + EST_CLOSE)
            position = match.end()
        pieces.append(self._with_refs(text[position:], mask=True))
        return "".join(pieces)

    def _with_refs(self, text: str, *, mask: bool) -> str:
        pieces: list[str] = []
        position = 0
        for match in _REF.finditer(text):
            pieces.append(self._clean(text[position : match.start()], mask=mask))
            fact_id = match.group(1)
            fact = self._facts.get(fact_id)
            if fact is not None:
                if fact_id not in self._used:
                    self._used.append(fact_id)
                pieces.append(fig_open(fact_id) + fact.formatted + FIG_CLOSE)
            position = match.end()
        pieces.append(self._clean(text[position:], mask=mask))
        return "".join(pieces)

    def _clean(self, text: str, *, mask: bool) -> str:
        text = _STRAY.sub("", text)
        if not mask or not any(character.isdigit() for character in text):
            return text
        masked = mask_paragraph(text, ledger_strings=self._formatted, allowlist=())
        out: list[str] = []
        position = 0
        for match in _NUMBER.finditer(text):
            if not any(character.isdigit() for character in masked[match.start() : match.end()]):
                continue
            token = match.group(0)
            if token.isdigit() and int(token) <= SMALL_COUNT_LIMIT:
                continue
            out.append(text[position : match.start()])
            out.append(WITHHELD)
            position = match.end()
            self.withheld += 1
        out.append(text[position:])
        return "".join(out)


def _balanced(prefix: str) -> bool:
    if prefix.count("<est>") != prefix.count("</est>"):
        return False
    if prefix.rfind("{{") > prefix.rfind("}}"):
        return False
    if prefix.rfind("<propose_report") > prefix.rfind("/>"):
        return False
    return True
