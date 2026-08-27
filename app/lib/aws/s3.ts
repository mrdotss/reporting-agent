import "server-only"

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { randomUUID } from "node:crypto"

import { requireEnv } from "@/lib/env"

/**
 * Artifact keys, download authorization and the presigner (Requirement 37.8).
 *
 * The artifact key layout is `<actor_id>/snapshots/<runId>/<rest…>`, and
 * `actor_id` **is** `report_runs.user_id` — the same value the runtime receives
 * as `actor_id` in the invoke context (Requirement 41.11). That coincidence is
 * the whole authorization mechanism: a key's first segment names its owner, so a
 * download request can be authorized by comparing that segment against the
 * signed-in user's id, with no lookup and nothing to fall out of sync.
 *
 * `lib/db/views.ts#snapshotArtifactKey` **writes** that layout and this module
 * **reads** it. The two are the same template and are asserted against each other
 * in `lib/aws/s3.test.ts`, because three copies of a path template is how the
 * authorization check ends up guarding a key nothing writes.
 */

/**
 * The longest a presigned URL may live (Requirement 37.8).
 *
 * Five minutes is long enough for a browser to follow a download and short
 * enough that a URL copied out of a history entry or a proxy log is useless by
 * the time anybody reads it. It is a **maximum**, and the only value this module
 * mints with, so there is no call site that can quietly ask for an hour.
 */
export const MAX_PRESIGN_SECONDS = 300

/** The second segment of every artifact key. */
export const ARTIFACT_SEGMENT_SNAPSHOTS = "snapshots"

/** The report artifacts' second segment — `.docx`, `.pdf`, ledger, AST, prose. */
export const ARTIFACT_SEGMENT_REPORTS = "reports"

/**
 * The **only** two second segments a download may name (Requirement 43.2).
 *
 * A closed set matched exactly, not a prefix and not a pattern. `previews` is
 * deliberately outside it: a preview is written under
 * `<actor>/previews/<previewId>/preview.pdf` and presented inline by a route with
 * its own key template, so the report download path is *structurally* unable to
 * serve a preview and the preview path is unable to serve a report. That is a
 * property of the key space rather than a rule either route has to remember.
 */
export const DOWNLOADABLE_SEGMENTS: ReadonlySet<string> = Object.freeze(
  new Set([ARTIFACT_SEGMENT_SNAPSHOTS, ARTIFACT_SEGMENT_REPORTS])
)

/** The minimum segment count of `<actor>/snapshots/<run>/<rest>`. */
const MINIMUM_SEGMENTS = 4

/**
 * A parsed artifact key.
 *
 * `rest` is everything after the run id, joined back with `/` — `snapshot.json`
 * today, and `raw/0001.json.gz` once the raw archive lands, which is why it is a
 * remainder rather than a file name.
 */
export type ParsedArtifactKey = {
  actorId: string
  /** `snapshots` or `reports` — never anything else; see {@link DOWNLOADABLE_SEGMENTS}. */
  kind: string
  runId: string
  rest: string
}

/**
 * A download or read was refused (Requirement 37.12).
 *
 * Callers resolve this as **not found**, not as forbidden: a request for another
 * user's key must not confirm that the key exists. The message names no key and
 * no user id, so it is safe to log verbatim.
 */
export class ArtifactAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactAccessError"
  }
}

/**
 * Split an artifact key into its actor id, run id and remainder, or return
 * `null` if it is not an artifact key. **Pure** — no I/O, no clock, no
 * environment.
 *
 * Every segment must be non-empty, so `alice//run/x` and a key with a leading
 * `/` are rejected rather than parsed into an empty actor id that would then
 * compare equal to an empty candidate. Requiring four segments is what makes
 * `alice/snapshots/run-1` — a prefix, not an object — fail to parse.
 *
 * The second segment is matched **exactly**, against a closed set of two. There
 * is deliberately no case-folding and no normalization: S3 keys are byte strings,
 * `Snapshots/` is a different prefix from `snapshots/`, and accepting both here
 * would authorize against a key the writer never wrote. `previews` is absent from
 * that set, which is what makes a preview unreachable through the report download
 * path however the caller asks.
 */
