"""The print stylesheet, generated from the theme the profile selected.

The styled PDF is rendered from `render/html.py`'s output by WeasyPrint. That output is a
**fragment** carrying semantic classes and `data-style` attributes; this turns the theme
into the CSS those hooks resolve against, so a `corporate` report's styled PDF is navy for
the same reason its `.docx` is.

## Generated rather than written

A static stylesheet would be a fifth theme — a set of faces, sizes and colours that
somebody would have to keep level with `THEME_SPECS`' four, and would not. Every value
here reads off the same `ThemeSpec` that builds the `.docx` theme documents, so a change to
a preset reaches both outputs or neither.

## What CSS gets to decide, and what it does not

Pagination, running headers, page numbers and column widths are the stylesheet's, because
they are presentation and WeasyPrint measures text properly — which is the whole reason
this path exists rather than a second round of guessing at LibreOffice's column arithmetic.

Content is not. Not a number, not a label, not an order: those came out of the compiler and
are identical in both outputs. `content:` appears here only for page numbers and the
running section title, neither of which any emitter can know.
"""

from __future__ import annotations

from typing import Final

__all__ = ["PAGE_SIZES", "stylesheet"]

PAGE_SIZES: Final[dict[str, str]] = {"A4": "A4", "Letter": "Letter"}
"""The `@page size` for each page size the definition admits, named as CSS names them.

Deliberately a mapping rather than a pass-through: `design.page_size` is validated against
the definition's vocabulary, and a value CSS does not recognise would silently fall back to
the initial page size rather than failing, so an unrecognised one must not reach `size:`.
"""


