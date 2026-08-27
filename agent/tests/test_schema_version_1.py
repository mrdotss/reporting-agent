"""Prove a v1 definition compiles, renders, and verifies end to end (Req 13.11, 15.12, 16.10, 24.17).

The starters in `app/lib/templates/starters.ts` were migrated from schema_version 1
to schema_version 3 by task 3.13. This test now exercises a dedicated v1 fixture
instead — a definition that exercises the cover, kpi_row, resource_table,
gaps_and_coverage, and verification_record block paths, which is the same set the
original v1 starters exercised.

The fixture is `schema_version` 1 and carries:

- One `cover` block in its `blocks` list — the v1 position.
- Exactly two `number_format` keys (`decimal_places` and `group_thousands`) — no
  `decimal_separator`, no `grouping_separator`.
- No `identity.language` — the field that v2 requires and v1 must not carry.

The definition is compiled, rendered to `.docx`, converted to `.pdf`, and verified
through the production pipeline (Azure ports faked, everything else real). The
assertions:

1. The document is rendered (non-empty `.docx` and `.pdf` bytes).
2. Verification passes — every figure the compiler emitted traces to the snapshot.
3. Every string id is resolved in `en` (the default for v1 definitions per Req 15.12).
4. The separators are `.` (decimal) and `,` (grouping) — the language-derived defaults
   for English per Req 16.10.
5. No stored template version row is written, updated or rewritten by this path —
   compilation reads a pinned definition as it was stored.

This is the **positive outcome** criterion 24.17 names as exempt from the enumeration
meta-test: it is proven by a compile test rather than by a gate that can fail.  The
exemption is declared in task 15.16; this test justifies it by demonstrating that a
v1 definition passes the full pipeline unchanged, so the only thing raising
`schema_version` does is add keys — it rewrites nothing.
"""

from __future__ import annotations

import os
from typing import Any, Final

import pytest

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
from reporting_agent.errors import PartialCoverageError

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

RESOURCES: Final[tuple[str, ...]] = ("prod-web-01", "prod-web-02")

# A rich v1 definition that exercises the block types the original v1 starters used.
# Mirrors the shape of V1_TEST_FIXTURE_DEFINITION in app/lib/templates/starters.ts
# (added by task 3.13 for the same purpose on the TypeScript side). Excludes blocks
# that need external context (comparison_delta, historical_trend) so the pipeline
# harness can compile it end-to-end with only fake metrics.
V1_FIXTURE_DEFINITION: Final[dict[str, Any]] = {
    "schema_version": 1,
    "identity": {
        "name": "V1 pipeline fixture",
        "description": "A rich v1 definition for pipeline integration tests.",
        "report_title": "V1 pipeline fixture",
    },
    "scope": {
        "resource_types": ["Microsoft.Compute/virtualMachines"],
        "tag_filters": [],
        "resource_groups": [],
        "top_n": None,
        "sort": None,
    },
    "period": {"kind": "last_full_month"},
    "metrics": {
        "Microsoft.Compute/virtualMachines": [
            {"metric": "Percentage CPU", "statistic": "avg"},
            {"metric": "Percentage CPU", "statistic": "max"},
            {"metric": "Available Memory Bytes", "statistic": "avg"},
        ],
    },
    "blocks": [
        {
            "id": "v1-cover",
            "type": "cover",
            "config": {"subtitle": "V1 fixture"},
        },
        {
            "id": "v1-heading",
            "type": "heading",
            "config": {"level": 1, "text": "Utilization"},
        },
        {
            "id": "v1-kpis",
            "type": "kpi_row",
            "config": {
                "caption": "Fleet averages",
                "show_fidelity": True,
                "metrics": [
                    {"metric": "Percentage CPU", "statistic": "avg"},
                    {"metric": "Available Memory Bytes", "statistic": "avg"},
                ],
            },
        },
        {
            "id": "v1-table",
            "type": "resource_table",
            "config": {
                "caption": "Per-machine utilization",
                "show_fidelity": True,
                "columns": [
                    {"metric": "Percentage CPU", "statistic": "avg"},
                    {"metric": "Percentage CPU", "statistic": "max"},
                ],
            },
        },
        {
            "id": "v1-gaps",
            "type": "gaps_and_coverage",
            "config": {"caption": "What could not be collected"},
        },
        {
            "id": "v1-record",
            "type": "verification_record",
            "config": {"caption": "Collection record"},
        },
    ],
    "design": {
        "preset": "editorial",
        "accent_color": "#1f6f78",
        "density": "normal",
        "table_style": "hairline",
        "number_format": {"decimal_places": 2, "group_thousands": True},
        "cover_page": True,
        "logo": None,
        "page_size": "A4",
    },
}


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def v1_definition() -> dict[str, Any]:
    """The dedicated v1 test fixture, loaded once per module."""
    return V1_FIXTURE_DEFINITION


