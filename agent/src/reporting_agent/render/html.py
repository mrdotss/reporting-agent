"""The second emitter over the same tree.

Walks the **same AST instance** `render/docx.py` walks (Req 24.1) — the tree the block
compiler produced from that run's pinned template version and that run's snapshot. It compiles
no second AST, and it holds **no block ordering rule, no column arrangement rule and no layout
definition of its own**. Every structural decision was already made by the compiler; this module
only chooses HTML elements for nodes that already exist in an order that is already fixed.

That absence is the requirement. A third layout definition — one in the compiler, one in the
DOCX emitter, one here — is three places for the in-app preview and the delivered document to
disagree about what the report contains, and the disagreement would surface as a customer
noticing the screen and the Word file differ.

## Provenance travels as attributes, not as a tooltip somebody composed

Every figure element carries `data-snapshot-path` and, for an estimate, `data-estimator-label`
(Req 24.2). Both are read from the ledger entry; **this module composes no estimator label**.
`compile/estimators.py` already produced one without a numeral in it, and a second composition
here would be a second formatter's output in a string the UI presents as provenance.

A **text fact** carries the same `data-snapshot-path` plus `data-fact-source` and
`data-collected-at` (Req 6.9), because provenance means something different for a collected
string: a figure's source is implicit in its metric, while two Azure APIs can answer for the
same resource and only one of them was asked. So the reveal presents a fact's source and
instant exactly where it presents a figure's snapshot path.

## What this emitter deliberately cannot say

**No page number, no page count, no total-page indicator** (Req 24.4). The HTML emitter
determines no pagination — Word does, from font metrics and column widths this module never
sees — so any page count it emitted would be a guess. A wrong page count is a promise the
document breaks, and it is worse than omitting the information entirely.

## A node it cannot emit produces nothing at all

Req 24.8: no partial rendering. A half-rendered preview is worse than an absent one, because a
reader cannot tell which half is missing. The `.pdf` remains the delivered result, and the
verifier records nothing for this failure — it reads the `.docx` alone, and the in-app rendering
is never a verification input.
"""

from __future__ import annotations

import html
from dataclasses import dataclass, field
from typing import Final

from reporting_agent.compile.ast import (
    Chart,
    ChartPoint,
    Document,
    EmptyCell,
    Figure,
    FigureCell,
    LayoutColumn,
    LayoutRow,
    PageBreak,
    Paragraph,
    Row,
    Series,
    Table,
    Text,
    TextCell,
    TextFact,
    TextFactCell,
)
from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT
from reporting_agent.compile.messages import Messages
from reporting_agent.render.toc import ADOPTED_APPROACH, TOC_APPROACH_NONE

__all__ = [
    "EMITTED_CLASS_NAMES",
    "EMPTY_CELL_TEXT",
    "FIGURE_CLASS",
    "NOTICE_ROW_CLASS",
    "PAGINATION_FORBIDDEN_ATTRIBUTES",
    "HtmlEmitFailed",
    "HtmlOutcome",
    "emit_html",
    "emit_toc_html",
]

# --- BEGIN EMITTED_CLASS_NAMES ---
EMITTED_CLASS_NAMES: Final[tuple[str, ...]] = (
    "rpt-document",
    "rpt-block",
    "rpt-break",
    "rpt-table",
    "rpt-row",
    "rpt-notice",
    "rpt-chart",
    "rpt-chart-period",
    "rpt-series-set",
    "rpt-series",
    "rpt-point",
    "rpt-figure",
    "rpt-column",
    "rpt-layout-row",
    "rpt-toc",
    "rpt-toc-list",
    "rpt-toc-entry",
)
# --- END EMITTED_CLASS_NAMES ---
"""Every class name the HTML emitter may write into a ``class`` attribute.

Thirteen names, declared **once**. Every emit site below takes its class from this
collection rather than from an inline literal. `agent/tests/test_html_classes.py`
asserts no `class="rpt-` literal appears in this file outside this declaration, and
that a runtime-produced document's class set is a subset of this tuple.

`rpt-paper` is deliberately NOT in this collection — `paper-render.tsx` emits it as
its own wrapper; an extra stylesheet rule is never a failure and a missing one is.
"""

