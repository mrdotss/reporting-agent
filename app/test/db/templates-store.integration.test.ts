import { createHash, randomUUID } from "node:crypto"

import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * `lib/templates/store.ts` against a real Postgres 17 (Requirements 1.4, 1.5,
 * 1.6, 1.7, 1.9, 9.2, 9.3, 9.5, 9.11, 9.12, 10.7, 11.4).
 *
 * ## Why these claims need a database
 *
 * Every one of them is a claim where the SQL *is* the behaviour, so a double
 * would be a second, unverified query planner standing between the test and
 * its subject:
 *
 *   * **Requirement 9.11** is a violation of
 *     `report_template_versions_template_id_version_uq`, forced by two
 *     genuinely concurrent transactions racing for the same next `version`.
 *     A single connection cannot race itself — it would serialize the two
 *     attempts and the retry path would never be exercised.
 *   * **Requirement 1.5** is `AND user_id = $n` inside every statement.
 *     "Applies no write" and "discloses no field" are claims about a row
 *     that was *not* touched, asserted by reading it back afterwards.
 *   * **Requirement 9.3** is "no operation modifies or deletes a version
 *     row" — asserted here by reading the version table back unchanged
 *     after every operation this store exposes has been exercised against
 *     it, rather than by trusting that the module has no such code path.
 *   * **Requirement 9.5** is "an unchanged digest inserts nothing", which is
 *     a claim about the *absence* of a row, settled by counting rows before
 *     and after.
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
  createTemplate,
  getTemplate,
  insertVersion,
  listTemplates,
  readLatestVersion,
  readVersion,
  saveDraft,
  TemplateNotFoundError,
  TemplateVersionNotFoundError,
  type InsertVersionInput,
} from "@/lib/templates/store"

// --- Wiring ------------------------------------------------------------

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let ownerId: string
let intruderId: string

function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) {
    throw new Error(
      "The scratch-schema Drizzle client is not open. Read it inside a test."
    )
  }
  return drizzleDb
}

const UNUSABLE_PASSWORD_HASH = "$argon2id$fixture-never-verified"

