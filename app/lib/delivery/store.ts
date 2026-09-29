import "server-only"

import { createHash, randomBytes, randomUUID } from "node:crypto"

import { and, desc, eq, sql } from "drizzle-orm"

import { getDb } from "@/lib/db"
import {
  customerContacts,
  projects,
  reportDeliveries,
  reportRuns,
  reportVerifications,
  type ReportDelivery,
} from "@/lib/db/schema"
import { reportArtifactKey } from "@/lib/db/views"
import { sendMail } from "@/lib/mail/mailtrap"
import { deliveryEmail } from "@/lib/delivery/email"
import { WorkspaceAccessError, accessWhere, requireProject } from "@/lib/workspaces/access"

/**
 * Review and send: a customer's contacts, the approved send of a verified report, and the
 * link the email carries.
 *
 * Only a **completed** run with a **passing** verification can be sent, and only by an
 * Owner or Admin — approving and sending are one act, recorded with who did it and when.
 * The link is a random token; the table keeps its SHA-256 only.
 */

export const MAX_CONTACTS = 20
export const DEFAULT_LINK_DAYS = 30

export class DeliveryInputError extends Error {}

export type ContactView = { readonly id: string; readonly name: string; readonly email: string }

export type DeliveryView = {
  readonly id: string
  readonly status: "sent" | "partial" | "failed"
  readonly approvedAt: string
  readonly recipients: readonly { name: string; email: string; ok: boolean; error?: string }[]
  readonly linkExpiresAt: string
  readonly firstOpenedAt: string | null
  readonly openCount: number
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function linkDays(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.RPT_REPORT_LINK_DAYS)
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_LINK_DAYS
}

function toDeliveryView(row: ReportDelivery): DeliveryView {
  return {
    id: row.id,
    status: row.status as DeliveryView["status"],
    approvedAt: row.approvedAt.toISOString(),
    recipients: row.recipients.map((r) => ({ name: r.name, email: r.email, ok: r.error === undefined, ...(r.error ? { error: r.error } : {}) })),
    linkExpiresAt: row.linkExpiresAt.toISOString(),
    firstOpenedAt: row.firstOpenedAt?.toISOString() ?? null,
    openCount: row.openCount,
  }
}

// --- contacts -----------------------------------------------------------------------

type Scope = { workspaceId: string; projectId: string }

export async function listContacts(userId: string, scope: Scope): Promise<ContactView[]> {
  await requireProject(userId, scope, "read")
  const rows = await getDb()
    .select()
    .from(customerContacts)
    .where(and(eq(customerContacts.workspaceId, scope.workspaceId), eq(customerContacts.projectId, scope.projectId)))
    .orderBy(customerContacts.name)
  return rows.map((row) => ({ id: row.id, name: row.name, email: row.email }))
}

export async function addContact(userId: string, scope: Scope, input: { name: string; email: string }): Promise<ContactView> {
  await requireProject(userId, scope, "edit")
  const name = input.name.trim().slice(0, 120)
  const email = input.email.trim().toLowerCase()
  if (!name || !EMAIL.test(email) || email.length > 254) {
    throw new DeliveryInputError("Enter a name and a valid email address.")
  }
  const db = getDb()
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customerContacts)
    .where(eq(customerContacts.projectId, scope.projectId))
  if (count >= MAX_CONTACTS) throw new DeliveryInputError(`A customer has at most ${MAX_CONTACTS} contacts.`)
  const [row] = await db
    .insert(customerContacts)
    .values({ id: randomUUID(), ...scope, name, email })
    .onConflictDoNothing()
    .returning()
  if (row === undefined) throw new DeliveryInputError("That address is already a contact for this customer.")
  return { id: row.id, name: row.name, email: row.email }
}

export async function removeContact(userId: string, id: string): Promise<void> {
  const db = getDb()
  const [row] = await db.select().from(customerContacts).where(eq(customerContacts.id, id)).limit(1)
  if (row === undefined) throw new WorkspaceAccessError()
  await requireProject(userId, { workspaceId: row.workspaceId, projectId: row.projectId }, "edit")
  await db.delete(customerContacts).where(eq(customerContacts.id, id))
}

// --- approve and send -----------------------------------------------------------------

type SendableRun = {
  run: typeof reportRuns.$inferSelect
  customer: string
  figureCount: number
}

async function sendableRun(userId: string, runId: string): Promise<SendableRun> {
  const db = getDb()
  const [row] = await db
    .select({ run: reportRuns, customer: projects.name })
    .from(reportRuns)
    .innerJoin(projects, eq(projects.id, reportRuns.projectId))
    .where(and(eq(reportRuns.id, runId), accessWhere(reportRuns, userId)))
    .limit(1)
  if (row === undefined || row.run.workspaceId === null || row.run.projectId === null) throw new WorkspaceAccessError()
  const [verification] = await db
    .select({ status: reportVerifications.status, figureCount: reportVerifications.figureCount })
    .from(reportVerifications)
    .where(eq(reportVerifications.runId, runId))
    .orderBy(desc(reportVerifications.createdAt))
    .limit(1)
  if (row.run.status !== "completed" || verification?.status !== "pass") {
    throw new DeliveryInputError("Only a completed report that passed verification can be sent.")
  }
  return { run: row.run, customer: row.customer, figureCount: verification.figureCount }
}

