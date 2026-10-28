"""The two chart block types: `timeseries_chart` and `distribution_chart`.

Every plotted value is a **figure**, so an in-app chart and a chart embedded in the `.docx`
are two views of the same verified numbers rather than two computations (Req 16.14).

## The compiler decides the encoding; no consumer infers it

`encoding` is `categorical` where the series are **peers** and `sequential` where the chart
encodes **one ordered quantity**. That decision is made here, in the AST, because a client
inferring it from the series count would get it wrong in both directions — and a lightness
ramp over peers asserts an order the data does not contain, which is the quiet dishonesty
this product exists to remove. There is no sense in which "memory" is a higher value of
"CPU".

## Why a distribution chart is not a histogram

A binned histogram plots **counts per bucket**, and a bucket count is arithmetic over the
snapshot with no address of its own — it could not be a `Figure`, so it could not appear in
the document at all. (The snapshot's own cardinalities are counts of *its* collections, not
of buckets a compiler chose.)

So `distribution_chart` plots each resource's value, sorted ascending, one bar per resource.
A reader gets the shape of the distribution — where the mass sits, how long the tail is —
from a sorted series, and every bar traces to one resource's one measurement. Sorted values
along an ordered axis are genuinely **one ordered quantity**, so the encoding is
`sequential`, which is also the palette `design-system.md` reserves for exactly that.

## Series are capped, and the cap is a compile-time decision

At most :data:`MAX_CHART_SERIES` series, because past five a categorical palette has to start
modulating lightness and has then reinvented the ramp. Capping here rather than in the
renderer means the document and the app agree on which series exist, since both read this
tree.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal

from reporting_agent.compile.ast import (
    ChartMarker,
    PRIOR_RUNS_POINTER_PREFIX,
    Chart,
    ChartPoint,
    Series,
    compiling_against,
    panel_groups,
)
from reporting_agent.compile.blocks.base import (
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    BlockContext,
    BlockOutput,
    BlockSpec,
    MetricRef,
    caption_of,
    empty_scope_table,
    no_data_table,
    read_metric_refs,
    resolve_stat,
)
from reporting_agent.compile.definition import (
    HISTORICAL_LOOKBACK_MAX,  # the bound a section's `lookback` is validated against
    HISTORICAL_LOOKBACK_MIN,
)
from reporting_agent.compile.figures import BlockCursor
from reporting_agent.compile.historical import Selection
from reporting_agent.compile.messages import Messages
from reporting_agent.compile.snapshot_view import ResourceView, SnapshotValue, SnapshotView
from reporting_agent.errors import CompileFailedError

__all__ = [
    "ANNOTATED_LAYOUT",
    "ANNOTATED_LINES",
    "FLEET_MIX_BLOCK",
    "MAX_MULTIPLES",
    "MULTIPLES_LAYOUT",
    "WEEK_HEATMAP_BLOCK",
    "incident_day",
    "compile_distribution_chart",
    "compile_fleet_mix",
    "compile_historical_trend",
    "compile_timeseries_chart",
    "compile_week_heatmap",
]

ENCODING_CATEGORICAL = "categorical"
ENCODING_SEQUENTIAL = "sequential"

# --- Historical trend ---

PRIOR_RUN_NAMESPACE: str = "prior_runs"
"""The namespace prefix for prior-run pointers in the historical trend block."""

HEATMAP_LAYOUT: str = "heatmap"
"""`config.layout` for a v4 heatmap: the time-series compile, drawn as one row per resource
and one cell per day instead of one line per resource."""

MAX_HEATMAP_ROWS: int = 12
"""The resources a heatmap draws, ranked by the section's scope."""

MULTIPLES_LAYOUT: str = "multiples"
"""`config.layout` for a v4 `small_multiples` block: the time-series compile, drawn as one
small panel per resource on one shared scale."""

MAX_MULTIPLES: int = 24
"""The panels small multiples draw, ranked by the section's scope."""

ANNOTATED_LAYOUT: str = "annotated"
"""`config.layout` for a v4 `annotated_line` block: the time-series compile, with the design's
threshold and the run's incidents marked on their days."""

ANNOTATED_LINES: int = 3
"""The resources an annotated line draws: the busiest few, so a marked day reads clearly."""

ANNOTATED_DEFAULT_THRESHOLD: str = "80"
"""The line an annotated chart draws where the design sets no threshold of its own."""

_MONTHS: dict[str, int] = {
    name: number
    for number, names in enumerate(
        (("jan",), ("feb", "peb"), ("mar",), ("apr",), ("may", "mei"), ("jun",), ("jul",),
         ("aug", "agu", "agt"), ("sep",), ("oct", "okt"), ("nov", "nop"), ("dec", "des")),
        start=1,
    )
    for name in names
}


