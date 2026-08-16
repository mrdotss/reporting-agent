import { describe, expect, test } from "vitest"

import {
  SUBSCRIPTION_ID_MASK_CHAR,
  SUBSCRIPTION_ID_VISIBLE_CHARS,
  maskSubscriptionId,
} from "@/lib/validation/mask"
import { maskSubscriptionId as maskViaViews } from "@/lib/db/views"
import { maskSubscriptionId as maskViaBarrel } from "@/lib/validation"

/**
 * `lib/validation/mask.ts` — Requirement 10.4, at the five lengths the spec
 * names.
 *
 * **Scoped deliberately narrow, because this function is already tested.**
 * `lib/db/views.test.ts` is the Projection_Guard: it exercises the same lengths,
 * surrogate pairs, and a generated sweep asserting at most four code points
 * survive — but it reaches the function through `@/lib/db/views`, which
 * re-exports it. That leaves two things unasserted, and they are all this file
 * adds:
 *
 *  1. the five named lengths hold against the **implementing** module, so
 *     `mask.ts` stays covered even if `views.ts` stopped re-exporting it;
 *  2. the re-exports are the **same function**, not a second implementation.
 *     Requirement 10.4's short-id clause is the kind of rule that gets
 *     re-derived as a `slice(-4)` in a component that formats an id for display,
 *     and a second implementation is how "all but the last 4" comes to mean two
 *     different things in one product.
 *
 * The generated sweep is not repeated here. Duplicating it would double the
 * runtime and halve the chance that a real failure is read rather than skimmed.
 */

/** Hard-coded, so the assertions do not restate the module's own constants. */
const MASK = "*"
const VISIBLE = 4

/** A real Azure subscription GUID: 36 characters, 32 of them masked. */
const GUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"

describe("maskSubscriptionId — Requirement 10.4", () => {
  test("the mask character and the revealed window are what the guard assumes", () => {
    expect(SUBSCRIPTION_ID_MASK_CHAR).toBe(MASK)
    expect(SUBSCRIPTION_ID_VISIBLE_CHARS).toBe(VISIBLE)
    // Not a character a GUID can contain, and not `-`, which one does — a
    // revealed separator would read as revealed content.
    expect(GUID).not.toContain(MASK)
  })

  test.each([
    { length: 0, id: "", expected: "" },
    { length: 1, id: "7", expected: "*" },
    { length: 4, id: "3301", expected: "****" },
    { length: 5, id: "a3301", expected: "*3301" },
    { length: 36, id: GUID, expected: `${MASK.repeat(32)}3301` },
  ])("length $length masks to $expected", ({ id, expected, length }) => {
    const masked = maskSubscriptionId(id)

    expect(masked).toBe(expected)
    // Code-point length is preserved, so a masked id discloses neither a
    // shorter nor a longer id than the real one.
    expect(Array.from(masked)).toHaveLength(length)
    expect(Array.from(id)).toHaveLength(length)
  })

  test.each([0, 1, 2, 3, 4])(
    "every character of a %i-character id is masked",
    (length) => {
      // The clause an "all but the last 4" implementation gets wrong: at four
      // characters it would publish the id whole, and at one character too.
      const id = GUID.slice(0, length)
      const masked = maskSubscriptionId(id)

      expect(masked).toBe(MASK.repeat(length))
      for (const character of Array.from(id)) {
        expect(masked).not.toContain(character)
      }
    }
  )

  test("at 36 characters exactly the final four survive", () => {
    const masked = maskSubscriptionId(GUID)
    const revealed = Array.from(masked).filter(
      (character) => character !== MASK
    )

    expect(revealed.join("")).toBe("3301")
    expect(revealed).toHaveLength(VISIBLE)
    expect(masked.slice(0, -VISIBLE)).toBe(MASK.repeat(32))
    expect(masked).not.toBe(GUID)
  })

  test("the projection and the barrel re-export this exact function", () => {
    // Identity, not equivalence. Two implementations that agree today are two
    // implementations, and only one of them gets fixed.
    expect(maskViaViews).toBe(maskSubscriptionId)
    expect(maskViaBarrel).toBe(maskSubscriptionId)
  })
})
