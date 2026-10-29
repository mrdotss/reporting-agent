import { z } from "zod"

import {
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  unauthorized,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { toTemplateView, type TemplateView } from "@/lib/db/views"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import { templateIdParamSchema } from "@/lib/templates/input"
import {
  readLatestVersionForView,
  setTemplateArchived,
  TemplateNotFoundError,
} from "@/lib/templates/store"

/**
 * `POST /api/report-profiles/[id]/archive` with `{ archived: true | false }` — put a
 * preset away, or bring it back.
 *
 * Its own route rather than a field on `PATCH [id]`: that patch is the editor's draft
 * write, guarded by `expectedRevision`, and archiving touches neither the draft nor its
 * revision. Archiving removes nothing, so it is how a preset that made reports (which
 * `DELETE` refuses with `TEMPLATE_PINNED`) leaves the Presets page and the Overview.
 */
export const runtime = "nodejs"

type TemplateRouteContext = Readonly<{ params: Promise<{ id: string }> }>

const archiveInputSchema = z.object({ archived: z.boolean() }).strict()

export async function POST(request: Request, context: TemplateRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const params = templateIdParamSchema.safeParse(await context.params)
  if (!params.success) return invalidInput(params.error)

  const raw = await readJsonBody(request)
  if (raw === undefined) return malformedBody()
  const body = archiveInputSchema.safeParse(raw)
  if (!body.success) return invalidInput(body.error)

  try {
    const row = await setTemplateArchived(user.id, params.data.id, body.data.archived)
    const version = (await readLatestVersionForView(user.id, row.id)) ?? null
    return json(200, { template: toTemplateView(row, version) } satisfies {
      readonly template: TemplateView
    })
  } catch (thrown) {
    if (thrown instanceof TemplateNotFoundError || thrown instanceof WorkspaceAccessError) {
      return notFound()
    }
    throw thrown
  }
}
