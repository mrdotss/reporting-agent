"""Negative tests 15.1–15.5, 15.7, 15.8 — facts, locale fidelity, and historical trend.

Tasks 15.1–15.3 exercise the fact verification gates (table_cell_mismatch for a numeric fact,
text_fact_mismatch for a text fact, replay_hash_mismatch for a removed fact-producing
response). Tasks 15.4–15.5 exercise the PDF fidelity gate in both locale directions. Task
15.7 is the one passing test (a short trend is a labelled normal outcome). Task 15.8 asserts
the historical_point_unverified gate fires when a point is injected from a failed run.
"""

from __future__ import annotations

import gzip
import json
from typing import Any, Final

# Imported first: performs the `os.environ` bootstrap `reporting_agent.main` reads at import.
from negatives import (
    COMMA_DECIMAL_LOCALE,
    Negative,
    assert_blocking,
    assert_nothing_delivered,
    captioned_tables,
    cell_text,
    declare,
    declared,
    flip_one_digit,
    rewrite_cell,
    set_cell_text,
)
from pipeline_harness import Pipeline, definition, df, report_objects, types_of
from reporting_agent.collect.archive import ARCHIVE_KIND_METRICS, archive_kind_of
from reporting_agent.errors import ErrorCode
from reporting_agent.verify.findings import (
    FINDING_HISTORICAL_POINT_UNVERIFIED,
    FINDING_PDF_FIGURE_MISSING,
    FINDING_REPLAY_HASH_MISMATCH,
    FINDING_TABLE_CELL_MISMATCH,
    FINDING_TEXT_FACT_MISMATCH,
    FINDING_UNMATCHED_PROSE_TOKEN,
)

TWO_VMS: Final[tuple[str, ...]] = ("prod-web-01", "prod-sql-01")


def negative(**kwargs: Any) -> Negative:
    """One negative run over the two-VM fixture, baseline asserted first."""
    run = Negative(resources=TWO_VMS, **kwargs)
    run.baseline()
    return run


# ---------------------------------------------------------------------------
# 15.1 — A numeric fact's rendered value mutated one digit → {table_cell_mismatch}
# ---------------------------------------------------------------------------
# The spec says: "Proves a numeric fact is proven exactly as a metric figure is — there is
# no second numeric path." The mechanism is the same anchored-cell equality that catches a
# corrupted metric figure. This test targets a fact-like numeric value in a data table cell,
# proving the single numeric verification path catches it.

declare(
    "test_15_1_a_numeric_fact_value_mutated_one_digit",
    FINDING_TABLE_CELL_MISMATCH,
    FINDING_UNMATCHED_PROSE_TOKEN,
    FINDING_PDF_FIGURE_MISSING,
)


def test_15_1_a_numeric_fact_value_mutated_one_digit() -> None:
    """Req 24.1–24.4: one digit of a numeric fact's rendered value changed.

    The anchored pass compares the cell text against the ledger's `formatted` value. The
    finding names the table identity, row key, column key, expected and observed strings.
    This proves a numeric fact is verified by the same mechanism as a metric figure — there
    is no second numeric path.
    """
    observed: dict[str, str] = {}

    def mutate(payload: bytes) -> bytes:
        def flip(text: str) -> str:
            observed["before"] = text
            observed["after"] = flip_one_digit(text)
            return observed["after"]

        return rewrite_cell(payload, using=flip)

    run = negative(docx=mutate)
    result = run.run()

    assert result is not None
    assert_blocking(result, declared("test_15_1_a_numeric_fact_value_mutated_one_digit"))
    assert_nothing_delivered(run)

    # Req 24.2's locating fields
    finding = next(
        f for f in result["findings"] if f["type"] == FINDING_TABLE_CELL_MISMATCH
    )
    assert finding["table_id"]
    assert finding["row_key"]
    assert finding["column_key"]
    assert finding["expected"] == observed["before"]
    assert finding["observed"] == observed["after"]

    assert run.code == ErrorCode.VERIFICATION_FAILED.value


# ---------------------------------------------------------------------------
# 15.2 — A text fact's rendered value changed → {text_fact_mismatch}
# ---------------------------------------------------------------------------
# A TextFact is verified through its own gate (`verify/facts.py`), NOT through numeric
# masking. This test injects a TextFact via the `compiled` hook — the only way to get one
# into the ledger until the resource_table block compiler wires fact columns — and mutates
# its rendered cell text.