def incident_day(text: str) -> str | None:
    """The day an incident's typed date names, as `YYYY-MM-DD`, or `None` where it cannot be
    read with certainty. **Pure.**

    The date is free text on the run form, so only unambiguous shapes are read: ISO
    (`2026-09-14`, `2026/09/14`), day-first with numbers (`14/09/2026`, `14-09-2026`, the
    form a consultant in Indonesia types) and a named month either way round (`14 Sep 2026`,
    `Sep 14, 2026`, `14 Agustus 2026`). Anything else marks nothing rather than a guess.
    """
    import re
    from datetime import date

    value = text.strip().casefold()
    shapes = (
        (r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b", ("y", "m", "d")),
        (r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b", ("d", "m", "y")),
        (r"^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})\b", ("d", "M", "y")),
        (r"^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b", ("M", "d", "y")),
    )
    for pattern, order in shapes:
        found = re.match(pattern, value)
        if found is None:
            continue
        parts = dict(zip(order, found.groups(), strict=True))
        month = _MONTHS.get(parts["M"][:3]) if "M" in parts else int(parts["m"])
        if month is None:
            return None
        try:
            return date(int(parts["y"]), month, int(parts["d"])).isoformat()
        except ValueError:
            return None
    return None


def _markers(config: Mapping[str, object], days: set[str]) -> tuple[ChartMarker, ...]:
    """The incidents an annotated line marks: each row whose date reads as a plotted day,
    named by its case, else its description. Rows are `[case, date, solution, description]`,
    the incident report's columns."""
    rows = config.get("markers")
    if not isinstance(rows, Sequence) or isinstance(rows, str):
        return ()
    marked: list[ChartMarker] = []
    for row in rows:
        if not isinstance(row, Sequence) or isinstance(row, str) or len(row) < 2:
            continue
        day = incident_day(str(row[1]))
        name = next((str(cell).strip() for cell in (row[0], row[-1]) if str(cell).strip()), "")
        if day is not None and day in days and name:
            marked.append(ChartMarker(x=day, label=name[:40]))
    return tuple(sorted(marked, key=lambda marker: marker.x))



@dataclass(frozen=True, slots=True)
class HistoricalResolver:
    """The compiling snapshot's values, plus prior runs' values at ``/prior_runs/<id>/...``.

    Satisfies the ``SnapshotResolver`` protocol. Installed for the duration of a
    ``historical_trend`` block through ``compiling_against``, so the rest of the document
    is unaffected — the same shape ``DeltaResolver`` takes in ``comparison.py``.
    """

    base: SnapshotView
    prior_views: Mapping[str, SnapshotView]

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        prefix = f"{PRIOR_RUNS_POINTER_PREFIX}/"
        if raw_pointer.startswith(prefix):
            rest = raw_pointer[len(prefix):]
            run_id, _, inner_pointer = rest.partition("/")
            view = self.prior_views.get(run_id)
            if view is None:
                return ()
            return view.resolve_all(f"/{inner_pointer}" if inner_pointer else "")
        return self.base.resolve_all(raw_pointer)

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        prefix = f"{PRIOR_RUNS_POINTER_PREFIX}/"
        if raw_pointer.startswith(prefix):
            rest = raw_pointer[len(prefix):]
            run_id, _, inner_pointer = rest.partition("/")
            view = self.prior_views.get(run_id)
            if view is None:
                return ()
            return view.resolve_text_all(f"/{inner_pointer}" if inner_pointer else "")
        return self.base.resolve_text_all(raw_pointer)


def compile_historical_trend(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """A trend chart over prior verified runs for one metric+statistic pair (Req 18.1–18.3).

    One plotted point per selected prior period, ordered by period start ascending. No Azure
    request — every value from a stored snapshot. No interpolation, no carry-forward, no
    plotted point for a period no selected run covers.

    The block is EMITTED when short or empty (Req 19.1, 19.5): a block that vanishes is
    indistinguishable from one never configured. A short trend produces NO error code and
    NO collection_log gap (Req 19.6).
    """
    from dataclasses import replace as dc_replace

    from reporting_agent.compile.blocks.base import text_paragraph

    chart_cursor = cursor.child("nodes", 0)
    caption = caption_of(block)

    # Read config
    config = block.config
    metric = config.get("metric")
    statistic = config.get("statistic")
    lookback_raw = config.get("lookback")

    if not isinstance(metric, str) or not metric:
        raise block.fail("config.metric must be a non-empty string")
    if not isinstance(statistic, str) or not statistic:
        raise block.fail("config.statistic must be a non-empty string")
    if not isinstance(lookback_raw, int) or not (HISTORICAL_LOOKBACK_MIN <= lookback_raw <= HISTORICAL_LOOKBACK_MAX):
        raise block.fail(
            f"config.lookback must be an integer from {HISTORICAL_LOOKBACK_MIN} to "
            f"{HISTORICAL_LOOKBACK_MAX} inclusive"
        )
    lookback: int = lookback_raw

    # Which prior runs to plot is decided upstream, where the payload's candidate list and
    # the prior snapshots are reachable, and handed down as data — this stage holds no
    # client and no network. Keyed by this block's own config, so a second
    # `historical_trend` block on a different metric gets its own selection rather than
    # inheriting this one's.
    #
    # A missing selection means no caller supplied one. The block then plots nothing and
    # says so below; it never vanishes.
    selections = context.historical_selections or {}
    selection: Selection = selections.get(
        (metric, statistic, lookback)
    ) or Selection(selected=(), exclusions=())

    # Calendar months match the profile's requested monthly lookback. Prior report
    # windows are a fallback when this snapshot contains no measured monthly series.
    resource_id = block.config.get("_resource_id")
    requested_months = set(context.view.month_names[-lookback:])
    monthly_values = [(month, value) for month, value in _seeded_months(context.view, metric, statistic, resource_id=resource_id) if month in requested_months]
    selected = () if monthly_values else selection.selected

    # Build prior snapshot views for the HistoricalResolver
    prior_views: dict[str, SnapshotView] = {}
    if context.historical is not None:
        for candidate in selected:
            view = context.historical.snapshot_view_for(candidate.run_id)
            if view is not None:
                prior_views[candidate.run_id] = view

    resolver = HistoricalResolver(base=context.view, prior_views=prior_views)

    # Build chart points under the HistoricalResolver
    with compiling_against(resolver):
        series_cursor = chart_cursor.child("series", 0)
        points: list[ChartPoint] = []

        for candidate in selected:
            run_id = candidate.run_id
            snapshot_sha256 = candidate.snapshot_sha256 or ""
            period_label = f"{candidate.period_start} – {candidate.period_end}"

            prior_view = prior_views.get(run_id)
            if prior_view is None:
                continue

            # Find the value in the prior run's snapshot
            value = _find_historical_value(prior_view, metric, statistic, resource_id=resource_id)
            if value is None:
                continue

            # Build a SnapshotValue with the prefixed pointer so Figure.__post_init__
            # can re-resolve it through the HistoricalResolver.
            prefixed_pointer = f"{PRIOR_RUNS_POINTER_PREFIX}/{run_id}{value.pointer}"
            prefixed_value = dc_replace(value, pointer=prefixed_pointer)

            point_cursor = series_cursor.child("points", len(points))
            figure = point_cursor.child("y", 0).figure(
                prefixed_value,
                catalog_scale=context.catalog_scale(value),
                source_run_id=run_id,
                source_snapshot_sha256=snapshot_sha256,
            )
            points.append(ChartPoint(path=point_cursor.path, x=period_label, y=figure))

    # --- the seed, when there is no prior-run history to plot ------------------------
    #
    # `select` plots one point per prior verified run, which is right and empty on a first
    # report: a customer's first month has no earlier run to compare against, so the trend
    # they most want is the one the product could not draw. `collect/pipeline.py` seeds
    # calendar months into **this** run's own snapshot for exactly that case.
    #
    # Use one source consistently: measured calendar months first, verified report
    # periods otherwise. Never combine overlapping windows or invent missing values.
    seeded = False
    if not points:
        with compiling_against(context.view):
            series_cursor = chart_cursor.child("series", 0)
            for local_month, value in monthly_values:
                point_cursor = series_cursor.child("points", len(points))
                figure = point_cursor.child("y", 0).figure(
                    value, catalog_scale=context.catalog_scale(value)
                )
                points.append(
                    ChartPoint(path=point_cursor.path, x=local_month, y=figure)
                )
        seeded = bool(points)

    count_plotted = len(points)
    count_requested = lookback

    # Build the statements
    messages = context.messages
    exclusion_summary = _exclusion_summary(selection, messages)
    nodes: list[object] = []

    if count_plotted == 0:
        # Req 19.5 — zero prior runs and nothing seeded: one statement, block still emitted
        statement = messages.text("doc.historical.no_prior_runs")
        nodes.append(text_paragraph(cursor.child("nodes", 0), "Body Text", statement))
    else:
        # Build the chart
        historical_series = (
            Series(
                path=series_cursor.path,
                key=f"{metric}|{statistic}|historical",
                label=f"{metric} ({statistic})",
                points=tuple(points),
            ),
        )
        chart = Chart(
            path=chart_cursor.path,
            chart_type="line",
            title=caption
            or context.messages.text(
                "doc.chart.title.historical", metric=metric, statistic=statistic
            ),
            unit=points[0].y.unit if points else "",
            encoding=ENCODING_SEQUENTIAL,
            series=historical_series,
            caption=caption,
            panels=panel_groups(historical_series),
        )
        resource = next((r for r in context.view.resources if r.resource_id == resource_id), None)
        if resource is not None:
            chart = dc_replace(chart, title=context.messages.text("doc.chart.title.for_resource", resource=resource.name, title=chart.title))
        cursor.anchor_chart(chart_cursor.path)
        nodes.append(chart)

    # Req 19.2, 19.10 — the statement naming counts and exclusion reasons.
    # Register derived counts in the ledger so their formatted values are masked by
    # masking stage 1 (alongside figure formatted values). The verifier re-derives them
    # independently from the ledger/definition.
    statement_cursor = cursor.child("nodes", len(nodes))
    count_cursor = statement_cursor.child("derived_counts", 0)
    count_cursor.derived_count("historical_points_emitted", count_plotted)
    lookback_cursor = statement_cursor.child("derived_counts", 1)
    lookback_cursor.derived_count("historical_lookback", count_requested)

    trend_statement = messages.text(
        "doc.historical.monthly_statement" if seeded else "doc.historical.trend_statement",
        count=str(count_plotted),
        requested=str(count_requested),
        **({} if seeded else {"exclusions": exclusion_summary}),
    )
    nodes.append(text_paragraph(statement_cursor, "Body Text", trend_statement))

    # Req 19.7 — the verification-note statement
    verification_note = messages.text("doc.historical.monthly_verification_note" if seeded else "doc.historical.verification_note")
    nodes.append(text_paragraph(cursor.child("nodes", len(nodes)), "Body Text", verification_note))

    # Req 19.10 — assert emitted counts match (these are trivially true by construction
    # but the requirement demands an explicit check)
    if count_plotted != len(points):
        raise CompileFailedError(
            f"historical_trend block {block.id!r}: emitted plotted count {count_plotted} "
            f"differs from the number of points emitted ({len(points)})"
        )

    return BlockOutput(nodes=tuple(nodes))  # type: ignore[arg-type]


def _find_historical_value(
    view: SnapshotView, metric: str, statistic: str, *, resource_id: str | None = None
) -> SnapshotValue | None:
    """Find this resource's matching statistic in a verified prior snapshot.

    Legacy unscoped blocks retain their first-matching-resource behavior. Expanded
    profile sections always supply a resource id, so months cannot switch machines.
    """
    for resource in view.resources:
        if resource_id is not None and resource.resource_id != resource_id:
            continue
        value = view.stat(resource.resource_id, metric, statistic)
        if value is not None:
            return value
    return None


def _seeded_months(
    view: SnapshotView, metric: str, statistic: str, *, resource_id: str | None = None
) -> list[tuple[str, SnapshotValue]]:
    """This run's own calendar months for one metric+statistic, oldest first.

    The counterpart of :func:`_find_historical_value` on the seeded side, and it takes the
    first resource that answers for the same reason: the block plots one point per period,
    so it needs one value per month rather than one per resource.

    **Every plotted month comes from the same resource.** Taking the first answering
    resource per month independently would draw a line whose points belonged to different
    machines — a "trend" assembled from three unrelated series, which is worse than no
    trend at all. So a resource is chosen once, by being the first that answers for any
    month, and only that resource's months are plotted.
    """
    for resource in view.resources:
        if resource_id is not None and resource.resource_id != resource_id:
            continue
        series = view.month_series(resource.resource_id, metric, statistic)
        if series:
            return list(series)
    return []


def _exclusion_summary(selection: Selection, messages: Messages) -> str:
    """The distinct typed reasons prior periods were excluded, in the document's language.

    Criterion 19.2 asks the statement to name "the count of periods plotted, the count of
    periods requested and **the typed exclusion reasons**". The first two are the two
    `derived_count`s minted beside this; the third is these reasons, and it is not a count.

    ## This used to emit `period_overlapping: 10; status_not_completed: 12`

    Which is a **quantity the compiler computed**, written into a text node. The verifier
    extracts every numeric token from the rendered document and requires each to match
    either a ledger `formatted` value or the derived static-text allowlist, and a
    per-reason tally is neither: it is arithmetic over a selection that appears nowhere in
    the snapshot. Run `34ed5dce` was withheld for the tokens `10;` and `12` in exactly this
    sentence — a correct report, refused for a number nothing could vouch for.

    `omitted_row` in `compile/blocks/base.py` documents the same rule and made the same
    choice for the same reason: say plainly what happened, and carry no numeral that is not
    a figure.

    **It stayed unreachable until the trend started working.** `selection.exclusions` is
    empty when no candidate was ever fetched, and until `_historical_selection_keys` learned
    to read a v3 definition's `sections`, no candidate ever was — so this returned `""` on
    every run and the defect had no way to show itself.

    The reasons resolve through the Message_Catalog rather than printing their identifiers,
    the way `doc.gap.<type>` does for a collection gap. `tests/test_messages.py` asserts
    every declared reason has an entry, so a seventh reason cannot render as a
    missing-message error.
    """
    if not selection.exclusions:
        return ""
    seen: list[str] = []
    for exclusion in selection.exclusions:
        if exclusion.reason not in seen:
            seen.append(exclusion.reason)
    return ", ".join(
        messages.text(f"doc.historical.exclusion.{reason}") for reason in sorted(seen)
    )


def _point(
    cursor: BlockCursor, context: BlockContext, label: str, value: SnapshotValue
) -> ChartPoint:
    figure = cursor.child("y", 0).figure(
        value, catalog_scale=context.catalog_scale(value)
    )
    return ChartPoint(path=cursor.path, x=label, y=figure)


def compile_timeseries_chart(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One series per `(resource, metric)` pair, plotted over local days.

    Days come from the snapshot's own day buckets, which the collector built in the
    customer's local zone from an hourly grain — so the x axis is local days rather than
    UTC-aligned ones, and a "July" chart starts where July started for the customer.

    **A day the snapshot holds no value for is omitted, never plotted as zero.** A gap in a
    line is a gap; a zero is a claim that the machine was idle.

    A fleet-wide average per day would be arithmetic with no snapshot address, so there is no
    aggregate series — the chart shows the first few resources of the resolved scope, which
    for a `top_n` scope is the ranking's head and therefore the resources worth looking at.
    """
    refs = read_metric_refs(block, "metrics")
    chart_cursor = cursor.child("nodes", 0)
    matched = context.resources_for(block)
    caption = caption_of(block)

    if not matched:
        return BlockOutput(
            nodes=(
                empty_scope_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),
            )
        )

    # A v4 heatmap draws one row per resource, so it can hold more rows than a line chart
    # can hold lines before they stop being readable.
    layout = block.config.get("layout")
    heatmap = layout == HEATMAP_LAYOUT
    multiples = layout == MULTIPLES_LAYOUT
    annotated = layout == ANNOTATED_LAYOUT
    limit = (
        MAX_HEATMAP_ROWS if heatmap
        else MAX_MULTIPLES if multiples
        else ANNOTATED_LINES if annotated
        else MAX_CHART_SERIES
    )
    planned = [
        (resource, ref)
        for resource in matched
        for ref in refs
    ][:limit]

    series: list[Series] = []
    for ordinal, (resource, ref) in enumerate(planned):
        points_data = context.view.day_series(
            resource.resource_id, ref.name, ref.statistic
        )[:MAX_CHART_POINTS]
        if not points_data:
            continue

        series_cursor = chart_cursor.child("series", len(series))
        points = tuple(
            _point(series_cursor.child("points", position), context, local_day, value)
            for position, (local_day, value) in enumerate(points_data)
        )
        series.append(
            Series(
                path=series_cursor.path,
                key=f"{resource.resource_id}|{ref.key}",
                # A small multiple's panel is titled by its resource; the chart names the metric.
                label=resource.name if multiples else f"{resource.name} — {ref.label}",
                points=points,
            )
        )
        del ordinal

    if not series:
        # Every planned series was empty: the scope matched resources and the snapshot holds
        # no day values for these metrics. That is a recorded gap, not a chart of zeros —
        # and not "no resources matched this scope" either, which is what this branch used
        # to say. See `no_data_table`: the filter was right and the data is missing, and a
        # document that blames the filter is making a claim the snapshot contradicts.
        return BlockOutput(
            nodes=(
                no_data_table(chart_cursor, context.design.table_style_name, caption or context.messages.text("doc.chart.title.over_time", metrics=", ".join(ref.label for ref in refs)), messages=context.messages),
            )
        )

    unit = _unit_of(series)
    # Every distinct metric the chart plots, in the order the section selected them —
    # not `refs[0]` alone. A section selecting CPU average, CPU maximum and available
    # memory produced a three-panel chart titled "Percentage CPU (avg) over time", which
    # names one of the three and silently disowns the panel holding the byte counts.
    #
    # Through the catalogue rather than an f-string, which is the other half of the same
    # defect: `over time` was English in a title, and `compile/literals.py` could not see
    # it because its scan reads string literals and this was an f-string. An Indonesian
    # report carried an English chart title on every chart.
    metric_names = ", ".join(dict.fromkeys(ref.label for ref in refs))
    title = caption or context.messages.text(
        "doc.chart.title.over_time", metrics=metric_names
    )
    # A chart of one resource says which one.
    #
    # The section heading above it already does, but the title is what travels: it is the
    # caption under the image, the alt text, and what a reader sees when the chart lands on
    # a page of its own. Three per-machine charts titled `Percentage CPU (avg), Percentage
    # CPU (max) over time` are three identical captions.
    #
    # Only where the chart resolves to exactly one resource. A fleet chart names its
    # resources on its own series labels, and prefixing one of them would be wrong.
    if len(matched) == 1:
        title = context.messages.text(
            "doc.chart.title.for_resource", resource=matched[0].name, title=title
        )
    if (multiples or annotated) and not caption:
        title = context.messages.text(
            "doc.chart.title.multiples" if multiples else "doc.chart.title.annotated", metrics=metric_names
        )
    style = block.config.get("style")
    chart = Chart(
        path=chart_cursor.path,
        chart_type="heatmap" if heatmap else "multiples" if multiples else "annotated" if annotated else "line",
        title=title,
        unit=unit,
        # One series is one ordered quantity over time; two or more are peers. A heatmap's
        # rows share one colour scale, which is an ordered encoding.
        encoding=ENCODING_SEQUENTIAL if heatmap or len(series) == 1 else ENCODING_CATEGORICAL,
        series=tuple(series),
        caption=caption,
        style=style if isinstance(style, str) else "",
        panels=() if heatmap or multiples else panel_groups(tuple(series)),
        markers=_markers(block.config, {point.x for s in series for point in s.points}) if annotated else (),
    )
    cursor.anchor_chart(chart_cursor.path)
    return BlockOutput(nodes=(chart,))


AVG_VS_PEAK_LAYOUT: str = "avg_vs_peak"
"""A distribution chart's config `layout` for a v4 `avg_vs_peak` block: one row per resource
from its average to its peak, drawn as a dumbbell."""

AVG_VS_PEAK_ROWS: int = 12

BAR_LIST_LAYOUT: str = "bar_list"
"""A distribution chart's config `layout` for a v4 `bar_list` block: the section's ranking
metric, one labelled bar per resource, in the section's ranking order."""

BAR_LIST_ROWS: int = 10

BULLET_LAYOUT: str = "bullet"
"""A distribution chart's config `layout` for a v4 `utilization_bullet` block: one row per
resource with its average, its estimated P95 and a tick at its peak."""

BULLET_ROWS: int = 12


def compile_distribution_chart(
    context: BlockContext, block: BlockSpec, cursor: BlockCursor
) -> BlockOutput:
    """One bar per resource for one metric, sorted ascending by value.

    See the module docstring: a binned histogram would plot bucket counts, and a bucket count
    has no snapshot address. Sorted per-resource values convey the same shape and every bar
    traces to one measurement.

    Only the **first** metric reference is plotted. A distribution is about one quantity's
    spread; two quantities on one sorted axis would share an ordering that belongs to neither.
    """
    refs = read_metric_refs(block, "metrics")
    ref = refs[0]

    chart_cursor = cursor.child("nodes", 0)
    matched = context.resources_for(block)
    caption = caption_of(block)

    layout = block.config.get("layout")
    if layout == AVG_VS_PEAK_LAYOUT and len(refs) >= 2:
        return _avg_vs_peak(context, block, cursor, refs[0], refs[1], matched, caption)
    if layout == BULLET_LAYOUT and len(refs) >= 3:
        return _bullet(context, block, cursor, refs[0], refs[1], refs[2], matched, caption)
    if layout == BAR_LIST_LAYOUT:
        return _bar_list(context, block, cursor, ref, matched, caption)

    # Req 3.7, ahead of the metric lookup. Without this guard the two outcomes below
    # collapse into one, and an empty scope would be reported as missing data — the same
    # conflation in the opposite direction.
    if not matched:
        return BlockOutput(
            nodes=(
                empty_scope_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),
            )
        )

    measured: list[tuple[Decimal, str, ResourceView, SnapshotValue]] = []
    for resource in matched:
        value = resolve_stat(context.view, resource, ref)
        if value is not None:
            measured.append((value.value, resource.resource_id, resource, value))

    if not measured:
        # The scope matched, and no resource in it carries this metric. Same distinction the
        # timeseries branch above draws, and the same reason for drawing it.
        return BlockOutput(
            nodes=(
                no_data_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),
            )
        )

    # Ascending by value, ties on resource id — the same tie-break the scope resolver uses,
    # so two runs over one snapshot sort identically.
    measured.sort(key=lambda entry: (entry[0], entry[1]))
    measured = measured[:MAX_CHART_POINTS]

    series_cursor = chart_cursor.child("series", 0)
    points = tuple(
        _point(series_cursor.child("points", position), context, resource.name, value)
        for position, (_, _, resource, value) in enumerate(measured)
    )

    series = (
        Series(path=series_cursor.path, key=ref.key, label=ref.label, points=points),
    )
    chart = Chart(
        path=chart_cursor.path,
        chart_type="bar",
        title=caption
        or context.messages.text("doc.chart.title.distribution", metric=ref.label),
        unit=measured[0][3].unit,
        # Sorted values along an ordered axis: one ordered quantity, not a set of peers.
        encoding=ENCODING_SEQUENTIAL,
        series=series,
        caption=caption,
        panels=panel_groups(series),
    )
    cursor.anchor_chart(chart_cursor.path)
    return BlockOutput(nodes=(chart,))


def _avg_vs_peak(
    context: BlockContext,
    block: BlockSpec,
    cursor: BlockCursor,
    average: MetricRef,
    peak: MetricRef,
    matched: Sequence[ResourceView],
    caption: str | None,
) -> BlockOutput:
    """Each resource's average and peak of one metric, busiest by peak first.

    Two series over the same resources — every point a figure from the snapshot — which the
    renderer joins row by row. A resource missing either statistic is left out rather than
    drawn half: a line from an average to nothing says nothing.
    """
    chart_cursor = cursor.child("nodes", 0)
    if not matched:
        return BlockOutput(nodes=(empty_scope_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),))
    rows: list[tuple[Decimal, str, ResourceView, SnapshotValue, SnapshotValue]] = []
    for resource in matched:
        low = resolve_stat(context.view, resource, average)
        high = resolve_stat(context.view, resource, peak)
        if low is not None and high is not None:
            rows.append((high.value, resource.resource_id, resource, low, high))
    if not rows:
        return BlockOutput(nodes=(no_data_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),))
    rows.sort(key=lambda entry: (-entry[0], entry[1]))
    rows = rows[:AVG_VS_PEAK_ROWS]

    messages = context.messages
    series_list: list[Series] = []
    for ordinal, (ref, label_id, pick) in enumerate(
        ((average, "doc.chart.series.average", 3), (peak, "doc.chart.series.peak", 4))
    ):
        series_cursor = chart_cursor.child("series", ordinal)
        points = tuple(
            _point(series_cursor.child("points", position), context, row[2].name, row[pick])
            for position, row in enumerate(rows)
        )
        series_list.append(Series(path=series_cursor.path, key=ref.key, label=messages.text(label_id), points=points))
    series = tuple(series_list)
    chart = Chart(
        path=chart_cursor.path,
        chart_type="dumbbell",
        title=caption or messages.text("doc.chart.title.avg_vs_peak", metric=average.name),
        unit=rows[0][3].unit,
        encoding=ENCODING_SEQUENTIAL,
        series=series,
        caption=caption,
        panels=(tuple(entry.key for entry in series),),
    )
    cursor.anchor_chart(chart_cursor.path)
    return BlockOutput(nodes=(chart,))


