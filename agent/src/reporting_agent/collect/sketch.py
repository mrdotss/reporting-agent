"""Bounded sketches: a fixed 0-100 histogram and a log-spaced DDSketch (Req 28).

Two structures, one job each, selected by the Metric_Catalog's declared `unit_family`
and never by a metric name substring (Req 28.9, 32.6) — `Disk Read Operations/Sec`
contains no substring that reliably classifies it, and a name-sniffing selector
silently mis-sketches the next metric a catalog entry adds:

* **`percentage`** (CPU, memory %, % free space) folds into :class:`FixedHistogram`:
  a fixed range of 0 to 100 at a bin width of 0.5, exactly 200 bins (Req 28.1, 28.3).
* **`magnitude`** (bytes, IOPS, throughput) folds into :class:`DDSketch`: a log-spaced
  sketch at `gamma = 1.02`, at most 2048 buckets plus one dedicated zero bucket
  (Req 28.2, 28.3, 28.11).
* Any other declared family selects neither structure. :func:`sketch_for_unit_family`
  returns `None` for it, so the caller (`collect/accumulate.py`, a later task) records
  a `percentile_unsupported_unit` gap and continues collecting that metric's avg, min
  and max (Req 28.13, 32.6) — losing a percentile is not losing a metric.

**Both are ~1-2 KB per series regardless of window length (Req 26.11, 28.3).** A bin
count and a bucket count that do not vary with the number of points folded is what
makes a 31-day month at `PT1H` occupy the same state as a single day — every counter
here lives in a **fixed-length** array allocated once at construction, not a `dict`
keyed by however many distinct values happened to arrive. Folding a point updates
counts in place and the point itself is discarded immediately after (Req 26.1); no
sketch in this module ever holds a point, only a count of points that landed in one
bin or bucket.

**Every value in and out of a sketch is a `Decimal`.** `FixedHistogram` reports each
bin's representative value as its **midpoint** rather than a boundary, so its
worst-case absolute error is half a bin width, 0.25 — inside the 0.5 percentage-point
bound this module exists to satisfy (Property 3.1). `DDSketch` reports each bucket's
representative value with the standard formula `2 * gamma**i / (gamma + 1)`, which
bounds *relative* error at `(gamma - 1) / (gamma + 1)`; at `gamma = 1.02` that is
`0.02 / 2.02 ≈ 0.0099`, comfortably inside the 1% bound (Property 3.2). Both the index
computation and the representative-value computation run on `Decimal.ln()` inside a
raised-precision local context rather than `math.log` — the General Decimal
Arithmetic algorithm behind `Decimal.ln()` is specified bit-for-bit rather than
delegated to the platform's `libm`, which is the same reproducibility argument
`azure-integration.md` §8 makes for keeping `float` off the path from a folded
response to a snapshot value. A percentile is exactly such a value.

**Why `DDSketch` also retains the exact observed minimum and maximum.** Req 28.10
only requires it for the fixed histogram; this module extends the same guarantee to
`DDSketch` because Property 3.5 states it as a bound over both sketch kinds ("the
q=0 estimate equals the retained observed minimum and q=1 the observed maximum"),
and two extra `Decimal` fields per sketch is not a bounded-state concern. It also
means both sketch types satisfy the same exactness contract at the domain's edges,
so a caller never has to special-case one kind over the other.

**Why `DDSketch`'s bucket range is a fixed, clamped window rather than an unbounded
dict.** For the domain this catalog actually covers — bytes, IOPS and throughput,
practically 0 to `10^15` — `ceil(ln(10^15) / ln(1.02))` is approximately 1745, which
is comfortably inside 2048 (see the module-level `MAX_RAW_INDEX` note below). But
Req 28.3's bound is unconditional ("at most 2048 buckets"), and a `Decimal` value with
up to 6 fractional digits can fall below 1 without being zero, which pushes the raw
index negative with no floor. Rather than let an adversarial stream of many distinct
tiny fractional values grow a `dict` past 2048 keys, the bucket store is a **fixed
array of exactly 2048 slots** spanning a declared raw-index window, and any computed
index outside that window folds into the nearest boundary slot — the same "fold into
the nearest boundary bin" rule Req 28.10 states explicitly for the fixed histogram,
applied here for the same reason: bounded state must hold for every input, not only
for the inputs a well-behaved Azure response is expected to contain.
"""

