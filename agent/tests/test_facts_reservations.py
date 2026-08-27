"""Task 4.3's named case: the reservation source's **two** branches (Req 5.2, 5.4).

There is one reason this file exists apart from `test_azure_facts.py`, and it is the reason
Req 5.2 and Req 5.4 are two criteria rather than one:

* a **rejected** `Microsoft.Capacity` request records `fact_unavailable` naming the source;
* a **successful** response that covers a resource no reservation covers records
  `no_reservations`.

Reader at subscription scope does not grant `Microsoft.Capacity/reservationOrders/read` —
reservation orders are a *tenant*-level provider — so the rejection is the **common** case,
not the exceptional one. Collapsing the two would therefore print "no reservations" on nearly
every document, including one for a subscription with plenty. That is the whole failure, and
it is invisible to a test that only exercises the happy path: both branches produce zero
reservation facts, and only the gap type tells them apart.
"""

from __future__ import annotations

import asyncio
from typing import Any, Final

import pytest

from fakes.azure_ports import FakeFactsPort, empty_fact_list
from fakes.object_store import InMemoryObjectStore
from reporting_agent.azure.facts import (
    RESERVATION_ABSENT_GAP_TYPE,
    SOURCE_CAPACITY,
    FactCollector,
)
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.log import GAP_TYPE_FACT_UNAVAILABLE
from reporting_agent.providers.base import GapRecord, ResourceRecord

VM_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
SKU: Final[str] = "Standard_D4s_v3"
RESERVED_KEYS: Final[tuple[str, ...]] = ("reservation_expires_at", "reservation_term")

CATALOG = load_catalog()


def vm(name: str, *, sku_name: str = SKU) -> ResourceRecord:
    return ResourceRecord(
        resource_id=(
            f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod/providers/"
            f"Microsoft.Compute/virtualMachines/{name}"
        ),
        name=name,
        resource_type=VM_TYPE,
        location="southeastasia",
        resource_group="rg-prod",
        tags={},
        sku_name=sku_name,
        power_state_raw="PowerState/running",
        power_state="running",
        fidelity_tier="baseline",
    )


def reservation(
    *, sku_name: str = SKU, scope_type: str = "Shared", scopes: list[str] | None = None
) -> dict[str, Any]:
    return {
        "id": "/providers/Microsoft.Capacity/reservationOrders/ord-1/reservations/res-1",
        "sku": {"name": sku_name},
        "properties": {
            "appliedScopeType": scope_type,
            "appliedScopes": scopes or [],
            "term": "P3Y",
            "expiryDate": "2029-06-30",
            "reservedResourceType": "VirtualMachines",
        },
    }


def collect(
    *,
    resources: list[ResourceRecord],
    reservations: RawHttpResponse,
) -> tuple[list[dict[str, Any]], list[GapRecord]]:
    """The collector over a scripted reservation answer and nothing else.

    Backup and replication are scripted as successful-and-empty and their gaps are dropped
    below, so every assertion here is about the capacity source alone.
    """
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[reservations],
        advisor_responses=[empty_fact_list()]
    )
    collector = FactCollector(
        port,
        ArchiveWriter(store=InMemoryObjectStore()),
        declaration=CATALOG.facts,
        semaphore=asyncio.Semaphore(8),
    )
    result = asyncio.run(
        collector.collect(
            resources=resources, inventory_pages=(), subscription_id=SUBSCRIPTION
        )
    )
    facts = [dict(fact) for fact in result.facts if fact["source"] == SOURCE_CAPACITY]
    gaps = [gap for gap in result.gaps if gap["source"] == SOURCE_CAPACITY]
    return facts, gaps


# --------------------------------------------------------------------------- #
# Branch 1 — the request was rejected (Req 5.4)
# --------------------------------------------------------------------------- #


ARM_FORBIDDEN_BODY: Final[dict[str, Any]] = {
    "error": {
        "code": "AuthorizationFailed",
        "message": (
            "The client does not have authorization to perform action "
            "'Microsoft.Capacity/reservationOrders/read'."
        ),
    }
}
"""What a real ARM rejection carries, and the reason the check has to be on the **status**.

A 403 is not an empty body: it is an error envelope. A reader that folded `response.body`
whatever the status found no `value` array in this, read it as a list naming nothing, and
recorded `no_reservations` — the exact collapse this module exists to prevent, reached by a
route a test scripting `body=None` cannot see.
"""


@pytest.mark.parametrize("status", [401, 403, 404, 429, 500])
@pytest.mark.parametrize(
    "body", [None, ARM_FORBIDDEN_BODY, {"value": []}], ids=["empty", "arm-error", "no-value"]
)
def test_a_rejected_capacity_request_is_fact_unavailable_naming_the_source(
    status: int, body: Any
) -> None:
    """Not `no_reservations`. Reader at subscription scope does not grant the reservation
    read, so this is what an ordinary correctly-configured connection produces — and
    reporting it as an absence would state that a subscription has no reservations on the
    strength of never having been allowed to look."""
    machine = vm("prod-web-01")
    facts, gaps = collect(
        resources=[machine],
        reservations=RawHttpResponse(status=status, headers={}, body=body),
    )

    assert facts == []
    assert {gap["gap_type"] for gap in gaps} == {GAP_TYPE_FACT_UNAVAILABLE}
    assert {gap["metric"] for gap in gaps} == set(RESERVED_KEYS)
    for gap in gaps:
        assert gap["resource_id"] == machine["resource_id"]
        assert gap["source"] == SOURCE_CAPACITY
        assert SOURCE_CAPACITY in gap["message"]


