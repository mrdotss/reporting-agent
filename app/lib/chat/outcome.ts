import { isChatModelId } from "@/lib/chat/models"
import type { ProposalTarget } from "@/lib/chat/sources"
import type { NewChatMessage } from "@/lib/chat/store"
import type {
  ChatChart,
  ChatChartPoint,
  ChatChartSource,
  ChatCompareChart,
  ChatCitation,
  ChatKnowledgeSource,
  ChatProposal,
  ChatSpreadChart,
  ChatStatsChart,
  ChatStep,
  ChatTrendChart,
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
// The runtime's own bounds (chat/charts.py), so nothing larger is ever stored.
const MAX_BARS = 12
const MAX_POINTS = 93
const MAX_TREND_SERIES = 4
const MAX_SPREAD_ROWS = 12
const MAX_SPREAD_STATS = 8
const MAX_STAT_TILES = 4
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

type Field = Record<string, unknown>

function records(value: unknown): Field[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is Field => item !== null && typeof item === "object")
  return items.length === value.length ? items : undefined
}

function factId(value: unknown): string | undefined {
  const id = text(value, 8)
  return id !== undefined && FACT_ID.test(id) ? id : undefined
}

function decimal(value: unknown): string | undefined {
  const number = text(value, 40)
  return number !== undefined && DECIMAL.test(number) ? number : undefined
}

function seriesSource(value: unknown): "verified" | "live" | undefined {
  return value === "verified" || value === "live" ? value : undefined
}

/** Daily points, all well-formed, or `undefined`. `min` is the fewest a drawing needs. */
function pointsFrom(value: unknown, min: number): ChatChartPoint[] | undefined {
  const items = records(value)
  if (items === undefined || items.length < min || items.length > MAX_POINTS) return undefined
  const points: ChatChartPoint[] = []
  for (const item of items) {
    const day = text(item.day, 10)
    const pointValue = decimal(item.value)
    const formatted = text(item.formatted)
    if (day === undefined || !DAY.test(day) || pointValue === undefined || formatted === undefined) return undefined
    points.push({ day, value: pointValue, formatted })
  }
  return points
}

