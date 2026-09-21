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
import { requireAskLevel } from "@/lib/chat/access"
import { updateThreadSchema } from "@/lib/chat/input"
import { listChatSources } from "@/lib/chat/sources"
import {
  ChatThreadNotFoundError,
  ChatThreadNotYoursError,
  deleteThread,
  listMessages,
  readThread,
  updateThread,
} from "@/lib/chat/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

/**
 * `GET /api/chat/threads/[threadId]` — a conversation and its messages.
 * `PATCH /api/chat/threads/[threadId]` — rename it, or change what it is grounded in.
 * `DELETE /api/chat/threads/[threadId]` — delete it and its messages, author only.
 *
 * A thread outside the user's workspaces is a 404, the same as one that does not exist.
 * Reading needs the read level and changing needs chat (roles-and-ask-access Req 6), and a
 * refusal is the same 404.
 */
export const runtime = "nodejs"

type ThreadRouteContext = Readonly<{ params: Promise<{ threadId: string }> }>

export async function GET(_request: Request, context: ThreadRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const { threadId } = await context.params

  try {
    const thread = await readThread(user.id, threadId)
    const messages = await listMessages(thread)
    return json(200, { thread, messages })
  } catch (thrown) {
    if (thrown instanceof ChatThreadNotFoundError) return notFound()
    console.error(`[api/chat/threads/:id] GET failed: ${describe(thrown)}`)
    return internalError()
  }
}

export async function PATCH(request: Request, context: ThreadRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const { threadId } = await context.params

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = updateThreadSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const thread = await readThread(user.id, threadId)
    await requireAskLevel(user.id, thread.workspaceId, "chat")
    let attachments = parsed.data.attachments
    if (attachments !== undefined) {
      const sources = await listChatSources(user.id, thread.workspaceId)
      const runIds = new Set(sources.runs.map((run) => run.runId))
      const connectorIds = new Set(sources.connectors.map((connector) => connector.id))
      const liveIds = new Set(sources.live.map((pull) => pull.id))
      attachments = {
        runIds: attachments.runIds.filter((id) => runIds.has(id)),
        connectorIds: attachments.connectorIds.filter((id) => connectorIds.has(id)),
        liveIds: attachments.liveIds.filter((id) => liveIds.has(id)),
      }
    }

    const updated = await updateThread(thread, { title: parsed.data.title, attachments })
    return json(200, { thread: updated })
  } catch (thrown) {
    if (thrown instanceof ChatThreadNotFoundError || thrown instanceof WorkspaceAccessError) {
      return notFound()
    }
    console.error(`[api/chat/threads/:id] PATCH failed: ${describe(thrown)}`)
    return internalError()
  }
}

export async function DELETE(
  _request: Request,
  context: ThreadRouteContext
): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const { threadId } = await context.params

  try {
    await deleteThread(user.id, threadId)
    return json(200, { deleted: threadId })
  } catch (thrown) {
    if (thrown instanceof ChatThreadNotFoundError || thrown instanceof WorkspaceAccessError) {
      return notFound()
    }
    if (thrown instanceof ChatThreadNotYoursError) {
      return json(403, {
        error: {
          message: "Only the person who started a conversation can delete it.",
          code: "NOT_THREAD_AUTHOR",
        },
      })
    }
    console.error(`[api/chat/threads/:id] DELETE failed: ${describe(thrown)}`)
    return internalError()
  }
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown
}
