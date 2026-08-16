"""Task 11.9 — `collect/pipeline.py` (Req 14.7-14.9, 24.5, 29.5, 29.9, 31.x, 33.x, 35.7).

The pipeline is driven end to end against the **fake Azure ports** and an in-memory object
store, through `azure/provider.py`'s own `provider_over_ports`, so every test here runs a
real `discover`, a real `collect`, a real fidelity resolution and a real snapshot write with
no SDK, no credential and no subscription anywhere in the path.

What this suite asserts is the pipeline's own contribution:

* **the event stream** — the two `tool` steps and their determinate `progress`, in order,
  with exactly one `snapshot_ready` (Req 14.7, 14.8, 14.9, 35.7);
* **the gates** — enough to prove each one fires on the right fact and, just as
  importantly, does *not* fire on a neighbouring one (a subscription whose every VM is
  stopped is not `EMPTY_SCOPE`). The **exhaustive gate matrix — task 11.11 — is the last
  section of this file**, and it reuses these same fixtures rather than a parallel set;
* **the fidelity tier** — the ceiling rule, the downgrade triggers, the `_Total` collapse,
  and that a `baseline` run issues no Log Analytics query at all;
* **the plain-data round trip** the protocol boundary makes necessary, asserted as an
  equality rather than trusted as a comment.

Behaviours the five collector modules own — paging, quota waits, batch planning, the
halving loop, count weighting — are not re-asserted here; each has its own suite.

`main` reads its configuration at import (Req 14.12), so the two required variables are set
before importing it, the same contract the container satisfies with its environment. The
`StepTracker` this pipeline is driven through is `main`'s own, not a stand-in: the whole
point of the `StepEvents` protocol is that the real tracker satisfies it, so a test using a
looser double would be testing the protocol rather than the pipeline.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from fakes.azure_ports import (
    DNS_UNREACHABLE_LOCATIONS,
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    raw_response_from_recorded,
)
from fakes.object_store import InMemoryObjectStore
from fixtures import load_response
from reporting_agent import main
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.azure.provider import (
    FIDELITY_BASELINE as AZURE_FIDELITY_BASELINE,
)
from reporting_agent.azure.provider import (
    FIDELITY_ENHANCED as AZURE_FIDELITY_ENHANCED,
)
from reporting_agent.azure.provider import provider_over_ports
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_INSTANCE_NAME_COLLAPSED,
    GAP_TYPE_METRIC_ERROR,
    GAP_TYPE_NO_SAMPLES,
    GAP_TYPE_REGION_UNREACHABLE,
)
from reporting_agent.collect.pipeline import (
    COLLAPSED_INSTANCE_NAME,
    FIDELITY_BASELINE,
    FIDELITY_ENHANCED,
    assert_some_location_reachable,
    distinct_resource_ids,
    resolve_run_plan,
    run_generate_report,
    statistic_from_plain,
)
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.errors import (
    EmptyScopeError,
    ErrorCode,
    NoStatisticsError,
    PartialCoverageError,
    RegionUnreachableError,
)
from reporting_agent.events import (
    TOOL_COLLECT_INVENTORY,
    TOOL_COLLECT_METRICS,
)
from reporting_agent.main import StepTracker
from reporting_agent.progress import ProgressReporter
from reporting_agent.providers import registry
from reporting_agent.providers.base import (
    Capabilities,
    CollectRequest,
    CollectResult,
    DiscoverResult,
    GapRecord,
    ResourceRecord,
    ScopeSpec,
    StatValue,
)

Event = dict[str, Any]

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
LOCATION = "southeastasia"
RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"
WIRE_TYPE = "microsoft.compute/virtualmachines"
ACTOR_ID = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID = "run_01HQZX8QW9K7YB4T2C3M5N6P7Q"
SKU_NAME = "Standard_D4s_v5"
WORKSPACE = "9c8b7a65-4321-4321-4321-0123456789ab"
CPU = "Percentage CPU"
MEMORY = "Available Memory Bytes"
DISK_FREE = "disk_free_pct"
WATCHDOG_S = 10.0

CATALOG = load_catalog()
VM_CATALOG = CATALOG.for_resource_type(RESOURCE_TYPE)
assert VM_CATALOG is not None
DECLARED_METRICS: tuple[str, ...] = tuple(metric.name for metric in VM_CATALOG.metrics)

# 16 GiB, matching the SKU listing below, so `memory_used_pct` derives to exactly 50.00.
SKU_MEMORY_BYTES = Decimal(16) * Decimal(1073741824)
AVAILABLE_MEMORY_BYTES = SKU_MEMORY_BYTES / 2


# --------------------------------------------------------------------------- #
# Recorded-shaped responses
# --------------------------------------------------------------------------- #


def resource_id(name: str, *, group: str = "rg-prod-sea") -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{group}"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


WEB_01 = resource_id("prod-web-01")
WEB_02 = resource_id("prod-web-02")


def raw(
    body: object, *, status: int = 200, headers: dict[str, str] | None = None
) -> RawHttpResponse:
    return RawHttpResponse(status=status, headers=headers or {}, body=body)


def inventory_row(
    name: str,
    *,
    location: str = LOCATION,
    power_state: str = "PowerState/running",
) -> dict[str, Any]:
    return {
        "id": resource_id(name),
        "name": name,
        "type": WIRE_TYPE,
        "location": location,
        "resourceGroup": "rg-prod-sea",
        "tags": {"env": "prod"},
        "sku": SKU_NAME,
        "powerState": power_state,
    }


def inventory_page(rows: list[dict[str, Any]]) -> RawHttpResponse:
    return raw(
        {"totalRecords": len(rows), "count": len(rows), "data": rows},
        headers={"x-ms-user-quota-remaining": "9"},
    )


def definitions_response(*names: str) -> RawHttpResponse:
    return raw({"value": [{"name": {"value": name}} for name in names]})


def sku_listing(*, location: str = LOCATION) -> RawHttpResponse:
    """One location-filtered SKU listing. The location is a parameter because the SKU
    catalog caches per `(subscription, location)` and lists once per location, so a
    two-location run needs one listing per location rather than one per run."""
    return raw(
        {
            "value": [
                {
                    "resourceType": "virtualMachines",
                    "name": SKU_NAME,
                    "locations": [location],
                    "capabilities": [
                        {"name": "vCPUs", "value": "8"},
                        {"name": "vCPUsAvailable", "value": "4"},
                        {"name": "MemoryGB", "value": "16"},
                    ],
                }
            ]
        }
    )


def interval(value: int, *, count: int = 60, at: str = "2026-07-01T00:00:00Z") -> dict[str, Any]:
    return {
        "timeStamp": at,
        "total": value * count,
        "count": count,
        "minimum": value,
        "maximum": value,
    }


def metric_entry(name: str, *, error_code: str = "Success") -> dict[str, Any]:
    entry: dict[str, Any] = {
        "name": {"value": name, "localizedValue": name},
        "errorCode": error_code,
    }
    if error_code != "Success":
        return entry
    reading = int(AVAILABLE_MEMORY_BYTES) if name == MEMORY else 15
    entry["timeseries"] = [{"metadatavalues": [], "data": [interval(reading, count=1 if name == MEMORY else 60)]}]
    return entry


def batch_response(
    resource_ids: Sequence[str], *, names: Sequence[str] = DECLARED_METRICS
) -> RawHttpResponse:
    return raw(
        {
            "values": [
                {
                    "starttime": "2026-06-30T17:00:00Z",
                    "endtime": "2026-07-01T17:00:00Z",
                    "interval": "PT1H",
                    "namespace": WIRE_TYPE,
                    "resourceregion": LOCATION,
                    "resourceid": rid,
                    "value": [metric_entry(name) for name in names],
                }
                for rid in resource_ids
            ]
        }
    )


# --------------------------------------------------------------------------- #
# Assembly
# --------------------------------------------------------------------------- #


def payload(
    *, start: str = "2026-07-01", end: str = "2026-07-01", resource_types: list[str] | None = None
) -> dict[str, Any]:
    return {
        "command": "generate_report",
        "period": {"start": start, "end": end},
        "scope": {
            "resource_types": (
                resource_types if resource_types is not None else [RESOURCE_TYPE]
            ),
            "resource_groups": [],
            "tag_filters": {},
        },
    }


def context(**overrides: Any) -> dict[str, Any]:
    resolved = {
        "actor_id": ACTOR_ID,
        "run_id": RUN_ID,
        "subscription_id": SUBSCRIPTION,
        "timezone": "Asia/Jakarta",
        "fidelity_tier": FIDELITY_BASELINE,
        "log_analytics_workspace_id": None,
    }
    resolved.update(overrides)
    return resolved


class RecordingTransport:
    """A `ProgressTransport` recording the phase-callback bodies it was handed."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post_json(self, url, *, body, headers, timeout) -> int:
        self.calls.append(dict(body))
        return 204


