"""The Snapshot_Builder — content addressing, the float guard, write-once, the bare
percentile-key guard, the derived-direction inversion and NIC-level honesty
(Req 28.4, 30.1, 30.5, 30.6, 30.9, 34.5, 34.9, 34.10).

Two shapes asserted here differ from design.md's snapshot example, deliberately, and
both were decided when `collect/snapshot.py` was written:

1. **`statistics` is a flat, sorted JSON array**, not a `metric -> statistic` map.
   design.md's `statistics["Percentage CPU"]["p95"]` nesting makes the statistic name
   an object key, which is precisely what Req 28.4 forbids "at any level". Req 28.5's
   percentile object carrying its own `metric` field only makes sense in a flat
   collection, and Req 34.8's "by metric name then statistic name" is an array sort
   key. `test_a_built_snapshot_containing_percentiles_has_no_bare_percentile_key`
   is the test that makes that reading checkable rather than arguable.
2. **Values carry the catalog-declared `scale`**, so `Percentage CPU` (`scale: 2`)
   emits `"12.48"` rather than design.md's `"12.480000"`. Req 34.1 asks for exactly
   the catalog's fractional digits; `collect/accumulate.py`'s six-place quantization
   is the *working* scale Req 27.11 pins for the division, not the serialization one.

The derived-inversion fixture is the centre of the file. It runs the **real shipped
catalog** — not an inline copy — through `derive_statistic` and `derived_statistics`
with three clearly separated available-memory readings, so a non-inverted
implementation fails on a single readable comparison
(`max_value > avg_value > min_value`) rather than on an estimator string a reader has
to interpret.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import re
from collections.abc import Mapping
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest
import rfc8785

from reporting_agent.catalog.loader import DerivedEntry, LoadedCatalog, MetricEntry, load_catalog
from reporting_agent.collect.accumulate import AccumulatorResult, DerivedValue, derive_statistic
from reporting_agent.collect.buckets import Window, resolve_window
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_PERMISSION_DENIED,
    record_gap,
)
from reporting_agent.collect.sketch import FixedHistogram
from reporting_agent.collect.snapshot import (
    CONTENT_HASH_FIELD,
    ESTIMATOR_DERIVED_COUNT_WEIGHTED,
    ESTIMATOR_DERIVED_FROM_SOURCE_MAXIMUM,
    ESTIMATOR_DERIVED_FROM_SOURCE_MINIMUM,
    FORBIDDEN_NETWORK_TERMS,
    NIC_LEVEL_COUNTER_SCOPE,
    SNAPSHOT_ID_FIELD,
    BillingTermError,
    FloatInSnapshotError,
    PercentileKeyError,
    ResourceDayBucket,
    ResourceSnapshot,
    SkuCapacity,
    StatisticEntry,
    assert_no_bare_percentile_keys,
    assert_no_floats,
    build_snapshot,
    canonical_bytes,
    content_hash,
    derived_statistics,
    exact_statistics,
    find_float,
    percentile_statistics,
    snapshot_key,
    verify_content_hash,
    write_once,
)
from reporting_agent.providers.base import GapRecord, PlainData, ResourceRecord, ScopeSpec
from reporting_agent.storage.base import JSON_CONTENT_TYPE, JsonValue, ObjectNotFoundError
from reporting_agent.storage.s3 import OWNER_TAG_KEY

RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"
SUBSCRIPTION_ID = "3f2b0000-0000-0000-0000-000000000000"
JAKARTA = ZoneInfo("Asia/Jakarta")
ACTOR_ID = "user_01HQZX"
RUN_ID = "run_01HQZY"

HEX64 = re.compile(r"\A[0-9a-f]{64}\Z")
RFC3339_Z = re.compile(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")
UTC_OFFSET = re.compile(r"\A[+-]\d{2}:\d{2}\Z")

# The inversion fixture's three readings, chosen far enough apart that no rounding,
# no off-by-one and no accidental reuse of the average could make two of the three
# derived directions agree: 10 GiB, 100 GiB and 200 GiB available against a 256 GiB
# SKU. The utilizations they produce are 96.09, 60.94 and 21.88 percent.
SKU_MEMORY_BYTES = Decimal("274877906944")  # 256 GiB
AVAILABLE_AVERAGE = Decimal("107374182400")  # 100 GiB
AVAILABLE_MINIMUM = Decimal("10737418240")  # 10 GiB
AVAILABLE_MAXIMUM = Decimal("214748364800")  # 200 GiB
SAMPLE_COUNT = 44_640

EXPECTED_MEMORY_USED_PCT = {
    "avg": Decimal("60.94"),  # (256 - 100) / 256 * 100
    "min": Decimal("21.88"),  # (256 - 200) / 256 * 100, half-to-even on 21.875
    "max": Decimal("96.09"),  # (256 -  10) / 256 * 100
}


# --- the shipped catalog, and the entries these tests read from it -------------------


@pytest.fixture(scope="module")
def catalog() -> LoadedCatalog:
    """The real `catalog/metrics.v1.json` shipped in the image.

    Loaded rather than hand-copied on purpose: the three-way `for_statistic`
    inversion, `Network In Total`'s `NIC-level bytes` label and its
    `interval_scoped` flag are facts about the shipped file, and a test carrying its
    own copy of them would keep passing after someone edited the real one.
    """
    return load_catalog()


def metric(catalog: LoadedCatalog, name: str) -> MetricEntry:
    resource_type = catalog.for_resource_type(RESOURCE_TYPE)
    assert resource_type is not None
    for entry in resource_type.metrics:
        if entry.name == name:
            return entry
    raise AssertionError(f"the shipped catalog declares no metric {name!r}")


def memory_used_pct(catalog: LoadedCatalog) -> DerivedEntry:
    resource_type = catalog.for_resource_type(RESOURCE_TYPE)
    assert resource_type is not None
    for entry in resource_type.derived:
        if entry.statistic_id == "memory_used_pct":
            return entry
    raise AssertionError("the shipped catalog declares no memory_used_pct")


# --- fixture builders ----------------------------------------------------------------


def resource_record(name: str, tags: dict[str, str] | None = None) -> ResourceRecord:
    return ResourceRecord(
        resource_id=(
            f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/"
            f"{RESOURCE_TYPE}/{name}"
        ),
        name=name,
        resource_type=RESOURCE_TYPE,
        location="southeastasia",
        resource_group="rg-prod",
        tags={"env": "prod"} if tags is None else tags,
        sku_name="Standard_E32-8s_v5",
        power_state_raw="PowerState/running",
        power_state="running",
        fidelity_tier="baseline",
    )


def scope_spec() -> ScopeSpec:
    return ScopeSpec(
        subscription_id=SUBSCRIPTION_ID,
        resource_types=[RESOURCE_TYPE],
        resource_groups=["rg-prod", "rg-dev"],
        tag_filters={"env": "prod"},
    )


def window() -> Window:
    return resolve_window(date(2026, 7, 1), date(2026, 7, 31), JAKARTA)


def cpu_result() -> AccumulatorResult:
    return AccumulatorResult(
        average=Decimal("12.48"),
        minimum=Decimal("0.31"),
        maximum=Decimal("97.22"),
        sample_count=Decimal(SAMPLE_COUNT),
    )


def network_result() -> AccumulatorResult:
    return AccumulatorResult(
        average=Decimal("48211993"),
        minimum=Decimal("120"),
        maximum=Decimal("99887766"),
        sample_count=Decimal(744),
    )


def cpu_histogram() -> FixedHistogram:
    sketch = FixedHistogram()
    for value in ("0.5", "9.25", "12.5", "68.4", "97.2"):
        sketch.fold(Decimal(value))
    return sketch


def memory_derived_values(catalog: LoadedCatalog) -> dict[str, DerivedValue]:
    """`derive_statistic` over the inversion fixture: three distinct available-memory
    readings against one SKU capacity, with no gaps expected."""
    entry = memory_used_pct(catalog)
    values, gaps = derive_statistic(
        entry,
        resource_id=resource_record("prod-sql-01")["resource_id"],
        metric_results={
            "Available Memory Bytes": AccumulatorResult(
                average=AVAILABLE_AVERAGE,
                minimum=AVAILABLE_MINIMUM,
                maximum=AVAILABLE_MAXIMUM,
                sample_count=Decimal(SAMPLE_COUNT),
            )
        },
        sku_capability_values={"MemoryGB": SKU_MEMORY_BYTES},
    )
    assert gaps == [], gaps
    return values


def statistics_for(catalog: LoadedCatalog) -> tuple[StatisticEntry, ...]:
    """One resource's full statistics array: exact CPU, exact NIC-level network,
    CPU percentiles from a folded sketch, and the three derived directions."""
    cpu = metric(catalog, "Percentage CPU")
    network = metric(catalog, "Network In Total")
    entry = memory_used_pct(catalog)
    return (
        *exact_statistics(cpu_result(), metric=cpu, fidelity_tier="baseline", grain="PT1H"),
        *exact_statistics(
            network_result(), metric=network, fidelity_tier="baseline", grain="PT1H"
        ),
        *percentile_statistics(
            cpu_histogram(), metric=cpu, fidelity_tier="baseline", grain="PT1H"
        ),
        *derived_statistics(
            memory_derived_values(catalog),
            entry=entry,
            fidelity_tier="baseline",
            sample_count=SAMPLE_COUNT,
        ),
    )


def gap_records() -> list[GapRecord]:
    return [
        record_gap(
            GAP_TYPE_PERMISSION_DENIED,
            f"/subscriptions/{SUBSCRIPTION_ID}/vm/legacy-dc-01",
            "Percentage CPU",
            "AuthorizationFailed on the resource",
        ),
        record_gap(
            GAP_TYPE_DEALLOCATED,
            f"/subscriptions/{SUBSCRIPTION_ID}/vm/prod-batch-02",
            None,
            "PowerState/deallocated",
        ),
    ]


def built_snapshot(
    catalog: LoadedCatalog,
    *,
    resources: list[ResourceSnapshot] | None = None,
    gaps: list[GapRecord] | None = None,
    run_id: str = RUN_ID,
) -> dict[str, PlainData]:
    """A realistic snapshot: two resources — one fully measured, one present with no
    statistics and an unresolved SKU — a day bucket, and two gaps.

    The two resources are handed in **reverse** id order so every ordering assertion
    is about an order this module produced rather than one the fixture supplied.
    """
    if resources is None:
        measured = ResourceSnapshot(
            record=resource_record("prod-sql-01"),
            sku=SkuCapacity("Standard_E32-8s_v5", 8, SKU_MEMORY_BYTES),
            statistics=statistics_for(catalog),
            day_buckets=(
                ResourceDayBucket(
                    date(2026, 7, 2),
                    24,
                    exact_statistics(
                        cpu_result(),
                        metric=metric(catalog, "Percentage CPU"),
                        fidelity_tier="baseline",
                        grain="PT1H",
                    ),
                ),
                ResourceDayBucket(date(2026, 7, 1), 17, ()),
            ),
        )
        unmeasured = ResourceSnapshot(
            record=resource_record("app-web-01"),
            sku=SkuCapacity("Standard_D2s_v5"),
        )
        resources = [measured, unmeasured]

    return build_snapshot(
        invocation_started_at=None,
        run_id=run_id,
        scope=scope_spec(),
        scope_verified=True,
        collected_at=datetime(2026, 8, 1, 9, 22, 7, 654321, tzinfo=UTC),
        timezone_name="Asia/Jakarta",
        tz=JAKARTA,
        window=window(),
        grain="PT1H",
        metrics_by_resource_type={
            RESOURCE_TYPE: ["Percentage CPU", "Network In Total", "Available Memory Bytes"]
        },
        resources=resources,
        gaps=gap_records() if gaps is None else gaps,
        catalog_version=catalog.catalog_version,
        raw_archive_complete=False,
        raw_archive_object_count=87,
    )


class InMemoryObjectStore:
    """An in-memory `ObjectStore` with real conditional-put semantics.

    Defined here rather than in `tests/fakes/` on purpose: the shared fake belongs to
    a later task, and two files racing to create it would collide. `put_bytes_if_absent`
    is the only method these tests lean on for behaviour — it refuses a second write at
    an occupied key and leaves the stored bytes untouched, which is exactly what
    `PutObject` with `IfNoneMatch: "*"` does and exactly what Req 34.9 requires.
    """

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        self.tags: dict[str, dict[str, str]] = {}
        self.rejected: list[str] = []

    async def put_bytes(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = "application/octet-stream",
        tags: Mapping[str, str] | None = None,
    ) -> None:
        self.objects[key] = body
        self.content_types[key] = content_type
        self.tags[key] = dict(tags or {})

    async def put_bytes_if_absent(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = "application/octet-stream",
        tags: Mapping[str, str] | None = None,
    ) -> bool:
        if key in self.objects:
            self.rejected.append(key)
            return False
        await self.put_bytes(key, body, content_type=content_type, tags=tags)
        return True

    async def get_json(self, key: str) -> dict[str, JsonValue]:
        if key not in self.objects:
            raise ObjectNotFoundError(key)
        parsed = json.loads(self.objects[key].decode("utf-8"))
        assert isinstance(parsed, dict)
        return parsed


# --- A. content addressing and the two hash fields (Req 34.5) -----------------------


def test_snapshot_id_equals_content_hash_and_both_are_64_lowercase_hex(
    catalog: LoadedCatalog,
) -> None:
    """Req 34.3, 34.5 — one digest, in two fields, character for character."""
    document = built_snapshot(catalog)

    assert HEX64.match(str(document[CONTENT_HASH_FIELD]))
    assert document[SNAPSHOT_ID_FIELD] == document[CONTENT_HASH_FIELD]
    verify_content_hash(document)


def test_recomputing_the_hash_over_the_returned_document_is_not_circular(
    catalog: LoadedCatalog,
) -> None:
    """Req 34.4 — the two hash fields are excluded at the top level, so hashing the
    *returned* document (which carries both) reproduces the same digest."""
    document = built_snapshot(catalog)

    assert content_hash(document) == document[CONTENT_HASH_FIELD]


def test_two_builds_over_the_same_inputs_produce_the_same_digest(
    catalog: LoadedCatalog,
) -> None:
    first = built_snapshot(catalog)
    second = built_snapshot(catalog)

    assert first[CONTENT_HASH_FIELD] == second[CONTENT_HASH_FIELD]
    assert canonical_bytes(first) == canonical_bytes(second)


def test_a_document_mutated_after_it_was_built_fails_verification(
    catalog: LoadedCatalog,
) -> None:
    """Req 34.5 — the check that catches a document changed on the way to the store."""
    document = built_snapshot(catalog)
    resources = document["resources"]
    assert isinstance(resources, list)
    measured = resources[1]
    assert isinstance(measured, dict)
    statistics = measured["statistics"]
    assert isinstance(statistics, list)
    leaf = statistics[0]
    assert isinstance(leaf, dict)
    leaf["value"] = "999999"

    with pytest.raises(ValueError, match=CONTENT_HASH_FIELD):
        verify_content_hash(document)


def test_a_snapshot_id_replaced_by_another_identifier_fails_verification(
    catalog: LoadedCatalog,
) -> None:
    """Req 34.5 — nothing but the digest may occupy the `snapshot_id` position."""
    document = built_snapshot(catalog)
    document[SNAPSHOT_ID_FIELD] = "snap_01HQZZ"

    with pytest.raises(ValueError, match=SNAPSHOT_ID_FIELD):
        verify_content_hash(document)


def test_a_different_run_id_produces_a_different_digest(catalog: LoadedCatalog) -> None:
    """Content addressing at its most basic: two documents differing in one field are
    not the same snapshot."""
    first = built_snapshot(catalog, run_id="run_A")
    second = built_snapshot(catalog, run_id="run_B")

    assert first[CONTENT_HASH_FIELD] != second[CONTENT_HASH_FIELD]


# --- B. the float guard names the field path (Req 34.10) ----------------------------


def test_a_float_is_reported_with_its_full_field_path() -> None:
    """Req 34.10 — the error names the offending field path, in
    `providers.base.find_non_plain`'s `$.field[0].sub` convention."""
    document = {
        "resources": [
            {"statistics": [{"value": "12.48"}]},
            {"statistics": [{"value": 1.5}]},
        ]
    }

    with pytest.raises(FloatInSnapshotError) as raised:
        assert_no_floats(document)

    assert raised.value.path == "$.resources[1].statistics[0].value"


