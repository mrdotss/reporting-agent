"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import {
  ArrowRightIcon,
  CheckIcon,
  CircleNotchIcon,
  FileTextIcon,
  InfoIcon,
  LockSimpleIcon,
  PresentationChartIcon,
  ShieldCheckIcon,
  SparkleIcon,
  ChartBarIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react"

import { ProviderMark, SOURCE_NAMES } from "@/components/subscriptions/provider-mark"
import { sectionIcon } from "@/components/templates/section-marks"
import { Button } from "@/components/ui/button"
import { useCreationScope } from "@/components/workspaces/workspace-context"
import { GROUP_ORDER, catalogueFor, sectionEntry, sectionTitle, type Provider } from "@/lib/builder/catalogue"
import { emptyDraftV4 } from "@/lib/builder/draft"
import { STARTERS } from "@/lib/builder/starters"
import { THEME_LABELS, pageDesign, themeAccent } from "@/lib/builder/theme"
import { messageText, type MessageId } from "@/lib/messages/catalog"
import { PRESET_HEADING_FACES } from "@/lib/profiles/preview-sample"
import { noticedSegments } from "@/lib/presets/noticed"
import type { Outline, OutlineAudience, OutlineLength } from "@/lib/presets/outline"
import { DESIGN_PRESETS, type DesignPreset } from "@/lib/templates/definition"
import { cn } from "@/lib/utils"

/**
 * Describe it: a sentence in, an outline out, then the builder.
 *
 * Two columns, so what was asked and what was drafted are side by side. The input column
 * holds the cloud, the description (the largest thing on the page), suggestions, audience
 * and length, then "How we read it" — what the drafting understood, and what it could not
 * apply because no preset setting exists for it — and the refine controls with their
 * history. The output column shows the outline, grouped as the document is, and a preview
 * of the first page in the chosen look. Name, look and the save actions sit in a bar that
 * stays at the bottom once there is an outline.
 *
 * While an outline drafts, the output column shows three stages: the description read
 * back with familiar phrases marked, the cloud's catalogue scanned, and an outline
 * skeleton checked. The request reports no progress, so the stages advance on a timer and
 * the last one holds until the reply; a fast reply skips to the last stage briefly so
 * nothing flashes. The marks come from a fixed word list (`noticedSegments`), never the
 * model, and the scan never claims a pick.
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

const AUDIENCES: ReadonlyArray<readonly [OutlineAudience, MessageId, MessageId]> = [
  ["executive", "ui.describe.audience_executive", "ui.describe.audience_executive_hint"],
  ["technical", "ui.describe.audience_technical", "ui.describe.audience_technical_hint"],
  ["mixed", "ui.describe.audience_mixed", "ui.describe.audience_mixed_hint"],
]

const LENGTHS: ReadonlyArray<readonly [OutlineLength, MessageId, MessageId]> = [
  ["short", "ui.describe.length_short", "ui.describe.length_short_hint"],
  ["standard", "ui.describe.length_standard", "ui.describe.length_standard_hint"],
  ["detailed", "ui.describe.length_detailed", "ui.describe.length_detailed_hint"],
]

const EXAMPLES: ReadonlyArray<readonly [MessageId, MessageId, Icon]> = [
  ["ui.describe.example_exec_title", "ui.describe.example_exec", PresentationChartIcon],
  ["ui.describe.example_capacity_title", "ui.describe.example_capacity", ChartBarIcon],
  ["ui.describe.example_backup_title", "ui.describe.example_backup", ShieldCheckIcon],
]

const REFINES: readonly MessageId[] = [
  "ui.describe.refine_shorter",
  "ui.describe.refine_technical",
  "ui.describe.refine_backups",
  "ui.describe.refine_trend",
]

const STAGES: ReadonlyArray<readonly [MessageId, MessageId]> = [
  ["ui.describe.progress_read", "ui.describe.progress_read_note"],
  ["ui.describe.progress_choose", "ui.describe.progress_choose_note"],
  ["ui.describe.progress_check", "ui.describe.progress_check_note"],
]

const JOURNEY: readonly MessageId[] = ["ui.describe.step_describe", "ui.describe.step_refine", "ui.describe.step_save"]

/** When each later stage starts, in ms after Draft; the last holds until the reply. */
const STAGE_AT = [2600, 5200] as const
/** How long a reply that beats the timer still shows the last stage. */
const FAST_REPLY_HOLD = 500

