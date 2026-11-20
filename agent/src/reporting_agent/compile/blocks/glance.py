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

from collections.abc import Callable
from typing import Final

from reporting_agent.compile import activity as _activity
from reporting_agent.compile.ast import (
    Column,
    Figure,
    FigureCell,
    Paragraph,
    Row,
    Table,
    Text,
    TextCell,
    TextFactCell,
)
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
from reporting_agent.compile.snapshot_view import (
    HOUSEKEEPING_FACT_KEY,
    OWNERSHIP_SOURCE_BUCKETS,
    SnapshotValue,
    SnapshotView,
)

__all__ = [
    "FOCUS_OWNERSHIP",
    "GLANCE_ARTIFACT",
    "HEADLINE_KEYS",
    "MAX_DECISIONS",
    "OWNERSHIP_HEADLINE_KEYS",
    "RANKED_LOOK",
    "STACK_LOOK",
    "compile_at_a_glance",
    "decisions_for",
    "glance_summary",
    "ownership_decisions_for",
]

MAX_DECISIONS: Final[int] = 3

HEADLINE_KEYS: Final[tuple[str, ...]] = ("resources", "housekeeping", "no_backup", "stopped")
"""The headline table's row keys, in order."""

FOCUS_OWNERSHIP: Final[str] = "ownership"
"""`config.focus` for the weekly ownership report's first page: who created what, and what idles."""

OWNERSHIP_HEADLINE_KEYS: Final[tuple[str, ...]] = ("owned", "known_creator", "idle", "idle_cost")
"""The ownership page's four tiles, in order — what the email quotes."""

KICKER_LOOK: Final[str] = "kicker"
TITLE_UNDER_KICKER_LOOK: Final[str] = "under-kicker"
TILES_LOOK: Final[str] = "tiles"
STACK_LOOK: Final[str] = "stack"
"""`Table.look` of a one-bar breakdown: the designed PDF draws the bar from the rows' counts
above the rows set as its legend. The Word file keeps the plain two-column table."""
RANKED_LOOK: Final[str] = "ranked"
"""`Table.look` of the "Decide this week" list: numbered rows, the cost set large."""

MAX_RANKED: Final[int] = 5
"""How many idle resources the first page ranks; the full list is the Idle section's."""

USE_SEGMENTS: Final[tuple[tuple[str, str, str], ...]] = (
    ("active", "Active", "doc.glance.ownership.use.active"),
    ("in_use", "In use", "doc.glance.ownership.use.in_use"),
    ("low_use", "Low use", "doc.glance.ownership.low_use"),
    ("stopped", "Stopped", "doc.glance.ownership.stopped"),
    ("idle", "Idle", "doc.glance.ownership.idle"),
)
"""`(row key, activity, label id)` for "Is it still used?". *Not measured* is left out:
nothing measures a VPC or a security group, and a bar mostly of them says nothing."""

OWNED_TYPE_LABELS: Final[dict[str, str]] = {
    "aws::ec2::instance": "doc.ownership.type.instance",
    "aws::rds::dbinstance": "doc.ownership.type.database",
    "aws::ec2::volume": "doc.ownership.type.volume",
    "aws::ec2::eip": "doc.ownership.type.eip",
    "aws::ec2::vpc": "doc.ownership.type.vpc",
    "aws::ec2::securitygroup": "doc.ownership.type.security_group",
}

_SLOT: Final[str] = "\x00"
"""Where a figure goes in an interpolated sentence: the message is resolved with this in each
figure's placeholder, then split on it, so the number is a `Figure` and never text."""

GLANCE_ARTIFACT: Final[str] = "glance.json"
"""What the app quotes in the email that delivers the report: see `glance_summary`."""

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


def ownership_decisions_for(view: SnapshotView) -> tuple[str, ...]:
    """The ownership report's decisions, most important first. **Pure.**"""
    decisions: list[str] = []
    if _count(view, "ownership", "with_activity", "Idle") > 0:
        decisions.append("doc.glance.ownership.decision.idle")
    deleted = any(
        fact.key == "creator_status" and fact.value == "Deleted"
        for resource in view.resources
        for fact in view.facts_for(resource.resource_id)
    )
    if deleted:
        decisions.append("doc.glance.ownership.decision.deleted")
    if _count(view, "ownership", "creator_unknown") > 0:
        decisions.append("doc.glance.ownership.decision.unknown")
    if _count(view, "ownership", "created_in_period") > 0:
        decisions.append("doc.glance.ownership.decision.new")
    return tuple(decisions[:MAX_DECISIONS]) or ("doc.glance.ownership.decision.none",)


