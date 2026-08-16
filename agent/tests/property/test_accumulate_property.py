"""Property 1 — count-weighted aggregation is exact and partition-independent.

**Validates: Requirements 27.1, 27.2, 27.3, 27.4, 27.9, 27.11, 27.12, 42.2**

*Invariant / model-based.* Generate a list of sample values partitioned into buckets
of unequal size — each bucket carrying the `{total, count, minimum, maximum}` an
Azure batch-metrics response actually returns — fold every bucket through a fresh
:class:`~reporting_agent.collect.accumulate.MetricAccumulator`, and compare the
result against an expectation re-derived directly from the underlying samples rather
than by re-implementing the accumulator's own summation loop.

Every assertion group below is built with `sketch=None`
(`MetricAccumulator()`'s own default), bypassing `new_accumulator`, so this file is
purely about `total`/`count`/`minimum`/`maximum` bookkeeping and never also
exercises the percentile sketch — that is `test_sketch_property.py`'s claim
(Property 3), already covered by tasks 9.5/9.6.

Four classes of failure a plausible implementation gets wrong, one per assertion
group:

* **Averaging the averages.** `sum(total) / sum(count)` and
  `mean(total_i / count_i for each bucket)` agree only when every bucket carries the
  same sample count. The declared 3-samples-at-100/60-samples-at-0 example
  (Property 1.3, Req 27.2) makes that divergence enormous — 4.761905 against a naive
  50.000000 — specifically because a partial hour at a window edge (3 samples) must
  not be weighted the same as a full hour (60 samples).
* **Dividing by the bucket count instead of the summed count.** The declared
  744-bucket example, 700 empty followed by 44 full, is the month-boundary and
  recently-created-VM case verbatim: an implementation that divides by `len(buckets)`
  (744) rather than `sum(count)` (2640) reports a number two orders of magnitude too
  small. `test_declared_744_bucket_example...` asserts the *actual* wrong value the
  bug would produce, not just a mismatch, so a shrunk counterexample failing this
  test names the exact defect rather than "something is off".
* **Losing exactness at the extremes.** `minimum`/`maximum` must equal the true
  minimum/maximum across every underlying sample, not an approximation — Req 27.3
  and 27.4 give no error budget, unlike the sketches in Property 3.
* **Order- and partition-sensitivity.** A commutative-sum implementation is
  order-independent by construction, but a plausible bug (accumulating into a
  Python list and reducing it with a non-associative or order-dependent combinator,
  or memoizing a stale running average) is not. Folding the same buckets in a
  shuffled order, and folding the same flat sample list bucketed two different ways,
  must produce byte-identical `AccumulatorResult`s (Req 27.12).

**Generator scale, following `test_sketch_property.py`'s own precedent.** Req 42.2's
generator clause (Property 1.5) names bucket counts up to 744 and per-bucket sample
counts up to 60 — up to 44640 underlying samples per generated case. Drawing that
scale on every one of 100 `@given` examples would make this file the slowest thing
in the suite for no additional defect-finding power: hypothesis's own small-list
bias means a bounded `max_size` already explores every interesting shape (zero
buckets removed, buckets of size 0, 1 and many, orders shuffled) far more times than
a handful of near-744 draws would. `test_sketch_property.py`'s module docstring
makes exactly this call for its own 44640-sample declared stream ("a generated
property test over lists of at most a few hundred elements would never by itself
reach a scale where retaining every point becomes distinguishable from bounded
state"). This file draws `@given` bucket lists capped at 50 buckets and pins the
literal 3/60 and 744-bucket cases as `@example`s instead — committed, so they run on
every future execution of this property (Req 42.8) regardless of what hypothesis
happens to draw.
"""

from __future__ import annotations

import random
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from typing import TypedDict

from hypothesis import example, given
from hypothesis import strategies as st

from reporting_agent.collect.accumulate import (
    AVERAGE_QUANTIZE_SCALE,
    WORKING_PRECISION,
    MetricAccumulator,
)
from reporting_agent.collect.log import GAP_TYPE_NO_SAMPLES

