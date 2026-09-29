"""`at_a_glance` — the report's first page for a reader who reads one page.

Two parts, and no model in either:

* **Headline figures**, each a derived cardinality of this run's snapshot
  (`compile/snapshot_view.py`), so the verifier re-derives every one from the same
  document: resources in scope, resources that need tidying up (a `housekeeping`
  finding), resources without a backup, and stopped machines. The last three count
  **resources**, not gap entries — a resource with no backup carries two gaps on AWS.
* **Decisions for you**, at most three sentences chosen by fixed rules from what the
  snapshot holds, each a message template with no number in it. The figures above are the
  numbers; the sentences say what to do about them.

It says nothing about last month. A change against an earlier run is a figure that lives
in that run's snapshot, and the document is verified against exactly one.
"""

from __future__ import annotations

from typing import Final

from reporting_agent.compile.ast import Column, FigureCell, Paragraph, Row, Table
from reporting_agent.compile.blocks.base import (
    BlockContext,
    BlockOutput,
    BlockSpec,
    caption_of,
    empty_cell,
    text_cell,
    text_paragraph,
)
from reporting_agent.compile.figures import BlockCursor
from reporting_agent.compile.snapshot_view import HOUSEKEEPING_FACT_KEY, SnapshotView

__all__ = ["MAX_DECISIONS", "compile_at_a_glance", "decisions_for"]

MAX_DECISIONS: Final[int] = 3

RIGHTSIZING_FINDINGS: Final[frozenset[str]] = frozenset({"overprovisioned", "underprovisioned"})
"""Compute Optimizer's findings that recommend a different size."""

ADVISOR_TYPE: Final[str] = "microsoft.advisor/recommendations"


def _count(view: SnapshotView, *tokens: str) -> int:
    value = view.cardinality(*tokens)
    return 0 if value is None else int(value.value)


def decisions_for(view: SnapshotView) -> tuple[str, ...]:
    """The message ids of this month's decisions, most important first. **Pure.**"""
    decisions: list[str] = []
    if _count(view, "resources", "with_finding", HOUSEKEEPING_FACT_KEY) > 0:
        decisions.append("doc.glance.decision.housekeeping")
    if _count(view, "resources", "with_gap", "backup_not_configured") > 0:
        decisions.append("doc.glance.decision.backup")

    rightsizing = False
    for resource in view.resources:
        for fact in view.facts_for(resource.resource_id):
            if fact.key == "rightsizing_finding" and fact.value.strip().casefold() in RIGHTSIZING_FINDINGS:
                rightsizing = True
            elif (
                resource.resource_type.casefold() == ADVISOR_TYPE
                and fact.key == "category"
                and fact.value.strip().casefold() == "cost"
            ):
                rightsizing = True
    if rightsizing:
        decisions.append("doc.glance.decision.rightsizing")
    elif _count(view, "resources", "with_gap", "optimizer_not_available") > 0:
        decisions.append("doc.glance.decision.optimizer")

    return tuple(decisions[:MAX_DECISIONS]) or ("doc.glance.decision.none",)


def compile_at_a_glance(context: BlockContext, block: BlockSpec, cursor: BlockCursor) -> BlockOutput:
    view = context.view
    messages = context.messages
    table_cursor = cursor.child("nodes", 0)

    headline = (
        ("resources", messages.text("doc.glance.resources"), view.cardinality("resources")),
        (
            "housekeeping",
            messages.text("doc.glance.housekeeping"),
            view.cardinality("resources", "with_finding", HOUSEKEEPING_FACT_KEY),
        ),
        (
            "no_backup",
            messages.text("doc.glance.no_backup"),
            view.cardinality("resources", "with_gap", "backup_not_configured"),
        ),
        ("stopped", messages.text("doc.glance.stopped"), view.cardinality("resources", "with_gap", "deallocated")),
    )

    rows: list[Row] = []
    for ordinal, (key, label, value) in enumerate(headline):
        row_cursor = table_cursor.child("rows", ordinal)
        value_cursor = row_cursor.child("cells", 1)
        if value is None:
            cell = empty_cell(value_cursor)
        else:
            figure = value_cursor.child("figure", 0).figure(value, catalog_scale=context.catalog_scale(value))
            cell = FigureCell(path=value_cursor.path, figure=figure)
        rows.append(Row(path=row_cursor.path, key=key, cells=(text_cell(row_cursor.child("cells", 0), label), cell)))

    table = Table(
        path=table_cursor.path,
        style=context.design.table_style_name,
        columns=(
            Column(key="field", header=messages.text("doc.table.field")),
            Column(key="value", header=messages.text("doc.table.value")),
        ),
        rows=tuple(rows),
        caption=caption_of(block),
    )
    cursor.anchor_table(table_cursor.path)

    nodes: list[Table | Paragraph] = [
        table,
        text_paragraph(cursor.child("nodes", 1), "Heading 2", messages.text("doc.glance.decisions")),
    ]
    for decision in decisions_for(view):
        nodes.append(text_paragraph(cursor.child("nodes", len(nodes)), "Body Text", messages.text(decision)))
    return BlockOutput(nodes=tuple(nodes))
