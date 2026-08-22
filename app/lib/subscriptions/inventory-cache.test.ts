import { beforeEach, describe, expect, test } from "vitest"

import {
  INVENTORY_CACHE_TTL_MS,
  INVENTORY_DIMENSION_KEYS,
  clearInventoryCache,
  inventoryCacheEntryCount,
  readInventoryCache,
  writeInventoryCache,
  type InventoryDimensions,
} from "@/lib/subscriptions/inventory-cache"

/**
 * `lib/subscriptions/inventory-cache.ts` — the 300-second listing cache
 * (Requirement 9.2).
 *
 * Nothing is faked. The module is a `Map` plus two comparisons, and `now` is a
 * parameter precisely so the bound is testable at the millisecond rather than by
 * waiting five minutes.
 *
 * ## The claims worth machine-checking
 *
 *  1. **The age bound is measured from the instant the query completed**, and both
 *     sides of it behave. A cache whose bound was off by a factor of a thousand, or
 *     which never expired at all, passes a test that only ever reads back what it
 *     just wrote — so the boundary is asserted at the millisecond either side.
 *  2. **A write to the row is a miss.** This is the half that makes a rotated
 *     credential list the subscription again, and it is the half a plausible
 *     implementation omits: an age-only cache is correct-looking, passes every
 *     round-trip test, and serves the previous credential's answer for five minutes
 *     after the credential changed.
 *  3. **The key is the row id alone**, so two subscriptions do not share an answer.
 *  4. **A stored payload cannot be mutated afterwards.** Without that, a caller
 *     holding the object it handed over edits what every later request receives.
 */

const ROW = "8f14e45f-ceea-467a-9d9f-b8a4c8e6f1c2"
const OTHER_ROW = "c9f0f895-fb98-4b17-a4f6-2a8e6f1c2d3e"

const UPDATED_AT = "2026-07-15T09:30:00.000Z"
const LATER_UPDATED_AT = "2026-07-15T09:31:00.000Z"
const EARLIER_UPDATED_AT = "2026-07-15T09:29:00.000Z"

const AT = Date.parse("2026-07-15T09:30:05.000Z")

function dimensions(
  overrides: Partial<InventoryDimensions> = {}
): InventoryDimensions {
  return {
    resource_types: {
      values: ["Microsoft.Compute/virtualMachines"],
      truncated: false,
    },
    resource_groups: { values: ["rg-prod-sea"], truncated: false },
    tag_keys: { values: ["env", "owner"], truncated: false },
    tag_values: { values: ["prod"], truncated: true },
    ...overrides,
  }
}

beforeEach(() => {
  clearInventoryCache()
})

describe("Requirement 9.2 — a listing is a hit for 300 seconds", () => {
  test("the declared window is 300 seconds", () => {
    // Pinned as a number rather than trusted from the name: the requirement says 300
    // seconds, and a module declaring 300 *milliseconds* would satisfy every relative
    // assertion below while caching nothing in practice.
    expect(INVENTORY_CACHE_TTL_MS).toBe(300_000)
  })

  test("a fresh entry reads back exactly what was stored", () => {
    const stored = dimensions()
    writeInventoryCache(ROW, UPDATED_AT, stored, AT)

    expect(readInventoryCache(ROW, UPDATED_AT, AT)).toEqual(stored)
  })

  test.each([
    ["at the instant it completed", 0, true],
    ["one millisecond inside the bound", INVENTORY_CACHE_TTL_MS - 1, true],
    ["exactly at the bound", INVENTORY_CACHE_TTL_MS, true],
    ["one millisecond past it", INVENTORY_CACHE_TTL_MS + 1, false],
    ["long past it", INVENTORY_CACHE_TTL_MS * 10, false],
  ])("%s is a hit: %s → %s", (_label, elapsed, expected) => {
    writeInventoryCache(ROW, UPDATED_AT, dimensions(), AT)

    expect(
      readInventoryCache(ROW, UPDATED_AT, AT + elapsed) !== undefined
    ).toBe(expected)
  })

  test("an entry that appears to come from the future is a miss", () => {
    // A backwards clock jump. Serving the entry would mean extending the window by
    // however far the clock moved, on the strength of an explanation nothing has.
    writeInventoryCache(ROW, UPDATED_AT, dimensions(), AT)

    expect(readInventoryCache(ROW, UPDATED_AT, AT - 1)).toBeUndefined()
  })

  test("an unknown row is a miss and no entry is invented for it", () => {
    expect(readInventoryCache(ROW, UPDATED_AT, AT)).toBeUndefined()
    expect(inventoryCacheEntryCount()).toBe(0)
  })
})