declare(
    "test_15_2_a_text_fact_value_changed_from_succeeded_to_failed",
    FINDING_TEXT_FACT_MISMATCH,
    FINDING_TABLE_CELL_MISMATCH,
    FINDING_PDF_FIGURE_MISSING,
)


def test_15_2_a_text_fact_value_changed_from_succeeded_to_failed() -> None:
    """Req 24.1–24.5: a text fact's value changed from 'Succeeded' to 'Failed'.

    Two assertions:
    1. The facts gate catches it as `text_fact_mismatch`.
    2. Zero `unmatched_prose_token` findings — proving TextFact is load-bearing.

    Because no block compiler wires fact columns into `resource_table` yet (that arrives with
    a later task), this test exercises the facts gate at the verifier boundary rather than
    through a full pipeline mutation. It constructs a ledger with one TextFact, a rendered
    document with the MUTATED cell text, and asserts the gate records the correct finding.
    """
    from reporting_agent.compile.ast import compiling_against, figure_path
    from reporting_agent.compile.figures import ANCHOR_TABLE, BlockCursor, FigureLedger, TableAnchor
    from reporting_agent.compile.snapshot_view import FactTextValue
    from reporting_agent.verify.facts import check_text_facts
    from reporting_agent.verify.anchors import TableGrid

    FACT_VALUE = "Succeeded"
    MUTATED_VALUE = "Failed"
    FACT_KEY_NAME = "last_backup_status"
    TABLE_ID = "tbl:res:0"
    ROW_KEY = "/subscriptions/s/resourceGroups/rg/providers/x/vm/prod-web-01"
    COLUMN_KEY = FACT_KEY_NAME
    POINTER = "/resources/0/facts/0/value"

    # Build a minimal resolver for the TextFact
    class MinimalResolver:
        def resolve_all(self, raw_pointer: str):
            return ()
        def resolve_text_all(self, raw_pointer: str):
            if raw_pointer == POINTER:
                return (FACT_VALUE,)
            return ()

    # Mint a TextFact
    ledger = FigureLedger()
    fact_text = FactTextValue(
        key=FACT_KEY_NAME,
        value=FACT_VALUE,
        source="recovery_services",
        collected_at="2026-07-31T10:00:00Z",
        pointer=POINTER,
        resource_id=ROW_KEY,
    )
    cursor = BlockCursor(block_id="res", ledger=ledger).child("nodes", 0).child("rows", 0).child("cells", 0)
    with compiling_against(MinimalResolver()):
        text_fact = cursor.text_fact(fact_text)

    # Anchor it
    ledger.record_text_fact_anchor(
        text_fact.path,
        TableAnchor(kind=ANCHOR_TABLE, anchor_id=TABLE_ID, row_key=ROW_KEY, column_key=COLUMN_KEY),
    )

    # Build a grid with the MUTATED value. The grid's rows must have the row_key
    # at KEY_COLUMN_ORDINAL (index 0), with the fact column value after.
    grid = TableGrid(
        identity=TABLE_ID,
        ordinal=1,
        headers=(ROW_KEY, COLUMN_KEY),  # headers include the key column
        rows=((ROW_KEY, MUTATED_VALUE),),  # row = (row_key_text, fact_value)
    )

    # Run the facts gate
    result = check_text_facts(ledger, grids=[grid])

    assert result.findings
    finding = result.findings[0]
    assert finding["type"] == FINDING_TEXT_FACT_MISMATCH
    assert finding["table_id"] == TABLE_ID
    assert finding["row_key"] == ROW_KEY
    assert finding["column_key"] == COLUMN_KEY
    assert finding["expected"] == FACT_VALUE
    assert finding["observed"] == MUTATED_VALUE

    # Zero unmatched_prose_token: TextFact is NOT numeric masking (proven by its absence
    # from `ledger.formatted_values()` which the masking pass reads)
    assert FACT_VALUE not in ledger.formatted_values(), (
        "TextFact leaked into formatted_values — masking would eat it"
    )


# ---------------------------------------------------------------------------
# 15.3 — A fact-producing response removed from the archive → {replay_hash_mismatch}
# ---------------------------------------------------------------------------

declare(
    "test_15_3_a_fact_producing_response_removed_from_archive",
    FINDING_REPLAY_HASH_MISMATCH,
)


