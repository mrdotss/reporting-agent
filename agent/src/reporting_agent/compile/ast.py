"""The typed document AST: `Figure` is the only numeric leaf there is.

Every emitter — `render/docx.py`, `render/html.py`, `render/charts.py` — walks this one
tree, and the figure ledger's values **are** the `Figure` objects in it. So the rule
this module exists to enforce is not "please do not put a bare number in a document";
it is that **there is no representable way to do so** (Req 15.1, 15.2, 15.3).

## What "structural" buys, precisely

A `Figure` carries `value`, `snapshot_path` and `formatted` together, and its
`__post_init__` **re-resolves `snapshot_path` against the snapshot being compiled** and
asserts the addressed value's decimal string equals `value` (Req 15.11). A declared
provenance that does not resolve is therefore a failure at construction, not an
unchecked claim discovered — or not — at verification time. Three failures are
distinguished because they are three different bugs: a pointer that addresses nothing,
a pointer that addresses two values, and a pointer that addresses a value whose decimal
string differs.

The consequence for the product invariant: a number a language model wrote cannot
become a `Figure`, because there is no snapshot position it resolves to. It cannot
become a `Text` in a figure position either, because a figure position admits only a
`Figure` and `__post_init__` raises naming the node path and the offending type
(Req 15.4). Prose from the model enters as `Text` in a **prose** position, which is
exactly where the verifier's soundness pass looks for unmatched numeric tokens.

## No cardinality is a number (Req 15.6)

`LayoutRow` carries `columns: tuple[LayoutColumn, ...]` with a validator requiring two
or three — **not** `columns: int`. `Table` carries its header and row tuples, not
counts. A heading's level is a **style name** (`"Heading 1"`), not an `int`.
`PageBreak` carries no quantity at all.

That is not tidiness. It is what makes the static guard in `tests/test_ast_guard.py`
decidable: because no cardinality is a number, **`Figure` is the only dataclass in this
module whose annotations mention a numeric type at all**, so the guard can assert
exactly that — no allowlist of "counts that are fine", no judgement call, and no way to
add a numeric field to a non-`Figure` node without the suite going red. A single
`rows: int` anywhere would turn that crisp rule into a list of exceptions, and a list of
exceptions is where the next bare number hides.

`DecimalString` is a `NewType` over `str` rather than a bare `str` for the same reason:
the guard tells a quantity from prose **by the annotation alone**, with no need to
understand what the field means.

## `FigurePath` — the ledger key, derived from position

`<block_id>:<ordinal>[.<ordinal>]*`, where each ordinal is the zero-based index within
its parent's **declared child order**: the concatenation, in dataclass
field-declaration order, of every child-bearing field (:func:`child_nodes`). One
definition, read by two places — `compile/figures.py`'s `BlockCursor` mints paths while
building, and its assertion-only walk of the *finished* tree recomputes them and
requires the two to agree. A cursor that minted a wrong ordinal is therefore a test
failure rather than a ledger whose keys quietly disagree with the tree.

`table_id(path)` and `chart_id(path)` derive the `w:tblCaption` and chart anchor ids
`render/anchors.py` depends on, both asserted at most 255 characters.

## Immutability, and one deliberate piece of machinery

Every node is `frozen=True, slots=True`. `Figure` additionally raises
:class:`FigureImmutableError` — a `FrozenInstanceError` subclass — on assignment and
deletion, because a mutated figure is the one corruption the verifier cannot catch: it
compares document tokens against the ledger's `formatted` values, and the ledger holds
*the same objects*, so a figure edited after construction would agree with itself.
`dataclasses` refuses a `__setattr__` defined in the body of a frozen class, so the
override is installed on the class immediately after its definition; frozen `__init__`
writes through `object.__setattr__` and is unaffected.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Final, NewType

from reporting_agent.compile.snapshot_view import (
    DECIMAL_STRING_PATTERN,
    SnapshotResolver,
)
from reporting_agent.errors import CompileFailedError

__all__ = [
    "ANCHOR_ID_MAX_LENGTH",
    "CELL_TYPES",
    "CHART_ENCODINGS",
    "CHART_ID_PREFIX",
    "CHART_TYPES",
    "FIGURE_ADMITTING_ANNOTATIONS",
    "FIGURE_PATH_PATTERN",
    "MAX_LAYOUT_COLUMNS",
    "MIN_LAYOUT_COLUMNS",
    "NUMERIC_ANNOTATION_NAMES",
    "PRIOR_RUNS_POINTER_PREFIX",
    "REQUIRED_NODE_NAMES",
    "TABLE_ID_PREFIX",
    "TEXT_FACT_ADMITTING_ANNOTATIONS",
    "AstInvariantError",
    "Block",
    "Cell",
    "Chart",
    "ChartPoint",
    "Column",
    "DecimalString",
    "Document",
    "EmptyCell",
    "Figure",
    "FigureCell",
    "FigureImmutableError",
    "FigurePath",
    "FigureSource",
    "Inline",
    "LayoutColumn",
    "LayoutRow",
    "Node",
    "PageBreak",
    "Paragraph",
    "Row",
    "Series",
    "Table",
    "Text",
    "TextCell",
    "TextFact",
    "TextFactCell",
    "assert_numeric_leaf_invariant",
    "chart_id",
    "child_nodes",
    "collect_invariant_violations",
    "compiling_against",
    "decimal_string_of",
    "figure_path",
    "table_id",
]


# --- the two string kinds this module distinguishes ---------------------------------

DecimalString = NewType("DecimalString", str)
"""A fixed-precision decimal string: an optional leading `-`, digits, and at most one
`.` followed by digits.

Admits no exponent, no leading `+`, no thousands separator, no surrounding whitespace,
no empty string and no non-finite designation — :data:`DECIMAL_STRING_PATTERN`, the same
grammar `compile/snapshot_view.py` holds the snapshot to, so a figure's `value` is
byte-comparable with the string the snapshot stores.

A `NewType` and not a bare `str` because `tests/test_ast_guard.py` decides "is this
field a quantity?" **from the annotation alone**. A quantity spelled `str` would be
indistinguishable from prose, and the guard would need to know what every field means."""

FigurePath = NewType("FigurePath", str)
"""A node's position in the tree: `<block_id>:<ordinal>[.<ordinal>]*`.

Also the figure ledger's key, which is why it has to be derived from position rather
than chosen: two figures at one key would make the ledger's provenance ambiguous.

