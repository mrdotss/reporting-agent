"""Task 15.3, the agent half — **one full report run, through the entrypoint**.

Every phase of this run already has a suite, and two files already drive most of a walk:

* `test_run_wiring.py` drives `main.invoke` over faked Azure ports, but with a payload
  carrying **no pinned definition** — so it is a snapshot-only run and never reaches a
  compile, a render, a verification or an upload;
* `test_report_pipeline.py` reaches all four, but drives `run_generate_report`
  **directly**, so it never sees `emit`, the heartbeat merge, the router's terminal
  `finally` or the `done` those three produce.

The composition of the two is the gap this file closes: a pinned template version,
compiled against an immutable snapshot, rendered to `.docx` and converted by a **real
LibreOffice**, verified against every gate, uploaded only after the pass, and driven
through `main.invoke` — the function the container serves — with the progress callbacks
recorded and the redaction registry loaded from a context carrying real-shaped secrets.

## What is faked, and what deliberately is not

Faked: the four Azure ports, the object store, the progress transport and the
heartbeat's clock. Those are the four outside edges and a clock.

Real: the provider assembly, the whole collect pipeline, the snapshot build and its
hash, the compiler, `python-docx`, **LibreOffice**, the verifier and every one of its
gates, `StepTracker`, `ProgressReporter`, `emit`, `merge_with_heartbeat`, the redaction
registry and the router's terminal tail. An ordering asserted over this walk is an
ordering between real phases.

**A real LibreOffice is required, not optional.** `render/pdf.py` shells out to it, so a
host without it fails :func:`test_the_conversion_ran_against_a_real_libreoffice` by name
rather than skipping and reporting green — the same reasoning the app half applies to its
Postgres.

## The app's half of this walk is `app/test/db/report-run-end-to-end.integration.test.ts`

A run's other half is TypeScript against Postgres, so no single process drives both. The
two files meet at the callback bodies and at the artifact keys:

* this file asserts the runtime **produces** a `compiling` / `rendering` / `verifying`
  transition and then a verification callback carrying the four scalars and the artifact
  key, and that it writes the four artifacts Req 43.1 names under
  `<actor>/reports/<runId>/`;
* the app file asserts its two endpoints **accept and persist exactly those**, that the
  row only reaches `completed` with a stored passing verification, and that exactly two
  download controls exist for it.

`main` reads its configuration at import (Req 14.12), and `pipeline_harness` performs
that bootstrap — so it is imported first and nothing under `reporting_agent` may be
imported above it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any, Final

import pytest

# `pipeline_harness` sorts ahead of `reporting_agent`, which is what this file depends on:
# it performs the `os.environ` bootstrap — `AWS_REGION`, `RPT_ARTIFACT_BUCKET`,
# `RPT_PROSE_MODEL_ID`, `LANG`, `LO_PROFILE` — that `reporting_agent.main` reads at import
# (Req 14.12). The alphabetical order the linter enforces happens to be the required one;
# it is not a coincidence to rely on silently, so it is written down here.
from fakes.azure_ports import (
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    facts_port_answering_nothing,
)
from pipeline_harness import (
    ACTOR_ID,
    BUCKET,
    CPU,
    LOCATION,
    MEMORY,
    RESOURCE_TYPE,
    RUN_ID,
    SUBSCRIPTION,
    InMemoryObjectStore,
    batch,
    definition,
    df,
    inventory,
    raw,
    report_objects,
    resource_id,
)
from reporting_agent import main
from reporting_agent.artifacts import (
    reports_key,
    verification_key,
)
from reporting_agent.azure.provider import (
    FIDELITY_BASELINE,
    provider_over_ports,
)
from reporting_agent.catalog.loader import DEFAULT_CATALOG_PATH, load_catalog
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.events import (
    EVENT_TYPES,
    HEARTBEAT_EVENT_TYPE,
    TERMINAL_EVENT_TYPE,
)
from reporting_agent.heartbeat import (
    HEARTBEAT_INTERVAL_S,
    HEARTBEAT_TOLERANCE_S,
    MAX_EVENT_GAP_S,
    merge_with_heartbeat,
)
from reporting_agent.progress import (
    TOKEN_HEADER,
    ProgressReporter,
)
from reporting_agent.providers import registry
from reporting_agent.redaction import (
    SECRET_PLACEHOLDER,
    discard_secrets,
    scrub,
)
from reporting_agent.verify.findings import EXCERPT_MAX_CHARS

Event = dict[str, Any]

# Real wall clock. A full run here is a compile, a `python-docx` emission and one
# LibreOffice conversion, so the bound is generous — it exists so that a pipeline which
# stops producing fails as an assertion rather than hanging the suite.
WATCHDOG_S: Final[float] = 300.0

# The four VMs' names. Two, not one: a one-row data table makes a column transposition
# invisible, and the coverage pass has nothing to count against a single resource.
VMS: Final[tuple[str, ...]] = ("prod-web-01", "prod-batch-02")

SKU_NAME: Final[str] = "Standard_D4s_v5"

# The four values Req 15.6 and Req 15.7 forbid from every event, log line, finding
# message and stored byte. Long and distinctive enough that a match could not be a
# coincidence, and obviously none of them is a credential.
CLIENT_SECRET: Final[str] = "not-a-real-client-secret-Zq7Z~x0LmN4pR8sT2vW6yA9cE3gH5jK"
PROGRESS_TOKEN: Final[str] = "not-a-real-progress-token-b7e2d4c6a8f0192837465564738291a0"
TENANT_ID: Final[str] = "tenant-0d4f1a2b-not-a-real-tenant-id"
CLIENT_ID: Final[str] = "client-9e8d7c6b-not-a-real-client-id"

PROGRESS_URL: Final[str] = f"https://app.test/api/internal/runs/{RUN_ID}/progress"

# Req 41.1's document-phase transitions, in the order the state machine drives them.
DOCUMENT_PHASES: Final[tuple[str, ...]] = ("compiling", "rendering", "verifying")

# Req 42.1's four document-phase step names, in order.
DOCUMENT_STEPS: Final[tuple[str, ...]] = (
    "compile_figures",
    "render_document",
    "verify_document",
    "upload_artifact",
)

# Req 43.1 — the four artifacts a run writes for its report. The AST, the prose bundle,
# the emitted HTML and the chart sidecars are written too, for re-verification and for
# the in-app reading view; these four are the ones the requirement names.
REQUIRED_ARTIFACT_LEAVES: Final[tuple[str, ...]] = (
    "report.docx",
    "report.pdf",
    "ledger.json",
)

# The keys the app's `verificationCallbackSchema` accepts. It is `.strict()`, so an extra
# key here is a **rejected** callback — and a rejected verification callback leaves a run
# that verified with no stored proof, which the `verifying → completed` precondition then
# refuses forever.
VERIFICATION_CALLBACK_KEYS: Final[frozenset[str]] = frozenset(
    {
        "run_id",
        "attempt_id",
        "status",
        "figure_count",
        "snapshot_sha256",
        "docx_sha256",
        "pdf_sha256",
        "artifact_key",
    }
)


# --------------------------------------------------------------------------- #
# The canned Azure responses
# --------------------------------------------------------------------------- #


def sku_listing() -> Any:
    """A `resource_skus.list` response declaring the SKU the inventory names.

    Written here rather than taken from `tests/fixtures/azure/`: the recorded fixtures
    describe a **constrained-core** SKU (`Standard_E32-8s_v5`) whose name does not match
    the inventory's, which is a `sku_unknown` gap and therefore a `PARTIAL_COVERAGE` run.
    That is the right fixture for `azure/skus.py`'s own tests and the wrong one here —
    this file's subject is a clean walk to `completed`, and a run carrying gaps would
    reach it through a non-terminal `error` event whose presence would blunt the ordering
    assertions below.

    `vCPUsAvailable` is still distinct from `vCPUs` (Req 21.9), so the capacity this run
    derives from is the one the SKU actually exposes.
    """
    return raw(
        {
            "value": [
                {
                    "resourceType": "virtualMachines",
                    "name": SKU_NAME,
                    "tier": "Standard",
                    "locations": [LOCATION],
                    "capabilities": [
                        {"name": "vCPUs", "value": "8"},
                        {"name": "vCPUsAvailable", "value": "4"},
                        {"name": "MemoryGB", "value": "16"},
                    ],
                    "restrictions": [],
                }
            ]
        }
    )


def definitions_response() -> Any:
    """The metric-definition probe, declaring what this resource type emits here."""
    return raw({"value": [{"name": {"value": CPU}}, {"name": {"value": MEMORY}}]})


def pinned_definition() -> dict[str, Any]:
    """The pinned template version this run renders.

    Four blocks, chosen so the walk exercises the pieces the ordering depends on rather
    than to be a large report: a `heading` for a paragraph the masking pass reads, a
    `resource_table` for the anchored cell-equality pass, `gaps_and_coverage` for the
    coverage pass, and `verification_record` — the block that renders this run's own
    proof, so a report that could not be proven could not render it.
    """
    return definition(
        blocks=[
            df.block("h", "heading", {"text": "Utilization", "level": 1}),
            df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
            df.block("gaps", "gaps_and_coverage", {}),
            df.block("rec", "verification_record", {}),
        ]
    )


def invoke_payload() -> dict[str, Any]:
    """The payload `lib/runs/invoke.ts` sends for a `generate_report` command.

    A **command**, never a prompt: report generation must be reachable without a model
    deciding to call a tool, which is what makes "no LLM produces a number" a property of
    the wiring rather than of a system prompt.

    The context is the full twelve-field shape the app builds, so the fields this half
    ignores are still present — a runtime that broke on one of them would break in
    production and pass a test that omitted it.
    """
    return {
        "command": "generate_report",
        "period": {"start": "2026-07-01", "end": "2026-07-01"},
        "scope": {
            "resource_types": [RESOURCE_TYPE],
            "resource_groups": [],
            "tag_filters": {},
        },
        "definition": pinned_definition(),
        "template_version_id": "tv_01HQZX8QW9K7YB4T2C3M5N6P7Q",
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


# --------------------------------------------------------------------------- #
# The doubles
# --------------------------------------------------------------------------- #


class RecordingTransport:
    """A `ProgressTransport` recording every callback the reporter sent."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post_json(self, url: str, *, body: Any, headers: Any, timeout: Any) -> int:
        self.calls.append(
            {"url": url, "body": dict(body), "headers": dict(headers), "timeout": timeout}
        )
        return 204


