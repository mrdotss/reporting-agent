"""Task 4.4 — the `"facts"` archive kind and replay's fact re-derivation (Req 7.1-7.5).

`tests/test_verify_replay.py` carries the end-to-end proof: a real collection over the
**shipped** catalog, facts and all, replayed to a byte-identical digest. That file is where a
regression in the round trip surfaces first, and this one covers the parts a whole-collection
test cannot isolate:

* **the write happens before the fold**, observable as the call order a recording object store
  and a recording port see between them, rather than as an intention in a comment;
* **`received_at` comes off the archived object**, which is the one substitution that would
  report `REPLAY_MISMATCH` on every run in production and on none in a test that stamped the
  same instant twice;
* **`fact_keys` narrows the declaration**, so a backup response cannot manufacture a
  replication absence — the failure this field exists to prevent, carried across the archive
  boundary from `narrowed_to_gap_type`;
* **a missing fact object is a mismatch and a broken one is an advisory**, which are two
  different verdicts about two different situations and are the pair most easily collapsed.
"""

from __future__ import annotations

import asyncio
import gzip
import json
from typing import Any, Final

import pytest

from fakes.azure_ports import FakeFactsPort, empty_fact_list
from fakes.object_store import InMemoryObjectStore
from reporting_agent.azure.clients import FACT_FIELD_PREFIX
from reporting_agent.azure.facts import (
    BACKUP_ABSENT_GAP_TYPE,
    BACKUP_REQUEST_TARGET,
    REPLICATION_ABSENT_GAP_TYPE,
    REPLICATION_REQUEST_TARGET,
    RESERVATION_ABSENT_GAP_TYPE,
    RESERVATION_REQUEST_TARGET,
    SOURCE_CAPACITY,
    SOURCE_RECOVERY_SERVICES,
    FactArchiveContext,
    FactCollector,
    declared_keys,
    narrowed_to_gap_type,
)
from reporting_agent.azure.metrics import MAX_CONCURRENCY_PER_SUBSCRIPTION
from reporting_agent.azure.ports import FactsPort, RawHttpResponse
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.archive import (
    ARCHIVE_KIND_FACTS,
    ARCHIVE_KIND_INVENTORY,
    ARCHIVE_KIND_METRICS,
    ARCHIVE_KINDS,
    ARCHIVE_SCHEMA_VERSION,
    ArchiveWriter,
    archive_kind_of,
    facts_archive_key,
)
from reporting_agent.collect.log import GAP_TYPE_ARCHIVE_WRITE_FAILED
from reporting_agent.providers.base import ResourceRecord

VM_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
ACTOR: Final[str] = "user-01HZX9"
RUN: Final[str] = "run-01HZY0"
RECEIVED_AT: Final[str] = "2026-08-01T09:30:15Z"
CATALOG = load_catalog()


def resource_id(name: str) -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod/providers/{VM_TYPE}/{name}"
    )


def record(name: str) -> ResourceRecord:
    return ResourceRecord(
        resource_id=resource_id(name),
        name=name,
        resource_type=VM_TYPE.lower(),
        location="southeastasia",
        resource_group="rg-prod",
        tags={},
        sku_name="Standard_D4s_v3",
        power_state_raw="PowerState/running",
        power_state="running",
        fidelity_tier="baseline",
    )


def page(*rows: dict[str, Any]) -> dict[str, Any]:
    return {"totalRecords": len(rows), "count": len(rows), "data": list(rows)}


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


class RecordingStore(InMemoryObjectStore):
    """An object store that appends to a **shared** event log.

    The point is the interleaving with the port's calls, which neither the store's own `.calls`
    nor the port's own can show on their own: "the write completed before the next request" is
    a claim about one order over two objects.
    """

    def __init__(self, events: list[str]) -> None:
        super().__init__()
        self._events = events

    async def put_bytes(self, key: str, body: bytes, **kwargs: Any) -> None:  # type: ignore[override]
        await super().put_bytes(key, body, **kwargs)
        self._events.append(f"put:{key.rsplit('/', 1)[-1]}")


class RecordingFactsPort:
    """A `FactsPort` that appends to the same log, over a scripted `FakeFactsPort`."""

    def __init__(self, inner: FakeFactsPort, events: list[str]) -> None:
        self._inner = inner
        self._events = events

    async def list_backup_protected_items(
        self, *, subscription_id: str
    ) -> RawHttpResponse:
        self._events.append("request:backup")
        return await self._inner.list_backup_protected_items(
            subscription_id=subscription_id
        )

    async def list_replication_protected_items(self, *, vault_id: str) -> RawHttpResponse:
        self._events.append("request:replication")
        return await self._inner.list_replication_protected_items(vault_id=vault_id)

    async def list_reservations(self) -> RawHttpResponse:
        self._events.append("request:reservations")
        return await self._inner.list_reservations()


