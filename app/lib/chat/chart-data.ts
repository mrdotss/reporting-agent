import type {
  ChatChart,
  ChatChartPoint,
  ChatTrendChart,
} from "@/lib/chat/views"

/**
 * What an answer chart is drawn from, worked out in one pure place.
 *
 * Every value a chart prints is a string the runtime formatted; this module only decides
 * where things go — which facts a chart holds, which days its axis spans, where the ticks of
 * its scale fall — and writes the CSV a person downloads, which carries the runtime's own
 * decimal strings, never a number computed here.
 */

/** The facts a chart draws, in the order it draws them. A legacy daily chart names none. */
export function chartFactIds(chart: ChatChart): string[] {
  switch (chart.kind) {
    case "compare":
      return chart.bars.map((bar) => bar.fact_id)
    case "trend":
      return chart.series.map((series) => series.fact_id)
    case "spread":
      return chart.rows.flatMap((row) => row.stats.map((stat) => stat.fact_id))
    case "stats":
      return chart.tiles.map((tile) => tile.fact_id)
    default:
      return []
  }
}

/** A legacy one-series daily chart, as a trend with no fact behind its line. */
export function asTrend(chart: ChatChart): ChatTrendChart | null {
  if (chart.kind === "trend") return chart
  if (chart.kind !== "daily") return null
  return {
    id: chart.id,
    kind: "trend",
    title: chart.title,
    unit: chart.unit,
    source: chart.source,
    series: [
      {
        fact_id: "",
        label: chart.series_label,
        source: chart.source === "live" ? "live" : "verified",
        points: chart.points,
      },
    ],
  }
}

/** Every day any series has, in order: the trend's x axis. */
export function trendDays(chart: ChatTrendChart): string[] {
  return [
    ...new Set(
      chart.series.flatMap((series) => series.points.map((point) => point.day))
    ),
  ].sort()
}

/** A series' point for a day, or `undefined` where it has none. */
export function pointOn(
  points: readonly ChatChartPoint[],
  day: string
): ChatChartPoint | undefined {
  return points.find((point) => point.day === day)
}

/** The top of a scale that starts at zero: a round number at or above `max`. */
export function niceCeil(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= max) return step * magnitude
  }
  return 10 * magnitude
}

/** Four evenly spaced ticks from zero to `top`, inclusive. */
export function ticks(top: number): number[] {
  return [0, 1, 2, 3, 4].map((index) => (top * index) / 4)
}

/** A tick's label: a scale mark, not a figure, so it is rounded for reading. */
export function tickLabel(value: number, unit: string): string {
  const text =
    value >= 1e9
      ? `${trim(value / 1e9)}G`
      : value >= 1e6
        ? `${trim(value / 1e6)}M`
        : value >= 1e3
          ? `${trim(value / 1e3)}k`
          : trim(value)
  return unit === "percent" ? `${text}%` : text
}

const BINARY_UNITS: readonly (readonly [string, number])[] = [
  ["TiB", 2 ** 40],
  ["GiB", 2 ** 30],
  ["MiB", 2 ** 20],
  ["KiB", 2 ** 10],
]

/** A value axis from zero: where it tops out, and how its marks read. */
export type ValueScale = {
  readonly top: number
  readonly label: (value: number) => string
}

/**
 * The scale for a chart's values. Bytes read in binary units — in GiB whenever the figures
 * themselves read in GiB, so the axis says what the chips say — and the top is a round number
 * of that unit. Percent tops out at 100% once a value passes 60%.
 */
export function valueScale(
  unit: string,
  max: number,
  formatted: readonly string[] = []
): ValueScale {
  if (unit === "bytes") {
    const pinned =
      formatted.length > 0 && formatted.every((text) => text.endsWith(" GiB"))
    const [suffix, factor] = pinned
      ? (["GiB", 2 ** 30] as const)
      : (BINARY_UNITS.find(([, size]) => max >= size) ?? (["B", 1] as const))
    const top = niceCeil(max / factor) * factor
    const decimals = stepDecimals(top / factor / 4)
    return {
      top,
      label: (value) =>
        `${String(Number((value / factor).toFixed(decimals)))} ${suffix}`,
    }
  }
  const top = unit === "percent" && max > 60 ? 100 : niceCeil(max)
  return { top, label: (value) => tickLabel(value, unit) }
}

