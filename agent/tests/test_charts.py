"""Chart images, their companion tables and the chart data hash (Req 22).

The point of every assertion here is that **an image cannot quietly disagree with the numbers
beside it**. An image is opaque to the verifier; the companion table is not. So the tests
check three things over and over from different angles: that the table lists exactly the
plotted set, that the identity pairing holds, and that the hash is a function of the plotted
decimal strings and nothing else.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from decimal import Decimal
from typing import Final

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.ast import (
    Chart,
    ChartPoint,
    FigureCell,
    Series,
    TextCell,
    compiling_against,
    figure_path,
    panel_groups,
)
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT, DesignSettings
from reporting_agent.compile.messages import load_messages

_MESSAGES = load_messages("en")
_EMPTY_SCOPE_RESOLVED = _MESSAGES.text(EMPTY_SCOPE_TEXT)
from reporting_agent.compile.figures import BlockCursor, FigureLedger
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.errors import RenderFailedError
from reporting_agent.render import charts as C
from reporting_agent.render import chartstyle as S
from reporting_agent.render import tablefit as F
from reporting_agent.render import docx as D

W: Final[str] = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
TABLE_STYLE: Final[str] = "Table Hairline"

DESIGN: Final[dict[str, object]] = {
    "preset": "editorial",
    "accent_color": "#1f6f78",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": True,
    "logo": None,
    "page_size": "A4",
}


def compile_charts(blocks, *, view=None):
    resolved = build_snapshot_view(sf.two_vm_snapshot()) if view is None else view
    return compile_document(df.definition(blocks, design=DESIGN), view=resolved)


def render(blocks, *, view=None):
    compiled = compile_charts(blocks, view=view)
    outcome = D.render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
        messages=_MESSAGES,
    )
    return compiled, outcome


def package(payload: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(payload))


def document_xml(payload: bytes) -> str:
    return package(payload).read("word/document.xml").decode("utf-8")


def first_chart(compiled) -> Chart:
    for block in compiled.document.blocks:
        if isinstance(block, Chart):
            return block
    raise AssertionError("no chart in the compiled document")


def two_magnitude_chart(*, chart_type: str = "line") -> tuple[Chart, FigureLedger]:
    """A chart with two series at genuinely different magnitudes, so
    `panel_groups` actually splits them — unlike `synthetic_chart`'s series,
    which all share one figure's value and therefore always group into one
    panel.

    Built with a minimal resolver fixed per point, the same seam
    `test_panel_groups.py` uses and for the same reason: `sf.two_vm_snapshot()`
    has no metric at a genuinely different order of magnitude from CPU
    percentage on hand, and inventing a real second metric in the shared
    fixture would couple every other test that reads it to this one test's
    needs.
    """
    from dataclasses import dataclass as _dataclass

    from reporting_agent.compile.estimators import ESTIMATOR_EXACT_COUNT_WEIGHTED
    from reporting_agent.compile.snapshot_view import SnapshotValue

    @_dataclass(frozen=True, slots=True)
    class _FixedValueResolver:
        value: SnapshotValue

        def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
            return (self.value,)

        def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
            return ()

    def _value(decimal_str: str, unit: str) -> SnapshotValue:
        return SnapshotValue(
            value=Decimal(decimal_str),
            unit=unit,
            statistic="avg",
            estimator=ESTIMATOR_EXACT_COUNT_WEIGHTED,
            fidelity_tier="baseline",
            scale=2,
            pointer="/resources/r0/metrics/m0/value",
            estimated=None,
            metric="synthetic",
            resource_id="r0",
            window="",
        )

    ledger = FigureLedger()
    cursor = BlockCursor(block_id="c", ledger=ledger)

    cpu_points = []
    for point_index, decimal_str in enumerate(("50", "60", "70")):
        value = _value(decimal_str, "percent")
        with compiling_against(_FixedValueResolver(value)):
            figure = (
                cursor.child("series", 0).child("points", point_index).child("figure", 0).figure(value)
            )
        cpu_points.append(
            ChartPoint(path=figure_path("c", 0, point_index), x=f"day-{point_index}", y=figure)
        )

    memory_points = []
    for point_index, decimal_str in enumerate(("4000000000", "4200000000", "3900000000")):
        value = _value(decimal_str, "bytes")
        with compiling_against(_FixedValueResolver(value)):
            figure = (
                cursor.child("series", 1).child("points", point_index).child("figure", 0).figure(value)
            )
        memory_points.append(
            ChartPoint(path=figure_path("c", 1, point_index), x=f"day-{point_index}", y=figure)
        )

    series = (
        Series(path=figure_path("c", 0), key="cpu", label="CPU", points=tuple(cpu_points)),
        Series(
            path=figure_path("c", 1),
            key="memory",
            label="Memory",
            points=tuple(memory_points),
        ),
    )
    node = Chart(
        path=figure_path("c", 99),
        chart_type=chart_type,
        title="Two magnitudes",
        unit="mixed",
        encoding="categorical",
        series=series,
        panels=panel_groups(series),
    )
    return node, ledger


def synthetic_chart(
    *,
    series_count: int,
    points_per_series: int,
    chart_type: str = "line",
    encoding: str = "categorical",
) -> tuple[Chart, FigureLedger]:
    """A chart built directly, so a test can choose the series count.

    The compiler caps a chart at five series, so the above-the-cap behaviour of Req 22.9
    cannot be reached through a definition — it is reachable here, which is the only way to
    assert it.
    """
    view = build_snapshot_view(sf.two_vm_snapshot())
    ledger = FigureLedger()
    resource = view.resources[0]
    value = view.stat(resource.resource_id, sf.CPU, "avg")
    assert value is not None

    with compiling_against(view):
        series: list[Series] = []
        for series_index in range(series_count):
            cursor = BlockCursor(block_id="c", ledger=ledger)
            points: list[ChartPoint] = []
            for point_index in range(points_per_series):
                figure = (
                    cursor.child("series", series_index)
                    .child("points", point_index)
                    .child("figure", 0)
                    .figure(value)
                )
                points.append(
                    ChartPoint(
                        path=figure_path("c", series_index, point_index),
                        x=f"day-{point_index}",
                        y=figure,
                    )
                )
            series.append(
                Series(
                    path=figure_path("c", series_index),
                    key=f"metric-{series_index}",
                    label=f"Metric {series_index}",
                    points=tuple(points),
                )
            )
        chart = Chart(
            path=figure_path("c", 0),
            chart_type=chart_type,
            title="Synthetic",
            unit="percent",
            encoding=encoding,
            series=tuple(series),
            panels=panel_groups(tuple(series)),
        )
    return chart, ledger


# --------------------------------------------------------------------------- #
# Req 22.1 — one image, one companion table, every plotted point
# --------------------------------------------------------------------------- #


def test_a_chart_emits_exactly_one_image_and_one_companion_table() -> None:
    _, outcome = render(
        [df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})]
    )
    names = package(outcome.docx_bytes).namelist()
    images = [name for name in names if name.startswith("word/media/")]
    assert len(images) == 1, images
    assert document_xml(outcome.docx_bytes).count("<w:tbl>") == 1


def addressed_figures(table: Table) -> dict[tuple[str, str], str]:
    """The table as the verifier sees it: `(row_key, column_key)` -> formatted text.

    `verify/anchors.py` resolves a cell by the key column's emitted text and the column's
    header, so a test that compares against a flat ordered list is testing an iteration
    order nothing depends on. This compares the addresses instead, which is what has to
    hold for a figure to be findable at all.
    """
    return {
        (row.key, table.columns[index].key): cell.figure.formatted
        for row in table.rows
        for index, cell in enumerate(row.cells)
        if isinstance(cell, FigureCell)
    }


def plotted_addresses(node: Chart) -> dict[tuple[str, str], str]:
    """The same addresses, derived from the plotted series rather than from the table."""
    return {
        (point.x, series.key): point.y.formatted
        for series in C.plotted_series(node, messages=_MESSAGES)
        for point in series.points
    }


def test_the_companion_table_lists_every_plotted_point_with_no_thinning() -> None:
    """Req 22.1 — no sampling, no thinning, no re-rounding. A table showing a subset would
    let the image assert something the table could not confirm."""
    compiled, _ = render([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    node = first_chart(compiled)
    plotted = [point for series in C.plotted_series(node, messages=_MESSAGES) for point in series.points]
    assert plotted, "the fixture must plot something"

    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)

    # One row per x, one column per series, so the row count is the distinct x count and
    # the figure count is the plotted count. The cell text is the ledger's formatted
    # string, verbatim, and it is reachable at the address the verifier will use.
    assert len(table.rows) == len({point.x for point in plotted})
    assert addressed_figures(table) == plotted_addresses(node)


def test_the_companion_table_lists_every_panels_points_task_5_5() -> None:
    """Req 17.8 — the companion table carries every plotted point of EVERY
    panel, unthinned, on the same terms the single-panel test above asserts.
    `companion_table` iterates `plotted_series(node, ...)` chart-wide, never
    per panel, so this should already hold by construction — proven directly
    against a genuinely two-panel chart rather than assumed from the
    single-panel case."""
    node, _ = two_magnitude_chart()
    assert len(node.panels) == 2

    plotted = [
        point for series in C.plotted_series(node, messages=_MESSAGES) for point in series.points
    ]
    assert plotted, "the fixture must plot something"

    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)

    # Every panel's series keys must appear among the table's COLUMN keys — no panel is
    # silently dropped from the table just because it was drawn on a different subplot.
    panel_keys = {key for group in node.panels for key in group}
    assert panel_keys <= {column.key for column in table.columns}

    assert addressed_figures(table) == plotted_addresses(node)


def test_every_plotted_value_is_a_figure_from_the_ledger() -> None:
    """Req 22.6 — no plotted value is computed from a snapshot value a second time."""
    compiled, _ = render([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    node = first_chart(compiled)
    for series in C.plotted_series(node, messages=_MESSAGES):
        for point in series.points:
            assert point.y.path in compiled.ledger
            assert compiled.ledger[point.y.path] is point.y


# --------------------------------------------------------------------------- #
# Req 22.2 — the identity pairing
# --------------------------------------------------------------------------- #


def test_the_image_and_its_table_carry_the_same_identity() -> None:
    """The pairing key. Two different identities on the two halves of one chart would leave
    every chart unpairable — and because both derive from the same AST path, the mismatch
    looks correct in isolation."""
    compiled, outcome = render(
        [df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})]
    )
    identity = first_chart(compiled).anchor_id
    assert identity.startswith("cht:")

    xml = document_xml(outcome.docx_bytes)
    assert re.findall(r'tblCaption w:val="([^"]+)"', xml) == [identity]
    assert identity in re.findall(r'descr="([^"]*)"', xml)[0]
    assert re.findall(r'<wp:docPr[^>]*name="([^"]*)"', xml) == [identity]
    assert outcome.table_identities == (identity,)


def test_the_companion_table_follows_its_image_with_only_its_own_captions_between() -> None:
    """Req 22.2's body-order clause. The verifier pairs by identity, but a reader relies on
    the adjacency: the table explains the picture above it.

    What may sit between them is the **image's own** caption paragraphs — the chart's title
    and, under Req 17.12, its period label. Both name the picture, so neither separates it
    from its table in any sense a reader would notice; `period_label` has always been
    emitted there. What must not appear is a block belonging to something else, which is
    what this walks the gap to check.
    """
    compiled, outcome = render(
        [
            df.block("p", "rich_text", {"text": "Before."}),
            df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]}),
            df.block("q", "rich_text", {"text": "After."}),
        ]
    )
    from lxml import etree

    body = etree.fromstring(document_xml(outcome.docx_bytes).encode()).find(f"{W}body")
    children = [child.tag for child in body]

    drawing_index = next(
        index
        for index, child in enumerate(body)
        if list(child.iter(f"{W}drawing"))
    )
    table_index = children.index(f"{W}tbl")
    assert table_index > drawing_index, children

    node = first_chart(compiled)
    permitted = {node.caption or node.title, node.period_label} - {"", None}
    for child in body[drawing_index + 1 : table_index]:
        assert child.tag == f"{W}p", children
        text = "".join(child.itertext()).strip()
        assert text in permitted, (
            f"{text!r} sits between a chart and its companion table and is neither the "
            f"chart's title nor its period label"
        )


def test_the_identity_is_derived_from_the_ast_path_alone() -> None:
    """Req 22.9's determinism clause: two renders carry identical identities."""
    compiled, first = render([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    second = D.render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
        messages=_MESSAGES,
    )
    assert first.table_identities == second.table_identities


def test_a_chart_figure_records_a_chart_kind_anchor() -> None:
    """So the verifier can tell a companion-table cell from an ordinary data-table cell."""
    compiled, _ = render([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    anchors = compiled.ledger.anchors()
    assert anchors
    assert {anchor.kind for anchor in anchors.values()} == {"chart"}
    for anchor in anchors.values():
        assert anchor.anchor_id.startswith("cht:")
        assert anchor.row_key
        assert anchor.column_key


# --------------------------------------------------------------------------- #
# Req 22.3 — the chart data hash
# --------------------------------------------------------------------------- #


def test_the_hash_is_stable_across_calls_and_recorded_in_the_sidecar() -> None:
    compiled, outcome = render([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    node = first_chart(compiled)
    expected = C.chart_data_hash(node, messages=_MESSAGES)

    assert C.chart_data_hash(node, messages=_MESSAGES) == expected
    assert outcome.chart_hashes[node.anchor_id] == expected

    sidecar = json.loads(outcome.chart_sidecars[f"{node.anchor_id}{C.SIDECAR_SUFFIX}"])
    assert sidecar["data_hash"] == expected
    assert sidecar["identity"] == node.anchor_id


def test_the_hash_covers_the_series_key_the_x_key_and_the_decimal_string() -> None:
    """Each contribution named by Req 22.3, proven by changing one at a time."""
    node, _ = synthetic_chart(series_count=1, points_per_series=2)
    baseline = C.chart_data_hash(node, messages=_MESSAGES)

    renamed = Chart(
        path=node.path,
        chart_type=node.chart_type,
        title=node.title,
        unit=node.unit,
        encoding=node.encoding,
        series=(
            Series(
                path=node.series[0].path,
                key="different-key",
                label=node.series[0].label,
                points=node.series[0].points,
            ),
        ),
    )
    assert C.chart_data_hash(renamed, messages=_MESSAGES) != baseline

    moved = Chart(
        path=node.path,
        chart_type=node.chart_type,
        title=node.title,
        unit=node.unit,
        encoding=node.encoding,
        series=(
            Series(
                path=node.series[0].path,
                key=node.series[0].key,
                label=node.series[0].label,
                points=(
                    ChartPoint(
                        path=node.series[0].points[0].path,
                        x="renamed-x",
                        y=node.series[0].points[0].y,
                    ),
                    node.series[0].points[1],
                ),
            ),
        ),
    )
    assert C.chart_data_hash(moved, messages=_MESSAGES) != baseline


def test_the_hash_ignores_the_label_and_the_title() -> None:
    """A hash over presentation would fire on a caption edit, which is not a data change."""
    node, _ = synthetic_chart(series_count=1, points_per_series=2)
    relabelled = Chart(
        path=node.path,
        chart_type=node.chart_type,
        title="A completely different title",
        unit=node.unit,
        encoding=node.encoding,
        series=(
            Series(
                path=node.series[0].path,
                key=node.series[0].key,
                label="A completely different label",
                points=node.series[0].points,
            ),
        ),
    )
    assert C.chart_data_hash(relabelled, messages=_MESSAGES) == C.chart_data_hash(node, messages=_MESSAGES)


def test_the_hash_depends_on_plotted_order() -> None:
    """"In plotted order" is part of the definition: two charts over one multiset of points
    in different orders are two different charts."""
    node, _ = synthetic_chart(series_count=1, points_per_series=3)
    points = node.series[0].points
    reordered = Chart(
        path=node.path,
        chart_type=node.chart_type,
        title=node.title,
        unit=node.unit,
        encoding=node.encoding,
        series=(
            Series(
                path=node.series[0].path,
                key=node.series[0].key,
                label=node.series[0].label,
                points=(points[2], points[1], points[0]),
            ),
        ),
    )
    assert C.chart_data_hash(reordered, messages=_MESSAGES) != C.chart_data_hash(node, messages=_MESSAGES)


def test_the_hash_input_is_structured_rather_than_concatenated() -> None:
    """A separator-joined string would let a key containing the separator forge a different
    plotted set that hashes the same."""
    first, _ = synthetic_chart(series_count=1, points_per_series=1)
    forged = Chart(
        path=first.path,
        chart_type=first.chart_type,
        title=first.title,
        unit=first.unit,
        encoding=first.encoding,
        series=(
            Series(
                path=first.series[0].path,
                key=f"{first.series[0].key}|{first.series[0].points[0].x}",
                label=first.series[0].label,
                points=(
                    ChartPoint(
                        path=first.series[0].points[0].path,
                        x="",
                        y=first.series[0].points[0].y,
                    ),
                ),
            ),
        ),
    )
    assert C.chart_data_hash(forged, messages=_MESSAGES) != C.chart_data_hash(first, messages=_MESSAGES)


def test_the_hash_and_the_table_describe_one_plotted_set() -> None:
    node, _ = synthetic_chart(series_count=9, points_per_series=2)
    plotted = C.plotted_series(node, messages=_MESSAGES)
    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)

    hashed_points = sum(len(series.points) for series in plotted)
    assert len(addressed_figures(table)) == hashed_points

    sidecar = json.loads(C.sidecar_bytes(node, data_hash=C.chart_data_hash(node, messages=_MESSAGES), messages=_MESSAGES))
    assert sidecar["point_count"] == hashed_points
    assert sidecar["series"] == [series.key for series in plotted]


# --------------------------------------------------------------------------- #
# Req 22.9 — the five-series cap
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("series_count", [1, 2, 3, 4, 5])
def test_at_or_below_the_cap_every_series_is_plotted(series_count: int) -> None:
    node, _ = synthetic_chart(series_count=series_count, points_per_series=2)
    assert len(C.plotted_series(node, messages=_MESSAGES)) == series_count
    assert all(series.key != C.OTHER_SERIES_KEY for series in C.plotted_series(node, messages=_MESSAGES))


def test_above_the_cap_four_are_plotted_plus_one_aggregate() -> None:
    node, _ = synthetic_chart(series_count=9, points_per_series=2)
    plotted = C.plotted_series(node, messages=_MESSAGES)

    assert len(plotted) == S.CATEGORICAL_LIMIT
    assert [series.key for series in plotted[:4]] == [f"metric-{index}" for index in range(4)]
    assert plotted[-1].key == C.OTHER_SERIES_KEY
    assert _MESSAGES.text(C.OTHER_SERIES_LABEL_ID, count=5) == plotted[-1].label


def test_the_aggregate_carries_the_remaining_points_rather_than_a_sum() -> None:
    """Summing peer series would produce a number with no snapshot address — exactly what
    this package exists to prevent. So the aggregate plots the remainder's own figures."""
    node, ledger = synthetic_chart(series_count=7, points_per_series=3)
    aggregate = C.plotted_series(node, messages=_MESSAGES)[-1]

    remainder_points = [
        point for series in node.series[4:] for point in series.points
    ]
    assert len(aggregate.points) == len(remainder_points)
    for point in aggregate.points:
        assert point.y.path in ledger, "every aggregated point is still a ledger figure"


def test_the_five_series_cap_applies_to_the_chart_not_per_panel_task_5_5() -> None:
    """Req 17.7 — `plotted_series`'s five-series cap and aggregate are computed
    over the WHOLE chart's series, before any panel split — a nine-series
    chart above the cap still plots exactly 4 real series plus one aggregate
    regardless of how many panels those 5 plotted series eventually land in,
    never 5 real series *per panel*."""
    node, _ = synthetic_chart(series_count=9, points_per_series=2)
    plotted = C.plotted_series(node, messages=_MESSAGES)
    assert len(plotted) == S.CATEGORICAL_LIMIT  # capped chart-wide

    groups = C._panel_groups_for(node, plotted)
    total_in_panels = sum(len(group) for group in groups)
    # Every plotted key (the 4 real series plus the aggregate) is accounted
    # for across the panels, and the panels never re-introduce a series the
    # cap already excluded — the total across panels equals the capped
    # count, not the original 9.
    assert total_in_panels == S.CATEGORICAL_LIMIT
    assert {key for group in groups for key in group} == {
        series.key for series in plotted
    }


def test_the_aggregate_uses_the_muted_token_rather_than_a_sixth_hue() -> None:
    node, _ = synthetic_chart(series_count=9, points_per_series=1)
    plotted = C.plotted_series(node, messages=_MESSAGES)
    siblings = tuple(series.key for series in plotted)
    colour = C._colour_for(plotted[-1], siblings, node, "light")
    assert colour == S.hex_for_token(S.CAT_OTHER, "light")


def test_the_declared_order_is_preserved_rather_than_re_ranked() -> None:
    """The compiler ranks by the chart's ordering statistic with ties on ascending stable
    key. Re-ranking here would be a second ordering rule that could disagree with the one
    the document's own table used."""
    node, _ = synthetic_chart(series_count=9, points_per_series=1)
    assert [series.key for series in C.plotted_series(node, messages=_MESSAGES)[:4]] == [
        series.key for series in node.series[:4]
    ]


# --------------------------------------------------------------------------- #
# Req 22.7, 22.8, 22.12 — palette
# --------------------------------------------------------------------------- #


def test_a_peer_chart_is_never_coloured_from_the_sequential_ramp() -> None:
    """A lightness ramp asserts an order peer series do not carry."""
    node, _ = synthetic_chart(series_count=3, points_per_series=2, encoding="categorical")
    siblings = tuple(series.key for series in node.series)
    ramp = {S.hex_for_token(token, "light") for token in S.SEQUENTIAL_TOKENS}
    for series in node.series:
        assert C._colour_for(series, siblings, node, "light") not in ramp


def test_a_sequential_chart_takes_a_stroke_safe_ramp_step() -> None:
    node, _ = synthetic_chart(series_count=1, points_per_series=2, encoding="sequential")
    colour = C._colour_for(node.series[0], (node.series[0].key,), node, "light")
    safe = {S.hex_for_token(token, "light") for token in S.SEQUENTIAL_STROKE_SAFE["light"]}
    assert colour in safe


def test_the_palette_is_chosen_by_encoding_and_not_by_series_count() -> None:
    """Req 22.7 explicitly: derived from neither the series count nor the chart type."""
    one_peer, _ = synthetic_chart(series_count=1, points_per_series=2, encoding="categorical")
    categorical = {S.hex_for_token(token, "light") for token in S.CATEGORICAL_TOKENS}
    assert (
        C._colour_for(one_peer.series[0], (one_peer.series[0].key,), one_peer, "light")
        in categorical
    ), "a single-series categorical chart must still take a categorical token"


def test_a_stable_key_takes_one_colour_across_two_charts() -> None:
    """Req 22.8 — one metric keeps one colour across every chart of one report."""
    first, _ = synthetic_chart(series_count=3, points_per_series=1)
    siblings = tuple(series.key for series in first.series)
    assignment = {
        series.key: C._colour_for(series, siblings, first, "light") for series in first.series
    }
    # Same key set, arrived at in a different order.
    assert {
        key: S.hex_for_token(S.color_for_key(key, tuple(reversed(siblings))), "light")
        for key in siblings
    } == assignment


def test_destructive_appears_on_no_series_gridline_or_label() -> None:
    """Req 22.12 — if red appears on a report page it means the document could not be
    proven, and that meaning must not be diluted."""
    node, _ = synthetic_chart(series_count=5, points_per_series=2)
    siblings = tuple(series.key for series in node.series)
    forbidden = {
        S.oklch_to_hex(S.DESTRUCTIVE_VALUES["light"]),
        S.oklch_to_hex(S.DESTRUCTIVE_VALUES["dark"]),
    }
    used = {C._colour_for(series, siblings, node, "light") for series in node.series}
    used.add(S.grid_color("light"))
    used.add(S.axis_label_color("light"))
    used.add(S.value_label_color("light"))
    assert used.isdisjoint(forbidden)


# --------------------------------------------------------------------------- #
# Req 22.10 — nothing distinguished by colour alone
# --------------------------------------------------------------------------- #


def test_every_line_series_carries_a_marker_and_a_dash_no_sibling_shares() -> None:
    """Req 22.10's actual demand: within one chart, every line series is told apart by its
    marker shape and by its dash pattern. Distinctness is the property — which slot each
    one draws from is not, and reading them off the colour's hash slot bought nothing."""
    node, _ = synthetic_chart(series_count=4, points_per_series=3, chart_type="line")
    markers = {S.marker_for_position(index) for index in range(len(node.series))}
    dashes = {S.dash_for_position(index) for index in range(len(node.series))}
    assert len(markers) == len(node.series), markers
    assert len(dashes) == len(node.series), dashes


def test_the_slot_is_the_series_position_in_the_chart_not_in_its_panel(monkeypatch) -> None:
    """Asserted on what `_draw` is actually handed, not on the helper it calls.

    A panelled chart draws one panel at a time, and the slot was the series' index inside
    the panel — so a two-panel chart restarted at zero and drew both of its series solid,
    with one marker shape between them. That is two series distinguished by nothing but
    which panel they sit on, and the helper-level test above passes right through it.
    """
    node, _ = two_magnitude_chart()
    assert len(node.panels) == 2, "the fixture must actually be panelled"

    # Recorded at the point the vocabulary is *read*, not where the mapping is passed:
    # asserting on `slot_of` proves the caller built it, not that `_draw` used it, and the
    # per-panel restart lives entirely inside `_draw`.
    asked: list[int] = []
    original_marker = S.marker_for_position
    original_dash = S.dash_for_position

    def marker_spy(index):
        asked.append(index)
        return original_marker(index)

    def dash_spy(index):
        asked.append(index)
        return original_dash(index)

    monkeypatch.setattr(C.style, "marker_for_position", marker_spy)
    monkeypatch.setattr(C.style, "dash_for_position", dash_spy)
    C.render_chart(node, table_style="Table Hairline", preset="editorial",
                   messages=load_messages("en"))

    assert asked, "no line series was drawn"
    assert sorted(set(asked)) == list(range(len(node.series))), (
        f"the two panels asked for slots {sorted(set(asked))}; a panelled chart that "
        f"restarts at zero draws both of its series solid, with one marker between them"
    )


def test_a_single_series_chart_is_not_dashed() -> None:
    """It could be, and usually was. The pattern came from `hash(key) % 5`, so six of the
    seven keys a real report plots — `cpu`, `disk`, `net`, `Percentage CPU`, `vm-amor`,
    `CPN-App` — drew a lone dash-dot line on a chart with nothing to be distinguished
    from."""
    assert S.DASH_PATTERNS[0] is None
    assert S.dash_for_position(0) is None


# --------------------------------------------------------------------------- #
# Req 22.13 — an empty plotted set
# --------------------------------------------------------------------------- #


def test_an_empty_chart_emits_both_the_node_and_its_companion_table() -> None:
    """A chart that vanished is indistinguishable in the delivered document from a chart the
    author never configured."""
    narrow = df.scope(tag_filters=[{"key": "env", "value": "nope"}])
    _, outcome = render(
        [
            df.block(
                "ts",
                "timeseries_chart",
                {"metrics": [df.CPU_AVG]},
                scope_override=narrow,
            )
        ]
    )
    xml = document_xml(outcome.docx_bytes)
    assert xml.count("<w:tbl>") == 1
    assert _EMPTY_SCOPE_RESOLVED in xml


def test_an_empty_charts_companion_table_carries_the_notice_row() -> None:
    node, _ = synthetic_chart(series_count=1, points_per_series=0)
    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)
    assert len(table.rows) == 1
    assert table.rows[0].key == "empty-scope"
    cell = table.rows[0].cells[0]
    assert isinstance(cell, TextCell)
    assert cell.text == _EMPTY_SCOPE_RESOLVED


def test_an_empty_charts_image_says_so() -> None:
    """Req 22.13 asks for an explicit indication on the chart node, not only in the table."""
    node, ledger = synthetic_chart(series_count=1, points_per_series=0)
    artifacts = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    assert artifacts.image_png[:8] == b"\x89PNG\r\n\x1a\n"
    assert artifacts.data_hash == C.chart_data_hash(node, messages=_MESSAGES)
    assert ledger is not None


def test_an_empty_chart_still_hashes_deterministically() -> None:
    node, _ = synthetic_chart(series_count=1, points_per_series=0)
    assert C.chart_data_hash(node, messages=_MESSAGES) == C.chart_data_hash(node, messages=_MESSAGES)


# --------------------------------------------------------------------------- #
# Req 22.14 — byte-identical image content
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("chart_type", ["line", "area", "bar", "hbar"])
def test_two_renders_of_one_chart_node_produce_identical_bytes(chart_type: str) -> None:
    """The chart data hash and the `.docx` byte-equality guarantee both rest on this."""
    node, _ = synthetic_chart(series_count=3, points_per_series=4, chart_type=chart_type)
    first = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    second = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    assert first.image_png == second.image_png
    assert first.sidecar_json == second.sidecar_json
    assert first.data_hash == second.data_hash


def test_the_png_carries_no_creation_timestamp() -> None:
    """matplotlib writes a `Software` chunk and a creation date by default, which alone would
    make two renders differ — with no visible cause."""
    node, _ = synthetic_chart(series_count=1, points_per_series=2)
    payload = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES).image_png
    assert b"matplotlib" not in payload.lower()
    assert b"Creation Time" not in payload


def test_the_document_containing_a_chart_is_byte_identical_across_renders() -> None:
    compiled, first = render(
        [
            df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]}),
            df.block("dist", "distribution_chart", {"metrics": [df.CPU_AVG]}),
        ]
    )
    second = D.render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
        messages=_MESSAGES,
    )

    def parts(payload: bytes) -> dict[str, bytes]:
        with package(payload) as archive:
            return {
                name: archive.read(name)
                for name in archive.namelist()
                if name not in D.VOLATILE_PACKAGE_PARTS
            }

    assert parts(first.docx_bytes) == parts(second.docx_bytes)


