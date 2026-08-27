"""`panel_groups` — the pure panel-assignment rule (Req 17.1, 17.2, task 5.1).

`Figure.__post_init__` re-resolves its `snapshot_path` against whatever
`compiling_against` installed (Req 15.11) — a real requirement this test must
satisfy too, even though `panel_groups` itself reads nothing but `Series.key` and
each point's `Figure.value`. Rather than build a real snapshot (which would fix
every point to the same handful of realistic metric values, defeating the point of
a test that needs series at deliberately different magnitudes), a minimal fake
resolver implements the `SnapshotResolver` protocol directly and always resolves
whatever pointer it is asked about to the one `SnapshotValue` the caller supplied —
this is exactly the seam `SnapshotResolver` being a `Protocol` and not the concrete
class exists for, per that class's own docstring.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from reporting_agent.compile.ast import (
    ChartPoint,
    Series,
    compiling_against,
    figure_path,
    panel_groups,
)
from reporting_agent.compile.estimators import ESTIMATOR_EXACT_COUNT_WEIGHTED
from reporting_agent.compile.figures import BlockCursor, FigureLedger
from reporting_agent.compile.snapshot_view import SnapshotValue


@dataclass(frozen=True, slots=True)
class _FixedValueResolver:
    """Resolves any pointer to one fixed `SnapshotValue`. See module docstring."""

    value: SnapshotValue

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        return (self.value,)

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        return ()


def _value_of(decimal_str: str) -> SnapshotValue:
    return SnapshotValue(
        value=Decimal(decimal_str),
        unit="percent",
        statistic="avg",
        estimator=ESTIMATOR_EXACT_COUNT_WEIGHTED,
        fidelity_tier="baseline",
        scale=2,
        pointer="/resources/r0/metrics/m0/value",
        estimated=None,
        metric="Percentage CPU",
        resource_id="r0",
        window="",
    )


def _build(*series_specs: tuple[str, tuple[str, ...]]) -> tuple[Series, ...]:
    """Build a tuple of `Series`, each from `(key, decimal_strings)`.

    Each point gets its own `compiling_against` context fixed to that point's own
    decimal value: `Figure.__post_init__` re-resolves against whatever resolver is
    active at the moment of construction, so a resolver fixed per-point (not
    per-series) is what lets one series carry several distinct decimal strings.
    """
    ledger = FigureLedger()
    built: list[Series] = []
    for series_index, (key, decimal_strings) in enumerate(series_specs):
        points: list[ChartPoint] = []
        for point_index, decimal_str in enumerate(decimal_strings):
            value = _value_of(decimal_str)
            with compiling_against(_FixedValueResolver(value)):
                cursor = BlockCursor(block_id="c", ledger=ledger)
                figure = (
                    cursor.child("series", series_index)
                    .child("points", point_index)
                    .child("figure", 0)
                    .figure(value)
                )
            points.append(
                ChartPoint(
                    path=figure_path("c", series_index, point_index),
                    x=f"x{point_index}",
                    y=figure,
                )
            )
        built.append(
            Series(
                path=figure_path("c", series_index),
                key=key,
                label=key,
                points=tuple(points),
            )
        )
    return tuple(built)


def test_empty_series_tuple_returns_no_panels() -> None:
    assert panel_groups(()) == ()


def test_a_single_series_is_one_panel() -> None:
    result = panel_groups(_build(("cpu", ("10", "20", "30"))))
    assert result == (("cpu",),)


def test_series_within_one_order_of_magnitude_share_a_panel() -> None:
    # Maxima 90 and 15 — a ratio under 10, so they stay together.
    result = panel_groups(_build(("a", ("90",)), ("b", ("15",))))
    assert len(result) == 1
    assert set(result[0]) == {"a", "b"}


def test_series_ten_times_apart_split_into_separate_panels() -> None:
    result = panel_groups(_build(("small", ("1",)), ("big", ("10",))))
    assert len(result) == 2


def test_panels_are_ordered_by_descending_maximum() -> None:
    result = panel_groups(_build(("small", ("1",)), ("big", ("1000",))))
    assert result[0] == ("big",)
    assert result[1] == ("small",)


def test_three_series_at_three_scales_produce_three_panels_in_order() -> None:
    result = panel_groups(
        _build(
            ("hundreds", ("500",)),
            ("units", ("5",)),
            ("tens_of_thousands", ("50000",)),
        )
    )
    assert result == (("tens_of_thousands",), ("hundreds",), ("units",))


def test_negative_values_group_by_absolute_magnitude() -> None:
    result = panel_groups(_build(("positive", ("95",)), ("negative", ("-90",))))
    assert len(result) == 1
    assert set(result[0]) == {"positive", "negative"}


def test_a_series_with_no_points_has_zero_magnitude_and_groups_rather_than_errors() -> None:
    empty = Series(path=figure_path("c", 99), key="empty", label="empty", points=())
    (cpu,) = _build(("cpu", ("50",)))
    result = panel_groups((cpu, empty))
    assert sum(len(group) for group in result) == 2
    assert {key for group in result for key in group} == {"cpu", "empty"}


def test_two_all_zero_series_share_one_panel_rather_than_each_splitting() -> None:
    result = panel_groups(_build(("zero-a", ("0", "0")), ("zero-b", ("0",))))
    assert len(result) == 1
    assert set(result[0]) == {"zero-a", "zero-b"}


def test_a_zero_series_beside_a_nonzero_one_does_not_crash_on_the_ratio() -> None:
    result = panel_groups(_build(("nonzero", ("42",)), ("zero", ("0",))))
    assert sum(len(group) for group in result) == 2


def test_exactly_at_the_order_of_magnitude_threshold_still_splits() -> None:
    # Ratio exactly 10 is ">=" the threshold, so it splits — the boundary is
    # inclusive on the side that separates, not the side that groups.
    result = panel_groups(_build(("big", ("100",)), ("small", ("10",))))
    assert len(result) == 2


def test_just_under_the_threshold_stays_together() -> None:
    result = panel_groups(_build(("big", ("99",)), ("small", ("10",))))
    assert len(result) == 1


def test_result_is_a_tuple_of_tuples_of_the_original_series_keys() -> None:
    result = panel_groups(_build(("a", ("1",)), ("b", ("100",))))
    assert isinstance(result, tuple)
    assert all(isinstance(group, tuple) for group in result)
    all_keys = {key for group in result for key in group}
    assert all_keys == {"a", "b"}