from __future__ import annotations

from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, localcontext
from typing import Final

from reporting_agent.collect.log import GAP_TYPE_PERCENTILE_UNSUPPORTED_UNIT

__all__ = [
    "BIN_COUNT",
    "BIN_WIDTH",
    "GAMMA",
    "HISTOGRAM_LOWER_BOUND",
    "HISTOGRAM_UPPER_BOUND",
    "MAX_BUCKET_COUNT",
    "MAX_RAW_INDEX",
    "MIN_RAW_INDEX",
    "PERCENTILE_UNSUPPORTED_UNIT_GAP_TYPE",
    "UNIT_FAMILY_MAGNITUDE",
    "UNIT_FAMILY_PERCENTAGE",
    "DDSketch",
    "FixedHistogram",
    "Sketch",
    "sketch_for_unit_family",
]

# --- the catalog-declared unit families this module dispatches on (Req 28.9) -------
#
# These mirror `catalog.loader.DECLARED_UNIT_FAMILIES` by value, deliberately not by
# import: `collect/` stays independent of `catalog/` (the collect pipeline sees a
# plain `unit_family` string handed to it by whatever assembles a fold call, not a
# `LoadedCatalog` object), the same separation `providers/base.py` draws between the
# provider protocol and any one provider's SDK types. A later integration task may
# choose to have one module own both constants; until then the two files agreeing on
# the same two string literals is the contract.

UNIT_FAMILY_PERCENTAGE: Final[str] = "percentage"
UNIT_FAMILY_MAGNITUDE: Final[str] = "magnitude"

# The gap this module's caller records when a catalog entry declares a family that
# selects neither sketch kind (Req 28.13, 32.6). Imported from `collect/log.py`,
# which now owns the 19-value declared `gap_type` vocabulary, rather than
# re-declared here — the same pattern `collect/log.py` itself uses for
# `catalog.loader.CATALOG_ENTRY_INVALID_GAP_TYPE`. This reconciles what was
# previously a provisional, independently-declared local constant (written before
# `collect/log.py` existed) with that vocabulary, so the two can never drift into
# two different spellings of one gap type.
PERCENTILE_UNSUPPORTED_UNIT_GAP_TYPE: Final[str] = GAP_TYPE_PERCENTILE_UNSUPPORTED_UNIT

# --- FixedHistogram parameters (Req 28.1, 28.3) -------------------------------------

HISTOGRAM_LOWER_BOUND: Final[Decimal] = Decimal("0")
HISTOGRAM_UPPER_BOUND: Final[Decimal] = Decimal("100")
BIN_WIDTH: Final[Decimal] = Decimal("0.5")
BIN_COUNT: Final[int] = 200  # (100 - 0) / 0.5, exactly — the Req 28.3 bound

assert BIN_COUNT == int((HISTOGRAM_UPPER_BOUND - HISTOGRAM_LOWER_BOUND) / BIN_WIDTH)

# --- DDSketch parameters (Req 28.2, 28.3, 28.11) ------------------------------------

GAMMA: Final[Decimal] = Decimal("1.02")
MAX_BUCKET_COUNT: Final[int] = 2048  # the Req 28.3 bound on log-spaced buckets

# The relative-error guarantee this gamma buys, `(gamma - 1) / (gamma + 1)`, is
# documented in the module docstring; it is not a runtime constant because nothing in
# this module needs to compute with it, only report it in prose.

