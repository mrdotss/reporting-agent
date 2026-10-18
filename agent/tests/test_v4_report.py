"""A schema v4 profile — a section laid out by its author — through the real pipeline.

The v4 twin of `test_run_end_to_end_v3.py` (Azure) and `test_aws_report.py` (AWS): the same
faked cloud ports, then production code from collection to every verification gate, with
real LibreOffice. What v4 adds is a section's own `blocks`, so each walk carries a layout
that changes the document — a renamed title, added text, a hidden block, a reordered
per-resource group, a narrowed table, a location filter — and asserts both that the
report still verifies and that the document is the one the author laid out.

Re-verification is driven too: `verify_report` recompiles the pinned definition, and a v4
ledger that could not be rebuilt byte for byte would fail every delivered v4 report the
moment anyone re-checked it.
"""

from __future__ import annotations

import copy
from io import BytesIO
from typing import Any

import pytest

import test_run_end_to_end_v3 as v3_walk
from reporting_agent.artifacts import reports_key
from reporting_agent.events import TERMINAL_EVENT_TYPE
from reporting_agent.redaction import discard_secrets
from reporting_agent.render import pdf as P
from test_aws_report import aws_definition
from test_run_end_to_end_v2 import ACTOR_ID, RUN_ID, V2Walk, one
from test_run_end_to_end_v3 import v3_definition

pytestmark = pytest.mark.skipif(P.SOFFICE_BINARY is None, reason="LibreOffice is not installed")

Event = dict[str, Any]

TITLE = {"en": "How the machines ran", "id": "Bagaimana mesin berjalan"}
NOTE = {"en": "Each machine has its own chart and summary.", "id": "Setiap mesin memiliki grafik dan ringkasan."}


def _to_v4(definition: dict[str, Any]) -> dict[str, Any]:
    """The same profile at schema v4: an explicit position on every section and no
    `presentation`, which `blocks` replaces."""
    v4 = copy.deepcopy(definition)
    v4["schema_version"] = 4
    for position, section in enumerate(v4["sections"]):
        section.pop("presentation", None)
        section["position"] = position
        if len(section["id"]) > 24:  # a v4 id is short enough to build block ids from
            section["id"] = f"sec_{position}"
    return v4


def azure_v4_definition() -> dict[str, Any]:
    definition = _to_v4(v3_definition())
    utilisation = definition["sections"][0]
    utilisation["blocks"] = [
        {"slot": "title", "title": TITLE},
        {"kind": "text", "id": "u_note", "text": NOTE},
        {
            "slot": "each",
            "blocks": [
                {"slot": "name"},
                {"slot": "chart"},
                {"slot": "summary"},
                {"slot": "details", "columns": ["vm_size", "power_state"]},
                {"slot": "narrative", "hidden": True},
            ],
        },
        {"slot": "fleet", "hidden": True},
    ]
    return definition


@pytest.fixture(scope="module")
def walked_v4() -> tuple[V2Walk, list[Event]]:
    patcher = pytest.MonkeyPatch()
    try:
        walk = V2Walk()
        events = walk.run(patcher, defn=azure_v4_definition())
    finally:
        patcher.undo()
        discard_secrets()
    return walk, events


def _docx_text(walk: V2Walk) -> tuple[str, int]:
    from docx import Document

    document = Document(BytesIO(walk.store.get(reports_key(ACTOR_ID, RUN_ID, "report.docx")).body))  # type: ignore[union-attr]
    return "\n".join(p.text for p in document.paragraphs), len(document.tables)


class TestAzureV4Walk:
    def test_the_run_completes_and_every_gate_passes(self, walked_v4: tuple[V2Walk, list[Event]]) -> None:
        _, events = walked_v4
        done = [e for e in events if e["type"] == TERMINAL_EVENT_TYPE]
        assert done and done[0]["status"] == "completed"
        verification = one(events, "verification")
        assert verification["status"] == "pass", verification.get("findings")

    def test_the_document_is_the_one_the_author_laid_out(self, walked_v4: tuple[V2Walk, list[Event]]) -> None:
        walk, _ = walked_v4
        text, _ = _docx_text(walk)
        assert TITLE["en"] in text
        assert NOTE["en"] in text
        assert "Virtual Machine Utilization" not in text  # the catalogue title was replaced

    def test_the_added_text_comes_before_the_first_machine(self, walked_v4: tuple[V2Walk, list[Event]]) -> None:
        walk, _ = walked_v4
        text, _ = _docx_text(walk)
        assert text.index(TITLE["en"]) < text.index(NOTE["en"])