RESOURCE_ID = "vm-1"
METRIC_NAME = "Percentage CPU"

# --- generators ----------------------------------------------------------------------

DECIMAL_PLACES = 6

# Req 27.5's generator clause / Property 1.5 — at most 6 decimal places, 0 to 100 for
# a percentage metric. `places=6` draws exactly 6 digits after the point, a subset of
# "at most 6" (trailing zeros add no precision), matching `test_sketch_property.py`'s
# own reasoning for the identical choice.
percentage_values = st.decimals(
    min_value=Decimal("0"),
    max_value=Decimal("100"),
    places=DECIMAL_PLACES,
    allow_nan=False,
    allow_infinity=False,
)

MAGNITUDE_UPPER = Decimal(10) ** 15

# Req 27.5's generator clause — 0 to 10**15 for a byte, IOPS or throughput metric.
magnitude_values = st.decimals(
    min_value=Decimal("0"),
    max_value=MAGNITUDE_UPPER,
    places=DECIMAL_PLACES,
    allow_nan=False,
    allow_infinity=False,
)

_DOMAINS = ("percentage", "magnitude")


def _value_strategy(domain: str) -> st.SearchStrategy[Decimal]:
    return percentage_values if domain == "percentage" else magnitude_values


class Bucket(TypedDict):
    """One folded interval's `{total, count, minimum, maximum}`, plus the exact
    underlying samples that produced it — kept alongside so the exactness and
    partition-independence assertions below can be checked against the samples
    themselves rather than against a second copy of the bucket's own fields."""

    total: Decimal
    count: Decimal
    minimum: Decimal | None
    maximum: Decimal | None
    samples: tuple[Decimal, ...]


def _bucket_from_samples(samples: tuple[Decimal, ...]) -> Bucket:
    """Build a well-formed bucket from a (possibly empty) tuple of underlying
    samples — a zero-count bucket has no minimum, no maximum and no total to speak
    of beyond `Decimal(0)`, matching Req 27.7's "an ordinary empty bucket" case."""
    if not samples:
        return Bucket(total=Decimal(0), count=Decimal(0), minimum=None, maximum=None, samples=())
    return Bucket(
        total=sum(samples),
        count=Decimal(len(samples)),
        minimum=min(samples),
        maximum=max(samples),
        samples=samples,
    )


def _bucket_strategy(value_strategy: st.SearchStrategy[Decimal]) -> st.SearchStrategy[Bucket]:
    """One bucket: a sample count drawn 0-60 (Property 1.5), then that many samples."""

    @st.composite
    def _bucket(draw: st.DrawFn) -> Bucket:
        count = draw(st.integers(min_value=0, max_value=60))
        if count == 0:
            return _bucket_from_samples(())
        samples = tuple(draw(st.lists(value_strategy, min_size=count, max_size=count)))
        return _bucket_from_samples(samples)

    return _bucket()


@st.composite
def bucket_lists(draw: st.DrawFn, *, max_buckets: int = 50) -> list[Bucket]:
    """A list of 1 to `max_buckets` buckets, all drawn from one value domain
    (percentage or magnitude) — see the module docstring for why `max_buckets` is
    scaled down from Property 1.5's declared 744-bucket ceiling for the `@given`
    generator, with the literal 744-bucket case pinned as an `@example` instead."""
    domain = draw(st.sampled_from(_DOMAINS))
    value_strategy = _value_strategy(domain)
    bucket_strategy = _bucket_strategy(value_strategy)
    return draw(st.lists(bucket_strategy, min_size=1, max_size=max_buckets))


@st.composite
def flat_sample_lists(draw: st.DrawFn, *, max_size: int = 100) -> list[Decimal]:
    """A flat list of 1 to `max_size` samples from one value domain, for the
    partition-independence property, which re-buckets one such list two ways."""
    domain = draw(st.sampled_from(_DOMAINS))
    value_strategy = _value_strategy(domain)
    return draw(st.lists(value_strategy, min_size=1, max_size=max_size))