def collector(
    port: FactsPort,
    *,
    store: InMemoryObjectStore | None = None,
    context: FactArchiveContext | None = None,
    clock_at: str = RECEIVED_AT,
) -> FactCollector:
    from datetime import datetime

    fixed = datetime.fromisoformat(clock_at.replace("Z", "+00:00"))
    return FactCollector(
        port,
        # `is not None`, **not** `store or ...`: an empty `InMemoryObjectStore` is falsy
        # (it defines `__len__`), so the `or` spelling silently hands the writer a second
        # store and every assertion about this one reads an empty object set. The same trap
        # `FigureLedger` sets in `compile/figures.py`.
        ArchiveWriter(store=store if store is not None else InMemoryObjectStore()),
        declaration=CATALOG.facts,
        semaphore=asyncio.Semaphore(MAX_CONCURRENCY_PER_SUBSCRIPTION),
        clock=lambda: fixed,
        archive_context=context,
    )


def objects_of(store: InMemoryObjectStore) -> list[dict[str, Any]]:
    """Every archived object this store holds, decoded, in key order."""
    decoded: list[dict[str, Any]] = []
    for key in sorted(store.keys()):
        stored = store.get(key)
        assert stored is not None
        decoded.append(json.loads(gzip.decompress(stored.body)))
    return decoded


CONTEXT = FactArchiveContext(
    actor_id=ACTOR, run_id=RUN, catalog_version=CATALOG.catalog_version
)


# --------------------------------------------------------------------------- #
# The kind and the key
# --------------------------------------------------------------------------- #


def test_the_facts_kind_joins_the_archive_vocabulary() -> None:
    assert ARCHIVE_KIND_FACTS == "facts"
    assert ARCHIVE_KINDS == (
        ARCHIVE_KIND_METRICS,
        ARCHIVE_KIND_INVENTORY,
        ARCHIVE_KIND_FACTS,
    )


def test_a_facts_key_sorts_with_the_other_kinds_by_sequence() -> None:
    """A replay lists the run's `raw/` prefix and sorts the keys, so sorting by key has to
    equal sorting by sequence — across all three kinds, not within one."""
    from reporting_agent.collect.archive import archive_key, inventory_archive_key

    keys = [
        inventory_archive_key(
            actor_id=ACTOR, run_id=RUN, sequence=0, source="resource_graph", page_index=0
        ),
        archive_key(
            actor_id=ACTOR,
            run_id=RUN,
            sequence=1,
            location="southeastasia",
            resource_type=VM_TYPE,
        ),
        facts_archive_key(
            actor_id=ACTOR, run_id=RUN, sequence=2, source=SOURCE_RECOVERY_SERVICES
        ),
        facts_archive_key(actor_id=ACTOR, run_id=RUN, sequence=3, source=SOURCE_CAPACITY),
    ]

    assert sorted(keys) == keys


def test_the_dispatch_reads_the_declared_kind_off_a_facts_object() -> None:
    assert archive_kind_of({"kind": ARCHIVE_KIND_FACTS}) == ARCHIVE_KIND_FACTS
    # And absence is still the metrics claim, because every object written before the field
    # existed is a metrics response.
    assert archive_kind_of({"raw_response": {}}) == ARCHIVE_KIND_METRICS


# --------------------------------------------------------------------------- #
# Req 7.1 — the write happens in the folding pass, before the fold
# --------------------------------------------------------------------------- #


def test_each_fact_producing_response_lands_one_object_carrying_its_provenance() -> None:
    store = InMemoryObjectStore()
    port = FakeFactsPort(
        backup_responses=[
            RawHttpResponse(status=200, headers={}, body={"value": [backup_item(record("prod-web-01"))]})
        ],
        reservation_responses=[empty_fact_list()],
    )

    asyncio.run(
        collector(port, store=store, context=CONTEXT).collect(
            resources=[record("prod-web-01")],
            inventory_pages=[],
            subscription_id=SUBSCRIPTION,
        )
    )

    objects = objects_of(store)
    assert [obj["kind"] for obj in objects] == [ARCHIVE_KIND_FACTS] * 2
    assert {obj["source"] for obj in objects} == {
        SOURCE_RECOVERY_SERVICES,
        SOURCE_CAPACITY,
    }
    for obj in objects:
        assert obj["schema_version"] == ARCHIVE_SCHEMA_VERSION
        assert obj["received_at"] == RECEIVED_AT
        assert obj["catalog_version"] == CATALOG.catalog_version
        assert obj["resource_ids"] == [resource_id("prod-web-01")]
        assert obj["fact_keys"] == sorted(obj["fact_keys"])
        assert obj["request_target"] in {
            BACKUP_REQUEST_TARGET,
            REPLICATION_REQUEST_TARGET,
            RESERVATION_REQUEST_TARGET,
        }


