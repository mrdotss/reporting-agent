"use client"

import { init } from "echarts"
import { useId, useMemo, useSyncExternalStore, type CSSProperties, type ReactNode } from "react"

import {
  renderSVG,
  type ReportChartSpec,
} from "../../../../agent/chart-renderer/svg.mjs"
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
  type AddedEntry,
  type BlockStyle,
  type MetricItem,
  type SectionV4,
  type SlotEntry,
} from "@/lib/builder/model"
import type { AgentTry } from "@/lib/builder/store"
import {
  SAMPLE_COUNTS,
  formatSample,
  sampleCell,
  sampleMetricSeries,
  sampleResources,
  sampleSummary,
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
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: px(size) }}>
      <thead>
        <tr>
          {head.map((label, index) => (
            <th key={`${label}-${index}`} style={{ ...cell(index), fontWeight: 700, whiteSpace: "nowrap", fontFamily: spec.headingFace, ...headLook }}>
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
}: Readonly<{
  design: PageDesign
  series: readonly { label: string; values: readonly number[]; dashed?: boolean }[]
  categories: readonly string[]
  unit: SampleUnit
  height?: number
  type?: "line" | "heatmap" | "dumbbell"
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
  const threshold = own?.threshold ?? look.chartThreshold
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
    }
    return renderSVG(chartSpec, false, init)
      .replace(/zr\d+/g, prefix)
      .replace(/<svg /, '<svg style="width:100%;height:auto;display:block" ')
  }, [categories, chartFace, chartStyle, height, heightScale, look, panelLabel, prefix, series, spec.accent, spec.ink, spec.muted, spec.rule, threshold, type, unit, values])
  // The chart renderer's own SVG, the same drawing the runtime embeds in the report. Drawn
  // in the browser only: ECharts measures text, and the server's measurements differ from
  // the browser's, so a server-drawn chart would never match the one that hydrates it.
  const inBrowser = useSyncExternalStore(subscribeNever, () => true, () => false)
  if (!inBrowser) return <div aria-hidden style={{ aspectRatio: "640 / 190", width: "100%" }} />
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

function ResourceTableView(props: BlockViewProps) {
  const { design, language, expansion, settings, provider, resource } = props
  const columns = columnsFor(expansion, settings)
  const resources = sampleResources(provider)
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
          ...metrics.map((m) => formatSample(m.statistic === "max" ? r.peak : r.avg, "percent")),
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
  const { design, language, section, resource, provider } = props
  const target = resource ?? sampleResources(provider)[0]!
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
  const { design, language, section, resource, provider } = props
  const target = resource ?? sampleResources(provider)[0]!
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
        const summary = sampleSummary(sampleMetricSeries(target, name, "max"))
        return [
          name,
          formatSample(summary.avg * 0.62, unit),
          formatSample(summary.p95, unit),
          formatSample(summary.peak, unit),
          "14 Sep 10:00",
        ]
      })}
      numeric={[1, 2, 3]}
      own={props.settings.style}
    />
  )
}

function TopNView(props: BlockViewProps) {
  const { design, language, section, provider } = props
  const metric = section.metrics?.[0]
  const ranked = [...sampleResources(provider)].sort((a, b) => b.peak - a.peak)
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
        rows={ranked.map((r) => [r.name, formatSample(r.avg, "percent"), formatSample(r.peak, "percent")])}
        numeric={[1, 2]}
        own={props.settings.style}
      />
    </div>
  )
}

