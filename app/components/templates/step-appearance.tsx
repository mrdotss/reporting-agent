"use client"

import { useId } from "react"

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
  chartPreviewPaths,
} from "@/lib/profiles/chart-styles"

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
 * matplotlib on the runtime, from the figure ledger, and these previews never touch a
 * figure — they are a picture of a *shape*, so a consultant can choose one. That is
 * also why they carry a fixed sample rather than the profile's own data: a profile has
 * no data until a run collects some.
 */

/** The sample the previews plot: a real machine's August CPU, 31 daily points.
 *
 * Real rather than synthetic on purpose. The spread — a 27.31% peak against a 0.19%
 * average — is what makes the case for the stacked default, and a smooth invented curve
 * would have shown six shapes that all looked equally reasonable. */
const SAMPLE_MAX = [
  18.9, 10.6, 11.1, 5.2, 11.0, 9.7, 21.6, 8.4, 10.3, 10.2, 27.3, 11.8, 9.5, 10.3,
  10.2, 9.4, 10.2, 11.1, 13.4, 13.3, 13.9, 14.6, 7.4, 10.2, 12.8, 13.9, 14.0,
  24.5, 10.7, 8.9, 9.9,
]
const SAMPLE_AVG = [
  0.19, 0.17, 0.17, 0.17, 0.18, 0.18, 0.2, 0.17, 0.16, 0.17, 0.18, 0.18, 0.19,
  0.19, 0.19, 0.18, 0.17, 0.17, 0.17, 0.18, 0.18, 0.17, 0.16, 0.17, 0.17, 0.17,
  0.18, 0.22, 0.18, 0.18, 0.19,
]

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
  grotesque: "A neutral sans with tight numerals. What every chart used before this choice existed.",
  monospace: "Tabular figures — every digit the same width, so values line up down a gutter.",
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
  const gradientId = useId()
  const paths = chartPreviewPaths(style, SAMPLE_MAX, SAMPLE_AVG)

  return (
    <svg
      viewBox="0 0 236 78"
      width="100%"
      height={78}
      role="img"
      aria-label={`${STYLE_LABELS[style]} preview`}
      style={{ display: "block", fontFamily: fontStack }}
    >
      {style === "soft_area" ? (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.34" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>
      ) : null}

      <g stroke="currentColor" strokeWidth={1} className="text-border">
        {paths.rules.map((y) => (
          <line key={y} x1="0" y1={y} x2="236" y2={y} />
        ))}
      </g>

      {paths.fill ? (
        <polygon
          points={paths.fill}
          fill={style === "soft_area" ? `url(#${gradientId})` : accent}
          opacity={style === "soft_area" ? 1 : style === "range_band" ? 0.16 : 0.12}
        />
      ) : null}

      {paths.bars
        ? paths.bars.map((bar, index) => (
            <rect
              key={index}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx={1.2}
              fill={accent}
              opacity={0.85}
            />
          ))
        : null}

      {paths.lines.map((line, index) => (
        <polyline
          key={index}
          points={line.points}
          fill="none"
          stroke={accent}
          strokeWidth={line.width}
          strokeDasharray={line.dashed ? "3 2.5" : undefined}
          strokeLinejoin="round"
          strokeLinecap={line.rounded ? "round" : undefined}
          opacity={line.opacity}
        />
      ))}

      {paths.dot ? (
        <circle
          cx={paths.dot.x}
          cy={paths.dot.y}
          r={2.6}
          fill={accent}
          stroke="var(--card)"
          strokeWidth={1}
        />
      ) : null}

      {paths.labels.map((label) => (
        <text
          key={label.text + label.y}
          x={label.x}
          y={label.y}
          fontSize={label.size}
          fill={label.muted ? "var(--muted-foreground)" : "var(--foreground)"}
        >
          {label.text}
        </text>
      ))}
    </svg>
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
  const fontStack = CHART_FONT_STACKS[font]

  const setDesign = (patch: Record<string, unknown>) => {
    onChange({
      ...definition,
      design: { ...readDesign(definition), ...patch },
    } as TemplateDefinition)
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium tracking-tight">
            Chart design
          </h2>
          <p className="text-sm text-muted-foreground">
            Applies to every chart in the report. Each preview plots the same real
            series, so the shapes are comparable rather than flattering.
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
                    <Chip>{note.height} of page</Chip>
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
            The face a chart&rsquo;s labels and figures are set in. The previews above
            change with it.
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
          Each face is one the runtime already carries, so a chart renders the same on
          every run. A face the runtime does not have cannot be offered here — the chart
          is drawn on the server, not in your browser.
        </p>
      </section>

      <section className="flex flex-col gap-5 border-t border-border pt-8">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium tracking-tight">
            Document theme
          </h2>
          <p className="text-sm text-muted-foreground">
            The theme the document is rendered against, and what the theme leaves
            tunable. The accent below is also every chart&rsquo;s stroke.
          </p>
        </div>

        <StepDesign
          definition={definition}
          onChange={onChange}
          thumbnails={thumbnails}
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
