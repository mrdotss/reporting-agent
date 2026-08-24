/**
 * Globals preset guard — asserts the Luma preset tokens in globals.css have not
 * been changed, removed or reordered.
 *
 * Compares every `--*` custom property declared in `:root` and `.dark` (the
 * FIRST occurrence of each block — the preset block, not the appended categorical
 * palette) against a committed fixture, failing on a changed value, a removed
 * declaration or a reordered block and naming the token.
 *
 * Also asserts:
 * - `@import "shadcn/tailwind.css"` survives (pruning it breaks the build).
 * - No appended `rpt-` rule mentions `destructive`.
 *
 * Requirements: 22.11, 22.12
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import fixture from "./fixtures/globals-preset-tokens.json"

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const GLOBALS_CSS_PATH = path.join(appRoot, "app", "globals.css")

function readGlobalsCss(): string {
  return readFileSync(GLOBALS_CSS_PATH, "utf-8")
}

/**
 * Parse the FIRST `:root { ... }` or `.dark { ... }` block's custom properties.
 * Returns entries in declaration order.
 */
function parseFirstBlock(
  css: string,
  selector: ":root" | ".dark",
): Array<[string, string]> {
  // Find the first occurrence of the selector followed by {
  const selectorEscaped = selector.replace(".", "\\.")
  const blockRe = new RegExp(`${selectorEscaped}\\s*\\{`, "g")
  const match = blockRe.exec(css)
  if (!match) return []

  const start = match.index + match[0].length
  let depth = 1
  let end = start
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++
    else if (css[i] === "}") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }

  const body = css.slice(start, end)
  const entries: Array<[string, string]> = []
  const propRe = /(--[\w-]+)\s*:\s*([^;]+);/g
  let propMatch: RegExpExecArray | null
  while ((propMatch = propRe.exec(body)) !== null) {
    entries.push([propMatch[1], propMatch[2].trim()])
  }
  return entries
}

describe("globals-preset token guard", () => {
  const css = readGlobalsCss()

  test(":root tokens match the committed fixture values", () => {
    const rootEntries = parseFirstBlock(css, ":root")
    const fixtureRoot = fixture.root as Record<string, string>

    const issues: string[] = []
    for (const [token, value] of rootEntries) {
      if (!(token in fixtureRoot)) {
        // Extra tokens are allowed (appended blocks add them)
        continue
      }
      if (fixtureRoot[token] !== value) {
        issues.push(
          `${token}: expected "${fixtureRoot[token]}", got "${value}"`,
        )
      }
    }

    // Check nothing in the fixture is missing from the file
    const rootTokenSet = new Set(rootEntries.map(([t]) => t))
    for (const token of Object.keys(fixtureRoot)) {
      if (!rootTokenSet.has(token)) {
        issues.push(`${token}: REMOVED from :root`)
      }
    }

    expect(issues).toEqual([])
  })

  test(":root tokens are in the expected order", () => {
    const rootEntries = parseFirstBlock(css, ":root")
    const rootTokens = rootEntries.map(([t]) => t)
    const expectedOrder = fixture.root_order as string[]

    // The actual tokens must start with the expected order (appended tokens follow)
    const actualPresetTokens = rootTokens.slice(0, expectedOrder.length)
    expect(actualPresetTokens).toEqual(expectedOrder)
  })

  test(".dark tokens match the committed fixture values", () => {
    const darkEntries = parseFirstBlock(css, ".dark")
    const fixtureDark = fixture.dark as Record<string, string>

    const issues: string[] = []
    for (const [token, value] of darkEntries) {
      if (!(token in fixtureDark)) {
        continue
      }
      if (fixtureDark[token] !== value) {
        issues.push(
          `${token}: expected "${fixtureDark[token]}", got "${value}"`,
        )
      }
    }

    const darkTokenSet = new Set(darkEntries.map(([t]) => t))
    for (const token of Object.keys(fixtureDark)) {
      if (!darkTokenSet.has(token)) {
        issues.push(`${token}: REMOVED from .dark`)
      }
    }

    expect(issues).toEqual([])
  })

  test(".dark tokens are in the expected order", () => {
    const darkEntries = parseFirstBlock(css, ".dark")
    const darkTokens = darkEntries.map(([t]) => t)
    const expectedOrder = fixture.dark_order as string[]

    const actualPresetTokens = darkTokens.slice(0, expectedOrder.length)
    expect(actualPresetTokens).toEqual(expectedOrder)
  })

  test("@import shadcn/tailwind.css survives", () => {
    expect(css).toContain('@import "shadcn/tailwind.css"')
  })

  test("no appended rpt- rule mentions destructive", () => {
    // Find the rpt- rules section (after the last @theme inline)
    const rptSection = css.slice(css.lastIndexOf("rpt-"))
    const rptRuleBlocks = rptSection.match(/\.rpt-[^{]*\{[^}]*\}/g) || []

    const violations: string[] = []
    for (const block of rptRuleBlocks) {
      if (block.includes("destructive")) {
        violations.push(block.slice(0, 60))
      }
    }
    expect(violations).toEqual([])
  })
})
