import {
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
} from "@/lib/api/response"
import { runIdParamSchema } from "@/lib/runs/input"
import {
  decideTransition,
  progressCallbackSchema,
  type TransitionRejection,
} from "@/lib/runs/progress"
import {
  PROGRESS_TOKEN_HEADER,
  validateProgressToken,
} from "@/lib/runs/progress-token"
import {
  AGENT_ERROR_CODES,
  APP_WRITTEN_CODES,
  acceptedTargets,
  applyRunWriteIfStatus,
  applyVerifiedCompletion,
  phaseDeadlineFor,
  readRunForTokenHolder,
} from "@/lib/runs/state"

/**
 * `POST /api/internal/runs/[runId]/progress` — the agent advances its own state
 * (Requirement 38).
 *
 * The runtime fires one short POST at every phase transition. Four or five tiny
 * independent requests per run, **none long-lived, none able to time out the way a
 * twelve-minute stream can** — which is the whole reason run state does not depend
 * on a stream staying open. Postgres is the state machine; this endpoint is how the
 * agent writes to it.
 *
 * `export const runtime = "nodejs"` because it opens a Postgres connection and keys
 * an HMAC from `APP_ENCRYPTION_KEY` through `node:crypto`, neither of which runs on
 * the edge runtime.
 *
 * ## One response for every refusal
 *
 * Requirement 38.6 requires a bad token and an unknown run id to produce **one
 * response identical for both cases**. This handler widens that to *every* refusal:
 * a malformed body, an unreachable target, a terminal row, a reserved `TIMEOUT` — all
 * of them answer `404` with the shared fixed body, and none of them discloses a
 * field of any row.
 *
 * Widening it is deliberate. An endpoint that answered `409` for "that run is
 * already terminal" and `404` for "no such run" would be an oracle for run state,
 * reachable by anybody who can reach the URL: the run id is in the path, so probing
 * costs nothing. The reason is still recorded — in the **server log**, which is the
 * only consumer that has any business knowing it.
 *
 * The one exception is a body that fails its schema, which answers `400` with field
 * paths. That is not an information leak: the response describes the *request*, not
 * the row, and it is what makes a wrong callback shape debuggable instead of
 * indistinguishable from a wrong token. The token is checked first regardless, so an
 * unauthorized caller never reaches it.
 *
 * ## Order of operations, and why it is this order
 *
 *  1. **The path parameter**, so a pathological URL is refused before anything else.
 *  2. **The row**, read by id — the token's hash is on it, so there is nothing to
 *     validate against until it is read.
 *  3. **The token**, constant-time against `progress_token_hash`
 *     (Requirement 38.5). Before the body is parsed, so an unauthorized caller
 *     cannot use validation messages to probe the schema.
 *  4. **The body.**
 *  5. **The decision**, pure, in `lib/runs/progress.ts`.
 *  6. **The write**, guarded on the status that was read.
 *
 * Steps 2 and 3 cannot be swapped, and the cost is that an unknown run id skips the
 * token comparison entirely — a timing difference between "no such run" and "wrong
 * token". That is accepted: the run id is not a secret (it is in the URL the agent
 * was handed, and in the browser's own URLs), so a timing oracle for its existence
 * reveals nothing an authenticated user could not already read. Padding it would
 * mean a fake comparison against a fabricated hash, which is more machinery than the
 * threat justifies.
 *
 * ## Nothing here awaits anything slow
 *
 * Requirement 38.7 — the handler returns within 2 seconds and awaits no AgentCore
 * call, no S3 request and no Azure request. It reads one row and writes one row. The
 * gap list is *not* loaded here: the terminal callback carries counts, and the gaps
 * live in the snapshot object the agent already wrote (Requirement 38.12).
 */
export const runtime = "nodejs"

/**
 * The awaited-params shape Next 16 requires for a dynamic route handler: `params`
 * is a **Promise**, and synchronous access was removed
 * (`02-guides/upgrading/version-16.md`).
 */
type ProgressRouteContext = Readonly<{ params: Promise<{ runId: string }> }>

