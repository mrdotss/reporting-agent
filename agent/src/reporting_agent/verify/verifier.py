"""The orchestrator — one result from seven passes, and completeness in both directions.

This module owns two things the individual passes cannot: the **assembly** of one result
from all of them, and the **bidirectional completeness** assertion that only makes sense
once every pass has run.

## Why completeness needs both directions

**Forward** (Req 29.1): every numeric token the extractor found resolves — it was either a
data-cell value the anchored pass matched, or a numeric-bearing substring a masking stage
consumed. Every extracted token goes through one of the two, so none is excluded from both.
This is the direction that catches a number nobody put there: a model's invented figure, a
stale hand-edited value, a template string carrying a digit nobody meant to publish.

**Backward** (Req 29.2): every ledger entry appears. This is the direction that catches a
section that silently rendered nothing — a loop over zero rows, a block whose output was
dropped — and it is the more valuable half in practice, because a missing figure looks like
nothing at all while a spurious one at least looks odd.

An unrendered entry is `ledger_entry_unrendered`, **blocking, and blocking alone**
(Req 29.3, 29.4). That departs from the usual "completeness is a warning" framing on
purpose: in this product a template compiles the figures the composed blocks *declared*, so
there is no unused option to tolerate. A compiled figure that did not render is a rendering
defect that silently dropped part of the report.

One defect, one finding (Req 29.8). An entry unrendered *because* the anchored pass already
recorded a mismatch or an unresolved anchor for it records no second finding, which is why
`AnchorPass` carries a `faulted` set rather than only findings.

## `pass` is a claim about the gates, not only about the findings

`status` is `pass` only where **every** gate has been evaluated and zero blocking findings
were recorded (Req 25.5, 25.11). A verification that terminated early is a fail — not
"unknown", not "partial" — because an incomplete verification must never be a delivered
report, and the only safe reading of "we did not finish checking" is "not proven".

That is enforced structurally: :func:`verify` evaluates the gates and *then* asserts that
the set of gates it recorded equals :data:`REQUIRED_GATES`. A pass added to the spec and not
wired here fails every verification loudly rather than silently narrowing the gate.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final

from reporting_agent.compile.figures import ANCHOR_CHART, ANCHOR_TABLE, FigureLedger
from reporting_agent.compile.snapshot_view import SnapshotView
from reporting_agent.verify import anchors as anchors_pass
from reporting_agent.verify import charts as charts_pass
from reporting_agent.verify import coverage as coverage_pass
from reporting_agent.verify import pdf as pdf_pass
from reporting_agent.verify.allowlist import derive_allowlist
from reporting_agent.verify.drift import DriftOutcome, primary_metric, requery_sample, select
from reporting_agent.verify.findings import (
    FINDING_LEDGER_ENTRY_UNRENDERED,
    SEVERITY_BLOCKING,
    Finding,
    ReplayOutcome,
    VerificationResult,
    build_result,
)
from reporting_agent.verify.masking import ledger_strings_of, scan_paragraphs
from reporting_agent.verify.ports import MetricRequeryPort
from reporting_agent.verify.replay import ReplayPlan, replay
from reporting_agent.verify.tokens import numeric_tokens, paragraph_texts

__all__ = ["REQUIRED_GATES", "VerifyInputs", "verify"]

REQUIRED_GATES: Final[frozenset[str]] = frozenset(
    {
        "extraction",  # 26
        "tables",  # 27
        "prose",  # 28
        "completeness",  # 29
        "charts",  # 30
        "replay",  # 31
        "coverage",  # 32
        "pdf",  # 33
    }
)
"""The gates of requirements 26 through 33, by requirement.

