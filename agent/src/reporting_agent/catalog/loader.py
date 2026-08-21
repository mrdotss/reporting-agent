"""The catalog loader: `metrics.v1.json` and `facts.v1.json` in, a frozen
`LoadedCatalog` out.

`catalog/metrics.v1.json` and `catalog/facts.v1.json` are data shipped in the image
(Req 32.8), and they are **one document in two files**: the metric half carries the
`catalog_version` for both, and the fact half is refused if it declares one of its own, so
there is no second version string that could be bumped independently and disagree. This
module is the only code that reads either, validates every entry against the schema
Req 32.3 declares, and
hands back an object that cannot be mutated — a field assignment, an item assignment on
one of its tuple fields, or an attempt to attach a new attribute all raise, the same
guarantee `config.py` gives `Config` (Req 14.12) and for the same reason: a catalog a run
could rewrite mid-collection is a catalog whose declared metric set cannot be trusted for
the run that started with it.

**Per-entry validation degrades a run; whole-catalog unusability ends one.** Those are two
different failure shapes and this module keeps them that way:

* A single metric, derived statistic, enhanced-tier counter or declared fact that fails
  validation is recorded as one :class:`InvalidEntry`, skipped, and emits no statistic
  (Req 32.4). No exception crosses an entry boundary (Req 32.5) — a bug in one catalog
  entry costs that entry, not the run.
* Zero valid metrics, derived statistics, enhanced counters **and facts** across **every**
  resource type the pair declares is a different fact: there is nothing left to collect
  anything with, and :func:`load_catalog` raises
  :class:`~reporting_agent.errors.CatalogUnusableError` rather than returning a catalog with
  nothing in it (Req 32.7). A malformed top-level shape — invalid JSON, a missing
  `catalog_version`, a `catalog_version` in the fact half, a `resource_types` that is not an
  object — is the same fact by a different route, so it raises the same way instead of
  surfacing a `JSONDecodeError` or a `KeyError` three frames into a caller that expected a
  `LoadedCatalog`.

**Req 32.7 says "for every resource type present in the run's scope."** This module has
no notion of a run's scope — it loads one file, once, before any run exists — so the
check implemented here is the whole-catalog case: every resource type the file declares
ends up with zero valid entries. `LoadedCatalog.for_resource_type` is what lets a later,
scope-aware caller (the collect pipeline) ask the narrower question — "does *this run's*
scope have anything usable?" — without this module having to know what a run is.

**Why the loaded catalog is tuples, not dicts.** A `dict` value on a frozen dataclass is
still a dict: `catalog.resource_types["x"]["metrics"] = []` would succeed, because framing
only blocks assignment through the dataclass's own attributes, not mutation of an object
one of those attributes happens to reference. Every field on every dataclass in this
module is therefore a `tuple` of frozen dataclasses, all the way down, so there is no
mutable container anywhere inside a `LoadedCatalog` for a caller to reach past the frozen
`__setattr__` and mutate anyway. Lookup by name is O(n) over a handful of resource types
and a handful of metrics per type — not a data structure this module needs a dict for.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

from reporting_agent.errors import CatalogUnusableError

__all__ = [
    "AGGREGATION_COUNT",
    "AGGREGATION_MAXIMUM",
    "AGGREGATION_MINIMUM",
    "AGGREGATION_TOTAL",
    "AVERAGE_AGGREGATIONS",
    "CATALOG_ENTRY_INVALID_GAP_TYPE",
    "DECLARED_ABSENT_GAP_TYPES",
    "DECLARED_AGGREGATIONS",
    "DECLARED_FACT_SOURCES",
    "DECLARED_FACT_UNITS",
    "DECLARED_FACT_VALUE_KINDS",
    "DECLARED_UNITS",
    "DECLARED_UNIT_FAMILIES",
    "DEFAULT_CATALOG_PATH",
    "DEFAULT_FACTS_PATH",
    "MAX_FACT_KEY_LENGTH",
    "MAX_SCALE",
    "MIN_FACT_KEY_LENGTH",
    "MIN_SCALE",
    "CatalogEntry",
    "DerivedEntry",
    "EnhancedCounterEntry",
    "FactDeclaration",
    "FactDeclarationEntry",
    "InvalidEntry",
    "LoadedCatalog",
    "MetricEntry",
    "ResourceTypeCatalog",
    "ResourceTypeFacts",
    "SourceBinding",
    "load_catalog",
]

# --- the declared schema (Req 32.3) -------------------------------------------------
#
# What "declared" means: a set this module owns, not a set inferred from whatever the
# shipped file happens to contain. A catalog entry naming a unit or a family outside
# these sets fails validation even if every other entry in the file agrees with it,
# because the whole point of a declared set is that the file cannot silently widen it.

DECLARED_UNITS: Final[frozenset[str]] = frozenset({"percent", "bytes", "count_per_second"})
DECLARED_UNIT_FAMILIES: Final[frozenset[str]] = frozenset({"percentage", "magnitude"})

# The four aggregation names, each once. Named constants rather than bare strings in the
# set below, because three other modules now branch on *which* aggregation a metric
# requested — `azure/metrics.py` builds the `aggregation` query parameter from it,
# `collect/accumulate.py` decides whether a missing `count` is malformed or simply not
# asked for, and `collect/snapshot.py` decides whether an average exists at all. A bare
# `"Count"` in each of those is four places for one string to be misspelled, and the
# failure mode is silent: an unrequested aggregation reads as an absent one.
AGGREGATION_TOTAL: Final[str] = "Total"
AGGREGATION_COUNT: Final[str] = "Count"
AGGREGATION_MINIMUM: Final[str] = "Minimum"
AGGREGATION_MAXIMUM: Final[str] = "Maximum"

DECLARED_AGGREGATIONS: Final[frozenset[str]] = frozenset(
    {AGGREGATION_TOTAL, AGGREGATION_COUNT, AGGREGATION_MINIMUM, AGGREGATION_MAXIMUM}
)

AVERAGE_AGGREGATIONS: Final[frozenset[str]] = frozenset(
    {AGGREGATION_TOTAL, AGGREGATION_COUNT}
)
"""The two a count-weighted average needs, together (Req 1.9).