class RunawayClock:
    """A clock advancing a full heartbeat interval on every read.

    So the ticker is due on its first read and on every read after it, which makes a
    keep-alive **guaranteed** rather than a matter of scheduling luck. The same idiom
    `test_ordering.py` and `test_run_wiring.py` use for the entrypoint.
    """

    def __init__(self, interval: float) -> None:
        self.interval = interval
        self.now = 0.0

    def __call__(self) -> float:
        self.now += self.interval
        return self.now


class FailingStore(InMemoryObjectStore):
    """The in-memory store, refusing one key.

    For the one negative case in this file: a document phase that ends by **raising**
    still has its `tool` step closed before `done` (Req 42.1). The upload is the phase to
    fail for that, because it is the only document phase whose inputs are all real and
    whose failure can be induced from outside the pipeline — no production module is
    patched, and the run reaches it having genuinely compiled, rendered, converted and
    verified.
    """

    def __init__(self, *, refuse_leaf: str) -> None:
        super().__init__()
        self.refuse_leaf = refuse_leaf

    async def put_bytes(self, key: str, body: bytes, **kwargs: Any) -> None:
        if key.endswith(f"/{self.refuse_leaf}"):
            raise OSError(f"the object store refused {self.refuse_leaf}")
        await super().put_bytes(key, body, **kwargs)


