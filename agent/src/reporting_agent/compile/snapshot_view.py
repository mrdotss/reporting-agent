"""The `SnapshotView`: the only place a value enters the compile stage.

One walk of one immutable snapshot document produces one index. Every quantity the
compiler can reach is a :class:`SnapshotValue`, and every :class:`SnapshotValue`
carries the **RFC 6901 JSON Pointer of its own `value` field**, recorded from the
position the walk found it at (Req 15.5, 15.11). That is the whole design, and the
consequences are what make provenance structural rather than procedural:

* **`pointer` is derived, never supplied.** The only code that constructs a
  :class:`SnapshotValue` is :func:`build_snapshot_view`'s walk, and it computes the
  pointer from where it is standing. There is no factory, no `with_pointer(...)`, and
  no keyword that lets a caller assert a provenance it did not read. A
  :meth:`SnapshotValue.__post_init__` check refuses a pointer that is not a
  syntactically valid RFC 6901 pointer ending in `/value`, so a fabricated one is
  detectable rather than merely discouraged.
* **`compile/ast.py`'s `Figure` can therefore only be built from one of these.**
  `BlockCursor.figure(snapshot_value, ...)` (task 5.5) takes a `SnapshotValue` and
  nothing else, which is what makes a `Figure` unconstructible from a number that did
  not come out of a snapshot — including a number a language model produced.
* **Array indices are stable, so a pointer minted today resolves identically in a
  re-verification a year later.** Not an assumption: `collect/snapshot.py` *produces*
  every array order rather than inheriting it (Req 34.8) — resources by resource id,
  statistics by `(metric, statistic, instance)`, day buckets by local day, gaps by
  `(gap_type, resource_id, metric)` — and the document is immutable and
  content-addressed, so the bytes a pointer indexes into cannot change under it.

**Every value is parsed from the snapshot's decimal string into `Decimal`, and no
float is constructed anywhere on this path.** `Decimal(float)` would bake a binary
approximation into an audit artifact, and a JSON number in a value position is a
snapshot this module refuses to read rather than one it silently repairs — see
:func:`parse_decimal_string`. The failure is `COMPILE_FAILED` naming the pointer,
because a snapshot the compiler cannot read is a compile failure and not a collection
one: by the time this module runs, collection has already succeeded and been hashed.

**Two things the walk indexes that are not in a `statistics` array.**

*SKU capacities.* `capacity_vs_usage` has to emit a capacity as a **figure**, and a
figure needs a pointer. The `sku` object's `vcpus_available` and `memory_bytes` are
already decimal strings at their own positions, so the walk indexes them as
:class:`SnapshotValue`s under the metric names `sku.vcpus_available` and
`sku.memory_bytes` with the statistic `capacity`. A capacity figure then carries
provenance identical *in kind* to a metric figure — `/resources/3/sku/memory_bytes`
resolves and re-resolves exactly like `/resources/3/statistics/0/value` — rather than
being a number the compiler happens to know. Their `unit` is `count` and `bytes`
respectively, and neither is a Metric_Catalog *metric* unit, which is why
`compile/format.py` reads the unit as a string rather than assuming catalog
membership.

*Day buckets.* A day's statistics are indexed separately from a window's, keyed by
local day, because a timeseries block plots days and a KPI block reads the window.
Collapsing them would make `stat()` ambiguous for a metric that has both.

**What this module does not do.** It resolves no scope (that is `compile/scope.py`,
which takes a view), formats no string (`compile/format.py`), and mints no figure
(`compile/figures.py`). It imports no Azure SDK, no cloud SDK and no catalog: a
snapshot document in, a queryable index out, which is what lets the whole compile
stage be exercised against a JSON file.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from types import MappingProxyType
from typing import Final, Protocol, runtime_checkable

from reporting_agent.errors import CompileFailedError

__all__ = [
    "CARDINALITY_ESTIMATOR",
    "CARDINALITY_NAMESPACE",
    "CARDINALITY_SOURCE_KIND",
    "CARDINALITY_STATISTIC",
    "CARDINALITY_TOKEN",
    "DECIMAL_STRING_PATTERN",
    "SKU_CAPABILITIES",
    "SKU_CAPACITY_ESTIMATOR",
    "SKU_CAPACITY_STATISTIC",
    "SKU_METRIC_PREFIX",
    "CountKind",
    "DerivedSource",
    "FactTextValue",
    "GapEntry",
    "RequestedScope",
    "ResourceView",
    "SkuView",
    "SnapshotResolver",
    "SnapshotValue",
    "SnapshotView",
    "WindowView",
    "build_snapshot_view",
    "escape_pointer_token",
    "parse_decimal_string",
    "pointer",
]


# --- the decimal-string grammar -----------------------------------------------------

DECIMAL_STRING_PATTERN: Final[re.Pattern[str]] = re.compile(r"\A-?[0-9]+(\.[0-9]+)?\Z")
"""The one grammar for a stored quantity, shared with `compile/ast.py`'s
`DecimalString`.

An optional leading `-`, digits, and at most one `.` followed by digits. It admits no
exponent (`1E+3` and `1000` are two spellings of one quantity and a content-addressed
artifact cannot carry both), no leading `+`, no thousands separator, no surrounding
whitespace, no empty string and no non-finite designation. `collect/snapshot.py`'s
`decimal_string` produces exactly this shape via `format(value, "f")`, and this is the
reader that holds it to it."""

SKU_METRIC_PREFIX: Final[str] = "sku."
SKU_CAPACITY_STATISTIC: Final[str] = "capacity"
SKU_CAPACITY_ESTIMATOR: Final[str] = "sku_declared_capacity"

CARDINALITY_NAMESPACE: Final[str] = "$counts"
CARDINALITY_TOKEN: Final[str] = "count"
CARDINALITY_STATISTIC: Final[str] = "count"
CARDINALITY_ESTIMATOR: Final[str] = "snapshot_cardinality"
CARDINALITY_SOURCE_KIND: Final[str] = "snapshot_collection"
"""The reserved namespace for a **derived cardinality** — how many records one of the
snapshot's own collections holds.

`verification_record` must emit the resource count, the gap count and the per-tier counts
**as figures** (Req 16.4), and `gaps_and_coverage` must emit each group's count as one
(Req 16.3). A figure needs a `snapshot_path` that re-resolves, and a count is not stored
anywhere in the snapshot as a decimal string — the document carries the `resources` array,
not its length.

So the walk indexes cardinalities under `/$counts/...`, and three things make that honest
rather than a loophole:

* **The address is reserved and cannot collide.** Every top-level key the Snapshot_Builder
  writes is declared, and none begins with `$`.
* **The derivation is recorded on the value**, in `formula` and `derived_from`, naming the
  exact collection counted — the same treatment `memory_used_pct` gets. A count with no
  stated derivation would be an assertion; this one says what it counted.
