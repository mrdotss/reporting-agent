import { defineConfig } from "drizzle-kit"

/**
 * drizzle-kit's config, used by `db:generate`, `db:migrate` and `db:push`.
 *
 * `DATABASE_URL` is read straight from `process.env` here rather than through
 * `lib/env.ts`, and that is deliberate: `lib/env.ts` begins with
 * `import "server-only"`, whose default entry is a bare `throw`. drizzle-kit
 * loads this file in a plain Node context, not a React Server Component one, so
 * importing it would fail before the config was ever read. drizzle-kit bundles
 * dotenv and loads `app/.env` itself, so a local `pnpm db:generate` picks the
 * value up without any further wiring.
 *
 * `generate` only diffs `schema` against `out` — it never connects — so a
 * URL-shaped placeholder is enough to produce a migration. `migrate` and `push`
 * do connect, which is why the value is required rather than defaulted: a
 * silent fallback to `localhost` is how a migration lands on the wrong database.
 */
const url = process.env.DATABASE_URL

if (url === undefined || url.trim().length === 0) {
  throw new Error(
    "DATABASE_URL is not set, or is set to an empty value. drizzle-kit reads " +
      "it from app/.env; app/.env.example describes the expected shape. Its " +
      "value is excluded from this message."
  )
}

export default defineConfig({
  dialect: "postgresql",

  /**
   * One schema file (Requirement 9.4). Every table, enum and constraint is
   * declared there, so the generated SQL is a function of that file alone.
   */
  schema: "./lib/db/schema.ts",

  /**
   * Committed and never hand-edited. `test/db/scratch-schema.ts` applies these
   * files verbatim into a throwaway schema, and `test/migrations.static.test.ts`
   * parses them to enforce the additive rule (Requirements 9.5, 36.8).
   */
  out: "./lib/db/migrations",

  dbCredentials: { url },

  /**
   * The `--> statement-breakpoint` markers the scratch-schema harness splits on.
   * Splitting on `;` instead would cut a CHECK expression or a quoted literal in
   * half; this marker only ever appears between statements.
   */
  breakpoints: true,

  /** Print the SQL before it is written, so a generated diff is reviewed. */
  verbose: true,

  /** Ask before a destructive statement — the schema is only allowed to grow. */
  strict: true,
})
