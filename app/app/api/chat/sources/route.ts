import { internalError, json, notFound, unauthorized } from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { requireAskLevel } from "@/lib/chat/access"
import { listChatSources } from "@/lib/chat/sources"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import { selectedContext } from "@/lib/workspaces/context"

/**
 * `GET /api/chat/sources` — what the selected workspace can attach to a conversation: its
 * verified reports and its connectors with their latest complete scan (ask-chat Req 2).
 *
 * Every field is already browser-safe: run ids, customer and preset names, counts, a
 * digest prefix, and a scan's counts. No subscription id, tenant or credential.
 */
export const runtime = "nodejs"

export async function GET(): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  try {
    const { workspace } = await selectedContext(user.id)
    await requireAskLevel(user.id, workspace.id, "read")
    return json(200, await listChatSources(user.id, workspace.id))
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    console.error(
      `[api/chat/sources] GET failed: ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )
    return internalError()
  }
}