**There is always at least one ordinal**, because the block is the notional parent and
the nodes it emits are its children. A `resource_table` block that emits a caption
paragraph and then a table produces `resources:0` and `resources:1`; a figure in that
table's second row, first cell, is `resources:1.1.0`. So `<block_id>` alone is the name
of a *block*, never of a node — which is what keeps a block's identity and a node's
position from being the same string."""

FIGURE_PATH_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\A.{1,64}:(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*\Z", re.DOTALL
)
"""The `FigurePath` grammar.

The block-id group is greedy, so a path whose block id itself contains a `:` still
parses — the separator is effectively the **last** colon before the ordinals. That is
deliberate rather than clever: the definition schema bounds a block id at 1-64
characters and does not forbid punctuation, so a validator here that rejected `:` would
refuse a definition the web half accepts, which is exactly the save-then-fail
divergence the Mirror_Guard exists to prevent. Nothing downstream recovers the block id
from a path — the ledger keys by the whole string — so the ambiguity costs nothing."""

TABLE_ID_PREFIX: Final[str] = "tbl:"
CHART_ID_PREFIX: Final[str] = "cht:"
ANCHOR_ID_MAX_LENGTH: Final[int] = 255

MIN_LAYOUT_COLUMNS: Final[int] = 2
MAX_LAYOUT_COLUMNS: Final[int] = 3

PRIOR_RUNS_POINTER_PREFIX: Final[str] = "/prior_runs"
"""Where a historical-trend figure's `snapshot_path` addresses another run (Req 18.9).

