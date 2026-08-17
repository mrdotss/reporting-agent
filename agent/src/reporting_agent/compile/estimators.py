"""Estimator labels: how a figure says, in the document, how it was produced.

`compile/format.py` puts a figure's display string together; this module supplies the
one part of it that is a *claim about method* rather than about magnitude — the label a
`p95` carries so the document is structurally incapable of saying "p95 CPU"
unqualified (Req 18.10, 28.7).

## The label carries no numeral, and that is the whole point

`p95, est. from hourly averages`. No digits from the value, no unit, no separators —
because `format.py` is the only place a value becomes digits (Req 18.1), and a label
carrying its own numeral would put a second formatter's output inside the string the
verifier matches character for character.

**So this module deliberately does not consume the snapshot's own pre-formatted
`label`.** `collect/snapshot.py` writes one — `68.40% (p95, est. from hourly averages)`
— and it is useful to a reader of the snapshot, but it was rendered at the *collector's*
scale and separators. A template asking for three decimal places, or a comma decimal
separator, would then produce a document containing `68.400%` next to a parenthetical
that still said `68.40%`, and the verifier would be matching against whichever of the
two the renderer happened to use. `SnapshotValue.label` is retained for reference and
read by nothing on the render path.

## Unknown estimators fail the run

:func:`classify` raises for an estimator string it does not recognise, rather than
returning "probably exact". A new estimator in the collector then fails **the suite**
first — `tests/test_estimators.py` enumerates every estimator
`collect/snapshot.py` can emit and asserts each one classifies — and fails the *run*
if it somehow reaches production. The alternative, defaulting to "exact", would ship a
percentile with no estimate marking, which is exactly the figure a right-sizing
recommendation should not be built on: a percentile reconstructed from hourly averages
runs 20-40 points below the true p95 of the minute samples, so an unlabelled one makes
a saturating VM look comfortable.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Final

from reporting_agent.collect.snapshot import (
    ESTIMATOR_DERIVED_COUNT_WEIGHTED,
    ESTIMATOR_DERIVED_FROM_SOURCE_MAXIMUM,
    ESTIMATOR_DERIVED_FROM_SOURCE_MINIMUM,
    ESTIMATOR_EXACT_COUNT_WEIGHTED,
    ESTIMATOR_EXACT_GUEST_SAMPLE_AVERAGE,
    ESTIMATOR_EXACT_GUEST_SAMPLE_MAXIMUM,
    ESTIMATOR_EXACT_GUEST_SAMPLE_MINIMUM,
    ESTIMATOR_EXACT_INTERVAL_MAXIMUM,
    ESTIMATOR_EXACT_INTERVAL_MINIMUM,
)
from reporting_agent.compile.snapshot_view import (
    CARDINALITY_ESTIMATOR,
    SKU_CAPACITY_ESTIMATOR,
)
from reporting_agent.errors import CompileFailedError

__all__ = [
    "COMPARE_ESTIMATORS",
    "COMPARISON_DELTA_ESTIMATOR",
    "DECLARED_ESTIMATORS",
    "DECLARED_GRAIN_PHRASES",
    "DECLARED_METHOD_PHRASES",
    "DECLARED_SKETCH_KINDS",
    "EXACT_ESTIMATORS",
    "FOLDED_STATISTIC_PHRASES",
    "PERCENTILE_ESTIMATOR_PATTERN",
    "PERCENTILE_STATISTIC_PATTERN",
    "EstimatorKind",
    "classify",
    "estimator_label",
    "is_percentile_statistic",
]


class EstimatorKind(StrEnum):
    """What an estimator says about how a value was produced.

    Three kinds, because they get three different treatments in a document: an exact
    value needs no label, an estimated one must carry one, and a declared capacity is a
    published SKU fact rather than a measurement at all — it was not estimated and it
    was not observed, so calling it either would be wrong.
    """

    EXACT = "exact"
    ESTIMATED = "estimated"
    DECLARED = "declared"


# --- exact estimators (Req 27.1, 27.3, 27.4, 31.4) ----------------------------------
#
# Imported from `collect/snapshot.py` rather than re-spelled, so a rename there is an
# ImportError here rather than a silently unrecognised estimator. That is the whole
# reason these are module constants on the collector side.

EXACT_ESTIMATORS: Final[frozenset[str]] = frozenset(
    {
        ESTIMATOR_EXACT_COUNT_WEIGHTED,
        ESTIMATOR_EXACT_INTERVAL_MINIMUM,
        ESTIMATOR_EXACT_INTERVAL_MAXIMUM,
        ESTIMATOR_EXACT_GUEST_SAMPLE_AVERAGE,
        ESTIMATOR_EXACT_GUEST_SAMPLE_MINIMUM,
        ESTIMATOR_EXACT_GUEST_SAMPLE_MAXIMUM,
        ESTIMATOR_DERIVED_COUNT_WEIGHTED,
        ESTIMATOR_DERIVED_FROM_SOURCE_MINIMUM,
        ESTIMATOR_DERIVED_FROM_SOURCE_MAXIMUM,
    }
)
"""Nine estimators naming an exact computation.