_CLS_DOCUMENT: Final[str] = EMITTED_CLASS_NAMES[0]   # rpt-document
_CLS_BLOCK: Final[str] = EMITTED_CLASS_NAMES[1]      # rpt-block
_CLS_BREAK: Final[str] = EMITTED_CLASS_NAMES[2]      # rpt-break
_CLS_TABLE: Final[str] = EMITTED_CLASS_NAMES[3]      # rpt-table
_CLS_ROW: Final[str] = EMITTED_CLASS_NAMES[4]        # rpt-row
_CLS_NOTICE: Final[str] = EMITTED_CLASS_NAMES[5]     # rpt-notice
_CLS_CHART: Final[str] = EMITTED_CLASS_NAMES[6]      # rpt-chart
_CLS_CHART_PERIOD: Final[str] = EMITTED_CLASS_NAMES[7]  # rpt-chart-period
_CLS_SERIES_SET: Final[str] = EMITTED_CLASS_NAMES[8] # rpt-series-set
_CLS_SERIES: Final[str] = EMITTED_CLASS_NAMES[9]     # rpt-series
_CLS_POINT: Final[str] = EMITTED_CLASS_NAMES[10]     # rpt-point
_CLS_FIGURE: Final[str] = EMITTED_CLASS_NAMES[11]    # rpt-figure
_CLS_COLUMN: Final[str] = EMITTED_CLASS_NAMES[12]    # rpt-column
_CLS_LAYOUT_ROW: Final[str] = EMITTED_CLASS_NAMES[13]  # rpt-layout-row
_CLS_TOC_NAV: Final[str] = EMITTED_CLASS_NAMES[14]     # rpt-toc
_CLS_TOC_LIST: Final[str] = EMITTED_CLASS_NAMES[15]    # rpt-toc-list
_CLS_TOC_ENTRY: Final[str] = EMITTED_CLASS_NAMES[16]   # rpt-toc-entry

FIGURE_CLASS: Final[str] = _CLS_FIGURE
"""The class every figure element carries.

`design-system.md` requires every figure in the monospace face with **tabular** numerals
(Req 24.3), which is a stylesheet's job — but the hook has to be reliable, so it is one class
name emitted at every figure position rather than an inline style repeated per element."""

NOTICE_ROW_CLASS: Final[str] = _CLS_NOTICE
"""The explicit no-data row. Styled in mist neutrals rather than `--destructive`: an empty
result is information, not an error."""

EMPTY_CELL_TEXT: Final[str] = ""
"""An `EmptyCell` emits an empty cell.

Distinct from `"0"`, and the distinction is the product: a metric a resource does not emit is a
recorded gap, and a zero would read as measured idleness."""

PAGINATION_FORBIDDEN_ATTRIBUTES: Final[tuple[str, ...]] = (
    "data-page",
    "data-page-count",
    "data-total-pages",
)
"""Named so a test can assert their absence rather than trusting the emitter never grew one.

Req 24.4 forbids emitting pagination, and the failure mode is additive: somebody adds a page
indicator to the preview because it looks incomplete without one."""

_NOTICE_ROW_KEYS: Final[frozenset[str]] = frozenset({"empty-scope", "no-gaps"})
"""Matched by the compiler's row key, not by the row's text — the same rule
`render/docx.py` applies, so a wording change cannot restyle one surface and not the other."""


class HtmlEmitFailed(Exception):
    """The HTML emitter could not emit a node type.

    ## Deliberately **not** an `AgentError`, and that is the whole point

    Every `AgentError` carries an `ErrorCode` that becomes a run's terminal state. Req 24.8 says
    the opposite must happen here: the in-app rendering becomes unavailable, **the verified
    `.pdf` remains the delivered result**, the verifier records no finding, and the run's
    verification status is unchanged. Raising `RenderFailedError` would fail the run and
    withhold both downloads over a preview — the exact outcome the requirement rules out.

    The first version of this class *did* subclass `RenderFailedError`, and `tests/test_errors.py`
    caught it: that module asserts one exception class per `ErrorCode`, so a 16th class sharing
    `RENDER_FAILED` broke a real invariant. The invariant was right and the subclass was wrong —
    an HTML failure has no error code because it is not a run failure.
    """


