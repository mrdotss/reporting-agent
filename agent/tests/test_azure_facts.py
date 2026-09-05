"""Task 4.3 — `azure/facts.py`: the three lists, the projected pages, and what each covers.

The reservation source's two branches have their own module (`test_facts_reservations.py`),
because the task names them. This one covers the rest, and the assertions worth reading twice
are the ones about **coverage**: which resources a request's answer is allowed to speak about.
Every one of them is a claim that would otherwise be made silently, and each silent version is
a plausible-looking sentence in a delivered document.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
from typing import Any, Final
from zoneinfo import ZoneInfo

import pytest

from fakes.azure_ports import FakeFactsPort, empty_fact_list
from fakes.object_store import InMemoryObjectStore
from reporting_agent.azure.clients import (
    BACKUP_MANAGEMENT_TYPE_FILTER,
    FACT_FIELD_PREFIX,
)
from reporting_agent.azure.facts import (
    ADVISOR_ABSENT_GAP_TYPE,
    BACKUP_ABSENT_GAP_TYPE,
    BACKUP_COVERED_RESOURCE_TYPES,
    MAX_FACT_KEY_LENGTH,
    MAX_FACT_VALUE_LENGTH,
    RECOVERY_SERVICES_VAULT_TYPE,
    REPLICATION_ABSENT_GAP_TYPE,
    RESERVATION_ABSENT_GAP_TYPE,
    SOURCE_CAPACITY,
    SOURCE_ADVISOR,
    SOURCE_RECOVERY_SERVICES,
    FactCollector,
    narrowed_to_gap_type,
)
from reporting_agent.azure.metrics import MAX_CONCURRENCY_PER_SUBSCRIPTION
from reporting_agent.azure.ports import FactsPort, RawHttpResponse
from reporting_agent.catalog.loader import (
    DECLARED_ABSENT_GAP_TYPES,
    DECLARED_FACT_SOURCES,
    load_catalog,
)
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.log import GAP_TYPE_FACT_UNAVAILABLE
from reporting_agent.providers.base import FactRecord, GapRecord, InventoryPage, ResourceRecord

VM_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
SQL_DB_TYPE: Final[str] = "Microsoft.Sql/servers/databases"
SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"

CATALOG = load_catalog()
BACKUP_KEYS: Final[tuple[str, ...]] = ("last_backup_status", "last_restore_point")


def resource_id(name: str, *, provider: str = VM_TYPE) -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod/providers/"
        f"{provider}/{name}"
    )


def record(
    name: str, *, resource_type: str = VM_TYPE, sku_name: str = "Standard_D4s_v3"
) -> ResourceRecord:
    return ResourceRecord(
        resource_id=resource_id(name, provider=resource_type),
        name=name,
        resource_type=resource_type.lower(),  # Resource Graph lower-cases `type`
        location="southeastasia",
        resource_group="rg-prod",
        tags={},
        sku_name=sku_name,
        power_state_raw="PowerState/running",
        power_state="running",
        fidelity_tier="baseline",
    )


def page(*rows: dict[str, Any]) -> dict[str, Any]:
    return {"totalRecords": len(rows), "count": len(rows), "data": list(rows)}


DEFAULT_RECEIVED_AT = "2026-08-01T09:30:00Z"


def fact_page(body: Any, *, received_at: str = DEFAULT_RECEIVED_AT) -> InventoryPage:
    """One retained inventory page, paired with the instant it was received.

    A page record is not a response body: `InventoryCollector` pairs each body with the
    receipt instant it also hands the archive, and the fact fold stamps `collected_at`
    from that pairing rather than from its own clock. Tests that supply pages therefore
    have to supply both halves — which is the point, since a body alone is what let the
    fold read a second clock unnoticed.
    """
    return InventoryPage(body=body, received_at=received_at)


def row(resource: ResourceRecord, **facts: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": resource["resource_id"],
        "name": resource["name"],
        "type": resource["resource_type"],
        "location": resource["location"],
        "resourceGroup": resource["resource_group"],
        "tags": {},
        "sku": resource["sku_name"],
        "powerState": resource["power_state_raw"],
    }
    body.update({f"{FACT_FIELD_PREFIX}{key}": value for key, value in facts.items()})
    return body


def backup_item(resource: ResourceRecord, *, status: str = "Completed") -> dict[str, Any]:
    return {
        "id": "/subscriptions/x/…/backupProtectedItems/item-1",
        "properties": {
            "sourceResourceId": resource["resource_id"],
            "lastBackupStatus": status,
            "lastRecoveryPoint": "2026-07-31T18:04:00Z",
        },
    }


def replication_item(
    resource: ResourceRecord, *, health: str = "Normal"
) -> dict[str, Any]:
    return {
        "id": "/subscriptions/x/…/replicationProtectedItems/item-1",
        "properties": {
            "replicationHealth": health,
            "providerSpecificDetails": {"fabricObjectId": resource["resource_id"]},
        },
    }


def collector(
    port: FactsPort, *, semaphore: asyncio.Semaphore | None = None
) -> FactCollector:
    return FactCollector(
        port,
        ArchiveWriter(store=InMemoryObjectStore()),
        declaration=CATALOG.facts,
        semaphore=semaphore or asyncio.Semaphore(MAX_CONCURRENCY_PER_SUBSCRIPTION),
    )


def run(
    port: FactsPort,
    *,
    resources: list[ResourceRecord],
    pages: list[Any] | None = None,
    semaphore: asyncio.Semaphore | None = None,
) -> tuple[list[FactRecord], list[GapRecord]]:
    result = asyncio.run(
        collector(port, semaphore=semaphore).collect(
            resources=resources,
            inventory_pages=pages or [],
            subscription_id=SUBSCRIPTION,
        )
    )
    return list(result.facts), list(result.gaps)


def of_source(items: list[Any], source: str) -> list[Any]:
    return [item for item in items if item["source"] == source]


# --------------------------------------------------------------------------- #
# The declarations agree with the catalog's vocabulary
# --------------------------------------------------------------------------- #


def test_the_mirrored_sources_and_gap_types_agree_with_the_catalog() -> None:
    """Mirrored **by value** so a pure-ish collector does not import the loader's sets for two
    strings; the agreement is a test rather than an import."""
    assert {SOURCE_RECOVERY_SERVICES, SOURCE_CAPACITY} <= DECLARED_FACT_SOURCES
    assert {
        BACKUP_ABSENT_GAP_TYPE,
        REPLICATION_ABSENT_GAP_TYPE,
        RESERVATION_ABSENT_GAP_TYPE,
        ADVISOR_ABSENT_GAP_TYPE,
    } == DECLARED_ABSENT_GAP_TYPES


def test_the_three_absent_gap_types_partition_the_recovery_and_capacity_keys() -> None:
    """The narrowing the module depends on: one source, two APIs, two absences.

    `recovery_services` answers both the backup keys and the replication key, and
    `collect/factfold.py` selects on `source` alone — so folding a backup answer against the
    whole source would report `backup_not_configured` for `replication_health`, which a backup
    list cannot possibly know.
    """
    backup = {e.key for e in narrowed_to_gap_type(CATALOG.facts, BACKUP_ABSENT_GAP_TYPE).entries}
    replication = {
        e.key for e in narrowed_to_gap_type(CATALOG.facts, REPLICATION_ABSENT_GAP_TYPE).entries
    }
    reservations = {
        e.key for e in narrowed_to_gap_type(CATALOG.facts, RESERVATION_ABSENT_GAP_TYPE).entries
    }

    assert backup == set(BACKUP_KEYS)
    assert replication == {"replication_health"}
    assert reservations == {"reservation_term", "reservation_expires_at"}
    assert not backup & replication and not backup & reservations


def test_narrowing_keeps_every_resource_type_and_drops_only_the_other_keys() -> None:
    narrowed = narrowed_to_gap_type(CATALOG.facts, BACKUP_ABSENT_GAP_TYPE)
    assert narrowed.resource_type_names == CATALOG.facts.resource_type_names
    assert all(entry.absent_gap_type == BACKUP_ABSENT_GAP_TYPE for entry in narrowed.entries)


# --------------------------------------------------------------------------- #
# Req 4.8 — one list per source, never one request per resource
# --------------------------------------------------------------------------- #


def test_a_hundred_resources_cost_the_same_two_requests_as_one() -> None:
    """Req 4.8 as an observation rather than an intention. The whole reason a `FactsPort`
    method takes no resource id is that a per-resource shape would be the easy one to write."""
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    run(port, resources=[record(f"vm-{index:03d}") for index in range(100)])

    assert len(port.backup_calls) == 1
    assert len(port.reservation_calls) == 1
    assert len(port.advisor_calls) == 1
    assert port.replication_calls == []
    assert port.backup_calls[0] == {"subscription_id": SUBSCRIPTION}
    assert port.advisor_calls[0] == {"subscription_id": SUBSCRIPTION}


def test_the_backup_filter_is_the_reason_its_answer_covers_virtual_machines_alone() -> None:
    """The filter and the covered set are one claim, asserted together so neither can move
    without the other."""
    assert "AzureIaasVM" in BACKUP_MANAGEMENT_TYPE_FILTER
    assert BACKUP_COVERED_RESOURCE_TYPES == (VM_TYPE,)
    assert SQL_DB_TYPE not in BACKUP_COVERED_RESOURCE_TYPES


def test_a_sql_database_records_no_backup_fact_and_no_backup_gap() -> None:
    """A SQL database declares `last_backup_status` and the `AzureIaasVM`-filtered list cannot
    speak for it, so it records **nothing** — not `backup_not_configured`.

    A database backed up nightly through the `AzureWorkload` management type would otherwise
    be reported as unprotected, which is a false statement rather than a missing one.
    """
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    database = record("db-01", resource_type=SQL_DB_TYPE)
    facts, gaps = run(port, resources=[database])

    mine = [gap for gap in gaps if gap["resource_id"] == database["resource_id"]]
    # Nothing from the **backup** source. Advisor recommends across every type the
    # catalogue declares, so an Advisor listing that named this database nothing is an
    # ordinary `advisor_not_available` and not what this test is about.
    assert [gap for gap in mine if gap["source"] == SOURCE_RECOVERY_SERVICES] == []
    assert [fact for fact in facts if fact["resource_id"] == database["resource_id"]] == []


def test_a_backup_item_records_the_status_and_the_restore_point() -> None:
    machine = record("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[
            RawHttpResponse(status=200, headers={}, body={"value": [backup_item(machine)]})
        ],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, gaps = run(port, resources=[machine])

    by_key = {fact["key"]: fact for fact in of_source(facts, SOURCE_RECOVERY_SERVICES)}
    assert set(by_key) == set(BACKUP_KEYS)
    assert by_key["last_backup_status"]["value"] == "Completed"
    assert not of_source(gaps, SOURCE_RECOVERY_SERVICES)


def test_a_successful_empty_backup_list_is_backup_not_configured() -> None:
    machine = record("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    _, gaps = run(port, resources=[machine])

    recovery = of_source(gaps, SOURCE_RECOVERY_SERVICES)
    assert {gap["gap_type"] for gap in recovery} == {BACKUP_ABSENT_GAP_TYPE}
    assert {gap["metric"] for gap in recovery} == set(BACKUP_KEYS)


def test_a_rejected_backup_list_is_fact_unavailable_not_backup_not_configured() -> None:
    machine = record("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[RawHttpResponse(status=403, headers={}, body=None)],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    _, gaps = run(port, resources=[machine])

    recovery = of_source(gaps, SOURCE_RECOVERY_SERVICES)
    assert {gap["gap_type"] for gap in recovery} == {GAP_TYPE_FACT_UNAVAILABLE}


# --------------------------------------------------------------------------- #
# Req 5.3 — replication, one list per vault, and the case with no vault
# --------------------------------------------------------------------------- #


def test_no_vault_in_scope_records_no_replication_fact_and_no_replication_gap() -> None:
    """"No vault is in scope" and "no vault protects this VM" are not the same statement, and
    only the second is `replication_not_enabled`. Site Recovery has no subscription-wide list,
    so with no vault there is no request that could have answered — and a vault outside the
    run's scope is invisible from here rather than absent."""
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, gaps = run(port, resources=[record("prod-web-01")])

    assert port.replication_calls == []
    assert REPLICATION_ABSENT_GAP_TYPE not in {gap["gap_type"] for gap in gaps}
    assert "replication_health" not in {fact["key"] for fact in facts}


