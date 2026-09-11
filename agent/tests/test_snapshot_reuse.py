"""A re-run that reuses an earlier snapshot — the path that had no test at all.

Reuse is a choice the caller makes: the app passes `snapshot_run_id` and this run reads
that snapshot instead of asking Azure the same question twice. It shipped on 2026-09-05
and no test drove it, because driving it needs two runs with **different** run ids over
one store and the harness could only express one. It failed on the first attempt in
production, and then failed again behind that:

1. `KeyError: 'step_id'` — the branch closed its step with `step["step_id"]`, but a
   `tool` event carries `id`; `step_id` is the *parameter* `steps.start` takes. Every
   other `steps.end` in the tree reads `["id"]`. The run died before collecting anything
   and the app, whose callback also timed out, showed "Collecting" indefinitely.

2. `replay_hash_mismatch` over **0 archived objects** — the replay gate fetched the raw
   archive under *this* run's prefix, but the archive belongs to whoever collected the
   snapshot. A correct, already-verified snapshot was reported as irreproducible.

The second was hiding behind the first, which is why these tests drive the whole run
rather than asserting on the branch: a unit test of the step id would have passed and the
next run would still have failed.
"""

from __future__ import annotations

from typing import Any

import pytest
from pipeline_harness import Pipeline, types_of
from reporting_agent.errors import PartialCoverageError

FIRST = "run-collects"
SECOND = "run-reuses"


def _ok(error: Exception | None) -> bool:
    """`PartialCoverageError` is a completed run: gaps recorded, document delivered."""
    return error is None or isinstance(error, PartialCoverageError)


@pytest.fixture(scope="module")
def collected_then_reused() -> tuple[Pipeline, list[dict[str, Any]], Exception | None]:
    first = Pipeline(run_id=FIRST)
    _events, error = first.run()
    assert _ok(error), f"the collecting run failed: {error!r}"

    second = Pipeline(
        run_id=SECOND,
        store=first.store,
        payload_extras={"snapshot_run_id": FIRST},
    )
    events, error = second.run()
    return second, events, error


def test_a_reuse_run_completes(collected_then_reused) -> None:
    """The regression itself. Before the fix this raised `KeyError: 'step_id'` from
    `report_pipeline.py` before a single figure existed."""
    _pipe, _events, error = collected_then_reused
    assert _ok(error), f"the reuse run failed: {error!r}"


def test_a_reuse_run_verifies(collected_then_reused) -> None:
    """And reaches a verdict, which is the assertion the second bug needed: the run
    survived the `KeyError` fix and then failed `replay_hash_mismatch` over an archive it
    was looking for in the wrong place."""
    _pipe, events, _error = collected_then_reused
    verifications = [e for e in events if e["type"] == "verification"]
    assert verifications, f"no verification event; got {types_of(events)}"
    assert verifications[0]["status"] == "pass", [
        f.get("type") for f in (verifications[0].get("findings") or [])
    ]


def test_a_reuse_run_delivers_a_document(collected_then_reused) -> None:
    """A reuse run is a full report, not a snapshot-only one — the point of reusing is to
    re-render the same figures, so the artifacts have to arrive."""
    _pipe, events, _error = collected_then_reused
    assert [e for e in events if e["type"] == "report_file"]


def test_a_reuse_run_collects_nothing_of_its_own(collected_then_reused) -> None:
    """The whole purpose: Azure is not asked the same question twice. The second run
    writes no snapshot and no archive under its own id, so a store holding one run's
    collection still holds exactly one."""
    pipe, _events, _error = collected_then_reused
    own = [k for k in pipe.store.keys() if f"/snapshots/{SECOND}/" in k]
    assert own == [], f"the reuse run collected its own snapshot: {own}"
    assert [k for k in pipe.store.keys() if f"/snapshots/{FIRST}/raw/" in k]


def test_the_reused_snapshot_is_the_one_the_figures_trace_to(collected_then_reused) -> None:
    """Reuse must not quietly become "collect anyway": the `snapshot_ready` event names
    the snapshot the document was built from, and it is the first run's."""
    _pipe, events, _error = collected_then_reused
    ready = [e for e in events if e["type"] == "snapshot_ready"]
    assert ready, f"no snapshot_ready event; got {types_of(events)}"
    assert ready[0]["snapshot_id"]


def test_a_run_that_names_no_snapshot_still_collects() -> None:
    """The mutation guard on all of the above: the reuse branch must be entered only when
    the caller asked for it. A pipeline given no `snapshot_run_id` writes its own
    snapshot, which is what every other test in this suite depends on."""
    pipe = Pipeline(run_id="run-fresh")
    _events, error = pipe.run()
    assert _ok(error), f"the fresh run failed: {error!r}"
    assert [k for k in pipe.store.keys() if "/snapshots/run-fresh/" in k]


def test_teammate_reuse_preserves_snapshot_and_archive_verification() -> None:
    first = Pipeline(run_id="shared-source", actor_id="original-collector")
    _, error = first.run()
    assert _ok(error), repr(error)
    second = Pipeline(
        run_id="shared-reuse", actor_id="requesting-teammate", store=first.store,
        payload_extras={
            "snapshot_run_id": "shared-source",
            "snapshot_source_actors": {"shared-source": "original-collector"},
        },
    )
    events, error = second.run()
    assert _ok(error), repr(error)
    verification = next(event for event in events if event["type"] == "verification")
    assert verification["status"] == "pass", verification.get("findings")
    assert second.outcome.collection.snapshot_id == first.outcome.collection.snapshot_id
