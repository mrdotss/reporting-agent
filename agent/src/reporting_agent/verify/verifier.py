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

import asyncio
import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final

from reporting_agent.compile.figures import ANCHOR_CHART, ANCHOR_TABLE, FigureLedger
from reporting_agent.compile.messages import Messages
from reporting_agent.compile.snapshot_view import SnapshotView
from reporting_agent.errors import VerificationFailedError
from reporting_agent.verify import anchors as anchors_pass
from reporting_agent.verify import charts as charts_pass
from reporting_agent.verify import coverage as coverage_pass
from reporting_agent.verify import derived_counts as derived_counts_pass
from reporting_agent.verify import facts as facts_pass
from reporting_agent.verify import historical as historical_pass
from reporting_agent.verify import pdf as pdf_pass
from reporting_agent.verify import toc as toc_pass
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
        # The breadth-and-document spec's three, by that spec's requirement number. Raised
        # here rather than with each pass on purpose: a gate this set names and :func:`verify`
        # does not record fails **every** verification naming itself, so the intervening tasks
        # cannot leave a partially wired verifier quietly passing.
        "facts",  # breadth 6 — the text-fact exact-string check
        "toc",  # breadth 14 — the table of contents' page numbers
        "historical",  # breadth 18 — a plotted point came from a verified prior run
        "derived_counts",  # breadth 19 — compile-derived integers re-derive from the ledger
    }
)
"""The gates of requirements 26 through 33, plus the three the breadth-and-document spec adds.

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
    styled_pdf_text: str = ""
    styled_pdf_pages: int = 0
    """The extracted text of the styled reading copy, where one was rendered.

    Empty when the run produced none, which is not a failure — the delivered pair is the
    `.docx` and its conversion, and the reading copy is a third artifact. Present, it is
    checked for the same figures at advisory severity; see `verify/pdf.check_styled_pdf`."""
    styled_pdf_omitted: frozenset[str] = frozenset()
    """The figure paths the reading copy was told not to carry (criterion 23.12).

    Named by `render/printpdf.py`, which read them off the companion tables it dropped,
    and passed through rather than re-derived — see `check_styled_pdf`."""
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
    messages: Messages | None = None
    historical: Mapping[str, historical_pass.HistoricalRunInfo] = field(default_factory=dict)
    front_matter: object | None = None
    run_facts: object | None = None
    section_catalogue: object | None = None


async def verify(inputs: VerifyInputs) -> VerificationResult:
    """Evaluate every gate and assemble one result.

    Never raises for a *finding*: a finding is a statement about the document, and the whole
    point is to record every one of them rather than to stop at the first. It does propagate
    the two refusals to answer — an unreadable `.docx`, a `.pdf` that is not the recorded one
    — because those say the inputs are not the run's artifacts, which is a different claim.

    **The gate body runs in a worker thread.** Every gate but drift is synchronous, and
    together they are minutes of work at a few hundred resources — the replay fold alone
    re-runs the whole aggregation. Run on the event loop they would starve the heartbeat
    ticker `main.invoke` merges around the pipeline, and Req 42.11 requires consecutive
    events no more than 30 seconds apart while the status is `verifying`. So the one
    awaiting gate is resolved first and the rest is handed to `asyncio.to_thread`.

    Drift moving to the front changes no output: :func:`_drift` reads `inputs` and nothing
    the other gates produce, and its findings are still spliced in at the position
    Req 25.8's document order puts them.
    """
    drift = await _drift(inputs)
    return await asyncio.to_thread(_evaluate_gates, inputs, drift)


def _evaluate_gates(inputs: VerifyInputs, drift: DriftOutcome) -> VerificationResult:
    """Every gate but drift, and the assembled result. Synchronous, and off the loop.

    Split out of :func:`verify` rather than inlined there so the threaded boundary is one
    call rather than a shape a later edit could accidentally put an `await` back inside.
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
        messages=inputs.messages,
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
    #
    # The TOC gate runs BEFORE the prose gate (breadth criteria 14.9, 14.12) and returns
    # `proven_toc_numerals` keyed by paragraph ordinal — a numeral is admitted ONLY in the
    # paragraph whose comparison produced it, not document-wide.
    toc_result = toc_pass.check_toc(
        inputs.pdf_bytes,
        paragraphs=paragraphs,
        document=inputs.document,
    )
    findings.extend(toc_result.findings)
    counts["toc_entries_checked"] = toc_result.entries_checked
    gates.add("toc")

    allowlist = derive_allowlist(
        inputs.definition,
        inputs.snapshot,
        subscription_display_name=inputs.subscription_display_name,
        catalog_scales=inputs.catalog_scales,
        front_matter=inputs.front_matter,
        run_facts=inputs.run_facts,
        section_catalogue=inputs.section_catalogue,
    )
    ledger_strings = ledger_strings_of(
        (*inputs.ledger.entries.values(), *inputs.ledger.derived_counts().values())
    )
    prose = scan_paragraphs(
        paragraphs, ledger_strings=ledger_strings, allowlist=allowlist,
        proven_toc_numerals=toc_result.proven_toc_numerals,
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

    # --- the styled reading copy, advisory ---------------------------------------------
    #
    # Not a gate, and deliberately not in REQUIRED_GATES: a gate is something whose absence
    # makes a `pass` verdict meaningless, and this artifact's absence does not. The
    # delivered pair is checked above on its own terms. These findings say the reading copy
    # lost a figure, which suppresses that copy and withholds nothing else.
    styled_findings = (
        pdf_pass.check_styled_pdf(
            inputs.ledger,
            text=inputs.styled_pdf_text,
            pages_read=inputs.styled_pdf_pages,
            number_format=_number_format(inputs.definition),
            omitted=inputs.styled_pdf_omitted,
        )
        if inputs.styled_pdf_text
        else ()
    )
    findings.extend(styled_findings)
    counts["styled_pdf_figures_missing"] = len(styled_findings)
    counts["styled_pdf_pages_read"] = inputs.styled_pdf_pages

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
    #
    # Resolved by `verify` before this function was scheduled — it is the one gate that
    # awaits — and spliced in here, where document order puts it.
    findings.extend(drift.findings)
    counts["drift_resources_requeried"] = drift.requeried

    # --- breadth 6: text-fact exact-string check -----------------------------------------
    text_fact_result = facts_pass.check_text_facts(inputs.ledger, grids)
    findings.extend(text_fact_result.findings)
    counts["text_fact_count"] = len(inputs.ledger.text_facts())
    counts["text_fact_entries_checked"] = text_fact_result.entries_checked
    counts["text_fact_entries_resolved"] = text_fact_result.entries_resolved
    gates.add("facts")

    # --- breadth 18: historical ---------------------------------------------------------
    historical_result = historical_pass.check_historical(
        inputs.ledger, historical=inputs.historical
    )
    findings.extend(historical_result.findings)
    counts["historical_points_checked"] = len(historical_result.historical_points)
    gates.add("historical")

    # --- breadth 19: derived_counts -----------------------------------------------------
    dc_result = derived_counts_pass.check_derived_counts(
        inputs.ledger, definition=inputs.definition,
    )
    findings.extend(dc_result.findings)
    counts["derived_counts_checked"] = dc_result.counts_checked
    gates.add("derived_counts")

    # --- 29: completeness, in both directions ------------------------------------------
    unrendered, resolved = _completeness(
        inputs.ledger, paragraphs=paragraphs, tables=tables,
        text_fact_pass=text_fact_result,
    )
    findings.extend(unrendered)
    counts["ledger_entries_checked"] = len(inputs.ledger.entry_paths())
    counts["ledger_entries_resolved"] = resolved
    counts["ledger_entries_unrendered"] = len(unrendered)
    gates.add("completeness")

    _assert_every_gate_ran(gates)

    blocking = [f for f in findings if f.get("severity") == SEVERITY_BLOCKING]
    counts["blocking_findings_observed"] = len(blocking)
    counts["advisory_findings_observed"] = len(findings) - len(blocking)

    result = build_result(
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

    # Record historical points on the result so a reader can trace each plotted period
    # to the verification that proved it (Req 18.11, 19.9). Shape matches
    # VerificationView.historicalPoints: readonly { runId: string; snapshotSha256: string }[].
    result["historical_points"] = list(historical_result.historical_points)  # type: ignore[typeddict-unknown-key]

    return result


def _assert_every_gate_ran(gates: set[str]) -> None:
    """Req 25.5, 25.11 — `pass` is a claim about the gates as well as the findings."""
    if gates != REQUIRED_GATES:
        raise VerificationFailedError(
            "the verification did not evaluate every gate REQUIRED_GATES declares "
            "(requirements 26 through 33, plus facts, toc and historical); "
            f"missing {sorted(REQUIRED_GATES - gates)}, unexpected "
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
    text_fact_pass: facts_pass.TextFactPass,
) -> tuple[list[Finding], int]:
    """Every ledger entry, checked for its appearance in the document (Req 29.2).

    Three kinds of entry, three definitions of "appears", and the third is the one with a
    trap in it: where two prose entries in one block carry an identical `formatted` string,
    the block's text must hold **at least that many** occurrences and no two entries may
    resolve to the same one (Req 29.7). A naive `string in text` check reports one
    occurrence as satisfying both, and a report that printed a figure once instead of twice
    would verify clean.

    Text facts are covered through their own gate (`check_text_facts`). A text fact that
    resolved (its cell text matched `formatted`) counts as rendered. An unanchored text fact
    or one whose cell did not match is `ledger_entry_unrendered` exactly as an unrendered
    figure is — the facts gate already recorded the specific finding, and Req 29.8 says one
    defect one finding.
    """
    anchors = ledger.anchors()
    by_block = _paragraph_text_by_block(paragraphs)
    consumed: dict[tuple[str | None, str], int] = {}

    findings: list[Finding] = []
    resolved = 0

    # --- figures (the original path) ---
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

    # --- text facts: resolved by the facts gate, counted here for completeness ---
    # A text fact that the facts gate checked AND resolved is rendered.
    # One that the facts gate found a finding for is faulted (one defect, one finding).
    # One that was unanchored is already reported by the facts gate — don't double.
    # text_fact_pass.entries_resolved counts exactly those text facts whose cell matched.
    resolved += text_fact_pass.entries_resolved

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

    # Req 16.12 — re-verification reads number_format from the run's PINNED template
    # version, resolving separators from that version's declared language. A later edit
    # of the template's separators or language leaves this archived report verifying
    # exactly as delivered.
    identity = definition.get("identity")
    language: str | None = None
    if isinstance(identity, Mapping):
        lang = identity.get("language")
        if isinstance(lang, str) and lang in ("en", "id"):
            language = lang
    return DesignSettings.from_plain(definition.get("design"), language=language).number_format


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()