class Harness:
    """The pipeline over one provider over the four fakes, with everything reachable."""

    def __init__(
        self,
        *,
        inventory: list[RawHttpResponse] | None = None,
        skus: list[RawHttpResponse] | None = None,
        definitions: list[RawHttpResponse] | None = None,
        batches: list[Any] | None = None,
        fallbacks: list[RawHttpResponse] | None = None,
        logs: list[Any] | None = None,
        fidelity_tier: str = FIDELITY_BASELINE,
        payload_body: dict[str, Any] | None = None,
        context_body: dict[str, Any] | None = None,
    ) -> None:
        self.inventory_port = FakeInventoryPort(inventory or [])
        self.sku_port = FakeSkuPort(skus or [])
        self.definitions_port = FakeDefinitionsPort(definitions or [])
        self.metrics_port = FakeMetricsPort(
            batch_responses=batches or [],
            fallback_responses=fallbacks or [],
            logs_responses=logs or [],
        )
        self.store = InMemoryObjectStore()
        self.steps = StepTracker()
        self.transport = RecordingTransport()
        self.progress = ProgressReporter(
            progress_url=f"https://app.test/api/internal/runs/{RUN_ID}/progress",
            progress_token="b7e2d4c6a8f0192837465564738291a0b7e2d4c6a8f01928",
            run_id=RUN_ID,
            transport=self.transport,
        )
        self.provider = provider_over_ports(
            inventory_port=self.inventory_port,
            sku_port=self.sku_port,
            definitions_port=self.definitions_port,
            metrics_port=self.metrics_port,
            object_store=self.store,
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            fidelity_tier=fidelity_tier,
            catalog=CATALOG,
        )
        self.payload = payload_body if payload_body is not None else payload()
        self.context = context_body if context_body is not None else context(
            fidelity_tier=fidelity_tier
        )

    def run(self) -> list[Event]:
        """Drain the pipeline, under a watchdog so a stall fails rather than hangs."""
        events, error = self.run_capturing()
        if error is not None:
            raise error
        return events

    def run_capturing(self) -> tuple[list[Event], Exception | None]:
        """Drain the pipeline, returning the events it emitted **and** how it ended.

        `run` cannot serve a gate test on its own: an exception propagating out of the
        `async for` discards the events yielded before it, and "emits no
        `snapshot_ready`" (Req 33.1) is a claim about exactly those events. So the two
        outcomes are returned together and every gate test asserts on both.
        """
        events: list[Event] = []

        async def go() -> None:
            async for event in run_generate_report(
                payload=self.payload,
                context=self.context,
                steps=self.steps,
                artifact_bucket="rpt-artifacts-test",
                progress=self.progress,
                provider=self.provider,
                object_store=self.store,
                catalog=CATALOG,
            ):
                events.append(event)

        try:
            asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))
        except Exception as exc:  # returned to the caller, which asserts on it
            return events, exc
        return events, None


def one_vm_harness(**overrides: Any) -> Harness:
    """A clean, gap-free run: one running VM, every declared metric probed and answered."""
    defaults: dict[str, Any] = {
        "inventory": [inventory_page([inventory_row("prod-web-01")])],
        "skus": [sku_listing()],
        "definitions": [definitions_response(*DECLARED_METRICS)],
        "batches": [batch_response([WEB_01])],
    }
    defaults.update(overrides)
    return Harness(**defaults)


def types_of(events: list[Event]) -> list[str]:
    return [event["type"] for event in events]


def one(events: list[Event], kind: str) -> Event:
    matches = [event for event in events if event["type"] == kind]
    assert len(matches) == 1, f"expected exactly one {kind}, got {types_of(events)}"
    return matches[0]


def snapshot_of(harness: Harness) -> dict[str, Any]:
    return asyncio.run(harness.store.get_json(snapshot_key(ACTOR_ID, RUN_ID)))


def statistics_of(snapshot: dict[str, Any], resource_id_: str) -> list[dict[str, Any]]:
    for resource in snapshot["resources"]:
        if resource["resource_id"] == resource_id_:
            return list(resource["statistics"])
    raise AssertionError(f"{resource_id_} is not in the snapshot")


# --------------------------------------------------------------------------- #
# The event stream (Req 14.7, 14.8, 14.9, 35.7)
# --------------------------------------------------------------------------- #


def test_a_clean_run_emits_two_paired_steps_and_one_snapshot_ready() -> None:
    """Req 14.7, 14.9 — `collect_inventory` then `collect_metrics`, each opened and closed,
    with exactly one `snapshot_ready` after both and nothing after it.

    `done` is deliberately absent: the router emits it, last, on every path (Req 14.10), so
    a pipeline that emitted its own would be claiming an authority it does not have.
    """
    harness = one_vm_harness()

    events = harness.run()

    assert types_of(events) == [
        "tool",
        "progress",
        "tool",
        "tool",
        "progress",
        "progress",
        "tool",
        "snapshot_ready",
    ]
    tools = [event for event in events if event["type"] == "tool"]
    assert [event["name"] for event in tools] == [
        TOOL_COLLECT_INVENTORY,
        TOOL_COLLECT_INVENTORY,
        TOOL_COLLECT_METRICS,
        TOOL_COLLECT_METRICS,
    ]
    assert [event["phase"] for event in tools] == ["start", "end", "start", "end"]
    assert tools[0]["id"] == tools[1]["id"] and tools[2]["id"] == tools[3]["id"]
    assert tools[0]["id"] != tools[2]["id"]
    assert harness.steps.open_ids == (), "every step this pipeline opened, it closed"


def test_progress_events_are_determinate_and_reference_their_open_step() -> None:
    """Req 14.8 — `id`, `done`, `total`, `unit`, `label`, `done <= total`, non-decreasing,
    and every `id` referencing a step that was open when the event was emitted.

    A report run is minutes long, so an indeterminate spinner reads as a hang; the counts
    are what let the timeline render `1 / 1 resources` rather than nothing.
    """
    harness = Harness(
        inventory=[inventory_page([inventory_row("prod-web-01"), inventory_row("prod-web-02")])],
        skus=[sku_listing()],
        definitions=[definitions_response(*DECLARED_METRICS)],
        batches=[batch_response([WEB_01, WEB_02])],
    )

    events = harness.run()

    progress = [event for event in events if event["type"] == "progress"]
    assert len(progress) == 3
    for event in progress:
        assert set(event) == {"type", "id", "done", "total", "unit", "label"}
        assert event["unit"] == "resources"
        assert event["total"] == 2
        assert 0 <= event["done"] <= event["total"]
    inventory_id = events[0]["id"]
    metrics_id = events[3]["id"]
    assert progress[0]["id"] == inventory_id
    assert [event["id"] for event in progress[1:]] == [metrics_id, metrics_id]
    assert [event["done"] for event in progress[1:]] == [0, 2]


def test_the_snapshot_ready_event_carries_the_written_snapshots_own_facts() -> None:
    """Req 35.7, 29.9 — `snapshot_id` equals the written document's `content_hash`, the
    resource count equals the number of resources in it, and the gap list is the
    snapshot's own, so the count this event carries equals the count recorded during
    collection by construction rather than by two lists agreeing.
    """
    harness = one_vm_harness()

    events = harness.run()

    document = snapshot_of(harness)
    ready = one(events, "snapshot_ready")
    assert ready["snapshot_id"] == document["content_hash"] == document["snapshot_id"]
    assert ready["resource_count"] == len(document["resources"]) == 1
    assert ready["gaps"] == document["gaps"]
    assert ready["grain"] == document["grain"] == "PT1H"
    assert ready["window"] == document["window"]
    assert ready["window"] == {
        "start": "2026-07-01",
        "end": "2026-07-01",
        # +07:00, so a local July day starts at 17:00Z the day before (Req 25.7).
        "start_utc": "2026-06-30T17:00:00Z",
        "end_utc": "2026-07-01T17:00:00Z",
    }


def test_the_snapshot_is_written_once_under_the_actors_own_prefix() -> None:
    """Req 35.6 — `<actor_id>/snapshots/<runId>/snapshot.json`, and one object at it."""
    harness = one_vm_harness()

    harness.run()

    key = snapshot_key(ACTOR_ID, RUN_ID)
    assert key.split("/")[0] == ACTOR_ID
    assert key in harness.store.keys()
    writes = [call for call in harness.store.calls if call["key"] == key]
    assert len(writes) == 1
    # The conditional put is what makes write-once a store guarantee rather than a
    # read-then-write race this pipeline would lose (Req 34.6, 34.9).
    assert writes[0]["op"] == "put_bytes_if_absent"
    assert writes[0]["conditional"] is True and writes[0]["wrote"] is True
    assert harness.store.get(key).tags == {"owner-actor-id": ACTOR_ID}


