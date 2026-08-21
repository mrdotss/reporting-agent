"""The remaining blocking finding types, one test each (Req 44.1, 44.9 through 44.11).

N1 through N6 in `test_negative_gates.py` cover six of the sixteen blocking types the
glossary declares. This module covers the rest, built the same way and through the same
harness: the unmutated fixture is asserted passing, exactly one mutation is applied, the
recorded blocking set is asserted **equal** to the declared set, and nothing is delivered.

Two of them are worth reading before the others, because what they turned up is not a test
result but a fact about the implementation:

* :func:`test_a_ledger_entry_with_nothing_rendered_behind_it_fails` cannot be provoked by
  editing the rendered document, and that is Req 29.8 working: every figure a block compiles
  today is anchored into a data table, so deleting its rendered text faults the anchored pass
  and completeness correctly stands down. The defect is therefore injected into the ledger.
* :func:`test_an_unresolvable_union_scope_fails_closed` reaches `coverage_resource_absent`
  through the only branch a run can take. Its docstring explains why the other branch is
  unreachable, which is a finding about Req 32.2 rather than about this test.
"""

from __future__ import annotations

import copy
import gzip
import io
import json
from typing import Any, Final

from docx import Document as open_docx
from docx.oxml.ns import qn

# Imported first: it performs the `os.environ` bootstrap `reporting_agent.main` reads at
# import, so nothing under `reporting_agent` may be imported above it.
from negatives import (
    Negative,
    assert_blocking,
    assert_nothing_delivered,
    captioned_tables,
    clone_table,
    declare,
    declared,
    drop_table,
    set_cell_text,
)
from pipeline_harness import definition, df
from reporting_agent.collect.archive import ARCHIVE_KIND_METRICS, archive_kind_of
from reporting_agent.errors import ErrorCode
from reporting_agent.verify.findings import (
    FINDING_CHART_TABLE_MISSING,
    FINDING_COVERAGE_RESOURCE_ABSENT,
    FINDING_DUPLICATE_TABLE_ANCHOR,
    FINDING_EMPTY_SCOPE,
    FINDING_LEDGER_ENTRY_UNRENDERED,
    FINDING_PDF_FIGURE_MISSING,
    FINDING_REPLAY_HASH_MISMATCH,
    FINDING_SCOPE_UNVERIFIED,
    FINDING_TABLE_ANCHOR_MISSING,
    FINDING_TABLE_ANCHOR_UNEXPECTED,
    FINDING_TABLE_COLUMN_UNRESOLVED,
    FINDING_TABLE_ROW_UNRESOLVED,
)

TWO_VMS: Final[tuple[str, ...]] = ("prod-web-01", "prod-sql-01")

TABLE_ONLY: Final[dict[str, Any]] = definition(
    blocks=[df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]})]
)

# A second block, so a mutation that removes the first table still leaves a document with
# text in it. Req 33.7 refuses a `.pdf` that yields zero characters while the ledger is
# non-empty — correctly, since that is a conversion that failed without failing — and a
# one-block fixture would trip that refusal instead of the gate under test.
TWO_BLOCKS: Final[dict[str, Any]] = definition(
    blocks=[
        df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
        df.block("kpi", "kpi_row", {"metrics": [df.CPU_AVG]}),
    ]
)

WITH_CHART: Final[dict[str, Any]] = definition(
    blocks=[
        df.block("res", "resource_table", {"columns": [df.CPU_AVG]}),
        df.block("spread", "distribution_chart", {"metrics": [df.CPU_AVG]}),
    ]
)


def negative(*, definition_used: dict[str, Any] | None = None, **kwargs: Any) -> Negative:
    run = Negative(
        resources=TWO_VMS, definition=definition_used or TABLE_ONLY, **kwargs
    )
    run.baseline()
    return run


def only(result: Any, finding_type: str) -> Any:
    matches = [f for f in result["findings"] if f["type"] == finding_type]
    assert len(matches) == 1, f"expected exactly one {finding_type}; got {len(matches)}"
    return matches[0]


def check(name: str, run: Negative) -> Any:
    """The three assertions every negative test in this section makes."""
    result = run.run()
    assert result is not None, run.error
    assert_blocking(result, declared(name))
    assert_nothing_delivered(run)
    return result


