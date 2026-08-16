import "server-only"

import { randomUUID } from "node:crypto"

import { and, asc, desc, eq } from "drizzle-orm"
import { z } from "zod"

import { getDb } from "@/lib/db"
import {
  reportTemplates,
  reportTemplateVersions,
  type NewReportTemplate,
  type ReportTemplate,
  type ReportTemplateVersion,
} from "@/lib/db/schema"

/**
 * Every read and write of `report_templates` and `report_template_versions`
 * (Requirements 1.4, 1.5, 1.6, 1.7, 1.9, 9.2, 9.3, 9.5, 9.11, 9.12, 10.7, 11.4).
 *
 * `import "server-only"` is the first line and stays there: this module opens
 * a connection, and a client component importing it should be a build error
 * rather than a review comment.
 *
 * ## The two invariants this module exists to hold
 *
 * **Every operation is scoped by `user_id`** (Requirement 1.4). A template
 * carries `user_id` directly; a version does not, so every version operation
 * first re-proves ownership of the version's *template* before touching the
 * version — see {@link readOwnedTemplate}. There is no exported function that
 * reaches either table by primary key alone. A row belonging to another user
 * resolves as **not found** (Requirement 1.5) — not as forbidden, and
 * byte-identical to the response for an id that exists for no row at all — the
 * same rule `lib/subscriptions/store.ts` and `lib/runs/state.ts` follow: a
 * "forbidden" answer confirms the row exists, and existence is itself a fact
 * about somebody else's report.
 *
 * **A `report_template_versions` row is written once and never again**
 * (Requirement 9.3). This module exposes exactly two operations that touch
 * that table — {@link insertVersion} and {@link readVersion} (plus
 * {@link readLatestVersion}, a second read) — and no operation that updates or
 * deletes a version row. That is not a rule this module remembers to follow;
 * it is the whole of what this module can do to that table, so a modification
 * attempted through any operation this module exposes is refused by the
 * absence of a code path that could perform one, and the module's own test
 * suite asserts that absence directly rather than trusting a comment.
 *
 * Write failures are re-thrown **redacted**, for the same reason
 * `lib/subscriptions/store.ts` and `lib/actions/runs.ts` redact their own:
 * drizzle wraps a driver failure in a `DrizzleQueryError` whose message
 * carries the statement *and its bound parameters* — here, the full
 * definition `jsonb` blob on every version insert. Re-throwing that verbatim
 * writes a customer's report structure into a server log.
 */

// --- Errors -------------------------------------------------------------

/**
 * No template with that id belongs to the signed-in user (Requirement 1.5).
 *
 * One error for two situations that must be **indistinguishable**: the
 * template does not exist, and the template exists and belongs to somebody
 * else. The message names no id and no user, so it is safe to log verbatim
 * and discloses nothing when it reaches a response.
 */
export class TemplateNotFoundError extends Error {
  constructor() {
    super("No report template with that id belongs to the signed-in user.")
    this.name = "TemplateNotFoundError"
  }
}

/**
 * The template exists and is this user's, but carries no version at that
 * number.
 *
 * Distinct from {@link TemplateNotFoundError} because it is reached only
 * *after* ownership is already proved (Requirement 1.5): {@link readVersion}
 * checks the template first, so this error means the version number itself —
 * never the owner — is what did not resolve. The message names neither the
 * template id nor the version number, for the same disclosure reasoning as
 * every other not-found error in this module.
 */
export class TemplateVersionNotFoundError extends Error {
  constructor() {
    super("That template carries no version at that number.")
    this.name = "TemplateVersionNotFoundError"
  }
}

/**
 * {@link insertVersion} could not settle the `(template_id, version)` race
 * within its retry budget (Requirement 9.11).
 *
 * Not a bug and not the caller's mistake: two saves of the same template were
 * committed concurrently, both computed the same next `version`, and the
 * database let exactly one of them win at every attempt this call made. The
 * remedy is to retry the *save*, from a caller that will re-read whatever
 * state the winner left — retrying inside this function indefinitely would
 * turn a rare race into an unbounded loop on the one path a user is waiting
 * on.
 */
