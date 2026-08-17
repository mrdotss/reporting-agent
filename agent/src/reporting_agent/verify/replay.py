"""Deterministic replay — proving the snapshot without re-collecting (Req 31).

Every other pass in this package checks the *document* against the *snapshot*. This one
checks the snapshot against the raw bytes the cloud actually returned: it re-runs the same
aggregation over the archived responses and asserts the recomputed digest is byte-for-byte
equal to the stored `snapshot_id`.

That is the check worth having the day a customer disputes a number. A full Azure re-query
would answer a different question — "does the cloud still say this today?" — which for a
closed window is both slower and less informative, since the cloud legitimately revises and
ages out data. Replay answers the question actually in dispute: given what arrived, does
this aggregation produce this snapshot, every time.

## The same code, not equivalent code

This module folds through `azure/metrics.py`'s `fold_resource_metrics`, finalizes through
`collect/finalize.py`'s `finalize_resource`, and canonicalizes and hashes through
`collect/snapshot.py`'s `build_snapshot`. Not reimplementations of them — them. A second
implementation would make a mismatch mean "the two agree less than they should", and the
whole value of the artifact is that a mismatch means "this snapshot is not reproducible".

## Purity is a build-time property here, not a runtime one

Zero network requests of any kind (Req 31.2). The archived objects arrive **from the
caller** as an iterable, because a replay that fetched its own inputs could fetch anything.
And `tests/test_boundaries.py` walks this module's transitive first-party import closure and
fails if any module in it imports `azure.*`, `boto3`, `httpx` or `reporting_agent.storage.s3`
— so purity is checked when the tests run rather than hoped for when a verification does.

`reporting_agent.azure.metrics` is on that closure and is *not* an Azure SDK import: it is a
first-party module that parses a response body already in memory. The guard distinguishes
them by import root, and the day someone adds an SDK import to it, the guard fails loudly
rather than replay quietly opening a socket.

## A missing input is not a mismatch

The snapshot's archive flag being false, an object the sequence names being absent, or an
object failing to decode all record the **advisory** `archive_incomplete`, record that replay
was not possible, and record **no** `replay_hash_mismatch` (Req 31.5, 31.8). Reporting a
mismatch there would accuse a run of non-determinism on the strength of a missing input —
which is both wrong and, because it is blocking, would withhold a correct report.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from datetime import tzinfo as TzInfo
from decimal import Decimal
from typing import Final, cast
from zoneinfo import ZoneInfo

from reporting_agent.azure.metrics import fold_batch_response, fold_fallback_response
from reporting_agent.catalog.loader import DerivedEntry, LoadedCatalog, MetricEntry
from reporting_agent.collect.accumulate import MetricAccumulator, new_accumulator
from reporting_agent.collect.buckets import Window, resolve_window
from reporting_agent.collect.finalize import finalize_resource
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_INTERVAL_COUNTS_MISSING,
    GAP_TYPE_INTERVAL_MALFORMED,
    GAP_TYPE_METRIC_ERROR,
    GAP_TYPE_NO_SAMPLES,
    GAP_TYPE_PERMISSION_DENIED,
    GAP_TYPE_POWER_STATE_UNKNOWN,
    GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE,
    GAP_TYPE_SKU_CAPABILITY_MISSING,
)
from reporting_agent.collect.snapshot import (
    ResourceDayBucket,
    ResourceSnapshot,
    SkuCapacity,
    StatisticEntry,
    build_snapshot,
)
from reporting_agent.providers.base import GapRecord, ResourceRecord, ScopeSpec
from reporting_agent.verify.findings import (
    FINDING_ARCHIVE_INCOMPLETE,
    FINDING_REPLAY_HASH_MISMATCH,
    Finding,
    ReplayOutcome,
    record_finding,
)

__all__ = [
    "RECOMPUTED_GAP_TYPES",
    "ReplayPlan",
    "ReplayResource",
    "ReplayResult",
    "plan_from_snapshot",
    "replay",
]

RECOMPUTED_GAP_TYPES: Final[frozenset[str]] = frozenset(
    {
        GAP_TYPE_INTERVAL_COUNTS_MISSING,
        GAP_TYPE_INTERVAL_MALFORMED,
        GAP_TYPE_METRIC_ERROR,
        GAP_TYPE_NO_SAMPLES,
        GAP_TYPE_PERMISSION_DENIED,
        GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE,
        GAP_TYPE_SKU_CAPABILITY_MISSING,
    }
)
"""The gap types the fold and the finalize produce, and which a replay therefore recomputes
rather than carries over.

