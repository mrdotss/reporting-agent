"""The four ports, over the real Azure SDK clients. The only module that builds one.

`azure/ports.py` declares four transport-level seams; `azure/inventory.py`,
`azure/skus.py`, `azure/definitions.py` and `azure/metrics.py` are written against
them and tested against `tests/fakes/azure_ports.py`. This module is the other
implementation — the one that actually talks to Azure — and it is deliberately the
thinnest thing that can be: **build one request, send it through the SDK client's own
pipeline, wrap what comes back in a `RawHttpResponse`.** No paging loop (except the
one the SKU listing genuinely needs), no retry, no interpretation of a status, no
classification of an error code. Every one of those is a requirement some module above
already owns, and a second implementation of it here would be the second one to go
wrong.

**Why the raw wire body rather than an SDK model.** The modules above parse Azure's
own JSON — `data` / `skipToken` for a Resource Graph page, `values[].value[].errorCode`
for a batch metrics response, `value[].name.value` for a definitions probe — because
that is the shape `tests/fixtures/azure/*.json` records and the shape a replayed
archive object holds (Req 26.6). So each adapter sends its request through the SDK
client's pipeline with `send_request`, which azure-core documents as *"Does not do
error handling on your response"*, and reads status, headers and body off the answer.
Handing back a deserialized model instead would mean translating it back into the wire
shape, and a model that drops a field — a per-resource `errorCode`, say — would drop a
gap with it.

**Why the pipeline and not `httpx`.** The pipeline carries the credential policy for
the right audience, the user agent, and the transport, all from the invocation's single
`ClientSecretCredential` (Req 19.1, 19.2). What it deliberately does **not** carry here
is a retry policy's own opinion about 429: `azure/metrics.py` must *see* each 429 to
honour its `Retry-After` and to raise `THROTTLED` on the 5th (Req 23.8, 23.9), and
`azure/inventory.py` must see `x-ms-user-quota-remaining` to wait exactly as long as
Azure said (Req 20.3, 20.4). A retry policy that quietly absorbed either would make
both requirements untestable and unobservable — so responses come back exactly as they
arrived, and every wait in this runtime is one some module chose.

**Every call runs on a worker thread.** The pinned SDK clients are synchronous, so each
adapter awaits `asyncio.to_thread`. That is the same seam `azure/credential.py` is built
around: a sync client's auth policy calls `get_token` on whatever thread the request
runs on, and `InvocationCredential` routes that back into its per-audience lock
(Req 19.5).

**The one exception that crosses a port.** A location whose regional metrics data-plane
host does not resolve raises `DnsResolutionError` (Req 24.2) — there is no status and no
body to hand back, so there is no envelope to return. `azure/regions.py` catches it and
memoises the location as fallback-only for the rest of the run. Every other failure that
reached a server, 429 and a response-too-large rejection included, is a returned
envelope.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Final, Protocol

from azure.core.exceptions import HttpResponseError, ServiceRequestError
from azure.core.rest import HttpRequest

from reporting_agent.azure.credential import (
    ARM_SCOPE,
    LOGS_SCOPE,
    METRICS_DATA_PLANE_SCOPE,
    InvocationCredential,
)
from reporting_agent.azure.ports import DnsResolutionError, RawHttpResponse
from reporting_agent.azure.regions import metrics_data_plane_endpoint

__all__ = [
    "ARM_ENDPOINT",
    "DNS_FAILURE_PHRASES",
    "LOGS_ENDPOINT",
    "METRICS_BATCH_API_VERSION",
    "METRIC_DEFINITIONS_API_VERSION",
    "MONITOR_METRICS_API_VERSION",
    "RESOURCE_GRAPH_API_VERSION",
    "RESOURCE_SKUS_API_VERSION",
    "ArmDefinitionsPort",
    "ArmInventoryPort",
    "ArmSkuPort",
    "AzureMetricsPort",
    "AzurePorts",
    "RequestSender",
    "build_azure_ports",
    "envelope_from_response",
    "inventory_query",
    "is_dns_resolution_failure",
    "pipeline_sender",
]

logger = logging.getLogger(__name__)

# --- endpoints and pinned API versions -----------------------------------------------

ARM_ENDPOINT: Final[str] = "https://management.azure.com"
"""The ARM control plane. It has no regional endpoint, which is exactly why the
per-resource metrics fallback (Req 24.2) resolves when a regional data-plane host does
not, and why it needs no second token audience."""

LOGS_ENDPOINT: Final[str] = "https://api.loganalytics.io"
"""Log Analytics, for the **enhanced** tier only (Req 31.5)."""

RESOURCE_GRAPH_API_VERSION: Final[str] = "2022-10-01"
RESOURCE_SKUS_API_VERSION: Final[str] = "2021-07-01"
METRIC_DEFINITIONS_API_VERSION: Final[str] = "2024-02-01"
MONITOR_METRICS_API_VERSION: Final[str] = "2024-02-01"
METRICS_BATCH_API_VERSION: Final[str] = "2024-02-01"
LOGS_API_VERSION: Final[str] = "v1"
"""Pinned, not floated. The response *shapes* the modules above parse are properties of
these versions — `values[].value[].errorCode` at `2024-02-01` for the batch endpoint,
`data` plus `$skipToken` at `2022-10-01` for Resource Graph — so a floating version
could change a body out from under a parser that has no way to notice."""

MAX_SKU_PAGES: Final[int] = 50
"""A ceiling on the SKU listing's `nextLink` follow (see :class:`ArmSkuPort`). One
location's listing is a few hundred SKUs over a handful of pages; 50 is far above that
and still bounded, so a service that returned a `nextLink` cycle costs a logged warning
rather than a run that never ends."""

DNS_FAILURE_PHRASES: Final[tuple[str, ...]] = (
    "failed to resolve",
    "name or service not known",
    "nodename nor servname provided",
    "temporary failure in name resolution",
    "getaddrinfo failed",
    "name resolution",
    "no address associated with hostname",
)
"""The phrases a DNS resolution failure carries, across platforms and resolvers.

