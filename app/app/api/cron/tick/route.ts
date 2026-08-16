import { randomUUID } from "node:crypto"

import { internalError, json, serviceUnavailable } from "@/lib/api/response"
import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import {
  bearerMatches,
  claimQueuedRuns,
  sweepExpiredRuns,
} from "@/lib/runs/claim"
import { startRunInvocation } from "@/lib/runs/invoke"
import { sessionIdForRun } from "@/lib/session-id"

/**
 * `POST /api/cron/tick` — the reaper (Requirement 39).
 *
 * **Not optional and not deferrable.** Without this endpoint one crashed container
 * leaves a row in `collecting` forever, because nothing else sweeps it: the agent is
 * gone, so there is no callback coming, and the SSE relay is a view rather than a
 * writer. The scheduling *feature* is later work; the state machine, the progress
 * callback and this reaper are foundation, and this is the part that pages somebody
 * at three in the morning if it is missing.
 *
 * `export const runtime = "nodejs"` because it opens a Postgres connection, uses
 * `node:crypto` for the constant-time bearer comparison, and reaches the AWS SDK.
 *
 * ## Its only protection is the bearer secret, and it fails closed
 *
 * This endpoint can claim work and invoke the runtime, so an unauthenticated tick is
 * a **denial-of-wallet hole**: anybody who found the URL could drive as many
 * collections as there are queued rows. `bearerMatches` therefore rejects every
 * request when `RPT_CRON_SECRET` is unset or empty (Requirement 39.2), compares over
 * equal-length digests so the comparison leaks neither a matching prefix nor the
 * secret's length (Requirement 39.1), and a rejected request **claims nothing and
 * writes nothing — including no `TIMEOUT`** (Requirement 39.3). The authorization
 * check is the first statement in the handler, before any database read, so there is
 * no ordering in which an unauthorized request has already touched a row.
 *
 * ## Sweep, then claim, then invoke — and why that order
 *
 * Requirement 39.11 puts the deadline sweep **before** the claim, within the same
 * request. A `queued` row past its deadline must be *failed* rather than claimed, and
 * claiming first would start an invocation for a run that is about to be timed out.
 * Running the sweep first excludes those rows from the claim **by construction**:
 * they no longer match `status = 'queued'`, so no second predicate is needed and none
 * can be forgotten.
 *
 * ## It never waits for a run
 *
 * Requirement 39.9 — the response is returned within 10 seconds and awaits no run's
 * completion. The invocations are started **concurrently** and each is capped at a
 * 10-second start budget, so ten claimed rows cost ten seconds in the worst case
 * rather than a hundred. Each response stream is released with a detached drain
 * (Requirement 39.6): read, discarded, never parsed as state.
 *
 * A row whose invocation fails to start is **left at `claimed`** for a later sweep
 * (Requirement 39.13), and the remaining rows are still invoked. That is deliberate:
 * a transient invoke failure is a candidate for the next tick, and the 300-second
 * `claimed` budget bounds how long that stays true.
 */
export const runtime = "nodejs"

/** What one tick did. Counts only — no run id, no error message, no secret. */
type TickResponseBody = {
  readonly swept: number
  readonly claimed: number
  readonly invoked: number
  /** Claimed rows failed at the gate: unverified scope, expired or unreadable secret. */
  readonly failed: number
  /** Claimed rows that were no longer `claimed` when the invoke was reached. */
  readonly skipped: number
  /** Claimed rows whose invocation did not start; left `claimed` for the sweep. */
  readonly notStarted: number
}

/**
 * The rejection, as a bare `401` with an empty body.
 *
 * Deliberately not the shared `unauthorized()` helper, whose body says "Sign in to
 * continue." — this caller is a scheduler, not a browser, and there is no sign-in for
 * it to do. An empty body also states nothing about whether the variable is
 * configured: a message distinguishing "no secret is set" from "your secret is wrong"
 * would tell an unauthorized caller which of the two it is looking at.
 */
function rejected(): Response {
  return new Response(null, {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      // So a client does not sit waiting for a body that is not coming.
      "Content-Length": "0",
    },
  })
}

