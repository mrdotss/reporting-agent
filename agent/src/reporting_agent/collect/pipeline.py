"""The collection pipeline: discover -> gate -> collect -> gate -> snapshot.

One function drives a whole collection — :func:`run_collection` — and it is deliberately
the only place in the runtime that sees the collection end to end. That is what lets three
decisions live here that no single collector module could make correctly:

| decision | why it needs the whole run |
|---|---|
| **the empty-scope gate** (Req 33.1, 33.5, 33.6) | it counts the *union* of every scope, after paging, before the first metric request |
| **the no-statistics gate** (Req 33.7) | "zero statistics" is a fact about every resource and every metric together |
| **the all-locations escalation** (Req 24.5) | one location being unreachable is a gap; *every* location being unreachable ends the run |
| **the per-resource fidelity tier** (Req 31.1, 31.2) | the subscription's tier is a ceiling, and the evidence that raises a resource to it is collected across two separate queries |

**This module reaches Azure only through `providers.base.Provider`** (Req 18.4). It
imports nothing from `azure/` — not the ports, not the region resolver, not the metrics
collector — and `tests/test_boundaries.py` enforces that with an AST scan (Req 18.5,
18.7). Everything it needs from a cloud arrives as plain data: the inventory, the
statistics, the gaps, the resolved SKU capacities, the raw-archive completeness marker
and the location routing. The last three are `NotRequired` keys on `CollectResult`
carried for exactly this reason — see that TypedDict's own docstring.

**It emits events; it does not emit terminal ones.** `main.run_invocation` owns the
single egress, the `done` event, the step closures and the exception -> terminal `error`
translation (Req 14.10, 14.14, 18.8). So a gate that fails here **raises** a typed
`AgentError` and the router turns it into one terminal `error` followed by `done`; a run
that completed with gaps raises `PartialCoverageError`, whose `terminal` is `False`, and
the router emits the non-terminal `error` and still reports the run `completed`
(Req 29.5). There is exactly one event type this module constructs itself —
`snapshot_ready` (Req 14.9, 35.7) — and every `tool` and `progress` event it yields comes
from the injected step tracker, so Req 14.7 and Req 14.8's invariants are enforced rather
than re-implemented.

**Two entry points, and only one of them decides what a gap means** (Req 41.1, 41.4).

* :func:`run_collection` collects and stops. It yields exactly the events described
  above and reports what the collection produced — the snapshot document, its
  `snapshot_id`, the resource and gap counts, the gaps themselves, `partial` and the
  raw-archive completeness marker — as a :class:`CollectionOutcome`. It raises for the
  three gates, because a gate is a fact about whether a collection happened at all, and
  it raises **nothing** for a run that merely carries gaps.
* :func:`run_generate_report` is a thin wrapper: it drives `run_collection` and, at the
  end, raises the non-terminal `PartialCoverageError` when the outcome is `partial`. A
  snapshot-only invocation therefore behaves exactly as it always has.

That split exists so the report pipeline can **defer** the partial-coverage raise past
compile, render, verify and upload. A run carrying gaps still completes and still
delivers its artifacts, so its non-terminal `PARTIAL_COVERAGE` event has to arrive before
`done` rather than before compilation — which is impossible if collection raises the
moment the snapshot is announced.

**How the outcome gets out, and why it is not a yielded item.** A Python async generator
cannot both yield events and `return` a value an `async for` can read, so
:func:`run_collection` takes a :class:`CollectionSink` and deposits the outcome on it as
its last act. The rejected alternative — yielding the outcome as the final item — was
rejected for a specific reason rather than on taste: every item this pipeline yields goes
through `main.emit`, which validates `type` against the declared event vocabulary, so a
consumer that forgot to filter the outcome out of the stream would emit an undeclared
event to the browser. A sink cannot be forgotten *into* the stream; it can only be
forgotten, and :meth:`CollectionSink.require` says so loudly.

The deposit happens **after** the final `yield`, so it lands only for a consumer that
drains the generator to exhaustion. A consumer that `break`s early leaves the sink empty,
which is the honest reading: it abandoned the collection, so there is no outcome.

**The order of the gates is not interchangeable.**

1. `discover` pages the inventory.
2. **The empty-scope gate** runs before the first metrics request, the first archive
   write and any snapshot write (Req 33.5) — which is structural here, because all three
   of those happen inside `collect` and `write_once`, both of which are called after it.
3. `collect` folds every metric response.
4. **The all-locations-unreachable escalation** (Req 24.5) runs before the no-statistics
   gate, because a run that reached no location at all also produced no statistic, and
   `REGION_UNREACHABLE` says which of the two happened while `NO_STATISTICS` does not.
5. **The no-statistics gate** (Req 33.7).
6. The snapshot is built, written once, and announced.
7. `PARTIAL_COVERAGE`, last, so it cannot pre-empt a terminal outcome — and, for a
   caller that has more phases to run, later still. :func:`run_collection` records
   `partial` on the outcome and raises nothing; the raise belongs to whoever owns the end
   of the run.

**What a `baseline` resource never does.** It issues no Log Analytics query and requests
no guest-observed metric (Req 31.3), so it emits no per-volume disk free space and no
guest-observed memory (Req 31.9). Both are structural rather than checked: the guest
query is issued only for the resources this run has evidence for, and there is no
platform metric for in-guest free space to request in the first place (Req 31.5) — the
Metric_Catalog declares none, and `capabilities()` is where the requested metric names
come from.
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import AsyncIterator, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from datetime import tzinfo as TzInfo
from decimal import Decimal, InvalidOperation
from types import MappingProxyType
from typing import Any, Final, Protocol, runtime_checkable

from reporting_agent.catalog.loader import (
    EnhancedCounterEntry,
    LoadedCatalog,
    load_catalog,
)
from reporting_agent.collect.accumulate import (
    AccumulatorResult,
    DerivedSourceRef,
    MetricAccumulator,
)
from reporting_agent.collect.buckets import (
    Window,
    choose_grain,
    day_buckets,
    resolve_timezone,
    resolve_window,
)
from reporting_agent.collect.log import (
    GAP_TYPE_INSTANCE_NAME_COLLAPSED,
    GAP_TYPE_METRIC_ERROR,
    GAP_TYPE_METRIC_NOT_SELECTED,
    GAP_TYPE_NO_SAMPLES,
    record_gap,
)
from reporting_agent.collect.snapshot import (
    FactEntry,
    ResourceDayBucket,
    ResourceSnapshot,
    SkuCapacity,
    StatisticEntry,
    build_snapshot,
    # Moved out of this module in task 4.4, and re-exported below so its existing callers
    # and their tests are untouched: `verify/replay.py` re-derives facts from the archive and
    # has to build the same `FactEntry` this pass builds, and replay may import only pure
    # modules — which this orchestrator is not.
    fact_from_plain,
    guest_counter_statistics,
    window_to_plain,
    write_once,
)
from reporting_agent.errors import (
    EmptyScopeError,
    NoStatisticsError,
    PartialCoverageError,
    RegionUnreachableError,
)
from reporting_agent.events import TOOL_COLLECT_INVENTORY, TOOL_COLLECT_METRICS
from reporting_agent.progress import ProgressReporter
from reporting_agent.providers import registry
from reporting_agent.providers.base import (
    GUEST_STATUS_EMPTY,
    GUEST_STATUS_OK,
    CollectRequest,
    DiscoverResult,
    FactCollectingProvider,
    FactRequest,
    GapRecord,
    GuestCounterOutcome,
    GuestCounterProvider,
    GuestCounterRequest,
    GuestCounterRow,
    GuestCounterSpec,
    PlainData,
    Provider,
    ResourceRecord,
    ScopeSpec,
    SkuCapacityRecord,
    StatValue,
)
from reporting_agent.storage.base import ObjectStore

__all__ = [
    "COLLAPSED_INSTANCE_NAME",
    "FIDELITY_BASELINE",
    "FIDELITY_ENHANCED",
    "PHASE_COLLECTING",
    "PROGRESS_UNIT_RESOURCES",
    "SNAPSHOT_READY_EVENT_TYPE",
    "CollectionOutcome",
    "CollectionSink",
    "RunPlan",
    "StepEvents",
    "assert_scope_not_empty",
    "assert_some_location_reachable",
    "assert_some_statistic",
    "distinct_resource_ids",
    "fact_from_plain",
    "resolve_run_plan",
    "run_collection",
    "run_generate_report",
    "sku_from_plain",
    "statistic_from_plain",
]

logger = logging.getLogger(__name__)

Event = dict[str, Any]

SNAPSHOT_READY_EVENT_TYPE: Final[str] = "snapshot_ready"
"""The one event type this module constructs (Req 14.9, 35.7). Spelled here rather than
imported from `events.py`'s sentinel block because that block is what the web app's mirror
guard compares against, and it carries the ten *declared* types; this is the single type
this module emits, and `main.emit` validates it against that vocabulary on the way out."""

PROGRESS_UNIT_RESOURCES: Final[str] = "resources"
"""The `unit` on every `progress` event this pipeline emits — the noun the UI renders as
`142 / 200 resources` (Req 14.8)."""

PHASE_COLLECTING: Final[str] = "collecting"
"""The one non-terminal phase this pipeline reports (Req 38.1). The terminal transition is
`main.run_invocation`'s to fire, because only it knows how the invocation ended."""

