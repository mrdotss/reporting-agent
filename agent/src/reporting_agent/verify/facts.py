"""The text-fact exact-string check — gate `facts` (Req 6.4, 6.5, 6.6, 6.7, 6.8, 6.10).

This pass reads the ledger's `text_facts` and `text_fact_anchors` and the `.docx` grids.
It does **not** read the figure entries — `verify/pdf.py` does not read the text-fact
entries either, so the two passes have disjoint inputs.

## Why this pass exists

`verify/masking.py`'s stage 2 masks tokens matching `[A-Za-z_][\\w.\\-]*[0-9][\\w.\\-]*`,
so `Standard_D4s_v3` would be masked as an identifier. A value such as `Succeeded`
carries no digit and is therefore never extracted as a numeric token at all. A text fact
therefore gets its own ledger entry and its own exact-string anchored check — the only
verification surface that can catch a mutated text fact.

## The comparison

The cell text is the cell's runs concatenated in document order **with no character
inserted between runs**. No trimming, no whitespace normalization, no case folding, no
re-parsing of either string. This is deliberately strict: the anchor writer emits a
`TextFact` as exactly one run in exactly one paragraph of that cell, so the concatenation
the check compares is the run the renderer wrote.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from reporting_agent.compile.figures import FigureLedger, FigurePath, TableAnchor
from reporting_agent.verify.anchors import TableGrid
from reporting_agent.verify.findings import (
    FINDING_TEXT_FACT_ANCHOR_MISSING,
    FINDING_TEXT_FACT_MISMATCH,
    FINDING_TEXT_FACT_UNANCHORED,
    Finding,
    record_finding,
)

__all__ = ["TextFactPass", "check_text_facts"]


@dataclass(frozen=True, slots=True)
class TextFactPass:
    """The result of checking every `TextFact` ledger entry against the document.

    `entries_checked` counts every entry for which a comparison was attempted.
    `entries_resolved` counts entries whose cell text matched `formatted` exactly.
    """

    findings: tuple[Finding, ...]
    entries_checked: int
    entries_resolved: int


def check_text_facts(
    ledger: FigureLedger,
    grids: Sequence[TableGrid],
) -> TextFactPass:
    """Check every `TextFact` ledger entry against the document grids.

    Three finding types:

    - `text_fact_mismatch`: the anchor resolves to exactly one cell whose runs
      concatenated in document order **with no character inserted between runs** differ
      from `formatted`.
    - `text_fact_anchor_missing`: the anchor **was** recorded and resolves to no cell.
    - `text_fact_unanchored`: the `TextFact` entry has **no anchor recorded at all**.
    """
    text_facts = ledger.text_facts()
    text_fact_anchors = ledger.text_fact_anchors()

    by_identity: dict[str, list[TableGrid]] = {}
    for grid in grids:
        by_identity.setdefault(grid.identity, []).append(grid)

    findings: list[Finding] = []
    entries_checked = 0
    entries_resolved = 0

    for path, fact in text_facts.items():
        anchor = text_fact_anchors.get(path)

        # --- text_fact_unanchored: no anchor at all ---
        if anchor is None:
            findings.append(
                record_finding(
                    FINDING_TEXT_FACT_UNANCHORED,
                    f"the text fact at {path!s} (key={fact.key!r}, value={fact.value!r}) "
                    f"has no recorded anchor; a TextFact outside a data-table cell "
                    f"carries no anchor and therefore cannot be checked",
                    ast_path=str(path),
                )
            )
            continue

        entries_checked += 1

        # Resolve the anchor against the document grids.
        finding = _resolve_anchor(
            path=path,
            anchor=anchor,
            formatted=fact.formatted,
            fact_key=fact.key,
            candidates=by_identity.get(anchor.anchor_id, []),
        )
        if finding is None:
            entries_resolved += 1
        else:
            findings.append(finding)

    return TextFactPass(
        findings=tuple(findings),
        entries_checked=entries_checked,
        entries_resolved=entries_resolved,
    )


def _resolve_anchor(
    *,
    path: FigurePath,
    anchor: TableAnchor,
    formatted: str,
    fact_key: str,
    candidates: Sequence[TableGrid],
) -> Finding | None:
    """Resolve one text-fact anchor and compare. `None` means the cell matched."""
    identity = anchor.anchor_id
    row_key = anchor.row_key or ""
    column_key = anchor.column_key or ""

    # --- text_fact_anchor_missing: anchor recorded but resolves to no cell ---
    if len(candidates) != 1:
        why = (
            "the document does not carry"
            if not candidates
            else f"resolves to {len(candidates)} tables in"
        )
        return record_finding(
            FINDING_TEXT_FACT_ANCHOR_MISSING,
            f"the text fact at {path!s} (key={fact_key!r}) is anchored to the data "
            f"table {identity!r}, which {why} the document",
            ast_path=str(path),
            table_id=identity,
            row_key=row_key,
            column_key=column_key,
        )

    grid = candidates[0]

    # Resolve column.
    column_matches = [
        ordinal for ordinal, header in enumerate(grid.headers) if header == column_key
    ]
    if len(column_matches) != 1:
        return record_finding(
            FINDING_TEXT_FACT_ANCHOR_MISSING,
            f"the text fact at {path!s} (key={fact_key!r}) is anchored to column "
            f"{column_key!r} of data table {identity!r}, which matches "
            f"{len(column_matches)} column(s)",
            ast_path=str(path),
            table_id=identity,
            row_key=row_key,
            column_key=column_key,
        )
    column_ordinal = column_matches[0]

    # Resolve row.
    row_matches = [
        ordinal for ordinal, key in enumerate(grid.row_keys) if key == row_key
    ]
    if len(row_matches) != 1:
        return record_finding(
            FINDING_TEXT_FACT_ANCHOR_MISSING,
            f"the text fact at {path!s} (key={fact_key!r}) is anchored to row "
            f"{row_key!r} of data table {identity!r}, which matches "
            f"{len(row_matches)} data row(s)",
            ast_path=str(path),
            table_id=identity,
            row_key=row_key,
            column_key=column_key,
        )
    row = grid.rows[row_matches[0]]

    # A row shorter than the resolved column means no cell at that position.
    observed = row[column_ordinal] if len(row) > column_ordinal else ""

    # --- the exact-string comparison: no trimming, no normalization, no case folding ---
    if observed == formatted:
        return None

    # --- text_fact_mismatch ---
    return record_finding(
        FINDING_TEXT_FACT_MISMATCH,
        f"the data table {identity!r} row {row_key!r} column {column_key!r} holds "
        f"{observed!r}, but the text fact ledger records {formatted!r} at {path!s} "
        f"(key={fact_key!r})",
        table_id=identity,
        row_key=row_key,
        column_key=column_key,
        ast_path=str(path),
        expected=formatted,
        observed=observed,
    )