A **derived** value is in here: `memory_used_pct` is exact arithmetic over exact
inputs. Its caveats — host-observed, typically 1-3% below what the guest reports — ride
on the value object as `observation` and `note` and are surfaced by
`appendix_methodology`, not folded into an estimator label. They are a statement about
*vantage point*, not about estimation, and merging the two would make "estimated" mean
two different things."""

COMPARISON_DELTA_ESTIMATOR: Final[str] = "derived_run_difference"
"""`later - earlier` across two pinned snapshots (Req 16.7).

Declared **here**, in the estimator vocabulary, and imported by `compare/delta.py` rather than
the other way round. Two reasons: this module is where an estimator name belongs, and the
dependency runs the way the layering does — `compare/` is a producer of values, and the
vocabulary that classifies them should not depend on its producers.

Classified **exact**: subtracting two exact decimals is exact arithmetic, and the caveat a
reader needs is not "this is an estimate" but *which two runs* it is a difference of — which the
figure carries in `derived_from`, both operands fully qualified as `<snapshot_id>#<pointer>`."""

COMPARE_ESTIMATORS: Final[frozenset[str]] = frozenset({COMPARISON_DELTA_ESTIMATOR})
"""Estimators the compare stage produces, kept apart from :data:`EXACT_ESTIMATORS`.

The separation is load-bearing for a test: `EXACT_ESTIMATORS` is asserted **equal** to the set
of estimator constants `collect/snapshot.py` declares, so a collector estimator that disappears
is caught. Folding a compile-stage estimator into that set would break the equality and cost
that check."""

DECLARED_METHOD_PHRASES: Final[dict[str, str]] = {
    SKU_CAPACITY_ESTIMATOR: "declared SKU capacity, as published by the platform",
    CARDINALITY_ESTIMATOR: (
        "a count of the snapshot's own records; exact by construction, and the collection "
        "counted is named on the figure"
    ),
}
"""Values that are neither measured nor estimated, each with its methodology phrase.

Two of them, and they are different kinds of fact: a SKU capacity is Azure's published
number, and a cardinality is a count of the snapshot's own records. Neither is an estimate,
so neither carries an estimator label — but the methodology appendix says which is which,
because a reader who cannot tell a published capacity from a counted one cannot judge
either."""

DECLARED_ESTIMATORS: Final[frozenset[str]] = frozenset(DECLARED_METHOD_PHRASES)

DECLARED_SKETCH_KINDS: Final[tuple[tuple[str, str], ...]] = (
    ("histogram_sketch", "a fixed 0-100 histogram"),
    ("ddsketch", "a log-spaced sketch"),
)
"""The two sketch kinds `collect/sketch.py` folds into, and prose for each.

