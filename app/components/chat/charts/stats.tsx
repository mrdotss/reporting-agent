"use client"

import { useFigureTrace } from "@/components/chat/figure-trace"
import { SourceBadge } from "@/components/chat/charts/frame"
import type { ChatChartPoint, ChatStatsChart } from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * An answer's headline figures as tiles, each with its daily line when the snapshot has
 * one. A tile is a figure like any chip: the same string, the same number, the same trace.
 */
export function StatsStrip({ chart }: Readonly<{ chart: ChatStatsChart }>) {
  const trace = useFigureTrace()

  return (
    <section
      data-slot="answer-chart"
      data-kind="stats"
      data-source={chart.source}
      aria-label={chart.title || "Headline figures"}
      className="flex flex-col gap-2"
    >
      {chart.title ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">{chart.title}</span>
          <SourceBadge source={chart.source} />
        </div>
      ) : null}
      <div
        className={cn(
          "grid gap-2.5",
          chart.tiles.length === 2
            ? "sm:grid-cols-2"
            : chart.tiles.length === 3
              ? "sm:grid-cols-3"
              : "grid-cols-2 sm:grid-cols-4"
        )}
      >
        {chart.tiles.map((tile) => {
          const live = tile.source === "live"
          const number = trace?.numbers.get(tile.fact_id)
          const selected = trace?.selectedId === tile.fact_id
          return (
            <button
              key={tile.fact_id}
              type="button"
              data-slot="stat-tile"
              disabled={!trace || number === undefined}
              aria-pressed={trace ? selected : undefined}
              aria-label={`${tile.label}: ${tile.formatted}${live ? ", live, not verified" : ""}${number ? `, figure ${number}` : ""}`}
              onClick={() => trace?.onSelect(tile.fact_id)}
              className={cn(
                "flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-3 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 enabled:cursor-pointer enabled:hover:border-ring/60",
                live ? "border-dashed border-input" : "border-border",
                selected && "border-primary ring-1 ring-primary"
              )}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-micro text-muted-foreground uppercase">
                  {tile.label}
                </span>
                {number !== undefined ? (
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">
                    {number}
                  </span>
                ) : null}
              </span>
              <span className="flex items-end justify-between gap-2">
                <span
                  className={cn(
                    "truncate font-mono text-xl leading-none font-medium tracking-tight tabular-nums",
                    live ? "text-foreground" : "text-(--status-verified)"
                  )}
                >
                  {tile.formatted}
                </span>
                {tile.points.length >= 2 ? (
                  <Sparkline points={tile.points} live={live} />
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {live
                  ? "Live · not verified"
                  : tile.points.length >= 2
                    ? `${tile.points.length} days`
                    : "Verified"}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function Sparkline({
  points,
  live,
}: Readonly<{ points: readonly ChatChartPoint[]; live: boolean }>) {
  const values = points
    .map((point) => Number(point.value))
    .filter(Number.isFinite)
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const at = values.map(
    (value, index) =>
      [
        2 + (index / (values.length - 1)) * 76,
        22 - ((value - min) / (max - min || 1)) * 18,
      ] as const
  )
  const line = at
    .map(
      ([x, y], index) =>
        `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`
    )
    .join(" ")
  const end = at[at.length - 1]!
  return (
    <svg
      width="80"
      height="26"
      viewBox="0 0 80 26"
      aria-hidden="true"
      className="shrink-0"
    >
      {live ? null : (
        <path d={`${line} L78 25 L2 25 Z`} className="fill-(--cat-1)/12" />
      )}
      <path
        d={line}
        fill="none"
        className={live ? "stroke-muted-foreground" : "stroke-(--cat-1)"}
        strokeWidth="1.5"
        strokeDasharray={live ? "4 3" : undefined}
        strokeLinejoin="round"
      />
      <circle
        cx={end[0]}
        cy={end[1]}
        r="2.5"
        className={live ? "fill-muted-foreground" : "fill-(--cat-1)"}
      />
    </svg>
  )
}
