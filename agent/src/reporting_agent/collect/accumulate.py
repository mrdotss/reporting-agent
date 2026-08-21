"""The Accumulator: count-weighted averages, exact min/max, and derived statistics.

**The average is `sum(total) / sum(count)`, never a mean of per-interval averages**
(Req 27.1, 27.2). Buckets do not carry equal sample counts — a partial hour at a
window edge, or a VM created mid-window, has fewer samples than a full bucket — so
averaging averages weights a 3-sample interval the same as a 60-sample one. That is
wrong in exactly the cases nobody checks: month boundaries and recently-created VMs.
This module therefore accumulates `total` and `count` separately across every folded
interval and divides once, at the end, never before.

**`min`/`max` roll up exactly, at any grain** (Req 27.3, 27.4): the minimum of the
per-interval minima and the maximum of the per-interval maxima, with no caveat,
because `Minimum`/`Maximum` aggregations preserve the raw extremes regardless of how
coarse the interval is.

**Every value on this module's path is a `Decimal`; no `float` ever appears between a
folded response and a snapshot value** (Req 27.5, 27.6). Division runs at a working
precision of at least 28 significant digits and the result is quantized to exactly 6
decimal places, rounding half to even (Req 27.11) — pinned so two machines folding the
same intervals in different orders produce the identical digit string. `fold_interval`
mutates nothing and instead records an `interval_malformed` gap when an interval omits
`total` or `count`, carries a negative count, or carries a non-`Decimal` value in any
of `total`, `count`, `minimum` or `maximum` (Req 27.10) — the last three fields are a
deliberate broadening of the literal requirement text, which names only `total` and
`count`; see the module's task report for why. A **valid** interval whose `count` is
exactly zero is a different, unremarkable fact — a partial bucket that happened to
have no samples — and leaves the accumulator untouched with **no** gap recorded
(Req 27.7). **Fold order never affects the result** (Req 27.12): every update is a
commutative sum, an exact min or an exact max.

**"No result" is `None`, structurally, not a sentinel `Decimal`.** A `(resource,
metric)` pair whose summed count is zero after every fold emits no average, no
minimum and no maximum, and :meth:`MetricAccumulator.finalize` records a `no_samples`
gap rather than returning a zero-valued or `NaN`-valued result (Req 27.9) — an absent
measurement must never be representable as a number a snapshot consumer could
mistake for a real one.

**Exclusion is a property of the accumulator, not a filter its caller has to
remember.** Req 20.6 and Req 20.13 name "THE Accumulator" as the actor that excludes a
`deallocated` or `power_state_unknown` resource from every average, so
`MetricAccumulator.excluded` is a constructor-time flag: an excluded accumulator's
`fold_interval` is a no-op and its `finalize` returns `(None, None)` — no result and,
deliberately, **no** gap, because the reason nothing is here was already recorded as
that resource's `deallocated` or `power_state_unknown` gap elsewhere. Recording a
second, redundant `no_samples` gap on top of it would restate the same fact under the
wrong classification. Req 21.8's SKU-capacity exclusion needs no equivalent flag: a
missing SKU capability already reaches this module as `None` in
`derive_statistic`'s `sku_capability_values`, and the `sku_capability_missing` path
below already emits no derived value for it.

**Derived statistics evaluate the catalog's own formula, generically.** Req 30.1's
memory-utilization inversion — average utilization from the count-weighted average of
`Available Memory Bytes`, but *maximum* utilization from that metric's *minimum* and
*minimum* utilization from its *maximum*, because the expression is monotonically
decreasing in available memory — is read entirely from `DerivedEntry.sources`'
`for_statistic` bindings (`catalog/loader.py`). Nothing here hardcodes
`memory_used_pct`: :func:`derive_statistic` walks whichever `sources` a
`DerivedEntry` declares and evaluates whichever `formula` string it carries, so a
second derived statistic the catalog adds later needs no change to this function.
Evaluating that formula string safely — the string comes from a JSON file, not from a
user, but "no `eval`" is the discipline this codebase already holds everywhere else
(no ambient credential, no Unicode normalization on the snapshot path) — uses a
minimal `ast`-based evaluator (:func:`evaluate_formula`) restricted to the four
arithmetic operators, parentheses, numeric literals and the identifiers `sources`
binds. Missing or zero SKU capacity records `sku_capability_missing` and derives
nothing for the whole statistic (Req 30.7); a computed value outside 0-100 for a
`percent`-unit derived statistic records `metric_error` and derives nothing for that
one direction, rather than clamping (Req 30.8) — clamping would silently turn a
data-consistency failure into a plausible-looking number.
"""

