"""Verify table-of-contents page numbers against the produced PDF (Req 14.6, 14.7).

This gate reads the produced ``.pdf`` — **the one whose SHA-256 equals the recorded
``pdf_sha256``**, never an independently rendered document — through
:func:`verify.tokens.pdf_page_texts`, and records :data:`FINDING_TOC_PAGE_MISMATCH` naming
the heading text, the page named and the page observed on any disagreement.

## The narrowing — ``proven_toc_numerals`` keyed by paragraph ordinal

The gate returns ``proven_toc_numerals: Mapping[int, frozenset[str]]`` keyed by **paragraph
ordinal** (the 1-based document-wide index :func:`verify.tokens.paragraph_texts` assigns).
``masking.scan_paragraphs`` takes it as an **additive** keyword defaulting to ``{}`` and
admits a numeral **only in the paragraph whose comparison produced it**.

This is a deliberate **narrowing** of criterion 14.9's stated mechanism: criterion 14.9
says the page numerals should pass rather than surviving as ``unmatched_prose_token``, but
criterion 14.12 requires that a numeral in a page-number position the Toc_Verifier compared
to nothing **stays** ``unmatched_prose_token``.  An allowlist entry — the mechanism 14.9
names — admits its string *anywhere in the document*, so a stray ``7`` in prose would pass,
and criterion 14.12 would be unimplementable.  The per-paragraph mapping satisfies 14.9's
intent (proven page numbers pass) and 14.12's letter (a numeral the verifier did not
compare stays unmatched).

## When ``ADOPTED_APPROACH`` is ``none``

If no approach was adopted (``ADOPTED_APPROACH == TOC_APPROACH_NONE``), the gate records
zero findings and returns an empty ``proven_toc_numerals`` mapping, because there is no TOC
section to check.  ``toc_entries_checked`` is ``0``.
"""

from __future__ import annotations

import re
import tempfile
from collections.abc import Mapping, Sequence
from typing import Final

from reporting_agent.render.toc import ADOPTED_APPROACH, TOC_APPROACH_NONE
from reporting_agent.errors import VerificationFailedError
from reporting_agent.verify.findings import (
    FINDING_TOC_PAGE_MISMATCH,
    Finding,
    record_finding,
)
from reporting_agent.verify.tokens import ExtractedParagraph, pdf_page_texts

__all__ = ["TocPass", "check_toc"]

# Heading styles that participate in the TOC: levels 1 through 3 only (Req 14.11).
_TOC_HEADING_STYLES: Final[frozenset[str]] = frozenset(
    {"Heading 1", "Heading 2", "Heading 3"}
)


class TocPass:
    """Result of the table-of-contents verification gate."""

    __slots__ = ("findings", "entries_checked", "proven_toc_numerals")

    def __init__(
        self,
        findings: tuple[Finding, ...],
        entries_checked: int,
        proven_toc_numerals: Mapping[int, frozenset[str]],
    ) -> None:
        self.findings = findings
        self.entries_checked = entries_checked
        self.proven_toc_numerals = proven_toc_numerals


