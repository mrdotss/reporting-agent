"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useId, useState } from "react"
import {
  ArrowRightIcon,
  CheckIcon,
  CircleNotchIcon,
  InfoIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react"

import { ProviderMark, SOURCE_NAMES } from "@/components/subscriptions/provider-mark"
import { SectionMark } from "@/components/templates/section-marks"
import { Button } from "@/components/ui/button"
import { useCreationScope } from "@/components/workspaces/workspace-context"
import { GROUP_ORDER, sectionEntry, sectionTitle, type Provider } from "@/lib/builder/catalogue"
import { emptyDraftV4 } from "@/lib/builder/draft"
import { STARTERS } from "@/lib/builder/starters"
import { THEME_LABELS, pageDesign, themeAccent } from "@/lib/builder/theme"
import { messageText, type MessageId } from "@/lib/messages/catalog"
import { PRESET_HEADING_FACES } from "@/lib/profiles/preview-sample"
import type { Outline, OutlineAudience, OutlineLength } from "@/lib/presets/outline"
import { DESIGN_PRESETS, type DesignPreset } from "@/lib/templates/definition"
import { cn } from "@/lib/utils"

/**
 * Describe it: a sentence in, an outline out, then the builder.
 *
 * Two columns, so what was asked and what was drafted are side by side. The input column
 * holds the description, the cloud, audience and length, then "How we read it" — what the
 * drafting understood, and what it could not apply because no preset setting exists for
 * it — and the refine controls with their history. The output column shows the outline,
 * grouped as the document is, and a preview of the first page in the chosen look.
 *
 * Saving creates an ordinary preset draft from the outline (`POST /api/report-profiles`
 * with `outline`), built the way a starter is. Nothing here changes the builder.
 */

const t = (id: MessageId, params?: Record<string, string | number>) => messageText(id, "en", params) ?? ""

const GROUP_IDS: Readonly<Record<string, MessageId>> = {
  summary: "ui.describe.group_summary",
  inventory: "ui.describe.group_inventory",
  utilisation: "ui.describe.group_utilisation",
  closing: "ui.describe.group_closing",
}

const AUDIENCES: ReadonlyArray<readonly [OutlineAudience, MessageId]> = [
  ["executive", "ui.describe.audience_executive"],
  ["technical", "ui.describe.audience_technical"],
  ["mixed", "ui.describe.audience_mixed"],
]

const LENGTHS: ReadonlyArray<readonly [OutlineLength, MessageId]> = [
  ["short", "ui.describe.length_short"],
  ["standard", "ui.describe.length_standard"],
  ["detailed", "ui.describe.length_detailed"],
]

const EXAMPLES: readonly MessageId[] = [
  "ui.describe.example_exec",
  "ui.describe.example_capacity",
  "ui.describe.example_backup",
]

const REFINES: readonly MessageId[] = [
  "ui.describe.refine_shorter",
  "ui.describe.refine_technical",
  "ui.describe.refine_backups",
  "ui.describe.refine_trend",
]

const PROGRESS: readonly MessageId[] = [
  "ui.describe.progress_read",
  "ui.describe.progress_choose",
  "ui.describe.progress_check",
]

const COVERAGE = "coverage_and_verification"

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string
  value: T
  options: ReadonlyArray<readonly [T, MessageId]>
  onChange: (next: T) => void
}>) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex w-fit gap-0.5 rounded-lg bg-muted p-[3px]">
        {options.map(([option, id]) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            onClick={() => onChange(option)}
            className={cn(
              "inline-flex h-7 items-center rounded-md px-2.5 text-[13px] text-muted-foreground",
              value === option && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,20,30,.08)]"
            )}
          >
            {t(id)}
          </button>
        ))}
      </div>
    </div>
  )
}

