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
    Figure,
    Row,
    Series,
    Table,
    TextCell,
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
    "SERIES_COLUMN_KEY",
    "SIDECAR_SUFFIX",
    "VALUE_COLUMN_KEY",
    "X_COLUMN_KEY",
    "ChartArtifacts",
    "chart_data_hash",
    "companion_table",
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
    """Every plotted point of every plotted series, as a data table.

    No sampling, no thinning, no re-rounding (Req 22.1): the cell text is the ledger's
    `formatted` string, and the row set is exactly the plotted set. A table that showed a
    subset would let the image assert something the table could not confirm.

    Its path is the chart node's own, so its identity is `cht:<path>` — the same identity
    written into the image's alt text. That is the pairing key, and deriving both from the
    node's path means they cannot disagree.

    A chart with nothing to plot gets the explicit no-resources-matched row (Req 22.13),
    keyed the way `render/docx.py` recognises a notice row so it is styled as information
    rather than as a failure.

    `messages` is **required** rather than optional. A `None` default silently renders
    English copy, which is the exact outcome criterion 15.11 exists to prevent — reachable
    today by omission. Every call site supplies the run's pinned messages explicitly, and
    the tests are what make the update cheap.
    """

    columns = (
        Column(key=SERIES_COLUMN_KEY, header=messages.text("doc.table.period")),
        Column(key=X_COLUMN_KEY, header=messages.text("chart.axis.time")),
        Column(key=VALUE_COLUMN_KEY, header=messages.text("doc.table.value")),
    )

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

    rows: list[Row] = []
    for series in series_set:
        for point in series.points:
            # The row key the verifier resolves by is the key column's text, and the key
            # column here is the series label — so the x value goes into it too, because a
            # multi-series chart repeats every x.
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

    data_hash = chart_data_hash(node, messages=messages)
    series_set = plotted_series(node, messages=messages)

    with rc_context(style.frozen_rc_params()):
        figure = MplFigure(figsize=style.CHART_SIZE_INCHES, dpi=style.CHART_DPI)
        axes = figure.add_subplot(111)
        try:
            _draw(axes, node, series_set, theme=theme, messages=messages)
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


def _draw(axes, node: Chart, series_set: tuple[Series, ...], *, theme: str, messages: Messages) -> None:
    """Draw the plotted set.

    `float(...)` on a plotted decimal string happens here and nowhere else. The result
    positions a mark and is discarded; it is never hashed and never emitted as text
    (Req 22.6), which is what keeps a float off the path from a snapshot value to a
    displayed string.
    """
    axes.set_title(node.title)
    axes.set_ylabel(node.unit)
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
                series.label,
                xy=(len(values) - 1, values[-1]),
                xytext=(3, 0),
                textcoords="offset points",
                color=colour,
                va="center",
                fontsize=style.CHART_LABEL_SIZE,
            )
            axes.set_xticks(range(len(labels)))
            axes.set_xticklabels(labels, rotation=45, ha="right")
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
                axes.set_xticks(range(len(labels)))
                axes.set_xticklabels(labels, rotation=45, ha="right")
            # Req 22.10 — a direct value label on every bar.
            for position, value, point in zip(positions, values, series.points, strict=True):
                axes.annotate(
                    point.y.formatted,
                    xy=(value, position) if horizontal else (position, value),
                    xytext=(3, 0) if horizontal else (0, 3),
                    textcoords="offset points",
                    ha="left" if horizontal else "center",
                    va="center" if horizontal else "bottom",
                    color=style.axis_label_color(theme),
                    fontsize=style.CHART_LABEL_SIZE,
                )

    # Fixed rather than tight_layout(): `tight_layout` measures rendered text, so its result
    # depends on font metrics and would make the emitted bytes host-dependent.
    axes.figure.subplots_adjust(left=0.12, right=0.86, top=0.86, bottom=0.28)


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
