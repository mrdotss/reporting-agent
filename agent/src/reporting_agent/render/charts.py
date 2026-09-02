"""Chart images and their companion tables: an image that cannot disagree with the numbers.

Every chart in the document is **two** things emitted together (Req 22.1, 22.2):

1. exactly one static PNG, and
2. exactly one companion **data table** carrying every plotted point as a figure,

both bearing the same `cht:<path>` identity — the image in its alternative text, the table
in its `w:tblCaption`. So the verifier pairs them **by identity rather than by proximity**,
and the table goes through the ordinary anchored-equality pass. An image is opaque to the
verifier; the table beside it is not, and it is the table that makes the picture checkable.

## Nothing here computes a value

Every plotted number comes from a `Figure` in the AST, which came from the ledger, which came
from a snapshot position (Req 22.6). The only arithmetic applied to a plotted decimal string
is the layout scaling that positions a mark — and that result is **neither hashed nor emitted
as text**, so it cannot leak into the document. `float(...)` appears exactly once, at the
boundary where a mark's coordinate is computed, and the value it produces is thrown away with
the figure.

## The chart data hash

SHA-256 over the ordered plotted contributions — series stable key, x key, and the ledger's
**decimal string** — in plotted order (Req 22.3). Written into the sidecar beside the
embedded image, and recomputable from the AST by the verifier, which is how
`chart_hash_mismatch` becomes detectable: the image's sidecar says what was plotted, the tree
says what should have been, and the two are compared rather than trusted.

Hashing the decimal strings rather than the plotted coordinates is deliberate. A coordinate
is a float produced by layout; a decimal string is the value. Hashing the former would make
the digest depend on the figure size.

## Colour never carries meaning alone

Palette from the node's **declared** `encoding`, never from the series count or the chart type
(Req 22.7). Colour assigned by stable key, never by array index (Req 22.8). And every series
additionally carries a direct label plus, for a line, a marker shape and a dash pattern
(Req 22.10) — so the chart reads in greyscale, under colour-vision deficiency, and in a
photocopy. `--destructive` appears on no series, delta, gridline or band (Req 22.12).
"""

from __future__ import annotations

import hashlib
import io
import json
from dataclasses import dataclass
from decimal import Decimal
from collections.abc import Sequence
from typing import Final

import matplotlib
from matplotlib import rc_context
from matplotlib.figure import Figure as MplFigure
from matplotlib.ticker import MaxNLocator

from reporting_agent.compile.ast import (
    Chart,
    ChartPoint,
    Column,
    EmptyCell,
    Figure,
    Row,
    Series,
    Table,
    TextCell,
    panel_groups,
)
from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT, NOTICE_COLUMN_HEADER
from reporting_agent.compile.messages import Messages
from reporting_agent.errors import RenderFailedError
from reporting_agent.render import chartstyle as style
from reporting_agent.render.tablefit import fits_page

__all__ = [
    "CHART_ALT_TEXT_PREFIX",
    "EMPTY_CHART_TEXT_ID",
    "OTHER_SERIES_KEY",
    "OTHER_SERIES_LABEL_ID",
    "QUALIFIER",
    "SERIES_COLUMN_KEY",
    "VALUE_COLUMN_KEY",
    "X_COLUMN_KEY",
    "SIDECAR_SUFFIX",
    "ChartArtifacts",
    "chart_data_hash",
    "companion_table",
    "label_indices",
    "plotted_series",
    "render_chart",
    "sidecar_bytes",
    "stack_without_overlap",
]

CHART_ALT_TEXT_PREFIX: Final[str] = "Chart "
"""Prefixes the identity in the image's alt text, so the attribute reads as a description
rather than as a bare token while still carrying the identity verbatim."""

SIDECAR_SUFFIX: Final[str] = ".chart.json"

EMPTY_CHART_TEXT_ID: Final[str] = "doc.chart.empty"
"""Req 22.13 — resolved through the message catalog so the indication appears in the
document's pinned language. A chart that vanished is indistinguishable in the delivered
document from a chart the author never configured."""

SERIES_COLUMN_KEY: Final[str] = "series"
X_COLUMN_KEY: Final[str] = "x"
VALUE_COLUMN_KEY: Final[str] = "value"

# The three companion-table header constants that stood here — `SERIES_COLUMN_HEADER`,
# `X_COLUMN_HEADER` and `VALUE_COLUMN_HEADER` — were removed when task 6.3 migrated their
# call sites to `messages.text(...)`. Their definitions survived the migration with no
# remaining reference, which `tests/test_message_literals.py` reported as English copy at a
# text-emitting site on its first run. Deleted rather than allowlisted: the guard exists
# precisely so an unused literal cannot sit here looking load-bearing.

OTHER_SERIES_KEY: Final[str] = "__other__"
OTHER_SERIES_LABEL_ID: Final[str] = "doc.chart.other_series"
QUALIFIER: Final[str] = " \u00b7"
"""Separates an aggregated point's originating series key from its own x label."""
"""Req 22.9's aggregate. A reserved key rather than a label match, so a real series
legitimately named "Other" cannot collide with it."""


@dataclass(frozen=True, slots=True)
class ChartArtifacts:
    """One chart's emitted parts.

    `table` is an AST `Table` rather than an emitted docx table: `render/docx.py` owns
    emission, so this module builds the node and hands it over. That keeps one table
    emitter — and therefore one caption writer, one header assertion and one anchor
    recorder — rather than a second path that could drift from it.
    """

    image_png: bytes
    sidecar_json: bytes
    table: Table
    data_hash: str
    identity: str
    plotted_keys: tuple[str, ...]
    image_svg: str = ""
    """The same figure as vector, for the print stylesheet to embed.

    Drawn once and serialised twice, so the raster in the `.docx` and the vector in the
    styled PDF cannot show different charts. Last and defaulted so a caller constructing
    one of these in a test needs only the raster, which is what every existing one does.
    """


