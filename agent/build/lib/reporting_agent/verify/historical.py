"""The ``historical`` gate (Req 18.11, 18.12, 19.9).

**Pure**: no clock, no network, no object store, no database. The verification status
and periods of prior runs are supplied in ``VerifyInputs.historical`` — the app resolves
them from Postgres before invoking the agent, so this module reads what was already known.

Two blocking findings:

- ``historical_point_unverified``: a ledger entry carries a ``source_run_id`` whose
  supplied verification status is not ``pass``. Every such entry records a finding,
  naming the run id and the entry's AST path.
- ``historical_point_overlapping``: two distinct ``source_run_id`` values among the
  historical entries have periods that overlap. One finding per pair, naming both run ids
  and both periods.

Records on the verification result — for every historical point the document carries —
its source run id and that run's snapshot hash, so a reader can trace each plotted period
to the verification that proved it.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from reporting_agent.compile.figures import FigureLedger
from reporting_agent.verify.findings import (
    FINDING_HISTORICAL_POINT_OVERLAPPING,
    FINDING_HISTORICAL_POINT_UNVERIFIED,
    Finding,
    record_finding,
)

__all__ = ["HistoricalPass", "HistoricalRunInfo", "check_historical"]


@dataclass(frozen=True, slots=True)
class HistoricalRunInfo:
    """Supplied by the app for each source run id used in historical trend figures.

    ``verification_status`` is the latest verification's status for that run, or an
    empty string / absent key when no verification exists (treated as not-pass).
    """

    verification_status: str
    period_start: str
    period_end: str


@dataclass(frozen=True, slots=True)
class HistoricalPass:
    """Result of the ``historical`` gate."""

    findings: tuple[Finding, ...]
    historical_points: tuple[dict[str, str], ...]
    """For each historical figure in the ledger, ``{run_id, snapshot_sha256}``.

    Matches ``VerificationView.historicalPoints`` from task 8.3:
    ``readonly { runId: string; snapshotSha256: string }[]``.
    The Python-side uses snake_case keys; the app projection maps them.
    """


_STATUS_PASS: Final[str] = "pass"


def check_historical(
    ledger: FigureLedger,
    *,
    historical: Mapping[str, HistoricalRunInfo],
) -> HistoricalPass:
    """Evaluate the ``historical`` gate.

    Parameters
    ----------
    ledger
        The compiled figure ledger for this run.
    historical
        A mapping from source run id to its verification status and period, supplied by
        the app in the invoke payload. Only run ids that appear as ``source_run_id`` on
        ledger entries are relevant.
    """
    findings: list[Finding] = []
    historical_points: list[dict[str, str]] = []

    # Collect all historical entries from the ledger — those with a source_run_id.
    historical_entries: list[tuple[str, str, str]] = []  # (path, run_id, snapshot_sha256)
    for path, figure in ledger.entries.items():
        if figure.source_run_id is not None:
            historical_entries.append((
                str(path),
                figure.source_run_id,
                figure.source_snapshot_sha256 or "",
            ))

    # Record historical points for the result (one per entry).
    seen_run_ids: dict[str, str] = {}  # run_id -> snapshot_sha256 (deduped for points)
    for _path, run_id, snapshot_sha256 in historical_entries:
        if run_id not in seen_run_ids:
            seen_run_ids[run_id] = snapshot_sha256

    for run_id, snapshot_sha256 in seen_run_ids.items():
        historical_points.append({
            "run_id": run_id,
            "snapshot_sha256": snapshot_sha256,
        })

    # --- Finding 1: historical_point_unverified (Req 18.11) ---
    # Every ledger entry with a source_run_id whose verification status is not "pass".
    for entry_path, run_id, _sha in historical_entries:
        info = historical.get(run_id)
        if info is None or info.verification_status != _STATUS_PASS:
            status_desc = (
                info.verification_status if info is not None else "unknown"
            )
            findings.append(record_finding(
                FINDING_HISTORICAL_POINT_UNVERIFIED,
                f"historical figure at {entry_path!r} references prior run "
                f"{run_id!r} whose verification status is {status_desc!r}, not 'pass'",
                run_id=run_id,
                path=entry_path,
            ))

    # --- Finding 2: historical_point_overlapping (Req 18.12) ---
    # Any two DISTINCT source_run_ids among the entries whose periods overlap.
    # Collect unique run ids that have info supplied.
    distinct_run_ids = sorted(seen_run_ids.keys())
    reported_pairs: set[tuple[str, str]] = set()

    for i, run_id_a in enumerate(distinct_run_ids):
        info_a = historical.get(run_id_a)
        if info_a is None:
            continue
        for run_id_b in distinct_run_ids[i + 1:]:
            info_b = historical.get(run_id_b)
            if info_b is None:
                continue
            pair = (run_id_a, run_id_b)
            if pair in reported_pairs:
                continue
            if _periods_overlap(
                info_a.period_start, info_a.period_end,
                info_b.period_start, info_b.period_end,
            ):
                reported_pairs.add(pair)
                findings.append(record_finding(
                    FINDING_HISTORICAL_POINT_OVERLAPPING,
                    f"historical points from run {run_id_a!r} "
                    f"({info_a.period_start}–{info_a.period_end}) and run "
                    f"{run_id_b!r} ({info_b.period_start}–{info_b.period_end}) "
                    f"have overlapping periods",
                    run_id_a=run_id_a,
                    period_a=f"{info_a.period_start}/{info_a.period_end}",
                    run_id_b=run_id_b,
                    period_b=f"{info_b.period_start}/{info_b.period_end}",
                ))

    return HistoricalPass(
        findings=tuple(findings),
        historical_points=tuple(historical_points),
    )


def _periods_overlap(start_a: str, end_a: str, start_b: str, end_b: str) -> bool:
    """Two date periods overlap if neither ends strictly before the other starts.

    Periods are half-open [start, end) — the end date is exclusive. Two adjacent
    periods (one's end == the other's start) do NOT overlap.
    """
    # ISO date strings compare lexicographically.
    return start_a < end_b and start_b < end_a