const SHORT_CLOUD: Readonly<Record<Provider, string>> = { aws: "AWS", azure: "Azure" }

/** Skeleton rows for the empty and checking states: a width per row, grouped as the document is. */
const SKELETON: readonly (readonly string[])[] = [["40%"], ["58%", "36%"], ["64%", "48%"], ["30%", "52%", "44%"]]

const COVERAGE = "coverage_and_verification"

const subscribeNothing = () => () => {}

/** Whether the shortcut reads ⌘ or Ctrl. Server render and first paint say Ctrl. */
function useIsMac() {
  return useSyncExternalStore(
    subscribeNothing,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => false
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string
  value: T
  options: ReadonlyArray<readonly [T, MessageId, MessageId]>
  onChange: (next: T) => void
}>) {
  const labelId = useId()
  const hint = options.find(([option]) => option === value)?.[2]
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-[13px] font-semibold">{label}</span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex gap-0.5 rounded-[10px] bg-muted p-[3px]">
        {options.map(([option, id]) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            onClick={() => onChange(option)}
            className={cn(
              "inline-flex h-8 flex-1 items-center justify-center rounded-[7px] px-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
              value === option && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,20,30,.10),0_0_0_1px_rgba(20,20,30,.05)]"
            )}
          >
            {t(id)}
          </button>
        ))}
      </div>
      {hint ? <span className="text-meta text-muted-foreground">{t(hint)}</span> : null}
    </div>
  )
}

function Card({ label, className, children }: Readonly<{ label: string; className?: string; children: ReactNode }>) {
  return (
    <section
      aria-label={label}
      className={cn("flex flex-col rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(20,20,30,.04)]", className)}
    >
      {children}
    </section>
  )
}