describe("Requirement 9.2 — a write to the row invalidates the entry", () => {
  test("the same updated_at within the window is a hit", () => {
    // The control for the two cases below: without it, an implementation that missed
    // unconditionally would satisfy both of them.
    writeInventoryCache(ROW, UPDATED_AT, dimensions(), AT)

    expect(readInventoryCache(ROW, UPDATED_AT, AT + 1000)).toBeDefined()
  })

  test("a later updated_at is a miss even one millisecond after the write", () => {
    // The rotated credential. The listing is one millisecond old and must not be
    // served, because the credential that produced it is not the one on the row.
    writeInventoryCache(ROW, UPDATED_AT, dimensions(), AT)

    expect(readInventoryCache(ROW, LATER_UPDATED_AT, AT + 1)).toBeUndefined()
  })

  test("an earlier updated_at is a miss too", () => {
    // Not "newer than" but "different from". A row whose `updated_at` moved backwards
    // is a row this process cannot explain, and a listing against it would be
    // trusting an explanation nobody has.
    writeInventoryCache(ROW, UPDATED_AT, dimensions(), AT)

    expect(readInventoryCache(ROW, EARLIER_UPDATED_AT, AT + 1)).toBeUndefined()
  })

  test("re-listing after an invalidation replaces the entry rather than adding one", () => {
    writeInventoryCache(ROW, UPDATED_AT, dimensions(), AT)
    const rotated = dimensions({
      resource_groups: { values: ["rg-prod-sea", "rg-dr"], truncated: false },
    })
    writeInventoryCache(ROW, LATER_UPDATED_AT, rotated, AT + 1)

    expect(inventoryCacheEntryCount()).toBe(1)
    expect(readInventoryCache(ROW, LATER_UPDATED_AT, AT + 1)).toEqual(rotated)
    // And the superseded row state does not resurrect the previous answer.
    expect(readInventoryCache(ROW, UPDATED_AT, AT + 1)).toBeUndefined()
  })
})

describe("Requirement 9.2 — the key is the row id alone", () => {
  test("two rows do not share one answer", () => {
    const mine = dimensions()
    const theirs = dimensions({
      resource_types: { values: ["Microsoft.Sql/servers"], truncated: false },
    })

    writeInventoryCache(ROW, UPDATED_AT, mine, AT)
    writeInventoryCache(OTHER_ROW, UPDATED_AT, theirs, AT)

    expect(readInventoryCache(ROW, UPDATED_AT, AT)).toEqual(mine)
    expect(readInventoryCache(OTHER_ROW, UPDATED_AT, AT)).toEqual(theirs)
    expect(inventoryCacheEntryCount()).toBe(2)
  })

  test("one row's entry is not reachable under another row's id", () => {
    writeInventoryCache(ROW, UPDATED_AT, dimensions(), AT)

    expect(readInventoryCache(OTHER_ROW, UPDATED_AT, AT)).toBeUndefined()
  })
})

describe("the stored payload is immutable and the four keys are the type's", () => {
  test("neither the payload nor a dimension nor its values can be mutated", () => {
    const stored = dimensions()
    writeInventoryCache(ROW, UPDATED_AT, stored, AT)

    const served = readInventoryCache(ROW, UPDATED_AT, AT)
    expect(served).toBeDefined()
    if (served === undefined) return

    // Frozen at all three levels. A caller that pushed onto `values` would be
    // editing what every later request receives, and the failure would surface as a
    // wrong option list rather than as an error at the mutation.
    expect(Object.isFrozen(served)).toBe(true)
    for (const key of INVENTORY_DIMENSION_KEYS) {
      expect(Object.isFrozen(served[key])).toBe(true)
      expect(Object.isFrozen(served[key].values)).toBe(true)
    }
    expect(() => {
      ;(served.tag_keys.values as string[]).push("leaked")
    }).toThrow(TypeError)
    expect(readInventoryCache(ROW, UPDATED_AT, AT)?.tag_keys.values).toEqual([
      "env",
      "owner",
    ])
  })

  test("the declared key list is exactly the four dimensions", () => {
    // The list is what the freeze loop walks, so a key missing from it would leave
    // that dimension mutable while every assertion above still passed.
    expect([...INVENTORY_DIMENSION_KEYS].sort()).toEqual([
      "resource_groups",
      "resource_types",
      "tag_keys",
      "tag_values",
    ])
    expect(Object.keys(dimensions()).sort()).toEqual(
      [...INVENTORY_DIMENSION_KEYS].sort()
    )
  })

  test("clearInventoryCache empties the map", () => {
    writeInventoryCache(ROW, UPDATED_AT, dimensions(), AT)
    expect(inventoryCacheEntryCount()).toBe(1)

    clearInventoryCache()

    expect(inventoryCacheEntryCount()).toBe(0)
    expect(readInventoryCache(ROW, UPDATED_AT, AT)).toBeUndefined()
  })
})