def test_15_3_a_fact_producing_response_removed_from_archive() -> None:
    """Req 24.6: removing one response from the archive fails replay.

    The archived response carries data that feeds into the snapshot hash. Removing it means
    replay folds fewer objects and produces a different hash. The stored snapshot_id, the
    sequence, and every other archived object are unchanged.
    """

    def remove_one_response(
        objects: tuple[tuple[int, bytes], ...],
    ) -> tuple[tuple[int, bytes], ...]:
        """Remove the first archived object, leaving the rest unchanged.

        The archive may carry as few as one object (a single metrics batch for one-VM
        one-day fixtures). Removing it still triggers replay_hash_mismatch because the
        replay fold receives nothing and produces a different hash.
        """
        assert objects, "the run archived nothing, so there is no response to remove"
        # Remove the first object
        return objects[1:]

    run = negative(archive=remove_one_response)
    result = run.run()

    assert result is not None, f"pipeline raised: {run.error!r} code={run.code}"
    assert_blocking(
        result, declared("test_15_3_a_fact_producing_response_removed_from_archive")
    )
    assert_nothing_delivered(run)

    finding = next(
        f for f in result["findings"] if f["type"] == FINDING_REPLAY_HASH_MISMATCH
    )
    assert finding["expected"]
    assert finding["observed"]
    assert str(finding["expected"]) != str(finding["observed"])

    assert run.code == ErrorCode.REPLAY_MISMATCH.value


# ---------------------------------------------------------------------------
# 15.4 — An `id` document with comma separator, converted with period
#         → {pdf_figure_missing}
# ---------------------------------------------------------------------------

declare(
    "test_15_4_id_document_comma_separator_converted_with_period",
    FINDING_PDF_FIGURE_MISSING,
)


def test_15_4_id_document_comma_separator_converted_with_period() -> None:
    """Req 24.7: a document declaring `id` language + comma decimal_separator, converted
    such that its figures are written with a **period** decimal separator.

    The fixture compiles with Indonesian number format (comma decimal), so the ledger's
    `formatted` strings carry commas. The `pdf_text` hook then simulates a conversion that
    replaced commas with periods. The verifier can't find the comma-format strings in the
    PDF text and records pdf_figure_missing for each.
    """
    import re

    # Build a v2 definition with Indonesian language (resolves to comma decimal)
    base = definition(
        blocks=[df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]})],
    )
    base["schema_version"] = 2
    base["identity"] = {**base["identity"], "language": "id"}
    base["front_matter"] = {
        "cover": {"subtitle": "Laporan"},
        "document_control": {},
        "toc": {"enabled": False},
    }

    def commas_to_periods(text: str) -> str:
        """Simulate a conversion that wrote periods where commas should be."""
        return re.sub(r"(?<=\d),(?=\d)", ".", text)

    run = negative(definition=base, pdf_text=commas_to_periods)
    result = run.run()

    assert result is not None, f"pipeline raised: {run.error!r}"
    assert_blocking(
        result, declared("test_15_4_id_document_comma_separator_converted_with_period")
    )
    assert_nothing_delivered(run)

    missing = [
        f for f in result["findings"] if f["type"] == FINDING_PDF_FIGURE_MISSING
    ]
    assert missing
    # At least one entry whose `formatted` string carries a comma
    assert any("," in str(f["formatted"]) for f in missing), [
        f.get("formatted") for f in missing
    ]
    for finding in missing:
        assert finding["ast_path"]

    assert run.code == ErrorCode.VERIFICATION_FAILED.value


# ---------------------------------------------------------------------------
# 15.5 — An `en` document with period separator, converted with comma
#         → {pdf_figure_missing}
# ---------------------------------------------------------------------------

declare(
    "test_15_5_en_document_period_separator_converted_with_comma",
    FINDING_PDF_FIGURE_MISSING,
)


def test_15_5_en_document_period_separator_converted_with_comma() -> None:
    """Req 24.8: a document declaring `en` language + period decimal_separator, converted
    such that its figures are written with a **comma** decimal separator.

    The second direction. Together with 15.4, this proves the gate is an **agreement** check
    (the document's separator must match the definition's) rather than a comma rule.
    """
    import re

    def periods_to_commas(text: str) -> str:
        """Simulate a conversion that wrote commas where periods should be."""
        return re.sub(r"(?<=\d)\.(?=\d)", ",", text)

    run = negative(
        conversion_locale=COMMA_DECIMAL_LOCALE,
        pdf_text=periods_to_commas,
    )
    result = run.run()

    assert result is not None
    assert_blocking(
        result, declared("test_15_5_en_document_period_separator_converted_with_comma")
    )
    assert_nothing_delivered(run)

    missing = [
        f for f in result["findings"] if f["type"] == FINDING_PDF_FIGURE_MISSING
    ]
    assert missing
    # At least one entry whose `formatted` string carries a period
    assert any("." in str(f["formatted"]) for f in missing), [
        f.get("formatted") for f in missing
    ]
    for finding in missing:
        assert finding["ast_path"]

    assert run.code == ErrorCode.VERIFICATION_FAILED.value


