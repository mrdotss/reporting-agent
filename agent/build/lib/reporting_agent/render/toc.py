"""The table-of-contents approach: the candidate set, and which one was adopted
(Req 14.1, 14.3, 14.10).

This module declares **only** the vocabulary and the decision. The measurement harness
that produced the decision lives in `agent/tests/toc_harness.py`, the evidence it
recorded is committed under `agent/evidence/toc/`, and the emitter — if there is one —
lands in `render/docx.py`. Keeping the decision here, alone, is what lets every later
module *read* it rather than assume a value.

## Why a module constant and not an environment variable

**A table of contents whose correctness was proven in the image build must not be
switchable at run time by a deployment that never ran the proof.**

That is the whole reason, and it is worth being concrete about the failure it rules out.
A page number in a table of contents is a claim about where a heading will land after
Word or LibreOffice has paginated the document — the one thing neither the compiler nor
the HTML emitter can determine, which is why criterion 14.2 demands a proof test over a
real multi-page render rather than a unit test over a field code. An environment variable
would let an operator turn that section on in an image where the proof was never run,
or in an image where it ran and *failed*: the document would then ship a page number that
is not merely unverified but structurally unverifiable, in a product whose entire claim
is that a figure in a delivered document traces to something checkable. A wrong page
number is also the most quietly damaging kind of wrong, because a reader who follows it
to the wrong page concludes the document is sloppy rather than that a number is untrue,
and stops checking the numbers that matter.

So the value is compiled into the image beside the proof that justifies it, and the two
travel together or not at all. **`.env.example` gains nothing in this module's name, in
this task or any other** — there is no variable to add, and adding one would be the
mistake this paragraph exists to prevent.

The corollary, and it is a real cost accepted deliberately: changing the approach is a
code change, a review and a new image, not a redeploy. That is the correct price for a
claim that has to be re-proven whenever it changes.

## The candidates

Three ways to make a table of contents carry true page numbers, evaluated in this order —
cheapest first — and one way to ship no table of contents at all:

* :data:`TOC_APPROACH_LIBREOFFICE_INDEX` — insert a Word `TOC` field with **no cached
  result** and let the `.docx` → `.pdf` conversion resolve it. Cheapest by far: no second
  conversion, no macro, no change to the conversion filter.
* :data:`TOC_APPROACH_TWO_PASS` — emit the section at full size with no numbers, convert,
  measure which page each heading landed on, re-emit with those numbers as literal text,
  convert again. Correct only if the measurement is a **fixed point**: the second pass's
  own pagination must agree with the first's, or the numbers describe a document that no
  longer exists. It also doubles the LibreOffice conversion, which is why adopting it is
  the one candidate that moves the `rendering` phase budget.
* :data:`TOC_APPROACH_CONVERSION_MACRO` — drive `updateIndexes()` through `soffice`'s
  scripting interface before export.
* :data:`TOC_APPROACH_NONE` — **ship no table of contents.** Criterion 14.3's stated
  outcome when no candidate is `correct`, and not a gap: the document is cover →
  document control → content, `front_matter.toc` is retained in the definition exactly
  as a disabled cover is retained, and `verification.counts.toc_entries_checked` is `0`.
  A section that cannot state a true page number is worth less than no section.

:data:`ADOPTED_APPROACH` is the first candidate the evaluation recorded a `correct` verdict
for. It is **not** a placeholder to be optimistically overwritten: a `none` value is a
shippable outcome, so a reader cannot tell "not yet evaluated" from "evaluated and nothing
worked" by looking at this value — that is what `agent/evidence/toc/evaluation.json` is for,
and why the evidence record carries all three verdicts regardless of which one was adopted.

## Nothing else may spell these strings

`tests/test_boundaries.py`'s rule 12 fails on any of the four literals appearing outside
this module. A second declaration is the ordinary way this kind of constant rots: a
comparison written as `== "two_pass_measure"` keeps passing after the constant it was
meant to track is renamed, and the branch silently stops being taken. Every later
consumer imports the name.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

__all__ = [
    "ADOPTED_APPROACH",
    "TOC_APPROACHES",
    "TOC_APPROACH_CONVERSION_MACRO",
    "TOC_APPROACH_LIBREOFFICE_INDEX",
    "TOC_APPROACH_NONE",
    "TOC_APPROACH_TWO_PASS",
    "TOC_HEADING_STYLES",
    "TOC_LABEL_ID",
    "apply_toc_page_numbers",
    "heading_anchor",
    "heading_bookmark",
    "named_destination_pages",
    "section_numbers",
    "should_emit_toc",
    "toc_entries_from_document",
    "toc_heading_text",
]

# --- the candidate set (Req 14.1) ----------------------------------------------------
#
# Four `Final[str]` constants rather than a `StrEnum`, matching `collect/log.py`'s
# `GAP_TYPE_*` and `catalog/loader.py`'s `CATALOG_ENTRY_INVALID_GAP_TYPE`: the value is
# written into `evidence/toc/evaluation.json` as a JSON string and read back out of it,
# and a plain `str` crosses that boundary with no enum-to-string conversion on either
# side.

TOC_APPROACH_LIBREOFFICE_INDEX: Final[str] = "libreoffice_index_update"
TOC_APPROACH_TWO_PASS: Final[str] = "two_pass_measure"
TOC_APPROACH_CONVERSION_MACRO: Final[str] = "conversion_macro"
TOC_APPROACH_NONE: Final[str] = "none"

TOC_APPROACHES: Final[tuple[str, ...]] = (
    TOC_APPROACH_LIBREOFFICE_INDEX,
    TOC_APPROACH_TWO_PASS,
    TOC_APPROACH_CONVERSION_MACRO,
    TOC_APPROACH_NONE,
)
"""Exactly the four approaches, in the order they are evaluated — cheapest first, with
`none` last because it is the outcome rather than a candidate. A `tuple`, so the
evaluation iterates a declared order and two runs try them in the same sequence."""

assert len(TOC_APPROACHES) == 4
assert len(set(TOC_APPROACHES)) == len(TOC_APPROACHES)

# --- the decision (Req 14.3, 14.10) -------------------------------------------------

ADOPTED_APPROACH: Final[str] = TOC_APPROACH_TWO_PASS
"""The approach this image ships, and the value every front-matter module reads.

