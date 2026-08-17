"""The figure ledger and the block cursor: one structure, not two.

**The ledger and the render context are the same object** (Req 17.1, 17.4). The ledger's
values *are* the `Figure` instances the AST holds — the identical objects, by reference —
so the tree the renderer walks and the ledger the verifier checks against cannot disagree.
They cannot drift because there is only one of them.

That is the entire design, and everything below exists to make it impossible to
accidentally build a second one:

* **There is no `build_ledger(ast)` function anywhere in this package, and there cannot
  be one without deleting :meth:`BlockCursor.figure`** (Req 17.4). A parallel walk is a
  second structure, and two structures can disagree — which is exactly the class of bug
  the whole verification stage exists to catch, reintroduced one layer below it.
* **:meth:`BlockCursor.figure` is the only figure factory** (Req 17.2). It mints the
  path, calls `compile/format.py`, constructs the `Figure` and inserts it into the ledger
  **in one step**, so the entry is created during the traversal that creates the node and
  the ledger's value is that same object.
* **The factory takes a `SnapshotValue` and nothing else numeric.** A `SnapshotValue`
  carries its own JSON Pointer, minted by `compile/snapshot_view.py`'s walk from the
  position it was read at. So a `Figure` is unconstructible from a number that did not
  come out of a snapshot, and there is consequently **no operation anywhere in this
  package** that accepts a numeric produced by a language model, supplied in a template
  definition, or computed from model-authored text, and places it in a figure position
  (Req 17.3).

## Two checks that turn the design into something observable

**The closing invariant** (:func:`assert_ledger_matches_tree`): the ledger's key set
equals the figure paths found by an **assertion-only walk of the finished tree**, and no
two figure nodes resolve to one key. The walk recomputes every path structurally from
`compile/ast.py`'s `child_nodes` and compares it to the path the figure carries, so a
cursor that minted a wrong ordinal is a `COMPILE_FAILED` naming both paths rather than a
ledger whose keys quietly disagree with the tree.

**The factory call count**: `BlockCursor` counts its own `figure` calls, and the invariant
requires that count to equal both the ledger's entry count and the tree's figure-node
count. A second-pass implementation — one that walked the tree afterwards to fill a
ledger — shows up as a count mismatch rather than as something a reviewer has to notice.

## Serialization

`serialize()` renders the ledger as entries keyed by path in RFC 8785 canonical form, and
`digest()` hashes that. The artifact is written alongside the document and its digest
recorded on the verification result, so a later re-verification reads **the same ledger
the render used**. The renderers, though, read the **in-memory** object: never a written
or deserialized one, because a round trip through JSON would produce equal-looking
`Figure` values that are no longer the same objects the tree holds, and the one guarantee
this module provides would be gone.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Final

import rfc8785

from reporting_agent.compile.ast import (
    Figure,
    FigurePath,
    FigureSource,
    LayoutColumn,
    chart_id,
    child_nodes,
    decimal_string_of,
    figure_path,
    table_id,
)
from reporting_agent.compile.estimators import estimator_label, is_percentile_statistic
from reporting_agent.compile.format import (
    DEFAULT_NUMBER_FORMAT,
    NumberFormat,
    format_figure,
)
from reporting_agent.compile.snapshot_view import SnapshotValue
from reporting_agent.errors import CompileFailedError

__all__ = [
    "ANCHOR_CHART",
    "ANCHOR_KINDS",
    "ANCHOR_TABLE",
    "UNSET",
    "BlockCursor",
    "FigureLedger",
    "TableAnchor",
    "assert_ledger_matches_tree",
    "walk_figures",
]

ANCHOR_TABLE: Final[str] = "table"
ANCHOR_CHART: Final[str] = "chart"
ANCHOR_KINDS: Final[tuple[str, ...]] = (ANCHOR_TABLE, ANCHOR_CHART)


@dataclass(frozen=True, slots=True)
class _Unset:
    """The "argument omitted" sentinel for :meth:`BlockCursor.figure`'s `catalog_scale`.

    A sentinel rather than `None`, because `None` already means something specific and
    opposite: "a catalog was consulted and it declares no scale for this metric", which is
    Req 18.11's refusal. Collapsing the two onto one value is how a metric with no declared
    precision comes to be published at a guessed one — and it is a bug that produces a
    plausible-looking document, which is the worst kind here.
    """


UNSET: Final[_Unset] = _Unset()


@dataclass(frozen=True, slots=True)
class TableAnchor:
    """A data table's or chart's identity, recorded against the figures inside it.

    `render/anchors.py` writes the `w:tblCaption` id; the verifier's table pass looks for
    it. Recording it here — **onto the existing ledger entry**, not into a separate
    collection — is what lets the verifier go from "this document token is inside table
    `tbl:resources:1`" to "so it must equal one of these figures' `formatted` values"
    without re-deriving the document's structure.
    """

    kind: str
    anchor_id: str
    row_key: str | None = None
    column_key: str | None = None

    def __post_init__(self) -> None:
        if self.kind not in ANCHOR_KINDS:
            raise CompileFailedError(
                f"an anchor kind must be one of {list(ANCHOR_KINDS)}, got {self.kind!r}"
            )
        if not self.anchor_id:
            raise CompileFailedError("an anchor id must be a non-empty string")


@dataclass(slots=True)
class FigureLedger:
    """Every figure one render emitted, keyed by AST node path (Req 17.1).

    `_entries`' values **are** the objects the AST holds. Not copies, not equal-looking
    reconstructions — the same objects, which is why there is no synchronization step
    anywhere in this module and no way for the two to fall out of agreement.

    Mutable during compilation and only during compilation: entries are inserted by
    :meth:`BlockCursor.figure` as the tree is built, and `compile()` calls
    :func:`assert_ledger_matches_tree` before returning. Nothing exposed here removes or
    replaces an entry.
    """

    _entries: dict[FigurePath, Figure] = field(default_factory=dict)
    _anchors: dict[FigurePath, TableAnchor] = field(default_factory=dict)

    def __getitem__(self, path: FigurePath | str) -> Figure:
        try:
            return self._entries[FigurePath(str(path))]
        except KeyError:
            raise KeyError(
                f"no figure at {path!r}; the ledger holds {len(self._entries)} entries"
            ) from None

    def __contains__(self, path: object) -> bool:
        return isinstance(path, str) and FigurePath(path) in self._entries

    def __len__(self) -> int:
        return len(self._entries)

    def __iter__(self) -> Iterator[FigurePath]:
        return iter(self._entries)

    @property
    def entries(self) -> Mapping[FigurePath, Figure]:
        """A read-only view of the entries, in insertion order — which is document order,
        because insertion happens during the traversal that builds the tree."""
        return MappingProxyType(self._entries)

    def paths(self) -> tuple[FigurePath, ...]:
        return tuple(self._entries)

    def insert(self, figure: Figure) -> None:
        """Record `figure` under its own path.

        Only :meth:`BlockCursor.figure` calls this, and it does so in the same step that
        constructs the figure. A duplicate path is a `COMPILE_FAILED`: two figures at one
        key would make the ledger's provenance ambiguous, and the verifier would have two
        candidate `formatted` values for one document token.
        """
        if figure.path in self._entries:
            existing = self._entries[figure.path]
            raise CompileFailedError(
                f"two figures resolve to the ledger key {figure.path!r} "
                f"({existing.snapshot_path!r} and {figure.snapshot_path!r}); a node path "
                f"addresses exactly one position"
            )
        self._entries[figure.path] = figure

    def record_anchor(self, path: FigurePath, anchor: TableAnchor) -> None:
        """Attach a table or chart identity to an **existing** entry.

        Refuses a path the ledger does not hold, rather than creating a bare anchor
        record: an anchor with no figure is a claim about a document position that carries
        no verifiable number, which is the shape of a second structure starting to grow.
        """
        if path not in self._entries:
            raise CompileFailedError(
                f"cannot record an anchor for {path!r}: the ledger holds no figure there"
            )
        self._anchors[path] = anchor

    def anchors(self) -> Mapping[FigurePath, TableAnchor]:
        return MappingProxyType(self._anchors)

    def formatted_values(self) -> tuple[str, ...]:
        """Every distinct `formatted` string, **longest first**.

        Longest-first is masking stage 1's requirement, not a preference. The verifier
        masks known figures out of the document text before looking for unmatched numeric
        tokens, and masking `12.4` before `12.48%` would leave `8%` behind as a spurious
        unmatched token — a false verification failure on a correct report. Ties break on
        the string itself so the order is total and identical across processes.
        """
        distinct = {figure.formatted for figure in self._entries.values()}
        return tuple(sorted(distinct, key=lambda value: (-len(value), value)))

    def by_snapshot_path(self) -> Mapping[str, tuple[FigurePath, ...]]:
        """Which figures cite each snapshot position, for the coverage pass.

        Ordered by figure path so two compiles of one snapshot produce the same mapping.
        """
        grouped: dict[str, list[FigurePath]] = {}
        for path, figure in self._entries.items():
            grouped.setdefault(figure.snapshot_path, []).append(path)
        return MappingProxyType(
            {key: tuple(sorted(value)) for key, value in sorted(grouped.items())}
        )

    def serialize(self) -> bytes:
        """The ledger as its RFC 8785 canonical artifact — entries keyed by path.

        Written alongside the document and its SHA-256 recorded on the verification
        result, so a later re-verification reads the same ledger the render used. Keys are
        emitted in sorted order for readability; JCS orders object keys itself, so the
        digest does not depend on it.
        """
        return rfc8785.dumps(
            {
                "schema_version": 1,
                "entries": {
                    str(path): _figure_to_plain(self._entries[path])
                    for path in sorted(self._entries)
                },
                "anchors": {
                    str(path): _anchor_to_plain(self._anchors[path])
                    for path in sorted(self._anchors)
                },
            }
        )

    def digest(self) -> str:
        """SHA-256 over :meth:`serialize`, as 64 lowercase hexadecimal characters."""
        return hashlib.sha256(self.serialize()).hexdigest()


def _figure_to_plain(figure: Figure) -> dict[str, object]:
    """One ledger entry as plain data.

    Every optional field that is `None` is **omitted** rather than emitted as `null`, so
    the entry's shape says what kind of figure it is — the same convention
    `collect/snapshot.py` applies to a statistic object, and for the same reason: two
    spellings of "absent" would be two digests for one ledger.
    """
    entry: dict[str, object] = {
        "path": str(figure.path),
        "value": str(figure.value),
        "unit": figure.unit,
        "snapshot_path": figure.snapshot_path,
        "formatted": figure.formatted,
        "statistic": figure.statistic,
    }
    for name in (
        "fidelity_tier",
        "metric",
        "resource_id",
        "window",
        "estimator",
        "estimator_label",
        "formula",
    ):
        value = getattr(figure, name)
        if value is not None:
            entry[name] = value
    if figure.derived_from:
        entry["derived_from"] = [
            _source_to_plain(source) for source in figure.derived_from
        ]
    return entry


def _source_to_plain(source: FigureSource) -> dict[str, object]:
    plain: dict[str, object] = {"kind": source.kind, "name": source.name}
    if source.statistic is not None:
        plain["statistic"] = source.statistic
    if source.unit is not None:
        plain["unit"] = source.unit
    return plain


def _anchor_to_plain(anchor: TableAnchor) -> dict[str, object]:
    plain: dict[str, object] = {"kind": anchor.kind, "anchor_id": anchor.anchor_id}
    if anchor.row_key is not None:
        plain["row_key"] = anchor.row_key
    if anchor.column_key is not None:
        plain["column_key"] = anchor.column_key
    return plain


# --- the cursor ---------------------------------------------------------------------


@dataclass(slots=True)
class BlockCursor:
    """Mints node paths and figures for one block, in declared child order.

    A cursor is created per block by the block compiler, carries that block's id, and is
    the **only** way a figure comes into existence. Child cursors are minted by
    :meth:`child`, which appends an ordinal, so a path is always the concatenation of the
    positions actually traversed rather than a string someone composed.

    `_emitted` counts the children handed out per cursor, so `child(field, ordinal)` can
    check that a caller is proceeding in the declared order rather than skipping or
    revisiting one. It is a cheap check with a specific target: an ordinal minted out of
    order produces a ledger key that does not match the tree, and catching it here names
    the field rather than leaving :func:`assert_ledger_matches_tree` to report two paths
    that differ by one digit.
    """

    block_id: str
    ledger: FigureLedger
    number_format: NumberFormat = DEFAULT_NUMBER_FORMAT
    _ordinals: tuple[int, ...] = ()
    _emitted: int = 0
    _factory_calls: list[int] = field(default_factory=lambda: [0])

    @property
    def path(self) -> FigurePath:
        """This cursor's own node path.

        Raises for a block-root cursor, which addresses a **block** rather than a node:
        `<block_id>` alone is a block's name, and a node always carries at least one
        ordinal. A caller wanting the block's first emitted node asks for `child(...)`.
        """
        if not self._ordinals:
            raise CompileFailedError(
                f"block {self.block_id!r} has no node path of its own; a node path "
                f"carries at least one ordinal. Ask for a child."
            )
        return figure_path(self.block_id, *self._ordinals)

    @property
    def factory_calls(self) -> int:
        """How many figures this block's cursors have minted, in total.

        Shared by reference across every child cursor — a one-element list rather than an
        `int`, because a frozen count per cursor would only ever report the leaf that
        happened to be asked. The closing invariant compares this against both the
        ledger's entry count and the tree's figure-node count, so a second-pass
        implementation shows up as a count mismatch.
        """
        return self._factory_calls[0]

    def child(self, field_name: str, ordinal: int) -> BlockCursor:
        """A cursor for the child at `ordinal` within the parent's declared child order.

        `field_name` is the dataclass field the child sits in, carried for the error
        message only — the ordinal is already flat across every child-bearing field, which
        is what `compile/ast.py`'s `child_nodes` defines.
        """
        if isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal < 0:
            raise CompileFailedError(
                f"block {self.block_id!r} field {field_name!r}: an ordinal must be a "
                f"non-negative integer, got {ordinal!r}"
            )
        return BlockCursor(
            block_id=self.block_id,
            ledger=self.ledger,
            number_format=self.number_format,
            _ordinals=(*self._ordinals, ordinal),
            _factory_calls=self._factory_calls,
        )

    def children(self, field_name: str, count: int) -> tuple[BlockCursor, ...]:
        """Cursors for `count` consecutive children, in order — the common case."""
        return tuple(self.child(field_name, ordinal) for ordinal in range(count))

    def figure(
        self,
        snapshot_value: SnapshotValue,
        *,
        catalog_scale: int | _Unset | None = UNSET,
        number_format: NumberFormat | None = None,
    ) -> Figure:
        """Mint the figure at this cursor's path, and record it. **The only factory.**

        One step: mint the path, compose the estimator label, format the display string,
        construct the `Figure` — which re-resolves its own `snapshot_path` against the
        compiling snapshot — and insert it into the ledger. The entry is created during
        the traversal that creates the node, and the ledger's value *is* that node.

        Takes a `SnapshotValue` and nothing else that could carry a quantity. A
        `SnapshotValue` exists only as the output of `compile/snapshot_view.py`'s walk and
        carries the JSON Pointer of the position it was read at, so there is no way to
        reach this method with a number a language model produced, a template supplied, or
        a caller computed from prose.

        **`catalog_scale` distinguishes three cases, and the third is Req 18.11's refusal.**

        * **Omitted** (:data:`UNSET`) — use the value's own stored scale, which *is* the
          catalog scale that was in force when the collector serialized it. This is the
          right default for an archived report: reading today's catalog instead would let a
          catalog edit change how a two-year-old document renders.
        * **An `int`** — a caller holding the loaded catalog passes the currently declared
          scale. The display scale is the maximum of that and the template's
          `decimal_places` either way, so the figure can only gain digits, never lose them.
        * **`None`** — the caller consulted a catalog and it **declares no scale for this
          metric**. That is a refusal, not a fallback: `format_figure` produces no string at
          all and the run fails with the AST path named. A sentinel is needed precisely
          because `None` and "omitted" mean opposite things here — collapsing them onto one
          value is how a metric with no declared precision comes to be published at a
          guessed one.
        """
        path = self.path
        at = f"figure {str(path)!r}"

        if not isinstance(snapshot_value, SnapshotValue):
            raise CompileFailedError(
                f"{at}: a figure is minted from a SnapshotValue, got "
                f"{type(snapshot_value).__name__}. Every figure traces to a position in "
                f"an immutable snapshot; there is no factory that accepts a bare number, "
                f"which is what makes a model-authored figure unconstructible."
            )

        label = estimator_label(snapshot_value.estimator, snapshot_value.statistic, at=at)

        # Req 18.10 — a percentile with no estimator label may not exist. The formatter
        # cannot check this: it never sees the statistic. This is the layer that knows.
        if label is None and is_percentile_statistic(snapshot_value.statistic):
            raise CompileFailedError(
                f"{at}: the statistic {snapshot_value.statistic!r} is a percentile but "
                f"its estimator {snapshot_value.estimator!r} composes no label. A "
                f"percentile estimated from coarser intervals runs well below the true "
                f"value, so it may not appear unqualified."
            )

        resolved_scale = (
            snapshot_value.scale if isinstance(catalog_scale, _Unset) else catalog_scale
        )
        formatted = format_figure(
            snapshot_value.value,
            unit=snapshot_value.unit,
            catalog_scale=resolved_scale,
            number_format=number_format or self.number_format,
            estimator_label=label,
            path=str(path),
        )

        figure = Figure(
            path=path,
            value=decimal_string_of(f"{snapshot_value.value:f}", at=at),
            unit=snapshot_value.unit,
            snapshot_path=snapshot_value.pointer,
            formatted=formatted,
            # `None` where no resource is measured — a derived cardinality has no tier, and
            # `""` would be a second spelling of absent that every renderer would special-case.
            fidelity_tier=snapshot_value.fidelity_tier or None,
            statistic=snapshot_value.statistic,
            metric=snapshot_value.metric or None,
            resource_id=snapshot_value.resource_id or None,
            window=snapshot_value.window or None,
            estimator=snapshot_value.estimator,
            estimator_label=label,
            derived_from=tuple(
                FigureSource(
                    kind=source.kind,
                    name=source.name,
                    statistic=source.statistic,
                    unit=source.unit,
                )
                for source in snapshot_value.derived_from
            ),
            formula=snapshot_value.formula or None,
        )

        self.ledger.insert(figure)
        self._factory_calls[0] += 1
        return figure

    def anchor_table(self, path: FigurePath) -> str:
        """Record the table anchor for every figure already inside `path`'s subtree, and
        return the anchor id.

        Called by the block compiler once the table node exists. The anchor is recorded
        **onto existing ledger entries** — there is no separate anchor collection to keep
        in step.
        """
        anchor_id = table_id(path)
        prefix = f"{path}."
        for candidate in self.ledger.paths():
            if str(candidate).startswith(prefix):
                self.ledger.record_anchor(
                    candidate, TableAnchor(kind=ANCHOR_TABLE, anchor_id=anchor_id)
                )
        return anchor_id

    def anchor_chart(self, path: FigurePath) -> str:
        """As :meth:`anchor_table`, for a chart."""
        anchor_id = chart_id(path)
        prefix = f"{path}."
        for candidate in self.ledger.paths():
            if str(candidate).startswith(prefix):
                self.ledger.record_anchor(
                    candidate, TableAnchor(kind=ANCHOR_CHART, anchor_id=anchor_id)
                )
        return anchor_id


# --- the assertion-only walk and the closing invariant -------------------------------


def walk_figures(node: object) -> Iterator[tuple[tuple[int, ...], Figure]]:
    """Every figure in `node`'s subtree, with the **structurally recomputed** ordinals
    that address it.

    Assertion-only. Nothing builds a ledger from this — that is the point. It recomputes
    positions from `compile/ast.py`'s `child_nodes`, which is the single definition of
    declared child order, so :func:`assert_ledger_matches_tree` can compare what the
    cursor minted against what the finished tree actually says.

    **It stops at a `LayoutColumn`.** A `row` block's columns hold *other blocks*, and a
    figure inside one of them is rooted at **that** block's id, not the row's — a path
    starts with the block that emitted it. Descending would recompute those figures'
    positions relative to the row and report every one of them as misplaced. Each nested
    block is registered with :func:`assert_ledger_matches_tree` under its own id instead,
    so every figure is still walked exactly once and the union still covers the whole tree.
    """
    if isinstance(node, Figure):
        yield ((), node)
        return
    if isinstance(node, LayoutColumn):
        return
    for ordinal, child in enumerate(child_nodes(node)):
        for suffix, found in walk_figures(child):
            yield ((ordinal, *suffix), found)


def assert_ledger_matches_tree(
    blocks: Mapping[str, object], ledger: FigureLedger, *, factory_calls: int
) -> None:
    """The closing invariant, asserted before `compile()` returns (Req 17.9, 17.11).

    `blocks` maps each block id to the tuple of nodes that block emitted, so the walk can
    recompute a full `FigurePath` — block id plus ordinals — rather than only a relative
    position.

    Three things are checked together, because each catches a different way the one-object
    design could have been broken:

    1. **The ledger's key set equals the tree's figure paths.** A key in one and not the
       other means the ledger is no longer a view of the tree.
    2. **Each figure's own `path` equals the path the tree structurally addresses it at.**
       This is what catches a cursor that minted a wrong ordinal — the figure would be in
       the ledger under a key that does not describe where it actually sits.
    3. **The factory call count equals both counts.** A second-pass implementation, one
       that walked the tree afterwards to fill a ledger, would satisfy (1) and (2) and
       fail here.

    Raises `COMPILE_FAILED` naming every differing or colliding path.
    """
    from_tree: dict[FigurePath, Figure] = {}
    collisions: list[str] = []
    misplaced: list[str] = []

    for block_id, emitted in sorted(blocks.items()):
        nodes = emitted if isinstance(emitted, tuple) else (emitted,)
        for ordinal, node in enumerate(nodes):
            for suffix, figure in walk_figures(node):
                structural = figure_path(block_id, ordinal, *suffix)
                if structural in from_tree:
                    collisions.append(str(structural))
                from_tree[structural] = figure
                if str(figure.path) != str(structural):
                    misplaced.append(
                        f"{figure.path!r} sits at {structural!r} in the tree"
                    )

    problems: list[str] = []
    if collisions:
        problems.append(f"two figure nodes resolve to one path: {sorted(set(collisions))}")
    if misplaced:
        problems.append(
            "a figure's minted path disagrees with its position in the tree: "
            f"{sorted(set(misplaced))}"
        )

    ledger_keys = {str(path) for path in ledger.paths()}
    tree_keys = {str(path) for path in from_tree}
    if ledger_keys != tree_keys:
        only_ledger = sorted(ledger_keys - tree_keys)
        only_tree = sorted(tree_keys - ledger_keys)
        if only_ledger:
            problems.append(f"in the ledger but not in the tree: {only_ledger}")
        if only_tree:
            problems.append(f"in the tree but not in the ledger: {only_tree}")

    for path in sorted(ledger_keys & tree_keys):
        key = FigurePath(path)
        if ledger[key] is not from_tree[key]:
            problems.append(
                f"{path}: the ledger's figure is not the object the tree holds; the "
                f"ledger is a view of the tree, not a copy of it"
            )

    if factory_calls != len(ledger) or factory_calls != len(from_tree):
        problems.append(
            f"the figure factory was called {factory_calls} time(s) but the ledger holds "
            f"{len(ledger)} entr(ies) and the tree holds {len(from_tree)} figure node(s); "
            f"a second pass built one of them"
        )

    if problems:
        raise CompileFailedError(
            "the figure ledger and the compiled tree disagree:\n  " + "\n  ".join(problems)
        )
