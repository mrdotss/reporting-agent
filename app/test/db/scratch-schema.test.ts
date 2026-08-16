import { describe, expect, test } from "vitest"

import {
  MISSING_TEST_DATABASE_MESSAGE,
  MISSING_TEST_DATABASE_NOTE,
  scratchSchemaName,
  splitStatements,
  TEST_DATABASE_URL_VAR,
  withScratchSchema,
} from "@/test/db/scratch-schema"

/**
 * Self-tests for the integration-test harness, in the same spirit as
 * `test/harness.test.ts`: if the mechanism the later database suites stand on
 * stops holding, this file says so rather than every one of those suites failing
 * for an unrelated-looking reason.
 *
 * The first two groups need no Postgres. The third does, and is the suite whose
 * skip is the developer-facing signal that `TEST_DATABASE_URL` is unset.
 */

// --- Naming ---------------------------------------------------------------

/** `NAMEDATALEN - 1`. Postgres truncates past this without complaining. */
const MAX_IDENTIFIER_LENGTH = 63

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/

describe("scratchSchemaName", () => {
  test("two calls with one label never collide", () => {
    const names = new Set(
      Array.from({ length: 500 }, () => scratchSchemaName("same-label"))
    )

    // Parallel Vitest workers do not share module state, so uniqueness has to
    // come from randomness rather than from a counter.
    expect(names.size).toBe(500)
  })

  const labels: readonly (string | undefined)[] = [
    undefined,
    "",
    "   ",
    "a",
    "0000_leading_digits",
    "-----",
    "Ünïcödé Ñäme",
    "报告",
    "file:///home/dev/app/test/runs/claim.integration.test.ts",
    "/home/dev/app/lib/db/index.test.ts",
    "test/db/A-Very.Long_File-Name.That.Goes.On.And.On.And.On.And.On.Forever.test.ts",
    "x".repeat(500),
  ]

  test.each(labels)("%j yields a legal, in-budget identifier", (label) => {
    const name = scratchSchemaName(label)

    expect(name).toMatch(SAFE_IDENTIFIER)
    expect(name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH)
    expect(name.startsWith("rpt_test_")).toBe(true)
  })

  test("a long label is truncated rather than colliding after truncation", () => {
    // Same 200-character prefix, different tails: truncation alone would map
    // both to one schema, and two suites would then share state silently.
    const shared = "z".repeat(200)
    const first = scratchSchemaName(`${shared}_alpha.test.ts`)
    const second = scratchSchemaName(`${shared}_beta.test.ts`)

    expect(first.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH)
    expect(second.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH)
    expect(first).not.toBe(second)
  })

  test("a file URL is traceable to the file that created it", () => {
    // The point of the slug: a schema left behind by a crashed run names the
    // suite to blame. Only the final extension is dropped, so
    // `claim.integration.test.ts` stays distinguishable from `claim.test.ts`.
    expect(
      scratchSchemaName("file:///home/dev/app/test/runs/claim.test.ts")
    ).toMatch(/^rpt_test_claim_test_[0-9a-f]{10}$/)
    expect(
      scratchSchemaName(
        "file:///home/dev/app/test/runs/claim.integration.test.ts"
      )
    ).toMatch(/^rpt_test_claim_integration_test_[0-9a-f]{10}$/)
  })
})

// --- Splitting a generated migration --------------------------------------

