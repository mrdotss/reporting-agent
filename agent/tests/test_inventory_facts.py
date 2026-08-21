"""Projected fact columns, and the archived inventory page (Req 4.7, 7.1, 7.2).

## What this covers and why each part needs its own assertion

**The query.** A projected fact is a `fact_<key> = <projection>` term appended to the
`project` clause. Two properties are load-bearing and neither is visible from the other:
the terms are ordered by key, so two runs over one declaration build the identical query;
and every one is prefixed, so no fact key can shadow one of the eight inventory columns.
A declaration naming its key `name` or `sku` would otherwise overwrite the resource's own
identity and the row would look complete.

**The archive.** An inventory page becomes a *fact-producing* response the moment the query
projects a fact, and criterion 7.1 requires a fact-producing response to be archived in the
pass that folds it. The condition is therefore the **projection**, not the writer: with no
projection the response produces no fact, every other field it carries is on the snapshot
already, and archiving it would add an object per page that a replay folds nothing from.

**The shared writer.** The inventory pages and the metric responses go through one
`ArchiveWriter`, because the snapshot records one `raw_archive.object_count` and a replay
refuses to proceed when the objects supplied and the objects the sequence names differ. Two
writers would keep two sequences and two counts. Asserted by checking that the sequence
numbers interleave rather than restart.
"""

from __future__ import annotations

import asyncio
import gzip
import json
from datetime import UTC, datetime
from typing import Any

import pytest

from fakes.azure_ports import FakeInventoryPort
from fakes.object_store import InMemoryObjectStore
from reporting_agent.azure.clients import FACT_FIELD_PREFIX, inventory_query
from reporting_agent.azure.inventory import (
    RESOURCE_GRAPH_REQUEST_TARGET,
    RESOURCE_GRAPH_SOURCE,
    InventoryArchiveContext,
    InventoryCollector,
)
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.collect.archive import (
    ARCHIVE_KIND_INVENTORY,
    ARCHIVE_KIND_METRICS,
    ARCHIVE_SCHEMA_VERSION,
    ArchiveWriter,
    archive_kind_of,
)
from reporting_agent.collect.log import GAP_TYPE_ARCHIVE_WRITE_FAILED
from reporting_agent.storage.base import ObjectStore

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
ACTOR_ID = "user_01HQZZZZZZZZZZZZZZZZZZZZZZ"
RUN_ID = "run_01HQZZZZZZZZZZZZZZZZZZZZZZ"
CATALOG_VERSION = "1.1.0"
VM_TYPE = "Microsoft.Compute/virtualMachines"
RECEIVED_AT = datetime(2026, 8, 1, 9, 30, 15, tzinfo=UTC)

OS_TYPE = ("os_type", "tostring(properties.storageProfile.osDisk.osType)")
VM_SIZE = ("vm_size", "tostring(properties.hardwareProfile.vmSize)")
DISKS = ("data_disk_count", "tostring(array_length(properties.storageProfile.dataDisks))")


def resource_id(name: str) -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


def page(*names: str, skip_token: str | None = None) -> RawHttpResponse:
    body: dict[str, Any] = {
        "totalRecords": len(names),
        "count": len(names),
        "data": [
            {
                "id": resource_id(name),
                "name": name,
                "type": "microsoft.compute/virtualmachines",
                "location": "southeastasia",
                "resourceGroup": "rg-prod",
                "tags": {"env": "prod"},
                "sku": "Standard_D2s_v5",
                "powerState": "PowerState/running",
                "fact_os_type": "Windows",
                "fact_vm_size": "Standard_D2s_v5",
            }
            for name in names
        ],
    }
    if skip_token is not None:
        # `skipToken`, not `$skipToken`: Resource Graph names it with the `$` on the wire
        # and `ArmInventoryPort` normalizes the key, so the collector only ever sees this
        # spelling. A fixture using the wire spelling silently ends the paging loop after
        # one page — which is how this helper was wrong the first time.
        body["skipToken"] = skip_token
    return RawHttpResponse(status=200, headers={}, body=body)