# --- the two declared examples (Property 1.3, Req 27.2 / Req 42.8) -------------------

# One bucket of 3 samples at 100, one bucket of 60 samples at 0 — count-weighted
# 300 / 63 = 4.761905, against a naive mean-of-bucket-averages of 50.000000, a
# 45-point gap (Property 1.3, first clause).
DECLARED_EXAMPLE_1: list[Bucket] = [
    _bucket_from_samples((Decimal("100"),) * 3),
    _bucket_from_samples((Decimal("0"),) * 60),
]

# 744 buckets — the hourly slot count of a 31-day window — the first 700 carrying a
# count of 0, the remaining 44 each carrying 60 samples of 42, so the count-weighted
# average is exactly 42.000000, never a number close to `44 * 2520 / 744` (Property
# 1.3, second clause).
DECLARED_EXAMPLE_2: list[Bucket] = [_bucket_from_samples(()) for _ in range(700)] + [
    _bucket_from_samples((Decimal("42"),) * 60) for _ in range(44)
]


# --- shared fold/expectation helpers --------------------------------------------------


def fold_all(buckets: list[Bucket]) -> MetricAccumulator:
    """Fold every bucket into a fresh accumulator, asserting along the way that a
    well-formed generated bucket never itself produces an `interval_malformed` gap
    — that classification is `test_boundaries`/unit-test territory (task 9.7), not
    this property's concern."""
    accumulator = MetricAccumulator()
    for bucket in buckets:
        gap = accumulator.fold_interval(
            total=bucket["total"],
            count=bucket["count"],
            minimum=bucket["minimum"],
            maximum=bucket["maximum"],
            resource_id=RESOURCE_ID,
            metric=METRIC_NAME,
        )
        assert gap is None
    return accumulator


def expected_average(buckets: list[Bucket]) -> Decimal | None:
    """`sum(total) / sum(count)`, at Req 27.11's working precision and quantization —
    re-derived independently from the input buckets, never by calling into
    `MetricAccumulator` itself. `None` when the summed count is zero."""
    total = sum((b["total"] for b in buckets), start=Decimal(0))
    count = sum((b["count"] for b in buckets), start=Decimal(0))
    if count == 0:
        return None
    with localcontext() as ctx:
        ctx.prec = WORKING_PRECISION
        return (total / count).quantize(AVERAGE_QUANTIZE_SCALE, rounding=ROUND_HALF_EVEN)


def expected_extremes(buckets: list[Bucket]) -> tuple[Decimal | None, Decimal | None]:
    """The true minimum and maximum across every underlying sample of every bucket,
    read directly from each bucket's own `samples`, not from its pre-computed
    `minimum`/`maximum` fields (which this test is partly trying to verify)."""
    all_samples = [sample for bucket in buckets for sample in bucket["samples"]]
    if not all_samples:
        return None, None
    return min(all_samples), max(all_samples)


# --- Property 1.1, 1.2, 1.5 — count-weighted correctness and exact extremes ----------


@given(buckets=bucket_lists())
@example(buckets=DECLARED_EXAMPLE_1)
@example(buckets=DECLARED_EXAMPLE_2)
def test_average_matches_the_independently_derived_count_weighted_expectation(
    buckets: list[Bucket],
) -> None:
    """Req 27.1, 27.9, 27.11 / Property 1.1 — `finalize()`'s average equals
    `sum(total) / sum(count)` computed independently from the input, quantized
    identically; a summed count of zero instead emits `(None, no_samples gap)`."""
    result, gap = fold_all(buckets).finalize(RESOURCE_ID, METRIC_NAME)
    expected = expected_average(buckets)

    if expected is None:
        assert result is None
        assert gap is not None
        assert gap["gap_type"] == GAP_TYPE_NO_SAMPLES
        assert gap["resource_id"] == RESOURCE_ID
        assert gap["metric"] == METRIC_NAME
        return

    assert gap is None
    assert result is not None
    assert result.average == expected
    assert result.sample_count == sum((b["count"] for b in buckets), start=Decimal(0))