describe("splitStatements", () => {
  test("splits on drizzle's breakpoint, not on semicolons", () => {
    const sql = [
      `CREATE TABLE "users" (`,
      `\t"id" uuid PRIMARY KEY NOT NULL,`,
      `\t"email" text NOT NULL`,
      `);`,
      `--> statement-breakpoint`,
      `CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");`,
    ].join("\n")

    expect(splitStatements(sql)).toHaveLength(2)
  })

  test("a semicolon inside a string literal is not a boundary", () => {
    // The reason `;` is the wrong separator: this is one statement, and a naive
    // split would hand the server two syntax errors instead.
    const sql =
      `ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_error_code_ck" ` +
      `CHECK ("error_code" IN ('TIMEOUT', 'a;b', 'EMPTY_SCOPE'));`

    const statements = splitStatements(sql)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain("'a;b'")
  })

  test("a semicolon inside a dollar-quoted body is not a boundary", () => {
    const sql = [
      `CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$`,
      `BEGIN`,
      `  NEW.updated_at := now();`,
      `  RETURN NEW;`,
      `END;`,
      `$$ LANGUAGE plpgsql;`,
    ].join("\n")

    const statements = splitStatements(sql)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain("RETURN NEW;")
  })

  test("blank chunks and a trailing breakpoint yield no empty statement", () => {
    const sql = [
      `CREATE TABLE "a" ("id" integer);`,
      `--> statement-breakpoint`,
      ``,
      `--> statement-breakpoint`,
      `CREATE TABLE "b" ("id" integer);`,
      `--> statement-breakpoint`,
      ``,
    ].join("\n")

    const statements = splitStatements(sql)

    expect(statements).toHaveLength(2)
    expect(statements.every((statement) => statement.length > 0)).toBe(true)
  })

  test("CRLF line endings still separate statements", () => {
    // A committed .sql file checked out on Windows arrives with CRLF, and the
    // marker has to be found anyway.
    const sql =
      `CREATE TABLE "a" ("id" integer);\r\n` +
      `--> statement-breakpoint\r\n` +
      `CREATE TABLE "b" ("id" integer);\r\n`

    expect(splitStatements(sql)).toHaveLength(2)
  })

  test("a file holding no statements yields none", () => {
    expect(splitStatements("")).toEqual([])
    expect(splitStatements("\n\n   \n")).toEqual([])
  })
})

// --- The skip message -----------------------------------------------------

describe("the missing-database skip", () => {
  test("the message names the variable, the script and the URL to export", () => {
    // A skip that does not say what to do sends a developer looking for a
    // connection bug that is not there.
    expect(MISSING_TEST_DATABASE_MESSAGE).toContain(TEST_DATABASE_URL_VAR)
    expect(MISSING_TEST_DATABASE_MESSAGE).toContain("pnpm test:db:up")
    expect(MISSING_TEST_DATABASE_MESSAGE).toContain("pnpm test:db:down")
    expect(MISSING_TEST_DATABASE_MESSAGE).toContain("docker-compose.test.yml")
    expect(MISSING_TEST_DATABASE_MESSAGE).toContain(
      "postgresql://rpt_test:rpt_test@127.0.0.1:55432/rpt_test"
    )
  })

  test("the per-test note names the variable and the script", () => {
    // The note rides on each skipped test in the report, so it has to carry the
    // actionable pair on its own.
    expect(MISSING_TEST_DATABASE_NOTE).toContain(TEST_DATABASE_URL_VAR)
    expect(MISSING_TEST_DATABASE_NOTE).toContain("pnpm test:db:up")
  })
})

// --- The harness against a real Postgres ----------------------------------

/**
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset. When it is set this is the
 * suite that proves the harness itself: a schema is created, the pool is bound
 * to it on *every* connection, and the schema is dropped afterwards.
 *
 * It creates its own table rather than relying on a migration, so it is valid
 * both before and after task 2.1 generates the first one.
 */
describe("a scratch schema", () => {
  const db = withScratchSchema(import.meta.url)

  test("the pool resolves unqualified names inside the scratch schema", async () => {
    await db.query(`CREATE TABLE harness_probe (id integer PRIMARY KEY)`)
    await db.query(`INSERT INTO harness_probe (id) VALUES (1), (2)`)

    const rows = await db.query<{ id: number }>(
      `SELECT id FROM harness_probe ORDER BY id`
    )
    expect(rows.rows.map(({ id }) => id)).toEqual([1, 2])

    const located = await db.query<{ schemaname: string }>(
      `SELECT schemaname FROM pg_tables WHERE tablename = 'harness_probe'`
    )
    expect(located.rows.map(({ schemaname }) => schemaname)).toEqual([
      db.schemaName,
    ])
  })

  test("two simultaneously checked-out clients both see the scratch schema", async () => {
    // The `SKIP LOCKED` proof in task 13.7 needs two connections open at the
    // same instant, and a `SET search_path` on one of them says nothing about
    // the other. Hold both at once rather than in sequence, because a
    // sequential check would pass against a pool of size one.
    const [first, second] = await Promise.all([
      db.pool().connect(),
      db.pool().connect(),
    ])

    try {
      expect(first).not.toBe(second)

      const paths = await Promise.all(
        [first, second].map(async (client) => {
          const result = await client.query<{ search_path: string }>(
            `SHOW search_path`
          )
          return result.rows[0]?.search_path
        })
      )

      expect(paths).toEqual([db.schemaName, db.schemaName])
    } finally {
      first.release()
      second.release()
    }
  })
})