def collector(port: FakeInventoryPort) -> InventoryCollector:
    async def no_wait(seconds: float) -> None:
        del seconds

    return InventoryCollector(port, sleep=no_wait, now=lambda: RECEIVED_AT)


def context(writer: ArchiveWriter) -> InventoryArchiveContext:
    return InventoryArchiveContext(
        writer=writer,
        actor_id=ACTOR_ID,
        run_id=RUN_ID,
        catalog_version=CATALOG_VERSION,
    )


def archived_documents(store: ObjectStore) -> list[dict[str, Any]]:
    return [
        json.loads(gzip.decompress(store.get(key).body).decode("utf-8"))  # type: ignore[union-attr]
        for key in sorted(key for key in store.keys() if "/raw/" in key)
    ]


def discover(
    port: FakeInventoryPort,
    *,
    fact_projections: tuple[tuple[str, str], ...] = (),
    archive: InventoryArchiveContext | None = None,
):
    return asyncio.run(
        collector(port).discover(
            subscription_id=SUBSCRIPTION,
            resource_types=(VM_TYPE,),
            fidelity_tier="baseline",
            fact_projections=fact_projections,
            archive=archive,
        )
    )


# --- the query (Req 4.7) -------------------------------------------------------------


def test_each_projection_becomes_one_prefixed_project_term() -> None:
    query = inventory_query(
        [VM_TYPE], subscription_id=SUBSCRIPTION, fact_projections=[OS_TYPE, VM_SIZE]
    )

    assert f", {FACT_FIELD_PREFIX}os_type = {OS_TYPE[1]}" in query
    assert f", {FACT_FIELD_PREFIX}vm_size = {VM_SIZE[1]}" in query
    assert query.rstrip().endswith("| order by id asc")


def test_the_terms_are_ordered_by_key_whatever_order_they_were_declared_in() -> None:
    """Two runs over one declaration must build one identical query. The query is not
    hashed, but it is what a support case quotes and what a recorded fixture carries, and
    one that reorders itself between runs makes both useless."""
    ascending = inventory_query(
        [VM_TYPE], subscription_id=SUBSCRIPTION, fact_projections=[DISKS, OS_TYPE, VM_SIZE]
    )
    descending = inventory_query(
        [VM_TYPE], subscription_id=SUBSCRIPTION, fact_projections=[VM_SIZE, OS_TYPE, DISKS]
    )

    assert ascending == descending
    positions = [
        ascending.index(f"{FACT_FIELD_PREFIX}{key}") for key, _ in (DISKS, OS_TYPE, VM_SIZE)
    ]
    assert positions == sorted(positions)


def test_no_projection_leaves_the_query_byte_identical_to_the_one_before_facts() -> None:
    assert inventory_query(
        [VM_TYPE], subscription_id=SUBSCRIPTION, fact_projections=()
    ) == inventory_query([VM_TYPE], subscription_id=SUBSCRIPTION)


@pytest.mark.parametrize(
    "reserved", ["id", "name", "type", "location", "resourceGroup", "tags", "sku"]
)
def test_a_fact_key_named_like_an_inventory_column_cannot_shadow_it(reserved: str) -> None:
    """The prefix is what makes this safe, so assert the outcome rather than the prefix:
    a key spelled exactly like a projected column produces a *distinct* column, and the
    inventory field of that name is still projected unchanged."""
    query = inventory_query(
        [VM_TYPE],
        subscription_id=SUBSCRIPTION,
        fact_projections=[(reserved, "tostring(properties.somethingElse)")],
    )

    assert f"{FACT_FIELD_PREFIX}{reserved} = " in query
    assert f"\n          , {reserved} = " not in query
    # And the original column survives in the base projection.
    assert "| project id, name, type, location, resourceGroup, tags," in query


