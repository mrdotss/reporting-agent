"""Task 14.3, the agent half — **one `generate_report`, end to end, through `invoke`**.

Every piece of this run already has a suite. What none of them has is the whole thing
through the **entrypoint**:

* `test_collect_pipeline.py` drives `run_generate_report` directly, so it never sees
  `emit`, `merge_with_heartbeat` or the terminal callback the router fires;
* `test_ordering.py` owns the ordering contract but drives it with **fake handlers**,
  so no assertion there involves a real collection;
* `test_progress.py`, `test_redaction.py` and `test_heartbeat.py` each prove one
  primitive in isolation.

So the composition is the gap: a clean run over the faked ports and the in-memory
object store, driven through `main.invoke` — the function the container actually
serves — asserting the stream, the snapshot, the callbacks and the redaction of a real
run's real output rather than a scripted one's.

## The app's half of this walk is `app/test/db/run-wiring.integration.test.ts`

A run's other half is TypeScript against Postgres, so no single process drives both.
The two files meet at the callback bodies:

* this file asserts the runtime **produces** `phase` / `current` / `total` / `label`
  while collecting, and then `phase` / `snapshot_id` / `resource_count` / `gap_count`;
* the app file asserts its progress endpoint **accepts and persists exactly those**,
  and that the relay renders the counts back out.

`EXPECTED_COLLECTING_KEYS` and `EXPECTED_TERMINAL_KEYS` below are that contract written
down. If the two halves ever diverge, this file fails on the body and the app file fails
on its schema — neither drifts silently.

## What is faked, and what is deliberately not

Faked: the four Azure ports, the object store, the progress transport, and the
heartbeat's clock. Real: the provider, the whole collect pipeline, the snapshot build
and hash, `StepTracker`, `ProgressReporter`, `emit`, `merge_with_heartbeat`, the
redaction registry and the router's terminal `finally`.

`main` reads its configuration at import (Req 14.12), so the two required variables are
set before importing it — the same contract the container satisfies with its
environment.

The provider and the object store reach the pipeline the only way they can from outside:
`handle_generate_report` passes neither, so the **registry** supplies the provider and
`pipeline._s3_store` is patched for the store. That is the recipe
`test_collect_pipeline.py` established for its one router-level test, reused here rather
than reinvented.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator, Sequence
from decimal import Decimal
from typing import Any

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from fakes.azure_ports import (
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    facts_port_answering_nothing,
)
from fakes.object_store import InMemoryObjectStore
from reporting_agent import main
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.azure.provider import provider_over_ports
from reporting_agent.catalog.loader import DEFAULT_CATALOG_PATH, load_catalog
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.events import (
    EMITTED_BY_FOUNDATION,
    HEARTBEAT_EVENT_TYPE,
    TERMINAL_EVENT_TYPE,
    TOOL_COLLECT_INVENTORY,
    TOOL_COLLECT_METRICS,
)
from reporting_agent.heartbeat import merge_with_heartbeat
from reporting_agent.progress import (
    PROGRESS_THROTTLE_S,
    TOKEN_HEADER,
    ProgressReporter,
)
from reporting_agent.providers import registry
from reporting_agent.redaction import SECRET_PLACEHOLDER, discard_secrets, scrub

Event = dict[str, Any]

WATCHDOG_S = 10.0

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
LOCATION = "southeastasia"
RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"
WIRE_TYPE = "microsoft.compute/virtualmachines"
ACTOR_ID = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID = "run_01HQZX8QW9K7YB4T2C3M5N6P7Q"
SKU_NAME = "Standard_D4s_v5"
MEMORY = "Available Memory Bytes"
FIDELITY_BASELINE = "baseline"

PROGRESS_URL = f"https://app.test/api/internal/runs/{RUN_ID}/progress"

# The two values Req 15.1 registers, long and distinctive enough that a match in an
# event, a log line or a stored object could not be a coincidence. Obviously neither is
# a credential.
CLIENT_SECRET = "not-a-real-client-secret-Zq7Z~x0LmN4pR8sT2vW6yA9cE3gH5jK"
PROGRESS_TOKEN = "not-a-real-progress-token-b7e2d4c6a8f0192837465564738291a0"
TENANT_ID = "tenant-0d4f1a2b-not-a-real-tenant-id"
CLIENT_ID = "client-9e8d7c6b-not-a-real-client-id"

# The **metric** catalog alone, so the runs below declare no fact and the fact pass is a
# no-op for them. These suites are about paging, aggregation, the gates, the document phases
# and replay determinism; `test_facts_*` owns the fact pass. Loading the shipped pair here
# would make each of them also an assertion about backup coverage — and, until task 4.4
# teaches `verify/replay.py` to re-derive a fact from the archive, a snapshot carrying facts
# cannot be replayed to an identical digest at all. `load_catalog(path)` declaring no facts
# without a `facts_path` is documented behaviour in `catalog/loader.py`.
CATALOG = load_catalog(DEFAULT_CATALOG_PATH)
_VM_CATALOG = CATALOG.for_resource_type(RESOURCE_TYPE)
assert _VM_CATALOG is not None
DECLARED_METRICS: tuple[str, ...] = tuple(metric.name for metric in _VM_CATALOG.metrics)

# 16 GiB, matching the SKU listing below, so `memory_used_pct` derives to exactly 50.00.
SKU_MEMORY_BYTES = Decimal(16) * Decimal(1073741824)
AVAILABLE_MEMORY_BYTES = SKU_MEMORY_BYTES / 2

# --- The cross-language callback contract ----------------------------------- #
#
# The app's `progressCallbackSchema` is `.strict()`, so an extra key here is a rejected
# callback — and a rejected terminal callback costs a successful run a false `TIMEOUT`.
# These two sets are the contract, asserted below against what a real run produces.

EXPECTED_COLLECTING_KEYS = frozenset({"run_id", "phase", "current", "total", "label"})
EXPECTED_TERMINAL_KEYS = frozenset(
    {"run_id", "phase", "snapshot_id", "resource_count", "gap_count"}
)

# Keys the app's schema accepts. Nothing the reporter sends may fall outside this.
APP_ACCEPTED_KEYS = frozenset(
    {
        "run_id",
        "phase",
        "error_code",
        "error_message",
        "snapshot_id",
        "resource_count",
        "gap_count",
        "current",
        "total",
        "label",
    }
)


# --------------------------------------------------------------------------- #
# Recorded-shaped responses — one running VM, every declared metric answered
# --------------------------------------------------------------------------- #


def resource_id(name: str) -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod-sea"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


WEB_01 = resource_id("prod-web-01")
BATCH_02 = resource_id("prod-batch-02")


def raw(body: object, *, headers: dict[str, str] | None = None) -> RawHttpResponse:
    return RawHttpResponse(status=200, headers=headers or {}, body=body)


def inventory_row(name: str, *, power_state: str = "PowerState/running") -> dict[str, Any]:
    return {
        "id": resource_id(name),
        "name": name,
        "type": WIRE_TYPE,
        "location": LOCATION,
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


def sku_listing() -> RawHttpResponse:
    return raw(
        {
            "value": [
                {
                    "resourceType": "virtualMachines",
                    "name": SKU_NAME,
                    "locations": [LOCATION],
                    "capabilities": [
                        {"name": "vCPUs", "value": "8"},
                        # Req 22.4 — the constrained-core column, not the parent's.
                        {"name": "vCPUsAvailable", "value": "4"},
                        {"name": "MemoryGB", "value": "16"},
                    ],
                }
            ]
        }
    )


def metric_entry(name: str) -> dict[str, Any]:
    count = 1 if name == MEMORY else 60
    reading = int(AVAILABLE_MEMORY_BYTES) if name == MEMORY else 15
    return {
        "name": {"value": name, "localizedValue": name},
        "errorCode": "Success",
        "timeseries": [
            {
                "metadatavalues": [],
                "data": [
                    {
                        "timeStamp": "2026-07-01T00:00:00Z",
                        "total": reading * count,
                        "count": count,
                        "minimum": reading,
                        "maximum": reading,
                    }
                ],
            }
        ],
    }


def batch_response(resource_ids: Sequence[str]) -> RawHttpResponse:
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
                    "value": [metric_entry(name) for name in DECLARED_METRICS],
                }
                for rid in resource_ids
            ]
        }
    )


# --------------------------------------------------------------------------- #
# The invocation
# --------------------------------------------------------------------------- #


def invoke_payload() -> dict[str, Any]:
    """The payload `lib/runs/invoke.ts` sends, context included.

    Written as the twelve-field context the app builds rather than a minimal one, so the
    fields this half ignores are still present — a runtime that broke on one of them
    would break in production and pass a test that omitted it.
    """
    return {
        "command": "generate_report",
        "period": {"start": "2026-07-01", "end": "2026-07-01"},
        "scope": {
            "resource_types": [RESOURCE_TYPE],
            "resource_groups": [],
            "tag_filters": {},
        },
        "context": {
            "actor_id": ACTOR_ID,
            "subscription_id": SUBSCRIPTION,
            "tenant_id": TENANT_ID,
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "timezone": "Asia/Jakarta",
            "display_name": "Contoso production",
            "fidelity_tier": FIDELITY_BASELINE,
            "log_analytics_workspace_id": None,
            "run_id": RUN_ID,
            "progress_url": PROGRESS_URL,
            "progress_token": PROGRESS_TOKEN,
        },
    }


class RecordingTransport:
    """A `ProgressTransport` recording every callback the reporter sent."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post_json(
        self, url: str, *, body: Any, headers: Any, timeout: Any
    ) -> int:
        self.calls.append(
            {"url": url, "body": dict(body), "headers": dict(headers), "timeout": timeout}
        )
        return 204


