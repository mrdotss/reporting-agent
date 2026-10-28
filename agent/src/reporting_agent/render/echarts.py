"""Production charts: one ECharts SVG, rasterized for Word without redrawing data."""

from __future__ import annotations

import base64
import json
import logging
import re
import shutil
import subprocess
import time
from datetime import date, timedelta
from decimal import ROUND_CEILING, Decimal
from pathlib import Path

from reporting_agent.compile.format import bytes_to_gib
from reporting_agent.errors import RenderFailedError
from reporting_agent.render import charts as legacy
from reporting_agent.render import chartstyle

logger = logging.getLogger(__name__)

CHART_RENDER_TIMEOUT_S = 120
"""How long one chart's renderer process may take, launch included.

A chart renders in under a second once Node, ECharts and the rasterizer's font scan are warm.
The first launch on a freshly started runtime machine is another matter: on 2026-10-21 a
report failed `RENDER_FAILED` because its first chart passed the old 30-second limit, and the
same chart rendered in 0.4 s locally and fine on the next preview. A hung renderer now costs
two minutes before the report fails, rather than a slow start costing the report."""

SLOW_CHART_S = 10
"""A render slower than this is logged, so the cold-start cost stays visible."""

LINE_WIDTHS = {"thin": 1.4, "regular": 2.3, "bold": 3.2}
HEIGHT_SCALES = {"short": 0.75, "normal": 1.0, "tall": 1.3}
LEGEND_SPACE = 24
"""The band a legend above or below the plot takes, added to the chart's height so the
panels keep their size."""

_SHADE_STEPS = (0.0, 0.32, 0.5, 0.64, 0.75, 0.83)
THRESHOLD_INK = "#C2410C"
"""The orange a threshold is drawn in on every chart that draws one."""


def _mono(furniture):
    """The theme's figure face, which resource names are set in where a chart prints them."""
    face = getattr(furniture, "figure_face", "") or "monospace"
    return chartstyle.chart_font_face("monospace", body_face=face) if face == "monospace" else face
_GREYS = ("#6F747C", "#9599A0", "#B5B8BD", "#CFD1D4", "#E0E1E3")


