
import { randomUUID } from "node:crypto"

import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * `lib/profiles/authored-matches-store.ts` against a real Postgres 17 (task
 * 3.10, Requirement 9.5).
 *
 * ## Why these claims need a database
 *
 * **The upsert semantics ARE the SQL.** `writeAuthoredMatches` conflicts on
 * `unique(template_version_id, section_id)` — whether a second write for the
 * same pair updates in place rather than duplicating is a claim about a
 * constraint Postgres enforces, not about this module's own control flow. A
 * mocked client would let a broken `onConflictDoUpdate` target pass silently.
 *
 * **The FK to `subscription_scans` and `report_template_versions` is real** —
 * a `scanId`/`templateVersionId` that does not exist must be refused by the
 * database, which is the actual guarantee "the row always names a real scan
 * and a real version" rests on.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import * as schema from "@/lib/db/schema"
import {
  readAuthoredMatches,
  writeAuthoredMatches,
} from "@/lib/profiles/authored-matches-store"

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let ownerId: string
let subscriptionId: string
let templateId: string
let versionId: string
let scanId: string
let otherScanId: string

function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) {
    throw new Error(
      "The scratch-schema Drizzle client is not open. Read it inside a test."
    )
  }
  return drizzleDb
}

const UNUSABLE_PASSWORD_HASH = "$argon2id$fixture-never-verified"
const UNUSABLE_SECRET = "enc:fixture-never-decrypted"

beforeAll(async () => {
  if (!db.enabled) return

  drizzleDb = drizzle(db.pool(), { schema })

  ownerId = randomUUID()
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [ownerId, "owner@example.com", "owner@example.com", UNUSABLE_PASSWORD_HASH]
  )
})

beforeEach(async () => {
  if (!db.enabled) return

  await db.query(
    `TRUNCATE report_profile_authored_matches, subscription_scans,
     report_template_versions, report_templates, connected_subscriptions CASCADE`
  )

  subscriptionId = randomUUID()
  const connectedSubscriptionRowId = randomUUID()
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, subscription_id, display_name, tenant_id, client_id,
        client_secret_enc, scope_verified, fidelity_tier, status, secret_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      connectedSubscriptionRowId,
      ownerId,
      subscriptionId,
      "Test Subscription",
      "tenant-1",
      "client-1",
      UNUSABLE_SECRET,
      true,
      "baseline",
      "active",
      new Date("2099-01-01T00:00:00Z"),
    ]
  )

  templateId = randomUUID()
  await db.query(
    `INSERT INTO report_templates (id, user_id, name) VALUES ($1, $2, $3)`,
    [templateId, ownerId, "Test Template"]
  )

  versionId = randomUUID()
  await db.query(
    `INSERT INTO report_template_versions
       (id, template_id, version, definition, definition_sha256)
     VALUES ($1, $2, $3, $4, $5)`,
    [versionId, templateId, 1, JSON.stringify({ schema_version: 3 }), "digest-1"]
  )

  scanId = randomUUID()
  await db.query(
    `INSERT INTO subscription_scans (id, user_id, connected_subscription_id, status)
     VALUES ($1, $2, $3, $4)`,
    [scanId, ownerId, connectedSubscriptionRowId, "complete"]
  )

  otherScanId = randomUUID()
  await db.query(
    `INSERT INTO subscription_scans (id, user_id, connected_subscription_id, status)
     VALUES ($1, $2, $3, $4)`,
    [otherScanId, ownerId, connectedSubscriptionRowId, "complete"]
  )
})

describe("writeAuthoredMatches / readAuthoredMatches", () => {
  test("writes one row per section, readable back", async () => {
    if (!db.enabled) return

    await writeAuthoredMatches(versionId, scanId, [
      { sectionId: "sec_1", matchedCount: 3, matchedResourceIds: ["r1", "r2", "r3"] },
      { sectionId: "sec_2", matchedCount: 0, matchedResourceIds: [] },
    ])

    const rows = await readAuthoredMatches(versionId)
    const bySection = new Map(rows.map((r) => [r.sectionId, r]))

    expect(rows).toHaveLength(2)
    expect(bySection.get("sec_1")).toEqual({
      sectionId: "sec_1",
      matchedCount: 3,
      matchedResourceIds: ["r1", "r2", "r3"],
    })
    expect(bySection.get("sec_2")).toEqual({
      sectionId: "sec_2",
      matchedCount: 0,
      matchedResourceIds: [],
    })
  })

  test("a second write for the same (version, section) UPDATES in place, not a duplicate", async () => {
    if (!db.enabled) return

    await writeAuthoredMatches(versionId, scanId, [
      { sectionId: "sec_1", matchedCount: 2, matchedResourceIds: ["r1", "r2"] },
    ])

    // Requirement 9.5's other half: republishing an UNCHANGED definition
    // against a freshly re-scanned estate still needs its authored-matches
    // rows to reflect the CURRENT scan, even though insertVersion created no
    // new version row to hold them.
    await writeAuthoredMatches(versionId, otherScanId, [
      { sectionId: "sec_1", matchedCount: 5, matchedResourceIds: ["r1", "r2", "r3", "r4", "r5"] },
    ])

    const rows = await readAuthoredMatches(versionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      sectionId: "sec_1",
      matchedCount: 5,
      matchedResourceIds: ["r1", "r2", "r3", "r4", "r5"],
    })

    const result = await db.query(
      `SELECT scan_id FROM report_profile_authored_matches WHERE template_version_id = $1 AND section_id = $2`,
      [versionId, "sec_1"]
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].scan_id).toBe(otherScanId)
  })

  test("an empty matches array writes nothing", async () => {
    if (!db.enabled) return

    await writeAuthoredMatches(versionId, scanId, [])

    const rows = await readAuthoredMatches(versionId)
    expect(rows).toHaveLength(0)
  })

  test("rows for a different template version are untouched by a write to this one", async () => {
    if (!db.enabled) return

    const otherVersionId = randomUUID()
    await db.query(
      `INSERT INTO report_template_versions
         (id, template_id, version, definition, definition_sha256)
       VALUES ($1, $2, $3, $4, $5)`,
      [otherVersionId, templateId, 2, JSON.stringify({ schema_version: 3 }), "digest-2"]
    )

    await writeAuthoredMatches(versionId, scanId, [
      { sectionId: "sec_1", matchedCount: 1, matchedResourceIds: ["r1"] },
    ])
    await writeAuthoredMatches(otherVersionId, scanId, [
      { sectionId: "sec_1", matchedCount: 9, matchedResourceIds: Array.from({ length: 9 }, (_, i) => `r${i}`) },
    ])

    const first = await readAuthoredMatches(versionId)
    const second = await readAuthoredMatches(otherVersionId)

    expect(first).toEqual([
      { sectionId: "sec_1", matchedCount: 1, matchedResourceIds: ["r1"] },
    ])
    expect(second[0]?.matchedCount).toBe(9)
  })

  test("a scan_id naming no real scan is refused by the database", async () => {
    if (!db.enabled) return

    await expect(
      writeAuthoredMatches(versionId, randomUUID(), [
        { sectionId: "sec_1", matchedCount: 1, matchedResourceIds: ["r1"] },
      ])
    ).rejects.toThrow()
  })
})
