"""The orchestrator (Req 25, 29).

Driven over a real compile and a real render, so the passing case is a document this test
did not construct. Then every negative case mutates that document and asserts the status
flips — because a gate never observed to fail is not a gate.

The two tests that carry the module are
:func:`test_a_dropped_ledger_entry_is_blocking_on_its_own` — backward completeness failing a
report that compiled a figure and did not render it, with nothing else wrong — and
:func:`test_one_rendering_defect_yields_one_finding`, which is the counts staying
unambiguous when the anchored pass and completeness would otherwise both fire on one defect.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
from typing import Any, Final

import pytest
from docx import Document as open_docx

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.errors import VerificationFailedError
from reporting_agent.render.docx import render_document
from reporting_agent.verify.findings import (
    FINDING_EMPTY_SCOPE,
    FINDING_LEDGER_ENTRY_UNRENDERED,
    FINDING_PDF_FIGURE_MISSING,
    FINDING_SCOPE_UNVERIFIED,
    FINDING_TABLE_CELL_MISMATCH,
    FINDING_UNMATCHED_PROSE_TOKEN,
    SEVERITY_BLOCKING,
)
from reporting_agent.verify.verifier import REQUIRED_GATES, VerifyInputs, verify

DESIGN: Final[dict[str, Any]] = {
    "preset": "editorial",
    "accent_color": "#1f6f78",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": False,
    "logo": None,
    "page_size": "A4",
}

BLOCKS: Final[list[dict[str, Any]]] = [
    df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
    df.block("kpi", "kpi_row", {"metrics": [df.CPU_AVG]}),
]


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


class Verification:
    """One compiled, rendered document plus everything a verification reads."""

    def __init__(self, *, snapshot: dict | None = None, blocks=None) -> None:
        self.snapshot = snapshot if snapshot is not None else sf.two_vm_snapshot()
        self.view = build_snapshot_view(self.snapshot)
        self.definition = df.definition(blocks or BLOCKS, design=DESIGN)
        self.compiled = compile_document(self.definition, view=self.view)
        self.outcome = render_document(
            self.compiled.document,
            ledger=self.compiled.ledger,
            design=DesignSettings.from_plain(DESIGN),
        )
        self.pdf_bytes = b"%PDF-1.7 " + self.outcome.docx_bytes[:16]
        self.pdf_text = " ".join(
            figure.formatted for figure in self.compiled.ledger.entries.values()
        )

    def inputs(self, **overrides: Any) -> VerifyInputs:
        payload = overrides.pop("docx_bytes", self.outcome.docx_bytes)
        base = {
            "attempt_id": "att_1",
            "run_id": "run_1",
            "template_version_id": "tv_1",
            "docx_bytes": payload,
            "pdf_bytes": self.pdf_bytes,
            "ledger": self.compiled.ledger,
            "ast": self.compiled.document,
            "document": open_docx(io.BytesIO(payload)),
            "snapshot": self.snapshot,
            "view": self.view,
            "definition": self.definition,
            "pdf_text": self.pdf_text,
            "pdf_pages": 1,
            "pdf_sha256": digest(self.pdf_bytes),
            "snapshot_sha256": str(self.snapshot["snapshot_id"]),
            "chart_sidecars": dict(self.outcome.chart_sidecars),
            "drift_seed": "d" * 64,
        }
        base.update(overrides)
        return VerifyInputs(**base)  # type: ignore[arg-type]

    def run(self, **overrides: Any):
        return asyncio.run(verify(self.inputs(**overrides)))


@pytest.fixture(scope="module")
def clean() -> Verification:
    return Verification()


def types_of(result) -> set[str]:
    return {str(finding["type"]) for finding in result["findings"]}


# --------------------------------------------------------------------------- #
# The passing case
# --------------------------------------------------------------------------- #


def test_a_correct_document_passes_every_gate(clean) -> None:
    result = clean.run()

    assert result["findings"] == [], result["findings"]
    assert result["status"] == "pass"
    assert result["figure_count"] == len(clean.compiled.ledger) > 0
    assert result["ledger_sha256"] == clean.compiled.ledger.digest()
    assert result["docx_sha256"] == digest(clean.outcome.docx_bytes)


def test_the_counts_are_recorded_on_a_pass(clean) -> None:
    """Req 29.5 — four counts, non-negative, whether the status is pass or fail, with
    entries-checked equal to the ledger's total."""
    counts = clean.run()["counts"]

    assert counts["ledger_entries_checked"] == len(clean.compiled.ledger)
    assert counts["ledger_entries_resolved"] == len(clean.compiled.ledger)
    assert counts["ledger_entries_unrendered"] == 0
    assert counts["numeric_tokens_extracted"] > 0
    assert counts["blocking_findings_observed"] == 0
    assert all(value >= 0 for value in counts.values())


