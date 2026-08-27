"""Deterministic replay (Req 31).

Driven end to end rather than over hand-built inputs, because the claim under test is
"re-running the aggregation over what was archived reproduces the snapshot", and a test
that fed the replay a structure it had built itself would be asserting that two literals
match. So every scenario here runs a **real collection** through the production provider
assembly over the scripted fakes, builds the snapshot the pipeline builds, reads back the
objects the archive writer actually wrote, and replays those.

The load-bearing pair is
:func:`test_a_real_collection_replays_to_an_identical_digest` and
:func:`test_altering_one_decimal_string_in_one_archived_object_changes_the_digest`.
The first alone would pass against a replay that returned the stored `snapshot_id`; the
second is what makes it mean something.
"""

from __future__ import annotations

import asyncio
import gzip
import json
from datetime import UTC, datetime, timedelta
from typing import Any, Final
from zoneinfo import ZoneInfo

import pytest

from fakes.azure_ports import (
    FakeDefinitionsPort,
    FakeFactsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    empty_fact_list,
    raw_response_from_recorded,
)
from fakes.object_store import InMemoryObjectStore
from fixtures import load_response
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.azure.provider import FIDELITY_BASELINE, provider_over_ports
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.archive import ARCHIVE_KIND_METRICS, archive_kind_of
from reporting_agent.collect.buckets import day_buckets, resolve_window
from reporting_agent.collect.pipeline import sku_from_plain, statistic_from_plain
from reporting_agent.collect.snapshot import (
    ResourceSnapshot,
    build_snapshot,
    content_hash,
    fact_from_plain,
)
from reporting_agent.providers.base import CollectRequest, FactRequest, ScopeSpec
from reporting_agent.verify.findings import (
    FINDING_ARCHIVE_INCOMPLETE,
    FINDING_REPLAY_HASH_MISMATCH,
    SEVERITY_ADVISORY,
    SEVERITY_BLOCKING,
)
from reporting_agent.verify.replay import (
    RECOMPUTED_GAP_TYPES,
    plan_from_snapshot,
    replay,
)

SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
RESOURCE_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
WIRE_TYPE: Final[str] = "microsoft.compute/virtualmachines"
LOCATION: Final[str] = "southeastasia"
GROUP: Final[str] = "rg-prod-sea"
ACTOR_ID: Final[str] = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID: Final[str] = "run_01HQZX8QW9K7YB4T2C3M5N6P7Q"
CPU: Final[str] = "Percentage CPU"
MEMORY: Final[str] = "Available Memory Bytes"
SKU: Final[str] = "Standard_D4s_v5"
JAKARTA: Final[ZoneInfo] = ZoneInfo("Asia/Jakarta")
COLLECTED_AT: Final[datetime] = datetime(2026, 7, 2, 1, 30, tzinfo=UTC)

FACT_RECEIVED_AT: Final[datetime] = datetime(2026, 7, 2, 1, 25, 15, tzinfo=UTC)
"""When every fact response in this harness is received.

Before `COLLECTED_AT`, because a fact is collected during the run whose `collected_at` marks
its end — and `build_snapshot` bounds a fact's instant by the invocation's start, so an
instant after the snapshot's would be refused rather than merely odd."""

WINDOW: Final[dict[str, str]] = {
    "start": "2026-07-01",
    "end": "2026-07-01",
    "start_utc": "2026-06-30T17:00:00Z",
    "end_utc": "2026-07-01T17:00:00Z",
}


def resource_id(name: str) -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


WEB_01: Final[str] = resource_id("prod-web-01")
WEB_02: Final[str] = resource_id("prod-web-02")


# --------------------------------------------------------------------------- #
# One real collection, then the snapshot the pipeline builds from it
# --------------------------------------------------------------------------- #


def raw(body: object, **headers: str) -> RawHttpResponse:
    return RawHttpResponse(status=200, headers=dict(headers), body=body)


def wire_row(name: str, *, power_state: str = "PowerState/running") -> dict[str, Any]:
    return {
        "id": resource_id(name),
        "name": name,
        "type": WIRE_TYPE,
        "location": LOCATION,
        "resourceGroup": GROUP,
        "tags": {"env": "prod"},
        "sku": SKU,
        "powerState": power_state,
        # The projected `fact_<key>` columns the catalog's projectable keys ask for. A row
        # without them yields no projected fact at all, which would make any assertion
        # about a projected fact's `collected_at` vacuous — and that instant is exactly
        # what the receipt-vs-fold defect got wrong.
        "fact_os_type": "Linux",
        "fact_provisioning_state": "Succeeded",
        "fact_vm_size": SKU,
        "fact_data_disk_count": "2",
    }


def metric_entry(name: str, intervals: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "name": {"value": name, "localizedValue": name},
        "errorCode": "Success",
        "timeseries": [{"metadatavalues": [], "data": intervals}],
    }


def intervals(*, total: float, count: int, low: float, high: float) -> list[dict[str, Any]]:
    return [
        {
            "timeStamp": WINDOW["start_utc"],
            "total": total,
            "count": count,
            "minimum": low,
            "maximum": high,
        },
        {
            "timeStamp": WINDOW["end_utc"],
            "total": total * 2,
            "count": count * 2,
            "minimum": low / 2,
            "maximum": high * 2,
        },
    ]


def batch_response(resource_ids: list[str]) -> RawHttpResponse:
    return raw(
        {
            "values": [
                {
                    "starttime": WINDOW["start_utc"],
                    "endtime": WINDOW["end_utc"],
                    "interval": "PT1H",
                    "namespace": WIRE_TYPE,
                    "resourceregion": LOCATION,
                    "resourceid": rid,
                    "value": [
                        metric_entry(
                            CPU, intervals(total=720.0, count=60, low=5.0, high=30.0)
                        ),
                        metric_entry(
                            MEMORY,
                            intervals(
                                total=4294967296.0, count=1, low=4294967296.0, high=4294967296.0
                            ),
                        ),
                    ],
                }
                for rid in resource_ids
            ]
        }
    )


