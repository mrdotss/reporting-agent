import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  readJsonBody,
  serviceUnavailable,
  unauthorized,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import { subscriptionTestInputSchema } from "@/lib/subscriptions/input"
import {
  runPreflight,
  type PreflightOutcome,
} from "@/lib/subscriptions/preflight"

/**
 * `POST /api/subscriptions/test` — the preflight probe (Requirements 12.11,
 * 12.12, 12.5, 7.7).
 *
 * The wizard's third step submits a credential here and renders what comes back.
 * **This route persists nothing.** It answers one question — does this service
 * principal hold read at this subscription's own scope — and the create route is
 * where an accepted answer becomes a row.
 *
 * `export const runtime = "nodejs"` is load-bearing rather than documentary: the
 * AWS SDK requires Node, and this handler consumes a response stream, which the
 * edge runtime's fetch shape does not give in the form `invokeAgentRuntime`
 * returns.
 *
 * **No Azure SDK is imported here, or anywhere in `app/`.** The permissions
 * request is issued inside the agent container (Requirement 12.11); this handler
 * invokes `command: "preflight"` and reads the answer off the event stream. See
 * `lib/subscriptions/preflight.ts` for why the app holds no Azure token.
 *
 * ## Why a rejection is a `200`
 *
 * A rejected preflight is this endpoint's **answer**, not its failure: the probe
 * ran, and the result is that the scope could not be proved. The wizard renders
 * that as a result step explaining the subscription-scope Reader requirement
 * (Requirement 12.7), which it can only do if it received a parsed body rather
 * than an error it has to interpret. The create route treats the same outcome as a
 * `422`, because there the rejection *is* a refusal to do what was asked.
 *
 * ## What does not survive this request
 *
 * The plaintext client secret arrives in the body, goes into the invoke payload,
 * and is referenced nowhere else — no module-level storage, no log line, and no
 * field of the response. The response body is either
 * `{ scopeVerified: true, fidelityTier }` or
 * `{ scopeVerified: false, code, message }`, and neither shape has a place to put
 * it.
 */
export const runtime = "nodejs"

/** The body this route answers with. Nothing derived from the submission. */
type PreflightResponseBody = PreflightOutcome

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  // Requirement 7.7 — parsed at the boundary, with a named schema, and `.strict()`
  // so a body carrying `scopeVerified: true` is rejected rather than ignored.
  const parsed = subscriptionTestInputSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  const submitted = parsed.data

  try {
    // `actorId` comes from the session, never from the body (Requirement 41.4's
    // rule for credentials, applied to the identity too). The submitted
    // `secretExpiresAt` is validated by the schema above and deliberately not
    // forwarded: the expiry is a fact about the credential that the store records,
    // and the runtime has no use for it.
    const outcome = await runPreflight({
      actorId: user.id,
      displayName: submitted.displayName,
      subscriptionId: submitted.subscriptionId,
      tenantId: submitted.tenantId,
      clientId: submitted.clientId,
      clientSecret: submitted.clientSecret,
      logAnalyticsWorkspaceId: submitted.logAnalyticsWorkspaceId,
    })

    return json(200, outcome satisfies PreflightResponseBody)
  } catch (thrown) {
    if (thrown instanceof MissingRuntimeConfigError) {
      // A deployment mistake, reported as one. Telling the consultant their
      // customer's role assignment is wrong would send them to argue with an
      // administrator about a correct assignment.
      return serviceUnavailable(
        "The reporting runtime is not configured, so the connection could not " +
          "be tested. No change was made.",
        "RUNTIME_UNCONFIGURED"
      )
    }

    // `runPreflight` answers rather than throws for every failure of the
    // connection, so reaching here is a defect on our side. The log line carries
    // the error's name and message and nothing from the request: neither module in
    // this path puts a submitted value into an error, and this is the one place
    // that would write it where a log aggregator could read it.
    console.error(
      `[api/subscriptions/test] unexpected failure: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
