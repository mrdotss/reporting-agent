import "server-only"

import { randomUUID } from "node:crypto"

import { and, eq, isNotNull } from "drizzle-orm"
import { z } from "zod"

import { getDb } from "@/lib/db"
import { reportTemplates, reportTemplateVersions } from "@/lib/db/schema"
import {
  STARTER_TEMPLATES,
  STARTER_TEMPLATE_COUNT,
} from "@/lib/templates/starters"
import { definitionSha256 } from "@/lib/templates/version"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import { sectionByKey } from "@/lib/profiles/sections"
import { DEFAULT_PRESET_NAME, expandPreset } from "@/lib/profiles/presets"

/**
 * Fill each section's `metrics` from the catalogue's default preset.
 *
 * `starters.ts` writes `metrics: []` and cannot do better: expansion needs the
 * Metric_Catalog and the Section_Catalogue, both `server-only`, and that module is
 * deliberately client-safe so a starter can be previewed without dragging a server
 * module into the bundle. This module is `server-only`, so the expansion happens
 * here — at the one point where a starter stops being a plain value and becomes a
 * STORED, pinnable definition.
 *
 * That distinction is the whole point. A stored section with no metrics requests
 * none, so the collector asks Azure for nothing, produces no statistic, and the run
 * fails `NO_STATISTICS` with an empty `collection_log` — which is what all three
 * shipped starters did. And the metrics are written IN rather than referenced by
 * preset name because `load_catalog()` reads the catalogue baked into the running
 * image: a stored name would resolve against whatever build replays the run, and
 * replay demands a byte-identical ledger, so editing a preset later would fail
 * replay on reports that were correct when they were issued.
 *
 * A section the catalogue does not know, or one whose entry declares no matching
 * preset, keeps its empty array rather than being dropped — the definition's shape
 * is `starters.ts`'s decision, not this function's.
 */
function withPresetMetrics<T>(definition: T): T {
  const record = definition as unknown as Record<string, unknown>
  const sections = record.sections
  if (!Array.isArray(sections)) return definition

  return {
    ...record,
    sections: sections.map((section) => {
      if (typeof section !== "object" || section === null) return section
      const entry = section as Record<string, unknown>
      if (typeof entry.type !== "string") return section

      const catalogueEntry = sectionByKey(entry.type)
      if (catalogueEntry === undefined) return section

      const metrics = expandPreset(
        catalogueEntry,
        DEFAULT_PRESET_NAME,
        METRIC_CATALOG
      )
      if (metrics.length === 0) return section

      return { ...entry, metrics }
    }),
  } as unknown as T
}

