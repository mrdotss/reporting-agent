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

from decimal import Decimal

from reporting_agent.compile.ast import Chart, ChartPoint, Series
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
from reporting_agent.compile.scope import resolve
from reporting_agent.compile.snapshot_view import ResourceView, SnapshotValue

__all__ = ["compile_distribution_chart", "compile_timeseries_chart"]

ENCODING_CATEGORICAL = "categorical"
ENCODING_SEQUENTIAL = "sequential"


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
    matched = resolve(context.scope_for(block), context.view)
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
    chart = Chart(
        path=chart_cursor.path,
        chart_type="line",
        title=caption or f"{refs[0].label} over time",
        unit=unit,
        # One series is one ordered quantity over time; two or more are peers.
        encoding=ENCODING_SEQUENTIAL if len(series) == 1 else ENCODING_CATEGORICAL,
        series=tuple(series),
        caption=caption,
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
    matched = resolve(context.scope_for(block), context.view)
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

    chart = Chart(
        path=chart_cursor.path,
        chart_type="bar",
        title=caption or f"Distribution of {ref.label}",
        unit=measured[0][3].unit,
        # Sorted values along an ordered axis: one ordered quantity, not a set of peers.
        encoding=ENCODING_SEQUENTIAL,
        series=(
            Series(
                path=series_cursor.path, key=ref.key, label=ref.label, points=points
            ),
        ),
        caption=caption,
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