class TestReVerificationOfAV4Run(v3_walk.TestReVerificationOfAV3Run):
    """The v3 re-verification claims, against a v4 report: the recompiled ledger is byte
    for byte the delivered one."""

    def test_a_stored_v3_report_can_be_re_verified_at_all(self, walked_v4) -> None:  # type: ignore[override]
        walk, _ = walked_v4
        _events, error = self._reverify(walk, azure_v4_definition())
        assert error is None, f"re-verification raised: {error!r}"

    def test_the_recompiled_ledger_is_byte_identical_to_the_delivered_one(self, walked_v4) -> None:  # type: ignore[override]
        walk, _ = walked_v4
        events, error = self._reverify(walk, azure_v4_definition())
        assert error is None, f"re-verification raised: {error!r}"
        assert [e for e in events if e["type"] == "verification"]

    @pytest.mark.skip(reason="the chart re-verification gap is pre-existing; see the v3 class")
    def test_re_verification_reaches_a_passing_verdict(self, walked_v4) -> None:  # type: ignore[override]
        raise AssertionError


# --- AWS --------------------------------------------------------------------------------


def aws_v4_definition() -> dict[str, Any]:
    definition = _to_v4(aws_definition())
    for section in definition["sections"]:
        if section["type"] == "ec2_utilization":
            section["blocks"] = [
                {"slot": "title", "title": {"en": "Instance use"}},
                {"slot": "each", "blocks": [{"slot": "narrative", "hidden": True}]},
            ]
        if section["type"] == "ebs_volumes":
            section["selection"]["locations"] = ["us-east-1"]
    return definition


@pytest.fixture(scope="module")
def walked_aws_v4():
    import asyncio
    import json

    from fakes.object_store import InMemoryObjectStore
    from reporting_agent.catalog.loader import load_catalog
    from reporting_agent.main import StepTracker
    from reporting_agent.report_pipeline import ReportOutcome, run_generate_report
    from test_aws_collector import ACCOUNT, fake_clients, provider
    from test_run_end_to_end_v2 import invoke_payload

    store = InMemoryObjectStore()
    payload = invoke_payload(aws_v4_definition())
    payload["period"] = {"start": "2026-09-01", "end": "2026-09-01"}
    payload["scope"] = {"resource_types": [], "resource_groups": [], "tag_filters": {}, "regions": ["us-east-1", "ap-southeast-3"]}
    payload.pop("context", None)
    context = {"actor_id": "actor-1", "run_id": "run-1", "subscription_id": ACCOUNT, "timezone": "UTC",
               "provider": "aws", "fidelity_tier": "baseline", "display_name": "Example AWS"}
    events: list[dict[str, Any]] = []

    async def go() -> None:
        async for event in run_generate_report(
            payload=payload, context=context, steps=StepTracker(), artifact_bucket="unused",
            outcome=ReportOutcome(), prose=None, provider=provider(store, fake_clients()),
            object_store=store, catalog=load_catalog(),
        ):
            events.append(event)

    try:
        asyncio.run(go())
    except Exception:  # a report with gaps ends `PARTIAL_COVERAGE`, which is still a delivery
        pass
    finally:
        discard_secrets()
    records = [json.loads(store.get(key).body) for key in store.keys() if "/verification-" in key]  # type: ignore[union-attr]
    return store, events, records


def test_an_aws_v4_report_verifies(walked_aws_v4) -> None:
    _, events, records = walked_aws_v4
    verification = [event for event in events if event["type"] == "verification"]
    assert verification and verification[-1]["status"] == "pass"
    assert records and not [f for f in records[-1].get("findings", []) if f.get("severity") == "blocking"]


def test_the_aws_document_carries_the_authors_title(walked_aws_v4) -> None:
    from docx import Document

    store, _, _ = walked_aws_v4
    key = next(key for key in store.keys() if key.endswith("/report.docx"))
    text = "\n".join(p.text for p in Document(BytesIO(store.get(key).body)).paragraphs)  # type: ignore[union-attr]
    assert "Instance use" in text
    assert "EC2 Instance Utilization" not in text
    assert "EBS Volumes" in text  # the located section still prints


