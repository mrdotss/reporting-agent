"""Typed `collection_log` entries — the gap vocabulary and the one way to build one.

**A gap is recorded, never zero-filled** (Req 29.3, 29.4). `deallocated`,
`metric_not_emitted` and `permission_denied` are three completely different facts that
a zero-filling collector would render identically as "0% CPU" — the partition of
24 declared `gap_type` values below is the point, not an implementation detail, and it
is fixed by the requirements glossary rather than inferred from whatever a caller
happens to pass. This module is the single place that partition is declared and the
single place a caller builds one entry, so a typo in a `gap_type` string fails at the
call site instead of surfacing 30 phases later as an unrecognised token in the
snapshot's `gaps` array.

**Deliberately reuses, rather than re-declares, two shapes that already exist:**

* `providers.base.GapRecord` is the `TypedDict` every gap crosses the provider
  boundary as (Req 18.2, 18.3) — `record_gap` returns one of those, not a second
  parallel shape this module would have to keep in sync with it.
* `catalog.loader.CATALOG_ENTRY_INVALID_GAP_TYPE` is `"catalog_entry_invalid"`,
  already declared as a `Final[str]` in the module that raises it (Req 32.4). This
  module imports that constant rather than writing the string a second time, so the
  two can never drift into two different spellings of one gap type.

**What this module does not decide:** which `gap_type` applies to a given failure, or
what a resource-less gap's `resource_id` should read. Those are call-site decisions —
`azure/inventory.py` knows it is recording `deallocated`, `collect/accumulate.py` knows
it is recording `no_samples` — made by the fifteen call sites across `azure/` and
`collect/` that this parent's remaining tasks fill in. `record_gap` is the single
narrow gate every one of those calls passes through, refusing an undeclared
`gap_type` or a blank field before a malformed entry can reach a snapshot.
"""

from __future__ import annotations

from typing import Final

from reporting_agent.catalog.loader import CATALOG_ENTRY_INVALID_GAP_TYPE
from reporting_agent.providers.base import GapRecord

__all__ = [
    "DECLARED_GAP_TYPES",
    "FACT_GAP_TYPES",
    "GAP_TYPE_ADVISOR_NOT_AVAILABLE",
    "GAP_TYPE_ARCHIVE_WRITE_FAILED",
    "GAP_TYPE_BACKUP_NOT_CONFIGURED",
    "GAP_TYPE_CATALOG_ENTRY_INVALID",
    "GAP_TYPE_DEALLOCATED",
    "GAP_TYPE_DEFINITIONS_UNAVAILABLE",
    "GAP_TYPE_DUPLICATE_INVENTORY_ROW",
    "GAP_TYPE_FACT_UNAVAILABLE",
    "GAP_TYPE_INSTANCE_NAME_COLLAPSED",
    "GAP_TYPE_INTERVAL_COUNTS_MISSING",
    "GAP_TYPE_INTERVAL_MALFORMED",
    "GAP_TYPE_METRIC_ERROR",
    "GAP_TYPE_METRIC_NOT_EMITTED",
    "GAP_TYPE_METRIC_NOT_SELECTED",
    "GAP_TYPE_NO_RESERVATIONS",
    "GAP_TYPE_NO_SAMPLES",
    "GAP_TYPE_PERCENTILE_UNSUPPORTED_UNIT",
    "GAP_TYPE_PERMISSION_DENIED",
    "GAP_TYPE_POWER_STATE_UNKNOWN",
    "GAP_TYPE_REGION_UNREACHABLE",
    "GAP_TYPE_REPLICATION_NOT_ENABLED",
    "GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE",
    "GAP_TYPE_RESPONSE_TOO_LARGE",
    "GAP_TYPE_SKU_CAPABILITY_MISSING",
    "GAP_TYPE_SKU_UNKNOWN",
    "GapTypeError",
    "gap_sort_key",
    "record_gap",
]

# --- the declared gap_type partition (requirements.md glossary; Req 29.2, 29.7) ------
#
# 24 values, one `Final[str]` each rather than a `StrEnum`. `catalog/loader.py`
# already set this precedent for `CATALOG_ENTRY_INVALID_GAP_TYPE` — a bare string
# constant, not an enum member — and a `GapRecord` is a `TypedDict` whose `gap_type`
# field is a plain `str` (Req 18.3: only str, bool, int, Decimal, None, list, dict
# cross the provider boundary; an `Enum` does not). Matching that shape here means a
# gap built in `azure/inventory.py` and a gap built by `catalog/loader.py`'s
# `InvalidEntry` compare equal by value with no enum-to-string conversion anywhere on
# the path to a snapshot.

