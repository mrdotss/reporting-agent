"""What every block compiler shares: the context, the output shape, the theme style
vocabulary, and the config readers.

## One module per declared block type, and this one holds what they agree on

Sixteen block types, sixteen modules, and this file is the seam. It carries no block
logic — only the things a block cannot decide for itself: which theme styles exist, how a
`(metric, statistic)` reference in a config is read, what an empty scope renders as, and
what a compiler is handed and returns.

## The style vocabulary is declared here because the Theme_Guard reads it

`agent/themes/*.docx` must define **every** paragraph and table style the declared block
types reference, asserted at build time (task 7.1). That assertion needs the referenced set
as data, and a set assembled by grepping sixteen modules for string literals is a set that
drifts. So :data:`PARAGRAPH_STYLES` and :data:`TABLE_STYLES` are the declaration, every
block module reads a name from here, and a style a theme forgets is a build failure rather
than a silently unstyled run.

## Config value shapes are validated here, and that is a real tension worth stating

`compile/definition.py`'s `BLOCK_CONFIG` is deliberately **shallow**: field *names*,
required status, and enumerated values — nothing about the shape of a field's *value*. That
is what lets the Mirror_Guard compare two declarations without either side needing a parser.

The cost is that a config value's shape is checked **here**, at compile time, and not at
save time. A definition carrying `columns: ["cpu"]` therefore saves cleanly and fails to
compile — the save-then-fail divergence the mirror exists to prevent, reappearing one level
down. Two things keep it bounded:

* The readers below accept exactly what `app/lib/templates/starters.ts` writes, which is
  what the builder produces, so the shapes are pinned by the shipped starters and by the
  corpus that runs through both validators.
* A shape this module cannot read is a `COMPILE_FAILED` **naming the block's id, its type
  and the config path** — not a silently skipped column. A dropped column is a document
  quietly missing something the author configured, which is worse than a failed run.

## An empty scope is information, never an absence

:func:`empty_scope_table` is the one shape every scoped block uses when its scope resolves
to nothing (Req 3.7, 16.10): a table carrying one explicit row, styled as a notice rather
than as a failure, emitting **zero figures**, keeping the block's heading and its position
in the document. A block that vanished is indistinguishable from one that was never
configured, and the reader cannot tell an empty result from a missing section.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final, Protocol

from reporting_agent.compile.ast import (
    Block,
    Column,
    EmptyCell,
    FigureCell,
    Paragraph,
    Row,
    Table,
    Text,
    TextCell,
)
from reporting_agent.compile.estimators import COMPARE_ESTIMATORS, DECLARED_ESTIMATORS
from reporting_agent.compile.figures import BlockCursor, FigureLedger
from reporting_agent.compile.format import NumberFormat
from reporting_agent.compile.scope import ScopeRules, scope_rules_from_plain
from reporting_agent.compile.snapshot_view import (
    SKU_CAPACITY_STATISTIC,
    SKU_METRIC_PREFIX,
    ResourceView,
    SnapshotValue,
    SnapshotView,
)
from reporting_agent.errors import CompileFailedError

__all__ = [
    "CAPTION_STYLE",
    "EMPTY_SCOPE_TEXT",
    "LAYOUT_TABLE_STYLE",
    "MAX_CHART_POINTS",
    "MAX_CHART_SERIES",
    "MAX_HEADING_LEVEL",
    "MAX_TABLE_ROWS",
    "NON_CATALOG_ESTIMATORS",
    "NOTICE_COLUMN_HEADER",
    "NOTICE_STYLE",
    "NOT_COMPARABLE_TEXT",
    "NO_GAPS_TEXT",
    "OMITTED_ROW_LABEL",
    "PARAGRAPH_STYLES",
    "SKU_CAPABILITY_FIELDS",
    "TABLE_STYLES",
    "BlockContext",
    "BlockOutput",
    "BlockSpec",
    "CapacityRef",
    "ComparisonSource",
    "Deferred",
    "DesignSettings",
    "MetricRef",
    "ProseProvider",
    "ProseRequest",
    "caption_of",
    "empty_cell",
    "empty_scope_table",
    "heading_style",
    "omitted_row",
    "read_capacity_ref",
    "read_metric_ref",
    "read_metric_refs",
    "resolve_capacity",
    "resolve_stat",
    "shows_fidelity",
    "table_style_name",
    "text_cell",
    "text_paragraph",
]


# --- the theme style vocabulary -----------------------------------------------------

PARAGRAPH_STYLES: Final[tuple[str, ...]] = (
    "Title",
    "Subtitle",
    "Heading 1",
    "Heading 2",
    "Heading 3",
    "Heading 4",
    "Body Text",
    "Caption",
    "Notice",
)
"""Every paragraph style the declared block types reference.

