"""The four ports `azure/`'s SDK-touching modules are built against.

`InventoryPort`, `SkuPort`, `DefinitionsPort` and `MetricsPort` are the seam between
"talk to Azure" and "get the paging, the quota headers, the per-resource errors and the
regional fallback right." Each port is a thin transport-level operation — one Resource
Graph page, one SKU listing, one metric-definitions probe, one batch metrics call — and
nothing more. The business logic each requirement is actually about (Req 20.2–20.14,
21.1–21.12, 22.1–22.7, 23.1–23.14, 24.1–24.8) lives in `azure/inventory.py`,
`azure/skus.py`, `azure/definitions.py` and `azure/metrics.py`, which take a port as a
constructor argument and are tested against a fake implementing it.

**Why a port rather than hooking the SDK's own transport.** A transport hook tests
whether the SDK serializes a request correctly, which is Microsoft's problem, not
this codebase's. What Req 20.1–29.9 actually assert is *our handling* of what comes
back — does a `skip_token` get followed, does `x-ms-user-quota-remaining == 0` produce
a wait, does a per-resource `errorCode` become a typed gap rather than a zero. A port
lets a fake hand back exactly the envelope a requirement is about, with no SDK model
class, no HTTP client and no subscription anywhere in the test.

**Why this keeps `collect/` importing nothing from `azure/` at all.** `collect/`
never sees a port. It reaches Azure only through `providers.base.Provider`
(`discover` / `collect` / `capabilities`), which `azure/provider.py` implements by
orchestrating the four modules above — each constructed with a *port*, not with a
concrete Azure client. So the ports are `azure/`'s own internal seam for keeping
`inventory.py`, `skus.py`, `definitions.py` and `metrics.py` unit-testable, not a
second public surface `collect/` has any reason to reach past `providers.base` for.

**Why every method returns an envelope instead of raising on a bad status.**
Per-resource errors arrive at HTTP **200** (Req 29.1) — the call succeeded and
individual resources inside it can still have failed. A port that raised on every
non-2xx and returned a bare body on success would still leave the most common failure
shape needing to be read out of a "successful" return, which is exactly the kind of
two-reading-conventions split that lets one of them go unhandled. So every port method
returns `RawHttpResponse` — status, headers and body together — for **every** outcome
that got an HTTP response at all, 429 and a response-too-large rejection included, and
the caller inspects `.status` and `.body` the same way regardless of which one it got.
A concrete implementation over the real SDK is expected to catch the SDK's own
`HttpResponseError` and rebuild this envelope from it, rather than letting that
exception cross the port.

**The one thing that is not an envelope.** A DNS resolution failure for a location's
regional metrics endpoint (Req 24.2) never reaches a server, so there is no status and
no body to hand back — `DnsResolutionError` is raised instead, and it is the only
exception a port defines.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

__all__ = [
    "AzureTransportError",
    "DefinitionsPort",
    "DnsResolutionError",
    "InventoryPort",
    "MetricsPort",
    "RawHttpResponse",
    "SkuPort",
]


@dataclass(frozen=True, slots=True)
class RawHttpResponse:
    """One HTTP answer from Azure, exactly as it arrived: status, headers, body.

    Frozen, so a module downstream of a port cannot mutate the envelope a fake or a
    real implementation handed it — the same reasoning `tests/fixtures/__init__.py`
    gives `RecordedResponse`, which this type deliberately mirrors: several of the
    behaviours a port exists to make testable live in the envelope rather than in the
    body alone (a quota header, a `Retry-After` value), so headers travel with the
    body rather than being a second argument a caller could forget to pass.

    `body` is `object` rather than a narrower type because it is whatever the caller
    already parsed — a Resource Graph page, a batch metrics response, an ARM error
    envelope — and this module has no business narrowing that; the module that issued
    the request knows its own response shape.
    """

    status: int
    headers: Mapping[str, str]
    body: object

    def header(self, name: str) -> str | None:
        """A header by name, case-insensitively.

        HTTP header names are case-insensitive and Azure's own casing varies by
        service (`x-ms-user-quota-remaining` lowercase, `Retry-After` title case), so
        a case-sensitive lookup would work for one service's headers and silently
        miss another's.
        """
        lowered = name.lower()
        for key, value in self.headers.items():
            if key.lower() == lowered:
                return value
        return None

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


class AzureTransportError(Exception):
    """Base for a port failure that never produced an HTTP envelope.

    Every failure that *did* get a response — a 429, a response-too-large rejection,
    a per-resource 403 inside a 200 — is carried on a returned `RawHttpResponse`
    instead of raised; see the module docstring. This base exists for the one
    genuinely different case, and a caller catching it is catching "there was no
    response at all," never "there was a response and it was bad."
    """


class DnsResolutionError(AzureTransportError):
    """The regional metrics data-plane endpoint for `location` failed to resolve
    (Req 24.2).

    Some regions have no metrics data-plane host, and the failure presents exactly
    this way rather than as a rejected request — there is no server to reject
    anything. `azure/regions.py` catches this to memoise the location as
    fallback-only for the remainder of the run (Req 24.6); `azure/metrics.py` catches
    it to route that location to `MetricsPort.query_resource_fallback` instead.
    """

    def __init__(self, location: str) -> None:
        super().__init__(
            f"the regional metrics data-plane endpoint for location {location!r} "
            f"failed to resolve in DNS"
        )
        self.location = location


@runtime_checkable
class InventoryPort(Protocol):
    """One Resource Graph page (Req 20.1, 20.2, 20.11).

    `azure/inventory.py` owns the `skip_token` loop and the quota-header wait; this
    port hands back one page at a time and lets the caller decide whether to ask for
    another. `resource_types` is a filter the caller applies, not a promise the port
    itself narrows the query — the port issues exactly the request it is asked for.
    """

    async def query_resources(
        self,
        *,
        subscription_id: str,
        resource_types: Sequence[str],
        skip_token: str | None,
    ) -> RawHttpResponse:
        """One page. `body` is the Resource Graph response as returned; `headers`
        carries `x-ms-user-quota-remaining` and `x-ms-user-quota-resets-after` when
        Azure sent them. The port does not parse either — that interpretation
        (Req 20.3, 20.4, 20.14) belongs to `azure/inventory.py`."""
        ...


@runtime_checkable
class SkuPort(Protocol):
    """One `resource_skus.list`, always filtered (Req 21.1).

    `location` is a required keyword rather than an optional filter, so a caller
    cannot construct an unfiltered request through this seam even by omission — an
    unfiltered list returns every SKU in every region, which this port's contract
    makes unreachable rather than merely discouraged.
    """

    async def list_skus(self, *, subscription_id: str, location: str) -> RawHttpResponse:
        """The SKUs available in `location`. `body` is the listing response as
        returned; `azure/skus.py` reads `vCPUsAvailable` and `MemoryGB` out of it."""
        ...


@runtime_checkable
class DefinitionsPort(Protocol):
    """One `MonitorManagementClient.metric_definitions.list` probe against a single
    resource (Req 22.1).

    Probed once per `(resource_type, region)` and cached — that caching and the
    retry-against-at-most-2-further-resources policy (Req 22.4) belong to
    `azure/definitions.py`, not to this port, which issues exactly the one probe it
    is asked for.
    """

    async def list_metric_definitions(
        self, *, resource_id: str, metric_namespace: str
    ) -> RawHttpResponse:
        """The metric definitions Azure reports for `resource_id`'s type and region.
        `body` is the definitions listing as returned."""
        ...


@runtime_checkable
class MetricsPort(Protocol):
    """Batch metric values, the per-resource ARM fallback, and the enhanced-tier
    logical-disk counter — the three ways `azure/metrics.py` reads a metric value.

    All three share this port rather than being split across three because they
    share one concurrency budget (Req 23.7: batch and fallback requests count
    against the same per-subscription semaphore) and, for the first two, one
    grouping key (Req 23.1) and one aggregation set (Req 23.11) — keeping them on one
    port is what lets `azure/metrics.py` reason about them as one budget rather than
    three independently-limited ones.
    """

    async def query_batch(
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
    ) -> RawHttpResponse:
        """One `MetricsClient.query_resources` batch call against `location`'s
        regional data-plane endpoint (Req 23.1, 23.5, 23.10).

        Raises `DnsResolutionError` when that endpoint fails to resolve (Req 24.2).
        Every other outcome — success, a per-resource 403 inside a 200 (Req 29.1), a
        429 carrying `Retry-After` (Req 23.8), a response-too-large rejection
        (Req 23.3) — is a `RawHttpResponse`; the caller reads `.status`, `.header(...)`
        and `.body` to tell them apart.
        """
        ...

    async def query_resource_fallback(
        self,
        *,
        resource_id: str,
        metric_namespace: str,
        metric_names: Sequence[str],
        aggregations: Sequence[str],
        start_time: str,
        end_time: str,
        interval: str,
    ) -> RawHttpResponse:
        """One per-resource `MonitorManagementClient.metrics.list` (Req 24.2, 24.7).

        Two distinct callers reach this: `azure/regions.py`'s DNS fallback for a
        whole location, and `azure/metrics.py`'s own halving loop when a
        single-resource batch still rejects as too large and is split by metric name
        (Req 23.14). Both request the same grain, window, metric names and
        aggregations the batch path would have — this signature carries no
        location-specific parameter because the operation itself is the ARM
        control-plane API, which has no regional endpoint to route through.
        """
        ...

    async def query_logical_disk_free_space(
        self, *, workspace_id: str, resource_id: str, start_time: str, end_time: str
    ) -> RawHttpResponse:
        """One Log Analytics logical-disk `% Free Space` query, for an enhanced-tier
        resource's per-volume figures (Req 31.4, 31.5, 31.6).

        Distinct from the row-counting probe `azure/preflight.py` runs against the
        same query during onboarding: that one only asks *whether* rows exist in the
        trailing 24 hours, this one reads them, including the `InstanceName` value that
        an AMA regression can collapse to `_Total` for every drive (Req 31.6) —
        `collect/pipeline.py` is what turns that collapse into an
        `instance_name_collapsed` gap rather than a mis-attributed per-volume figure.

        **Bounded by the run's own half-open window**, `start_time` and `end_time` as
        RFC 3339 instants, the same two parameters :meth:`query_batch` takes and for the
        same reason (Req 31.4). A trailing-duration bound cannot express this: a July
        report generated in August is about July, and `PT744H` from *now* would read the
        wrong month while looking entirely plausible.
        """
        ...