def test_the_projections_reach_the_port() -> None:
    """The wiring, asserted at the port rather than at the query builder: a `discover` that
    accepted projections and dropped them would pass every assertion above."""
    port = FakeInventoryPort([page("prod-web-01")])

    discover(port, fact_projections=(OS_TYPE, VM_SIZE))

    assert port.calls[0]["fact_projections"] == (OS_TYPE, VM_SIZE)


# --- the archived page (Req 7.1, 7.2) ------------------------------------------------


def test_a_page_carrying_a_projected_fact_is_archived() -> None:
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)
    port = FakeInventoryPort([page("prod-web-01", "prod-web-02")])

    result = discover(port, fact_projections=(OS_TYPE,), archive=context(writer))

    assert [gap["gap_type"] for gap in result["gaps"]] == []
    documents = archived_documents(store)
    assert len(documents) == 1
    assert writer.object_count == 1
    assert writer.archive_incomplete is False


def test_the_archived_page_carries_the_declared_shape() -> None:
    store = InMemoryObjectStore()
    port = FakeInventoryPort([page("prod-web-01")])

    discover(port, fact_projections=(OS_TYPE,), archive=context(ArchiveWriter(store=store)))

    document = archived_documents(store)[0]
    assert set(document) == {
        "schema_version",
        "kind",
        "sequence",
        "source",
        "request_target",
        "page_index",
        "skip_token_present",
        "received_at",
        "catalog_version",
        "resource_ids",
        "raw_response",
    }
    assert document["schema_version"] == ARCHIVE_SCHEMA_VERSION
    assert document["kind"] == ARCHIVE_KIND_INVENTORY
    assert document["sequence"] == 0
    assert document["source"] == RESOURCE_GRAPH_SOURCE
    assert document["request_target"] == RESOURCE_GRAPH_REQUEST_TARGET
    assert document["page_index"] == 0
    assert document["skip_token_present"] is False
    # From the injected clock, so a committed fixture never depends on the wall clock.
    assert document["received_at"] == "2026-08-01T09:30:15Z"
    assert document["catalog_version"] == CATALOG_VERSION
    assert document["resource_ids"] == [resource_id("prod-web-01")]
    assert document["raw_response"]["data"][0]["fact_os_type"] == "Windows"


def test_the_request_target_names_no_subscription() -> None:
    """An archived object should be interpretable without carrying an identifier the
    fixture guards exclude — the same discipline the metric-definition fixtures keep."""
    assert SUBSCRIPTION not in RESOURCE_GRAPH_REQUEST_TARGET
    assert RESOURCE_GRAPH_REQUEST_TARGET.startswith("/providers/")


def test_every_page_of_a_paged_sequence_is_archived_and_numbered() -> None:
    store = InMemoryObjectStore()
    port = FakeInventoryPort(
        [
            page("prod-web-01", skip_token="tok-1"),
            page("prod-web-02", skip_token="tok-2"),
            page("prod-web-03"),
        ]
    )

    discover(port, fact_projections=(OS_TYPE,), archive=context(ArchiveWriter(store=store)))

    documents = archived_documents(store)
    assert [document["page_index"] for document in documents] == [0, 1, 2]
    # The last page carries no continuation token, and the earlier two do — which is what
    # makes an archive readable as a complete sequence rather than a set of pages.
    assert [document["skip_token_present"] for document in documents] == [True, True, False]
    assert [document["sequence"] for document in documents] == [0, 1, 2]


def test_sorting_the_keys_equals_sorting_by_sequence() -> None:
    """A replay lists the run's `raw/` prefix and sorts the keys, so the two orders have to
    agree. A key leading with the source name instead of the sequence would interleave
    inventory pages among the metric objects alphabetically."""
    store = InMemoryObjectStore()
    port = FakeInventoryPort(
        [page("prod-web-01", skip_token="t"), page("prod-web-02")]
    )

    discover(port, fact_projections=(OS_TYPE,), archive=context(ArchiveWriter(store=store)))

    keys = sorted(key for key in store.keys() if "/raw/" in key)
    sequences = [archived_documents(store)[i]["sequence"] for i in range(len(keys))]
    assert sequences == sorted(sequences)


