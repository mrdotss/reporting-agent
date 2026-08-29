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

import io
import re
from collections.abc import Sequence
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
    "APPROVER_ROLE_LABEL_IDS",
    "DOC_CONTROL_CONFIDENTIALITY",
    "DOC_CONTROL_DISTRIBUTION",
    "DOC_CONTROL_DOCUMENT_NAME",
    "DOC_CONTROL_DOCUMENT_NUMBER",
    "DOC_CONTROL_REVISION_HISTORY",
    "DOC_CONTROL_TITLE",
    "SIGNATURE_BOX_HEIGHT_TWIPS",
    "ApproverEntry",
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
DISTRIBUTION_HEADER_RECIPIENT: Final[str] = "doc.front_matter.distribution_recipient"
DISTRIBUTION_HEADER_COMPANY: Final[str] = "doc.front_matter.distribution_company"
DISTRIBUTION_HEADER_NOTE: Final[str] = "doc.front_matter.distribution_note"
DOC_CONTROL_REVISION_HISTORY: Final[str] = "doc.front_matter.revision_history"
REVISION_LABEL: Final[str] = "doc.front_matter.revision"
REVISION_AUTHOR_LABEL: Final[str] = "doc.front_matter.revision_author"
REVISION_NOTE_LABEL: Final[str] = "doc.front_matter.revision_note"

APPROVER_HEADER_ROLE: Final[str] = "doc.front_matter.approver_role"
APPROVER_HEADER_COMPANY: Final[str] = "doc.front_matter.approver_company"
APPROVER_HEADER_NAME: Final[str] = "doc.front_matter.approver_name"
APPROVER_HEADER_SIGNATURE: Final[str] = "doc.front_matter.approver_signature"

APPROVER_ROLE_LABEL_IDS: Final[dict[str, str]] = {
    "author": "doc.front_matter.role.author",
    "reviewer": "doc.front_matter.role.reviewer",
    "approver": "doc.front_matter.role.approver",
    "recipient": "doc.front_matter.role.recipient",
}
"""Requirement 12.3 — the four roles are relabelled **positionally**
(`Author` / `Quality Control` / `Reviewed By` / `Customer`), through the
message catalogue rather than by renaming a stored id, a fixture, or a
mirror region. `_emit_approvers_table` resolves the role column through
this map instead of writing the raw role id string into the cell — a role
id is an internal symbol (Requirement 1's own rule for this rename), not
copy a reader should see."""


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
    company: str = ""
    signature_image: bytes | None = None
    """The decoded signature image, if one was supplied for this role.

    Bytes, not a key: Requirement 13.5's `signature_key` is resolved to bytes
    **server-side in the app** and passed inline in the invoke payload — the
    runtime holds no session and must not fetch content from the app back —
    so by the time a definition reaches this renderer, there is no key left
    to resolve, only the image or its absence. `None` is the ordinary,
    expected value for a role with no supplied signature; it is what
    produces the empty ruled box (Req 13.1), not an error condition."""


@dataclass(frozen=True, slots=True)
class CoverConfig:
    """The cover subsection of `front_matter`."""

    enabled: bool = True
    logo: str | None = None
    contact_block: str | None = None
    subtitle: str | None = None


@dataclass(frozen=True, slots=True)
class DistributionRow:
    """One row of the v3 distribution list (Req 12.6)."""

    recipient: str = ""
    company: str = ""
    note: str = ""


