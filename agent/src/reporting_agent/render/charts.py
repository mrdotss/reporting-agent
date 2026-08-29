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
from typing import Final

import matplotlib
from matplotlib import rc_context
from matplotlib.figure import Figure as MplFigure

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

__all__ = [
    "CHART_ALT_TEXT_PREFIX",
    "EMPTY_CHART_TEXT_ID",
    "OTHER_SERIES_KEY",
    "OTHER_SERIES_LABEL_ID",
    "QUALIFIER",
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
]

CHART_ALT_TEXT_PREFIX: Final[str] = "Chart "
"""Prefixes the identity in the image's alt text, so the attribute reads as a description
rather than as a bare token while still carrying the identity verbatim."""

SIDECAR_SUFFIX: Final[str] = ".chart.json"

EMPTY_CHART_TEXT_ID: Final[str] = "doc.chart.empty"
"""Req 22.13 — resolved through the message catalog so the indication appears in the
document's pinned language. A chart that vanished is indistinguishable in the delivered
document from a chart the author never configured."""

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
    """Every plotted point of every plotted series — one row per x, one column per series.

    No sampling, no thinning, no re-rounding (Req 22.1): the cell text is the ledger's
    `formatted` string, and the set of figures is exactly the plotted set. A table that
    showed a subset would let the image assert something the table could not confirm.

    Its path is the chart node's own, so its identity is `cht:<path>` — the same identity
    written into the image's alt text. That is the pairing key, and deriving both from the
    node's path means they cannot disagree.

    ## Why the x axis is the rows

    Req 22.1 demands every point; it does not say in what arrangement. There are at most
    five series — Req 22.9's cap makes that structural — and there are as many x values as
    the period has days. So the short dimension is the series and the long one is the x,
    and the table is **six columns wide at the very most, whatever the period holds**.

    That is the second arrangement tried and the first that both fits and reads. One row
    per (series, point) was 93 rows for three machines over July, with the key column
    repeating the series name beside an x the next column already held. Transposing it the
    other way — a row per series, a column per x — collapsed that to three rows and
    **thirty-two columns**, which LibreOffice lays out too narrow for the text to reach the
    converted PDF: a real July run returned 146 `pdf_figure_missing` findings, every figure
    of this table, on a `.docx` whose own twenty tables all resolved.

    Measured against real LibreOffice at a month of days: ten columns render and eleven do
    not. Six is the worst this can reach, which is why the cap is load-bearing here and not
    only on the image.

    ## Both addresses are the document's own text

    The verifier resolves a cell by `(row_key, column_key)`, and reads both **out of the
    `.docx`** — the key column's emitted text and the column's header text. An x is unique
    among rows and a series label is unique among columns, so this arrangement addresses
    every figure without a key that repeats. The previous shape had to concatenate the x
    into the series label for exactly that reason; here the two dimensions do it.

    A series with no point at some x gets an `EmptyCell` — `day_series` omits a day it has
    no value for rather than zero-filling it, and the distinction between "measured zero"
    and "not measured" is one this table has no business collapsing.

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


def render_chart(node: Chart, *, table_style: str, theme: str = "light", messages: Messages) -> ChartArtifacts:
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

    with rc_context(style.frozen_rc_params()):
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
        figure.suptitle(
            title_text, fontfamily=style.CHART_FONT, fontsize=style.CHART_TITLE_SIZE
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
            figure.subplots_adjust(
                left=0.12, right=_AXES_RIGHT, top=0.86, bottom=0.28, hspace=0.5
            )

            buffer = io.BytesIO()
            figure.savefig(
                buffer,
                format="png",
                dpi=style.CHART_DPI,
                metadata=dict(style.PNG_METADATA),
                facecolor="white",
            )
        finally:
            # Explicit, because a Figure created directly is not registered with pyplot and
            # would otherwise be reclaimed only by the collector — which under a long run is
            # a slow leak of several megabytes per chart.
            figure.clear()
        image = buffer.getvalue()

    return ChartArtifacts(
        image_png=image,
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


def _draw(
    axes,
    node: Chart,
    series_set: tuple[Series, ...],
    *,
    theme: str,
    messages: Messages,
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
    axes.set_title(
        panel_subtitle, fontfamily=style.CHART_FONT, fontsize=style.CHART_LABEL_SIZE
    )

    # Y-axis: combine title and unit
    if y_axis_title:
        axes.set_ylabel(f"{y_axis_title} ({node.unit})")
    else:
        axes.set_ylabel(node.unit)

    # X-axis: title only on the last (bottom) panel — see `is_last_panel`'s note above.
    if x_axis_title and is_last_panel:
        axes.set_xlabel(x_axis_title)

    # --- Gridlines (Req 17.2) -------------------------------------------------
    axes.grid(True, axis="y", color=style.grid_color(theme), linewidth=style.CHART_GRID_WIDTH)
    axes.tick_params(colors=style.axis_label_color(theme))
    for spine in axes.spines.values():
        spine.set_color(style.grid_color(theme))

    if not any(series.points for series in series_set):
        # Req 22.13 — the image says so too, not only the companion table.
        axes.text(
            0.5,
            0.5,
            messages.text(EMPTY_CHART_TEXT_ID),
            transform=axes.transAxes,
            ha="center",
            va="center",
            color=style.axis_label_color(theme),
        )
        axes.set_xticks([])
        axes.set_yticks([])
        return

    siblings = tuple(series.key for series in series_set)
    horizontal = node.chart_type == "hbar"

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
            line, = axes.plot(
                range(len(values)),
                values,
                color=colour,
                marker=marker,
                label=series.label,
            )
            if dashes is not None:
                line.set_dashes(list(dashes))
            if node.chart_type == "area":
                axes.fill_between(range(len(values)), values, color=colour, alpha=0.15)
            # Req 22.10 — a direct label at the line end, so the legend is a fallback.
            axes.annotate(
                truncate_end_label(series.label),
                xy=(len(values) - 1, values[-1]),
                xytext=(3, 0),
                textcoords="offset points",
                color=colour,
                va="center",
                fontsize=style.CHART_LABEL_SIZE,
            )
            # Direct value labels at labelled indices (Req 17.4)
            for index in sorted(labelled):
                if index < len(values):
                    axes.annotate(
                        series.points[index].y.formatted,
                        xy=(index, values[index]),
                        xytext=(0, 5),
                        textcoords="offset points",
                        ha="center",
                        va="bottom",
                        color=style.value_label_color(theme),
                        fontsize=style.CHART_LABEL_SIZE,
                        fontfamily="monospace",
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
                    color=style.value_label_color(theme),
                    fontsize=style.CHART_LABEL_SIZE,
                    fontfamily="monospace",
                )

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
