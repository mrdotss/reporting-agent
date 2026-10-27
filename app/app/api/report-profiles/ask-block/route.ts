import { z } from "zod"

import { ASK_REQUEST_MAX_LENGTH } from "@/components/builder/ask"
import {
  badRequest,
  invalidInput,
  json,
  malformedBody,
  readJsonBody,
  serviceUnavailable,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import type { DefinitionV4 } from "@/lib/builder/model"
import { AskBlockGoneError, AskUnavailableError, askOnBlock } from "@/lib/presets/ask-block"

/**
 * `POST /api/report-profiles/ask-block` — Ask on the selected block in the builder.
 *
 * Takes the draft as the builder holds it, the block and the wish; answers with the
 * settings to change and their before and after. Writes nothing: the builder applies the
 * answer to its draft, and the draft saves the way every edit does.
 */
export const runtime = "nodejs"

const refSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slot"), slot: z.string().min(1).max(64), inEach: z.boolean() }),
  z.object({ kind: z.literal("added"), id: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("each") }),
])

const bodySchema = z.object({
  definition: z
    .object({
      schema_version: z.literal(4),
      provider: z.enum(["aws", "azure"]),
      identity: z.object({ language: z.enum(["en", "id"]) }).passthrough(),
      sections: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()).max(200),
    })
    .passthrough(),
  sectionId: z.string().min(1).max(64),
  ref: refSchema,
  request: z.string().trim().min(1).max(ASK_REQUEST_MAX_LENGTH),
})

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)

  const { definition, sectionId, ref } = parsed.data
  try {
    const answer = await askOnBlock(definition as unknown as DefinitionV4, sectionId, ref, parsed.data.request)
    return json(200, answer)
  } catch (thrown) {
    if (thrown instanceof AskUnavailableError) return serviceUnavailable(thrown.message, "ASK_UNAVAILABLE")
    if (thrown instanceof AskBlockGoneError) return unprocessable(thrown.message, "ASK_BLOCK_GONE")
    if (thrown instanceof TypeError) return badRequest("The draft could not be read.", "ASK_BAD_DRAFT")
    throw thrown
  }
}
