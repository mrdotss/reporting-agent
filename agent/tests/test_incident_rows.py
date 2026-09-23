"""Incidents typed on the run form, and the blank rows left to fill in afterwards.

The run form collects this period's incidents; the app sends them as `author_rows`, keyed
by the author-filled section they print into. `compile/sections.apply_author_rows` places
them on the definition the run compiles **and** verifies, and the incident table prints
them ahead of its blank rows. Every blank cell left over is a fill-in field: a content
control in the `.docx`, a text field in its conversion, and an input in the designed PDF,
so a reader can add what happened after the report went out without a PDF editor.

What must hold, and why each is here:

* the rows print, in order, in the table's own columns;
* a date typed into an incident is **not** an unproven number — the verifier renders the
  same definition, rows included, to learn what text is the template's own;
* each blank cell is a separate field, in all three documents;
* a malformed payload is refused rather than trimmed into something that prints.
"""

from __future__ import annotations

import io
import os
import tempfile
from typing import Any, Final

import pytest
from docx import Document as open_docx
from docx.oxml.ns import qn
from pypdf import PdfReader

import messages_factory as mf
import snapshot_factory as sf
from reporting_agent.catalog.loader import load_section_catalogue
from reporting_agent.compile.ast import EmptyCell, Table, TextCell
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.sections import apply_author_rows
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.errors import CompileFailedError
from reporting_agent.render.docx import render_document
from reporting_agent.render.pdf import convert_to_pdf
from reporting_agent.render.printpdf import render_print_pdf
from reporting_agent.verify.allowlist import derive_allowlist
from reporting_agent.verify.masking import scan_paragraphs
from reporting_agent.verify.tokens import paragraph_texts

os.environ.setdefault("LO_PROFILE", tempfile.mkdtemp(prefix="rpt-lo-profile-"))

# Case, Date, Solution, Description — the catalogue's column order.
INCIDENTS: Final[list[list[str]]] = [
    ["Disk full on CPN-App", "12 Aug 2026", "Cleared /var/log, added an alert at 85%", "/var filled"],
    ["Backup job failed", "20–21 Aug", "Re-ran the job", "Snapshot quota reached"],
]
BLANK_ROWS: Final[int] = 5 - len(INCIDENTS)
"""The catalogue's incident table pads to five rows."""

DESIGN: Final[dict[str, object]] = {
    "preset": "corporate",
    "accent_color": "#008080",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": False,
    "logo": None,
    "page_size": "A4",
}


def _definition() -> dict[str, Any]:
    return {
        "schema_version": 3,
        "provider": "azure",
        "sections": [
            {
                "id": "inc",
                "type": "incident_report",
                "position": 0,
                "selection": {
                    "resource_types": [],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [],
                "presentation": "table_only",
            }
        ],
        "identity": {"language": "en", "customer_name": "FATechID", "report_title": "Report"},
        "period": {"start": "2026-08-01", "end": "2026-08-31"},
        "design": dict(DESIGN),
    }


@pytest.fixture(scope="module")
def catalogue():
    return load_section_catalogue()


@pytest.fixture(scope="module")
def effective(catalogue) -> dict[str, Any]:
    return dict(
        apply_author_rows(
            _definition(), {"incident_report": INCIDENTS}, catalogue=catalogue
        )
    )


@pytest.fixture(scope="module")
def rendered(effective, catalogue):
    snapshot = sf.two_vm_snapshot()
    compiled = compile_document(
        effective, view=build_snapshot_view(snapshot), catalogue=catalogue
    )
    outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
        messages=mf.EN,
    )
    return snapshot, compiled, outcome


def _incident_table(compiled) -> Table:
    [table] = [block for block in compiled.document.blocks if isinstance(block, Table)]
    return table


# --------------------------------------------------------------------------- #
# Placing the rows
# --------------------------------------------------------------------------- #


def test_no_rows_leaves_the_definition_as_it_was(catalogue) -> None:
    definition = _definition()
    assert apply_author_rows(definition, None, catalogue=catalogue) is definition
    assert apply_author_rows(definition, {}, catalogue=catalogue) is definition


