"""The four data-table block types: `kpi_row`, `resource_table`, `top_n_table` and
`capacity_vs_usage`.

One module, because all four are the same walk — resolve a scope, emit one row per resource,
one figure per `(resource, metric, statistic)` — differing only in which columns they carry
and how the rows are ordered. Splitting them would produce four copies of the row loop, and
the row loop is precisely where "every numeric quantity is a figure node" has to hold.

## Every quantity is a `FigureCell`; nothing numeric is ever a `TextCell` (Req 16.1)

The type system says it and this module keeps it: a `TextCell` here only ever carries a
resource name, a resource group, a fidelity tier or a column label. Every measured or
declared quantity goes through `BlockCursor.figure`, which is the only figure factory and
which mints the ledger entry in the same step.

A snapshot value that does not exist becomes an **`EmptyCell`**, not a `TextCell` carrying
`"0"` and not a `TextCell` carrying `"—"`. A metric a resource does not emit is a recorded
gap, and a zero would read as measured idleness — the single error this whole package exists
to prevent.

## Why a `kpi_row` selects rather than averages

A KPI card wants one number for the whole fleet, and the obvious one — the fleet average — is
**arithmetic over many snapshot values, producing a number with no snapshot address**. It
could not be a `Figure`, so it could not appear in the document at all.

So a `kpi_row` **selects** instead of computing: per metric, it takes the extreme value
across the resolved scope and emits *that resource's own figure*, alongside the resource's
name and the basis of the selection. Selection creates no new number, so provenance survives
intact, and the row is more useful than an average anyway — a consultant sizing
infrastructure wants the machine that saturates, not the mean of a fleet.

The direction follows the statistic: a `min` selects the **lowest** observed value and
everything else the **highest**. Stated per row in a `basis` column rather than in the column
header, because the header is table-wide and the statistic is not.

## The 500-row cap states its own truncation (Req 16.2)

`resource_table` and `top_n_table` render at most :data:`MAX_TABLE_ROWS` resource rows and
then emit a final row whose omitted count is a **figure**. A truncated table that did not say
so would present a partial list as complete; a truncated table that said so in text would put
a numeric token in the document that the verifier finds and cannot match, withholding the
whole report.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Final

from reporting_agent.compile.ast import Column, FigureCell, Row, Table
from reporting_agent.compile.blocks.base import (
    MAX_TABLE_ROWS,
    BlockContext,
    BlockOutput,
    BlockSpec,
    MetricRef,
    caption_of,
    empty_cell,
    empty_scope_table,
    omitted_row,
    read_capacity_ref,
    read_metric_ref,
    read_metric_refs,
    resolve_capacity,
    resolve_stat,
    shows_fidelity,
    text_cell,
)
from reporting_agent.compile.figures import BlockCursor
from reporting_agent.compile.scope import resolve
from reporting_agent.compile.snapshot_view import ResourceView, SnapshotValue

__all__ = [
    "COLUMN_ATTRIBUTES",
    "compile_capacity_vs_usage",
    "compile_kpi_row",
    "compile_resource_table",
    "compile_top_n_table",
    "resource_attribute_text",
]

# --- BEGIN COLUMN ATTRIBUTES (mirrored in app/lib/templates/options.ts) ---
COLUMN_ATTRIBUTES: Final[tuple[str, ...]] = (
    "resource_name",
    "resource_group",
    "resource_type",
    "location",
    "sku_name",
    "power_state",
    "fidelity_tier",
)
# --- END COLUMN ATTRIBUTES ---
"""The resource attributes a data table can emit as a column, and **nothing else**.

Every one of the seven is a field this module can actually read off a `ResourceView` —
:func:`resource_attribute_text` is that reading, and it is total over this tuple. That
totality is the reason the constant is declared here rather than in the app: the wizard's
`column_list` options come from this vocabulary, and an attribute the builder could offer and
the compiler could not emit would be a column a consultant selects, saves, and then finds
missing from a delivered document.