The prose is not in the label — a label naming the sketch kind would be telling the
reader about our implementation rather than about their infrastructure. It is here so
`appendix_methodology` can explain the method once, in one place, from the same
declaration the label is derived from."""

DECLARED_GRAIN_PHRASES: Final[tuple[tuple[str, str], ...]] = (
    ("pt1m", "minute"),
    ("pt15m", "15-minute"),
    ("pt1h", "hourly"),
    ("p1d", "daily"),
)
"""Prose for the grain a percentile was estimated from, keyed by the case-folded grain
the estimator string carries. `PT1H` is the base grain; `PT15M` is what a non-whole-hour
timezone offset drops to. A `tuple` of pairs, scanned in a declared order, so nothing
here iterates a hash-ordered container."""

FOLDED_STATISTIC_PHRASES: Final[tuple[tuple[str, str], ...]] = (
    ("interval_average", "averages"),
)
"""Prose for *what* was folded into the sketch.

`interval_average` means each interval's own mean was folded — which is precisely why
the resulting percentile is an estimate and must say so: the spikes inside an hour are
already gone by the time the point reaches the sketch."""

PERCENTILE_ESTIMATOR_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\A(?P<sketch>[a-z_]+?)_(?P<grain>pt\d+[mh]|p\d+d)_(?P<folded>[a-z_]+)\Z"
)
"""The shape `collect/snapshot.py`'s `_percentile_estimator` composes:
`<sketch>_<grain>_<folded statistic>`, as in
`histogram_sketch_pt1h_interval_average`.