class SteppingClock:
    """A monotonic clock advancing a fixed number of seconds on every read.

    Used to step past `PROGRESS_THROTTLE_S`. The throttle is real production behaviour
    and it is *why* a fast run reports one `collecting` callback rather than two: the
    pipeline's two in-phase reports happen microseconds apart, so the second is
    suppressed. On a real eight-minute run they are minutes apart and both land.

    So the suite drives both: one case on the real clock, asserting the throttle
    suppresses the second **without** suppressing the transition or the terminal
    callback, and one case on this clock, asserting the counted body is exactly what the
    app's schema accepts.
    """

    def __init__(self, step: float) -> None:
        self.step = step
        self.now = 0.0

    def __call__(self) -> float:
        self.now += self.step
        return self.now


class RunawayClock:
    """A clock advancing a full heartbeat interval on every read.

    So the ticker is due on its **first** read — which happens before the pump can make
    further progress — and a keep-alive is therefore guaranteed rather than a matter of
    scheduling luck. The same idiom `test_ordering.py` uses for the entrypoint.
    """

    def __init__(self, interval: float) -> None:
        self.interval = interval
        self.now = 0.0

    def __call__(self) -> float:
        self.now += self.interval
        return self.now


@pytest.fixture(autouse=True)
def _clean_secret_registry() -> AsyncIterator[None]:
    """The registry is a `ContextVar` (Req 15.10), so it is cleared around every test."""
    discard_secrets()
    yield
    discard_secrets()