`Notice` is the empty-scope and no-gaps row's style, and it is a **separate style from
`Body Text` on purpose**: `design-system.md` requires those rows in mist neutrals rather
than in `--destructive`, because an empty result is information and not an error. Making it
a style rather than inline formatting is what lets a theme honour that."""

TABLE_STYLES: Final[tuple[str, ...]] = (
    "Table Hairline",
    "Table Banded",
    "Table Bordered",
    "Layout Table",
)
"""Every table style the declared block types reference.

The first three are the template's `design.table_style` choices. `Layout Table` is the
**borderless** style a `row` block's container takes, and it exists so the verifier's table
pass can exclude a layout table by construction: a data table always carries a
`w:tblCaption` id, a layout table never does (Req 15.9)."""

LAYOUT_TABLE_STYLE: Final[str] = "Layout Table"

_TABLE_STYLE_BY_SETTING: Final[tuple[tuple[str, str], ...]] = (
    ("hairline", "Table Hairline"),
    ("banded", "Table Banded"),
    ("bordered", "Table Bordered"),
)

NON_CATALOG_ESTIMATORS: Final[frozenset[str]] = DECLARED_ESTIMATORS | COMPARE_ESTIMATORS
"""Estimators whose values the Metric_Catalog does not describe.

A derived cardinality, a declared SKU capacity and a run-to-run difference. Their scale comes
from the value itself, because the catalog has nothing to say about the precision of a count,
a published capacity or a subtraction — see :meth:`BlockContext.catalog_scale`."""

MAX_HEADING_LEVEL: Final[int] = 4
MAX_TABLE_ROWS: Final[int] = 500
"""Req 16.2 — a resource or top-N table renders at most this many resource rows, then
states the omitted count as a figure. A table longer than this is unreadable in a paginated
document, and a truncated table that did not say so would present a partial list as
complete."""

EMPTY_SCOPE_TEXT: Final[str] = "No resources matched this scope"
NO_GAPS_TEXT: Final[str] = "No gaps recorded for this collection"

CAPTION_STYLE: Final[str] = "Caption"
"""The paragraph style a table's or chart's caption takes.

Declared here rather than as a literal in `render/docx.py` for the reason this module's
docstring gives about the style vocabulary: the Theme_Guard reads these constants, and a
name only the renderer knows is a name a theme can forget to declare."""

NOTICE_STYLE: Final[str] = "Notice"
"""The paragraph style the explicit no-data rows take.

A `caption` travels as `Table.caption` and a notice row as a `TextCell`, so neither carries
a style in the AST — both are applied by the renderer. See `render/themes.py`'s
`RENDERER_APPLIED_STYLES`."""

NOTICE_COLUMN_HEADER: Final[str] = "Scope"
"""The header of the single column an empty-scope table carries.

Non-empty because Req 21.4 requires **every** data-table column header to be a non-empty
string the verifier can resolve a column by, and an empty-scope table is an ordinary data
table that happens to carry zero figures (Req 21.11) rather than a special kind of node.

Leaving it blank would have forced the renderer or the verifier to special-case a table by
inspecting its contents, which is exactly the guessing the caption contract exists to
avoid — and a one-column table with a blank header row also just looks broken in a
delivered document."""
OMITTED_ROW_LABEL: Final[str] = (
    "Not every matched resource is listed above; this table is capped. "
    "Resources in the subscription:"
)
"""The truncation row's label. **Carries no numeral** — see :func:`omitted_row`."""
NOT_COMPARABLE_TEXT: Final[str] = "Not comparable — fidelity tiers differ between runs"

