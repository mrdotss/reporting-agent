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
import {
  deleteObject,
  presignPreview,
  previewHtmlKey,
  previewKey,
} from "@/lib/aws/s3"
import { newSessionId } from "@/lib/session-id"
import { getTemplate, TemplateNotFoundError } from "@/lib/templates/store"
import { mostRecentSnapshotRun, newPreviewId } from "@/lib/templates/preview"
import {
  PREVIEW_BUDGET_MS,
  previewRequestSchema,
  templateIdParamSchema,
} from "@/lib/templates/input"

/**
 * `POST /api/templates/[id]/preview` — the real preview (Requirement 14).
 *
 * Renders the definition **currently composed in the wizard** — inline, unsaved —
 * against the most recent completed run's snapshot for the selected subscription,
 * through the true `python-docx → LibreOffice → PDF` path, and returns a
 * presigned URL to the resulting `.pdf`.
 *
 * `export const runtime = "nodejs"` because the handler opens a Postgres
 * connection, invokes AgentCore and reaches S3.
 *
 * ## What makes this not a report
 *
 * Three things, and none of them is a rule this handler remembers:
 *
 * - The runtime writes under `previews/<previewId>/`, and `parseArtifactKey`
 *   admits exactly `snapshots` or exactly `reports` — so the report download path
 *   is *structurally* unable to serve a preview (Requirement 43.3). This route
 *   mints through `presignPreview`, a separate function over a separate
 *   predicate.
 * - `run_render_preview` emits **no `report_file`** event, so nothing downstream
 *   treats the object as a deliverable.
 * - No `report_runs` row is inserted, so a preview appears in no run list and is
 *   swept by no reaper.
 *
 * ## The 180-second budget, and the cleanup that must not eat into it
 *
 * Requirement 14.9 gives the whole activation 180 seconds. The invocation is
 * raced against that deadline here rather than trusted to the SDK's own, because
 * the number has to be the same one the panel reports.
 *
 * The superseded-preview delete is scheduled with `after()` — it runs once the
 * response has been sent, so a slow `DeleteObject` cannot widen a budget that is
 * about how long a consultant waits. Deleting *before* rendering would be worse
 * still: it would remove the previous preview at the moment the new one might
 * fail, leaving the panel with nothing to show.
 *
 * ## Failures name the stage
 *
 * Requirement 14.9 wants "compilation, `.docx` rendering or `.pdf` conversion".
 * The runtime is what knows which; this handler maps its terminal error code to
 * one of the three and passes the stage through, rather than inventing a
 * guess from the shape of a stream failure.
 */
export const runtime = "nodejs"

/** The three stages Requirement 14.9 names, and nothing else. */
type PreviewStage = "compilation" | "docx" | "pdf"

type PreviewResponseBody = {
  readonly url: string
  readonly expiresIn: number
  /** So the panel can present what Requirement 14.10 requires alongside the `.pdf`. */
  readonly snapshotId: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly timezone: string
}

/**
 * Which stage a terminal error code belongs to.
 *
 * `TEMPLATE_INVALID` and `COMPILE_FAILED` are compilation; `RENDER_FAILED` is the
 * `.docx`; `PDF_CONVERSION_FAILED` is the conversion. An unrecognized code
 * resolves to compilation, which is the earliest stage — and saying "it failed
 * while compiling" about a later failure is a smaller lie than the reverse,
 * because compilation is the stage a consultant can act on by editing the
 * template.
 */
function stageFor(code: string | undefined): PreviewStage {
  if (code === "PDF_CONVERSION_FAILED") return "pdf"
  if (code === "RENDER_FAILED") return "docx"

  return "compilation"
}

const STAGE_MESSAGE: Readonly<Record<PreviewStage, string>> = {
  compilation:
    "The real preview was not produced: compilation failed. The composed " +
    "definition could not be compiled against that run's snapshot.",
  docx:
    "The real preview was not produced: the .docx rendering failed. The " +
    "document was compiled but could not be emitted against the chosen theme.",
  pdf:
    "The real preview was not produced: the .pdf conversion failed. The .docx " +
    "was rendered but LibreOffice could not convert it.",
}

