import {
  internalError,
  json,
  notFound,
  serviceUnavailable,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import { listConnectorResources } from "@/lib/subscriptions/resources"
import {
  getConnectedSubscription,
  resolveSubscriptionCredentials,
  SubscriptionNotFoundError,
  SubscriptionSecretUnreadableError,
} from "@/lib/subscriptions/store"

/**
 * `GET /api/subscriptions/[id]/resources` — the machines a connector can see, for the Ask
 * page's live metrics picker (ask-chat Req 8.1).
 *
 * Any workspace member who can read the connector may list its machines. The listing is
 * resolved in the runtime with the connector's credentials, decrypted here and never sent
 * to the browser; the response carries names, regions, sizes and resource ids only.
 *
 * Refused before invoking for a connector that could not collect anyway — scope not proven
 * at subscription level, or a secret already expired — so the answer names the fix.
 */
export const runtime = "nodejs"

type ResourcesRouteContext = Readonly<{ params: Promise<{ id: string }> }>

export async function GET(_request: Request, context: ResourcesRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const { id } = await context.params

  try {
    const connector = await getConnectedSubscription(user.id, id)
    if (!connector.scopeVerified) {
      return unprocessable(
        "This connector's read access hasn't been proven at subscription level yet.",
        "SCOPE_UNVERIFIED"
      )
    }
    if (connector.provider !== "azure") {
      return unprocessable(
        "This is available for Azure connectors only, for now.",
        "PROVIDER_UNSUPPORTED"
      )
    }
    if (connector.secretExpiresAt === null || Date.parse(connector.secretExpiresAt) <= Date.now()) {
      return unprocessable(
        "This connector's client secret has expired. Rotate it on Connectors first.",
        "SECRET_EXPIRED"
      )
    }

    const credentials = await resolveSubscriptionCredentials(user.id, id)
    const listing = await listConnectorResources({
      connectorId: id,
      actorId: user.id,
      displayName: connector.displayName,
      credentials,
    })

    if (!listing.available) return serviceUnavailable(listing.message, "RESOURCES_UNAVAILABLE")
    return json(200, { resources: listing.resources, truncated: listing.truncated })
  } catch (thrown) {
    if (thrown instanceof SubscriptionNotFoundError) return notFound()
    if (thrown instanceof SubscriptionSecretUnreadableError) {
      return unprocessable(
        "The stored client secret couldn't be decrypted. Rotate it on Connectors.",
        "SECRET_UNREADABLE"
      )
    }
    if (thrown instanceof MissingRuntimeConfigError) {
      return serviceUnavailable("The agent runtime is not configured.", "RUNTIME_UNCONFIGURED")
    }
    console.error(
      `[api/subscriptions/:id/resources] GET failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`
    )
    return internalError()
  }
}
