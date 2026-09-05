import { z } from "zod"

/**
 * The named boundary schemas for the run routes (Requirements 7.7, 37.1).
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no database, no
 * environment, no secret: a request body in, a parsed value out. The run form is a
 * client leaf, and the bounds it renders come from here so a field hint and a
 * route cannot describe different rules.
 *
 * It reads no clock, and since task 13.1 it parses no period at all: the window a
 * run collects is resolved from the **pinned template version** at enqueue
 * (Requirement 4.3), not submitted. See the note above the re-exports at the foot
 * of this file for what that removed and why.
 *
 * ## What is deliberately absent
 *
 * **No `userId`.** Every run is scoped to the signed-in user, resolved from the
 * session by the route (Requirements 36.10, 41.11). A field for it would be a
 * field a caller could set, and `actor_id` is what prefixes every artifact key.
 *
 * **No `dedupeKey`, no `progressToken`, no `status`.** All three are derived
 * server-side. A submitted `dedupe_key` would let a caller collide with somebody
 * else's run or opt out of the idempotency guard by varying it; a submitted token
 * would be a caller minting its own credential for the state machine.
 *
 * **No `runId`.** The row's id is minted at insert. A caller-chosen id is how two
 * users end up racing for one primary key.
 */

// --- Front-matter per-run values (Requirement 13.7) -------------------------

/**
 * The customer name for the cover and document-control pages. Bounded to reject
 * a pathological string while accepting any plausible business name.
 */
export const MAX_CUSTOMER_NAME_LENGTH = 200

/**
 * The revision note for the revision history table. Bounded but generous — a
 * note is one line, and 500 characters is more than a line needs.
 */
export const MAX_REVISION_NOTE_LENGTH = 500

/**
 * The revision label ("1.0", "Rev B") and the author name.
 *
 * Named rather than inline in the schema below, for the reason stated at the top of
 * this module: the run form renders these bounds as `maxLength`, so a constant here
 * is what stops the field and the route describing different rules. They were inline
 * while no surface collected them; the form that collects them is what made the
 * duplication reachable.
 */
export const MAX_REVISION_LENGTH = 100
export const MAX_REVISION_AUTHOR_LENGTH = 200

/**
 * The strict schema for one revision-history row: `revision`, `note` and
 * `author`, all non-empty bounded strings.
 *
 * `.strict()` so an undeclared key is rejected rather than silently stripped.
 */
export const revisionHistoryRowSchema = z
  .object({
    revision: z.string().trim().min(1).max(MAX_REVISION_LENGTH),
    note: z.string().trim().min(1).max(MAX_REVISION_NOTE_LENGTH),
    author: z.string().trim().min(1).max(MAX_REVISION_AUTHOR_LENGTH),
  })
  .strict()

export type RevisionHistoryRow = z.output<typeof revisionHistoryRowSchema>

// --- The period -------------------------------------------------------------

/**
 * Requirement 37.10 — the accepted period length, in **local** days inclusive.
 *
 * 1 is a single-day report, which is a legitimate spot check. 31 is the longest
 * calendar month, which is the unit this product is actually about — and it is
 * also where the collector's scaling assumptions were measured (200 resources × 6
 * metrics × 31 days at `PT1H`). A 90-day window is a different collection problem,
 * not a longer version of this one.
 */
export const MIN_PERIOD_DAYS = 1
export const MAX_PERIOD_DAYS = 31

/**
 * The rejection message, stating the accepted range as Requirement 37.10 demands.
 *
 * One message for inverted, too short, too long and ending in the future. They are
 * the same answer to the consultant — "that is not a period we can collect" — and
 * splitting it into four would put four sentences in the UI for one field pair.
 */
export const PERIOD_MESSAGE =
  `Choose a period of ${MIN_PERIOD_DAYS} to ${MAX_PERIOD_DAYS} local days ` +
  `whose last day is at or before today in the report's timezone. A period is ` +
  `local: "July 2026" means July in that zone, not July in UTC.`

/**
 * An IANA zone name.
 *
 * Bounded and non-empty, and validated for real by {@link isSupportedTimeZone}
 * rather than against a list: the set of zones is the platform's, it changes with
 * the tzdata the runtime ships, and a hardcoded list here would start rejecting a
 * zone the collector can bucket perfectly well.
 */
const timezoneSchema = z.string().trim().min(1).max(64)

// --- The submission ---------------------------------------------------------

/** A bound on the path and body id fields, so a pathological URL is refused. */
export const RUN_ID_PARAM_MAX_LENGTH = 200

export const RUN_ID_PARAM_MESSAGE =
  "The report run id is missing from the request path."

/**
 * `POST /api/runs` (Requirements 7.7, 37.1).
 *
 * `timezone` defaults to `Asia/Jakarta` — the customer's zone, and the default the
 * invoke context carries (Requirement 41.5). It is a field rather than a constant
 * because it decides local-day bucketing and therefore every daily figure, so a
 * run against a customer in another zone has to be able to say so; it is
 * *defaulted* rather than required because leaving it out is the common case and an
 * absent zone must not silently become UTC.
 */
