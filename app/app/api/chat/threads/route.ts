import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  unauthorized,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { createThreadSchema } from "@/lib/chat/input"
import { listChatSources } from "@/lib/chat/sources"
import { createThread, listThreads } from "@/lib/chat/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import { selectedContext } from "@/lib/workspaces/context"

/**
 * `GET /api/chat/threads` and `POST /api/chat/threads` (ask-chat Req 7).
 *
 * Conversations belong to the **selected workspace** and every member sees them. A new
 * conversation's attachments are narrowed to what the workspace can attach right now —
 * an id for a report that is not verified, or a connector that is not the workspace's,
 * is dropped rather than stored.
 */
export const runtime = "nodejs"

export async function GET(): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  try {
    const { workspace } = await selectedContext(user.id)
    const threads = await listThreads(user.id, workspace.id)
    return json(200, { threads })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    console.error(`[api/chat/threads] GET failed: ${describe(thrown)}`)
    return internalError()
  }
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = createThreadSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const { workspace } = await selectedContext(user.id)
    const sources = await listChatSources(user.id, workspace.id)
    const runIds = new Set(sources.runs.map((run) => run.runId))
    const connectorIds = new Set(sources.connectors.map((connector) => connector.id))

    const thread = await createThread(user.id, workspace.id, {
      runIds: parsed.data.attachments.runIds.filter((id) => runIds.has(id)),
      connectorIds: parsed.data.attachments.connectorIds.filter((id) => connectorIds.has(id)),
    })
    return json(201, { thread })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    console.error(`[api/chat/threads] POST failed: ${describe(thrown)}`)
    return internalError()
  }
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown
}
