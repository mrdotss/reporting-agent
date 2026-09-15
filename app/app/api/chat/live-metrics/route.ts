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
import { requireAskLevel } from "@/lib/chat/access"
import { livePullSchema } from "@/lib/chat/input"
import { toLiveMetricPullView } from "@/lib/db/views"
import {
  createLivePull,
  executeLivePull,
  listLivePulls,
  LivePullConnectorNotFoundError,
} from "@/lib/live-metrics/execute"
import { windowProblem } from "@/lib/live-metrics/window"
import { listConnectorResources } from "@/lib/subscriptions/resources"
import {
  getConnectedSubscription,
  resolveSubscriptionCredentials,
  SubscriptionNotFoundError,
  SubscriptionSecretUnreadableError,
} from "@/lib/subscriptions/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import { selectedContext } from "@/lib/workspaces/context"

/**
 * `POST /api/chat/live-metrics` — collect live metrics for picked machines over whole local
 * days, and `GET` — the selected workspace's completed pulls (ask-chat Req 8).
 *
 * The POST runs the collection in the request, like a scan, and answers with the finished
 * pull. Order matters:
 *
 *   1. the window is validated — whole days, not after today, inside Azure Monitor's
 *      93-day retention;
 *   2. the connector is read with the user's access, and refused if it could not collect;
 *   3. every picked id is checked against the connector's own machine listing, so a body
 *      cannot name a resource the connector does not see;
 *   4. the pull row is created with **edit** access — collection spends the connector's
 *      credential, the same bar as requesting a report;
 *   5. the collection runs and the row records its outcome.
 */
export const runtime = "nodejs"

export async function GET(): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  try {
    const { workspace } = await selectedContext(user.id)
    await requireAskLevel(user.id, workspace.id, "read")
    const pulls = await listLivePulls(user.id, workspace.id)
    return json(200, { pulls: pulls.map(toLiveMetricPullView) })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    console.error(`[api/chat/live-metrics] GET failed: ${describe(thrown)}`)
    return internalError()
  }
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = livePullSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)
  const { connectedSubscriptionId, resourceIds, window } = parsed.data

  const problem = windowProblem(window)
  if (problem !== null) return unprocessable(problem, "WINDOW_INVALID")

  try {
    // Collecting is asking: the chat level, in the workspace Ask is open in
    // (roles-and-ask-access Req 6). The pull's own edit check on the connector follows.
    const { workspace } = await selectedContext(user.id)
    await requireAskLevel(user.id, workspace.id, "chat")
    const connector = await getConnectedSubscription(user.id, connectedSubscriptionId)
    if (!connector.scopeVerified) {
      return unprocessable(
        "This connector's read access hasn't been proven at subscription level yet.",
        "SCOPE_UNVERIFIED"
      )
    }
    if (Date.parse(connector.secretExpiresAt) <= Date.now()) {
      return unprocessable(
        "This connector's client secret has expired. Rotate it on Connectors first.",
        "SECRET_EXPIRED"
      )
    }

    const credentials = await resolveSubscriptionCredentials(user.id, connectedSubscriptionId)
    const listing = await listConnectorResources({
      connectorId: connectedSubscriptionId,
      actorId: user.id,
      displayName: connector.displayName,
      credentials,
    })
    if (!listing.available) return serviceUnavailable(listing.message, "RESOURCES_UNAVAILABLE")

    const byId = new Map(
      listing.resources.map((resource) => [resource.resourceId.toLowerCase(), resource])
    )
    const picked = resourceIds.map((resourceId) => byId.get(resourceId.toLowerCase()))
    if (picked.some((resource) => resource === undefined)) {
      return unprocessable(
        "One of the picked machines isn't visible to this connector any more. Reopen the list and pick again.",
        "RESOURCE_NOT_VISIBLE"
      )
    }
    const machines = picked.filter((resource) => resource !== undefined)

    const pull = await createLivePull({
      userId: user.id,
      connectedSubscriptionId,
      resourceIds: machines.map((resource) => resource.resourceId),
      resourceNames: machines.map((resource) => resource.name),
      window,
    })

    const finished = await executeLivePull({
      pull,
      displayName: connector.displayName,
      credentials,
    })

    const view = toLiveMetricPullView(finished)
    return finished.status === "complete"
      ? json(201, { pull: view })
      : json(502, {
          error: {
            message:
              finished.errorMessage ?? "The metrics for these machines couldn’t be collected.",
            code: finished.errorCode ?? "COLLECTION_FAILED",
          },
          pull: view,
        })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    if (thrown instanceof SubscriptionNotFoundError) return notFound()
    if (thrown instanceof LivePullConnectorNotFoundError) return notFound()
    if (thrown instanceof SubscriptionSecretUnreadableError) {
      return unprocessable(
        "The stored client secret couldn't be decrypted. Rotate it on Connectors.",
        "SECRET_UNREADABLE"
      )
    }
    if (thrown instanceof MissingRuntimeConfigError) {
      return serviceUnavailable("The agent runtime is not configured.", "RUNTIME_UNCONFIGURED")
    }
    console.error(`[api/chat/live-metrics] POST failed: ${describe(thrown)}`)
    return internalError()
  }
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown
}
