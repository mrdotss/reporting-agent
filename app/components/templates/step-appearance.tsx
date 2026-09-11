"use client"

import { useMemo } from "react"
import Image from "next/image"
import { init } from "echarts"
import {
  renderSVG,
  type ReportChartSpec,
} from "../../../agent/chart-renderer/svg.mjs"

import { StepDesign } from "@/components/templates/step-design"
import {
  CHART_FONTS,
  CHART_STYLES,
  type ChartFont,
  type ChartStyle,
  type TemplateDefinition,
} from "@/lib/templates/definition"
import type { ThemeThumbnail } from "@/lib/templates/theme-thumbnails"
import {
  CHART_FONT_STACKS,
  CHART_STYLE_NOTES,
} from "@/lib/profiles/chart-styles"
// The sample and the faces live beside the document preview's, because the two surfaces
// sit next to each other on this step and a chart card drawn from a different series or
// in a different face than the page beside it is a comparison of nothing.
import {
  PRESET_FACES,
  SAMPLE_AVG,
  SAMPLE_MAX,
} from "@/lib/profiles/preview-sample"

/**
 * Step 5 — Appearance: how every chart is drawn, and the theme it is drawn against.
 *
 * ## Why the chart lives beside the theme
 *
 * A chart's stroke is the document's accent and its labels are set in the document's
 * face, so the two decisions are one decision made twice. They were two steps apart —
 * the theme at the bottom of step 4, the chart nowhere at all — and a consultant
 * picking a teal accent had no way to see what it did to a chart until a run had
 * produced one.
 *
 * ## The previews are drawn here, and the real ones are not
 *
 * Every card below is inline SVG over one real series. The delivered chart is drawn by
 * the same ECharts SVG engine on the runtime, from the figure ledger, and these previews never touch a
 * figure — they are a picture of a *shape*, so a consultant can choose one. That is
 * also why they carry a fixed sample rather than the profile's own data: a profile has
 * no data until a run collects some.
 */


const STYLE_LABELS: Readonly<Record<ChartStyle, string>> = {
  stacked: "Stacked panels",
  soft_area: "Soft area",
  flat_area: "Flat tint",
  range_band: "Range band",
  columns: "Daily columns",
  sparkline: "Sparkline rows",
}

const FONT_LABELS: Readonly<Record<ChartFont, string>> = {
  document: "Document font",
  grotesque: "Grotesque",
  monospace: "Monospace",
}

const FONT_HINTS: Readonly<Record<ChartFont, string>> = {
  document:
    "The face the theme already uses, so the chart stops looking like a different document.",
  grotesque:
    "A neutral sans with tight numerals. What every chart used before this choice existed.",
  monospace:
    "Tabular figures — every digit the same width, so values line up down a gutter.",
}

function readDesign(definition: TemplateDefinition): Record<string, unknown> {
  const design = (definition as Record<string, unknown>).design
  return design !== null && typeof design === "object"
    ? (design as Record<string, unknown>)
    : {}
}

/** The stored choice, or the one that shipped before the field existed. */
function currentStyle(definition: TemplateDefinition): ChartStyle {
  const value = readDesign(definition).chart_style
  return (CHART_STYLES as readonly string[]).includes(value as string)
    ? (value as ChartStyle)
    : "stacked"
}

