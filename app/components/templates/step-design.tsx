"use client"

import { useId } from "react"

import { StylePresetPicker } from "@/components/templates/style-preset-picker"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  DENSITY_VALUES,
  MAX_DECIMAL_PLACES,
  MIN_DECIMAL_PLACES,
  PAGE_SIZE_VALUES,
  TABLE_STYLE_VALUES,
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

const DENSITY_SUMMARY: Readonly<Record<(typeof DENSITY_VALUES)[number], string>> = {
  compact: "Tighter leading and table padding — more rows per page.",
  normal: "The theme's own spacing.",
  relaxed: "More air. Fewer rows per page, easier to read at a glance.",
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

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={design.cover_page}
          onCheckedChange={(checked) => set({ cover_page: checked === true })}
        />
        Cover page
      </label>

      <Field>
        <FieldLabel htmlFor={logoId}>Logo URL</FieldLabel>
        <Input
          id={logoId}
          value={design.logo ?? ""}
          onChange={(event) =>
            // Empty means "no logo", stored as `null` rather than `""` so the
            // definition has one representation for it and the digest cannot
            // differ between two templates that both have no logo.
            set({ logo: event.target.value.trim() === "" ? null : event.target.value })
          }
        />
        <FieldDescription>
          Optional. Printed on the cover page when one is enabled.
        </FieldDescription>
      </Field>
    </div>
  )
}
