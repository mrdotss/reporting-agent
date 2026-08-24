import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import type { VerificationView } from "@/lib/db/views"

import { VerificationPanel } from "@/components/reports/verification-panel"

/**
 * Requirement 21 — the verification panel fits its box.
 *
 * ## Why no width assertion
 *
 * The app test environment (jsdom) performs no layout and reports every element
 * width as zero. A width assertion there reports a pass for a panel presenting
 * all 64 characters — which is exactly the failure it exists to catch. So
 * instead of asserting element widths, we assert the **text content length** of
 * each digest/seed presentation and the accessibility contract that the full
 * value is reachable through the copy control's `aria-label`.
 */

afterEach(cleanup)

/** Generate a 64-character hex string from a repeating pattern. */
function hex64(pattern: string): string {
  return pattern.repeat(Math.ceil(64 / pattern.length)).slice(0, 64)
}

function view(over: Partial<VerificationView> = {}): VerificationView {
  return {
    id: "ver-dom-1",
    status: "pass",
    figureCount: 1480,
    snapshotSha256: hex64("9f2c"),
    docxSha256: hex64("a1b2"),
    pdfSha256: hex64("c3d4"),
    replay: {
      possible: true,
      recomputedSha256: hex64("9f2c"),
      storedSha256: hex64("9f2c"),
      objectsFolded: 12,
      objectsNamed: 12,
    },
    driftSample: {
      n: 25,
      method: "stratified",
      seed: hex64("e5f6"),
      notRequeried: [],
    },
    blockingFindings: [],
    advisoryFindings: [],
    counts: { blocking: 0, advisory: 0 },
    createdAt: "2026-08-01T00:00:00.000Z",
    textFactCount: 0,
    historicalPoints: [],
    ...over,
  } as VerificationView
}

describe("Requirement 21.1–21.3 — truncation through CopyDigest", () => {
  test("a 64-character seed presents at most 12 characters of text", () => {
    const seed = hex64("e5f6")
    render(<VerificationPanel verification={view({ driftSample: { n: 25, method: "stratified", seed, notRequeried: [] } })} />)

    // The CopyDigest control renders a truncated span + a copy button.
    // Find by aria-label which contains the full value.
    const button = screen.getByLabelText(`Copy the drift sample seed: ${seed}`)
    // The sibling text span contains the truncated visible text.
    const wrapper = button.closest("[data-slot='copy-digest']")
    expect(wrapper).not.toBeNull()

    // The visible text span is the first child span with font-mono class
    const visibleSpan = wrapper!.querySelector("span.font-mono")
    expect(visibleSpan).not.toBeNull()
    expect(visibleSpan!.textContent!.length).toBeLessThanOrEqual(12)
  })

  test("a 64-character snapshot digest presents at most 12 characters of text", () => {
    const digest = hex64("9f2c")
    render(<VerificationPanel verification={view({ snapshotSha256: digest })} />)

    // Multiple CopyDigests exist for snapshot; find by the label in the digests dl
    const buttons = screen.getAllByLabelText(`Copy the snapshot digest: ${digest}`)
    expect(buttons.length).toBeGreaterThanOrEqual(1)

    for (const button of buttons) {
      const wrapper = button.closest("[data-slot='copy-digest']")
      expect(wrapper).not.toBeNull()
      const visibleSpan = wrapper!.querySelector("span.font-mono")
      expect(visibleSpan).not.toBeNull()
      expect(visibleSpan!.textContent!.length).toBeLessThanOrEqual(12)
    }
  })

  test("a 64-character docx digest presents at most 12 characters of text", () => {
    const digest = hex64("a1b2")
    render(<VerificationPanel verification={view({ docxSha256: digest })} />)

    const button = screen.getByLabelText(`Copy the docx digest: ${digest}`)
    const wrapper = button.closest("[data-slot='copy-digest']")
    expect(wrapper).not.toBeNull()
    const visibleSpan = wrapper!.querySelector("span.font-mono")
    expect(visibleSpan).not.toBeNull()
    expect(visibleSpan!.textContent!.length).toBeLessThanOrEqual(12)
  })

  test("a 64-character pdf digest presents at most 12 characters of text", () => {
    const digest = hex64("c3d4")
    render(<VerificationPanel verification={view({ pdfSha256: digest })} />)

    const button = screen.getByLabelText(`Copy the pdf digest: ${digest}`)
    const wrapper = button.closest("[data-slot='copy-digest']")
    expect(wrapper).not.toBeNull()
    const visibleSpan = wrapper!.querySelector("span.font-mono")
    expect(visibleSpan).not.toBeNull()
    expect(visibleSpan!.textContent!.length).toBeLessThanOrEqual(12)
  })
})