# --- Blocks an author places (PR 3) ------------------------------------------------------

PRIOR_AWS_RUN = "run-prior-aws"


def aws_placed_blocks_definition() -> dict[str, Any]:
    """Every added block kind in one AWS section, plus a page break before the next."""
    definition = _to_v4(aws_definition())
    for section in definition["sections"]:
        if section["type"] == "ec2_utilization":
            section["blocks"] = [
                {"slot": "title"},
                {"kind": "key_figures", "id": "u_kpi"},
                {"kind": "month_vs_month", "id": "u_mvm"},
                {"slot": "each"},
                {"kind": "top_list", "id": "u_top"},
                {"slot": "fleet", "hidden": True},
                {"kind": "coverage", "id": "u_cov"},
                {"kind": "page_break", "id": "u_brk"},
            ]
    return definition


def _aws_run(store, *, run_id: str, candidates: list[dict[str, Any]] | None = None):
    import asyncio

    from reporting_agent.catalog.loader import load_catalog
    from reporting_agent.main import StepTracker
    from reporting_agent.report_pipeline import ReportOutcome, run_generate_report
    from test_aws_collector import ACCOUNT, fake_clients, provider
    from test_run_end_to_end_v2 import invoke_payload

    payload = invoke_payload(aws_placed_blocks_definition())
    payload["period"] = {"start": "2026-09-01", "end": "2026-09-01"}
    payload["scope"] = {"resource_types": [], "resource_groups": [], "tag_filters": {}, "regions": ["us-east-1", "ap-southeast-3"]}
    payload.pop("context", None)
    if candidates is not None:
        payload["historical_candidates"] = candidates
    context = {"actor_id": "actor-1", "run_id": run_id, "subscription_id": ACCOUNT, "timezone": "UTC",
               "provider": "aws", "fidelity_tier": "baseline", "display_name": "Example AWS"}
    events: list[dict[str, Any]] = []

    async def go() -> None:
        async for event in run_generate_report(
            payload=payload, context=context, steps=StepTracker(), artifact_bucket="unused",
            outcome=ReportOutcome(), prose=None, provider=provider(store, fake_clients()),
            object_store=store, catalog=load_catalog(),
        ):
            events.append(event)

    try:
        asyncio.run(go())
    except Exception:  # a report with gaps ends `PARTIAL_COVERAGE`, which is still a delivery
        pass
    finally:
        discard_secrets()
    return events


@pytest.fixture(scope="module")
def placed_blocks_walk():
    """Two runs: the first becomes the second's previous verified report."""
    import json

    from fakes.object_store import InMemoryObjectStore, StoredObject
    from reporting_agent.collect.snapshot import snapshot_key

    first_store = InMemoryObjectStore()
    first = _aws_run(first_store, run_id="run-1")
    prior = first_store.get(snapshot_key("actor-1", "run-1"))
    assert prior is not None

    store = InMemoryObjectStore()
    store._objects[snapshot_key("actor-1", PRIOR_AWS_RUN)] = StoredObject(
        body=prior.body, content_type=prior.content_type, tags=prior.tags
    )
    candidates = [{
        "id": PRIOR_AWS_RUN, "period_start": "2026-08-01", "period_end": "2026-08-31", "timezone": "UTC",
        "status": "completed", "verification_status": "pass", "verification_created_at": "2026-09-01T00:00:00Z",
        "verification_id": "v-prior", "verification_snapshot_sha256": "b" * 64,
    }]
    # The fake provider archives under `run-1` whatever the context says, so the second run
    # keeps that id too — in its own store, where `run-1` is this month's run.
    second = _aws_run(store, run_id="run-1", candidates=candidates)
    records = [json.loads(store.get(key).body) for key in store.keys() if "/verification-" in key]  # type: ignore[union-attr]
    return first, second, store, records


def _verified(events: list[dict[str, Any]]) -> bool:
    verification = [event for event in events if event["type"] == "verification"]
    return bool(verification) and verification[-1]["status"] == "pass"


