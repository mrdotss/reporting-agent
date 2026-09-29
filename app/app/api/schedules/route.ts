import { z } from "zod"

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
import { isAwsRegion, MAX_RUN_REGIONS } from "@/lib/runs/regions"
import { MAX_SCHEDULE_DAY, MIN_SCHEDULE_DAY } from "@/lib/schedules/due"
import { deleteSchedule, saveSchedule } from "@/lib/schedules/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

/**
 * `PUT /api/schedules` saves a customer's monthly schedule; `DELETE` stops it.
 *
 * Both need edit on the customer. A connector or preset that is not the customer's, and a
 * customer the member cannot edit, all answer 404 — the same answer, so the route does not
 * say which ids exist.
 */

export const runtime = "nodejs"

const id = z.string().trim().min(1).max(200)
const scopeSchema = z.object({ workspaceId: id, projectId: id }).strict()

const saveSchema = z
  .object({
    workspaceId: id,
    projectId: id,
    connectedSubscriptionId: id,
    templateId: id,
    regions: z.array(z.string().trim().refine(isAwsRegion, { error: "Not an AWS region code." })).max(MAX_RUN_REGIONS).optional(),
    dayOfMonth: z.number().int().min(MIN_SCHEDULE_DAY).max(MAX_SCHEDULE_DAY),
    hour: z.number().int().min(0).max(23),
  })
  .strict()

function failed(thrown: unknown, verb: string): Response {
  if (thrown instanceof WorkspaceAccessError) return notFound()
  console.error(
    `[api/schedules] ${verb} failed: ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
  )
  return internalError()
}

export async function PUT(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = saveSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    return json(200, { schedule: await saveSchedule(user.id, parsed.data) })
  } catch (thrown) {
    return failed(thrown, "PUT")
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = scopeSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    await deleteSchedule(user.id, parsed.data)
    return json(200, { schedule: null })
  } catch (thrown) {
    return failed(thrown, "DELETE")
  }
}
