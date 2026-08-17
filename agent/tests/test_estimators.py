"""`compile/estimators.py` — the estimator-label table (Req 18.10, 28.6, 28.7, 31.8).

The load-bearing test here is :func:`test_every_estimator_the_collector_can_emit_classifies`:
it drives **the collector's own composer** over the cross product of sketch kinds and
declared grains, so a new estimator in `collect/snapshot.py` fails this suite rather than
producing an unlabelled figure in a delivered document.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from reporting_agent.collect import snapshot as collector
from reporting_agent.collect.sketch import DDSketch, FixedHistogram
from reporting_agent.compile.estimators import (
    DECLARED_GRAIN_PHRASES,
    DECLARED_SKETCH_KINDS,
    EXACT_ESTIMATORS,
    EstimatorKind,
    classify,
    estimator_label,
    is_percentile_statistic,
    method_phrase,
)
from reporting_agent.compile.snapshot_view import SKU_CAPACITY_ESTIMATOR
from reporting_agent.errors import CompileFailedError


def _collector_percentile_estimators() -> list[str]:
    """Every percentile estimator string `collect/snapshot.py` can compose.

    Built by calling the collector's **own** `_percentile_estimator` over both sketch
    kinds and every declared grain, rather than by re-spelling the strings here. Reaching
    for a private helper is deliberate: re-spelling is exactly how a table test comes to
    assert that this module agrees with itself.
    """
    sketches = (FixedHistogram(), DDSketch())
    grains = [grain.upper() for grain, _ in DECLARED_GRAIN_PHRASES]
    return [
        collector._percentile_estimator(sketch, grain)
        for sketch in sketches
        for grain in grains
    ]


def _collector_exact_estimators() -> list[str]:
    """Every non-percentile estimator the collector declares as a module constant."""
    return [
        value
        for name, value in vars(collector).items()
        if name.startswith("ESTIMATOR_") and isinstance(value, str)
    ]


def _catalog_metric_entries():
    """Every validated metric entry in the shipped catalog, across resource types."""
    from reporting_agent.catalog.loader import load_catalog

    catalog = load_catalog()
    for resource_type in catalog.resource_types:
        yield from resource_type.metrics


# --------------------------------------------------------------------------- #
# The table is complete
# --------------------------------------------------------------------------- #


def test_every_estimator_the_collector_can_emit_classifies() -> None:
    """The table test Req 18.10 rests on.

    A new estimator in the collector fails **here**, at build time, instead of reaching a
    document as a figure with no estimate marking. Getting that wrong is not cosmetic: a
    percentile reconstructed from hourly averages runs 20-40 points below the true p95 of
    the minute samples, so an unlabelled one is precisely what makes a saturating VM look
    comfortable enough to downsize.
    """
    candidates = [
        *_collector_exact_estimators(),
        *_collector_percentile_estimators(),
        SKU_CAPACITY_ESTIMATOR,
    ]
    assert candidates, "no estimator strings were discovered, so this test checked nothing"

    unclassified: list[str] = []
    for estimator in candidates:
        try:
            classify(estimator, at="table test")
        except CompileFailedError:
            unclassified.append(estimator)

    assert not unclassified, (
        "these estimators have no entry in compile/estimators.py, so a figure carrying "
        f"one would be unlabelled: {sorted(unclassified)}"
    )


def test_the_collectors_exact_constants_are_exactly_this_modules_exact_set() -> None:
    """Set equality, both directions: an estimator the collector dropped should not
    linger here either, or the table drifts into describing a method nobody emits."""
    assert set(_collector_exact_estimators()) == set(EXACT_ESTIMATORS)


def test_every_declared_grain_and_sketch_kind_participates() -> None:
    for grain, phrase in DECLARED_GRAIN_PHRASES:
        assert phrase, grain
        estimator = f"histogram_sketch_{grain}_interval_average"
        assert classify(estimator) is EstimatorKind.ESTIMATED
        assert phrase in (estimator_label(estimator, "p95") or "")

    for sketch, phrase in DECLARED_SKETCH_KINDS:
        assert phrase, sketch
        assert classify(f"{sketch}_pt1h_interval_average") is EstimatorKind.ESTIMATED


# --------------------------------------------------------------------------- #
# Classification
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("estimator", sorted(EXACT_ESTIMATORS))
def test_an_exact_estimator_classifies_exact_and_needs_no_label(estimator: str) -> None:
    assert classify(estimator) is EstimatorKind.EXACT
    assert estimator_label(estimator, "avg") is None


def test_a_derived_estimator_is_exact_not_estimated() -> None:
    """`memory_used_pct` is exact arithmetic over exact inputs. Its host-observed caveat
    rides on the value object as `observation`/`note` and is surfaced by the methodology
    appendix — a statement about vantage point, not about estimation. Merging the two
    would make "estimated" mean two different things."""
    assert classify(collector.ESTIMATOR_DERIVED_COUNT_WEIGHTED) is EstimatorKind.EXACT
    assert estimator_label(collector.ESTIMATOR_DERIVED_COUNT_WEIGHTED, "avg") is None


def test_a_declared_capacity_is_neither_measured_nor_estimated() -> None:
    assert classify(SKU_CAPACITY_ESTIMATOR) is EstimatorKind.DECLARED
    assert estimator_label(SKU_CAPACITY_ESTIMATOR, "capacity") is None
    assert "declared" in method_phrase(SKU_CAPACITY_ESTIMATOR)


@pytest.mark.parametrize(
    "estimator",
    [
        "",
        "exact",
        "p95",
        "histogram_sketch",
        "histogram_sketch_pt1h",
        "histogram_sketch_pt7h_interval_average",  # undeclared grain
        "bloom_filter_pt1h_interval_average",  # undeclared sketch kind
        "histogram_sketch_pt1h_interval_median",  # undeclared folded statistic
        "EXACT_COUNT_WEIGHTED",  # wrong case
    ],
)
def test_an_unrecognised_estimator_is_a_compile_failure(estimator: str) -> None:
    """No default. Guessing "exact" would ship an unlabelled percentile; guessing
    "estimated" would mark an exact minimum as an estimate."""
    with pytest.raises(CompileFailedError) as caught:
        classify(estimator, at="figure 'k:0'")
    assert "k:0" in str(caught.value)


# --------------------------------------------------------------------------- #
# The label
# --------------------------------------------------------------------------- #


def test_the_label_is_the_declared_shape() -> None:
    assert (
        estimator_label("histogram_sketch_pt1h_interval_average", "p95")
        == "p95, est. from hourly averages"
    )
    assert (
        estimator_label("ddsketch_pt15m_interval_average", "p99")
        == "p99, est. from 15-minute averages"
    )


def test_the_label_carries_no_numeral_from_the_value() -> None:
    """`compile/format.py` owns every digit that reaches a document. A label carrying its
    own numeral would put a second formatter's output inside the string the verifier
    matches character for character."""
    for grain, _ in DECLARED_GRAIN_PHRASES:
        label = estimator_label(f"histogram_sketch_{grain}_interval_average", "p95")
        assert label is not None
        # The only digits permitted are the ones in the statistic name itself and in a
        # grain phrase like "15-minute".
        residue = label.replace("p95", "").replace("15-minute", "")
        assert not any(character.isdigit() for character in residue), label


def test_the_label_does_not_reuse_the_snapshots_own_pre_formatted_label() -> None:
    """The collector writes `68.40% (p95, est. from hourly averages)`, rendered at *its*
    scale and separators. A template asking for three decimal places would then produce a
    document showing `68.400%` beside a parenthetical still reading `68.40%`."""
    sketch = FixedHistogram()
    sketch.fold(Decimal("68.4"))
    metric = next(
        entry for entry in _catalog_metric_entries() if entry.name == "Percentage CPU"
    )
    entries = collector.percentile_statistics(
        sketch, metric=metric, fidelity_tier="baseline", grain="PT1H"
    )
    assert entries, "the fixture sketch produced no percentile"

    snapshot_label = entries[0].label
    assert snapshot_label is not None
    assert any(character.isdigit() for character in snapshot_label.split("(")[0])

    composed = estimator_label(entries[0].estimator, entries[0].statistic)
    assert composed is not None
    assert composed != snapshot_label
    assert composed in snapshot_label  # the collector's label wraps the same phrase


def test_an_estimated_estimator_with_no_statistic_is_a_compile_failure() -> None:
    with pytest.raises(CompileFailedError, match="statistic"):
        estimator_label("histogram_sketch_pt1h_interval_average", "")


@pytest.mark.parametrize("statistic", ["p1", "p50", "p95", "p99", "p999"])
def test_a_percentile_statistic_is_recognised(statistic: str) -> None:
    assert is_percentile_statistic(statistic)


@pytest.mark.parametrize("statistic", ["avg", "min", "max", "P95", "p", "p95th", "capacity"])
def test_a_non_percentile_statistic_is_not(statistic: str) -> None:
    assert not is_percentile_statistic(statistic)


# --------------------------------------------------------------------------- #
# The methodology phrase
# --------------------------------------------------------------------------- #


def test_every_exact_estimator_has_a_methodology_phrase() -> None:
    for estimator in EXACT_ESTIMATORS:
        phrase = method_phrase(estimator)
        assert phrase and not any(character.isdigit() for character in phrase.replace("1-3", ""))


def test_the_methodology_phrase_for_a_percentile_says_it_is_an_estimate() -> None:
    phrase = method_phrase("histogram_sketch_pt1h_interval_average")
    assert "estimate" in phrase
    assert "hourly" in phrase


def test_the_methodology_phrase_and_the_label_describe_one_method() -> None:
    """Both are composed from the same declarations, so the appendix and the in-document
    label cannot describe two different methods."""
    estimator = "ddsketch_pt15m_interval_average"
    label = estimator_label(estimator, "p95")
    phrase = method_phrase(estimator)
    assert label is not None
    grain_phrase = "15-minute"
    assert grain_phrase in label
    assert grain_phrase in phrase
