"""Fakes for the four ports in `reporting_agent.azure.ports`, replaying recordings from
`tests/fixtures/azure/`.

Every fake here is a **scripted sequence**, not a stateful simulation of Azure: the
constructor takes the exact sequence of `RawHttpResponse` objects (or, for
`FakeMetricsPort.query_batch`, `DnsResolutionError` instances) the port should hand
back, in order, and each call pops the next one. That is deliberate. The requirements
these fakes exist to exercise are about a *sequence* of answers — a paging loop that
keeps going while `skip_token` is present, a halving loop that keeps halving while the
response says too-large, a quota wait that repeats up to 3 times before the 4th
raises — so the fake's job is to hand back the exact sequence a fixture recording
describes and then let the module under test's own control flow decide what to do
next. A fake that tried to be "smart" about what the next response should be would
just be reimplementing the collector inside its own test double.

Every call is also **recorded**: `.calls` on each fake is a list of the keyword
arguments it was invoked with, so a test can assert Req 21.1's "always location-filtered"
or Req 23.1's "one metric_namespace per call" against what the module under test
actually sent, not just against what it got back.
"""

from __future__ import annotations

import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from reporting_agent.azure.ports import DnsResolutionError, ProbeResult, RawHttpResponse

__all__ = [
    "DNS_REACHABLE_LOCATIONS",
    "DNS_UNREACHABLE_LOCATIONS",
    "ExhaustedScriptError",
    "FakeDefinitionsPort",
    "FakeFactsPort",
    "FakeInventoryPort",
    "FakeMetricsPort",
    "FakeSkuPort",
    "empty_fact_list",
    "facts_port_answering_nothing",
    "raw_response_from_recorded",
]

# A DNS resolution failure (Req 24.2) never produces an HTTP envelope, so it has no
# place in `tests/fixtures/azure/`, whose convention is "status, headers, body" for
# exactly the responses that got one — see `AzureTransportError` /
# `DnsResolutionError` in `reporting_agent.azure.ports`. These two tuples are the
# fixture-equivalent for that case: a fake or a test picks a location from
# `DNS_UNREACHABLE_LOCATIONS` to script a `DnsResolutionError`, and one from
# `DNS_REACHABLE_LOCATIONS` as the control value that must keep resolving normally —
# proving a region resolver's fallback memoisation (Req 24.6) is scoped to the one
# location that failed and does not leak across an unrelated one.
DNS_UNREACHABLE_LOCATIONS: tuple[str, ...] = ("norwayeast",)
DNS_REACHABLE_LOCATIONS: tuple[str, ...] = ("southeastasia", "australiaeast")


class ExhaustedScriptError(RuntimeError):
    """A fake port was called more times than its scripted sequence provides.

    Raised rather than looping or returning a stale response, because a test relying
    on this fake calling further than its script goes is a test whose fixture is
    wrong, not a test that should silently observe a repeated response.
    """

    def __init__(self, port_name: str, method_name: str) -> None:
        super().__init__(
            f"{port_name}.{method_name} was called with no scripted response left; "
            f"the fake was given fewer responses than the test called it"
        )


@dataclass
class _ScriptedCalls:
    """Shared bookkeeping: a thread-safe call log plus a thread-safe response queue.

    A `threading.Lock` rather than nothing, because the modules under test — the
    real `azure/metrics.py` chief among them — issue concurrent requests from
    `asyncio.to_thread` workers (Req 23.7's concurrency cap is exactly this), so a
    fake standing in for the port must not race on its own list.
    """

    responses: list[object] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def record_and_pop(self, *, port_name: str, method_name: str, **kwargs: Any) -> object:
        with self._lock:
            self.calls.append(kwargs)
            if not self.responses:
                raise ExhaustedScriptError(port_name, method_name)
            return self.responses.pop(0)


