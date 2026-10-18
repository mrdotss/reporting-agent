"""A callout: the author's words, printed only when a fixed condition holds in the snapshot.

A v4 section's `callout` block compiles here, through `rich_text`'s compiler, because its
output is a paragraph and its config carries the condition beside the words. Five
conditions, each a fixed rule, none a model's judgement:

* ``peak_at_or_above`` — some resource the section selects reaches the author's
  ``threshold`` on the section's ranking metric. ``{resource}`` names the highest and
  ``{value}`` is its value, a figure.
* ``without_backup``, ``housekeeping``, ``stopped``, ``coverage_gaps`` — a snapshot
  cardinality is above zero. ``{count}`` is that cardinality, a figure.

The threshold is a setting and never printed. Every number a callout prints is a figure
minted from the snapshot, so the verifier proves it like any other; the author's words carry
no numeral, which both validators refuse.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Final

from reporting_agent.compile.ast import Inline, Paragraph, Text
from reporting_agent.compile.blocks.base import BlockContext, BlockOutput, BlockSpec
from reporting_agent.compile.figures import BlockCursor
from reporting_agent.compile.snapshot_view import HOUSEKEEPING_FACT_KEY, SnapshotValue

__all__ = ["CALLOUT_ATTENTION_STYLE", "CALLOUT_CONDITION_KEY", "CALLOUT_STYLE", "compile_callout"]

CALLOUT_CONDITION_KEY: Final[str] = "callout"
"""The config key a `rich_text` block carries when it is a callout."""

CALLOUT_STYLE: Final[str] = "Callout"
"""The `info` tone: set apart from body text, in the theme's accent."""

CALLOUT_ATTENTION_STYLE: Final[str] = "Callout Attention"
"""The `attention` tone: the same block, marked for a reader to act on."""

_COUNTED: Final[Mapping[str, tuple[str, ...]]] = {
    "without_backup": ("resources", "with_gap", "backup_not_configured"),
    "housekeeping": ("resources", "with_finding", HOUSEKEEPING_FACT_KEY),
    "stopped": ("resources", "with_gap", "deallocated"),
    "coverage_gaps": ("gaps",),
}

_TOKEN: Final[re.Pattern[str]] = re.compile(r"\{(count|value|resource)\}")


def compile_callout(context: BlockContext, block: BlockSpec, cursor: BlockCursor) -> BlockOutput:
    condition = block.config.get(CALLOUT_CONDITION_KEY)
    text = block.config.get("text")
    if not isinstance(condition, Mapping) or not isinstance(text, str) or not text:
        raise block.fail("a callout needs config.callout and config.text")
    when = condition.get("when")

    fills: dict[str, SnapshotValue | str] = {}
    if when == "peak_at_or_above":
        metric = condition.get("metric")
        statistic = condition.get("statistic")
        threshold = condition.get("threshold")
        if not isinstance(metric, str) or not isinstance(statistic, str) or not isinstance(threshold, int):
            raise block.fail("a peak callout needs config.callout.metric, statistic and threshold")
        candidates = [
            (value.value, resource.resource_id, resource, value)
            for resource in context.resources_for(block)
            for value in [context.view.stat(resource.resource_id, metric, statistic)]
            if value is not None
        ]
        if not candidates:
            return BlockOutput()
        candidates.sort(key=lambda entry: (-entry[0], entry[1]))
        top_value, _, top_resource, top = candidates[0]
        # The threshold is in the metric's own unit, as the section displays it.
        if top_value < Decimal(threshold):
            return BlockOutput()
        fills = {"value": top, "resource": top_resource.name}
    elif when in _COUNTED:
        counted = context.view.cardinality(*_COUNTED[str(when)])
        if counted is None or counted.value <= 0:
            return BlockOutput()
        fills = {"count": counted}
    else:
        raise block.fail(f"unknown callout condition {when!r}")

    paragraph_cursor = cursor.child("nodes", 0)
    inlines: list[Inline] = []
    position = 0
    for match in _TOKEN.finditer(text):
        if match.start() > position:
            inlines.append(Text(path=paragraph_cursor.child("inlines", len(inlines)).path, text=text[position:match.start()]))
        fill = fills.get(match.group(1))
        inline_cursor = paragraph_cursor.child("inlines", len(inlines))
        if isinstance(fill, SnapshotValue):
            inlines.append(inline_cursor.figure(fill, catalog_scale=context.catalog_scale(fill)))
        elif isinstance(fill, str):
            inlines.append(Text(path=inline_cursor.path, text=fill))
        else:
            # Both validators refuse a token the condition cannot fill; reaching here is a
            # contract break, and printing the braces would be a document with a hole.
            raise block.fail(f"{{{match.group(1)}}} cannot be filled for condition {when!r}")
        position = match.end()
    if position < len(text):
        inlines.append(Text(path=paragraph_cursor.child("inlines", len(inlines)).path, text=text[position:]))

    style = CALLOUT_ATTENTION_STYLE if condition.get("tone") == "attention" else CALLOUT_STYLE
    return BlockOutput(nodes=(Paragraph(path=paragraph_cursor.path, style=style, inlines=tuple(inlines)),))