class Collection:
    """One real collection over the production assembly, plus its snapshot and archive."""

    def __init__(
        self,
        *,
        batches: list[RawHttpResponse] | None = None,
        extra_rows: list[dict[str, Any]] | None = None,
        metrics_by_resource_type: dict[str, list[str]] | None = None,
        definitions_responses: list[RawHttpResponse] | None = None,
        inventory_clock: Any = None,
        fact_clock: Any = None,
    ) -> None:
        self.store = InMemoryObjectStore()
        self.catalog = load_catalog()
        self._metrics_by_resource_type = metrics_by_resource_type
        rows = [wire_row("prod-web-01"), wire_row("prod-web-02"), *(extra_rows or [])]
        self.provider = provider_over_ports(
            inventory_port=FakeInventoryPort(
                [
                    raw(
                        {
                            "totalRecords": len(rows),
                            "count": len(rows),
                            "data": rows,
                        },
                        **{"x-ms-user-quota-remaining": "9"},
                    )
                ]
            ),
            sku_port=FakeSkuPort(
                [raw_response_from_recorded(load_response("azure", "resource_skus_with_vcpus_available"))]
            ),
            definitions_port=FakeDefinitionsPort(
                definitions_responses
                if definitions_responses is not None
                else [
                    raw({"value": [{"name": {"value": CPU}}, {"name": {"value": MEMORY}}]})
                ]
            ),
            metrics_port=FakeMetricsPort(
                batch_responses=(
                    batches if batches is not None else [batch_response([WEB_01, WEB_02])]
                ),
                fallback_responses=[],
            ),
            # A **real** backup answer for one of the two VMs, so the snapshot carries a
            # fact and not only absences. With every source answering nothing, the
            # re-derivation below would be proving that zero facts round-trip to zero facts —
            # and the `received_at` and digest-mismatch assertions would both hold trivially,
            # because nothing in the document would carry a fact's instant or its value.
            facts_port=FakeFactsPort(
                backup_responses=[
                    raw(
                        {
                            "value": [
                                {
                                    "id": "/subscriptions/x/…/backupProtectedItems/item-1",
                                    "properties": {
                                        "sourceResourceId": WEB_01,
                                        "lastBackupStatus": "Completed",
                                        "lastRecoveryPoint": "2026-07-31T18:04:00Z",
                                    },
                                }
                            ]
                        }
                    )
                ],
                reservation_responses=[empty_fact_list()],
                advisor_responses=[empty_fact_list()]
            ),
            object_store=self.store,
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            # A fixed instant for every fact response. `collected_at` is part of the
            # snapshot's canonical form, so with the wall clock deciding it this harness's
            # digest would change between two runs — and
            # `test_the_digest_is_identical_across_two_processes_with_different_hash_seeds`
            # compares digests produced by two subprocesses, which would then differ for a
            # reason that has nothing to do with a hash seed.
            fact_clock=fact_clock if fact_clock is not None else (lambda: FACT_RECEIVED_AT),
            # Defaults to the *same* instant as `fact_clock`, which is what every existing
            # test here wants — and is exactly why those tests could not see a fold that
            # read its own clock. A test that needs the receipt and the fold in different
            # seconds passes both explicitly.
            inventory_clock=(
                inventory_clock
                if inventory_clock is not None
                else (lambda: FACT_RECEIVED_AT)
            ),
            fidelity_tier=FIDELITY_BASELINE,
            catalog=self.catalog,
            sleep=self._sleep,
        )

    async def _sleep(self, seconds: float) -> None:  # pragma: no cover - nothing waits
        del seconds

    def scope(self) -> ScopeSpec:
        return ScopeSpec(
            subscription_id=SUBSCRIPTION,
            resource_types=[RESOURCE_TYPE],
            resource_groups=[],
            tag_filters={},
        )

    def run(self) -> dict[str, Any]:
        """Discover, collect, and build the snapshot the pipeline would build."""

        async def go():
            discovered = await self.provider.discover(self.scope())
            resources = list(discovered["resources"])
            collected = await self.provider.collect(
                CollectRequest(
                    scope=self.scope(),
                    resources=resources,
                    metrics_by_resource_type=(
                        self._metrics_by_resource_type
                        if self._metrics_by_resource_type is not None
                        else {RESOURCE_TYPE: [CPU, MEMORY]}
                    ),
                    grain="PT1H",
                    window=WINDOW,  # type: ignore[typeddict-item]
                    timezone="Asia/Jakarta",
                    utc_offset="+07:00",
                )
            )
            # The fact pass, because this harness claims to build "the snapshot the pipeline
            # would build" and the pipeline runs it. Skipping it was invisible until task 4.4
            # taught replay to fold an archived inventory page as fact-bearing: the archive
            # then carried a page whose projected columns replay re-derived and this snapshot
            # never had, so a correct replay reported eight `fact_unavailable` gaps as a
            # digest mismatch. A harness that collects less than the run it stands in for
            # fails the thing it is checking, not the thing it omitted.
            facts = await self.provider.collect_facts(
                FactRequest(
                    resources=resources,
                    inventory_pages=list(discovered.get("inventory_pages") or ()),
                    subscription_id=SUBSCRIPTION,
                )
            )
            return discovered, collected, resources, facts

        discovered, collected, resources, facts = asyncio.run(go())
        self.gaps = [*discovered["gaps"], *collected["gaps"], *facts["gaps"]]
        facts_by_resource: dict[str, list[Any]] = {}
        for record in facts["facts"]:
            facts_by_resource.setdefault(record["resource_id"], []).append(
                fact_from_plain(record)
            )

        window = resolve_window(
            _date(WINDOW["start"]), _date(WINDOW["end"]), JAKARTA
        )
        buckets = tuple(
            _bucket(bucket) for bucket in day_buckets(window, JAKARTA, "PT1H")
        )
        capacities = collected.get("sku_capacities") or {}
        day_statistics = collected.get("day_statistics") or {}
        built = [
            ResourceSnapshot(
                record={**record, "fidelity_tier": FIDELITY_BASELINE},
                sku=sku_from_plain(
                    capacities.get(record["resource_id"]),
                    sku_name=record.get("sku_name") or "",
                ),
                statistics=tuple(
                    statistic_from_plain(value, fidelity_tier=FIDELITY_BASELINE)
                    for by_statistic in collected["statistics"]
                    .get(record["resource_id"], {})
                    .values()
                    for value in by_statistic.values()
                ),
                # The day dimension, attached the way `collect/pipeline.py` attaches it:
                # the geometry above is the spine and the provider supplies only values.
                # This harness assembles the snapshot locally rather than calling the
                # pipeline, so the two have to be kept in step by hand — and the day
                # statistics landing here is what the replay compares against.
                day_buckets=tuple(
                    _bucket_with(
                        bucket,
                        day_statistics.get(record["resource_id"], {}).get(
                            bucket.local_day.isoformat(), ()
                        ),
                    )
                    for bucket in buckets
                ),
                facts=tuple(facts_by_resource.get(record["resource_id"], ())),
            )
            for record in resources
        ]
        self.document = build_snapshot(
            run_id=RUN_ID,
            # No lower bound on a fact's `collected_at`: this snapshot is built in a test
            # rather than by a run, so there is no invocation instant to bound it against —
            # and the facts it now carries were stamped by the collector's own clock, which a
            # fresh instant here would reject. `build_snapshot` takes it as a
            # required-but-nullable keyword so every call site states which it is.
            invocation_started_at=None,
            scope=self.scope(),
            scope_verified=True,
            collected_at=COLLECTED_AT,
            timezone_name="Asia/Jakarta",
            tz=JAKARTA,
            window=window,
            grain="PT1H",
            metrics_by_resource_type=(
                self._metrics_by_resource_type
                if self._metrics_by_resource_type is not None
                else {RESOURCE_TYPE: [CPU, MEMORY]}
            ),
            resources=built,
            gaps=self.gaps,
            catalog_version=self.catalog.catalog_version,
            raw_archive_complete=True,
            raw_archive_object_count=len(self.archived()),
        )
        return self.document

    def archived(self) -> list[tuple[int, bytes]]:
        """The archive as the caller of `replay` supplies it: `(ordinal, bytes)`, in
        sequence order, read back out of the store the collector actually wrote to."""
        keys = sorted(key for key in self.store.keys() if "/raw/" in key)
        return [
            (ordinal, self.store.get(key).body)  # type: ignore[union-attr]
            for ordinal, key in enumerate(keys)
        ]

    def plan(self, **overrides: Any):
        plan = plan_from_snapshot(self.document, catalog=self.catalog)
        return plan if not overrides else _replace(plan, **overrides)


