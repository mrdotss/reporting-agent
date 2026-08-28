import { randomUUID } from "node:crypto"

import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * `lib/templates/seed.ts` against a real Postgres 17 (Requirements 10.2, 10.4,
 * 10.6, 10.7).
 *
 * ## Why every claim here needs a database
 *
 * Each one is a claim where the SQL *is* the behaviour, so a double would be a
 * second, unverified query planner standing between the test and its subject:
 *
 *   * **Requirement 10.4** is `ON CONFLICT (user_id, seeded_starter_key) DO
 *     NOTHING` against a real unique constraint. The interesting case is two
 *     genuinely concurrent seedings, which both read an empty template set and
 *     which only the index can settle — a single connection cannot race itself.
 *   * **Requirement 10.6** is transaction rollback. "Retains no partially
 *     inserted starter template or starter version row" is a claim about rows
 *     that are *not* there after a failure part-way through, and it is only true
 *     if all three starters share one transaction. A per-starter transaction
 *     passes a weaker reading and leaves a user holding one of three.
 *   * **Requirement 10.2** is `version` 1 plus `current_version_id` pointing at
 *     it, asserted by reading both columns back.
 *   * **Requirement 10.7** is the absence of an insert after a delete.
 *
 * The mid-seed failure is forced with a real `BEFORE INSERT` trigger on
 * `report_templates` that raises on the **third** starter's key. A thrown
 * JavaScript error from a stubbed client would prove nothing about rollback: the
 * whole question is whether Postgres discarded the first two starters, and only
 * Postgres can answer it.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import * as schema from "@/lib/db/schema"
import { createTemplate } from "@/lib/templates/store"
import {
  readSeededStarterKeys,
  seedStarterTemplates,
  STARTERS_UNINITIALIZED_NOTICE,
} from "@/lib/templates/seed"
import {
  STARTER_KEYS,
  STARTER_TEMPLATE_COUNT,
  STARTER_TEMPLATES,
} from "@/lib/templates/starters"
import { definitionSha256 } from "@/lib/templates/version"
import { sectionByKey } from "@/lib/profiles/sections"
import { DEFAULT_PRESET_NAME, expandPreset } from "@/lib/profiles/presets"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

// --- Wiring ------------------------------------------------------------

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let userId: string
let otherUserId: string

function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) {
    throw new Error(
      "The scratch-schema Drizzle client is not open. Read it inside a test."
    )
  }
  return drizzleDb
}

const UNUSABLE_PASSWORD_HASH = "$argon2id$fixture-never-verified"

/** The starter whose insert the forced-failure test makes raise. */
const THIRD_STARTER_KEY = STARTER_TEMPLATES[2].seededStarterKey