function Eyebrow({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="text-micro text-muted-foreground uppercase">{children}</span>
}

export function DescribeScreen({
  defaultProvider,
  canCreate,
}: Readonly<{ defaultProvider: Provider; canCreate: boolean }>) {
  const router = useRouter()
  const scope = useCreationScope()
  const isMac = useIsMac()
  const descriptionId = useId()
  const nameId = useId()
  const refineId = useId()
  const cloudLabelId = useId()
  const lookLabelId = useId()

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
  const [stage, setStage] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  // The read of what was sent, so the drafting stage shows the description it is drafting.
  const [sent, setSent] = useState("")

  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const stageRef = useRef(0)
  const clearTimers = () => {
    timers.current.forEach((timer) => clearTimeout(timer))
    timers.current = []
  }
  useEffect(() => () => timers.current.forEach((timer) => clearTimeout(timer)), [])

  const moveTo = (next: number) => {
    stageRef.current = next
    setStage(next)
  }

  const startStages = () => {
    clearTimers()
    moveTo(0)
    setElapsed(0)
    STAGE_AT.forEach((at, index) => {
      timers.current.push(setTimeout(() => moveTo(Math.max(stageRef.current, index + 1)), at))
    })
    const tick = () => {
      setElapsed((seconds) => seconds + 1)
      timers.current.push(setTimeout(tick, 1000))
    }
    timers.current.push(setTimeout(tick, 1000))
  }

  const request = async (refine?: string) => {
    if (busy !== null || description.trim().length < 8) return
    const drafting = refine === undefined
    setBusy(drafting ? "draft" : "refine")
    setError(null)
    if (drafting) {
      setSent(description.trim())
      startStages()
    }
    try {
      const response = await fetch("/api/report-profiles/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          provider,
          audience,
          length,
          ...(drafting || outline === null ? {} : { current: outline, instruction: refine }),
        }),
      })
      const body = (await response.json().catch(() => null)) as { outline?: Outline } | null
      if (!response.ok || !body?.outline) {
        setError(t(drafting ? "ui.describe.error_draft" : "ui.describe.error_refine"))
        return
      }
      if (drafting && stageRef.current < STAGES.length - 1) {
        moveTo(STAGES.length - 1)
        await sleep(FAST_REPLY_HOLD)
      }
      const next = body.outline
      setOutline(next)
      setName(next.name)
      setTheme(next.theme)
      if (drafting) {
        setHistory([])
        setTab("outline")
      } else {
        setHistory((entries) => [...entries, next.changeNote ?? refine])
        setInstruction("")
      }
    } catch {
      setError(t(drafting ? "ui.describe.error_draft" : "ui.describe.error_refine"))
    } finally {
      clearTimers()
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

  const drafting = busy === "draft"
  const refining = busy === "refine"
  const ready = description.trim().length >= 8
  const starterName = outline?.starterKey ? STARTERS.find((starter) => starter.key === outline.starterKey)?.name : undefined
  const journeyAt = outline === null ? 0 : 1
  const draftHint = !ready
    ? t("ui.describe.draft_hint_empty")
    : outline === null
      ? t("ui.describe.draft_hint_ready")
      : t("ui.describe.draft_hint_again")

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex max-w-[40rem] flex-col gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-micro text-primary uppercase">
            <SparkleIcon aria-hidden="true" weight="fill" className="size-3.5" />
            {t("ui.describe.eyebrow")}
          </span>
          <h1 className="text-display">{t("ui.describe.title")}</h1>
          <p className="text-[15px] leading-relaxed text-muted-foreground">{t("ui.describe.lead")}</p>
        </div>
        <ol aria-label={t("ui.describe.steps")} className="flex items-center gap-2 text-[13px]">
          {JOURNEY.map((id, index) => (
            <li key={id} className="flex items-center gap-2" aria-current={index === journeyAt ? "step" : undefined}>
              <span className={cn("inline-flex items-center gap-1.5 text-muted-foreground", index === journeyAt && "font-semibold text-foreground")}>
                <span
                  className={cn(
                    "grid size-5 place-items-center rounded-full text-[11px] font-semibold",
                    index <= journeyAt ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  )}
                >
                  {index + 1}
                </span>
                {t(id)}
              </span>
              {index < JOURNEY.length - 1 ? <span aria-hidden="true" className="h-px w-6 bg-input" /> : null}
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        {/* Input */}
        <div className="flex max-w-[28rem] min-w-0 flex-[1_1_22rem] flex-col gap-4">
          <Card label={t("ui.describe.step_describe")} className="gap-6 p-5 sm:p-6">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span id={cloudLabelId} className="text-[13px] font-semibold">{t("ui.describe.cloud")}</span>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <LockSimpleIcon aria-hidden="true" className="size-3" />
                  {t("ui.describe.cloud_fixed")}
                </span>
              </div>
              <div role="radiogroup" aria-labelledby={cloudLabelId} className="grid grid-cols-2 gap-2.5">
                {(["aws", "azure"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={provider === option}
                    disabled={outline !== null || drafting}
                    onClick={() => setProvider(option)}
                    className={cn(
                      "flex min-h-14 min-w-0 items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5 text-left transition-[border-color,box-shadow] hover:border-input disabled:cursor-not-allowed disabled:opacity-60",
                      provider === option && "border-primary shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_12%,transparent)] hover:border-primary"
                    )}
                  >
                    <ProviderMark kind={option} className="shrink-0 [&_svg]:size-5" />
                    <span className="min-w-0 truncate text-[13.5px] font-semibold" title={SOURCE_NAMES[option]}>
                      {SHORT_CLOUD[option]}
                      <span className="sr-only"> ({SOURCE_NAMES[option]})</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "ms-auto grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] border-input",
                        provider === option && "border-primary bg-primary text-primary-foreground"
                      )}
                    >
                      {provider === option ? <CheckIcon weight="bold" className="size-2.5" /> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              <label htmlFor={descriptionId} className="text-[13px] font-semibold">
                {t("ui.describe.description_label")}
              </label>
              <div className="rounded-xl border border-input bg-card transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_4px_color-mix(in_oklab,var(--primary)_9%,transparent)]">
                <textarea
                  id={descriptionId}
                  value={description}
                  maxLength={1200}
                  rows={5}
                  onChange={(event) => setDescription(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault()
                      void request()
                    }
                  }}
                  placeholder={t("ui.describe.description_placeholder")}
                  className="block min-h-32 w-full resize-y bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
                />
                <div className="flex items-center justify-between gap-2 px-4 pb-2.5">
                  <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
                    {t("ui.describe.char_count", { count: description.length, max: 1200 })}
                  </span>
                  {description.length > 0 && !drafting ? (
                    <button
                      type="button"
                      onClick={() => setDescription("")}
                      className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {t("ui.describe.clear")}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            {outline === null && !drafting ? (
              <div className="flex flex-col gap-2">
                <Eyebrow>{t("ui.describe.examples")}</Eyebrow>
                {EXAMPLES.map(([titleId, textId, Glyph]) => (
                  <button
                    key={textId}
                    type="button"
                    onClick={() => setDescription(t(textId))}
                    className="group flex w-full items-start gap-3 rounded-[10px] border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary"
                  >
                    <span aria-hidden="true" className="grid size-7.5 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Glyph className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13.5px] font-semibold">{t(titleId)}</span>
                      <span className="text-[12.5px] leading-snug text-muted-foreground">{t(textId)}</span>
                    </span>
                    <ArrowRightIcon
                      aria-hidden="true"
                      className="ms-auto size-4 shrink-0 self-center text-primary opacity-0 transition-[opacity,transform] -translate-x-1 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
                    />
                  </button>
                ))}
              </div>
            ) : null}

            <div className="flex flex-col gap-4">
              <Segmented label={t("ui.describe.audience")} value={audience} options={AUDIENCES} onChange={setAudience} />
              <Segmented label={t("ui.describe.length")} value={length} options={LENGTHS} onChange={setLength} />
            </div>

            <div className="flex flex-col gap-2">
              <Button
                size="lg"
                // While drafting the button keeps its colour so the animation reads; a click is ignored.
                disabled={(busy !== null && !drafting) || !ready}
                aria-busy={drafting}
                onClick={() => void request()}
                className="relative h-11 w-full overflow-hidden rounded-[11px] text-[15px]"
              >
                {drafting ? (
                  <>
                    <SparkleIcon aria-hidden="true" weight="fill" className="describe-twinkle size-4.5" />
                    {t("ui.describe.drafting")}
                    <span aria-hidden="true" className="describe-slide absolute bottom-0 left-0 h-[3px] w-[30%] rounded-full bg-primary-foreground/75" />
                  </>
                ) : (
                  <>
                    <SparkleIcon aria-hidden="true" weight="fill" className="size-4.5" />
                    {outline === null ? t("ui.describe.draft") : t("ui.describe.redraft")}
                    <kbd aria-hidden="true" className="ms-1 rounded-[5px] border border-primary-foreground/35 px-1.5 py-px font-mono text-[11px] font-normal text-primary-foreground/85">
                      {isMac ? "⌘ ↵" : "Ctrl ↵"}
                    </kbd>
                  </>
                )}
              </Button>
              {drafting ? null : <span className="text-center text-xs text-muted-foreground">{draftHint}</span>}
            </div>
          </Card>

          {outline !== null ? (
            <Card label={t("ui.describe.step_refine")} className="describe-rise gap-5 p-5 sm:p-6">
              {outline.understood.length > 0 || outline.notApplied.length > 0 ? (
                <div className="flex flex-col gap-2.5">
                  <span className="text-[13px] font-semibold">{t("ui.describe.how_we_read")}</span>
                  <ul className="flex flex-col gap-2">
                    {outline.understood.map((note, index) => (
                      <li key={`u-${index}`} className="flex items-start gap-2.5 text-[13.5px] leading-snug">
                        <span aria-hidden="true" className="mt-px grid size-4.5 shrink-0 place-items-center rounded-full bg-(--status-verified-soft) text-(--status-verified)">
                          <CheckIcon weight="bold" className="size-2.5" />
                        </span>
                        {note}
                      </li>
                    ))}
                  </ul>
                  {outline.notApplied.length > 0 ? (
                    <div className="flex flex-col gap-1.5 rounded-[10px] bg-(--status-attention-soft) px-3.5 py-3">
                      <span className="text-[12.5px] font-semibold text-(--status-attention)">{t("ui.describe.not_applied")}</span>
                      <ul className="flex flex-col gap-1">
                        {outline.notApplied.map((note, index) => (
                          <li key={`n-${index}`} className="flex items-start gap-2 text-[13px] leading-snug">
                            <XIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-(--status-attention)" />
                            {note}
                          </li>
                        ))}
                      </ul>
                      <span className="text-xs leading-snug text-muted-foreground">{t("ui.describe.not_applied_note")}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-col gap-2.5 border-t border-border pt-5">
                <label htmlFor={refineId} className="text-[13px] font-semibold">{t("ui.describe.step_refine")}</label>
                <div className="flex flex-wrap gap-1.5">
                  {REFINES.map((id) => (
                    <button
                      key={id}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void request(t(id))}
                      className="h-7.5 rounded-full border border-border bg-card px-3 text-[12.5px] transition-colors hover:border-primary disabled:opacity-60"
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
                  <input
                    id={refineId}
                    value={instruction}
                    maxLength={400}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder={t("ui.describe.refine_placeholder")}
                    className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-card px-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/15"
                  />
                  <Button type="submit" variant="outline" disabled={busy !== null || instruction.trim().length < 2}>
                    {refining ? <CircleNotchIcon aria-hidden="true" className="animate-spin" /> : null}
                    {t("ui.describe.refine_apply")}
                  </Button>
                </form>
                {history.length > 0 ? (
                  <div className="flex flex-col gap-1 pt-1">
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
              </div>
            </Card>
          ) : null}

          {error ? (
            <p aria-live="polite" className="text-sm text-destructive">{error}</p>
          ) : null}
        </div>

        {/* Output */}
        <div className="flex min-w-0 flex-[999_1_32rem] flex-col gap-3">
          <Card label={t("ui.describe.output")} className="min-h-[40rem] overflow-hidden">
            <div aria-busy={drafting || refining} className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border px-4 py-3.5">
              <div role="tablist" className="flex gap-0.5 rounded-[10px] bg-muted p-[3px]">
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
                    disabled={outline === null || drafting}
                    onClick={() => setTab(value)}
                    className={cn(
                      "inline-flex h-7.5 items-center rounded-[7px] px-3 text-[13px] text-muted-foreground disabled:opacity-60",
                      tab === value && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,20,30,.10),0_0_0_1px_rgba(20,20,30,.05)]"
                    )}
                  >
                    {t(id)}
                  </button>
                ))}
              </div>
              {drafting ? (
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
                </span>
              ) : outline !== null ? (
                <span className="flex flex-wrap gap-1.5 text-xs text-foreground">
                  {[
                    t("ui.describe.section_count", { count: outline.sections.length }),
                    outline.period === "last_30d" ? t("ui.describe.period_last_30d") : t("ui.describe.period_last_full_month"),
                    outline.contents ? t("ui.describe.contents_on") : t("ui.describe.contents_off"),
                    outline.language === "id" ? t("ui.describe.language_id") : t("ui.describe.language_en"),
                  ].map((label) => (
                    <span key={label} className="rounded-full bg-accent px-2.5 py-1">{label}</span>
                  ))}
                </span>
              ) : null}
            </div>

            {drafting ? (
              <Drafting stage={stage} provider={provider} description={sent} />
            ) : outline === null ? (
              <EmptyOutline />
            ) : (
              <div className="relative flex flex-1 flex-col">
                {refining ? (
                  <span aria-live="polite" className="sr-only">{t("ui.describe.refining")}</span>
                ) : null}
                {outline.source === "starter" && starterName ? (
                  <p className="mx-7 mt-6 flex items-start gap-2 rounded-[10px] bg-muted px-3.5 py-2.5 text-[13px]">
                    <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    {t("ui.describe.from_starter", { name: starterName })}
                  </p>
                ) : null}
                <div className={cn("flex flex-1 flex-col transition-opacity", refining && "opacity-55")}>
                  {tab === "outline" ? (
                    <OutlineList outline={outline} onRemove={removeSection} />
                  ) : (
                    <PagePreview outline={outline} name={name || outline.name} theme={theme} />
                  )}
                </div>
                {refining ? (
                  <span aria-hidden="true" className="describe-line pointer-events-none absolute inset-x-5 h-0.5 rounded-full bg-primary shadow-[0_0_12px_2px_color-mix(in_oklab,var(--primary)_25%,transparent)]" />
                ) : null}
              </div>
            )}
          </Card>
        </div>
      </div>

      {outline !== null ? (
        <div className="describe-rise sticky bottom-0 z-10 -mx-4 border-t border-border bg-background/95 px-4 py-3.5 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-end gap-x-5 gap-y-4">
            <div className="flex max-w-[21rem] min-w-0 flex-[1_1_15rem] flex-col gap-1.5">
              <label htmlFor={nameId} className="text-xs font-semibold text-foreground">{t("ui.describe.name")}</label>
              <input
                id={nameId}
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                className="h-10 rounded-[9px] border border-input bg-card px-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/15"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span id={lookLabelId} className="text-xs font-semibold text-foreground">
                {t("ui.describe.theme")} · <span className="font-medium text-muted-foreground">{THEME_LABELS[theme].name}</span>
              </span>
              <div role="radiogroup" aria-labelledby={lookLabelId} className="flex flex-wrap gap-1.5">
                {DESIGN_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    role="radio"
                    aria-checked={theme === preset}
                    aria-label={THEME_LABELS[preset].name}
                    title={`${THEME_LABELS[preset].name}: ${THEME_LABELS[preset].note}`}
                    onClick={() => setTheme(preset)}
                    className={cn(
                      "grid size-10 place-items-center rounded-[9px] border border-border bg-card text-[15px] font-bold transition-[border-color,box-shadow] hover:border-input",
                      theme === preset && "border-primary shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_14%,transparent)] hover:border-primary"
                    )}
                    style={{ fontFamily: PRESET_HEADING_FACES[preset], color: themeAccent(preset) }}
                  >
                    Aa
                  </button>
                ))}
              </div>
            </div>
            <div className="ms-auto flex flex-col items-end gap-1.5">
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="lg" variant="outline" disabled={!canCreate || busy !== null} onClick={() => void create(false)}>
                  {t("ui.describe.save_draft")}
                </Button>
                <Button size="lg" disabled={!canCreate || busy !== null} onClick={() => void create(true)}>
                  {busy === "create" ? t("ui.describe.creating") : t("ui.describe.open_builder")}
                  <ArrowRightIcon aria-hidden="true" />
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                {canCreate ? t("ui.describe.save_note") : t("ui.describe.cannot_create")}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Before anything is drafted: a faint outline of what will appear, and a way to a starter. */
function EmptyOutline() {
  return (
    <div className="relative flex min-h-[34rem] flex-1 flex-col p-7">
      <div aria-hidden="true" className="flex flex-col gap-5 opacity-55">
        {GROUP_ORDER.map((group, index) => (
          <div key={group} className="flex flex-col gap-2">
            <span className="text-micro text-muted-foreground uppercase">{t(GROUP_IDS[group]!)}</span>
            <div className="rounded-xl border border-dashed border-input">
              {(SKELETON[index] ?? []).map((width, row) => (
                <div key={row} className="flex items-center gap-3 px-3.5 py-3">
                  <div className="size-7.5 shrink-0 rounded-lg bg-muted" />
                  <div className="flex flex-1 flex-col gap-2">
                    <div className="h-2 rounded bg-muted" style={{ width }} />
                    <div className="h-1.5 w-2/3 rounded bg-muted/70" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="absolute inset-0 grid place-items-center p-6">
        <div className="flex max-w-[22.5rem] flex-col items-center gap-3 rounded-2xl border border-border bg-card/95 px-6 pt-6 pb-5 text-center shadow-[0_12px_32px_-12px_rgba(20,20,30,.18)]">
          <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
            <FileTextIcon className="size-5.5" />
          </span>
          <span className="text-base font-semibold">{t("ui.describe.output_empty_title")}</span>
          <span className="text-[13.5px] leading-normal text-muted-foreground">{t("ui.describe.output_empty")}</span>
          <Link href="/report-profiles/new" className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
            {t("ui.presets.quick_starter_title")}
            <ArrowRightIcon aria-hidden="true" className="size-3.5" />
          </Link>
        </div>
      </div>
    </div>
  )
}

/** The three drafting stages: read, choose, check. See the module note on why they are timed. */
function Drafting({ stage, provider, description }: Readonly<{ stage: number; provider: Provider; description: string }>) {
  const catalogue = catalogueFor(provider)
  const cloud = SHORT_CLOUD[provider]
  return (
    <div className="flex flex-1 flex-col gap-5 px-7 pt-6 pb-7">
      <ol aria-live="polite" className="grid grid-cols-3 gap-3">
        {STAGES.map(([labelId, noteId], index) => {
          const done = index < stage
          const active = index === stage
          return (
            <li key={labelId} className="flex min-w-0 flex-col gap-2.5" aria-current={active ? "step" : undefined}>
              <div className="h-[3px] overflow-hidden rounded-full bg-muted">
                {done ? <div className="h-full bg-primary" /> : null}
                {active && index < STAGES.length - 1 ? <div className="describe-fill h-full bg-primary" /> : null}
                {active && index === STAGES.length - 1 ? <div className="describe-shimmer h-full opacity-80" /> : null}
              </div>
              <div className="flex items-start gap-2">
                {done ? (
                  <span aria-hidden="true" className="grid size-4.5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                    <CheckIcon weight="bold" className="size-2.5" />
                  </span>
                ) : active ? (
                  <span aria-hidden="true" className="grid size-4.5 shrink-0 place-items-center rounded-full border-2 border-primary">
                    <span className="describe-pulse size-2 rounded-full bg-primary" />
                  </span>
                ) : (
                  <span aria-hidden="true" className="size-4.5 shrink-0 rounded-full border-[1.5px] border-input" />
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className={cn("text-[13px] font-medium", active ? "font-semibold text-foreground" : done ? "text-foreground" : "text-muted-foreground")}>
                    {t(labelId)}
                  </span>
                  <span className="hidden text-xs text-muted-foreground sm:block">
                    {t(noteId, index === 1 ? { count: catalogue.length, cloud } : undefined)}
                  </span>
                </span>
              </div>
            </li>
          )
        })}
      </ol>

      <div className="relative flex min-h-[28.5rem] flex-1 flex-col justify-center overflow-hidden rounded-[14px] border border-border/70 bg-muted/45 p-6 sm:p-7">
        {stage === 0 ? (
          <div className="mx-auto flex max-w-[39rem] flex-col gap-4">
            <Eyebrow>{t("ui.describe.stage_read_title")}</Eyebrow>
            <p className="text-lg leading-relaxed tracking-[-0.01em] text-muted-foreground sm:text-[22px]">
              {noticedSegments(description).map((segment, index) =>
                segment.marked ? (
                  <span key={index} className="describe-mark font-semibold text-foreground" style={{ animationDelay: `${0.3 + segment.order * 0.32}s` }}>
                    {segment.text}
                  </span>
                ) : (
                  <span key={index}>{segment.text}</span>
                )
              )}
              <span aria-hidden="true" className="describe-caret ms-0.5 inline-block h-[1.1em] w-0.5 -translate-y-px bg-primary align-middle" />
            </p>
            <span className="text-meta text-muted-foreground">{t("ui.describe.stage_read_note")}</span>
          </div>
        ) : stage === 1 ? (
          <div className="mx-auto flex max-w-[42rem] flex-col gap-4">
            <Eyebrow>{t("ui.describe.stage_choose_title", { count: catalogue.length, cloud })}</Eyebrow>
            <div className="flex flex-wrap gap-2">
              {catalogue.map((section, index) => (
                <span
                  key={section.key}
                  className="describe-scan inline-flex h-7.5 items-center rounded-full border border-border bg-card px-3 text-[12.5px] text-muted-foreground"
                  style={{ animationDelay: `${index * 0.09}s` }}
                >
                  {sectionTitle(section, "en")}
                </span>
              ))}
            </div>
            <span className="text-meta text-muted-foreground">{t("ui.describe.stage_choose_note")}</span>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[35rem] flex-col gap-3.5">
            <Eyebrow>{t("ui.describe.progress_check")}</Eyebrow>
            <div className="relative flex flex-col gap-4 rounded-xl border border-border bg-card px-5.5 pt-5.5 pb-6 shadow-[0_10px_30px_-14px_rgba(20,20,30,.2)]">
              {SKELETON.map((rows, group) => (
                <div key={group} className="describe-rise flex flex-col gap-2.5" style={{ animationDelay: `${group * 0.25}s` }}>
                  <div className="describe-shimmer h-[7px] w-16 rounded opacity-80" />
                  {rows.map((width, row) => (
                    <div key={row} className="flex items-center gap-2.5">
                      <div className="describe-shimmer size-5.5 shrink-0 rounded-md" />
                      <div className="describe-shimmer h-2.5 rounded" style={{ width }} />
                    </div>
                  ))}
                </div>
              ))}
              <span aria-hidden="true" className="describe-line absolute inset-x-4.5 h-0.5 rounded-full bg-primary shadow-[0_0_12px_2px_color-mix(in_oklab,var(--primary)_25%,transparent)]" />
            </div>
          </div>
        )}
      </div>
      <span className="text-center text-meta text-muted-foreground">{t("ui.describe.drafting_note")}</span>
    </div>
  )
}

function OutlineList({ outline, onRemove }: Readonly<{ outline: Outline; onRemove: (key: string) => void }>) {
  const provider = outline.provider
  const removable = outline.sections.filter((section) => section.key !== COVERAGE).length > 1
  let shown = 0
  return (
    <div className="flex flex-col gap-5.5 px-7 pt-6 pb-7">
      {outline.summary ? <p className="describe-rise max-w-[42rem] text-[15.5px] leading-relaxed">{outline.summary}</p> : null}
      {GROUP_ORDER.map((group) => {
        const inGroup = outline.sections.filter((section) => sectionEntry(provider, section.key)?.group === group)
        if (inGroup.length === 0) return null
        const delay = 0.08 + shown++ * 0.09
        return (
          <div key={group} className="describe-rise flex flex-col gap-2" style={{ animationDelay: `${delay}s` }}>
            <div className="flex items-baseline gap-2">
              <span className="text-micro text-muted-foreground uppercase">{t(GROUP_IDS[group]!)}</span>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{inGroup.length}</span>
            </div>
            <ul className="flex flex-col divide-y divide-border/70 overflow-hidden rounded-xl border border-border">
              {inGroup.map((section) => {
                const title = sectionTitle(sectionEntry(provider, section.key), "en")
                const Glyph = sectionIcon(provider, section.key)
                return (
                  <li key={section.key} className="group flex items-start gap-3 px-3.5 py-3">
                    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Glyph className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{title}</span>
                        {section.lookback ? (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11.5px] font-medium text-primary">
                            {t("ui.describe.lookback", { count: section.lookback })}
                          </span>
                        ) : null}
                      </span>
                      {section.why ? <span className="text-[13px] leading-snug text-muted-foreground">{section.why}</span> : null}
                    </span>
                    {section.key === COVERAGE ? (
                      <span className="self-center text-[11.5px] whitespace-nowrap text-muted-foreground">{t("ui.describe.always_included")}</span>
                    ) : removable ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("ui.describe.remove_section", { name: title })}
                        title={t("ui.describe.remove_section", { name: title })}
                        onClick={() => onRemove(section.key)}
                        className="self-center opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
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
    <div className="flex flex-1 flex-col items-center gap-3.5 bg-muted/50 px-6 pt-8 pb-10">
      <div
        aria-hidden
        className="describe-rise w-full max-w-[29rem] overflow-hidden rounded-[4px] bg-white shadow-[0_1px_2px_rgba(20,20,30,.08),0_18px_40px_-18px_rgba(20,20,30,.28)]"
        style={{ fontFamily: spec.face }}
      >
        <div className="h-2.5" style={{ background: spec.accent }} />
        <div className="flex flex-col gap-3.5 px-9 pt-8 pb-10">
          <div className="text-2xl leading-tight font-bold" style={{ color: spec.accent, fontFamily: spec.headingFace }}>{name}</div>
          {outline.summary ? <div className="text-[11px] leading-normal" style={{ color: spec.muted }}>{outline.summary}</div> : null}
          <div className="h-px" style={{ background: spec.rule }} />
          <div className="flex flex-col gap-3">
            {outline.sections.map((section, index) => {
              const entry = sectionEntry(outline.provider, section.key)
              return (
                <div key={section.key} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[9px] tabular-nums" style={{ color: spec.muted }}>{String(index + 1).padStart(2, "0")}</span>
                    <span className="text-[11.5px] font-semibold" style={{ color: spec.ink, fontFamily: spec.headingFace }}>{sectionTitle(entry, "en")}</span>
                  </div>
                  {entry?.metricBearing ? (
                    <svg viewBox="0 0 100 10" className="h-3 w-full" preserveAspectRatio="none">
                      <polyline points="0,8 12,6 24,7 36,3 48,5 60,4 72,6 84,2 100,5" fill="none" stroke={spec.accent} strokeWidth="1" />
                    </svg>
                  ) : (
                    <div className="flex flex-col gap-1 ps-5">
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
      <span className="text-meta text-muted-foreground">{t("ui.describe.preview_note", { name: THEME_LABELS[theme].name })}</span>
    </div>
  )
}