function currentFont(definition: TemplateDefinition): ChartFont {
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

function ChartPreview({
  style,
  accent,
  fontStack,
}: Readonly<{ style: ChartStyle; accent: string; fontStack: string }>) {
  const svg = useMemo(() => {
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
      width: 300,
      height: 110,
      font: fontStack.split(",")[0].replaceAll('"', ""),
      ink: "#25313b",
      muted: "#64717d",
      rule: "#e1e6ea",
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
    return renderSVG(spec, true, init).replace(/zr\d+/g, "report-preview")
  }, [style, accent, fontStack])
  return (
    <Image
      unoptimized
      alt={`${STYLE_LABELS[style]} preview`}
      width={300}
      height={110}
      className="block w-full"
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
    />
  )
}

export function StepAppearance({
  definition,
  onChange,
  thumbnails,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
  /** Resolved on the server — see `StepDesign`'s own note. Passed straight
   * through: this component never inspects a thumbnail. */
  thumbnails: readonly ThemeThumbnail[]
}>) {
  const style = currentStyle(definition)
  const font = currentFont(definition)
  const accent = accentOf(definition)
  const fontStack =
    font === "document"
      ? PRESET_FACES[definition.design.preset]
      : CHART_FONT_STACKS[font]

  const setDesign = (patch: Record<string, unknown>) => {
    onChange({
      ...definition,
      design: { ...readDesign(definition), ...patch },
    } as TemplateDefinition)
  }

  return (
    <div className="flex flex-col gap-8">
      <StepDesign
        definition={definition}
        onChange={onChange}
        thumbnails={thumbnails}
        controls="theme"
      />
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium tracking-tight">
            Chart design
          </h2>
          <p className="text-sm text-muted-foreground">
            Applies to every chart in the report. Each preview plots the same
            real series, so the shapes are comparable rather than flattering.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Chart design"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {CHART_STYLES.map((candidate) => {
            const selected = candidate === style
            const note = CHART_STYLE_NOTES[candidate]

            return (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setDesign({ chart_style: candidate })}
                className={`flex flex-col overflow-hidden rounded-lg border text-left transition-colors ${
                  selected
                    ? "border-primary ring-3 ring-primary/15"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <div
                  className={`px-3.5 pt-3.5 pb-1.5 ${selected ? "bg-primary/4" : "bg-card"}`}
                >
                  <ChartPreview
                    style={candidate}
                    accent={accent}
                    fontStack={fontStack}
                  />
                </div>

                <div className="flex flex-col gap-1.5 border-t border-border px-3.5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {STYLE_LABELS[candidate]}
                    </span>
                    {candidate === "stacked" ? (
                      <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        Default
                      </span>
                    ) : null}
                  </div>

                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {note.blurb}
                  </p>

                  <div className="mt-0.5 flex flex-wrap gap-1">
                    <OutputChip raster={note.raster} />
                    <Chip>Fits report content</Chip>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-8">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium tracking-tight">
            Chart font
          </h2>
          <p className="text-sm text-muted-foreground">
            The face a chart&rsquo;s labels and figures are set in. The previews
            above change with it.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Chart font"
          className="grid gap-2 sm:grid-cols-3"
        >
          {CHART_FONTS.map((candidate) => {
            const selected = candidate === font
            return (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setDesign({ chart_font: candidate })}
                className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? "border-primary bg-primary/4"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <span
                  className="text-sm font-medium"
                  style={{ fontFamily: CHART_FONT_STACKS[candidate] }}
                >
                  {FONT_LABELS[candidate]}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    18.30%
                  </span>
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {FONT_HINTS[candidate]}
                </span>
              </button>
            )
          })}
        </div>

        <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <InfoIcon />
          Each face is one the runtime already carries, so a chart renders the
          same on every run. A face the runtime does not have cannot be offered
          here — the chart is drawn on the server, not in your browser.
        </p>
      </section>

      <section className="flex flex-col gap-5 border-t border-border pt-8">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium tracking-tight">
            Tables and page layout
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose table borders, spacing and page size for the exported report.
          </p>
        </div>

        <StepDesign
          definition={definition}
          onChange={onChange}
          thumbnails={thumbnails}
          controls="details"
        />
      </section>
    </div>
  )
}

function Chip({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {children}
    </span>
  )
}

/**
 * Whether the chart's SVG is vector throughout, or carries a bitmap.
 *
 * Only the gradient does — matplotlib draws a ramp as an image and clips it — and it is
 * worth saying out loud, because the styled PDF is otherwise pure vector and someone
 * choosing on that basis has no other way to know.
 */
function OutputChip({ raster }: Readonly<{ raster: boolean }>) {
  if (raster) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 15l5-5 4 4 3-3 6 6" />
        </svg>
        Raster fill
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        aria-hidden="true"
      >
        <path d="M4 18 L10 8 L14 14 L20 5" />
      </svg>
      Vector
    </span>
  )
}

function InfoIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className="mt-0.5 shrink-0"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" strokeLinecap="round" />
      <circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}
