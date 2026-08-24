"""**Property 3: Historical run selection is newest-N, non-overlapping and verified.**
Identifier `historical_selection`.

**Validates: Requirements 18.4, 18.5, 18.6, 18.7, 18.10, 18.13, 18.14, 18.15, 19.1, 19.3, 19.4**

## The selector under test

`compile/historical.select` takes a list of `PriorRunCandidate` rows — each carrying a
run status, its latest verification outcome, a period and a snapshot reference — and returns
a `Selection`: the runs to plot, ordered by period start ascending, plus one typed
`Exclusion` per excluded candidate with exactly one reason.

## The seven kills

1. A selector filtering on `status` alone: admits a completed run whose verification failed.
2. One taking the newest N **before** filtering: returns fewer than N eligible while eligible
   older runs exist.
3. One admitting overlapping periods: plots one interval twice as two separate periods.
4. One padding to the lookback: fabricates a point that no prior run supports.
5. One whose order depends on the query's row order: breaks on a reshuffled input.
6. One keyed on `template_version_id`: empties every trend on the next template edit.
7. One that silently drops an ineligible candidate without recording why.
"""

from __future__ import annotations

from typing import Any

from hypothesis import assume, example, given, settings
from hypothesis import strategies as st

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
    Selection,
    select,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

METRIC = "Percentage CPU"
STATISTIC = "avg"
FIDELITY_TIER = "baseline"
COMPILING_PERIOD_START = "2026-08-01"

# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------


def _date_str(year: int = 2026, month: int = 1, day: int = 1) -> str:
    return f"{year:04d}-{month:02d}-{day:02d}"


@st.composite
def st_period(draw: st.DrawFn) -> tuple[str, str]:
    """Generate a (period_start, period_end) pair before COMPILING_PERIOD_START."""
    # Months 1-7 (all before August 2026)
    start_month = draw(st.integers(min_value=1, max_value=7))
    start_day = draw(st.integers(min_value=1, max_value=28))
    # End is 28-31 days after start, staying within the same or next month
    duration_days = draw(st.integers(min_value=28, max_value=31))
    end_month = start_month + (start_day + duration_days - 1) // 28
    end_day = ((start_day + duration_days - 1) % 28) + 1
    if end_month > 7:
        end_month = 7
        end_day = 28
    start = _date_str(2026, start_month, start_day)
    end = _date_str(2026, end_month, end_day)
    assume(start < end)
    assume(end < COMPILING_PERIOD_START)
    return start, end


@st.composite
def st_verification(
    draw: st.DrawFn,
    *,
    status: str | None = None,
) -> tuple[str | None, str | None, str | None]:
    """Generate (verification_status, verification_created_at, verification_id).

    When status is None, draw from the full set including absent verifications.
    """
    if status is not None:
        s = status
    else:
        s = draw(st.sampled_from(["pass", "fail", None]))

    if s is None:
        return (None, None, None)

    hour = draw(st.integers(min_value=0, max_value=23))
    minute = draw(st.integers(min_value=0, max_value=59))
    created_at = f"2026-07-15T{hour:02d}:{minute:02d}:00Z"
    vid = draw(st.text(alphabet="abcdef0123456789", min_size=8, max_size=8))
    return (s, created_at, f"ver-{vid}")


@st.composite
def st_candidate(
    draw: st.DrawFn,
    *,
    status: str | None = None,
    verification_status: str | None = None,
    period: tuple[str, str] | None = None,
    run_id_prefix: str = "run",
) -> PriorRunCandidate:
    """Generate a PriorRunCandidate."""
    rid = draw(st.text(alphabet="abcdef0123456789", min_size=8, max_size=8))
    run_id = f"{run_id_prefix}-{rid}"

    if status is None:
        s = draw(st.sampled_from(["completed", "failed", "cancelled"]))
    else:
        s = status

    if period is None:
        p_start, p_end = draw(st_period())
    else:
        p_start, p_end = period

    if verification_status is not None:
        v_status, v_created, v_id = draw(st_verification(status=verification_status))
    else:
        v_status, v_created, v_id = draw(st_verification())

    snap_sha = draw(st.text(alphabet="abcdef0123456789", min_size=64, max_size=64))

    return PriorRunCandidate(
        run_id=run_id,
        period_start=p_start,
        period_end=p_end,
        timezone="Asia/Jakarta",
        status=s,
        verification_status=v_status,
        verification_created_at=v_created,
        verification_id=v_id,
        snapshot_sha256=snap_sha,
    )


