"""The batch metrics planner and collector: sizing, halving, throttling, per-resource
errors — everything Req 23, 24.8, 26, 27.8 and 29 ask of "THE Metrics_Collector".

**Sizing is by points budget, never by the documented 50-resource cap** (Req 23.1-23.4,
23.6). `plan_batches` groups a `(subscription, location, resource_type)` batch's
resources into chunks whose *estimated* point count — resource count times metric
count times grain-interval count — stays at or under :data:`POINTS_BUDGET`, because the
batch endpoint offers no paging and batch sizing is therefore the only control over
response size. `max(1, ...)` is what puts a resource whose own metric set already
exceeds the budget into a batch of exactly one rather than dropping it.

**Response-too-large is a runtime rejection, not a sizing mistake to avoid** (Req 23.3,
23.14). Even a batch sized correctly against the estimate can still be rejected —
Azure's real limit and this module's estimate are not the same number — so
:class:`MetricsCollector` treats every accepted `Batch` as provisional: a
`ResponseTooLarge` rejection **splits the batch's resource ids into two halves by
integer division and requests each half independently**, recursing until every
resource has either answered or reached a batch of exactly one. At that floor, a
still-oversized single-resource request is split by metric name (Req 23.14); a
single-metric request that *also* rejects records `response_too_large` with no zero
value. This "split both halves, drop nothing" reading is a deliberate choice over a
literal "halve and retry, dropping the other half" reading of Req 23.3's text: the
latter would leave resources permanently unrequested, which contradicts this
codebase's "never silently drop a resource" discipline (Req 23.12, 29.6) far more than
it satisfies a specific request-count bound. Flagged here for the task report, and for
Property 4 (task 11.7) to hold this module to whichever reading the property settles
on.

**Every returned series is matched to a requested resource by resource id, never by
position** (Req 23.12) — `_entries_by_resource_id` builds a lookup keyed by the
response's own `resourceid` field, casefolded the same way `azure/inventory.py`
casefolds Resource Graph's `type` field, because Azure is not guaranteed to echo back
identical casing. A requested resource absent from that lookup records
`resource_absent_from_response` and folds nothing for it.

**Per-resource errors arrive at HTTP 200** (Req 29.1-29.4, 29.6, 29.7). Every metric
entry inside every resource entry is inspected regardless of the envelope's own
status; `errorCode != "Success"` becomes a typed gap — `Forbidden` maps to
`permission_denied`, anything else unrecognised maps to `metric_error` — and no code
path here ever converts one of those into a folded zero. An interval missing `count`
or `total` records `interval_counts_missing` **before** `MetricAccumulator.fold_interval`
is ever called for it (Req 23.13): this module screens the raw response for that
specific omission and passes only well-formed intervals down, so `accumulate.py`'s own
`interval_malformed` stays its defensive floor for a differently-malformed value
reaching it directly, and the two gap types never both fire for the same interval.

**Concurrency is one 8-slot semaphore per subscription id** (Req 23.7), acquired around
every call this module makes into `azure/regions.py`'s
`RegionResolver.request_batch_or_fallback` — batch and per-resource-fallback requests
alike, because a fallback-routed call still issues its per-resource requests
sequentially inside that one call (`azure/regions.py`'s own contract), so holding the
semaphore for the call's duration never permits more than 8 requests in flight for one
subscription at any instant, and a different subscription's semaphore is entirely
independent.

**429 handling wraps only the batch path** (Req 23.8, 23.9). A `DnsResolutionError`
inside `RegionResolver` is a **different** failure mode with its own retry-free
contract (`azure/regions.py`, task 11.5) that this module does not second-guess; the
429/`Retry-After` loop below applies only when `RegionResolver` answered with a batch
response, because every 429 fixture this module is built against is a batch-endpoint
rejection.

**Archiving happens in the same pass, before this module returns control** (Req 26.3,
26.4, 26.9, 24.8) — see `collect/archive.py`. A rejected request (429, response-too-
large) is never archived (Req 26.10); every response this module accepts as an answer
— a batch success or an individual fallback response — is archived exactly once,
immediately before it is folded.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from email.utils import parsedate_to_datetime
from typing import Final

from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.azure.regions import LocationRequestResult, RegionResolver
from reporting_agent.collect.accumulate import MetricAccumulator
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.log import (
    GAP_TYPE_INTERVAL_COUNTS_MISSING,
    GAP_TYPE_METRIC_ERROR,
    GAP_TYPE_PERMISSION_DENIED,
    GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE,
    GAP_TYPE_RESPONSE_TOO_LARGE,
    record_gap,
)
from reporting_agent.errors import ThrottledError
from reporting_agent.providers.base import GapRecord

__all__ = [
    "AGGREGATIONS",
    "DEFAULT_RETRY_AFTER_S",
    "MAX_CONCURRENCY_PER_SUBSCRIPTION",
    "MAX_CONSECUTIVE_429",
    "POINTS_BUDGET",
    "Batch",
    "BatchGroup",
    "GroupKey",
    "MetricsCollector",
    "classify_metric_error_code",
    "fold_batch_response",
    "fold_fallback_response",
    "fold_resource_metrics",
    "parse_retry_after",
    "plan_batches",
]

logger = logging.getLogger(__name__)

# --- the constants Req 23.2, 23.7, 23.9, 23.11, 27.8 declare ------------------------

POINTS_BUDGET: Final[int] = 20_000
"""Req 23.2, 23.4. The estimated-point ceiling a planned batch must not exceed; the
documented 50-resource cap is never consulted."""

MAX_CONCURRENCY_PER_SUBSCRIPTION: Final[int] = 8
"""Req 23.7. One semaphore of this size per subscription id, shared by batch and
per-resource-fallback requests alike."""

AGGREGATIONS: Final[tuple[str, ...]] = ("Total", "Count", "Minimum", "Maximum")
"""Req 23.11, 27.8. Requested for every metric, so the Accumulator can compute a
count-weighted average and exact extremes from the response alone."""

MAX_CONSECUTIVE_429: Final[int] = 5
"""Req 23.9. The 5th consecutive 429 for one logical request raises `ThrottledError`
rather than being waited out a 5th time."""

DEFAULT_RETRY_AFTER_S: Final[float] = 5.0
"""Applied only when a 429 response's `Retry-After` header is absent or unparseable —
a case Req 23.8 does not explicitly name, since it assumes the header is present.
Mirrors `azure/inventory.py`'s own fallback-wait convention for the analogous quota
case rather than treating an unparseable header as "no wait needed"."""

_RESPONSE_TOO_LARGE_STATUS: Final[int] = 400
_RESPONSE_TOO_LARGE_HEADER: Final[str] = "x-ms-error-code"
_RESPONSE_TOO_LARGE_VALUE: Final[str] = "ResponseTooLarge"

_ERROR_CODE_SUCCESS: Final[str] = "Success"
_ERROR_CODE_GAP_TYPES: Final[dict[str, str]] = {"Forbidden": GAP_TYPE_PERMISSION_DENIED}
"""Req 29.7's recognised classifications. Every `errorCode` not in this mapping
becomes `metric_error` rather than being dropped."""


def classify_metric_error_code(error_code: str) -> str:
    """The `gap_type` for a per-resource metric entry's `errorCode` (Req 29.2, 29.7).

    **Pure.** `"Forbidden"` maps to `permission_denied`; every other non-`"Success"`
    code — recognised or not — maps to `metric_error`, so an error Azure has not yet
    taught this module a name for is still recorded, typed, rather than silently
    dropped (Req 29.7).
    """
    return _ERROR_CODE_GAP_TYPES.get(error_code, GAP_TYPE_METRIC_ERROR)


# --- batch planning (Req 23.1-23.4, 23.6, 23.10) ------------------------------------

type GroupKey = tuple[str, str, str]
"""`(subscription_id, location, resource_type)` — Req 23.1's grouping key. A plain
tuple rather than a dataclass, so a `Batch` carrying one hashes and compares by value
with no extra type to import at every call site that just wants to check "same
group"."""


