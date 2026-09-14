"use client"

import { useMemo, useId } from "react"

import { StylePresetPicker } from "@/components/templates/style-preset-picker"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  DENSITY_VALUES,
  LANGUAGES,
  MAX_DECIMAL_PLACES,
  MIN_DECIMAL_PLACES,
  PAGE_SIZE_VALUES,
  SEPARATOR_DEFAULTS,
  TABLE_STYLE_VALUES,
  resolveSeparators,
  type DesignSpec,
  type TemplateDefinition,
} from "@/lib/templates/definition"

/**
 * Step 6 — design (Requirements 7.1, 7.2, 11.1).
 *
 * Theme and accent controls may render above the chart previews, while table
 * and page controls stay together below them.
 *
 * ## Every value is one of a closed set, read from the schema
 *
 * `DENSITY_VALUES`, `TABLE_STYLE_VALUES` and `PAGE_SIZE_VALUES` are the
 * validator's own constants, so a value added to the schema appears here without
 * an edit and a value removed stops being offered. A hand-written list in this
 * file is how a wizard comes to offer a fourth density the compiler refuses.
 */

const DENSITY_SUMMARY: Readonly<
  Record<(typeof DENSITY_VALUES)[number], string>
> = {
  compact: "Tighter leading and table padding — more rows per page.",
  normal: "The theme's own spacing.",
  relaxed: "More air. Fewer rows per page, easier to read at a glance.",
}

/**
 * The characters a definition may declare as a decimal or grouping separator
 * (Requirement 16.2). One code point, not a digit, not a minus sign, not whitespace, and
 * the two may not be equal. `.` `,` `'` and ` ` (thin space) cover the real-world set a
 * consultant would reach for — the Select offers these while the validator accepts any
 * legal single character typed into the Input.
 *
 * Note: thin space (`\u2009`) is *historically* the Swiss grouping separator but is now
 * rejected by the validator (whitespace), so we offer the right single quote (U+2019,
 * the digit grouping apostrophe ISO 31-0 recommends) instead.
 */
const DECIMAL_SEPARATOR_OPTIONS = [".", ",", "\u2019"] as const
const GROUPING_SEPARATOR_OPTIONS = [",", ".", " ", "\u2019"] as const

/**
 * Human-readable label for a separator character.
 */
function separatorLabel(char: string): string {
  switch (char) {
    case ".":
      return ". (period)"
    case ",":
      return ", (comma)"
    case "\u2019":
      return "\u2019 (apostrophe)"
    case " ":
      return "(space)"
    default:
      return char
  }
}

/**
 * The three sample values shown in the design step (Requirement 16.9).
 *
 * They exercise three scale regions: sub-unit (a percentage), hundreds (a capacity), and
 * millions (a byte count). Their `unit` suffix makes the sample readable as a real figure.
 */
const SAMPLE_VALUES: readonly {
  readonly value: number
  readonly unit: string
  readonly suffix: string
}[] = [
  { value: 0.58, unit: "percent", suffix: "%" },
  { value: 462.81, unit: "bytes_gb", suffix: " GB" },
  { value: 1234567.5, unit: "bytes", suffix: " B" },
]

/**
 * Format a sample figure using the declared separators, decimal places and grouping
 * setting — **client-side only**, for preview. The real formatting lives in
 * `agent/.../compile/format.py` and this must produce an identical result for the same
 * inputs, which Property 2 (`number_format_agreement`) asserts.
 */
