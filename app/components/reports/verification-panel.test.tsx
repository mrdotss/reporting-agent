import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import type { VerificationView } from "@/lib/db/views"

import { VerificationPanel } from "./verification-panel"

/**
 * The verification panel (Requirement 39).
 *
 * ## The assertion this file exists for
 *
 * **`--destructive` carries one meaning.** Requirement 39.6 reserves it for the
 * verification-failure state and hard errors, and forbids it on gaps, advisory
 * findings, fidelity badges, utilization values and negative deltas. The scan
 * below walks every rendered class name rather than checking the root, so it
 * holds for a nested element somebody adds later.
 *
 * The second is Requirement 39.10: an unrecognized finding type is still
 * presented, still classified as the result classified it, and still counted. A
 * panel that switched over known types would under-report the day the agent
 * learned a new blocking check — and the under-reported number is the one a
 * consultant reads as "how much is wrong".
 */

afterEach(cleanup)

/**
 * The panel's visible text, with whitespace collapsed.
 *
 * Several statements here are deliberately built from inline elements — the
 * digest's copy control sits inside the pass sentence, and "not delivered" is a
 * `<strong>` inside the failure sentence — so `getByText` on the whole phrase
 * finds no single node. Asserting on the flattened text is asserting what a
 * reader actually sees, which is the claim these tests are making anyway.
 */
function visibleText(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ")
}

/** Every class name in the tree, so a nested element cannot slip past. */
function classNames(container: HTMLElement): string {
  return [...container.querySelectorAll<HTMLElement>("*")]
    .map((node) => node.className)
    .join(" ")
}