@dataclass(frozen=True, slots=True)
class BatchGroup:
    """Everything `plan_batches` needs to size one group's batches.

    `resources_sorted` is the group's resource ids, already ordered by the caller —
    this dataclass does not itself sort, so two calls over the same set in the same
    order produce byte-identical batches (Property 4's determinism clause). Each
    resource in a group shares `key`, so no batch this module ever plans mixes
    resources from two different `(subscription, location, resource_type)` triples.
    """

    key: GroupKey
    resources_sorted: tuple[str, ...]
    metric_count: int


@dataclass(frozen=True, slots=True)
class Batch:
    """One planned request: a grouping key plus the resource ids it covers."""

    key: GroupKey
    resource_ids: tuple[str, ...]


def _chunk(sequence: Sequence[str], size: int) -> Iterator[tuple[str, ...]]:
    """`sequence`, split into consecutive tuples of at most `size` elements each, the
    last one possibly shorter. **Pure.** Raises `ValueError` for a non-positive
    `size` — there is no such thing as a batch of zero or fewer resources."""
    if size <= 0:
        raise ValueError(f"size must be positive, got {size!r}")
    for start in range(0, len(sequence), size):
        yield tuple(sequence[start : start + size])


def plan_batches(group: BatchGroup, *, interval_count: int) -> list[Batch]:
    """Size `group`'s resources into batches whose estimated point count stays at or
    under :data:`POINTS_BUDGET` (Req 23.1, 23.2, 23.4, 23.6). **Pure.**

    `per_resource = group.metric_count * interval_count` is the estimated point count
    one resource contributes; `capacity = max(1, POINTS_BUDGET // per_resource)` is
    how many resources one batch may hold while staying under budget, and the
    `max(1, ...)` is what puts a resource whose own metric set already exceeds the
    budget into a batch of exactly one rather than being dropped (Property 4.7).

    Returns `[]` for an empty `group.resources_sorted` — there is nothing to plan.
    Raises `ValueError` for a non-positive `interval_count` or `metric_count`: a
    window with zero intervals or a group with zero metrics describes no real
    request.
    """
    if interval_count <= 0:
        raise ValueError(f"interval_count must be positive, got {interval_count!r}")
    if group.metric_count <= 0:
        raise ValueError(f"metric_count must be positive, got {group.metric_count!r}")
    if not group.resources_sorted:
        return []

    per_resource = group.metric_count * interval_count
    capacity = max(1, POINTS_BUDGET // per_resource)
    return [
        Batch(key=group.key, resource_ids=chunk)
        for chunk in _chunk(group.resources_sorted, capacity)
    ]


# --- response classification (Req 23.3, 23.8, 23.14) --------------------------------


def _is_response_too_large(response: RawHttpResponse) -> bool:
    """Req 23.3's rejection: HTTP 400 carrying `x-ms-error-code: ResponseTooLarge`.
    **Pure.** Matched by status and header, never by parsing the message text
    (`tests/fixtures/azure/metrics_batch_response_too_large.json`'s own comment)."""
    return (
        response.status == _RESPONSE_TOO_LARGE_STATUS
        and response.header(_RESPONSE_TOO_LARGE_HEADER) == _RESPONSE_TOO_LARGE_VALUE
    )


def parse_retry_after(value: str | None, *, now: datetime) -> float | None:
    """The wait duration `Retry-After` names, in seconds, or `None` if `value` is
    absent or neither legal form (Req 23.8). **Pure.**

    Accepts a bare integer count of seconds, or an RFC 7231 HTTP-date (`"Tue, 01 Jul
    2026 00:05:00 GMT"`), parsed relative to `now` and clamped to 0 rather than
    returning a negative wait for a date already in the past. `now` is a required
    keyword rather than an ambient `datetime.now()` call, so a test replaying an
    HTTP-date fixture supplies its own notion of "now" instead of this function
    reaching for the wall clock.
    """
    if not isinstance(value, str) or not value.strip():
        return None

    stripped = value.strip()
    if stripped.isdigit():
        return float(int(stripped))

    try:
        parsed = parsedate_to_datetime(stripped)
    except (TypeError, ValueError, IndexError):
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)

    return max(0.0, (parsed - now).total_seconds())


