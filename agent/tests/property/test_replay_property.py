"""Property 4: Replay produces a bit-identical snapshot digest.

**Validates: Requirements 31.1, 31.2, 31.4, 9.13, 45.1**

*For any* set of archived raw responses, re-running the pure aggregation produces a snapshot
digest equal to the one the original aggregation produced, identically across two operating-
system processes with different interpreter hash-randomization seeds, with zero network
requests and each archived object folded exactly once.

**On what "the original" means here.** A property cannot run a real Azure collection per
example, so the correctness half of 4.1 — *the recomputed digest equals the digest the
collector computed* — is asserted in `tests/test_verify_replay.py`, over a real collection
through the production provider assembly, and the two-process clause is asserted there too
over that same real archive. What the property adds is everything that needs scale and
adversarial input: determinism over 1–200 generated objects, sensitivity to any single value
mutation, the fold count, and purity under a blocked socket.

Splitting it this way keeps both halves honest. A property that replayed its own output and
compared would assert that a function equals itself, which is true of the implementation
this property is meant to kill: one that reads the stored `snapshot_id` and returns it.
Assertion 4.4 is what kills that one, and it needs generated mutations rather than a real
collection.
"""

from __future__ import annotations

import gzip
import json
import socket
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Final
from zoneinfo import ZoneInfo

from hypothesis import example, given
from hypothesis import strategies as st

from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.buckets import resolve_window
from reporting_agent.collect.snapshot import ResourceDayBucket, SkuCapacity
from reporting_agent.providers.base import ScopeSpec
from reporting_agent.verify.findings import (
    FINDING_ARCHIVE_INCOMPLETE,
    FINDING_REPLAY_HASH_MISMATCH,
)
from reporting_agent.verify.replay import ReplayPlan, ReplayResource, replay

SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
RESOURCE_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
LOCATION: Final[str] = "southeastasia"
GROUP: Final[str] = "rg-prod-sea"
JAKARTA: Final[ZoneInfo] = ZoneInfo("Asia/Jakarta")
COLLECTED_AT: Final[datetime] = datetime(2026, 7, 2, 1, 30, tzinfo=UTC)
CATALOG = load_catalog()
VM_CATALOG = CATALOG.for_resource_type(RESOURCE_TYPE)
assert VM_CATALOG is not None, "the shipped catalog must declare the VM resource type"
METRIC_NAMES: Final[tuple[str, ...]] = tuple(m.name for m in VM_CATALOG.metrics)
assert METRIC_NAMES, "the VM catalog must declare at least one metric"

MAX_RESOURCES: Final[int] = 12
MAX_OBJECTS: Final[int] = 24
MAX_INTERVALS: Final[int] = 30


# --------------------------------------------------------------------------- #
# Generating an archive and the plan that goes with it
# --------------------------------------------------------------------------- #


def resource_id(index: int) -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}"
        f"/providers/Microsoft.Compute/virtualMachines/vm-{index:03d}"
    )


@st.composite
def intervals(draw: st.DrawFn) -> list[dict[str, Any]]:
    """Per-interval `{total, count, minimum, maximum}`, including the awkward ones.

    A zero-count interval is ordinary (a partial bucket with no samples) and must fold to
    nothing without a gap; an interval missing its `count` is malformed and must record one.
    Both are drawn rather than hoped for, because they are the two shapes whose handling the
    recomputed `collection_log` — and therefore the digest — depends on.
    """
    count = draw(st.integers(min_value=1, max_value=MAX_INTERVALS))
    drawn: list[dict[str, Any]] = []
    for index in range(count):
        kind = draw(st.sampled_from(("ordinary", "zero_count", "malformed")))
        samples = draw(st.integers(min_value=1, max_value=60))
        total = draw(st.integers(min_value=0, max_value=6000))
        point: dict[str, Any] = {"timeStamp": f"2026-07-01T{index % 24:02d}:00:00Z"}
        if kind == "malformed":
            point["total"] = total
        elif kind == "zero_count":
            point.update({"total": 0, "count": 0, "minimum": 0, "maximum": 0})
        else:
            point.update(
                {
                    "total": total,
                    "count": samples,
                    "minimum": draw(st.integers(min_value=0, max_value=50)),
                    "maximum": draw(st.integers(min_value=50, max_value=100)),
                }
            )
        drawn.append(point)
    return drawn