def test_the_phase_callback_reports_collecting_with_its_counts() -> None:
    """Req 38.1 — the phase transition is persisted by a short callback carrying the
    countable work, so the row can feed a determinate bar. Fire-and-forget, so the
    callbacks are awaited out only by the reporter's own close on the terminal path;
    here they are observed through the recording transport.
    """
    harness = one_vm_harness()

    harness.run()
    asyncio.run(harness.progress.aclose())

    phases = [call["phase"] for call in harness.transport.calls]
    assert phases, "at least the entry into `collecting` is reported"
    assert set(phases) == {"collecting"}
    assert all(call["run_id"] == RUN_ID for call in harness.transport.calls)
    assert "progress_token" not in harness.transport.calls[0]


# --------------------------------------------------------------------------- #
# The gates (Req 24.5, 33.1, 33.5, 33.6, 33.7) — task 11.11 owns the full matrix
# --------------------------------------------------------------------------- #


def test_a_zero_resource_union_is_terminal_empty_scope_with_no_snapshot() -> None:
    """Req 33.1, 33.2, 33.5 — terminal, before any metrics request and any write."""
    harness = Harness(inventory=[inventory_page([])])

    with pytest.raises(EmptyScopeError) as caught:
        harness.run()

    assert caught.value.code is ErrorCode.EMPTY_SCOPE
    assert caught.value.terminal is True
    assert harness.metrics_port.batch_calls == [], "no metric was requested"
    assert harness.store.keys() == (), "no raw object and no snapshot was written"
    # Req 33.4's causes are named in the message the app surfaces.
    assert "secret" in caught.value.message and "subscription scope" in caught.value.message


def test_a_subscription_whose_every_vm_is_stopped_is_not_empty_scope() -> None:
    """Req 33.6 — the count includes resources carrying `deallocated` gaps.

    This is the gate's most important negative case: a subscription whose machines are all
    switched off has resources, so it is a report with no measurements and visible gaps,
    not a failure. Counting only the resources that produced a value would fail it here.
    """
    harness = Harness(
        inventory=[
            inventory_page(
                [
                    inventory_row("prod-web-01", power_state="PowerState/deallocated"),
                    inventory_row("prod-web-02", power_state="PowerState/deallocated"),
                ]
            )
        ],
        skus=[sku_listing()],
        definitions=[definitions_response(*DECLARED_METRICS)],
        batches=[batch_response([WEB_01, WEB_02])],
    )

    # Not `EmptyScopeError`: the gate let the run past it, which is the whole point. The
    # run then fails on the *next* gate, because a stopped VM emits nothing and Req 33.7
    # makes zero statistics across every resource terminal in its own right — a different
    # fact, with a different cause to investigate, reported under a different code.
    with pytest.raises(NoStatisticsError):
        harness.run()

    assert harness.metrics_port.batch_calls, (
        "the empty-scope gate admitted the run, so metrics were requested — a gate "
        "counting only resources that produced a value would have failed before this"
    )
    assert {WEB_01, WEB_02} <= set(harness.metrics_port.batch_calls[0]["resource_ids"])


def test_resources_with_no_statistic_at_all_are_terminal_no_statistics() -> None:
    """Req 33.7 — distinct from `EMPTY_SCOPE` and from `PARTIAL_COVERAGE`, and no snapshot.

    Driven by a definitions probe that answers with a metric the catalog does not declare,
    so every requested metric is `metric_not_emitted` and nothing is requested at all: the
    resources resolved and none of them was measurable.
    """
    harness = Harness(
        inventory=[inventory_page([inventory_row("prod-web-01")])],
        skus=[sku_listing()],
        definitions=[definitions_response("Some Other Metric")],
    )

    with pytest.raises(NoStatisticsError) as caught:
        harness.run()

    assert caught.value.code is ErrorCode.NO_STATISTICS
    assert caught.value.terminal is True
    assert harness.store.keys() == ()


def test_distinct_resource_ids_counts_ids_not_rows() -> None:
    """Req 33.6 — "distinct resource ids remaining after de-duplication", counted as such
    here rather than inherited from an upstream de-duplication happening to have run."""
    duplicated = [{"resource_id": WEB_01}, {"resource_id": WEB_01}, {"resource_id": WEB_02}]
    assert distinct_resource_ids(duplicated) == 2  # type: ignore[arg-type]
    assert distinct_resource_ids([]) == 0


@pytest.mark.parametrize(
    ("requested", "unreachable", "escalates"),
    [
        (["southeastasia"], ["southeastasia"], True),
        (["southeastasia", "australiaeast"], ["southeastasia", "australiaeast"], True),
        (["southeastasia", "australiaeast"], ["southeastasia"], False),
        (["southeastasia"], [], False),
        ([], [], False),
        ([], ["southeastasia"], False),
    ],
)
def test_region_unreachable_escalates_only_when_every_location_is_unreachable(
    requested: list[str], unreachable: list[str], escalates: bool
) -> None:
    """Req 24.4 against Req 24.5 — one unreachable location is a gap and the run
    continues; **every** location unreachable is terminal, because there is nothing left
    to collect. An empty requested set escalates nothing: there is no run to fail.
    """
    plan = resolve_run_plan(payload(), context())
    locations = {"requested": requested, "unreachable": unreachable}

    if not escalates:
        assert_some_location_reachable(plan, locations)
        return

    with pytest.raises(RegionUnreachableError) as caught:
        assert_some_location_reachable(plan, locations)
    assert caught.value.code is ErrorCode.REGION_UNREACHABLE
    assert caught.value.terminal is True


def test_a_dns_failure_and_a_failed_fallback_fails_the_only_location_terminally() -> None:
    """Req 24.2, 24.4, 24.5 end to end: the one location's batch endpoint does not resolve,
    its per-resource fallback is rejected, so every location this run requested is
    unreachable and the run fails terminally with no snapshot."""
    from reporting_agent.azure.ports import DnsResolutionError

    location = DNS_UNREACHABLE_LOCATIONS[0]
    harness = Harness(
        inventory=[inventory_page([inventory_row("prod-web-01", location=location)])],
        skus=[sku_listing()],
        definitions=[definitions_response(*DECLARED_METRICS)],
        batches=[DnsResolutionError(location)],
        fallbacks=[raw({"error": {"code": "InternalServerError"}}, status=500)],
    )

    with pytest.raises(RegionUnreachableError) as caught:
        harness.run()

    assert caught.value.terminal is True
    assert harness.store.keys() == (), "no snapshot for a run that reached no location"


# --------------------------------------------------------------------------- #
# The provider's lifetime (Req 19.4, 21.11)
# --------------------------------------------------------------------------- #


def test_a_provider_the_pipeline_built_is_released_even_when_a_gate_fails() -> None:
    """Req 19.4, 21.11 — the run's credential and its SKU listing cache are released at run
    end, on the raising path too.

    SKU restrictions are subscription-scoped and a long-lived container serves more than one
    customer, so a cache outliving its run is a cache that could answer for the wrong
    subscription. The provider is built through the registry here — not injected — because
    an injected provider's lifetime belongs to whoever injected it.
    """
    closed: list[str] = []

    class ClosingProvider:
        async def discover(self, scope: Any) -> Any:
            return {"resources": [], "gaps": []}

        async def collect(self, request: Any) -> Any:  # pragma: no cover - gate fires first
            return {"statistics": {}, "gaps": []}

        def capabilities(self) -> Any:
            return {
                "resource_types": [RESOURCE_TYPE],
                "metrics": {RESOURCE_TYPE: list(DECLARED_METRICS)},
                "grains": ["PT1H", "PT15M"],
                "fidelity_tiers": [FIDELITY_BASELINE, FIDELITY_ENHANCED],
            }

        def close(self) -> None:
            closed.append("released")

    store = InMemoryObjectStore()
    registry.register(
        registry.AZURE_PROVIDER_ID,
        lambda ctx, **options: ClosingProvider(),
        replace=True,
    )
    try:

        async def go() -> None:
            async for _ in run_generate_report(
                payload=payload(),
                context=context(),
                steps=StepTracker(),
                artifact_bucket="rpt-artifacts-test",
                object_store=store,
                catalog=CATALOG,
            ):
                pass

        with pytest.raises(EmptyScopeError):
            asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))
    finally:
        registry.register_lazy(
            registry.AZURE_PROVIDER_ID,
            "reporting_agent.azure.provider:build_provider",
            replace=True,
        )

    assert closed == ["released"]