Every other gap in a stored `collection_log` — inventory, region reachability, SKU
resolution, fidelity probing, archive writes — was produced by a step replay does not re-run
and could not re-run, so it is carried over unchanged. Getting this partition wrong is the
most likely way a correct replay reports a mismatch: carry a recomputed type over and it
appears twice; drop a carried-over type and it vanishes. Both change the `collection_log` and
therefore the digest.
"""


@dataclass(frozen=True, slots=True)
class ReplayResource:
    """One resource's non-metric facts — everything the archive does not carry.

    The archive holds metric responses and nothing else, so a recomputation needs the
    inventory record, the resolved SKU capacity and the local-day geometry from somewhere.
    They come from the stored snapshot, and Req 31.4 permits that precisely: what it forbids
    is deriving a folded value from an **accumulator, aggregated value or digest** read out
    of the stored snapshot. A resource's name, type and vCPU count are none of those, and no
    archive of metric responses could supply them.

    `sku_capability_values` is pre-resolved rather than a capacity object, matching
    `collect/finalize.py`'s provider-neutral signature.
    """

    record: ResourceRecord
    resource_type: str
    fidelity_tier: str
    sku: SkuCapacity
    day_buckets: tuple[ResourceDayBucket, ...]
    declared: Mapping[str, MetricEntry]
    selected: tuple[str, ...]
    derived_entries: tuple[DerivedEntry, ...]
    sku_capability_values: Mapping[str, Decimal | None] = field(default_factory=dict)
    excluded: bool = False
    guest_entries: tuple[StatisticEntry, ...] = ()


@dataclass(frozen=True, slots=True)
class ReplayPlan:
    """Everything a recomputation needs beyond the archived responses themselves.

    `gaps` carries the run's **non-metric** gaps only — inventory, SKU resolution, fidelity
    probing, archive writes. The gaps the metric fold and the finalize produce are
    recomputed here, because a mutation that turns a well-formed interval into a malformed
    one must change the recomputed snapshot, and it changes it through the gap list.
    Handing the stored fold gaps back in would make that mutation invisible.
    """

    stored_snapshot_id: str
    run_id: str
    scope: ScopeSpec
    scope_verified: bool
    collected_at: datetime
    timezone_name: str
    tz: TzInfo
    window: Window
    grain: str
    metrics_by_resource_type: Mapping[str, Sequence[str]]
    resources: tuple[ReplayResource, ...]
    gaps: tuple[GapRecord, ...]
    catalog_version: str
    archive_complete: bool
    archive_object_count: int
    objects_named: int


@dataclass(frozen=True, slots=True)
class ReplayResult:
    """The replay outcome plus the findings it produced.

    `document` is the recomputed snapshot, returned so a caller can diff two snapshots when
    a mismatch is reported rather than only being told that they differ. It is `None` where
    replay was not possible.
    """

    outcome: ReplayOutcome
    findings: tuple[Finding, ...]
    document: Mapping[str, object] | None = None


def replay(archived: Iterable[tuple[int, bytes]], *, plan: ReplayPlan) -> ReplayResult:
    """Re-run the aggregation over `archived` and compare the digest (Req 31.1).

    `archived` is `(sequence ordinal, gzipped object bytes)` pairs, supplied by the caller.
    Each is folded **exactly once**, in the order the sequence records, and each object's
    decoded points are discarded once folded, so no more than one object's points are held
    at a time (Req 31.4).

    Returns rather than raises for every outcome including a mismatch: a mismatch is a
    finding on the verification result, and the orchestrator decides the run's terminal
    code from it.
    """
    if not plan.archive_complete:
        return _not_possible(
            plan,
            objects_folded=0,
            why=(
                "the snapshot records its raw archive as incomplete, so at least one "
                "response this run folded was never written; replay was not attempted"
            ),
        )

    accumulators = _new_accumulators(plan)
    fold_gaps: list[GapRecord] = []
    folded = 0

    for ordinal, payload in archived:
        try:
            document = _decode(payload)
        except Exception as exc:
            return _not_possible(
                plan,
                objects_folded=folded,
                why=(
                    f"the archived object at sequence ordinal {ordinal} could not be "
                    f"decoded ({type(exc).__name__}); a replay over a partial archive "
                    f"would report a mismatch on the strength of a missing input"
                ),
                ordinal=ordinal,
            )
        fold_gaps.extend(_fold_object(document, accumulators))
        folded += 1
        # The decoded points go out of scope here, per object, rather than being collected
        # into a list the loop then aggregates over.
        del document

    if folded != plan.objects_named:
        return _not_possible(
            plan,
            objects_folded=folded,
            why=(
                f"the archive sequence names {plan.objects_named} object(s) and "
                f"{folded} were supplied; an object the sequence names is missing"
            ),
        )

    recomputed = _assemble(plan, accumulators, fold_gaps)
    digest = str(recomputed["snapshot_id"])

    outcome: ReplayOutcome = {
        "possible": True,
        "recomputed_sha256": digest,
        "stored_sha256": plan.stored_snapshot_id,
        "objects_folded": folded,
        "objects_named": plan.objects_named,
    }
    if digest == plan.stored_snapshot_id:
        return ReplayResult(outcome=outcome, findings=(), document=recomputed)

    return ReplayResult(
        outcome=outcome,
        findings=(
            record_finding(
                FINDING_REPLAY_HASH_MISMATCH,
                f"re-running the aggregation over {folded} archived object(s) produced "
                f"the snapshot digest {digest}, but the run recorded "
                f"{plan.stored_snapshot_id}; this snapshot is not reproducible from the "
                f"responses that produced it",
                expected=plan.stored_snapshot_id,
                observed=digest,
            ),
        ),
        document=recomputed,
    )


def _not_possible(
    plan: ReplayPlan, *, objects_folded: int, why: str, ordinal: int | None = None
) -> ReplayResult:
    """Req 31.5, 31.8 — an inability to replay, recorded as advisory and nothing more."""
    located: dict[str, object] = {}
    if ordinal is not None:
        located["paragraph_ordinal"] = ordinal
    return ReplayResult(
        outcome={
            "possible": False,
            "objects_folded": objects_folded,
            "objects_named": plan.objects_named,
        },
        findings=(record_finding(FINDING_ARCHIVE_INCOMPLETE, why, **located),),
    )


def _decode(payload: bytes) -> Mapping[str, object]:
    """One archived object, as `collect/archive.py` wrote it.

    `parse_float=Decimal` is not optional. The archive was written from `Decimal` values
    rendered as their exact digit strings, and reading them back through `float` would
    round-trip every metric value through binary floating point — which is exactly the
    non-determinism the snapshot's decimal-string discipline exists to prevent, arriving by
    the back door of the check that is supposed to prove determinism.
    """
    document = json.loads(gzip.decompress(payload).decode("utf-8"), parse_float=Decimal)
    if not isinstance(document, Mapping):
        raise TypeError(f"an archived object must be an object, got {type(document).__name__}")
    return document


def _new_accumulators(plan: ReplayPlan) -> dict[tuple[str, str], MetricAccumulator]:
    """One accumulator per `(resource, metric)` pair, built the way the collector built it.

    Through `new_accumulator`, so the sketch kind follows the catalog's declared unit
    family and an excluded resource is excluded here too. The `percentile_unsupported_unit`
    gap it can return is **discarded**: it was recorded during collection and is already in
    the plan's non-metric gap list, and recording it a second time would put two identical
    entries in the recomputed `collection_log` and guarantee a mismatch.
    """
    accumulators: dict[tuple[str, str], MetricAccumulator] = {}
    for resource in plan.resources:
        resource_id = resource.record["resource_id"]
        for name in resource.selected:
            accumulator, _ = new_accumulator(
                resource.declared[name].unit_family,
                resource_id=resource_id,
                metric=name,
                excluded=resource.excluded,
            )
            accumulators[(resource_id, name)] = accumulator
    return accumulators


def _fold_object(
    document: Mapping[str, object],
    accumulators: Mapping[tuple[str, str], MetricAccumulator],
) -> list[GapRecord]:
    """Fold one archived response, through the collector's own two folds.

    The object body carries its own provenance — the grouping key, the grain, the window,
    the requested metric names and the resource ids travel with the response
    (`collect/archive.py`) — which is what lets this re-aggregate from the archive alone
    rather than needing the request that produced it.

    The two shapes are distinguished the way the collector distinguishes them: a batch
    response carries `values`, a per-resource ARM fallback carries `value` at the top level
    with its resource id outside the body, recovered here from the object's `resource_ids`.
    Getting this wrong in either direction would fold nothing and report a mismatch on a
    reproducible snapshot.
    """
    raw = document.get("raw_response")
    if not isinstance(raw, Mapping):
        return []
    metric_names = [
        name for name in document.get("metric_names") or [] if isinstance(name, str)
    ]
    resource_ids = [
        value for value in document.get("resource_ids") or [] if isinstance(value, str)
    ]

    if isinstance(raw.get("values"), list):
        return fold_batch_response(
            body=raw,
            resource_ids=resource_ids,
            metric_names=metric_names,
            accumulators=accumulators,
        )

    gaps: list[GapRecord] = []
    for resource_id in resource_ids:
        gaps.extend(
            fold_fallback_response(
                body=raw,
                resource_id=resource_id,
                metric_names=metric_names,
                accumulators=accumulators,
            )
        )
    return gaps


def _assemble(
    plan: ReplayPlan,
    accumulators: Mapping[tuple[str, str], MetricAccumulator],
    fold_gaps: Sequence[GapRecord],
) -> dict[str, object]:
    """Finalize every resource and build the snapshot, through the collector's own path."""
    gaps: list[GapRecord] = [*plan.gaps, *fold_gaps]
    resources: list[ResourceSnapshot] = []

    for resource in plan.resources:
        entries, finalize_gaps = finalize_resource(
            resource_id=resource.record["resource_id"],
            fidelity_tier=resource.fidelity_tier,
            grain=plan.grain,
            declared=resource.declared,
            selected=resource.selected,
            accumulators=accumulators,
            derived_entries=resource.derived_entries,
            sku_capability_values=resource.sku_capability_values,
        )
        gaps.extend(finalize_gaps)
        resources.append(
            ResourceSnapshot(
                record={**resource.record, "fidelity_tier": resource.fidelity_tier},
                sku=resource.sku,
                statistics=(*entries, *resource.guest_entries),
                day_buckets=resource.day_buckets,
            )
        )

    return build_snapshot(
        run_id=plan.run_id,
        scope=plan.scope,
        scope_verified=plan.scope_verified,
        collected_at=plan.collected_at,
        timezone_name=plan.timezone_name,
        tz=plan.tz,
        window=plan.window,
        grain=plan.grain,
        metrics_by_resource_type=plan.metrics_by_resource_type,
        resources=resources,
        gaps=gaps,
        catalog_version=plan.catalog_version,
        raw_archive_complete=plan.archive_complete,
        raw_archive_object_count=plan.archive_object_count,
    )


