import { randomUUID, createHash } from "node:crypto"
import { beforeAll, test, expect, vi } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { withScratchSchema } from "@/test/db/scratch-schema"
import * as schema from "@/lib/db/schema"
const db = withScratchSchema(import.meta.url)
vi.mock("@/lib/db", () => ({
  getPool: () => db.pool(),
  getDb: () => drizzle(db.pool(), { schema }),
}))
import {
  createWorkspace,
  changeProject,
  createInvitation,
  acceptInvitation,
  changeMember,
  transferOwnership,
  revokeInvitation,
  listWorkspaces,
} from "@/lib/workspaces/store"
import {
  requireProject,
  WorkspaceAccessError,
  DraftConflictError,
} from "@/lib/workspaces/access"
import {
  createTemplate,
  getTemplate,
  patchTemplate,
  insertVersion,
  listTemplates,
} from "@/lib/templates/store"
let owner: string,
  editor: string,
  viewer: string,
  outsider: string,
  scope: { workspaceId: string; projectId: string }
beforeAll(async () => {
  if (!db.enabled) return
  ;[owner, editor, viewer, outsider] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ]
  for (const id of [owner, editor, viewer, outsider])
    await db.query(
      "insert into users(id,email,email_normalized,password_hash) values($1,$2,$2,'unusable')",
      [id, `${id}@example.test`]
    )
  scope = await createWorkspace(owner, "Customer delivery")
  for (const [id, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ])
    await acceptInvitation(
      id,
      await createInvitation(
        owner,
        scope.workspaceId,
        role as "editor" | "viewer"
      )
    )
})
test("new and legacy user data defaults have an owned workspace", async () => {
  const rows = await listWorkspaces(outsider)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.role).toBe("owner")
  const r = await db.query(
    "select count(*)::int n from projects where workspace_id=$1",
    [rows[0]?.id]
  )
  expect(r.rows[0].n).toBe(1)
})
test("role checks reject outsiders and viewers before mutations", async () => {
  await expect(requireProject(outsider, scope)).rejects.toBeInstanceOf(
    WorkspaceAccessError
  )
  await expect(requireProject(viewer, scope, "edit")).rejects.toBeInstanceOf(
    WorkspaceAccessError
  )
  await expect(requireProject(editor, scope, "connect")).rejects.toBeInstanceOf(
    WorkspaceAccessError
  )
  await expect(requireProject(editor, scope, "edit")).resolves.toMatchObject({
    role: "editor",
  })
})
test("members read a teammate profile; unrelated users cannot", async () => {
  const p = await createTemplate(owner, { ...scope, name: "Shared" })
  expect((await getTemplate(editor, p.id)).id).toBe(p.id)
  expect((await getTemplate(viewer, p.id)).id).toBe(p.id)
  await expect(getTemplate(outsider, p.id)).rejects.toThrow()
  expect((await listTemplates(editor, scope)).some((r) => r.id === p.id)).toBe(
    true
  )
})
test("concurrent draft saves have exactly one winner", async () => {
  const p = await createTemplate(owner, { ...scope, name: "Concurrent" })
  const result = await Promise.allSettled([
    patchTemplate(owner, p.id, {
      draftDefinition: { a: 1 },
      expectedRevision: 0,
    }),
    patchTemplate(editor, p.id, {
      draftDefinition: { a: 2 },
      expectedRevision: 0,
    }),
  ])
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  const rejected = result.find(
    (r) => r.status === "rejected"
  ) as PromiseRejectedResult
  expect(rejected.reason).toBeInstanceOf(DraftConflictError)
  expect((await getTemplate(owner, p.id)).draftRevision).toBe(1)
})
test("viewer cannot patch; stale publisher cannot pin different content", async () => {
  const p = await createTemplate(owner, { ...scope, name: "Pin" })
  await expect(
    patchTemplate(viewer, p.id, { name: "No", expectedRevision: 0 })
  ).rejects.toThrow()
  await patchTemplate(editor, p.id, {
    draftDefinition: { v: 2 },
    expectedRevision: 0,
  })
  await expect(
    insertVersion(owner, p.id, {
      definition: { v: 1 },
      definitionSha256: "a".repeat(64),
      expectedRevision: 0,
    })
  ).rejects.toBeInstanceOf(DraftConflictError)
  const r = await db.query(
    "select count(*)::int n from report_template_versions where template_id=$1",
    [p.id]
  )
  expect(r.rows[0].n).toBe(0)
})
test("project archive blocks edits but preserves reads", async () => {
  const id = await changeProject(owner, scope.workspaceId, { name: "Archive" })
  const sub = { workspaceId: scope.workspaceId, projectId: id }
  const p = await createTemplate(editor, { ...sub, name: "Old" })
  await changeProject(owner, scope.workspaceId, { id, archived: true })
  expect((await getTemplate(viewer, p.id)).id).toBe(p.id)
  await expect(
    patchTemplate(editor, p.id, { name: "No", expectedRevision: 0 })
  ).rejects.toThrow()
  await expect(
    createTemplate(editor, { ...sub, name: "No" })
  ).rejects.toBeInstanceOf(WorkspaceAccessError)
})
test("invitation tokens are hashed, single-use, and concurrent acceptance has one winner", async () => {
  const token = await createInvitation(owner, scope.workspaceId, "viewer")
  const hash = createHash("sha256").update(token).digest("hex")
  const r = await db.query(
    "select token_hash from workspace_invitations where token_hash=$1",
    [hash]
  )
  expect(r.rows[0].token_hash).not.toBe(token)
  const results = await Promise.allSettled([
    acceptInvitation(outsider, token),
    acceptInvitation(outsider, token),
  ])
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1)
  await changeMember(owner, scope.workspaceId, outsider, null)
  await expect(requireProject(outsider, scope)).rejects.toThrow()
})
test("expired and revoked invitations cannot be accepted", async () => {
  for (const kind of ["expired", "revoked"]) {
    const token = await createInvitation(owner, scope.workspaceId, "viewer"),
      hash = createHash("sha256").update(token).digest("hex")
    const r = await db.query(
      "select id from workspace_invitations where token_hash=$1",
      [hash]
    )
    if (kind === "expired")
      await db.query(
        "update workspace_invitations set expires_at=now()-interval '1 second' where id=$1",
        [r.rows[0].id]
      )
    else await revokeInvitation(owner, scope.workspaceId, r.rows[0].id)
    await expect(acceptInvitation(outsider, token)).rejects.toBeInstanceOf(
      WorkspaceAccessError
    )
  }
})
test("ownership cannot be removed; transfer changes both roles atomically", async () => {
  const w = await createWorkspace(owner, "Transfer")
  await acceptInvitation(
    editor,
    await createInvitation(owner, w.workspaceId, "admin")
  )
  await expect(
    changeMember(editor, w.workspaceId, owner, null)
  ).rejects.toThrow()
  await expect(
    changeMember(owner, w.workspaceId, owner, null)
  ).rejects.toThrow()
  await transferOwnership(owner, w.workspaceId, editor)
  const r = await db.query(
    "select user_id,role from workspace_members where workspace_id=$1",
    [w.workspaceId]
  )
  expect(r.rows).toEqual(
    expect.arrayContaining([
      { user_id: owner, role: "admin" },
      { user_id: editor, role: "owner" },
    ])
  )
})
