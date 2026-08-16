import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  Client,
  escapeIdentifier,
  Pool,
  type QueryResult,
  type QueryResultRow,
} from "pg"
import { afterAll, beforeAll, beforeEach } from "vitest"

/**
 * The integration-test database harness.
 *
 * A test file calls `withScratchSchema(import.meta.url)` once, at module scope,
 * and gets back a handle carrying a real `pg.Pool`. Around it this module
 * registers the hooks that make the file's tests isolated:
 *
 *   beforeAll  — create a uniquely named schema, open the pool bound to it, and
 *                apply every migration in `lib/db/migrations` into it
 *   afterAll   — end the pool and `DROP SCHEMA ... CASCADE`, whether the tests
 *                passed or failed
 *
 * Two consequences worth stating, because they are the reasons for the design
 * rather than incidental details.
 *
 * **A pool, not a client.** The reaper claims work with `FOR UPDATE SKIP LOCKED`
 * (Req 39.4) and the property that matters is that two overlapping requests
 * claim *disjoint* sets (Req 39.5). Proving that needs two transactions open at
 * the same instant. A single connection cannot race itself — it would serialize
 * the two transactions and the assertion would hold without the lock ever being
 * exercised, which is a test that passes for the wrong reason. Hence a pool, and
 * hence `MIN_POOL_SIZE`.
 *
 * **A schema per file, dropped afterwards.** Files share no state, so they
 * depend on no ordering, and a failing run leaves no rows behind for the next
 * one to trip over.
 *
 * This module is not a test file (`vitest.config.ts` collects `test/**\/*.test.ts`),
 * so it is imported rather than collected.
 */

// --- The one variable this harness reads -----------------------------------

/**
 * Read from `process.env` and nowhere else in `app/`.
 *
 * Deliberately **not** in `REQUIRED_ENV_VARS` (`lib/env.ts`): it is not a
 * runtime variable, so it is not part of the runtime contract `getEnv()`
 * validates. It is therefore also deliberately absent from `.env.example`,
 * because the boundary guard asserts that file's key set *equals*
 * `REQUIRED_ENV_VARS` exactly (Req 5.4) and an extra key would fail it.
 */
export const TEST_DATABASE_URL_VAR = "TEST_DATABASE_URL"

/** The compose service's URL, quoted for a shell, so the skip can be acted on. */
const SUGGESTED_URL = "postgresql://rpt_test:rpt_test@127.0.0.1:55432/rpt_test"

const UP_SCRIPT = "pnpm test:db:up"
const DOWN_SCRIPT = "pnpm test:db:down"
const COMPOSE_FILE = "docker-compose.test.yml"

/**
 * The loud skip (see `withScratchSchema`). Names the variable, the script that
 * starts the service, and the URL that service listens on, because "skipped" on
 * its own sends a developer looking for a connection bug that is not there.
 */
export const MISSING_TEST_DATABASE_MESSAGE = [
  ``,
  `${TEST_DATABASE_URL_VAR} is unset — every Postgres integration suite in this run is SKIPPED.`,
  ``,
  `Start the pinned Postgres 17 service and point the harness at it:`,
  ``,
  `    ${UP_SCRIPT}`,
  `    export ${TEST_DATABASE_URL_VAR}='${SUGGESTED_URL}'`,
  `    pnpm test`,
  ``,
  `${DOWN_SCRIPT} removes the container and its volume. The service, the port and`,
  `the reason its Postgres major is pinned are documented in ${COMPOSE_FILE}.`,
  ``,
].join("\n")

/** The short form that rides along on each skipped test in the report. */
export const MISSING_TEST_DATABASE_NOTE = `${TEST_DATABASE_URL_VAR} unset — run \`${UP_SCRIPT}\``

// --- Paths, resolved at run time ------------------------------------------

/** `app/`, resolved from this file so it does not depend on the cwd. */
const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
)