beforeAll(async () => {
  if (!db.enabled) return

  drizzleDb = drizzle(db.pool(), { schema })

  userId = randomUUID()
  otherUserId = randomUUID()

  for (const [id, email] of [
    [userId, "seeded@example.com"],
    [otherUserId, "other@example.com"],
  ] as const) {
    await db.query(
      `INSERT INTO users (id, email, email_normalized, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [id, email, email, UNUSABLE_PASSWORD_HASH]
    )
  }
})

beforeEach(async () => {
  if (!db.enabled) return

  await db.query(`TRUNCATE report_template_versions, report_templates CASCADE`)
})

// --- Queries ---------------------------------------------------------------

interface TemplateRow {
  readonly id: string
  readonly user_id: string
  readonly name: string
  readonly description: string
  readonly current_version_id: string | null
  readonly draft_definition: unknown
  readonly seeded_starter_key: string | null
}

async function templatesFor(owner: string): Promise<readonly TemplateRow[]> {
  const result = await db.query<TemplateRow>(
    `SELECT * FROM report_templates WHERE user_id = $1
      ORDER BY created_at, seeded_starter_key`,
    [owner]
  )
  return result.rows
}

interface VersionRow {
  readonly id: string
  readonly template_id: string
  readonly version: number
  readonly definition: unknown
  readonly definition_sha256: string
}

async function versionsFor(owner: string): Promise<readonly VersionRow[]> {
  const result = await db.query<VersionRow>(
    `SELECT v.* FROM report_template_versions v
       JOIN report_templates t ON t.id = v.template_id
      WHERE t.user_id = $1
      ORDER BY t.seeded_starter_key, v.version`,
    [owner]
  )
  return result.rows
}

async function totalTemplateRows(): Promise<number> {
  const result = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM report_templates`
  )
  return Number(result.rows[0].n)
}

async function totalVersionRows(): Promise<number> {
  const result = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM report_template_versions`
  )
  return Number(result.rows[0].n)
}

/**
 * Make the insert of one starter raise, from inside the database.
 *
 * A trigger rather than a stubbed client: the claim under test is that Postgres
 * rolled back the two starters that had already been inserted in the same
 * transaction, and a fake that threw before reaching the database would assert
 * nothing about that.
 */
async function failInsertOfStarter(key: string): Promise<void> {
  await db.query(
    `CREATE OR REPLACE FUNCTION fail_on_starter() RETURNS trigger AS $$
     BEGIN
       IF NEW.seeded_starter_key = '${key}' THEN
         RAISE EXCEPTION 'forced mid-seed failure';
       END IF;
       RETURN NEW;
     END $$ LANGUAGE plpgsql`
  )
  await db.query(
    `CREATE TRIGGER fail_on_starter_trg BEFORE INSERT ON report_templates
       FOR EACH ROW EXECUTE FUNCTION fail_on_starter()`
  )
}

async function removeStarterFailure(): Promise<void> {
  await db.query(
    `DROP TRIGGER IF EXISTS fail_on_starter_trg ON report_templates`
  )
  await db.query(`DROP FUNCTION IF EXISTS fail_on_starter()`)
}

// --- Requirement 10.2 — what a fresh account gets --------------------------

describe("Requirement 10.2 — seeding a fresh account", () => {
  test("inserts three templates, three version-1 rows, and points each at its version", async () => {
    const outcome = await seedStarterTemplates(userId)

    expect(outcome).toStrictEqual({
      ok: true,
      inserted: STARTER_TEMPLATE_COUNT,
    })

    const templates = await templatesFor(userId)
    expect(templates).toHaveLength(STARTER_TEMPLATE_COUNT)

    // Requirement 10.2 — one row per starter, carrying this user's id and the
    // starter's persisted key.
    expect(templates.map((row) => row.seeded_starter_key).sort()).toEqual(
      [...STARTER_KEYS].sort()
    )
    expect(new Set(templates.map((row) => row.user_id))).toEqual(
      new Set([userId])
    )

    const versions = await versionsFor(userId)
    expect(versions).toHaveLength(STARTER_TEMPLATE_COUNT)

    for (const starter of STARTER_TEMPLATES) {
      const template = templates.find(
        (row) => row.seeded_starter_key === starter.seededStarterKey
      )
      expect(template, starter.seededStarterKey).toBeDefined()

      const version = versions.find((row) => row.template_id === template!.id)
      expect(version, starter.seededStarterKey).toBeDefined()

      // `version` 1, always — a starter has no earlier version to sequence from.
      expect(version!.version, starter.seededStarterKey).toBe(1)

      // The canonical digest of the definition that was actually stored, computed
      // through the same function a wizard-authored version uses (Req 9.4).
      //
      // Compared against the STORED definition rather than against
      // `starter.definition`: seeding fills each section's `metrics` from the
      // catalogue's default preset (`withPresetMetrics`), because `starters.ts`
      // cannot expand it — both catalogues are `server-only` and that module is
      // deliberately client-safe. Asserting digest-matches-row is the real
      // invariant anyway; asserting digest-matches-a-constant only held while the
      // stored definition happened to be that constant.
      expect(version!.definition_sha256, starter.seededStarterKey).toBe(
        definitionSha256(version!.definition as never)
      )

      // Everything except `metrics` is the starter verbatim.
      const storedSections = (
        version!.definition as unknown as {
          sections: readonly Record<string, unknown>[]
        }
      ).sections
      const starterSections = (
        starter.definition as unknown as {
          sections: readonly Record<string, unknown>[]
        }
      ).sections

      expect(storedSections, starter.seededStarterKey).toHaveLength(
        starterSections.length
      )
      storedSections.forEach((stored, index) => {
        const { metrics: _stored, ...storedRest } = stored
        const { metrics: _starter, ...starterRest } = starterSections[index]!
        expect(
          storedRest,
          `${starter.seededStarterKey}[${index}]`
        ).toStrictEqual(JSON.parse(JSON.stringify(starterRest)))
      })

      // Requirement 10.3 — every section that BEARS metrics and whose default
      // preset expands to something carries concrete metrics. Every starter wrote
      // `metrics: []` for every section before this, so no starter with a
      // utilization section could produce a report: no metric requested means no
      // statistic collected, and the run fails NO_STATISTICS.
      //
      // Scoped per section rather than per starter: `executive_summary` is composed
      // only of `azure_subscription` and `coverage_and_verification`, both
      // `metric_bearing: false`, so seeding no metrics there is correct rather than
      // a miss.
      for (const [index, section] of storedSections.entries()) {
        const entry =
          typeof section.type === "string"
            ? sectionByKey(section.type)
            : undefined
        if (entry === undefined || !entry.metric_bearing) continue
        if (
          expandPreset(entry, DEFAULT_PRESET_NAME, METRIC_CATALOG).length === 0
        ) {
          // A known catalogue defect for `app_service_and_storage` — see
          // `test/preset-expansion.test.ts`, which pins it by name.
          continue
        }

        expect(
          section.metrics,
          `${starter.seededStarterKey}[${index}] (${String(section.type)}) seeded no metrics`
        ).not.toStrictEqual([])
      }

      // Requirement 10.2 — `current_version_id` names that row, so a seeded
      // starter is immediately runnable rather than a template with no version.
      expect(template!.current_version_id, starter.seededStarterKey).toBe(
        version!.id
      )

      // Name and description come off the definition's own identity, so the row
      // and the version it pins cannot disagree about what the template is.
      expect(template!.name).toBe(starter.definition.identity.name)
      expect(template!.description).toBe(
        starter.definition.identity.description ?? ""
      )

      // A seeded starter is an editable template, not a draft in progress.
      expect(template!.draft_definition).toBeNull()
    }
  })

  test("seeding one user leaves another user unseeded", async () => {
    // The `user_id` scoping, from the other direction: the UNIQUE is per user, so
    // one account's seeding must neither block nor populate another's.
    await seedStarterTemplates(userId)

    expect(await templatesFor(otherUserId)).toEqual([])

    const outcome = await seedStarterTemplates(otherUserId)

    expect(outcome).toStrictEqual({
      ok: true,
      inserted: STARTER_TEMPLATE_COUNT,
    })
    expect(await templatesFor(otherUserId)).toHaveLength(STARTER_TEMPLATE_COUNT)
    expect(await totalTemplateRows()).toBe(STARTER_TEMPLATE_COUNT * 2)
  })

  test("readSeededStarterKeys reports exactly the three keys", async () => {
    // The detection surface the `/templates` notice reads (task 13.2): the row,
    // not a flash, so a refresh gives the same answer.
    expect(await readSeededStarterKeys(userId)).toEqual([])

    await seedStarterTemplates(userId)

    expect([...(await readSeededStarterKeys(userId))].sort()).toEqual(
      [...STARTER_KEYS].sort()
    )

    // An authored template carries no starter key, so it does not inflate the set.
    await createTemplate(userId, { name: "Authored by hand" })

    expect(await readSeededStarterKeys(userId)).toHaveLength(
      STARTER_TEMPLATE_COUNT
    )
  })
})

// --- Requirements 10.4, 10.7 — a repeated request inserts nothing ----------

describe("Requirements 10.4, 10.7 — a repeated seeding inserts nothing", () => {
  test("a second call for the same user creates no duplicate", async () => {
    await seedStarterTemplates(userId)

    const before = await templatesFor(userId)
    const versionsBefore = await versionsFor(userId)

    // Requirement 10.7's retried registration.
    const second = await seedStarterTemplates(userId)

    expect(second).toStrictEqual({
      ok: true,
      inserted: 0,
      reason: "already_initialized",
    })

    const after = await templatesFor(userId)

    // Byte-identical rows, not merely the same count: a re-insert that replaced
    // a row would keep the count and change the id.
    expect(after).toStrictEqual(before)
    expect(await versionsFor(userId)).toStrictEqual(versionsBefore)
    expect(await totalTemplateRows()).toBe(STARTER_TEMPLATE_COUNT)
    expect(await totalVersionRows()).toBe(STARTER_TEMPLATE_COUNT)
  })

  test("a deleted starter is not resurrected by a later call", async () => {
    // Requirement 10.7. A consultant deletes a seeded starter as they would any
    // other template, and no replacement starter is inserted for that user.
    await seedStarterTemplates(userId)

    const deleted = (await templatesFor(userId)).find(
      (row) => row.seeded_starter_key === THIRD_STARTER_KEY
    )
    expect(deleted).toBeDefined()

    // `current_version_id` references the version row, so the pointer is
    // released before the version is deleted — the same three statements a
    // `deleteTemplate` action will have to issue (task 13.1), in the same order.
    await db.query(
      `UPDATE report_templates SET current_version_id = NULL WHERE id = $1`,
      [deleted!.id]
    )
    await db.query(
      `DELETE FROM report_template_versions WHERE template_id = $1`,
      [deleted!.id]
    )
    await db.query(`DELETE FROM report_templates WHERE id = $1`, [deleted!.id])

    const remaining = await templatesFor(userId)
    expect(remaining).toHaveLength(STARTER_TEMPLATE_COUNT - 1)

    const later = await seedStarterTemplates(userId)

    expect(later).toStrictEqual({
      ok: true,
      inserted: 0,
      reason: "already_initialized",
    })

    // The deleted starter stays deleted, and the two survivors are untouched.
    expect(await templatesFor(userId)).toStrictEqual(remaining)
    expect(
      (await readSeededStarterKeys(userId)).includes(THIRD_STARTER_KEY)
    ).toBe(false)
  })

  test("two concurrent seedings of one account produce exactly three starters", async () => {
    // Requirement 10.4's own case, and the reason the `ON CONFLICT` clause exists
    // rather than only the pre-check: both transactions read an empty template
    // set, so neither can decline. The unique index settles it — the loser's
    // insert becomes a no-op, `RETURNING` yields no row, and its version is not
    // inserted either.
    const [first, second] = await Promise.all([
      seedStarterTemplates(userId),
      seedStarterTemplates(userId),
    ])

    expect(first.ok, JSON.stringify(first)).toBe(true)
    expect(second.ok, JSON.stringify(second)).toBe(true)

    const inserted = [first, second].map((outcome) =>
      outcome.ok ? outcome.inserted : -1
    )

    // One of them did the work; the other inserted nothing. Never six.
    expect(inserted.reduce((sum, count) => sum + count, 0)).toBe(
      STARTER_TEMPLATE_COUNT
    )

    expect(await templatesFor(userId)).toHaveLength(STARTER_TEMPLATE_COUNT)
    expect(await versionsFor(userId)).toHaveLength(STARTER_TEMPLATE_COUNT)

    // Every surviving starter still names its own version.
    for (const row of await templatesFor(userId)) {
      expect(
        row.current_version_id,
        row.seeded_starter_key ?? ""
      ).not.toBeNull()
    }
  })
})

// --- Requirement 10.6 — all three, or none --------------------------------

describe("Requirement 10.6 — a failure part-way through retains nothing", () => {
  test("a forced failure on the third starter leaves zero template and zero version rows", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      await failInsertOfStarter(THIRD_STARTER_KEY)

      const outcome = await seedStarterTemplates(userId)

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        // Requirement 10.6's statement, and the class of failure — never the
        // driver's message, whose parameters carry the whole definition.
        expect(outcome.message).toBe(STARTERS_UNINITIALIZED_NOTICE)
        expect(outcome.code).toMatch(/^[0-9A-Z]{5}$/)
      }

      // **The assertion this test exists for.** The first two starters were
      // inserted before the trigger raised, so anything other than zero here
      // means the three do not share one transaction.
      expect(await templatesFor(userId)).toEqual([])
      expect(await versionsFor(userId)).toEqual([])
      expect(await totalTemplateRows()).toBe(0)
      expect(await totalVersionRows()).toBe(0)

      // The failure is recorded server-side — the authoritative signal, since the
      // registration that triggered it redirects and cannot render a message.
      expect(logged).toHaveBeenCalled()
      expect(String(logged.mock.calls[0][0])).toContain("[starters]")
    } finally {
      await removeStarterFailure()
      logged.mockRestore()
    }
  })

  test("the trigger is not vacuous — with it removed the same call succeeds", async () => {
    // Non-vacuity for the rollback assertion: zero rows is also what a seeder
    // that inserted nothing at all would leave, so the identical call is run once
    // more without the trigger and asserted to insert all three.
    await failInsertOfStarter(THIRD_STARTER_KEY)
    await removeStarterFailure()

    expect(await seedStarterTemplates(userId)).toStrictEqual({
      ok: true,
      inserted: STARTER_TEMPLATE_COUNT,
    })
    expect(await templatesFor(userId)).toHaveLength(STARTER_TEMPLATE_COUNT)
  })

  test("a user whose seeding failed can still author a template", async () => {
    // The second half of Requirement 10.6. The rollback undoes the starters and
    // nothing else, so the wizard's own create path is unaffected.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      await failInsertOfStarter(THIRD_STARTER_KEY)

      expect((await seedStarterTemplates(userId)).ok).toBe(false)
    } finally {
      await removeStarterFailure()
      logged.mockRestore()
    }

    const authored = await createTemplate(userId, { name: "Authored by hand" })

    expect(authored.userId).toBe(userId)
    expect(authored.seededStarterKey).toBeNull()
    expect(await templatesFor(userId)).toHaveLength(1)
  })
})