@pytest.fixture(autouse=True)
def _clean_secret_registry() -> AsyncIterator[None]:
    """The registry is a `ContextVar` (Req 15.10), cleared around every test so one
    invocation's secrets never scrub another's output."""
    discard_secrets()
    yield
    discard_secrets()


class Walk:
    """One `main.invoke` over the fakes, with everything the run touched observable."""

    def __init__(self, *, store: InMemoryObjectStore | None = None) -> None:
        self.catalog = load_catalog(DEFAULT_CATALOG_PATH)
        self.store = store if store is not None else InMemoryObjectStore()
        self.transport = RecordingTransport()
        self.inventory_port = FakeInventoryPort([inventory(VMS)])
        self.sku_port = FakeSkuPort([sku_listing()])
        self.definitions_port = FakeDefinitionsPort([definitions_response()])
        self.metrics_port = FakeMetricsPort(
            batch_responses=[batch(VMS)], fallback_responses=[]
        )
        self.provider_builds = 0
        self.azure_calls_at_first_theme_read: int | None = None

    def _build_provider(self, context: Any, **options: Any) -> Any:
        self.provider_builds += 1
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
            catalog=self.catalog,
        )

    # --- driving ------------------------------------------------------------------

    def run(self, monkeypatch: pytest.MonkeyPatch) -> list[Event]:
        """Drive `main.invoke` to exhaustion and return every event it yielded."""
        # The store. Neither `handle_generate_report` nor the pipeline is handed one, so
        # both seams at which a real `S3ObjectStore` would be built are redirected here.
        for module in (
            "reporting_agent.collect.pipeline._s3_store",
            "reporting_agent.report_pipeline._s3_store",
        ):
            monkeypatch.setattr(module, lambda bucket, region: self.store)

        # The progress transport. `parse_invocation` builds the reporter from the context
        # with no seam to pass a transport through, so the class `main` resolves is
        # wrapped — the **real** `ProgressReporter` still runs, throttle included.
        real_reporter = ProgressReporter
        transport = self.transport

        def build_reporter(**kwargs: Any) -> ProgressReporter:
            return real_reporter(transport=transport, **kwargs)

        monkeypatch.setattr(main, "ProgressReporter", build_reporter)

        # The heartbeat's clock and sleep. `invoke` calls `merge_with_heartbeat` with no
        # timing arguments — the defaults bind at definition time — so the merge itself is
        # wrapped rather than the constants patched.
        async def immediately(seconds: float) -> None:
            await asyncio.sleep(0)

        def merge(source: AsyncIterator[Event]) -> AsyncIterator[Event]:
            return merge_with_heartbeat(
                source,
                interval=HEARTBEAT_INTERVAL_S,
                clock=RunawayClock(HEARTBEAT_INTERVAL_S),
                sleep=immediately,
            )

        monkeypatch.setattr(main, "merge_with_heartbeat", merge)

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

    # --- readers ------------------------------------------------------------------

    @property
    def azure_calls(self) -> int:
        return (
            len(self.inventory_port.calls)
            + len(self.sku_port.calls)
            + len(self.definitions_port.calls)
            + len(self.metrics_port.batch_calls)
            + len(self.metrics_port.fallback_calls)
            + len(self.metrics_port.logs_calls)
        )

    def snapshot(self) -> dict[str, Any]:
        return asyncio.run(self.store.get_json(snapshot_key(ACTOR_ID, RUN_ID)))

    def stored_verification(self, attempt_id: str) -> dict[str, Any]:
        return asyncio.run(
            self.store.get_json(verification_key(ACTOR_ID, RUN_ID, attempt_id))
        )

    def bodies(self, phase: str) -> list[dict[str, Any]]:
        return [
            call["body"]
            for call in self.transport.calls
            if call["body"].get("phase") == phase
        ]

    def stored_bytes(self) -> bytes:
        return b"".join(self.store.get(key).body for key in self.store.keys())

    def write_order(self) -> list[str]:
        return [call["key"] for call in self.store.calls if call["wrote"]]


async def _drain(stream: AsyncIterator[Event]) -> list[Event]:
    collected: list[Event] = []
    async for event in stream:
        collected.append(event)
    return collected


# --------------------------------------------------------------------------- #
# Readers over the stream
# --------------------------------------------------------------------------- #


def types_of(events: Sequence[Event]) -> list[str]:
    return [event["type"] for event in events]


def without_heartbeats(events: Sequence[Event]) -> list[Event]:
    return [event for event in events if event["type"] != HEARTBEAT_EVENT_TYPE]