* **It is reproducible from the document alone.** Rebuilding the view from the same
  immutable snapshot yields the same counts, so a re-verification a year later resolves
  these pointers to the same values — which is the whole property `snapshot_path` exists
  to provide.

The alternative — emitting a count as a text node — would put a number in the document
that the verifier's soundness pass finds and cannot match, and the report would be
withheld. Counting is the one derivation the document format forces."""

SKU_CAPABILITIES: Final[tuple[tuple[str, str], ...]] = (
    ("vcpus_available", "count"),
    ("memory_bytes", "bytes"),
)
"""The `sku` object's capacity fields and the unit each carries, in a declared visit
order so two walks over one document index them identically.

`vcpus_available` is `vCPUsAvailable` and **not** `vCPUs`: a constrained-core SKU
reports its parent's core count, so `Standard_E32-8s_v5` advertises 32 and exposes 8
(Req 21.2). The snapshot already made that choice; this module only has to not undo
it by indexing a field named something else."""


def parse_decimal_string(raw: object, at: str) -> Decimal:
    """`raw` as a `Decimal`, or `COMPILE_FAILED` naming the pointer `at`.

    Accepts **only** a `str` matching :data:`DECIMAL_STRING_PATTERN`. A JSON number is
    refused rather than converted: an `int` would be a value the collector was
    supposed to render as a string, and a `float` would mean `Decimal(float)` — baking
    a binary approximation into the audit artifact and putting this reader's digest
    into disagreement with the one the collector computed.

    The message names the pointer and the offending *type* or spelling, never a
    credential-bearing surrounding object.
    """
    if isinstance(raw, bool) or not isinstance(raw, str):
        raise CompileFailedError(
            f"{at} carries {type(raw).__name__}, not a decimal string: every metric "
            f"value is a fixed-precision decimal string end to end (Req 34.1, 34.2), "
            f"and converting a JSON number here would bake a binary approximation "
            f"into an audit artifact"
        )
    if not DECIMAL_STRING_PATTERN.match(raw):
        raise CompileFailedError(
            f"{at} is not a fixed-precision decimal string: expected an optional "
            f"leading '-', digits and at most one '.' followed by digits, carrying no "
            f"exponent and no separator"
        )
    try:
        return Decimal(raw)
    except InvalidOperation as exc:  # pragma: no cover - the pattern already excludes these
        raise CompileFailedError(f"{at} is not a readable decimal: {exc}") from exc


def _scale_of(raw: str) -> int:
    """The fractional-digit count of a stored decimal string.

    This is the scale the **collector serialized at**, which is evidence of the
    Metric_Catalog scale in force when the snapshot was written. It is deliberately
    *not* the scale `compile/format.py` formats at: that module takes the catalog's
    currently declared scale and uses it as a floor (Req 18.4). Carrying the observed
    scale here lets a reader see what the snapshot actually holds without this module
    needing a catalog.
    """
    _, _, fraction = raw.partition(".")
    return len(fraction)


# --- RFC 6901 pointers --------------------------------------------------------------


def escape_pointer_token(token: str) -> str:
    """One RFC 6901 reference token, escaped: `~` becomes `~0` and `/` becomes `~1`.

    In practice no token this module emits needs escaping — every one is either a
    fixed key name (`resources`, `statistics`, `value`) or an array index — but a
    resource id is a slash-heavy string and the day a pointer addresses one by name
    rather than by index is the day an unescaped implementation silently addresses the
    wrong place. `~` is replaced first; the other order would re-escape the `~` the
    `/` replacement introduces.
    """
    return token.replace("~", "~0").replace("/", "~1")


def pointer(*tokens: str | int) -> str:
    """An RFC 6901 JSON Pointer from reference tokens: `pointer("resources", 3,
    "statistics", 0, "value")` is `/resources/3/statistics/0/value`."""
    return "".join(f"/{escape_pointer_token(str(token))}" for token in tokens)


def _split_pointer(raw: str) -> tuple[str, ...] | None:
    """A pointer's decoded reference tokens, or `None` if it is not a valid pointer.

    The empty string is a valid pointer addressing the whole document, but no value in
    a snapshot sits there, so it decodes to `()` and every caller here rejects it on
    the separate ground that it does not end in `/value`.
    """
    if raw == "":
        return ()
    if not raw.startswith("/"):
        return None
    tokens: list[str] = []
    for token in raw.split("/")[1:]:
        if "~" in re.sub(r"~[01]", "", token):
            return None  # a stray `~` not part of `~0` or `~1`
        tokens.append(token.replace("~1", "/").replace("~0", "~"))
    return tuple(tokens)


# --- the value ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DerivedSource:
    """One entry of a derived value's `derived_from` list (Req 30.9).

    Declared here rather than imported from `collect/accumulate.py` on purpose: the
    compile stage reads a **stored document**, not the objects that produced it. A
    re-verification a year from now opens a JSON file, and a shape borrowed from the
    collector would tie this reader to a version of the collector that may no longer
    exist.
    """

    kind: str
    name: str
    statistic: str | None = None
    unit: str | None = None


@dataclass(frozen=True, slots=True)
class FactTextValue:
    """One **fact** read out of a snapshot, with everything a `TextFact` needs to prove it
    (Req 6.2, 6.3).

    The text-side counterpart of :class:`SnapshotValue`, and deliberately a much smaller
    shape: a fact has no window, no statistic, no estimator and no scale, because it answers
    *what is this resource* rather than *how much did it do*.

    **It declares no field admitting a quantity.** `value` is a `str` — a numeric fact's too,
    which reaches the snapshot as a fixed-precision decimal string (Req 4.6) — so a
    `FactTextValue` is not a second way a `Decimal` reaches the compile stage. That is what
    lets `compile/figures.BlockCursor.text_fact` mint a node with no number in it while the
    numeric factory keeps its own single entrance.

    `pointer` is the RFC 6901 pointer of this fact's own `value` field, recorded by the walk
    from the position it was found at, so provenance is an observation rather than a claim.
    """

    key: str
    value: str
    source: str
    collected_at: str
    pointer: str
    resource_id: str
    unit: str | None = None

    def __post_init__(self) -> None:
        # Req 6.11 — this is the `fact_source_missing` gate, and it is here rather than at
        # the `text_fact` factory on purpose: a fact with no provenance is unreadable at
        # construction, so there is no reachable path that carries one further. A second
        # check downstream could only fire against a `FactTextValue` built around this
        # constructor, which is a state no production code can produce.
        #
        # The message names the finding type, the resource and the key, because the field
        # that is missing is rarely the one the operator needs to find the entry by.
        for name in ("key", "value", "source", "collected_at", "pointer", "resource_id"):
            if not getattr(self, name):
                raise CompileFailedError(
                    f"fact_source_missing — a fact carries no {name}: resource "
                    f"{self.resource_id!r}, key {self.key!r}, read at {self.pointer!r}; "
                    f"every field a `TextFact` proves itself with is present or the fact "
                    f"is not readable"
                )
        if not (self.pointer.endswith("/value") or self.pointer.endswith("/collected_at")):
            raise CompileFailedError(
                f"a fact's pointer must address its own `value` or `collected_at` field, "
                f"got {self.pointer!r}; a pointer naming the fact object would resolve to "
                f"a mapping rather than to the string the document prints"
            )


@dataclass(frozen=True, slots=True)
class SnapshotValue:
    """One quantity read out of a snapshot, with everything a figure needs to prove it.

    `pointer` is the RFC 6901 JSON Pointer of this value's own `value` field (or of the
    `sku` capacity field, for a capacity), recorded by the walk from the position it
    found the value at. `__post_init__` refuses a pointer that is not a valid RFC 6901
    pointer whose last token is the field the value came from, so a hand-written
    provenance is caught at construction rather than at verification.

    `scale` is the fractional-digit count of the stored string — what the collector
    serialized at — not the scale a renderer will format at.

    `estimated` is `True` only for a value the snapshot marked as an estimate (every
    percentile), `False` when the snapshot said so explicitly, and `None` when the
    field was absent, which is how the collector spells "this direction is exact".
    Three states, because "absent" and "false" are the same fact here and both differ
    from `True`, and flattening `None` to `False` would be asserting exactness the
    document did not claim.
    """

    value: Decimal
    unit: str
    statistic: str
    estimator: str
    fidelity_tier: str
    scale: int
    metric: str
    resource_id: str
    window: str
    pointer: str
    estimated: bool | None = None
    derived_from: tuple[DerivedSource, ...] = field(default_factory=tuple)
    formula: str | None = None
    instance: str | None = None
    """The volume a per-instance guest counter's value belongs to (Req 31.4) — `"C:"`,
    never `"_Total"`. `None` for every platform metric, which has no instance
    dimension. Carried because the snapshot sorts a resource's statistics by
    `(metric, statistic, instance)`, so two values can legitimately share a
    `(metric, statistic)` pair and a lookup that ignored the instance would return
    one of them arbitrarily."""
    label: str | None = None
    """The snapshot's own pre-formatted label, retained for reference and
    **deliberately not consumed by the renderer**. It already embeds a numeral at the
    collector's scale and separators, so putting it inside a `formatted` string would
    place a second formatter's output where the verifier performs an exact match.
    `compile/estimators.py` composes the estimator label the document uses from
    `estimator` and `statistic` instead (Req 18.10)."""
    observation: str | None = None
    note: str | None = None
    counter_scope: str | None = None
    interval: str | None = None
    sample_count: int | None = None

    def __post_init__(self) -> None:
        tokens = _split_pointer(self.pointer)
        if tokens is None or not tokens:
            raise CompileFailedError(
                f"a snapshot value's pointer must be a non-empty RFC 6901 JSON "
                f"Pointer, got {self.pointer!r}"
            )
        if tokens[-1] not in _VALUE_BEARING_TOKENS:
            raise CompileFailedError(
                f"a snapshot value's pointer must address the field the value was read "
                f"from — one of {sorted(_VALUE_BEARING_TOKENS)} — got {self.pointer!r}"
            )

    @property
    def is_estimate(self) -> bool:
        """Whether the snapshot marked this value as an estimate. `None` means the
        document made no claim, which the collector uses for an exact direction."""
        return self.estimated is True


_VALUE_BEARING_TOKENS: Final[frozenset[str]] = frozenset(
    {"value", CARDINALITY_TOKEN, *(capability for capability, _ in SKU_CAPABILITIES)}
)
"""The last pointer token a `SnapshotValue` may carry: `value` for a statistic, the `sku`
capacity field for a capacity, or `count` for a derived cardinality."""


# --- the resource -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SkuView:
    """One resource's SKU capacity as the snapshot recorded it (Req 35.3).

    Both counts are `None` when the SKU or that capability could not be resolved. The
    snapshot omits the field rather than carrying a zero that would read as a
    measurement, and this view preserves that distinction: a `capacity_vs_usage` block
    over a resource with no resolvable capacity emits no capacity figure, which is a
    different document from one emitting `0`.
    """

    name: str
    vcpus_available: Decimal | None = None
    memory_bytes: Decimal | None = None


@dataclass(frozen=True, slots=True)
class ResourceView:
    """One resource in the snapshot, as `compile/scope.py` and the blocks see it.

    `index` is its position in the snapshot's `resources` array — the array the
    Snapshot_Builder sorted by resource id — and is what every pointer into this
    resource is built from. `tags` is a `MappingProxyType`, not a `dict`: a frozen
    dataclass blocks assignment *through the dataclass*, and would happily hand a
    caller a mutable dict to edit in place, which is precisely the kind of shared-state
    edit that makes two compiles of one snapshot differ.
    """

    index: int
    resource_id: str
    name: str
    resource_type: str
    location: str
    resource_group: str
    tags: Mapping[str, str]
    power_state_raw: str
    power_state: str
    fidelity_tier: str
    sku: SkuView

    @property
    def pointer_prefix(self) -> str:
        """This resource's own RFC 6901 pointer, `/resources/<index>`."""
        return pointer("resources", self.index)


