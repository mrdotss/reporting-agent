"use client"

import { useState } from "react"

import { useFigureTrace } from "@/components/chat/figure-trace"
import {
  ChartFrame,
  ChartToggle,
  FiguresTable,
} from "@/components/chat/charts/frame"
import type { ChatCompareChart } from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * One metric across machines or sizes, one bar each. A bar is a figure: its length is the
 * fact's value, its label the fact's string, and choosing it opens its trace. Sorting is the
 * reader's, and changes nothing but the order. A live bar is hatched with a dashed edge.
 */
export function CompareBars({
  chart,
  expanded = false,
  renderExpanded,
}: Readonly<{
  chart: ChatCompareChart
  expanded?: boolean
  renderExpanded?: () => React.ReactNode
}>) {
  const trace = useFigureTrace()
  const [order, setOrder] = useState<"value" | "asked">("value")
  const values = chart.bars
    .map((bar) => Number(bar.value))
    .filter(Number.isFinite)
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const bars =
    order === "value"
      ? [...chart.bars].sort((a, b) => Number(b.value) - Number(a.value))
      : chart.bars

  return (
    <ChartFrame
      chart={chart}
      meta={`${chart.bars.length} figures${trace ? " · select a bar to trace it" : ""}`}
      expanded={expanded}
      renderExpanded={renderExpanded}
      controls={
        <ChartToggle
          label="Order"
          value={order}
          onChange={setOrder}
          options={[
            { value: "value", label: "By value" },
            { value: "asked", label: "As asked" },
          ]}
        />
      }
      table={
        <FiguresTable
          head={["Label", "Value"]}
          rows={chart.bars.map((bar) => [bar.label, bar.formatted])}
        />
      }
    >
      <ol
        className="flex flex-col"
        aria-label={`${chart.title}, one bar per figure`}
      >
        {bars.map((bar) => {
          const value = Number(bar.value)
          const width = Number.isFinite(value)
            ? Math.max(1.5, ((value - min) / span) * 100)
            : 0
          const live =
            (bar.source ?? (chart.source === "live" ? "live" : "verified")) ===
            "live"
          const number = trace?.numbers.get(bar.fact_id)
          const selected = trace?.selectedId === bar.fact_id
          return (
            <li key={bar.fact_id}>
              <button
                type="button"
                data-slot="compare-bar"
                disabled={!trace || number === undefined}
                aria-pressed={trace ? selected : undefined}
                aria-label={`${bar.label}: ${bar.formatted}${live ? ", live, not verified" : ""}${number ? `, figure ${number}` : ""}`}
                onClick={() => trace?.onSelect(bar.fact_id)}
                className={cn(
                  "grid w-full grid-cols-[minmax(5rem,10rem)_minmax(0,1fr)_minmax(4.5rem,auto)] items-center gap-3 rounded-lg px-1.5 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30 enabled:cursor-pointer enabled:hover:bg-muted/60",
                  selected &&
                    "bg-primary/[0.07] enabled:hover:bg-primary/[0.07]"
                )}
              >
                <span
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={bar.label}
                >
                  {bar.label}
                </span>
                <span className="h-3 min-w-0 overflow-hidden rounded-[3px] bg-muted">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "block h-full rounded-[3px]",
                      live
                        ? "border border-dashed border-muted-foreground bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--border)_3px_5px)]"
                        : selected
                          ? "bg-primary"
                          : "bg-(--cat-1)"
                    )}
                    style={{ width: `${width}%` }}
                  />
                </span>
                <span
                  className={cn(
                    "text-right font-mono text-xs font-medium tabular-nums",
                    live ? "text-foreground" : "text-(--status-verified)"
                  )}
                >
                  {live ? (
                    <span className="mr-1 font-sans text-[0.625rem] text-muted-foreground uppercase">
                      Live
                    </span>
                  ) : null}
                  {bar.formatted}
                  {number !== undefined ? (
                    <sup className="ml-0.5 font-sans text-[0.6em] font-semibold opacity-60">
                      {number}
                    </sup>
                  ) : null}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </ChartFrame>
  )
}