FIDELITY_BASELINE: Final[str] = "baseline"
FIDELITY_ENHANCED: Final[str] = "enhanced"
"""Mirrored **by value** from `azure/provider.py` and `azure/preflight.py` rather than
imported: this module may not import `azure/` at all (Req 18.5). The two spellings are
asserted equal in `tests/test_collect_pipeline.py`, so the mirror cannot drift silently —
the same deliberate non-coupling `azure/provider.py` itself draws against `preflight.py`."""

COLLAPSED_INSTANCE_NAME: Final[str] = "_Total"
"""The AMA regression's literal (Req 31.6). An `InstanceName` equal to this, absent, or
empty are **one fact with three spellings** — the per-drive instance collapsed — and all
three are treated identically, because a collector that only string-matched `_Total`
would sail straight past the empty-string recording of the same failure."""


# --- the step tracker, structurally (no import cycle) --------------------------------


@runtime_checkable
class StepEvents(Protocol):
    """The three operations this pipeline needs from the invocation's step tracker.

    Declared structurally rather than imported from `main.py`, which would be a cycle:
    `main` imports this module (lazily, inside its handler) to run the pipeline.
    `main.StepTracker` satisfies this protocol as written, and going through it — rather
    than building `tool` and `progress` dicts here — is what makes Req 14.7's start/end
    pairing and Req 14.8's `done <= total`, non-decreasing, references-an-open-step
    invariants enforced for this pipeline instead of merely intended by it.
    """

    def start(
        self, name: str, *, label: str, status: str, step_id: str | None = None
    ) -> Event: ...

    def progress(
        self,
        step_id: str,
        *,
        done: int,
        total: int,
        unit: str,
        label: str | None = None,
    ) -> Event: ...

    def end(self, step_id: str) -> Event: ...


# --- what a collection produced ------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CollectionOutcome:
    """Everything a completed collection produced, for a caller with phases still to run.

    Frozen, because it describes a snapshot that is itself immutable: the document has
    already been written once at this point (Req 34.9), so an outcome a later phase could
    edit would be a second, divergent reading of an artifact that cannot change.

    `partial` is `gap_count > 0`, spelled as its own field rather than left to every
    caller to re-derive: it is the single condition Req 29.5 attaches `PARTIAL_COVERAGE`
    to, and two callers computing it from the gap list is two places for the threshold to
    drift. `gaps` is the snapshot's **own** scrubbed gap list — the same array the
    `snapshot_ready` event carries (Req 29.9) — so a caller reading gaps here and a
    browser reading them off the event cannot disagree, and no unscrubbed Azure error
    message reaches a later phase.

    `raw_archive_complete` travels because replay depends on it (Req 26.12): a verifier
    handed an archive with a hole in it must be able to tell that from a run that wrote
    no archive at all, and the marker is decided during collection.
    """

    document: Mapping[str, PlainData]
    snapshot_id: str
    resource_count: int
    gap_count: int
    gaps: tuple[PlainData, ...]
    partial: bool
    raw_archive_complete: bool


@dataclass(slots=True)
class CollectionSink:
    """Where :func:`run_collection` deposits its :class:`CollectionOutcome`.

    Mutable and deliberately trivial. An async generator cannot both yield events and
    return a value to an `async for`, and this is the shape chosen over yielding the
    outcome as a final pseudo-event — see the module docstring for why that alternative
    is a hazard rather than a preference.

    Written exactly once, after the last event, by a generator driven to exhaustion.
    """

    outcome: CollectionOutcome | None = None

    def require(self) -> CollectionOutcome:
        """The outcome, or `RuntimeError` naming the one way it can be missing.

        Loud rather than `None`-returning: a caller reaching for the snapshot id of a
        collection it abandoned has a bug in how it drove the generator, and a `None`
        flowing on from here would surface minutes later as a missing artifact.
        """
        if self.outcome is None:
            raise RuntimeError(
                "no collection outcome was recorded: `run_collection` deposits it after "
                "its last event, so this sink belongs to a generator that was not driven "
                "to exhaustion, or to one that raised"
            )
        return self.outcome


# --- the resolved run ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RunPlan:
    """Everything the pipeline needs, resolved from the payload and the context once.

    Frozen, and resolved before any Azure call, so an unresolvable timezone or an inverted
    period fails with **no metric request and no snapshot** (Req 25.9) rather than halfway
    through a collection.
    """

    actor_id: str
    run_id: str
    subscription_id: str
    scope: ScopeSpec
    timezone_name: str
    tz: TzInfo
    window: Window
    grain: str
    fidelity_ceiling: str
    workspace_id: str | None
    scope_verified: bool


def resolve_run_plan(
    payload: Mapping[str, PlainData], context: Mapping[str, PlainData]
) -> RunPlan:
    """Resolve one `generate_report` invocation into a :class:`RunPlan`.

    The window is half-open, from the **local** dates the payload's `period` names,
    resolved in the run's timezone and converted to UTC (Req 25.7); the grain is derived
    from the offsets actually in effect across that window, never from a zone name
    (Req 25.1, 25.5, 25.6). An absent or empty `timezone` resolves to `Asia/Jakarta`
    (Req 25.4) and one that names no IANA zone raises, before anything is requested
    (Req 25.9).

    `scope_verified` is `True` unless the context says otherwise, and that is not an
    assumption this module makes idly: Req 39.10 has the Reaper fail a run whose
    subscription carries `scope_verified` false **with no AgentCore invocation at all**, so
    an invoked run is one whose scope was proven. Recording it on the snapshot (Req 35.2)
    is therefore recording a fact about how this process came to be running, and the
    context is read first anyway so a future field needs no change here.
    """
    actor_id = _required_text(context, "actor_id")
    run_id = _required_text(context, "run_id")
    subscription_id = _required_text(context, "subscription_id")

    timezone_raw = context.get("timezone")
    tz = resolve_timezone(timezone_raw)
    timezone_name = str(tz)

    period = payload.get("period")
    if not isinstance(period, Mapping):
        raise ValueError(
            "the generate_report payload carries no `period` object; a run needs the "
            "local start and end dates it is about"
        )
    window = resolve_window(
        _local_date(period.get("start"), "start"),
        _local_date(period.get("end"), "end"),
        tz,
    )
    grain = choose_grain(window, tz)

    raw_scope = payload.get("scope")
    scope_map: Mapping[str, PlainData] = raw_scope if isinstance(raw_scope, Mapping) else {}
    scope = ScopeSpec(
        subscription_id=subscription_id,
        resource_types=_text_list(scope_map.get("resource_types")),
        resource_groups=_text_list(scope_map.get("resource_groups")),
        tag_filters=_text_map(scope_map.get("tag_filters")),
    )

    ceiling = context.get("fidelity_tier")
    workspace = context.get("log_analytics_workspace_id")
    verified = context.get("scope_verified")

    return RunPlan(
        actor_id=actor_id,
        run_id=run_id,
        subscription_id=subscription_id,
        scope=scope,
        timezone_name=timezone_name,
        tz=tz,
        window=window,
        grain=grain,
        fidelity_ceiling=(
            FIDELITY_ENHANCED if ceiling == FIDELITY_ENHANCED else FIDELITY_BASELINE
        ),
        workspace_id=(
            workspace.strip() if isinstance(workspace, str) and workspace.strip() else None
        ),
        scope_verified=verified is not False,
    )


def _required_text(context: Mapping[str, PlainData], field_name: str) -> str:
    """One required context string, or `ValueError` naming the field and never its value.

    `actor_id` and `run_id` prefix and name every artifact this run writes and `run_id`
    is what the progress callback addresses, so there is no safe default for any of the
    three (Req 26.8, 35.6).
    """
    value = context.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"the invocation context carries no usable {field_name}; the offending "
            f"value is excluded from this message"
        )
    return value