Declared as a constant because two things compare against it — `Figure.__post_init__` and the
resolver that indexes a prior run's values — and a prefix spelled twice is a prefix that
eventually differs in one of the two places."""

CHART_TYPES: Final[tuple[str, ...]] = ("bar", "hbar", "line", "area", "heatmap")
CHART_ENCODINGS: Final[tuple[str, ...]] = ("categorical", "sequential")
"""Req 16.14 — the compiler decides the encoding from whether the series are peers or
one ordered quantity, and the client must not infer it from the series count. A closed
set, so a chart cannot travel without one."""


class FigureImmutableError(dataclasses.FrozenInstanceError):
    """A constructed :class:`Figure` was assigned to, or had a field deleted.

    A `FrozenInstanceError` subclass, so a caller catching the standard frozen-dataclass
    error still catches this, and a caller who wants to say "specifically a figure" can.

    Why a figure gets its own error at all: the ledger's values **are** the figure
    objects in the tree, so an edit after construction is invisible to the verifier —
    it would compare the document against a ledger carrying the same edited value and
    find them in perfect agreement. Every other corruption this system can suffer is
    detectable; this one is not, so it is prevented rather than checked for.
    """


# --- the snapshot a compile is running against --------------------------------------

_ACTIVE_SNAPSHOT: ContextVar[SnapshotResolver | None] = ContextVar(
    "reporting_agent.compile.ast.active_snapshot", default=None
)


@contextmanager
def compiling_against(resolver: SnapshotResolver) -> Iterator[None]:
    """Bind the snapshot every :class:`Figure` constructed inside this block
    re-resolves against.

    A `ContextVar` rather than a constructor argument, because `Figure` is a frozen
    dataclass and a `resolver` field would ride along into the ledger, into the
    serialized artifact and into every equality comparison — a compile-time dependency
    baked into a document that is supposed to outlive the process.

    The consequence is stronger than it looks: **a `Figure` cannot be constructed
    outside a compile context at all**. There is no ambient default and no "skip the
    check if no snapshot is bound", because an unchecked provenance is precisely the
    claim this class exists to refuse. A test that wants a figure enters this context
    with a snapshot — real or a deliberately broken :class:`SnapshotResolver` — which is
    how the three re-resolution failures get exercised.
    """
    token = _ACTIVE_SNAPSHOT.set(resolver)
    try:
        yield
    finally:
        _ACTIVE_SNAPSHOT.reset(token)


# --- paths and anchors --------------------------------------------------------------


def figure_path(block_id: str, *ordinals: int) -> FigurePath:
    """`<block_id>:<ordinal>[.<ordinal>]*`, validated.

    Raises `COMPILE_FAILED` for a block id outside 1-64 characters, for no ordinals at
    all, or for a negative ordinal — each of which would produce a ledger key that
    cannot be parsed back into a position.
    """
    if not isinstance(block_id, str) or not 1 <= len(block_id) <= 64:
        raise CompileFailedError(
            f"a figure path's block id must be 1 to 64 characters, got {block_id!r}"
        )
    if not ordinals:
        raise CompileFailedError(
            f"a figure path needs at least one ordinal; {block_id!r} names a block, not "
            f"a position inside it"
        )
    for ordinal in ordinals:
        if isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal < 0:
            raise CompileFailedError(
                f"a figure path ordinal must be a non-negative integer, got {ordinal!r}"
            )

    candidate = f"{block_id}:{'.'.join(str(ordinal) for ordinal in ordinals)}"
    if not FIGURE_PATH_PATTERN.match(candidate):
        raise CompileFailedError(f"{candidate!r} is not a valid figure path")
    return FigurePath(candidate)


def _anchor(prefix: str, path: str, kind: str) -> str:
    anchor = f"{prefix}{path}"
    if len(anchor) > ANCHOR_ID_MAX_LENGTH:
        raise CompileFailedError(
            f"the {kind} anchor id for {path!r} is {len(anchor)} characters, above the "
            f"{ANCHOR_ID_MAX_LENGTH}-character bound the document format allows"
        )
    return anchor


def table_id(path: FigurePath | str) -> str:
    """The `w:tblCaption` id for a **data** table (Req 15.9).

    `render/anchors.py` puts this on every data table and on no layout table, which is
    what lets the verifier's table pass exclude a `row` block's borderless layout table
    **by construction** rather than by guessing from borders or cell count.
    """
    return _anchor(TABLE_ID_PREFIX, str(path), "table")


def chart_id(path: FigurePath | str) -> str:
    """The anchor id for a chart, on the same terms as :func:`table_id`."""
    return _anchor(CHART_ID_PREFIX, str(path), "chart")


def decimal_string_of(value: object, *, at: str) -> DecimalString:
    """`value` as a :data:`DecimalString`, or `COMPILE_FAILED` naming `at`.

    The one narrowing gate into the `NewType`. A `Decimal` is refused rather than
    stringified: rendering it here would apply `Decimal.__str__`, which emits scientific
    notation for a far-from-zero exponent, and a figure carrying `1E+3` where the
    snapshot stored `1000` would fail its own re-resolution check for a reason that
    looks like a data problem and is a formatting one.
    """
    if isinstance(value, bool) or not isinstance(value, str):
        raise CompileFailedError(
            f"{at} must be a fixed-precision decimal string, got "
            f"{type(value).__name__}: a figure's `value` is compared byte for byte "
            f"against the snapshot's own stored string"
        )
    if not DECIMAL_STRING_PATTERN.match(value):
        raise CompileFailedError(
            f"{at} is not a fixed-precision decimal string: expected an optional "
            f"leading '-', digits and at most one '.' followed by digits, carrying no "
            f"exponent and no separator"
        )
    return DecimalString(value)


# --- descriptors (not nodes: no position, no children) ------------------------------


@dataclass(frozen=True, slots=True)
class FigureSource:
    """One entry of a figure's `derived_from` (Req 30.9).

    A derived number without its derivation is an assertion rather than a measurement,
    so this travels with the figure into the document and into the ledger.
    """

    kind: str
    name: str
    statistic: str | None = None
    unit: str | None = None


@dataclass(frozen=True, slots=True)
class Column:
    """One data-table column: its stable key and the header text shown for it.

    A **descriptor**, not a node — it holds no position and no children, because a
    column is a property of the table rather than a place in the document. `key` is what
    lets the verifier's table pass name the cell it could not resolve as
    `(row_key, column_key)` rather than as a coordinate pair nobody can look up.
    """

    key: str
    header: str


# --- the one numeric leaf -----------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Figure:
    """One number in the document, with everything needed to prove it (Req 15.2, 15.3).

    The **only** node in this module declaring a field that carries a quantity, and the
    only dataclass here whose annotations mention a numeric type at all.

    `value` is the snapshot's own decimal string, byte for byte — provenance.
    `formatted` is the display string `compile/format.py` produced and the renderer is
    required to emit — presentation. They are different strings on purpose: `value`
    carries the collector's scale, `formatted` the display scale, and the verifier
    matches document tokens against `formatted` while re-resolution matches `value`.

    `estimator_label` is the pre-formatted, numeral-free label
    `compile/estimators.py` composed (`p95, est. from hourly averages`). The renderer
    consumes it verbatim and composes nothing of its own, which is what makes the
    document structurally incapable of saying "p95 CPU" unqualified (Req 18.10).
    """

    path: FigurePath
    value: DecimalString
    unit: str
    snapshot_path: str
    formatted: str
    fidelity_tier: str | None
    """The tier of the resource this figure measures, or `None` where no resource is
    measured.

    `None` is not a gap in the data — it is the honest answer for a figure that is not a
    resource's measurement at all. A **derived cardinality** (how many resources were in
    scope, how many gaps were recorded) counts the snapshot's own records; asking which
    fidelity tier a count belongs to is a category error, and `""` would be a second spelling
    of "absent" that a renderer would have to special-case anyway.

    Required rather than defaulted, so a caller minting a figure has to decide. A resource
    measurement that reached here with `None` would be a collector that failed to record the
    tier, which is a fact worth surfacing rather than defaulting to `baseline`."""
    statistic: str
    metric: str | None = None
    resource_id: str | None = None
    window: str | None = None
    estimator: str | None = None
    estimator_label: str | None = None
    derived_from: tuple[FigureSource, ...] = field(default_factory=tuple)
    formula: str | None = None
    source_run_id: str | None = None
    """The **prior** run this figure was read from, for a historical-trend series (Req 18.9).

    `None` for every figure compiled from this run's own snapshot, which is all of them today.
    A figure whose `snapshot_path` points under `/prior_runs/<id>` carries the matching run id,
    and `__post_init__` asserts the two agree — so a figure cannot claim a position in another
    run's snapshot while presenting as this run's own.

    `str | None`, so the numeric-annotation scan is unaffected: a run id is an identifier and
    not a quantity, and this class is already the one dataclass permitted to mention a number
    anyway. Declaring it as a string keeps that permission from being needed for a field that
    does not want it."""
    source_snapshot_sha256: str | None = None
    """The digest of the snapshot `source_run_id` names (Req 18.9).

    Required whenever `source_run_id` is present, and that pairing is the point: a delta between
    two runs only means something if both snapshots are pinned, so a figure naming a prior run
    without naming *which* snapshot of it would be a comparison against a moving target."""

    def __post_init__(self) -> None:
        at = f"figure {self.path!r}"
        _require_text(self.path, "path", at)
        if not FIGURE_PATH_PATTERN.match(str(self.path)):
            raise CompileFailedError(f"{at}: {self.path!r} is not a valid figure path")

        decimal_string_of(self.value, at=f"{at} field 'value'")
        _require_text(self.unit, "unit", at)
        _require_text(self.snapshot_path, "snapshot_path", at)
        _require_text(self.formatted, "formatted", at)
        _require_text(self.statistic, "statistic", at)

        for name in (
            "fidelity_tier",
            "metric",
            "resource_id",
            "window",
            "estimator",
            "estimator_label",
            "formula",
        ):
            candidate = getattr(self, name)
            if candidate is not None and (not isinstance(candidate, str) or not candidate):
                raise CompileFailedError(
                    f"{at}: field {name!r} must be None or a non-empty string, got "
                    f"{type(candidate).__name__}"
                )

        if not isinstance(self.derived_from, tuple) or not all(
            isinstance(source, FigureSource) for source in self.derived_from
        ):
            raise CompileFailedError(
                f"{at}: `derived_from` must be a tuple of FigureSource"
            )

        self._assert_prior_run_provenance(at)
        self._assert_provenance_resolves(at)

    def _assert_prior_run_provenance(self, at: str) -> None:
        """The two `source_*` fields agree with the `snapshot_path` (Req 18.9).

        Both directions, because each is a different wrong document:

        * a `snapshot_path` under `/prior_runs/<id>` **must** name the run it came from,
          or the figure presents another run's value as this run's own;
        * a `source_run_id` **must** be accompanied by a `source_snapshot_sha256`, because
          a delta between two runs only means something if both snapshots are pinned — a
          figure naming a prior run without naming which snapshot of it is a comparison
          against a moving target.

        The id is matched against the path rather than merely required to be present, so a
        figure cannot carry run A's id beside run B's position.
        """
        prefix = f"{PRIOR_RUNS_POINTER_PREFIX}/"
        if self.snapshot_path.startswith(prefix):
            declared = self.snapshot_path[len(prefix) :].split("/", 1)[0]
            if not self.source_run_id:
                raise CompileFailedError(
                    f"{at}: `snapshot_path` {self.snapshot_path!r} addresses the prior run "
                    f"{declared!r} and the figure names no `source_run_id`; a value read "
                    f"from another run must say which one"
                )
            if self.source_run_id != declared:
                raise CompileFailedError(
                    f"{at}: `source_run_id` is {self.source_run_id!r} and `snapshot_path` "
                    f"{self.snapshot_path!r} addresses run {declared!r}"
                )
        if self.source_run_id and not self.source_snapshot_sha256:
            raise CompileFailedError(
                f"{at}: `source_run_id` {self.source_run_id!r} carries no "
                f"`source_snapshot_sha256`. A delta between two runs means something only "
                f"if both snapshots are pinned"
            )

    def _assert_provenance_resolves(self, at: str) -> None:
        """Re-resolve `snapshot_path` and require it to address exactly this value
        (Req 15.11).

        Three distinct failures, kept apart because they are three different bugs:

        * **nothing** — the declared position does not exist in the snapshot, so the
          provenance is fiction;
        * **two values** — the position is ambiguous, so the ledger could not say which
          value a `snapshot_path` meant;
        * **a different decimal string** — the position exists and holds something
          else, which is the transcription error that would otherwise reach a document
          looking entirely plausible.
        """
        resolver = _ACTIVE_SNAPSHOT.get()
        if resolver is None:
            raise CompileFailedError(
                f"{at}: a Figure may only be constructed while compiling against a "
                f"snapshot (see `compiling_against`). Its `snapshot_path` is re-resolved "
                f"at construction, and a provenance nobody checked is the claim this "
                f"class exists to refuse."
            )

        addressed = resolver.resolve_all(self.snapshot_path)
        if not addressed:
            raise CompileFailedError(
                f"{at}: `snapshot_path` {self.snapshot_path!r} addresses no value in "
                f"the snapshot being compiled"
            )
        if len(addressed) > 1:
            raise CompileFailedError(
                f"{at}: `snapshot_path` {self.snapshot_path!r} addresses "
                f"{len(addressed)} values; a figure's provenance must be unambiguous"
            )

        stored = f"{addressed[0].value:f}"
        if stored != str(self.value):
            raise CompileFailedError(
                f"{at}: `value` is {str(self.value)!r} but `snapshot_path` "
                f"{self.snapshot_path!r} addresses {stored!r}"
            )

    @property
    def is_estimate(self) -> bool:
        """Whether this figure carries an estimator label, which is the document-visible
        marker that its statistic was estimated rather than measured exactly."""
        return self.estimator_label is not None


def _figure_setattr(self: Figure, name: str, value: object) -> None:
    raise FigureImmutableError(
        f"figure {self.path!r} is immutable; cannot set {name!r}. The figure ledger "
        f"holds this same object, so an edit here would agree with the ledger and the "
        f"verifier would find the document and the ledger in perfect agreement about a "
        f"number that came from nowhere."
    )


def _figure_delattr(self: Figure, name: str) -> None:
    raise FigureImmutableError(
        f"figure {self.path!r} is immutable; cannot delete {name!r}"
    )


# `dataclasses` refuses a `__setattr__` defined in the body of a frozen class, so the
# override is installed here. Frozen `__init__` writes through `object.__setattr__`, so
# construction is unaffected.
Figure.__setattr__ = _figure_setattr  # type: ignore[method-assign, assignment]
Figure.__delattr__ = _figure_delattr  # type: ignore[method-assign, assignment]


# --- inline content -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Text:
    """Literal prose. Carries no quantity, by type.

    Model-authored prose enters here **unaltered** (Req 16.12), which is exactly why the
    verifier's soundness pass extracts numeric tokens from prose positions: a number the
    model wrote lands in a `Text`, and an unmatched numeric token is a hard failure.
    """

    path: FigurePath
    text: str


type Inline = Text | Figure
"""Inline content: prose, or a figure. A union over exactly these two members —
`tests/test_ast_guard.py` asserts that, because a third member admitting a quantity
would be a second numeric leaf and the whole guarantee is that there is one."""


# --- table cells --------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FigureCell:
    """A data-table cell holding a figure, and nothing else.

    `__post_init__` raises naming this cell's path and the offending type for anything
    that is not a `Figure` (Req 15.4) — a `Decimal`, an `int`, a bare `str`, a `float`.
    The annotation says the same thing statically; this is what says it at runtime, for
    the code paths a type checker does not see.
    """

    path: FigurePath
    figure: Figure

    def __post_init__(self) -> None:
        _require_figure(self.figure, at=f"cell {self.path!r} field 'figure'")


@dataclass(frozen=True, slots=True)
class TextCell:
    """A data-table cell holding prose — a resource name, a tier badge, a gap type.

    Deliberately a `str` and not an `Inline`: a cell that could hold either prose or a
    figure would make "which cells does the verifier expect to resolve against the
    ledger?" a runtime question. `FigureCell` and `TextCell` answer it by type.
    """

    path: FigurePath
    text: str


@dataclass(frozen=True, slots=True)
class EmptyCell:
    """A cell with no value — the snapshot holds none for this `(resource, metric)`.

    Distinct from a `TextCell` carrying `"0"`, and that distinction is the point: a
    metric a resource does not emit is a recorded gap, and a zero would read as measured
    idleness.
    """

    path: FigurePath


@dataclass(frozen=True, slots=True)
class TextFact:
    """One collected **text** fact in the document, with everything needed to prove it
    (Req 6.2, 6.3, 17.1).

    The text-side counterpart of :class:`Figure`, and it declares **no field admitting a
    quantity** — no `int`, no `float`, no `Decimal`, no `DecimalString`. That is not an
    oversight to be corrected later: `tests/test_ast_guard.py`'s numeric-annotation scan
    still names `Figure` as the only dataclass here permitted to mention one, and
    `TextFact` is deliberately **not** exempted from it. A future edit adding a
    `count: int` to this class fails the guard, which is the point of adding it under the
    same rule rather than beside it.

    ## Why a text fact needs its own node at all

    A `TextCell` would have carried the characters perfectly well. What it could not carry
    is the **provenance**, and that is what makes the difference visible to the verifier:
    a `TextCell` is prose, so the soundness pass extracts numeric tokens from it and
    checks nothing else. `Succeeded` becoming `Failed` in a `TextCell` is invisible —
    the token carries no digit, so it is never extracted, and the document would ship a
    backup status that came from nowhere.

    Routing text facts through the numeric masking path is the other available mistake and
    is worse, because it *reports a clean pass*: the mutated token gets masked as though it
    were a `formatted` value and the verifier agrees with itself. So a text fact is a
    ledger entry of its own kind, re-resolved against the snapshot's text side.

    `formatted` must equal `value` character for character, the same rule
    `collect/snapshot.py`'s `FactEntry` enforces one layer down and for the same reason: a
    fact carries no unit suffix and no grouping, so a second spelling would be a second
    display path the verifier would have to choose between.
    """

    path: FigurePath
    key: str
    value: str
    snapshot_path: str
    source: str
    collected_at: str
    formatted: str

    def __post_init__(self) -> None:
        at = f"text fact {self.path!r}"
        if not FIGURE_PATH_PATTERN.match(str(self.path)):
            raise CompileFailedError(
                f"{at}: path does not match {FIGURE_PATH_PATTERN.pattern}"
            )
        for name in ("key", "value", "snapshot_path", "source", "collected_at", "formatted"):
            _require_text(getattr(self, name), name, at)
        if self.formatted != self.value:
            raise CompileFailedError(
                f"{at}: `formatted` {self.formatted!r} differs from `value` "
                f"{self.value!r}. A fact carries no unit suffix and no grouping, so the "
                f"two are one string; a second spelling here would be a second display "
                f"path the verifier would have to choose between"
            )

        self._assert_provenance_resolves(at)

    def _assert_provenance_resolves(self, at: str) -> None:
        """Re-resolve `snapshot_path` against the snapshot's **text** side and require it
        to address exactly this value (Req 17.1).

        The same three failures :meth:`Figure._assert_provenance_resolves` distinguishes,
        because they are the same three bugs: **nothing** means the provenance is fiction,
        **two values** means the ledger could not say which one a `snapshot_path` meant,
        and **a different string** is the transcription error that would otherwise reach a
        document looking entirely plausible.

        Resolved through `resolve_text_all` and not `resolve_all`, which is what makes a
        text fact structurally unable to claim a statistic's provenance: a `snapshot_path`
        naming a statistic addresses nothing on the text side.
        """
        resolver = _ACTIVE_SNAPSHOT.get()
        if resolver is None:
            raise CompileFailedError(
                f"{at}: a TextFact may only be constructed while compiling against a "
                f"snapshot (see `compiling_against`). Its `snapshot_path` is re-resolved "
                f"at construction, and a provenance nobody checked is the claim this "
                f"class exists to refuse."
            )

        addressed = resolver.resolve_text_all(self.snapshot_path)
        if not addressed:
            raise CompileFailedError(
                f"{at}: `snapshot_path` {self.snapshot_path!r} addresses no text value in "
                f"the snapshot being compiled"
            )
        if len(addressed) > 1:
            raise CompileFailedError(
                f"{at}: `snapshot_path` {self.snapshot_path!r} addresses "
                f"{len(addressed)} values; a fact's provenance must be unambiguous"
            )
        if addressed[0] != self.value:
            raise CompileFailedError(
                f"{at}: `value` is {self.value!r} but `snapshot_path` "
                f"{self.snapshot_path!r} addresses {addressed[0]!r}"
            )


def _text_fact_setattr(self: TextFact, name: str, value: object) -> None:
    raise FigureImmutableError(
        f"text fact {self.path!r} is immutable; cannot set {name!r}. The ledger holds "
        f"this same object, so an edit here would agree with the ledger and the verifier "
        f"would find the document and the ledger in perfect agreement about a value that "
        f"came from nowhere."
    )


def _text_fact_delattr(self: TextFact, name: str) -> None:
    raise FigureImmutableError(
        f"text fact {self.path!r} is immutable; cannot delete {name!r}"
    )


# Installed after the class body for the reason the module docstring gives about `Figure`:
# `dataclasses` refuses a `__setattr__` defined inside a frozen class body.
TextFact.__setattr__ = _text_fact_setattr  # type: ignore[method-assign, assignment]
TextFact.__delattr__ = _text_fact_delattr  # type: ignore[method-assign, assignment]


@dataclass(frozen=True, slots=True)
class TextFactCell:
    """A data-table cell holding a text fact, and nothing else (Req 6.3).

    Mirrors :class:`FigureCell` exactly, including the runtime refusal: the annotation says
    it statically and `__post_init__` says it on the paths a type checker does not see.

    Its `fact` field is the **only** field in this module annotated `TextFact`, and this
    class is a member of :data:`Cell` and of nothing else. Together those two facts make
    "every `TextFact` position admits the `TextFact` node type alone" a **type
    declaration**, and "only into a data-table cell" a consequence of union membership
    rather than a run-time rule somebody has to remember to check.
    """

    path: FigurePath
    fact: TextFact

    def __post_init__(self) -> None:
        if not isinstance(self.fact, TextFact):
            raise CompileFailedError(
                f"cell {self.path!r} field 'fact' is {type(self.fact).__name__}; a "
                f"TextFactCell admits a TextFact alone, so a bare string cannot reach a "
                f"fact position and skip its provenance check"
            )


type Cell = FigureCell | TextCell | EmptyCell | TextFactCell
"""A data-table cell. A union over exactly these four members; the guard asserts it."""

CELL_TYPES: Final[tuple[type, ...]] = (FigureCell, TextCell, EmptyCell, TextFactCell)
"""The `Cell` union's members as a runtime tuple, for `Row.__post_init__`'s check.

