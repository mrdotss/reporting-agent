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

/**
 * The ceiling for the cover's **background** image, which is a different picture with a
 * different job: the logo is a mark a few centimetres wide, the background covers a whole
 * A4 page and is a photograph. 2 MB is generous for the first and refuses the second — the
 * cover image that started this was 2.39 MB, and refusing it was correct only because it
 * was being submitted as a logo.
 */
export const COVER_BACKGROUND_MAX_BYTES = 5 * 1024 * 1024

/** How long the fetch may take before the save proceeds without it.
 *
 * It was 5s, which a 10 KB PNG over a cold TLS connection reached — measured at exactly
 * 5.00s from this network, so the budget, not the host, was what failed. A save is a
 * user-initiated action that already does database work; 15s is a defensible ceiling for
 * one image fetch that fails open, and it is still short enough that a hung host does not
 * hold the save. */
export const LOGO_FETCH_TIMEOUT_MS = 15_000

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
  userId: string,
  maxBytes: number = LOGO_MAX_BYTES
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

  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      reason: `the image is larger than the ${maxBytes}-byte ceiling`,
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
/**
 * The two images a cover can carry, each resolved the same way and each with its own
 * ceiling. They are separate pictures with separate jobs: the logo is the mark at the top,
 * the background is the full-bleed image the mark sits on, and a cover may have either,
 * both or neither.
 */
const COVER_IMAGES = [
  { url: "logo", key: "logo_key", maxBytes: LOGO_MAX_BYTES },
  {
    url: "background",
    key: "background_key",
    maxBytes: COVER_BACKGROUND_MAX_BYTES,
  },
] as const

export async function resolveLogoIntoDefinition(
  definition: Record<string, unknown>,
  userId: string,
  previous: {
    readonly logo?: string | null
    readonly logoKey?: string | null
    readonly background?: string | null
    readonly backgroundKey?: string | null
  }
): Promise<Record<string, unknown>> {
  const front = definition["front_matter"]
  if (front === null || typeof front !== "object") return definition
  const frontMatter = front as Record<string, unknown>
  const cover = frontMatter["cover"]
  if (cover === null || typeof cover !== "object") return definition

  let resolvedCover = cover as Record<string, unknown>
  let changed = false

  for (const image of COVER_IMAGES) {
    const url = resolvedCover[image.url]
    if (typeof url !== "string" || url.trim() === "") continue

    const previousUrl =
      image.url === "logo" ? previous.logo : previous.background
    const previousKey =
      image.url === "logo" ? previous.logoKey : previous.backgroundKey

    // The same URL as the stored version's means the same bytes: five saves of one
    // profile are not five fetches and five stored copies, and a version whose image did
    // not change keeps showing the identical picture.
    if (previousUrl === url && typeof previousKey === "string") {
      resolvedCover = { ...resolvedCover, [image.key]: previousKey }
      changed = true
      continue
    }

    const resolved = await resolveLogo(url, userId, image.maxBytes)
    const next = { ...resolvedCover }
    if (resolved.ok) {
      next[image.key] = resolved.key
    } else {
      console.warn(
        `[templates] the cover ${image.url} was not stored, so the cover is drawn ` +
          `without it: ${resolved.reason}`
      )
      // The key that was there goes, rather than surviving into a version whose URL it
      // no longer came from. The wizard round-trips it so the form can say whether the
      // last save could read the URL, and a failed refetch that left it in place would
      // draw the *previous* image under the new address.
      delete next[image.key]
    }
    resolvedCover = next
    changed = true
  }

  if (!changed) return definition
  return {
    ...definition,
    front_matter: { ...frontMatter, cover: resolvedCover },
  }
}