export const runCreateInputSchema = z
  .object({
    connectedSubscriptionId: z
      .string({ error: "Choose a connected subscription to report on." })
      .trim()
      .min(1, { error: "Choose a connected subscription to report on." })
      .max(RUN_ID_PARAM_MAX_LENGTH),

    /**
     * The template to run (Requirement 9.6).
     *
     * The **template**, not a version. The enqueue resolves the highest
     * existing version at insert, so a consultant who saved version 4 an
     * instant ago gets version 4 rather than whichever number the form was
     * rendered against. A submitted version id would also be a way to pin a
     * run to an older definition than the one the wizard is showing, which is
     * a capability nothing has asked for and which would make "what version
     * did this report use" a question with two plausible answers.
     */
    templateId: z
      .string({ error: "Choose a template to run." })
      .trim()
      .min(1, { error: "Choose a template to run." })
      .max(RUN_ID_PARAM_MAX_LENGTH),

    timezone: timezoneSchema.default("Asia/Jakarta"),

    /**
     * The customer name for the front-matter cover and document-control pages
     * (Requirement 13.7). Optional in the schema because the version is resolved
     * at insert and the schema cannot know yet whether it is v2; `enqueueRun`
     * rejects a v2-pinned request missing it.
     */
    customerName: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CUSTOMER_NAME_LENGTH)
      .optional(),

    /**
     * The revision-history row for the document-control page (Requirement 13.7).
     * Optional for the same reason as `customerName`.
     */
    revisionHistoryRow: revisionHistoryRowSchema.optional(),

    /**
     * A completed run of this user's whose snapshot to reuse instead of collecting.
     *
     * Optional, and absent means collect — which is what every caller sent before this
     * existed. A UUID rather than a free string so a malformed id is refused here rather
     * than at the storage read, where the failure would be a missing object and read as
     * a collection problem.
     */
    reuseSnapshotRunId: z.string().uuid().optional(),
  })
  .strict()

export type RunCreateInput = z.output<typeof runCreateInputSchema>

/**
 * Build the `POST /api/runs` body for one submission.
 *
 * **This function is the fix for a defect, and its existence is the point.** The run
 * form built its body inline and sent three fields; `enqueueRun` requires two more
 * once the pinned version turns out to declare `schema_version >= 2` (Requirement
 * 13.14). Both halves were correct about their own side and nothing compared them, so
 * every v2 run was rejected — visibly in the server log, invisibly in the browser,
 * because `internalError()` is fixed text.
 *
 * Extracting it puts the body's shape somewhere **both** a jsdom component test and a
 * node integration test can reach: the form's own suite asserts what it sends, and
 * `test/db/run-form-enqueue-round-trip.integration.test.ts` feeds the output of *this*
 * function to the real `enqueueRun`. Those two tests are only worth something together
 * — the first describes the form, the second proves the form's output is what the
 * enqueue accepts, which is the assertion that was missing.
 *
 * `frontMatter` is `null` for a v1 template, and the revision-history keys are then
 * **absent** rather than empty. `runCreateInputSchema` is `.strict()` with
 * `revisionHistoryRow` `.optional()`, so a blank string would fail its own `min(1)`
 * and a v1 run would start failing for a page it does not have.
 *
 * **`customerName` is deliberately not a parameter here** (Requirement 12.8, 12.9,
 * task 4.4). The run form stopped collecting it — nothing that identifies the
 * customer is asked at run time — and `enqueueRun` now sources it from the pinned
 * version's `identity.customer_name` at `schema_version >= 3` instead. A
 * `schema_version` 2 pin (the only remaining version whose front-matter gate still
 * reads a submitted `customerName`) can no longer be run through this form; that is
 * an accepted consequence of retiring the field everywhere the form touches it,
 * not an oversight.
 *
 * Values are trimmed here, once. The schema trims too, but a caller that gates its
 * submit button on "is this non-empty" and then sends untrimmed text is deciding with
 * a different value than it sends — and three spaces would pass the gate.
 */
export function buildRunCreateBody(fields: {
  readonly connectedSubscriptionId: string
  readonly templateId: string
  readonly timezone: string
  readonly frontMatter: {
    readonly revision: string
    readonly note: string
    readonly author: string
  } | null
  /**
   * A completed run whose snapshot to reuse, when the consultant chose to. Omitted from
   * the body when absent rather than sent as `null`: the schema is `.strict()`, and a key
   * present-and-empty would have to mean something the enqueue does not read.
   */
  readonly reuseSnapshotRunId?: string | null
}): Record<string, unknown> {
  const base = {
    connectedSubscriptionId: fields.connectedSubscriptionId,
    templateId: fields.templateId,
    timezone: fields.timezone,
    ...(fields.reuseSnapshotRunId
      ? { reuseSnapshotRunId: fields.reuseSnapshotRunId }
      : {}),
  }

  if (fields.frontMatter === null) return base

  return {
    ...base,
    revisionHistoryRow: {
      revision: fields.frontMatter.revision.trim(),
      note: fields.frontMatter.note.trim(),
      author: fields.frontMatter.author.trim(),
    },
  }
}