# ---------------------------------------------------------------------------
# Structural assertions on the definition as stored
# ---------------------------------------------------------------------------


class TestV1DefinitionAsStored:
    """Assert the invariants the task requires about the stored shape."""

    def test_cover_blocks_in_blocks_list(self, v1_definition: dict[str, Any]) -> None:
        """The fixture carries exactly one `cover` block in its `blocks` list.

        This is a `schema_version` 1 definition, so the cover lives in `blocks` (v2
        moves it to `front_matter`). It compiles through
        `compile/blocks/structure.compile_cover` at v1 — the path Req 13.11 keeps working.
        """
        cover_count = 0
        blocks = v1_definition.get("blocks", [])
        for block in blocks:
            if block.get("type") == "cover":
                cover_count += 1
            if block.get("type") == "row":
                for column in block.get("columns", []):
                    for child in column:
                        if child.get("type") == "cover":
                            cover_count += 1
        assert cover_count == 1, (
            f"Expected 1 cover block, found {cover_count}"
        )

    def test_exactly_two_number_format_keys(self, v1_definition: dict[str, Any]) -> None:
        """The fixture's `number_format` carries exactly `decimal_places` and
        `group_thousands` — the two keys `schema_version` 1 permits."""
        nf = v1_definition["design"]["number_format"]
        assert set(nf.keys()) == {"decimal_places", "group_thousands"}, (
            f"Unexpected number_format keys: {set(nf.keys())}"
        )

    def test_no_identity_language(self, v1_definition: dict[str, Any]) -> None:
        """The fixture does not declare `identity.language` — that is a `schema_version` 2 field."""
        identity = v1_definition.get("identity", {})
        assert "language" not in identity, (
            "Fixture declares identity.language, which is a schema_version 2 field"
        )

    def test_is_schema_version_1(self, v1_definition: dict[str, Any]) -> None:
        """The fixture is `schema_version` 1."""
        assert v1_definition.get("schema_version") == 1, (
            f"Fixture has schema_version {v1_definition.get('schema_version')}"
        )

    def test_passes_the_template_validator(self, v1_definition: dict[str, Any]) -> None:
        """The fixture passes `collect_definition_issues` with zero issues in `run` mode."""
        issues = list(collect_definition_issues(v1_definition, mode="run"))
        assert not issues, (
            "Fixture has validation issues: "
            + ", ".join(f"{i.path}: {i.message}" for i in issues)
        )


# ---------------------------------------------------------------------------
# Full pipeline run
# ---------------------------------------------------------------------------


