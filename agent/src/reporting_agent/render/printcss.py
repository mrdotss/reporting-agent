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

@page {{
  size: {size};
  margin: 20mm 18mm 18mm 18mm;
  @bottom-center {{
    content: counter(page) " / " counter(pages);
    font-family: var(--body-face);
    font-size: {spec.small_pt - 0.5}pt;
    color: var(--muted);
  }}
  @top-right {{
    content: string(section-title);
    font-family: var(--body-face);
    font-size: {spec.small_pt - 0.5}pt;
    color: var(--muted);
  }}
}}

/* The cover carries no running header: there is no section yet, and a page number on a
   cover is furniture nobody reads. */
@page :first {{
  @top-right {{ content: none; }}
  @bottom-center {{ content: none; }}
}}

body {{
  margin: 0;
  font-family: var(--body-face);
  font-size: {spec.body_pt}pt;
  line-height: {spec.line_spacing};
  color: var(--ink);
}}

h1, h2, h3, h4 {{
  font-family: var(--heading-face);
  color: var(--accent);
  break-after: avoid;
  margin: 1.4em 0 0.5em;
  string-set: section-title content();
}}
h1 {{ font-size: {h1}pt; }}
h2 {{ font-size: {h2}pt; }}
h3 {{ font-size: {h3}pt; text-transform: {caps}; }}
h4 {{ font-size: {h4}pt; text-transform: {caps}; }}

/* --- front matter ------------------------------------------------------- */

[data-style="Cover Title"] {{
  font-family: var(--heading-face);
  font-size: {spec.title_pt}pt;
  color: var(--accent);
  margin: 0 0 0.2em;
  line-height: 1.1;
}}
[data-style="Cover Meta"] {{
  font-size: {spec.subtitle_pt}pt;
  color: var(--muted);
  margin: 0 0 2em;
}}
[data-style="Document Control"] {{
  font-family: var(--heading-face);
  font-size: {h3}pt;
  color: var(--accent);
  margin: 1.6em 0 0.4em;
}}
[data-style="Title"] {{
  font-family: var(--heading-face);
  font-size: {h2}pt;
  color: var(--accent);
  margin: 0 0 0.6em;
}}

.rpt-pairs {{
  border-collapse: collapse;
  margin: 0 0 1.2em;
  font-size: {spec.body_pt}pt;
}}
.rpt-pairs th {{
  text-align: left;
  font-weight: 400;
  color: var(--muted);
  padding: 2.5pt 18pt 2.5pt 0;
  white-space: nowrap;
  vertical-align: top;
}}
.rpt-pairs td {{ padding: 2.5pt 0; vertical-align: top; }}

.rpt-grid {{
  width: 100%;
  border-collapse: collapse;
  margin: 0.4em 0 1.4em;
  font-size: {spec.small_pt}pt;
}}
.rpt-grid th {{
  text-align: left;
  font-size: {spec.small_pt - 1}pt;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  border-bottom: 1pt solid var(--accent);
  padding: 3pt 8pt 3pt 0;
}}
.rpt-grid td {{
  padding: 5pt 8pt 5pt 0;
  border-bottom: 0.4pt solid var(--rule);
  vertical-align: bottom;
}}
/* Req 13.6 clause (b) — a ruled box to sign, never the typed name. */
.rpt-signature {{
  border-bottom: 0.6pt solid var(--ink);
  min-width: 45mm;
  height: 14mm;
}}

.rpt-note {{ color: var(--muted); font-size: {spec.small_pt}pt; }}

.rpt-toc {{ margin: 0.5em 0 0; }}
.rpt-toc-list {{ list-style: none; padding: 0; margin: 0; }}
.rpt-toc-entry {{
  padding: 2.5pt 0;
  border-bottom: 0.4pt dotted var(--rule);
}}
.rpt-toc-entry[data-level="2"] {{ padding-left: 8mm; }}
.rpt-toc-entry[data-level="3"] {{ padding-left: 16mm; }}

/* --- body --------------------------------------------------------------- */

table.rpt-table {{
  width: 100%;
  border-collapse: collapse;
  margin: 0.6em 0 0.3em;
  font-size: {spec.small_pt}pt;
}}
thead {{ display: table-header-group; }}
tr {{ break-inside: avoid; }}
table.rpt-table th {{
  font-size: {spec.small_pt - 1.5}pt;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  text-align: left;
  font-weight: 700;
  padding: 4pt 6pt 4pt 0;
  border-bottom: 1.2pt solid var(--accent);
  /* A header may wrap; it may not be broken through the middle of a word, which is what
     the `.docx` does when a column is narrower than its longest header word. */
  overflow-wrap: normal;
  hyphens: none;
}}
table.rpt-table td {{
  padding: 3.5pt 6pt 3.5pt 0;
  border-bottom: 0.4pt solid var(--rule);
  vertical-align: top;
  /* `break-word`, never `anywhere`: `anywhere` lets the engine consider a break inside a
     word when it computes the column's minimum width, so a column of `metric_not_selected`
     is squeezed to `metri c_no t_sel ected`. */
  overflow-wrap: break-word;
}}
table.rpt-table tbody tr:nth-child(even) {{ background: var(--band); }}

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

.rpt-figure {{
  font-family: var(--figure-face);
  font-size: {spec.small_pt - 0.5}pt;
  /* A figure must never be broken across lines: `verify/pdf.py` searches the converted
     text for the ledger string contiguously, and a line break through a numeral reads as a
     figure that never arrived. This is the CSS statement of what cost two production runs
     to establish in Word. */
  white-space: nowrap;
}}

caption {{
  caption-side: bottom;
  text-align: left;
  font-size: {spec.small_pt - 0.5}pt;
  color: var(--muted);
  font-style: italic;
  padding-top: 3pt;
}}
.rpt-notice {{ color: var(--muted); font-style: italic; }}

.rpt-chart {{ margin: 0.8em 0 1.2em; break-inside: avoid; }}
.rpt-chart svg {{ width: 100%; height: auto; }}
.rpt-chart figcaption {{
  font-size: {spec.small_pt}pt;
  color: var(--muted);
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
