"""The v4 charts over time — small multiples and the annotated line — through the real
pipeline, on both clouds.

The same faked cloud ports `test_v4_charts.py` drives. Each walk places the blocks in a
utilization section, types incidents on the run form the way the app sends them
(`author_rows`), and asserts that the report still verifies and that each chart reached the
document: its chart type in the reading copy, its figures in the ledger, and the incident
dated inside the period as a marker on the annotated line.

An incident's case is free text and may hold digits ("INC-1042"). It prints in the incident
table, which the verifier already admits, and inside the chart's drawing, which it does not
read for numbers; the walk proves the report verifies with one.
"""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from reporting_agent.redaction import discard_secrets
from reporting_agent.render import pdf as P
from test_aws_report import aws_definition
from test_run_end_to_end_v3 import v3_definition
from test_v4_charts import _text
from test_v4_report import _to_v4, _verified

pytestmark = pytest.mark.skipif(P.SOFFICE_BINARY is None, reason="LibreOffice is not installed")

TIME_BLOCKS = [
    {"kind": "small_multiples", "id": "u_multi"},
    {"kind": "annotated_line", "id": "u_annot"},
    {"kind": "week_heatmap", "id": "u_week"},
]

MARKED_CASE = "INC-1042 disk full"
UNMARKED_CASE = "Before the period"


def _incidents(day: str) -> dict[str, list[list[str]]]:
    """Two incidents: one on the walk's only day, one a month earlier, which marks nothing."""
    return {
        "incident_report": [
            [MARKED_CASE, day, "Cleared the log volume", "/var filled"],
            [UNMARKED_CASE, "1 Jan 2026", "Nothing", "Out of the period"],
        ]
    }


def _with_time_blocks(definition: dict[str, Any], section_type: str) -> dict[str, Any]:
    definition = copy.deepcopy(definition)
    for section in definition["sections"]:
        if section["type"] == section_type:
            section["blocks"] = [{"slot": "title"}, *copy.deepcopy(TIME_BLOCKS), {"slot": "each"}]
    return definition


def _with_backup_tracker(definition: dict[str, Any], section_type: str) -> dict[str, Any]:
    for section in definition["sections"]:
        if section["type"] == section_type:
            section["blocks"] = [{"slot": "title"}, {"kind": "backup_tracker", "id": "u_track"}, {"slot": "table"}]
    return definition


