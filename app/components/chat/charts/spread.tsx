"use client"

import { useFigureTrace } from "@/components/chat/figure-trace"
import { ChartFrame, FiguresTable } from "@/components/chat/charts/frame"
import { statMark, tickLabel, valueScale } from "@/lib/chat/chart-data"
import type { ChatSpreadChart } from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * How far each machine's statistics spread on one scale: its average, its busiest hour,
 * its peak. The gap between the average and the scale's top is the room it has.
 *
 * Each mark is a figure the answer cites and a button that opens its trace. A percentage is
 * always drawn on 0–100%, so "room" means the same thing on every row; the half above 50% is
 * shaded as a reading aid, not a finding. A row with a live statistic is drawn dashed.
 */

const MARK_LABEL: Record<ReturnType<typeof statMark>, string> = {
  hollow: "average",
  filled: "percentile",
  tick: "max / min",
  diamond: "other",
}

export function SpreadChart({
  chart,
  expanded = false,
  renderExpanded,
}: Readonly<{
  chart: ChatSpreadChart
  expanded?: boolean
  renderExpanded?: () => React.ReactNode
}>) {
  const trace = useFigureTrace()
  const percent = chart.unit === "percent"
  const max = Math.max(
    0,
    ...chart.rows
      .flatMap((row) => row.stats.map((stat) => Number(stat.value)))
      .filter(Number.isFinite)
  )
  const scale = percent
    ? { top: 100, label: (value: number) => tickLabel(value, chart.unit) }
    : valueScale(
        chart.unit,
        max,
        chart.rows.flatMap((row) => row.stats.map((stat) => stat.formatted))
      )
  const top = scale.top
  const at = (value: number) =>
    `${Math.max(0, Math.min(100, (value / top) * 100)).toFixed(2)}%`
  const marks = [
    ...new Set(
      chart.rows.flatMap((row) =>
        row.stats.map((stat) => statMark(stat.statistic))
      )
    ),
  ]
  const statistics = [
    ...new Set(
      chart.rows.flatMap((row) => row.stats.map((stat) => stat.statistic))
    ),
  ]

  return (
    <ChartFrame
      chart={chart}
      meta={`${chart.rows.length} ${chart.rows.length === 1 ? "machine" : "machines"} · ${statistics.join(", ")}${
        trace ? " · select a mark to trace it" : ""
      }`}
      expanded={expanded}
      renderExpanded={renderExpanded}
      table={
        <FiguresTable
          head={["Machine", ...statistics]}
          rows={chart.rows.map((row) => [
            row.label,
            ...statistics.map(
              (name) =>
                row.stats.find((stat) => stat.statistic === name)?.formatted ??
                "—"
            ),
          ])}
        />
      }
    >
      <ul
        aria-label="Marks"
        className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
      >
        {marks.map((mark) => (
          <li key={mark} className="inline-flex items-center gap-1.5">
            <Mark kind={mark} live={false} />
            {MARK_LABEL[mark]}
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-[minmax(5rem,9rem)_minmax(0,1fr)] gap-x-3">
        <span />
        <div className="relative mb-1 h-4 font-mono text-[0.6875rem] text-muted-foreground">
          <span className="absolute left-0">{scale.label(0)}</span>
          <span className="absolute -translate-x-1/2" style={{ left: "50%" }}>
            {scale.label(top / 2)}
          </span>
          <span className="absolute right-0">{scale.label(top)}</span>
        </div>

        {chart.rows.map((row) => {
          const low = Number(row.stats[0]?.value)
          const high = Number(row.stats[row.stats.length - 1]?.value)
          const live = row.source === "live"
          return (
            <div key={row.label} className="contents">
              <span className="flex min-w-0 items-center gap-1.5 py-2">
                <span className="truncate font-mono text-xs" title={row.label}>
                  {row.label}
                </span>
                {live ? (
                  <span className="text-[0.625rem] font-semibold tracking-wide text-muted-foreground uppercase">
                    Live
                  </span>
                ) : null}
              </span>
              <div className="relative h-9 border-t border-border/60">
                {percent ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 right-0 left-1/2 bg-(--status-attention-soft)/50"
                  />
                ) : null}
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 h-0.5 -translate-y-1/2",
                    live
                      ? "border-t-2 border-dashed border-muted-foreground bg-transparent"
                      : "bg-(--cat-1)/45"
                  )}
                  style={{
                    left: at(low),
                    width: `calc(${at(high)} - ${at(low)})`,
                  }}
                />
                {row.stats.map((stat) => {
                  const selected = trace?.selectedId === stat.fact_id
                  const number = trace?.numbers.get(stat.fact_id)
                  return (
                    <button
                      key={stat.fact_id}
                      type="button"
                      data-slot="spread-mark"
                      aria-label={`${row.label} ${stat.statistic} ${stat.formatted}${live ? ", live, not verified" : ""}${
                        number ? `, figure ${number}` : ""
                      }`}
                      title={`${stat.statistic} ${stat.formatted}`}
                      aria-pressed={trace ? selected : undefined}
                      disabled={!trace || number === undefined}
                      onClick={() => trace?.onSelect(stat.fact_id)}
                      className={cn(
                        "absolute top-1/2 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/40 enabled:cursor-pointer",
                        selected && "ring-2 ring-primary"
                      )}
                      style={{ left: at(Number(stat.value)) }}
                    >
                      <Mark kind={statMark(stat.statistic)} live={live} />
                    </button>
                  )
                })}
              </div>
              <span />
              <p className="-mt-1 mb-1 flex flex-wrap gap-x-3 font-mono text-[0.6875rem] text-muted-foreground">
                {row.stats.map((stat) => (
                  <span key={stat.fact_id}>
                    {stat.statistic}{" "}
                    <span
                      className={
                        live ? "text-foreground" : "text-(--status-verified)"
                      }
                    >
                      {stat.formatted}
                    </span>
                  </span>
                ))}
              </p>
            </div>
          )
        })}
      </div>
    </ChartFrame>
  )
}

function Mark({
  kind,
  live,
}: Readonly<{ kind: ReturnType<typeof statMark>; live: boolean }>) {
  const color = live
    ? "border-muted-foreground bg-muted-foreground"
    : "border-(--cat-1) bg-(--cat-1)"
  switch (kind) {
    case "hollow":
      return (
        <span
          className={cn(
            "size-2.5 rounded-full border-2 bg-card",
            color.split(" ")[0],
            live && "border-dashed"
          )}
        />
      )
    case "filled":
      return (
        <span className={cn("size-2.5 rounded-full", color.split(" ")[1])} />
      )
    case "tick":
      return <span className="h-3.5 w-0.5 rounded-full bg-foreground" />
    default:
      return <span className={cn("size-2 rotate-45", color.split(" ")[1])} />
  }
}
