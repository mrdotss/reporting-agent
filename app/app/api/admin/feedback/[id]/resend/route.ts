import { internalError, json, notFound, unauthorized } from "@/lib/api/response"
import { isPlatformAdmin } from "@/lib/admin/platform"
import { requireSessionForApi } from "@/lib/auth/guard"
import { resendFeedback } from "@/lib/feedback/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import { permitsWorkspaceOrigin } from "@/lib/workspaces/input"

/**
 * `POST /api/admin/feedback/:id/resend` — email a saved feedback message again, for one
 * whose first send failed. A refusal is recorded on the row, not returned as an error.
 */
export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  if (!isPlatformAdmin(user.email)) return notFound()
  if (
    !permitsWorkspaceOrigin(
      request.headers.get("origin"),
      request.headers.get("host"),
      request.headers.get("sec-fetch-site")
    )
  ) {
    return notFound()
  }

  try {
    return json(200, { feedback: await resendFeedback(user, (await params).id) })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    console.error(`[api/admin/feedback/resend] POST failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`)
    return internalError()
  }
}