class FakeInventoryPort:
    """Replays a sequence of Resource Graph pages (Req 20.2, 20.3, 20.4, 20.14).

    One `RawHttpResponse` per call to :meth:`query_resources`, in the order given to
    the constructor — typically a paging sequence ending in a page whose body carries
    no `skipToken`.
    """

    def __init__(self, responses: Sequence[RawHttpResponse]) -> None:
        self._state = _ScriptedCalls(responses=list(responses))

    @property
    def calls(self) -> list[dict[str, Any]]:
        return self._state.calls

    async def query_resources(
        self,
        *,
        subscription_id: str,
        resource_types: Sequence[str],
        skip_token: str | None,
        fact_projections: Sequence[tuple[str, str]] = (),
    ) -> RawHttpResponse:
        result = self._state.record_and_pop(
            port_name="FakeInventoryPort",
            method_name="query_resources",
            subscription_id=subscription_id,
            resource_types=tuple(resource_types),
            skip_token=skip_token,
            # Recorded so a test can assert the projections reached the port. A fake that
            # accepted the argument and dropped it would let the whole wiring be asserted
            # against nothing.
            fact_projections=tuple(fact_projections),
        )
        assert isinstance(result, RawHttpResponse)
        return result

    async def query_distinct_dimensions(
        self, *, subscription_id: str
    ) -> RawHttpResponse:
        """The next scripted response, recorded like every other call.

        Scripted from the **same** sequence as :meth:`query_resources`, not a second one.
        That is what lets a test assert Req 9.1's "one query per call": a fake with a
        separate queue per method could not notice a `distinct_dimensions` that also paged
        the inventory, because both would find a response waiting.
        """
        result = self._state.record_and_pop(
            port_name="FakeInventoryPort",
            method_name="query_distinct_dimensions",
            subscription_id=subscription_id,
        )
        assert isinstance(result, RawHttpResponse)
        return result

    async def query_resource_counts(
        self, *, subscription_id: str
    ) -> RawHttpResponse:
        """The next scripted response, from the **same** queue as the other two methods.

        One queue for the same reason: a test asserting that the scan issues exactly two
        Resource Graph queries — dimensions and counts — could not notice a third if each
        method had its own inexhaustible supply.
        """
        result = self._state.record_and_pop(
            port_name="FakeInventoryPort",
            method_name="query_resource_counts",
            subscription_id=subscription_id,
        )
        assert isinstance(result, RawHttpResponse)
        return result

    async def query_child_resources(
        self, *, subscription_id: str
    ) -> RawHttpResponse:
        """The next scripted response, from the **same** shared queue (task 6.1).

        `AzureProvider.discover` calls this only when the scope actually requests a
        resource type that has a synthetic child type (e.g. VNets, for subnets) —
        never unconditionally — so a test scripting only `query_resources`'s own
        responses and never requesting such a type is unaffected. A test that DOES
        request one and forgets to script this call's response gets
        `ExhaustedScriptError` rather than a silent success, the same discipline every
        other method on this fake already gives.
        """
        result = self._state.record_and_pop(
            port_name="FakeInventoryPort",
            method_name="query_child_resources",
            subscription_id=subscription_id,
        )
        assert isinstance(result, RawHttpResponse)
        return result


class FakeFactsPort:
    """Scripts the four non-projectable fact sources (Req 4.8, 5.1, 5.2, 5.3, 16.7).

    **Four independent queues**, unlike `FakeInventoryPort`'s one, because the four methods
    are four different services and a test almost always wants to script them
    asymmetrically — a successful backup list beside a rejected reservation listing is the
    ordinary subscription, not an edge case.

    A queue left empty means "this test does not exercise that source", and calling it is a
    test bug rather than an observation, so it raises :class:`ExhaustedScriptError` the way
    every other fake here does.
    """

    def __init__(
        self,
        *,
        backup_responses: Sequence[RawHttpResponse] = (),
        replication_responses: Sequence[RawHttpResponse] = (),
        reservation_responses: Sequence[RawHttpResponse] = (),
        advisor_responses: Sequence[RawHttpResponse] = (),
    ) -> None:
        self._backup = _ScriptedCalls(responses=list(backup_responses))
        self._replication = _ScriptedCalls(responses=list(replication_responses))
        self._reservations = _ScriptedCalls(responses=list(reservation_responses))
        self._advisor = _ScriptedCalls(responses=list(advisor_responses))

    @property
    def backup_calls(self) -> list[dict[str, Any]]:
        return self._backup.calls

    @property
    def replication_calls(self) -> list[dict[str, Any]]:
        return self._replication.calls

    @property
    def reservation_calls(self) -> list[dict[str, Any]]:
        return self._reservations.calls

    @property
    def advisor_calls(self) -> list[dict[str, Any]]:
        return self._advisor.calls

    async def list_backup_protected_items(
        self, *, subscription_id: str
    ) -> RawHttpResponse:
        return _one(
            self._backup.record_and_pop(
                port_name="FakeFactsPort",
                method_name="list_backup_protected_items",
                subscription_id=subscription_id,
            )
        )

    async def list_replication_protected_items(self, *, vault_id: str) -> RawHttpResponse:
        return _one(
            self._replication.record_and_pop(
                port_name="FakeFactsPort",
                method_name="list_replication_protected_items",
                vault_id=vault_id,
            )
        )

    async def list_reservations(self) -> RawHttpResponse:
        return _one(
            self._reservations.record_and_pop(
                port_name="FakeFactsPort", method_name="list_reservations"
            )
        )

    async def list_recommendations(self, *, subscription_id: str) -> RawHttpResponse:
        return _one(
            self._advisor.record_and_pop(
                port_name="FakeFactsPort",
                method_name="list_recommendations",
                subscription_id=subscription_id,
            )
        )


