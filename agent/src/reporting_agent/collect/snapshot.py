"""The Snapshot_Builder: one immutable, content-addressed document per run.

Four functions decide whether the word "immutable" means anything an auditor could
check, and every one of them is small enough to read in a sitting:

    build_snapshot(...) -> dict          # every metric value already a decimal string
    assert_no_floats(doc, path="$")      # Req 34.10
    canonical_bytes(doc) -> bytes        # RFC 8785 of the body WITHOUT the two hash fields
    content_hash(doc) -> str             # sha256, 64 lowercase hex (Req 34.3)
    await write_once(store, doc, ...)    # PutObject If-None-Match: * (Req 34.9, 35.6)

**Every metric value is a decimal string, produced in exactly one place.**
:func:`decimal_string` quantizes to the number of fractional digits the Metric_Catalog
declares for that value, rounding half to even, and renders the result in **plain
notation with no exponent**, retaining trailing zeros to that scale, carrying at most
one leading minus (Req 34.1). `Decimal.__str__` is not usable for this: it emits
scientific notation for a value whose adjusted exponent is far from zero
(`str(Decimal("1E+3")) == "1E+3"`), and a snapshot carrying `1E+3` where another
machine wrote `1000` is not content-addressed in any useful sense. `format(value,
"f")` is the plain-notation formatter, and it is the only rendering path here.

**No metric value is ever a JSON number** (Req 34.2), and that is enforced by the
serializer rather than requested of the author: `rfc8785.dumps` **rejects `Decimal`
outright** with a `CanonicalizationError` — verified against rfc8785 0.1.4, the pinned
version — and it **accepts `float`**, rendering `1.5` as the number token `1.5`. Those
two facts point the same way. A `Decimal` that survives to canonicalization fails
loudly, and a `float` that survives would silently produce a `float.__repr__`-derived
token whose cross-platform equality is not a basis for an audit artifact. That is why
:func:`assert_no_floats` runs on the hash path (Req 34.10) rather than only at the
provider boundary, and why the value path here converts `Decimal` to `str` before the
document is ever assembled.

**Only the two top-level hash fields are excluded from the canonical input.**
:func:`canonical_bytes` builds a shallow copy without `content_hash` and `snapshot_id`
(Req 34.4) — at the **top level only**. A recursive strip of every field named
`content_hash` at every depth would be wrong: Property 2.8 requires two structures
differing only in a *nested* `content_hash` to hash **differently**, and a recursive
strip would make them hash alike. `snapshot_id` is then set equal to `content_hash`
character for character (Req 34.5); nothing else ever occupies that position.

**No Unicode normalization anywhere on this path.** Property 2.8 requires two key
spellings differing only by normalization form (NFC against NFD) to hash differently,
so `unicodedata.normalize` must not appear here — `rfc8785` does not normalize, and
neither may we. `tests/test_boundaries.py` asserts this over the whole snapshot path
with an AST scan, so it is a checked property rather than a promise.

**Array order is produced, never inherited** (Req 34.8). JCS orders object *keys* and
leaves arrays exactly as it finds them, so any array whose order depends on the order
Azure responses arrived in would change the digest. This module therefore sorts, at
build time: resources by resource id, each resource's statistics by metric name then
statistic name, `gaps` by `gap_type` then `resource_id` then `metric` (via
`collect/log.py`'s `gap_sort_key`, which already returns exactly that tuple), the
requested scope's resource types, resource groups and per-type metric names, and each
resource's day buckets by local day. Relatedly, **nothing here iterates a `set`**:
`PYTHONHASHSEED` differs between processes and Property 2.4 hashes the same structure
in two processes under different seeds. Every module constant that is iterated is a
`tuple`; the two that exist only for membership tests are read with `in` and never
walked.

**The scrub happens before the hash, not before the write.** Req 35.4 requires the
Redaction_Guard scrub over the whole snapshot before it is written, because an Azure
error message quoted into a `collection_log` entry can contain a credential. Scrubbing
*after* hashing would write bytes that differ from the bytes that were hashed, which
would break content addressing outright, so :func:`build_snapshot` scrubs first and
hashes the scrubbed body.

**The write is conditional and there is no second way to write.**
:func:`write_once` derives its own key — `<actor_id>/snapshots/<runId>/snapshot.json`
(Req 35.6) — rather than accepting one, tags the object with the owning actor id, and
goes through `ObjectStore.put_bytes_if_absent`, which is `PutObject` with
`IfNoneMatch: "*"`. A `412` (or the `409` a concurrent conditional write produces)
returns `False`, leaves the existing bytes untouched, writes no second object and logs
the attempt (Req 34.9). This module exposes **no** operation that modifies, partially
rewrites or deletes a snapshot (Req 34.6); re-running a collection builds a new
document with a new id and leaves every earlier object byte-identical at its own key
(Req 34.7). No Azure SDK is imported, and no boto3 call is made from here — the store
is injected, so the builder is exercised against an in-memory fake.

---

## Two deliberate deviations from design.md's snapshot example

**1. `statistics` is a flat, sorted JSON array — not a `metric -> statistic` map.**

design.md's "The snapshot document" example nests statistics twice, as
`statistics["Percentage CPU"]["p95"]`. That example **violates Req 28.4**, which
forbids "no object key named `p95`, no object key named `p99`, and no object key
consisting of the letter `p` followed only by digits, **at any level** of the
snapshot." Under that nesting the statistic name *is* an object key, so `p95` appears
as one.

Req 28.5 confirms which side is wrong: a percentile is "an object carrying `metric`,
`statistic`, `value`, `estimator`, `fidelity_tier` and `unit`." A `metric` field on
the value object is redundant under a `statistics[metric][statistic]` nesting — it can
only be there because the statistic objects live in a **flat collection** that does
not encode the metric name positionally. Req 34.8's "each resource's statistics by
metric name then statistic name" is then an **array sort key**, which is exactly what
the surrounding criterion is about (array order that must be produced rather than
inherited), not a nesting instruction.

So: `statistics` is a JSON array of statistic objects sorted by `(metric, statistic)`,
each carrying at least `metric`, `statistic`, `value`, `unit`, `estimator`,
`fidelity_tier` and `sample_count`. No statistic name is ever an object key anywhere,
which satisfies Req 28.4, Req 28.5 and Req 34.8 together instead of two out of three.
`day_buckets[].statistics` takes the same shape, and a derived statistic
(`memory_used_pct`) is an entry in the same array carrying its extra `formula`,
`derived_from`, `observation` and `note` fields (Req 30.2, 30.3, 30.4, 30.9).
Requirements are the authority here; the design example is a documentation bug.
:func:`assert_no_bare_percentile_keys` makes the rule checkable over a built document
rather than reviewable, so the map shape cannot come back by accident.

**2. Values carry the catalog-declared scale, not a uniform six decimal places.**

design.md's example renders `"12.480000"` and `"68.400000"` for `Percentage CPU`,
whose catalog entry declares `"scale": 2`. Req 34.1 requires "exactly the number of
fractional digits the Metric_Catalog declares for that value's unit", so the emitted
value is `"12.48"`. The six-place quantization in `collect/accumulate.py` is the
*working* scale Req 27.11 pins for the division that produces an average; the
catalog's `scale` is the *serialization* scale. They are different numbers with
different jobs, and this module is where the second one is applied.
"""

from __future__ import annotations

import hashlib
import logging
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from datetime import tzinfo as TzInfo
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from importlib.metadata import PackageNotFoundError, version
from typing import Final, cast

import rfc8785

from reporting_agent.catalog.loader import (
    MAX_SCALE,
    MIN_SCALE,
    DerivedEntry,
    EnhancedCounterEntry,
    MetricEntry,
)
from reporting_agent.collect.accumulate import (
    STATISTIC_AVERAGE,
    STATISTIC_MAXIMUM,
    STATISTIC_MINIMUM,
    STATISTIC_SUM,
    WORKING_PRECISION,
    AccumulatorResult,
    DerivedSourceRef,
    DerivedValue,
)
from reporting_agent.collect.buckets import Window
from reporting_agent.collect.log import gap_sort_key
from reporting_agent.collect.sketch import DDSketch, FixedHistogram, Sketch
from reporting_agent.providers.base import (
    FactRecord,
    GapRecord,
    PlainData,
    ResourceRecord,
    ScopeSpec,
)
from reporting_agent.providers.base import Window as WindowFields
from reporting_agent.redaction import scrub_deep
from reporting_agent.storage.base import JSON_CONTENT_TYPE, ObjectStore, owner_tags

__all__ = [
    "AGENT_VERSION",
    "DECLARED_FACT_SOURCES",
    "DECLARED_FACT_VALUE_KINDS",
    "ESTIMATOR_DERIVED_COUNT_WEIGHTED",
    "ESTIMATOR_DERIVED_FROM_SOURCE_MAXIMUM",
    "ESTIMATOR_DERIVED_FROM_SOURCE_MINIMUM",
    "ESTIMATOR_EXACT_COUNT_WEIGHTED",
    "ESTIMATOR_EXACT_GUEST_SAMPLE_AVERAGE",
    "ESTIMATOR_EXACT_GUEST_SAMPLE_MAXIMUM",
    "ESTIMATOR_EXACT_GUEST_SAMPLE_MINIMUM",
    "ESTIMATOR_EXACT_INTERVAL_MAXIMUM",
    "ESTIMATOR_EXACT_INTERVAL_MINIMUM",
    "ESTIMATOR_EXACT_INTERVAL_TOTAL_SUM",
    "FORBIDDEN_NETWORK_TERMS",
    "NIC_LEVEL_COUNTER_SCOPE",
    "NIC_LEVEL_METRIC_NAMES",
    "NUMERIC_FACT_GRAMMAR",
    "SNAPSHOT_SCHEMA_VERSION",
    "BillingTermError",
    "FactEntry",
    "FactEntryError",
    "FloatInSnapshotError",
    "PercentileKeyError",
    "ResourceDayBucket",
    "ResourceSnapshot",
    "SkuCapacity",
    "StatisticEntry",
    "assert_no_bare_percentile_keys",
    "assert_no_floats",
    "build_snapshot",
    "canonical_bytes",
    "content_hash",
    "decimal_string",
    "derived_statistics",
    "exact_statistics",
    "fact_from_plain",
    "find_float",
    "format_utc_offset",
    "guest_counter_statistics",
    "percentile_statistics",
    "rfc3339_utc",
    "snapshot_key",
    "verify_content_hash",
    "window_to_plain",
    "write_once",
]