# --------------------------------------------------------------------------- #
# Rebuilding the plan from what was stored
# --------------------------------------------------------------------------- #


def plan_from_snapshot(
    document: Mapping[str, object],
    *,
    catalog: LoadedCatalog,
    objects_named: int | None = None,
) -> ReplayPlan:
    """A `ReplayPlan` from the stored snapshot and the catalog it was collected under.

    Everything read here is structural — identity, geometry, capacity, scope — and nothing
    read here is a folded value. That distinction is Req 31.4's, and it is exactly the right
    one: the archive holds metric responses, so a recomputation has to learn the resource's
    name and its vCPU count from somewhere, and no archive of metric responses could supply
    them. What it must **not** learn from the snapshot is any average, extreme, percentile or
    digest — and it does not: every statistic in the stored document is discarded here, and
    the recomputation produces its own.

    The one judgement call is the gap partition, and :data:`RECOMPUTED_GAP_TYPES` documents
    it. Enhanced-tier guest statistics are carried over: they come from a Log Analytics query
    that is not archived and not replayable, and dropping them would make every
    enhanced-tier run report a mismatch.
    """
    resources = _as_mappings(document.get("resources"))
    requested = document.get("requested_scope")
    requested_map = requested if isinstance(requested, Mapping) else {}
    metrics_by_type = _metrics_by_resource_type(requested_map)
    window = _window_from(document)
    archive = document.get("raw_archive")
    archive_map = archive if isinstance(archive, Mapping) else {}

    # The lookup index is case-folded; `metrics_by_type` itself keeps the spelling the
    # snapshot recorded, because it is handed straight back to `build_snapshot` and a
    # re-cased `requested_scope` key would change the digest all by itself.
    folded = {key.casefold(): value for key, value in metrics_by_type.items()}
    plan_resources = tuple(
        _replay_resource(raw, catalog=catalog, metrics_by_type=folded)
        for raw in resources
    )
    carried = tuple(
        gap
        for gap in _as_mappings(document.get("gaps"))
        if str(gap.get("gap_type", "")) not in RECOMPUTED_GAP_TYPES
    )

    object_count = int(archive_map.get("object_count") or 0)
    return ReplayPlan(
        stored_snapshot_id=str(document.get("snapshot_id") or ""),
        run_id=str(document.get("run_id") or ""),
        scope=_scope_from(document, requested_map),
        scope_verified=bool(document.get("scope_verified")),
        collected_at=_instant(str(document.get("collected_at") or "")),
        timezone_name=str(document.get("timezone") or "UTC"),
        tz=ZoneInfo(str(document.get("timezone") or "UTC")),
        window=window,
        grain=str(document.get("grain") or ""),
        metrics_by_resource_type=metrics_by_type,
        resources=plan_resources,
        gaps=cast("tuple[GapRecord, ...]", carried),
        catalog_version=_catalog_version(document),
        archive_complete=bool(archive_map.get("complete")),
        archive_object_count=object_count,
        objects_named=object_count if objects_named is None else objects_named,
    )