def test_a_rejected_request_records_exactly_one_gap_per_declared_key() -> None:
    """Req 5.8 — one gap per `(resource, key)`, so the displayed count is the count of
    absences and not a multiple of it."""
    machines = [vm("prod-web-01"), vm("prod-web-02")]
    _, gaps = collect(
        resources=machines,
        reservations=RawHttpResponse(status=403, headers={}, body=None),
    )

    pairs = [(gap["resource_id"], gap["metric"]) for gap in gaps]
    assert len(pairs) == len(set(pairs)) == len(machines) * len(RESERVED_KEYS)


# --------------------------------------------------------------------------- #
# Branch 2 — the request succeeded and covered nothing (Req 5.2)
# --------------------------------------------------------------------------- #


def test_a_successful_listing_covering_no_resource_is_no_reservations() -> None:
    """The other branch, and the one a consultant reads as information rather than as an
    error: this subscription's VMs are on-demand."""
    machine = vm("prod-web-01")
    facts, gaps = collect(resources=[machine], reservations=empty_fact_list())

    assert facts == []
    assert {gap["gap_type"] for gap in gaps} == {RESERVATION_ABSENT_GAP_TYPE}
    assert {gap["metric"] for gap in gaps} == set(RESERVED_KEYS)
    assert all(gap["source"] == SOURCE_CAPACITY for gap in gaps)


def test_a_listing_whose_reservations_cover_another_sku_is_still_no_reservations() -> None:
    """A reservation for one VM size says nothing about a VM of another, so a subscription
    holding reservations can still answer `no_reservations` for a particular resource. That
    is why the gap is per-resource rather than per-subscription."""
    machine = vm("prod-web-01", sku_name="Standard_E8s_v5")
    facts, gaps = collect(
        resources=[machine],
        reservations=RawHttpResponse(
            status=200, headers={}, body={"value": [reservation(sku_name=SKU)]}
        ),
    )

    assert facts == []
    assert {gap["gap_type"] for gap in gaps} == {RESERVATION_ABSENT_GAP_TYPE}


def test_the_two_branches_are_told_apart_by_gap_type_alone() -> None:
    """The assertion this module exists for. Both branches produce **zero** reservation
    facts, so a test asserting "no fact was recorded" passes against a collector that
    collapsed them — the gap type is the only observable difference."""
    machine = vm("prod-web-01")
    rejected_facts, rejected_gaps = collect(
        resources=[machine],
        reservations=RawHttpResponse(status=403, headers={}, body=None),
    )
    empty_facts, empty_gaps = collect(
        resources=[machine], reservations=empty_fact_list()
    )

    assert rejected_facts == empty_facts == []
    assert len(rejected_gaps) == len(empty_gaps)
    assert {gap["gap_type"] for gap in rejected_gaps} == {GAP_TYPE_FACT_UNAVAILABLE}
    assert {gap["gap_type"] for gap in empty_gaps} == {RESERVATION_ABSENT_GAP_TYPE}
    assert GAP_TYPE_FACT_UNAVAILABLE != RESERVATION_ABSENT_GAP_TYPE


# --------------------------------------------------------------------------- #
# Branch 3 — a reservation that does cover the resource (the positive control)
# --------------------------------------------------------------------------- #


def test_a_covering_reservation_records_its_term_and_expiry_and_no_gap() -> None:
    """The positive control both branches above need: without it, a collector that recorded
    `no_reservations` for **every** resource unconditionally would satisfy every assertion
    in this file."""
    machine = vm("prod-web-01")
    facts, gaps = collect(
        resources=[machine],
        reservations=RawHttpResponse(
            status=200, headers={}, body={"value": [reservation()]}
        ),
    )

    assert gaps == []
    by_key = {fact["key"]: fact for fact in facts}
    assert set(by_key) == set(RESERVED_KEYS)
    assert by_key["reservation_term"]["value"] == "P3Y"
    assert by_key["reservation_expires_at"]["value"] == "2029-06-30"
    for fact in facts:
        assert fact["source"] == SOURCE_CAPACITY
        assert fact["value_kind"] == "text"
        assert fact["collected_at"].endswith("Z")


@pytest.mark.parametrize(
    ("scope_type", "scopes", "covered"),
    [
        ("Shared", [], True),
        ("Single", [f"/subscriptions/{SUBSCRIPTION}"], True),
        ("Single", [f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod"], True),
        ("Single", [f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-other"], False),
        ("Single", [], False),
    ],
)
def test_the_applied_scope_decides_whether_a_reservation_covers_a_resource(
    scope_type: str, scopes: list[str], covered: bool
) -> None:
    """A reservation names an applied scope and a SKU, never a resource, so the covering
    relation has to be computed. A `Shared` scope covers the subscription; a `Single` one
    covers what its scopes name."""
    machine = vm("prod-web-01")
    facts, gaps = collect(
        resources=[machine],
        reservations=RawHttpResponse(
            status=200,
            headers={},
            body={"value": [reservation(scope_type=scope_type, scopes=scopes)]},
        ),
    )

    assert bool(facts) is covered
    assert bool(gaps) is not covered


def test_one_reserved_and_one_on_demand_vm_get_different_answers() -> None:
    """Two resources, one listing, two outcomes — which is the point of matching per
    resource rather than asking "does this subscription have reservations"."""
    reserved = vm("prod-web-01", sku_name=SKU)
    on_demand = vm("prod-web-02", sku_name="Standard_E8s_v5")
    facts, gaps = collect(
        resources=[reserved, on_demand],
        reservations=RawHttpResponse(
            status=200, headers={}, body={"value": [reservation()]}
        ),
    )

    assert {fact["resource_id"] for fact in facts} == {reserved["resource_id"]}
    assert {gap["resource_id"] for gap in gaps} == {on_demand["resource_id"]}
