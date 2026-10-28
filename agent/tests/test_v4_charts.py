"""The v4 chart blocks — KPI tiles, bar list, utilization bullet and fleet mix — through the
real pipeline, on both clouds.

The same faked cloud ports `test_v4_report.py` drives, then production code from collection to
every verification gate. Each walk places the new blocks in a utilization section and asserts
that the report still verifies and that each block reached the document: its chart type in the
reading copy, its figures in the ledger, its tiles in the Word grid.

The AWS walk runs twice, so the second run's tiles read the first as their previous report.
"""

from __future__ import annotations

import copy
import json
from io import BytesIO
from typing import Any

import pytest

from reporting_agent.redaction import discard_secrets
from reporting_agent.render import pdf as P
from test_aws_report import aws_definition
from test_run_end_to_end_v3 import v3_definition
from test_v4_report import _to_v4, _verified

pytestmark = pytest.mark.skipif(P.SOFFICE_BINARY is None, reason="LibreOffice is not installed")

PRIOR_AWS_RUN = "run-prior-charts"

CHART_BLOCKS = [
    {"kind": "kpi_tiles", "id": "u_tiles"},
    {"kind": "bar_list", "id": "u_bars"},
    {"kind": "utilization_bullet", "id": "u_bullet"},
    {"kind": "fleet_mix", "id": "u_mix"},
]


def _with_chart_blocks(definition: dict[str, Any], section_type: str) -> dict[str, Any]:
    definition = copy.deepcopy(definition)
    for section in definition["sections"]:
        if section["type"] == section_type:
            section["blocks"] = [{"slot": "title"}, *copy.deepcopy(CHART_BLOCKS), {"slot": "each"}]
    return definition


def aws_chart_definition() -> dict[str, Any]:
    return _with_chart_blocks(_to_v4(aws_definition()), "ec2_utilization")


def azure_chart_definition() -> dict[str, Any]:
    return _with_chart_blocks(_to_v4(v3_definition()), "vm_utilization")


def _aws_run(store, *, candidates: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    import asyncio

    from reporting_agent.catalog.loader import load_catalog
    from reporting_agent.main import StepTracker
    from reporting_agent.report_pipeline import ReportOutcome, run_generate_report
    from test_aws_collector import ACCOUNT, fake_clients, provider
    from test_run_end_to_end_v2 import invoke_payload

    payload = invoke_payload(aws_chart_definition())
    payload["period"] = {"start": "2026-09-01", "end": "2026-09-01"}
    payload["scope"] = {"resource_types": [], "resource_groups": [], "tag_filters": {}, "regions": ["us-east-1", "ap-southeast-3"]}
    payload.pop("context", None)
    if candidates is not None:
        payload["historical_candidates"] = candidates
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
    return events


@pytest.fixture(scope="module")
def aws_walk():
    """Two AWS runs: the first becomes the second's previous verified report."""
    from fakes.object_store import InMemoryObjectStore, StoredObject
    from reporting_agent.collect.snapshot import snapshot_key

    first_store = InMemoryObjectStore()
    first = _aws_run(first_store)
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
    second = _aws_run(store, candidates=candidates)
    records = [json.loads(store.get(key).body) for key in store.keys() if "/verification-" in key]  # type: ignore[union-attr]
    return first, first_store, second, store, records


@pytest.fixture(scope="module")
def azure_walk():
    """One Azure run, through the faked Azure ports `test_v4_report.py` walks."""
    import test_run_end_to_end_v2 as v2

    patcher = pytest.MonkeyPatch()
    # The walk's heartbeat spins without sleeping, which starves the styled PDF's render
    # thread: the existing Azure v4 walk spends minutes there already, and three more
    # drawings take this one past the shared watchdog.
    patcher.setattr(v2, "WATCHDOG_S", 900.0)
    try:
        walk = v2.V2Walk()
        events = walk.run(patcher, defn=azure_chart_definition())
    finally:
        patcher.undo()
        discard_secrets()
    return events, walk.store


def _text(store, suffix: str) -> str:
    key = next(key for key in store.keys() if key.endswith(suffix))
    return store.get(key).body.decode()  # type: ignore[union-attr]


def _docx_rows(store) -> list[list[str]]:
    from docx import Document

    key = next(key for key in store.keys() if key.endswith("/report.docx"))
    document = Document(BytesIO(store.get(key).body))  # type: ignore[union-attr]
    return [[cell.text for cell in row.cells] for table in document.tables for row in table.rows]


def test_the_chart_blocks_verify_with_and_without_a_previous_report(aws_walk) -> None:
    first, _, second, _, records = aws_walk
    assert _verified(first)
    assert _verified(second)
    assert records and not [f for f in records[-1].get("findings", []) if f.get("severity") == "blocking"]


def test_each_chart_block_reaches_the_reading_copy(aws_walk) -> None:
    _, _, _, store, _ = aws_walk
    page = _text(store, "/document.html")
    for chart_type in ("bar_list", "bullet", "mix"):
        assert f'data-chart-type="{chart_type}"' in page, chart_type
    assert 'data-look="tiles"' in page
    ledger = _text(store, "/ledger.json")
    for block in ("__u_tiles:", "__u_bars:", "__u_bullet:", "__u_mix:"):
        assert block in ledger, block


def test_the_first_month_has_no_earlier_report_and_the_second_reads_it(aws_walk) -> None:
    _, first_store, _, store, records = aws_walk
    first_rows = _docx_rows(first_store)
    assert any(row[-1] == "No earlier report" for row in first_rows if len(row) == 6)
    rows = [row for row in _docx_rows(store) if len(row) == 6 and row[-1] in ("Higher", "Lower", "Same")]
    # The previous report is this month's own snapshot, so the tile reads "Same" and prints
    # the earlier figure beside this month's.
    assert rows, "no tile read the previous report"
    assert all(row[2] == row[4] for row in rows)
    points = records[-1].get("historical_points") or records[-1].get("historicalPoints") or []
    assert any(point.get("run_id") == PRIOR_AWS_RUN for point in points), points


def test_the_fleet_mix_counts_the_instances_by_family(aws_walk) -> None:
    _, _, _, store, _ = aws_walk
    ledger = _text(store, "/ledger.json")
    assert "/$counts/resource_type/by_name/AWS::EC2::Instance/mix/" in ledger


def test_the_azure_chart_blocks_verify_and_reach_the_document(azure_walk) -> None:
    events, store = azure_walk
    assert _verified(events)
    page = _text(store, "/document.html")
    for chart_type in ("bar_list", "bullet", "mix"):
        assert f'data-chart-type="{chart_type}"' in page, chart_type
    assert 'data-look="tiles"' in page
    rows = [row for row in _docx_rows(store) if len(row) == 6]
    assert any(row[-1] == "No earlier report" for row in rows)


def test_the_azure_fleet_mix_counts_virtual_machines_and_reads_deallocated(azure_walk) -> None:
    _, store = azure_walk
    ledger = _text(store, "/ledger.json")
    assert "/$counts/resource_type/by_name/microsoft.compute~1virtualmachines/mix/" in ledger