@dataclass(frozen=True, slots=True)
class GapEntry:
    """One `collection_log` entry, as `gaps_and_coverage` renders it.

    A gap is information, not an error state: it is emitted **as recorded**, never as
    an absence of data and never zero-filled (Req 16.3, 29.3).
    """

    index: int
    gap_type: str
    resource_id: str
    metric: str | None
    message: str


@dataclass(frozen=True, slots=True)
class WindowView:
    """The run's collection window: local dates and the UTC instants they resolved to.

    Half-open on the UTC side (Req 25.7) — `end_utc` is midnight of the local day
    *after* `end`, and is excluded — while `start` and `end` are both **inclusive**
    local dates. Two conventions in one object because that is what the snapshot
    carries, and collapsing them would misstate one of them.
    """

    start: str
    end: str
    start_utc: str
    end_utc: str

    @property
    def descriptor(self) -> str:
        """`2026-07-01/2026-07-31` — the stable string a window-scoped figure carries
        as its `window`. A day-scoped figure carries the local day itself instead."""
        return f"{self.start}/{self.end}"


@dataclass(frozen=True, slots=True)
class RequestedScope:
    """The run's requested scope as the snapshot recorded it (Req 35.9) — the **union**
    of the template default and every block override, resolved once.

    Read by `appendix_methodology` and by the coverage pass. It knows nothing about
    blocks, which is what keeps replay clean: replay re-runs `compile/` over the same
    snapshot and must produce a bit-identical ledger.
    """

    subscription_id: str
    resource_types: tuple[str, ...]
    resource_groups: tuple[str, ...]
    tag_filters: Mapping[str, str]
    metrics_by_resource_type: Mapping[str, tuple[str, ...]]


