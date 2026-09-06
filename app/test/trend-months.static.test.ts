import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

import { LIVE_METRICS_TREND_MONTHS } from "@/lib/templates/definition"

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

describe("LIVE_METRICS_TREND_MONTHS mirrors the agent's retention constant", () => {
  test("the agent declares the retention window exactly once, in days", () => {
    const source = readFileSync(BUCKETS, "utf8")
    const matches = [
      ...source.matchAll(
        /^LIVE_METRICS_RETENTION_DAYS:\s*Final\[int\]\s*=\s*(\d+)$/gm
      ),
    ]

    expect(matches).toHaveLength(1)
    // 93 days is a little over three months. The wizard says "about three months", which
    // is the honest rounding — a control that promised 3.1 would be stating a precision
    // Azure's own retention does not have.
    expect(Math.floor(Number(matches[0][1]) / 31)).toBe(LIVE_METRICS_TREND_MONTHS)
  })

  test("it is at least the minimum lookback, or no live trend could ever be plotted", () => {
    expect(LIVE_METRICS_TREND_MONTHS).toBeGreaterThanOrEqual(2)
  })
})
