/**
 * Apply the committed migrations, for a server that has no `drizzle-kit`.
 *
 * A release is the standalone build, which carries only the modules the app imports at
 * runtime — `drizzle-kit` is a development tool and is not among them. `buildspec.yml`
 * bundles this file with esbuild into one `migrate.cjs` (drizzle-orm's migrator and
 * `pg` inlined), and the deploy's `AfterInstall` hook runs it before the new release is
 * switched in:
 *
 *   node --env-file=/etc/reporting-agent/app.env migrate.cjs <migrations-folder>
 *
 * It uses drizzle-orm's own migrator, which is what `drizzle-kit migrate` calls, against
 * the same `meta/_journal.json` and the same bookkeeping table, so a database migrated by
 * hand before this existed is recognised rather than migrated twice. Migrations here are
 * additive (`test/migrations.static.test.ts`), which is what makes running them while the
 * previous release is still serving safe.
 */
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error("[migrate] DATABASE_URL is not set; nothing was applied.")
    process.exit(1)
  }

  const migrationsFolder = process.argv[2]
  if (!migrationsFolder) {
    console.error("[migrate] usage: migrate.cjs <migrations-folder>")
    process.exit(1)
  }

  const pool = new Pool({ connectionString, max: 1 })
  try {
    await migrate(drizzle(pool), { migrationsFolder })
    console.log("[migrate] migrations are up to date")
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  // The connection string is never printed: only the error's own name and message.
  console.error(
    "[migrate] failed:",
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  )
  process.exit(1)
})
