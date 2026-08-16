import { z } from "zod"

/**
 * The named boundary schemas for the run routes (Requirements 7.7, 37.1, 37.10).
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no database, no
 * environment, no secret: a request body in, a parsed value out. The run form is a
 * client leaf, and Requirement 37.10 requires the rejection to *state* the
 * accepted range — so the policy has to be nameable from the browser, or the form
 * re-implements it slightly differently and a field hint and a route come to
 * disagree about the same month.
 *
 * It reads no clock. "Ending at or before the current local date" needs both an
 * instant and a zone, and neither belongs in a schema: the zone is a *field of the
 * submission* — so it is not known until the object is parsed — and the instant is
 * the request's. Both are therefore handed to the pure {@link checkPeriod}, which
 * the enqueue calls after `safeParse` succeeds. That split is what makes every
 * boundary case assertable at an instant and a zone a test picks.
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

// --- The scope --------------------------------------------------------------

/**
 * An upper bound on each scope list, so a pathological body cannot become an
 * unbounded `jsonb` value and an unbounded `dedupe_key` input.
 *
 * Generous against reality: a report over more than a handful of resource types
 * or a few dozen resource groups is a report over the whole subscription, which is
 * expressed by leaving `resource_groups` empty rather than by listing them all.
 */
export const MAX_RESOURCE_TYPES = 20
export const MAX_RESOURCE_GROUPS = 200
export const MAX_TAG_FILTERS = 50

/** A bound on one entry, so a single string cannot carry a megabyte. */
const MAX_SCOPE_ENTRY_LENGTH = 400

const scopeEntrySchema = z.string().trim().min(1).max(MAX_SCOPE_ENTRY_LENGTH)

/**
 * The requested collection scope — the shape `report_runs.scope` persists and the
 * shape the invoke payload's `scope` carries (Requirement 41.8).
 *
 * `resource_types` is required and non-empty. There is no "everything" scope in
 * this spec: the collector needs a metric namespace per resource type, and an
 * empty list would mean either "no resources" — which is `EMPTY_SCOPE`, a hard
 * failure — or a silent default this schema would be inventing.
 *
 * `resource_groups` and `tag_filters` default to empty, which is how "the whole
 * subscription" is spelled. Defaulting rather than requiring means the common case
 * is a two-field body, and the persisted shape is still complete: every run's
 * `scope` column carries all three keys whether the submission named them or not,
 * so the compiler that later reads a stored scope never meets an absent field.
 *
 * `.strict()`, like every schema in this module: an unrecognized key is a
 * rejection, not something to drop quietly. A body carrying `top_n` is expressing
 * an expectation this spec does not honour, and answering it with an unfiltered
 * run would look like the filter had been applied.
 */
export const runScopeSchema = z
  .object({
    resource_types: z
      .array(scopeEntrySchema)
      .min(1, {
        error:
          "Name at least one Azure resource type to collect, for example " +
          "Microsoft.Compute/virtualMachines.",
      })
      .max(MAX_RESOURCE_TYPES),
    resource_groups: z
      .array(scopeEntrySchema)
      .max(MAX_RESOURCE_GROUPS)
      .default([]),
    tag_filters: z
      .record(scopeEntrySchema, z.string().max(MAX_SCOPE_ENTRY_LENGTH))
      .refine((tags) => Object.keys(tags).length <= MAX_TAG_FILTERS, {
        error: `At most ${MAX_TAG_FILTERS} tag filters.`,
      })
      .default({}),
  })
  .strict()

export type RunScopeInput = z.output<typeof runScopeSchema>

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

/** `YYYY-MM-DD`, and nothing looser. */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * A `YYYY-MM-DD` calendar date.
 *
 * The regex is the whole check, deliberately: this is a **local** calendar date in
 * a zone the submission names, so there is no instant here to validate and
 * `new Date(value)` would materialise one at UTC midnight — which is the exact
 * mistake the `date` column's `mode: "string"` exists to avoid. The date's
 * *calendar* validity (no 31 February) is checked by {@link checkPeriod}, which has
 * the arithmetic in hand anyway.
 */
const localDateSchema = z
  .string({ error: PERIOD_MESSAGE })
  .regex(LOCAL_DATE_PATTERN, { error: PERIOD_MESSAGE })

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
    periodStart: localDateSchema,
    periodEnd: localDateSchema,
    timezone: timezoneSchema.default("Asia/Jakarta"),
    scope: runScopeSchema,
  })
  .strict()

export type RunCreateInput = z.output<typeof runCreateInputSchema>

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

// --- The period check -------------------------------------------------------

/**
 * Why a submitted period was refused, or `null` if it was not.
 *
 * There is no `too_short` member, and its absence is a consequence of
 * {@link MIN_PERIOD_DAYS} being 1: a span below 1 day is exactly a span whose
 * start is after its end, so "below the minimum" and "inverted" are the same
 * condition and naming it twice would leave one of the two branches unreachable.
 */
