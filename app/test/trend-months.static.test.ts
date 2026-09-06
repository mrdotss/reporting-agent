import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

import { MAX_SEEDED_TREND_MONTHS } from "@/lib/templates/definition"

/**
 * The seeded-trend bound is one number in two languages.
 *
 * The agent decides it — `collect/buckets.py` is where the months are walked and where
 * each one costs a pass over the estate — and the wizard quotes it, because a consultant
 * setting a lookback of twelve is entitled to know that only three of those months will be
 * measured by this run. A drifted copy would put a number in front of them that nothing
 * enforces, which is the failure the helper text already had once: it promised "a deeper
 * trend is a longer run" while the collector capped at three.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
)
const BUCKETS = path.join(
  repoRoot,
  "agent",
  "src",
  "reporting_agent",
  "collect",
  "buckets.py"
)

describe("MAX_SEEDED_TREND_MONTHS mirrors the agent's MAX_TREND_MONTHS", () => {
  test("the agent declares it exactly once, as an integer literal", () => {
    const source = readFileSync(BUCKETS, "utf8")
    const matches = [
      ...source.matchAll(/^MAX_TREND_MONTHS:\s*Final\[int\]\s*=\s*(\d+)$/gm),
    ]

    expect(matches).toHaveLength(1)
    expect(Number(matches[0][1])).toBe(MAX_SEEDED_TREND_MONTHS)
  })

  test("it is at least the minimum lookback, or no seeded trend could ever be plotted", () => {
    expect(MAX_SEEDED_TREND_MONTHS).toBeGreaterThanOrEqual(2)
  })
})
