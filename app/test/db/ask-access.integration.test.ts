import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { withScratchSchema } from "@/test/db/scratch-schema"
import * as schema from "@/lib/db/schema"
const db = withScratchSchema(import.meta.url)
vi.mock("@/lib/db", () => ({
  getPool: () => db.pool(),
  getDb: () => drizzle(db.pool(), { schema }),
}))
import { listAccounts, setAskAccess } from "@/lib/admin/platform"
import { readAskLevel } from "@/lib/chat/access"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import {
  acceptInvitation,
  createInvitation,
  createWorkspace,
} from "@/lib/workspaces/store"

/**
 * Who gets Ask where, against real membership and grant rows (roles-and-ask-access Req 6, 7).
 *
 * The cast: a platform admin who owns an Ask home; an editor and a viewer in it; a
 * partner who is an editor there too, is granted Ask, and owns a workspace of their own
 * with an invitee in it; and an outsider with a workspace and no grant.
 */

const ADMIN_EMAIL = "platform-admin@example.test"
const previousAdmins = process.env.RPT_PLATFORM_ADMIN_EMAILS

let admin: string, editor: string, viewer: string, partner: string, invitee: string, outsider: string
let home: string, partnerOwn: string, outsiderOwn: string

beforeAll(async () => {
  if (!db.enabled) return
  process.env.RPT_PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL
  ;[admin, editor, viewer, partner, invitee, outsider] = Array.from({ length: 6 }, () => randomUUID())
  for (const id of [admin, editor, viewer, partner, invitee, outsider]) {
    const email = id === admin ? ADMIN_EMAIL : `${id}@example.test`
    await db.query(
      "insert into users(id,email,email_normalized,password_hash) values($1,$2,$2,'unusable')",
      [id, email]
    )
  }

  home = (await createWorkspace(admin, "Ask home")).workspaceId
  for (const [id, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
    [partner, "editor"],
  ] as const)
    await acceptInvitation(id, await createInvitation(admin, home, role))

  partnerOwn = (await createWorkspace(partner, "Partner's own")).workspaceId
  await acceptInvitation(invitee, await createInvitation(partner, partnerOwn, "editor"))
  outsiderOwn = (await createWorkspace(outsider, "Outsider's own")).workspaceId

  await setAskAccess({ admin: { id: admin, email: ADMIN_EMAIL }, userId: partner, enabled: true })
})

afterAll(() => {
  if (previousAdmins === undefined) delete process.env.RPT_PLATFORM_ADMIN_EMAILS
  else process.env.RPT_PLATFORM_ADMIN_EMAILS = previousAdmins
})

test.skipIf(!db.enabled)("members of a platform admin's workspace use Ask by role", async () => {
  expect(await readAskLevel(admin, home)).toBe("chat")
  expect(await readAskLevel(editor, home)).toBe("chat")
  expect(await readAskLevel(viewer, home)).toBe("read")
})

test.skipIf(!db.enabled)("a granted account uses Ask in its own workspace and no longer in the admin's", async () => {
  expect(await readAskLevel(partner, partnerOwn)).toBe("chat")
  expect(await readAskLevel(partner, home)).toBe("none")
})

test.skipIf(!db.enabled)("the people a granted account invites, and everyone else, get no Ask", async () => {
  expect(await readAskLevel(invitee, partnerOwn)).toBe("none")
  expect(await readAskLevel(outsider, outsiderOwn)).toBe("none")
  expect(await readAskLevel(outsider, home)).toBe("none")
})

test.skipIf(!db.enabled)("only a platform admin grants, never to another admin, and removing a grant takes Ask away", async () => {
  await expect(
    setAskAccess({ admin: { id: editor, email: `${editor}@example.test` }, userId: outsider, enabled: true })
  ).rejects.toBeInstanceOf(WorkspaceAccessError)
  await expect(
    setAskAccess({ admin: { id: admin, email: ADMIN_EMAIL }, userId: admin, enabled: true })
  ).rejects.toBeInstanceOf(WorkspaceAccessError)

  const adminRef = { id: admin, email: ADMIN_EMAIL }
  const first = await setAskAccess({ admin: adminRef, userId: outsider, enabled: true })
  expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(await readAskLevel(outsider, outsiderOwn)).toBe("chat")
  // A second grant keeps the first one's date.
  expect(await setAskAccess({ admin: adminRef, userId: outsider, enabled: true })).toBe(first)

  expect(await setAskAccess({ admin: adminRef, userId: outsider, enabled: false })).toBeNull()
  expect(await readAskLevel(outsider, outsiderOwn)).toBe("none")
})

test.skipIf(!db.enabled)("the admin page lists grants and where each account sits in the admin's workspaces", async () => {
  const accounts = await listAccounts()
  const byId = new Map(accounts.map((account) => [account.userId, account]))
  // Counted from the rows, not assumed: every account also owns the personal workspace it
  // was given, beside the ones created above.
  const owned = async (id: string): Promise<number> =>
    (
      await db.query(
        "select count(*)::int as n from workspace_members where user_id=$1 and role='owner'",
        [id]
      )
    ).rows[0].n

  expect(byId.get(admin)).toMatchObject({
    admin: true,
    homeRole: "owner",
    ownedWorkspaces: await owned(admin),
  })
  expect(byId.get(partner)).toMatchObject({
    admin: false,
    homeRole: "editor",
    ownedWorkspaces: await owned(partner),
  })
  expect(byId.get(partner)?.ownedWorkspaces).toBeGreaterThanOrEqual(1)
  expect(byId.get(partner)?.grantedAt).not.toBeNull()
  expect(byId.get(invitee)).toMatchObject({ homeRole: null, grantedAt: null })
})

test.skipIf(!db.enabled)("with no platform admin configured, nobody has Ask — not even a granted account", async () => {
  process.env.RPT_PLATFORM_ADMIN_EMAILS = ""
  try {
    expect(await readAskLevel(admin, home)).toBe("none")
    expect(await readAskLevel(partner, partnerOwn)).toBe("none")
  } finally {
    process.env.RPT_PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL
  }
})
