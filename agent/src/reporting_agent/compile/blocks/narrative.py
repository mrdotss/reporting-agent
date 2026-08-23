"""`executive_summary` — the one block where the model writes, and the only one.

The model contributes **prose**. It contributes no numbers, and the reason it cannot is
structural rather than a rule it is asked to follow:

* Its output arrives as `Text` nodes, **unaltered** (Req 16.12). `Text` carries no quantity by
  type.
* A numeral it wrote would land in a prose position, and the verifier's soundness pass
  extracts every numeric token from prose and requires each to equal a `formatted` value in
  the figure ledger. An invented figure is a **hard failure** and the report is withheld.
* It is never handed a series it could average. :class:`~...base.ProseRequest` carries the
  ledger's *formatted strings*, the aggregate table and the gap counts — so the model is never
  in a position to compute anything, and a figure it quotes is a figure that already exists.

## Two-phase, and why the figures come first

Compilation is deferred because the model's context is the **complete** ledger: it cannot be
asked until every other block's figures have been minted. `compile/blocks/__init__.py` runs
phase one over every block, then asks the provider, then calls `finish` once.

The compiler-placed figures are minted in **phase one**, at fixed ordinals **before** any
prose paragraph. That ordering is forced, not aesthetic: a node's path *is* its position, and
the number of prose paragraphs is not known when the figures are minted. Put the prose first
and every figure's ledger key would depend on how much the model wrote — two runs over one
snapshot would produce two different ledgers, and replay would fail on a correct report.

## What the block places itself

The run's two headline cardinalities — how many resources were in scope, and how many gaps
were recorded — as figures. A fleet average would be arithmetic with no snapshot address (see
`blocks/tables.py`), so the summary states the shape of the collection and leaves the
interpretation to prose, which is exactly the division of labour the product invariant
describes.

## A prose failure does not fail the run

If no provider is configured, or the provider raises, the block emits its figures and no prose
paragraph. Nothing numeric depends on the model, so losing its output costs a paragraph rather
than a report — and a run that failed because a narrator was unavailable would be the wrong
trade in a product whose value is the figures.
"""

from __future__ import annotations

import logging

from reporting_agent.compile.ast import Block, Column, FigureCell, Paragraph, Row, Table
from reporting_agent.compile.blocks.base import (
    BlockContext,
    BlockOutput,
    BlockSpec,
    Deferred,
    ProseRequest,
    caption_of,
    empty_cell,
    text_cell,
    text_paragraph,
)
from reporting_agent.compile.figures import BlockCursor
from reporting_agent.compile.scope import resolve
from reporting_agent.compile.snapshot_view import SnapshotValue

__all__ = ["MAX_PROSE_PARAGRAPHS", "compile_executive_summary"]

logger = logging.getLogger(__name__)

MAX_PROSE_PARAGRAPHS = 6
"""A bound on how much prose one summary block contributes.

Not a quality judgement — a bound. An unbounded model response would let one block's node
count depend on the model's verbosity, and every node after it in that block would move. The
figures sit before the prose so *they* cannot move; this keeps the block itself finite."""

MAX_PROSE_PARAGRAPH_CHARS = 2000


def compile_executive_summary(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """Mint the headline figures now; assemble with the model's prose later."""
    view = context.view
    table_cursor = cursor.child("nodes", 0)

    resources = view.cardinality("resources")
    gaps = view.cardinality("gaps")

    rows: list[Row] = []
    for ordinal, (key, label, value) in enumerate(
        (
            ("resources", "Resources in scope", resources),
            ("gaps", "Recorded gaps", gaps),
        )
    ):
        row_cursor = table_cursor.child("rows", ordinal)
        rows.append(_headline_row(row_cursor, context, key, label, value))

    headline = Table(
        path=table_cursor.path,
        style=context.design.table_style_name,
        columns=(Column(key="field", header=context.messages.text("doc.table.field")), Column(key="value", header=context.messages.text("doc.table.value"))),
        rows=tuple(rows),
        caption=caption_of(block),
    )
    cursor.anchor_table(table_cursor.path)

    request = ProseRequest(
        block_id=block.id,
        report_title=context.report_title,
        subscription_display_name=context.subscription_display_name,
        window=view.window.descriptor,
        grain=view.grain,
        resource_count=len(resolve(context.scope_for(block), view)),
        gap_counts={gap_type: len(entries) for gap_type, entries in view.gaps_by_type()},
        figures=tuple(
            (figure.metric or figure.statistic, figure.formatted)
            for figure in context.ledger.entries.values()
        ),
    )

    def finish(prose: str | None) -> tuple[Block, ...]:
        paragraphs: list[Paragraph] = []
        for text in _paragraphs_of(prose):
            paragraphs.append(
                text_paragraph(
                    cursor.child("nodes", 1 + len(paragraphs)), "Body Text", text
                )
            )
        # The table first, at ordinal 0, then the prose — see the module docstring.
        return (headline, *paragraphs)

    return BlockOutput(
        deferred=Deferred(block_id=block.id, finish=finish, prose_request=request)
    )


def _headline_row(
    cursor: BlockCursor,
    context: BlockContext,
    key: str,
    label: str,
    value: SnapshotValue | None,
) -> Row:
    value_cursor = cursor.child("cells", 1)
    if value is None:  # pragma: no cover - the walk always indexes both cardinalities
        return Row(
            path=cursor.path,
            key=key,
            cells=(text_cell(cursor.child("cells", 0), label), empty_cell(value_cursor)),
        )
    figure = value_cursor.child("figure", 0).figure(
        value, catalog_scale=context.catalog_scale(value)
    )
    return Row(
        path=cursor.path,
        key=key,
        cells=(
            text_cell(cursor.child("cells", 0), label),
            FigureCell(path=value_cursor.path, figure=figure),
        ),
    )


def _paragraphs_of(prose: str | None) -> tuple[str, ...]:
    """The model's response, split on blank lines, **otherwise unaltered** (Req 16.12).

    Splitting is not altering: it decides paragraph boundaries, which the document format
    needs and a single string cannot express. Nothing here rewrites a word, normalizes a
    number or strips a claim — if the model wrote a figure, it reaches the document intact and
    the verifier withholds the report, which is the outcome the invariant wants. Silently
    scrubbing numerals would hide a model that is inventing them.

    Bounded in count and in length, so one block's node count cannot depend on the model's
    verbosity.
    """
    if not prose or not prose.strip():
        return ()
    blocks = [chunk.strip() for chunk in prose.split("\n\n")]
    return tuple(
        chunk[:MAX_PROSE_PARAGRAPH_CHARS] for chunk in blocks if chunk
    )[:MAX_PROSE_PARAGRAPHS]
