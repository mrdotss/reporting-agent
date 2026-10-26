import {
  invalidInput,
  json,
  malformedBody,
  readJsonBody,
  serviceUnavailable,
  unauthorized,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { DescribeUnavailableError, describePreset } from "@/lib/presets/describe"
import { describeInputSchema, type Outline } from "@/lib/presets/outline"

/**
 * `POST /api/report-profiles/describe` — draft a preset outline from a description, or
 * refine the one on screen (Describe it).
 *
 * Writes nothing: the outline comes back to the page, and a preset exists only once the
 * person saves it through `POST /api/report-profiles` with that outline.
 */
export const runtime = "nodejs"

type DescribeResponseBody = {
  readonly outline: Outline
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  const parsed = describeInputSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  try {
    const outline = await describePreset(parsed.data)
    return json(200, { outline } satisfies DescribeResponseBody)
  } catch (thrown) {
    if (thrown instanceof DescribeUnavailableError) {
      return serviceUnavailable(thrown.message, "DESCRIBE_UNAVAILABLE")
    }
    throw thrown
  }
}
