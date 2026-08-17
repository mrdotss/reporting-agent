"""The four structural block types that carry no quantity: `heading`, `rich_text`,
`page_break` and `cover`.

Grouped in one module rather than four, because "one module per declared block type" is
about keeping a block's *logic* in one findable place, and these four have none — each is a
single node with no scope, no metric and no figure. Splitting them would produce four files
of eight lines each and one more place to look.

**What they share is the property that matters**: none of them can emit a figure, and none
of them reads a metric. `rich_text` is the one a template author could try to bend, and the
definition schema already refuses a `rich_text` config that binds a metric, a statistic, a
resource id, a scope or a snapshot path — on both sides of the mirror (Req 6.6). This module
does not need to re-check that, and deliberately does not: a second, differently-worded
version of a rule the validator already enforces is a second thing that can disagree.
"""

from __future__ import annotations

from reporting_agent.compile.ast import PageBreak, Paragraph
from reporting_agent.compile.blocks.base import (
    BlockContext,
    BlockOutput,
    BlockSpec,
    heading_style,
    text_paragraph,
)
from reporting_agent.compile.figures import BlockCursor

__all__ = [
    "compile_cover",
    "compile_heading",
    "compile_page_break",
    "compile_rich_text",
]


def compile_heading(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One paragraph in the theme's heading style for the declared level.

    The level becomes a **style name**, never a number in the AST — which is both how
    `python-docx` applies a style and what keeps a heading's level out of the node
    annotations as a quantity (Req 15.6).
    """
    text = block.config.get("text")
    if not isinstance(text, str) or not text:
        raise block.fail("config.text must be a non-empty string")

    return BlockOutput(
        nodes=(
            text_paragraph(
                cursor.child("nodes", 0), heading_style(block.config.get("level")), text
            ),
        )
    )


def compile_rich_text(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """Static prose, in body style, carrying no figure (Req 6.6).

    Authored in the template and identical in every render — which is what distinguishes it
    from `executive_summary`, whose prose is per-run narration. A methodological caveat
    belongs here; a description of what this month's numbers did does not.
    """
    text = block.config.get("text")
    if not isinstance(text, str) or not text:
        raise block.fail("config.text must be a non-empty string")

    return BlockOutput(
        nodes=(text_paragraph(cursor.child("nodes", 0), "Body Text", text),)
    )


def compile_page_break(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """A break, carrying no quantity and no cardinality — only its position (Req 16.9)."""
    return BlockOutput(nodes=(PageBreak(path=cursor.child("nodes", 0).path),))


def compile_cover(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """The cover page: title, optional subtitle, the customer, and the resolved window.

    **No metric value** (Req 16.13). Every quantity a cover could be tempted to carry — "200
    resources", "31 days" — belongs to `verification_record`, where it is a figure with a
    snapshot address. A cover states *which* report this is, not what it found.

    The window is the snapshot's **resolved local dates plus the resolved UTC offset**, both
    read from the snapshot rather than recomputed. A "July 2026" report means July in the
    customer's local time, and printing the offset is what lets a reader confirm which July
    that was — an offset omitted is the difference between a 31-day month and one silently
    shifted by seven hours.

    Emitted **only where the template's cover-page flag is true**; the registry skips this
    block entirely otherwise, so a template with the flag off carries no empty cover.
    """
    view = context.view
    nodes: list[Paragraph] = []

    def emit(style: str, text: str) -> None:
        nodes.append(text_paragraph(cursor.child("nodes", len(nodes)), style, text))

    emit("Title", context.report_title or "Infrastructure utilization report")

    subtitle = block.config.get("subtitle")
    if isinstance(subtitle, str) and subtitle:
        emit("Subtitle", subtitle)

    if context.subscription_display_name:
        emit("Body Text", context.subscription_display_name)

    emit(
        "Body Text",
        f"{view.window.start} to {view.window.end} "
        f"({view.timezone}, UTC{view.utc_offset})",
    )

    return BlockOutput(nodes=tuple(nodes))
