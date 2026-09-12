"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  PREVIEW_THEMES,
  THEME_NOTES,
  previewSettingsSchema,
  themeDefaults,
  type PreviewSettings,
} from "@/lib/design-preview/settings"

type Result = { url: string; settings: PreviewSettings }
const swatches = [
  "#1f6f78",
  "#33556b",
  "#0f6470",
  "#76558b",
  "#945a31",
  "#30343b",
]
const selectClass =
  "mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"

export function DesignPreview() {
  const [settings, setSettings] = useState<PreviewSettings>(() =>
    themeDefaults("corporate")
  )
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef<AbortController | null>(null)
  const latestUrl = useRef<string | null>(null)
  const valid = previewSettingsSchema.safeParse(settings).success
  const outdated =
    result !== null &&
    JSON.stringify(result.settings) !== JSON.stringify(settings)

  useEffect(
    () => () => {
      active.current?.abort()
      if (latestUrl.current) URL.revokeObjectURL(latestUrl.current)
    },
    []
  )

  function update(patch: Partial<PreviewSettings>) {
    setSettings((current) => ({ ...current, ...patch }))
  }

  async function render() {
    if (active.current || !valid) return
    const controller = new AbortController()
    active.current = controller
    const renderingSettings = { ...settings }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/report-profiles/design-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(renderingSettings),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.json()
        throw new Error(
          body.error?.message ?? "The preview could not be rendered."
        )
      }
      if (!response.headers.get("content-type")?.includes("application/pdf"))
        throw new Error("The renderer did not return a PDF.")
      const blob = await response.blob()
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(blob)
      const previous = latestUrl.current
      latestUrl.current = url
      setResult({ url, settings: renderingSettings })
      if (previous) URL.revokeObjectURL(previous)
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "The preview could not be rendered."
        )
    } finally {
      if (!controller.signal.aborted) setBusy(false)
      active.current = null
    }
  }

  return (
    <div className="mx-auto max-w-[1500px]">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-5 border-b border-border pb-7">
        <div>
          <p className="mb-3 text-micro text-muted-foreground uppercase">
            Report profiles / Design lab
          </p>
          <h1 className="text-title">
            Make the report yours.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Four themes. One sample report. Tune the details, then see the
            actual PDF.
          </p>
        </div>
        <span className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground">
          Development preview · Sample data
        </span>
      </header>

      <div className="grid items-start gap-7 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="space-y-6" aria-label="Report appearance">
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-section">Choose a starting point</h2>
              <span className="text-xs text-muted-foreground">01 / Theme</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {PREVIEW_THEMES.map((theme) => {
                const defaults = themeDefaults(theme)
                const selected = settings.preset === theme
                return (
                  <button
                    key={theme}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${theme} theme`}
                    onClick={() => setSettings(defaults)}
                    className={`overflow-hidden rounded-xl border text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring ${selected ? "border-primary ring-2 ring-primary/15" : "border-border hover:border-muted-foreground"}`}
                  >
                    <div
                      className="bg-muted/40 px-5 pt-4 pb-3"
                      aria-hidden="true"
                    >
                      <div
                        className="h-24 rounded-t-sm border border-black/10 bg-white px-3 pt-3 shadow-sm"
                        style={{
                          borderTop: `3px solid ${defaults.accent_color}`,
                          fontFamily:
                            theme === "editorial"
                              ? "Georgia, serif"
                              : "Arial, sans-serif",
                        }}
                      >
                        <div className="mb-2 text-[8px] font-bold text-slate-800">
                          Infrastructure
                          <br />
                          in focus.
                        </div>
                        <div className="mb-1 h-0.5 w-4/5 bg-slate-200" />
                        <div className="h-0.5 w-3/5 bg-slate-200" />
                        <div className="mt-3 flex items-end gap-1">
                          {[8, 15, 11, 19, 13, 22, 16].map((height, index) => (
                            <span
                              key={index}
                              className="w-2"
                              style={{
                                height,
                                background: defaults.accent_color,
                                opacity: 0.6 + index / 20,
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2.5 text-sm font-medium capitalize">
                      {theme}
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 rounded-full ${selected ? "bg-primary" : "bg-transparent"}`}
                      />
                    </div>
                  </button>
                )
              })}
            </div>
            <p className="mt-3 min-h-10 text-xs leading-5 text-muted-foreground">
              {THEME_NOTES[settings.preset]} Theme cards are illustrative;
              render to review the PDF.
            </p>
          </section>

          <section className="space-y-4 border-t border-border pt-5">
            <div className="flex justify-between">
              <h2 className="text-section">Refine the details</h2>
              <span className="text-xs text-muted-foreground">
                02 / Appearance
              </span>
            </div>
            <div>
              <label htmlFor="preview-accent" className="text-xs font-medium">
                Accent colour
              </label>
              <div className="mt-2 flex gap-2">
                {swatches.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Use accent ${color}`}
                    onClick={() => update({ accent_color: color })}
                    className="h-7 w-7 rounded-full border border-black/10 ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
                    style={{
                      backgroundColor: color,
                      outline:
                        settings.accent_color === color
                          ? "2px solid var(--foreground)"
                          : undefined,
                      outlineOffset: 2,
                    }}
                  />
                ))}
              </div>
              <input
                id="preview-accent"
                value={settings.accent_color}
                onChange={(e) => update({ accent_color: e.target.value })}
                maxLength={7}
                spellCheck={false}
                aria-invalid={!valid}
                aria-describedby={!valid ? "preview-accent-error" : undefined}
                className={`${selectClass} font-mono`}
              />
              {!valid ? (
                <p
                  id="preview-accent-error"
                  className="mt-1 text-xs text-destructive"
                >
                  Use a six-digit hex colour, such as #1f6f78.
                </p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Choice
                label="Spacing"
                value={settings.density}
                options={["compact", "normal", "relaxed"]}
                onChange={(density) => update({ density })}
              />
              <Choice
                label="Tables"
                value={settings.table_style}
                options={["hairline", "banded", "bordered"]}
                onChange={(table_style) => update({ table_style })}
              />
              <Choice
                label="Page size"
                value={settings.page_size}
                options={["A4", "Letter"]}
                onChange={(page_size) => update({ page_size })}
              />
              <Choice
                label="Chart font"
                value={settings.chart_font}
                options={["document", "grotesque", "monospace"]}
                onChange={(chart_font) => update({ chart_font })}
              />
            </div>
            <Choice
              label="Chart style"
              value={settings.chart_style}
              options={["stacked", "columns"]}
              labels={{ stacked: "Stacked panels", columns: "Daily columns" }}
              onChange={(chart_style) => update({ chart_style })}
            />
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => setSettings(themeDefaults(settings.preset))}
            >
              Reset to theme defaults
            </button>
          </section>
          <p className="border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
            An overview and a VM utilization page, using fixed sample data.
            These settings stay in this preview.
          </p>
        </aside>

        <section
          className="overflow-hidden rounded-xl border border-border bg-muted/30"
          aria-label="PDF preview"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-5 py-4">
            <div>
              <h2 className="text-section">Your report, on paper</h2>
              <p role="status" className="mt-1 text-xs text-muted-foreground">
                {busy
                  ? "Rendering your PDF…"
                  : outdated
                    ? "Settings changed · Preview outdated"
                    : result
                      ? `${result.settings.preset} · ${result.settings.page_size} · Ready to review`
                      : "Render your first sample to begin"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {result ? (
                <a
                  className="text-xs font-medium underline underline-offset-4"
                  href={result.url}
                  download={`design-preview-${result.settings.preset}.pdf`}
                >
                  {outdated ? "Download previous PDF" : "Download PDF"}
                </a>
              ) : null}
              <Button onClick={render} disabled={busy || !valid}>
                {busy ? "Rendering…" : "Render preview"}
              </Button>
            </div>
          </div>
          {error ? (
            <div
              role="alert"
              className="border-b border-border bg-destructive/5 px-5 py-3 text-sm text-destructive"
            >
              {error}
              {result ? " Your previous PDF is still available." : ""}
            </div>
          ) : null}
          {result ? (
            <iframe
              title="Rendered sample PDF"
              src={`${result.url}#zoom=page-width&navpanes=0`}
              className="h-[850px] w-full bg-white"
            />
          ) : (
            <div className="flex min-h-[760px] flex-col items-center justify-center px-7 text-center">
              <div
                className="mb-7 h-40 w-28 rotate-[-5deg] rounded-sm border border-border bg-background p-4 shadow-lg"
                aria-hidden="true"
              >
                <div className="mb-4 h-1 w-10 bg-primary" />
                <div className="h-2 w-full bg-foreground/15" />
                <div className="mt-2 h-2 w-3/4 bg-foreground/15" />
                <div className="mt-5 space-y-2">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-1 w-full bg-foreground/10" />
                  ))}
                </div>
              </div>
              <h3 className="text-section">
                A considered report starts here.
              </h3>
              <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                Choose your theme and render a sample. The preview shows the
                same PDF you download, including its fonts, charts and page
                breaks.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Choice<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string
  value: T
  options: readonly T[]
  labels?: Partial<Record<T, string>>
  onChange: (value: T) => void
}) {
  return (
    <label className="block text-xs font-medium">
      {label}
      <select
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels?.[option] ??
              option.charAt(0).toUpperCase() + option.slice(1)}
          </option>
        ))}
      </select>
    </label>
  )
}