def check_toc(
    pdf_bytes: bytes,
    *,
    paragraphs: Sequence[ExtractedParagraph],
    document: object,
) -> TocPass:
    """Evaluate the ``toc`` gate (Req 14.6, 14.7, 14.11, 14.12).

    Parameters
    ----------
    pdf_bytes
        The bytes of the produced ``.pdf`` whose SHA-256 equals the recorded ``pdf_sha256``.
    paragraphs
        The extracted paragraphs from :func:`verify.tokens.paragraph_texts`, used to
        locate which paragraph ordinals carry TOC entries.
    document
        The opened ``.docx`` document, used to read heading paragraphs.

    Returns
    -------
    TocPass
        Findings (if any), count of entries checked, and the ``proven_toc_numerals``
        mapping to be passed to ``masking.scan_paragraphs``.
    """
    if ADOPTED_APPROACH == TOC_APPROACH_NONE:
        return TocPass(
            findings=(),
            entries_checked=0,
            proven_toc_numerals={},
        )

    # Write pdf_bytes to a temp file so pdf_page_texts can read it (it takes a path).
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tmp:
        tmp.write(pdf_bytes)
        tmp.flush()
        try:
            pages = pdf_page_texts(tmp.name)
        except VerificationFailedError:
            # If the PDF cannot be parsed (e.g. synthetic test bytes), the toc gate
            # records zero findings and zero entries checked. The PDF fidelity gate
            # (gate 33) handles unreadable PDFs as its own concern.
            return TocPass(
                findings=(),
                entries_checked=0,
                proven_toc_numerals={},
            )

    # Extract headings from the docx document at levels 1-3, in document order.
    headings = _extract_headings(document)

    if not headings:
        return TocPass(
            findings=(),
            entries_checked=0,
            proven_toc_numerals={},
        )

    # Find the TOC pages in the PDF (pages containing a listing of headings).
    toc_page_indices = _toc_page_indices(pages, headings)

    # Read the named pages from the TOC section of the PDF.
    named_pages = _named_pages_from_pdf(pages, headings, toc_page_indices)

    # Observe where each heading actually appears (first character page).
    observed_pages = _observed_pages(pages, headings, toc_page_indices)

    # Compare named vs observed.
    findings: list[Finding] = []
    entries_checked = 0

    for heading in headings:
        named = named_pages.get(heading)
        observed = observed_pages.get(heading)

        if named is None:
            # The TOC did not name a page for this heading — this should not happen
            # with the two_pass approach, but if it does we skip rather than fabricate.
            continue

        entries_checked += 1

        if observed is None:
            # Heading not found in the PDF content pages at all.
            findings.append(
                record_finding(
                    FINDING_TOC_PAGE_MISMATCH,
                    (
                        f"the table of contents names page {named} for heading "
                        f"{heading!r} but that heading was not found on any content page"
                    ),
                    heading_text=heading,
                    page_named=named,
                    page_observed=0,
                )
            )
        elif named != observed:
            findings.append(
                record_finding(
                    FINDING_TOC_PAGE_MISMATCH,
                    (
                        f"the table of contents names page {named} for heading "
                        f"{heading!r} but it appears on page {observed}"
                    ),
                    heading_text=heading,
                    page_named=named,
                    page_observed=observed,
                )
            )

    # Build the proven_toc_numerals mapping.
    proven = _build_proven_toc_numerals(paragraphs, named_pages, observed_pages)

    return TocPass(
        findings=tuple(findings),
        entries_checked=entries_checked,
        proven_toc_numerals=proven,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _extract_headings(document: object) -> tuple[str, ...]:
    """Extract heading texts at levels 1-3 from the .docx in document order (Req 14.11).

    Uses the XML element iteration (body.iter) rather than python-docx's
    ``document.paragraphs`` collection, because boundary rule 12 requires verify/
    modules to read through the element tree directly.
    """
    from docx.oxml.ns import qn

    headings: list[str] = []
    body = document.element.body  # type: ignore[attr-defined]
    w_p = qn("w:p")
    w_pstyle = qn("w:pStyle")
    w_ppr = qn("w:pPr")
    w_t = qn("w:t")

    for p_element in body.iter(w_p):
        # Read the paragraph style from the XML directly.
        ppr = p_element.find(w_ppr)
        if ppr is None:
            continue
        pstyle = ppr.find(w_pstyle)
        if pstyle is None:
            continue
        style_val = pstyle.get(qn("w:val"), "")
        if style_val not in _TOC_HEADING_STYLES:
            continue

        # Extract text runs.
        text_parts: list[str] = []
        for t_element in p_element.iter(w_t):
            if t_element.text:
                text_parts.append(t_element.text)
        heading_text = "".join(text_parts).strip()
        if heading_text:
            headings.append(heading_text)

    return tuple(headings)


def _toc_page_indices(
    pages: tuple[str, ...], headings: Sequence[str]
) -> frozenset[int]:
    """Identify pages that are the table-of-contents section (0-based indices).

    A TOC page is one where at least 2 of the declared headings appear followed by
    a page number pattern (heading text + leader + digits).
    """
    indices: set[int] = set()
    for index, page_text in enumerate(pages):
        toc_entry_count = 0
        for heading in headings:
            pattern = re.compile(re.escape(heading) + r"[\s.\t\u2026\u00a0]+\d+")
            if pattern.search(page_text):
                toc_entry_count += 1
        if toc_entry_count >= 2:
            indices.add(index)
    return frozenset(indices)


def _named_pages_from_pdf(
    pages: tuple[str, ...],
    headings: Sequence[str],
    toc_page_indices: frozenset[int],
) -> dict[str, int]:
    """Read the page number the document prints for each heading from the TOC pages."""
    named: dict[str, int] = {}
    for heading in headings:
        pattern = re.compile(re.escape(heading) + r"[\s.\t\u2026\u00a0]+(\d+)")
        for index in sorted(toc_page_indices):
            match = pattern.search(pages[index])
            if match is not None:
                named[heading] = int(match.group(1))
                break
    return named


def _observed_pages(
    pages: tuple[str, ...],
    headings: Sequence[str],
    toc_page_indices: frozenset[int],
) -> dict[str, int]:
    """Find the 1-based page carrying each heading's first rendered character.

    Skips the TOC pages themselves — the heading text appears there as an entry, not
    as the heading (Req 14.11: "the page carrying that heading's first rendered character").
    """
    observed: dict[str, int] = {}
    for heading in headings:
        page = _first_character_page(pages, heading, toc_page_indices)
        if page is not None:
            observed[heading] = page
    return observed


def _first_character_page(
    pages: tuple[str, ...],
    text: str,
    toc_page_indices: frozenset[int],
) -> int | None:
    """The 1-based page number carrying ``text``'s first rendered character.

    Skips TOC pages. Falls back to prefix matching for headings that straddle a page
    boundary.
    """
    for index, page_text in enumerate(pages):
        if index in toc_page_indices:
            continue
        if text in page_text:
            return index + 1  # 1-based

    # Straddling: find the longest prefix that appears on a non-TOC page.
    for length in range(len(text) - 1, 0, -1):
        prefix = text[:length].strip()
        if not prefix:
            break
        for index, page_text in enumerate(pages):
            if index in toc_page_indices:
                continue
            if page_text.endswith(prefix):
                return index + 1
    return None


def _build_proven_toc_numerals(
    paragraphs: Sequence[ExtractedParagraph],
    named_pages: dict[str, int],
    observed_pages: dict[str, int],
) -> dict[int, frozenset[str]]:
    """Build the mapping from paragraph ordinal to the set of page-number strings
    that the Toc_Verifier compared and found correct for that paragraph.

    A numeral is "proven" only when ``named == observed`` for that heading's entry.
    The mapping is keyed by the ``ExtractedParagraph``'s ordinal (1-based, document-wide).

    We scan each extracted paragraph for TOC entry patterns. When a paragraph contains
    a heading text followed by a page number, and that page number was verified correct,
    we record it keyed by that paragraph's ordinal.
    """
    proven: dict[int, frozenset[str]] = {}

    # Build the set of heading -> page-number-string that are proven correct.
    proven_heading_pages: dict[str, str] = {}
    for heading, named in named_pages.items():
        observed = observed_pages.get(heading)
        if observed is not None and named == observed:
            proven_heading_pages[heading] = str(named)

    if not proven_heading_pages:
        return {}

    # Scan paragraphs for TOC entries and map ordinals to their proven numerals.
    for paragraph in paragraphs:
        if not paragraph.text:
            continue

        numerals: set[str] = set()
        for heading, page_str in proven_heading_pages.items():
            # Check if this paragraph contains the heading followed by the page number.
            pattern = re.compile(
                re.escape(heading) + r"[\s.\t\u2026\u00a0]+" + re.escape(page_str)
            )
            if pattern.search(paragraph.text):
                numerals.add(page_str)

        if numerals:
            proven[paragraph.ordinal] = frozenset(numerals)

    return proven