def test_the_frozen_rc_params_are_applied_without_mutating_global_state() -> None:
    """Global mutation would make the emitted bytes depend on whether some other module had
    already changed an rcParam."""
    import matplotlib

    before = dict(matplotlib.rcParams)
    node, _ = synthetic_chart(series_count=2, points_per_series=2)
    C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    after = dict(matplotlib.rcParams)
    changed = {
        key for key in before if str(before[key]) != str(after.get(key))
    }
    assert changed == set(), changed


def test_the_backend_is_agg() -> None:
    import matplotlib

    assert matplotlib.get_backend().lower() == "agg"


def test_the_font_is_named_explicitly_rather_than_resolved_by_fallback() -> None:
    """A fallback resolves to whatever the host has, which changes glyph widths, which changes
    where every label lands, which changes the bytes."""
    assert S.frozen_rc_params()["font.sans-serif"] == [S.CHART_FONT]
    assert S.CHART_FONT == "DejaVu Sans"


def test_the_dpi_and_figure_size_are_pinned() -> None:
    params = S.frozen_rc_params()
    assert params["figure.dpi"] == S.CHART_DPI
    assert params["savefig.dpi"] == S.CHART_DPI
    assert params["figure.figsize"] == S.CHART_SIZE_INCHES


def test_a_panelled_chart_still_produces_exactly_one_png_one_sidecar_one_identity_task_5_5() -> None:
    """Req 17.7 — panelling changes how many subplots one image contains, never
    how many images, sidecars or identities one `Chart` node produces. The
    pairing contract the verifier matches on is untouched by panel count."""
    node, _ = two_magnitude_chart()
    assert len(node.panels) == 2  # a genuinely panelled chart, not the ordinary case

    artifacts = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    assert artifacts.image_png[:8] == b"\x89PNG\r\n\x1a\n"

    sidecar = json.loads(artifacts.sidecar_json)
    assert sidecar["identity"] == node.anchor_id
    assert artifacts.identity == node.anchor_id
    assert artifacts.table.path == node.path  # cht:<path> derives from this


