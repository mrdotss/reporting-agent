"""Anchored cell equality — the pass a transposition cannot survive (Req 27).

The tempting implementation asks whether each ledger `formatted` string appears *somewhere*
in the document. Take a table with the columns `Avg CPU` and `Max CPU` whose cell texts are
transposed across every data row. Every `formatted` string is still present — attached to the
wrong things — so containment records zero discrepancies and calls the document verified, and
the reader gets a report in which every VM's average and peak are swapped. That is exactly the
class of error that survives review by looking reasonable.

So this pass never asks where a string appears. It resolves, in the order **table, then
column, then row** (Req 27.1), the one cell the ledger says a figure belongs in, and asserts
that cell's text equals the figure's `formatted` string character for character. Zero or more
than one match at any step is its own finding, because a column key resolving to two columns
has no single cell to compare.

## Exact equality at every step, and what that buys

Resolution is by **exact equality only** — never ordinal position, prefix, case-insensitive
match or any similarity measure (Req 27.9). That is what makes a *reordered* column verify
cleanly while a *transposed value* fails, and those are the two cases a positional
implementation gets backwards: it passes the transposition (the cell at (2, 3) still holds a
number) and fails the reordering (the column moved).

The comparison itself applies no trimming beyond the extraction's own, no whitespace
normalization, no case folding, no unit stripping and **no re-parsing of either side as a
number** (Req 27.2). Re-parsing would be the subtlest way to lose: `12.40` and `12.4` are the
same number and two different documents, and the one this product delivers is the one the
Formatter produced.

## What the pass reports back, and why it is more than findings

`AnchorPass` carries three sets alongside the findings, and each answers a question only this
pass can answer:

* `matched` — the ledger paths whose cell text equalled `formatted`. Req 29.2's backward
  completeness reads it: a table entry "appears" only if its anchored cell matched.
* `faulted` — the ledger paths this pass already recorded a blocking finding for. Req 29.8
  reads it so an entry unrendered *because* its anchor was unresolvable records no second
  finding, and one rendering defect stays one finding.
* `blocking_identities` — the table identities carrying a blocking finding. Req 30.5 reads it:
  a chart is verified only where its companion table's anchored pass was clean **and** its
  recomputed hash matched.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT
from reporting_agent.compile.figures import FigureLedger, TableAnchor
from reporting_agent.verify.findings import (
    FINDING_DUPLICATE_TABLE_ANCHOR,
    FINDING_TABLE_ANCHOR_MISSING,
    FINDING_TABLE_ANCHOR_UNEXPECTED,
    FINDING_TABLE_CELL_MISMATCH,
    FINDING_TABLE_COLUMN_UNRESOLVED,
    FINDING_TABLE_ROW_UNRESOLVED,
    FINDING_TABLE_ROWS_ABSENT,
    Finding,
    record_finding,
)
from reporting_agent.verify.tokens import data_tables, table_grid

__all__ = [
    "HEADER_ROW_ORDINAL",
    "KEY_COLUMN_ORDINAL",
    "AnchorPass",
    "TableGrid",
    "check_tables",
    "containment_discrepancies",
    "read_grids",
]

HEADER_ROW_ORDINAL: Final[int] = 0
"""The table's first row is its header row, and every later row is a data row (Req 27.10)."""

KEY_COLUMN_ORDINAL: Final[int] = 0
"""Mirrors `render/anchors.py`'s designated key column. Duplicated as a constant rather than
imported so `verify/` does not depend on `render/` — the verifier reads a `.docx`, and the
number it needs is a property of the emitted grid, not of the emitter."""