class CountKind(StrEnum):
    """What :meth:`SnapshotView.count` counts."""

    RESOURCES = "resources"
    GAPS = "gaps"
    STATISTICS = "statistics"
    DAY_BUCKETS = "day_buckets"


# --- the resolver protocol ----------------------------------------------------------


@runtime_checkable
class SnapshotResolver(Protocol):
    """What `compile/ast.py` needs of a snapshot to re-resolve a declared provenance.

    A `Protocol` rather than the concrete class, so `Figure`'s re-resolution check can
    be exercised against a view that deliberately resolves a pointer to nothing, or to
    two values — neither of which a real :class:`SnapshotView` can produce, since it
    refuses a duplicate pointer at build time. A rule that cannot be tested for
    failure is a rule nobody has seen work.
    """

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        """Every value the pointer addresses. Exactly one for a well-formed pointer
        into a well-formed snapshot; `()` for a pointer that addresses nothing."""
        ...

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        """Every **text** value the pointer addresses — a fact's `value` (Req 6.2).

        A second method rather than a widened return from :meth:`resolve_all`, and the
        separation is the whole point. `resolve_all` returns `SnapshotValue`s carrying a
        `Decimal`, and `Figure._assert_provenance_resolves` compares against
        `f"{value:f}"`; a text fact has no `Decimal` and never will, so folding the two
        together would mean one of them returning a union that every caller then has to
        narrow — and the narrowing decision would be made from the value's characters,
        which is exactly the inference Req 4.11 exists to forbid one layer down.

        Two methods means `TextFact` re-resolves against the text side and `Figure`
        against the numeric side, and neither can accidentally address the other's
        values: a `snapshot_path` naming a statistic resolves to nothing here, and one
        naming a fact resolves to nothing there.
        """
        ...


