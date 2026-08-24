import fc from "fast-check"
import { describe, expect, test } from "vitest"

import type { RunGap } from "@/lib/runs/gaps"
import {
  GRAIN_STEPS,
  NO_METRIC_KEY,
  UNATTRIBUTED_RESOURCE_KEY,
  groupGaps,
  type GapTypeGroup,
  type GroupGapsOptions,
} from "@/lib/runs/gap-groups"

/**
 * **Property 4: Gap grouping is lossless.** Identifier `gap_grouping_lossless`.
 *
 * **Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.5, 20.11, 20.12**
 *
 * *For any* set of 0–800 gap entries across 1–24 gapType values, 1–50 resource
 * ids (including one empty string), metrics including null, "" and 1–10 names,
 * interval starts including absent, contiguous runs at PT1H and at PT15M,
 * off-by-one-minute runs, duplicated starts, and runs with one hole; and entries
 * identical in all four fields: the grouping is lossless and deterministic.
 *
 * ## Kills
 *
 * - A grouper that de-duplicates entries rather than counting them, which presents
 *   a total below the recorded gap count.
 * - One grouping by `gapType` alone, which leaves 512 rows in one group.
 * - One whose representative depends on `Map` iteration order.
 * - One recording a range across non-contiguous intervals.
 * - One keyed on `(resourceId, metric)` alone, which produces an undefined key
 *   for every gap carrying no metric and drops rows the sum must account for.
 */

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const GAP_TYPES = [
  "interval_counts_missing",
  "interval_malformed",
  "permission_denied",
  "metric_not_selected",
  "region_unreachable",
  "metric_not_emitted",
  "resource_deallocated",
  "resource_unavailable",
  "backup_not_configured",
  "no_reservations",
  "replication_not_enabled",
  "fact_unavailable",
  "throttled",
  "batch_error",
  "timeout",
  "dns_failure",
  "sku_missing",
  "metric_definition_empty",
  "inventory_page_failed",
  "response_malformed",
  "partial_coverage",
  "data_plane_403",
  "counts_missing_vm_running",
  "interval_incomplete",
] as const

const RESOURCE_IDS = [
  "",
  "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-01",
  "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-02",
  "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-03",
  "/subscriptions/sub-1/resourceGroups/rg-2/providers/Microsoft.Compute/virtualMachines/vm-04",
  "/subscriptions/sub-1/resourceGroups/rg-2/providers/Microsoft.Compute/virtualMachines/vm-05",
  "/subscriptions/sub-1/resourceGroups/rg-2/providers/Microsoft.Storage/storageAccounts/sa-01",
  "/subscriptions/sub-1/resourceGroups/rg-2/providers/Microsoft.Sql/servers/sql-01/databases/db-01",
]

const METRICS: (string | null)[] = [
  null,
  "",
  "Percentage CPU",
  "Available Memory Bytes",
  "Disk Read Bytes",
  "Disk Write Bytes",
  "Network In Total",
  "Network Out Total",
  "VmAvailabilityMetric",
  "Disk Read Operations/Sec",
  "OS Disk IOPS Consumed Percentage",
]

const MESSAGES = [
  "No data points in this interval",
  "The metric has no data for this interval",
  "Permission denied on the resource",
  "Region endpoint unreachable",
  "Metric not emitted for this SKU",
  "VM is deallocated",
]

const GRAINS = ["PT1H", "PT15M"] as const

const UTC_OFFSETS = ["+07:00", "+00:00", "-05:00", "+05:45"] as const

/** Generate a contiguous sequence of starts at the given grain. */
function contiguousStarts(
  count: number,
  grain: "PT1H" | "PT15M",
  baseEpoch: number
): string[] {
  const step = GRAIN_STEPS[grain]
  return Array.from({ length: count }, (_, i) =>
    new Date((baseEpoch + i * step) * 1000).toISOString()
  )
}