def test_a_page_with_no_projected_fact_is_not_archived() -> None:
    """Criterion 7.1's obligation is over fact-*producing* responses. With no projection
    this response produces none, every other field it carries is recorded on the snapshot,
    and an object a replay folds nothing from is a cost with no reader."""
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)
    port = FakeInventoryPort([page("prod-web-01")])

    discover(port, fact_projections=(), archive=context(writer))

    assert archived_documents(store) == []
    assert writer.object_count == 0


def test_a_page_with_no_usable_resource_id_archives_nothing() -> None:
    """The ordinary empty last page of a sequence. An object naming no resource would add
    to the run's count and a replay could attribute it to nothing."""
    store = InMemoryObjectStore()
    empty = RawHttpResponse(
        status=200, headers={}, body={"totalRecords": 0, "count": 0, "data": []}
    )
    port = FakeInventoryPort([empty])

    result = discover(port, fact_projections=(OS_TYPE,), archive=context(ArchiveWriter(store=store)))

    assert archived_documents(store) == []
    assert result["resources"] == []


def test_a_failed_write_records_a_gap_per_resource_and_keeps_the_records() -> None:
    """The same contract `write` holds: an inventory that cannot be archived is still an
    inventory that was collected."""

    class RefusingStore(InMemoryObjectStore):
        async def put_bytes(self, key, body, *, content_type=None, tags=None):  # type: ignore[override]
            raise RuntimeError("bucket refused the write")

    writer = ArchiveWriter(store=RefusingStore())
    port = FakeInventoryPort([page("prod-web-01", "prod-web-02")])

    result = discover(port, fact_projections=(OS_TYPE,), archive=context(writer))

    gaps = [gap for gap in result["gaps"] if gap["gap_type"] == GAP_TYPE_ARCHIVE_WRITE_FAILED]
    assert len(gaps) == 2
    assert {gap["resource_id"] for gap in gaps} == {
        resource_id("prod-web-01"),
        resource_id("prod-web-02"),
    }
    assert writer.archive_incomplete is True
    # The records survive: the page was folded regardless of the write.
    assert len(result["resources"]) == 2


# --- the kind dispatch (Req 7.2) -----------------------------------------------------


def test_an_object_declaring_no_kind_reads_as_metrics() -> None:
    """Every object written before this field existed is a metrics response, so absence is
    the metrics claim rather than an unknown — which is what makes the field additive."""
    assert archive_kind_of({"grouping_key": {}, "raw_response": {}}) == ARCHIVE_KIND_METRICS


def test_an_object_declaring_its_kind_reads_as_that_kind() -> None:
    assert archive_kind_of({"kind": ARCHIVE_KIND_INVENTORY}) == ARCHIVE_KIND_INVENTORY
    assert archive_kind_of({"kind": ARCHIVE_KIND_METRICS}) == ARCHIVE_KIND_METRICS


def test_an_unrecognised_kind_is_returned_rather_than_coerced() -> None:
    """Coercing it to `metrics` would fold a fact response as a metric one. A caller
    refuses it by name instead."""
    assert archive_kind_of({"kind": "something_later"}) == "something_later"


def test_the_dispatch_does_not_sniff_the_body() -> None:
    """An inventory page's body carries `data`, a metrics batch carries `values` and a
    fallback carries `value`. Shape-sniffing works until one of those is renamed or a new
    kind arrives resembling an old one — at which point a replay folds an object as the
    wrong kind and reports a mismatch on a reproducible snapshot.

    Asserted by handing the dispatcher a body of the *wrong* shape for its declared kind:
    the declaration wins.
    """
    assert (
        archive_kind_of({"kind": ARCHIVE_KIND_INVENTORY, "values": [{"resourceid": "x"}]})
        == ARCHIVE_KIND_INVENTORY
    )
    assert (
        archive_kind_of({"kind": ARCHIVE_KIND_METRICS, "data": [{"id": "x"}]})
        == ARCHIVE_KIND_METRICS
    )
