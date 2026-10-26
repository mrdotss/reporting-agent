import { z } from "zod"

import { catalogueFor, sectionEntry, sectionTitle, type Provider } from "@/lib/builder/catalogue"
import { settled } from "@/lib/builder/draft"
import type { SectionV4 } from "@/lib/builder/model"
import { STARTERS, type Starter } from "@/lib/builder/starters"
import { THEME_LABELS } from "@/lib/builder/theme"
import {
  DESIGN_PRESETS,
  HISTORICAL_LOOKBACK_MAX,
  HISTORICAL_LOOKBACK_MIN,
  sectionNeedsLookback,
  type DesignPreset,
} from "@/lib/templates/definition"

/**
 * Describe it: a preset outline drafted from a sentence, before the builder opens.
 *
 * An outline is a list of **existing catalogue sections** with a theme, a period and a
 * name — nothing a starter could not also hold. The model chooses among sections; it
 * never invents one, and everything it answers passes {@link validateOutline} before a
 * person sees it. A key the catalogue does not hold is dropped, the verification
 * appendix is always kept, and a trend section always carries a depth the validator
 * accepts.
 *
 * Pure and client-safe: the Bedrock call lives in `describe.ts`, the page reads these
 * types, and the create route turns an outline into a starter with
 * {@link outlineStarter} so the draft is built the way every starter's is.
 */

export const OUTLINE_AUDIENCES = ["executive", "technical", "mixed"] as const
export const OUTLINE_LENGTHS = ["short", "standard", "detailed"] as const
export const OUTLINE_PERIODS = ["last_full_month", "last_30d"] as const

export type OutlineAudience = (typeof OUTLINE_AUDIENCES)[number]
export type OutlineLength = (typeof OUTLINE_LENGTHS)[number]
export type OutlinePeriod = (typeof OUTLINE_PERIODS)[number]

export type OutlineSection = {
  readonly key: string
  /** One line on why this section answers the description. */
  readonly why: string
  readonly lookback?: number
}

export type Outline = {
  readonly provider: Provider
  readonly name: string
  readonly summary: string
  readonly audience: OutlineAudience
  readonly theme: DesignPreset
  readonly period: OutlinePeriod
  readonly contents: boolean
  /** The document's language. */
  readonly language: "en" | "id"
  readonly sections: readonly OutlineSection[]
  /** What was understood from the description, as short notes. */
  readonly understood: readonly string[]
  /** Asks the outline cannot carry: no setting exists for them. */
  readonly notApplied: readonly string[]
  /** After a refine: what changed. */
  readonly changeNote?: string
  /** `model` when drafted by the model; `starter` when matched to a starter instead. */
  readonly source: "model" | "starter"
  readonly starterKey?: string
}

export const DESCRIPTION_MAX_LENGTH = 1200
export const INSTRUCTION_MAX_LENGTH = 400
const NOTE_MAX = 6
const NOTE_LENGTH = 200

/** The request the describe route parses. */
export const describeInputSchema = z
  .object({
    description: z.string().trim().min(8).max(DESCRIPTION_MAX_LENGTH),
    provider: z.enum(["aws", "azure"]),
    audience: z.enum(OUTLINE_AUDIENCES).default("mixed"),
    length: z.enum(OUTLINE_LENGTHS).default("standard"),
    /** A refine: the outline on screen, and what to change about it. */
    current: z.unknown().optional(),
    instruction: z.string().trim().min(2).max(INSTRUCTION_MAX_LENGTH).optional(),
  })
  .strict()

export type DescribeInput = z.output<typeof describeInputSchema>

/** What the create route accepts in place of a starter key. */
export const outlineCreateSchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            type: z.string().min(1).max(64),
            lookback: z.number().int().min(HISTORICAL_LOOKBACK_MIN).max(HISTORICAL_LOOKBACK_MAX).optional(),
          })
          .strict()
      )
      .min(1)
      .max(40),
    period: z.enum(OUTLINE_PERIODS),
    contents: z.boolean(),
    language: z.enum(["en", "id"]).optional(),
    summary: z.string().trim().max(1000).optional(),
  })
  .strict()