GAP_TYPE_DEALLOCATED: Final[str] = "deallocated"
GAP_TYPE_POWER_STATE_UNKNOWN: Final[str] = "power_state_unknown"
GAP_TYPE_DUPLICATE_INVENTORY_ROW: Final[str] = "duplicate_inventory_row"
GAP_TYPE_METRIC_NOT_EMITTED: Final[str] = "metric_not_emitted"
GAP_TYPE_PERMISSION_DENIED: Final[str] = "permission_denied"
GAP_TYPE_METRIC_ERROR: Final[str] = "metric_error"
GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE: Final[str] = "resource_absent_from_response"
GAP_TYPE_INTERVAL_COUNTS_MISSING: Final[str] = "interval_counts_missing"
GAP_TYPE_INTERVAL_MALFORMED: Final[str] = "interval_malformed"
GAP_TYPE_NO_SAMPLES: Final[str] = "no_samples"
GAP_TYPE_SKU_UNKNOWN: Final[str] = "sku_unknown"
GAP_TYPE_SKU_CAPABILITY_MISSING: Final[str] = "sku_capability_missing"
GAP_TYPE_DEFINITIONS_UNAVAILABLE: Final[str] = "definitions_unavailable"
GAP_TYPE_PERCENTILE_UNSUPPORTED_UNIT: Final[str] = "percentile_unsupported_unit"
GAP_TYPE_RESPONSE_TOO_LARGE: Final[str] = "response_too_large"
GAP_TYPE_REGION_UNREACHABLE: Final[str] = "region_unreachable"
GAP_TYPE_ARCHIVE_WRITE_FAILED: Final[str] = "archive_write_failed"
GAP_TYPE_CATALOG_ENTRY_INVALID: Final[str] = CATALOG_ENTRY_INVALID_GAP_TYPE
GAP_TYPE_INSTANCE_NAME_COLLAPSED: Final[str] = "instance_name_collapsed"

# Req 23.15, 23.16 — the caller requested no metric at all for this resource's type.
#
# Distinct from `metric_not_emitted` (Azure emits nothing for this SKU) and from
# `no_samples` (the samples came back empty), because the three name three different
# causes and only this one is a decision the caller made. It is the trace for the case
# Req 5.9's validator cannot see: a scope naming **no** resource types is unconstrained,
# so a subscription-agnostic template pointed at a subscription holding a type it did not
# select is an ordinary pairing rather than a broken template — but without this gap it
# leaves no trace of any kind. An unrequested metric builds no accumulator, so there is no
# `no_samples` gap, no per-resource error and no absent-from-response gap; the resource is
# simply present in the snapshot carrying no statistics, the coverage gate asserts presence
# and passes, and the run completes as a fully verified report holding resources with no
# figures and nothing anywhere saying why.
GAP_TYPE_METRIC_NOT_SELECTED: Final[str] = "metric_not_selected"

# Req 5.1-5.4 — the four fact gaps. A fact answers *what is this resource*, so its
# absences are different facts from a metric's and are classified separately.
#
# The first three are **not errors**: a subscription with no backups, no reservations and
# no Site Recovery is an ordinary subscription, and the source answered successfully in
# each case. What they prevent is a blank cell in a delivered document, which a reader
# cannot distinguish from "configured, nothing to report" (Req 5.1's own user story).
#
# `fact_unavailable` is the fourth and it is the one that means something went wrong: the
# request failed, was rejected, or answered no value for a key the type declares. Keeping
# it apart from the other three is the whole point of having four rather than one —
# "Azure says there is no backup" and "we could not ask Azure about the backup" are
# opposite facts, and Req 5.8 forbids recording both for one key.
GAP_TYPE_BACKUP_NOT_CONFIGURED: Final[str] = "backup_not_configured"
GAP_TYPE_NO_RESERVATIONS: Final[str] = "no_reservations"
GAP_TYPE_REPLICATION_NOT_ENABLED: Final[str] = "replication_not_enabled"
GAP_TYPE_ADVISOR_NOT_AVAILABLE: Final[str] = "advisor_not_available"
"""Task 6.4's own absent-gap type: Advisor answered successfully and named no
recommendation for a resource this run named. Kept apart from `GAP_TYPE_FACT_UNAVAILABLE`
for the identical reason the other three absent-gap types are — "Advisor has nothing to
say about this resource" and "we could not ask Advisor" are opposite facts, and recording
the wrong one turns a permission problem into a data problem or the reverse."""
GAP_TYPE_FACT_UNAVAILABLE: Final[str] = "fact_unavailable"