from __future__ import annotations

import ast
import operator
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from typing import Final

from reporting_agent.catalog.loader import (
    AGGREGATION_COUNT,
    AGGREGATION_TOTAL,
    DECLARED_AGGREGATIONS,
    DerivedEntry,
)
from reporting_agent.collect.log import (
    GAP_TYPE_INTERVAL_MALFORMED,
    GAP_TYPE_METRIC_ERROR,
    GAP_TYPE_NO_SAMPLES,
    GAP_TYPE_PERCENTILE_UNSUPPORTED_UNIT,
    GAP_TYPE_SKU_CAPABILITY_MISSING,
    record_gap,
)
from reporting_agent.collect.sketch import Sketch, sketch_for_unit_family
from reporting_agent.providers.base import GapRecord, PlainData

__all__ = [
    "AVERAGE_QUANTIZE_SCALE",
    "STATISTIC_AVERAGE",
    "STATISTIC_MAXIMUM",
    "STATISTIC_MINIMUM",
    "STATISTIC_SUM",
    "WORKING_PRECISION",
    "AccumulatorResult",
    "DerivedSourceRef",
    "DerivedValue",
    "FormulaEvaluationError",
    "MetricAccumulator",
    "derive_statistic",
    "evaluate_formula",
    "new_accumulator",
]

# --- shared arithmetic constants (Req 27.11) ----------------------------------------

WORKING_PRECISION: Final[int] = 28
"""The minimum significant-digit precision Req 27.11 requires for the division that
produces an average, and reused for every other division and formula evaluation this
module performs, so no computation on this path runs at a *lower* precision than the
one requirement explicitly measures."""

AVERAGE_QUANTIZE_SCALE: Final[Decimal] = Decimal("0.000001")
"""Exactly 6 decimal places (Req 27.11). `Decimal.quantize` with this exponent and
`ROUND_HALF_EVEN` is what makes two machines, folding the same intervals in different
orders, produce the identical digit string."""

# --- the three statistic directions a derived entry's sources may bind to ----------
#
# These mirror the `statistic` / `for_statistic` string values the catalog schema
# declares (`catalog/loader.py`'s `SourceBinding`) by value, not by import, the same
# deliberate non-coupling `collect/sketch.py` draws against `catalog/loader.py`'s unit
# families: `collect/` sees the strings a validated `DerivedEntry` already carries,
# never the loader's own vocabulary constants (which do not exist — the loader treats
# `statistic` and `for_statistic` as opaque strings its schema does not enumerate).

STATISTIC_AVERAGE: Final[str] = "avg"
STATISTIC_MINIMUM: Final[str] = "min"
STATISTIC_MAXIMUM: Final[str] = "max"

STATISTIC_SUM: Final[str] = "sum"
"""The summed interval totals, for a metric Azure serves `Total` for and `Count` for not.

Deliberately **not** in :data:`_DIRECTION_ORDER`: that tuple is the set of directions a
*derived* statistic can produce, and no derivation in the catalog binds a sum. This is an
exact statistic of one metric, not an input to arithmetic.

It exists because the alternative was worse in both available spellings. `Microsoft.Web/
sites` serves `BytesReceived`, `BytesSent` and its two IO counters as `Total` only, so
without a sum that resource type declares no metric at all and the report covers App
Service by naming it and saying nothing. Reporting the same totals as a `min`/`max` of
per-interval totals would reuse `exact_interval_minimum`, whose documented meaning is the
minimum of the per-interval *minima* — a different quantity under an identical name, which
is the class of quiet mislabelling this product exists to eliminate."""

_DIRECTION_ORDER: Final[tuple[str, ...]] = (
    STATISTIC_AVERAGE,
    STATISTIC_MINIMUM,
    STATISTIC_MAXIMUM,
)
"""A fixed iteration order over the three possible output directions, so that two
calls over the same `DerivedEntry` visit — and therefore report gaps for — the
directions in the same order every time, matching the "produced, not inherited" array-
order discipline the snapshot path holds elsewhere (Req 34.8's principle, applied
here even though this module does not itself write the snapshot)."""


# --- the accumulator -----------------------------------------------------------------