/**
 * Seeding the three starter templates at account creation (Requirements 10.2,
 * 10.4, 10.6, 10.7).
 *
 * `import "server-only"` first: this module opens a connection.
 *
 * ## Why this is its own module rather than a function on `lib/templates/store.ts`
 *
 * The store's two write paths and this one want different things from the same
 * two tables, and bending either to serve both would weaken it:
 *
 *   * `createTemplate` inserts an ordinary template — no `seeded_starter_key`,
 *     no conflict target, and no version. `insertVersion` computes `version` as
 *     `max + 1`, deduplicates against the highest existing digest, and retries a
 *     `(template_id, version)` race up to three times. **None of that applies
 *     here**: a starter's version is always exactly 1, there is no earlier
 *     version to dedupe against, and the race the store settles cannot happen
 *     because this runs once, before any other writer knows the template id.
 *   * This seeder needs `ON CONFLICT (user_id, seeded_starter_key) DO NOTHING`
 *     (Requirement 10.4) and needs all three starters inside **one**
 *     transaction (Requirement 10.6). `insertVersion` deliberately opens its own
 *     transaction per call and carries no conflict target, so reusing it would
 *     mean three independent transactions — precisely the arrangement
 *     Requirement 10.6 forbids, because a failure at the third would leave the
 *     first two committed.
 *
 * So the seeder issues its own statements, and the store keeps exposing no
 * operation that could modify a version row (Requirement 9.3) — a property that
 * would have had to be re-argued had `insertVersion` grown a conflict clause and
 * a caller-supplied version number.
 *
 * ## All three, or none (Requirement 10.6)
 *
 * One `db.transaction`. Requirement 10.6 says a failure after fewer than three
 * inserts retains **no** partially inserted starter template or starter version
 * row, and the only way to mean that is one transaction wrapping all six
 * inserts and the three `current_version_id` updates. A per-starter transaction
 * would satisfy a weaker reading — "no partial *starter*" — while leaving a user
 * holding one of three, which is worse than holding none: the composer would
 * look seeded, and the two missing examples would look deleted.
 *
 * The rollback is what makes the second half of Requirement 10.6 true for free.
 * A user with zero templates can author one through the wizard exactly as a
 * user with three can; nothing about the failure leaves the template tables in
 * a state that blocks a write.
 *
 * ## Two layers of idempotency, for two different situations
 *
 * **The pre-check** — if the user already owns *any* `report_templates` row, this
 * returns without inserting. That is what makes Requirement 10.7's "a deleted
 * starter is never resurrected" hold even against a caller that invoked the
 * seeder a second time: a user who deleted one starter still owns the other two,
 * so a later call declines rather than re-inserting the deleted one. Scoped to
 * "any template" rather than "any starter" on purpose — a user who deleted all
 * three and authored their own template has still been seeded, and re-seeding
 * them would resurrect three rows they removed.
 *
 * **`ON CONFLICT (user_id, seeded_starter_key) DO NOTHING`** — the backstop the
 * pre-check cannot provide, because two concurrent registrations of one account
 * would both read an empty template set. The database is the only thing that can
 * settle that, and `DO NOTHING` settles it without an error: the loser inserts
 * nothing, `RETURNING` yields no row, and this function counts it as
 * already-present rather than as a failure.
 *
 * ## Failure is a returned value, and never fails the registration
 *
 * Requirement 10.6 requires the user to stay able to author a template, which
 * means a seeding failure must not roll back the account. `registerAction`
 * inserts the `users` row and commits it, creates the session, and *then* calls
 * this function — so the transaction here is the only thing a failure can undo.
 * This function therefore **never throws**: it returns a
 * {@link StarterSeedingOutcome}, and the caller has nothing to catch on a path
 * that must reach its `redirect`.
 *
 * ### Where the "could not be initialized" statement lives
 *
 * Requirement 10.6 also requires *stating* that the starters could not be
 * initialized, and this task deliberately does not invent a banner for it.
 * `registerAction` redirects on success, and after a redirect the form that would
 * render an `AuthActionState` is gone — so there is no honest way to return the
 * sentence from the action that noticed the failure.
 *
 * What this task owns is therefore the **server-side signal plus a defined way
 * for a surface to detect it**:
 *
 *   * the failure is logged with the `[starters]` marker and the SQLSTATE code,
 *     redacted the way every other store in this codebase redacts a write
 *     failure — the authoritative record that a seeding failed;
 *   * {@link readSeededStarterKeys} reports which starters a user actually
 *     holds, so a surface can compare against `STARTER_KEYS` and state the
 *     shortfall from the row rather than from a transient flash;
 *   * {@link STARTERS_UNINITIALIZED_NOTICE} is the sentence to render.
 *
 * The **notice surface itself belongs to task 13.2**, the `/templates` list —
 * that is the screen a first-time user reaches, and it already has to render an
 * empty state. Wiring a half-connected banner into the dashboard now would put
 * the statement on a screen that is not about templates and would have to be
 * moved. The notice is worded as "could not be initialized, or have since been
 * removed" because a user who deleted all three reaches the same state, and
 * asserting a failure that may not have happened would be the same category of
 * quiet dishonesty this product exists to eliminate.
 */

// --- The outcome ------------------------------------------------------------

export type StarterSeedingOutcome =
  | {
      readonly ok: true
      /** 3 on a fresh account, 0 when the user was already seeded. */
      readonly inserted: number
      /** Why nothing was inserted, when `inserted` is 0. */
      readonly reason?: "already_initialized"
    }
  | {
      readonly ok: false
      /** The SQLSTATE class of the failure, or `unknown`. Carries no value. */
      readonly code: string
      readonly message: string
    }

/**
 * Requirement 10.6's statement, for whichever surface renders it (task 13.2).
 *
 * Names no user, no id and no driver detail, so it is safe to render and safe to
 * log verbatim.
 */
export const STARTERS_UNINITIALIZED_NOTICE =
  "The three starter templates could not be initialized for this account, or " +
  "have since been removed. You can still author a template from scratch."

// --- Driver errors ----------------------------------------------------------

/** The one field read off a node-postgres error. It carries no bound value. */
const driverErrorSchema = z.object({ code: z.string().optional() })

/** Just enough of an error to walk one link of the `cause` chain. */
const causeSchema = z.object({ cause: z.unknown() })

/** Depth bound, so a self-referential `cause` cannot spin. */
const MAX_CAUSE_DEPTH = 5

/**
 * The Postgres error code from a thrown value, or `undefined`.
 *
 * Walks the `cause` chain because drizzle wraps every driver failure in a
 * `DrizzleQueryError` and puts the original underneath. Structural, via zod,
 * rather than `instanceof DatabaseError`, for the reason `lib/templates/store.ts`
 * gives: an `instanceof` against a class imported here fails silently if the
 * driver instance differs.
 *
 * Only the **code** is read, never the message: `DrizzleQueryError`'s message is
 * `Failed query: <sql> params: <params>`, and the parameters of the inserts
 * below carry the whole starter definition. A log line is not a place to put a
 * few kilobytes of JSON.
 */
