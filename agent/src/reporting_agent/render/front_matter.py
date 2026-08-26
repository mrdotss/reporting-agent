"""Emit the front matter: cover, document control and table of contents, in that order,
before every content block (Req 13.4, 13.5, 13.6, 13.8, 13.9, 13.15, 13.16, 15.3).

## The three clauses that bind this module

(a) Where the cover-page flag is FALSE, emit no cover content AND NO LEADING BLANK PAGE,
    retain the cover configuration in the definition, and emit the document control page
    and table of contents UNCHANGED — disabling the cover does not disable the front matter.

(b) A role with no supplied signature image gets an EMPTY RULED SIGNATURE BOX at the height
    the theme declares, and emphatically NOT that role's typed name: a typed name in a
    signature position presents an approval nobody gave.

(c) A per-run value that is absent is RENDER_FAILED NAMING THAT VALUE, with no report
    artifact and NO SUBSTITUTED PLACEHOLDER in its position — a cover carrying invented
    copy is a document that cannot be signed.

## `document_number` resolves identically on every render of one run

Two renders of one run resolve one identical number. Two runs of one template and one
resolved period resolve the SAME number (distinguished by the revision history row),
because a re-run of one period is a revision of one document rather than a second document.

## Every fixed string is resolved by id through `messages`

This module contains no literal user-facing copy. Every heading, label, and column header
is a string id resolved through the `Messages` instance the caller supplies, pinned to the
run's language.

## TOC emission

Table-of-contents entries are emitted at levels 1-3 by :func:`_emit_toc` as pass 1 of
the two-pass approach: heading text + tab, no page number. Pass 2 is handled by
``render/toc.py::apply_toc_page_numbers`` which operates on the serialized docx bytes
after conversion to measure actual positions and fill in page numbers.

## Call site in render/docx.py

``render_document`` calls ``emit_front_matter`` after ``_apply_page_size`` and the preview
notice, before the first content block. ``front_matter=None`` (v1 definitions, thumbnails)
skips the call entirely.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Final

from docx.document import Document as DocxDocument
from docx.enum.text import WD_BREAK
from docx.oxml.ns import qn

from reporting_agent.compile.definition import (
    APPROVER_ROLES,
)
from reporting_agent.compile.messages import Messages
from reporting_agent.errors import RenderFailedError

__all__ = [
    "APPROVER_HEADER_COMPANY",
    "APPROVER_HEADER_NAME",
    "APPROVER_HEADER_ROLE",
    "APPROVER_HEADER_SIGNATURE",
    "DOC_CONTROL_CONFIDENTIALITY",
    "DOC_CONTROL_DISTRIBUTION",
    "DOC_CONTROL_DOCUMENT_NAME",
    "DOC_CONTROL_DOCUMENT_NUMBER",
    "DOC_CONTROL_REVISION_HISTORY",
    "DOC_CONTROL_TITLE",
    "SIGNATURE_BOX_HEIGHT_TWIPS",
    "FrontMatterConfig",
    "RunFacts",
    "document_number",
    "emit_front_matter",
]


# ---------------------------------------------------------------------------
# String ids resolved through the message catalog (Req 15.3)
# ---------------------------------------------------------------------------

DOC_CONTROL_TITLE: Final[str] = "doc.front_matter.document_control"
DOC_CONTROL_DOCUMENT_NAME: Final[str] = "doc.front_matter.document_name"
DOC_CONTROL_DOCUMENT_NUMBER: Final[str] = "doc.front_matter.document_number"
DOC_CONTROL_CONFIDENTIALITY: Final[str] = "doc.front_matter.confidentiality"
DOC_CONTROL_DISTRIBUTION: Final[str] = "doc.front_matter.distribution"
DOC_CONTROL_REVISION_HISTORY: Final[str] = "doc.front_matter.revision_history"

APPROVER_HEADER_ROLE: Final[str] = "doc.front_matter.approver_role"
APPROVER_HEADER_COMPANY: Final[str] = "doc.front_matter.approver_company"
APPROVER_HEADER_NAME: Final[str] = "doc.front_matter.approver_name"
APPROVER_HEADER_SIGNATURE: Final[str] = "doc.front_matter.approver_signature"


# ---------------------------------------------------------------------------
# Theme constants
# ---------------------------------------------------------------------------

from reporting_agent.render.themes import SIGNATURE_ROW_HEIGHT_TWIPS

SIGNATURE_BOX_HEIGHT_TWIPS: Final[int] = SIGNATURE_ROW_HEIGHT_TWIPS
"""The height of an empty ruled signature box, read from the theme rather than restated.

