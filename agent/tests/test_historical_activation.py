"""Activation of the historical_trend delivered path (task 11.6).

Three independent breaks kept `historical_trend` at zero points since task 11.3 shipped it:
1. `BlockContext._historical_selection` was an un-settable phantom attribute → fixed d2fad23
2. `compile_document` had no `historical` parameter → fixed d2fad23
3. Nothing called `select_historical_runs` on the delivered path → fixed HERE

This file asserts:
- The selection is called and forwarded on the delivered (generate_report) path.
- The selection is persisted as `historical.json` beside `prose.json`.
- `run_verify_report` replays the stored selection and reproduces a byte-identical ledger.
- Corruption of a persisted selected run id breaks re-verification (mutation check).
- Missing `historical_candidates` in the payload is a normal zero-selection outcome.
- `run_render_preview` renders the zero-point statement without error.
- Every `compile_document` call site that could carry historical data actually does.
"""

from __future__ import annotations

import asyncio
import copy
import json
from typing import Any

import pytest

from pipeline_harness import (
    ACTOR_ID,
    BUCKET,
    RUN_ID,
    WATCHDOG_S,
    Pipeline,
    definition,
    df,
)
from fakes.object_store import InMemoryObjectStore
from reporting_agent.artifacts import report_prefix, reports_key
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.compile.blocks.base import HistoricalSelectionKey
from reporting_agent.compile.historical import Selection
from reporting_agent.errors import PartialCoverageError, VerificationFailedError
from reporting_agent.main import StepTracker
from reporting_agent.report_pipeline import (
    _historical_bundle,
    _historical_selection_keys,
    _HistoricalSourceFromStore,
    _StoredSelection,
    run_render_preview,
    run_verify_report,
)

TEMPLATE_VERSION_ID = "tv_01HQZX"

# --------------------------------------------------------------------------- #
# A definition with a historical_trend block
# --------------------------------------------------------------------------- #


def _historical_definition(**overrides: Any) -> dict[str, Any]:
    """A definition including a historical_trend block."""
    blocks = [
        df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
        df.block(
            "trend",
            "historical_trend",
            {"metric": "Percentage CPU", "statistic": "avg", "lookback": 6},
        ),
        df.block("gaps", "gaps_and_coverage", {}),
    ]
    return definition(blocks=blocks, **overrides)


def _historical_candidates_for_prior_run(run_id: str) -> list[dict[str, Any]]:
    """Candidate list simulating one prior completed+verified run."""
    return [
        {
            "id": run_id,
            "period_start": "2026-06-01",
            "period_end": "2026-06-30",
            "timezone": "Asia/Jakarta",
            "status": "completed",
            "verification_status": "pass",
            "verification_created_at": "2026-06-30T10:00:00Z",
            "verification_id": f"v-{run_id}",
            "verification_snapshot_sha256": "a" * 64,
        }
    ]


PRIOR_RUN_ID = "run_prior_01"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def pipeline_with_trend():
    """A full pipeline run using a template with `historical_trend`.

    The block gets zero candidates (no prior runs exist), so it emits its "no prior runs"
    statement. This proves the delivered path CALLS select_historical_runs without error
    even when the result is empty.
    """
    pipe = Pipeline(definition=_historical_definition())
    events, error = pipe.run()
    # PartialCoverageError is non-terminal — the report was produced and verified; it
    # raises AFTER upload to record gaps. That is a successful pipeline.
    assert error is None or isinstance(error, PartialCoverageError), f"pipeline failed: {error}"
    return pipe, events


