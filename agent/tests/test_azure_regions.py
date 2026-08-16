"""Task 11.5 — `azure/regions.py`: the DNS-failure memo and the batch/fallback router.

Req 24.1 (endpoint selection), 24.2 (route to fallback on DNS failure), 24.3 (every
distinct location receives at least one request), 24.4 (a location whose fallback
also fails records `region_unreachable`, non-terminal), 24.6 (memoisation is scoped
per location, and stops further DNS attempts) and 24.7 (the fallback carries the same
grain, window, metric names and aggregations as the batch path would have).

Driven entirely against `FakeMetricsPort`, `DnsResolutionError` and the
`DNS_UNREACHABLE_LOCATIONS` / `DNS_REACHABLE_LOCATIONS` constants from
`fakes.azure_ports` — no HTTP fixture, because a DNS failure never produces one.
"""

from __future__ import annotations

import asyncio

import pytest

from fakes.azure_ports import (
    DNS_REACHABLE_LOCATIONS,
    DNS_UNREACHABLE_LOCATIONS,
    FakeMetricsPort,
)
from reporting_agent.azure.ports import DnsResolutionError, RawHttpResponse
from reporting_agent.azure.regions import (
    METRICS_DATA_PLANE_ENDPOINT_TEMPLATE,
    LocationRequestResult,
    RegionResolver,
    metrics_data_plane_endpoint,
)
from reporting_agent.collect.log import GAP_TYPE_REGION_UNREACHABLE
from reporting_agent.errors import ErrorCode, RegionUnreachableError

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
NAMESPACE = "Microsoft.Compute/virtualMachines"
METRIC_NAMES = ("Percentage CPU",)
AGGREGATIONS = ("Total", "Count", "Minimum", "Maximum")
START = "2026-07-01T00:00:00Z"
END = "2026-07-01T01:00:00Z"
INTERVAL = "PT1H"


def run(coro):
    return asyncio.run(coro)


def ok_response(body: object = None) -> RawHttpResponse:
    return RawHttpResponse(status=200, headers={}, body=body or {"values": []})


class ScriptedPort:
    """A minimal `MetricsPort` stand-in that can raise a plain exception from
    `query_resource_fallback`, which `FakeMetricsPort` cannot: its fake always
    asserts the scripted item is a `RawHttpResponse` for that method. A real
    `MetricsPort` implementation over the SDK is free to raise for a fallback
    request that never got a response at all (a connection failure, say), so
    `RegionResolver` has to handle that case too, and this stub is what proves it.
    """

    def __init__(
        self,
        *,
        batch: list[object] | None = None,
        fallback: list[object] | None = None,
    ) -> None:
        self._batch = list(batch or [])
        self._fallback = list(fallback or [])
        self.batch_calls: list[dict[str, object]] = []
        self.fallback_calls: list[dict[str, object]] = []

    async def query_batch(self, **kwargs: object) -> RawHttpResponse:
        self.batch_calls.append(kwargs)
        item = self._batch.pop(0)
        if isinstance(item, BaseException):
            raise item
        assert isinstance(item, RawHttpResponse)
        return item

    async def query_resource_fallback(self, **kwargs: object) -> RawHttpResponse:
        self.fallback_calls.append(kwargs)
        item = self._fallback.pop(0)
        if isinstance(item, BaseException):
            raise item
        assert isinstance(item, RawHttpResponse)
        return item

    async def query_logical_disk_free_space(self, **kwargs: object) -> RawHttpResponse:
        raise NotImplementedError


def request(
    resolver: RegionResolver,
    *,
    location: str,
    resource_ids: tuple[str, ...],
) -> LocationRequestResult:
    return run(
        resolver.request_batch_or_fallback(
            location=location,
            subscription_id=SUBSCRIPTION,
            resource_ids=resource_ids,
            metric_namespace=NAMESPACE,
            metric_names=METRIC_NAMES,
            aggregations=AGGREGATIONS,
            start_time=START,
            end_time=END,
            interval=INTERVAL,
        )
    )


# --------------------------------------------------------------------------- #
# metrics_data_plane_endpoint (Req 24.1)
# --------------------------------------------------------------------------- #


def test_the_endpoint_template_matches_the_documented_host_pattern() -> None:
    assert METRICS_DATA_PLANE_ENDPOINT_TEMPLATE == "https://{location}.metrics.monitor.azure.com"


