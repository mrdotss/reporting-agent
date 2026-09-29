import { internalError, json, notFound, unauthorized } from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { removeContact } from "@/lib/delivery/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

/** `DELETE /api/customers/contacts/:id` — stop sending a customer's reports to this contact. */

export const runtime = "nodejs"

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  try {
    await removeContact(user.id, (await params).id)
    return json(200, { ok: true })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    console.error(`[api/customers/contacts] DELETE failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`)
    return internalError()
  }
}
