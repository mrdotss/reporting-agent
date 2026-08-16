"""The Metric_Catalog loader: `metrics.v1.json` in, a frozen `LoadedCatalog` out.

`catalog/metrics.v1.json` is data shipped in the image (Req 32.8). This module is the
only code that reads it, validates every entry against the schema Req 32.3 declares, and
hands back an object that cannot be mutated — a field assignment, an item assignment on
one of its tuple fields, or an attempt to attach a new attribute all raise, the same
guarantee `config.py` gives `Config` (Req 14.12) and for the same reason: a catalog a run
could rewrite mid-collection is a catalog whose declared metric set cannot be trusted for
the run that started with it.

**Per-entry validation degrades a run; whole-catalog unusability ends one.** Those are two
different failure shapes and this module keeps them that way:

* A single metric, derived statistic or enhanced-tier counter that fails validation is
  recorded as one :class:`InvalidEntry`, skipped, and emits no statistic (Req 32.4). No
  exception crosses an entry boundary (Req 32.5) — a bug in one catalog entry costs that
  entry, not the run.
* Zero valid metrics, derived statistics and enhanced counters across **every** resource
  type the file declares is a different fact: there is nothing left to collect anything
  with, and :func:`load_catalog` raises :class:`~reporting_agent.errors.CatalogUnusableError`
  rather than returning a catalog with nothing in it (Req 32.7). A malformed top-level
  shape — invalid JSON, a missing `catalog_version`, a `resource_types` that is not an
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
    "CATALOG_ENTRY_INVALID_GAP_TYPE",
    "DECLARED_AGGREGATIONS",
    "DECLARED_UNITS",
    "DECLARED_UNIT_FAMILIES",
    "MAX_SCALE",
    "MIN_SCALE",
    "CatalogEntry",
    "DerivedEntry",
    "EnhancedCounterEntry",
    "InvalidEntry",
    "LoadedCatalog",
    "MetricEntry",
    "ResourceTypeCatalog",
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
DECLARED_AGGREGATIONS: Final[frozenset[str]] = frozenset(
    {"Total", "Count", "Minimum", "Maximum"}
)
DECLARED_SOURCE_KINDS: Final[frozenset[str]] = frozenset({"metric", "sku_capability"})

MIN_SCALE: Final[int] = 0
MAX_SCALE: Final[int] = 9

CATALOG_ENTRY_INVALID_GAP_TYPE: Final[str] = "catalog_entry_invalid"

DEFAULT_CATALOG_PATH: Final[Path] = Path(__file__).resolve().parent / "metrics.v1.json"

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


type CatalogEntry = MetricEntry | DerivedEntry | EnhancedCounterEntry
"""Every validated entry kind, for callers that want to walk the catalog without
caring which kind they are looking at (`LoadedCatalog.entries`)."""


@dataclass(frozen=True, slots=True)
class InvalidEntry:
    """One entry that failed validation (Req 32.4).

    Shaped so a caller can build a `catalog_entry_invalid` gap from it without this
    module knowing what a `collection_log` entry looks like — `collect/log.py` (a
    later task in this same parent) owns that shape. `metric` is the entry's own name
    or statistic id when one could be read at all, and `None` when the entry was
    missing or unusable as a name (an empty name is exactly the case Req 32.3 rejects,
    so `metric` is `None` rather than the empty string that failed validation).
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


def load_catalog(path: Path | str | None = None) -> LoadedCatalog:
    """Load, validate and freeze the Metric_Catalog at `path` (default:
    `catalog/metrics.v1.json`, shipped in the image).

    Raises :class:`~reporting_agent.errors.CatalogUnusableError` when the file cannot
    be read as the declared top-level shape at all, or when validation leaves zero
    valid entries for every resource type it declares (Req 32.7) — there is nothing an
    empty catalog could be used to collect. Every narrower failure — one bad metric,
    one bad derived statistic, one bad enhanced counter — is recorded in the returned
    catalog's `invalid_entries` instead of raising (Req 32.4, 32.5).
    """
    resolved = Path(path) if path is not None else DEFAULT_CATALOG_PATH

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

    if not any(rt.has_valid_entries for rt in resource_types):
        raise CatalogUnusableError(
            f"the metric catalog at {resolved} has zero valid metric, derived or "
            f"enhanced-counter entries across every declared resource type "
            f"({len(invalid_entries)} entries failed validation); see the invalid "
            f"entries for why."
        )

    return LoadedCatalog(
        catalog_version=catalog_version,
        resource_types=tuple(resource_types),
        entries=tuple(entries),
        invalid_entries=tuple(invalid_entries),
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