The task's wording is "an empty ruled signature box at the height the theme declares", so
the theme is the single declaration and this is an alias for reading it by the name the
front matter thinks in. It was briefly a second literal `907` here; two constants that must
agree, with nothing asserting they do, is the drift this codebase avoids everywhere else.

The box is exactly this tall. A supplied signature image would grow it
(``w:hRule="atLeast"``), but no image is emitted when none is supplied — only an empty cell
at this declared height, because a typed name in a signature position presents an approval
nobody gave."""


# ---------------------------------------------------------------------------
# Placeholder grammar (closed set from task 7.2 — read, not reinvented)
# ---------------------------------------------------------------------------

_PLACEHOLDER_RE: Final[re.Pattern[str]] = re.compile(r"\{[^{}]*\}")


# ---------------------------------------------------------------------------
# Configuration and per-run facts
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ApproverEntry:
    """One role in the approvers list."""

    role: str
    name: str = ""
    title: str = ""


@dataclass(frozen=True, slots=True)
class CoverConfig:
    """The cover subsection of `front_matter`."""

    enabled: bool = True
    logo: str | None = None
    contact_block: str | None = None
    subtitle: str | None = None


@dataclass(frozen=True, slots=True)
class DocumentControlConfig:
    """The document_control subsection of `front_matter`."""

    document_name: str | None = None
    document_number_pattern: str | None = None
    confidentiality_notice_id: str | None = None
    distribution: str | None = None
    approvers: tuple[ApproverEntry, ...] = ()


@dataclass(frozen=True, slots=True)
class TocConfig:
    """The toc subsection of `front_matter`."""

    enabled: bool = True
    max_level: int = 3


@dataclass(frozen=True, slots=True)
class FrontMatterConfig:
    """The full `front_matter` section, resolved from a validated definition.

    This is a data container only — no I/O, no network. The definition validator has
    already constrained every field.
    """

    cover: CoverConfig = field(default_factory=CoverConfig)
    document_control: DocumentControlConfig = field(
        default_factory=DocumentControlConfig
    )
    toc: TocConfig = field(default_factory=TocConfig)


@dataclass(frozen=True, slots=True)
class RevisionHistoryRow:
    """One row of the revision history table, supplied per-run at enqueue (Req 13.7)."""

    revision: str
    note: str = ""
    author: str = ""


@dataclass(frozen=True, slots=True)
class RunFacts:
    """Per-run values that the front matter needs (Req 13.7).

    Template-once values live in `FrontMatterConfig`; per-run values live here. This
    separation is the schema's: template config is stored on the definition and per-run
    values arrive at enqueue.
    """

    run_id: str
    template_id: str
    customer_name: str
    period_display: str
    report_title: str
    revision_history: RevisionHistoryRow | None = None
    period_start_year: str = ""
    period_start_month: str = ""


# ---------------------------------------------------------------------------
# `document_number` — the closed placeholder grammar (Req 13.8, 13.16)
# ---------------------------------------------------------------------------


def document_number(pattern: str, *, run: RunFacts) -> str:
    """Apply the document-number pattern to one run.

    The placeholder grammar is the closed set declared in `compile/definition.py` (task 7.2):
    `{template}`, `{year}`, `{month}`, `{run}`.

    Two renders of one run resolve one identical number. Two runs of one template and one
    resolved period resolve the SAME number — only `{run}` distinguishes them, and the
    definition validator already rejects a pattern naming no varying placeholder — so a
    re-run of one period is a revision of one document rather than a second document
    (Req 13.16).

    A placeholder whose substitution value is absent raises `RENDER_FAILED` naming the
    placeholder (clause c).
    """
    substitutions: dict[str, str] = {
        "{template}": run.template_id,
        "{year}": run.period_start_year,
        "{month}": run.period_start_month,
        "{run}": run.run_id,
    }

    # Validate that every required substitution value is non-empty.
    for placeholder, value in substitutions.items():
        if placeholder in pattern and not value:
            raise RenderFailedError(
                f"the document-number pattern names {placeholder} but the per-run value "
                f"for it is absent; a cover carrying invented copy is a document that "
                f"cannot be signed (Req 13.15)"
            )

    # Apply all placeholders from the closed set.
    result = pattern
    for placeholder, value in substitutions.items():
        result = result.replace(placeholder, value)

    return result


# ---------------------------------------------------------------------------
# emit_front_matter — the main entry point
# ---------------------------------------------------------------------------


def emit_front_matter(
    document: DocxDocument,
    *,
    front_matter: FrontMatterConfig,
    run: RunFacts,
    messages: Messages,
    cursor: object = None,
    ledger: object = None,
) -> None:
    """Emit cover, then document control, then the table of contents, in that order,
    before every content block (Req 13.4).

    Not composable, not reorderable, no block accepted inside it.

    Where the definition's cover-page flag is false, emit NO cover content and NO leading
    blank page, retain the cover configuration in the definition, and emit the document
    control page and the table of contents unchanged — disabling the cover does not
    disable the front matter (Req 13.9).

    A per-run value that is absent is `RENDER_FAILED` naming that value, with no report
    artifact and no substituted placeholder in its position (Req 13.15).
    """
    # --- validate per-run values (clause c) ------------------------------------------
    _require_run_value(run.customer_name, "customer_name")
    _require_run_value(run.period_display, "period_display")
    _require_run_value(run.report_title, "report_title")
    _require_run_value(run.run_id, "run_id")

    # --- resolve document number if pattern is declared ------------------------------
    doc_number: str | None = None
    pattern = front_matter.document_control.document_number_pattern
    if pattern:
        doc_number = document_number(pattern, run=run)

    # --- cover (Req 13.4, 13.9) -----------------------------------------------------
    # Clause (a): if cover disabled, emit NO cover content and NO leading blank page.
    if front_matter.cover.enabled:
        _emit_cover(document, front_matter=front_matter, run=run, messages=messages,
                    doc_number=doc_number)

    # --- document control (Req 13.5, 13.6) ------------------------------------------
    _emit_document_control(
        document, front_matter=front_matter, run=run, messages=messages,
        doc_number=doc_number,
    )

    # --- table of contents (Req 14.3, 14.5, 14.11) -----------------------------------
    # Emit entries for pass 1 of the two-pass approach: heading text + tab, no page
    # number. Pass 2 (apply_toc_page_numbers in render/toc.py) operates on the serialized
    # docx bytes after conversion to measure actual page positions, then re-emits with
    # the measured numbers as literal text.
    from reporting_agent.render.toc import should_emit_toc, toc_entries_from_document
    if should_emit_toc() and front_matter.toc.enabled:
        _emit_toc(
            document,
            heading_entries=toc_entries_from_document(cursor) if cursor is not None else (),
            messages=messages,
        )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _require_run_value(value: str, name: str) -> None:
    """Clause (c): a per-run value that is absent is RENDER_FAILED naming it."""
    if not value or not value.strip():
        raise RenderFailedError(
            f"the per-run value {name!r} is absent; a cover carrying invented copy is "
            f"a document that cannot be signed. No report artifact is produced and no "
            f"substituted placeholder is emitted in its position (Req 13.15)."
        )


def _emit_cover(
    document: DocxDocument,
    *,
    front_matter: FrontMatterConfig,
    run: RunFacts,
    messages: Messages,
    doc_number: str | None,
) -> None:
    """Emit the cover page: report title, customer name, period, contact block.

    Uses theme styles ``Cover Title`` and ``Cover Meta`` (declared in
    ``render/themes.py``). Ends with a page break so document control starts on a fresh
    page.
    """
    from reporting_agent.render.themes import COVER_META_STYLE, COVER_TITLE_STYLE

    # Report title in Cover Title style
    document.add_paragraph(run.report_title, style=COVER_TITLE_STYLE)

    # Customer name
    document.add_paragraph(run.customer_name, style=COVER_META_STYLE)

    # Period
    document.add_paragraph(run.period_display, style=COVER_META_STYLE)

    # Subtitle (optional)
    if front_matter.cover.subtitle:
        document.add_paragraph(front_matter.cover.subtitle, style=COVER_META_STYLE)

    # Contact block (optional)
    if front_matter.cover.contact_block:
        document.add_paragraph(front_matter.cover.contact_block, style=COVER_META_STYLE)

    # Document number on cover (identical to document control page — Req 13.8)
    if doc_number:
        document.add_paragraph(doc_number, style=COVER_META_STYLE)

    # Page break after cover
    _add_page_break(document)


def _emit_document_control(
    document: DocxDocument,
    *,
    front_matter: FrontMatterConfig,
    run: RunFacts,
    messages: Messages,
    doc_number: str | None,
) -> None:
    """Emit the document control page (Req 13.5, 13.6).

    Carries: document control heading, document name, document number, approvers table,
    revision history, distribution, confidentiality notice.

    The approvers table emits one row per role. Where no signature image is supplied,
    emit an EMPTY RULED SIGNATURE BOX — NOT the typed name (clause b).

    Every fixed string is resolved by id through ``messages`` (Req 15.3).
    """
    from reporting_agent.render.themes import DOCUMENT_CONTROL_STYLE

    # --- document control heading (resolved by id) ---
    dc_title = messages.text(DOC_CONTROL_TITLE)
    document.add_paragraph(dc_title, style=DOCUMENT_CONTROL_STYLE)

    # --- document name (optional in config) ---
    if front_matter.document_control.document_name:
        dc_doc_name_label = messages.text(DOC_CONTROL_DOCUMENT_NAME)
        document.add_paragraph(
            f"{dc_doc_name_label}: {front_matter.document_control.document_name}",
            style=DOCUMENT_CONTROL_STYLE,
        )

    # --- document number (Req 13.8 — identical on cover and here) ---
    if doc_number:
        dc_doc_number_label = messages.text(DOC_CONTROL_DOCUMENT_NUMBER)
        document.add_paragraph(
            f"{dc_doc_number_label}: {doc_number}",
            style=DOCUMENT_CONTROL_STYLE,
        )

    # --- customer name ---
    dc_prepared_for = messages.text("doc.front_matter.prepared_for")
    document.add_paragraph(
        f"{dc_prepared_for}: {run.customer_name}",
        style=DOCUMENT_CONTROL_STYLE,
    )

    # --- approvers table (Req 13.6) ---
    _emit_approvers_table(document, front_matter=front_matter, messages=messages)

    # --- revision history ---
    if run.revision_history:
        rev_label = messages.text(DOC_CONTROL_REVISION_HISTORY)
        document.add_paragraph(rev_label, style=DOCUMENT_CONTROL_STYLE)
        document.add_paragraph(
            f"{run.revision_history.revision} — {run.revision_history.note}"
            + (f" ({run.revision_history.author})" if run.revision_history.author else ""),
            style=DOCUMENT_CONTROL_STYLE,
        )

    # --- distribution ---
    if front_matter.document_control.distribution:
        dist_label = messages.text(DOC_CONTROL_DISTRIBUTION)
        document.add_paragraph(
            f"{dist_label}: {front_matter.document_control.distribution}",
            style=DOCUMENT_CONTROL_STYLE,
        )

    # --- confidentiality notice ---
    if front_matter.document_control.confidentiality_notice_id:
        conf_text = messages.text(
            front_matter.document_control.confidentiality_notice_id
        )
        document.add_paragraph(conf_text, style=DOCUMENT_CONTROL_STYLE)

    # Page break after document control
    _add_page_break(document)


def _emit_approvers_table(
    document: DocxDocument,
    *,
    front_matter: FrontMatterConfig,
    messages: Messages,
) -> None:
    """Emit the approvers table: one row per role (Req 13.6).

    Clause (b): a role with no supplied signature image gets an EMPTY RULED SIGNATURE BOX
    at the height the theme declares, NOT that role's typed name.

    The table uses the ``Table Signature`` style from ``render/themes.py``.
    """
    from reporting_agent.render.themes import SIGNATURE_TABLE_STYLE

    # Headers resolved by id
    header_role = messages.text(APPROVER_HEADER_ROLE)
    header_company = messages.text(APPROVER_HEADER_COMPANY)
    header_name = messages.text(APPROVER_HEADER_NAME)
    header_signature = messages.text(APPROVER_HEADER_SIGNATURE)

    # Create table: header row + one row per declared role
    num_roles = len(APPROVER_ROLES)
    table = document.add_table(rows=1 + num_roles, cols=4)
    table.style = SIGNATURE_TABLE_STYLE

    # Header row
    hdr_cells = table.rows[0].cells
    hdr_cells[0].text = header_role
    hdr_cells[1].text = header_company
    hdr_cells[2].text = header_name
    hdr_cells[3].text = header_signature

    # One row per role
    for i, role in enumerate(APPROVER_ROLES):
        row_cells = table.rows[i + 1].cells
        entry = _find_approver(front_matter.document_control.approvers, role)

        row_cells[0].text = role
        row_cells[1].text = entry.title if entry else ""
        row_cells[2].text = entry.name if entry else ""

        # Clause (b): signature cell is EMPTY (ruled box at declared height).
        # Never the typed name. The row height enforces the ruled box.
        row_cells[3].text = ""

        # Set row height to the theme's declared signature box height
        _set_row_height(table.rows[i + 1], SIGNATURE_BOX_HEIGHT_TWIPS)


def _set_row_height(row: object, height_twips: int) -> None:
    """Set a table row's height to exactly ``height_twips`` with hRule=atLeast.

    This creates the empty ruled signature box — the row is at least this tall, so an
    empty signature cell renders as a box of the declared height rather than collapsing.
    """
    tr = row._tr  # type: ignore[attr-defined]
    tr_pr = tr.get_or_add_trPr()
    tr_height = tr_pr.makeelement(
        qn("w:trHeight"),
        {qn("w:val"): str(height_twips), qn("w:hRule"): "atLeast"},
    )
    tr_pr.append(tr_height)


def _add_page_break(document: DocxDocument) -> None:
    """Add a page break after the current content."""
    paragraph = document.add_paragraph()
    run = paragraph.add_run()
    run.add_break(WD_BREAK.PAGE)


def _find_approver(
    approvers: tuple[ApproverEntry, ...], role: str
) -> ApproverEntry | None:
    """Find the approver entry for a given role, or None."""
    for entry in approvers:
        if entry.role == role:
            return entry
    return None



def _emit_toc(
    document: DocxDocument,
    *,
    heading_entries: tuple[tuple[str, int], ...],
    messages: Messages,
) -> None:
    """Emit the table of contents section (Req 14.3, 14.5, 14.11).

    Emits a TOC section heading followed by one entry per heading block at levels 1-3
    in document order. Each entry carries the heading's text and a tab stop; the page
    number position is left empty for pass 1 of the two-pass approach. Pass 2
    (``render.toc.apply_toc_page_numbers``) fills it after measuring actual page
    positions from the converted PDF.

    Followed by a page break so content starts on a fresh page.
    """
    from reporting_agent.render.themes import TOC_ENTRY_STYLE
    from reporting_agent.render.toc import TOC_LABEL_ID

    # Section heading — styled Title so it doesn't appear in its own TOC.
    toc_label = messages.text(TOC_LABEL_ID)
    document.add_paragraph(toc_label, style="Title")

    # One entry per heading, at levels 1-3. The text + tab is emitted whether or not
    # a number follows, so pass 1 lays out to exactly the height pass 2 will.
    for heading_text, _level in heading_entries:
        paragraph = document.add_paragraph(style=TOC_ENTRY_STYLE)
        paragraph.add_run(heading_text)
        paragraph.add_run().add_tab()

    # Page break after the TOC section.
    _add_page_break(document)