MAX_CHART_SERIES: Final[int] = 5
"""`design-system.md`'s categorical cap, applied at compile time rather than left to the
renderer.

A single-lightness, single-chroma hue ring supports about five reliably separable hues, so
past five the palette must start modulating lightness — at which point it has reinvented the
sequential ramp and lost categorical parity. Capping here means the chart the document
carries and the chart the app renders agree on which series exist, because both read the same
AST."""

MAX_CHART_POINTS: Final[int] = 200
"""A bound on one series' points, so a chart over a month of local days at a large scope
stays a readable figure rather than a black band."""

SKU_CAPABILITY_FIELDS: Final[tuple[tuple[str, str], ...]] = (
    ("vCPUsAvailable", "vcpus_available"),
    ("MemoryGB", "memory_bytes"),
)
"""The Metric_Catalog's SKU capability names, and the snapshot field each lands in.

A template's `capacity_vs_usage.capacity_metric` names the **catalog's** capability —
`vCPUsAvailable`, `MemoryGB` — because that is the vocabulary the wizard shows. The snapshot
stores `vcpus_available` and `memory_bytes`. The rename is not cosmetic in the second case:
the catalog declares `MemoryGB` in **GiB** and the collector converted it to **bytes** at
scale 0 before storing, so a compiler that assumed the catalog's unit would be off by
2^30."""


def heading_style(level: object) -> str:
    """The theme paragraph style for a `heading` block's level.

    **Clamped, not refused.** `BLOCK_CONFIG` declares `heading`'s fields by name and does
    not bound `level`, so a definition carrying `level: 9` is one both validators accept.
    Refusing it here would fail a run for a definition the wizard saved cleanly — the
    save-then-fail divergence the mirror exists to prevent. Clamping renders the heading at
    the deepest style the theme defines, which is the outcome an author asking for a
    ninth-level heading would recognise.
    """
    if isinstance(level, bool) or not isinstance(level, int) or level < 1:
        return "Heading 1"
    return f"Heading {min(level, MAX_HEADING_LEVEL)}"


def table_style_name(setting: str) -> str:
    """The theme table style for a template's `design.table_style`."""
    for declared, style in _TABLE_STYLE_BY_SETTING:
        if declared == setting:
            return style
    return "Table Hairline"


# --- the design settings ------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DesignSettings:
    """A template's `design` object, as the compiler needs it (Req 7.1, 7.2)."""

    preset: str = "editorial"
    accent_color: str = ""
    density: str = "normal"
    table_style: str = "hairline"
    number_format: NumberFormat = field(default_factory=NumberFormat)
    cover_page: bool = True
    logo: str | None = None
    page_size: str = "A4"

    @property
    def table_style_name(self) -> str:
        return table_style_name(self.table_style)

    @classmethod
    def from_plain(cls, raw: object) -> DesignSettings:
        if not isinstance(raw, Mapping):
            return cls()
        number_format_raw = raw.get("number_format")
        number_format = NumberFormat()
        if isinstance(number_format_raw, Mapping):
            number_format = NumberFormat(
                decimal_places=int(number_format_raw.get("decimal_places", 1)),
                group_thousands=bool(number_format_raw.get("group_thousands", True)),
            )
        logo = raw.get("logo")
        return cls(
            preset=str(raw.get("preset", "editorial")),
            accent_color=str(raw.get("accent_color", "")),
            density=str(raw.get("density", "normal")),
            table_style=str(raw.get("table_style", "hairline")),
            number_format=number_format,
            cover_page=bool(raw.get("cover_page", True)),
            logo=logo if isinstance(logo, str) else None,
            page_size=str(raw.get("page_size", "A4")),
        )


# --- the block, as a typed thing ----------------------------------------------------