# --------------------------------------------------------------------------- #
# PARTIAL_COVERAGE (Req 29.5, 29.8, 29.9)
# --------------------------------------------------------------------------- #


def test_a_run_with_gaps_completes_and_reports_partial_coverage_after_snapshot_ready() -> None:
    """Req 29.5 — the run **completes**; `PARTIAL_COVERAGE` is non-terminal and is raised
    only after the snapshot is written and announced, so it can never pre-empt a terminal
    outcome or suppress the artifact.

    Driven by a per-resource 403 inside an HTTP 200 batch response — the failure shape that
    would otherwise average into a report as measured idleness (Req 29.1, 29.3).
    """
    values = batch_response([WEB_01]).body
    assert isinstance(values, dict)
    values["values"][0]["value"][0] = metric_entry(CPU, error_code="AuthorizationFailed")
    harness = Harness(
        inventory=[inventory_page([inventory_row("prod-web-01")])],
        skus=[sku_listing()],
        definitions=[definitions_response(*DECLARED_METRICS)],
        batches=[raw(values)],
    )

    emitted: list[Event] = []

    async def go() -> None:
        async for event in run_generate_report(
            payload=harness.payload,
            context=harness.context,
            steps=harness.steps,
            artifact_bucket="rpt-artifacts-test",
            provider=harness.provider,
            object_store=harness.store,
            catalog=CATALOG,
        ):
            emitted.append(event)

    with pytest.raises(PartialCoverageError) as caught:
        asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))

    assert caught.value.terminal is False, "a report with recorded gaps is an honest result"
    assert caught.value.code is ErrorCode.PARTIAL_COVERAGE
    ready = one(emitted, "snapshot_ready")
    assert types_of(emitted)[-1] == "snapshot_ready"
    assert ready["gaps"], "the gap the 403 produced travels on the event"
    document = snapshot_of(harness)
    assert len(document["gaps"]) == len(ready["gaps"])
    # Req 29.8 — the unreadable resource is present with no CPU value rather than absent.
    entries = statistics_of(document, WEB_01)
    assert entries, "the other metrics were still collected"
    assert not [entry for entry in entries if entry["metric"] == CPU]


# --------------------------------------------------------------------------- #
# Fidelity tier (Req 31.1-31.9)
# --------------------------------------------------------------------------- #


def test_the_two_tier_spellings_match_the_provider_they_are_mirrored_from() -> None:
    """`collect/pipeline.py` may not import `azure/` (Req 18.5), so the two tier strings
    are mirrored by value. This is the guard that keeps the mirror from drifting."""
    assert FIDELITY_BASELINE == AZURE_FIDELITY_BASELINE
    assert FIDELITY_ENHANCED == AZURE_FIDELITY_ENHANCED
    assert FIDELITY_BASELINE != FIDELITY_ENHANCED


def test_a_baseline_subscription_issues_no_log_analytics_query_at_all() -> None:
    """Req 31.3, 31.9 — a `baseline` resource requests no guest-observed metric, so it emits
    no per-volume free space and no guest-observed memory. Structural, not filtered: the
    query is never issued, so there is nothing to filter out afterwards.
    """
    harness = one_vm_harness()

    harness.run()

    assert harness.metrics_port.logs_calls == []
    document = snapshot_of(harness)
    assert document["resources"][0]["fidelity_tier"] == FIDELITY_BASELINE
    entries = statistics_of(document, WEB_01)
    assert entries
    assert all(entry["fidelity_tier"] == FIDELITY_BASELINE for entry in entries)
    assert not [entry for entry in entries if entry["metric"] == DISK_FREE]
    assert not [entry for entry in entries if "instance" in entry]


def test_no_platform_metric_for_in_guest_disk_free_space_is_ever_requested() -> None:
    """Req 31.5 — there is no such platform metric, so the catalog declares none and the
    requested set cannot contain one. Asserted against the catalog and the wire."""
    harness = one_vm_harness()

    harness.run()

    requested = harness.metrics_port.batch_calls[0]["metric_names"]
    assert DISK_FREE not in requested
    assert not [name for name in requested if "free" in name.casefold()]
    assert not [
        metric for metric in VM_CATALOG.metrics if "free" in metric.name.casefold()
    ]
    # It exists only as an enhanced-tier counter, which is a Log Analytics read.
    assert DISK_FREE in {counter.statistic_id for counter in VM_CATALOG.enhanced_counters}


def test_an_enhanced_subscription_records_the_counter_and_the_workspace_per_volume() -> None:
    """Req 31.4 — the declared counter is queried, bounded to the run's window, and every
    resulting value records the counter name, the workspace id and the volume it came from.
    """
    harness = one_vm_harness(
        fidelity_tier=FIDELITY_ENHANCED,
        context_body=context(
            fidelity_tier=FIDELITY_ENHANCED, log_analytics_workspace_id=WORKSPACE
        ),
        logs=[raw_response_from_recorded(load_response("azure", "logs_logical_disk_free_space"))],
    )

    harness.run()

    call = harness.metrics_port.logs_calls[0]
    assert call["workspace_id"] == WORKSPACE
    assert call["resource_id"] == WEB_01
    # Req 31.4's "bound that query to the run's collection window" — the run's own
    # half-open window, not a trailing period.
    assert call["start_time"] == "2026-06-30T17:00:00Z"
    assert call["end_time"] == "2026-07-01T17:00:00Z"

    document = snapshot_of(harness)
    assert document["resources"][0]["fidelity_tier"] == FIDELITY_ENHANCED
    guest = [
        entry for entry in statistics_of(document, WEB_01) if entry["metric"] == DISK_FREE
    ]
    assert {entry["statistic"] for entry in guest} == {"avg", "min", "max"}
    for entry in guest:
        assert entry["instance"] == "C:"
        assert entry["counter"] == "LogicalDisk \\ % Free Space"
        assert entry["workspace_id"] == WORKSPACE
        assert entry["fidelity_tier"] == FIDELITY_ENHANCED
        assert entry["value"] == "41.70", "the recorded reading, at the declared scale"
        assert entry.get("estimated") is None, "a guest sample is measured, not estimated"


def test_every_value_carries_the_tier_recorded_on_its_own_resource() -> None:
    """Req 31.2 — no value may carry a `fidelity_tier` different from its resource's.

    The case that makes this non-trivial: the subscription is `enhanced`, so the provider
    stamped `enhanced` on every platform statistic it produced, and the resource is then
    **raised** to `enhanced` by its own evidence. Both halves must agree, and the pairing
    is asserted per value rather than in aggregate.
    """
    harness = one_vm_harness(
        fidelity_tier=FIDELITY_ENHANCED,
        context_body=context(
            fidelity_tier=FIDELITY_ENHANCED, log_analytics_workspace_id=WORKSPACE
        ),
        logs=[raw_response_from_recorded(load_response("azure", "logs_logical_disk_free_space"))],
    )

    harness.run()

    document = snapshot_of(harness)
    for resource in document["resources"]:
        tier = resource["fidelity_tier"]
        for entry in resource["statistics"]:
            assert entry["fidelity_tier"] == tier, entry["metric"]


@pytest.mark.parametrize("fixture", ["collapsed", "absent"])
def test_a_collapsed_instance_name_emits_no_free_space_value_at_all(fixture: str) -> None:
    """Req 31.6 — `_Total`, absent or empty `InstanceName` where per-volume rows were
    requested: one `instance_name_collapsed` gap, **no** per-volume value and **no**
    resource-level value.

    Both recorded shapes are driven, because a collector that only string-matched `_Total`
    would sail past the empty-string recording of the same AMA regression.
    """
    name = (
        "logs_logical_disk_instance_name_collapsed"
        if fixture == "collapsed"
        else "logs_logical_disk_instance_name_absent"
    )
    harness = one_vm_harness(
        fidelity_tier=FIDELITY_ENHANCED,
        context_body=context(
            fidelity_tier=FIDELITY_ENHANCED, log_analytics_workspace_id=WORKSPACE
        ),
        logs=[raw_response_from_recorded(load_response("azure", name))],
    )

    with pytest.raises(PartialCoverageError):
        harness.run()

    document = snapshot_of(harness)
    collapsed = [
        gap for gap in document["gaps"] if gap["gap_type"] == GAP_TYPE_INSTANCE_NAME_COLLAPSED
    ]
    assert len(collapsed) == 1
    assert collapsed[0]["resource_id"] == WEB_01
    assert collapsed[0]["metric"] == DISK_FREE
    entries = statistics_of(document, WEB_01)
    assert not [entry for entry in entries if entry["metric"] == DISK_FREE]
    assert not [entry for entry in entries if entry.get("instance")]
    # Rows came back, so the agent is delivering: Req 31.7's downgrade triggers are a
    # failure, a rejection and zero rows, and a collapsed instance name is none of them.
    assert document["resources"][0]["fidelity_tier"] == FIDELITY_ENHANCED
    assert COLLAPSED_INSTANCE_NAME in collapsed[0]["message"]


