"""Tests for `verify/facts.py` — the text-fact exact-string anchored check.

Covers the three finding types:
- `text_fact_mismatch`: cell text differs from `formatted`
- `text_fact_anchor_missing`: anchor resolves to no cell
- `text_fact_unanchored`: no anchor recorded at all

And the structural properties:
- The comparison is with NO character inserted between runs, no trimming, no normalization
- `text_fact_count` is distinct from `figure_count`
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest

from reporting_agent.compile.ast import TextFact, compiling_against
from reporting_agent.compile.figures import (
    ANCHOR_TABLE,
    FigureLedger,
    FigurePath,
    TableAnchor,
)
from reporting_agent.verify.anchors import TableGrid
from reporting_agent.verify.facts import check_text_facts
from reporting_agent.verify.findings import (
    FINDING_TEXT_FACT_ANCHOR_MISSING,
    FINDING_TEXT_FACT_MISMATCH,
    FINDING_TEXT_FACT_UNANCHORED,
    SEVERITY_BLOCKING,
)

# --- helpers --------------------------------------------------------------------------


class _FakeResolver:
    """A snapshot resolver that always resolves text facts successfully."""

    def __init__(self, facts: dict[str, str] | None = None):
        self._facts = facts or {}

    def resolve_all(self, raw_pointer: str) -> tuple[object, ...]:
        return ()

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        if raw_pointer in self._facts:
            return (self._facts[raw_pointer],)
        return ()


@contextmanager
def _compile_ctx(facts: dict[str, str] | None = None) -> Iterator[None]:
    """Enter a compiling_against context with a fake resolver."""
    with compiling_against(_FakeResolver(facts)):
        yield


def _grid(
    identity: str,
    headers: tuple[str, ...],
    rows: tuple[tuple[str, ...], ...],
) -> TableGrid:
    return TableGrid(identity=identity, ordinal=0, headers=headers, rows=rows)


def _ledger_with_text_fact(
    *,
    path: str = "block1:0",
    key: str = "backup_status",
    value: str = "Succeeded",
    snapshot_path: str = "resources/vm-1/facts/backup_status/value",
    source: str = "recovery_services",
    collected_at: str = "2026-07-15T09:00:00Z",
    anchor_id: str | None = "tbl:resources:0",
    row_key: str = "vm-1",
    column_key: str = "Backup Status",
) -> FigureLedger:
    """Build a ledger with one text fact, optionally anchored."""
    facts_map = {snapshot_path: value}
    ledger = FigureLedger()
    with _compile_ctx(facts_map):
        fact = TextFact(
            path=path,
            key=key,
            value=value,
            snapshot_path=snapshot_path,
            source=source,
            collected_at=collected_at,
            formatted=value,
        )
    ledger.insert_text_fact(fact)
    if anchor_id is not None:
        ledger.record_text_fact_anchor(
            FigurePath(path),
            TableAnchor(kind=ANCHOR_TABLE, anchor_id=anchor_id, row_key=row_key, column_key=column_key),
        )
    return ledger


# --- zero text facts: clean pass -------------------------------------------------------


def test_zero_text_facts_produces_clean_pass() -> None:
    ledger = FigureLedger()
    grids: tuple[TableGrid, ...] = ()
    result = check_text_facts(ledger, grids)
    assert result.findings == ()
    assert result.entries_checked == 0
    assert result.entries_resolved == 0


# --- matching: resolved when cell equals formatted ------------------------------------


def test_exact_match_resolves() -> None:
    ledger = _ledger_with_text_fact(value="Succeeded")
    grids = (
        _grid("tbl:resources:0", ("Resource", "Backup Status"), (("vm-1", "Succeeded"),)),
    )
    result = check_text_facts(ledger, grids)
    assert result.findings == ()
    assert result.entries_checked == 1
    assert result.entries_resolved == 1


# --- text_fact_mismatch ---------------------------------------------------------------


def test_mismatch_when_cell_differs_from_formatted() -> None:
    """A single character mutation produces text_fact_mismatch."""
    ledger = _ledger_with_text_fact(value="Succeeded")
    grids = (
        _grid("tbl:resources:0", ("Resource", "Backup Status"), (("vm-1", "Failed"),)),
    )
    result = check_text_facts(ledger, grids)
    assert len(result.findings) == 1
    finding = result.findings[0]
    assert finding["type"] == FINDING_TEXT_FACT_MISMATCH
    assert finding["severity"] == SEVERITY_BLOCKING
    assert finding["table_id"] == "tbl:resources:0"
    assert finding["row_key"] == "vm-1"
    assert finding["column_key"] == "Backup Status"
    assert result.entries_checked == 1
    assert result.entries_resolved == 0


def test_mismatch_no_trimming_or_normalization() -> None:
    """Whitespace differences count as mismatches — no trimming, no normalization."""
    ledger = _ledger_with_text_fact(value="Succeeded")
    grids = (
        _grid("tbl:resources:0", ("Resource", "Backup Status"), (("vm-1", " Succeeded"),)),
    )
    result = check_text_facts(ledger, grids)
    assert len(result.findings) == 1
    assert result.findings[0]["type"] == FINDING_TEXT_FACT_MISMATCH


def test_mismatch_no_case_folding() -> None:
    """Case differences count as mismatches — no case folding."""
    ledger = _ledger_with_text_fact(value="Succeeded")
    grids = (
        _grid("tbl:resources:0", ("Resource", "Backup Status"), (("vm-1", "succeeded"),)),
    )
    result = check_text_facts(ledger, grids)
    assert len(result.findings) == 1
    assert result.findings[0]["type"] == FINDING_TEXT_FACT_MISMATCH


# --- text_fact_anchor_missing ---------------------------------------------------------


def test_anchor_missing_when_table_not_in_document() -> None:
    """Anchor recorded but no table with that identity in the document."""
    ledger = _ledger_with_text_fact()
    grids: tuple[TableGrid, ...] = ()  # no tables at all
    result = check_text_facts(ledger, grids)
    assert len(result.findings) == 1
    finding = result.findings[0]
    assert finding["type"] == FINDING_TEXT_FACT_ANCHOR_MISSING
    assert finding["severity"] == SEVERITY_BLOCKING


def test_anchor_missing_when_column_not_found() -> None:
    """Table exists but column key doesn't match any header."""
    ledger = _ledger_with_text_fact(column_key="Nonexistent Column")
    grids = (
        _grid("tbl:resources:0", ("Resource", "Backup Status"), (("vm-1", "Succeeded"),)),
    )
    result = check_text_facts(ledger, grids)
    assert len(result.findings) == 1
    assert result.findings[0]["type"] == FINDING_TEXT_FACT_ANCHOR_MISSING