@dataclass(frozen=True, slots=True)
class TableGrid:
    """One captioned table, read back out of the document.

    `rows` holds the **data** rows only; the header row is `headers`. `ordinal` is the
    caption-bearing table's position in the document, and it is here so a
    `duplicate_table_anchor` finding can say which two tables collided rather than only that
    a collision happened.
    """

    identity: str
    ordinal: int
    headers: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]

    @property
    def row_keys(self) -> tuple[str, ...]:
        """Each data row's key — the text of its cell in the designated key column.

        A row too short to reach that column yields `""`, which resolves against no anchor
        and is reported as `table_row_unresolved` rather than silently skipped.
        """
        return tuple(
            row[KEY_COLUMN_ORDINAL] if len(row) > KEY_COLUMN_ORDINAL else ""
            for row in self.rows
        )

    def is_empty_scope_notice(self) -> bool:
        """Whether this table is the explicit no-resources-matched row and nothing else.

        Req 27.11's exemption. Matched on the emitted text because that is all the document
        carries — the compiler's notice row key is not written into the `.docx`.
        """
        return len(self.rows) == 1 and any(
            cell == EMPTY_SCOPE_TEXT for cell in self.rows[0]
        )


@dataclass(frozen=True, slots=True)
class AnchorPass:
    """Everything one anchored-equality pass observed.

    Counts are recorded whether the pass found anything or not (Req 27.13), because a pass
    produced by checking zero anchors and a pass produced by checking all of them are
    otherwise the same result.
    """

    findings: tuple[Finding, ...]
    matched: frozenset[str]
    faulted: frozenset[str]
    blocking_identities: frozenset[str]
    anchors_checked: int
    tables_resolved: int


def read_grids(document: object) -> tuple[TableGrid, ...]:
    """Every captioned table of `document`, as a grid (Req 26.4).

    A captioned table carrying **no** rows at all yields empty `headers` and no data rows.
    That is not a state the renderer can produce — `emit_table` always writes a header row —
    so it is left to surface as `table_column_unresolved` against whatever anchors name it,
    rather than being special-cased into a finding of its own that no emitter can trigger.
    """
    grids: list[TableGrid] = []
    for table in data_tables(document):
        cells = table_grid(table.element)
        headers = cells[HEADER_ROW_ORDINAL] if cells else ()
        grids.append(
            TableGrid(
                identity=table.identity,
                ordinal=table.ordinal,
                headers=headers,
                rows=cells[HEADER_ROW_ORDINAL + 1 :],
            )
        )
    return tuple(grids)


def _sort_key(finding: Finding) -> tuple[str, str, str, str]:
    """Req 27.14's total order: table identity, then row key, then column key.

    The finding type joins the key last so two findings that differ only in type — a
    `table_rows_absent` and a `table_anchor_unexpected` on one identity — still order
    identically across two runs.
    """
    return (
        str(finding.get("table_id", "")),
        str(finding.get("row_key", "")),
        str(finding.get("column_key", "")),
        str(finding.get("type", "")),
    )


