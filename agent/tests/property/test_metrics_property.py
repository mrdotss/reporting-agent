"""Property 4 — batch planning respects the points budget and loses nothing.

**Validates: Requirements 23.1, 23.2, 23.3, 23.4, 42.2, 42.4, 42.8**

*Invariant.* `plan_batches` (task 11.6) is a pure function, so most of Property 4 is
checked directly against it: for generated `BatchGroup`s spanning 1-500 resources, 1-8
metrics and 1-2976 expected points per metric (the `PT15M`-grain slot count of a
31-day window, which also covers `PT1H`'s smaller 744-slot ceiling) drawn across 1-10
distinct locations and 1-3 distinct resource types —

* every emitted batch's estimated point count is at most `POINTS_BUDGET`, except a
  single-resource batch, which the `max(1, ...)` floor may leave over budget rather
  than dropping the resource (Req 23.2, 23.4);
* no batch is empty;
* the batches' union of resource ids equals the input set exactly — no duplicate, no
  omission;
* two planning passes over the identical input emit identical batches in identical
  order (Req 23.1's `BatchGroup.resources_sorted` contract: `plan_batches` itself does
  no sorting or shuffling, so this is determinism, not idempotence of a side effect);
* every batch's resources carry its own group's `(subscription, location,
  resource_type)` key, checked both within one group and across several
  simultaneously-planned groups with distinct keys, so no batch is a construction
  artifact of a single-group call.

The declared worked example — 50 resources x 6 metrics x 720 hourly points = 216,000
estimated points, `per_resource = 4320`, `capacity = 4` — is pinned as both an
`@example` on the general property and as its own standalone regression test
asserting at least 11 batches, because an implementation sizing by the documented
50-resource cap would emit exactly 1 and this is precisely the mistake Req 23.4 exists
to rule out.

*Scripted.* The halving loop is not pure — it drives `MetricsCollector` through
`RegionResolver` against a port that always answers `ResponseTooLarge` — so its two
clauses are checked with a small hand-rolled port stub rather than through
`FakeMetricsPort`'s finite scripted queue (which would need exactly as many scripted
responses as the collector's recursion issues, defeating the point of generating `n`).

**A finding surfaced by proving this property, not assumed going in — see the
"per-resource depth vs total request count" note below `_run_halving_scenario`.**
`azure/metrics.py`'s halving loop recurses into *both* halves of an oversized batch
rather than the other legal reading of Req 23.3 ("halve and retry, dropping the other
half"), specifically so that no resource is ever silently left unrequested (its own
docstring's stated reasoning, and this codebase's "never drop a resource" discipline
elsewhere — Req 23.12, 29.6). That choice means the *total* number of requests issued
for one oversized batch of `n` resources grows like `2n - 1` (a full binary recursion
tree over `n` leaves), not like `ceil(log2(n)) + 1`. What **does** stay bounded by
`ceil(log2(n)) + 1` is the number of halving-phase requests any **one** resource is
ever a part of — the depth of the recursion tree from the root to that resource's
leaf — because every recursive call halves the batch a resource is inside of, and a
batch of size 1 is the floor. This file asserts the depth bound, which is what the
implementation actually satisfies and what "the loop terminates within
`ceil(log2(n)) + 1` requests" reads most naturally as meaning for a single resource's
own path through it; it does not assert an aggregate request-count bound the
"recurse on both halves" implementation does not, and should not, satisfy. See the
task 11.7 report for the numbers this claim was checked against (n up to 500).
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from hypothesis import example, given
from hypothesis import strategies as st

from fakes.object_store import InMemoryObjectStore
from reporting_agent.azure.metrics import (
    POINTS_BUDGET,
    BatchGroup,
    MetricsCollector,
    plan_batches,
)
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.azure.regions import RegionResolver
from reporting_agent.collect.accumulate import MetricAccumulator
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.log import GAP_TYPE_NO_SAMPLES, GAP_TYPE_RESPONSE_TOO_LARGE

# --- generators (Property 4.5's declared ranges) --------------------------------------

RESOURCE_COUNT = st.integers(min_value=1, max_value=500)
METRIC_COUNT = st.integers(min_value=1, max_value=8)
# The PT15M-grain slot count of a 31-day window (96 slots/day x 31); PT1H's smaller
# 744-slot ceiling is a subset of this range, so one generator covers both grains
# without the strategy needing to know which grain produced the count.
POINTS_PER_METRIC = st.integers(min_value=1, max_value=2976)

_LOCATIONS = tuple(f"location-{i}" for i in range(10))
_RESOURCE_TYPES = tuple(f"Microsoft.Compute/type-{i}" for i in range(3))

LOCATION = st.sampled_from(_LOCATIONS)
RESOURCE_TYPE = st.sampled_from(_RESOURCE_TYPES)
SUBSCRIPTION_ID = st.uuids().map(str)


def _resources(prefix: str, n: int) -> tuple[str, ...]:
    """`n` distinct resource id strings. Content is irrelevant to every property
    below — only distinctness and count matter — so ids are synthesized from an
    index rather than drawn from a text strategy, matching this codebase's own
    convention (`test_azure_metrics.py`'s `f"vm-{i:03d}"` for its declared example)."""
    return tuple(f"{prefix}-r-{i:06d}" for i in range(n))


@st.composite
def batch_group_and_interval_count(draw: st.DrawFn) -> tuple[BatchGroup, int]:
    """One `BatchGroup` plus the `interval_count` `plan_batches` needs alongside it."""
    n = draw(RESOURCE_COUNT)
    metric_count = draw(METRIC_COUNT)
    interval_count = draw(POINTS_PER_METRIC)
    key = (draw(SUBSCRIPTION_ID), draw(LOCATION), draw(RESOURCE_TYPE))
    group = BatchGroup(key=key, resources_sorted=_resources("g", n), metric_count=metric_count)
    return group, interval_count


DECLARED_EXAMPLE_GROUP = BatchGroup(
    key=("3f2b0000-0000-0000-0000-000000000000", "southeastasia", "Microsoft.Compute/virtualMachines"),
    resources_sorted=_resources("declared", 50),
    metric_count=6,
)
DECLARED_EXAMPLE_INTERVAL_COUNT = 720  # design.md's own worked example: 720 hourly points


# --- Property 4: at-budget sizing, no empty batch, exact union, determinism, key ------


@given(data=batch_group_and_interval_count())
@example(data=(DECLARED_EXAMPLE_GROUP, DECLARED_EXAMPLE_INTERVAL_COUNT))
def test_plan_batches_respects_the_points_budget_loses_nothing_and_is_deterministic(
    data: tuple[BatchGroup, int],
) -> None:
    group, interval_count = data
    batches = plan_batches(group, interval_count=interval_count)

    # (b) no empty batch (Req 23.2).
    assert all(len(b.resource_ids) > 0 for b in batches)

    # (a) at most POINTS_BUDGET estimated points, except a batch of exactly one
    # resource — the max(1, ...) floor may leave that one over budget rather than
    # dropping it (Req 23.2, 23.4, 23.6).
    per_resource = group.metric_count * interval_count
    for batch in batches:
        if len(batch.resource_ids) == 1:
            continue
        assert len(batch.resource_ids) * per_resource <= POINTS_BUDGET

    # (c) the union of every batch's resource ids equals the input set exactly: no
    # duplicate, no omission (Req 23.1, 23.6).
    all_ids = [rid for b in batches for rid in b.resource_ids]
    assert len(all_ids) == len(group.resources_sorted)
    assert len(all_ids) == len(set(all_ids))
    assert set(all_ids) == set(group.resources_sorted)

    # (e) every batch carries its own group's grouping key (Req 23.1).
    assert all(b.key == group.key for b in batches)

    # (d) determinism: a second planning pass over the identical input emits
    # identical batches in identical order (Req 23.1's "resources_sorted is already
    # ordered by the caller" contract — plan_batches itself introduces no
    # nondeterminism).
    assert plan_batches(group, interval_count=interval_count) == batches


def test_the_declared_50x6x720_example_emits_at_least_11_batches() -> None:
    """design.md's own worked example (Property 4.5): 50 resources x 6 metrics x 720
    hourly points = 216,000 estimated points -> per_resource = 4320 -> capacity = 4
    -> at least 11 batches. An implementation sizing by the documented 50-resource
    cap would emit exactly 1 batch and fail this test."""
    batches = plan_batches(DECLARED_EXAMPLE_GROUP, interval_count=DECLARED_EXAMPLE_INTERVAL_COUNT)

    assert len(batches) >= 11
    assert all(len(b.resource_ids) <= 4 for b in batches)
    union = {rid for b in batches for rid in b.resource_ids}
    assert union == set(DECLARED_EXAMPLE_GROUP.resources_sorted)


# --- Property 4.7 — an oversized single resource is emitted alone, never dropped -----


@given(
    n=st.integers(min_value=1, max_value=20),
    metric_count=METRIC_COUNT,
)
@example(n=1, metric_count=8)
def test_a_group_whose_per_resource_estimate_exceeds_the_budget_floors_capacity_at_one(
    n: int, metric_count: int
) -> None:
    """When `per_resource` alone exceeds `POINTS_BUDGET`, `capacity = max(1, ...)`
    floors at 1: every batch this group plans has exactly one resource, and no
    resource is dropped (Req 23.2, 23.4 / Property 4.7)."""
    group = BatchGroup(
        key=("sub", "location-0", "Microsoft.Compute/type-0"),
        resources_sorted=_resources("oversized", n),
        metric_count=metric_count,
    )
    # interval_count chosen so metric_count * interval_count exceeds POINTS_BUDGET
    # for every metric_count in [1, 8] the generator can draw.
    over_budget_interval_count = POINTS_BUDGET + 1

    batches = plan_batches(group, interval_count=over_budget_interval_count)

    assert len(batches) == n
    assert all(len(b.resource_ids) == 1 for b in batches)
    union = {b.resource_ids[0] for b in batches}
    assert union == set(group.resources_sorted)


# --- Property 4.1/4.4 — batches from distinct groups never mix keys ------------------


@st.composite
def distinct_batch_groups(draw: st.DrawFn) -> list[tuple[BatchGroup, int]]:
    """2-5 `BatchGroup`s, each with a distinct `(subscription, location,
    resource_type)` key, planned independently — so "every batch's resources share
    one grouping key" is checked across simultaneously-exercised groups, not only as
    a trivial per-call fact about `Batch.key` copying `group.key`."""
    group_count = draw(st.integers(min_value=2, max_value=5))
    keys = draw(
        st.lists(
            st.tuples(SUBSCRIPTION_ID, LOCATION, RESOURCE_TYPE),
            min_size=group_count,
            max_size=group_count,
            unique=True,
        )
    )
    groups: list[tuple[BatchGroup, int]] = []
    for index, key in enumerate(keys):
        n = draw(st.integers(min_value=1, max_value=20))
        metric_count = draw(METRIC_COUNT)
        interval_count = draw(POINTS_PER_METRIC)
        group = BatchGroup(key=key, resources_sorted=_resources(f"grp{index}", n), metric_count=metric_count)
        groups.append((group, interval_count))
    return groups


@given(groups_and_intervals=distinct_batch_groups())
def test_batches_from_distinct_groups_never_mix_keys(
    groups_and_intervals: list[tuple[BatchGroup, int]],
) -> None:
    keys = [group.key for group, _ in groups_and_intervals]
    assert len(keys) == len(set(keys))  # the generator's own uniqueness constraint

    for group, interval_count in groups_and_intervals:
        batches = plan_batches(group, interval_count=interval_count)
        assert all(b.key == group.key for b in batches)
        other_keys = set(keys) - {group.key}
        assert all(b.key not in other_keys for b in batches)


# --- the halving loop: per-resource depth, and the floor that stops it --------------


@dataclass
class _AlwaysTooLargePort:
    """A `MetricsPort` stand-in whose `query_batch` always answers `ResponseTooLarge`
    (Req 23.3), regardless of how many resources or metrics the call asks for.
    `query_resource_fallback` and `query_logical_disk_free_space` raise if called at
    all: this scenario never triggers a DNS failure, so `RegionResolver` must never
    route to either of them, and a call reaching them would mean this test stopped
    proving what it claims to."""

    calls: list[dict[str, Any]] = field(default_factory=list)

    async def query_batch(self, **kwargs: Any) -> RawHttpResponse:
        self.calls.append(kwargs)
        return RawHttpResponse(status=400, headers={"x-ms-error-code": "ResponseTooLarge"}, body={})

    async def query_resource_fallback(self, **kwargs: Any) -> RawHttpResponse:
        raise AssertionError(
            "the fallback path must never be reached: this scenario has no DNS failure"
        )

    async def query_logical_disk_free_space(self, **kwargs: Any) -> RawHttpResponse:
        raise AssertionError("not exercised by this property")


def _run_halving_scenario(
    n: int, metric_names: Sequence[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[tuple[str, str], MetricAccumulator]]:
    """Drive `MetricsCollector.collect_group` for `n` resources against a port that
    always rejects as too large, and return every `query_batch` call it made, every
    gap it produced, and the accumulators (all left empty) it folded into.

    `interval_count=1` and a single-batch-sized group (`metric_count` from
    `len(metric_names)` is small enough that `plan_batches` never itself splits `n`
    resources into more than one initial batch — `POINTS_BUDGET // (metric_count *
    1)` comfortably exceeds 500 for `metric_count` in this file's range) means the
    collector's *first* call is always one batch covering all `n` resources, so every
    later call is attributable purely to the halving loop's own recursion rather than
    to `plan_batches` having pre-split the input.
    """
    port = _AlwaysTooLargePort()
    resolver = RegionResolver(port=port)
    writer = ArchiveWriter(store=InMemoryObjectStore())
    collector = MetricsCollector(region_resolver=resolver, archive_writer=writer)
    resource_ids = _resources("halve", n)
    accumulators = {
        (resource_id, metric_name): MetricAccumulator()
        for resource_id in resource_ids
        for metric_name in metric_names
    }

    gaps = asyncio.run(
        collector.collect_group(
            actor_id="actor_01HQZZZZZZZZZZZZZZZZZZZZZZ",
            run_id="run_01HQZZZZZZZZZZZZZZZZZZZZZZ",
            subscription_id="3f2b0000-0000-0000-0000-000000000000",
            location="southeastasia",
            resource_type="Microsoft.Compute/virtualMachines",
            resource_ids=resource_ids,
            metric_namespace="microsoft.compute/virtualmachines",
            metric_names=metric_names,
            accumulators=accumulators,
            day_fold=None,
            grain="PT1H",
            window={"start_utc": "2026-07-01T00:00:00Z", "end_utc": "2026-07-01T01:00:00Z"},
            start_time="2026-07-01T00:00:00Z",
            end_time="2026-07-01T01:00:00Z",
            interval_count=1,
        )
    )
    return port.calls, gaps, accumulators


@given(n=st.integers(min_value=1, max_value=500))
@example(n=1)
@example(n=2)
@example(n=3)
@example(n=50)
@example(n=500)
def test_the_halving_loops_per_resource_depth_is_bounded_by_ceil_log2_n_plus_1(n: int) -> None:
    """Req 23.3 / Property 4.6 — the number of halving-phase requests (batches of
    more than one resource) any single resource is ever a part of is bounded by
    `ceil(log2(n)) + 1`, the depth of the binary recursion tree from an initial batch
    of `n` down to a floor of one. See the module docstring: this is the bound the
    "recurse on both halves" implementation actually satisfies; the *total* number of
    requests issued for the whole batch does not satisfy this bound, and this test
    does not assert that it does.
    """
    calls, gaps, accumulators = _run_halving_scenario(n, ("Percentage CPU",))

    bound = math.ceil(math.log2(n)) + 1 if n > 1 else 1

    resource_ids = _resources("halve", n)
    for resource_id in resource_ids:
        halving_calls = [
            call
            for call in calls
            if resource_id in call["resource_ids"] and len(call["resource_ids"]) > 1
        ]
        assert len(halving_calls) <= bound, (resource_id, len(halving_calls), bound)

        # exactly 2 requests are ever issued once a resource reaches a batch of
        # one: the floor attempt (a batch of one, carrying the full — here
        # single-element — metric set) and its single-metric split retry. With one
        # metric these two calls carry identical parameters
        # (`metric_names=("Percentage CPU",)` both times), so they are counted by
        # call count rather than by trying to distinguish them by content.
        single_resource_calls = [call for call in calls if call["resource_ids"] == (resource_id,)]
        assert len(single_resource_calls) == 2
        assert all(call["metric_names"] == ("Percentage CPU",) for call in single_resource_calls)

    assert all(len(call["resource_ids"]) >= 1 for call in calls)  # never a batch of zero

    # every resource ends up with a response_too_large gap and folds nothing.
    assert len(gaps) == n
    assert all(gap["gap_type"] == GAP_TYPE_RESPONSE_TOO_LARGE for gap in gaps)
    for (resource_id, metric_name), accumulator in accumulators.items():
        result, gap = accumulator.finalize(resource_id, metric_name)
        assert result is None
        assert gap is not None
        assert gap["gap_type"] == GAP_TYPE_NO_SAMPLES


@given(
    n=st.integers(min_value=1, max_value=200),
    metric_count=st.integers(min_value=1, max_value=8),
)
@example(n=1, metric_count=1)
@example(n=1, metric_count=8)
def test_a_rejected_single_resource_batch_stops_halving_and_splits_by_metric_with_no_zero(
    n: int, metric_count: int
) -> None:
    """Req 23.14 / Property 4.6's second clause — once a resource reaches a batch of
    exactly one and still rejects as too large, the collector splits by metric name
    rather than halving further (there is nothing left to halve), and a
    single-metric request that *also* rejects records `response_too_large` with no
    zero value — never a batch of zero resources.
    """
    metric_names = tuple(f"Metric{i}" for i in range(metric_count))
    calls, gaps, accumulators = _run_halving_scenario(n, metric_names)

    # every resource's floor attempt (the full-metric-set batch of one) happens
    # exactly once, and is followed by exactly one single-metric request per metric
    # — total metric_count + 1 requests once a resource reaches the floor. When
    # metric_count == 1 the floor attempt and its lone per-metric-split attempt
    # carry an identical (single-element) metric_names tuple and are not
    # distinguishable by content, which is exactly why this counts by total rather
    # than trying to separate "the floor call" from "the split call" when they are
    # the same shape.
    resource_ids = _resources("halve", n)
    for resource_id in resource_ids:
        single_resource_calls = [call for call in calls if call["resource_ids"] == (resource_id,)]
        assert len(single_resource_calls) == metric_count + 1

        for metric_name in metric_names:
            per_metric_attempts = [
                call for call in single_resource_calls if call["metric_names"] == (metric_name,)
            ]
            assert len(per_metric_attempts) >= 1

        if metric_count > 1:
            full_floor_attempts = [
                call for call in single_resource_calls if call["metric_names"] == metric_names
            ]
            assert len(full_floor_attempts) == 1

    assert all(len(call["resource_ids"]) >= 1 for call in calls)

    assert len(gaps) == n * metric_count
    assert all(gap["gap_type"] == GAP_TYPE_RESPONSE_TOO_LARGE for gap in gaps)
    for (resource_id, metric_name), accumulator in accumulators.items():
        result, gap = accumulator.finalize(resource_id, metric_name)
        assert result is None
        assert gap is not None
        assert gap["gap_type"] == GAP_TYPE_NO_SAMPLES