logger = logging.getLogger(__name__)


# --- what a reader needs to identify the producer (Req 35.8) -------------------------

SNAPSHOT_SCHEMA_VERSION: Final[str] = "1.2.0"
"""The version of the snapshot *shape* — this module's output contract, distinct from
the agent's own version and from the catalog's. A later reader tells which producer
wrote a snapshot from `schema_version` plus `producer`, without consulting the run
(Req 35.8).

`1.1.0` adds `day_buckets[].statistics` (Req 35.11): the field was declared from the
start and always written empty, and `collect/dayfold.py` now fills it. A minor bump
rather than a major one because nothing was removed or re-typed — a `1.0.0` reader
meets an array where it expected an empty one, which is the case it already handled.

**A snapshot written at `1.0.0` does not replay to a `1.1.0` digest**, and cannot: the
recomputation now emits day statistics the stored document does not carry. That is
correct rather than unfortunate — a stored artifact and the code that would produce it
today genuinely disagree — but it means a re-verification of a pre-bump run reports
`replay_hash_mismatch`, which is what the version is for.

`1.2.0` adds `resources[].facts` (Req 4.6), on the same reasoning and with the same
consequence. The array is emitted **always, including empty**, so **every** digest changes
at this bump and not only the digests of runs that collected a fact — which is deliberate:
a key that appeared only when a source answered would make the document's shape depend on
whether the estate happened to have a backup configured, and two runs over one subscription
would then differ in shape rather than in content. A minor bump again because nothing was
removed or re-typed: a `1.1.0` reader meets an array where it expected no key, which is the
same case it already handles for `day_buckets[].statistics`."""


def _agent_version() -> str:
    """The installed distribution version, or a marked fallback.

    The container installs the package, so this resolves to `pyproject.toml`'s
    `version` there. The fallback only appears when the package is imported from a
    source tree with no distribution metadata at all; it is spelled distinctly so a
    snapshot produced that way is identifiable rather than silently indistinguishable
    from a released one.
    """
    try:
        return version("reporting-agent")
    except PackageNotFoundError:  # pragma: no cover - installed in every real env
        return "0.0.0+unknown"


AGENT_VERSION: Final[str] = _agent_version()


# --- the two hash fields, and only they, are excluded (Req 34.4) ---------------------
#
# A `tuple`, not a `frozenset`, and that is not decoration: nothing on the snapshot
# path may iterate a set, because `PYTHONHASHSEED` differs between processes and
# Property 2.4 hashes the same structure in two of them. Two elements read with `in`
# cost nothing, and the rule stays trivially true by inspection.

CONTENT_HASH_FIELD: Final[str] = "content_hash"
SNAPSHOT_ID_FIELD: Final[str] = "snapshot_id"
_EXCLUDED_FROM_CANONICAL: Final[tuple[str, ...]] = (CONTENT_HASH_FIELD, SNAPSHOT_ID_FIELD)


# --- estimator vocabulary ------------------------------------------------------------
#
# One constant per estimator string, so the verifier and the renderer downstream match
# a value the compiler produced rather than a spelling someone retyped. The exact and
# derived estimators name *how* the number was computed; the percentile estimators are
# composed (below) from the sketch kind and the source grain, never from a fidelity
# tier (Req 31.8).

ESTIMATOR_EXACT_COUNT_WEIGHTED: Final[str] = "exact_count_weighted"
ESTIMATOR_EXACT_INTERVAL_MINIMUM: Final[str] = "exact_interval_minimum"
ESTIMATOR_EXACT_INTERVAL_MAXIMUM: Final[str] = "exact_interval_maximum"
ESTIMATOR_EXACT_INTERVAL_TOTAL_SUM: Final[str] = "exact_interval_total_sum"
"""The estimator for :data:`~reporting_agent.collect.accumulate.STATISTIC_SUM`.

Names what was summed — the per-interval **totals** — because that is the one thing a
reader has to know to interpret the number. `exact` with no hedging: adding totals is
exact at any grain, the same way a minimum rolls up exactly, and there is nothing here
estimated from a coarser grain."""
ESTIMATOR_EXACT_GUEST_SAMPLE_AVERAGE: Final[str] = "exact_guest_sample_average"
ESTIMATOR_EXACT_GUEST_SAMPLE_MINIMUM: Final[str] = "exact_guest_sample_minimum"
ESTIMATOR_EXACT_GUEST_SAMPLE_MAXIMUM: Final[str] = "exact_guest_sample_maximum"
"""The three estimators for an **enhanced**-tier, guest-observed value (Req 31.4).

Spelled apart from the platform-metric estimators deliberately. A platform average is
count-weighted over intervals Azure pre-aggregated; a guest average is computed over the
individual samples the in-guest agent shipped to Log Analytics. Both are exact, and they
are exact over *different things* — a reader who cannot tell them apart cannot tell which
figures would disappear if the customer removed the agent."""
ESTIMATOR_DERIVED_COUNT_WEIGHTED: Final[str] = "derived_count_weighted"
ESTIMATOR_DERIVED_FROM_SOURCE_MINIMUM: Final[str] = "derived_from_source_minimum"
ESTIMATOR_DERIVED_FROM_SOURCE_MAXIMUM: Final[str] = "derived_from_source_maximum"

_HISTOGRAM_SKETCH_PREFIX: Final[str] = "histogram_sketch"
_DDSKETCH_PREFIX: Final[str] = "ddsketch"
_INTERVAL_STATISTIC_FOLDED: Final[str] = "interval_average"
"""What `MetricAccumulator.fold_interval` folds into a sketch: `total / count`, this
interval's own average (Req 28.12). The estimator names it, so a reader of the
snapshot can tell a percentile over minute samples from a percentile over the means
of hourly buckets — the distinction that decides whether a right-sizing
recommendation is honest."""

_DIRECTION_ORDER: Final[tuple[str, ...]] = (
    STATISTIC_AVERAGE,
    STATISTIC_MINIMUM,
    STATISTIC_MAXIMUM,
)
"""A fixed visit order over the three **derived** directions, so two builds over the same
inputs emit the same entries in the same order before sorting even runs. Mirrors
`collect/accumulate.py`'s constant of the same name for the same reason.

Read by `derived_statistics` alone. `exact_statistics` iterates its own four-entry tuple,
which additionally carries `sum`: a derivation can produce an average, a minimum or a
maximum, and no derivation in the catalog produces a sum."""

_PERCENTILE_KEY_PATTERN: Final[re.Pattern[str]] = re.compile(r"\Ap[0-9]+\Z")
"""`p` followed only by digits — the whole family Req 28.4 forbids as an object key,
which is `p95` and `p99` and every other spelling of the same mistake."""

_GRAIN_PHRASE: Final[tuple[tuple[str, str], ...]] = (
    ("PT1H", "hourly"),
    ("PT15M", "15-minute"),
)
"""Prose for a grain, for the pre-formatted percentile label. A `tuple` of pairs
rather than a mapping so the lookup is a scan over a declared order and nothing here
iterates a hash-ordered container."""


# --- NIC counters: labelled honestly, never as billing (Req 30.5, 30.6) -------------

NIC_LEVEL_COUNTER_SCOPE: Final[str] = "nic_level"

NIC_LEVEL_METRIC_NAMES: Final[tuple[str, ...]] = (
    "Network In Total",
    "Network Out Total",
)
"""The two metrics Req 30.5 and Req 30.6 name literally. Read with `in` and never
iterated. Declared here rather than inferred from the catalog's `interval_scoped`
flag, because `interval_scoped` means "a total over an interval" — a property a future
non-network counter could share — while `nic_level` is a claim about *what the counter
measures*, and asserting that about the wrong metric is the sort of plausible-looking
error this module exists to prevent."""

FORBIDDEN_NETWORK_TERMS: Final[tuple[str, ...]] = (
    "egress",
    "transfer cost",
    "bandwidth charge",
    "billable",
)
"""Req 30.6, compared case-insensitively across every string field of a NIC-level
value — its label, `unit`, `statistic`, `formula` and `derived_from` entries. The NIC
counters are not billable egress: billable egress differs by zone, peering,
intra-region exemption and free tier, so a document implying otherwise is wrong in a
way a client could act on. A `tuple`, so the check iterates a declared order."""


# --- errors --------------------------------------------------------------------------


class FloatInSnapshotError(TypeError):
    """A `float` was offered for serialization into a snapshot (Req 34.10).

    Carries the offending **field path** — `$.resources[3].statistics[0].value`, in the
    same `$.field[0].sub` convention `providers.base.find_non_plain` established — and
    deliberately **not** the offending value: an Azure error object quoted into a
    message can contain a credential, and a numeric value has no diagnostic use a path
    does not already give.

    A `TypeError` subclass because that is what `assert_plain_data` raises for the same
    class of violation at the provider boundary; one class of bug, one exception type,
    wherever on the path it is caught.
    """

    def __init__(self, path: str) -> None:
        super().__init__(
            f"{path} is a float. Every metric value is a fixed-precision decimal "
            f"string end to end (Req 34.1, 34.2): `json.dumps` renders a float "
            f"through `float.__repr__`, and cross-platform float equality is not a "
            f"basis for an audit artifact. No snapshot object is written (Req 34.10)."
        )
        self.path = path


class PercentileKeyError(ValueError):
    """An object key named `p` followed only by digits reached a snapshot (Req 28.4).

    Carries the path of the offending object and the key. This is the structural half
    of the percentile-honesty rule: a bare `p95` key asserts an unqualified percentile,
    and a percentile computed from hourly buckets runs 20-40 points below the true p95
    of the minute samples — precisely the error that makes an over-provisioned VM look
    right-sized. A percentile is therefore always an object carrying `estimator`,
    `estimated` and a pre-formatted `label` (Req 28.5), and never a key.
    """

    def __init__(self, path: str, key: str) -> None:
        super().__init__(
            f"{path} carries the object key {key!r}: no object key named `p` followed "
            f"only by digits may appear at any level of a snapshot (Req 28.4). A "
            f"percentile is an object carrying `metric`, `statistic`, `value`, "
            f"`estimator`, `fidelity_tier` and `unit` (Req 28.5)."
        )
        self.path = path
        self.key = key


class BillingTermError(ValueError):
    """A NIC-level value carried a billing term in one of its string fields (Req 30.6)."""

    def __init__(self, metric: str, statistic: str, term: str, where: str) -> None:
        super().__init__(
            f"the {statistic!r} value of {metric!r} carries the term {term!r} in its "
            f"{where}: `Network In Total` and `Network Out Total` are NIC-level byte "
            f"counters, not billable egress, and billable egress differs by zone, "
            f"peering, intra-region exemption and free tier (Req 30.5, 30.6)."
        )
        self.metric = metric
        self.statistic = statistic
        self.term = term
        self.where = where