def _bar_list(
    context: BlockContext,
    block: BlockSpec,
    cursor: BlockCursor,
    ref: MetricRef,
    matched: Sequence[ResourceView],
    caption: str | None,
) -> BlockOutput:
    """One bar per resource for the ranking metric, in the order the section ranks them.

    The scope already holds the ranking — the section's own top-N, or the top ten by this
    metric — so the bars keep its order rather than sorting again: a lowest-first ranking
    stays lowest first. A resource without the figure is left out, never drawn as zero.
    """
    chart_cursor = cursor.child("nodes", 0)
    if not matched:
        return BlockOutput(nodes=(empty_scope_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),))
    measured = [
        (resource, value)
        for resource in matched
        if (value := resolve_stat(context.view, resource, ref)) is not None
    ][:BAR_LIST_ROWS]
    if not measured:
        return BlockOutput(nodes=(no_data_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),))
    series_cursor = chart_cursor.child("series", 0)
    points = tuple(
        _point(series_cursor.child("points", position), context, resource.name, value)
        for position, (resource, value) in enumerate(measured)
    )
    series = (Series(path=series_cursor.path, key=ref.key, label=ref.label, points=points),)
    chart = Chart(
        path=chart_cursor.path,
        chart_type="bar_list",
        title=caption or context.messages.text("doc.chart.title.bar_list", metric=ref.label),
        unit=measured[0][1].unit,
        encoding=ENCODING_SEQUENTIAL,
        series=series,
        caption=caption,
        panels=panel_groups(series),
    )
    cursor.anchor_chart(chart_cursor.path)
    return BlockOutput(nodes=(chart,))


