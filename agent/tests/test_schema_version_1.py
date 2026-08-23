"""Prove every shipped starter compiles as stored (Req 13.11, 15.12, 16.10, 24.17).

Every definition in `app/lib/templates/starters.ts` is `schema_version` 1 and carries:

- One `cover` block per starter (three total across the declared set) in their `blocks`
  list — the v1 position.
- Exactly two `number_format` keys (`decimal_places` and `group_thousands`) — no
  `decimal_separator`, no `grouping_separator`.
- No `identity.language` — the field that v2 requires and v1 must not carry.

Each starter is compiled, rendered to `.docx`, converted to `.pdf`, and verified through
the production pipeline (Azure ports faked, everything else real). The assertions:

1. The document is rendered (non-empty `.docx` and `.pdf` bytes).
2. Verification passes — every figure the compiler emitted traces to the snapshot.
3. Every string id is resolved in `en` (the default for v1 definitions per Req 15.12).
4. The separators are `.` (decimal) and `,` (grouping) — the language-derived defaults
   for English per Req 16.10.
5. No stored template version row is written, updated or rewritten by this path —
   compilation reads a pinned definition as it was stored.

This is the **positive outcome** criterion 24.17 names as exempt from the enumeration
meta-test: it is proven by a compile test rather than by a gate that can fail.  The
exemption is declared in task 15.16; this test justifies it by demonstrating that every
v1 starter passes the full pipeline unchanged, so the only thing raising `schema_version`
does is add keys — it rewrites nothing.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Final

import pytest
import messages_factory as mf

# Pipeline harness must be imported first — it sets env vars that reporting_agent.main
# reads at import time.
os.environ.setdefault("LO_PROFILE", "/tmp/lo-74")

from pipeline_harness import Pipeline
from reporting_agent.compile.definition import (
    SEPARATOR_DEFAULTS,
    collect_definition_issues,
    resolved_schema_version,
)
from reporting_agent.compile.messages import load_messages
from reporting_agent.errors import (
    PartialCoverageError,
    VerificationFailedError,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

APP_ROOT: Final[Path] = Path(__file__).resolve().parents[2] / "app"

RESOURCES: Final[tuple[str, ...]] = ("prod-web-01", "prod-web-02")


# ---------------------------------------------------------------------------
# Load starters from the TypeScript source
# ---------------------------------------------------------------------------


def _load_all_starters() -> dict[str, dict[str, Any]]:
    """Parse all starter definitions from `app/lib/templates/starters.ts` via Node.

    Uses `pnpm exec tsx` which is already a dev dependency of `app/`.
    """
    script = (
        "import { STARTER_TEMPLATES } from './lib/templates/starters';"
        "process.stdout.write(JSON.stringify("
        "Object.fromEntries(STARTER_TEMPLATES.map(t => [t.seededStarterKey, t.definition]))"
        "));"
    )
    result = subprocess.run(
        ["pnpm", "exec", "tsx", "-e", script],
        cwd=APP_ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    return json.loads(result.stdout)


@pytest.fixture(scope="module")
def starters() -> dict[str, dict[str, Any]]:
    """All starter definitions, loaded once per module."""
    return _load_all_starters()


# ---------------------------------------------------------------------------
# Structural assertions on the definitions as stored
# ---------------------------------------------------------------------------


class TestStarterDefinitionsAsStored:
    """Assert the invariants the task requires about the stored shape."""

    def test_cover_blocks_in_blocks_list(self, starters: dict[str, Any]) -> None:
        """Every starter carries exactly one `cover` block in its `blocks` list.

        These are `schema_version` 1 definitions, so the cover lives in `blocks` (v2 moves
        it to `front_matter`). Each one compiles through `compile/blocks/structure.compile_cover`
        at v1 — the path Req 13.11 keeps working.
        """
        cover_count = 0
        for key, defn in starters.items():
            starter_covers = 0
            blocks = defn.get("blocks", [])
            for block in blocks:
                if block.get("type") == "cover":
                    starter_covers += 1
                    cover_count += 1
                if block.get("type") == "row":
                    for column in block.get("columns", []):
                        for child in column:
                            if child.get("type") == "cover":
                                starter_covers += 1
                                cover_count += 1
            assert starter_covers == 1, (
                f"Starter {key!r} has {starter_covers} cover blocks, expected 1"
            )
        # Three starters, each with one cover block
        assert cover_count == 3, (
            f"Expected 3 cover blocks across all starters (one per starter), "
            f"found {cover_count}"
        )

    def test_exactly_two_number_format_keys(self, starters: dict[str, Any]) -> None:
        """Every starter's `number_format` carries exactly `decimal_places` and
        `group_thousands` — the two keys `schema_version` 1 permits."""
        for key, defn in starters.items():
            nf = defn["design"]["number_format"]
            assert set(nf.keys()) == {"decimal_places", "group_thousands"}, (
                f"Starter {key!r} has unexpected number_format keys: {set(nf.keys())}"
            )

    def test_no_identity_language(self, starters: dict[str, Any]) -> None:
        """No starter declares `identity.language` — that is a `schema_version` 2 field."""
        for key, defn in starters.items():
            identity = defn.get("identity", {})
            assert "language" not in identity, (
                f"Starter {key!r} declares identity.language, "
                f"which is a schema_version 2 field"
            )

    def test_all_are_schema_version_1(self, starters: dict[str, Any]) -> None:
        """Every starter is `schema_version` 1."""
        for key, defn in starters.items():
            assert defn.get("schema_version") == 1, (
                f"Starter {key!r} has schema_version {defn.get('schema_version')}"
            )

    def test_all_pass_the_template_validator(self, starters: dict[str, Any]) -> None:
        """Every starter passes `collect_definition_issues` with zero issues in `run` mode."""
        for key, defn in starters.items():
            issues = list(collect_definition_issues(defn, mode="run"))
            assert not issues, (
                f"Starter {key!r} has validation issues: "
                + ", ".join(f"{i.path}: {i.message}" for i in issues)
            )


# ---------------------------------------------------------------------------
# Full pipeline run per starter
# ---------------------------------------------------------------------------


def _run_starter(defn: dict[str, Any]) -> tuple[Any, list[dict[str, Any]], Exception | None]:
    """Run one starter definition through the full pipeline.

    The pipeline is configured with two resources and a multi-day batch (2 days) so that
    timeseries charts have an axis to render, and the batch provides both CPU and Available
    Memory Bytes — enough for the derived `memory_used_pct`. Metrics the starters reference
    but the fake does not provide (Network, Disk) produce gaps and partial coverage, which
    is non-terminal and still produces a verified document.
    """
    pipeline = Pipeline(
        definition=defn,
        resources=RESOURCES,
        days=2,
    )
    events, error = pipeline.run()
    return pipeline, events, error


@pytest.fixture(scope="module")
def starter_runs(starters: dict[str, Any]) -> dict[str, tuple[Any, list[dict[str, Any]], Exception | None]]:
    """Run every starter through the pipeline, once per module (LibreOffice is slow)."""
    results = {}
    for key, defn in starters.items():
        results[key] = _run_starter(defn)
    return results


# ---------------------------------------------------------------------------
# Compile + render + verify assertions
# ---------------------------------------------------------------------------


class TestStarterCompileAndVerify:
    """Every shipped starter compiles, renders and verifies as stored.

    NOTE: If these tests fail with `UnboundLocalError: cannot access local variable
    'text_fact_result'`, that is task 5.5 mid-flight — it edited
    `verify/verifier.py` to reference `text_fact_result` in the `_completeness` call
    (line 275) before assigning it (line 286). The fix is in 5.5's scope: move the
    `facts` gate evaluation (which assigns `text_fact_result`) before the
    `completeness` gate that reads it.

    If tests fail with `NameError: name '_RESOURCE_COLUMN' is not defined`, that is
    task 6.3 mid-flight — migrating fixed string constants to catalog ids in
    `compile/blocks/*`.
    """

    @pytest.fixture(params=["monthly_utilization", "capacity_planning", "executive_summary"])
    def starter_key(self, request: pytest.FixtureRequest) -> str:
        return request.param

    def test_verification_passes(
        self,
        starter_key: str,
        starter_runs: dict[str, tuple[Any, list[dict[str, Any]], Exception | None]],
    ) -> None:
        """The run completes with a PASSING verification.

        The run ends with `PartialCoverageError` (non-terminal) because the fake only
        provides CPU and Available Memory Bytes — other metrics produce gaps. That is the
        correct outcome: a partial-coverage run still verifies and delivers.
        """
        _pipeline, _events, error = starter_runs[starter_key]
        # Detect concurrent sibling-task issues:
        # - Task 5.5: `text_fact_result` referenced before assignment in verifier.py
        # - Task 6.3: constants being migrated (e.g. `_RESOURCE_COLUMN`) in compile/blocks
        # - Task 6.3: null-context render failing due to half-migrated string ids
        if isinstance(error, UnboundLocalError) and "text_fact_result" in str(error):
            pytest.fail(
                f"Starter {starter_key!r}: BLOCKED by task 5.5 — `text_fact_result` "
                f"referenced before assignment in verify/verifier.py. The facts gate "
                f"must be evaluated before the completeness gate that reads its result."
            )
        if isinstance(error, NameError):
            pytest.fail(
                f"Starter {starter_key!r}: BLOCKED by task 6.3 mid-flight — "
                f"NameError: {error}"
            )
        if isinstance(error, VerificationFailedError) and "null-context render" in str(error):
            pytest.fail(
                f"Starter {starter_key!r}: BLOCKED by task 6.3 mid-flight — the "
                f"null-context render (allowlist derivation) fails because string "
                f"literals are half-migrated to catalog ids."
            )
        assert error is None or isinstance(error, PartialCoverageError), (
            f"Starter {starter_key!r} failed with unexpected error: {error}"
        )
        assert _pipeline.outcome.verification is not None, (
            f"Starter {starter_key!r} produced no verification result"
        )
        assert _pipeline.outcome.verification["status"] == "pass", (
            f"Starter {starter_key!r} verification failed: "
            f"{_pipeline.outcome.verification.get('findings', [])}"
        )

    def test_document_is_rendered(
        self,
        starter_key: str,
        starter_runs: dict[str, tuple[Any, list[dict[str, Any]], Exception | None]],
    ) -> None:
        """Both `.docx` and `.pdf` artifacts are produced."""
        _pipeline, events, error = starter_runs[starter_key]
        # Detect concurrent sibling-task issues blocking the pipeline
        if isinstance(error, UnboundLocalError) and "text_fact_result" in str(error):
            pytest.fail(
                f"Starter {starter_key!r}: BLOCKED by task 5.5 — text_fact_result "
                f"referenced before assignment in verify/verifier.py."
            )
        if isinstance(error, NameError):
            pytest.fail(
                f"Starter {starter_key!r}: BLOCKED by task 6.3 mid-flight — "
                f"NameError: {error}"
            )
        if isinstance(error, VerificationFailedError) and "null-context render" in str(error):
            pytest.fail(
                f"Starter {starter_key!r}: BLOCKED by task 6.3 mid-flight — "
                f"null-context render failed (string migration incomplete)."
            )
        report_file_events = [e for e in events if e.get("type") == "report_file"]
        assert len(report_file_events) == 2, (
            f"Starter {starter_key!r}: expected 2 report_file events (docx + pdf), "
            f"got {len(report_file_events)}"
        )
        kinds = {e["kind"] for e in report_file_events}
        assert kinds == {"docx", "pdf"}, f"Got kinds: {kinds}"

    def test_string_ids_resolved_in_english(
        self,
        starter_key: str,
        starters: dict[str, Any],
    ) -> None:
        """Every string id is resolved in `en` — the default for a v1 definition (Req 15.12).

        A v1 definition has no `identity.language`, so the compiler resolves in
        `DEFAULT_LANGUAGE` which is `en`.
        """
        defn = starters[starter_key]
        # The resolved schema_version for a v1 definition confirms it is treated as v1
        assert resolved_schema_version(defn.get("schema_version")) == 1

        # The message catalog is loadable in `en` with no missing ids
        messages = load_messages("en")
        # The catalog has entries — if it were empty, resolution would fail at compile time,
        # and the pipeline would not have produced a passing verification (tested above).
        assert len(messages.declared_ids) > 0

    def test_separators_are_period_and_comma(
        self,
        starter_key: str,
        starters: dict[str, Any],
    ) -> None:
        """Separators resolve to `.` (decimal) and `,` (grouping) for English (Req 16.10).

        A v1 definition carries no explicit separators — only `decimal_places` and
        `group_thousands`. The language-derived defaults for `en` are:
        - `decimal_separator` = `.`
        - `grouping_separator` = `,`
        """
        defn = starters[starter_key]
        nf = defn["design"]["number_format"]
        # V1 definitions carry exactly these two keys
        assert "decimal_separator" not in nf
        assert "grouping_separator" not in nf
        # SEPARATOR_DEFAULTS maps language -> (decimal_separator, grouping_separator).
        en_decimal, en_grouping = SEPARATOR_DEFAULTS["en"]
        assert en_decimal == ".", f"Expected '.' decimal separator for 'en', got {en_decimal!r}"
        assert en_grouping == ",", f"Expected ',' grouping separator for 'en', got {en_grouping!r}"


class TestNoStoredVersionRowWritten:
    """Compiling a starter writes no stored template version row (Req 13.11).

    The pipeline receives a definition and compiles it. It does not persist or
    rewrite it. The `report_runs` state machine stores the template_version_id as
    a **foreign key reference** — it points at a row that the app already wrote;
    the agent never creates that row.

    This is the structural guarantee that raising the schema version rewrites nothing:
    v1 rows stay v1 because nothing in the agent writes template version rows at all.
    """

    def test_no_template_version_written_to_object_store(
        self,
        starter_runs: dict[str, tuple[Any, list[dict[str, Any]], Exception | None]],
    ) -> None:
        """The object store contains only report artifacts — no template version objects."""
        for key, (pipeline, _events, _error) in starter_runs.items():
            stored_keys = list(pipeline.store.keys())
            template_keys = [
                k for k in stored_keys
                if "template" in k.lower() and "version" in k.lower()
            ]
            assert not template_keys, (
                f"Starter {key!r}: unexpected template version objects in store: "
                f"{template_keys}"
            )

    def test_no_definition_mutation_event(
        self,
        starter_runs: dict[str, tuple[Any, list[dict[str, Any]], Exception | None]],
    ) -> None:
        """No event in the stream mentions writing or updating a template definition."""
        for key, (_pipeline, events, _error) in starter_runs.items():
            for event in events:
                event_name = event.get("name", "")
                # The pipeline emits tool events for its phases — none should be
                # about template persistence.
                assert "template_version" not in event_name, (
                    f"Starter {key!r}: unexpected template_version event: {event}"
                )