def stylesheet(preset: str, *, page_size: str = "A4") -> str:
    """The print stylesheet for one theme.

    Raises nothing for an unknown preset — falls back to `editorial`, the definition
    schema's own default — because a styled PDF is a second copy of a document that
    rendered successfully, and refusing to style it would withhold an artifact over a
    presentation decision.
    """
    from reporting_agent.render.themes import THEME_SPECS

    spec = THEME_SPECS.get(preset) or THEME_SPECS["editorial"]
    palette = spec.palette
    size = PAGE_SIZES.get(page_size, "A4")
    h1, h2, h3, h4 = spec.heading_pt
    caps = "uppercase" if spec.heading_all_caps else "none"
    band = f"#{palette.band}" if spec.banded_rows else "transparent"

    small = spec.small_pt
    return f"""
:root {{
  --accent: #{palette.accent};
  --ink: #{palette.ink};
  --muted: #{palette.muted};
  --rule: #{palette.rule};
  --band: {band};
  --body-face: "{spec.face.body}", serif;
  --heading-face: "{spec.face.heading}", sans-serif;
  --figure-face: "{spec.face.figure}", monospace;
}}

/* --- the page ------------------------------------------------------------
   `design/proposed/ReportA.dc.html` puts a running head over a hairline at the top of
   every page and the page number alone at the bottom right, in the figure face.
   Nothing else is furniture. */
@page {{
  size: {size};
  margin: 17mm 16mm 14mm 16mm;

  @top-left {{
    content: string(running-head);
    font-family: var(--heading-face);
    font-size: {small - 1}pt;
    font-weight: 700;
    color: var(--muted);
    vertical-align: bottom;
    border-bottom: 0.5pt solid var(--rule);
    width: 100%;
    padding-bottom: 4pt;
  }}
  @bottom-right {{
    content: counter(page);
    font-family: var(--figure-face);
    font-size: {small - 1.5}pt;
    color: var(--muted);
    vertical-align: top;
    padding-top: 6pt;
  }}
}}

/* The cover carries no apparatus — there is no section yet, and a page number on a
   cover is furniture nobody reads. It carries the accent band instead. */
@page :first {{
  @top-left {{ content: none; border-bottom: none; }}
  @bottom-right {{ content: none; }}
  border-top: 4pt solid var(--accent);
}}

body {{
  margin: 0;
  font-family: var(--body-face);
  font-size: {spec.body_pt}pt;
  line-height: 1.65;
  color: var(--ink);
}}

p {{ margin: 0 0 1em; }}

/* --- headings ------------------------------------------------------------
   The section's own name becomes the running head, captured with `string-set` so the
   words stay the emitter's. The short accent rule under a heading is the design's one
   piece of ornament and what makes a section start read as a start. */
h1, h2, h3, h4 {{
  font-family: var(--heading-face);
  color: var(--ink);
  font-weight: 700;
  letter-spacing: -0.01em;
  break-after: avoid;
  margin: 1.6em 0 0.15em;
  string-set: running-head content();
}}
h1 {{ font-size: {h1}pt; }}
h2 {{ font-size: {h2}pt; }}
h3 {{ font-size: {h3}pt; text-transform: {caps}; margin: 1.3em 0 0.5em; }}
h4 {{ font-size: {h4}pt; text-transform: {caps}; margin: 1.2em 0 0.4em; }}

h1::after, h2::after {{
  content: "";
  display: block;
  width: 9mm;
  height: 1.6pt;
  background: var(--accent);
  margin: 6pt 0 10pt;
}}

/* --- front matter --------------------------------------------------------- */

[data-style="Cover Title"] {{
  font-family: var(--heading-face);
  font-size: {spec.title_pt}pt;
  color: var(--ink);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin: 0 0 0.15em;
}}
[data-style="Cover Meta"] {{
  font-family: var(--heading-face);
  font-size: {small}pt;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 10pt 0 20mm;
}}
/* The document-control page's own title, and then its subsections. `ReportA.dc.html`
   sets the first as the page heading with the accent rule under it and the rest as
   `h3.ss` — small, bold, tight. Both arrive with the same style name, so the later
   siblings are what separates them. */
[data-style="Document Control"] {{
  font-family: var(--heading-face);
  font-size: {h2}pt;
  font-weight: 700;
  color: var(--ink);
  margin: 0 0 0.15em;
}}
[data-style="Document Control"]::after {{
  content: "";
  display: block;
  width: 9mm;
  height: 1.6pt;
  background: var(--accent);
  margin: 6pt 0 10pt;
}}
[data-style="Document Control"] ~ [data-style="Document Control"] {{
  font-size: {h4}pt;
  margin: 1.4em 0 0.4em;
}}
[data-style="Document Control"] ~ [data-style="Document Control"]::after {{
  content: none;
}}
[data-style="Title"] {{
  font-family: var(--heading-face);
  font-size: {h2}pt;
  font-weight: 700;
  color: var(--ink);
  margin: 0 0 0.6em;
}}

.rpt-note {{ color: var(--muted); font-size: {small}pt; }}

/* --- tables ---------------------------------------------------------------
   Boxed cells with a shaded header, from `ReportA.dc.html`'s `table.d`. Full rules
   rather than horizontal hairlines: these are dense inventory grids read down a column
   as often as across a row, and a reader tracking `Private IP` down twenty machines
   needs that column to have an edge. */
.rpt-pairs,
.rpt-grid,
table.rpt-table {{
  /* Every column's width is declared by the emitter's `<colgroup>`, from the same
     `render/tablefit.py` allocation the `.docx` sizes its columns with — so `fixed`
     here is not "equal columns", it is "the columns the document already agreed on".

     `auto` sizes a column to its widest content, and a cell holding an ARM resource id
     is one unbreakable token past a hundred characters: the column grew to fit it and
     the Public IP table ran off the right edge of the page. Under `fixed` the column is
     bounded and `overflow-wrap: break-word` below can do its job. */
  table-layout: fixed;
  width: 100%;
  border-collapse: collapse;
  margin: 0.4em 0 0.9em;
  font-size: {small}pt;
}}
thead {{ display: table-header-group; }}
tr {{ break-inside: avoid; }}

.rpt-grid th,
table.rpt-table th {{
  background: var(--band);
  border: 0.5pt solid var(--rule);
  font-family: var(--heading-face);
  font-size: {small - 0.5}pt;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--ink);
  text-align: left;
  padding: 3.5pt 5pt;
  vertical-align: bottom;
  overflow-wrap: normal;
  hyphens: none;
}}
.rpt-grid td,
table.rpt-table td {{
  border: 0.5pt solid var(--rule);
  padding: 3.5pt 5pt;
  vertical-align: top;
  color: var(--ink);
  /* `anywhere`, and only because the column widths are now **declared**.
     `anywhere` lets the engine consider a break inside a word when computing a column's
     minimum width, which under `table-layout: auto` squeezed a column of
     `metric_not_selected` to `metri c_no t_sel ected` — the reason this said
     `break-word` before. Under `fixed` no column is sized from its content, so that
     cost is gone, and `break-word` is not enough on its own: it declines to break a
     token with no break opportunity of its own, which is exactly what an ARM resource
     id is. */
  overflow-wrap: anywhere;
}}

/* A label/value block on the document-control page is a boxed grid with a key column,
   at `ReportA.dc.html`'s 32%: label weighted, value inked. */
.rpt-pairs th {{
  width: 32%;
  background: transparent;
  border: 0.5pt solid var(--rule);
  text-align: left;
  font-family: var(--heading-face);
  font-weight: 700;
  font-size: {small}pt;
  letter-spacing: 0;
  text-transform: none;
  color: var(--ink);
  padding: 3.5pt 5pt;
  vertical-align: top;
}}
.rpt-pairs td {{
  border: 0.5pt solid var(--rule);
  padding: 3.5pt 5pt;
  vertical-align: top;
  color: var(--ink);
}}

/* The cover's own facts are not that grid. `ReportA.dc.html` sets them borderless under
   a hairline, the label muted and the value carrying the weight — a title block, not a
   table of record. It is the first such block in the front matter, which is what
   distinguishes it: nothing in the markup says "cover", and nothing should, because the
   cover is a position rather than a kind. */
.rpt-front-matter > .rpt-pairs:first-of-type {{
  border-top: 0.5pt solid var(--rule);
  margin-top: 14pt;
  padding-top: 10pt;
}}
.rpt-front-matter > .rpt-pairs:first-of-type th,
.rpt-front-matter > .rpt-pairs:first-of-type td {{
  border: 0;
  padding: 3pt 22pt 3pt 0;
}}
.rpt-front-matter > .rpt-pairs:first-of-type th {{
  font-family: var(--body-face);
  font-weight: 400;
  color: var(--muted);
  width: 34%;
}}
.rpt-front-matter > .rpt-pairs:first-of-type td {{
  font-weight: 700;
  padding-right: 0;
}}

/* A body table whose first column is keyed `field` is a **profile**, not a data table:
   the subscription's own id and counts, or one machine's size, OS and resource group.
   `ReportA.dc.html` sets those with a weighted key column at 32% and the value inked
   beside it, which is the same treatment the document-control page's pairs get — the
   two are the same object at different places in the document.

   Selected on `data-column-key` rather than on a class, because the class would have to
   come from the AST and the AST deliberately does not carry presentation. The emitter
   already writes each cell's column key (`render/html.py`), which is the table's own
   vocabulary, and `field`/`value` is what `compile/blocks/tables.py`'s two pairs
   builders name their columns. A plain attribute selector, not `:has()` — WeasyPrint's
   support for that is untested here and this renders in a container this host cannot
   run. */
table.rpt-table th[data-column-key="field"],
table.rpt-table td[data-column-key="field"] {{
  width: 32%;
  background: transparent;
  font-family: var(--heading-face);
  font-weight: 700;
  color: var(--ink);
  text-align: left;
  letter-spacing: 0;
  text-transform: none;
}}
table.rpt-table td[data-column-key="value"] {{
  color: var(--ink);
}}

/* A rollup's count column is a quantity and reads right-aligned, like every other
   figure column. `ReportA.dc.html` sets `Resources` that way beside the group name. */
table.rpt-table th[data-column-key="count"],
table.rpt-table td[data-column-key="count"] {{
  text-align: right;
}}

/* The logo's reserved block. The emitter carries its own height and width inline, so
   this only has to stop the box collapsing and keep it out of the text flow's baseline —
   an empty div with no content is otherwise zero-height whatever its `height` says. */
.rpt-logo {{
  display: block;
  margin: 0 0 18pt;
}}

/* Req 13.6 clause (b) — a ruled box to sign, never the typed name. */
.rpt-signature {{ height: 13mm; min-width: 40mm; }}

/* Every cell ends with a zero-width space, and this is load-bearing rather than
   decorative.

   `verify/pdf.py::is_located` refuses a match whose neighbouring character continues a
   number, which is what stops `1.5` being found inside `21.53`. Judging that needs the
   extracted text to preserve cell boundaries, and pypdf's extraction of WeasyPrint's
   output does not: adjacent cells arrive welded together, so a real July run produced

       '0.25% (p95, est. from hourly averages)79.88%'
       '2026-07-020.22%'

   and the gate correctly concluded, of sixty figures that were plainly on the page, that
   each was part of a longer numeral. The reading copy was suppressed over a document with
   nothing wrong with it.

   Nothing recoverable fixes that from the outside. A visitor over pypdf's positioned runs
   recovers some boundaries and not others; `extraction_mode="layout"` halves the count and
   no more; and no adjacency rule can tell a lost cell boundary from an embedded numeral,
   because the neighbour may be an ordinary date rather than another figure. So the
   document states its own boundaries instead.

   U+200B specifically. A normal space and a non-breaking space are both trimmed at the end
   of a cell's line box and never reach the content stream — measured, both leave all sixty
   findings standing. A zero-width space is not whitespace, so it is not trimmed; it is
   emitted, it costs no width, and `_continues` reads it as ending a number. Sixty findings
   to zero.

   It is presentation, which is why it lives here: the emitters put no character in the
   document that came from neither the snapshot nor the template, and this stylesheet is
   not an emitter. */
table.rpt-table td::after,
table.rpt-table th::after,
.rpt-grid td::after,
.rpt-grid th::after,
.rpt-pairs th::after,
.rpt-pairs td::after {{ content: "\\200b"; }}

/* --- figures ---------------------------------------------------------------
   Tabular and right-aligned, so a column of numbers lines up on its digits and a
   reader can compare magnitudes down it without reading any of them. */
.rpt-figure {{
  font-family: var(--figure-face);
  font-size: {small - 0.5}pt;
  font-variant-numeric: tabular-nums;
  /* A figure must never be broken across lines: `verify/pdf.py` searches the converted
     text for the ledger string contiguously, and a line break through a numeral reads as
     a figure that never arrived. This is the CSS statement of what cost two production
     runs to establish in Word. */
  white-space: nowrap;
}}

/* A text fact wears `.rpt-figure` too, so the app's provenance reveal is one interaction
   over both — see `render/html.py::text_fact`. The `nowrap` above must not follow it
   here. That rule exists because `verify/pdf.py` searches for a **figure's** formatted
   string contiguously, and both PDF gates read `ledger.entries`, which holds figures
   alone; a fact is checked by `verify/facts.py` against the `.docx` instead.

   Under `nowrap` an ARM resource id is one unbreakable 130-character token, and it ran
   off the right edge of the Public IP table rather than wrapping inside its column. */
.rpt-fact {{
  white-space: normal;
  overflow-wrap: anywhere;
}}
/* Numbers right, text left. The `:not(.rpt-fact)` is the same distinction `nowrap`
   needs: a column of figures lines up on its digits, and a text fact — an ARM id, a SKU
   name, `Static` — is prose that happens to be checked, and reads left like prose.
   `ReportB.dc.html` sets its per-machine detail values that way. */
table.rpt-table td:has(> .rpt-figure:not(.rpt-fact)),
.rpt-grid td:has(> .rpt-figure:not(.rpt-fact)) {{ text-align: right; }}

caption {{
  caption-side: bottom;
  text-align: left;
  font-family: var(--body-face);
  font-size: {small - 1}pt;
  color: var(--muted);
  line-height: 1.5;
  padding-top: 4pt;
}}
.rpt-notice {{ color: var(--muted); font-style: italic; }}

/* --- contents -------------------------------------------------------------- */

.rpt-toc {{ margin: 0.5em 0 0; }}
.rpt-toc-list {{ list-style: none; padding: 0; margin: 0; }}
/* Weighted at the top level, indented and muted below it, and no rules between —
   `ReportA.dc.html`'s contents is a hierarchy, and a rule under every line flattens one
   into a list. */
.rpt-toc-entry {{
  padding: 3.5pt 0;
  font-size: {spec.body_pt - 0.5}pt;
  font-weight: 700;
  color: var(--ink);
}}
.rpt-toc-entry[data-level="2"] {{
  padding: 2.5pt 0 2.5pt 7mm;
  font-weight: 400;
  color: var(--muted);
}}
.rpt-toc-entry[data-level="3"] {{
  padding: 2.5pt 0 2.5pt 14mm;
  font-weight: 400;
  color: var(--muted);
}}

/* --- charts ---------------------------------------------------------------- */

.rpt-chart {{ margin: 0.7em 0 1em; break-inside: avoid; }}
.rpt-chart svg {{ width: 100%; height: auto; }}
.rpt-chart figcaption {{
  font-family: var(--body-face);
  font-size: {small - 1}pt;
  color: var(--muted);
  line-height: 1.5;
  margin-top: 4pt;
}}
/* The series and points are the app's data. The PDF has the drawing. */
.rpt-chart .rpt-series-set {{ display: none; }}

hr.rpt-break {{ border: 0; margin: 0; break-after: page; }}
"""

