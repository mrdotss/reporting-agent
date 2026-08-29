import { describe, expect, test } from "vitest"

import { resolveRevisionAuthor } from "@/lib/actions/runs"

/**
 * `resolveRevisionAuthor` (task 2.3).
 *
 * A pure unit test, for the reason `customer-name-resolution.test.ts` gives for
 * its own subject: `enqueueRun` around this function is only reachable against a
 * real Postgres, so this is the seam where the decision itself can be checked.
 *
 * ## Why the revision is derived at all
 *
 * Requirements line 1057 — *a re-run of one period is a revision of one document
 * rather than a second document*. Two runs of July carry the same document number
 * and the revision row is the only thing telling them apart, which makes it a fact
 * about the account's history rather than a field. Asking for it produced a "1.0"
 * typed on every run forever; `countRunsForProfilePeriod` supplies the number, and
 * this supplies the name beside it.
 */

describe("the author comes from the profile's own signatories", () => {
  test("reads the Author signatory, not the first approver", () => {
    expect(
      resolveRevisionAuthor({
        front_matter: {
          document_control: {
            approvers: [
              { role: "reviewer", name: "Muhammad Lugina" },
              { role: "author", name: "Mayer Reflino Sitorus" },
            ],
          },
        },
      })
    ).toBe("Mayer Reflino Sitorus")
  })

  test("it is the same value the signature table prints", () => {
    // One list, read twice — so the name on the revision row and the name in the
    // signature table cannot disagree about who issued the document.
    const approvers = [{ role: "author", name: "  Mayer Reflino Sitorus  " }]
    expect(
      resolveRevisionAuthor({ front_matter: { document_control: { approvers } } })
    ).toBe("Mayer Reflino Sitorus")
  })

  test("is empty rather than guessing when no author is named", () => {
    // The renderer omits an empty author. Substituting the reviewer, or the
    // signed-in user, would put a name on a revision row nobody assigned.
    expect(
      resolveRevisionAuthor({
        front_matter: {
          document_control: { approvers: [{ role: "reviewer", name: "X" }] },
        },
      })
    ).toBe("")
  })
})

describe("it survives every shape a stored definition can hold", () => {
  // `front_matter` is typed `unknown` on a definition, and this runs against
  // whatever a stored version happens to carry — including one authored before
  // approvers existed.
  const shapes: readonly unknown[] = [
    {},
    { front_matter: null },
    { front_matter: "not an object" },
    { front_matter: {} },
    { front_matter: { document_control: null } },
    { front_matter: { document_control: {} } },
    { front_matter: { document_control: { approvers: "not a list" } } },
    { front_matter: { document_control: { approvers: [null, 7, "x"] } } },
    { front_matter: { document_control: { approvers: [{ role: "author" }] } } },
    { front_matter: { document_control: { approvers: [{ role: "author", name: 42 }] } } },
  ]

  test.each(shapes.map((shape, index) => [index, shape] as const))(
    "shape %i resolves to the empty string rather than throwing",
    (_index, shape) => {
      expect(
        resolveRevisionAuthor(shape as { front_matter?: unknown })
      ).toBe("")
    }
  )
})