/** The success body. Deliberately minimal: the caller is fire-and-forget. */
type ProgressResponseBody = {
  readonly ok: true
  /** So a log on the agent side can confirm which transition landed. */
  readonly status: string
}

/**
 * Log a refusal, naming the reason and the run id and **nothing else**.
 *
 * The token is excluded — not even as a presence marker, because the marker would
 * still distinguish "absent" from "present but wrong" in a log a wider audience
 * reads than the row does. The run id is in the request path already.
 */
function logRefusal(runId: string, reason: TransitionRejection | string): void {
  console.warn(
    `[api/internal/runs/progress] refused a callback for run ${runId}: ` +
      `${reason}. The response is the shared not-found body, so the caller ` +
      `learns nothing about the row.`
  )
}

export async function POST(
  request: Request,
  context: ProgressRouteContext
): Promise<Response> {
  // 1 — Requirement 7.7: a path parameter is input, parsed with a named schema.
  const params = runIdParamSchema.safeParse(await context.params)
  if (!params.success) return notFound()

  const runId = params.data.runId

  // 2 — The row. Not user-scoped: the caller is a container with no session, and
  //     its authorization is the run-scoped token whose hash lives on this row.
  const run = await readRunForTokenHolder(runId)

  // 3 — Requirements 38.5, 38.6. An unknown run and an invalid token produce the
  //     same answer. `validateProgressToken` is constant-time over the digests and
  //     returns `false` rather than throwing, so both arms are one shape.
  const presented = request.headers.get(PROGRESS_TOKEN_HEADER)

  if (
    run === undefined ||
    presented === null ||
    !validateProgressToken(presented, run.progressTokenHash)
  ) {
    logRefusal(runId, run === undefined ? "unknown run id" : "invalid token")
    return notFound()
  }

  // 4 — The body. Reached only by a caller holding the run's token.
  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  const parsed = progressCallbackSchema.safeParse(body)
  if (!parsed.success) {
    logRefusal(runId, "the callback body failed its schema")
    return invalidInput(parsed.error)
  }

  // A body naming a different run than the path is a caller bug, and honouring
  // either interpretation would be wrong: the path is what the token authorized, so
  // the body's `run_id` cannot be allowed to redirect the write.
  if (parsed.data.run_id !== runId) {
    logRefusal(runId, "the body's run_id does not match the path")
    return notFound()
  }

  // 5 — The decision, pure and separately tested. `now` is read once, here, so the
  //     refreshed `phase_deadline` and `updated_at` are the same instant.
  const now = new Date()

  const decision = decideTransition(run, parsed.data, now, {
    acceptedTargets,
    phaseDeadlineFor,
    agentErrorCodes: AGENT_ERROR_CODES,
    appWrittenCodes: APP_WRITTEN_CODES,
  })

  if (!decision.ok) {
    logRefusal(runId, decision.rejection)
    return notFound()
  }

  // 6 — The write, guarded on the status that was read. A row the reaper's sweep
  //     failed between step 2 and here matches nothing, so a decision made against
  //     a stale status cannot reopen a terminal row.
  //
  //     `verifying → completed` carries one precondition beyond the table
  //     (Requirement 41.1): a passing `report_verifications` row for this run,
  //     read **in the same transaction** as the update. `completed` is the status
  //     the download control keys off, so a run reaching it before its proof was
  //     stored would present a download for a document nothing had verified — for
  //     as long as the verification callback took to arrive, and forever if it
  //     never did.
  const needsProof =
    run.status === "verifying" && decision.write.status === "completed"

  const written = needsProof
    ? await applyVerifiedCompletion(runId, run.status, decision.write, now)
    : await applyRunWriteIfStatus(runId, run.status, decision.write, now)

  if (written === undefined) {
    logRefusal(
      runId,
      needsProof
        ? "no passing verification is stored for this run, or the row's status " +
            "changed between the read and the write"
        : "the row's status changed between the read and the write"
    )
    return notFound()
  }

  return json(200, {
    ok: true,
    status: written.status,
  } satisfies ProgressResponseBody)
}
