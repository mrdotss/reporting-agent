import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  unauthorized,
} from "@/lib/api/response"
import { askAccessInputSchema } from "@/lib/admin/input"
import { isPlatformAdmin, setAskAccess } from "@/lib/admin/platform"
import { requireSessionForApi } from "@/lib/auth/guard"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import { permitsWorkspaceOrigin } from "@/lib/workspaces/input"

/**
 * `POST /api/admin/ask-access` — grant or remove Ask for one account
 * (roles-and-ask-access Req 7).
 *
 * A 404 for anyone who is not a platform admin, so the route does not confirm it exists,
 * and for a cross-site request, with the same origin rule as `POST /api/workspaces`. The
 * admin check is repeated inside `setAskAccess`, which also refuses a target that is itself
 * a platform admin.
 */
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
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
  const parsed = askAccessInputSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const grantedAt = await setAskAccess({
      admin: user,
      userId: parsed.data.userId,
      enabled: parsed.data.enabled,
    })
    return json(200, { userId: parsed.data.userId, grantedAt })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    console.error(
      `[api/admin/ask-access] POST failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`
    )
    return internalError()
  }
}