# --- the one place a metric value becomes a string (Req 34.1) -----------------------

_QUANTIZE_GUARD_DIGITS: Final[int] = 2
"""Headroom over the digit count a quantization strictly needs, so `Decimal.quantize`
never raises `InvalidOperation` for a value whose integer part is wide (a byte count
near `10^15` at scale 0 needs 16 digits, comfortably inside the working precision;
this guard covers the values that are not)."""


def decimal_string(value: Decimal, scale: int) -> str:
    """`value` as a decimal string at exactly `scale` fractional digits (Req 34.1).

    Rounds half to even, renders in **plain notation carrying no exponent**, retains
    trailing zeros out to `scale`, and carries at most one leading minus sign.

    Three details are load-bearing:

    * **`format(value, "f")`, not `str(value)`.** `Decimal.__str__` emits scientific
      notation when the adjusted exponent is far from zero, so `str(Decimal("1E+3"))`
      is `"1E+3"`. Two machines writing `1E+3` and `1000` for the same quantity do not
      produce the same digest, and the requirement's "plain notation carrying no
      exponent" is exactly this.
    * **Negative zero is folded to zero.** A tiny negative quantity quantizes to
      `Decimal("-0.000000")`, which formats as `"-0.000000"` — a second spelling of
      zero, and therefore a second digest for one measurement. `abs` is applied when
      the quantized value compares equal to zero, which is also what "at most one
      leading minus sign" reads as once a signed zero is in scope.
    * **A `float` is refused, loudly, here** rather than silently converted. A
      `Decimal(float)` conversion would bake the binary approximation into the audit
      artifact, so the type check is a `TypeError` naming the requirement.

    Raises `TypeError` for a non-`Decimal` (a `bool` included — `isinstance(True, int)`
    is true and a boolean is not a measurement), and `ValueError` for a non-finite
    value or a `scale` outside the catalog's declared 0-to-9 range.
    """
    if isinstance(value, bool) or not isinstance(value, Decimal):
        raise TypeError(
            f"a metric value must be a Decimal, got {type(value).__name__}: every "
            f"value is a fixed-precision decimal string end to end (Req 34.1, 34.2)"
        )
    if not value.is_finite():
        raise ValueError(
            "a metric value must be finite: NaN and Infinity have no decimal string "
            "and no place in an audit artifact"
        )
    if not isinstance(scale, int) or isinstance(scale, bool):
        raise TypeError(f"scale must be an int, got {type(scale).__name__}")
    if scale < MIN_SCALE or scale > MAX_SCALE:
        raise ValueError(
            f"scale must be between {MIN_SCALE} and {MAX_SCALE} inclusive, as the "
            f"Metric_Catalog declares it, got {scale}"
        )

    integer_digits = max(value.adjusted() + 1, 1)
    with localcontext() as ctx:
        ctx.prec = max(WORKING_PRECISION, integer_digits + scale + _QUANTIZE_GUARD_DIGITS)
        quantized = value.quantize(Decimal(1).scaleb(-scale), rounding=ROUND_HALF_EVEN)

    if quantized == 0:
        quantized = abs(quantized)

    return f"{quantized:f}"


# --- the float guard (Req 34.10) -----------------------------------------------------


def find_float(value: object, path: str = "$") -> str | None:
    """The path of the first `float` inside `value`, or `None` if there is none.

    Traversal is deterministic and matches `providers.base.find_non_plain` exactly:
    an explicit stack, dictionary keys visited in sorted order (pushed in reverse so
    they *pop* in ascending order), list indices in ascending order. The path reported
    for a structure carrying two floats therefore does not depend on insertion order,
    which is what makes the error message reproducible across processes — the same
    property the digest itself needs.

    A non-`str` dictionary key is traversed under a synthetic `<int key>` segment
    rather than reported: it is a real problem, but it is not a `float`, and
    :class:`FloatInSnapshotError` naming it would be a lie about what went wrong.
    `rfc8785` refuses such a key on its own.
    """
    stack: list[tuple[str, object]] = [(path, value)]
    while stack:
        current_path, current = stack.pop()
        if isinstance(current, dict):
            for key in sorted(current, key=_key_sort_key, reverse=True):
                if isinstance(key, str):
                    stack.append((f"{current_path}.{key}", current[key]))
                else:
                    stack.append(
                        (f"{current_path}.<{type(key).__name__} key>", current[key])
                    )
            continue
        if isinstance(current, list):
            for index in range(len(current) - 1, -1, -1):
                stack.append((f"{current_path}[{index}]", current[index]))
            continue
        if isinstance(current, float):
            return current_path
    return None


def _key_sort_key(key: object) -> tuple[int, str]:
    """Order `str` keys among themselves and keep a non-`str` key comparable, so a
    dictionary carrying a mixture of key types still sorts without raising. Copied in
    spirit from `providers.base._key_sort_key`, for the same reason."""
    return (1, key) if isinstance(key, str) else (0, "")


def assert_no_floats(doc: object, path: str = "$") -> None:
    """Raise :class:`FloatInSnapshotError` naming the field path if `doc` contains a
    `float` at any depth (Req 34.10).

    Called on the hash path — :func:`canonical_bytes` runs it before handing anything
    to `rfc8785` — so a float cannot reach a digest, and :func:`build_snapshot` runs it
    before computing one, so a float raises before any object is written. Writing
    nothing on failure is not extra work here: nothing has been written by the time
    the document exists.
    """
    offender = find_float(doc, path)
    if offender is not None:
        raise FloatInSnapshotError(offender)


# --- the percentile-key guard (Req 28.4) ---------------------------------------------


def assert_no_bare_percentile_keys(doc: object, path: str = "$") -> None:
    """Raise :class:`PercentileKeyError` if any object key in `doc` is `p` followed
    only by digits, at any depth (Req 28.4).

    Makes the rule checkable over a built document rather than reviewable. It is the
    guard that keeps the `statistics` array from quietly reverting to a
    `metric -> statistic` map: a `statistics["Percentage CPU"]["p95"]` nesting fails
    here immediately, with the path of the offending object.

    Traversal order matches :func:`find_float`, so the offender reported for a document
    with two of them is the same offender in every process.
    """
    stack: list[tuple[str, object]] = [(path, doc)]
    while stack:
        current_path, current = stack.pop()
        if isinstance(current, dict):
            for key in sorted(current, key=_key_sort_key, reverse=True):
                if isinstance(key, str):
                    if _PERCENTILE_KEY_PATTERN.match(key):
                        raise PercentileKeyError(current_path, key)
                    stack.append((f"{current_path}.{key}", current[key]))
                else:
                    stack.append(
                        (f"{current_path}.<{type(key).__name__} key>", current[key])
                    )
            continue
        if isinstance(current, list):
            for index in range(len(current) - 1, -1, -1):
                stack.append((f"{current_path}[{index}]", current[index]))
    return None


# --- canonicalization and content addressing (Req 34.3, 34.4, 34.5) -----------------


def canonical_bytes(doc: Mapping[str, PlainData]) -> bytes:
    """The RFC 8785 (JCS) canonical form of `doc` **without** its two hash fields.

    `content_hash` and `snapshot_id` are excluded at the **top level only** (Req 34.4):
    `snapshot_id` equals the digest, so including either would make the computation
    circular. A *recursive* strip would be a different and wrong thing — Property 2.8
    requires two structures differing only in a **nested** `content_hash` to hash
    differently, and a recursive strip would make them hash alike. A shallow copy is
    built rather than popping from the caller's mapping, so this function mutates
    nothing.

    :func:`assert_no_floats` runs first, so a `float` produces a path-carrying
    :class:`FloatInSnapshotError` (Req 34.10) instead of the silent number token
    `rfc8785` would happily emit for it.
    """
    body = {key: value for key, value in doc.items() if key not in _EXCLUDED_FROM_CANONICAL}
    assert_no_floats(body)
    return rfc8785.dumps(body)


def content_hash(doc: Mapping[str, PlainData]) -> str:
    """The SHA-256 digest of :func:`canonical_bytes`, as 64 lowercase hexadecimal
    characters carrying no prefix (Req 34.3).

    `hexdigest()` is already lowercase and unprefixed, so there is nothing to
    normalize — and nothing here does, deliberately.
    """
    return hashlib.sha256(canonical_bytes(doc)).hexdigest()


def verify_content_hash(document: Mapping[str, PlainData]) -> None:
    """Raise `ValueError` unless `document` carries `content_hash` and `snapshot_id`
    equal to the digest of its own canonical form, character for character (Req 34.5).

    A cheap integrity check on the way to the store: it catches a document mutated
    after :func:`build_snapshot` returned, which is the one way the two fields and the
    bytes they address could disagree. :func:`write_once` runs it, so no object is ever
    written under an id it does not actually have.
    """
    expected = content_hash(document)
    actual_hash = document.get(CONTENT_HASH_FIELD)
    actual_id = document.get(SNAPSHOT_ID_FIELD)
    if actual_hash != expected:
        raise ValueError(
            f"{CONTENT_HASH_FIELD} is {actual_hash!r} but the document's canonical "
            f"form hashes to {expected!r}: the document was changed after it was built"
        )
    if actual_id != expected:
        raise ValueError(
            f"{SNAPSHOT_ID_FIELD} is {actual_id!r} but must equal {CONTENT_HASH_FIELD} "
            f"{expected!r} character for character (Req 34.5)"
        )


# --- window, offset and instant formatting (Req 35.1) -------------------------------


def rfc3339_utc(instant: datetime) -> str:
    """`instant` as a UTC RFC 3339 timestamp with a `Z` designator and whole-second
    precision (Req 35.1).

    A naive value is read as a UTC wall-clock reading rather than as the host process's
    local time — the same interpretation `collect/buckets.py`'s `local_day` applies, and
    for the same reason: nothing on this path may depend on the container's own zone
    setting. Sub-second precision is **truncated**, not rounded: rounding would let two
    timestamps 500 microseconds apart print the same second while two 1-microsecond
    apart print different ones, and truncation is what "whole-second precision" means
    without a second rule about ties.
    """
    aware = instant if instant.tzinfo is not None else instant.replace(tzinfo=UTC)
    utc = aware.astimezone(UTC).replace(microsecond=0)
    return (
        f"{utc.year:04d}-{utc.month:02d}-{utc.day:02d}"
        f"T{utc.hour:02d}:{utc.minute:02d}:{utc.second:02d}Z"
    )