def _bullet(
    context: BlockContext,
    block: BlockSpec,
    cursor: BlockCursor,
    average: MetricRef,
    p95: MetricRef,
    peak: MetricRef,
    matched: Sequence[ResourceView],
    caption: str | None,
) -> BlockOutput:
    """Each resource's average, estimated P95 and peak of one metric, busiest by peak first.

    Three series over the same resources, every point a figure. The average and the peak are
    required, as on Average and peak; the P95 is the estimated one the metric summary prints,
    and a resource without it keeps its row with that bar left out.
    """
    chart_cursor = cursor.child("nodes", 0)
    if not matched:
        return BlockOutput(nodes=(empty_scope_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),))
    rows: list[tuple[Decimal, str, ResourceView, SnapshotValue, SnapshotValue | None, SnapshotValue]] = []
    for resource in matched:
        low = resolve_stat(context.view, resource, average)
        high = resolve_stat(context.view, resource, peak)
        if low is not None and high is not None:
            rows.append((high.value, resource.resource_id, resource, low, resolve_stat(context.view, resource, p95), high))
    if not rows:
        return BlockOutput(nodes=(no_data_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),))
    rows.sort(key=lambda entry: (-entry[0], entry[1]))
    rows = rows[:BULLET_ROWS]

    messages = context.messages
    series_list: list[Series] = []
    for ordinal, (ref, label_id, pick) in enumerate(
        (
            (average, "doc.chart.series.average", 3),
            (p95, "doc.chart.series.p95", 4),
            (peak, "doc.chart.series.peak", 5),
        )
    ):
        series_cursor = chart_cursor.child("series", ordinal)
        present = [row for row in rows if row[pick] is not None]
        points = tuple(
            _point(series_cursor.child("points", position), context, row[2].name, row[pick])  # type: ignore[arg-type]
            for position, row in enumerate(present)
        )
        series_list.append(Series(path=series_cursor.path, key=ref.key, label=messages.text(label_id), points=points))
    series = tuple(series_list)
    chart = Chart(
        path=chart_cursor.path,
        chart_type="bullet",
        title=caption or messages.text("doc.chart.title.bullet", metric=average.name),
        unit=rows[0][3].unit,
        encoding=ENCODING_SEQUENTIAL,
        series=series,
        caption=caption,
        panels=(tuple(entry.key for entry in series),),
    )
    cursor.anchor_chart(chart_cursor.path)
    return BlockOutput(nodes=(chart,))