def check_tables(
    ledger: FigureLedger,
    grids: Sequence[TableGrid],
    *,
    scope_counts: Mapping[str, int] | None = None,
) -> AnchorPass:
    """Check every table anchor the ledger records against the document's grids.

    `scope_counts` maps a table identity to the number of resources that block's scope
    resolved to, and it is what Req 27.10 needs to tell "the block rendered nothing" from
    "the block had nothing to render". An identity absent from the mapping records no
    `table_rows_absent`: the count is unknown, and inventing one would be a finding about the
    verifier's own ignorance.

    Every anchor is checked rather than stopping at the first failure (Req 27.12), so one
    verification names every mis-anchored cell.
    """
    counts = dict(scope_counts or {})
    by_identity: dict[str, list[TableGrid]] = {}
    for grid in grids:
        by_identity.setdefault(grid.identity, []).append(grid)

    findings: list[Finding] = []
    matched: set[str] = set()
    faulted: set[str] = set()

    findings.extend(_duplicate_findings(by_identity))
    findings.extend(_unexpected_findings(by_identity, ledger))
    findings.extend(_rows_absent_findings(by_identity, ledger, counts))

    anchors = ledger.anchors()
    anchors_checked = 0
    for path, anchor in anchors.items():
        if anchor.row_key is None or anchor.column_key is None:
            # A figure inside a table node that the emitter never placed in a cell. The
            # emitter completes the triple for every `FigureCell` it writes, so this is a
            # figure in a table's caption or a padded position — nothing to resolve, and
            # nothing to claim about it either way. Backward completeness still checks it,
            # through the prose path, so it is not excluded from both.
            continue
        anchors_checked += 1
        finding = _check_anchor(
            path=str(path),
            anchor=anchor,
            formatted=ledger[path].formatted,
            candidates=by_identity.get(anchor.anchor_id, []),
        )
        if finding is None:
            matched.add(str(path))
        else:
            faulted.add(str(path))
            findings.append(finding)

    ordered = tuple(sorted(findings, key=_sort_key))
    return AnchorPass(
        findings=ordered,
        matched=frozenset(matched),
        faulted=frozenset(faulted),
        blocking_identities=frozenset(
            str(finding["table_id"]) for finding in ordered if "table_id" in finding
        ),
        anchors_checked=anchors_checked,
        tables_resolved=sum(
            1 for identity in by_identity if identity in ledger.table_identities()
        ),
    )


def _duplicate_findings(by_identity: Mapping[str, list[TableGrid]]) -> list[Finding]:
    """Req 27.5's other half: two data tables sharing one identity.

    Reported once per identity rather than once per colliding table — the defect is the
    collision, and two findings would double-count one document error in the blocking total.
    """
    return [
        record_finding(
            FINDING_DUPLICATE_TABLE_ANCHOR,
            f"the document carries {len(candidates)} data tables whose caption identity is "
            f"{identity!r}, at ordinals "
            f"{', '.join(str(grid.ordinal) for grid in candidates)}; an anchor naming that "
            f"identity resolves to no single table",
            table_id=identity,
        )
        for identity, candidates in sorted(by_identity.items())
        if len(candidates) > 1
    ]


def _unexpected_findings(
    by_identity: Mapping[str, list[TableGrid]], ledger: FigureLedger
) -> list[Finding]:
    """A data table the ledger never registered (Req 27.5).

    Checked against the ledger's **registered table identities**, not against the set of
    identities carrying anchors. A data table with zero figures — an empty-scope block, a
    `gaps_and_coverage` over a clean run — is registered and carries no anchor, and reporting
    it here would fail a document the compiler emitted correctly.
    """
    registered = ledger.table_identities()
    return [
        record_finding(
            FINDING_TABLE_ANCHOR_UNEXPECTED,
            f"the document carries a data table captioned {identity!r} that this render's "
            f"figure ledger never registered; every captioned table is a table the verifier "
            f"is expected to be able to resolve",
            table_id=identity,
        )
        for identity in sorted(by_identity)
        if identity not in registered
    ]


def _rows_absent_findings(
    by_identity: Mapping[str, list[TableGrid]],
    ledger: FigureLedger,
    scope_counts: Mapping[str, int],
) -> list[Finding]:
    """A table that rendered no rows while its block's scope held resources (Req 27.10).

    The exemption in Req 27.11 is narrow on purpose and both halves are required: the table
    carries the explicit notice row as its **only** data row **and** carries zero anchors. A
    table with the notice row plus anchors is a block that rendered its notice *and* some
    figures, which is not a state the compiler produces and not one to wave through.
    """
    anchored = {anchor.anchor_id for anchor in ledger.anchors().values()}
    findings: list[Finding] = []
    for identity, candidates in sorted(by_identity.items()):
        expected = scope_counts.get(identity)
        if expected is None or expected < 1:
            continue
        for grid in candidates:
            if grid.is_empty_scope_notice() and identity not in anchored:
                continue  # Req 27.11
            if grid.rows:
                continue
            findings.append(
                record_finding(
                    FINDING_TABLE_ROWS_ABSENT,
                    f"the data table {identity!r} carries 0 data rows while its block's "
                    f"scope resolved to {expected} resource(s); a block that silently "
                    f"rendered nothing is indistinguishable in the delivered document from "
                    f"a block that was never configured",
                    table_id=identity,
                )
            )
    return findings


