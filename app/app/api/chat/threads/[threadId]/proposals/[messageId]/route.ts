import { EnqueueRejectedError, enqueueRun } from "@/lib/actions/runs"
import {
  badRequest,
  conflict,
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
import { requireAskLevel } from "@/lib/chat/access"
import { proposalActionSchema } from "@/lib/chat/input"
import { listProposalPresets } from "@/lib/chat/sources"
import {
  ChatProposalClosedError,
  ChatThreadNotFoundError,
  closeProposal,
  readMessage,
  readThread,
} from "@/lib/chat/store"
import { runCreateInputSchema } from "@/lib/runs/input"
import { requireWorkspace, WorkspaceAccessError } from "@/lib/workspaces/access"

/**
 * A report the assistant proposed (ask-chat Req 6).
 *
 * `GET` — the presets it may be requested with: runnable, and written for the proposal's
 * connector source.
 *
 * `POST {action: "request", templateId}` — enqueue it through `enqueueRun`, the same path
 * `POST /api/runs` takes, so the edit permission, the connector's state and the
 * preset/connector source pairing are all checked exactly as the form checks them. The
 * preset's period rule decides the window; the month the assistant named is not an input.
 *
 * `POST {action: "dismiss"}` — close it without a run.
 *
 * Closing is conditional in DynamoDB, so two teammates confirming at once get one run and
 * one `409` between them (the enqueue's own dedupe covers the window between the two).
 */
export const runtime = "nodejs"

type ProposalRouteContext = Readonly<{
  params: Promise<{ threadId: string; messageId: string }>
}>

async function readProposal(userId: string, threadId: string, messageId: string) {
  const thread = await readThread(userId, threadId)
  const message = await readMessage(thread, messageId)
  if (message?.proposal === undefined) throw new ChatThreadNotFoundError()
  return { thread, message, proposal: message.proposal }
}

export async function GET(_request: Request, context: ProposalRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const { threadId, messageId } = await context.params

  try {
    const { proposal } = await readProposal(user.id, threadId, messageId)
    const presets = await listProposalPresets(
      user.id,
      { workspaceId: proposal.workspaceId, projectId: proposal.projectId },
      proposal.provider
    )
    return json(200, { proposal, presets })
  } catch (thrown) {
    if (thrown instanceof ChatThreadNotFoundError || thrown instanceof WorkspaceAccessError) {
      return notFound()
    }
    console.error(`[api/chat/proposals] GET failed: ${describe(thrown)}`)
    return internalError()
  }
}

export async function POST(request: Request, context: ProposalRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const { threadId, messageId } = await context.params

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = proposalActionSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const { thread, proposal } = await readProposal(user.id, threadId, messageId)
    // Acting on a proposal is part of asking: a member who can only read Ask here cannot
    // (roles-and-ask-access Req 6), whatever their workspace role.
    await requireAskLevel(user.id, thread.workspaceId, "chat")
    if (proposal.state !== "open") {
      return conflict(new ChatProposalClosedError().message, "PROPOSAL_CLOSED")
    }

    if (parsed.data.action === "dismiss") {
      await requireWorkspace(user.id, thread.workspaceId, "edit")
      await closeProposal(thread, messageId, "dismissed")
      return json(200, { proposal: { ...proposal, state: "dismissed" } })
    }

    const input = runCreateInputSchema.safeParse({
      workspaceId: proposal.workspaceId,
      projectId: proposal.projectId,
      connectedSubscriptionId: proposal.connectedSubscriptionId,
      templateId: parsed.data.templateId,
      customerName: proposal.customerName,
      ...(parsed.data.revisionHistoryRow
        ? { revisionHistoryRow: parsed.data.revisionHistoryRow }
        : {}),
    })
    if (!input.success) return invalidInput(input.error)

    const { run } = await enqueueRun(user.id, input.data)
    await closeProposal(thread, messageId, "requested", run.id)
    return json(201, { proposal: { ...proposal, state: "requested", runId: run.id } })
  } catch (thrown) {
    if (thrown instanceof ChatThreadNotFoundError || thrown instanceof WorkspaceAccessError) {
      return notFound()
    }
    if (thrown instanceof ChatProposalClosedError) {
      return conflict(thrown.message, "PROPOSAL_CLOSED")
    }
    if (thrown instanceof EnqueueRejectedError) {
      const { rejection } = thrown
      switch (rejection.kind) {
        case "resolved_period":
          return badRequest(thrown.message, rejection.code.toUpperCase())
        case "template_not_found":
        case "subscription_not_found":
          return notFound()
        case "template_unversioned":
          return unprocessable(thrown.message, "TEMPLATE_UNVERSIONED")
        case "subscription_inactive":
          return unprocessable(thrown.message, rejection.code)
        case "provider_mismatch":
          return unprocessable(thrown.message, "PROVIDER_MISMATCH")
        case "regions_unavailable":
          return unprocessable(thrown.message, "REGIONS_UNAVAILABLE")
        case "front_matter_values_missing":
          return unprocessable(thrown.message, "FRONT_MATTER_VALUES_MISSING")
      }
      const unhandled: never = rejection
      void unhandled
    }
    console.error(`[api/chat/proposals] POST failed: ${describe(thrown)}`)
    return internalError()
  }
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown
}
