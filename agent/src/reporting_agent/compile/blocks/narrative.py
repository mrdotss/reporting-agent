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
from typing import Final

from reporting_agent.compile.ast import (
    PRIOR_RUNS_POINTER_PREFIX,
    Block,
    Column,
    FigureCell,
    Paragraph,
    Row,
    Table,
)
from reporting_agent.compile.blocks.base import (
    PROSE_KIND_RESOURCE,
    PROSE_KIND_TREND,
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

__all__ = [
    "MAX_PROSE_PARAGRAPHS",
    "MAX_NARRATED_RESOURCES",
    "MAX_RESOURCE_NARRATIVE_FIGURES",
    "MAX_TREND_NARRATIVE_RESOURCES",
    "compile_executive_summary",
    "compile_resource_narrative",
    "compile_trend_narrative",
]

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
        resource_count=len(context.resources_for(block, view)),
        gap_counts={gap_type: len(entries) for gap_type, entries in view.gaps_by_type()},
        figures=tuple(
            (figure.metric,
                        figure.statistic, figure.formatted)
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


MAX_TREND_NARRATIVE_RESOURCES: Final[int] = 12
"""How many resources the trend commentary describes.

A bound on the **prompt**, where `MAX_PROSE_PARAGRAPHS` bounds the answer. One paragraph
per resource over an estate of two hundred is a document nobody reads and a token bill
nobody expected, and the resources beyond this bound are not hidden — the trend chart and
the tables still carry every one of them. Ordered by the ledger, so which twelve is a
property of the compile rather than of a set's iteration order.
"""

_TREND_FIGURE_MARKERS: Final[tuple[str, ...]] = ("/month_buckets/", PRIOR_RUNS_POINTER_PREFIX)
"""What makes a ledger figure a trend figure: it addresses a seeded month in this run's
snapshot, or a prior run's. Read off `snapshot_path` rather than tracked separately,
because the path is what the verifier re-resolves and so is the one description of a
figure that cannot drift from the document."""


def compile_trend_narrative(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One paragraph per resource about how it moved across the months (Req 19.x).

    ## It mints no figure of its own

    Every number it shows the model is already in the ledger, put there by the
    `historical_trend` block that plotted it. That ordering is a real dependency and it is
    the right one: a narrative block that re-read the snapshot would mint a second figure
    at the same `snapshot_path` as the chart's, and the ledger would then hold one address
    twice. So this block reads what the chart already established, and a definition that
    places the narrative **before** its chart gets no prose rather than a wrong one — the
    block still emits, which is what Req 19.5 asks of every narrative block.

    ## What the model is shown

    `(label, formatted)` pairs exactly as the executive summary sends them, with the label
    carrying resource, metric and month so the model can group without being handed a
    structure. Formatted strings only — a trend is the shape that most invites "up 12%
    from May", and 12 is a number the compiler never placed.
    """
    view = context.view
    names = {resource.resource_id: resource.name for resource in view.resources}

    scoped_resource_id = block.config.get("_resource_id")
    ordered: list[str] = []
    figures: list[tuple[str, str]] = []
    for figure in context.ledger.entries.values():
        if not any(marker in figure.snapshot_path for marker in _TREND_FIGURE_MARKERS):
            continue
        resource_id = figure.resource_id or ""
        if scoped_resource_id is not None and resource_id != scoped_resource_id:
            continue
        if resource_id not in ordered:
            if len(ordered) >= MAX_TREND_NARRATIVE_RESOURCES:
                continue
            ordered.append(resource_id)
        figures.append(
            (
                " · ".join(
                    part
                    for part in (
                        names.get(resource_id) or resource_id or "the estate",
                        figure.metric,
                        figure.statistic,
                        figure.window or "",
                    )
                    if part
                ),
                figure.formatted,
            )
        )

    request = (
        ProseRequest(
            block_id=block.id,
            kind=PROSE_KIND_TREND,
            report_title=context.report_title,
            subscription_display_name=context.subscription_display_name,
            window=view.window.descriptor,
            grain=view.grain,
            resource_count=len(ordered),
            gap_counts={},
            figures=tuple(figures),
        )
        if figures
        else None
    )

    def finish(prose: str | None) -> tuple[Block, ...]:
        paragraphs: list[Block] = []
        for text in _paragraphs_of(prose):
            paragraphs.append(
                text_paragraph(cursor.child("nodes", len(paragraphs)), "Body Text", text)
            )
        if paragraphs:
            return tuple(paragraphs)
        # Emitted rather than vanished, on the same terms as the trend chart's own
        # zero-point statement: a block that disappears is indistinguishable from one
        # never configured.
        return (
            text_paragraph(
                cursor.child("nodes", 0),
                "Body Text",
                context.messages.text("doc.historical.no_narrative"),
            ),
        )

    return BlockOutput(
        deferred=Deferred(block_id=block.id, finish=finish, prose_request=request)
    )


MAX_NARRATED_RESOURCES: Final[int] = 12
"""How many of a section's resources get a paragraph of their own.

The bound that matters for cost. `MAX_RESOURCE_NARRATIVE_FIGURES` bounds one request and
`MAX_PROSE_PARAGRAPHS` bounds one answer, but this block is expanded **per resource**, so
without a bound here the number of model calls in a report is the size of the estate — and
"one paragraph per resource" was asked for precisely to keep the token cost down, not to
multiply it by the fleet.

Twelve, the same as :data:`MAX_TREND_NARRATIVE_RESOURCES`, and for the same reason: past a
dozen paragraphs nobody is reading them anyway. Which twelve is the section's own resolved
order — the order the report already prints them in, so the narrated ones are the first
twelve a reader meets rather than an arbitrary set. The rest keep their heading, table and
chart; only the paragraph is spent.
"""

MAX_RESOURCE_NARRATIVE_FIGURES: Final[int] = 24
"""How many of one resource's figures the model is shown.

A bound on the **prompt**, like :data:`MAX_TREND_NARRATIVE_RESOURCES` and for the same
reason, but the shape of the risk is different here. A trend narrative is one block per
report; this one is expanded **per resource**, so an estate of fifty machines is fifty
requests and every figure in each of them is paid for fifty times. The `everything` preset
resolves nine metrics across four statistics, and a month of day buckets can put hundreds
of figures in the ledger for one machine — none of which a paragraph could use.

Twenty-four is the section's own aggregate figures (metric x statistic, across the presets
the catalogue ships) with room to spare, and the figures beyond it are not hidden: the
table and the chart immediately above the paragraph carry every one of them.
"""


def compile_resource_narrative(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One short paragraph about the one resource this block was expanded for (Req 19.x).

    ## Why this is a separate block from `trend_narrative`

    They narrate different things and sit in different places. `trend_narrative` describes
    how one resource moved **across months** and appears under its historical charts. This
    describes what one machine did **inside the reported period** and appears under that
    machine's own heading, which is where a reader who has just looked at its chart is
    standing. Folding the two into one block would mean one instruction for two questions,
    and the answer to "did it grow" is not the answer to "was it busy".

    ## It mints no figure, and reads only its own resource's

    Like the trend narrative, every number it shows the model was already minted by a block
    above it — the facts table, the chart, the statistics table — so this places nothing
    and cannot put a second figure at an address the ledger already holds.

    The filter is the resource id. A `per: "resource"` expansion emits one of these per
    resolved resource and the ledger is shared, so an unfiltered read would hand machine
    three's paragraph the figures of machines one through three: each request would be
    bigger than the last and each paragraph would describe the wrong estate. `resources_for`
    narrows to the single resource the expander wrote, which is the same narrowing every
    other `per: "resource"` compiler in this package applies.

    ## An absent narrator leaves no trace here, deliberately

    `trend_narrative` emits `doc.historical.no_narrative` when it has no prose, because it
    is one block and a block that vanishes is indistinguishable from one never configured.
    This block is expanded per resource: the same reasoning would print the same apology
    under every machine in the report, which reads as a broken document rather than an
    honest one. The section's heading, table and chart are all still there, so the absence
    is visible without a sentence spent on it under each of fifty headings.
    """
    view = context.view
    resources = context.resources_for(block, view)
    if not resources:
        return BlockOutput()
    resource = resources[0]

    # Past the bound this block still emits — it simply asks for nothing. Position is read
    # from the section's own resolved scope rather than from the block's id, which carries
    # an ordinal the expander wrote: an id is a naming convention and this is a decision
    # about what to spend, so it reads the same list the section ordered its headings by.
    in_scope = resolve(context.scope_for(block), view)
    ordinals = {item.resource_id: index for index, item in enumerate(in_scope)}
    if ordinals.get(resource.resource_id, 0) >= MAX_NARRATED_RESOURCES:
        return BlockOutput()

    # The label names the figure's **own** resource, looked up rather than assumed to be
    # this block's. Naming `resource` here instead would be shorter and would make the
    # label incapable of contradicting the filter above it — every figure would read as
    # this machine's whether or not it was one, which is precisely the failure the filter
    # exists to prevent and precisely what a label should be able to reveal.
    names = {item.resource_id: item.name for item in view.resources}

    figures: list[tuple[str, str]] = []
    for figure in context.ledger.entries.values():
        if figure.resource_id != resource.resource_id:
            continue
        if len(figures) >= MAX_RESOURCE_NARRATIVE_FIGURES:
            break
        label = " · ".join(
            part
            for part in (
                names.get(figure.resource_id) or figure.resource_id,
                figure.metric or figure.statistic,
                figure.window or "",
            )
            if part
        )
        figures.append((label, figure.formatted))

    request = (
        ProseRequest(
            block_id=block.id,
            kind=PROSE_KIND_RESOURCE,
            report_title=context.report_title,
            subscription_display_name=context.subscription_display_name,
            window=view.window.descriptor,
            grain=view.grain,
            resource_count=1,
            gap_counts={},
            figures=tuple(figures),
        )
        if figures
        else None
    )

    def finish(prose: str | None) -> tuple[Block, ...]:
        return tuple(
            text_paragraph(cursor.child("nodes", ordinal), "Body Text", text)
            for ordinal, text in enumerate(_paragraphs_of(prose))
        )

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
