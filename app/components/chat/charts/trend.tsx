"use client"

import { useMemo, useRef, useState } from "react"

import { useFigureTrace } from "@/components/chat/figure-trace"
import {
  ChartFrame,
  ChartToggle,
  FiguresTable,
} from "@/components/chat/charts/frame"
import { FigureChip } from "@/components/chat/message-text"
import { cssVar } from "@/components/charts/categorical"
import {
  colorForKey,
  dashForPosition,
  markerForPosition,
  type MarkerShape,
} from "@/components/charts/palette"
import {
  longDay,
  pointOn,
  shortDay,
  ticks,
  trendDays,
  valueScale,
} from "@/lib/chat/chart-data"
import type { ChatChart, ChatCitation, ChatTrendChart } from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * One to four daily series on one scale.
 *
 * Pointing at a day reads every series on it, and clicking pins that day so it stays read
 * while the reader looks elsewhere; the arrow keys move the pin. Each series can be hidden
 * from its legend entry, and a long series can be narrowed to its last fourteen days. Every
 * value printed — in the readout, beside a peak, in the table — is the runtime's own string.
 *
 * Series are told apart three ways, as every chart here is: colour, dash and marker. A live
 * series is also drawn dashed and says so, so it never passes for a verified one.
 */

const W = 720
const H = 260
const L = 46
const R = 104
const T = 22
const B = 28
const RECENT_DAYS = 14

type Range = "all" | "recent"

