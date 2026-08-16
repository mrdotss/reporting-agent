"""Property 3 — sketch quantiles are bounded in error and in state.

**Validates: Requirements 28.1, 28.2, 28.3, 28.10, 28.11, 26.11, 42.2, 42.4, 42.8**

*Metamorphic.* Generate sample streams, fold them into the sketch, and compare each
estimated quantile against the quantile computed exactly from the retained samples
via :func:`exact_quantile` — the nearest-rank method Req 28's Property 3.1 defines:
for `n` ascending sorted samples, the exact quantile at `q` is the sample at the
1-based rank `ceil(q * n)`, and the exact quantile at `q = 0` is the first sample.

Four classes of failure a plausible implementation gets wrong, one assertion group
each:

* **Absolute vs relative error.** `FixedHistogram` reports a bin *midpoint*, so its
  worst-case error is a fixed 0.25 regardless of where in `[0, 100]` the value sits —
  an **absolute** bound (Property 3.1). `DDSketch` is log-spaced, so its error scales
  with the value itself — a **relative** bound (Property 3.2). Conflating the two
  (testing a log-spaced sketch with an absolute tolerance, or vice versa) would either
  pass trivially at large magnitudes or fail spuriously at small ones.
* **The interval-mean trap.** The declared 90%-at-5/10%-at-95 stream (Property 3.6)
  has an arithmetic mean of 14 but an exact p95 of 95. An implementation that
  estimates a percentile from a running mean instead of a folded distribution passes
  every hand-written unit test that only checks the mean and fails this one loudly.
* **Bounded state vs retained points.** Req 26.11 requires state that does not grow
  with the number of folded points. The 44640-sample declared stream (a 31-day month
  at `PT1M`, Property 3.7) is the one exemplified case in this file precisely because
  a bounded-state claim is not falsifiable by hypothesis's *default* small-list bias —
  a generated property test over lists of at most a few hundred elements would never
  by itself reach a scale where retaining every point becomes distinguishable from
  bounded state by wall-clock time or memory. The exemplified case pins the array
  lengths (200 bins, `MAX_BUCKET_COUNT` buckets) at a scale where "retained the
  points" and "retained fixed-size counts" are the same *length* assertion but very
  different *implementations* — the test only asserts the length, which is the only
  externally observable difference the public API exposes.
* **The dedicated zero bucket.** `log(0)` has no bucket index. A `DDSketch` without a
  separate zero counter either raises on an idle series or silently drops zeros from
  the rank, both of which this file's all-zero-stream test (Property 3.8) catches
  directly.

**A deliberately excluded sub-domain, not a hidden concession.** `collect/sketch.py`'s
own module docstring documents that a raw log-index below `MIN_RAW_INDEX` (any
positive magnitude under `gamma ** -147 ≈ 0.054`) clamps into the lowest bucket as an
explicit trade-off for "adversarial sub-unit inputs" outside the domain the catalog
actually covers (bytes, IOPS, throughput — practically never sub-unit). Drawing
generated *nonzero* magnitudes from that clamped sliver would fail Property 3.2 for a
reason the implementation already documents and accepts, not for a reason worth
discovering via a property test. `magnitude_nonzero_values` below therefore floors at
`Decimal("1")`, comfortably inside the un-clamped window for the full `0` to `10**15`
range this property is otherwise scoped to (Req 28.2), while exact zero is drawn
explicitly and separately so the dedicated zero bucket stays fully exercised.
"""

from __future__ import annotations

from decimal import ROUND_CEILING, Decimal, localcontext

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from reporting_agent.collect.sketch import (
    BIN_COUNT,
    MAX_BUCKET_COUNT,
    UNIT_FAMILY_MAGNITUDE,
    UNIT_FAMILY_PERCENTAGE,
    DDSketch,
    FixedHistogram,
    sketch_for_unit_family,
)

# --- generators ---------------------------------------------------------------------

DECIMAL_PLACES = 6

# Req 28.1's percentage domain: 0 to 100, at most 6 decimal places (Property 3's
# generator clause). `places=6` draws exactly 6 digits after the point, which is a
# subset of "at most 6" — trailing zeros do not add precision, so this satisfies the
# bound without needing a variable-places strategy.
percentage_values = st.decimals(
    min_value=Decimal("0"), max_value=Decimal("100"), places=DECIMAL_PLACES, allow_nan=False, allow_infinity=False
)

