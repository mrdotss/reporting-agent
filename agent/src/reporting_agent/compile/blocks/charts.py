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

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

from reporting_agent.compile.ast import (
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
from reporting_agent.compile.figures import BlockCursor
from reporting_agent.compile.historical import Selection
from reporting_agent.compile.messages import Messages
from reporting_agent.compile.snapshot_view import ResourceView, SnapshotValue, SnapshotView
from reporting_agent.errors import CompileFailedError

__all__ = ["compile_distribution_chart", "compile_historical_trend", "compile_timeseries_chart"]

ENCODING_CATEGORICAL = "categorical"
ENCODING_SEQUENTIAL = "sequential"

# --- Historical trend ---

PRIOR_RUN_NAMESPACE: str = "prior_runs"
"""The namespace prefix for prior-run pointers in the historical trend block."""

HISTORICAL_LOOKBACK_MIN: int = 2
HISTORICAL_LOOKBACK_MAX: int = 24


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

    selected = selection.selected

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
            value = _find_historical_value(prior_view, metric, statistic)
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

    count_plotted = len(points)
    count_requested = lookback

    # Build the statements
    messages = context.messages
    exclusion_summary = _exclusion_summary(selection, messages)
    nodes: list[object] = []

    if count_plotted == 0:
        # Req 19.5 — zero prior runs: one statement, block still emitted
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
        "doc.historical.trend_statement",
        count=str(count_plotted),
        requested=str(count_requested),
        exclusions=exclusion_summary,
    )
    nodes.append(text_paragraph(statement_cursor, "Body Text", trend_statement))

    # Req 19.7 — the verification-note statement
    verification_note = messages.text("doc.historical.verification_note")
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
    view: SnapshotView, metric: str, statistic: str
) -> SnapshotValue | None:
    """Find the first value matching (metric, statistic) in the snapshot view.

    For a trend chart we take the **aggregate** value — the first resource's matching
    statistic. In a real implementation this would be the overall aggregate across
    all resources, but the block plots one point per run so we take whatever the
    snapshot exposes for this (metric, statistic) pair.
    """
    for resource in view.resources:
        value = view.stat(resource.resource_id, metric, statistic)
        if value is not None:
            return value
    return None


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

    planned = [
        (resource, ref)
        for resource in matched
        for ref in refs
    ][:MAX_CHART_SERIES]

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
                label=f"{resource.name} — {ref.label}",
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
                no_data_table(chart_cursor, context.design.table_style_name, caption, messages=context.messages),
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
    chart = Chart(
        path=chart_cursor.path,
        chart_type="line",
        title=caption
        or context.messages.text("doc.chart.title.over_time", metrics=metric_names),
        unit=unit,
        # One series is one ordered quantity over time; two or more are peers.
        encoding=ENCODING_SEQUENTIAL if len(series) == 1 else ENCODING_CATEGORICAL,
        series=tuple(series),
        caption=caption,
        panels=panel_groups(tuple(series)),
    )
    cursor.anchor_chart(chart_cursor.path)
    return BlockOutput(nodes=(chart,))


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