def test_a_float_at_the_top_level_a_list_element_and_a_nested_key_each_report_their_path() -> None:
    assert find_float(1.5) == "$"
    assert find_float([{"a": 1}, 2.5]) == "$[1]"
    assert find_float({"producer": {"agent_version": 0.1}}) == "$.producer.agent_version"


def test_the_float_guard_does_not_report_a_decimal_or_an_int_or_a_bool() -> None:
    """A `Decimal` is the correct type on the value path before serialization; only a
    `float` is the thing whose cross-platform equality an audit artifact cannot rest
    on."""
    assert find_float({"value": Decimal("1.5"), "count": 744, "complete": True}) is None


def test_the_float_guard_passes_over_a_real_built_snapshot(catalog: LoadedCatalog) -> None:
    document = built_snapshot(catalog)

    assert find_float(document) is None
    assert_no_floats(document)


def test_canonicalization_refuses_a_float_bearing_document_so_none_reaches_a_digest() -> None:
    """Req 34.10 — `canonical_bytes` runs the guard itself, so no float can reach the
    serializer even if a caller skipped the standalone assertion."""
    document: dict[str, Any] = {"run_id": "run_1", "resources": [{"value": 0.30000000000000004}]}

    with pytest.raises(FloatInSnapshotError) as raised:
        canonical_bytes(document)

    assert raised.value.path == "$.resources[0].value"

    with pytest.raises(FloatInSnapshotError):
        content_hash(document)