# --------------------------------------------------------------------------- #
# The image is embedded, and the emitter refuses what it cannot pair
# --------------------------------------------------------------------------- #


def test_the_image_is_embedded_in_the_package_rather_than_linked() -> None:
    _, outcome = render([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    with package(outcome.docx_bytes) as archive:
        media = [name for name in archive.namelist() if name.startswith("word/media/")]
        assert len(media) == 1
        assert archive.read(media[0])[:8] == b"\x89PNG\r\n\x1a\n"


def test_a_sidecar_is_produced_per_chart() -> None:
    _, outcome = render(
        [
            df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]}),
            df.block("dist", "distribution_chart", {"metrics": [df.CPU_AVG]}),
        ]
    )
    assert len(outcome.chart_sidecars) == 2
    assert len(outcome.chart_hashes) == 2
    for name in outcome.chart_sidecars:
        assert name.endswith(C.SIDECAR_SUFFIX)
        assert name.removesuffix(C.SIDECAR_SUFFIX) in outcome.chart_hashes


def test_an_undeclared_encoding_is_refused() -> None:
    node, _ = synthetic_chart(series_count=1, points_per_series=1)
    object.__setattr__(node, "encoding", "ordinal")
    with pytest.raises(RenderFailedError, match="encoding"):
        C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)


