"""Azure Advisor as a fifth fact source (task 6.4, Req 16.7).

There is one reason this file exists apart from `test_azure_facts.py`, and it is the same
reason `test_facts_reservations.py` exists apart from it:

* a **rejected** `Microsoft.Advisor` request records `fact_unavailable` naming the source;
* a **successful** response that names nothing for a resource records `advisor_not_available`.

Unlike reservations, Reader at subscription scope **does** grant
`Microsoft.Advisor/recommendations/read` — Advisor is a read-only recommendation feed, not a
capacity-purchase record — so the rejected branch is the less common of the two here. The
distinction is drawn the same way regardless: collapsing either direction would misreport
either a permission problem as a data problem or the reverse, and both branches produce
**zero** advisor facts for an unmentioned resource, so a test that only checks "no fact was
recorded" cannot tell a correctly-configured empty subscription from a broken connection.
"""

from __future__ import annotations

import asyncio
from typing import Any, Final

import pytest

from fakes.azure_ports import FakeFactsPort, empty_fact_list
from fakes.object_store import InMemoryObjectStore
from reporting_agent.azure.facts import (
    ADVISOR_ABSENT_GAP_TYPE,
    SOURCE_ADVISOR,
    FactCollector,
)
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.log import GAP_TYPE_FACT_UNAVAILABLE
from reporting_agent.providers.base import GapRecord, ResourceRecord

VM_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
ADVISOR_KEYS: Final[tuple[str, ...]] = ("category", "impact", "recommendation")

CATALOG = load_catalog()


def vm(name: str) -> ResourceRecord:
    resource_id = (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod/providers/"
        f"Microsoft.Compute/virtualMachines/{name}"
    )
    return ResourceRecord(
        resource_id=resource_id,
        name=name,
        resource_type=VM_TYPE,
        location="southeastasia",
        resource_group="rg-prod",
        tags={},
        sku_name="Standard_D4s_v3",
        power_state_raw="PowerState/running",
        power_state="running",
        fidelity_tier="baseline",
    )


def recommendation(*, resource_id: str, name: str = "armavset") -> dict[str, Any]:
    """One Advisor recommendation, shaped exactly as Advisor's own REST reference
    (`ResourceRecommendationBase`) documents it."""
    return {
        "id": f"{resource_id}/providers/Microsoft.Advisor/recommendations/bd27ddc6",
        "name": "bd27ddc6-1312-4067-b4af-cbb45e32cfd7",
        "properties": {
            "category": "HighAvailability",
            "impact": "Medium",
            "impactedField": VM_TYPE,
            "impactedValue": name,
            "shortDescription": {
                "problem": "A problem Advisor found.",
                "solution": "What to do about it.",
            },
            "resourceMetadata": {"resourceId": resource_id},
        },
        "type": "Microsoft.Advisor/recommendations",
    }


def collect(
    *,
    resources: list[ResourceRecord],
    recommendations: RawHttpResponse,
) -> tuple[list[dict[str, Any]], list[GapRecord]]:
    """The collector over a scripted Advisor answer and nothing else.

    Backup and reservations are scripted as successful-and-empty and their gaps are dropped
    below, so every assertion here is about the advisor source alone.
    """
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[recommendations],
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
    facts = [dict(fact) for fact in result.facts if fact["source"] == SOURCE_ADVISOR]
    gaps = [gap for gap in result.gaps if gap["source"] == SOURCE_ADVISOR]
    return facts, gaps


# --------------------------------------------------------------------------- #
# Branch 1 — the request was rejected
# --------------------------------------------------------------------------- #


ARM_FORBIDDEN_BODY: Final[dict[str, Any]] = {
    "error": {
        "code": "AuthorizationFailed",
        "message": (
            "The client does not have authorization to perform action "
            "'Microsoft.Advisor/recommendations/read'."
        ),
    }
}


@pytest.mark.parametrize("status", [401, 403, 404, 429, 500])
@pytest.mark.parametrize(
    "body", [None, ARM_FORBIDDEN_BODY, {"value": []}], ids=["empty", "arm-error", "no-value"]
)
def test_a_rejected_advisor_request_is_fact_unavailable_naming_the_source(
    status: int, body: Any
) -> None:
    """Not `advisor_not_available`. A rejected list is a role problem, and reporting it as
    an absence would state that Advisor has no recommendation for this resource on the
    strength of never having been allowed to ask."""
    machine = vm("prod-web-01")
    facts, gaps = collect(
        resources=[machine],
        recommendations=RawHttpResponse(status=status, headers={}, body=body),
    )

    assert facts == []
    assert {gap["gap_type"] for gap in gaps} == {GAP_TYPE_FACT_UNAVAILABLE}
    assert {gap["metric"] for gap in gaps} == set(ADVISOR_KEYS)
    for gap in gaps:
        assert gap["resource_id"] == machine["resource_id"]
        assert gap["source"] == SOURCE_ADVISOR
        assert SOURCE_ADVISOR in gap["message"]