export class TemplateVersionSequencingError extends Error {
  constructor() {
    super(
      "This template version could not be sequenced — another save is " +
        "racing this one. Retrying the save should resolve it."
    )
    this.name = "TemplateVersionSequencingError"
  }
}

// --- Driver errors --------------------------------------------------------

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505"

/**
 * The constraint drizzle-kit generated for `(template_id, version)`, as it
 * appears in `lib/db/migrations/0002_chubby_smasher.sql`.
 *
 * Requirement 9.11 is about **this** constraint. Matching on SQLSTATE alone
 * would map any future unique violation on this table to "sequencing
 * conflict", which is a false statement about a different failure.
 */
const VERSION_SEQUENCE_CONSTRAINT =
  "report_template_versions_template_id_version_uq"

/** The two fields read off a node-postgres error; neither carries a value. */
const driverErrorSchema = z.object({
  code: z.string().optional(),
  constraint: z.string().optional(),
})

/** Just enough of an error to walk one link of the `cause` chain. */
const causeSchema = z.object({ cause: z.unknown() })

/** Depth bound, so a self-referential `cause` cannot spin. */
const MAX_CAUSE_DEPTH = 5

/**
 * The Postgres error code and constraint from a thrown value, or `undefined`.
 *
 * Walks the `cause` chain because drizzle 0.45 wraps every driver failure in
 * a `DrizzleQueryError` and puts the original underneath — the code is never
 * on the frame that is thrown. Structural, via zod, rather than
 * `instanceof DatabaseError`, for the reason every other store in this
 * codebase gives: an `instanceof` against a class imported here fails
 * silently if the driver instance differs, and that failure mode is a UNIQUE
 * violation escaping as a 500 on the one path Requirement 9.11 is about.
 *
 * A fourth implementation of the same walk (`lib/actions/auth.ts`,
 * `lib/actions/runs.ts` and `lib/subscriptions/store.ts` have the others).
 * The duplication is imposed rather than chosen: `auth.ts` carries a
 * file-level `"use server"` directive and cannot export a synchronous
 * helper, and factoring the walk out of any of the three would couple
 * unrelated stores to one shared module for eight lines.
 */
function driverError(
  thrown: unknown
): { code: string; constraint: string | undefined } | undefined {
  let frame: unknown = thrown

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    const fields = driverErrorSchema.safeParse(frame)
    if (fields.success && fields.data.code !== undefined) {
      return { code: fields.data.code, constraint: fields.data.constraint }
    }

    const wrapper = causeSchema.safeParse(frame)
    if (!wrapper.success) return undefined

    frame = wrapper.data.cause
    if (frame === undefined || frame === null) return undefined
  }

  return undefined
}

/** Requirement 9.11 — the insert lost the race for this `(template, version)` pair. */
function isVersionSequenceConflict(thrown: unknown): boolean {
  const error = driverError(thrown)

  return (
    error?.code === UNIQUE_VIOLATION &&
    error.constraint === VERSION_SEQUENCE_CONSTRAINT
  )
}

/**
 * A replacement error carrying the operation and the SQLSTATE code and
 * **nothing else**.
 *
 * The original is dropped rather than attached as `cause`, for the reason
 * every other store in this codebase drops its own: `DrizzleQueryError`'s
 * message is `Failed query: <sql> params: <params>`, and the parameters of
 * every write below include the definition `jsonb` blob. The SQLSTATE code
 * names the class of failure (`23502` not-null, `42P01` undefined table,
 * `08006` connection failure) without carrying a value.
 */
function redactedWriteError(operation: string, thrown: unknown): Error {
  const code = driverError(thrown)?.code
  const suffix = code === undefined ? "" : ` (postgres ${code})`

  return new Error(`[templates] ${operation} failed${suffix}`)
}

// --- Ownership -------------------------------------------------------------

