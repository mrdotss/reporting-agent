import type { FeedbackKind } from "@/lib/feedback/input"

/**
 * One Send feedback message as the Admin page lists it. Pure, so the client list can name
 * it: `lib/feedback/store.ts`, which builds it, is `server-only`.
 */
export type FeedbackView = Readonly<{
  id: string
  kind: FeedbackKind
  message: string
  userEmail: string
  workspaceName: string | null
  /** The sender's role in that workspace, as a label ("Owner"). */
  role: string | null
  pagePath: string | null
  canReply: boolean
  emailStatus: "pending" | "sent" | "failed"
  emailError: string | null
  /** ISO 8601 times, or null. */
  emailedAt: string | null
  resolvedAt: string | null
  createdAt: string
}>