def test_a_rejected_request_records_exactly_one_gap_per_declared_key() -> None:
    """One gap per `(resource, key)`, so the displayed count is the count of absences and
    not a multiple of it."""
    machines = [vm("prod-web-01"), vm("prod-web-02")]
    _, gaps = collect(
        resources=machines,
        recommendations=RawHttpResponse(status=403, headers={}, body=None),
    )

    pairs = [(gap["resource_id"], gap["metric"]) for gap in gaps]
    assert len(pairs) == len(set(pairs)) == len(machines) * len(ADVISOR_KEYS)


# --------------------------------------------------------------------------- #
# Branch 2 — the request succeeded and named nothing for this resource
# --------------------------------------------------------------------------- #


def test_a_successful_listing_naming_nothing_is_advisor_not_available() -> None:
    """The other branch, and the one a consultant reads as information rather than as an
    error: Advisor simply has no finding for this resource right now."""
    machine = vm("prod-web-01")
    facts, gaps = collect(resources=[machine], recommendations=empty_fact_list())

    assert facts == []
    assert {gap["gap_type"] for gap in gaps} == {ADVISOR_ABSENT_GAP_TYPE}
    assert {gap["metric"] for gap in gaps} == set(ADVISOR_KEYS)
    assert all(gap["source"] == SOURCE_ADVISOR for gap in gaps)


def test_a_listing_naming_another_resource_is_still_advisor_not_available() -> None:
    """A recommendation about a resource not in this run's inventory must not be folded
    onto a resource that happens to be present — matching is by id, not by presence."""
    machine = vm("prod-web-01")
    other = vm("prod-web-02")
    facts, gaps = collect(
        resources=[machine],
        recommendations=RawHttpResponse(
            status=200,
            headers={},
            body={"value": [recommendation(resource_id=other["resource_id"])]},
        ),
    )

    assert facts == []
    assert {gap["gap_type"] for gap in gaps} == {ADVISOR_ABSENT_GAP_TYPE}


def test_the_two_branches_are_told_apart_by_gap_type_alone() -> None:
    """The assertion this module exists for. Both branches produce **zero** advisor facts,
    so a test asserting "no fact was recorded" passes against a collector that collapsed
    them — the gap type is the only observable difference."""
    machine = vm("prod-web-01")
    rejected_facts, rejected_gaps = collect(
        resources=[machine],
        recommendations=RawHttpResponse(status=403, headers={}, body=None),
    )
    empty_facts, empty_gaps = collect(
        resources=[machine], recommendations=empty_fact_list()
    )

    assert rejected_facts == empty_facts == []
    assert len(rejected_gaps) == len(empty_gaps)
    assert {gap["gap_type"] for gap in rejected_gaps} == {GAP_TYPE_FACT_UNAVAILABLE}
    assert {gap["gap_type"] for gap in empty_gaps} == {ADVISOR_ABSENT_GAP_TYPE}
    assert GAP_TYPE_FACT_UNAVAILABLE != ADVISOR_ABSENT_GAP_TYPE


# --------------------------------------------------------------------------- #
# Branch 3 — a recommendation that does name the resource (the positive control)
# --------------------------------------------------------------------------- #


def test_a_matching_recommendation_records_all_four_facts_and_no_gap() -> None:
    machine = vm("prod-web-01")
    facts, gaps = collect(
        resources=[machine],
        recommendations=RawHttpResponse(
            status=200,
            headers={},
            body={
                "value": [
                    recommendation(resource_id=machine["resource_id"], name="prod-web-01")
                ]
            },
        ),
    )

    by_key = {fact["key"]: fact["value"] for fact in facts}
    assert by_key == {
        "category": "HighAvailability",
        "impact": "Medium",
        "recommendation": "What to do about it.",
    }
    assert gaps == []
    assert all(fact["resource_id"] == machine["resource_id"] for fact in facts)
    assert all(fact["source"] == SOURCE_ADVISOR for fact in facts)


def test_a_hundred_resources_cost_one_request_not_one_hundred() -> None:
    """Advisor's own list is subscription-scoped, matching every other source's Req 4.8
    "no per-resource fact request" rule — the same claim `test_azure_facts.py` already
    proves for backup and reservations, restated for the source this module is about."""
    machine = vm("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[
            RawHttpResponse(
                status=200,
                headers={},
                body={
                    "value": [
                        recommendation(resource_id=vm(f"vm-{i:03d}")["resource_id"])
                        for i in range(100)
                    ]
                    + [recommendation(resource_id=machine["resource_id"], name="prod-web-01")]
                },
            )
        ],
    )
    collector = FactCollector(
        port,
        ArchiveWriter(store=InMemoryObjectStore()),
        declaration=CATALOG.facts,
        semaphore=asyncio.Semaphore(8),
    )
    resources = [vm(f"vm-{i:03d}") for i in range(100)] + [machine]
    asyncio.run(
        collector.collect(
            resources=resources, inventory_pages=(), subscription_id=SUBSCRIPTION
        )
    )

    assert len(port.advisor_calls) == 1
    assert port.advisor_calls[0] == {"subscription_id": SUBSCRIPTION}