export function formatSampleFigure(
  value: number,
  opts: {
    decimalPlaces: number
    groupThousands: boolean
    decimalSeparator: string
    groupingSeparator: string
  }
): string {
  const { decimalPlaces, groupThousands, decimalSeparator, groupingSeparator } =
    opts

  // Quantize to the declared decimal places, rounding half away from zero.
  const factor = 10 ** decimalPlaces
  const sign = value < 0 ? -1 : 1
  const abs = Math.abs(value)
  const quantized = (Math.round(abs * factor) / factor).toFixed(decimalPlaces)

  const [integerPart, fractionPart] = quantized.split(".")

  // Group the integer part rightward in groups of 3.
  let grouped = integerPart
  if (groupThousands && integerPart.length > 3) {
    const groups: string[] = []
    let remaining = integerPart
    while (remaining.length > 3) {
      groups.push(remaining.slice(-3))
      remaining = remaining.slice(0, -3)
    }
    groups.push(remaining)
    grouped = groups.reverse().join(groupingSeparator)
  }

  let rendered = grouped
  if (decimalPlaces > 0 && fractionPart !== undefined) {
    rendered = `${grouped}${decimalSeparator}${fractionPart}`
  }

  return sign < 0 ? `-${rendered}` : rendered
}

export function StepDesign({
  definition,
  onChange,
  controls = "all",
}: Readonly<{
  controls?: "all" | "theme" | "details"
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
}>) {
  const accentId = useId()
  const decimalsId = useId()

  const design = definition.design

  const set = (patch: Partial<DesignSpec>) => {
    onChange({ ...definition, design: { ...design, ...patch } })
  }

  return (
    <div className="flex flex-col gap-5">
      {controls !== "details" && (
        <section className="flex flex-col gap-6 rounded-xl border border-border p-4">
          {/*
            The four themes as rendered pages, not as four words in a select.

            Requirement 13.3, and `design-system.md` states the reason: "a theme is a
            visual decision, and a dropdown of words gives the user nothing to decide
            with". This is the decision that determines what the customer's delivered
            PDF looks like, so it is made against pictures of the page.

            A list rather than a grid of page images. The images were the earlier
            answer and they cost more than they returned: four rendered pages at
            thumbnail size show mostly grey text, the difference between two themes is
            legible only at a size the rail cannot give, and each one had to be hashed
            against its theme document on every render to prove it was not stale.

            What actually distinguishes these four is stated in words instead — the
            heading face, the table treatment, the density — which reads at any size
            and needs no freshness check to stay true.
          */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h3 className="text-title-sm">Document theme</h3>
              <p className="text-meta max-w-prose">
                What each theme does to the page: its headings, its tables, and how
                much air it leaves.
              </p>
            </div>

            <StylePresetPicker
              selected={design.preset}
              onSelect={(preset) => set({ preset })}
            />
          </div>

          <div className="border-t border-border pt-5">
            <Field>
              <FieldLabel htmlFor={accentId}>Accent colour</FieldLabel>
              <div className="flex items-center gap-3">
                <Input
                  type="color"
                  aria-label="Pick accent colour"
                  className="h-9 w-10 shrink-0 cursor-pointer rounded-md p-1"
                  value={
                    /^#[0-9a-f]{6}$/i.test(design.accent_color)
                      ? design.accent_color
                      : "#1f6f78"
                  }
                  onChange={(event) =>
                    set({ accent_color: event.target.value })
                  }
                />
                <Input
                  id={accentId}
                  className="max-w-36 rounded-md font-mono text-xs"
                  value={design.accent_color}
                  onChange={(event) =>
                    set({ accent_color: event.target.value })
                  }
                  placeholder="#1f6f78"
                />
              </div>
              <div className="flex gap-2" aria-label="Accent swatches">
                {["#1f6f78", "#183b63", "#6d4c91", "#a34d24", "#30343b"].map(
                  (color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Use accent ${color}`}
                      aria-pressed={design.accent_color === color}
                      onClick={() => set({ accent_color: color })}
                      className="size-6 rounded-full border-2 border-background ring-1 ring-border focus-visible:ring-2 focus-visible:ring-ring"
                      style={{ backgroundColor: color }}
                    />
                  )
                )}
              </div>
              <FieldDescription>
                Accent updates the document preview and the exported report.
              </FieldDescription>
            </Field>
          </div>
        </section>
      )}
      {controls !== "theme" && (
        <>
          {/*
            Three segmented choices on two rows instead of three stacked lists. Each is
            still a native radio group — the input is visually hidden inside its label —
            so arrow keys, form semantics and label queries behave as they did; only the
            one-line description of the selected value is shown beneath, rather than a
            paragraph under every option.
          */}
          <div className="grid gap-5 sm:grid-cols-2">
            <Segmented
              legend="Density"
              name="design-density"
              value={design.density}
              options={DENSITY_VALUES.map((density) => ({
                value: density,
                label: density,
              }))}
              hint={DENSITY_SUMMARY[design.density]}
              onSelect={(density) => set({ density })}
            />

            <Segmented
              legend="Page size"
              name="design-page-size"
              value={design.page_size}
              options={PAGE_SIZE_VALUES.map((size) => ({
                value: size,
                label: size,
              }))}
              onSelect={(page_size) => set({ page_size })}
            />
          </div>

          <Segmented
            legend="Table style"
            name="design-table-style"
            value={design.table_style}
            options={TABLE_STYLE_VALUES.map((style) => ({
              value: style,
              label: style,
            }))}
            hint={
              design.table_style === "bordered"
                ? "Full grid with vertical and horizontal borders."
                : design.table_style === "banded"
                  ? "Alternating row shading with horizontal rules."
                  : "Fine horizontal rules, no vertical borders."
            }
            onSelect={(table_style) => set({ table_style })}
          />

          <p className="text-sm text-muted-foreground">
            Memory and storage values use GiB in new report versions. Save a
            version on the Preview step to apply these settings to generated
            reports.
          </p>
          <Field>
            <FieldLabel htmlFor={decimalsId}>Decimal places</FieldLabel>
            <Input
              id={decimalsId}
              type="number"
              min={MIN_DECIMAL_PLACES}
              max={MAX_DECIMAL_PLACES}
              value={design.number_format.decimal_places}
              onChange={(event) =>
                set({
                  number_format: {
                    ...design.number_format,
                    decimal_places: Number(event.target.value),
                  },
                })
              }
            />
            <FieldDescription>
              {MIN_DECIMAL_PLACES} to {MAX_DECIMAL_PLACES}. Applied when a
              figure is formatted for the document, and recorded in the ledger
              with it — the verifier compares the string that was printed.
            </FieldDescription>
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={design.number_format.group_thousands}
              onCheckedChange={(checked) =>
                set({
                  number_format: {
                    ...design.number_format,
                    group_thousands: checked === true,
                  },
                })
              }
            />
            Group thousands
          </label>

          <SeparatorControls
            definition={definition}
            design={design}
            onDesignChange={set}
          />

          {/*
        The cover-page toggle and the logo URL used to sit here, on `design`, and both
        were dead controls: the save path resolved every `design` field from a separate
        Brand record and overwrote whatever these wrote, so unchecking the box changed
        nothing and a logo typed here was discarded. The Brand is gone and the profile
        owns both under `front_matter.cover` — the Document step is where they are — and
        two fields for one thing, one of which silently loses, is worse than one field in
        the right place.
      */}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Segmented radio group
// ---------------------------------------------------------------------------

/**
 * A native radio group drawn as a segmented control.
 *
 * The inputs stay real `<input type="radio">` elements, visually hidden inside their
 * labels, so the group keeps the browser's arrow-key behaviour and its form semantics;
 * the label is what gets the pressed look, through `has-checked`.
 */
function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  hint,
  onSelect,
}: Readonly<{
  legend: string
  name: string
  value: T
  options: readonly { value: T; label: string }[]
  hint?: string
  onSelect: (value: T) => void
}>) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-[9px] bg-muted p-[3px]">
        {options.map((option) => (
          <label
            key={option.value}
            className="relative inline-flex h-7.5 cursor-pointer items-center rounded-md px-3 text-meta font-medium text-muted-foreground capitalize transition-colors hover:text-foreground has-checked:bg-card has-checked:text-foreground has-checked:shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.05)] has-focus-visible:ring-3 has-focus-visible:ring-ring/30"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onSelect(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// Separator controls + sample figure (Requirement 16.9)
// ---------------------------------------------------------------------------

/**
 * Presents the declared separators as controls and a **sample figure formatted in the
 * declared format**, so a consultant sees `462,81 GB` before a run rather than after one.
 *
 * The sample is the whole point: a separator picker with no rendered sample makes the
 * consequence invisible until a document is delivered.
 */
function SeparatorControls({
  definition,
  design,
  onDesignChange,
}: Readonly<{
  definition: TemplateDefinition
  design: DesignSpec
  onDesignChange: (patch: Partial<DesignSpec>) => void
}>) {
  const decimalId = useId()
  const groupingId = useId()

  const language = definition.identity.language ?? null
  const resolved = resolveSeparators(design.number_format, language)

  // The sample figures, formatted with the resolved separators.
  const samples = useMemo(
    () =>
      SAMPLE_VALUES.map(
        ({ value, suffix }) =>
          formatSampleFigure(value, {
            decimalPlaces: design.number_format.decimal_places,
            groupThousands: design.number_format.group_thousands,
            decimalSeparator: resolved.decimal_separator,
            groupingSeparator: resolved.grouping_separator,
          }) + suffix
      ),
    [
      design.number_format.decimal_places,
      design.number_format.group_thousands,
      resolved.decimal_separator,
      resolved.grouping_separator,
    ]
  )

  const languageDefault = language
    ? SEPARATOR_DEFAULTS[language as (typeof LANGUAGES)[number]]
    : SEPARATOR_DEFAULTS[LANGUAGES[0]]

  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <legend className="px-2 text-sm font-medium">Number separators</legend>

      <div className="flex flex-wrap gap-4">
        <Field>
          <FieldLabel htmlFor={decimalId}>Decimal separator</FieldLabel>
          <div className="flex items-center gap-2">
            <select
              id={decimalId}
              value={design.number_format.decimal_separator ?? ""}
              onChange={(event) =>
                onDesignChange({
                  number_format: {
                    ...design.number_format,
                    decimal_separator: event.target.value || undefined,
                  },
                })
              }
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              <option value="">
                Default ({separatorLabel(languageDefault.decimal_separator)})
              </option>
              {DECIMAL_SEPARATOR_OPTIONS.map((char) => (
                <option key={char} value={char}>
                  {separatorLabel(char)}
                </option>
              ))}
            </select>
          </div>
          <FieldDescription>
            Character between integer and fractional digits.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={groupingId}>Grouping separator</FieldLabel>
          <div className="flex items-center gap-2">
            <select
              id={groupingId}
              value={design.number_format.grouping_separator ?? ""}
              onChange={(event) =>
                onDesignChange({
                  number_format: {
                    ...design.number_format,
                    grouping_separator: event.target.value || undefined,
                  },
                })
              }
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              <option value="">
                Default ({separatorLabel(languageDefault.grouping_separator)})
              </option>
              {GROUPING_SEPARATOR_OPTIONS.map((char) => (
                <option key={char} value={char}>
                  {separatorLabel(char)}
                </option>
              ))}
            </select>
          </div>
          <FieldDescription>
            Character between groups of three digits.
          </FieldDescription>
        </Field>
      </div>

      {/* Sample figure in the declared format (Req 16.9) */}
      <div
        className="rounded-lg border border-border bg-muted/40 px-4 py-3"
        aria-label="Sample figures in the declared number format"
      >
        <p className="mb-1.5 text-micro text-muted-foreground uppercase">
          Preview
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-sm tabular-nums">
          {samples.map((sample, i) => (
            <span key={i}>{sample}</span>
          ))}
        </div>
      </div>
    </fieldset>
  )
}
