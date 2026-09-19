import { isChatModelId } from "@/lib/chat/models"
import type { ProposalTarget } from "@/lib/chat/sources"
import type { NewChatMessage } from "@/lib/chat/store"
import type {
  ChatChart,
  ChatChartSource,
  ChatCitation,
  ChatProposal,
  ChatStep,
} from "@/lib/chat/views"

/**
 * Turn a chat turn's terminal outcome into the assistant message that is stored
 * (ask-chat Req 3.5, 6.1, 9).
 *
 * The runtime's `done` is data from a process this app does not control, so nothing in it
 * is trusted by shape: citations keep only string fields on well-formed fact ids, a proposal
 * survives only when its target id is one this turn offered — at which point the opaque id
 * is replaced by the customer and connector it stood for — and a chart survives only with a
 * known kind, bounded sizes and decimal values.
 */

const FACT_ID = /^f\d{1,4}$/
const CHART_ID = /^c\d{1,2}$/
const DECIMAL = /^-?\d+(?:\.\d+)?$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_FIELD = 400
const MAX_CHARTS = 3
const SOURCES: readonly ChatChartSource[] = ["verified", "live", "mixed"]

export function citationsFrom(value: unknown): Record<string, ChatCitation> {
  if (value === null || typeof value !== "object") return {}
  const citations: Record<string, ChatCitation> = {}
  for (const [factId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!FACT_ID.test(factId) || entry === null || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    if (typeof record.formatted !== "string" || typeof record.label !== "string") continue
    const clean: Record<string, string> = {}
    for (const [key, field] of Object.entries(record)) {
      if (typeof field === "string") clean[key] = field.slice(0, MAX_FIELD)
    }
    citations[factId] = clean as unknown as ChatCitation
  }
  return citations
}

export function proposalFrom(
  value: unknown,
  targets: ReadonlyMap<string, ProposalTarget>
): ChatProposal | undefined {
  if (value === null || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const target = typeof record.target_id === "string" ? targets.get(record.target_id) : undefined
  const period = typeof record.period === "string" ? record.period : undefined
  if (target === undefined || period === undefined || !/^\d{4}-\d{2}$/.test(period)) {
    return undefined
  }
  return { ...target, period, state: "open" }
}

function text(value: unknown, limit = 120): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined
}

/** The charts an outcome carries, keeping only well-formed ones. */
export function chartsFrom(value: unknown): ChatChart[] {
  if (!Array.isArray(value)) return []
  const charts: ChatChart[] = []
  for (const entry of value.slice(0, MAX_CHARTS)) {
    if (entry === null || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const id = text(record.id, 8)
    const title = text(record.title)
    const unit = text(record.unit, 60)
    const source = SOURCES.find((candidate) => candidate === record.source)
    if (id === undefined || !CHART_ID.test(id) || title === undefined || unit === undefined || source === undefined) {
      continue
    }

    if (record.kind === "compare" && Array.isArray(record.bars)) {
      const bars = record.bars.flatMap((bar) => {
        if (bar === null || typeof bar !== "object") return []
        const item = bar as Record<string, unknown>
        const factId = text(item.fact_id, 8)
        const label = text(item.label)
        const barValue = text(item.value, 40)
        const formatted = text(item.formatted)
        if (factId === undefined || !FACT_ID.test(factId) || label === undefined || formatted === undefined) return []
        if (barValue === undefined || !DECIMAL.test(barValue)) return []
        return [{ fact_id: factId, label, value: barValue, formatted }]
      })
      if (bars.length >= 2 && bars.length <= 12 && bars.length === record.bars.length) {
        charts.push({ id, kind: "compare", title, unit, source, bars })
      }
      continue
    }

    if (record.kind === "daily" && Array.isArray(record.points)) {
      const points = record.points.flatMap((point) => {
        if (point === null || typeof point !== "object") return []
        const item = point as Record<string, unknown>
        const day = text(item.day, 10)
        const pointValue = text(item.value, 40)
        const formatted = text(item.formatted)
        if (day === undefined || !DAY.test(day) || formatted === undefined) return []
        if (pointValue === undefined || !DECIMAL.test(pointValue)) return []
        return [{ day, value: pointValue, formatted }]
      })
      const seriesLabel = text(record.series_label) ?? title
      if (points.length >= 2 && points.length <= 93 && points.length === record.points.length) {
        charts.push({ id, kind: "daily", title, unit, source, series_label: seriesLabel, points })
      }
    }
  }
  return charts
}

export function assistantMessageFrom(a: {
  readonly authorId: string
  readonly text: string
  readonly steps: readonly ChatStep[]
  /** The sentence shown while the answer was worked out; kept only on an answer that stands. */
  readonly intent?: string
  readonly outcome: Record<string, unknown> | undefined
  readonly failure: string | undefined
  readonly targets: ReadonlyMap<string, ProposalTarget>
}): NewChatMessage {
  const outcome = a.outcome
  if (outcome === undefined) {
    return {
      role: "assistant",
      text: a.text.trim().length > 0 ? a.text : (a.failure ?? "The assistant could not answer."),
      authorId: a.authorId,
      citations: {},
      steps: a.steps,
      failed: true,
    }
  }

  const unavailable = outcome.unavailable_runs
  const unavailableLive = outcome.unavailable_live
  const charts = chartsFrom(outcome.charts)
  const unavailableCount =
    (Array.isArray(unavailable) ? unavailable.length : 0) +
    (Array.isArray(unavailableLive) ? unavailableLive.length : 0)
  const refused = outcome.refused === true
  const thought = outcome.thought_seconds
  return {
    role: "assistant",
    text: a.text,
    authorId: a.authorId,
    citations: citationsFrom(outcome.citations),
    steps: a.steps,
    charts: charts.length > 0 ? charts : undefined,
    proposal: proposalFrom(outcome.proposal, a.targets),
    refused: refused ? true : undefined,
    unavailableRuns: unavailableCount > 0 ? unavailableCount : undefined,
    pricesUnavailable: Array.isArray(outcome.prices_unavailable) ? true : undefined,
    intent: !refused && a.intent ? a.intent : undefined,
    model: isChatModelId(outcome.model) ? outcome.model : undefined,
    thoughtSeconds:
      !refused && typeof thought === "number" && Number.isFinite(thought) && thought >= 0
        ? Math.round(thought)
        : undefined,
  }
}