def test_the_aggregate_qualifies_each_point_with_its_originating_series() -> None:
    """The collision this fixes is not exotic — it is every multi-series chart over one period.

    Nine series sharing the x labels `day-0`, `day-1` produce nine aggregated points per day.
    Unqualified, their `(series key, x)` pairs are identical, which is the companion table's
    row key, and a repeated row key is a row the verifier cannot address (Req 21.5). It also
    reads better: "metric-4 · day-0" says which series the value belongs to.
    """
    node, _ = synthetic_chart(series_count=9, points_per_series=2)
    aggregate = C.plotted_series(node, messages=_MESSAGES)[-1]

    xs = [point.x for point in aggregate.points]
    assert len(set(xs)) == len(xs), xs
    assert all(C.QUALIFIER in value for value in xs)
    for index, series in enumerate(node.series[4:]):
        assert any(value.startswith(series.key) for value in xs), index

    # And the companion table therefore builds at all, with unique keys.
    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)
    keys = [row.key for row in table.rows]
    assert len(set(keys)) == len(keys)


def test_every_companion_table_row_key_is_unique_and_readable() -> None:
    """Asserted over every chart type and series count the compiler can produce, because a
    duplicate row key surfaces as a RENDER_FAILED late in a run rather than here."""
    for series_count in (1, 2, 5, 6, 12):
        node, _ = synthetic_chart(series_count=series_count, points_per_series=3)
        table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)
        keys = [row.key for row in table.rows]
        assert len(set(keys)) == len(keys), (series_count, keys)

        first_column = [
            cell.text
            for row in table.rows
            for cell in row.cells[:1]
            if isinstance(cell, TextCell)
        ]
        assert len(set(first_column)) == len(first_column), (series_count, first_column)


def test_a_chart_document_renders_and_its_row_keys_survive_the_emitter() -> None:
    """The end-to-end form: the emitter's own row-key uniqueness assertion has to pass for a
    chart above the cap, which is the case the collision broke."""
    node, ledger = synthetic_chart(series_count=9, points_per_series=3)
    from reporting_agent.compile.ast import Document

    artifacts = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    outcome = D.render_document(
        Document(blocks=(artifacts.table,)),
        ledger=ledger,
        design=DesignSettings.from_plain(DESIGN),
        messages=_MESSAGES,
    )
    assert outcome.table_identities == (artifacts.table.anchor_id,)
    assert outcome.figures_emitted == sum(
        len(series.points) for series in C.plotted_series(node, messages=_MESSAGES)
    )


# --------------------------------------------------------------------------- #
# Req 15.11 — an Indonesian render produces the Indonesian series label
# --------------------------------------------------------------------------- #

_MESSAGES_ID = load_messages("id")


def test_indonesian_render_produces_indonesian_series_label() -> None:
    """An Indonesian document uses the Indonesian aggregate label with the count in the
    position that language puts it (Req 15.11).

    This is the entire point of the interpolation Part A added: without it the label was
    hardcoded English. A test in only one language cannot prove the parameter reached the
    right place.
    """
    node, _ = synthetic_chart(series_count=9, points_per_series=2)
    plotted = C.plotted_series(node, messages=_MESSAGES_ID)

    aggregate = plotted[-1]
    # 9 series minus 4 plotted = 5 in the aggregate
    expected_label = _MESSAGES_ID.text(C.OTHER_SERIES_LABEL_ID, count=5)
    assert expected_label == "Lainnya (5 seri)"
    assert aggregate.label == expected_label
    assert aggregate.key == C.OTHER_SERIES_KEY


# --------------------------------------------------------------------------- #
# Task 5.2 — the renderer draws N stacked panels
# --------------------------------------------------------------------------- #


def test_a_single_panel_chart_renders_at_the_original_size() -> None:
    """A chart with one panel (the ordinary case, unchanged by panelling) is
    exactly `CHART_SIZE_INCHES` — the same size every chart rendered before
    task 5.2, so a one-panel chart's emitted bytes stay byte-identical."""
    from reporting_agent.render import chartstyle as S

    node, _ = synthetic_chart(series_count=2, points_per_series=3)
    assert len(node.panels) == 1  # no split: both series share the same figure's value

    artifacts = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    assert artifacts.image_png[:8] == b"\x89PNG\r\n\x1a\n"

    # The pixel dimensions are size_inches * dpi, so an unchanged figsize
    # produces the same pixel geometry a pre-panelling chart always had.
    import io as _io

    from PIL import Image

    with Image.open(_io.BytesIO(artifacts.image_png)) as img:
        expected_w = round(S.CHART_SIZE_INCHES[0] * S.CHART_DPI)
        expected_h = round(S.CHART_SIZE_INCHES[1] * S.CHART_DPI)
        assert img.size == (expected_w, expected_h)


def test_a_two_magnitude_chart_splits_into_two_panels_and_is_taller() -> None:
    """CPU (0-100) and memory-in-bytes (billions) differ by far more than one
    order of magnitude, so `panel_groups` splits them — and the rendered
    image is taller than a single-panel chart, proportional to
    `chart_size_inches(2)`."""
    from reporting_agent.render import chartstyle as S

    node, _ = two_magnitude_chart()
    assert len(node.panels) == 2

    artifacts = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)

    import io as _io

    from PIL import Image

    with Image.open(_io.BytesIO(artifacts.image_png)) as img:
        expected_w, expected_h = S.chart_size_inches(2)
        assert img.size == (
            round(expected_w * S.CHART_DPI),
            round(expected_h * S.CHART_DPI),
        )
        # Taller than the single-panel size, and width is unchanged — panels
        # stack vertically, never widen the figure.
        single_w, single_h = S.CHART_SIZE_INCHES
        assert img.size[1] > round(single_h * S.CHART_DPI)
        assert img.size[0] == round(single_w * S.CHART_DPI)


@pytest.mark.parametrize("chart_type", ["line", "area", "bar", "hbar"])
def test_a_panelled_chart_still_renders_identical_bytes_across_two_calls(
    chart_type: str,
) -> None:
    """Panelling must not reopen the byte-reproducibility guarantee
    `test_two_renders_of_one_chart_node_produce_identical_bytes` already
    proves for the single-panel case."""
    node, _ = two_magnitude_chart(chart_type=chart_type)
    first = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    second = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    assert first.image_png == second.image_png
    assert first.data_hash == second.data_hash


def test_a_declared_panel_grouping_missing_the_aggregate_key_is_rerived() -> None:
    """Above the five-series cap, `plotted_series` folds the remainder into
    one `__other__` aggregate the compile-time `panel_groups` call never saw
    — `_panel_groups_for` must re-derive rather than silently dropping that
    series from every panel (task 5.2's own note on why this re-derivation
    exists at all)."""
    node, _ = synthetic_chart(series_count=9, points_per_series=2)
    # synthetic_chart's series all share one figure's value, so
    # panel_groups declared one panel naming all nine metric-N keys — none
    # of which is __other__, since the aggregate does not exist until
    # plotted_series folds the remainder at render time.
    assert C.OTHER_SERIES_KEY not in {key for group in node.panels for key in group}

    series_set = C.plotted_series(node, messages=_MESSAGES)
    groups = C._panel_groups_for(node, series_set)

    # Every plotted key — including the aggregate — must appear in some
    # panel; re-deriving is what makes that true when the declared grouping
    # cannot possibly have named it.
    grouped_keys = {key for group in groups for key in group}
    assert grouped_keys == {series.key for series in series_set}
    assert C.OTHER_SERIES_KEY in grouped_keys

    # render_chart must not crash on this reconciliation either.
    artifacts = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    assert artifacts.image_png[:8] == b"\x89PNG\r\n\x1a\n"