@dataclass(slots=True)
class HtmlOutcome:
    """One emission's result.

    `figure_count` is returned so a caller can assert against the ledger — the cheapest
    available check that the preview shows every figure the document does.
    """

    html: str
    figure_count: int
    table_count: int
    text_fact_count: int = 0
    """Counted **separately** from `figure_count`, the same split the DOCX outcome and the
    verification result make (Req 6.15). A preview showing every figure and no fact would
    otherwise report a matching total."""


@dataclass(slots=True)
class _Emitter:
    messages: Messages
    parts: list[str] = field(default_factory=list)
    figure_count: int = 0
    table_count: int = 0
    text_fact_count: int = 0

    def write(self, markup: str) -> None:
        self.parts.append(markup)

    # --- inline ---------------------------------------------------------------

    def figure(self, figure: Figure) -> str:
        """One figure element, carrying its `formatted` string and its provenance.

        `formatted` is emitted **exactly** as the Formatter produced it (Req 24.2) — escaped for
        HTML, which changes the bytes on the wire but not the text a reader or a copy-paste
        gets. No rounding, no locale substitution, no unit transformation: the unit is already
        inside the string.
        """
        if not figure.formatted:
            raise HtmlEmitFailed(
                f"figure {figure.path!r} carries no formatted string; the Formatter is the "
                f"only path from a value to a display string and this figure never took it"
            )
        if not figure.snapshot_path:
            raise HtmlEmitFailed(
                f"figure {figure.path!r} carries no snapshot path, so the provenance reveal "
                f"would have nothing to read; every figure element carries its own provenance"
            )

        attributes = [
            f'class="{FIGURE_CLASS}"',
            f'data-snapshot-path="{html.escape(figure.snapshot_path, quote=True)}"',
            f'data-figure-path="{html.escape(str(figure.path), quote=True)}"',
        ]
        # Req 24.2 — read from the ledger, never composed here. `estimator_label` is `None` for
        # an exact value, which is the signal that there is nothing to qualify.
        if figure.estimator_label:
            attributes.append(
                f'data-estimator-label="{html.escape(figure.estimator_label, quote=True)}"'
            )
        if figure.unit:
            attributes.append(f'data-unit="{html.escape(figure.unit, quote=True)}"')

        self.figure_count += 1
        return f"<span {' '.join(attributes)}>{html.escape(figure.formatted)}</span>"

    def text_fact(self, fact: TextFact) -> str:
        """One text-fact element, carrying its `formatted` string and its provenance (Req 6.9).

        The same shape as :meth:`figure`, down to the class, because the provenance reveal is
        one interaction: a reader clicks a checked value and is told where it came from. What
        differs is *what provenance means* for a fact — a `source` naming the API that
        answered and a `collected_at` naming when, alongside the `snapshot_path` a figure also
        carries. A figure's source is implicit in its metric; a fact's is not, because two
        Azure APIs can answer for the same resource and only one of them was asked.

        `formatted` is emitted exactly as `format_text_fact` produced it, escaped for HTML —
        which changes the bytes on the wire but not the text a reader or a copy-paste gets.
        No case folding and no translation: see `compile/format.py`.
        """
        if not fact.formatted:
            raise HtmlEmitFailed(
                f"text fact {fact.path!r} carries no formatted string; "
                f"`compile/format.py::format_text_fact` is the only path to one and this "
                f"entry never took it"
            )

        attributes = [
            f'class="{FIGURE_CLASS}"',
            f'data-snapshot-path="{html.escape(fact.snapshot_path, quote=True)}"',
            f'data-figure-path="{html.escape(str(fact.path), quote=True)}"',
            f'data-fact-key="{html.escape(fact.key, quote=True)}"',
            # The two Req 6.9 names. Unconditional rather than emitted when present:
            # `TextFact.__post_init__` requires both non-empty, so an absent attribute here
            # could only mean this emitter dropped one — and the reveal would then show a
            # fact with no source, which is the one thing a fact must never present as.
            f'data-fact-source="{html.escape(fact.source, quote=True)}"',
            f'data-collected-at="{html.escape(fact.collected_at, quote=True)}"',
        ]

        self.text_fact_count += 1
        return f"<span {' '.join(attributes)}>{html.escape(fact.formatted)}</span>"

    def inlines(self, items: tuple[object, ...], *, at: str) -> str:
        rendered: list[str] = []
        for ordinal, item in enumerate(items):
            if isinstance(item, Figure):
                rendered.append(self.figure(item))
            elif isinstance(item, Text):
                rendered.append(html.escape(item.text))
            else:
                raise HtmlEmitFailed(
                    f"{at} inline {ordinal} is {type(item).__name__}; an inline position "
                    f"admits only Text or Figure"
                )
        return "".join(rendered)

    # --- blocks ---------------------------------------------------------------

    def block(self, node: object) -> None:
        """Emit one block, in the order the AST declares (Req 24.1).

        A plain dispatch with no reordering, no grouping and no decision that depends on the
        node's content — which is what "holds no block ordering rule of its own" means in
        practice.
        """
        if isinstance(node, Paragraph):
            self.paragraph(node)
        elif isinstance(node, Table):
            self.table(node)
        elif isinstance(node, Chart):
            self.chart(node)
        elif isinstance(node, LayoutRow):
            self.layout_row(node)
        elif isinstance(node, PageBreak):
            self.page_break(node)
        else:
            raise HtmlEmitFailed(
                f"no HTML emission is declared for {type(node).__name__} at "
                f"{getattr(node, 'path', '<unknown path>')!r}. No partial rendering is "
                f"emitted: a half-rendered preview is worse than an absent one, because a "
                f"reader cannot tell which half is missing"
            )

    def paragraph(self, node: Paragraph) -> None:
        tag, extra = _paragraph_tag(node.style)
        body = self.inlines(node.inlines, at=f"paragraph {node.path!r}")
        self.write(
            f'<{tag} class="{_CLS_BLOCK}" data-style="{html.escape(node.style, quote=True)}"'
            f'{extra} data-path="{html.escape(str(node.path), quote=True)}">{body}</{tag}>'
        )

    def page_break(self, node: PageBreak) -> None:
        """A break is emitted as a **separator**, never as a page boundary.

        Req 24.4 forbids a page number or count, and the reason extends here: this module
        determines no pagination, so it cannot honestly say where a page ends. A horizontal
        rule says "the author asked for a break", which is the fact the AST actually carries.
        """
        self.write(
            f'<hr class="{_CLS_BREAK}" data-path="{html.escape(str(node.path), quote=True)}" />'
        )

    def table(self, node: Table) -> None:
        """One data table, with the same headers, row keys and cell strings the DOCX carries.

        Req 24.5 — same column order, same row order. Both come straight from the node, so
        "same" is structural rather than something two emitters have to agree to maintain.

        The table's *identity* is deliberately **not** emitted. It is the `.docx`'s anchor
        contract, and putting it in the DOM would invite a consumer to treat the preview as a
        verification input, which Req 24.8 is explicit it is not.
        """
        self.table_count += 1
        rows: list[str] = []

        header_cells = "".join(
            f'<th scope="col" data-column-key="{html.escape(column.key, quote=True)}">'
            f"{html.escape(column.header)}</th>"
            for column in node.columns
        )
        rows.append(f"<thead><tr>{header_cells}</tr></thead>")

        body: list[str] = []
        for row in node.rows:
            body.append(self.row(node, row))
        rows.append(f"<tbody>{''.join(body)}</tbody>")

        caption = (
            f"<caption>{html.escape(node.caption)}</caption>" if node.caption else ""
        )
        self.write(
            f'<table class="{_CLS_TABLE}" data-style="{html.escape(node.style, quote=True)}"'
            f' data-path="{html.escape(str(node.path), quote=True)}">{caption}'
            f"{''.join(rows)}</table>"
        )

    def row(self, node: Table, row: Row) -> str:
        classes = [_CLS_ROW]
        if row.key in _NOTICE_ROW_KEYS:
            classes.append(_CLS_NOTICE)

        cells: list[str] = []
        for ordinal, column in enumerate(node.columns):
            if ordinal >= len(row.cells):
                # Padded, exactly as the DOCX emitter pads a short row — a truncation row
                # carries fewer cells than the table has columns, by design.
                cells.append(f'<td data-column-key="{html.escape(column.key, quote=True)}"></td>')
                continue

            cell = row.cells[ordinal]
            attribute = f' data-column-key="{html.escape(column.key, quote=True)}"'
            if isinstance(cell, FigureCell):
                cells.append(f"<td{attribute}>{self.figure(cell.figure)}</td>")
            elif isinstance(cell, TextFactCell):
                cells.append(f"<td{attribute}>{self.text_fact(cell.fact)}</td>")
            elif isinstance(cell, TextCell):
                cells.append(f"<td{attribute}>{html.escape(cell.text)}</td>")
            elif isinstance(cell, EmptyCell):
                cells.append(f"<td{attribute}>{EMPTY_CELL_TEXT}</td>")
            else:
                raise HtmlEmitFailed(
                    f"table {node.path!r} row {row.key!r} cell {ordinal} is "
                    f"{type(cell).__name__}; a cell admits only FigureCell, TextFactCell, "
                    f"TextCell or EmptyCell"
                )

        return (
            f'<tr class="{" ".join(classes)}" '
            f'data-row-key="{html.escape(row.key, quote=True)}">{"".join(cells)}</tr>'
        )

    def chart(self, node: Chart) -> None:
        """A chart, rendered **client-side from the structured spec** — no image, no presign.

        The agent's static PNG belongs in the `.docx`; in the app the chart is drawn from the
        data so it is interactive and theme-aware. So this emits the spec as a data island plus
        the same companion table the document carries, which is what keeps the two surfaces
        showing one plotted set.

        `encoding` is emitted verbatim because the **agent** decides the palette and the client
        must not guess it from the series count.
        """
        series_markup: list[str] = []
        for series in node.series:
            series_markup.append(self.series(series))

        indication = (
            f'<p class="{_CLS_NOTICE}">{html.escape(self.messages.text(EMPTY_SCOPE_TEXT))}</p>'
            if not any(series.points for series in node.series)
            else ""
        )

        period_markup = (
            f'<p class="{_CLS_CHART_PERIOD}">{html.escape(node.period_label)}</p>'
            if node.period_label
            else ""
        )

        self.write(
            f'<figure class="{_CLS_CHART}" data-chart-type='
            f'"{html.escape(node.chart_type, quote=True)}"'
            f' data-encoding="{html.escape(node.encoding, quote=True)}"'
            f' data-unit="{html.escape(node.unit, quote=True)}"'
            f' data-path="{html.escape(str(node.path), quote=True)}">'
            f"<figcaption>{html.escape(node.title)}</figcaption>"
            f'{period_markup}{indication}<div class="{_CLS_SERIES_SET}">{"".join(series_markup)}</div>'
            f"</figure>"
        )

    def series(self, series: Series) -> str:
        point_markups = [self.point(point) for point in series.points]
        points = " \u00b7 ".join(point_markups)
        return (
            f'<div class="{_CLS_SERIES}" data-series-key='
            f'"{html.escape(series.key, quote=True)}"'
            f' data-series-label="{html.escape(series.label, quote=True)}">{points}</div>'
        )

    def point(self, point: ChartPoint) -> str:
        return (
            f'<span class="{_CLS_POINT}" data-x="{html.escape(point.x, quote=True)}">'
            f"{self.figure(point.y)}</span>"
        )

    def layout_row(self, node: LayoutRow) -> None:
        """A `row` as a container carrying its declared column count (Req 24.7).

        **No table identity and no anchor triple**, so a layout container is never presented as
        a data table. `data-columns` is the tuple's own length rather than a stored count, the
        same reasoning the AST applies: no separate field can disagree with the children it
        holds.
        """
        columns: list[str] = []
        for column in node.columns:
            if not isinstance(column, LayoutColumn):  # pragma: no cover - AST validates
                raise HtmlEmitFailed(
                    f"layout row {node.path!r} column is {type(column).__name__}"
                )
            nested = _Emitter(messages=self.messages)
            for child in column.blocks:
                nested.block(child)
            self.figure_count += nested.figure_count
            self.table_count += nested.table_count
            self.text_fact_count += nested.text_fact_count
            columns.append(
                f'<div class="{_CLS_COLUMN}" data-path='
                f'"{html.escape(str(column.path), quote=True)}">'
                f"{''.join(nested.parts)}</div>"
            )

        self.write(
            f'<div class="{_CLS_LAYOUT_ROW}" data-columns="{len(node.columns)}"'
            f' data-path="{html.escape(str(node.path), quote=True)}">'
            f"{''.join(columns)}</div>"
        )