function driverErrorCode(thrown: unknown): string | undefined {
  let frame: unknown = thrown

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    const fields = driverErrorSchema.safeParse(frame)
    if (fields.success && fields.data.code !== undefined)
      return fields.data.code

    const wrapper = causeSchema.safeParse(frame)
    if (!wrapper.success) return undefined

    frame = wrapper.data.cause
    if (frame === undefined || frame === null) return undefined
  }

  return undefined
}

// --- Reads -----------------------------------------------------------------

/**
 * The `seeded_starter_key` values this user currently holds.
 *
 * The detection surface described in the module docstring: a caller compares
 * this against `STARTER_KEYS` and renders
 * {@link STARTERS_UNINITIALIZED_NOTICE} for the shortfall. Reads the row rather
 * than a flash, so a reconnecting or refreshing client sees the same answer.
 *
 * Scoped by `user_id` like every other read of this table, and projects only
 * the key — no name, no definition, no digest.
 */
export async function readSeededStarterKeys(
  userId: string
): Promise<readonly string[]> {
  const rows = await getDb()
    .select({ seededStarterKey: reportTemplates.seededStarterKey })
    .from(reportTemplates)
    .where(
      and(
        eq(reportTemplates.userId, userId),
        isNotNull(reportTemplates.seededStarterKey)
      )
    )

  return rows
    .map(({ seededStarterKey }) => seededStarterKey)
    .filter((key): key is string => key !== null)
}

// --- The seeder ------------------------------------------------------------

/**
 * Insert this user's three starter templates, each with its `version` 1 and its
 * `current_version_id` set, in one transaction (Requirements 10.2, 10.4, 10.6).
 *
 * Never throws. Call it **after** the `users` row has committed, from a path
 * that must go on to redirect.
 *
 * `definition_sha256` is computed here through
 * `lib/templates/version.ts` — the same RFC 8785 canonicalization and SHA-256 a
 * wizard-authored version gets (Requirement 9.4) — rather than being written
 * into `starters.ts` as a literal. A hand-copied digest is a digest nothing
 * verifies, and it would silently stop matching its definition the first time a
 * starter is edited.
 */
export async function seedStarterTemplates(
  userId: string
): Promise<StarterSeedingOutcome> {
  try {
    return await getDb().transaction(async (tx) => {
      // The pre-check. `LIMIT 1` over any template of this user, not only a
      // seeded one — see the module docstring on why a user who deleted all
      // three starters is still a seeded user.
      const [existing] = await tx
        .select({ id: reportTemplates.id })
        .from(reportTemplates)
        .where(eq(reportTemplates.userId, userId))
        .limit(1)

      if (existing !== undefined) {
        return {
          ok: true as const,
          inserted: 0,
          reason: "already_initialized" as const,
        }
      }

      let inserted = 0

      for (const starter of STARTER_TEMPLATES) {
        const definition = withPresetMetrics(starter.definition)
        const templateId = randomUUID()

        const [template] = await tx
          .insert(reportTemplates)
          .values({
            id: templateId,
            userId,
            name: definition.identity.name,
            description: definition.identity.description ?? "",
            seededStarterKey: starter.seededStarterKey,
          })
          // Requirement 10.4. The race the pre-check above cannot settle: two
          // concurrent registrations both read an empty template set, and the
          // database lets exactly one insert win. `DO NOTHING` rather than an
          // error, so the loser is "already present" rather than a failure that
          // would roll back a registration.
          .onConflictDoNothing({
            target: [reportTemplates.userId, reportTemplates.seededStarterKey],
          })
          .returning({ id: reportTemplates.id })

        // No row returned means the conflict fired: this starter already exists
        // for this user, so its version must not be inserted either.
        if (template === undefined) continue

        const versionId = randomUUID()

        await tx.insert(reportTemplateVersions).values({
          id: versionId,
          templateId,
          // Requirement 10.2 — a starter's first version is 1, always. There is
          // no earlier version to compute `max + 1` from.
          version: 1,
          definition,
          definitionSha256: definitionSha256(definition),
        })

        // Requirement 10.2 — `current_version_id` points at that version. In the
        // same transaction as the insert, so no committed state exists in which
        // a seeded starter has a version and does not name it.
        await tx
          .update(reportTemplates)
          .set({ currentVersionId: versionId })
          .where(eq(reportTemplates.id, templateId))

        inserted += 1
      }

      return { ok: true as const, inserted }
    })
  } catch (thrown) {
    const code = driverErrorCode(thrown) ?? "unknown"

    // The authoritative record that a seeding failed. The code names the class
    // of failure (`23505` unique violation, `23502` not-null, `08006`
    // connection failure); nothing else from the driver is logged, because the
    // statement's parameters carry the whole definition.
    console.error(
      `[starters] seeding the ${STARTER_TEMPLATE_COUNT} starter templates failed (postgres ${code})`
    )

    return { ok: false, code, message: STARTERS_UNINITIALIZED_NOTICE }
  }
}
