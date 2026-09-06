"""Azure Advisor as a fifth fact source (task 6.4, Req 16.7).

## One row per recommendation

A fact is one value per `(resource_id, key)`, and Advisor answers many recommendations for
one resource — seven for a single virtual machine in the subscription this was measured
against. So six of those seven were overwritten and lost, silently, because replacing a
mapping key is not an event anything reports: **26 recommendations across 8 resources, of
which 18 (69%) never reached the document.** The section printed eight rows and read as a
complete answer.

Each recommendation is now its own synthetic resource — the third child type, on the terms
`Microsoft.Network/virtualNetworks/subnets` and `.../securityRules` already establish: a
thing the document renders as a **row** is a resource in this model. Its name carries the
resource it is about and that resource's kind, `cpn-mcp (Virtual Machine)`, which is what
the Recommendations table's resource column prints.

## Telling a refusal from an empty answer

Still the reason this file exists apart from `test_azure_facts.py`. Both outcomes produce
**zero** rows, so a test asserting "no fact was recorded" passes against a collector that
collapsed them:

* a **rejected** `Microsoft.Advisor` request records `fact_unavailable` naming the source;
* a **successful** listing naming nothing records `advisor_not_available`.

Both are recorded against the **subscription**, which is the change. The three keys used to
be declared on every reportable type, so one 403 over twenty machines recorded sixty
entries all saying the same sentence. Advisor is asked once, of the subscription, so its
silence is one absence per key rather than one per resource per key.

Unlike reservations, Reader at subscription scope **does** grant
`Microsoft.Advisor/recommendations/read` — Advisor is a read-only recommendation feed, not a
capacity-purchase record — so the rejected branch is the less common of the two here.
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


def recommendation(
    *,
    resource_id: str,
    name: str = "armavset",
    solution: str = "What to do about it.",
) -> dict[str, Any]:
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
                "solution": solution,
            },
            "resourceMetadata": {"resourceId": resource_id},
        },
        "type": "Microsoft.Advisor/recommendations",
    }


def collect(
    *,
    resources: list[ResourceRecord],
    recommendations: RawHttpResponse,
) -> tuple[list[dict[str, Any]], list[GapRecord], list[ResourceRecord]]:
    """The collector over a scripted Advisor answer and nothing else.

    Returns `(facts, gaps, rows)`. Backup and reservations are scripted as
    successful-and-empty and their gaps are dropped below, so every assertion here is about
    the advisor source alone.
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
    return facts, gaps, list(result.resources)


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
    """Not silence. A rejected list is a role problem, and recording nothing would state
    that Advisor has no recommendation on the strength of never having been allowed to
    ask."""
    machine = vm("prod-web-01")
    facts, gaps, rows = collect(
        resources=[machine],
        recommendations=RawHttpResponse(status=status, headers={}, body=body),
    )

    assert facts == []
    assert rows == []
    assert {gap["gap_type"] for gap in gaps} == {GAP_TYPE_FACT_UNAVAILABLE}
    assert {gap["metric"] for gap in gaps} == set(ADVISOR_KEYS)
    for gap in gaps:
        # Against the **subscription**, which is what Advisor was asked of.
        assert gap["resource_id"] == SUBSCRIPTION
        assert gap["source"] == SOURCE_ADVISOR


def test_a_rejected_request_records_one_gap_per_key_and_not_one_per_resource() -> None:
    """Advisor is asked **once**, of the subscription, so its refusal is one absence per
    declared key and not one per resource per key.

    It used to be the latter, because the three keys were declared on every reportable type
    and the fold ran over every resource in the run: a single 403 over twenty machines
    recorded sixty entries, all saying the same sentence.
    """
    machines = [vm(f"prod-web-{i:02d}") for i in range(20)]
    _, gaps, _ = collect(
        resources=machines,
        recommendations=RawHttpResponse(status=403, headers={}, body=None),
    )

    assert len(gaps) == len(ADVISOR_KEYS)
    assert {gap["resource_id"] for gap in gaps} == {SUBSCRIPTION}


def test_a_successful_listing_naming_nothing_is_advisor_not_available() -> None:
    """The other branch, and the one a consultant reads as information rather than as an
    error: Advisor simply has no finding for this subscription right now."""
    machine = vm("prod-web-01")
    facts, gaps, rows = collect(
        resources=[machine], recommendations=empty_fact_list()
    )

    assert facts == []
    assert rows == []
    assert {gap["gap_type"] for gap in gaps} == {ADVISOR_ABSENT_GAP_TYPE}
    assert {gap["resource_id"] for gap in gaps} == {SUBSCRIPTION}


def test_the_two_branches_are_told_apart_by_gap_type_alone() -> None:
    """The assertion this module exists for. Both branches produce **zero** rows and zero
    facts, so a test asserting "nothing was recorded" passes against a collector that
    collapsed them — the gap type is the only observable difference."""
    machine = vm("prod-web-01")
    rejected_facts, rejected_gaps, rejected_rows = collect(
        resources=[machine],
        recommendations=RawHttpResponse(status=403, headers={}, body=None),
    )
    empty_facts, empty_gaps, empty_rows = collect(
        resources=[machine], recommendations=empty_fact_list()
    )

    assert rejected_rows == empty_rows == []
    assert rejected_facts == empty_facts == []
    assert len(rejected_gaps) == len(empty_gaps)
    assert {gap["gap_type"] for gap in rejected_gaps} == {GAP_TYPE_FACT_UNAVAILABLE}
    assert {gap["gap_type"] for gap in empty_gaps} == {ADVISOR_ABSENT_GAP_TYPE}
    assert GAP_TYPE_FACT_UNAVAILABLE != ADVISOR_ABSENT_GAP_TYPE