def _replay_resource(
    raw: Mapping[str, object],
    *,
    catalog: LoadedCatalog,
    metrics_by_type: Mapping[str, tuple[str, ...]],
) -> ReplayResource:
    resource_type = str(raw.get("resource_type") or "")
    entry = catalog.for_resource_type(resource_type)
    declared = {metric.name: metric for metric in (entry.metrics if entry else ())}
    # Case-folded, for the same reason `LoadedCatalog.for_resource_type` is: Resource Graph
    # lowercases `type`, so a snapshot resource reads `microsoft.compute/virtualmachines`
    # while `requested_scope` carries the catalog's `Microsoft.Compute/virtualMachines`. An
    # exact lookup finds nothing for every real resource, and the replay then folds nothing,
    # recomputes an empty snapshot and reports a mismatch on a reproducible run.
    requested = metrics_by_type.get(resource_type.casefold(), ())
    sku_raw = raw.get("sku")
    sku_map = sku_raw if isinstance(sku_raw, Mapping) else {}
    sku = SkuCapacity(
        name=str(sku_map.get("name") or ""),
        vcpus_available=_optional_int(sku_map.get("vcpus_available")),
        memory_bytes=_optional_decimal(sku_map.get("memory_bytes")),
    )
    power_state = str(raw.get("power_state") or "")

    record: dict[str, object] = {
        "resource_id": str(raw.get("resource_id") or ""),
        "name": str(raw.get("name") or ""),
        "resource_type": resource_type,
        "location": str(raw.get("location") or ""),
        "resource_group": str(raw.get("resource_group") or ""),
        "tags": dict(raw.get("tags") or {}),  # type: ignore[arg-type]
        "power_state_raw": str(raw.get("power_state_raw") or ""),
        "power_state": power_state,
        "fidelity_tier": str(raw.get("fidelity_tier") or ""),
    }

    return ReplayResource(
        record=cast("ResourceRecord", record),
        resource_type=resource_type,
        fidelity_tier=str(raw.get("fidelity_tier") or ""),
        sku=sku,
        day_buckets=_day_buckets(raw.get("day_buckets")),
        declared=declared,
        # Intersected with what the catalog declares, in the requested order, so a metric
        # the requested scope names but the catalog no longer carries is skipped rather
        # than raising a `KeyError` inside the finalize.
        selected=tuple(name for name in requested if name in declared),
        derived_entries=tuple(entry.derived if entry else ()),
        sku_capability_values=_capability_values(
            entry.sku_capabilities if entry else (), sku
        ),
        # Req 20.6, 20.13 — the same exclusion the collector applied, recovered from the
        # normalized power state the snapshot records for exactly this kind of question.
        excluded=power_state in _EXCLUDED_POWER_STATES,
        guest_entries=_guest_entries(raw.get("statistics")),
    )


