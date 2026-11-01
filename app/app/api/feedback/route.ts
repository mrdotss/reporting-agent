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
import { feedbackInputSchema } from "@/lib/feedback/input"
import { FeedbackLimitError, submitFeedback } from "@/lib/feedback/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import { selectedContext } from "@/lib/workspaces/context"
import { permitsWorkspaceOrigin } from "@/lib/workspaces/input"

/**
 * `POST /api/feedback` — save one Send feedback message and email it to the team.
 *
 * Any signed-in member may send. The workspace recorded with it is the one they have open,
 * read from their session. A 201 even when the email was refused: the message is saved,
 * and the Admin page can send it again.
 */
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
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
  const parsed = feedbackInputSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const workspace = await selectedContext(user.id).then(
      ({ workspace }) => ({ id: workspace.id, name: workspace.name, role: workspace.role }),
      (thrown: unknown) => {
        if (thrown instanceof WorkspaceAccessError) return null
        throw thrown
      }
    )
    const saved = await submitFeedback(user, workspace, parsed.data)
    return json(201, { feedback: { id: saved.id, emailStatus: saved.emailStatus } })
  } catch (thrown) {
    if (thrown instanceof FeedbackLimitError) {
      return json(429, { error: { message: thrown.message, code: "FEEDBACK_LIMIT" } })
    }
    console.error(`[api/feedback] POST failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`)
    return internalError()
  }
}