FACT_GAP_TYPES: Final[frozenset[str]] = frozenset(
    {
        GAP_TYPE_BACKUP_NOT_CONFIGURED,
        GAP_TYPE_NO_RESERVATIONS,
        GAP_TYPE_REPLICATION_NOT_ENABLED,
        GAP_TYPE_ADVISOR_NOT_AVAILABLE,
        GAP_TYPE_FACT_UNAVAILABLE,
    }
)
"""The five gap types a fact produces, and the set `record_gap` requires a `source` for.

Req 5.10 asks that every gap of a type this spec adds record the source that was queried.
Declared as a set and enforced at the one gate rather than left to the caller: the fold
that records these gaps handles five sources and several keys per resource, so "remember to
pass the source" is exactly the kind of obligation that holds for four call sites and not
the fifth. A gap that cannot name where it looked is not evidence of anything."""

DECLARED_GAP_TYPES: Final[frozenset[str]] = frozenset(
    {
        GAP_TYPE_DEALLOCATED,
        GAP_TYPE_POWER_STATE_UNKNOWN,
        GAP_TYPE_DUPLICATE_INVENTORY_ROW,
        GAP_TYPE_METRIC_NOT_EMITTED,
        GAP_TYPE_PERMISSION_DENIED,
        GAP_TYPE_METRIC_ERROR,
        GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE,
        GAP_TYPE_INTERVAL_COUNTS_MISSING,
        GAP_TYPE_INTERVAL_MALFORMED,
        GAP_TYPE_NO_SAMPLES,
        GAP_TYPE_SKU_UNKNOWN,
        GAP_TYPE_SKU_CAPABILITY_MISSING,
        GAP_TYPE_DEFINITIONS_UNAVAILABLE,
        GAP_TYPE_PERCENTILE_UNSUPPORTED_UNIT,
        GAP_TYPE_RESPONSE_TOO_LARGE,
        GAP_TYPE_REGION_UNREACHABLE,
        GAP_TYPE_ARCHIVE_WRITE_FAILED,
        GAP_TYPE_CATALOG_ENTRY_INVALID,
        GAP_TYPE_INSTANCE_NAME_COLLAPSED,
        GAP_TYPE_METRIC_NOT_SELECTED,
        *FACT_GAP_TYPES,
    }
)

assert len(DECLARED_GAP_TYPES) == 25
assert FACT_GAP_TYPES < DECLARED_GAP_TYPES


class GapTypeError(ValueError):
    """`gap_type` is not one of the 25 declared values.

    Carries the offending value so a caller building a message does not have to
    re-parse `str(exc)`.
    """

    def __init__(self, gap_type: str) -> None:
        super().__init__(
            f"{gap_type!r} is not one of the declared gap_type values: "
            f"{sorted(DECLARED_GAP_TYPES)}"
        )
        self.gap_type = gap_type