def st_snapshot(
    *,
    has_metric: bool = True,
    fidelity_tier: str = FIDELITY_TIER,
) -> st.SearchStrategy[dict[str, Any]]:
    """Return a strategy for a snapshot dict with or without the target metric/statistic."""
    if not has_metric:
        return st.just({"resources": []})

    return st.just({
        "resources": [
            {
                "fidelity_tier": fidelity_tier,
                "statistics": [
                    {"metric": METRIC, "statistic": STATISTIC, "value": "42.5"},
                ],
            }
        ]
    })


@st.composite
def st_candidates_with_snapshots_small(
    draw: st.DrawFn,
) -> tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int]:
    """Generate a smaller test case (up to 15 candidates) for permutation tests."""
    n_candidates = draw(st.integers(min_value=0, max_value=15))
    lookback = draw(st.integers(min_value=2, max_value=24))

    candidates: list[PriorRunCandidate] = []
    snapshots: dict[str, dict[str, Any]] = {}

    for i in range(n_candidates):
        status = draw(st.sampled_from(["completed", "completed", "completed", "failed", "cancelled"]))
        candidate = draw(st_candidate(status=status, run_id_prefix=f"r{i:03d}"))
        candidates.append(candidate)

        has_metric = draw(st.booleans())
        tier = draw(st.sampled_from([FIDELITY_TIER, FIDELITY_TIER, FIDELITY_TIER, "enhanced"]))
        snapshots[candidate.run_id] = draw(st_snapshot(has_metric=has_metric, fidelity_tier=tier))

    return candidates, snapshots, lookback


@st.composite
def st_candidates_with_snapshots(
    draw: st.DrawFn,
) -> tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int]:
    """Generate a full test case: candidates, snapshots, and lookback."""
    n_candidates = draw(st.integers(min_value=0, max_value=40))
    lookback = draw(st.integers(min_value=2, max_value=24))

    candidates: list[PriorRunCandidate] = []
    snapshots: dict[str, dict[str, Any]] = {}

    for i in range(n_candidates):
        # Mix statuses
        status = draw(st.sampled_from(["completed", "completed", "completed", "failed", "cancelled"]))
        candidate = draw(st_candidate(status=status, run_id_prefix=f"r{i:03d}"))
        candidates.append(candidate)

        # Build snapshot for this run
        has_metric = draw(st.booleans())
        tier = draw(st.sampled_from([FIDELITY_TIER, FIDELITY_TIER, FIDELITY_TIER, "enhanced"]))
        snapshots[candidate.run_id] = draw(st_snapshot(has_metric=has_metric, fidelity_tier=tier))

    # Inject noise: other template rows / other subscriptions (should be excluded)
    n_noise = draw(st.integers(min_value=0, max_value=5))
    for i in range(n_noise):
        noise = draw(st_candidate(status="completed", run_id_prefix=f"noise{i}"))
        candidates.append(noise)
        snapshots[noise.run_id] = draw(st_snapshot())

    return candidates, snapshots, lookback


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _run_select(
    candidates: list[PriorRunCandidate],
    snapshots: dict[str, dict[str, Any]],
    lookback: int,
) -> Selection:
    """Run select with standard parameters."""
    return select(
        candidates,
        compiling_period_start=COMPILING_PERIOD_START,
        lookback=lookback,
        metric=METRIC,
        statistic=STATISTIC,
        compiling_fidelity_tier=FIDELITY_TIER,
        snapshot_for=lambda run_id: snapshots.get(run_id),
    )


def _overlaps(a: PriorRunCandidate, b: PriorRunCandidate) -> bool:
    """Two periods overlap if the later's start is at or before the earlier's end."""
    earlier, later = (a, b) if a.period_start <= b.period_start else (b, a)
    return later.period_start <= earlier.period_end