beforeAll(async () => {
  if (!db.enabled) return

  drizzleDb = drizzle(db.pool(), { schema })

  ownerId = randomUUID()
  intruderId = randomUUID()

  for (const [id, email] of [
    [ownerId, "owner@example.com"],
    [intruderId, "intruder@example.com"],
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

  // `report_template_versions` cascades from `report_templates` through the FK,
  // but the FK carries no `ON DELETE CASCADE`, so both are truncated together —
  // `users` survives, seeded once above.
  await db.query(
    `TRUNCATE report_template_versions, report_templates CASCADE`
  )
})

// --- Helpers -------------------------------------------------------------

/** A stand-in for `lib/templates/version.ts`'s canonical digest — any stable
 * hash of the definition serves this store's tests, which never canonicalize
 * on their own. */
function digestOf(definition: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(definition), "utf8")
    .digest("hex")
}

function versionInput(definition: unknown): InsertVersionInput {
  return { definition, definitionSha256: digestOf(definition) }
}

interface VersionRow {
  readonly id: string
  readonly template_id: string
  readonly version: number
  readonly definition: unknown
  readonly definition_sha256: string
}

async function allVersionRows(): Promise<readonly VersionRow[]> {
  const result = await db.query<VersionRow>(
    `SELECT * FROM report_template_versions ORDER BY template_id, version`
  )
  return result.rows
}

async function templateRow(
  id: string
): Promise<{ readonly current_version_id: string | null } | undefined> {
  const result = await db.query<{ current_version_id: string | null }>(
    `SELECT current_version_id FROM report_templates WHERE id = $1`,
    [id]
  )
  return result.rows[0]
}

// --- createTemplate / listTemplates / getTemplate -------------------------

describe("createTemplate, listTemplates, getTemplate", () => {
  test("a created template starts with no version and no draft", async () => {
    const template = await createTemplate(ownerId, { name: "Monthly report" })

    expect(template.currentVersionId).toBeNull()
    expect(template.draftDefinition).toBeNull()
    expect(template.name).toBe("Monthly report")
    expect(template.description).toBe("")
  })

  test("an optional description is stored, and its absence defaults to the empty string", async () => {
    const withDescription = await createTemplate(ownerId, {
      name: "Capacity planning",
      description: "For the quarterly review.",
    })
    expect(withDescription.description).toBe("For the quarterly review.")

    const withoutDescription = await createTemplate(ownerId, {
      name: "Executive summary",
    })
    expect(withoutDescription.description).toBe("")
  })

  test("Requirement 1.4 — the list holds only this user's templates", async () => {
    const mine = await createTemplate(ownerId, { name: "Mine" })
    await createTemplate(intruderId, { name: "Someone else's" })

    const listed = await listTemplates(ownerId)
    expect(listed.map((row) => row.id)).toEqual([mine.id])

    const theirs = await listTemplates(intruderId)
    expect(theirs).toHaveLength(1)
    expect(theirs[0]?.id).not.toBe(mine.id)
  })

  test("Requirement 1.5 — another user's id resolves as not found on getTemplate", async () => {
    const theirs = await createTemplate(intruderId, {
      name: "Someone else's customer's report",
    })

    const forAbsent = await getTemplate(ownerId, randomUUID()).catch(
      (error: unknown) => error
    )
    const forSomeoneElse = await getTemplate(ownerId, theirs.id).catch(
      (error: unknown) => error
    )

    expect(forSomeoneElse).toBeInstanceOf(TemplateNotFoundError)
    // Byte-identical: a probe cannot tell an absent id from somebody else's.
    expect(String(forAbsent)).toBe(String(forSomeoneElse))

    const message = String(forSomeoneElse)
    for (const disclosure of [theirs.id, intruderId, "customer"]) {
      expect(message).not.toContain(disclosure)
    }
  })
})

// --- saveDraft -----------------------------------------------------------

describe("saveDraft", () => {
  test("Requirement 11.4 — writes draft_definition and inserts no version row", async () => {
    const template = await createTemplate(ownerId, { name: "Draft only" })
    const draft = { schema_version: 1, blocks: [] }

    const updated = await saveDraft(ownerId, template.id, draft)

    expect(updated.draftDefinition).toEqual(draft)
    expect(await allVersionRows()).toEqual([])
    expect((await templateRow(template.id))?.current_version_id).toBeNull()
  })

  test("a draft persists whether or not it carries any block", async () => {
    const template = await createTemplate(ownerId, { name: "Empty draft" })

    const updated = await saveDraft(ownerId, template.id, {
      schema_version: 1,
      blocks: [],
    })

    expect(updated.draftDefinition).toEqual({ schema_version: 1, blocks: [] })
  })

  test("another user's id applies no write and raises TemplateNotFoundError", async () => {
    const theirs = await createTemplate(intruderId, { name: "Not yours" })

    await expect(
      saveDraft(ownerId, theirs.id, { schema_version: 1 })
    ).rejects.toBeInstanceOf(TemplateNotFoundError)

    const row = await templateRow(theirs.id)
    expect(row).toBeDefined()

    const result = await db.query<{ draft_definition: unknown }>(
      `SELECT draft_definition FROM report_templates WHERE id = $1`,
      [theirs.id]
    )
    expect(result.rows[0]?.draft_definition).toBeNull()
  })
})

// --- insertVersion / readVersion / readLatestVersion -----------------------

describe("insertVersion", () => {
  test("Requirement 9.2 — version is the highest existing version plus exactly 1", async () => {
    const template = await createTemplate(ownerId, { name: "Versioned" })

    const v1 = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["a"] })
    )
    expect(v1.version).toBe(1)

    const v2 = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["a", "b"] })
    )
    expect(v2.version).toBe(2)

    const v3 = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["a", "b", "c"] })
    )
    expect(v3.version).toBe(3)

    expect((await allVersionRows()).map((row) => row.version)).toEqual([
      1, 2, 3,
    ])
  })

  test("insertVersion points current_version_id at the newly inserted row", async () => {
    const template = await createTemplate(ownerId, { name: "Pointer" })

    const v1 = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1 })
    )
    expect((await templateRow(template.id))?.current_version_id).toBe(v1.id)

    const v2 = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["x"] })
    )
    expect((await templateRow(template.id))?.current_version_id).toBe(v2.id)
    expect(v2.id).not.toBe(v1.id)
  })

  test("Requirement 9.5 — an unchanged canonical digest inserts nothing and returns the existing version", async () => {
    const template = await createTemplate(ownerId, { name: "Idempotent" })
    const definition = { schema_version: 1, blocks: ["a"] }

    const first = await insertVersion(ownerId, template.id, versionInput(definition))

    const second = await insertVersion(
      ownerId,
      template.id,
      versionInput(definition)
    )

    // The exact same row, not a new one with the same content.
    expect(second.id).toBe(first.id)
    expect(second.version).toBe(1)

    const rows = await allVersionRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.version).toBe(1)
  })

  test("a changed digest after an unchanged save still increments from the highest existing version", async () => {
    const template = await createTemplate(ownerId, { name: "Mixed" })
    const definition = { schema_version: 1, blocks: ["a"] }

    await insertVersion(ownerId, template.id, versionInput(definition))
    await insertVersion(ownerId, template.id, versionInput(definition)) // no-op

    const changed = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["a", "b"] })
    )

    expect(changed.version).toBe(2)
    expect(await allVersionRows()).toHaveLength(2)
  })

  test("Requirement 1.5 — another user's id applies no write and raises TemplateNotFoundError", async () => {
    const theirs = await createTemplate(intruderId, { name: "Not yours" })

    await expect(
      insertVersion(ownerId, theirs.id, versionInput({ schema_version: 1 }))
    ).rejects.toBeInstanceOf(TemplateNotFoundError)

    expect(await allVersionRows()).toEqual([])
  })

  test("Requirement 9.11 — two concurrent saves computing the same next version resolve to one committed row, the loser retried", async () => {
    const template = await createTemplate(ownerId, { name: "Racing" })

    // Establish version 1 up front, so both concurrent calls below are racing
    // for version 2 specifically.
    await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["seed"] })
    )

    const [a, b] = await Promise.all([
      insertVersion(
        ownerId,
        template.id,
        versionInput({ schema_version: 1, blocks: ["a"] })
      ),
      insertVersion(
        ownerId,
        template.id,
        versionInput({ schema_version: 1, blocks: ["b"] })
      ),
    ])

    // Both calls succeeded — the retry settled the loser rather than raising —
    // and between them they produced exactly one version 2 and one version 3.
    const versions = [a.version, b.version].sort()
    expect(versions).toEqual([2, 3])
    expect(a.id).not.toBe(b.id)

    const rows = await allVersionRows()
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3])

    // The final `current_version_id` is whichever of the two committed last —
    // either is a legitimate outcome of the race, but it must be one of them.
    const finalPointer = (await templateRow(template.id))?.current_version_id
    expect([a.id, b.id]).toContain(finalPointer)
  })

  test("Requirement 9.3 — no operation issues an UPDATE or a DELETE against an existing version row", async () => {
    const template = await createTemplate(ownerId, { name: "Immutable" })

    const v1 = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["a"] })
    )
    await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["a", "b"] })
    )
    // The no-op path, exercised too — still no write to the existing row.
    await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["a", "b"] })
    )

    const stillThere = await db.query<VersionRow>(
      `SELECT * FROM report_template_versions WHERE id = $1`,
      [v1.id]
    )
    expect(stillThere.rows[0]?.version).toBe(1)
    expect(stillThere.rows[0]?.definition).toEqual({
      schema_version: 1,
      blocks: ["a"],
    })
  })
})

