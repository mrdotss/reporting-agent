"use client"

import { CaretDownIcon } from "@phosphor-icons/react"
import { useId, useState } from "react"

import { CHART_STYLE_NAMES } from "@/components/builder/canvas/labels"
import { useBuilder } from "@/components/builder/context"
import { CHART_STYLE_NOTES } from "@/lib/profiles/chart-styles"
import { PRESET_HEADING_FACES } from "@/lib/profiles/preview-sample"
import {
  ACCENT_SWATCHES,
  LOOK_KEYS,
  NEW_THEMES,
  THEME_LABELS,
  pageDesign,
  themeAccent,
  themeLook,
  type Look,
} from "@/lib/builder/theme"
import {
  CHART_FONTS,
  CHART_STYLES,
  DESIGN_PRESETS,
  STYLE_THRESHOLD_MAX,
  STYLE_THRESHOLD_MIN,
} from "@/lib/templates/definition"
import { cn } from "@/lib/utils"

/**
 * The document's look, grouped: theme, colour, type, tables, charts, callouts, page.
 *
 * A theme sets every value. What the author changes is stored in `design.style` as an
 * override and kept when the theme changes; choosing the theme's own value again removes the
 * override, so `style` holds only what differs. Each group says how many of its values
 * differ, and the list at the top resets any of them. A block's own look lives in the
 * inspector's Style tab.
 */


export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}>) {
  return (
    <div role="group" aria-label={label} className="flex gap-0.5 rounded-lg bg-muted p-[3px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-[26px] min-w-0 flex-1 truncate rounded-md px-2 text-[12.5px] whitespace-nowrap text-muted-foreground",
            option.value === value && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,20,30,.08)]"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children, hint }: Readonly<{ label: string; children: React.ReactNode; hint?: string }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] leading-snug text-muted-foreground">{hint}</span>}
    </div>
  )
}

type Choice<K extends keyof Look> = { key: K; label: string; options: readonly { value: Exclude<Look[K], null>; label: string }[] }

const CHOICES = {
  headingColor: { key: "headingColor", label: "Headings", options: [{ value: "accent", label: "Accent" }, { value: "ink", label: "Ink" }] },
  chartPalette: {
    key: "chartPalette",
    label: "Chart colours",
    options: [{ value: "standard", label: "Distinct" }, { value: "shades", label: "Accent shades" }, { value: "greys", label: "Accent + greys" }],
  },
  fonts: {
    key: "fonts",
    label: "Faces",
    options: [
      { value: "theme", label: "Theme" },
      { value: "plex", label: "Plex" },
      { value: "source", label: "Source" },
      { value: "archivo", label: "Archivo" },
      { value: "serif", label: "Serif" },
    ],
  },
  textSize: { key: "textSize", label: "Text size", options: [{ value: "small", label: "Small" }, { value: "normal", label: "Normal" }, { value: "large", label: "Large" }] },
  figures: { key: "figures", label: "Figures", options: [{ value: "mono", label: "Monospaced" }, { value: "text", label: "Text face" }] },
  tableHeader: {
    key: "tableHeader",
    label: "Header",
    options: [{ value: "rule", label: "Rule" }, { value: "tint", label: "Tint" }, { value: "solid", label: "Solid" }, { value: "plain", label: "Plain" }],
  },
  chartLine: { key: "chartLine", label: "Line weight", options: [{ value: "thin", label: "Thin" }, { value: "regular", label: "Regular" }, { value: "bold", label: "Bold" }] },
  chartGrid: { key: "chartGrid", label: "Grid", options: [{ value: "none", label: "None" }, { value: "light", label: "Light" }, { value: "full", label: "Full" }] },
  chartValues: { key: "chartValues", label: "Value labels", options: [{ value: "last", label: "Last value" }, { value: "peak", label: "Peak" }, { value: "none", label: "None" }] },
  chartLegend: { key: "chartLegend", label: "Legend", options: [{ value: "line_ends", label: "Line ends" }, { value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }] },
  callout: { key: "callout", label: "Callouts", options: [{ value: "rule", label: "Rule" }, { value: "boxed", label: "Boxed" }, { value: "banner", label: "Banner" }] },
  cover: { key: "cover", label: "Cover", options: [{ value: "band", label: "Band" }, { value: "full_bleed", label: "Full bleed" }, { value: "summary", label: "Title strip" }] },
  sectionNumbers: {
    key: "sectionNumbers",
    label: "Section numbers",
    options: [{ value: "inline", label: "Inline" }, { value: "display", label: "Large" }, { value: "none", label: "None" }],
  },
  margins: { key: "margins", label: "Margins", options: [{ value: "narrow", label: "Narrow" }, { value: "normal", label: "Normal" }, { value: "wide", label: "Wide" }] },
  runningHeader: {
    key: "runningHeader",
    label: "Running header",
    options: [{ value: "section", label: "Section" }, { value: "customer", label: "Customer" }, { value: "none", label: "None" }],
  },
} as const satisfies { [K in keyof Look]?: Choice<K> }

