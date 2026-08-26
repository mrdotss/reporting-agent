"""The `blank_rows_table` block type — section 13's author-filled table with ruled
empty rows.

A `resource_table` cannot emit a row with no resource, because its contract is one
row per resolved resource and an empty resolution emits the explicit "No resources
matched" marker. The incident-report section needs a table whose rows are never
resolved: they exist so a consultant can fill them in after printing. This block
emits a table of empty cells at the declared column count and row count.

The block carries no figure, no metric and no scope. Its cells are `EmptyCell`
instances that produce no ledger entry and no anchor — an empty cell is not a zero,
and the verifier's bidirectional ledger completeness is unaffected by them.
"""

from __future__ import annotations

from reporting_agent.compile.ast import Column, EmptyCell, Row, Table
from reporting_agent.compile.blocks.base import (
    BlockContext,
    BlockOutput,
    BlockSpec,
)
from reporting_agent.compile.figures import BlockCursor

__all__ = ["compile_blank_rows_table"]


def _blank_row(cursor: BlockCursor, row_idx: int, column_count: int) -> Row:
    """One row of `EmptyCell`s at `row_idx`, one per declared column.

    `BlockCursor.child` takes exactly one field name and one ordinal per call, so a
    two-level position (row, then cell within that row) is two chained calls, not one
    call carrying both ordinals.
    """
    row_cursor = cursor.child("rows", row_idx)
    return Row(
        path=row_cursor.path,
        key=f"row_{row_idx}",
        cells=tuple(
            EmptyCell(path=row_cursor.child("cells", col_idx).path)
            for col_idx in range(column_count)
        ),
    )


def compile_blank_rows_table(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """Emit a table of blank cells.

    Config:
    - `columns`: list of column header strings
    - `rows`: number of empty rows to emit (default 5)
    - `caption`: optional table caption
    """
    columns = block.config.get("columns")
    if not isinstance(columns, list) or not columns:
        raise block.fail("config.columns must be a non-empty list of strings")
    for col in columns:
        if not isinstance(col, str) or not col:
            raise block.fail("every entry in config.columns must be a non-empty string")

    rows_count = block.config.get("rows", 5)
    if not isinstance(rows_count, int) or isinstance(rows_count, bool) or rows_count < 1:
        raise block.fail("config.rows must be a positive integer")

    # Build Column descriptors
    table_columns = tuple(
        Column(key=col, header=col) for col in columns
    )

    # Build empty data rows
    table_rows = tuple(
        _blank_row(cursor, row_idx, len(columns)) for row_idx in range(rows_count)
    )

    table = Table(
        path=cursor.child("nodes", 0).path,
        style="Table Grid",
        columns=table_columns,
        rows=table_rows,
        caption=block.config.get("caption"),
    )

    return BlockOutput(nodes=(table,))