function StepLabel({ n, id }: Readonly<{ n: number; id: MessageId }>) {
  return (
    <span className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      <span className="grid size-5 place-items-center rounded-full bg-primary text-[11px] text-primary-foreground">{n}</span>
      {t(id)}
    </span>
  )
}

export function DescribeScreen({
  defaultProvider,
  canCreate,
}: Readonly<{ defaultProvider: Provider; canCreate: boolean }>) {
  const router = useRouter()
  const scope = useCreationScope()
  const descriptionId = useId()
  const nameId = useId()
  const refineId = useId()

  const [provider, setProvider] = useState<Provider>(defaultProvider)
  const [description, setDescription] = useState("")
  const [audience, setAudience] = useState<OutlineAudience>("mixed")
  const [length, setLength] = useState<OutlineLength>("standard")
  const [outline, setOutline] = useState<Outline | null>(null)
  const [history, setHistory] = useState<readonly string[]>([])
  const [instruction, setInstruction] = useState("")
  const [busy, setBusy] = useState<"draft" | "refine" | "create" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<"outline" | "preview">("outline")
  const [name, setName] = useState("")
  const [theme, setTheme] = useState<DesignPreset>("corporate")

  const request = async (refine?: string) => {
    if (busy !== null || description.trim().length < 8) return
    setBusy(refine === undefined ? "draft" : "refine")
    setError(null)
    try {
      const response = await fetch("/api/report-profiles/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          provider,
          audience,
          length,
          ...(refine === undefined || outline === null ? {} : { current: outline, instruction: refine }),
        }),
      })
      const body = (await response.json().catch(() => null)) as { outline?: Outline } | null
      if (!response.ok || !body?.outline) {
        setError(t(refine === undefined ? "ui.describe.error_draft" : "ui.describe.error_refine"))
        return
      }
      const next = body.outline
      setOutline(next)
      setName(next.name)
      setTheme(next.theme)
      if (refine === undefined) {
        setHistory([])
      } else {
        setHistory((entries) => [...entries, next.changeNote ?? refine])
        setInstruction("")
      }
    } catch {
      setError(t(refine === undefined ? "ui.describe.error_draft" : "ui.describe.error_refine"))
    } finally {
      setBusy(null)
    }
  }

  const removeSection = (key: string) => {
    if (outline === null) return
    setOutline({ ...outline, sections: outline.sections.filter((section) => section.key !== key) })
  }

  const create = async (open: boolean) => {
    if (busy !== null || outline === null) return
    setBusy("create")
    setError(null)
    try {
      const response = await fetch("/api/report-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || outline.name,
          provider: outline.provider,
          theme,
          ...(outline.summary ? { description: outline.summary } : {}),
          outline: {
            sections: outline.sections.map((section) => ({
              type: section.key,
              ...(section.lookback ? { lookback: section.lookback } : {}),
            })),
            period: outline.period,
            contents: outline.contents,
            language: outline.language,
            ...(outline.summary ? { summary: outline.summary } : {}),
          },
          ...scope,
        }),
      })
      const body = (await response.json().catch(() => null)) as { template?: { id: string }; error?: { message?: string } } | null
      if (!response.ok || !body?.template) {
        setError(body?.error?.message ?? t("ui.describe.error_create"))
        return
      }
      router.push(open ? `/report-profiles/${body.template.id}/edit` : "/report-profiles")
    } catch {
      setError(t("ui.describe.error_create"))
    } finally {
      setBusy(null)
    }
  }

  const drafting = busy === "draft" || busy === "refine"
  const starterName = outline?.starterKey ? STARTERS.find((starter) => starter.key === outline.starterKey)?.name : undefined

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {/* Input */}
      <div className="flex min-w-0 flex-col gap-5">
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
          <StepLabel n={1} id="ui.describe.step_describe" />

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("ui.describe.cloud")}</span>
            <div role="radiogroup" aria-label={t("ui.describe.cloud")} className="flex w-fit gap-0.5 rounded-lg bg-muted p-[3px]">
              {(["aws", "azure"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={provider === option}
                  disabled={outline !== null}
                  onClick={() => setProvider(option)}
                  className={cn(
                    "inline-flex h-7 items-center gap-2 rounded-md px-2.5 text-[13px] text-muted-foreground disabled:cursor-not-allowed",
                    provider === option && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,20,30,.08)]"
                  )}
                >
                  <ProviderMark kind={option} className="[&_svg]:size-4" />
                  {SOURCE_NAMES[option]}
                </button>
              ))}
            </div>
            <span className="text-[11.5px] text-muted-foreground">{t("ui.describe.cloud_fixed")}</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={descriptionId} className="text-xs font-medium text-muted-foreground">
              {t("ui.describe.description_label")}
            </label>
            <textarea
              id={descriptionId}
              value={description}
              maxLength={1200}
              rows={5}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("ui.describe.description_placeholder")}
              className="min-h-28 rounded-md border border-input bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {outline === null ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px] text-muted-foreground">{t("ui.describe.examples")}</span>
                {EXAMPLES.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setDescription(t(id))}
                    className="rounded-full border border-border px-2 py-0.5 text-left text-[11.5px] hover:border-primary"
                  >
                    {t(id)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-4">
            <Segmented label={t("ui.describe.audience")} value={audience} options={AUDIENCES} onChange={setAudience} />
            <Segmented label={t("ui.describe.length")} value={length} options={LENGTHS} onChange={setLength} />
          </div>

          <Button
            disabled={drafting || description.trim().length < 8}
            onClick={() => void request()}
            className="w-fit"
          >
            {busy === "draft" ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" />
            ) : (
              <SparkleIcon aria-hidden="true" />
            )}
            {busy === "draft" ? t("ui.describe.drafting") : outline === null ? t("ui.describe.draft") : t("ui.describe.redraft")}
          </Button>
        </section>

        {outline !== null ? (
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
            <StepLabel n={2} id="ui.describe.step_refine" />

            {outline.understood.length > 0 || outline.notApplied.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">{t("ui.describe.how_we_read")}</span>
                <ul className="flex flex-col gap-1">
                  {outline.understood.map((note, index) => (
                    <li key={`u-${index}`} className="flex items-start gap-2 text-[13px]">
                      <CheckIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" />
                      {note}
                    </li>
                  ))}
                </ul>
                {outline.notApplied.length > 0 ? (
                  <div className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2">
                    <span className="text-[11.5px] font-semibold">{t("ui.describe.not_applied")}</span>
                    <ul className="flex flex-col gap-1">
                      {outline.notApplied.map((note, index) => (
                        <li key={`n-${index}`} className="flex items-start gap-2 text-[13px]">
                          <XIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                          {note}
                        </li>
                      ))}
                    </ul>
                    <span className="text-[11.5px] text-muted-foreground">{t("ui.describe.not_applied_note")}</span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              {REFINES.map((id) => (
                <button
                  key={id}
                  type="button"
                  disabled={drafting}
                  onClick={() => void request(t(id))}
                  className="rounded-full border border-border px-2.5 py-1 text-[12.5px] hover:border-primary disabled:opacity-60"
                >
                  {t(id)}
                </button>
              ))}
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (instruction.trim().length >= 2) void request(instruction.trim())
              }}
            >
              <label htmlFor={refineId} className="sr-only">{t("ui.describe.refine_placeholder")}</label>
              <input
                id={refineId}
                value={instruction}
                maxLength={400}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder={t("ui.describe.refine_placeholder")}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="submit" variant="outline" disabled={drafting || instruction.trim().length < 2}>
                {busy === "refine" ? <CircleNotchIcon aria-hidden="true" className="animate-spin" /> : null}
                {t("ui.describe.refine_apply")}
              </Button>
            </form>
            {history.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t("ui.describe.history")}</span>
                <ol className="flex flex-col gap-1">
                  {history.map((entry, index) => (
                    <li key={index} className="flex items-start gap-2 text-[13px]">
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{index + 1}</span>
                      {entry}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </section>
        ) : null}

        {error ? (
          <p aria-live="polite" className="text-sm text-destructive">{error}</p>
        ) : null}
      </div>

      {/* Output */}
      <div className="flex min-w-0 flex-col gap-4">
        <section aria-busy={drafting} className="flex min-h-80 flex-col gap-4 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" className="flex gap-0.5 rounded-lg bg-muted p-[3px]">
              {(
                [
                  ["outline", "ui.describe.output"],
                  ["preview", "ui.describe.output_preview"],
                ] as const
              ).map(([value, id]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => setTab(value)}
                  className={cn(
                    "inline-flex h-7 items-center rounded-md px-2.5 text-[13px] text-muted-foreground",
                    tab === value && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,20,30,.08)]"
                  )}
                >
                  {t(id)}
                </button>
              ))}
            </div>
            {outline !== null ? (
              <span className="text-xs text-muted-foreground">
                {t("ui.describe.section_count", { count: outline.sections.length })} ·{" "}
                {outline.period === "last_30d" ? t("ui.describe.period_last_30d") : t("ui.describe.period_last_full_month")} ·{" "}
                {outline.contents ? t("ui.describe.contents_on") : t("ui.describe.contents_off")} ·{" "}
                {outline.language === "id" ? t("ui.describe.language_id") : t("ui.describe.language_en")}
              </span>
            ) : null}
          </div>

          {drafting && busy === "draft" ? (
            <ol className="flex flex-col gap-2" aria-live="polite">
              {PROGRESS.map((id) => (
                <li key={id} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CircleNotchIcon aria-hidden="true" className="size-4 animate-spin" />
                  {t(id)}
                </li>
              ))}
            </ol>
          ) : outline === null ? (
            <p className="max-w-prose text-sm text-muted-foreground">{t("ui.describe.output_empty")}</p>
          ) : (
            <div className={cn("flex flex-col gap-4", busy === "refine" && "opacity-60")}>
              {outline.source === "starter" && starterName ? (
                <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-[13px]">
                  <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {t("ui.describe.from_starter", { name: starterName })}
                </p>
              ) : null}
              {tab === "outline" ? (
                <OutlineList outline={outline} onRemove={removeSection} />
              ) : (
                <PagePreview outline={outline} name={name || outline.name} theme={theme} />
              )}
            </div>
          )}
        </section>

        {outline !== null ? (
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
            <StepLabel n={3} id="ui.describe.step_save" />
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">{t("ui.describe.name")}</label>
                <input
                  id={nameId}
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t("ui.describe.theme")}</span>
                <div role="radiogroup" aria-label={t("ui.describe.theme")} className="flex flex-wrap gap-1.5">
                  {DESIGN_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      role="radio"
                      aria-checked={theme === preset}
                      onClick={() => setTheme(preset)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[12.5px] hover:border-input",
                        theme === preset && "border-primary font-semibold"
                      )}
                    >
                      <span aria-hidden className="text-sm font-bold" style={{ fontFamily: PRESET_HEADING_FACES[preset], color: themeAccent(preset) }}>
                        Aa
                      </span>
                      {THEME_LABELS[preset].name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={!canCreate || busy !== null} onClick={() => void create(true)}>
                {busy === "create" ? t("ui.describe.creating") : t("ui.describe.open_builder")}
                <ArrowRightIcon aria-hidden="true" />
              </Button>
              <Button variant="outline" disabled={!canCreate || busy !== null} onClick={() => void create(false)}>
                {t("ui.describe.save_draft")}
              </Button>
              <span className="text-xs text-muted-foreground">
                {canCreate ? t("ui.describe.save_note") : t("ui.describe.cannot_create")}
              </span>
            </div>
          </section>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Link href="/report-profiles/new" className="underline underline-offset-4">
              {t("ui.presets.quick_starter_title")}
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}

function OutlineList({ outline, onRemove }: Readonly<{ outline: Outline; onRemove: (key: string) => void }>) {
  const provider = outline.provider
  const removable = outline.sections.filter((section) => section.key !== COVERAGE).length > 1
  return (
    <div className="flex flex-col gap-4">
      {outline.summary ? <p className="text-sm">{outline.summary}</p> : null}
      {GROUP_ORDER.map((group) => {
        const inGroup = outline.sections.filter((section) => sectionEntry(provider, section.key)?.group === group)
        if (inGroup.length === 0) return null
        return (
          <div key={group} className="flex flex-col gap-1.5">
            <span className="text-[11px] tracking-wide text-muted-foreground uppercase">{t(GROUP_IDS[group]!)}</span>
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {inGroup.map((section) => {
                const title = sectionTitle(sectionEntry(provider, section.key), "en")
                return (
                  <li key={section.key} className="flex items-start gap-3 px-3 py-2">
                    <SectionMark provider={provider} type={section.key} className="mt-0.5" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium">
                        {title}
                        {section.lookback ? (
                          <span className="font-normal text-muted-foreground"> · {t("ui.describe.lookback", { count: section.lookback })}</span>
                        ) : null}
                      </span>
                      {section.why ? <span className="text-xs text-muted-foreground">{section.why}</span> : null}
                    </span>
                    {section.key === COVERAGE ? (
                      <span className="text-[11px] text-muted-foreground">{t("ui.describe.always_included")}</span>
                    ) : removable ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("ui.describe.remove_section", { name: title })}
                        title={t("ui.describe.remove_section", { name: title })}
                        onClick={() => onRemove(section.key)}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/** The first page in the chosen look: title, summary and the outline as numbered headings. */
function PagePreview({ outline, name, theme }: Readonly<{ outline: Outline; name: string; theme: DesignPreset }>) {
  const draft = emptyDraftV4(name, outline.provider)
  const { spec } = pageDesign({ ...draft, design: { ...draft.design, preset: theme, accent_color: undefined } })
  return (
    <div aria-hidden className="mx-auto w-full max-w-md overflow-hidden rounded-md border border-border bg-white shadow-sm" style={{ fontFamily: spec.face }}>
      <div className="h-2" style={{ background: spec.accent }} />
      <div className="flex flex-col gap-3 px-6 pt-5 pb-6">
        <div className="text-lg leading-tight font-bold" style={{ color: spec.accent, fontFamily: spec.headingFace }}>{name}</div>
        {outline.summary ? <div className="text-[11px] leading-snug" style={{ color: spec.muted }}>{outline.summary}</div> : null}
        <div className="h-px" style={{ background: spec.rule }} />
        <div className="flex flex-col gap-2.5">
          {outline.sections.map((section, index) => {
            const entry = sectionEntry(outline.provider, section.key)
            return (
              <div key={section.key} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[9px] tabular-nums" style={{ color: spec.muted }}>{String(index + 1).padStart(2, "0")}</span>
                  <span className="text-[11px] font-semibold" style={{ color: spec.ink, fontFamily: spec.headingFace }}>{sectionTitle(entry, "en")}</span>
                </div>
                {entry?.metricBearing ? (
                  <svg viewBox="0 0 100 10" className="h-3 w-full" preserveAspectRatio="none">
                    <polyline points="0,8 12,6 24,7 36,3 48,5 60,4 72,6 84,2 100,5" fill="none" stroke={spec.accent} strokeWidth="1" />
                  </svg>
                ) : (
                  <div className="flex flex-col gap-1">
                    <div className="h-1 w-full rounded-sm" style={{ background: spec.rule }} />
                    <div className="h-1 w-2/3 rounded-sm" style={{ background: spec.rule }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
