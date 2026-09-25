import { WorkspaceAccessError } from "@/lib/workspaces/access"
import {
  internalError,
  invalidInput,
  json,
  notFound,
  serviceUnavailable,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import type { ConnectedSubscriptionView } from "@/lib/db/views"
import { subscriptionIdParamSchema } from "@/lib/subscriptions/input"
import { runAwsPreflight } from "@/lib/subscriptions/preflight"
import {
  readAwsConnectorSetup,
  recordAwsPreflight,
  SubscriptionNotFoundError,
} from "@/lib/subscriptions/store"

export const runtime = "nodejs"

type VerifyResponseBody = {
  readonly subscription: ConnectedSubscriptionView
  readonly regions: readonly string[]
}

/**
 * Verify an AWS connector's role: assume it, prove every required action through IAM's
 * own policy simulation, list the enabled regions.
 *
 * A pass makes the connector `active`. A refusal is a 422 carrying the runtime's reason —
 * which actions are missing, or why the role could not be assumed — and leaves the
 * connector `pending`, so a customer who fixes the role can simply verify again.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const param = subscriptionIdParamSchema.safeParse(await params)
  if (!param.success) return invalidInput(param.error)
  const id = param.data.id

  try {
    const setup = await readAwsConnectorSetup(user.id, id)
    const outcome = await runAwsPreflight({
      actorId: user.id,
      displayName: setup.displayName,
      credentials: {
        provider: "aws",
        subscriptionId: setup.accountId,
        roleArn: setup.roleArn,
        externalId: setup.externalId,
        fidelityTier: "baseline",
        regions: setup.regions,
      },
    })

    if (!outcome.scopeVerified) {
      await recordAwsPreflight(user.id, id, { scopeVerified: false })
      return unprocessable(outcome.message, outcome.code)
    }

    const subscription = await recordAwsPreflight(user.id, id, {
      scopeVerified: true,
      fidelityTier: outcome.fidelityTier,
      regions: outcome.regions,
    })
    return json(200, { subscription, regions: outcome.regions } satisfies VerifyResponseBody)
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    if (thrown instanceof SubscriptionNotFoundError) return notFound()
    if (thrown instanceof MissingRuntimeConfigError) {
      return serviceUnavailable(
        "The reporting runtime is not configured, so the role could not be verified.",
        "RUNTIME_UNCONFIGURED"
      )
    }
    console.error(
      `[api/subscriptions/[id]/verify] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )
    return internalError()
  }
}
