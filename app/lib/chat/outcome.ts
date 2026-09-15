import type { ProposalTarget } from "@/lib/chat/sources"
import type { NewChatMessage } from "@/lib/chat/store"
import type { ChatCitation, ChatProposal, ChatStep } from "@/lib/chat/views"

/**
 * Turn a chat turn's terminal outcome into the assistant message that is stored
 * (ask-chat Req 3.5, 6.1).
 *
 * The runtime's `done` is data from a process this app does not control, so nothing in it
 * is trusted by shape: citations keep only string fields on well-formed fact ids, and a
 * proposal survives only when its target id is one this turn offered — at which point the
 * opaque id is replaced by the customer and connector it stood for.
 */

const FACT_ID = /^f\d{1,4}$/
const MAX_FIELD = 400

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

export function assistantMessageFrom(a: {
  readonly authorId: string
  readonly text: string
  readonly steps: readonly ChatStep[]
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
  return {
    role: "assistant",
    text: a.text,
    authorId: a.authorId,
    citations: citationsFrom(outcome.citations),
    steps: a.steps,
    proposal: proposalFrom(outcome.proposal, a.targets),
    refused: outcome.refused === true ? true : undefined,
    unavailableRuns: Array.isArray(unavailable) ? unavailable.length : undefined,
    pricesUnavailable: Array.isArray(outcome.prices_unavailable) ? true : undefined,
  }
}