export type OutlineCreate = z.output<typeof outlineCreateSchema>

const DEFAULT_LOOKBACK = 6
const COVERAGE = "coverage_and_verification"

function cleanNote(value: unknown, max = NOTE_LENGTH): string | null {
  if (typeof value !== "string") return null
  const line = value.replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim()
  if (line.length === 0) return null
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

function notes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => cleanNote(item)).filter((item): item is string => item !== null).slice(0, NOTE_MAX)
}

function themeFor(audience: OutlineAudience): DesignPreset {
  return audience === "executive" ? "brief" : audience === "technical" ? "technical" : "corporate"
}

/**
 * The sections, kept to the catalogue: unknown keys dropped, repeats dropped, a depth on
 * every trend section, and the verification appendix if it was left out. Returned in the
 * order the builder settles them into, so the outline reads as the document will.
 */
export function validSections(provider: Provider, raw: unknown): OutlineSection[] {
  const seen = new Set<string>()
  const kept: OutlineSection[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const key = typeof item === "string" ? item : (item as { key?: unknown } | null)?.key
    if (typeof key !== "string" || seen.has(key) || sectionEntry(provider, key) === undefined) continue
    seen.add(key)
    const why = cleanNote((item as { why?: unknown } | null)?.why, 160) ?? ""
    if (!sectionNeedsLookback(key)) {
      kept.push({ key, why })
      continue
    }
    const asked = (item as { lookback?: unknown } | null)?.lookback
    const lookback =
      typeof asked === "number" && Number.isFinite(asked)
        ? Math.min(HISTORICAL_LOOKBACK_MAX, Math.max(HISTORICAL_LOOKBACK_MIN, Math.round(asked)))
        : DEFAULT_LOOKBACK
    kept.push({ key, why, lookback })
  }
  if (!seen.has(COVERAGE)) kept.push({ key: COVERAGE, why: "" })
  // The order the builder settles the same sections into, so the outline reads as the
  // document will print.
  const byKey = new Map(kept.map((section) => [section.key, section]))
  return settled(provider, kept.map((section) => ({ type: section.key }) as SectionV4)).map(
    (section) => byKey.get(section.type)!
  )
}

/**
 * A model answer as an outline, or `null` when it carries nothing usable — no JSON, or no
 * section besides the appendix.
 */
export function validateOutline(
  raw: unknown,
  input: Pick<DescribeInput, "provider" | "audience">
): Outline | null {
  if (raw === null || typeof raw !== "object") return null
  const answer = raw as Record<string, unknown>
  const sections = validSections(input.provider, answer.sections)
  if (sections.filter((section) => section.key !== COVERAGE).length === 0) return null
  const audience = OUTLINE_AUDIENCES.includes(answer.audience as OutlineAudience)
    ? (answer.audience as OutlineAudience)
    : input.audience
  const theme = DESIGN_PRESETS.includes(answer.theme as DesignPreset)
    ? (answer.theme as DesignPreset)
    : themeFor(audience)
  const period = OUTLINE_PERIODS.includes(answer.period as OutlinePeriod)
    ? (answer.period as OutlinePeriod)
    : "last_full_month"
  return {
    provider: input.provider,
    name: cleanNote(answer.name, 120) ?? "Described preset",
    summary: cleanNote(answer.summary, 300) ?? "",
    audience,
    theme,
    period,
    contents: typeof answer.contents === "boolean" ? answer.contents : sections.length > 5,
    language: answer.language === "id" ? "id" : "en",
    sections,
    understood: notes(answer.understood),
    notApplied: notes(answer.not_applied),
    ...(cleanNote(answer.change_note) ? { changeNote: cleanNote(answer.change_note)! } : {}),
    source: "model",
  }
}