def _headline(context: BlockContext, block: BlockSpec) -> tuple[tuple[str, str, object], ...]:
    view = context.view
    messages = context.messages
    return (
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


def compile_at_a_glance(context: BlockContext, block: BlockSpec, cursor: BlockCursor) -> BlockOutput:
    if block.config.get("focus") == FOCUS_OWNERSHIP:
        return compile_ownership_glance(context, block, cursor)
    view = context.view
    messages = context.messages
    table_cursor = cursor.child("nodes", 0)

    headline = _headline(context, block)
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


# --- the weekly ownership report's first page ------------------------------------------


def _is_week(view: SnapshotView) -> bool:
    from datetime import date

    try:
        days = (date.fromisoformat(view.window.end) - date.fromisoformat(view.window.start)).days + 1
    except (TypeError, ValueError):
        return False
    return 1 <= days <= 7


def _figure(context: BlockContext, cursor: BlockCursor, value: SnapshotValue) -> Figure:
    return cursor.figure(value, catalog_scale=context.catalog_scale(value))


def _sentence(
    context: BlockContext,
    cursor: BlockCursor,
    inlines: list[Text | Figure],
    template: str,
    figures: tuple[tuple[str, SnapshotValue], ...] = (),
    **words: str,
) -> None:
    """Append one message to `inlines`: its figure placeholder as a `Figure`, the rest text.

    At most one figure per sentence, so a translation that moves the number moves nothing
    else: the message is resolved with a marker in the placeholder and split on it.
    """
    assert len(figures) <= 1, "one figure per sentence"
    resolved = context.messages.text(template, **{name: _SLOT for name, _ in figures}, **words)
    parts = resolved.split(_SLOT)
    for index, part in enumerate(parts):
        if part:
            inlines.append(Text(path=cursor.child("inlines", len(inlines)).path, text=part))
        if index == 0 and figures:
            inlines.append(_figure(context, cursor.child("inlines", len(inlines)), figures[0][1]))


def _count_of(view: SnapshotView, *tokens: str) -> int:
    value = view.cardinality(*tokens)
    return 0 if value is None else int(value.value)


def _headline_inlines(context: BlockContext, cursor: BlockCursor, when: str) -> list[Text | Figure]:
    """Two sentences, the idle count and then how many of those nobody owns, joined by a
    message of their own so a language that joins sentences differently can say so."""
    view = context.view
    messages = context.messages
    inlines: list[Text | Figure] = []
    idle = view.cardinality("ownership", "with_activity", _activity.ACTIVITY_IDLE)
    unowned = view.cardinality("ownership", "idle_unowned")
    idle_n = _count_of(view, "ownership", "with_activity", _activity.ACTIVITY_IDLE)
    unowned_n = _count_of(view, "ownership", "idle_unowned")
    if idle is None or idle_n == 0:
        _sentence(context, cursor, inlines, "doc.glance.ownership.headline.none", when=when)
        return inlines
    first = messages.text(
        "doc.glance.ownership.headline.one" if idle_n == 1 else "doc.glance.ownership.headline.many",
        idle=_SLOT, when=when,
    )
    figures: list[SnapshotValue] = [idle]
    if unowned is None or unowned_n == 0:
        second = messages.text("doc.glance.ownership.unowned.none")
    elif unowned_n == idle_n:
        second = messages.text(
            "doc.glance.ownership.unowned.it" if idle_n == 1 else "doc.glance.ownership.unowned.all"
        )
    else:
        second = messages.text("doc.glance.ownership.unowned.some", unowned=_SLOT)
        figures.append(unowned)
    parts = messages.text("doc.glance.ownership.joined", first=first, second=second).split(_SLOT)
    for index, part in enumerate(parts):
        if part:
            inlines.append(Text(path=cursor.child("inlines", len(inlines)).path, text=part))
        if index < len(figures):
            inlines.append(_figure(context, cursor.child("inlines", len(inlines)), figures[index]))
    return inlines


def _tiles(context: BlockContext, cursor: BlockCursor, when: str) -> Table:
    view = context.view
    messages = context.messages
    entries = (
        ("owned", messages.text("doc.glance.ownership.tile.owned"), view.cardinality("ownership", "resources")),
        ("known_creator", messages.text("doc.glance.ownership.tile.known"), view.cardinality("ownership", "known_creator")),
        (
            "idle",
            messages.text("doc.glance.ownership.tile.idle", when=when),
            view.cardinality("ownership", "with_activity", _activity.ACTIVITY_IDLE),
        ),
        (
            "idle_cost",
            messages.text("doc.glance.ownership.tile.idle_cost"),
            view.derived_sum("cost", "with_activity", _activity.ACTIVITY_IDLE),
        ),
    )
    rows: list[Row] = []
    for ordinal, (key, label, value) in enumerate(entries):
        row_cursor = cursor.child("rows", ordinal)
        value_cursor = row_cursor.child("cells", 1)
        cell = (
            empty_cell(value_cursor)
            if value is None
            else FigureCell(path=value_cursor.path, figure=_figure(context, value_cursor.child("figure", 0), value))
        )
        rows.append(Row(path=row_cursor.path, key=key, cells=(text_cell(row_cursor.child("cells", 0), label), cell)))
    cursor.anchor_table(cursor.path)
    return Table(
        path=cursor.path,
        style=context.design.table_style_name,
        columns=(
            Column(key="metric", header=messages.text("doc.table.field")),
            Column(key="value", header=messages.text("doc.table.value")),
        ),
        rows=tuple(rows),
        look=TILES_LOOK,
    )


def _stack(
    context: BlockContext,
    cursor: BlockCursor,
    title_id: str,
    segments: tuple[tuple[str, str, SnapshotValue | None], ...],
) -> Table:
    """One breakdown as a table of `(segment, count)`; the designed PDF draws it as one bar."""
    messages = context.messages
    rows: list[Row] = []
    for key, label, value in segments:
        if value is None or value.value <= 0:
            continue
        row_cursor = cursor.child("rows", len(rows))
        count_cursor = row_cursor.child("cells", 1)
        rows.append(Row(
            path=row_cursor.path,
            key=key,
            cells=(
                text_cell(row_cursor.child("cells", 0), label),
                FigureCell(path=count_cursor.path, figure=_figure(context, count_cursor.child("figure", 0), value)),
            ),
        ))
    cursor.anchor_table(cursor.path)
    return Table(
        path=cursor.path,
        style=context.design.table_style_name,
        columns=(
            Column(key="segment", header=messages.text("doc.glance.ownership.segment")),
            Column(key="count", header=messages.text("doc.inventory.resources")),
        ),
        rows=tuple(rows),
        caption=messages.text(title_id),
        look=STACK_LOOK,
    )


def _breakdowns(context: BlockContext, next_cursor: Callable[[], BlockCursor], nodes: list[object]) -> None:
    """The two one-bar breakdowns, as two tables the designed PDF sets side by side.

    Not a `LayoutRow`: a row's columns hold other blocks, and the ledger roots a figure at
    the block that emitted it, so a row inside one block would hide its figures."""
    view = context.view
    messages = context.messages
    use = tuple(
        (key, messages.text(label_id), view.cardinality("ownership", "with_activity", activity))
        for key, activity, label_id in USE_SEGMENTS
    )
    source = tuple(
        (bucket, messages.text(f"doc.glance.ownership.source.{bucket}"), view.cardinality("ownership", "creator_source", bucket))
        for bucket in OWNERSHIP_SOURCE_BUCKETS
    )
    nodes.append(_stack(context, next_cursor(), "doc.glance.ownership.use_title", use))
    nodes.append(_stack(context, next_cursor(), "doc.glance.ownership.source_title", source))


_RANKED_FACTS: Final[tuple[str, ...]] = ("created_by", "creator_type", _activity.COST_FACT_KEY)


def _ranked(context: BlockContext, cursor: BlockCursor) -> Table | None:
    """The idle resources, costliest first, each with who created it — at most five."""
    view = context.view
    messages = context.messages
    candidates = []
    for resource in view.resources:
        facts = {fact.key: fact for fact in view.facts_for(resource.resource_id)}
        activity = facts.get(_activity.ACTIVITY_FACT_KEY)
        if activity is None or activity.value != _activity.ACTIVITY_IDLE:
            continue
        cost = _activity.monthly_cost(facts[_activity.COST_FACT_KEY].value) if _activity.COST_FACT_KEY in facts else None
        candidates.append((-(cost if cost is not None else -1), resource.name or resource.resource_id, resource, facts))
    if not candidates:
        return None
    candidates.sort(key=lambda entry: (entry[0], entry[1], entry[2].resource_id))
    rows: list[Row] = []
    for ordinal, (_, name, resource, facts) in enumerate(candidates[:MAX_RANKED]):
        row_cursor = cursor.child("rows", ordinal)
        cells: list[object] = [
            text_cell(row_cursor.child("cells", 0), name),
            text_cell(
                row_cursor.child("cells", 1),
                messages.text(OWNED_TYPE_LABELS.get(resource.resource_type.casefold(), "doc.ownership.type.instance")),
            ),
        ]
        for key in _RANKED_FACTS:
            cell_cursor = row_cursor.child("cells", len(cells))
            fact = facts.get(key)
            cells.append(
                empty_cell(cell_cursor)
                if fact is None
                else TextFactCell(path=cell_cursor.path, fact=cell_cursor.child("fact", 0).text_fact(fact))
            )
        rows.append(Row(path=row_cursor.path, key=resource.resource_id, cells=tuple(cells)))  # type: ignore[arg-type]
    cursor.anchor_table(cursor.path)
    return Table(
        path=cursor.path,
        style=context.design.table_style_name,
        columns=(
            Column(key="resource", header=messages.text("doc.table.resource")),
            Column(key="what", header=messages.text("doc.glance.ownership.decide.what")),
            Column(key="created_by", header=messages.text("doc.inventory.creator")),
            Column(key="creator_type", header=messages.text("doc.inventory.creator_type")),
            Column(key="est_monthly_usd", header=messages.text("doc.inventory.est_monthly_usd")),
        ),
        rows=tuple(rows),
        look=RANKED_LOOK,
    )


def compile_ownership_glance(context: BlockContext, block: BlockSpec, cursor: BlockCursor) -> BlockOutput:
    """The weekly ownership report's first page, as one page a reader acts on.

    A kicker, a headline sentence whose numbers are figures, a lead naming where the
    resources are, four tiles, two one-bar breakdowns (is it used; how its creator is
    known), the costliest idle resources with who created each, the decisions, and the
    rules. Every number is a derived count, total or collected fact of this snapshot.
    """
    view = context.view
    messages = context.messages
    when = messages.text("doc.glance.ownership.when.week" if _is_week(view) else "doc.glance.ownership.when.period")
    nodes: list[object] = []

    def at() -> BlockCursor:
        return cursor.child("nodes", len(nodes))

    kicker = text_paragraph(at(), "Body Text", messages.text("doc.glance.ownership.kicker"))
    nodes.append(Paragraph(path=kicker.path, style=kicker.style, inlines=kicker.inlines, look=KICKER_LOOK))
    headline_cursor = at()
    nodes.append(Paragraph(
        path=headline_cursor.path, style="Body Text", inlines=tuple(_headline_inlines(context, headline_cursor, when)),
        look="headline",
    ))
    regions = sorted({
        resource.location for resource in view.resources
        if resource.location and resource.resource_type.casefold() in OWNED_TYPE_LABELS
    })
    if regions:
        lead = text_paragraph(at(), "Body Text", messages.text(
            "doc.glance.ownership.lead", regions=", ".join(regions), when=when
        ))
        nodes.append(Paragraph(path=lead.path, style=lead.style, inlines=lead.inlines, look="lead"))
    nodes.append(_tiles(context, at(), when))
    _breakdowns(context, at, nodes)
    nodes.append(text_paragraph(at(), "Heading 2", messages.text(
        "doc.glance.ownership.decide.week" if _is_week(view) else "doc.glance.ownership.decide.period"
    )))
    ranked = _ranked(context, at())
    if ranked is not None:
        nodes.append(ranked)
    for decision in ownership_decisions_for(view):
        nodes.append(text_paragraph(at(), "Body Text", messages.text(decision)))
    # The rules, once, on the page that states their results. Template text: the same
    # sentences in every render, so the verifier admits their numerals as chrome.
    nodes.append(text_paragraph(at(), "Heading 3", messages.text("doc.glance.ownership.rules_title")))
    rules = text_paragraph(at(), "Body Text", messages.text("doc.glance.ownership.rules"))
    nodes.append(Paragraph(path=rules.path, style=rules.style, inlines=rules.inlines, look="note"))
    return BlockOutput(nodes=tuple(nodes))  # type: ignore[arg-type]


def glance_summary(blocks: object) -> dict[str, object] | None:
    """At a glance as the document printed it, for the email that delivers the report.

    Read back from the compiled nodes rather than recomputed, so each value is the
    verified figure's own `formatted` string and each decision the sentence on the page.
    `blocks` is the compile's `nodes_by_block`. `None` when the report has no At a glance
    section: the email then quotes nothing it would not also find in the document.
    """
    if not hasattr(blocks, "values"):
        return None
    for nodes in blocks.values():  # type: ignore[attr-defined]
        nodes = tuple(nodes)
        ownership = _ownership_summary(nodes)
        if ownership is not None:
            return ownership
        if not nodes or not isinstance(nodes[0], Table):
            continue
        table = nodes[0]
        keys = tuple(row.key for row in table.rows)
        if keys != HEADLINE_KEYS:
            continue
        figures = []
        for row in table.rows:
            label, value = row.cells[0], row.cells[1]
            figures.append(
                {
                    "key": row.key,
                    "label": label.text if isinstance(label, TextCell) else "",
                    "value": value.figure.formatted if isinstance(value, FigureCell) else "\u2014",
                }
            )
        decisions = []
        for node in nodes[2:]:
            if not isinstance(node, Paragraph):
                continue
            decisions.append("".join(inline.text for inline in node.inlines if isinstance(inline, Text)))
        title = nodes[1]
        return {
            "schema_version": 1,
            "focus": "estate",
            "decisions_title": "".join(i.text for i in title.inlines if isinstance(i, Text))
            if isinstance(title, Paragraph)
            else "",
            "figures": figures,
            "decisions": [d for d in decisions if d],
        }
    return None


def _plain(paragraph: Paragraph) -> str:
    return "".join(
        inline.text if isinstance(inline, Text) else inline.formatted if isinstance(inline, Figure) else ""
        for inline in paragraph.inlines
    )


def _ownership_summary(nodes: tuple[object, ...]) -> dict[str, object] | None:
    """The ownership page as the email quotes it: its headline, tiles and decisions."""
    tiles = next(
        (
            node for node in nodes
            if isinstance(node, Table) and tuple(row.key for row in node.rows) == OWNERSHIP_HEADLINE_KEYS
        ),
        None,
    )
    if tiles is None:
        return None
    figures = [
        {
            "key": row.key,
            "label": row.cells[0].text if isinstance(row.cells[0], TextCell) else "",
            "value": row.cells[1].figure.formatted if isinstance(row.cells[1], FigureCell) else "\u2014",
        }
        for row in tiles.rows
    ]
    headline = next((_plain(n) for n in nodes if isinstance(n, Paragraph) and n.look == "headline"), "")
    title = ""
    decisions: list[str] = []
    for node in nodes:
        if not isinstance(node, Paragraph):
            continue
        if node.style == "Heading 2":
            title = _plain(node)
            continue
        if node.style == "Heading 3":
            break
        if title and node.style == "Body Text" and not node.look:
            decisions.append(_plain(node))
    return {
        "schema_version": 1,
        "focus": FOCUS_OWNERSHIP,
        "headline": headline,
        "decisions_title": title,
        "figures": figures,
        "decisions": [d for d in decisions if d],
    }