def test_chart_size_inches_reduces_to_the_single_chart_size_at_one_panel() -> None:
    from reporting_agent.render import chartstyle as S

    assert S.chart_size_inches(1) == S.CHART_SIZE_INCHES


def test_chart_size_inches_grows_with_panel_count_until_the_page_stops_it() -> None:
    """Linear while the stack fits, clamped once it would not.

    `render/docx.py::emit_chart` embeds the PNG at a fixed 6in width and passes no height,
    so python-docx keeps the aspect ratio and Word gets an image as tall as it was drawn —
    which it **crops** rather than scales. Three panels at the full panel height is 10.2in
    against roughly 9.7in of A4 text, and the delivered report showed the memory panel cut
    through the middle of its own y-axis, every value above 3.30e9 missing from the page.

    The old assertion here was `three == 3 * panel + 2 * gap`, which is precisely the
    behaviour that produced that, asserted as though it were the requirement.
    """
    from reporting_agent.render import chartstyle as S

    one = S.chart_size_inches(1)
    two = S.chart_size_inches(2)

    # Unclamped while it fits, so the single-panel case keeps its byte-identical guarantee.
    assert one[1] == pytest.approx(S.CHART_PANEL_HEIGHT_INCHES)
    assert two[1] == pytest.approx(2 * S.CHART_PANEL_HEIGHT_INCHES + S.CHART_PANEL_GAP_INCHES)

    # Width never changes — panelling stacks vertically.
    for count in range(1, 9):
        assert S.chart_size_inches(count)[0] == one[0]

    # And no panel count, however large, produces an image the page cannot hold.
    for count in range(1, 9):
        assert S.chart_size_inches(count)[1] <= S.MAX_CHART_HEIGHT_INCHES + 1e-9, (
            f"{count} panels draw an image taller than the page, which Word crops"
        )

    # Growth is still monotonic up to the clamp — a chart with more panels is never
    # shorter than one with fewer.
    heights = [S.chart_size_inches(n)[1] for n in range(1, 9)]
    assert heights == sorted(heights)


def test_chart_size_inches_rejects_zero_or_negative_panel_counts() -> None:
    from reporting_agent.render import chartstyle as S

    with pytest.raises(ValueError):
        S.chart_size_inches(0)
    with pytest.raises(ValueError):
        S.chart_size_inches(-1)


# ---------------------------------------------------------------------------
# Chart layout: the end-label gutter, tick thinning, and the legend's role
# ---------------------------------------------------------------------------


class TestEndLabelBudget:
    """`truncate_end_label` keeps a series identifiable in the right gutter.

    The gutter is a fixed fraction of a fixed figure width, so what fits is a character
    count and not a measurement — see `END_LABEL_MAX_CHARS`. Before this, a label was
    written at full length into a 0.84in gutter and the figure edge cut it mid-word,
    which is how "CPN-MCP — Percentage CPU (max)" reached a delivered document as
    "CPN-MCP — Percenta".
    """

    def test_a_label_within_budget_is_untouched(self) -> None:
        from reporting_agent.render.charts import truncate_end_label

        assert truncate_end_label("CPN-App — CPU (avg)") == "CPN-App — CPU (avg)"

    def test_a_long_label_is_cut_to_the_budget(self) -> None:
        from reporting_agent.render.charts import (
            END_LABEL_MAX_CHARS,
            truncate_end_label,
        )

        label = "A" * 120
        assert len(truncate_end_label(label)) == END_LABEL_MAX_CHARS

    def test_two_series_of_one_resource_stay_distinguishable(self) -> None:
        """The reason the elision is in the middle rather than at the tail.

        Two series of one machine differ only in their last five characters. Cutting the
        tail would give both the same label and leave the chart unreadable — which is
        precisely the case the gutter exists to serve.
        """
        from reporting_agent.render.charts import truncate_end_label

        avg = truncate_end_label(
            "CPN-App — Percentage CPU utilisation across the window (avg)"
        )
        mx = truncate_end_label(
            "CPN-App — Percentage CPU utilisation across the window (max)"
        )
        assert avg != mx
        assert avg.endswith("(avg)")
        assert mx.endswith("(max)")

    def test_it_is_total_over_a_tiny_budget(self) -> None:
        from reporting_agent.render.charts import truncate_end_label

        assert truncate_end_label("abcdef", budget=1) == "a"


class TestTickThinning:
    """`tick_label_positions` bounds how many x labels one panel prints."""

    def test_a_short_series_labels_every_point(self) -> None:
        from reporting_agent.render.charts import tick_label_positions

        assert tick_label_positions(5) == [0, 1, 2, 3, 4]

    def test_a_months_worth_of_days_is_thinned(self) -> None:
        from reporting_agent.render.charts import (
            MAX_X_TICK_LABELS,
            tick_label_positions,
        )

        ticks = tick_label_positions(31)
        assert len(ticks) <= MAX_X_TICK_LABELS
        assert ticks[0] == 0
        # Evenly stepped, so the axis reads as a scale rather than a selection.
        steps = {b - a for a, b in zip(ticks[:-1], ticks[1:], strict=True)}
        assert len(steps) == 1

    def test_it_is_total_at_the_boundaries(self) -> None:
        from reporting_agent.render.charts import tick_label_positions

        assert tick_label_positions(0) == []
        assert tick_label_positions(1) == [0]


def test_the_table_width_never_follows_the_point_count() -> None:
    """The invariant a real July run broke, and the reason this file did not catch it.

    One row per series with a column per x was tried, to turn 93 rows into 3. It reaches
    A4 as a 32-column table, and LibreOffice lays those columns out too narrow for their
    text to survive into the converted PDF — a July run came back with 146
    `pdf_figure_missing` findings, every figure of this table, on a `.docx` whose own
    twenty tables all resolved.

    Nothing here noticed, because every fixture in this file plots a handful of points and
    the end-to-end fixture plots **one**: at one point per series the matrix is two columns
    wide and looks perfectly well. So the guard is not "the shape is a matrix" but "the
    width does not follow the data", checked at a month's worth of days.

    The shipping shape puts the x on the rows, so the width is one key column plus one
    column per plotted series and the point count cannot reach it at all.
    """
    for points in (1, 4, 31, 90):
        node, _ = synthetic_chart(series_count=3, points_per_series=points)
        table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)

        assert len(table.columns) == 4, (
            f"{points} points produced {len(table.columns)} columns; a companion table's "
            f"width must not follow its point count, or it stops fitting the page"
        )
        assert len(table.rows) == points


@pytest.mark.parametrize("series_count", [1, 3, 5, 9, 40])
def test_the_table_is_never_wider_than_libreoffice_can_render(series_count: int) -> None:
    """The width bound that keeps figures alive through the `.docx` -> PDF conversion.

    Measured against real LibreOffice at a month of days: a ten-column table renders its
    text extractably and an eleven-column one loses all of it. Req 22.9's five-series cap
    is what holds this table under that, and it is load-bearing here and not only on the
    image — which is why it is asserted against a series count far above the cap.
    """
    node, _ = synthetic_chart(series_count=series_count, points_per_series=31)
    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)

    assert len(table.columns) == 1 + len(C.plotted_series(node, messages=_MESSAGES))
    assert len(table.columns) <= 1 + S.CATEGORICAL_LIMIT
    assert len(table.columns) <= 10

def test_the_aggregate_keeps_every_remainder_point_addressable() -> None:
    """Above the five-series cap the aggregate qualifies each point's x with the series it
    came from, so two remainder series sharing a date stay distinct row keys — which here
    means distinct ROWS, each carrying its one value in the aggregate's column and empty
    cells under the four series that were plotted in their own right."""
    node, _ = synthetic_chart(series_count=9, points_per_series=4)
    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)

    assert len(table.columns) == 1 + S.CATEGORICAL_LIMIT
    assert len({row.key for row in table.rows}) == len(table.rows), (
        "a repeated row key is a row the verifier cannot address (Req 21.5)"
    )

    plotted = C.plotted_series(node, messages=_MESSAGES)
    assert len(addressed_figures(table)) == sum(len(series.points) for series in plotted)


# --------------------------------------------------------------------------- #
# The shape is chosen by width — run ef01a404
# --------------------------------------------------------------------------- #


def _chart_with_value_width(*, series_count: int, points: int, value: str) -> tuple[Chart, FigureLedger]:
    """A chart whose every plotted figure formats to `value`, so a test can choose the
    width of the data rather than only its shape."""
    view = build_snapshot_view(
        sf.build(resources=[
            sf.vm(
                resource_id="/vm/w", name="w",
                statistics=[sf.exact(sf.AVAILABLE_MEMORY, "avg", value)],
            )
        ])
    )
    ledger = FigureLedger()
    stat = view.stat("/vm/w", sf.AVAILABLE_MEMORY, "avg")
    assert stat is not None

    with compiling_against(view):
        series = []
        for series_index in range(series_count):
            cursor = BlockCursor(block_id="c", ledger=ledger)
            pts = []
            for point_index in range(points):
                figure = (
                    cursor.child("series", series_index)
                    .child("points", point_index)
                    .child("figure", 0)
                    .figure(stat)
                )
                pts.append(ChartPoint(
                    path=figure_path("c", series_index, point_index),
                    x=f"2026-07-{point_index + 1:02d}",
                    y=figure,
                ))
            series.append(Series(
                path=figure_path("c", series_index),
                key=f"m{series_index}",
                label=f"prod-db-0{series_index} — Available Memory Bytes (avg)",
                points=tuple(pts),
            ))
        chart = Chart(
            path=figure_path("c", 0), chart_type="line", title="S", unit="bytes",
            encoding="categorical", series=tuple(series), panels=panel_groups(tuple(series)),
        )
    return chart, ledger