_EXCLUDED_POWER_STATES: Final[frozenset[str]] = frozenset(
    {GAP_TYPE_DEALLOCATED, GAP_TYPE_POWER_STATE_UNKNOWN, "deallocated", "unknown"}
)

_CAPABILITY_READERS: Final[tuple[tuple[str, str], ...]] = (
    ("vCPUsAvailable", "vcpus_available"),
    ("MemoryGB", "memory_bytes"),
)
"""How a catalog-declared capability name reads off a `SkuCapacity`.

`MemoryGB` reads `memory_bytes` — already converted from GiB — because the catalog's own
source binds that capability with `"unit": "bytes"`. Handing the GiB figure to the formula
would produce a plausible percentage wrong by a factor of 2**30, which is the kind of error
that survives review.
"""


def _capability_values(
    names: Sequence[str], sku: SkuCapacity
) -> dict[str, Decimal | None]:
    values: dict[str, Decimal | None] = dict.fromkeys(names)
    for capability, attribute in _CAPABILITY_READERS:
        if capability in values:
            raw = getattr(sku, attribute, None)
            values[capability] = None if raw is None else Decimal(raw)
    return values


def _guest_entries(raw: object) -> tuple[StatisticEntry, ...]:
    """The enhanced-tier statistics, carried over rather than recomputed.

    A guest counter comes from a Log Analytics query, which is not archived and cannot be
    replayed. Recomputing it is impossible; dropping it would make every enhanced-tier run
    report a mismatch on a snapshot that is perfectly reproducible in the part replay can
    actually check. It is identified by carrying a `workspace_id`, which only a guest
    counter does.
    """
    entries: list[StatisticEntry] = []
    for value in _as_mappings(raw):
        if not value.get("workspace_id"):
            continue
        entries.append(
            StatisticEntry(
                metric=str(value.get("metric") or ""),
                statistic=str(value.get("statistic") or ""),
                value=Decimal(str(value.get("value") or "0")),
                unit=str(value.get("unit") or ""),
                estimator=str(value.get("estimator") or ""),
                fidelity_tier=str(value.get("fidelity_tier") or ""),
                sample_count=int(value.get("sample_count") or 0),
                scale=_scale_of(str(value.get("value") or "0")),
                instance=_optional_str(value.get("instance")),
                counter=_optional_str(value.get("counter")),
                workspace_id=_optional_str(value.get("workspace_id")),
            )
        )
    return tuple(entries)


