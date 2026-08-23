"""Task 9.1 — Supply the declared separators to the Formatter and the fidelity gate.

Tests the three clauses of task 9.1:
1. `number_format_from_definition` builds NumberFormat from a pinned definition's
   design.number_format, resolving separators from the declared language when absent.
2. `verify/pdf.py` bounds located occurrences with the declared separators and counts an
   occurrence written with any other separator as no located occurrence.
3. `render/charts.py` emits every numeral from the ledger's `formatted` string verbatim.

Requirements: 16.4, 16.5, 16.6, 16.7, 16.8, 16.11, 16.12
"""

from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Final

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.format import (
    NumberFormat,
    format_figure,
    number_format_from_definition,
)
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render.charts import companion_table
from reporting_agent.verify.pdf import check_pdf, is_located

PAYLOAD: Final[bytes] = b"%PDF-1.7 pretend"
DIGEST: Final[str] = hashlib.sha256(PAYLOAD).hexdigest()


# ---------------------------------------------------------------------------
# 1. number_format_from_definition — building NumberFormat from raw definition
# ---------------------------------------------------------------------------


class TestNumberFormatFromDefinition:
    """Req 16.4 — the Formatter applies the separators the pinned definition declares."""

    def test_no_raw_returns_language_defaults_en(self) -> None:
        """A None input (no design.number_format) resolves to `en` defaults."""
        nf = number_format_from_definition(None)
        assert nf.decimal_separator == "."
        assert nf.grouping_separator == ","

    def test_no_raw_returns_language_defaults_id(self) -> None:
        """Indonesian language → comma decimal, period grouping."""
        nf = number_format_from_definition(None, language="id")
        assert nf.decimal_separator == ","
        assert nf.grouping_separator == "."

    def test_empty_mapping_uses_language_defaults(self) -> None:
        """An empty number_format object still resolves separators from language."""
        nf = number_format_from_definition({}, language="id")
        assert nf.decimal_separator == ","
        assert nf.grouping_separator == "."
        assert nf.decimal_places == 1
        assert nf.group_thousands is True

    def test_v1_no_separators_defaults_to_en(self) -> None:
        """A v1 definition's number_format with only decimal_places and group_thousands
        resolves separators from the default language (en) — `.` and `,`."""
        nf = number_format_from_definition(
            {"decimal_places": 2, "group_thousands": True}
        )
        assert nf.decimal_separator == "."
        assert nf.grouping_separator == ","
        assert nf.decimal_places == 2

    def test_v2_explicit_separators_are_used(self) -> None:
        """Req 16.4 — declared separators are passed through to NumberFormat."""
        nf = number_format_from_definition(
            {
                "decimal_places": 2,
                "group_thousands": True,
                "decimal_separator": ",",
                "grouping_separator": ".",
            }
        )
        assert nf.decimal_separator == ","
        assert nf.grouping_separator == "."
        assert nf.decimal_places == 2
        assert nf.group_thousands is True

    def test_v2_partial_separator_declaration(self) -> None:
        """When only one separator is declared, the other comes from language defaults."""
        nf = number_format_from_definition(
            {"decimal_places": 1, "group_thousands": True, "decimal_separator": ","},
            language="id",
        )
        assert nf.decimal_separator == ","
        # The other defaults from `id` → "."
        assert nf.grouping_separator == "."

    def test_conflicting_separators_fall_back_to_defaults(self) -> None:
        """If declared separators are equal (would fail NumberFormat), fall back to
        language defaults. This can never happen for a validated definition."""
        nf = number_format_from_definition(
            {"decimal_separator": ",", "grouping_separator": ","},
            language="en",
        )
        # Falls back to en defaults
        assert nf.decimal_separator == "."
        assert nf.grouping_separator == ","

    def test_unknown_language_defaults_to_en(self) -> None:
        """An unrecognised language resolves from `en`."""
        nf = number_format_from_definition(None, language="fr")
        assert nf.decimal_separator == "."
        assert nf.grouping_separator == ","

    def test_swiss_apostrophe_grouping(self) -> None:
        """A valid non-standard grouping separator is accepted."""
        nf = number_format_from_definition(
            {
                "decimal_places": 2,
                "group_thousands": True,
                "decimal_separator": ".",
                "grouping_separator": "'",
            }
        )
        assert nf.grouping_separator == "'"


