"""The finding vocabulary and the verification result document.

**Severity travels on the finding** (Req 25.6). A reader never derives "is this
blocking?" from `type`, because that would put the answer in a lookup table the app
would have to keep in sync with this module by hand — and the day the agent declares a
twenty-first type, an older app build would meet a finding it cannot classify and
either drop it or miscount it. Carrying `severity` in the record means an unrecognised
type still lands under the right classification and still counts. `result.ts` validates
`type` as an open string for the same reason, so this module is the *only* place the
partition is declared, and `record_finding` is the only way to build one.

**Every blocking finding is recorded, not the first** (Req 25.8). A verifier that
stops at the first mismatch turns one broken document into as many round-trips as it
has defects. The emitted list is bounded at :data:`FINDING_LIST_LIMIT` entries in the
document order the caller already produced — this module never re-sorts, because
`result.ts` does not either and a re-order at one end would silently disagree with the
panel at the other — while `counts.blocking_findings_observed` and
`counts.advisory_findings_observed` always carry the **true** totals. That split is
what lets :func:`build_result` derive `status` from the observed counts rather than
from the truncated list: a document with 1,200 blocking findings must not pass because
the 1,001st was dropped from an array.

**Scrub, then truncate, and in that order.** A finding message can quote document text
or a service error, so the redaction pass runs before the artifact is written and
before it is emitted (Req 36.3, 43.7). Truncating first would let a 200-character cut
land mid-secret, leaving a fragment the scrubber's pattern no longer matches — so
:func:`record_finding` scrubs each field and only then bounds it. :func:`build_result`
additionally runs `scrub_deep` over the whole assembled document, which is redundant
for anything built through `record_finding` and deliberately so: it is the gate that
still holds if a caller ever assembles a finding dict by hand.

**What this module does not decide:** which finding type applies to a given defect, or
what a criterion's locating fields should read. Those are pass decisions —
`verify/tokens.py` knows it is recording `unmatched_prose_token`, `verify/replay.py`
knows it is recording `replay_hash_mismatch` — made by the passes that tasks 9.2
onward fill in. This module is the narrow gate every one of them passes through,
refusing an undeclared type or a blank required field before a malformed finding can
reach an artifact the app then fails to parse.
"""

from __future__ import annotations

from typing import Any, Final, Literal, TypedDict, cast

from reporting_agent.redaction import scrub, scrub_deep

__all__ = [
    "ADVISORY_FINDING_TYPES",
    "BLOCKING_FINDING_TYPES",
    "DECLARED_FINDING_TYPES",
    "EXCERPT_MAX_CHARS",
    "FINDING_FACT_SOURCE_MISSING",
    "FINDING_HISTORICAL_POINT_OVERLAPPING",
    "FINDING_HISTORICAL_POINT_UNVERIFIED",
    "FINDING_LIST_LIMIT",
    "FINDING_STYLED_PDF_FIGURE_MISSING",
    "FINDING_TEXT_FACT_ANCHOR_MISSING",
    "FINDING_TEXT_FACT_MISMATCH",
    "FINDING_TEXT_FACT_UNANCHORED",
    "FINDING_TOC_PAGE_MISMATCH",
    "MESSAGE_MAX_CHARS",
    "RESULT_SCHEMA_VERSION",
    "SEVERITY_ADVISORY",
    "SEVERITY_BLOCKING",
    "DriftSample",
    "Finding",
    "FindingTypeError",
    "ReplayOutcome",
    "ResultFieldError",
    "VerificationCounts",
    "VerificationResult",
    "build_result",
    "record_finding",
    "severity_of",
    "truncate_excerpt",
]

# --- the artifact's own schema version ------------------------------------------------
#
# Distinct from a template definition's `schema_version`. `result.ts` validates this as
# an integer >= 1 rather than the literal 1, so bumping it here is a forward-compatible
# change at the app boundary rather than a parse failure.

RESULT_SCHEMA_VERSION: Final[int] = 1

# --- severity -------------------------------------------------------------------------

SEVERITY_BLOCKING: Final[str] = "blocking"
SEVERITY_ADVISORY: Final[str] = "advisory"

Severity = Literal["blocking", "advisory"]

