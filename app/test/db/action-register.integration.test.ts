import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * The Action register against a real Postgres: the sync from a verified run's findings,
 * resolution on evidence only, reopening, and the edits people make.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
  getPool: () => db.pool(),
}))

const s3 = vi.hoisted(() => ({ bundle: null as unknown }))
vi.mock("@/lib/aws/s3", () => ({ getSnapshotJson: async () => s3.bundle }))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import { ActionItemInputError, listActionItems, updateActionItem } from "@/lib/action-register/store"
import { planSync, registerForConnector, syncActionRegister } from "@/lib/action-register/sync"
import * as schema from "@/lib/db/schema"
import type { ReportRun } from "@/lib/db/schema"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let ownerId: string
let strangerId: string
let subscriptionId: string

function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) throw new Error("The scratch-schema Drizzle client is not open.")
  return drizzleDb
}

async function insertUser(id: string): Promise<void> {
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash) VALUES ($1, $2, $3, $4)`,
    [id, `${id}@example.com`, `${id}@example.com`, "$argon2id$fixture-never-verified"]
  )
}

const scopeOf = (userId: string) => ({ workspaceId: `imported-${userId}`, projectId: `imported-project-${userId}` })

function run(id: string, periodStart: string, snapshotId: string): ReportRun {
  return {
    id,
    userId: ownerId,
    ...scopeOf(ownerId),
    connectedSubscriptionId: subscriptionId,
    periodStart,
    snapshotId,
  } as unknown as ReportRun
}

const finding = (key: string, title: string) => ({
  key,
  kind: key.split(":")[0]!,
  resource_id: key.split(":").slice(1).join(":"),
  title,
})

beforeAll(() => {
  if (!db.enabled) return
  drizzleDb = drizzle(db.pool(), { schema })
})

afterAll(() => {})

beforeEach(async () => {
  if (!db.enabled) return
  await db.query(`TRUNCATE users CASCADE`)
  ownerId = randomUUID()
  strangerId = randomUUID()
  subscriptionId = `sub-${randomUUID()}`
  await insertUser(ownerId)
  await insertUser(strangerId)
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, display_name, subscription_id, tenant_id, client_id, client_secret_enc,
        scope_verified, fidelity_tier, secret_expires_at, status)
     VALUES ($1, $2, 'Fixture subscription', '3f2b0000-0000-0000-0000-000000000000', 'tenant-fixture',
             'client-fixture', 'ciphertext-fixture', true, 'baseline', now() + interval '400 days', 'active')`,
    [subscriptionId, ownerId]
  )
})

describe("the sync plan", () => {
  test("adds new findings, sees known ones, and resolves only what was checked clear", () => {
    const plan = planSync(
      [
        { findingKey: "backup:/r/a", status: "open" },
        { findingKey: "housekeeping:/r/b", status: "accepted" },
        { findingKey: "housekeeping:/r/c", status: "open" },
        { findingKey: "advisor:/r/rec", status: "open" },
      ],
      {
        schema_version: 1,
        findings: [finding("backup:/r/a", "Back up a"), finding("rightsizing:/r/d", "Resize d")],
        checked: ["housekeeping:/r/b"],
        advisor_answered: true,
      }
    )
    expect(plan.add.map((f) => f.key)).toEqual(["rightsizing:/r/d"])
    expect(plan.seen).toEqual(["backup:/r/a"])
    // `/r/c` was not checked this run, so it stays open; Advisor answered, so its item resolves.
    expect(plan.resolve).toEqual(["housekeeping:/r/b", "advisor:/r/rec"])
  })
})

describe.skipIf(!db.enabled)("the Action register", () => {
  test("a verified run's findings open items, and a later run resolves and reopens them", async () => {
    s3.bundle = {
      schema_version: 1,
      findings: [finding("housekeeping:/r/vm", "vm: Stopped"), finding("backup:/r/vm", "Back up vm")],
      checked: [],
      advisor_answered: false,
    }
    await syncActionRegister(run("run-aug", "2026-08-01", "snap-aug"))
    let items = await listActionItems(ownerId, scopeOf(ownerId))
    expect(items.map((i) => [i.title, i.status])).toEqual([["Back up vm", "open"], ["vm: Stopped", "open"]])

    // September: the machine was started (checked clear); the backup is still missing.
    s3.bundle = {
      schema_version: 1,
      findings: [finding("backup:/r/vm", "Back up vm")],
      checked: ["housekeeping:/r/vm"],
      advisor_answered: false,
    }
    await syncActionRegister(run("run-sep", "2026-09-01", "snap-sep"))
    items = await listActionItems(ownerId, scopeOf(ownerId))
    const stopped = items.find((i) => i.title === "vm: Stopped")!
    expect(stopped).toMatchObject({ status: "resolved", resolvedRunId: "run-sep", resolvedSnapshotId: "snap-sep" })
    expect(items.find((i) => i.title === "Back up vm")).toMatchObject({ status: "open", firstSeenPeriod: "2026-08-01" })

    // October: stopped again — the resolved item reopens.
    s3.bundle = {
      schema_version: 1,
      findings: [finding("housekeeping:/r/vm", "vm: Stopped")],
      checked: [],
      advisor_answered: false,
    }
    await syncActionRegister(run("run-oct", "2026-10-01", "snap-oct"))
    items = await listActionItems(ownerId, scopeOf(ownerId))
    expect(items.find((i) => i.title === "vm: Stopped")).toMatchObject({ status: "open", resolvedRunId: null })

    const register = await registerForConnector(subscriptionId)
    expect(register.find((r) => r.key === "housekeeping:/r/vm")).toMatchObject({ status: "open", since: "Aug 2026" })
  })

  test("an unreadable bundle leaves the register unchanged", async () => {
    s3.bundle = { schema_version: 2 }
    vi.spyOn(console, "error").mockImplementation(() => {})
    await syncActionRegister(run("run-aug", "2026-08-01", "snap-aug"))
    expect(await listActionItems(ownerId, scopeOf(ownerId))).toEqual([])
  })

  test("people set owner and status; Won't do needs a note; resolved is not theirs to set", async () => {
    s3.bundle = { schema_version: 1, findings: [finding("backup:/r/vm", "Back up vm")], checked: [], advisor_answered: false }
    await syncActionRegister(run("run-aug", "2026-08-01", "snap-aug"))
    const [item] = await listActionItems(ownerId, scopeOf(ownerId))

    await expect(updateActionItem(ownerId, item!.id, { owner: "customer", status: "wont_do", note: " " })).rejects.toBeInstanceOf(
      ActionItemInputError
    )
    await expect(updateActionItem(strangerId, item!.id, { owner: "msp", status: "accepted", note: null })).rejects.toBeInstanceOf(
      WorkspaceAccessError
    )
    const updated = await updateActionItem(ownerId, item!.id, { owner: "customer", status: "wont_do", note: "Dev box, no backup needed" })
    expect(updated).toMatchObject({ owner: "customer", status: "wont_do", note: "Dev box, no backup needed" })

    // Checked clear later: even a Won't do item resolves, and then it is not editable.
    s3.bundle = { schema_version: 1, findings: [], checked: ["backup:/r/vm"], advisor_answered: false }
    await syncActionRegister(run("run-sep", "2026-09-01", "snap-sep"))
    await expect(updateActionItem(ownerId, item!.id, { owner: null, status: "open", note: null })).rejects.toBeInstanceOf(
      ActionItemInputError
    )
  })
})