def test_zero_rows_downgrades_the_resource_to_baseline_with_a_no_samples_gap() -> None:
    """Req 31.7 — zero rows inside the window: `baseline`, a `no_samples` gap, run continues.

    And the consequence Req 31.2 draws from it: the platform statistics the provider
    stamped `enhanced` are rewritten to `baseline`, because the resource is `baseline`.
    """
    harness = one_vm_harness(
        fidelity_tier=FIDELITY_ENHANCED,
        context_body=context(
            fidelity_tier=FIDELITY_ENHANCED, log_analytics_workspace_id=WORKSPACE
        ),
        logs=[raw({"tables": [{"name": "PrimaryResult", "columns": [], "rows": []}]})],
    )

    with pytest.raises(PartialCoverageError):
        harness.run()

    document = snapshot_of(harness)
    assert document["resources"][0]["fidelity_tier"] == FIDELITY_BASELINE
    entries = statistics_of(document, WEB_01)
    assert entries and all(entry["fidelity_tier"] == FIDELITY_BASELINE for entry in entries)
    assert not [entry for entry in entries if entry["metric"] == DISK_FREE]
    assert [
        gap
        for gap in document["gaps"]
        if gap["gap_type"] == GAP_TYPE_NO_SAMPLES and gap["metric"] == DISK_FREE
    ]


@pytest.mark.parametrize(
    "logs_response",
    [
        RuntimeError("the workspace rejected the query"),
        raw({"error": {"code": "BadArgumentError"}}, status=400),
    ],
    ids=["raised", "rejected"],
)
def test_a_failed_or_rejected_guest_query_downgrades_and_continues(logs_response: object) -> None:
    """Req 31.7 — a failure and a rejection both record `baseline` plus a `metric_error`
    gap, and neither ends the run: the report is delivered with the platform figures it
    does have and a recorded gap saying what it does not."""
    harness = one_vm_harness(
        fidelity_tier=FIDELITY_ENHANCED,
        context_body=context(
            fidelity_tier=FIDELITY_ENHANCED, log_analytics_workspace_id=WORKSPACE
        ),
        logs=[logs_response],
    )

    with pytest.raises(PartialCoverageError):
        harness.run()

    document = snapshot_of(harness)
    assert document["resources"][0]["fidelity_tier"] == FIDELITY_BASELINE
    assert [
        gap
        for gap in document["gaps"]
        if gap["gap_type"] == GAP_TYPE_METRIC_ERROR and gap["metric"] == DISK_FREE
    ]


def test_an_enhanced_subscription_with_no_workspace_id_collects_at_baseline() -> None:
    """Req 31.1's ceiling, from the other direction: a connection claiming `enhanced` with
    nothing to read the counters from is evidence of nothing, so the resource is `baseline`
    — never `enhanced` on the strength of the connection alone."""
    harness = one_vm_harness(
        fidelity_tier=FIDELITY_ENHANCED,
        context_body=context(fidelity_tier=FIDELITY_ENHANCED),
    )

    with pytest.raises(PartialCoverageError):
        harness.run()

    assert harness.metrics_port.logs_calls == [], "there was no workspace to query"
    document = snapshot_of(harness)
    assert document["resources"][0]["fidelity_tier"] == FIDELITY_BASELINE


def test_a_percentile_is_never_marked_as_measured_for_a_baseline_resource() -> None:
    """Req 31.9 — a `baseline` resource's percentiles are estimates, everywhere they appear,
    and the label says so rather than leaving the reader to infer it."""
    harness = one_vm_harness()

    harness.run()

    document = snapshot_of(harness)
    percentiles = [
        entry
        for entry in statistics_of(document, WEB_01)
        if entry["statistic"].startswith("p") and entry["statistic"][1:].isdigit()
    ]
    assert percentiles, "the catalog declares percentiles for Percentage CPU"
    for entry in percentiles:
        assert entry["estimated"] is True
        assert "est. from" in entry["label"]


# --------------------------------------------------------------------------- #
# Through the router (Req 14.10, 29.5) — the wiring `main.py` adds
# --------------------------------------------------------------------------- #


