import "server-only"

import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { getPool } from "@/lib/db"
import { PERMISSION_ROLES, type Permission, type WorkspaceRole } from "./policy"

export type ProjectScope = { workspaceId: string; projectId: string }
export class WorkspaceAccessError extends Error {
  constructor() {
    super(
      "This resource is unavailable or you do not have permission to change it."
    )
    this.name = "WorkspaceAccessError"
  }
}
export class DraftConflictError extends Error {
  constructor() {
    super(
      "Another teammate updated this profile. Reload before saving your changes."
    )
    this.name = "DraftConflictError"
  }
}
type ScopedTable = {
  userId: AnyPgColumn
  workspaceId: AnyPgColumn
  projectId: AnyPgColumn
}
/** Membership is checked inside the statement. Unmigrated rows retain legacy ownership. */
export function accessWhere(
  table: ScopedTable,
  userId: string,
  permission: Permission = "read",
  scope?: Partial<ProjectScope>
): SQL {
  const roles = PERMISSION_ROLES[permission]
  const membership = sql`exists (select 1 from workspace_members wm where wm.workspace_id = ${table.workspaceId} and wm.user_id = ${userId} and wm.role::text in (${sql.join(
    roles.map((role) => sql`${role}`),
    sql`, `
  )}))`
  const active =
    permission === "read"
      ? sql`true`
      : sql`exists (select 1 from projects wp where wp.id = ${table.projectId} and wp.workspace_id = ${table.workspaceId} and wp.archived_at is null)`
  return and(
    or(
      and(isNull(table.workspaceId), eq(table.userId, userId)),
      and(membership, active)
    ),
    scope?.workspaceId ? eq(table.workspaceId, scope.workspaceId) : undefined,
    scope?.projectId ? eq(table.projectId, scope.projectId) : undefined
  )!
}
export async function requireProject(
  userId: string,
  scope: ProjectScope,
  permission: Permission = "read"
) {
  const { rows } = await getPool().query<{
    role: WorkspaceRole
    name: string
    archived_at: Date | null
  }>(
    `select m.role,p.name,p.archived_at from projects p join workspace_members m on m.workspace_id=p.workspace_id
     where p.id=$1 and p.workspace_id=$2 and m.user_id=$3 and m.role::text=any($4::text[])
       and ($5::boolean or p.archived_at is null)`,
    [
      scope.projectId,
      scope.workspaceId,
      userId,
      PERMISSION_ROLES[permission],
      permission === "read",
    ]
  )
  if (!rows[0]) throw new WorkspaceAccessError()
  return rows[0]
}
export async function requireWorkspace(
  userId: string,
  workspaceId: string,
  permission: Permission = "read"
) {
  const { rows } = await getPool().query<{ role: WorkspaceRole }>(
    "select role from workspace_members where workspace_id=$1 and user_id=$2 and role::text=any($3::text[])",
    [workspaceId, userId, PERMISSION_ROLES[permission]]
  )
  if (!rows[0]) throw new WorkspaceAccessError()
  return rows[0].role
}
