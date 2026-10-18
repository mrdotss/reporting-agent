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
import { rankingOf, type AddedEntry, type MetricItem, type SectionV4, type SlotEntry } from "@/lib/builder/model"
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
import { DENSITY_SCALE, PT, type PageDesign } from "@/lib/builder/theme"
import { messageText, type MessageId } from "@/lib/messages/catalog"

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

function Table({
  design,
  head,
  rows,
  numeric = [],
}: Readonly<{
  design: PageDesign
  head: readonly string[]
  rows: readonly (readonly ReactNode[])[]
  numeric?: readonly number[]
}>) {
  const { spec, tableStyle, density } = design
  const scale = DENSITY_SCALE[density]
  const hair = `0.75px solid ${spec.rule}`
  const under = `1.5px solid ${spec.accent}`
  const cell = (index: number, rowIndex?: number): CSSProperties => ({
    padding: `${4 * scale}px 8px`,
    textAlign: numeric.includes(index) ? "right" : "left",
    fontVariantNumeric: "tabular-nums",
    borderTop: tableStyle === "bordered" ? hair : "none",
    borderLeft: tableStyle === "bordered" ? hair : "none",
    borderRight: tableStyle === "bordered" ? hair : "none",
    borderBottom: tableStyle === "banded" ? "none" : hair,
    background:
      tableStyle === "banded" && spec.bandedRows && rowIndex !== undefined && rowIndex % 2 === 1
        ? spec.band
        : "transparent",
  })
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: px(spec.smallPt + 0.5) }}>
      <thead>
        <tr>
          {head.map((label, index) => (
            <th
              key={`${label}-${index}`}
              style={{
                ...cell(index),
                fontWeight: 700,
                color: spec.ink,
                borderBottom: under,
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((value, index) => (
              <td key={index} style={cell(index, rowIndex)}>
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

function Heading({
  design,
  level,
  children,
  number,
}: Readonly<{ design: PageDesign; level: 1 | 2 | 3 | 4; children: ReactNode; number?: number }>) {
  const { spec } = design
  const size = spec.headingPt[level - 1]!
  const caps = spec.headingAllCaps && level >= 3
  return (
    <div
      role="heading"
      aria-level={level + 1}
      style={{
        fontSize: px(size),
        fontWeight: 700,
        color: level === 1 ? spec.accent : spec.ink,
        letterSpacing: caps ? "0.06em" : level === 1 ? "-0.005em" : undefined,
        textTransform: caps ? "uppercase" : undefined,
        lineHeight: 1.2,
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        paddingBottom: level === 1 ? 6 : 0,
        borderBottom: level === 1 ? `1px solid ${spec.rule}` : undefined,
      }}
    >
      {number !== undefined && (
        <span style={{ color: spec.muted, fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>
          {String(number).padStart(2, "0")}
        </span>
      )}
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
}: Readonly<{
  design: PageDesign
  series: readonly { label: string; values: readonly number[]; dashed?: boolean }[]
  categories: readonly string[]
  unit: SampleUnit
  height?: number
}>) {
  const { spec, chartStyle, chartFace } = design
  // ECharts numbers its clip paths per instance, so two charts on one page would share ids.
  const prefix = `builder${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const svg = useMemo(() => {
    const split = (chartStyle === "stacked" || chartStyle === "sparkline") && series.length > 1
    const max = niceMax(Math.max(...series.flatMap((s) => s.values)), unit)
    const chartSpec: ReportChartSpec = {
      style: chartStyle,
      type: "line",
      width: 640,
      height: split ? Math.max(height, series.length * 115 + 30) : height,
      font: chartFace.split(",")[0]!.replaceAll('"', ""),
      ink: spec.ink,
      muted: spec.muted,
      rule: spec.rule,
      emptyLabel: "",
      categories: [...categories],
      panels: (split ? series : series.slice(0, 1)).map((s) => ({
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
        color: spec.accent,
        dashed: s.dashed ?? index > 0,
        values: s.values.map(String),
      })),
      bands: chartStyle === "range_band" && series.length > 1 ? [{ lower: 1, upper: 0 }] : [],
    }
    return renderSVG(chartSpec, false, init)
      .replace(/zr\d+/g, prefix)
      .replace(/<svg /, '<svg style="width:100%;height:auto;display:block" ')
  }, [categories, chartFace, chartStyle, height, prefix, series, spec.accent, spec.ink, spec.muted, spec.rule, unit])
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
      />
    )
  }
  const shown = columns.filter((column) => column.id !== "resource_name")
  return (
    <Table
      design={design}
      head={[t("doc.table.resource", language, "Resource"), ...shown.map((c) => columnLabel(c, language))]}
      rows={(resource ? [resource] : resources).map((r) => [r.name, ...shown.map((c) => sampleCell(r, c.id))])}
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
      <SampleChart design={design} series={series} categories={categories} unit={unit} />
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
  return <Table design={design} head={[t("doc.table.field", language, "Field"), t("doc.table.value", language, "Value")]} rows={rows} />
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
      <SampleChart design={design} series={[{ label: "Monthly", values }]} categories={categories} unit="percent" height={170} />
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

// --- Blocks the author placed -----------------------------------------------------------

export function AddedBlockView({
  provider,
  design,
  language,
  section,
  sectionEntry: catalogueEntry,
  entry,
}: Readonly<{
  provider: Provider
  design: PageDesign
  language: Language
  section: SectionV4
  sectionEntry: CatalogueSection
  entry: AddedEntry
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