def test_the_router_turns_a_gapped_run_into_snapshot_ready_error_then_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The whole invocation, through `main.run_invocation`: `snapshot_ready`, then a
    **non-terminal** `error` carrying `PARTIAL_COVERAGE`, then `done` with status
    `completed` and nothing after it (Req 14.10, 29.5).

    This is the ordering the web app's run surfaces read, and it is produced by two modules
    together — the pipeline raises, the router translates — so it is asserted where they
    meet rather than in either one alone.
    """
    values = batch_response([WEB_01]).body
    assert isinstance(values, dict)
    values["values"][0]["value"][0] = metric_entry(CPU, error_code="AuthorizationFailed")
    harness = Harness(
        inventory=[inventory_page([inventory_row("prod-web-01")])],
        skus=[sku_listing()],
        definitions=[definitions_response(*DECLARED_METRICS)],
        batches=[raw(values)],
    )

    monkeypatch.setattr(
        "reporting_agent.collect.pipeline._s3_store",
        lambda bucket, region: harness.store,
    )
    registry.register(
        registry.AZURE_PROVIDER_ID,
        lambda ctx, **options: harness.provider,
        replace=True,
    )
    try:
        invocation = main.parse_invocation(
            {**harness.payload, "context": harness.context}
        )
        events = asyncio.run(
            asyncio.wait_for(_drain(main.run_invocation(invocation)), timeout=WATCHDOG_S)
        )
    finally:
        registry.register_lazy(
            registry.AZURE_PROVIDER_ID,
            "reporting_agent.azure.provider:build_provider",
            replace=True,
        )

    assert types_of(events)[-3:] == ["snapshot_ready", "error", "done"]
    error = one(events, "error")
    assert error["code"] == ErrorCode.PARTIAL_COVERAGE.value
    assert error["terminal"] is False
    done = one(events, "done")
    assert done == {"type": "done", "run_id": RUN_ID, "status": "completed"}
    assert one(events, "snapshot_ready")["snapshot_id"] == snapshot_of(harness)["snapshot_id"]


async def _drain(stream: Any) -> list[Event]:
    collected: list[Event] = []
    async for event in stream:
        collected.append(event)
    return collected


# --------------------------------------------------------------------------- #
# The plain-data round trip
# --------------------------------------------------------------------------- #


def test_a_statistic_survives_the_plain_data_round_trip_byte_for_byte() -> None:
    """The provider boundary is plain data and the Snapshot_Builder takes typed objects, so
    the pipeline rebuilds one from the other. That round trip has to be exact: the value's
    rendered scale is recovered from the string's own fractional digits, so re-rendering
    reproduces the identical decimal string a verifier would later match against.

    Asserted over the statistics a **real** collection produced — including a derived value
    with its `formula` and its ordered `derived_from` — rather than over a hand-built one.
    """
    harness = one_vm_harness()
    collected = asyncio.run(
        harness.provider.collect(
            {
                "scope": {
                    "subscription_id": SUBSCRIPTION,
                    "resource_types": [RESOURCE_TYPE],
                    "resource_groups": [],
                    "tag_filters": {},
                },
                "resources": asyncio.run(
                    harness.provider.discover(
                        {
                            "subscription_id": SUBSCRIPTION,
                            "resource_types": [RESOURCE_TYPE],
                            "resource_groups": [],
                            "tag_filters": {},
                        }
                    )
                )["resources"],
                "metrics_by_resource_type": {RESOURCE_TYPE: list(DECLARED_METRICS)},
                "grain": "PT1H",
                "window": {
                    "start": "2026-07-01",
                    "end": "2026-07-01",
                    "start_utc": "2026-06-30T17:00:00Z",
                    "end_utc": "2026-07-01T17:00:00Z",
                },
                "timezone": "Asia/Jakarta",
                "utc_offset": "+07:00",
            }
        )
    )

    values = [
        value
        for metrics in collected["statistics"].values()
        for statistics in metrics.values()
        for value in statistics.values()
    ]
    assert values, "the collection produced statistics to round-trip"
    derived = [value for value in values if value.get("formula")]
    assert derived, "including a derived value, which carries the most optional fields"

    for value in values:
        rebuilt = statistic_from_plain(value, fidelity_tier=value["fidelity_tier"])
        assert rebuilt.to_plain_data() == value


def test_the_round_trip_overrides_only_the_fidelity_tier() -> None:
    """The one field the round trip deliberately does not preserve, and why: the provider
    holds the subscription's ceiling, the pipeline holds the tier resolved for the resource,
    and Req 31.2 says the value carries the latter."""
    value = {
        "metric": CPU,
        "statistic": "avg",
        "value": "15.00",
        "unit": "percent",
        "estimator": "exact_count_weighted",
        "fidelity_tier": FIDELITY_ENHANCED,
        "sample_count": 120,
    }

    rebuilt = statistic_from_plain(value, fidelity_tier=FIDELITY_BASELINE)

    assert rebuilt.fidelity_tier == FIDELITY_BASELINE
    assert rebuilt.scale == 2 and rebuilt.value == Decimal("15.00")
    assert rebuilt.to_plain_data() == {**value, "fidelity_tier": FIDELITY_BASELINE}


def test_a_malformed_provider_statistic_is_refused_rather_than_defaulted() -> None:
    """A provider handing back a statistic with no `unit` is a bug in that provider;
    substituting a default would put a number with no provenance into an audit artifact."""
    with pytest.raises(ValueError, match="unit"):
        statistic_from_plain(
            {
                "metric": CPU,
                "statistic": "avg",
                "value": "15.00",
                "estimator": "exact_count_weighted",
                "fidelity_tier": FIDELITY_BASELINE,
                "sample_count": 120,
            },
            fidelity_tier=FIDELITY_BASELINE,
        )


# --------------------------------------------------------------------------- #
# The run plan and the snapshot's own shape
# --------------------------------------------------------------------------- #


def test_the_window_and_grain_come_from_the_local_dates_and_the_offsets() -> None:
    """Req 25.1, 25.4, 25.5, 25.7 — half-open from local midnight in the run's zone, and
    `PT1H` for a whole-hour offset."""
    plan = resolve_run_plan(payload(start="2026-07-01", end="2026-07-31"), context())

    assert plan.grain == "PT1H"
    assert plan.window.start_utc.isoformat() == "2026-06-30T17:00:00+00:00"
    assert plan.window.end_utc.isoformat() == "2026-07-31T17:00:00+00:00"
    assert plan.timezone_name == "Asia/Jakarta"
    assert plan.scope_verified is True


def test_a_non_whole_hour_offset_drops_to_the_fifteen_minute_grain() -> None:
    """Req 25.5, 25.6 — derived from the offsets in effect, with no zone list consulted."""
    plan = resolve_run_plan(payload(), context(timezone="Asia/Kathmandu"))

    assert plan.grain == "PT15M"


def test_an_unresolvable_timezone_stops_the_run_before_anything_is_requested() -> None:
    """Req 25.9 — an unresolvable zone would silently change every local-day value, so it
    raises before a provider is built, a metric requested or a snapshot written."""
    harness = one_vm_harness(context_body=context(timezone="Mars/Olympus_Mons"))

    with pytest.raises(ValueError, match="no IANA time zone"):
        harness.run()

    assert harness.inventory_port.calls == []
    assert harness.store.keys() == ()


def test_the_snapshot_records_the_local_day_buckets_with_their_slot_counts() -> None:
    """Req 25.11 — every local day the window touches is retained with the count of slots
    that fell inside it, partial edge days included and never padded."""
    harness = one_vm_harness(payload_body=payload(start="2026-07-01", end="2026-07-02"))

    harness.run()

    buckets = snapshot_of(harness)["resources"][0]["day_buckets"]
    assert [bucket["local_day"] for bucket in buckets] == ["2026-07-01", "2026-07-02"]
    assert [bucket["slot_count"] for bucket in buckets] == [24, 24]


def test_the_snapshot_records_the_sku_capacity_that_was_actually_used() -> None:
    """Req 35.3, 21.2, 21.3 — `vCPUsAvailable`, never `vCPUs`: a constrained-core SKU
    advertises the parent's core count, and using it would overstate capacity fourfold."""
    harness = one_vm_harness()

    harness.run()

    sku = snapshot_of(harness)["resources"][0]["sku"]
    assert sku == {
        "name": SKU_NAME,
        "vcpus_available": "4",
        "memory_bytes": str(int(SKU_MEMORY_BYTES)),
    }


def test_the_snapshot_records_the_requested_scope_and_the_producer() -> None:
    """Req 35.8, 35.9 — the catalog version the collection ran against, and the scope as
    resolved, so a later reader can reproduce the run without consulting it."""
    harness = one_vm_harness()

    harness.run()

    document = snapshot_of(harness)
    assert document["producer"]["catalog_version"] == CATALOG.catalog_version
    assert document["requested_scope"]["resource_types"] == [RESOURCE_TYPE]
    assert document["requested_scope"]["metrics_by_resource_type"] == {
        RESOURCE_TYPE: sorted(DECLARED_METRICS)
    }
    assert document["raw_archive"]["object_count"] == 1
    assert document["raw_archive"]["complete"] is True


# --------------------------------------------------------------------------- #
# Task 11.11 — the gate matrix (Req 24.4, 24.5, 29.5, 29.9, 33.1, 33.5-33.7, 35.7)
#
# Everything above proves each gate fires on the right fact. This section closes the
# matrix around them: the *same* terminal outcome from three different causes, the
# negative case of Req 24.4 driven end to end rather than through the pure predicate,
# Req 29.9's count established independently of the snapshot that carries it, and the
# precedence between gates that would otherwise both fire.
#
# **On a property-based test, and why there is not one here.** The four outcomes are
# mutually exclusive and the gate order decides which occurs, which does read like a
# property. But the classification depends on exactly three predicates — "are there
# distinct resource ids", "is there any statistic", "is every requested location
# unreachable" — plus "was any gap recorded", and every one of them is a boolean over a
# structure, not a value drawn from a range. The input space collapses to the handful of
# equivalence classes `test_the_gates_are_mutually_exclusive_and_ordered` enumerates
# below, so hypothesis would draw 100 examples from ~9 classes: no coverage a table does
# not already give, no shrinking to do (there is no smaller counterexample than "one
# resource, no statistic"), and each case loses the name that says why it matters. The
# two places generation *would* have earned its keep are covered by construction
# instead: nested-but-empty `statistics`, which is the shape a naive emptiness check
# passes, is an explicit case in that table, and the requested/unreachable subset
# relation is already an enumerated matrix in
# `test_region_unreachable_escalates_only_when_every_location_is_unreachable`. The
# repo's property suite lives in `tests/property/` and covers the modules where
# generation does pay — decimals, sketches, bucketing, hashing.
# --------------------------------------------------------------------------- #


NORWAY = DNS_UNREACHABLE_LOCATIONS[0]
EU_01 = resource_id("prod-eu-01")


class RecordingProvider:
    """A provider that delegates to a real one and keeps what crossed the boundary.

    Req 29.9's clause is about the entries recorded **during collection**, so counting
    them from the snapshot that carries them proves only that a list equals itself. This
    wrapper counts them where they are produced — on the way out of `discover` and
    `collect` — which is the only place independent of the document under test.

    It deliberately does **not** implement `collect_guest_counters`: the pipeline decides
    the enhanced tier with `isinstance(provider, GuestCounterProvider)`, so a wrapper
    without that method is a `baseline` run, and every gap the pipeline sees came through
    one of the two methods recorded here.
    """

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.discovered: list[DiscoverResult] = []
        self.collected: list[CollectResult] = []

    async def discover(self, scope: ScopeSpec) -> DiscoverResult:
        result = await self.inner.discover(scope)
        self.discovered.append(result)
        return result

    async def collect(self, request: CollectRequest) -> CollectResult:
        result = await self.inner.collect(request)
        self.collected.append(result)
        return result

    def capabilities(self) -> Capabilities:
        return self.inner.capabilities()

    @property
    def recorded_gaps(self) -> list[GapRecord]:
        """Every gap this run recorded, in the order the pipeline received it."""
        return [
            gap
            for result in (*self.discovered, *self.collected)
            for gap in result["gaps"]
        ]

    @property
    def recorded_statistics(self) -> list[StatValue]:
        return [
            value
            for result in self.collected
            for metrics in result["statistics"].values()
            for values in metrics.values()
            for value in values.values()
        ]


def recording(harness: Harness) -> RecordingProvider:
    """Wrap a harness's provider in place, so the run is driven through the recorder."""
    wrapped = RecordingProvider(harness.provider)
    harness.provider = wrapped  # type: ignore[assignment]
    return wrapped