@dataclass(slots=True)
class AccumulatorResult:
    """What :meth:`MetricAccumulator.finalize` returns when at least one sample was
    folded: the count-weighted average, the exact minimum and maximum, and the summed
    sample count every one of those three numbers was computed over.

    `minimum` and `maximum` are `Decimal | None` rather than always `Decimal`, and so is
    `average`. Not defensiveness — the catalog declares, per metric, which aggregations
    Azure serves for it, and the three fields are independently present or absent
    accordingly:

    * `Total` **and** `Count` requested (every `Microsoft.Compute/virtualMachines` metric,
      every `Microsoft.Compute/disks` metric): `average` is the count-weighted average.
    * Neither requested (`Microsoft.Sql/servers/databases`' `cpu_percent`, which Azure
      serves as `Average`, `Minimum` and `Maximum` only): `average` is `None`, and the
      exact minimum and maximum are the whole result. There is no fabricated average and
      no dropped metric.
    * `Total` requested without `Count` (`Microsoft.Web/sites`' `BytesReceived`):
      `total_sum` carries the summed interval totals and `average` is `None` — a sum over
      the window is what that counter means, and dividing it by an interval count Azure
      never sent would be arithmetic on a denominator nobody measured.

    `sample_count` is the summed per-interval sample count when `Count` was requested. When
    it was not, Azure sent no sample count at all, and this is the number of **intervals**
    rolled up — which is genuinely what the extremes were computed over, and is the same
    honesty `percentile_statistics` already applies to a sketch's fold count. `interval` on
    the emitted `StatisticEntry` is what says which unit that number is in.
    """

    average: Decimal | None
    minimum: Decimal | None
    maximum: Decimal | None
    sample_count: Decimal
    total_sum: Decimal | None = None