/** The latest send of this run, for the report page. */
export async function latestDelivery(userId: string, runId: string): Promise<DeliveryView | null> {
  const db = getDb()
  const [run] = await db.select({ id: reportRuns.id }).from(reportRuns).where(and(eq(reportRuns.id, runId), accessWhere(reportRuns, userId))).limit(1)
  if (run === undefined) return null
  const [row] = await db.select().from(reportDeliveries).where(eq(reportDeliveries.runId, runId)).orderBy(desc(reportDeliveries.createdAt)).limit(1)
  return row === undefined ? null : toDeliveryView(row)
}

/**
 * Approve this verified report and email it to every contact of its customer. One message
 * per contact, so recipients do not see one another and one refusal does not stop the rest.
 * Needs Owner or Admin on the customer.
 */
export async function approveAndSend(
  userId: string,
  runId: string,
  { now = new Date(), baseUrl = process.env.RPT_APP_BASE_URL ?? "", send = sendMail } = {}
): Promise<DeliveryView> {
  const { run, customer, figureCount } = await sendableRun(userId, runId)
  const scope = { workspaceId: run.workspaceId!, projectId: run.projectId! }
  await requireProject(userId, scope, "manage")
  const contacts = await listContacts(userId, scope)
  if (contacts.length === 0) throw new DeliveryInputError("Add at least one contact for this customer before sending.")

  const token = randomBytes(32).toString("base64url")
  const expires = new Date(now.getTime() + linkDays() * 24 * 60 * 60 * 1000)
  const base = baseUrl.replace(/\/+$/, "")

  const recipients: ReportDelivery["recipients"] = []
  for (const contact of contacts) {
    const email = deliveryEmail({
      contactName: contact.name,
      customer,
      periodStart: run.periodStart,
      figureCount,
      reportUrl: `${base}/r/${token}`,
      proofUrl: `${base}/v/${run.id}`,
      expiresAt: expires,
    })
    const result = await send({ to: { email: contact.email, name: contact.name }, ...email })
    recipients.push(
      result.ok
        ? { name: contact.name, email: contact.email, messageId: result.messageId }
        : { name: contact.name, email: contact.email, error: result.error }
    )
  }
  const delivered = recipients.filter((r) => r.error === undefined).length
  const status = delivered === recipients.length ? "sent" : delivered === 0 ? "failed" : "partial"

  const [row] = await getDb()
    .insert(reportDeliveries)
    .values({
      id: randomUUID(),
      runId: run.id,
      ...scope,
      approvedBy: userId,
      approvedAt: now,
      status,
      recipients,
      linkTokenHash: hashToken(token),
      linkExpiresAt: expires,
      createdAt: now,
    })
    .returning()
  return toDeliveryView(row as ReportDelivery)
}

// --- the customer's link --------------------------------------------------------------

export type OpenedReport = {
  readonly runId: string
  readonly customer: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly timezone: string
  readonly figureCount: number
  readonly verifiedAt: string
  readonly linkExpiresAt: string
}

async function deliveryByToken(token: string, now: Date) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null
  const [row] = await getDb()
    .select({ delivery: reportDeliveries, run: reportRuns, customer: projects.name })
    .from(reportDeliveries)
    .innerJoin(reportRuns, eq(reportRuns.id, reportDeliveries.runId))
    .innerJoin(projects, eq(projects.id, reportDeliveries.projectId))
    .where(eq(reportDeliveries.linkTokenHash, hashToken(token)))
    .limit(1)
  if (row === undefined || row.delivery.linkExpiresAt.getTime() <= now.getTime() || row.run.status !== "completed") return null
  return row
}

/** The report behind a customer's link, counting the visit. `null` for an unknown or expired link. */
export async function openDelivery(token: string, now: Date = new Date()): Promise<OpenedReport | null> {
  const row = await deliveryByToken(token, now)
  if (row === null) return null
  const db = getDb()
  await db
    .update(reportDeliveries)
    .set({ openCount: sql`${reportDeliveries.openCount} + 1`, firstOpenedAt: row.delivery.firstOpenedAt ?? now })
    .where(eq(reportDeliveries.id, row.delivery.id))
  const [verification] = await db
    .select({ figureCount: reportVerifications.figureCount, createdAt: reportVerifications.createdAt })
    .from(reportVerifications)
    .where(and(eq(reportVerifications.runId, row.run.id), eq(reportVerifications.status, "pass")))
    .orderBy(desc(reportVerifications.createdAt))
    .limit(1)
  return {
    runId: row.run.id,
    customer: row.customer,
    periodStart: row.run.periodStart,
    periodEnd: row.run.periodEnd,
    timezone: row.run.timezone,
    figureCount: verification?.figureCount ?? 0,
    verifiedAt: verification?.createdAt.toISOString() ?? "",
    linkExpiresAt: row.delivery.linkExpiresAt.toISOString(),
  }
}

/** The artifact key a customer's link may download, or `null`. */
export async function deliveryArtifact(
  token: string,
  kind: "pdf" | "docx",
  now: Date = new Date()
): Promise<{ runId: string; actorId: string; key: string } | null> {
  const row = await deliveryByToken(token, now)
  if (row === null) return null
  return {
    runId: row.run.id,
    actorId: row.run.userId,
    key: reportArtifactKey(row.run.userId, row.run.id, kind === "pdf" ? "report.pdf" : "report.docx"),
  }
}
