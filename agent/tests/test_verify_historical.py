"""Tests for the ``historical`` verification gate (verify/historical.py).

Covers:
- No historical entries -> no findings, empty points.
- Unverified source run -> historical_point_unverified finding.
- Unknown source run (not in mapping) -> historical_point_unverified finding.
- Overlapping periods -> historical_point_overlapping finding.
- Adjacent (non-overlapping) periods -> no overlap finding.
- Historical points recorded on result.
- Multiple entries from same source run produce one point, one finding per entry.
"""

from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal
from collections.abc import Iterator

from reporting_agent.compile.ast import Figure, FigurePath, compiling_against
from reporting_agent.compile.figures import FigureLedger
from reporting_agent.compile.snapshot_view import SnapshotValue
from reporting_agent.verify.findings import (
    FINDING_HISTORICAL_POINT_OVERLAPPING,
    FINDING_HISTORICAL_POINT_UNVERIFIED,
    SEVERITY_BLOCKING,
)
from reporting_agent.verify.historical import (
    HistoricalPass,
    HistoricalRunInfo,
    check_historical,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _AnyResolver:
    """A resolver that resolves ANY pointer to a plausible SnapshotValue.
    
    Returns the value that the figure under construction expects, by storing what
    it should return for each pointer.
    """

    def __init__(self) -> None:
        self._values: dict[str, Decimal] = {}

    def set_value(self, pointer: str, value: Decimal) -> None:
        self._values[pointer] = value

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        val = self._values.get(raw_pointer, Decimal("42.50"))
        return (SnapshotValue(
            value=val,
            unit="percent",
            statistic="avg",
            estimator="",
            fidelity_tier="baseline",
            scale=2,
            metric="Percentage CPU",
            resource_id="vm-1",
            window="2026-06-01/2026-06-30",
            pointer=raw_pointer,
        ),)

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        return ()


_RESOLVER = _AnyResolver()


@contextmanager
def _compile_ctx() -> Iterator[None]:
    # Pre-register the normal figure's pointer with its expected value
    _RESOLVER.set_value("/resources/0/statistics/0/value", Decimal("10.00"))
    with compiling_against(_RESOLVER):  # type: ignore[arg-type]
        yield


def _make_ledger(*figures: Figure) -> FigureLedger:
    """Build a ledger with the given figures."""
    ledger = FigureLedger()
    for fig in figures:
        ledger.insert(fig)
    return ledger


def _historical_figure(path: str, run_id: str, snapshot_sha: str = "abc123") -> Figure:
    """A figure referencing a prior run. Must be built inside _compile_ctx."""
    return Figure(
        path=FigurePath(path),
        value="42.50",
        unit="percent",
        snapshot_path=f"/prior_runs/{run_id}/resources/0/statistics/0/value",
        formatted="42.5%",
        fidelity_tier="baseline",
        statistic="avg",
        metric="Percentage CPU",
        source_run_id=run_id,
        source_snapshot_sha256=snapshot_sha,
    )


def _normal_figure(path: str) -> Figure:
    """A figure from the current run. Must be built inside _compile_ctx."""
    return Figure(
        path=FigurePath(path),
        value="10.00",
        unit="percent",
        snapshot_path="/resources/0/statistics/0/value",
        formatted="10.0%",
        fidelity_tier="baseline",
        statistic="avg",
        metric="Percentage CPU",
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestNoHistoricalEntries:
    """When the ledger has no historical entries, the gate is clean."""

    def test_empty_ledger(self) -> None:
        ledger = FigureLedger()
        result = check_historical(ledger, historical={})
        assert result.findings == ()
        assert result.historical_points == ()

    def test_only_current_run_figures(self) -> None:
        with _compile_ctx():
            ledger = _make_ledger(
                _normal_figure("blk:0"),
                _normal_figure("blk:1"),
            )
        result = check_historical(ledger, historical={})
        assert result.findings == ()
        assert result.historical_points == ()


class TestUnverifiedFindings:
    """historical_point_unverified for entries whose source run is not 'pass'."""

    def test_source_run_not_pass(self) -> None:
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="fail",
                period_start="2026-06-01",
                period_end="2026-06-30",
            ),
        }
        result = check_historical(ledger, historical=historical)
        assert len(result.findings) == 1
        f = result.findings[0]
        assert f["type"] == FINDING_HISTORICAL_POINT_UNVERIFIED
        assert f["severity"] == SEVERITY_BLOCKING
        assert "run_A" in f["message"]
        assert f["run_id"] == "run_A"
        assert f["path"] == "hist:0.0.0"

    def test_source_run_not_in_mapping(self) -> None:
        """A run id not in the historical mapping is treated as unverified."""
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_X", "sha_X"),
            )
        result = check_historical(ledger, historical={})
        assert len(result.findings) == 1
        assert result.findings[0]["type"] == FINDING_HISTORICAL_POINT_UNVERIFIED
        assert result.findings[0]["run_id"] == "run_X"

    def test_verified_pass_produces_no_finding(self) -> None:
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-01",
                period_end="2026-06-30",
            ),
        }
        result = check_historical(ledger, historical=historical)
        assert result.findings == ()

    def test_multiple_entries_same_unverified_run(self) -> None:
        """Each entry produces its own finding, even if the run id repeats."""
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
                _historical_figure("hist:0.1.0", "run_A", "sha_A"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="fail",
                period_start="2026-06-01",
                period_end="2026-06-30",
            ),
        }
        result = check_historical(ledger, historical=historical)
        assert len(result.findings) == 2
        paths = {f["path"] for f in result.findings}
        assert paths == {"hist:0.0.0", "hist:0.1.0"}