def _local_date(value: object, field_name: str) -> date:
    """One `YYYY-MM-DD` local date from the payload's `period`.

    `date.fromisoformat` and nothing looser: a period is the thing the whole report is
    about, so a value this cannot read is refused rather than guessed at.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"period.{field_name} must be a YYYY-MM-DD local date, got {value!r}"
        )
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(
            f"period.{field_name} is not a readable YYYY-MM-DD local date: {value!r}"
        ) from exc


def _text_list(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    return [item for item in value if isinstance(item, str) and item.strip()]


def _text_map(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        key: item
        for key, item in value.items()
        if isinstance(key, str) and isinstance(item, str)
    }


# --- the gates -----------------------------------------------------------------------


def distinct_resource_ids(resources: Iterable[ResourceRecord]) -> int:
    """How many distinct resource ids an inventory holds (Req 33.6).

    Counted over a set of ids rather than as `len(resources)`, so "distinct resource ids
    remaining after `duplicate_inventory_row` de-duplication" is true of this count by
    construction and not merely because the collector happens to de-duplicate upstream.

    **Nothing is filtered.** A resource carrying a `deallocated`, `power_state_unknown` or
    `permission_denied` gap is in the inventory (Req 20.10) and is counted, which is
    exactly Req 33.6's point: a subscription whose virtual machines are all stopped has
    resources, so it is a report with no measurements rather than an `EMPTY_SCOPE`
    failure. The gaps are a separate list and no code path here consults them.
    """
    return len({resource["resource_id"] for resource in resources})


def assert_scope_not_empty(plan: RunPlan, resources: Sequence[ResourceRecord]) -> None:
    """Req 33.1, 33.2, 33.5, 33.6 — the empty-scope gate.

    Raised **after** inventory paging and **before** the first metrics request, the first
    archive write and any snapshot write, which the call order in
    :func:`run_generate_report` makes structural: everything those three describe happens
    inside `collect` and `write_once`, both called later.

    Terminal, and a failure rather than a warning or a gap (Req 33.2) — whatever the cause
    (Req 33.1). An expired client secret and a Reader assignment made below subscription
    scope both present as zero resources, and both would otherwise produce a clean,
    fully-verified, **empty** artifact: zero resources means zero figures, which means zero
    unverifiable figures, which is a pass on every other gate.
    """
    count = distinct_resource_ids(resources)
    if count > 0:
        return
    raise EmptyScopeError(
        f"the union of all scopes for this run resolved to zero resources in "
        f"subscription {plan.subscription_id} for {plan.window.local_start.isoformat()} "
        f"to {plan.window.local_end.isoformat()}: no metric was requested, no raw object "
        f"was archived and no snapshot was written. Check whether the client secret has "
        f"expired and whether the Reader assignment was made at subscription scope "
        f"rather than on a resource group."
    )


def assert_some_location_reachable(
    plan: RunPlan, locations: Mapping[str, PlainData] | None
) -> None:
    """Req 24.5 — terminal `REGION_UNREACHABLE` only when **every** location is unreachable.

    One unreachable location is a `region_unreachable` gap per resource and a non-terminal
    code (Req 24.4): a run that collected three regions out of four is a report with a
    visible hole, which is honest and useful. Every location unreachable is a different
    fact — there is nothing left to collect — and `RegionUnreachableError` is the one
    escalatable error in the vocabulary for exactly this reason.

    Read from `CollectResult`'s plain-data `locations` rather than from the region
    resolver, which lives in `azure/` and this module may not import. An absent key means
    the provider reports no regional routing at all, and there is nothing to escalate from
    a fact nobody claimed.
    """
    if not isinstance(locations, Mapping):
        return
    requested = set(_text_list(locations.get("requested")))
    unreachable = set(_text_list(locations.get("unreachable")))
    if not requested or not requested <= unreachable:
        return
    raise RegionUnreachableError(
        f"every location this run requested resolved unreachable "
        f"({', '.join(sorted(requested))}): neither the regional batch metrics endpoint "
        f"nor the per-resource ARM fallback answered for any of them, so no statistic "
        f"was collected for subscription {plan.subscription_id} and no snapshot was "
        f"written.",
        terminal=True,
    )


def assert_some_statistic(
    plan: RunPlan,
    statistics: Mapping[str, Mapping[str, Mapping[str, StatValue]]],
    gaps: Sequence[GapRecord] = (),
) -> None:
    """Req 33.7 — at least one resource resolved, and zero statistics across all of them.

    A distinct terminal code, not a variation of `EMPTY_SCOPE` and not a
    `PARTIAL_COVERAGE`: resources *were* found and nothing about them was measurable,
    which points at a different cause than an empty scope does. A snapshot carrying
    resources and no statistics reaches the same worthless artifact the empty-scope gate
    exists to prevent, so it is refused on the same terms.

    **The gap summary is in the message because this is the one failure that destroys its
    own evidence.** Every reason a metric produced nothing — a per-resource 403 arriving
    at HTTP 200, `metric_not_emitted`, `no_samples`, `interval_counts_missing` — is
    recorded in the `collection_log`, and the `collection_log` lives on the snapshot.
    Raising here means no snapshot is written, so without this the entire diagnosis is
    discarded at the moment it becomes most useful and the operator is left with "nothing
    was collected" and a subscription id.

    Types and counts only, never a message: a gap message can quote a service error, and
    this string reaches a log line and a `report_runs` row. `sibling
    assert_all_locations_reachable` already names its locations for the same reason — an
    unactionable terminal error is a support ticket.
    """
    if any(
        metric_values
        for resource_values in statistics.values()
        for metric_values in resource_values.values()
    ):
        return

    counted = Counter(
        str(gap.get("gap_type") or "unclassified") for gap in gaps
    )
    detail = (
        ", ".join(f"{gap_type} x{count}" for gap_type, count in sorted(counted.items()))
        if counted
        else "and the collection_log recorded no gap either, so nothing explains the "
        "absence — the metrics were requested and answered with no data point"
    )

    raise NoStatisticsError(
        f"the collection produced no statistic for any resource or any metric in "
        f"subscription {plan.subscription_id}, although at least one resource resolved "
        f"in scope: no snapshot was written, because a snapshot carrying resources and "
        f"no statistics is indistinguishable downstream from a measured one. The "
        f"collection_log this run would have carried: {detail}."
    )


# --- plain data -> the typed objects the Snapshot_Builder takes ----------------------
#
# The provider boundary is plain data (Req 18.3) and `collect/snapshot.py` builds its
# document from typed objects, so something has to bridge the two. It is here, in the
# pipeline, rather than in `snapshot.py`: the round trip exists *because* of the protocol
# boundary, which is a pipeline concern, and the hashing module is better left alone.
#
# The round trip is exact, not approximate. Each `StatValue` is precisely one
# `StatisticEntry.to_plain_data()`, whose `value` is rendered by `decimal_string` at the
# catalog-declared scale — plain notation, trailing zeros retained — so the count of
# digits after the decimal point **is** that scale, and re-rendering the parsed `Decimal`
# at it reproduces the identical string. `tests/test_collect_pipeline.py` asserts that
# equality directly rather than trusting this paragraph.


def _scale_of(text: str) -> int:
    """The scale a decimal string was rendered at: its count of fractional digits."""
    _, _, fraction = text.partition(".")
    return len(fraction)


def statistic_from_plain(value: StatValue, *, fidelity_tier: str) -> StatisticEntry:
    """One `StatValue` back as the `StatisticEntry` it was rendered from.

    `fidelity_tier` is **overridden** rather than read from the value, and that override is
    the whole reason this function takes an argument at all: the provider stamps the
    *subscription's* tier on every value it produces (it holds the ceiling and nothing
    else), while Req 31.2 requires a value's tier to equal the tier resolved for its
    resource — which, for a resource this run downgraded, is not the same string. One
    assignment, in one place, is what keeps "no value carries a tier its resource does
    not" true of the whole document.

    Raises `ValueError` naming the field for a malformed value. A provider handing back a
    statistic missing its `value`, `unit` or `estimator` is a bug in that provider, and
    substituting a default would put a number with no provenance into an audit artifact.
    """
    text = _required_field(value, "value", str)
    try:
        decimal = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError(
            f"statistic value {text!r} is not a decimal string; every metric value is a "
            f"fixed-precision decimal string end to end (Req 34.1)"
        ) from exc

    return StatisticEntry(
        metric=_required_field(value, "metric", str),
        statistic=_required_field(value, "statistic", str),
        value=decimal,
        unit=_required_field(value, "unit", str),
        estimator=_required_field(value, "estimator", str),
        fidelity_tier=fidelity_tier,
        sample_count=_required_field(value, "sample_count", int),
        scale=_scale_of(text),
        estimated=_optional(value, "estimated", bool),
        label=_optional(value, "label", str),
        counter_scope=_optional(value, "counter_scope", str),
        interval=_optional(value, "interval", str),
        observation=_optional(value, "observation", str),
        note=_optional(value, "note", str),
        formula=_optional(value, "formula", str),
        derived_from=_refs_from_plain(value.get("derived_from")),
        instance=_optional(value, "instance", str),
        counter=_optional(value, "counter", str),
        workspace_id=_optional(value, "workspace_id", str),
    )


def _refs_from_plain(value: object) -> tuple[DerivedSourceRef, ...]:
    """A derived value's `derived_from` array back as ordered `DerivedSourceRef`s.

    Order is preserved exactly as it arrived: Req 30.2 requires the list to be ordered
    identically for every value of one derived statistic, and re-sorting it here would
    substitute this module's ordering for the catalog's.
    """
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    refs: list[DerivedSourceRef] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        refs.append(
            DerivedSourceRef(
                kind=_required_field(item, "kind", str),
                name=_required_field(item, "name", str),
                statistic=_optional(item, "statistic", str),
                value=_optional(item, "value", str),
                unit=_optional(item, "unit", str),
            )
        )
    return tuple(refs)


def sku_from_plain(record: SkuCapacityRecord | None, *, sku_name: str) -> SkuCapacity:
    """The SKU capacity for one resource, from the provider's plain-data record.

    Falls back to the SKU name on the inventory record when the provider resolved no
    capacity — a resource excluded from every average, or one whose type declares no SKU
    capabilities. The name is the one fact known about it, and the omitted capacities are
    already explained by a `sku_unknown` or `sku_capability_missing` gap; emitting a zero
    for either would read as a measured capacity of nothing (Req 21.8).
    """
    if not isinstance(record, Mapping):
        return SkuCapacity(name=sku_name)
    vcpus = record.get("vcpus_available")
    memory = record.get("memory_bytes")
    return SkuCapacity(
        name=_required_field(record, "name", str),
        vcpus_available=int(vcpus) if isinstance(vcpus, str) and vcpus.strip() else None,
        memory_bytes=(
            Decimal(memory) if isinstance(memory, str) and memory.strip() else None
        ),
    )


def _required_field(source: Mapping[str, Any], name: str, kind: type) -> Any:
    value = source.get(name)
    # `bool` is a subclass of `int`, and `True` is not a sample count.
    if kind is int and isinstance(value, bool):
        value = None
    if not isinstance(value, kind):
        raise ValueError(
            f"a provider-supplied value carries no usable {name!r} of type "
            f"{kind.__name__}; the offending value is excluded from this message"
        )
    return value


def _optional(source: Mapping[str, Any], name: str, kind: type) -> Any | None:
    value = source.get(name)
    if kind is not bool and isinstance(value, bool):
        return None
    return value if isinstance(value, kind) else None


# --- the enhanced tier (Req 31.1-31.9) ----------------------------------------------


@dataclass(frozen=True, slots=True)
class _GuestOutcomeReading:
    """What one guest-counter outcome resolved to: a tier, some entries, some gaps."""

    enhanced: bool
    entries: tuple[StatisticEntry, ...]
    gaps: tuple[GapRecord, ...]


def _counters_for(catalog: LoadedCatalog, resource_type: str) -> tuple[GuestCounterSpec, ...]:
    """The guest-observed counters the catalog declares for one resource type (Req 31.4).

    **Exactly** what the catalog declares — the specs are built from its entries, so there
    is no counter this pipeline could ask for that the catalog does not name, and no way
    to ask for a subset of the ones it does.
    """
    entry = catalog.for_resource_type(resource_type)
    if entry is None:
        return ()
    return tuple(
        GuestCounterSpec(
            statistic_id=counter.statistic_id,
            object=counter.object,
            counter=counter.counter,
            per_instance=counter.per_instance,
            unit=counter.unit,
            scale=counter.scale,
        )
        for counter in entry.enhanced_counters
    )


def _enhanced_entry(
    catalog: LoadedCatalog, resource_type: str, statistic_id: str
) -> EnhancedCounterEntry | None:
    entry = catalog.for_resource_type(resource_type)
    if entry is None:
        return None
    for counter in entry.enhanced_counters:
        if counter.statistic_id == statistic_id:
            return counter
    return None


def _is_collapsed(instance_name: str | None) -> bool:
    """Req 31.6's condition: `_Total`, absent, or empty — one fact, three spellings."""
    if instance_name is None:
        return True
    stripped = instance_name.strip()
    return not stripped or stripped == COLLAPSED_INSTANCE_NAME


