import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  serviceUnavailable,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import type { ConnectedSubscriptionView } from "@/lib/db/views"
import {
  rotateSecretInputSchema,
  subscriptionIdParamSchema,
} from "@/lib/subscriptions/input"
import { runPreflight } from "@/lib/subscriptions/preflight"
import {
  resolveSubscriptionIdentity,
  rotateClientSecret,
  SubscriptionNotFoundError,
} from "@/lib/subscriptions/store"

/**
 * `POST /api/subscriptions/[id]/secret` — rotate a client secret
 * (Requirements 13.7, 13.8, 9.2, 9.7).
 *
 * This is the endpoint behind the rotate action the expired and `disabled` states
 * offer (Requirement 13.3). It does three things in this order, and the order is
 * load-bearing:
 *
 *   1. **Read the stored identity, scoped to the signed-in user.** An id that is
 *      not this user's stops here, as a 404, before a 30-second preflight is spent
 *      on it.
 *   2. **Re-run the preflight with the rotated secret** (Requirement 13.8). The
 *      same service principal, the same subscription, the new credential.
 *   3. **Write the new ciphertext and the submitted expiry** (Requirement 13.7),
 *      with `scope_verified` taken from step 2's result and from nowhere else.
 *
 * `export const runtime = "nodejs"` for the reason its sibling routes declare it:
 * the preflight reaches the AWS SDK and consumes a response stream, and neither
 * works on the edge runtime.
 *
 * ## The body carries the secret and its expiry, and nothing else
 *
 * A rotation replaces a *credential*, not a connection. `tenant_id`, `client_id`
 * and `subscription_id` are unchanged — it is the same app registration with a new
 * secret — so `rotateSecretInputSchema` has no field for them and `.strict()`
 * refuses a body that supplies one. The three identifiers the preflight needs come
 * off the stored row through `resolveSubscriptionIdentity`, so the browser cannot
 * choose which service principal gets re-asserted. There is no `scopeVerified`
 * field either, for the reason the create route documents at length: Requirement
 * 12.14 reserves writing that flag to the Preflight_Service, and the cheapest way
 * to hold it is to leave no other way in.
 *
 * `resolveSubscriptionIdentity` rather than `resolveSubscriptionCredentials`
 * because this route has no use for the old secret and must not depend on it being
 * readable. A row whose stored envelope no longer decrypts is precisely a row that
 * needs rotating, and resolving credentials would raise
 * `SubscriptionSecretUnreadableError` on the one request that repairs it.
 *
 * ## A rejected preflight still records the rotation — the deliberate choice
 *
 * When the re-run assertion fails, this route **writes the new ciphertext anyway**
 * and answers `422` carrying the preflight's own code. The row lands
 * `scope_verified: false`, which the store derives `status: 'pending'` from. Three
 * reasons, in order of weight:
 *
 *   * **Requirement 13.7 is unconditional.** It says a submitted rotation replaces
 *     `client_secret_enc`, records the expiry and retains no earlier ciphertext,
 *     and it names no precondition. Requirement 13.8 separately says the preflight
 *     re-runs and `scope_verified` comes from its result. Read together, the write
 *     happens and the *flag* is what the preflight decides.
 *   * **The consultant needs a path back to working.** Rotation is reached from an
 *     expired or `disabled` row, so the stored envelope encrypts a credential
 *     Azure has already stopped accepting. Refusing the write leaves that dead
 *     ciphertext in place — a retained credential that authenticates nothing — and
 *     makes repair impossible for the case where the role assignment lapsed too:
 *     the secret could never be updated until somebody else fixed the role first.
 *     A passing rotation, by contrast, clears `disabled` in the same write.
 *   * **Nothing unsafe becomes reachable.** `pending` is what
 *     `resolveSubscriptionState` reads and what `subscriptionRunBlocker` refuses
 *     with `SCOPE_UNVERIFIED`, so a rotation that failed its assertion cannot start
 *     a run — the same gate an unverified new connection meets. And `active`
 *     alongside `scope_verified: false` stays unrepresentable, because the store
 *     derives `status` and this route passes none.
 *
 * The alternative — refuse the write, answer 422, change nothing — is defensible
 * and was rejected for the second reason. It also makes Requirement 13.7
 * conditional on something Requirement 13.7 does not mention.
 *
 * One consequence worth naming: a rejected rotation moves a `disabled` row to
 * `pending`, so Azure's recorded evidence about the *old* credential is dropped
 * along with the old credential. That evidence was about a secret that no longer
 * exists. If Azure rejects the new one too, Requirement 13.9's writer sets
 * `disabled` again on the next attempt, and the blocking gate holds in the interim
 * either way — only the code the UI shows differs.
 *
 * ## What crosses to the browser
 *
 * Only {@link ConnectedSubscriptionView} (Requirement 10.2). The plaintext secret
 * arrives in the body, goes into the preflight's invoke payload and into the
 * store's encryption, and is referenced nowhere after — no module-level storage, no
 * log line, no response field. Neither the previous ciphertext nor the new one has
 * anywhere to appear.
 */