# --- the twenty-three blocking types (Req 44.1's enumeration) -------------------------
#
# Each is asserted by at least one negative test in task 14, and task 14.8's meta-test
# fails if any type declared here is asserted by none of them — so a type added to this
# tuple without a test that observes it failing breaks the suite rather than sitting
# declared and unexercised.

FINDING_UNMATCHED_PROSE_TOKEN: Final[str] = "unmatched_prose_token"
FINDING_TABLE_ANCHOR_MISSING: Final[str] = "table_anchor_missing"
FINDING_TABLE_ANCHOR_UNEXPECTED: Final[str] = "table_anchor_unexpected"
FINDING_TABLE_CELL_MISMATCH: Final[str] = "table_cell_mismatch"
FINDING_TABLE_COLUMN_UNRESOLVED: Final[str] = "table_column_unresolved"
FINDING_TABLE_ROW_UNRESOLVED: Final[str] = "table_row_unresolved"
FINDING_DUPLICATE_TABLE_ANCHOR: Final[str] = "duplicate_table_anchor"
FINDING_TABLE_ROWS_ABSENT: Final[str] = "table_rows_absent"
FINDING_LEDGER_ENTRY_UNRENDERED: Final[str] = "ledger_entry_unrendered"
FINDING_CHART_TABLE_MISSING: Final[str] = "chart_table_missing"
FINDING_CHART_HASH_MISMATCH: Final[str] = "chart_hash_mismatch"
FINDING_REPLAY_HASH_MISMATCH: Final[str] = "replay_hash_mismatch"
FINDING_COVERAGE_RESOURCE_ABSENT: Final[str] = "coverage_resource_absent"
FINDING_PDF_FIGURE_MISSING: Final[str] = "pdf_figure_missing"
FINDING_SCOPE_UNVERIFIED: Final[str] = "scope_unverified"
FINDING_EMPTY_SCOPE: Final[str] = "empty_scope"

# --- the seven blocking types the breadth-and-document spec adds ----------------------

FINDING_TEXT_FACT_MISMATCH: Final[str] = "text_fact_mismatch"
FINDING_TEXT_FACT_ANCHOR_MISSING: Final[str] = "text_fact_anchor_missing"
FINDING_TEXT_FACT_UNANCHORED: Final[str] = "text_fact_unanchored"
FINDING_HISTORICAL_POINT_UNVERIFIED: Final[str] = "historical_point_unverified"
FINDING_HISTORICAL_POINT_OVERLAPPING: Final[str] = "historical_point_overlapping"
FINDING_TOC_PAGE_MISMATCH: Final[str] = "toc_page_mismatch"
FINDING_FACT_SOURCE_MISSING: Final[str] = "fact_source_missing"
FINDING_DERIVED_COUNT_MISMATCH: Final[str] = "derived_count_mismatch"

BLOCKING_FINDING_TYPES: Final[tuple[str, ...]] = (
    FINDING_UNMATCHED_PROSE_TOKEN,
    FINDING_TABLE_ANCHOR_MISSING,
    FINDING_TABLE_ANCHOR_UNEXPECTED,
    FINDING_TABLE_CELL_MISMATCH,
    FINDING_TABLE_COLUMN_UNRESOLVED,
    FINDING_TABLE_ROW_UNRESOLVED,
    FINDING_DUPLICATE_TABLE_ANCHOR,
    FINDING_TABLE_ROWS_ABSENT,
    FINDING_LEDGER_ENTRY_UNRENDERED,
    FINDING_CHART_TABLE_MISSING,
    FINDING_CHART_HASH_MISMATCH,
    FINDING_REPLAY_HASH_MISMATCH,
    FINDING_COVERAGE_RESOURCE_ABSENT,
    FINDING_PDF_FIGURE_MISSING,
    FINDING_SCOPE_UNVERIFIED,
    FINDING_EMPTY_SCOPE,
    FINDING_TEXT_FACT_MISMATCH,
    FINDING_TEXT_FACT_ANCHOR_MISSING,
    FINDING_TEXT_FACT_UNANCHORED,
    FINDING_HISTORICAL_POINT_UNVERIFIED,
    FINDING_HISTORICAL_POINT_OVERLAPPING,
    FINDING_TOC_PAGE_MISMATCH,
    FINDING_FACT_SOURCE_MISSING,
    FINDING_DERIVED_COUNT_MISMATCH,
)