def _date(text: str):
    from datetime import date

    return date.fromisoformat(text)


def _bucket(bucket: Any):
    from reporting_agent.collect.snapshot import ResourceDayBucket

    return ResourceDayBucket(local_day=bucket.local_day, slot_count=bucket.slot_count)


def _bucket_with(bucket: Any, values: Any):
    """One geometry bucket carrying a day's statistics, as `collect/pipeline.py` builds it."""
    import dataclasses

    from reporting_agent.collect.pipeline import statistic_from_plain

    return dataclasses.replace(
        bucket,
        statistics=tuple(
            statistic_from_plain(value, fidelity_tier=FIDELITY_BASELINE)
            for value in values
        ),
    )


def _replace(plan: Any, **overrides: Any):
    import dataclasses

    return dataclasses.replace(plan, **overrides)


@pytest.fixture(scope="module")
def collection() -> Collection:
    harness = Collection()
    harness.run()
    return harness


# --------------------------------------------------------------------------- #
# 4.1 — the recomputed digest equals the original
# --------------------------------------------------------------------------- #


def test_a_real_collection_replays_to_an_identical_digest(collection) -> None:
    """Req 31.1, Property 4.1 — over a snapshot this test did not construct.

    Every input is what the collector produced: the archive is what the archive writer
    wrote, the plan is reconstructed from the stored document, and the digest is the one
    `build_snapshot` computed.
    """
    result = replay(collection.archived(), plan=collection.plan())

    assert result.findings == ()
    assert result.outcome["possible"] is True
    assert result.outcome["recomputed_sha256"] == collection.document["snapshot_id"]
    assert result.outcome["stored_sha256"] == collection.document["snapshot_id"]
    assert result.outcome["objects_folded"] == len(collection.archived()) > 0


def metrics_objects(archived: list[tuple[int, bytes]]) -> list[tuple[int, int, bytes]]:
    """`(index, ordinal, payload)` for every **metrics-kind** archived object.

    The archive holds two kinds now — the inventory query projects the catalog's facts, so
    its Resource Graph page is archived too (Req 7.1) — and only the metrics ones carry a
    `values` body to reach into. Narrowed by the object's **declared kind** rather than by
    position, because position is exactly what changed when the second kind arrived.
    """
    found: list[tuple[int, int, bytes]] = []
    for index, (ordinal, payload) in enumerate(archived):
        document = json.loads(gzip.decompress(payload))
        if archive_kind_of(document) == ARCHIVE_KIND_METRICS:
            found.append((index, ordinal, payload))
    return found