# --------------------------------------------------------------------------- #
# The anchored pass's four remaining refusals
# --------------------------------------------------------------------------- #

declare(
    "test_a_missing_data_table_fails",
    FINDING_TABLE_ANCHOR_MISSING,
    FINDING_PDF_FIGURE_MISSING,
)


def test_a_missing_data_table_fails() -> None:
    """A whole section that did not reach the document.

    The ledger still registers the anchors; the table they name is gone. This is the shape a
    dropped block takes in a delivered report — the reader sees a document that reads
    complete, because nothing in it says a section is missing.
    """
    run = negative(definition_used=TWO_BLOCKS, docx=drop_table)
    result = check("test_a_missing_data_table_fails", run)

    # One per anchor the dropped table carried — two rows by two columns.
    findings = [
        f for f in result["findings"] if f["type"] == FINDING_TABLE_ANCHOR_MISSING
    ]
    assert len(findings) == 4, findings
    for finding in findings:
        assert finding["table_id"]
        assert finding["ast_path"]
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


declare("test_an_unregistered_captioned_table_fails", FINDING_TABLE_ANCHOR_UNEXPECTED)


def test_an_unregistered_captioned_table_fails() -> None:
    """A data table the ledger never registered.

    The inverse of the missing anchor, and the reason both directions are checked: a table
    carrying a caption identity is a table the verifier is supposed to be able to resolve, so
    one it cannot account for is a set of numbers no gate in this package is reading.
    """
    run = negative(docx=_add_unregistered_table)
    result = check("test_an_unregistered_captioned_table_fails", run)

    assert only(result, FINDING_TABLE_ANCHOR_UNEXPECTED)["table_id"] == GHOST_IDENTITY
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


declare("test_a_renamed_column_header_fails", FINDING_TABLE_COLUMN_UNRESOLVED)


def test_a_renamed_column_header_fails() -> None:
    """A column key that resolves to no column.

    Req 27.9 resolves a column by exact equality of header text and by nothing else — no
    ordinal, no prefix, no case folding, no similarity. This is that decision observed
    failing: a header the renderer changed leaves the anchor with no cell to compare, and the
    verifier says so instead of falling back to position.
    """
    run = negative(docx=lambda payload: _rewrite_header(payload, "Something Else"))
    result = check("test_a_renamed_column_header_fails", run)

    findings = [
        f for f in result["findings"] if f["type"] == FINDING_TABLE_COLUMN_UNRESOLVED
    ]
    assert findings
    for finding in findings:
        assert finding["column_key"]
        assert finding["match_count"] == 0
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


declare("test_a_renamed_row_key_fails", FINDING_TABLE_ROW_UNRESOLVED)


def test_a_renamed_row_key_fails() -> None:
    """A row key that resolves to no row — the same refusal, on the other axis."""
    run = negative(docx=lambda payload: _rewrite_row_key(payload, "not-a-resource"))
    result = check("test_a_renamed_row_key_fails", run)

    # One per anchor pointing at that row — two columns, so two findings. Asserted as a
    # count rather than as a presence, because a pass that recorded one and stopped would be
    # Req 27.12's "every blocking finding, never the first" quietly broken.
    findings = [
        f for f in result["findings"] if f["type"] == FINDING_TABLE_ROW_UNRESOLVED
    ]
    assert len(findings) == 2, findings
    for finding in findings:
        assert finding["row_key"]
        assert finding["match_count"] == 0
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


declare(
    "test_two_tables_sharing_one_caption_identity_fail",
    FINDING_DUPLICATE_TABLE_ANCHOR,
    FINDING_TABLE_ANCHOR_MISSING,
)


def test_two_tables_sharing_one_caption_identity_fail() -> None:
    """Two tables, one identity, so an anchor naming it resolves to neither.

    `table_anchor_missing` is declared alongside it because that is the honest consequence:
    once the identity is ambiguous there is no single table for the anchors to resolve
    against, and the anchored pass says both things rather than picking one.
    """
    run = negative(docx=clone_table)
    result = check("test_two_tables_sharing_one_caption_identity_fail", run)

    finding = only(result, FINDING_DUPLICATE_TABLE_ANCHOR)
    assert finding["table_id"]
    assert "2 data tables" in str(finding["message"])
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


# --------------------------------------------------------------------------- #
# The chart's other gate
# --------------------------------------------------------------------------- #

