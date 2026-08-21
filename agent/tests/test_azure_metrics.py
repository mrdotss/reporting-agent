"""Task 11.6 — `azure/metrics.py`: batch planning, halving, throttling, per-resource
error classification, and the archive fold (Req 23, 24.8, 26, 27.8, 29).

Driven against `FakeMetricsPort` (routed through a real `RegionResolver`),
`InMemoryObjectStore` and the recorded fixtures in `tests/fixtures/azure/`. The
points-budget planning itself gets a light integration check here; the exhaustive
property proof is task 11.7's job.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from fakes.azure_ports import FakeMetricsPort, raw_response_from_recorded
from fakes.object_store import InMemoryObjectStore
from fixtures import load_response
from reporting_agent.azure.metrics import (
    AGGREGATIONS,
    MAX_CONSECUTIVE_429,
    POINTS_BUDGET,
    BatchGroup,
    MetricsCollector,
    classify_metric_error_code,
    parse_retry_after,
    plan_batches,
)
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.azure.regions import RegionResolver
from reporting_agent.collect.accumulate import MetricAccumulator
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.log import (
    GAP_TYPE_INTERVAL_COUNTS_MISSING,
    GAP_TYPE_METRIC_ERROR,
    GAP_TYPE_PERMISSION_DENIED,
    GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE,
    GAP_TYPE_RESPONSE_TOO_LARGE,
)
from reporting_agent.errors import ThrottledError

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
LOCATION = "southeastasia"
RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"
NAMESPACE = "microsoft.compute/virtualmachines"
ACTOR_ID = "user_01HQZZZZZZZZZZZZZZZZZZZZZZ"
RUN_ID = "run_01HQZZZZZZZZZZZZZZZZZZZZZZ"
WINDOW = {"start_utc": "2026-07-01T00:00:00Z", "end_utc": "2026-07-01T02:00:00Z"}
START = "2026-07-01T00:00:00Z"
END = "2026-07-01T02:00:00Z"

WEB_01 = (
    f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod-sea"
    f"/providers/Microsoft.Compute/virtualMachines/prod-web-01"
)
WEB_02 = (
    f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod-sea"
    f"/providers/Microsoft.Compute/virtualMachines/prod-web-02"
)
SQL_01 = (
    f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod-sea"
    f"/providers/Microsoft.Compute/virtualMachines/prod-sql-01"
)


def run(coro):
    return asyncio.run(coro)


class RecordingSleep:
    def __init__(self) -> None:
        self.waits: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


def new_collector(port: FakeMetricsPort, *, sleep=None, now=None):
    resolver = RegionResolver(port=port)
    writer = ArchiveWriter(store=InMemoryObjectStore())
    kwargs = {}
    if sleep is not None:
        kwargs["sleep"] = sleep
    if now is not None:
        kwargs["now"] = now
    return MetricsCollector(region_resolver=resolver, archive_writer=writer, **kwargs), writer


def new_accumulators(resource_ids, metric_names):
    return {
        (resource_id, metric_name): MetricAccumulator()
        for resource_id in resource_ids
        for metric_name in metric_names
    }


def collect(collector, *, resource_ids, metric_names, accumulators=None, day_fold=None):
    accs = accumulators if accumulators is not None else new_accumulators(resource_ids, metric_names)
    gaps = run(
        collector.collect_group(
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            resource_type=RESOURCE_TYPE,
            resource_ids=resource_ids,
            metric_namespace=NAMESPACE,
            metric_names=metric_names,
            accumulators=accs,
            day_fold=day_fold,
            grain="PT1H",
            window=WINDOW,
            start_time=START,
            end_time=END,
            interval_count=2,
        )
    )
    return gaps, accs


# --------------------------------------------------------------------------- #
# plan_batches: points-budget sizing (Req 23.1, 23.2, 23.4, 23.6)
# --------------------------------------------------------------------------- #


def test_plan_batches_groups_by_the_subscription_location_resource_type_key() -> None:
    group = BatchGroup(
        key=(SUBSCRIPTION, LOCATION, RESOURCE_TYPE),
        resources_sorted=(WEB_01, WEB_02),
        metric_count=1,
    )
    batches = plan_batches(group, interval_count=1)
    assert all(b.key == group.key for b in batches)


def test_the_declared_50x6x720_example_emits_at_least_11_batches() -> None:
    """design.md's own worked example: 50 resources x 6 metrics x 720 hourly points
    = 216000 -> per_resource=4320 -> capacity=4 -> at least 11 batches. An
    implementation sizing by the 50-resource cap would emit exactly 1."""
    resources = tuple(f"vm-{i:03d}" for i in range(50))
    group = BatchGroup(key=(SUBSCRIPTION, LOCATION, RESOURCE_TYPE), resources_sorted=resources, metric_count=6)

    batches = plan_batches(group, interval_count=720)

    assert len(batches) >= 11
    assert all(len(b.resource_ids) <= 4 for b in batches)
    union = {rid for b in batches for rid in b.resource_ids}
    assert union == set(resources)


def test_a_resource_whose_own_metric_set_exceeds_the_budget_gets_a_batch_of_one() -> None:
    """max(1, ...) floors capacity at 1 rather than dropping an oversized resource."""
    group = BatchGroup(
        key=(SUBSCRIPTION, LOCATION, RESOURCE_TYPE),
        resources_sorted=("vm-huge",),
        metric_count=8,
    )
    batches = plan_batches(group, interval_count=POINTS_BUDGET)  # per_resource way over budget

    assert len(batches) == 1
    assert batches[0].resource_ids == ("vm-huge",)


def test_an_empty_group_plans_no_batches() -> None:
    group = BatchGroup(key=(SUBSCRIPTION, LOCATION, RESOURCE_TYPE), resources_sorted=(), metric_count=1)
    assert plan_batches(group, interval_count=1) == []


def test_aggregations_are_exactly_total_count_minimum_maximum() -> None:
    assert AGGREGATIONS == ("Total", "Count", "Minimum", "Maximum")


# --------------------------------------------------------------------------- #
# retry-after parsing: seconds and HTTP-date (Req 23.8)
# --------------------------------------------------------------------------- #


def test_retry_after_parses_a_bare_seconds_count() -> None:
    assert parse_retry_after("30", now=datetime(2026, 7, 1, tzinfo=UTC)) == 30.0


def test_retry_after_parses_an_http_date_relative_to_now() -> None:
    now = datetime(2026, 7, 1, 0, 0, 0, tzinfo=UTC)
    wait = parse_retry_after("Tue, 01 Jul 2026 00:05:00 GMT", now=now)
    assert wait == 300.0


def test_retry_after_returns_none_for_absent_or_unparseable() -> None:
    assert parse_retry_after(None, now=datetime.now(UTC)) is None
    assert parse_retry_after("not-a-value", now=datetime.now(UTC)) is None


def test_retry_after_clamps_a_past_http_date_to_zero() -> None:
    now = datetime(2026, 7, 1, 1, 0, 0, tzinfo=UTC)
    wait = parse_retry_after("Tue, 01 Jul 2026 00:05:00 GMT", now=now)
    assert wait == 0.0


# --------------------------------------------------------------------------- #
# classify_metric_error_code (Req 29.2, 29.7)
# --------------------------------------------------------------------------- #


def test_forbidden_classifies_as_permission_denied() -> None:
    assert classify_metric_error_code("Forbidden") == GAP_TYPE_PERMISSION_DENIED


def test_an_unrecognised_error_code_classifies_as_metric_error() -> None:
    assert classify_metric_error_code("SomethingAzureInventsNextYear") == GAP_TYPE_METRIC_ERROR


# --------------------------------------------------------------------------- #
# a per-resource 403 inside HTTP 200: permission_denied, no zero folded
# (Req 29.1, 29.2, 29.3)
# --------------------------------------------------------------------------- #


def test_a_per_resource_403_records_permission_denied_and_folds_no_zero() -> None:
    response = raw_response_from_recorded(load_response("azure", "metrics_batch_per_resource_403"))
    port = FakeMetricsPort(batch_responses=[response])
    collector, _writer = new_collector(port)

    gaps, accs = collect(collector, resource_ids=[WEB_01, SQL_01], metric_names=["Percentage CPU"])

    denied = [g for g in gaps if g["gap_type"] == GAP_TYPE_PERMISSION_DENIED]
    assert len(denied) == 1
    assert denied[0]["resource_id"] == SQL_01
    assert denied[0]["metric"] == "Percentage CPU"

    sql_result, _sql_gap = accs[(SQL_01, "Percentage CPU")].finalize(SQL_01, "Percentage CPU")
    assert sql_result is None  # no zero folded

    web_result, _ = accs[(WEB_01, "Percentage CPU")].finalize(WEB_01, "Percentage CPU")
    assert web_result is not None
    assert web_result.average > 0


# --------------------------------------------------------------------------- #
# a requested resource absent from the response (Req 23.12, 29.6)
# --------------------------------------------------------------------------- #


def test_a_requested_resource_absent_from_the_response_records_the_gap() -> None:
    response = raw_response_from_recorded(
        load_response("azure", "metrics_batch_resource_absent_from_response")
    )
    port = FakeMetricsPort(batch_responses=[response])
    collector, _writer = new_collector(port)

    gaps, accs = collect(collector, resource_ids=[WEB_01, WEB_02], metric_names=["Percentage CPU"])

    absent = [g for g in gaps if g["gap_type"] == GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE]
    assert len(absent) == 1
    assert absent[0]["resource_id"] == WEB_02

    result, _ = accs[(WEB_02, "Percentage CPU")].finalize(WEB_02, "Percentage CPU")
    assert result is None


# --------------------------------------------------------------------------- #
# an interval missing count/total: interval_counts_missing, excluded from avg
# (Req 23.13)
# --------------------------------------------------------------------------- #


def test_an_interval_missing_count_records_interval_counts_missing_and_excludes_it() -> None:
    response = raw_response_from_recorded(load_response("azure", "metrics_batch_interval_missing_count"))
    port = FakeMetricsPort(batch_responses=[response])
    collector, _writer = new_collector(port)

    resource_id = (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod-sea"
        f"/providers/Microsoft.Compute/virtualMachines/prod-web-01"
    )
    gaps, accs = collect(collector, resource_ids=[resource_id], metric_names=["Percentage CPU"])

    missing = [g for g in gaps if g["gap_type"] == GAP_TYPE_INTERVAL_COUNTS_MISSING]
    assert len(missing) == 1
    assert missing[0]["resource_id"] == resource_id
    assert missing[0]["metric"] == "Percentage CPU"

    # The gap names **the interval that was incomplete**, not the one that folded.
    # The fixture's two intervals are an hour apart precisely so that reading the
    # wrong one is a failure rather than a coincidence: 01:00 is the interval with
    # no count, 00:00 is the complete one.
    assert missing[0]["interval_start"] == "2026-07-01T01:00:00Z"

    # Only the complete first interval (total=720, count=60) folded.
    result, _ = accs[(resource_id, "Percentage CPU")].finalize(resource_id, "Percentage CPU")
    assert result is not None
    assert result.sample_count == Decimal(60)
    assert result.average == Decimal("12.000000")  # 720 / 60


# --------------------------------------------------------------------------- #
# response-too-large: halving to 1, then metric split, then response_too_large
# with no zero (Req 23.3, 23.14)
# --------------------------------------------------------------------------- #


def test_a_response_too_large_batch_halves_and_retries_until_it_succeeds() -> None:
    too_large = raw_response_from_recorded(load_response("azure", "metrics_batch_response_too_large"))
    ok_web_01 = RawHttpResponse(
        status=200,
        headers={},
        body={
            "values": [
                {
                    "resourceid": WEB_01,
                    "value": [
                        {
                            "name": {"value": "Percentage CPU"},
                            "errorCode": "Success",
                            "timeseries": [
                                {
                                    "data": [
                                        {"total": 600.0, "count": 60, "minimum": 1.0, "maximum": 20.0}
                                    ]
                                }
                            ],
                        }
                    ],
                }
            ]
        },
    )
    ok_web_02 = RawHttpResponse(
        status=200,
        headers={},
        body={
            "values": [
                {
                    "resourceid": WEB_02,
                    "value": [
                        {
                            "name": {"value": "Percentage CPU"},
                            "errorCode": "Success",
                            "timeseries": [
                                {
                                    "data": [
                                        {"total": 1200.0, "count": 60, "minimum": 2.0, "maximum": 40.0}
                                    ]
                                }
                            ],
                        }
                    ],
                }
            ]
        },
    )
    # First request (both resources) rejects too-large; the halving loop then
    # requests two single-resource batches, each of which succeeds.
    port = FakeMetricsPort(batch_responses=[too_large, ok_web_01, ok_web_02])
    collector, writer = new_collector(port)

    gaps, accs = collect(collector, resource_ids=[WEB_01, WEB_02], metric_names=["Percentage CPU"])

    assert not any(g["gap_type"] == GAP_TYPE_RESPONSE_TOO_LARGE for g in gaps)
    web_01_result, _ = accs[(WEB_01, "Percentage CPU")].finalize(WEB_01, "Percentage CPU")
    web_02_result, _ = accs[(WEB_02, "Percentage CPU")].finalize(WEB_02, "Percentage CPU")
    assert web_01_result is not None and web_02_result is not None
    assert len(port.batch_calls) == 3
    # Only the two accepted, single-resource batch responses are archived - the
    # rejected multi-resource attempt writes no object (Req 26.10).
    assert len(writer.store) == 2  # type: ignore[attr-defined]


def test_a_single_resource_batch_still_too_large_splits_by_metric_name() -> None:
    single_too_large = raw_response_from_recorded(
        load_response("azure", "metrics_batch_response_too_large_single_resource")
    )
    ok_cpu = RawHttpResponse(
        status=200,
        headers={},
        body={
            "values": [
                {
                    "resourceid": WEB_01,
                    "value": [
                        {
                            "name": {"value": "Percentage CPU"},
                            "errorCode": "Success",
                            "timeseries": [{"data": [{"total": 600.0, "count": 60}]}],
                        }
                    ],
                }
            ]
        },
    )
    ok_mem = RawHttpResponse(
        status=200,
        headers={},
        body={
            "values": [
                {
                    "resourceid": WEB_01,
                    "value": [
                        {
                            "name": {"value": "Available Memory Bytes"},
                            "errorCode": "Success",
                            "timeseries": [{"data": [{"total": 6000.0, "count": 60}]}],
                        }
                    ],
                }
            ]
        },
    )
    port = FakeMetricsPort(batch_responses=[single_too_large, ok_cpu, ok_mem])
    collector, _writer = new_collector(port)

    gaps, accs = collect(
        collector,
        resource_ids=[WEB_01],
        metric_names=["Percentage CPU", "Available Memory Bytes"],
    )

    assert not any(g["gap_type"] == GAP_TYPE_RESPONSE_TOO_LARGE for g in gaps)
    cpu_result, _ = accs[(WEB_01, "Percentage CPU")].finalize(WEB_01, "Percentage CPU")
    mem_result, _ = accs[(WEB_01, "Available Memory Bytes")].finalize(WEB_01, "Available Memory Bytes")
    assert cpu_result is not None and mem_result is not None
    # The batch call, plus one per-metric request after the split.
    assert len(port.batch_calls) == 3


def test_a_single_metric_request_that_still_rejects_records_response_too_large_with_no_zero() -> None:
    single_too_large = raw_response_from_recorded(
        load_response("azure", "metrics_batch_response_too_large_single_resource")
    )
    port = FakeMetricsPort(batch_responses=[single_too_large, single_too_large])
    collector, _writer = new_collector(port)

    gaps, accs = collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])

    too_large_gaps = [g for g in gaps if g["gap_type"] == GAP_TYPE_RESPONSE_TOO_LARGE]
    assert len(too_large_gaps) == 1
    assert too_large_gaps[0]["resource_id"] == WEB_01
    assert too_large_gaps[0]["metric"] == "Percentage CPU"

    result, _ = accs[(WEB_01, "Percentage CPU")].finalize(WEB_01, "Percentage CPU")
    assert result is None


# --------------------------------------------------------------------------- #
# Retry-After honoured for both forms (Req 23.8)
# --------------------------------------------------------------------------- #


def test_retry_after_seconds_is_honoured_before_retrying() -> None:
    throttled = raw_response_from_recorded(load_response("azure", "metrics_batch_429_retry_after_seconds"))
    ok = RawHttpResponse(status=200, headers={}, body={"values": []})
    port = FakeMetricsPort(batch_responses=[throttled, ok])
    sleep = RecordingSleep()
    collector, _writer = new_collector(port, sleep=sleep)

    _gaps, _accs = collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])

    assert sleep.waits == [30.0]
    assert len(port.batch_calls) == 2


def test_retry_after_http_date_is_honoured_before_retrying() -> None:
    throttled = raw_response_from_recorded(
        load_response("azure", "metrics_batch_429_retry_after_http_date")
    )
    ok = RawHttpResponse(status=200, headers={}, body={"values": []})
    port = FakeMetricsPort(batch_responses=[throttled, ok])
    sleep = RecordingSleep()
    now = datetime(2026, 7, 1, 0, 0, 0, tzinfo=UTC)
    collector, _writer = new_collector(port, sleep=sleep, now=lambda: now)

    _gaps, _accs = collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])

    assert sleep.waits == [300.0]
    assert len(port.batch_calls) == 2


# --------------------------------------------------------------------------- #
# 5 consecutive 429s raise ThrottledError (Req 23.9)
# --------------------------------------------------------------------------- #


def test_five_consecutive_429s_raise_throttled_error() -> None:
    throttled = raw_response_from_recorded(load_response("azure", "metrics_batch_429_retry_after_seconds"))
    port = FakeMetricsPort(batch_responses=[throttled] * MAX_CONSECUTIVE_429)
    sleep = RecordingSleep()
    collector, _writer = new_collector(port, sleep=sleep)

    raised = False
    try:
        collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])
    except ThrottledError:
        raised = True
    assert raised
    assert len(port.batch_calls) == MAX_CONSECUTIVE_429
    # Only 4 waits: the 5th 429 raises instead of waiting a 5th time.
    assert len(sleep.waits) == MAX_CONSECUTIVE_429 - 1


def test_four_consecutive_429s_then_success_does_not_raise() -> None:
    throttled = raw_response_from_recorded(load_response("azure", "metrics_batch_429_retry_after_seconds"))
    ok = RawHttpResponse(status=200, headers={}, body={"values": []})
    port = FakeMetricsPort(batch_responses=[throttled, throttled, throttled, throttled, ok])
    sleep = RecordingSleep()
    collector, _writer = new_collector(port, sleep=sleep)

    _gaps, _accs = collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])

    assert len(port.batch_calls) == 5
    assert len(sleep.waits) == 4


# --------------------------------------------------------------------------- #
# archiving happens for accepted responses, never for rejections (Req 26.3,
# 26.9, 26.10, 24.8)
# --------------------------------------------------------------------------- #


def test_a_successful_batch_response_is_archived_exactly_once() -> None:
    response = raw_response_from_recorded(load_response("azure", "metrics_batch_per_resource_403"))
    port = FakeMetricsPort(batch_responses=[response])
    collector, writer = new_collector(port)

    collect(collector, resource_ids=[WEB_01, SQL_01], metric_names=["Percentage CPU"])

    assert len(writer.store) == 1  # type: ignore[attr-defined]


def test_the_archived_object_carries_the_grouping_key_grain_window_and_metric_names() -> None:
    import gzip
    import json

    response = raw_response_from_recorded(load_response("azure", "metrics_batch_per_resource_403"))
    port = FakeMetricsPort(batch_responses=[response])
    collector, writer = new_collector(port)

    collect(collector, resource_ids=[WEB_01, SQL_01], metric_names=["Percentage CPU"])

    (key,) = writer.store.keys()  # type: ignore[attr-defined]
    stored = writer.store.get(key)  # type: ignore[attr-defined]
    document = json.loads(gzip.decompress(stored.body))
    assert document["grouping_key"]["location"] == LOCATION
    assert document["grain"] == "PT1H"
    assert document["metric_names"] == ["Percentage CPU"]


def test_a_dns_fallback_response_is_also_archived() -> None:
    from reporting_agent.azure.ports import DnsResolutionError

    fallback_response = RawHttpResponse(
        status=200,
        headers={},
        body={
            "value": [
                {
                    "name": {"value": "Percentage CPU"},
                    "errorCode": "Success",
                    "timeseries": [{"data": [{"total": 300.0, "count": 60}]}],
                }
            ]
        },
    )
    port = FakeMetricsPort(
        batch_responses=[DnsResolutionError("norwayeast")],
        fallback_responses=[fallback_response],
    )
    collector, writer = new_collector(port)

    _gaps, accs = collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])

    assert len(writer.store) == 1  # type: ignore[attr-defined]
    result, _ = accs[(WEB_01, "Percentage CPU")].finalize(WEB_01, "Percentage CPU")
    assert result is not None
    assert result.average == Decimal("5.000000")  # 300 / 60


# --------------------------------------------------------------------------- #
# A data plane that answers, and refuses (Req 24.2's other shape)
# --------------------------------------------------------------------------- #
#
# Req 24.2 anticipated a region with **no** metrics data-plane host, which presents as a
# DNS failure and has been routed to the per-resource ARM path since the foundation. The
# case below is the one it did not anticipate: the host exists, resolves, and refuses.
#
# It happened on a real subscription and cost a whole diagnosis. Azure's own first-party
# `Metrics Monitor API` principal performs a `Microsoft.Authorization/checkAccess` to
# authorize a batch request; where that is denied, the endpoint answers 403 to *every*
# caller — a service principal holding Reader and a subscription owner alike — while the
# ARM per-resource path serves the same metrics for the same window happily. The run
# recorded one `metric_error` per resource and ended `NO_STATISTICS` with a working route
# sitting unused.


def _served_fallback(value: float = 300.0) -> RawHttpResponse:
    return RawHttpResponse(
        status=200,
        headers={},
        body={
            "value": [
                {
                    "name": {"value": "Percentage CPU"},
                    "errorCode": "Success",
                    "timeseries": [{"data": [{"total": value, "count": 60}]}],
                }
            ]
        },
    )


@pytest.mark.parametrize("status", [401, 403, 404])
def test_a_refusing_batch_endpoint_falls_back_and_still_collects(status: int) -> None:
    """The fix, asserted by its outcome: a statistic exists where there was none."""
    port = FakeMetricsPort(
        batch_responses=[RawHttpResponse(status=status, headers={}, body={})],
        fallback_responses=[_served_fallback()],
    )
    collector, _writer = new_collector(port)

    gaps, accs = collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])

    result, _ = accs[(WEB_01, "Percentage CPU")].finalize(WEB_01, "Percentage CPU")
    assert result is not None, f"status {status} produced no statistic"
    assert result.average == Decimal("5.000000")
    # And no gap, because nothing was lost — the location was rerouted, not degraded.
    assert [g["gap_type"] for g in gaps] == []


def test_a_refused_location_stays_fallback_only_for_the_rest_of_the_run() -> None:
    """Req 24.6's memo, extended to this refusal.

    The second group for the same location must not pay for another 403. Scripted with a
    **single** batch response: if the collector tried the batch endpoint twice, the fake
    would run out and raise, so the assertion is that it does not.
    """
    port = FakeMetricsPort(
        batch_responses=[RawHttpResponse(status=403, headers={}, body={})],
        fallback_responses=[_served_fallback(), _served_fallback(600.0)],
    )
    collector, _writer = new_collector(port)

    collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])
    _gaps, accs = collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])

    result, _ = accs[(WEB_01, "Percentage CPU")].finalize(WEB_01, "Percentage CPU")
    assert result is not None
    assert result.average == Decimal("10.000000")  # 600 / 60 — the second fallback


def test_a_bad_request_stays_a_gap_rather_than_falling_back() -> None:
    """A 400 is this runtime's own fault and fails on both paths.

    Falling back would hide it — and worse, might succeed for the wrong reason and put a
    figure in a document that the malformed request was never entitled to. The fallback
    sequence is deliberately non-empty: if the collector reroutes, it gets a statistic and
    this fails.
    """
    port = FakeMetricsPort(
        batch_responses=[RawHttpResponse(status=400, headers={}, body={})],
        fallback_responses=[_served_fallback()],
    )
    collector, _writer = new_collector(port)

    gaps, accs = collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])

    assert [g["gap_type"] for g in gaps] == ["metric_error"]
    result, _ = accs[(WEB_01, "Percentage CPU")].finalize(WEB_01, "Percentage CPU")
    assert result is None


def test_the_refusal_is_archived_like_any_other_answer() -> None:
    """Req 26.3 — the fallback responses reach the raw archive, so a replay of a rerouted
    run folds the same bytes the run folded."""
    port = FakeMetricsPort(
        batch_responses=[RawHttpResponse(status=403, headers={}, body={})],
        fallback_responses=[_served_fallback()],
    )
    collector, writer = new_collector(port)

    collect(collector, resource_ids=[WEB_01], metric_names=["Percentage CPU"])

    assert len(writer.store) == 1  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# input validation
# --------------------------------------------------------------------------- #


def test_collect_group_rejects_empty_resource_ids() -> None:
    port = FakeMetricsPort()
    collector, _writer = new_collector(port)

    raised = False
    try:
        collect(collector, resource_ids=[], metric_names=["Percentage CPU"])
    except ValueError:
        raised = True
    assert raised


def test_collect_group_rejects_empty_metric_names() -> None:
    port = FakeMetricsPort()
    collector, _writer = new_collector(port)

    raised = False
    try:
        collect(collector, resource_ids=[WEB_01], metric_names=[])
    except ValueError:
        raised = True
    assert raised
