"""The styled PDF — a third artifact, rendered from the HTML emitter's output.

## What this is, and what it is not

Two PDFs are delivered. `render/pdf.py` converts the produced `.docx` through LibreOffice
and that pair is exactly what Req 23.1 describes: one document, converted, so the Word file
and the PDF cannot disagree. This is a **reading copy** — the same compiled AST, the same
figure ledger, the same front-matter description, laid out by a stylesheet instead of by
Word.

They will not paginate alike, and are not meant to. What they share is every figure, which
is checkable and is checked: the `pdf` gate runs over this artifact too, because a customer
opens it.

## Why WeasyPrint and not a browser

Measured rather than assumed, and the Dockerfile asserts both results at build time.
WeasyPrint runs **no JavaScript** — a `<script>` rewriting the DOM leaves the original text
in the output — so Chart.js, Recharts and every shadcn chart need Chromium, which is
300-400MB on an image with a cold-start budget. And it renders inline SVG natively as
vector with the text still extractable, which is what lets the chart come from the
matplotlib renderer that already draws the `.docx`'s PNG: one drawing, two encodings,
rather than a second engine with its own opinion about which series are plotted.

## The import is deferred on purpose

WeasyPrint binds cairo and pango through cffi **at import**, not at first use, so
`import weasyprint` raises `OSError` on any machine without those libraries — including a
developer's. At module scope that would fail collection of the entire test suite. The image
has them and asserts it at build time; here the import sits inside the one function that
needs it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final

from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.messages import Messages
from reporting_agent.errors import RenderFailedError
from reporting_agent.render.printcss import stylesheet

__all__ = [
    "PrintOutcome",
    "print_document_html",
    "print_pdf_bytes",
    "render_print_pdf",
]

_DOCUMENT: Final[str] = (
    '<!doctype html><html lang="{language}"><head><meta charset="utf-8">'
    "<title>{title}</title><style>{css}</style></head>"
    '<body class="rpt-print">{front_matter}{body}</body></html>'
)


class PrintOutcome:
    """The rendered bytes and the HTML they came from.

    The HTML is returned rather than discarded because it is what a failure is diagnosed
    from: a figure missing from this PDF is either missing from the markup or lost in
    layout, and those have different fixes.
    """

    __slots__ = ("pdf_bytes", "html")

    def __init__(self, pdf_bytes: bytes, html: str) -> None:
        self.pdf_bytes = pdf_bytes
        self.html = html


def print_document_html(
    *,
    body_html: str,
    front_matter_html: str,
    design: DesignSettings,
    title: str,
    language: str,
) -> str:
    """Assemble the complete page: front matter, body, and the theme's stylesheet.

    A complete document rather than the fragment `emit_html` returns. That fragment is
    deliberately a fragment — the app owns the page around it — and a PDF has no app, so
    the page is built here and nowhere else.
    """
    return _DOCUMENT.format(
        language=language,
        title=title,
        css=stylesheet(design.preset, page_size=design.page_size),
        front_matter=front_matter_html,
        body=body_html,
    )


def print_pdf_bytes(document_html: str) -> bytes:
    """Render an assembled page to PDF.

    Raises `RenderFailedError` when WeasyPrint is unavailable or the render fails, naming
    which — an operator reading "no styled PDF" needs to know whether the image is missing
    a library or the document is malformed.
    """
    try:
        import weasyprint
    except Exception as error:  # OSError from cffi, ModuleNotFoundError if absent
        raise RenderFailedError(
            f"the styled PDF renderer is unavailable: {type(error).__name__}: {error}. "
            f"WeasyPrint binds cairo and pango at import; the image installs them and "
            f"asserts a render at build time, so this is an environment fault rather than "
            f"a document fault."
        ) from error

    try:
        return weasyprint.HTML(string=document_html).write_pdf()
    except Exception as error:
        raise RenderFailedError(
            f"the styled PDF could not be rendered: {type(error).__name__}: {error}"
        ) from error


def render_print_pdf(
    document: object,
    *,
    front_matter_sections: Sequence[object],
    chart_vectors: Mapping[str, str],
    chart_tables: Mapping[str, object],
    design: DesignSettings,
    messages: Messages,
    title: str,
    language: str = "en",
) -> PrintOutcome:
    """The whole path: emit both halves, assemble, render.

    `chart_vectors` come from the `.docx` render rather than from a second drawing, so the
    chart in this PDF is the chart in the Word file.
    """
    from reporting_agent.render.html import emit_front_matter_html, emit_html

    body = emit_html(
        document,
        messages=messages,
        chart_vectors=chart_vectors,
        chart_tables=chart_tables,
    ).html
    front_matter = emit_front_matter_html(front_matter_sections)
    page = print_document_html(
        body_html=body,
        front_matter_html=front_matter,
        design=design,
        title=title,
        language=language,
    )
    return PrintOutcome(print_pdf_bytes(page), page)