/** The chart one outcome entry describes, or `undefined` when any part of it is malformed. */
function chartFrom(record: Field): ChatChart | undefined {
  const id = text(record.id, 8)
  const title = text(record.title)
  const unit = text(record.unit, 60)
  const source = SOURCES.find((candidate) => candidate === record.source)
  if (id === undefined || !CHART_ID.test(id) || title === undefined || source === undefined) return undefined

  if (record.kind === "stats") {
    const items = records(record.tiles)
    if (items === undefined || items.length < 2 || items.length > MAX_STAT_TILES) return undefined
    const tiles: ChatStatsChart["tiles"][number][] = []
    for (const item of items) {
      const tileFact = factId(item.fact_id)
      const label = text(item.label)
      const formatted = text(item.formatted)
      const tileSource = seriesSource(item.source)
      // A tile without a daily series carries none; one with a series needs two points.
      const points = Array.isArray(item.points) && item.points.length === 0 ? [] : pointsFrom(item.points, 2)
      if (tileFact === undefined || label === undefined || formatted === undefined) return undefined
      if (tileSource === undefined || points === undefined) return undefined
      tiles.push({ fact_id: tileFact, label, formatted, source: tileSource, points })
    }
    return { id, kind: "stats", title, source, tiles }
  }

  if (unit === undefined) return undefined

  if (record.kind === "compare") {
    const items = records(record.bars)
    if (items === undefined || items.length < 2 || items.length > MAX_BARS) return undefined
    const bars: ChatCompareChart["bars"][number][] = []
    for (const item of items) {
      const barFact = factId(item.fact_id)
      const label = text(item.label)
      const barValue = decimal(item.value)
      const formatted = text(item.formatted)
      if (barFact === undefined || label === undefined || barValue === undefined || formatted === undefined) {
        return undefined
      }
      const barSource = seriesSource(item.source)
      bars.push({ fact_id: barFact, label, value: barValue, formatted, ...(barSource ? { source: barSource } : {}) })
    }
    return { id, kind: "compare", title, unit, source, bars }
  }

  if (record.kind === "daily") {
    const points = pointsFrom(record.points, 2)
    if (points === undefined) return undefined
    return { id, kind: "daily", title, unit, source, series_label: text(record.series_label) ?? title, points }
  }

  if (record.kind === "trend") {
    const items = records(record.series)
    if (items === undefined || items.length < 1 || items.length > MAX_TREND_SERIES) return undefined
    const series: ChatTrendChart["series"][number][] = []
    for (const item of items) {
      const seriesFact = factId(item.fact_id)
      const label = text(item.label)
      const lineSource = seriesSource(item.source)
      const points = pointsFrom(item.points, 2)
      if (seriesFact === undefined || label === undefined || lineSource === undefined || points === undefined) {
        return undefined
      }
      series.push({ fact_id: seriesFact, label, source: lineSource, points })
    }
    return { id, kind: "trend", title, unit, source, series }
  }

  if (record.kind === "spread") {
    const items = records(record.rows)
    if (items === undefined || items.length < 1 || items.length > MAX_SPREAD_ROWS) return undefined
    const rows: ChatSpreadChart["rows"][number][] = []
    for (const item of items) {
      const label = text(item.label)
      const rowSource = seriesSource(item.source)
      const statItems = records(item.stats)
      if (label === undefined || rowSource === undefined || statItems === undefined) return undefined
      if (statItems.length < 2 || statItems.length > MAX_SPREAD_STATS) return undefined
      const stats: ChatSpreadChart["rows"][number]["stats"][number][] = []
      for (const stat of statItems) {
        const statFact = factId(stat.fact_id)
        const statistic = text(stat.statistic, 60)
        const statValue = decimal(stat.value)
        const formatted = text(stat.formatted)
        if (statFact === undefined || statistic === undefined || statValue === undefined || formatted === undefined) {
          return undefined
        }
        stats.push({ fact_id: statFact, statistic, value: statValue, formatted })
      }
      rows.push({ label, source: rowSource, stats })
    }
    return { id, kind: "spread", title, unit, source, rows }
  }

  return undefined
}

/** The charts an outcome carries, keeping only well-formed ones. */
export function chartsFrom(value: unknown): ChatChart[] {
  if (!Array.isArray(value)) return []
  const charts: ChatChart[] = []
  for (const entry of value.slice(0, MAX_CHARTS)) {
    if (entry === null || typeof entry !== "object") continue
    const chart = chartFrom(entry as Field)
    if (chart !== undefined) charts.push(chart)
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
    knowledge: knowledgeFrom(outcome.knowledge),
    thoughtSeconds:
      !refused && typeof thought === "number" && Number.isFinite(thought) && thought >= 0
        ? Math.round(thought)
        : undefined,
  }
}

/** The hosts a knowledge link may point at — the runtime fetches from these alone. */
const KNOWLEDGE_HOSTS = new Set(["learn.microsoft.com", "docs.aws.amazon.com"])

/**
 * The runtime's knowledge sources, trusted by shape only.
 *
 * A link is kept only when it is https on one of the two documentation hosts: it is
 * rendered as a clickable link, and the runtime's own allowlist is not a reason for this
 * side to render whatever arrives.
 */
export function knowledgeFrom(raw: unknown): ChatKnowledgeSource[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const sources: ChatKnowledgeSource[] = []
  for (const entry of raw.slice(0, 12)) {
    if (entry === null || typeof entry !== "object") continue
    const { skill, provider, title, url } = entry as Record<string, unknown>
    if (typeof skill !== "string" || typeof title !== "string") continue
    if (provider !== "azure" && provider !== "aws") continue
    let link: string | undefined
    if (typeof url === "string") {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === "https:" && KNOWLEDGE_HOSTS.has(parsed.hostname)) link = parsed.toString()
      } catch {
        link = undefined
      }
    }
    sources.push({ skill: skill.slice(0, 80), provider, title: title.slice(0, 200), ...(link ? { url: link } : {}) })
  }
  return sources.length > 0 ? sources : undefined
}
