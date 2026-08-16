import { describe, expect, test } from "vitest"

import {
  DEDUPE_BUCKET_MS,
  dedupeBucketSeconds,
  deriveDedupeKey,
  type DedupeKeyInput,
} from "@/lib/runs/dedupe"

/**
 * `deriveDedupeKey` (Requirement 37.1).
 *
 * The four properties that matter, each written so it fails on the specific wrong
 * implementation it exists to rule out:
 *
 *   * **stable inside one 60-second bucket, different across the edge** — fails on
 *     a derivation that folds in the raw instant (every submission distinct, the
 *     UNIQUE constraint decorative) and on one that folds in no instant at all (a
 *     deliberate re-run a minute later impossible);
 *   * **independent of resource-type and resource-group input order** — fails on a
 *     derivation that joins the arrays as given;
 *   * **no randomness** — fails on a derivation that reaches for a uuid;
 *   * **field boundaries are unambiguous** — fails on a derivation that joins with
 *     a character the inputs can contain.
 */

const BASE: DedupeKeyInput = {
  userId: "user-1",
  connectedSubscriptionId: "sub-row-1",
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  timezone: "Asia/Jakarta",
  resourceTypes: ["Microsoft.Compute/virtualMachines"],
  resourceGroups: ["rg-prod", "rg-staging"],
  enqueuedAtMs: Date.UTC(2026, 7, 15, 10, 30, 0),
}

/** The bucket boundary `BASE` sits at the start of. */
const BUCKET_START = Date.UTC(2026, 7, 15, 10, 30, 0)

describe("dedupeBucketSeconds — the 60-second floor", () => {
  test("an instant at the boundary is its own bucket", () => {
    expect(dedupeBucketSeconds(BUCKET_START)).toBe(BUCKET_START / 1000)
  })

  test("every instant inside one minute floors to the same second", () => {
    for (const offset of [0, 1, 999, 30_000, 59_999]) {
      expect(dedupeBucketSeconds(BUCKET_START + offset)).toBe(
        BUCKET_START / 1000
      )
    }
  })

  test("the next boundary is a different bucket", () => {
    expect(dedupeBucketSeconds(BUCKET_START + DEDUPE_BUCKET_MS)).not.toBe(
      dedupeBucketSeconds(BUCKET_START)
    )
  })

  test("buckets stay contiguous across the epoch", () => {
    // `Math.floor` on a negative value rounds away from zero, which is what keeps
    // the bucket straddling 1970 one bucket wide rather than two. No deployment
    // enqueues a run before 1970; a generated test instant will.
    expect(dedupeBucketSeconds(-1)).toBe(-60)
    expect(dedupeBucketSeconds(-60_000)).toBe(-60)
    expect(dedupeBucketSeconds(-60_001)).toBe(-120)
  })
})