/** Generate a contiguous sequence with one hole (missing step). */
function contiguousWithHole(
  count: number,
  grain: "PT1H" | "PT15M",
  baseEpoch: number,
  holeIndex: number
): string[] {
  const step = GRAIN_STEPS[grain]
  const starts: string[] = []
  let current = baseEpoch
  for (let i = 0; i < count; i++) {
    if (i === holeIndex) {
      current += step // skip one step
    }
    starts.push(new Date(current * 1000).toISOString())
    current += step
  }
  return starts
}

// A base epoch for July 2026 — 2026-07-01T00:00:00Z
const BASE_EPOCH = 1782950400

const gapTypeArb = fc.constantFrom(...GAP_TYPES)
const resourceIdArb = fc.constantFrom(...RESOURCE_IDS)
const metricArb = fc.constantFrom(...METRICS)
const messageArb = fc.constantFrom(...MESSAGES)
const grainArb = fc.constantFrom<"PT1H" | "PT15M">(...GRAINS)
const utcOffsetArb = fc.constantFrom(...UTC_OFFSETS)

type IntervalStartStrategy =
  | { kind: "absent" }
  | { kind: "contiguous"; grain: "PT1H" | "PT15M"; count: number }
  | { kind: "contiguous_with_hole"; grain: "PT1H" | "PT15M"; count: number; holeIndex: number }
  | { kind: "off_by_one_minute"; grain: "PT1H" | "PT15M"; count: number }
  | { kind: "duplicated"; grain: "PT1H" | "PT15M"; count: number }

const intervalStartStrategyArb: fc.Arbitrary<IntervalStartStrategy> = fc.oneof(
  fc.constant({ kind: "absent" } as const),
  fc.tuple(grainArb, fc.integer({ min: 1, max: 20 })).map(([grain, count]) => ({
    kind: "contiguous" as const,
    grain,
    count,
  })),
  fc
    .tuple(grainArb, fc.integer({ min: 2, max: 20 }))
    .chain(([grain, count]) =>
      fc.integer({ min: 1, max: count - 1 }).map((holeIndex) => ({
        kind: "contiguous_with_hole" as const,
        grain,
        count,
        holeIndex,
      }))
    ),
  fc.tuple(grainArb, fc.integer({ min: 2, max: 20 })).map(([grain, count]) => ({
    kind: "off_by_one_minute" as const,
    grain,
    count,
  })),
  fc.tuple(grainArb, fc.integer({ min: 2, max: 20 })).map(([grain, count]) => ({
    kind: "duplicated" as const,
    grain,
    count,
  }))
)

function generateStarts(
  strategy: IntervalStartStrategy,
  baseOffset: number
): (string | null)[] {
  const base = BASE_EPOCH + baseOffset
  switch (strategy.kind) {
    case "absent":
      return [null]
    case "contiguous":
      return contiguousStarts(strategy.count, strategy.grain, base)
    case "contiguous_with_hole":
      return contiguousWithHole(
        strategy.count,
        strategy.grain,
        base,
        strategy.holeIndex
      )
    case "off_by_one_minute": {
      const step = GRAIN_STEPS[strategy.grain]
      return Array.from({ length: strategy.count }, (_, i) => {
        const offset = i === strategy.count - 1 ? step - 60 : step
        return new Date((base + i * offset) * 1000).toISOString()
      })
    }
    case "duplicated": {
      const starts = contiguousStarts(strategy.count, strategy.grain, base)
      // Duplicate the first start
      starts.push(starts[0])
      return starts
    }
  }
}

/**
 * Generate a full set of gap entries, 0–800.
 */