def test_the_archive_is_non_empty_so_the_replay_folded_something(collection) -> None:
    """Guard the guard. A replay over an empty archive would agree with any snapshot whose
    resources produced no statistic, and Property 4.1 would pass vacuously."""
    archived = collection.archived()
    metrics = metrics_objects(archived)

    assert archived
    assert metrics, "the archive holds no metrics response for the replay to fold"
    for _, _, payload in metrics:
        document = json.loads(gzip.decompress(payload))
        assert document["raw_response"]["values"]
        assert document["metric_names"]


def test_the_recomputed_snapshot_carries_the_same_statistics(collection) -> None:
    """Not only the same digest — the same content, so a digest match cannot be an
    accident of two documents that are both empty."""
    result = replay(collection.archived(), plan=collection.plan())

    assert result.document is not None
    assert result.document["resources"] == collection.document["resources"]
    assert result.document["gaps"] == collection.document["gaps"]
    statistics = [
        stat
        for resource in result.document["resources"]  # type: ignore[union-attr]
        for stat in resource["statistics"]
    ]
    assert len(statistics) >= 4, statistics


# --------------------------------------------------------------------------- #
# 4.4 — a mutation must move the digest
# --------------------------------------------------------------------------- #


def mutate(payload: bytes, mutation) -> bytes:
    document = json.loads(gzip.decompress(payload))
    mutation(document)
    return gzip.compress(json.dumps(document).encode("utf-8"))


def with_first_metrics_mutated(
    archived: list[tuple[int, bytes]], mutation
) -> list[tuple[int, bytes]]:
    """`archived`, with `mutation` applied to its first metrics-kind object and every
    other object — the inventory page included — supplied unchanged.

    Whole-archive rather than `[mutated, *archived[1:]]`: the mutated object has to go back
    at **its own** index, or the ordinals stop matching the sequence the archive named and
    the replay would refuse for that reason instead of the digest mismatch under test.
    """
    index, ordinal, payload = metrics_objects(archived)[0]
    rebuilt = list(archived)
    rebuilt[index] = (ordinal, mutate(payload, mutation))
    return rebuilt


def test_altering_one_decimal_string_in_one_archived_object_changes_the_digest(
    collection,
) -> None:
    """Property 4.4, and the test that gives 4.1 its meaning.

    A replay that read the stored `snapshot_id` and returned it passes 4.1 and cannot
    possibly pass this: the mutation cannot change a digest that was never recomputed.
    """
    archived = collection.archived()

    def bump(document):
        document["raw_response"]["values"][0]["value"][0]["timeseries"][0]["data"][0][
            "total"
        ] = 999999.0

    result = replay(with_first_metrics_mutated(archived, bump), plan=collection.plan())

    assert result.outcome["possible"] is True
    assert result.outcome["recomputed_sha256"] != collection.document["snapshot_id"]
    assert [f["type"] for f in result.findings] == [FINDING_REPLAY_HASH_MISMATCH]
    assert result.findings[0]["severity"] == SEVERITY_BLOCKING
    assert result.findings[0]["observed"] == result.outcome["recomputed_sha256"]
    assert result.findings[0]["expected"] == collection.document["snapshot_id"]


def test_making_one_interval_malformed_changes_the_digest_through_the_gap_list(
    collection,
) -> None:
    """The gap partition, made executable. A replay that carried the stored fold gaps over
    instead of recomputing them would report an identical digest here — the statistics
    barely move, and the whole signal is the new `interval_counts_missing` entry."""
    archived = collection.archived()

    def drop_count(document):
        del document["raw_response"]["values"][0]["value"][0]["timeseries"][0]["data"][0][
            "count"
        ]

    result = replay(
        with_first_metrics_mutated(archived, drop_count), plan=collection.plan()
    )

    assert result.outcome["recomputed_sha256"] != collection.document["snapshot_id"]
    assert result.document is not None
    recomputed_types = {gap["gap_type"] for gap in result.document["gaps"]}  # type: ignore[index]
    assert "interval_counts_missing" in recomputed_types


def test_the_recomputed_gap_types_are_the_ones_the_fold_and_finalize_produce() -> None:
    """The partition itself, asserted rather than left to a comment.

    Carry a recomputed type over and it appears twice; drop a carried-over type and it
    vanishes. Either changes the `collection_log` and therefore the digest, on a snapshot
    that is perfectly reproducible.
    """
    assert "interval_counts_missing" in RECOMPUTED_GAP_TYPES
    assert "no_samples" in RECOMPUTED_GAP_TYPES
    assert "sku_capability_missing" in RECOMPUTED_GAP_TYPES
    # Produced by steps replay does not re-run, so carried over unchanged.
    for carried in (
        "deallocated",
        "duplicate_inventory_row",
        "region_unreachable",
        "sku_unknown",
        "definitions_unavailable",
        "archive_write_failed",
        "instance_name_collapsed",
        "percentile_unsupported_unit",
        # Req 23.15. Named here because it is the one that most looks like a metrics gap
        # and is not: it comes from the collector's *request planning*, before any response
        # exists, and replay re-runs the fold and the finalize but never the planning.
        "metric_not_selected",
    ):
        assert carried not in RECOMPUTED_GAP_TYPES, carried


