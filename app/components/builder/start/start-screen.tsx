"use client"

import { useRouter } from "next/navigation"
import { useId, useState } from "react"

import { ProviderMark, SOURCE_NAMES } from "@/components/subscriptions/provider-mark"
import { useCreationScope } from "@/components/workspaces/workspace-context"
import { GROUP_ORDER, sectionEntry, sectionTitle, type Provider } from "@/lib/builder/catalogue"
import { STARTERS, type Starter } from "@/lib/builder/starters"
import { THEME_LABELS, pageDesign } from "@/lib/builder/theme"
import { emptyDraftV4 } from "@/lib/builder/draft"
import { PRESET_FACES } from "@/lib/profiles/preview-sample"
import { DESIGN_PRESETS, type DesignPreset } from "@/lib/templates/definition"
import { cn } from "@/lib/utils"

/**
 * Start a preset: choose the provider, a starter and a look, then open the builder.
 *
 * The provider comes first because everything after it depends on it — the starters list
 * that provider's sections, and the preset keeps the provider for good.
 */

const GROUP_LABELS: Readonly<Record<string, string>> = {
  summary: "Summary",
  inventory: "Inventory",
  utilisation: "Utilisation",
  closing: "Closing",
}

export function StartScreen({
  defaultProvider,
  canCreate,
}: Readonly<{ defaultProvider: Provider; canCreate: boolean }>) {
  const router = useRouter()
  const scope = useCreationScope()
  const nameId = useId()
  const [provider, setProvider] = useState<Provider>(defaultProvider)
  const [starter, setStarter] = useState<Starter>(STARTERS[0]!)
  const [theme, setTheme] = useState<DesignPreset>(STARTERS[0]!.theme)
  const [name, setName] = useState(`${STARTERS[0]!.name} — ${defaultProvider === "aws" ? "AWS" : "Azure"}`)
  const [named, setNamed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = (next: Starter, nextProvider = provider) => {
    setStarter(next)
    setTheme(next.theme)
    if (!named) setName(`${next.name} — ${nextProvider === "aws" ? "AWS" : "Azure"}`)
  }

  const create = async () => {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const response = await fetch("/api/report-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || starter.name,
          provider,
          starter: starter.key,
          theme,
          ...scope,
        }),
      })
      const body = (await response.json()) as { template?: { id: string }; error?: { message?: string } }
      if (!response.ok || !body.template) {
        setError(body.error?.message ?? "The preset could not be created.")
        return
      }
      router.push(`/report-profiles/${body.template.id}/edit`)
    } catch {
      setError("The preset could not be created. Check your connection.")
    } finally {
      setCreating(false)
    }
  }

  const sections = starter.sections[provider]

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="radiogroup" aria-label="Provider" className="flex gap-0.5 rounded-lg bg-muted p-[3px]">
            {(["aws", "azure"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={provider === option}
                onClick={() => {
                  setProvider(option)
                  if (!named) setName(`${starter.name} — ${option === "aws" ? "AWS" : "Azure"}`)
                }}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-md px-3 text-[13px] text-muted-foreground",
                  provider === option && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,20,30,.08)]"
                )}
              >
                <ProviderMark kind={option} className="[&_svg]:size-4" />
                {SOURCE_NAMES[option]}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">The provider is fixed once the preset exists.</p>
        </div>

        <div role="radiogroup" aria-label="Starter" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {STARTERS.map((option) => {
            const on = option.key === starter.key
            return (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => choose(option)}
                className={cn(
                  "group flex flex-col gap-3 rounded-xl border border-border bg-card p-3 text-left hover:border-input",
                  on && "border-primary shadow-[0_0_0_2px_color-mix(in_oklab,var(--primary)_18%,transparent)]"
                )}
              >
                <MiniPage starter={option} provider={provider} theme={on ? theme : option.theme} />
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    {option.name}
                    {option.isNew && (
                      <span className="text-[10px] font-semibold tracking-wide text-primary uppercase">New</span>
                    )}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">{option.blurb}</span>
                  <span className="mt-1 font-mono text-[11px] text-muted-foreground tabular-nums">
                    {option.sections[provider].length}{" "}
                    {option.sections[provider].length === 1 ? "section" : "sections"}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <aside aria-label="New preset" className="flex flex-col gap-5 self-start rounded-xl border border-border bg-card p-4 lg:sticky lg:top-6">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">Preset name</label>
          <input
            id={nameId}
            value={name}
            maxLength={120}
            onChange={(event) => {
              setName(event.target.value)
              setNamed(true)
            }}
            className="h-9 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">What&rsquo;s inside</span>
          <div className="flex flex-col gap-2">
            {GROUP_ORDER.map((group) => {
              const inGroup = sections.filter((section) => sectionEntry(provider, section.type)?.group === group)
              if (inGroup.length === 0) return null
              return (
                <div key={group} className="flex flex-col gap-0.5">
                  <span className="text-[11px] tracking-wide text-muted-foreground uppercase">{GROUP_LABELS[group]}</span>
                  {inGroup.map((section) => (
                    <span key={section.type} className="text-[13px]">
                      {sectionTitle(sectionEntry(provider, section.type), "en")}
                      {section.lookback ? (
                        <span className="text-muted-foreground"> · {section.lookback} months</span>
                      ) : null}
                    </span>
                  ))}
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Look</span>
          <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-1.5">
            {DESIGN_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={theme === preset}
                onClick={() => setTheme(preset)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-left text-[12.5px] hover:border-input",
                  theme === preset && "border-primary font-semibold"
                )}
              >
                <span aria-hidden className="text-sm font-bold" style={{ fontFamily: PRESET_FACES[preset] }}>Aa</span>
                {THEME_LABELS[preset].name}
              </button>
            ))}
          </div>
          <span className="text-[11.5px] text-muted-foreground">{THEME_LABELS[theme].note}</span>
        </div>

        <button
          type="button"
          disabled={!canCreate || creating}
          onClick={() => void create()}
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {creating ? "Creating…" : "Open in builder"}
        </button>
        {!canCreate && (
          <p className="text-xs text-muted-foreground">
            Choose a customer you can edit in the header to create a preset.
          </p>
        )}
        {error && (
          <p aria-live="polite" className="text-sm text-destructive">{error}</p>
        )}
      </aside>
    </div>
  )
}

/** A starter drawn as a page: its theme's accent and face, one band per section. */
function MiniPage({ starter, provider, theme }: Readonly<{ starter: Starter; provider: Provider; theme: DesignPreset }>) {
  const draft = emptyDraftV4(starter.name, provider)
  const design = pageDesign({ ...draft, design: { ...draft.design, preset: theme, accent_color: undefined } })
  const { spec } = design
  const sections = starter.sections[provider].slice(0, 5)
  return (
    <div aria-hidden className="relative h-36 overflow-hidden rounded-md border border-border bg-white px-4 pt-4" style={{ fontFamily: spec.face }}>
      <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: spec.accent }} />
      <div className="mb-2 text-[11px] leading-tight font-bold" style={{ color: spec.accent }}>{starter.name}</div>
      <div className="flex flex-col gap-1.5">
        {sections.map((section, index) => {
          const entry = sectionEntry(provider, section.type)
          const charted = entry?.metricBearing
          return (
            <div key={section.type} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[7px] tabular-nums" style={{ color: spec.muted }}>{String(index + 1).padStart(2, "0")}</span>
                <span className="truncate text-[8px] font-semibold" style={{ color: spec.ink }}>{sectionTitle(entry, "en")}</span>
              </div>
              {charted ? (
                <svg viewBox="0 0 100 10" className="h-2 w-full" preserveAspectRatio="none">
                  <polyline points="0,8 12,6 24,7 36,3 48,5 60,4 72,6 84,2 100,5" fill="none" stroke={spec.accent} strokeWidth="1" />
                </svg>
              ) : (
                <div className="h-1 w-3/4 rounded-sm" style={{ background: spec.rule }} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