# The fixed raw-index window the bucket array spans. `MAX_RAW_INDEX = 1900` leaves
# headroom above `ceil(ln(10^15) / ln(1.02)) ≈ 1745` (the practical upper bound this
# catalog covers per `azure-integration.md` §6) for a magnitude value somewhat past
# 10^15 to still land inside the window rather than immediately clamping. The window
# width is exactly `MAX_BUCKET_COUNT`, so `MIN_RAW_INDEX` falls out of that choice:
# `1900 - 2048 + 1 = -147`, i.e. any positive value below `gamma**-147 ≈ 0.054`
# clamps into the lowest bucket. That threshold is an explicit, documented trade-off
# for adversarial sub-unit inputs; see the module docstring.
MAX_RAW_INDEX: Final[int] = 1900
MIN_RAW_INDEX: Final[int] = MAX_RAW_INDEX - MAX_BUCKET_COUNT + 1

assert MAX_RAW_INDEX - MIN_RAW_INDEX + 1 == MAX_BUCKET_COUNT

# Working precision for every `Decimal.ln()` / `Decimal.__pow__` call in this module.
# 50 significant digits is far past what a value up to `10^15` or an exponent up to
# `MAX_RAW_INDEX` needs to round correctly to the nearest integer index or the sixth
# decimal place of a representative value; it exists to keep index computation away
# from any boundary-rounding ambiguity, not because the inputs need it.
_DECIMAL_PRECISION: Final[int] = 50

_ZERO: Final[Decimal] = Decimal("0")
_ONE: Final[Decimal] = Decimal("1")
_HALF: Final[Decimal] = Decimal("0.5")


def _clamp(value: int, *, lower: int, upper: int) -> int:
    """Clamp `value` into `[lower, upper]`."""
    if value < lower:
        return lower
    if value > upper:
        return upper
    return value


def _quantile_as_decimal(q: Decimal | float | int) -> Decimal:
    """Coerce a quantile argument to `Decimal` without ever passing through a bare
    `float` division — `Decimal(str(q))` for a `float`, so `0.95` round-trips as the
    text `"0.95"` a user actually wrote rather than its nearest `float` binary
    fraction. `Decimal` and `int` inputs pass through as `Decimal` directly."""
    if isinstance(q, Decimal):
        return q
    return Decimal(str(q))