def test_anchor_missing_when_row_not_found() -> None:
    """Table exists but row key doesn't match any data row."""
    ledger = _ledger_with_text_fact(row_key="nonexistent-vm")
    grids = (
        _grid("tbl:resources:0", ("Resource", "Backup Status"), (("vm-1", "Succeeded"),)),
    )
    result = check_text_facts(ledger, grids)
    assert len(result.findings) == 1
    assert result.findings[0]["type"] == FINDING_TEXT_FACT_ANCHOR_MISSING


# --- text_fact_unanchored -------------------------------------------------------------


def test_unanchored_when_no_anchor_recorded() -> None:
    """A text fact with no anchor recorded at all."""
    ledger = _ledger_with_text_fact(anchor_id=None)
    grids = (
        _grid("tbl:resources:0", ("Resource", "Backup Status"), (("vm-1", "Succeeded"),)),
    )
    result = check_text_facts(ledger, grids)
    assert len(result.findings) == 1
    finding = result.findings[0]
    assert finding["type"] == FINDING_TEXT_FACT_UNANCHORED
    assert finding["severity"] == SEVERITY_BLOCKING
    # Unanchored facts are not counted in entries_checked
    assert result.entries_checked == 0


# --- multiple text facts in one document -----------------------------------------------


def test_multiple_text_facts_all_matched() -> None:
    """Multiple text facts all resolving correctly."""
    facts_map = {
        "resources/vm-1/facts/backup_status/value": "Succeeded",
        "resources/vm-1/facts/vm_size/value": "Standard_D4s_v3",
    }
    ledger = FigureLedger()
    with _compile_ctx(facts_map):
        fact1 = TextFact(
            path="block1:0",
            key="backup_status",
            value="Succeeded",
            snapshot_path="resources/vm-1/facts/backup_status/value",
            source="recovery_services",
            collected_at="2026-07-15T09:00:00Z",
            formatted="Succeeded",
        )
        fact2 = TextFact(
            path="block1:1",
            key="vm_size",
            value="Standard_D4s_v3",
            snapshot_path="resources/vm-1/facts/vm_size/value",
            source="resource_graph",
            collected_at="2026-07-15T09:00:00Z",
            formatted="Standard_D4s_v3",
        )
    ledger.insert_text_fact(fact1)
    ledger.insert_text_fact(fact2)
    ledger.record_text_fact_anchor(
        FigurePath("block1:0"),
        TableAnchor(kind=ANCHOR_TABLE, anchor_id="tbl:resources:0", row_key="vm-1", column_key="Backup Status"),
    )
    ledger.record_text_fact_anchor(
        FigurePath("block1:1"),
        TableAnchor(kind=ANCHOR_TABLE, anchor_id="tbl:resources:0", row_key="vm-1", column_key="VM Size"),
    )
    grids = (
        _grid(
            "tbl:resources:0",
            ("Resource", "Backup Status", "VM Size"),
            (("vm-1", "Succeeded", "Standard_D4s_v3"),),
        ),
    )
    result = check_text_facts(ledger, grids)
    assert result.findings == ()
    assert result.entries_checked == 2
    assert result.entries_resolved == 2