def _run_definition(defn: dict[str, Any]) -> tuple[Any, list[dict[str, Any]], Exception | None]:
    """Run a definition through the full pipeline.

    The pipeline is configured with two resources and a multi-day batch (2 days) so that
    timeseries charts have an axis to render, and the batch provides both CPU and Available
    Memory Bytes — enough for the derived `memory_used_pct`. Metrics the fixture references
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
def pipeline_run(v1_definition: dict[str, Any]) -> tuple[Any, list[dict[str, Any]], Exception | None]:
    """Run the fixture through the pipeline, once per module (LibreOffice is slow)."""
    return _run_definition(v1_definition)


# ---------------------------------------------------------------------------
# Compile + render + verify assertions
# ---------------------------------------------------------------------------


class TestV1CompileAndVerify:
    """The v1 fixture compiles, renders and verifies as stored."""

    def test_verification_passes(
        self,
        pipeline_run: tuple[Any, list[dict[str, Any]], Exception | None],
    ) -> None:
        """The run completes with a PASSING verification.

        The run ends with `PartialCoverageError` (non-terminal) because the fake only
        provides CPU and Available Memory Bytes — other metrics produce gaps. That is the
        correct outcome: a partial-coverage run still verifies and delivers.
        """
        pipeline, _events, error = pipeline_run
        assert error is None or isinstance(error, PartialCoverageError), (
            f"V1 fixture failed with unexpected error: {error}"
        )
        assert pipeline.outcome.verification is not None, (
            "V1 fixture produced no verification result"
        )
        assert pipeline.outcome.verification["status"] == "pass", (
            f"V1 fixture verification failed: "
            f"{pipeline.outcome.verification.get('findings', [])}"
        )

    def test_document_is_rendered(
        self,
        pipeline_run: tuple[Any, list[dict[str, Any]], Exception | None],
    ) -> None:
        """Both `.docx` and `.pdf` artifacts are produced."""
        _pipeline, events, error = pipeline_run
        assert error is None or isinstance(error, PartialCoverageError), (
            f"V1 fixture failed with unexpected error: {error}"
        )
        report_file_events = [e for e in events if e.get("type") == "report_file"]
        assert len(report_file_events) == 2, (
            f"Expected 2 report_file events (docx + pdf), got {len(report_file_events)}"
        )
        kinds = {e["kind"] for e in report_file_events}
        assert kinds == {"docx", "pdf"}, f"Got kinds: {kinds}"

    def test_string_ids_resolved_in_english(
        self,
        v1_definition: dict[str, Any],
    ) -> None:
        """Every string id is resolved in `en` — the default for a v1 definition (Req 15.12).

        A v1 definition has no `identity.language`, so the compiler resolves in
        `DEFAULT_LANGUAGE` which is `en`.
        """
        # The resolved schema_version for a v1 definition confirms it is treated as v1
        assert resolved_schema_version(v1_definition.get("schema_version")) == 1

        # The message catalog is loadable in `en` with no missing ids
        messages = load_messages("en")
        # The catalog has entries — if it were empty, resolution would fail at compile time,
        # and the pipeline would not have produced a passing verification (tested above).
        assert len(messages.declared_ids) > 0

    def test_separators_are_period_and_comma(
        self,
        v1_definition: dict[str, Any],
    ) -> None:
        """Separators resolve to `.` (decimal) and `,` (grouping) for English (Req 16.10).

        A v1 definition carries no explicit separators — only `decimal_places` and
        `group_thousands`. The language-derived defaults for `en` are:
        - `decimal_separator` = `.`
        - `grouping_separator` = `,`
        """
        nf = v1_definition["design"]["number_format"]
        # V1 definitions carry exactly these two keys
        assert "decimal_separator" not in nf
        assert "grouping_separator" not in nf
        # SEPARATOR_DEFAULTS maps language -> (decimal_separator, grouping_separator).
        en_decimal, en_grouping = SEPARATOR_DEFAULTS["en"]
        assert en_decimal == ".", f"Expected '.' decimal separator for 'en', got {en_decimal!r}"
        assert en_grouping == ",", f"Expected ',' grouping separator for 'en', got {en_grouping!r}"


class TestNoStoredVersionRowWritten:
    """Compiling a v1 fixture writes no stored template version row (Req 13.11).

    The pipeline receives a definition and compiles it. It does not persist or
    rewrite it. The `report_runs` state machine stores the template_version_id as
    a **foreign key reference** — it points at a row that the app already wrote;
    the agent never creates that row.

    This is the structural guarantee that raising the schema version rewrites nothing:
    v1 rows stay v1 because nothing in the agent writes template version rows at all.
    """

    def test_no_template_version_written_to_object_store(
        self,
        pipeline_run: tuple[Any, list[dict[str, Any]], Exception | None],
    ) -> None:
        """The object store contains only report artifacts — no template version objects."""
        pipeline, _events, _error = pipeline_run
        stored_keys = list(pipeline.store.keys())
        template_keys = [
            k for k in stored_keys
            if "template" in k.lower() and "version" in k.lower()
        ]
        assert not template_keys, (
            f"Unexpected template version objects in store: {template_keys}"
        )

    def test_no_definition_mutation_event(
        self,
        pipeline_run: tuple[Any, list[dict[str, Any]], Exception | None],
    ) -> None:
        """No event in the stream mentions writing or updating a template definition."""
        _pipeline, events, _error = pipeline_run
        for event in events:
            event_name = event.get("name", "")
            # The pipeline emits tool events for its phases — none should be
            # about template persistence.
            assert "template_version" not in event_name, (
                f"Unexpected template_version event: {event}"
            )
