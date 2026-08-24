/**
 * Paper stylesheet guard — one declared list against one stylesheet.
 *
 * Reads `app/app/globals.css`, extracts its selectors, and asserts a rule
 * exists for each of the thirteen class names read from `paper-classes.ts`,
 * failing **naming the class name**.
 *
 * Never a TypeScript test parsing Python from another package.
 *
 * Requirements: 22.5, 22.7
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { EMITTED_CLASS_NAMES } from "@/components/reports/paper-classes"

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const GLOBALS_CSS = path.join(appRoot, "app", "globals.css")

function readGlobalsCss(): string {
  return readFileSync(GLOBALS_CSS, "utf-8")
}

describe("paper-stylesheet guard", () => {
  const css = readGlobalsCss()

  test("a rule exists for each declared class name", () => {
    const missing: string[] = []
    for (const cls of EMITTED_CLASS_NAMES) {
      // Match .rpt-xxx as a selector (possibly combined, e.g. .rpt-figure + .rpt-figure)
      const selectorPattern = new RegExp(`\\.${cls.replace("-", "\\-")}\\b`)
      if (!selectorPattern.test(css)) {
        missing.push(cls)
      }
    }
    expect(missing).toEqual([])
  })

  test("--font-mono is present in the @theme inline block", () => {
    // The task requires asserting --font-mono: var(--font-mono); is already present
    expect(css).toMatch(/--font-mono:\s*var\(--font-mono\)/)
  })

  test("no rpt- rule mentions destructive", () => {
    // Extract all rpt- rule blocks and check none references --destructive
    const rptRulePattern = /\.rpt-[^{]*\{[^}]*\}/g
    let match: RegExpExecArray | null
    const violations: string[] = []
    while ((match = rptRulePattern.exec(css)) !== null) {
      if (match[0].includes("destructive")) {
        violations.push(match[0].slice(0, 80))
      }
    }
    expect(violations).toEqual([])
  })
})
