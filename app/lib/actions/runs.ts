import "server-only"

import { randomUUID } from "node:crypto"

import { and, eq } from "drizzle-orm"
import { z } from "zod"

import { getDb } from "@/lib/db"
import {
  connectedSubscriptions,
  reportRuns,
  type ReportRun,
  type RunErrorCode,
  type RunScope,
} from "@/lib/db/schema"
import { toConnectedSubscriptionView } from "@/lib/db/views"
import { deriveDedupeKey } from "@/lib/runs/dedupe"
import type { RunCreateInput } from "@/lib/runs/input"
import {
  resolvePeriod,
  type PeriodRejectionCode,
  type PeriodSpec,
} from "@/lib/templates/period"
import { unionScope } from "@/lib/templates/scope-union"
import { readLatestVersion, TemplateNotFoundError } from "@/lib/templates/store"

import type { TemplateDefinition } from "@/lib/templates/definition"
import { MAX_SUPPORTED_SCHEMA_VERSION } from "@/lib/templates/definition"
import {
  deriveProgressToken,
  progressTokenHash,
} from "@/lib/runs/progress-token"
import { phaseDeadlineFor } from "@/lib/runs/state"
import { subscriptionRunBlocker } from "@/lib/subscriptions/state"

/**
 * `enqueueRun` — insert one `queued` row and return (Requirement 37).
 *
 * ## Why this module carries `import "server-only"` and not `"use server"`
 *
 * `lib/actions/auth.ts` carries the `"use server"` directive because the login and
 * register forms are `"use client"` leaves that call its exports directly. This
 * module deliberately does not, and the reason is a security property rather than a
 * style preference.
 *
 * {@link enqueueRun} takes the owning **user id as its first argument**. Under
 * `"use server"` every export becomes a browser-reachable endpoint, so that
 * signature would be an endpoint through which any caller could enqueue a run
 * against any user's subscription — and `actor_id` is what prefixes every artifact
 * key, so it would also be a way to write objects under somebody else's prefix.
 * The alternatives were to resolve the session inside the action (which makes the
 * function untestable without a cookie store, and makes the reaper's and the
 * relay's use of the same scoped reads inconsistent) or to keep the id an argument
 * and *not* expose the module. The second is what this is.
 *
 * So the run form is a `"use client"` leaf that `fetch`es `POST /api/runs`, exactly
 * as `components/subscriptions/connect-wizard.tsx` posts to `/api/subscriptions`.
 * The route resolves the session and passes the id it resolved. One orchestration
 * path is preserved either way (Requirement 37.4): form-triggered and
 * chat-triggered runs both arrive here, through that route.
 *
 * ## What "enqueue and return" means, literally
 *
 * It validates, inserts, and returns — awaiting **nothing** but its own validation
 * and its own writes (Requirement 37.2). It holds no stream, makes no AgentCore
 * invocation and makes no Azure call. The cron tick is what invokes the runtime, in
 * a later request.
 *
 * > **Rejected design, recorded so it does not get reinvented.** An earlier design
 * > had this action consume the `generate_report` SSE stream server-side, so the run
 * > would survive the user closing the tab. **Surviving a closed tab is not the hard
 * > case.** That consumer still dies on a Next.js restart, a deploy roll or a
 * > request timeout, and the row then sits in `collecting` forever because nothing
 * > sweeps it. Making a long-held HTTP stream the source of truth is the fragility,
 * > not the fix.
 */

// --- Rejections -------------------------------------------------------------

/**
 * The reason a submission was refused before any row was written.
 *
 * A discriminated union rather than a thrown `Error` per case, because the caller
 * has to map each one to a **different** HTTP status and a different piece of copy:
 * a period problem is a 400 the consultant fixes in the form, while a subscription
 * that is not `active` is a 422 they fix on the subscriptions screen. A single error
 * type would collapse that distinction and the UI could not say which.
 *
 * `code` carries a terminal run error code for the subscription cases — the same
 * `AUTH_EXPIRED` / `SCOPE_UNVERIFIED` the reaper would write if the run were
 * allowed through (Requirement 39.10) — so the UI's copy for "this subscription
 * cannot run" is written once and reached from both paths.
 */