def _read_guest_outcome(
    outcome: GuestCounterOutcome,
    *,
    entry: EnhancedCounterEntry,
    per_instance: bool,
) -> _GuestOutcomeReading:
    """One `(resource, counter)` outcome, as a tier verdict plus values and gaps.

    Four cases, and each one is a requirement rather than a judgement call:

    * **failed / rejected** (Req 31.7) — `baseline`, one `metric_error` gap, run continues.
    * **zero rows in the window** (Req 31.7) — `baseline`, one `no_samples` gap. Distinct
      from a failure: the query ran and the counter is not being collected.
    * **a collapsed `InstanceName` where per-volume rows were requested** (Req 31.6) — one
      `instance_name_collapsed` gap and **no value at all**, neither per-volume nor
      resource-level. A single collapsed row disqualifies the whole `(resource, counter)`
      pair, which is the criterion's own wording ("emit no per-volume free-space value for
      that resource"), and the safe reading besides: attributing one volume's free space to
      a named volume, or to the whole machine, is an error that survives review by looking
      reasonable. The tier stays `enhanced` — rows came back, so the agent *is* delivering,
      and Req 31.7's three downgrade triggers are failure, rejection and zero rows, none of
      which this is.
    * **usable rows** (Req 31.4) — `enhanced`, one value set per volume (or one for the
      resource, for a counter that is not per-instance), each recording the counter name
      and the workspace id it came from.
    """
    resource_id = outcome["resource_id"]
    status = outcome["status"]
    message = outcome.get("message") or "the guest-observed counter query produced nothing"
    counter = outcome["counter"]

    if status == GUEST_STATUS_EMPTY:
        return _GuestOutcomeReading(
            enhanced=False,
            entries=(),
            gaps=(
                record_gap(
                    GAP_TYPE_NO_SAMPLES,
                    resource_id,
                    entry.statistic_id,
                    f"the guest-observed counter {counter!r} returned no row inside the "
                    f"collection window, so this resource collects at the baseline tier "
                    f"and emits no guest-observed value: {message}",
                ),
            ),
        )

    if status != GUEST_STATUS_OK:
        return _GuestOutcomeReading(
            enhanced=False,
            entries=(),
            gaps=(
                record_gap(
                    GAP_TYPE_METRIC_ERROR,
                    resource_id,
                    entry.statistic_id,
                    f"the guest-observed counter {counter!r} could not be read, so this "
                    f"resource collects at the baseline tier and emits no "
                    f"guest-observed value: {message}",
                ),
            ),
        )

    rows = outcome["rows"]
    if per_instance and any(_is_collapsed(row["instance_name"]) for row in rows):
        return _GuestOutcomeReading(
            enhanced=True,
            entries=(),
            gaps=(
                record_gap(
                    GAP_TYPE_INSTANCE_NAME_COLLAPSED,
                    resource_id,
                    entry.statistic_id,
                    f"at least one {counter!r} row carries an InstanceName that is "
                    f"{COLLAPSED_INSTANCE_NAME!r}, absent or empty where per-volume rows "
                    f"were requested, so no per-volume value and no resource-level value "
                    f"is emitted for this resource: attributing one volume's reading to a "
                    f"named volume or to the whole machine is an error that survives "
                    f"review by looking reasonable.",
                ),
            ),
        )

    entries: list[StatisticEntry] = []
    gaps: list[GapRecord] = []
    for instance, instance_rows in _rows_by_instance(rows, per_instance=per_instance):
        result, gap = _fold_guest_rows(
            instance_rows, resource_id=resource_id, statistic_id=entry.statistic_id
        )
        if gap is not None:
            gaps.append(gap)
        if result is None:
            continue
        entries.extend(
            guest_counter_statistics(
                result,
                entry=entry,
                fidelity_tier=FIDELITY_ENHANCED,
                counter=counter,
                workspace_id=outcome["workspace_id"],
                instance=instance,
            )
        )

    return _GuestOutcomeReading(
        enhanced=True, entries=tuple(entries), gaps=tuple(gaps)
    )