# --------------------------------------------------------------------------- #
# The plotted set
# --------------------------------------------------------------------------- #


def plotted_series(node: Chart, *, messages: Messages) -> tuple[Series, ...]:
    """The series actually plotted, applying Req 22.9's five-series cap.

    At or below the cap, every series. Above it, the **four largest by the node's declared
    ordering** plus one aggregate — and "declared ordering" means the order the compiler
    already put them in. `compile/blocks/charts.py` ranks by the chart's ordering statistic
    with ties broken by ascending stable key, so re-ranking here would be a second ordering
    rule that could disagree with the one the document's own table used.

    The aggregate is **not** a computed sum. Summing peer series would produce a number with
    no snapshot address — exactly the thing this package exists to prevent — so the aggregate
    carries the *points of the remaining series concatenated*, each still its own figure. The
    series is labelled through the message catalog and coloured `--cat-other`; a reader sees
    that the remainder is plotted together, not that it was added up.

    `messages` is **required** rather than defaulting to English, because an omitted parameter
    silently renders English copy in an Indonesian document — exactly the outcome criterion
    15.11 exists to prevent. Every call site supplies the run's pinned messages explicitly.
    """
    if len(node.series) <= style.CATEGORICAL_LIMIT:
        return node.series

    plotted = node.series[: style.CATEGORICAL_PLOTTED_LIMIT]
    remainder = node.series[style.CATEGORICAL_PLOTTED_LIMIT :]

    # Each aggregated point's x is **qualified with the series it came from**. Without that,
    # two remaining series sharing an x — which is every multi-series chart over one period —
    # produce two points whose `(series key, x)` pair is identical. That pair is the companion
    # table's row key, and a repeated row key is a row the verifier cannot address (Req 21.5).
    # It is also what keeps the aggregate readable: "prod-db-04 · 2026-07-03" says which
    # resource the value belongs to, where a bare "2026-07-03" repeated nine times says
    # nothing.
    aggregated_points = tuple(
        ChartPoint(path=point.path, x=f"{series.key}{QUALIFIER} {point.x}", y=point.y)
        for series in remainder
        for point in series.points
    )

    aggregate = Series(
        path=remainder[0].path,
        key=OTHER_SERIES_KEY,
        label=messages.text(OTHER_SERIES_LABEL_ID, count=len(remainder)),
        points=aggregated_points,
    )
    return (*plotted, aggregate)


def _figures_in(node: Chart, *, messages: Messages) -> tuple[tuple[Series, tuple[Figure, ...]], ...]:
    return tuple(
        (series, tuple(point.y for point in series.points))
        for series in plotted_series(node, messages=messages)
    )


# --------------------------------------------------------------------------- #
# Direct value label selection (Req 17.4)
# --------------------------------------------------------------------------- #

def label_indices(points: tuple[ChartPoint, ...]) -> frozenset[int]:
    """Which points carry a direct value label (task 5.3, Req 18.1-18.9).

    **The last point only.** The direct label at each series' line end is the one that
    was already load-bearing before this task — the annotation naming which series is
    which, positioned where a reader's eye lands after following the line — and it
    stays exactly there. Every intermediate point's label is dropped: the companion
    table records every plotted point's value regardless (Req 22.1), so a reader who
    wants an interior value already has it in the table, and a chart crowded with a
    label at every point competed with the line it was meant to annotate.

    Pure, total, and deterministic: an empty series labels nothing, and any non-empty
    series labels exactly its last index, so the same series always labels the same
    point.

    Every emitted label is that point's ledger entry ``formatted`` string verbatim —
    unchanged by this task, since the label's own content was never the thing being
    thinned, only how many points carried one.
    """
    if not points:
        return frozenset()
    return frozenset({len(points) - 1})


# --------------------------------------------------------------------------- #
# The chart data hash (Req 22.3)
# --------------------------------------------------------------------------- #


