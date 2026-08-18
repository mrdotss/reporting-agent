import { EnqueueRejectedError, enqueueRun } from "@/lib/actions/runs"
import {
  badRequest,
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import {
  NO_RUN_VIEW_EXTRAS,
  toRunView,
  type RunView,
} from "@/lib/db/views"
import { runCreateInputSchema } from "@/lib/runs/input"
import { resolveRunExtras, resolveRunExtrasBatch } from "@/lib/runs/detail"
import { listOwnedRuns } from "@/lib/runs/state"

/**
 * `POST /api/runs` and `GET /api/runs` (Requirements 37.1–37.5, 37.9, 37.10, 7.7).
 *
 * A **thin wrapper** over `lib/actions/runs.ts#enqueueRun`, and thin is the
 * specification rather than a description: Requirement 37.4 says form-triggered and
 * chat-triggered runs share one orchestration path, so everything this file does
 * has to be things that are *about the HTTP boundary* — resolving the session,
 * parsing the body, mapping a rejection to a status. Every decision about whether a
 * run may exist is in the action, where the chat trigger reaches it too.
 *
 * `export const runtime = "nodejs"` because the action opens a Postgres connection
 * through `pg`, which does not run on the edge runtime (Requirement 6.7).
 *
 * ## The status codes, and why each one
 *
 * | outcome | status | why |
 * |---|---|---|
 * | inserted | `201` | a row was created, and `Location` names it |
 * | deduplicated | `200` | the **existing** run, no second row, no second token (Req 37.5) |
 * | period refused | `400` | the submission is wrong and the form is where it is fixed |
 * | subscription not this user's | `404` | not found, never forbidden (Req 9.8) |
 * | subscription not runnable | `422` | well-formed and understood; the *answer* is that it cannot run |
 *
 * The 422 carries the terminal `code` the reaper would have written — `AUTH_EXPIRED`
 * or `SCOPE_UNVERIFIED` — so the UI's copy for "this subscription cannot run" is
 * written once and reached identically whether the refusal happened at enqueue or
 * at claim (Requirement 12.13). One is a secret the consultant rotates, the other a
 * role the customer fixes, and flattening them would remove the only signal they
 * can act on.
 *
 * ## What crosses to the browser
 *
 * Only {@link RunView} (Requirement 37.5). `progress_token_hash`, `claimed_by`,
 * `dedupe_key`, `scope` and the three in-flight progress columns are dropped by the
 * projection, not filtered here — so there is no field this handler could forget to
 * remove. `artifactKeys` carries **keys**, never a presigned URL, which is what
 * lets a run payload be rendered and cached without carrying a credential.
 */
export const runtime = "nodejs"

/** The `POST` success body. */
type CreateResponseBody = { readonly run: RunView }

/** The `GET` success body. */
type ListResponseBody = { readonly runs: readonly RunView[] }

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  // Requirement 7.7 — a named schema at the boundary, `.strict()`, no
  // `as SomeType`. The period's *semantic* checks are not here: they need the
  // submission's own `timezone`, which is not known until this parse succeeds, so
  // they run inside the action against an instant it holds.
  const parsed = runCreateInputSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    // The user id comes from the session and from nowhere else (Requirement
    // 41.11): it becomes the run's `user_id`, which becomes the `actor_id` the
    // runtime writes artifacts under, which is the prefix download authorization
    // compares against. A body-supplied id would be a way to write under somebody
    // else's prefix.
    const { run, deduplicated } = await enqueueRun(user.id, parsed.data)

    // Resolvable now: the enqueue pins a version (Requirement 9.6), so a
    // freshly inserted run already knows its template and its number. The
    // verification is `null`, honestly — nothing has verified a run that was
    // created a millisecond ago.
    const view = toRunView(run, await resolveRunExtras(run))

    return json(deduplicated ? 200 : 201, {
      run: view,
    } satisfies CreateResponseBody)
  } catch (thrown) {
    if (thrown instanceof EnqueueRejectedError) {
      const { rejection } = thrown

      switch (rejection.kind) {
        case "resolved_period":
          // Requirements 4.6, 4.7, 4.11 — the *pinned version's* period
          // specification does not resolve to a collectable window. A 400 like
          // the submitted-period case, but the code is the resolver's own, so
          // the UI can tell "wait until tomorrow" apart from "edit the
          // template" without parsing prose.
          return badRequest(thrown.message, rejection.code.toUpperCase())

        case "template_unversioned":
          // 422: the request is well-formed and understood, and the *answer* is
          // that this template cannot run yet. The same shape as an inactive
          // subscription, and for the same reason — the fix is on another
          // screen, not in this form.
          return unprocessable(thrown.message, "TEMPLATE_UNVERSIONED")

        case "template_not_found":
        case "subscription_not_found":
          // Requirement 9.8 — the same answer for an id that does not exist as
          // for one that is somebody else's. A 404 rather than a 403, because
          // "forbidden" confirms the row exists and its existence is a fact about
          // somebody else's customer. The shared helper's fixed body is used
          // rather than the rejection's own message, so this answer is byte-
          // identical to every other not-found in the app.
          return notFound()

        case "subscription_inactive":
          return unprocessable(thrown.message, rejection.code)
      }
    }

    // The action replaces a driver failure with the operation and the SQLSTATE and
    // nothing else, so this line cannot write `progress_token_hash` or the
    // requested scope into a log.
    console.error(
      `[api/runs] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}

/**
 * This user's runs, newest first (Requirement 36.10).
 *
 * Search parameters are deliberately not parsed here: this handler accepts none,
 * and unlike the subscriptions list it does not reject an unexpected one either —
 * the run list is a read whose only scoping is the session, and a browser appending
 * a cache-busting parameter to a polling `fetch` is ordinary rather than an
 * expectation being expressed. The narrower rule stays on the routes where a
 * parameter could plausibly *mean* something.
 */
export async function GET(): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  try {
    // Requirement 37.1 — the template name, the pinned version and the
    // verification status per run. This is the join `NO_RUN_VIEW_EXTRAS`
    // said would replace it once tasks 13.1 and 11.5 landed; both have.
    const rows = await listOwnedRuns(user.id)
    const extras = await resolveRunExtrasBatch(rows)

    const runs = rows.map((run) =>
      toRunView(run, extras.get(run.id) ?? NO_RUN_VIEW_EXTRAS)
    )

    return json(200, { runs } satisfies ListResponseBody)
  } catch (thrown) {
    console.error(
      `[api/runs] GET failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