def _one(result: object) -> RawHttpResponse:
    assert isinstance(result, RawHttpResponse), result
    return result


def empty_fact_list() -> RawHttpResponse:
    """A successful fact list naming nothing — the ordinary subscription with no backups.

    `200` with an empty `value` array, which is what makes the answer a **statement** rather
    than a failure: `azure/facts.py` folds it into `backup_not_configured` or
    `no_reservations`, not into `fact_unavailable`. A test that wants the failure scripts a
    non-2xx response instead, and the difference between the two is the whole of
    `test_facts_reservations.py`.
    """
    return RawHttpResponse(status=200, headers={}, body={"value": []})


def facts_port_answering_nothing(*, vaults: int = 0) -> FakeFactsPort:
    """A `FakeFactsPort` every source of which answers successfully and names nothing.

    The default for a harness that is **not** about facts: it models a subscription with no
    backup, no replication, no reservation and no Advisor recommendation, so the run
    collects the projected facts from the inventory query and records one typed absence per
    non-projectable key. That is a real subscription rather than an evasion — and it is why
    those harnesses' runs now carry gaps and report `PARTIAL_COVERAGE`, which Req 5.6 names
    as the intended outcome.

    `vaults` scripts one replication answer per Recovery Services vault the harness's
    inventory holds; zero is the common case, and `azure/facts.py` then issues no replication
    request at all.
    """
    return FakeFactsPort(
        backup_responses=[empty_fact_list()],
        replication_responses=[empty_fact_list() for _ in range(vaults)],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )


class FakeSkuPort:
    """Replays a sequence of `resource_skus.list` responses (Req 21.1).

    Records every call's `location` so a test can assert the port was never asked to
    list without one — the location-filter is a required keyword on the real
    `SkuPort`, so an unfiltered call is a type error before it is a test failure, but
    the recorded call also lets a test assert the module under test passed the
    *resource's own* location rather than some other value.
    """

    def __init__(self, responses: Sequence[RawHttpResponse]) -> None:
        self._state = _ScriptedCalls(responses=list(responses))

    @property
    def calls(self) -> list[dict[str, Any]]:
        return self._state.calls

    async def list_skus(self, *, subscription_id: str, location: str) -> RawHttpResponse:
        result = self._state.record_and_pop(
            port_name="FakeSkuPort",
            method_name="list_skus",
            subscription_id=subscription_id,
            location=location,
        )
        assert isinstance(result, RawHttpResponse)
        return result


class FakeDefinitionsPort:
    """Replays a sequence of metric-definitions probes (Req 22.1, 22.4).

    One response per call to :meth:`list_metric_definitions`. A caching definitions
    module (`azure/definitions.py`) should call this exactly once per
    `(resource_type, region)` pair it has not already served from its own cache, so a
    test asserts the *count* of calls this fake recorded rather than the fake doing
    any caching of its own — caching is the module under test's behaviour, not the
    fake's.
    """

    def __init__(self, responses: Sequence[RawHttpResponse]) -> None:
        self._state = _ScriptedCalls(responses=list(responses))

    @property
    def calls(self) -> list[dict[str, Any]]:
        return self._state.calls

    async def list_metric_definitions(
        self, *, resource_id: str, metric_namespace: str
    ) -> RawHttpResponse:
        result = self._state.record_and_pop(
            port_name="FakeDefinitionsPort",
            method_name="list_metric_definitions",
            resource_id=resource_id,
            metric_namespace=metric_namespace,
        )
        assert isinstance(result, RawHttpResponse)
        return result