export function TrendChart({
  chart,
  original,
  citations,
  expanded = false,
  renderExpanded,
}: Readonly<{
  chart: ChatTrendChart
  original: ChatChart
  citations: Readonly<Record<string, ChatCitation>>
  expanded?: boolean
  renderExpanded?: () => React.ReactNode
}>) {
  const trace = useFigureTrace()
  const allDays = useMemo(() => trendDays(chart), [chart])
  const [range, setRange] = useState<Range>("all")
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [hover, setHover] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const plot = useRef<SVGSVGElement>(null)

  const days = range === "recent" ? allDays.slice(-RECENT_DAYS) : allDays
  const labels = chart.series.map((series) => series.label)
  const styled = chart.series.map((series, index) => ({
    ...series,
    key: series.fact_id || series.label,
    token: colorForKey(
      series.label,
      labels.filter((label) => label !== series.label)
    ),
    dash: series.source === "live" ? "5 4" : dashForPosition(index),
    marker: markerForPosition(index),
  }))
  const visible = styled.filter((series) => !hidden.has(series.key))

  const values = visible.flatMap((series) =>
    series.points
      .filter((point) => days.includes(point.day))
      .map((point) => Number(point.value))
  )
  const max = Math.max(0, ...values.filter(Number.isFinite))
  const scale = valueScale(
    chart.unit,
    max,
    chart.series.flatMap((series) =>
      series.points.map((point) => point.formatted)
    )
  )
  const top = scale.top
  const x = (index: number) =>
    L + (days.length <= 1 ? 0 : (index / (days.length - 1)) * (W - L - R))
  const y = (value: number) => T + (H - T - B) - (value / top) * (H - T - B)

  const shown = hover ?? pinned
  const shownDay =
    shown === null ? null : days[Math.min(shown, days.length - 1)]

  function indexAt(clientX: number): number | null {
    const box = plot.current?.getBoundingClientRect()
    if (!box || box.width === 0 || days.length === 0) return null
    const svgX = ((clientX - box.left) / box.width) * W
    const ratio = (svgX - L) / (W - L - R)
    return Math.max(
      0,
      Math.min(days.length - 1, Math.round(ratio * (days.length - 1)))
    )
  }

  const everyNth = Math.max(1, Math.ceil(days.length / 6))
  const xTicks = days
    .map((day, index) => ({ day, index }))
    .filter(({ index }) => index % everyNth === 0 || index === days.length - 1)

  const meta = `${chart.series.length} ${chart.series.length === 1 ? "series" : "series"} · ${allDays.length} days${
    trace ? " · point at a day to read it" : ""
  }`

  return (
    <ChartFrame
      chart={original}
      meta={meta}
      expanded={expanded}
      renderExpanded={renderExpanded}
      controls={
        allDays.length > RECENT_DAYS + 7 ? (
          <ChartToggle
            label="Range"
            value={range}
            onChange={(next) => {
              setRange(next)
              setPinned(null)
            }}
            options={[
              { value: "all", label: "All days" },
              { value: "recent", label: `Last ${RECENT_DAYS}` },
            ]}
          />
        ) : null
      }
      table={
        <FiguresTable
          head={["Day", ...chart.series.map((series) => series.label)]}
          rows={allDays.map((day) => [
            day,
            ...chart.series.map(
              (series) => pointOn(series.points, day)?.formatted ?? "—"
            ),
          ])}
        />
      }
    >
      <ul aria-label="Series" className="mb-1 flex flex-wrap gap-1.5">
        {styled.map((series) => {
          const off = hidden.has(series.key)
          const citation = series.fact_id
            ? citations[series.fact_id]
            : undefined
          return (
            <li key={series.key} className="flex items-center gap-1">
              <button
                type="button"
                aria-pressed={!off}
                onClick={() =>
                  setHidden((current) => {
                    const next = new Set(current)
                    if (next.has(series.key)) next.delete(series.key)
                    else if (visible.length > 1) next.add(series.key)
                    return next
                  })
                }
                title={off ? "Show this series" : "Hide this series"}
                className={cn(
                  "inline-flex h-7 items-center gap-2 rounded-md border border-border px-2 text-xs transition-[opacity,background-color] outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30",
                  off && "opacity-45"
                )}
              >
                <svg
                  width="22"
                  height="10"
                  viewBox="0 0 22 10"
                  aria-hidden="true"
                >
                  <line
                    x1="1"
                    y1="5"
                    x2="21"
                    y2="5"
                    stroke={cssVar(series.token)}
                    strokeWidth="2"
                    strokeDasharray={
                      series.dash === "0" ? undefined : series.dash
                    }
                  />
                  <Marker
                    shape={series.marker}
                    x={11}
                    y={5}
                    token={series.token}
                    size={3.2}
                  />
                </svg>
                <span className="font-mono">{series.label}</span>
                {series.source === "live" ? (
                  <span className="text-[0.625rem] font-semibold tracking-wide text-muted-foreground uppercase">
                    Live
                  </span>
                ) : null}
              </button>
              {citation && series.fact_id ? (
                <FigureChip
                  text={citation.formatted}
                  citation={citation}
                  factId={series.fact_id}
                />
              ) : null}
            </li>
          )
        })}
      </ul>

      <div
        className="relative -mx-1 outline-none focus-visible:rounded-lg focus-visible:ring-3 focus-visible:ring-ring/30"
        tabIndex={0}
        role="group"
        aria-label={`${chart.title}. Use the left and right arrow keys to read one day at a time.`}
        onKeyDown={(event) => {
          if (
            event.key !== "ArrowLeft" &&
            event.key !== "ArrowRight" &&
            event.key !== "Escape"
          )
            return
          event.preventDefault()
          if (event.key === "Escape") return setPinned(null)
          const from = pinned ?? (event.key === "ArrowLeft" ? days.length : -1)
          setPinned(
            Math.max(
              0,
              Math.min(
                days.length - 1,
                from + (event.key === "ArrowLeft" ? -1 : 1)
              )
            )
          )
        }}
      >
        <svg
          ref={plot}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full touch-pan-y"
          role="img"
          aria-label={`${chart.title}, ${days.length} days`}
          onPointerMove={(event) => setHover(indexAt(event.clientX))}
          onPointerLeave={() => setHover(null)}
          onClick={(event) => {
            const index = indexAt(event.clientX)
            setPinned((current) =>
              index === null || current === index ? null : index
            )
          }}
        >
          {ticks(top).map((tick) => (
            <g key={tick}>
              <line
                x1={L}
                x2={W - R + 8}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-border"
                strokeWidth="1"
              />
              <text
                x={L - 8}
                y={y(tick) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground font-mono text-[10.5px]"
              >
                {scale.label(tick)}
              </text>
            </g>
          ))}
          {xTicks.map(({ day, index }) => (
            <text
              key={day}
              x={x(index)}
              y={H - 8}
              textAnchor="middle"
              className="fill-muted-foreground font-mono text-[10.5px]"
            >
              {shortDay(day)}
            </text>
          ))}

          {shown !== null ? (
            <line
              x1={x(shown)}
              x2={x(shown)}
              y1={T - 6}
              y2={H - B}
              className="stroke-primary"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          ) : null}

          {visible.map((series) => {
            const placed = days
              .map((day, index) => {
                const point = pointOn(series.points, day)
                return point === undefined ||
                  !Number.isFinite(Number(point.value))
                  ? null
                  : { index, point }
              })
              .filter(
                (entry): entry is NonNullable<typeof entry> => entry !== null
              )
            if (placed.length === 0) return null
            const path = placed
              .map(
                ({ index, point }, position) =>
                  `${position === 0 ? "M" : "L"}${x(index).toFixed(1)} ${y(Number(point.value)).toFixed(1)}`
              )
              .join(" ")
            const peak = placed.reduce((best, entry) =>
              Number(entry.point.value) > Number(best.point.value)
                ? entry
                : best
            )
            const last = placed[placed.length - 1]!
            const selected =
              trace !== null &&
              series.fact_id !== "" &&
              trace.selectedId === series.fact_id
            return (
              <g key={series.key} data-series={series.label}>
                <path
                  d={path}
                  fill="none"
                  stroke={cssVar(series.token)}
                  strokeWidth={selected ? 3 : 2}
                  strokeDasharray={
                    series.dash === "0" ? undefined : series.dash
                  }
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {placed.length <= 40
                  ? placed.map(({ index, point }) => (
                      <Marker
                        key={point.day}
                        shape={series.marker}
                        x={x(index)}
                        y={y(Number(point.value))}
                        token={series.token}
                        size={2.2}
                      />
                    ))
                  : null}
                {visible.length <= 2 ? (
                  <g>
                    <circle
                      cx={x(peak.index)}
                      cy={y(Number(peak.point.value))}
                      r="4.5"
                      className="fill-card"
                      stroke={cssVar(series.token)}
                      strokeWidth="2"
                    />
                    <text
                      x={x(peak.index)}
                      y={y(Number(peak.point.value)) - 9}
                      textAnchor="middle"
                      className="font-mono text-[10.5px] font-medium"
                      fill={cssVar(series.token)}
                    >
                      peak {peak.point.formatted}
                    </text>
                  </g>
                ) : null}
                <text
                  x={x(last.index) + 8}
                  y={y(Number(last.point.value)) + 3.5}
                  className="font-mono text-[10.5px]"
                  fill={cssVar(series.token)}
                >
                  {series.label.length > 14
                    ? `${series.label.slice(0, 13)}…`
                    : series.label}
                </text>
                {shown !== null &&
                shownDay !== null &&
                pointOn(series.points, shownDay) ? (
                  <Marker
                    shape={series.marker}
                    x={x(shown)}
                    y={y(Number(pointOn(series.points, shownDay)!.value))}
                    token={series.token}
                    size={4.5}
                    ring
                  />
                ) : null}
              </g>
            )
          })}
        </svg>

        {shown !== null && shownDay !== null ? (
          <div
            data-slot="trend-readout"
            role="status"
            className="pointer-events-none absolute top-2 w-52 rounded-lg border border-border bg-popover p-2.5 text-xs shadow-md"
            style={
              x(shown) / W > 0.55
                ? {
                    right: `calc(${(100 - (x(shown) / W) * 100).toFixed(2)}% + 12px)`,
                  }
                : { left: `calc(${((x(shown) / W) * 100).toFixed(2)}% + 12px)` }
            }
          >
            <p className="mb-1.5 flex justify-between gap-2 font-mono text-muted-foreground">
              <span>{longDay(shownDay)}</span>
              {pinned !== null && hover === null ? (
                <span className="font-sans">pinned</span>
              ) : null}
            </p>
            <ul className="flex flex-col gap-1">
              {visible.map((series) => {
                const point = pointOn(series.points, shownDay)
                return (
                  <li
                    key={series.key}
                    className="grid grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-2"
                  >
                    <span
                      className="size-2 rounded-[2px]"
                      style={{ background: cssVar(series.token) }}
                    />
                    <span className="truncate font-mono text-muted-foreground">
                      {series.label}
                    </span>
                    <span
                      className={cn(
                        "rounded-[3px] px-1 font-mono font-medium",
                        point === undefined
                          ? "text-muted-foreground"
                          : series.source === "live"
                            ? "border border-dashed border-input bg-muted text-foreground"
                            : "bg-(--status-verified-soft) text-(--status-verified)"
                      )}
                    >
                      {point?.formatted ?? "no data"}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </ChartFrame>
  )
}

/** One marker, centred on `(x, y)`: the third channel, after colour and dash. */
export function Marker({
  shape,
  x,
  y,
  token,
  size,
  ring = false,
}: Readonly<{
  shape: MarkerShape
  x: number
  y: number
  token: string
  size: number
  ring?: boolean
}>) {
  const fill = cssVar(token)
  const stroke = ring ? "var(--card)" : "none"
  const strokeWidth = ring ? 2 : 0
  switch (shape) {
    case "square":
      return (
        <rect
          x={x - size}
          y={y - size}
          width={size * 2}
          height={size * 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      )
    case "triangle":
      return (
        <path
          d={`M${x} ${y - size * 1.2}L${x + size * 1.1} ${y + size * 0.8}L${x - size * 1.1} ${y + size * 0.8}Z`}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      )
    case "diamond":
      return (
        <path
          d={`M${x} ${y - size * 1.3}L${x + size * 1.3} ${y}L${x} ${y + size * 1.3}L${x - size * 1.3} ${y}Z`}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      )
    case "cross":
      return (
        <path
          d={`M${x - size} ${y - size}L${x + size} ${y + size}M${x + size} ${y - size}L${x - size} ${y + size}`}
          stroke={fill}
          strokeWidth={Math.max(1.5, size / 1.5)}
        />
      )
    default:
      return (
        <circle
          cx={x}
          cy={y}
          r={size}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      )
  }
}