@dataclass(frozen=True, slots=True)
class BlockSpec:
    """One block from a validated definition, typed.

    `columns` is populated only for a `row` and is a **list of lists** exactly as the
    definition carries it, so "2 or 3 columns" stays that tuple's own length all the way
    from the schema to the AST.
    """

    id: str
    type: str
    config: Mapping[str, object] = field(default_factory=dict)
    scope_override: ScopeRules | None = None
    columns: tuple[tuple[BlockSpec, ...], ...] = ()

    @classmethod
    def from_plain(cls, raw: object, *, at: str) -> BlockSpec:
        if not isinstance(raw, Mapping):
            raise CompileFailedError(f"{at} is not a block object")

        block_id = raw.get("id")
        block_type = raw.get("type")
        if not isinstance(block_id, str) or not block_id:
            raise CompileFailedError(f"{at} carries no usable block id")
        if not isinstance(block_type, str) or not block_type:
            raise CompileFailedError(f"{at} (id {block_id!r}) carries no block type")

        config_raw = raw.get("config")
        config: Mapping[str, object] = (
            dict(config_raw) if isinstance(config_raw, Mapping) else {}
        )

        if block_type == "row":
            raw_columns = raw.get("columns")
            if not isinstance(raw_columns, Sequence) or isinstance(raw_columns, str):
                raise CompileFailedError(
                    f"block {block_id!r} (row) carries no columns array"
                )
            return cls(
                id=block_id,
                type=block_type,
                config=config,
                columns=tuple(
                    tuple(
                        cls.from_plain(
                            child, at=f"block {block_id!r} column {index} child {position}"
                        )
                        for position, child in enumerate(column)
                    )
                    for index, column in enumerate(raw_columns)
                    if isinstance(column, Sequence) and not isinstance(column, str)
                ),
            )

        override = raw.get("scope_override")
        return cls(
            id=block_id,
            type=block_type,
            config=config,
            scope_override=(
                None
                if override is None
                else scope_rules_from_plain(
                    override, at=f"block {block_id!r} scope_override"
                )
            ),
        )

    def fail(self, reason: str) -> CompileFailedError:
        """A `COMPILE_FAILED` naming this block's id and type (Req 16.11).

        Both, always: the id locates the block in the definition the author edits, and the
        type says which compiler refused, which is what turns "the report failed" into one
        fix.
        """
        return CompileFailedError(
            f"block {self.id!r} of type {self.type!r} could not be compiled: {reason}"
        )


# --- prose (the model's only entry point) --------------------------------------------


@dataclass(frozen=True, slots=True)
class ProseRequest:
    """Everything the model is allowed to see (Req 19.1).

    The ledger's **formatted** strings, the aggregate table and the collection-log gap
    counts — and nothing else. Deliberately not the raw snapshot: a model handed a series
    could average it, and a number it computed has no `snapshot_path`, so it could not
    become a figure and would be caught by the verifier as an unmatched token. Withholding
    the series means the model is never in a position to try.
    """

    block_id: str
    report_title: str
    subscription_display_name: str
    window: str
    grain: str
    resource_count: int
    gap_counts: Mapping[str, int] = field(default_factory=dict)
    figures: tuple[tuple[str, str], ...] = ()
    """`(label, formatted)` pairs from the ledger. The **formatted string**, never the
    value: the model reads what the document will say, so a figure it quotes is a figure
    that already exists."""


class ProseProvider(Protocol):
    """What `narrate/` supplies. Prose in, prose out; no numbers either way."""

    def narrate(self, request: ProseRequest) -> str: ...


class ComparisonSource(Protocol):
    """Resolves a completed run's stored snapshot, for `comparison_delta` (Req 16.7).

    A protocol rather than a concrete reader because a delta is compiled from **two stored
    snapshots and no Azure call**: whether they come from S3, from a local cache or from a
    test fixture is the pipeline's business, and `compare/delta.py` must stay pure enough for
    replay to import it.
    """

    def snapshot_for(self, run_id: str) -> SnapshotView | None: ...


@dataclass(frozen=True, slots=True)
class Deferred:
    """A block that cannot be finished until every other block has compiled (Req 16.12).

    Two blocks need this, for the same structural reason and with different consequences:

    * **`executive_summary`** — the model's context is the **complete** ledger, so it cannot
      be asked until every block's compiler-placed figures exist. `prose_request` is set.
    * **`appendix_methodology`** — it reads each estimated statistic's label *from the
      ledger* (Req 16.6) and composes none of its own, so it likewise needs the ledger
      finished. `prose_request` is `None`: no model is involved, and
      `compile_document` calls `finish(None)` directly.

    `finish` assembles that block's nodes **once**, from parts already built, mutating
    nothing. Where a block mints figures, it mints them in phase one at **fixed** ordinals —
    see `executive_summary`'s docstring for why the figures have to come before the prose.
    """

    block_id: str
    finish: Callable[[str | None], tuple[Block, ...]]
    prose_request: ProseRequest | None = None


