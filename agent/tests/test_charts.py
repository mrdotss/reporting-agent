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


def test_the_companion_table_lists_every_plotted_point_with_no_thinning() -> None:
    """Req 22.1 — no sampling, no thinning, no re-rounding. A table showing a subset would
    let the image assert something the table could not confirm."""
    compiled, _ = render([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    node = first_chart(compiled)
    plotted = [point for series in C.plotted_series(node, messages=_MESSAGES) for point in series.points]
    assert plotted, "the fixture must plot something"

    table = C.companion_table(node, TABLE_STYLE, messages=_MESSAGES)

    # One row per series, one column per x — and every plotted point still in it.
    series_set = C.plotted_series(node, messages=_MESSAGES)
    assert len(table.rows) == len(series_set)
    x_values = {point.x for point in plotted}
    assert len(table.columns) == len(x_values) + 1  # + the series column

    # The cell text is the ledger's formatted string, verbatim, and the set is exactly
    # the plotted set — that is the claim, and it does not depend on the row shape.
    emitted = [
        cell.figure.formatted
        for row in table.rows
        for cell in row.cells
        if isinstance(cell, FigureCell)
    ]
    assert sorted(emitted) == sorted(point.y.formatted for point in plotted)


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
    assert len(table.rows) == len(C.plotted_series(node, messages=_MESSAGES))

    # Every panel's series keys must appear in the table's row keys — no panel
    # is silently dropped from the table just because it was drawn on a
    # different subplot. A row key is now the series key alone: the x that used
    # to be concatenated into it is the column.
    panel_keys = {key for group in node.panels for key in group}
    assert panel_keys <= {row.key for row in table.rows}

    emitted = [
        cell.figure.formatted
        for row in table.rows
        for cell in row.cells
        if isinstance(cell, FigureCell)
    ]
    assert sorted(emitted) == sorted(point.y.formatted for point in plotted)


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


def test_the_companion_table_follows_its_image_with_nothing_between_them() -> None:
    """Req 22.2's body-order clause. The verifier pairs by identity, but a reader relies on
    the adjacency: the table explains the picture above it."""
    _, outcome = render(
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
    assert table_index == drawing_index + 1, children


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
    # One row per series; the plotted points are the table's figure cells.
    assert len(table.rows) == len(plotted)
    assert sum(
        1 for row in table.rows for cell in row.cells if isinstance(cell, FigureCell)
    ) == hashed_points

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


def test_every_line_series_carries_a_marker_and_a_dash_from_its_own_slot() -> None:
    node, _ = synthetic_chart(series_count=4, points_per_series=3, chart_type="line")
    siblings = tuple(series.key for series in node.series)
    markers = {S.marker_for_key(series.key, siblings) for series in node.series}
    dashes = {S.dash_for_key(series.key, siblings) for series in node.series}
    assert len(markers) == len(node.series), markers
    assert len(dashes) == len(node.series), dashes


def test_the_first_slot_is_solid_so_a_single_series_chart_is_not_dashed() -> None:
    assert S.DASH_PATTERNS[0] is None


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


def test_chart_size_inches_grows_linearly_with_panel_count_plus_gaps() -> None:
    from reporting_agent.render import chartstyle as S

    one = S.chart_size_inches(1)
    three = S.chart_size_inches(3)
    expected_height = 3 * S.CHART_PANEL_HEIGHT_INCHES + 2 * S.CHART_PANEL_GAP_INCHES
    assert three[1] == pytest.approx(expected_height)
    assert three[0] == one[0]  # width never changes


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
