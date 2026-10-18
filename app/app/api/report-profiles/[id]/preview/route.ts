import { after } from "next/server"

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
import { COMMAND_RENDER_PREVIEW, invokeAgentRuntime } from "@/lib/aws/agentcore"
import { deleteObject, presignPreview, previewHtmlKey, previewKey } from "@/lib/aws/s3"
import { newSessionId } from "@/lib/session-id"
import { getConnectedSubscription, SubscriptionNotFoundError } from "@/lib/subscriptions/store"
import { currentDisplayFormat } from "@/lib/templates/current-format"
import {
  PREVIEW_BUDGET_MS,
  previewRequestSchema,
  templateIdParamSchema,
} from "@/lib/templates/input"
import { mostRecentSnapshotRun, newPreviewId } from "@/lib/templates/preview"
import { getTemplate, TemplateNotFoundError } from "@/lib/templates/store"

/**
 * `POST /api/report-profiles/[id]/preview` — the builder's Preview PDF.
 *
 * The draft on the page, inline, rendered by the runtime's `render_preview` against the
 * latest completed report of a connection the consultant picks: real figures from a real
 * snapshot, laid out as the draft lays them out, with a notice on every page that it is
 * not a verified deliverable. The `.pdf` lands under `previews/`, which the report
 * download path cannot serve (`lib/aws/s3.ts`), and the answer is a short-lived URL the
 * builder opens in a new tab.
 *
 * ## The connection must be the preset's provider
 *
 * A preset belongs to one provider and its sections select that provider's resources.
 * An AWS draft against an Azure snapshot compiles to empty sections, which would be a
 * preview of nothing — so a mismatch is refused here, by name, rather than rendered.
 *
 * ## No front matter
 *
 * A preview has no run, so it has no customer name, period or revision row to put on a
 * cover — and a cover with invented copy is refused (Requirement 13.15). The runtime
 * renders the content only; the canvas shows the cover.
 */
export const runtime = "nodejs"

type PreviewStage = "compilation" | "docx" | "pdf"

type PreviewResponseBody = {
  readonly previewId: string
  readonly url: string
  readonly expiresIn: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly timezone: string
}

function stageFor(code: string | undefined): PreviewStage {
  if (code === "PDF_CONVERSION_FAILED") return "pdf"
  if (code === "RENDER_FAILED") return "docx"
  return "compilation"
}

const STAGE_MESSAGE: Readonly<Record<PreviewStage, string>> = {
  compilation:
    "The preview was not produced: the draft could not be compiled against that " +
    "connection's latest report. Fix what the builder lists under “to fix”, then try again.",
  docx:
    "The preview was not produced: the draft compiled, but the Word document could not " +
    "be rendered in the chosen theme.",
  pdf:
    "The preview was not produced: the Word document was rendered, but it could not be " +
    "converted to PDF.",
}

type TemplateRouteContext = Readonly<{ params: Promise<{ id: string }> }>

/**
 * Read the runtime's stream to its end and report whether it failed.
 *
 * The runtime streams step events and, on failure, one error event carrying a `code`.
 * Only that code matters here — the `.pdf` itself is read from S3, not from the stream.
 */
async function drainForOutcome(
  stream: AsyncIterable<Uint8Array>
): Promise<{ ok: true } | { ok: false; code: string | undefined }> {
  const decoder = new TextDecoder()
  let buffered = ""
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true })
  }
  const match = /"code"\s*:\s*"([A-Z_]+)"/.exec(buffered)
  return match === null ? { ok: true } : { ok: false, code: match[1] }
}

export async function POST(request: Request, context: TemplateRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const params = templateIdParamSchema.safeParse(await context.params)
  if (!params.success) return invalidInput(params.error)

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = previewRequestSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const profile = await getTemplate(user.id, params.data.id)
    const source = await getConnectedSubscription(user.id, parsed.data.connectedSubscriptionId)
    // Another workspace's connection is not found, the way an id that exists for no row is.
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
      return unprocessable(
        "That connection is not active, so it cannot be previewed against.",
        "CONNECTION_INACTIVE"
      )
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
      "A completed report is needed before a preview can be rendered. Run any preset " +
        "against that connection first, and the preview will use that report's snapshot.",
      "NO_SNAPSHOT"
    )
  }

  const previewId = newPreviewId()
  const pdfKey = previewKey(snapshotRun.actorId, previewId)

  try {
    const stream = await invokeAgentRuntime({
      sessionId: newSessionId(),
      context: { actor_id: snapshotRun.actorId, run_id: previewId },
      command: {
        command: COMMAND_RENDER_PREVIEW,
        preview_id: previewId,
        snapshot_run_id: snapshotRun.runId,
        definition: currentDisplayFormat(parsed.data.definition),
      },
    })

    const outcome = await Promise.race([
      drainForOutcome(stream),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), PREVIEW_BUDGET_MS)),
    ])
    if (outcome === "timeout") {
      return serviceUnavailable(
        `The preview did not finish within ${PREVIEW_BUDGET_MS / 1000} seconds. ` +
          `The draft is unchanged; try again.`,
        "PREVIEW_TIMEOUT"
      )
    }
    if (!outcome.ok) {
      const stage = stageFor(outcome.code)
      return unprocessable(STAGE_MESSAGE[stage], `PREVIEW_${stage.toUpperCase()}`)
    }

    const presigned = await presignPreview(snapshotRun.actorId, pdfKey)

    // The preview this one replaces, after the response: the caller names it, and only an
    // object minted for this user under this prefix is deleted.
    const superseded = parsed.data.supersedes
    if (superseded !== undefined && superseded !== previewId) {
      after(async () => {
        await Promise.allSettled([
          deleteObject(previewKey(snapshotRun.actorId, superseded)),
          deleteObject(previewHtmlKey(snapshotRun.actorId, superseded)),
        ])
      })
    }

    return json(200, {
      previewId,
      url: presigned.url,
      expiresIn: presigned.expiresIn,
      periodStart: snapshotRun.periodStart,
      periodEnd: snapshotRun.periodEnd,
      timezone: snapshotRun.timezone,
    } satisfies PreviewResponseBody)
  } catch (thrown) {
    console.error(
      `[api/report-profiles/[id]/preview] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )
    return internalError()
  }
}