class FixedHistogram:
    """A fixed 0-100 histogram at bin width 0.5 — exactly 200 bins (Req 28.1, 28.3).

    State is a **fixed-length** list of 200 bin counts, allocated once, plus the two
    `Decimal` fields holding the exact observed minimum and maximum. Neither grows
    with the number of points folded (Req 26.11): a month at `PT1H` and a day at
    `PT1H` occupy the same bytes.

    A value below 0 or above 100 folds into the nearest boundary bin — bin 0 or bin
    199 — rather than being rejected or extending the range (Req 28.10). The exact
    observed minimum and maximum are retained *alongside* the bins specifically so
    that fact does not cost accuracy at the domain's edges: `quantile(0)` and
    `quantile(1)` return those exact values rather than a bin midpoint, so an
    out-of-range fold never makes the 0 or 1 quantile estimate worse than exact.
    """

    __slots__ = ("_bins", "_count", "_maximum", "_minimum")

    def __init__(self) -> None:
        self._bins: list[int] = [0] * BIN_COUNT
        self._count: int = 0
        self._minimum: Decimal | None = None
        self._maximum: Decimal | None = None

    def fold(self, value: Decimal) -> None:
        """Fold one observed value into the histogram.

        Updates the exact observed minimum and maximum unconditionally, then
        increments exactly one bin — the value's own bin if it falls inside
        `[0, 100]`, or the nearest boundary bin otherwise (Req 28.10).
        """
        if self._minimum is None or value < self._minimum:
            self._minimum = value
        if self._maximum is None or value > self._maximum:
            self._maximum = value

        self._bins[self._bin_index(value)] += 1
        self._count += 1

    @staticmethod
    def _bin_index(value: Decimal) -> int:
        """The bin index `value` folds into, clamped to `[0, BIN_COUNT - 1]`."""
        if value <= HISTOGRAM_LOWER_BOUND:
            return 0
        if value >= HISTOGRAM_UPPER_BOUND:
            return BIN_COUNT - 1
        quotient = (value - HISTOGRAM_LOWER_BOUND) / BIN_WIDTH
        index = int(quotient.to_integral_value(rounding=ROUND_FLOOR))
        return _clamp(index, lower=0, upper=BIN_COUNT - 1)

    @staticmethod
    def bin_midpoint(index: int) -> Decimal:
        """The representative value reported for bin `index` — that bin's
        **midpoint**, `index * BIN_WIDTH + BIN_WIDTH / 2` (Req 28.1)."""
        return HISTOGRAM_LOWER_BOUND + BIN_WIDTH * index + BIN_WIDTH * _HALF

    def quantile(self, q: Decimal | float | int) -> Decimal:
        """Estimate the value at quantile `q` (`0 <= q <= 1`).

        `q <= 0` returns the exact observed minimum and `q >= 1` the exact observed
        maximum (Property 3.5), both retained independently of the bins. Every other
        `q` returns the midpoint of the smallest-indexed bin whose cumulative count,
        scanning from bin 0, is at least `q * sample_count` — the nearest-rank method,
        which is monotone non-decreasing in `q` because cumulative counts are
        themselves non-decreasing.

        That bin-midpoint estimate is then **clamped into `[minimum, maximum]`**
        before being returned. Clamping a monotone non-decreasing function to a fixed
        range is itself monotone non-decreasing, so the clamp cannot break the
        ordering the nearest-rank scan already established — it only pulls an
        estimate back inside the exact observed range when an out-of-range fold (Req
        28.10) placed the relevant bin's midpoint outside it. Without the clamp, a
        `q` just above 0 (or just below 1) can return a midpoint on the *wrong side*
        of `quantile(0)` (or `quantile(1)`), which is exactly the boundary violation
        of monotonicity Property 3.5 forbids; the clamp can only tighten the existing
        0.25 worst-case error, never widen it, since the true quantile always lies
        within `[minimum, maximum]`.

        Raises `ValueError` if nothing has been folded yet: an empty histogram has no
        minimum, no maximum and no bin with any mass, so no quantile is defined.
        """
        if self._count == 0:
            raise ValueError("quantile() called on a FixedHistogram with no folded values")

        q_decimal = _quantile_as_decimal(q)

        if q_decimal <= 0:
            assert self._minimum is not None
            return self._minimum
        if q_decimal >= 1:
            assert self._maximum is not None
            return self._maximum

        assert self._minimum is not None
        assert self._maximum is not None

        target = q_decimal * Decimal(self._count)
        cumulative = 0
        for index, bin_count in enumerate(self._bins):
            if bin_count == 0:
                continue
            cumulative += bin_count
            if Decimal(cumulative) >= target:
                return max(self._minimum, min(self.bin_midpoint(index), self._maximum))

        # Unreachable given `target < sample_count` whenever `q < 1`, which is
        # guaranteed by the `q_decimal >= 1` branch above — kept as a defined
        # fallback rather than an assertion so a future floating-point-adjacent
        # rounding surprise degrades to the exact maximum instead of raising.
        return self._maximum

    @property
    def bins(self) -> tuple[int, ...]:
        """The 200 bin counts, in bin order. Always length `BIN_COUNT` regardless of
        how many values have been folded — the bounded-state guarantee made
        inspectable."""
        return tuple(self._bins)

    @property
    def minimum(self) -> Decimal | None:
        """The exact observed minimum, or `None` if nothing has been folded."""
        return self._minimum

    @property
    def maximum(self) -> Decimal | None:
        """The exact observed maximum, or `None` if nothing has been folded."""
        return self._maximum

    @property
    def sample_count(self) -> int:
        """The number of values folded so far."""
        return self._count