def test_the_float_error_message_names_the_path_and_not_the_value() -> None:
    """The path is diagnostic; the value is not, and an offending value quoted from an
    Azure error could carry a credential."""
    with pytest.raises(FloatInSnapshotError) as raised:
        assert_no_floats({"gaps": [{"message": 1.2345}]})

    assert "$.gaps[0].message" in str(raised.value)
    assert "1.2345" not in str(raised.value)


# --- C. write-once semantics (Req 34.9, 35.6) ---------------------------------------


def test_the_first_write_stores_the_document_at_the_actor_scoped_key(
    catalog: LoadedCatalog,
) -> None:
    """Req 35.6 — `<actor_id>/snapshots/<runId>/snapshot.json`, tagged with the owner."""
    store = InMemoryObjectStore()
    document = built_snapshot(catalog)

    written = asyncio.run(write_once(store, document, actor_id=ACTOR_ID, run_id=RUN_ID))

    key = f"{ACTOR_ID}/snapshots/{RUN_ID}/snapshot.json"
    assert written is True
    assert list(store.objects) == [key]
    assert store.tags[key] == {OWNER_TAG_KEY: ACTOR_ID}
    assert store.content_types[key] == JSON_CONTENT_TYPE


def test_a_second_write_returns_false_and_leaves_the_stored_bytes_byte_identical(
    catalog: LoadedCatalog,
) -> None:
    """Req 34.9 — the core assertion. A second document at the same key changes
    nothing: the existing bytes stay exactly as written and no second object appears.
    """
    store = InMemoryObjectStore()
    first = built_snapshot(catalog)
    second = built_snapshot(
        catalog,
        gaps=[
            record_gap(
                GAP_TYPE_DEALLOCATED,
                f"/subscriptions/{SUBSCRIPTION_ID}/vm/other-01",
                None,
                "PowerState/deallocated",
            )
        ],
    )
    assert first[CONTENT_HASH_FIELD] != second[CONTENT_HASH_FIELD]

    key = f"{ACTOR_ID}/snapshots/{RUN_ID}/snapshot.json"
    assert asyncio.run(write_once(store, first, actor_id=ACTOR_ID, run_id=RUN_ID)) is True
    stored_after_first = store.objects[key]

    assert asyncio.run(write_once(store, second, actor_id=ACTOR_ID, run_id=RUN_ID)) is False

    assert store.objects[key] == stored_after_first
    assert len(store.objects) == 1
    assert store.rejected == [key]