def test_a_recommendation_about_a_resource_outside_the_run_is_still_a_row() -> None:
    """Advisor recommends on the subscription itself and on resources a scope filter
    excluded. Dropping those for want of an inventory lookup would hide findings the
    consultant asked Azure for; the row falls back to the id's own last segment and the
    type its id names."""
    machine = vm("prod-web-01")
    other = vm("prod-web-02")
    facts, gaps, rows = collect(
        resources=[machine],
        recommendations=RawHttpResponse(
            status=200,
            headers={},
            body={"value": [recommendation(resource_id=other["resource_id"])]},
        ),
    )

    assert [row["name"] for row in rows] == ["prod-web-02 (Virtual Machine)"]
    assert gaps == []
    assert {fact["key"] for fact in facts} == set(ADVISOR_KEYS)


# --------------------------------------------------------------------------- #
# The defect: many recommendations on one resource
# --------------------------------------------------------------------------- #


def test_every_recommendation_for_one_resource_becomes_its_own_row() -> None:
    """The whole fix. Measured against one subscription's real Advisor listing, a single
    virtual machine carried seven recommendations and the document printed one."""
    machine = vm("prod-web-01")
    solutions = [
        "Use Availability zones for better resiliency",
        "Convert Standard to Premium disk for higher uptime",
        "Enable VM Insights for virtual machines",
        "Migrate workload to D-series or better virtual machine",
    ]
    facts, gaps, rows = collect(
        resources=[machine],
        recommendations=RawHttpResponse(
            status=200,
            headers={},
            body={
                "value": [
                    recommendation(
                        resource_id=machine["resource_id"], solution=solution
                    )
                    for solution in solutions
                ]
            },
        ),
    )

    assert len(rows) == len(solutions)
    assert len({row["resource_id"] for row in rows}) == len(solutions)
    recorded = {
        fact["value"] for fact in facts if fact["key"] == "recommendation"
    }
    assert recorded == set(solutions)
    assert gaps == []


def test_two_identical_recommendations_on_one_resource_are_one_row() -> None:
    """The id is derived from the recommendation's own content, so the same finding stated
    twice is the same row. Correct rather than incidental: a reader counting rows is
    counting findings."""
    machine = vm("prod-web-01")
    once = recommendation(resource_id=machine["resource_id"])
    _, _, rows = collect(
        resources=[machine],
        recommendations=RawHttpResponse(
            status=200, headers={}, body={"value": [once, dict(once)]}
        ),
    )

    assert len(rows) == 1


def test_a_row_id_does_not_depend_on_the_order_advisor_answered_in() -> None:
    """Advisor is free to answer in a different order next time. An id derived from
    position would make two runs over an unchanged estate produce different ids for the
    same finding, which every comparison between two reports would read as one
    recommendation disappearing and another appearing."""
    machine = vm("prod-web-01")
    first = recommendation(resource_id=machine["resource_id"], solution="Do A")
    second = recommendation(resource_id=machine["resource_id"], solution="Do B")

    _, _, forwards = collect(
        resources=[machine],
        recommendations=RawHttpResponse(
            status=200, headers={}, body={"value": [first, second]}
        ),
    )
    _, _, backwards = collect(
        resources=[machine],
        recommendations=RawHttpResponse(
            status=200, headers={}, body={"value": [second, first]}
        ),
    )

    assert {row["resource_id"] for row in forwards} == {
        row["resource_id"] for row in backwards
    }


def test_a_row_is_named_for_the_resource_it_is_about_and_that_resource_s_kind() -> None:
    """What the Recommendations table's resource column prints. The label goes in the
    row's **name** rather than a fourth column, which is both what was asked for and the
    smaller change."""
    machine = vm("prod-web-01")
    _, _, rows = collect(
        resources=[machine],
        recommendations=RawHttpResponse(
            status=200,
            headers={},
            body={"value": [recommendation(resource_id=machine["resource_id"])]},
        ),
    )

    assert [row["name"] for row in rows] == ["prod-web-01 (Virtual Machine)"]
    assert rows[0]["resource_type"] == "Microsoft.Advisor/recommendations"


def test_a_row_is_addressed_under_the_resource_it_is_about() -> None:
    """Containment is in the id, where ARM puts it — so a recommendation sorts beside its
    resource and a reader can see which one it belongs to."""
    machine = vm("prod-web-01")
    _, _, rows = collect(
        resources=[machine],
        recommendations=RawHttpResponse(
            status=200,
            headers={},
            body={"value": [recommendation(resource_id=machine["resource_id"])]},
        ),
    )

    assert rows[0]["resource_id"].startswith(
        f"{machine['resource_id']}/providers/Microsoft.Advisor/recommendations/"
    )


# --------------------------------------------------------------------------- #
# The positive control
# --------------------------------------------------------------------------- #


def test_a_matching_recommendation_records_its_three_facts_and_no_gap() -> None:
    machine = vm("prod-web-01")
    facts, gaps, rows = collect(
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
    assert all(fact["resource_id"] == rows[0]["resource_id"] for fact in facts)
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
