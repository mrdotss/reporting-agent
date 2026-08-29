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

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Final

from reporting_agent.compile.ast import Column, FigureCell, Row, Table, TextFactCell
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
from reporting_agent.compile.messages import Messages
from reporting_agent.compile.scope import resolve
from reporting_agent.compile.snapshot_view import FactTextValue, ResourceView, SnapshotValue

__all__ = [
    "COLUMN_ATTRIBUTES",
    "COLUMN_KINDS",
    "ColumnEntry",
    "compile_capacity_vs_usage",
    "compile_kpi_row",
    "compile_resource_table",
    "compile_top_n_table",
    "read_column_entries",
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

def _resource_column(messages: Messages) -> Column:
    return Column(key="resource", header=messages.text("doc.table.resource"))


def _tier_column(messages: Messages) -> Column:
    return Column(key="fidelity_tier", header=messages.text("doc.table.fidelity"))


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


# ---------------------------------------------------------------------------
# Typed column entries (Requirement 12.6)
# ---------------------------------------------------------------------------

# --- BEGIN COLUMN KINDS (mirrored in app/lib/templates/blocks.ts) ---
COLUMN_KINDS: Final[tuple[str, ...]] = ("metric", "attribute", "fact")
# --- END COLUMN KINDS ---


@dataclass(frozen=True, slots=True)
class ColumnEntry:
    """One entry in a block's ``columns`` config, carrying a ``kind`` discriminator.

    A v1 definition's bare metric-ref objects (``{"metric": ..., "statistic": ...}`` with no
    ``kind`` field) parse as ``kind="metric"``, so no stored row changes meaning.

    A ``fact`` entry emits **two** columns at compile time — ``<key>`` and
    ``<key>.observed_at`` — the second carrying that fact's ``collected_at`` as a ``TextFact``
    with its own anchor.
    """

    kind: str  # One of COLUMN_KINDS
    # Metric:
    metric_ref: MetricRef | None = None
    # Attribute:
    attribute: str | None = None
    # Fact:
    fact_key: str | None = None


def read_column_entries(block: BlockSpec, field_name: str) -> tuple[ColumnEntry, ...]:
    """A config field holding a list of typed column entries.

    Accepts **both** the v2 shape (objects with ``kind``) and the v1 shape (bare metric-ref
    objects with no ``kind`` field, parsed as ``kind="metric"``). A bare **string** in a v1
    definition is read as a metric ref's ``key`` — the validator upstream already rejects it,
    so this only needs to avoid crashing during load.

    An empty list is refused, same as ``read_metric_refs``.
    """
    from collections.abc import Mapping as _Mapping

    raw = block.config.get(field_name)
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        raise block.fail(f"config.{field_name} must be an array of column entries")

    entries: list[ColumnEntry] = []
    for index, item in enumerate(raw):
        at = f"config.{field_name}[{index}]"

        if not isinstance(item, _Mapping):
            raise block.fail(f"{at} must be an object, got {type(item).__name__}")

        kind = item.get("kind")

        if kind == "attribute":
            attr = item.get("attribute")
            if not isinstance(attr, str) or not attr:
                raise block.fail(f"{at} (kind=attribute) names no attribute")
            if attr not in COLUMN_ATTRIBUTES:
                raise block.fail(
                    f"{at} names attribute {attr!r} which is not in {list(COLUMN_ATTRIBUTES)}"
                )
            entries.append(ColumnEntry(kind="attribute", attribute=attr))

        elif kind == "fact":
            fact_key = item.get("fact_key")
            if not isinstance(fact_key, str) or not fact_key:
                raise block.fail(f"{at} (kind=fact) names no fact_key")
            entries.append(ColumnEntry(kind="fact", fact_key=fact_key))

        else:
            # kind == "metric" OR absent (v1 compatibility: bare metric-ref object)
            ref = read_metric_ref(item, block, at)
            entries.append(ColumnEntry(kind="metric", metric_ref=ref))

    if not entries:
        raise block.fail(
            f"config.{field_name} is empty; a block with no column has nothing to show"
        )
    return tuple(entries)


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


def _fact_columns(
    fact_keys: Sequence[str], *, with_observed_at: bool
) -> tuple[Column, ...]:
    """One column per fact key, plus a `<key>.observed_at` column each when the facts in
    this table disagree about when they were collected.

    ## Why the instant columns are conditional

    The second column exists so two facts on one resource carrying **different**
    `collected_at` instants produce two distinct instant columns — that is the spec's
    stated reason, and it is the case this keeps. What it stopped doing is emitting them
    when every fact agrees, which is the ordinary case: six facts became twelve columns,
    the headers wrapped to four lines, and an A4 page had no width left for the values.
    One agreed instant is one line under the table (`Table.provenance`), not a column
    beside every value.

    The header is the fact key humanised — `os_type` reads as "OS type". A reader is being
    shown a label, not a key; the key stays the column's identity, which is what the
    verifier addresses cells by.
    """
    result: list[Column] = []
    for key in fact_keys:
        result.append(Column(key=key, header=_fact_header(key)))
        if with_observed_at:
            result.append(
                Column(key=f"{key}.observed_at", header=f"{_fact_header(key)} observed")
            )
    return tuple(result)


def _fact_header(key: str) -> str:
    """A fact key as a column label: `private_ip` -> "Private IP".

    Deliberately not a message-catalogue lookup. A fact key is provider data — the
    catalogue would need an entry per key of every resource type, and a key added to
    `facts.v1.json` would render as a missing-message error rather than as itself.
    Initialisms the catalogue would otherwise lower-case are held in `_FACT_INITIALISMS`.

    Sentence case, not title case: the catalogue already spells a two-word header
    "Resources affected", and a table whose own headers disagree about that reads as two
    tables. Initialisms keep their case wherever they fall, so `os_type` is "OS type" and
    `disk_size_gb` is "Disk size GB".
    """
    words = [word for word in key.split("_") if word]
    if not words:
        return key
    return " ".join(
        _FACT_INITIALISMS.get(word) or (word.capitalize() if index == 0 else word)
        for index, word in enumerate(words)
    )


_FACT_INITIALISMS: Final[Mapping[str, str]] = {
    "ip": "IP",
    "os": "OS",
    "nic": "NIC",
    "nsg": "NSG",
    "gb": "GB",
    "id": "ID",
    "sku": "SKU",
    "cpu": "CPU",
    "vm": "VM",
    "dns": "DNS",
}
"""Words a plain `.capitalize()` gets wrong. Everything else title-cases correctly."""


def _fact_instants(
    context: BlockContext,
    resources: Sequence[ResourceView],
    fact_keys: Sequence[str],
) -> frozenset[str]:
    """Every distinct `collected_at` among the named facts on the listed resources.

    Three sizes, three meanings, and the caller needs to tell them apart:

    * **one** — every fact agrees, so the instant is one line under the table;
    * **more than one** — they disagree, which is what the per-fact `observed_at`
      columns exist to show;
    * **none** — no resource carries any of these facts. There is nothing to disagree
      about and nothing to state, so the columns go too. That is the case that printed
      the `Disks` table as three empty rows under seven headers.

    Stops early past two, since no caller distinguishes two from ten. Pure over the
    snapshot, so replay recompiles the same shape.
    """
    if not fact_keys:
        return frozenset()
    wanted = set(fact_keys)
    instants: set[str] = set()
    for resource in resources:
        for fact in context.view.facts_for(resource.resource_id):
            if fact.key in wanted:
                instants.add(fact.collected_at)
                if len(instants) > 1:
                    return frozenset(instants)
    return frozenset(instants)


def _observed_at_fact_value(fact: FactTextValue) -> FactTextValue:
    """A `FactTextValue` for the `collected_at` timestamp of an existing fact.

    Derives from the same snapshot position. The pointer addresses the `collected_at`
    field (indexed by the walk alongside the value field), so `resolve_text_all` can
    prove provenance independently. This is what makes two differing `collected_at`
    instants produce two distinct instant columns — the spec's stated reason for the
    second column's existence.
    """
    # The original pointer is .../facts/N/value; the timestamp lives at .../facts/N/collected_at
    observed_pointer = fact.pointer.rsplit("/", 1)[0] + "/collected_at"
    return FactTextValue(
        key=f"{fact.key}.observed_at",
        value=fact.collected_at,
        source=fact.source,
        collected_at=fact.collected_at,
        pointer=observed_pointer,
        resource_id=fact.resource_id,
        unit=None,
    )


def _resource_row(
    cursor: BlockCursor,
    context: BlockContext,
    resource: ResourceView,
    refs: Sequence[MetricRef],
    *,
    with_tier: bool,
    fact_keys: Sequence[str] = (),
    with_observed_at: bool = True,
) -> Row:
    """One resource's row: its name, optionally its tier, then one cell per metric, then a
    cell per fact key — plus its instant when the table's facts disagree about theirs.

    `with_observed_at` must match what `_fact_columns` was given for the same table, or the
    row would carry a different number of cells than the header declares. Both come from
    one call site (`_resource_rows_table`), which is what keeps them in step.
    """
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

    if fact_keys:
        # Resolve all facts for this resource once; index by key for O(1) lookup.
        resource_facts = {
            f.key: f for f in context.view.facts_for(resource.resource_id)
        }
        for key in fact_keys:
            fact = resource_facts.get(key)
            if fact is None:
                # fact_unavailable: the resource does not carry this fact. EmptyCell,
                # never a zero, never a raise (Req 4.3).
                cells.append(empty_cell(cursor.child("cells", len(cells))))
                if with_observed_at:
                    cells.append(empty_cell(cursor.child("cells", len(cells))))
            else:
                # Value column: a TextFactCell anchored to the fact's value.
                value_cursor = cursor.child("cells", len(cells))
                text_fact = value_cursor.child("fact", 0).text_fact(fact)
                cells.append(TextFactCell(path=value_cursor.path, fact=text_fact))

                if with_observed_at:
                    # Observed_at column: a TextFactCell anchored to the fact's collected_at.
                    obs_cursor = cursor.child("cells", len(cells))
                    obs_fact_value = _observed_at_fact_value(fact)
                    obs_text_fact = obs_cursor.child("fact", 0).text_fact(obs_fact_value)
                    cells.append(TextFactCell(path=obs_cursor.path, fact=obs_text_fact))

    return Row(path=cursor.path, key=resource.resource_id, cells=tuple(cells))  # type: ignore[arg-type]


def _resource_rows_table(
    context: BlockContext,
    block: BlockSpec,
    cursor: BlockCursor,
    refs: Sequence[MetricRef],
    *,
    fact_keys: Sequence[str] = (),
) -> BlockOutput:
    """The shared body of `resource_table` and `top_n_table`."""
    table_cursor = cursor.child("nodes", 0)
    matched = resolve(context.scope_for(block), context.view)
    style = context.design.table_style_name
    caption = caption_of(block)

    if not matched:
        return BlockOutput(nodes=(empty_scope_table(table_cursor, style, caption, messages=context.messages),))

    with_tier = shows_fidelity(block)
    shown = matched[:MAX_TABLE_ROWS]

    # One decision, used by the header and by every row, so the two cannot disagree about
    # how many cells a fact contributes.
    instants = _fact_instants(context, shown, fact_keys)
    with_observed_at = len(instants) > 1
    instant = next(iter(instants)) if len(instants) == 1 else None

    rows: list[Row] = [
        _resource_row(
            table_cursor.child("rows", ordinal), context, resource, refs,
            with_tier=with_tier, fact_keys=fact_keys, with_observed_at=with_observed_at,
        )
        for ordinal, resource in enumerate(shown)
    ]

    truncation = omitted_row(
        table_cursor.child("rows", len(rows)), context.view, len(shown), len(matched),
        messages=context.messages,
    )
    if truncation is not None:
        rows.append(truncation)

    columns = (
        _resource_column(context.messages),
        *((_tier_column(context.messages),) if with_tier else ()),
        *_metric_columns(refs),
        *_fact_columns(fact_keys, with_observed_at=with_observed_at),
    )
    table = Table(
        path=table_cursor.path,
        style=style,
        columns=columns,
        rows=tuple(rows),
        caption=caption,
        provenance=(
            context.messages.text("doc.table.observed_at", instant=instant)
            if instant is not None
            else None
        ),
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
    entries = read_column_entries(block, "columns")
    refs = tuple(e.metric_ref for e in entries if e.kind == "metric" and e.metric_ref is not None)
    fact_keys = tuple(e.fact_key for e in entries if e.kind == "fact" and e.fact_key is not None)
    return _resource_rows_table(
        context, block, cursor, refs, fact_keys=fact_keys,
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
    entries = read_column_entries(block, "columns")
    columns = tuple(e.metric_ref for e in entries if e.kind == "metric" and e.metric_ref is not None)
    fact_keys = tuple(e.fact_key for e in entries if e.kind == "fact" and e.fact_key is not None)
    order_by = read_metric_ref(
        block.config.get("order_by"), block, "config.order_by"
    )

    ordered = (order_by, *(ref for ref in columns if ref.key != order_by.key))
    return _resource_rows_table(context, block, cursor, ordered, fact_keys=fact_keys)


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
        return BlockOutput(nodes=(empty_scope_table(table_cursor, style, caption, messages=context.messages),))

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
            Column(key="metric", header=context.messages.text("doc.table.metric")),
            Column(key="basis", header=context.messages.text("doc.table.basis")),
            Column(key="value", header=context.messages.text("doc.table.value")),
            Column(key="resource", header=context.messages.text("doc.table.resource")),
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
        return BlockOutput(nodes=(empty_scope_table(table_cursor, style, caption, messages=context.messages),))

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
        table_cursor.child("rows", len(rows)), context.view, len(shown), len(matched),
        messages=context.messages,
    )
    if truncation is not None:
        rows.append(truncation)

    table = Table(
        path=table_cursor.path,
        style=style,
        columns=(
            _resource_column(context.messages),
            *((_tier_column(context.messages),) if with_tier else ()),
            Column(key=capacity_ref.key, header=f"{capacity_ref.label} (capacity)"),
            Column(key=usage_ref.key, header=f"{usage_ref.label} (observed)"),
        ),
        rows=tuple(rows),
        caption=caption,
    )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(table,))