export type PeriodProblem =
  "malformed" | "inverted" | "too_long" | "ends_in_future"

/** Milliseconds in one day — used only on the UTC-noon proxy below. */
const MS_PER_DAY = 86_400_000

/**
 * Is this a calendar date that exists?
 *
 * `2026-02-31` matches the regex and names no day. Checked by round-tripping
 * through `Date.UTC`, which normalizes an out-of-range day into the following
 * month — so a value that does not survive the round trip is not a date.
 */
function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number)

  const at = new Date(Date.UTC(year, month - 1, day))

  return (
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day
  )
}

/**
 * The count of local days from `start` to `end` inclusive.
 *
 * Computed at **UTC noon** rather than UTC midnight. The two dates are local
 * calendar dates and the arithmetic here is a pure day count between them, so the
 * frame is arbitrary — but midnight sits exactly on a boundary, and noon is 12
 * hours from either edge, which keeps a day count from ever being off by one
 * because of a leap second or a `Date` implementation detail at the boundary.
 *
 * Pure and exported for its own test: the inclusive count is where an off-by-one
 * would let a 32-day period through, and 31 is the number the collector's memory
 * budget was measured against.
 */
export function localDaySpan(start: string, end: string): number {
  const [startYear, startMonth, startDay] = start.split("-").map(Number)
  const [endYear, endMonth, endDay] = end.split("-").map(Number)

  const startAt = Date.UTC(startYear, startMonth - 1, startDay, 12)
  const endAt = Date.UTC(endYear, endMonth - 1, endDay, 12)

  return Math.round((endAt - startAt) / MS_PER_DAY) + 1
}

/**
 * Is `timezone` a zone this runtime can resolve?
 *
 * `Intl.DateTimeFormat` throws a `RangeError` for an unknown zone, which is the
 * platform telling us its own tzdata does not have it. Catching that is a real
 * check rather than a shape check: a zone the runtime cannot resolve is a zone the
 * collector cannot bucket local days in, so accepting it would produce a run whose
 * every daily figure is silently in the wrong frame.
 */
export function isSupportedTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date())
    return true
  } catch {
    return false
  }
}

/**
 * The current calendar date in `timezone`, as `YYYY-MM-DD`.
 *
 * `en-CA` because its short date format **is** ISO 8601 — `2026-08-15` — so the
 * formatted output needs no reassembly and no per-part padding. `formatToParts`
 * plus manual joining is the alternative, and it is three more lines in which to
 * get a single-digit month wrong.
 *
 * Pure with respect to its arguments: `now` is a parameter, so the boundary — a
 * period ending "today" in Asia/Jakarta while it is still yesterday in UTC — is
 * assertable at an instant a test picks.
 */
export function localDateIn(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

/**
 * Why this period may not be collected, or `null` (Requirement 37.10).
 *
 * Pure — the instant and the zone are arguments — and separate from the schema
 * because both of the things it needs are unavailable to a schema: the zone is a
 * *field of the submission*, so it is not known until parsing has succeeded, and
 * the instant is the request's. It runs after `safeParse`, in the enqueue, before
 * any insert.
 *
 * The order of the checks is the order of the answers' usefulness: a malformed
 * date is a different mistake from an inverted range, and an inverted range is a
 * different mistake from a 90-day window. `ends_in_future` is last because it is
 * the only one that depends on the clock, so it is the only one whose verdict can
 * change between two identical submissions.
 *
 * **The future check is against the local date in the run's own zone**, not
 * against UTC. For a customer at UTC+07:00 the local date is ahead of UTC's for
 * seven hours of every day, so a UTC comparison would refuse a report on a day
 * that has already ended locally — and, worse, on the other side of the
 * international date line it would *accept* one that has not started.
 */
export function checkPeriod(
  period: {
    readonly periodStart: string
    readonly periodEnd: string
    readonly timezone: string
  },
  now: Date
): PeriodProblem | null {
  if (
    !isRealCalendarDate(period.periodStart) ||
    !isRealCalendarDate(period.periodEnd)
  ) {
    return "malformed"
  }

  if (!isSupportedTimeZone(period.timezone)) return "malformed"

  const days = localDaySpan(period.periodStart, period.periodEnd)

  // `days < MIN_PERIOD_DAYS` and "start after end" are one condition, because
  // MIN_PERIOD_DAYS is 1 — see {@link PeriodProblem}.
  if (days < MIN_PERIOD_DAYS) return "inverted"
  if (days > MAX_PERIOD_DAYS) return "too_long"

  // String comparison is correct for `YYYY-MM-DD`: the format is fixed-width and
  // big-endian, so lexical order is chronological order.
  if (period.periodEnd > localDateIn(period.timezone, now)) {
    return "ends_in_future"
  }

  return null
}

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