def gap_keys(gaps: Sequence[Mapping[str, Any]]) -> list[tuple[str, str, str | None]]:
    """Gaps as sorted `(gap_type, resource_id, metric)` triples, for a multiset compare.

    Compared on the typed triple rather than on the whole entry because the snapshot's
    copy has been through the Redaction_Guard scrub (Req 35.4), and a message is exactly
    the field a scrub may rewrite. The count and the typed identity are what Req 29.9 is
    about.
    """
    return sorted(
        (str(gap["gap_type"]), str(gap["resource_id"]), gap.get("metric")) for gap in gaps
    )


# --- EMPTY_SCOPE, whatever the cause (Req 33.1, 33.5) --------------------------------


@pytest.mark.parametrize(
    ("cause", "harness_kwargs"),
    [
        (
            "an expired secret or a revoked role: the inventory answers with no row",
            {"inventory": [inventory_page([])]},
        ),
        (
            "a Reader assignment made on one resource group while the run asks another",
            {
                "inventory": [inventory_page([inventory_row("prod-web-01")])],
                "payload_body": {
                    **payload(),
                    "scope": {
                        "resource_types": [RESOURCE_TYPE],
                        "resource_groups": ["rg-finance-weu"],
                        "tag_filters": {},
                    },
                },
            },
        ),
        (
            "a tag filter that matches nothing in the subscription",
            {
                "inventory": [inventory_page([inventory_row("prod-web-01")])],
                "payload_body": {
                    **payload(),
                    "scope": {
                        "resource_types": [RESOURCE_TYPE],
                        "resource_groups": [],
                        "tag_filters": {"env": "staging"},
                    },
                },
            },
        ),
    ],
    ids=["expired-secret", "over-narrow-scope", "tag-filter"],
)
def test_the_empty_scope_gate_fires_whatever_the_cause_and_emits_no_snapshot_ready(
    cause: str, harness_kwargs: dict[str, Any]
) -> None:
    """Req 33.1, 33.5 — three different causes, one identical terminal outcome: the same
    code, no snapshot object, **no `snapshot_ready` event**, and no metric requested.

    Req 33.1 says "whatever the cause", and these are the three shapes that reach zero:
    an inventory that answered with nothing at all, an inventory that answered with rows
    the run's resource-group scope then excluded, and one whose rows a tag filter
    excluded. All three would otherwise deliver a clean, fully-verified, empty artifact,
    and the causes differ in what the consultant has to go and fix — which is why the
    message names them rather than the gate branching on them.

    The `snapshot_ready` half is asserted on the events the run actually emitted, not
    inferred from the empty store: the event is what the web app's run surface reads, and
    a pipeline that announced a snapshot it never wrote would be worse than either.
    """
    harness = one_vm_harness(**harness_kwargs)

    events, error = harness.run_capturing()

    assert isinstance(error, EmptyScopeError), cause
    assert error.code is ErrorCode.EMPTY_SCOPE
    assert error.terminal is True
    assert "snapshot_ready" not in types_of(events)
    assert harness.metrics_port.batch_calls == []
    assert harness.metrics_port.fallback_calls == []
    assert harness.store.keys() == ()
    # The inventory step opened and closed before the gate fired, and carried no
    # `progress`: a step with nothing to count emits none rather than a `0 / 0` bar
    # (Req 14.7, 14.8, 14.14). The metrics step never opened at all.
    assert types_of(events) == ["tool", "tool"]
    assert harness.steps.open_ids == ()


# --- REGION_UNREACHABLE: the negative case, end to end (Req 24.4 against 24.5) -------


def test_one_unreachable_location_does_not_fail_a_run_that_reached_another() -> None:
    """Req 24.4 — a location whose batch endpoint does not resolve **and** whose
    per-resource fallback also fails is a `region_unreachable` gap per resource and a
    **non-terminal** outcome: the run completes, writes its snapshot and announces it.

    The matrix in `test_region_unreachable_escalates_only_when_every_location_is_
    unreachable` proves the predicate; this proves the run. That distinction matters
    because "does not escalate" is only half the requirement — the other half is that a
    report with a visible hole is still delivered, with the hole recorded per resource
    and no zero standing in for it.

    Driven with two locations: one reachable, and `norwayeast` whose regional endpoint
    raises `DnsResolutionError` and whose ARM fallback answers 500.
    """
    from reporting_agent.azure.ports import DnsResolutionError

    harness = Harness(
        inventory=[
            inventory_page(
                [
                    inventory_row("prod-web-01"),
                    inventory_row("prod-eu-01", location=NORWAY),
                ]
            )
        ],
        # Sorted group order puts `norwayeast` first, and the SKU catalog lists once per
        # location, so the listings are scripted in that order.
        skus=[sku_listing(location=NORWAY), sku_listing()],
        definitions=[definitions_response(*DECLARED_METRICS)] * 2,
        batches=[DnsResolutionError(NORWAY), batch_response([WEB_01])],
        fallbacks=[raw({"error": {"code": "InternalServerError"}}, status=500)] * 3,
    )

    events, error = harness.run_capturing()

    assert isinstance(error, PartialCoverageError), (
        "one unreachable location out of two is a completed run with gaps, not a failure"
    )
    assert error.terminal is False
    # Req 24.3 — the region was never dropped: it was requested through the fallback.
    assert [call["resource_id"] for call in harness.metrics_port.fallback_calls] == [EU_01]

    ready = one(events, "snapshot_ready")
    document = snapshot_of(harness)
    assert ready["snapshot_id"] == document["snapshot_id"]
    assert ready["resource_count"] == 2, "the unreachable location's resource is present"

    unreachable = [
        gap for gap in document["gaps"] if gap["gap_type"] == GAP_TYPE_REGION_UNREACHABLE
    ]
    assert unreachable, "the gap Req 24.4 requires, on the resource it happened to"
    assert {gap["resource_id"] for gap in unreachable} == {EU_01}
    # Req 24.4's "no statistic value and no zero value": the reachable location produced
    # figures, the unreachable one produced none — not a zero, not an absence.
    assert statistics_of(document, WEB_01)
    assert statistics_of(document, EU_01) == []


def test_every_location_unreachable_is_reported_ahead_of_the_no_statistics_gate() -> None:
    """Req 24.5 against Req 33.7 — a run that reached no location also produced no
    statistic, so **both** gates hold; the pipeline reports `REGION_UNREACHABLE`.

    That order is not cosmetic and not interchangeable: both codes are terminal and both
    are true, but `REGION_UNREACHABLE` says *why* nothing was measurable while
    `NO_STATISTICS` says only that nothing was. The consultant's next action differs.
    The "no statistic was produced" half is asserted from what crossed the provider
    boundary, so the test shows the second gate really was armed rather than assuming it.
    """
    from reporting_agent.azure.ports import DnsResolutionError

    harness = Harness(
        inventory=[inventory_page([inventory_row("prod-eu-01", location=NORWAY)])],
        skus=[sku_listing(location=NORWAY)],
        definitions=[definitions_response(*DECLARED_METRICS)],
        batches=[DnsResolutionError(NORWAY)],
        fallbacks=[raw({"error": {"code": "InternalServerError"}}, status=500)] * 3,
    )
    recorder = recording(harness)

    events, error = harness.run_capturing()

    assert isinstance(error, RegionUnreachableError)
    assert error.code is ErrorCode.REGION_UNREACHABLE
    assert error.terminal is True
    assert recorder.recorded_statistics == [], (
        "the no-statistics gate would also have fired; the escalation runs first"
    )
    assert "snapshot_ready" not in types_of(events)
    assert harness.store.keys() == ()


# --- PARTIAL_COVERAGE and the gap count (Req 29.5, 29.9) ----------------------------


