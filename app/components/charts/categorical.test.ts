import { describe, expect, test } from "vitest"

import {
  assignSeries,
  styleForKey,
  styleForSlot,
} from "@/components/charts/categorical"
import {
  CAT_OTHER,
  CATEGORICAL_PLOTTED_LIMIT,
  CATEGORICAL_TOKENS,
  slotForKey,
} from "@/components/charts/palette"

/**
 * The series-style pairing (Requirements 22.8, 22.9, 22.11).
 *
 * The **assignment** is `palette.ts`'s and is tested there against
 * `chartstyle.py`. What is tested here is the pairing: that a slot becomes a
 * token *and* a marker *and* a dash, that the aggregate slot is the fifth, and
 * that the three channels never collapse into one.
 */

describe("Requirement 22.11 — colour follows the key, not the position", () => {
  test("the same key gets the same style however the set is ordered", () => {
    // The invariant the whole module exists for: a resource keeps its colour
    // between two charts that plot different subsets of the report's series.
    const cpu = assignSeries(["web-01", "web-02", "db-01"])
    const memory = assignSeries(["db-01", "web-01"])

    expect(memory.get("web-01")).toEqual(cpu.get("web-01"))
    expect(memory.get("db-01")).toEqual(cpu.get("db-01"))
  })

  test("the style is a pure function of the key alone", () => {
    // Not of the set it appears in. `assignSeries` is a convenience over
    // `styleForKey`, and this is what stops it becoming an index lookup.
    expect(assignSeries(["a", "b", "c"]).get("b")).toEqual(styleForKey("b"))
    expect(assignSeries(["b"]).get("b")).toEqual(styleForKey("b"))
  })

  test("it composes the shared slot assignment rather than a second one", () => {
    // The guard against the bug this file was rewritten to remove: a private
    // sort-and-index here would disagree with `chartstyle.py`, and the two
    // charts would silently use different colours for one resource.
    for (const key of ["web-01", "db-01", "Microsoft.Compute/virtualMachines"]) {
      expect(styleForKey(key)).toEqual(styleForSlot(slotForKey(key)))
    }
  })
})

describe("Requirement 22.8 — never colour alone", () => {
  test("every slot carries a distinct marker and dash as well as a token", () => {
    const styles = CATEGORICAL_TOKENS.map((_, slot) => styleForSlot(slot))

    expect(new Set(styles.map((style) => style.marker)).size).toBe(styles.length)
    expect(new Set(styles.map((style) => style.dash)).size).toBe(styles.length)
  })

  test("the aggregate slot is distinguishable without colour", () => {
    // `Other` and the fourth series differ in marker and dash, not only in hue —
    // which is what makes them tellable apart in greyscale.
    const fourth = styleForSlot(CATEGORICAL_PLOTTED_LIMIT - 1)
    const other = styleForSlot(CATEGORICAL_PLOTTED_LIMIT)

    expect(other.marker).not.toBe(fourth.marker)
    expect(other.dash).not.toBe(fourth.dash)
  })
})

describe("Requirement 22.9 — four plotted, one aggregate", () => {
  test("slots below the plotted limit are not aggregate", () => {
    for (let slot = 0; slot < CATEGORICAL_PLOTTED_LIMIT; slot += 1) {
      expect(styleForSlot(slot).aggregate, `slot ${slot}`).toBe(false)
      expect(styleForSlot(slot).token).toBe(CATEGORICAL_TOKENS[slot])
    }
  })

  test("the fifth slot is the aggregate token", () => {
    expect(styleForSlot(CATEGORICAL_PLOTTED_LIMIT).aggregate).toBe(true)
    expect(styleForSlot(CATEGORICAL_PLOTTED_LIMIT).token).toBe(CAT_OTHER)
  })

  test("a slot beyond the palette clamps to the aggregate rather than wrapping", () => {
    // Wrapping would give the sixth series the first series' colour, which is
    // worse than the aggregate: two different resources, one hue, no signal that
    // they were ever different.
    expect(styleForSlot(99).token).toBe(CAT_OTHER)
    expect(styleForSlot(-1).token).toBe(CATEGORICAL_TOKENS[0])
  })
})

describe("tokens are custom-property names, never resolved colours", () => {
  test("no style carries a hex or an oklch literal", () => {
    // A baked value would stay light-mode teal on a dark page: `globals.css`
    // redefines every `--cat-*` under the dark scheme, and a chart follows the
    // viewer's theme only by referencing the property.
    for (let slot = 0; slot < 6; slot += 1) {
      expect(styleForSlot(slot).token).toMatch(/^--/)
    }
  })
})