Set to the first candidate the evaluation recorded a `correct` verdict for, or left at
:data:`TOC_APPROACH_NONE`. See the module docstring on why this is a module constant and
not an environment variable, and why `none` is a shippable value rather than a
placeholder.

## What the evaluation found (`agent/evidence/toc/evaluation.json`)

Measured over `agent/tests/fixtures/toc/long_report.*` — a 12-page document with six
`Heading 1` sections on six distinct pages — under **LibreOffice 26.2.4.2**. All three
verdicts are in the record; these are the two that were rejected and why:

* :data:`TOC_APPROACH_LIBREOFFICE_INDEX` — **`incorrect`.** The field was emitted exactly as
  criterion 14.1 specifies, `TOC \\o "1-3" \\h \\z \\u` with no `separate` and therefore no
  cached result, and `w:dirty="true"`. The conversion **did not resolve it**: the contents
  page came back carrying its heading and nothing else, so the document named no page for any
  of the six headings. Note which way that failed — not a stale cached number, which the
  no-cached-result shape rules out, but no number at all. Cheap and silent, which is why it
  was worth measuring first and why it could not be adopted on the assumption that it worked.
* :data:`TOC_APPROACH_CONVERSION_MACRO` — **`unavailable`.** Addressing `updateIndexes()`
  needs a Basic macro in the profile's `user/basic/Standard/Module1.xba`, and LibreOffice
  warms that library **empty**. Installing the macro is a write into the profile the image
  builds at build time, and installing it at run time needs a second `soffice` invocation
  contending on that same single profile — criterion 14.3 rejects both. Recorded as
  `unavailable` rather than `incorrect` on purpose: the mechanism was never exercised, so
  nothing here says whether it would have produced right or wrong numbers.

