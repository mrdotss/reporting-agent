import "server-only"

import { logoKey, putLogo } from "@/lib/aws/s3"
import {
  SIGNATURE_MAX_BYTES,
  sniffImageFormat,
} from "@/lib/brands/signature-validation"

/**
 * Resolve a profile's cover logo URL into stored bytes, once, when a version is
 * saved.
 *
 * ## Why the fetch happens here and not at render time
 *
 * `front_matter.cover.logo` is a URL a profile author typed. Fetching it while
 * rendering would mean the runtime issuing a request to an address chosen by
 * the person whose report it is, from inside the VPC — the shape of every SSRF,
 * and a network call the render path makes nowhere else. So the app resolves it
 * exactly once, here, between validation and insertion, and writes a
 * `logo_key`. The runtime then reads its own artifact bucket, which is what it
 * already does for an approver's signature.
 *
 * It is also the same reason `resolveDesignFromBrand` sits on this seam: a
 * saved version has to be self-contained. A logo that changed at the URL after
 * a report was delivered must not change what that report shows.
 *
 * ## Never blocks a save
 *
 * A URL that is unreachable, slow, too large, or not an image leaves `logo_key`
 * absent and the definition otherwise untouched. The cover then reserves the
 * logo's space and draws nothing, which is exactly what it does for a profile
 * that names no logo — and losing a profile edit over an unreachable image
 * would be a far worse trade than a cover without one.
 */

/** The ceiling and the formats, shared with the signature upload deliberately:
 * both end up as an image in the same document, drawn by the same renderer. */
export const LOGO_MAX_BYTES = SIGNATURE_MAX_BYTES

/** How long the fetch may take before the save proceeds without it. */
export const LOGO_FETCH_TIMEOUT_MS = 5_000

/** Only these. A URL naming any other scheme is never requested — `file:` and
 * `gopher:` are not oversights to be caught downstream, and a redirect chain is
 * followed by `fetch` only within http(s). */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"])

export type LogoResolution =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Fetch, validate and store one logo URL.
 *
 * Exported for its own tests; {@link resolveLogoIntoDefinition} is what the save
 * path calls.
 */
export async function resolveLogo(
  url: string,
  userId: string
): Promise<LogoResolution> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: "the logo URL could not be parsed" }
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `the logo URL names ${parsed.protocol}` }
  }

  let bytes: Uint8Array
  try {
    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS),
      redirect: "follow",
    })
    if (!response.ok) {
      return { ok: false, reason: `the logo URL answered ${response.status}` }
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    const detail = error instanceof Error ? error.name : "unknown error"
    return { ok: false, reason: `the logo URL could not be read (${detail})` }
  }

  if (bytes.byteLength > LOGO_MAX_BYTES) {
    return {
      ok: false,
      reason: `the logo is larger than the ${LOGO_MAX_BYTES}-byte ceiling`,
    }
  }

  // The bytes' own magic number, never the URL's extension or the response's
  // Content-Type — both are strings the far end chose, and a `.png` that is not
  // a PNG would reach the renderer as a broken image on a signed document.
  const format = sniffImageFormat(bytes)
  if (format === null) {
    return { ok: false, reason: "the logo is neither a PNG nor a JPEG" }
  }

  const key = logoKey(userId, format)
  await putLogo(key, bytes, format === "png" ? "image/png" : "image/jpeg")
  return { ok: true, key }
}

/**
 * The definition with `front_matter.cover.logo_key` filled in, where the cover
 * names a logo URL this save could fetch.
 *
 * `previousKey` is the key the last version resolved, reused when the URL has
 * not changed: a profile saved five times should not fetch and store the same
 * image five times, and a version whose logo is unchanged should keep showing
 * the identical bytes.
 */
export async function resolveLogoIntoDefinition(
  definition: Record<string, unknown>,
  userId: string,
  previous: { readonly logo?: string | null; readonly logoKey?: string | null }
): Promise<Record<string, unknown>> {
  const front = definition["front_matter"]
  if (front === null || typeof front !== "object") return definition
  const frontMatter = front as Record<string, unknown>
  const cover = frontMatter["cover"]
  if (cover === null || typeof cover !== "object") return definition
  const coverRecord = cover as Record<string, unknown>

  const url = coverRecord["logo"]
  if (typeof url !== "string" || url.trim() === "") return definition

  if (previous.logo === url && typeof previous.logoKey === "string") {
    return withLogoKey(definition, frontMatter, coverRecord, previous.logoKey)
  }

  const resolved = await resolveLogo(url, userId)
  if (!resolved.ok) {
    console.warn(
      `[templates] the cover logo was not stored, so the cover reserves its ` +
        `space and draws nothing: ${resolved.reason}`
    )
    return definition
  }
  return withLogoKey(definition, frontMatter, coverRecord, resolved.key)
}

function withLogoKey(
  definition: Record<string, unknown>,
  frontMatter: Record<string, unknown>,
  cover: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  return {
    ...definition,
    front_matter: {
      ...frontMatter,
      cover: { ...cover, logo_key: key },
    },
  }
}