def _day_buckets(raw: object) -> tuple[ResourceDayBucket, ...]:
    return tuple(
        ResourceDayBucket(
            local_day=date.fromisoformat(str(bucket.get("local_day"))),
            slot_count=int(bucket.get("slot_count") or 0),
        )
        for bucket in _as_mappings(raw)
    )


def _window_from(document: Mapping[str, object]) -> Window:
    raw = document.get("window")
    window = raw if isinstance(raw, Mapping) else {}
    tz = ZoneInfo(str(document.get("timezone") or "UTC"))
    return resolve_window(
        date.fromisoformat(str(window.get("start"))),
        # The stored `local_end` is the window's last local day; `resolve_window` takes the
        # same value the collector handed it, so the round trip is exact.
        date.fromisoformat(str(window.get("end"))),
        tz,
    )


def _scope_from(
    document: Mapping[str, object], requested: Mapping[str, object]
) -> ScopeSpec:
    return cast(
        "ScopeSpec",
        {
            "subscription_id": str(document.get("subscription_id") or ""),
            "resource_types": [str(value) for value in requested.get("resource_types") or []],
            "resource_groups": [
                str(value) for value in requested.get("resource_groups") or []
            ],
            "tag_filters": dict(requested.get("tag_filters") or {}),  # type: ignore[arg-type]
        },
    )


def _metrics_by_resource_type(
    requested: Mapping[str, object],
) -> dict[str, tuple[str, ...]]:
    raw = requested.get("metrics_by_resource_type")
    if not isinstance(raw, Mapping):
        return {}
    return {
        str(resource_type): tuple(str(name) for name in names or [])
        for resource_type, names in raw.items()
    }


def _catalog_version(document: Mapping[str, object]) -> str:
    producer = document.get("producer")
    if isinstance(producer, Mapping):
        return str(producer.get("catalog_version") or "")
    return ""


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _as_mappings(raw: object) -> tuple[Mapping[str, object], ...]:
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return ()
    return tuple(item for item in raw if isinstance(item, Mapping))


def _optional_int(raw: object) -> int | None:
    return None if raw is None else int(str(raw))


def _optional_decimal(raw: object) -> Decimal | None:
    return None if raw is None else Decimal(str(raw))


def _optional_str(raw: object) -> str | None:
    return None if raw is None else str(raw)


def _scale_of(text: str) -> int:
    _, _, fraction = text.partition(".")
    return len(fraction)
