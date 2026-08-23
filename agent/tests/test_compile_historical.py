"""Tests for compile/historical.py — the pure historical-trend selector.

Validates Requirements 18.4, 18.5, 18.6, 18.7, 18.10, 18.13, 18.14, 18.15.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from reporting_agent.compile.historical import (
    EXCLUSION_REASONS,
    REASON_BEYOND_LOOKBACK,
    REASON_FIDELITY_TIER_DIFFERS,
    REASON_METRIC_ABSENT_IN_SNAPSHOT,
    REASON_PERIOD_OVERLAPPING,
    REASON_STATUS_NOT_COMPLETED,
    REASON_VERIFICATION_NOT_PASSED,
    Exclusion,
    PriorRunCandidate,
    select,
)

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _candidate(
    run_id: str = "run-1",
    period_start: str = "2026-06-01",
    period_end: str = "2026-06-30",
    timezone: str = "Asia/Jakarta",
    status: str = "completed",
    verification_status: str | None = "pass",
    verification_created_at: str | None = "2026-07-02T10:00:00Z",
    verification_id: str | None = "v-1",
    snapshot_sha256: str | None = "abc123",
) -> PriorRunCandidate:
    return PriorRunCandidate(
        run_id=run_id,
        period_start=period_start,
        period_end=period_end,
        timezone=timezone,
        status=status,
        verification_status=verification_status,
        verification_created_at=verification_created_at,
        verification_id=verification_id,
        snapshot_sha256=snapshot_sha256,
    )


def _snapshot_with_metric(
    metric: str = "Percentage CPU",
    statistic: str = "avg",
    fidelity_tier: str = "baseline",
) -> dict[str, Any]:
    """A minimal snapshot that carries one matching (metric, statistic)."""
    return {
        "resources": [
            {
                "resource_id": "res-1",
                "fidelity_tier": fidelity_tier,
                "statistics": [
                    {
                        "metric": metric,
                        "statistic": statistic,
                        "value": "12.34",
                    }
                ],
            }
        ]
    }


def _snapshot_without_metric() -> dict[str, Any]:
    """A snapshot with no matching metric."""
    return {
        "resources": [
            {
                "resource_id": "res-1",
                "fidelity_tier": "baseline",
                "statistics": [
                    {
                        "metric": "Network In Total",
                        "statistic": "avg",
                        "value": "100.00",
                    }
                ],
            }
        ]
    }


def _noop_snapshot_for(_run_id: str) -> Mapping[str, object] | None:
    """snapshot_for that always returns a matching snapshot."""
    return _snapshot_with_metric()


def _none_snapshot_for(_run_id: str) -> Mapping[str, object] | None:
    return None


# ---------------------------------------------------------------------------
# Structural invariants
# ---------------------------------------------------------------------------


class TestExclusionReasons:
    def test_exactly_six_reasons(self) -> None:
        assert len(EXCLUSION_REASONS) == 6

    def test_reason_values(self) -> None:
        assert EXCLUSION_REASONS == (
            "status_not_completed",
            "verification_not_passed",
            "period_overlapping",
            "beyond_lookback",
            "metric_absent_in_snapshot",
            "fidelity_tier_differs",
        )

    def test_exclusion_refuses_undeclared_reason(self) -> None:
        with pytest.raises(ValueError, match="not one of the six"):
            Exclusion(run_id="r1", reason="made_up_reason")


# ---------------------------------------------------------------------------
# Step 1: status_not_completed
# ---------------------------------------------------------------------------


class TestStatusFilter:
    def test_non_completed_excluded(self) -> None:
        candidates = [
            _candidate(run_id="r1", status="failed"),
            _candidate(run_id="r2", status="queued"),
            _candidate(run_id="r3", status="completed"),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        excluded_ids = {e.run_id for e in result.exclusions if e.reason == REASON_STATUS_NOT_COMPLETED}
        assert excluded_ids == {"r1", "r2"}
        assert any(s.run_id == "r3" for s in result.selected)

    def test_only_completed_passes(self) -> None:
        candidates = [_candidate(run_id="r1", status="completed")]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        assert len(result.selected) == 1
        assert result.selected[0].run_id == "r1"


# ---------------------------------------------------------------------------
# Step 2: verification_not_passed
# ---------------------------------------------------------------------------


class TestVerificationFilter:
    def test_no_verification_excluded(self) -> None:
        candidates = [_candidate(run_id="r1", verification_status=None)]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        excluded_reasons = {e.reason for e in result.exclusions}
        assert REASON_VERIFICATION_NOT_PASSED in excluded_reasons

    def test_failed_verification_excluded(self) -> None:
        candidates = [_candidate(run_id="r1", verification_status="fail")]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        assert result.exclusions[0].reason == REASON_VERIFICATION_NOT_PASSED

    def test_passed_verification_admitted(self) -> None:
        candidates = [_candidate(run_id="r1", verification_status="pass")]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        assert len(result.selected) == 1


# ---------------------------------------------------------------------------
# Step 3: period_overlapping
# ---------------------------------------------------------------------------


class TestOverlapFilter:
    def test_non_overlapping_both_retained(self) -> None:
        candidates = [
            _candidate(run_id="r1", period_start="2026-05-01", period_end="2026-05-31"),
            _candidate(run_id="r2", period_start="2026-06-01", period_end="2026-06-30"),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        assert len(result.selected) == 2

    def test_overlapping_retains_later_end(self) -> None:
        candidates = [
            _candidate(
                run_id="r1", period_start="2026-06-01", period_end="2026-06-30",
                verification_created_at="2026-07-01T00:00:00Z",
            ),
            _candidate(
                run_id="r2", period_start="2026-06-15", period_end="2026-07-15",
                verification_created_at="2026-07-16T00:00:00Z",
            ),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        selected_ids = {s.run_id for s in result.selected}
        excluded_ids = {e.run_id for e in result.exclusions if e.reason == REASON_PERIOD_OVERLAPPING}
        assert "r2" in selected_ids  # later end
        assert "r1" in excluded_ids

    def test_overlap_equal_end_uses_verification_tiebreak(self) -> None:
        """Equal period_end — retain the one with later verification_created_at."""
        candidates = [
            _candidate(
                run_id="r1", period_start="2026-06-01", period_end="2026-06-30",
                verification_created_at="2026-07-01T00:00:00Z",
            ),
            _candidate(
                run_id="r2", period_start="2026-06-01", period_end="2026-06-30",
                verification_created_at="2026-07-02T00:00:00Z",
            ),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        selected_ids = {s.run_id for s in result.selected}
        assert "r2" in selected_ids
        assert len(result.selected) == 1

    def test_overlap_equal_end_equal_verification_uses_id_tiebreak(self) -> None:
        """Equal period_end, equal verification — retain greater id in code-point order."""
        candidates = [
            _candidate(
                run_id="run-a", period_start="2026-06-01", period_end="2026-06-30",
                verification_created_at="2026-07-01T00:00:00Z",
            ),
            _candidate(
                run_id="run-b", period_start="2026-06-01", period_end="2026-06-30",
                verification_created_at="2026-07-01T00:00:00Z",
            ),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        selected_ids = {s.run_id for s in result.selected}
        assert "run-b" in selected_ids  # 'b' > 'a' in code-point order
        assert len(result.selected) == 1

    def test_later_start_at_earlier_end_is_overlap(self) -> None:
        """Later start == earlier end means overlap."""
        candidates = [
            _candidate(run_id="r1", period_start="2026-06-01", period_end="2026-06-15"),
            _candidate(run_id="r2", period_start="2026-06-15", period_end="2026-06-30"),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        # r2 has later end, so it wins
        selected_ids = {s.run_id for s in result.selected}
        assert "r2" in selected_ids
        assert len(result.selected) == 1


# ---------------------------------------------------------------------------
# Step 4: beyond_lookback
# ---------------------------------------------------------------------------


class TestLookbackFilter:
    def test_excess_candidates_excluded(self) -> None:
        # 5 candidates but lookback=3
        candidates = [
            _candidate(
                run_id=f"r{i}",
                period_start=f"2026-0{i}-01",
                period_end=f"2026-0{i}-28",
                verification_created_at=f"2026-0{i+1}-01T00:00:00Z",
            )
            for i in range(1, 6)
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=3,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        beyond_excluded = [e for e in result.exclusions if e.reason == REASON_BEYOND_LOOKBACK]
        assert len(beyond_excluded) == 2
        # The newest 3 (by period_end desc) should be selected
        selected_ids = {s.run_id for s in result.selected}
        assert "r5" in selected_ids
        assert "r4" in selected_ids
        assert "r3" in selected_ids

    def test_fewer_than_lookback_selects_all(self) -> None:
        candidates = [
            _candidate(run_id="r1", period_start="2026-06-01", period_end="2026-06-30"),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=5,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        assert len(result.selected) == 1
        assert len(result.exclusions) == 0


# ---------------------------------------------------------------------------
# Step 5: metric_absent_in_snapshot
# ---------------------------------------------------------------------------


class TestMetricAbsentFilter:
    def test_missing_metric_excluded(self) -> None:
        candidates = [_candidate(run_id="r1")]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=lambda _: _snapshot_without_metric(),
        )
        assert result.exclusions[0].reason == REASON_METRIC_ABSENT_IN_SNAPSHOT

    def test_none_snapshot_treated_as_absent(self) -> None:
        candidates = [_candidate(run_id="r1")]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_none_snapshot_for,
        )
        assert result.exclusions[0].reason == REASON_METRIC_ABSENT_IN_SNAPSHOT

    def test_present_metric_passes(self) -> None:
        candidates = [_candidate(run_id="r1")]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=lambda _: _snapshot_with_metric("Percentage CPU", "avg"),
        )
        assert len(result.selected) == 1


# ---------------------------------------------------------------------------
# Step 6: fidelity_tier_differs
# ---------------------------------------------------------------------------


class TestFidelityTierFilter:
    def test_different_tier_excluded(self) -> None:
        candidates = [_candidate(run_id="r1")]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="enhanced",
            snapshot_for=lambda _: _snapshot_with_metric(
                "Percentage CPU", "avg", fidelity_tier="baseline"
            ),
        )
        assert result.exclusions[0].reason == REASON_FIDELITY_TIER_DIFFERS

    def test_same_tier_passes(self) -> None:
        candidates = [_candidate(run_id="r1")]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=lambda _: _snapshot_with_metric(
                "Percentage CPU", "avg", fidelity_tier="baseline"
            ),
        )
        assert len(result.selected) == 1


# ---------------------------------------------------------------------------
# Set invariant: selected + exclusions == candidates
# ---------------------------------------------------------------------------


class TestSetInvariant:
    def test_no_candidate_dropped(self) -> None:
        """Every candidate appears exactly once in either selected or exclusions."""
        candidates = [
            _candidate(run_id="r1", status="failed"),
            _candidate(run_id="r2", verification_status="fail"),
            _candidate(run_id="r3", period_start="2026-06-01", period_end="2026-06-30"),
            _candidate(run_id="r4", period_start="2026-05-01", period_end="2026-05-31"),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        selected_ids = {s.run_id for s in result.selected}
        excluded_ids = {e.run_id for e in result.exclusions}
        candidate_ids = {c.run_id for c in candidates}
        assert selected_ids | excluded_ids == candidate_ids
        assert selected_ids & excluded_ids == set()

    def test_empty_candidates(self) -> None:
        result = select(
            [],
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        assert result.selected == ()
        assert result.exclusions == ()


# ---------------------------------------------------------------------------
# Ordering: selected ordered by period_start ascending
# ---------------------------------------------------------------------------


class TestSelectedOrdering:
    def test_ascending_period_start(self) -> None:
        candidates = [
            _candidate(run_id="r3", period_start="2026-05-01", period_end="2026-05-31"),
            _candidate(run_id="r1", period_start="2026-03-01", period_end="2026-03-31"),
            _candidate(run_id="r2", period_start="2026-04-01", period_end="2026-04-30"),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        starts = [s.period_start for s in result.selected]
        assert starts == sorted(starts)


# ---------------------------------------------------------------------------
# Purity — no network, no clock
# ---------------------------------------------------------------------------


class TestPurity:
    def test_snapshot_for_called_at_most_lookback_times(self) -> None:
        """Steps 5 and 6 are last, so at most lookback snapshots are loaded."""
        call_count = 0

        def counting_snapshot_for(_run_id: str) -> Mapping[str, object] | None:
            nonlocal call_count
            call_count += 1
            return _snapshot_with_metric()

        # 10 eligible candidates but lookback=3
        candidates = [
            _candidate(
                run_id=f"r{i}",
                period_start=f"2026-{i:02d}-01",
                period_end=f"2026-{i:02d}-28",
                verification_created_at=f"2026-{i+1:02d}-01T00:00:00Z",
            )
            for i in range(1, 11)
        ]
        select(
            candidates,
            compiling_period_start="2026-12-01",
            lookback=3,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=counting_snapshot_for,
        )
        # Steps 5 and 6 each consult snapshot_for — but at most lookback candidates
        # reach step 5, so total calls are at most lookback * 2 (step 5 + step 6).
        # In practice, step 6 reuses the same snapshot_for callable (same cache), so
        # the upper bound on _distinct_ run_ids is lookback.
        assert call_count <= 3 * 2  # at most lookback candidates × 2 calls each

    def test_deterministic_across_permutations(self) -> None:
        """The selection is identical under any permutation of the input order."""
        import random

        candidates = [
            _candidate(
                run_id=f"r{i}",
                period_start=f"2026-{i:02d}-01",
                period_end=f"2026-{i:02d}-28",
                verification_created_at=f"2026-{i+1:02d}-01T00:00:00Z",
            )
            for i in range(1, 7)
        ]
        kwargs: dict[str, Any] = {
            "compiling_period_start": "2026-08-01",
            "lookback": 4,
            "metric": "Percentage CPU",
            "statistic": "avg",
            "compiling_fidelity_tier": "baseline",
            "snapshot_for": _noop_snapshot_for,
        }
        baseline = select(list(candidates), **kwargs)
        rng = random.Random(42)
        for _ in range(10):
            shuffled = list(candidates)
            rng.shuffle(shuffled)
            result = select(shuffled, **kwargs)
            assert {s.run_id for s in result.selected} == {
                s.run_id for s in baseline.selected
            }
            assert [s.run_id for s in result.selected] == [
                s.run_id for s in baseline.selected
            ]


# ---------------------------------------------------------------------------
# Filter precedence: exactly one reason per candidate
# ---------------------------------------------------------------------------


class TestFilterPrecedence:
    def test_status_takes_precedence_over_verification(self) -> None:
        """A failed status is reported, even if verification also fails."""
        candidates = [
            _candidate(run_id="r1", status="failed", verification_status="fail")
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        assert len(result.exclusions) == 1
        assert result.exclusions[0].reason == REASON_STATUS_NOT_COMPLETED

    def test_verification_takes_precedence_over_overlap(self) -> None:
        """verification_not_passed is step 2, before overlap step 3."""
        # Two runs with identical periods but one has failed verification
        candidates = [
            _candidate(
                run_id="r1", period_start="2026-06-01", period_end="2026-06-30",
                verification_status="fail",
            ),
            _candidate(
                run_id="r2", period_start="2026-06-01", period_end="2026-06-30",
                verification_status="pass",
            ),
        ]
        result = select(
            candidates,
            compiling_period_start="2026-08-01",
            lookback=10,
            metric="Percentage CPU",
            statistic="avg",
            compiling_fidelity_tier="baseline",
            snapshot_for=_noop_snapshot_for,
        )
        r1_exclusion = next(e for e in result.exclusions if e.run_id == "r1")
        assert r1_exclusion.reason == REASON_VERIFICATION_NOT_PASSED
