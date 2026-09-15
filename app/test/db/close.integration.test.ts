import { randomUUID } from "node:crypto"
import { beforeAll, expect, test, vi } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { withScratchSchema } from "@/test/db/scratch-schema"
import * as schema from "@/lib/db/schema"
const db = withScratchSchema(import.meta.url)
vi.mock("@/lib/db", () => ({
  getPool: () => db.pool(),
  getDb: () => drizzle(db.pool(), { schema }),
}))
import { loadClose } from "@/lib/close/load"
import {
  acceptInvitation,
  changeProject,
  createInvitation,
  createWorkspace,
  listWorkspaces,
  setCloseDay,
} from "@/lib/workspaces/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

let owner: string, admin: string, outsider: string
let scope: { workspaceId: string; projectId: string }

beforeAll(async () => {
  if (!db.enabled) return
  ;[owner, admin, outsider] = [randomUUID(), randomUUID(), randomUUID()]
  for (const id of [owner, admin, outsider])
    await db.query(
      "insert into users(id,email,email_normalized,password_hash) values($1,$2,$2,'unusable')",
      [id, `${id}@example.test`]
    )
  scope = await createWorkspace(owner, "Close board")
  await acceptInvitation(admin, await createInvitation(owner, scope.workspaceId, "admin"))
})

test.skipIf(!db.enabled)("a new workspace closes on the 15th by default", async () => {
  const workspace = (await listWorkspaces(owner)).find(
    (w) => w.id === scope.workspaceId
  )
  expect(workspace?.closeDay).toBe(15)
})

test.skipIf(!db.enabled)("only the owner can move the close day, and only within 1..28", async () => {
  await expect(setCloseDay(outsider, scope.workspaceId, 10)).rejects.toBeInstanceOf(
    WorkspaceAccessError
  )
  // roles-and-ask-access Req 3: an admin sees the close day and cannot move it.
  await expect(setCloseDay(admin, scope.workspaceId, 10)).rejects.toBeInstanceOf(
    WorkspaceAccessError
  )
  await setCloseDay(owner, scope.workspaceId, 20)
  const workspace = (await listWorkspaces(owner)).find(
    (w) => w.id === scope.workspaceId
  )
  expect(workspace?.closeDay).toBe(20)
  await expect(setCloseDay(owner, scope.workspaceId, 31)).rejects.toThrow()
})

test.skipIf(!db.enabled)("every live customer with nothing requested is due, archived ones are dropped", async () => {
  const archived = await changeProject(owner, scope.workspaceId, {
    name: "Former customer",
  })
  await changeProject(owner, scope.workspaceId, { id: archived, archived: true })

  const { period, board } = await loadClose(
    owner,
    { id: scope.workspaceId, closeDay: 15 },
    new Date()
  )

  expect(board.openMonth).toBe(period.month)
  expect(board.months).toHaveLength(6)
  expect(board.rows.map((row) => row.project.id)).toEqual([scope.projectId])
  expect(board.rows[0].current.state).toBe("due")
  expect(board.counts.due).toBe(1)
})

test.skipIf(!db.enabled)("a non-member reads an empty board, whatever ids they pass", async () => {
  const { board } = await loadClose(outsider, { id: scope.workspaceId, closeDay: 15 })
  expect(board.rows).toEqual([])
})
