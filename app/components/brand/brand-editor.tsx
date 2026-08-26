"use client"

import { useState } from "react"
import { CheckCircle } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import type { BrandView } from "@/lib/db/views"
import type { ThemeThumbnail } from "@/lib/templates/theme-thumbnails"
import { DESIGN_PRESETS, type DesignPreset } from "@/lib/templates/definition"

/**
 * The Brand editor (Requirement 2.4, 2.5).
 *
 * Four theme presets as rendered page images in a selectable grid — not names in
 * a select, because a theme is a visual decision and a dropdown of words gives
 * the user nothing to decide with. Selected card takes a `--ring` and a
 * `--primary` check.
 *
 * Consumes the same `ThemeThumbnail[]` source that `step-design.tsx` already
 * receives, not a new one.
 */
export function BrandEditor({
  brand,
  thumbnails,
}: Readonly<{
  brand: BrandView
  thumbnails: readonly ThemeThumbnail[]
}>) {
  const [preset, setPreset] = useState<DesignPreset>(
    brand.themePreset as DesignPreset
  )
  const [accentColor, setAccentColor] = useState(brand.accentColor)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch("/api/brand", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          themePreset: preset,
          accentColor,
        }),
      })
      if (res.ok) setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Theme preset grid */}
      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-base font-medium">Theme preset</h2>
        <div className="grid grid-cols-2 gap-4">
          {thumbnails.map((thumb) => {
            const isSelected = thumb.preset === preset
            return (
              <button
                key={thumb.preset}
                type="button"
                onClick={() => setPreset(thumb.preset)}
                className={`relative flex flex-col items-center gap-2 rounded-xl border p-3 transition-all ${
                  isSelected
                    ? "border-primary ring-2 ring-ring"
                    : "border-border hover:border-primary/40"
                }`}
              >
                {thumb.src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb.src}
                    alt={`${thumb.preset} theme preview`}
                    className="h-40 w-full rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex h-40 w-full items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
                    Page image unavailable
                  </div>
                )}
                <span className="text-sm font-medium capitalize">
                  {thumb.preset}
                </span>
                {isSelected && (
                  <CheckCircle
                    weight="fill"
                    className="absolute right-2 top-2 text-primary"
                    size={20}
                  />
                )}
              </button>
            )
          })}
        </div>
      </section>

      {/* Accent colour */}
      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-base font-medium">Accent colour</h2>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded-lg border border-border"
          />
          <input
            type="text"
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            className="h-9 w-32 rounded-lg border border-input bg-background px-3 font-mono text-sm"
          />
        </div>
      </section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save brand"}
        </Button>
        {saved && (
          <span className="text-sm text-muted-foreground">
            Saved. Changes apply to the next report.
          </span>
        )}
      </div>
    </div>
  )
}