@dataclass(frozen=True, slots=True)
class BlockOutput:
    """What a block compiler returns: the nodes it emitted, in document order.

    A block may emit several nodes — a caption paragraph and a table, say — and the tuple's
    order **is** their order in the document. `deferred` is set only by
    `executive_summary`; for every other block the nodes are final when the compiler
    returns.
    """

    nodes: tuple[Block, ...] = ()
    deferred: Deferred | None = None


# --- the compile context -------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BlockContext:
    """Everything a block compiler is handed.

    No client, no clock and no network — the same discipline `compile/scope.py` keeps, for
    the same reason: replay re-runs this stage over a stored snapshot and must produce a
    bit-identical ledger.
    """

    view: SnapshotView
    ledger: FigureLedger
    design: DesignSettings
    default_scope: ScopeRules
    period: Mapping[str, object] = field(default_factory=dict)
    report_title: str = ""
    subscription_display_name: str = ""
    metrics: Mapping[str, Sequence[Mapping[str, object]]] = field(default_factory=dict)
    prose: ProseProvider | None = None
    comparison: ComparisonSource | None = None
    catalog_scales: Mapping[str, int] | None = None
    """Per-metric fractional-digit counts, when a caller has the loaded catalog to hand.

    **`None` — the default — means "use each value's own stored scale"**, and that is the
    better answer for an archived report rather than a shortcut. The collector serialized
    every value at the catalog scale in force when it ran, so the stored scale *is* that
    scale; reading today's catalog instead would let a catalog edit change how a
    two-year-old report renders, and a re-verification would then fail on a document that
    was correct when it was delivered.

    A caller passing a mapping gets Req 18.11's refusal path: a metric the mapping does not
    name resolves to no scale at all, and the run fails with the AST path named rather than
    publishing a figure at a guessed precision.
    """

    def scope_for(self, block: BlockSpec) -> ScopeRules:
        """A block's own scope: its override, or the template default (Req 3.2)."""
        return block.scope_override if block.scope_override is not None else self.default_scope

    def cursor(self, block: BlockSpec) -> BlockCursor:
        """A fresh block-root cursor, rooted at this block's own id.

        A nested block inside a `row` gets one of these too, rooted at **its** id rather
        than the row's — a figure path starts with the block that emitted it.
        """
        return BlockCursor(
            block_id=block.id,
            ledger=self.ledger,
            number_format=self.design.number_format,
        )

    def catalog_scale(self, value: SnapshotValue) -> int | None:
        """The scale to format `value` at, or `None` when the catalog declares none.

        `None` is Req 18.11's refusal and reaches `format_figure` as such — see
        :attr:`catalog_scales` and `BlockCursor.figure`'s three cases.

        **A value that is not a catalog metric is never looked up**, and that is not an
        exemption from the rule. A derived cardinality, a declared SKU capacity and a
        run-to-run difference are quantities the Metric_Catalog does not describe and has no
        business declaring a precision for: a count has no fractional part, a capacity is
        Azure's published integer, and a difference inherits its operands' scale. Asking the
        catalog about them and refusing when it stays silent would fail every
        `verification_record` the moment a caller supplied a catalog.
        """
        if self.catalog_scales is None:
            return value.scale
        if value.estimator in NON_CATALOG_ESTIMATORS:
            return value.scale
        return self.catalog_scales.get(value.metric)


# --- config readers ------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class MetricRef:
    """A `(metric | derived, statistic)` reference, as a block config carries one.

    Exactly one of `metric` or `derived` — the same shape the definition's metric selection
    uses and the shape `starters.ts`'s `ref()` writes, so a block can only reference
    something the run was asked to collect.
    """

    name: str
    statistic: str
    derived: bool = False

    @property
    def key(self) -> str:
        """A stable column and series key: `metric:statistic`.

        Stable across every chart in the report and across the delta table, which is what
        lets a series keep its colour between two views of the same data — colour assigned
        by array index would shift when a series is added.
        """
        return f"{self.name}:{self.statistic}"

    @property
    def label(self) -> str:
        return f"{self.name} ({self.statistic})"