class _RaisingProvider:
    """A provider whose `discover` fails, for the redaction case below.

    Failing at `discover` rather than deeper is deliberate: it is the first Azure call a
    run makes, so the failure reaches the router through the same path a real credential
    rejection would, with a `tool` step open and nothing collected.
    """

    def __init__(self, error: BaseException) -> None:
        self._error = error

    async def discover(self, scope: Any) -> Any:
        raise self._error

    async def collect(self, request: Any) -> Any:  # pragma: no cover - discover raises
        raise self._error

    def capabilities(self) -> Any:
        return {
            "resource_types": [RESOURCE_TYPE],
            "metrics": {RESOURCE_TYPE: list(DECLARED_METRICS)},
            "grains": ["PT1H", "PT15M"],
            "fidelity_tiers": [FIDELITY_BASELINE, "enhanced"],
        }

    def close(self) -> None:
        return None


class Wiring:
    """One invocation of `main.invoke`, over the fakes, with everything observable."""

    def __init__(
        self,
        *,
        rows: list[dict[str, Any]] | None = None,
        heartbeat_interval: float = 1.0,
        progress_clock_step: float | None = None,
        provider_error: BaseException | None = None,
    ) -> None:
        resolved = rows if rows is not None else [inventory_row("prod-web-01")]
        ids = [row["id"] for row in resolved]

        self.inventory_port = FakeInventoryPort([inventory_page(resolved)])
        self.sku_port = FakeSkuPort([sku_listing()])
        self.definitions_port = FakeDefinitionsPort(
            [definitions_response(*DECLARED_METRICS)]
        )
        self.metrics_port = FakeMetricsPort(batch_responses=[batch_response(ids)])
        self.store = InMemoryObjectStore()
        self.transport = RecordingTransport()
        self.heartbeat_interval = heartbeat_interval
        self.progress_clock_step = progress_clock_step
        self.provider_error = provider_error
        self.provider_builds = 0

    def _build_provider(self, context: Any, **options: Any) -> Any:
        self.provider_builds += 1

        if self.provider_error is not None:
            return _RaisingProvider(self.provider_error)

        return provider_over_ports(
            inventory_port=self.inventory_port,
            sku_port=self.sku_port,
            definitions_port=self.definitions_port,
            metrics_port=self.metrics_port,
            facts_port=facts_port_answering_nothing(),
            object_store=self.store,
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            fidelity_tier=FIDELITY_BASELINE,
            catalog=CATALOG,
        )

    def run(self, monkeypatch: pytest.MonkeyPatch) -> list[Event]:
        """Drive `main.invoke` to exhaustion and return every event it yielded."""
        # The store: `handle_generate_report` passes none, so the pipeline builds one
        # from the bucket. This is the seam it builds it at.
        monkeypatch.setattr(
            "reporting_agent.collect.pipeline._s3_store",
            lambda bucket, region: self.store,
        )

        # The reporter: `parse_invocation` constructs it from the context, with no seam
        # to pass a transport or a clock through, so the class `main` resolves is what
        # gets wrapped. The **real** `ProgressReporter` is still what runs — the
        # throttle, the forbidden-key drop and the awaited terminal call are all its own.
        real_reporter = ProgressReporter
        transport = self.transport
        step = self.progress_clock_step

        def build_reporter(**kwargs: Any) -> ProgressReporter:
            if step is not None:
                kwargs["clock"] = SteppingClock(step)
            return real_reporter(transport=transport, **kwargs)

        monkeypatch.setattr(main, "ProgressReporter", build_reporter)

        # The heartbeat's clock and sleep. `invoke` calls `merge_with_heartbeat` with no
        # timing arguments — the defaults are bound at definition time — so the merge
        # itself is wrapped rather than the constants patched.
        interval = self.heartbeat_interval

        async def immediately(seconds: float) -> None:
            await asyncio.sleep(0)

        def merge(source: AsyncIterator[Event]) -> AsyncIterator[Event]:
            return merge_with_heartbeat(
                source,
                interval=interval,
                clock=RunawayClock(interval),
                sleep=immediately,
            )

        monkeypatch.setattr(main, "merge_with_heartbeat", merge)

        # The provider: registered, because `handle_generate_report` passes none either.
        registry.register(registry.AZURE_PROVIDER_ID, self._build_provider, replace=True)
        try:
            return asyncio.run(
                asyncio.wait_for(_drain(main.invoke(invoke_payload())), timeout=WATCHDOG_S)
            )
        finally:
            registry.register_lazy(
                registry.AZURE_PROVIDER_ID,
                "reporting_agent.azure.provider:build_provider",
                replace=True,
            )

    # --- readers -----------------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        return asyncio.run(self.store.get_json(snapshot_key(ACTOR_ID, RUN_ID)))

    def bodies(self, phase: str) -> list[dict[str, Any]]:
        return [
            call["body"] for call in self.transport.calls if call["body"]["phase"] == phase
        ]