A `type` alias is not usable with `isinstance` at runtime, so the check needs the members
spelled once more — and spelling them *here*, beside the alias, is what keeps the two from
diverging silently. `tests/test_ast_guard.py`'s `_EXPECTED_UNION_MEMBERS` compares this tuple
against the alias's own annotation, so a member added to one and not the other fails there
rather than presenting as a cell type the annotation permits and the constructor refuses."""


# --- block-level nodes --------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Paragraph:
    """One paragraph, in one theme paragraph style, over inline content.

    `style` is a **theme style name** — `"Heading 1"`, `"Body Text"`,
    `"PreviewNotice"` — and never a level number. That is what keeps a heading's level
    out of the annotations as a quantity, and it is also simply how `python-docx`
    applies a style, so the two reasons point the same way.
    """

    path: FigurePath
    style: str
    inlines: tuple[Inline, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        _require_text(self.style, "style", f"paragraph {self.path!r}")
        for ordinal, inline in enumerate(self.inlines):
            if not isinstance(inline, Text | Figure):
                raise CompileFailedError(
                    f"paragraph {self.path!r} inline {ordinal} is "
                    f"{type(inline).__name__}; an inline position admits only Text or "
                    f"Figure, so a bare number cannot appear in prose"
                )


@dataclass(frozen=True, slots=True)
class Row:
    """One data-table row: a stable key and its ordered cells."""

    path: FigurePath
    key: str
    cells: tuple[Cell, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        _require_text(self.key, "key", f"row {self.path!r}")
        for ordinal, cell in enumerate(self.cells):
            # Checked against `CELL_TYPES`, which is derived from the `Cell` union itself, so
            # a member added to that union cannot be admitted by the annotation and refused
            # here. That divergence is not hypothetical: `TextFactCell` joined `Cell` and this
            # check kept refusing it, so the type said one thing and the constructor another.
            if not isinstance(cell, CELL_TYPES):
                raise CompileFailedError(
                    f"row {self.path!r} cell {ordinal} is {type(cell).__name__}; a cell "
                    f"position admits only "
                    + ", ".join(kind.__name__ for kind in CELL_TYPES)
                )


@dataclass(frozen=True, slots=True)
class Table:
    """A **data** table: identity, ordered columns, ordered rows.

    Its identity is :func:`table_id` of its path, derived rather than stored so the
    `w:tblCaption` the renderer writes and the anchor the verifier looks for cannot
    disagree. Every data table carries one; a `row` block's borderless layout table
    carries none, which is what lets the table-verification pass exclude layout tables
    by construction (Req 15.9).

    Column keys are unique among columns and row keys unique among rows: a repeated key
    would make `(row_key, column_key)` address two cells, and the verifier reports an
    unresolved cell by exactly that pair.
    """

    path: FigurePath
    style: str
    columns: tuple[Column, ...] = field(default_factory=tuple)
    rows: tuple[Row, ...] = field(default_factory=tuple)
    caption: str | None = None

    def __post_init__(self) -> None:
        at = f"table {self.path!r}"
        _require_text(self.style, "style", at)
        _require_unique(
            (column.key for column in self.columns), at=at, what="column key"
        )
        _require_unique((row.key for row in self.rows), at=at, what="row key")
        table_id(self.path)  # asserts the anchor id fits the format's bound

    @property
    def anchor_id(self) -> str:
        """The `w:tblCaption` id, derived from the path."""
        return table_id(self.path)


@dataclass(frozen=True, slots=True)
class ChartPoint:
    """One plotted value: its x label and the figure it plots.

    `y` is a `Figure`, so every point in every chart traces to a snapshot position —
    which is what makes an in-app chart a *view of verified figures* rather than a
    second computation.
    """

    path: FigurePath
    x: str
    y: Figure

    def __post_init__(self) -> None:
        _require_figure(self.y, at=f"chart point {self.path!r} field 'y'")


@dataclass(frozen=True, slots=True)
class Series:
    """One chart series: a **stable key**, a label, and ordered points.

    `key` is stable across every chart in the report and across the delta table, so a
    resource keeps its colour between two views of the same data. Colour assigned by
    array index instead would shift when a series is added, which is worse than no
    colour.
    """

    path: FigurePath
    key: str
    label: str
    points: tuple[ChartPoint, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        at = f"series {self.path!r}"
        _require_text(self.key, "key", at)
        _require_text(self.label, "label", at)


@dataclass(frozen=True, slots=True)
class Chart:
    """A chart: type, title, unit, encoding, and ordered series.

    `encoding` is the **compiler's** decision — `categorical` where the series are
    peers, `sequential` where the chart encodes one ordered quantity (Req 16.14) — so no
    consumer infers it from the series count. A lightness ramp over peers would assert
    an order the data does not contain.
    """

    path: FigurePath
    chart_type: str
    title: str
    unit: str
    encoding: str
    x_axis_label_id: str = ""
    y_axis_label_id: str = ""
    period_label: str = ""
    series: tuple[Series, ...] = field(default_factory=tuple)
    caption: str | None = None

    def __post_init__(self) -> None:
        at = f"chart {self.path!r}"
        _require_text(self.title, "title", at)
        _require_text(self.unit, "unit", at)
        if self.chart_type not in CHART_TYPES:
            raise CompileFailedError(
                f"{at}: chart_type {self.chart_type!r} is not one of {list(CHART_TYPES)}"
            )
        if self.encoding not in CHART_ENCODINGS:
            raise CompileFailedError(
                f"{at}: encoding {self.encoding!r} is not one of {list(CHART_ENCODINGS)}"
            )
        _require_unique((series.key for series in self.series), at=at, what="series key")
        chart_id(self.path)

    @property
    def anchor_id(self) -> str:
        return chart_id(self.path)


@dataclass(frozen=True, slots=True)
class PageBreak:
    """A page break. Carries no quantity and no cardinality — only its position."""

    path: FigurePath


@dataclass(frozen=True, slots=True)
class LayoutColumn:
    """One column of a `row` block, holding its compiled children in declared order."""

    path: FigurePath
    blocks: tuple[Block, ...] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class LayoutRow:
    """A `row` block: two or three columns, each holding blocks.

    `columns` is a **tuple of columns**, never a count (Req 15.6). "Two or three
    columns" is therefore this tuple's own length, and no separate field can disagree
    with the children it actually holds — the same reasoning the definition schema
    applies to a row's list-of-lists.

    Emitted as a **borderless layout table** carrying no `w:tblCaption`, which is how
    the verifier's table pass tells a layout table from a data one without inspecting
    borders.
    """

    path: FigurePath
    columns: tuple[LayoutColumn, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if not all(isinstance(column, LayoutColumn) for column in self.columns):
            raise CompileFailedError(
                f"layout row {self.path!r} columns must each be a LayoutColumn"
            )
        if not MIN_LAYOUT_COLUMNS <= len(self.columns) <= MAX_LAYOUT_COLUMNS:
            raise CompileFailedError(
                f"layout row {self.path!r} declares {len(self.columns)} columns; a row "
                f"holds {MIN_LAYOUT_COLUMNS} or {MAX_LAYOUT_COLUMNS}"
            )


type Block = Paragraph | Table | Chart | LayoutRow | PageBreak
"""A block-level node — what a compiled block type becomes."""


@dataclass(frozen=True, slots=True)
class Document:
    """The whole compiled document: blocks in document order.

    List order **is** document order. There is no separate ordering or index field,
    because a second source of order is a second thing that can be wrong.
    """

    blocks: tuple[Block, ...] = field(default_factory=tuple)


type Node = (
    Text
    | Figure
    | Paragraph
    | Row
    | FigureCell
    | TextCell
    | EmptyCell
    | Table
    | ChartPoint
    | Series
    | Chart
    | PageBreak
    | LayoutColumn
    | LayoutRow
    | Document
)
"""Every positioned node. `Column` and `FigureSource` are **descriptors**, not nodes:
they hold no position and no children."""


_NODE_TYPES: Final[tuple[type, ...]] = (
    Text,
    Figure,
    TextFact,
    Paragraph,
    Row,
    FigureCell,
    TextCell,
    EmptyCell,
    TextFactCell,
    Table,
    ChartPoint,
    Series,
    Chart,
    PageBreak,
    LayoutColumn,
    LayoutRow,
    Document,
)


def child_nodes(node: object) -> tuple[object, ...]:
    """A node's children in **declared child order** — the concatenation, in dataclass
    field-declaration order, of every child-bearing field.

    The single definition of the order `FigurePath`'s ordinals index into. Read by two
    places that must agree: `compile/figures.py`'s `BlockCursor` mints ordinals while
    building, and its assertion-only walk of the finished tree recomputes every path
    from this function and requires the two to match. Nothing here is a second
    structure — it reads the dataclass fields the nodes already declare.

    `Figure.derived_from` is a tuple of `FigureSource`, a descriptor rather than a node,
    so it contributes no children — which is what keeps a figure a leaf.
    """
    if not dataclasses.is_dataclass(node) or not isinstance(node, _NODE_TYPES):
        return ()

    found: list[object] = []
    for declared in dataclasses.fields(node):
        value = getattr(node, declared.name)
        if isinstance(value, _NODE_TYPES):
            found.append(value)
        elif isinstance(value, tuple):
            found.extend(item for item in value if isinstance(item, _NODE_TYPES))
    return tuple(found)


# --- shared validators --------------------------------------------------------------


def _require_text(value: object, name: str, at: str) -> None:
    if not isinstance(value, str) or not value:
        raise CompileFailedError(
            f"{at}: field {name!r} must be a non-empty string, got "
            f"{type(value).__name__}"
        )


def _require_figure(value: object, *, at: str) -> None:
    """Req 15.4 — a figure position admits a `Figure` and nothing else.

    Names the offending type explicitly, because the four things that turn up here mean
    four different mistakes: a `Decimal` or a `float` is a raw quantity that skipped the
    formatter, an `int` is usually a cardinality that should not have been a figure at
    all, and a `str` is a pre-formatted string that skipped the ledger — which is
    precisely how a model-authored number would try to enter.
    """
    if not isinstance(value, Figure):
        raise CompileFailedError(
            f"{at} is {type(value).__name__}; a figure position admits only a Figure, "
            f"so a number with no snapshot provenance cannot occupy one"
        )


def _require_unique(keys: Iterable[str], *, at: str, what: str) -> None:
    seen: set[str] = set()
    duplicates: list[str] = []
    for key in keys:
        if key in seen and key not in duplicates:
            duplicates.append(key)
        seen.add(key)
    if duplicates:
        raise CompileFailedError(
            f"{at}: duplicate {what}(s) {duplicates}; a key addresses exactly one "
            f"position, or the verifier cannot report which one it could not resolve"
        )


# --- the numeric-leaf invariant, asserted in the suite AND in the image build --------
#
# The checker lives here, in `src/`, rather than only in `tests/test_ast_guard.py`,
# because `.dockerignore` excludes `tests/` — a guard that only ran in the suite could
# not stop an image from carrying an AST that admits a bare number. The test module
# calls this function and adds the guard-the-guard cases around it; the Dockerfile runs
# `python -m reporting_agent.compile.ast --assert-build`.
#
# It reads `__annotations__`, which under `from __future__ import annotations` are the
# annotation **strings** as written. That is exactly what this invariant is about: the
# rule is decidable from the spelling, with no need to resolve a type or understand what
# a field means.

NUMERIC_ANNOTATION_NAMES: Final[tuple[str, ...]] = (
    "int",
    "float",
    "Decimal",
    "DecimalString",
    "complex",
    "Fraction",
)
"""Every spelling that names a quantity. `Figure` is the only dataclass in this module
permitted to mention one — **including `TextFact`**, which is deliberately not exempted:
adding a `count: int` to it later fails the guard, which is why the text-fact node was
added under this rule rather than beside it.

