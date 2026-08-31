"""The styled PDF — the reading copy rendered from the HTML emitter's output.

A **third** artifact. `render/pdf.py` converts the produced `.docx` through LibreOffice and
that pair is exactly what Req 23.1 describes: one document, converted, so the Word file and
the PDF cannot disagree. This is the same compiled AST and the same figure ledger laid out
by a stylesheet instead of by Word. The two PDFs do not paginate alike and are not meant
to; what they share is every figure, which is checkable and is checked.
"""

from __future__ import annotations

import pytest

import definition_factory as df
import snapshot_factory as sf
import test_docx as TD
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.messages import load_messages
from reporting_agent.errors import RenderFailedError
from reporting_agent.render import printpdf
from reporting_agent.render.html import emit_html
from reporting_agent.render.printcss import stylesheet
from reporting_agent.render.themes import THEME_PRESETS, THEME_SPECS

_MESSAGES = load_messages("en")


def _weasyprint_available() -> bool:
    try:
        import weasyprint  # noqa: F401
    except Exception:
        return False
    return True


_HAS_WEASYPRINT = _weasyprint_available()


def _charted_document():
    refs = [df.CPU_AVG, df.CPU_MAX]
    return TD.render(
        [df.block("c", "timeseries_chart", {"metrics": refs})],
        metrics={sf.VM_TYPE: refs},
    )


class TestTheStylesheetIsGeneratedFromTheTheme:
    """A static stylesheet would be a fifth theme nobody keeps level with the four."""

    @pytest.mark.parametrize("preset", THEME_PRESETS)
    def test_every_preset_contributes_its_own_palette(self, preset: str) -> None:
        css = stylesheet(preset)
        spec = THEME_SPECS[preset]
        assert f"--accent: #{spec.palette.accent};" in css
        assert f"--rule: #{spec.palette.rule};" in css
        assert f'"{spec.face.body}"' in css

    def test_no_two_presets_produce_the_same_stylesheet(self) -> None:
        rendered = {stylesheet(preset) for preset in THEME_PRESETS}
        assert len(rendered) == len(THEME_PRESETS)

    def test_a_theme_that_does_not_band_its_rows_gets_no_band(self) -> None:
        """`minimal` earns its name by not banding — the hairline carries the separation."""
        assert "--band: transparent;" in stylesheet("minimal")
        assert "--band: transparent;" not in stylesheet("editorial")

    def test_an_unknown_preset_falls_back_rather_than_failing(self) -> None:
        """A styled PDF is a second copy of a document that already rendered. Refusing to
        style it would withhold an artifact over a presentation decision."""
        assert stylesheet("no-such-preset") == stylesheet("editorial")

    def test_an_unrecognised_page_size_does_not_reach_the_page_rule(self) -> None:
        """CSS falls back silently for a `size` it does not know, which would produce a
        correct-looking document on the wrong paper."""
        assert "size: A4;" in stylesheet("editorial", page_size="Quarto")

    def test_a_figure_is_never_broken_across_lines(self) -> None:
        """The CSS statement of what cost two production runs to establish in Word: the
        gate searches the converted text for the ledger string contiguously."""
        css = stylesheet("editorial")
        figure_rule = css.split(".rpt-figure {")[1].split("}")[0]
        assert "white-space: nowrap" in figure_rule


class TestTheRendererDefersItsImport:
    """WeasyPrint binds cairo and pango through cffi **at import**, so `import weasyprint`
    raises `OSError` on a machine without them. At module scope that fails collection of the
    whole suite — which is what happened the first time this was tried."""

    def test_the_module_imports_without_the_renderer_present(self) -> None:
        assert printpdf.render_print_pdf is not None

    @pytest.mark.skipif(_HAS_WEASYPRINT, reason="WeasyPrint is installed and working here")
    def test_an_absent_renderer_is_reported_as_an_environment_fault(self) -> None:
        with pytest.raises(RenderFailedError) as raised:
            printpdf.print_pdf_bytes("<p>x</p>")
        assert "environment fault" in str(raised.value)