MAGNITUDE_UPPER = Decimal(10) ** 15

# See the module docstring: nonzero magnitudes are floored at 1 to stay clear of the
# documented sub-unit clamp threshold (~0.054) that `collect/sketch.py` itself accepts
# as an adversarial-input trade-off rather than a bound this property is meant to
# police.
_MAGNITUDE_NONZERO_LOWER = Decimal("1")

magnitude_nonzero_values = st.decimals(
    min_value=_MAGNITUDE_NONZERO_LOWER,
    max_value=MAGNITUDE_UPPER,
    places=DECIMAL_PLACES,
    allow_nan=False,
    allow_infinity=False,
)

# Req 28.2 — "including streams containing exact zeros." Zero and the un-clamped
# nonzero range are drawn with equal weight so both are well represented across the
# default 100-example floor.
magnitude_values = st.one_of(st.just(Decimal("0")), magnitude_nonzero_values)

percentage_streams = st.lists(percentage_values, min_size=1, max_size=120)
magnitude_streams = st.lists(magnitude_values, min_size=1, max_size=120)

# Req 28's declared quantiles (0.5, 0.9, 0.95, 0.99, 1) plus the full 0-1 range,
# generated at the same 6-decimal-place resolution as the samples.
quantiles = st.decimals(min_value=Decimal("0"), max_value=Decimal("1"), places=DECIMAL_PLACES, allow_nan=False, allow_infinity=False)

# Deterministic streams for `@example` coverage of the declared quantiles, chosen so
# the exact quantile at every declared value is trivially checkable by hand: ranks
# fall on round numbers because the stream is a contiguous ascending run.
PERCENTAGE_EXAMPLE_STREAM = [Decimal(n) for n in range(0, 101)]  # 0..100, one each
MAGNITUDE_EXAMPLE_STREAM = [Decimal(n) for n in range(1, 201)]  # 1..200, one each

# --- Req 42.8 — the retained counterexamples of a resolved defect -------------------
#
# Property 3.5's first run failed on a **single-sample stream at a quantile a hair off
# an edge**, in both sketch kinds, and in both directions:
#
#   DDSketch       [1.000000]  quantile(0) = 1.000000 > quantile(0.000001) = 0.990099…
#   FixedHistogram [1.49]      quantile(0) = 1.49     > quantile(0.000001) = 1.25
#   FixedHistogram [1.01]      quantile(0.999999) = 1.25 > quantile(1) = 1.01
#
# One defect with one shape: `quantile(0)` and `quantile(1)` returned the retained
# exact extreme while any `q` strictly inside returned a **bin midpoint** or a bucket
# bound, so the estimate stepped *down* as `q` stepped up from 0 — and up as `q`
# stepped down from 1. A single-sample stream is where it is visible, because there the
# exact extreme and the interpolated interior are the same sample rendered two ways.
#
# The fix is in `collect/sketch.py`; these are the inputs that found it, retained as
# declared examples on all three of Property 3.5's and 3.1/3.2's assertions so they run
# on every subsequent execution rather than waiting for generation to rediscover a
# 1-in-many-thousands draw. `MIN_QUANTILE_STEP` is the smallest `q` the generators can
# draw at `places=6`, which is what made the failure reachable at all.
MIN_QUANTILE_STEP = Decimal("0.000001")
NEAR_ONE_QUANTILE = Decimal("1") - MIN_QUANTILE_STEP

# The exact shrunk stream hypothesis reported, at the full 6-decimal-place rendering.
SINGLE_SAMPLE_MAGNITUDE_STREAM = [Decimal("1.000000")]
# The two deterministic percentage cases the same defect reproduced at: 1.49 sits just
# below a bin midpoint and 1.01 just above one, so they fail in opposite directions.
SINGLE_SAMPLE_BELOW_MIDPOINT_STREAM = [Decimal("1.49")]
SINGLE_SAMPLE_ABOVE_MIDPOINT_STREAM = [Decimal("1.01")]

