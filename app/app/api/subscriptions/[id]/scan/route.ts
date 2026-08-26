import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  searchParamsObject,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import {
  scanParamsSchema,
  scanPostBodySchema,
  scanQuerySchema,
} from "@/lib/scans/input"
import { executeScan } from "@/lib/scans/execute"
import {
  createScan,
  readLatestScan,
  readSubscriptionForScan,
  ScanSubscriptionNotFoundError,
} from "@/lib/scans/store"
import {
  getConnectedSubscription,
  resolveSubscriptionCredentials,
  SubscriptionNotFoundError,
  SubscriptionSecretUnreadableError,
} from "@/lib/subscriptions/store"

/**
 * `POST /api/subscriptions/[id]/scan` — start a subscription scan.
 * `GET /api/subscriptions/[id]/scan` — return the latest scan for this subscription.
 *
 * ## Why a scan does NOT join the report_runs state machine
 *
 * A scan produces no snapshot, no ledger and no artifact. Giving it the reaper,
 * the progress callback and the phase deadlines would be machinery with nothing
 * to protect. The row carries `status` and the screen polls `GET`; a dead
 * `running` row is superseded by the next scan, and the screen offers "Re-scan".
 *
 * ## Refusal before invocation (Requirement 4.8)
 *
 * An inventory query is RBAC-filtered: a scan taken through a narrowed role would
 * present a partial estate as the whole one. So the POST refuses BEFORE invoking
 * anything when:
 *   - `scope_verified` is false — the subscription has not been proven at
 *     subscription scope.
 *   - `secret_expires_at` has passed — the credential is expired.
 *
 * Both return `unprocessable` naming WHICH of the two it is, not a generic failure.
 */
export const runtime = "nodejs"

type ScanRouteContext = Readonly<{ params: Promise<{ id: string }> }>

// --- POST -------------------------------------------------------------------

export async function POST(
  request: Request,
  context: ScanRouteContext
): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const params = scanParamsSchema.safeParse(await context.params)
  if (!params.success) return invalidInput(params.error)

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  const parsed = scanPostBodySchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  const subscriptionId = params.data.id

  try {
    const sub = await readSubscriptionForScan(user.id, subscriptionId)

    // Requirement 4.8 — refuse before invoking when scope is unverified.
    if (!sub.scopeVerified) {
      return unprocessable(
        "This subscription's scope has not been verified at subscription level. " +
          "Complete the preflight before scanning.",
        "SCOPE_UNVERIFIED"
      )
    }

    // Requirement 4.8 — refuse before invoking when the secret has expired.
    if (sub.secretExpiresAt.getTime() <= Date.now()) {
      return unprocessable(
        "This subscription's client secret has expired. Rotate the secret " +
          "before scanning.",
        "SECRET_EXPIRED"
      )
    }

    const scan = await createScan(user.id, subscriptionId)

    // Resolve credentials server-side. Never logged, never echoed.
    const subView = await getConnectedSubscription(user.id, subscriptionId)
    const credentials = await resolveSubscriptionCredentials(
      user.id,
      subscriptionId
    )

    // Execute the scan synchronously in this request. The scan invocation is
    // short-lived (~5–20s) — not a report run. The row carries `status` and the
    // screen polls GET; this request completes with the final result.
    const completed = await executeScan({
      scanId: scan.id,
      actorId: user.id,
      displayName: subView.displayName,
      credentials,
    })

    return json(201, { scan: completed })
  } catch (thrown) {
    if (thrown instanceof ScanSubscriptionNotFoundError) {
      return notFound()
    }
    if (thrown instanceof SubscriptionNotFoundError) {
      return notFound()
    }
    if (thrown instanceof SubscriptionSecretUnreadableError) {
      return unprocessable(
        "The stored client secret could not be decrypted. Rotate the secret.",
        "SECRET_UNREADABLE"
      )
    }

    console.error(
      `[api/subscriptions/[id]/scan] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}

// --- GET --------------------------------------------------------------------

export async function GET(
  request: Request,
  context: ScanRouteContext
): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const params = scanParamsSchema.safeParse(await context.params)
  if (!params.success) return invalidInput(params.error)

  const query = scanQuerySchema.safeParse(searchParamsObject(request.url))
  if (!query.success) return invalidInput(query.error)

  const subscriptionId = params.data.id

  try {
    // Ownership check — readSubscriptionForScan scopes by user_id; a row
    // belonging to another user throws ScanSubscriptionNotFoundError.
    await readSubscriptionForScan(user.id, subscriptionId)

    const scan = await readLatestScan(user.id, subscriptionId)

    if (scan === null) {
      return json(200, { scan: null })
    }

    return json(200, { scan })
  } catch (thrown) {
    if (thrown instanceof ScanSubscriptionNotFoundError) {
      return notFound()
    }

    console.error(
      `[api/subscriptions/[id]/scan] GET failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