class FakeMetricsPort:
    """Replays batch, per-resource-fallback and Log-Analytics responses independently.

    Three separate scripted sequences, one per method, because a single test
    frequently exercises two of the three in one scenario — a DNS failure on the
    batch path (Req 24.2) that then falls through to
    :meth:`query_resource_fallback` — and independent sequences let each be scripted
    without interleaving bookkeeping.

    A response in the `batch_responses` sequence may be a `DnsResolutionError`
    **instance** rather than a `RawHttpResponse`: when popped, it is raised instead of
    returned, which is how this fake represents Req 24.2's "the regional endpoint
    failed to resolve" — an outcome with no HTTP envelope at all, exactly as the real
    `MetricsPort.query_batch` contract describes.
    """

    def __init__(
        self,
        *,
        batch_responses: Sequence[RawHttpResponse | DnsResolutionError] = (),
        fallback_responses: Sequence[RawHttpResponse] = (),
        logs_responses: Sequence[RawHttpResponse | Exception] = (),
        probe_responses: Sequence[object] = (),
    ) -> None:
        self._batch = _ScriptedCalls(responses=list(batch_responses))
        self._fallback = _ScriptedCalls(responses=list(fallback_responses))
        self._logs = _ScriptedCalls(responses=list(logs_responses))
        self._probes = _ScriptedCalls(responses=list(probe_responses))

    @property
    def batch_calls(self) -> list[dict[str, Any]]:
        return self._batch.calls

    @property
    def fallback_calls(self) -> list[dict[str, Any]]:
        return self._fallback.calls

    @property
    def logs_calls(self) -> list[dict[str, Any]]:
        return self._logs.calls

    @property
    def probe_calls(self) -> list[dict[str, Any]]:
        return self._probes.calls

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
        result = self._batch.record_and_pop(
            port_name="FakeMetricsPort",
            method_name="query_batch",
            location=location,
            subscription_id=subscription_id,
            resource_ids=tuple(resource_ids),
            metric_namespace=metric_namespace,
            metric_names=tuple(metric_names),
            aggregations=tuple(aggregations),
            start_time=start_time,
            end_time=end_time,
            interval=interval,
        )
        if isinstance(result, DnsResolutionError):
            raise result
        assert isinstance(result, RawHttpResponse)
        return result

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
        result = self._fallback.record_and_pop(
            port_name="FakeMetricsPort",
            method_name="query_resource_fallback",
            resource_id=resource_id,
            metric_namespace=metric_namespace,
            metric_names=tuple(metric_names),
            aggregations=tuple(aggregations),
            start_time=start_time,
            end_time=end_time,
            interval=interval,
        )
        assert isinstance(result, RawHttpResponse)
        return result

    async def query_logical_disk_free_space(
        self, *, workspace_id: str, resource_id: str, start_time: str, end_time: str
    ) -> RawHttpResponse:
        result = self._logs.record_and_pop(
            port_name="FakeMetricsPort",
            method_name="query_logical_disk_free_space",
            workspace_id=workspace_id,
            resource_id=resource_id,
            start_time=start_time,
            end_time=end_time,
        )
        if isinstance(result, Exception):
            # Req 31.7 — an enhanced-tier query that fails outright, so the pipeline
            # downgrades that resource to `baseline` and continues. Scripted the same way
            # `query_batch` scripts a `DnsResolutionError`: an outcome with no HTTP
            # envelope is raised rather than returned.
            raise result
        assert isinstance(result, RawHttpResponse)
        return result

    async def probe_region(
        self, *, location: str, subscription_id: str
    ) -> ProbeResult:
        """The next scripted probe response. Scripted from the **probes** queue so a test
        can count exactly how many probe requests were issued per region."""
        result = self._probes.record_and_pop(
            port_name="FakeMetricsPort",
            method_name="probe_region",
            location=location,
            subscription_id=subscription_id,
        )
        if isinstance(result, DnsResolutionError):
            raise result
        assert isinstance(result, ProbeResult)
        return result


def raw_response_from_recorded(recorded: Any) -> RawHttpResponse:
    """Adapt a `tests.fixtures.RecordedResponse` into the `RawHttpResponse` a port
    hands back.

    Kept as a free function rather than a `RecordedResponse` method: the fixture
    loader (`tests/fixtures/__init__.py`) is a generic recorded-HTTP-answer
    convention with no dependency on `azure/ports.py`, and it should stay that way
    so a future non-Azure fixture area does not inherit an Azure-specific import.
    """
    return RawHttpResponse(status=recorded.status, headers=dict(recorded.headers), body=recorded.body)