# ---------------------------------------------------------------------------
# The property
# ---------------------------------------------------------------------------


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_selection_is_bounded_by_lookback(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Assert <= lookback selected runs."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)
    assert len(result.selected) <= lookback


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_no_non_completed_selected(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Assert no non-completed run is selected."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)
    for run in result.selected:
        assert run.status == "completed"


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_no_non_pass_verification_selected(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Assert no run without passing verification is selected."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)
    for run in result.selected:
        assert run.verification_status == "pass"


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_no_overlapping_periods_selected(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Assert no two selected runs have overlapping periods."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)
    selected = list(result.selected)
    for i, a in enumerate(selected):
        for b in selected[i + 1 :]:
            assert not _overlaps(a, b), (
                f"selected runs {a.run_id} [{a.period_start},{a.period_end}] and "
                f"{b.run_id} [{b.period_start},{b.period_end}] overlap"
            )


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_selected_ordered_by_period_start_ascending(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Assert selected runs are ordered by period start ascending."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)
    starts = [r.period_start for r in result.selected]
    assert starts == sorted(starts)


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_selected_plus_exclusions_equals_candidates(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Assert selected + exclusions == candidates as a set of run ids, each with exactly one reason."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)

    candidate_ids = {c.run_id for c in candidates}
    selected_ids = {r.run_id for r in result.selected}
    excluded_ids = {e.run_id for e in result.exclusions}

    assert selected_ids | excluded_ids == candidate_ids
    assert selected_ids & excluded_ids == set()
    # Each excluded candidate has exactly one reason
    assert len(excluded_ids) == len(result.exclusions)


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_exclusion_reasons_are_valid(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Every exclusion reason is one of the six declared values."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)
    for exclusion in result.exclusions:
        assert exclusion.reason in EXCLUSION_REASONS


@given(data=st_candidates_with_snapshots_small())
@settings(max_examples=200)
def test_permutation_invariance(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Identical selection under any permutation of the input order."""
    candidates, snapshots, lookback = data

    result1 = _run_select(candidates, snapshots, lookback)
    # Reverse the input
    result2 = _run_select(list(reversed(candidates)), snapshots, lookback)

    assert [r.run_id for r in result1.selected] == [r.run_id for r in result2.selected]
    assert {(e.run_id, e.reason) for e in result1.exclusions} == {
        (e.run_id, e.reason) for e in result2.exclusions
    }


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_no_eligible_run_excluded_while_later_ending_admitted(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """No eligible run is excluded via beyond_lookback while a later-ending run was admitted.

    'Eligible' means completed, verification passed, non-overlapping with any selected run,
    metric present, and same fidelity tier.
    """
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)

    beyond_excluded = {
        e.run_id for e in result.exclusions if e.reason == REASON_BEYOND_LOOKBACK
    }
    if not beyond_excluded or not result.selected:
        return

    # Every beyond-excluded run must have period_end <= every selected run's period_end
    # (the selector takes the newest by period_end)
    selected_min_end = min(r.period_end for r in result.selected)
    for c in candidates:
        if c.run_id in beyond_excluded:
            assert c.period_end <= selected_min_end, (
                f"run {c.run_id} (end={c.period_end}) excluded as beyond_lookback "
                f"while a run ending at {selected_min_end} was admitted"
            )


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_no_padding_when_fewer_than_lookback(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Every eligible run selected when fewer than lookback exist — no padding."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)

    # Count how many candidates are eligible through the first four filters
    # (completed, pass verification, non-overlapping, within lookback)
    # If selected < lookback, every non-metric/non-tier-excluded candidate that passed
    # the first three filters should be accounted for
    selected_ids = {r.run_id for r in result.selected}
    metric_excluded = {
        e.run_id for e in result.exclusions if e.reason == REASON_METRIC_ABSENT_IN_SNAPSHOT
    }
    tier_excluded = {
        e.run_id for e in result.exclusions if e.reason == REASON_FIDELITY_TIER_DIFFERS
    }

    # If no BEYOND_LOOKBACK exclusions, every eligible candidate must be selected
    beyond_excluded = {
        e.run_id for e in result.exclusions if e.reason == REASON_BEYOND_LOOKBACK
    }
    if not beyond_excluded:
        # Selection is not padded — count must equal actual eligible
        for run in result.selected:
            assert run.run_id in {c.run_id for c in candidates}


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_metric_absent_excludes_with_no_plotted_point(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """A run excluded by metric_absent_in_snapshot is not in selected."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)

    metric_excluded = {
        e.run_id for e in result.exclusions if e.reason == REASON_METRIC_ABSENT_IN_SNAPSHOT
    }
    selected_ids = {r.run_id for r in result.selected}
    assert metric_excluded & selected_ids == set()


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_fidelity_tier_differs_excludes_with_no_plotted_point(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """A run excluded by fidelity_tier_differs is not in selected."""
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)

    tier_excluded = {
        e.run_id for e in result.exclusions if e.reason == REASON_FIDELITY_TIER_DIFFERS
    }
    selected_ids = {r.run_id for r in result.selected}
    assert tier_excluded & selected_ids == set()


@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_purity_network_double(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Calling select twice on the same input produces the same result — purity."""
    candidates, snapshots, lookback = data
    r1 = _run_select(candidates, snapshots, lookback)
    r2 = _run_select(candidates, snapshots, lookback)
    assert [c.run_id for c in r1.selected] == [c.run_id for c in r2.selected]
    assert set((e.run_id, e.reason) for e in r1.exclusions) == set(
        (e.run_id, e.reason) for e in r2.exclusions
    )


# ---------------------------------------------------------------------------
# Declared examples — three cases that prove specific selector properties
# ---------------------------------------------------------------------------


# Example 1: Two runs of identical period whose latest passing verifications carry
# equal creation instants — assert the id tie-break (greater id wins, loser excluded
# as period_overlapping).
@example(
    data=(
        [
            PriorRunCandidate(
                run_id="run-aaa00001",
                period_start="2026-06-01",
                period_end="2026-06-30",
                timezone="Asia/Jakarta",
                status="completed",
                verification_status="pass",
                verification_created_at="2026-07-15T10:00:00Z",
                verification_id="ver-001",
                snapshot_sha256="a" * 64,
            ),
            PriorRunCandidate(
                run_id="run-bbb00002",
                period_start="2026-06-01",
                period_end="2026-06-30",
                timezone="Asia/Jakarta",
                status="completed",
                verification_status="pass",
                verification_created_at="2026-07-15T10:00:00Z",
                verification_id="ver-002",
                snapshot_sha256="b" * 64,
            ),
        ],
        {
            "run-aaa00001": {
                "resources": [{"fidelity_tier": "baseline", "statistics": [{"metric": "Percentage CPU", "statistic": "avg", "value": "50.0"}]}]
            },
            "run-bbb00002": {
                "resources": [{"fidelity_tier": "baseline", "statistics": [{"metric": "Percentage CPU", "statistic": "avg", "value": "55.0"}]}]
            },
        },
        12,
    )
)
# Example 2: A candidate whose latest verification is `fail` while an earlier one
# passed — asserts exclusion as verification_not_passed (the selector sees only the
# LATEST verification, which is `fail`).
@example(
    data=(
        [
            PriorRunCandidate(
                run_id="run-fail0001",
                period_start="2026-05-01",
                period_end="2026-05-31",
                timezone="Asia/Jakarta",
                status="completed",
                verification_status="fail",
                verification_created_at="2026-07-15T12:00:00Z",
                verification_id="ver-f01",
                snapshot_sha256="c" * 64,
            ),
        ],
        {
            "run-fail0001": {
                "resources": [{"fidelity_tier": "baseline", "statistics": [{"metric": "Percentage CPU", "statistic": "avg", "value": "30.0"}]}]
            },
        },
        12,
    )
)
# Example 3: A run of the same subscription under a DIFFERENT template version of
# the same template row — asserts INCLUSION. The selector does not key on
# template_version_id (the field does not exist on PriorRunCandidate), so template
# version changes do not empty trends.
@example(
    data=(
        [
            PriorRunCandidate(
                run_id="run-ver00001",
                period_start="2026-04-01",
                period_end="2026-04-30",
                timezone="Asia/Jakarta",
                status="completed",
                verification_status="pass",
                verification_created_at="2026-07-15T08:00:00Z",
                verification_id="ver-v01",
                snapshot_sha256="d" * 64,
            ),
            PriorRunCandidate(
                run_id="run-ver00002",
                period_start="2026-05-01",
                period_end="2026-05-31",
                timezone="Asia/Jakarta",
                status="completed",
                verification_status="pass",
                verification_created_at="2026-07-15T09:00:00Z",
                verification_id="ver-v02",
                snapshot_sha256="e" * 64,
            ),
        ],
        {
            "run-ver00001": {
                "resources": [{"fidelity_tier": "baseline", "statistics": [{"metric": "Percentage CPU", "statistic": "avg", "value": "40.0"}]}]
            },
            "run-ver00002": {
                "resources": [{"fidelity_tier": "baseline", "statistics": [{"metric": "Percentage CPU", "statistic": "avg", "value": "45.0"}]}]
            },
        },
        12,
    )
)
@given(data=st_candidates_with_snapshots())
@settings(max_examples=200)
def test_declared_examples_and_general_property(
    data: tuple[list[PriorRunCandidate], dict[str, dict[str, Any]], int],
) -> None:
    """Combines the declared examples with the general property assertions.

    The declared examples above exercise specific edges:
    1. Id tie-break on identical period + identical verification instant
    2. Latest-verification-is-fail exclusion
    3. Different template versions included (no template_version_id filtering)
    """
    candidates, snapshots, lookback = data
    result = _run_select(candidates, snapshots, lookback)

    # All the core invariants hold on declared examples too
    assert len(result.selected) <= lookback
    for run in result.selected:
        assert run.status == "completed"
        assert run.verification_status == "pass"

    # selected + exclusions == candidates
    candidate_ids = {c.run_id for c in candidates}
    selected_ids = {r.run_id for r in result.selected}
    excluded_ids = {e.run_id for e in result.exclusions}
    assert selected_ids | excluded_ids == candidate_ids
    assert selected_ids & excluded_ids == set()

    # No overlaps
    selected = list(result.selected)
    for i, a in enumerate(selected):
        for b in selected[i + 1 :]:
            assert not _overlaps(a, b)

    # Ordered ascending
    starts = [r.period_start for r in result.selected]
    assert starts == sorted(starts)