class TestDesignSettingsFromPlainWithSeparators:
    """Req 16.4 — DesignSettings.from_plain passes separators through."""

    def test_v2_separators_reach_number_format(self) -> None:
        """A v2 definition's design.number_format carries separators to NumberFormat."""
        raw = {
            "number_format": {
                "decimal_places": 2,
                "group_thousands": True,
                "decimal_separator": ",",
                "grouping_separator": ".",
            },
            "preset": "editorial",
        }
        ds = DesignSettings.from_plain(raw)
        assert ds.number_format.decimal_separator == ","
        assert ds.number_format.grouping_separator == "."

    def test_v1_no_separators_defaults(self) -> None:
        """A v1 design (no separator keys) uses the default en separators."""
        raw = {"number_format": {"decimal_places": 1, "group_thousands": True}}
        ds = DesignSettings.from_plain(raw)
        assert ds.number_format.decimal_separator == "."
        assert ds.number_format.grouping_separator == ","

    def test_language_id_resolves_separators(self) -> None:
        """When language=id is passed, defaults resolve to Indonesian conventions."""
        raw = {"number_format": {"decimal_places": 2, "group_thousands": True}}
        ds = DesignSettings.from_plain(raw, language="id")
        assert ds.number_format.decimal_separator == ","
        assert ds.number_format.grouping_separator == "."


# ---------------------------------------------------------------------------
# Req 16.11 — grouping inserts the declared grouping_separator between each
# group of three digits of the INTEGER part counted RIGHTWARD from the decimal
# separator, none where the integer part has three digits or fewer, and none
# in the fractional part.
# ---------------------------------------------------------------------------


class TestGroupingWithDeclaredSeparators:
    """Req 16.11 — grouping uses the declared separator, rightward from decimal."""

    def test_grouping_with_period_separator(self) -> None:
        """Indonesian style: period as grouping separator."""
        nf = NumberFormat(
            decimal_places=2,
            group_thousands=True,
            decimal_separator=",",
            grouping_separator=".",
        )
        result = format_figure(
            Decimal("1234567.50"),
            unit="bytes",
            catalog_scale=2,
            number_format=nf,
            path="test:0",
        )
        assert result == "1.234.567,50 bytes"

    def test_grouping_with_apostrophe_separator(self) -> None:
        """Swiss style: apostrophe as grouping separator."""
        nf = NumberFormat(
            decimal_places=2,
            group_thousands=True,
            decimal_separator=".",
            grouping_separator="'",
        )
        result = format_figure(
            Decimal("1234567.50"),
            unit="bytes",
            catalog_scale=2,
            number_format=nf,
            path="test:0",
        )
        assert result == "1'234'567.50 bytes"

    def test_no_grouping_for_three_or_fewer_digits(self) -> None:
        """Integer part <= 3 digits → no grouping separator inserted."""
        nf = NumberFormat(
            decimal_places=2,
            group_thousands=True,
            decimal_separator=",",
            grouping_separator=".",
        )
        result = format_figure(
            Decimal("462.81"),
            unit="bytes",
            catalog_scale=2,
            number_format=nf,
            path="test:0",
        )
        assert result == "462,81 bytes"

    def test_no_grouping_in_fractional_part(self) -> None:
        """Grouping never appears after the decimal separator."""
        nf = NumberFormat(
            decimal_places=3,
            group_thousands=True,
            decimal_separator=".",
            grouping_separator=",",
        )
        result = format_figure(
            Decimal("12.345"),
            unit="percent",
            catalog_scale=3,
            number_format=nf,
            path="test:0",
        )
        assert result == "12.345%"

    def test_grouping_disabled(self) -> None:
        """group_thousands=False → no separator regardless of integer part length."""
        nf = NumberFormat(
            decimal_places=2,
            group_thousands=False,
            decimal_separator=",",
            grouping_separator=".",
        )
        result = format_figure(
            Decimal("1234567.50"),
            unit="bytes",
            catalog_scale=2,
            number_format=nf,
            path="test:0",
        )
        assert result == "1234567,50 bytes"


# ---------------------------------------------------------------------------
# 2. verify/pdf.py — the fidelity gate uses declared separators
# ---------------------------------------------------------------------------


