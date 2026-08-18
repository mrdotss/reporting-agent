import "server-only"

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { DESIGN_PRESETS, type DesignPreset } from "@/lib/templates/definition"

/**
 * Whether each theme's page image is current evidence of the theme that ships
 * (Requirements 13.2, 13.8).
 *
 * ## What "available" means, and why it is a digest comparison
 *
 * `agent/src/reporting_agent/render/thumbnails.py` renders each preset's sample
 * page through the production path and writes the PNG beside a sidecar carrying
 * the SHA-256 of the **theme document that image derives from**. This module
 * recomputes that digest from the theme file currently shipped and compares.
 *
 * Requirement 13.8 makes a mismatch an *unavailable* image rather than a stale
 * one, and that is the whole point of the sidecar: a theme edited without
 * regenerating its thumbnail would otherwise show a consultant a picture of the
 * previous theme, and they would choose a preset on evidence that is quietly
 * wrong. A card saying "page image unavailable" is worse-looking and honest.
 *
 * ## Read at module load, from disk
 *
 * The sidecars and the theme files are build-time artifacts in the repository —
 * neither changes while the server runs — so they are read once. `server-only`
 * because this reaches the filesystem, and because the browser needs the
 * *verdict*, not the digests.
 *
 * ## Why the images are copied into `app/public/` rather than served from `agent/`
 *
 * Next serves static files from `public/`, and `agent/` is not under it. The copy
 * is what `pnpm sync:thumbnails` performs, and the digest check above is what
 * makes the copy safe to have: an image that fell out of step with its theme is
 * reported unavailable whether it fell out of step in `agent/` or in the copy,
 * because the sidecar it is checked against travels with the source rather than
 * with the copy.
 */

const appRoot = path.resolve(process.cwd())

/** The monorepo root — `agent/` is a sibling of `app/`. */
const repoRoot = path.resolve(appRoot, "..")

const THUMBNAIL_SOURCE = path.join(repoRoot, "agent", "themes", "thumbnails")
const THEME_SOURCE = path.join(repoRoot, "agent", "themes")

/** Where the browser fetches the image from. */
export const THUMBNAIL_PUBLIC_PREFIX = "/theme-thumbnails"

export type ThemeThumbnail = {
  readonly preset: DesignPreset
  /**
   * The image's URL, or `null` when it is unavailable (Requirement 13.8).
   *
   * `null` for an absent image and for a digest mismatch alike. The two have one
   * behaviour — the card states the page image is unavailable and stays
   * selectable — so distinguishing them in this type would be a distinction no
   * caller can act on.
   */
  readonly src: string | null
  /** Why it is unavailable, for a server log. Never rendered. */
  readonly unavailableReason: "absent" | "stale" | null
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** The digest recorded beside a preset's image, or `null`. */
function recordedDigest(preset: string): string | null {
  const sidecar = path.join(THUMBNAIL_SOURCE, `${preset}.json`)
  if (!existsSync(sidecar)) return null

  try {
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as unknown

    if (typeof parsed !== "object" || parsed === null) return null

    const digest = (parsed as { theme_sha256?: unknown }).theme_sha256

    return typeof digest === "string" && digest.length === 64 ? digest : null
  } catch {
    // Absent, malformed and unparsable are one outcome, matching the agent's
    // own `sidecar_for` and `verify/charts.py#sidecar_digest`.
    return null
  }
}

/** The digest of the theme document currently shipped, or `null` when absent. */
function shippedDigest(preset: string): string | null {
  const theme = path.join(THEME_SOURCE, `${preset}.docx`)
  if (!existsSync(theme)) return null

  return sha256(readFileSync(theme))
}

function resolve(preset: DesignPreset): ThemeThumbnail {
  const image = path.join(THUMBNAIL_SOURCE, `${preset}.png`)

  if (!existsSync(image)) {
    return { preset, src: null, unavailableReason: "absent" }
  }

  const recorded = recordedDigest(preset)
  const shipped = shippedDigest(preset)

  // An absent sidecar, an absent theme and a genuine mismatch are all "this
  // image is not provably of this theme", which is what Requirement 13.8 acts
  // on. Treating an absent sidecar as a pass would make the check trivially
  // satisfiable by deleting a file.
  if (recorded === null || shipped === null || recorded !== shipped) {
    return { preset, src: null, unavailableReason: "stale" }
  }

  return {
    preset,
    src: `${THUMBNAIL_PUBLIC_PREFIX}/${preset}.png`,
    unavailableReason: null,
  }
}

/**
 * Every preset, with its image resolved. Always four entries, in the declared
 * order — an unavailable image drops the `src`, never the card (Requirement
 * 13.8 keeps it selectable, and 13.3 forbids substituting a name-only control).
 */
export function themeThumbnails(): readonly ThemeThumbnail[] {
  return DESIGN_PRESETS.map(resolve)
}
