import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"

import type {
  DriftSample,
  Finding,
  ReplayOutcome,
  VerificationCounts,
} from "@/lib/verifications/result"

/**
 * The single source of truth for the Postgres schema (Requirement 9.4).
 *
 * SQL migrations are **generated** from this file with `pnpm db:generate` into
 * `lib/db/migrations/` and are never hand-edited. Two consequences follow, and
 * both are load-bearing rather than stylistic:
 *
 *   * Every constraint has to be expressible here — including the CHECKs at the
 *     bottom of `report_runs` — because there is no post-generation edit step in
 *     which to add one.
 *   * Migrations are **additive** (Requirements 9.5, 36.8). These rows are the
 *     audit trail for delivered documents, so the schema may only grow around
 *     them. A column is added; a column is not repurposed, retyped, or dropped.
 *     `test/migrations.static.test.ts` enforces that against the generated SQL.
 */

// --- Enums ------------------------------------------------------------------

/**
 * Real Postgres enums, not `text` columns with a TypeScript union.
 *
 * Requirements 9.6 and 36.1 say *constrain*, and a `text` column constrains
 * nothing in the database: a TS union is erased at build time, so any writer
 * that is not this app — a migration, a psql session, a future service — can
 * store `'colecting'` and every reader downstream inherits it.
 *
 * The additive rule applies at the type level too. A Postgres enum can only
 * gain values (`ALTER TYPE ... ADD VALUE`), which is exactly the shape of change
 * these tables are allowed to undergo.
 */

/** Requirement 9.6. `active` is the only state a run is accepted from. */
export const subscriptionStatus = pgEnum("subscription_status", [
  "pending",
  "active",
  "disabled",
])

/**
 * There is deliberately no `expired` value: the expired state is **derived**
 * from `secret_expires_at` rather than stored (Requirement 9.6). A stored
 * `expired` would have to be written by something at the moment it becomes
 * true, and nothing runs at that moment.
 */
export const fidelityTier = pgEnum("fidelity_tier", ["baseline", "enhanced"])

/**
 * Requirement 36.1 — all eight values.
 *
 * `compiling`, `rendering` and `verifying` are defined here and **not driven by
 * this spec**: the run pipeline stops at the snapshot, so the only transitions
 * that fire are `queued → claimed → collecting → completed | failed`
 * (Requirement 36.2). They are declared anyway because the state machine is one
 * design, and adding them later would mean migrating the same enum twice.
 */
export const runStatus = pgEnum("run_status", [
  "queued",
  "claimed",
  "collecting",
  "compiling",
  "rendering",
  "verifying",
  "completed",
  "failed",
])

/**
 * Requirement 36.6's ten terminal codes, plus Requirement 41.2's six.
 *
 * `PARTIAL_COVERAGE` is **absent on purpose**. It is an *event* code carried on
 * a run that **completes** with recorded gaps, never a failed row's code
 * (Requirement 29.5). A report with recorded, visible gaps is useful and
 * honest; a report with hidden gaps is the thing the whole design exists to
 * prevent, and admitting `PARTIAL_COVERAGE` here would let a run with gaps be
 * filed as a failure instead of surfaced as a report with a gap list.
 *
 * `TIMEOUT` is written only by the Reaper, because a timed-out run's container
 * may already be gone and there is no stream left to carry an `error` event.
 *
 * The six document-phase codes are **appended**, and the position matters
 * (Requirement 41.2). A Postgres enum grows with `ALTER TYPE ... ADD VALUE`,
 * which appends unless told otherwise, so declaring them last is what keeps this
 * array and the type's own value order the same thing — and it is why the change
 * removes nothing: there is no rewrite of the type, only six additions to it.
 *
 * `TEMPLATE_INVALID` is worth reading twice. Reaching it means a definition the
 * app was willing to *save* is one the compiler *refuses*, so it does not only
 * fail a run — it is the signal that the two block-config schemas have drifted.
 */
export const runErrorCode = pgEnum("run_error_code", [
  "AUTH_EXPIRED",
  "AUTH_FAILED",
  "SCOPE_UNVERIFIED",
  "SECRET_UNREADABLE",
  "EMPTY_SCOPE",
  "CATALOG_UNUSABLE",
  "NO_STATISTICS",
  "REGION_UNREACHABLE",
  "THROTTLED",
  "TIMEOUT",
  // Requirement 41.2 — one per document phase. All six terminal.
  "TEMPLATE_INVALID",
  "COMPILE_FAILED",
  "RENDER_FAILED",
  "PDF_CONVERSION_FAILED",
  "VERIFICATION_FAILED",
  "REPLAY_MISMATCH",
  // A failure in the runtime rather than in the customer's data. Not a
  // collection phase and not an app-written code: it is what the five
  // invocation-level codes present as, because the progress endpoint refuses a
  // `failed` transition carrying no code at all and the agent used to send
  // exactly that — losing the transition and letting the Reaper write TIMEOUT
  // over a run that had already failed in seconds.
  "INTERNAL_ERROR",
])