@dataclass(slots=True)
class MetricAccumulator:
    """Accumulates one `(resource, metric)` pair's intervals into `{total, count,
    minimum, maximum}` plus an optional percentile sketch (Req 27.1-27.12).

    `sketch` is `None` for a metric whose catalog-declared `unit_family` selects
    neither sketch kind (`collect/sketch.py`'s `sketch_for_unit_family` returning
    `None`) — `fold_interval` simply skips the percentile fold for it and avg/min/max
    accumulation continues unaffected, exactly as `sketch.py`'s own docstring
    describes. Use :func:`new_accumulator` to build one with the sketch already
    selected and the `percentile_unsupported_unit` gap already recorded when it
    applies.

    `excluded` is `True` for a resource already carrying a `deallocated` or
    `power_state_unknown` gap (Req 20.6, 20.13): every `fold_interval` call becomes a
    no-op and `finalize` returns `(None, None)` — no result, and deliberately no
    `no_samples` gap, because the reason this pair has nothing is already recorded
    under its own, more specific classification.

    `aggregations` is **the set this metric's request actually asked Azure for**, taken
    from the catalog entry, and it is what makes an absent `total` or `count` legible.
    Those two facts are indistinguishable in a response body and mean opposite things:

    * `Count` was requested and the interval omits it — a real omission, and the
      64-hour timestamp-only stretch `.kiro/steering/azure-integration.md` records is
      exactly this. It is a gap.
    * `Count` was never requested, because Azure does not serve it for this metric — the
      response is complete and correct. Treating it as a gap would produce one entry per
      interval, roughly 720 per pair per month, and then `no_samples` and no statistic at
      all, for a metric whose minimum and maximum arrived intact.

    Defaulting to :data:`~reporting_agent.catalog.loader.DECLARED_AGGREGATIONS` — all four
    — keeps every existing caller and every existing test unchanged: a pair built without
    an opinion behaves exactly as this class did before the field existed.

    `folded_intervals` counts the intervals that actually contributed, and it is the
    "did anything arrive" signal `finalize` reads. `count` cannot serve that purpose any
    more: a `Minimum`/`Maximum`-only metric folds real extremes and leaves `count` at
    zero, so keying "nothing arrived" on `count == 0` would report `no_samples` for a pair
    that collected fine.
    """

    sketch: Sketch | None = None
    excluded: bool = False
    aggregations: frozenset[str] = DECLARED_AGGREGATIONS
    total: Decimal = field(default_factory=lambda: Decimal(0))
    count: Decimal = field(default_factory=lambda: Decimal(0))
    minimum: Decimal | None = None
    maximum: Decimal | None = None
    folded_intervals: int = 0

    def fold_interval(
        self,
        *,
        total: PlainData,
        count: PlainData,
        minimum: PlainData | None,
        maximum: PlainData | None,
        resource_id: str,
        metric: str,
        interval_start: str | None = None,
    ) -> GapRecord | None:
        """Fold one interval's `{total, count, minimum, maximum}` into this pair's
        running state.

        `interval_start` is recorded on the `interval_malformed` gap and used for
        nothing else — it is not folded, not compared and not stored on the
        accumulator. It defaults to `None` so a caller with no timestamp in scope
        (`collect/dayfold.py`, which discards the returned gap anyway) is unchanged,
        and so this module keeps deciding nothing about how a timestamp is read.

        Returns a `GapRecord` naming `resource_id` and `metric` — never raises, never
        partially mutates — in three cases, and returns `None` (no gap) in every
        other case, including the ordinary zero-count interval:

        * This accumulator is `excluded` (Req 20.6, 20.13): the call is a pure no-op,
          returning `None`, before any validation runs — an excluded pair does not
          even get the chance to look malformed.
        * `total` or `count` is missing (`None`) or is present but not a `Decimal`,
          or `count` is negative: `interval_malformed` (Req 27.10), leaving `total`,
          `count`, `minimum` and `maximum` exactly as they were.
        * `minimum` or `maximum` is present (not `None`) but is not a `Decimal`: also
          `interval_malformed`. Req 27.10's literal text names only `total` and
          `count`; this module extends the same classification to a present-but-
          wrong-typed `minimum`/`maximum` rather than silently discarding it or
          letting a non-`Decimal` value corrupt an exact rollup, consistent with
          Req 27.5/27.6's absolute "no `float` on this path" rule. Flagged in this
          module's task report as a deliberate broadening for the orchestrator to
          confirm.

        A valid interval whose `count` is exactly zero updates nothing and returns
        `None` — no gap (Req 27.7): a partial bucket with no samples is not an error.

        A valid interval whose `count` is positive adds `total` and `count` into the
        running sums, updates `minimum`/`maximum` with `min`/`max` against whichever
        of them were present and typed correctly, and — when `sketch` is not `None`
        — folds `total / count` (this interval's own average, at
        :data:`WORKING_PRECISION`) into the sketch as one point, exactly as Req 28.12
        describes for an interval coarser than `PT1M`.
        """
        if self.excluded:
            return None

        reason = _malformed_reason(
            total=total,
            count=count,
            minimum=minimum,
            maximum=maximum,
            aggregations=self.aggregations,
        )
        if reason is not None:
            return record_gap(
                GAP_TYPE_INTERVAL_MALFORMED,
                resource_id,
                metric,
                f"interval for {metric!r} on resource {resource_id!r} is malformed: "
                f"{reason}",
                interval_start,
            )

        if AGGREGATION_COUNT in self.aggregations:
            assert isinstance(count, Decimal)  # narrowed by _malformed_reason
            if count == 0:
                return None
            assert isinstance(total, Decimal)
            self.total += total
            self.count += count
        elif AGGREGATION_TOTAL in self.aggregations:
            # A sum over the window, with no denominator to divide it by. See
            # `AccumulatorResult` on why that is the honest result rather than an average.
            assert isinstance(total, Decimal)
            self.total += total

        if isinstance(minimum, Decimal) and (self.minimum is None or minimum < self.minimum):
            self.minimum = minimum
        if isinstance(maximum, Decimal) and (self.maximum is None or maximum > self.maximum):
            self.maximum = maximum

        self.folded_intervals += 1

        # The sketch is fed this interval's own average, so it can only be fed when there
        # is a count to divide by. A metric Azure serves no `Count` for therefore folds
        # nothing here and yields no percentile — which is why the catalog declares no
        # `percentiles` for one, and why that is a fact about the metric rather than a
        # limitation of this module.
        if self.sketch is not None and AGGREGATION_COUNT in self.aggregations:
            assert isinstance(total, Decimal)
            assert isinstance(count, Decimal)
            with localcontext() as ctx:
                ctx.prec = WORKING_PRECISION
                interval_average = total / count
            self.sketch.fold(interval_average)

        return None

    def finalize(self, resource_id: str, metric: str) -> tuple[AccumulatorResult | None, GapRecord | None]:
        """The final `(result, gap)` for this pair — exactly one of the two is
        non-`None`, except for an excluded pair, which is `(None, None)`.

        * `excluded`: `(None, None)` — see the class docstring.
        * `self.folded_intervals == 0` (nothing was ever successfully folded, or every
          fold was zero-count): `(None, no_samples gap)` (Req 27.9) — no average, no
          minimum, no maximum, and an absent measurement is recorded rather than
          serialized as zero.
        * Otherwise: `(AccumulatorResult(...), None)`. `average` is divided at
          :data:`WORKING_PRECISION` and quantized to :data:`AVERAGE_QUANTIZE_SCALE`
          rounding half to even (Req 27.11) **when this metric requested both `Total` and
          `Count`**, and is `None` otherwise; `total_sum` is the summed totals for a
          metric that requested `Total` without `Count`.

        The emptiness test is `folded_intervals`, not `count`. For every metric that
        requests both `Total` and `Count` the two agree exactly — `count` only ever grows
        on an interval that also increments `folded_intervals` — so this changes nothing
        for them. For a `Minimum`/`Maximum`-only metric they disagree completely: `count`
        stays at zero while real extremes accumulate, and keying on it would throw away
        every statistic the metric actually produced and call it `no_samples`.
        """
        if self.excluded:
            return None, None

        if self.folded_intervals == 0:
            return None, record_gap(
                GAP_TYPE_NO_SAMPLES,
                resource_id,
                metric,
                f"no samples were folded for {metric!r} on resource {resource_id!r}",
            )

        average: Decimal | None = None
        if self.count > 0:
            with localcontext() as ctx:
                ctx.prec = WORKING_PRECISION
                average = (self.total / self.count).quantize(
                    AVERAGE_QUANTIZE_SCALE, rounding=ROUND_HALF_EVEN
                )

        summed = (
            self.total
            if AGGREGATION_TOTAL in self.aggregations
            and AGGREGATION_COUNT not in self.aggregations
            else None
        )

        return (
            AccumulatorResult(
                average=average,
                minimum=self.minimum,
                maximum=self.maximum,
                # The count Azure reported when it reported one, and the number of
                # intervals rolled up when it did not. See `AccumulatorResult`.
                sample_count=(
                    self.count if self.count > 0 else Decimal(self.folded_intervals)
                ),
                total_sum=summed,
            ),
            None,
        )


