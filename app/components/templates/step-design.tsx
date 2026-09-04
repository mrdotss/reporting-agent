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
  type DesignPreset,
  type DesignSpec,
  type TemplateDefinition,
} from "@/lib/templates/definition"
import type { ThemeThumbnail } from "@/lib/templates/theme-thumbnails"

/**
 * Step 6 — design (Requirements 7.1, 7.2, 11.1).
 *
 * ## The grid above, the tuning below
 *
 * Requirement 13.5 puts the design tuning controls **below** the preset grid, and
 * the order is the order of the decision: a consultant picks the theme by looking
 * at four pages, then adjusts what the theme left tunable. Reversing it would ask
 * them to set an accent colour before seeing what it will sit on.
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
  thumbnails,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
  /**
   * Resolved on the server, because deciding whether an image is current means
   * hashing a theme document on disk (Requirement 13.2). The verdict crosses to
   * the browser; the digests do not.
   */
  thumbnails: readonly ThemeThumbnail[]
}>) {
  const accentId = useId()
  const decimalsId = useId()
  const logoId = useId()

  const design = definition.design

  const set = (patch: Partial<DesignSpec>) => {
    onChange({ ...definition, design: { ...design, ...patch } })
  }

  return (
    <div className="flex flex-col gap-5">
      <StylePresetPicker
        selected={design.preset}
        thumbnails={thumbnails}
        onSelect={(preset: DesignPreset) => set({ preset })}
      />

      <Field>
        <FieldLabel htmlFor={accentId}>Accent colour</FieldLabel>
        <Input
          id={accentId}
          value={design.accent_color}
          onChange={(event) => set({ accent_color: event.target.value })}
          placeholder="#1f6f78"
        />
        <FieldDescription>
          Six-digit hex. Used for headings, rules and chart emphasis.
        </FieldDescription>
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Density</legend>

        {DENSITY_VALUES.map((density) => (
          <label
            key={density}
            className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-focus-visible:ring-3 has-focus-visible:ring-ring/30"
          >
            <input
              type="radio"
              name="design-density"
              value={density}
              checked={design.density === density}
              onChange={() => set({ density })}
              className="mt-1"
            />
            <span className="flex flex-col gap-0.5">
              <span className="capitalize">{density}</span>
              <span className="text-xs text-muted-foreground">
                {DENSITY_SUMMARY[density]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-2 w-full text-sm font-medium">Table style</legend>

        {TABLE_STYLE_VALUES.map((style) => (
          <label key={style} className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="design-table-style"
              value={style}
              checked={design.table_style === style}
              onChange={() => set({ table_style: style })}
            />
            <span className="capitalize">{style}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-2 w-full text-sm font-medium">Page size</legend>

        {PAGE_SIZE_VALUES.map((size) => (
          <label key={size} className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="design-page-size"
              value={size}
              checked={design.page_size === size}
              onChange={() => set({ page_size: size })}
            />
            <span>{size}</span>
          </label>
        ))}
      </fieldset>

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
          {MIN_DECIMAL_PLACES} to {MAX_DECIMAL_PLACES}. Applied when a figure is
          formatted for the document, and recorded in the ledger with it — the
          verifier compares the string that was printed.
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
        were dead controls: `resolveDesignFromBrand` overwrites every `design` field
        from the Brand at save, so unchecking the box changed nothing and a logo typed
        here was discarded. The profile owns both under `front_matter.cover` — the
        Document step is where they are — and two fields for one thing, one of which
        silently loses, is worse than one field in the right place.
      */}
    </div>
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
      SAMPLE_VALUES.map(({ value, suffix }) =>
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
                    decimal_separator:
                      event.target.value || undefined,
                  },
                })
              }
              className="h-9 rounded-4xl border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                    grouping_separator:
                      event.target.value || undefined,
                  },
                })
              }
              className="h-9 rounded-4xl border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
