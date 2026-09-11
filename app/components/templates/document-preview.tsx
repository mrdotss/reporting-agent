"use client"

import { useMemo } from "react"
import { init } from "echarts"
import {
  renderSVG,
  type ReportChartSpec,
} from "../../../agent/chart-renderer/svg.mjs"

import type { SectionCatalogueEntry } from "@/components/templates/step-sections"
import { messageText, type MessageId } from "@/lib/messages/catalog"
import { CHART_FONT_STACKS } from "@/lib/profiles/chart-styles"
import {
  PRESET_FACES,
  SAMPLE_AVG,
  SAMPLE_KPIS,
  SAMPLE_MAX,
  SAMPLE_ROWS,
} from "@/lib/profiles/preview-sample"
import {
  CHART_FONTS,
  CHART_STYLES,
  type ChartFont,
  type ChartStyle,
  type Density,
  type DesignPreset,
  type PageSize,
  type TableStyle,
  type TemplateDefinition,
} from "@/lib/templates/definition"
import type { PeriodKind } from "@/lib/templates/period"

/**
 * The design sample — what the appearance choices look like on a page.
 *
 * ## What this is, and the one thing it is not
 *
 * It is a picture of the **theme**: the face, the accent, the table rules, the spacing
 * and the page proportion, drawn over a declared sample so a consultant can see what
 * they just chose. It updates as they choose, with no server, no snapshot and no run.
 *
 * It is **not** a preview of this profile's document, and it must never be read as one.
 * That is `PaperPreview` — the emitter's own markup over a real compilation — and the
 * `.pdf` beneath it is the only artifact allowed to claim it is what will be delivered
 * (Requirement 14.6). So every figure here is from `preview-sample.ts`, the panel says
 * so in permanent visible text at the top and again in the page footer, and nothing in
 * this file can be configured to remove either.
 *
 * Two consequences follow from that separation, and both are deliberate:
 *
 * - **It holds a layout of its own, and may.** Requirement 14.1 forbids a second layout
 *   definition for the surface that *approximates the document*, because two emitters
 *   drift and the drift shows up as a preview that quietly stops resembling what ships.
 *   Nothing here depicts a compilation, so there is nothing to drift from — this is a
 *   sample page, in the way a paint chip is a sample wall.
 * - **It states no pagination.** The footer's `01` is part of the sample, not a count:
 *   a browser does not lay out Word's columns, so a page total here would be a guess.
 *
 * ## What IS real on it
 *
 * The structure. The report title, the customer, the document name and the section list
 * are the consultant's own — text they typed or chose, carried straight from the draft.
 * That is what makes this worth looking at rather than a swatch: the sections they
 * selected on step 2, in order, under the theme they are choosing now.
 */

// --- Reading the draft ------------------------------------------------------