def test_the_gate_set_is_the_eight_requirements_26_through_33_declare() -> None:
    """Req 25.5's "every gate has been evaluated", made checkable.

    Without this the claim is unfalsifiable: a verifier that quietly skipped the PDF gate
    would report `pass` and nothing would say otherwise.
    """
    assert REQUIRED_GATES == {
        "extraction",
        "tables",
        "prose",
        "completeness",
        "charts",
        "replay",
        "coverage",
        "pdf",
    }


# --------------------------------------------------------------------------- #
# Each gate, observed failing
# --------------------------------------------------------------------------- #


def test_a_mutated_cell_fails_the_verification(clean) -> None:
    """The anchored pass, through the orchestrator."""
    mutated = _rewrite_first_figure_cell(clean.outcome.docx_bytes, "999.99%")

    result = clean.run(docx_bytes=mutated, document=open_docx(io.BytesIO(mutated)))

    assert result["status"] == "fail"
    assert FINDING_TABLE_CELL_MISMATCH in types_of(result)


def test_an_invented_prose_number_fails_the_verification(clean) -> None:
    """Req 19.4 — the enforcement that makes "no LLM ever produces a number" true.

    A model writing "CPU averaged 12%" produces a string the compiler never placed. It
    survives all five masking stages, records `unmatched_prose_token`, and the report is not
    delivered — which is the only mechanism in the product that enforces the invariant. No
    prompt, tool description or model setting is treated as enforcement.
    """
    injected = _append_paragraph(clean.outcome.docx_bytes, "CPU averaged 37.4% last month")

    result = clean.run(docx_bytes=injected, document=open_docx(io.BytesIO(injected)))

    assert result["status"] == "fail"
    assert FINDING_UNMATCHED_PROSE_TOKEN in types_of(result)


def test_an_unproven_scope_fails_the_verification() -> None:
    unverified = sf.two_vm_snapshot()
    unverified["scope_verified"] = False
    harness = Verification(snapshot=unverified)

    result = harness.run()

    assert result["status"] == "fail"
    assert FINDING_SCOPE_UNVERIFIED in types_of(result)


def test_an_empty_snapshot_fails_the_verification() -> None:
    """The clean-and-empty report, refused at the orchestrator rather than only at the
    pass — a document with zero figures satisfies every other gate."""
    harness = Verification(snapshot=sf.build(resources=[]))

    result = harness.run()

    assert result["status"] == "fail"
    assert FINDING_EMPTY_SCOPE in types_of(result)
    assert result["figure_count"] == 0


def test_a_pdf_missing_a_figure_fails_the_verification(clean) -> None:
    result = clean.run(pdf_text="a conversion that lost every numeral")

    assert result["status"] == "fail"
    assert FINDING_PDF_FIGURE_MISSING in types_of(result)


def test_a_pdf_that_is_not_the_recorded_one_is_refused(clean) -> None:
    """Not a finding — a refusal to answer. The file in hand is not the delivered document,
    which is a different claim from "the delivered document is wrong"."""
    with pytest.raises(VerificationFailedError):
        clean.run(pdf_sha256="0" * 64)


# --------------------------------------------------------------------------- #
# Req 29 — backward completeness, and one defect yielding one finding
# --------------------------------------------------------------------------- #


def _mint(harness, block_id: str, count: int = 1):
    """Add `count` figures to the ledger that the render never emitted.

    This is the state `ledger_entry_unrendered` exists to catch — a figure the compiler
    produced and the renderer dropped — and it is **not** reachable through a definition
    today, because every block currently anchors its figures into a data table and a dropped
    table therefore surfaces as `table_anchor_missing` first (Req 29.8 then correctly
    suppresses the second finding).

    So the defect is injected rather than provoked. The source value is the fixture's `p95`,
    which the definitions here do not select, so its `formatted` string appears nowhere in
    the rendered document by construction rather than by arrangement.
    """
    from reporting_agent.compile.ast import compiling_against
    from reporting_agent.compile.figures import BlockCursor

    value = harness.view.stat(harness.view.resources[0].resource_id, sf.CPU, "p95")
    assert value is not None
    with compiling_against(harness.view):
        cursor = BlockCursor(block_id=block_id, ledger=harness.compiled.ledger)
        return [cursor.child("nodes", index).figure(value) for index in range(count)]


def test_a_dropped_ledger_entry_is_blocking_on_its_own(clean) -> None:
    """Req 29.3, 29.4 — the compiled figure that silently did not render.

    Nothing else is wrong with the document: every anchored cell matches, the prose is
    clean, the PDF carries every string it should. Only the backward direction can see this,
    and it must fail the verification on its own.
    """
    harness = Verification()
    minted = _mint(harness, "ghost")
    assert minted[0].formatted not in harness.pdf_text

    result = harness.run(pdf_text=f"{harness.pdf_text} {minted[0].formatted}")

    assert result["status"] == "fail"
    assert types_of(result) == {FINDING_LEDGER_ENTRY_UNRENDERED}
    assert result["counts"]["ledger_entries_unrendered"] == 1
    assert result["counts"]["ledger_entries_resolved"] == len(harness.compiled.ledger) - 1
    assert all(
        finding["severity"] == SEVERITY_BLOCKING for finding in result["findings"]
    )
    assert clean is not None


