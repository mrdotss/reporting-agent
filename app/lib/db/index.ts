import "server-only"

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import * as schema from "@/lib/db/schema"
import { requireEnv } from "@/lib/env"

/**
 * The Postgres connection, and the only place in `app/` that opens one.
 *
 * `import "server-only"` is the first line and stays there (Requirement 6.1):
 * this module reads `DATABASE_URL` and hands out a client that can read every
 * secret-bearing column in `lib/db/schema.ts`, so a client component importing
 * it should be a build error rather than a review comment.
 */

export type Database = NodePgDatabase<typeof schema>

export { schema }

/**
 * Cached on `globalThis` rather than in a module-level `const`.
 *
 * Next's dev server re-evaluates a module on every hot reload while the process
 * survives, so a module-scoped pool leaks one pool per edit until Postgres
 * refuses connections — a failure that reads as "the database is down" after
 * twenty minutes of ordinary editing. The global outlives the module instance,
 * which is exactly the lifetime a connection pool wants.
 */
const cache = globalThis as typeof globalThis & {
  __rptPool?: Pool
  __rptDb?: Database
}

/**
 * How many connections one app process may hold.
 *
 * Sized against Postgres's default `max_connections` of 100 with room for
 * several app instances, a migration, and a psql session alongside them. It is
 * a ceiling, not a target: pg opens connections lazily.
 */
const MAX_CONNECTIONS = 10

/** Fail with a stated timeout rather than hanging until the caller's. */
const CONNECT_TIMEOUT_MS = 10_000

/** Return an idle connection to the server instead of holding it forever. */
const IDLE_TIMEOUT_MS = 30_000

/**
 * The pool, opened on first use.
 *
 * **Lazily**, because `DATABASE_URL` is resolved at call time (Requirements 5.1,
 * 5.9). A pool constructed at module scope would move that resolution to import
 * time, so a missing variable would surface as a module-load crash in whatever
 * imported this transitively — including a static test that only wanted a table
 * definition — instead of as a `MissingEnvError` naming `DATABASE_URL` at the
 * moment something needed a connection.
 */
export function getPool(): Pool {
  if (cache.__rptPool !== undefined) return cache.__rptPool

  const pool = new Pool({
    connectionString: requireEnv("DATABASE_URL"),
    max: MAX_CONNECTIONS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
  })

  /**
   * Required, not defensive. pg emits `error` on a pooled connection that dies
   * while **idle** — a server restart, a failover, an idle-session timeout — and
   * that event has no query to reject, so with no listener attached Node treats
   * it as an unhandled `'error'` and takes the process down. A dropped idle
   * connection is an ordinary event in a long-lived server; the pool discards
   * the client itself and the next checkout opens a fresh one.
   */
  pool.on("error", (error) => {
    console.error("[db] idle client error", error)
  })

  cache.__rptPool = pool
  return pool
}

/**
 * The Drizzle client, bound to the full schema so relational queries and
 * `$inferSelect` types resolve against it.
 *
 * A function rather than an exported `db` const for the same reason as
 * {@link getPool}: an eagerly constructed client resolves `DATABASE_URL` at
 * import time. Call it where the query is.
 */
export function getDb(): Database {
  if (cache.__rptDb !== undefined) return cache.__rptDb

  const db = drizzle(getPool(), { schema })
  cache.__rptDb = db
  return db
}

/**
 * Close the pool and clear the cache.
 *
 * For a script or a test that has to end the process cleanly. Application code
 * does not call this — a request handler that closed the pool would take every
 * concurrent request with it.
 */
export async function closeDb(): Promise<void> {
  const pool = cache.__rptPool
  cache.__rptPool = undefined
  cache.__rptDb = undefined
  await pool?.end()
}
