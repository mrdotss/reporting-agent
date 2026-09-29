import { z } from "zod"

import { internalError, invalidInput, json, malformedBody, notFound, readJsonBody, unauthorized, unprocessable } from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { DeliveryInputError, addContact } from "@/lib/delivery/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

/** `POST /api/customers/contacts` — add who receives a customer's reports. Edit roles. */

export const runtime = "nodejs"

const id = z.string().trim().min(1).max(200)
const bodySchema = z
  .object({ workspaceId: id, projectId: id, name: z.string().max(200), email: z.string().max(320) })
  .strict()

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)
  const { workspaceId, projectId, name, email } = parsed.data
  try {
    return json(201, { contact: await addContact(user.id, { workspaceId, projectId }, { name, email }) })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    if (thrown instanceof DeliveryInputError) return unprocessable(thrown.message, "CONTACT_INVALID")
    console.error(`[api/customers/contacts] POST failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`)
    return internalError()
  }
}