@pytest.mark.parametrize(
    ("rows", "reason"),
    [
        ({"vm_utilization": [["a", "b", "c", "d"]]}, "not an author-filled section"),
        ({"no_such_section": [["a", "b", "c", "d"]]}, "not an author-filled section"),
        ({"incident_report": [["only", "three", "cells"]]}, "one per column"),
        ({"incident_report": [["a", "b", "c", 4]]}, "one per column"),
        ({"incident_report": [["a", "b", "c", "x" * 2001]]}, "one per column"),
        ({"incident_report": [["a", "b", "c", "d"]] * 51}, "at most"),
        ({"incident_report": "not a list"}, "at most"),
        (["incident_report"], "must be an object"),
    ],
)
def test_a_malformed_payload_is_refused(catalogue, rows: object, reason: str) -> None:
    with pytest.raises(CompileFailedError, match=reason):
        apply_author_rows(_definition(), rows, catalogue=catalogue)


def test_the_rows_print_first_and_the_rest_are_fill_in_blanks(rendered) -> None:
    _, compiled, _ = rendered
    table = _incident_table(compiled)

    typed = [
        [cell.text for cell in row.cells[1:]] for row in table.rows[: len(INCIDENTS)]
    ]
    assert typed == INCIDENTS
    blanks = [cell for row in table.rows[len(INCIDENTS) :] for cell in row.cells[1:]]
    assert len(blanks) == BLANK_ROWS * 4
    assert all(isinstance(cell, EmptyCell) and cell.fill_in for cell in blanks)
    # The ordinal column runs straight through, typed rows and blanks alike.
    assert [row.cells[0].text for row in table.rows] == ["1", "2", "3", "4", "5"]
    assert all(isinstance(row.cells[0], TextCell) for row in table.rows)


# --------------------------------------------------------------------------- #
# Verification: a typed date is not an unproven number
# --------------------------------------------------------------------------- #


def test_the_verifier_admits_what_was_typed_and_nothing_else(rendered, effective, catalogue) -> None:
    snapshot, _, outcome = rendered
    paragraphs = paragraph_texts(open_docx(io.BytesIO(outcome.docx_bytes)))
    allowlist = derive_allowlist(effective, snapshot, section_catalogue=catalogue)

    findings = scan_paragraphs(paragraphs, ledger_strings=[], allowlist=allowlist)
    assert findings == ()

    # Rendered against the pinned definition alone — rows the verifier never saw — the
    # same digits would be flagged. That is why the rows go onto the definition itself.
    without = derive_allowlist(_definition(), snapshot, section_catalogue=catalogue)
    flagged = scan_paragraphs(paragraphs, ledger_strings=[], allowlist=without)
    assert flagged


# --------------------------------------------------------------------------- #
# Fill-in fields, in all three documents
# --------------------------------------------------------------------------- #


def test_every_blank_cell_is_a_content_control_in_the_docx(rendered) -> None:
    _, _, outcome = rendered
    body = open_docx(io.BytesIO(outcome.docx_bytes)).element.body
    controls = list(body.iter(qn("w:sdt")))
    assert len(controls) == BLANK_ROWS * 4
    ids = {control.find(qn("w:sdtPr")).find(qn("w:id")).get(qn("w:val")) for control in controls}
    assert len(ids) == len(controls)
    aliases = [control.find(qn("w:sdtPr")).find(qn("w:alias")).get(qn("w:val")) for control in controls]
    assert aliases[:4] == ["Case", "Date", "Solution", "Description"]


def test_the_converted_pdf_has_one_text_field_per_blank_cell(rendered) -> None:
    _, _, outcome = rendered
    pdf = convert_to_pdf(outcome.docx_bytes).pdf_bytes
    fields = PdfReader(io.BytesIO(pdf)).get_fields() or {}
    assert len(fields) == BLANK_ROWS * 4
    assert {field.get("/FT") for field in fields.values()} == {"/Tx"}
    text = " ".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages)
    assert "Disk full on CPN-App" in text and "12 Aug 2026" in text


def test_the_designed_pdf_has_one_text_field_per_blank_cell(rendered) -> None:
    _, compiled, outcome = rendered
    printed = render_print_pdf(
        compiled.document,
        front_matter_sections=(),
        chart_vectors=outcome.chart_vectors,
        chart_tables=outcome.chart_tables,
        design=DesignSettings.from_plain(DESIGN),
        messages=mf.EN,
        title="Report",
    )
    fields = PdfReader(io.BytesIO(printed.pdf_bytes)).get_fields() or {}
    assert len(fields) == BLANK_ROWS * 4
