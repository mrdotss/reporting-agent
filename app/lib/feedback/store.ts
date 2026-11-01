import "server-only"

import { randomUUID } from "node:crypto"

import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm"

import { isPlatformAdmin } from "@/lib/admin/platform"
import { getDb } from "@/lib/db"
import { feedback, type Feedback } from "@/lib/db/schema"
import { feedbackEmail } from "@/lib/feedback/email"
import type { FeedbackInput, FeedbackKind } from "@/lib/feedback/input"
import type { FeedbackView } from "@/lib/feedback/views"
import { MailNotConfiguredError, sendMail, type MailResult } from "@/lib/mail/mailtrap"
import { publicBaseUrl } from "@/lib/public-url"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

/**
 * Send feedback: what a member writes in the dialog, saved and then emailed to the team.
 *
 * The row is written **before** the email goes out, so a refusal from Mailtrap, or email
 * not being set up on this server, loses nothing — the row says why, and the Admin page
 * can send it again. The email goes through the same Mailtrap sender as the report emails
 * (`RPT_MAIL_FROM`), to `RPT_FEEDBACK_TO`.
 */

export const DEFAULT_FEEDBACK_TO = "mayer@fatechid.com"

/** How many messages one account may send in an hour; enough to never meet in honest use. */
export const FEEDBACK_HOURLY_LIMIT = 10

export class FeedbackLimitError extends Error {
  constructor() {
    super("You have sent a lot of feedback in the last hour. Try again a little later.")
    this.name = "FeedbackLimitError"
  }
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export function feedbackRecipient(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RPT_FEEDBACK_TO?.trim()
  return configured && EMAIL.test(configured) ? configured : DEFAULT_FEEDBACK_TO
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" }

function toView(row: Feedback): FeedbackView {
  return {
    id: row.id,
    kind: row.kind as FeedbackKind,
    message: row.message,
    userEmail: row.userEmail,
    workspaceName: row.workspaceName,
    role: row.role,
    pagePath: row.pagePath,
    canReply: row.canReply,
    emailStatus: row.emailStatus as FeedbackView["emailStatus"],
    emailError: row.emailError,
    emailedAt: row.emailedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

type Send = (message: Parameters<typeof sendMail>[0]) => Promise<MailResult>
type MailOptions = { send?: Send; baseUrl?: string; env?: NodeJS.ProcessEnv; now?: Date }

/** Email one saved row and record how it went. Never throws for a refusal. */
async function deliver(row: Feedback, { send = sendMail, baseUrl, env = process.env, now = new Date() }: MailOptions): Promise<Feedback> {
  const email = feedbackEmail({
    id: row.id,
    kind: row.kind as FeedbackKind,
    message: row.message,
    userEmail: row.userEmail,
    canReply: row.canReply,
    workspaceName: row.workspaceName,
    role: row.role,
    pagePath: row.pagePath,
    createdAt: row.createdAt,
    baseUrl: (baseUrl ?? publicBaseUrl()).replace(/\/+$/, ""),
  })
  let result: MailResult
  try {
    result = await send({ to: { email: feedbackRecipient(env) }, category: "feedback", ...email })
  } catch (thrown) {
    if (!(thrown instanceof MailNotConfiguredError)) throw thrown
    result = { ok: false, error: thrown.message }
  }
  const [saved] = await getDb()
    .update(feedback)
    .set(
      result.ok
        ? { emailStatus: "sent", emailError: null, emailedAt: now }
        : { emailStatus: "failed", emailError: result.error.slice(0, 500) }
    )
    .where(eq(feedback.id, row.id))
    .returning()
  return saved ?? row
}

/**
 * Save one message from the signed-in member and email it. The workspace is the one the
 * member had open, resolved by the route from their session, never from the request body.
 */
export async function submitFeedback(
  user: Readonly<{ id: string; email: string }>,
  workspace: Readonly<{ id: string; name: string; role: string }> | null,
  input: FeedbackInput,
  options: MailOptions = {}
): Promise<FeedbackView> {
  const now = options.now ?? new Date()
  const db = getDb()
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(feedback)
    .where(and(eq(feedback.userId, user.id), gte(feedback.createdAt, new Date(now.getTime() - 60 * 60 * 1000))))
  if (count >= FEEDBACK_HOURLY_LIMIT) throw new FeedbackLimitError()

  const [row] = await db
    .insert(feedback)
    .values({
      id: `fb_${randomUUID()}`,
      userId: user.id,
      userEmail: user.email,
      workspaceId: workspace?.id ?? null,
      workspaceName: workspace?.name ?? null,
      role: workspace ? (ROLE_LABEL[workspace.role] ?? workspace.role) : null,
      kind: input.kind,
      message: input.message,
      pagePath: input.pagePath ?? null,
      canReply: input.canReply,
      createdAt: now,
    })
    .returning()
  if (row === undefined) throw new Error("[feedback] the message was not saved")
  return toView(await deliver(row, { ...options, now }))
}

// --- the Admin page -------------------------------------------------------------------

function requireAdmin(admin: Readonly<{ email: string }>): void {
  if (!isPlatformAdmin(admin.email)) throw new WorkspaceAccessError()
}

export const FEEDBACK_LIST_LIMIT = 500
export type FeedbackFilter = "open" | "done" | "all"

export async function listFeedback(
  admin: Readonly<{ email: string }>,
  filter: FeedbackFilter = "open"
): Promise<FeedbackView[]> {
  requireAdmin(admin)
  const rows = await getDb()
    .select()
    .from(feedback)
    .where(filter === "open" ? isNull(feedback.resolvedAt) : filter === "done" ? isNotNull(feedback.resolvedAt) : undefined)
    .orderBy(desc(feedback.createdAt))
    .limit(FEEDBACK_LIST_LIMIT)
  return rows.map(toView)
}

/** How many messages nobody has marked done: the count beside the Admin tab. */
export async function openFeedbackCount(admin: Readonly<{ email: string }>): Promise<number> {
  requireAdmin(admin)
  const [{ count } = { count: 0 }] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(feedback)
    .where(isNull(feedback.resolvedAt))
  return count
}

async function findRow(id: string): Promise<Feedback> {
  const [row] = await getDb().select().from(feedback).where(eq(feedback.id, id)).limit(1)
  if (row === undefined) throw new WorkspaceAccessError()
  return row
}

export async function setFeedbackDone(
  admin: Readonly<{ email: string }>,
  id: string,
  done: boolean,
  { now = new Date() } = {}
): Promise<FeedbackView> {
  requireAdmin(admin)
  const row = await findRow(id)
  const [saved] = await getDb()
    .update(feedback)
    .set({ resolvedAt: done ? (row.resolvedAt ?? now) : null })
    .where(eq(feedback.id, id))
    .returning()
  return toView(saved ?? row)
}

/** Email a message again, for a row whose first send failed. */
export async function resendFeedback(
  admin: Readonly<{ email: string }>,
  id: string,
  options: MailOptions = {}
): Promise<FeedbackView> {
  requireAdmin(admin)
  return toView(await deliver(await findRow(id), options))
}
