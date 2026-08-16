import {
  conflict,
  internalError,
  invalidInput,
  json,
  malformedBody,
  readJsonBody,
  searchParamsObject,
  serviceUnavailable,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import type { ConnectedSubscriptionView } from "@/lib/db/views"
import {
  subscriptionCreateInputSchema,
  subscriptionListQuerySchema,
} from "@/lib/subscriptions/input"
import { runPreflight } from "@/lib/subscriptions/preflight"
import {
  createConnectedSubscription,
  listConnectedSubscriptions,
  SubscriptionAlreadyConnectedError,
} from "@/lib/subscriptions/store"

/**
 * `POST /api/subscriptions` and `GET /api/subscriptions` (Requirements 10.2,
 * 11.9, 11.10, 12.5, 12.11, 12.12, 12.14, 7.7).
 *
 * `export const runtime = "nodejs"` for the reason the sibling route declares it:
 * `POST` reaches the AWS SDK and consumes a response stream, and neither works on
 * the edge runtime.
 *
 * ## `POST` runs the preflight itself
 *
 * It does **not** accept a preflight result from the browser, and this is the
 * single most important decision in this file. Requirement 12.14 makes the
 * Preflight_Service the only writer of a `scope_verified` value of true, and the
 * cheapest way to hold that is to leave no other way in: the create schema has no
 * `scopeVerified` field (and `.strict()`, so a body carrying one is rejected
 * rather than ignored), and the flag this route hands the store is read off the
 * runtime's own `done` event inside {@link runPreflight}.
 *
 * The alternative — trusting the `/test` result the wizard already has — is what
 * makes an over-narrow role assignment deliverable. A principal holding Reader on
 * one resource group returns that group's resources, every metric query succeeds,
 * every figure verifies, and the document is 90% incomplete with nothing in the
 * data to say so. The only thing standing between that and a signed report is that
 * the flag came from the permissions response. A browser-supplied `true` removes
 * it.
 *
 * So `/test` and `POST` both preflight, and the duplicated 30 seconds is the
 * price. `/test` exists so the wizard can show the result *before* asking for a
 * name and saving — Requirement 11.10's "no control that saves a connection
 * without that result" is a statement about the wizard's flow — not so that the
 * save can skip the check.
 *
 * ## Requirement 12.5, structurally
 *
 * "Persist no row whose `status` is `active`" is not enforced by a branch here.
 * `lib/subscriptions/store.ts` **derives** `status` from `scopeVerified` through a
 * private `statusFor`, so `active` alongside `scope_verified: false` is
 * unrepresentable — there is no argument through which this route could ask for
 * it. What this route adds is that a rejected preflight writes **no row at all**:
 * a `pending` row for a connection the consultant was told was refused would show
 * up on their subscriptions screen as something they had connected.
 *
 * ## What crosses to the browser
 *
 * Only {@link ConnectedSubscriptionView} (Requirement 10.2). The store returns
 * that shape and nothing else, so the unmasked subscription id, the tenant id, the
 * client id and the ciphertext cannot reach a response body from here. The
 * plaintext secret is consumed by the preflight and by the store's encryption and
 * is referenced nowhere after — no module-level storage, no log line, no response
 * field.
 */
export const runtime = "nodejs"

/** The `POST` success body. */
type CreateResponseBody = { readonly subscription: ConnectedSubscriptionView }

/** The `GET` success body. */
type ListResponseBody = {
  readonly subscriptions: readonly ConnectedSubscriptionView[]
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  // Requirement 7.7, and Requirement 11.9 inside it: an expiry that is absent, at
  // or before now, or more than 24 months out is rejected here, with the accepted
  // range stated by the schema's own message — before a 30-second preflight is
  // spent on a submission that cannot be recorded anyway.
  const parsed = subscriptionCreateInputSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  const submitted = parsed.data

  try {
    const outcome = await runPreflight({
      actorId: user.id,
      displayName: submitted.displayName,
      subscriptionId: submitted.subscriptionId,
      tenantId: submitted.tenantId,
      clientId: submitted.clientId,
      clientSecret: submitted.clientSecret,
      logAnalyticsWorkspaceId: submitted.logAnalyticsWorkspaceId,
    })

    if (!outcome.scopeVerified) {
      // Requirement 12.5 — no row, of any status. `422` rather than `400`: the
      // submission was well-formed and understood, and the answer was that the
      // scope could not be proved. The code travels so the UI can tell
      // `SCOPE_UNVERIFIED` from `AUTH_EXPIRED` (Requirement 12.13) — one is a role
      // the customer fixes, the other a secret the consultant rotates.
      return unprocessable(outcome.message, outcome.code)
    }

    const subscription = await createConnectedSubscription({
      userId: user.id,
      displayName: submitted.displayName,
      subscriptionId: submitted.subscriptionId,
      tenantId: submitted.tenantId,
      clientId: submitted.clientId,
      clientSecret: submitted.clientSecret,
      secretExpiresAt: submitted.secretExpiresAt,
      // Both from the preflight result and from nowhere else
      // (Requirements 12.14, 12.8–12.10). `status` is derived from the first of
      // them by the store, which is why none is passed.
      scopeVerified: outcome.scopeVerified,
      fidelityTier: outcome.fidelityTier,
      logAnalyticsWorkspaceId: submitted.logAnalyticsWorkspaceId,
    })

    return json(201, { subscription } satisfies CreateResponseBody)
  } catch (thrown) {
    if (thrown instanceof SubscriptionAlreadyConnectedError) {
      // Requirement 9.10 — stated, with no second row written. The message is the
      // error's own and names no id.
      return conflict(thrown.message, "ALREADY_CONNECTED")
    }

    if (thrown instanceof MissingRuntimeConfigError) {
      return serviceUnavailable(
        "The reporting runtime is not configured, so the connection could not " +
          "be verified and nothing was saved.",
        "RUNTIME_UNCONFIGURED"
      )
    }

    // The store already replaces a driver failure with a redacted error carrying
    // the operation and the SQLSTATE and nothing else, so this line cannot write
    // the ciphertext, the tenant id or the client id into a log.
    console.error(
      `[api/subscriptions] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}

export async function GET(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  // Requirement 7.7 counts search parameters as input, so they are parsed rather
  // than ignored. The accepted set is empty and `.strict()`, which makes
  // `?userId=…` a rejection: every read is scoped to the signed-in user, and
  // answering that request with the caller's own subscriptions would look like the
  // filter had been honoured.
  const query = subscriptionListQuerySchema.safeParse(
    searchParamsObject(request.url)
  )
  if (!query.success) return invalidInput(query.error)

  try {
    const subscriptions = await listConnectedSubscriptions(user.id)

    return json(200, { subscriptions } satisfies ListResponseBody)
  } catch (thrown) {
    console.error(
      `[api/subscriptions] GET failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