def _rows_by_instance(
    rows: Sequence[GuestCounterRow], *, per_instance: bool
) -> list[tuple[str | None, list[GuestCounterRow]]]:
    """Rows grouped by volume, in **sorted instance order** (Req 34.8's principle).

    Sorted here rather than left in arrival order, because two volumes' values share a
    `(metric, statistic)` pair and the snapshot's array order must be produced rather than
    inherited from whichever order Log Analytics returned the rows in.

    A counter that is not per-instance yields one group keyed `None`: its value is about
    the resource, and giving it an instance name would invent a dimension the counter does
    not have.
    """
    if not per_instance:
        return [(None, list(rows))]
    grouped: dict[str, list[GuestCounterRow]] = {}
    for row in rows:
        name = (row["instance_name"] or "").strip()
        grouped.setdefault(name, []).append(row)
    return [(name, grouped[name]) for name in sorted(grouped)]


def _fold_guest_rows(
    rows: Sequence[GuestCounterRow], *, resource_id: str, statistic_id: str
) -> tuple[AccumulatorResult | None, GapRecord | None]:
    """Fold one volume's rows into an exact avg/min/max.

    Each row is **one sample**, so it folds as a one-sample interval: `total` is the
    reading, `count` is 1, and `minimum` and `maximum` are the reading itself. That reuses
    `collect/accumulate.py`'s count-weighted machinery verbatim rather than adding a second
    averaging path — Req 27.1's rule and Req 27.2's prohibition apply to a guest average
    exactly as they do to a platform one, and the accumulator is the only code in this
    package allowed to compute either.

    No sketch is attached: `EnhancedCounterEntry` declares no percentiles, so there is no
    percentile to estimate and nothing to fold one into.
    """
    accumulator = MetricAccumulator(sketch=None)
    for row in rows:
        try:
            reading = Decimal(row["value"])
        except (InvalidOperation, TypeError):
            logger.warning(
                "a %s row for %s carries an unreadable value and was not folded.",
                statistic_id,
                resource_id,
            )
            continue
        accumulator.fold_interval(
            total=reading,
            count=Decimal(1),
            minimum=reading,
            maximum=reading,
            resource_id=resource_id,
            metric=statistic_id,
        )
    return accumulator.finalize(resource_id, statistic_id)


async def _resolve_fidelity(
    *,
    plan: RunPlan,
    provider: Provider,
    catalog: LoadedCatalog,
    resources: Sequence[ResourceRecord],
) -> tuple[dict[str, str], dict[str, tuple[StatisticEntry, ...]], list[GapRecord]]:
    """Resolve each resource's `fidelity_tier` from this run's evidence (Req 31.1).

    Returns the tier per resource id, the guest-observed values per resource id, and every
    gap the guest queries recorded.

    **The subscription's tier is a ceiling, and every resource starts at `baseline`.** A
    resource is raised to `enhanced` only by evidence collected *for that resource during
    this run* — never on the strength of the connection, which is precisely what Req 31.1's
    ceiling wording rules out.

    A `baseline` ceiling therefore issues **no Log Analytics query at all** (Req 31.3), and
    neither does a run whose provider does not offer the guest-counter surface or whose
    catalog declares no counters for the resource types in scope. In each of those cases
    every resource stays `baseline` and emits no per-volume free space and no guest-observed
    memory (Req 31.9) — structurally, because nothing was ever queried to build one from.
    """
    tiers = dict.fromkeys(
        (resource["resource_id"] for resource in resources), FIDELITY_BASELINE
    )
    entries: dict[str, tuple[StatisticEntry, ...]] = {}
    gaps: list[GapRecord] = []

    if plan.fidelity_ceiling != FIDELITY_ENHANCED:
        return tiers, entries, gaps

    if not isinstance(provider, GuestCounterProvider):
        logger.info(
            "the connected subscription's fidelity tier is %s but this provider offers no "
            "guest-observed counter surface; every resource collects at %s.",
            FIDELITY_ENHANCED,
            FIDELITY_BASELINE,
        )
        return tiers, entries, gaps

    by_type: dict[str, list[ResourceRecord]] = {}
    for resource in resources:
        by_type.setdefault(resource["resource_type"], []).append(resource)

    for resource_type in sorted(by_type):
        specs = _counters_for(catalog, resource_type)
        if not specs:
            continue
        result = await provider.collect_guest_counters(
            GuestCounterRequest(
                resources=by_type[resource_type],
                counters=list(specs),
                window=window_to_plain(plan.window),
                workspace_id=plan.workspace_id or "",
            )
        )
        per_instance = {spec["statistic_id"]: spec["per_instance"] for spec in specs}
        for outcome in result["outcomes"]:
            entry = _enhanced_entry(catalog, resource_type, outcome["statistic_id"])
            if entry is None:  # pragma: no cover - specs come from this same catalog
                continue
            reading = _read_guest_outcome(
                outcome,
                entry=entry,
                per_instance=per_instance.get(outcome["statistic_id"], False),
            )
            resource_id = outcome["resource_id"]
            if reading.enhanced:
                tiers[resource_id] = FIDELITY_ENHANCED
            if reading.entries:
                entries[resource_id] = entries.get(resource_id, ()) + reading.entries
            gaps.extend(reading.gaps)

    return tiers, entries, gaps


# --- the pipeline --------------------------------------------------------------------


