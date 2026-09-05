import { NextResponse } from "next/server"

import { findReusableSnapshot } from "@/lib/actions/runs"
import { badRequest, unauthorized } from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"

/**
 * `GET /api/runs/reusable` — is there a snapshot this submission could reuse?
 *
 * The run form asks as soon as a subscription and a profile are both chosen, and shows
 * the answer as a choice rather than acting on it. Reuse is the consultant's decision:
 * re-running one period asks Azure the same question again, and Azure is entitled to a
 * different answer — late-arriving samples, a resized machine, a resource deleted since —
 * so a re-run to fix a cover page would otherwise return a document whose figures moved
 * for reasons unrelated to the fix.
 *
 * ## Why the period is not a parameter
 *
 * It is resolved server-side from the pinned definition at this instant, exactly as
 * `enqueueRun` resolves it. A browser that supplied a period could offer a candidate for
 * one window and then submit a run for another, and the runtime would refuse the
 * mismatched snapshot — a failed run as the way to learn the offer was wrong.
 *
 * ## What it answers with
 *
 * The run's id, when it collected, and how much it found. Not the snapshot itself and no
 * artifact key: this endpoint decides nothing about access, and a caller wanting the
 * document goes through the download gate like every other reader.
 */
/**
 * Node, not Edge — Requirements 6.7, 6.10, 6.11. Every route in this app declares it,
 * streaming or not: this one reads Postgres through `pg`, which the Edge runtime has no
 * socket for, and a route that inherits the default is a route nobody chose a runtime
 * for.
 */
export const runtime = "nodejs"

export async function GET(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const url = new URL(request.url)
  const connectedSubscriptionId = url.searchParams.get("connectedSubscriptionId")
  const templateId = url.searchParams.get("templateId")
  const timezone = url.searchParams.get("timezone")

  if (!connectedSubscriptionId || !templateId || !timezone) {
    // All three or nothing: a partial query cannot resolve a period, and answering
    // "no candidate" for it would read as "this period was never collected".
    return badRequest(
      "connectedSubscriptionId, templateId and timezone are all required",
      "INCOMPLETE_QUERY"
    )
  }

  const found = await findReusableSnapshot(user.id, {
    connectedSubscriptionId,
    templateId,
    timezone,
  })

  if (found === null) {
    return NextResponse.json({ candidate: null })
  }

  return NextResponse.json({
    candidate: {
      runId: found.id,
      collectedAt: found.updatedAt.toISOString(),
      periodStart: found.periodStart,
      periodEnd: found.periodEnd,
      resourceCount: found.resourceCount,
      gapCount: found.gapCount,
    },
  })
}
