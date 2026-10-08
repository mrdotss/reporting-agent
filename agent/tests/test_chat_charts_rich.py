"""The richer answer charts — trend, spread, stats — built from facts, never typed numbers."""

from __future__ import annotations

from typing import Any

from reporting_agent.chat.charts import ChartRequest, build_chart, series_index_from_snapshot
from reporting_agent.chat.grounding import Fact, format_statistic, number_facts

VM_A = "/r/vm-a"
VM_B = "/r/vm-b"


def _day(day: str, value: str, statistic: str = "avg") -> dict[str, Any]:
    return {"local_day": day, "statistics": [{"metric": "Percentage CPU", "statistic": statistic, "value": value}]}


SNAPSHOT = {
    "resources": [
        {"resource_id": VM_A, "day_buckets": [_day("2026-08-01", "4.10"), _day("2026-08-02", "6.20")]},
        {"resource_id": VM_B, "day_buckets": [_day("2026-08-01", "8.90"), _day("2026-08-02", "7.40")]},
    ]
}


def key(resource: str, statistic: str, source: str = "run_1") -> tuple[str, str, str, str, str]:
    return (source, resource.casefold(), "Percentage CPU", statistic, "")


def _facts() -> dict[str, Fact]:
    return number_facts(
        [
            Fact("report", "vm-a · Percentage CPU · avg", "5.15%", {}, value="5.15", unit="percent", series_key=key(VM_A, "avg")),
            Fact("report", "vm-b · Percentage CPU · avg", "8.15%", {}, value="8.15", unit="percent", series_key=key(VM_B, "avg")),
            Fact("report", "vm-a · Percentage CPU · p95", "9.40%", {}, value="9.40", unit="percent", series_key=key(VM_A, "p95")),
            Fact("report", "vm-a · Percentage CPU · max", "27.40%", {}, value="27.40", unit="percent", series_key=key(VM_A, "max")),
            Fact("live", "vm-b · Percentage CPU · p95", "12.10%", {}, value="12.10", unit="percent", series_key=key(VM_B, "p95")),
            Fact("report", "vm-a · Network In Total · sum", "1.2 GB", {}, value="1200000000", unit="bytes"),
            Fact("report", "vm-a · VM size", "Standard_B2als_v2", {}),
        ]
    )


def _build(kind: str, *ids: str, title: str = "") -> dict[str, Any] | None:
    return build_chart(
        ChartRequest(kind, ids, title),
        chart_id="c1",
        facts=_facts(),
        series=series_index_from_snapshot(SNAPSHOT, "run_1"),
        format_value=format_statistic,
    )


def test_a_trend_draws_each_named_series_from_the_snapshot() -> None:
    chart = _build("trend", "f1", "f2", title="Daily average CPU")
    assert chart is not None
    assert chart["kind"] == "trend"
    assert chart["unit"] == "percent"
    assert [s["label"] for s in chart["series"]] == ["vm-a", "vm-b"]
    assert [s["fact_id"] for s in chart["series"]] == ["f1", "f2"]
    assert chart["series"][0]["points"] == [
        {"day": "2026-08-01", "value": "4.10", "formatted": "4.10%"},
        {"day": "2026-08-02", "value": "6.20", "formatted": "6.20%"},
    ]
    assert {s["source"] for s in chart["series"]} == {"verified"}


def test_a_trend_refuses_what_it_cannot_draw() -> None:
    assert _build("trend", "f1", "f3") is None  # f3 has no daily series
    assert _build("trend", "f1", "f6") is None  # mixed units
    assert _build("trend", "f1", "f1") is None  # the same series twice
    assert _build("trend", "f1", "f2", "f1", "f2", "f1") is None  # more than four


def test_a_spread_groups_statistics_by_machine_and_sorts_them_by_value() -> None:
    chart = _build("spread", "f4", "f1", "f3", "f2", "f5", title="CPU headroom")
    assert chart is not None
    assert chart["kind"] == "spread"
    assert chart["title"] == "CPU headroom"
    rows = {row["label"]: row for row in chart["rows"]}
    assert set(rows) == {"vm-a", "vm-b"}
    assert [stat["statistic"] for stat in rows["vm-a"]["stats"]] == ["avg", "p95", "max"]
    assert [stat["formatted"] for stat in rows["vm-a"]["stats"]] == ["5.15%", "9.40%", "27.40%"]
    assert [stat["fact_id"] for stat in rows["vm-a"]["stats"]] == ["f1", "f3", "f4"]
    # A row with a live statistic in it is marked live.
    assert rows["vm-b"]["source"] == "live"
    assert rows["vm-a"]["source"] == "verified"
    assert chart["source"] == "mixed"


def test_a_spread_refuses_a_machine_with_one_statistic_or_a_second_metric() -> None:
    assert _build("spread", "f1", "f3", "f2") is None  # vm-b has only one statistic
    assert _build("spread", "f1", "f6") is None  # no series key on f6, another unit
    assert _build("spread", "f1") is None


def test_stats_are_tiles_with_a_sparkline_only_where_a_series_exists() -> None:
    chart = _build("stats", "f1", "f7", "f4")
    assert chart is not None
    assert chart["kind"] == "stats"
    tiles = chart["tiles"]
    assert [tile["formatted"] for tile in tiles] == ["5.15%", "Standard_B2als_v2", "27.40%"]
    assert len(tiles[0]["points"]) == 2
    assert tiles[1]["points"] == []  # a size has no series
    assert tiles[2]["points"] == []  # no daily max in the snapshot


def test_stats_take_two_to_four_figures() -> None:
    assert _build("stats", "f1") is None
    assert _build("stats", "f1", "f2", "f3", "f4", "f5") is None


def test_a_memory_trend_reads_in_gib_when_its_figure_does() -> None:
    db = "arn:aws:rds:ap-southeast-1:123456789012:db:da-rds-postgres"
    snapshot = {
        "resources": [
            {
                "resource_id": db,
                "day_buckets": [
                    {"local_day": day, "statistics": [{"metric": "FreeableMemory", "statistic": "avg", "value": value}]}
                    for day, value in (("2026-09-15", "204010946.0"), ("2026-09-16", "211029208.0"))
                ],
            }
        ]
    }
    series_key = ("run_1", db.casefold(), "FreeableMemory", "avg", "")
    facts = number_facts(
        [
            Fact("report", "da-rds-postgres · FreeableMemory · avg", "0.19 GiB", {}, value="207520077.0", unit="bytes", series_key=series_key),
            Fact("report", "da-rds-postgres · FreeableMemory · max", "211,029,208.0 bytes", {}, value="211029208.0", unit="bytes", series_key=series_key),
        ]
    )

    def build(fact_id: str) -> dict[str, Any] | None:
        return build_chart(
            ChartRequest("trend", (fact_id,), ""),
            chart_id="c1",
            facts=facts,
            series=series_index_from_snapshot(snapshot, "run_1"),
            format_value=format_statistic,
        )

    gib = build("f1")
    assert gib is not None
    assert [p["formatted"] for p in gib["series"][0]["points"]] == ["0.19 GiB", "0.20 GiB"]
    assert [p["value"] for p in gib["series"][0]["points"]] == ["204010946.0", "211029208.0"]
    raw = build("f2")
    assert raw is not None
    assert raw["series"][0]["points"][1]["formatted"] == "211,029,208.0 bytes"