async def run_generate_report(
    *,
    payload: Mapping[str, PlainData],
    context: Mapping[str, PlainData],
    steps: StepEvents,
    artifact_bucket: str,
    aws_region: str | None = None,
    progress: ProgressReporter | None = None,
    provider: Provider | None = None,
    object_store: ObjectStore | None = None,
    catalog: LoadedCatalog | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> AsyncIterator[Event]:
    """Run one snapshot-only `generate_report` invocation, yielding its events.

    A thin wrapper over :func:`run_collection` that owns exactly one decision the
    collection itself no longer makes: **a run that ends here and carries gaps raises the
    non-terminal `PartialCoverageError`** (Req 29.5). It ends here, so the raise is last,
    and a caller with compile, render and verify still ahead of it drives
    :func:`run_collection` directly and raises at the end of *its* run instead (Req 41.4).

    Yields, in order: the `collect_inventory` step and its determinate `progress`, the
    `collect_metrics` step and its `progress`, and exactly one `snapshot_ready` (Req 14.9).
    `done` is not yielded here — `main.run_invocation` emits it last, on every path
    (Req 14.10), after closing any step this pipeline left open (Req 14.14).

    Raises rather than emitting a terminal `error` itself (Req 18.8): `EmptyScopeError`,
    `NoStatisticsError` and a terminal `RegionUnreachableError` for the three gates, and
    `PartialCoverageError` — non-terminal — last, when the run completed carrying at least
    one gap. The router owns the translation to an `error` event, so there is one place in
    the process where an exception becomes a terminal stream.

    Every argument is forwarded untouched; see :func:`run_collection` for what each one is.
    """
    sink = CollectionSink()
    async for event in run_collection(
        payload=payload,
        context=context,
        steps=steps,
        artifact_bucket=artifact_bucket,
        aws_region=aws_region,
        progress=progress,
        provider=provider,
        object_store=object_store,
        catalog=catalog,
        now=now,
        sink=sink,
    ):
        yield event

    # The gates raise from inside `run_collection`, so reaching here means the collection
    # completed and the snapshot is written and announced. `require()` cannot fail on this
    # path: the `async for` above drove the generator to exhaustion.
    outcome = sink.require()
    if outcome.partial:
        raise PartialCoverageError(
            f"this run completed with {outcome.gap_count} recorded collection_log "
            f"{'entry' if outcome.gap_count == 1 else 'entries'}: the report is complete "
            f"and the gaps are recorded on its snapshot rather than zero-filled."
        )


async def run_collection(
    *,
    payload: Mapping[str, PlainData],
    context: Mapping[str, PlainData],
    steps: StepEvents,
    artifact_bucket: str,
    sink: CollectionSink,
    aws_region: str | None = None,
    progress: ProgressReporter | None = None,
    provider: Provider | None = None,
    object_store: ObjectStore | None = None,
    catalog: LoadedCatalog | None = None,
    metric_selection: Mapping[str, Sequence[str]] | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> AsyncIterator[Event]:
    """Collect one run into an immutable snapshot, yielding its non-terminal events.

    Yields exactly what :func:`run_generate_report` yields — it is the same sequence,
    produced here — and deposits a :class:`CollectionOutcome` on `sink` as its last act,
    after the final event (Req 41.1). **It raises nothing for a run that merely carries
    gaps**: `partial` is recorded on the outcome and the decision of what that means
    belongs to whoever owns the end of the run (Req 41.4).

    It still raises for the three gates, and that asymmetry is the point. A gate is a fact
    about whether a usable collection happened at all — an empty scope, no reachable
    location, no statistic anywhere — so there is nothing for a later phase to compile and
    no useful deferral available. Gaps are the opposite: the collection succeeded and the
    holes in it are recorded on the snapshot, so a report built from it is deliverable.

    `artifact_bucket` and `aws_region` come from the process configuration the entrypoint
    built once at start (Req 14.12); nothing here reads an environment variable. `provider`,
    `object_store` and `catalog` are injectable so the whole pipeline runs against the fake
    Azure ports and an in-memory store, with no SDK, no credential and no subscription.

    `metric_selection` is Req 5.4's narrowing — per resource type, the platform metric names
    the pinned template version selected, already expanded from its derived statistics and
    already carrying every top-N ranking metric. It is `None` for a snapshot-only run, which
    has no pinned version to narrow by; see :func:`_requested_metrics`.
    """
    plan = resolve_run_plan(payload, context)
    loaded = catalog if catalog is not None else load_catalog()
    store = (
        object_store
        if object_store is not None
        else _s3_store(artifact_bucket, aws_region)
    )

    if provider is not None:
        # Injected: the caller owns its lifetime, and closing it here would discard caches
        # a test may be about to assert on.
        async for event in _drive(
            plan=plan,
            provider=provider,
            store=store,
            catalog=loaded,
            metric_selection=metric_selection,
            steps=steps,
            progress=progress,
            now=now,
            sink=sink,
        ):
            yield event
        return

    built = registry.build(
        registry.AZURE_PROVIDER_ID, context, object_store=store, catalog=loaded
    )
    try:
        async for event in _drive(
            plan=plan,
            provider=built,
            store=store,
            catalog=loaded,
            metric_selection=metric_selection,
            steps=steps,
            progress=progress,
            now=now,
            sink=sink,
        ):
            yield event
    finally:
        # Req 19.4, 21.11 — release the run's credential and its SKU listing cache
        # deliberately at run end rather than whenever the garbage collector notices. SKU
        # restrictions are subscription-scoped and this container serves more than one
        # customer, so a cache outliving its run is a cache that could answer for the
        # wrong subscription. On the raising path too: a failed gate still ends a run.
        _close_quietly(built)


async def _drive(
    *,
    plan: RunPlan,
    provider: Provider,
    store: ObjectStore,
    catalog: LoadedCatalog,
    metric_selection: Mapping[str, Sequence[str]] | None,
    steps: StepEvents,
    progress: ProgressReporter | None,
    now: Callable[[], datetime],
    sink: CollectionSink,
) -> AsyncIterator[Event]:
    """The orchestration itself, over an already-resolved plan and an already-built provider.

    Separated from :func:`run_collection` only so that function can own the provider's
    lifetime without wrapping this whole sequence in a `try` — the ordering here is the
    thing to read, and an indentation level of bookkeeping around it does not help.
    """
    active = provider
    loaded = catalog
    # Read **before** the first request, so every fact this run collects is stamped at or after
    # it. Reading it beside the snapshot build instead would produce a lower bound later than
    # the facts it is supposed to contain, and the check would reject every correct run.
    invocation_started_at = now()

    await _report(progress, PHASE_COLLECTING, label="Inventory")

    # --- inventory (Req 14.7, 20.x) --------------------------------------------------
    inventory_step = steps.start(
        TOOL_COLLECT_INVENTORY, label="Inventory", status="Enumerating resources"
    )
    yield inventory_step
    discovered = await active.discover(plan.scope)
    resources = list(discovered["resources"])
    gaps: list[GapRecord] = list(discovered["gaps"])
    total = distinct_resource_ids(resources)
    if total:
        # A determinate bar needs a positive total, and a step with nothing to count emits
        # no `progress` event at all rather than a `0 / 0` the UI would render as a bar
        # that means nothing (Req 14.8). The gate below is about to end the run anyway.
        yield steps.progress(
            inventory_step["id"], done=total, total=total, unit=PROGRESS_UNIT_RESOURCES
        )
    yield steps.end(inventory_step["id"])

    # --- the empty-scope gate, before anything is requested or written (Req 33.5) ----
    assert_scope_not_empty(plan, resources)

    # --- facts, between inventory and metrics (Req 4.7, 4.8, 4.9) --------------------
    #
    # Here for two reasons, and the second is the one that decided it. It is **after** the
    # empty-scope gate, because the gate's promise is that nothing is requested for a run
    # that resolved to zero resources and this pass issues requests. And it is **before**
    # metrics, because the per-subscription budget of 8 is uncontended at this moment: two
    # to six requests cost seconds, where the same requests interleaved with the metric
    # fan-out would each wait behind a batch and extend the critical path of an 8-to-12
    # minute run.
    #
    # No `tool` step of its own. The activity timeline's step vocabulary is a UI contract
    # (`AGENTCORE_INTEGRATION.md` names six), and a pass that finishes in seconds would
    # render as a step that flickers — the honest presentation of something this short is
    # nothing at all.
    facts_by_resource, fact_gaps = await _collect_facts(
        provider=active, plan=plan, resources=resources, discovered=discovered
    )
    gaps.extend(fact_gaps)

    metrics_by_resource_type = _requested_metrics(active, plan.scope, metric_selection)
    gaps.extend(_metric_not_selected_gaps(resources, metrics_by_resource_type))
    await _report(progress, PHASE_COLLECTING, current=0, total=total, label="Metrics")

    # --- metrics (Req 14.7, 14.8, 23.x-30.x) -----------------------------------------
    metrics_step = steps.start(
        TOOL_COLLECT_METRICS, label="Metrics", status="Collecting metric values"
    )
    yield metrics_step
    yield steps.progress(
        metrics_step["id"], done=0, total=total, unit=PROGRESS_UNIT_RESOURCES
    )
    collected = await active.collect(
        CollectRequest(
            scope=plan.scope,
            resources=resources,
            metrics_by_resource_type=metrics_by_resource_type,
            grain=plan.grain,
            window=window_to_plain(plan.window),
            timezone=plan.timezone_name,
            utc_offset=_utc_offset_text(plan),
        )
    )
    gaps.extend(collected["gaps"])

    tiers, guest_entries, guest_gaps = await _resolve_fidelity(
        plan=plan, provider=active, catalog=loaded, resources=resources
    )
    gaps.extend(guest_gaps)
    yield steps.progress(
        metrics_step["id"], done=total, total=total, unit=PROGRESS_UNIT_RESOURCES
    )
    yield steps.end(metrics_step["id"])

    # --- the two remaining gates, in this order (see the module docstring) -----------
    assert_some_location_reachable(plan, collected.get("locations"))
    assert_some_statistic(plan, collected["statistics"], collected.get("gaps") or ())

    # --- the snapshot (Req 34.x, 35.x) -----------------------------------------------
    await _report(progress, PHASE_COLLECTING, current=total, total=total, label="Snapshot")

    archive = collected.get("raw_archive")
    archive_complete = _archive_complete(archive)
    document = build_snapshot(
        run_id=plan.run_id,
        scope=plan.scope,
        scope_verified=plan.scope_verified,
        collected_at=now(),
        timezone_name=plan.timezone_name,
        tz=plan.tz,
        window=plan.window,
        grain=plan.grain,
        metrics_by_resource_type=metrics_by_resource_type,
        resources=_resource_snapshots(
            plan=plan,
            resources=resources,
            statistics=collected["statistics"],
            day_statistics=collected.get("day_statistics") or {},
            capacities=collected.get("sku_capacities") or {},
            tiers=tiers,
            guest_entries=guest_entries,
            facts_by_resource=facts_by_resource,
        ),
        gaps=gaps,
        catalog_version=loaded.catalog_version,
        raw_archive_complete=archive_complete,
        raw_archive_object_count=_archive_object_count(archive),
        # Req 4.13's lower bound on every fact's `collected_at`, read once at the top of this
        # function rather than here: a bound read after the collection would be later than the
        # facts it is meant to contain. See `_assert_facts_are_collectable` on why the
        # invocation instant stands in for `claimed_at` and why that is strictly tighter.
        invocation_started_at=invocation_started_at,
    )
    written = await write_once(store, document, actor_id=plan.actor_id, run_id=plan.run_id)
    if not written:
        # `write_once` already logged the attempt and left the existing bytes untouched
        # (Req 34.9). The run still completed and the snapshot at that key is this run's
        # own document by content, so the event is emitted for the id that is there.
        logger.warning(
            "run %s found a snapshot already at its key; the existing object's bytes are "
            "unchanged and no second object was written.",
            plan.run_id,
        )

    # --- exactly one snapshot_ready, before `done` (Req 14.9, 35.7) ------------------
    document_gaps = tuple(_as_list(document["gaps"]))
    resource_count = len(_as_list(document["resources"]))
    yield {
        "type": SNAPSHOT_READY_EVENT_TYPE,
        "snapshot_id": document["snapshot_id"],
        "resource_count": resource_count,
        "window": dict(window_to_plain(plan.window)),
        "grain": plan.grain,
        # Req 29.9 — the snapshot's own gap list, so the count this event carries equals
        # the count recorded during collection by construction rather than by agreement
        # between two lists.
        "gaps": document["gaps"],
    }

    # --- the collection completed; `partial` is recorded, not raised (Req 41.1, 41.4) -
    #
    # The outcome is deposited **after** the last event, so it lands only for a consumer
    # that drains this generator — which is what makes an abandoned collection produce no
    # outcome rather than a half-true one. The gap list is the snapshot's own, scrubbed
    # copy (Req 15.3, 29.9): `scrub_deep` rewrites strings element-wise and adds and drops
    # nothing, so `gap_count` here is the count recorded during collection, and `partial`
    # holds exactly when `gaps` did.
    sink.outcome = CollectionOutcome(
        document=document,
        snapshot_id=str(document["snapshot_id"]),
        resource_count=resource_count,
        gap_count=len(document_gaps),
        gaps=document_gaps,
        partial=bool(document_gaps),
        raw_archive_complete=archive_complete,
    )


# --- assembly helpers ----------------------------------------------------------------


async def _collect_facts(
    *,
    provider: Provider,
    plan: RunPlan,
    resources: Sequence[ResourceRecord],
    discovered: DiscoverResult,
) -> tuple[dict[str, tuple[FactEntry, ...]], list[GapRecord]]:
    """The fact pass, or nothing at all (Req 4.7, 4.8, 4.12).

    A provider with no fact surface records **no fact and no gap and issues no request** —
    Req 4.12 declares an empty `facts` collection an ordinary canonical form, so a provider
    that cannot collect one is not a provider that has to fail. That is the same shape
    `_resolve_fidelity` takes against `GuestCounterProvider`, and for the same reason: a
    fourth required method on `Provider` would break every conforming implementation for a
    capability two of the three do not have.

    `FactEntry`'s own `__post_init__` is the gate on each record, and it raises — which is
    correct and is why it runs **here** rather than inside the provider: a fact carrying no
    source or an unparseable numeric value is a defect in this runtime's own derivation, not
    a fact about the subscription, and Req 4.4 requires no snapshot object to be written for
    one. The bounds Req 5.4 makes a *collection* outcome are applied one layer earlier, in
    `azure/facts.py`, so an over-long value costs a cell rather than the run.
    """
    if not isinstance(provider, FactCollectingProvider):
        logger.info(
            "the provider exposes no fact surface; every resource carries an empty facts "
            "collection and no fact request was issued."
        )
        return {}, []

    result = await provider.collect_facts(
        FactRequest(
            resources=list(resources),
            inventory_pages=list(discovered.get("inventory_pages") or ()),
            subscription_id=plan.scope["subscription_id"],
        )
    )

    by_resource: dict[str, list[FactEntry]] = {}
    for record in result["facts"]:
        by_resource.setdefault(record["resource_id"], []).append(
            fact_from_plain(record)
        )
    return (
        {resource_id: tuple(entries) for resource_id, entries in by_resource.items()},
        list(result["gaps"]),
    )


def _resource_snapshots(
    *,
    plan: RunPlan,
    resources: Sequence[ResourceRecord],
    statistics: Mapping[str, Mapping[str, Mapping[str, StatValue]]],
    day_statistics: Mapping[str, Mapping[str, Sequence[StatValue]]],
    capacities: Mapping[str, SkuCapacityRecord],
    tiers: Mapping[str, str],
    guest_entries: Mapping[str, tuple[StatisticEntry, ...]],
    facts_by_resource: Mapping[str, tuple[FactEntry, ...]] = MappingProxyType({}),
) -> list[ResourceSnapshot]:
    """Every resource as the Snapshot_Builder takes it (Req 29.8, 31.1, 31.2, 35.3).

    **Every** discovered resource appears, including one that produced no statistic at
    all: a resource carrying a `permission_denied`, `deallocated` or `power_state_unknown`
    gap is present with no values rather than absent (Req 20.10, 29.8), because "absent"
    and "measured at zero" are the two readings this whole pipeline exists to keep apart.

    The resolved `fidelity_tier` is written onto both the resource record (Req 31.1) and
    every one of its values (Req 31.2), from the one mapping `_resolve_fidelity` produced.

    Day buckets carry the local day and the slot count that fell inside the window,
    partial edge days included and never padded (Req 25.11), **and** that day's statistics
    where the provider folded any (Req 35.11).

    The geometry is the spine and it is produced here, from the window alone, for every
    resource alike. What the provider contributes is only the values: a day it measured
    nothing for keeps its bucket with an empty `statistics` array, because a day with no
    data is still a day of the window and dropping it would make a gap in the data look
    like a gap in the calendar. That split is also what stops the day dimension from being
    two derivations of one calendar — see `collect/dayfold.py`.
    """
    geometry = day_buckets(plan.window, plan.tz, plan.grain)

    built: list[ResourceSnapshot] = []
    for record in resources:
        resource_id = record["resource_id"]
        tier = tiers.get(resource_id, FIDELITY_BASELINE)
        entries: list[StatisticEntry] = [
            statistic_from_plain(value, fidelity_tier=tier)
            for metric_values in statistics.get(resource_id, {}).values()
            for value in metric_values.values()
        ]
        entries.extend(guest_entries.get(resource_id, ()))
        per_day = day_statistics.get(resource_id, {})
        buckets = tuple(
            ResourceDayBucket(
                local_day=bucket.local_day,
                slot_count=bucket.slot_count,
                statistics=tuple(
                    statistic_from_plain(value, fidelity_tier=tier)
                    for value in per_day.get(bucket.local_day.isoformat(), ())
                ),
            )
            for bucket in geometry
        )
        built.append(
            ResourceSnapshot(
                record={**record, "fidelity_tier": tier},
                sku=sku_from_plain(
                    capacities.get(resource_id), sku_name=record.get("sku_name") or ""
                ),
                statistics=tuple(entries),
                day_buckets=buckets,
                # Req 4.10, 4.12 — **every** resource carries a `facts` collection, and a
                # resource whose statistics are absent still carries its configuration: a
                # deallocated VM's size and OS are facts about it whatever it measured. The
                # default is the empty tuple rather than an absent key, which Req 4.12 makes
                # a different canonical form.
                facts=facts_by_resource.get(resource_id, ()),
            )
        )
    return built


def _metric_not_selected_gaps(
    resources: Sequence[ResourceRecord],
    metrics_by_resource_type: Mapping[str, Sequence[str]],
) -> list[GapRecord]:
    """Req 23.15, 23.16 — one gap per resource whose type had no metric requested.

    **The case exists because no validator can see it.** Req 5.9 rejects a saved version
    whose scope *names* a resource type with no metric selection, but a scope naming **no**
    resource types is unconstrained (Req 3.1, 3.12): which types it can contain is a fact
    about the subscription, not about the definition. A subscription-agnostic template
    pointed at a subscription holding a type it did not select is an ordinary pairing rather
    than a broken template, so the run continues — but it must not continue *silently*.

    Without this gap the case leaves no trace of any kind. An unrequested metric builds no
    accumulator, so there is no `no_samples` gap, no per-resource error and no
    `resource_absent_from_response` gap. The resource is simply present in the snapshot
    carrying no statistics; `verify/coverage.py` asserts presence and passes;
    `assert_some_statistic` is satisfied by any other resource that did collect. The run
    completes as a fully verified report holding resources with no figures and nothing
    anywhere saying why — which is the one failure this product cannot afford.

    Distinct from `metric_not_emitted` and `no_samples` on purpose (Req 23.16): those two say
    Azure emits nothing for this SKU and the samples came back empty. This one says nobody
    asked. Only the third is a decision the caller made, and only the third is fixed by
    editing the template rather than by installing an agent in the guest.

    Resource type comparison folds case (Req 3.12), for the reason it folds everywhere else
    on this path: `metrics_by_resource_type` is keyed by the catalog's spelling and a
    Resource Graph inventory row carries Azure's lowercase one, so an exact comparison would
    record this gap for **every** resource on a run that requested everything correctly.

    One gap per resource rather than one per resource type, because `collection_log` is
    per-resource by definition — the glossary's "the affected `resource_id`" — and the gap
    list is what the report's gap surface groups and counts.
    """
    requested = {
        resource_type.casefold()
        for resource_type, names in metrics_by_resource_type.items()
        if names
    }

    gaps: list[GapRecord] = []
    for resource in resources:
        resource_type = resource["resource_type"]
        if resource_type.casefold() in requested:
            continue
        gaps.append(
            record_gap(
                GAP_TYPE_METRIC_NOT_SELECTED,
                resource["resource_id"],
                None,
                f"no metric was requested for resource type {resource_type!r}, so nothing "
                f"was collected for this resource; the pinned template version selected no "
                f"metric for that type",
            )
        )
    return gaps


def _requested_metrics(
    provider: Provider,
    scope: ScopeSpec,
    selection: Mapping[str, Sequence[str]] | None = None,
) -> dict[str, list[str]]:
    """The metric names to request per resource type, from `capabilities()` (Req 18.6).

    Narrowed to the scope's requested resource types when it names any, and to everything
    the provider collects when it names none. Taken from `capabilities()` rather than from
    the catalog directly, so the metric set this pipeline asks for is by definition a set
    the provider said it can collect — and so a resource type the provider cannot collect
    at all is never requested.

    **No platform metric for in-guest disk free space is requested** (Req 31.5), and that
    needs no filter here: the Metric_Catalog declares none, because Azure emits none, so
    there is no name in this map that could be one.

    `selection` is Req 5.4's second narrowing, and the two compose in one direction only:
    the result is the **intersection** of what the provider can collect and what the pinned
    template version asked for, so a report neither requests a metric the provider cannot
    produce nor one the template did not select. `None` — a snapshot-only run, which has no
    pinned version to ask — leaves the capability set unnarrowed.

    A resource type present in the scope and absent from `selection` requests **nothing**,
    because "exactly the union of the pinned version's metric selections for that resource
    type" is empty for it. Requesting everything instead would be the one reading of
    Req 5.4 the requirement explicitly forbids ("SHALL request no metric outside that
    union"), and it is also how a template that asked for one CPU figure ends up paying for
    every disk and network counter the type emits.

    **Every resource-type comparison here folds case** (Req 3.12), and all three of them
    would otherwise fail closed to an empty request. Azure resource type names are
    case-insensitive and Resource Graph lowercases `type` in its response body, so three
    spellings of one type meet in this function: the scope's, the capability map's (the
    catalog's) and `selection`'s (the definition's). An exact comparison between any two of
    them turns a spelling difference into a resource type with no metrics — a run that
    collects nothing for a type it was asked about, with nothing anywhere saying why. The
    keys of the returned map are the **capability map's** spelling, which is the catalog's,
    so nothing downstream inherits Azure's casing from here.
    """
    available = provider.capabilities()["metrics"]
    requested = [name for name in scope["resource_types"] if name] or list(available)
    available_by_fold = {name.casefold(): name for name in available}

    # Folded keys **union** rather than overwrite, and that is not defensive tidying: the
    # definition's `metrics` key and its scope's `resource_types` entry are two independent
    # spellings of one type, and `union_scope` folds a top-N ranking metric into the scope's
    # spelling. So one type legitimately arrives here under two keys, and last-one-wins would
    # drop either the selection or the ranking metric depending on iteration order.
    selection_by_fold: dict[str, set[str]] | None = None
    if selection is not None:
        selection_by_fold = {}
        for resource_type, names in selection.items():
            selection_by_fold.setdefault(resource_type.casefold(), set()).update(names)

    narrowed: dict[str, list[str]] = {}
    for resource_type in requested:
        folded = resource_type.casefold()
        declared = available_by_fold.get(folded)
        if declared is None:
            continue
        names = set(available[declared])
        if selection_by_fold is not None:
            names &= set(selection_by_fold.get(folded, ()))
        narrowed[declared] = sorted(names)
    return narrowed


def _utc_offset_text(plan: RunPlan) -> str:
    """The run timezone's offset at the window start, as `+HH:MM`.

    Resolved at the window's **start** instant, the same instant `collect/snapshot.py`
    resolves the snapshot's own `utc_offset` at, so the two cannot disagree for one run.
    """
    offset = plan.window.start_utc.astimezone(plan.tz).utcoffset()
    total = int(offset.total_seconds()) if offset is not None else 0
    sign = "-" if total < 0 else "+"
    hours, remainder = divmod(abs(total), 3600)
    return f"{sign}{hours:02d}:{remainder // 60:02d}"


def _archive_complete(archive: Mapping[str, PlainData] | None) -> bool:
    """Whether this run's raw archive can be replayed in full (Req 26.12).

    A provider reporting nothing is treated as complete: it wrote no archive to be
    incomplete about. A provider that *did* write one and lost an object says so.
    """
    if not isinstance(archive, Mapping):
        return True
    return archive.get("complete") is not False


def _archive_object_count(archive: Mapping[str, PlainData] | None) -> int:
    if not isinstance(archive, Mapping):
        return 0
    count = archive.get("object_count")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        return 0
    return count


def _as_list(value: PlainData) -> list[PlainData]:
    return value if isinstance(value, list) else []


async def _report(
    reporter: ProgressReporter | None,
    phase: str,
    *,
    current: int | None = None,
    total: int | None = None,
    label: str | None = None,
) -> None:
    """Fire one phase callback, fire-and-forget (Req 38.1, 38.4).

    A no-op when this invocation carries no run, and it can never fail the run: the
    reporter itself never raises, and a callback that does not land is the Reaper's
    problem rather than this pipeline's — a run that died because it could not report its
    own progress is the worst of both designs.

    **One consequence of the reporter's throttle is worth stating rather than discovering.**
    The entry into `collecting` is a *transition* and is sent at the instant it occurs; the
    refresh that follows it carries the resource count but is an *in-phase* callback, so if
    inventory paging took less than `PROGRESS_THROTTLE_S` it is dropped (Req 38.15). The
    row therefore carries no counts until the refresh after collection, minutes later, which
    does land. That is the correct trade: the alternative is delaying the transition itself
    until the count is known, which would leave the row at `claimed` — against a much
    tighter phase deadline — for the whole of inventory paging.
    """
    if reporter is None:
        return
    await reporter.report(phase, current=current, total=total, label=label)


def _close_quietly(provider: Provider) -> None:
    """Release a provider this pipeline built. Never raises.

    `close` is not part of `providers.base.Provider` — the protocol is about collecting —
    so it is called if the built provider offers one and skipped otherwise, which is what
    lets a provider with nothing to release simply not have the method. Never raises,
    because this runs on the teardown path: an exception here would replace a real terminal
    error with a cleanup one.
    """
    closer = getattr(provider, "close", None)
    if not callable(closer):
        return
    try:
        closer()
    except Exception as exc:  # teardown must not mask the run's own outcome
        logger.warning("releasing the provider at run end failed: %s", exc)


def _s3_store(bucket: str, region: str | None) -> ObjectStore:
    """An `S3ObjectStore` over the run's artifact bucket.

    Imported locally, so a unit test that injects its own store — every test in
    `tests/test_collect_pipeline.py` — never imports boto3 at all. The bucket and the
    region are passed in from the configuration the entrypoint built once at process
    start; nothing here reads an environment variable (Req 14.12).
    """
    from reporting_agent.storage.s3 import S3ObjectStore

    return S3ObjectStore(bucket, region=region)