/** The first JSON object in a model's text, or `null`. */
export function parseModelJson(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

const STARTER_HINTS: ReadonlyArray<readonly [Starter["key"], RegExp]> = [
  ["executive_brief", /\b(exec|executive|board|one[- ]page|brief|ringkas|eksekutif|direksi)/i],
  ["capacity_planning", /\b(capacity|peak|p95|trend|forecast|kapasitas|tren)/i],
  ["backup_exposure", /\b(backup|exposure|internet|public ip|security|cadangan|keamanan)/i],
  ["rightsizing_review", /\b(rightsiz|right-siz|saving|cost|idle|oversiz|hemat|biaya)/i],
  ["quarterly_review", /\b(quarter|qbr|business review|kuartal|triwulan)/i],
]

/**
 * When the model is unreachable: the starter whose subject the description names, or
 * monthly utilisation. Honest about it — `source` says the outline came from a starter.
 */
export function starterOutline(input: Pick<DescribeInput, "description" | "provider" | "audience">): Outline {
  const key = STARTER_HINTS.find(([, pattern]) => pattern.test(input.description))?.[0] ?? "monthly_utilization"
  const starter = STARTERS.find((entry) => entry.key === key)!
  const sections = validSections(
    input.provider,
    starter.sections[input.provider].map((section) => ({ key: section.type, why: "", lookback: section.lookback }))
  )
  return {
    provider: input.provider,
    name: `${starter.name} — ${input.provider === "aws" ? "AWS" : "Azure"}`,
    summary: starter.blurb,
    audience: input.audience,
    theme: starter.theme,
    period: starter.period,
    contents: starter.contents !== false,
    language: "en",
    sections,
    understood: [],
    notApplied: [],
    source: "starter",
    starterKey: starter.key,
  }
}

/** An outline the page sent back for a refine, re-checked like a model answer. */
export function currentOutline(raw: unknown, input: Pick<DescribeInput, "provider" | "audience">): Outline | null {
  if (raw === null || typeof raw !== "object") return null
  const outline = raw as Record<string, unknown>
  return validateOutline(
    { ...outline, not_applied: outline.notApplied, change_note: undefined },
    input
  )
}

/** The catalogue, one line per section, for the model to choose from. */
export function catalogueBrief(provider: Provider): string {
  return catalogueFor(provider)
    .filter((entry) => entry.key !== COVERAGE)
    .map((entry) => {
      const note = entry.notes ? ` — ${entry.notes.replace(/\s+/g, " ").slice(0, 140)}` : ""
      const depth = sectionNeedsLookback(entry.key)
        ? ` (needs lookback: months of history, ${HISTORICAL_LOOKBACK_MIN}-${HISTORICAL_LOOKBACK_MAX})`
        : ""
      return `- ${entry.key} [${entry.group}]: ${sectionTitle(entry, "en")}${depth}${note}`
    })
    .join("\n")
}

/** The themes, one line each, for the model to choose from. */
export function themeBrief(): string {
  return DESIGN_PRESETS.map((preset) => `- ${preset}: ${THEME_LABELS[preset].note}`).join("\n")
}

/** The outline as a starter, so the create route builds its draft as it builds any starter's. */
export function outlineStarter(provider: Provider, name: string, theme: DesignPreset, outline: OutlineCreate): Starter {
  const sections = validSections(
    provider,
    outline.sections.map((section) => ({ key: section.type, lookback: section.lookback }))
  ).map((section) => ({ type: section.key, ...(section.lookback ? { lookback: section.lookback } : {}) }))
  return {
    key: "blank",
    name,
    blurb: outline.summary ?? "",
    theme,
    period: outline.period,
    isNew: false,
    contents: outline.contents,
    sections: { aws: provider === "aws" ? sections : [], azure: provider === "azure" ? sections : [] },
  }
}
