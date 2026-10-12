import "server-only"

import { and, asc, eq, isNull } from "drizzle-orm"

import { getDb } from "@/lib/db"
import { actionItems, connectedSubscriptions, projects, type ActionItem } from "@/lib/db/schema"
import { WorkspaceAccessError, requireProject, requireWorkspace } from "@/lib/workspaces/access"

/**
 * The Action register for people: list one customer's items, or every customer's in a
 * workspace, and set an item's owner, status and note. `resolved` is never set here — only a sync resolves, on evidence.
 */

export const EDITABLE_STATUSES = ["open", "accepted", "wont_do"] as const
export type EditableStatus = (typeof EDITABLE_STATUSES)[number]
export const OWNERS = ["customer", "msp"] as const
export const MAX_NOTE = 1000

export type ActionItemView = {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly owner: "customer" | "msp" | null
  readonly status: "open" | "accepted" | "wont_do" | "resolved"
  readonly note: string | null
  readonly connector: string
  /** The customer (project) the item belongs to. */
  readonly customer: string
  readonly firstSeenPeriod: string
  readonly lastSeenRunId: string
  readonly resolvedRunId: string | null
  readonly resolvedSnapshotId: string | null
}

export class ActionItemInputError extends Error {}

function toView(row: ActionItem, connector: string, customer: string): ActionItemView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    owner: row.owner === "customer" || row.owner === "msp" ? row.owner : null,
    status: row.status as ActionItemView["status"],
    note: row.note,
    connector,
    customer,
    firstSeenPeriod: row.firstSeenPeriod,
    lastSeenRunId: row.lastSeenRunId,
    resolvedRunId: row.resolvedRunId,
    resolvedSnapshotId: row.resolvedSnapshotId,
  }
}

/**
 * One customer's items, or — with no `projectId` ("All customers") — every active customer's
 * in the workspace, ordered by customer and then title.
 */
export async function listActionItems(
  userId: string,
  scope: { workspaceId: string; projectId?: string }
): Promise<ActionItemView[]> {
  const { workspaceId, projectId } = scope
  if (projectId === undefined) await requireWorkspace(userId, workspaceId, "read")
  else await requireProject(userId, { workspaceId, projectId }, "read")
  const rows = await getDb()
    .select({ item: actionItems, connector: connectedSubscriptions.displayName, customer: projects.name })
    .from(actionItems)
    .innerJoin(connectedSubscriptions, eq(connectedSubscriptions.id, actionItems.connectedSubscriptionId))
    .innerJoin(projects, eq(projects.id, actionItems.projectId))
    .where(
      and(
        eq(actionItems.workspaceId, workspaceId),
        projectId === undefined ? isNull(projects.archivedAt) : eq(actionItems.projectId, projectId)
      )
    )
    .orderBy(asc(projects.name), asc(actionItems.title))
  return rows.map(({ item, connector, customer }) => toView(item, connector, customer))
}

/** Set owner, status and note. Needs edit on the item's customer; Won't do needs a note. */
export async function updateActionItem(
  userId: string,
  id: string,
  input: { owner: "customer" | "msp" | null; status: EditableStatus; note: string | null },
  now: Date = new Date()
): Promise<ActionItemView> {
  const db = getDb()
  const [row] = await db.select().from(actionItems).where(eq(actionItems.id, id)).limit(1)
  if (row === undefined) throw new WorkspaceAccessError()
  await requireProject(userId, { workspaceId: row.workspaceId, projectId: row.projectId }, "edit")
  if (row.status === "resolved") {
    throw new ActionItemInputError("A resolved item reopens by itself if the next report finds it again.")
  }
  const note = input.note?.trim() ? input.note.trim().slice(0, MAX_NOTE) : null
  if (input.status === "wont_do" && note === null) {
    throw new ActionItemInputError("Say why it won't be done. The note is kept with the item.")
  }
  const [updated] = await db
    .update(actionItems)
    .set({ owner: input.owner, status: input.status, note, updatedAt: now })
    .where(eq(actionItems.id, id))
    .returning()
  const [connector] = await db
    .select({ name: connectedSubscriptions.displayName })
    .from(connectedSubscriptions)
    .where(eq(connectedSubscriptions.id, row.connectedSubscriptionId))
  const [customer] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId))
  return toView(updated as ActionItem, connector?.name ?? "", customer?.name ?? "")
}