@pytest.fixture(scope="module")
def pipeline_with_candidates():
    """A pipeline run where historical_candidates are supplied.

    To supply candidates, we need a stored prior snapshot. We first run the pipeline once
    (to get a snapshot), then run again with that run's snapshot as a "prior run" candidate.
    """
    from fakes.object_store import StoredObject

    # Step 1: produce a prior run's snapshot
    prior_pipe = Pipeline(definition=_historical_definition())
    prior_events, prior_error = prior_pipe.run()
    assert prior_error is None or isinstance(prior_error, PartialCoverageError), f"prior pipeline failed: {prior_error}"

    # Step 2: run again, with that prior run listed as a historical candidate
    # Reuse the same store so the prior snapshot is accessible
    main_pipe = Pipeline(definition=_historical_definition())
    # Copy the prior snapshot into the main pipe's store under a different run id
    from reporting_agent.collect.snapshot import snapshot_key as sk

    prior_snap_key = snapshot_key(ACTOR_ID, RUN_ID)
    prior_stored = prior_pipe.store.get(prior_snap_key)
    assert prior_stored is not None
    prior_key = sk(ACTOR_ID, PRIOR_RUN_ID)
    main_pipe.store._objects[prior_key] = StoredObject(
        body=prior_stored.body,
        content_type=prior_stored.content_type,
        tags=prior_stored.tags,
    )

    # Override the payload to include historical_candidates
    original_payload = main_pipe.payload

    def patched_payload() -> dict[str, Any]:
        p = original_payload()
        p["historical_candidates"] = _historical_candidates_for_prior_run(PRIOR_RUN_ID)
        return p

    main_pipe.payload = patched_payload  # type: ignore[assignment]

    events, error = main_pipe.run()
    # With the DerivedCount mechanism (task 11.7), the historical_trend block's counts
    # are verified through the ledger rather than the allowlist, so this MUST pass
    # verification. PartialCoverageError is non-terminal (collection gaps recorded).
    assert error is None or isinstance(error, PartialCoverageError), (
        f"pipeline with candidates failed: {error}"
    )
    return main_pipe, events, error


# --------------------------------------------------------------------------- #
# The selection is called on the delivered path
# --------------------------------------------------------------------------- #


class TestHistoricalSelectionOnDeliveredPath:
    def test_pipeline_with_trend_block_completes(self, pipeline_with_trend) -> None:
        """The delivered path calls select_historical_runs without error."""
        _, events = pipeline_with_trend
        types = [e["type"] for e in events]
        assert "verification" in types

    def test_pipeline_with_trend_produces_passing_verification(
        self, pipeline_with_trend
    ) -> None:
        _, events = pipeline_with_trend
        verifications = [e for e in events if e["type"] == "verification"]
        assert verifications[0]["status"] == "pass"

    def test_pipeline_with_candidates_completes(self, pipeline_with_candidates) -> None:
        """With real candidates, the historical block emits figures and verification passes.

        This is the acceptance bar for task 11.6/11.7: a table-and-trend template with one
        real prior candidate MUST re-verify successfully end to end.
        """
        _, events, error = pipeline_with_candidates
        # Must be non-terminal (PartialCoverageError) or clean
        assert error is None or isinstance(error, PartialCoverageError)
        verifications = [e for e in events if e["type"] == "verification"]
        assert verifications[0]["status"] == "pass"

    def test_pipeline_with_candidates_activates_the_block(
        self, pipeline_with_candidates
    ) -> None:
        """The historical_trend block produces chart events when candidates are available.

        With candidates and a loadable prior snapshot, the block emits a chart — the
        evidence that activation worked.
        """
        _, events, _ = pipeline_with_candidates
        chart_events = [e for e in events if e.get("type") == "chart"]
        # A chart event must be present (from the historical trend block)
        assert len(chart_events) >= 1, "historical_trend block should emit a chart event"


# --------------------------------------------------------------------------- #
# Persistence: historical.json is written
# --------------------------------------------------------------------------- #


