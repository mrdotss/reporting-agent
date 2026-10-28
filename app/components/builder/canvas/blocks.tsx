"use client"

import { init } from "echarts"
import { useId, useMemo, useSyncExternalStore, type CSSProperties, type ReactNode } from "react"

import {
  renderSVG,
  type ReportChartSpec,
} from "../../../../agent/chart-renderer/svg.mjs"
import { useCanvasData, useSectionResources } from "@/components/builder/context"
import {
  columnLabel,
  declaredColumns,
  sectionTitle,
  type CatalogueExpansion,
  type CatalogueSection,
  type Language,
  type Provider,
} from "@/lib/builder/catalogue"
import {
  avgAndPeakMetric,
  rankingOf,
  weekMetricOf,
  type AddedEntry,
  type BlockStyle,
  type MetricItem,
  type SectionV4,
  type SlotEntry,
} from "@/lib/builder/model"
import { readsMetrics } from "@/lib/builder/fit"
import { FLEET_MIX_SEGMENTS, fleetMix } from "@/lib/builder/fleet-mix"
import { friendlyLabel, friendlyMetric } from "@/lib/builder/metric-names"
import type { AgentTry } from "@/lib/builder/store"
import {
  byFigure,
  figureOf,
  formatFigure,
  formatSample,
  periodFigures,
  sampleCell,
  sampleMetricSeries,
  seriesKey,
  sampleUnit,
  type SampleResource,
  type SampleUnit,
} from "@/lib/builder/sample"
import { ATTENTION, DENSITY_SCALE, MARK, PT, TEXT_SIZE_FACTORS, tint, type PageDesign } from "@/lib/builder/theme"
import { messageText, type MessageId } from "@/lib/messages/catalog"

import { AGENT_REASONS } from "./labels"

/**
 * One catalogue block drawn the way the report prints it, over the sample.
 *
 * Drawn from the block's own catalogue config — its declared columns, its heading level,
 * its layout — and the section's own metrics, so what changes in the inspector changes
 * here. The figures are the sample's; `canvas.tsx` labels the page so.
 */

export type BlockViewProps = {
  readonly provider: Provider
  readonly design: PageDesign
  readonly language: Language
  readonly entry: CatalogueSection
  readonly expansion: CatalogueExpansion
  readonly section: SectionV4
  readonly settings: SlotEntry
  readonly number: number
  readonly resource?: SampleResource
}

function t(id: string, language: Language, fallback: string, params?: Record<string, string | number>): string {
  return messageText(id as MessageId, language, params) ?? fallback
}

function px(pt: number): string {
  return `${(pt * PT).toFixed(2)}px`
}

function metricLabel(item: MetricItem): string {
  return item.metric ?? item.derived ?? "metric"
}

function statisticLabel(statistic: string, language: Language): string {
  if (statistic === "avg") return t("doc.summary.avg", language, "Average")
  if (statistic === "max") return t("doc.summary.max", language, "Peak")
  if (statistic === "min") return t("doc.summary.min", language, "Minimum")
  if (statistic === "p95") return t("doc.summary.p95", language, "P95 (est.)")
  return statistic
}

// --- Shared pieces ------------------------------------------------------------------

/** A value longer than this may break inside a word, so one long token cannot widen its table. */
const LONG_TOKEN_CHARS = 24

/**
 * A table drawn as the theme draws it, with the design's look — header, rows, marked values —
 * or a block's own (`own`) where it has one.
 */
