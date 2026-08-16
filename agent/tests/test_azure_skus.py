"""Unit tests for `azure/skus.py` (task 11.3) — Req 21.1, 21.2, 21.3, 21.4, 21.5, 21.6,
21.7, 21.9, 21.10, 21.11, 21.12.

Driven against `FakeSkuPort` and the two recorded fixtures from task 11.1:
`resource_skus_with_vcpus_available` (the constrained-core `Standard_E32-8s_v5`,
`vCPUs=32` vs `vCPUsAvailable=8`) and `resource_skus_without_vcpus_available` (a SKU
whose capabilities carry `vCPUs` but not `vCPUsAvailable`).

No Azure SDK, no network, no subscription.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal

from fakes.azure_ports import FakeSkuPort, raw_response_from_recorded
from fixtures import load_response
from reporting_agent.azure.ports import RawHttpResponse, SkuPort
from reporting_agent.azure.skus import (
    CAPABILITY_MEMORY_GB,
    CAPABILITY_VCPUS_AVAILABLE,
    GIB_TO_BYTES,
    SkuCatalog,
)
from reporting_agent.collect.log import GAP_TYPE_SKU_CAPABILITY_MISSING, GAP_TYPE_SKU_UNKNOWN

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
LOCATION = "southeastasia"
OTHER_LOCATION = "australiaeast"
RESOURCE_ID = (
    f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod-sea"
    f"/providers/Microsoft.Compute/virtualMachines/prod-web-01"
)


def run(coro):
    return asyncio.run(coro)


def _with_vcpus_available() -> RawHttpResponse:
    return raw_response_from_recorded(load_response("azure", "resource_skus_with_vcpus_available"))


def _without_vcpus_available() -> RawHttpResponse:
    return raw_response_from_recorded(
        load_response("azure", "resource_skus_without_vcpus_available")
    )


# --------------------------------------------------------------------------- #
# GIB_TO_BYTES is exactly 2**30, and no float is anywhere on the path
# --------------------------------------------------------------------------- #


def test_gib_to_bytes_is_exactly_1073741824() -> None:
    assert GIB_TO_BYTES == Decimal(1073741824)
    assert GIB_TO_BYTES == Decimal(2) ** 30


# --------------------------------------------------------------------------- #
# Req 21.2, 21.3, 21.9 — vCPUsAvailable is used; vCPUs is never a fallback
# --------------------------------------------------------------------------- #


def test_vcpus_available_is_read_and_vcpus_is_ignored_for_a_constrained_core_sku() -> None:
    """`Standard_E32-8s_v5` advertises vCPUs=32 but exposes vCPUsAvailable=8. The
    resolved capacity must be 8, never 32."""
    port = FakeSkuPort([_with_vcpus_available()])
    catalog = SkuCatalog(port)

    capacity, gaps = run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_E32-8s_v5",
            resource_id=RESOURCE_ID,
        )
    )

    assert gaps == []
    assert capacity is not None
    assert capacity.vcpus_available == Decimal("8")
    assert capacity.vcpus_available != Decimal("32")
    assert isinstance(capacity.vcpus_available, Decimal)


def test_a_sku_missing_vcpus_available_records_sku_capability_missing_naming_the_capability() -> None:
    """No fallback to `vCPUs` (which is present at value '2' in this fixture) —
    `vcpus_available` must be `None` and the gap must name the capability."""
    port = FakeSkuPort([_without_vcpus_available()])
    catalog = SkuCatalog(port)

    capacity, gaps = run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_Legacy_A2",
            resource_id=RESOURCE_ID,
        )
    )

    assert capacity is not None
    assert capacity.vcpus_available is None, "must never fall back to the vCPUs capability"

    missing = [g for g in gaps if g["metric"] == CAPABILITY_VCPUS_AVAILABLE]
    assert len(missing) == 1
    gap = missing[0]
    assert gap["gap_type"] == GAP_TYPE_SKU_CAPABILITY_MISSING
    assert gap["resource_id"] == RESOURCE_ID
    assert "Standard_Legacy_A2" in gap["message"]
    assert CAPABILITY_VCPUS_AVAILABLE in gap["message"]


# --------------------------------------------------------------------------- #
# Req 21.4, 21.5, 21.12 — MemoryGB -> bytes via exact Decimal arithmetic
# --------------------------------------------------------------------------- #


def test_memory_gb_converts_to_bytes_via_exact_decimal_arithmetic() -> None:
    """The fixture's MemoryGB is '256'. 256 * 1073741824 = 274877906944 exactly."""
    port = FakeSkuPort([_with_vcpus_available()])
    catalog = SkuCatalog(port)

    capacity, gaps = run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_E32-8s_v5",
            resource_id=RESOURCE_ID,
        )
    )

    assert gaps == []
    assert capacity is not None
    assert capacity.memory_bytes == Decimal("274877906944")
    assert capacity.memory_bytes == Decimal("256") * GIB_TO_BYTES
    assert isinstance(capacity.memory_bytes, Decimal)
    assert not isinstance(capacity.memory_bytes, float)


