import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * Monthly schedules against a real Postgres: saving, the tick starting one once a month,
 * a rejected start kept for the Close Board, and who may save one.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
  getPool: () => db.pool(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import * as schema from "@/lib/db/schema"
import { deleteSchedule, readSchedule, saveSchedule, startDueSchedules } from "@/lib/schedules/store"
import type { TemplateDefinition } from "@/lib/templates/definition"
import { V1_TEST_FIXTURE_DEFINITION } from "@/lib/templates/starters"
import { definitionSha256 } from "@/lib/templates/version"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let ownerId: string
let strangerId: string
let subscriptionId: string

function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) throw new Error("The scratch-schema Drizzle client is not open.")
  return drizzleDb
}

const savedEnv: Record<string, string | undefined> = {}

// 3 Oct 2026, 12:00 WIB. A schedule for the 1st has already passed this month.
const MID_MONTH = new Date("2026-10-03T05:00:00Z")

async function insertUser(id: string): Promise<void> {
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash) VALUES ($1, $2, $3, $4)`,
    [id, `${id}@example.com`, `${id}@example.com`, "$argon2id$fixture-never-verified"]
  )
}

async function insertTemplate(userId: string, versions: number): Promise<string> {
  const templateId = `tpl-${randomUUID()}`
  await db.query(`INSERT INTO report_templates (id, user_id, name, description) VALUES ($1, $2, 'Monthly', '')`, [
    templateId,
    userId,
  ])
  let last: string | null = null
  for (let version = 1; version <= versions; version++) {
    last = `ver-${randomUUID()}`
    await db.query(
      `INSERT INTO report_template_versions (id, template_id, version, definition, definition_sha256)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        last,
        templateId,
        version,
        JSON.stringify(V1_TEST_FIXTURE_DEFINITION),
        definitionSha256(V1_TEST_FIXTURE_DEFINITION as TemplateDefinition),
      ]
    )
  }
  if (last !== null) await db.query(`UPDATE report_templates SET current_version_id = $2 WHERE id = $1`, [templateId, last])
  return templateId
}

const scopeOf = (userId: string) => ({ workspaceId: `imported-${userId}`, projectId: `imported-project-${userId}` })

async function runCount(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM report_runs`)
  return Number(rows[0]?.n)
}

beforeAll(() => {
  if (!db.enabled) return
  savedEnv["APP_ENCRYPTION_KEY"] = process.env["APP_ENCRYPTION_KEY"]
  process.env["APP_ENCRYPTION_KEY"] = Buffer.alloc(32, 9).toString("base64")
  drizzleDb = drizzle(db.pool(), { schema })
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

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

describe.skipIf(!db.enabled)("monthly schedules", () => {
  test("a slot already past this month starts next month, not now", async () => {
    const templateId = await insertTemplate(ownerId, 1)
    const saved = await saveSchedule(
      ownerId,
      { ...scopeOf(ownerId), connectedSubscriptionId: subscriptionId, templateId, dayOfMonth: 1, hour: 2 },
      MID_MONTH
    )

    expect(saved).toMatchObject({ cadence: "on the 1st at 02:00 WIB", next: "1 Nov, 02:00", enabled: true })
    expect(await startDueSchedules(MID_MONTH)).toEqual([])
    expect(await runCount()).toBe(0)
  })

  test("a due schedule starts one run, once a month, however many ticks see it", async () => {
    const templateId = await insertTemplate(ownerId, 1)
    await saveSchedule(
      ownerId,
      { ...scopeOf(ownerId), connectedSubscriptionId: subscriptionId, templateId, dayOfMonth: 5, hour: 2 },
      MID_MONTH
    )

    const fifth = new Date("2026-10-04T19:30:00Z") // 5 Oct, 02:30 WIB
    const [attempt] = await startDueSchedules(fifth)
    expect(attempt).toMatchObject({ deduplicated: false })
    expect(await startDueSchedules(new Date("2026-10-04T19:31:00Z"))).toEqual([])
    expect(await runCount()).toBe(1)

    const schedule = await readSchedule(ownerId, scopeOf(ownerId), fifth)
    expect(schedule).toMatchObject({ lastRunId: (attempt as { runId: string }).runId, lastError: null, next: "5 Nov, 02:00" })
  })

  test("a start the enqueue refuses is kept for the Close Board and not retried", async () => {
    const templateId = await insertTemplate(ownerId, 1)
    await saveSchedule(
      ownerId,
      { ...scopeOf(ownerId), connectedSubscriptionId: subscriptionId, templateId, dayOfMonth: 5, hour: 2 },
      MID_MONTH
    )
    await db.query(`UPDATE connected_subscriptions SET status = 'disabled' WHERE id = $1`, [subscriptionId])

    const [attempt] = await startDueSchedules(new Date("2026-10-04T19:30:00Z"))
    expect(attempt).toHaveProperty("error")
    expect(await startDueSchedules(new Date("2026-10-06T00:00:00Z"))).toEqual([])
    expect(await runCount()).toBe(0)
    expect((await readSchedule(ownerId, scopeOf(ownerId)))?.lastError).toMatch(/not ready to run/)
  })

  test("only a member who can edit the customer saves or stops its schedule", async () => {
    const templateId = await insertTemplate(ownerId, 1)
    const input = { ...scopeOf(ownerId), connectedSubscriptionId: subscriptionId, templateId, dayOfMonth: 1, hour: 2 }

    await expect(saveSchedule(strangerId, input, MID_MONTH)).rejects.toBeInstanceOf(WorkspaceAccessError)
    await expect(saveSchedule(ownerId, { ...input, connectedSubscriptionId: "sub-nobody" }, MID_MONTH)).rejects.toBeInstanceOf(
      WorkspaceAccessError
    )

    await saveSchedule(ownerId, input, MID_MONTH)
    await expect(deleteSchedule(strangerId, scopeOf(ownerId))).rejects.toBeInstanceOf(WorkspaceAccessError)
    await deleteSchedule(ownerId, scopeOf(ownerId))
    expect(await readSchedule(ownerId, scopeOf(ownerId))).toBeNull()
  })
})