DECLARED_QUANTILES = (
    Decimal("0"),
    Decimal("0.5"),
    Decimal("0.9"),
    Decimal("0.95"),
    Decimal("0.99"),
    Decimal("1"),
)


def exact_quantile(sorted_samples: list[Decimal], q: Decimal) -> Decimal:
    """The nearest-rank exact quantile Property 3.1 defines.

    For ascending `sorted_samples` of length `n`: `q <= 0` returns the first sample;
    otherwise the sample at the 1-based rank `ceil(q * n)`, clamped to `[1, n]` so a
    `q` of exactly 1 lands on the last sample rather than one past it.
    """
    n = len(sorted_samples)
    if q <= 0:
        return sorted_samples[0]
    with localcontext() as ctx:
        ctx.prec = 50
        rank = int((q * n).to_integral_value(rounding=ROUND_CEILING))
    rank = max(1, min(rank, n))
    return sorted_samples[rank - 1]


def _relative_error(estimate: Decimal, exact: Decimal) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = 50
        return abs(estimate - exact) / exact


def _histogram_state(histogram: FixedHistogram) -> tuple[object, ...]:
    """A canonical, order-independent state tuple, for the confluence check (Property
    3.4). No `serialize()` exists on `FixedHistogram`; `.bins` is already a sum-of-
    counts structure with no dependency on fold order, so this tuple built from the
    public properties *is* the canonical serialized form for this test's purpose."""
    return (histogram.bins, histogram.minimum, histogram.maximum, histogram.sample_count)


def _ddsketch_state(sketch: DDSketch) -> tuple[object, ...]:
    return (sketch.buckets, sketch.zero_count, sketch.minimum, sketch.maximum, sketch.sample_count)


# --- Property 3.1 — FixedHistogram absolute error bound -----------------------------

ABSOLUTE_BOUND = Decimal("0.5")


@given(samples=percentage_streams, q=quantiles)
@example(samples=PERCENTAGE_EXAMPLE_STREAM, q=Decimal("0"))
@example(samples=PERCENTAGE_EXAMPLE_STREAM, q=Decimal("0.5"))
@example(samples=PERCENTAGE_EXAMPLE_STREAM, q=Decimal("0.9"))
@example(samples=PERCENTAGE_EXAMPLE_STREAM, q=Decimal("0.95"))
@example(samples=PERCENTAGE_EXAMPLE_STREAM, q=Decimal("0.99"))
@example(samples=PERCENTAGE_EXAMPLE_STREAM, q=Decimal("1"))
def test_fixed_histogram_estimate_is_within_half_a_percentage_point(
    samples: list[Decimal], q: Decimal
) -> None:
    """Req 28.1, 28.10 / Property 3.1 — 0.5 percentage-point absolute bound, exact at
    the edges."""
    histogram = FixedHistogram()
    for value in samples:
        histogram.fold(value)

    sorted_samples = sorted(samples)
    estimate = histogram.quantile(q)
    assert isinstance(estimate, Decimal)

    if q <= 0:
        assert estimate == sorted_samples[0] == histogram.minimum
        return
    if q >= 1:
        assert estimate == sorted_samples[-1] == histogram.maximum
        return

    exact = exact_quantile(sorted_samples, q)
    assert abs(estimate - exact) <= ABSOLUTE_BOUND


# --- Property 3.2, 3.8 — DDSketch relative error bound and the zero bucket ----------

RELATIVE_BOUND = Decimal("0.01")


@given(samples=magnitude_streams, q=quantiles)
@example(samples=MAGNITUDE_EXAMPLE_STREAM, q=Decimal("0"))
@example(samples=MAGNITUDE_EXAMPLE_STREAM, q=Decimal("0.5"))
@example(samples=MAGNITUDE_EXAMPLE_STREAM, q=Decimal("0.9"))
@example(samples=MAGNITUDE_EXAMPLE_STREAM, q=Decimal("0.95"))
@example(samples=MAGNITUDE_EXAMPLE_STREAM, q=Decimal("0.99"))
@example(samples=MAGNITUDE_EXAMPLE_STREAM, q=Decimal("1"))
def test_ddsketch_estimate_is_within_one_percent_relative(samples: list[Decimal], q: Decimal) -> None:
    """Req 28.2, 28.10, 28.11 / Property 3.2 — 1% relative bound (`gamma = 1.02`
    guarantees `alpha ~= 0.0099`, so 1% holds with margin), exact 0 where the exact
    quantile is 0, exact at the edges."""
    sketch = DDSketch()
    for value in samples:
        sketch.fold(value)

    sorted_samples = sorted(samples)
    estimate = sketch.quantile(q)
    assert isinstance(estimate, Decimal)

    if q <= 0:
        assert estimate == sorted_samples[0] == sketch.minimum
        return
    if q >= 1:
        assert estimate == sorted_samples[-1] == sketch.maximum
        return

    exact = exact_quantile(sorted_samples, q)
    if exact == 0:
        assert estimate == Decimal("0")
    else:
        assert _relative_error(estimate, exact) <= RELATIVE_BOUND