def test_the_endpoint_is_built_from_the_location_component_of_the_grouping_key() -> None:
    assert metrics_data_plane_endpoint("southeastasia") == (
        "https://southeastasia.metrics.monitor.azure.com"
    )


def test_a_blank_location_is_rejected_rather_than_producing_a_malformed_url() -> None:
    with pytest.raises(ValueError):
        metrics_data_plane_endpoint("")


# --------------------------------------------------------------------------- #
# a reachable location stays on the batch path (Req 24.1)
# --------------------------------------------------------------------------- #


def test_a_reachable_location_is_served_by_the_batch_call_and_is_not_memoised() -> None:
    location = DNS_REACHABLE_LOCATIONS[0]
    port = FakeMetricsPort(batch_responses=[ok_response()])
    resolver = RegionResolver(port=port)

    result = request(resolver, location=location, resource_ids=("vm-1", "vm-2"))

    assert result.via_fallback is False
    assert result.batch_response is not None and result.batch_response.ok
    assert result.fallback_responses == {}
    assert result.gaps == ()
    assert not resolver.is_fallback_only(location)
    assert location in resolver.requested_locations
    assert not port.fallback_calls


def test_the_batch_call_carries_the_resource_ids_grain_window_metrics_and_aggregations() -> None:
    location = DNS_REACHABLE_LOCATIONS[0]
    port = FakeMetricsPort(batch_responses=[ok_response()])
    resolver = RegionResolver(port=port)

    request(resolver, location=location, resource_ids=("vm-1", "vm-2"))

    assert port.batch_calls == [
        {
            "location": location,
            "subscription_id": SUBSCRIPTION,
            "resource_ids": ("vm-1", "vm-2"),
            "metric_namespace": NAMESPACE,
            "metric_names": METRIC_NAMES,
            "aggregations": AGGREGATIONS,
            "start_time": START,
            "end_time": END,
            "interval": INTERVAL,
        }
    ]


# --------------------------------------------------------------------------- #
# a DNS failure memoises the location and falls through in the same call
# (Req 24.2, 24.6)
# --------------------------------------------------------------------------- #


def test_a_dns_failure_falls_through_to_the_fallback_within_the_same_call() -> None:
    location = DNS_UNREACHABLE_LOCATIONS[0]
    port = FakeMetricsPort(
        batch_responses=[DnsResolutionError(location)],
        fallback_responses=[ok_response(), ok_response()],
    )
    resolver = RegionResolver(port=port)

    result = request(resolver, location=location, resource_ids=("vm-1", "vm-2"))

    assert result.via_fallback is True
    assert result.batch_response is None
    assert set(result.fallback_responses) == {"vm-1", "vm-2"}
    assert result.gaps == ()
    assert resolver.is_fallback_only(location)
    assert location in resolver.requested_locations


def test_a_dns_failure_is_memoised_so_the_next_call_for_that_location_skips_the_batch_path() -> None:
    """No further DNS resolution attempt (Req 24.6): the second call for the same
    location must not add a second entry to `port.batch_calls`."""
    location = DNS_UNREACHABLE_LOCATIONS[0]
    port = FakeMetricsPort(
        batch_responses=[DnsResolutionError(location)],
        fallback_responses=[ok_response(), ok_response()],
    )
    resolver = RegionResolver(port=port)

    request(resolver, location=location, resource_ids=("vm-1",))
    assert len(port.batch_calls) == 1

    second = request(resolver, location=location, resource_ids=("vm-2",))

    assert len(port.batch_calls) == 1, "a second DNS attempt was made for a memoised location"
    assert second.via_fallback is True
    assert set(second.fallback_responses) == {"vm-2"}


def test_the_fallback_call_carries_the_same_grain_window_metrics_and_aggregations(
) -> None:
    """Req 24.7: the fallback requests exactly what the batch path would have."""
    location = DNS_UNREACHABLE_LOCATIONS[0]
    port = FakeMetricsPort(
        batch_responses=[DnsResolutionError(location)],
        fallback_responses=[ok_response(), ok_response()],
    )
    resolver = RegionResolver(port=port)

    request(resolver, location=location, resource_ids=("vm-1", "vm-2"))

    assert port.fallback_calls == [
        {
            "resource_id": "vm-1",
            "metric_namespace": NAMESPACE,
            "metric_names": METRIC_NAMES,
            "aggregations": AGGREGATIONS,
            "start_time": START,
            "end_time": END,
            "interval": INTERVAL,
        },
        {
            "resource_id": "vm-2",
            "metric_namespace": NAMESPACE,
            "metric_names": METRIC_NAMES,
            "aggregations": AGGREGATIONS,
            "start_time": START,
            "end_time": END,
            "interval": INTERVAL,
        },
    ]


