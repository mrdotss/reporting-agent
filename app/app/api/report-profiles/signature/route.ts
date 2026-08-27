import { presignSignature, putSignature, signatureKey } from "@/lib/aws/s3"
import { badRequest, json, notFound, unauthorized } from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { validateSignatureUpload } from "@/lib/brands/signature-validation"

/**
 * `POST /api/report-profiles/signature` (Requirements 13.5, 13.6).
 *
 * The wizard's approver rows upload a signature image **through the app**,
 * not via a client-direct presigned `PUT` to S3, precisely because a
 * presigned `PUT` never gives the app a chance to inspect the bytes before
 * they land in the bucket — and Requirement 13.6's "not a recognised raster
 * image" is a content check, not a `Content-Type`-header check. The app
 * receives the bytes, sniffs them, and only then writes.
 *
 * `export const runtime = "nodejs"` because `@aws-sdk/client-s3` does not run
 * on the edge runtime, matching every other route in this directory.
 *
 * The response carries only `{ key }` — never a presigned URL, and never the
 * bytes back. A caller who needs to preview what it just uploaded asks for a
 * presigned GET separately (`presignSignature`), which is a read, authorized
 * the same way every other artifact read is.
 */
export const runtime = "nodejs"

type UploadResponseBody = {
  readonly key: string
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (!user) return unauthorized()

  const body = await request.arrayBuffer()
  const bytes = new Uint8Array(body)

  const result = validateSignatureUpload(bytes)
  if ("reason" in result) {
    return badRequest(result.reason, "SIGNATURE_REJECTED")
  }

  const key = signatureKey(user.id, result.format)
  const contentType = result.format === "png" ? "image/png" : "image/jpeg"

  await putSignature(key, bytes, contentType)

  return json(201, { key } satisfies UploadResponseBody)
}

/**
 * `GET /api/report-profiles/signature?key=...` — a short-lived presigned GET
 * for the wizard to preview a signature it (or an earlier session) already
 * uploaded (Requirement 13.5's read half).
 *
 * Ownership is checked with the same `signatureBelongsToActor` boolean every
 * write already goes through — a key naming another user's signature reads
 * as `notFound`, not as a distinguishable "forbidden", so the response
 * cannot be used to probe for a key's existence.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (!user) return unauthorized()

  const key = new URL(request.url).searchParams.get("key")
  if (!key) return badRequest("key is required", "MISSING_KEY")

  try {
    const { url, expiresIn } = await presignSignature(user.id, key)
    return json(200, { url, expiresIn })
  } catch {
    return notFound()
  }
}