/**
 * Requirement 36.1. Two values, never a third: a verification either proved
 * the document against the snapshot or it did not, and there is no partial
 * credit — `verify/verifier.py`'s own rule is that a verification which
 * terminated before evaluating every gate is a `fail`, not a third state.
 *
 * A real Postgres enum for the same reason `run_status` is one rather than a
 * `text` column: an errant writer storing `'passed'` instead of `pass` would
 * make the Verification_Panel's pass/fail branch silently fall through to
 * neither, and a TS union catches that nowhere a migration or a psql session
 * can reach.
 */
export const verificationStatus = pgEnum("verification_status", [
  "pass",
  "fail",
])

/**
 * The scan lifecycle — deliberately simpler than `run_status` because a scan
 * produces no snapshot, ledger or artifact, so there is nothing to claim, no
 * progress callback and no reaper. A dead `running` row is superseded by the
 * next scan rather than reaped.
 */
export const scanStatus = pgEnum("scan_status", [
  "queued",
  "running",
  "complete",
  "failed",
])

export type SubscriptionStatus = (typeof subscriptionStatus.enumValues)[number]
export type FidelityTier = (typeof fidelityTier.enumValues)[number]
export type RunStatus = (typeof runStatus.enumValues)[number]
export type RunErrorCode = (typeof runErrorCode.enumValues)[number]
export type VerificationStatus = (typeof verificationStatus.enumValues)[number]
export type ScanStatus = (typeof scanStatus.enumValues)[number]

// --- Shared column shapes ---------------------------------------------------

/**
 * Every instant in this schema is `timestamptz`. A `timestamp without time
 * zone` would store the wall clock of whichever machine wrote it, and session
 * expiry, phase deadlines and the trailing lockout window are all comparisons
 * against `now()` that must not depend on that.
 *
 * Report *periods* are the deliberate exception — see `report_runs` below.
 */
function instant(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" })
}

// --- users ------------------------------------------------------------------

/** Requirements 1.1, 7.3. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),

  /** As entered, so a sign-in confirmation can address the user as they typed. */
  email: text("email").notNull(),

  /**
   * Trimmed and lower-cased, UNIQUE (Requirement 7.3). The uniqueness that
   * matters is over the normalized form: `Ada@Example.com ` and
   * `ada@example.com` are one account, and a UNIQUE over `email` would let both
   * exist.
   */
  emailNormalized: text("email_normalized").notNull().unique(),

  /**
   * The argon2id encoded hash and nothing else (Requirement 1.1) — the encoded
   * string carries its own parameters and salt, so no other column is needed
   * and none is offered.
   */
  passwordHash: text("password_hash").notNull(),

  createdAt: instant("created_at").notNull().defaultNow(),
})

// --- sessions ---------------------------------------------------------------

/** Requirement 2. Sessions are database rows, so sign-out and expiry are real. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * `sha256(token)` as hex — Requirement 2.2. There is **no column holding
     * the token**, which is the point: a database disclosure then yields no
     * usable cookie value. UNIQUE both because two sessions cannot share a
     * token and because the lookup is an equality probe on this column.
     */
    sessionTokenHash: text("session_token_hash").notNull().unique(),

    /** Creation instant + 30 days; never rolled forward (Requirement 2.6). */
    absoluteExpiresAt: instant("absolute_expires_at").notNull(),

    /** Rolled to read instant + 7 days on every valid read (Requirement 2.7). */
    idleExpiresAt: instant("idle_expires_at").notNull(),

    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    /**
     * What makes "revoke every session for this user" (Requirement 1.9) a
     * single indexed delete instead of a sequential scan. It runs inside the
     * password-change transaction, so its cost is on a user-facing path.
     */
    index("sessions_user_id_idx").on(table.userId),
  ]
)

// --- login_attempts ---------------------------------------------------------

/**
 * Requirement 3.1. Lockout is derived from a trailing window over these rows
 * (Requirement 3.4) — there is no lock row, and therefore nothing that has to
 * be cleared for a locked email to become usable again.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: text("id").primaryKey(),

    /** The normalized form, so case and whitespace cannot split the window. */
    emailNormalized: text("email_normalized").notNull(),

    success: boolean("success").notNull(),

    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    /**
     * `created_at DESC` is not decoration. The read is "the failures for this
     * email in the trailing 15 minutes", and a descending second key lets
     * Postgres walk the newest rows first and stop, rather than sorting the
     * whole per-email range. The direction is part of the index because it is
     * part of the query.
     */
    index("login_attempts_email_normalized_created_at_idx").on(
      table.emailNormalized,
      table.createdAt.desc()
    ),
  ]
)

// --- connected_subscriptions ------------------------------------------------

/**
 * Requirement 9.1. Three columns here are **secrets** — `tenant_id`,
 * `client_id` and `client_secret_enc` — and they leave the server only in the
 * invoke payload's `context`. Nothing in this table reaches the browser except
 * through `ConnectedSubscriptionView`.
 */