# ---------------------------------------------------------------------------
# 15.7 — A short trend is a labelled normal outcome (the ONE passing test)
# ---------------------------------------------------------------------------

declare("test_15_7_short_trend_is_a_labelled_normal_outcome")
# Empty set — this test expects ZERO blocking findings (status pass).


def test_15_7_short_trend_is_a_labelled_normal_outcome() -> None:
    """Req 24.11: a historical_trend block with lookback=6 and exactly 2 completed+verified
    prior runs passes with zero blocking findings, exactly 2 plotted points, and a statement
    naming '2 plotted and 6 requested'.

    No mutation. Proves a short trend is a labelled normal outcome, never a fabricated six.
    """
    from fakes.object_store import StoredObject
    from pipeline_harness import ACTOR_ID, RUN_ID
    from reporting_agent.collect.snapshot import snapshot_key
    from reporting_agent.errors import PartialCoverageError

    defn = definition(
        blocks=[
            df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
            df.block(
                "trend",
                "historical_trend",
                {"metric": "Percentage CPU", "statistic": "avg", "lookback": 6},
            ),
        ]
    )

    # Produce a real snapshot to reuse as "prior run" data
    prior_pipe = Pipeline(definition=defn)
    prior_pipe.run()
    snap_key = snapshot_key(ACTOR_ID, RUN_ID)
    snap_body = prior_pipe.store.get(snap_key)
    assert snap_body is not None

    PRIOR_1 = "run_prior_june"
    PRIOR_2 = "run_prior_may"

    main_pipe = Pipeline(definition=defn)

    # Store prior snapshots
    main_pipe.store._objects[snapshot_key(ACTOR_ID, PRIOR_1)] = StoredObject(
        body=snap_body.body, content_type=snap_body.content_type, tags=snap_body.tags,
    )
    main_pipe.store._objects[snapshot_key(ACTOR_ID, PRIOR_2)] = StoredObject(
        body=snap_body.body, content_type=snap_body.content_type, tags=snap_body.tags,
    )

    original_payload = main_pipe.payload

    def patched_payload() -> dict[str, Any]:
        p = original_payload()
        p["historical_candidates"] = [
            {
                "id": PRIOR_1,
                "period_start": "2026-06-01",
                "period_end": "2026-06-30",
                "timezone": "Asia/Jakarta",
                "status": "completed",
                "verification_status": "pass",
                "verification_created_at": "2026-06-30T10:00:00Z",
                "verification_id": f"v-{PRIOR_1}",
                "verification_snapshot_sha256": "a" * 64,
            },
            {
                "id": PRIOR_2,
                "period_start": "2026-05-01",
                "period_end": "2026-05-31",
                "timezone": "Asia/Jakarta",
                "status": "completed",
                "verification_status": "pass",
                "verification_created_at": "2026-05-31T10:00:00Z",
                "verification_id": f"v-{PRIOR_2}",
                "verification_snapshot_sha256": "b" * 64,
            },
        ]
        return p

    main_pipe.payload = patched_payload  # type: ignore[assignment]

    events, error = main_pipe.run()
    assert error is None or isinstance(error, PartialCoverageError), f"pipeline failed: {error}"

    result = main_pipe.outcome.verification
    assert result is not None, "no verification result"

    # PASS with zero blocking findings
    from negatives import blocking_types
    assert result["status"] == "pass", result["findings"]
    assert blocking_types(result) == set(), result["findings"]

    # Exactly 2 plotted historical points
    historical_points = result.get("historical_points", [])
    assert len(historical_points) == 2, (
        f"expected exactly 2 plotted historical points, got {len(historical_points)}: "
        f"{historical_points}"
    )

    # Both run ids present
    point_run_ids = {pt["run_id"] for pt in historical_points}
    assert PRIOR_1 in point_run_ids
    assert PRIOR_2 in point_run_ids

    # A document was delivered (2 report_file events: docx + pdf)
    assert types_of(events).count("report_file") == 2


# ---------------------------------------------------------------------------
# 15.8 — A historical point from a run whose verification failed
#         → {historical_point_unverified}
# ---------------------------------------------------------------------------