def _malformed_reason(
    *,
    total: PlainData,
    count: PlainData,
    minimum: PlainData | None,
    maximum: PlainData | None,
    aggregations: frozenset[str] = DECLARED_AGGREGATIONS,
) -> str | None:
    """The human-readable reason `fold_interval`'s arguments are malformed, or `None`
    if they are not. Kept as a free function, not a method, because it has no state
    to read — it is purely a classification over its own arguments (Req 27.10).

    **`aggregations` scopes what "malformed" means**, and that is the whole of this
    function's involvement in the per-metric aggregation change. A `total` of `None` is
    malformed for a metric that asked for one and complete for a metric that did not, so
    a check that did not know which was which would classify one of the two wrongly. It
    defaults to all four, so every existing caller is unaffected.

    `minimum` and `maximum` are checked only for *type*, never for presence, whether or
    not they were requested — unchanged from before. An interval legitimately carries no
    extreme, and a requested-but-absent extreme is already handled by the roll-up simply
    not moving.
    """
    if AGGREGATION_TOTAL in aggregations or AGGREGATION_COUNT in aggregations:
        if not isinstance(total, Decimal):
            return f"`total` must be a Decimal, got {total!r}"
    if AGGREGATION_COUNT in aggregations:
        if not isinstance(count, Decimal):
            return f"`count` must be a Decimal, got {count!r}"
        if count < 0:
            return f"`count` must not be negative, got {count!r}"
    if minimum is not None and not isinstance(minimum, Decimal):
        return f"`minimum` must be a Decimal or None, got {minimum!r}"
    if maximum is not None and not isinstance(maximum, Decimal):
        return f"`maximum` must be a Decimal or None, got {maximum!r}"
    return None


def new_accumulator(
    unit_family: str,
    *,
    resource_id: str,
    metric: str,
    excluded: bool = False,
    aggregations: Iterable[str] = DECLARED_AGGREGATIONS,
) -> tuple[MetricAccumulator, GapRecord | None]:
    """Build a fresh `MetricAccumulator` for one `(resource, metric)` pair, selecting
    its sketch from the catalog-declared `unit_family`.

    This is the "caller" `collect/sketch.py`'s own docstring names: when
    `sketch_for_unit_family(unit_family)` returns `None` because the family selects
    neither the fixed histogram nor the DDSketch, this function is where that fact
    becomes a recorded `percentile_unsupported_unit` gap (Req 28.13, 32.6) rather than
    a silently missing percentile — avg/min/max accumulation continues unaffected
    either way, since only the sketch is absent.

    `excluded=True` skips sketch selection entirely and returns an accumulator that
    folds nothing and finalizes to `(None, None)` (Req 20.6, 20.13); no gap is
    returned for this case either, for the reason `MetricAccumulator`'s own docstring
    gives — the caller already has a `deallocated` or `power_state_unknown` gap for
    this resource, and duplicating it here would restate one fact under two
    classifications.

    `aggregations` is the catalog entry's own `aggregations` tuple — the set the request
    for this metric will carry. Passing it here rather than at every `fold_interval` call
    is what lets `verify/replay.py` inherit it for free: replay rebuilds its accumulators
    through this same function from the same catalog entry, so the fold it re-runs
    classifies an absent `count` identically on both sides of the archive. A fold that
    read the aggregation set from anywhere else would be a second source of truth, and a
    replay mismatch would then mean "the two sides disagree about the request" rather than
    "the aggregation is not deterministic".
    """
    requested = frozenset(aggregations)
    if excluded:
        return MetricAccumulator(sketch=None, excluded=True, aggregations=requested), None

    sketch = sketch_for_unit_family(unit_family)
    if sketch is None:
        gap = record_gap(
            GAP_TYPE_PERCENTILE_UNSUPPORTED_UNIT,
            resource_id,
            metric,
            f"unit family {unit_family!r} selects neither the fixed histogram nor "
            f"the DDSketch; {metric!r} on resource {resource_id!r} collects avg, "
            f"min and max with no percentile",
        )
        return MetricAccumulator(sketch=None, aggregations=requested), gap

    return MetricAccumulator(sketch=sketch, aggregations=requested), None