declare(
    "test_a_chart_with_no_companion_table_fails",
    FINDING_CHART_TABLE_MISSING,
    FINDING_TABLE_ANCHOR_MISSING,
)


def test_a_chart_with_no_companion_table_fails() -> None:
    """The image survives; the numbers beside it do not.

    Req 30.5 requires **both** chart gates, and this is why the hash gate alone is not
    enough: the sidecar still matches the ledger exactly, so the picture is provably drawn
    from the right numbers — and there is no longer anything in the document a reader or a
    verifier can check it against.
    """
    run = negative(definition_used=WITH_CHART, docx=_drop_last_table)
    result = check("test_a_chart_with_no_companion_table_fails", run)

    finding = only(result, FINDING_CHART_TABLE_MISSING)
    assert finding["ast_path"]
    assert finding["table_id"]
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


# --------------------------------------------------------------------------- #
# Completeness, backwards
# --------------------------------------------------------------------------- #

declare(
    "test_a_ledger_entry_with_nothing_rendered_behind_it_fails",
    FINDING_LEDGER_ENTRY_UNRENDERED,
    FINDING_PDF_FIGURE_MISSING,
)


def test_a_ledger_entry_with_nothing_rendered_behind_it_fails() -> None:
    """A compiled figure the renderer never emitted (Req 44.10).

    Injected into the ledger rather than provoked through the document, and the reason is
    itself the interesting part. Every block compiles its figures into a data table, so
    removing a figure's rendered text faults the anchored pass — and Req 29.8 then has
    completeness deliberately record nothing, so that one rendering defect yields one
    finding. The only state that reaches this gate is a ledger entry with no anchored
    position at all, which is exactly the compiler-emitted-it, renderer-dropped-it defect the
    gate exists for.

    The value chosen is the fixture's `p95`, which the definition selects as a metric but no
    block renders as a column, so its `formatted` string is absent from the document by
    construction rather than by arrangement.
    """
    run = negative(compiled=_mint_ghost_figure)
    result = check("test_a_ledger_entry_with_nothing_rendered_behind_it_fails", run)

    finding = only(result, FINDING_LEDGER_ENTRY_UNRENDERED)
    assert str(finding["ast_path"]).startswith(GHOST_BLOCK)
    assert result["counts"]["ledger_entries_unrendered"] == 1
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


# --------------------------------------------------------------------------- #
# Replay
# --------------------------------------------------------------------------- #

declare("test_one_mutated_archived_decimal_fails_the_replay", FINDING_REPLAY_HASH_MISMATCH)


def test_one_mutated_archived_decimal_fails_the_replay() -> None:
    """Req 44.9 — one decimal string, in one archived response, before the replay.

    The stored `snapshot_id`, the archive sequence and the count of archived objects are all
    left alone, so the only thing that changed is a number inside one recorded response. The
    document still matches the snapshot perfectly; what fails is that the snapshot is no
    longer reproducible from its own inputs, which is a different claim and carries a
    different terminal code.
    """
    run = negative(archive=_mutate_one_archived_decimal)
    result = check("test_one_mutated_archived_decimal_fails_the_replay", run)

    finding = only(result, FINDING_REPLAY_HASH_MISMATCH)
    message = str(finding["message"])
    # Both digests reported, so a reviewer can tell which stored artifact to look at.
    assert result["replay"]["possible"] is True
    assert result["replay"]["objects_folded"] == result["replay"]["objects_named"]
    assert finding["expected"] and finding["observed"]
    assert str(finding["expected"]) != str(finding["observed"])
    assert "archived object" in message

    # Req 44.9's terminal code. `VERIFICATION_FAILED` would say the document disagrees with
    # the snapshot, and it does not.
    assert run.code == ErrorCode.REPLAY_MISMATCH.value


# --------------------------------------------------------------------------- #
# The snapshot's own three
# --------------------------------------------------------------------------- #

declare(
    "test_a_snapshot_with_an_unproven_scope_fails",
    FINDING_SCOPE_UNVERIFIED,
    FINDING_REPLAY_HASH_MISMATCH,
)


