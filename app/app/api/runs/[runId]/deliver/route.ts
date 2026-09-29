import { internalError, json, notFound, unauthorized, unprocessable } from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { DeliveryInputError, approveAndSend } from "@/lib/delivery/store"
import { MailNotConfiguredError } from "@/lib/mail/mailtrap"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

/**
 * `POST /api/runs/:runId/deliver` — approve this verified report and email it to the
 * customer's contacts. Owner or Admin. A refusal from Mailtrap is recorded per recipient
 * on the delivery rather than failing the request.
 */

export const runtime = "nodejs"

export async function POST(_request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  try {
    return json(201, { delivery: await approveAndSend(user.id, (await params).runId) })
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) return notFound()
    if (thrown instanceof DeliveryInputError) return unprocessable(thrown.message, "DELIVERY_REFUSED")
    if (thrown instanceof MailNotConfiguredError) return unprocessable(thrown.message, "MAIL_NOT_CONFIGURED")
    console.error(`[api/runs/deliver] POST failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`)
    return internalError()
  }
}
