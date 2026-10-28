import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, test } from "vitest"

import { FRIENDLY_METRICS, friendlyLabel, friendlyMetric } from "./metric-names"

/** The runtime's half of the map, read from its source so the two cannot drift apart. */
function runtimeMap(): Record<string, string> {
  const source = readFileSync(
    path.resolve(__dirname, "../../../agent/src/reporting_agent/compile/blocks/base.py"),
    "utf8"
  )
  const body = source.split("FRIENDLY_METRICS: Final[dict[str, str]] = {")[1]!.split("\n}")[0]!
  return Object.fromEntries([...body.matchAll(/"([^"]+)": "([^"]+)"/g)].map((match) => [match[1], match[2]]))
}

describe("friendly metric names", () => {
  test("name the same metrics as the runtime does", () => {
    expect(FRIENDLY_METRICS).toEqual(runtimeMap())
  })

  test("read as words in both languages, and fall back to the catalogue name", () => {
    expect(friendlyLabel("CPUUtilization", "max", "en")).toBe("Peak CPU")
    expect(friendlyLabel("Percentage CPU", "avg", "id")).toBe("CPU rata-rata")
    expect(friendlyLabel("FreeableMemory", "min", "en")).toBe("Lowest free memory")
    expect(friendlyLabel("CPUUtilization", "p95", "en")).toBe("CPUUtilization (p95)")
    expect(friendlyLabel("BurstBalance", "avg", "en")).toBe("BurstBalance (avg)")
    expect(friendlyMetric("memory_percent", "id")).toBe("Memori")
  })
})