@st.composite
def archives(draw: st.DrawFn) -> tuple[list[tuple[int, bytes]], ReplayPlan]:
    """An archive and the plan that describes the run it came from."""
    resource_count = draw(st.integers(min_value=1, max_value=MAX_RESOURCES))
    metric_names = draw(
        st.lists(st.sampled_from(METRIC_NAMES), min_size=1, unique=True).map(sorted)
    )
    ids = [resource_id(index) for index in range(resource_count)]

    objects: list[tuple[int, bytes]] = []
    object_count = draw(st.integers(min_value=1, max_value=min(MAX_OBJECTS, resource_count)))
    per_object = max(1, resource_count // object_count)
    for ordinal in range(object_count):
        chunk = ids[ordinal * per_object : (ordinal + 1) * per_object] or [ids[-1]]
        values = []
        for rid in chunk:
            entries = []
            for name in metric_names:
                # A per-resource error at HTTP 200 — the failure that silently becomes a
                # zero if the fold does not check every entry's own error field.
                if draw(st.booleans()) and draw(st.booleans()):
                    entries.append(
                        {
                            "name": {"value": name},
                            "errorCode": draw(st.sampled_from(("Forbidden", "BadRequest"))),
                            "errorMessage": "denied",
                        }
                    )
                    continue
                entries.append(
                    {
                        "name": {"value": name},
                        "errorCode": "Success",
                        "timeseries": [{"metadatavalues": [], "data": draw(intervals())}],
                    }
                )
            values.append({"resourceid": rid, "value": entries})
        objects.append((ordinal, _pack(chunk, metric_names, {"values": values})))

    return objects, _plan(ids, metric_names, objects_named=len(objects))


def _pack(
    resource_ids: list[str], metric_names: list[str], raw_response: dict[str, Any]
) -> bytes:
    return gzip.compress(
        json.dumps(
            {
                "grouping_key": {
                    "subscription_id": SUBSCRIPTION,
                    "location": LOCATION,
                    "resource_type": RESOURCE_TYPE,
                },
                "grain": "PT1H",
                "window": {"start": "2026-07-01", "end": "2026-07-01"},
                "metric_names": list(metric_names),
                "resource_ids": list(resource_ids),
                "raw_response": raw_response,
            }
        ).encode("utf-8")
    )


def _plan(ids: list[str], metric_names: list[str], *, objects_named: int) -> ReplayPlan:
    window = resolve_window(date(2026, 7, 1), date(2026, 7, 1), JAKARTA)
    declared = {metric.name: metric for metric in VM_CATALOG.metrics}
    resources = tuple(
        ReplayResource(
            record={  # type: ignore[arg-type]
                "resource_id": rid,
                "name": rid.rsplit("/", 1)[-1],
                "resource_type": RESOURCE_TYPE,
                "location": LOCATION,
                "resource_group": GROUP,
                "tags": {},
                "power_state_raw": "PowerState/running",
                "power_state": "running",
                "fidelity_tier": "baseline",
            },
            resource_type=RESOURCE_TYPE,
            fidelity_tier="baseline",
            sku=SkuCapacity(name="Standard_D4s_v5", vcpus_available=4),
            day_buckets=(ResourceDayBucket(local_day=date(2026, 7, 1), slot_count=24),),
            declared=declared,
            selected=tuple(metric_names),
            derived_entries=tuple(VM_CATALOG.derived),
            sku_capability_values={"vCPUsAvailable": Decimal(4), "MemoryGB": None},
        )
        for rid in ids
    )
    return ReplayPlan(
        stored_snapshot_id="0" * 64,
        run_id="run_property",
        scope=ScopeSpec(
            subscription_id=SUBSCRIPTION,
            resource_types=[RESOURCE_TYPE],
            resource_groups=[],
            tag_filters={},
        ),
        scope_verified=True,
        collected_at=COLLECTED_AT,
        timezone_name="Asia/Jakarta",
        tz=JAKARTA,
        window=window,
        grain="PT1H",
        metrics_by_resource_type={RESOURCE_TYPE: list(metric_names)},
        resources=resources,
        gaps=(),
        catalog_version=CATALOG.catalog_version,
        archive_complete=True,
        archive_object_count=objects_named,
        objects_named=objects_named,
    )


def digest_of(objects: list[tuple[int, bytes]], plan: ReplayPlan) -> str:
    result = replay(objects, plan=plan)
    assert result.outcome["possible"] is True, result.findings
    return str(result.outcome["recomputed_sha256"])


# --------------------------------------------------------------------------- #
# 4.1 as determinism, at scale
# --------------------------------------------------------------------------- #


@given(archives())
def test_two_replays_of_one_archive_produce_one_digest(case) -> None:
    """The digest is a function of the archive and the plan, and of nothing else — no
    dictionary iteration order, no set, no clock, no counter."""
    objects, plan = case

    assert digest_of(objects, plan) == digest_of(objects, plan)


@given(archives())
def test_the_fold_count_equals_the_object_count(case) -> None:
    """4.5. A skipped object and a double-folded one are both visible here before they are
    visible in a digest, which is what makes a failure diagnosable."""
    objects, plan = case

    result = replay(objects, plan=plan)

    assert result.outcome["objects_folded"] == len(objects)
    assert result.outcome["objects_named"] == len(objects)


@given(archives())
def test_the_digest_does_not_depend_on_the_order_objects_are_supplied_in(case) -> None:
    """Declared in the design as an example, and true for a reason worth stating: the
    aggregation is order-independent — sums and extremes commute — so a reversed archive
    recomputes the same snapshot. The *sequence* is still followed for the fold count, which
    the assertion above pins."""
    objects, plan = case

    assert digest_of(objects, plan) == digest_of(list(reversed(objects)), plan)


# --------------------------------------------------------------------------- #
# 4.4 — the assertion that kills a replay which recomputes nothing
# --------------------------------------------------------------------------- #


@given(archives(), st.integers(min_value=0, max_value=10_000))
@example(
    (
        [
            (
                0,
                _pack(
                    [resource_id(0)],
                    [METRIC_NAMES[0]],
                    {
                        "values": [
                            {
                                "resourceid": resource_id(0),
                                "value": [
                                    {
                                        "name": {"value": METRIC_NAMES[0]},
                                        "errorCode": "Success",
                                        "timeseries": [
                                            {
                                                "metadatavalues": [],
                                                "data": [
                                                    {
                                                        "timeStamp": "2026-07-01T00:00:00Z",
                                                        "total": 600,
                                                        "count": 60,
                                                        "minimum": 5,
                                                        "maximum": 30,
                                                    }
                                                ],
                                            }
                                        ],
                                    }
                                ],
                            }
                        ]
                    },
                ),
            )
        ],
        _plan([resource_id(0)], [METRIC_NAMES[0]], objects_named=1),
    ),
    0,
)
def test_altering_one_value_changes_the_digest(case, pick: int) -> None:
    """4.4. A replay that read the stored `snapshot_id` and returned it passes every other
    assertion in this module and cannot pass this one: the mutation cannot change a digest
    that was never recomputed.

    The declared example is the minimal case — one object, one resource, one metric, one
    well-formed interval — so a failure here is readable rather than a 200-object shrink.
    """
    objects, plan = case
    before = digest_of(objects, plan)

    mutated = _mutate_one_total(objects, pick)
    if mutated is None:
        return

    assert digest_of(mutated, plan) != before


def _mutate_one_total(
    objects: list[tuple[int, bytes]], pick: int
) -> list[tuple[int, bytes]] | None:
    """Change one folded `total`, somewhere. `None` when the archive folds nothing.

    Two constraints on the mutation, and both are corrections the property forced:

    * Only a **well-formed** interval is mutated. A malformed one is excluded from the
      average by construction, so changing it legitimately leaves the digest alone.
    * The change is **large enough to move the value at its recorded precision**. The
      design states 4.4 as "any single-value mutation produces a differing digest", and
      that is not quite true: a snapshot records a count-weighted average at the catalog's
      declared scale, so adding 1 to one interval's total among thirty — where the summed
      count is in the thousands — moves the average by less than half of the last recorded
      digit and reproduces the same snapshot. That is correct behaviour, not a hole; the
      mutation is sized so the property tests what it means to test.
    """
    positions: list[tuple[int, int, int, int]] = []
    decoded = [json.loads(gzip.decompress(payload)) for _, payload in objects]
    for object_index, document in enumerate(decoded):
        for value_index, value in enumerate(document["raw_response"]["values"]):
            for entry_index, entry in enumerate(value["value"]):
                if entry.get("errorCode") != "Success":
                    continue
                for point_index, point in enumerate(entry["timeseries"][0]["data"]):
                    if point.get("count"):
                        positions.append(
                            (object_index, value_index, entry_index, point_index)
                        )
    if not positions:
        return None

    object_index, value_index, entry_index, point_index = positions[pick % len(positions)]
    document = decoded[object_index]
    point = document["raw_response"]["values"][value_index]["value"][entry_index][
        "timeseries"
    ][0]["data"][point_index]
    point["total"] = point["total"] + 10_000

    payload = gzip.compress(json.dumps(document).encode("utf-8"))
    return [
        (ordinal, payload if index == object_index else original)
        for index, (ordinal, original) in enumerate(objects)
    ]


# --------------------------------------------------------------------------- #
# A missing input is an inability to replay, never a mismatch
# --------------------------------------------------------------------------- #


@given(archives(), st.integers(min_value=0, max_value=10_000))
def test_dropping_or_corrupting_an_object_is_advisory_and_never_a_mismatch(
    case, pick: int
) -> None:
    """Req 31.5, 31.8. Both are blocking if reported as a mismatch, and both would withhold
    a correct report on the strength of an input that never arrived."""
    objects, plan = case
    index = pick % len(objects)

    dropped = replay([o for i, o in enumerate(objects) if i != index], plan=plan)
    corrupted = replay(
        [
            (ordinal, b"\x00 not gzip" if i == index else payload)
            for i, (ordinal, payload) in enumerate(objects)
        ],
        plan=plan,
    )

    for result in (dropped, corrupted):
        assert result.outcome["possible"] is False
        assert {f["type"] for f in result.findings} == {FINDING_ARCHIVE_INCOMPLETE}
        assert FINDING_REPLAY_HASH_MISMATCH not in {f["type"] for f in result.findings}
        assert "recomputed_sha256" not in result.outcome


# --------------------------------------------------------------------------- #
# 4.3 — purity, observed as well as guarded
# --------------------------------------------------------------------------- #


class _NoSockets:
    """A socket factory that refuses. Any attempt to open one fails the property."""

    def __init__(self) -> None:
        self.attempts = 0

    def __call__(self, *args: object, **kwargs: object):
        self.attempts += 1
        raise AssertionError("a replay opened a socket; the aggregation is not pure")


@given(archives())
def test_a_replay_opens_no_socket(case) -> None:
    """4.3, at run time — the complement to the import-closure guard in
    `tests/test_boundaries.py`.

    The guard proves no module on the closure *imports* a network client; this proves no
    call is attempted through the one primitive every client ultimately reaches. Both are
    needed: a guard alone would miss a `subprocess` call out, and a runtime double alone
    would pass on a run that simply took a code path with no call in it today.
    """
    objects, plan = case
    refuse = _NoSockets()
    original = socket.socket
    socket.socket = refuse  # type: ignore[assignment]
    try:
        result = replay(objects, plan=plan)
    finally:
        socket.socket = original  # type: ignore[assignment]

    assert refuse.attempts == 0
    assert result.outcome["possible"] is True
