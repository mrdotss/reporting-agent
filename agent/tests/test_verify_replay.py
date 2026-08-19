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
from datetime import UTC, datetime
from typing import Any, Final
from zoneinfo import ZoneInfo

import pytest

from fakes.azure_ports import (
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    raw_response_from_recorded,
)
from fakes.object_store import InMemoryObjectStore
from fixtures import load_response
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.azure.provider import FIDELITY_BASELINE, provider_over_ports
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.buckets import day_buckets, resolve_window
from reporting_agent.collect.pipeline import sku_from_plain, statistic_from_plain
from reporting_agent.collect.snapshot import (
    ResourceSnapshot,
    build_snapshot,
    content_hash,
)
from reporting_agent.providers.base import CollectRequest, ScopeSpec
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

    def __init__(self, *, batches: list[RawHttpResponse] | None = None) -> None:
        self.store = InMemoryObjectStore()
        self.catalog = load_catalog()
        self.provider = provider_over_ports(
            inventory_port=FakeInventoryPort(
                [
                    raw(
                        {
                            "totalRecords": 2,
                            "count": 2,
                            "data": [wire_row("prod-web-01"), wire_row("prod-web-02")],
                        },
                        **{"x-ms-user-quota-remaining": "9"},
                    )
                ]
            ),
            sku_port=FakeSkuPort(
                [raw_response_from_recorded(load_response("azure", "resource_skus_with_vcpus_available"))]
            ),
            definitions_port=FakeDefinitionsPort(
                [raw({"value": [{"name": {"value": CPU}}, {"name": {"value": MEMORY}}]})]
            ),
            metrics_port=FakeMetricsPort(
                batch_responses=(
                    batches if batches is not None else [batch_response([WEB_01, WEB_02])]
                ),
                fallback_responses=[],
            ),
            object_store=self.store,
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
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
                    metrics_by_resource_type={RESOURCE_TYPE: [CPU, MEMORY]},
                    grain="PT1H",
                    window=WINDOW,  # type: ignore[typeddict-item]
                    timezone="Asia/Jakarta",
                    utc_offset="+07:00",
                )
            )
            return discovered, collected, resources

        discovered, collected, resources = asyncio.run(go())
        self.gaps = [*discovered["gaps"], *collected["gaps"]]

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
            )
            for record in resources
        ]
        self.document = build_snapshot(
            run_id=RUN_ID,
            scope=self.scope(),
            scope_verified=True,
            collected_at=COLLECTED_AT,
            timezone_name="Asia/Jakarta",
            tz=JAKARTA,
            window=window,
            grain="PT1H",
            metrics_by_resource_type={RESOURCE_TYPE: [CPU, MEMORY]},
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


def test_the_archive_is_non_empty_so_the_replay_folded_something(collection) -> None:
    """Guard the guard. A replay over an empty archive would agree with any snapshot whose
    resources produced no statistic, and Property 4.1 would pass vacuously."""
    archived = collection.archived()

    assert archived
    for _, payload in archived:
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


def test_altering_one_decimal_string_in_one_archived_object_changes_the_digest(
    collection,
) -> None:
    """Property 4.4, and the test that gives 4.1 its meaning.

    A replay that read the stored `snapshot_id` and returned it passes 4.1 and cannot
    possibly pass this: the mutation cannot change a digest that was never recomputed.
    """
    archived = collection.archived()
    ordinal, payload = archived[0]

    def bump(document):
        document["raw_response"]["values"][0]["value"][0]["timeseries"][0]["data"][0][
            "total"
        ] = 999999.0

    result = replay([(ordinal, mutate(payload, bump)), *archived[1:]], plan=collection.plan())

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
    ordinal, payload = archived[0]

    def drop_count(document):
        del document["raw_response"]["values"][0]["value"][0]["timeseries"][0]["data"][0][
            "count"
        ]

    result = replay(
        [(ordinal, mutate(payload, drop_count)), *archived[1:]], plan=collection.plan()
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
    does the digest."""
    archived = collection.archived()

    once = replay(archived, plan=collection.plan())
    twice = replay(
        [*archived, *((ordinal + 100, payload) for ordinal, payload in archived)],
        plan=collection.plan(objects_named=len(archived) * 2),
    )

    assert once.outcome["objects_folded"] == len(archived)
    assert twice.outcome["objects_folded"] == len(archived) * 2
    assert twice.outcome["recomputed_sha256"] != once.outcome["recomputed_sha256"]


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