# --- the four advisory types ----------------------------------------------------------
#
# Advisory means observed and reported, never delivery-blocking. `drift_observed` is
# advisory because a re-query of an open window legitimately drifts (see
# azure-integration.md); `archive_incomplete` because a run whose archive write failed
# still produced a correct snapshot from folded points.

FINDING_ARCHIVE_INCOMPLETE: Final[str] = "archive_incomplete"
FINDING_DRIFT_OBSERVED: Final[str] = "drift_observed"
FINDING_PROSE_REVIEW_FINDING: Final[str] = "prose_review_finding"
FINDING_FIDELITY_NOT_COMPARABLE: Final[str] = "fidelity_not_comparable"

FINDING_STYLED_PDF_FIGURE_MISSING: Final[str] = "styled_pdf_figure_missing"
"""A figure the styled reading copy does not carry locatably.

**Advisory**, where the same fault in the converted `.pdf` is blocking, and the difference
is which document it is about. The `.docx` and its LibreOffice conversion are the delivered
pair Req 23.1 describes; the styled PDF is a third artifact, a reading copy of the same
compiled AST laid out by a stylesheet. A figure missing from it is a real defect and says
so, but withholding a document that verified — every figure traced, every gate passed — over
the layout of its reading copy would be the wrong trade. The styled copy is simply not
presented, and the finding records why."""

ADVISORY_FINDING_TYPES: Final[tuple[str, ...]] = (
    FINDING_ARCHIVE_INCOMPLETE,
    FINDING_DRIFT_OBSERVED,
    FINDING_PROSE_REVIEW_FINDING,
    FINDING_FIDELITY_NOT_COMPARABLE,
    FINDING_STYLED_PDF_FIGURE_MISSING,
)

DECLARED_FINDING_TYPES: Final[frozenset[str]] = frozenset(
    BLOCKING_FINDING_TYPES + ADVISORY_FINDING_TYPES
)

_SEVERITY_BY_TYPE: Final[dict[str, str]] = {
    **dict.fromkeys(BLOCKING_FINDING_TYPES, SEVERITY_BLOCKING),
    **dict.fromkeys(ADVISORY_FINDING_TYPES, SEVERITY_ADVISORY),
}

# --- bounds ---------------------------------------------------------------------------

EXCERPT_MAX_CHARS: Final[int] = 200
"""Req 36.3 — every quoted document excerpt is bounded at 200 characters."""

MESSAGE_MAX_CHARS: Final[int] = 2000
"""`result.ts`'s own bound on `message`. Restated here so the writer cannot emit a
message the reader would reject; the two are one number in two languages, and the
cross-language fixture test in `tests/test_verify_findings.py` is what keeps them
agreeing."""

FINDING_LIST_LIMIT: Final[int] = 1000
"""Req 25.8 — the emitted list is bounded; `counts` still carries the true totals.

The cap applies to the whole ordered list rather than to blocking findings alone. A
document carrying a thousand blocking findings is catastrophically broken and its
advisories are not the reader's problem, whereas a severity-partitioned cap would
reorder the list to fill two quotas and lose the document order Req 27.14 declares."""

_TRUNCATION_MARKER: Final[str] = "…"

# Fields holding text quoted from a document, a ledger or a service error. Bounded at
# EXCERPT_MAX_CHARS; `message` is bounded separately at MESSAGE_MAX_CHARS because it is
# a description that may *contain* an excerpt rather than being one.
_EXCERPT_FIELDS: Final[tuple[str, ...]] = (
    "formatted",
    "expected",
    "observed",
    "substring",
)


class FindingTypeError(ValueError):
    """An undeclared finding type reached :func:`record_finding`."""


class ResultFieldError(ValueError):
    """A required result field was absent, blank or malformed."""


# --- the record shapes ----------------------------------------------------------------
#
# TypedDict rather than dataclass, matching `providers.base.GapRecord`: these are plain
# JSON-serializable data that crosses a language boundary, and a dataclass would add an
# encode step between the builder and `json.dumps` for no gain.