def test_one_rendering_defect_yields_one_finding(clean) -> None:
    """Req 29.8. A mutated cell is one defect: the anchored pass records the mismatch and
    completeness records nothing for that entry.

    Two findings for one defect would make the counts ambiguous — a reviewer could not tell
    two broken cells from one broken cell counted twice.
    """
    mutated = _rewrite_first_figure_cell(clean.outcome.docx_bytes, "0.01%")

    result = clean.run(docx_bytes=mutated, document=open_docx(io.BytesIO(mutated)))

    mismatches = [f for f in result["findings"] if f["type"] == FINDING_TABLE_CELL_MISMATCH]
    unrendered = [
        f for f in result["findings"] if f["type"] == FINDING_LEDGER_ENTRY_UNRENDERED
    ]
    assert len(mismatches) == 1
    assert unrendered == []


def test_two_entries_with_one_string_need_two_occurrences() -> None:
    """Req 29.7. The trap a naive `string in text` check falls into: it resolves both
    entries to one occurrence, so a report that printed a figure once where it compiled it
    twice verifies clean.

    Both halves are asserted over one string. One occurrence in the document leaves one
    entry unrendered; two occurrences resolve both.
    """
    once = Verification()
    minted = _mint(once, "twins", count=2)
    string = minted[0].formatted
    assert minted[1].formatted == string

    with_one = _append_paragraph(once.outcome.docx_bytes, f"headroom stands at {string}")
    result = once.run(
        docx_bytes=with_one,
        document=open_docx(io.BytesIO(with_one)),
        pdf_text=f"{once.pdf_text} {string}",
    )

    assert result["counts"]["ledger_entries_unrendered"] == 1

    twice = Verification()
    minted = _mint(twice, "twins", count=2)
    with_two = _append_paragraph(
        twice.outcome.docx_bytes, f"headroom stands at {string} and again at {string}"
    )
    passing = twice.run(
        docx_bytes=with_two,
        document=open_docx(io.BytesIO(with_two)),
        pdf_text=f"{twice.pdf_text} {string}",
    )

    assert passing["counts"]["ledger_entries_unrendered"] == 0
    assert passing["status"] == "pass"


# --------------------------------------------------------------------------- #
# Req 25.10 — every finding is on the result, even when the document is withheld
# --------------------------------------------------------------------------- #


def test_a_failing_verification_still_records_every_count_and_both_digests(clean) -> None:
    unverified = sf.two_vm_snapshot()
    unverified["scope_verified"] = False
    harness = Verification(snapshot=unverified)

    result = harness.run()

    assert result["status"] == "fail"
    assert result["counts"]["ledger_entries_checked"] == len(harness.compiled.ledger)
    assert result["ledger_sha256"]
    assert result["docx_sha256"]
    assert result["replay"]["possible"] is False
    assert result["drift_sample"]["seed"] == "d" * 64
    assert clean is not None


def test_no_port_and_no_replay_plan_is_a_complete_verification(clean) -> None:
    """Req 25.7, 34.6 — both are advisory paths, so their absence changes no status.

    This is the re-verification case: a two-year-old report whose credential expired and
    whose archive was never fetched still verifies to the same verdict.
    """
    result = clean.run(requery=None, replay_plan=None, archived=())

    assert result["status"] == "pass"
    assert result["replay"]["possible"] is False
    assert result["drift_sample"]["method"]


# --------------------------------------------------------------------------- #
# Document surgery
# --------------------------------------------------------------------------- #


def _rewrite_first_figure_cell(payload: bytes, text: str) -> bytes:
    from docx.oxml.ns import qn

    from reporting_agent.verify.tokens import table_caption

    document = open_docx(io.BytesIO(payload))
    for table in document.element.body.iter(qn("w:tbl")):
        if table_caption(table) is None:
            continue
        rows = table.findall(qn("w:tr"))
        if len(rows) < 2:
            continue
        cells = rows[1].findall(qn("w:tc"))
        target = cells[-1]
        nodes = list(target.iter(qn("w:t")))
        if not nodes:
            continue
        nodes[0].text = text
        for node in nodes[1:]:
            node.text = ""
        break
    return _save(document)


def _remove_first_data_table(payload: bytes) -> bytes:
    from docx.oxml.ns import qn

    from reporting_agent.verify.tokens import table_caption

    document = open_docx(io.BytesIO(payload))
    for table in list(document.element.body.iter(qn("w:tbl"))):
        if table_caption(table) is None:
            continue
        table.getparent().remove(table)
        break
    return _save(document)


def _append_paragraph(payload: bytes, text: str) -> bytes:
    document = open_docx(io.BytesIO(payload))
    document.add_paragraph(text)
    return _save(document)


def _save(document) -> bytes:
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()
