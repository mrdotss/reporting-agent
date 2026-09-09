"""A profile's selected CPU/memory statistics survive to the compiled report."""

from dataclasses import replace

import snapshot_factory as sf
from reporting_agent.catalog.loader import load_section_catalogue
from reporting_agent.compile.ast import Chart
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.verify.derived_counts import check_derived_counts


def selected_fixture():
    resources = []
    for index in range(2):
        resource = sf.vm(
            resource_id=f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/{sf.VM_TYPE}/sample-{index}",
            name=f"sample-{index}",
            month_cpu={"2026-05": "10", "2026-06": "12", "2026-07": "14"},
        )
        memory = (
            sf.exact(sf.AVAILABLE_MEMORY, "avg", "4294967296", unit="bytes"),
            sf.exact(sf.AVAILABLE_MEMORY, "min", "2147483648", unit="bytes"),
        )
        resources.append(
            replace(
                resource,
                statistics=resource.statistics + memory,
                day_buckets=tuple(
                    replace(
                        day, statistics=(*day.statistics, sf.exact(sf.CPU, "max", "28"), *memory)
                    )
                    for day in resource.day_buckets
                ),
                month_buckets=tuple(
                    replace(
                        month,
                        statistics=(*month.statistics, sf.exact(sf.CPU, "max", str(30 + index))),
                    )
                    for month in resource.month_buckets
                ),
            )
        )
    snapshot = sf.build(resources=resources)
    common = {
        "selection": {
            "resource_types": [sf.VM_TYPE],
            "resource_groups": [],
            "tag_filters": [],
            "top_n": None,
            "sort": None,
        },
        "presentation": "chart_and_table",
    }
    cpu = [{"metric": sf.CPU, "statistic": stat} for stat in ("avg", "max")]
    definition = {
        "schema_version": 3,
        "provider": "azure",
        "identity": {"language": "en"},
        "design": {
            "preset": "technical",
            "accent_color": "#6d4c91",
            "table_style": "bordered",
            "chart_style": "stacked",
            "chart_font": "monospace",
            "page_size": "A4",
        },
        "sections": [
            {
                **common,
                "id": "utilization",
                "type": "vm_utilization",
                "position": 1,
                "metrics": cpu
                + [{"metric": sf.AVAILABLE_MEMORY, "statistic": stat} for stat in ("avg", "min")],
            },
            {
                **common,
                "id": "history",
                "type": "historical_vm_utilization",
                "position": 2,
                "metrics": cpu,
                "lookback": 3,
            },
        ],
    }
    return definition, snapshot


def test_selected_metrics_and_months_survive_compilation_and_count_verification():
    definition, snapshot = selected_fixture()
    view = build_snapshot_view(snapshot)
    catalogue = load_section_catalogue()
    result = compile_document(definition, view=view, catalogue=catalogue)
    charts = [node for node in result.document.blocks if isinstance(node, Chart)]
    daily = [node for node in charts if str(node.path).startswith("utilization")]
    history = [node for node in charts if str(node.path).startswith("history")]
    assert len(daily) == 4  # CPU and memory for each VM.
    assert len(history) == 4  # Average and maximum for each VM.
    assert {p.y.metric for node in daily for s in node.series for p in s.points} == {
        sf.CPU,
        sf.AVAILABLE_MEMORY,
    }
    assert {
        p.y.statistic
        for node in daily
        for s in node.series
        for p in s.points
        if p.y.metric == sf.AVAILABLE_MEMORY
    } == {"avg", "min"}
    for node in history:
        assert len(node.series[0].points) == 3
        assert len({p.y.resource_id for p in node.series[0].points}) == 1
    assert not check_derived_counts(
        result.ledger, definition=definition, view=view, catalogue=catalogue
    ).findings


def test_unavailable_selected_memory_still_has_a_named_notice():
    from reporting_agent.compile.ast import Table

    definition, snapshot = selected_fixture()
    for resource in snapshot["resources"]:
        for day in resource["day_buckets"]:
            day["statistics"] = [
                stat for stat in day["statistics"] if stat["metric"] != sf.AVAILABLE_MEMORY
            ]
    result = compile_document(
        definition, view=build_snapshot_view(snapshot), catalogue=load_section_catalogue()
    )
    notices = [
        node
        for node in result.document.blocks
        if isinstance(node, Table)
        and "Available Memory Bytes" in (node.caption or "")
        and "__metric_" in str(node.path)
    ]
    assert len(notices) == 2


def test_missing_internal_month_is_a_gap_in_each_selected_statistic():
    from reporting_agent.compile.messages import load_messages
    from reporting_agent.render.echarts import chart_spec

    definition, snapshot = selected_fixture()
    snapshot["resources"][0]["month_buckets"] = [
        month
        for month in snapshot["resources"][0]["month_buckets"]
        if month["local_month"] != "2026-06"
    ]
    result = compile_document(
        definition, view=build_snapshot_view(snapshot), catalogue=load_section_catalogue()
    )
    charts = [
        node
        for node in result.document.blocks
        if isinstance(node, Chart)
        and str(node.path).startswith("history")
        and node.series[0].points[0].y.resource_id.endswith("sample-0")
    ]
    assert len(charts) == 2
    for chart in charts:
        spec = chart_spec(
            chart,
            preset="technical",
            chart_style="stacked",
            chart_font="document",
            accent_color="#6d4c91",
            theme="light",
            messages=load_messages("en"),
        )
        assert spec["categories"] == ["2026-05", "2026-06", "2026-07"]
        assert spec["series"][0]["values"][1] is None