# --- the view -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SnapshotView:
    """One immutable snapshot, indexed for the compile stage.

    Build with :func:`build_snapshot_view`. Frozen, and every container inside it is a
    `tuple` or a `MappingProxyType`, so there is nowhere for a caller to reach past the
    frozen `__setattr__` and mutate — the same reasoning `catalog/loader.py` applies to
    a loaded catalog, and for the same reason: a snapshot a compile pass could rewrite
    mid-run is a snapshot whose digest means nothing.
    """

    snapshot_id: str
    schema_version: str
    run_id: str
    subscription_id: str
    scope_verified: bool
    collected_at: str
    timezone: str
    utc_offset: str
    grain: str
    window: WindowView
    requested_scope: RequestedScope
    raw_archive_complete: bool
    raw_archive_object_count: int
    resources: tuple[ResourceView, ...]
    gaps: tuple[GapEntry, ...]
    day_names: tuple[str, ...]
    _by_pointer: Mapping[str, SnapshotValue]
    _window_stats: Mapping[tuple[str, str, str, str], SnapshotValue]
    _sample_counts: Mapping[tuple[str, str, str, str], SnapshotValue]
    _day_stats: Mapping[tuple[str, str, str, str, str], SnapshotValue]
    _tier_counts: Mapping[str, int]
    _statistic_count: int
    _day_bucket_count: int
    _facts_by_pointer: Mapping[str, FactTextValue] = field(default_factory=dict)
    """Every **fact** the snapshot carries, keyed by the JSON pointer of its `value`
    (Req 6.2).

    A second index rather than a widened `_by_pointer`, for the reason
    `SnapshotResolver.resolve_text_all` gives: the numeric side carries `Decimal`s and the
    text side does not, and a single index would force every caller to narrow a union by
    inspecting the value — the inference Req 4.11 forbids.

    **One** index rather than two, though. It holds the whole :class:`FactTextValue` and
    :meth:`resolve_text_all` reads `.value` off it, because an index of bare strings beside
    an index of records would be two structures over one array — and the provenance a
    `TextFact` carries would then come from a different lookup than the value it re-resolves
    against.

    Defaulted so every existing `SnapshotView` construction site is unchanged; the real
    builder always fills it."""

    # --- lookups ---

    def resource(self, resource_id: str) -> ResourceView | None:
        """One resource by id, or `None`. Exact comparison: a snapshot resource id is
        the id Azure returned, and the compile stage matches what the collector
        stored rather than re-normalizing it."""
        for candidate in self.resources:
            if candidate.resource_id == resource_id:
                return candidate
        return None

    def stat(
        self,
        resource_id: str,
        metric: str,
        statistic: str,
        *,
        instance: str | None = None,
    ) -> SnapshotValue | None:
        """One window-scoped value, or `None` when the snapshot holds none.

        **A miss returns `None` and raises nothing.** A metric a resource does not
        emit, a direction computed over zero samples, a deallocated VM — each is an
        ordinary, recorded fact (the gap is already in `collection_log`), and a block
        that meets one renders a resource row without that cell rather than failing the
        run. Raising here would turn a recorded gap into a terminal error, which is the
        opposite of what the gap vocabulary exists for.
        """
        return self._window_stats.get((resource_id, metric, statistic, instance or ""))

    def sample_count_of(
        self,
        resource_id: str,
        metric: str,
        statistic: str,
        *,
        instance: str | None = None,
    ) -> SnapshotValue | None:
        """How many samples one window statistic was computed over, as a value.

        Addressed by the same key as :meth:`stat` and returned as a `SnapshotValue` rather
        than an `int`, so a block can mint it as a **figure**: a sample count printed as
        text would be a numeral the verifier finds in the document and cannot match.

        `None` when the statistic is absent, or present but declaring no sample count.
        """
        return self._sample_counts.get((resource_id, metric, statistic, instance or ""))

    def day_stat(
        self,
        resource_id: str,
        metric: str,
        statistic: str,
        local_day: str,
        *,
        instance: str | None = None,
    ) -> SnapshotValue | None:
        """One day-scoped value, or `None`. Same miss semantics as :meth:`stat`."""
        return self._day_stats.get(
            (resource_id, local_day, metric, statistic, instance or "")
        )

    def day_series(
        self,
        resource_id: str,
        metric: str,
        statistic: str,
        *,
        instance: str | None = None,
    ) -> tuple[tuple[str, SnapshotValue], ...]:
        """Every day this resource has a value for, in ascending local-day order.

        Ordered from :attr:`day_names`, which the walk collected from the snapshot's
        own day-bucket order, so a chart's x axis is the order the Snapshot_Builder
        produced rather than one this module invented. Days with no value are
        **omitted** rather than zero-filled: a missing day is a gap, and a zero would
        read as a measured idle day.
        """
        found: list[tuple[str, SnapshotValue]] = []
        for local_day in self.day_names:
            value = self.day_stat(
                resource_id, metric, statistic, local_day, instance=instance
            )
            if value is not None:
                found.append((local_day, value))
        return tuple(found)

    def sku_capacity(self, resource_id: str, capability: str) -> SnapshotValue | None:
        """A resource's SKU capacity as a value with its own pointer, or `None`.

        `capability` is `vcpus_available` or `memory_bytes`. This is what lets
        `capacity_vs_usage` emit a capacity as a **figure** rather than as a number the
        compiler happens to know: the returned value's pointer re-resolves against the
        snapshot exactly like a metric value's does.
        """
        return self.stat(
            resource_id, f"{SKU_METRIC_PREFIX}{capability}", SKU_CAPACITY_STATISTIC
        )

    def cardinality(self, *tokens: str) -> SnapshotValue | None:
        """A derived cardinality as a value with its own re-resolvable pointer, or `None`.

        `view.cardinality("resources")` is the resource count;
        `view.cardinality("fidelity_tier", "baseline")` the per-tier count;
        `view.cardinality("gaps", "by_type", "metric_not_emitted")` one gap group's.

        This is how a count becomes a **figure** rather than a text node — see
        :data:`CARDINALITY_NAMESPACE` for why the document format forces the question and
        what makes the answer honest.
        """
        return self._by_pointer.get(
            pointer(CARDINALITY_NAMESPACE, *tokens, CARDINALITY_TOKEN)
        )

    def count(self, kind: CountKind, *, fidelity_tier: str | None = None) -> int:
        """A count from the snapshot: resources, gaps, statistics or day buckets.

        `fidelity_tier` narrows a resource count to one tier and is rejected for every
        other kind — a "gap count for the enhanced tier" is not a quantity the snapshot
        defines, and answering it with the unfiltered count would be worse than
        refusing.
        """
        if fidelity_tier is not None and kind is not CountKind.RESOURCES:
            raise ValueError(
                f"fidelity_tier narrows {CountKind.RESOURCES.value!r} only, not "
                f"{kind.value!r}"
            )
        match kind:
            case CountKind.RESOURCES:
                if fidelity_tier is None:
                    return len(self.resources)
                return self._tier_counts.get(fidelity_tier, 0)
            case CountKind.GAPS:
                return len(self.gaps)
            case CountKind.STATISTICS:
                return self._statistic_count
            case CountKind.DAY_BUCKETS:
                return self._day_bucket_count

    def tier_counts(self) -> Mapping[str, int]:
        """Resource counts per `fidelity_tier`, ordered by tier name.

        A mapping rather than two named accessors, because the tier vocabulary is the
        snapshot's to declare: `verification_record` emits "the per-`fidelity_tier`
        counts" (Req 16.4), and a hardcoded baseline/enhanced pair would silently omit
        a third tier the day one exists.
        """
        return self._tier_counts

    def gaps_by_type(self) -> tuple[tuple[str, tuple[GapEntry, ...]], ...]:
        """Gaps grouped by `gap_type` ascending in code-point order, and within each
        group by resource id ascending (Req 16.3).

        The order is produced here rather than inherited, for the same reason the
        snapshot produces its own array orders: a group order that depended on the
        order responses arrived in would make one snapshot compile to two documents.
        """
        grouped: dict[str, list[GapEntry]] = {}
        for gap in self.gaps:
            grouped.setdefault(gap.gap_type, []).append(gap)
        return tuple(
            (
                gap_type,
                tuple(sorted(grouped[gap_type], key=lambda entry: entry.resource_id)),
            )
            for gap_type in sorted(grouped)
        )

    def values(self) -> tuple[SnapshotValue, ...]:
        """Every indexed value, in pointer order. The coverage pass reads this."""
        return tuple(self._by_pointer[key] for key in sorted(self._by_pointer))

    # --- re-resolution (the SnapshotResolver protocol) ---

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        """Every value `raw_pointer` addresses — exactly one, or none.

        A real view can never return two: :func:`build_snapshot_view` refuses a
        duplicate pointer at build time, because two values at one address would make
        the figure ledger's provenance ambiguous. The tuple return exists so
        `compile/ast.py` can *assert* exactly one against a `SnapshotResolver` that
        does return two, which is how that rule gets tested for failure.
        """
        found = self._by_pointer.get(raw_pointer)
        return () if found is None else (found,)

    def resolve(self, raw_pointer: str) -> SnapshotValue | None:
        """The single value `raw_pointer` addresses, or `None` if it is not exactly
        one."""
        found = self.resolve_all(raw_pointer)
        return found[0] if len(found) == 1 else None

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        """Every text value `raw_pointer` addresses — exactly one, or none.

        The text-side twin of :meth:`resolve_all`, with the same tuple return for the same
        reason: `compile/ast.py` asserts *exactly one* against a resolver that can return
        two, which is how that rule gets tested for failure. A real view can never return
        two — :func:`build_snapshot_view` refuses a duplicate pointer.

        A pointer naming a **statistic** resolves to nothing here, and one naming a **fact**
        resolves to nothing in `resolve_all`. That mutual exclusion is what makes a
        `TextFact` unable to claim a numeric provenance and a `Figure` unable to claim a
        textual one.
        """
        found = self._facts_by_pointer.get(raw_pointer)
        return () if found is None else (found.value,)

    def facts_for(self, resource_id: str) -> tuple[FactTextValue, ...]:
        """Every fact one resource carries, in the snapshot's own `key` order.

        The only way a caller obtains a :class:`FactTextValue`, and therefore the only way
        one reaches `compile/figures.BlockCursor.text_fact` — the same shape the numeric side
        keeps, where a `SnapshotValue` exists solely as the output of this walk. A block
        compiler cannot assemble one from a template's configuration.

        Exact comparison on the resource id, matching :meth:`resource`: a snapshot resource
        id is the id Azure returned, and re-normalizing it here would be a second reading of
        the same string.

        Returns only **primary** fact entries (pointer ending in `/value`), not the derived
        `collected_at` entries also indexed for provenance re-resolution.
        """
        return tuple(
            fact
            for fact in self._facts_by_pointer.values()
            if fact.resource_id == resource_id and fact.pointer.endswith("/value")
        )


# --- the walk -----------------------------------------------------------------------