def test_a_snapshot_with_an_unproven_scope_fails() -> None:
    """Req 44.11 — at least one resource, and `scope_verified` false.

    The additional assertion the requirement asks for is the one that matters: **no
    `empty_scope` finding**. The snapshot carries two resources, so the recorded failure is
    attributable to the unproven scope rather than to a snapshot with nothing in it — which
    is the confusion that would let a reader dismiss this as the empty-report case.

    `replay_hash_mismatch` is declared too, and honestly: a snapshot edited after collection
    no longer matches what its own archived responses fold to, and the replay gate says so.
    That is the gate working, not interference — but Req 44.14 is a set equality, so it is
    declared rather than tolerated.
    """
    run = negative(snapshot=lambda document: {**document, "scope_verified": False})
    result = check("test_a_snapshot_with_an_unproven_scope_fails", run)

    assert FINDING_EMPTY_SCOPE not in {f["type"] for f in result["findings"]}
    assert result["counts"]["snapshot_resources"] == len(TWO_VMS)

    # `VERIFICATION_FAILED`, not `REPLAY_MISMATCH`, and the distinction is deliberate: the
    # narrower code is reported only when a replay mismatch is the *only* kind of blocking
    # finding. Here the scope is also unproven, and a code naming only the replay would send
    # a reader to the archive for a failure that is not in it.
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


declare(
    "test_a_snapshot_carrying_no_resources_fails_at_verification",
    FINDING_EMPTY_SCOPE,
    FINDING_REPLAY_HASH_MISMATCH,
)


def test_a_snapshot_carrying_no_resources_fails_at_verification() -> None:
    """Req 32.4 — the *verification* gate, distinct from N6's collection gate.

    N6 proves a run whose inventory finds nothing ends before a snapshot exists. This proves
    the second net under it: a snapshot that reaches a verification carrying zero resources
    fails there too. Both are needed, because a re-verification of a stored snapshot never
    passes through the collection gate at all.
    """
    run = negative(snapshot=lambda document: {**document, "resources": []})
    result = check("test_a_snapshot_carrying_no_resources_fails_at_verification", run)

    assert result["counts"]["snapshot_resources"] == 0
    assert run.code == ErrorCode.VERIFICATION_FAILED.value


declare(
    "test_an_unresolvable_union_scope_fails_closed", FINDING_COVERAGE_RESOURCE_ABSENT
)


def test_an_unresolvable_union_scope_fails_closed() -> None:
    """Req 32.2's fail-closed branch, and two findings about the gate itself.

    **The per-resource branch of `coverage_resource_absent` cannot fire.** Req 32.5 requires
    coverage to be derived "from the snapshot and the pinned template version alone", so
    `check_coverage` resolves the union against the same `SnapshotView` it reads the present
    set from — and a resolver that filters `view.resources` cannot return a resource
    `view.resources` does not contain. The union is a subset of the present set on every
    input, so no identifier is ever absent. The branch is unreachable by construction, not by
    accident, and no mutation of a run can reach it.

    **The other branch cannot be reached through a whole verification either**, and the
    second half of this test is what establishes that. A pinned version whose scope will not
    parse is also the version the allowlist derivation renders against (Req 28.7), and that
    derivation runs at the prose gate — *before* coverage — where it raises rather than
    recording. So a run handed such a version fails on the allowlist and coverage never
    executes.

    What is left, and what the first half asserts, is the pass at its own boundary: handed a
    version it cannot resolve, `check_coverage` records `coverage_resource_absent` and fails
    closed rather than deriving an empty union and reporting complete coverage. That is the
    behaviour Req 32.2 is really carrying.
    """
    import snapshot_factory as sf
    from reporting_agent.compile.snapshot_view import build_snapshot_view
    from reporting_agent.verify.coverage import check_coverage
    from reporting_agent.verify.findings import SEVERITY_BLOCKING

    snapshot = sf.two_vm_snapshot()
    view = build_snapshot_view(snapshot)
    unresolvable = {**TABLE_ONLY, "scope": {"tag_filters": "not-a-list"}}

    outcome = check_coverage(snapshot, view=view, definition=unresolvable)

    blocking = {
        str(finding["type"])
        for finding in outcome.findings
        if finding.get("severity") == SEVERITY_BLOCKING
    }
    assert blocking == declared("test_an_unresolvable_union_scope_fails_closed"), blocking
    assert outcome.union_resource_count == 0
    assert outcome.snapshot_resource_count == len(view.resources) > 0
    assert "could not be resolved" in str(outcome.findings[0]["message"])

    # The second half: the same version through a whole run. It fails and delivers nothing —
    # at the allowlist rather than at coverage, which is the preemption the docstring names.
    run = Negative(
        resources=TWO_VMS,
        definition=TABLE_ONLY,
        verified_definition=lambda pinned: unresolvable,
    )
    run.baseline()
    assert run.run() is None
    assert run.code == ErrorCode.VERIFICATION_FAILED.value
    assert_nothing_delivered(run)