export function parseArtifactKey(key: string): ParsedArtifactKey | null {
  if (typeof key !== "string" || key.length === 0) return null

  const segments = key.split("/")

  if (segments.length < MINIMUM_SEGMENTS) return null
  if (segments.some((segment) => segment.length === 0)) return null
  if (!DOWNLOADABLE_SEGMENTS.has(segments[1])) return null

  return {
    actorId: segments[0],
    kind: segments[1],
    runId: segments[2],
    rest: segments.slice(3).join("/"),
  }
}

/**
 * Does this key belong to this actor? **Pure**, and the authorization primitive
 * every artifact read runs through first.
 *
 * An **exact segment match** — `segments[0] === actorId` — and emphatically not
 * `key.startsWith(actorId)`. The `startsWith` implementation is the specific bug
 * Requirement 37.12 exists to rule out, and it is the one a reader nods along
 * with: for `actorId` `alice` it authorizes `alice-evil/snapshots/r/x`, because
 * `"alice-evil/..."` does start with `"alice"`. Adding the separator —
 * `startsWith(actorId + "/")` — fixes that one case and still authorizes
 * `alice/snapshots/...` for an actor whose id happens to *be* a path prefix, and
 * it accepts a key whose second segment is not `snapshots` at all. Parsing the
 * key and comparing one whole segment has no such family of near-misses.
 *
 * An empty `actorId` matches nothing: `parseArtifactKey` rejects empty segments,
 * so there is no key whose first segment is `""` for it to equal.
 */
export function keyBelongsToActor(actorId: string, key: string): boolean {
  if (typeof actorId !== "string" || actorId.length === 0) return false

  const parsed = parseArtifactKey(key)

  return parsed !== null && parsed.actorId === actorId
}

/**
 * Cached on `globalThis` for the reason `lib/db/index.ts` caches its pool there:
 * Next's dev server re-evaluates a module on every hot reload while the process
 * survives, so a module-level `const` would leak one client per edit.
 *
 * Keyed by region, so a region changed in the environment builds a new client
 * instead of reusing one pointed at the old one.
 */
const cache = globalThis as typeof globalThis & {
  __rptS3Client?: S3Client
  __rptS3Region?: string
}

/** The S3 client for the region currently in the environment. */
export function getS3Client(): S3Client {
  const region = requireEnv("AWS_REGION")

  if (cache.__rptS3Client !== undefined && cache.__rptS3Region === region) {
    return cache.__rptS3Client
  }

  const client = new S3Client({ region })
  cache.__rptS3Client = client
  cache.__rptS3Region = region
  return client
}

/**
 * Mint a short-lived presigned GET for one artifact (Requirement 37.8).
 *
 * **Authorization runs before any AWS call.** A key that is not this actor's
 * throws {@link ArtifactAccessError} and no URL is minted, so a probe for
 * another user's key costs nothing and reveals nothing — not even the latency
 * difference between an object that exists and one that does not.
 *
 * Ownership of the *key* is what this function checks. Ownership of the **run**
 * is the caller's other half of Requirement 37.8: the route reads the
 * `report_runs` row scoped by `user_id` and resolves a mismatch as not found.
 * Both checks are required, and neither implies the other — a key can carry a
 * well-formed actor prefix for a run that was never this user's.
 *
 * The returned URL is **never stored** and never placed in a cacheable or
 * server-rendered payload: it is minted per request, in the handler that answers
 * that request. `RunView.artifactKeys` carries keys precisely so that a run
 * payload can be cached and rendered without carrying a credential.
 */
export async function presignArtifact(
  actorId: string,
  key: string
): Promise<{ url: string; expiresIn: number }> {
  if (!keyBelongsToActor(actorId, key)) {
    throw new ArtifactAccessError(
      "The requested artifact key does not belong to the signed-in user, so " +
        "no presigned URL was minted. Resolve this as not found."
    )
  }

  const url = await getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: requireEnv("RPT_ARTIFACT_BUCKET"),
      Key: key,
    }),
    { expiresIn: MAX_PRESIGN_SECONDS }
  )

  return { url, expiresIn: MAX_PRESIGN_SECONDS }
}