class Finding(TypedDict, total=False):
    """One finding. `type`, `severity` and `message` are always present; every locating
    field below is optional and supplied by whichever criterion recorded it."""

    type: str
    severity: str
    message: str

    ast_path: str
    block_id: str

    table_id: str
    row_key: str
    column_key: str
    match_count: int

    formatted: str
    expected: str
    observed: str

    substring: str
    region: str
    paragraph_ordinal: int

    resource_id: str
    snapshot_path: str


class ReplayOutcome(TypedDict, total=False):
    """Req 31.6. `recomputed_sha256` and `stored_sha256` are absent when
    `possible` is false — replay was never attempted, so there is no digest to report,
    and emitting a placeholder would be a claim the verifier cannot make."""

    possible: bool
    recomputed_sha256: str
    stored_sha256: str
    objects_folded: int
    objects_named: int


class DriftSample(TypedDict):
    """Req 34.3. `seed` is what makes a disputed check re-runnable identically."""

    n: int
    method: str
    seed: str
    not_requeried: list[str]


VerificationCounts = dict[str, int]
"""The `counts` bag. An open mapping rather than a closed shape: a result carries the
counts the passes that actually ran produced, and a pass added later contributes its
count without an edit here or in `result.ts`."""


class VerificationResult(TypedDict):
    """The artifact written to `reports/<runId>/verification-<attemptId>.json`, the
    `verification` event's payload, and — after `verificationResultSchema` parses it —
    the `report_verifications` row. One shape, three consumers."""

    schema_version: int
    attempt_id: str
    run_id: str
    template_version_id: str
    status: str
    figure_count: int

    snapshot_sha256: str
    docx_sha256: str
    pdf_sha256: str
    ledger_sha256: str

    counts: VerificationCounts
    replay: ReplayOutcome
    drift_sample: DriftSample
    findings: list[Finding]


# --- helpers --------------------------------------------------------------------------


def severity_of(finding_type: str) -> str:
    """The declared severity for `finding_type`.

    Raises :class:`FindingTypeError` for anything undeclared, which is what turns a
    typo at a call site into an immediate failure rather than a finding the app
    classifies as neither blocking nor advisory.
    """
    try:
        return _SEVERITY_BY_TYPE[finding_type]
    except KeyError:
        raise FindingTypeError(
            f"undeclared finding type {finding_type!r}; declared types are "
            f"{sorted(DECLARED_FINDING_TYPES)}"
        ) from None


def truncate_excerpt(text: str, limit: int = EXCERPT_MAX_CHARS) -> str:
    """Bound `text` at `limit` characters, marking the cut.

    The marker is one character and counts against the limit, so the result is never
    longer than `limit`. Marking matters: an unmarked truncation reads as a complete
    value that simply does not match, which sends a reader looking for a mismatch that
    is really an elision.
    """
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    return text[: limit - len(_TRUNCATION_MARKER)] + _TRUNCATION_MARKER


def _clean(value: str, limit: int) -> str:
    """Scrub then truncate, in that order.

    Truncating first can cut a secret in half and leave a fragment no registered
    pattern matches — the scrub has to see the whole value to remove it.
    """
    scrubbed = scrub(value)
    return truncate_excerpt(scrubbed if scrubbed is not None else "", limit)


def record_finding(finding_type: str, message: str, **locating: object) -> Finding:
    """Build one finding, refusing an undeclared type or a blank message.

    `severity` is resolved from the declared partition rather than accepted from the
    caller, so a criterion cannot record a blocking defect as advisory. Every string
    field is scrubbed and bounded here; integer locating fields are validated as
    non-negative and passed through.
    """
    severity = severity_of(finding_type)

    text = _clean(message, MESSAGE_MAX_CHARS)
    if not text.strip():
        raise ResultFieldError(
            f"finding {finding_type!r} requires a non-blank message"
        )

    finding: Finding = {
        "type": finding_type,
        "severity": severity,
        "message": text,
    }

    for key, raw in locating.items():
        if raw is None:
            continue
        if isinstance(raw, bool):
            raise ResultFieldError(
                f"locating field {key!r} on finding {finding_type!r} is a bool; "
                "the result schema declares no boolean locating field"
            )
        if isinstance(raw, int):
            if raw < 0:
                raise ResultFieldError(
                    f"locating field {key!r} on finding {finding_type!r} is negative"
                )
            cast(dict[str, object], finding)[key] = raw
            continue
        if not isinstance(raw, str):
            raise ResultFieldError(
                f"locating field {key!r} on finding {finding_type!r} is "
                f"{type(raw).__name__}; every locating field is a string or an int"
            )
        limit = EXCERPT_MAX_CHARS if key in _EXCERPT_FIELDS else MESSAGE_MAX_CHARS
        cast(dict[str, object], finding)[key] = _clean(raw, limit)

    return finding


