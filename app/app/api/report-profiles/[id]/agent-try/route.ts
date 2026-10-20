import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  serviceUnavailable,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { parseSseFrame, splitSseFrames } from "@/lib/aws/agent-stream"
import { COMMAND_TRY_AGENT, invokeAgentRuntime } from "@/lib/aws/agentcore"
import { newSessionId } from "@/lib/session-id"
import { getConnectedSubscription, SubscriptionNotFoundError } from "@/lib/subscriptions/store"
import { currentDisplayFormat } from "@/lib/templates/current-format"
import { AGENT_TRY_BUDGET_MS, agentTryRequestSchema, templateIdParamSchema } from "@/lib/templates/input"
import { mostRecentSnapshotRun, newPreviewId } from "@/lib/templates/preview"
import { getTemplate, TemplateNotFoundError } from "@/lib/templates/store"

/**
 * `POST /api/report-profiles/[id]/agent-try` — the builder's Try it on an agent paragraph.
 *
 * The draft on the page, inline, compiled by the runtime's `try_agent` against the latest
 * completed report of a connection the consultant picks, with the model asked for that one
 * paragraph. The answer is the paragraph's words, whether they were kept and, when they were
 * not, why. Nothing is written: a delivered report writes its own paragraphs, fresh.
 *
 * The same guards as Preview PDF: the preset and the connection must be the caller's, in the
 * same project, of the same provider, and the connection must have a completed report.
 */
export const runtime = "nodejs"

type AgentTryBody = {
  readonly outcome: "written" | "note" | "omitted"
  readonly reason: string
  readonly text: string
  readonly figures: number
}

type TemplateRouteContext = Readonly<{ params: Promise<{ id: string }> }>

/**
 * Read the runtime's stream to its `done`: the `agent` it carries, or the failure code.
 */
async function drainForAgent(
  stream: AsyncIterable<Uint8Array>
): Promise<{ ok: true; agent: AgentTryBody } | { ok: false; code: string | undefined }> {
  const decoder = new TextDecoder()
  let buffered = ""
  let code: string | undefined
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true })
    const { frames, rest } = splitSseFrames(buffered)
    buffered = rest
    for (const frame of frames) {
      const event = parseSseFrame(frame)
      if (event === null || typeof event !== "object") continue
      const record = event as Record<string, unknown>
      if (record.type === "error" && typeof record.code === "string") code = record.code
      if (record.type !== "done") continue
      const agent = record.agent as Record<string, unknown> | undefined
      if (agent && (agent.outcome === "written" || agent.outcome === "note" || agent.outcome === "omitted")) {
        return {
          ok: true,
          agent: {
            outcome: agent.outcome,
            reason: typeof agent.reason === "string" ? agent.reason : "",
            text: typeof agent.text === "string" ? agent.text : "",
            figures: typeof agent.figures === "number" ? agent.figures : 0,
          },
        }
      }
      return { ok: false, code }
    }
  }
  return { ok: false, code }
}

export async function POST(request: Request, context: TemplateRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const params = templateIdParamSchema.safeParse(await context.params)
  if (!params.success) return invalidInput(params.error)

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = agentTryRequestSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const profile = await getTemplate(user.id, params.data.id)
    const source = await getConnectedSubscription(user.id, parsed.data.connectedSubscriptionId)
    if (profile.workspaceId !== source.workspaceId || profile.projectId !== source.projectId) {
      return notFound()
    }
    const provider = profile.provider === "aws" ? "aws" : "azure"
    if (source.provider !== provider) {
      return unprocessable(
        `This preset reports on ${provider === "aws" ? "AWS" : "Azure"}, and that connection is ` +
          `${source.provider === "aws" ? "AWS" : "Azure"}. Choose a connection of the same provider.`,
        "PROVIDER_MISMATCH"
      )
    }
    if (source.status !== "active") {
      return unprocessable("That connection is not active, so the agent cannot be tried against it.", "CONNECTION_INACTIVE")
    }
  } catch (thrown) {
    if (thrown instanceof TemplateNotFoundError || thrown instanceof SubscriptionNotFoundError) {
      return notFound()
    }
    throw thrown
  }

  const snapshotRun = await mostRecentSnapshotRun(user.id, parsed.data.connectedSubscriptionId)
  if (snapshotRun === null) {
    return unprocessable(
      "A completed report is needed before the agent can be tried. Run any preset against that " +
        "connection first, and Try it will use that report's figures.",
      "NO_SNAPSHOT"
    )
  }

  try {
    const stream = await invokeAgentRuntime({
      sessionId: newSessionId(),
      context: { actor_id: snapshotRun.actorId, run_id: newPreviewId() },
      command: {
        command: COMMAND_TRY_AGENT,
        snapshot_run_id: snapshotRun.runId,
        block_id: parsed.data.blockId,
        definition: currentDisplayFormat(parsed.data.definition),
      },
    })
    const outcome = await Promise.race([
      drainForAgent(stream),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), AGENT_TRY_BUDGET_MS)),
    ])
    if (outcome === "timeout") {
      return serviceUnavailable(
        `The agent did not answer within ${AGENT_TRY_BUDGET_MS / 1000} seconds. The draft is unchanged; try again.`,
        "AGENT_TRY_TIMEOUT"
      )
    }
    if (!outcome.ok) {
      return unprocessable(
        "The paragraph could not be tried: the draft did not compile against that connection's " +
          "latest report. Fix what the builder lists under “to fix”, then try again.",
        "AGENT_TRY_FAILED"
      )
    }
    return json(200, {
      ...outcome.agent,
      periodStart: snapshotRun.periodStart,
      periodEnd: snapshotRun.periodEnd,
    })
  } catch (thrown) {
    console.error(
      `[api/report-profiles/[id]/agent-try] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )
    return internalError()
  }
}