/**
 * `GET /api/runs/[runId]` and `GET /api/runs/[runId]/stream` — a path parameter is
 * input (Requirement 7.7).
 *
 * **A bounded non-empty string, deliberately not `z.uuid()`.** `report_runs.id` is
 * a `text` primary key; a boundary that asserts more than the column does is a
 * boundary that starts rejecting valid rows the day an id is minted any other way.
 *
 * Leaving the shape unasserted also keeps the refusal **uniform**: every id that is
 * not this user's — absent, junk, or somebody else's — resolves as the one
 * not-found answer Requirement 36.11 requires, decided by the `AND user_id`
 * predicate in the statement rather than split across a 400 here and a 404 there. A
 * caller learns nothing from the difference because there is no difference.
 */
export const runIdParamSchema = z
  .object({
    runId: z
      .string({ error: RUN_ID_PARAM_MESSAGE })
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1, { error: RUN_ID_PARAM_MESSAGE })
          .max(RUN_ID_PARAM_MAX_LENGTH, { error: RUN_ID_PARAM_MESSAGE })
      ),
  })
  .strict()

export type RunIdParam = z.output<typeof runIdParamSchema>

/**
 * `GET /api/runs/[runId]` — no query parameters (Requirement 7.7).
 *
 * States positively that the accepted set is empty. `.strict()` makes an
 * unexpected parameter a rejection, for the reason the subscriptions list route
 * gives: a caller passing `?userId=…` is expressing an expectation this route does
 * not honour.
 */
export const runQuerySchema = z.object({}).strict()

// --- Calendar and zone primitives --------------------------------------------

/**
 * Re-exported from `lib/templates/period.ts`, under the names this module has
 * always exported.
 *
 * **What used to be here, and why it is gone.** This module carried a
 * `checkPeriod` implementing foundation Requirement 37.10 over a *submitted*
 * period, alongside the `localDateSchema` and `runScopeSchema` the run
 * submission parsed those fields with. Task 13.1 moved the period and the scope
 * into the pinned template version (Requirements 3.3, 4.3), so no surface
 * submits either any more and nothing called any of the three.
 *
 * They are deleted rather than kept for a future caller. `resolvePeriod` covers
 * the same ground and covers it more strictly — foundation 37.10 permitted a
 * period ending *today*, Requirement 4.5 does not, because the current local day
 * is incomplete and a partial trailing day understates every daily figure. Two
 * period policies where one is reachable is how a field hint and a route come to
 * describe different months.
 */
export {
  isSupportedTimeZone,
  localDateIn,
  inclusiveLocalDaySpan as localDaySpan,
} from "@/lib/templates/period"

// --- The artifact download --------------------------------------------------

/**
 * An upper bound on a submitted S3 key, so a pathological query string cannot become
 * a `GetObject` argument.
 *
 * Generous against the layout the app actually writes — `<uuid>/snapshots/<uuid>/snapshot.json`
 * is around 90 characters — and well inside S3's own 1024-byte key limit, so a key
 * this rejects is a key no object could have.
 */
export const ARTIFACT_KEY_MAX_LENGTH = 512

export const ARTIFACT_KEY_MESSAGE =
  "Name the artifact key to download, as it appears in the run's artifactKeys."

/**
 * `GET /api/artifact-url` (Requirements 7.7, 37.8).
 *
 * One parameter, and `.strict()` so anything else is a rejection. There is
 * deliberately **no `expiresIn` parameter**: Requirement 37.8 caps a presigned URL at
 * 300 seconds, and `MAX_PRESIGN_SECONDS` is the only value the app mints with — a
 * caller-supplied expiry would be a caller choosing how long its own download link
 * stays valid, which is the one number this route exists to decide.
 *
 * The key's *shape* is not validated here beyond a length bound. `parseArtifactKey` and
 * `keyBelongsToActor` in `lib/aws/s3.ts` own that, as an exact segment match against
 * the signed-in user's id — and keeping it there means there is one definition of a
 * well-formed key rather than a schema's approximation of one plus the real check.
 */
export const artifactUrlQuerySchema = z
  .object({
    key: z
      .string({ error: ARTIFACT_KEY_MESSAGE })
      .min(1, { error: ARTIFACT_KEY_MESSAGE })
      .max(ARTIFACT_KEY_MAX_LENGTH, { error: ARTIFACT_KEY_MESSAGE }),
  })
  .strict()

export type ArtifactUrlQuery = z.output<typeof artifactUrlQuerySchema>