function InventoryView(props: BlockViewProps) {
  const { design, language, provider } = props
  const counts = SAMPLE_COUNTS[provider]
  const rows =
    provider === "aws"
      ? [
          [t("doc.inventory.account_id", language, "Account ID"), "•••• •••• 4821"],
          [t("doc.inventory.regions", language, "Regions"), "ap-southeast-1, ap-southeast-3"],
          [t("doc.inventory.total_resources", language, "Total resources"), String(counts.resources)],
        ]
      : [
          [t("doc.inventory.subscription_id", language, "Subscription ID"), "•••••••-••••-4c21"],
          [t("doc.inventory.resource_groups", language, "Resource groups"), "rg-app-prod, rg-data-prod"],
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
  const { design, language, section, resource, provider } = props
  const months = Math.max(2, section.lookback ?? 3)
  const target = resource ?? sampleResources(provider)[0]!
  const values = Array.from({ length: months }, (_, index) =>
    Number((target.avg * (0.7 + 0.3 * Math.sin(index + 1) ** 2)).toFixed(1))
  )
  const categories = Array.from({ length: months }, (_, index) => {
    const date = new Date(2026, 8 - (months - 1 - index), 1)
    return date.toLocaleString(language === "id" ? "id-ID" : "en-GB", { month: "short" })
  })
  const metric = section.metrics?.[0]
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
  const { design, language, provider } = props
  const counts = SAMPLE_COUNTS[provider]
  const tiles = [
    [t("doc.glance.resources", language, "Resources in scope"), counts.resources],
    [t("doc.glance.stopped", language, "Stopped machines"), counts.stopped],
    [t("doc.glance.no_backup", language, "Resources without a backup"), counts.unprotected],
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
  const resources = sampleResources(provider)
  const ranking = rankingOf(section, catalogueEntry)
  const firstName = ranking?.metric ?? "CPU"
  const firstStat = ranking?.statistic ?? "avg"
  const valueOf = (resource: SampleResource, name: string, statistic: string): number => {
    const summary = sampleSummary(sampleMetricSeries(resource, name, statistic === "max" ? "max" : "avg"))
    return statistic === "max" ? summary.peak : summary.avg
  }

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
            const sorted = [...resources].sort((a, b) => valueOf(b, name, item.statistic) - valueOf(a, name, item.statistic))
            const pick = lowest ? sorted.at(-1)! : sorted[0]!
            return [
              `${name} (${item.statistic})`,
              t(lowest ? "doc.basis.lowest_observed" : "doc.basis.highest_observed", language, lowest ? "lowest observed" : "highest observed"),
              formatSample(valueOf(pick, name, item.statistic), sampleUnit(name)),
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
      const ranked = [...resources].sort((a, b) => valueOf(b, firstName, firstStat) - valueOf(a, firstName, firstStat))
      return (
        <Table
          design={design}
          head={[t("doc.table.resource", language, "Resource"), ...ordered.map((m) => `${m.metric} (${m.statistic})`)]}
          rows={ranked.map((r) => [
            r.name,
            ...ordered.map((m) => formatSample(valueOf(r, m.metric, m.statistic), sampleUnit(m.metric))),
          ])}
          numeric={ordered.map((_, index) => index + 1)}
        />
      )
    }
    case "callout": {
      const fills: Record<string, string> = {
        count: "3",
        resource: [...resources].sort((a, b) => b.peak - a.peak)[0]!.name,
        value: formatSample([...resources].sort((a, b) => b.peak - a.peak)[0]!.peak, sampleUnit(firstName)),
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
      const ranked = [...resources].sort((a, b) => valueOf(b, firstName, firstStat) - valueOf(a, firstName, firstStat))
      const rows = ranked.map((r) => ({
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
      const ranked = [...resources].sort((a, b) => valueOf(b, firstName, firstStat) - valueOf(a, firstName, firstStat))
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SampleChart
            design={design}
            style="sparkline"
            series={ranked.map((r) => ({
              label: r.name,
              values: sampleMetricSeries(r, firstName, firstStat === "max" ? "max" : "avg"),
            }))}
            categories={sampleMetricSeries(ranked[0]!, firstName, "avg").map((_, index) => String(index + 1))}
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
            rows={ranked.map((r) => {
              const summary = sampleSummary(sampleMetricSeries(r, firstName, "max"))
              const unit = sampleUnit(firstName)
              return [r.name, formatSample(summary.avg * 0.62, unit), formatSample(summary.p95, unit), formatSample(summary.peak, unit)]
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
      const ranked = [...resources].sort((a, b) => valueOf(b, metric, "max") - valueOf(a, metric, "max"))
      return (
        <div>
          <Caption design={design}>
            {t("doc.chart.title.avg_vs_peak", language, "Average and peak by resource", { metric })}
          </Caption>
          <SampleChart
            design={design}
            type="dumbbell"
            series={[
              { label: t("doc.chart.series.average", language, "Average"), values: ranked.map((r) => valueOf(r, metric, "avg")) },
              { label: t("doc.chart.series.peak", language, "Peak"), values: ranked.map((r) => valueOf(r, metric, "max")) },
            ]}
            categories={ranked.map((r) => r.name)}
            unit={sampleUnit(metric)}
          />
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
