/**
 * The shapes a conversation takes on its way to the browser (ask-chat Req 7), and the
 * parser for the two markers an answer's text carries.
 *
 * Pure and secret-free, so deliberately not `server-only`: the Ask page's client
 * components import these types and {@link parseAnswer}.
 *
 * ## The markers
 *
 * The runtime rewrites every answer before it leaves (`agent/…/chat/stream_filter.py`):
 *
 * - `⟦fig:f3⟧8.06%⟦/fig⟧` — a verified fact, its string exactly as the artifact holds it;
 * - `⟦est⟧…⟦/est⟧` — reasoning or arithmetic over facts, never a figure.
 *
 * The runtime strips `⟦` and `⟧` from model text before it adds its own, so these are the
 * only places the characters appear. {@link parseAnswer} turns the text into segments a
 * component renders as React nodes — **never** as HTML.
 */

export const CHAT_TITLE_MAX = 80
export const CHAT_PROMPT_MAX = 4000

export type ChatAttachments = {
  readonly runIds: readonly string[]
  readonly connectorIds: readonly string[]
}

export type ChatThreadView = {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly messageCount: number
  readonly attachments: ChatAttachments
}

export type ChatCitation = {
  readonly fact_id: string
  readonly source: "report" | "scan" | "price" | string
  readonly label: string
  readonly formatted: string
  readonly run_id?: string
  readonly customer_name?: string
  readonly period_display?: string
  readonly snapshot_path?: string
  readonly unit?: string
  readonly scan_id?: string
  readonly collected_at?: string
  readonly sku?: string
  readonly region?: string
  readonly operating_system?: string
  readonly currency?: string
  readonly unit_of_measure?: string
  readonly effective_start?: string
  readonly price_source?: string
}

export type ChatProposalState = "open" | "requested" | "dismissed"

/** A report the answer proposed, resolved server-side from the opaque target id. */
export type ChatProposal = {
  readonly projectId: string
  readonly workspaceId: string
  readonly connectedSubscriptionId: string
  readonly customerName: string
  readonly connectorLabel: string
  readonly provider: string
  /** `YYYY-MM` the model named. Informational: the preset's period rule decides the window. */
  readonly period: string
  readonly state: ChatProposalState
  readonly runId?: string
}

export type ChatStep = { readonly name: string; readonly label: string; readonly status: string }

export type ChatMessageView = {
  readonly id: string
  readonly threadId: string
  readonly role: "user" | "assistant"
  readonly text: string
  readonly authorId: string
  readonly createdAt: string
  readonly citations: Readonly<Record<string, ChatCitation>>
  readonly steps: readonly ChatStep[]
  readonly proposal?: ChatProposal
  readonly refused?: boolean
  readonly failed?: boolean
  readonly unavailableRuns?: number
  readonly pricesUnavailable?: boolean
}

// --- The stream the messages route writes to the browser ---------------------

export type ChatStreamEvent =
  | { readonly type: "user_message"; readonly message: ChatMessageView }
  | { readonly type: "step"; readonly step: ChatStep; readonly phase: "start" | "end" }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "message"; readonly message: ChatMessageView; readonly thread: ChatThreadView }
  | { readonly type: "error"; readonly message: string }

// --- Answer text ------------------------------------------------------------------

export type AnswerSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "figure"; readonly factId: string; readonly text: string }
  | { readonly kind: "estimate"; readonly children: readonly AnswerSegment[] }

const TOKEN = /⟦fig:(f\d{1,4})⟧([^⟦⟧]*)⟦\/fig⟧|⟦est⟧|⟦\/est⟧/g

/**
 * Segments of one answer. Total: any text parses, and a marker left unbalanced by a
 * stream still arriving is dropped rather than shown.
 */
export function parseAnswer(text: string): AnswerSegment[] {
  const root: AnswerSegment[] = []
  let current = root
  let estimate: AnswerSegment[] | null = null
  let position = 0

  const pushText = (value: string) => {
    const clean = value.replace(/[⟦⟧]/g, "")
    if (clean) current.push({ kind: "text", text: clean })
  }

  for (const match of text.matchAll(TOKEN)) {
    pushText(text.slice(position, match.index))
    position = match.index + match[0].length

    if (match[1] !== undefined) {
      current.push({ kind: "figure", factId: match[1], text: match[2] ?? "" })
    } else if (match[0] === "⟦est⟧") {
      if (estimate === null) {
        estimate = []
        current = estimate
      }
    } else if (estimate !== null) {
      root.push({ kind: "estimate", children: estimate })
      estimate = null
      current = root
    }
  }

  pushText(text.slice(position))
  if (estimate !== null && estimate.length > 0) {
    root.push({ kind: "estimate", children: estimate })
  }
  return root
}

/** The answer as plain text, for copying and for history sent back to the runtime. */
export function answerPlainText(text: string): string {
  return text
    .replace(/⟦fig:f\d{1,4}⟧([^⟦⟧]*)⟦\/fig⟧/g, "$1")
    .replace(/⟦\/?est⟧/g, "")
}
