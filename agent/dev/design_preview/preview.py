"""Local design lab only; never imported by the production report pipeline.

Protocol: one JSON request on stdin; `prepare` emits HTML/spec/manifest JSON and
`pdf` emits PDF bytes. Sample values always pass through the production compiler.
"""
from __future__ import annotations

import copy
import json
import sys
from datetime import date, timedelta
from decimal import Decimal
from html import escape
from pathlib import Path

from reporting_agent.compile.ast import Chart, FigureCell, Table
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.definition import assert_valid_pinned_definition
from reporting_agent.compile.messages import load_messages
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render.charts import chart_data_hash, plotted_series
from reporting_agent.render.printpdf import print_pdf_bytes
from reporting_agent.render.themes import THEME_SPECS

ROOT = Path(__file__).parent
MESSAGES = load_messages("en")
CHOICES = {
    "preset": ("corporate", "editorial", "technical", "minimal"),
    "density": ("compact", "normal", "relaxed"),
    "table_style": ("hairline", "banded", "bordered"),
    "page_size": ("A4", "Letter"),
    "chart_font": ("document", "grotesque", "monospace"),
    "chart_style": ("stacked", "columns"),
}


def validate(settings):
    import re
    if not isinstance(settings, dict) or set(settings) != {*CHOICES, "accent_color"}:
        raise ValueError("Invalid appearance fields")
    for key, values in CHOICES.items():
        if settings[key] not in values:
            raise ValueError(f"Invalid {key}")
    if not isinstance(settings["accent_color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", settings["accent_color"]):
        raise ValueError("Invalid accent")


def sample(variant="default"):
    payload = json.loads((ROOT / "sample.json").read_text())
    # Stress variants are internal test inputs; the HTTP endpoint never accepts them.
    if variant not in ("default", "long-name", "missing", "empty", "overflow", "low"):
        raise ValueError("Unknown sample variant")
    snapshot = payload["snapshot"]
    if variant == "empty":
        snapshot["resources"] = []
    for resource in snapshot["resources"]:
        if variant == "long-name":
            resource["name"] = "sample-production-application-worker-southeastasia-long-resource-name"
        if variant == "missing":
            resource["day_buckets"] = [b for i, b in enumerate(resource["day_buckets"]) if i not in (8, 9, 10)]
        if variant == "low":
            for bucket in resource["day_buckets"]:
                for stat in bucket["statistics"]:
                    stat["value"] = "0.00"
    return payload


def prepare(settings, variant="default"):
    validate(settings)
    payload = sample(variant)
    definition = copy.deepcopy(payload["definition"])
    definition["design"].update({k: v for k, v in settings.items() if k in definition["design"]})
    assert_valid_pinned_definition(definition)
    compiled = compile_document(definition, view=build_snapshot_view(payload["snapshot"]))
    theme = THEME_SPECS[settings["preset"]]
    font = {"document": theme.face.body, "grotesque": "DejaVu Sans", "monospace": "DejaVu Sans Mono"}[settings["chart_font"]]
    ink = "#1f3a5f" if settings["preset"] == "corporate" else f"#{theme.palette.ink}"
    displayed = []

    def figure_html(figure, *, card=False):
        displayed.append({"path": str(figure.path), "value": str(figure.value), "formatted": figure.formatted, "snapshot_path": figure.snapshot_path})
        formatted = escape(figure.formatted)
        if card and " (" in figure.formatted:
            value, qualifier = figure.formatted.split(" (", 1)
            formatted = f'<span class="primary-value">{escape(value)}</span> <span class="qualifier">&#160;({escape(qualifier)}</span>'
        return f'<span class="figure" data-figure-path="{escape(str(figure.path))}">{formatted}</span>' 

    def table_html(block_id):
        parts = []
        for node in compiled.nodes_by_block[block_id]:
            if not isinstance(node, Table):
                continue
            head = "".join(f"<th>{escape(c.header)}</th>" for c in node.columns)
            rows = []
            for row in node.rows:
                cells = "".join(f"<td>{figure_html(c.figure) if isinstance(c, FigureCell) else escape(getattr(c, 'text', '—'))}</td>" for c in row.cells)
                rows.append(f"<tr>{cells}</tr>")
            parts.append(f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(rows)}</tbody></table>")
        return "".join(parts)

    summary_figures = {}
    resource_name = "No VM in scope"
    for node in compiled.nodes_by_block["summary"]:
        if isinstance(node, Table) and node.rows:
            resource_name = getattr(node.rows[0].cells[0], "text", resource_name)
            for cell in node.rows[0].cells:
                if isinstance(cell, FigureCell):
                    summary_figures[cell.figure.statistic] = cell.figure
    cards = "".join(f'<div class="stat"><p>{label}</p><strong>{figure_html(summary_figures[key], card=True) if key in summary_figures else "Unavailable"}</strong></div>' for key, label in (("avg", "Average CPU"), ("max", "Peak CPU"), ("p95", "Estimated P95")))
    count = next((c.figure for n in compiled.nodes_by_block["inventory"] if isinstance(n, Table) for r in n.rows for c in r.cells if isinstance(c, FigureCell)), None)
    count_html = figure_html(count) if count else "Unavailable"
    inventory = table_html("resources")
    node = next((n for n in compiled.nodes_by_block["cpu"] if isinstance(n, Chart)), None)
    dates = [(date(2026, 8, 1) + timedelta(days=i)).isoformat() for i in range(31)]
    series = []
    data_hash = ""
    if node:
        data_hash = chart_data_hash(node, messages=MESSAGES)
        selected = plotted_series(node, messages=MESSAGES)
        # Preserve compiler panel membership; this fixture compiles avg/max separately.
        groups = node.panels or (tuple(s.key for s in selected),)
        for entry in selected:
            points = {point.x: point.y for point in entry.points}
            statistic = next(iter(points.values())).statistic if points else "avg"
            panel = next(i for i, group in enumerate(groups) if entry.key in group)
            values = [points[d].value if d in points else None for d in dates]
            upper = max((Decimal(v) for v in values if v is not None), default=Decimal(0))
            # CPU peak uses the full percentage range; low averages explicitly zoom.
            maximum = 100 if statistic == "max" or upper > 1 else (1 if upper > Decimal("0.3") else 0.3)
            series.append({
                "key": entry.key, "label": "Daily average CPU" if statistic == "avg" else "Daily peak CPU",
                "unit": "CPU utilization", "panel": panel,
                "color": ("#30343b" if statistic == "avg" else "#707780") if settings["preset"] == "minimal" else ("#167583" if statistic == "avg" else "#9b5d20"),
                "values": values, "formatted": [points[d].formatted if d in points else None for d in dates],
                "min": 0, "max": maximum, "interval": 25 if maximum == 100 else (0.25 if maximum == 1 else 0.1),
            })
    series.sort(key=lambda entry: entry["panel"])
    chart = {"identity": str(node.path) if node else "empty", "data_hash": data_hash, "width": 680, "height": 380, "font": font, "ink": ink, "muted": "#606b76", "rule": "#e0e5e9", "dates": dates, "series": series}
    overview_note = "The sample fleet has a consistent deployment footprint. Review workload demand alongside availability requirements before making capacity changes."
    vm_note = "Daily averages remain low while brief peaks show intermittent activity. Review workload schedules and service requirements before considering a smaller VM."
    if variant == "overflow":
        vm_note = " ".join([vm_note] * 32)
    if variant == "empty":
        overview_note = "No resources are present in this sample scope. Missing telemetry is not treated as zero utilization."
        vm_note = "No VM telemetry is available for this scope."
    if variant == "low":
        vm_note = "This stress sample supplies rounded daily readings at zero to check axis behavior; window statistics remain separate fixture inputs."
    chart_html = "<!--DESIGN_PREVIEW_CHART-->" if node else '<p class="notice">No CPU telemetry is available.</p><!--DESIGN_PREVIEW_CHART-->'
    html = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sample infrastructure review</title><style>{stylesheet(settings, theme, ink)}</style></head><body>
<section class="page overview">
<div class="eyebrow">NORTHWIND SAMPLE / INFRASTRUCTURE REVIEW</div>
<h1>A clearer view of<br>your infrastructure.</h1>
<p class="lead">Monthly operations overview</p>
<div class="period">August 2026 · Asia/Jakarta (UTC+07:00)</div>
<div class="overview-stats"><div><strong>{count_html}</strong><p>Virtual machines in scope</p></div><div><b>Azure</b><p>Sample environment</p></div><div><b>CPU telemetry</b><p>Monthly window · daily view</p></div></div>
<h2>Environment at a glance</h2><p class="muted">A compact inventory of the resources included in this sample.</p>{inventory}
<h2>What deserves attention</h2><div class="finding"><span class="eyebrow">CAPACITY REVIEW</span><p>{overview_note}</p></div>
<h2>Collection availability</h2><div class="availability"><b>CPU and inventory</b><span>{"No resources in scope" if variant == "empty" else "Partial daily telemetry" if variant == "missing" else "Available in this sample"}</span></div><div class="availability"><b>Backup and reservations</b><span>Not collected in this fixture</span></div>
<p class="small note">Sample output for design evaluation. This document contains deterministic fixture data and is not a customer report.</p>
</section>
<section class="page vm"><div class="eyebrow">RESOURCE DETAIL / COMPUTE</div><h1>VM utilization</h1><p class="resource">{escape(resource_name)}</p><p class="muted">August 2026 · Daily CPU utilization · Sample environment</p>
<div class="stats">{cards}</div><div class="chart">{chart_html}</div>
<h2>Reading the pattern</h2><p>{vm_note}</p>
<div class="method"><b>Methodology</b><p>Average and peak panels share dates, with independently labelled scales. Gaps indicate missing observations; lines do not bridge them. P95 is an estimate from hourly averages, supplied by the sample snapshot. All summary values use the compiler’s number format.</p></div>
</section></body></html>'''
    return {"html": html, "chart": chart, "manifest": {"sample": True, "variant": variant, "settings": settings, "chart_data_hash": data_hash, "displayed_figures": displayed, "chart_points": [{"key": s["key"], "values": s["values"], "formatted": s["formatted"]} for s in series], "compiled_figure_count": compiled.figure_count}}


def stylesheet(settings, theme, ink):
    gap, padding, leading = {"compact": (12, 7, 1.3), "normal": (16, 9, 1.42), "relaxed": (19, 11, 1.5)}[settings["density"]]
    table_extra = "tbody tr:nth-child(even) {background:#f1f4f6;}" if settings["table_style"] == "banded" else "th,td {border:0.6pt solid #ccd4db;}" if settings["table_style"] == "bordered" else ""
    return f'''
@page {{size:{settings['page_size']};margin:17mm 16mm 17mm;@top-left {{content:"NORTHWIND SAMPLE";font:7.5pt "Liberation Sans";color:#68727d;}} @bottom-left {{content:"SAMPLE OUTPUT · DESIGN PREVIEW";font:7pt "Liberation Sans";color:#68727d;}} @bottom-right {{content:counter(page);font:8pt "DejaVu Sans Mono";color:#68727d;}}}}
* {{box-sizing:border-box;}} body {{margin:0;background:white;color:{ink};font:{theme.body_pt}pt "{theme.face.body}";line-height:{leading};}}
.page + .page {{break-before:page;}} .eyebrow {{font:8pt "Liberation Sans";letter-spacing:1.4pt;color:{settings['accent_color']};font-weight:bold;}}
h1 {{font-family:"{theme.face.heading}";font-size:30pt;line-height:1.1;letter-spacing:-0.7pt;margin:15pt 0 12pt;font-weight:bold;}} .vm h1 {{font-size:27pt;margin-top:12pt;}}
h2 {{font-family:"{theme.face.heading}";font-size:13pt;margin:{gap}pt 0 6pt;break-after:avoid;}} p {{margin:6pt 0;orphans:3;widows:3;}}
.lead {{font-size:14pt;margin:0;}} .period {{margin:10pt 0 20pt;font-size:9pt;color:#606b76;}} .muted,.small {{color:#606b76;font-size:9pt;}} .note {{margin-top:19pt;border-top:0.6pt solid #dbe1e6;padding-top:10pt;}}
.overview-stats {{display:table;width:100%;border-top:2pt solid {settings['accent_color']};border-bottom:0.6pt solid #dbe1e6;padding:16pt 0;margin-bottom:20pt;}} .overview-stats>div {{display:table-cell;width:33.3%;vertical-align:middle;}} .overview-stats strong {{font-size:29pt;}} .overview-stats b {{font-size:12pt;}} .overview-stats p {{font-size:8pt;color:#606b76;margin:3pt 0;}}
table {{width:100%;border-collapse:collapse;font-size:8.5pt;margin:10pt 0 16pt;table-layout:fixed;}} thead {{display:table-header-group;}} tr {{break-inside:avoid;}} th,td {{padding:{padding}pt 6pt;text-align:left;border-bottom:0.6pt solid #dbe1e6;overflow-wrap:anywhere;}} th {{font-size:7.5pt;color:#606b76;font-weight:bold;border-top:0.6pt solid #dbe1e6;}} th:first-child {{width:29%;}} {table_extra}
.figure {{white-space:nowrap;font-variant-numeric:tabular-nums;}} .finding {{border-left:2pt solid {settings['accent_color']};padding:9pt 13pt;background:#f5f7f8;break-inside:avoid;}} .finding p {{margin:5pt 0 0;}} .availability {{display:table;width:100%;padding:7pt 0;border-bottom:0.5pt solid #e5e9ec;font-size:9pt;}} .availability b,.availability span {{display:table-cell;width:50%;}} .availability span {{color:#606b76;text-align:right;}}
.resource {{font:{"10" if settings['preset']=='technical' else "11"}pt "{'DejaVu Sans Mono' if settings['preset']=='technical' else theme.face.body}";overflow-wrap:anywhere;margin-bottom:2pt;}}
.stats {{display:table;table-layout:fixed;width:100%;margin:17pt 0 13pt;border-top:2pt solid {settings['accent_color']};border-bottom:0.6pt solid #dbe1e6;}} .stat {{display:table-cell;width:33.3%;padding:12pt 0 14pt;}} .stat p {{color:#606b76;font-size:8.5pt;margin:0 0 4pt;}} .stat strong {{font-size:23pt;font-family:"{theme.face.body}";font-weight:normal;}}
.stat .figure {{white-space:normal;}} .primary-value {{white-space:nowrap;}} .qualifier {{display:block;font-size:8pt;line-height:1.3;color:#606b76;margin-top:5pt;}}
.chart {{break-inside:avoid;}} .chart svg {{display:block;width:100%;height:auto;}} .method {{border-top:0.6pt solid #dbe1e6;margin-top:{gap}pt;padding-top:9pt;font-size:8pt;color:#606b76;break-inside:avoid;}} .method p {{margin-bottom:0;}} .notice {{padding:12pt;background:#f5f7f8;}}
'''


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        if sys.argv[1] == "prepare":
            print(json.dumps(prepare(request["settings"], request.get("variant", "default"))))
        elif sys.argv[1] == "pdf":
            sys.stdout.buffer.write(print_pdf_bytes(request["html"]))
        else:
            raise ValueError("Unknown mode")
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