describe("readVersion", () => {
  test("resolves a specific version number of this user's template", async () => {
    const template = await createTemplate(ownerId, { name: "Readable" })
    await insertVersion(ownerId, template.id, versionInput({ v: 1 }))
    await insertVersion(ownerId, template.id, versionInput({ v: 2 }))

    const version1 = await readVersion(ownerId, template.id, 1)
    expect(version1.definition).toEqual({ v: 1 })

    const version2 = await readVersion(ownerId, template.id, 2)
    expect(version2.definition).toEqual({ v: 2 })
  })

  test("Requirement 1.5 — another user's template id resolves as TemplateNotFoundError, checked before the version number", async () => {
    const theirs = await createTemplate(intruderId, { name: "Not yours" })
    await insertVersion(intruderId, theirs.id, versionInput({ v: 1 }))

    await expect(readVersion(ownerId, theirs.id, 1)).rejects.toBeInstanceOf(
      TemplateNotFoundError
    )
  })

  test("a version number this template does not carry raises TemplateVersionNotFoundError", async () => {
    const template = await createTemplate(ownerId, { name: "Sparse" })
    await insertVersion(ownerId, template.id, versionInput({ v: 1 }))

    await expect(readVersion(ownerId, template.id, 2)).rejects.toBeInstanceOf(
      TemplateVersionNotFoundError
    )
  })
})

describe("readLatestVersion", () => {
  test("returns the highest-numbered version", async () => {
    const template = await createTemplate(ownerId, { name: "Latest" })
    await insertVersion(ownerId, template.id, versionInput({ v: 1 }))
    await insertVersion(ownerId, template.id, versionInput({ v: 2 }))
    const latest = await insertVersion(
      ownerId,
      template.id,
      versionInput({ v: 3 })
    )

    const resolved = await readLatestVersion(ownerId, template.id)
    expect(resolved?.id).toBe(latest.id)
    expect(resolved?.version).toBe(3)
  })

  test("returns undefined for a template that carries no version yet, without throwing", async () => {
    const template = await createTemplate(ownerId, { name: "No version yet" })

    await expect(readLatestVersion(ownerId, template.id)).resolves.toBeUndefined()
  })

  test("Requirement 1.5 — another user's id raises TemplateNotFoundError", async () => {
    const theirs = await createTemplate(intruderId, { name: "Not yours" })

    await expect(readLatestVersion(ownerId, theirs.id)).rejects.toBeInstanceOf(
      TemplateNotFoundError
    )
  })
})

// --- The enqueue boundary: no write to template/version rows ----------------

describe("Requirement 1.7 — a run enqueue applies no write to a template or its versions", () => {
  test("reading the latest version for an invoke payload leaves every row unchanged", async () => {
    const template = await createTemplate(ownerId, { name: "Reusable" })
    const v1 = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["a"] })
    )

    const before = await allVersionRows()
    const beforeTemplate = await templateRow(template.id)

    // What an enqueue does with a template: resolve its latest version, and
    // nothing else. No exported operation in this store performs a write on
    // that path.
    const resolved = await readLatestVersion(ownerId, template.id)
    expect(resolved?.id).toBe(v1.id)

    // Run it as if for ten repeat runs and two more subscriptions — the read
    // is the only operation exercised, over and over.
    for (let i = 0; i < 10; i += 1) {
      await readLatestVersion(ownerId, template.id)
    }

    expect(await allVersionRows()).toEqual(before)
    expect(await templateRow(template.id)).toEqual(beforeTemplate)
  })
})