export async function POST(request: Request): Promise<Response> {
  // Requirements 39.1, 39.2, 39.3 — first, before any read or write. A rejected
  // request has not touched a row, because it has not reached one.
  if (
    !bearerMatches(
      request.headers.get("authorization"),
      process.env.RPT_CRON_SECRET
    )
  ) {
    console.warn(
      "[api/cron/tick] rejected an unauthorized request. No work was claimed " +
        "and no row was written, including no TIMEOUT."
    )

    return rejected()
  }

  try {
    // 1 — Requirements 39.7, 39.8, 39.11. Before the claim, so a queued row past
    //     its deadline is failed rather than claimed.
    const swept = await sweepExpiredRuns()

    for (const run of swept) {
      // One line per swept row, because a run failed as TIMEOUT is the event an
      // operator investigates and the phase it expired in is the only clue the row
      // carries about where it died.
      console.warn(
        `[api/cron/tick] failed run ${run.id} as TIMEOUT: its ` +
          `${run.expiredPhase} phase exceeded its deadline.`
      )
    }

    // 2 — Requirements 39.4, 39.5. One `claimed_by` per request, so a claim is
    //     attributable to a claimer, and `FOR UPDATE SKIP LOCKED` inside the
    //     statement so overlapping ticks claim disjoint sets.
    const claimedBy = randomUUID()
    const claimed = await claimQueuedRuns(claimedBy)

    // 3 — Started concurrently, each capped at its own start budget, none awaited to
    //     completion. `allSettled` rather than `all`: one row's gate throwing must
    //     not abandon the others (Requirement 39.13), and the throw is re-raised
    //     below only for a configuration error that no run can recover from.
    const outcomes = await Promise.allSettled(
      claimed.map((run) =>
        // Requirements 8.5, 41.7 — the session id is derived from the run's id, so a
        // retried invocation of one run presents the same id and the agent's memory
        // stays continuous across it.
        startRunInvocation(run, sessionIdForRun(run.id))
      )
    )

    let invoked = 0
    let failed = 0
    let skipped = 0
    let notStarted = 0
    let unconfigured = false

    for (const [index, outcome] of outcomes.entries()) {
      const runId = claimed[index]?.id ?? "unknown"

      if (outcome.status === "rejected") {
        if (outcome.reason instanceof MissingRuntimeConfigError) {
          // Not this run's problem, and not one the next tick will solve either.
          // Reported once, after every row has been attempted, so a deployment that
          // has not been configured yet does not also leave rows half-processed.
          unconfigured = true
          notStarted += 1
          continue
        }

        // The row stays `claimed` and the sweep is the backstop. The thrown value's
        // name only: an AWS SDK error's own serialization can quote the request it
        // failed on, and that request carries the customer's client secret.
        notStarted += 1
        console.error(
          `[api/cron/tick] starting run ${runId} raised ` +
            `${outcome.reason instanceof Error ? outcome.reason.name : typeof outcome.reason}. ` +
            `The row is left claimed for the deadline sweep.`
        )
        continue
      }

      switch (outcome.value.kind) {
        case "invoked":
          invoked += 1
          break

        case "failed":
          failed += 1
          console.warn(
            `[api/cron/tick] failed run ${runId} as ${outcome.value.code} at ` +
              `the gate. No AgentCore invocation was made for it.`
          )
          break

        case "skipped":
          skipped += 1
          console.warn(
            `[api/cron/tick] skipped the invocation for run ${runId}: ` +
              `${outcome.value.reason}.`
          )
          break

        case "not_started":
          notStarted += 1
          console.error(
            `[api/cron/tick] the invocation for run ${runId} did not start ` +
              `(${outcome.value.reason}). The row is left claimed for the ` +
              `deadline sweep.`
          )
          break
      }
    }

    if (unconfigured) {
      // The sweep and the claim both happened and are reported by their own log
      // lines; the claimed rows are left `claimed` and the sweep will time them out.
      // A 503 rather than a 500 so a monitor can tell "this deployment is missing a
      // variable" from "this endpoint is broken". The message names no variable —
      // that is a fact about our deployment and belongs in the server log, which
      // `MissingRuntimeConfigError` already wrote.
      return serviceUnavailable(
        "The reporting runtime is not configured, so no claimed run could be " +
          "started. The claimed rows will be timed out by a later tick.",
        "RUNTIME_UNCONFIGURED"
      )
    }

    return json(200, {
      swept: swept.length,
      claimed: claimed.length,
      invoked,
      failed,
      skipped,
      notStarted,
    } satisfies TickResponseBody)
  } catch (thrown) {
    // A failure of the sweep or the claim itself — a connection loss, most likely.
    // Nothing partial is reported, because the two statements are each atomic and
    // the next tick 60 seconds from now repeats whichever did not land.
    console.error(
      `[api/cron/tick] the tick failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