/**
 * Where drizzle-kit writes its SQL. Resolved on every `beforeAll` rather than
 * once at import: task 2.1 generates the first migration, so at the moment this
 * harness lands the directory does not exist yet, and the harness has to be
 * correct both before and after that.
 */
const MIGRATIONS_DIR = "lib/db/migrations"

// --- Pool and hook sizing -------------------------------------------------

/**
 * Four connections, not one. Two simultaneous transactions is the floor for the
 * `SKIP LOCKED` disjointness proof; the spare two leave room for a fixture
 * connection and an assertion connection alongside them without a checkout
 * blocking on the racing pair.
 */
const MIN_POOL_SIZE = 4

/** A cold container plus a full migration apply comfortably exceeds Vitest's
 * 10s default hook timeout, and a timeout there reads as a harness bug. */
const SETUP_TIMEOUT_MS = 60_000
const TEARDOWN_TIMEOUT_MS = 30_000

/** A wrong URL should fail with a stated timeout, not hang until the hook's. */
const CONNECT_TIMEOUT_MS = 10_000

// --- The handle -----------------------------------------------------------

export interface ScratchSchemaHandle {
  /** The schema every query on `pool()` resolves against. */
  readonly schemaName: string
  /**
   * False when `TEST_DATABASE_URL` is unset. Every test in the file is skipped
   * in that case, so a suite rarely needs to read this; it is here so a test can
   * assert the skip path itself.
   */
  readonly enabled: boolean
  /**
   * The pool, with `search_path` bound to `schemaName` on every connection.
   *
   * Throws before `beforeAll` has run and after `afterAll` has ended it, rather
   * than handing back a pool whose connections point somewhere else.
   */
  pool(): Pool
  /** One query on a pooled connection. Shorthand for `pool().query(...)`. */
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>
  /** The migration file names applied into this schema, in applied order. */
  appliedMigrations(): readonly string[]
}

/**
 * Register a scratch schema for the calling suite and return its handle.
 *
 * @param label anything identifying the caller — `import.meta.url` is the
 * intended argument. It is slugified into the schema name so a stuck schema is
 * traceable to the file that created it; uniqueness comes from the random
 * suffix, not from the label.
 */