def one(events: Sequence[Event], kind: str) -> Event:
    matches = [event for event in events if event["type"] == kind]
    assert len(matches) == 1, f"expected exactly one {kind}, got {types_of(events)}"
    return matches[0]


def index_of(events: Sequence[Event], kind: str) -> int:
    return types_of(events).index(kind)


def tool_pairs(events: Sequence[Event]) -> list[tuple[str, str]]:
    return [
        (event["name"], event["phase"]) for event in events if event["type"] == "tool"
    ]


# --------------------------------------------------------------------------- #
# One walk, shared — a real LibreOffice conversion is the expensive part
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def walked() -> tuple[Walk, list[Event]]:
    """One clean run to `completed`, driven once for the whole module.

    Module-scoped for cost, and safe to share because nothing below mutates the walk —
    every assertion reads the events, the store or the transport.

    `monkeypatch` is function-scoped, so a `MonkeyPatch` is created and undone by hand
    here; that is the documented way to patch from a module-scoped fixture.
    """
    patcher = pytest.MonkeyPatch()
    discard_secrets()
    try:
        walk = Walk()
        events = walk.run(patcher)
    finally:
        patcher.undo()
        discard_secrets()
    return walk, events


# --------------------------------------------------------------------------- #
# The dependency this walk cannot fake
# --------------------------------------------------------------------------- #


def test_the_conversion_ran_against_a_real_libreoffice(walked) -> None:
    """A real LibreOffice, in the image, and the `.pdf` this run's `.docx` produced.

    Stated as its own test so a host without LibreOffice fails **here**, by name, rather
    than reporting a green suite that never converted anything. Task 15.3 requires the
    conversion to be real; a skip would satisfy the suite and not the requirement.

    The PDF is asserted by its header and by being non-trivial rather than by size alone:
    `render/pdf.py` raises `PdfConversionFailedError` on empty output, so what this rules
    out is a stub that returned plausible bytes.
    """
    assert shutil.which("soffice") is not None, (
        "LibreOffice is absent from this host, so no report run in this suite converted a "
        "real document. Build and run in the agent image, which installs it together with "
        "the fonts each theme references and a pre-warmed profile."
    )

    walk, _ = walked
    pdf = walk.store.get(reports_key(ACTOR_ID, RUN_ID, "report.pdf"))
    assert pdf is not None, "no PDF was written"
    assert pdf.body.startswith(b"%PDF-"), pdf.body[:16]
    assert len(pdf.body) > 1_000, len(pdf.body)

    docx = walk.store.get(reports_key(ACTOR_ID, RUN_ID, "report.docx"))
    assert docx is not None and docx.body.startswith(b"PK\x03\x04"), "no .docx was written"


# --------------------------------------------------------------------------- #
# Req 25.9, 42.4, 42.5 — the ordering contract, at the source
# --------------------------------------------------------------------------- #


def test_the_stream_is_snapshot_ready_then_verification_then_two_report_files_then_done(
    walked,
) -> None:
    """Req 25.9, 42.4, 42.5 — the whole ordering, over one real run.

    The four claims are asserted as **positions**, not as membership: every one of them
    is a statement about what a client may rely on having already seen, so a stream
    carrying the right events in the wrong order satisfies a membership test and violates
    the contract.
    """
    _, events = walked
    ordered = without_heartbeats(events)
    types = types_of(ordered)

    # `snapshot_ready` exactly once, and before any `verification`.
    assert types.count("snapshot_ready") == 1, types
    assert index_of(ordered, "snapshot_ready") < index_of(ordered, "verification")

    # Exactly one `verification`, carrying a pass.
    verification = one(ordered, "verification")
    assert verification["status"] == "pass", verification["findings"]

    # Both `report_file` events after it.
    verification_at = index_of(ordered, "verification")
    report_files = [
        position
        for position, event in enumerate(ordered)
        if event["type"] == "report_file"
    ]
    assert len(report_files) == 2, types
    assert all(position > verification_at for position in report_files), types
    assert {ordered[position]["kind"] for position in report_files} == {"docx", "pdf"}

    # `done` last, once, and nothing of any type after it — including no keep-alive, so
    # this is asserted over the stream **with** heartbeats in it.
    assert types_of(events)[-1] == TERMINAL_EVENT_TYPE, types_of(events)
    assert types_of(events).count(TERMINAL_EVENT_TYPE) == 1
    assert events[-1] == {
        "type": TERMINAL_EVENT_TYPE,
        "run_id": RUN_ID,
        "status": "completed",
    }


def test_no_report_file_names_an_object_that_did_not_exist_when_it_was_emitted(
    walked,
) -> None:
    """The delivery gate, asserted against the store's own write log.

    The ordering above says the events arrive in the right order. This says the *objects*
    do: no report artifact had been written at the moment the `verification` event was
    emitted, and each `report_file`'s key names an object that existed by the time it was.

    Ordering the events alone would leave the window this closes — a pipeline that
    uploaded first and emitted later would satisfy every positional assertion above.
    """
    walk, events = walked
    writes = walk.write_order()

    verification_object = verification_key(
        ACTOR_ID, RUN_ID, str(one(events, "verification")["attempt_id"])
    )
    assert verification_object in writes, writes

    # The verification result is written first, on both paths (Req 25.10) — it is the
    # record the panel presents for a run whose document was withheld.
    at_verification = writes.index(verification_object)
    for key in writes[: at_verification + 1]:
        assert "/reports/" not in key or key == verification_object, (
            f"{key} was written before this run's verification result existed"
        )

    for event in events:
        if event["type"] != "report_file":
            continue
        assert event["key"] in writes, event
        assert writes.index(event["key"]) > at_verification, event
        # Req 42.3 — the event carries the key, the bucket, the kind and the byte count,
        # and no URL and no content.
        assert event["bucket"] == BUCKET
        assert event["bytes"] == len(walk.store.get(event["key"]).body)
        assert "url" not in event and "body" not in event


