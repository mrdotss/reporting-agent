"""`comparison_delta` — the block form of `compare/delta.py`.

Thin on purpose. `compare/delta.py` decides what the comparison *is*; this module turns that
into a table, so the arithmetic and the layout are separable and the arithmetic can be
property-tested without an AST.

Every delta is a **figure**. A row that is not comparable — differing fidelity tiers, or a
resource present in one snapshot only — carries an `EmptyCell` in the delta column and says why
in text, and is **never omitted** (Req 16.8, 16.15).

Both `snapshot_id`s are emitted in the block, as rows of the table rather than as a caption: a
delta whose two anchors are not named in the document cannot be re-checked, and a caption is the
first thing a copy-paste loses.

## The table shows the later value and the change, not the earlier value

**A document is verified against exactly one snapshot**, and every figure in it must resolve
there. The earlier run's value lives at a position in the *earlier* snapshot, so a figure
carrying it could not re-resolve at all — `Figure.__post_init__` refuses it, which is the
guarantee working rather than an obstacle to route around.

Emitting the earlier value as **text** would be worse: a numeric token in the document that the
verifier finds and cannot match, withholding the whole report. So the row carries the later
value and the change, both figures against this run's snapshot, and the change's
`derived_from` names **both** operands fully qualified as `<snapshot_id>#<pointer>` — so the
earlier number is recoverable and locatable by anyone holding both documents, which is what a
reader disputing a change actually needs. The earlier run's own numbers are in the earlier run's
own report, verified against the snapshot they came from.
"""

from __future__ import annotations

from collections.abc import Mapping

from reporting_agent.compare.delta import DeltaKind, DeltaRow, DeltaTable, compile_delta
from reporting_agent.compile.ast import Column, FigureCell, Row, Table, compiling_against
from reporting_agent.compile.blocks.base import (
    MAX_TABLE_ROWS,
    NOT_COMPARABLE_TEXT,
    BlockContext,
    BlockOutput,
    BlockSpec,
    caption_of,
    empty_cell,
    empty_scope_table,
    text_cell,
)
from reporting_agent.compile.figures import BlockCursor
from reporting_agent.compile.scope import resolve

__all__ = ["compile_comparison_delta"]

_COLUMNS = (
    Column(key="resource", header="Resource"),
    Column(key="later", header="This run"),
    Column(key="delta", header="Change"),
    Column(key="note", header="Note"),
)
"""Four columns, and there is deliberately no "Earlier" one — see the module docstring."""


