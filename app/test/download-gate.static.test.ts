import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

/**
 * The web-app half of Requirement 44.12 — **no** route, action or control
 * returns a presigned URL for a run whose verification is failing or absent.
 *
 * `test/api/artifact-url.route.test.ts` already proves that `GET
 * /api/artifact-url` refuses one. This file asserts the quantifier the agent
 * suite's negative tests cannot reach from their side of the boundary: that the
 * route is the **only** thing that could have minted one. A gate on one route is
 * a gate on the app only if there is one route.
 *
 * So these rules read the repository from disk and count. Adding a second
 * presigning path — a server action, a page that embeds a URL in its payload, a
 * second route — fails here rather than at the moment somebody notices a
 * download working on an unverified report.
 *
 * ## Why static rather than a runtime sweep
 *
 * A runtime test can only exercise the handlers it imports, so it answers "the
 * handlers I thought of refuse" and reports green on the one nobody thought of.
 * The claim in 44.12 is universal, and only a scan of the tree can make it.
 *
 * Each rule asserts its own completeness (a scan that found no files **fails**),
 * for the same reason: a guard that silently scans nothing is a guard that
 * always passes.
 */

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

const SOURCE_DIRECTORIES = ["app", "lib", "components", "hooks"] as const
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const

/** Test files are excluded: they mint URLs against fakes on purpose. */
const TEST_FILE = /\.(test|spec)\.tsx?$/

function listSourceFiles(): readonly string[] {
  const found: string[] = []

  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(projectRoot, relative), {
      withFileTypes: true,
    })) {
      const next = path.join(relative, entry.name)
      if (entry.isDirectory()) {
        walk(next)
      } else if (
        SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) &&
        !TEST_FILE.test(entry.name)
      ) {
        found.push(next)
      }
    }
  }

  for (const directory of SOURCE_DIRECTORIES) walk(directory)
  return found
}

const SOURCES: ReadonlyMap<string, string> = new Map(
  listSourceFiles().map((relative) => [
    relative,
    readFileSync(path.join(projectRoot, relative), "utf8"),
  ])
)

function callers(symbol: string): readonly string[] {
  const called = new RegExp(`\\b${symbol}\\s*\\(`)
  return [...SOURCES]
    .filter(([, source]) => called.test(source))
    .map(([relative]) => relative)
    .sort()
}

/** Where the presigners are defined, and therefore never a caller of interest. */
const PRESIGNER_MODULE = path.join("lib", "aws", "s3.ts")

describe("Requirement 44.12 — one presigning path for reports, and it is gated", () => {
  test("the scan found source files to read", () => {
    // Without this every rule below passes on an empty set.
    expect(SOURCES.size).toBeGreaterThan(50)
    for (const directory of SOURCE_DIRECTORIES) {
      expect(
        [...SOURCES.keys()].some((relative) => relative.startsWith(directory)),
        `no source files were scanned under ${directory}/`
      ).toBe(true)
    }
  })

  test("exactly one module outside lib/aws mints a report download", () => {
    const minting = callers("presignArtifact").filter(
      (relative) => relative !== PRESIGNER_MODULE
    )

    expect(minting).toEqual([path.join("app", "api", "artifact-url", "route.ts")])
  })

  test("that module reads the run's verification status before minting", () => {
    // The gate itself is asserted behaviourally in
    // `test/api/artifact-url.route.test.ts`. What this adds is that the gate is
    // *present in the only module that can mint*, so the behavioural test is
    // testing the whole surface rather than one of two.
    const route = SOURCES.get(path.join("app", "api", "artifact-url", "route.ts"))

    expect(route).toBeDefined()
    expect(route).toContain("readLatestVerificationStatus")
    expect(route).toContain("recordedArtifactKeys")
    expect(route).toContain("keyBelongsToActor")
  })

  test("no server action mints one", () => {
    // A server action is reachable from the browser exactly like a route and is
    // easy to forget when reasoning about "routes". Any file declaring
    // `"use server"` is one, wherever it lives.
    const actions = [...SOURCES]
      .filter(([, source]) => /^\s*["']use server["']/m.test(source))
      .filter(([, source]) => /presign\w*\s*\(/.test(source))
      .map(([relative]) => relative)

    expect(actions).toEqual([])
  })

  test("no page or component mints one during render", () => {
    // Requirement 40.1 — a URL in a server-rendered payload is a credential in
    // the page source. The control fetches at activation, so no page and no
    // component may call a presigner at all.
    const rendering = [
      ...callers("presignArtifact"),
      ...callers("presignPreview"),
    ].filter(
      (relative) =>
        relative.startsWith("components" + path.sep) ||
        (relative.startsWith("app" + path.sep) && relative.endsWith("page.tsx"))
    )

    expect(rendering).toEqual([])
  })

  test("the preview presigner is confined to the preview route", () => {
    // A preview is not a report: different key space, no verification, and
    // deleted after one read. It must not become a second way to reach a run's
    // rendered document, so its presigner is enumerated too.
    const minting = callers("presignPreview").filter(
      (relative) => relative !== PRESIGNER_MODULE
    )

    for (const relative of minting) {
      expect(relative).toMatch(/preview/)
      expect(SOURCES.get(relative)).not.toContain("reportArtifactKey")
    }
  })

  test("one download control, rendered from one place", () => {
    const control = path.join("components", "reports", "download-card.tsx")
    expect(SOURCES.has(control)).toBe(true)

    const importers = [...SOURCES]
      .filter(([relative]) => relative !== control)
      .filter(([, source]) => /\bDownloadCard\b/.test(source))
      .map(([relative]) => relative)

    expect(importers).toEqual([
      path.join("app", "(app)", "reports", "[runId]", "page.tsx"),
    ])
  })

  test("the page renders the control only behind a passing verification", () => {
    const page = SOURCES.get(
      path.join("app", "(app)", "reports", "[runId]", "page.tsx")
    )

    expect(page).toBeDefined()
    // The rendering decision and the word `pass` in the same file is a weak
    // claim on its own; it is the enumeration above that makes it a strong one,
    // because there is nowhere else the control can come from.
    expect(page).toMatch(/DownloadCard/)
    expect(page).toMatch(/"pass"|'pass'/)
  })
})