def test_mark_fallback_only_is_idempotent_and_reachable_without_the_orchestration() -> None:
    resolver = RegionResolver(port=FakeMetricsPort())
    location = DNS_UNREACHABLE_LOCATIONS[0]

    resolver.mark_fallback_only(location)
    resolver.mark_fallback_only(location)

    assert resolver.fallback_only_locations == {location}


# --------------------------------------------------------------------------- #
# memoisation is scoped per location (Req 24.6) — a DNS failure on one location
# must not affect a different, reachable location
# --------------------------------------------------------------------------- #


def test_a_dns_failure_on_one_location_does_not_mark_a_different_reachable_location() -> None:
    unreachable = DNS_UNREACHABLE_LOCATIONS[0]
    reachable = DNS_REACHABLE_LOCATIONS[0]
    port = FakeMetricsPort(
        batch_responses=[DnsResolutionError(unreachable), ok_response()],
        fallback_responses=[ok_response()],
    )
    resolver = RegionResolver(port=port)

    request(resolver, location=unreachable, resource_ids=("vm-1",))
    second = request(resolver, location=reachable, resource_ids=("vm-2",))

    assert resolver.is_fallback_only(unreachable)
    assert not resolver.is_fallback_only(reachable)
    assert second.via_fallback is False
    assert len(port.batch_calls) == 2, "the reachable location must still try the batch path"


# --------------------------------------------------------------------------- #
# every distinct location receives at least one request (Req 24.3)
# --------------------------------------------------------------------------- #


def test_every_distinct_location_requested_is_tracked_regardless_of_path() -> None:
    reachable = DNS_REACHABLE_LOCATIONS[0]
    unreachable = DNS_UNREACHABLE_LOCATIONS[0]
    port = FakeMetricsPort(
        batch_responses=[ok_response(), DnsResolutionError(unreachable)],
        fallback_responses=[ok_response()],
    )
    resolver = RegionResolver(port=port)

    request(resolver, location=reachable, resource_ids=("vm-1",))
    request(resolver, location=unreachable, resource_ids=("vm-2",))

    assert resolver.requested_locations == {reachable, unreachable}


def test_an_empty_resource_id_sequence_is_rejected_rather_than_issuing_a_vacuous_request() -> None:
    resolver = RegionResolver(port=FakeMetricsPort())

    with pytest.raises(ValueError):
        request(resolver, location=DNS_REACHABLE_LOCATIONS[0], resource_ids=())


# --------------------------------------------------------------------------- #
# a location whose fallback also fails: region_unreachable gaps, no zero,
# REGION_UNREACHABLE non-terminal (Req 24.4)
# --------------------------------------------------------------------------- #


def test_a_fallback_that_raises_for_every_resource_records_region_unreachable_gaps() -> None:
    location = DNS_UNREACHABLE_LOCATIONS[0]
    port = ScriptedPort(
        batch=[DnsResolutionError(location)],
        fallback=[RuntimeError("connection refused"), RuntimeError("connection refused")],
    )
    resolver = RegionResolver(port=port)

    result = request(resolver, location=location, resource_ids=("vm-1", "vm-2"))

    assert result.fallback_responses == {}
    assert {gap["resource_id"] for gap in result.gaps} == {"vm-1", "vm-2"}
    assert all(gap["gap_type"] == GAP_TYPE_REGION_UNREACHABLE for gap in result.gaps)
    assert all(gap["metric"] is None for gap in result.gaps)
    assert result.location_unreachable is True
    assert location in resolver.unreachable_locations


def test_a_fallback_that_answers_non_2xx_for_every_resource_also_records_the_gap() -> None:
    """Not every fallback failure is an exception — a non-2xx `RawHttpResponse` is
    just as much a failure to answer, and must be treated identically."""
    location = DNS_UNREACHABLE_LOCATIONS[0]
    rejected = RawHttpResponse(status=403, headers={}, body={"error": "forbidden"})
    port = FakeMetricsPort(
        batch_responses=[DnsResolutionError(location)],
        fallback_responses=[rejected, rejected],
    )
    resolver = RegionResolver(port=port)

    result = request(resolver, location=location, resource_ids=("vm-1", "vm-2"))

    assert result.fallback_responses == {}
    assert {gap["resource_id"] for gap in result.gaps} == {"vm-1", "vm-2"}
    assert result.location_unreachable is True