async def _drain(stream: AsyncIterator[Event]) -> list[Event]:
    collected: list[Event] = []
    async for event in stream:
        collected.append(event)
    return collected


def types_of(events: list[Event]) -> list[str]:
    return [event["type"] for event in events]


def without_heartbeats(events: list[Event]) -> list[Event]:
    return [event for event in events if event["type"] != HEARTBEAT_EVENT_TYPE]


def one(events: list[Event], kind: str) -> Event:
    matches = [event for event in events if event["type"] == kind]
    assert len(matches) == 1, f"expected exactly one {kind}, got {types_of(events)}"
    return matches[0]


# --------------------------------------------------------------------------- #
# The stream (Req 14.7-14.11, 35.7)
# --------------------------------------------------------------------------- #


def test_a_clean_run_through_the_entrypoint_ends_snapshot_ready_then_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 14.9, 14.10 — the whole ordering contract, over a real collection.

    `test_ordering.py` asserts this against fake handlers, which proves the router.
    This asserts it against the collector, which is what actually ships: a pipeline that
    yielded a second `snapshot_ready`, or emitted after the terminal event, would pass
    there and fail here.
    """
    wiring = Wiring()

    events = wiring.run(monkeypatch)
    substantive = types_of(without_heartbeats(events))

    assert substantive == [
        "tool",  # collect_inventory start
        "progress",
        "tool",  # collect_inventory end
        "tool",  # collect_metrics start
        "progress",
        "progress",
        "tool",  # collect_metrics end
        "snapshot_ready",
        TERMINAL_EVENT_TYPE,
    ], substantive

    tools = [event for event in events if event["type"] == "tool"]
    assert [event["name"] for event in tools] == [
        TOOL_COLLECT_INVENTORY,
        TOOL_COLLECT_INVENTORY,
        TOOL_COLLECT_METRICS,
        TOOL_COLLECT_METRICS,
    ]
    assert [event["phase"] for event in tools] == ["start", "end", "start", "end"]

    done = one(events, TERMINAL_EVENT_TYPE)
    assert done == {"type": TERMINAL_EVENT_TYPE, "run_id": RUN_ID, "status": "completed"}
    # Req 14.10 — last, absolutely. A keep-alive the ticker queued behind it is never
    # yielded, because the merge stops reading at the terminal event.
    assert types_of(events)[-1] == TERMINAL_EVENT_TYPE


def test_the_run_emits_keep_alives_and_none_of_them_follows_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 16.1, 16.3, 16.6 — through the composition the entrypoint actually runs.

    The clock is due on the ticker's first read, so the keep-alive is guaranteed rather
    than a matter of scheduling luck — and the assertion that at least one arrived is
    what stops the "none follows `done`" claim below from being vacuous.
    """
    wiring = Wiring()

    events = wiring.run(monkeypatch)
    heartbeats = [event for event in events if event["type"] == HEARTBEAT_EVENT_TYPE]

    assert heartbeats, "the ticker never ran, so this asserts nothing"
    # Req 16.6 — a timestamp and nothing else. No phase, no counts, no run id.
    for beat in heartbeats:
        assert set(beat) == {"type", "ts"}
    # Req 16.7 — non-decreasing.
    stamps = [beat["ts"] for beat in heartbeats]
    assert stamps == sorted(stamps)
    # Req 16.3 — the terminal event is last even with the ticker running hot.
    assert types_of(events).index(TERMINAL_EVENT_TYPE) == len(events) - 1