:data:`TOC_APPROACH_TWO_PASS` is `correct`: every one of the six headings is named on the page
it landed on, across six distinct pages of the 13-page document (the contents section adds
one). The fixed point holds — `named_pages` **is** pass 1's measurement and `observed_pages`
is pass 2's pagination, so their equality is the fixed-point test rather than a separate
check — and it held on three consecutive runs.

**Adopting this one has a consequence outside this module**, and it is task 2.5's whole
content: the two-pass approach performs **two** LibreOffice conversions, each bounded at
300s, so `app/lib/runs/state.ts`'s `PHASE_DEADLINE_SECONDS.rendering` has to rise from 600 to
900. A deadline that did not move would time out a rendering phase that is behaving
correctly."""

assert ADOPTED_APPROACH in TOC_APPROACHES



# --- the builder (Req 14.3, 14.4, 14.5, 14.11) ------------------------------------
#
# Emits a table of contents ONLY where ADOPTED_APPROACH names a candidate the evaluation
# recorded `correct`. Where it is `none`, emits NO table of contents at all and no
# page-number position anywhere.

# Heading styles eligible for the TOC: levels 1 through 3 only (Req 14.11).
TOC_HEADING_STYLES: Final[frozenset[str]] = frozenset(
    {"Heading 1", "Heading 2", "Heading 3"}
)

TOC_LABEL_ID: Final[str] = "doc.front_matter.toc_heading"
"""The string id for the TOC section heading, resolved through the message catalog."""



# --- section numbers and anchors, for the styled reading copy only -------------------


def heading_anchor(ordinal: int) -> str:
    """The id a heading carries in the styled reading copy, from its 1-based position
    among the headings the contents lists.

    Derived from the ordinal rather than from the heading's text, which is not unique —
    a per-machine section repeats "Network addressing" once per machine — and rather than
    from the AST path, which would have to be threaded through `FrontMatterContents` and
    is not otherwise wanted there. Both walks that need it (the contents, and the body
    emitter) traverse `document.blocks` in order under the same predicate, so counting
    independently produces the same ordinal for the same heading.
    """
    return f"rpt-heading-{ordinal}"


def heading_bookmark(ordinal: int) -> str:
    """The Word bookmark on a heading, and the link target of its contents entry.

    The same ordinal as :func:`heading_anchor`, so the `.docx` and the reading copy agree
    about which heading is the third. Two jobs, one name: the contents entry is a
    hyperlink to it, so it is clickable in Word and in the converted PDF, and LibreOffice
    exports it as a **named destination** on the page the heading actually landed on —
    which is how pass 2 reads a heading's page without searching text for it.

    No leading underscore, although Word hides bookmarks that start with one: LibreOffice
    escapes the underscore in the destination's name (`#5F`), and a name that survives the
    round trip unchanged is worth more than one hidden from Word's bookmark list.
    """
    return f"RptToc{ordinal}"


def toc_heading_text(block: object) -> str | None:
    """A top-level block's contents entry text, or `None` when it has none.

    The one predicate both walks use — the contents builder and the `.docx` emitter that
    bookmarks the headings — so they count the same headings in the same order and the
    third entry links to the third bookmark. Two copies of this test would be two chances
    for the counts to drift apart, and a drift sends every later link to the wrong page.
    """
    from reporting_agent.compile.ast import Figure, Paragraph, Text

    if not isinstance(block, Paragraph) or block.style not in TOC_HEADING_STYLES:
        return None
    parts: list[str] = []
    for inline in block.inlines:
        if isinstance(inline, Text):
            parts.append(inline.text)
        elif isinstance(inline, Figure):
            parts.append(inline.formatted or "")
    text = "".join(parts).strip()
    return text or None


def named_destination_pages(pdf_bytes: bytes) -> dict[str, int]:
    """Every named destination in a PDF, with the 1-based page it points at.

    The converter writes one per Word bookmark (see `render/pdf.py`), placed where the
    bookmarked heading was laid out. Reading them is exact where searching page text for a
    heading is not: a heading that repeats ("Inbound", once per security group) or that a
    table printed earlier (a machine's name in the inventory) sends a text search to the
    wrong page.
    """
    import io

    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        destinations = reader.named_destinations
    except Exception:
        # An unreadable PDF names no destination; each entry then falls back to text.
        return {}
    pages: dict[str, int] = {}
    for name, destination in destinations.items():
        try:
            pages[str(name).lstrip("/")] = reader.get_destination_page_number(destination) + 1
        except Exception:
            # One broken destination does not void the rest.
            continue
    return pages


def section_numbers(levels: Sequence[int]) -> tuple[str, ...]:
    """Hierarchical section numbers for a sequence of heading levels.

    `[1, 1, 2, 2, 1]` numbers as `1, 2, 2.1, 2.2, 3`, which is what `ReportA.dc.html`'s
    contents page shows. Pure over the level sequence, so the numbers are the same on
    every run over one document and can be computed independently wherever they are needed.

    A level that jumps deeper by more than one — a `Heading 3` directly under a
    `Heading 1`, which the compiler does not emit but a hand-written definition could —
    opens the intermediate counters at zero rather than raising, so a malformed outline
    produces `1.0.1` and a readable contents page instead of a failed render.

    ## Why these do not reach the `.docx`

    `verify/allowlist.py::derive_allowlist` renders the document under a **null context**
    and treats the numeric tokens it finds as the document's static chrome; anything
    numeric in the real render that the null render did not produce fails the prose gate.
    A section that expands per resource emits no sub-headings under a null context and
    several under real data, so `8.1`–`8.7` would exist in the delivered document and in
    no allowlist — and a correct report would be withheld for its own contents page.

    The styled reading copy has no prose gate, so the numbers live there: `render/html.py`
    prints them and `render/docx.py` does not.
    """
    counters: list[int] = []
    numbers: list[str] = []
    for level in levels:
        depth = max(1, level)
        if depth > len(counters):
            counters.extend([0] * (depth - len(counters)))
        else:
            del counters[depth:]
        counters[depth - 1] += 1
        numbers.append(".".join(str(count) for count in counters))
    return tuple(numbers)


def should_emit_toc() -> bool:
    """Whether a table of contents should be emitted (Req 14.3).

    True only where ADOPTED_APPROACH names a candidate whose evaluation verdict was
    ``correct``. Where it is ``none``, no TOC is emitted at all.
    """
    return ADOPTED_APPROACH != TOC_APPROACH_NONE


def toc_entries_from_document(document: object) -> tuple[tuple[str, int], ...]:
    """Extract heading entries from a compiled Document for the TOC (Req 14.5, 14.11).

    Returns a tuple of ``(heading_text, level)`` pairs in document order, for headings
    at levels 1 through 3 only.  Deeper headings are excluded.

    ``level`` is 1, 2 or 3 corresponding to ``Heading 1``, ``Heading 2``, ``Heading 3``.
    """
    from reporting_agent.compile.ast import Document as CompiledDocument

    if not isinstance(document, CompiledDocument):
        return ()

    _LEVEL_MAP = {"Heading 1": 1, "Heading 2": 2, "Heading 3": 3}
    entries: list[tuple[str, int]] = []

    for block in document.blocks:
        heading_text = toc_heading_text(block)
        if heading_text is not None:
            entries.append((heading_text, _LEVEL_MAP[block.style]))  # type: ignore[attr-defined]

    return tuple(entries)



# --- the two-pass production builder (Req 14.3, 14.4, 14.5) -----------------------

def apply_toc_page_numbers(
    docx_bytes: bytes,
    *,
    headings: tuple[str, ...],
) -> tuple[bytes, bytes]:
    """Two-pass TOC page-number resolution (Req 14.3, 14.4, 14.5).

    Takes the rendered ``.docx`` bytes — which already carry the TOC section from
    ``emit_front_matter`` with headings but no page numbers — and applies the two-pass
    approach that the evaluation recorded as ``correct``:

    1. Convert pass 1 to PDF and measure which page each heading landed on.
    2. Re-emit the TOC entries with those measured numbers as literal text.
    3. Convert again — this is pass 2, whose PDF is the artifact.

    Returns ``(final_docx_bytes, final_pdf_bytes)``.

    Raises :class:`~reporting_agent.errors.RenderFailedError` if the approach is ``none``
    (the caller should check :func:`should_emit_toc` first).

    ## How a heading's page is measured

    From the **bookmark** the `.docx` emitter put on the heading and the contents entry
    links to (:func:`heading_bookmark`): the conversion exports each bookmark as a named
    destination on the page where it was laid out, and :func:`named_destination_pages`
    reads them back. This replaced a search of the page text for the heading's words,
    which returned the first page carrying those words anywhere — so "Inbound", repeated
    once per security group, and a machine's name, printed in the inventory table long
    before its own section, were numbered with a page they merely appeared on.

    `headings` remains for an entry that carries no link target, which falls back to that
    text search: a document emitted before the entries were links.
    """
    import io

    from reporting_agent.render.pdf import convert_to_pdf
    from reporting_agent.render.themes import TOC_ENTRY_STYLE
    from reporting_agent.verify.tokens import pdf_page_texts

    if ADOPTED_APPROACH == TOC_APPROACH_NONE:
        from reporting_agent.errors import RenderFailedError
        raise RenderFailedError(
            "apply_toc_page_numbers called but ADOPTED_APPROACH is 'none'; "
            "the caller must check should_emit_toc() first"
        )

    # --- Pass 1: convert the document with empty page-number positions ---------------
    pass1_pdf = convert_to_pdf(docx_bytes)

    # Where each heading landed, read from the bookmark destinations the conversion wrote.
    # Exact, and indifferent to a heading's words appearing anywhere else in the document.
    destinations = named_destination_pages(pass1_pdf.pdf_bytes)

    # The text measurement, only for an entry that carries no link target — a document
    # emitted before the entries were links. Computed once, and only if needed.
    text_measured: dict[str, int] | None = None

    def measured_by_text() -> dict[str, int]:
        nonlocal text_measured
        if text_measured is None:
            import tempfile

            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tmp:
                tmp.write(pass1_pdf.pdf_bytes)
                tmp.flush()
                pages = pdf_page_texts(tmp.name)
            toc_page_indices = _identify_toc_pages(pages, headings)
            text_measured = {}
            for heading in headings:
                page = _find_heading_page(pages, heading, toc_page_indices)
                if page is not None:
                    text_measured[heading] = page
        return text_measured

    # --- Pass 2: re-emit the TOC section with measured page numbers ------------------
    from docx import Document as open_docx_cls

    document = open_docx_cls(io.BytesIO(docx_bytes))
    body = document.element.body

    from docx.oxml.ns import qn
    w_p = qn("w:p")
    w_ppr = qn("w:pPr")
    w_pstyle = qn("w:pStyle")
    w_val = qn("w:val")
    w_hyperlink = qn("w:hyperlink")
    w_anchor = qn("w:anchor")

    # The **styleId** of the TOC entry style, resolved from the document's own styles.
    # `TOC_ENTRY_STYLE` is a display *name* ("Toc Entry") — the value `w:pStyle/@w:val`
    # carries is the styleId ("TocEntry"; OOXML strips the space). Comparing the two
    # directly matched nothing, so pass 2 walked every paragraph, recognised no TOC entry,
    # and returned the document unchanged — the page numbers were silently never written.
    # Invisible until `emit_front_matter` was wired in and something finally emitted a TOC.
    toc_entry_style_id = TOC_ENTRY_STYLE
    for style in document.styles:
        if getattr(style, "name", None) == TOC_ENTRY_STYLE:
            resolved = getattr(style, "style_id", None)
            if isinstance(resolved, str) and resolved:
                toc_entry_style_id = resolved
            break

    for p_element in body.iter(w_p):
        ppr = p_element.find(w_ppr)
        if ppr is None:
            continue
        pstyle = ppr.find(w_pstyle)
        if pstyle is None or pstyle.get(w_val, "") != toc_entry_style_id:
            continue

        # The entry's runs sit inside its hyperlink where it has one.
        hyperlink = p_element.find(w_hyperlink)
        holder = hyperlink if hyperlink is not None else p_element
        anchor = hyperlink.get(w_anchor) if hyperlink is not None else None

        page = destinations.get(anchor) if anchor else None
        if page is None:
            page = measured_by_text().get(_entry_text(holder))
        if page is not None:
            _write_page_number(holder, page)

    buffer = io.BytesIO()
    document.save(buffer)
    final_docx_bytes = buffer.getvalue()

    # Convert pass 2
    pass2_pdf = convert_to_pdf(final_docx_bytes)

    return final_docx_bytes, pass2_pdf.pdf_bytes


def _entry_text(holder: object) -> str:
    """A contents entry's heading text: its runs up to the tab."""
    from docx.oxml.ns import qn

    parts: list[str] = []
    for run in holder.findall(qn("w:r")):  # type: ignore[attr-defined]
        if run.find(qn("w:tab")) is not None:
            break
        for text in run.findall(qn("w:t")):
            if text.text:
                parts.append(text.text)
    return "".join(parts).strip()


def _write_page_number(holder: object, page: int) -> None:
    """Put `page` in the run after the entry's tab, creating that run if there is none.

    Written inside the hyperlink when the entry has one, so the number is part of the link
    and clicking either the heading or its page goes to the same place.
    """
    from docx.oxml.ns import qn
    from lxml import etree

    tab_found = False
    for run in holder.findall(qn("w:r")):  # type: ignore[attr-defined]
        if run.find(qn("w:tab")) is not None:
            tab_found = True
            continue
        if tab_found:
            for text in run.findall(qn("w:t")):
                text.text = str(page)
            return
    if tab_found:
        run = etree.SubElement(holder, qn("w:r"))
        etree.SubElement(run, qn("w:t")).text = str(page)


def _identify_toc_pages(
    pages: tuple[str, ...], headings: tuple[str, ...]
) -> frozenset[int]:
    """Identify 0-based page indices that are the TOC section.

    A TOC page is one where at least two headings appear **followed by a leader run** —
    the dots or tabs a TOC entry's tab stop renders as. Content pages are excluded by
    that requirement, because a heading in the body is followed by prose.

    ## Why the leader run is load-bearing

    This used to test `heading in page_text` with a count of two, which misclassified any
    content page carrying two headings as part of the TOC. Those pages were then skipped
    by :func:`_find_heading_page`, so a heading that appeared only on skipped pages
    measured as ``None`` and pass 2 wrote it no page number at all. On a document with
    short sections that is most headings: the observed symptom was a TOC where only the
    last entry carried a number, which then failed the verifier's own TOC identification
    (it needs two numbered entries) and left the one number that *was* written unmasked,
    failing the run on `unmatched_prose_token`.

    Numbers are deliberately **not** required here, unlike the verifier's
    `verify/toc.py::_toc_page_indices`: this runs on pass-1 output, which is exactly the
    state where the entries have leaders and no numbers yet.
    """
    import re

    indices: set[int] = set()
    for index, page_text in enumerate(pages):
        count = 0
        for heading in headings:
            # Heading, then a run of leader glyphs — dots, tabs, ellipses, or the
            # non-breaking spaces some converters emit inside a tab stop.
            if re.search(
                re.escape(heading) + r"[.\t\u2026\u00a0]{3,}", page_text
            ):
                count += 1
        if count >= 2:
            indices.add(index)
    return frozenset(indices)


def _find_heading_page(
    pages: tuple[str, ...], text: str, toc_page_indices: frozenset[int]
) -> int | None:
    """The 1-based page carrying text's first rendered character, skipping TOC pages."""
    for index, page_text in enumerate(pages):
        if index in toc_page_indices:
            continue
        if text in page_text:
            return index + 1
    # Prefix fallback for page-straddling headings.
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