def test_the_snapshot_ready_gap_count_equals_the_entries_recorded_during_collection() -> None:
    """Req 29.9 — the count `snapshot_ready` carries equals the count recorded **during
    collection**, established from the gaps that crossed the provider boundary rather
    than from the snapshot's own list.

    A snapshot that dropped one entry, deduplicated two that differ only by message, or
    collapsed a per-metric gap into a per-resource one would still satisfy "the event's
    list equals the document's list". It would not satisfy this.

    Driven with a run that records several types at once, and one type **more than once**
    — a stopped VM excluded from every average, plus a per-resource 403 on one metric of
    each of two running VMs — because neither a single-gap run nor a run with one gap per
    type can tell a count from a set.
    """
    web_03 = resource_id("prod-web-03")
    values = batch_response([WEB_01, WEB_02, web_03]).body
    assert isinstance(values, dict)
    for index in (0, 2):
        values["values"][index]["value"][0] = metric_entry(
            CPU, error_code="AuthorizationFailed"
        )
    harness = Harness(
        inventory=[
            inventory_page(
                [
                    inventory_row("prod-web-01"),
                    inventory_row("prod-web-02", power_state="PowerState/deallocated"),
                    inventory_row("prod-web-03"),
                ]
            )
        ],
        skus=[sku_listing()],
        definitions=[definitions_response(*DECLARED_METRICS)],
        batches=[raw(values)],
    )
    recorder = recording(harness)

    events, error = harness.run_capturing()

    assert isinstance(error, PartialCoverageError) and error.terminal is False
    recorded = recorder.recorded_gaps
    kinds = {gap["gap_type"] for gap in recorded}
    assert GAP_TYPE_DEALLOCATED in kinds, "the stopped VM is recorded, not dropped"
    assert len(kinds) > 1, "more than one type, so a count is compared rather than a flag"
    assert len(recorded) > len(kinds), "and at least one type recorded more than once"

    ready = one(events, "snapshot_ready")
    announced = ready["gaps"]
    assert isinstance(announced, list)
    assert len(announced) == len(recorded)
    assert gap_keys(announced) == gap_keys(recorded)
    # The count the run reports to the app in its non-terminal error is the same count.
    assert str(len(recorded)) in error.message


# --- the four outcomes, enumerated (Req 33.1, 33.7, 24.5, 29.5) ---------------------


@dataclass(frozen=True)
class Shape:
    """One run shape: what the inventory held, what was measurable, what was reachable.

    Deliberately not an Azure conversation. The gates are the pipeline's own decisions
    (see `collect/pipeline.py`'s module docstring), and several of these combinations —
    statistics keyed but empty, locations reported with none requested — are shapes a
    correct Azure client would not produce but a provider protocol permits, which is
    exactly where a gate reading `if not statistics` instead of walking the nesting
    would pass.
    """

    locations: tuple[str, ...]
    """One resource per entry, in that location. Empty means a zero-resource union."""

    statistics: str
    """`"some"`, `"none"`, or `"empty-branches"` — keyed by resource and metric with no
    value at the leaf, the shape a naive emptiness check treats as non-empty."""

    routing: dict[str, list[str]] | None
    """The provider's `locations` fact, or `None` for a provider that reports none."""

    gaps: int


def shaped_resource(name: str, *, location: str) -> ResourceRecord:
    return ResourceRecord(
        resource_id=resource_id(name),
        name=name,
        resource_type=RESOURCE_TYPE,
        location=location,
        resource_group="rg-prod-sea",
        tags={"env": "prod"},
        sku_name=SKU_NAME,
        power_state_raw="PowerState/running",
        power_state="running",
        fidelity_tier=FIDELITY_BASELINE,
    )


def shaped_statistic() -> StatValue:
    return {
        "metric": CPU,
        "statistic": "avg",
        "value": "15.00",
        "unit": "percent",
        "estimator": "exact_count_weighted",
        "fidelity_tier": FIDELITY_BASELINE,
        "sample_count": 60,
    }


class ShapedProvider:
    """A provider that answers with one :class:`Shape` and nothing else."""

    def __init__(self, shape: Shape) -> None:
        self.shape = shape
        self.resources = [
            shaped_resource(f"prod-web-{index:02d}", location=location)
            for index, location in enumerate(shape.locations, start=1)
        ]

    async def discover(self, scope: ScopeSpec) -> DiscoverResult:
        return DiscoverResult(
            resources=list(self.resources),
            gaps=[
                GapRecord(
                    gap_type=GAP_TYPE_NO_SAMPLES,
                    resource_id=self.resources[index % len(self.resources)]["resource_id"]
                    if self.resources
                    else "",
                    metric=CPU,
                    message="a shaped gap, so this run completes as PARTIAL_COVERAGE",
                )
                for index in range(self.shape.gaps)
            ],
        )

    async def collect(self, request: CollectRequest) -> CollectResult:
        statistics: dict[str, dict[str, dict[str, StatValue]]] = {}
        for resource in self.resources:
            if self.shape.statistics == "some":
                statistics[resource["resource_id"]] = {CPU: {"avg": shaped_statistic()}}
            elif self.shape.statistics == "empty-branches":
                statistics[resource["resource_id"]] = {CPU: {}}
        result = CollectResult(statistics=statistics, gaps=[])
        if self.shape.routing is not None:
            result["locations"] = {  # type: ignore[typeddict-item]
                "requested": list(self.shape.routing["requested"]),
                "unreachable": list(self.shape.routing["unreachable"]),
            }
        return result

    def capabilities(self) -> Capabilities:
        return Capabilities(
            resource_types=[RESOURCE_TYPE],
            metrics={RESOURCE_TYPE: [CPU]},
            grains=["PT1H", "PT15M"],
            fidelity_tiers=[FIDELITY_BASELINE, FIDELITY_ENHANCED],
        )


ROUTING_BOTH_REACHABLE = {"requested": [LOCATION, NORWAY], "unreachable": []}
ROUTING_ONE_UNREACHABLE = {"requested": [LOCATION, NORWAY], "unreachable": [NORWAY]}
ROUTING_ALL_UNREACHABLE = {
    "requested": [LOCATION, NORWAY],
    "unreachable": [LOCATION, NORWAY],
}


@pytest.mark.parametrize(
    ("shape", "expected", "why"),
    [
        (
            Shape((), "none", None, 0),
            EmptyScopeError,
            "zero resources is the first gate, and nothing later can reach it",
        ),
        (
            Shape((), "none", ROUTING_ALL_UNREACHABLE, 0),
            EmptyScopeError,
            "all three conditions hold at once; the empty-scope gate runs first because "
            "it runs before any metric is requested at all",
        ),
        (
            Shape((LOCATION,), "none", None, 0),
            NoStatisticsError,
            "resources resolved and nothing was measurable, with no region to blame",
        ),
        (
            Shape((LOCATION,), "empty-branches", None, 0),
            NoStatisticsError,
            "statistics keyed by resource and metric with no value at the leaf: the "
            "shape that passes a gate written as `if not statistics`",
        ),
        (
            Shape((LOCATION, NORWAY), "none", ROUTING_ALL_UNREACHABLE, 0),
            RegionUnreachableError,
            "every requested location unreachable outranks the no-statistics gate, "
            "because it says why nothing was measurable",
        ),
        (
            Shape((LOCATION, NORWAY), "none", ROUTING_ONE_UNREACHABLE, 0),
            NoStatisticsError,
            "one unreachable location does not escalate, so the next gate decides",
        ),
        (
            Shape((LOCATION, NORWAY), "some", ROUTING_ONE_UNREACHABLE, 1),
            PartialCoverageError,
            "the run completed with a hole in it, which is the honest outcome",
        ),
        (
            Shape((LOCATION,), "some", ROUTING_BOTH_REACHABLE, 1),
            PartialCoverageError,
            "a gap of any kind completes the run non-terminally",
        ),
        (
            Shape((LOCATION,), "some", ROUTING_BOTH_REACHABLE, 0),
            None,
            "the only shape that ends with no error at all",
        ),
    ],
    ids=[
        "empty-union",
        "empty-union-beats-everything",
        "no-statistics",
        "no-statistics-nested-but-empty",
        "all-locations-unreachable",
        "one-location-unreachable",
        "completes-with-a-hole",
        "completes-with-a-gap",
        "completes-clean",
    ],
)
def test_the_gates_are_mutually_exclusive_and_ordered(
    shape: Shape, expected: type[Exception] | None, why: str
) -> None:
    """Exactly one outcome per run shape, and the gate order decides which (Req 24.5,
    33.1, 33.7, 29.5).

    The four outcomes — `EMPTY_SCOPE`, `NO_STATISTICS`, `REGION_UNREACHABLE`, and
    completing (with `PARTIAL_COVERAGE` when anything was recorded) — are not
    independent: more than one condition can hold for the same run, and which code the
    consultant sees is a consequence of the order `collect/pipeline.py` states in its
    module docstring. This table is that order, enumerated, with the coupled invariant
    asserted alongside it: a **terminal** outcome writes no snapshot and announces none,
    and a completing one does both exactly once.
    """
    harness = one_vm_harness()
    harness.provider = ShapedProvider(shape)  # type: ignore[assignment]

    events, error = harness.run_capturing()

    if expected is None:
        assert error is None, why
    else:
        assert isinstance(error, expected), f"{why}: got {error!r}"

    terminal = bool(error is not None and getattr(error, "terminal", False))
    if terminal:
        assert "snapshot_ready" not in types_of(events), why
        assert harness.store.keys() == (), why
    else:
        assert one(events, "snapshot_ready")["resource_count"] == len(shape.locations)
        assert snapshot_key(ACTOR_ID, RUN_ID) in harness.store.keys()