def test_a_carried_over_metric_not_selected_gap_survives_replay_exactly_once(
    collection,
) -> None:
    """Req 23.15 with Req 31.x — the gap is carried over, and carried over **once**.

    The failure this pins is specific and expensive: add `metric_not_selected` to
    `RECOMPUTED_GAP_TYPES` and it is stripped from the stored log and then re-produced by a
    recomputation that never planned a request — so it either vanishes or appears twice, the
    `collection_log` changes, the digest changes, and every affected run fails the replay
    gate as a mismatch while being entirely correct.

    Driven by planting the gap in a real stored snapshot and replaying it, rather than by
    asserting set membership, because membership is already asserted above and would not
    catch a second code path that filtered the log by a different rule.
    """
    planted = json.loads(json.dumps(collection.document))
    gap = {
        "gap_type": "metric_not_selected",
        "resource_id": str(planted["resources"][0]["resource_id"]),
        "metric": None,
        "message": (
            "no metric was requested for resource type "
            "'Microsoft.Storage/storageAccounts', so nothing was collected for this "
            "resource; the pinned template version selected no metric for that type"
        ),
    }
    planted["gaps"] = sorted(
        [*planted["gaps"], gap],
        key=lambda entry: (
            str(entry["gap_type"]),
            str(entry["resource_id"]),
            str(entry["metric"] or ""),
        ),
    )
    # A hand-edited document is a new document, so its digest is recomputed the way the
    # builder would have. The assertions below are about the replay's treatment of the gap,
    # not about whether an edited snapshot still matches the digest it arrived with.
    planted["content_hash"] = ""
    planted["content_hash"] = content_hash(planted)
    planted["snapshot_id"] = planted["content_hash"]

    result = replay(
        collection.archived(),
        plan=plan_from_snapshot(planted, catalog=collection.catalog),
    )

    assert result.findings == (), result.findings
    assert result.outcome["recomputed_sha256"] == planted["snapshot_id"]
    assert result.document is not None
    carried = [
        entry
        for entry in result.document["gaps"]  # type: ignore[index]
        if entry["gap_type"] == "metric_not_selected"
    ]
    assert carried == [gap], carried


# --------------------------------------------------------------------------- #
# 4.5 — each object folded exactly once
# --------------------------------------------------------------------------- #


def test_every_archived_object_is_folded_exactly_once(collection) -> None:
    """Property 4.5. A double fold doubles every count-weighted average's denominator and
    its numerator, so the averages survive — but the sample counts do not, and neither
    does the digest.

    Since task 4.4 the double fold is caught **harder** than by a differing digest: folding a
    fact response twice gives a resource two values for one key, which `ResourceSnapshot`
    refuses outright. So there is no second digest to compare — the outcome is a mismatch with
    no digest at all, which is a stronger statement than "the two digests differ" and the one
    asserted here. `replay` still returns rather than raises, which is what stops a duplicated
    S3 key from turning a verification into an unhandled exception.
    """
    archived = collection.archived()

    once = replay(archived, plan=collection.plan())
    twice = replay(
        [*archived, *((ordinal + 100, payload) for ordinal, payload in archived)],
        plan=collection.plan(objects_named=len(archived) * 2),
    )

    assert once.outcome["objects_folded"] == len(archived)
    assert twice.outcome["objects_folded"] == len(archived) * 2
    assert [f["type"] for f in twice.findings] == [FINDING_REPLAY_HASH_MISMATCH]
    assert twice.findings[0]["severity"] == SEVERITY_BLOCKING
    assert "recomputed_sha256" not in twice.outcome
    # And the single fold still produces one, so the assertion above is about the double fold
    # rather than about replay having stopped producing digests.
    assert once.outcome["recomputed_sha256"] == collection.document["snapshot_id"]


def test_dropping_one_object_is_reported_as_an_incomplete_archive(collection) -> None:
    """Req 31.8 — an object the sequence names is missing, so replay was not possible.

    **Not** a mismatch. Reporting one would accuse a run of non-determinism on the
    strength of a missing input, and because `replay_hash_mismatch` is blocking it would
    withhold a correct report.
    """
    archived = collection.archived()
    assert archived, "the scenario needs an object to drop"

    result = replay(archived[:-1], plan=collection.plan())

    assert result.outcome["possible"] is False
    assert "recomputed_sha256" not in result.outcome
    assert [f["type"] for f in result.findings] == [FINDING_ARCHIVE_INCOMPLETE]
    assert result.findings[0]["severity"] == SEVERITY_ADVISORY


# --------------------------------------------------------------------------- #
# Req 31.5, 31.8 — an inability to replay is never a mismatch
# --------------------------------------------------------------------------- #


def test_a_snapshot_whose_archive_is_incomplete_is_not_replayed_at_all(collection) -> None:
    """Req 31.5. The flag is the run's own admission that a write failed; attempting a
    replay against a known hole could only produce a false mismatch."""
    result = replay(collection.archived(), plan=collection.plan(archive_complete=False))

    assert result.outcome["possible"] is False
    assert result.outcome["objects_folded"] == 0
    assert [f["type"] for f in result.findings] == [FINDING_ARCHIVE_INCOMPLETE]
    assert "incomplete" in result.findings[0]["message"]


def test_a_corrupt_object_names_its_sequence_ordinal_and_records_no_mismatch(
    collection,
) -> None:
    """Req 31.8 — a corrupt gzip is a missing input, not a failed proof."""
    archived = collection.archived()

    result = replay([(0, b"not gzip at all"), *archived[1:]], plan=collection.plan())

    assert result.outcome["possible"] is False
    assert [f["type"] for f in result.findings] == [FINDING_ARCHIVE_INCOMPLETE]
    assert result.findings[0]["paragraph_ordinal"] == 0
    assert FINDING_REPLAY_HASH_MISMATCH not in {f["type"] for f in result.findings}


def test_an_object_that_decodes_to_a_non_object_is_an_incomplete_archive(
    collection,
) -> None:
    archived = collection.archived()
    payload = gzip.compress(b"[1, 2, 3]")

    result = replay([(0, payload), *archived[1:]], plan=collection.plan())

    assert result.outcome["possible"] is False
    assert [f["type"] for f in result.findings] == [FINDING_ARCHIVE_INCOMPLETE]


# --------------------------------------------------------------------------- #
# The plan reconstruction
# --------------------------------------------------------------------------- #