def test_every_document_phase_step_is_opened_and_closed_in_order(walked) -> None:
    """Req 42.1 — the four step names, each opened once and closed once, in phase order.

    The `tool` stream is the timeline a consultant watches for eight to twelve minutes. A
    step left open is a spinner that never resolves, which is indistinguishable from a
    phase still working.
    """
    _, events = walked
    pairs = tool_pairs(events)
    started = [name for name, phase in pairs if phase == "start"]
    ended = [name for name, phase in pairs if phase == "end"]

    assert started == [
        "collect_inventory",
        "collect_metrics",
        *DOCUMENT_STEPS,
    ], started
    assert ended == started, ended

    # Every `end` precedes `done`, and each pair repeats its own id and name.
    done_at = index_of(events, TERMINAL_EVENT_TYPE)
    open_ids: dict[str, str] = {}
    for position, event in enumerate(events):
        if event["type"] != "tool":
            continue
        assert position < done_at, types_of(events)
        if event["phase"] == "start":
            open_ids[event["id"]] = event["name"]
        else:
            assert open_ids.pop(event["id"]) == event["name"], event
    assert open_ids == {}, f"left open: {open_ids}"


def test_a_document_phase_that_raises_still_closes_its_step_before_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 42.1's second clause — "even for a phase that ended by raising".

    The upload is failed rather than any earlier phase, and from **outside** the pipeline:
    the store refuses one key. So the run genuinely collected, compiled, rendered,
    converted and verified, and the phase that raised is a real one rather than a patched
    seam.

    Two things are asserted, and the second is the delivery gate's other half: the step
    closes before `done`, and **no `report_file` is emitted** for a run whose artifacts
    were not all written.
    """
    walk = Walk(store=FailingStore(refuse_leaf="report.pdf"))
    events = walk.run(monkeypatch)

    ordered = without_heartbeats(events)
    types = types_of(ordered)

    assert types[-1] == TERMINAL_EVENT_TYPE, types
    assert one(ordered, "verification")["status"] == "pass"
    assert "report_file" not in types, types

    upload_positions = [
        position
        for position, event in enumerate(ordered)
        if event["type"] == "tool" and event["name"] == "upload_artifact"
    ]
    upload_events = [ordered[position] for position in upload_positions]
    assert [event["phase"] for event in upload_events] == ["start", "end"], upload_events
    assert upload_events[0]["id"] == upload_events[1]["id"]

    # The closing `end` is inside the stream, ahead of `done`, not behind it. A step left
    # open spins on the timeline forever, which is indistinguishable from a phase still
    # working — and the phase this one belongs to ended by raising.
    assert upload_positions[1] < types.index(TERMINAL_EVENT_TYPE), types

    error = one(ordered, "error")
    assert error["terminal"] is True
    assert ordered[-1]["status"] == "failed"


def test_no_event_falls_outside_the_declared_vocabulary(walked) -> None:
    """Req 42.8 — the document phases add no event type.

    The vocabulary is mirrored in `app/lib/events.ts`, and a type this half invents is a
    type the app's own guard has never seen — so it would reach a client that ignores it
    and render nothing, silently.
    """
    _, events = walked
    for event in events:
        assert event["type"] in EVENT_TYPES, event


# --------------------------------------------------------------------------- #
# Req 42.11 — consecutive events no more than 30 seconds apart
# --------------------------------------------------------------------------- #


def test_the_document_phases_are_kept_inside_the_thirty_second_gap(walked) -> None:
    """Req 42.11 — and it is the **composition** that satisfies it, not the pipeline.

    The pipeline's document phases emit nothing between entering a phase and finishing it;
    a real render or verification of a few hundred resources takes minutes. What keeps the
    stream inside the relay's inactivity window is `merge_with_heartbeat` wrapping the
    router, and that composition only exists in `main.invoke`.

    So two things are asserted, and neither is sufficient alone: the declared cadence fits
    inside the declared bound, and a keep-alive really is emitted **while the document
    phases are in flight** — between the compile step opening and the verification
    arriving — which is the stretch a run spends most of its life in.
    """
    _, events = walked

    # Req 42.11's numbers: a 15-second interval with 5 seconds of tolerance, inside a
    # 30-second bound. `test_timing.py` drives the emitter over 45 simulated seconds; this
    # asserts the two constants are consistent, so a widened interval fails here too.
    assert HEARTBEAT_INTERVAL_S + HEARTBEAT_TOLERANCE_S <= MAX_EVENT_GAP_S
    assert MAX_EVENT_GAP_S <= 30.0

    types = types_of(events)
    compile_start = next(
        position
        for position, event in enumerate(events)
        if event["type"] == "tool"
        and event["phase"] == "start"
        and event["name"] == "compile_figures"
    )
    verification_at = types.index("verification")

    during_document_phases = types[compile_start:verification_at]
    assert HEARTBEAT_EVENT_TYPE in during_document_phases, (
        "no keep-alive was emitted across the compile, render and verify phases, so a "
        "document phase producing no other event would fall outside the relay's "
        "120-second inactivity window"
    )


# --------------------------------------------------------------------------- #
# The refusals before any Azure call, and the snapshot
# --------------------------------------------------------------------------- #


def test_the_theme_was_asserted_before_the_first_azure_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 8.9 — a missing theme costs nothing when this fires and four minutes of
    somebody else's money when it does not.

    Asserted by the absence of every Azure call: a pinned version naming a preset with no
    theme document must fail before inventory, so the four ports record nothing at all.
    """
    walk = Walk()

    # A preset the validator accepts and the image has no theme for is unreachable — the
    # four presets are a closed set on both sides — so the *lookup* is redirected at a
    # name no theme file carries. That is the same absence a deployment missing a theme
    # document presents, arriving through the same code path.
    from reporting_agent.render import themes

    monkeypatch.setattr(
        themes,
        "theme_path",
        lambda preset: themes.THEME_DIR / f"{preset}-absent.docx",
    )

    events = walk.run(monkeypatch)
    ordered = without_heartbeats(events)

    assert walk.azure_calls == 0, (
        "the run reached Azure before asserting its theme, so a deployment missing a "
        "theme document would be discovered after a full collection"
    )
    assert types_of(ordered) == ["error", TERMINAL_EVENT_TYPE], types_of(ordered)
    assert one(ordered, "error")["code"] == "RENDER_FAILED"
    assert snapshot_key(ACTOR_ID, RUN_ID) not in walk.store.keys()
    assert report_objects(walk.store) == []