def _as_decimal(value: object) -> Decimal | None:
    """A raw JSON-decoded numeric leaf (`int`, `float`, or already `Decimal`) as a
    `Decimal`, or `None` for anything else. **Pure.**

    `Decimal(str(value))` for a `float` rather than `Decimal(value)` — the same
    reasoning `collect/sketch.py`'s `_quantile_as_decimal` and the Azure SDK's own
    model deserializer (`azure/monitor/querymetrics/_utils/model_base.py`) both apply:
    it round-trips the digit string a JSON decoder produced rather than the value's
    nearest binary fraction. A concrete `MetricsPort` backed by the real SDK hands
    back `Decimal` already for these fields (the SDK deserializes them that way), so
    this function is the seam that also accepts the plain `int`/`float` a recorded
    JSON fixture parses to."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return Decimal(str(value))
    return None


def _metric_name_of(entry: Mapping[str, object]) -> str | None:
    name_field = entry.get("name")
    if isinstance(name_field, Mapping):
        value = name_field.get("value")
        return value if isinstance(value, str) else None
    return name_field if isinstance(name_field, str) else None


def _entries_by_metric_name(entries: Sequence[Mapping[str, object]]) -> dict[str, Mapping[str, object]]:
    """One resource's metric entries, keyed by metric name. **Pure.**"""
    result: dict[str, Mapping[str, object]] = {}
    for entry in entries:
        name = _metric_name_of(entry)
        if name is not None:
            result[name] = entry
    return result