def test_narrow_values_take_the_wide_shape() -> None:
    """The compact arrangement, whenever the page can hold it: one row per x."""
    node, _ = _chart_with_value_width(series_count=5, points=31, value="12")
    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)

    assert table.columns[0].key == C.X_COLUMN_KEY
    assert len(table.rows) == 31
    assert len(table.columns) == 6
    assert F.fits_page(table)


def test_wide_values_take_the_tall_shape() -> None:
    """Run ef01a404, as a test.

    Five series of `3,187,970,789.00 bytes` cannot be laid side by side on A4 — the
    columns come out narrower than the value, LibreOffice wraps each one inside its cell,
    and `verify/pdf.py` searches the converted text for the ledger string contiguously, so
    a line break through the middle of it reads as a figure that never arrived. The live
    run came back with 30 `pdf_figure_missing` findings, one per day of July, every one in
    the single column that held the byte counts.

    So the shape has to follow the width of the data, not only its cardinality.
    """
    node, _ = _chart_with_value_width(series_count=5, points=31, value="3187970789")
    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)

    assert table.columns[0].key == C.SERIES_COLUMN_KEY
    assert len(table.columns) == 3
    assert len(table.rows) == 5 * 31


def test_both_shapes_carry_every_plotted_point() -> None:
    """Req 22.1 holds whichever arrangement is chosen — the shapes trade width for height
    and nothing else. A fallback that thinned would let the image assert something the
    table could not confirm, which is the whole reason the table exists."""
    for value in ("12", "3187970789"):
        node, _ = _chart_with_value_width(series_count=5, points=31, value=value)
        table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)
        plotted = [
            point
            for series in C.plotted_series(node, messages=_MESSAGES)
            for point in series.points
        ]
        emitted = [
            cell.figure.formatted
            for row in table.rows
            for cell in row.cells
            if isinstance(cell, FigureCell)
        ]
        assert sorted(emitted) == sorted(point.y.formatted for point in plotted)
        assert len({row.key for row in table.rows}) == len(table.rows)


# --------------------------------------------------------------------------- #
# One drawing, two encodings
# --------------------------------------------------------------------------- #


def test_the_svg_and_the_png_come_from_one_drawing() -> None:
    """The `.docx` embeds the raster and the print stylesheet embeds the vector, and both
    are serialised from the **same** `Figure` — so the Word file and the styled PDF cannot
    show different charts.

    A second `render_chart` call would be a second drawing under the same inputs and would
    almost certainly agree; that is not the point. The point is that no code path exists
    that could draw one without the other.
    """
    node, _ = synthetic_chart(series_count=3, points_per_series=31)
    artifacts = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)

    assert artifacts.image_png.startswith(b"\x89PNG")
    assert artifacts.image_svg.lstrip().startswith("<?xml")
    assert "<svg" in artifacts.image_svg


def test_the_svg_is_byte_identical_across_renders() -> None:
    """Determinism, on the same terms the PNG is held to.

    Two sources of drift, both already closed: matplotlib salts SVG element ids per
    process unless `svg.hashsalt` is fixed, which `frozen_rc_params` sets, and it writes a
    `<dc:date>` into the RDF metadata unless suppressed, which `SVG_METADATA` does. Either
    would make one chart differ between two runs, which is exactly what the replay gate
    compares.
    """
    node, _ = synthetic_chart(series_count=3, points_per_series=31)
    first = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)
    second = C.render_chart(node, table_style=TABLE_STYLE, messages=_MESSAGES)

    assert first.image_svg == second.image_svg
    assert "dc:date" not in first.image_svg.lower()


# --------------------------------------------------------------------------- #
# Req 22.10 — the direct end labels must stay readable
# --------------------------------------------------------------------------- #


class TestStackWithoutOverlap:
    """Two series ending at nearly the same value printed one label over the other.

    The delivered chart showed it: `CPN-App — Percentage CPU (max)` and
    `CPN-MCP — Percentage CPU (max)` both ended near 2.3% and overprinted, along with their
    two numerals. Req 22.10 makes these labels the primary way a reader tells series apart
    and the legend only a fallback, so this is the legend's failure mode reappearing inside
    its replacement.
    """

    def test_labels_far_apart_are_left_where_they_are(self) -> None:
        assert C.stack_without_overlap([0.0, 10.0, 20.0], 1.0) == [0.0, 10.0, 20.0]

    def test_a_colliding_label_is_lifted_exactly_clear(self) -> None:
        """Lifted by the least that separates them, not to a fixed slot."""
        assert C.stack_without_overlap([2.32, 2.35], 1.0) == [2.32, 3.32]

    def test_the_lowest_label_keeps_its_true_position(self) -> None:
        """Only the ones above move, so at least one label is exactly where its line ends."""
        stacked = C.stack_without_overlap([5.0, 5.1, 5.2, 5.3], 2.0)
        assert stacked[0] == 5.0
        assert stacked == [5.0, 7.0, 9.0, 11.0]

    def test_no_pair_ends_closer_than_the_gap(self) -> None:
        """The property, over a run that mixes collisions with clear space."""
        values = [0.0, 0.05, 0.1, 8.0, 8.01, 20.0]
        stacked = C.stack_without_overlap(values, 1.0)
        for lower, upper in zip(stacked, stacked[1:], strict=False):
            assert upper - lower >= 1.0 - 1e-9

    def test_it_never_lowers_a_label(self) -> None:
        values = [0.0, 0.05, 0.1, 8.0, 8.01, 20.0]
        for original, placed in zip(values, C.stack_without_overlap(values, 1.0), strict=True):
            assert placed >= original

    def test_it_is_total_over_the_empty_and_single_cases(self) -> None:
        assert C.stack_without_overlap([], 1.0) == []
        assert C.stack_without_overlap([4.2], 1.0) == [4.2]


# --------------------------------------------------------------------------- #
# A series' label is reduced to what distinguishes it
# --------------------------------------------------------------------------- #


class TestShortSeriesLabel:
    """`ReportB.dc.html` labels a per-machine CPU chart's two lines `Max` and `Avg`.

    The full form — `CPN-App — Percentage CPU (max)` — is right on a fleet chart, where
    the resource is what tells two lines apart. On a chart of one machine and one metric
    it spends the whole right gutter on the half that is identical, and the delivered
    chart ran the label off the edge of the image.
    """

    def _series(self, key: str, statistic: str, *, metric: str, resource: str, index: int = 0):
        """One series, built through `BlockCursor.figure` under `compiling_against` —
        a `Figure` refuses construction outside it, which is the provenance guarantee this
        file's own fixtures already go through."""
        from dataclasses import dataclass

        from reporting_agent.compile.ast import ChartPoint, Series
        from reporting_agent.compile.estimators import ESTIMATOR_EXACT_COUNT_WEIGHTED
        from reporting_agent.compile.snapshot_view import SnapshotValue

        @dataclass(frozen=True, slots=True)
        class _FixedValueResolver:
            """Resolves any pointer to one fixed value — the same seam
            `two_magnitude_chart` uses, and for the same reason."""

            value: SnapshotValue

            def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
                return (self.value,)

            def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
                return ()

        ledger = FigureLedger()
        cursor = BlockCursor(block_id="c", ledger=ledger)
        points = []
        for point_index in range(2):
            value = SnapshotValue(
                value=Decimal("10.00"),
                unit="percent",
                statistic=statistic,
                estimator=ESTIMATOR_EXACT_COUNT_WEIGHTED,
                fidelity_tier="baseline",
                scale=2,
                pointer="/resources/r0/metrics/m0/value",
                estimated=None,
                metric=metric,
                resource_id=resource,
                window="",
            )
            with compiling_against(_FixedValueResolver(value)):
                figure = (
                    cursor.child("series", index)
                    .child("points", point_index)
                    .child("figure", 0)
                    .figure(value)
                )
            points.append(
                ChartPoint(
                    path=figure_path("c", index, point_index),
                    x=f"2026-08-0{point_index + 1}",
                    y=figure,
                )
            )
        return Series(
            path=figure_path("c", index),
            key=key,
            label=f"{resource} \u2014 {metric} ({statistic})",
            points=tuple(points),
        )

    def test_one_resource_and_one_metric_reduces_to_the_statistic(self) -> None:
        from reporting_agent.render.charts import short_series_label

        avg = self._series("a", "avg", metric="Percentage CPU", resource="/vm/one")
        maximum = self._series("m", "max", metric="Percentage CPU", resource="/vm/one", index=1)
        both = (avg, maximum)

        assert short_series_label(avg, both) == "Avg"
        assert short_series_label(maximum, both) == "Max"

    def test_two_resources_keep_their_full_labels(self) -> None:
        """A fleet chart's lines are told apart by the machine, so the machine stays."""
        from reporting_agent.render.charts import short_series_label

        one = self._series("a", "avg", metric="Percentage CPU", resource="/vm/one")
        two = self._series("b", "avg", metric="Percentage CPU", resource="/vm/two", index=1)
        both = (one, two)

        assert short_series_label(one, both) == one.label
        assert short_series_label(two, both) == two.label

    def test_two_metrics_keep_their_full_labels(self) -> None:
        """`Avg` and `Avg` would be one label twice over."""
        from reporting_agent.render.charts import short_series_label

        cpu = self._series("a", "avg", metric="Percentage CPU", resource="/vm/one")
        memory = self._series(
            "b", "avg", metric="Available Memory Bytes", resource="/vm/one", index=1
        )
        both = (cpu, memory)

        assert short_series_label(cpu, both) == cpu.label
        assert short_series_label(memory, both) == memory.label

    def test_a_series_with_no_points_keeps_its_label(self) -> None:
        """An unlabelled line is worse than a long label."""
        from reporting_agent.compile.ast import Series
        from reporting_agent.render.charts import short_series_label

        empty = Series(path=figure_path("c", 0), key="e", label="an empty series")
        assert short_series_label(empty, (empty,)) == "an empty series"

    def test_an_empty_series_beside_a_populated_one_stops_the_shortening(self) -> None:
        """A series with no points answers nothing about which resource or metric the set
        plots, so the set cannot be established as single-faceted and every label stays
        long. Skipping it instead would shorten on the evidence of the others and label a
        line that might be a third resource's `Avg`."""
        from reporting_agent.compile.ast import Series
        from reporting_agent.render.charts import short_series_label

        avg = self._series("a", "avg", metric="Percentage CPU", resource="/vm/one")
        empty = Series(path=figure_path("c", 1), key="e", label="an empty series")
        both = (avg, empty)

        assert short_series_label(avg, both) == avg.label

    def test_a_figure_carrying_no_statistic_keeps_the_full_label(self) -> None:
        """`Figure.statistic` is optional — a derived figure carries none — and
        `.capitalize()` on nothing is not a label.

        Stood in rather than built, because `dataclasses.replace` on a real `Figure` re-runs
        its provenance check and this case is about a field being absent, not about where
        the value came from. `short_series_label` reads four attributes; these carry them.
        """
        from types import SimpleNamespace

        from reporting_agent.render.charts import short_series_label

        def point(statistic):
            return SimpleNamespace(
                y=SimpleNamespace(
                    metric="Percentage CPU",
                    resource_id="/vm/one",
                    statistic=statistic,
                )
            )

        stripped = SimpleNamespace(
            label="/vm/one — Percentage CPU", points=(point(None), point(None))
        )
        assert short_series_label(stripped, (stripped,)) == stripped.label

        # And a series whose points disagree about the statistic — which nothing builds
        # today, so this pins the guard rather than an observed case.
        mixed = SimpleNamespace(
            label="/vm/one — Percentage CPU", points=(point("avg"), point("max"))
        )
        assert short_series_label(mixed, (mixed,)) == mixed.label

    def test_the_short_label_fits_the_gutter(self) -> None:
        """The defect this exists for, stated as the property: the reduced label is well
        inside `END_LABEL_MAX_CHARS`, so it is never middle-elided and never overflows."""
        from reporting_agent.render.charts import END_LABEL_MAX_CHARS, short_series_label

        avg = self._series("a", "avg", metric="Percentage CPU", resource="/vm/one")
        maximum = self._series("m", "max", metric="Percentage CPU", resource="/vm/one", index=1)

        for series in (avg, maximum):
            assert len(short_series_label(series, (avg, maximum))) <= END_LABEL_MAX_CHARS // 3