def format_utc_offset(offset: timedelta) -> str:
    """`offset` as `+HH:MM` or `-HH:MM` (Req 35.1).

    Whole minutes; a zone whose historical offset carried seconds (local mean time,
    pre-1900) truncates to the minute, which is the granularity RFC 3339 itself
    admits. `+00:00` is rendered with a `+`, never as `Z`, because this field is the
    zone's resolved offset rather than a timestamp.
    """
    total_seconds = int(offset.total_seconds())
    sign = "-" if total_seconds < 0 else "+"
    magnitude = abs(total_seconds)
    hours, remainder = divmod(magnitude, 3600)
    minutes = remainder // 60
    return f"{sign}{hours:02d}:{minutes:02d}"


def window_to_plain(window: Window) -> WindowFields:
    """`collect/buckets.py`'s computable `Window` as the string-valued `Window`
    `providers/base.py` declares — local `YYYY-MM-DD` dates plus the UTC instants they
    resolved to, in RFC 3339 (Req 35.1).

    `buckets.py`'s own docstring says this serialization is the caller's job, and this
    is that caller. The window stays half-open on the UTC side (Req 25.7): `end_utc` is
    midnight of the local day *after* `end`, and is excluded.
    """
    return WindowFields(
        start=window.local_start.isoformat(),
        end=window.local_end.isoformat(),
        start_utc=rfc3339_utc(window.start_utc),
        end_utc=rfc3339_utc(window.end_utc),
    )


# --- the statistic object (Req 28.5, 35.5) ------------------------------------------


@dataclass(frozen=True, slots=True)
class StatisticEntry:
    """One statistic for one resource: the flat array element that replaces design.md's
    `metric -> statistic` nesting (see the module docstring's deviation 1).

    Carries `metric` explicitly — which is what Req 28.5 requires of a percentile and
    what makes a flat array possible at all — plus the `statistic` name, the value, its
    `unit`, its `estimator`, the `fidelity_tier` of the resource it came from
    (Req 31.2) and the number of samples it was computed over (Req 35.5).

    `value` is a `Decimal` here and a **string** in the emitted document: `scale` is
    the catalog-declared fractional-digit count :meth:`to_plain_data` renders it at, so
    the conversion happens in exactly one place (:func:`decimal_string`) and a caller
    cannot accidentally hand the builder a pre-formatted string at the wrong scale.

    The optional fields are each required by a specific criterion and each omitted
    rather than emitted as `null` when they do not apply, so a value's shape says what
    kind of value it is: `estimated` and `label` for a percentile (Req 28.7),
    `counter_scope` and `interval` for a NIC-level total (Req 30.5), `observation` and
    `note` for a host-observed derived value (Req 30.4), `formula` and `derived_from`
    for every derived value (Req 30.2, 30.3, 30.9), and `instance`, `counter` and
    `workspace_id` for an enhanced-tier, guest-observed value (Req 31.4).
    """

    metric: str
    statistic: str
    value: Decimal
    unit: str
    estimator: str
    fidelity_tier: str
    sample_count: int
    scale: int
    estimated: bool | None = None
    label: str | None = None
    counter_scope: str | None = None
    interval: str | None = None
    observation: str | None = None
    note: str | None = None
    formula: str | None = None
    derived_from: tuple[DerivedSourceRef, ...] = field(default_factory=tuple)
    instance: str | None = None
    """The volume a per-instance guest counter's value belongs to (Req 31.4) — `"C:"`,
    never `"_Total"`: a row that could not name its volume produces no value at all
    (Req 31.6). `None` for every platform metric, which has no instance dimension."""
    counter: str | None = None
    """The guest-observed counter this value came from (Req 31.4)."""
    workspace_id: str | None = None
    """The Log Analytics workspace this value was read from (Req 31.4)."""

    @property
    def sort_key(self) -> tuple[str, str, str]:
        """`(metric, statistic, instance)` — the array order Req 34.8 requires of a
        resource's statistics: by metric name, then statistic name. Produced here, never
        inherited from the order responses arrived in.

        `instance` is the tie-break, `""` for every platform metric, so it changes the
        relative order of nothing that existed before per-volume values did — and it is
        what keeps two volumes' values for one `(metric, statistic)` pair in a
        **defined** order rather than in whichever order the rows arrived in, which is
        precisely the inherited-array-order failure Req 34.8 is about."""
        return (self.metric, self.statistic, self.instance or "")

    def to_plain_data(self) -> dict[str, PlainData]:
        """This statistic as the plain-data object the snapshot carries.

        `value` becomes a decimal string at `scale` (Req 34.1, 34.2). Every optional
        field that is `None` is omitted entirely rather than emitted as `null`, and
        `derived_from` is omitted when empty, so the emitted object carries exactly the
        fields that apply to it.
        """
        data: dict[str, PlainData] = {
            "metric": self.metric,
            "statistic": self.statistic,
            "value": decimal_string(self.value, self.scale),
            "unit": self.unit,
            "estimator": self.estimator,
            "fidelity_tier": self.fidelity_tier,
            "sample_count": self.sample_count,
        }
        if self.estimated is not None:
            data["estimated"] = self.estimated
        if self.label is not None:
            data["label"] = self.label
        if self.counter_scope is not None:
            data["counter_scope"] = self.counter_scope
        if self.interval is not None:
            data["interval"] = self.interval
        if self.observation is not None:
            data["observation"] = self.observation
        if self.note is not None:
            data["note"] = self.note
        if self.formula is not None:
            data["formula"] = self.formula
        if self.derived_from:
            data["derived_from"] = [ref.to_plain_data() for ref in self.derived_from]
        if self.instance is not None:
            data["instance"] = self.instance
        if self.counter is not None:
            data["counter"] = self.counter
        if self.workspace_id is not None:
            data["workspace_id"] = self.workspace_id
        return data


NUMERIC_FACT_GRAMMAR: Final[re.Pattern[str]] = re.compile(
    r"\A-?[0-9]+(\.[0-9]+)?\Z"
)
"""The only shape a `numeric` fact's `value` may take (Req 4.11, 4.12).

An optional leading minus, digits, and at most one fractional part. No exponent, no
grouping separator, no leading plus, no surrounding whitespace — each excluded for the same
reason the metric values are stored as decimal strings: this string goes into the canonical
form the `content_hash` is computed over, and every alternative spelling of one quantity is
a second document with a different id.

**`\\A` and `\\Z`, not `^` and `$`.** The two differ on exactly one input and it is the one
that matters here: `$` also matches immediately before a trailing newline, so `"12\\n"` would
satisfy an `^…$` pattern and land in a snapshot carrying whitespace the requirement forbids.
`\\Z` matches only at the very end. `collect/snapshot.py`'s `_PERCENTILE_KEY_PATTERN` and
`compile/definition.py`'s patterns are anchored the same way, for the same reason."""

DECLARED_FACT_VALUE_KINDS: Final[frozenset[str]] = frozenset({"numeric", "text"})
DECLARED_FACT_SOURCES: Final[frozenset[str]] = frozenset(
    {"resource_graph", "arm", "recovery_services", "capacity", "advisor"}
)
"""Req 4.2 and 4.11's vocabularies, mirrored from `catalog/loader.py` **by value**.

The same non-coupling `collect/sketch.py` draws against the catalog's unit families and
`catalog/loader.py` draws against `collect/log.py`'s gap types: the snapshot is the document
whose shape this module owns, and it validates what it is handed rather than importing the
catalog to find out what is legal. `tests/test_snapshot.py` asserts the two agree, which is
a cheaper coupling than an import that would put a data-file read on the snapshot path."""


class FactEntryError(ValueError):
    """A fact the snapshot refuses to carry (Req 4.11, 4.12, 4.13).

    Carries `key` and, where the caller had one, `resource_id`, so a handler building an
    event does not have to re-parse the message. Raised **before** any digest exists, so
    **no snapshot object is written** — the same ordering `assert_no_floats` relies on.

    A `ValueError` rather than an `AgentError`: this module is pure and declares no error
    code, exactly as `PercentileKeyError` and `BillingTermError` above it do. The pipeline
    maps it to a terminal code at the boundary where run state lives.
    """

    def __init__(self, message: str, *, key: str, resource_id: str | None = None) -> None:
        super().__init__(message)
        self.key = key
        self.resource_id = resource_id


