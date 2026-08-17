"""`row` — the one container block, and the one level of nesting there is.

A `row` compiles to a :class:`~reporting_agent.compile.ast.LayoutRow`: two or three
:class:`~reporting_agent.compile.ast.LayoutColumn`s, each holding its children's compiled
nodes in **declared order**. The column count is the tuple's own length, never a number in the
AST, so "2 or 3 columns" cannot disagree with the children the row actually holds (Req 15.6).

## A child block keeps its own identity

Each child is compiled with a cursor rooted at **its own** block id, not the row's. A figure
path starts with the block that emitted it, so a KPI row inside a column produces
`kpi-1:0.0.0` rather than something rooted at the row — which is what lets an error name the
block a template author edits and what keeps a nested block's ledger keys stable if the row
around it is later split or removed.

The consequence is that `compile/figures.py`'s assertion walk **stops at a `LayoutColumn`**:
descending would recompute a nested figure's position relative to the row and report every one
of them as misplaced. Each nested block is registered with the closing invariant under its own
id instead, so every figure is still walked exactly once.

## Emitted as a borderless layout table

`render/anchors.py` gives a `row` the `Layout Table` style and **no** `w:tblCaption` id, while
every data table always carries one. That is what lets the verifier's table pass exclude a
layout table **by construction** rather than by guessing from borders or cell count (Req 15.9)
— and guessing is exactly what a verifier over a reflowing document format must not do.

## Rows do not nest, and this compiler does not have to enforce it

The definition schema rejects a `row` inside a `row` at any depth, on both sides of the mirror
(Req 6.4). A second check here would be a second version of the same rule; if the two ever
disagreed, the one that mattered would be whichever ran first. A `row` reaching this compiler
with a `row` child is a mirror failure, and the corpus is what catches it.
"""

from __future__ import annotations

from collections.abc import Callable

from reporting_agent.compile.ast import Block, LayoutColumn, LayoutRow
from reporting_agent.compile.blocks.base import (
    BlockContext,
    BlockOutput,
    BlockSpec,
)
from reporting_agent.compile.figures import BlockCursor

__all__ = ["ChildCompiler", "compile_row"]

type ChildCompiler = Callable[[BlockContext, BlockSpec], tuple[BlockOutput, BlockCursor]]
"""How a row compiles a child.

Passed in rather than imported, so this module does not import the registry that imports it. It
also makes the dependency visible: a row's only capability beyond arranging nodes is compiling
the blocks it contains.
"""


def compile_row(
    context: BlockContext,
    block: BlockSpec,
    cursor: BlockCursor,
    *,
    compile_child: ChildCompiler,
) -> tuple[BlockOutput, dict[str, tuple[Block, ...]]]:
    """The layout container, plus each child's nodes registered under the child's own id.

    Returns both because the closing invariant
    (:func:`~reporting_agent.compile.figures.assert_ledger_matches_tree`) needs every block's
    nodes keyed by the block that emitted them, and a row's children are separate blocks whose
    figures are rooted at their own ids.

    A child that defers — an `executive_summary` inside a column — is refused rather than
    silently dropped: the deferred assembly happens after the whole document's phase one, and a
    node produced then could not be placed inside a `LayoutColumn` that was already built. A
    template can put a summary beside a table by using two blocks in document order instead,
    which is the arrangement the paginated format wants anyway.
    """
    row_cursor = cursor.child("nodes", 0)
    columns: list[LayoutColumn] = []
    child_nodes_by_id: dict[str, tuple[Block, ...]] = {}

    for column_ordinal, column in enumerate(block.columns):
        column_cursor = row_cursor.child("columns", column_ordinal)
        placed: list[Block] = []

        for child in column:
            output, _child_cursor = compile_child(context, child)
            if output.deferred is not None:
                raise block.fail(
                    f"child block {child.id!r} of type {child.type!r} defers its content "
                    f"until every figure exists, which cannot be placed inside a row column "
                    f"that has already been built; put it in document order instead"
                )
            placed.extend(output.nodes)
            child_nodes_by_id[child.id] = output.nodes

        columns.append(LayoutColumn(path=column_cursor.path, blocks=tuple(placed)))

    return (
        BlockOutput(nodes=(LayoutRow(path=row_cursor.path, columns=tuple(columns)),)),
        child_nodes_by_id,
    )