def test_multiple_text_facts_mixed_results() -> None:
    """One matching, one mismatched — both are checked independently."""
    facts_map = {
        "resources/vm-1/facts/backup_status/value": "Succeeded",
        "resources/vm-1/facts/vm_size/value": "Standard_D4s_v3",
    }
    ledger = FigureLedger()
    with _compile_ctx(facts_map):
        fact1 = TextFact(
            path="block1:0",
            key="backup_status",
            value="Succeeded",
            snapshot_path="resources/vm-1/facts/backup_status/value",
            source="recovery_services",
            collected_at="2026-07-15T09:00:00Z",
            formatted="Succeeded",
        )
        fact2 = TextFact(
            path="block1:1",
            key="vm_size",
            value="Standard_D4s_v3",
            snapshot_path="resources/vm-1/facts/vm_size/value",
            source="resource_graph",
            collected_at="2026-07-15T09:00:00Z",
            formatted="Standard_D4s_v3",
        )
    ledger.insert_text_fact(fact1)
    ledger.insert_text_fact(fact2)
    ledger.record_text_fact_anchor(
        FigurePath("block1:0"),
        TableAnchor(kind=ANCHOR_TABLE, anchor_id="tbl:resources:0", row_key="vm-1", column_key="Backup Status"),
    )
    ledger.record_text_fact_anchor(
        FigurePath("block1:1"),
        TableAnchor(kind=ANCHOR_TABLE, anchor_id="tbl:resources:0", row_key="vm-1", column_key="VM Size"),
    )
    # Second fact has wrong value in the document
    grids = (
        _grid(
            "tbl:resources:0",
            ("Resource", "Backup Status", "VM Size"),
            (("vm-1", "Succeeded", "Standard_E4s_v3"),),  # vm_size mutated
        ),
    )
    result = check_text_facts(ledger, grids)
    assert len(result.findings) == 1
    assert result.findings[0]["type"] == FINDING_TEXT_FACT_MISMATCH
    assert result.entries_checked == 2
    assert result.entries_resolved == 1


# --- the no-character-inserted-between-runs comparison --------------------------------


