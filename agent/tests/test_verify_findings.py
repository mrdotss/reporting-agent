"""The finding vocabulary, the result document, and the corpus the app parses.

The cross-language assertion this module owes task 9.1 is split across two suites on
purpose. Python writes the artifact and zod reads it, so proving they agree needs both
languages: this module **writes** a corpus covering every declared finding type and
every structural variation the writer can emit, and
`app/test/verification-result-corpus.static.test.ts` **parses** every file in it with
`verificationResultSchema`. Neither half can pass alone, which is the point — a field
this writer emits and that reader rejects fails the second suite rather than surfacing
as an unparseable artifact in a route handler at run time.

The corpus is regenerated on every run of this module rather than hand-maintained, so
it cannot drift from the builder that produces it; `git diff` after a change to
`findings.py` shows exactly what the app will now have to parse.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final

import pytest

from reporting_agent.redaction import discard_secrets, register_secrets
from reporting_agent.verify.findings import (
    ADVISORY_FINDING_TYPES,
    BLOCKING_FINDING_TYPES,
    DECLARED_FINDING_TYPES,
    EXCERPT_MAX_CHARS,
    FINDING_LIST_LIMIT,
    MESSAGE_MAX_CHARS,
    RESULT_SCHEMA_VERSION,
    SEVERITY_ADVISORY,
    SEVERITY_BLOCKING,
    DriftSample,
    Finding,
    FindingTypeError,
    ReplayOutcome,
    ResultFieldError,
    build_result,
    record_finding,
    severity_of,
    truncate_excerpt,
)

CORPUS_DIR: Final[Path] = (
    Path(__file__).resolve().parent / "fixtures" / "verification"
)

_DIGEST_A: Final[str] = "9f2c" + "0" * 60
_DIGEST_B: Final[str] = "4e1a" + "1" * 60
_DIGEST_C: Final[str] = "b7c0" + "2" * 60
_DIGEST_D: Final[str] = "2d55" + "3" * 60


def _replay(possible: bool = True) -> ReplayOutcome:
    if not possible:
        return {"possible": False, "objects_folded": 0, "objects_named": 87}
    return {
        "possible": True,
        "recomputed_sha256": _DIGEST_A,
        "stored_sha256": _DIGEST_A,
        "objects_folded": 87,
        "objects_named": 87,
    }


def _drift(n: int = 25) -> DriftSample:
    return {
        "n": n,
        "method": "document_named+top10_max+10pct",
        "seed": "a3f9" + "0" * 60,
        "not_requeried": [],
    }


def _result(findings: list[Finding], **overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "attempt_id": "ver_01JTESTATTEMPT",
        "run_id": "run_01JTESTRUN",
        "template_version_id": "tv_01JTESTVERSION",
        "figure_count": 1480,
        "snapshot_sha256": _DIGEST_A,
        "docx_sha256": _DIGEST_B,
        "pdf_sha256": _DIGEST_C,
        "ledger_sha256": _DIGEST_D,
        "counts": {"ledger_entries_checked": 1480, "numeric_tokens_extracted": 1655},
        "replay": _replay(),
        "drift_sample": _drift(),
        "findings": findings,
    }
    kwargs.update(overrides)
    return dict(build_result(**kwargs))


# --- the partition --------------------------------------------------------------------


def test_the_partition_is_twenty_three_blocking_and_four_advisory() -> None:
    assert len(BLOCKING_FINDING_TYPES) == 23
    assert len(ADVISORY_FINDING_TYPES) == 4
    assert len(DECLARED_FINDING_TYPES) == 27
    assert not set(BLOCKING_FINDING_TYPES) & set(ADVISORY_FINDING_TYPES)


@pytest.mark.parametrize("finding_type", BLOCKING_FINDING_TYPES)
def test_every_blocking_type_resolves_to_blocking(finding_type: str) -> None:
    assert severity_of(finding_type) == SEVERITY_BLOCKING


@pytest.mark.parametrize("finding_type", ADVISORY_FINDING_TYPES)
def test_every_advisory_type_resolves_to_advisory(finding_type: str) -> None:
    assert severity_of(finding_type) == SEVERITY_ADVISORY


def test_an_undeclared_type_is_refused_at_the_call_site() -> None:
    with pytest.raises(FindingTypeError, match="undeclared finding type"):
        record_finding("table_cell_mismatched", "typo in the type name")


def test_severity_is_never_accepted_from_the_caller() -> None:
    # A criterion cannot record a blocking defect as advisory: the partition decides.
    finding = record_finding("chart_hash_mismatch", "hash differs")
    assert finding["severity"] == SEVERITY_BLOCKING


# --- scrub then truncate --------------------------------------------------------------


def test_excerpt_fields_are_bounded_and_the_cut_is_marked() -> None:
    finding = record_finding(
        "table_cell_mismatch",
        "cell text differs",
        observed="x" * 500,
        expected="12.48%",
    )
    assert len(finding["observed"]) == EXCERPT_MAX_CHARS
    assert finding["observed"].endswith("…")
    assert finding["expected"] == "12.48%"


def test_message_is_bounded_at_its_own_larger_limit() -> None:
    finding = record_finding("unmatched_prose_token", "m" * 5000)
    assert len(finding["message"]) == MESSAGE_MAX_CHARS


def test_a_secret_is_scrubbed_before_truncation_can_split_it() -> None:
    """Truncating first would cut the secret and leave a fragment no pattern matches."""
    secret = "S3cr3t-" + "v" * 40
    token = register_secrets([secret])
    try:
        # Position the secret so a 200-character cut would land inside it.
        finding = record_finding(
            "table_cell_mismatch",
            "cell text differs",
            observed=("a" * 190) + secret + ("b" * 100),
        )
    finally:
        discard_secrets(token)
    assert secret not in finding["observed"]
    assert "v" * 20 not in finding["observed"]


def test_truncate_excerpt_never_exceeds_its_limit() -> None:
    for length in (0, 1, 199, 200, 201, 5000):
        assert len(truncate_excerpt("z" * length)) <= EXCERPT_MAX_CHARS


# --- field validation -----------------------------------------------------------------


def test_a_blank_message_is_refused() -> None:
    with pytest.raises(ResultFieldError, match="non-blank message"):
        record_finding("empty_scope", "   ")


def test_a_negative_locating_integer_is_refused() -> None:
    with pytest.raises(ResultFieldError, match="negative"):
        record_finding("unmatched_prose_token", "token survived", paragraph_ordinal=-1)


def test_a_bool_locating_field_is_refused() -> None:
    # bool is an int subclass, so an unguarded isinstance(raw, int) would let True
    # through as paragraph_ordinal=1.
    with pytest.raises(ResultFieldError, match="bool"):
        record_finding("unmatched_prose_token", "token survived", match_count=True)


@pytest.mark.parametrize(
    "field", ["attempt_id", "run_id", "template_version_id"]
)
def test_a_blank_identifier_is_refused(field: str) -> None:
    with pytest.raises(ResultFieldError, match=field):
        _result([], **{field: "  "})


@pytest.mark.parametrize(
    "bad", ["", "9f2c", "9F2C" + "0" * 60, "z" * 64, "0" * 63]
)
def test_a_malformed_digest_is_refused(bad: str) -> None:
    with pytest.raises(ResultFieldError, match="64 lowercase hex"):
        _result([], snapshot_sha256=bad)


def test_a_finding_whose_severity_contradicts_the_partition_is_refused() -> None:
    forged: Finding = {
        "type": "empty_scope",
        "severity": SEVERITY_ADVISORY,
        "message": "hand-built, wrong severity",
    }
    with pytest.raises(ResultFieldError, match="declared partition"):
        _result([forged])


# --- status derivation ----------------------------------------------------------------


def test_no_findings_passes() -> None:
    assert _result([])["status"] == "pass"


def test_one_blocking_finding_fails() -> None:
    doc = _result([record_finding("empty_scope", "zero resources in the union")])
    assert doc["status"] == "fail"
    assert doc["counts"]["blocking_findings_observed"] == 1


def test_advisory_findings_alone_still_pass() -> None:
    doc = _result(
        [
            record_finding("drift_observed", "0.02% on an open window"),
            record_finding("archive_incomplete", "one object failed to write"),
        ]
    )
    assert doc["status"] == "pass"
    assert doc["counts"]["advisory_findings_observed"] == 2
    assert doc["counts"]["blocking_findings_observed"] == 0


def test_status_derives_from_the_observed_count_not_the_truncated_list() -> None:
    """A document with more blocking findings than the list holds must still fail.

    This is the case a list-derived status gets wrong: the array is capped, so a
    verifier reading `len(findings)` would see the cap and could not tell a truncated
    catastrophe from a clean pass if the cap were ever zero — and more practically, a
    caller that retained none of its findings but observed thousands must not pass.
    """
    doc = _result(
        [],
        counts={"blocking_findings_observed": 1200, "advisory_findings_observed": 0},
    )
    assert doc["status"] == "fail"
    assert doc["findings"] == []
    assert doc["counts"]["blocking_findings_observed"] == 1200


def test_the_emitted_list_is_capped_while_the_count_stays_true() -> None:
    many = [
        record_finding("unmatched_prose_token", f"token {i} survived masking")
        for i in range(FINDING_LIST_LIMIT + 200)
    ]
    doc = _result(many)
    assert len(doc["findings"]) == FINDING_LIST_LIMIT
    assert doc["counts"]["blocking_findings_observed"] == FINDING_LIST_LIMIT + 200
    assert doc["status"] == "fail"


def test_document_order_is_preserved_and_never_re_sorted() -> None:
    ordered = [
        record_finding("table_rows_absent", "third", table_id="c"),
        record_finding("empty_scope", "first"),
        record_finding("chart_table_missing", "second", block_id="b"),
    ]
    doc = _result(ordered)
    assert [f["message"] for f in doc["findings"]] == ["third", "first", "second"]


# --- the corpus the app parses --------------------------------------------------------


def _corpus() -> dict[str, dict[str, Any]]:
    """Every structural variation the writer can emit, plus one of every declared type."""
    corpus: dict[str, dict[str, Any]] = {
        "pass-no-findings": _result([]),
        "pass-advisory-only": _result(
            [record_finding("drift_observed", "0.02% drift on an open window")]
        ),
        "fail-single-blocking": _result(
            [
                record_finding(
                    "ledger_entry_unrendered",
                    "a ledger figure reached no position in the document",
                    ast_path="tbl-7:3.2",
                    block_id="tbl-7",
                    formatted="12.48%",
                )
            ]
        ),
        "fail-every-locating-field": _result(
            [
                record_finding(
                    "table_cell_mismatch",
                    "the resolved cell holds a different string",
                    ast_path="tbl-3:1.4",
                    block_id="tbl-3",
                    table_id="utilization_by_vm",
                    row_key="web-01",
                    column_key="Average CPU",
                    match_count=1,
                    formatted="34.2%",
                    expected="34.2%",
                    observed="34.3%",
                    substring="34.3%",
                    region="body",
                    paragraph_ordinal=12,
                    resource_id="/subscriptions/x/resourceGroups/rg/vm/web-01",
                    snapshot_path="resources[3].metrics.cpu_percent.avg",
                )
            ]
        ),
        "fail-replay-impossible": _result(
            [record_finding("replay_hash_mismatch", "archive incomplete, replay skipped")],
            replay=_replay(possible=False),
        ),
        "pass-drift-sample-empty": _result(
            [], drift_sample={"n": 0, "method": "none", "seed": "0" * 64, "not_requeried": []}
        ),
        "pass-drift-not-requeried": _result(
            [],
            drift_sample={
                "n": 3,
                "method": "document_named+top10_max+10pct",
                "seed": "beef" + "0" * 60,
                "not_requeried": ["/subscriptions/x/rg/vm-gone"],
            },
        ),
        "fail-truncated-excerpt": _result(
            [
                record_finding(
                    "unmatched_prose_token",
                    "a numeric token survived every masking stage",
                    substring="9" * 500,
                    region="body",
                    paragraph_ordinal=4,
                )
            ]
        ),
        "fail-counts-exceed-list": _result(
            [record_finding("pdf_figure_missing", "a ledger string is absent from the PDF")],
            counts={"blocking_findings_observed": 1200, "pdf_entries_checked": 1480},
        ),
    }
    # One document carrying exactly one finding of every declared type, so the app-side
    # parse covers the whole vocabulary rather than the handful the cases above use.
    every = [
        record_finding(name, f"declared-type coverage for {name}")
        for name in (*BLOCKING_FINDING_TYPES, *ADVISORY_FINDING_TYPES)
    ]
    corpus["fail-every-declared-type"] = _result(every)
    return corpus


def test_the_corpus_is_written_for_the_app_suite_to_parse() -> None:
    CORPUS_DIR.mkdir(parents=True, exist_ok=True)
    written = _corpus()
    for name, document in written.items():
        path = CORPUS_DIR / f"{name}.json"
        path.write_text(
            json.dumps(document, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    # Non-vacuity, twice: the corpus is not empty, and it covers the whole vocabulary.
    # A corpus the app parses cleanly because it contains nothing proves nothing.
    assert len(written) >= 9
    covered = {
        finding["type"]
        for document in written.values()
        for finding in document["findings"]
    }
    assert covered == DECLARED_FINDING_TYPES, sorted(DECLARED_FINDING_TYPES - covered)
    assert {d["status"] for d in written.values()} == {"pass", "fail"}


def test_every_corpus_document_carries_the_declared_schema_version() -> None:
    for document in _corpus().values():
        assert document["schema_version"] == RESULT_SCHEMA_VERSION
