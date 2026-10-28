"""The v4 `backup_tracker` block: which days each resource has a backup on.

Two shapes, because the two clouds answer different questions:

* **AWS, a daily strip.** AWS Backup lists every recovery point a protected resource has, so
  the collector folds them into one `recovery_point_days` text fact per resource
  (`2026-09 1-14,~15,16-30`). The strip reads that fact back into one glyph per local day of
  the period: `●` a complete recovery point, `◐` only a partial one, `○` none. AWS records
  no recovery point for a failed job, so there is no "failed" glyph.
* **Azure, a status table.** Recovery Services reports the last job's status and the last
  restore point, not a history, so the block is the same resource table the backup section
  already draws, of those facts.

## No number is printed that is not the snapshot's

The glyphs carry no digit, and the raw fact sits in the last column as a `TextFactCell`, so
every day the strip marks is traceable to the collected value it was read from. The day
column's header names the strip's first and last day as ISO dates, which the masking pass
reads as temporal values rather than measurements; a header of day numbers would have
admitted `1` to `31` to the derived allowlist and hidden an invented small number anywhere
in the report's prose.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import date, timedelta
from typing import Final

from reporting_agent.compile.ast import Column, Row, Table, TextCell, TextFactCell
from reporting_agent.compile.blocks.base import (
    MAX_TABLE_ROWS,
    BlockContext,
    BlockOutput,
    BlockSpec,
    caption_of,
    empty_cell,
    empty_scope_table,
    omitted_row,
    text_cell,
)
from reporting_agent.compile.figures import BlockCursor

__all__ = [
    "BACKUP_STRIP_LOOK",
    "BACKUP_TRACKER_BLOCK",
    "MAX_STRIP_DAYS",
    "STRIP_GLYPHS",
    "compile_backup_tracker",
    "recovery_days",
]

BACKUP_TRACKER_BLOCK: Final[str] = "backup_tracker"
"""The block a v4 `backup_tracker` entry expands to. Not a declared type: only the section
expander produces it."""

BACKUP_STRIP_LOOK: Final[str] = "strip"
"""`Table.look` of the AWS strip; the renderers colour its glyphs."""

MODE_STRIP: Final[str] = "strip"
MODE_STATUS: Final[str] = "status"

MAX_STRIP_DAYS: Final[int] = 31
"""The newest days of the period a strip draws. A longer period keeps its last month."""

STRIP_GLYPHS: Final[Mapping[str, str]] = {"full": "●", "partial": "◐", "none": "○"}
"""One glyph per day, by status. The renderers read a glyph back to its status to colour it."""

RECOVERY_POINT_FACT: Final[str] = "recovery_point_days"
STATUS_FACTS: Final[tuple[str, ...]] = ("last_backup_status", "last_restore_point")

_MONTH: Final[re.Pattern[str]] = re.compile(r"^(\d{4})-(\d{2}) (.+)$")


def recovery_days(text: str) -> dict[date, bool]:
    """The days a `recovery_point_days` fact names, each `True` when a complete recovery
    point exists that day and `False` when only a partial one does. **Pure.**

    The inverse of `aws/facts.py::recovery_point_days`. A part it cannot read is skipped
    rather than guessed at, so a malformed fact marks fewer days, never more.
    """
    days: dict[date, bool] = {}
    for group in text.split(";"):
        match = _MONTH.match(group.strip())
        if match is None:
            continue
        year, month = int(match.group(1)), int(match.group(2))
        for part in match.group(3).split(","):
            part = part.strip()
            complete = not part.startswith("~")
            first, _, last = part.lstrip("~").partition("-")
            try:
                start, end = int(first), int(last or first)
                for number in range(start, end + 1):
                    days[date(year, month, number)] = complete
            except ValueError:
                continue
    return days


def _strip_days(context: BlockContext) -> tuple[date, ...]:
    end = date.fromisoformat(context.view.window.end)
    start = max(date.fromisoformat(context.view.window.start), end - timedelta(days=MAX_STRIP_DAYS - 1))
    return tuple(start + timedelta(days=offset) for offset in range((end - start).days + 1))


def _glyphs(days: tuple[date, ...], marked: Mapping[date, bool]) -> str:
    """One glyph per day, a space after each seven so a narrow column wraps on a week."""
    glyphs = [
        STRIP_GLYPHS["none" if day not in marked else "full" if marked[day] else "partial"]
        for day in days
    ]
    return " ".join("".join(glyphs[i : i + 7]) for i in range(0, len(glyphs), 7))


def compile_backup_tracker(context: BlockContext, block: BlockSpec, cursor: BlockCursor) -> BlockOutput:
    """The strip on AWS, the status table on Azure — see the module docstring."""
    if block.config.get("mode") == MODE_STATUS:
        from reporting_agent.compile.blocks.tables import _resource_rows_table

        return _resource_rows_table(context, block, cursor, (), fact_keys=STATUS_FACTS)

    table_cursor = cursor.child("nodes", 0)
    style = context.design.table_style_name
    caption = caption_of(block)
    messages = context.messages
    matched = context.resources_for(block)
    if not matched:
        return BlockOutput(nodes=(empty_scope_table(table_cursor, style, caption, messages=messages),))

    days = _strip_days(context)
    shown = matched[:MAX_TABLE_ROWS]
    rows: list[Row] = []
    for ordinal, resource in enumerate(shown):
        row_cursor = table_cursor.child("rows", ordinal)
        fact = next((f for f in context.view.facts_for(resource.resource_id) if f.key == RECOVERY_POINT_FACT), None)
        cells: list[TextCell | TextFactCell | object] = [text_cell(row_cursor.child("cells", 0), resource.name)]
        if fact is None:
            # Not protected, or AWS Backup was not reached: the gap says which. Blank, never `○`.
            cells.append(empty_cell(row_cursor.child("cells", 1)))
            cells.append(empty_cell(row_cursor.child("cells", 2)))
        else:
            cells.append(text_cell(row_cursor.child("cells", 1), _glyphs(days, recovery_days(fact.value))))
            fact_cursor = row_cursor.child("cells", 2)
            cells.append(TextFactCell(path=fact_cursor.path, fact=fact_cursor.child("fact", 0).text_fact(fact)))
        rows.append(Row(path=row_cursor.path, key=resource.resource_id, cells=tuple(cells)))  # type: ignore[arg-type]

    truncation = omitted_row(
        table_cursor.child("rows", len(rows)), context.view, len(shown), len(matched), messages=messages,
    )
    if truncation is not None:
        rows.append(truncation)

    table = Table(
        path=table_cursor.path,
        style=style,
        columns=(
            Column(key="resource", header=messages.text("doc.table.resource")),
            Column(
                key="days",
                header=messages.text("doc.backup.days", start=days[0].isoformat(), end=days[-1].isoformat()),
            ),
            Column(key=RECOVERY_POINT_FACT, header=messages.text("doc.backup.recovery_points")),
        ),
        rows=tuple(rows),
        caption=caption,
        note=messages.text("doc.backup.legend"),
        look=BACKUP_STRIP_LOOK,
    )
    cursor.anchor_table(table_cursor.path)
    return BlockOutput(nodes=(table,))