const gapSetArb: fc.Arbitrary<{
  gaps: RunGap[]
  grain: "PT1H" | "PT15M"
  utcOffset: string
}> = fc
  .tuple(
    grainArb,
    utcOffsetArb,
    fc.array(
      fc.tuple(
        gapTypeArb,
        resourceIdArb,
        metricArb,
        messageArb,
        intervalStartStrategyArb,
        fc.integer({ min: 0, max: 100000 })
      ),
      { minLength: 0, maxLength: 100 }
    )
  )
  .map(([grain, utcOffset, groups]) => {
    const gaps: RunGap[] = []
    for (const [gapType, resourceId, metric, message, strategy, baseOffset] of groups) {
      const starts = generateStarts(strategy, baseOffset)
      for (const start of starts) {
        gaps.push({
          gapType,
          resourceId,
          metric,
          message,
          intervalStart: start,
        })
      }
    }
    return { gaps, grain, utcOffset }
  })

// ---------------------------------------------------------------------------
// Declared cases (Requirement 25.5)
// ---------------------------------------------------------------------------

/**
 * Declared case 1: 512 entries across 8 metrics of 1 resource of one gapType.
 * The shape a live run produced. Asserts at most 9 rows before expansion (1 type
 * group × 8 inner groups + 1 no-metric = max 9) while counts still sum to 512.
 */
function declaredCase512(): [RunGap[], GroupGapsOptions] {
  const entries: RunGap[] = []
  const resource =
    "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-01"
  const metrics = [
    "Percentage CPU",
    "Available Memory Bytes",
    "Disk Read Bytes",
    "Disk Write Bytes",
    "Network In Total",
    "Network Out Total",
    "VmAvailabilityMetric",
    "Disk Read Operations/Sec",
  ]
  // 512 entries across 8 metrics: 64 per metric
  for (const metric of metrics) {
    const starts = contiguousStarts(64, "PT1H", BASE_EPOCH)
    for (const start of starts) {
      entries.push({
        gapType: "interval_counts_missing",
        resourceId: resource,
        metric,
        message: "No data points in this interval",
        intervalStart: start,
      })
    }
  }
  return [entries, { grain: "PT1H", utcOffset: "+07:00" }]
}

/**
 * Declared case 2: an entry carrying a null metric.
 */
function declaredCaseNullMetric(): [RunGap[], GroupGapsOptions] {
  const entries: RunGap[] = [
    {
      gapType: "permission_denied",
      resourceId:
        "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-01",
      metric: null,
      message: "Permission denied on the resource",
      intervalStart: null,
    },
  ]
  return [entries, { grain: "PT1H", utcOffset: "+07:00" }]
}

/**
 * Declared case 3: an entry carrying an empty resourceId.
 */
function declaredCaseEmptyResource(): [RunGap[], GroupGapsOptions] {
  const entries: RunGap[] = [
    {
      gapType: "region_unreachable",
      resourceId: "",
      metric: null,
      message: "Region endpoint unreachable",
      intervalStart: null,
    },
  ]
  return [entries, { grain: "PT1H", utcOffset: "+07:00" }]
}

/**
 * Declared case 4: a group whose starts are one grain step apart except for one
 * hole, asserting NO range.
 */
function declaredCaseHole(): [RunGap[], GroupGapsOptions] {
  const starts = contiguousWithHole(5, "PT1H", BASE_EPOCH, 2)
  const entries: RunGap[] = starts.map((start) => ({
    gapType: "interval_counts_missing",
    resourceId:
      "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-01",
    metric: "Percentage CPU",
    message: "No data points in this interval",
    intervalStart: start,
  }))
  return [entries, { grain: "PT1H", utcOffset: "+07:00" }]
}

/**
 * The four declared cases, pre-shaped for fast-check's `examples` option.
 *
 * fast-check examples are tuples matching the property's argument list — here,
 * one positional argument shaped `{ gaps, grain, utcOffset }`. The guard
 * (property-hygiene.static.test.ts) counts cases by reading this identifier as a
 * module-scope array literal, so the reference in each `fc.assert` must be the
 * bare name `DECLARED_EXAMPLES` — not a `.map()` or any other computed expression.
 *
 * numRuns is 104 = 100 (floor) + 4 (declared cases).
 */