_SHA256_LENGTH: Final[int] = 64
_SHA256_ALPHABET: Final[frozenset[str]] = frozenset("0123456789abcdef")


def _require_digest(name: str, value: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != _SHA256_LENGTH
        or not _SHA256_ALPHABET.issuperset(value)
    ):
        raise ResultFieldError(
            f"{name} must be 64 lowercase hex characters; "
            f"got a {type(value).__name__} of length {len(value) if isinstance(value, str) else 0}"
        )
    return value


def _require_identifier(name: str, value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ResultFieldError(f"{name} must be a non-blank string")
    return value


def build_result(
    *,
    attempt_id: str,
    run_id: str,
    template_version_id: str,
    figure_count: int,
    snapshot_sha256: str,
    docx_sha256: str,
    pdf_sha256: str,
    ledger_sha256: str,
    counts: VerificationCounts,
    replay: ReplayOutcome,
    drift_sample: DriftSample,
    findings: list[Finding],
) -> VerificationResult:
    """Assemble the result document.

    `status` is **derived** from the observed blocking count, never accepted from the
    caller: there is no legitimate result that carries a blocking finding and passes,
    and deriving it removes the only way to write one. It is derived from the *count*
    rather than from `findings`, because the list is capped at
    :data:`FINDING_LIST_LIMIT` — a document with 1,200 blocking findings must not pass
    on the grounds that the array was truncated.

    `counts.blocking_findings_observed` and `counts.advisory_findings_observed` are
    filled from the supplied list when the caller has not already set them, so the
    common case cannot forget them; a caller that observed more findings than it
    retained sets them explicitly and this function leaves those totals alone.
    """
    _require_identifier("attempt_id", attempt_id)
    _require_identifier("run_id", run_id)
    _require_identifier("template_version_id", template_version_id)
    for digest_name, digest in (
        ("snapshot_sha256", snapshot_sha256),
        ("docx_sha256", docx_sha256),
        ("pdf_sha256", pdf_sha256),
        ("ledger_sha256", ledger_sha256),
    ):
        _require_digest(digest_name, digest)
    if figure_count < 0:
        raise ResultFieldError("figure_count must be non-negative")

    for finding in findings:
        finding_type = finding.get("type", "")
        declared = severity_of(finding_type)
        if finding.get("severity") != declared:
            raise ResultFieldError(
                f"finding {finding_type!r} carries severity "
                f"{finding.get('severity')!r}, but the declared partition says "
                f"{declared!r}; build every finding through record_finding"
            )

    resolved = dict(counts)
    resolved.setdefault(
        "blocking_findings_observed",
        sum(1 for f in findings if f.get("severity") == SEVERITY_BLOCKING),
    )
    resolved.setdefault(
        "advisory_findings_observed",
        sum(1 for f in findings if f.get("severity") == SEVERITY_ADVISORY),
    )

    blocking_observed = resolved["blocking_findings_observed"]
    status = "fail" if blocking_observed > 0 else "pass"

    result: VerificationResult = {
        "schema_version": RESULT_SCHEMA_VERSION,
        "attempt_id": attempt_id,
        "run_id": run_id,
        "template_version_id": template_version_id,
        "status": status,
        "figure_count": figure_count,
        "snapshot_sha256": snapshot_sha256,
        "docx_sha256": docx_sha256,
        "pdf_sha256": pdf_sha256,
        "ledger_sha256": ledger_sha256,
        "counts": resolved,
        "replay": replay,
        "drift_sample": drift_sample,
        "findings": findings[:FINDING_LIST_LIMIT],
    }

    # Redundant for anything built through `record_finding`, and deliberately so: this
    # is the gate that still holds for a finding assembled by hand.
    return cast("VerificationResult", cast(Any, scrub_deep(result)))