type TemplateRouteContext = Readonly<{ params: Promise<{ id: string }> }>

/** Drain the runtime's stream, returning the terminal error code if it carried one. */
async function drainForOutcome(
  stream: AsyncIterable<Uint8Array>
): Promise<{ ok: true } | { ok: false; code: string | undefined }> {
  const decoder = new TextDecoder()
  let buffered = ""

  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true })
  }

  // The runtime's terminal `error` event carries a `code`. Read by a narrow
  // search rather than a full SSE parse: this handler needs one field, and the
  // relay in `lib/runs/relay.ts` is where a real parser lives.
  const match = /"code"\s*:\s*"([A-Z_]+)"/.exec(buffered)

  return match === null ? { ok: true } : { ok: false, code: match[1] }
}

export async function POST(
  request: Request,
  context: TemplateRouteContext
): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const params = templateIdParamSchema.safeParse(await context.params)
  if (!params.success) return invalidInput(params.error)

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  const parsed = previewRequestSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    // Ownership of the template, first and scoped — a preview against somebody
    // else's template id resolves as not found, indistinguishably from an id
    // that exists for nobody (Requirement 1.5).
    await getTemplate(user.id, params.data.id)
  } catch (thrown) {
    if (thrown instanceof TemplateNotFoundError) return notFound()
    throw thrown
  }

  const snapshotRun = await mostRecentSnapshotRun(
    user.id,
    parsed.data.connectedSubscriptionId
  )

  if (snapshotRun === null) {
    // Requirement 14.7 — stated, with no render started and nothing fabricated.
    // A 422 rather than a 404: the request is well-formed and understood, and
    // the answer is that there is nothing to render against yet.
    return unprocessable(
      "A completed run is required before a real preview can be rendered. " +
        "Run this template — or any template — against that subscription first, " +
        "and the preview will use that run's snapshot.",
      "NO_SNAPSHOT"
    )
  }

  const previewId = newPreviewId()
  const pdfKey = previewKey(user.id, previewId)

  try {
    const stream = await invokeAgentRuntime({
      sessionId: newSessionId(),
      context: {
        actor_id: user.id,
        run_id: previewId,
      },
      command: {
        command: COMMAND_RENDER_PREVIEW,
        preview_id: previewId,
        snapshot_run_id: snapshotRun.runId,
        definition: parsed.data.definition,
      },
    })

    const outcome = await Promise.race([
      drainForOutcome(stream),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), PREVIEW_BUDGET_MS)
      ),
    ])

    if (outcome === "timeout") {
      return serviceUnavailable(
        `The real preview did not finish within ${PREVIEW_BUDGET_MS / 1000} ` +
          `seconds, so no .pdf is shown. The composed definition is unchanged.`,
        "PREVIEW_TIMEOUT"
      )
    }

    if (!outcome.ok) {
      const stage = stageFor(outcome.code)
      return unprocessable(
        STAGE_MESSAGE[stage],
        `PREVIEW_${stage.toUpperCase()}`
      )
    }

    const presigned = await presignPreview(user.id, pdfKey)

    // Requirement 13.5's cleanup, after the response. The two objects of *this*
    // preview are kept — they are what the panel is about to fetch — and the
    // caller names the one it is superseding, so the app deletes only an object
    // it minted for this user under this prefix.
    const superseded = parsed.data.supersedes
    if (superseded !== undefined && superseded !== previewId) {
      after(async () => {
        await Promise.allSettled([
          deleteObject(previewKey(user.id, superseded)),
          deleteObject(previewHtmlKey(user.id, superseded)),
        ])
      })
    }

    return json(200, {
      url: presigned.url,
      expiresIn: presigned.expiresIn,
      snapshotId: snapshotRun.snapshotId,
      periodStart: snapshotRun.periodStart,
      periodEnd: snapshotRun.periodEnd,
      timezone: snapshotRun.timezone,
    } satisfies PreviewResponseBody)
  } catch (thrown) {
    console.error(
      `[api/templates/[id]/preview] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
