"""The table of contents links to its headings, and numbers them from where they landed.

Each contents heading in the `.docx` carries a bookmark; each contents entry is a hyperlink
to it, so the entry is clickable in Word and in the converted PDF; and the conversion writes
every bookmark as a named destination, which is where the two-pass approach now reads a
heading's page from (`render/toc.py`).

It used to search the page text for the heading's words, which fails in exactly the shape a
real report has — the reason for this module, measured over a real conversion:

* **a heading that repeats.** "Inbound" and "Outbound" appear once per security group; every
  "Inbound" entry was numbered with the first one's page.
* **a heading whose words appeared earlier.** A machine's name is in the inventory table long
  before its own section; its entry was numbered with the inventory's page.

Like `test_toc_proof.py`, this runs LibreOffice rather than skipping without it.
"""

from __future__ import annotations

import io
import os
import tempfile
from typing import Final

import pytest
from docx import Document as open_docx
from docx.oxml.ns import qn

import messages_factory as mf
from reporting_agent.compile.ast import Document, FigurePath, Paragraph, Text
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.figures import FigureLedger
from reporting_agent.render.docx import render_document
from reporting_agent.render.front_matter import CoverConfig, FrontMatterConfig, RunFacts
from reporting_agent.render.toc import (
    apply_toc_page_numbers,
    heading_bookmark,
    named_destination_pages,
    toc_entries_from_document,
)
from reporting_agent.verify.toc import check_toc
from reporting_agent.verify.tokens import paragraph_texts

# A throwaway LibreOffice profile, as `pipeline_harness.py` sets one: the image's warmed
# profile path does not exist outside the image.
os.environ.setdefault("LO_PROFILE", tempfile.mkdtemp(prefix="rpt-lo-profile-"))

DESIGN: Final[dict[str, object]] = {
    "preset": "editorial",
    "accent_color": "#1f6f78",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": False,
    "logo": None,
    "page_size": "A4",
}

# Heading 1 starts a page in every theme, so each of these lands on its own page.
OUTLINE: Final[tuple[tuple[str, str], ...]] = (
    ("Heading 1", "Network Security Groups"),
    ("Heading 2", "Inbound"),
    ("Heading 1", "Firewall Rules"),
    ("Heading 2", "Inbound"),
    ("Heading 1", "Virtual Machine Utilization"),
    ("Heading 2", "CPN-App"),
)


def _paragraph(index: int, style: str, text: str) -> Paragraph:
    return Paragraph(
        path=FigurePath(f"p{index}"),
        style=style,
        inlines=(Text(path=FigurePath(f"p{index}.0"), text=text),),
    )


def _document() -> Document:
    blocks: list[Paragraph] = [
        # The machine's name, printed well before its own section.
        _paragraph(0, "Heading 1", "Inventory"),
        _paragraph(1, "Body Text", "CPN-App runs in the fatechid resource group."),
    ]
    for index, (style, text) in enumerate(OUTLINE, start=2):
        blocks.append(_paragraph(index * 2, style, text))
        blocks.append(_paragraph(index * 2 + 1, "Body Text", "Content of the section."))
    return Document(blocks=tuple(blocks))


@pytest.fixture(scope="module")
def two_pass():
    document = _document()
    outcome = render_document(
        document,
        ledger=FigureLedger(),
        design=DesignSettings.from_plain(DESIGN),
        messages=mf.EN,
        front_matter=FrontMatterConfig(cover=CoverConfig(enabled=False)),
        run=RunFacts(
            run_id="r1",
            template_id="t1",
            customer_name="FATechID",
            period_display="August 2026",
            report_title="Monthly Report",
        ),
    )
    headings = tuple(text for text, _level in toc_entries_from_document(document))
    docx_bytes, pdf_bytes = apply_toc_page_numbers(outcome.docx_bytes, headings=headings)
    return document, docx_bytes, pdf_bytes


def _entries(docx_bytes: bytes) -> list[tuple[str, str, str]]:
    """`(link target, heading text, printed page)` for every contents entry."""
    document = open_docx(io.BytesIO(docx_bytes))
    entries = []
    for link in document.element.body.iter(qn("w:hyperlink")):
        texts = [t.text or "" for t in link.iter(qn("w:t"))]
        entries.append((link.get(qn("w:anchor")), texts[0], texts[-1]))
    return entries


def test_every_heading_carries_the_bookmark_its_entry_links_to(two_pass) -> None:
    document, docx_bytes, _ = two_pass
    bookmarks = [
        mark.get(qn("w:name"))
        for mark in open_docx(io.BytesIO(docx_bytes)).element.body.iter(qn("w:bookmarkStart"))
    ]
    count = len(toc_entries_from_document(document))
    assert bookmarks == [heading_bookmark(ordinal) for ordinal in range(1, count + 1)]
    assert [target for target, _, _ in _entries(docx_bytes)] == bookmarks


def test_each_entry_is_numbered_with_the_page_its_own_heading_landed_on(two_pass) -> None:
    _, docx_bytes, pdf_bytes = two_pass
    destinations = named_destination_pages(pdf_bytes)
    entries = _entries(docx_bytes)

    for target, heading, printed in entries:
        assert printed == str(destinations[target]), (heading, printed, destinations[target])

    # The two cases a text search got wrong: the second "Inbound" is not the first one's
    # page, and "CPN-App" is its own section's page, not the inventory's.
    pages = {target: int(printed) for target, _heading, printed in entries}
    inbound = [pages[target] for target, heading, _ in entries if heading == "Inbound"]
    assert len(inbound) == 2 and inbound[0] < inbound[1]
    inventory = next(pages[t] for t, heading, _ in entries if heading == "Inventory")
    cpn_app = next(pages[t] for t, heading, _ in entries if heading == "CPN-App")
    assert cpn_app > inventory


def test_the_entries_are_links_in_the_converted_pdf(two_pass) -> None:
    from pypdf import PdfReader

    _, _, pdf_bytes = two_pass
    reader = PdfReader(io.BytesIO(pdf_bytes))
    links = [
        annotation.get_object()
        for page in reader.pages
        for annotation in page.get("/Annots", [])
        if annotation.get_object().get("/Subtype") == "/Link"
    ]
    assert len(links) == len(_entries(two_pass[1]))


def test_the_verifier_proves_every_number_and_admits_each_only_in_its_own_entry(two_pass) -> None:
    _, docx_bytes, pdf_bytes = two_pass
    document = open_docx(io.BytesIO(docx_bytes))
    paragraphs = paragraph_texts(document)

    result = check_toc(pdf_bytes, paragraphs=paragraphs, document=document)

    assert result.findings == ()
    assert result.entries_checked == len(_entries(docx_bytes))
    by_ordinal = {paragraph.ordinal: paragraph.text for paragraph in paragraphs}
    for ordinal, numerals in result.proven_toc_numerals.items():
        [numeral] = numerals
        assert by_ordinal[ordinal].endswith(numeral)


def test_a_wrong_printed_page_is_a_finding(two_pass) -> None:
    _, docx_bytes, pdf_bytes = two_pass
    document = open_docx(io.BytesIO(docx_bytes))
    link = next(iter(document.element.body.iter(qn("w:hyperlink"))))
    number = list(link.iter(qn("w:t")))[-1]
    number.text = str(int(number.text) + 1)

    result = check_toc(pdf_bytes, paragraphs=paragraph_texts(document), document=document)

    assert len(result.findings) == 1
    assert result.findings[0]["page_named"] == result.findings[0]["page_observed"] + 1
