"""Task 11.2 — `azure/inventory.py`: paging, quota waits, power state, dedup.

Driven against `FakeInventoryPort` and the recorded fixtures in `tests/fixtures/azure/`
(Req 20.1-20.5, 20.9-20.14). The wait/backoff logic is exercised with an injected `sleep`
so every quota-fallback path runs in milliseconds rather than in real seconds, the same
pattern `heartbeat.py`'s `merge_with_heartbeat` and `progress.py`'s `ProgressReporter`
use for their own clocks.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from fakes.azure_ports import ExhaustedScriptError, FakeInventoryPort, raw_response_from_recorded
from fixtures import load_response
from reporting_agent.azure.inventory import (
    DECLARED_POWER_STATES,
    FALLBACK_WAIT_S,
    MAX_CONSECUTIVE_FALLBACK_WAITS,
    POWER_STATE_UNKNOWN,
    VIRTUAL_MACHINE_RESOURCE_TYPE,
    InventoryCollector,
    normalize_power_state,
    parse_quota_remaining,
    parse_reset_after,
)
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_DUPLICATE_INVENTORY_ROW,
    GAP_TYPE_POWER_STATE_UNKNOWN,
)
from reporting_agent.errors import ErrorCode, ThrottledError

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
VM_TYPES = (VIRTUAL_MACHINE_RESOURCE_TYPE,)


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class RecordingSleep:
    """An injected `sleep` that records every wait instead of actually waiting."""

    def __init__(self) -> None:
        self.waits: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


def collector(responses: list[RawHttpResponse], sleep: RecordingSleep | None = None) -> tuple[InventoryCollector, FakeInventoryPort]:
    port = FakeInventoryPort(responses)
    return InventoryCollector(port, sleep=sleep or RecordingSleep()), port


# --------------------------------------------------------------------------- #
# skip_token paging (Req 20.2, 20.11)
# --------------------------------------------------------------------------- #


def test_paging_follows_skip_token_until_a_page_carries_none() -> None:
    page_1 = raw_response_from_recorded(load_response("azure", "resource_graph_page_1_of_2"))
    page_2 = raw_response_from_recorded(
        load_response("azure", "resource_graph_page_2_of_2_duplicate_boundary")
    )
    inv, port = collector([page_1, page_2])

    result = run(
        inv.discover(
            subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline"
        )
    )

    # page 1 has prod-web-01, prod-web-02; page 2 repeats prod-web-02 and adds prod-web-03.
    ids = [r["resource_id"] for r in result["resources"]]
    assert len(ids) == 3
    assert ids == sorted(ids)  # Req 18.9

    assert [call["skip_token"] for call in port.calls] == [
        None,
        page_1.body["skipToken"],
    ]


def test_paging_scopes_every_request_to_the_subscription_and_resource_types() -> None:
    page = raw_response_from_recorded(load_response("azure", "resource_graph_two_types_two_locations"))
    inv, port = collector([page])

    run(
        inv.discover(
            subscription_id=SUBSCRIPTION,
            resource_types=("Microsoft.Compute/virtualMachines", "Microsoft.Storage/storageAccounts"),
            fidelity_tier="baseline",
        )
    )

    assert port.calls == [
        {
            "subscription_id": SUBSCRIPTION,
            "resource_types": (
                "Microsoft.Compute/virtualMachines",
                "Microsoft.Storage/storageAccounts",
            ),
            "skip_token": None,
            # Empty until the fact declaration supplies projections: with none, the
            # query is byte-identical to the one this port built before facts existed.
            "fact_projections": (),
        }
    ]


def test_a_blank_subscription_id_raises_value_error() -> None:
    inv, _ = collector([])
    with pytest.raises(ValueError):
        run(inv.discover(subscription_id="  ", resource_types=VM_TYPES, fidelity_tier="baseline"))


# --------------------------------------------------------------------------- #
# duplicate resource id across a page boundary (Req 20.12)
# --------------------------------------------------------------------------- #


def test_a_duplicated_resource_id_across_a_page_boundary_keeps_one_entry_and_records_a_gap() -> None:
    page_1 = raw_response_from_recorded(load_response("azure", "resource_graph_page_1_of_2"))
    page_2 = raw_response_from_recorded(
        load_response("azure", "resource_graph_page_2_of_2_duplicate_boundary")
    )
    inv, _ = collector([page_1, page_2])

    result = run(
        inv.discover(
            subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline"
        )
    )

    ids = [r["resource_id"] for r in result["resources"]]
    assert len(ids) == len(set(ids)), "a duplicate id must be folded to exactly one entry"

    duplicate_id = page_1.body["data"][-1]["id"]
    assert ids.count(duplicate_id) == 1

    dup_gaps = [g for g in result["gaps"] if g["gap_type"] == GAP_TYPE_DUPLICATE_INVENTORY_ROW]
    assert len(dup_gaps) == 1
    assert dup_gaps[0]["resource_id"] == duplicate_id


# --------------------------------------------------------------------------- #
# quota headers (Req 20.3, 20.4, 20.14)
# --------------------------------------------------------------------------- #


def test_quota_remaining_at_least_one_issues_the_next_request_with_no_wait() -> None:
    first = raw_response_from_recorded(load_response("azure", "resource_graph_quota_remaining_1"))
    # last page: no skip token, so paging stops after this one.
    last = RawHttpResponse(
        status=200, headers={"x-ms-user-quota-remaining": "5"}, body={"data": [], "skipToken": None}
    )
    sleep = RecordingSleep()
    inv, _ = collector([first, last], sleep)

    run(inv.discover(subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline"))

    assert sleep.waits == []


def test_quota_remaining_zero_with_a_parseable_reset_header_waits_exactly_that_duration() -> None:
    first = raw_response_from_recorded(
        load_response("azure", "resource_graph_quota_remaining_0_with_reset")
    )
    last = RawHttpResponse(
        status=200, headers={"x-ms-user-quota-remaining": "5"}, body={"data": [], "skipToken": None}
    )
    sleep = RecordingSleep()
    inv, _ = collector([first, last], sleep)

    run(inv.discover(subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline"))

    assert sleep.waits == [5.0]


def test_quota_remaining_zero_without_a_reset_header_waits_the_five_second_fallback() -> None:
    first = raw_response_from_recorded(
        load_response("azure", "resource_graph_quota_remaining_0_without_reset")
    )
    last = RawHttpResponse(
        status=200, headers={"x-ms-user-quota-remaining": "5"}, body={"data": [], "skipToken": None}
    )
    sleep = RecordingSleep()
    inv, _ = collector([first, last], sleep)

    run(inv.discover(subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline"))

    assert sleep.waits == [FALLBACK_WAIT_S]


def test_quota_remaining_zero_with_an_unparseable_reset_header_also_falls_back() -> None:
    first = raw_response_from_recorded(
        load_response("azure", "resource_graph_quota_remaining_0_unparseable_reset")
    )
    last = RawHttpResponse(
        status=200, headers={"x-ms-user-quota-remaining": "5"}, body={"data": [], "skipToken": None}
    )
    sleep = RecordingSleep()
    inv, _ = collector([first, last], sleep)

    run(inv.discover(subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline"))

    assert sleep.waits == [FALLBACK_WAIT_S]


def _quota_exhausted_page(skip_token: str | None) -> RawHttpResponse:
    return RawHttpResponse(
        status=200,
        headers={"x-ms-user-quota-remaining": "0"},
        body={"data": [], "skipToken": skip_token},
    )


def test_a_fourth_consecutive_fallback_wait_raises_throttled_instead_of_waiting_again() -> None:
    # Pages 1-3 exhaust the quota with no usable reset header each time; each of those
    # three pages must trigger exactly one fallback wait. Page 4 would require a 4th
    # consecutive fallback wait and must raise instead.
    pages = [_quota_exhausted_page(f"tok-{i}") for i in range(1, 4)]
    pages.append(_quota_exhausted_page("tok-4"))  # never reached; the 4th wait raises first
    sleep = RecordingSleep()
    inv, _ = collector(pages, sleep)

    with pytest.raises(ThrottledError) as caught:
        run(
            inv.discover(
                subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline"
            )
        )

    assert caught.value.code is ErrorCode.THROTTLED
    assert caught.value.terminal is True
    # Exactly 3 waits were applied before the 4th was refused.
    assert sleep.waits == [FALLBACK_WAIT_S] * MAX_CONSECUTIVE_FALLBACK_WAITS


def test_a_normal_wait_resets_the_consecutive_fallback_counter() -> None:
    """Three fallback waits, then a page whose remaining is >=1 (no wait, and it resets
    the counter), then three more fallback waits: never a 4th *consecutive* one."""
    pages = [_quota_exhausted_page(f"tok-a{i}") for i in range(1, 4)]
    pages.append(
        RawHttpResponse(
            status=200,
            headers={"x-ms-user-quota-remaining": "9"},
            body={"data": [], "skipToken": "tok-reset"},
        )
    )
    pages.extend(_quota_exhausted_page(f"tok-b{i}") for i in range(1, 4))
    pages.append(RawHttpResponse(status=200, headers={}, body={"data": [], "skipToken": None}))

    sleep = RecordingSleep()
    inv, _ = collector(pages, sleep)

    run(inv.discover(subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline"))

    assert sleep.waits == [FALLBACK_WAIT_S] * 6


def test_the_inventory_fake_running_out_of_script_raises_exhausted_script_error() -> None:
    """A page with a skip_token but no further scripted response is a fixture bug in the
    test, not a case the collector needs to handle -- proven here rather than assumed."""
    only_page = RawHttpResponse(
        status=200, headers={}, body={"data": [], "skipToken": "more"}
    )
    inv, _ = collector([only_page])

    with pytest.raises(ExhaustedScriptError):
        run(
            inv.discover(
                subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline"
            )
        )


# --------------------------------------------------------------------------- #
# power state (Req 20.5, 20.9, 20.10, 20.13)
# --------------------------------------------------------------------------- #


def test_a_deallocated_vm_stays_in_inventory_and_records_a_deallocated_gap_with_the_exact_code() -> None:
    page = raw_response_from_recorded(
        load_response("azure", "resource_graph_page_2_of_2_duplicate_boundary")
    )
    inv, _ = collector([page])

    result = run(
        inv.discover(subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline")
    )

    deallocated = [r for r in result["resources"] if r["name"] == "prod-web-03"]
    assert len(deallocated) == 1
    resource = deallocated[0]
    assert resource["power_state_raw"] == "PowerState/deallocated"
    assert resource["power_state"] == "deallocated"
    # present with every field Req 20.10 names
    assert resource["resource_id"]
    assert resource["resource_type"]
    assert resource["location"]
    assert resource["resource_group"]
    assert resource["tags"] == {"env": "prod"}

    gaps = [g for g in result["gaps"] if g["gap_type"] == GAP_TYPE_DEALLOCATED]
    assert len(gaps) == 1
    assert gaps[0]["resource_id"] == resource["resource_id"]
    assert gaps[0]["message"] == "PowerState/deallocated"


def test_a_stopped_vm_also_records_a_deallocated_gap_carrying_its_own_exact_code() -> None:
    page = RawHttpResponse(
        status=200,
        headers={},
        body={
            "data": [
                {
                    "id": "/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm-stopped",
                    "name": "vm-stopped",
                    "type": "microsoft.compute/virtualmachines",
                    "location": "southeastasia",
                    "resourceGroup": "y",
                    "tags": {},
                    "sku": "Standard_D2s_v5",
                    "powerState": "PowerState/stopped",
                }
            ],
            "skipToken": None,
        },
    )
    inv, _ = collector([page])

    result = run(
        inv.discover(subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline")
    )

    assert len(result["resources"]) == 1
    assert result["resources"][0]["power_state"] == "stopped"
    gaps = [g for g in result["gaps"] if g["gap_type"] == GAP_TYPE_DEALLOCATED]
    assert len(gaps) == 1
    assert gaps[0]["message"] == "PowerState/stopped"


def test_an_absent_power_state_code_on_a_vm_records_power_state_unknown() -> None:
    page = RawHttpResponse(
        status=200,
        headers={},
        body={
            "data": [
                {
                    "id": "/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm-no-state",
                    "name": "vm-no-state",
                    "type": "microsoft.compute/virtualmachines",
                    "location": "southeastasia",
                    "resourceGroup": "y",
                    "tags": {},
                    "sku": "Standard_D2s_v5",
                    # powerState absent entirely
                },
                {
                    "id": "/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm-empty-state",
                    "name": "vm-empty-state",
                    "type": "microsoft.compute/virtualmachines",
                    "location": "southeastasia",
                    "resourceGroup": "y",
                    "tags": {},
                    "sku": "Standard_D2s_v5",
                    "powerState": "",
                },
            ],
            "skipToken": None,
        },
    )
    inv, _ = collector([page])

    result = run(
        inv.discover(subscription_id=SUBSCRIPTION, resource_types=VM_TYPES, fidelity_tier="baseline")
    )

    assert len(result["resources"]) == 2
    for resource in result["resources"]:
        assert resource["power_state"] == POWER_STATE_UNKNOWN

    unknown_gaps = [g for g in result["gaps"] if g["gap_type"] == GAP_TYPE_POWER_STATE_UNKNOWN]
    assert len(unknown_gaps) == 2
    resource_ids = {r["resource_id"] for r in result["resources"]}
    assert {g["resource_id"] for g in unknown_gaps} == resource_ids


def test_an_empty_power_state_on_a_non_vm_resource_records_no_power_state_unknown_gap() -> None:
    """Req 20.13 is scoped to `Microsoft.Compute/virtualMachines`; a Storage Account has
    no power state at all, so an empty value there is ordinary, not a gap."""
    page = raw_response_from_recorded(load_response("azure", "resource_graph_two_types_two_locations"))
    inv, _ = collector([page])

    result = run(
        inv.discover(
            subscription_id=SUBSCRIPTION,
            resource_types=(
                "Microsoft.Compute/virtualMachines",
                "Microsoft.Storage/storageAccounts",
            ),
            fidelity_tier="baseline",
        )
    )

    storage_resources = [
        r for r in result["resources"] if r["resource_type"] == "microsoft.storage/storageaccounts"
    ]
    assert storage_resources, "the fixture must carry at least one storage account"
    for r in storage_resources:
        assert r["power_state_raw"] == ""
        assert r["power_state"] == POWER_STATE_UNKNOWN

    unknown_gaps = [g for g in result["gaps"] if g["gap_type"] == GAP_TYPE_POWER_STATE_UNKNOWN]
    storage_ids = {r["resource_id"] for r in storage_resources}
    assert not (storage_ids & {g["resource_id"] for g in unknown_gaps})


def test_deallocated_vm_from_the_two_types_two_locations_fixture_stays_present() -> None:
    page = raw_response_from_recorded(load_response("azure", "resource_graph_two_types_two_locations"))
    inv, _ = collector([page])

    result = run(
        inv.discover(
            subscription_id=SUBSCRIPTION,
            resource_types=(
                "Microsoft.Compute/virtualMachines",
                "Microsoft.Storage/storageAccounts",
            ),
            fidelity_tier="baseline",
        )
    )

    dr_web = [r for r in result["resources"] if r["name"] == "dr-web-01"]
    assert len(dr_web) == 1
    assert dr_web[0]["power_state"] == "deallocated"
    assert any(
        g["gap_type"] == GAP_TYPE_DEALLOCATED and g["resource_id"] == dr_web[0]["resource_id"]
        for g in result["gaps"]
    )


# --------------------------------------------------------------------------- #
# fidelity_tier and power_state on every resource (Req 20.9)
# --------------------------------------------------------------------------- #


def test_every_resource_carries_fidelity_tier_and_power_state() -> None:
    page = raw_response_from_recorded(load_response("azure", "resource_graph_two_types_two_locations"))
    inv, _ = collector([page])

    result = run(
        inv.discover(
            subscription_id=SUBSCRIPTION,
            resource_types=(
                "Microsoft.Compute/virtualMachines",
                "Microsoft.Storage/storageAccounts",
            ),
            fidelity_tier="enhanced",
        )
    )

    assert result["resources"], "the fixture must yield at least one resource"
    for resource in result["resources"]:
        assert resource["fidelity_tier"] == "enhanced"
        assert resource["power_state"] in DECLARED_POWER_STATES


# --------------------------------------------------------------------------- #
# pure helpers
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("PowerState/running", "running"),
        ("PowerState/stopped", "stopped"),
        ("PowerState/deallocated", "deallocated"),
        ("PowerState/starting", "starting"),
        ("PowerState/stopping", "stopping"),
        ("PowerState/deallocating", "deallocating"),
        ("powerstate/RUNNING", "running"),
        ("", POWER_STATE_UNKNOWN),
        (None, POWER_STATE_UNKNOWN),
        ("PowerState/somethingweird", POWER_STATE_UNKNOWN),
        (42, POWER_STATE_UNKNOWN),
    ],
)
def test_normalize_power_state(raw: object, expected: str) -> None:
    assert normalize_power_state(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("9", 9),
        ("0", 0),
        ("1", 1),
        (None, None),
        ("", None),
        ("not-a-number", None),
        (14, None),  # not a string
    ],
)
def test_parse_quota_remaining(raw: object, expected: int | None) -> None:
    assert parse_quota_remaining(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("00:00:05", 5.0),
        ("00:01:00", 60.0),
        ("1.00:00:00", 86400.0),
        ("00:00:05.5000000", 5.5),
        (None, None),
        ("", None),
        ("unknown", None),
        (5, None),
    ],
)
def test_parse_reset_after(raw: object, expected: float | None) -> None:
    assert parse_reset_after(raw) == expected