const THRESHOLD_LABELS = { markAtOrAbove: "Mark table values at or above", chartThreshold: "Threshold line on charts at" } as const

const GROUPS = [
  { id: "theme", title: "Theme", keys: [] },
  { id: "colour", title: "Colour", keys: ["headingColor", "chartPalette"] },
  { id: "type", title: "Type", keys: ["fonts", "textSize", "figures"] },
  { id: "tables", title: "Tables", keys: ["tableHeader", "markAtOrAbove"] },
  { id: "charts", title: "Charts", keys: ["chartLine", "chartGrid", "chartValues", "chartLegend", "chartThreshold"] },
  { id: "callouts", title: "Callouts", keys: ["callout"] },
  { id: "page", title: "Page & cover", keys: ["cover", "sectionNumbers", "margins", "runningHeader"] },
] as const satisfies readonly { id: string; title: string; keys: readonly (keyof Look)[] }[]

type GroupId = (typeof GROUPS)[number]["id"]

function labelOf(key: keyof Look, value: Look[keyof Look]): string {
  if (key === "markAtOrAbove" || key === "chartThreshold") return value === null ? "Off" : `${value}%`
  const choice = (CHOICES as Record<string, Choice<keyof Look>>)[key]
  return choice?.options.find((option) => option.value === value)?.label ?? String(value)
}

function nameOf(key: keyof Look): string {
  if (key === "markAtOrAbove") return "Marked values"
  if (key === "chartThreshold") return "Chart threshold"
  return (CHOICES as Record<string, Choice<keyof Look>>)[key]?.label ?? key
}

