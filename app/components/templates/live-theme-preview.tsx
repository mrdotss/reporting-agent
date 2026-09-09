"use client"

import {
  DESIGN_PRESETS,
  type DesignPreset,
  type DesignSpec,
} from "@/lib/templates/definition"

const FACES = {
  editorial: '"Liberation Serif", Georgia, serif',
  corporate: '"Liberation Sans", Arial, sans-serif',
  technical: '"DejaVu Sans", Arial, sans-serif',
  minimal: '"Liberation Sans", Arial, sans-serif',
}
const NOTES = {
  editorial: "Serif · spacious",
  corporate: "Sans serif · structured",
  technical: "Compact · precise",
  minimal: "Quiet · restrained",
}

/** Small live document specimens, using the profile's current appearance overrides. */
export function LiveThemePreview({
  design,
  onSelect,
}: {
  design: DesignSpec
  onSelect: (preset: DesignPreset) => void
}) {
  const accent = /^#[0-9a-f]{6}$/i.test(design.accent_color)
    ? design.accent_color
    : "#1f6f78"
  return (
    <div
      role="radiogroup"
      aria-label="Live theme previews"
      className="grid grid-cols-2 gap-3 xl:grid-cols-4"
    >
      {DESIGN_PRESETS.map((preset, index) => (
        <button
          type="button"
          key={preset}
          role="radio"
          aria-checked={design.preset === preset}
          aria-label={`${preset}: ${NOTES[preset]}`}
          tabIndex={design.preset === preset ? 0 : -1}
          onClick={() => onSelect(preset)}
          onKeyDown={(event) => {
            if (
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                event.key
              )
            )
              return
            event.preventDefault()
            const next =
              DESIGN_PRESETS[
                (index +
                  (["ArrowLeft", "ArrowUp"].includes(event.key) ? 3 : 1)) %
                  4
              ]
            onSelect(next)
            const parent = event.currentTarget.parentElement
            parent
              ?.querySelectorAll<HTMLButtonElement>("button")
              [DESIGN_PRESETS.indexOf(next)]?.focus()
          }}
          className={`flex min-w-0 flex-col rounded-lg border p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${design.preset === preset ? "border-primary ring-1 ring-primary" : "border-border hover:border-muted-foreground"}`}
        >
          <span
            aria-hidden="true"
            className="block min-h-40 w-full rounded-md border border-slate-200 bg-white p-3 text-slate-800"
            style={{ fontFamily: FACES[preset] }}
          >
            <span
              className="mb-2 block h-1 rounded-full"
              style={{ backgroundColor: accent }}
            />
            <span
              className="block text-xs font-bold"
              style={{ color: preset === "corporate" ? "#183b63" : accent }}
            >
              Utilization summary
            </span>
            <span className="my-2 block text-[10px] leading-relaxed">
              Resource health and performance for the reporting period.
            </span>
            <span
              className="grid grid-cols-2 text-[9px]"
              style={{
                border:
                  design.table_style === "bordered"
                    ? "1px solid #cbd5e1"
                    : undefined,
              }}
            >
              {["Resource", "Status", "Sample VM", "Available"].map(
                (text, i) => (
                  <span
                    key={text}
                    style={{
                      padding: design.density === "compact" ? "3px" : "5px",
                      borderBottom: "1px solid #cbd5e1",
                      borderRight:
                        design.table_style === "bordered" && i % 2 === 0
                          ? "1px solid #cbd5e1"
                          : undefined,
                      backgroundColor:
                        i > 1 && design.table_style === "banded"
                          ? "#f1f5f9"
                          : "transparent",
                      fontFamily:
                        preset === "technical" && i > 1
                          ? '"DejaVu Sans Mono", monospace'
                          : undefined,
                    }}
                  >
                    {text}
                  </span>
                )
              )}
            </span>
          </span>
          <span className="mt-2 flex items-center justify-between text-xs font-medium capitalize">
            {preset}
            <span aria-hidden="true">
              {design.preset === preset ? "✓" : ""}
            </span>
          </span>
          <span className="block text-[10px] text-muted-foreground">
            {NOTES[preset]}
          </span>
        </button>
      ))}
    </div>
  )
}