def test_the_rejected_second_write_is_recorded_in_a_log_line(
    catalog: LoadedCatalog, caplog: pytest.LogCaptureFixture
) -> None:
    """Req 34.9's third clause — the attempt is recorded, not silently dropped."""
    store = InMemoryObjectStore()
    document = built_snapshot(catalog)
    asyncio.run(write_once(store, document, actor_id=ACTOR_ID, run_id=RUN_ID))

    with caplog.at_level("WARNING", logger="reporting_agent.collect.snapshot"):
        asyncio.run(write_once(store, document, actor_id=ACTOR_ID, run_id=RUN_ID))

    assert caplog.records, "a refused write logged nothing"
    assert f"{ACTOR_ID}/snapshots/{RUN_ID}/snapshot.json" in caplog.text


def test_the_stored_body_round_trips_and_carries_both_hash_fields(
    catalog: LoadedCatalog,
) -> None:
    """Only the *hash input* excludes the two fields (Req 34.4); the stored object
    carries them, which is what lets a reader check the id against the bytes."""
    store = InMemoryObjectStore()
    document = built_snapshot(catalog)
    asyncio.run(write_once(store, document, actor_id=ACTOR_ID, run_id=RUN_ID))

    key = f"{ACTOR_ID}/snapshots/{RUN_ID}/snapshot.json"
    body = json.loads(store.objects[key].decode("utf-8"))

    assert body[CONTENT_HASH_FIELD] == document[CONTENT_HASH_FIELD]
    assert body[SNAPSHOT_ID_FIELD] == document[CONTENT_HASH_FIELD]
    assert store.objects[key] == rfc8785.dumps(dict(document))


def test_a_tampered_document_is_refused_and_nothing_is_written(
    catalog: LoadedCatalog,
) -> None:
    """`write_once` verifies before it writes, so no object lands under an id it does
    not actually have."""
    store = InMemoryObjectStore()
    document = built_snapshot(catalog)
    document["grain"] = "PT15M"

    with pytest.raises(ValueError, match=CONTENT_HASH_FIELD):
        asyncio.run(write_once(store, document, actor_id=ACTOR_ID, run_id=RUN_ID))

    assert store.objects == {}


def test_the_snapshot_key_puts_the_actor_id_first() -> None:
    """Req 35.6 — first-segment ownership, which is what makes download authorization
    a segment comparison rather than a prefix match."""
    key = snapshot_key("alice", "run_1")

    assert key == "alice/snapshots/run_1/snapshot.json"
    assert key.split("/")[0] == "alice"


@pytest.mark.parametrize(
    ("actor_id", "run_id"),
    [
        ("", "run_1"),
        ("   ", "run_1"),
        ("alice", ""),
        ("alice/evil", "run_1"),
        ("alice", "run/1"),
    ],
)
def test_the_snapshot_key_rejects_an_empty_or_slash_bearing_component(
    actor_id: str, run_id: str
) -> None:
    with pytest.raises(ValueError, match=r"actor_id|run_id"):
        snapshot_key(actor_id, run_id)