export type EnqueueRejection =
  | { readonly kind: "subscription_not_found" }
  | { readonly kind: "subscription_inactive"; readonly code: RunErrorCode }
  /** Requirement 1.5 — the template is not this user's, or does not exist. */
  | { readonly kind: "template_not_found" }
  /**
   * Requirement 9.6 — the template exists and carries no version row, so there
   * is no definition to pin. A distinct case from `template_not_found`, and the
   * distinction is one the consultant acts on: a template they have never
   * finished in the wizard needs step 7, not a different template.
   */
  | { readonly kind: "template_unversioned" }
  /**
   * Requirements 4.6, 4.7, 4.11 — the pinned version's period specification is
   * unrecognized, or resolves to a window that cannot be collected.
   *
   * Carries the resolver's own code rather than one flattened "bad period",
   * because the outcomes are different corrections:
   * `unrecognized_period` needs the template edited,
   * `no_complete_local_day` needs the consultant to wait until tomorrow, and
   * `exceeds_maximum_days` needs a shorter specification.
   */
  | {
      readonly kind: "resolved_period"
      readonly code: PeriodRejectionCode
      readonly message: string
    }
  /**
   * Requirement 13.14 — the pinned version's `schema_version` is 2 or above and
   * the request is missing one or both per-run front-matter values (customer name
   * and/or revision history row). Names every absent field.
   */
  | {
      readonly kind: "front_matter_values_missing"
      readonly missingFields: readonly string[]
    }

/**
 * A submission was refused, with **no `report_runs` row inserted and no
 * `progress_token` minted** (Requirements 37.9, 37.10).
 *
 * The message is display-safe and quotes no submitted value. `rejection` carries
 * the machine-readable reason.
 */
export class EnqueueRejectedError extends Error {
  readonly rejection: EnqueueRejection

  constructor(rejection: EnqueueRejection, message: string) {
    super(message)
    this.name = "EnqueueRejectedError"
    this.rejection = rejection
  }
}

// --- Driver errors ----------------------------------------------------------

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505"

/**
 * The constraint drizzle-kit generated for `report_runs.dedupe_key`.
 *
 * Requirement 37.5 is about **this** constraint. Matching on SQLSTATE alone would
 * map any future unique violation on this table to "that run already exists",
 * which is a false statement about a different failure — and here it would be a
 * particularly bad one, because the handler's response to it is to return somebody
 * a run id.
 */
const DEDUPE_KEY_CONSTRAINT = "report_runs_dedupe_key_unique"

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
 * Walks the `cause` chain because drizzle 0.45 wraps every driver failure in a
 * `DrizzleQueryError` and puts the original underneath — the code is never on the
 * frame that is thrown. Structural, via zod, rather than `instanceof
 * DatabaseError`: an `instanceof` against a class imported here fails silently if
 * the driver instance differs, and that failure mode is a UNIQUE violation escaping
 * as a 500 on the one path Requirement 37.5 is about.
 *
 * A third implementation of the same walk (`lib/actions/auth.ts` and
 * `lib/subscriptions/store.ts` have the others). The duplication is imposed rather
 * than chosen: `auth.ts` carries a file-level `"use server"` directive, so it
 * cannot export a synchronous helper, and factoring it out of `store.ts` would
 * couple the run path to the subscription path for eight lines.
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

/** Requirement 37.5 — the insert lost the race for this derived key. */
function isDedupeKeyTaken(thrown: unknown): boolean {
  const error = driverError(thrown)

  return (
    error?.code === UNIQUE_VIOLATION &&
    error.constraint === DEDUPE_KEY_CONSTRAINT
  )
}