FLEET_MIX_BLOCK: str = "fleet_mix"
"""The block a v4 `fleet_mix` entry expands to. Not a declared type: only the section expander
produces it, from a block the author added."""

FLEET_MIX_TYPE_LABELS: dict[str, str] = {
    "aws::ec2::instance": "doc.mix.type.ec2",
    "aws::rds::dbinstance": "doc.mix.type.rds",
    "microsoft.compute/virtualmachines": "doc.mix.type.vm",
}


def compile_fleet_mix(context: BlockContext, block: BlockSpec, cursor: BlockCursor) -> BlockOutput:
    """How a section's machines or databases split: running by size family, and stopped.

    One bar per resource type the section holds, one part per segment, each part a count the
    snapshot view derived (`/$counts/resource_type/by_name/<type>/mix/<segment>/count`). The
    counts are of every resource of that type the report collected — a count of the section's
    own narrower scope would have no address to verify — and the chart's note says so. A
    segment holding none is left out of its bar.
    """
    from reporting_agent.compile.snapshot_view import FLEET_MIX_SEGMENTS, FLEET_MIX_TYPES

    chart_cursor = cursor.child("nodes", 0)
    caption = caption_of(block)
    messages = context.messages
    matched = context.resources_for(block)
    types = sorted(
        {resource.resource_type for resource in matched if resource.resource_type.casefold() in FLEET_MIX_TYPES},
        key=str.casefold,
    )
    if not types:
        return BlockOutput(nodes=(empty_scope_table(chart_cursor, context.design.table_style_name, caption, messages=messages),))

    azure = any(resource_type.casefold().startswith("microsoft.") for resource_type in types)
    series: list[Series] = []
    for segment in FLEET_MIX_SEGMENTS:
        counted = [
            (resource_type, value)
            for resource_type in types
            if (value := context.view.cardinality("resource_type", "by_name", resource_type, "mix", segment)) is not None
            and value.value > 0
        ]
        if not counted:
            continue
        series_cursor = chart_cursor.child("series", len(series))
        label_id = "doc.mix.deallocated" if segment == "stopped" and azure else f"doc.mix.{segment}"
        points = tuple(
            _point(
                series_cursor.child("points", position),
                context,
                messages.text(FLEET_MIX_TYPE_LABELS.get(resource_type.casefold(), "doc.mix.type.other")),
                value,
            )
            for position, (resource_type, value) in enumerate(counted)
        )
        series.append(Series(path=series_cursor.path, key=segment, label=messages.text(label_id), points=points))
    if not series:
        return BlockOutput(nodes=(no_data_table(chart_cursor, context.design.table_style_name, caption, messages=messages),))

    chart = Chart(
        path=chart_cursor.path,
        chart_type="mix",
        title=caption or messages.text("doc.chart.title.fleet_mix"),
        unit="count",
        # The parts are peers: a compute machine is not "more" than a burstable one.
        encoding=ENCODING_CATEGORICAL,
        series=tuple(series),
        caption=caption,
        period_label=messages.text("doc.chart.note.fleet_mix"),
        panels=(tuple(entry.key for entry in series),),
    )
    cursor.anchor_chart(chart_cursor.path)
    return BlockOutput(nodes=(chart,))