# ---------------------------------------------------------------------------
# Build-time guard
# ---------------------------------------------------------------------------


def _assert_cell_boundaries_survive() -> None:
    """Render a table and require the fidelity gate to locate every figure in it.

    `verify/pdf.py::is_located` refuses a match whose neighbour continues a number, which is
    what stops `1.5` being found inside `21.53`. pypdf's extraction of WeasyPrint's output
    does not preserve cell boundaries, so a real July run produced `2026-07-020.22%` and
    `...averages)79.88%`, and the gate concluded — of sixty figures plainly on the page —
    that each was part of a longer numeral. A correct document had its reading copy
    suppressed. :func:`stylesheet` ends every cell with a zero-width space to state the
    boundary the extractor cannot see, and this is what holds that true.

    **Four columns and ten rows, with a grouped byte count among them**, because that is
    where the welding starts. A two-column table extracts cleanly with or without the
    terminator, so the obvious small fixture asserts nothing — measured, the mutant
    survives it. The wide column is what pushes its neighbours together.

    Run at image build because it needs a real render and a real extraction: WeasyPrint
    binds cairo and pango at import, and a developer machine may have neither.
    """
    import io

    import weasyprint
    from pypdf import PdfReader

    from reporting_agent.verify.pdf import is_located, normalize
    from reporting_agent.verify.tokens import normalize_pdf_text

    def cell(value: str) -> str:
        return f'<td><span class="rpt-figure">{value}</span></td>'

    rows = "".join(
        "<tr>"
        + cell(f"2026-07-{n + 1:02d}")
        + cell(f"0.2{n % 10}%")
        + cell(f"12.4{n % 10}%")
        + cell(f"3,187,970,78{n % 10}.00 bytes")
        + "</tr>"
        for n in range(10)
    )
    # The real headers, at their real length. Short ones leave the columns wide enough that
    # the extraction is clean either way — measured, the mutant survives a `CPU avg` header
    # and dies on this one. What squeezes the cells together is a header far longer than the
    # value beneath it, which is exactly what a companion table has.
    headers = (
        "Time",
        "CPN-App — Percentage CPU (avg)",
        "CPN-App — Percentage CPU (max)",
        "CPN-App — Available Memory Bytes (avg)",
    )
    body = (
        '<table class="rpt-table"><thead><tr>'
        + "".join(f"<th>{header}</th>" for header in headers)
        + f"</tr></thead><tbody>{rows}</tbody></table>"
    )
    page = (
        "<!doctype html><html><head><style>"
        + stylesheet("editorial")
        + "</style></head><body>"
        + body
        + "</body></html>"
    )
    pdf = weasyprint.HTML(string=page).write_pdf()
    text = normalize_pdf_text(
        [page_.extract_text() for page_ in PdfReader(io.BytesIO(pdf)).pages]
    )

    wanted = ("0.20%", "12.40%", "3,187,970,780.00 bytes")
    missing = [
        value
        for value in wanted
        if not is_located(normalize(value), text, decimal=".", grouping=",")
    ]
    if missing:
        raise SystemExit(
            f"cell boundaries are lost in extraction: the fidelity gate cannot locate "
            f"{missing} though every one is on the page. The styled reading copy would be "
            f"suppressed for a correct document."
        )
    print("cell boundaries ok: a figure beside a wide neighbour is locatable")


if __name__ == "__main__":
    import sys

    if "--assert-build" in sys.argv:
        _assert_cell_boundaries_survive()
    else:
        raise SystemExit("usage: python -m reporting_agent.render.printcss --assert-build")