/**
 * Read and parse a snapshot object, server-side.
 *
 * The **snapshot object is the store** for a run's gap list: `report_runs`
 * carries `gap_count` but not the gaps, so `lib/runs/gaps.ts` reads them from
 * here rather than from a column or a replayed event.
 *
 * No presigned URL is involved — the bytes never leave the server — so this
 * takes no actor argument and performs no ownership check. The caller builds the
 * key from a row it has already read scoped by `user_id`
 * (`snapshotArtifactKey(row.userId, row.id)`), which is a stronger guarantee than
 * re-deriving the owner from the key would be. What is checked is that the key is
 * *well-formed*: a malformed key would otherwise become a `GetObject` against
 * whatever prefix it happened to name.
 *
 * Returns `unknown`. The snapshot's shape is the agent's schema and belongs to
 * whichever module needs a field, parsed there with zod at its own boundary — a
 * type assertion here would be a claim this module cannot back.
 */
export async function getSnapshotJson(key: string): Promise<unknown> {
  if (parseArtifactKey(key) === null) {
    throw new ArtifactAccessError(
      "The supplied object key is not a well-formed artifact key " +
        "(<actor_id>/<snapshots|reports>/<runId>/<rest>), so no object was read."
    )
  }

  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: requireEnv("RPT_ARTIFACT_BUCKET"),
      Key: key,
    })
  )

  if (response.Body === undefined) {
    throw new ArtifactAccessError(
      "The artifact object carried no body, so there is no snapshot to parse."
    )
  }

  return JSON.parse(await response.Body.transformToString("utf-8")) as unknown
}

// --- Previews ---------------------------------------------------------------

/**
 * The second segment a preview lives under, and the reason there is a separate
 * function below rather than a widened {@link DOWNLOADABLE_SEGMENTS}.
 *
 * `previews` is deliberately **not** in that set (Requirement 43.3), so
 * {@link parseArtifactKey} returns `null` for a preview key and
 * {@link presignArtifact} refuses it. That is the property that makes "a preview
 * is not a report" structural: the report download path cannot serve one however
 * the caller asks, because the key does not parse in the function that path uses.
 *
 * The cost of that property is this module needing a second minting function,
 * and it is worth paying. The alternative — one function with a flag — is one
 * function a future caller passes the wrong flag to.
 */
export const ARTIFACT_SEGMENT_PREVIEWS = "previews"

/** `<actorId>/previews/<previewId>/preview.pdf`, matching `artifacts.py#preview_key`. */
export function previewKey(actorId: string, previewId: string): string {
  return `${actorId}/${ARTIFACT_SEGMENT_PREVIEWS}/${previewId}/preview.pdf`
}

/** `<actorId>/previews/<previewId>/preview.html`, matching `preview_html_key`. */
export function previewHtmlKey(actorId: string, previewId: string): string {
  return `${actorId}/${ARTIFACT_SEGMENT_PREVIEWS}/${previewId}/preview.html`
}

/**
 * Whether `key` is a preview belonging to `actorId`.
 *
 * The same **exact segment equality** {@link keyBelongsToActor} applies, and for
 * the same reason: `startsWith(actorId)` would authorize `alice-evil/...` for
 * `alice`, and `startsWith(actorId + "/")` would still admit any second segment.
 * Written out rather than delegated, because delegating would mean widening the
 * predicate the report path uses — which is the one thing this split exists to
 * prevent.
 */
export function previewBelongsToActor(actorId: string, key: string): boolean {
  const segments = key.split("/")

  return (
    actorId.length > 0 &&
    segments.length === 4 &&
    segments[0] === actorId &&
    segments[1] === ARTIFACT_SEGMENT_PREVIEWS &&
    (segments[2] ?? "").length > 0 &&
    (segments[3] === "preview.pdf" || segments[3] === "preview.html")
  )
}