@dataclass(frozen=True, slots=True)
class DocumentControlConfig:
    """The document_control subsection of `front_matter`.

    `distribution` carries the **v1/v2** free-text block; `distribution_rows` carries the
    **v3** ordered `{recipient, company, note}` rows (Req 12.6). Two fields rather than one
    union because the two render differently — a paragraph and a table — and a renderer
    that had to ask which shape it held on every use would ask in more places than the one
    that matters.

    A definition populates at most one of them. Both empty is the ordinary case for a
    profile that names no distribution at all.
    """

    document_name: str | None = None
    document_number_pattern: str | None = None
    confidentiality_notice_id: str | None = None
    distribution: str | None = None
    distribution_rows: tuple[DistributionRow, ...] = ()
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
    """Emit the cover page: report title, then a labelled block of the run's facts.

    Uses theme styles ``Cover Title`` and ``Cover Meta``, and ``Layout Table`` for the
    facts block. Ends with a page break so document control starts on a fresh page.

    ## Why the facts are a table and not a run of paragraphs

    They were five bare `Cover Meta` paragraphs — customer, period, document number — one
    under the next with nothing saying which was which. A reader who does not already know
    the document cannot tell the customer's name from the report's subtitle, because
    nothing distinguishes them.

    A two-column layout table gives each value its label. ``Layout Table`` is the theme's
    own borderless style, already used by `render/anchors.py` for exactly this — structure
    with no rules drawn — so the cover gains alignment without gaining a grid.
    """
    from reporting_agent.compile.blocks.base import LAYOUT_TABLE_STYLE
    from reporting_agent.render.themes import COVER_META_STYLE, COVER_TITLE_STYLE

    document.add_paragraph(run.report_title, style=COVER_TITLE_STYLE)

    # The subtitle sits directly under the title, where it reads as part of it, rather
    # than as another labelled fact.
    if front_matter.cover.subtitle:
        document.add_paragraph(front_matter.cover.subtitle, style=COVER_META_STYLE)

    # Req 13.8 — the document number is the same string here and on the document
    # control page; both read it from `doc_number`.
    rows: list[tuple[str, str]] = [
        (messages.text("doc.front_matter.prepared_for"), run.customer_name),
        (messages.text("doc.front_matter.reporting_period"), run.period_display),
    ]
    if doc_number:
        rows.append((messages.text(DOC_CONTROL_DOCUMENT_NUMBER), doc_number))
    if front_matter.cover.contact_block:
        rows.append(
            (
                messages.text("doc.front_matter.prepared_by"),
                front_matter.cover.contact_block,
            )
        )

    _emit_label_value_table(
        document, rows, style_name=LAYOUT_TABLE_STYLE, paragraph_style=COVER_META_STYLE
    )

    _add_page_break(document)


def _emit_label_value_table(
    document: DocxDocument,
    rows: Sequence[tuple[str, str]],
    *,
    style_name: str,
    paragraph_style: str,
) -> None:
    """A two-column label/value block, in the given table and paragraph styles.

    Emits nothing for an empty `rows` — a table with no rows is a table a reader has to
    wonder about. Every cell's paragraph carries `paragraph_style` rather than the
    document default, so the block inherits the theme's front-matter type rather than the
    body face.
    """
    if not rows:
        return

    table = document.add_table(rows=len(rows), cols=2)
    table.style = style_name
    for index, (label, value) in enumerate(rows):
        cells = table.rows[index].cells
        _set_cell_text(cells[0], label, paragraph_style)
        _set_cell_text(cells[1], value, paragraph_style)


def _set_cell_text(cell: object, text: str, paragraph_style: str) -> None:
    """Write `text` into `cell`'s first paragraph in `paragraph_style`.

    `python-docx` gives a new cell exactly one empty paragraph; this writes into it rather
    than adding a second, so a cell never carries a blank line above its content.
    """
    paragraph = cell.paragraphs[0]  # type: ignore[attr-defined]
    paragraph.style = paragraph_style
    paragraph.add_run(text)