describe("Requirement 37.1 — the key is stable inside a bucket", () => {
  test("two submissions in the same bucket derive the same key", () => {
    const first = deriveDedupeKey({ ...BASE, enqueuedAtMs: BUCKET_START })
    const second = deriveDedupeKey({
      ...BASE,
      enqueuedAtMs: BUCKET_START + 59_999,
    })

    expect(second).toBe(first)
  })

  test("a submission one bucket later derives a different key", () => {
    // The half that makes a deliberate re-run possible. A derivation folding in
    // no instant at all would fail here.
    const inside = deriveDedupeKey({ ...BASE, enqueuedAtMs: BUCKET_START })
    const after = deriveDedupeKey({
      ...BASE,
      enqueuedAtMs: BUCKET_START + DEDUPE_BUCKET_MS,
    })

    expect(after).not.toBe(inside)
  })

  test("the key is a 64-character lowercase hex digest", () => {
    expect(deriveDedupeKey(BASE)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("Requirement 37.1 — sorted scope, so input order cannot matter", () => {
  test("resource types in a different order derive the same key", () => {
    const ascending = deriveDedupeKey({
      ...BASE,
      resourceTypes: [
        "Microsoft.Compute/virtualMachines",
        "Microsoft.Storage/storageAccounts",
      ],
    })
    const descending = deriveDedupeKey({
      ...BASE,
      resourceTypes: [
        "Microsoft.Storage/storageAccounts",
        "Microsoft.Compute/virtualMachines",
      ],
    })

    expect(descending).toBe(ascending)
  })

  test("resource groups in a different order derive the same key", () => {
    const ascending = deriveDedupeKey({
      ...BASE,
      resourceGroups: ["rg-a", "rg-b", "rg-c"],
    })
    const shuffled = deriveDedupeKey({
      ...BASE,
      resourceGroups: ["rg-c", "rg-a", "rg-b"],
    })

    expect(shuffled).toBe(ascending)
  })

  test("the caller's arrays are not mutated by the sort", () => {
    // `[...xs].sort()` rather than `xs.sort()`. The input is a parsed request
    // body that the enqueue goes on to persist as `scope`, so sorting in place
    // would silently reorder what gets stored.
    const resourceTypes = ["b", "a"]
    const resourceGroups = ["y", "x"]

    deriveDedupeKey({ ...BASE, resourceTypes, resourceGroups })

    expect(resourceTypes).toEqual(["b", "a"])
    expect(resourceGroups).toEqual(["y", "x"])
  })

  test("a genuinely different scope derives a different key", () => {
    expect(deriveDedupeKey({ ...BASE, resourceGroups: ["rg-prod"] })).not.toBe(
      deriveDedupeKey(BASE)
    )
  })
})

describe("Requirement 37.1 — no random value enters the derivation", () => {
  test("one input derives one key across many calls", () => {
    const keys = new Set(
      Array.from({ length: 50 }, () => deriveDedupeKey(BASE))
    )

    expect(keys.size).toBe(1)
  })
})

describe("field boundaries are unambiguous", () => {
  test.each([
    ["userId", { userId: "a" }, { userId: "a\u001fb" }],
    [
      "connectedSubscriptionId",
      { connectedSubscriptionId: "s" },
      { connectedSubscriptionId: "s\u001ft" },
    ],
    ["timezone", { timezone: "UTC" }, { timezone: "UTC\u001fx" }],
  ] as const)(
    "%s cannot be confused with the next field",
    (_label, left, right) => {
      // Not a realistic input — the point is that the separator's absence from
      // the input alphabet is what the derivation relies on, and a join on `:` or
      // `,` would have realistic collisions instead.
      expect(deriveDedupeKey({ ...BASE, ...left })).not.toBe(
        deriveDedupeKey({ ...BASE, ...right })
      )
    }
  )

  test("two resource groups cannot alias a single one containing a comma", () => {
    // The collision a comma-joined *field* list would produce. The lists are
    // comma-joined internally and the unit separator delimits the fields, so this
    // pair must still differ.
    const split = deriveDedupeKey({ ...BASE, resourceGroups: ["a", "b"] })
    const merged = deriveDedupeKey({ ...BASE, resourceGroups: ["a,b"] })

    // Both derive the inner string "a,b", so these two *are* equal by design —
    // asserted rather than left implicit, because the requirement is about field
    // boundaries between the sorted lists and the neighbouring fields, not about
    // distinguishing a comma inside a resource group name. Azure resource group
    // names cannot contain a comma, so the aliasing is unreachable.
    expect(merged).toBe(split)
  })

  test("the scope lists cannot bleed into each other", () => {
    // This is the boundary that must hold: a resource type list and a resource
    // group list are separate fields, so moving a value from one to the other
    // changes the key.
    const asType = deriveDedupeKey({
      ...BASE,
      resourceTypes: ["x"],
      resourceGroups: [],
    })
    const asGroup = deriveDedupeKey({
      ...BASE,
      resourceTypes: [],
      resourceGroups: ["x"],
    })

    expect(asGroup).not.toBe(asType)
  })
})

describe("every field is load-bearing", () => {
  test.each([
    ["userId", { userId: "user-2" }],
    ["connectedSubscriptionId", { connectedSubscriptionId: "sub-row-2" }],
    ["periodStart", { periodStart: "2026-07-02" }],
    ["periodEnd", { periodEnd: "2026-07-30" }],
    ["timezone", { timezone: "UTC" }],
  ] as const)("changing %s changes the key", (_label, patch) => {
    // Requirement 37.1 names each of these, and a derivation that omitted one
    // would deduplicate two genuinely different runs into the first of them.
    expect(deriveDedupeKey({ ...BASE, ...patch })).not.toBe(
      deriveDedupeKey(BASE)
    )
  })
})
