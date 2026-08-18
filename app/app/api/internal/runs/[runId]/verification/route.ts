import {
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
} from "@/lib/api/response"
import { getSnapshotJson, keyBelongsToActor } from "@/lib/aws/s3"
import { runIdParamSchema } from "@/lib/runs/input"
import {
  PROGRESS_TOKEN_HEADER,
  validateProgressToken,
} from "@/lib/runs/progress-token"
import { readRunForTokenHolder } from "@/lib/runs/state"
import {
  describesSameAttempt,
  verificationCallbackSchema,
} from "@/lib/runs/verification-callback"
import { verificationResultSchema } from "@/lib/verifications/result"
import { insertVerification } from "@/lib/verifications/store"

/**
 * `POST /api/internal/runs/[runId]/verification` — the agent records its proof
 * (Requirements 36.1, 41.5).
 *
 * Sibling of the progress endpoint and deliberately shaped like it: same
 * run-scoped HMAC, same constant-time validator, same single `404` for a bad
 * token and an unknown run id. Two endpoints rather than one because the two
 * carry different things and fail for different reasons — a verification whose
 * artifact cannot be read must not also lose the phase transition it travelled
 * with, and a phase transition must not be held up while an S3 object is fetched.
 *
 * **The callback carries a pointer.** Its body names the artifact key; this
 * handler fetches and parses the object. The obvious alternative — send the
 * result — does not survive the numbers: up to 1,000 findings with 200-character
 * excerpts is several hundred kilobytes in a fire-and-forget POST that the agent
 * abandons after five seconds, so the delivery most likely to fail would be the
 * one carrying the most findings. Exactly backwards.
 *
 * `export const runtime = "nodejs"` because it opens a Postgres connection and an
 * S3 client, neither of which the edge runtime provides.
 */
export const runtime = "nodejs"

type VerificationRouteContext = Readonly<{ params: Promise<{ runId: string }> }>

type VerificationResponseBody = {
  readonly ok: true
  /** So the agent's log can confirm which attempt landed. */
  readonly attemptId: string
}

/**
 * Log a refusal naming the reason and the run id and **nothing else**.
 *
 * No token, not even as a presence marker: the marker would still distinguish
 * "absent" from "present but wrong" in a log a wider audience reads than the row
 * does. No artifact key either — it carries an actor id.
 */
function logRefusal(runId: string, reason: string): void {
  console.warn(
    `[api/internal/runs/verification] refused a callback for run ${runId}: ` +
      `${reason}. The response is the shared not-found body, so the caller ` +
      `learns nothing about the row.`
  )
}

export async function POST(
  request: Request,
  context: VerificationRouteContext
): Promise<Response> {
  const params = runIdParamSchema.safeParse(await context.params)
  if (!params.success) return notFound()

  const runId = params.data.runId
  const run = await readRunForTokenHolder(runId)
  const presented = request.headers.get(PROGRESS_TOKEN_HEADER)

  // An unknown run id and an invalid token produce one identical 404: a caller
  // must not be able to enumerate run ids by the shape of the refusal.
  if (
    run === undefined ||
    presented === null ||
    !validateProgressToken(presented, run.progressTokenHash)
  ) {
    logRefusal(runId, run === undefined ? "unknown run id" : "invalid token")
    return notFound()
  }

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  const parsed = verificationCallbackSchema.safeParse(body)
  if (!parsed.success) {
    logRefusal(runId, "the callback body failed its schema")
    return invalidInput(parsed.error)
  }

  const callback = parsed.data

  // The path is what the token authorized, so the body's `run_id` may not
  // redirect the write.
  if (callback.run_id !== runId) {
    logRefusal(runId, "the body's run_id does not match the path")
    return notFound()
  }

  // The key names an object under *this run's actor*. Checked before the fetch,
  // and with the same exact-segment predicate every download runs through, so a
  // callback cannot make this app read an arbitrary object in the bucket.
  if (!keyBelongsToActor(run.userId, callback.artifact_key)) {
    logRefusal(runId, "the artifact key does not belong to this run's actor")
    return notFound()
  }

  let raw: unknown
  try {
    raw = await getSnapshotJson(callback.artifact_key)
  } catch {
    logRefusal(runId, "the verification artifact could not be read")
    return notFound()
  }

  const result = verificationResultSchema.safeParse(raw)
  if (!result.success) {
    logRefusal(runId, "the verification artifact failed its schema")
    return notFound()
  }

  // The callback and the artifact are two statements about one verification,
  // delivered separately. A retried callback whose key was built from a stale
  // attempt id would otherwise insert a row whose `attempt_id` and whose artifact
  // disagree, and every later reader would follow the pointer to the wrong object.
  if (!describesSameAttempt(callback, result.data)) {
    logRefusal(runId, "the artifact describes a different attempt")
    return notFound()
  }

  // Idempotent on `(run_id, attempt_id)`: a retried delivery resolves exactly as
  // the first one did, without inflating this run's attempt count.
  const row = await insertVerification({
    result: result.data,
    artifactKey: callback.artifact_key,
  })

  return json(200, {
    ok: true,
    attemptId: row.attemptId,
  } satisfies VerificationResponseBody)
}