Matched case-insensitively inside a `ServiceRequestError`'s text. Phrase matching is
unlovely, and it is what is available: the transport wraps every connection-level
failure in one exception type, and a region with no metrics data-plane host presents as
a resolution failure rather than as a refused connection or a timeout (Req 24.2).
Matched narrowly on purpose — a connection reset or a TLS failure is **not** routed to
the fallback, because those are transient and the fallback memo is for the rest of the
run (Req 24.6)."""


# --- the sender seam -------------------------------------------------------------------


class RequestSender(Protocol):
    """Sends one `azure.core.rest.HttpRequest` through an SDK client's pipeline.

    Synchronous, because every pinned client is. Injectable, which is what makes each
    adapter below testable: a test hands a sender that returns a stub carrying a
    recorded status, headers and body, and asserts the request the adapter built —
    the method, the URL, the query parameters and the body — without a subscription.
    """

    def __call__(self, request: HttpRequest) -> Any: ...


def pipeline_sender(client: Any) -> RequestSender:
    """The `RequestSender` for one SDK client, over whichever accessor it exposes.

    The pinned clients disagree about the spelling of the same operation, so the
    resolution order is stated once here instead of at four call sites:

    * `send_request` — `azure.monitor.querymetrics.MetricsClient`,
      `azure.monitor.query.LogsQueryClient`.
    * `_send_request` — `azure.mgmt.monitor.MonitorManagementClient`; the escape hatch
      the code generator emits, documented in the generated client itself.
    * `_client.send_request` — `azure.mgmt.resourcegraph.ResourceGraphClient` and
      `azure.mgmt.compute.ComputeManagementClient`, whose generation predates the
      client-level method; `_client` is the `ARMPipelineClient`, and `send_request` on
      it is public azure-core API.

    Every URL this module builds is **absolute**, so no accessor needs to resolve a
    relative path against a base URL and the three behave identically. Raises
    `TypeError` for a client exposing none of them rather than falling back to a
    hand-built pipeline, which would authenticate outside the invocation's single
    credential.
    """
    for accessor in ("send_request", "_send_request"):
        candidate = getattr(client, accessor, None)
        if callable(candidate):
            return candidate
    inner = getattr(client, "_client", None)
    candidate = getattr(inner, "send_request", None)
    if callable(candidate):
        return candidate
    raise TypeError(
        f"{type(client).__name__} exposes no send_request, _send_request or "
        f"_client.send_request, so this module cannot send a request through its "
        f"pipeline; a request sent outside that pipeline would authenticate outside "
        f"the invocation's single credential (Req 19.1)"
    )


# --- turning an SDK answer into the envelope a port returns ---------------------------


def is_dns_resolution_failure(exc: BaseException) -> bool:
    """Whether `exc` is a DNS resolution failure (Req 24.2). **Pure.**

    Reads the whole exception chain's text, because the transport nests the resolver's
    own message inside its wrapper. See :data:`DNS_FAILURE_PHRASES` for why this is a
    phrase match and why it is a narrow one.
    """
    seen: list[str] = []
    current: BaseException | None = exc
    while current is not None and len(seen) < 8:
        seen.append(str(current).casefold())
        current = current.__cause__ or current.__context__
    text = " ".join(seen)
    return any(phrase in text for phrase in DNS_FAILURE_PHRASES)


def _body_of(response: Any) -> object:
    """The response body, parsed as JSON with every number kept exact.

    `parse_float=Decimal` rather than the default `float`: a metric interval's `total`
    and `minimum` arrive here as JSON numbers, and every one of them ends up in a
    snapshot value that has to hash identically in two processes (Req 27.5, 34.1). A
    `float` detour on that path is exactly the determinism bug `collect/accumulate.py`
    refuses to accept a value through, and `azure/metrics.py`'s `_as_decimal` already
    takes a `Decimal` unchanged.

    A body that is absent or is not JSON parses to `None`, which every parser above
    treats as "no rows" rather than raising — the same defensive convention
    `azure/skus.py`'s `_parse_listing` and `azure/inventory.py`'s `_rows_from_body`
    already apply to a malformed page.
    """
    text: str | None = None
    reader = getattr(response, "text", None)
    if callable(reader):
        try:
            text = reader()
        except Exception:  # a body that cannot be read is a body we do not have
            text = None
    if isinstance(text, str) and text.strip():
        try:
            return json.loads(text, parse_float=Decimal)
        except ValueError:
            logger.debug("an Azure response body was not JSON; treating it as absent.")
            return None

    decoder = getattr(response, "json", None)
    if callable(decoder):
        try:
            return decoder()
        except Exception:
            return None
    return None


def envelope_from_response(response: Any) -> RawHttpResponse:
    """One SDK response as the `RawHttpResponse` a port hands back."""
    return RawHttpResponse(
        status=int(getattr(response, "status_code", 0)),
        headers={str(key): str(value) for key, value in dict(response.headers or {}).items()},
        body=_body_of(response),
    )


def _envelope_from_error(exc: HttpResponseError) -> RawHttpResponse:
    """An `HttpResponseError` rebuilt into an envelope, per `azure/ports.py`'s contract.

    Reached only if a pipeline policy raises rather than returning — `send_request`
    itself does no status handling — so this is the defensive floor under that, not an
    expected path. An error carrying no response at all becomes a synthetic 0-status
    envelope, which every caller reads as "not ok" exactly as it would a 500.
    """
    response = getattr(exc, "response", None)
    if response is None:
        return RawHttpResponse(status=0, headers={}, body=None)
    return envelope_from_response(response)


async def _send(sender: RequestSender, request: HttpRequest) -> RawHttpResponse:
    """Send one request on a worker thread and wrap the answer.

    `HttpResponseError` is caught and rebuilt into an envelope (`azure/ports.py`);
    nothing else is caught here, so a `ServiceRequestError` — a connection-level
    failure that never reached a server — propagates to the adapter that knows whether
    it means "this region has no data-plane host" (Req 24.2) or simply "that failed".
    """
    try:
        response = await asyncio.to_thread(sender, request)
    except HttpResponseError as exc:
        return _envelope_from_error(exc)
    return envelope_from_response(response)


# --- inventory: Azure Resource Graph (Req 20.1, 20.2, 20.11) --------------------------


def _kql_literal(value: str) -> str:
    """One KQL single-quoted string literal.

    Doubles embedded quotes and strips control characters. The values interpolated into
    the query below are a subscription id and resource type names, both of which arrive
    from outside this process — the invocation `context` and the Metric_Catalog — so
    neither is quoted into a query without escaping, whatever its provenance.
    """
    cleaned = "".join(character for character in value if character.isprintable())
    return "'" + cleaned.replace("'", "''") + "'"


FACT_FIELD_PREFIX: Final[str] = "fact_"
"""The prefix every projected fact column carries (Req 4.7).