Mirrored **by value** into `app/lib/templates/options.ts` and compared by
`app/test/mirror.static.test.ts`, the same treatment the block-type and block-config
vocabularies get. A name present on one side only is a save-time option the compiler refuses,
or an emittable column the builder never offers.

Not a metric, and the distinction is the whole point of a separate list: an attribute is a
**string** the inventory already carried, so it emits as a `TextCell` and carries no figure,
no unit and no snapshot statistic. `fidelity_tier` is on both this list and
:data:`_TIER_COLUMN`'s implicit path, which is why naming it explicitly while `show_fidelity`
is set is a validation error rather than two identical columns."""

_RESOURCE_COLUMN = Column(key="resource", header="Resource")
_TIER_COLUMN = Column(key="fidelity_tier", header="Fidelity")


def resource_attribute_text(resource: ResourceView, attribute: str) -> str:
    """One resource attribute as the string a `TextCell` carries. **Pure.**

    Total over :data:`COLUMN_ATTRIBUTES` and raising for anything else, so the constant cannot
    drift away from what this function can answer: a name added to the tuple without a branch
    here fails the guard in `tests/test_blocks.py` rather than emitting an empty column.

    Returns `""` for an attribute the inventory did not record — `sku_name` on a resource whose
    SKU never resolved, for instance. An empty string rather than a placeholder, because a
    `TextCell` carrying `"—"` would put a character in the document that came from neither the
    snapshot nor the template.
    """
    if attribute == "resource_name":
        return resource.name
    if attribute == "resource_group":
        return resource.resource_group
    if attribute == "resource_type":
        return resource.resource_type
    if attribute == "location":
        return resource.location
    if attribute == "sku_name":
        return resource.sku.name
    if attribute == "power_state":
        return resource.power_state
    if attribute == "fidelity_tier":
        return resource.fidelity_tier
    raise ValueError(
        f"{attribute!r} is not a declared column attribute; the declared set is "
        f"{list(COLUMN_ATTRIBUTES)}"
    )


_LOWEST = "lowest observed"
_HIGHEST = "highest observed"


def _figure_cell(
    cursor: BlockCursor, context: BlockContext, value: SnapshotValue
) -> FigureCell:
    """One cell holding one figure, minted through the only factory there is."""
    figure = cursor.child("figure", 0).figure(
        value, catalog_scale=context.catalog_scale(value)
    )
    return FigureCell(path=cursor.path, figure=figure)


def _metric_columns(refs: Sequence[MetricRef]) -> tuple[Column, ...]:
    return tuple(Column(key=ref.key, header=ref.label) for ref in refs)


def _resource_row(
    cursor: BlockCursor,
    context: BlockContext,
    resource: ResourceView,
    refs: Sequence[MetricRef],
    *,
    with_tier: bool,
) -> Row:
    """One resource's row: its name, optionally its tier, then one cell per metric."""
    cells: list[object] = [
        text_cell(cursor.child("cells", 0), resource.name),
    ]
    if with_tier:
        cells.append(text_cell(cursor.child("cells", len(cells)), resource.fidelity_tier))

    for ref in refs:
        cell_cursor = cursor.child("cells", len(cells))
        value = resolve_stat(context.view, resource, ref)
        cells.append(
            empty_cell(cell_cursor)
            if value is None
            else _figure_cell(cell_cursor, context, value)
        )

    return Row(path=cursor.path, key=resource.resource_id, cells=tuple(cells))  # type: ignore[arg-type]


