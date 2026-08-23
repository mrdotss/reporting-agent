"""The three record block types: `gaps_and_coverage`, `verification_record` and
`appendix_methodology`.

Together they are the part of the document that makes the rest of it checkable — what the
collection could not see, what it was, and how it was computed.

## `gaps_and_coverage`: a gap is information, not an error state (Req 16.3, 29.3)

Grouped by `gap_type` ascending in code-point order, and within each group by resource id
ascending — an order **produced** here rather than inherited, so one snapshot compiles to one
document. Each group names the resources it affects and carries its **count as a figure**,
addressed to the snapshot's own per-type cardinality.

Emitted **as recorded**, never as an absence of data: `deallocated`, `metric_not_emitted` and
`permission_denied` are three completely different facts that a zero-filling report would
render identically as "0% CPU". An empty log gets an explicit "no gaps recorded" row rather
than a missing section, for the same reason an empty scope does — a section that vanished is
indistinguishable from one that was never configured.

## `verification_record`: the collection record, and **not** the verification outcome

It carries `snapshot_id`, the window with its resolved UTC offset, the grain, the resource
count, the gap count, the per-`fidelity_tier` counts and the raw-archive completeness flag
(Req 16.4). Every count is a figure.

It carries **no verification status, no verified-figure count and no finding count** (Req
16.5), and that is structural rather than an omission to remember: those are computed from the
**rendered** document, which does not exist while this block is compiling. A block that
claimed a passing verification would be asserting the outcome of a check that had not run —
and the run it was asserting about is the one that might yet be withheld.

## `appendix_methodology`: reads labels, composes none (Req 16.6)

The declared period specification, the requested grain, the snapshot's grain, the aggregation
method for every statistic present, each estimated statistic's label **read from the ledger**,
and what each present fidelity tier does and does not support.

It composes no label of its own. `compile/estimators.py` owns the label and the method phrase,
both derived from the same declarations, so the appendix and the in-document label cannot
describe two different methods. That is why this block is **deferred**: the ledger has to be
complete before its labels can be read, and reading them from anywhere else would be a second
formatting path.
"""

from __future__ import annotations

from typing import Final

from reporting_agent.compile.ast import Block, Column, FigureCell, Paragraph, Row, Table
from reporting_agent.compile.blocks.base import (
    NO_GAPS_TEXT,
    BlockContext,
    BlockOutput,
    BlockSpec,
    Deferred,
    caption_of,
    empty_cell,
    text_cell,
    text_paragraph,
)
from reporting_agent.compile.estimators import method_phrase
from reporting_agent.compile.figures import BlockCursor
from reporting_agent.compile.messages import Messages
from reporting_agent.compile.snapshot_view import SnapshotValue

__all__ = [
    "TIER_MEANINGS",
    "compile_appendix_methodology",
    "compile_gaps_and_coverage",
    "compile_verification_record",
]

def _field_column(messages: Messages) -> Column:
    return Column(key="field", header=messages.text("doc.table.field"))


def _value_column(messages: Messages) -> Column:
    return Column(key="value", header=messages.text("doc.table.value"))

TIER_MEANINGS: Final = {
    "baseline": (
        "Platform metrics only, with no agent installed in the guest. Averages, minima and "
        "maxima are exact. Percentiles are estimated and labelled as such wherever they "
        "appear, and per-volume disk free space and guest-observed memory are not available."
    ),
    "enhanced": (
        "The customer opted into the Azure Monitor Agent and a Data Collection Rule, so "
        "percentiles are computed from the individual samples the guest shipped, and "
        "per-volume disk free space and guest-observed memory are available."
    ),
}
"""What each fidelity tier does and does not support, in the reader's terms.

A right-sizing recommendation built on an estimated percentile is honest only if the document
says the percentile was estimated **and** what it would have taken to measure it. A tier the
snapshot carries and this table does not describe falls back to a neutral sentence rather than
being omitted: an undescribed tier is worse than a plainly-unfamiliar one."""