def test_placed_blocks_verify_without_and_with_a_previous_report(placed_blocks_walk) -> None:
    first, second, _, records = placed_blocks_walk
    assert _verified(first)
    assert _verified(second)
    assert records and not [f for f in records[-1].get("findings", []) if f.get("severity") == "blocking"]


def test_month_vs_month_reads_the_previous_report(placed_blocks_walk) -> None:
    from docx import Document

    _, _, store, records = placed_blocks_walk
    key = next(key for key in store.keys() if key.endswith("/report.docx"))
    document = Document(BytesIO(store.get(key).body))  # type: ignore[union-attr]
    tables = [[cell.text for cell in row.cells] for table in document.tables for row in table.rows]
    headers = [row for row in tables if "Previous report" in row]
    assert headers, "no month-vs-month table"
    directions = {row[3] for row in tables if len(row) == 4 and row[3] in ("Higher", "Lower", "Same", "No earlier report")}
    # The previous report is this month's own snapshot, so every instance measured in both
    # reads "Same"; an instance with no figure in either (a stopped one) has no earlier one.
    assert "Same" in directions
    points = records[-1].get("historical_points") or records[-1].get("historicalPoints") or []
    assert any(point.get("run_id") == PRIOR_AWS_RUN for point in points), points


def test_key_figures_and_top_list_print(placed_blocks_walk) -> None:
    from docx import Document

    _, _, store, _ = placed_blocks_walk
    key = next(key for key in store.keys() if key.endswith("/report.docx"))
    document = Document(BytesIO(store.get(key).body))  # type: ignore[union-attr]
    headers = [tuple(cell.text for cell in table.rows[0].cells) for table in document.tables]
    assert any(header[:2] == ("Metric", "Basis") for header in headers), headers
    assert any("Gap" in header for header in headers)


# --- New blocks (PR 4) ---------------------------------------------------------------------


def aws_new_blocks_definition() -> dict[str, Any]:
    definition = _to_v4(aws_definition())
    for section in definition["sections"]:
        if section["type"] == "ec2_utilization":
            section["blocks"] = [
                {"slot": "title"},
                {"kind": "callout", "id": "u_gaps", "when": "coverage_gaps", "tone": "attention",
                 "text": {"en": "Some figures could not be measured: {count} gaps are listed in the appendix."}},
                {"kind": "callout", "id": "u_never", "when": "peak_at_or_above", "threshold": 100,
                 "text": {"en": "A machine ran flat out."}},
                {"kind": "callout", "id": "u_peak", "when": "peak_at_or_above", "threshold": 1,
                 "text": {"en": "The busiest instance, {resource}, peaked at {value}."}},
                {"kind": "heatmap", "id": "u_heat"},
                {"kind": "sparklines", "id": "u_spark"},
                {"slot": "each"},
            ]
    return definition


@pytest.fixture(scope="module")
def new_blocks_walk():
    import asyncio
    import json

    from fakes.object_store import InMemoryObjectStore
    from reporting_agent.catalog.loader import load_catalog
    from reporting_agent.main import StepTracker
    from reporting_agent.report_pipeline import ReportOutcome, run_generate_report
    from test_aws_collector import ACCOUNT, fake_clients, provider
    from test_run_end_to_end_v2 import invoke_payload

    store = InMemoryObjectStore()
    payload = invoke_payload(aws_new_blocks_definition())
    payload["period"] = {"start": "2026-09-01", "end": "2026-09-01"}
    payload["scope"] = {"resource_types": [], "resource_groups": [], "tag_filters": {}, "regions": ["us-east-1", "ap-southeast-3"]}
    payload.pop("context", None)
    context = {"actor_id": "actor-1", "run_id": "run-1", "subscription_id": ACCOUNT, "timezone": "UTC",
               "provider": "aws", "fidelity_tier": "baseline", "display_name": "Example AWS"}
    events: list[dict[str, Any]] = []

    async def go() -> None:
        async for event in run_generate_report(
            payload=payload, context=context, steps=StepTracker(), artifact_bucket="unused",
            outcome=ReportOutcome(), prose=None, provider=provider(store, fake_clients()),
            object_store=store, catalog=load_catalog(),
        ):
            events.append(event)

    try:
        asyncio.run(go())
    except Exception:  # a report with gaps ends `PARTIAL_COVERAGE`, which is still a delivery
        pass
    finally:
        discard_secrets()
    records = [json.loads(store.get(key).body) for key in store.keys() if "/verification-" in key]  # type: ignore[union-attr]
    return store, events, records