def test_the_snapshot_is_written_once_conditionally_and_never_updated(walked) -> None:
    """Req 34.9, 35.6 — one conditional write, under the actor's prefix, no update path.

    The prefix is what makes the app's download authorization work: it compares the key's
    first segment against the signed-in user's id, and `actor_id` **is** that id.
    """
    walk, events = walked
    key = snapshot_key(ACTOR_ID, RUN_ID)

    assert key.split("/")[0] == ACTOR_ID
    writes = [call for call in walk.store.calls if call["key"] == key]
    assert len(writes) == 1, writes
    assert writes[0]["op"] == "put_bytes_if_absent"
    assert writes[0]["conditional"] is True and writes[0]["wrote"] is True
    assert walk.store.get(key).tags == {"owner-actor-id": ACTOR_ID}

    # The snapshot the document was compiled against is the one the verification names.
    document = walk.snapshot()
    ready = one(events, "snapshot_ready")
    assert ready["snapshot_id"] == document["content_hash"] == document["snapshot_id"]
    assert ready["resource_count"] == len(document["resources"]) == len(VMS)
    # `snapshot_sha256` **is** the snapshot id: the id is the hash of the canonical bytes,
    # so the verification names the snapshot it was proved against by naming its digest.
    assert one(events, "verification")["snapshot_sha256"] == document["snapshot_id"]

    # The union gate passed on a non-empty scope, which is the reason the rest of this
    # walk exists: zero resources would be zero figures, and zero figures pass every
    # other gate.
    assert document["resources"], "the union gate should have failed an empty scope"
    assert ready["gaps"] == [] == document["gaps"]


# --------------------------------------------------------------------------- #
# Req 43.1 — the artifacts and their keys
# --------------------------------------------------------------------------- #


def test_the_four_artifacts_are_written_under_the_actor_reports_run_prefix(
    walked,
) -> None:
    """Req 43.1 — the `.docx`, the `.pdf`, the ledger and the verification result.

    The key shape is the contract with the app's authorization predicate: the actor id
    first, `reports` second, the run id third — and `app/test/boundaries.static.test.ts`
    asserts that predicate admits exactly `snapshots` and `reports`.
    """
    walk, events = walked
    attempt_id = str(one(events, "verification")["attempt_id"])

    expected = {
        *(reports_key(ACTOR_ID, RUN_ID, leaf) for leaf in REQUIRED_ARTIFACT_LEAVES),
        verification_key(ACTOR_ID, RUN_ID, attempt_id),
    }
    assert len(expected) == 4, expected

    written = set(walk.store.keys())
    assert expected <= written, expected - written

    for key in expected:
        segments = key.split("/")
        assert segments[0] == ACTOR_ID
        assert segments[1] == "reports"
        assert segments[2] == RUN_ID
        assert len(segments) == 4
        assert walk.store.get(key).tags == {"owner-actor-id": ACTOR_ID}

    # The two downloadable ones, and only those two, are named by a `report_file`.
    named = {event["key"] for event in events if event["type"] == "report_file"}
    assert named == {
        reports_key(ACTOR_ID, RUN_ID, "report.docx"),
        reports_key(ACTOR_ID, RUN_ID, "report.pdf"),
    }