def _mix_with_white(hex_colour, amount):
    channels = [int(hex_colour[i : i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(c + (255 - c) * amount):02x}" for c in channels)


def palette_colour(palette, index, accent):
    """The colour of the `index`th series under a design's chart palette, or `None` for the
    standard assignment. `shades` steps the accent toward white; `greys` keeps the accent for
    the first series and sets the rest in greys, so one line leads."""
    if palette == "shades":
        return _mix_with_white(accent, _SHADE_STEPS[min(index, len(_SHADE_STEPS) - 1)])
    if palette == "greys":
        return accent if index == 0 else _GREYS[min(index - 1, len(_GREYS) - 1)]
    return None


def chart_options(node, style):
    """This chart's look: the node's own setting where it has one, else the design's.

    Every value is `None` at the default, and a default adds nothing to the spec — so a
    design with no style draws exactly the chart it always drew.
    """
    def pick(own, designed):
        return own or designed or None

    threshold = node.threshold or (str(style.chart_threshold) if style and style.chart_threshold else "")
    return {
        "line": pick("", getattr(style, "chart_line", None)),
        "grid": pick("", getattr(style, "chart_grid", None)),
        "values": pick(node.values, getattr(style, "chart_values", None)),
        "legend": pick("", getattr(style, "chart_legend", None)),
        "palette": pick("", getattr(style, "chart_palette", None)),
        "height": pick(node.height, None),
        "threshold": int(threshold) if threshold else None,
    }


def chart_spec(node, *, preset, chart_style, chart_font, accent_color, theme, messages, style=None):
    selected = legacy.plotted_series(node, messages=messages)
    options = chart_options(node, style)
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
    if categories and all(re.fullmatch(r"\d{4}-\d{2}", c) for c in categories):
        month_indexes = [int(c[:4]) * 12 + int(c[5:]) - 1 for c in categories]
        categories = [f"{index // 12:04d}-{index % 12 + 1:02d}" for index in range(min(month_indexes), max(month_indexes) + 1)]
    if node.chart_type == "week":
        # Every hour of the day, so a quiet hour no weekday reported in keeps its column.
        categories = [f"{hour:02d}:00" for hour in range(24)]
    if node.chart_type == "tiles":
        return _tiles_spec(node, selected, face=face, accent=accent, furniture=furniture, messages=messages)
    if node.chart_type in ("heatmap", "week"):
        return _heatmap_spec(node, selected, categories, face=face, accent=accent, furniture=furniture, messages=messages)
    if node.chart_type in ("bar_list", "bullet", "mix"):
        return _row_chart_spec(
            node, selected, categories, options=options, face=face, accent=accent, furniture=furniture, messages=messages
        )
    if node.chart_type == "multiples":
        return _multiples_spec(
            node, selected, categories, face=face, accent=accent, furniture=furniture,
            threshold=options["threshold"] if options["threshold"] is not None else int(_default_threshold()),
        )
    if node.chart_type == "annotated":
        # A line chart whatever the document's look, with a threshold it always draws.
        if chart_style not in ("stacked", "soft_area", "flat_area"):
            chart_style = "stacked"
        if options["threshold"] is None:
            from reporting_agent.compile.blocks.charts import ANNOTATED_DEFAULT_THRESHOLD

            options["threshold"] = int(ANNOTATED_DEFAULT_THRESHOLD)
    groups = legacy._panel_groups_for(node, selected)
    if chart_style == "sparkline":
        groups = tuple((s.key,) for s in selected) or ((),)
    elif chart_style == "range_band":
        by_unit = {}
        for s in selected:
            unit = s.points[0].y.unit if s.points else node.unit
            by_unit.setdefault(unit, []).append(s.key)
        groups = tuple(tuple(g) for g in by_unit.values()) or ((),)
    elif chart_style == "small_multiples":
        # One panel per resource, every panel on the same scale its unit gives it.
        by_resource = {}
        for s in selected:
            resource = (s.points[0].y.resource_id or s.key) if s.points else s.key
            by_resource.setdefault(resource, []).append(s.key)
        groups = tuple(tuple(g) for g in by_resource.values()) or ((),)
    if node.chart_type in ("dumbbell", "annotated"):
        # Average and peak share one scale, whatever the document's chart style: the
        # renderer draws the dumbbell on the first panel alone. An annotated line keeps its
        # few lines on one panel so a marked day reads across all of them.
        groups = (tuple(s.key for s in selected),)
    facets = {(p.y.resource_id, p.y.metric) for s in selected for p in s.points}
    single_metric = len(facets) == 1
    panels = []
    series = []
    for group in groups:
        members = [s for s in selected if s.key in group]
        values = [Decimal(str(p.y.value)) for s in members for p in s.points]
        unit = next((p.y.unit for s in members for p in s.points), node.unit)
        # Raw figure values and hashes stay in bytes; only drawing coordinates scale.
        gib = unit == "bytes" and all(" GiB" in p.y.formatted for s in members for p in s.points)
        values = [bytes_to_gib(value) if gib else value for value in values]
        if gib:
            unit = "GiB"
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
            shaded = palette_colour(options["palette"], [e.key for e in selected].index(s.key), accent)
            color = (
                accent
                if node.encoding == "sequential" or single_metric
                else shaded or legacy._colour_for(s, tuple(entry.key for entry in selected), node, theme)
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
                    "values": [(str(bytes_to_gib(Decimal(str(points[c].value)))) if gib else str(points[c].value)) if c in points else None for c in categories],
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
    look = {}
    if options["line"] and options["line"] != "regular":
        look["lineWidth"] = LINE_WIDTHS[options["line"]]
    if options["grid"] and options["grid"] != "light":
        look["gridLines"] = options["grid"]
    if options["values"] and options["values"] != "last":
        look["values"] = options["values"]
    if options["legend"] and options["legend"] != "line_ends":
        look["legend"] = options["legend"]
    if options["threshold"] is not None:
        look["threshold"] = options["threshold"]
        look["thresholdLabel"] = (
            messages.text("doc.chart.threshold_at", threshold=options["threshold"])
            if node.chart_type == "annotated"
            else messages.text("doc.chart.threshold")
        )
    if node.chart_type == "annotated":
        # A line is named by its resource at its end; the title already names the metric.
        # The busiest line leads in the accent, the others step paler behind it.
        for index, entry in enumerate(series):
            entry["label"] = entry["label"].split(" \u2014 ", 1)[0]
            entry["color"] = _mix_with_white(accent, (0.0, 0.45, 0.7)[min(index, 2)])
        if panels:
            panels[0]["label"] = node.title
    if node.chart_type == "dumbbell" and len(series) == 2:
        # Average and peak of one metric per resource: the average muted, the peak in the
        # accent, joined row by row by the renderer.
        series[0]["color"] = _mix_with_white(accent, 0.55)
        series[1]["color"] = accent
    scale = HEIGHT_SCALES.get(options["height"] or "normal", 1.0)
    height = min(850, max(120, (110 if chart_style == "sparkline" else 205) * len(panels)))
    if node.chart_type == "dumbbell":
        height = min(850, max(140, 64 + 26 * len(categories)))
    if scale != 1.0:
        height = min(1100, max(100, round(height * scale)))
    if "legend" in look:
        height += LEGEND_SPACE
    if node.markers:
        look["markers"] = [{"x": marker.x, "label": marker.label} for marker in node.markers]
    return {
        **look,
        "style": chart_style,
        "type": node.chart_type,
        "width": 720,
        "height": height,
        "font": face,
        "mono": _mono(furniture),
        "accent": accent,
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


def _heatmap_spec(node, selected, categories, *, face, accent, furniture, messages):
    """One row per resource, one cell per day, one colour scale from the lowest value to the
    highest — drawn from the same figures a line chart would plot."""
    rows = []
    values = []
    gib = all(" GiB" in p.y.formatted for s in selected for p in s.points) and any(
        p.y.unit == "bytes" for s in selected for p in s.points
    )
    for s in selected:
        points = {p.x: p.y for p in s.points}
        row = []
        for c in categories:
            if c in points:
                value = Decimal(str(points[c].value))
                value = bytes_to_gib(value) if gib else value
                values.append(value)
                row.append(str(value))
            else:
                row.append(None)
        rows.append({
            "key": s.key,
            # The series label is "<resource> — <metric>"; a row is named by its resource.
            "label": s.label.split(" — ", 1)[0],
            "last": s.points[-1].y.formatted if s.points else "",
            "panel": 0,
            "color": accent,
            "dashed": False,
            "values": row,
        })
    unit = "GiB" if gib else next((p.y.unit for s in selected for p in s.points), node.unit)
    week = node.chart_type == "week"
    return {
        "style": "heatmap",
        "type": "heatmap",
        "week": week,
        "legendText": messages.text("doc.chart.legend.week") if week else "",
        "width": 720,
        "height": max(140, (26 if week else 34) * len(rows) + (70 if week else 90)),
        "font": face,
        "mono": _mono(furniture),
        "accent": accent,
        "ink": furniture.value_label,
        "muted": furniture.axis_label,
        "rule": furniture.grid,
        "categories": categories,
        "panels": [{
            "label": node.title,
            "unit": unit,
            "min": float(min(values)) if values else 0.0,
            "max": float(max(values)) if values else 1.0,
        }],
        "series": rows,
        "bands": [],
        "xTitle": "",
        "yTitle": "",
        "emptyLabel": messages.text(legacy.EMPTY_CHART_TEXT_ID),
    }


_MIX_GREYS = ("#6F747C", "#B5B8BD")
MIX_STOPPED_INK = "#E8B4A0"

TILE_UP_INK = "#7A4A0C"
TILE_DOWN_INK = "#1D5C4A"
HIGHER_IS_BETTER = frozenset({
    "FreeableMemory", "Available Memory Bytes", "FreeStorageSpace", "storage_free",
    "Availability", "availability",
})
"""Metrics where a rise is good news: their change is drawn green going up, amber going
down. Every other metric reads as load, where a rise is the one to look at."""


def _tiles_spec(node, selected, *, face, accent, furniture, messages):
    """KPI tiles: per panel, its name, the figure, the change since the previous report and a
    sparkline. Every printed number is a plotted figure's own `formatted` string; the change
    is drawn without its sign, which the mark beside it carries."""
    by_key = {s.key: s for s in selected}
    notes = list(node.panel_notes)
    tiles = []
    vs_previous = ""
    for index, group in enumerate(node.panels):
        members = [by_key[key] for key in group if key in by_key]
        value = next((s for s in members if s.key.endswith("|value") and s.points), None)
        if value is None:
            continue
        figure = value.points[0].y
        tile = {
            "label": value.label,
            "value": figure.formatted,
            "resource": value.points[0].x,
            "change": None,
            "note": notes[index] if index < len(notes) else "",
            "spark": [],
        }
        change = next((s for s in members if s.key.endswith("|change") and s.points), None)
        if change is not None:
            delta = change.points[0].y
            vs_previous = change.points[0].x
            amount = Decimal(str(delta.value))
            text = delta.formatted.lstrip("+-\u2212 ")
            if delta.unit == "percent" and text.endswith("%"):
                text = f"{text[:-1].rstrip()} {messages.text('doc.tiles.points')}"
            direction = "up" if amount > 0 else "down" if amount < 0 else "flat"
            good = (direction == "up") == (figure.metric in HIGHER_IS_BETTER)
            tile["change"] = {
                "text": text if direction != "flat" else change.label,
                "direction": direction,
                "ink": furniture.axis_label if direction == "flat" else TILE_DOWN_INK if good else TILE_UP_INK,
            }
        spark = next((s for s in members if s.key.endswith("|spark")), None)
        if spark is not None and len(spark.points) > 1:
            tile["spark"] = [str(Decimal(str(point.y.value))) for point in spark.points]
        tiles.append(tile)
    return {
        "style": "tiles",
        "type": "tiles",
        "width": 720,
        "height": 172,
        "font": face,
        "ink": furniture.value_label,
        "muted": furniture.axis_label,
        "rule": furniture.grid,
        "accent": accent,
        "title": node.title,
        "subtitle": vs_previous,
        "tiles": tiles,
        "categories": [],
        "panels": [],
        "series": [],
        "bands": [],
        "xTitle": "",
        "yTitle": "",
        "emptyLabel": messages.text(legacy.EMPTY_CHART_TEXT_ID),
    }


def _multiples_spec(node, selected, categories, *, face, accent, furniture, threshold=None):
    """Small multiples: one small panel per resource, every panel on one shared scale so a
    taller shape is a busier resource. Values plot as drawn coordinates only; the one label
    each panel prints is its peak's own `formatted` string."""
    gib = all(" GiB" in p.y.formatted for s in selected for p in s.points) and any(
        p.y.unit == "bytes" for s in selected for p in s.points
    )
    unit = "GiB" if gib else next((p.y.unit for s in selected for p in s.points), node.unit)
    values = []
    series = []
    for s in selected:
        points = {p.x: p.y for p in s.points}
        row = []
        for c in categories:
            if c in points:
                value = Decimal(str(points[c].value))
                value = bytes_to_gib(value) if gib else value
                values.append(value)
                row.append(str(value))
            else:
                row.append(None)
        series.append({
            "key": s.key,
            "label": s.label,
            "last": s.points[-1].y.formatted if s.points else "",
            "panel": 0,
            "color": accent,
            "dashed": False,
            "pointLabels": [points[c].formatted if c in points else None for c in categories],
            "values": row,
        })
    upper = max([Decimal(0), *values])
    if unit == "percent" and 1 < upper <= 100:
        upper = Decimal(100)
    elif upper > 0:
        upper = upper * Decimal("1.1")
        step = Decimal(10) ** upper.adjusted()
        upper = (upper / step).to_integral_value(rounding=ROUND_CEILING) * step
    else:
        upper = Decimal(1)
    columns = MULTIPLES_COLUMNS if len(series) > 4 else max(1, min(len(series), 2))
    rows = -(-len(series) // columns) if series else 1
    return {
        "style": "multiples",
        "type": "multiples",
        "width": 720,
        "height": min(1100, 40 + 104 * rows),
        "columns": columns,
        "font": face,
        "mono": _mono(furniture),
        "accent": accent,
        **({"threshold": threshold} if threshold is not None and unit == "percent" else {}),
        "ink": furniture.value_label,
        "muted": furniture.axis_label,
        "rule": furniture.grid,
        "categories": categories,
        "panels": [{"label": node.title, "unit": unit, "min": 0.0, "max": float(upper)}],
        "series": series,
        "emptyLabel": "",
    }


MULTIPLES_COLUMNS = 4
"""How many small panels sit side by side once there are more than four."""


def _default_threshold():
    from reporting_agent.compile.blocks.charts import ANNOTATED_DEFAULT_THRESHOLD

    return ANNOTATED_DEFAULT_THRESHOLD


def _row_chart_spec(node, selected, categories, *, options, face, accent, furniture, messages):
    """A chart of one row per category: a bar list's resources, a bullet's resources, or a
    fleet mix's resource types. Values plot as drawn coordinates only; every label printed is
    a plotted figure's own `formatted` string."""
    gib = all(" GiB" in p.y.formatted for s in selected for p in s.points) and any(
        p.y.unit == "bytes" for s in selected for p in s.points
    )
    unit = "GiB" if gib else next((p.y.unit for s in selected for p in s.points), node.unit)
    values = []
    series = []
    for index, s in enumerate(selected):
        points = {p.x: p.y for p in s.points}
        row = []
        for c in categories:
            if c in points:
                value = Decimal(str(points[c].value))
                value = bytes_to_gib(value) if gib else value
                values.append(value)
                row.append(str(value))
            else:
                row.append(None)
        if node.chart_type == "bullet":
            # Average darkest, the P95 pale behind it, the peak a tick in the ink.
            color = (accent, _mix_with_white(accent, 0.72), furniture.value_label)[min(index, 2)]
        elif node.chart_type == "mix":
            # Running families step from the accent toward white; stopped machines are the
            # one warm part, the ones a reader asks about.
            color = (
                MIX_STOPPED_INK
                if s.key == "stopped"
                else _MIX_GREYS[1]
                if s.key == "other"
                else _mix_with_white(accent, (0.0, 0.32, 0.72, 0.82, 0.88)[min(index, 4)])
            )
        else:
            color = accent
        series.append({
            "key": s.key,
            "label": s.label,
            "last": s.points[-1].y.formatted if s.points else "",
            "panel": 0,
            "color": color,
            "dashed": False,
            "pointLabels": [points[c].formatted if c in points else None for c in categories],
            "values": row,
        })
    upper = max([Decimal(0), *values])
    if node.chart_type == "mix":
        upper = Decimal(1)
    elif unit == "percent" and 1 < upper <= 100:
        upper = Decimal(100)
    elif upper > 0:
        upper = upper * Decimal("1.1")
        step = Decimal(10) ** upper.adjusted()
        upper = (upper / step).to_integral_value(rounding=ROUND_CEILING) * step
    else:
        upper = Decimal(1)
    rows = len(categories)
    height = {
        "bar_list": 44 + 36 * rows,
        "bullet": 72 + 28 * rows,
        "mix": 36 + 64 * rows,
    }[node.chart_type]
    look = {}
    if node.chart_type == "bullet":
        # A bullet always draws its line, the design's or the default, and says so below.
        threshold = options["threshold"] if options["threshold"] is not None else int(_default_threshold())
        look["threshold"] = threshold
        look["thresholdLabel"] = messages.text("doc.chart.threshold")
        look["legendText"] = messages.text("doc.chart.legend.bullet", threshold=threshold)
    if node.chart_type == "mix":
        # The legend reads as a sentence: "14 general purpose".
        for entry in series:
            label = entry["label"]
            entry["label"] = label if label[1:2].isupper() else label[:1].lower() + label[1:]
    if node.chart_type == "bar_list":
        # Busiest first, darkest first, each bar a step paler.
        for entry in series:
            entry["shades"] = [
                _mix_with_white(accent, min(0.3 + 0.12 * position, 0.72)) for position in range(len(categories))
            ]
    return {
        **look,
        "style": node.chart_type,
        "type": node.chart_type,
        "width": 720,
        "height": min(1100, height),
        "font": face,
        "mono": _mono(furniture),
        "accent": accent,
        "ink": furniture.value_label,
        "muted": furniture.axis_label,
        "rule": furniture.grid,
        "categories": categories,
        "panels": [{"label": node.title, "unit": unit, "min": 0.0, "max": float(upper)}],
        "series": series,
        "bands": [],
        "xTitle": "",
        "yTitle": "",
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
    style=None,
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
        style=style,
    )
    parent = Path(__file__).resolve().parents[2]
    root = parent.parent if parent.name == "src" else parent
    node_bin = shutil.which("node")
    if not node_bin:
        raise RenderFailedError("The chart renderer requires the packaged Node.js runtime")
    started = time.monotonic()
    try:
        result = subprocess.run(
            [node_bin, str(root / "chart-renderer/render.mjs")],
            input=json.dumps(spec).encode(),
            capture_output=True,
            timeout=CHART_RENDER_TIMEOUT_S,
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
    elapsed = time.monotonic() - started
    if elapsed > SLOW_CHART_S:
        logger.warning("chart %s took %.1f s to render, launch included", node.path, elapsed)
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