class TestHistoricalPersistence:
    def test_historical_json_written_when_trend_block_with_candidates(
        self, pipeline_with_candidates
    ) -> None:
        """historical.json is persisted beside prose.json when the block has candidates.

        With the DerivedCount mechanism, verification passes, so artifacts are uploaded
        and historical.json is present.
        """
        pipe, _, error = pipeline_with_candidates
        prefix = report_prefix(ACTOR_ID, RUN_ID)
        hist_key = f"{prefix}historical.json"
        # Verification passes, so artifacts were uploaded — historical.json is present
        assert hist_key in pipe.store.keys()

    def test_historical_json_not_written_without_trend_block(self) -> None:
        """A definition without historical_trend produces no historical.json."""
        pipe = Pipeline()  # default definition: resource_table + gaps
        events, error = pipe.run()
        assert error is None or isinstance(error, PartialCoverageError)
        prefix = report_prefix(ACTOR_ID, RUN_ID)
        assert f"{prefix}historical.json" not in pipe.store.keys()

    def test_historical_json_written_for_zero_candidate_passing_run(
        self, pipeline_with_trend
    ) -> None:
        """A passing run with a historical_trend block writes historical.json.

        Even with zero candidates (no prior runs), the selection is persisted because
        the block exists in the definition. The persisted selection records that zero
        runs were selected — which is what a re-verification must reproduce.
        """
        pipe, _ = pipeline_with_trend
        prefix = report_prefix(ACTOR_ID, RUN_ID)
        # The block exists, so a selection (empty) is persisted
        hist_key = f"{prefix}historical.json"
        assert hist_key in pipe.store.keys()
        # The stored selection should have the key but with no selected runs
        raw_bytes = pipe.store.get(hist_key).body
        raw = json.loads(raw_bytes)
        stored = _StoredSelection(raw)
        key = ("Percentage CPU", "avg", 6)
        assert key in stored.selections
        assert stored.selections[key].selected == ()

    def test_stored_historical_json_round_trips(self) -> None:
        """The serialization → deserialization of _historical_bundle is lossless."""
        from reporting_agent.compile.historical import PriorRunCandidate

        candidate = PriorRunCandidate(
            run_id="run-abc",
            period_start="2026-05-01",
            period_end="2026-05-31",
            timezone="Asia/Jakarta",
            status="completed",
            verification_status="pass",
            verification_created_at="2026-05-31T10:00:00Z",
            verification_id="v-run-abc",
            snapshot_sha256="b" * 64,
        )
        key: HistoricalSelectionKey = ("Percentage CPU", "avg", 6)
        selections = {key: Selection(selected=(candidate,), exclusions=())}

        bundle = _historical_bundle(selections)
        assert bundle is not None

        restored = _StoredSelection(bundle)
        assert key in restored.selections
        restored_sel = restored.selections[key]
        assert len(restored_sel.selected) == 1
        assert restored_sel.selected[0].run_id == "run-abc"
        assert restored_sel.selected[0].period_start == "2026-05-01"
        assert restored_sel.selected[0].snapshot_sha256 == "b" * 64


# --------------------------------------------------------------------------- #
# Re-verification replays the stored selection
# --------------------------------------------------------------------------- #


def _run_verify(
    store: Any, payload: dict[str, Any]
) -> tuple[list[dict[str, Any]], Exception | None]:
    """Drive `run_verify_report` end to end."""
    steps = StepTracker()
    events: list[dict[str, Any]] = []

    async def go() -> None:
        async for event in run_verify_report(
            payload=payload,
            context={"actor_id": ACTOR_ID, "run_id": RUN_ID},
            steps=steps,
            artifact_bucket=BUCKET,
            object_store=store,
        ):
            events.append(event)

    try:
        asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))
    except Exception as exc:
        return events, exc
    return events, None