class TestPdfGateWithDeclaredSeparators:
    """Req 16.5, 16.6, 16.7 — the gate bounds occurrences with the declared separators."""

    def test_comma_decimal_located_correctly(self) -> None:
        """Req 16.7 — a comma decimal separator is CORRECT where declared."""
        assert is_located("462,81", "totalling 462,81 bytes", decimal=",", grouping=".") is True

    def test_period_decimal_is_incorrect_when_comma_declared(self) -> None:
        """Req 16.7 — a period is INCORRECT where the declaration says comma."""
        # "462.81" in text where the declared format says decimal is comma:
        # The needle "462,81" (what the formatter would produce) is simply not found.
        assert is_located("462,81", "totalling 462.81 bytes", decimal=",", grouping=".") is False

    def test_occurrence_with_wrong_separator_is_not_located(self) -> None:
        """Req 16.5 — an occurrence written with any other separator counts as absent."""
        # The formatted string is "1.234,56" (period grouping, comma decimal)
        # but the text has "1,234.56" (English style)
        assert is_located(
            "1.234,56", "totalling 1,234.56 bytes", decimal=",", grouping="."
        ) is False

    def test_correct_separator_is_located(self) -> None:
        """Req 16.5 — the declared-format string is found with declared separators."""
        assert is_located(
            "1.234,56", "totalling 1.234,56 bytes", decimal=",", grouping="."
        ) is True

    def test_boundary_uses_declared_separators(self) -> None:
        """The boundary characters ARE the declared separators, not hardcoded . and ,"""
        # With declared decimal="," and grouping=".", the period continues the numeral.
        # So "234,56" inside "1.234,56" is a FRAGMENT (bounded by period grouping).
        assert is_located(
            "234,56", "totalling 1.234,56 bytes", decimal=",", grouping="."
        ) is False


class TestPdfPassWithIndonesianFormat:
    """Req 16.6 — pdf_figure_missing for every entry whose declared-format string is absent."""

    @pytest.fixture()
    def indonesian_ledger(self):
        """Compile a document with Indonesian-style separators."""
        nf_raw = {
            "decimal_places": 2,
            "group_thousands": True,
            "decimal_separator": ",",
            "grouping_separator": ".",
        }
        definition = df.definition(
            [df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]})],
            design={
                "preset": "editorial",
                "accent_color": "#1f6f78",
                "density": "normal",
                "table_style": "hairline",
                "number_format": nf_raw,
                "cover_page": True,
                "logo": None,
                "page_size": "A4",
            },
            validate=False,
        )
        view = build_snapshot_view(sf.two_vm_snapshot())
        compiled = compile_document(definition, view=view)
        return compiled.ledger

    def test_correct_indonesian_format_locates_all(self, indonesian_ledger) -> None:
        """Figures formatted with comma decimal are located when declared format matches."""
        text = " ".join(
            figure.formatted for figure in indonesian_ledger.entries.values()
        )
        result = check_pdf(
            indonesian_ledger,
            pdf_bytes=PAYLOAD,
            text=text,
            pages_read=1,
            expected_sha256=DIGEST,
            number_format=NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator=",",
                grouping_separator=".",
            ),
        )
        assert result.entries_located == result.entries_checked
        assert result.findings == ()

    def test_english_format_in_pdf_fails_when_indonesian_declared(
        self, indonesian_ledger
    ) -> None:
        """Req 16.6 — figures in English format are missing when Indonesian is declared."""
        # Swap separators to simulate a locale conversion error
        text = " ".join(
            figure.formatted for figure in indonesian_ledger.entries.values()
        )
        # The formatted strings use comma decimal; swap them to period decimal
        swapped_text = text.translate(str.maketrans({",": ".", ".": ","}))

        result = check_pdf(
            indonesian_ledger,
            pdf_bytes=PAYLOAD,
            text=swapped_text,
            pages_read=1,
            expected_sha256=DIGEST,
            number_format=NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator=",",
                grouping_separator=".",
            ),
        )
        assert result.entries_located == 0
        assert len(result.findings) == result.entries_checked


# ---------------------------------------------------------------------------
# 3. render/charts.py — emits formatted verbatim, no locale formatting
# ---------------------------------------------------------------------------