def test_the_verification_event_and_the_stored_result_are_the_same_values(
    walked,
) -> None:
    """Req 42.2 — a client that received no event renders the identical panel.

    Compared field by field against the **stored artifact** rather than against a
    re-derivation, because two constructions of "the same" payload is exactly how the
    panel a watcher sees and the panel a reconnecting client sees come to differ.
    """
    walk, events = walked
    event = one(events, "verification")
    stored = walk.stored_verification(str(event["attempt_id"]))

    for field in (
        "attempt_id",
        "run_id",
        "status",
        "figure_count",
        "snapshot_sha256",
        "docx_sha256",
        "pdf_sha256",
        "ledger_sha256",
    ):
        assert json.dumps(event[field], default=str) == json.dumps(
            stored[field], default=str
        ), field

    assert event["figure_count"] > 0, "a report with no figures proves nothing"

    # Req 42.2 — the replay outcome carries **both** compared digests, and they agree:
    # re-running the pure aggregation over this run's archived raw responses reproduced
    # the snapshot bit for bit, with zero Azure calls.
    replay = event["replay"]
    assert replay["possible"] is True, replay
    assert replay["recomputed_sha256"] == replay["stored_sha256"] == stored["snapshot_sha256"]
    assert replay["objects_folded"] == replay["objects_named"] > 0, replay

    # And the drift descriptor carries the seed that makes the sample itself reproducible.
    assert event["drift_sample"]["seed"], "the drift sample must be reproducible"
    assert event["drift_sample"]["n"] <= 25, event["drift_sample"]

    # The digests name the bytes that were actually written.
    from hashlib import sha256

    for field, leaf in (("docx_sha256", "report.docx"), ("pdf_sha256", "report.pdf")):
        body = walk.store.get(reports_key(ACTOR_ID, RUN_ID, leaf)).body
        assert stored[field] == sha256(body).hexdigest(), leaf


# --------------------------------------------------------------------------- #
# The callbacks — the contract with the app half
# --------------------------------------------------------------------------- #


def test_every_document_phase_transition_was_posted(walked) -> None:
    """Req 41.4 — the compile, render and verify transitions each reach the endpoint.

    They are what advance `report_runs.status`, and the row is the record. A transition
    that did not land leaves the reaper to fail a run that succeeded, which is why they
    travel on a path independent of the stream.
    """
    walk, _ = walked
    phases = [call["body"]["phase"] for call in walk.transport.calls if "phase" in call["body"]]

    for phase in DOCUMENT_PHASES:
        assert phase in phases, phases

    # In order, and after `collecting`, and with `completed` last.
    positions = [phases.index(phase) for phase in DOCUMENT_PHASES]
    assert positions == sorted(positions), phases
    assert phases.index("collecting") < positions[0], phases
    assert phases[-1] == "completed", phases
    assert "failed" not in phases, phases


def test_the_verification_callback_carries_the_keys_the_app_accepts(walked) -> None:
    """Req 41.5 — a pointer, not a copy, and exactly the eight keys the app parses.

    The app's schema is `.strict()`, so a key outside this set is a **rejected** callback,
    and a rejected verification callback leaves a run that verified with no stored proof —
    which the `verifying → completed` precondition then refuses, permanently.
    """
    walk, events = walked
    callbacks = [
        call["body"]
        for call in walk.transport.calls
        if "attempt_id" in call["body"]
    ]
    assert len(callbacks) == 1, callbacks
    body = callbacks[0]

    assert set(body) == VERIFICATION_CALLBACK_KEYS, set(body)
    assert body["run_id"] == RUN_ID
    assert body["status"] == "pass"

    event = one(events, "verification")
    assert body["attempt_id"] == event["attempt_id"]
    assert body["figure_count"] == event["figure_count"]
    for field in ("snapshot_sha256", "docx_sha256", "pdf_sha256"):
        assert body[field] == event[field], field
        assert len(body[field]) == 64 and body[field] == body[field].lower()

    # The key names the object that already exists, under this run's actor prefix.
    assert body["artifact_key"] == verification_key(
        ACTOR_ID, RUN_ID, str(body["attempt_id"])
    )
    assert body["artifact_key"] in walk.store.keys()


def test_the_verification_callback_lands_before_the_terminal_one(walked) -> None:
    """The proof is stored before the row is told the run finished.

    `completed` is the status the download control keys off, so a run reaching it before
    its verification was recorded would present a download for a document nothing had
    verified — for as long as the callback took, and forever if it never arrived.
    """
    walk, _ = walked
    order = [
        "verification" if "attempt_id" in call["body"] else call["body"].get("phase")
        for call in walk.transport.calls
    ]
    assert "verification" in order, order
    assert order.index("verification") < order.index("completed"), order


def test_the_token_travels_in_the_header_and_nowhere_else(walked) -> None:
    """Req 38.2 — a URL reaches access logs and proxy logs; a body reaches the row's
    writer. The token authorizes writes to the run state machine, so it goes in exactly
    one place."""
    walk, _ = walked
    assert walk.transport.calls, "no callback was sent"

    for call in walk.transport.calls:
        assert PROGRESS_TOKEN not in call["url"]
        assert call["headers"][TOKEN_HEADER] == PROGRESS_TOKEN
        assert PROGRESS_TOKEN not in json.dumps(call["body"])
        assert "progress_token" not in call["body"]


# --------------------------------------------------------------------------- #
# Req 43.7, 15.6, 15.7 — nothing secret survives the walk
# --------------------------------------------------------------------------- #


def test_no_secret_reaches_an_event_a_stored_object_or_a_finding(walked) -> None:
    """Req 15.6, 15.7, 43.7 — over the output of a **real** run, not a scripted one.

    `test_redaction_property.py` proves the primitives across generated secrets. What it
    cannot prove is that they are actually *on* every path a full report run writes to:
    the events, the stored `.docx` and `.pdf`, the ledger, the verification result and
    every finding message it carries.
    """
    walk, events = walked

    serialized_events = json.dumps(events, default=str)
    stored = walk.stored_bytes()
    verification = walk.stored_verification(str(one(events, "verification")["attempt_id"]))
    serialized_verification = json.dumps(verification, default=str)

    for name, value in (
        ("client_secret", CLIENT_SECRET),
        ("progress_token", PROGRESS_TOKEN),
        ("tenant_id", TENANT_ID),
        ("client_id", CLIENT_ID),
    ):
        assert value not in serialized_events, f"{name} reached an event"
        assert value.encode("utf-8") not in stored, f"{name} reached a stored object"
        assert value not in serialized_verification, f"{name} reached the verification"

    # Not vacuous: the run really did produce a document and store it.
    assert len(events) > 10
    assert reports_key(ACTOR_ID, RUN_ID, "report.docx") in walk.store.keys()
    assert stored, "nothing was stored, so the byte scan above asserts nothing"