@dataclass(frozen=True, slots=True)
class FactEntry:
    """One collected fact about one resource, as the snapshot carries it (Req 4.1-4.6).

    The fact-side counterpart of :class:`StatisticEntry`, and deliberately a much smaller
    shape: a fact has no window, no estimator, no sample count and no aggregation, because it
    is an answer to *what is this resource* rather than *how much did it do*.

    `value` is a `str` here **and** a string in the emitted document — unlike
    `StatisticEntry.value`, which is a `Decimal` this module renders. There is no scale to
    render a fact at: a `text` fact is already its own display form, and a `numeric` fact
    arrives from `collect/factfold.py` as a fixed-precision decimal string that
    :data:`NUMERIC_FACT_GRAMMAR` checks rather than reformats. Reformatting it here would be a
    second place a fact's characters are decided.

    `value_kind` is read from the **declaration**, never inferred from the characters
    (Req 4.11). `2022` satisfies a decimal grammar and is an operating-system version, while
    `10.0.0.4` fails it and is an address — so a router reading the characters formats a
    Windows version with a grouping separator and refuses an address as malformed.

    `formatted` must equal `value` character for character. A fact carries no unit suffix and
    no grouping, so the two are the same string; the field exists so the verifier's token
    extraction has one thing to match against for every leaf in the document, fact or figure,
    without branching on which kind it is. Asserting the equality here is what stops that
    convenience from becoming a second display path.
    """

    key: str
    value: str
    value_kind: str
    source: str
    collected_at: str
    formatted: str
    unit: str | None = None

    def __post_init__(self) -> None:
        at = f"fact {self.key!r}"
        if not isinstance(self.key, str) or not self.key.strip():
            raise FactEntryError(
                f"a fact's key must be a non-empty string, got {self.key!r}",
                key=str(self.key),
            )
        if self.value_kind not in DECLARED_FACT_VALUE_KINDS:
            raise FactEntryError(
                f"{at}: value_kind {self.value_kind!r} is not one of "
                f"{sorted(DECLARED_FACT_VALUE_KINDS)}; the kind is read from the "
                f"declaration and never inferred from the value's characters (Req 4.11)",
                key=self.key,
            )
        if self.source not in DECLARED_FACT_SOURCES:
            raise FactEntryError(
                f"{at}: source {self.source!r} is not one of "
                f"{sorted(DECLARED_FACT_SOURCES)}. A fact that cannot name where it came "
                f"from is an assertion rather than an observation",
                key=self.key,
            )
        if not isinstance(self.collected_at, str) or not self.collected_at.strip():
            raise FactEntryError(
                f"{at}: collected_at is absent. A fact with no receipt instant cannot be "
                f"checked against the run's own lifetime (Req 4.13)",
                key=self.key,
            )
        if not isinstance(self.value, str) or not self.value:
            raise FactEntryError(
                f"{at}: value must be a non-empty string; an absent fact is recorded as a "
                f"gap and not as an empty value (Req 5.5)",
                key=self.key,
            )
        if self.formatted != self.value:
            raise FactEntryError(
                f"{at}: formatted {self.formatted!r} differs from value {self.value!r}. A "
                f"fact carries no unit suffix and no grouping, so the two are one string; a "
                f"second spelling here would be a second display path the verifier would "
                f"have to choose between",
                key=self.key,
            )
        if self.value_kind == "numeric" and not NUMERIC_FACT_GRAMMAR.match(self.value):
            raise FactEntryError(
                f"{at}: the declared numeric value {self.value!r} does not match "
                f"{NUMERIC_FACT_GRAMMAR.pattern} — no exponent, no grouping separator, no "
                f"leading plus and no surrounding whitespace, because this string goes into "
                f"the canonical form the content hash is taken over",
                key=self.key,
            )
        if self.value_kind == "text" and self.unit is not None:
            raise FactEntryError(
                f"{at}: a text fact declares no unit, got {self.unit!r}: there is no unit "
                f"for `Succeeded`",
                key=self.key,
            )

    @property
    def sort_key(self) -> str:
        """`key` — the array order Req 34.8 requires of a resource's facts.

        One field rather than a tuple because a resource carries at most one fact per key, and
        :func:`build_snapshot` refuses a pair that shares one. A tie-break would be a
        tie-break for a case that raises.
        """
        return self.key

    def to_plain_data(self) -> dict[str, PlainData]:
        """This fact as the plain-data object the snapshot carries (Req 4.2, 4.6).

        `unit` is omitted rather than emitted as `null` when it does not apply, the same rule
        every optional field on :class:`StatisticEntry` follows: the emitted object carries
        exactly the fields that apply to it, so a value's shape says what kind of value it is.
        """
        data: dict[str, PlainData] = {
            "key": self.key,
            "value": self.value,
            "value_kind": self.value_kind,
            "source": self.source,
            "collected_at": self.collected_at,
            "formatted": self.formatted,
        }
        if self.unit is not None:
            data["unit"] = self.unit
        return data


def _assert_no_billing_terms(entry: StatisticEntry) -> None:
    """Req 30.6 over one NIC-level value: no string field of it may contain `egress`,
    `transfer cost`, `bandwidth charge` or `billable`, compared case-insensitively.

    Checks the label, `unit`, `statistic`, `estimator`, `counter_scope`, `formula` and
    every `derived_from` entry's own strings — the fields the criterion enumerates plus
    the two this module adds. Enforced rather than promised: the catalog supplies the
    label, and a well-meaning catalog edit to `"NIC-level bytes (billable egress)"`
    would otherwise ship a document that is wrong in a way a client could act on.
    """
    candidates: list[tuple[str, str]] = [
        ("statistic", entry.statistic),
        ("unit", entry.unit),
        ("estimator", entry.estimator),
    ]
    if entry.label is not None:
        candidates.append(("label", entry.label))
    if entry.counter_scope is not None:
        candidates.append(("counter_scope", entry.counter_scope))
    if entry.formula is not None:
        candidates.append(("formula", entry.formula))
    if entry.note is not None:
        candidates.append(("note", entry.note))
    for index, ref in enumerate(entry.derived_from):
        candidates.append((f"derived_from[{index}].name", ref.name))
        if ref.unit is not None:
            candidates.append((f"derived_from[{index}].unit", ref.unit))

    for where, text in candidates:
        lowered = text.casefold()
        for term in FORBIDDEN_NETWORK_TERMS:
            if term in lowered:
                raise BillingTermError(entry.metric, entry.statistic, term, where)


def _nic_fields(metric: MetricEntry, grain: str) -> dict[str, str | None]:
    """The `counter_scope`, `interval` and `label` a metric's values carry.

    `interval` is set for an `interval_scoped` metric — Req 30.5's "record the length
    of the interval the total covers", because a total without its interval is not a
    rate. `counter_scope` is set only for the two metrics Req 30.5 names, for the
    reason :data:`NIC_LEVEL_METRIC_NAMES` gives.
    """
    return {
        "counter_scope": (
            NIC_LEVEL_COUNTER_SCOPE if metric.name in NIC_LEVEL_METRIC_NAMES else None
        ),
        "interval": grain if metric.interval_scoped else None,
        "label": metric.label,
    }


def exact_statistics(
    result: AccumulatorResult,
    *,
    metric: MetricEntry,
    fidelity_tier: str,
    grain: str,
) -> tuple[StatisticEntry, ...]:
    """The exact `avg`, `min` and `max` entries for one `(resource, metric)` pair.

    `avg` is the count-weighted average `MetricAccumulator` produced (Req 27.1), so its
    estimator is `exact_count_weighted`. `min` and `max` roll up exactly at any grain
    (Req 27.3, 27.4), so theirs say `exact_interval_minimum` and
    `exact_interval_maximum` — no hedging, because there is nothing to hedge about.
    None of the three is marked `estimated`; only a percentile is.

    A direction the accumulator has no value for is **omitted**, never emitted as zero:
    Req 35.10's "a statistic computed over zero samples emits no value" is structural
    here, since `StatisticEntry.value` is a required `Decimal` and there is no sentinel
    to put in it. The `no_samples` gap for that case is recorded by
    `MetricAccumulator.finalize`, which is the code that knows the count was zero;
    recording it a second time here would double the gap count Req 29.9 ties to the
    `snapshot_ready` event.

    A NIC-level total additionally carries `counter_scope`, its `interval` and the
    catalog's label, and every emitted entry is checked against Req 30.6's forbidden
    billing terms.

    **`avg` is one of the omittable directions, not a guaranteed one.** A metric whose
    catalog entry requests `Minimum` and `Maximum` and not `Total`/`Count` — because those
    are the aggregations Azure serves for it — yields `average is None` and emits `min` and
    `max` only. That needs no special case here: the loop already omits a direction with no
    value, and `avg` joins `min` and `max` in being an ordinary member of that set. `sum`
    is the fourth member, present only for a metric served `Total` without `Count`, and it
    is mutually exclusive with `avg` by construction in `MetricAccumulator.finalize` — a
    sum and a count-weighted average cannot both be derivable from one interval's leaves.
    """
    extra = _nic_fields(metric, grain)
    sample_count = int(result.sample_count)
    values: tuple[tuple[str, Decimal | None, str], ...] = (
        (STATISTIC_AVERAGE, result.average, ESTIMATOR_EXACT_COUNT_WEIGHTED),
        (STATISTIC_MINIMUM, result.minimum, ESTIMATOR_EXACT_INTERVAL_MINIMUM),
        (STATISTIC_MAXIMUM, result.maximum, ESTIMATOR_EXACT_INTERVAL_MAXIMUM),
        (STATISTIC_SUM, result.total_sum, ESTIMATOR_EXACT_INTERVAL_TOTAL_SUM),
    )

    entries: list[StatisticEntry] = []
    for statistic, value, estimator in values:
        if value is None:
            continue
        entry = StatisticEntry(
            metric=metric.name,
            statistic=statistic,
            value=value,
            unit=metric.unit,
            estimator=estimator,
            fidelity_tier=fidelity_tier,
            sample_count=sample_count,
            scale=metric.scale,
            label=extra["label"],
            counter_scope=extra["counter_scope"],
            interval=extra["interval"],
        )
        if entry.counter_scope == NIC_LEVEL_COUNTER_SCOPE:
            _assert_no_billing_terms(entry)
        entries.append(entry)

    return tuple(entries)


def _percentile_estimator(sketch: Sketch, grain: str) -> str:
    """The estimator string for a sketch-derived percentile: the sketch kind, the
    source grain, and the interval statistic folded (Req 28.6, 28.12).

    `histogram_sketch_pt1h_interval_average` reads as: a fixed 0-to-100 histogram, fed
    from `PT1H` intervals, each folded as that interval's own average. Every part of
    that is a fact about how the number was produced. **None of it comes from the
    resource's `fidelity_tier`** (Req 31.8), which is what keeps an `enhanced`
    resource's hourly-sourced percentile honestly marked as an estimate.
    """
    if isinstance(sketch, FixedHistogram):
        prefix = _HISTOGRAM_SKETCH_PREFIX
    elif isinstance(sketch, DDSketch):
        prefix = _DDSKETCH_PREFIX
    else:  # pragma: no cover - `Sketch` is a closed union of the two above
        raise TypeError(f"unknown sketch kind {type(sketch).__name__}")
    return f"{prefix}_{grain.casefold()}_{_INTERVAL_STATISTIC_FOLDED}"


def _grain_phrase(grain: str) -> str:
    """Prose for a grain, for the pre-formatted percentile label — `"hourly"` for
    `PT1H`. An unrecognised grain falls back to the grain string itself rather than
    inventing prose for it."""
    for candidate, phrase in _GRAIN_PHRASE:
        if candidate == grain:
            return phrase
    return grain


def _unit_suffix(unit: str) -> str:
    """How a unit reads immediately after a number in a label: `"12.48%"` for a
    percentage, `"48211993 bytes"` for everything else."""
    return "%" if unit == "percent" else f" {unit}"


