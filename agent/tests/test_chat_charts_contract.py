"""The charts the runtime sends, pinned as JSON the app's parser is tested against.

`tests/fixtures/chat-charts/runtime-charts.json` holds one chart of every kind exactly as
`build_chart` emits it; `app/lib/chat/outcome.contract.test.ts` checks that the app keeps
every one of them. A runtime change to a chart's shape fails here first, so the fixture —
and with it the app's parser — has to move with it. PR #111 shipped three new kinds the app
silently dropped because each side tested against its own idea of the shape.

Regenerate after a deliberate change: `RPT_WRITE_CHART_FIXTURE=1 uv run pytest tests/test_chat_charts_contract.py`.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from reporting_agent.chat.charts import ChartRequest, build_chart, series_index_from_snapshot
from reporting_agent.chat.grounding import Fact, format_statistic, number_facts

FIXTURE = Path(__file__).parent / "fixtures" / "chat-charts" / "runtime-charts.json"

VM_A = "/r/vm-a"
VM_B = "/r/vm-b"
DB = "arn:aws:rds:ap-southeast-1:123456789012:db:da-rds-postgres"


def _bucket(day: str, metric: str, values: dict[str, str]) -> dict[str, Any]:
    return {
        "local_day": day,
        "statistics": [{"metric": metric, "statistic": statistic, "value": value} for statistic, value in values.items()],
    }


SNAPSHOT = {
    "resources": [
        {
            "resource_id": VM_A,
            "day_buckets": [
                _bucket("2026-09-01", "Percentage CPU", {"avg": "4.10", "max": "20.00"}),
                _bucket("2026-09-02", "Percentage CPU", {"avg": "6.20", "max": "27.40"}),
            ],
        },
        {
            "resource_id": VM_B,
            "day_buckets": [
                _bucket("2026-09-01", "Percentage CPU", {"avg": "8.90"}),
                _bucket("2026-09-02", "Percentage CPU", {"avg": "7.40"}),
            ],
        },
        {
            "resource_id": DB,
            "day_buckets": [
                _bucket("2026-09-01", "FreeableMemory", {"avg": "204010946.0"}),
                _bucket("2026-09-02", "FreeableMemory", {"avg": "211029208.0"}),
            ],
        },
    ]
}


def _key(resource: str, metric: str, statistic: str) -> tuple[str, str, str, str, str]:
    return ("run_1", resource.casefold(), metric, statistic, "")


FACTS = number_facts(
    [
        Fact("report", "vm-a · Percentage CPU · avg", "5.15%", {}, value="5.15", unit="percent", series_key=_key(VM_A, "Percentage CPU", "avg")),
        Fact("report", "vm-b · Percentage CPU · avg", "8.15%", {}, value="8.15", unit="percent", series_key=_key(VM_B, "Percentage CPU", "avg")),
        Fact("report", "vm-a · Percentage CPU · max", "27.40%", {}, value="27.40", unit="percent", series_key=_key(VM_A, "Percentage CPU", "max")),
        Fact("live", "vm-b · Percentage CPU · max", "12.10%", {}, value="12.10", unit="percent", series_key=_key(VM_B, "Percentage CPU", "max")),
        Fact("report", "da-rds-postgres · FreeableMemory · avg", "0.19 GiB", {}, value="207520077.0", unit="bytes", series_key=_key(DB, "FreeableMemory", "avg")),
        Fact("report", "count(/resources) · count", "68", {}, value="68", unit="count"),
    ]
)

REQUESTS = [
    ChartRequest("stats", ("f6", "f1", "f5"), ""),
    ChartRequest("compare", ("f1", "f2"), "Average CPU by machine"),
    ChartRequest("trend", ("f1", "f2"), "Daily average CPU"),
    ChartRequest("trend", ("f5",), "Daily freeable memory"),
    ChartRequest("spread", ("f1", "f3", "f2", "f4"), "CPU headroom"),
    ChartRequest("daily", ("f1",), "Daily average CPU — vm-a"),
]


def _charts() -> list[dict[str, Any]]:
    series = series_index_from_snapshot(SNAPSHOT, "run_1")
    charts = []
    for index, request in enumerate(REQUESTS, start=1):
        chart = build_chart(request, chart_id=f"c{index}", facts=FACTS, series=series, format_value=format_statistic)
        assert chart is not None, request
        charts.append(chart)
    return charts


def test_the_fixture_is_what_the_runtime_builds() -> None:
    charts = _charts()
    if os.environ.get("RPT_WRITE_CHART_FIXTURE"):
        FIXTURE.write_text(json.dumps(charts, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == charts


def test_the_fixture_covers_every_kind() -> None:
    from reporting_agent.chat.charts import CHART_KINDS

    assert {chart["kind"] for chart in json.loads(FIXTURE.read_text(encoding="utf-8"))} == set(CHART_KINDS)