/**
 * One template row, scoped to its owner (Requirements 1.4, 1.5).
 *
 * Module-private, and the **only** place a `report_templates` row is read by
 * id in this file, so there is exactly one place where the `user_id`
 * predicate could be forgotten. Every version operation calls this first —
 * `report_template_versions` carries no `user_id` of its own, so proving
 * ownership of a version means proving ownership of the template it belongs
 * to, and this is where that proof happens.
 *
 * Returns `undefined` for "no such row for this user", which every exported
 * function turns into {@link TemplateNotFoundError}. The `AND` is what makes
 * the two cases — absent and somebody else's — one answer: another user's id
 * matches no row here, so no field of it is read, let alone returned.
 */
async function readOwnedTemplate(
  userId: string,
  id: string
): Promise<ReportTemplate | undefined> {
  const [row] = await getDb()
    .select()
    .from(reportTemplates)
    .where(and(eq(reportTemplates.id, id), eq(reportTemplates.userId, userId)))
    .limit(1)

  return row
}

// --- Create -----------------------------------------------------------------

/** What creating a template needs. Both fields the Template_Validator bounds. */
export type CreateTemplateInput = {
  readonly name: string
  readonly description?: string
}

/**
 * Insert one `report_templates` row, carrying no version and no draft
 * (Requirement 1.1).
 *
 * `currentVersionId` starts `null` — a template created here has no version
 * until {@link insertVersion} gives it one — and `draftDefinition` starts
 * `null`, so a brand-new template is a valid, empty draft rather than a
 * definition that happens to be missing.
 */
export async function createTemplate(
  userId: string,
  input: CreateTemplateInput
): Promise<ReportTemplate> {
  const values: NewReportTemplate = {
    id: randomUUID(),
    userId,
    name: input.name,
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
  }

  try {
    const [row] = await getDb()
      .insert(reportTemplates)
      .values(values)
      .returning()

    // Unreachable through the driver — an `INSERT ... RETURNING` that raised
    // nothing returned the row — but the caller needs a row rather than a
    // `row!`, and an assertion here would be a claim this module cannot back.
    if (row === undefined) {
      throw new Error("[templates] the insert returned no row")
    }

    return row
  } catch (thrown) {
    throw redactedWriteError("creating a template", thrown)
  }
}

// --- Reads -------------------------------------------------------------

/**
 * Every template this user owns (Requirement 1.4).
 *
 * Ordered by `created_at` then `id`: `created_at` is the order a consultant
 * created them in, and the id breaks a tie so two rows written in the same
 * transaction do not swap places between renders.
 */
export async function listTemplates(
  userId: string
): Promise<ReportTemplate[]> {
  return await getDb()
    .select()
    .from(reportTemplates)
    .where(eq(reportTemplates.userId, userId))
    .orderBy(asc(reportTemplates.createdAt), asc(reportTemplates.id))
}

/**
 * One template row.
 *
 * Throws {@link TemplateNotFoundError} for an id that is not this user's
 * (Requirement 1.5) — the same error an absent id gets, so a probe learns
 * nothing from the difference.
 */
export async function getTemplate(
  userId: string,
  id: string
): Promise<ReportTemplate> {
  const row = await readOwnedTemplate(userId, id)
  if (row === undefined) throw new TemplateNotFoundError()

  return row
}

// --- The draft --------------------------------------------------------------

/**
 * Write the wizard's in-progress definition and insert no version row
 * (Requirement 11.4).
 *
 * `draft_definition` is a column on `report_templates`, not a row on
 * `report_template_versions` (Requirement 9.2's boundary reflected in the
 * schema): a draft must not consume a version number, so this function
 * touches one table and never the other. It persists whether or not the
 * draft yet satisfies the at-least-one-block rule and whether or not it is
 * valid at all — that validation is `Template_Validator`'s, not this store's.
 *
 * Scoped like every write here: another user's id applies no write and
 * raises {@link TemplateNotFoundError} (Requirement 1.5).
 */