def percentile_statistics(
    sketch: Sketch,
    *,
    metric: MetricEntry,
    fidelity_tier: str,
    grain: str,
) -> tuple[StatisticEntry, ...]:
    """Every percentile the catalog declares for `metric`, read from the sketch that
    was folded during collection (Req 28.8).

    **Every percentile comes from the sketch, never from data points read a second
    time** (Req 28.8) — the points were discarded as they were folded, so there is no
    second read to be tempted by. Each entry is marked `estimated` and carries a
    pre-formatted `label` naming the source grain, because both `PT1H` and `PT15M` are
    coarser than `PT1M` and a percentile is not reconstructible from the
    `{min, max, sum, count}` moments Azure Monitor stores per interval. That covers
    Req 28.7's "a `baseline` resource's percentiles are estimates" without consulting
    the tier at all, which is what Req 31.8 requires.

    `sample_count` is the sketch's own fold count — the number of **intervals** folded,
    which is a smaller and different number from the underlying sample count an exact
    average was computed over. Reporting the average's count here would overstate how
    much information the estimate rests on.

    A sketch with nothing folded yields no entries (Req 35.10). A declared percentile
    name that is not `p` followed by digits raises `ValueError`: the catalog is code
    shipped in the image, so a malformed percentile name there is a bug to surface, not
    a value to guess at.
    """
    if sketch.sample_count == 0:
        return ()

    estimator = _percentile_estimator(sketch, grain)
    phrase = _grain_phrase(grain)
    suffix = _unit_suffix(metric.unit)

    entries: list[StatisticEntry] = []
    for name in metric.percentiles:
        if not _PERCENTILE_KEY_PATTERN.match(name):
            raise ValueError(
                f"the Metric_Catalog declares the percentile {name!r} for "
                f"{metric.name!r}, which is not `p` followed by digits; a percentile "
                f"name is what its quantile is read from"
            )
        quantile = Decimal(f"0.{name[1:]}")
        value = sketch.quantile(quantile)
        formatted = decimal_string(value, metric.scale)
        entries.append(
            StatisticEntry(
                metric=metric.name,
                statistic=name,
                value=value,
                unit=metric.unit,
                estimator=estimator,
                fidelity_tier=fidelity_tier,
                sample_count=sketch.sample_count,
                scale=metric.scale,
                estimated=True,
                label=f"{formatted}{suffix} ({name}, est. from {phrase} averages)",
            )
        )

    return tuple(entries)


def guest_counter_statistics(
    result: AccumulatorResult,
    *,
    entry: EnhancedCounterEntry,
    fidelity_tier: str,
    counter: str,
    workspace_id: str,
    instance: str | None = None,
) -> tuple[StatisticEntry, ...]:
    """The exact `avg`, `min` and `max` for one enhanced-tier guest counter (Req 31.4).

    `result` is the accumulator over the **individual samples** the in-guest agent
    shipped, so all three directions are exact and none is marked `estimated` — there is
    no interval pre-aggregation between the sample and the figure to hedge about.

    Every emitted value carries the `counter` name and the `workspace_id` it came from,
    which is Req 31.4's requirement stated as a constructor argument rather than as a
    convention: there is no path through this function that produces a guest value
    without both. `instance` names the volume for a per-instance counter and is
    `None` for a resource-level one — Req 31.6's `_Total` / absent / empty case never
    reaches here at all, because a row that cannot name its volume produces no value to
    build (the caller records `instance_name_collapsed` instead).

    `fidelity_tier` is the tier resolved for this resource, which for a value built here
    is `enhanced` by construction — a `baseline` resource issues no guest query at all
    (Req 31.3) and emits no per-volume free-space value (Req 31.9). Passed rather than
    hardcoded so the one rule Req 31.2 states — a value's tier equals its resource's
    tier — has exactly one enforcement point, in the caller that resolved it.
    """
    if not isinstance(workspace_id, str) or not workspace_id.strip():
        raise ValueError(
            f"a guest-observed value for {entry.statistic_id!r} must record the "
            f"workspace identifier it came from (Req 31.4), got {workspace_id!r}"
        )
    if not isinstance(counter, str) or not counter.strip():
        raise ValueError(
            f"a guest-observed value for {entry.statistic_id!r} must record the counter "
            f"name it came from (Req 31.4), got {counter!r}"
        )

    directions: tuple[tuple[str, Decimal | None, str], ...] = (
        (STATISTIC_AVERAGE, result.average, ESTIMATOR_EXACT_GUEST_SAMPLE_AVERAGE),
        (STATISTIC_MINIMUM, result.minimum, ESTIMATOR_EXACT_GUEST_SAMPLE_MINIMUM),
        (STATISTIC_MAXIMUM, result.maximum, ESTIMATOR_EXACT_GUEST_SAMPLE_MAXIMUM),
    )
    return tuple(
        StatisticEntry(
            metric=entry.statistic_id,
            statistic=statistic,
            value=value,
            unit=entry.unit,
            estimator=estimator,
            fidelity_tier=fidelity_tier,
            sample_count=int(result.sample_count),
            scale=entry.scale,
            instance=instance,
            counter=counter,
            workspace_id=workspace_id,
        )
        for statistic, value, estimator in directions
        if value is not None
    )


_DERIVED_ESTIMATOR_BY_SOURCE_STATISTIC: Final[tuple[tuple[str, str], ...]] = (
    (STATISTIC_AVERAGE, ESTIMATOR_DERIVED_COUNT_WEIGHTED),
    (STATISTIC_MINIMUM, ESTIMATOR_DERIVED_FROM_SOURCE_MINIMUM),
    (STATISTIC_MAXIMUM, ESTIMATOR_DERIVED_FROM_SOURCE_MAXIMUM),
)
"""The estimator a derived direction takes, keyed by the statistic it read **from its
source metric** rather than by the direction it produced. That distinction is the whole
point: `memory_used_pct`'s `max` is derived from the *minimum* of
`Available Memory Bytes`, because the expression is monotonically decreasing in
available memory (Req 30.1), so its estimator reads `derived_from_source_minimum`. A
tuple of pairs, scanned in order, so nothing iterates a hash-ordered container."""


def derived_statistics(
    values: Mapping[str, DerivedValue],
    *,
    entry: DerivedEntry,
    fidelity_tier: str,
    sample_count: int,
) -> tuple[StatisticEntry, ...]:
    """The derived entries for one resource and one catalog-declared derived statistic.

    `values` is what `collect/accumulate.py`'s `derive_statistic` returned, keyed by
    direction (`avg`/`min`/`max`); a direction it could not compute is simply absent
    and emits nothing.

    Every emitted value carries **both** `formula` and `derived_from`, and this
    function raises `ValueError` if either is empty (Req 30.9): a derived number
    without its derivation is an assertion rather than a measurement, so there is no
    code path that emits one. `observation` and `note` come from the catalog entry and
    ride on the **value object**, not the snapshot's top level (Req 30.4), so every
    consumer of a host-observed memory percentage receives the caveat with the number
    rather than having to find it elsewhere.

    The estimator names which source statistic fed each direction, so the Req 30.1
    inversion is visible in the document itself rather than only in the code that
    performed it.
    """
    entries: list[StatisticEntry] = []
    for direction in _DIRECTION_ORDER:
        value = values.get(direction)
        if value is None:
            continue
        if not value.formula or not value.derived_from:
            raise ValueError(
                f"the {direction!r} value of {entry.statistic_id!r} carries "
                f"formula={value.formula!r} and "
                f"{len(value.derived_from)} derived_from entries: a derived value "
                f"emits both, always (Req 30.9)"
            )
        derived = StatisticEntry(
            metric=entry.statistic_id,
            statistic=direction,
            value=value.value,
            unit=entry.unit,
            estimator=_derived_estimator(value.derived_from),
            fidelity_tier=fidelity_tier,
            sample_count=sample_count,
            scale=entry.scale,
            observation=entry.observation,
            note=entry.note,
            formula=value.formula,
            derived_from=value.derived_from,
        )
        if _derives_from_nic_counter(value.derived_from):
            _assert_no_billing_terms(derived)
        entries.append(derived)

    return tuple(entries)


def _derived_estimator(refs: Sequence[DerivedSourceRef]) -> str:
    """The estimator for a derived direction, read from the statistic its first metric
    source contributed. Falls back to `derived_count_weighted` for a derivation with no
    metric source at all — a SKU-only derived statistic, which the catalog does not
    declare today but which would still be count-weighted in the only sense that
    applies to it."""
    for ref in refs:
        if ref.kind != "metric" or ref.statistic is None:
            continue
        for statistic, estimator in _DERIVED_ESTIMATOR_BY_SOURCE_STATISTIC:
            if ref.statistic == statistic:
                return estimator
    return ESTIMATOR_DERIVED_COUNT_WEIGHTED


def _derives_from_nic_counter(refs: Sequence[DerivedSourceRef]) -> bool:
    """Whether any source of a derived value is one of the two NIC counters, which is
    what brings Req 30.6's forbidden-term check to bear on a derived value."""
    return any(
        ref.kind == "metric" and ref.name in NIC_LEVEL_METRIC_NAMES for ref in refs
    )


# --- the per-resource shapes (Req 35.3) ---------------------------------------------


@dataclass(frozen=True, slots=True)
class SkuCapacity:
    """The SKU capacity used for one resource (Req 35.3).

    `vcpus_available` is `vCPUsAvailable`, **not** `vCPUs`: a constrained-core SKU
    reports its parent's core count, so `Standard_E32-8s_v5` advertises 32 and exposes
    8, and using the wrong one overstates capacity fourfold and makes every derived
    per-core figure wrong (Req 21.2, 21.3).

    Both counts are `None` when the SKU or that capability could not be resolved — the
    `sku_unknown` / `sku_capability_missing` gap for that is recorded upstream, and the
    emitted `sku` object simply omits the field rather than carrying a zero that would
    read as a measurement.
    """

    name: str
    vcpus_available: int | None = None
    memory_bytes: Decimal | None = None

    def to_plain_data(self) -> dict[str, PlainData]:
        """The `sku` object. Both capacities are **strings**, not JSON numbers: the
        memory capacity is a decimal string at scale 0 (Req 35.3), and the vCPU count
        follows the same convention so nothing in a `sku` object is a number token a
        float could ever have produced."""
        data: dict[str, PlainData] = {"name": self.name}
        if self.vcpus_available is not None:
            data["vcpus_available"] = str(int(self.vcpus_available))
        if self.memory_bytes is not None:
            data["memory_bytes"] = decimal_string(self.memory_bytes, 0)
        return data


@dataclass(frozen=True, slots=True)
class ResourceDayBucket:
    """One local-day bucket for one resource, and that day's statistics (Req 25.11).

    `local_day` and `slot_count` are `collect/buckets.py`'s `DayBucket` fields — a
    partial edge day keeps its real slot count and is never padded to 24 or 96, nor
    dropped for being partial. `statistics` is a flat array on the same terms as a
    resource's own, so a day's percentile is as structurally incapable of being a bare
    `p95` key as a window's is.
    """

    local_day: date
    slot_count: int
    statistics: tuple[StatisticEntry, ...] = field(default_factory=tuple)

    def to_plain_data(self) -> dict[str, PlainData]:
        return {
            "local_day": self.local_day.isoformat(),
            "slot_count": int(self.slot_count),
            "statistics": _statistics_to_plain_data(self.statistics),
        }