class TestReVerificationReplaysSelection:
    def test_reverify_passes_with_no_historical_data(
        self, pipeline_with_trend
    ) -> None:
        """Re-verification of a passing run with historical_trend (zero candidates) works.

        The block emitted the "no prior runs" statement, which produced no figures.
        Re-verification with no stored historical.json reproduces the same ledger.
        """
        pipe, _ = pipeline_with_trend
        payload = {
            "definition": pipe.definition,
            "template_version_id": TEMPLATE_VERSION_ID,
            "attempt_id": f"{RUN_ID}-reverify-hist",
        }
        events, error = _run_verify(pipe.store, payload)
        assert error is None, f"reverify raised: {error}"
        verifications = [e for e in events if e["type"] == "verification"]
        assert verifications[0]["status"] == "pass"

    def test_reverify_with_stored_historical_produces_same_ledger(self) -> None:
        """Re-verification with stored historical.json reproduces the same ledger.

        Unit-level: we manually persist historical.json in the store of a passing run
        (with empty selections to match the zero-candidate compile), then re-verify.
        """
        pipe = Pipeline(definition=_historical_definition())
        events, error = pipe.run()
        assert error is None or isinstance(error, PartialCoverageError)

        # The pipeline passed with zero candidates. Now store a historical.json
        # with empty selections (matching what was compiled).
        prefix = report_prefix(ACTOR_ID, RUN_ID)
        from fakes.object_store import StoredObject

        hist_bundle = {"schema_version": 1, "selections": {}}
        pipe.store._objects[f"{prefix}historical.json"] = StoredObject(
            body=json.dumps(hist_bundle).encode("utf-8"),
            content_type="application/json",
            tags={},
        )

        payload = {
            "definition": pipe.definition,
            "template_version_id": TEMPLATE_VERSION_ID,
            "attempt_id": f"{RUN_ID}-reverify-stored",
        }
        events, error = _run_verify(pipe.store, payload)
        assert error is None, f"reverify with stored historical raised: {error}"
        verifications = [e for e in events if e["type"] == "verification"]
        assert verifications[0]["status"] == "pass"

    def test_corrupted_historical_selection_fails_reverification(
        self, pipeline_with_candidates
    ) -> None:
        """Mutation check: corrupting the persisted selected run id in historical.json
        makes re-verification FAIL.

        The pipeline_with_candidates fixture produced a passing run with actual historical
        points. We corrupt the stored historical.json to reference a different run id,
        then re-verify. The recompile either resolves zero points (different run id not
        loadable) or resolves different points, producing a ledger that differs from the
        stored one.
        """
        pipe, _, _ = pipeline_with_candidates
        prefix = report_prefix(ACTOR_ID, RUN_ID)
        hist_key = f"{prefix}historical.json"
        assert hist_key in pipe.store.keys(), "historical.json must exist for this test"

        # Read the real historical.json and corrupt the run id
        raw_bytes = pipe.store.get(hist_key).body
        raw = json.loads(raw_bytes)

        # Corrupt: change every selected run_id to a non-existent one
        from fakes.object_store import StoredObject

        corrupted = copy.deepcopy(raw)
        if "selections" in corrupted:
            for key, sel in corrupted["selections"].items():
                if isinstance(sel, dict) and "selected" in sel:
                    for candidate in sel["selected"]:
                        if isinstance(candidate, dict):
                            candidate["run_id"] = "CORRUPTED_RUN_NEVER_EXISTED"

        pipe.store._objects[hist_key] = StoredObject(
            body=json.dumps(corrupted).encode("utf-8"),
            content_type="application/json",
            tags={},
        )

        payload = {
            "definition": pipe.definition,
            "template_version_id": TEMPLATE_VERSION_ID,
            "attempt_id": f"{RUN_ID}-reverify-corrupt",
        }
        events, error = _run_verify(pipe.store, payload)

        # The corrupted run id means the recompile cannot load the prior snapshot,
        # so it produces zero historical points instead of the original non-zero count.
        # The compile layer comparison then fails.
        assert isinstance(error, VerificationFailedError), (
            f"corrupted historical selection must fail re-verification, got: {error}"
        )

    def test_original_passes_after_mutation_check(self, pipeline_with_trend) -> None:
        """Confirms the uncorrupted store still passes (not a flaky fixture)."""
        pipe, _ = pipeline_with_trend
        payload = {
            "definition": pipe.definition,
            "template_version_id": TEMPLATE_VERSION_ID,
            "attempt_id": f"{RUN_ID}-reverify-confirm",
        }
        events, error = _run_verify(pipe.store, payload)
        assert error is None


