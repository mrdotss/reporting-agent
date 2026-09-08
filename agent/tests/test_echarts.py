"""Production renderer integration: styles never change compiled chart data."""

from dataclasses import replace

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.ast import Chart
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.messages import load_messages
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render import charts, docx, echarts, printpdf
from reporting_agent.render.printcss import stylesheet

M = load_messages("en")


@pytest.fixture
def compiled():
    return compile_document(
        df.definition([df.block("cpu", "timeseries_chart", {"metrics": [df.CPU_AVG, df.CPU_MAX]})]),
        view=build_snapshot_view(sf.two_vm_snapshot()),
    )


@pytest.mark.parametrize("encoding", ["sequential", "categorical"])
@pytest.mark.parametrize(
    "style", ["stacked", "soft_area", "flat_area", "range_band", "columns", "sparkline"]
)
def test_all_styles_preserve_hash_series_and_table(compiled, style, encoding):
    node = next(n for n in compiled.document.blocks if isinstance(n, Chart))
    node = replace(node, encoding=encoding)
    result = echarts.render_chart(
        node,
        table_style="Table Hairline",
        preset="editorial",
        chart_style=style,
        chart_font="monospace",
        accent_color="#76558b",
        messages=M,
    )
    assert result.data_hash == charts.chart_data_hash(node, messages=M)
    assert result.sidecar_json == charts.sidecar_bytes(node, data_hash=result.data_hash, messages=M)
    assert result.table == charts.companion_table(node, "Table Hairline", messages=M)
    expected = (
        "#76558b"
        if encoding == "sequential"
        else charts._colour_for(
            charts.plotted_series(node, messages=M)[0],
            tuple(s.key for s in charts.plotted_series(node, messages=M)),
            node,
            "light",
        )
    )
    assert expected in result.image_svg
    assert "DejaVu Sans Mono" in result.image_svg
    assert "<image" not in result.image_svg
    assert result.image_png.startswith(b"\x89PNG")
    assert result.plotted_keys == tuple(s.key for s in charts.plotted_series(node, messages=M))


def test_saved_settings_reach_word_and_pdf(compiled):
    design = DesignSettings(
        preset="editorial",
        accent_color="#76558b",
        density="relaxed",
        table_style="banded",
        chart_style="flat_area",
        chart_font="monospace",
    )
    document = replace(
        compiled.document,
        blocks=tuple(
            replace(n, encoding="sequential") if isinstance(n, Chart) else n
            for n in compiled.document.blocks
        ),
    )
    result = docx.render_document(document, ledger=compiled.ledger, design=design, messages=M)
    assert all("#76558b" in svg for svg in result.chart_vectors.values())
    page = printpdf.print_document_html(
        body_html="", front_matter_html="", design=design, title="Preview", language="en"
    )
    assert "--accent: #76558b" in page
    assert "padding: 7pt 5pt" in page
    assert "break-before: page" in page.split('.rpt-block[data-style="Heading 1"]')[1].split("}")[0]


def test_bad_renderer_is_a_failure_not_a_fallback(compiled, monkeypatch):
    from reporting_agent.errors import RenderFailedError

    monkeypatch.setattr(echarts.shutil, "which", lambda _: None)
    node = next(n for n in compiled.document.blocks if isinstance(n, Chart))
    with pytest.raises(RenderFailedError, match=r"Node\.js"):
        echarts.render_chart(node, table_style="Table Hairline", messages=M)


def test_single_resource_metric_uses_accent_for_both_statistics():
    import json
    from pathlib import Path

    fixture = json.loads((Path(__file__).parents[1] / "dev/design_preview/sample.json").read_text())
    compiled = compile_document(
        fixture["definition"], view=build_snapshot_view(fixture["snapshot"])
    )
    node = next(n for n in compiled.document.blocks if isinstance(n, Chart))
    spec = echarts.chart_spec(
        node,
        preset="editorial",
        chart_style="stacked",
        chart_font="monospace",
        accent_color="#76558b",
        theme="light",
        messages=M,
    )
    assert {s["color"] for s in spec["series"]} == {"#76558b"}
    assert {s["dashed"] for s in spec["series"]} == {False, True}
    assert any(p["zoomed"] and p["max"] < 1 for p in spec["panels"])
    result = echarts.render_chart(
        node,
        table_style="Table Hairline",
        preset="editorial",
        chart_style="stacked",
        chart_font="monospace",
        accent_color="#76558b",
        messages=M,
    )
    assert "#76558b" in result.image_svg
    assert "zoomed axis" in result.image_svg


def test_top_level_chapters_start_separate_pdf_pages():
    import io

    from pypdf import PdfReader
    from weasyprint import HTML

    body = '<main class="rpt-document"><h2 class="rpt-block" data-style="Heading 1">Chapter Alpha</h2><p>First content.</p><h2 class="rpt-block" data-style="Heading 1">Chapter Beta</h2><p>Second content.</p></main>'
    pdf = HTML(
        string="<style>" + stylesheet("editorial", table_style="bordered") + "</style>" + body
    ).write_pdf()
    pages = PdfReader(io.BytesIO(pdf)).pages
    assert len(pages) == 2
    assert "First content." in pages[0].extract_text()
    assert "Second content." in pages[1].extract_text()
    assert "Second content." not in pages[0].extract_text()