`DecimalString` is listed separately from `Decimal` and the check is word-bounded, so
`\\bDecimal\\b` does not match inside `DecimalString` and each is caught under its own
name."""

FIGURE_ADMITTING_ANNOTATIONS: Final[frozenset[str]] = frozenset(
    {
        "Figure",
        "tuple[Figure, ...]",
        "Inline",
        "tuple[Inline, ...]",
        "Cell",
        "tuple[Cell, ...]",
    }
)
"""The only six spellings a field that can hold a figure may carry.

A seventh spelling would be a seventh place to audit. Restricting the vocabulary is
what lets `render/` and `verify/` enumerate figure positions by annotation rather than
by reading every node's semantics."""

_FIGURE_MENTION_PATTERN: Final[re.Pattern[str]] = re.compile(r"\b(Figure|Inline|Cell)\b")

_EXPECTED_UNION_MEMBERS: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    ("Inline", ("Text", "Figure")),
    ("Cell", ("FigureCell", "TextCell", "EmptyCell", "TextFactCell")),
)
"""`Inline` and `Cell` must be unions over **exactly** these members.

A third `Inline` member admitting a quantity would be a second numeric leaf, and the
entire guarantee is that there is one. Declared here rather than inferred from the
aliases, so the check compares the code against an intention rather than against
itself."""