def _emit_document_control(
    document: DocxDocument,
    *,
    front_matter: FrontMatterConfig,
    run: RunFacts,
    messages: Messages,
    doc_number: str | None,
) -> None:
    """Emit the document control page (Req 13.5, 13.6).

    Carries: the page title, a labelled block naming the document, the approvers table,
    the revision history, the distribution list and the confidentiality notice.

    The approvers table emits one row per role. Where no signature image is supplied,
    emit an EMPTY RULED SIGNATURE BOX — NOT the typed name (clause b).

    Every fixed string is resolved by id through ``messages`` (Req 15.3).

    ## Labelled blocks, not "Label: value" sentences

    The naming block and the revision history were emitted as `Document Control`
    paragraphs holding `f"{label}: {value}"`. That put the page's whole structure inside
    string concatenation: nothing aligned, every label re-read as prose, and a document
    control page indistinguishable from a paragraph of running text. They are tables now,
    in the theme's own borderless ``Layout Table``.
    """
    from reporting_agent.compile.blocks.base import LAYOUT_TABLE_STYLE
    from reporting_agent.render.themes import DOCUMENT_CONTROL_STYLE

    document.add_paragraph(messages.text(DOC_CONTROL_TITLE), style=DOCUMENT_CONTROL_STYLE)

    # --- what this document is ------------------------------------------------
    naming: list[tuple[str, str]] = []
    if front_matter.document_control.document_name:
        naming.append(
            (
                messages.text(DOC_CONTROL_DOCUMENT_NAME),
                front_matter.document_control.document_name,
            )
        )
    # Req 13.8 — identical to the cover's.
    if doc_number:
        naming.append((messages.text(DOC_CONTROL_DOCUMENT_NUMBER), doc_number))
    naming.append(
        (messages.text("doc.front_matter.prepared_for"), run.customer_name)
    )
    _emit_label_value_table(
        document,
        naming,
        style_name=LAYOUT_TABLE_STYLE,
        paragraph_style=DOCUMENT_CONTROL_STYLE,
    )

    # --- approvers (Req 13.6) -------------------------------------------------
    _emit_approvers_table(document, front_matter=front_matter, messages=messages)

    # --- revision history -----------------------------------------------------
    if run.revision_history:
        document.add_paragraph(
            messages.text(DOC_CONTROL_REVISION_HISTORY), style=DOCUMENT_CONTROL_STYLE
        )
        row = run.revision_history
        # One labelled row per field the run actually carried, in the same label/value
        # shape as the naming block above it.
        #
        # Previously one row of `(revision, note + " (author)")`, which put a bare "11" in
        # the label column — a number in the position every other row of this block uses
        # for the name of the thing — and, on a run whose note is empty, a value cell
        # reading " (Mayer Reflino Sitorus)": a parenthetical qualifying nothing. Since
        # schema_version 3 the note is *always* empty, because the revision is derived
        # from the count of prior runs for the period rather than typed, so that was the
        # shape every current run rendered.
        #
        # Concatenation is what made the empty note visible, so there is none: a field the
        # run did not carry contributes no row instead of a fragment of one. A pinned v1
        # or v2 run whose note was typed by hand still renders it, which is what keeps
        # those replays reading as they did.
        revision_rows = [(messages.text(REVISION_LABEL), row.revision)]
        if row.author:
            revision_rows.append((messages.text(REVISION_AUTHOR_LABEL), row.author))
        if row.note:
            revision_rows.append((messages.text(REVISION_NOTE_LABEL), row.note))
        _emit_label_value_table(
            document,
            revision_rows,
            style_name=LAYOUT_TABLE_STYLE,
            paragraph_style=DOCUMENT_CONTROL_STYLE,
        )

    # --- distribution ---------------------------------------------------------
    _emit_distribution(
        document, front_matter=front_matter, messages=messages,
        paragraph_style=DOCUMENT_CONTROL_STYLE,
    )

    # --- confidentiality notice ----------------------------------------------
    if front_matter.document_control.confidentiality_notice_id:
        document.add_paragraph(
            messages.text(front_matter.document_control.confidentiality_notice_id),
            style=DOCUMENT_CONTROL_STYLE,
        )

    _add_page_break(document)