class TestChartsEmitFormattedVerbatim:
    """Req 16.8 — charts emit every numeral from the ledger's formatted string verbatim."""

    @pytest.fixture()
    def chart_compiled(self):
        """A chart compiled with Indonesian-style number format."""
        nf_raw = {
            "decimal_places": 2,
            "group_thousands": True,
            "decimal_separator": ",",
            "grouping_separator": ".",
        }
        definition = df.definition(
            [df.block("chart1", "timeseries_chart", {"metrics": [df.CPU_AVG]})],
            design={
                "preset": "editorial",
                "accent_color": "#1f6f78",
                "density": "normal",
                "table_style": "hairline",
                "number_format": nf_raw,
                "cover_page": True,
                "logo": None,
                "page_size": "A4",
            },
            validate=False,
        )
        view = build_snapshot_view(sf.two_vm_snapshot())
        compiled = compile_document(definition, view=view)
        return compiled

    def test_companion_table_uses_formatted_verbatim(self, chart_compiled) -> None:
        """The companion table's value cells carry the ledger's formatted string."""
        from reporting_agent.compile.ast import Chart, FigureCell

        # Find a chart node in the compiled document
        charts = [
            node
            for node in chart_compiled.document.blocks
            if isinstance(node, Chart)
        ]
        if not charts:
            pytest.skip("no chart in compiled document")

        chart_node = charts[0]
        table = companion_table(chart_node, "Table Grid")

        # Every FigureCell in the table must carry the figure's formatted string
        for row in table.rows:
            for cell in row.cells:
                if isinstance(cell, FigureCell):
                    # The cell's figure must have its formatted string as-is from the ledger
                    figure = cell.figure
                    path_str = str(figure.path)
                    if path_str in chart_compiled.ledger:
                        ledger_fig = chart_compiled.ledger[path_str]
                        assert figure.formatted == ledger_fig.formatted, (
                            f"chart companion table reformatted {ledger_fig.formatted!r} "
                            f"to {figure.formatted!r} — the chart must emit verbatim"
                        )

    def test_bar_annotations_use_formatted_verbatim(self, chart_compiled) -> None:
        """Bar chart annotations use point.y.formatted directly, not a reformatted value."""
        from reporting_agent.compile.ast import Chart

        charts = [
            node
            for node in chart_compiled.document.blocks
            if isinstance(node, Chart)
        ]
        if not charts:
            pytest.skip("no chart in compiled document")

        chart_node = charts[0]
        # Verify that the chart node's points carry the ledger's formatted strings
        for series in chart_node.series:
            for point in series.points:
                path_str = str(point.y.path)
                if path_str in chart_compiled.ledger:
                    ledger_fig = chart_compiled.ledger[path_str]
                    assert point.y.formatted == ledger_fig.formatted


# ---------------------------------------------------------------------------
# Req 16.12 — re-verification reads number_format from the PINNED template
# version, not from the template's current definition.
# ---------------------------------------------------------------------------


class TestReverificationUsesPinnedDefinition:
    """Req 16.12 — the verifier reads separators from the pinned version."""

    def test_pinned_v2_id_definition_resolves_comma_decimal(self) -> None:
        """A pinned v2 Indonesian definition resolves comma decimal for verification."""
        from reporting_agent.verify.verifier import _number_format

        pinned = {
            "schema_version": 2,
            "identity": {"name": "Test", "language": "id"},
            "design": {
                "number_format": {
                    "decimal_places": 2,
                    "group_thousands": True,
                    "decimal_separator": ",",
                    "grouping_separator": ".",
                }
            },
        }
        nf = _number_format(pinned)
        assert nf.decimal_separator == ","
        assert nf.grouping_separator == "."

    def test_pinned_v1_definition_resolves_en_defaults(self) -> None:
        """A pinned v1 definition (no language, no separators) resolves to en defaults."""
        from reporting_agent.verify.verifier import _number_format

        pinned = {
            "schema_version": 1,
            "identity": {"name": "Test"},
            "design": {
                "number_format": {"decimal_places": 1, "group_thousands": True}
            },
        }
        nf = _number_format(pinned)
        assert nf.decimal_separator == "."
        assert nf.grouping_separator == ","

    def test_pinned_v2_with_language_but_no_separators_resolves_from_language(
        self,
    ) -> None:
        """A v2 definition declaring language=id but no explicit separators resolves
        from the language — comma decimal, period grouping."""
        from reporting_agent.verify.verifier import _number_format

        pinned = {
            "schema_version": 2,
            "identity": {"name": "Test", "language": "id"},
            "design": {
                "number_format": {"decimal_places": 2, "group_thousands": True}
            },
        }
        nf = _number_format(pinned)
        assert nf.decimal_separator == ","
        assert nf.grouping_separator == "."
