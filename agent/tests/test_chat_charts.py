"""Charts in chat answers (ask-chat Req 9): built from facts, never from typed numbers."""

from __future__ import annotations

from typing import Any

from reporting_agent.chat.charts import ChartRequest, build_chart, series_index_from_snapshot
from reporting_agent.chat.grounding import Fact, format_statistic, number_facts
from reporting_agent.chat.stream_filter import AnswerFilter, plain_text

VM_A = "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-a"

SNAPSHOT: dict[str, Any] = {
    "resources": [
        {
            "resource_id": VM_A,
            "name": "vm-a",
            "day_buckets": [
                {
                    "local_day": "2026-09-09",
                    "slot_count": 24,
                    "statistics": [
                        {"metric": "Percentage CPU", "statistic": "avg", "value": "0.30", "unit": "percent"}
                    ],
                },
                {
                    "local_day": "2026-09-08",
                    "slot_count": 24,
                    "statistics": [
                        {"metric": "Percentage CPU", "statistic": "avg", "value": "0.21", "unit": "percent"}
                    ],
                },
            ],
        }
    ]
}

SERIES_KEY = ("pull_1", VM_A.casefold(), "Percentage CPU", "avg", "")


def _facts() -> dict[str, Fact]:
    return number_facts(
        [
            Fact("live", "vm-a · Percentage CPU · avg", "0.21%", {}, value="0.21", unit="percent", series_key=SERIES_KEY),
            Fact("live", "vm-b · Percentage CPU · avg", "25.79%", {}, value="25.79", unit="percent"),
            Fact("live", "vm-a · Network In Total · sum", "123,456.0 bytes", {}, value="123456", unit="bytes"),
            Fact("report", "vm-a · VM size", "Standard_B2als_v2", {}),
        ]
    )


def _build(request: ChartRequest, facts: dict[str, Fact] | None = None) -> dict[str, Any] | None:
    return build_chart(
        request,
        chart_id="c1",
        facts=facts or _facts(),
        series=series_index_from_snapshot(SNAPSHOT, "pull_1"),
        format_value=format_statistic,
    )


def test_the_series_index_is_keyed_by_source_resource_and_statistic_in_day_order() -> None:
    index = series_index_from_snapshot(SNAPSHOT, "pull_1")
    assert index[SERIES_KEY] == [("2026-09-08", "0.21"), ("2026-09-09", "0.30")]


def test_a_comparison_uses_the_facts_own_values_and_strings() -> None:
    chart = _build(ChartRequest("compare", ("f1", "f2"), "Average CPU"))
    assert chart == {
        "id": "c1",
        "kind": "compare",
        "title": "Average CPU",
        "unit": "percent",
        "source": "live",
        "bars": [
            {"fact_id": "f1", "label": "vm-a", "value": "0.21", "formatted": "0.21%"},
            {"fact_id": "f2", "label": "vm-b", "value": "25.79", "formatted": "25.79%"},
        ],
    }


def test_a_daily_chart_reads_the_snapshot_buckets_formatted_like_figures() -> None:
    chart = _build(ChartRequest("daily", ("f1",), ""))
    assert chart is not None
    assert chart["kind"] == "daily"
    assert chart["title"] == "Percentage CPU · avg"
    assert chart["points"] == [
        {"day": "2026-09-08", "value": "0.21", "formatted": "0.21%"},
        {"day": "2026-09-09", "value": "0.30", "formatted": "0.30%"},
    ]


def test_a_chart_that_cannot_be_drawn_builds_nothing() -> None:
    assert _build(ChartRequest("compare", ("f1", "f3"), "")) is None  # mixed units
    assert _build(ChartRequest("compare", ("f1", "f9"), "")) is None  # unknown fact
    assert _build(ChartRequest("compare", ("f1",), "")) is None  # one bar
    assert _build(ChartRequest("compare", ("f1", "f4"), "")) is None  # no value on f4
    assert _build(ChartRequest("daily", ("f2",), "")) is None  # no daily series
    assert _build(ChartRequest("pie", ("f1", "f2"), "")) is None  # unknown kind


def _filter() -> AnswerFilter:
    facts = _facts()

    def builder(request: ChartRequest, chart_id: str) -> dict[str, Any] | None:
        return build_chart(
            request,
            chart_id=chart_id,
            facts=facts,
            series=series_index_from_snapshot(SNAPSHOT, "pull_1"),
            format_value=format_statistic,
        )

    return AnswerFilter(facts, frozenset(), chart_builder=builder)


def test_a_chart_directive_becomes_a_marker_on_its_own_paragraph() -> None:
    answer = _filter()
    text = answer.feed('Here is the trend.\n<chart kind="daily" facts="f1" title="CPU"/>\n') + answer.finish()
    assert "⟦chart:c1⟧" in text
    assert "<chart" not in text
    assert [chart["id"] for chart in answer.charts] == ["c1"]
    assert "f1" in answer.citations()


def test_an_invalid_chart_directive_is_dropped_and_leaves_no_marker() -> None:
    answer = _filter()
    text = answer.feed('Mixed.\n<chart kind="compare" facts="f1,f3"/>\n') + answer.finish()
    assert "⟦chart" not in text and "<chart" not in text
    assert answer.charts == []


def test_a_forged_chart_marker_from_the_model_is_stripped() -> None:
    answer = _filter()
    text = answer.feed("Look ⟦chart:c1⟧ here.") + answer.finish()
    assert "⟦" not in text
    assert answer.charts == []


def test_a_directive_split_across_chunks_is_built_once() -> None:
    answer = _filter()
    text = (
        answer.feed('Comparing machines now.\n<chart kind="compare" fa')
        + answer.feed('cts="f1,f2"/>\nDone.')
        + answer.finish()
    )
    assert text.count("⟦chart:c1⟧") == 1
    assert len(answer.charts) == 1


def test_chart_ids_in_markers_are_not_withheld_as_numbers() -> None:
    answer = _filter()
    text = answer.feed('<chart kind="compare" facts="f1,f2"/>\nThat is all.') + answer.finish()
    assert "⟦chart:c1⟧" in text and "—" not in text


def test_history_shows_a_chart_as_a_word_not_a_marker() -> None:
    assert plain_text("Trend:\n\n⟦chart:c1⟧\n\nFlat.") == "Trend:\n\n[chart]\n\nFlat."