/**
 * A replacement error carrying the operation and the SQLSTATE and nothing else.
 *
 * The original is dropped rather than attached as `cause`, for the reason
 * `lib/subscriptions/store.ts` drops its own: `DrizzleQueryError`'s message is
 * `Failed query: <sql> params: <params>`, and the insert below binds
 * `progress_token_hash`. That is not the plaintext token, but a hash of a
 * credential is still a credential-shaped value that has no business in a log line
 * next to the run id it belongs to.
 */
function redactedWriteError(operation: string, thrown: unknown): Error {
  const code = driverError(thrown)?.code
  const suffix = code === undefined ? "" : ` (postgres ${code})`

  return new Error(`[runs] ${operation} failed${suffix}`)
}

// --- The enqueue ------------------------------------------------------------

/** What the caller gets back: the row, and whether it was already there. */
export type EnqueueResult = {
  readonly run: ReportRun
  /**
   * `true` when the derived `dedupe_key` already existed and the **existing** run
   * was returned (Requirement 37.5).
   *
   * Surfaced rather than hidden because the two cases have different HTTP statuses
   * — 201 for a row that was created, 200 for one that already was — and because a
   * caller that cannot tell them apart cannot report "already running" honestly.
   */
  readonly deduplicated: boolean
}

/**
 * Insert one `queued` run for `userId`, or return the existing one
 * (Requirement 37.1, 37.2, 37.5, 37.9, 37.10).
 *
 * `now` is injectable so the 60-second dedupe bucket and the "ends in the future"
 * boundary are assertable at an instant a test picks. Production passes nothing.
 *
 * The order below is the order the requirements force, and each step is a rejection
 * point that writes nothing:
 *
 *  1. **The subscription must be this user's and `active`** (Requirement 37.9),
 *     read with the `AND user_id` predicate inside the statement so another user's
 *     id matches no row and discloses nothing.
 *  2. **The subscription must not be blocked**, decided by
 *     `subscriptionRunBlocker` — the same predicate the expiry banner renders from
 *     and the reaper's gate rejects with. A gate with its own expiry arithmetic is
 *     how a screen warns about a secret the enqueue happily invokes with.
 *  3. **The period must be collectable** (Requirement 37.10), in the run's own
 *     zone.
 *  4. **Insert.** The `dedupe_key` and the `progress_token_hash` are derived, and
 *     the `phase_deadline` is the `queued` budget.
 *
 * Step 2 is not redundant with step 1. `status = 'active'` and "not blocked" are
 * different facts: a row can be `active` with a secret that expires tomorrow
 * (allowed — a working secret) or with one that expired an hour ago (refused).
 * `status` records what the preflight decided; the blocker adds what the clock has
 * done since.
 */