function view(over: Partial<VerificationView> = {}): VerificationView {
  return {
    id: "ver-1",
    status: "pass",
    figureCount: 1480,
    snapshotSha256: "9f2c".repeat(16),
    docxSha256: "a1b2".repeat(16),
    pdfSha256: "c3d4".repeat(16),
    replay: {
      possible: true,
      recomputedSha256: "9f2c".repeat(16),
      storedSha256: "9f2c".repeat(16),
      objectsFolded: 12,
      objectsNamed: 12,
    },
    driftSample: {
      n: 25,
      method: "stratified",
      seed: "abc123",
      notRequeried: [],
    },
    blockingFindings: [],
    advisoryFindings: [],
    counts: { blocking: 0, advisory: 0 },
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as VerificationView
}

describe("Requirement 39.2 — success is quiet", () => {
  test("a pass states the count and the snapshot as one statement", () => {
    const { container } = render(<VerificationPanel verification={view()} />)

    expect(visibleText(container)).toMatch(
      /1,480 figures · every figure traced to snapshot/i
    )
  })

  test("a pass uses no destructive token anywhere", () => {
    const { container } = render(<VerificationPanel verification={view()} />)

    expect(classNames(container)).not.toContain("destructive")
  })

  test("a pass is announced politely, never assertively", () => {
    const { container } = render(<VerificationPanel verification={view()} />)
    const live = container.querySelector("[aria-live]")

    expect(live?.getAttribute("aria-live")).toBe("polite")
    expect(container.querySelector("[role='alert']")).toBeNull()
  })
})

describe("Requirement 39.3 — failure is loud and specific", () => {
  const failed = view({
    status: "fail",
    blockingFindings: [
      {
        type: "table_cell_mismatch",
        severity: "blocking",
        message: "The cell does not carry the ledger's string.",
        tableId: "resources",
        rowKey: "web-01",
        columnKey: "CPU avg",
        expected: "64.20%",
        observed: "46.20%",
      },
    ],
    counts: { blocking: 1, advisory: 0 },
  })

  test("it states the report was not delivered", () => {
    const { container } = render(<VerificationPanel verification={failed} />)

    expect(visibleText(container)).toMatch(/not delivered/i)
  })

  test("every locating field the finding recorded is presented", () => {
    render(<VerificationPanel verification={failed} />)

    // Requirement 39.3 names the table identity with its row and column key, and
    // the expected and observed strings. Two bare strings side by side are a
    // puzzle; the labels are what make them legible.
    for (const value of [
      "resources",
      "web-01",
      "CPU avg",
      "64.20%",
      "46.20%",
    ]) {
      expect(screen.getByText(value), value).toBeTruthy()
    }
  })

  test("the blocking count is in the same announcement as the status", () => {
    // Requirement 39.7 — one announcement. Two would mean a screen-reader user
    // can hear the count without the status, or the status without the count.
    const { container } = render(<VerificationPanel verification={failed} />)
    const live = container.querySelector("[aria-live='polite']")

    expect(live?.textContent).toMatch(/failed/i)
    expect(live?.textContent).toMatch(/1 blocking finding/i)
  })
})

describe("Requirement 39.10 — an unrecognized finding type is still presented", () => {
  test("its type string and locating fields are shown, and it is counted", () => {
    // The type below does not exist in this build. A panel that switched over
    // known types would drop it, and the count a consultant reads would be wrong
    // in the direction that matters.
    const { container } = render(
      <VerificationPanel
        verification={view({
          status: "fail",
          blockingFindings: [
            {
              type: "a_check_this_build_has_never_heard_of",
              severity: "blocking",
              astPath: "b3:0.1",
              message: "Something new failed.",
            },
          ],
          counts: { blocking: 1, advisory: 0 },
        })}
      />
    )

    expect(
      screen.getByText("a_check_this_build_has_never_heard_of")
    ).toBeTruthy()
    expect(screen.getByText("b3:0.1")).toBeTruthy()
    expect(
      container.querySelector("[data-slot='blocking-findings']")?.children
    ).toHaveLength(1)
  })
})

describe("Requirement 39.5 — advisory findings are separate and not destructive", () => {
  test("they are in their own labelled region", () => {
    render(
      <VerificationPanel
        verification={view({
          advisoryFindings: [
            {
              type: "drift_observed",
              severity: "advisory",
              message: "A drift.",
            },
          ],
          counts: { blocking: 0, advisory: 1 },
        })}
      />
    )

    expect(screen.getByText(/advisory findings/i)).toBeTruthy()
    expect(screen.getByText(/none of these affected/i)).toBeTruthy()
  })

  test("an advisory finding on a passing run adds no destructive token", () => {
    // Requirement 39.6 — the token means "this document could not be proven",
    // and an advisory finding is explicitly not that.
    const { container } = render(
      <VerificationPanel
        verification={view({
          advisoryFindings: [
            {
              type: "drift_observed",
              severity: "advisory",
              message: "A drift.",
            },
          ],
          counts: { blocking: 0, advisory: 1 },
        })}
      />
    )

    expect(classNames(container)).not.toContain("destructive")
  })
})

describe("Requirement 39.4 — replay reports three outcomes, not two", () => {
  test("an impossible replay is stated as impossible", () => {
    // Not a pass and not a failure. Reporting either would be a false claim
    // about what was checked.
    render(
      <VerificationPanel
        verification={view({
          replay: { possible: false, objectsFolded: 0, objectsNamed: 0 },
        })}
      />
    )

    expect(screen.getByText(/not possible for this run/i)).toBeTruthy()
  })

  test("a possible replay reports both digests and the fold count", () => {
    render(<VerificationPanel verification={view()} />)

    expect(screen.getByText(/re-folded/i)).toBeTruthy()
    expect(screen.getByText(/recomputed/i)).toBeTruthy()
  })
})

describe("Requirement 39.8 — no verification is not a failure", () => {
  test("an absent verification says the report is not verified", () => {
    render(<VerificationPanel verification={null} />)

    expect(screen.getByText(/not verified/i)).toBeTruthy()
  })

  test("it presents no pass statement and no digest as proven", () => {
    render(<VerificationPanel verification={null} />)

    expect(screen.queryByText(/every figure traced/i)).toBeNull()
  })

  test("it is styled in mist neutrals rather than destructive", () => {
    // A run that is still verifying must not look like a run that was refused.
    const { container } = render(<VerificationPanel verification={null} />)

    expect(classNames(container)).not.toContain("destructive")
  })
})