def compile_comparison_delta(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One row per resource across the two runs the config names.

    The two runs' snapshots come from :class:`~...base.ComparisonSource`, which the pipeline
    supplies. A block whose runs cannot be resolved is a `COMPILE_FAILED` naming the block and
    the run id: a comparison block that silently rendered one run's numbers would look like a
    delta of zero, which is the most misleading possible outcome.
    """
    table_cursor = cursor.child("nodes", 0)
    style = context.design.table_style_name
    caption = caption_of(block)

    run_a = block.config.get("run_a")
    run_b = block.config.get("run_b")
    if not isinstance(run_a, str) or not run_a or not isinstance(run_b, str) or not run_b:
        raise block.fail("config.run_a and config.run_b must each name a completed run")

    if context.comparison is None:
        raise block.fail(
            "no comparison source is configured, so the two runs' snapshots cannot be read; a "
            "delta is compiled from two pinned snapshots and never re-collected"
        )

    earlier = context.comparison.snapshot_for(run_a)
    later = context.comparison.snapshot_for(run_b)
    for run_id, view in ((run_a, earlier), (run_b, later)):
        if view is None:
            raise block.fail(
                f"run {run_id!r} has no stored snapshot to compare against; a delta between "
                f"two runs only means something if both snapshots are pinned"
            )
    assert earlier is not None and later is not None  # narrowed above

    scope = context.scope_for(block)
    metric, statistic = _ranking_pair(context, block, scope)

    # Resolve against **both** snapshots and compare the union. Resolving against the later run
    # alone would drop every resource that has since been decommissioned — which is precisely the
    # row Req 16.15 exists to require, and the one a reader is most likely to be looking for.
    matched = sorted(
        {resource.resource_id for resource in resolve(scope, later)}
        | {resource.resource_id for resource in resolve(scope, earlier)}
    )

    table = compile_delta(
        run_a=run_a,
        run_b=run_b,
        earlier=earlier,
        later=later,
        metric=metric,
        statistic=statistic,
        resource_ids=matched or None,
    )

    if not table.rows:
        return BlockOutput(nodes=(empty_scope_table(table_cursor, style, caption),))

    # Widen what resolves for the duration of this block: every value this run's snapshot holds,
    # plus the compile-time deltas at their reserved addresses. A superset, so the rest of the
    # document is unaffected — see `DeltaResolver`.
    with compiling_against(table.resolver(later)):
        return _delta_table(context, block, cursor, table_cursor, table, style, caption)


def _delta_table(
    context: BlockContext,
    block: BlockSpec,
    cursor: BlockCursor,
    table_cursor: BlockCursor,
    table: DeltaTable,
    style: str,
    caption: str | None,
) -> BlockOutput:
    run_a, run_b = table.run_a, table.run_b
    rows: list[Row] = [
        _anchor_row(table_cursor.child("rows", 0), "snapshot_a", run_a, table.snapshot_a),
        _anchor_row(table_cursor.child("rows", 1), "snapshot_b", run_b, table.snapshot_b),
    ]

    for delta_row in table.rows[:MAX_TABLE_ROWS]:
        rows.append(_delta_row(table_cursor.child("rows", len(rows)), context, delta_row))

    node = Table(
        path=table_cursor.path,
        style=style,
        columns=_COLUMNS,
        rows=tuple(rows),
        caption=caption,
    )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(node,))


def _ranking_pair(
    context: BlockContext, block: BlockSpec, scope: object
) -> tuple[str, str]:
    """The `(metric, statistic)` the delta compares.

    **Not from the block's config**, because `comparison_delta`'s declared config schema is
    `run_a`, `run_b` and `caption` and nothing else — adding a field here would be a change to
    the mirrored declaration, and a compiler that read an undeclared field would be reading
    something the validator rejects on both sides.

    So the pair is taken from, in order:

    1. **The block's scope `top_n`**, when it has one. A ranked comparison is already about a
       specific `(metric, statistic)`, and using a different one would compare something other
       than what the ranking selected.
    2. **The definition's own metric selection** — the first entry, by resource type in sorted
       order then declaration order. Deterministic, and it needs no new config field.

    Falling back rather than refusing is deliberate: a consultant dropping a
    `comparison_delta` onto a template with the default scope has authored something the wizard
    accepts, and failing the run minutes later would be the save-then-fail divergence the mirror
    exists to prevent. A block that resolves to no metric at all — a definition with an empty
    metric selection — is a `COMPILE_FAILED`, because then there genuinely is nothing to
    compare.
    """
    top_n = getattr(scope, "top_n", None)
    if top_n is not None:
        return (top_n.metric, top_n.statistic)

    for resource_type in sorted(context.metrics):
        for item in context.metrics[resource_type]:
            if not isinstance(item, Mapping):
                continue
            name = item.get("metric") or item.get("derived")
            statistic = item.get("statistic")
            if isinstance(name, str) and name and isinstance(statistic, str) and statistic:
                return (name, statistic)

    raise block.fail(
        "resolves to no metric to compare: the block's scope declares no top-N and the "
        "definition's metric selection is empty"
    )


def _anchor_row(cursor: BlockCursor, key: str, run_id: str, snapshot_id: str) -> Row:
    """One of the two snapshot anchors, in the table itself."""
    return Row(
        path=cursor.path,
        key=key,
        cells=(
            text_cell(cursor.child("cells", 0), f"Run {run_id}"),
            text_cell(cursor.child("cells", 1), ""),
            text_cell(cursor.child("cells", 2), ""),
            text_cell(cursor.child("cells", 3), f"snapshot {snapshot_id}"),
        ),
    )


def _delta_row(cursor: BlockCursor, context: BlockContext, row: DeltaRow) -> Row:
    """One resource's row: the two observed values, the change, and the note.

    Every quantity is a figure or an `EmptyCell`. The note carries the reason a row is not
    comparable in **text**, because a reason is prose — but it never carries a number, so it
    cannot introduce a token the verifier would have to match.
    """
    cells: list[object] = [text_cell(cursor.child("cells", 0), row.resource_name)]

    # This run's value, and the change. Both resolve against the snapshot this document is
    # verified against; the earlier run's value does not, so it is not a figure here.
    for ordinal, value in ((1, row.later), (2, row.delta)):
        cell_cursor = cursor.child("cells", ordinal)
        if value is None:
            cells.append(empty_cell(cell_cursor))
        else:
            figure = cell_cursor.child("figure", 0).figure(
                value, catalog_scale=context.catalog_scale(value)
            )
            cells.append(FigureCell(path=cell_cursor.path, figure=figure))

    note = row.note
    if row.kind == DeltaKind.FIDELITY_DIFFERS:
        note = f"{NOT_COMPARABLE_TEXT} ({row.earlier_tier} to {row.later_tier})"
    cells.append(text_cell(cursor.child("cells", 3), note))

    return Row(path=cursor.path, key=row.resource_id, cells=tuple(cells))  # type: ignore[arg-type]