def _figure_row(
    cursor: BlockCursor,
    context: BlockContext,
    key: str,
    label: str,
    value: SnapshotValue | None,
) -> Row:
    """A `(label, figure)` row, or a `(label, empty)` row when the value is absent."""
    value_cursor = cursor.child("cells", 1)
    if value is None:
        return Row(
            path=cursor.path,
            key=key,
            cells=(
                text_cell(cursor.child("cells", 0), label),
                empty_cell(value_cursor),
            ),
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


def _text_row(cursor: BlockCursor, key: str, label: str, value: str) -> Row:
    return Row(
        path=cursor.path,
        key=key,
        cells=(
            text_cell(cursor.child("cells", 0), label),
            text_cell(cursor.child("cells", 1), value),
        ),
    )


def compile_gaps_and_coverage(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """Every recorded gap, grouped by type, each group's count as a figure."""
    table_cursor = cursor.child("nodes", 0)
    view = context.view
    style = context.design.table_style_name
    caption = caption_of(block)
    grouped = view.gaps_by_type()

    rows: list[Row] = []

    if not grouped:
        row_cursor = table_cursor.child("rows", 0)
        rows.append(
            Row(
                path=row_cursor.path,
                key="no-gaps",
                cells=(
                    text_cell(row_cursor.child("cells", 0), context.messages.text(NO_GAPS_TEXT)),
                    text_cell(row_cursor.child("cells", 1), ""),
                    empty_cell(row_cursor.child("cells", 2)),
                ),
            )
        )
    else:
        for ordinal, (gap_type, entries) in enumerate(grouped):
            row_cursor = table_cursor.child("rows", ordinal)
            affected = ", ".join(
                dict.fromkeys(entry.resource_id for entry in entries)
            )
            count = view.cardinality("gaps", "by_type", gap_type)
            value_cursor = row_cursor.child("cells", 2)

            cells: tuple[object, ...] = (
                text_cell(row_cursor.child("cells", 0), gap_type),
                text_cell(row_cursor.child("cells", 1), affected),
                empty_cell(value_cursor)
                if count is None
                else FigureCell(
                    path=value_cursor.path,
                    figure=value_cursor.child("figure", 0).figure(
                        count, catalog_scale=context.catalog_scale(count)
                    ),
                ),
            )
            rows.append(Row(path=row_cursor.path, key=gap_type, cells=cells))  # type: ignore[arg-type]

    table = Table(
        path=table_cursor.path,
        style=style,
        columns=(
            Column(key="gap_type", header=context.messages.text("doc.table.gap")),
            Column(key="resources", header=context.messages.text("doc.table.resources_affected")),
            Column(key="count", header=context.messages.text("doc.table.count")),
        ),
        rows=tuple(rows),
        caption=caption,
    )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(table,))


def compile_verification_record(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """Snapshot provenance and the collection record. No verification outcome."""
    table_cursor = cursor.child("nodes", 0)
    view = context.view
    rows: list[Row] = []

    def row_cursor() -> BlockCursor:
        return table_cursor.child("rows", len(rows))

    rows.append(_text_row(row_cursor(), "snapshot_id", "Snapshot id", view.snapshot_id))
    rows.append(
        _text_row(
            row_cursor(),
            "window",
            "Collection window",
            f"{view.window.start} to {view.window.end} "
            f"({view.timezone}, UTC{view.utc_offset})",
        )
    )
    rows.append(_text_row(row_cursor(), "grain", "Grain", view.grain))
    rows.append(
        _figure_row(
            row_cursor(), context, "resources", "Resources", view.cardinality("resources")
        )
    )
    rows.append(
        _figure_row(row_cursor(), context, "gaps", "Recorded gaps", view.cardinality("gaps"))
    )

    for tier in view.tier_counts():
        rows.append(
            _figure_row(
                row_cursor(),
                context,
                f"fidelity_tier:{tier}",
                f"Resources at fidelity tier {tier}",
                view.cardinality("fidelity_tier", tier),
            )
        )

    rows.append(
        _text_row(
            row_cursor(),
            "raw_archive_complete",
            "Raw archive complete",
            "yes" if view.raw_archive_complete else "no",
        )
    )
    rows.append(
        _figure_row(
            row_cursor(),
            context,
            "raw_archive_objects",
            "Archived raw responses",
            view.cardinality("raw_archive", "objects"),
        )
    )

    table = Table(
        path=table_cursor.path,
        style=context.design.table_style_name,
        columns=(_field_column(context.messages), _value_column(context.messages)),
        rows=tuple(rows),
        caption=caption_of(block),
    )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(table,))


def compile_appendix_methodology(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """Deferred: the ledger has to be complete before its estimator labels can be read."""

    def finish(_prose: str | None) -> tuple[Block, ...]:
        view = context.view
        paragraphs: list[Paragraph] = []

        def emit(style: str, text: str) -> None:
            paragraphs.append(
                text_paragraph(cursor.child("nodes", len(paragraphs)), style, text)
            )

        emit("Heading 2", "How these figures were produced")

        emit(
            "Body Text",
            f"Period requested: {_period_phrase(context)}. Resolved to "
            f"{view.window.start} through {view.window.end} inclusive, in "
            f"{view.timezone} (UTC{view.utc_offset}).",
        )
        emit(
            "Body Text",
            f"Requested grain: {view.grain}. The snapshot was collected at {view.grain} "
            f"and bucketed into local days in the customer's own timezone, so a daily "
            f"figure covers a local day rather than a UTC one.",
        )

        for estimator in _estimators_present(context):
            emit("Body Text", f"{estimator[0]}: {estimator[1]}.")

        labels = _estimated_labels(context)
        if labels:
            emit(
                "Body Text",
                "Estimated statistics in this report are labelled wherever they appear: "
                + "; ".join(labels)
                + ".",
            )

        for tier in view.tier_counts():
            emit(
                "Body Text",
                f"Fidelity tier {tier}: "
                + TIER_MEANINGS.get(
                    tier,
                    "a tier this report does not describe; treat its figures with the "
                    "caveats its collection method implies.",
                ),
            )

        return tuple(paragraphs)

    return BlockOutput(deferred=Deferred(block_id=block.id, finish=finish))


def _period_phrase(context: BlockContext) -> str:
    """The **declared** period specification, not just the dates it resolved to.

    Both matter and they are different facts: `last_full_month` tells a reader the report will
    move with the calendar, while the resolved dates tell them which month this one covered. A
    report showing only the dates cannot be re-run knowingly.
    """
    kind = context.period.get("kind")
    if not isinstance(kind, str) or not kind:
        return "unspecified"
    if kind != "custom":
        return kind
    start = context.period.get("start")
    end = context.period.get("end")
    return f"custom ({start} to {end})"


def _estimators_present(context: BlockContext) -> tuple[tuple[str, str], ...]:
    """Every `(statistic, method)` pair the ledger actually used, ordered.

    Read from the ledger rather than from the catalog, so the appendix describes the methods
    **this** report relied on and not every method the product supports.
    """
    seen: dict[str, str] = {}
    for figure in context.ledger.entries.values():
        if figure.estimator is None:
            continue
        seen.setdefault(figure.statistic, method_phrase(figure.estimator))
    return tuple(sorted(seen.items()))


def _estimated_labels(context: BlockContext) -> tuple[str, ...]:
    """Each estimated statistic's label, **read from the ledger** (Req 16.6).

    The pre-formatted label the figure already carries, deduplicated and ordered — this block
    composes none of its own, so the appendix and the figure it describes cannot disagree.
    """
    labels = {
        figure.estimator_label
        for figure in context.ledger.entries.values()
        if figure.estimator_label is not None
    }
    return tuple(sorted(labels))