def _resource_rows_table(
    context: BlockContext,
    block: BlockSpec,
    cursor: BlockCursor,
    refs: Sequence[MetricRef],
) -> BlockOutput:
    """The shared body of `resource_table` and `top_n_table`."""
    table_cursor = cursor.child("nodes", 0)
    matched = resolve(context.scope_for(block), context.view)
    style = context.design.table_style_name
    caption = caption_of(block)

    if not matched:
        return BlockOutput(nodes=(empty_scope_table(table_cursor, style, caption),))

    with_tier = shows_fidelity(block)
    shown = matched[:MAX_TABLE_ROWS]

    rows: list[Row] = [
        _resource_row(
            table_cursor.child("rows", ordinal), context, resource, refs, with_tier=with_tier
        )
        for ordinal, resource in enumerate(shown)
    ]

    truncation = omitted_row(
        table_cursor.child("rows", len(rows)), context.view, len(shown), len(matched)
    )
    if truncation is not None:
        rows.append(truncation)

    columns = (
        _RESOURCE_COLUMN,
        *((_TIER_COLUMN,) if with_tier else ()),
        *_metric_columns(refs),
    )
    table = Table(
        path=table_cursor.path,
        style=style,
        columns=columns,
        rows=tuple(rows),
        caption=caption,
    )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(table,))


def compile_resource_table(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One row per resource in **resolved-scope order** (Req 16.2).

    The order is the scope's, not this block's: `compile/scope.py` already applied the
    scope's own `top_n` and `sort`, so a `resource_table` renders what the scope selected in
    the order the scope declared. A second ordering decision here would be a second thing
    that can disagree with the ranking the table's caption describes.
    """
    return _resource_rows_table(
        context, block, cursor, read_metric_refs(block, "columns")
    )


def compile_top_n_table(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """A ranked table. Same walk as `resource_table`, with the ranking column first.

    **The ranking itself is the scope's** — `scope_override.top_n` and `scope_override.sort`
    are what order and cap the resources, and `compile/scope.py` has already applied both by
    the time this runs. `config.order_by` names the column the table highlights *as the
    reason* for that order and `order_by_direction` records which way it was read; neither
    re-derives the ranking, and a compiler that re-sorted here could disagree with the cap
    the resolver applied.

    So the only thing this does differently is put the `order_by` column first among the
    metric columns, deduplicated, so the reason for the order is the first number a reader
    meets.
    """
    columns = read_metric_refs(block, "columns")
    order_by = read_metric_ref(
        block.config.get("order_by"), block, "config.order_by"
    )

    ordered = (order_by, *(ref for ref in columns if ref.key != order_by.key))
    return _resource_rows_table(context, block, cursor, ordered)


def compile_kpi_row(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One row per metric, each carrying the extreme value observed across the scope.

    See the module docstring for why this selects rather than averages. The row names the
    resource it selected, so the figure is attributable rather than a fleet number nobody can
    check.
    """
    refs = read_metric_refs(block, "metrics")
    table_cursor = cursor.child("nodes", 0)
    matched = resolve(context.scope_for(block), context.view)
    style = context.design.table_style_name
    caption = caption_of(block)

    if not matched:
        return BlockOutput(nodes=(empty_scope_table(table_cursor, style, caption),))

    rows: list[Row] = []
    for ordinal, ref in enumerate(refs):
        row_cursor = table_cursor.child("rows", ordinal)
        selected = _extreme(context, matched, ref)

        cells: list[object] = [
            text_cell(row_cursor.child("cells", 0), ref.label),
            text_cell(row_cursor.child("cells", 1), _basis(ref)),
        ]
        if selected is None:
            # No resource in scope carries this metric. An EmptyCell and no resource name,
            # rather than a zero and a resource that was never measured.
            cells.append(empty_cell(row_cursor.child("cells", 2)))
            cells.append(text_cell(row_cursor.child("cells", 3), ""))
        else:
            resource, value = selected
            cells.append(_figure_cell(row_cursor.child("cells", 2), context, value))
            cells.append(text_cell(row_cursor.child("cells", 3), resource.name))

        rows.append(Row(path=row_cursor.path, key=ref.key, cells=tuple(cells)))  # type: ignore[arg-type]

    table = Table(
        path=table_cursor.path,
        style=style,
        columns=(
            Column(key="metric", header="Metric"),
            Column(key="basis", header="Basis"),
            Column(key="value", header="Value"),
            Column(key="resource", header="Resource"),
        ),
        rows=tuple(rows),
        caption=caption,
    )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(table,))


def _basis(ref: MetricRef) -> str:
    return _LOWEST if ref.statistic == "min" else _HIGHEST