class TestOverlappingFindings:
    """historical_point_overlapping for distinct runs with overlapping periods."""

    def test_overlapping_periods(self) -> None:
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
                _historical_figure("hist:0.1.0", "run_B", "sha_B"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-01",
                period_end="2026-06-30",
            ),
            "run_B": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-15",
                period_end="2026-07-15",
            ),
        }
        result = check_historical(ledger, historical=historical)
        overlap_findings = [
            f for f in result.findings
            if f["type"] == FINDING_HISTORICAL_POINT_OVERLAPPING
        ]
        assert len(overlap_findings) == 1
        f = overlap_findings[0]
        assert f["severity"] == SEVERITY_BLOCKING
        assert "run_A" in f["message"]
        assert "run_B" in f["message"]

    def test_adjacent_periods_no_overlap(self) -> None:
        """Adjacent periods [June 1-July 1) and [July 1-Aug 1) do NOT overlap."""
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
                _historical_figure("hist:0.1.0", "run_B", "sha_B"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-01",
                period_end="2026-07-01",
            ),
            "run_B": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-07-01",
                period_end="2026-08-01",
            ),
        }
        result = check_historical(ledger, historical=historical)
        assert result.findings == ()

    def test_identical_periods_overlap(self) -> None:
        """Identical periods are overlapping."""
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
                _historical_figure("hist:0.1.0", "run_B", "sha_B"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-01",
                period_end="2026-06-30",
            ),
            "run_B": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-01",
                period_end="2026-06-30",
            ),
        }
        result = check_historical(ledger, historical=historical)
        overlap_findings = [
            f for f in result.findings
            if f["type"] == FINDING_HISTORICAL_POINT_OVERLAPPING
        ]
        assert len(overlap_findings) == 1


class TestHistoricalPointsRecorded:
    """The result records historical_points for traceability."""

    def test_one_run_one_point(self) -> None:
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-01",
                period_end="2026-06-30",
            ),
        }
        result = check_historical(ledger, historical=historical)
        assert len(result.historical_points) == 1
        assert result.historical_points[0] == {
            "run_id": "run_A",
            "snapshot_sha256": "sha_A",
        }

    def test_multiple_entries_same_run_one_point(self) -> None:
        """Multiple figures from the same run produce one historical point."""
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
                _historical_figure("hist:0.1.0", "run_A", "sha_A"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-01",
                period_end="2026-06-30",
            ),
        }
        result = check_historical(ledger, historical=historical)
        assert len(result.historical_points) == 1

    def test_two_distinct_runs_two_points(self) -> None:
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
                _historical_figure("hist:0.1.0", "run_B", "sha_B"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-05-01",
                period_end="2026-06-01",
            ),
            "run_B": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-01",
                period_end="2026-07-01",
            ),
        }
        result = check_historical(ledger, historical=historical)
        assert len(result.historical_points) == 2
        ids = {p["run_id"] for p in result.historical_points}
        assert ids == {"run_A", "run_B"}

    def test_no_historical_entries_empty_points(self) -> None:
        """Non-historical figures produce no points."""
        with _compile_ctx():
            ledger = _make_ledger(_normal_figure("blk:0"))
        result = check_historical(ledger, historical={})
        assert result.historical_points == ()


class TestIntegrationShape:
    """The gate returns the correct shape for use by the verifier."""

    def test_check_historical_returns_historical_pass(self) -> None:
        with _compile_ctx():
            ledger = _make_ledger(
                _historical_figure("hist:0.0.0", "run_A", "sha_A"),
            )
        historical = {
            "run_A": HistoricalRunInfo(
                verification_status="pass",
                period_start="2026-06-01",
                period_end="2026-06-30",
            ),
        }
        result = check_historical(ledger, historical=historical)
        assert isinstance(result, HistoricalPass)
        assert result.findings == ()
        assert result.historical_points == ({"run_id": "run_A", "snapshot_sha256": "sha_A"},)