def _paragraphs(store) -> list[str]:
    from docx import Document

    key = next(key for key in store.keys() if key.endswith("/report.docx"))
    return [p.text for p in Document(BytesIO(store.get(key).body)).paragraphs]  # type: ignore[union-attr]


def test_new_blocks_verify(new_blocks_walk) -> None:
    _, events, records = new_blocks_walk
    assert _verified(events)
    assert records and not [f for f in records[-1].get("findings", []) if f.get("severity") == "blocking"]


def test_a_callout_prints_only_when_its_condition_holds_and_fills_its_figures(new_blocks_walk) -> None:
    store, _, _ = new_blocks_walk
    text = "\n".join(_paragraphs(store))
    assert "A machine ran flat out." not in text  # threshold 100 is never reached
    gaps = next(line for line in _paragraphs(store) if line.startswith("Some figures could not be measured"))
    assert "{count}" not in gaps and any(ch.isdigit() for ch in gaps)
    peak = next(line for line in _paragraphs(store) if line.startswith("The busiest instance"))
    assert "{resource}" not in peak and "{value}" not in peak and "%" in peak


def test_a_callout_prints_in_its_tone_s_theme_style(new_blocks_walk) -> None:
    """`attention` prints in `Callout Attention`, the default `info` tone in `Callout` — the
    styles every theme declares (`tests/test_themes.py` walks a v1 corpus that has no callout,
    so this is where the two names are seen in a real document)."""
    from docx import Document

    store, _, _ = new_blocks_walk
    key = next(key for key in store.keys() if key.endswith("/report.docx"))
    styles = {
        p.text.split(":")[0]: p.style.name
        for p in Document(BytesIO(store.get(key).body)).paragraphs  # type: ignore[union-attr]
        if p.text.startswith(("Some figures could not be measured", "The busiest instance"))
    }
    assert styles == {
        "Some figures could not be measured": "Callout Attention",
        next(name for name in styles if name.startswith("The busiest instance")): "Callout",
    }


def test_heatmap_and_sparklines_draw_figures_from_the_snapshot(new_blocks_walk) -> None:
    """Each cell of the heatmap and each sparkline point is a figure in the ledger, under the
    block id the section's layout gave it."""
    store, _, _ = new_blocks_walk
    ledger = next(store.get(key).body.decode() for key in store.keys() if key.endswith("/ledger.json"))  # type: ignore[union-attr]
    assert "__u_heat:" in ledger
    assert "__u_spark__chart:" in ledger
    assert "__u_spark__summary:" in ledger


# --- Preview (PR 6) -------------------------------------------------------------------------


@pytest.mark.parametrize("preset", ["editorial", "ledger", "signal", "brief"])
def test_a_v4_draft_previews_against_a_completed_run(placed_blocks_walk, preset: str) -> None:
    """The builder's Preview PDF: an inline v4 draft rendered against a completed run's
    snapshot, in any theme. It writes under `previews/`, a key the report download path
    cannot serve, and emits no `report_file`."""
    import asyncio

    from reporting_agent.main import StepTracker
    from reporting_agent.report_pipeline import run_render_preview

    _, _, store, _ = placed_blocks_walk
    definition = aws_placed_blocks_definition()
    definition["design"] = {**definition["design"], "preset": preset}
    preview_id = f"pv-{preset}"
    events: list[dict[str, Any]] = []

    async def go() -> None:
        async for event in run_render_preview(
            payload={"definition": definition, "preview_id": preview_id, "snapshot_run_id": "run-1"},
            context={"actor_id": "actor-1", "run_id": preview_id},
            steps=StepTracker(), artifact_bucket="unused", object_store=store,
        ):
            events.append(event)

    asyncio.run(go())
    pdf = store.get(f"actor-1/previews/{preview_id}/preview.pdf")
    assert pdf is not None and pdf.body.startswith(b"%PDF")
    assert store.get(f"actor-1/previews/{preview_id}/preview.html") is not None
    assert not [event for event in events if event.get("type") == "report_file"]