# --- derived statistics: a generic, catalog-driven evaluator (Req 30.1, 30.7, 30.8) --


@dataclass(frozen=True, slots=True)
class DerivedSourceRef:
    """One entry of a derived value's `derived_from` list (Req 30.2).

    Two shapes, selected by `kind`, matching exactly what the catalog's own
    `SourceBinding.kind` distinguishes:

    * `kind == "metric"`: `name` is the source metric's catalog name and `statistic`
      is the statistic *read from that metric* for this entry — `"min"` when this ref
      belongs to the `max` direction of an inverted derived statistic, not `"max"`.
      `value` and `unit` are `None`.
    * `kind == "sku_capability"`: `name` is the SKU capability's catalog name,
      `value` is the resolved capacity as a decimal string, and `unit` is its unit.
      `statistic` is `None` — a SKU capability has no direction to invert.
    """

    kind: str
    name: str
    statistic: str | None = None
    value: str | None = None
    unit: str | None = None

    def to_plain_data(self) -> dict[str, PlainData]:
        """This ref as the plain-data dict shape `collect/snapshot.py` (task 9.9)
        writes into a derived value's `derived_from` array — only the fields that
        apply to this ref's `kind` are present, matching the two example shapes in
        the design document exactly (no `statistic: null` on a SKU-capability ref,
        no `value`/`unit: null` on a metric ref)."""
        data: dict[str, PlainData] = {"kind": self.kind, "name": self.name}
        if self.statistic is not None:
            data["statistic"] = self.statistic
        if self.value is not None:
            data["value"] = self.value
        if self.unit is not None:
            data["unit"] = self.unit
        return data


@dataclass(frozen=True, slots=True)
class DerivedValue:
    """One computed direction (`avg`/`min`/`max`) of one derived statistic for one
    resource (Req 30.1, 30.2, 30.3).

    `value` is already quantized to the catalog entry's declared `scale`. `formula`
    is the identical expression string the catalog declares for this statistic
    (Req 30.3) — never composed or reformatted here. `derived_from` is ordered
    identically for every direction of the same statistic (Req 30.2): every metric
    source this direction bound, in the catalog's own `sources` order, followed by
    every SKU-capability source, also in catalog order.
    """

    value: Decimal
    formula: str
    derived_from: tuple[DerivedSourceRef, ...]


class FormulaEvaluationError(ValueError):
    """A derived statistic's `formula` could not be evaluated against its bound
    sources.

    Raised only for a formula this module cannot parse or that names an operator or
    an identifier outside what :func:`evaluate_formula` permits. In ordinary
    operation this should never fire: `catalog/loader.py` already rejects, at load
    time, any formula naming an identifier absent from its own `sources` list, so a
    `DerivedEntry` reaching this module has already had every identifier checked
    against a `binds` value. This exception exists as the defensive floor under that
    guarantee, not as an expected code path.
    """


_ALLOWED_BINARY_OPERATORS: Final[dict[type[ast.operator], Callable[[Decimal, Decimal], Decimal]]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
}
"""Exactly the four arithmetic operators a catalog formula may use. Nothing else in
`ast`'s operator vocabulary — comparisons, boolean operators, bitwise operators,
attribute access, subscripting, calls — has any legitimate use in an arithmetic
expression over decimal figures, so none of them is in this table and
:func:`_evaluate_node` rejects every AST node type this table and the few other
explicitly-handled node types do not cover."""


