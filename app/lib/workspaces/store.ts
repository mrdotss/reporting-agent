import "server-only"

import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import { getPool } from "@/lib/db"
import { canManageMember, type WorkspaceRole } from "./policy"
import { requireWorkspace, WorkspaceAccessError } from "./access"

export type WorkspaceView = { id: string; name: string; role: WorkspaceRole }
export type ProjectView = {
  id: string
  workspaceId: string
  name: string
  description: string
  archivedAt: Date | null
}
async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect()
  try {
    await db.query("begin")
    const result = await fn(db)
    await db.query("commit")
    return result
  } catch (error) {
    await db.query("rollback")
    throw error
  } finally {
    db.release()
  }
}
async function audit(
  db: PoolClient,
  workspaceId: string,
  actorId: string,
  action: string,
  targetId: string
) {
  await db.query(
    "insert into workspace_audit(id,workspace_id,actor_id,action,target_id) values($1,$2,$3,$4,$5)",
    [randomUUID(), workspaceId, actorId, action, targetId]
  )
}
/** Lock the workspace first, serializing membership changes with invite acceptance. */
async function manager(db: PoolClient, userId: string, workspaceId: string) {
  await db.query("select id from workspaces where id=$1 for update", [
    workspaceId,
  ])
  const { rows } = await db.query<{ role: WorkspaceRole }>(
    "select role from workspace_members where workspace_id=$1 and user_id=$2",
    [workspaceId, userId]
  )
  if (!rows[0] || !["owner", "admin"].includes(rows[0].role))
    throw new WorkspaceAccessError()
  return rows[0].role
}
export async function ensurePersonalWorkspace(userId: string) {
  return transaction(async (db) => {
    const id = `imported-${userId}`,
      projectId = `imported-project-${userId}`
    const created = await db.query(
      "insert into workspaces(id,name,created_by,imported_for_user_id) values($1,'My workspace',$2,$2) on conflict(imported_for_user_id) do nothing returning id",
      [id, userId]
    )
    if (!created.rows[0]) return { workspaceId: id, projectId }
    await db.query(
      "insert into workspace_members(id,workspace_id,user_id,role) values($1,$2,$3,'owner') on conflict(workspace_id,user_id) do nothing",
      [`imported-member-${userId}`, id, userId]
    )
    await db.query(
      "insert into projects(id,workspace_id,name,description) values($1,$2,'Imported','Existing reporting data') on conflict(id) do nothing",
      [projectId, id]
    )
    return { workspaceId: id, projectId }
  })
}
export async function listWorkspaces(userId: string): Promise<WorkspaceView[]> {
  const { rows } = await getPool().query(
    "select w.id,w.name,m.role from workspaces w join workspace_members m on m.workspace_id=w.id where m.user_id=$1 order by w.created_at,w.id",
    [userId]
  )
  return rows
}
export async function listProjects(
  userId: string,
  workspaceId: string
): Promise<ProjectView[]> {
  await requireWorkspace(userId, workspaceId)
  const { rows } = await getPool().query(
    'select p.id,p.workspace_id as "workspaceId",p.name,p.description,p.archived_at as "archivedAt" from projects p join workspace_members m on m.workspace_id=p.workspace_id where p.workspace_id=$1 and m.user_id=$2 order by p.created_at,p.id',
    [workspaceId, userId]
  )
  return rows
}
export async function createWorkspace(userId: string, name: string) {
  return transaction(async (db) => {
    const id = randomUUID(),
      projectId = randomUUID()
    await db.query(
      "insert into workspaces(id,name,created_by) values($1,$2,$3)",
      [id, name, userId]
    )
    await db.query(
      "insert into workspace_members(id,workspace_id,user_id,role) values($1,$2,$3,'owner')",
      [randomUUID(), id, userId]
    )
    await db.query(
      "insert into projects(id,workspace_id,name) values($1,$2,'First project')",
      [projectId, id]
    )
    await audit(db, id, userId, "workspace.created", id)
    return { workspaceId: id, projectId }
  })
}
export async function changeProject(
  userId: string,
  workspaceId: string,
  input: {
    id?: string
    name?: string
    description?: string
    archived?: boolean
  }
) {
  return transaction(async (db) => {
    await manager(db, userId, workspaceId)
    const id = input.id ?? randomUUID()
    if (input.id) {
      const r = await db.query(
        "update projects set name=coalesce($3,name),description=coalesce($4,description),archived_at=case when $5::boolean is null then archived_at when $5 then now() else null end where id=$1 and workspace_id=$2 returning id",
        [
          id,
          workspaceId,
          input.name ?? null,
          input.description ?? null,
          input.archived ?? null,
        ]
      )
      if (!r.rows[0]) throw new WorkspaceAccessError()
    } else
      await db.query(
        "insert into projects(id,workspace_id,name,description) values($1,$2,$3,$4)",
        [id, workspaceId, input.name, input.description ?? ""]
      )
    await audit(
      db,
      workspaceId,
      userId,
      input.id ? "project.updated" : "project.created",
      id
    )
    return id
  })
}
export async function createInvitation(
  userId: string,
  workspaceId: string,
  role: Exclude<WorkspaceRole, "owner">
) {
  return transaction(async (db) => {
    const actor = await manager(db, userId, workspaceId)
    if (!canManageMember(actor, role, role)) throw new WorkspaceAccessError()
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID()
    await db.query(
      "insert into workspace_invitations(id,workspace_id,token_hash,role,created_by,expires_at) values($1,$2,$3,$4,$5,now()+interval '7 days')",
      [
        id,
        workspaceId,
        createHash("sha256").update(token).digest("hex"),
        role,
        userId,
      ]
    )
    await audit(db, workspaceId, userId, "invitation.created", id)
    return token
  })
}
export async function acceptInvitation(userId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new WorkspaceAccessError()
  return transaction(async (db) => {
    const hash = createHash("sha256").update(token).digest("hex")
    const found = await db.query(
      "select workspace_id from workspace_invitations where token_hash=$1",
      [hash]
    )
    const workspaceId = found.rows[0]?.workspace_id
    if (!workspaceId) throw new WorkspaceAccessError()
    await db.query("select id from workspaces where id=$1 for update", [
      workspaceId,
    ])
    const r = await db.query(
      "select id,role from workspace_invitations where token_hash=$1 and revoked_at is null and accepted_at is null and expires_at>now() for update",
      [hash]
    )
    if (!r.rows[0]) throw new WorkspaceAccessError()
    await db.query(
      "insert into workspace_members(id,workspace_id,user_id,role) values($1,$2,$3,$4) on conflict(workspace_id,user_id) do nothing",
      [randomUUID(), workspaceId, userId, r.rows[0].role]
    )
    await db.query(
      "update workspace_invitations set accepted_at=now(),accepted_by=$2 where id=$1",
      [r.rows[0].id, userId]
    )
    await audit(db, workspaceId, userId, "invitation.accepted", r.rows[0].id)
    return workspaceId
  })
}
export async function revokeInvitation(
  userId: string,
  workspaceId: string,
  id: string
) {
  await transaction(async (db) => {
    const actor = await manager(db, userId, workspaceId)
    const r = await db.query<{ role: WorkspaceRole }>(
      "select role from workspace_invitations where id=$1 and workspace_id=$2",
      [id, workspaceId]
    )
    if (!r.rows[0] || !canManageMember(actor, r.rows[0].role))
      throw new WorkspaceAccessError()
    await db.query(
      "update workspace_invitations set revoked_at=now() where id=$1 and accepted_at is null",
      [id]
    )
    await audit(db, workspaceId, userId, "invitation.revoked", id)
  })
}
export async function changeMember(
  userId: string,
  workspaceId: string,
  targetId: string,
  role: WorkspaceRole | null
) {
  await transaction(async (db) => {
    const actor = await manager(db, userId, workspaceId)
    if (targetId === userId) throw new WorkspaceAccessError()
    const r = await db.query<{ role: WorkspaceRole }>(
      "select role from workspace_members where workspace_id=$1 and user_id=$2",
      [workspaceId, targetId]
    )
    if (
      !r.rows[0] ||
      !canManageMember(actor, r.rows[0].role, role ?? undefined)
    )
      throw new WorkspaceAccessError()
    if (role)
      await db.query(
        "update workspace_members set role=$3 where workspace_id=$1 and user_id=$2",
        [workspaceId, targetId, role]
      )
    else
      await db.query(
        "delete from workspace_members where workspace_id=$1 and user_id=$2",
        [workspaceId, targetId]
      )
    await audit(
      db,
      workspaceId,
      userId,
      role ? "member.role_changed" : "member.removed",
      targetId
    )
  })
}
export async function transferOwnership(
  userId: string,
  workspaceId: string,
  targetId: string
) {
  await transaction(async (db) => {
    if (
      (await manager(db, userId, workspaceId)) !== "owner" ||
      targetId === userId
    )
      throw new WorkspaceAccessError()
    const r = await db.query(
      "select id from workspace_members where workspace_id=$1 and user_id=$2",
      [workspaceId, targetId]
    )
    if (!r.rows[0]) throw new WorkspaceAccessError()
    await db.query(
      "update workspace_members set role=case when user_id=$2 then 'owner'::workspace_role else 'admin'::workspace_role end where workspace_id=$1 and user_id=any($3::text[])",
      [workspaceId, targetId, [userId, targetId]]
    )
    await audit(
      db,
      workspaceId,
      userId,
      "workspace.ownership_transferred",
      targetId
    )
  })
}
export async function teamDetails(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId, "manage")
  const [members, invitations] = await Promise.all([
    getPool().query(
      'select m.user_id as "userId",u.email,m.role from workspace_members m join users u on u.id=m.user_id where m.workspace_id=$1 order by m.created_at',
      [workspaceId]
    ),
    getPool().query(
      'select id,role,expires_at as "expiresAt",revoked_at as "revokedAt",accepted_at as "acceptedAt" from workspace_invitations where workspace_id=$1 order by created_at desc limit 100',
      [workspaceId]
    ),
  ])
  return { members: members.rows, invitations: invitations.rows }
}