@dataclass(frozen=True, slots=True)
class CapacityRef:
    """A `{"sku_capability": name}` reference from a `capacity_vs_usage` config."""

    capability: str
    field_name: str

    @property
    def metric(self) -> str:
        return f"{SKU_METRIC_PREFIX}{self.field_name}"

    @property
    def key(self) -> str:
        return f"sku:{self.capability}"

    @property
    def label(self) -> str:
        return self.capability


def read_metric_ref(raw: object, block: BlockSpec, at: str) -> MetricRef:
    """One metric reference, or a `COMPILE_FAILED` naming the block and the config path."""
    if not isinstance(raw, Mapping):
        raise block.fail(
            f"{at} must be an object naming a metric or a derived statistic and a "
            f"statistic, got {type(raw).__name__}"
        )

    statistic = raw.get("statistic")
    if not isinstance(statistic, str) or not statistic:
        raise block.fail(f"{at} names no statistic")

    metric = raw.get("metric")
    derived = raw.get("derived")
    if isinstance(metric, str) and metric:
        return MetricRef(name=metric, statistic=statistic, derived=False)
    if isinstance(derived, str) and derived:
        return MetricRef(name=derived, statistic=statistic, derived=True)
    raise block.fail(f"{at} names neither a metric nor a derived statistic")


def read_metric_refs(block: BlockSpec, field_name: str) -> tuple[MetricRef, ...]:
    """A config field holding a list of metric references.

    An **empty** list is refused: a KPI row or a chart with no metric has nothing to show,
    and emitting an empty table would look like an empty scope, which means something
    entirely different to a reader.
    """
    raw = block.config.get(field_name)
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        raise block.fail(f"config.{field_name} must be an array of metric references")
    refs = tuple(
        read_metric_ref(entry, block, f"config.{field_name}[{index}]")
        for index, entry in enumerate(raw)
    )
    if not refs:
        raise block.fail(
            f"config.{field_name} is empty; a block with no metric has nothing to show, "
            f"and an empty table reads as an empty scope"
        )
    return refs


def read_capacity_ref(block: BlockSpec, field_name: str) -> CapacityRef:
    """A `{"sku_capability": name}` reference, resolved to the snapshot's field name."""
    raw = block.config.get(field_name)
    if not isinstance(raw, Mapping):
        raise block.fail(
            f"config.{field_name} must be an object naming a SKU capability"
        )
    capability = raw.get("sku_capability")
    if not isinstance(capability, str) or not capability:
        raise block.fail(f"config.{field_name} names no `sku_capability`")

    for declared, snapshot_field in SKU_CAPABILITY_FIELDS:
        if declared.casefold() == capability.casefold():
            return CapacityRef(capability=declared, field_name=snapshot_field)

    raise block.fail(
        f"config.{field_name} names the SKU capability {capability!r}, which the snapshot "
        f"does not record; declared capabilities are "
        f"{[declared for declared, _ in SKU_CAPABILITY_FIELDS]}"
    )


def caption_of(block: BlockSpec) -> str | None:
    """A block's caption, or `None`. Never an empty string, so a renderer cannot emit an
    empty caption paragraph."""
    caption = block.config.get("caption")
    return caption if isinstance(caption, str) and caption else None


def shows_fidelity(block: BlockSpec) -> bool:
    """Whether the block asked for a fidelity-tier column (Req 31.2, design-system).

    A resource whose percentiles are estimated says so wherever a percentile is shown, and
    the tier column is how a table says it once per row rather than once per cell.
    """
    return bool(block.config.get("show_fidelity"))


# --- shared node builders ------------------------------------------------------------


def resolve_stat(
    view: SnapshotView, resource: ResourceView, ref: MetricRef
) -> SnapshotValue | None:
    """The snapshot value for one `(resource, metric, statistic)`, or `None`.

    `None` is an ordinary outcome — a metric the resource does not emit, a direction with no
    samples, a deallocated VM — and the caller emits an `EmptyCell` for it rather than a
    zero. The gap is already recorded in `collection_log`.
    """
    return view.stat(resource.resource_id, ref.name, ref.statistic)