An average here is the sum of totals over the sum of counts, so a metric requesting only
one of the two cannot produce one — and requesting neither is not an error, it is a metric
Azure does not serve those aggregations for. `Microsoft.Sql/servers/databases`'
`cpu_percent` supports `Average`, `Minimum` and `Maximum` and nothing else, so the honest
outcome for it is an exact minimum and maximum and **no** average, rather than a fabricated
one or a metric dropped from the catalog."""
DECLARED_SOURCE_KINDS: Final[frozenset[str]] = frozenset({"metric", "sku_capability"})

# --- the fact declaration's own vocabulary (Req 1.4, 1.7, 4.2, 4.11, 5.1-5.4) --------
#
# A fact answers *what is this resource*; a metric answers *how much did it do*. The two
# vocabularies are therefore separate sets rather than one shared one, and the most
# important of those separations is the unit.

DECLARED_FACT_UNITS: Final[frozenset[str]] = frozenset(
    {"bytes", "count", "percent", "days"}
)
"""The units a **numeric fact** may declare — deliberately **not** `DECLARED_UNITS`.

The two sets overlap on `bytes` and `percent` and diverge on purpose, because a metric's
unit does something a fact's unit never does: it selects the **sketch**
(`collect/sketch.py`'s `sketch_for_unit_family`), and a fact is never sketched. So
`count_per_second` is meaningless for a fact — nothing folds a fact into a distribution —
while `count` and `days` are exactly what a fact needs and are meaningless for a metric,
which is why `Count` and `Seconds` have no term in the metric mapping at all.

Sharing one set would force a fact like `backup_retention_days` to be declared in a unit
chosen for its effect on a sketch that does not exist."""

DECLARED_FACT_VALUE_KINDS: Final[frozenset[str]] = frozenset({"numeric", "text"})
"""Req 4.11. Read from the **declaration**, never inferred from the characters of a value.

The requirement states the reason and it is worth keeping in front of the code: `2022`
satisfies a decimal grammar and is an operating-system version, while `10.0.0.4` and
`10.0.0.0/16` fail it and are addresses. A router reading the characters formats a Windows
version with a grouping separator."""

DECLARED_FACT_SOURCES: Final[frozenset[str]] = frozenset(
    {"resource_graph", "arm", "recovery_services", "capacity"}
)
"""Req 4.2's four sources, recorded from the request that produced the fact rather than
derived from its key — so a fact's provenance is an observation about where it came from
and not a guess from what it is called."""

DECLARED_ABSENT_GAP_TYPES: Final[frozenset[str]] = frozenset(
    {"backup_not_configured", "no_reservations", "replication_not_enabled"}
)
"""The three gap types a **non-projectable** fact may name for its own absence (Req 5.1-5.3).

Mirrors three of `collect/log.py`'s four fact gap types **by value, not by import**, the
same non-coupling `collect/sketch.py` draws against this module's unit families: the
catalog is a document whose vocabulary this module owns, and `collect/log.py` imports
nothing from here.

`fact_unavailable` is deliberately absent. It is not a declarable absence — it means the
request *failed*, which no declaration can anticipate, and a fact declaring it as its
`absent_gap_type` would be claiming that failure is a configuration state."""

MIN_SCALE: Final[int] = 0
MAX_SCALE: Final[int] = 9

CATALOG_ENTRY_INVALID_GAP_TYPE: Final[str] = "catalog_entry_invalid"

DEFAULT_CATALOG_PATH: Final[Path] = Path(__file__).resolve().parent / "metrics.v1.json"
DEFAULT_FACTS_PATH: Final[Path] = Path(__file__).resolve().parent / "facts.v1.json"

_FACT_KEY_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[a-z][a-z0-9_]*$")
MIN_FACT_KEY_LENGTH: Final[int] = 1
MAX_FACT_KEY_LENGTH: Final[int] = 120

_IDENTIFIER_PATTERN: Final[re.Pattern[str]] = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

type SourceKind = Literal["metric", "sku_capability"]


# --- the frozen shapes ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class MetricEntry:
    """One validated platform metric (Req 32.1).

    `aggregations` and `percentiles` are tuples, never lists — see the module
    docstring for why that is load-bearing rather than a style preference.
    """

    resource_type: str
    name: str
    unit: str
    unit_family: str
    aggregations: tuple[str, ...]
    scale: int
    percentiles: tuple[str, ...] = ()
    label: str | None = None
    interval_scoped: bool = False


@dataclass(frozen=True, slots=True)
class SourceBinding:
    """One binding inside a derived statistic's `sources` list.

    `binds` is the identifier the formula string refers to; `for_statistic` is the
    direction inversion for a `kind == "metric"` source — the catalog fact that lets
    minimum available memory feed *maximum* memory-used-percent (Req 30.1). It is
    `None` for a `kind == "sku_capability"` source, which has no direction to invert.
    """

    kind: SourceKind
    name: str
    binds: str
    statistic: str | None = None
    for_statistic: str | None = None
    unit: str | None = None


@dataclass(frozen=True, slots=True)
class DerivedEntry:
    """One validated derived statistic (Req 32.1) — `memory_used_pct` today.

    `formula` is the fixed string emitted identically for every value of this
    statistic in every run (Req 30.3); every identifier it names resolves to some
    source's `binds` in `sources` (Req 32.3), which :func:`load_catalog` checks before
    this object is ever constructed.
    """

    resource_type: str
    statistic_id: str
    unit: str
    unit_family: str
    scale: int
    formula: str
    sources: tuple[SourceBinding, ...]
    observation: str | None = None
    note: str | None = None


@dataclass(frozen=True, slots=True)
class EnhancedCounterEntry:
    """One validated enhanced-tier counter (Req 32.1) — `LogicalDisk % Free Space`
    today. Requires Azure Monitor Agent, a Data Collection Rule and Log Analytics; the
    catalog only ever describes the counter, never collects it directly."""

    resource_type: str
    statistic_id: str
    object: str
    counter: str
    unit: str
    unit_family: str
    scale: int
    per_instance: bool = False


@dataclass(frozen=True, slots=True)
class FactDeclarationEntry:
    """One declared fact (Req 1.4, 1.7, 4.7, 5.9).

    `projection` and `absent_gap_type` are **mutually exclusive by construction**, and that
    is the whole shape of the declaration:

    * a **projectable** fact carries a `projection` — a Resource Graph expression appended to
      the inventory query, so it costs no additional request (Req 4.7);
    * a **non-projectable** fact carries an `absent_gap_type` — the gap to record when its
      own source answers successfully and names nothing for the resource (Req 5.1-5.3). A
      projectable fact needs none, because Resource Graph returning no value for a projected
      column is `fact_unavailable`, not a configuration state.

    `unit` is present for a `numeric` fact and `None` for a `text` one. A unit on a text fact
    would be a unit for `Succeeded`.
    """

    resource_type: str
    key: str
    value_kind: str
    source: str
    projectable: bool
    projection: str | None = None
    absent_gap_type: str | None = None
    unit: str | None = None


@dataclass(frozen=True, slots=True)
class ResourceTypeFacts:
    """One resource type's validated fact declarations.

    The fact-side counterpart of :class:`ResourceTypeCatalog`, and a separate frozen shape
    rather than a `dict` entry for the reason the module docstring gives: a mapping field on
    a frozen dataclass is still mutable through the mapping, so there would be a reachable
    `declaration.by_resource_type["x"] = ()` inside an object the loader promises is frozen.
    """

    resource_type: str
    facts: tuple[FactDeclarationEntry, ...]

    @property
    def has_valid_entries(self) -> bool:
        """Whether this resource type declares any usable fact at all."""
        return bool(self.facts)


@dataclass(frozen=True, slots=True)
class FactDeclaration:
    """Every declared fact, grouped by resource type (Req 1.7).

    A separate object from `LoadedCatalog.resource_types` rather than a field on
    `ResourceTypeCatalog`, because the two are loaded from two files and a resource type may
    legitimately appear in one and not the other — a type with metrics and no facts, or with
    facts and no metrics, is an ordinary declaration rather than an error.

    Defaults to declaring nothing so every existing `LoadedCatalog` construction site keeps
    working; a catalog loaded from the shipped pair of files always carries the real one.
    """

    resource_types: tuple[ResourceTypeFacts, ...] = ()

    def for_resource_type(self, resource_type: str) -> tuple[FactDeclarationEntry, ...]:
        """This type's declared facts, or `()`.

        **Matched case-insensitively**, exactly as `LoadedCatalog.for_resource_type` matches,
        and for the identical reason: Resource Graph lower-cases `type` in its response body,
        so an inventory row arrives as `microsoft.compute/virtualmachines` while this file
        declares `Microsoft.Compute/virtualMachines`. An exact comparison would find no fact
        for every real row, and the failure would present as a resource type with no facts
        rather than as a spelling mismatch.
        """
        folded = resource_type.casefold() if isinstance(resource_type, str) else ""
        for declared in self.resource_types:
            if declared.resource_type.casefold() == folded:
                return declared.facts
        return ()

    @property
    def entries(self) -> tuple[FactDeclarationEntry, ...]:
        """Every validated fact across every resource type, in file order."""
        return tuple(
            entry for declared in self.resource_types for entry in declared.facts
        )

    def projectable(
        self, resource_type: str | None = None
    ) -> tuple[tuple[str, str], ...]:
        """`(key, projection)` pairs for every projectable fact, **ordered by key**.

        Ordered here rather than at the call site so two runs over one declaration build a
        byte-identical Resource Graph query — `azure/clients.py` sorts again, and the two
        agreeing is cheaper than deciding which one owns the order.

        `resource_type` narrows to one type; `None` returns every projectable fact across
        every type, de-duplicated by `(key, projection)`. The union is what a caller building
        one query for a multi-type scope needs, and de-duplication matters because several
        types declare `sku_name` with the identical projection — emitting it twice would make
        the query name one column twice and Resource Graph reject it.
        """
        entries = (
            self.for_resource_type(resource_type)
            if resource_type is not None
            else self.entries
        )
        pairs = {
            (entry.key, entry.projection)
            for entry in entries
            if entry.projectable and entry.projection
        }
        return tuple(sorted(pairs))

    def by_source(self, source: str) -> tuple[FactDeclarationEntry, ...]:
        """Every declared fact whose `source` is `source`, in declaration order.

        What the fact collector iterates: one request per non-projectable source, covering
        every fact that source answers for, rather than one request per fact.
        """
        return tuple(entry for entry in self.entries if entry.source == source)

    @property
    def keys(self) -> frozenset[str]:
        """Every declared fact key across every type — for a guard asserting a gap names a
        key some type actually declares."""
        return frozenset(entry.key for entry in self.entries)

    @property
    def resource_type_names(self) -> tuple[str, ...]:
        """Every resource type the fact declaration covers, in file order."""
        return tuple(declared.resource_type for declared in self.resource_types)


type CatalogEntry = MetricEntry | DerivedEntry | EnhancedCounterEntry
"""Every validated entry kind, for callers that want to walk the catalog without
caring which kind they are looking at (`LoadedCatalog.entries`)."""


@dataclass(frozen=True, slots=True)
class InvalidEntry:
    """One entry that failed validation (Req 32.4).

    Shaped so a caller can build a `catalog_entry_invalid` gap from it without this
    module knowing what a `collection_log` entry looks like — `collect/log.py` (a
    later task in this same parent) owns that shape. `metric` is the entry's own name,
    statistic id or fact key when one could be read at all, and `None` when the entry
    was missing or unusable as a name (an empty name is exactly the case Req 32.3
    rejects, so `metric` is `None` rather than the empty string that failed validation).
    """

    resource_type: str
    metric: str | None
    message: str
    gap_type: str = CATALOG_ENTRY_INVALID_GAP_TYPE


@dataclass(frozen=True, slots=True)
class ResourceTypeCatalog:
    """One resource type's validated entries plus what its formulas may resolve
    against — its own declared metric names and its declared SKU capabilities."""

    resource_type: str
    metric_namespace: str
    sku_capabilities: tuple[str, ...]
    metrics: tuple[MetricEntry, ...]
    derived: tuple[DerivedEntry, ...]
    enhanced_counters: tuple[EnhancedCounterEntry, ...]

    @property
    def has_valid_entries(self) -> bool:
        """Whether this resource type has anything left to collect a statistic with,
        after validation. The whole-catalog `CATALOG_UNUSABLE` gate in
        :func:`load_catalog` is "every resource type answers `False` here."""
        return bool(self.metrics or self.derived or self.enhanced_counters)


@dataclass(frozen=True, slots=True)
class LoadedCatalog:
    """The validated, frozen result of one catalog load (Req 32.8).

    `entries` flattens every valid entry across every resource type and every kind, in
    file order, for a caller that wants to walk the whole catalog without caring which
    resource type or kind an entry belongs to. `resource_types` is the same
    information kept structured, for a caller — `collect/accumulate.py`,
    `collect/sketch.py`, later tasks — that needs one resource type's declarations.
    """

    catalog_version: str
    resource_types: tuple[ResourceTypeCatalog, ...]
    entries: tuple[CatalogEntry, ...]
    invalid_entries: tuple[InvalidEntry, ...] = ()
    facts: FactDeclaration = FactDeclaration()
    """The Fact_Declaration loaded alongside the metric catalog (Req 1.7, 32.8).

    A field on `LoadedCatalog` rather than a second object a caller loads separately,
    because the two files are **one document version**: `facts.v1.json` declares no
    `catalog_version` of its own precisely so there is no second version string that could
    disagree with this one, and the collect pipeline reaches facts through the same object
    it already reaches metrics through.

    Defaults to an empty declaration so a `LoadedCatalog` built directly in a test that
    cares only about metrics stays a two-line construction."""

    def for_resource_type(self, resource_type: str) -> ResourceTypeCatalog | None:
        """The validated entries for `resource_type`, or `None` if the catalog
        declares nothing for it. A linear scan over a handful of resource types —
        not a data structure this module needs a dict for.

        **Matched case-insensitively**, because Azure resource type names *are*
        case-insensitive and Resource Graph lowercases `type` in its response body: an
        inventory row arrives as `microsoft.compute/virtualmachines` while this catalog —
        and every other document in the product — declares
        `Microsoft.Compute/virtualMachines`. An exact comparison here would find nothing
        for every real inventory row, and the failure would present as a resource type
        with no metrics rather than as a spelling mismatch. Exact spelling remains the
        catalog's to declare: `ResourceTypeCatalog.resource_type` is returned as the file
        wrote it, so nothing downstream inherits Azure's casing from this lookup.
        """
        folded = resource_type.casefold() if isinstance(resource_type, str) else ""
        for entry in self.resource_types:
            if entry.resource_type.casefold() == folded:
                return entry
        return None

    @property
    def resource_type_names(self) -> tuple[str, ...]:
        """Every resource type the catalog declares, in file order."""
        return tuple(entry.resource_type for entry in self.resource_types)


# --- loading ---------------------------------------------------------------------


def load_catalog(
    path: Path | str | None = None, *, facts_path: Path | str | None = None
) -> LoadedCatalog:
    """Load, validate and freeze the Metric_Catalog at `path` (default:
    `catalog/metrics.v1.json`, shipped in the image) together with the Fact_Declaration
    at `facts_path` (default: `catalog/facts.v1.json`, shipped beside it).

    Raises :class:`~reporting_agent.errors.CatalogUnusableError` when either file cannot
    be read as the declared top-level shape at all, or when validation leaves zero valid
    entries **of any of the four kinds** for every resource type the pair declares
    (Req 32.7) — there is nothing an empty catalog could be used to collect. Every narrower
    failure — one bad metric, one bad derived statistic, one bad enhanced counter, one bad
    fact — is recorded in the returned catalog's `invalid_entries` instead of raising
    (Req 32.4, 32.5).

    **The two paths default together, and only together.** `load_catalog()` loads the
    shipped pair. `load_catalog(some_path)` loads `some_path` and declares **no** facts,
    rather than pairing an arbitrary metric file with the shipped fact file: the two files
    are one document version — `facts.v1.json` carries no `catalog_version` of its own for
    exactly that reason — so silently completing a caller's half-document with the image's
    other half would produce a `LoadedCatalog` whose two halves came from two documents and
    whose `catalog_version` describes only one of them. A caller that wants both supplies
    both.
    """
    resolved = Path(path) if path is not None else DEFAULT_CATALOG_PATH
    resolved_facts: Path | None
    if facts_path is not None:
        resolved_facts = Path(facts_path)
    elif path is None:
        resolved_facts = DEFAULT_FACTS_PATH
    else:
        resolved_facts = None

    try:
        raw_text = resolved.read_text(encoding="utf-8")
    except OSError as exc:
        raise CatalogUnusableError(
            f"the metric catalog could not be read from {resolved}: {exc}"
        ) from exc

    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise CatalogUnusableError(
            f"the metric catalog at {resolved} is not valid JSON: {exc}"
        ) from exc

    if not isinstance(raw, dict):
        raise CatalogUnusableError(
            f"the metric catalog at {resolved} must be a JSON object at the top "
            f"level, got {type(raw).__name__}"
        )

    catalog_version = raw.get("catalog_version")
    if not isinstance(catalog_version, str) or not catalog_version.strip():
        raise CatalogUnusableError(
            f"the metric catalog at {resolved} has no usable `catalog_version`"
        )

    raw_resource_types = raw.get("resource_types")
    if not isinstance(raw_resource_types, dict) or not raw_resource_types:
        raise CatalogUnusableError(
            f"the metric catalog at {resolved} declares no `resource_types` object, "
            f"or an empty one; there is nothing to collect anything with"
        )

    resource_types: list[ResourceTypeCatalog] = []
    invalid_entries: list[InvalidEntry] = []
    entries: list[CatalogEntry] = []

    for resource_type, raw_entry in raw_resource_types.items():
        if not isinstance(resource_type, str) or not resource_type.strip():
            invalid_entries.append(
                InvalidEntry(
                    resource_type=str(resource_type),
                    metric=None,
                    message="a resource type key must be a non-empty string",
                )
            )
            continue

        built, built_invalid = _load_resource_type(resource_type, raw_entry)
        resource_types.append(built)
        invalid_entries.extend(built_invalid)
        entries.extend(built.metrics)
        entries.extend(built.derived)
        entries.extend(built.enhanced_counters)

    facts, fact_invalid = _load_facts(resolved_facts)
    invalid_entries.extend(fact_invalid)

    # Req 32.7, widened by Req 1.7: a *fact* is a fourth thing a resource type can be
    # usable for. A type declaring no metric this run can collect but a fact it can
    # project still contributes a section to the document, so counting only the three
    # metric-shaped kinds would refuse a fact-only declaration as unusable.
    usable = any(rt.has_valid_entries for rt in resource_types) or any(
        declared.has_valid_entries for declared in facts.resource_types
    )
    if not usable:
        raise CatalogUnusableError(
            f"the metric catalog at {resolved} has zero valid metric, derived, "
            f"enhanced-counter or fact entries across every declared resource type "
            f"({len(invalid_entries)} entries failed validation); see the invalid "
            f"entries for why."
        )

    return LoadedCatalog(
        catalog_version=catalog_version,
        resource_types=tuple(resource_types),
        entries=tuple(entries),
        invalid_entries=tuple(invalid_entries),
        facts=facts,
    )


def _load_resource_type(
    resource_type: str, raw_entry: object
) -> tuple[ResourceTypeCatalog, list[InvalidEntry]]:
    """Validate one resource type's declared entries.

    A resource type whose own body is not an object is recorded as one invalid entry
    and treated as declaring nothing — the run continues with whatever other resource
    types validated (Req 32.5).
    """
    invalid: list[InvalidEntry] = []

    if not isinstance(raw_entry, dict):
        invalid.append(
            InvalidEntry(
                resource_type=resource_type,
                metric=None,
                message=(
                    f"the entry for resource type {resource_type!r} must be a JSON "
                    f"object, got {type(raw_entry).__name__}"
                ),
            )
        )
        return (
            ResourceTypeCatalog(
                resource_type=resource_type,
                metric_namespace=resource_type,
                sku_capabilities=(),
                metrics=(),
                derived=(),
                enhanced_counters=(),
            ),
            invalid,
        )

    metric_namespace = raw_entry.get("metric_namespace")
    if not isinstance(metric_namespace, str) or not metric_namespace.strip():
        metric_namespace = resource_type

    sku_capabilities = _coerce_string_tuple(
        raw_entry.get("sku_capabilities"),
        resource_type=resource_type,
        field_name="sku_capabilities",
        invalid=invalid,
    )

    seen_names: set[str] = set()

    metrics = _validate_metrics(
        resource_type,
        raw_entry.get("metrics"),
        seen_names=seen_names,
        invalid=invalid,
    )
    derived = _validate_derived(
        resource_type,
        raw_entry.get("derived"),
        seen_names=seen_names,
        declared_metric_names=frozenset(metric.name for metric in metrics),
        declared_sku_capabilities=frozenset(sku_capabilities),
        invalid=invalid,
    )
    enhanced_counters = _validate_enhanced_counters(
        resource_type,
        raw_entry.get("enhanced_counters"),
        seen_names=seen_names,
        invalid=invalid,
    )

    return (
        ResourceTypeCatalog(
            resource_type=resource_type,
            metric_namespace=metric_namespace,
            sku_capabilities=sku_capabilities,
            metrics=metrics,
            derived=derived,
            enhanced_counters=enhanced_counters,
        ),
        invalid,
    )


# --- the fact declaration (Req 1.4, 1.7, 4.2, 4.7, 4.11, 5.1-5.3) --------------------


def _load_facts(
    resolved: Path | None,
) -> tuple[FactDeclaration, list[InvalidEntry]]:
    """Load, validate and freeze the Fact_Declaration at `resolved`.

    `None` means the caller supplied a metric catalog and no fact file, which declares no
    facts — see :func:`load_catalog` for why that is a declaration rather than a default.

    Raises :class:`~reporting_agent.errors.CatalogUnusableError` for a malformed top-level
    shape, the same treatment and for the same reason the metric file gets it: a fact half
    that cannot be read at all is not a run that collects fewer facts, it is a run that
    would render every fact-bearing block empty with no gap saying why — which is precisely
    the silently-wrong artifact the verification premise exists to prevent. A malformed
    *entry* degrades to one :class:`InvalidEntry` exactly as a malformed metric does
    (Req 32.4, 32.5).
    """
    if resolved is None:
        return FactDeclaration(), []

    try:
        raw_text = resolved.read_text(encoding="utf-8")
    except OSError as exc:
        raise CatalogUnusableError(
            f"the fact declaration could not be read from {resolved}: {exc}"
        ) from exc

    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise CatalogUnusableError(
            f"the fact declaration at {resolved} is not valid JSON: {exc}"
        ) from exc

    if not isinstance(raw, dict):
        raise CatalogUnusableError(
            f"the fact declaration at {resolved} must be a JSON object at the top "
            f"level, got {type(raw).__name__}"
        )

    # Declaring a version here is itself the failure. The two files are one document
    # version, carried by `metrics.v1.json` alone, so a `catalog_version` in this file
    # is a second version string that can disagree with the first — and the disagreement
    # would be invisible, because every snapshot records one version and both halves
    # would claim to be it. Refusing the *key* is what makes the two files structurally
    # impossible to raise apart, rather than a convention someone has to remember when
    # bumping one of them.
    if "catalog_version" in raw:
        raise CatalogUnusableError(
            f"the fact declaration at {resolved} declares a `catalog_version`; the "
            f"metric catalog is the single version of the pair, and a second version "
            f"string here could disagree with it"
        )

    raw_resource_types = raw.get("resource_types")
    if not isinstance(raw_resource_types, dict):
        raise CatalogUnusableError(
            f"the fact declaration at {resolved} declares no `resource_types` object"
        )

    invalid: list[InvalidEntry] = []
    declared: list[ResourceTypeFacts] = []
    # One projection per key, across **every** resource type — see `_validate_facts` for
    # why this is a cross-type rule and not a per-type one.
    projection_of_key: dict[str, str] = {}

    for resource_type, raw_entry in raw_resource_types.items():
        if not isinstance(resource_type, str) or not resource_type.strip():
            invalid.append(
                InvalidEntry(
                    resource_type=str(resource_type),
                    metric=None,
                    message="a resource type key must be a non-empty string",
                )
            )
            continue

        declared.append(
            ResourceTypeFacts(
                resource_type=resource_type,
                facts=_validate_facts(
                    resource_type,
                    raw_entry,
                    invalid=invalid,
                    projection_of_key=projection_of_key,
                ),
            )
        )

    return FactDeclaration(resource_types=tuple(declared)), invalid


def _validate_facts(
    resource_type: str,
    raw_entry: object,
    *,
    invalid: list[InvalidEntry],
    projection_of_key: dict[str, str],
) -> tuple[FactDeclarationEntry, ...]:
    """Validate one resource type's declared facts, degrading per entry.

    `projection_of_key` carries the first projection seen for each key **across every
    resource type processed so far**, because a projectable fact's column name is derived
    from its key alone: `azure/clients.py` emits one `fact_<key> = <projection>` term per
    `(key, projection)` pair into a single query serving the whole scope, so two types
    declaring one key with two different expressions would name `fact_<key>` twice and
    Resource Graph would reject the query outright — every fact for the run, not just those
    two. Declaring the same key with the *identical* projection is the ordinary case and
    de-duplicates to one column.

    Where a fact genuinely lives at different paths on different types — `os_type` is
    `properties.osType` on a disk and `properties.storageProfile.osDisk.osType` on a VM —
    the projection is one `coalesce(tostring(a), tostring(b))` naming both paths, a single
    expression that resolves on whichever type the row happens to be.

    **`coalesce(tostring(a), tostring(b))`, not `tostring(coalesce(a, b))`.** KQL requires
    every `coalesce` argument to be the same type, and this form makes both arguments
    `string` by construction rather than relying on two dynamic property accesses agreeing.
    It works because `coalesce` skips an **empty** string as well as a null, and `tostring()`
    of an absent dynamic property is the empty string — so the second path is reached exactly
    when the first is absent.
    """
    if not isinstance(raw_entry, dict):
        invalid.append(
            InvalidEntry(
                resource_type=resource_type,
                metric=None,
                message=(
                    f"the fact entry for resource type {resource_type!r} must be a "
                    f"JSON object, got {type(raw_entry).__name__}"
                ),
            )
        )
        return ()

    raw_facts = raw_entry.get("facts")
    if raw_facts is None:
        return ()
    if not isinstance(raw_facts, list):
        invalid.append(
            InvalidEntry(
                resource_type=resource_type,
                metric=None,
                message="`facts` must be a JSON array",
            )
        )
        return ()

    seen_keys: set[str] = set()
    validated: list[FactDeclarationEntry] = []
    for raw_fact in raw_facts:
        result = _validate_one_fact(
            resource_type,
            raw_fact,
            seen_keys=seen_keys,
            projection_of_key=projection_of_key,
        )
        if isinstance(result, InvalidEntry):
            invalid.append(result)
        else:
            validated.append(result)
            if result.projectable and result.projection:
                projection_of_key.setdefault(result.key, result.projection)
    return tuple(validated)


def _validate_one_fact(
    resource_type: str,
    raw_fact: object,
    *,
    seen_keys: set[str],
    projection_of_key: dict[str, str],
) -> FactDeclarationEntry | InvalidEntry:
    """One fact entry, validated against the declared vocabularies (Req 32.3-32.5).

    Every reason is collected before returning, rather than short-circuiting on the first,
    so one `InvalidEntry` explains everything wrong with the entry — a fact that names both
    an undeclared source and an undeclared unit should not have to be fixed twice.
    """
    if not isinstance(raw_fact, dict):
        return InvalidEntry(
            resource_type=resource_type,
            metric=None,
            message=(
                f"a fact entry must be a JSON object, got {type(raw_fact).__name__}"
            ),
        )

    key = raw_fact.get("key")
    reasons: list[str] = []

    if not isinstance(key, str) or not key:
        reasons.append("fact key is missing, empty or not a string")
        key_for_gap: str | None = None
    else:
        key_for_gap = key
        if not (MIN_FACT_KEY_LENGTH <= len(key) <= MAX_FACT_KEY_LENGTH):
            reasons.append(
                f"fact key {key!r} must be between {MIN_FACT_KEY_LENGTH} and "
                f"{MAX_FACT_KEY_LENGTH} characters, got {len(key)}"
            )
        if not _FACT_KEY_PATTERN.match(key):
            reasons.append(
                f"fact key {key!r} must match {_FACT_KEY_PATTERN.pattern} — a fact key "
                f"names a snapshot field and a message id, so it is lower snake case"
            )
        if key in seen_keys:
            reasons.append(
                f"fact key {key!r} is repeated within resource type {resource_type!r}"
            )

    value_kind = raw_fact.get("value_kind")
    if value_kind not in DECLARED_FACT_VALUE_KINDS:
        reasons.append(
            f"value_kind {value_kind!r} is not one of the declared kinds "
            f"{sorted(DECLARED_FACT_VALUE_KINDS)}"
        )

    source = raw_fact.get("source")
    if source not in DECLARED_FACT_SOURCES:
        reasons.append(
            f"source {source!r} is not one of the declared sources "
            f"{sorted(DECLARED_FACT_SOURCES)}"
        )

    raw_projectable = raw_fact.get("projectable")
    if not isinstance(raw_projectable, bool):
        reasons.append(
            f"`projectable` must be a JSON boolean, got {raw_projectable!r}"
        )
        projectable = False
    else:
        projectable = raw_projectable

    projection = raw_fact.get("projection")
    absent_gap_type = raw_fact.get("absent_gap_type")

    if isinstance(raw_projectable, bool):
        if projectable:
            if not isinstance(projection, str) or not projection.strip():
                reasons.append(
                    "a projectable fact must declare a non-empty `projection`; without "
                    "one there is no column for the inventory query to project"
                )
            if absent_gap_type is not None:
                reasons.append(
                    f"a projectable fact must not declare an `absent_gap_type`, got "
                    f"{absent_gap_type!r}: a projected column with no value is "
                    f"`fact_unavailable`, not a configuration state"
                )
            established = projection_of_key.get(key) if isinstance(key, str) else None
            if (
                established is not None
                and isinstance(projection, str)
                and projection != established
            ):
                reasons.append(
                    f"fact key {key!r} is already projected as {established!r} by another "
                    f"resource type; one key is one column in the single inventory query, "
                    f"so a second expression would name `fact_{key}` twice and Resource "
                    f"Graph would reject the whole query. Use one `coalesce(...)` naming "
                    f"both paths."
                )
        else:
            if projection is not None:
                reasons.append(
                    f"a non-projectable fact must not declare a `projection`, got "
                    f"{projection!r}"
                )
            if absent_gap_type not in DECLARED_ABSENT_GAP_TYPES:
                reasons.append(
                    f"a non-projectable fact must declare an `absent_gap_type` drawn "
                    f"from {sorted(DECLARED_ABSENT_GAP_TYPES)}, got "
                    f"{absent_gap_type!r}"
                )

    unit = raw_fact.get("unit")
    if value_kind == "numeric":
        if unit not in DECLARED_FACT_UNITS:
            reasons.append(
                f"a numeric fact must declare a `unit` drawn from "
                f"{sorted(DECLARED_FACT_UNITS)}, got {unit!r}"
            )
    elif unit is not None:
        reasons.append(
            f"a text fact must not declare a `unit`, got {unit!r}: there is no unit "
            f"for `Succeeded`"
        )

    if reasons:
        return InvalidEntry(
            resource_type=resource_type,
            metric=key_for_gap,
            message="; ".join(reasons),
        )

    assert isinstance(key, str)  # narrowed by the checks above
    assert isinstance(value_kind, str)
    assert isinstance(source, str)
    seen_keys.add(key)

    return FactDeclarationEntry(
        resource_type=resource_type,
        key=key,
        value_kind=value_kind,
        source=source,
        projectable=projectable,
        projection=projection if isinstance(projection, str) else None,
        absent_gap_type=(
            absent_gap_type if isinstance(absent_gap_type, str) else None
        ),
        unit=unit if isinstance(unit, str) else None,
    )


def _coerce_string_tuple(
    raw: object, *, resource_type: str, field_name: str, invalid: list[InvalidEntry]
) -> tuple[str, ...]:
    """A declared list of names (`sku_capabilities`), or `()` with a recorded
    structural gap if the field is present but not a list of strings."""
    if raw is None:
        return ()
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        invalid.append(
            InvalidEntry(
                resource_type=resource_type,
                metric=None,
                message=f"`{field_name}` must be a JSON array of strings",
            )
        )
        return ()
    return tuple(raw)


def _validate_metrics(
    resource_type: str,
    raw: object,
    *,
    seen_names: set[str],
    invalid: list[InvalidEntry],
) -> tuple[MetricEntry, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        invalid.append(
            InvalidEntry(
                resource_type=resource_type,
                metric=None,
                message="`metrics` must be a JSON array",
            )
        )
        return ()

    validated: list[MetricEntry] = []
    for raw_metric in raw:
        result = _validate_one_metric(resource_type, raw_metric, seen_names=seen_names)
        if isinstance(result, InvalidEntry):
            invalid.append(result)
        else:
            validated.append(result)
    return tuple(validated)


def _validate_one_metric(
    resource_type: str, raw_metric: object, *, seen_names: set[str]
) -> MetricEntry | InvalidEntry:
    if not isinstance(raw_metric, dict):
        return InvalidEntry(
            resource_type=resource_type,
            metric=None,
            message=f"a metric entry must be a JSON object, got {type(raw_metric).__name__}",
        )

    name = raw_metric.get("name")
    reasons: list[str] = []

    if not isinstance(name, str) or not name.strip():
        reasons.append("metric name is missing, empty or not a string")
        name_for_gap: str | None = None
    else:
        name_for_gap = name
        if name in seen_names:
            reasons.append(
                f"metric name {name!r} is repeated within resource type {resource_type!r}"
            )

    unit = raw_metric.get("unit")
    if unit not in DECLARED_UNITS:
        reasons.append(
            f"unit {unit!r} is not one of the declared units {sorted(DECLARED_UNITS)}"
        )

    unit_family = raw_metric.get("unit_family")
    if unit_family not in DECLARED_UNIT_FAMILIES:
        reasons.append(
            f"unit family {unit_family!r} is not one of the declared families "
            f"{sorted(DECLARED_UNIT_FAMILIES)}"
        )

    aggregations = raw_metric.get("aggregations")
    valid_aggregations = _valid_string_list(aggregations, DECLARED_AGGREGATIONS)
    if valid_aggregations is None or len(valid_aggregations) == 0:
        reasons.append(
            f"`aggregations` must be a non-empty JSON array drawn from "
            f"{sorted(DECLARED_AGGREGATIONS)}, got {aggregations!r}"
        )

    scale = raw_metric.get("scale")
    if not _is_valid_scale(scale):
        reasons.append(
            f"`scale` must be an integer between {MIN_SCALE} and {MAX_SCALE} "
            f"inclusive, got {scale!r}"
        )

    if reasons:
        return InvalidEntry(
            resource_type=resource_type,
            metric=name_for_gap,
            message="; ".join(reasons),
        )

    assert isinstance(name, str)  # narrowed by the checks above
    seen_names.add(name)

    percentiles = raw_metric.get("percentiles")
    percentiles_tuple = (
        tuple(percentiles) if isinstance(percentiles, list) else ()
    )

    label = raw_metric.get("label")
    interval_scoped = bool(raw_metric.get("interval_scoped", False))

    return MetricEntry(
        resource_type=resource_type,
        name=name,
        unit=unit,
        unit_family=unit_family,
        aggregations=tuple(valid_aggregations),
        scale=int(scale),
        percentiles=percentiles_tuple,
        label=label if isinstance(label, str) else None,
        interval_scoped=interval_scoped,
    )


def _validate_derived(
    resource_type: str,
    raw: object,
    *,
    seen_names: set[str],
    declared_metric_names: frozenset[str],
    declared_sku_capabilities: frozenset[str],
    invalid: list[InvalidEntry],
) -> tuple[DerivedEntry, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        invalid.append(
            InvalidEntry(
                resource_type=resource_type,
                metric=None,
                message="`derived` must be a JSON array",
            )
        )
        return ()

    validated: list[DerivedEntry] = []
    for raw_derived in raw:
        result = _validate_one_derived(
            resource_type,
            raw_derived,
            seen_names=seen_names,
            declared_metric_names=declared_metric_names,
            declared_sku_capabilities=declared_sku_capabilities,
        )
        if isinstance(result, InvalidEntry):
            invalid.append(result)
        else:
            validated.append(result)
    return tuple(validated)


def _validate_one_derived(
    resource_type: str,
    raw_derived: object,
    *,
    seen_names: set[str],
    declared_metric_names: frozenset[str],
    declared_sku_capabilities: frozenset[str],
) -> DerivedEntry | InvalidEntry:
    if not isinstance(raw_derived, dict):
        return InvalidEntry(
            resource_type=resource_type,
            metric=None,
            message=(
                f"a derived statistic entry must be a JSON object, got "
                f"{type(raw_derived).__name__}"
            ),
        )

    statistic_id = raw_derived.get("statistic_id")
    reasons: list[str] = []

    if not isinstance(statistic_id, str) or not statistic_id.strip():
        reasons.append("statistic_id is missing, empty or not a string")
        name_for_gap: str | None = None
    else:
        name_for_gap = statistic_id
        if statistic_id in seen_names:
            reasons.append(
                f"statistic id {statistic_id!r} is repeated within resource type "
                f"{resource_type!r}"
            )

    unit = raw_derived.get("unit")
    if unit not in DECLARED_UNITS:
        reasons.append(
            f"unit {unit!r} is not one of the declared units {sorted(DECLARED_UNITS)}"
        )

    unit_family = raw_derived.get("unit_family")
    if unit_family not in DECLARED_UNIT_FAMILIES:
        reasons.append(
            f"unit family {unit_family!r} is not one of the declared families "
            f"{sorted(DECLARED_UNIT_FAMILIES)}"
        )

    scale = raw_derived.get("scale")
    if not _is_valid_scale(scale):
        reasons.append(
            f"`scale` must be an integer between {MIN_SCALE} and {MAX_SCALE} "
            f"inclusive, got {scale!r}"
        )

    formula = raw_derived.get("formula")
    if not isinstance(formula, str) or not formula.strip():
        reasons.append("`formula` is missing, empty or not a string")
        formula = ""

    sources, source_reasons, bound_identifiers = _validate_sources(
        raw_derived.get("sources"),
        declared_metric_names=declared_metric_names,
        declared_sku_capabilities=declared_sku_capabilities,
    )
    reasons.extend(source_reasons)

    if formula:
        unresolved = sorted(
            identifier
            for identifier in set(_IDENTIFIER_PATTERN.findall(formula))
            if identifier not in bound_identifiers
        )
        if unresolved:
            reasons.append(
                f"formula identifier(s) {unresolved} are not bound by any entry in "
                f"`sources`"
            )

    if reasons:
        return InvalidEntry(
            resource_type=resource_type,
            metric=name_for_gap,
            message="; ".join(reasons),
        )

    assert isinstance(statistic_id, str)
    seen_names.add(statistic_id)

    observation = raw_derived.get("observation")
    note = raw_derived.get("note")

    return DerivedEntry(
        resource_type=resource_type,
        statistic_id=statistic_id,
        unit=unit,
        unit_family=unit_family,
        scale=int(scale),
        formula=formula,
        sources=sources,
        observation=observation if isinstance(observation, str) else None,
        note=note if isinstance(note, str) else None,
    )


def _validate_sources(
    raw: object,
    *,
    declared_metric_names: frozenset[str],
    declared_sku_capabilities: frozenset[str],
) -> tuple[tuple[SourceBinding, ...], list[str], frozenset[str]]:
    """Validate a derived statistic's `sources` list.

    Returns the validated bindings, any failure reasons, and the set of identifiers
    those bindings make resolvable — what the formula-identifier check in
    :func:`_validate_one_derived` checks every formula identifier against.
    """
    reasons: list[str] = []

    if raw is None or not isinstance(raw, list) or len(raw) == 0:
        return (), ["`sources` must be a non-empty JSON array"], frozenset()

    bindings: list[SourceBinding] = []
    bound_identifiers: set[str] = set()

    for index, raw_source in enumerate(raw):
        if not isinstance(raw_source, dict):
            reasons.append(f"sources[{index}] must be a JSON object")
            continue

        kind = raw_source.get("kind")
        if kind not in DECLARED_SOURCE_KINDS:
            reasons.append(
                f"sources[{index}].kind {kind!r} is not one of "
                f"{sorted(DECLARED_SOURCE_KINDS)}"
            )
            continue

        name = raw_source.get("name")
        if not isinstance(name, str) or not name.strip():
            reasons.append(f"sources[{index}].name is missing, empty or not a string")
            continue

        binds = raw_source.get("binds")
        if not isinstance(binds, str) or not binds.strip():
            reasons.append(f"sources[{index}].binds is missing, empty or not a string")
            continue

        if kind == "metric":
            if name not in declared_metric_names:
                reasons.append(
                    f"sources[{index}] binds metric {name!r}, which is not among "
                    f"this resource type's declared, valid metrics"
                )
                continue
            statistic = raw_source.get("statistic")
            if not isinstance(statistic, str) or not statistic.strip():
                reasons.append(
                    f"sources[{index}] (kind=metric) is missing a `statistic` field"
                )
                continue
            for_statistic = raw_source.get("for_statistic")
            bindings.append(
                SourceBinding(
                    kind="metric",
                    name=name,
                    binds=binds,
                    statistic=statistic,
                    for_statistic=(
                        for_statistic if isinstance(for_statistic, str) else None
                    ),
                )
            )
        else:  # kind == "sku_capability"
            if name not in declared_sku_capabilities:
                reasons.append(
                    f"sources[{index}] binds SKU capability {name!r}, which is not "
                    f"among this resource type's declared `sku_capabilities`"
                )
                continue
            unit = raw_source.get("unit")
            bindings.append(
                SourceBinding(
                    kind="sku_capability",
                    name=name,
                    binds=binds,
                    unit=unit if isinstance(unit, str) else None,
                )
            )

        bound_identifiers.add(binds)

    return tuple(bindings), reasons, frozenset(bound_identifiers)


def _validate_enhanced_counters(
    resource_type: str,
    raw: object,
    *,
    seen_names: set[str],
    invalid: list[InvalidEntry],
) -> tuple[EnhancedCounterEntry, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        invalid.append(
            InvalidEntry(
                resource_type=resource_type,
                metric=None,
                message="`enhanced_counters` must be a JSON array",
            )
        )
        return ()

    validated: list[EnhancedCounterEntry] = []
    for raw_counter in raw:
        result = _validate_one_enhanced_counter(
            resource_type, raw_counter, seen_names=seen_names
        )
        if isinstance(result, InvalidEntry):
            invalid.append(result)
        else:
            validated.append(result)
    return tuple(validated)


def _validate_one_enhanced_counter(
    resource_type: str, raw_counter: object, *, seen_names: set[str]
) -> EnhancedCounterEntry | InvalidEntry:
    if not isinstance(raw_counter, dict):
        return InvalidEntry(
            resource_type=resource_type,
            metric=None,
            message=(
                f"an enhanced-counter entry must be a JSON object, got "
                f"{type(raw_counter).__name__}"
            ),
        )

    statistic_id = raw_counter.get("statistic_id")
    reasons: list[str] = []

    if not isinstance(statistic_id, str) or not statistic_id.strip():
        reasons.append("statistic_id is missing, empty or not a string")
        name_for_gap: str | None = None
    else:
        name_for_gap = statistic_id
        if statistic_id in seen_names:
            reasons.append(
                f"statistic id {statistic_id!r} is repeated within resource type "
                f"{resource_type!r}"
            )

    counter_object = raw_counter.get("object")
    if not isinstance(counter_object, str) or not counter_object.strip():
        reasons.append("`object` is missing, empty or not a string")

    counter = raw_counter.get("counter")
    if not isinstance(counter, str) or not counter.strip():
        reasons.append("`counter` is missing, empty or not a string")

    unit = raw_counter.get("unit")
    if unit not in DECLARED_UNITS:
        reasons.append(
            f"unit {unit!r} is not one of the declared units {sorted(DECLARED_UNITS)}"
        )

    unit_family = raw_counter.get("unit_family")
    if unit_family not in DECLARED_UNIT_FAMILIES:
        reasons.append(
            f"unit family {unit_family!r} is not one of the declared families "
            f"{sorted(DECLARED_UNIT_FAMILIES)}"
        )

    scale = raw_counter.get("scale")
    if not _is_valid_scale(scale):
        reasons.append(
            f"`scale` must be an integer between {MIN_SCALE} and {MAX_SCALE} "
            f"inclusive, got {scale!r}"
        )

    if reasons:
        return InvalidEntry(
            resource_type=resource_type,
            metric=name_for_gap,
            message="; ".join(reasons),
        )

    assert isinstance(statistic_id, str)
    seen_names.add(statistic_id)

    return EnhancedCounterEntry(
        resource_type=resource_type,
        statistic_id=statistic_id,
        object=counter_object,
        counter=counter,
        unit=unit,
        unit_family=unit_family,
        scale=int(scale),
        per_instance=bool(raw_counter.get("per_instance", False)),
    )


# --- small shared checks ----------------------------------------------------------


def _is_valid_scale(value: object) -> bool:
    # `bool` is a subclass of `int`; a scale of `True` is not a fractional-digit count.
    if isinstance(value, bool) or not isinstance(value, int):
        return False
    return MIN_SCALE <= value <= MAX_SCALE


def _valid_string_list(value: object, declared: frozenset[str]) -> list[str] | None:
    """`value` as a list of strings each drawn from `declared`, or `None` if `value`
    is not a list of strings at all (as opposed to a list containing an undeclared
    member, which returns the empty subset rather than `None`)."""
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return None
    return [item for item in value if item in declared]