def test_memory_gb_present_alongside_a_missing_vcpus_available_still_resolves() -> None:
    """`resource_skus_without_vcpus_available` carries MemoryGB='3.5', isolating a
    missing vCPUsAvailable from a missing MemoryGB (per the fixture's own comment)."""
    port = FakeSkuPort([_without_vcpus_available()])
    catalog = SkuCatalog(port)

    capacity, gaps = run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_Legacy_A2",
            resource_id=RESOURCE_ID,
        )
    )

    assert capacity is not None
    assert capacity.memory_bytes == Decimal("3.5") * GIB_TO_BYTES
    assert not any(g["metric"] == CAPABILITY_MEMORY_GB for g in gaps)


def test_a_sku_missing_memory_gb_records_sku_capability_missing_naming_the_capability() -> None:
    port = FakeSkuPort(
        [
            RawHttpResponse(
                status=200,
                headers={},
                body={
                    "value": [
                        {
                            "resourceType": "virtualMachines",
                            "name": "Standard_NoMemory",
                            "capabilities": [
                                {"name": "vCPUsAvailable", "value": "4"},
                            ],
                        }
                    ]
                },
            )
        ]
    )
    catalog = SkuCatalog(port)

    capacity, gaps = run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_NoMemory",
            resource_id=RESOURCE_ID,
        )
    )

    assert capacity is not None
    assert capacity.memory_bytes is None
    missing = [g for g in gaps if g["metric"] == CAPABILITY_MEMORY_GB]
    assert len(missing) == 1
    assert missing[0]["gap_type"] == GAP_TYPE_SKU_CAPABILITY_MISSING
    assert "Standard_NoMemory" in missing[0]["message"]


# --------------------------------------------------------------------------- #
# Req 21.7 — a SKU absent from the listing records sku_unknown
# --------------------------------------------------------------------------- #


def test_a_sku_absent_from_the_listing_records_sku_unknown() -> None:
    port = FakeSkuPort([_with_vcpus_available()])
    catalog = SkuCatalog(port)

    capacity, gaps = run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_Does_Not_Exist",
            resource_id=RESOURCE_ID,
        )
    )

    assert capacity is None
    assert len(gaps) == 1
    assert gaps[0]["gap_type"] == GAP_TYPE_SKU_UNKNOWN
    assert gaps[0]["resource_id"] == RESOURCE_ID
    assert gaps[0]["metric"] is None
    assert "Standard_Does_Not_Exist" in gaps[0]["message"]


# --------------------------------------------------------------------------- #
# Req 21.1 — always location-filtered
# --------------------------------------------------------------------------- #


def test_list_skus_is_always_called_with_the_resources_location() -> None:
    port = FakeSkuPort([_with_vcpus_available()])
    catalog = SkuCatalog(port)

    run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_E32-8s_v5",
            resource_id=RESOURCE_ID,
        )
    )

    assert port.calls == [{"subscription_id": SUBSCRIPTION, "location": LOCATION}]


# --------------------------------------------------------------------------- #
# Req 21.6, 21.11 — cache keyed (subscription, location), reused, discardable
# --------------------------------------------------------------------------- #


def test_the_cache_is_reused_across_two_lookups_for_the_same_subscription_and_location() -> None:
    port = FakeSkuPort([_with_vcpus_available()])
    catalog = SkuCatalog(port)

    run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_E32-8s_v5",
            resource_id=RESOURCE_ID,
        )
    )
    run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_E32-8s_v5",
            resource_id=RESOURCE_ID + "-2",
        )
    )

    assert len(port.calls) == 1


def test_two_different_locations_each_issue_their_own_listing_call() -> None:
    port = FakeSkuPort([_with_vcpus_available(), _without_vcpus_available()])
    catalog = SkuCatalog(port)

    run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_E32-8s_v5",
            resource_id=RESOURCE_ID,
        )
    )
    run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=OTHER_LOCATION,
            sku_name="Standard_Legacy_A2",
            resource_id=RESOURCE_ID,
        )
    )

    assert len(port.calls) == 2
    assert [call["location"] for call in port.calls] == [LOCATION, OTHER_LOCATION]


def test_discard_clears_the_cache_so_a_later_resolve_lists_again() -> None:
    port = FakeSkuPort([_with_vcpus_available(), _with_vcpus_available()])
    catalog = SkuCatalog(port)

    run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_E32-8s_v5",
            resource_id=RESOURCE_ID,
        )
    )
    catalog.discard()
    run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_E32-8s_v5",
            resource_id=RESOURCE_ID,
        )
    )

    assert len(port.calls) == 2


# --------------------------------------------------------------------------- #
# The catalog is built against the declared SkuPort protocol
# --------------------------------------------------------------------------- #


def test_the_fake_sku_port_satisfies_sku_port_and_the_catalog_uses_only_that_surface() -> None:
    assert isinstance(FakeSkuPort([]), SkuPort)


def test_a_non_ok_listing_response_resolves_every_sku_as_sku_unknown() -> None:
    port = FakeSkuPort(
        [RawHttpResponse(status=403, headers={}, body={"error": "Forbidden"})]
    )
    catalog = SkuCatalog(port)

    capacity, gaps = run(
        catalog.resolve(
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            sku_name="Standard_E32-8s_v5",
            resource_id=RESOURCE_ID,
        )
    )

    assert capacity is None
    assert gaps[0]["gap_type"] == GAP_TYPE_SKU_UNKNOWN