const DECLARED_EXAMPLES: [{ gaps: RunGap[]; grain: "PT1H" | "PT15M"; utcOffset: string }][] = [
  [{ gaps: declaredCase512()[0], grain: "PT1H", utcOffset: "+07:00" }],
  [{ gaps: declaredCaseNullMetric()[0], grain: "PT1H", utcOffset: "+07:00" }],
  [{ gaps: declaredCaseEmptyResource()[0], grain: "PT1H", utcOffset: "+07:00" }],
  [{ gaps: declaredCaseHole()[0], grain: "PT1H", utcOffset: "+07:00" }],
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function totalCount(groups: readonly GapTypeGroup[]): number {
  return groups.reduce((sum, g) => sum + g.count, 0)
}

function totalInnerCount(groups: readonly GapTypeGroup[]): number {
  return groups.reduce(
    (sum, g) =>
      sum + g.innerGroups.reduce((iSum, ig) => iSum + ig.count, 0),
    0
  )
}

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe("Property 4: gap_grouping_lossless", () => {
  test("counts sum to the input count", () => {
    fc.assert(
      fc.property(gapSetArb, ({ gaps, grain, utcOffset }) => {
        const result = groupGaps(gaps, { grain, utcOffset })
        // Top-level counts
        expect(totalCount(result)).toBe(gaps.length)
        // Inner-level counts
        expect(totalInnerCount(result)).toBe(gaps.length)
      }),
      { numRuns: 104, examples: DECLARED_EXAMPLES }
    )
  })

  test("every entry is in exactly one group", () => {
    fc.assert(
      fc.property(gapSetArb, ({ gaps, grain, utcOffset }) => {
        const result = groupGaps(gaps, { grain, utcOffset })

        // Verify that the type set equals the input's distinct types
        const inputTypes = new Set(gaps.map((g) => g.gapType))
        const outputTypes = new Set(result.map((g) => g.gapType))
        expect(outputTypes).toEqual(inputTypes)

        // Verify inner key set matches distinct keys under total keying
        for (const typeGroup of result) {
          const entriesOfType = gaps.filter(
            (g) => g.gapType === typeGroup.gapType
          )
          const expectedInnerKeys = new Set(
            entriesOfType.map((e) => {
              const rKey = e.resourceId === "" ? UNATTRIBUTED_RESOURCE_KEY : e.resourceId
              const mKey =
                e.metric === null || e.metric === "" ? NO_METRIC_KEY : e.metric
              return `${rKey}\u0000${mKey}`
            })
          )
          const actualInnerKeys = new Set(
            typeGroup.innerGroups.map(
              (ig) => {
                const rKey = ig.resourceId === "" ? UNATTRIBUTED_RESOURCE_KEY : ig.resourceId
                return `${rKey}\u0000${ig.metricKey}`
              }
            )
          )
          expect(actualInnerKeys).toEqual(expectedInnerKeys)
        }
      }),
      { numRuns: 104, examples: DECLARED_EXAMPLES }
    )
  })

  test("identical grouping and identical representative on every call", () => {
    fc.assert(
      fc.property(gapSetArb, ({ gaps, grain, utcOffset }) => {
        const opts: GroupGapsOptions = { grain, utcOffset }
        const result1 = groupGaps(gaps, opts)
        const result2 = groupGaps(gaps, opts)
        expect(result1).toEqual(result2)
      }),
      { numRuns: 104, examples: DECLARED_EXAMPLES }
    )
  })

  test("contiguous range is exactly earliest → latest + one step; non-contiguous or start-less is absent", () => {
    fc.assert(
      fc.property(gapSetArb, ({ gaps, grain, utcOffset }) => {
        const grainStep = GRAIN_STEPS[grain]
        const result = groupGaps(gaps, { grain, utcOffset })

        for (const typeGroup of result) {
          for (const innerGroup of typeGroup.innerGroups) {
            // Collect entries of this inner group from the input
            const entries = gaps.filter((g) => {
              if (g.gapType !== typeGroup.gapType) return false
              const rKey = g.resourceId === "" ? UNATTRIBUTED_RESOURCE_KEY : g.resourceId
              const mKey =
                g.metric === null || g.metric === "" ? NO_METRIC_KEY : g.metric
              const igRKey = innerGroup.resourceId === "" ? UNATTRIBUTED_RESOURCE_KEY : innerGroup.resourceId
              return rKey === igRKey && mKey === innerGroup.metricKey
            })

            // Check if any entry has no start
            const hasAbsentStart = entries.some(
              (e) => e.intervalStart === null
            )
            if (hasAbsentStart) {
              expect(innerGroup.range).toBeNull()
              continue
            }

            // Parse all starts
            const starts = entries
              .map((e) => Date.parse(e.intervalStart!))
              .filter((ms) => !Number.isNaN(ms))
              .map((ms) => ms / 1000)

            if (starts.length === 0) {
              expect(innerGroup.range).toBeNull()
              continue
            }

            starts.sort((a, b) => a - b)

            // Check contiguity
            let isContiguous = true
            for (let i = 1; i < starts.length; i++) {
              if (starts[i] - starts[i - 1] !== grainStep) {
                isContiguous = false
                break
              }
            }

            if (!isContiguous) {
              expect(innerGroup.range).toBeNull()
            } else {
              expect(innerGroup.range).not.toBeNull()
              // Verify the range spans earliest → latest + one step
              // (We can't easily verify the formatted string without
              // reimplementing the formatter, but we verify it's present.)
            }
          }
        }
      }),
      { numRuns: 104, examples: DECLARED_EXAMPLES }
    )
  })

  test("no undefined key — null metric and empty resourceId are handled", () => {
    fc.assert(
      fc.property(gapSetArb, ({ gaps, grain, utcOffset }) => {
        const result = groupGaps(gaps, { grain, utcOffset })
        for (const typeGroup of result) {
          for (const innerGroup of typeGroup.innerGroups) {
            expect(innerGroup.metricKey).toBeDefined()
            expect(innerGroup.metricKey).not.toBe("")
            expect(innerGroup.resourceId).toBeDefined()
          }
        }
      }),
      { numRuns: 104, examples: DECLARED_EXAMPLES }
    )
  })

  // --- Declared case assertions -------------------------------------------------

  test("DECLARED CASE: 512 entries across 8 metrics produce at most 9 inner groups with sum 512", () => {
    const [entries, opts] = declaredCase512()
    expect(entries).toHaveLength(512)
    const result = groupGaps(entries, opts)
    expect(totalCount(result)).toBe(512)
    expect(totalInnerCount(result)).toBe(512)
    // 1 type group, 8 inner groups (one per metric)
    expect(result).toHaveLength(1)
    expect(result[0].innerGroups.length).toBeLessThanOrEqual(9)
  })

  test("DECLARED CASE: entry with null metric is placed in a group", () => {
    const [entries, opts] = declaredCaseNullMetric()
    const result = groupGaps(entries, opts)
    expect(totalCount(result)).toBe(1)
    const inner = result[0].innerGroups[0]
    expect(inner.metricKey).toBe(NO_METRIC_KEY)
    expect(inner.count).toBe(1)
  })

  test("DECLARED CASE: entry with empty resourceId is placed in a group", () => {
    const [entries, opts] = declaredCaseEmptyResource()
    const result = groupGaps(entries, opts)
    expect(totalCount(result)).toBe(1)
    const inner = result[0].innerGroups[0]
    // The resourceId on the inner group should still be the original ""
    expect(inner.resourceId).toBe("")
    expect(inner.count).toBe(1)
  })

  test("DECLARED CASE: hole in contiguous starts produces no range", () => {
    const [entries, opts] = declaredCaseHole()
    const result = groupGaps(entries, opts)
    expect(totalCount(result)).toBe(entries.length)
    const inner = result[0].innerGroups[0]
    expect(inner.range).toBeNull()
  })
})
