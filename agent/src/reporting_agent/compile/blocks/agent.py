"""`agent_paragraph` and `agent_record` — words the agent writes, on the author's instruction.

An agent paragraph is a narration like the resource and trend narratives, with two things the
author chooses: **what it reads** (blocks of its own section) and **what it is asked** (an
instruction, a length and a voice). Everything else is the narratives' discipline unchanged:

* It mints no figure. The model is shown the ledger's `(label, formatted)` pairs of the blocks
  it reads, and nothing else — no series, no value it could average.
* Its words arrive as `Text`, unaltered. `narrate/summary.py` refuses an answer holding a
  number it was not shown before the words reach a document, and the delivery gate is still
  the backstop behind that.
* A missing paragraph costs a paragraph, not a report. The preset's fallback decides what
  stands in its place: nothing, or the author's own note, which is typed text checked for
  numerals like any other.

## Why the request is built late

The request is assembled when the compile's second phase asks for it, after every block has
minted its figures. An author who asks the agent about the table *below* the paragraph gets
that table's figures, rather than a paragraph about nothing because the table had not been
compiled yet.

## The record

`agent_record` lists, at the foot of the coverage section, which sections carry a paragraph
the agent wrote. It is finished after every other deferred block (`Deferred.after_others`),
because what it lists is what they produced. It names sections only: a count would be a number
with no snapshot address.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final

from reporting_agent.compile.ast import Block
from reporting_agent.compile.blocks.base import (
    NOTICE_STYLE,
    PROSE_KIND_AGENT,
    AgentOutcome,
    BlockContext,
    BlockOutput,
    BlockSpec,
    Deferred,
    ProseRequest,
    text_paragraph,
)
from reporting_agent.compile.figures import BlockCursor

__all__ = [
    "AGENT_PARAGRAPH_BLOCK",
    "AGENT_RECORD_BLOCK",
    "MAX_AGENT_FIGURES",
    "agent_paragraphs_of",
    "compile_agent_paragraph",
    "compile_agent_record",
    "outcome_plain",
]

AGENT_PARAGRAPH_BLOCK: Final[str] = "agent_paragraph"
AGENT_RECORD_BLOCK: Final[str] = "agent_record"

MAX_AGENT_FIGURES: Final[int] = 60
"""A bound on the prompt: the figures of the blocks a paragraph reads, in document order."""

MAX_AGENT_PARAGRAPHS: Final[int] = 2
"""A sentence or a short paragraph is one paragraph; an answer split in two is kept, a third
is not — a bound on the block's node count, as `narrative.MAX_PROSE_PARAGRAPHS` is."""

MAX_AGENT_POINTS: Final[int] = 6
MAX_AGENT_CHARS: Final[int] = 1500

READS_CONFIG_KEY: Final[str] = "reads"
"""The block-id stems the paragraph reads: `<section>__<slot or added id>`, matched exactly
or as the stem of a per-resource or per-metric id. One `<section>__` stem reads the whole
section."""