def evaluate_formula(formula: str, bindings: Mapping[str, Decimal]) -> Decimal:
    """Evaluate `formula` — a catalog-declared arithmetic expression string, such as
    `"(sku_memory_bytes - available_memory_bytes) / sku_memory_bytes * 100"` — against
    `bindings`, a mapping from every identifier the formula may name to its bound
    `Decimal` value.

    Deliberately **not** `eval()` or `exec()`: `formula` originates from a JSON file
    shipped in the image rather than from a user, but this codebase holds a "no
    ambient trust shortcut" discipline everywhere else on the collection path — no
    `DefaultAzureCredential`, no Unicode normalization on the snapshot path — and a
    formula string is exactly the kind of embedded-language input that discipline is
    meant to cover. Parses `formula` with `ast.parse(formula, mode="eval")` and walks
    only a fixed, whitelisted set of node types: a top-level expression, a binary
    operation using one of the four operators in `_ALLOWED_BINARY_OPERATORS`, unary
    negation, a bound name, and a numeric literal. Every other node type — a call, an
    attribute access, a comparison, a string or collection literal, an import, a
    lambda, anything else the Python grammar admits — raises
    :class:`FormulaEvaluationError` rather than being silently ignored or partially
    evaluated.

    Runs entirely inside one `localcontext()` at :data:`WORKING_PRECISION`, so a
    formula chaining several operations — as `memory_used_pct`'s does — does not lose
    precision between one sub-expression and the next.

    Raises :class:`FormulaEvaluationError` if `formula` does not parse as an
    expression, names an operator outside the allowed four, or names an identifier
    absent from `bindings`.
    """
    try:
        tree = ast.parse(formula, mode="eval")
    except SyntaxError as exc:
        raise FormulaEvaluationError(
            f"formula {formula!r} is not a valid expression: {exc}"
        ) from exc

    with localcontext() as ctx:
        ctx.prec = WORKING_PRECISION
        return _evaluate_node(tree, bindings)


def _evaluate_node(node: ast.AST, bindings: Mapping[str, Decimal]) -> Decimal:
    if isinstance(node, ast.Expression):
        return _evaluate_node(node.body, bindings)

    if isinstance(node, ast.BinOp):
        apply = _ALLOWED_BINARY_OPERATORS.get(type(node.op))
        if apply is None:
            raise FormulaEvaluationError(
                f"operator {type(node.op).__name__} is not permitted; a formula may "
                f"use only +, -, * and /"
            )
        return apply(_evaluate_node(node.left, bindings), _evaluate_node(node.right, bindings))

    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -_evaluate_node(node.operand, bindings)

    if isinstance(node, ast.Name):
        if node.id not in bindings:
            raise FormulaEvaluationError(
                f"identifier {node.id!r} has no bound value; bound identifiers are "
                f"{sorted(bindings)}"
            )
        return bindings[node.id]

    if (
        isinstance(node, ast.Constant)
        and isinstance(node.value, int | float)
        and not isinstance(node.value, bool)
    ):
        return Decimal(str(node.value))

    raise FormulaEvaluationError(
        f"formula contains a disallowed expression: {ast.dump(node)}"
    )


def _select_statistic(result: AccumulatorResult, statistic: str) -> Decimal | None:
    """The value of `statistic` (`"avg"`/`"min"`/`"max"`) on `result`, or `None` for
    any other name — used to resolve a `SourceBinding.statistic`, which names the
    statistic *read from* the source metric, as distinct from the direction it feeds
    (`SourceBinding.for_statistic`)."""
    if statistic == STATISTIC_AVERAGE:
        return result.average
    if statistic == STATISTIC_MINIMUM:
        return result.minimum
    if statistic == STATISTIC_MAXIMUM:
        return result.maximum
    return None


