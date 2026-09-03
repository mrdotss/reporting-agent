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
    no_data_table,
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
from reporting_agent.compile.definition import BLOCK_CONFIG
from reporting_agent.compile.messages import Messages
from reporting_agent.errors import CompileFailedError
from reporting_agent.compile.snapshot_view import FactTextValue, ResourceView, SnapshotValue

__all__ = [
    "COLUMN_ATTRIBUTES",
    "COLUMN_KINDS",
    "ColumnEntry",
    "compile_capacity_vs_usage",
    "compile_inventory_summary",
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


def _attribute_column(attribute: str, messages: Messages) -> Column:
    """The header for one attribute column, keyed by the attribute's own name.

    `fidelity_tier` reuses the tier column's header rather than declaring a second wording
    for the same thing. Naming it *while* `show_fidelity` is set is a validation error, so
    the two never both appear.

    `resource_name` never reaches here — see :func:`_emitted_attributes`.
    """
    if attribute == "fidelity_tier":
        return Column(key=attribute, header=messages.text("doc.table.fidelity"))
    return Column(key=attribute, header=messages.text(f"doc.table.attr.{attribute}"))


def _emitted_attributes(attributes: Sequence[str]) -> tuple[str, ...]:
    """The declared attributes minus `resource_name`, which the key column already is.

    Every `resource_table` opens with a key column carrying `resource.name`, so a
    `resource_name` attribute column is that same string a second time. The section
    catalogue declares one on five tables — always first, which is where the key column
    already puts it: the author was saying "the name goes first", not asking for it twice.

    Not merely redundant. `render/anchors.py::assert_header_row` refuses a table whose
    columns share a header, because the verifier addresses a cell by `(row_key,
    column_key)` and reads the column key out of the header text — two columns headed
    "Resource" are two cells at one address. So emitting it would fail the render outright,
    which is exactly what it did the first time these columns were wired up.

    Dropped here rather than rejected at validation: an authored `resource_name` column is
    a reasonable thing to have written and means precisely what the table already does.
    """
    return tuple(a for a in attributes if a != "resource_name")


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


def _answered_fact_keys(
    context: BlockContext,
    resources: Sequence[ResourceView],
    fact_keys: Sequence[str],
) -> tuple[str, ...]:
    """The declared fact keys at least one listed resource actually carries, in the order
    the template declared them.

    A key no resource answers contributes a column of blanks across every row, and a blank
    cell cannot distinguish "this resource has no NSG" from "the collector never reached
    the NSG API". The column is dropped and the key is named in the table's note instead,
    which says which of the two it was and points at the coverage appendix — the same
    trade `metric_summary` makes for a metric that declares no percentile.

    Per key rather than all-or-nothing: the VM network table asked for six facts and got
    one, and printing five empty columns beside the answered one is the same failure at a
    smaller scale.

    Judged over `resources` — the rows this table will actually show — not over the whole
    inventory, so a key answered only by a resource past `MAX_TABLE_ROWS` does not leave a
    blank column behind on the rows that are visible. Pure over the snapshot, so replay
    recompiles the same shape.
    """
    if not fact_keys:
        return ()
    wanted = set(fact_keys)
    answered: set[str] = set()
    for resource in resources:
        for fact in context.view.facts_for(resource.resource_id):
            if fact.key in wanted:
                answered.add(fact.key)
        if len(answered) == len(wanted):
            break
    return tuple(key for key in fact_keys if key in answered)


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
    attributes: Sequence[str] = (),
    fact_keys: Sequence[str] = (),
    with_observed_at: bool = True,
) -> Row:
    """One resource's row: its name, optionally its tier, then a cell per declared
    attribute, then one cell per metric, then a cell per fact key — plus its instant when
    the table's facts disagree about theirs.

    `with_observed_at` must match what `_fact_columns` was given for the same table, or the
    row would carry a different number of cells than the header declares. Both come from
    one call site (`_resource_rows_table`), which is what keeps them in step; `attributes`
    is threaded the same way and for the same reason.
    """
    cells: list[object] = [
        text_cell(cursor.child("cells", 0), resource.name),
    ]
    if with_tier:
        cells.append(text_cell(cursor.child("cells", len(cells)), resource.fidelity_tier))

    # Attributes before metrics: they are what the inventory already knew about the
    # resource, and a reader identifies the row from them before reading its numbers.
    for attribute in attributes:
        cells.append(
            text_cell(
                cursor.child("cells", len(cells)),
                resource_attribute_text(resource, attribute),
            )
        )

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
    attributes: Sequence[str] = (),
    fact_keys: Sequence[str] = (),
) -> BlockOutput:
    """The shared body of `resource_table` and `top_n_table`."""
    table_cursor = cursor.child("nodes", 0)
    matched = context.resources_for(block)
    style = context.design.table_style_name
    caption = caption_of(block)

    if not matched:
        return BlockOutput(nodes=(empty_scope_table(table_cursor, style, caption, messages=context.messages),))

    with_tier = shows_fidelity(block)
    shown = matched[:MAX_TABLE_ROWS]

    # A key nothing answered contributes no column; the note names it instead. Computed
    # once here and passed to both the header and every row, so the two cannot disagree
    # about which facts the table carries.
    answered = _answered_fact_keys(context, shown, fact_keys)
    unanswered = tuple(key for key in fact_keys if key not in answered)

    # A table whose every declared column came back empty says so, rather than printing a
    # column of names beside nothing.
    #
    # `Reserved Instances` scopes to virtual machines on purpose — it answers "which of my
    # machines a reservation covers" — so a subscription with no reservations produced a
    # table headed `Resource` listing CPN-App, CPN-MCP and RAAS-App, which reads as
    # *these are your reserved instances*. It is the opposite of true, and the note
    # underneath explaining that five fact keys were unanswered is not what a reader takes
    # from a list of their own machines under that heading. The disk table and the
    # network-security-group table said the same thing about themselves.
    #
    # Only where the table has nothing else to show: a declared attribute or metric that
    # did resolve is content, and a table carrying one is a table with rows worth printing.
    # `resource_name` does not count, because `_emitted_attributes` drops it — the key
    # column already is that string.
    if fact_keys and not answered and not attributes and not refs:
        return BlockOutput(
            nodes=(
                no_data_table(
                    table_cursor, style, caption, messages=context.messages
                ),
            )
        )

    # One decision, used by the header and by every row, so the two cannot disagree about
    # how many cells a fact contributes.
    instants = _fact_instants(context, shown, answered)
    with_observed_at = len(instants) > 1
    instant = next(iter(instants)) if len(instants) == 1 else None

    # The compiler's line under the table: the one instant its facts agree on, and the
    # keys that were asked for and answered nothing. Either can apply on its own and both
    # can apply together — a table can have three facts observed at one instant and two
    # that resolved for no resource at all.
    #
    # A note rather than a notice row in the table's place: a table listing 500 of 620
    # matched resources is saying something even when none of its facts resolved, and
    # replacing it would discard both the list and the omitted-row count.
    lines: list[str] = []
    if instant is not None:
        lines.append(context.messages.text("doc.table.observed_at", instant=instant))
    if unanswered:
        lines.append(
            context.messages.text("doc.notice.no_facts", keys=", ".join(unanswered))
        )
    note = " ".join(lines) if lines else None

    rows: list[Row] = [
        _resource_row(
            table_cursor.child("rows", ordinal), context, resource, refs,
            with_tier=with_tier, attributes=attributes, fact_keys=answered,
            with_observed_at=with_observed_at,
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
        *(_attribute_column(a, context.messages) for a in attributes),
        *_metric_columns(refs),
        *_fact_columns(answered, with_observed_at=with_observed_at),
    )
    table = Table(
        path=table_cursor.path,
        style=style,
        columns=columns,
        rows=tuple(rows),
        caption=caption,
        note=note,
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
    attributes = _emitted_attributes(
        [e.attribute for e in entries if e.kind == "attribute" and e.attribute is not None]
    )
    fact_keys = tuple(e.fact_key for e in entries if e.kind == "fact" and e.fact_key is not None)
    if str(block.config.get("layout") or "rows") == "pairs":
        return _resource_pairs_table(
            context, block, cursor, refs, attributes=attributes, fact_keys=fact_keys
        )
    return _resource_rows_table(
        context, block, cursor, refs, attributes=attributes, fact_keys=fact_keys,
    )


def _resource_pairs_table(
    context: BlockContext,
    block: BlockSpec,
    cursor: BlockCursor,
    refs: Sequence[MetricRef],
    *,
    attributes: Sequence[str] = (),
    fact_keys: Sequence[str] = (),
) -> BlockOutput:
    """One resource's columns turned into rows: a label beside its value.

    `layout: "pairs"` exists for a section that expands **per resource**. A machine's own
    page wants Size, Operating system, Private IP and Resource group stacked down the
    page, not spread across a five-column table with a single row under it — which is
    what the default layout produces there, and which reads as a table someone forgot
    to finish.

    Every cell is built by the same helpers the row layout uses, so a fact is a
    `TextFactCell` and a metric is a `FigureCell` here exactly as it is there. Only the
    arrangement differs; nothing about provenance does.

    Narrowed to the **first** resolved resource. A per-resource expansion resolves to
    exactly one, and refusing to guess for a scope that resolved to several is better
    than silently profiling one of them: a caller wanting all of them wants the row
    layout, which is the default.
    """
    table_cursor = cursor.child("nodes", 0)
    matched = context.resources_for(block)
    style = context.design.table_style_name
    caption = caption_of(block)
    messages = context.messages

    if not matched:
        return BlockOutput(
            nodes=(empty_scope_table(table_cursor, style, caption, messages=messages),)
        )

    resource = matched[0]
    rows: list[Row] = []
    by_key = {f.key: f for f in context.view.facts_for(resource.resource_id)}

    def add(label: str, key: str, build) -> None:
        row_cursor = table_cursor.child("rows", len(rows))
        value_cursor = row_cursor.child("cells", 1)
        cell = build(value_cursor)
        rows.append(
            Row(
                path=row_cursor.path,
                key=key,
                cells=(text_cell(row_cursor.child("cells", 0), label), cell),
            )
        )

    # In the order the columns were **declared**, not grouped by kind. A machine's card
    # reads Size, OS, Private IP, Resource group because the catalogue lists them that
    # way; emitting every attribute and then every fact would put the resource group
    # above the size no matter how the section was authored, and the author would have no
    # way to change it.
    for entry in read_column_entries(block, "columns"):
        if entry.kind == "attribute" and entry.attribute is not None:
            if entry.attribute not in attributes:
                continue
            text = resource_attribute_text(resource, entry.attribute)
            add(
                _attribute_column(entry.attribute, messages).header,
                f"attr:{entry.attribute}",
                lambda c, text=text: text_cell(c, text),
            )
        elif entry.kind == "fact" and entry.fact_key is not None:
            fact = by_key.get(entry.fact_key)
            if fact is None:
                # A key the profile asked for and this resource does not answer
                # contributes no row. The row layout drops the whole column for the same
                # reason; here the equivalent is dropping the pair, not printing a label
                # beside a blank.
                continue
            add(
                _fact_header(entry.fact_key),
                f"fact:{entry.fact_key}",
                lambda c, fact=fact: TextFactCell(
                    path=c.path, fact=c.child("fact", 0).text_fact(fact)
                ),
            )
        elif entry.kind == "metric" and entry.metric_ref is not None:
            value = resolve_stat(context.view, resource, entry.metric_ref)
            add(
                entry.metric_ref.label,
                entry.metric_ref.key,
                lambda c, value=value: (
                    empty_cell(c) if value is None else _figure_cell(c, context, value)
                ),
            )

    table = Table(
        path=table_cursor.path,
        style=style,
        columns=(
            Column(key="field", header=messages.text("doc.table.field")),
            Column(key="value", header=messages.text("doc.table.value")),
        ),
        rows=tuple(rows),
        caption=caption,
    )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(table,))


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

    attributes = _emitted_attributes(
        [e.attribute for e in entries if e.kind == "attribute" and e.attribute is not None]
    )
    ordered = (order_by, *(ref for ref in columns if ref.key != order_by.key))
    return _resource_rows_table(
        context, block, cursor, ordered, attributes=attributes, fact_keys=fact_keys
    )


# ---------------------------------------------------------------------------
# metric_summary — the block that replaced the per-day dump
# ---------------------------------------------------------------------------

SUMMARY_STATISTICS: Final[tuple[str, ...]] = ("avg", "p95", "max", "min")
"""The statistics a summary row reports, in column order.

`avg`, `max` and `min` are exact — the collector computes all three over every sample.
`p95` is an **estimate** from the folded sketch and only exists where the Metric_Catalog declares it,
which today is `Percentage CPU` alone; its column is omitted entirely for a metric that
declares none rather than printed as a row of blanks.

Deliberately not configurable. A summary whose columns varied per profile would be a
second thing to author and a second thing to get wrong, and the point of the block is that
one row describes one resource over one period the same way every time.
"""


def compile_metric_summary(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One table per selected metric: a row per resource, a period in four numbers.

    ## What this replaces

    A month of `timeseries_chart` companion rows is one row per plotted point per series —
    three machines over July is 93 rows, and twenty machines is 620. Nobody reads 620 rows
    to learn that CPU sat near idle with one spike. This says that in three.

    The daily values are not lost: they remain in the snapshot, in the ledger, and in the
    chart's own companion table, which is where a reader who wants a specific day looks.

    ## Peak at

    A `TextCell` carrying the local day whose daily maximum equals the window maximum —
    derived here by argmax over `day_series`, the same series the chart plots. Derived
    rather than collected, and therefore not a figure: the figure is the peak itself, in
    the column beside it. The derivation is pure over the snapshot, so a replay recomputes
    the same day, and a date is masked as a date by `verify/masking.py`'s fourth stage.

    Ties go to the **earliest** day. A resource that hit its maximum twice has no single
    peak day, and picking the earlier one is at least a rule rather than whichever the
    dictionary happened to yield.
    """
    refs = read_metric_refs(block, "metrics")
    matched = context.resources_for(block)
    style = context.design.table_style_name
    caption = caption_of(block)

    # One table per distinct metric name, in the order the section selected them. The
    # statistics are this block's own, so two refs naming one metric with different
    # statistics are one table, not two.
    names: list[str] = []
    for ref in refs:
        if ref.name not in names:
            names.append(ref.name)

    if str(block.config.get("orientation") or "resource_major") == "statistic_major":
        nodes: list[Table] = []
        for ordinal, name in enumerate(names):
            table_cursor = cursor.child("nodes", ordinal)
            if not matched:
                nodes.append(
                    empty_scope_table(
                        table_cursor, style, caption, messages=context.messages
                    )
                )
                continue
            nodes.append(
                _statistic_major_table(
                    context, table_cursor, name, matched[0], style, caption
                )
            )
            cursor.anchor_table(table_cursor.path)
        return BlockOutput(nodes=tuple(nodes))

    nodes: list[Table] = []
    for ordinal, name in enumerate(names):
        table_cursor = cursor.child("nodes", ordinal)
        if not matched:
            nodes.append(
                empty_scope_table(table_cursor, style, caption, messages=context.messages)
            )
            continue
        nodes.append(
            _metric_summary_table(
                context, table_cursor, name, matched[:MAX_TABLE_ROWS], style, caption
            )
        )
        cursor.anchor_table(table_cursor.path)

    return BlockOutput(nodes=tuple(nodes))


def _metric_summary_table(
    context: BlockContext,
    table_cursor: BlockCursor,
    metric: str,
    resources: Sequence[ResourceView],
    style: str,
    caption: str | None,
) -> Table:
    """One metric's summary table over `resources`."""
    # A statistic earns its column only if some resource has it. `p95` is declared for one
    # metric in the whole catalogue, so an unconditional column would be blank in every
    # table but one.
    present = tuple(
        statistic
        for statistic in SUMMARY_STATISTICS
        if any(
            context.view.stat(resource.resource_id, metric, statistic) is not None
            for resource in resources
        )
    )

    rows: list[Row] = []
    for ordinal, resource in enumerate(resources):
        row_cursor = table_cursor.child("rows", ordinal)
        cells: list[object] = [text_cell(row_cursor.child("cells", 0), resource.name)]
        for statistic in present:
            cell_cursor = row_cursor.child("cells", len(cells))
            value = context.view.stat(resource.resource_id, metric, statistic)
            cells.append(
                empty_cell(cell_cursor)
                if value is None
                else _figure_cell(cell_cursor, context, value)
            )
        peak_day = _peak_day(context, resource, metric)
        cells.append(
            text_cell(row_cursor.child("cells", len(cells)), peak_day)
            if peak_day is not None
            else empty_cell(row_cursor.child("cells", len(cells)))
        )
        rows.append(
            Row(path=row_cursor.path, key=resource.resource_id, cells=tuple(cells))  # type: ignore[arg-type]
        )

    columns = (
        _resource_column(context.messages),
        *(
            Column(
                key=f"{metric}:{statistic}",
                header=context.messages.text(f"doc.summary.{statistic}"),
            )
            for statistic in present
        ),
        Column(key=f"{metric}:peak_at", header=context.messages.text("doc.summary.peak_at")),
    )
    return Table(
        path=table_cursor.path,
        style=style,
        columns=columns,
        rows=tuple(rows),
        caption=caption or metric,
    )


def _peak_day(
    context: BlockContext, resource: ResourceView, metric: str
) -> str | None:
    """The earliest local day whose daily maximum equals this resource's window maximum.

    `None` when the window has no maximum, or when no day's maximum reaches it — the
    second is possible when a day bucket is missing, and inventing a day for a peak whose
    day was not collected would be the kind of quiet fabrication the whole product exists
    to refuse.
    """
    window_max = context.view.stat(resource.resource_id, metric, "max")
    if window_max is None:
        return None
    for local_day, value in context.view.day_series(resource.resource_id, metric, "max"):
        if value.value == window_max.value:
            return local_day
    return None


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
    matched = context.resources_for(block)
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
    matched = context.resources_for(block)
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


def _statistic_major_table(
    context: BlockContext,
    table_cursor: BlockCursor,
    metric: str,
    resource: ResourceView,
    style: str,
    caption: str | None,
) -> Table:
    """One machine's one metric, a row per statistic: `Statistic | Value | Samples`.

    ## Why not one row per metric, which is what the artifact draws

    The artifact's per-machine table is metric-major — `Metric | Average | Maximum |
    Minimum | Samples`, one row per metric — and that shape was built first. Against the
    real estate it needs **132 characters of a 70-character page**: three byte-valued
    columns at 22 characters each (`3,489,660,928.00 bytes`) beside a P95 whose estimator
    label is inside the formatted string (`0.25% (p95, est. from hourly averages)`, 38).
    `tablefit.allocate` water-fills that to 10.4 characters a column, every value wraps,
    and a wrapped figure has no contiguous occurrence in the extracted PDF text — six
    `pdf_figure_missing` findings, and a report withheld.

    The artifact's shape fits because the artifact writes `6.88 GB`, not
    `3,489,660,928.00 bytes`. Scaling bytes is the real fix and it is not available
    here: `format_figure` is the one place a figure becomes a string, `verify_report`
    requires a recompiled ledger to be byte-identical to the stored one, and changing
    the string would fail re-verification for every report already delivered. See
    `compile/format.py::display_scale`, where the same constraint blocks a count from
    reading `23` instead of `23.00`.

    So this transposes the other way. One table per metric keeps the wide values apart:
    a byte metric's table is `Statistic(10) + Value(22) + Samples(9)`, and the CPU table
    carries the 38-character P95 alone. Both fit, every figure stays on one line, and
    the reader still gets one machine's numbers under that machine's heading.
    """
    messages = context.messages
    present = tuple(
        statistic
        for statistic in SUMMARY_STATISTICS
        if context.view.stat(resource.resource_id, metric, statistic) is not None
    )
    with_samples = any(
        context.view.sample_count_of(resource.resource_id, metric, statistic) is not None
        for statistic in present
    )

    rows: list[Row] = []
    for ordinal, statistic in enumerate(present):
        row_cursor = table_cursor.child("rows", ordinal)
        cells: list[object] = [
            text_cell(
                row_cursor.child("cells", 0),
                messages.text(f"doc.summary.{statistic}"),
            )
        ]
        value_cursor = row_cursor.child("cells", 1)
        value = context.view.stat(resource.resource_id, metric, statistic)
        cells.append(
            empty_cell(value_cursor)
            if value is None
            else _figure_cell(value_cursor, context, value)
        )
        if with_samples:
            samples_cursor = row_cursor.child("cells", 2)
            samples = context.view.sample_count_of(
                resource.resource_id, metric, statistic
            )
            cells.append(
                empty_cell(samples_cursor)
                if samples is None
                else _figure_cell(samples_cursor, context, samples)
            )
        rows.append(Row(path=row_cursor.path, key=statistic, cells=tuple(cells)))

    columns = (
        Column(key="statistic", header=messages.text("doc.table.statistic")),
        Column(key="value", header=messages.text("doc.table.value")),
        *(
            (Column(key="samples", header=messages.text("doc.summary.samples")),)
            if with_samples
            else ()
        ),
    )
    return Table(
        path=table_cursor.path,
        style=style,
        columns=columns,
        rows=tuple(rows),
        caption=caption or metric,
    )

# ---------------------------------------------------------------------------
# inventory_summary — the estate reported as its own groupings
# ---------------------------------------------------------------------------

INVENTORY_GROUP_BY: Final[tuple[str, ...]] = (
    "subscription",
    "resource_group",
    "region",
    "resource_type",
)
"""The four groupings, mirrored in `compile/definition.py`'s `BLOCK_CONFIG` enum."""

_INVENTORY_DIMENSION: Final[dict[str, str]] = {
    "resource_group": "resource_group",
    "region": "location",
    "resource_type": "resource_type",
}
"""`group_by` value → the snapshot dimension it counts over.

`region` is the reader's word and `location` is the snapshot's; the mapping is here so
the catalogue can say `region` without the snapshot having to rename a field.
"""

assert set(INVENTORY_GROUP_BY) == set(
    BLOCK_CONFIG["inventory_summary"]["enums"]["group_by"]
), (
    "the groupings this compiler handles and the ones the validator admits disagree: "
    f"{sorted(set(INVENTORY_GROUP_BY) ^ set(BLOCK_CONFIG['inventory_summary']['enums']['group_by']))}"
)
assert set(_INVENTORY_DIMENSION) == set(INVENTORY_GROUP_BY) - {"subscription"}, (
    "every grouping but `subscription` is a rollup and needs a snapshot dimension to "
    f"count over: {sorted(set(INVENTORY_GROUP_BY) - {'subscription'} ^ set(_INVENTORY_DIMENSION))}"
)
assert all(
    hasattr(ResourceView, dimension) for dimension in _INVENTORY_DIMENSION.values()
), (
    "a rollup dimension names no field on ResourceView, so `getattr` would silently "
    "group every resource under the empty string and the table would come out empty: "
    f"{sorted(d for d in _INVENTORY_DIMENSION.values() if not hasattr(ResourceView, d))}"
)


def compile_inventory_summary(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """The estate as its groupings, not as a list of its resources.

    ## The defect this replaces

    `azure_subscription` and `resource_groups` both expanded to a `resource_table` whose
    columns were an attribute plus `{"kind": "fact", "fact_key": "count"}`. No resource
    answers a fact called `count` — a `resource_table` emits one row **per resource** —
    so a section meant to say "23 resources across 2 groups" printed 23 rows of resource
    type with an empty column beside them. Nothing failed: an unanswered fact key
    contributes no column and says so in the note, which is correct behaviour for a fact
    that happens to be unanswered and useless for a count that was never a fact.

    ## Two shapes, one block

    * ``group_by: "subscription"`` — a **pairs** table: subscription id, total resources,
      resource groups, regions. One row per property, two columns, no header row.
    * ``group_by: "resource_group" | "region" | "resource_type"`` — one row per distinct
      value of that dimension, ordered by resource count descending then name ascending,
      with the count in the last column.

    They are one block because they answer one question at two grains, and because the
    counts on both sides come from the same place.

    ## Why every count here is a figure

    A count printed as text is a numeral the verifier finds in the document and cannot
    match to anything, which is `unmatched_prose_token`. So each count is resolved
    through `SnapshotView.cardinality`, which mints it as a `SnapshotValue` carrying its
    own snapshot pointer and a `formula` naming the collection counted. A replay derives
    the identical value from the identical snapshot, and the verifier re-resolves the
    pointer rather than trusting the page.

    That is also why this block never computes a count itself. `len(matched)` would be
    just as correct and would produce a number with no provenance — the distinction the
    whole document format exists to preserve.
    """
    group_by = str(block.config.get("group_by") or "")
    if group_by not in INVENTORY_GROUP_BY:
        raise CompileFailedError(
            f"inventory_summary block {block.id!r} declares group_by={group_by!r}, "
            f"which is not one of {', '.join(INVENTORY_GROUP_BY)}"
        )

    table_cursor = cursor.child("nodes", 0)
    style = context.design.table_style_name
    caption = caption_of(block)

    if group_by == "subscription":
        table = _subscription_pairs_table(context, table_cursor, style, caption)
    else:
        table = _dimension_rollup_table(
            context, table_cursor, _INVENTORY_DIMENSION[group_by], style, caption
        )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(table,))


def _subscription_pairs_table(
    context: BlockContext,
    table_cursor: BlockCursor,
    style: str,
    caption: str | None,
) -> Table:
    """Subscription id and the three estate-wide counts, one property per row.

    The subscription id is plain text, not a figure: it is an identifier that happens to
    contain digits, and minting it as a quantity would put a number in the ledger that no
    arithmetic is true of. It reaches the reader through the static-text allowlist
    instead — `verify/allowlist.py`'s null-context render keeps `subscription_id`
    (it describes *where* the collection happened, not what was measured), so this row
    renders identically there and its digits are admitted as chrome.
    """
    messages = context.messages
    rows: list[Row] = []

    subscription_id = context.view.subscription_id
    if subscription_id:
        row_cursor = table_cursor.child("rows", len(rows))
        rows.append(
            Row(
                path=row_cursor.path,
                key="subscription_id",
                cells=(
                    text_cell(
                        row_cursor.child("cells", 0),
                        messages.text("doc.inventory.subscription_id"),
                    ),
                    text_cell(row_cursor.child("cells", 1), subscription_id),
                ),
            )
        )

    for key, label_id, tokens in (
        ("total_resources", "doc.inventory.total_resources", ("resources",)),
        ("resource_groups", "doc.inventory.resource_groups", ("resource_group",)),
        ("regions", "doc.inventory.regions", ("location",)),
    ):
        value = context.view.cardinality(*tokens)
        if value is None:
            continue
        row_cursor = table_cursor.child("rows", len(rows))
        rows.append(
            Row(
                path=row_cursor.path,
                key=key,
                cells=(
                    text_cell(row_cursor.child("cells", 0), messages.text(label_id)),
                    _figure_cell(row_cursor.child("cells", 1), context, value),
                ),
            )
        )

    return Table(
        path=table_cursor.path,
        style=style,
        columns=(
            Column(key="field", header=messages.text("doc.table.field")),
            Column(key="value", header=messages.text("doc.table.value")),
        ),
        rows=tuple(rows),
        caption=caption,
    )


def _dimension_rollup_table(
    context: BlockContext,
    table_cursor: BlockCursor,
    dimension: str,
    style: str,
    caption: str | None,
) -> Table:
    """One row per distinct value of `dimension`, with its resource count.

    Ordered by count descending, then by name ascending — the artifact's "ordered by
    resource count" with a total order rather than a partial one, so two groups holding
    four resources each land in the same order on every replay.

    A resource group also carries its region, which is the estate's own second dimension
    and the column the reader needs to tell `rg-app-sea` from `rg-app-idn`. A group
    spanning regions gets both, comma-joined, rather than the first one found — a group
    is not required to be single-region and silently reporting one of two would be a
    wrong fact rather than a missing one.
    """
    messages = context.messages
    resources = context.view.resources

    members: dict[str, list[ResourceView]] = {}
    for resource in resources:
        key = getattr(resource, dimension, "")
        if key:
            members.setdefault(key, []).append(resource)

    if not members:
        return empty_scope_table(table_cursor, style, caption, messages=messages)

    counted: list[tuple[str, SnapshotValue | None, list[ResourceView]]] = [
        (name, context.view.cardinality(dimension, "by_name", name), group)
        for name, group in members.items()
    ]
    counted.sort(key=lambda entry: (-len(entry[2]), entry[0]))

    with_region = dimension == "resource_group"
    rows: list[Row] = []
    for ordinal, (name, value, group) in enumerate(counted[:MAX_TABLE_ROWS]):
        row_cursor = table_cursor.child("rows", ordinal)
        cells: list[object] = [text_cell(row_cursor.child("cells", 0), name)]
        if with_region:
            regions = ", ".join(sorted({r.location for r in group if r.location}))
            cells.append(text_cell(row_cursor.child("cells", len(cells)), regions))
        count_cursor = row_cursor.child("cells", len(cells))
        cells.append(
            empty_cell(count_cursor)
            if value is None
            else _figure_cell(count_cursor, context, value)
        )
        rows.append(Row(path=row_cursor.path, key=name, cells=tuple(cells)))

    truncation = omitted_row(
        table_cursor.child("rows", len(rows)),
        context.view,
        len(rows),
        len(counted),
        messages=messages,
        total_tokens=(dimension,),
        cells=3 if with_region else 2,
    )
    if truncation is not None:
        rows.append(truncation)

    columns = (
        Column(key="name", header=messages.text("doc.inventory.name")),
        *(
            (Column(key="region", header=messages.text("doc.inventory.region")),)
            if with_region
            else ()
        ),
        Column(key="count", header=messages.text("doc.inventory.resources")),
    )
    return Table(
        path=table_cursor.path,
        style=style,
        columns=columns,
        rows=tuple(rows),
        caption=caption,
    )