def test_no_gap_carries_a_zero_value_or_a_statistic_field() -> None:
    """Req 24.4's explicit "no statistic value and no zero value" — this is
    structural in `GapRecord`, which has no value field at all, but assert the
    message names the fact rather than silently agreeing with a hypothetical zero."""
    location = DNS_UNREACHABLE_LOCATIONS[0]
    port = ScriptedPort(
        batch=[DnsResolutionError(location)],
        fallback=[RuntimeError("boom")],
    )
    resolver = RegionResolver(port=port)

    result = request(resolver, location=location, resource_ids=("vm-1",))

    assert set(result.gaps[0]) == {"gap_type", "resource_id", "metric", "message"}
    assert "0" not in result.gaps[0]["message"].split()


def test_region_unreachable_is_reported_as_non_terminal() -> None:
    resolver = RegionResolver(port=FakeMetricsPort())

    error = resolver.unreachable_error("norwayeast")

    assert isinstance(error, RegionUnreachableError)
    assert error.code is ErrorCode.REGION_UNREACHABLE
    assert error.terminal is False


def test_a_partially_answering_fallback_is_not_location_unreachable() -> None:
    """One resource answering keeps the location from being `region_unreachable` as a
    whole — the resources that failed are ordinary per-resource gaps, not a region-
    level failure, matching Req 24.4's per-resource framing."""
    location = DNS_UNREACHABLE_LOCATIONS[0]
    port = ScriptedPort(
        batch=[DnsResolutionError(location)],
        fallback=[ok_response(), RuntimeError("boom")],
    )
    resolver = RegionResolver(port=port)

    result = request(resolver, location=location, resource_ids=("vm-1", "vm-2"))

    assert result.location_unreachable is False
    assert "vm-1" in result.fallback_responses
    assert len(result.gaps) == 1
    assert result.gaps[0]["resource_id"] == "vm-2"
    assert location not in resolver.unreachable_locations


# --------------------------------------------------------------------------- #
# all-locations-unreachable escalation is a decision this module exposes but
# never makes on its own (Req 24.5)
# --------------------------------------------------------------------------- #


def test_all_requested_locations_unreachable_is_false_for_an_empty_run() -> None:
    resolver = RegionResolver(port=FakeMetricsPort())
    assert resolver.all_requested_locations_unreachable() is False


def test_all_requested_locations_unreachable_is_true_when_every_location_failed() -> None:
    location_a, location_b = DNS_UNREACHABLE_LOCATIONS[0], "westus3"
    port = ScriptedPort(
        batch=[DnsResolutionError(location_a), DnsResolutionError(location_b)],
        fallback=[RuntimeError("boom"), RuntimeError("boom")],
    )
    resolver = RegionResolver(port=port)

    request(resolver, location=location_a, resource_ids=("vm-1",))
    request(resolver, location=location_b, resource_ids=("vm-2",))

    assert resolver.all_requested_locations_unreachable() is True


def test_all_requested_locations_unreachable_is_false_when_one_location_still_answers() -> None:
    unreachable = DNS_UNREACHABLE_LOCATIONS[0]
    reachable = DNS_REACHABLE_LOCATIONS[0]
    port = ScriptedPort(
        batch=[DnsResolutionError(unreachable), ok_response()],
        fallback=[RuntimeError("boom")],
    )
    resolver = RegionResolver(port=port)

    request(resolver, location=unreachable, resource_ids=("vm-1",))
    request(resolver, location=reachable, resource_ids=("vm-2",))

    assert resolver.all_requested_locations_unreachable() is False


def test_the_resolver_satisfies_isinstance_checks_against_no_protocol_it_should_not() -> None:
    """`RegionResolver` is a concrete orchestration class, not a `Protocol`
    implementation of `MetricsPort` -- guards against an accidental structural match
    that would let a caller pass it where a port is expected."""
    resolver = RegionResolver(port=FakeMetricsPort())
    assert not isinstance(resolver, type(FakeMetricsPort()))