export function withScratchSchema(label?: string): ScratchSchemaHandle {
  const connectionString = readTestDatabaseUrl()
  const schemaName = scratchSchemaName(label)

  let pool: Pool | undefined
  let applied: readonly string[] = []
  let created = false

  function requirePool(): Pool {
    if (pool === undefined) {
      throw new Error(
        connectionString === undefined
          ? MISSING_TEST_DATABASE_MESSAGE
          : `The scratch pool for ${schemaName} is not open. ` +
              `Read it inside a test or a beforeEach, not at module scope.`
      )
    }
    return pool
  }

  const handle: ScratchSchemaHandle = {
    schemaName,
    enabled: connectionString !== undefined,
    pool: requirePool,
    query: (text, values) => requirePool().query(text, values),
    appliedMigrations: () => applied,
  }

  if (connectionString === undefined) {
    // Two mechanisms, because neither alone is both honest and visible.
    //
    // `ctx.skip(note)` is Vitest 4's mechanism: it marks each test skipped and
    // records the note on the result, so the run reports `N skipped` rather than
    // `N passed`. That distinction is the point — a suite that reports a pass
    // while testing nothing is the outcome worth preventing. The note is
    // rendered beside the test (`↓ … [note]`) by the verbose reporter and by the
    // default reporter in a TTY.
    //
    // `notify` covers the runs where that per-test line is never printed: the
    // default reporter collapses a passing module to one line in a piped run,
    // and Vitest's agent reporter goes further, defaulting `silent` to
    // `"passed-only"` so intercepted `console` output from a *non-failing* file
    // is dropped entirely. Writing to `process.stderr` is outside that
    // interception, so it survives every reporter — measured, not assumed.
    notifyOnce(label ?? schemaName, MISSING_TEST_DATABASE_MESSAGE)
    beforeEach((ctx) => {
      ctx.skip(MISSING_TEST_DATABASE_NOTE)
    })
    return handle
  }

  beforeAll(async () => {
    await withAdminClient(connectionString, (client) =>
      client.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`)
    )
    created = true
    pool = openScratchPool(connectionString, schemaName)
    applied = await applyMigrations(pool, schemaName)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    // This hook runs whether the tests passed, failed, or never ran because
    // `beforeAll` threw, so a failing run leaves no schema behind for the next
    // one to trip over.
    //
    // Guarded on `created` rather than swallowing errors: if the create never
    // happened there is nothing to drop and a second connection failure would
    // only bury the first, but if it did happen and the drop fails then there is
    // residue and the run should say so.
    if (!created) return

    const opened = pool
    pool = undefined
    created = false
    try {
      // Ended before the drop: a pooled connection still sitting in the schema
      // holds locks that would make `DROP SCHEMA` block until this hook's
      // timeout, which reads as a hang rather than as a leak.
      await opened?.end()
    } finally {
      await withAdminClient(connectionString, (client) =>
        client.query(
          `DROP SCHEMA IF EXISTS ${escapeIdentifier(schemaName)} CASCADE`
        )
      )
    }
  }, TEARDOWN_TIMEOUT_MS)

  return handle
}

// --- TEST_DATABASE_URL ----------------------------------------------------

function readTestDatabaseUrl(): string | undefined {
  const raw = process.env[TEST_DATABASE_URL_VAR]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  // An empty or whitespace-only value is an unset variable that looks set —
  // treat it as unset so it takes the loud skip rather than a connect failure.
  return trimmed.length === 0 ? undefined : trimmed
}

// --- Operator-facing notices ----------------------------------------------

/**
 * Every notice this harness emits goes here, straight to `process.stderr`.
 *
 * Not `console`: Vitest intercepts `console` inside the worker and hands the
 * output to the reporter, which then decides whether to show it. The agent
 * reporter's `silent: "passed-only"` default means a notice from a file whose
 * tests all skipped is discarded — precisely the case each of these notices
 * exists to explain. `process.stderr` is not intercepted, so the notice prints
 * under every reporter.
 */
function notify(message: string): void {
  process.stderr.write(`${message}\n`)
}

/** Keyed by caller, so every suite that trips a notice says so exactly once. */
const notified = new Set<string>()

function notifyOnce(key: string, message: string): void {
  const seen = `${key}\u0000${message}`
  if (notified.has(seen)) return
  notified.add(seen)
  notify(message)
}

// --- Schema naming --------------------------------------------------------

/** `NAMEDATALEN - 1`: Postgres truncates a longer identifier, which would turn
 * two long file names into one colliding schema. */
const MAX_IDENTIFIER_LENGTH = 63

const SCHEMA_PREFIX = "rpt_test_"

/** 5 bytes → 10 hex characters. Uniqueness across parallel workers, which do not
 * share the module state a counter would need. */
const SUFFIX_BYTES = 5

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/

/**
 * The schema name for one suite: a fixed prefix, a slug of the label, and a
 * random suffix.
 *
 * Exported because the identifier budget is the part with a failure mode worth
 * asserting — Postgres silently truncates past `NAMEDATALEN`, so a naive
 * `prefix + longFileName + suffix` turns two long file names into one shared
 * schema and the isolation this harness exists for disappears without an error.
 */
export function scratchSchemaName(label?: string): string {
  const suffix = randomBytes(SUFFIX_BYTES).toString("hex")
  const budget =
    MAX_IDENTIFIER_LENGTH - SCHEMA_PREFIX.length - suffix.length - 1
  const name = `${SCHEMA_PREFIX}${slugify(label).slice(0, budget)}_${suffix}`

  // The name reaches the connection's `options` startup parameter, which has no
  // quoting available (see `openScratchPool`), so its shape is an invariant
  // rather than a convention.
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to use ${name} as a schema name.`)
  }
  return name
}

/** A file URL or path becomes its basename without extension; anything else is
 * used as given. Lowercased, non-alphanumerics collapsed to `_`. */
function slugify(label: string | undefined): string {
  if (label === undefined || label.trim().length === 0) return "anon"

  const bare = label.startsWith("file:") ? fileURLToPath(label) : label
  const base = bare.includes("/") ? path.basename(bare) : bare

  const slug = base
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")

  return slug.length === 0 ? "anon" : slug
}

// --- The pool -------------------------------------------------------------

function openScratchPool(connectionString: string, schemaName: string): Pool {
  return new Pool({
    connectionString,
    max: MIN_POOL_SIZE,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // So a forgotten teardown cannot hold the test process open.
    allowExitOnIdle: true,

    // Binding #1, in the startup packet. The server applies it during session
    // startup, before it will run any statement, so there is no window in which
    // a freshly opened connection still points at `public`. Only the scratch
    // schema is listed — a stray table in `public` must not be able to satisfy a
    // query the migrations were supposed to satisfy.
    options: `-c search_path=${schemaName}`,

    // Binding #2, on every pooled connection.
    //
    // The property that matters is per-*connection*: a `SET search_path` issued
    // once against a borrowed client applies to that session only, and the next
    // checkout gets a different one. That is the bug that makes a pooled
    // integration test flaky, so the binding has to run on each new connection
    // rather than once against one client.
    //
    // `onConnect` rather than the `pool.on("connect")` event, and the difference
    // is load-bearing rather than stylistic — both fire once per new connection,
    // but only this one is **awaited**:
    //
    //   * pg-pool emits the `connect` event synchronously and does not await its
    //     listeners, so a `SET` issued from a listener is merely *enqueued*
    //     ahead of the caller's first query. Ordering then rests on the client's
    //     internal FIFO queue, and pg 8.22 deprecates exactly that overlap
    //     ("Calling client.query() when the client is already executing a query
    //     ... will be removed in pg@9.0"), so the pattern both warns now and
    //     stops working on the next major.
    //   * `onConnect` is awaited by pg-pool (`_promiseTry(...).then(_afterConnect)`)
    //     and the client is handed to the caller only afterwards, so the SET has
    //     *completed* before any test statement can run.
    //
    // It also fails safe: a rejection here makes pg-pool discard the connection
    // and reject the checkout, so a binding that did not take is a visible error
    // rather than a connection quietly pointing at `public`.
    onConnect: async (client) => {
      await client.query(`SET search_path TO ${escapeIdentifier(schemaName)}`)
    },
  })
}

async function withAdminClient<T>(
  connectionString: string,
  run: (client: Client) => Promise<T>
): Promise<T> {
  // A short-lived connection with the server's default `search_path`, because
  // creating and dropping the scratch schema are the two operations that must
  // not be performed from inside it.
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

// --- Migrations -----------------------------------------------------------

interface Migration {
  readonly name: string
  readonly statements: readonly string[]
}

/**
 * drizzle-kit separates the statements in a generated file with a
 * `--> statement-breakpoint` line, and that marker is the separator to split on.
 *
 * Splitting on `;` instead is the tempting shortcut and it is wrong: a semicolon
 * inside a string literal, a `$$`-quoted function body or a CHECK expression is
 * not a statement boundary, so a naive split would cut one statement into two
 * halves that are each a syntax error. The breakpoint carries no such ambiguity
 * — drizzle-kit writes it, only ever between statements.
 *
 * Anchored per line, because the marker occupies its own line. Also tolerant of
 * CRLF, since a checkout on Windows rewrites the line endings of a committed
 * `.sql` file and the marker must still be found.
 */
const STATEMENT_BREAKPOINT = /^[ \t]*-->[ \t]*statement-breakpoint[ \t]*\r?$/m

/**
 * Exported for its own unit test: the failure mode is a statement silently cut
 * in half, which surfaces later as a syntax error in SQL nobody wrote by hand.
 */
export function splitStatements(sql: string): readonly string[] {
  return (
    sql
      .split(STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim())
      // A trailing breakpoint, or a file that is only comments, yields empties.
      .filter((statement) => statement.length > 0)
  )
}

/**
 * drizzle-kit qualifies the DDL it generates for a `pgEnum` with the schema the
 * type belongs to — `CREATE TYPE "public"."run_status" AS ENUM(...)`. An
 * explicit qualifier outranks `search_path`, so applied verbatim the enum would
 * be created in `public`: outside the scratch schema, surviving the drop, and
 * colliding with the next file that applies the same migration. Dropping the
 * qualifier hands the decision back to `search_path`, which is the scratch
 * schema.
 *
 * Safe to do bluntly because migrations are *generated* from one `schema.ts`
 * (Req 9.4) and never hand-edited, so the qualifier only ever appears in DDL
 * identifier position — there are no string literals in this SQL for the pattern
 * to reach into.
 */
const PUBLIC_QUALIFIER = /"public"\./g

function bindDdlToSearchPath(sql: string): string {
  return sql.replace(PUBLIC_QUALIFIER, "")
}

function readMigrations(): readonly Migration[] {
  const dir = path.join(APP_ROOT, MIGRATIONS_DIR)

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    // Expected, not an ordering error: this harness ships before task 2.1
    // generates the first migration, and it is first exercised by that
    // migration. A scratch schema with no tables in it is still a valid scratch
    // schema, so the run continues.
    notifyOnce(
      dir,
      `No migrations directory at ${MIGRATIONS_DIR} — applying none, so this ` +
        `scratch schema is empty. Task 2.1 generates the first migration from ` +
        `lib/db/schema.ts with \`pnpm db:generate\`.`
    )
    return []
  }

  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    // Lexical order is the applied order. drizzle-kit's zero-padded
    // `NNNN_name.sql` makes lexical and numeric order the same thing; comparing
    // code units rather than using a locale collation keeps that true on every
    // machine.
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

  if (names.length === 0) {
    notifyOnce(
      dir,
      `${MIGRATIONS_DIR} holds no .sql files — applying none, so this scratch ` +
        `schema is empty. Generate them with \`pnpm db:generate\` from ` +
        `lib/db/schema.ts; never hand-write them (Req 9.4).`
    )
  }

  return names.map((name) => ({
    name,
    statements: splitStatements(
      bindDdlToSearchPath(readFileSync(path.join(dir, name), "utf8"))
    ),
  }))
}

async function applyMigrations(
  pool: Pool,
  schemaName: string
): Promise<readonly string[]> {
  const migrations = readMigrations()
  if (migrations.length === 0) return []

  // One connection for the whole apply, so the files land in one session in the
  // order they were read.
  const client = await pool.connect()
  try {
    const applied: string[] = []
    // One transaction around the whole apply. A migration that fails halfway
    // would otherwise leave a scratch schema holding some of its tables, and the
    // suite's failures would then be about the missing half rather than about the
    // statement that actually broke.
    await client.query("BEGIN")
    try {
      for (const migration of migrations) {
        for (const [index, statement] of migration.statements.entries()) {
          try {
            await client.query(statement)
          } catch (cause) {
            // The index, because a generated file holds dozens of statements and
            // "migration 0001 failed" does not say which one.
            throw new Error(
              `Statement ${index + 1} of ${migration.statements.length} in migration ` +
                `${migration.name} failed against scratch schema ${schemaName}.`,
              { cause }
            )
          }
        }
        applied.push(migration.name)
      }
      await client.query("COMMIT")
    } catch (cause) {
      await client.query("ROLLBACK")
      throw cause
    }
    return applied
  } finally {
    client.release()
  }
}