def test_concatenation_inserts_no_character_between_runs() -> None:
    """The comparison is the cell's runs concatenated with no separator.

    This test verifies by checking that a value that equals the concatenation passes,
    while the same value with a space between would fail.
    """
    # If the cell contains "Standard_D4s_v3" as a single run, it matches
    ledger = _ledger_with_text_fact(value="Standard_D4s_v3")
    grids = (
        _grid("tbl:resources:0", ("Resource", "Backup Status"), (("vm-1", "Standard_D4s_v3"),)),
    )
    result = check_text_facts(ledger, grids)
    assert result.findings == ()

    # If the document had "Standard_D4s_ v3" (space inserted between runs), it mismatches
    grids_with_space = (
        _grid("tbl:resources:0", ("Resource", "Backup Status"), (("vm-1", "Standard_D4s_ v3"),)),
    )
    result2 = check_text_facts(ledger, grids_with_space)
    assert len(result2.findings) == 1
    assert result2.findings[0]["type"] == FINDING_TEXT_FACT_MISMATCH


# --- fact_source_missing: compile-time guard (Req 6.11) --------------------------------


def test_a_fact_with_no_source_is_unreadable() -> None:
    """Req 6.11 — a fact with no `source` cannot be constructed, so it cannot compile.

    The gate is `FactTextValue.__post_init__`, and this test goes through the real
    constructor. An earlier version of this test defeated that constructor with
    `object.__setattr__` in order to reach a second guard in `BlockCursor.text_fact` —
    which meant it passed by manufacturing a state no production path can produce, and
    certified a guard that could never fire. The guard is gone; this is the gate.
    """
    from reporting_agent.compile.snapshot_view import FactTextValue
    from reporting_agent.errors import CompileFailedError

    with pytest.raises(CompileFailedError, match="fact_source_missing") as exc_info:
        FactTextValue(
            key="backup_status",
            value="Succeeded",
            source="",
            collected_at="2026-07-15T09:00:00Z",
            pointer="/resources/0/facts/0/value",
            resource_id="vm-1",
        )

    msg = str(exc_info.value)
    assert "source" in msg, f"the absent field is not named: {msg}"
    assert "vm-1" in msg, f"resource_id not in message: {msg}"
    assert "backup_status" in msg, f"key not in message: {msg}"


def test_a_fact_with_no_collected_at_is_unreadable() -> None:
    """Req 6.11 — the same gate, for the observation instant.

    Separate from the `source` case rather than parametrized with it, because the two
    absences mean different things: no source is *unprovenanced*, no instant is
    *undated*, and a document must not carry either.
    """
    from reporting_agent.compile.snapshot_view import FactTextValue
    from reporting_agent.errors import CompileFailedError

    with pytest.raises(CompileFailedError, match="fact_source_missing") as exc_info:
        FactTextValue(
            key="backup_status",
            value="Succeeded",
            source="recovery_services",
            collected_at="",
            pointer="/resources/0/facts/0/value",
            resource_id="vm-1",
        )

    msg = str(exc_info.value)
    assert "collected_at" in msg, f"the absent field is not named: {msg}"
    assert "vm-1" in msg, f"resource_id not in message: {msg}"
    assert "backup_status" in msg, f"key not in message: {msg}"


def test_a_complete_fact_constructs_and_reaches_the_ledger() -> None:
    """The guard-the-guard: the gate rejects an incomplete fact and *only* that.

    Without this, a `__post_init__` that raised unconditionally would pass both tests
    above. It is also the proof that no artifact escapes on the failing path: the same
    factory that records a complete fact in the ledger records nothing when construction
    raises, because construction happens first.
    """
    from reporting_agent.compile.figures import BlockCursor, FigureLedger
    from reporting_agent.compile.snapshot_view import FactTextValue

    class FakeResolver:
        def resolve_all(self, raw_pointer: str) -> tuple[object, ...]:
            return ()

        def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
            return ("Succeeded",)

    complete = FactTextValue(
        key="backup_status",
        value="Succeeded",
        source="recovery_services",
        collected_at="2026-07-15T09:00:00Z",
        pointer="/resources/0/facts/0/value",
        resource_id="vm-1",
    )

    ledger = FigureLedger()
    with compiling_against(FakeResolver()):
        cursor = BlockCursor(block_id="block1", ledger=ledger).child("nodes", 0)
        cursor.text_fact(complete)

    assert len(ledger.text_facts()) == 1, "a complete fact must reach the ledger"
    assert len(ledger) == 0, "a text fact is not a figure and must not be counted as one"
