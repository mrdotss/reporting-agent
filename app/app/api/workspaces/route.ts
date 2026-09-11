import { requireSessionForApi } from "@/lib/auth/guard"
import {
  json,
  unauthorized,
  notFound,
  invalidInput,
  readJsonBody,
  badRequest,
  internalError,
} from "@/lib/api/response"
import { workspaceActionSchema, permitsWorkspaceOrigin } from "@/lib/workspaces/input"
import { workspaceUiEnabled, selectContext } from "@/lib/workspaces/context"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import * as store from "@/lib/workspaces/store"
export async function POST(request: Request) {
  const user = await requireSessionForApi()
  if (!user) return unauthorized()
  if (!workspaceUiEnabled()) return notFound()
  if (!permitsWorkspaceOrigin(request.headers.get("origin"), request.headers.get("host"), request.headers.get("sec-fetch-site"))) return notFound()
  const parsed = workspaceActionSchema.safeParse(await readJsonBody(request))
  if (!parsed.success) return invalidInput(parsed.error)
  const d = parsed.data
  try {
    switch (d.action) {
      case "create_workspace": {
        const scope = await store.createWorkspace(user.id, d.name)
        await selectContext(user.id, scope.workspaceId, scope.projectId)
        return json(201, scope)
      }
      case "select":
        await selectContext(user.id, d.workspaceId, d.projectId)
        return json(200, { ok: true })
      case "project":
        if (!d.id && !d.name) return badRequest("Give the project a name.")
        return json(200, {
          id: await store.changeProject(user.id, d.workspaceId, d),
        })
      case "invite":
        return json(201, {
          token: await store.createInvitation(user.id, d.workspaceId, d.role),
        })
      case "accept": {
        const workspaceId = await store.acceptInvitation(user.id, d.token)
        await selectContext(user.id, workspaceId)
        return json(200, { workspaceId })
      }
      case "revoke":
        await store.revokeInvitation(user.id, d.workspaceId, d.id)
        break
      case "member":
        await store.changeMember(user.id, d.workspaceId, d.userId, d.role)
        break
      case "transfer":
        await store.transferOwnership(user.id, d.workspaceId, d.userId)
        break
    }
    return json(200, { ok: true })
  } catch (e) {
    if (e instanceof WorkspaceAccessError) return notFound()
    console.error(
      "[workspaces] operation failed",
      e instanceof Error ? e.name : "unknown"
    )
    return internalError()
  }
}

export const runtime = "nodejs"