def record_gap(
    gap_type: str,
    resource_id: str,
    metric: str | None,
    message: str,
    interval_start: str | None = None,
    source: str | None = None,
) -> GapRecord:
    """Build one typed `collection_log` entry.

    The single gate every gap-recording call site passes through (Req 29.2). Raises
    rather than returning a malformed entry:

    * `GapTypeError` if `gap_type` is not one of the 24 declared values — a typo here
      is exactly the "unrecognised classification" Req 29.7 refuses to drop, so it
      must not reach the snapshot as an ad hoc string either.
    * `ValueError` if `resource_id` or `message` is empty or not a string. Every gap
      names the resource it affects — "the affected `resource_id`" per the
      requirements glossary — so there is no code path that produces a gap naming
      nothing. A gap that is not about one specific resource (a whole-catalog failure
      recorded before any inventory exists, for instance) still names the identifier
      its caller has in scope for it, such as a resource type; this module does not
      prescribe which identifier that is, only that one is present.
    * `ValueError` if `metric` is present but empty. `None` is always accepted —
      Req 18.2's `GapRecord.metric` is `None` for a resource-level gap — but an empty
      string would silently mean the same thing through a different spelling, which
      is exactly the kind of two-spellings-one-meaning gap this module exists to
      close off.
    * `ValueError` if `interval_start` is present but empty, on the identical
      reasoning and deliberately in the identical shape: `None` means "this gap is
      not about one interval", and an empty string would be a second spelling of
      that same absence. One validation style here rather than two, so a caller
      cannot learn a different rule per field.

    * `ValueError` if `source` is present but empty — the same reasoning again — and
      also if it is **absent for one of the four** :data:`FACT_GAP_TYPES` (Req 5.10).
      That second clause is the only conditional validation in this function, and it
      earns the exception: a fact gap's whole content is "I asked *there* and it said
      nothing", so one that cannot name where it looked states an absence without
      evidence of having looked. Enforced here rather than trusted to the fold, which
      handles four sources across several keys per resource — precisely the shape where
      three call sites remember and the fourth does not.

    `interval_start` defaults to `None`, so the twenty-odd call sites that record a
    resource-level or metric-level gap are unchanged and say nothing about an interval
    they have none of. Only the interval-level sites in `azure/metrics.py` and
    `collect/accumulate.py` pass it. `source` is the same shape one field over: absent on
    all twenty of the original types, required on the four fact types.

    Returns a `GapRecord` (Req 18.2) rather than a bespoke type, so a caller in
    `azure/` and a caller in `collect/` hand the pipeline the identical shape.
    """
    if not isinstance(gap_type, str) or gap_type not in DECLARED_GAP_TYPES:
        raise GapTypeError(gap_type if isinstance(gap_type, str) else repr(gap_type))

    if not isinstance(resource_id, str) or not resource_id.strip():
        raise ValueError(
            f"resource_id must be a non-empty string for gap_type {gap_type!r}, "
            f"got {resource_id!r}"
        )

    if metric is not None and (not isinstance(metric, str) or not metric.strip()):
        raise ValueError(
            f"metric must be None or a non-empty string for gap_type {gap_type!r}, "
            f"got {metric!r}; use None for a resource-level gap rather than an empty "
            f"string"
        )

    if not isinstance(message, str) or not message.strip():
        raise ValueError(
            f"message must be a non-empty string for gap_type {gap_type!r}, got "
            f"{message!r}"
        )

    if interval_start is not None and (
        not isinstance(interval_start, str) or not interval_start.strip()
    ):
        raise ValueError(
            f"interval_start must be None or a non-empty string for gap_type "
            f"{gap_type!r}, got {interval_start!r}; use None for a gap that is not "
            f"about one interval rather than an empty string"
        )

    if source is not None and (not isinstance(source, str) or not source.strip()):
        raise ValueError(
            f"source must be None or a non-empty string for gap_type {gap_type!r}, got "
            f"{source!r}; use None for a gap that queried no named source rather than an "
            f"empty string"
        )

    if source is None and gap_type in FACT_GAP_TYPES:
        raise ValueError(
            f"gap_type {gap_type!r} is a fact gap and must name the source that was "
            f"queried (Req 5.10); got source=None. A fact gap asserts that a named "
            f"source answered and named nothing, so one that cannot say where it looked "
            f"records an absence with no evidence behind it"
        )

    return GapRecord(
        gap_type=gap_type,
        resource_id=resource_id,
        metric=metric,
        message=message,
        interval_start=interval_start,
        source=source,
    )


def gap_sort_key(gap: GapRecord) -> tuple[str, str, str]:
    """`(gap_type, resource_id, metric)` — the array order Req 34.8 requires of the
    snapshot's `gaps` list: by `gap_type`, then `resource_id`, then `metric`.

    `metric` is normalised to `""` for comparison only, never stored: `None` sorts
    before every non-empty metric name, which keeps a resource-level gap ahead of
    that same resource's metric-level gaps without this module inventing an ordering
    for `None` against `str` that Python's own comparison refuses to define.

    A caller — `collect/snapshot.py` (task 9.9) — uses this as
    `sorted(gaps, key=gap_sort_key)`; it does not itself sort or store anything,
    consistent with every other pure helper in this package producing an order
    rather than assuming a caller already provided one (Req 34.8's own emphasis:
    "produced, never inherited").
    """
    return (gap["gap_type"], gap["resource_id"], gap["metric"] or "")
