"""Pure selector for historical-trend prior runs (Requirements 18.4–18.15).

**Pure**: no clock, no network, no object store. ``snapshot_for`` is supplied by the
caller and consulted only for a candidate the first four filters already admitted.

The filter order is DECLARED and load-bearing — it determines both the typed exclusion
reason (exactly one per excluded candidate) and the number of snapshots loaded:

    1. status_not_completed
    2. verification_not_passed
    3. period_overlapping
    4. beyond_lookback
    5. metric_absent_in_snapshot
    6. fidelity_tier_differs

Steps 5 and 6 are last because they are the only two that read a snapshot, so **at most
``lookback`` snapshots are ever loaded** by the pipeline that calls this module.

``report_pipeline.py`` loads prior snapshots and hands them to the selector — the same
shape ``verify/replay.py`` already has, where the caller fetches and the pure module folds.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final

__all__ = [
    "EXCLUSION_REASONS",
    "REASON_BEYOND_LOOKBACK",
    "REASON_FIDELITY_TIER_DIFFERS",
    "REASON_METRIC_ABSENT_IN_SNAPSHOT",
    "REASON_PERIOD_OVERLAPPING",
    "REASON_STATUS_NOT_COMPLETED",
    "REASON_VERIFICATION_NOT_PASSED",
    "Exclusion",
    "PriorRunCandidate",
    "Selection",
    "select",
]

# ---------------------------------------------------------------------------
# The six declared exclusion reasons — a closed set (Requirement 18.15)
# ---------------------------------------------------------------------------

REASON_STATUS_NOT_COMPLETED: Final[str] = "status_not_completed"
REASON_VERIFICATION_NOT_PASSED: Final[str] = "verification_not_passed"
REASON_PERIOD_OVERLAPPING: Final[str] = "period_overlapping"
REASON_BEYOND_LOOKBACK: Final[str] = "beyond_lookback"
REASON_METRIC_ABSENT_IN_SNAPSHOT: Final[str] = "metric_absent_in_snapshot"
REASON_FIDELITY_TIER_DIFFERS: Final[str] = "fidelity_tier_differs"

EXCLUSION_REASONS: Final[tuple[str, ...]] = (
    REASON_STATUS_NOT_COMPLETED,
    REASON_VERIFICATION_NOT_PASSED,
    REASON_PERIOD_OVERLAPPING,
    REASON_BEYOND_LOOKBACK,
    REASON_METRIC_ABSENT_IN_SNAPSHOT,
    REASON_FIDELITY_TIER_DIFFERS,
)
"""Exactly six, in filter order."""

assert len(EXCLUSION_REASONS) == 6


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PriorRunCandidate:
    """One candidate row from the app's historical query.

    ``verification_status``, ``verification_created_at`` and ``verification_id`` are
    ``None`` when no verification exists for this run — the LEFT JOIN doing its job.
    """

    run_id: str
    period_start: str
    period_end: str
    timezone: str
    status: str
    verification_status: str | None
    verification_created_at: str | None
    verification_id: str | None
    snapshot_sha256: str | None


@dataclass(frozen=True, slots=True)
class Exclusion:
    """One excluded candidate with exactly one typed reason."""

    run_id: str
    reason: str

    def __post_init__(self) -> None:
        if self.reason not in EXCLUSION_REASONS:
            raise ValueError(
                f"exclusion reason {self.reason!r} is not one of the six declared values"
            )


@dataclass(frozen=True, slots=True)
class Selection:
    """The selector's result.

    Invariant: ``selected + exclusions == candidates`` as a set of run ids.
    ``selected`` is ordered by period start ascending.
    """

    selected: tuple[PriorRunCandidate, ...]
    exclusions: tuple[Exclusion, ...]


# ---------------------------------------------------------------------------
# The selector
# ---------------------------------------------------------------------------


def select(
    candidates: list[PriorRunCandidate],
    *,
    compiling_period_start: str,
    lookback: int,
    metric: str,
    statistic: str,
    compiling_fidelity_tier: str,
    snapshot_for: Callable[[str], Mapping[str, object] | None],
) -> Selection:
    """Select prior runs for a ``historical_trend`` block.

    Parameters
    ----------
    candidates
        The app's query result — up to 200 prior runs for the same template row and
        subscription, each carrying its latest verification. Order does not matter:
        this function sorts internally.
    compiling_period_start
        The compiling run's resolved local period start (ISO date). Only runs whose
        ``period_end`` is strictly before this are candidates (the query already
        enforces this, but the selector does not rely on that).
    lookback
        The block's declared lookback count (2–24 inclusive).
    metric
        The metric the ``historical_trend`` block plots.
    statistic
        The statistic the ``historical_trend`` block plots.
    compiling_fidelity_tier
        The compiling run's own fidelity tier for this metric+statistic.
    snapshot_for
        ``snapshot_for(run_id)`` returns the plain snapshot document for that run, or
        ``None`` if unavailable. Called **at most ``lookback`` times** — only for runs
        that passed all four preceding filters.

    Returns
    -------
    Selection
        ``selected`` ordered by period start ascending, plus one ``Exclusion`` per
        excluded candidate. ``selected + exclusions == candidates`` as a set.
    """
    exclusions: list[Exclusion] = []

    # --- Step 1: status_not_completed ------------------------------------------------
    alive: list[PriorRunCandidate] = []
    for candidate in candidates:
        if candidate.status != "completed":
            exclusions.append(Exclusion(candidate.run_id, REASON_STATUS_NOT_COMPLETED))
        else:
            alive.append(candidate)

    # --- Step 2: verification_not_passed ---------------------------------------------
    passed: list[PriorRunCandidate] = []
    for candidate in alive:
        if candidate.verification_status != "pass":
            exclusions.append(
                Exclusion(candidate.run_id, REASON_VERIFICATION_NOT_PASSED)
            )
        else:
            passed.append(candidate)

    # --- Step 3: period_overlapping --------------------------------------------------
    # Among overlapping runs, retain the one whose period end is later; on equal ends,
    # the one whose latest passing verification has the greater creation instant; on
    # equal instants, the one whose id compares greater in code-point order.
    non_overlapping = _resolve_overlaps(passed)
    excluded_by_overlap = {c.run_id for c in passed} - {
        c.run_id for c in non_overlapping
    }
    for candidate in passed:
        if candidate.run_id in excluded_by_overlap:
            exclusions.append(Exclusion(candidate.run_id, REASON_PERIOD_OVERLAPPING))

    # --- Step 4: beyond_lookback -----------------------------------------------------
    # Order by period end descending, then verification_created_at descending, then id
    # descending. Take only up to `lookback`.
    ordered = sorted(
        non_overlapping,
        key=lambda c: (
            c.period_end,
            c.verification_created_at or "",
            c.run_id,
        ),
        reverse=True,
    )
    within_lookback = ordered[:lookback]
    beyond = ordered[lookback:]
    for candidate in beyond:
        exclusions.append(Exclusion(candidate.run_id, REASON_BEYOND_LOOKBACK))

    # --- Step 5: metric_absent_in_snapshot -------------------------------------------
    # Only now do we consult snapshots — at most `lookback` loads.
    metric_present: list[PriorRunCandidate] = []
    for candidate in within_lookback:
        snapshot = snapshot_for(candidate.run_id)
        if snapshot is None or not _has_metric_statistic(snapshot, metric, statistic):
            exclusions.append(
                Exclusion(candidate.run_id, REASON_METRIC_ABSENT_IN_SNAPSHOT)
            )
        else:
            metric_present.append(candidate)

    # --- Step 6: fidelity_tier_differs -----------------------------------------------
    selected: list[PriorRunCandidate] = []
    for candidate in metric_present:
        snapshot = snapshot_for(candidate.run_id)
        tier = _fidelity_tier_for(snapshot, metric, statistic) if snapshot else None
        if tier != compiling_fidelity_tier:
            exclusions.append(
                Exclusion(candidate.run_id, REASON_FIDELITY_TIER_DIFFERS)
            )
        else:
            selected.append(candidate)

    # --- Order selected by period start ascending ------------------------------------
    selected.sort(key=lambda c: (c.period_start, c.run_id))

    return Selection(
        selected=tuple(selected),
        exclusions=tuple(exclusions),
    )


# ---------------------------------------------------------------------------
# Overlap resolution
# ---------------------------------------------------------------------------


def _resolve_overlaps(
    candidates: list[PriorRunCandidate],
) -> list[PriorRunCandidate]:
    """Remove overlapping periods, retaining the winner per the declared tie-break.

    Two periods overlap when the later's start is at or before the earlier's end.
    Overlap resolution operates pairwise: sort by period start, then sweep left to
    right, comparing each consecutive pair.
    """
    if not candidates:
        return []

    # Sort by period_start ascending, then by tie-break descending to get a stable order.
    sorted_candidates = sorted(
        candidates,
        key=lambda c: (
            c.period_start,
            # Tie-break within same start: prefer greater end, greater verification, greater id
            c.period_end,
            c.verification_created_at or "",
            c.run_id,
        ),
    )

    retained: list[PriorRunCandidate] = [sorted_candidates[0]]
    for candidate in sorted_candidates[1:]:
        prev = retained[-1]
        if _overlaps(prev, candidate):
            # Decide which to retain
            winner = _overlap_winner(prev, candidate)
            if winner is candidate:
                retained[-1] = candidate
            # else: prev stays (the winner), candidate is excluded
        else:
            retained.append(candidate)

    return retained


def _overlaps(earlier: PriorRunCandidate, later: PriorRunCandidate) -> bool:
    """Two periods overlap when the later's start is at or before the earlier's end."""
    return later.period_start <= earlier.period_end


def _overlap_winner(
    a: PriorRunCandidate, b: PriorRunCandidate
) -> PriorRunCandidate:
    """Retain the run whose period end is later; on equal ends the one with greater
    verification creation instant; on equal instants the one whose id compares greater."""
    # Compare period_end
    if a.period_end != b.period_end:
        return a if a.period_end > b.period_end else b
    # Equal period_end — compare verification_created_at
    a_vca = a.verification_created_at or ""
    b_vca = b.verification_created_at or ""
    if a_vca != b_vca:
        return a if a_vca > b_vca else b
    # Equal instants — compare id in code-point order
    return a if a.run_id > b.run_id else b


# ---------------------------------------------------------------------------
# Snapshot inspection helpers — pure, work on plain data
# ---------------------------------------------------------------------------


def _has_metric_statistic(
    snapshot: Mapping[str, object], metric: str, statistic: str
) -> bool:
    """Whether the snapshot carries at least one value for ``(metric, statistic)``."""
    resources = snapshot.get("resources")
    if not isinstance(resources, (list, tuple)):
        return False
    for resource in resources:
        if not isinstance(resource, dict):
            continue
        statistics = resource.get("statistics")
        if not isinstance(statistics, (list, tuple)):
            continue
        for stat_entry in statistics:
            if not isinstance(stat_entry, dict):
                continue
            if stat_entry.get("metric") == metric and stat_entry.get("statistic") == statistic:
                return True
    return False


def _fidelity_tier_for(
    snapshot: Mapping[str, object], metric: str, statistic: str
) -> str | None:
    """Return the fidelity_tier for the first matching (metric, statistic) in the snapshot.

    The fidelity tier is on the resource-level in the snapshot structure. Find the first
    resource carrying a statistic with the matching (metric, statistic) and return its tier.
    """
    resources = snapshot.get("resources")
    if not isinstance(resources, (list, tuple)):
        return None
    for resource in resources:
        if not isinstance(resource, dict):
            continue
        tier = resource.get("fidelity_tier")
        if not isinstance(tier, str):
            continue
        statistics = resource.get("statistics")
        if not isinstance(statistics, (list, tuple)):
            continue
        for stat_entry in statistics:
            if not isinstance(stat_entry, dict):
                continue
            if stat_entry.get("metric") == metric and stat_entry.get("statistic") == statistic:
                return tier
    return None