def build_snapshot_view(document: Mapping[str, object]) -> SnapshotView:
    """Index one snapshot document in a single walk (Req 15.5, 16.4).

    Every value's `pointer` is computed from the position the walk is standing at, so
    provenance is a fact about where the value was found rather than a claim a caller
    made. Raises `COMPILE_FAILED` naming the pointer for a document this reader cannot
    read: a missing required field, a value that is not a decimal string, or two values
    at one pointer.
    """
    snapshot_id = _require_str(document, "snapshot_id")
    resources_raw = _require_list(document, "resources")
    gaps_raw = _require_list(document, "gaps")
    window = _build_window(document)

    by_pointer: dict[str, SnapshotValue] = {}
    facts_by_pointer: dict[str, FactTextValue] = {}
    window_stats: dict[tuple[str, str, str, str], SnapshotValue] = {}
    sample_counts: dict[tuple[str, str, str, str], SnapshotValue] = {}
    day_stats: dict[tuple[str, str, str, str, str], SnapshotValue] = {}
    tier_counts: dict[str, int] = {}
    day_names: list[str] = []
    seen_days: set[str] = set()
    resources: list[ResourceView] = []
    statistic_count = 0
    day_bucket_count = 0

    for index, raw_resource in enumerate(resources_raw):
        at = pointer("resources", index)
        if not isinstance(raw_resource, dict):
            raise CompileFailedError(f"{at} is not an object")

        resource = _build_resource(raw_resource, index, at)
        resources.append(resource)
        tier_counts[resource.fidelity_tier] = tier_counts.get(resource.fidelity_tier, 0) + 1

        for value in _sku_values(resource, raw_resource, at, window.descriptor):
            _record(by_pointer, value)
            window_stats[_window_key(value)] = value

        for position, raw_fact in enumerate(_list_at(raw_resource, "facts", at)):
            fact_at = pointer("resources", index, "facts", position, "value")
            if not isinstance(raw_fact, dict):
                raise CompileFailedError(f"{fact_at} is not an object")
            fact_value = raw_fact.get("value")
            if not isinstance(fact_value, str) or not fact_value:
                raise CompileFailedError(
                    f"{fact_at} is not a non-empty string; a fact's value is always a "
                    f"string, including a numeric fact's (Req 4.6)"
                )
            # No duplicate-pointer check here, deliberately, unlike `_record` on the numeric
            # side: this pointer is built from `enumerate`'s own position, so two facts cannot
            # share one within a resource and a guard against it would be a branch no test can
            # reach. What *can* collide is two facts sharing a **key**, and that is refused one
            # layer up by `build_snapshot._assert_facts_are_collectable`, where the resource id
            # is in scope to name.
            facts_by_pointer[fact_at] = FactTextValue(
                key=_require_str(raw_fact, "key", fact_at),
                value=fact_value,
                source=_require_str(raw_fact, "source", fact_at),
                collected_at=_require_str(raw_fact, "collected_at", fact_at),
                pointer=fact_at,
                resource_id=resource.resource_id,
                unit=raw_fact.get("unit") if isinstance(raw_fact.get("unit"), str) else None,
            )

            # Index the `collected_at` field as a second text value at its own pointer,
            # so `resolve_text_all` can prove the provenance of a fact's timestamp when
            # it appears in a `<key>.observed_at` column (Req 12.6).
            collected_at_pointer = pointer("resources", index, "facts", position, "collected_at")
            collected_at_str = _require_str(raw_fact, "collected_at", collected_at_pointer)
            facts_by_pointer[collected_at_pointer] = FactTextValue(
                key=f"{_require_str(raw_fact, 'key', fact_at)}.observed_at",
                value=collected_at_str,
                source=_require_str(raw_fact, "source", fact_at),
                collected_at=collected_at_str,
                pointer=collected_at_pointer,
                resource_id=resource.resource_id,
                unit=None,
            )

        for position, raw_stat in enumerate(_list_at(raw_resource, "statistics", at)):
            value = _build_value(
                raw_stat,
                at=pointer("resources", index, "statistics", position, "value"),
                resource_id=resource.resource_id,
                window=window.descriptor,
            )
            _record(by_pointer, value)
            window_stats[_window_key(value)] = value
            statistic_count += 1

            # The statistic's own sample count, as a figure.
            #
            # A document reporting "0.18% average CPU" without saying how many samples
            # that average is over reports a number whose weight the reader cannot judge:
            # 89 231 samples and 3 read identically otherwise.
            #
            # It goes in the **cardinality namespace**, not at its own JSON position.
            # `/resources/6/statistics/3/sample_count` is where the field lives, but every
            # pointer outside `$counts` is required to resolve to a stored *decimal string*
            # — the invariant that makes a measurement's provenance checkable — and a
            # sample count is stored as a JSON integer. It is a count of the snapshot's own
            # records, which is precisely what `$counts` was reserved for, so it is
            # registered there and its `formula` names the samples it counted.
            #
            # Indexed apart from `window_stats`: it shares that dict's key — one resource,
            # metric and statistic — and recording it there would overwrite the
            # measurement with its own sample count.
            if value.sample_count is not None:
                sample_value = _cardinality_value(
                    ("resources", str(index), "statistics", str(position), "samples"),
                    value.sample_count,
                    window.descriptor,
                )
                _record(by_pointer, sample_value)
                sample_counts[_window_key(value)] = sample_value

        for bucket_position, raw_bucket in enumerate(
            _list_at(raw_resource, "day_buckets", at)
        ):
            bucket_at = pointer("resources", index, "day_buckets", bucket_position)
            if not isinstance(raw_bucket, dict):
                raise CompileFailedError(f"{bucket_at} is not an object")
            local_day = _require_str(raw_bucket, "local_day", bucket_at)
            day_bucket_count += 1
            if local_day not in seen_days:
                seen_days.add(local_day)
                day_names.append(local_day)

            for position, raw_stat in enumerate(
                _list_at(raw_bucket, "statistics", bucket_at)
            ):
                value = _build_value(
                    raw_stat,
                    at=pointer(
                        "resources",
                        index,
                        "day_buckets",
                        bucket_position,
                        "statistics",
                        position,
                        "value",
                    ),
                    resource_id=resource.resource_id,
                    window=local_day,
                )
                _record(by_pointer, value)
                day_stats[
                    (
                        value.resource_id,
                        local_day,
                        value.metric,
                        value.statistic,
                        value.instance or "",
                    )
                ] = value
                statistic_count += 1

    gaps = tuple(
        _build_gap(raw_gap, position, pointer("gaps", position))
        for position, raw_gap in enumerate(gaps_raw)
    )

    # Derived cardinalities, so `verification_record` and `gaps_and_coverage` can emit
    # their counts as figures rather than as text nodes the verifier would find and be
    # unable to match. See CARDINALITY_NAMESPACE.
    gap_type_counts: dict[str, int] = {}
    for gap in gaps:
        gap_type_counts[gap.gap_type] = gap_type_counts.get(gap.gap_type, 0) + 1

    # The estate's own groupings, counted: how many resources each resource group,
    # region and resource type holds, and how many distinct values each dimension has.
    #
    # These exist for `inventory_summary`, which reports the estate *as* its groupings —
    # "five resource groups, this one holds 21" — rather than as a list of resources. A
    # count that reaches the page must be a figure or the verifier finds an unmatched
    # numeral, and the only honest way to make a count a figure is to derive it here,
    # from the snapshot, where a replay derives it identically.
    #
    # Empty-string keys are skipped rather than counted under `""`: a resource carrying
    # no resource group is a collection gap, already recorded as one, and inventing a
    # group named "" to hold it would put a row in the rollup that names nothing.
    group_counts: dict[str, int] = {}
    region_counts: dict[str, int] = {}
    type_counts: dict[str, int] = {}
    for resource in resources:
        for bucket, key in (
            (group_counts, resource.resource_group),
            (region_counts, resource.location),
            (type_counts, resource.resource_type),
        ):
            if key:
                bucket[key] = bucket.get(key, 0) + 1

    cardinalities: list[tuple[tuple[str, ...], int]] = [
        (("resources",), len(resources)),
        (("gaps",), len(gaps)),
        (("statistics",), statistic_count),
        (("day_buckets",), day_bucket_count),
        (("raw_archive", "objects"), _raw_archive_count(document)),
        (("resource_group",), len(group_counts)),
        (("location",), len(region_counts)),
        (("resource_type",), len(type_counts)),
        *(
            (("fidelity_tier", tier), tier_count)
            for tier, tier_count in sorted(tier_counts.items())
        ),
        *(
            (("gaps", "by_type", gap_type), gap_type_count)
            for gap_type, gap_type_count in sorted(gap_type_counts.items())
        ),
        *(
            (("resource_group", "by_name", name), total)
            for name, total in sorted(group_counts.items())
        ),
        *(
            (("location", "by_name", name), total)
            for name, total in sorted(region_counts.items())
        ),
        *(
            (("resource_type", "by_name", name), total)
            for name, total in sorted(type_counts.items())
        ),
    ]
    for tokens, total in cardinalities:
        _record(by_pointer, _cardinality_value(tokens, total, window.descriptor))

    return SnapshotView(
        snapshot_id=snapshot_id,
        schema_version=_optional_str(document, "schema_version") or "",
        run_id=_require_str(document, "run_id"),
        subscription_id=_require_str(document, "subscription_id"),
        scope_verified=bool(document.get("scope_verified")),
        collected_at=_require_str(document, "collected_at"),
        timezone=_require_str(document, "timezone"),
        utc_offset=_require_str(document, "utc_offset"),
        grain=_require_str(document, "grain"),
        window=window,
        requested_scope=_build_requested_scope(document),
        raw_archive_complete=_raw_archive_flag(document),
        raw_archive_object_count=_raw_archive_count(document),
        resources=tuple(resources),
        gaps=gaps,
        day_names=tuple(sorted(day_names)),
        _by_pointer=MappingProxyType(by_pointer),
        _facts_by_pointer=MappingProxyType(facts_by_pointer),
        _window_stats=MappingProxyType(window_stats),
        _sample_counts=MappingProxyType(sample_counts),
        _day_stats=MappingProxyType(day_stats),
        _tier_counts=MappingProxyType(dict(sorted(tier_counts.items()))),
        _statistic_count=statistic_count,
        _day_bucket_count=day_bucket_count,
    )


