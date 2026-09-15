"use client"

import { useId } from "react"
import { ChartLineIcon, LightningIcon, SealCheckIcon } from "@phosphor-icons/react"

import { cssVar } from "@/components/charts/categorical"
import type { ChartSpec } from "@/components/charts/chart-spec"
import { ThemedChart } from "@/components/charts/themed-chart"
import type { ChatChart, ChatChartSource } from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * A chart inside an answer (ask-chat Req 9).
 *
 * Built by the runtime from facts it read, so every value here is a fact's own decimal
 * string and every label a fact's own formatted string — a bar and the figure chip beside it
 * cannot disagree.
 *
 * - **daily** reuses the report's {@link ThemedChart}, so a trend in an answer is drawn the
 *   way a delivered document draws one: the same scale rule, baseline, palette and marker.
 * - **compare** is a single-series ranking, drawn as bars in the first categorical token,
 *   each labelled with its formatted figure.
 *
 * The header says where the numbers came from before anything else: a verified seal, or a
 * grey "Live · not verified" when a live metrics pull supplied them. The figures are also
 * listed beneath the drawing, which is the chart's accessible alternative.
 */

const SOURCE_BADGE: Readonly<
  Record<ChatChartSource, { readonly label: string; readonly verified: boolean }>
> = {
  verified: { label: "Verified figures", verified: true },
  live: { label: "Live · not verified", verified: false },
  mixed: { label: "Verified and live figures", verified: false },
}

export function AnswerChart({ chart }: Readonly<{ chart: ChatChart }>) {
  const headingId = useId()
  const badge = SOURCE_BADGE[chart.source]

  return (
    <figure
      data-slot="answer-chart"
      data-kind={chart.kind}
      data-source={chart.source}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5"
    >
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span id={headingId} className="min-w-0 flex-1 truncate text-sm font-semibold">
          {chart.title}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium",
            badge.verified
              ? "bg-(--status-verified-soft) text-(--status-verified)"
              : "bg-muted text-muted-foreground ring-1 ring-border ring-inset"
          )}
        >
          {badge.verified ? (
            <SealCheckIcon aria-hidden="true" className="size-3" />
          ) : (
            <LightningIcon aria-hidden="true" className="size-3" />
          )}
          {badge.label}
        </span>
      </figcaption>

      {chart.kind === "daily" ? <DailyChart chart={chart} /> : <CompareBars chart={chart} />}
    </figure>
  )
}

function DailyChart({ chart }: Readonly<{ chart: Extract<ChatChart, { kind: "daily" }> }>) {
  const spec: ChartSpec = {
    chartType: "timeseries",
    encoding: "categorical",
    unit: chart.unit,
    title: chart.title,
    panels: [],
    series: [
      {
        key: chart.series_label,
        label: chart.series_label,
        points: chart.points.map((point) => ({
          x: point.day,
          value: Number(point.value),
          formatted: point.formatted,
          snapshotPath: null,
        })),
      },
    ],
  }

  const first = chart.points[0]
  const last = chart.points.at(-1)
  const values = chart.points.map((point) => Number(point.value))
  const peak = chart.points[values.indexOf(Math.max(...values))]

  return (
    <>
      <div className="-mx-1 overflow-x-auto">
        <div className="min-w-[28rem]">
          <ThemedChart spec={spec} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <ChartLineIcon aria-hidden="true" className="size-3.5" />
          {chart.series_label}
        </span>
        <span className="font-mono tabular-nums">
          {first?.day} → {last?.day}
          {peak ? ` · peak ${peak.formatted} on ${peak.day}` : ""}
        </span>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
          Daily figures
        </summary>
        <table className="mt-2 w-full border-collapse">
          <tbody>
            {chart.points.map((point) => (
              <tr key={point.day} className="border-t border-border/60">
                <td className="py-1 pr-3 font-mono text-muted-foreground">{point.day}</td>
                <td className="py-1 text-right font-mono tabular-nums">{point.formatted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  )
}

function CompareBars({ chart }: Readonly<{ chart: Extract<ChatChart, { kind: "compare" }> }>) {
  const values = chart.bars.map((bar) => Number(bar.value))
  const max = Math.max(...values.filter((value) => Number.isFinite(value)), 0)
  const min = Math.min(...values.filter((value) => Number.isFinite(value)), 0)
  const span = max - min || 1

  return (
    <ol className="flex flex-col gap-2" aria-label={`${chart.title}, one bar per figure`}>
      {chart.bars.map((bar) => {
        const value = Number(bar.value)
        const width = Number.isFinite(value) ? Math.max(1.5, ((value - min) / span) * 100) : 0
        return (
          <li key={bar.fact_id} className="grid grid-cols-[minmax(5rem,11rem)_minmax(0,1fr)] items-center gap-3">
            <span className="truncate font-mono text-xs text-muted-foreground" title={bar.label}>
              {bar.label}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  aria-hidden="true"
                  className="block h-full rounded-full"
                  style={{ width: `${width}%`, background: cssVar("--cat-1") }}
                />
              </span>
              <span className="w-24 shrink-0 text-right font-mono text-xs font-medium tabular-nums">
                {bar.formatted}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
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