# --- D. no object key is `p` followed only by digits (Req 28.4) ---------------------


def test_a_built_snapshot_containing_percentiles_has_no_bare_percentile_key(
    catalog: LoadedCatalog,
) -> None:
    """Req 28.4 over a document that genuinely carries `p50`, `p90`, `p95` and `p99`.

    The point is that they appear as `statistic` *values* inside a flat array, never
    as object keys — which is what the flat-array deviation from design.md buys.
    """
    document = built_snapshot(catalog)

    assert_no_bare_percentile_keys(document)

    resources = document["resources"]
    assert isinstance(resources, list)
    measured = resources[1]
    assert isinstance(measured, dict)
    statistics = measured["statistics"]
    assert isinstance(statistics, list)
    emitted = {entry["statistic"] for entry in statistics if isinstance(entry, dict)}
    assert {"p50", "p90", "p95", "p99"} <= emitted


def test_a_metric_to_statistic_map_shape_is_rejected_with_the_offending_path_and_key() -> None:
    """The shape design.md's example shows: the statistic name becomes an object key,
    which Req 28.4 forbids at any level."""
    document = {
        "resources": [
            {"statistics": {"Percentage CPU": {"p95": {"value": "68.40"}}}},
        ]
    }

    with pytest.raises(PercentileKeyError) as raised:
        assert_no_bare_percentile_keys(document)

    assert raised.value.key == "p95"
    assert raised.value.path == "$.resources[0].statistics.Percentage CPU"


@pytest.mark.parametrize("key", ["p95", "p99", "p1", "p0", "p100", "p0000"])
def test_every_spelling_of_p_followed_only_by_digits_is_refused(key: str) -> None:
    with pytest.raises(PercentileKeyError) as raised:
        assert_no_bare_percentile_keys({"resources": [{"day_buckets": [{key: 1}]}]})

    assert raised.value.key == key
    assert raised.value.path == "$.resources[0].day_buckets[0]"


@pytest.mark.parametrize("key", ["p95x", "pp95", "percentile95", "p", "P95", "p9_5", "95p"])
def test_a_key_that_is_not_p_followed_only_by_digits_is_allowed(key: str) -> None:
    """The pattern is `p` followed by *only* digits, at least one of them. Widening it
    would start rejecting ordinary field names."""
    assert_no_bare_percentile_keys({"resources": [{key: "fine"}]})


def test_build_snapshot_itself_refuses_a_percentile_key_reaching_it_through_a_tag(
    catalog: LoadedCatalog,
) -> None:
    """Req 28.4 is enforced by the builder, not only checkable after the fact. A
    resource tag is the one caller-supplied object whose keys the builder does not
    choose, so it is where the guard has to hold."""
    tagged = ResourceSnapshot(
        record=resource_record("prod-sql-01", tags={"p95": "why-would-you"}),
        sku=SkuCapacity("Standard_E32-8s_v5", 8, SKU_MEMORY_BYTES),
    )

    with pytest.raises(PercentileKeyError) as raised:
        built_snapshot(catalog, resources=[tagged])

    assert raised.value.key == "p95"
    assert raised.value.path.endswith(".tags")


# --- E. the derived-direction inversion (Req 30.1, 30.2, 30.3, 30.4, 30.9) ---------