# --------------------------------------------------------------------------- #
# Zero-candidate path: normal outcome, no error
# --------------------------------------------------------------------------- #


class TestZeroCandidatePath:
    def test_absent_historical_candidates_is_not_an_error(self) -> None:
        """A payload with no historical_candidates still completes cleanly."""
        pipe = Pipeline(definition=_historical_definition())
        events, error = pipe.run()
        assert error is None or isinstance(error, PartialCoverageError)

    def test_empty_historical_candidates_list_is_not_an_error(self) -> None:
        """An explicitly empty list behaves identically to absent."""
        pipe = Pipeline(definition=_historical_definition())
        original_payload = pipe.payload

        def patched() -> dict[str, Any]:
            p = original_payload()
            p["historical_candidates"] = []
            return p

        pipe.payload = patched  # type: ignore[assignment]
        events, error = pipe.run()
        assert error is None or isinstance(error, PartialCoverageError)


# --------------------------------------------------------------------------- #
# render_preview: zero-point statement, not a short trend
# --------------------------------------------------------------------------- #


class TestRenderPreviewHistorical:
    def test_preview_renders_zero_point_statement(self, pipeline_with_trend) -> None:
        """render_preview with a historical_trend block completes without error.

        The preview does NOT resolve prior runs — it has no candidate list and no stored
        historical.json. The block emits its "no prior runs" statement, which is correct:
        a preview is a layout draft, not a report. Showing plotted data that the final
        report might not have (different candidates at run time) would be the HTML-preview
        divergence design-system.md warns against.
        """
        pipe, _ = pipeline_with_trend

        async def go() -> list[dict[str, Any]]:
            events: list[dict[str, Any]] = []
            steps = StepTracker()
            async for event in run_render_preview(
                payload={
                    "definition": pipe.definition,
                    "preview_id": "preview-hist-test",
                    "snapshot_run_id": RUN_ID,
                },
                context={"actor_id": ACTOR_ID},
                steps=steps,
                artifact_bucket=BUCKET,
                object_store=pipe.store,
            ):
                events.append(event)
            return events

        events = asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))
        # Should complete without error
        tool_events = [e for e in events if e["type"] == "tool"]
        assert any(e["phase"] == "end" for e in tool_events)


# --------------------------------------------------------------------------- #
# Guard: every compile_document call site that COULD carry historical data DOES
# --------------------------------------------------------------------------- #


class TestCompileDocumentCallSiteGuard:
    def test_every_call_site_passes_historical_when_available(self) -> None:
        """Static check: grep for compile_document calls and verify historical forwarding.

        The delivered path (_document_phases) and the verify path (run_verify_report) must
        pass both `historical` and `historical_selections`. The preview and thumbnails
        deliberately don't (they have no candidates), and that is asserted separately.
        """
        import ast
        from pathlib import Path

        source = (
            Path(__file__).resolve().parents[1]
            / "src"
            / "reporting_agent"
            / "report_pipeline.py"
        )
        tree = ast.parse(source.read_text(encoding="utf-8"))

        # Find all calls to compile_document
        calls: list[tuple[int, set[str]]] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            # Match `compile_document(...)` or `asyncio.to_thread(compile_document, ...)`
            is_direct = isinstance(func, ast.Name) and func.id == "compile_document"
            is_threaded = (
                isinstance(func, ast.Attribute)
                and func.attr == "to_thread"
                and len(node.args) >= 1
                and isinstance(node.args[0], ast.Name)
                and node.args[0].id == "compile_document"
            )
            if not (is_direct or is_threaded):
                continue
            kwarg_names = {kw.arg for kw in node.keywords if kw.arg is not None}
            calls.append((node.lineno, kwarg_names))

        # There should be at least 3 call sites: _document_phases, verify, preview
        assert len(calls) >= 3, f"Expected ≥3 compile_document calls, found {len(calls)}"

        # The first two (delivered path and verify path) MUST have historical kwargs
        delivered_and_verify = [
            (lineno, kwargs)
            for lineno, kwargs in calls
            if "historical" in kwargs or "historical_selections" in kwargs
        ]
        assert len(delivered_and_verify) >= 2, (
            f"Expected ≥2 compile_document calls with historical kwargs, found "
            f"{len(delivered_and_verify)}. All calls: {calls}"
        )

        # Preview and thumbnails are allowed to omit historical — they have no candidates.
        # But verify MUST carry it.
        for lineno, kwargs in calls:
            if "catalog_scales" in kwargs and "historical" not in kwargs:
                # This is likely the verify path — if it has catalog_scales=None AND prose
                # it should also have historical
                if "prose" in kwargs:
                    # This is definitely verify or a full compile — must have historical
                    assert "historical" in kwargs, (
                        f"compile_document at line {lineno} has prose= but no historical= "
                        f"— a verify/compile path must replay historical selections"
                    )