def _entries_by_resource_id(values: Sequence[Mapping[str, object]]) -> dict[str, Mapping[str, object]]:
    """A batch response's `values` array, keyed by `resourceid`, casefolded
    (Req 23.12). **Pure.** Casefolding matches `azure/inventory.py`'s own convention
    for Resource Graph's `type` field — Azure is not guaranteed to echo a resource id
    back in the exact casing it was requested in."""
    result: dict[str, Mapping[str, object]] = {}
    for entry in values:
        resource_id = entry.get("resourceid")
        if isinstance(resource_id, str):
            result[resource_id.casefold()] = entry
    return result


def fold_batch_response(
    *,
    body: Mapping[str, object],
    resource_ids: Sequence[str],
    metric_names: Sequence[str],
    accumulators: Mapping[tuple[str, str], MetricAccumulator],
) -> list[GapRecord]:
    """Fold one **batch** response body, resource by requested resource.

    Iterating `resource_ids` rather than the response's own `values` array is what turns a
    resource the response silently omitted into a recorded
    `resource_absent_from_response` gap rather than into nothing at all (Req 29.5). The
    lookup is case-folded because Azure does not preserve the casing of a resource id it
    was handed.

    Public, and separate from the archiving and HTTP around it, so `verify/replay.py`
    folds an archived response through **this** function rather than through a second
    reading of the same body shape (Req 31.1). Nothing here touches a client: the body is
    plain data, already in memory, from a live response or from the archive alike.
    """
    raw_values = body.get("values")
    values = (
        [value for value in raw_values if isinstance(value, Mapping)]
        if isinstance(raw_values, list)
        else []
    )
    by_resource_id = _entries_by_resource_id(values)

    gaps: list[GapRecord] = []
    for resource_id in resource_ids:
        entry = by_resource_id.get(resource_id.casefold())
        if entry is None:
            gaps.append(
                record_gap(
                    GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE,
                    resource_id,
                    None,
                    f"resource {resource_id!r} was requested in this batch but "
                    f"is absent from the response's values array; no value is "
                    f"folded for it.",
                )
            )
            continue

        raw_metric_entries = entry.get("value")
        gaps.extend(
            fold_resource_metrics(
                resource_id=resource_id,
                entries=(
                    [e for e in raw_metric_entries if isinstance(e, Mapping)]
                    if isinstance(raw_metric_entries, list)
                    else []
                ),
                requested_metric_names=metric_names,
                accumulators=accumulators,
            )
        )
    return gaps


def fold_fallback_response(
    *,
    body: Mapping[str, object],
    resource_id: str,
    metric_names: Sequence[str],
    accumulators: Mapping[tuple[str, str], MetricAccumulator],
) -> list[GapRecord]:
    """Fold one **per-resource ARM fallback** response body.

    The shape differs from a batch's by one level — `value` at the top rather than inside a
    `values` entry — and the resource id comes from the request rather than from the body,
    which is why the archive records `resource_ids` alongside every object.
    """
    raw_entries = body.get("value")
    return fold_resource_metrics(
        resource_id=resource_id,
        entries=(
            [entry for entry in raw_entries if isinstance(entry, Mapping)]
            if isinstance(raw_entries, list)
            else []
        ),
        requested_metric_names=metric_names,
        accumulators=accumulators,
    )