WEEK_HEATMAP_BLOCK: str = "week_heatmap"
"""The block a v4 `week_heatmap` entry expands to. Not a declared type, like
:data:`FLEET_MIX_BLOCK`."""

WEEKDAY_IDS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
"""The `doc.weekday.*` message ids, by ISO weekday from Monday."""


def compile_week_heatmap(context: BlockContext, block: BlockSpec, cursor: BlockCursor) -> BlockOutput:
    """A section's fleet by hour of the day and weekday: one row per weekday, one cell per hour.

    Each cell is a snapshot figure the collector folded across every running resource of the
    type (`/week/buckets/<i>/statistics/<k>/value`), so the chart is of the type's fleet, not
    the section's narrower scope — the note says so. The section's first type with any cell
    is drawn; an hour nothing reported in stays empty, never zero.
    """
    chart_cursor = cursor.child("nodes", 0)
    caption = caption_of(block)
    messages = context.messages
    metric = str(block.config.get("metric") or "")
    statistic = str(block.config.get("statistic") or "avg")
    matched = context.resources_for(block)
    if not matched:
        return BlockOutput(nodes=(empty_scope_table(chart_cursor, context.design.table_style_name, caption, messages=messages),))

    types = sorted({resource.resource_type for resource in matched if resource.resource_type}, key=str.casefold)
    for resource_type in types:
        cells = {
            (weekday, hour): value
            for weekday in range(1, 8)
            for hour in range(24)
            if (value := context.view.week_stat(resource_type, metric, statistic, weekday, hour)) is not None
        }
        if cells:
            break
    else:
        return BlockOutput(nodes=(no_data_table(chart_cursor, context.design.table_style_name, caption, messages=messages),))

    series: list[Series] = []
    for weekday in range(1, 8):
        hours = [(hour, cells[(weekday, hour)]) for hour in range(24) if (weekday, hour) in cells]
        if not hours:
            continue
        series_cursor = chart_cursor.child("series", len(series))
        points = tuple(
            _point(series_cursor.child("points", position), context, f"{hour:02d}:00", value)
            for position, (hour, value) in enumerate(hours)
        )
        series.append(
            Series(path=series_cursor.path, key=str(weekday), label=messages.text(f"doc.weekday.{WEEKDAY_IDS[weekday - 1]}"), points=points)
        )

    chart = Chart(
        path=chart_cursor.path,
        chart_type="week",
        title=caption or messages.text("doc.chart.title.week", metric=MetricRef(name=metric, statistic=statistic).label),
        unit=_unit_of(series),
        encoding=ENCODING_SEQUENTIAL,
        series=tuple(series),
        caption=caption,
        period_label=messages.text("doc.chart.note.week"),
        panels=(),
    )
    cursor.anchor_chart(chart_cursor.path)
    return BlockOutput(nodes=(chart,))


def _unit_of(series: list[Series]) -> str:
    """The unit every plotted figure in `series` carries.

    Chart-wide, because an axis has one unit. Where two series disagree — a percentage
    plotted beside a byte count — the first one's unit is used and the mismatch is visible in
    the series labels rather than silently rescaled: rescaling would be arithmetic on a
    figure, which nothing outside `compile/` is allowed to do.
    """
    for entry in series:
        for point in entry.points:
            return point.y.unit
    return "count"


def _metric_label(ref: MetricRef) -> str:
    return ref.label