def _backup_section(position: int) -> dict[str, Any]:
    return {
        "id": "sec_bak",
        "type": "backup_report",
        "position": position,
        "selection": {"resource_types": [], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
        "metrics": [],
    }


def _incident_section(position: int) -> dict[str, Any]:
    return {
        "id": "sec_inc",
        "type": "incident_report",
        "position": position,
        "selection": {"resource_types": [], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
        "metrics": [],
    }


def aws_time_definition() -> dict[str, Any]:
    # Every AWS section, the incident report among them.
    return _with_backup_tracker(_with_time_blocks(_to_v4(aws_definition()), "ec2_utilization"), "backups")


def azure_time_definition() -> dict[str, Any]:
    definition = _to_v4(v3_definition())
    definition["sections"].append(_backup_section(len(definition["sections"])))
    definition["sections"].append(_incident_section(len(definition["sections"])))
    return _with_backup_tracker(_with_time_blocks(definition, "vm_utilization"), "backup_report")


@pytest.fixture(scope="module")
def aws_walk():
    import asyncio

    from fakes.object_store import InMemoryObjectStore
    from reporting_agent.catalog.loader import load_catalog
    from reporting_agent.main import StepTracker
    from reporting_agent.report_pipeline import ReportOutcome, run_generate_report
    from test_aws_collector import ACCOUNT, fake_clients, provider
    from test_run_end_to_end_v2 import invoke_payload

    store = InMemoryObjectStore()
    payload = invoke_payload(aws_time_definition())
    payload["period"] = {"start": "2026-09-01", "end": "2026-09-01"}
    payload["scope"] = {"resource_types": [], "resource_groups": [], "tag_filters": {}, "regions": ["us-east-1", "ap-southeast-3"]}
    payload["author_rows"] = _incidents("1 Sep 2026")
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
    return events, store, records


@pytest.fixture(scope="module")
def azure_walk():
    import test_run_end_to_end_v2 as v2

    real_payload = v2.invoke_payload

    def with_incidents(defn: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = real_payload(defn)
        payload["author_rows"] = _incidents(payload["period"]["start"])
        return payload

    patcher = pytest.MonkeyPatch()
    # The walk's heartbeat starves the styled PDF's render thread; see `test_v4_charts.py`.
    patcher.setattr(v2, "WATCHDOG_S", 900.0)
    patcher.setattr(v2, "invoke_payload", with_incidents)
    try:
        walk = v2.V2Walk()
        events = walk.run(patcher, defn=azure_time_definition())
    finally:
        patcher.undo()
        discard_secrets()
    return events, walk.store


def _chart_html(page: str, chart_type: str) -> str:
    start = page.index(f'data-chart-type="{chart_type}"')
    return page[start : page.index("</figure>", start)]


def test_the_time_charts_verify_with_a_typed_incident(aws_walk) -> None:
    events, _, records = aws_walk
    assert _verified(events)
    assert records and not [f for f in records[-1].get("findings", []) if f.get("severity") == "blocking"]


def test_each_time_chart_reaches_the_reading_copy(aws_walk) -> None:
    _, store, _ = aws_walk
    page = _text(store, "/document.html")
    for chart_type in ("multiples", "annotated", "week"):
        assert f'data-chart-type="{chart_type}"' in page, chart_type
    ledger = _text(store, "/ledger.json")
    for block in ("__u_multi:", "__u_annot:", "__u_week:"):
        assert block in ledger, block


def test_the_incident_in_the_period_is_marked_and_the_other_is_not(aws_walk) -> None:
    _, store, _ = aws_walk
    chart = _chart_html(_text(store, "/document.html"), "annotated")
    assert MARKED_CASE in chart
    assert UNMARKED_CASE not in chart


def test_the_azure_time_charts_verify_and_mark_the_incident(azure_walk) -> None:
    events, store = azure_walk
    assert _verified(events)
    page = _text(store, "/document.html")
    assert 'data-chart-type="multiples"' in page
    chart = _chart_html(page, "annotated")
    assert MARKED_CASE in chart
    assert UNMARKED_CASE not in chart


def test_the_hour_by_weekday_cells_come_from_the_snapshot_week(aws_walk) -> None:
    _, store, _ = aws_walk
    snapshot = json.loads(_text(store, "/snapshot.json"))
    assert snapshot["week"]["metrics_by_resource_type"] == {"AWS::EC2::Instance": ["CPUUtilization"]}
    assert snapshot["week"]["buckets"]
    assert "/week/buckets/" in _text(store, "/ledger.json")


def test_the_azure_heatmap_by_hour_reads_the_fleet(azure_walk) -> None:
    _, store = azure_walk
    assert 'data-chart-type="week"' in _text(store, "/document.html")
    assert "/week/buckets/" in _text(store, "/ledger.json")


def test_the_aws_backup_strip_reads_the_recovery_points(aws_walk) -> None:
    """The fake AWS Backup lists points on 28 to 31 August only, so the walk's one day,
    1 September, is an empty mark, and the collected value prints beside it."""
    _, store, _ = aws_walk
    page = _text(store, "/document.html")
    start = page.index('data-look="strip"')
    strip = page[start : page.index("</table>", start)]
    assert "Each day, 2026-09-01 to 2026-09-01" in strip
    assert '<span data-status="none">○</span>' in strip
    assert "2026-08 28-30,~31" in strip
    assert "__u_track:" in _text(store, "/ledger.json")


def test_the_azure_backup_tracker_is_a_status_table(azure_walk) -> None:
    _, store = azure_walk
    assert 'data-look="strip"' not in _text(store, "/document.html")