/** The fewest decimals that spell a tick step exactly: `0.05` needs two, `2.5` one. */
function stepDecimals(step: number): number {
  for (let decimals = 0; decimals < 4; decimals++) {
    const scaled = step * 10 ** decimals
    if (Math.abs(Math.round(scaled) - scaled) < 1e-9) return decimals
  }
  return 4
}

/**
 * A label's resource named by its own name: an ARN or an Azure resource id reads as its last
 * field, so `arn:aws:rds:…:db:da-rds-postgres · FreeableMemory · avg` reads
 * `da-rds-postgres · FreeableMemory · avg`.
 */
export function resourceLabel(label: string): string {
  return label
    .split(" · ")
    .map((part) => {
      const trimmed = part.replace(/\/+$/, "")
      if (trimmed.startsWith("arn:"))
        return (
          (trimmed.includes("/")
            ? trimmed.slice(trimmed.lastIndexOf("/") + 1)
            : trimmed.slice(trimmed.lastIndexOf(":") + 1)) || part
        )
      if (/^\/subscriptions\//i.test(trimmed))
        return trimmed.slice(trimmed.lastIndexOf("/") + 1) || part
      return part
    })
    .join(" · ")
}

/** The chart with every resource label shortened by `resourceLabel`; its figures untouched. */
export function withResourceLabels(chart: ChatChart): ChatChart {
  switch (chart.kind) {
    case "compare":
      return {
        ...chart,
        bars: chart.bars.map((bar) => ({
          ...bar,
          label: resourceLabel(bar.label),
        })),
      }
    case "daily":
      return { ...chart, series_label: resourceLabel(chart.series_label) }
    case "trend":
      return {
        ...chart,
        series: chart.series.map((series) => ({
          ...series,
          label: resourceLabel(series.label),
        })),
      }
    case "spread":
      return {
        ...chart,
        rows: chart.rows.map((row) => ({
          ...row,
          label: resourceLabel(row.label),
        })),
      }
    case "stats":
      return {
        ...chart,
        tiles: chart.tiles.map((tile) => ({
          ...tile,
          label: resourceLabel(tile.label),
        })),
      }
    default:
      return chart
  }
}

function trim(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(value < 10 ? 1 : 0)
}

/** `1 Aug` from `2026-08-01`. */
export function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date)
}

/** `Thu 20 Aug 2026` from `2026-08-20`. */
export function longDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}

function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The chart's figures as CSV: the runtime's decimal strings under a header naming each
 * column's unit and whether it is verified or live. `null` for a chart with nothing tabular.
 */
export function chartCsv(chart: ChatChart): string | null {
  const rows: string[][] = []
  const unitOf = (unit: string) => (unit === "percent" ? "%" : unit)
  const trend = asTrend(chart)
  if (trend !== null) {
    const days = trendDays(trend)
    rows.push([
      "day",
      ...trend.series.map(
        (s) => `${s.label} (${unitOf(trend.unit)}, ${s.source})`
      ),
    ])
    for (const day of days)
      rows.push([
        day,
        ...trend.series.map((s) => pointOn(s.points, day)?.value ?? ""),
      ])
  } else if (chart.kind === "compare") {
    rows.push(["label", `value (${unitOf(chart.unit)})`, "source"])
    for (const bar of chart.bars)
      rows.push([
        bar.label,
        bar.value,
        bar.source ?? (chart.source === "mixed" ? "" : chart.source),
      ])
  } else if (chart.kind === "spread") {
    rows.push([
      "machine",
      "statistic",
      `value (${unitOf(chart.unit)})`,
      "source",
    ])
    for (const row of chart.rows)
      for (const stat of row.stats)
        rows.push([row.label, stat.statistic, stat.value, row.source])
  } else {
    return null
  }
  return rows.map((row) => row.map(cell).join(",")).join("\n") + "\n"
}

/** A file name for a chart's CSV: its title, lower-case, words joined by dashes. */
export function csvName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return `${slug || "chart"}.csv`
}

/** The mark for a statistic in a spread: average hollow, a percentile filled, the extremes a tick. */
export function statMark(
  statistic: string
): "hollow" | "filled" | "tick" | "diamond" {
  const name = statistic.toLowerCase()
  if (name === "avg" || name === "average" || name === "mean") return "hollow"
  if (/^p\d{1,2}$/.test(name) || name.includes("percentile")) return "filled"
  if (
    name === "max" ||
    name === "maximum" ||
    name === "min" ||
    name === "minimum"
  )
    return "tick"
  return "diamond"
}