Named as a set and asserted against rather than left implicit, because Req 25.5's "every
gate has been evaluated" is otherwise a claim nobody can check. A gate added to the spec and
not wired into :func:`verify` fails every verification with a message naming it.
"""


@dataclass(slots=True)
class VerifyInputs:
    """Everything one verification reads.

    Two fields are structural rather than convenient, and both are refusals to let this
    module reach for something itself:

    * `archived` is an iterable the **caller** already fetched, because Req 31.2 forbids the
      replay from fetching anything.
    * `requery` is a **port**, because `verify/` may not import an Azure SDK and the bounded
      drift sample is the one place verification touches a cloud at all.
    """

    attempt_id: str
    run_id: str
    template_version_id: str

    docx_bytes: bytes
    pdf_bytes: bytes
    ledger: FigureLedger
    ast: object
    document: object
    """The opened `.docx`, so the caller owns the file handle and this module reads only."""

    snapshot: Mapping[str, object]
    view: SnapshotView
    definition: Mapping[str, object]

    pdf_text: str = ""
    pdf_pages: int = 0
    pdf_sha256: str = ""
    snapshot_sha256: str = ""

    chart_sidecars: Mapping[str, bytes] = field(default_factory=dict)
    scope_counts: Mapping[str, int] = field(default_factory=dict)
    archived: Iterable[tuple[int, bytes]] = ()
    replay_plan: ReplayPlan | None = None
    requery: MetricRequeryPort | None = None
    drift_seed: str = ""
    subscription_display_name: str = ""
    catalog_scales: Mapping[str, int] | None = None


async def verify(inputs: VerifyInputs) -> VerificationResult:
    """Evaluate every gate and assemble one result.

    Never raises for a *finding*: a finding is a statement about the document, and the whole
    point is to record every one of them rather than to stop at the first. It does propagate
    the two refusals to answer — an unreadable `.docx`, a `.pdf` that is not the recorded one
    — because those say the inputs are not the run's artifacts, which is a different claim.
    """
    gates: set[str] = set()
    findings: list[Finding] = []
    counts: dict[str, int] = {}

    # --- 26: extraction -------------------------------------------------------------
    paragraphs = paragraph_texts(inputs.document)
    grids = anchors_pass.read_grids(inputs.document)
    tokens = [token for paragraph in paragraphs for token in numeric_tokens(paragraph)]
    counts["numeric_tokens_extracted"] = len(tokens)
    counts["paragraphs_extracted"] = len(paragraphs)
    counts["data_tables_extracted"] = len(grids)
    gates.add("extraction")

    # --- 27: anchored cell equality --------------------------------------------------
    tables = anchors_pass.check_tables(
        inputs.ledger, grids, scope_counts=inputs.scope_counts
    )
    findings.extend(tables.findings)
    counts["table_anchors_checked"] = tables.anchors_checked
    counts["data_tables_resolved"] = tables.tables_resolved
    gates.add("tables")

    # --- 30: charts (reads 27's verdict rather than re-running it) -------------------
    charts = charts_pass.check_charts(
        inputs.ast,
        grids=grids,
        sidecars=inputs.chart_sidecars,
        table_pass=tables,
    )
    findings.extend(charts.findings)
    counts["charts_checked"] = charts.charts_checked
    counts["chart_hashes_matched"] = charts.hashes_matched
    gates.add("charts")

    # --- 28: prose masking -----------------------------------------------------------
    #
    # The allowlist is derived on every run by rendering the pinned version with a null
    # context (Req 28.7). A failure to derive one propagates: an allowlist that could not be
    # derived must never let prose pass unchecked, and passing an empty one would do exactly
    # that in reverse — it would flag every piece of template chrome instead.
    allowlist = derive_allowlist(
        inputs.definition,
        inputs.snapshot,
        subscription_display_name=inputs.subscription_display_name,
        catalog_scales=inputs.catalog_scales,
    )
    ledger_strings = ledger_strings_of(inputs.ledger.entries)
    prose = scan_paragraphs(
        paragraphs, ledger_strings=ledger_strings, allowlist=allowlist
    )
    findings.extend(prose)
    counts["unmatched_prose_tokens"] = len(prose)
    counts["allowlist_entries"] = len(allowlist)
    gates.add("prose")

    # --- 32: coverage ----------------------------------------------------------------
    coverage = coverage_pass.check_coverage(
        inputs.snapshot, view=inputs.view, definition=inputs.definition
    )
    findings.extend(coverage.findings)
    counts["union_scope_resources"] = coverage.union_resource_count
    counts["snapshot_resources"] = coverage.snapshot_resource_count
    counts["collection_log_entries"] = coverage.collection_log_entries
    gates.add("coverage")

    # --- 33: PDF fidelity ------------------------------------------------------------
    fidelity = pdf_pass.check_pdf(
        inputs.ledger,
        pdf_bytes=inputs.pdf_bytes,
        text=inputs.pdf_text,
        pages_read=inputs.pdf_pages,
        expected_sha256=inputs.pdf_sha256,
        number_format=_number_format(inputs.definition),
    )
    findings.extend(fidelity.findings)
    counts["pdf_entries_checked"] = fidelity.entries_checked
    counts["pdf_entries_located"] = fidelity.entries_located
    counts["pdf_figures_missing"] = len(fidelity.findings)
    counts["pdf_pages_read"] = fidelity.pages_read
    gates.add("pdf")

    # --- 31: replay ------------------------------------------------------------------
    replay_outcome: ReplayOutcome
    if inputs.replay_plan is None:
        # No plan is an inability to replay, recorded the same way a missing object is —
        # never a mismatch, and never a silent skip that would let `status` read as pass on
        # a gate nobody ran.
        replay_outcome = {"possible": False, "objects_folded": 0, "objects_named": 0}
    else:
        outcome = replay(inputs.archived, plan=inputs.replay_plan)
        replay_outcome = outcome.outcome
        findings.extend(outcome.findings)
    gates.add("replay")

    # --- 34: drift, advisory -----------------------------------------------------------
    drift = await _drift(inputs)
    findings.extend(drift.findings)
    counts["drift_resources_requeried"] = drift.requeried

    # --- 29: completeness, in both directions ------------------------------------------
    unrendered, resolved = _completeness(
        inputs.ledger, paragraphs=paragraphs, tables=tables
    )
    findings.extend(unrendered)
    counts["ledger_entries_checked"] = len(inputs.ledger)
    counts["ledger_entries_resolved"] = resolved
    counts["ledger_entries_unrendered"] = len(unrendered)
    gates.add("completeness")

    _assert_every_gate_ran(gates)

    blocking = [f for f in findings if f.get("severity") == SEVERITY_BLOCKING]
    counts["blocking_findings_observed"] = len(blocking)
    counts["advisory_findings_observed"] = len(findings) - len(blocking)

    return build_result(
        attempt_id=inputs.attempt_id,
        run_id=inputs.run_id,
        template_version_id=inputs.template_version_id,
        figure_count=len(inputs.ledger),
        snapshot_sha256=inputs.snapshot_sha256 or _digest(b""),
        docx_sha256=_digest(inputs.docx_bytes),
        pdf_sha256=inputs.pdf_sha256 or _digest(inputs.pdf_bytes),
        ledger_sha256=inputs.ledger.digest(),
        counts=counts,
        replay=replay_outcome,
        drift_sample=drift.sample,
        findings=findings,
    )


def _assert_every_gate_ran(gates: set[str]) -> None:
    """Req 25.5, 25.11 — `pass` is a claim about the gates as well as the findings."""
    if gates != REQUIRED_GATES:
        from reporting_agent.errors import VerificationFailedError

        raise VerificationFailedError(
            "the verification did not evaluate every gate requirements 26 through 33 "
            f"declare; missing {sorted(REQUIRED_GATES - gates)}, unexpected "
            f"{sorted(gates - REQUIRED_GATES)}. An incomplete verification is a fail, "
            "never a partial pass."
        )


# --------------------------------------------------------------------------- #
# Req 29 — backward completeness
# --------------------------------------------------------------------------- #


def _completeness(
    ledger: FigureLedger,
    *,
    paragraphs: Sequence[object],
    tables: anchors_pass.AnchorPass,
) -> tuple[list[Finding], int]:
    """Every ledger entry, checked for its appearance in the document (Req 29.2).

    Three kinds of entry, three definitions of "appears", and the third is the one with a
    trap in it: where two prose entries in one block carry an identical `formatted` string,
    the block's text must hold **at least that many** occurrences and no two entries may
    resolve to the same one (Req 29.7). A naive `string in text` check reports one
    occurrence as satisfying both, and a report that printed a figure once instead of twice
    would verify clean.
    """
    anchors = ledger.anchors()
    by_block = _paragraph_text_by_block(paragraphs)
    consumed: dict[tuple[str | None, str], int] = {}

    findings: list[Finding] = []
    resolved = 0

    for path, figure in ledger.entries.items():
        key = str(path)
        anchor = anchors.get(path)

        if anchor is not None and anchor.kind in (ANCHOR_TABLE, ANCHOR_CHART):
            if key in tables.matched:
                resolved += 1
                continue
            if key in tables.faulted:
                # Req 29.8 — the anchored pass already named this defect. One rendering
                # defect, one finding, and the counts stay unambiguous.
                continue
            if anchor.row_key is None or anchor.column_key is None:
                # A figure inside a table node that never reached a cell. It has no anchored
                # position to check, so it falls through to the prose path below rather than
                # being excluded from both directions.
                pass
            else:  # pragma: no cover - matched | faulted covers every checked anchor
                findings.append(_unrendered(key, figure))
                continue

        block_id = key.split(":", 1)[0]
        occurrences = by_block.for_block(block_id).count(figure.formatted)
        seen = consumed.get((block_id, figure.formatted), 0)
        if occurrences > seen:
            consumed[(block_id, figure.formatted)] = seen + 1
            resolved += 1
            continue
        findings.append(_unrendered(key, figure, block_id=block_id))

    return findings, resolved


def _unrendered(path: str, figure: object, *, block_id: str | None = None) -> Finding:
    from reporting_agent.verify.findings import record_finding

    formatted = getattr(figure, "formatted", "")
    locating: dict[str, object] = {"ast_path": path, "formatted": formatted}
    if block_id:
        locating["block_id"] = block_id
    return record_finding(
        FINDING_LEDGER_ENTRY_UNRENDERED,
        f"the figure {formatted!r} at {path} was compiled but does not appear in the "
        f"rendered document; a compiled figure that did not render is a rendering defect "
        f"that silently dropped part of the report",
        **locating,
    )


@dataclass(frozen=True, slots=True)
class _BlockText:
    """The document's paragraph text, split into what a block owns and what is shared.

    The `.docx` carries **no per-paragraph block attribution** — the renderer writes
    `w:tblCaption` on data tables and nothing else — so a prose paragraph outside a table
    cannot be tied to the block that authored it by reading the document. Pretending
    otherwise would be the worst option available: it would fail an executive summary's
    figure for appearing in "the wrong" paragraph on a document that is perfectly correct.

    So a block's text is its own captioned tables' paragraphs **plus** the shared pool of
    untabled prose. The multiplicity rule of Req 29.7 still bites — two entries carrying one
    string still need two occurrences — which is the part that actually catches a report
    printing a figure once where it compiled it twice.
    """

    pool: str
    per_block: Mapping[str, str]

    def for_block(self, block_id: str) -> str:
        own = self.per_block.get(block_id)
        return self.pool if own is None else f"{own}\n{self.pool}"


def _paragraph_text_by_block(paragraphs: Sequence[object]) -> _BlockText:
    per_block: dict[str, list[str]] = {}
    pooled: list[str] = []
    for paragraph in paragraphs:
        text = getattr(paragraph, "text", "")
        identity = getattr(paragraph, "block_id", None)
        if identity is None:
            pooled.append(text)
            continue
        per_block.setdefault(_block_of(str(identity)), []).append(text)
    return _BlockText(
        pool="\n".join(pooled),
        per_block={block: "\n".join(texts) for block, texts in per_block.items()},
    )


def _block_of(identity: str) -> str:
    """`tbl:kpi:0` and `cht:trend:1.2` both name the block `kpi` / `trend`."""
    body = identity.split(":", 1)[1] if ":" in identity else identity
    return body.split(":", 1)[0]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


async def _drift(inputs: VerifyInputs) -> DriftOutcome:
    resolved = primary_metric(inputs.view, inputs.definition)
    metric = resolved[1] if resolved else None
    named = {
        figure.resource_id
        for figure in inputs.ledger.entries.values()
        if figure.resource_id
    }
    window = inputs.snapshot.get("window")
    sample = select(
        inputs.view, named=named, seed=inputs.drift_seed, metric=metric
    )
    return await requery_sample(
        inputs.view,
        sample=sample,
        seed=inputs.drift_seed,
        metric=metric,
        statistic="max",
        window=window if isinstance(window, Mapping) else {},  # type: ignore[arg-type]
        grain=str(inputs.snapshot.get("grain") or ""),
        requery=inputs.requery,
    )


def _number_format(definition: Mapping[str, object]):
    from reporting_agent.compile.blocks.base import DesignSettings

    return DesignSettings.from_plain(definition.get("design")).number_format


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()

