import { z } from "zod"

import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import {
  ActionItemInputError,
  EDITABLE_STATUSES,
  MAX_NOTE,
  OWNERS,
  updateActionItem,
} from "@/lib/action-register/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

/** `PATCH /api/actions/:id` — owner, status and note of one Action register item. */

export const runtime = "nodejs"

const bodySchema = z
  .object({
    owner: z.enum(OWNERS).nullable(),
    status: z.enum(EDITABLE_STATUSES),
    note: z.string().max(MAX_NOTE).nullable(),
  })
  .strict()

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    return json(200, { item: await updateActionItem(user.id, (await params).id, parsed.data) })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    if (thrown instanceof ActionItemInputError) return unprocessable(thrown.message, "ACTION_ITEM_INVALID")
    console.error(`[api/actions] PATCH failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`)
    return internalError()
  }
}