export function ThemePanel() {
  const definition = useBuilder((state) => state.definition)
  const edit = useBuilder((state) => state.edit)
  const design = pageDesign(definition)
  const hexId = useId()
  const [open, setOpen] = useState<GroupId | null>("theme")
  const set = (key: string, value: unknown) =>
    edit((draft) => {
      ;(draft.design as Record<string, unknown>)[key] = value
    })
  const base = themeLook(design.preset)
  const stored = ((definition.design as Record<string, unknown>).style ?? {}) as Record<string, unknown>
  const changed = (Object.keys(LOOK_KEYS) as (keyof Look)[]).filter((key) => LOOK_KEYS[key] in stored)

  /** One override: the theme's own value removes it, so `style` holds only what differs. */
  const setLook = <K extends keyof Look>(key: K, value: Look[K]) =>
    edit((draft) => {
      const designDraft = draft.design as Record<string, unknown>
      const style = { ...((designDraft.style as Record<string, unknown> | undefined) ?? {}) }
      if (value === base[key] || value === null) delete style[LOOK_KEYS[key]]
      else style[LOOK_KEYS[key]] = value
      if (Object.keys(style).length === 0) delete designDraft.style
      else designDraft.style = style
    })
  const reset = (keys: readonly (keyof Look)[]) =>
    edit((draft) => {
      const designDraft = draft.design as Record<string, unknown>
      const style = { ...((designDraft.style as Record<string, unknown> | undefined) ?? {}) }
      for (const key of keys) delete style[LOOK_KEYS[key]]
      if (Object.keys(style).length === 0) delete designDraft.style
      else designDraft.style = style
    })

  const accent = typeof definition.design.accent_color === "string" ? definition.design.accent_color : design.spec.accent
  const decimals = (definition.design.number_format as { decimal_places?: number } | undefined)?.decimal_places ?? 2

  const choice = <K extends keyof typeof CHOICES>(key: K, hint?: string) => {
    const spec = CHOICES[key] as unknown as Choice<K>
    return (
      <Field key={key} label={spec.label} hint={hint}>
        <Segmented
          label={spec.label}
          value={design.look[key] as string}
          options={spec.options.map((option) => ({ value: option.value as string, label: option.label }))}
          onChange={(value) => setLook(key, value as Look[K])}
        />
      </Field>
    )
  }
  const threshold = (key: "markAtOrAbove" | "chartThreshold", hint: string) => {
    const value = design.look[key]
    return (
      <div key={key} className="flex flex-col gap-1.5">
        <label className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
          {THRESHOLD_LABELS[key]}
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              aria-label={THRESHOLD_LABELS[key]}
              min={STYLE_THRESHOLD_MIN}
              max={STYLE_THRESHOLD_MAX}
              disabled={value === null}
              value={value ?? 80}
              onChange={(event) => {
                const next = Math.round(Number(event.target.value))
                if (next >= STYLE_THRESHOLD_MIN && next <= STYLE_THRESHOLD_MAX) setLook(key, next)
              }}
              className="h-7 w-14 rounded-md border border-input bg-background px-1.5 text-right font-mono text-xs text-foreground disabled:opacity-50"
            />
            %
            <button
              type="button"
              role="switch"
              aria-checked={value !== null}
              aria-label={`${THRESHOLD_LABELS[key]}: ${value === null ? "off" : "on"}`}
              onClick={() => setLook(key, value === null ? 80 : null)}
              className={cn("flex h-5 w-[34px] shrink-0 rounded-full p-0.5", value === null ? "bg-input" : "justify-end bg-primary")}
            >
              <span className="size-4 rounded-full bg-white shadow-sm" />
            </button>
          </span>
        </label>
        <span className="text-[11.5px] leading-snug text-muted-foreground">{hint}</span>
      </div>
    )
  }

  const body = (id: GroupId) => {
    switch (id) {
      case "theme":
        return (
          <div role="radiogroup" aria-label="Theme" className="flex flex-col gap-1.5">
            {DESIGN_PRESETS.map((preset) => {
              const on = design.preset === preset
              return (
                <button
                  key={preset}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() =>
                    edit((draft) => {
                      // A theme brings its own accent; the style's overrides stay.
                      const designDraft = draft.design as Record<string, unknown>
                      designDraft.preset = preset
                      designDraft.accent_color = themeAccent(preset)
                    })
                  }
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border border-border bg-card p-2 text-left hover:border-input",
                    on && "border-primary shadow-[0_0_0_2px_color-mix(in_oklab,var(--primary)_18%,transparent)]"
                  )}
                >
                  <span
                    aria-hidden
                    className="grid size-8 shrink-0 place-items-center rounded bg-muted text-[15px] font-bold"
                    style={{ fontFamily: PRESET_HEADING_FACES[preset], color: themeAccent(preset) }}
                  >
                    Aa
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                      {THEME_LABELS[preset].name}
                      {NEW_THEMES.has(preset) && (
                        <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">New</span>
                      )}
                    </span>
                    <span className="truncate text-[11.5px] text-muted-foreground">{THEME_LABELS[preset].note}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )
      case "colour":
        return (
          <>
            <Field label="Accent">
              <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap items-center gap-2">
                {ACCENT_SWATCHES.map((swatch) => {
                  const on = accent.toLowerCase() === swatch.hex.toLowerCase()
                  return (
                    <button
                      key={swatch.hex}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={swatch.label}
                      title={swatch.label}
                      onClick={() => set("accent_color", swatch.hex)}
                      className={cn(
                        "size-[22px] rounded-full border-2 border-card shadow-[0_0_0_1px_var(--border)]",
                        on && "shadow-[0_0_0_2px_var(--primary)]"
                      )}
                      style={{ background: swatch.hex }}
                    />
                  )
                })}
                <label htmlFor={hexId} className="sr-only">Custom accent</label>
                <input
                  id={hexId}
                  value={accent}
                  onChange={(event) => {
                    const value = event.target.value.trim()
                    if (/^#[0-9a-fA-F]{0,6}$/.test(value)) set("accent_color", value)
                  }}
                  className="h-7 w-[84px] rounded-md border border-input bg-background px-2 font-mono text-xs"
                />
              </div>
            </Field>
            {choice("chartPalette", "Distinct keeps series apart by lightness as well as hue.")}
            {choice("headingColor")}
          </>
        )
      case "type":
        return (
          <>
            {choice("fonts", "Only faces the report image carries, so the PDF sets what you see.")}
            {choice("textSize")}
            {choice("figures")}
          </>
        )
      case "tables":
        return (
          <>
            <Field label="Rows">
              <Segmented
                label="Table rows"
                value={design.tableStyle}
                options={[
                  { value: "hairline", label: "Hairline" },
                  { value: "banded", label: "Zebra" },
                  { value: "bordered", label: "Boxed" },
                  { value: "open", label: "Open" },
                ]}
                onChange={(value) => set("table_style", value)}
              />
            </Field>
            {choice("tableHeader")}
            <Field label="Density">
              <Segmented
                label="Density"
                value={design.density}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "normal", label: "Normal" },
                  { value: "relaxed", label: "Relaxed" },
                ]}
                onChange={(value) => set("density", value)}
              />
            </Field>
            {threshold("markAtOrAbove", "Colours a percentage cell at or above it. It adds no number, and the setting never prints.")}
          </>
        )
      case "charts":
        return (
          <>
            <Field label="Look" hint={CHART_STYLE_NOTES[design.chartStyle].blurb}>
              <div role="radiogroup" aria-label="Chart look" className="grid grid-cols-2 gap-1.5">
                {CHART_STYLES.map((style) => (
                  <button
                    key={style}
                    type="button"
                    role="radio"
                    aria-checked={design.chartStyle === style}
                    onClick={() => set("chart_style", style)}
                    className={cn(
                      "rounded-md border border-border bg-card px-1.5 py-1.5 text-[11.5px] text-muted-foreground hover:border-input",
                      design.chartStyle === style && "border-primary font-semibold text-foreground"
                    )}
                  >
                    {CHART_STYLE_NAMES[style]}
                  </button>
                ))}
              </div>
            </Field>
            {choice("chartLine")}
            {choice("chartGrid")}
            {choice("chartValues", "A label is a plotted value, so it is a ledger figure like any other.")}
            {choice("chartLegend")}
            {threshold("chartThreshold", "A dashed line on percentage charts, named in words.")}
            <Field label="Chart lettering">
              <Segmented
                label="Chart font"
                value={design.chartFont}
                options={CHART_FONTS.map((font) => ({
                  value: font,
                  label: font === "document" ? "Document" : font === "grotesque" ? "Grotesque" : "Mono",
                }))}
                onChange={(value) => set("chart_font", value)}
              />
            </Field>
          </>
        )
      case "callouts":
        return choice("callout")
      case "page":
        return (
          <>
            {choice("cover")}
            {choice("sectionNumbers", "Section numbers and the running header are the styled PDF's; the Word file has neither.")}
            {choice("margins")}
            {choice("runningHeader")}
            <Field label="Page size">
              <Segmented
                label="Page size"
                value={design.pageSize}
                options={[
                  { value: "A4", label: "A4" },
                  { value: "Letter", label: "Letter" },
                ]}
                onChange={(value) => set("page_size", value)}
              />
            </Field>
            <Field label="Decimal places" hint="How many decimals every figure prints with.">
              <Segmented
                label="Decimal places"
                value={String(decimals) as "0" | "1" | "2" | "3"}
                options={(["0", "1", "2", "3"] as const).map((value) => ({ value, label: value }))}
                onChange={(value) =>
                  edit((draft) => {
                    const format = ((draft.design as Record<string, unknown>).number_format ??= {}) as Record<string, unknown>
                    format.decimal_places = Number(value)
                  })
                }
              />
            </Field>
          </>
        )
    }
  }

  const summary = (id: GroupId): string => {
    const look = design.look
    switch (id) {
      case "theme":
        return `${THEME_LABELS[design.preset].name} · ${THEME_LABELS[design.preset].note}`
      case "colour":
        return `${ACCENT_SWATCHES.find((s) => s.hex.toLowerCase() === accent.toLowerCase())?.label ?? accent} accent · ${labelOf("chartPalette", look.chartPalette).toLowerCase()}`
      case "type":
        return `${look.fonts === "theme" ? "Theme faces" : `${labelOf("fonts", look.fonts)} faces`} · ${look.textSize} text`
      case "tables":
        return `${labelOf("tableHeader", look.tableHeader)} header · ${design.tableStyle === "banded" ? "zebra" : design.tableStyle === "bordered" ? "boxed" : design.tableStyle} rows`
      case "charts":
        return `${CHART_STYLE_NAMES[design.chartStyle]} · legend ${labelOf("chartLegend", look.chartLegend).toLowerCase()}`
      case "callouts":
        return `${labelOf("callout", look.callout)}`
      case "page":
        return `${labelOf("cover", look.cover)} cover · ${labelOf("sectionNumbers", look.sectionNumbers).toLowerCase()} numbers`
    }
  }

  return (
    <div className="flex flex-col gap-2 pb-4">
      <p className="text-[12px] leading-snug text-muted-foreground">
        A theme sets every value below. What you change is kept as an override, and stays when you switch theme.
      </p>

      {changed.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
          <span className="flex items-center justify-between gap-2 text-[12.5px] font-semibold">
            Changed from {THEME_LABELS[design.preset].name}
            <button type="button" onClick={() => reset(changed)} className="h-6 rounded-md border border-input px-2 text-[11.5px] font-medium hover:bg-muted">
              Reset all
            </button>
          </span>
          <ul className="flex flex-col gap-1">
            {changed.map((key) => (
              <li key={key} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="min-w-0 truncate">
                  {nameOf(key)}: <b className="font-semibold">{labelOf(key, design.look[key])}</b>
                  <span className="text-muted-foreground"> · theme: {labelOf(key, base[key])}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Reset ${nameOf(key)}`}
                  onClick={() => reset([key])}
                  className="h-6 shrink-0 rounded-md px-1.5 text-[11.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Reset
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {GROUPS.map((group) => {
        const isOpen = open === group.id
        const count = (group.keys as readonly (keyof Look)[]).filter((key) => changed.includes(key)).length
        return (
          <section key={group.id} className="overflow-hidden rounded-lg border border-border bg-card">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : group.id)}
              className="flex min-h-11 w-full items-center gap-2 px-2.5 text-left hover:bg-muted/60"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                  {group.title}
                  {count > 0 && <span className="text-[11px] font-medium text-primary">{count} changed</span>}
                </span>
                <span className="truncate text-[11.5px] text-muted-foreground">{summary(group.id)}</span>
              </span>
              <CaretDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
            </button>
            {isOpen && <div className="flex flex-col gap-3.5 px-2.5 pt-1 pb-3">{body(group.id)}</div>}
          </section>
        )
      })}
    </div>
  )
}