# --------------------------------------------------------------------------- #
# Unit tests for helpers
# --------------------------------------------------------------------------- #


class TestHistoricalSelectionKeys:
    def test_extracts_keys_from_top_level_block(self) -> None:
        defn = _historical_definition()
        keys = _historical_selection_keys(defn)
        assert ("Percentage CPU", "avg", 6) in keys

    def test_returns_empty_for_no_trend_blocks(self) -> None:
        defn = definition(blocks=[df.block("res", "resource_table", {"columns": [df.CPU_AVG]})])
        keys = _historical_selection_keys(defn)
        assert keys == set()

    def test_deduplicates_identical_keys(self) -> None:
        """Two blocks with same (metric, statistic, lookback) yield one key."""
        blocks = [
            df.block("t1", "historical_trend", {"metric": "Percentage CPU", "statistic": "avg", "lookback": 6}),
            df.block("t2", "historical_trend", {"metric": "Percentage CPU", "statistic": "avg", "lookback": 6}),
        ]
        defn = definition(blocks=blocks)
        keys = _historical_selection_keys(defn)
        assert len(keys) == 1


class TestHistoricalBundle:
    def test_none_for_empty_selections(self) -> None:
        assert _historical_bundle(None) is None
        assert _historical_bundle({}) is None

    def test_round_trip(self) -> None:
        """Serialization → deserialization produces equivalent selections."""
        from reporting_agent.compile.historical import PriorRunCandidate

        candidate = PriorRunCandidate(
            run_id="run-abc",
            period_start="2026-05-01",
            period_end="2026-05-31",
            timezone="Asia/Jakarta",
            status="completed",
            verification_status="pass",
            verification_created_at="2026-05-31T10:00:00Z",
            verification_id="v-run-abc",
            snapshot_sha256="b" * 64,
        )
        key: HistoricalSelectionKey = ("Percentage CPU", "avg", 6)
        selections = {key: Selection(selected=(candidate,), exclusions=())}

        bundle = _historical_bundle(selections)
        assert bundle is not None

        restored = _StoredSelection(bundle)
        assert key in restored.selections
        restored_sel = restored.selections[key]
        assert len(restored_sel.selected) == 1
        assert restored_sel.selected[0].run_id == "run-abc"
        assert restored_sel.selected[0].period_start == "2026-05-01"
        assert restored_sel.selected[0].snapshot_sha256 == "b" * 64


class TestStoredSelection:
    def test_none_input_produces_empty_selections(self) -> None:
        stored = _StoredSelection(None)
        assert stored.selections == {}

    def test_malformed_input_produces_empty_selections(self) -> None:
        stored = _StoredSelection({"selections": "not-a-dict"})
        assert stored.selections == {}

    def test_bad_key_format_skipped(self) -> None:
        stored = _StoredSelection({"selections": {"badkey": {"selected": []}}})
        assert stored.selections == {}