@given(count=st.integers(min_value=1, max_value=200), q=quantiles)
@example(count=1, q=Decimal("0"))
@example(count=1, q=Decimal("1"))
@example(count=200, q=Decimal("0.5"))
def test_ddsketch_all_zero_stream_is_exactly_zero_at_every_quantile(count: int, q: Decimal) -> None:
    """Req 28.11 / Property 3.8 — a series of idle intervals yields a defined,
    correct, exactly-zero quantile everywhere in `[0, 1]`, never an undefined `log(0)`
    and never a nonzero artifact of falling through to a log-spaced bucket."""
    sketch = DDSketch()
    for _ in range(count):
        sketch.fold(Decimal("0"))

    estimate = sketch.quantile(q)
    assert isinstance(estimate, Decimal)
    assert estimate == Decimal("0")
    assert sketch.zero_count == count
    assert sketch.minimum == Decimal("0")
    assert sketch.maximum == Decimal("0")


# --- Property 3.3, 3.7 — bounded bin/bucket count regardless of stream size --------


def test_fixed_histogram_bin_count_never_varies_with_stream_size() -> None:
    """Req 28.1, 28.3, 26.11 / Property 3.3 — exactly 200 bins for a 5-sample stream
    and for a 5000-sample stream alike."""
    small = FixedHistogram()
    for value in (Decimal("1"), Decimal("22.5"), Decimal("50"), Decimal("77.25"), Decimal("99")):
        small.fold(value)

    large = FixedHistogram()
    for i in range(5000):
        large.fold(Decimal(i % 101))

    assert len(small.bins) == BIN_COUNT == 200
    assert len(large.bins) == BIN_COUNT == 200


def test_ddsketch_bucket_count_never_varies_with_stream_size() -> None:
    """Req 28.2, 28.3, 26.11 / Property 3.3 — exactly `MAX_BUCKET_COUNT` buckets for a
    5-sample stream and for a 5000-sample stream alike."""
    small = DDSketch()
    for value in (Decimal("1"), Decimal("1000"), Decimal("0"), Decimal("50000"), Decimal("999999")):
        small.fold(value)

    large = DDSketch()
    for i in range(5000):
        large.fold(Decimal(i + 1))

    assert len(small.buckets) == MAX_BUCKET_COUNT == 2048
    assert len(large.buckets) == MAX_BUCKET_COUNT == 2048


def test_declared_31_day_pt1m_stream_keeps_ddsketch_state_bounded() -> None:
    """Req 26.11, 28.3 / Property 3.7 — the declared 44640-sample stream (a 31-day
    window at `PT1M`, `31 * 24 * 60`) folds into the same fixed-size state as a
    5-sample stream. The bucket array length is the only externally observable
    stand-in for "did not retain the folded points": both streams below produce
    identically shaped state despite an 8928x difference in sample count.
    """
    sample_count = 31 * 24 * 60
    assert sample_count == 44640

    sketch = DDSketch()
    for i in range(sample_count):
        # A varied, non-repeating-in-lockstep magnitude stream that also revisits the
        # dedicated zero bucket periodically, well inside the un-clamped domain.
        value = Decimal("0") if i % 7 == 0 else Decimal(i % 1_000_000) + Decimal("0.123456")
        sketch.fold(value)

    assert sketch.sample_count == sample_count
    assert len(sketch.buckets) == MAX_BUCKET_COUNT == 2048

    small = DDSketch()
    for value in (Decimal("1"), Decimal("2"), Decimal("3")):
        small.fold(value)

    # Identical state shape regardless of the 44640x difference in points folded —
    # the assertion "bounded state" reduces to at this API surface.
    assert len(small.buckets) == len(sketch.buckets)