def test_the_plan_reads_structure_from_the_snapshot_and_no_folded_value(
    collection,
) -> None:
    """Req 31.4. The plan may carry a resource's name and its vCPU count — no archive of
    metric responses could supply those — and may carry no average, extreme or percentile.

    Asserted by construction: `ReplayResource` has no field that could hold one.
    """
    import dataclasses

    from reporting_agent.verify.replay import ReplayResource

    fields = {field.name for field in dataclasses.fields(ReplayResource)}

    assert "statistics" not in fields
    assert fields.isdisjoint({"average", "minimum", "maximum", "percentiles", "sketch"})
    plan = collection.plan()
    assert len(plan.resources) == 2
    assert {r.record["resource_id"] for r in plan.resources} == {WEB_01, WEB_02}
    assert all(set(r.selected) == {CPU, MEMORY} for r in plan.resources)


def test_the_plan_carries_the_stored_digest_and_the_archive_geometry(collection) -> None:
    plan = collection.plan()

    assert plan.stored_snapshot_id == collection.document["snapshot_id"]
    assert plan.archive_complete is True
    assert plan.objects_named == plan.archive_object_count == len(collection.archived())
    assert plan.grain == "PT1H"
    assert plan.timezone_name == "Asia/Jakarta"


def test_the_reconstructed_window_round_trips(collection) -> None:
    """A window off by a day would move every day bucket and every digest, and the error
    would read as non-determinism rather than as a parsing mistake."""
    plan = collection.plan()
    stored = collection.document["window"]

    assert plan.window.local_start.isoformat() == stored["start"]  # type: ignore[index]
    assert plan.window.local_end.isoformat() == stored["end"]  # type: ignore[index]


# --------------------------------------------------------------------------- #
# 4.2 — identical across two processes with differing hash seeds
# --------------------------------------------------------------------------- #


REPLAY_IN_SUBPROCESS: Final[str] = """
import base64, json, sys
sys.path[:0] = [%r, %r]
import test_verify_replay as harness
from reporting_agent.verify.replay import replay

collection = harness.Collection()
collection.run()
result = replay(collection.archived(), plan=collection.plan())
print(result.outcome["recomputed_sha256"])
"""


def test_the_digest_is_identical_across_two_processes_with_different_hash_seeds() -> None:
    """Property 4.2. A `set` or a `dict` iterated anywhere on the aggregation path produces
    a stable digest within one process and a different one in the next — which is invisible
    to every same-process assertion and fatal to an audit artifact that is supposed to be
    reproducible on another machine a year later.

    Two real interpreters, two different `PYTHONHASHSEED` values, one collection each.
    """
    import os
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    program = REPLAY_IN_SUBPROCESS % (str(root / "src"), str(root / "tests"))

    digests = []
    for seed in ("0", "12345"):
        completed = subprocess.run(
            [sys.executable, "-c", program],
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "PYTHONHASHSEED": seed},
            check=False,
        )
        assert completed.returncode == 0, completed.stderr[-2000:]
        digests.append(completed.stdout.strip())

    # Non-vacuity twice over. An empty stdout would satisfy an equality check trivially,
    # and two subprocesses agreeing with each other but not with this process would be a
    # different bug wearing the same green — so the digest is checked against the one
    # computed here as well.
    local = Collection()
    local.run()

    assert len(digests[0]) == 64, digests
    assert digests[0] == digests[1]
    assert digests[0] == local.document["snapshot_id"]


# --------------------------------------------------------------------------- #
# Task 4.4 — the facts re-derivation, and the two verdicts about a bad object
# --------------------------------------------------------------------------- #


def _facts_object_ordinals(collection: Collection) -> list[int]:
    """The ordinals of the archived objects whose kind is `facts`."""
    from reporting_agent.collect.archive import ARCHIVE_KIND_FACTS, archive_kind_of

    found: list[int] = []
    for ordinal, payload in collection.archived():
        document = json.loads(gzip.decompress(payload))
        if archive_kind_of(document) == ARCHIVE_KIND_FACTS:
            found.append(ordinal)
    return found


def test_the_collection_actually_archived_fact_objects(collection) -> None:
    """The anchor for every assertion below. With no `facts` object in the archive, dropping
    one would drop nothing and the mismatch tests would pass by changing the input they meant
    to change — which is exactly how this file read before task 4.4, against a catalog that
    declared no facts."""
    assert _facts_object_ordinals(collection), (
        "the shipped catalog declares facts, so a real collection must archive at least one "
        "`facts` object or the re-derivation below is not being exercised"
    )


def test_the_recomputed_snapshot_carries_the_re_derived_facts(collection) -> None:
    """Req 7.3 — not only the same digest, the same facts, so a match cannot be an accident of
    two documents that both carry none."""
    result = replay(collection.archived(), plan=collection.plan())

    assert result.document is not None
    stored_facts = [
        (resource["resource_id"], fact["key"], fact["value"])
        for resource in collection.document["resources"]  # type: ignore[union-attr]
        for fact in resource.get("facts", ())
    ]
    replayed_facts = [
        (resource["resource_id"], fact["key"], fact["value"])
        for resource in result.document["resources"]  # type: ignore[index]
        for fact in resource.get("facts", ())
    ]
    assert replayed_facts == stored_facts


def test_dropping_a_facts_object_is_an_incomplete_archive_not_a_mismatch(
    collection,
) -> None:
    """The object count is what catches it first.

    An object the sequence names being absent is Req 31.5's advisory, not an accusation of
    non-determinism — and the ordering matters: a replay that folded what it had and *then*
    compared digests would report `replay_hash_mismatch`, withholding a correct report on the
    strength of a missing input.
    """
    ordinals = _facts_object_ordinals(collection)
    kept = [
        (ordinal, payload)
        for ordinal, payload in collection.archived()
        if ordinal != ordinals[0]
    ]

    result = replay(kept, plan=collection.plan())

    assert result.outcome["possible"] is False
    assert [f["type"] for f in result.findings] == [FINDING_ARCHIVE_INCOMPLETE]
    assert all(f["severity"] == SEVERITY_ADVISORY for f in result.findings)