def test_one_list_is_issued_per_vault_in_the_inventory() -> None:
    machine = record("prod-web-01")
    vaults = [
        record("vault-a", resource_type=RECOVERY_SERVICES_VAULT_TYPE),
        record("vault-b", resource_type=RECOVERY_SERVICES_VAULT_TYPE),
    ]
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        replication_responses=[empty_fact_list(), empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    _, gaps = run(port, resources=[machine, *vaults])

    assert [call["vault_id"] for call in port.replication_calls] == [
        vault["resource_id"] for vault in vaults
    ]
    assert REPLICATION_ABSENT_GAP_TYPE in {gap["gap_type"] for gap in gaps}


def test_a_replicated_vm_records_its_health_from_the_fabric_object_id() -> None:
    machine = record("prod-web-01")
    vault = record("vault-a", resource_type=RECOVERY_SERVICES_VAULT_TYPE)
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        replication_responses=[
            RawHttpResponse(
                status=200, headers={}, body={"value": [replication_item(machine)]}
            )
        ],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, gaps = run(port, resources=[machine, vault])

    health = [fact for fact in facts if fact["key"] == "replication_health"]
    assert [fact["value"] for fact in health] == ["Normal"]
    assert REPLICATION_ABSENT_GAP_TYPE not in {gap["gap_type"] for gap in gaps}


def test_one_unreadable_vault_makes_replication_unavailable_rather_than_absent() -> None:
    """A partial listing cannot tell "this VM is not replicated" from "the vault protecting it
    is the one that failed", so the honest outcome for every covered resource is
    `fact_unavailable` — not a mixture of one true gap and one false one."""
    machine = record("prod-web-01")
    vaults = [
        record("vault-a", resource_type=RECOVERY_SERVICES_VAULT_TYPE),
        record("vault-b", resource_type=RECOVERY_SERVICES_VAULT_TYPE),
    ]
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        replication_responses=[RawHttpResponse(status=500, headers={}, body=None)],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    _, gaps = run(port, resources=[machine, *vaults])

    health = [gap for gap in gaps if gap["metric"] == "replication_health"]
    assert {gap["gap_type"] for gap in health} == {GAP_TYPE_FACT_UNAVAILABLE}
    assert REPLICATION_ABSENT_GAP_TYPE not in {gap["gap_type"] for gap in gaps}
    # The second vault is not asked once the first failed: the answer is already unusable.
    assert len(port.replication_calls) == 1


# --------------------------------------------------------------------------- #
# Req 4.7 — the projectable half, from pages already paged
# --------------------------------------------------------------------------- #


def test_a_projected_column_becomes_a_fact_with_no_request_of_its_own() -> None:
    machine = record("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, _ = run(
        port,
        resources=[machine],
        pages=[fact_page(page(row(machine, os_type="Linux", data_disk_count="2")))],
    )

    projected = {
        fact["key"]: fact for fact in facts if fact["source"] == "resource_graph"
    }
    assert projected["os_type"]["value"] == "Linux"
    assert projected["os_type"]["value_kind"] == "text"
    assert projected["data_disk_count"]["value"] == "2"
    assert projected["data_disk_count"]["value_kind"] == "numeric"
    assert projected["data_disk_count"]["unit"] == "count"


def test_a_resource_on_a_later_page_records_no_absence_from_an_earlier_one() -> None:
    """Each page is folded against the ids **that page** names. Folding every page against
    every resource would record one `fact_unavailable` per projectable key for every resource
    on every other page — a paged inventory would produce gaps quadratic in its page count."""
    first = record("prod-web-01")
    second = record("prod-web-02")
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    _, gaps = run(
        port,
        resources=[first, second],
        pages=[
            fact_page(
                page(
                    row(
                        first,
                        os_type="Linux",
                        provisioning_state="Succeeded",
                        vm_size="x",
                        data_disk_count="1",
                    )
                )
            ),
            fact_page(
                page(
                    row(
                        second,
                        os_type="Linux",
                        provisioning_state="Succeeded",
                        vm_size="x",
                        data_disk_count="1",
                    )
                )
            ),
        ],
    )

    assert [gap for gap in gaps if gap["source"] == "resource_graph"] == []


def test_a_page_naming_no_resource_is_skipped_rather_than_folded() -> None:
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, gaps = run(port, resources=[record("prod-web-01")], pages=[fact_page(page()), fact_page({}), fact_page(None)])

    assert [fact for fact in facts if fact["source"] == "resource_graph"] == []
    assert [gap for gap in gaps if gap["source"] == "resource_graph"] == []


# --------------------------------------------------------------------------- #
# Req 4.1, 5.4 — the two bounds are a collection outcome, not a snapshot refusal
# --------------------------------------------------------------------------- #


def test_the_two_bounds_are_the_ones_the_requirement_declares() -> None:
    assert (MAX_FACT_KEY_LENGTH, MAX_FACT_VALUE_LENGTH) == (120, 512)


def test_a_value_at_the_bound_is_kept_and_one_past_it_is_a_gap() -> None:
    """Req 5.4 — an over-long value is `fact_unavailable`, so it costs one cell.

    Reaching `collect/snapshot.py` with it instead would raise there and write **no snapshot
    object**, losing the whole run over one long string a source really did return.
    """
    machine = record("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[
            RawHttpResponse(
                status=200,
                headers={},
                body={"value": [backup_item(machine, status="x" * MAX_FACT_VALUE_LENGTH)]},
            )
        ],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, gaps = run(port, resources=[machine])
    assert any(fact["key"] == "last_backup_status" for fact in facts)
    assert not any(gap["metric"] == "last_backup_status" for gap in gaps)

    port = FakeFactsPort(
        backup_responses=[
            RawHttpResponse(
                status=200,
                headers={},
                body={
                    "value": [
                        backup_item(machine, status="x" * (MAX_FACT_VALUE_LENGTH + 1))
                    ]
                },
            )
        ],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, gaps = run(port, resources=[machine])
    assert not any(fact["key"] == "last_backup_status" for fact in facts)
    over_long = [gap for gap in gaps if gap["metric"] == "last_backup_status"]
    assert [gap["gap_type"] for gap in over_long] == [GAP_TYPE_FACT_UNAVAILABLE]
    assert str(MAX_FACT_VALUE_LENGTH) in over_long[0]["message"]


# --------------------------------------------------------------------------- #
# Req 4.9 — one budget of eight, shared with the metric requests
# --------------------------------------------------------------------------- #


def test_every_source_request_is_taken_through_the_supplied_semaphore() -> None:
    """The seam Req 4.9 is about, observed rather than asserted from the wiring: a collector
    holding a semaphore it never acquires would satisfy every other test in this file."""
    machine = record("prod-web-01")
    vault = record("vault-a", resource_type=RECOVERY_SERVICES_VAULT_TYPE)
    semaphore = asyncio.Semaphore(1)

    depths: list[int] = []

    class Counting(FakeFactsPort):
        async def list_backup_protected_items(self, *, subscription_id: str) -> Any:
            depths.append(semaphore._value)
            return await super().list_backup_protected_items(
                subscription_id=subscription_id
            )

        async def list_replication_protected_items(self, *, vault_id: str) -> Any:
            depths.append(semaphore._value)
            return await super().list_replication_protected_items(vault_id=vault_id)

        async def list_reservations(self) -> Any:
            depths.append(semaphore._value)
            return await super().list_reservations()

    port = Counting(
        backup_responses=[empty_fact_list()],
        replication_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    run(port, resources=[machine, vault], semaphore=semaphore)

    assert len(depths) == 3, depths
    # A semaphore of one, held across each call, means every observation is at zero.
    assert set(depths) == {0}


def test_the_shared_budget_is_the_metric_collectors_own_object() -> None:
    """`azure/provider.py` hands over `MetricsCollector.semaphore_for(...)`, so a fact request
    and a metric request share one budget of eight. Two semaphores of eight would be sixteen
    in flight while satisfying every assertion either could make about itself."""
    from reporting_agent.azure.metrics import MetricsCollector
    from reporting_agent.azure.regions import RegionResolver

    metrics = MetricsCollector(
        region_resolver=RegionResolver(port=None),  # type: ignore[arg-type]
        archive_writer=ArchiveWriter(store=InMemoryObjectStore()),
    )
    first = metrics.semaphore_for(SUBSCRIPTION)
    assert metrics.semaphore_for(SUBSCRIPTION) is first
    assert first._value == MAX_CONCURRENCY_PER_SUBSCRIPTION
    assert metrics.semaphore_for("other-subscription") is not first


# --------------------------------------------------------------------------- #
# Req 5.7 — the exemption in `tests/test_boundaries.py` is backed by behaviour
# --------------------------------------------------------------------------- #


def test_a_leaf_that_does_not_parse_still_reaches_a_typed_gap() -> None:
    """The behavioural backing for `FACT_PATH_HANDLER_EXEMPTIONS`' `decimal_leaf` entry.

    That handler returns `None` rather than recording a gap, which the static rule would
    otherwise report. The exemption is sound only because the caller is obliged to classify
    that `None` — so this asserts the obligation is met rather than trusting the comment.
    """
    machine = record("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, gaps = run(
        port,
        resources=[machine],
        pages=[fact_page(page(row(machine, data_disk_count="not-a-number")))],
    )

    assert not any(fact["key"] == "data_disk_count" for fact in facts)
    unusable = [gap for gap in gaps if gap["metric"] == "data_disk_count"]
    assert [gap["gap_type"] for gap in unusable] == [GAP_TYPE_FACT_UNAVAILABLE]
    assert unusable[0]["source"] == "resource_graph"


# --------------------------------------------------------------------------- #
# Purity of the surrounding claims
# --------------------------------------------------------------------------- #


def test_a_collected_at_is_rfc3339_utc_with_whole_second_precision() -> None:
    machine = record("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[
            RawHttpResponse(status=200, headers={}, body={"value": [backup_item(machine)]})
        ],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, _ = run(port, resources=[machine])

    for fact in facts:
        assert fact["collected_at"].endswith("Z")
        assert "." not in fact["collected_at"]
        assert len(fact["collected_at"]) == len("2026-07-31T18:04:00Z")


def test_the_collector_records_no_gap_for_a_source_the_type_does_not_declare() -> None:
    """Req 5.9 — a gap states that a fact the type declares is absent, not that a fact the
    type never had is absent. Without it every storage account collects `no_reservations`.

    Written as "declares none" while a storage account declared no facts at all. It now
    declares Advisor's three, because Advisor recommends across every type rather than a
    fixed tuple — so the property is stated against the **sources the type does not
    declare**, which is what it was always about.
    """
    storage = record("store01", resource_type="Microsoft.Storage/storageAccounts")
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    _, gaps = run(port, resources=[storage])

    mine = [gap for gap in gaps if gap["resource_id"] == storage["resource_id"]]
    assert [gap["source"] for gap in mine] == [SOURCE_ADVISOR] * 3
    assert {gap["metric"] for gap in mine} == {"category", "impact", "recommendation"}


@pytest.mark.parametrize("source", [SOURCE_RECOVERY_SERVICES, SOURCE_CAPACITY])
def test_every_gap_names_its_source_and_its_key(source: str) -> None:
    """Req 5.10 — the `(resource_id, metric)` grouping the gap surface uses is only defined
    for a fact gap if both are present, and `record_gap` refuses an absent `source` for one of
    the four fact gap types."""
    machine = record("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    _, gaps = run(port, resources=[machine])

    for gap in of_source(gaps, source):
        assert gap["resource_id"] == machine["resource_id"]
        assert gap["metric"]
        assert gap["source"] == source


# --------------------------------------------------------------------------- #
# The pipeline seam — a fact reaches the snapshot, or nothing does
# --------------------------------------------------------------------------- #


def test_a_provider_with_no_fact_surface_collects_nothing_and_issues_no_request() -> None:
    """Req 4.12 — an empty `facts` collection is an ordinary canonical form, so a provider
    that cannot collect one is not a provider that has to fail. The same shape
    `_resolve_fidelity` takes against `GuestCounterProvider`."""
    from reporting_agent.collect.pipeline import _collect_facts

    class Bare:
        """Conforms to `Provider` and to nothing else."""

        async def discover(self, scope: Any) -> Any: ...  # pragma: no cover
        async def collect(self, request: Any) -> Any: ...  # pragma: no cover
        def capabilities(self) -> Any: ...  # pragma: no cover

    plan = _plan()
    facts, gaps = asyncio.run(
        _collect_facts(
            provider=Bare(),  # type: ignore[arg-type]
            plan=plan,
            resources=[record("prod-web-01")],
            discovered={"resources": [], "gaps": []},
        )
    )
    assert facts == {}
    assert gaps == []


def test_the_pipeline_turns_each_record_into_a_fact_entry_keyed_by_resource() -> None:
    """The seam between the provider's plain data and the Snapshot_Builder's frozen shape.

    Nothing is defaulted on the way: `FactEntry.__post_init__` is the gate, and a record with
    no source or an unparseable numeric value raises there and writes **no** snapshot object
    (Req 4.4) rather than reaching the document as a plausible string.
    """
    from reporting_agent.collect.pipeline import _collect_facts

    machine = record("prod-web-01")

    class WithFacts:
        async def discover(self, scope: Any) -> Any: ...  # pragma: no cover
        async def collect(self, request: Any) -> Any: ...  # pragma: no cover
        def capabilities(self) -> Any: ...  # pragma: no cover

        async def collect_facts(self, request: Any) -> Any:
            assert request["subscription_id"] == SUBSCRIPTION
            assert request["inventory_pages"] == [{"data": []}]
            return {
                "facts": [
                    FactRecord(
                        resource_id=machine["resource_id"],
                        key="os_type",
                        value="Linux",
                        value_kind="text",
                        source="resource_graph",
                        collected_at="2026-08-01T09:30:15Z",
                        unit=None,
                    )
                ],
                "gaps": [],
            }

    facts, gaps = asyncio.run(
        _collect_facts(
            provider=WithFacts(),  # type: ignore[arg-type]
            plan=_plan(),
            resources=[machine],
            discovered={"resources": [], "gaps": [], "inventory_pages": [{"data": []}]},
        )
    )

    assert gaps == []
    entries = facts[machine["resource_id"]]
    assert [entry.key for entry in entries] == ["os_type"]
    # `formatted` equals `value` character for character: a fact carries no unit suffix and no
    # grouping, so a second spelling here would be a second display path.
    assert entries[0].formatted == entries[0].value == "Linux"
    assert entries[0].unit is None


def test_a_record_with_no_source_raises_rather_than_being_defaulted() -> None:
    """Req 4.4 — a fact whose provenance is absent is an assertion, not an observation, and no
    snapshot object is written for one."""
    from reporting_agent.collect.pipeline import fact_from_plain
    from reporting_agent.collect.snapshot import FactEntryError

    with pytest.raises(FactEntryError) as caught:
        fact_from_plain(
            FactRecord(
                resource_id=resource_id("prod-web-01"),
                key="os_type",
                value="Linux",
                value_kind="text",
                source="",
                collected_at="2026-08-01T09:30:15Z",
                unit=None,
            )
        )
    assert caught.value.key == "os_type"


def test_every_resource_carries_a_facts_collection_including_an_empty_one() -> None:
    """Req 4.10, 4.12 — a resource whose statistics are absent still carries its
    configuration, and a resource with no fact carries `()` rather than an absent key."""
    from reporting_agent.collect.pipeline import _resource_snapshots
    from reporting_agent.collect.snapshot import FactEntry

    stopped = record("stopped-01")
    other = record("prod-web-02")
    entry = FactEntry(
        key="os_type",
        value="Linux",
        value_kind="text",
        source="resource_graph",
        collected_at="2026-08-01T09:30:15Z",
        formatted="Linux",
    )

    built = _resource_snapshots(
        plan=_plan(),
        resources=[stopped, other],
        statistics={},
        day_statistics={},
        capacities={},
        tiers={},
        guest_entries={},
        facts_by_resource={stopped["resource_id"]: (entry,)},
    )

    by_id = {snapshot.record["resource_id"]: snapshot for snapshot in built}
    assert by_id[stopped["resource_id"]].statistics == ()
    assert by_id[stopped["resource_id"]].facts == (entry,)
    assert by_id[other["resource_id"]].facts == ()
    for snapshot in built:
        assert "facts" in snapshot.to_plain_data()


def _plan() -> Any:
    """The smallest `RunPlan` the two helpers above read: a scope, a zone and a window."""
    from reporting_agent.collect.buckets import resolve_window
    from reporting_agent.collect.pipeline import RunPlan
    from reporting_agent.providers.base import ScopeSpec

    jakarta = ZoneInfo("Asia/Jakarta")
    return RunPlan(
        actor_id="usr_01HQZX8QW9K7YB4T2C3M5N6P7Q",
        run_id="run_01HQZX8QW9K7YB4T2C3M5N6P7Q",
        subscription_id=SUBSCRIPTION,
        scope=ScopeSpec(
            subscription_id=SUBSCRIPTION,
            resource_types=[VM_TYPE],
            resource_groups=[],
            tag_filters={},
        ),
        timezone_name="Asia/Jakarta",
        tz=jakarta,
        window=resolve_window(date(2026, 7, 1), date(2026, 7, 31), jakarta),
        grain="PT1H",
        fidelity_ceiling="baseline",
        workspace_id=None,
        scope_verified=True,
    )


# --------------------------------------------------------------------------- #
# The seven assertions the first mutation pass found missing
# --------------------------------------------------------------------------- #

ARM_FORBIDDEN_BODY: Final[dict[str, Any]] = {
    "error": {
        "code": "AuthorizationFailed",
        "message": "The client does not have authorization to perform action.",
    }
}
"""A real ARM rejection's body, which is an error envelope and **not** empty.

Scripting `body=None` for a rejection hides the failure that matters: a reader folding
`response.body` whatever the status finds no `value` array in this, reads it as a list naming
nothing, and records the absence gap instead of `fact_unavailable`. The check has to be on the
**status**, and only a fixture carrying a body can tell the two implementations apart.
"""


def test_a_rejected_backup_list_carrying_an_error_body_is_still_unavailable() -> None:
    machine = record("prod-web-01")
    port = FakeFactsPort(
        backup_responses=[
            RawHttpResponse(status=403, headers={}, body=ARM_FORBIDDEN_BODY)
        ],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    _, gaps = run(port, resources=[machine])

    recovery = of_source(gaps, SOURCE_RECOVERY_SERVICES)
    assert {gap["gap_type"] for gap in recovery} == {GAP_TYPE_FACT_UNAVAILABLE}
    assert BACKUP_ABSENT_GAP_TYPE not in {gap["gap_type"] for gap in gaps}


def test_a_rejected_vault_list_carrying_an_error_body_is_still_unavailable() -> None:
    machine = record("prod-web-01")
    vault = record("vault-a", resource_type=RECOVERY_SERVICES_VAULT_TYPE)
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        replication_responses=[
            RawHttpResponse(status=403, headers={}, body=ARM_FORBIDDEN_BODY)
        ],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    _, gaps = run(port, resources=[machine, vault])

    health = [gap for gap in gaps if gap["metric"] == "replication_health"]
    assert {gap["gap_type"] for gap in health} == {GAP_TYPE_FACT_UNAVAILABLE}


def test_each_page_is_stamped_with_its_own_receipt_instant() -> None:
    """Req 4.3, 4.13 — a fact's `collected_at` is when **its** response was received.

    Two pages arrive at two instants, and one instant for both would be a clock default
    presented as an observation.

    ## This test used to assert only that the two stamps differ, and that was not enough

    A fold that read its own clock once per page also produces two different values, so
    the distinctness assertion passed while every stamp was the instant the *fold* ran
    rather than the instant the page arrived. On a run where the fold crossed a second
    boundary, all 29 facts were one second later than the archived page said and the
    replay reported `REPLAY_MISMATCH` on a reproducible snapshot.

    So it now asserts the stamps **are** the pages' receipt instants, by name. The clock
    is handed to the collector and would tick if anything still read it — a fold-time
    read would produce `09:30:00Z`/`09:30:01Z` instead of the two instants below and fail
    on the equality rather than on the difference.
    """
    first = record("prod-web-01")
    second = record("prod-web-02")

    first_received = "2026-08-01T09:30:00Z"
    second_received = "2026-08-01T09:31:17Z"

    ticks = iter(
        datetime(2026, 8, 1, 12, 0, 0, tzinfo=UTC) + timedelta(seconds=index)
        for index in range(20)
    )

    port = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    collect_facts = FactCollector(
        port,
        ArchiveWriter(store=InMemoryObjectStore()),
        declaration=CATALOG.facts,
        semaphore=asyncio.Semaphore(8),
        # Deliberately hours away from either receipt instant, so a fold-time read is not
        # merely a near miss but an unmistakable one.
        clock=lambda: next(ticks),
    )
    result = asyncio.run(
        collect_facts.collect(
            resources=[first, second],
            inventory_pages=[
                fact_page(page(row(first, os_type="Linux")), received_at=first_received),
                fact_page(
                    page(row(second, os_type="Windows")), received_at=second_received
                ),
            ],
            subscription_id=SUBSCRIPTION,
        )
    )

    stamps = {
        fact["resource_id"]: fact["collected_at"]
        for fact in result.facts
        if fact["key"] == "os_type"
    }
    assert len(stamps) == 2
    assert stamps[first["resource_id"]] == first_received
    assert stamps[second["resource_id"]] == second_received


def test_the_covered_type_match_folds_case_in_both_directions() -> None:
    """Resource Graph lower-cases `type` in its response body while the covered set carries
    the catalog's mixed-case spelling, so an exact comparison in **either** direction covers
    nothing on every real subscription."""
    from reporting_agent.azure.facts import BACKUP_COVERED_RESOURCE_TYPES as covered

    declared_spelling = record("prod-web-01")
    declared_spelling = ResourceRecord(
        **{**declared_spelling, "resource_type": covered[0]}
    )
    port = FakeFactsPort(
        backup_responses=[
            RawHttpResponse(
                status=200,
                headers={},
                body={"value": [backup_item(declared_spelling)]},
            )
        ],
        reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
    )
    facts, _ = run(port, resources=[declared_spelling])

    assert declared_spelling["resource_type"] != declared_spelling["resource_type"].lower()
    assert {fact["key"] for fact in of_source(facts, SOURCE_RECOVERY_SERVICES)} == set(
        BACKUP_KEYS
    )


def test_the_concurrency_cap_is_the_eight_the_requirement_names() -> None:
    """Pinned as a literal. Asserting a semaphore's capacity **equals the constant** moves
    with the constant and would pass at sixteen."""
    assert MAX_CONCURRENCY_PER_SUBSCRIPTION == 8


def test_the_inventory_collector_retains_the_pages_a_projection_made_fact_bearing() -> None:
    """Req 4.7's other half: the pages the fact pass folds are the pages the run **already**
    paged. Asserted through `InventoryCollector.discover` rather than by handing pages to the
    collector directly, because a `discover` that discarded them would satisfy every test that
    supplies its own."""
    from fakes.azure_ports import FakeInventoryPort
    from reporting_agent.azure.inventory import InventoryCollector

    machine = record("prod-web-01")
    body = page(row(machine, os_type="Linux"))

    with_projection = InventoryCollector(
        FakeInventoryPort([RawHttpResponse(status=200, headers={}, body=body)])
    )
    retained = asyncio.run(
        with_projection.discover(
            subscription_id=SUBSCRIPTION,
            resource_types=(VM_TYPE,),
            fidelity_tier="baseline",
            fact_projections=(("os_type", "tostring(properties.osType)"),),
        )
    )
    # The body is retained, paired with the instant the page was received. Compared as
    # two assertions rather than one equality against a hardcoded record, because the
    # instant comes from the collector's own clock here — what matters is that the body
    # survived and that an instant travelled with it. That the instant is the *archived*
    # one is asserted by `test_a_fact_fold_after_the_receipt_second_replays_identically`.
    pages_retained = retained.get("inventory_pages") or []
    assert [entry["body"] for entry in pages_retained] == [body]
    assert all(entry["received_at"] for entry in pages_retained)

    without = InventoryCollector(
        FakeInventoryPort([RawHttpResponse(status=200, headers={}, body=body)])
    )
    plain = asyncio.run(
        without.discover(
            subscription_id=SUBSCRIPTION,
            resource_types=(VM_TYPE,),
            fidelity_tier="baseline",
        )
    )
    # No projection means no fact-bearing page, so nothing is held: the memory cost is
    # exactly the cost of the feature that needs it.
    assert plain.get("inventory_pages") == []


def test_a_value_carrying_surrounding_whitespace_is_recorded_verbatim() -> None:
    """`formatted` equals `value` **character for character** (Req 4.1's one-display-path
    invariant). A `.strip()` anywhere on this path is a second display form, and the verifier
    would then have two strings to choose between for one cell."""
    from reporting_agent.collect.pipeline import fact_from_plain

    entry = fact_from_plain(
        FactRecord(
            resource_id=resource_id("prod-web-01"),
            key="last_backup_status",
            value="Completed ",
            value_kind="text",
            source=SOURCE_RECOVERY_SERVICES,
            collected_at="2026-08-01T09:30:15Z",
            unit=None,
        )
    )
    assert entry.value == "Completed "
    assert entry.formatted == entry.value


def test_the_fact_pass_waits_on_the_metric_collectors_own_semaphore() -> None:
    """Req 4.9, observed end to end: drain the **metrics** budget and the fact pass cannot
    proceed. A collector handed a second semaphore of its own would sail through, and every
    assertion about `semaphore_for` in isolation would still pass."""
    from fakes.azure_ports import (
        FakeDefinitionsPort,
        FakeInventoryPort,
        FakeMetricsPort,
        FakeSkuPort,
    )
    from reporting_agent.azure.provider import provider_over_ports
    from reporting_agent.providers.base import FactRequest

    machine = record("prod-web-01")
    provider = provider_over_ports(
        inventory_port=FakeInventoryPort([]),
        sku_port=FakeSkuPort([]),
        definitions_port=FakeDefinitionsPort([]),
        metrics_port=FakeMetricsPort(),
        facts_port=FakeFactsPort(
            backup_responses=[empty_fact_list()],
            reservation_responses=[empty_fact_list()],
        advisor_responses=[empty_fact_list()],
        ),
        object_store=InMemoryObjectStore(),
        actor_id="usr_01HQZX8QW9K7YB4T2C3M5N6P7Q",
        run_id="run_01HQZX8QW9K7YB4T2C3M5N6P7Q",
        catalog=CATALOG,
    )

    async def go() -> bool:
        semaphore = provider.metrics.semaphore_for(SUBSCRIPTION)
        for _ in range(MAX_CONCURRENCY_PER_SUBSCRIPTION):
            await semaphore.acquire()
        request = FactRequest(
            resources=[machine], inventory_pages=[], subscription_id=SUBSCRIPTION
        )
        task = asyncio.ensure_future(provider.collect_facts(request))
        done, pending = await asyncio.wait({task}, timeout=0.05)
        for _ in range(MAX_CONCURRENCY_PER_SUBSCRIPTION):
            semaphore.release()
        await asyncio.wait(pending, timeout=1.0)
        if not task.done():  # pragma: no cover - the release above completes it
            task.cancel()
        return not done

    assert asyncio.run(go()), (
        "the fact pass completed while the metric budget was fully held, so it is not "
        "sharing that semaphore"
    )