def compile_agent_paragraph(context: BlockContext, block: BlockSpec, cursor: BlockCursor) -> BlockOutput:
    config = block.config
    stems = tuple(str(stem) for stem in _sequence(config.get(READS_CONFIG_KEY)))
    length = str(config.get("length") or "short")
    fallback = str(config.get("fallback") or "omit")
    note = config.get("note")
    note_text = note if isinstance(note, str) and note.strip() else ""

    def reads(block_id: str) -> bool:
        for stem in stems:
            if stem.endswith("__"):
                if block_id.startswith(stem) and block_id != block.id:
                    return True
            elif block_id == stem or block_id.startswith(f"{stem}__"):
                return True
        return False

    def request_for() -> ProseRequest | None:
        view = context.view
        names = {resource.resource_id: resource.name for resource in view.resources}
        figures: list[tuple[str, str]] = []
        resources: set[str] = set()
        for figure in context.ledger.entries.values():
            if not reads(str(figure.path).split(":", 1)[0]):
                continue
            if len(figures) >= MAX_AGENT_FIGURES:
                break
            measure = f"{figure.metric} ({figure.statistic})" if figure.metric else figure.statistic
            label = " · ".join(
                part
                for part in (
                    names.get(figure.resource_id or "") or figure.resource_id or "",
                    measure,
                    figure.window or "",
                )
                if part
            )
            figures.append((label, figure.formatted))
            if figure.resource_id:
                resources.add(figure.resource_id)
        if not figures:
            return None
        return ProseRequest(
            block_id=block.id,
            kind=PROSE_KIND_AGENT,
            report_title=context.report_title,
            subscription_display_name=context.subscription_display_name,
            window=view.window.descriptor,
            grain=view.grain,
            resource_count=len(resources),
            figures=tuple(figures),
            instruction=str(config.get("instruction") or ""),
            length=length,
            voice=str(config.get("voice") or "plain"),
            language=context.messages.language,
        )

    def finish(prose: str | None) -> tuple[Block, ...]:
        texts = agent_paragraphs_of(prose, length)
        reason = "written" if texts else context.prose_reasons.get(block.id) or "empty"
        if texts:
            outcome, nodes = "written", tuple(
                text_paragraph(cursor.child("nodes", ordinal), "Body Text", text)
                for ordinal, text in enumerate(texts)
            )
        elif fallback == "note" and note_text:
            outcome, nodes = "note", (text_paragraph(cursor.child("nodes", 0), NOTICE_STYLE, note_text),)
        else:
            outcome, nodes = "omitted", ()
        context.agent_paragraphs[block.id] = AgentOutcome(
            block_id=block.id,
            section_id=str(config.get("section_id") or ""),
            section_title=str(config.get("section_title") or ""),
            outcome=outcome,
            reason=reason,
            text="\n\n".join(texts) if length != "bullets" else "\n".join(texts),
        )
        return nodes

    return BlockOutput(deferred=Deferred(block_id=block.id, finish=finish, request_for=request_for))


def compile_agent_record(context: BlockContext, block: BlockSpec, cursor: BlockCursor) -> BlockOutput:
    """Which sections carry a paragraph the agent wrote, after every one of them finished."""

    def finish(_prose: str | None) -> tuple[Block, ...]:
        titles = list(
            dict.fromkeys(
                outcome.section_title
                for outcome in context.agent_paragraphs.values()
                if outcome.outcome == "written" and outcome.section_title
            )
        )
        if not titles:
            return ()
        messages = context.messages
        return (
            text_paragraph(cursor.child("nodes", 0), "Heading 3", messages.text("doc.agent.record.title")),
            text_paragraph(
                cursor.child("nodes", 1),
                "Body Text",
                messages.text("doc.agent.record.body", sections="; ".join(titles)),
            ),
        )

    return BlockOutput(deferred=Deferred(block_id=block.id, finish=finish, after_others=True))


def agent_paragraphs_of(prose: str | None, length: str) -> tuple[str, ...]:
    """The model's answer split into paragraphs — or, for points, lines — **otherwise
    unaltered**, and bounded in count and length so the block's node count cannot depend on
    the model's verbosity."""
    if not prose or not prose.strip():
        return ()
    if length == "bullets":
        lines = [line.strip() for line in prose.splitlines()]
        return tuple(line[:MAX_AGENT_CHARS] for line in lines if line)[:MAX_AGENT_POINTS]
    chunks = [chunk.strip() for chunk in prose.split("\n\n")]
    return tuple(chunk[:MAX_AGENT_CHARS] for chunk in chunks if chunk)[:MAX_AGENT_PARAGRAPHS]


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, str):
        return value
    return ()


def outcome_plain(outcome: AgentOutcome) -> Mapping[str, str]:
    """One paragraph's line in `agent.json`. The words stay in `prose.json`."""
    return {
        "block_id": outcome.block_id,
        "section_id": outcome.section_id,
        "section_title": outcome.section_title,
        "outcome": outcome.outcome,
        "reason": outcome.reason,
    }