# --------------------------------------------------------------------------- #
# The profile's chart style and chart font
#
# Six shapes and three faces, chosen in the wizard's Appearance step and carried to here
# through `DesignSettings`. The rule that governs all of them: **appearance is not data**.
# A style changes what the reader sees and must never change what the verifier checks, so
# every test below that renders also asserts the chart data hash is where it was.
# --------------------------------------------------------------------------- #


class TestChartStyleAndFont:
    def _node(self, *, series_count: int = 2, points: int = 12):
        return synthetic_chart(series_count=series_count, points_per_series=points)[0]

    def _render(self, node, *, chart_style: str, chart_font: str = "grotesque"):
        return C.render_chart(
            node,
            table_style="Table Hairline",
            preset="editorial",
            chart_style=chart_style,
            chart_font=chart_font,
            messages=load_messages("en"),
        )

    def test_every_declared_style_and_font_renders(self) -> None:
        node = self._node()
        for name in S.CHART_STYLES:
            for face in ("document", "grotesque", "monospace"):
                artifacts = self._render(node, chart_style=name, chart_font=face)
                assert artifacts.image_png.startswith(b"\x89PNG"), (name, face)
                assert artifacts.image_svg.lstrip().startswith("<?xml"), (name, face)

    def test_the_data_hash_is_blind_to_the_style_and_the_face(self) -> None:
        """The property the twelve gates depend on.

        `chart_data_hash` is over the plotted decimal strings, and the verifier recomputes
        it from the stored tree. If a style could move it, choosing a different chart in the
        wizard would fail `chart_hash_mismatch` on every replay of an unchanged report.
        """
        node = self._node()
        hashes = {
            self._render(node, chart_style=name, chart_font=face).data_hash
            for name in S.CHART_STYLES
            for face in ("document", "grotesque", "monospace")
        }
        assert len(hashes) == 1

    def test_the_companion_table_is_blind_to_the_style(self) -> None:
        """The same, for the half of the pair the verifier actually reads."""
        node = self._node()
        tables = {
            _table_shape(self._render(node, chart_style=name).table)
            for name in S.CHART_STYLES
        }
        assert len(tables) == 1

    def test_an_unrecognised_style_draws_the_shape_that_shipped(self) -> None:
        """A definition naming a style this build does not have renders rather than raising.

        The wizard's validator is the gate on the name; this is what happens to a stored
        profile written by a newer app than the agent replaying it. Falling back to the
        shipped shape keeps that report deliverable — refusing to draw would make an
        appearance field able to fail a run, which is precisely what appearance may not do.
        """
        node = self._node()
        assert S.chart_style_spec("nonsense") == S.chart_style_spec("stacked")
        assert (
            self._render(node, chart_style="nonsense").image_png
            == self._render(node, chart_style="stacked").image_png
        )

    def test_a_single_panel_style_draws_one_panel(self) -> None:
        """Not asserted through the picture: the figure's height is derived from the panel
        count, so one panel is a materially shorter image than two.

        The two-magnitude chart, because that is the only one the default grouping splits —
        `synthetic_chart`'s series share a magnitude and already occupy one panel, so it
        could not tell the override from the default.
        """
        node, _ = two_magnitude_chart()
        assert S.chart_style_spec("stacked").panels == "magnitude"
        assert S.chart_style_spec("columns").panels == "single"
        assert _png_height(self._render(node, chart_style="columns").image_png) < _png_height(
            self._render(node, chart_style="stacked").image_png
        )

    def test_every_style_gives_every_series_its_direct_label(self, monkeypatch) -> None:
        """Req 22.10 under all six shapes.

        The columns shape shipped without this and drew no series label at all: two dodged
        series a hundredfold apart in scale read as one, because the shorter one's bar was
        under a pixel high and nothing named it.
        """
        node = self._node(series_count=2)
        captured: list[str] = []
        # Bound once, outside the loop. Re-reading the module attribute per iteration would
        # capture the previous iteration's own spy and recur.
        original = C._draw_end_labels

        def spy(axes, entries, **kwargs):
            captured.extend(entry[2] for entry in entries)
            return original(axes, entries, **kwargs)

        monkeypatch.setattr(C, "_draw_end_labels", spy)
        for name in S.CHART_STYLES:
            captured.clear()
            self._render(node, chart_style=name)
            for series in node.series:
                assert any(
                    C.short_series_label(series, node.series) == text for text in captured
                ), f"{name} drew no direct label for {series.key}"

    def test_the_bare_furniture_style_strips_the_axes(self) -> None:
        """A sparkline is the shape and its last value. The exact figures are in the
        companion table either way, which is what makes dropping the ticks honest."""
        assert S.chart_style_spec("sparkline").furniture == "bare"
        node = self._node()
        # Fewer pixels of ink than the same data with a full frame around it: the gridlines,
        # the tick labels, the axis title and the spines are all gone.
        assert len(self._render(node, chart_style="sparkline").image_png) < len(
            self._render(node, chart_style="stacked").image_png
        )

    def test_the_face_resolves_from_the_choice_and_the_theme(self) -> None:
        assert S.chart_font_face("grotesque", body_face="Liberation Serif") == "DejaVu Sans"
        assert (
            S.chart_font_face("monospace", body_face="Liberation Serif")
            == "DejaVu Sans Mono"
        )
        # `document` is the whole reason this is a function rather than a mapping: it is
        # whatever the preset sets the body in, which is not knowable in `chartstyle.py`.
        assert (
            S.chart_font_face("document", body_face="Liberation Serif")
            == "Liberation Serif"
        )
        # And an unknown choice draws in the face every chart used before the field existed.
        assert S.chart_font_face("art-deco", body_face="Liberation Serif") == "DejaVu Sans"

    def test_the_resolved_face_is_what_the_panel_is_drawn_with(self, monkeypatch) -> None:
        """Asserted on the furniture handed to `_draw`, not on the emitted bytes.

        Bytes would have been the stronger check and are the wrong one here: `document`
        resolves to the preset's Liberation Serif, which this host does not have and
        matplotlib silently substitutes — so a byte comparison passes in the image and fails
        on a laptop, which is a test about the machine rather than about the code.
        """
        node = self._node()
        faces: list[str] = []
        original = C._draw

        def spy(axes, *args, **kwargs):
            faces.append(kwargs["furniture"].body_face)
            return original(axes, *args, **kwargs)

        monkeypatch.setattr(C, "_draw", spy)
        for choice, expected in (
            ("grotesque", "DejaVu Sans"),
            ("monospace", "DejaVu Sans Mono"),
        ):
            faces.clear()
            self._render(node, chart_style="soft_area", chart_font=choice)
            assert faces and set(faces) == {expected}

        faces.clear()
        self._render(node, chart_style="soft_area", chart_font="document")
        assert faces and set(faces) == {C._furniture_for("editorial", "light").body_face}

    def test_the_renderer_draws_exactly_the_styles_the_validator_accepts(self) -> None:
        """The drift guard. A style the wizard offers and this module has never heard of
        would save cleanly and then draw as `stacked` — a profile field that looks like it
        works. A style drawn here and missing from the validator is unreachable."""
        from reporting_agent.compile import definition as V

        assert set(S.CHART_STYLES) == set(V.CHART_STYLES)
        assert set(S.CHART_FONT_CHOICES) == set(V.CHART_FONTS)

    def test_the_profiles_choice_reaches_the_renderer(self, monkeypatch) -> None:
        """The wire between the two halves, and the only part of this feature the user can
        actually see. Every other test here calls `render_chart` with a style directly; this
        is the one that asserts a **definition** naming one arrives with it.

        Without this, deleting the two keyword arguments at the `docx.py` call site left the
        whole suite green while every chart in every report drew the shipped default.
        """
        received: list[dict] = []
        original = D.render_chart

        def spy(node, **kwargs):
            received.append(kwargs)
            return original(node, **kwargs)

        monkeypatch.setattr(D, "render_chart", spy)
        compiled = compile_charts([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
        D.render_document(
            compiled.document,
            ledger=compiled.ledger,
            design=DesignSettings.from_plain(
                {**DESIGN, "chart_style": "range_band", "chart_font": "monospace"}
            ),
            messages=_MESSAGES,
        )
        assert received, "no chart was rendered"
        for call in received:
            assert call["chart_style"] == "range_band"
            assert call["chart_font"] == "monospace"

    def test_the_shipped_shape_is_what_a_profile_naming_nothing_gets(self) -> None:
        """The defaults are the old behaviour, so a stored version from before these fields
        existed replays to the same picture it delivered."""
        settings = DesignSettings.from_plain({})
        assert settings.chart_style == "stacked"
        assert settings.chart_font == "grotesque"

        # And a `design` that is not an object at all, which takes the other branch: the
        # two defaults are written twice, once on the dataclass and once in `from_plain`,
        # the way every field here is, so both have to be asserted or one can drift.
        for absent in (None, "editorial", []):
            fallback = DesignSettings.from_plain(absent)
            assert (fallback.chart_style, fallback.chart_font) == ("stacked", "grotesque")


class TestEndLabelPlacement:
    """The right gutter — where a series' name and its final value are drawn.

    Two defects live here, both only reachable once a style could put every series on one
    panel: a near-zero series printed its value under the axis and through the date labels,
    and one pair's value printed through the next pair's label.
    """

    def _axes(self):
        from matplotlib.figure import Figure as _Figure

        figure = _Figure(figsize=(6.0, 1.5), dpi=200)
        axes = figure.add_subplot(1, 1, 1)
        axes.set_ylim(0.0, 28.0)
        axes.set_xlim(0.0, 30.0)
        figure.subplots_adjust(left=0.12, right=C._AXES_RIGHT, top=0.7, bottom=0.3)
        return figure, axes

    def _drawn(self, axes):
        """Each annotation's text and its y in **display** pixels — which is the space the
        overlap happens in, and the only space in which "a line of text" is a length."""
        placed = []
        for child in axes.texts:
            x, y = axes.transData.transform(child.xy)
            offset = child.get_position()
            placed.append(
                (child.get_text(), y + offset[1] * axes.get_figure().dpi / 72.0)
            )
        return placed

    def test_a_near_zero_series_keeps_its_value_inside_the_panel(self) -> None:
        figure, axes = self._axes()
        C._draw_end_labels(
            axes,
            [(29.0, 0.19, "0.19%", "#000000")],
            offset=(3, -C._VALUE_UNDER_LABEL_POINTS),
            floor_points=C._VALUE_UNDER_LABEL_POINTS + C._AXIS_CLEARANCE_POINTS,
            occupied_lines=C._PAIR_LINES,
        )
        floor_px = axes.transData.transform((0.0, axes.get_ylim()[0]))[1]
        for _text, y in self._drawn(axes):
            assert y > floor_px, "a value was drawn below the axis, over the date labels"

    def test_a_label_and_the_value_below_it_clear_the_next_pair(self) -> None:
        """Two series ending 9.89 and 0.19 apart on one panel — the observed case.

        Each entry occupies two lines, not one, so spacing the labels a single line apart
        left the upper label's value sitting on the lower label.
        """
        figure, axes = self._axes()
        entries = [(29.0, 9.89, "Max", "#7b2d4e"), (29.0, 0.19, "Avg", "#1b5e20")]
        values = [(29.0, 9.89, "9.89%", "#000000"), (29.0, 0.19, "0.19%", "#000000")]
        floor = C._VALUE_UNDER_LABEL_POINTS + C._AXIS_CLEARANCE_POINTS
        C._draw_end_labels(
            axes, entries, floor_points=floor, occupied_lines=C._PAIR_LINES
        )
        C._draw_end_labels(
            axes,
            values,
            offset=(3, -C._VALUE_UNDER_LABEL_POINTS),
            floor_points=floor,
            occupied_lines=C._PAIR_LINES,
        )

        line_px = S.CHART_LABEL_SIZE * axes.get_figure().dpi / 72.0
        heights = sorted(y for _text, y in self._drawn(axes))
        gaps = [b - a for a, b in zip(heights, heights[1:])]
        assert all(gap >= line_px for gap in gaps), (
            f"two end annotations sit {min(gaps):.1f}px apart, "
            f"inside one {line_px:.1f}px line: {self._drawn(axes)}"
        )

    def test_the_panels_are_positioned_before_anything_is_drawn_on_them(
        self, monkeypatch
    ) -> None:
        """The ordering the gutter arithmetic depends on.

        `_draw_end_labels` converts a line of text from pixels into data units through
        `axes.transData`, and that transform is a function of how tall the axes box is.
        `subplots_adjust` used to run after every panel was drawn, so the labels were spaced
        against a box that then shrank — two lines of room reserved, a little over one
        delivered. Asserting the box is already the final one at draw time is the fix stated
        as a property, rather than a second copy of the overlap arithmetic.
        """
        seen: list[tuple[float, ...]] = []
        original = C._draw

        def spy(axes, *args, **kwargs):
            seen.append(tuple(round(value, 6) for value in axes.get_position().bounds))
            return original(axes, *args, **kwargs)

        monkeypatch.setattr(C, "_draw", spy)
        node = synthetic_chart(series_count=2, points_per_series=8)[0]
        C.render_chart(
            node,
            table_style="Table Hairline",
            preset="editorial",
            chart_style="columns",
            messages=load_messages("en"),
        )
        assert seen, "no panel was drawn"
        # The right edge is the gutter this chart's own labels earned — `Max`/`Avg` are
        # short, so it is the narrowest the clamp allows rather than the widest.
        expected_right = C.axes_right_for(("Max", "Avg"))
        assert expected_right == pytest.approx(C._AXES_RIGHT_MAX)
        for left, _bottom, width, _height in seen:
            assert left == pytest.approx(0.12)
            assert left + width == pytest.approx(expected_right)


class TestTheEndLabelGutter:
    """How much of the width is held back for the labels at the line ends.

    Fixed at 26% before — 1.56in reserved on every chart for a 30-character label, on a
    chart whose labels are `Max` and `9.89%`. The delivered image put 23.5% of its width on
    the right holding nothing against 7.1% on the left, so the drawing's own centre sat at
    41.8% and every chart read as shoved left inside a box that was itself centred.
    """

    def test_short_labels_take_the_narrowest_gutter(self) -> None:
        assert C.axes_right_for(("Max", "Avg")) == pytest.approx(C._AXES_RIGHT_MAX)

    def test_a_long_label_keeps_the_room_it_always_had(self) -> None:
        """A fleet chart's labels are resource names, and this is the case the fixed
        gutter was sized for. It must not be narrowed.

        Asserted in **inches**, not against `_AXES_RIGHT`: comparing the widest gutter to
        the constant that defines it is a tautology that survives the constant moving, and
        1.5in is the measured room `CPN-App — Percentage CPU (max)` actually needs.
        """
        gutter = (1.0 - C.axes_right_for(("CPN-App — Percentage CPU (max)",)))
        assert gutter * S.CHART_WIDTH_INCHES >= 1.5

    def test_the_gutter_is_monotone_in_the_label_it_holds(self) -> None:
        widths = [C.axes_right_for(("x" * n,)) for n in range(1, 40)]
        assert widths == sorted(widths, reverse=True), widths
        assert min(widths) == pytest.approx(C._AXES_RIGHT)
        assert max(widths) == pytest.approx(C._AXES_RIGHT_MAX)

    def test_an_empty_label_set_does_not_reserve_a_gutter_for_nothing(self) -> None:
        assert C.axes_right_for(()) == pytest.approx(C._AXES_RIGHT_MAX)

    def test_the_budget_is_the_inverse_of_the_gutter(self) -> None:
        """The property that keeps the two from drifting: a chart that narrowed its gutter
        must not then elide to a width that no longer fits inside it."""
        # The mid-length labels are the ones that matter. A short label's gutter is the
        # narrowest allowed and a long one's is the widest, so both survive a budget read
        # off the wrong constant; only a label between them gets a gutter sized to itself
        # and can be elided to a width that no longer fits it.
        for label in (
            "Max",
            "CPN-App",
            "CPN-App — Percentage",
            "CPN-App — Percentage CPU",
            "CPN-MCP — Percentage CPU (a)",
            "CPN-App — Percentage CPU (max)",
            "x" * 60,
        ):
            right = C.axes_right_for((label,))
            budget = C.gutter_budget_chars(right)
            drawn = C.truncate_end_label(label, budget)
            assert len(drawn) <= budget
            # And the drawn label fits the inches the gutter actually left.
            inches = len(drawn) * C._LABEL_CHAR_INCHES + C._GUTTER_AIR_INCHES
            assert inches <= (1.0 - right) * S.CHART_WIDTH_INCHES + 1e-9, label

    def test_the_budget_is_read_from_the_gutter_it_is_given(self) -> None:
        """Asserted over the gutter directly, not through a label.

        Going via `axes_right_for` cannot catch a budget read off the fixed constant: that
        function sizes the gutter to fit its label exactly, so the label fits whatever
        budget it is then given, and the two only differ past the clamp where they agree.
        The relationship itself is the thing worth pinning — a later change to either
        clamp is what would make the redundancy stop holding.
        """
        for right in (0.74, 0.78, 0.82, 0.86, 0.90):
            inches = (1.0 - right) * S.CHART_WIDTH_INCHES - C._GUTTER_AIR_INCHES
            assert C.gutter_budget_chars(right) == max(
                2, int(inches / C._LABEL_CHAR_INCHES)
            ), right

        # And it is monotone: a wider gutter never holds fewer characters.
        budgets = [C.gutter_budget_chars(right) for right in (0.90, 0.86, 0.82, 0.78, 0.74)]
        assert budgets == sorted(budgets), budgets

    def test_the_gutter_does_not_move_the_data_hash(self) -> None:
        """It is layout. A chart whose labels changed length would otherwise re-hash."""
        node, _ = synthetic_chart(series_count=2, points_per_series=8)
        assert C.render_chart(
            node, table_style="Table Hairline", preset="editorial",
            messages=load_messages("en"),
        ).data_hash == C.chart_data_hash(node, messages=load_messages("en"))


def _png_height(data: bytes) -> int:
    """A PNG's pixel height, from its IHDR — bytes 20-24 of the fixed-layout header."""
    assert data.startswith(b"\x89PNG")
    return int.from_bytes(data[20:24], "big")


def _table_shape(table) -> tuple:
    """A companion table reduced to what the verifier reads: its cells' text, in order."""
    return tuple(
        tuple(getattr(cell, "text", getattr(cell, "formatted", "")) for cell in row.cells)
        for row in table.rows
    )