export async function enqueueRun(
  userId: string,
  input: RunCreateInput,
  now: Date = new Date()
): Promise<EnqueueResult> {
  // 1 — the subscription, scoped to its owner (Requirements 9.7, 37.9).
  const [subscription] = await getDb()
    .select()
    .from(connectedSubscriptions)
    .where(
      and(
        eq(connectedSubscriptions.id, input.connectedSubscriptionId),
        eq(connectedSubscriptions.userId, userId)
      )
    )
    .limit(1)

  if (subscription === undefined) {
    // Not found, never forbidden, and the same answer for an id that does not
    // exist as for one that is somebody else's (Requirement 9.8).
    throw new EnqueueRejectedError(
      { kind: "subscription_not_found" },
      "No connected subscription with that id belongs to the signed-in user."
    )
  }

  if (subscription.status !== "active") {
    throw new EnqueueRejectedError(
      {
        kind: "subscription_inactive",
        // `pending` means the preflight never proved subscription-scope read;
        // `disabled` means Azure rejected the credential. The blocker knows which,
        // and it is the single definition of both.
        code:
          subscriptionRunBlocker(
            toConnectedSubscriptionView(subscription),
            now
          ) ?? "SCOPE_UNVERIFIED",
      },
      "That subscription is not ready to run. Read at subscription scope must " +
        "be proved, and its client secret must be one Azure still accepts."
    )
  }

  // 2 — the blocker, from the one module that defines "expired" (Req 13.4, 37.9).
  const blocker = subscriptionRunBlocker(
    toConnectedSubscriptionView(subscription),
    now
  )

  if (blocker !== null) {
    throw new EnqueueRejectedError(
      { kind: "subscription_inactive", code: blocker },
      blocker === "AUTH_EXPIRED"
        ? "That subscription's Azure client secret has expired, so a run " +
            "against it would return no resources at all — which would deliver " +
            "a fully-verified, empty report. Rotate the secret first."
        : "Read at subscription scope has not been proved for that " +
            "subscription, so runs against it are blocked."
    )
  }

  // 3 — the pinned version: the **highest** existing, as of this read
  //     (Requirement 9.6). Not `current_version_id`, which is a cached pointer
  //     that a concurrent save can leave a version behind.
  let pinned
  try {
    pinned = await readLatestVersion(userId, input.templateId)
  } catch (thrown) {
    if (thrown instanceof TemplateNotFoundError) {
      throw new EnqueueRejectedError(
        { kind: "template_not_found" },
        "No report template with that id belongs to the signed-in user."
      )
    }
    throw thrown
  }

  if (pinned === undefined) {
    throw new EnqueueRejectedError(
      { kind: "template_unversioned" },
      "That template has no saved version, so there is no definition to run. " +
        "Finish the wizard and save it first."
    )
  }

  // The stored `definition` is `jsonb`, so its TypeScript type is a promise the
  // database cannot keep. Both readers below are written to survive a shape they
  // did not expect: `resolvePeriod` widens its own argument and answers
  // `unrecognized_period` for anything outside the six kinds (Requirement 4.11),
  // and `declaredScopes` walks a `blocks` array that may not be one.
  const definition = pinned.definition as TemplateDefinition

  // 4 — the period, resolved from the pinned specification rather than
  //     submitted (Requirements 4.3, 4.5, 4.6, 4.7, 4.11). Every run resolves
  //     afresh at its own enqueue instant, which is what makes a scheduled
  //     "last full month" template correct next month with no edit.
  const period = resolvePeriod(
    definition.period as PeriodSpec,
    now,
    input.timezone
  )

  if (!period.ok) {
    throw new EnqueueRejectedError(
      {
        kind: "resolved_period",
        code: period.code,
        message: period.message,
      },
      period.message
    )
  }

  // 4b — per-run front-matter values, required at schema_version >= 2
  //       (Requirement 13.14). The invariant lives at this boundary, not in a
  //       CHECK: a CHECK constrained on the pinned version's schema_version needs
  //       a join a CHECK cannot perform.
  const schemaVersion =
    typeof definition.schema_version === "number"
      ? definition.schema_version
      : 1

  if (schemaVersion >= 2) {
    const missingFields: string[] = []
    if (input.customerName === undefined) {
      missingFields.push("customerName")
    }
    if (input.revisionHistoryRow === undefined) {
      missingFields.push("revisionHistoryRow")
    }

    if (missingFields.length > 0) {
      throw new EnqueueRejectedError(
        { kind: "front_matter_values_missing", missingFields },
        `A run pinning a schema_version ${schemaVersion} template requires ` +
          `per-run front-matter values, but ${missingFields.join(" and ")} ` +
          `${missingFields.length === 1 ? "is" : "are"} absent.`
      )
    }
  }

  // 5 — the collection scope, as the union of the definition's template default
  //     and every block `scope_override` (Requirement 3.3).
  //
  //     Derived rather than submitted, because `payload["scope"]` is what the
  //     collector actually collects: a form-supplied scope and a definition's
  //     block overrides would be two assertions about one fact, and a block
  //     scoped outside the submitted set would render its "no resources matched"
  //     row on a run that every gate called correct.
  //
  //     Copied into the column's own mutable shape rather than cast: `RunScope`
  //     is what the `jsonb` column stores and `UnionScope` is deeply readonly,
  //     and spreading here is what keeps the derived value unable to be mutated
  //     by anything downstream of this line.
  const derived = unionScope(definition)
  const scope: RunScope = {
    resource_types: [...derived.resource_types],
    resource_groups: [...derived.resource_groups],
    tag_filters: { ...derived.tag_filters },
  }

  // 6 — the insert. Derived first, so the values are in hand and the statement is
  //     the only awaited operation left (Requirement 37.2).
  const runId = randomUUID()

  const dedupeKey = deriveDedupeKey({
    userId,
    connectedSubscriptionId: input.connectedSubscriptionId,
    periodStart: period.start,
    periodEnd: period.end,
    timezone: input.timezone,
    resourceTypes: scope.resource_types,
    resourceGroups: scope.resource_groups,
    enqueuedAtMs: now.getTime(),
  })

  try {
    const [row] = await getDb()
      .insert(reportRuns)
      .values({
        id: runId,
        userId,
        connectedSubscriptionId: input.connectedSubscriptionId,
        // Requirement 9.6 — the pin, set on every run this action inserts, and
        // the column `report_runs_template_version_id_ck` requires from the
        // cutover instant onward.
        templateVersionId: pinned.id,
        periodStart: period.start,
        periodEnd: period.end,
        timezone: input.timezone,
        scope,
        status: "queued",
        dedupeKey,
        // Requirement 13.7 — per-run front-matter values, nullable for v1 pins.
        customerName: input.customerName ?? null,
        revisionHistoryRow: input.revisionHistoryRow ?? null,
        // Requirement 37.3 — the hash, and no column carrying the token. The tick
        // recomputes the token from this run's id when it invokes.
        progressTokenHash: progressTokenHash(deriveProgressToken(runId)),
        // Requirement 36.9 — 900 seconds, which tolerates 14 consecutive missed
        // 60-second ticks before the reaper fails this row as TIMEOUT.
        phaseDeadline: phaseDeadlineFor("queued", now),
        updatedAt: now,
        createdAt: now,
      })
      .returning()

    // Unreachable through the driver — an `INSERT ... RETURNING` that raised
    // nothing returned the row — but a `row!` here would be a claim this module
    // cannot back.
    if (row === undefined) {
      throw new Error("[runs] the insert returned no row")
    }

    return { run: row, deduplicated: false }
  } catch (thrown) {
    if (isDedupeKeyTaken(thrown)) {
      // Requirement 37.5 — return the **existing** run, insert no second row, mint
      // no second token. There is deliberately no pre-`SELECT` for this: two
      // submissions of one derived key can pass any pre-check concurrently, and
      // the database is the only thing that can decide which one wins. The insert
      // is the first and only write here, so the loser has nothing to unwind.
      const [existing] = await getDb()
        .select()
        .from(reportRuns)
        .where(
          and(
            eq(reportRuns.dedupeKey, dedupeKey),
            eq(reportRuns.userId, userId)
          )
        )
        .limit(1)

      if (existing !== undefined) {
        return { run: existing, deduplicated: true }
      }

      // The key is taken but not by a row of this user's. `dedupe_key` is derived
      // from the user id, so this is unreachable short of a SHA-256 collision —
      // and reporting it as somebody else's run would be worse than reporting a
      // write failure.
      throw redactedWriteError("enqueueing a run", thrown)
    }

    throw redactedWriteError("enqueueing a run", thrown)
  }
}

// --- Historical-trend candidates (Requirement 18.4) -------------------------

/**
 * The candidate query for the historical-trend block.
 *
 * Re-exported here so `lib/actions/runs.ts` is the public surface for run-related
 * database queries (this module owns enqueue; `historical.ts` owns the trend
 * candidates). The actual call site is `lib/runs/invoke.ts`, which fetches
 * candidates at invoke time and carries them in the **command payload** — never in
 * `context`, which stays closed at twelve fields with its existing guard.
 */
export { fetchHistoricalCandidates } from "@/lib/runs/historical"