def test_a_facts_object_present_but_empty_of_facts_is_a_digest_mismatch(
    collection,
) -> None:
    """The other verdict, and the one the task names: a fact folded with **no** archived
    response behind it produces a differing digest and `replay_hash_mismatch`.

    Driven by emptying the response rather than removing the object, so the count still
    matches and the replay proceeds all the way to the comparison — which is the only way to
    reach the mismatch branch at all.
    """
    ordinals = _facts_object_ordinals(collection)
    supplied: list[tuple[int, bytes]] = []
    for ordinal, payload in collection.archived():
        if ordinal == ordinals[0]:
            document = json.loads(gzip.decompress(payload))
            document["raw_response"] = {"value": []}
            payload = gzip.compress(json.dumps(document).encode("utf-8"))
        supplied.append((ordinal, payload))

    result = replay(supplied, plan=collection.plan())

    assert result.outcome["possible"] is True
    assert [f["type"] for f in result.findings] == [FINDING_REPLAY_HASH_MISMATCH]
    assert all(f["severity"] == SEVERITY_BLOCKING for f in result.findings)


def test_an_undecodable_facts_object_is_advisory_and_names_its_ordinal(
    collection,
) -> None:
    """Req 7.3 — an object that will not decompress is `archive_incomplete` naming the sequence
    ordinal, with replay recorded as not possible and **no exception mid-fold**."""
    ordinals = _facts_object_ordinals(collection)
    supplied = [
        (ordinal, b"not gzip at all" if ordinal == ordinals[0] else payload)
        for ordinal, payload in collection.archived()
    ]

    result = replay(supplied, plan=collection.plan())

    assert result.outcome["possible"] is False
    assert len(result.findings) == 1
    assert result.findings[0]["type"] == FINDING_ARCHIVE_INCOMPLETE
    assert result.findings[0]["paragraph_ordinal"] == ordinals[0]


def test_a_facts_objects_received_at_is_read_from_the_object_not_the_replay_instant(
    collection,
) -> None:
    """The substitution that would report `REPLAY_MISMATCH` on every run in production and on
    none in a test that happened to stamp the same instant twice.

    A fact's `collected_at` is part of the canonical form the digest is taken over, so moving
    the archived instant by one second has to move the recomputed digest — which is what proves
    the value is being read from the object rather than produced at verification time.
    """
    ordinals = _facts_object_ordinals(collection)
    supplied: list[tuple[int, bytes]] = []
    moved = ""
    for ordinal, payload in collection.archived():
        if ordinal == ordinals[0]:
            document = json.loads(gzip.decompress(payload))
            original = str(document["received_at"])
            # Derived rather than substituted textually: the collector stamps this from its
            # own clock, which in this harness is the wall clock, so a hard-coded second
            # would differ from the original only by luck.
            moved = (
                datetime.fromisoformat(original.replace("Z", "+00:00"))
                + timedelta(seconds=1)
            ).strftime("%Y-%m-%dT%H:%M:%SZ")
            assert moved != original, original
            document["received_at"] = moved
            payload = gzip.compress(json.dumps(document).encode("utf-8"))
        supplied.append((ordinal, payload))

    result = replay(supplied, plan=collection.plan())

    assert result.document is not None
    assert result.outcome["recomputed_sha256"] != collection.document["snapshot_id"]
    # And the moved instant is the one that reached the re-derived fact, rather than being
    # discarded in favour of a fresh one.
    assert moved in json.dumps(result.document)


def test_the_fact_gap_types_are_recomputed_rather_than_carried_over(collection) -> None:
    """The partition, asserted where getting it wrong is visible.

    Carry a recomputed type over and it appears twice; drop a carried-over one and it vanishes.
    Both change the `collection_log` and therefore the digest — so a partition error shows up
    as a mismatch on a reproducible snapshot, which is the failure this test exists to name.
    """
    from reporting_agent.collect.log import (
        FACT_GAP_TYPES,
        GAP_TYPE_ARCHIVE_WRITE_FAILED,
    )

    assert FACT_GAP_TYPES <= RECOMPUTED_GAP_TYPES
    # The one fact-ish type that is **not** recomputed: replay does not re-run the write, so
    # its failure is carried over like every other step replay cannot repeat.
    assert GAP_TYPE_ARCHIVE_WRITE_FAILED not in RECOMPUTED_GAP_TYPES

    stored = collection.document["gaps"]
    fact_gaps = [gap for gap in stored if gap["gap_type"] in FACT_GAP_TYPES]
    assert fact_gaps, "the collection recorded no fact gap, so this partition is untested"

    result = replay(collection.archived(), plan=collection.plan())
    assert result.document is not None
    replayed = [
        gap
        for gap in result.document["gaps"]  # type: ignore[index]
        if gap["gap_type"] in FACT_GAP_TYPES
    ]
    assert len(replayed) == len(fact_gaps)


# --------------------------------------------------------------------------- #
# 4.4 — the two defects that reported REPLAY_MISMATCH on a reproducible snapshot
# --------------------------------------------------------------------------- #


DISK_WIRE_TYPE: Final[str] = "microsoft.compute/disks"
DISK_RESOURCE_TYPE: Final[str] = "Microsoft.Compute/disks"
DISK_METRICS: Final[tuple[str, ...]] = (
    "Composite Disk Read Bytes/sec",
    "Composite Disk Write Bytes/sec",
    "Composite Disk Read Operations/sec",
    "Composite Disk Write Operations/sec",
)