def _extreme(
    context: BlockContext, matched: Sequence[ResourceView], ref: MetricRef
) -> tuple[ResourceView, SnapshotValue] | None:
    """The resource holding the extreme value for `ref`, or `None` if none carries it.

    Ties break on resource id ascending, so two resources at the same peak select the same
    one on every run — the same tie-break `compile/scope.py` uses, for the same reason.
    """
    candidates: list[tuple[Decimal, str, ResourceView, SnapshotValue]] = []
    for resource in matched:
        value = resolve_stat(context.view, resource, ref)
        if value is not None:
            candidates.append((value.value, resource.resource_id, resource, value))

    if not candidates:
        return None

    lowest = ref.statistic == "min"
    candidates.sort(key=lambda entry: (entry[0], entry[1]) if lowest else (-entry[0], entry[1]))
    return (candidates[0][2], candidates[0][3])


def compile_capacity_vs_usage(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One row per resource: the declared SKU capacity beside the observed usage.

    Both are figures. The capacity is a **snapshot value with its own pointer** — the walk in
    `compile/snapshot_view.py` indexes `sku.vcpus_available` and `sku.memory_bytes` exactly
    like a metric — so a capacity in a document re-resolves and re-verifies like everything
    else, rather than being a number the compiler happened to know.

    A resource whose capacity could not be resolved gets an `EmptyCell`: the snapshot omits an
    unresolved capability rather than storing a zero, and "we could not read the SKU" is a
    different document from "this machine has no memory".

    Deliberately **no headroom column.** Capacity minus usage is arithmetic over two snapshot
    values, and the result has no snapshot address — so it could not be a figure, and a
    document cannot carry it. Placing the two numbers side by side gives the reader the
    comparison without the compiler inventing a third quantity.
    """
    capacity_ref = read_capacity_ref(block, "capacity_metric")
    usage_ref = read_metric_ref(
        block.config.get("usage_metric"), block, "config.usage_metric"
    )

    table_cursor = cursor.child("nodes", 0)
    matched = resolve(context.scope_for(block), context.view)
    style = context.design.table_style_name
    caption = caption_of(block)

    if not matched:
        return BlockOutput(nodes=(empty_scope_table(table_cursor, style, caption),))

    with_tier = shows_fidelity(block)
    shown = matched[:MAX_TABLE_ROWS]
    rows: list[Row] = []

    for ordinal, resource in enumerate(shown):
        row_cursor = table_cursor.child("rows", ordinal)
        cells: list[object] = [text_cell(row_cursor.child("cells", 0), resource.name)]
        if with_tier:
            cells.append(
                text_cell(row_cursor.child("cells", len(cells)), resource.fidelity_tier)
            )

        capacity = resolve_capacity(context.view, resource, capacity_ref)
        cells.append(
            empty_cell(row_cursor.child("cells", len(cells)))
            if capacity is None
            else _figure_cell(row_cursor.child("cells", len(cells)), context, capacity)
        )

        usage = resolve_stat(context.view, resource, usage_ref)
        cells.append(
            empty_cell(row_cursor.child("cells", len(cells)))
            if usage is None
            else _figure_cell(row_cursor.child("cells", len(cells)), context, usage)
        )

        rows.append(Row(path=row_cursor.path, key=resource.resource_id, cells=tuple(cells)))  # type: ignore[arg-type]

    truncation = omitted_row(
        table_cursor.child("rows", len(rows)), context.view, len(shown), len(matched)
    )
    if truncation is not None:
        rows.append(truncation)

    table = Table(
        path=table_cursor.path,
        style=style,
        columns=(
            _RESOURCE_COLUMN,
            *((_TIER_COLUMN,) if with_tier else ()),
            Column(key=capacity_ref.key, header=f"{capacity_ref.label} (capacity)"),
            Column(key=usage_ref.key, header=f"{usage_ref.label} (observed)"),
        ),
        rows=tuple(rows),
        caption=caption,
    )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(table,))
