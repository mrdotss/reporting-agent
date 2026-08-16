"""The regional metrics data-plane endpoint, and the DNS-failure fallback memo.

Not every region has a metrics data-plane host, and the failure presents as a **DNS
resolution failure** rather than a rejected request — there is no server to reject
anything (Req 24.2). This module is the one place that fact is handled: it decides,
per location, whether a batch request against
`https://{location}.metrics.monitor.azure.com` (Req 24.1) is still worth attempting,
and once a location has failed DNS resolution once, it **memoises that location as
fallback-only for the remainder of the run** (Req 24.6) — every later request for it
skips `MetricsPort.query_batch` entirely and goes straight to the per-resource ARM
control-plane fallback, `MonitorManagementClient.metrics.list`, which resolves
precisely because `management.azure.com` has no regional endpoint and needs no new
token scope (the run's single `ClientSecretCredential` already serves that audience).

**The region is never dropped** (Req 24.3): every distinct location a caller asks this
resolver about receives at least one metric request, batch or fallback, and that fact
is tracked (`requested_locations`) so a caller — `azure/metrics.py`, and ultimately
`collect/pipeline.py` — can prove no location was silently skipped.

**A location whose fallback also fails is a gap, not a silent zero** (Req 24.4). If
every resource requested through the fallback path for one location fails to answer —
whether the port raises or answers with a non-2xx status — this module records a
`region_unreachable` gap for each of them, with no statistic and no zero value, and
exposes the location as unreachable. `REGION_UNREACHABLE` is non-terminal by
construction here (`RegionUnreachableError.default_terminal` is `False`): this
resolver reasons about one location at a time and has no view of the others, so it
never escalates to a run failure on its own. Only `collect/pipeline.py` — seeing every
requested location come back unreachable (Req 24.5) — may construct the terminal
variant; `unreachable_error` below always returns the non-terminal one.

**What this module deliberately does not do.** It does not fold a response into a
statistic, does not classify a per-resource business error (a 403 inside an
otherwise-answering fallback call) as anything other than "this resource answered",
and does not decide batch sizing or concurrency. Those are `azure/metrics.py`'s job
(Req 23.x); this module's contract with it is narrow and stated in
:class:`LocationRequestResult` and :meth:`RegionResolver.request_batch_or_fallback`.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Final

from reporting_agent.azure.ports import DnsResolutionError, MetricsPort, RawHttpResponse
from reporting_agent.collect.log import GAP_TYPE_REGION_UNREACHABLE, record_gap
from reporting_agent.errors import RegionUnreachableError
from reporting_agent.providers.base import GapRecord

__all__ = [
    "METRICS_DATA_PLANE_ENDPOINT_TEMPLATE",
    "LocationRequestResult",
    "RegionResolver",
    "metrics_data_plane_endpoint",
]

logger = logging.getLogger(__name__)

METRICS_DATA_PLANE_ENDPOINT_TEMPLATE: Final[str] = "https://{location}.metrics.monitor.azure.com"
"""Req 24.1. The `location` component of a batch call's `(subscription, location,
resource_type)` grouping key selects this host. The DNS resolution attempt itself
happens inside a concrete `MetricsPort.query_batch` implementation, not here — this
module reacts to `DnsResolutionError`, it does not perform the lookup."""


def metrics_data_plane_endpoint(location: str) -> str:
    """The regional metrics data-plane endpoint for `location` (Req 24.1). **Pure.**

    Declared as a function rather than inlined at every call site that logs or
    reasons about which host a batch request targeted, so the template is spelled
    once. Raises `ValueError` for a blank location rather than returning a malformed
    URL — an empty `location` is a caller bug, not a location to route around.
    """
    if not isinstance(location, str) or not location.strip():
        raise ValueError(f"location must be a non-empty string, got {location!r}")
    return METRICS_DATA_PLANE_ENDPOINT_TEMPLATE.format(location=location)


@dataclass(frozen=True, slots=True)
class LocationRequestResult:
    """The outcome of routing one location's metric request through
    :meth:`RegionResolver.request_batch_or_fallback`.

    `via_fallback` is `True` whenever the per-resource ARM path served this call —
    because the location was already memoised fallback-only, or because this is the
    very call that just discovered the DNS failure and fell through within itself.
    `batch_response` and `fallback_responses` never both carry data: a batch call
    carries only `batch_response`, a fallback call carries only
    `fallback_responses` (plus, on failure, `gaps`).

    `fallback_responses` maps resource id -> `RawHttpResponse` for every resource
    whose per-resource fallback request answered, successfully or not.
    `azure/metrics.py` reads `.ok` on each exactly as it would for a batch response —
    a per-resource business error (a 403, say) inside a response that *did* answer is
    that module's gap to classify, not this one's.

    `gaps` carries one `region_unreachable` `GapRecord` (Req 24.4) for every resource
    whose per-resource fallback did not answer **at all** — the port raised, or
    answered with a non-2xx status. Deliberately not folded into
    `fallback_responses`: a resource named only in `gaps` has no `RawHttpResponse` for
    a caller to read a statistic from, on purpose.
    """

    location: str
    via_fallback: bool
    batch_response: RawHttpResponse | None
    fallback_responses: dict[str, RawHttpResponse]
    gaps: tuple[GapRecord, ...]

    @property
    def location_unreachable(self) -> bool:
        """`True` when this location answered through **no** path at all for **any**
        of its requested resources (Req 24.4) — every one produced a
        `region_unreachable` gap and none produced a usable response.

        `False` for a successful batch call (`via_fallback` is `False`) and `False`
        for a fallback call in which at least one resource answered: a region that
        answered for some resources and not others is a set of ordinary per-resource
        gaps for `azure/metrics.py` to classify, not a `region_unreachable` region.
        """
        if not self.via_fallback:
            return False
        return bool(self.gaps) and not self.fallback_responses


@dataclass(slots=True)
class RegionResolver:
    """Routes one location's metric request to the batch endpoint or, once a DNS
    failure has been observed for it, to the per-resource ARM fallback (Req 24.1,
    24.2, 24.6) — and tracks the per-run facts `azure/metrics.py` and
    `collect/pipeline.py` need to prove no location was silently dropped (Req 24.3)
    and to decide the all-locations-unreachable escalation (Req 24.5).

    One instance per run, constructed over the run's single `MetricsPort`. All state
    below is plain per-run bookkeeping with no cross-run persistence — a location is
    only ever fallback-only *for the remainder of the run that observed its DNS
    failure* (Req 24.6), never beyond it.
    """

    port: MetricsPort
    _fallback_only: set[str] = field(default_factory=set, repr=False)
    _requested: set[str] = field(default_factory=set, repr=False)
    _unreachable: set[str] = field(default_factory=set, repr=False)

    # --- state a caller can consume without going through the orchestration ---------

    def is_fallback_only(self, location: str) -> bool:
        """Whether `location` has already failed DNS resolution this run (Req 24.6)."""
        return location in self._fallback_only

    def mark_fallback_only(self, location: str) -> None:
        """Memoise `location` as fallback-only for the remainder of the run (Req 24.6).

        Idempotent. Exposed as a standalone method — not only reached through
        :meth:`request_batch_or_fallback` — so a caller that drives its own
        `MetricsPort.query_batch` call and catches `DnsResolutionError` itself can
        still keep this resolver's memoised state accurate for every later request.
        """
        if location not in self._fallback_only:
            logger.info(
                "location %s failed DNS resolution against %s; routing every later "
                "request for it to the per-resource ARM fallback with no further DNS "
                "attempt.",
                location,
                metrics_data_plane_endpoint(location),
            )
        self._fallback_only.add(location)

    @property
    def fallback_only_locations(self) -> frozenset[str]:
        """Every location memoised fallback-only so far this run."""
        return frozenset(self._fallback_only)

    @property
    def requested_locations(self) -> frozenset[str]:
        """Every location that has received at least one metric request through this
        resolver, batch or fallback (Req 24.3)."""
        return frozenset(self._requested)

    @property
    def unreachable_locations(self) -> frozenset[str]:
        """Every location for which the most recent request found no path — batch or
        fallback — that answered for any of its resources (Req 24.4).

        Reflects only the **most recent** request for each location: if a location
        first came back unreachable and a later call for it (with a different
        resource set) succeeds, it is removed from this set. There is at most one
        request per location in the foundation's batching plan, so this distinction
        does not arise in practice, but the resolver does not assume it.
        """
        return frozenset(self._unreachable)

    def all_requested_locations_unreachable(self) -> bool:
        """Req 24.5's condition: every distinct location requested this run resolved
        unreachable. `False` when nothing has been requested yet — there is nothing
        to escalate from an empty run.

        `collect/pipeline.py` reads this once collection finishes requesting every
        location; this resolver never escalates on its own.
        """
        return bool(self._requested) and self._requested <= self._unreachable

    def unreachable_error(self, location: str) -> RegionUnreachableError:
        """A **non-terminal** `RegionUnreachableError` naming `location` (Req 24.4).

        Always non-terminal: this resolver reasons about one location at a time and
        has no view of the others, so it can never itself observe Req 24.5's
        all-locations condition. `collect/pipeline.py` is the only place a
        `terminal=True` instance may be constructed, once
        `all_requested_locations_unreachable()` is true.
        """
        return RegionUnreachableError(
            f"location {location!r} answered through neither the batch metrics "
            f"endpoint nor the per-resource ARM fallback; every resource requested "
            f"for it carries a region_unreachable gap with no statistic and no zero "
            f"value recorded."
        )

    # --- the orchestration a metrics collector delegates to --------------------------

    async def request_batch_or_fallback(
        self,
        *,
        location: str,
        subscription_id: str,
        resource_ids: Sequence[str],
        metric_namespace: str,
        metric_names: Sequence[str],
        aggregations: Sequence[str],
        start_time: str,
        end_time: str,
        interval: str,
    ) -> LocationRequestResult:
        """Request one location's metrics, batch or fallback, with the location
        always receiving at least one request (Req 24.3).

        If `location` is not yet memoised fallback-only, tries
        `MetricsPort.query_batch` first (Req 24.1). A `DnsResolutionError` there
        memoises the location (Req 24.6) and falls through to the per-resource path
        **within this same call** — the caller never has to notice the transition or
        retry anything itself, and no second DNS attempt is made for this or any
        later call.

        Once routed to fallback — because the location was already memoised, or
        because this call is the one that just discovered the failure — every id in
        `resource_ids` is requested individually through
        `MetricsPort.query_resource_fallback`, carrying the identical grain, window,
        metric names and aggregations the batch call would have carried (Req 24.7). A
        resource whose fallback call raises, or answers with a non-2xx status,
        contributes a `region_unreachable` gap and no entry in `fallback_responses`
        (Req 24.4); one that answers 2xx contributes its `RawHttpResponse`.

        Raises `ValueError` for an empty `resource_ids` — there is nothing to
        request, and issuing a request against zero resources would not be a real
        exercise of either path.
        """
        if not resource_ids:
            raise ValueError("resource_ids must be non-empty; there is nothing to request")

        self._requested.add(location)

        if not self.is_fallback_only(location):
            try:
                response = await self.port.query_batch(
                    location=location,
                    subscription_id=subscription_id,
                    resource_ids=resource_ids,
                    metric_namespace=metric_namespace,
                    metric_names=metric_names,
                    aggregations=aggregations,
                    start_time=start_time,
                    end_time=end_time,
                    interval=interval,
                )
            except DnsResolutionError as exc:
                self.mark_fallback_only(exc.location)
            else:
                self._unreachable.discard(location)
                return LocationRequestResult(
                    location=location,
                    via_fallback=False,
                    batch_response=response,
                    fallback_responses={},
                    gaps=(),
                )

        return await self._request_fallback(
            location=location,
            resource_ids=resource_ids,
            metric_namespace=metric_namespace,
            metric_names=metric_names,
            aggregations=aggregations,
            start_time=start_time,
            end_time=end_time,
            interval=interval,
        )

    async def _request_fallback(
        self,
        *,
        location: str,
        resource_ids: Sequence[str],
        metric_namespace: str,
        metric_names: Sequence[str],
        aggregations: Sequence[str],
        start_time: str,
        end_time: str,
        interval: str,
    ) -> LocationRequestResult:
        """Every resource in `resource_ids`, one at a time, through
        `MetricsPort.query_resource_fallback` (Req 24.2, 24.7)."""
        fallback_responses: dict[str, RawHttpResponse] = {}
        gaps: list[GapRecord] = []

        for resource_id in resource_ids:
            try:
                response = await self.port.query_resource_fallback(
                    resource_id=resource_id,
                    metric_namespace=metric_namespace,
                    metric_names=metric_names,
                    aggregations=aggregations,
                    start_time=start_time,
                    end_time=end_time,
                    interval=interval,
                )
            except Exception as exc:  # the ARM fallback itself did not answer
                gaps.append(
                    record_gap(
                        GAP_TYPE_REGION_UNREACHABLE,
                        resource_id,
                        None,
                        f"the per-resource metrics fallback for location {location!r} "
                        f"raised for resource {resource_id!r}: {exc}; no statistic and "
                        f"no zero value are recorded for it.",
                    )
                )
                continue

            if not response.ok:
                gaps.append(
                    record_gap(
                        GAP_TYPE_REGION_UNREACHABLE,
                        resource_id,
                        None,
                        f"the per-resource metrics fallback for location {location!r} "
                        f"answered resource {resource_id!r} with status "
                        f"{response.status}; no statistic and no zero value are "
                        f"recorded for it.",
                    )
                )
                continue

            fallback_responses[resource_id] = response

        result = LocationRequestResult(
            location=location,
            via_fallback=True,
            batch_response=None,
            fallback_responses=fallback_responses,
            gaps=tuple(gaps),
        )

        if result.location_unreachable:
            self._unreachable.add(location)
            logger.warning(
                "location %s answered through neither the batch path nor the "
                "per-resource fallback for any of its %d requested resources; "
                "recording REGION_UNREACHABLE as a non-terminal gap.",
                location,
                len(resource_ids),
            )
        else:
            self._unreachable.discard(location)

        return result
