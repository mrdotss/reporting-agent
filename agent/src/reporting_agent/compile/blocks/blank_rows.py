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

`config.supplied_rows` (optional) is author-typed text, resolved into that
distinct destination the user's own spec named — Section 13, a numbered content
section near the end of the document, never document control (that page is front
matter). Supplied rows print first, in the author's own entry order, and the
table pads with `EmptyCell` rows up to `config.rows`'s **minimum total** — zero
supplied rows reproduces exactly the all-blank behaviour this block always had.
A supplied row's text is presentation, exactly like a revision-history note: it
enters no figure ledger, is checked by no numeric gate, and its absence is not a
verification finding. The row's own ordinal (`No`, `1, 2, 3…`) is compiler-generated
and never typed, and it is a `TextCell` holding the digit string, never an
`EmptyCell` even on a padding row — the ordinal exists whether or not the row's
content does, which is what makes the printed sequence continuous. It is
deliberately not a `DerivedCount`, since it numbers rows rather than counting
anything about the estate, so it must never enter the `DerivedCount`
re-derivation path `verify/allowlist.py` and the coverage appendix use for
figures that really do describe the collected estate. The `No` column itself is
prepended automatically and is never part of `config.columns` — an author who
typed a "No" header would collide with the one the compiler already emits, so
the column simply does not exist in the config the author writes.
"""

from __future__ import annotations

from reporting_agent.compile.ast import Column, EmptyCell, Row, Table, TextCell
from reporting_agent.compile.blocks.base import (
    BlockContext,
    BlockOutput,
    BlockSpec,
)
from reporting_agent.compile.figures import BlockCursor

__all__ = ["compile_blank_rows_table"]

_ORDINAL_COLUMN_KEY = "no"
_ORDINAL_COLUMN_HEADER = "No"


def _supplied_row(
    cursor: BlockCursor, row_idx: int, values: list[str], column_count: int
) -> Row:
    """One row of `TextCell`s: the compiler-generated ordinal first, then one
    `TextCell` per declared column built from `values`.

    `values` is validated by the caller to have exactly `column_count` entries
    before this is called, so this function does not re-check that — it exists
    to keep the two row-construction shapes (`_supplied_row`, `_blank_row`)
    symmetric and equally simple, not to defend against a shape its caller
    already refused.
    """
    row_cursor = cursor.child("rows", row_idx)
    ordinal_cell = TextCell(
        path=row_cursor.child("cells", 0).path,
        text=str(row_idx + 1),
    )
    return Row(
        path=row_cursor.path,
        key=f"row_{row_idx}",
        cells=(
            ordinal_cell,
            *(
                TextCell(
                    path=row_cursor.child("cells", col_idx + 1).path,
                    text=value,
                )
                for col_idx, value in enumerate(values)
            ),
        ),
    )


def _blank_row(cursor: BlockCursor, row_idx: int, column_count: int) -> Row:
    """One row for a padding position: the compiler-generated ordinal (a real
    `TextCell`, since the row's position in the sequence is a fact regardless
    of whether its content was ever supplied), then one `EmptyCell` per
    declared column.

    `BlockCursor.child` takes exactly one field name and one ordinal per call, so a
    two-level position (row, then cell within that row) is two chained calls, not one
    call carrying both ordinals.
    """
    row_cursor = cursor.child("rows", row_idx)
    ordinal_cell = TextCell(
        path=row_cursor.child("cells", 0).path,
        text=str(row_idx + 1),
    )
    return Row(
        path=row_cursor.path,
        key=f"row_{row_idx}",
        cells=(
            ordinal_cell,
            *(
                EmptyCell(path=row_cursor.child("cells", col_idx + 1).path)
                for col_idx in range(column_count)
            ),
        ),
    )


def compile_blank_rows_table(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """Emit a table of author-supplied rows (if any), padded with blank cells
    up to the declared minimum row count, with a compiler-generated `No`
    ordinal column prepended to every row.

    Config:
    - `columns`: list of column header strings — never including `No`, which
      the compiler always prepends
    - `rows`: the MINIMUM total row count — padding fills up to this count,
      never below it. Default 5.
    - `supplied_rows`: optional list of string lists, one per author-supplied
      row, each of exactly `len(columns)` entries (excluding `No`). Printed
      first, in order.
    - `caption`: optional table caption
    """
    columns = block.config.get("columns")
    if not isinstance(columns, list) or not columns:
        raise block.fail("config.columns must be a non-empty list of strings")
    for col in columns:
        if not isinstance(col, str) or not col:
            raise block.fail("every entry in config.columns must be a non-empty string")
        if col.strip().lower() == _ORDINAL_COLUMN_KEY:
            raise block.fail(
                "config.columns must not declare a \"No\" column — the ordinal "
                "column is generated by the compiler and prepended automatically"
            )

    rows_count = block.config.get("rows", 5)
    if not isinstance(rows_count, int) or isinstance(rows_count, bool) or rows_count < 1:
        raise block.fail("config.rows must be a positive integer")

    supplied_rows_raw = block.config.get("supplied_rows", [])
    if not isinstance(supplied_rows_raw, list):
        raise block.fail("config.supplied_rows must be a list of lists")
    for entry in supplied_rows_raw:
        if not isinstance(entry, list) or len(entry) != len(columns):
            raise block.fail(
                f"every entry in config.supplied_rows must be a list of exactly "
                f"{len(columns)} strings, matching config.columns (excluding "
                f"the automatic \"No\" column)"
            )
        for value in entry:
            if not isinstance(value, str):
                raise block.fail(
                    "every value in a config.supplied_rows entry must be a string"
                )

    # Build Column descriptors: the ordinal column first, then the author's own.
    table_columns = (
        Column(key=_ORDINAL_COLUMN_KEY, header=_ORDINAL_COLUMN_HEADER),
        *(Column(key=col, header=col) for col in columns),
    )

    # Supplied rows print first, in entry order; padding fills the remainder up
    # to the declared minimum. `max(0, ...)` is what makes more supplied rows
    # than `rows` simply print all of them with no padding, rather than
    # truncating the author's own content to fit a minimum meant as a floor.
    supplied_row_nodes = tuple(
        _supplied_row(cursor, row_idx, values, len(columns))
        for row_idx, values in enumerate(supplied_rows_raw)
    )
    padding_count = max(0, rows_count - len(supplied_row_nodes))
    padding_row_nodes = tuple(
        _blank_row(cursor, len(supplied_row_nodes) + row_idx, len(columns))
        for row_idx in range(padding_count)
    )

    table = Table(
        path=cursor.child("nodes", 0).path,
        style=context.design.table_style_name,
        columns=table_columns,
        rows=supplied_row_nodes + padding_row_nodes,
        caption=block.config.get("caption"),
    )

    return BlockOutput(nodes=(table,))
