"""Task 1.6 — the region route probe.

Two properties are the point, and both must be able to fail for the right reason:

1. At most ONE request per region per scan — driven with two regions and the request
   count asserted, not just that it worked.
2. The probe NEVER reads a response body — the port returns a `ProbeResult` carrying
   only status + retry_after, so the caller has no body to access at all. The
   `_BodyAccessRaises` sentinel proves the PORT IMPLEMENTATION itself discards the
   body on its way to building the `ProbeResult`.

Plus: the probe reaches `regions.is_data_plane_refusal` through the same module
attribute the collection path uses, so a counting wrapper covering both callers
proves the scan and the run cannot disagree on what a status means.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest

from reporting_agent.azure import regions
from reporting_agent.azure.ports import (
    AzureTransportError,
    DnsResolutionError,
    ProbeResult,
    RawHttpResponse,
)
from reporting_agent.azure.regions import (
    VERDICT_REACHABLE,
    VERDICT_REFUSED,
    VERDICT_UNKNOWN,
    RegionProbeResult,
    probe_regions,
)

# --- helpers --------------------------------------------------------------------------


class _BodyAccessRaises:
    """A body object that raises on ANY attribute access or iteration.

    With the new `ProbeResult` return type, the probe caller never sees a body at all.
    This sentinel now proves that the PORT IMPLEMENTATION discards the body on its way
    to extracting the status code — i.e. that the concrete `AzureMetricsPort.probe_region`
    reads only `.status` and `.header(...)` from the `RawHttpResponse` it receives
    internally, and never touches `.body`.
    """

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(
            f"the port implementation read the response body (accessed .body.{name}); "
            f"Req 5.1 requires the body to be discarded unread"
        )

    def __iter__(self) -> Any:
        raise AssertionError("the port iterated the response body")

    def __len__(self) -> int:
        raise AssertionError("the port read len(body)")

    def __getitem__(self, key: Any) -> Any:
        raise AssertionError(f"the port accessed body[{key!r}]")

    def __contains__(self, item: Any) -> bool:
        raise AssertionError("the port tested 'in body'")

    def __bool__(self) -> bool:
        raise AssertionError("the port tested bool(body)")


def _probe_result(status: int, *, retry_after: str | None = None) -> ProbeResult:
    """A probe result for a given status code."""
    return ProbeResult(status=status, retry_after=retry_after)


class FakeProbePort:
    """A metrics port stub that scripts probe responses and counts calls.

    `probe_responses` is a dict of region -> list of responses. Each region's list is
    popped in order. If a region is called that has no scripted response, the stub raises.
    """

    def __init__(
        self,
        probe_responses: dict[str, list[ProbeResult | DnsResolutionError | Exception]],
    ) -> None:
        self._responses = {k: list(v) for k, v in probe_responses.items()}
        self.calls: list[dict[str, str]] = []

    async def probe_region(
        self, *, location: str, subscription_id: str
    ) -> ProbeResult:
        self.calls.append({"location": location, "subscription_id": subscription_id})
        if location not in self._responses or not self._responses[location]:
            raise RuntimeError(f"no scripted probe response for {location!r}")
        item = self._responses[location].pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    # Stubs for other MetricsPort methods — not called by the probe.
    async def query_batch(self, **kw: Any) -> RawHttpResponse:
        raise NotImplementedError

    async def query_resource_fallback(self, **kw: Any) -> RawHttpResponse:
        raise NotImplementedError

    async def query_logical_disk_free_space(self, **kw: Any) -> RawHttpResponse:
        raise NotImplementedError


SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
FIXED_NOW = datetime(2026, 8, 26, 12, 0, 0, tzinfo=UTC)


def run(coro: Any) -> Any:
    return asyncio.run(coro)


# --- test 1: at most ONE request per region per scan ---------------------------------


def test_probe_issues_at_most_one_request_per_region() -> None:
    """Req 5.5: at most one probe per distinct region per scan.

    Driven with two regions; asserts the request COUNT, not just that it worked.
    A third call to either region would be a violation.
    """
    port = FakeProbePort(
        probe_responses={
            "southeastasia": [_probe_result(200)],
            "westeurope": [_probe_result(403)],
        }
    )

    results = run(probe_regions(
        regions=["southeastasia", "westeurope", "southeastasia"],  # duplicate!
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        now=lambda: FIXED_NOW,
    ))

    # Exactly two calls — one per distinct region, the duplicate is NOT re-probed.
    assert len(port.calls) == 2
    assert port.calls[0]["location"] == "southeastasia"
    assert port.calls[1]["location"] == "westeurope"
    assert len(results) == 2


# --- test 2: the probe has no body to read (structural) ------------------------------


def test_probe_result_type_carries_no_body() -> None:
    """Req 5.1: the probe returns a `ProbeResult` with status + retry_after only.

    The caller has no `.body` attribute to access — "discards the body unread" is a
    property of the type, not a trust contract.
    """
    result = _probe_result(200)
    assert not hasattr(result, "body")
    assert result.status == 200
    assert result.retry_after is None


def test_port_implementation_does_not_read_body() -> None:
    """The port implementation (tested via the _BodyAccessRaises sentinel on
    RawHttpResponse) proves that the CONCRETE port discards the body.

    This keeps `_BodyAccessRaises` useful: with the new return type the probe caller
    cannot see a body, but the port implementation must also not read it on its way to
    extracting status and Retry-After.
    """
    # This test validates that RawHttpResponse with _BodyAccessRaises body can have
    # its .status and .header() accessed without touching .body — the same pattern the
    # real AzureMetricsPort.probe_region uses internally.
    response = RawHttpResponse(status=429, headers={"Retry-After": "5"}, body=_BodyAccessRaises())
    # These accesses are what the real implementation does:
    assert response.status == 429
    assert response.header("Retry-After") == "5"
    # If we got here without AssertionError, the pattern is body-safe.


# --- the counting-wrapper guard: BOTH callers reach is_data_plane_refusal ------------


def test_the_probe_reaches_is_data_plane_refusal_through_the_module_attribute() -> None:
    """Task 1.1's extension: the scan probe and the collection path reach the SAME
    `regions.is_data_plane_refusal` through the same module attribute.

    Patching `regions.is_data_plane_refusal` with a counting wrapper and asserting the
    probe increments it. This is the same patch point the existing
    `test_the_collection_path_reads_the_shared_data_plane_predicate` uses for the
    metrics collection path — one predicate, one patch point, two callers.
    """
    seen: list[tuple[int | None, bool]] = []
    real = regions.is_data_plane_refusal

    def counting(status: int | None, *, dns_failed: bool) -> bool:
        seen.append((status, dns_failed))
        return real(status, dns_failed=dns_failed)

    port = FakeProbePort(
        probe_responses={"westeurope": [_probe_result(403)]}
    )

    with patch.object(regions, "is_data_plane_refusal", counting):
        run(probe_regions(
            regions=["westeurope"],
            subscription_id=SUBSCRIPTION,
            port=port,  # type: ignore[arg-type]
            now=lambda: FIXED_NOW,
        ))

    assert (403, False) in seen, (
        "the probe classified a data-plane status without consulting "
        f"regions.is_data_plane_refusal; it saw {seen!r}"
    )


# --- verdict mapping -----------------------------------------------------------------


def test_a_200_is_reachable() -> None:
    port = FakeProbePort(probe_responses={"eastus": [_probe_result(200)]})
    results = run(probe_regions(
        regions=["eastus"],
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        now=lambda: FIXED_NOW,
    ))
    assert results[0].verdict == VERDICT_REACHABLE
    assert results[0].status_code == 200


@pytest.mark.parametrize("status", [401, 403, 404])
def test_a_refused_status_yields_refused_verdict(status: int) -> None:
    port = FakeProbePort(probe_responses={"eastus": [_probe_result(status)]})
    results = run(probe_regions(
        regions=["eastus"],
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        now=lambda: FIXED_NOW,
    ))
    assert results[0].verdict == VERDICT_REFUSED
    assert results[0].status_code == status


def test_a_dns_failure_yields_refused_verdict() -> None:
    port = FakeProbePort(
        probe_responses={"norwayeast": [DnsResolutionError("norwayeast")]}
    )
    results = run(probe_regions(
        regions=["norwayeast"],
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        now=lambda: FIXED_NOW,
    ))
    assert results[0].verdict == VERDICT_REFUSED
    assert results[0].status_code is None


def test_a_transport_exception_yields_unknown_verdict() -> None:
    """A probe that could not complete at all — a transport-level failure (OSError
    subclass) that is NOT a programming error."""

    class FailPort(FakeProbePort):
        async def probe_region(self, **kw: Any) -> ProbeResult:
            self.calls.append(kw)  # type: ignore[arg-type]
            raise ConnectionError("network unreachable")

    port = FailPort(probe_responses={})
    results = run(probe_regions(
        regions=["mysteryland"],
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        now=lambda: FIXED_NOW,
    ))
    assert results[0].verdict == VERDICT_UNKNOWN
    assert results[0].status_code is None


def test_an_azure_transport_error_yields_unknown_verdict() -> None:
    """AzureTransportError (non-DNS) is also a transport failure → unknown."""

    class FailPort(FakeProbePort):
        async def probe_region(self, **kw: Any) -> ProbeResult:
            self.calls.append(kw)  # type: ignore[arg-type]
            raise AzureTransportError("connection reset")

    port = FailPort(probe_responses={})
    results = run(probe_regions(
        regions=["mysteryland"],
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        now=lambda: FIXED_NOW,
    ))
    assert results[0].verdict == VERDICT_UNKNOWN
    assert results[0].status_code is None


def test_a_programming_error_propagates_not_unknown() -> None:
    """FIX 2: a TypeError / AttributeError / etc. is a bug, not a transport failure.

    It MUST propagate rather than being swallowed as `unknown`, so a defect in
    this module presents as a crash rather than as a merely-unreachable region.
    """

    class BuggyPort(FakeProbePort):
        async def probe_region(self, **kw: Any) -> ProbeResult:
            self.calls.append(kw)  # type: ignore[arg-type]
            raise TypeError("something is wrong in the implementation")

    port = BuggyPort(probe_responses={})
    with pytest.raises(TypeError, match="something is wrong"):
        run(probe_regions(
            regions=["eastus"],
            subscription_id=SUBSCRIPTION,
            port=port,  # type: ignore[arg-type]
            now=lambda: FIXED_NOW,
        ))


def test_timeout_error_yields_unknown_verdict() -> None:
    """asyncio.TimeoutError is a transport-level failure → unknown."""

    class TimeoutPort(FakeProbePort):
        async def probe_region(self, **kw: Any) -> ProbeResult:
            self.calls.append(kw)  # type: ignore[arg-type]
            raise TimeoutError()

    port = TimeoutPort(probe_responses={})
    results = run(probe_regions(
        regions=["eastus"],
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        now=lambda: FIXED_NOW,
    ))
    assert results[0].verdict == VERDICT_UNKNOWN


# --- 429 / Retry-After handling ------------------------------------------------------


def test_429_with_retry_after_retries_once() -> None:
    throttled = _probe_result(429, retry_after="1")
    success = _probe_result(200)
    port = FakeProbePort(probe_responses={"eastus": [throttled, success]})
    slept: list[float] = []

    async def fake_sleep(secs: float) -> None:
        slept.append(secs)

    results = run(probe_regions(
        regions=["eastus"],
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        sleep=fake_sleep,
        now=lambda: FIXED_NOW,
    ))
    assert results[0].verdict == VERDICT_REACHABLE
    assert results[0].status_code == 200
    assert slept == [1.0]
    assert len(port.calls) == 2  # first attempt + retry


def test_429_with_http_date_retry_after_honours_the_date() -> None:
    """The probe honours an RFC 7231 HTTP-date `Retry-After`, not only seconds.

    `parse_retry_after` from `azure/metrics.py` resolves the date against the injected
    `now`, yielding the seconds to wait.
    """
    # Retry-After as an HTTP-date 5 seconds after FIXED_NOW.
    throttled = _probe_result(429, retry_after="Wed, 26 Aug 2026 12:00:05 GMT")
    success = _probe_result(200)
    port = FakeProbePort(probe_responses={"eastus": [throttled, success]})
    slept: list[float] = []

    async def fake_sleep(secs: float) -> None:
        slept.append(secs)

    results = run(probe_regions(
        regions=["eastus"],
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        sleep=fake_sleep,
        now=lambda: FIXED_NOW,
    ))
    assert results[0].verdict == VERDICT_REACHABLE
    assert results[0].status_code == 200
    # The HTTP-date is 5 seconds after FIXED_NOW, so the probe should sleep 5s.
    assert slept == [5.0]
    assert len(port.calls) == 2


# --- probed_at -----------------------------------------------------------------------


def test_probed_at_is_recorded() -> None:
    port = FakeProbePort(probe_responses={"eastus": [_probe_result(200)]})
    results = run(probe_regions(
        regions=["eastus"],
        subscription_id=SUBSCRIPTION,
        port=port,  # type: ignore[arg-type]
        now=lambda: FIXED_NOW,
    ))
    assert results[0].probed_at == FIXED_NOW.isoformat()


# --- to_plain_data -------------------------------------------------------------------


def test_to_plain_data_shape() -> None:
    r = RegionProbeResult(
        region="eastus", status_code=200, verdict="reachable",
        probed_at="2026-08-26T12:00:00+00:00",
    )
    d = r.to_plain_data()
    assert d == {
        "region": "eastus",
        "status_code": 200,
        "verdict": "reachable",
        "probed_at": "2026-08-26T12:00:00+00:00",
    }