def disk_row(name: str) -> dict[str, Any]:
    """One managed disk, as Resource Graph returns it.

    Two fields carry the whole defect. `type` is **not** a virtual machine, and
    `powerState` is absent — a disk has none — so the inventory normalizes
    `power_state` to `"unknown"` while `power_state_raw` stays `""`. The averages
    exclusion reads the *raw* field and the type, so a disk is **not** excluded; the
    copy replay used to carry read the *normalized* field against a set containing
    `"unknown"` and excluded it.
    """
    return {
        "id": resource_id(name),
        "name": name,
        "type": DISK_WIRE_TYPE,
        "location": LOCATION,
        "resourceGroup": GROUP,
        "tags": {"env": "prod"},
        "sku": "Premium_LRS",
    }


def test_a_non_vm_resource_folding_no_samples_replays_identically() -> None:
    """Req 20.6, 31.1 — one exclusion predicate, so the collector and the replay agree.

    ## The defect

    `is_excluded_from_averages` existed twice. The collector's copy read
    `power_state_raw` and only excluded a non-deallocated resource when it was a VM;
    replay's copy tested the **normalized** `power_state` against a set containing
    `"unknown"`. Every non-VM resource carries `power_state="unknown"` and
    `power_state_raw=""`, so the two disagreed on all of them.

    It only became visible when such a resource had **selected metrics and folded no
    samples**: the collector, not excluding it, wrote a `no_samples` gap; replay,
    excluding it, wrote none. The gap list is inside the hashed document, so a snapshot
    that was perfectly reproducible reported `REPLAY_MISMATCH` — 12 gaps on the run that
    surfaced it, from three region-unreachable disks times four composite-disk metrics.

    This drives exactly that shape: a disk with the four composite metrics selected, and
    a metrics response that carries nothing for it, so its accumulators fold no sample.
    """
    harness = Collection(
        extra_rows=[disk_row("prod-data-01")],
        # The VMs' real batch, then a response carrying no value at all for the disk's
        # group — which is what makes the disk fold **no samples** and the collector write
        # the `no_samples` gaps the two sides used to disagree about.
        # The **same** VM-only response for both groups, so the disk is absent from
        # whichever response its group receives and folds no sample — and the assertion
        # does not depend on which resource type happens to be collected first.
        batches=[batch_response([WEB_01, WEB_02]) for _ in range(2)],
        # One probe per (resource_type, region) and two types here, so two answers — both
        # naming every metric, because the probe order across groups is not this test's
        # subject and a mismatched pairing would make the disk's metrics read as
        # `metric_not_emitted` instead of reaching the fold at all.
        definitions_responses=[
            raw(
                {
                    "value": [
                        {"name": {"value": name}}
                        for name in (CPU, MEMORY, *DISK_METRICS)
                    ]
                }
            )
            for _ in range(2)
        ],
        metrics_by_resource_type={
            RESOURCE_TYPE: [CPU, MEMORY],
            # Selected, so the disk gets accumulators and can be found to have folded
            # nothing. A resource with no selected metric never reaches the predicate.
            DISK_RESOURCE_TYPE: list(DISK_METRICS),
        },
    )
    harness.run()

    # The precondition, asserted rather than assumed: the collector wrote a `no_samples`
    # gap for the disk. Without it this test would pass against the defect, because the
    # two sides only disagree where such a gap exists.
    disk_id = resource_id("prod-data-01")
    disk_gaps = [
        gap
        for gap in harness.document["gaps"]
        if gap.get("resource_id") == disk_id and gap.get("gap_type") == "no_samples"
    ]
    assert len(disk_gaps) == len(DISK_METRICS), harness.document["gaps"]

    result = replay(harness.archived(), plan=harness.plan())

    assert result.findings == ()
    assert result.outcome["recomputed_sha256"] == harness.document["snapshot_id"]


def test_a_fact_fold_after_the_receipt_second_replays_identically() -> None:
    """Req 4.3, 4.13, 31.1 — a projected fact's `collected_at` is its page's receipt.

    ## The defect

    `azure/facts.py` stamped `collected_at` from its own clock, read inside the fold
    loop. The page had already been archived with the instant it actually arrived, and
    replay re-derives from that archived value — so any gap between arrival and fold
    put every projected fact's `collected_at` in the document one step away from what
    the archive said. One second, on the run that surfaced it: 29 facts, all off,
    `REPLAY_MISMATCH` on a reproducible snapshot.

    ## Why the existing tests could not see it

    Every other test here pins one fixed instant for both clocks, so a fold-time read
    and a receipt-time read return the same value and the bug is invisible. The
    per-page test in `test_azure_facts.py` asserted only that two pages' stamps
    *differ* — which a per-page fold-time read also satisfies.

    So this drives them apart on purpose: the page is received at `:15`, the fold runs
    at `:17`, and they are in different seconds. The archived receipt instant is the one
    that must reach the document.
    """
    received = datetime(2026, 7, 2, 1, 25, 15, tzinfo=UTC)
    folded_later = datetime(2026, 7, 2, 1, 25, 17, tzinfo=UTC)
    assert received.second != folded_later.second

    harness = Collection(
        inventory_clock=lambda: received,
        # Two seconds later, and it must not appear anywhere in the document's projected
        # facts. A fold-time read would put `01:25:17Z` on every one of them.
        fact_clock=lambda: folded_later,
    )
    harness.run()

    result = replay(harness.archived(), plan=harness.plan())

    assert result.findings == ()
    assert result.outcome["recomputed_sha256"] == harness.document["snapshot_id"]

    # And the stamp is the receipt instant, named — not merely self-consistent between
    # the two halves. A defect that stamped the fold instant on *both* sides would
    # replay identically and still record the wrong time in a delivered document.
    projectable_keys = {"os_type", "provisioning_state", "vm_size", "data_disk_count"}
    projected = [
        fact
        for resource in harness.document["resources"]
        for fact in (resource.get("facts") or ())
        if fact.get("key") in projectable_keys and fact.get("value")
    ]
    assert projected, "the harness collected no projected fact to stamp"
    assert {fact["collected_at"] for fact in projected} == {"2026-07-02T01:25:15Z"}