export async function saveDraft(
  userId: string,
  id: string,
  draftDefinition: unknown
): Promise<ReportTemplate> {
  let rows: ReportTemplate[]

  try {
    rows = await getDb()
      .update(reportTemplates)
      .set({ draftDefinition })
      .where(
        and(eq(reportTemplates.id, id), eq(reportTemplates.userId, userId))
      )
      .returning()
  } catch (thrown) {
    throw redactedWriteError("saving a draft", thrown)
  }

  const [row] = rows
  if (row === undefined) throw new TemplateNotFoundError()

  return row
}

// --- Versions ----------------------------------------------------------

/** What inserting a version needs. Both fields already validated by the caller. */
export type InsertVersionInput = {
  /** The validated definition this version pins. */
  readonly definition: unknown
  /**
   * RFC 8785 (JCS) canonicalization of `definition`, SHA-256 hex
   * (Requirement 9.4) — computed by the caller (`lib/templates/version.ts`),
   * not by this store. This module's job is sequencing and immutability, not
   * canonicalization.
   */
  readonly definitionSha256: string
}

/**
 * Retried at most this many times after the first attempt (Requirement
 * 9.11), each retry re-resolving the highest existing `version` afresh. Three
 * is enough to settle a race between a small handful of concurrent saves of
 * one template — a scenario with no legitimate reason to be larger than a
 * few — without turning a genuine, unresolvable conflict into a long spin on
 * the one request a user is waiting on.
 */
const MAX_VERSION_INSERT_RETRIES = 3

/** The highest existing version row for a template, or `undefined` if none. */
async function readHighestVersionRow(
  templateId: string
): Promise<ReportTemplateVersion | undefined> {
  const [row] = await getDb()
    .select()
    .from(reportTemplateVersions)
    .where(eq(reportTemplateVersions.templateId, templateId))
    .orderBy(desc(reportTemplateVersions.version))
    .limit(1)

  return row
}

/**
 * One attempt: read the current highest version, dedup against it, and
 * either return it unchanged or insert the next one and point the template
 * at it.
 *
 * Everything here runs in one transaction, so a template that gains a new
 * version never has a moment where `current_version_id` points at an older
 * row than the one just inserted, and a `version` conflict rolls back both
 * statements rather than leaving an inserted row whose template was not
 * updated to match.
 *
 * Returns `{ conflict: true }` rather than throwing when the insert loses the
 * `(template_id, version)` race, so the caller can retry without this
 * function's own transaction and this function's own read of the previous
 * attempt's stale `version` getting confused for one another.
 */
async function attemptInsertVersion(
  templateId: string,
  input: InsertVersionInput
): Promise<
  { readonly conflict: false; readonly row: ReportTemplateVersion } | { readonly conflict: true }
> {
  try {
    return await getDb().transaction(async (tx) => {
      const [highest] = await tx
        .select()
        .from(reportTemplateVersions)
        .where(eq(reportTemplateVersions.templateId, templateId))
        .orderBy(desc(reportTemplateVersions.version))
        .limit(1)

      // Requirement 9.5 — a save that changed nothing creates no version, and
      // issues no UPDATE and no DELETE against the existing row: this branch
      // performs no write at all.
      if (
        highest !== undefined &&
        highest.definitionSha256 === input.definitionSha256
      ) {
        return { conflict: false, row: highest }
      }

      const nextVersion = (highest?.version ?? 0) + 1

      const [inserted] = await tx
        .insert(reportTemplateVersions)
        .values({
          id: randomUUID(),
          templateId,
          version: nextVersion,
          definition: input.definition,
          definitionSha256: input.definitionSha256,
        })
        .returning()

      if (inserted === undefined) {
        throw new Error("[templates] the version insert returned no row")
      }

      await tx
        .update(reportTemplates)
        .set({ currentVersionId: inserted.id })
        .where(eq(reportTemplates.id, templateId))

      return { conflict: false, row: inserted }
    })
  } catch (thrown) {
    if (isVersionSequenceConflict(thrown)) {
      return { conflict: true }
    }
    throw redactedWriteError("saving a template version", thrown)
  }
}