export const connectedSubscriptions = pgTable(
  "connected_subscriptions",
  {
    id: text("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    displayName: text("display_name").notNull(),

    /** The customer's Azure subscription GUID. Masked in every projection. */
    subscriptionId: text("subscription_id").notNull(),

    /** **Secret.** Server-resolved at invoke time, never sent to the browser. */
    tenantId: text("tenant_id").notNull(),

    /** **Secret.** */
    clientId: text("client_id").notNull(),

    /**
     * **Secret.** The Crypto_Module's AES-256-GCM envelope and nothing else
     * (Requirement 9.2) — the plaintext client secret is never stored in this
     * column or any other.
     */
    clientSecretEnc: text("client_secret_enc").notNull(),

    /**
     * Defaults to false, and the preflight is its only writer of `true`
     * (Requirement 12.14). It is never inferred from a successful inventory
     * query: that query is itself RBAC-filtered, so a principal holding Reader
     * on one resource group returns that group's resources, every downstream
     * metric succeeds, and the run reports full coverage of a report that is
     * mostly missing.
     */
    scopeVerified: boolean("scope_verified").notNull().default(false),

    fidelityTier: fidelityTier("fidelity_tier").notNull().default("baseline"),

    /**
     * Azure service-principal secrets expire — 24 months at most, commonly 6 to
     * 12 (Requirement 13.1). NOT NULL because an unknown expiry is
     * indistinguishable from one that has passed, and a passed one produces a
     * clean, fully-verified, empty report.
     */
    secretExpiresAt: instant("secret_expires_at").notNull(),

    status: subscriptionStatus("status").notNull().default("pending"),

    /**
     * The **only** nullable column on this table (Requirement 9.1): it is set
     * on the `enhanced` tier and absent on `baseline`, which is a genuine
     * absence rather than a value not yet filled in.
     */
    logAnalyticsWorkspaceId: text("log_analytics_workspace_id"),

    createdAt: instant("created_at").notNull().defaultNow(),

    /**
     * The instant this row was last written, and the Inventory_Endpoint's
     * invalidation signal (Requirement 9.2).
     *
     * The inventory cache in `lib/subscriptions/inventory-cache.ts` keys on the row
     * id and holds a listing for 300 seconds, but a rotated credential or a changed
     * status has to list the subscription again rather than serve the previous
     * answer. Comparing this column makes invalidation-on-write a read of the row
     * the handler already loaded, instead of a publish/subscribe problem between one
     * request that writes and another that caches.
     *
     * `defaultNow()` so an existing row gets a value on the additive migration, and
     * NOT NULL because "never written" and "written at an unknown instant" would
     * otherwise be the same absence — and a NULL compared against a cache entry
     * would read as "not written since", which is the answer that serves a stale
     * list. Every writer in `lib/subscriptions/store.ts` sets it explicitly: a
     * column that only ever holds its default is invalidation that never fires.
     */
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    /** Requirement 9.7 — every read and write is scoped by `user_id`. */
    index("connected_subscriptions_user_id_idx").on(table.userId),

    /**
     * Requirements 9.1, 9.10. Scoped to the user rather than global: two
     * consultants may legitimately hold their own connection to the same
     * customer subscription, with their own service principal and their own
     * secret. A global UNIQUE would make the first connection block the second
     * and leak the fact that it exists.
     */
    unique("connected_subscriptions_user_id_subscription_id_uq").on(
      table.userId,
      table.subscriptionId
    ),
  ]
)

// --- report_runs ------------------------------------------------------------

/**
 * The requested collection scope, persisted as one `jsonb` column.
 *
 * Parsed at the boundary by `runScopeSchema` in `lib/actions/runs.ts`; this type
 * is the persisted shape that schema must satisfy. One `jsonb` column rather
 * than two `text[]` columns so the persisted scope, the invoke payload's
 * `scope` and the snapshot's recorded scope are **one shape** instead of three
 * that can drift — and so tag filters need no further migration.
 */
export type RunScope = {
  resource_types: string[]
  resource_groups: string[]
  tag_filters: Record<string, string>
}

/**
 * Requirement 36.3. **This row is authoritative** (Requirement 36.6): a client
 * reconstructs run state from it, not from a replayed event stream, and the
 * `TIMEOUT` code exists only here because the Reaper writes it with no stream
 * left to carry an event.
 *
 * The columns below are what make it an actual state machine rather than a
 * status label — `dedupe_key` for idempotency, `claimed_*` for the
 * `FOR UPDATE SKIP LOCKED` claim, `phase_deadline` for the reaper.
 */
export const reportRuns = pgTable(
  "report_runs",
  {
    id: text("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id),

    connectedSubscriptionId: text("connected_subscription_id")
      .notNull()
      .references(() => connectedSubscriptions.id),

    /**
     * `date`, in string mode, and both decisions matter.
     *
     * A report period is a **local** calendar range in `timezone` — "July 2026"
     * means July in Asia/Jakarta, not July in UTC. `mode: "string"` keeps it a
     * plain `YYYY-MM-DD` on both sides of the driver. `mode: "date"` would
     * materialise a `Date` at UTC midnight, and the first place that formatted
     * it in a westward zone would silently render the previous day.
     *
     * Neither is `timestamptz`: there is no instant here to convert, only a
     * calendar date the collector resolves against `timezone`.
     */
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),

    /**
     * IANA zone name. Not cosmetic — it decides local-day bucketing and
     * therefore every daily figure in the report.
     */
    timezone: text("timezone").notNull().default("Asia/Jakarta"),

    /**
     * Requirements 37.1, 41.8. Persisted because two other criteria need it
     * after the enqueue returns: `dedupe_key` is derived from the sorted
     * resource types and resource groups, and the invoke payload must carry
     * *that run's* requested scope. Neither is satisfiable without storing it.
     *
     * Excluded from `RunView`, so it does not reach the browser.
     */
    scope: jsonb("scope").$type<RunScope>().notNull(),

    status: runStatus("status").notNull().default("queued"),

    /**
     * The idempotency guard (Requirement 36.4). UNIQUE, so a double-submitted
     * form or a retried cron tick cannot produce two runs against one
     * subscription and period: the second insert is rejected by the database
     * and the enqueue returns the existing run (Requirement 37.5).
     *
     * Derived deterministically, with no random component — a random suffix
     * would make every key unique and the constraint decorative.
     */
    dedupeKey: text("dedupe_key").notNull().unique(),

    claimedAt: instant("claimed_at"),

    /** One uuid per tick request, so a claim is attributable to a claimer. */
    claimedBy: text("claimed_by"),

    /**
     * Set to the write instant on every write that changes another column
     * (Requirement 36.3). `$onUpdate` covers writes issued through Drizzle; the
     * hand-written claim and reap statements in `lib/runs/` set it explicitly,
     * because a raw `UPDATE` bypasses this hook.
     */
    updatedAt: instant("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    /**
     * The instant after which the Reaper fails a non-terminal run as `TIMEOUT`
     * (Requirement 36.9), and cleared on a terminal row so a finished run is
     * never swept. Indexed because the reaper's sweep is a range scan over it
     * on every tick.
     */
    phaseDeadline: instant("phase_deadline"),

    /** Constrained against `status` by `report_runs_error_code_ck` below. */
    errorCode: runErrorCode("error_code"),
    errorMessage: text("error_message"),

    /**
     * `sha256(progress_token)` as hex. The token itself is **never stored**
     * (Requirement 37.3): the process that invokes the runtime recomputes it
     * from `APP_ENCRYPTION_KEY` and this run's id.
     *
     * It authorizes writes to this state machine, so a leaked token lets
     * someone mark a run `completed` — it gets the session-token treatment, not
     * the correlation-id treatment. Never projected to the browser.
     */
    progressTokenHash: text("progress_token_hash").notNull(),

    /**
     * The three in-flight progress columns (Requirement 36.12): the count a
     * phase is currently at, so a reconnecting client recovers a *determinate*
     * bar rather than a spinner that has been turning for four minutes.
     *
     * Nullable and cleared when the row goes terminal, so a finished run
     * carries no stale in-flight count. All three are additive, so the
     * additive-migration guard is unaffected — nothing is dropped and no
     * existing column changes type or nullability.
     */
    progressCurrent: integer("progress_current"),
    progressTotal: integer("progress_total"),
    progressLabel: text("progress_label"),

    /** The snapshot's `content_hash`: 64 lowercase hex, set on completion. */
    snapshotId: text("snapshot_id"),

    resourceCount: integer("resource_count"),
    gapCount: integer("gap_count"),

    /**
     * The exact `report_template_versions` row this run pins (Requirement
     * 9.6) — nullable rather than `NOT NULL`, and deliberately so. `NOT NULL`
     * would demand a backfill for every foundation-era row, and every one of
     * those rows produced no document: writing a version into them would be a
     * false statement in the exact rows that exist to be an audit trail. The
     * partial CHECK below enforces the pin for every row this spec's code can
     * create — a snapshot-only run from before this column existed stays
     * truthfully unpinned rather than fictitiously pinned.
     */
    templateVersionId: text("template_version_id").references(
      (): AnyPgColumn => reportTemplateVersions.id
    ),

    /**
     * The customer name printed on the cover and document-control pages
     * (Requirement 13.7). Nullable because a run pinned to a `schema_version` 1
     * version legitimately carries neither per-run front-matter value, and
     * `NOT NULL` would demand writing values into rows that never had them.
     *
     * The invariant is enforced at the boundary: `lib/actions/runs.ts` rejects a
     * v2-pinned request missing this value, naming the absent field and inserting
     * no row.
     */
    customerName: text("customer_name"),

    /**
     * The revision history row for this run's document-control page
     * (Requirement 13.7). A single jsonb object carrying `revision`, `note` and
     * `author`. Nullable for the same reason as `customer_name`: a run pinned to
     * a `schema_version` 1 version has no front matter to populate.
     */
    revisionHistoryRow: jsonb("revision_history_row").$type<{
      revision: string
      note: string
      author: string
    }>(),

    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    /** Requirement 36.10 — every read and write is scoped by `user_id`. */
    index("report_runs_user_id_idx").on(table.userId),

    /** The reaper's and the run list's read: due work in creation order. */
    index("report_runs_status_created_at_idx").on(
      table.status,
      table.createdAt
    ),

    /** The reaper's other read: non-terminal rows past their deadline. */
    index("report_runs_phase_deadline_idx").on(table.phaseDeadline),

    /**
     * Requirement 36.6, in the database rather than in a code path.
     *
     * A `failed` row must carry a code and a `completed` row must not. Both
     * halves matter and for opposite reasons: a failure with no code is a
     * terminal state the UI cannot explain, and a success carrying a stale code
     * reads as a failure that was somehow delivered. Expressed as a CHECK
     * because the writers are plural — the progress callback, the reaper, and
     * the enqueue action — and a rule enforced in three places is a rule
     * enforced in two.
     */
    check(
      "report_runs_error_code_ck",
      sql`(${table.status} = 'failed' AND ${table.errorCode} IS NOT NULL) OR
          (${table.status} <> 'failed' AND ${table.errorCode} IS NULL)`
    ),

    /**
     * Requirement 36.4's other half: UNIQUE settles *distinctness*, this
     * settles *presence*. An empty string is a perfectly unique value, so
     * without it one empty key would be accepted and the idempotency guard
     * would be satisfied by a row that identifies nothing.
     */
    check("report_runs_dedupe_key_ck", sql`length(${table.dedupeKey}) > 0`),

    /**
     * The other half of the deviation recorded in the design and in
     * `tasks.md` 2.2: `template_version_id` is nullable rather than
     * `NOT NULL`, and this CHECK is what still enforces the pin everywhere it
     * can be enforced truthfully.
     *
     * `2026-12-01T00:00:00Z` is the cutover instant, fixed and literal rather
     * than `now()`. It is **not** simply "when this migration file was
     * generated" — this migration lands in task 2.2, several tasks before
     * `lib/actions/runs.ts#enqueueRun` is taught to resolve and set
     * `template_version_id` at insertion (Requirement 9.6, wired in task
     * 13.1). Picking the literal generation instant would make every row the
     * *not-yet-updated* enqueue path writes between task 2.2 and task 13.1
     * violate this CHECK, which is exactly the "foundation-era, pinned to no
     * document" shape the deviation exists to exempt — just produced a few
     * tasks later rather than a spec earlier. The cutover is therefore set
     * past the implementation window this spec's remaining tasks run in, so
     * every row `enqueueRun` writes stays truthfully unpinned until task 13.1
     * lands, and every row created once the pinning writer exists is held to
     * the pin. If the rollout schedule slips past this literal, the fix is a
     * new migration moving it forward — the same shape as any other
     * outgrown constant, not a reason to weaken the CHECK itself.
     */
    check(
      "report_runs_template_version_id_ck",
      sql`${table.createdAt} < '2026-12-01T00:00:00Z'::timestamptz OR ${table.templateVersionId} IS NOT NULL`
    ),
  ]
)

// --- the design vocabulary ---------------------------------------------------

/**
 * The four enums a document's design is chosen from.
 *
 * They were declared for the `brands` table, which is gone: a Brand held one visual
 * identity for a whole consultancy, and a profile turned out to be a per-customer
 * engagement whose design is its own. The **types** stay. A profile's `design` object is
 * validated against these same four vocabularies (`lib/templates/definition.ts`), and
 * `DROP TYPE` of a committed enum is the harder half of the additive rule — the one place
 * a later `ALTER TYPE … ADD VALUE` becomes impossible to undo.
 */

export const themePreset = pgEnum("theme_preset", [
  "editorial",
  "corporate",
  "technical",
  "minimal",
])

export const density = pgEnum("density", ["compact", "normal", "relaxed"])

export const tableStyle = pgEnum("table_style", [
  "hairline",
  "banded",
  "bordered",
])

export const pageSize = pgEnum("page_size", ["A4", "Letter"])

export type ThemePreset = (typeof themePreset.enumValues)[number]
export type DensityEnum = (typeof density.enumValues)[number]
export type TableStyleEnum = (typeof tableStyle.enumValues)[number]
export type PageSizeEnum = (typeof pageSize.enumValues)[number]

// --- report_templates --------------------------------------------------------

/**
 * Requirements 1.1, 1.2. A template is **rules**, never resource identifiers:
 * there is no `connected_subscription_id`, no subscription id, no tenant id
 * and no Azure resource id on this table or anywhere in a definition, which is
 * what lets one definition run against every connected subscription a user
 * has rather than being re-authored per customer.
 *
 * `currentVersionId` and `report_template_versions.templateId` reference each
 * other. Both sides are ordinary lazy `references(() => ...)` closures, so the
 * declaration order below is not load-bearing — `reportTemplateVersions` is
 * declared after this table and this table's FK still resolves it correctly
 * because the closure is only evaluated once both tables exist.
 */
export const reportTemplates = pgTable(
  "report_templates",
  {
    id: text("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Constrained to 1–120 characters by `report_templates_name_ck` below. */
    name: text("name").notNull(),

    /**
     * Constrained to at most 1000 characters by
     * `report_templates_description_ck` below. Defaults to `''` rather than
     * being nullable, so "no description" and "description not yet set" are
     * not two representable states for the same thing.
     */
    description: text("description").notNull().default(""),

    /**
     * Nullable **only** until the template's first version exists
     * (Requirement 1.1). A template created through the wizard has no
     * version until step 7 completes, so this column starts null and is set
     * once `report_template_versions` gains its first row for this template.
     */
    currentVersionId: text("current_version_id").references(
      (): AnyPgColumn => reportTemplateVersions.id
    ),

    /**
     * The wizard's in-progress definition (Requirement 11.4). A column, not a
     * version row: a draft must not consume a version number, and there is
     * exactly one draft per template and no history of drafts to keep — which
     * is also why this lives on the template rather than in its own table.
     */
    draftDefinition: jsonb("draft_definition"),

    /**
     * Set only on the three seeded starter templates (Requirement 10.2), and
     * the seeder's idempotency: it inserts with
     * `ON CONFLICT (user_id, seeded_starter_key) DO NOTHING`, which runs only
     * at account creation, so a later request creates no duplicate and a
     * deleted starter is never resurrected (Requirement 10.7).
     */
    seededStarterKey: text("seeded_starter_key"),

    createdAt: instant("created_at").notNull().defaultNow(),

    /** Set on every write that changes another column on this row. */
    updatedAt: instant("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /** Requirement 1.4 — every read and write is scoped by `user_id`. */
    index("report_templates_user_id_idx").on(table.userId),

    /**
     * Requirement 1.1. `length` rather than `char_length` only by naming
     * convention with the rest of this file — both count characters, not
     * bytes, over `text`.
     */
    check(
      "report_templates_name_ck",
      sql`length(${table.name}) >= 1 AND length(${table.name}) <= 120`
    ),

    check(
      "report_templates_description_ck",
      sql`length(${table.description}) <= 1000`
    ),

    /**
     * Requirements 10.2, 10.7. Scoped to the user rather than global, the
     * same reasoning as `connected_subscriptions_user_id_subscription_id_uq`:
     * each user gets their own three starter rows, and a global UNIQUE would
     * make the first user's seeding block every other user's.
     */
    unique("report_templates_user_id_seeded_starter_key_uq").on(
      table.userId,
      table.seededStarterKey
    ),
  ]
)

// --- report_template_versions ------------------------------------------------

/**
 * Requirement 9.1. **Every column is `NOT NULL`** and there is deliberately
 * **no `updated_at`** — a version row is written once and never touched
 * again (Requirement 9.3); `lib/templates/store.ts` exposes no operation that
 * modifies or deletes one.
 */
export const reportTemplateVersions = pgTable(
  "report_template_versions",
  {
    id: text("id").primaryKey(),

    templateId: text("template_id")
      .notNull()
      .references(() => reportTemplates.id),

    /** Starts at 1 for a template's first version (Requirement 9.1). */
    version: integer("version").notNull(),

    /** The validated definition this version pins. */
    definition: jsonb("definition").notNull(),

    /**
     * RFC 8785 (JCS) canonicalization of `definition`, SHA-256 hex
     * (Requirement 9.4) — the same construction the snapshot uses, and the
     * same reason: two machines that agree on the definition must agree on
     * its digest.
     */
    definitionSha256: text("definition_sha256").notNull(),

    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    /** The FK read: every version of one template, in creation order. */
    index("report_template_versions_template_id_idx").on(table.templateId),

    /**
     * Requirement 9.1. Settles the race criterion 9.11 describes: two
     * concurrent saves that compute the same next `version` both attempt this
     * row, the database lets exactly one commit, and the loser re-resolves
     * the highest version and retries.
     */
    unique("report_template_versions_template_id_version_uq").on(
      table.templateId,
      table.version
    ),
  ]
)

// --- report_verifications ----------------------------------------------------

/**
 * Requirements 36.1, 36.2. **Every column is `NOT NULL`** and there is
 * deliberately no `updated_at` and no delete operation — a verification
 * result is written once, for one attempt, and never touched again
 * (Requirement 36.2); `lib/verifications/store.ts` (task 2.4) exposes insert
 * and read only.
 *
 * `run_id` carries **no UNIQUE**, and that absence is the design rather than
 * an oversight: a re-verification of one run **appends** a further row for
 * that run (Requirement 36.1), so a UNIQUE on `run_id` would make the second
 * attempt at proving the same run a constraint violation instead of a record.
 * `attempt_id` carries the UNIQUE instead, paired with `run_id` — which is
 * what makes a *retried* progress callback idempotent (the reporter's fire-
 * and-forget POST landing twice must insert one row, not two and inflate the
 * figure count the panel shows) without forbidding the deliberate append a
 * genuine re-verification performs under a fresh `attempt_id`.
 */
export const reportVerifications = pgTable(
  "report_verifications",
  {
    id: text("id").primaryKey(),

    runId: text("run_id")
      .notNull()
      .references(() => reportRuns.id),

    /**
     * Distinguishes one verification attempt from a retried callback
     * delivering the same attempt twice (Requirement 36.1) — paired with
     * `run_id` in the UNIQUE below rather than unique on its own, since two
     * different runs may each mint an `attempt_id` from the same sequence.
     */
    attemptId: text("attempt_id").notNull(),

    /**
     * The pinned version this attempt verified against — **not**
     * `report_runs.id`. A re-verification recompiles the run's *pinned*
     * version rather than the template's current one (Requirement 9.13), so
     * this column is what a stored verification result names as the
     * definition it proved the document against.
     */
    templateVersionId: text("template_version_id")
      .notNull()
      .references(() => reportTemplateVersions.id),

    /** Restricted to `pass` and `fail` — never a third state (Requirement 36.1). */
    status: verificationStatus("status").notNull(),

    /** Constrained to non-negative by `report_verifications_figure_count_ck`. */
    figureCount: integer("figure_count").notNull(),

    /** The run's `snapshot_id` — see criterion 36.6. */
    snapshotSha256: text("snapshot_sha256").notNull(),

    /** SHA-256 of the delivered `.docx` bytes this attempt verified. */
    docxSha256: text("docx_sha256").notNull(),

    /** SHA-256 of the `.pdf` converted from that same delivered `.docx`. */
    pdfSha256: text("pdf_sha256").notNull(),

    /**
     * The replay outcome — recomputed digest, stored digest, fold count and
     * whether replay was possible (Requirement 31.6). One `jsonb` column
     * rather than four scalar ones for the same reason `scope` on
     * `report_runs` is one column: the shape is validated at the boundary by
     * `lib/verifications/result.ts` (task 2.4), and a stored row, the invoke
     * payload and the emitted event stay one shape instead of three that can
     * drift.
     */
    replay: jsonb("replay").$type<ReplayOutcome>().notNull(),

    /** `{n, method, seed}` — Requirement 34.3. */
    driftSample: jsonb("drift_sample").$type<DriftSample>().notNull(),

    /** The ordered blocking-and-advisory finding list — Requirement 25.8. */
    findings: jsonb("findings").$type<Finding[]>().notNull(),

    /**
     * The non-negative counts every pass contributes — entries checked,
     * entries resolved, tokens extracted, anchors checked, and so on
     * (Requirements 27.13, 29.5, 32.6, 33.4) — kept as one `jsonb` bag rather
     * than one column per pass because passes are added over the life of
     * this spec and a counts column per pass is a migration per pass.
     */
    counts: jsonb("counts").$type<VerificationCounts>().notNull(),

    /**
     * The verification-result artifact's own S3 key — the **pointer** the
     * progress callback carries rather than a copy of the result
     * (Requirement 41.5's callback design): a 1,000-finding list with
     * 200-character excerpts is too large for a fire-and-forget POST, and the
     * artifact is the record anyway. Positional like every other report
     * artifact key (Requirement 43.1) rather than free-form, but recorded
     * here rather than computed, because it carries this row's own
     * `attempt_id` and computing it a second time in `lib/db/views.ts` would
     * be the same one-path-template rule stated twice.
     */
    artifactKey: text("artifact_key").notNull(),

    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    /**
     * The FK read with no UNIQUE (per the table-level note above): every
     * verification attempt for one run, so `latestForRun` (task 2.4) can
     * order by `created_at` within it.
     */
    index("report_verifications_run_id_idx").on(table.runId),

    /**
     * The idempotency guard a retried progress callback needs (Requirement
     * 41.5): one row per `(run_id, attempt_id)`, so a duplicate delivery of
     * the same attempt is rejected by the database rather than inserted
     * twice.
     */
    unique("report_verifications_run_id_attempt_id_uq").on(
      table.runId,
      table.attemptId
    ),

    check(
      "report_verifications_figure_count_ck",
      sql`${table.figureCount} >= 0`
    ),
  ]
)

// --- subscription_scans ------------------------------------------------------

/**
 * One row per subscription scan (Requirement 4.4). A scan reports the counts,
 * regions and route probes the wizard's step 2 needs; it is deliberately NOT
 * part of the `report_runs` state machine — it produces no snapshot, no ledger
 * and no artifact, so the reaper, phase deadlines and progress callback would
 * protect nothing. A dead `running` row is superseded by the next scan.
 */
export const subscriptionScans = pgTable(
  "subscription_scans",
  {
    id: text("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    connectedSubscriptionId: text("connected_subscription_id")
      .notNull()
      .references(() => connectedSubscriptions.id),

    status: scanStatus("status").notNull().default("queued"),

    catalogVersion: text("catalog_version"),
    sectionsCatalogueVersion: text("sections_catalogue_version"),

    resourceCount: integer("resource_count"),
    typeCounts: jsonb("type_counts"),
    childTypeCounts: jsonb("child_type_counts"),
    resourceGroups: jsonb("resource_groups"),
    regions: jsonb("regions"),
    regionCounts: jsonb("region_counts"),
    regionProbes: jsonb("region_probes"),

    truncated: boolean("truncated"),

    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    completedAt: instant("completed_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("subscription_scans_user_id_idx").on(table.userId),
    index("subscription_scans_subscription_created_at_idx").on(
      table.connectedSubscriptionId,
      table.createdAt
    ),
  ]
)

/**
 * One row per (template version, section) — the resources that section's rule
 * matched at PUBLISH time, against the scan the consultant was looking at while
 * authoring it (task 3.10, Requirement 9.5).
 *
 * **Deliberately kept out of `report_template_versions.definition`.**
 * `definition_sha256` is compared head-to-head across both languages' validators
 * and pinned per fixture — putting customer resource ids inside the hashed
 * definition would make the digest a function of the estate the consultant
 * happened to be looking at, rather than of the profile's own content. Two
 * profiles with identical sections authored against different scans (different
 * resource estates, different `scan_id`) must produce the SAME digest, and this
 * table is what makes that possible: the digest is computed from `definition`
 * alone, which never carries a resource id, a scan id, or a match count.
 *
 * **`unique(template_version_id, section_id)` is a pair, not a single key,
 * because `insertVersion` may return an EXISTING version** when the submitted
 * digest equals the current highest version's — a save that changed nothing
 * creates no new version row (Requirement 9.5's other half). The write here
 * must therefore be an upsert keyed on that pair, not a bare insert: republishing
 * an unchanged definition against a freshly re-scanned estate still needs its
 * authored-matches rows to reflect the current scan, even though no new version
 * was created to hold them.
 *
 * **Not projected to the browser.** `matched_resource_ids` is real customer
 * resource ids; nothing under `lib/db/views.ts` reads this table, and the
 * projection guard covers it by the same mechanism it covers every
 * secret-bearing table — see `structure.md`'s "one browser-safe projection type
 * per secret-bearing table" rule.
 */
export const reportProfileAuthoredMatches = pgTable(
  "report_profile_authored_matches",
  {
    id: text("id").primaryKey(),

    templateVersionId: text("template_version_id")
      .notNull()
      .references(() => reportTemplateVersions.id, { onDelete: "cascade" }),

    scanId: text("scan_id")
      .notNull()
      .references(() => subscriptionScans.id),

    /** The authored section's own `id` field within `definition.sections` —
     * not a database foreign key, since a section is not a row anywhere. */
    sectionId: text("section_id").notNull(),

    matchedCount: integer("matched_count").notNull(),

    /** The full resource id list the section's rule matched, at the scan named
     * above. `jsonb`, matching every other resource-shaped array in this
     * schema (`typeCounts`, `resourceGroups`, …) rather than a second-table
     * normalization this data has no other consumer to justify. */
    matchedResourceIds: jsonb("matched_resource_ids").notNull(),

    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("report_profile_authored_matches_version_section_uq").on(
      table.templateVersionId,
      table.sectionId
    ),
    index("report_profile_authored_matches_scan_id_idx").on(table.scanId),
  ]
)

// --- Row types --------------------------------------------------------------

/**
 * Inferred, never restated. `lib/db/views.ts` projects from these, and a
 * hand-written row type is how a column that was added to the table quietly
 * fails to appear in the projection guard's key set.
 */
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert

export type LoginAttempt = typeof loginAttempts.$inferSelect
export type NewLoginAttempt = typeof loginAttempts.$inferInsert

export type ConnectedSubscription = typeof connectedSubscriptions.$inferSelect
export type NewConnectedSubscription =
  typeof connectedSubscriptions.$inferInsert

export type ReportRun = typeof reportRuns.$inferSelect
export type NewReportRun = typeof reportRuns.$inferInsert

export type ReportTemplate = typeof reportTemplates.$inferSelect
export type NewReportTemplate = typeof reportTemplates.$inferInsert

export type ReportTemplateVersion = typeof reportTemplateVersions.$inferSelect
export type NewReportTemplateVersion =
  typeof reportTemplateVersions.$inferInsert

export type ReportVerification = typeof reportVerifications.$inferSelect
export type NewReportVerification = typeof reportVerifications.$inferInsert

export type SubscriptionScan = typeof subscriptionScans.$inferSelect
export type NewSubscriptionScan = typeof subscriptionScans.$inferInsert