_HEADING_TAGS: Final[dict[str, str]] = {
    "Title": "h1",
    "Subtitle": "p",
    "Heading 1": "h2",
    "Heading 2": "h3",
    "Heading 3": "h4",
    "Heading 4": "h5",
}
"""Theme paragraph style to HTML element.

`Title` becomes `h1` and `Heading 1` becomes `h2` because a document has one title and the
page it is previewed on already has a heading level above the paper. Everything unlisted is a
`<p>`, which is correct for `Body Text`, `Caption` and the notices — none of them is a heading,
and marking one up as a heading would put it in a screen reader's document outline.
"""


def _paragraph_tag(style: str) -> tuple[str, str]:
    tag = _HEADING_TAGS.get(style, "p")
    if style in ("Caption",):
        return tag, ' data-role="caption"'
    if style in ("Notice", "PreviewNotice"):
        return tag, f' class="{_CLS_NOTICE}"'
    return tag, ""


def emit_html(document: object, *, messages: Messages) -> HtmlOutcome:
    """Emit `document` as an HTML fragment (Req 24.1).

    A **fragment**, not a page: no `<html>`, no `<head>`, no stylesheet link. The app owns the
    surrounding page, the theme tokens and the permanent preview label, and a self-contained
    document here would be a second place those decisions live.

    Raises :class:`HtmlEmitFailed` — and emits nothing at all — for a node type it declares no
    emission for (Req 24.8).
    """
    if not isinstance(document, Document):
        raise HtmlEmitFailed(
            f"emit_html takes a compiled Document, got {type(document).__name__}"
        )

    emitter = _Emitter(messages=messages)
    for block in document.blocks:
        emitter.block(block)

    return HtmlOutcome(
        html=f'<div class="{_CLS_DOCUMENT}">{"".join(emitter.parts)}</div>',
        figure_count=emitter.figure_count,
        text_fact_count=emitter.text_fact_count,
        table_count=emitter.table_count,
    )