class AstInvariantError(AssertionError):
    """The AST's numeric-leaf invariant is broken. Carries every violation, not the
    first: a single fix pass should be able to clear the module."""


TEXT_FACT_ADMITTING_ANNOTATIONS: Final[frozenset[str]] = frozenset({"TextFact"})
"""Every spelling that names a text fact.

The mirror of :data:`NUMERIC_ANNOTATION_NAMES` one node over: `TextFactCell.fact` is the only
field in this module permitted to mention one, so "every `TextFact` position admits the
`TextFact` node type alone" is checkable as a **declaration** rather than trusted to review.

A `frozenset` of one today. It is a set rather than a bare string because the guard asks the
same question of it that it asks of the numeric names — which fields mention any of these — and
a rule written against one name would have to be rewritten to ask about two."""


REQUIRED_NODE_NAMES: Final[tuple[str, ...]] = (
    "Figure",
    "Text",
    "TextFact",
    "FigureCell",
    "TextCell",
    "EmptyCell",
    "TextFactCell",
    "LayoutRow",
)
"""Nodes whose absence means the module was restructured rather than merely edited.

Checked because every other rule below is expressed as "no violations found", and a
module that lost `Figure` entirely would satisfy all of them."""


def _namespace_dataclasses(
    namespace: Mapping[str, object], module_name: str
) -> tuple[tuple[str, type], ...]:
    """Every dataclass in `namespace` that was *defined* in `module_name`.

    Filtered on `__module__` so a dataclass merely *imported* into the module —
    `SnapshotValue`, say — is not held to this module's rule. It has its own reasons to
    carry a `Decimal`.

    Parameterized rather than reading `globals()` directly so the guard can be pointed
    at a synthetic namespace and **proven to fire** for each rule. A guard nobody has
    watched fail is a guard nobody knows the shape of.
    """
    found: list[tuple[str, type]] = []
    for name, value in namespace.items():
        if (
            isinstance(value, type)
            and dataclasses.is_dataclass(value)
            and value.__module__ == module_name
        ):
            found.append((name, value))
    return tuple(found)


