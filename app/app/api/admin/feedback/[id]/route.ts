import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  unauthorized,
} from "@/lib/api/response"
import { isPlatformAdmin } from "@/lib/admin/platform"
import { requireSessionForApi } from "@/lib/auth/guard"
import { feedbackStatusSchema } from "@/lib/feedback/input"
import { setFeedbackDone } from "@/lib/feedback/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import { permitsWorkspaceOrigin } from "@/lib/workspaces/input"

/**
 * `PATCH /api/admin/feedback/:id` — mark one feedback message done, or open it again.
 * A 404 for anyone who is not a platform admin, so the route does not confirm it exists.
 */
export const runtime = "nodejs"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
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

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = feedbackStatusSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    return json(200, { feedback: await setFeedbackDone(user, (await params).id, parsed.data.done) })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    console.error(`[api/admin/feedback] PATCH failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`)
    return internalError()
  }
}