@given(buckets=bucket_lists())
@example(buckets=DECLARED_EXAMPLE_1)
@example(buckets=DECLARED_EXAMPLE_2)
def test_minimum_and_maximum_equal_the_exact_extremes_of_every_underlying_sample(
    buckets: list[Bucket],
) -> None:
    """Req 27.3, 27.4 / Property 1.2 — no error budget: the rolled-up minimum and
    maximum equal the true minimum and maximum across every sample folded, across
    every bucket, not merely across the buckets' own pre-computed extremes."""
    result, gap = fold_all(buckets).finalize(RESOURCE_ID, METRIC_NAME)
    expected_min, expected_max = expected_extremes(buckets)

    if expected_min is None:
        assert result is None
        assert gap is not None
        return

    assert result is not None
    assert result.minimum == expected_min
    assert result.maximum == expected_max


# --- Property 1.3 — the two declared examples, asserted exactly ---------------------


def test_declared_3_and_60_sample_buckets_kill_the_mean_of_bucket_averages_estimator() -> None:
    """Req 27.1, 27.2 / Property 1.3, first clause. `300 / 63` quantized to 6 places
    is `4.761905`; the naive mean of the two bucket averages (100 and 0) is
    `50.000000` — a 45-point gap only a count-weighted implementation closes."""
    result, gap = fold_all(DECLARED_EXAMPLE_1).finalize(RESOURCE_ID, METRIC_NAME)

    assert gap is None
    assert result is not None
    assert result.average == Decimal("4.761905")
    assert result.minimum == Decimal("0")
    assert result.maximum == Decimal("100")
    assert result.sample_count == Decimal("63")

    naive_mean_of_bucket_averages = Decimal("50.000000")
    assert result.average != naive_mean_of_bucket_averages
    assert naive_mean_of_bucket_averages - result.average >= Decimal("45")


def test_declared_744_bucket_example_kills_dividing_by_the_bucket_count() -> None:
    """Req 27.1, 27.9 / Property 1.3, second clause. 700 empty buckets followed by 44
    buckets of 60 samples at 42 must average to exactly `42.000000` — never a number
    near `44 * 2520 / 744`, which is what an implementation dividing the summed total
    by the number of buckets (744) rather than the summed count (2640) would produce.
    """
    assert len(DECLARED_EXAMPLE_2) == 744

    result, gap = fold_all(DECLARED_EXAMPLE_2).finalize(RESOURCE_ID, METRIC_NAME)

    assert gap is None
    assert result is not None
    assert result.average == Decimal("42.000000")
    assert result.minimum == Decimal("42")
    assert result.maximum == Decimal("42")
    assert result.sample_count == Decimal("2640")  # 44 * 60, never 744

    with localcontext() as ctx:
        ctx.prec = WORKING_PRECISION
        wrong_divide_by_bucket_count = (Decimal("44") * Decimal("2520") / Decimal("744")).quantize(
            AVERAGE_QUANTIZE_SCALE, rounding=ROUND_HALF_EVEN
        )
    assert result.average != wrong_divide_by_bucket_count


# --- Property 1.4 — fold-order independence -----------------------------------------


@given(buckets=bucket_lists(), shuffle_seed=st.integers(min_value=0, max_value=2**32 - 1))
@example(buckets=DECLARED_EXAMPLE_1, shuffle_seed=0)
@example(buckets=DECLARED_EXAMPLE_2, shuffle_seed=12345)
def test_fold_order_never_affects_the_result(buckets: list[Bucket], shuffle_seed: int) -> None:
    """Req 27.12 / Property 1.4, first clause — folding the same buckets in the
    original order and in a shuffled order into two fresh accumulators produces
    identical `average`, `minimum`, `maximum` and `sample_count`."""
    original_result, original_gap = fold_all(buckets).finalize(RESOURCE_ID, METRIC_NAME)

    shuffled = list(buckets)
    random.Random(shuffle_seed).shuffle(shuffled)
    shuffled_result, shuffled_gap = fold_all(shuffled).finalize(RESOURCE_ID, METRIC_NAME)

    assert original_result == shuffled_result
    assert (original_gap is None) == (shuffled_gap is None)
    if original_gap is not None:
        assert shuffled_gap is not None
        assert original_gap["gap_type"] == shuffled_gap["gap_type"]