def test_the_registry_was_loaded_so_the_absences_above_mean_something(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Req 15.4, 15.5 — registration proven positively.

    A run that registered nothing would pass every absence scan trivially. So a failure
    whose text quotes the client secret — the shape an SDK error takes when it serializes
    the request it failed on — is driven through the same walk, and the log carries the
    **placeholder** instead.

    The failure is induced at the object store rather than at Azure, so the run reaches it
    having compiled, rendered and verified: the scrub is asserted on the document half of
    the pipeline, which is the half this spec adds.
    """
    caplog.set_level(logging.DEBUG)

    class QuotingStore(InMemoryObjectStore):
        async def put_bytes(self, key: str, body: bytes, **kwargs: Any) -> None:
            if key.endswith("/report.pdf"):
                raise OSError(
                    f"the upstream rejected the credential {CLIENT_SECRET} "
                    f"for tenant {TENANT_ID}"
                )
            await super().put_bytes(key, body, **kwargs)

    walk = Walk(store=QuotingStore())
    events = walk.run(monkeypatch)

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert CLIENT_SECRET not in logged, "the secret reached a log record"
    assert SECRET_PLACEHOLDER in logged, (
        "nothing was scrubbed, so the guard was not installed for this invocation and "
        "the absence assertions elsewhere in this file prove nothing"
    )
    assert CLIENT_SECRET not in json.dumps(events, default=str)
    assert "report_file" not in types_of(events)

    # And the registry does not outlive the invocation (Req 15.10).
    assert scrub(f"secret={CLIENT_SECRET}") == f"secret={CLIENT_SECRET}"


def test_every_quoted_excerpt_in_a_finding_is_bounded(walked) -> None:
    """Req 43.7 — each quoted document excerpt is at most 200 characters.

    Asserted over the findings a real run produced, and **non-vacuously**: the clean walk
    above has no blocking finding, so the bound is also asserted over a run that produces
    findings, driven through the same pipeline with model prose quoting a number the
    compiler never placed.

    A finding message can quote document text or a service error, and either can be
    arbitrarily long — a verification result carrying up to 1,000 findings with unbounded
    excerpts is a several-megabyte artifact the panel then has to render.
    """
    walk, events = walked

    def assert_bounded(findings: Sequence[Mapping[str, Any]]) -> None:
        for finding in findings:
            for field in ("observed", "expected", "message", "detail"):
                value = finding.get(field)
                if isinstance(value, str):
                    assert len(value) <= EXCERPT_MAX_CHARS, (field, len(value), finding)

    stored = walk.stored_verification(str(one(events, "verification")["attempt_id"]))
    assert_bounded(stored["findings"])

    # The non-vacuous half — a failing verification, over the same production assembly.
    from pipeline_harness import Pipeline, StubProse

    long_number = "1" + "2" * 400
    failing = Pipeline(
        definition=definition(
            blocks=[
                df.block("sum", "executive_summary", {}),
                df.block("res", "resource_table", {"columns": [df.CPU_AVG]}),
            ]
        ),
        prose=StubProse(f"Utilization averaged {long_number}% across the estate."),
    )
    failing.run()

    result = failing.outcome.verification
    assert result is not None
    assert result["status"] == "fail", "the prose figure should not have verified"
    assert result["findings"], "no finding was recorded, so this asserts nothing"
    assert_bounded(result["findings"])
    assert report_objects(failing.store) == [
        verification_key(ACTOR_ID, RUN_ID, str(result["attempt_id"]))
    ], "a failing verification delivered a document"


# --------------------------------------------------------------------------- #
# The seams this walk rests on
# --------------------------------------------------------------------------- #


def test_the_run_touched_azure_only_through_the_four_faked_ports(walked) -> None:
    """Every port was exercised, which is what makes this an end-to-end run rather than a
    pipeline that short-circuited before the interesting part."""
    walk, _ = walked

    assert walk.provider_builds == 1
    assert walk.inventory_port.calls, "no inventory query"
    assert walk.sku_port.calls, "no SKU listing, so no derived capacity"
    assert walk.definitions_port.calls, "no metric-definition probe"
    assert walk.metrics_port.batch_calls, "no batch metric query"
    # Req 20.4 — cached per (resource_type, region), so one type in one region costs one.
    assert len(walk.definitions_port.calls) == 1
    # A `baseline` run issues no Log Analytics query at all, and the verifier re-queries
    # nothing: replay proves determinism from the archive rather than by re-collecting
    # (Req 25.7, 31.2). So the batch path is the **only** metrics path this run used.
    assert walk.metrics_port.logs_calls == []
    assert walk.metrics_port.fallback_calls == []

    # The `resourceid`s the batch request named are exactly the ones the inventory
    # returned — so the collection covered the union rather than a subset of it.
    requested = {
        rid for call in walk.metrics_port.batch_calls for rid in call["resource_ids"]
    }
    assert requested == {resource_id(name) for name in VMS}, requested