def test_maximum_memory_utilization_comes_from_the_minimum_available_memory(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.1 — the expression inverts the direction of its source metric, so the
    *minimum* of `Available Memory Bytes` feeds *maximum* utilization.

    10 GiB available of a 256 GiB SKU is 96.09% used.
    """
    entries = {
        entry.statistic: entry
        for entry in derived_statistics(
            memory_derived_values(catalog),
            entry=memory_used_pct(catalog),
            fidelity_tier="baseline",
            sample_count=SAMPLE_COUNT,
        )
    }

    maximum = entries["max"]
    assert maximum.value == EXPECTED_MEMORY_USED_PCT["max"] == Decimal("96.09")
    assert maximum.estimator == ESTIMATOR_DERIVED_FROM_SOURCE_MINIMUM
    metric_refs = [ref for ref in maximum.derived_from if ref.kind == "metric"]
    assert [(ref.name, ref.statistic) for ref in metric_refs] == [
        ("Available Memory Bytes", "min")
    ]


def test_minimum_memory_utilization_comes_from_the_maximum_available_memory(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.1, the other half: 200 GiB available of a 256 GiB SKU is 21.88% used."""
    entries = {
        entry.statistic: entry
        for entry in derived_statistics(
            memory_derived_values(catalog),
            entry=memory_used_pct(catalog),
            fidelity_tier="baseline",
            sample_count=SAMPLE_COUNT,
        )
    }

    minimum = entries["min"]
    assert minimum.value == EXPECTED_MEMORY_USED_PCT["min"] == Decimal("21.88")
    assert minimum.estimator == ESTIMATOR_DERIVED_FROM_SOURCE_MAXIMUM
    metric_refs = [ref for ref in minimum.derived_from if ref.kind == "metric"]
    assert [(ref.name, ref.statistic) for ref in metric_refs] == [
        ("Available Memory Bytes", "max")
    ]


def test_average_memory_utilization_comes_from_the_count_weighted_average(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.1 — the average direction is not inverted: 100 GiB available of 256 GiB
    is 60.94% used."""
    entries = {
        entry.statistic: entry
        for entry in derived_statistics(
            memory_derived_values(catalog),
            entry=memory_used_pct(catalog),
            fidelity_tier="baseline",
            sample_count=SAMPLE_COUNT,
        )
    }

    average = entries["avg"]
    assert average.value == EXPECTED_MEMORY_USED_PCT["avg"] == Decimal("60.94")
    assert average.estimator == ESTIMATOR_DERIVED_COUNT_WEIGHTED
    metric_refs = [ref for ref in average.derived_from if ref.kind == "metric"]
    assert [(ref.name, ref.statistic) for ref in metric_refs] == [
        ("Available Memory Bytes", "avg")
    ]


def test_the_three_derived_directions_are_ordered_max_then_avg_then_min(
    catalog: LoadedCatalog,
) -> None:
    """The assertion that fails loudly on a non-inverted implementation: reading the
    minimum available memory for the minimum utilization would put these three the
    other way round."""
    entries = {
        entry.statistic: entry.value
        for entry in derived_statistics(
            memory_derived_values(catalog),
            entry=memory_used_pct(catalog),
            fidelity_tier="baseline",
            sample_count=SAMPLE_COUNT,
        )
    }

    assert entries["max"] > entries["avg"] > entries["min"]


def test_every_derived_value_carries_a_non_empty_formula_and_derived_from(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.9 — a derived number without its derivation is an assertion, not a
    measurement, so both fields are present on every direction."""
    entry = memory_used_pct(catalog)
    entries = derived_statistics(
        memory_derived_values(catalog),
        entry=entry,
        fidelity_tier="baseline",
        sample_count=SAMPLE_COUNT,
    )

    assert len(entries) == 3
    for emitted in entries:
        data = emitted.to_plain_data()
        assert data["formula"] == entry.formula
        assert isinstance(data["derived_from"], list)
        assert len(data["derived_from"]) == 2


def test_the_formula_is_the_catalog_string_and_is_identical_across_all_three_directions(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.3 — the same declared expression string, byte for byte, every time."""
    entry = memory_used_pct(catalog)
    formulas = {
        emitted.formula
        for emitted in derived_statistics(
            memory_derived_values(catalog),
            entry=entry,
            fidelity_tier="baseline",
            sample_count=SAMPLE_COUNT,
        )
    }

    assert formulas == {
        "(sku_memory_bytes - available_memory_bytes) / sku_memory_bytes * 100"
    }
    assert formulas == {entry.formula}


def test_derived_from_is_ordered_identically_across_all_three_directions(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.2 — metric sources first in catalog order, then SKU-capability sources,
    so the canonical form does not depend on which direction was computed first."""
    shapes = [
        [(ref.kind, ref.name) for ref in emitted.derived_from]
        for emitted in derived_statistics(
            memory_derived_values(catalog),
            entry=memory_used_pct(catalog),
            fidelity_tier="baseline",
            sample_count=SAMPLE_COUNT,
        )
    ]

    assert shapes == [
        [("metric", "Available Memory Bytes"), ("sku_capability", "MemoryGB")]
    ] * 3


def test_the_sku_capability_ref_carries_the_capacity_as_a_decimal_string_with_its_unit(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.2's second shape: one SKU capability name together with the capacity
    resolved for it as a decimal string, with its unit."""
    first = derived_statistics(
        memory_derived_values(catalog),
        entry=memory_used_pct(catalog),
        fidelity_tier="baseline",
        sample_count=SAMPLE_COUNT,
    )[0]

    sku_refs = [ref for ref in first.derived_from if ref.kind == "sku_capability"]
    assert [ref.to_plain_data() for ref in sku_refs] == [
        {
            "kind": "sku_capability",
            "name": "MemoryGB",
            "value": str(SKU_MEMORY_BYTES),
            "unit": "bytes",
        }
    ]


def test_the_host_observed_marker_and_its_note_ride_on_the_value_object(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.4 — on the value, not at the snapshot's top level, so every consumer of
    the number receives the caveat with it."""
    entry = memory_used_pct(catalog)
    entries = derived_statistics(
        memory_derived_values(catalog),
        entry=entry,
        fidelity_tier="baseline",
        sample_count=SAMPLE_COUNT,
    )

    for emitted in entries:
        data = emitted.to_plain_data()
        assert data["observation"] == "host_observed"
        assert data["note"] == entry.note
        assert "1-3 percentage points below the guest-reported value" in str(data["note"])


@pytest.mark.parametrize("field_name", ["formula", "derived_from"])
def test_a_derived_value_missing_its_formula_or_its_derived_from_is_refused(
    catalog: LoadedCatalog, field_name: str
) -> None:
    """Req 30.9 has no emit-anyway path: an empty derivation raises rather than
    producing a number nobody can trace."""
    values = memory_derived_values(catalog)
    empty: str | tuple[()] = "" if field_name == "formula" else ()
    broken = {
        direction: dataclasses.replace(value, **{field_name: empty})
        for direction, value in values.items()
    }

    with pytest.raises(ValueError, match=r"Req 30\.9"):
        derived_statistics(
            broken,
            entry=memory_used_pct(catalog),
            fidelity_tier="baseline",
            sample_count=SAMPLE_COUNT,
        )


def test_the_derived_values_appear_in_the_built_snapshot_with_their_derivation(
    catalog: LoadedCatalog,
) -> None:
    """The end-to-end shape: the derived entries survive into the document carrying
    `formula`, `derived_from`, `observation` and `note`."""
    document = built_snapshot(catalog)
    resources = document["resources"]
    assert isinstance(resources, list)
    measured = resources[1]
    assert isinstance(measured, dict)
    statistics = measured["statistics"]
    assert isinstance(statistics, list)

    derived = [
        entry
        for entry in statistics
        if isinstance(entry, dict) and entry["metric"] == "memory_used_pct"
    ]
    assert {entry["statistic"] for entry in derived} == {"avg", "min", "max"}
    for entry in derived:
        assert entry["formula"]
        assert entry["derived_from"]
        assert entry["observation"] == "host_observed"
    by_statistic = {str(entry["statistic"]): str(entry["value"]) for entry in derived}
    assert by_statistic == {"avg": "60.94", "min": "21.88", "max": "96.09"}


# --- F. NIC-level labelling and the billing-term exclusion (Req 30.5, 30.6) --------


def test_a_network_total_is_labelled_nic_level_with_its_interval_and_unit(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.5 — a NIC-level counter, in bytes, carrying the length of the interval
    the total covers, because a total without its interval is not a rate."""
    entries = exact_statistics(
        network_result(),
        metric=metric(catalog, "Network In Total"),
        fidelity_tier="baseline",
        grain="PT1H",
    )

    assert [entry.statistic for entry in entries] == ["avg", "min", "max"]
    for entry in entries:
        assert entry.counter_scope == NIC_LEVEL_COUNTER_SCOPE
        assert entry.interval == "PT1H"
        assert entry.unit == "bytes"
        assert entry.label == "NIC-level bytes"


def test_a_non_interval_scoped_metric_carries_no_counter_scope_and_no_interval(
    catalog: LoadedCatalog,
) -> None:
    """`Percentage CPU` is neither a NIC counter nor a total over an interval, so
    neither field applies and neither is emitted as `null`."""
    entries = exact_statistics(
        cpu_result(),
        metric=metric(catalog, "Percentage CPU"),
        fidelity_tier="baseline",
        grain="PT1H",
    )

    for entry in entries:
        assert entry.counter_scope is None
        assert entry.interval is None
        data = entry.to_plain_data()
        assert "counter_scope" not in data
        assert "interval" not in data


def _string_fields(data: Mapping[str, PlainData]) -> list[tuple[str, str]]:
    """Every string field of a statistic object, including each `derived_from` entry's
    own strings — the fields Req 30.6 enumerates plus the two this builder adds."""
    collected: list[tuple[str, str]] = []
    for key, value in data.items():
        if isinstance(value, str):
            collected.append((key, value))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                if isinstance(item, dict):
                    collected.extend(
                        (f"{key}[{index}].{sub_key}", sub_value)
                        for sub_key, sub_value in item.items()
                        if isinstance(sub_value, str)
                    )
    return collected


def test_no_string_field_of_a_nic_level_value_carries_a_billing_term(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.6 — `egress`, `transfer cost`, `bandwidth charge` and `billable`, in any
    casing, across the label, `unit`, `statistic`, `estimator`, `counter_scope`,
    `formula` and every `derived_from` entry."""
    entries = exact_statistics(
        network_result(),
        metric=metric(catalog, "Network In Total"),
        fidelity_tier="baseline",
        grain="PT1H",
    )

    checked = 0
    for entry in entries:
        for where, text in _string_fields(entry.to_plain_data()):
            for term in FORBIDDEN_NETWORK_TERMS:
                assert term not in text.casefold(), f"{where} carries {term!r}: {text!r}"
            checked += 1
    assert checked >= len(entries) * 6


def test_the_built_snapshots_nic_level_values_carry_no_billing_term(
    catalog: LoadedCatalog,
) -> None:
    """The same rule over the emitted document, so a field added between the statistic
    object and the snapshot cannot smuggle a term past the unit-level check."""
    document = built_snapshot(catalog)
    resources = document["resources"]
    assert isinstance(resources, list)

    nic_values = 0
    for resource in resources:
        assert isinstance(resource, dict)
        statistics = resource["statistics"]
        assert isinstance(statistics, list)
        for entry in statistics:
            if not isinstance(entry, dict):
                continue
            if entry.get("counter_scope") != NIC_LEVEL_COUNTER_SCOPE:
                continue
            nic_values += 1
            assert entry["interval"] == "PT1H"
            assert entry["unit"] == "bytes"
            for where, text in _string_fields(entry):
                for term in FORBIDDEN_NETWORK_TERMS:
                    assert term not in text.casefold(), f"{where} carries {term!r}"

    assert nic_values == 3


@pytest.mark.parametrize(
    ("label", "term"),
    [
        ("NIC-level bytes (billable egress)", "egress"),
        ("NIC-level bytes — BILLABLE", "billable"),
        ("NIC-level bytes, includes Transfer Cost", "transfer cost"),
        ("NIC-level bytes / Bandwidth Charge", "bandwidth charge"),
    ],
)
def test_a_nic_level_label_carrying_a_billing_term_is_refused(
    catalog: LoadedCatalog, label: str, term: str
) -> None:
    """Req 30.6 is enforced, not merely absent by luck: the catalog supplies the label,
    and a well-meaning edit to it must fail rather than ship."""
    tampered = dataclasses.replace(metric(catalog, "Network In Total"), label=label)

    with pytest.raises(BillingTermError) as raised:
        exact_statistics(
            network_result(), metric=tampered, fidelity_tier="baseline", grain="PT1H"
        )

    assert raised.value.term == term
    assert raised.value.where == "label"
    assert raised.value.metric == "Network In Total"


def test_the_same_billing_term_in_a_non_nic_metrics_label_is_not_this_rule(
    catalog: LoadedCatalog,
) -> None:
    """Req 30.5 and 30.6 are about values derived from the two NIC counters. A label on
    an unrelated metric is a different (and non-existent) problem, and widening the
    check to every metric would be asserting something the requirement does not say."""
    tampered = dataclasses.replace(
        metric(catalog, "Percentage CPU"), label="billable egress"
    )

    entries = exact_statistics(
        cpu_result(), metric=tampered, fidelity_tier="baseline", grain="PT1H"
    )

    assert entries[0].label == "billable egress"


# --- G. field inventory sanity (Req 35.1, 35.3, 35.8, 35.9) ------------------------


def test_the_document_carries_every_declared_top_level_field(catalog: LoadedCatalog) -> None:
    """Req 35.1, 35.2, 35.8, 35.9 — the whole inventory, in one assertion, so a field
    quietly dropped fails here rather than in a downstream consumer."""
    document = built_snapshot(catalog)

    assert set(document) == {
        "schema_version",
        "producer",
        "snapshot_id",
        "content_hash",
        "run_id",
        "subscription_id",
        "scope_verified",
        "collected_at",
        "timezone",
        "utc_offset",
        "grain",
        "window",
        "requested_scope",
        "raw_archive",
        "resources",
        "gaps",
    }
    producer = document["producer"]
    assert isinstance(producer, dict)
    assert set(producer) == {"agent_version", "catalog_version"}
    assert producer["catalog_version"] == catalog.catalog_version
    window_fields = document["window"]
    assert isinstance(window_fields, dict)
    assert set(window_fields) == {"start", "end", "start_utc", "end_utc"}
    archive = document["raw_archive"]
    assert isinstance(archive, dict)
    assert archive == {"complete": False, "object_count": 87}


def test_collected_at_is_whole_second_rfc3339_and_the_offset_is_jakartas(
    catalog: LoadedCatalog,
) -> None:
    """Req 35.1 — a `Z` designator, whole seconds (truncated, not rounded), and the
    zone's resolved offset as `+HH:MM`."""
    document = built_snapshot(catalog)

    assert RFC3339_Z.match(str(document["collected_at"]))
    assert document["collected_at"] == "2026-08-01T09:22:07Z"
    assert UTC_OFFSET.match(str(document["utc_offset"]))
    assert document["utc_offset"] == "+07:00"
    assert document["timezone"] == "Asia/Jakarta"
    window_fields = document["window"]
    assert isinstance(window_fields, dict)
    assert window_fields == {
        "start": "2026-07-01",
        "end": "2026-07-31",
        "start_utc": "2026-06-30T17:00:00Z",
        "end_utc": "2026-07-31T17:00:00Z",
    }


def test_resources_gaps_statistics_and_day_buckets_are_all_sorted(
    catalog: LoadedCatalog,
) -> None:
    """Req 34.8 — every array order is produced here, not inherited from the order the
    fixture supplied (which is reversed for resources, gaps and day buckets alike)."""
    document = built_snapshot(catalog)

    resources = document["resources"]
    assert isinstance(resources, list)
    ids = [resource["resource_id"] for resource in resources if isinstance(resource, dict)]
    assert ids == sorted(ids)
    assert len(ids) == 2

    gaps = document["gaps"]
    assert isinstance(gaps, list)
    assert [
        (gap["gap_type"], gap["resource_id"], gap["metric"] or "")
        for gap in gaps
        if isinstance(gap, dict)
    ] == sorted(
        (gap["gap_type"], gap["resource_id"], gap["metric"] or "")
        for gap in gaps
        if isinstance(gap, dict)
    )

    for resource in resources:
        assert isinstance(resource, dict)
        statistics = resource["statistics"]
        assert isinstance(statistics, list)
        keys = [
            (entry["metric"], entry["statistic"])
            for entry in statistics
            if isinstance(entry, dict)
        ]
        assert keys == sorted(keys)

        buckets = resource["day_buckets"]
        assert isinstance(buckets, list)
        days = [bucket["local_day"] for bucket in buckets if isinstance(bucket, dict)]
        assert days == sorted(days)


def test_a_day_bucket_keeps_its_real_slot_count_and_a_flat_statistics_array(
    catalog: LoadedCatalog,
) -> None:
    """A partial edge day is neither padded to 24 nor dropped, and a day's statistics
    take the same flat shape as a window's."""
    document = built_snapshot(catalog)
    resources = document["resources"]
    assert isinstance(resources, list)
    measured = resources[1]
    assert isinstance(measured, dict)
    buckets = measured["day_buckets"]
    assert isinstance(buckets, list)

    assert [
        (bucket["local_day"], bucket["slot_count"])
        for bucket in buckets
        if isinstance(bucket, dict)
    ] == [("2026-07-01", 17), ("2026-07-02", 24)]
    second = buckets[1]
    assert isinstance(second, dict)
    assert isinstance(second["statistics"], list)


def test_the_sku_object_carries_both_capacities_as_strings(catalog: LoadedCatalog) -> None:
    """Req 35.3 — the memory capacity is a decimal string, and `vcpus_available` follows
    the same convention so nothing in a `sku` object is a number token."""
    document = built_snapshot(catalog)
    resources = document["resources"]
    assert isinstance(resources, list)
    measured = resources[1]
    assert isinstance(measured, dict)

    assert measured["sku"] == {
        "name": "Standard_E32-8s_v5",
        "vcpus_available": "8",
        "memory_bytes": "274877906944",
    }


def test_an_unresolved_sku_capability_omits_the_field_rather_than_emitting_zero(
    catalog: LoadedCatalog,
) -> None:
    """A capacity that could not be resolved is absent, never a zero that would read as
    a measurement — the same rule as Req 35.10 applies to a statistic."""
    document = built_snapshot(catalog)
    resources = document["resources"]
    assert isinstance(resources, list)
    unmeasured = resources[0]
    assert isinstance(unmeasured, dict)

    assert unmeasured["sku"] == {"name": "Standard_D2s_v5"}
    assert unmeasured["statistics"] == []


def test_a_resource_with_no_statistics_stays_in_the_snapshot(catalog: LoadedCatalog) -> None:
    """Req 29.8 — an unreadable resource is visible rather than absent, because
    "absent" and "measured at zero" are the two readings this module keeps apart."""
    document = built_snapshot(catalog)
    resources = document["resources"]
    assert isinstance(resources, list)

    names = [resource["name"] for resource in resources if isinstance(resource, dict)]
    assert names == ["app-web-01", "prod-sql-01"]


def test_the_requested_scope_is_recorded_with_every_array_sorted(
    catalog: LoadedCatalog,
) -> None:
    """Req 35.9 — the requested resource types, resource groups, tag filters and the
    metric names requested per resource type, each array ordered here."""
    document = built_snapshot(catalog)

    assert document["requested_scope"] == {
        "resource_types": [RESOURCE_TYPE],
        "resource_groups": ["rg-dev", "rg-prod"],
        "tag_filters": {"env": "prod"},
        "metrics_by_resource_type": {
            RESOURCE_TYPE: [
                "Available Memory Bytes",
                "Network In Total",
                "Percentage CPU",
            ]
        },
    }
    assert document["scope_verified"] is True
    assert document["subscription_id"] == SUBSCRIPTION_ID