def test_no_event_falls_outside_this_specs_vocabulary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 14.11, 14.15 — six types, and never `verification` or `report_file`.

    Structural rather than hopeful: `emit` refuses anything outside
    `EMITTED_BY_FOUNDATION`, so a run that produced one would raise rather than reach
    this assertion. Asserted anyway, because "the run emitted neither" is the claim the
    app's ordering guarantee rests on.
    """
    events = Wiring().run(monkeypatch)
    types = set(types_of(events))

    assert types <= EMITTED_BY_FOUNDATION, types
    assert "verification" not in types
    assert "report_file" not in types


def test_progress_events_are_determinate_and_reference_an_open_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 14.8 — the counts the app's determinate bar is ultimately fed from.

    Two resources, so a total of 2 is a number the pipeline had to compute rather than a
    constant that happens to read correctly at 1.
    """
    wiring = Wiring(
        rows=[inventory_row("prod-web-01"), inventory_row("prod-batch-02")]
    )

    events = wiring.run(monkeypatch)
    progress = [event for event in events if event["type"] == "progress"]

    assert len(progress) == 3
    for event in progress:
        assert set(event) == {"type", "id", "done", "total", "unit", "label"}
        assert event["unit"] == "resources"
        assert event["total"] == 2
        assert 0 <= event["done"] <= event["total"]

    # Every id references a `tool` step that was open when the event was emitted.
    open_ids: set[str] = set()
    for event in without_heartbeats(events):
        if event["type"] == "tool":
            if event["phase"] == "start":
                open_ids.add(event["id"])
            else:
                open_ids.discard(event["id"])
        elif event["type"] == "progress":
            assert event["id"] in open_ids, event


# --------------------------------------------------------------------------- #
# The snapshot (Req 34.9, 35.6, 35.7)
# --------------------------------------------------------------------------- #