export const runtime = "nodejs"

/**
 * The awaited-params shape Next 16 requires for a dynamic route handler:
 * `params` is a **Promise**, and synchronous access was removed
 * (`02-guides/upgrading/version-16.md`).
 *
 * Typed structurally rather than with the generated
 * `RouteContext<'/api/subscriptions/[id]/secret'>` global, matching the decision
 * `app/(auth)/login/page.tsx` makes about `PageProps`: `.next/types` is generated
 * by `next typegen` and git-ignored, so a checkout that has not built yet would
 * fail `pnpm typecheck` on a name that does not exist. The shape is identical to
 * the one the generated helper declares — `{ params: Promise<{ id: string }> }` —
 * so the handler signature is the same either way.
 */
type SecretRouteContext = Readonly<{ params: Promise<{ id: string }> }>

/** The success body. */
type RotateResponseBody = { readonly subscription: ConnectedSubscriptionView }

/**
 * What a rejected-but-recorded rotation says, ahead of the preflight's own prose.
 *
 * The consultant has to know both facts: the secret they submitted **was** stored,
 * and the connection still cannot run. Answering with the preflight's message
 * alone would read as "nothing happened", and they would submit it again.
 */
function rotatedButUnverified(preflightMessage: string): string {
  return (
    "The rotated client secret was recorded, but read at subscription scope " +
    `was not proved, so this connection cannot start a run. ${preflightMessage}`
  )
}

export async function POST(
  request: Request,
  context: SecretRouteContext
): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  // Requirement 7.7 — the path parameter is input, parsed with a named schema
  // like any body. `await` because Next 16 removed synchronous `params`.
  const params = subscriptionIdParamSchema.safeParse(await context.params)
  if (!params.success) return invalidInput(params.error)

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  // Requirement 11.9's range applies to a rotated secret exactly as it does to a
  // new one, and it is checked here — before a 30-second preflight is spent on an
  // expiry that cannot be recorded anyway.
  const parsed = rotateSecretInputSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  const submitted = parsed.data
  const subscriptionRowId = params.data.id

  try {
    // Requirements 9.7, 9.8 — scoped to the signed-in user, so another user's id
    // is a 404 and no preflight runs for it. The identity is read rather than
    // accepted from the body: the same principal is re-asserted, not one the
    // caller nominated.
    const identity = await resolveSubscriptionIdentity(
      user.id,
      subscriptionRowId
    )

    // Requirement 13.8 — the permissions assertion, re-run with the rotated
    // secret. `actorId` comes from the session, never from the body.
    const outcome = await runPreflight({
      actorId: user.id,
      displayName: identity.displayName,
      subscriptionId: identity.subscriptionId,
      tenantId: identity.tenantId,
      clientId: identity.clientId,
      clientSecret: submitted.clientSecret,
      logAnalyticsWorkspaceId: identity.logAnalyticsWorkspaceId,
    })

    // Requirement 13.7 — fresh ciphertext and the submitted expiry, retaining no
    // earlier ciphertext. `scopeVerified` is the preflight's answer and `status`
    // is not passed: the store derives it, which is what keeps `active` alongside
    // `scope_verified: false` unrepresentable. The tier is forwarded only when
    // the preflight probed one — a rejection carries no tier at all, and leaving
    // the field absent keeps the recorded tier rather than resetting it.
    const subscription = await rotateClientSecret(user.id, subscriptionRowId, {
      clientSecret: submitted.clientSecret,
      secretExpiresAt: submitted.secretExpiresAt,
      scopeVerified: outcome.scopeVerified,
      ...(outcome.scopeVerified ? { fidelityTier: outcome.fidelityTier } : {}),
    })

    if (!outcome.scopeVerified) {
      // `422`, not `400`: the submission was well-formed and understood, and the
      // answer was that the scope could not be proved. The code travels so the UI
      // can tell `SCOPE_UNVERIFIED` from `AUTH_EXPIRED` (Requirement 12.13) — one
      // is a role the customer fixes, the other a secret Azure would not accept.
      return unprocessable(rotatedButUnverified(outcome.message), outcome.code)
    }

    return json(200, { subscription } satisfies RotateResponseBody)
  } catch (thrown) {
    if (thrown instanceof SubscriptionNotFoundError) {
      // Requirements 9.7, 9.8 — not found, never forbidden, and the same answer
      // for an id that does not exist as for one that is somebody else's. Raised
      // by the identity read before any write, and by the rotation itself if the
      // row went away in between.
      return notFound()
    }

    if (thrown instanceof MissingRuntimeConfigError) {
      return serviceUnavailable(
        "The reporting runtime is not configured, so the rotated secret could " +
          "not be verified and nothing was changed.",
        "RUNTIME_UNCONFIGURED"
      )
    }

    // Both modules in this path redact what they throw — the store replaces a
    // driver failure with the operation and the SQLSTATE and nothing else — so
    // this line cannot write the submitted secret, either ciphertext, the tenant
    // id or the client id into a log.
    console.error(
      `[api/subscriptions/[id]/secret] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