# --- Property 1.4 — partition independence ------------------------------------------


@given(samples=flat_sample_lists())
@example(samples=[Decimal("100")] * 3 + [Decimal("0")] * 60)
def test_the_result_depends_on_the_samples_not_on_how_they_were_bucketed(
    samples: list[Decimal],
) -> None:
    """Req 27.12 / Property 1.4, second clause — one flat sample list, partitioned
    into a single bucket and, separately, into one singleton bucket per sample,
    produces an identical `finalize()` result either way."""
    samples_tuple = tuple(samples)

    one_big_bucket = [_bucket_from_samples(samples_tuple)]
    one_singleton_bucket_per_sample = [_bucket_from_samples((sample,)) for sample in samples_tuple]

    one_bucket_result, one_bucket_gap = fold_all(one_big_bucket).finalize(RESOURCE_ID, METRIC_NAME)
    many_buckets_result, many_buckets_gap = fold_all(one_singleton_bucket_per_sample).finalize(
        RESOURCE_ID, METRIC_NAME
    )

    assert one_bucket_gap is None
    assert many_buckets_gap is None
    assert one_bucket_result == many_buckets_result


# --- Property 1.6 — zero-count buckets never affect the result ----------------------


@given(buckets=bucket_lists())
@example(buckets=DECLARED_EXAMPLE_2)
def test_removing_zero_count_buckets_from_a_partition_never_changes_the_result(
    buckets: list[Bucket],
) -> None:
    """Req 27.7, 27.9 / Property 1.6 — a partition containing zero-count buckets
    produces the same `finalize()` result as the same partition with every
    zero-count bucket removed, so the property fails against an implementation that
    divides by the number of buckets rather than by the summed count."""
    without_zero_count = [b for b in buckets if b["count"] > 0]

    with_zero_result, with_zero_gap = fold_all(buckets).finalize(RESOURCE_ID, METRIC_NAME)
    without_zero_result, without_zero_gap = fold_all(without_zero_count).finalize(
        RESOURCE_ID, METRIC_NAME
    )

    assert with_zero_result == without_zero_result
    assert (with_zero_gap is None) == (without_zero_gap is None)
    if with_zero_gap is not None:
        assert without_zero_gap is not None
        assert with_zero_gap["gap_type"] == without_zero_gap["gap_type"]


# --- Property 1.7 — an all-zero-count partition emits nothing -----------------------


@given(bucket_count=st.integers(min_value=0, max_value=744))
@example(bucket_count=0)
@example(bucket_count=700)
@example(bucket_count=744)
def test_an_all_zero_count_partition_emits_no_average_minimum_or_maximum(
    bucket_count: int,
) -> None:
    """Req 27.9 / Property 1.7 — every bucket in the partition carrying a count of 0
    (including the degenerate empty partition, `bucket_count == 0`) leaves the
    accumulator's summed count at zero, so `finalize()` reports `(None, no_samples
    gap)` rather than a fabricated zero-valued result."""
    zero_count_buckets = [_bucket_from_samples(()) for _ in range(bucket_count)]

    result, gap = fold_all(zero_count_buckets).finalize(RESOURCE_ID, METRIC_NAME)

    assert result is None
    assert gap is not None
    assert gap["gap_type"] == GAP_TYPE_NO_SAMPLES
    assert gap["resource_id"] == RESOURCE_ID
    assert gap["metric"] == METRIC_NAME