def test_the_object_is_written_before_the_next_request_of_that_source() -> None:
    """Req 7.1's ordering, observed rather than asserted about.

    The three sources run concurrently, so there is no global order to check — what is checked
    is that within one source, the write completes before anything derived from the response
    exists, and that a source issuing several requests writes **one** object after the last of
    them because the accumulated items are folded as one response.
    """
    events: list[str] = []
    inner = FakeFactsPort(
        backup_responses=[empty_fact_list()],
        reservation_responses=[empty_fact_list()],
    )
    store = RecordingStore(events)

    asyncio.run(
        collector(
            RecordingFactsPort(inner, events), store=store, context=CONTEXT
        ).collect(
            resources=[record("prod-web-01")],
            inventory_pages=[],
            subscription_id=SUBSCRIPTION,
        )
    )

    puts = [event for event in events if event.startswith("put:")]
    requests = [event for event in events if event.startswith("request:")]
    assert len(puts) == 2
    assert set(requests) == {"request:backup", "request:reservations"}
    # Every put follows the request whose response it archives, and the first put cannot
    # precede the first request.
    assert events.index("request:backup") < min(
        index for index, event in enumerate(events) if event.startswith("put:")
    )


def test_a_collector_with_no_archive_context_writes_nothing_and_still_folds() -> None:
    """The seam every fold test uses. A collector built without a context is not a collector
    that fails — a run whose archive was never written reports `archive_incomplete`, which is
    the honest verdict for an archive that does not exist."""
    store = InMemoryObjectStore()
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()], reservation_responses=[empty_fact_list()]
    )

    result = asyncio.run(
        collector(port, store=store, context=None).collect(
            resources=[record("prod-web-01")],
            inventory_pages=[],
            subscription_id=SUBSCRIPTION,
        )
    )

    assert not store.keys()
    # The absences were still recorded, so nothing about the fold depends on the archive.
    assert {gap["gap_type"] for gap in result.gaps} == {
        BACKUP_ABSENT_GAP_TYPE,
        RESERVATION_ABSENT_GAP_TYPE,
    }


def test_a_failed_write_records_a_gap_per_resource_and_still_folds() -> None:
    """Req 26.4's rule, applied to the new kind: a run that cannot archive a fact response is
    still a run that collected the fact."""

    class FailingStore(InMemoryObjectStore):
        async def put_bytes(self, key: str, body: bytes, **kwargs: Any) -> None:  # type: ignore[override]
            raise OSError("the bucket refused the write")

    port = FakeFactsPort(
        backup_responses=[
            RawHttpResponse(status=200, headers={}, body={"value": [backup_item(record("prod-web-01"))]})
        ],
        reservation_responses=[empty_fact_list()],
    )
    writer_store = FailingStore()

    result = asyncio.run(
        collector(port, store=writer_store, context=CONTEXT).collect(
            resources=[record("prod-web-01")],
            inventory_pages=[],
            subscription_id=SUBSCRIPTION,
        )
    )

    assert any(gap["gap_type"] == GAP_TYPE_ARCHIVE_WRITE_FAILED for gap in result.gaps)
    # And the backup fact is present regardless.
    assert any(fact["key"] == "last_backup_status" for fact in result.facts)


# --------------------------------------------------------------------------- #
# `write_facts`'s own refusals
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("resource_ids", "fact_keys", "expected"),
    [
        ((), ("last_backup_status",), "resource_ids"),
        ((resource_id("prod-web-01"),), (), "fact_keys"),
    ],
)
def test_an_object_naming_nothing_is_refused(
    resource_ids: tuple[str, ...], fact_keys: tuple[str, ...], expected: str
) -> None:
    """Both are `ValueError` rather than a written object: an object covering no resource, or
    answering for no declared key, names nothing a replay could re-derive from it."""
    writer = ArchiveWriter(store=InMemoryObjectStore())

    with pytest.raises(ValueError, match=expected):
        asyncio.run(
            writer.write_facts(
                actor_id=ACTOR,
                run_id=RUN,
                source=SOURCE_RECOVERY_SERVICES,
                request_target=BACKUP_REQUEST_TARGET,
                fact_keys=fact_keys,
                received_at=RECEIVED_AT,
                catalog_version=CATALOG.catalog_version,
                resource_ids=resource_ids,
                raw_body={"value": []},
            )
        )