def fold_resource_metrics(
    *,
    resource_id: str,
    entries: Sequence[Mapping[str, object]],
    requested_metric_names: Sequence[str],
    accumulators: Mapping[tuple[str, str], MetricAccumulator],
) -> list[GapRecord]:
    """Fold one resource's answered metrics into `accumulators`, in place, returning
    every gap this resource's entries produced (Req 23.13, 27.8, 29.1-29.4, 29.6, 29.7,
    29.8).

    Public rather than private because `verify/replay.py` calls it: Req 31.1 requires a
    replay to re-run **the same** aggregation, and a private twin in `verify/` would make
    a replay mismatch mean "the two folds disagree" rather than "the aggregation is not
    deterministic". This function reaches no client and no credential — the response body
    arrives as plain data — so importing it costs the replay-purity guard nothing.

    `entries` is the resource's own `value` array — the shape is identical whether it
    came from a batch response's per-resource entry or a per-resource fallback
    response's top-level `value` array, which is why one function serves both call
    sites in :class:`MetricsCollector`. A metric named in `requested_metric_names`
    with no matching entry at all folds nothing and records no gap for it — an
    entirely absent metric entry is not a classification any requirement in this
    task's scope names, so this function does not invent one.

    Per metric entry found:

    * `errorCode` present and not `"Success"` — a typed gap via
      :func:`classify_metric_error_code`, naming this resource and this metric, and
      **no** fold for it (Req 29.2, 29.3, 29.7).
    * Otherwise, every interval in every `timeseries[*].data` entry: an interval
      missing `total` or `count`, or carrying either as something other than a
      decimal, records `interval_counts_missing` **before** `fold_interval` is ever
      called for it (Req 23.13) — this is the screening step that keeps
      `accumulate.py`'s own `interval_malformed` a defensive floor for a differently-
      malformed value, never the path a batch response's own omission takes. A
      well-formed interval is folded via `MetricAccumulator.fold_interval`, which may
      itself return a gap (a negative count, a non-decimal `minimum`/`maximum`) — that
      gap is forwarded unchanged.

    No accumulator supplied for a `(resource_id, metric_name)` pair silently folds
    nothing for it — the caller's contract, not a fact about this response.
    """
    gaps: list[GapRecord] = []
    entries_by_metric = _entries_by_metric_name(entries)

    for metric_name in requested_metric_names:
        entry = entries_by_metric.get(metric_name)
        if entry is None:
            continue

        error_code = entry.get("errorCode")
        if isinstance(error_code, str) and error_code != _ERROR_CODE_SUCCESS:
            error_message = entry.get("errorMessage")
            message = (
                str(error_message)
                if isinstance(error_message, str) and error_message.strip()
                else f"errorCode {error_code!r} for metric {metric_name!r} on "
                f"resource {resource_id!r}"
            )
            gaps.append(
                record_gap(
                    classify_metric_error_code(error_code),
                    resource_id,
                    metric_name,
                    message,
                )
            )
            continue

        accumulator = accumulators.get((resource_id, metric_name))

        for timeseries in entry.get("timeseries") or []:
            if not isinstance(timeseries, Mapping):
                continue
            for point in timeseries.get("data") or []:
                if not isinstance(point, Mapping):
                    continue

                total = _as_decimal(point.get("total"))
                count = _as_decimal(point.get("count"))
                if total is None or count is None:
                    gaps.append(
                        record_gap(
                            GAP_TYPE_INTERVAL_COUNTS_MISSING,
                            resource_id,
                            metric_name,
                            f"an interval for metric {metric_name!r} on resource "
                            f"{resource_id!r} omits its total or its count value; "
                            f"excluded from the average.",
                        )
                    )
                    continue

                if accumulator is None:
                    continue

                minimum = _as_decimal(point.get("minimum"))
                maximum = _as_decimal(point.get("maximum"))
                fold_gap = accumulator.fold_interval(
                    total=total,
                    count=count,
                    minimum=minimum,
                    maximum=maximum,
                    resource_id=resource_id,
                    metric=metric_name,
                )
                if fold_gap is not None:
                    gaps.append(fold_gap)

    return gaps


# --- the collector -------------------------------------------------------------------