describe("Requirement 21.3 — the complete recorded string is reachable through the copy control's accessible name", () => {
  test("the seed's full value is in its copy control's aria-label", () => {
    const seed = hex64("e5f6")
    render(<VerificationPanel verification={view({ driftSample: { n: 25, method: "stratified", seed, notRequeried: [] } })} />)

    const button = screen.getByLabelText(`Copy the drift sample seed: ${seed}`)
    expect(button).toBeTruthy()
    expect(button.getAttribute("aria-label")).toContain(seed)
  })

  test("the snapshot digest's full value is in its copy control's aria-label", () => {
    const digest = hex64("9f2c")
    render(<VerificationPanel verification={view({ snapshotSha256: digest })} />)

    const buttons = screen.getAllByLabelText(`Copy the snapshot digest: ${digest}`)
    expect(buttons.length).toBeGreaterThanOrEqual(1)
    for (const button of buttons) {
      expect(button.getAttribute("aria-label")).toContain(digest)
    }
  })

  test("the docx digest's full value is in its copy control's aria-label", () => {
    const digest = hex64("a1b2")
    render(<VerificationPanel verification={view({ docxSha256: digest })} />)

    const button = screen.getByLabelText(`Copy the docx digest: ${digest}`)
    expect(button.getAttribute("aria-label")).toContain(digest)
  })

  test("the pdf digest's full value is in its copy control's aria-label", () => {
    const digest = hex64("c3d4")
    render(<VerificationPanel verification={view({ pdfSha256: digest })} />)

    const button = screen.getByLabelText(`Copy the pdf digest: ${digest}`)
    expect(button.getAttribute("aria-label")).toContain(digest)
  })
})

describe("Requirement 21.9 — explicit statement when no drift sample or no seed", () => {
  test("no drift sample (n=0, empty seed) says no drift sample was recorded", () => {
    const { container } = render(
      <VerificationPanel
        verification={view({
          driftSample: { n: 0, method: "", seed: "", notRequeried: [] },
        })}
      />
    )

    expect(container.textContent).toMatch(
      /no drift sample was recorded/i
    )
  })

  test("a drift sample carrying no seed says no seed was recorded", () => {
    const { container } = render(
      <VerificationPanel
        verification={view({
          driftSample: { n: 25, method: "stratified", seed: "", notRequeried: [] },
        })}
      />
    )

    expect(container.textContent).toMatch(
      /no drift sample seed was recorded/i
    )
  })
})

describe("Requirement 21.5 — no width assertion used", () => {
  /**
   * This test documents WHY no element width assertion is used:
   * jsdom performs no layout and reports every element width as zero.
   * A width assertion would pass vacuously for a panel displaying all
   * 64 characters, which is the exact failure it would exist to catch.
   *
   * Instead, the truncation assertions above verify the TEXT CONTENT length
   * is at most 12 characters, which is the meaningful equivalent without
   * depending on layout.
   */
  test("confirms jsdom reports zero width (documenting the constraint)", () => {
    const { container } = render(<VerificationPanel verification={view()} />)
    const digest = container.querySelector("[data-slot='copy-digest'] span.font-mono")
    expect(digest).not.toBeNull()
    // jsdom always reports 0 — this assertion documents the constraint
    expect(digest!.getBoundingClientRect().width).toBe(0)
  })
})

describe("Requirement 21.7 — values derived from the stored row", () => {
  test("the panel takes a VerificationView prop (stored row) and not events", () => {
    // This test asserts the component's prop type contract:
    // VerificationPanel receives a VerificationView (the stored row projection)
    // and has no event subscription at all.
    const v = view()
    const { container } = render(<VerificationPanel verification={v} />)
    // If it renders from the stored row, the snapshot sha256 appears truncated
    // via CopyDigest with the row's value as its aria-label
    const button = screen.getAllByLabelText(
      `Copy the snapshot digest: ${v.snapshotSha256}`
    )
    expect(button.length).toBeGreaterThanOrEqual(1)
    // The panel's data-status reflects the stored row's status
    const section = container.querySelector("[data-slot='verification-panel']")
    expect(section?.getAttribute("data-status")).toBe("pass")
  })
})
