"use client"

import { ChartLineIcon } from "@phosphor-icons/react"

import { CompareBars } from "@/components/chat/charts/compare"
import { SpreadChart } from "@/components/chat/charts/spread"
import { StatsStrip } from "@/components/chat/charts/stats"
import { TrendChart } from "@/components/chat/charts/trend"
import { asTrend, withResourceLabels } from "@/lib/chat/chart-data"
import type { ChatChart, ChatCitation } from "@/lib/chat/views"

/**
 * A chart in an answer (ask-chat Req 9), drawn from the spec the runtime built from facts it
 * read — never from numbers the model wrote. Geometry comes from each value's decimal
 * string; every label is the formatted string a figure chip shows.
 *
 * Inside an answer that can trace its figures (`FigureTraceProvider`), every bar, mark and
 * tile is a button that opens the figure's trace. Each chart offers its figures as a table,
 * as a CSV, and at full size.
 */
export function AnswerChart({
  chart: stored,
  citations = {},
  expanded = false,
}: Readonly<{
  chart: ChatChart
  citations?: Readonly<Record<string, ChatCitation>>
  expanded?: boolean
}>) {
  // Charts stored before labels named the resource still read by its name, not its ARN.
  const chart = withResourceLabels(stored)
  const renderExpanded = expanded
    ? undefined
    : () => <AnswerChart chart={chart} citations={citations} expanded />

  if (chart.kind === "stats") return <StatsStrip chart={chart} />
  if (chart.kind === "spread")
    return (
      <SpreadChart
        chart={chart}
        expanded={expanded}
        renderExpanded={renderExpanded}
      />
    )
  if (chart.kind === "compare")
    return (
      <CompareBars
        chart={chart}
        expanded={expanded}
        renderExpanded={renderExpanded}
      />
    )

  const trend = asTrend(chart)
  if (trend === null) return null
  return (
    <TrendChart
      chart={trend}
      original={chart}
      citations={citations}
      expanded={expanded}
      renderExpanded={renderExpanded}
    />
  )
}

/** Where a chart will be, while the answer that places it is still streaming. */
export function AnswerChartPending() {
  return (
    <div
      data-slot="answer-chart-pending"
      className="flex h-28 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground"
    >
      <ChartLineIcon aria-hidden="true" className="mr-1.5 size-4" />
      The chart appears when the answer finishes.
    </div>
  )
}