def _check_anchor(
    *,
    path: str,
    anchor: TableAnchor,
    formatted: str,
    candidates: Sequence[TableGrid],
) -> Finding | None:
    """Resolve one anchor and compare (Req 27.1, 27.2). `None` means the cell matched.

    A duplicate identity resolves to no single table and is reported here as
    `table_anchor_missing` for this anchor — the document-level `duplicate_table_anchor` names
    the collision itself, and this names the figure that could not be checked because of it.
    """
    identity = anchor.anchor_id
    row_key = anchor.row_key or ""
    column_key = anchor.column_key or ""

    if len(candidates) != 1:
        why = (
            "the document does not carry"
            if not candidates
            else f"resolves to {len(candidates)} tables in"
        )
        return record_finding(
            FINDING_TABLE_ANCHOR_MISSING,
            f"the figure at {path} is anchored to the data table {identity!r}, which {why} "
            f"the document",
            ast_path=path,
            table_id=identity,
            row_key=row_key,
            column_key=column_key,
            formatted=formatted,
        )
    grid = candidates[0]

    column_matches = [
        ordinal for ordinal, header in enumerate(grid.headers) if header == column_key
    ]
    if len(column_matches) != 1:
        return record_finding(
            FINDING_TABLE_COLUMN_UNRESOLVED,
            f"the column key {column_key!r} matches {len(column_matches)} column(s) of the "
            f"data table {identity!r}; a column key resolving to none or to several has no "
            f"single cell to compare",
            ast_path=path,
            table_id=identity,
            row_key=row_key,
            column_key=column_key,
            match_count=len(column_matches),
        )
    column_ordinal = column_matches[0]

    row_matches = [
        ordinal for ordinal, key in enumerate(grid.row_keys) if key == row_key
    ]
    if len(row_matches) != 1:
        return record_finding(
            FINDING_TABLE_ROW_UNRESOLVED,
            f"the row key {row_key!r} matches {len(row_matches)} data row(s) of the data "
            f"table {identity!r}",
            ast_path=path,
            table_id=identity,
            row_key=row_key,
            column_key=column_key,
            match_count=len(row_matches),
        )
    row = grid.rows[row_matches[0]]

    # A row shorter than the resolved column is a cell that was never emitted. Reported as an
    # empty observed string rather than as its own finding type: the ledger says a figure
    # belongs at this position and the document holds nothing there, which is a mismatch.
    observed = row[column_ordinal] if len(row) > column_ordinal else ""
    if observed == formatted:
        return None

    return record_finding(
        FINDING_TABLE_CELL_MISMATCH,
        f"the data table {identity!r} row {row_key!r} column {column_key!r} holds "
        f"{observed!r}, but the figure ledger records {formatted!r} at {path}",
        ast_path=path,
        table_id=identity,
        row_key=row_key,
        column_key=column_key,
        expected=formatted,
        observed=observed,
    )


def containment_discrepancies(
    ledger: FigureLedger, grids: Sequence[TableGrid]
) -> tuple[str, ...]:
    """Every `formatted` string absent from **every** cell of **every** data table.

    Not part of the gate, and deliberately so: this is the check this module exists to be
    better than, kept here so the argument is executable rather than only written down. Req
    44.3's negative test transposes two columns and asserts that the anchored pass fails
    **while this returns nothing** — which is what makes the test fail against a verifier
    that quietly checks containment.
    """
    cells = {cell for grid in grids for row in grid.rows for cell in row}
    return tuple(
        sorted(
            {
                figure.formatted
                for figure in ledger.entries.values()
                if figure.formatted not in cells
            }
        )
    )