A prefix rather than the bare key, so a fact key can **never** collide with one of the
eight columns `inventory_query` already projects: `id`, `name`, `type`, `location`,
`resourceGroup`, `tags`, `sku` and `powerState`. A declaration naming its key `name` or
`sku` would otherwise silently overwrite the inventory field of the same name, and the
resulting record would look complete while carrying a fact where its own identity should
be. The reader strips this prefix; nothing else in the product spells it."""

_RESERVED_PROJECTION_NAMES: Final[frozenset[str]] = frozenset(
    {"id", "name", "type", "location", "resourceGroup", "tags", "sku", "powerState"}
)
"""The eight columns the projection already emits, asserted against rather than assumed.

The prefix makes a collision impossible, so this is the guard that proves the prefix is
doing its job — if it is ever dropped, the assertion fails instead of a record silently
carrying a fact in its `name` column."""


def inventory_query(
    resource_types: Sequence[str],
    *,
    subscription_id: str,
    fact_projections: Sequence[tuple[str, str]] = (),
) -> str:
    """The Resource Graph query one page is requested with (Req 20.1, 20.11, 4.7).
    **Pure.**

    Projects exactly the fields Req 20.11 enumerates — id, name, type, location,
    resource group, tags, the SKU or size identifier, and
    `properties.extended.instanceView.powerState.code` — and orders by id ascending,
    which is what makes `skip_token` paging stable and the inventory's array order a
    function of the estate rather than of the service's internal ordering.

    `type in~ (...)` matches case-insensitively, because Resource Graph lowercases
    `type` in its response body while the catalog spells it `Microsoft.Compute/
    virtualMachines`. A request naming no resource type omits the type filter entirely
    rather than emitting `in~ ()`, which matches nothing — an empty request list means
    "every type in scope", the same reading `discover`'s group and tag filters take.

    `fact_projections` is `(key, projection)` pairs from the fact declaration, each
    appended to the same `project` clause as `fact_<key> = <projection>`. Two properties
    of how they are appended are load-bearing:

    * **Ordered by key**, not in the order the declaration happened to list them, so two
      runs over one declaration build a byte-identical query. The query string is not
      hashed, but it is the thing a support case quotes and a fixture records, and a
      query that reorders itself between runs makes both useless.
    * **Prefixed** with :data:`FACT_FIELD_PREFIX`, so no fact key can shadow an inventory
      column. See that constant.

    Defaulting to `()` means every existing caller builds the query it built before,
    character for character — the projection clause is unchanged when there is no fact to
    project.
    """
    lines = [
        "Resources",
        f"| where subscriptionId == {_kql_literal(subscription_id)}",
    ]
    if resource_types:
        joined = ", ".join(_kql_literal(name) for name in resource_types)
        lines.append(f"| where type in~ ({joined})")

    projection = [
        "| project id, name, type, location, resourceGroup, tags,",
        "          sku = tostring(properties.hardwareProfile.vmSize),",
        "          powerState = tostring("
        "properties.extended.instanceView.powerState.code)",
    ]
    for key, expression in sorted(fact_projections, key=lambda pair: pair[0]):
        column = f"{FACT_FIELD_PREFIX}{key}"
        assert column not in _RESERVED_PROJECTION_NAMES, column
        projection.append(f"          , {column} = {expression}")

    lines.extend(projection)
    lines.append("| order by id asc")
    return "\n".join(lines)


_SKIP_TOKEN_WIRE_KEY: Final[str] = "$skipToken"
_SKIP_TOKEN_PARSED_KEY: Final[str] = "skipToken"
"""Resource Graph names its continuation token `$skipToken` on the wire — both in a
request's `options` and in a response body — while `azure/inventory.py` and the
recorded fixtures read `skipToken`. :class:`ArmInventoryPort` normalizes the response
key so the collector sees one spelling; the difference is a fact about the service, not
a choice either side gets to make."""


@dataclass(slots=True)
class ArmInventoryPort:
    """`InventoryPort` over `ResourceGraphClient`'s pipeline (Req 20.1, 20.2, 20.11).

    One request per call. The `skip_token` loop, the quota-header waits and every
    power-state gap belong to `azure/inventory.py`; this adapter's whole contribution
    is the query, the continuation token and the envelope.
    """

    sender: RequestSender
    api_version: str = RESOURCE_GRAPH_API_VERSION

    async def query_resources(
        self,
        *,
        subscription_id: str,
        resource_types: Sequence[str],
        skip_token: str | None,
        fact_projections: Sequence[tuple[str, str]] = (),
    ) -> RawHttpResponse:
        options: dict[str, Any] = {"resultFormat": "objectArray"}
        if skip_token:
            options[_SKIP_TOKEN_WIRE_KEY] = skip_token
        request = HttpRequest(
            "POST",
            f"{ARM_ENDPOINT}/providers/Microsoft.ResourceGraph/resources",
            params={"api-version": self.api_version},
            json={
                "subscriptions": [subscription_id],
                "query": inventory_query(
                    resource_types,
                    subscription_id=subscription_id,
                    fact_projections=fact_projections,
                ),
                "options": options,
            },
        )
        response = await _send(self.sender, request)
        return _with_normalized_skip_token(response)


def _with_normalized_skip_token(response: RawHttpResponse) -> RawHttpResponse:
    """The same envelope, with `$skipToken` also present as `skipToken`.

    Additive rather than a rename: the original key stays, so an archived or logged body
    is still the body Azure sent. A response already carrying `skipToken` is returned
    untouched.
    """
    body = response.body
    if not isinstance(body, Mapping):
        return response
    token = body.get(_SKIP_TOKEN_WIRE_KEY)
    if not isinstance(token, str) or not token.strip():
        return response
    if isinstance(body.get(_SKIP_TOKEN_PARSED_KEY), str):
        return response
    return RawHttpResponse(
        status=response.status,
        headers=response.headers,
        body={**dict(body), _SKIP_TOKEN_PARSED_KEY: token},
    )


# --- SKUs: resource_skus.list, always location-filtered (Req 21.1) --------------------


@dataclass(slots=True)
class ArmSkuPort:
    """`SkuPort` over `ComputeManagementClient`'s pipeline (Req 21.1).

    The **one** adapter here that loops, and only because the port's contract is one
    location's whole listing while ARM pages it: `azure/skus.py` parses a single
    `{"value": [...]}` body into `sku_name -> SkuCapacity`, so a listing spread over
    `nextLink` pages is concatenated into one envelope here rather than leaving the
    parser to discover that half its SKUs are missing. A page that answers non-2xx
    short-circuits and is returned as-is, which `azure/skus.py` already reads as "treat
    this location's listing as empty" — and every SKU that would have resolved against
    it then records `sku_unknown` from the input side (Req 21.7) rather than as an
    invented second failure mode.

    `location` is a required keyword on the port, so no call can omit the filter
    (Req 21.1). The `$filter` value is built with `eq` against a quoted location.
    """

    sender: RequestSender
    api_version: str = RESOURCE_SKUS_API_VERSION
    max_pages: int = MAX_SKU_PAGES

    async def list_skus(self, *, subscription_id: str, location: str) -> RawHttpResponse:
        request = HttpRequest(
            "GET",
            f"{ARM_ENDPOINT}/subscriptions/{subscription_id}/providers/"
            f"Microsoft.Compute/skus",
            params={
                "api-version": self.api_version,
                "$filter": f"location eq '{location}'",
            },
        )
        response = await _send(self.sender, request)
        if not response.ok:
            return response

        entries: list[Any] = []
        pages = 0
        current = response
        while True:
            body = current.body if isinstance(current.body, Mapping) else {}
            value = body.get("value")
            if isinstance(value, list):
                entries.extend(value)
            next_link = body.get("nextLink")
            pages += 1
            if not isinstance(next_link, str) or not next_link.strip():
                break
            if pages >= self.max_pages:
                logger.warning(
                    "the resource_skus listing for location %r still carried a "
                    "nextLink after %d pages; %d SKU(s) are used and the rest are "
                    "ignored for this run.",
                    location,
                    pages,
                    len(entries),
                )
                break
            current = await _send(self.sender, HttpRequest("GET", next_link))
            if not current.ok:
                return current

        return RawHttpResponse(
            status=response.status, headers=response.headers, body={"value": entries}
        )


# --- definitions: metric_definitions.list, one probe per pair (Req 22.1) --------------


@dataclass(slots=True)
class ArmDefinitionsPort:
    """`DefinitionsPort` over `MonitorManagementClient`'s pipeline (Req 22.1).

    One probe against one resource. The once-per-`(resource_type, region)` caching, the
    probe-target selection and the retry against at most 2 further resources are
    `azure/definitions.py`'s (Req 22.2, 22.4).

    `metricDefinitions` answers with a flat `{"value": [...]}` and no continuation, so
    unlike the SKU listing there is no page to follow — and inventing one would mean
    following a link the service does not send.
    """

    sender: RequestSender
    api_version: str = METRIC_DEFINITIONS_API_VERSION

    async def list_metric_definitions(
        self, *, resource_id: str, metric_namespace: str
    ) -> RawHttpResponse:
        request = HttpRequest(
            "GET",
            f"{ARM_ENDPOINT}{resource_id}/providers/microsoft.insights/metricDefinitions",
            params={
                "api-version": self.api_version,
                "metricnamespace": metric_namespace,
            },
        )
        return await _send(self.sender, request)


# --- metrics: the batch data plane, the ARM fallback, and Log Analytics ---------------


@dataclass(slots=True)
class AzureMetricsPort:
    """`MetricsPort` over three endpoints, one credential (Req 23.1, 24.2, 31.5).

    * **batch** — `MetricsClient.query_resources`'s own operation,
      `POST /subscriptions/{id}/metrics:getBatch`, against
      `https://{location}.metrics.monitor.azure.com` (Req 23.1, 23.5, 23.10). One
      client per location, built on first use, because the endpoint is regional while
      the audience is not.
    * **fallback** — `MonitorManagementClient.metrics.list`'s own operation,
      `GET {resourceUri}/providers/microsoft.insights/metrics` on
      `management.azure.com`, which has no regional endpoint and therefore resolves
      when a data-plane host does not (Req 24.2, 24.7).
    * **logs** — the Log Analytics query the enhanced tier's logical-disk counter needs
      (Req 31.5, 31.6).

    `metrics_client_factory` is the seam a test replaces to avoid constructing a real
    regional client; production leaves it unset and gets
    `azure.monitor.querymetrics.MetricsClient`.
    """

    arm_sender: RequestSender
    metrics_client_factory: Callable[[str], Any] | None = None
    logs_sender_factory: Callable[[], RequestSender] | None = None
    batch_api_version: str = METRICS_BATCH_API_VERSION
    fallback_api_version: str = MONITOR_METRICS_API_VERSION
    _batch_senders: dict[str, RequestSender] = field(default_factory=dict, repr=False)
    _batch_clients: list[Any] = field(default_factory=list, repr=False)
    _logs_sender: RequestSender | None = field(default=None, repr=False)

    # --- the batch path -------------------------------------------------------------

    def _batch_sender(self, location: str) -> RequestSender:
        """The sender for one location's regional data-plane client, built once.

        Construction itself can raise nothing DNS-related — the client resolves no host
        until a request is sent — so a location with no data-plane host fails on the
        request, which is where `DnsResolutionError` belongs (Req 24.2).
        """
        sender = self._batch_senders.get(location)
        if sender is not None:
            return sender
        factory = self.metrics_client_factory
        if factory is None:  # pragma: no cover - exercised only with real SDK clients
            raise RuntimeError(
                "no metrics client factory is configured; build this port through "
                "build_azure_ports, which supplies one over the invocation credential"
            )
        client = factory(location)
        self._batch_clients.append(client)
        sender = pipeline_sender(client)
        self._batch_senders[location] = sender
        return sender

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
        """One batch call against `location`'s regional endpoint.

        Raises `DnsResolutionError` when the host does not resolve (Req 24.2) and lets
        every other connection-level failure propagate unchanged: a reset or a TLS
        failure is transient, and routing it to the fallback would memoise a whole
        location as fallback-only for the rest of the run over a blip (Req 24.6).
        """
        request = HttpRequest(
            "POST",
            f"{metrics_data_plane_endpoint(location)}/subscriptions/"
            f"{subscription_id}/metrics:getBatch",
            params={
                "api-version": self.batch_api_version,
                "starttime": start_time,
                "endtime": end_time,
                "interval": interval,
                "metricnamespace": metric_namespace,
                "metricnames": ",".join(metric_names),
                "aggregation": ",".join(aggregations),
            },
            json={"resourceids": list(resource_ids)},
        )
        sender = self._batch_sender(location)
        try:
            return await _send(sender, request)
        except ServiceRequestError as exc:
            if is_dns_resolution_failure(exc):
                raise DnsResolutionError(location) from exc
            raise

    # --- the per-resource ARM fallback ----------------------------------------------

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
        """One per-resource `metrics.list`, carrying the batch path's own parameters.

        The same grain, window, metric names and aggregations the batch call would have
        carried (Req 24.7), expressed the way this operation takes them: one `timespan`
        of `start/end` rather than two parameters.
        """
        request = HttpRequest(
            "GET",
            f"{ARM_ENDPOINT}{resource_id}/providers/microsoft.insights/metrics",
            params={
                "api-version": self.fallback_api_version,
                "timespan": f"{start_time}/{end_time}",
                "interval": interval,
                "metricnamespace": metric_namespace,
                "metricnames": ",".join(metric_names),
                "aggregation": ",".join(aggregations),
            },
        )
        return await _send(self.arm_sender, request)

    # --- the enhanced tier's logical-disk counter ------------------------------------

    async def query_logical_disk_free_space(
        self, *, workspace_id: str, resource_id: str, start_time: str, end_time: str
    ) -> RawHttpResponse:
        """The enhanced tier's per-volume `% Free Space` rows (Req 31.4, 31.5, 31.6).

        Scoped to the one resource and bounded to the run's own half-open window, so the
        query cannot quietly read another VM's counters or a period the report is not
        about — the `timespan` is the ISO 8601 interval `start/end`, exactly the window
        the batch metrics path requested, rather than a trailing duration measured from
        whenever the run happens to execute.

        `InstanceName` is projected because an AMA regression can collapse it to
        `_Total` for every drive, and `collect/pipeline.py` must turn that into an
        `instance_name_collapsed` gap rather than a mis-attributed per-volume figure
        (Req 31.6).
        """
        computer = resource_id.rstrip("/").rsplit("/", 1)[-1]
        query = (
            'Perf | where ObjectName == "LogicalDisk" '
            'and CounterName == "% Free Space" '
            f"and Computer =~ {_kql_literal(computer)} "
            "| project TimeGenerated, Computer, ObjectName, CounterName, "
            "InstanceName, CounterValue"
        )
        request = HttpRequest(
            "POST",
            f"{LOGS_ENDPOINT}/{LOGS_API_VERSION}/workspaces/{workspace_id}/query",
            json={"query": query, "timespan": f"{start_time}/{end_time}"},
        )
        return await _send(self._logs(), request)

    def _logs(self) -> RequestSender:
        sender = self._logs_sender
        if sender is None:
            factory = self.logs_sender_factory
            if factory is None:  # pragma: no cover - only without a configured factory
                raise RuntimeError(
                    "no Log Analytics sender is configured; the enhanced tier needs "
                    "one built over the invocation credential's logs audience"
                )
            sender = factory()
            self._logs_sender = sender
        return sender

    # --- teardown -------------------------------------------------------------------

    def close(self) -> None:
        """Close every regional client this port built. Never raises."""
        for client in self._batch_clients:
            _close_quietly(client)
        self._batch_clients.clear()
        self._batch_senders.clear()


# --- assembly --------------------------------------------------------------------------


@dataclass(slots=True)
class AzurePorts:
    """The four ports for one invocation, plus the clients behind them.

    Held together so `close` releases every transport the run opened in one call —
    `azure/provider.py`'s own `close` is what invokes it, at run end.
    """

    inventory: ArmInventoryPort
    skus: ArmSkuPort
    definitions: ArmDefinitionsPort
    metrics: AzureMetricsPort
    _clients: tuple[Any, ...] = field(default=(), repr=False)

    def close(self) -> None:
        """Close every SDK client. Never raises: this runs on the teardown path, where
        raising would replace a real terminal error with a cleanup one."""
        self.metrics.close()
        for client in self._clients:
            _close_quietly(client)


def _close_quietly(client: Any) -> None:
    closer = getattr(client, "close", None)
    if not callable(closer):
        return
    try:
        closer()
    except Exception as exc:  # pragma: no cover - defensive teardown
        logger.debug("closing %s failed: %s", type(client).__name__, exc)


def build_azure_ports(
    *, credential: InvocationCredential, subscription_id: str
) -> AzurePorts:
    """Build the four SDK-backed ports over one invocation's single credential.

    Every client here is constructed from `credential.for_scope(...)` — a per-audience
    **view** over the one `ClientSecretCredential` the invocation already built, not a
    second credential (Req 19.1, 19.2). Two audiences are in play at construction time,
    `management.azure.com` for the three ARM clients and the metrics data plane for the
    regional batch clients, plus Log Analytics on first enhanced-tier use; all three
    come from the same instance, which is why the data-plane fallback to ARM needs no
    new token scope.

    The regional batch clients are **not** built here: their endpoint depends on a
    location the run has not enumerated yet, so a factory is passed instead and each
    location's client is built on first use.
    """
    from azure.mgmt.compute import ComputeManagementClient
    from azure.mgmt.monitor import MonitorManagementClient
    from azure.mgmt.resourcegraph import ResourceGraphClient
    from azure.monitor.querymetrics import MetricsClient

    arm_credential = credential.for_scope(ARM_SCOPE)

    resource_graph = ResourceGraphClient(arm_credential)
    compute = ComputeManagementClient(arm_credential, subscription_id)
    monitor = MonitorManagementClient(arm_credential, subscription_id)

    def metrics_client_factory(location: str) -> Any:
        return MetricsClient(
            endpoint=metrics_data_plane_endpoint(location),
            credential=credential.for_scope(METRICS_DATA_PLANE_SCOPE),
        )

    def logs_sender_factory() -> RequestSender:
        from azure.monitor.query import LogsQueryClient

        return pipeline_sender(LogsQueryClient(credential.for_scope(LOGS_SCOPE)))

    return AzurePorts(
        inventory=ArmInventoryPort(sender=pipeline_sender(resource_graph)),
        skus=ArmSkuPort(sender=pipeline_sender(compute)),
        definitions=ArmDefinitionsPort(sender=pipeline_sender(monitor)),
        metrics=AzureMetricsPort(
            arm_sender=pipeline_sender(monitor),
            metrics_client_factory=metrics_client_factory,
            logs_sender_factory=logs_sender_factory,
        ),
        _clients=(resource_graph, compute, monitor),
    )