def fact_from_plain(record: FactRecord) -> FactEntry:
    """One `FactRecord` back as the `FactEntry` the snapshot carries (Req 4.1-4.6).

    The fact-side counterpart of :func:`statistic_from_plain`, and a much thinner one: there
    is nothing to override and nothing to re-render. A fact's `value` is already its own
    display form — a `text` fact is the string the API returned and a `numeric` fact arrives
    as the fixed-precision decimal string `collect/factfold.py` produced — so `formatted` is
    that same string, character for character, and `FactEntry.__post_init__` refuses any other
    relationship between the two.

    Nothing is defaulted. A record missing its `source`, its `value_kind` or its `collected_at`
    reaches `FactEntry`, which raises and writes no snapshot object (Req 4.4): a fact whose
    provenance is absent is an assertion rather than an observation, and substituting a
    plausible value here is precisely how one would become the other.

    ## Where Req 7.4's "recomputed through `compile/format.py`" landed, and why not here

    This function is the **one** builder of a snapshot `FactEntry`, and `verify/replay.py`
    calls this same function when it re-derives a fact from an archived response — so the
    characters a fact carries are decided in one place on both sides of the archive, which is
    the property Req 7.4 is protecting.

    It is not routed through `compile/format.py::format_text_fact`, and that is a deliberate
    departure. Two reasons, in order of weight:

    * **`collect/` does not import `compile/`, anywhere.** The compiler consumes the snapshot;
      inverting that direction for a function that is the identity would establish a dependency
      the layering has so far kept out, in exchange for nothing observable.
    * **They are two fields on two objects.** `FactEntry.formatted` is the snapshot's canonical
      form of a collected value; `TextFact.formatted` is the string the renderer emits into the
      document, and *that* one does go through `format_text_fact` (`compile/figures.py`, rule 7c
      in `tests/test_boundaries.py`). Both equal the value character for character, each
      asserted by its own `__post_init__`, so there is no drift for a single formatter to
      prevent — only two places that would then both depend on it.
    """
    return FactEntry(
        key=record["key"],
        value=record["value"],
        value_kind=record["value_kind"],
        source=record["source"],
        collected_at=record["collected_at"],
        formatted=record["value"],
        unit=record.get("unit"),
    )


@dataclass(frozen=True, slots=True)
class ResourceSnapshot:
    """One resource's contribution to a snapshot: its inventory record, the SKU
    capacity resolved for it, its window statistics and its day buckets.

    `record` is `providers.base.ResourceRecord` unchanged — the same shape the provider
    boundary already produces, carrying `power_state_raw` (the `powerState.code` the
    inventory query projected) alongside the normalized `power_state` and the
    `fidelity_tier` (Req 35.3). A resource carrying a `deallocated`,
    `power_state_unknown` or `permission_denied` gap is **present here with no
    statistics** rather than absent (Req 20.10, 29.8): an unreadable resource must be
    visible, because "absent" and "measured at zero" are the two readings this whole
    module exists to keep apart.
    """

    record: ResourceRecord
    sku: SkuCapacity
    statistics: tuple[StatisticEntry, ...] = field(default_factory=tuple)
    day_buckets: tuple[ResourceDayBucket, ...] = field(default_factory=tuple)
    facts: tuple[FactEntry, ...] = field(default_factory=tuple)
    """This resource's collected facts (Req 4.1).

    **Independent of `statistics`.** A resource carrying a `deallocated` or
    `permission_denied` gap has no statistics and still has facts: a stopped machine's size,
    OS and backup status are all readable while it is switched off, and they are exactly what
    a right-sizing reader wants about a machine nobody is using. Emitting facts only for
    resources that produced a measurement would drop the configuration of every resource the
    report most needs to talk about."""

    @property
    def resource_id(self) -> str:
        return self.record["resource_id"]

    def to_plain_data(self) -> dict[str, PlainData]:
        """This resource as the plain-data object the snapshot carries (Req 35.3).

        Day buckets are ordered by local day, statistics by `(metric, statistic)` and facts
        by `key` ascending in Unicode code-point order — all produced here rather than
        inherited from the order responses arrived in (Req 34.8). `sorted` over `str` compares
        by code point, which is what the requirement asks for and what JCS assumes of the
        arrays it leaves untouched.
        """
        record = self.record
        return {
            "resource_id": record["resource_id"],
            "name": record["name"],
            "resource_type": record["resource_type"],
            "location": record["location"],
            "resource_group": record["resource_group"],
            "tags": dict(record["tags"]),
            "power_state_raw": record["power_state_raw"],
            "power_state": record["power_state"],
            "fidelity_tier": record["fidelity_tier"],
            "sku": self.sku.to_plain_data(),
            "statistics": _statistics_to_plain_data(self.statistics),
            "day_buckets": [
                bucket.to_plain_data()
                for bucket in sorted(self.day_buckets, key=lambda item: item.local_day)
            ],
            # Req 4.6 — emitted **always**, including as an empty array, and inside the
            # canonical form the content hash is taken over. Omitting the key when a resource
            # has no fact would make "this resource has no facts" and "this snapshot predates
            # facts" the same document, which is the distinction `schema_version` exists to
            # carry; and a key that appears conditionally makes the digest depend on whether a
            # source happened to answer.
            "facts": [
                entry.to_plain_data()
                for entry in sorted(self.facts, key=lambda item: item.sort_key)
            ],
        }


def _statistics_to_plain_data(
    entries: Iterable[StatisticEntry],
) -> list[PlainData]:
    """A statistics array, sorted by `(metric, statistic)` (Req 34.8) and rendered.

    `sorted` is stable, so two entries sharing a metric and a statistic keep their
    relative order rather than being reordered arbitrarily — which is the only sensible
    behaviour for input that should not contain such a pair in the first place.
    """
    return [
        entry.to_plain_data() for entry in sorted(entries, key=lambda item: item.sort_key)
    ]


# --- the document (Req 35.1-35.5, 35.8, 35.9) ---------------------------------------


def _scope_to_plain_data(
    scope: ScopeSpec, metrics_by_resource_type: Mapping[str, Sequence[str]]
) -> dict[str, PlainData]:
    """The run's requested scope as resolved (Req 35.9): the requested resource types,
    resource groups and tag filters, plus the metric names requested per resource type.

    Every array is sorted here. JCS orders object keys and leaves arrays untouched, so
    an inherited array order — the order a form submitted resource groups in, say —
    would change the digest for a scope that is semantically identical (Req 34.8).
    Tag filters need no sorting: they are an object, and JCS orders its keys.
    """
    return {
        "resource_types": sorted(scope["resource_types"]),
        "resource_groups": sorted(scope["resource_groups"]),
        "tag_filters": dict(scope["tag_filters"]),
        "metrics_by_resource_type": {
            resource_type: sorted(names)
            for resource_type, names in metrics_by_resource_type.items()
        },
    }


def _gaps_to_plain_data(gaps: Iterable[GapRecord]) -> list[PlainData]:
    """Every `collection_log` entry the run recorded, ordered by `gap_type`, then
    `resource_id`, then `metric` (Req 34.8) via `collect/log.py`'s `gap_sort_key`.

    **Every** entry, with no filtering and no de-duplication: Req 29.9 ties the gap
    count a `snapshot_ready` event carries to the count recorded during collection, so
    dropping a duplicate-looking entry here would silently break that equality. `metric`
    is emitted as `null` for a resource-level gap, which is the `GapRecord` shape
    unchanged.

    `interval_start` and `source` are emitted **only when present**, following this
    module's omit-when-absent convention rather than `metric`'s emit-`null` one. The
    two differ for a reason that is about digests, not taste: `metric` has been written
    on every gap since the first snapshot, so emitting it as `null` costs nothing, while
    the other two are new. Emitting `null` for the twenty gap types that carry neither
    would change the canonical bytes of **every** gap ever recorded, and so the
    `content_hash` of every snapshot a re-run would produce — turning two additive fields
    into a silent break of the one property the snapshot exists to have. Omitted, a run
    recording no interval-level and no fact gap hashes exactly as it did before.

    Both are read with `.get`, so a gap built as a plain dict by an older writer — or read
    back out of an archived snapshot — is emitted rather than raising a `KeyError` on a
    field it predates.
    """
    entries: list[PlainData] = []
    for gap in sorted(gaps, key=gap_sort_key):
        entry: dict[str, PlainData] = {
            "gap_type": gap["gap_type"],
            "resource_id": gap["resource_id"],
            "metric": gap["metric"],
            "message": gap["message"],
        }
        for field_name in ("interval_start", "source"):
            value = gap.get(field_name)  # type: ignore[literal-required]
            if value is not None:
                entry[field_name] = value
        entries.append(entry)
    return entries