def _record(by_pointer: dict[str, SnapshotValue], value: SnapshotValue) -> None:
    """Index one value, refusing a second value at one pointer.

    Two values at one address would make a figure's declared provenance ambiguous —
    `resolve` could not say which value a `snapshot_path` meant — so this is a build
    failure rather than a last-write-wins.
    """
    if value.pointer in by_pointer:
        raise CompileFailedError(
            f"{value.pointer} addresses two values; a snapshot pointer addresses "
            f"exactly one position, so a figure's provenance would be ambiguous"
        )
    by_pointer[value.pointer] = value


def _cardinality_value(
    tokens: tuple[str, ...], total: int, window: str
) -> SnapshotValue:
    """One derived cardinality, carrying the derivation that makes it auditable.

    `formula` names the collection counted and `derived_from` records it as a snapshot
    collection, so a reader of the ledger can tell a count of the snapshot's own records
    from a measurement — which is exactly the distinction a bare `12` in a document would
    lose.

    Scale 0 and unit `count`: a cardinality has no fractional part, and the display scale
    is `max(template decimal places, 0)`, so a template asking for two decimal places shows
    `200.00` resources. That is the catalog-scale-as-a-floor rule applying uniformly rather
    than a special case carved out here, and a template that finds it odd can ask for zero.
    """
    address = pointer(CARDINALITY_NAMESPACE, *tokens, CARDINALITY_TOKEN)
    collection = pointer(*tokens)
    return SnapshotValue(
        value=Decimal(total),
        unit="count",
        statistic=CARDINALITY_STATISTIC,
        estimator=CARDINALITY_ESTIMATOR,
        fidelity_tier="",
        scale=0,
        metric=f"count({collection})",
        resource_id="",
        window=window,
        pointer=address,
        formula=f"count({collection})",
        derived_from=(
            DerivedSource(kind=CARDINALITY_SOURCE_KIND, name=collection, unit="count"),
        ),
    )


def _window_key(value: SnapshotValue) -> tuple[str, str, str, str]:
    return (value.resource_id, value.metric, value.statistic, value.instance or "")


def _build_value(
    raw: object, *, at: str, resource_id: str, window: str
) -> SnapshotValue:
    if not isinstance(raw, dict):
        raise CompileFailedError(f"{at} is not inside a statistic object")

    holder = at.rsplit("/", 1)[0]
    raw_value = raw.get("value")
    parsed = parse_decimal_string(raw_value, at)
    assert isinstance(raw_value, str)  # narrowed by parse_decimal_string

    return SnapshotValue(
        value=parsed,
        unit=_require_str(raw, "unit", holder),
        statistic=_require_str(raw, "statistic", holder),
        estimator=_require_str(raw, "estimator", holder),
        fidelity_tier=_require_str(raw, "fidelity_tier", holder),
        scale=_scale_of(raw_value),
        metric=_require_str(raw, "metric", holder),
        resource_id=resource_id,
        window=window,
        pointer=at,
        estimated=_optional_bool(raw, "estimated"),
        derived_from=_build_derived_from(raw.get("derived_from"), holder),
        formula=_optional_str(raw, "formula"),
        instance=_optional_str(raw, "instance"),
        label=_optional_str(raw, "label"),
        observation=_optional_str(raw, "observation"),
        note=_optional_str(raw, "note"),
        counter_scope=_optional_str(raw, "counter_scope"),
        interval=_optional_str(raw, "interval"),
        sample_count=_optional_int(raw, "sample_count"),
    )


