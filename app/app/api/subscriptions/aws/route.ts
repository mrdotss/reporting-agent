import { WorkspaceAccessError } from "@/lib/workspaces/access"
import {
  conflict,
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  unauthorized,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import type { ConnectedSubscriptionView } from "@/lib/db/views"
import { awsConnectorPrincipal } from "@/lib/subscriptions/aws-principal"
import { awsConnectorCreateInputSchema } from "@/lib/subscriptions/input"
import {
  createAwsConnector,
  SubscriptionAlreadyConnectedError,
} from "@/lib/subscriptions/store"

export const runtime = "nodejs"

type CreateResponseBody = { readonly subscription: ConnectedSubscriptionView }

/**
 * Start an AWS connection: save it `pending` with a fresh external id, so the setup page
 * can show the customer a template that names it.
 *
 * Nothing is proved here and nothing can run against the connector yet — that is
 * `POST /api/subscriptions/[id]/verify`, once the customer has deployed the role. A
 * deployment without `RPT_AWS_CONNECTOR_PRINCIPAL_ARN` does not offer AWS at all, so this
 * answers 404 there as though the route did not exist.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  if (awsConnectorPrincipal() === null) return notFound()

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  const parsed = awsConnectorCreateInputSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const subscription = await createAwsConnector({
      userId: user.id,
      workspaceId: parsed.data.workspaceId,
      projectId: parsed.data.projectId,
      displayName: parsed.data.displayName,
      accountId: parsed.data.accountId,
    })
    return json(201, { subscription } satisfies CreateResponseBody)
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    if (thrown instanceof SubscriptionAlreadyConnectedError) {
      return conflict("That AWS account is already connected in this workspace.", "ALREADY_CONNECTED")
    }
    console.error(
      `[api/subscriptions/aws] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )
    return internalError()
  }
}