def test_the_snapshot_is_written_once_conditionally_under_the_actors_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 34.9, 35.6 — one conditional write, at `<actor_id>/snapshots/<runId>/`.

    The prefix is what makes the app's download authorization work: it compares the
    key's first segment against the signed-in user's id, and `actor_id` **is** that id.
    """
    wiring = Wiring()

    wiring.run(monkeypatch)

    key = snapshot_key(ACTOR_ID, RUN_ID)
    assert key.split("/")[0] == ACTOR_ID
    assert key.endswith("snapshot.json")

    writes = [call for call in wiring.store.calls if call["key"] == key]
    assert len(writes) == 1
    assert writes[0]["op"] == "put_bytes_if_absent"
    assert writes[0]["conditional"] is True and writes[0]["wrote"] is True
    assert wiring.store.get(key).tags == {"owner-actor-id": ACTOR_ID}


def test_the_snapshot_ready_event_carries_the_written_documents_own_facts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 35.7 — the event and the object agree because there is one source, not two.

    Also the seam the app reads: the relay's `snapshot_ready` reports `gap_count` from
    the row while the gap **list** comes from this object, so the two must be the same
    collection's.
    """
    wiring = Wiring()

    events = wiring.run(monkeypatch)
    document = wiring.snapshot()
    ready = one(events, "snapshot_ready")

    assert ready["snapshot_id"] == document["content_hash"] == document["snapshot_id"]
    assert ready["resource_count"] == len(document["resources"]) == 1
    assert ready["gaps"] == document["gaps"]
    assert ready["grain"] == "PT1H"
    # +07:00, so a local July day starts at 17:00Z the day before (Req 25.7).
    assert ready["window"] == {
        "start": "2026-07-01",
        "end": "2026-07-01",
        "start_utc": "2026-06-30T17:00:00Z",
        "end_utc": "2026-07-01T17:00:00Z",
    }


def test_every_metric_value_in_the_snapshot_is_a_decimal_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 27.x, 34.x — no JSON number survives into a hashed document.

    Asserted over the object a real run wrote rather than over a hand-built one, because
    the failure mode is a float that entered through one accumulator and left through
    the serializer looking fine.
    """
    wiring = Wiring()

    wiring.run(monkeypatch)
    document = wiring.snapshot()

    values: list[Any] = []
    for resource in document["resources"]:
        for statistic in resource["statistics"]:
            values.append(statistic["value"])

    assert values, "the run produced no statistic, so this asserts nothing"
    for value in values:
        assert isinstance(value, str), value
        Decimal(value)  # raises if it is not a decimal string


# --------------------------------------------------------------------------- #
# The callbacks — the contract with `app/test/db/run-wiring.integration.test.ts`
# --------------------------------------------------------------------------- #


def test_the_collecting_callback_carries_exactly_the_keys_the_app_accepts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 38.1 — the phase transition, with the countable work.

    The app's schema is `.strict()`, so a key outside `APP_ACCEPTED_KEYS` is a **rejected
    callback** rather than an ignored field — and a rejected transition leaves the row
    behind until the reaper fails it.

    Driven on a stepped clock, because the reporter's in-phase throttle is real: the
    pipeline's two `collecting` reports happen microseconds apart here and minutes apart
    on a real run, so without stepping past `PROGRESS_THROTTLE_S` the counted one never
    leaves. The case below asserts the throttle's own behaviour.
    """
    wiring = Wiring(progress_clock_step=PROGRESS_THROTTLE_S * 2)

    wiring.run(monkeypatch)
    collecting = wiring.bodies("collecting")

    assert collecting, "entry into `collecting` is reported"
    for body in collecting:
        assert set(body) <= APP_ACCEPTED_KEYS, set(body) - APP_ACCEPTED_KEYS
        assert body["run_id"] == RUN_ID

    # The ones carrying counts are what the determinate bar is fed from, and they arrive
    # in the order they were reported — which is the assertion, not an incidental fact
    # about the last one.
    #
    # This used to assert `counted[-1]` carried `current == 0`, and it passed because
    # delivery was **unordered**: `report` scheduled each callback as an independent task
    # and whichever POST settled first was recorded first. The bar's last word was
    # whichever one won the race. Ordering delivery made the sequence what the pipeline
    # actually reports — 0 of 1 while metrics are folding, then 1 of 1 as the snapshot is
    # built — and a determinate bar that ends anywhere but full is the defect, not the
    # expectation.
    counted = [body for body in collecting if "total" in body]
    assert counted, "no `collecting` callback carried a total"
    for body in counted:
        assert set(body) == EXPECTED_COLLECTING_KEYS

    assert [
        (body["current"], body["total"], body["label"]) for body in counted
    ] == [(0, 1, "Metrics"), (1, 1, "Snapshot")], (
        "the counted `collecting` callbacks did not arrive in the order the pipeline "
        "reported them, so the bar the consultant watches moves backwards"
    )