def derive_statistic(
    entry: DerivedEntry,
    *,
    resource_id: str,
    metric_results: Mapping[str, AccumulatorResult | None],
    sku_capability_values: Mapping[str, Decimal | None],
) -> tuple[dict[str, DerivedValue], list[GapRecord]]:
    """Compute every direction (`avg`/`min`/`max`) of one derived statistic for one
    resource, from `entry`'s catalog-declared `sources` and `formula` (Req 30.1).

    Generic over `entry`: nothing here names `memory_used_pct` or `Available Memory
    Bytes`. For each direction a metric source declares via `for_statistic`, this
    function binds `sources[i].binds` to `metric_results[sources[i].name]`'s
    statistic named by `sources[i].statistic` — which is what makes the direction
    inversion (Req 30.1: minimum available memory feeds *maximum* utilization) purely
    a fact read from the catalog rather than a branch written for one statistic — and
    to every SKU-capability source's resolved value, then evaluates `entry.formula`
    (:func:`evaluate_formula`) and quantizes the result to `entry.scale` places,
    rounding half to even.

    `metric_results` and `sku_capability_values` are supplied by the caller (a later
    collection-pipeline task) from whatever it already accumulated or resolved for
    this resource: a metric name absent or mapped to `None` means that metric
    produced no result for this resource (already reflected in its own
    `MetricAccumulator.finalize` gap, so no gap is duplicated here), and a SKU
    capability name absent or mapped to `None` means the SKU capacity is unknown
    (`sku_unknown`) or that specific capability is missing (`sku_capability_missing`)
    — Req 21.8's "the Accumulator SHALL emit no derived value that depends on that
    resource's SKU capacity" is satisfied by this same `None` check, without a second,
    parallel exclusion mechanism.

    Returns `(values, gaps)`:

    * Every SKU-capability source with a missing or zero value stops the **whole**
      entry — no direction can be computed without it — and records one
      `sku_capability_missing` gap per such source, naming that capability
      (Req 30.7). `values` is then empty.
    * Otherwise, each direction is computed independently. A direction whose metric
      source has no result, or whose result lacks the specific statistic this
      direction needs, is skipped with **no** gap — the absence was already recorded
      against that metric. A direction that evaluates outside `[0, 100]` when
      `entry.unit == "percent"` records one `metric_error` gap naming the primary
      metric source and is **not** emitted — never clamped, never zero-filled
      (Req 30.8). Every other computed direction appears in `values`, keyed by
      direction (`"avg"`, `"min"`, `"max"`).
    """
    gaps: list[GapRecord] = []

    sku_sources = [source for source in entry.sources if source.kind == "sku_capability"]
    sku_bindings: dict[str, Decimal] = {}
    sku_refs: list[DerivedSourceRef] = []
    every_sku_resolved = True

    for source in sku_sources:
        value = sku_capability_values.get(source.name)
        if value is None or value == 0:
            gaps.append(
                record_gap(
                    GAP_TYPE_SKU_CAPABILITY_MISSING,
                    resource_id,
                    source.name,
                    f"SKU capability {source.name!r} is absent or zero for resource "
                    f"{resource_id!r}; no {entry.statistic_id} value can be derived",
                )
            )
            every_sku_resolved = False
            continue
        sku_bindings[source.binds] = value
        sku_refs.append(
            DerivedSourceRef(
                kind="sku_capability",
                name=source.name,
                value=str(value),
                unit=source.unit,
            )
        )

    if not every_sku_resolved:
        return {}, gaps

    values: dict[str, DerivedValue] = {}

    for direction in _DIRECTION_ORDER:
        metric_sources = [
            source
            for source in entry.sources
            if source.kind == "metric" and source.for_statistic == direction
        ]
        if not metric_sources:
            continue

        bindings: dict[str, Decimal] = dict(sku_bindings)
        metric_refs: list[DerivedSourceRef] = []
        every_metric_resolved = True

        for source in metric_sources:
            result = metric_results.get(source.name)
            if result is None:
                every_metric_resolved = False
                break

            assert source.statistic is not None  # guaranteed for kind == "metric"
            value = _select_statistic(result, source.statistic)
            if value is None:
                every_metric_resolved = False
                break

            bindings[source.binds] = value
            metric_refs.append(
                DerivedSourceRef(kind="metric", name=source.name, statistic=source.statistic)
            )

        if not every_metric_resolved:
            continue

        raw_value = evaluate_formula(entry.formula, bindings)

        with localcontext() as ctx:
            ctx.prec = WORKING_PRECISION
            quantized = raw_value.quantize(
                Decimal(1).scaleb(-entry.scale), rounding=ROUND_HALF_EVEN
            )

        if entry.unit == "percent" and not (Decimal(0) <= quantized <= Decimal(100)):
            primary_metric_name = metric_sources[0].name
            gaps.append(
                record_gap(
                    GAP_TYPE_METRIC_ERROR,
                    resource_id,
                    primary_metric_name,
                    f"{entry.statistic_id} ({direction}) evaluated to {quantized} for "
                    f"resource {resource_id!r}, outside the valid 0-100 percent "
                    f"range; not emitted",
                )
            )
            continue

        values[direction] = DerivedValue(
            value=quantized,
            formula=entry.formula,
            derived_from=tuple(metric_refs + sku_refs),
        )

    return values, gaps