def build_snapshot(
    *,
    run_id: str,
    scope: ScopeSpec,
    scope_verified: bool,
    collected_at: datetime,
    timezone_name: str,
    tz: TzInfo,
    window: Window,
    grain: str,
    metrics_by_resource_type: Mapping[str, Sequence[str]],
    resources: Iterable[ResourceSnapshot],
    gaps: Iterable[GapRecord],
    catalog_version: str,
    raw_archive_complete: bool,
    raw_archive_object_count: int,
    invocation_started_at: datetime | None,
    agent_version: str = AGENT_VERSION,
    schema_version: str = SNAPSHOT_SCHEMA_VERSION,
) -> dict[str, PlainData]:
    """Build one complete, scrubbed, content-addressed snapshot document.

    Every field Req 35.1, 35.2, 35.3, 35.5, 35.8 and 35.9 enumerate is emitted:
    `schema_version` and `producer` so a later reader identifies the writer without the
    run; `run_id` and `subscription_id`; `scope_verified` as recorded on the connection
    at invoke time (Req 35.2); `collected_at` as a whole-second RFC 3339 UTC instant;
    the IANA `timezone` name and that zone's resolved `utc_offset`; the `grain`; the
    half-open `window` as local dates plus the UTC instants they resolved to; the
    `requested_scope`; the `raw_archive` completeness marker (Req 26.12), so a
    replayable run is distinguishable from one whose archive has a hole in it; the
    sorted `resources`; and the full `gaps` list.

    The order of operations matters and is not interchangeable:

    1. The body is assembled with every array order **produced** (Req 34.8).
    2. The whole body passes through the Redaction_Guard scrub (Req 35.4) — an Azure
       error message quoted into a gap can contain a credential.
    3. :func:`assert_no_bare_percentile_keys` and :func:`assert_no_floats` run over the
       scrubbed body, so a violation raises before any digest exists and therefore
       before anything could be written (Req 28.4, 34.10).
    4. The digest is taken over the **scrubbed** body (Req 34.3). Scrubbing after
       hashing would write bytes that differ from the bytes that were hashed, which
       would defeat content addressing entirely.
    5. `content_hash` and `snapshot_id` are set to that digest, character for character
       (Req 34.5).

    `utc_offset` is resolved at the window's **start** instant. A zone observing
    daylight saving holds more than one offset across a month, and Req 35.1 asks for
    "that zone's resolved UTC offset" — singular — so the window's own start is the
    one instant that is unambiguously about this collection. The customer zone this
    product targets, `Asia/Jakarta`, has no transitions at all.

    Returns a plain `dict`. There is no snapshot *object* type, deliberately: the
    document's identity is its bytes, and a class wrapping it would invite an `update`
    method, which Req 34.6 forbids outright.
    """
    resource_list = list(resources)
    _assert_facts_are_collectable(
        resource_list,
        invocation_started_at=invocation_started_at,
        snapshot_written_at=collected_at,
    )

    body: dict[str, PlainData] = {
        "schema_version": schema_version,
        "producer": {
            "agent_version": agent_version,
            "catalog_version": catalog_version,
        },
        "run_id": run_id,
        "subscription_id": scope["subscription_id"],
        "scope_verified": bool(scope_verified),
        "collected_at": rfc3339_utc(collected_at),
        "timezone": timezone_name,
        "utc_offset": format_utc_offset(_resolved_offset(window, tz)),
        "grain": grain,
        "window": dict(window_to_plain(window)),
        "requested_scope": _scope_to_plain_data(scope, metrics_by_resource_type),
        "raw_archive": {
            "complete": bool(raw_archive_complete),
            "object_count": int(raw_archive_object_count),
        },
        "resources": [
            resource.to_plain_data()
            for resource in sorted(resource_list, key=lambda item: item.resource_id)
        ],
        "gaps": _gaps_to_plain_data(gaps),
    }

    scrubbed = cast("dict[str, PlainData]", scrub_deep(body))

    assert_no_bare_percentile_keys(scrubbed)
    assert_no_floats(scrubbed)

    digest = content_hash(scrubbed)
    scrubbed[CONTENT_HASH_FIELD] = digest
    scrubbed[SNAPSHOT_ID_FIELD] = digest
    return scrubbed


def _assert_facts_are_collectable(
    resources: Sequence[ResourceSnapshot],
    *,
    invocation_started_at: datetime | None,
    snapshot_written_at: datetime,
) -> None:
    """The two refusals a fact's own `__post_init__` cannot make (Req 4.12, 4.13).

    Both need something an individual :class:`FactEntry` does not have — the other facts on the
    resource, and the run's own clock — so they live here, where `build_snapshot` has both and
    can name the **resource id** alongside the key. Raised before the body is assembled, so no
    digest exists and therefore no snapshot object could have been written.

    ## Two facts for one resource sharing a key

    Refused rather than resolved. A resource carrying `os_type` twice makes the emitted array's
    contents depend on which one sorted first among equals, and `FactEntry.sort_key` is the key
    alone precisely because a pair sharing one is a case that raises. Whichever value won would
    also be a coin toss between two answers from possibly two different sources.

    ## `collected_at` outside the run's lifetime

    A fact stamped before the run began or after its snapshot was written did not come from this
    run, and a snapshot that carried one would be attributing an observation to a collection
    that could not have made it.

    **The lower bound is the invocation instant, not `claimed_at`**, and that is the design's
    deliberate narrowing of Req 4.13. The runtime cannot observe `claimed_at`: the invoke
    `context` is closed at twelve fields with a guard, and reaching `claimed_at` would need a
    thirteenth. The invocation instant is `>= claimed_at` by construction — the app claims the
    row and then invokes — so this bound is **strictly tighter** than the requirement's and
    rejects no correct run. A looser bound would have been the thing to argue about; a tighter
    one needs only to be recorded, which is what this paragraph is.

    `invocation_started_at` is `None` on the **replay** path, and that is a decision rather than
    a default: `verify/replay.py` re-derives a document that was already validated when it was
    written, and it has no invocation of its own to bound anything by. Required-but-nullable so
    every call site states which of the two it is, rather than inheriting a default that would
    make the check skippable by omission.
    """
    for resource in resources:
        resource_id = resource.resource_id
        seen: set[str] = set()
        for entry in resource.facts:
            if entry.key in seen:
                raise FactEntryError(
                    f"resource {resource_id!r} carries two facts for the key "
                    f"{entry.key!r}. One resource holds at most one value per key, so the "
                    f"emitted array's contents would depend on which of the two sorted "
                    f"first among equals",
                    key=entry.key,
                    resource_id=resource_id,
                )
            seen.add(entry.key)

            if invocation_started_at is None:
                continue
            instant = _parse_rfc3339(entry.collected_at, key=entry.key, resource_id=resource_id)
            if not invocation_started_at <= instant <= snapshot_written_at:
                raise FactEntryError(
                    f"resource {resource_id!r} fact {entry.key!r} was collected at "
                    f"{entry.collected_at}, outside this run's lifetime "
                    f"[{rfc3339_utc(invocation_started_at)}, "
                    f"{rfc3339_utc(snapshot_written_at)}]. A fact from outside the window "
                    f"attributes an observation to a collection that could not have made it",
                    key=entry.key,
                    resource_id=resource_id,
                )


def _parse_rfc3339(value: str, *, key: str, resource_id: str) -> datetime:
    """`value` as an aware `datetime`, or a :class:`FactEntryError`.

    Parsed only to compare against the run's own bounds and **never written back**: the
    snapshot carries `collected_at` as the string the response arrived with, exactly as
    `GapRecord.interval_start` is passed through unreparsed. A normalized instant here would
    make the digest depend on this function's formatting rather than on what Azure said.
    """
    text = value.replace("Z", "+00:00") if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as error:
        raise FactEntryError(
            f"resource {resource_id!r} fact {key!r} carries a collected_at "
            f"{value!r} that is not an RFC 3339 instant, so it cannot be checked against "
            f"the run's lifetime (Req 4.13)",
            key=key,
            resource_id=resource_id,
        ) from error
    if parsed.tzinfo is None:
        raise FactEntryError(
            f"resource {resource_id!r} fact {key!r} carries a naive collected_at "
            f"{value!r}; an instant with no offset cannot be ordered against the run's "
            f"bounds without inventing a zone for it",
            key=key,
            resource_id=resource_id,
        )
    return parsed


def _resolved_offset(window: Window, tz: TzInfo) -> timedelta:
    """The UTC offset `tz` holds at the window's start instant.

    Raises `ValueError` if the `tzinfo` yields no offset for an aware instant, which no
    stdlib `tzinfo` does — the check exists so a custom `tzinfo` cannot silently make
    the emitted offset `+00:00`.
    """
    offset = window.start_utc.astimezone(tz).utcoffset()
    if offset is None:  # pragma: no cover - no stdlib tzinfo does this
        raise ValueError(f"{tz!r} produced no UTC offset at {window.start_utc!r}")
    return offset


# --- the write, and the only write there is (Req 34.6, 34.9, 35.6) ------------------


def snapshot_key(actor_id: str, run_id: str) -> str:
    """`<actor_id>/snapshots/<runId>/snapshot.json` (Req 35.6).

    The **actor id is the first segment**, which is what makes download authorization in
    the web app a first-segment comparison against the signed-in user's id rather than
    a `startsWith` prefix match — `alice-evil/...` starts with `alice` and must not
    authorize for `alice`.

    Raises `ValueError` for an empty component or one containing `/`: a slash would
    silently move the object to a different prefix, and for the first segment that
    means a different owner's namespace.
    """
    for label, component in (("actor_id", actor_id), ("run_id", run_id)):
        if not isinstance(component, str) or not component.strip():
            raise ValueError(f"{label} must be a non-empty string, got {component!r}")
        if "/" in component:
            raise ValueError(
                f"{label} must contain no '/', got {component!r}: the artifact key's "
                f"first segment is the owning actor id and authorization compares it "
                f"segment-wise"
            )
    return f"{actor_id}/snapshots/{run_id}/snapshot.json"


async def write_once(
    store: ObjectStore,
    document: Mapping[str, PlainData],
    *,
    actor_id: str,
    run_id: str,
) -> bool:
    """Write `document` exactly once, at the key Req 35.6 declares.

    Returns `True` when this call wrote the object and `False` when one already existed
    at the key — in which case the existing bytes are left **unchanged**, no second
    object is written, and the attempt is recorded in a log line (Req 34.9). The
    conditional is `PutObject` with `IfNoneMatch: "*"`, which `storage/base.py`'s
    `put_bytes_if_absent` already implements, so write-once is an S3 guarantee rather
    than a read-then-write race this module would lose.

    The body is the document's own RFC 8785 canonical form, **including** `content_hash`
    and `snapshot_id`. Only the *hash input* excludes those two fields (Req 34.4); the
    stored object carries them, which is what lets a reader check the id against the
    bytes without knowing how the document was built.
    :func:`verify_content_hash` runs first, so a document changed after
    :func:`build_snapshot` returned is refused rather than stored under an id it does
    not have.

    The key is **derived**, not accepted, and the object is tagged with the owning actor
    id. There is deliberately no `key` parameter, no update path and no delete path
    (Req 34.6): re-running a collection builds a new document with a new id and writes
    it at its own run's key, leaving every earlier object byte-identical (Req 34.7).
    The store is injected, so nothing here imports boto3 and the whole path is
    exercised against an in-memory fake.
    """
    verify_content_hash(document)
    key = snapshot_key(actor_id, run_id)
    body = rfc8785.dumps(dict(document))

    written = await store.put_bytes_if_absent(
        key,
        body,
        content_type=JSON_CONTENT_TYPE,
        tags=owner_tags(actor_id),
    )
    if not written:
        logger.warning(
            "a snapshot object already exists at %s; leaving its bytes unchanged and "
            "writing no second object (Req 34.9). Snapshot %s was not stored.",
            key,
            document.get(SNAPSHOT_ID_FIELD),
        )
    return written