def test_the_throttle_suppresses_a_second_in_phase_report_and_nothing_else(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 38.15 — at most one progress callback per 5 seconds per phase, and **neither**
    a phase transition nor the terminal callback is ever delayed or suppressed by it.

    On the real clock this run's two in-phase reports are microseconds apart, so the
    second is dropped — which is the whole point: a 200-resource run folds many batches,
    and posting per batch would turn a four-request budget into hundreds. What must
    survive regardless is the transition itself and the terminal call.
    """
    wiring = Wiring()

    wiring.run(monkeypatch)
    phases = [call["body"]["phase"] for call in wiring.transport.calls]

    # The transition landed, once, despite the throttle.
    assert phases.count("collecting") == 1
    # And so did the terminal call, which is the one whose loss costs a false TIMEOUT.
    assert phases.count("completed") == 1


def test_the_terminal_callback_carries_the_completion_facts_the_row_records(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 38.4, 38.12 — awaited, and carrying exactly what the row records.

    Losing this callback costs a successful run a false `TIMEOUT`, which is why it is
    awaited rather than fire-and-forget: the container is about to exit.
    """
    wiring = Wiring()

    events = wiring.run(monkeypatch)
    terminal = wiring.bodies("completed")

    assert len(terminal) == 1
    body = terminal[0]

    assert set(body) == EXPECTED_TERMINAL_KEYS, set(body)
    assert set(body) <= APP_ACCEPTED_KEYS
    assert body["run_id"] == RUN_ID

    # The same three numbers the `snapshot_ready` event carried, from one source.
    ready = one(events, "snapshot_ready")
    assert body["snapshot_id"] == ready["snapshot_id"]
    assert body["resource_count"] == ready["resource_count"]
    assert body["gap_count"] == len(ready["gaps"])

    # A 64-character lowercase hex digest, which is what the app's schema requires.
    assert len(body["snapshot_id"]) == 64
    assert body["snapshot_id"] == body["snapshot_id"].lower()
    int(body["snapshot_id"], 16)


def test_the_terminal_callback_is_the_last_one_and_follows_the_collecting_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wiring = Wiring()

    wiring.run(monkeypatch)
    phases = [call["body"]["phase"] for call in wiring.transport.calls]

    assert phases[-1] == "completed"
    assert set(phases[:-1]) <= {"collecting"}
    assert "failed" not in phases


def test_the_token_travels_in_the_header_and_never_in_the_url_or_the_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 38.2 — a URL reaches access logs and proxy logs; a body reaches the row's
    writer. The token authorizes writes to the run state machine, so it goes in exactly
    one place.
    """
    wiring = Wiring()

    wiring.run(monkeypatch)

    assert wiring.transport.calls, "no callback was sent"
    for call in wiring.transport.calls:
        assert call["url"] == PROGRESS_URL
        assert PROGRESS_TOKEN not in call["url"]
        assert call["headers"][TOKEN_HEADER] == PROGRESS_TOKEN
        assert PROGRESS_TOKEN not in json.dumps(call["body"])
        assert "progress_token" not in call["body"]
        assert "token" not in call["body"]


# --------------------------------------------------------------------------- #
# Redaction over a whole real run (Req 15.6, 15.7)
# --------------------------------------------------------------------------- #


def test_no_registered_secret_reaches_an_event_a_log_line_or_a_stored_object(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Req 15.6, 15.7 — asserted over the output of a **real** run, not a scripted one.

    `test_redaction_property.py` proves the primitives across generated secrets. What
    that cannot prove is that the primitives are actually *on* every path a real
    invocation writes to, which is what this asserts: every event, every log record the
    run produced, and every byte it stored.
    """
    caplog.set_level(logging.DEBUG)
    wiring = Wiring()

    events = wiring.run(monkeypatch)

    serialized_events = json.dumps(events)
    serialized_logs = "\n".join(
        record.getMessage() for record in caplog.records
    ) + "\n".join(str(record.args) for record in caplog.records)
    stored = b"".join(wiring.store.get(key).body for key in wiring.store.keys())

    for name, secret in (
        ("client_secret", CLIENT_SECRET),
        ("progress_token", PROGRESS_TOKEN),
    ):
        assert secret not in serialized_events, f"{name} reached an event"
        assert secret not in serialized_logs, f"{name} reached a log record"
        assert secret.encode("utf-8") not in stored, f"{name} reached a stored object"

    # Neither identifier belongs in an artifact either. They are not registered as
    # scrubbing patterns — they are not credentials — but nothing writes them, and this
    # is what says so.
    for identifier in (TENANT_ID, CLIENT_ID):
        assert identifier not in serialized_events
        assert identifier.encode("utf-8") not in stored

    # Not vacuous: the run really did produce events and really did store the snapshot.
    assert len(events) > 5
    assert snapshot_key(ACTOR_ID, RUN_ID) in wiring.store.keys()


def test_a_failure_quoting_the_secret_is_scrubbed_on_the_way_out(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Req 15.4, 15.5 — and the half that makes the scan above mean something.

    A run that registered nothing would pass a "no secret appears" scan trivially. So
    registration is proven positively: a collection failure whose text quotes the client
    secret — the shape an SDK error takes when it serializes the request it failed on —
    reaches the log carrying the **placeholder** instead.

    The event carries only the exception's type name, deliberately: a stack frame is a
    debugging aid, not something to relay to a browser. So the log is where this has to
    be asserted, and it is the harder of the two paths.
    """
    caplog.set_level(logging.DEBUG)
    wiring = Wiring(
        provider_error=RuntimeError(
            f"the upstream rejected the credential {CLIENT_SECRET} for {TENANT_ID}"
        )
    )

    events = wiring.run(monkeypatch)
    logged = "\n".join(record.getMessage() for record in caplog.records)

    # The run still ends properly: a terminal error, then `done`, with the step the
    # failing phase abandoned closed in between.
    assert types_of(without_heartbeats(events))[-1] == TERMINAL_EVENT_TYPE
    error = one(events, "error")
    assert error["terminal"] is True

    assert CLIENT_SECRET not in logged, "the secret reached a log record"
    assert SECRET_PLACEHOLDER in logged, (
        "nothing was scrubbed, so the guard was not installed for this invocation and "
        "the absence assertions elsewhere in this file prove nothing"
    )
    assert CLIENT_SECRET not in json.dumps(events)


def test_the_registry_is_discarded_when_the_invocation_ends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 15.10 — one invocation's secrets never scrub another's output.

    `discard_secrets()` runs in `invoke`'s `finally`, after `done` has been scrubbed and
    yielded, so teardown can neither leave a later event unscrubbed nor carry a pattern
    into the next run.
    """
    wiring = Wiring()

    wiring.run(monkeypatch)

    assert scrub(f"secret={CLIENT_SECRET}") == f"secret={CLIENT_SECRET}"
    assert scrub(f"token={PROGRESS_TOKEN}") == f"token={PROGRESS_TOKEN}"
    # Not vacuous: the run really did construct a reporter, which registers the token.
    assert wiring.transport.calls


# --------------------------------------------------------------------------- #
# The seams this walk depends on
# --------------------------------------------------------------------------- #


def test_the_provider_is_built_through_the_registry_once_per_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pipeline builds its own provider, so the registry is the only injection point
    — and it builds **one**, whose credential and SKU cache are released at run end.

    A second build per run would mean a second credential and a second cache, and a SKU
    cache outliving its run is one that could answer for the wrong subscription.
    """
    wiring = Wiring()

    wiring.run(monkeypatch)

    assert wiring.provider_builds == 1


def test_the_run_touched_azure_only_through_the_four_faked_ports(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every port was exercised, which is what makes this an end-to-end run rather than
    a pipeline that short-circuited before the interesting part."""
    wiring = Wiring()

    wiring.run(monkeypatch)

    assert wiring.inventory_port.calls, "no inventory query"
    assert wiring.sku_port.calls, "no SKU listing, so no derived memory percentage"
    assert wiring.definitions_port.calls, "no metric-definition probe"
    assert wiring.metrics_port.batch_calls, "no batch metric query"
    # Req 20.4 — the definitions probe is cached per (resource_type, region), so one
    # resource type in one region costs exactly one probe.
    assert len(wiring.definitions_port.calls) == 1
    # A `baseline` run issues no Log Analytics query at all.
    assert wiring.metrics_port.logs_calls == []