Parsed rather than enumerated, because the grain is a run-time parameter — pinning a
finite list of estimator strings here would mean a run at a new grain produced an
unrecognised estimator. The three *parts* are each checked against a declared set, so
the parsing is not a licence to accept anything."""

PERCENTILE_STATISTIC_PATTERN: Final[re.Pattern[str]] = re.compile(r"\Ap[0-9]+\Z")
"""`p` followed only by digits — the same pattern `collect/snapshot.py` forbids as a
bare object key and `compile/definition.py` uses to decide that a metric selection entry
needs an estimator label."""


def is_percentile_statistic(statistic: str) -> bool:
    """Whether `statistic` names a percentile.

    `compile/figures.py` uses this to refuse a percentile figure carrying no estimator
    label — the check that keeps a bare `p95` out of a document.
    """
    return bool(PERCENTILE_STATISTIC_PATTERN.match(statistic))


def _lookup(pairs: tuple[tuple[str, str], ...], key: str) -> str | None:
    for candidate, phrase in pairs:
        if candidate == key:
            return phrase
    return None


def classify(estimator: str, *, at: str = "") -> EstimatorKind:
    """What kind of value `estimator` describes.

    Raises `COMPILE_FAILED` naming `at` for an estimator this module does not recognise.
    Defaulting to :attr:`EstimatorKind.EXACT` would ship an unlabelled percentile, and
    defaulting to :attr:`EstimatorKind.ESTIMATED` would mark an exact minimum as an
    estimate — both are worse than stopping.
    """
    if estimator in EXACT_ESTIMATORS or estimator in COMPARE_ESTIMATORS:
        return EstimatorKind.EXACT
    if estimator in DECLARED_ESTIMATORS:
        return EstimatorKind.DECLARED

    match = PERCENTILE_ESTIMATOR_PATTERN.match(estimator)
    if match is not None:
        sketch = _lookup(DECLARED_SKETCH_KINDS, match.group("sketch"))
        grain = _lookup(DECLARED_GRAIN_PHRASES, match.group("grain"))
        folded = _lookup(FOLDED_STATISTIC_PHRASES, match.group("folded"))
        if sketch is not None and grain is not None and folded is not None:
            return EstimatorKind.ESTIMATED

    raise CompileFailedError(
        f"{at or 'a figure'} carries the estimator {estimator!r}, which this compiler "
        f"does not recognise. Every estimator the collector can emit must have an entry "
        f"here, because guessing would either ship an unlabelled percentile or mark an "
        f"exact minimum as an estimate."
    )


def estimator_label(estimator: str, statistic: str, *, at: str = "") -> str | None:
    """The document-visible label for an estimated value, or `None` for an exact or
    declared one.

    `p95, est. from hourly averages` — the statistic, then how it was arrived at, and
    **no numeral**: `compile/format.py` owns every digit that reaches a document, and a
    label carrying its own would put a second formatter's output inside the string the
    verifier matches.

    Returns `None` rather than an empty string for a value that needs no label, so a
    caller cannot accidentally render `12.5% ()`.
    """
    kind = classify(estimator, at=at)
    if kind is not EstimatorKind.EXACT and kind is not EstimatorKind.ESTIMATED:
        return None
    if kind is EstimatorKind.EXACT:
        return None

    match = PERCENTILE_ESTIMATOR_PATTERN.match(estimator)
    assert match is not None  # narrowed: classify() returned ESTIMATED
    grain = _lookup(DECLARED_GRAIN_PHRASES, match.group("grain"))
    folded = _lookup(FOLDED_STATISTIC_PHRASES, match.group("folded"))
    assert grain is not None and folded is not None  # narrowed by classify()

    if not statistic:
        raise CompileFailedError(
            f"{at or 'a figure'} carries an estimated estimator {estimator!r} but no "
            f"statistic to label; the label names the statistic first"
        )

    return f"{statistic}, est. from {grain} {folded}"


def method_phrase(estimator: str, *, at: str = "") -> str:
    """A one-line description of the method, for `appendix_methodology` (Req 16.6).

    Longer than the label and composed from the same declarations, so the appendix and
    the in-document label can never describe two different methods. The appendix reads
    each estimated statistic's **label from the ledger** and its method from here; it
    composes nothing of its own.
    """
    kind = classify(estimator, at=at)
    if kind is EstimatorKind.DECLARED:
        return DECLARED_METHOD_PHRASES[estimator]
    if kind is EstimatorKind.EXACT:
        return _EXACT_METHOD_PHRASES[estimator]  # noqa: RUF100

    match = PERCENTILE_ESTIMATOR_PATTERN.match(estimator)
    assert match is not None  # narrowed by classify()
    sketch = _lookup(DECLARED_SKETCH_KINDS, match.group("sketch"))
    grain = _lookup(DECLARED_GRAIN_PHRASES, match.group("grain"))
    folded = _lookup(FOLDED_STATISTIC_PHRASES, match.group("folded"))
    return (
        f"estimated from {sketch} folded during collection over {grain} interval "
        f"{folded}; the platform stores no percentile aggregation, so this is an "
        f"estimate rather than a measurement"
    )


_EXACT_METHOD_PHRASES: Final[dict[str, str]] = {
    ESTIMATOR_EXACT_COUNT_WEIGHTED: (
        "exact, count-weighted across intervals (the sum of interval totals divided by "
        "the sum of interval sample counts)"
    ),
    ESTIMATOR_EXACT_INTERVAL_MINIMUM: (
        "exact; the minimum of the per-interval minima is the true minimum at any grain"
    ),
    ESTIMATOR_EXACT_INTERVAL_MAXIMUM: (
        "exact; the maximum of the per-interval maxima is the true maximum at any grain"
    ),
    ESTIMATOR_EXACT_GUEST_SAMPLE_AVERAGE: (
        "exact, computed over the individual samples the in-guest agent shipped"
    ),
    ESTIMATOR_EXACT_GUEST_SAMPLE_MINIMUM: (
        "exact, the minimum of the individual samples the in-guest agent shipped"
    ),
    ESTIMATOR_EXACT_GUEST_SAMPLE_MAXIMUM: (
        "exact, the maximum of the individual samples the in-guest agent shipped"
    ),
    ESTIMATOR_DERIVED_COUNT_WEIGHTED: (
        "derived by formula from count-weighted source averages"
    ),
    ESTIMATOR_DERIVED_FROM_SOURCE_MINIMUM: (
        "derived by formula from the source metric's minimum, which the expression "
        "inverts"
    ),
    ESTIMATOR_DERIVED_FROM_SOURCE_MAXIMUM: (
        "derived by formula from the source metric's maximum, which the expression "
        "inverts"
    ),
    COMPARISON_DELTA_ESTIMATOR: (
        "the later run's value minus the earlier run's, over two pinned snapshots and with no "
        "re-collection; both operands are named on the figure"
    ),
}

assert set(_EXACT_METHOD_PHRASES) == EXACT_ESTIMATORS | COMPARE_ESTIMATORS, (
    "every exact estimator needs a method phrase for the methodology appendix"
)
