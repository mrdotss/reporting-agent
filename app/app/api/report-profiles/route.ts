import {
  createTemplate,
  publishTemplateVersion,
  TemplateInvalidError,
} from "@/lib/actions/templates"
import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  readJsonBody,
  searchParamsObject,
  unauthorized,
  type ApiErrorBody,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { toTemplateView, type TemplateView,
  templateViewCurrentVersion,
} from "@/lib/db/views"
import {
  templateCreateInputSchema,
  templateQuerySchema,
} from "@/lib/templates/input"
import { listTemplates, readLatestVersionForView } from "@/lib/templates/store"

/**
 * `POST /api/templates` and `GET /api/templates` (Requirements 1.4, 1.9, 9.2,
 * 7.7).
 *
 * `export const runtime = "nodejs"` because both handlers open a Postgres
 * connection through `pg`, which does not run on the edge runtime.
 *
 * ## Every read is scoped by the session's user id
 *
 * Not by a body field, not by a search parameter. The store applies the
 * `user_id` predicate inside each statement, so another user's row matches
 * nothing rather than being read and then filtered — and there is no id in the
 * request a caller could substitute.
 */
export const runtime = "nodejs"

type CreateResponseBody = {
  readonly template: TemplateView
}

type ListResponseBody = {
  readonly templates: readonly TemplateView[]
}

/**
 * A validation rejection, carrying every failing field path (Requirement 2.7).
 *
 * Shaped as {@link ApiErrorBody} so a caller distinguishes it from a success body
 * by one key at any status, and `fields` is populated from the validator's own
 * issue list rather than a zod error — the definition is not parsed by zod
 * (see `lib/templates/input.ts`), so `invalidInput` has nothing to read.
 */
function definitionRejected(thrown: TemplateInvalidError): Response {
  return json(400, {
    error: {
      message: thrown.message,
      code: "TEMPLATE_INVALID",
      fields: thrown.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    },
  } satisfies ApiErrorBody)
}

/**
 * Create a template, and its `version` 1 when the body carries a definition.
 *
 * ## The two-statement window, and why it is acceptable here
 *
 * A definition-carrying create inserts the template row and then the version
 * row, and the two are not one transaction. A failure between them leaves a
 * named template with no version — which is **exactly the state the wizard
 * produces on purpose** at step 1, and which the list renders as "no saved
 * version" and the enqueue refuses with "the template has no saved version".
 * There is no state here that a later save cannot reach, and no partial write
 * that misrepresents anything.
 *
 * That is not true of the starter seeder, and Requirement 10.6 says so: a
 * partial *starter* insert must retain nothing. The difference is that a
 * consultant watching this request can see the result and press save again,
 * while account creation happens once, unattended.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  const parsed = templateCreateInputSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const template = await createTemplate(user.id, {
      name: parsed.data.name,
      ...(parsed.data.description === undefined
        ? {}
        : { description: parsed.data.description }),
    })

    if (parsed.data.definition === undefined) {
      return json(201, {
        template: toTemplateView(template, null),
      } satisfies CreateResponseBody)
    }

    const version = await publishTemplateVersion(
      user.id,
      template.id,
      parsed.data.definition
    )

    return json(201, {
      template: toTemplateView(template, templateViewCurrentVersion(version)),
    } satisfies CreateResponseBody)
  } catch (thrown) {
    if (thrown instanceof TemplateInvalidError)
      return definitionRejected(thrown)

    console.error(
      `[api/templates] POST failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}

/**
 * This user's templates, oldest first, with each one's current version number
 * and digest (Requirement 1.4).
 *
 * ## One query per template, and why that is the right shape here
 *
 * `readLatestVersionForView` runs per row rather than as one join. A user holds three
 * starters plus what they author — single digits, not a page of results — and
 * the alternative is a `DISTINCT ON` that has to be kept consistent with
 * `readHighestVersionRow`'s own ordering. When a user's template count makes
 * this worth changing, the fix is a join in the store beside that function,
 * where the two orderings can be compared, rather than a second ordering
 * written here.
 *
 * Note that this resolves the **highest existing version**, not
 * `current_version_id`. The two agree today, and resolving the highest is what
 * the enqueue does (Requirement 9.6), so the list shows a consultant the version
 * a run would actually pin.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const query = templateQuerySchema.safeParse(searchParamsObject(request.url))
  if (!query.success) return invalidInput(query.error)

  try {
    const rows = await listTemplates(user.id)

    const templates = await Promise.all(
      rows.map(async (row) =>
        toTemplateView(row, (await readLatestVersionForView(user.id, row.id)) ?? null)
      )
    )

    return json(200, { templates } satisfies ListResponseBody)
  } catch (thrown) {
    console.error(
      `[api/templates] GET failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
