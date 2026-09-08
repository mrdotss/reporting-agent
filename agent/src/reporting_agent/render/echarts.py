"""Production charts: one ECharts SVG, rasterized for Word without redrawing data."""

from __future__ import annotations

import base64
import json
import re
import shutil
import subprocess
from datetime import date, timedelta
from decimal import ROUND_CEILING, Decimal
from pathlib import Path

from reporting_agent.errors import RenderFailedError
from reporting_agent.render import charts as legacy
from reporting_agent.render import chartstyle


def chart_spec(node, *, preset, chart_style, chart_font, accent_color, theme, messages):
    selected = legacy.plotted_series(node, messages=messages)
    furniture = legacy._furniture_for(preset, theme)
    face = chartstyle.chart_font_face(chart_font, body_face=furniture.body_face)
    accent = (
        accent_color
        if re.fullmatch(r"#[0-9a-fA-F]{6}", accent_color or "")
        else (furniture.accent or "#1f6f78")
    )
    if not accent.startswith("#"):
        accent = "#" + accent
    categories = list(dict.fromkeys(p.x for s in selected for p in s.points))
    if categories and all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", c) for c in categories):
        first, last = (
            min(map(date.fromisoformat, categories)),
            max(map(date.fromisoformat, categories)),
        )
        if (last - first).days <= 3660:
            categories = [
                (first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)
            ]
    groups = legacy._panel_groups_for(node, selected)
    if chart_style == "sparkline":
        groups = tuple((s.key,) for s in selected) or ((),)
    elif chart_style == "range_band":
        by_unit = {}
        for s in selected:
            unit = s.points[0].y.unit if s.points else node.unit
            by_unit.setdefault(unit, []).append(s.key)
        groups = tuple(tuple(g) for g in by_unit.values()) or ((),)
    facets = {(p.y.resource_id, p.y.metric) for s in selected for p in s.points}
    single_metric = len(facets) == 1
    panels = []
    series = []
    for group in groups:
        members = [s for s in selected if s.key in group]
        values = [Decimal(str(p.y.value)) for s in members for p in s.points]
        unit = next((p.y.unit for s in members for p in s.points), node.unit)
        lower = min([Decimal(0), *values])
        upper = max([Decimal(0), *values])
        upper = (
            Decimal(100)
            if unit == "percent" and upper > 1 and upper <= 100
            else (upper * Decimal("1.15") if upper else Decimal(1))
        )
        if upper != 100 and upper > 0:
            step = Decimal(10) ** upper.adjusted()
            upper = (upper / step).to_integral_value(rounding=ROUND_CEILING) * step
        lower = lower * Decimal("1.1") if lower < 0 else lower
        panels.append(
            {
                "label": ", ".join(legacy.short_series_label(s, selected) for s in members),
                "unit": unit,
                "zoomed": unit == "percent" and upper < 100,
                "min": float(lower),
                "max": float(upper),
            }
        )
        for s in members:
            points = {p.x: p.y for p in s.points}
            statistic = s.points[0].y.statistic if s.points else ""
            # Metric meaning stays consistent between per-resource charts.
            color = (
                accent
                if node.encoding == "sequential" or single_metric
                else legacy._colour_for(s, tuple(entry.key for entry in selected), node, theme)
            )
            series.append(
                {
                    "key": s.key,
                    "label": legacy.short_series_label(s, selected),
                    "last": s.points[-1].y.formatted if s.points else "",
                    "panel": len(panels) - 1,
                    "color": color,
                    "dashed": statistic == "avg",
                    "pointLabels": [
                        points[c].formatted if c in points else None for c in categories
                    ],
                    "values": [str(points[c].value) if c in points else None for c in categories],
                }
            )
    bands = []
    for low in selected:
        if not low.points or low.points[0].y.statistic != "avg":
            continue
        source = low.points[0].y
        for high in selected:
            if not high.points:
                continue
            target = high.points[0].y
            if target.statistic == "max" and (source.resource_id, source.metric, source.unit) == (
                target.resource_id,
                target.metric,
                target.unit,
            ):
                a = next(i for i, s in enumerate(series) if s["key"] == low.key)
                b = next(i for i, s in enumerate(series) if s["key"] == high.key)
                if series[a]["panel"] == series[b]["panel"]:
                    bands.append({"lower": a, "upper": b})
    return {
        "style": chart_style,
        "type": node.chart_type,
        "width": 720,
        "height": min(850, max(120, (110 if chart_style == "sparkline" else 205) * len(panels))),
        "font": face,
        "ink": furniture.value_label,
        "muted": furniture.axis_label,
        "rule": furniture.grid,
        "categories": categories,
        "panels": panels,
        "series": series,
        "bands": bands,
        "xTitle": legacy._resolve_axis_title(
            node.x_axis_label_id, node=node, axis="x", messages=messages
        ),
        "yTitle": legacy._resolve_axis_title(
            node.y_axis_label_id, node=node, axis="y", messages=messages
        ),
        "emptyLabel": messages.text(legacy.EMPTY_CHART_TEXT_ID),
    }


def render_chart(
    node,
    *,
    table_style,
    preset="",
    chart_style="stacked",
    chart_font="grotesque",
    accent_color="",
    theme="light",
    messages,
):
    if not node.unit:
        raise RenderFailedError(f"chart {node.path!r} has no axis unit")
    for axis in ("x", "y"):
        legacy._resolve_axis_title(
            getattr(node, f"{axis}_axis_label_id"), node=node, axis=axis, messages=messages
        )
    if chart_style not in chartstyle.CHART_STYLES:
        raise RenderFailedError(f"unsupported chart style {chart_style!r}")
    spec = chart_spec(
        node,
        preset=preset,
        chart_style=chart_style,
        chart_font=chart_font,
        accent_color=accent_color,
        theme=theme,
        messages=messages,
    )
    parent = Path(__file__).resolve().parents[2]
    root = parent.parent if parent.name == "src" else parent
    node_bin = shutil.which("node")
    if not node_bin:
        raise RenderFailedError("The chart renderer requires the packaged Node.js runtime")
    try:
        result = subprocess.run(
            [node_bin, str(root / "chart-renderer/render.mjs")],
            input=json.dumps(spec).encode(),
            capture_output=True,
            timeout=30,
            check=True,
        )
        output = json.loads(result.stdout)
        png = base64.b64decode(output["png"], validate=True)
        svg = output["svg"]
        if not png.startswith(b"\x89PNG\r\n\x1a\n") or not svg.startswith("<svg"):
            raise ValueError("Invalid chart artifact")
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        raise RenderFailedError(
            f"ECharts could not render chart {node.path!r}: {type(error).__name__}"
        ) from error
    data_hash = legacy.chart_data_hash(node, messages=messages)
    return legacy.ChartArtifacts(
        image_png=png,
        image_svg=svg,
        sidecar_json=legacy.sidecar_bytes(node, data_hash=data_hash, messages=messages),
        table=legacy.companion_table(node, table_style, messages=messages),
        data_hash=data_hash,
        identity=node.anchor_id,
        plotted_keys=tuple(s.key for s in legacy.plotted_series(node, messages=messages)),
    )