# --------------------------------------------------------------------------- #
# Mutations
# --------------------------------------------------------------------------- #

GHOST_IDENTITY: Final[str] = "tbl:ghost:0"
GHOST_BLOCK: Final[str] = "ghost"


def _add_unregistered_table(payload: bytes) -> bytes:
    """Copy a data table and give the copy a caption identity the ledger never saw."""
    document = open_docx(io.BytesIO(payload))
    original = captioned_tables(document)[0]
    duplicate = copy.deepcopy(original)
    for node in duplicate.iter(qn("w:tblCaption")):
        node.set(qn("w:val"), GHOST_IDENTITY)
    original.addnext(duplicate)
    return _save(document)


def _rewrite_header(payload: bytes, text: str) -> bytes:
    document = open_docx(io.BytesIO(payload))
    header = captioned_tables(document)[0].findall(qn("w:tr"))[0]
    set_cell_text(header.findall(qn("w:tc"))[-1], text)
    return _save(document)


def _rewrite_row_key(payload: bytes, text: str) -> bytes:
    document = open_docx(io.BytesIO(payload))
    first_data_row = captioned_tables(document)[0].findall(qn("w:tr"))[1]
    # The key column is the first, which is `verify/anchors.py`'s KEY_COLUMN_ORDINAL.
    set_cell_text(first_data_row.findall(qn("w:tc"))[0], text)
    return _save(document)


def _drop_last_table(payload: bytes) -> bytes:
    """Drop the chart's companion table, which the emitter writes after the chart."""
    document = open_docx(io.BytesIO(payload))
    return drop_table(payload, table=len(captioned_tables(document)) - 1)


def _mint_ghost_figure(compiled: Any, view: Any) -> None:
    """Add one figure to the ledger that no node of the document carries."""
    import snapshot_factory as sf
    from reporting_agent.compile.ast import compiling_against
    from reporting_agent.compile.figures import BlockCursor

    value = view.stat(view.resources[0].resource_id, sf.CPU, "p95")
    assert value is not None, "the fixture's snapshot carries no p95 to mint from"
    with compiling_against(view):
        BlockCursor(block_id=GHOST_BLOCK, ledger=compiled.ledger).child(
            "nodes", 0
        ).figure(value)


def _mutate_one_archived_decimal(
    objects: tuple[tuple[int, bytes], ...],
) -> tuple[tuple[int, bytes], ...]:
    """Change one decimal string in one archived response, and nothing else.

    The object count and the sequence ordinals are preserved exactly, because Req 44.9 makes
    those the controls: an archive short an object is an *inability* to replay, which the gate
    correctly reports as advisory rather than as a mismatch, and a test that shortened the
    archive would be exercising the wrong branch.
    """
    assert objects, "the run archived nothing, so there is no response to mutate"
    # The **first metrics response**, not the first object: the inventory query projects the
    # catalog's declared facts, so its Resource Graph page is archived too (Req 7.1) and
    # sorts first by sequence. Picked by the object's declared `kind`, because a page of
    # inventory carries no metric decimal to move and the loop below would find nothing.
    index = next(
        (
            position
            for position, (_, candidate) in enumerate(objects)
            if archive_kind_of(json.loads(gzip.decompress(candidate)))
            == ARCHIVE_KIND_METRICS
        ),
        None,
    )
    assert index is not None, "the run archived no metrics response to mutate"
    ordinal, body = objects[index]
    text = gzip.decompress(body).decode("utf-8")
    for original, replacement in (("720.0", "999.0"), ("720", "999")):
        if original in text:
            text = text.replace(original, replacement, 1)
            break
    else:  # pragma: no cover - the fake's canned response always carries one
        raise AssertionError("no decimal string found in the first archived response")
    mutated = list(objects)
    mutated[index] = (ordinal, gzip.compress(text.encode("utf-8")))
    return tuple(mutated)


def _save(document: Any) -> bytes:
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()