# --- Property 3.4 — fold-order independence (confluence) ---------------------------


@given(stream_a=percentage_streams, stream_b=percentage_streams)
@example(stream_a=PERCENTAGE_EXAMPLE_STREAM, stream_b=[Decimal("3.5"), Decimal("88")])
def test_fixed_histogram_state_is_identical_under_either_fold_order(
    stream_a: list[Decimal], stream_b: list[Decimal]
) -> None:
    """Req 28.10 / Property 3.4 — folding A before B and B before A into two fresh
    histograms produces the identical canonical state tuple."""
    a_then_b = FixedHistogram()
    for value in stream_a:
        a_then_b.fold(value)
    for value in stream_b:
        a_then_b.fold(value)

    b_then_a = FixedHistogram()
    for value in stream_b:
        b_then_a.fold(value)
    for value in stream_a:
        b_then_a.fold(value)

    assert _histogram_state(a_then_b) == _histogram_state(b_then_a)


@given(stream_a=magnitude_streams, stream_b=magnitude_streams)
@example(stream_a=MAGNITUDE_EXAMPLE_STREAM, stream_b=[Decimal("0"), Decimal("42")])
def test_ddsketch_state_is_identical_under_either_fold_order(
    stream_a: list[Decimal], stream_b: list[Decimal]
) -> None:
    """Req 28.2, 28.11 / Property 3.4 — same confluence claim for `DDSketch`,
    including the dedicated zero counter."""
    a_then_b = DDSketch()
    for value in stream_a:
        a_then_b.fold(value)
    for value in stream_b:
        a_then_b.fold(value)

    b_then_a = DDSketch()
    for value in stream_b:
        b_then_a.fold(value)
    for value in stream_a:
        b_then_a.fold(value)

    assert _ddsketch_state(a_then_b) == _ddsketch_state(b_then_a)


# --- Property 3.5 — exactness at the edges and monotonicity ------------------------


@given(samples=percentage_streams, q1=quantiles, q2=quantiles)
@example(samples=PERCENTAGE_EXAMPLE_STREAM, q1=Decimal("0"), q2=Decimal("1"))
@example(samples=PERCENTAGE_EXAMPLE_STREAM, q1=Decimal("0.3"), q2=Decimal("0.3"))
# Req 42.8 — the retained counterexamples. A step off either edge on a single-sample
# stream, which is where returning a bin midpoint for an interior `q` and the exact
# extreme at the edges stops agreeing.
@example(
    samples=SINGLE_SAMPLE_BELOW_MIDPOINT_STREAM,
    q1=Decimal("0"),
    q2=MIN_QUANTILE_STEP,
)
@example(
    samples=SINGLE_SAMPLE_ABOVE_MIDPOINT_STREAM,
    q1=NEAR_ONE_QUANTILE,
    q2=Decimal("1"),
)
@example(
    samples=SINGLE_SAMPLE_BELOW_MIDPOINT_STREAM,
    q1=NEAR_ONE_QUANTILE,
    q2=Decimal("1"),
)
def test_fixed_histogram_is_exact_at_the_edges_and_monotone_in_between(
    samples: list[Decimal], q1: Decimal, q2: Decimal
) -> None:
    """Req 28.10 / Property 3.5 — `quantile(0)` is the exact minimum, `quantile(1)`
    is the exact maximum, and the estimate is monotone non-decreasing in `q`."""
    histogram = FixedHistogram()
    for value in samples:
        histogram.fold(value)

    sorted_samples = sorted(samples)
    assert histogram.quantile(Decimal("0")) == sorted_samples[0] == histogram.minimum
    assert histogram.quantile(Decimal("1")) == sorted_samples[-1] == histogram.maximum

    lo, hi = sorted((q1, q2))
    assert histogram.quantile(lo) <= histogram.quantile(hi)