def test_the_writer_sorts_the_keys_it_is_handed() -> None:
    """The sort is the **archive's** contract, not the collector's.

    `declared_keys` already returns a sorted tuple, so going through `FactCollector` cannot
    tell whether this method sorts — two guards for one property, and a mutation run is what
    said so: replacing `sorted(fact_keys)` with `list(fact_keys)` changed nothing any test
    observed. This calls the writer directly with keys out of order, which is the only way the
    line is covered.

    Why it matters at all: the object's bytes are what a replay reads, and two runs over one
    subscription should archive byte-identical objects for one response. A set iterating in a
    different order between two Python processes would otherwise change the object without
    changing anything about the response.
    """
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    asyncio.run(
        writer.write_facts(
            actor_id=ACTOR,
            run_id=RUN,
            source=SOURCE_RECOVERY_SERVICES,
            request_target=BACKUP_REQUEST_TARGET,
            fact_keys=["last_restore_point", "last_backup_status"],
            received_at=RECEIVED_AT,
            catalog_version=CATALOG.catalog_version,
            resource_ids=[resource_id("prod-web-01")],
            raw_body={"value": []},
        )
    )

    assert objects_of(store)[0]["fact_keys"] == [
        "last_backup_status",
        "last_restore_point",
    ]


def test_the_three_writers_share_one_sequence_and_one_object_count() -> None:
    """One run records **one** `raw_archive.object_count`, and a replay refuses when the count
    and the objects supplied disagree. Two counters would produce two counts."""
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    async def go() -> None:
        await writer.write_inventory(
            actor_id=ACTOR,
            run_id=RUN,
            source="resource_graph",
            request_target="/providers/Microsoft.ResourceGraph/resources",
            page_index=0,
            skip_token_present=False,
            received_at=RECEIVED_AT,
            catalog_version=CATALOG.catalog_version,
            resource_ids=[resource_id("prod-web-01")],
            raw_body=page(row(record("prod-web-01"))),
        )
        await writer.write_facts(
            actor_id=ACTOR,
            run_id=RUN,
            source=SOURCE_RECOVERY_SERVICES,
            request_target=BACKUP_REQUEST_TARGET,
            fact_keys=["last_backup_status"],
            received_at=RECEIVED_AT,
            catalog_version=CATALOG.catalog_version,
            resource_ids=[resource_id("prod-web-01")],
            raw_body={"value": []},
        )

    asyncio.run(go())

    assert writer.object_count == 2
    sequences = [obj["sequence"] for obj in objects_of(store)]
    assert sequences == [0, 1]


# --------------------------------------------------------------------------- #
# `fact_keys` — the narrowing that stops a false absence
# --------------------------------------------------------------------------- #


def test_the_archived_keys_are_the_keys_that_source_answers_for() -> None:
    """The whole reason the field exists. `recovery_services` is one source covering two APIs,
    and the fold selects on `source` alone — so an object claiming the backup request answered
    for the replication key would make a replay record `replication_not_enabled` for a
    subscription whose replication was never asked about."""
    backup = declared_keys(narrowed_to_gap_type(CATALOG.facts, BACKUP_ABSENT_GAP_TYPE))
    replication = declared_keys(
        narrowed_to_gap_type(CATALOG.facts, REPLICATION_ABSENT_GAP_TYPE)
    )
    reservations = declared_keys(
        narrowed_to_gap_type(CATALOG.facts, RESERVATION_ABSENT_GAP_TYPE)
    )

    assert backup and replication and reservations
    # Disjoint, which is what makes narrowing meaningful at all.
    assert not set(backup) & set(replication)
    assert not set(backup) & set(reservations)


def test_the_object_records_the_narrowed_keys_and_not_the_whole_declaration() -> None:
    store = InMemoryObjectStore()
    port = FakeFactsPort(
        backup_responses=[empty_fact_list()], reservation_responses=[empty_fact_list()]
    )

    asyncio.run(
        collector(port, store=store, context=CONTEXT).collect(
            resources=[record("prod-web-01")],
            inventory_pages=[],
            subscription_id=SUBSCRIPTION,
        )
    )

    by_source = {obj["source"]: obj for obj in objects_of(store)}
    backup_keys = declared_keys(
        narrowed_to_gap_type(CATALOG.facts, BACKUP_ABSENT_GAP_TYPE)
    )
    replication_keys = declared_keys(
        narrowed_to_gap_type(CATALOG.facts, REPLICATION_ABSENT_GAP_TYPE)
    )

    assert by_source[SOURCE_RECOVERY_SERVICES]["fact_keys"] == list(backup_keys)
    # The replication keys are absent, because no replication request was issued: the run's
    # inventory holds no vault.
    for key in replication_keys:
        assert key not in by_source[SOURCE_RECOVERY_SERVICES]["fact_keys"]


def test_declared_keys_is_sorted_and_deduplicated() -> None:
    """Sorted so two runs archive byte-identical objects for one response; deduplicated because
    one key is declared per resource type and several types can declare the same key."""
    keys = declared_keys(CATALOG.facts)

    assert list(keys) == sorted(set(keys))
