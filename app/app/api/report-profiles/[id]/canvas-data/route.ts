import { z } from "zod"

import {
  invalidInput,
  json,
  notFound,
  searchParamsObject,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { getConnectedSubscription, SubscriptionNotFoundError } from "@/lib/subscriptions/store"
import { CanvasDataUnreadableError, loadCanvasData } from "@/lib/templates/canvas-data"
import { previewRequestSchema, templateIdParamSchema } from "@/lib/templates/input"
import { mostRecentSnapshotRun } from "@/lib/templates/preview"
import { getTemplate, TemplateNotFoundError } from "@/lib/templates/store"

/**
 * `GET /api/report-profiles/[id]/canvas-data?connection=<id>` — the builder's Real figures:
 * the canvas's resources from that connection's latest completed report.
 *
 * The same checks as Try it: the preset and the connection are the caller's, in one
 * project, of one provider, and the connection is active. Reads the snapshot and writes
 * nothing; the canvas marks what it draws from here as not a deliverable.
 */
export const runtime = "nodejs"

type TemplateRouteContext = Readonly<{ params: Promise<{ id: string }> }>

const querySchema = z.object({ connection: previewRequestSchema.shape.connectedSubscriptionId })

export async function GET(request: Request, context: TemplateRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const params = templateIdParamSchema.safeParse(await context.params)
  if (!params.success) return invalidInput(params.error)
  const query = querySchema.safeParse(searchParamsObject(request.url))
  if (!query.success) return invalidInput(query.error)

  let source: Awaited<ReturnType<typeof getConnectedSubscription>>
  let provider: "aws" | "azure"
  try {
    const profile = await getTemplate(user.id, params.data.id)
    source = await getConnectedSubscription(user.id, query.data.connection)
    if (profile.workspaceId !== source.workspaceId || profile.projectId !== source.projectId) {
      return notFound()
    }
    provider = profile.provider === "aws" ? "aws" : "azure"
  } catch (thrown) {
    if (thrown instanceof TemplateNotFoundError || thrown instanceof SubscriptionNotFoundError) {
      return notFound()
    }
    throw thrown
  }
  if (source.provider !== provider) {
    return unprocessable(
      `This preset reports on ${provider === "aws" ? "AWS" : "Azure"}. Choose a connection of the same provider.`,
      "PROVIDER_MISMATCH"
    )
  }
  if (source.status !== "active") {
    return unprocessable("That connection is not active.", "CONNECTION_INACTIVE")
  }

  const run = await mostRecentSnapshotRun(user.id, query.data.connection)
  if (run === null) {
    return unprocessable(
      "That connection has no completed report yet. Run any preset against it, and the page can draw that report's figures.",
      "NO_SNAPSHOT"
    )
  }

  try {
    return json(200, await loadCanvasData(run, { name: source.displayName, provider }))
  } catch (thrown) {
    if (thrown instanceof CanvasDataUnreadableError) return unprocessable(thrown.message, "SNAPSHOT_UNREADABLE")
    throw thrown
  }
}