@given(samples=magnitude_streams, q1=quantiles, q2=quantiles)
@example(samples=MAGNITUDE_EXAMPLE_STREAM, q1=Decimal("0"), q2=Decimal("1"))
@example(samples=MAGNITUDE_EXAMPLE_STREAM, q1=Decimal("0.3"), q2=Decimal("0.3"))
# Req 42.8 — the exact shrunk counterexample this property first failed on. A
# log-spaced bucket bound for an interior `q` against the retained exact minimum at
# `q = 0`: `quantile(0)` returned 1.000000 and `quantile(0.000001)` returned
# 0.990099…, so the estimate ran backwards over the smallest step the generator can
# draw.
@example(
    samples=SINGLE_SAMPLE_MAGNITUDE_STREAM,
    q1=Decimal("0"),
    q2=MIN_QUANTILE_STEP,
)
@example(
    samples=SINGLE_SAMPLE_MAGNITUDE_STREAM,
    q1=NEAR_ONE_QUANTILE,
    q2=Decimal("1"),
)
def test_ddsketch_is_exact_at_the_edges_and_monotone_in_between(
    samples: list[Decimal], q1: Decimal, q2: Decimal
) -> None:
    """Req 28.10 / Property 3.5 — the same exactness-at-edges and monotonicity claim
    for `DDSketch`."""
    sketch = DDSketch()
    for value in samples:
        sketch.fold(value)

    sorted_samples = sorted(samples)
    assert sketch.quantile(Decimal("0")) == sorted_samples[0] == sketch.minimum
    assert sketch.quantile(Decimal("1")) == sorted_samples[-1] == sketch.maximum

    lo, hi = sorted((q1, q2))
    assert sketch.quantile(lo) <= sketch.quantile(hi)


# --- Property 3.6 — the declared interval-mean-trap example -------------------------


def test_declared_90_percent_at_5_and_10_percent_at_95_kills_the_interval_mean_estimator() -> None:
    """Req 28.1 / Property 3.6 — mean 14, exact p95 95; the histogram's estimate at
    0.95 must be at least 94.5, which no implementation estimating a percentile from
    the running mean can produce."""
    samples = [Decimal("5")] * 900 + [Decimal("95")] * 100

    histogram = FixedHistogram()
    for value in samples:
        histogram.fold(value)

    # The exact quantile this stream produces, worked by hand per Property 3.1's own
    # definition: rank = ceil(0.95 * 1000) = 950, the 950th ascending sample, which
    # falls inside the block of 100 samples equal to 95.
    assert exact_quantile(sorted(samples), Decimal("0.95")) == Decimal("95")

    mean = sum(samples) / Decimal(len(samples))
    assert mean == Decimal("14")

    estimate = histogram.quantile(Decimal("0.95"))
    assert isinstance(estimate, Decimal)
    assert estimate >= Decimal("94.5")
    # Directly kills "estimate the percentile from the interval mean": that
    # implementation would return (something close to) 14, not >= 94.5.
    assert estimate != mean


# --- sketch_for_unit_family dispatch (Req 28.9, 28.13, 32.6) ------------------------


def test_sketch_for_unit_family_dispatches_on_the_declared_family_only() -> None:
    """The two declared families select their sketch kind; every other string,
    including a metric name, selects neither."""
    assert isinstance(sketch_for_unit_family(UNIT_FAMILY_PERCENTAGE), FixedHistogram)
    assert isinstance(sketch_for_unit_family(UNIT_FAMILY_MAGNITUDE), DDSketch)

    assert sketch_for_unit_family("count") is None
    assert sketch_for_unit_family("") is None
    # Never dispatched on a metric-name substring, even one that looks suggestive.
    assert sketch_for_unit_family("Percentage CPU") is None
    assert sketch_for_unit_family("Disk Read Operations/Sec") is None


# --- empty-sketch guard (documented in sketch.py; not itself a Property 3 claim) ---


def test_quantile_on_an_empty_sketch_raises_value_error() -> None:
    """Neither sketch kind has a defined quantile before anything is folded — this
    file's generators always fold at least one value first, and this test pins the
    documented exception behaviour at the boundary they deliberately avoid."""
    with pytest.raises(ValueError):
        FixedHistogram().quantile(Decimal("0.5"))
    with pytest.raises(ValueError):
        DDSketch().quantile(Decimal("0.5"))