/**
 * A presigned URL for one preview object.
 *
 * Expiry is the same {@link MAX_PRESIGN_SECONDS} ceiling every other minted URL
 * uses. A preview is more ephemeral than a report, not less, so a longer window
 * would be a credential outliving the thing it points at.
 */
export async function presignPreview(
  actorId: string,
  key: string
): Promise<{ url: string; expiresIn: number }> {
  if (!previewBelongsToActor(actorId, key)) {
    throw new ArtifactAccessError(
      "The requested preview key does not belong to the signed-in user, so no " +
        "presigned URL was minted. Resolve this as not found."
    )
  }

  const url = await getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: requireEnv("RPT_ARTIFACT_BUCKET"),
      Key: key,
    }),
    { expiresIn: MAX_PRESIGN_SECONDS }
  )

  return { url, expiresIn: MAX_PRESIGN_SECONDS }
}

/** Delete one object. Used only by the superseded-preview cleanup. */
export async function deleteObject(key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: requireEnv("RPT_ARTIFACT_BUCKET"),
      Key: key,
    })
  )
}

// --- Signatures (Requirement 13.5, 13.6) ------------------------------------

/** The second segment a signature image lives under. */
export const ARTIFACT_SEGMENT_SIGNATURES = "signatures"

/**
 * `<userId>/signatures/<uuid>.<ext>` — the owner-prefixed layout every other
 * artifact key uses (Requirement 37.8's mechanism), so a signature's key is
 * authorized by comparing its first segment against the signed-in user's id,
 * with no lookup and nothing to fall out of sync. A fresh `uuid` per upload
 * means re-uploading a signature for the same role never collides with, or
 * overwrites, a signature already referenced by an existing published
 * version — a version is immutable, so the object its `signature_key`
 * addresses must not change under it either.
 */
export function signatureKey(userId: string, extension: "png" | "jpeg"): string {
  const ext = extension === "jpeg" ? "jpg" : "png"
  return `${userId}/${ARTIFACT_SEGMENT_SIGNATURES}/${randomUUID()}.${ext}`
}

/**
 * Does this signature key belong to this actor? Exact segment match, for the
 * same reason {@link keyBelongsToActor} uses one rather than a `startsWith` —
 * see that function's docstring for the `alice` / `alice-evil` case this
 * rules out.
 */
export function signatureBelongsToActor(actorId: string, key: string): boolean {
  const segments = key.split("/")
  return (
    actorId.length > 0 &&
    segments.length === 3 &&
    segments[0] === actorId &&
    segments[1] === ARTIFACT_SEGMENT_SIGNATURES &&
    segments[2].length > 0
  )
}

/**
 * Write a signature image's bytes to its key. The caller has already
 * validated the content (`validateSignatureUpload`) and minted the key
 * (`signatureKey`) — this function performs no validation of its own, so it
 * is not the place a future caller can skip that step by calling something
 * that "just uploads."
 */
export async function putSignature(
  key: string,
  bytes: Uint8Array,
  contentType: "image/png" | "image/jpeg"
): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: requireEnv("RPT_ARTIFACT_BUCKET"),
      Key: key,
      Body: bytes,
      ContentType: contentType,
    })
  )
}

/**
 * A presigned GET for one signature image, so the wizard can render a
 * preview of an already-uploaded signature without the bytes passing
 * through the app a second time. Same {@link MAX_PRESIGN_SECONDS} ceiling
 * and the same "authorize before any AWS call" ordering as
 * {@link presignArtifact}.
 */
export async function presignSignature(
  actorId: string,
  key: string
): Promise<{ url: string; expiresIn: number }> {
  if (!signatureBelongsToActor(actorId, key)) {
    throw new ArtifactAccessError(
      "The requested signature key does not belong to the signed-in user, " +
        "so no presigned URL was minted. Resolve this as not found."
    )
  }

  const url = await getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: requireEnv("RPT_ARTIFACT_BUCKET"),
      Key: key,
    }),
    { expiresIn: MAX_PRESIGN_SECONDS }
  )

  return { url, expiresIn: MAX_PRESIGN_SECONDS }
}