@dataclass(slots=True)
class MetricsCollector:
    """Plans, requests, archives and folds one run's batch metrics (Req 23, 24.8, 26,
    27.8, 29).

    One instance per run, over that run's `RegionResolver` and `ArchiveWriter`.
    `sleep` and `now` are injected — defaulting to `asyncio.sleep` and
    `datetime.now(UTC)` — so the 429 wait loop is testable over simulated time with
    no real waiting, the same seam `azure/inventory.py` uses for its own quota waits.
    """

    region_resolver: RegionResolver
    archive_writer: ArchiveWriter
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    _semaphores: dict[str, asyncio.Semaphore] = field(default_factory=dict, repr=False)

    def _semaphore_for(self, subscription_id: str) -> asyncio.Semaphore:
        """Req 23.7's per-subscription concurrency budget, created lazily and reused
        for the life of this instance."""
        semaphore = self._semaphores.get(subscription_id)
        if semaphore is None:
            semaphore = asyncio.Semaphore(MAX_CONCURRENCY_PER_SUBSCRIPTION)
            self._semaphores[subscription_id] = semaphore
        return semaphore

    async def collect_group(
        self,
        *,
        actor_id: str,
        run_id: str,
        subscription_id: str,
        location: str,
        resource_type: str,
        resource_ids: Sequence[str],
        metric_namespace: str,
        metric_names: Sequence[str],
        accumulators: Mapping[tuple[str, str], MetricAccumulator],
        grain: str,
        window: Mapping[str, str],
        start_time: str,
        end_time: str,
        interval_count: int,
    ) -> list[GapRecord]:
        """Collect one `(subscription, location, resource_type)` group's metrics.

        Plans batches (Req 23.1, 23.2), requests each one — halving on a response-too-
        large rejection down to a floor of one resource, then splitting by metric name
        (Req 23.3, 23.14) — folds every answer into `accumulators` (a caller-supplied
        `(resource_id, metric_name) -> MetricAccumulator` mapping; typically built by
        the collection pipeline from the Metric_Catalog's declared unit families),
        archives every accepted response in the same pass (Req 26.3, 26.9), and
        returns every gap produced. Runs every batch concurrently, each individually
        bounded by this instance's per-subscription semaphore (Req 23.7).

        Raises `ValueError` for an empty `resource_ids` or `metric_names` — there is
        nothing to request. Raises `ThrottledError` if a 5th consecutive 429 is met
        for any single logical request (Req 23.9).
        """
        if not resource_ids:
            raise ValueError("resource_ids must be non-empty; there is nothing to collect")
        if not metric_names:
            raise ValueError("metric_names must be non-empty; there is nothing to collect")

        group = BatchGroup(
            key=(subscription_id, location, resource_type),
            resources_sorted=tuple(sorted(resource_ids)),
            metric_count=len(metric_names),
        )
        batches = plan_batches(group, interval_count=interval_count)

        results = await asyncio.gather(
            *[
                self._collect_batch(
                    actor_id=actor_id,
                    run_id=run_id,
                    subscription_id=subscription_id,
                    location=location,
                    resource_type=resource_type,
                    resource_ids=batch.resource_ids,
                    metric_namespace=metric_namespace,
                    metric_names=tuple(metric_names),
                    accumulators=accumulators,
                    grain=grain,
                    window=window,
                    start_time=start_time,
                    end_time=end_time,
                )
                for batch in batches
            ]
        )

        gaps: list[GapRecord] = []
        for batch_gaps in results:
            gaps.extend(batch_gaps)
        return gaps

    # --- one attempt: the semaphore plus the 429 loop --------------------------------

    async def _request(
        self,
        *,
        subscription_id: str,
        location: str,
        resource_ids: tuple[str, ...],
        metric_namespace: str,
        metric_names: tuple[str, ...],
        start_time: str,
        end_time: str,
        interval: str,
    ) -> LocationRequestResult:
        semaphore = self._semaphore_for(subscription_id)
        async with semaphore:
            return await self.region_resolver.request_batch_or_fallback(
                location=location,
                subscription_id=subscription_id,
                resource_ids=resource_ids,
                metric_namespace=metric_namespace,
                metric_names=metric_names,
                aggregations=AGGREGATIONS,
                start_time=start_time,
                end_time=end_time,
                interval=interval,
            )

    async def _request_with_429_retry(
        self,
        *,
        subscription_id: str,
        location: str,
        resource_ids: tuple[str, ...],
        metric_namespace: str,
        metric_names: tuple[str, ...],
        start_time: str,
        end_time: str,
        interval: str,
    ) -> LocationRequestResult:
        """Req 23.8, 23.9. Applies only to the batch path: a fallback-routed result
        (`via_fallback`) is returned immediately, because 429 handling for the
        per-resource ARM fallback belongs to no fixture or requirement this module is
        built against."""
        consecutive_429 = 0

        while True:
            result = await self._request(
                subscription_id=subscription_id,
                location=location,
                resource_ids=resource_ids,
                metric_namespace=metric_namespace,
                metric_names=metric_names,
                start_time=start_time,
                end_time=end_time,
                interval=interval,
            )

            response = result.batch_response
            if result.via_fallback or response is None or response.status != 429:
                return result

            consecutive_429 += 1
            if consecutive_429 >= MAX_CONSECUTIVE_429:
                raise ThrottledError(
                    f"Azure returned HTTP 429 on {consecutive_429} consecutive "
                    f"attempts for a batch metrics request against location "
                    f"{location!r} covering {len(resource_ids)} resource(s), each "
                    f"attempt having honoured the wait derived from the preceding "
                    f"response."
                )

            wait = parse_retry_after(response.header("Retry-After"), now=self.now())
            if wait is None:
                wait = DEFAULT_RETRY_AFTER_S
            await self.sleep(wait)

    # --- the halving loop and metric-name split (Req 23.3, 23.14) -------------------

    async def _collect_batch(
        self,
        *,
        actor_id: str,
        run_id: str,
        subscription_id: str,
        location: str,
        resource_type: str,
        resource_ids: tuple[str, ...],
        metric_namespace: str,
        metric_names: tuple[str, ...],
        accumulators: Mapping[tuple[str, str], MetricAccumulator],
        grain: str,
        window: Mapping[str, str],
        start_time: str,
        end_time: str,
    ) -> list[GapRecord]:
        result = await self._request_with_429_retry(
            subscription_id=subscription_id,
            location=location,
            resource_ids=resource_ids,
            metric_namespace=metric_namespace,
            metric_names=metric_names,
            start_time=start_time,
            end_time=end_time,
            interval=grain,
        )

        if result.via_fallback:
            return await self._handle_fallback(
                actor_id=actor_id,
                run_id=run_id,
                subscription_id=subscription_id,
                location=location,
                resource_type=resource_type,
                metric_names=metric_names,
                accumulators=accumulators,
                grain=grain,
                window=window,
                result=result,
            )

        response = result.batch_response
        assert response is not None  # a non-fallback result always carries one

        if _is_response_too_large(response):
            if len(resource_ids) == 1:
                return await self._split_by_metric(
                    actor_id=actor_id,
                    run_id=run_id,
                    subscription_id=subscription_id,
                    location=location,
                    resource_type=resource_type,
                    resource_id=resource_ids[0],
                    metric_namespace=metric_namespace,
                    metric_names=metric_names,
                    accumulators=accumulators,
                    grain=grain,
                    window=window,
                    start_time=start_time,
                    end_time=end_time,
                )

            half = len(resource_ids) // 2
            first, rest = resource_ids[:half], resource_ids[half:]
            first_gaps, rest_gaps = await asyncio.gather(
                self._collect_batch(
                    actor_id=actor_id,
                    run_id=run_id,
                    subscription_id=subscription_id,
                    location=location,
                    resource_type=resource_type,
                    resource_ids=first,
                    metric_namespace=metric_namespace,
                    metric_names=metric_names,
                    accumulators=accumulators,
                    grain=grain,
                    window=window,
                    start_time=start_time,
                    end_time=end_time,
                ),
                self._collect_batch(
                    actor_id=actor_id,
                    run_id=run_id,
                    subscription_id=subscription_id,
                    location=location,
                    resource_type=resource_type,
                    resource_ids=rest,
                    metric_namespace=metric_namespace,
                    metric_names=metric_names,
                    accumulators=accumulators,
                    grain=grain,
                    window=window,
                    start_time=start_time,
                    end_time=end_time,
                ),
            )
            return [*first_gaps, *rest_gaps]

        if not response.ok:
            # A non-2xx, non-429, non-too-large answer is not named by any
            # requirement in this task's scope. Every resource in this batch is
            # typed as metric_error rather than silently discarded, per this
            # module's own no-bare-suppression discipline.
            return [
                record_gap(
                    GAP_TYPE_METRIC_ERROR,
                    resource_id,
                    None,
                    f"the batch metrics request for location {location!r} answered "
                    f"status {response.status} for resource {resource_id!r}.",
                )
                for resource_id in resource_ids
            ]

        return await self._handle_batch_success(
            actor_id=actor_id,
            run_id=run_id,
            subscription_id=subscription_id,
            location=location,
            resource_type=resource_type,
            resource_ids=resource_ids,
            metric_names=metric_names,
            accumulators=accumulators,
            grain=grain,
            window=window,
            response=response,
        )

    async def _split_by_metric(
        self,
        *,
        actor_id: str,
        run_id: str,
        subscription_id: str,
        location: str,
        resource_type: str,
        resource_id: str,
        metric_namespace: str,
        metric_names: tuple[str, ...],
        accumulators: Mapping[tuple[str, str], MetricAccumulator],
        grain: str,
        window: Mapping[str, str],
        start_time: str,
        end_time: str,
    ) -> list[GapRecord]:
        """Req 23.14: a single-resource batch that still rejects as too large is split
        into one request per metric name. A single-metric request that also rejects
        records `response_too_large` with no zero value."""
        gaps: list[GapRecord] = []

        for metric_name in metric_names:
            result = await self._request_with_429_retry(
                subscription_id=subscription_id,
                location=location,
                resource_ids=(resource_id,),
                metric_namespace=metric_namespace,
                metric_names=(metric_name,),
                start_time=start_time,
                end_time=end_time,
                interval=grain,
            )

            if result.via_fallback:
                gaps.extend(
                    await self._handle_fallback(
                        actor_id=actor_id,
                        run_id=run_id,
                        subscription_id=subscription_id,
                        location=location,
                        resource_type=resource_type,
                        metric_names=(metric_name,),
                        accumulators=accumulators,
                        grain=grain,
                        window=window,
                        result=result,
                    )
                )
                continue

            response = result.batch_response
            assert response is not None

            if _is_response_too_large(response):
                gaps.append(
                    record_gap(
                        GAP_TYPE_RESPONSE_TOO_LARGE,
                        resource_id,
                        metric_name,
                        f"a single-resource, single-metric request for metric "
                        f"{metric_name!r} on resource {resource_id!r} still "
                        f"rejected as too large; no value is recorded for it.",
                    )
                )
                continue

            if not response.ok:
                gaps.append(
                    record_gap(
                        GAP_TYPE_METRIC_ERROR,
                        resource_id,
                        metric_name,
                        f"the single-metric fallback request for metric "
                        f"{metric_name!r} on resource {resource_id!r} answered "
                        f"status {response.status}.",
                    )
                )
                continue

            gaps.extend(
                await self._handle_batch_success(
                    actor_id=actor_id,
                    run_id=run_id,
                    subscription_id=subscription_id,
                    location=location,
                    resource_type=resource_type,
                    resource_ids=(resource_id,),
                    metric_names=(metric_name,),
                    accumulators=accumulators,
                    grain=grain,
                    window=window,
                    response=response,
                )
            )

        return gaps

    # --- archiving then folding a successful response (Req 23.12, 26.3, 26.9) -------

    async def _handle_batch_success(
        self,
        *,
        actor_id: str,
        run_id: str,
        subscription_id: str,
        location: str,
        resource_type: str,
        resource_ids: tuple[str, ...],
        metric_names: tuple[str, ...],
        accumulators: Mapping[tuple[str, str], MetricAccumulator],
        grain: str,
        window: Mapping[str, str],
        response: RawHttpResponse,
    ) -> list[GapRecord]:
        gaps: list[GapRecord] = []

        # Write first, fold second — design.md's own "write, fold, discard" order for
        # this pass (Req 26.3, 26.4, 26.9). Never called for a rejected request, so
        # Req 26.10 ("a rejected request writes no object") holds with no check here.
        archive_result = await self.archive_writer.write(
            actor_id=actor_id,
            run_id=run_id,
            subscription_id=subscription_id,
            location=location,
            resource_type=resource_type,
            resource_ids=resource_ids,
            grain=grain,
            window=window,
            metric_names=metric_names,
            raw_body=response.body,
        )
        gaps.extend(archive_result.gaps)

        gaps.extend(
            fold_batch_response(
                body=response.body if isinstance(response.body, Mapping) else {},
                resource_ids=resource_ids,
                metric_names=metric_names,
                accumulators=accumulators,
            )
        )
        return gaps

    async def _handle_fallback(
        self,
        *,
        actor_id: str,
        run_id: str,
        subscription_id: str,
        location: str,
        resource_type: str,
        metric_names: tuple[str, ...],
        accumulators: Mapping[tuple[str, str], MetricAccumulator],
        grain: str,
        window: Mapping[str, str],
        result: LocationRequestResult,
    ) -> list[GapRecord]:
        """Archive and fold every per-resource ARM fallback response
        (`RegionResolver` guarantees each one is `.ok`; a resource whose fallback
        failed entirely is already a `region_unreachable` gap in `result.gaps`, which
        is forwarded unchanged), per Req 24.8.
        """
        gaps: list[GapRecord] = list(result.gaps)

        for resource_id, response in result.fallback_responses.items():
            archive_result = await self.archive_writer.write(
                actor_id=actor_id,
                run_id=run_id,
                subscription_id=subscription_id,
                location=location,
                resource_type=resource_type,
                resource_ids=(resource_id,),
                grain=grain,
                window=window,
                metric_names=metric_names,
                raw_body=response.body,
            )
            gaps.extend(archive_result.gaps)

            gaps.extend(
                fold_fallback_response(
                    body=response.body if isinstance(response.body, Mapping) else {},
                    resource_id=resource_id,
                    metric_names=metric_names,
                    accumulators=accumulators,
                )
            )

        return gaps