class DDSketch:
    """A log-spaced DDSketch at `gamma = 1.02`, at most 2048 buckets plus one
    dedicated zero bucket (Req 28.2, 28.3, 28.11).

    State is a **fixed-length** list of `MAX_BUCKET_COUNT` bucket counts spanning the
    raw-index window `[MIN_RAW_INDEX, MAX_RAW_INDEX]`, allocated once, plus a
    dedicated zero counter and the exact observed minimum and maximum. None of these
    grow with the number of points folded (Req 26.11, 28.3).

    Exact zero is folded into the dedicated zero bucket rather than a log-spaced one,
    because `log(0)` has no index — without this, a resource whose every interval in
    the window was idle would have an undefined quantile instead of the correct
    answer, which is exactly 0 (Req 28.11).
    """

    __slots__ = ("_buckets", "_count", "_gamma", "_log_gamma", "_maximum", "_minimum", "_zero_count")

    def __init__(self, gamma: Decimal = GAMMA) -> None:
        self._gamma: Decimal = gamma
        with localcontext() as ctx:
            ctx.prec = _DECIMAL_PRECISION
            self._log_gamma: Decimal = gamma.ln()
        self._buckets: list[int] = [0] * MAX_BUCKET_COUNT
        self._zero_count: int = 0
        self._count: int = 0
        self._minimum: Decimal | None = None
        self._maximum: Decimal | None = None

    def fold(self, value: Decimal) -> None:
        """Fold one observed value into the sketch.

        A negative value has no meaning for a magnitude metric (bytes, IOPS and
        throughput are never negative); it is treated as an invalid reading of 0
        rather than raising, mirroring `FixedHistogram.fold`'s boundary-clamping
        philosophy for out-of-domain input. An exact 0 goes to the dedicated zero
        bucket (Req 28.11). Every other value goes to the log-spaced bucket its raw
        index falls into, clamped to `[MIN_RAW_INDEX, MAX_RAW_INDEX]`.
        """
        if value < _ZERO:
            value = _ZERO

        if self._minimum is None or value < self._minimum:
            self._minimum = value
        if self._maximum is None or value > self._maximum:
            self._maximum = value

        self._count += 1

        if value == _ZERO:
            self._zero_count += 1
            return

        raw_index = self._raw_index(value)
        clamped_index = _clamp(raw_index, lower=MIN_RAW_INDEX, upper=MAX_RAW_INDEX)
        self._buckets[clamped_index - MIN_RAW_INDEX] += 1

    def _raw_index(self, value: Decimal) -> int:
        """The unclamped log-spaced bucket index for a strictly positive `value`:
        `ceil(ln(value) / ln(gamma))`, the standard DDSketch index (Req 28.2)."""
        with localcontext() as ctx:
            ctx.prec = _DECIMAL_PRECISION
            ratio = value.ln() / self._log_gamma
            return int(ratio.to_integral_value(rounding=ROUND_CEILING))

    def _representative(self, raw_index: int) -> Decimal:
        """The representative value reported for bucket `raw_index`:
        `2 * gamma**raw_index / (gamma + 1)`, the standard DDSketch estimate that
        bounds relative error at `(gamma - 1) / (gamma + 1)` (Req 28.2)."""
        with localcontext() as ctx:
            ctx.prec = _DECIMAL_PRECISION
            return (2 * self._gamma**raw_index) / (self._gamma + _ONE)

    def quantile(self, q: Decimal | float | int) -> Decimal:
        """Estimate the value at quantile `q` (`0 <= q <= 1`).

        `q <= 0` returns the exact observed minimum and `q >= 1` the exact observed
        maximum (Property 3.5). Every other `q` scans the zero bucket first, then the
        log-spaced buckets in ascending raw-index order — ascending index is
        ascending value, by construction — and returns the representative value of
        the smallest-indexed bucket whose cumulative count is at least
        `q * sample_count`. If the cumulative mass never leaves the zero bucket, the
        estimate is exactly 0 (Req 28.11): a fully idle series has a defined,
        correct, zero quantile at every `q`.

        That representative-value estimate is then **clamped into
        `[minimum, maximum]`** before being returned, for the same reason
        `FixedHistogram.quantile` clamps its bin midpoint: the nearest-rank scan over
        ascending bucket index already makes the unclamped estimate monotone
        non-decreasing in `q`, and clamping a monotone non-decreasing function to a
        fixed range preserves that ordering. Without it, a bucket's log-spaced
        representative value can fall on the wrong side of the exact retained minimum
        or maximum near the `q = 0` / `q = 1` boundary — precisely the monotonicity
        violation Property 3.5 forbids — because a clamped fold (Req 28.10) or the
        bucket's own relative-error bound can place the representative value outside
        the exact observed range. The clamp only ever pulls an out-of-range estimate
        back toward the true quantile, so it tightens the existing 1% relative-error
        bound and never widens it. The zero-bucket early return below needs no
        clamp: `zero_count > 0` implies `minimum == 0`, so `_ZERO` is always inside
        `[minimum, maximum]` whenever it is reachable.

        Raises `ValueError` if nothing has been folded yet.
        """
        if self._count == 0:
            raise ValueError("quantile() called on a DDSketch with no folded values")

        q_decimal = _quantile_as_decimal(q)

        if q_decimal <= 0:
            assert self._minimum is not None
            return self._minimum
        if q_decimal >= 1:
            assert self._maximum is not None
            return self._maximum

        assert self._minimum is not None
        assert self._maximum is not None

        target = q_decimal * Decimal(self._count)
        cumulative = self._zero_count
        if Decimal(cumulative) >= target:
            return max(self._minimum, min(_ZERO, self._maximum))

        for array_index, bucket_count in enumerate(self._buckets):
            if bucket_count == 0:
                continue
            cumulative += bucket_count
            if Decimal(cumulative) >= target:
                return max(self._minimum, min(self._representative(array_index + MIN_RAW_INDEX), self._maximum))

        # Unreachable for the same reason as FixedHistogram.quantile's fallback.
        return self._maximum

    @property
    def buckets(self) -> tuple[int, ...]:
        """The `MAX_BUCKET_COUNT` log-spaced bucket counts, in ascending raw-index
        order. Always this length regardless of how many values have been folded."""
        return tuple(self._buckets)

    @property
    def zero_count(self) -> int:
        """The number of exact-zero values folded, tracked separately from the
        log-spaced buckets (Req 28.11)."""
        return self._zero_count

    @property
    def minimum(self) -> Decimal | None:
        """The exact observed minimum, or `None` if nothing has been folded."""
        return self._minimum

    @property
    def maximum(self) -> Decimal | None:
        """The exact observed maximum, or `None` if nothing has been folded."""
        return self._maximum

    @property
    def sample_count(self) -> int:
        """The number of values folded so far."""
        return self._count


type Sketch = FixedHistogram | DDSketch
"""Either sketch kind, for a caller (`collect/accumulate.py`'s `MetricAccumulator`)
that holds one without caring which kind it folds into once selected."""


def sketch_for_unit_family(unit_family: str) -> Sketch | None:
    """Select a fresh sketch for `unit_family`, or `None` if that family selects
    neither structure (Req 28.9, 28.13, 32.6).

    Dispatches on the exact declared string `unit_family` names — never on any
    metric's own name — so the mapping stays correct as the catalog grows metrics
    without this module changing. `None` is the caller's signal to emit no percentile
    for that metric and record a `PERCENTILE_UNSUPPORTED_UNIT_GAP_TYPE` gap while
    avg/min/max collection continues unaffected.
    """
    if unit_family == UNIT_FAMILY_PERCENTAGE:
        return FixedHistogram()
    if unit_family == UNIT_FAMILY_MAGNITUDE:
        return DDSketch()
    return None
