import { notFound } from "@/lib/api/response"
import { keyBelongsToActor, presignArtifact } from "@/lib/aws/s3"
import { deliveryArtifact } from "@/lib/delivery/store"
import { readLatestVerificationStatus } from "@/lib/verifications/store"

/**
 * `GET /r/<token>/download?kind=pdf|docx` — a customer's download: the token is checked, a
 * short-lived S3 URL is minted at the click, and the browser is sent to it.
 *
 * The second of the two gated presigning paths (`test/download-gate.static.test.ts`): like
 * `/api/artifact-url`, it mints only for a key under the run's own actor, and only while the
 * run's **latest** verification passed — a report re-verified since it was sent, and found
 * wanting, stops downloading from the customer's link too.
 */

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const kind = new URL(request.url).searchParams.get("kind")
  if (kind !== "pdf" && kind !== "docx") return notFound()
  const artifact = await deliveryArtifact((await params).token, kind)
  if (artifact === null || !keyBelongsToActor(artifact.actorId, artifact.key)) return notFound()
  if ((await readLatestVerificationStatus(artifact.runId)) !== "pass") return notFound()
  try {
    const { url } = await presignArtifact(artifact.actorId, artifact.key)
    return Response.redirect(url, 302)
  } catch {
    return notFound()
  }
}
