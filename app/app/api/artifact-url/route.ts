import {
  internalError,
  invalidInput,
  notFound,
  searchParamsObject,
  unauthorized,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import {
  ArtifactAccessError,
  keyBelongsToActor,
  parseArtifactKey,
  presignArtifact,
} from "@/lib/aws/s3"
import { artifactUrlQuerySchema } from "@/lib/runs/input"
import { findOwnedRun } from "@/lib/runs/state"

/**
 * `GET /api/artifact-url` — mint a short-lived presigned download
 * (Requirements 37.8, 37.12, 7.7).
 *
 * `export const runtime = "nodejs"` because the presigner is an AWS SDK package and the
 * ownership check opens a Postgres connection, neither of which runs on the edge
 * runtime.
 *
 * ## Two authorization checks, and neither implies the other
 *
 * Requirement 37.8 requires **both**, and they are genuinely independent:
 *
 *  1. **The key's `actor_id` prefix equals the signed-in user's id.** An exact segment
 *     match through `keyBelongsToActor`, not a `startsWith` — for `alice` a prefix
 *     match would authorize `alice-evil/snapshots/…`, which is the specific bug
 *     Requirement 37.12 exists to rule out.
 *  2. **The run named by the key is this user's.** Read scoped by `user_id`, so
 *     another user's run matches no row.
 *
 * Check 1 alone is insufficient because a key can carry a well-formed actor prefix for
 * a run that was never this user's — a run id guessed, or one from a deleted
 * connection. Check 2 alone is insufficient because the key's *remainder* is
 * caller-supplied: a valid run of mine plus somebody else's actor prefix would
 * otherwise presign an object I have no claim to.
 *
 * **Both run before any AWS call.** A probe for another user's key therefore costs
 * nothing and reveals nothing — not even the latency difference between an object that
 * exists and one that does not.
 *
 * ## Not found, never forbidden
 *
 * Requirement 37.12 — a mismatch of either kind resolves as **not found** with no URL
 * minted. "Forbidden" would confirm the key names something real, and what it names is
 * a fact about somebody else's customer.
 *
 * ## The URL is never stored and never cached
 *
 * Requirement 37.8's other half. It is minted per request, in the handler that answers
 * that request, and `lib/api/response.ts` sets `Cache-Control: no-store` on every body
 * it builds — so there is no path on which this response is cached by an intermediary
 * and served to the next requester. `RunView.artifactKeys` carries **keys** precisely
 * so a run payload can be cached and server-rendered without carrying a credential.
 */
export const runtime = "nodejs"

/** The success body. */
type ArtifactUrlResponseBody = {
  readonly url: string
  /** Seconds. At most `MAX_PRESIGN_SECONDS`, so a caller can schedule a retry. */
  readonly expiresIn: number
}

export async function GET(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  // Requirement 7.7 — search parameters are input, parsed with a named schema.
  // `.strict()`, so a body-shaped extra parameter is a rejection rather than something
  // ignored: a caller passing `?expiresIn=3600` is expressing an expectation this route
  // does not honour, and answering it with a 300-second URL would look like it had.
  const query = artifactUrlQuerySchema.safeParse(
    searchParamsObject(request.url)
  )
  if (!query.success) return invalidInput(query.error)

  const key = query.data.key

  // Check 1 — the key's own shape and its actor prefix. Pure, and before anything
  // else, so a malformed or foreign key never reaches a database read either.
  if (!keyBelongsToActor(user.id, key)) return notFound()

  const parsed = parseArtifactKey(key)
  // Unreachable: `keyBelongsToActor` returned true, which required a successful parse.
  // Handled rather than asserted because a `!` here would be a claim this handler
  // cannot back, and the answer for an unparseable key is the same not-found anyway.
  if (parsed === null) return notFound()

  try {
    // Check 2 — the run itself, scoped by `user_id`. The key's actor prefix being
    // right does not make the run mine.
    const run = await findOwnedRun(user.id, parsed.runId)
    if (run === undefined) return notFound()

    // A run that produced no artifact has nothing to presign, and minting a URL for an
    // object that does not exist would hand the browser a link to a 404 it cannot
    // explain. `completed` is the only status under which the snapshot exists.
    if (run.status !== "completed") return notFound()

    const { url, expiresIn } = await presignArtifact(user.id, key)

    // Built directly rather than through `lib/api/response.ts#json`, for one reason:
    // this is the single response body in the app that carries a credential, and
    // `no-store` is stated here where a reader of this handler can see it rather than
    // inherited from a helper. `Vary: Cookie` is added for the same reason — the answer
    // depends on the session, and an intermediary that ignored `no-store` must at least
    // not serve one user's URL to another.
    return new Response(
      JSON.stringify({ url, expiresIn } satisfies ArtifactUrlResponseBody),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          Vary: "Cookie",
        },
      }
    )
  } catch (thrown) {
    if (thrown instanceof ArtifactAccessError) {
      // Raised by `presignArtifact`'s own re-check of the same rule. Reaching it means
      // this handler's check and the module's disagreed, which is a bug — but the safe
      // answer is unchanged, and no URL was minted.
      return notFound()
    }

    // The key is excluded from the log line: it carries the actor id, and this line
    // ends up in a log aggregator.
    console.error(
      `[api/artifact-url] GET failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