/**
 * Insert the next immutable version of a template, or return the existing
 * highest version unchanged (Requirements 9.2, 9.3, 9.5, 9.11, 9.12).
 *
 * `version` is computed as the highest existing `version` for this
 * `template_id` plus exactly 1 (Requirement 9.2). No path in this function
 * issues an `UPDATE` or a `DELETE` against an existing
 * `report_template_versions` row — the only write to that table is the one
 * `INSERT` inside {@link attemptInsertVersion}.
 *
 * When the submitted canonical digest equals the existing highest version's
 * `definition_sha256`, this inserts nothing and returns that existing version
 * (Requirement 9.5): a save that changed nothing creates no version.
 *
 * On a `(template_id, version)` UNIQUE violation — two saves computing the
 * same next version concurrently — this re-resolves the highest existing
 * version and retries, up to {@link MAX_VERSION_INSERT_RETRIES} times, before
 * throwing {@link TemplateVersionSequencingError} (Requirement 9.11). There is
 * deliberately no pre-check that tries to avoid the race: the database is the
 * only thing that can settle which concurrent save wins, so the loop's whole
 * job is to notice a loss and ask again, not to predict one.
 *
 * Scoped like every write here: another user's id applies no write and
 * raises {@link TemplateNotFoundError} (Requirement 1.5), checked once before
 * any retry attempt rather than inside the loop.
 */
export async function insertVersion(
  userId: string,
  templateId: string,
  input: InsertVersionInput
): Promise<ReportTemplateVersion> {
  const template = await readOwnedTemplate(userId, templateId)
  if (template === undefined) throw new TemplateNotFoundError()

  for (let attempt = 0; attempt <= MAX_VERSION_INSERT_RETRIES; attempt += 1) {
    const result = await attemptInsertVersion(templateId, input)
    if (!result.conflict) return result.row
  }

  throw new TemplateVersionSequencingError()
}

/**
 * One version of a template, by its `version` number.
 *
 * Ownership is checked first, against the *template* (Requirement 1.5) — a
 * version row carries no `user_id` of its own — and only then is the version
 * looked up. Throws {@link TemplateNotFoundError} for a template that is not
 * this user's, and {@link TemplateVersionNotFoundError} for a template that is
 * this user's but carries no version at that number. The two are distinct
 * error types because the second is reachable only after ownership already
 * held, never as a substitute disclosure for the first.
 */
export async function readVersion(
  userId: string,
  templateId: string,
  version: number
): Promise<ReportTemplateVersion> {
  const template = await readOwnedTemplate(userId, templateId)
  if (template === undefined) throw new TemplateNotFoundError()

  const [row] = await getDb()
    .select()
    .from(reportTemplateVersions)
    .where(
      and(
        eq(reportTemplateVersions.templateId, templateId),
        eq(reportTemplateVersions.version, version)
      )
    )
    .limit(1)

  if (row === undefined) throw new TemplateVersionNotFoundError()

  return row
}

/**
 * The highest-numbered version of a template, or `undefined` when it carries
 * none yet.
 *
 * `undefined` rather than a thrown error for "no version yet": a template
 * with zero versions is an ordinary, valid state — a draft that has not
 * reached step 7 of the wizard — and is not the same fact as "no such
 * template", which stays {@link TemplateNotFoundError}.
 *
 * Scoped like every read here (Requirement 1.5). This is the read the
 * Enqueue_Action resolves a run's `template_version_id` from (Requirement
 * 9.6): the highest version *as of that read*, never a cached
 * `current_version_id` that could have gone stale between two requests.
 */
export async function readLatestVersion(
  userId: string,
  templateId: string
): Promise<ReportTemplateVersion | undefined> {
  const template = await readOwnedTemplate(userId, templateId)
  if (template === undefined) throw new TemplateNotFoundError()

  return await readHighestVersionRow(templateId)
}
