"use client"

import { useId } from "react"

import { useBuilder } from "@/components/builder/context"
import { CHART_STYLE_NOTES } from "@/lib/profiles/chart-styles"
import { PRESET_HEADING_FACES } from "@/lib/profiles/preview-sample"
import { ACCENT_SWATCHES, NEW_THEMES, THEME_LABELS, pageDesign, themeAccent } from "@/lib/builder/theme"
import {
  CHART_FONTS,
  CHART_STYLES,
  DESIGN_PRESETS,
  type ChartStyle,
} from "@/lib/templates/definition"
import { cn } from "@/lib/utils"

/**
 * The document's look: theme, accent, density, tables, charts, page.
 *
 * Every control writes `design` and the page redraws as it changes. These apply to the
 * whole document; a block's own settings live in the inspector.
 */

const CHART_STYLE_NAMES: Readonly<Record<ChartStyle, string>> = {
  stacked: "Stacked",
  soft_area: "Soft area",
  flat_area: "Flat area",
  range_band: "Range band",
  columns: "Columns",
  sparkline: "Sparkline",
}

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
            "h-[26px] flex-1 rounded-md px-2 text-[12.5px] whitespace-nowrap text-muted-foreground",
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
      {hint && <span className="text-[11.5px] text-muted-foreground">{hint}</span>}
    </div>
  )
}

export function ThemePanel() {
  const definition = useBuilder((state) => state.definition)
  const edit = useBuilder((state) => state.edit)
  const design = pageDesign(definition)
  const hexId = useId()
  const set = (key: string, value: unknown) =>
    edit((draft) => {
      ;(draft.design as Record<string, unknown>)[key] = value
    })
  const accent = typeof definition.design.accent_color === "string" ? definition.design.accent_color : design.spec.accent
  const decimals = (definition.design.number_format as { decimal_places?: number } | undefined)?.decimal_places ?? 2

  return (
    <div className="flex flex-col gap-5 pb-4">
      <Field label="Theme">
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
                    // A theme brings its own accent; picking another accent afterwards keeps it.
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
      </Field>

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

      <Field label="Tables">
        <Segmented
          label="Table style"
          value={design.tableStyle}
          options={[
            { value: "hairline", label: "Hairline" },
            { value: "banded", label: "Banded" },
            { value: "bordered", label: "Bordered" },
          ]}
          onChange={(value) => set("table_style", value)}
        />
      </Field>

      <Field label="Charts" hint={CHART_STYLE_NOTES[design.chartStyle].blurb}>
        <div role="radiogroup" aria-label="Chart style" className="grid grid-cols-3 gap-1.5">
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

      <Field label="Page">
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
    </div>
  )
}