def chart_data_hash(node: Chart, *, messages: Messages) -> str:
    """SHA-256 over the ordered plotted contributions.

    Each point contributes its **series stable key**, its **x key** and the ledger's
    **decimal string**, in plotted order. Fed as a canonical JSON array rather than as a
    concatenation, so a key containing the separator cannot forge a different plotted set
    that hashes the same.

    Computed from the plotted set — the same set the image draws and the companion table
    lists — which is what makes "the image, the table and the hash describe one plotted set"
    a checkable claim rather than an intention.

    **Absent from the hash input by construction:**

    - the ``formatted`` string (presentation, not data)
    - the label presence (whether a point carries a direct label)
    - colour assignment (palette token, hex, categorical or sequential)
    - marker shape and dash pattern
    - axis titles (resolved from the message catalog)
    - the ``unit`` field on the chart node
    - legend presence or absence
    - period label (resolved from the Formatter)
    - chart title and caption
    - gridline style

    Appearance is absent because the input is exactly
    ``(series.key, point.x, point.y.value)`` — the ledger's decimal string, not its
    formatted string, not any rendering attribute. "Appearance changes and verification
    does not" is a fact about this function's signature: widening the input would make a
    style change fire the chart-hash-mismatch finding.
    """
    contributions = [
        [series.key, point.x, str(point.y.value)]
        for series in plotted_series(node, messages=messages)
        for point in series.points
    ]
    payload = json.dumps(
        contributions, ensure_ascii=False, separators=(",", ":"), sort_keys=False
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def sidecar_bytes(node: Chart, *, data_hash: str, messages: Messages) -> bytes:
    """The sidecar recorded beside the embedded image.

    Carries the identity, the hash, and the plotted series keys — enough for the verifier to
    say *which* chart disagrees and *how*, without re-deriving the document's structure.
    """
    payload = {
        "identity": node.anchor_id,
        "chart_type": node.chart_type,
        "encoding": node.encoding,
        "unit": node.unit,
        "data_hash": data_hash,
        "series": [series.key for series in plotted_series(node, messages=messages)],
        "point_count": sum(len(series.points) for series in plotted_series(node, messages=messages)),
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )


# --------------------------------------------------------------------------- #
# The companion table (Req 22.1, 22.2)
# --------------------------------------------------------------------------- #


def companion_table(node: Chart, table_style: str, *, messages: Messages) -> Table:
    """Every plotted point of every plotted series, in whichever of two shapes fits.

    No sampling, no thinning, no re-rounding (Req 22.1): the cell text is the ledger's
    `formatted` string, and the set of figures is exactly the plotted set. A table that
    showed a subset would let the image assert something the table could not confirm.

    Its path is the chart node's own, so its identity is `cht:<path>` — the same identity
    written into the image's alt text. That is the pairing key, and deriving both from the
    node's path means they cannot disagree.

    ## Two shapes, and why the choice is measured rather than fixed

    Req 22.1 demands every point; it does not say in what arrangement. The wide shape puts
    the x on the rows and gives each series a column, which turns three machines over July
    from 93 rows into 31. It only works while every column can be made wide enough to hold
    its longest value on one line — `verify/pdf.py` searches the converted PDF for each
    ledger string *contiguously*, so a value wrapped inside its cell is a
    `pdf_figure_missing` finding even though every character of it is on the page. Run
    ef01a404 is what that looks like: 30 findings, one per day of July, all in the single
    column holding `3,187,970,789.00 bytes` beside four columns of `0.20%`.

    `tablefit` owns the arithmetic, measured against real LibreOffice. When the wide shape
    does not fit, the tall one does — a row per (series, point), so every value has the
    full width of a column to itself and no arrangement of the data can overflow it.

    Neither shape is a fallback in the sense of being worse: they trade width for height,
    and which one is right depends on how wide the values are, which is a property of the
    metrics the section selected rather than something the code can decide once.

    A chart with nothing to plot gets the explicit no-resources-matched row (Req 22.13),
    keyed the way `render/docx.py` recognises a notice row so it is styled as information
    rather than as a failure.

    `messages` is **required** rather than optional. A `None` default silently renders
    English copy, which is the exact outcome criterion 15.11 exists to prevent — reachable
    today by omission. Every call site supplies the run's pinned messages explicitly, and
    the tests are what make the update cheap.
    """
    series_set = plotted_series(node, messages=messages)
    if not any(series.points for series in series_set):
        # One column, so the notice reads as a notice rather than as a row with two blanks.
        return Table(
            path=node.path,
            style=table_style,
            columns=(Column(key="notice", header=messages.text(NOTICE_COLUMN_HEADER)),),
            rows=(
                Row(
                    path=node.path,
                    key="empty-scope",
                    cells=(TextCell(path=node.path, text=messages.text(EMPTY_SCOPE_TEXT)),),
                ),
            ),
            caption=node.caption,
        )

    wide = _x_major_table(node, table_style, series_set, messages=messages)
    return wide if fits_page(wide) else _point_per_row_table(
        node, table_style, series_set, messages=messages
    )


def _x_major_table(
    node: Chart, table_style: str, series_set: Sequence[Series], *, messages: Messages
) -> Table:
    """One row per x, one column per series — the compact shape.

    There are at most five series, because Req 22.9's cap makes that structural, and as
    many x values as the period has days. So the short dimension is the series and the long
    one is the x, and the table is **six columns wide at the very most, whatever the period
    holds**.

    Both of the verifier's addresses are the document's own text without concatenating
    them: it resolves a cell by `(row_key, column_key)` and reads both out of the `.docx` —
    the key column's emitted text and the column's header text. An x is unique among rows
    and a series label is unique among columns, so this addresses every figure without a
    key that repeats. The tall shape has to fold the x into the series label for exactly
    that reason; here the two dimensions do it.

    A series with no point at some x gets an `EmptyCell` — `day_series` omits a day it has
    no value for rather than zero-filling it, and the distinction between "measured zero"
    and "not measured" is one this table has no business collapsing.
    """
    # The x axis, in the order the points are plotted. Above the cap the aggregate's own
    # x values arrive already qualified with the series they came from, so they are
    # distinct rows carrying one value each rather than colliding with the real dates.
    x_values: list[str] = []
    for series in series_set:
        for point in series.points:
            if point.x not in x_values:
                x_values.append(point.x)

    columns = (
        Column(key=X_COLUMN_KEY, header=messages.text("chart.axis.time")),
        *(Column(key=series.key, header=series.label) for series in series_set),
    )

    by_series = [{point.x: point for point in series.points} for series in series_set]

    rows: list[Row] = []
    for x in x_values:
        cells: list[object] = [TextCell(path=node.path, text=x)]
        for lookup in by_series:
            point = lookup.get(x)
            cells.append(
                _figure_cell(point.y) if point is not None else EmptyCell(path=node.path)
            )
        # The row's own path is the chart node's: a row spans many points now, and no one
        # of them is the row. Each cell still carries its own figure's path, which is what
        # the ledger matches against, and the row is addressed by its x.
        rows.append(Row(path=node.path, key=x, cells=tuple(cells)))  # type: ignore[arg-type]

    return Table(
        path=node.path,
        style=table_style,
        columns=columns,
        rows=tuple(rows),
        caption=node.caption,
    )


def _point_per_row_table(
    node: Chart, table_style: str, series_set: Sequence[Series], *, messages: Messages
) -> Table:
    """One row per (series, point) — the tall shape, for values too wide to sit side by
    side.

    Three columns whatever the data holds, so each value gets roughly a third of the page
    and nothing can wrap. It is longer than the wide shape by a factor of the series count,
    which is the price of that guarantee and the reason it is not used unconditionally.

    The key column repeats the series label because a row key must be unique within the
    table and the x alone is not: the same day appears once per series. It is a
    concatenation of two strings the document already carries elsewhere, not a computed
    value, so masking treats it as identifier text.
    """
    columns = (
        Column(key=SERIES_COLUMN_KEY, header=messages.text("doc.table.period")),
        Column(key=X_COLUMN_KEY, header=messages.text("chart.axis.time")),
        Column(key=VALUE_COLUMN_KEY, header=messages.text("doc.table.value")),
    )

    rows: list[Row] = []
    for series in series_set:
        for point in series.points:
            rows.append(
                Row(
                    path=point.path,
                    key=f"{series.key}|{point.x}",
                    cells=(
                        TextCell(path=point.path, text=f"{series.label} — {point.x}"),
                        TextCell(path=point.path, text=point.x),
                        _figure_cell(point.y),
                    ),
                )
            )

    return Table(
        path=node.path,
        style=table_style,
        columns=columns,
        rows=tuple(rows),
        caption=node.caption,
    )


def _figure_cell(figure: Figure):
    from reporting_agent.compile.ast import FigureCell

    return FigureCell(path=figure.path, figure=figure)


# --------------------------------------------------------------------------- #
# The image
# --------------------------------------------------------------------------- #


def _panel_groups_for(
    node: Chart, series_set: tuple[Series, ...]
) -> tuple[tuple[str, ...], ...]:
    """Resolve `node.panels` against the series actually **plotted** (Req 17.7).

    `node.panels` was assigned by the compiler at compile time, over every
    series the block produced — before `plotted_series` applies Req 22.9's
    five-series cap and folds the remainder into one `__other__` aggregate.
    A chart above the cap therefore has a declared panel grouping that may
    name series no longer present (the folded ones) and never names the
    aggregate (which does not exist until render time), so this function
    re-derives groups over the plotted set rather than trusting the
    declared one verbatim in that case.

    Below the cap, `plotted_series` returns every series unchanged, so
    `node.panels`'s own groups already match — filtered to the keys present
    (a no-op there) and returned as declared, preserving the compiler's own
    panel ORDER rather than re-deriving it and risking a different order
    for the ordinary, most common case.

    Empty `node.panels` (a chart compiled before task 5.1, or one whose
    `panel_groups` never split it) still means one panel — never zero —
    matching the AST field's own documented default.
    """
    plotted_keys = {series.key for series in series_set}

    if node.panels:
        filtered = tuple(
            tuple(key for key in group if key in plotted_keys)
            for group in node.panels
        )
        filtered = tuple(group for group in filtered if group)
        if filtered and plotted_keys <= {key for group in filtered for key in group}:
            return filtered
        # The aggregate key (or some other plotted key) is not named in the
        # declared groups — re-derive over what is actually plotted rather
        # than silently dropping it from every panel.

    groups = panel_groups(series_set)
    return groups if groups else ((),)


def render_chart(
    node: Chart,
    *,
    table_style: str,
    theme: str = "light",
    preset: str = "",
    messages: Messages,
) -> ChartArtifacts:
    """Emit one chart's image, sidecar and companion table.

    The image is drawn under :func:`chartstyle.frozen_rc_params` in a `rc_context`, so the
    style is applied for this call and not left on the global state — where it would make the
    emitted bytes depend on whether some other module had already changed an rcParam.

    `messages` is **required** — see :func:`companion_table` for the reasoning. A default
    that silently falls back to English is the exact defect criterion 15.11 exists to close.
    """

    if node.encoding not in style.CHART_ENCODINGS:  # pragma: no cover - AST validates
        raise RenderFailedError(
            f"chart {node.path!r} declares encoding {node.encoding!r}, not one of "
            f"{style.CHART_ENCODINGS}"
        )

    # Req 17.11 — an absent unit for a plotted axis is RENDER_FAILED.
    if not node.unit:
        raise RenderFailedError(
            f"chart {node.path!r}: no unit declared for the plotted axis; "
            f"an untitled unitless axis is a refusal (Req 17.11)."
        )

    data_hash = chart_data_hash(node, messages=messages)
    series_set = plotted_series(node, messages=messages)

    # Req 17.1 — the panel groups this chart's plotted series fall into. Empty
    # `node.panels` means one panel holding every plotted series (task 5.1's
    # own guarantee), so `groups` always has at least one entry even for a
    # chart compiled before panelling existed. `plotted_series` (the
    # five-series cap and the aggregate) runs BEFORE this, so a panel never
    # groups a series the cap already dropped — panelling is a further split
    # of what was already going to be drawn, not a second selection.
    groups = _panel_groups_for(node, series_set)
    panel_count = len(groups)

    # The document's own ink for everything that is not data. `preset` is the theme the
    # profile selected; an empty one means "no document", which is what a preview or a test
    # renders into, and keeps the app's light/dark tokens.
    furniture = _furniture_for(preset, theme)

    with rc_context(style.frozen_rc_params(furniture.body_face)):
        figure = MplFigure(
            figsize=style.chart_size_inches(panel_count), dpi=style.CHART_DPI
        )
        axes_list = figure.subplots(panel_count, 1, sharex=True, squeeze=False)[:, 0]

        # Req 17.5 — the chart's own title (plus period) belongs to the whole
        # figure, set exactly once regardless of panel count, so a panelled
        # chart reads as one chart with panel_count panels rather than
        # panel_count separately titled charts stacked together.
        title_text = node.title
        if node.period_label:
            title_text = f"{node.title}\n{node.period_label}"
        # Left-aligned, in the document's accent and heading face — the way every other
        # heading in the report is set. A centred banner in a face the document uses
        # nowhere else is what made the chart read as a picture pasted into the page
        # rather than as part of it.
        figure.suptitle(
            title_text,
            fontfamily=furniture.heading_face,
            fontsize=style.CHART_TITLE_SIZE,
            color=furniture.accent or furniture.value_label,
            x=_TITLE_LEFT,
            ha="left",
        )

        try:
            for panel_index, (axes, panel_keys) in enumerate(zip(axes_list, groups, strict=True)):
                panel_series = tuple(
                    series for series in series_set if series.key in panel_keys
                )
                _draw(
                    axes,
                    node,
                    panel_series,
                    theme=theme,
                    messages=messages,
                    furniture=furniture,
                    is_last_panel=(panel_index == panel_count - 1),
                )

            # `right` leaves the gutter the direct end labels are drawn into. At the
            # previous 0.86 that gutter was 0.84in and a label like
            # "CPN-MCP - Percentage CPU (max)" was clipped mid-word by the figure edge,
            # which is what made the legend load-bearing rather than a fallback.
            #
            # Fixed rather than tight_layout(): `tight_layout` measures rendered text, so
            # its result depends on font metrics and would make the emitted bytes
            # host-dependent. Set once, on the whole figure, after every panel is drawn.
            # `hspace` is a fixed axes-fraction gap between stacked panels — large enough
            # to separate one panel's x-axis tick labels from the panel below's title,
            # small enough that `panel_count` panels still read as one chart rather than
            # `panel_count` charts with visible whitespace between them. Single-panel
            # charts (`panel_count == 1`) ignore `hspace` entirely, so this changes
            # nothing about their emitted bytes.
            #
            # `top` and `bottom` are computed from **inches** rather than fixed fractions.
            # The title needs the same half-inch and the rotated dates the same inch
            # whatever the panel count, but a fraction of a figure that grows from 3.2in to
            # 8in does not: at three panels a `bottom` of 0.28 reserved 2.24in for labels
            # that need under one, and the chart sat in the top two-thirds of its own image
            # with a band of white beneath it.
            height = figure.get_figheight()
            figure.subplots_adjust(
                left=0.12,
                right=_AXES_RIGHT,
                top=1.0 - _TITLE_BAND_INCHES / height,
                bottom=_XLABEL_BAND_INCHES / height,
                hspace=0.5,
            )

            buffer = io.BytesIO()
            figure.savefig(
                buffer,
                format="png",
                dpi=style.CHART_DPI,
                metadata=dict(style.PNG_METADATA),
                facecolor="white",
            )

            # The same figure, serialised a second way. **One drawing, two encodings** —
            # the PNG the `.docx` embeds and the SVG the print stylesheet does, which is
            # what stops the Word file and the styled PDF from showing different charts.
            #
            # SVG for print because WeasyPrint embeds it natively as vector: crisp at any
            # zoom, and smaller than this PNG at 200dpi. The `.docx` keeps the raster
            # because Word's SVG support is unreliable and python-docx cannot emit one.
            svg_buffer = io.StringIO()
            figure.savefig(
                svg_buffer,
                format="svg",
                metadata=dict(style.SVG_METADATA),
                facecolor="white",
            )
        finally:
            # Explicit, because a Figure created directly is not registered with pyplot and
            # would otherwise be reclaimed only by the collector — which under a long run is
            # a slow leak of several megabytes per chart.
            figure.clear()
        image = buffer.getvalue()
        vector = svg_buffer.getvalue()

    return ChartArtifacts(
        image_png=image,
        image_svg=vector,
        sidecar_json=sidecar_bytes(node, data_hash=data_hash, messages=messages),
        table=companion_table(node, table_style, messages=messages),
        data_hash=data_hash,
        identity=node.anchor_id,
        plotted_keys=tuple(series.key for series in series_set),
    )


def _resolve_axis_title(label_id: str, *, node: Chart, axis: str, messages: Messages) -> str:
    """Resolve an axis title from the message catalog.

    An absent string id (empty string) is accepted when the axis carries a unit — the axis
    is rendered with the unit alone. But if the id IS provided and the catalog has no
    value for it in this language, ``MissingMessageError`` (a ``RenderFailedError`` subclass)
    propagates, naming that axis, the string id and the metric (Req 17.11).

    An untitled unitless axis — no string id AND no unit — is caught in ``render_chart``
    before this function is reached.
    """
    if not label_id:
        return ""
    # MissingMessageError is a RenderFailedError subclass, so this naturally
    # raises RENDER_FAILED if the catalog has no value.
    return messages.text(label_id)


def _colour_for(series: Series, siblings: tuple[str, ...], node: Chart, theme: str) -> str:
    """The concrete colour for one series, from the node's **declared** encoding.

    Never from the series count and never from the chart type (Req 22.7), and never from an
    array index (Req 22.8) — the aggregate is the one exception and it takes `--cat-other`,
    which is the muted neutral rather than a sixth hue.
    """
    if series.key == OTHER_SERIES_KEY:
        return style.hex_for_token(style.CAT_OTHER, theme)
    if node.encoding == "sequential":
        return style.hex_for_token(style.stroke_safe_token("sequential", theme), theme)
    return style.hex_for_token(style.color_for_key(series.key, siblings), theme)


def stack_without_overlap(values: Sequence[float], minimum_gap: float) -> list[float]:
    """`values`, in ascending order, lifted so no two sit closer together than
    `minimum_gap`.

    The arithmetic behind the direct line-end labels, separated from the drawing because
    this is the part with a right answer. Two idle machines both averaging 0.2% end their
    lines within a hair of each other, and labels drawn at their own heights print one over
    the other — the legend's failure mode, reproduced inside the thing Req 22.10 introduced
    to replace the legend.

    Each label is lifted only as far as clearing the one below it requires, and never
    lowered, so the lowest keeps its true position and the displacement above it is the
    least that separates them. A label may therefore sit slightly above the point it names,
    which is a smaller lie than two labels that cannot be read at all.

    Pure, total, and order-preserving: the caller sorts, this spaces, and the two are
    testable apart.
    """
    stacked: list[float] = []
    for value in values:
        height = value
        if stacked and height - stacked[-1] < minimum_gap:
            height = stacked[-1] + minimum_gap
        stacked.append(height)
    return stacked


def _draw_end_labels(
    axes,
    entries: Sequence[tuple[float, float, str, str]],
    *,
    offset: tuple[float, float] = (3, 0),
    align: str = "left",
    mono: bool = False,
    face: str = "",
) -> None:
    """Place the direct line-end labels, pushed apart where they would overlap.

    Req 22.10 makes these the primary way a reader tells two series apart, and the legend
    only a fallback. Two idle machines both averaging 0.2% end their lines within a
    hair of each other, so drawn at their own heights the two labels print one over the
    other — which is exactly the failure the direct labelling exists to avoid, reproduced
    inside it. The delivered chart showed it.

    The rule is the simplest one that terminates: sort by height, walk upward, and lift any
    label that would sit closer to the one below it than a line of text is tall. A label may
    therefore be drawn slightly above the point it names, which is a smaller lie than two
    labels that cannot be read at all — and the leader is the colour, which is unchanged.

    Measured in **display** space and converted back, because "a line of text is tall" is a
    typographic quantity and the data axis may be percentages or bytes.
    """
    if not entries:
        return

    figure = axes.get_figure()
    # A line of text at the label size, in data units: transform two display points that
    # differ by that many pixels and take the difference.
    line_px = style.CHART_LABEL_SIZE * figure.dpi / 72.0 * 1.25
    inverse = axes.transData.inverted()
    origin = inverse.transform((0.0, 0.0))
    stepped = inverse.transform((0.0, line_px))
    minimum_gap = abs(stepped[1] - origin[1])

    ordered = sorted(entries, key=lambda entry: entry[1])
    heights = stack_without_overlap([entry[1] for entry in ordered], minimum_gap)

    for (x, _value, text, colour), height in zip(ordered, heights, strict=True):
        axes.annotate(
            text,
            xy=(x, height),
            xytext=offset,
            textcoords="offset points",
            color=colour,
            ha=align,
            va="center",
            fontsize=style.CHART_LABEL_SIZE,
            annotation_clip=False,
            **({"fontfamily": face} if face else {}),
        )


def _furniture_for(preset: str, theme: str) -> style.ChartFurniture:
    """The chart's non-data ink, from the document's theme where there is one.

    Imported here rather than in `render/chartstyle.py`: that module's whole claim is that
    it is pure palette and colour conversion, and `render/themes.py` pulls python-docx.
    This module already draws, already imports matplotlib, and is the one that knows a
    chart is being rendered into a document at all.

    An unknown or empty preset falls back to the app's light/dark tokens, which is what a
    preview and every existing test render with — so a chart drawn without a preset is
    unchanged to the byte.
    """
    from reporting_agent.render.themes import THEME_SPECS

    spec = THEME_SPECS.get(preset)
    if spec is None:
        return style.furniture_for_theme(theme)
    return style.furniture_from_palette(
        ink=spec.palette.ink,
        muted=spec.palette.muted,
        rule=spec.palette.rule,
        accent=spec.palette.accent,
        heading_face=spec.face.heading,
        body_face=spec.face.body,
        figure_face=spec.face.figure,
    )


def _draw(
    axes,
    node: Chart,
    series_set: tuple[Series, ...],
    *,
    theme: str,
    messages: Messages,
    furniture: style.ChartFurniture | None = None,
    is_last_panel: bool = True,
) -> None:
    """Draw one panel's plotted set.

    `float(...)` on a plotted decimal string happens here and nowhere else. The result
    positions a mark and is discarded; it is never hashed and never emitted as text
    (Req 22.6), which is what keeps a float off the path from a snapshot value to a
    displayed string.

    `is_last_panel` decides whether this axes gets x-axis tick labels: `sharex=True`
    across the stacked subplots means every panel shares one x range, so repeating the
    labels on every panel would say the same thing `panel_count` times for no reason —
    only the bottom panel needs them (Req 17.3).
    """
    # The document's ink and faces where the caller knew which document; the app's tokens
    # otherwise. Resolved first because every text element below is set with it.
    ink = furniture if furniture is not None else style.furniture_for_theme(theme)

    # --- Axis titles (Req 17.1, 17.11) ----------------------------------------
    # Resolved from the message catalog. An absent id with a unit is acceptable;
    # a present id with no catalog value raises RENDER_FAILED.
    x_axis_title = _resolve_axis_title(node.x_axis_label_id, node=node, axis="x", messages=messages)
    y_axis_title = _resolve_axis_title(node.y_axis_label_id, node=node, axis="y", messages=messages)

    # --- Panel title (Req 17.5) -------------------------------------------------
    # The chart's own title (plus period) belongs to the WHOLE chart, so it is set
    # only once, on the top panel — repeating it on every panel would read as
    # `panel_count` separately titled charts stacked together rather than one
    # chart with `panel_count` panels. Every panel still states which series it
    # holds, so "a reader knows which is the maximum without a legend" — the
    # requirement's own phrasing — holds even on a panel with no chart title.
    panel_subtitle = ", ".join(dict.fromkeys(series.label for series in series_set))
    # The panel's own series, named quietly: this says which lines are here, and a reader
    # meets it after the chart's title rather than competing with it.
    axes.set_title(
        panel_subtitle,
        fontfamily=ink.body_face,
        fontsize=style.CHART_LABEL_SIZE,
        color=ink.axis_label,
        loc="left",
    )

    # Y-axis: combine title and **this panel's** unit.
    #
    # `node.unit` is chart-wide, and `_unit_of` picks the first series' unit where they
    # disagree — which is right for a chart node, whose `unit` describes the figure set as
    # a whole. It is wrong for an axis. Panels are grouped by magnitude, which in practice
    # groups by unit, so the panel holding `3,187,970,789.00 bytes` was labelled `percent`
    # because a percentage series happened to sort first on the chart.
    #
    # Falls back to the chart's unit for a panel whose points carry none, so a chart that
    # labelled its axis before still labels it the same way.
    panel_unit = next(
        (
            point.y.unit
            for series in series_set
            for point in series.points
            if point.y.unit
        ),
        node.unit,
    )
    axes.set_ylabel(
        f"{y_axis_title} ({panel_unit})" if y_axis_title else panel_unit,
        fontfamily=ink.body_face,
        fontsize=style.CHART_LABEL_SIZE,
        color=ink.axis_label,
    )

    # X-axis: title only on the last (bottom) panel — see `is_last_panel`'s note above.
    if x_axis_title and is_last_panel:
        axes.set_xlabel(x_axis_title)

    # --- Gridlines (Req 17.2) -------------------------------------------------
    axes.grid(True, axis="y", color=ink.grid, linewidth=style.CHART_GRID_WIDTH)
    # Labels without tick marks: the gridline already says where the value is, and a mark
    # beside it says the same thing twice.
    axes.tick_params(colors=ink.axis_label, length=0, labelsize=style.CHART_LABEL_SIZE - 0.5)

    # Three or four horizontals, not eight. The panel is there to show a shape; the
    # companion table is where a reader reads a number, and every one of them is in it.
    axes.yaxis.set_major_locator(MaxNLocator(nbins=4, prune=None))

    # matplotlib's `1e9` offset is the axis quietly restating the scale. It stays — a
    # reader needs it to know these are billions — but it is apparatus, not data.
    offset = axes.yaxis.get_offset_text()
    offset.set_color(ink.axis_label)
    offset.set_fontsize(style.CHART_LABEL_SIZE - 1)
    offset.set_fontfamily(ink.body_face)

    # Two rules, not four. A closed box draws a frame around every panel and then repeats it
    # `panel_count` times down the page, which reads as a stack of boxes rather than as one
    # chart; the top and right rules carry nothing a reader uses, because the scale is on the
    # left and the gridlines already carry the horizontals. What is left is an L: the value
    # axis and the baseline.
    for edge in ("top", "right"):
        axes.spines[edge].set_visible(False)
    for edge in ("left", "bottom"):
        axes.spines[edge].set_color(ink.grid)

    if not any(series.points for series in series_set):
        # Req 22.13 — the image says so too, not only the companion table.
        axes.text(
            0.5,
            0.5,
            messages.text(EMPTY_CHART_TEXT_ID),
            transform=axes.transAxes,
            ha="center",
            va="center",
            color=ink.axis_label,
        )
        axes.set_xticks([])
        axes.set_yticks([])
        return

    siblings = tuple(series.key for series in series_set)
    horizontal = node.chart_type == "hbar"
    end_labels: list[tuple[float, float, str, str]] = []
    end_values: list[tuple[float, float, str, str]] = []

    for slot, series in enumerate(series_set):
        colour = _colour_for(series, siblings, node, theme)
        labels = [point.x for point in series.points]
        # The one float boundary in this module.
        values = [float(Decimal(str(point.y.value))) for point in series.points]

        # Determine which points get direct labels (Req 17.4)
        labelled = label_indices(series.points)

        if node.chart_type in ("line", "area"):
            marker = style.marker_for_key(series.key, siblings)
            dashes = style.dash_for_key(series.key, siblings)
            # Markers every `stride` points rather than on all of them. At a month of
            # days the marks stop reading as a shape and start reading as a texture, which
            # is the opposite of what they are for.
            stride = max(1, len(values) // style.MARKER_STRIDE_TARGET)
            line, = axes.plot(
                range(len(values)),
                values,
                color=colour,
                marker=marker,
                markevery=stride,
                label=series.label,
            )
            if dashes is not None:
                line.set_dashes(list(dashes))
            if node.chart_type == "area":
                axes.fill_between(range(len(values)), values, color=colour, alpha=0.15)
            # Req 22.10 — a direct label at the line end, so the legend is a fallback.
            # Collected rather than drawn here: two series ending at nearly the same value
            # would otherwise print one label over the other, which is a legend's failure
            # mode reproduced in the thing meant to replace it. Placed once, below, where
            # every end position is known.
            end_labels.append(
                (len(values) - 1, values[-1], truncate_end_label(series.label), colour)
            )
            # Direct value labels at labelled indices (Req 17.4)
            for index in sorted(labelled):
                if index < len(values):
                    # The last point already carries the series label, three points to its
                    # right. A centred value there puts half its width into that gutter and
                    # the two overprint — the delivered chart read `2.32%` through
                    # `CPN-App — Percentage CPU (max)`. Right-aligning the final value hangs
                    # it back over the line it belongs to, which is also where a reader
                    # looking for it would follow the series.
                    if index == len(values) - 1:
                        # The final value sits where the series label does, and two series
                        # ending close together stack two numerals on one another the same
                        # way their labels did. Collected and placed with them.
                        end_values.append(
                            (index, values[index], series.points[index].y.formatted,
                             ink.value_label)
                        )
                        continue
                    axes.annotate(
                        series.points[index].y.formatted,
                        xy=(index, values[index]),
                        xytext=(0, 5),
                        textcoords="offset points",
                        ha="center",
                        va="bottom",
                        color=ink.value_label,
                        fontsize=style.CHART_LABEL_SIZE,
                        fontfamily=ink.figure_face,
                    )
            ticks = tick_label_positions(len(labels))
            axes.set_xticks(ticks)
            axes.set_xticklabels([labels[i] for i in ticks], rotation=45, ha="right")
        else:
            offset = _bar_offsets(len(series_set), slot)
            positions = [index + offset for index in range(len(values))]
            width = 0.8 / max(len(series_set), 1)
            if horizontal:
                axes.barh(positions, values, height=width, color=colour, label=series.label)
                axes.set_yticks(range(len(labels)))
                axes.set_yticklabels(labels)
            else:
                axes.bar(positions, values, width=width, color=colour, label=series.label)
                ticks = tick_label_positions(len(labels))
                axes.set_xticks(ticks)
                axes.set_xticklabels(
                    [labels[i] for i in ticks], rotation=45, ha="right"
                )
            # Req 17.4 — a direct value label on labelled bars.
            for index, (position, value, point) in enumerate(
                zip(positions, values, series.points, strict=True)
            ):
                if index not in labelled:
                    continue
                axes.annotate(
                    point.y.formatted,
                    xy=(value, position) if horizontal else (position, value),
                    xytext=(3, 0) if horizontal else (0, 3),
                    textcoords="offset points",
                    ha="left" if horizontal else "center",
                    va="center" if horizontal else "bottom",
                    color=ink.value_label,
                    fontsize=style.CHART_LABEL_SIZE,
                    fontfamily=ink.figure_face,
                )

    # The numerals first, hung back over the line they belong to; then the series labels in
    # the gutter. Both de-overlapped, and separately, because they occupy different columns.
    _draw_end_labels(
        axes, end_values, offset=(-4, 0), align="right", mono=True, face=ink.figure_face
    )
    _draw_end_labels(axes, end_labels, face=ink.body_face)

    # --- Legend (Req 17.3) — the fallback, and only when it is one -------------
    #
    # Req 22.10 makes the direct label at each line end the primary way a reader tells
    # two series apart and calls the legend a *fallback*. Drawn unconditionally it was
    # not a fallback but a second label, boxed at `upper right` — on top of the plotted
    # lines, and on top of the very end labels it duplicated.
    #
    # So it is drawn only when the direct labels are **not** there to be read: a line or
    # area panel annotates every non-empty series at its line end, and a bar panel
    # annotates none. `label_indices` is what decides that, so ask it rather than
    # restating the rule and letting the two drift.
    directly_labelled = node.chart_type in ("line", "area") and all(
        label_indices(series.points) for series in series_set
    )
    if len(series_set) > 1 and not directly_labelled:
        axes.legend(
            loc="upper right",
            fontsize=style.CHART_LABEL_SIZE,
            framealpha=0.8,
        )


_TITLE_BAND_INCHES: Final[float] = 0.8
"""Space above the first panel, for the chart title and its breathing room."""

_XLABEL_BAND_INCHES: Final[float] = 0.95
"""Space below the last panel, for the rotated date labels and the axis title.

Both are absolute because what they hold is: a line of 7pt type rotated 45 degrees
occupies the same inch whether it sits under one panel or five."""

_TITLE_LEFT: Final[float] = 0.12
"""The chart title's left edge, in figure coordinates — the same `left` the axes take, so
the title starts where the plot does rather than floating over the y-axis labels."""

_AXES_RIGHT: Final[float] = 0.74
"""Where the axes stop, leaving the rest of the figure width as the end-label gutter."""

END_LABEL_MAX_CHARS: Final[int] = 30
"""How many characters of a series label fit in the right gutter.

The gutter is `1 - _AXES_RIGHT` of `CHART_WIDTH_INCHES` — 0.26 x 6.0in = 1.56in — and a
character of the 7pt label face averages about half its point size, so 1.56in / (3.5pt)
is a little over 30 characters. Counted rather than measured **on purpose**: measuring
rendered text is what `subplots_adjust`'s own note rules out, because a font metric read
at render time makes the emitted PNG host-dependent.
"""

_ELLIPSIS: Final[str] = "\u2026"

MAX_X_TICK_LABELS: Final[int] = 12
"""The most x tick labels one panel prints.

A 31-day window ticked at every point produces 31 rotated labels in 6 inches — about
0.19in each — which overlap into an unreadable diagonal band. Every k-th label, where k
is chosen so at most this many survive, keeps them legible; the companion table carries
every point's x value regardless (Req 22.1), so nothing is lost by not printing them all.
"""


def truncate_end_label(label: str, budget: int = END_LABEL_MAX_CHARS) -> str:
    """`label` shortened to `budget` characters, keeping both ends.

    Middle-elided rather than tail-truncated because the **tail is what distinguishes
    two series of one resource**: "CPN-App - Percentage CPU (avg)" and
    "... (max)" differ only in their last five characters, so cutting the tail turns two
    series into one label and the chart into a chart a reader cannot read. The head is
    kept because that is where the resource name is.

    Pure and total over any string and any budget >= 2.
    """
    if len(label) <= budget:
        return label
    if budget < 2:
        return label[:budget]
    keep = budget - 1  # one code point spent on the ellipsis
    head = (keep + 1) // 2
    tail = keep - head
    return f"{label[:head]}{_ELLIPSIS}{label[len(label) - tail:]}" if tail else f"{label[:head]}{_ELLIPSIS}"


def tick_label_positions(count: int, maximum: int = MAX_X_TICK_LABELS) -> list[int]:
    """Which of `count` x positions carry a printed tick label.

    Every k-th index from 0, with k the smallest step that brings the total to `maximum`
    or fewer. Integer arithmetic over one integer, so it is as deterministic as the
    plotted order it indexes into.
    """
    if count <= 0:
        return []
    if count <= maximum:
        return list(range(count))
    step = -(-count // maximum)  # ceil
    return list(range(0, count, step))


def _bar_offsets(series_count: int, slot: int) -> float:
    """Where one series' bars sit within a grouped cluster.

    Pure geometry over two integers, so it is deterministic and carries no data.
    """
    if series_count <= 1:
        return 0.0
    width = 0.8 / series_count
    return -0.4 + width / 2 + slot * width


assert matplotlib.get_backend().lower() == "agg", (
    f"matplotlib resolved the {matplotlib.get_backend()!r} backend; the package "
    f"__init__ pins Agg, and any other backend renders non-reproducibly"
)