function Table({
  design,
  head,
  rows,
  numeric = [],
  own,
}: Readonly<{
  design: PageDesign
  head: readonly string[]
  rows: readonly (readonly ReactNode[])[]
  numeric?: readonly number[]
  own?: BlockStyle
}>) {
  const { spec, density, look } = design
  const tableStyle = (own?.rows ?? design.tableStyle) as PageDesign["tableStyle"]
  const header = own?.header ?? look.tableHeader
  const mark = own?.mark_at_or_above ?? look.markAtOrAbove
  const scale = DENSITY_SCALE[density]
  const size = (spec.smallPt + 0.5) * TEXT_SIZE_FACTORS[look.textSize]
  const hair = `0.75px solid ${spec.rule}`
  const open = tableStyle === "open"
  const cell = (index: number, rowIndex?: number): CSSProperties => ({
    padding: `${(open ? 6 : 4) * scale}px 8px`,
    textAlign: numeric.includes(index) ? "right" : "left",
    fontVariantNumeric: "tabular-nums",
    fontFamily: numeric.includes(index) && rowIndex !== undefined ? design.figureFace : undefined,
    borderTop: tableStyle === "bordered" ? hair : "none",
    borderLeft: tableStyle === "bordered" ? hair : "none",
    borderRight: tableStyle === "bordered" ? hair : "none",
    borderBottom: tableStyle === "banded" || open ? "none" : hair,
    background: tableStyle === "banded" && rowIndex !== undefined && rowIndex % 2 === 1 ? spec.band : "transparent",
  })
  const headLook: CSSProperties =
    header === "tint"
      ? { background: tint(spec.accent, 0.86), color: spec.ink, borderBottom: "none" }
      : header === "solid"
        ? { background: spec.accent, color: "#fff", borderBottom: "none" }
        : header === "plain"
          ? { color: spec.ink, borderBottom: hair }
          : { color: spec.ink, borderBottom: `1.5px solid ${spec.accent}` }
  // Marked as the runtime marks: a percentage at or above the setting, colour only.
  const marked = (value: ReactNode, index: number) =>
    mark !== null &&
    numeric.includes(index) &&
    typeof value === "string" &&
    value.endsWith("%") &&
    Number.parseFloat(value) >= mark
  return (
    // Headers wrap at their spaces, so a table with many columns (RDS's eight) narrows to its
    // longest words and stays inside the page frame. A long unbroken value (an ARM id) may
    // break anywhere, or it alone would push the table past the page; a short resource name
    // stays on one line.
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: px(size), overflowWrap: "break-word" }}>
      <thead>
        <tr>
          {head.map((label, index) => (
            <th key={`${label}-${index}`} style={{ ...cell(index), fontWeight: 700, fontFamily: spec.headingFace, ...headLook }}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((value, index) => (
              <td
                key={index}
                style={{
                  ...cell(index, rowIndex),
                  ...(typeof value === "string"
                    ? value.length > LONG_TOKEN_CHARS
                      ? { overflowWrap: "anywhere" }
                      : index === 0
                        ? { whiteSpace: "nowrap" }
                        : {}
                    : {}),
                  ...(marked(value, index) ? { background: MARK.fill, color: MARK.ink, fontWeight: 700 } : {}),
                }}
              >
                {value}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Caption({ design, children }: Readonly<{ design: PageDesign; children: ReactNode }>) {
  return (
    <p style={{ margin: "0 0 6px", fontSize: px(design.spec.smallPt), color: design.spec.muted }}>
      {children}
    </p>
  )
}

/** What sits under a section heading, per `ThemeSpec.headingRule` — the Word file's rule. */
function sectionRule(spec: PageDesign["spec"]): string | undefined {
  switch (spec.headingRule) {
    case "double":
      return `3px double ${spec.accent}`
    case "line":
      return `1px solid ${spec.accent}`
    case "none":
      return undefined
    default:
      return `1px solid ${spec.rule}`
  }
}

function Heading({
  design,
  level,
  children,
  number,
}: Readonly<{ design: PageDesign; level: 1 | 2 | 3 | 4; children: ReactNode; number?: number }>) {
  const { spec } = design
  const size = spec.headingPt[level - 1]! * TEXT_SIZE_FACTORS[design.look.textSize]
  const caps = spec.headingAllCaps && level >= 3
  const display = design.look.sectionNumbers === "display" && level === 1 && number !== undefined
  const numbered = number !== undefined && design.look.sectionNumbers !== "none"
  const rule = level === 1 ? sectionRule(spec) : undefined
  return (
    <div
      role="heading"
      aria-level={level + 1}
      style={{
        fontFamily: spec.headingFace,
        fontSize: px(size),
        fontWeight: 700,
        color: level === 1 && design.look.headingColor === "accent" ? spec.accent : spec.ink,
        letterSpacing: caps ? "0.06em" : level === 1 ? "-0.005em" : undefined,
        textTransform: caps ? "uppercase" : undefined,
        lineHeight: 1.2,
        display: "flex",
        flexDirection: display ? "column" : "row",
        alignItems: display ? "flex-start" : "baseline",
        gap: display ? 4 : 10,
        paddingBottom: rule ? 6 : 0,
        borderBottom: rule,
      }}
    >
      {numbered &&
        (display ? (
          // `signal`: the number on its own line, large and in the accent.
          <span
            style={{
              fontSize: px(size * 2.6),
              fontWeight: 900,
              lineHeight: 0.85,
              letterSpacing: "-0.05em",
              color: spec.accent,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {number}
          </span>
        ) : (
          <span style={{ color: spec.muted, fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>
            {String(number).padStart(2, "0")}
          </span>
        ))}
      <span>{children}</span>
    </div>
  )
}

/**
 * An axis maximum the four gridlines divide evenly, as the runtime's own scales do: 1, 2,
 * 2.5 or 5 times a power of ten per step. A percentage never runs past 100.
 */
const subscribeNever = () => () => {}

function niceMax(value: number, unit: SampleUnit): number {
  const top = Math.max(value, 1e-6) * 1.08
  const raw = top / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw)!
  const max = step * 4
  return unit === "percent" ? Math.min(100, max) : max
}

function SampleChart({
  design,
  series,
  categories,
  unit,
  height = 190,
  type = "line",
  style,
  panelLabel,
  own,
  markers,
  defaultThreshold,
}: Readonly<{
  design: PageDesign
  series: readonly { label: string; values: readonly number[]; dashed?: boolean }[]
  categories: readonly string[]
  unit: SampleUnit
  height?: number
  type?: "line" | "heatmap" | "dumbbell"
  /** An annotated line's incident markers, on categories it plots. */
  markers?: readonly { x: string; label: string }[]
  /** The threshold drawn where neither the block nor the design sets one — an annotated line's 80. */
  defaultThreshold?: number
  /** A chart slot's own look, over the design's. */
  own?: BlockStyle
  /** A style this chart draws in whatever the document's is — a sparkline table's. */
  style?: PageDesign["chartStyle"]
  /** A heatmap's title: the metric its colour scale reads. */
  panelLabel?: string
}>) {
  const { spec, chartFace, look } = design
  const chartStyle = style ?? own?.look ?? design.chartStyle
  const values = own?.values ?? look.chartValues
  const threshold = own?.threshold ?? look.chartThreshold ?? defaultThreshold ?? null
  const heightScale = own?.height === "short" ? 0.75 : own?.height === "tall" ? 1.3 : 1
  // ECharts numbers its clip paths per instance, so two charts on one page would share ids.
  const prefix = `builder${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const svg = useMemo(() => {
    const dumbbell = type === "dumbbell"
    // A dumbbell's average and peak share one scale, as the runtime draws it.
    const split =
      !dumbbell &&
      (chartStyle === "stacked" || chartStyle === "sparkline" || chartStyle === "small_multiples") &&
      series.length > 1
    // The runtime's look keys: present only where they leave the default, as there.
    const legend = look.chartLegend === "line_ends" ? undefined : look.chartLegend
    const options = {
      ...(look.chartLine !== "regular" ? { lineWidth: look.chartLine === "thin" ? 1.4 : 3.2 } : {}),
      ...(look.chartGrid === "light" ? {} : { gridLines: look.chartGrid }),
      ...(values === "last" ? {} : { values }),
      ...(legend ? { legend } : {}),
      ...(threshold !== null && unit === "percent" ? { threshold, thresholdLabel: t("doc.chart.threshold", "en", "Threshold") } : {}),
    }
    const palette = (index: number) =>
      look.chartPalette === "shades"
        ? tint(spec.accent, [0, 0.32, 0.5, 0.64, 0.75][Math.min(index, 4)]!)
        : look.chartPalette === "greys" && index > 0
          ? ["#6F747C", "#9599A0", "#B5B8BD", "#CFD1D4"][Math.min(index - 1, 3)]!
          : spec.accent
    const max = niceMax(Math.max(...series.flatMap((s) => s.values)), unit)
    const heatmap = type === "heatmap"
    const all = series.flatMap((s) => s.values)
    const base = heatmap
      ? Math.max(140, 30 * series.length + 80)
      : dumbbell
        ? Math.max(140, 64 + 26 * categories.length)
        : chartStyle === "sparkline"
          ? Math.max(100, series.length * 70 + 20)
          : split
            ? Math.max(height, series.length * 115 + 30)
            : height
    const chartSpec: ReportChartSpec = {
      ...options,
      style: heatmap ? "heatmap" : chartStyle,
      type,
      width: 640,
      height: Math.round(base * heightScale) + (legend && !heatmap && !dumbbell ? 24 : 0),
      font: chartFace.split(",")[0]!.replaceAll('"', ""),
      ink: spec.ink,
      muted: spec.muted,
      rule: spec.rule,
      emptyLabel: "",
      categories: [...categories],
      panels: heatmap
        ? [{ label: panelLabel ?? "", unit, min: Math.min(...all), max: Math.max(...all) }]
        : (split ? series : series.slice(0, 1)).map((s) => ({
            label: s.label,
            unit,
            min: 0,
            max: split ? niceMax(Math.max(...s.values), unit) : max,
          })),
      series: series.map((s, index) => ({
        key: s.label,
        label: s.label,
        last: formatSample(s.values.at(-1) ?? 0, unit),
        panel: split ? index : 0,
        color: dumbbell ? (index === 0 ? tint(spec.accent, 0.55) : spec.accent) : palette(split ? 0 : index),
        dashed: chartStyle === "sparkline" || dumbbell ? false : (s.dashed ?? index > 0),
        values: s.values.map(String),
        pointLabels: s.values.map((v) => formatSample(v, unit)),
      })),
      bands: chartStyle === "range_band" && series.length > 1 ? [{ lower: 1, upper: 0 }] : [],
      ...(markers?.length ? { markers: [...markers] } : {}),
    }
    return renderSVG(chartSpec, false, init)
      .replace(/zr\d+/g, prefix)
      .replace(/<svg /, '<svg style="width:100%;height:auto;display:block" ')
  }, [categories, chartFace, chartStyle, height, heightScale, look, markers, panelLabel, prefix, series, spec.accent, spec.ink, spec.muted, spec.rule, threshold, type, unit, values])
  // The chart renderer's own SVG, the same drawing the runtime embeds in the report. Drawn
  // in the browser only: ECharts measures text, and the server's measurements differ from
  // the browser's, so a server-drawn chart would never match the one that hydrates it.
  const inBrowser = useSyncExternalStore(subscribeNever, () => true, () => false)
  if (!inBrowser) return <div aria-hidden style={{ aspectRatio: "640 / 190", width: "100%" }} />
  return <div dangerouslySetInnerHTML={{ __html: svg }} />
}

/**
 * A chart of one row per category — a bar list, a bullet, a fleet mix — from the spec the
 * runtime sends the same renderer (`render/echarts.py::_row_chart_spec`): its colours, its
 * row heights and its scale.
 */
function RowChart({
  design,
  title,
  type,
  categories,
  series,
  unit,
  legendText,
}: Readonly<{
  design: PageDesign
  /** Drawn inside the chart, as the runtime draws a chart's title; the caption goes below. */
  title: string
  type: "bar_list" | "bullet" | "mix"
  categories: readonly string[]
  series: readonly { key: string; label: string; values: readonly (number | null)[]; labels: readonly (string | null)[] }[]
  unit: SampleUnit | "count"
  /** A bullet's line of words saying which mark is which. */
  legendText?: string
}>) {
  const { spec, chartFace, look } = design
  const prefix = `builder${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  // A bullet always draws its line: the design's, else the runtime's default.
  const threshold = look.chartThreshold ?? (type === "bullet" ? DEFAULT_THRESHOLD : null)
  const svg = useMemo(() => {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
    const top = Math.max(0, ...all)
    const max =
      type === "mix" ? 1 : unit === "percent" && top > 1 && top <= 100 ? 100 : top > 0 ? niceCeiling(top * 1.1) : 1
    // The runtime's colours (`render/echarts.py::_row_chart_spec`).
    const color = (key: string, index: number) =>
      type === "bullet"
        ? [spec.accent, tint(spec.accent, 0.72), spec.ink][Math.min(index, 2)]!
        : type === "mix"
          ? key === "stopped"
            ? MIX_STOPPED_INK
            : key === "other"
              ? "#B5B8BD"
              : tint(spec.accent, [0, 0.32, 0.72, 0.82, 0.88][Math.min(index, 4)]!)
          : spec.accent
    const rows = categories.length
    const height = { bar_list: 44 + 36 * rows, bullet: 72 + 28 * rows, mix: 36 + 64 * rows }[type]
    const chartSpec: ReportChartSpec = {
      ...(type === "bullet" && threshold !== null && unit === "percent"
        ? { threshold, thresholdLabel: t("doc.chart.threshold", "en", "Threshold"), ...(legendText ? { legendText } : {}) }
        : {}),
      style: type,
      type,
      width: 640,
      height: Math.min(1100, height),
      font: chartFace.split(",")[0]!.replaceAll('"', ""),
      mono: monoOf(design),
      accent: spec.accent,
      ink: spec.ink,
      muted: spec.muted,
      rule: spec.rule,
      emptyLabel: "",
      categories: [...categories],
      panels: [{ label: title, unit, min: 0, max }],
      series: series.map((s, index) => ({
        key: s.key,
        // A fleet mix's legend reads as a sentence: "14 general purpose".
        label: type === "mix" && !/^.[A-Z]/.test(s.label) ? s.label.slice(0, 1).toLowerCase() + s.label.slice(1) : s.label,
        last: s.labels.at(-1) ?? "",
        panel: 0,
        color: color(s.key, index),
        dashed: false,
        values: s.values.map((v) => (v === null ? null : String(v))),
        pointLabels: [...s.labels],
        ...(type === "bar_list" ? { shades: categories.map((_, row) => tint(spec.accent, Math.min(0.3 + 0.12 * row, 0.72))) } : {}),
      })),
    }
    return renderSVG(chartSpec, false, init)
      .replace(/zr\d+/g, prefix)
      .replace(/<svg /, '<svg style="width:100%;height:auto;display:block" ')
  }, [categories, chartFace, design, legendText, prefix, series, spec.accent, spec.ink, spec.muted, spec.rule, threshold, title, type, unit])
  const inBrowser = useSyncExternalStore(subscribeNever, () => true, () => false)
  if (!inBrowser) return <div aria-hidden style={{ aspectRatio: "640 / 160", width: "100%" }} />
  return <div dangerouslySetInnerHTML={{ __html: svg }} />
}

/**
 * Small multiples from the spec the runtime sends the renderer (`render/echarts.py::_multiples_spec`):
 * one panel per resource on one shared scale, four to a row past four panels.
 */
function MultiplesChart({
  design,
  title,
  series,
  categories,
  unit,
}: Readonly<{
  design: PageDesign
  title: string
  series: readonly { label: string; values: readonly number[] }[]
  categories: readonly string[]
  unit: SampleUnit
}>) {
  const { spec, chartFace } = design
  const prefix = `builder${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const svg = useMemo(() => {
    const top = Math.max(0, ...series.flatMap((s) => s.values))
    const max = unit === "percent" && top > 1 && top <= 100 ? 100 : top > 0 ? niceCeiling(top * 1.1) : 1
    const columns = series.length > 4 ? 4 : Math.max(1, Math.min(series.length, 2))
    const rows = Math.max(1, Math.ceil(series.length / columns))
    const chartSpec: ReportChartSpec = {
      style: "multiples",
      type: "multiples",
      width: 640,
      height: Math.min(1100, 40 + 104 * rows),
      columns,
      font: chartFace.split(",")[0]!.replaceAll('"', ""),
      mono: monoOf(design),
      accent: spec.accent,
      ...(unit === "percent" ? { threshold: design.look.chartThreshold ?? DEFAULT_THRESHOLD } : {}),
      ink: spec.ink,
      muted: spec.muted,
      rule: spec.rule,
      emptyLabel: "",
      categories: [...categories],
      panels: [{ label: title, unit, min: 0, max }],
      series: series.map((s) => ({
        key: s.label,
        label: s.label,
        last: formatSample(s.values.at(-1) ?? 0, unit),
        panel: 0,
        color: spec.accent,
        dashed: false,
        values: s.values.map(String),
        pointLabels: s.values.map((v) => formatSample(v, unit)),
      })),
    }
    return renderSVG(chartSpec, false, init)
      .replace(/zr\d+/g, prefix)
      .replace(/<svg /, '<svg style="width:100%;height:auto;display:block" ')
  }, [categories, chartFace, design, prefix, series, spec.accent, spec.ink, spec.muted, spec.rule, title, unit])
  const inBrowser = useSyncExternalStore(subscribeNever, () => true, () => false)
  if (!inBrowser) return <div aria-hidden style={{ aspectRatio: "640 / 240", width: "100%" }} />
  return <div dangerouslySetInnerHTML={{ __html: svg }} />
}

/** The line a bullet, small multiples and an annotated line draw where the design sets none. */
const DEFAULT_THRESHOLD = 80

/** The fleet mix's stopped part, `render/echarts.py::MIX_STOPPED_INK`. */
const MIX_STOPPED_INK = "#E8B4A0"

/** The face resource names are set in inside a chart: the theme's figure face. */
function monoOf(design: PageDesign): string {
  return /plex/i.test(design.figureFace) ? "IBM Plex Mono" : "DejaVu Sans Mono"
}

/**
 * The hour-of-week heatmap from the spec the runtime sends (`render/echarts.py::_heatmap_spec`
 * for a `week` chart): seven rows of 24 rounded cells, a line of words for its scale.
 */
function WeekChart({
  design,
  title,
  rows,
  unit,
  legendText,
}: Readonly<{
  design: PageDesign
  title: string
  rows: readonly { label: string; values: readonly (number | null)[] }[]
  unit: SampleUnit
  legendText: string
}>) {
  const { spec, chartFace } = design
  const prefix = `builder${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const svg = useMemo(() => {
    const all = rows.flatMap((row) => row.values.filter((v): v is number => v !== null))
    const chartSpec: ReportChartSpec = {
      style: "heatmap",
      type: "heatmap",
      week: true,
      legendText,
      width: 640,
      height: 26 * rows.length + 70,
      font: chartFace.split(",")[0]!.replaceAll('"', ""),
      accent: spec.accent,
      ink: spec.ink,
      muted: spec.muted,
      rule: spec.rule,
      emptyLabel: "",
      categories: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`),
      panels: [{ label: title, unit, min: all.length ? Math.min(...all) : 0, max: all.length ? Math.max(...all) : 1 }],
      series: rows.map((row) => ({
        key: row.label,
        label: row.label,
        last: "",
        panel: 0,
        color: spec.accent,
        dashed: false,
        values: row.values.map((v) => (v === null ? null : String(v))),
      })),
    }
    return renderSVG(chartSpec, false, init)
      .replace(/zr\d+/g, prefix)
      .replace(/<svg /, '<svg style="width:100%;height:auto;display:block" ')
  }, [chartFace, legendText, prefix, rows, spec.accent, spec.ink, spec.muted, spec.rule, title, unit])
  const inBrowser = useSyncExternalStore(subscribeNever, () => true, () => false)
  if (!inBrowser) return <div aria-hidden style={{ aspectRatio: "640 / 250", width: "100%" }} />
  return <div dangerouslySetInnerHTML={{ __html: svg }} />
}

/** The days a backup strip draws: the period's last 31, or a sample month's 30. */
function stripDays(period: { readonly start: string; readonly end: string } | undefined): string[] {
  const end = period ? new Date(`${period.end}T00:00:00Z`) : new Date(Date.UTC(2026, 8, 30))
  const start = period ? new Date(`${period.start}T00:00:00Z`) : new Date(Date.UTC(2026, 8, 1))
  const days: string[] = []
  for (let day = new Date(end); day >= start && days.length < 31; day.setUTCDate(day.getUTCDate() - 1)) {
    days.unshift(day.toISOString().slice(0, 10))
  }
  return days
}

/**
 * The days a `recovery_point_days` fact names (`2026-09 1-14,~15`), `true` for a complete
 * recovery point and `false` for a partial one: `compile/blocks/backup.py::recovery_days`.
 */
function recoveryDays(text: string): Map<string, boolean> {
  const days = new Map<string, boolean>()
  for (const group of text.split(";")) {
    const match = /^(\d{4})-(\d{2}) (.+)$/.exec(group.trim())
    if (!match) continue
    for (const raw of match[3]!.split(",")) {
      const part = raw.trim()
      const [first, last] = part.replace(/^~/, "").split("-")
      const start = Number(first)
      const end = Number(last ?? first)
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue
      for (let day = start; day <= end; day += 1) {
        days.set(`${match[1]}-${match[2]}-${String(day).padStart(2, "0")}`, !part.startsWith("~"))
      }
    }
  }
  return days
}

/** The runtime's scale for a row chart: one significant step above the value. */
function niceCeiling(value: number): number {
  const step = 10 ** Math.floor(Math.log10(value))
  return Math.ceil(value / step) * step
}

/**
 * KPI tiles drawn by the runtime's renderer from the spec it sends (`render/echarts.py::_tiles_spec`):
 * each tile's name, figure, change since the previous report, resource and days.
 */
function KpiTiles({
  design,
  title,
  subtitle,
  tiles,
}: Readonly<{
  design: PageDesign
  title: string
  subtitle: string
  tiles: NonNullable<ReportChartSpec["tiles"]>
}>) {
  const { spec, chartFace } = design
  const prefix = `builder${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const svg = useMemo(() => {
    const chartSpec: ReportChartSpec = {
      style: "tiles",
      type: "tiles",
      width: 640,
      height: 172,
      font: chartFace.split(",")[0]!.replaceAll('"', ""),
      accent: spec.accent,
      ink: spec.ink,
      muted: spec.muted,
      rule: spec.rule,
      emptyLabel: "",
      title,
      subtitle,
      tiles: [...tiles],
      categories: [],
      panels: [],
      series: [],
    }
    return renderSVG(chartSpec, false, init)
      .replace(/zr\d+/g, prefix)
      .replace(/<svg /, '<svg style="width:100%;height:auto;display:block" ')
  }, [chartFace, prefix, spec.accent, spec.ink, spec.muted, spec.rule, subtitle, tiles, title])
  const inBrowser = useSyncExternalStore(subscribeNever, () => true, () => false)
  if (!inBrowser) return <div aria-hidden style={{ aspectRatio: "640 / 172", width: "100%" }} />
  return <div dangerouslySetInnerHTML={{ __html: svg }} />
}

function Narrative({ design, language, children }: Readonly<{ design: PageDesign; language: Language; children: ReactNode }>) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <p style={{ margin: 0, color: design.spec.ink }}>{children}</p>
      <span
        style={{
          fontFamily: "var(--font-sans), system-ui, sans-serif",
          fontSize: 10.5,
          color: "#8a8b91",
          letterSpacing: "0.02em",
        }}
      >
        {language === "id"
          ? "Ditulis saat laporan dibuat, dari angka yang terverifikasi."
          : "Written when the report runs, from verified figures only."}
      </span>
    </div>
  )
}

// --- Block views ---------------------------------------------------------------------

function columnsFor(expansion: CatalogueExpansion, settings: SlotEntry) {
  const declared = declaredColumns(expansion)
  if (!settings.columns) return declared
  return settings.columns.flatMap((id) => declared.filter((column) => column.id === id))
}

/** Where the chosen report holds none of the resources a block draws. Builder chrome, not print. */
function NoResources({ language }: Readonly<{ language: Language }>) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-2 font-sans text-[12px] text-muted-foreground">
      {language === "id"
        ? "Laporan yang dipilih tidak memuat sumber daya untuk blok ini."
        : "The chosen report holds no resources for this block."}
    </p>
  )
}

function ResourceTableView(props: BlockViewProps) {
  const { design, language, expansion, settings, resource } = props
  const columns = columnsFor(expansion, settings)
  const resources = useSectionResources(props.section)
  const layout = expansion.config.layout
  if (expansion.per === "resource" && layout === "pairs" && resource) {
    return (
      <Table
        design={design}
        head={[t("doc.table.field", language, "Field"), t("doc.table.value", language, "Value")]}
        rows={columns.map((column) => [columnLabel(column, language), sampleCell(resource, column.id)])}
        own={settings.style}
      />
    )
  }
  if (columns.length === 0) {
    // A table whose columns come from the section's metrics, not the catalogue.
    const metrics = props.section.metrics ?? []
    return (
      <Table
        design={design}
        head={[t("doc.table.resource", language, "Resource"), ...metrics.map((m) => `${metricLabel(m)} (${m.statistic})`)]}
        rows={(resource ? [resource] : resources).map((r) => [
          r.name,
          ...metrics.map((m) => formatFigure(figureOf(r, metricLabel(m), m.statistic), sampleUnit(metricLabel(m)))),
        ])}
        numeric={metrics.map((_, index) => index + 1)}
        own={settings.style}
      />
    )
  }
  const shown = columns.filter((column) => column.id !== "resource_name")
  return (
    <Table
      design={design}
      head={[t("doc.table.resource", language, "Resource"), ...shown.map((c) => columnLabel(c, language))]}
      rows={(resource ? [resource] : resources).map((r) => [r.name, ...shown.map((c) => sampleCell(r, c.id))])}
      own={settings.style}
    />
  )
}

function ChartView(props: BlockViewProps) {
  const { design, language, section, resource } = props
  const resources = useSectionResources(section)
  const target = resource ?? resources[0]
  if (!target) return <NoResources language={language} />
  const all = section.metrics ?? []
  // One chart holds one unit, as the runtime splits unlike metrics into separate figures.
  const unit = sampleUnit(all[0] ? metricLabel(all[0]) : "CPU")
  const metrics = all.filter((item) => sampleUnit(metricLabel(item)) === unit).slice(0, 5)
  const series = (metrics.length > 0 ? metrics : [{ metric: "CPU", statistic: "avg" }]).map((item, index) => ({
    label: `${metricLabel(item)} · ${statisticLabel(item.statistic, language)}`,
    values: sampleMetricSeries(target, metricLabel(item), item.statistic),
    dashed: index > 0,
  }))
  const categories = series[0]!.values.map((_, index) => String(index + 1))
  const title = t("doc.chart.title.over_time", language, "Over time", {
    metrics: metrics.map(metricLabel).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "CPU",
  })
  return (
    <div>
      <Caption design={design}>{resource ? `${resource.name} — ${title}` : title}</Caption>
      <SampleChart design={design} series={series} categories={categories} unit={unit} own={props.settings.style} />
    </div>
  )
}

function MetricSummaryView(props: BlockViewProps) {
  const { design, language, section, resource } = props
  const resources = useSectionResources(section)
  const target = resource ?? resources[0]
  if (!target) return <NoResources language={language} />
  const names = (section.metrics ?? []).map(metricLabel).filter((v, i, a) => a.indexOf(v) === i)
  return (
    <Table
      design={design}
      head={[
        t("doc.table.metric", language, "Metric"),
        t("doc.summary.avg", language, "Average"),
        t("doc.summary.p95", language, "P95 (est.)"),
        t("doc.summary.max", language, "Peak"),
        t("doc.summary.peak_at", language, "Peak at"),
      ]}
      rows={(names.length ? names : ["CPU"]).map((name) => {
        const unit = sampleUnit(name)
        const figures = periodFigures(target, name)
        return [
          name,
          formatFigure(figures.avg, unit),
          formatFigure(figures.p95, unit),
          formatFigure(figures.peak, unit),
          // When the peak fell is the report's own; real figures here do not carry it.
          target.stats === undefined ? "14 Sep 10:00" : "–",
        ]
      })}
      numeric={[1, 2, 3]}
      own={props.settings.style}
    />
  )
}

function TopNView(props: BlockViewProps) {
  const { design, language, section } = props
  const metric = section.metrics?.[0]
  const name = metric ? metricLabel(metric) : "CPU"
  const ranked = [...useSectionResources(section)].sort(byFigure(name, "max"))
  return (
    <div>
      <Caption design={design}>{t("doc.section.fleet_summary", language, "Fleet summary")}</Caption>
      <Table
        design={design}
        head={[
          t("doc.table.resource", language, "Resource"),
          `${metric ? metricLabel(metric) : "CPU"} · ${t("doc.summary.avg", language, "Average")}`,
          `${metric ? metricLabel(metric) : "CPU"} · ${t("doc.summary.max", language, "Peak")}`,
        ]}
        rows={ranked.map((r) => [
          r.name,
          formatFigure(figureOf(r, name, "avg"), sampleUnit(name)),
          formatFigure(figureOf(r, name, "max"), sampleUnit(name)),
        ])}
        numeric={[1, 2]}
        own={props.settings.style}
      />
    </div>
  )
}

function InventoryView(props: BlockViewProps) {
  const { design, language, provider } = props
  const data = useCanvasData()
  const counts = data.counts
  const rows =
    provider === "aws"
      ? [
          [t("doc.inventory.account_id", language, "Account ID"), `•••• •••• ${data.scope.idTail}`],
          [t("doc.inventory.regions", language, "Regions"), data.scope.places.join(", ")],
          [t("doc.inventory.total_resources", language, "Total resources"), String(counts.resources)],
        ]
      : [
          [t("doc.inventory.subscription_id", language, "Subscription ID"), `•••••••-••••-${data.scope.idTail}`],
          [t("doc.inventory.resource_groups", language, "Resource groups"), data.scope.places.join(", ")],
          [t("doc.inventory.total_resources", language, "Total resources"), String(counts.resources)],
        ]
  return (
    <Table
      design={design}
      head={[t("doc.table.field", language, "Field"), t("doc.table.value", language, "Value")]}
      rows={rows}
      own={props.settings.style}
    />
  )
}

function TrendView(props: BlockViewProps) {
  const { design, language, section, resource } = props
  const months = Math.max(2, section.lookback ?? 3)
  const resources = useSectionResources(section)
  const target = resource ?? resources[0]
  if (!target) return <NoResources language={language} />
  const metric = section.metrics?.[0]
  // Real figures carry the report's own months; the sample draws a shape of the right length.
  const real = target.months?.[seriesKey(metric ? metricLabel(metric) : "", metric?.statistic ?? "avg")]?.slice(-months)
  const monthName = (date: Date) => date.toLocaleString(language === "id" ? "id-ID" : "en-GB", { month: "short" })
  const values = real
    ? real.map((entry) => entry.value)
    : Array.from({ length: months }, (_, index) => Number((target.avg * (0.7 + 0.3 * Math.sin(index + 1) ** 2)).toFixed(1)))
  const categories = real
    ? real.map((entry) => monthName(new Date(`${entry.month}-01T00:00:00`)))
    : Array.from({ length: months }, (_, index) => monthName(new Date(2026, 8 - (months - 1 - index), 1)))
  return (
    <div>
      <Caption design={design}>
        {t("doc.chart.title.historical", language, "Historical trend", {
          metric: metric ? metricLabel(metric) : "CPU",
          statistic: metric?.statistic ?? "avg",
        })}
      </Caption>
      <SampleChart
        design={design}
        series={[{ label: "Monthly", values }]}
        categories={categories}
        unit="percent"
        height={170}
        own={props.settings.style}
      />
    </div>
  )
}

function BlankRowsView(props: BlockViewProps) {
  const { design, expansion } = props
  const labels = Array.isArray(expansion.config.columns)
    ? (expansion.config.columns as unknown[]).map(String)
    : []
  const rows = Math.min(3, Number(expansion.config.rows ?? 3))
  return (
    <Table
      design={design}
      head={labels}
      rows={Array.from({ length: rows }, () => labels.map(() => "\u00a0"))}
    />
  )
}

function GlanceView(props: BlockViewProps) {
  const { design, language } = props
  const data = useCanvasData()
  const counts = data.counts
  const tiles = [
    [t("doc.glance.resources", language, "Resources in scope"), counts.resources],
    [t("doc.glance.stopped", language, "Stopped machines"), counts.stopped],
    [t("doc.glance.no_backup", language, "Resources without a backup"), counts.unprotected ?? "–"],
  ] as const
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {tiles.map(([label, value]) => (
          <div key={label} style={{ border: `1px solid ${design.spec.rule}`, borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: px(design.spec.smallPt), color: design.spec.muted }}>{label}</div>
            <div style={{ fontSize: px(design.spec.headingPt[0] + 4), fontWeight: 700, color: design.spec.accent, fontVariantNumeric: "tabular-nums" }}>
              {value}
            </div>
          </div>
        ))}
      </div>
      <div>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{t("doc.glance.decisions", language, "Decisions for you")}</div>
        <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
          <li>{t("doc.glance.decision.backup", language, "Decide which resources without a backup need one.").split(". ")[0]}.</li>
          <li>{t("doc.glance.decision.housekeeping", language, "Review the resources listed under Housekeeping.").split(". ")[0]}.</li>
        </ol>
      </div>
    </div>
  )
}

function CoverageView(props: BlockViewProps) {
  const { design, language } = props
  return (
    <Table
      design={design}
      head={[t("doc.table.gap", language, "Gap"), t("doc.table.resources_affected", language, "Resources affected"), t("doc.table.note", language, "Note")]}
      rows={[["Metrics not measured", "1", "Stopped for the whole period"]]}
      numeric={[1]}
    />
  )
}

function VerificationView(props: BlockViewProps) {
  const { design, language } = props
  return (
    <Table
      design={design}
      head={[t("doc.table.field", language, "Field"), t("doc.table.value", language, "Value")]}
      rows={[
        [t("doc.verification.figures_checked", language, "Figures checked"), "412"],
        [t("doc.verification.replay_status", language, "Replay"), t("doc.verification.status_pass", language, "Verified")],
        [t("doc.verification.snapshot_digest", language, "Snapshot digest"), "sha256:9f2c…41ab"],
      ]}
    />
  )
}

export function CatalogueBlock(props: BlockViewProps) {
  const { expansion, design, entry, language, settings, number, resource } = props
  const level = Number(expansion.config.level ?? 2) as 1 | 2 | 3 | 4

  switch (expansion.block) {
    case "heading": {
      if (expansion.per === "section" && level === 1) {
        const title = settings.title?.[language] ?? sectionTitle(entry, language)
        return <Heading design={design} level={1} number={number}>{title}</Heading>
      }
      const titleId = expansion.config.title_id
      const text =
        settings.title?.[language] ??
        (typeof titleId === "string"
          ? (messageText(titleId as MessageId, language) ?? titleId)
          : (resource?.name ?? sectionTitle(entry, language)))
      return <Heading design={design} level={Math.min(4, Math.max(2, level)) as 2 | 3 | 4}>{text}</Heading>
    }
    case "resource_table":
      return <ResourceTableView {...props} />
    case "timeseries_chart":
      return <ChartView {...props} />
    case "metric_summary":
      return <MetricSummaryView {...props} />
    case "top_n_table":
      return <TopNView {...props} />
    case "inventory_summary":
      return <InventoryView {...props} />
    case "historical_trend":
      return <TrendView {...props} />
    case "blank_rows_table":
      return <BlankRowsView {...props} />
    case "at_a_glance":
      return <GlanceView {...props} />
    case "gaps_and_coverage":
      return <CoverageView {...props} />
    case "verification_record":
      return <VerificationView {...props} />
    case "resource_narrative":
      return (
        <Narrative design={design} language={language}>
          {language === "id"
            ? `${resource?.name ?? "Sumber daya ini"} rata-rata ${resource?.avg ?? 0}% dan mencapai puncak ${resource?.peak ?? 0}% pada periode ini.`
            : `${resource?.name ?? "This resource"} averaged ${resource?.avg ?? 0}% and peaked at ${resource?.peak ?? 0}% over the period.`}
        </Narrative>
      )
    case "trend_narrative":
      return (
        <Narrative design={design} language={language}>
          {language === "id"
            ? "Penggunaan naik perlahan selama tiga bulan terakhir."
            : "Use rose gradually over the last three months."}
        </Narrative>
      )
    default:
      return <Caption design={design}>{expansion.block}</Caption>
  }
}

export function AddedText({ design, text }: Readonly<{ design: PageDesign; text: string | undefined }>) {
  return (
    <p style={{ margin: 0, color: text ? design.spec.ink : design.spec.muted, fontStyle: text ? undefined : "italic", whiteSpace: "pre-wrap" }}>
      {text || "Type in the inspector — words only, no numbers."}
    </p>
  )
}

export { Heading, Caption, px }

/**
 * An agent paragraph on the page. What prints is written at run time, so the page shows the
 * author's instruction and — once they have pressed Try it — the words the agent wrote from
 * a real report's figures, marked as a try. In Preview only what would print is drawn.
 */
function AgentParagraphView({
  design,
  language,
  entry,
  lastTry,
  editing,
}: Readonly<{ design: PageDesign; language: Language; entry: AddedEntry; lastTry?: AgentTry; editing: boolean }>) {
  const { spec } = design
  const instruction = entry.instruction?.[language]?.trim()
  const note = entry.fallback === "note" ? entry.note?.[language]?.trim() : undefined
  const printed = lastTry?.outcome === "written" ? lastTry.text : lastTry?.outcome === "note" ? note : undefined
  const paragraphs = (printed ?? "").split(entry.length === "bullets" ? /\n/ : /\n\n/).filter((part) => part.trim())

  if (!editing) {
    return paragraphs.length > 0 ? (
      <div className="flex flex-col" style={{ gap: 6, color: lastTry?.outcome === "note" ? spec.muted : spec.ink }}>
        {paragraphs.map((text, index) => (
          <p key={index}>{text}</p>
        ))}
      </div>
    ) : (
      <p style={{ color: spec.muted, fontStyle: "italic" }}>The agent&rsquo;s paragraph prints here, written from this section&rsquo;s figures.</p>
    )
  }

  return (
    <div
      className="flex flex-col gap-1.5 font-sans"
      style={{ borderLeft: `2px dashed ${tint(spec.accent, 0.4)}`, paddingLeft: 10 }}
    >
      <span className="text-[10.5px] font-semibold tracking-wide uppercase" style={{ color: spec.accent }}>
        Agent paragraph · {entry.length === "bullets" ? "points" : entry.length === "sentence" ? "one sentence" : "short"} · {entry.voice ?? "plain"}
      </span>
      <p className="text-[12px] leading-snug" style={{ color: instruction ? spec.ink : spec.muted, fontStyle: instruction ? undefined : "italic" }}>
        {instruction ? `“${instruction}”` : "Write an instruction in the inspector: what should the agent say about these figures?"}
      </p>
      {lastTry && (
        <div className="mt-1 flex flex-col gap-1 rounded-sm px-2 py-1.5" style={{ background: spec.band }}>
          <span className="text-[10.5px] font-medium" style={{ color: spec.muted }}>
            Last try · {lastTry.outcome === "written" ? `from ${lastTry.figures} figures, every number checked` : "not written"}
          </span>
          {paragraphs.length > 0 ? (
            paragraphs.map((text, index) => (
              <p key={index} className="text-[12.5px] leading-snug" style={{ color: lastTry.outcome === "note" ? spec.muted : spec.ink, fontFamily: spec.face }}>
                {text}
              </p>
            ))
          ) : (
            <p className="text-[12px] leading-snug" style={{ color: spec.muted }}>
              {AGENT_REASONS[lastTry.reason] ?? "Not written."} {entry.fallback === "note" ? "Your note prints instead." : "Nothing prints in its place."}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// --- Blocks the author placed -----------------------------------------------------------

export function AddedBlockView({
  provider,
  design,
  language,
  section,
  sectionEntry: catalogueEntry,
  entry,
  lastTry,
  editing = true,
}: Readonly<{
  provider: Provider
  design: PageDesign
  language: Language
  section: SectionV4
  sectionEntry: CatalogueSection
  entry: AddedEntry
  /** An agent paragraph's last Try it, if there was one this session. */
  lastTry?: AgentTry
  editing?: boolean
}>) {
  const metrics = section.metrics ?? []
  const resources = useSectionResources(section)
  const data = useCanvasData()
  const ranking = rankingOf(section, catalogueEntry)
  const firstName = ranking?.metric ?? "CPU"
  const firstStat = ranking?.statistic ?? "avg"
  // Charts draw a missing real figure as zero; tables print a dash (`formatFigure`).
  const valueOf = (resource: SampleResource, name: string, statistic: string): number =>
    figureOf(resource, name, statistic === "max" ? "max" : "avg") ?? 0
  const ranked = (name: string, statistic: string) => [...resources].sort(byFigure(name, statistic === "max" ? "max" : "avg"))

  if (resources.length === 0 && readsMetrics(entry.kind)) return <NoResources language={language} />

  switch (entry.kind) {
    case "text":
      return <AddedText design={design} text={entry.text?.[language]} />
    case "page_break":
      return (
        <div className="flex items-center gap-2 font-sans text-[10.5px] tracking-wide text-muted-foreground uppercase">
          <span className="h-px flex-1 border-t border-dashed border-current" />
          Page break
          <span className="h-px flex-1 border-t border-dashed border-current" />
        </div>
      )
    case "coverage":
      return <CoverageView {...({ design, language } as BlockViewProps)} />
    case "key_figures":
      return (
        <Table
          design={design}
          head={[
            t("doc.table.metric", language, "Metric"),
            t("doc.table.basis", language, "Basis"),
            t("doc.table.value", language, "Value"),
            t("doc.table.resource", language, "Resource"),
          ]}
          rows={(metrics.length ? metrics : [{ metric: "CPU", statistic: "avg" }]).map((item) => {
            const name = metricLabel(item)
            const lowest = item.statistic === "min"
            const sorted = ranked(name, item.statistic).filter((r) => figureOf(r, name, item.statistic === "max" ? "max" : "avg") !== null)
            const pick = (lowest ? sorted.at(-1) : sorted[0]) ?? resources[0]!
            return [
              `${name} (${item.statistic})`,
              t(lowest ? "doc.basis.lowest_observed" : "doc.basis.highest_observed", language, lowest ? "lowest observed" : "highest observed"),
              formatFigure(figureOf(pick, name, item.statistic === "max" ? "max" : "avg"), sampleUnit(name)),
              pick.name,
            ]
          })}
          numeric={[2]}
        />
      )
    case "top_list": {
      // Ranking column first, then the section's other metrics, as the runtime lays it out.
      const ordered = [
        { metric: firstName, statistic: firstStat },
        ...metrics
          .map((m) => ({ metric: metricLabel(m), statistic: m.statistic }))
          .filter((m) => !(m.metric === firstName && m.statistic === firstStat)),
      ].slice(0, 4)
      const rows = ranked(firstName, firstStat)
      return (
        <Table
          design={design}
          head={[t("doc.table.resource", language, "Resource"), ...ordered.map((m) => `${m.metric} (${m.statistic})`)]}
          rows={rows.map((r) => [
            r.name,
            ...ordered.map((m) => formatFigure(figureOf(r, m.metric, m.statistic === "max" ? "max" : "avg"), sampleUnit(m.metric))),
          ])}
          numeric={ordered.map((_, index) => index + 1)}
        />
      )
    }
    case "callout": {
      const fills: Record<string, string> = {
        count: "3",
        resource: ranked(firstName, "max")[0]!.name,
        value: formatFigure(figureOf(ranked(firstName, "max")[0]!, firstName, "max"), sampleUnit(firstName)),
      }
      const words = entry.text?.[language] ?? ""
      const attention = entry.tone === "attention"
      const rule = attention ? ATTENTION.rule : design.spec.accent
      const tone = attention ? ATTENTION.tint : design.spec.band
      // The three treatments `printcss._treatments` and `docx._apply_style_options` draw.
      const look =
        design.look.callout === "banner"
          ? { background: rule, color: "#fff", fontWeight: 700 }
          : design.look.callout === "boxed"
            ? { border: `1px solid ${rule}`, borderRadius: 4, background: tone, color: design.spec.ink }
            : { borderLeft: `3px solid ${rule}`, background: tone, color: design.spec.ink }
      return (
        <div style={{ ...look, padding: "8px 12px" }}>
          {words ? words.replace(/\{(count|resource|value)\}/g, (_, token: string) => fills[token] ?? "") : (
            <span style={{ opacity: 0.7, fontStyle: "italic" }}>Write the callout in the inspector — it prints only when its condition holds.</span>
          )}
        </div>
      )
    }
    case "heatmap": {
      const rows = ranked(firstName, firstStat).map((r) => ({
        label: r.name,
        values: sampleMetricSeries(r, firstName, firstStat === "max" ? "max" : "avg"),
      }))
      return (
        <div>
          <Caption design={design}>
            {t("doc.chart.title.over_time", language, "Over time", { metrics: `${firstName} (${firstStat})` })}
          </Caption>
          <SampleChart
            design={design}
            type="heatmap"
            panelLabel={`${firstName} (${firstStat})`}
            series={rows}
            categories={rows[0]!.values.map((_, index) => String(index + 1))}
            unit={sampleUnit(firstName)}
          />
        </div>
      )
    }
    case "sparklines": {
      const order = ranked(firstName, firstStat)
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SampleChart
            design={design}
            style="sparkline"
            series={order.map((r) => ({
              label: r.name,
              values: sampleMetricSeries(r, firstName, firstStat === "max" ? "max" : "avg"),
            }))}
            categories={sampleMetricSeries(order[0]!, firstName, "avg").map((_, index) => String(index + 1))}
            unit={sampleUnit(firstName)}
          />
          <Table
            design={design}
            head={[
              t("doc.table.resource", language, "Resource"),
              t("doc.summary.avg", language, "Average"),
              t("doc.summary.p95", language, "P95 (est.)"),
              t("doc.summary.max", language, "Peak"),
            ]}
            rows={order.map((r) => {
              const figures = periodFigures(r, firstName)
              const unit = sampleUnit(firstName)
              return [r.name, formatFigure(figures.avg, unit), formatFigure(figures.p95, unit), formatFigure(figures.peak, unit)]
            })}
            numeric={[1, 2, 3]}
          />
        </div>
      )
    }
    case "agent":
      return <AgentParagraphView design={design} language={language} entry={entry} lastTry={lastTry} editing={editing} />
    case "avg_vs_peak": {
      const metric = avgAndPeakMetric(section) ?? firstName
      const byPeak = ranked(metric, "max")
      return (
        <div>
          <Caption design={design}>
            {t("doc.chart.title.avg_vs_peak", language, "Average and peak by resource", { metric: friendlyMetric(metric, language) })}
          </Caption>
          <SampleChart
            design={design}
            type="dumbbell"
            series={[
              { label: t("doc.chart.series.average", language, "Average"), values: byPeak.map((r) => valueOf(r, metric, "avg")) },
              { label: t("doc.chart.series.peak", language, "Peak"), values: byPeak.map((r) => valueOf(r, metric, "max")) },
            ]}
            categories={byPeak.map((r) => r.name)}
            unit={sampleUnit(metric)}
          />
        </div>
      )
    }
    case "kpi_tiles": {
      const items = (metrics.length ? metrics : [{ metric: "CPU", statistic: "avg" }]).slice(0, 4)
      const tiles = items.map((item, index) => {
        const name = metricLabel(item)
        const statistic = item.statistic === "max" ? "max" : "avg"
        const lowest = item.statistic === "min"
        const unit = sampleUnit(name)
        const sorted = ranked(name, item.statistic).filter((r) => figureOf(r, name, statistic) !== null)
        const pick = (lowest ? sorted.at(-1) : sorted[0]) ?? resources[0]!
        const now = figureOf(pick, name, statistic)
        // The previous report's figure: the month before on real figures, a sample's otherwise.
        const months = pick.months?.[seriesKey(name, statistic)]
        const before =
          pick.months !== undefined
            ? (months && months.length > 1 ? months.at(-2)!.value : null)
            : now === null ? null : now * (index % 2 ? 0.93 : 0.88)
        const delta = before === null || now === null ? null : now - before
        const direction: "up" | "down" | "flat" | null = delta === null ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat"
        // A rise in free memory or availability is good news; in load, the one to look at.
        const good = (direction === "up") === /free|available|availability/i.test(name)
        const amount = delta === null ? "" : formatSample(Math.abs(delta), unit)
        return {
          label: friendlyLabel(name, item.statistic, language),
          value: formatFigure(now, unit),
          resource: pick.name,
          change:
            direction === null
              ? null
              : {
                  text:
                    direction === "flat"
                      ? t("doc.comparison.direction.same", language, "Same")
                      : unit === "percent"
                        ? `${amount.replace(/%$/, "")} ${t("doc.tiles.points", language, "pts")}`
                        : amount,
                  direction,
                  ink: direction === "flat" ? design.spec.muted : good ? "#1D5C4A" : "#7A4A0C",
                },
          note: direction === null ? t("doc.tiles.no_earlier_report", language, "No earlier report") : "",
          spark: sampleMetricSeries(pick, name, statistic).map(String),
        }
      })
      const compared = tiles.some((tile) => tile.change !== null)
      return (
        <KpiTiles
          design={design}
          title={t("doc.chart.title.tiles", language, "Key figures")}
          subtitle={compared ? t("doc.tiles.vs_previous", language, "change since the previous report") : ""}
          tiles={tiles}
        />
      )
    }
    case "bar_list": {
      const statistic = firstStat === "max" ? "max" : "avg"
      const unit = sampleUnit(firstName)
      const rows = ranked(firstName, firstStat)
        .filter((r) => figureOf(r, firstName, statistic) !== null)
        .slice(0, section.selection?.top_n?.count ?? 10)
      const values = rows.map((r) => figureOf(r, firstName, statistic))
      return (
        <div>
          <RowChart
            design={design}
            title={t("doc.chart.title.bar_list", language, "By resource", { metric: friendlyLabel(firstName, firstStat, language) })}
            type="bar_list"
            categories={rows.map((r) => r.name)}
            series={[{ key: "value", label: firstName, values, labels: values.map((v) => formatFigure(v, unit)) }]}
            unit={unit}
          />
          <Caption design={design}>
            {t("doc.chart.title.bar_list", language, "By resource", { metric: friendlyLabel(firstName, firstStat, language) })}
          </Caption>
        </div>
      )
    }
    case "utilization_bullet": {
      const metric = avgAndPeakMetric(section) ?? firstName
      const unit = sampleUnit(metric)
      const rows = ranked(metric, "max")
        .filter((r) => periodFigures(r, metric).avg !== null && periodFigures(r, metric).peak !== null)
        .slice(0, 12)
      const figures = rows.map((r) => periodFigures(r, metric))
      const part = (key: "avg" | "p95" | "peak", id: MessageId, fallback: string) => {
        const values = figures.map((f) => f[key])
        return { key, label: t(id, language, fallback), values, labels: values.map((v) => formatFigure(v, unit)) }
      }
      return (
        <div>
          <RowChart
            design={design}
            title={t("doc.chart.title.bullet", language, "Average, estimated P95 and peak by resource", { metric: friendlyMetric(metric, language) })}
            type="bullet"
            legendText={t("doc.chart.legend.bullet", language, "", { threshold: design.look.chartThreshold ?? DEFAULT_THRESHOLD })}
            categories={rows.map((r) => r.name)}
            series={[
              part("avg", "doc.chart.series.average", "Average"),
              part("p95", "doc.chart.series.p95", "P95 (est.)"),
              part("peak", "doc.chart.series.peak", "Peak"),
            ]}
            unit={unit}
          />
          <Caption design={design}>
            {t("doc.chart.title.bullet", language, "Average, estimated P95 and peak by resource", { metric: friendlyMetric(metric, language) })}
          </Caption>
        </div>
      )
    }
    case "fleet_mix": {
      const mix = fleetMix(resources, provider)
      if (mix.length === 0) return <NoResources language={language} />
      const typeLabel = (type: string): string => {
        const key = type.toLowerCase()
        return key === "aws::ec2::instance"
          ? t("doc.mix.type.ec2", language, "EC2 instances")
          : key === "aws::rds::dbinstance"
            ? t("doc.mix.type.rds", language, "RDS databases")
            : t("doc.mix.type.vm", language, "Virtual machines")
      }
      const segments = FLEET_MIX_SEGMENTS.filter((segment) => mix.some((row) => (row.counts[segment] ?? 0) > 0))
      return (
        <div>
          <RowChart
            design={design}
            title={t("doc.chart.title.fleet_mix", language, "Fleet mix")}
            type="mix"
            categories={mix.map((row) => typeLabel(row.type))}
            series={segments.map((segment) => {
              const values = mix.map((row) => row.counts[segment] ?? null)
              const label =
                segment === "stopped" && provider === "azure" ? "doc.mix.deallocated" : (`doc.mix.${segment}` as MessageId)
              return { key: segment, label: t(label, language, segment), values, labels: values.map((v) => (v === null ? null : String(v))) }
            })}
            unit="count"
          />
          <Caption design={design}>{t("doc.chart.title.fleet_mix", language, "Fleet mix")}</Caption>
          <Caption design={design}>{t("doc.chart.note.fleet_mix", language, "")}</Caption>
        </div>
      )
    }
    case "small_multiples": {
      const order = ranked(firstName, firstStat).slice(0, 24)
      const title = t("doc.chart.title.multiples", language, "By resource, day by day", { metrics: friendlyLabel(firstName, firstStat, language) })
      return (
        <div>
          <MultiplesChart
            design={design}
            title={title}
            series={order.map((r) => ({ label: r.name, values: sampleMetricSeries(r, firstName, firstStat === "max" ? "max" : "avg") }))}
            categories={sampleMetricSeries(order[0]!, firstName, "avg").map((_, index) => String(index + 1))}
            unit={sampleUnit(firstName)}
          />
          <Caption design={design}>{title}</Caption>
        </div>
      )
    }
    case "annotated_line": {
      const order = ranked(firstName, firstStat).slice(0, 3)
      const days = sampleMetricSeries(order[0]!, firstName, "avg").map((_, index) => String(index + 1))
      // Where an incident typed on the run form lands: a sample, since the builder has no run.
      const marked = days[Math.floor(days.length / 3)]
      return (
        <div>
          <Caption design={design}>
            {t("doc.chart.title.annotated", language, "Against the threshold, with incidents", { metrics: friendlyLabel(firstName, firstStat, language) })}
          </Caption>
          <SampleChart
            design={design}
            style="stacked"
            series={order.map((r) => ({ label: r.name, values: sampleMetricSeries(r, firstName, firstStat === "max" ? "max" : "avg") }))}
            categories={days}
            unit={sampleUnit(firstName)}
            defaultThreshold={80}
            markers={marked ? [{ x: marked, label: "Incident from the run form" }] : []}
          />
        </div>
      )
    }
    case "week_heatmap": {
      const week = weekMetricOf(section, catalogueEntry)
      const name = week?.metric ?? firstName
      const statistic = week?.statistic ?? "avg"
      const title = t("doc.chart.title.week", language, "By hour and weekday", { metric: friendlyLabel(name, statistic, language) })
      const days = (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) =>
        t(`doc.weekday.${day}` as MessageId, language, day)
      )
      let grid: readonly (readonly (number | null)[])[] | undefined
      if (data.kind === "real") {
        // The report's own cells: the fleet of the section's first type that has any.
        const types = [...new Set(resources.map((r) => (r.type ?? "").toLowerCase()).filter(Boolean))].sort()
        grid = types.map((type) => data.week?.[`${type}|${seriesKey(name, statistic)}`]).find((cells) => cells !== undefined)
        if (grid === undefined) {
          return (
            <div>
              <Caption design={design}>{title}</Caption>
              <p style={{ color: design.spec.muted, fontStyle: "italic", margin: 0 }}>
                The latest report holds no hour-by-weekday figures for this section. A report the
                runtime makes from now on collects them.
              </p>
            </div>
          )
        }
      } else {
        // A sample shape, not anybody's figures: busier in weekday working hours.
        const level = valueOf(ranked(name, statistic)[0]!, name, statistic)
        grid = days.map((_, index) =>
          Array.from({ length: 24 }, (_, hour) => {
            const working = index < 5 && hour >= 8 && hour < 18
            return Number((level * (working ? 0.9 + ((hour * 7 + index) % 5) * 0.05 : 0.15 + ((hour + index) % 3) * 0.05)).toFixed(2))
          })
        )
      }
      return (
        <div>
          <WeekChart
            design={design}
            title={title}
            rows={days.map((label, index) => ({ label, values: grid![index] ?? [] }))}
            unit={sampleUnit(name)}
            legendText={t("doc.chart.legend.week", language, "")}
          />
          <Caption design={design}>{title}</Caption>
          <Caption design={design}>{t("doc.chart.note.week", language, "")}</Caption>
        </div>
      )
    }
    case "backup_tracker": {
      if (resources.length === 0) return <NoResources language={language} />
      const shown = resources.slice(0, 6)
      const real = data.kind === "real"
      if (provider === "azure") {
        return (
          <Table
            design={design}
            head={[t("doc.table.resource", language, "Resource"), "Last backup status", "Last restore point"]}
            rows={shown.map((r, index) =>
              real
                ? [r.name, r.cells.last_backup_status ?? "", r.cells.last_restore_point ?? ""]
                : [r.name, index === 2 ? "Failed" : "Completed", "Sample date"]
            )}
          />
        )
      }
      // The period's last 31 days, as the runtime draws them (`compile/blocks/backup.py`).
      const period = stripDays(real ? data.source : undefined)
      const pill = (status: "full" | "partial" | "none", key: number, gap: boolean): ReactNode => (
        <span
          key={key}
          aria-label={status}
          style={{
            display: "inline-block",
            width: "0.45em",
            height: "1.1em",
            marginRight: gap ? "0.5em" : "0.14em",
            borderRadius: "0.16em",
            verticalAlign: "-0.2em",
            background: status === "full" ? design.spec.accent : status === "partial" ? "#B26A00" : "#D6DCE0",
          }}
        />
      )
      const strip = (resource: SampleResource, index: number): ReactNode => {
        if (real) {
          // The collected fact, read back the way the runtime reads it. No fact, no strip:
          // AWS Backup does not protect that resource.
          const fact = resource.cells.recovery_point_days
          if (!fact) return ""
          const marked = recoveryDays(fact)
          return period.map((day, position) => {
            const complete = marked.get(day)
            return pill(complete === undefined ? "none" : complete ? "full" : "partial", position, position % 7 === 6)
          })
        }
        // A sample month, not anybody's backups: a missed day or two on some rows.
        return period.map((_, day) =>
          pill(index === 1 && day > 17 && day < 20 ? "none" : index === 3 && day === 9 ? "partial" : "full", day, day % 7 === 6)
        )
      }
      return (
        <div>
          <Table
            design={design}
            head={[
              t("doc.table.resource", language, "Resource"),
              t("doc.backup.days", language, "Each day", { start: period[0] ?? "", end: period.at(-1) ?? "" }),
              t("doc.backup.recovery_points", language, "Recovery points"),
            ]}
            rows={shown.map((r, index) => [r.name, strip(r, index), real ? (r.cells.recovery_point_days ?? "") : "As AWS Backup lists them"])}
          />
          <Caption design={design}>{t("doc.backup.legend", language, "")}</Caption>
        </div>
      )
    }
    case "month_vs_month":
      return (
        <div>
          <Caption design={design}>
            {t("doc.comparison.caption", language, "Against the previous verified report", {
              metric: firstName,
              statistic: firstStat,
            })}
          </Caption>
          <Table
            design={design}
            head={[
              t("doc.table.resource", language, "Resource"),
              t("doc.table.previous_report", language, "Previous report"),
              t("doc.table.this_run", language, "This run"),
              t("doc.table.direction", language, "Direction"),
            ]}
            rows={resources.map((r, index) => {
              const unit = sampleUnit(firstName)
              const now = valueOf(r, firstName, firstStat)
              const before = now * (index === 1 ? 1.12 : 0.86)
              return [
                r.name,
                formatSample(before, unit),
                formatSample(now, unit),
                t(
                  before < now ? "doc.comparison.direction.higher" : "doc.comparison.direction.lower",
                  language,
                  before < now ? "Higher" : "Lower"
                ),
              ]
            })}
            numeric={[1, 2]}
          />
        </div>
      )
  }
}