class TestTheAssembledPage:
    def test_the_front_matter_precedes_the_body(self) -> None:
        page = printpdf.print_document_html(
            body_html="<div class='rpt-document'>BODY</div>",
            front_matter_html="<div class='rpt-front-matter'>FRONT</div>",
            design=DesignSettings.from_plain(TD.DEFAULT_DESIGN),
            title="Report",
            language="en",
        )
        assert page.index("FRONT") < page.index("BODY")

    def test_it_is_a_complete_document_not_a_fragment(self) -> None:
        """`emit_html` returns a fragment on purpose — the app owns the page around it. A
        PDF has no app, so the page is built here and nowhere else."""
        page = printpdf.print_document_html(
            body_html="", front_matter_html="",
            design=DesignSettings.from_plain(TD.DEFAULT_DESIGN),
            title="Enesis Monthly Report", language="id",
        )
        assert page.startswith("<!doctype html>")
        assert '<html lang="id">' in page
        assert "<title>Enesis Monthly Report</title>" in page
        assert "@page" in page


class TestTheChartReachesTheReadingCopy:
    """Both halves of a chart, or the reading copy is one nobody can check."""

    def test_the_drawing_is_inlined_when_it_is_supplied(self) -> None:
        compiled, outcome = _charted_document()
        assert outcome.chart_vectors, "the fixture must draw a chart"

        markup = emit_html(
            compiled.document, messages=_MESSAGES, chart_vectors=outcome.chart_vectors
        ).html
        assert "<svg" in markup
        # matplotlib writes an XML declaration and a DOCTYPE that are illegal mid-body.
        assert "<?xml" not in markup
        assert "<!DOCTYPE svg" not in markup

    def test_the_companion_table_is_emitted_when_it_is_supplied(self) -> None:
        """Req 22.1 — it is built by `render/charts.py` and is not in the AST, so this
        emitter cannot reach it alone. Without it the styled PDF carried the picture and
        none of the points."""
        compiled, outcome = _charted_document()
        plain = emit_html(compiled.document, messages=_MESSAGES)
        withtable = emit_html(
            compiled.document, messages=_MESSAGES, chart_tables=outcome.chart_tables
        )
        assert withtable.table_count == plain.table_count + len(outcome.chart_tables)

    def test_the_app_gets_data_and_no_drawing(self) -> None:
        """The app has Recharts, the mirrored palette and a reader who can hover a point.
        It passes neither, and must keep getting the series as data."""
        compiled, _ = _charted_document()
        markup = emit_html(compiled.document, messages=_MESSAGES).html
        assert "<svg" not in markup
        assert "rpt-series" in markup


@pytest.mark.skipif(not _HAS_WEASYPRINT, reason="WeasyPrint cannot render on this machine")
class TestTheRenderedArtifact:
    """Only where the libraries are present. The image installs them and asserts a render at
    build time, so this being skipped locally does not leave the path unproven."""

    def test_every_ledger_figure_is_locatable_in_the_styled_pdf(self, tmp_path) -> None:
        """The `pdf` gate's own criterion, applied to the artifact the gate will read."""
        from pypdf import PdfReader

        compiled, outcome = _charted_document()
        page = printpdf.print_document_html(
            body_html=emit_html(
                compiled.document, messages=_MESSAGES,
                chart_vectors=outcome.chart_vectors, chart_tables=outcome.chart_tables,
            ).html,
            front_matter_html="",
            design=DesignSettings.from_plain(TD.DEFAULT_DESIGN),
            title="Report", language="en",
        )
        produced = tmp_path / "styled.pdf"
        produced.write_bytes(printpdf.print_pdf_bytes(page))

        reader = PdfReader(str(produced))
        text = " ".join(" ".join(p.extract_text().split()) for p in reader.pages)
        missing = [
            figure.formatted
            for figure in compiled.ledger.entries.values()
            if figure.formatted not in text
        ]
        assert missing == [], missing