def _emit_distribution(
    document: DocxDocument,
    *,
    front_matter: FrontMatterConfig,
    messages: Messages,
    paragraph_style: str,
) -> None:
    """Emit the distribution list, in whichever of its two shapes the definition carries.

    ## The v3 rows were being rendered as their own Python repr

    `distribution` is a free-text block at schema_version 1 and 2, and **ordered
    `{recipient, company, note}` rows at 3** (Req 12.6). The emitter knew only the string,
    and the pipeline coerced whatever arrived with `str(...)` — so a v3 profile's
    distribution reached the delivered document as `[{'recipient': ...}]`, the list's repr,
    in a signed report. The rows get a table; the string keeps the paragraph it always had.
    """
    from reporting_agent.compile.blocks.base import LAYOUT_TABLE_STYLE

    control = front_matter.document_control
    if not control.distribution_rows and not control.distribution:
        return

    document.add_paragraph(messages.text(DOC_CONTROL_DISTRIBUTION), style=paragraph_style)

    if not control.distribution_rows:
        # v1/v2 — one free-text block, unchanged.
        document.add_paragraph(str(control.distribution), style=paragraph_style)
        return

    table = document.add_table(rows=1 + len(control.distribution_rows), cols=3)
    table.style = LAYOUT_TABLE_STYLE
    header = table.rows[0].cells
    _set_cell_text(header[0], messages.text(DISTRIBUTION_HEADER_RECIPIENT), paragraph_style)
    _set_cell_text(header[1], messages.text(DISTRIBUTION_HEADER_COMPANY), paragraph_style)
    _set_cell_text(header[2], messages.text(DISTRIBUTION_HEADER_NOTE), paragraph_style)

    for index, row in enumerate(control.distribution_rows):
        cells = table.rows[index + 1].cells
        _set_cell_text(cells[0], row.recipient, paragraph_style)
        _set_cell_text(cells[1], row.company, paragraph_style)
        _set_cell_text(cells[2], row.note, paragraph_style)


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

        # Req 12.3 — the role column shows the positional label
        # (Author / Quality Control / Reviewed By / Customer), resolved
        # through the message catalog. The stored role id is an internal
        # symbol; a reader never sees it.
        role_label_id = APPROVER_ROLE_LABEL_IDS.get(role)
        row_cells[0].text = messages.text(role_label_id) if role_label_id else role
        # The COMPANY column shows the approver's **company**. It showed `title` — the
        # person's job title — under a header reading "Company", while the `company` the
        # app collects was dropped by the pipeline and never reached this renderer at
        # all. `title` remains the fallback so a profile that put its company in that
        # field before this fix keeps rendering exactly as it did.
        row_cells[1].text = (entry.company or entry.title) if entry else ""
        row_cells[2].text = entry.name if entry else ""

        # Clause (b): the signature cell text is EMPTY unconditionally, and
        # NEVER the typed name — set before any image placement, so an
        # exception raised while placing an image cannot leave a stale
        # typed name behind it.
        row_cells[3].text = ""

        # Clause (c): where a signature image was supplied, place it inside
        # the signature cell, scaled to fit the theme's declared row height
        # without changing that height — a signed row and an unsigned row
        # occupy the same space, so pagination never depends on who signed.
        if entry is not None and entry.signature_image is not None:
            _place_signature_image(row_cells[3], entry.signature_image)

        # Set row height to the theme's declared signature box height —
        # AFTER either path, so `w:hRule="atLeast"` plus a scaled-to-fit
        # image is what makes the signed and unsigned rows the same size,
        # rather than the image growing the row past it.
        _set_row_height(table.rows[i + 1], SIGNATURE_BOX_HEIGHT_TWIPS)


def _place_signature_image(cell: object, image_bytes: bytes) -> None:
    """Place a signature image inside a table cell, height-constrained to fit
    within the theme's declared signature row height (Req 13.3).

    Height-constrained rather than width-constrained: the box this cell sits
    in is fixed-**height** (`SIGNATURE_BOX_HEIGHT_TWIPS`, `w:hRule="atLeast"`),
    so the image's height is what must not exceed it — an image scaled only
    by width could still be taller than the box and grow the row, which is
    exactly the coupling Req 13.3 exists to rule out. `python-docx` preserves
    aspect ratio automatically when only one of `width`/`height` is given.
    """
    from docx.shared import Twips

    paragraph = cell.paragraphs[0]  # type: ignore[attr-defined]
    run = paragraph.add_run()
    run.add_picture(
        io.BytesIO(image_bytes),
        height=Twips(SIGNATURE_BOX_HEIGHT_TWIPS),
    )


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