def resolve_capacity(
    view: SnapshotView, resource: ResourceView, ref: CapacityRef
) -> SnapshotValue | None:
    """The snapshot value for one resource's SKU capacity, or `None` when it could not be
    resolved. The snapshot omits an unresolved capability rather than storing a zero, and
    this preserves that: no capacity figure is emitted, which is a different document from
    one emitting `0`."""
    return view.stat(resource.resource_id, ref.metric, SKU_CAPACITY_STATISTIC)


def text_paragraph(cursor: BlockCursor, style: str, text: str) -> Paragraph:
    """A paragraph of literal prose at `cursor`'s path, carrying no figure."""
    return Paragraph(
        path=cursor.path,
        style=style,
        inlines=(Text(path=cursor.child("inlines", 0).path, text=text),),
    )


def text_cell(cursor: BlockCursor, text: str) -> TextCell:
    return TextCell(path=cursor.path, text=text)


def empty_scope_table(cursor: BlockCursor, style: str, caption: str | None) -> Table:
    """The one explicit row a block emits when its scope matched nothing (Req 3.7, 16.10).

    A **data** table with one column and one row, styled `Notice`, carrying **zero
    figures**. It reports no error code and records no gap, because an empty result is not
    a failure: a report can legitimately ask for "Storage Accounts tagged `env=prod`" in a
    subscription that has none.

    It is a table rather than a paragraph so the block keeps the same document shape it
    would have had — a reader scanning for the section finds it where it belongs, with its
    caption, saying plainly that nothing matched. A block that collapsed to nothing is
    indistinguishable from one that was never configured.
    """
    row_cursor = cursor.child("rows", 0)
    return Table(
        path=cursor.path,
        style=style,
        columns=(Column(key="notice", header=NOTICE_COLUMN_HEADER),),
        rows=(
            Row(
                path=row_cursor.path,
                key="empty-scope",
                cells=(text_cell(row_cursor.child("cells", 0), EMPTY_SCOPE_TEXT),),
            ),
        ),
        caption=caption,
    )


def omitted_row(
    cursor: BlockCursor, view: SnapshotView, shown: int, matched: int
) -> Row | None:
    """The final row of a truncated table, stating its own truncation (Req 16.2).

    `None` when nothing was omitted.

    ## The label carries no numeral, and that is not fussiness

    The obvious sentence — "17 of the resources this block matched are not listed" — puts a
    **computed** number in a text node. The verifier extracts every numeric token from the
    rendered document and requires each to match either a ledger `formatted` value or an
    allowlist derived from the snapshot. `matched - shown` is arithmetic over a *block's
    resolved scope*, which appears nowhere in the snapshot, so it can be neither a figure nor
    allowlisted — and the report would be withheld for a sentence the compiler wrote.

    That is the line this whole package draws, and it is worth naming: text may carry
    **identifiers and dates the snapshot or the run record already contains** — a snapshot id,
    a window, a grain, a resource name — because those are derivable and therefore
    allowlistable. It may not carry a **quantity the compiler computed**, because nothing can
    vouch for one.

    So the row says plainly that the table is capped, and the one number it carries is the
    snapshot's own resource cardinality as a **figure**. A reader sees a capped table beside
    the size of the fleet, which is the fact the truncation is about.
    """
    if matched <= shown:
        return None

    total = view.cardinality("resources")
    if total is None:  # pragma: no cover - the walk always indexes it
        return None

    figure_cursor = cursor.child("cells", 1).child("figure", 0)
    figure = figure_cursor.figure(total)
    return Row(
        path=cursor.path,
        key="omitted",
        cells=(
            text_cell(cursor.child("cells", 0), OMITTED_ROW_LABEL),
            FigureCell(path=cursor.child("cells", 1).path, figure=figure),
        ),
    )


def empty_cell(cursor: BlockCursor) -> EmptyCell:
    """A cell the snapshot holds no value for.

    Distinct from a cell carrying `"0"`, and the distinction is the product: a metric a
    resource does not emit is a recorded gap, and a zero would read as measured idleness.
    """
    return EmptyCell(path=cursor.path)