def _sku_values(
    resource: ResourceView, raw_resource: Mapping[str, object], at: str, window: str
) -> Iterable[SnapshotValue]:
    """The resource's SKU capacities as values, each pointing at its own field.

    A capability the snapshot omitted yields nothing — the `sku_unknown` /
    `sku_capability_missing` gap is already recorded, and emitting a zero here would
    turn "we could not resolve the SKU" into "this machine has no memory".
    """
    raw_sku = raw_resource.get("sku")
    if not isinstance(raw_sku, dict):
        return

    for capability, unit in SKU_CAPABILITIES:
        raw_value = raw_sku.get(capability)
        if raw_value is None:
            continue
        field_at = f"{at}/sku/{capability}"
        parsed = parse_decimal_string(raw_value, field_at)
        assert isinstance(raw_value, str)  # narrowed by parse_decimal_string
        yield SnapshotValue(
            value=parsed,
            unit=unit,
            statistic=SKU_CAPACITY_STATISTIC,
            estimator=SKU_CAPACITY_ESTIMATOR,
            fidelity_tier=resource.fidelity_tier,
            scale=_scale_of(raw_value),
            metric=f"{SKU_METRIC_PREFIX}{capability}",
            resource_id=resource.resource_id,
            window=window,
            pointer=field_at,
        )


def _build_resource(raw: Mapping[str, object], index: int, at: str) -> ResourceView:
    raw_sku = raw.get("sku")
    sku_at = f"{at}/sku"
    if not isinstance(raw_sku, dict):
        raise CompileFailedError(f"{sku_at} is missing or is not an object")

    raw_tags = raw.get("tags")
    if raw_tags is None:
        tags: dict[str, str] = {}
    elif isinstance(raw_tags, dict) and all(
        isinstance(key, str) and isinstance(value, str) for key, value in raw_tags.items()
    ):
        tags = dict(raw_tags)
    else:
        raise CompileFailedError(f"{at}/tags must be a string-to-string object")

    return ResourceView(
        index=index,
        resource_id=_require_str(raw, "resource_id", at),
        name=_require_str(raw, "name", at),
        resource_type=_require_str(raw, "resource_type", at),
        location=_require_str(raw, "location", at),
        resource_group=_require_str(raw, "resource_group", at),
        tags=MappingProxyType(tags),
        power_state_raw=_optional_str(raw, "power_state_raw") or "",
        power_state=_require_str(raw, "power_state", at),
        fidelity_tier=_require_str(raw, "fidelity_tier", at),
        sku=SkuView(
            name=_optional_str(raw_sku, "name") or "",
            vcpus_available=(
                parse_decimal_string(raw_sku["vcpus_available"], f"{sku_at}/vcpus_available")
                if raw_sku.get("vcpus_available") is not None
                else None
            ),
            memory_bytes=(
                parse_decimal_string(raw_sku["memory_bytes"], f"{sku_at}/memory_bytes")
                if raw_sku.get("memory_bytes") is not None
                else None
            ),
        ),
    )


def _build_gap(raw: object, index: int, at: str) -> GapEntry:
    if not isinstance(raw, dict):
        raise CompileFailedError(f"{at} is not an object")
    return GapEntry(
        index=index,
        gap_type=_require_str(raw, "gap_type", at),
        resource_id=_require_str(raw, "resource_id", at),
        metric=_optional_str(raw, "metric"),
        message=_optional_str(raw, "message") or "",
    )


def _build_window(document: Mapping[str, object]) -> WindowView:
    raw = document.get("window")
    if not isinstance(raw, dict):
        raise CompileFailedError("/window is missing or is not an object")
    return WindowView(
        start=_require_str(raw, "start", "/window"),
        end=_require_str(raw, "end", "/window"),
        start_utc=_require_str(raw, "start_utc", "/window"),
        end_utc=_require_str(raw, "end_utc", "/window"),
    )


def _build_requested_scope(document: Mapping[str, object]) -> RequestedScope:
    raw = document.get("requested_scope")
    if not isinstance(raw, dict):
        raise CompileFailedError("/requested_scope is missing or is not an object")

    raw_tags = raw.get("tag_filters")
    tag_filters = (
        dict(raw_tags)
        if isinstance(raw_tags, dict)
        and all(isinstance(k, str) and isinstance(v, str) for k, v in raw_tags.items())
        else {}
    )

    raw_metrics = raw.get("metrics_by_resource_type")
    metrics: dict[str, tuple[str, ...]] = {}
    if isinstance(raw_metrics, dict):
        for resource_type, names in raw_metrics.items():
            if isinstance(resource_type, str) and isinstance(names, list):
                metrics[resource_type] = tuple(
                    name for name in names if isinstance(name, str)
                )

    return RequestedScope(
        subscription_id=_require_str(document, "subscription_id"),
        resource_types=_string_tuple(raw.get("resource_types")),
        resource_groups=_string_tuple(raw.get("resource_groups")),
        tag_filters=MappingProxyType(tag_filters),
        metrics_by_resource_type=MappingProxyType(dict(sorted(metrics.items()))),
    )


def _raw_archive_flag(document: Mapping[str, object]) -> bool:
    raw = document.get("raw_archive")
    return bool(raw.get("complete")) if isinstance(raw, dict) else False


def _raw_archive_count(document: Mapping[str, object]) -> int:
    raw = document.get("raw_archive")
    if not isinstance(raw, dict):
        return 0
    count = raw.get("object_count")
    return count if isinstance(count, int) and not isinstance(count, bool) else 0


def _build_derived_from(raw: object, at: str) -> tuple[DerivedSource, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise CompileFailedError(f"{at}/derived_from must be an array")
    sources: list[DerivedSource] = []
    for position, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise CompileFailedError(f"{at}/derived_from/{position} is not an object")
        sources.append(
            DerivedSource(
                kind=_optional_str(entry, "kind") or "",
                name=_optional_str(entry, "name") or "",
                statistic=_optional_str(entry, "statistic"),
                unit=_optional_str(entry, "unit"),
            )
        )
    return tuple(sources)


# --- small readers ------------------------------------------------------------------


def _require_str(source: Mapping[str, object], key: str, at: str = "") -> str:
    value = source.get(key)
    if not isinstance(value, str) or not value:
        raise CompileFailedError(f"{at}/{key} is missing or is not a non-empty string")
    return value


def _optional_str(source: Mapping[str, object], key: str) -> str | None:
    value = source.get(key)
    return value if isinstance(value, str) else None


def _optional_bool(source: Mapping[str, object], key: str) -> bool | None:
    value = source.get(key)
    return value if isinstance(value, bool) else None


def _optional_int(source: Mapping[str, object], key: str) -> int | None:
    value = source.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _require_list(source: Mapping[str, object], key: str) -> Sequence[object]:
    value = source.get(key)
    if not isinstance(value, list):
        raise CompileFailedError(f"/{key} is missing or is not an array")
    return value


def _list_at(source: Mapping[str, object], key: str, at: str) -> Sequence[object]:
    value = source.get(key)
    if value is None:
        return ()
    if not isinstance(value, list):
        raise CompileFailedError(f"{at}/{key} must be an array")
    return value


def _string_tuple(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    return tuple(entry for entry in raw if isinstance(entry, str))