function readDesign(definition: TemplateDefinition): Record<string, unknown> {
  const design = (definition as Record<string, unknown>).design
  return design !== null && typeof design === "object"
    ? (design as Record<string, unknown>)
    : {}
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

function chartStyleOf(definition: TemplateDefinition): ChartStyle {
  const value = readDesign(definition).chart_style
  return (CHART_STYLES as readonly string[]).includes(value as string)
    ? (value as ChartStyle)
    : "stacked"
}

function chartFontOf(definition: TemplateDefinition): ChartFont {
  const value = readDesign(definition).chart_font
  return (CHART_FONTS as readonly string[]).includes(value as string)
    ? (value as ChartFont)
    : "grotesque"
}

function accentOf(definition: TemplateDefinition): string {
  const value = readDesign(definition).accent_color
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : "#1f6f78"
}

/** The document name the front matter carries, read defensively — the field is `unknown`. */
function documentNameOf(definition: TemplateDefinition): string | null {
  const front = definition.front_matter
  if (typeof front !== "object" || front === null) return null
  const control = (front as Record<string, unknown>).document_control
  if (typeof control !== "object" || control === null) return null
  return readString(control as Record<string, unknown>, "document_name")
}

function coverEnabled(definition: TemplateDefinition): boolean {
  const front = definition.front_matter
  if (typeof front !== "object" || front === null) return true
  const cover = (front as Record<string, unknown>).cover
  if (typeof cover !== "object" || cover === null) return true
  return (cover as Record<string, unknown>).enabled !== false
}

/** The authored sections, in their authored order. */
function sectionTypes(definition: TemplateDefinition): readonly string[] {
  const sections = (definition as Record<string, unknown>).sections
  if (!Array.isArray(sections)) return []
  return sections.flatMap((section) =>
    typeof section === "object" &&
    section !== null &&
    typeof (section as Record<string, unknown>).type === "string"
      ? [(section as Record<string, unknown>).type as string]
      : []
  )
}

/**
 * How the period reads on a cover.
 *
 * A label, never a date: the window is resolved fresh at each run against the
 * customer's zone, so printing "1 – 31 August" here would be a specific claim about a
 * report that has not run and may never cover that month.
 */
const PERIOD_LABELS: Readonly<Record<PeriodKind, string>> = {
  last_24h: "Last 24 hours",
  last_7d: "Last 7 days",
  last_30d: "Last 30 days",
  last_full_month: "Last full month",
  mtd: "Month to date",
  custom: "A fixed window",
}

// --- Theme -> page -----------------------------------------------------------

/** The ink each preset sets body text in. Headings take the accent. */
const PRESET_INK: Readonly<Record<DesignPreset, string>> = {
  editorial: "#1c1a17",
  corporate: "#16232c",
  technical: "#1b2733",
  minimal: "#24262a",
}

/** Spacing multiplier. Density is the one choice with no visible control of its own. */
const DENSITY_SCALE: Readonly<Record<Density, number>> = {
  compact: 0.78,
  normal: 1,
  relaxed: 1.28,
}

/** Width ÷ height, so the page keeps its proportion at any rail width. */
const PAGE_RATIO: Readonly<Record<PageSize, number>> = {
  A4: 210 / 297,
  Letter: 8.5 / 11,
}

/**
 * The four table edges each style draws, plus its row stripe.
 *
 * **Every variant declares all four edges**, and none of them uses the `border`
 * shorthand. React warned about the mix the first time this rendered, and it was right
 * to: a shorthand and a longhand for the same edge are applied in an order React does
 * not guarantee across a re-render, so switching from `bordered` to `hairline` left the
 * side rules of the style that had just been deselected. Four longhands, always written,
 * means a switch replaces every edge rather than some of them.
 */
function tableRules(style: TableStyle, accent: string, rule: string) {
  const none = "none"
  const hair = `0.75px solid ${rule}`
  const under = `1.5px solid ${accent}`

  return {
    hairline: {
      header: { borderTop: none, borderRight: none, borderBottom: under, borderLeft: none },
      cell: {
        borderTop: none,
        borderRight: none,
        borderBottom: `0.5px solid ${rule}`,
        borderLeft: none,
      },
      stripe: "transparent",
    },
    banded: {
      header: { borderTop: none, borderRight: none, borderBottom: under, borderLeft: none },
      cell: { borderTop: none, borderRight: none, borderBottom: none, borderLeft: none },
      // A tint of the accent rather than a grey, so the banding belongs to the theme.
      stripe: `${accent}0f`,
    },
    bordered: {
      header: { borderTop: hair, borderRight: hair, borderBottom: under, borderLeft: hair },
      cell: { borderTop: hair, borderRight: hair, borderBottom: hair, borderLeft: hair },
      stripe: "transparent",
    },
  }[style]
}

// --- The component -----------------------------------------------------------

export function DocumentPreview({
  definition,
  sectionCatalogue,
}: Readonly<{
  definition: TemplateDefinition
  /** Resolved server-side, threaded through the wizard — `sections.ts` is `server-only`. */
  sectionCatalogue: readonly SectionCatalogueEntry[]
}>) {
  const design = definition.design
  const preset: DesignPreset = design?.preset ?? "corporate"
  const density: Density = design?.density ?? "normal"
  const tableStyle: TableStyle = design?.table_style ?? "hairline"
  const pageSize: PageSize = design?.page_size ?? "A4"
  const accent = accentOf(definition)
  const chartStyle = chartStyleOf(definition)
  const chartFont = chartFontOf(definition)

  const face = PRESET_FACES[preset]
  const ink = PRESET_INK[preset]
  const muted = `${ink}99`
  const rule = `${ink}26`
  const scale = DENSITY_SCALE[density]
  const rules = tableRules(tableStyle, accent, rule)

  const language = definition.identity?.language === "id" ? "id" : "en"
  const title =
    definition.identity?.report_title?.trim() ||
    definition.identity?.name?.trim() ||
    "Untitled report profile"
  const customer = definition.identity?.customer_name?.trim() ?? null
  const documentName = documentNameOf(definition)
  const periodLabel = PERIOD_LABELS[definition.period?.kind ?? "last_full_month"]

  const titles = useMemo(() => {
    const byKey = new Map(sectionCatalogue.map((entry) => [entry.key, entry]))
    return sectionTypes(definition).map((type) => {
      const entry = byKey.get(type)
      if (entry === undefined) return type
      return messageText(entry.title_id as MessageId, language) ?? entry.key
    })
  }, [definition, language, sectionCatalogue])

  const chartFace =
    chartFont === "document" ? face : CHART_FONT_STACKS[chartFont]

  const chart = useMemo(
    () => sampleChart({ style: chartStyle, accent, face: chartFace, ink, rule }),
    [accent, chartFace, chartStyle, ink, rule]
  )

  const pad = `${5.5 * scale}%`

  return (
    <section
      data-slot="document-preview"
      aria-label="Design sample"
      className="flex flex-col gap-2"
    >
      {/*
        Permanent, above the page, in the same container — the reader cannot scroll it
        away and there is no control that hides it. What makes this panel safe is that a
        consultant never has to work out whether the figures are theirs.
      */}
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
          Design sample
        </h3>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
          {pageSize} · sample figures
        </span>
      </div>

      <div
        data-slot="document-preview-page"
        data-preset={preset}
        data-density={density}
        data-table-style={tableStyle}
        data-page-size={pageSize}
        className="overflow-hidden rounded-lg border border-border shadow-sm"
        style={{
          aspectRatio: String(PAGE_RATIO[pageSize]),
          background: "#fff",
          color: ink,
          fontFamily: face,
          // Everything inside is sized in `cqw` so the whole page scales with the rail
          // rather than reflowing — a sample that reflows is a sample of a different
          // layout at every width.
          containerType: "inline-size",
        }}
      >
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            padding: pad,
            // The accent band a cover prints. Absent when the cover is switched off, so
            // the toggle on step 4 is visible here rather than only in a rendered file.
            borderTop: coverEnabled(definition)
              ? `2.2cqw solid ${accent}`
              : `0.35cqw solid ${rule}`,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "2.5cqw",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: muted,
            }}
          >
            {customer ?? "Customer"} · {periodLabel}
          </p>

          <h4
            style={{
              margin: `${2.6 * scale}cqw 0 0`,
              fontSize: "7.4cqw",
              lineHeight: 1.12,
              letterSpacing: "-0.02em",
              fontWeight: preset === "editorial" ? 400 : 600,
              color: accent,
            }}
          >
            {title}
          </h4>

          {documentName === null ? null : (
            <p style={{ margin: `${1.1 * scale}cqw 0 0`, fontSize: "2.9cqw", color: muted }}>
              {documentName}
            </p>
          )}

          <hr
            style={{
              width: "100%",
              border: 0,
              borderTop: `0.35cqw solid ${rule}`,
              margin: `${3 * scale}cqw 0 0`,
            }}
          />

          {/* The figures. Sample, and labelled as such at both ends of the page. */}
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "3cqw",
              margin: `${3 * scale}cqw 0 0`,
            }}
          >
            {SAMPLE_KPIS.map((kpi) => (
              <div key={kpi.label}>
                <dt
                  style={{
                    fontSize: "2.3cqw",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: muted,
                  }}
                >
                  {kpi.label}
                </dt>
                <dd
                  style={{
                    margin: "0.9cqw 0 0",
                    fontSize: "5.6cqw",
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "-0.015em",
                  }}
                >
                  {kpi.value}
                </dd>
              </div>
            ))}
          </dl>

          <div
            style={{ margin: `${3 * scale}cqw 0 0` }}
            /* The same ECharts engine the runtime draws with, over the same sample the
               chart cards on this step use — so the card a consultant clicked and the
               page beside it are the same picture. */
            dangerouslySetInnerHTML={{ __html: chart }}
          />

          <h5
            style={{
              margin: `${3.4 * scale}cqw 0 0`,
              fontSize: "3.4cqw",
              fontWeight: 600,
              color: accent,
            }}
          >
            Utilisation overview
          </h5>

          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              margin: `${1.4 * scale}cqw 0 0`,
              fontSize: "2.7cqw",
            }}
          >
            <thead>
              <tr>
                {["Resource", "Average", "Peak", "Memory"].map((heading, column) => (
                  <th
                    key={heading}
                    style={{
                      ...rules.header,
                      padding: `${1.1 * scale}cqw 1.2cqw`,
                      textAlign: column === 0 ? "left" : "right",
                      fontSize: "2.3cqw",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      fontWeight: 600,
                      color: muted,
                    }}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SAMPLE_ROWS.map((row, index) => (
                <tr
                  key={row.resource}
                  style={{ background: index % 2 === 1 ? rules.stripe : "transparent" }}
                >
                  {[row.resource, row.average, row.peak, row.memory].map(
                    (cell, column) => (
                      <td
                        key={cell}
                        style={{
                          ...rules.cell,
                          padding: `${1.1 * scale}cqw 1.2cqw`,
                          textAlign: column === 0 ? "left" : "right",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {cell}
                      </td>
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {/* The consultant's own structure — the one part of this page that is theirs. */}
          {titles.length === 0 ? null : (
            <div style={{ margin: `${3 * scale}cqw 0 0` }}>
              <p
                style={{
                  margin: 0,
                  fontSize: "2.3cqw",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: muted,
                }}
              >
                In this report
              </p>
              <ol
                style={{
                  margin: `${1.1 * scale}cqw 0 0`,
                  padding: 0,
                  listStyle: "none",
                  fontSize: "2.7cqw",
                  lineHeight: 1.75,
                }}
              >
                {titles.map((sectionTitle, index) => (
                  <li
                    key={`${sectionTitle}-${index}`}
                    style={{ display: "flex", gap: "1.6cqw" }}
                  >
                    <span
                      style={{
                        color: accent,
                        fontVariantNumeric: "tabular-nums",
                        minWidth: "4cqw",
                      }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {sectionTitle}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div
            style={{
              marginTop: "auto",
              paddingTop: `${2.4 * scale}cqw`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              fontSize: "2.2cqw",
              color: muted,
            }}
          >
            {/* Said again at the foot of the page, so a screenshot of the bottom half
                carries the disclaimer too. */}
            <span>Sample figures · {preset}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>01</span>
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Your theme, page size, table rules and section list — over{" "}
        <strong>sample figures</strong>. Nothing here is collected data. Render the
        real <code className="font-mono">.pdf</code> below to see the document itself.
      </p>
    </section>
  )
}

/** The page's chart: the shared sample, the chosen style, drawn by the runtime's engine. */
function sampleChart({
  style,
  accent,
  face,
  ink,
  rule,
}: Readonly<{
  style: ChartStyle
  accent: string
  face: string
  ink: string
  rule: string
}>): string {
  const rows =
    style === "stacked" || style === "sparkline" || style === "range_band"
      ? [
          { label: "Max", values: SAMPLE_MAX },
          { label: "Avg", values: SAMPLE_AVG },
        ]
      : [{ label: "Max", values: SAMPLE_MAX }]
  const split = style === "stacked" || style === "sparkline"

  const spec: ReportChartSpec = {
    style,
    type: "line",
    width: 640,
    height: 200,
    font: face.split(",")[0].replaceAll('"', ""),
    ink,
    muted: `${ink}99`,
    rule,
    emptyLabel: "",
    categories: SAMPLE_MAX.map((_, index) => String(index + 1)),
    panels: (split ? rows : rows.slice(0, 1)).map((row) => ({
      label: row.label,
      unit: "percent",
      min: 0,
      max: Math.max(...row.values) * 1.15,
    })),
    series: rows.map((row, index) => ({
      key: row.label,
      label: row.label,
      last: `${row.values.at(-1)}%`,
      panel: split ? index : 0,
      color: accent,
      dashed: index === 1,
      values: row.values.map(String),
    })),
    bands: style === "range_band" ? [{ lower: 1, upper: 0 }] : [],
  }

  // The ids ECharts generates are per-instance counters, so two charts on one page
  // collide on `clipPath` references. A fixed prefix per surface keeps this page's
  // definitions its own, the way the step's own cards do.
  return renderSVG(spec, true, init)
    .replace(/zr\d+/g, "document-preview")
    .replace(/<svg /, '<svg style="width:100%;height:auto;display:block" ')
}