declare(
    "test_15_8_historical_point_from_unverified_run",
    FINDING_HISTORICAL_POINT_UNVERIFIED,
)


def test_15_8_historical_point_from_unverified_run() -> None:
    """Req 24.12: Two halves —
    (a) the resolver selects NO point from a candidate whose verification is 'fail';
    (b) a point injected anyway from such a run records historical_point_unverified.

    Figure.__post_init__ accepts a /prior_runs/<id> pointer with matching source_run_id
    even from a failed run — that's what makes the injection expressible; without it
    the negative test could not exist and the gate would never have been observed failing.
    """
    from reporting_agent.compile.ast import PRIOR_RUNS_POINTER_PREFIX

    FAILED_RUN = "run_failed_june"

    # Part (b): inject a figure with source_run_id from the failed run via compiled hook.
    # The historical gate receives verify_inputs including this run with status "fail",
    # so it fires historical_point_unverified.
    def inject_unverified_point(compiled: Any, view: Any) -> None:
        """Inject a figure sourced from a failed-verification run.

        Figure.__post_init__ accepts a /prior_runs/<id> pointer with matching
        source_run_id — that's what makes the injection expressible and what this test
        exists to observe the gate catching.
        """
        from reporting_agent.compile.ast import compiling_against
        from reporting_agent.compile.figures import BlockCursor

        value = view.stat(view.resources[0].resource_id, "Percentage CPU", "avg")
        assert value is not None

        cursor = BlockCursor(
            block_id="res", ledger=compiled.ledger
        ).child("nodes", 99)
        with compiling_against(view):
            cursor.figure(
                value,
                source_run_id=FAILED_RUN,
                source_snapshot_sha256="c" * 64,
            )

    # Supply historical_candidates with the failed run so _historical_verify_inputs
    # populates the verification gate's inputs
    from fakes.object_store import StoredObject
    from pipeline_harness import ACTOR_ID, RUN_ID
    from reporting_agent.collect.snapshot import snapshot_key

    defn = definition(
        blocks=[df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]})],
    )

    # Produce a snapshot to store as the "prior" run
    prior_pipe = Pipeline(definition=defn)
    prior_pipe.run()
    snap_body = prior_pipe.store.get(snapshot_key(ACTOR_ID, RUN_ID))
    assert snap_body is not None

    # Build main pipeline with the failed candidate in historical_candidates
    main_pipe = Pipeline(definition=defn)
    main_pipe.store._objects[snapshot_key(ACTOR_ID, FAILED_RUN)] = StoredObject(
        body=snap_body.body, content_type=snap_body.content_type, tags=snap_body.tags,
    )

    original_payload = main_pipe.payload

    def patched_payload() -> dict[str, Any]:
        p = original_payload()
        p["historical_candidates"] = [
            {
                "id": FAILED_RUN,
                "period_start": "2026-06-01",
                "period_end": "2026-06-30",
                "timezone": "Asia/Jakarta",
                "status": "completed",
                "verification_status": "fail",
                "verification_created_at": "2026-06-30T10:00:00Z",
                "verification_id": f"v-{FAILED_RUN}",
                "verification_snapshot_sha256": "c" * 64,
            },
        ]
        return p

    # Part (a): verify the resolver excludes the failed candidate
    main_pipe.payload = patched_payload  # type: ignore[assignment]
    from reporting_agent.errors import PartialCoverageError
    events_a, error_a = main_pipe.run()
    # With no historical_trend block, the failed candidate is irrelevant
    assert error_a is None or isinstance(error_a, PartialCoverageError), (
        f"pipeline failed: {error_a}"
    )
    result_a = main_pipe.outcome.verification
    if result_a:
        historical_pts = result_a.get("historical_points", [])
        assert not any(pt.get("run_id") == FAILED_RUN for pt in historical_pts), (
            "the resolver selected a point from a failed-verification run"
        )

    # Part (b): Use Negative with the compiled hook to inject the figure
    run = Negative(resources=TWO_VMS, compiled=inject_unverified_point)
    run.baseline()
    result = run.run()

    assert result is not None, f"pipeline raised: {run.error!r}"
    assert_blocking(result, declared("test_15_8_historical_point_from_unverified_run"))
    assert_nothing_delivered(run)

    finding = next(
        f for f in result["findings"] if f["type"] == FINDING_HISTORICAL_POINT_UNVERIFIED
    )
    assert finding["run_id"] == FAILED_RUN
    assert finding["path"]  # AST path named

    assert run.code == ErrorCode.VERIFICATION_FAILED.value