# ---------------------------------------------------------------------------
# Table of contents — a list of headings, carrying NO page number (Req 14.8)
# ---------------------------------------------------------------------------

# Heading styles eligible for the TOC: levels 1 through 3 (Req 14.11).
_TOC_HEADING_STYLES: Final[frozenset[str]] = frozenset(
    {"Heading 1", "Heading 2", "Heading 3"}
)

_HEADING_LEVEL_MAP: Final[dict[str, int]] = {
    "Heading 1": 1,
    "Heading 2": 2,
    "Heading 3": 3,
}


# TOC-specific class names — derived from EMITTED_CLASS_NAMES like all others.
_TOC_CLS_ENTRY: Final[str] = _CLS_TOC_ENTRY
_TOC_CLS_NAV: Final[str] = _CLS_TOC_NAV
_TOC_CLS_LIST: Final[str] = _CLS_TOC_LIST


def emit_toc_html(document: object) -> str:
    """Emit the table of contents as a list of headings carrying **no page number**.

    The HTML emitter determines no pagination (Req 14.8, templates spec 14.3), so
    no page number, no page count, and no total-page indicator is emitted. The TOC
    is a navigation aid showing heading hierarchy alone.

    Returns an empty string if ``ADOPTED_APPROACH`` is ``none`` — no TOC section at all.
    Returns an empty string if there are no headings at levels 1-3.
    """
    if ADOPTED_APPROACH == TOC_APPROACH_NONE:
        return ""

    if not isinstance(document, Document):
        return ""

    headings: list[tuple[int, str]] = []
    for block in document.blocks:
        if isinstance(block, Paragraph) and block.style in _TOC_HEADING_STYLES:
            # Extract the text from inlines.
            text_parts: list[str] = []
            for inline in block.inlines:
                if isinstance(inline, Text):
                    text_parts.append(inline.text)
                elif isinstance(inline, Figure):
                    text_parts.append(inline.formatted or "")
            heading_text = "".join(text_parts).strip()
            if heading_text:
                level = _HEADING_LEVEL_MAP.get(block.style, 1)
                headings.append((level, heading_text))

    if not headings:
        return ""

    items: list[str] = []
    for level, text in headings:
        items.append(
            f'<li class="{_TOC_CLS_ENTRY}" data-level="{level}">'
            f"{html.escape(text)}</li>"
        )

    return (
        f'<nav class="{_TOC_CLS_NAV}" aria-label="Table of contents">'
        f'<ol class="{_TOC_CLS_LIST}">{"".join(items)}</ol></nav>'
    )