def _annotation_strings(declared: type) -> tuple[tuple[str, str], ...]:
    """`(field_name, annotation_as_written)` for one dataclass, in declaration order."""
    raw = getattr(declared, "__annotations__", {})
    return tuple(
        (declared_field.name, str(raw.get(declared_field.name, "")))
        for declared_field in dataclasses.fields(declared)
    )


def collect_invariant_violations(
    namespace: Mapping[str, object],
    *,
    module_name: str,
    exempt: str = "Figure",
    required_names: tuple[str, ...] = REQUIRED_NODE_NAMES,
    unions: tuple[tuple[str, tuple[str, ...]], ...] = _EXPECTED_UNION_MEMBERS,
) -> list[str]:
    """Every numeric-leaf violation in `namespace`, as messages.

    Four rules, all decidable from annotation **spelling** — which is why
    `DecimalString` is a `NewType` and why no cardinality is a number:

    1. **No dataclass other than `exempt` mentions a numeric type in any annotation.**
       This is the rule "no cardinality is a number" makes checkable: because
       `LayoutRow` carries columns rather than a count and a heading carries a style
       name rather than a level, there is no legitimate numeric annotation outside
       `Figure`, and therefore no allowlist of exceptions for the next bare number to
       hide in.
    2. **Every figure-admitting annotation is one of six spellings**
       (:data:`FIGURE_ADMITTING_ANNOTATIONS`).
    3. **Each declared union is over exactly its declared members.**
    4. **Every dataclass is `frozen=True, slots=True`.**

    Returns a list rather than raising so a caller can assert the list is empty *and* a
    guard-the-guard test can assert it is not.
    """
    violations: list[str] = []
    declared = _namespace_dataclasses(namespace, module_name)

    if not declared:
        violations.append(
            f"no dataclasses were found in {module_name!r} — a guard that passes by "
            f"inspecting nothing is worse than no guard"
        )

    names = {name for name, _ in declared}
    for required in required_names:
        if required not in names:
            violations.append(f"{module_name} no longer declares {required!r}")

    for name, node in declared:
        params = node.__dataclass_params__  # type: ignore[attr-defined]
        if not getattr(params, "frozen", False):
            violations.append(f"{name} is not frozen=True")
        if not getattr(params, "slots", False) or not hasattr(node, "__slots__"):
            violations.append(f"{name} is not slots=True")

        for field_name, annotation in _annotation_strings(node):
            where = f"{name}.{field_name}: {annotation}"

            if name != exempt:
                for numeric in NUMERIC_ANNOTATION_NAMES:
                    if re.search(rf"\b{numeric}\b", annotation):
                        violations.append(
                            f"{where} mentions {numeric!r}; {exempt} is the only node "
                            f"permitted to carry a quantity, and no cardinality is a "
                            f"number (express it as a tuple or a style name)"
                        )

            if _FIGURE_MENTION_PATTERN.search(annotation):
                if annotation not in FIGURE_ADMITTING_ANNOTATIONS:
                    violations.append(
                        f"{where} can hold a figure but is not one of "
                        f"{sorted(FIGURE_ADMITTING_ANNOTATIONS)}"
                    )

    for alias_name, expected in unions:
        alias = namespace.get(alias_name)
        members = tuple(
            getattr(member, "__name__", str(member))
            for member in _union_members(getattr(alias, "__value__", None))
        )
        if tuple(sorted(members)) != tuple(sorted(expected)):
            violations.append(
                f"{alias_name} is a union over {list(members)}, expected exactly "
                f"{list(expected)}"
            )

    return violations


def assert_numeric_leaf_invariant() -> None:
    """Raise :class:`AstInvariantError` listing **every** numeric-leaf violation in this
    module, or return silently.

    Called by `tests/test_ast_guard.py` and by the image build
    (`python -m reporting_agent.compile.ast --assert-build`), so an image cannot carry an
    AST that admits a bare number.
    """
    violations = collect_invariant_violations(globals(), module_name=__name__)
    if violations:
        raise AstInvariantError(
            "the AST's numeric-leaf invariant is broken:\n  " + "\n  ".join(violations)
        )


def _union_members(value: object) -> tuple[object, ...]:
    """The members of a `X | Y | Z` union, or `()` for anything that is not one."""
    args = getattr(value, "__args__", None)
    return tuple(args) if isinstance(args, tuple) else ()


if __name__ == "__main__":  # pragma: no cover - exercised by the Dockerfile and the suite
    import sys

    if "--assert-build" not in sys.argv[1:]:
        print(
            "usage: python -m reporting_agent.compile.ast --assert-build",
            file=sys.stderr,
        )
        raise SystemExit(2)

    assert_numeric_leaf_invariant()
    print("ast numeric-leaf invariant ok")
