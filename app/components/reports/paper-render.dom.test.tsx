import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { PaperRender } from "./paper-render"

/**
 * The report reading view (Requirements 14.2, 14.3, 14.6, 38.5, 38.6).
 *
 * ## The assertions this file exists for
 *
 * **The preview label is permanent** — on every render, behind no disclosure,
 * with no dismiss control. A label a reader can close is a label a reader will
 * close, and the next person to look at the page sees an approximation with
 * nothing saying so.
 *
 * **No page number and no page count** (14.3). The emitter determines no
 * pagination, and "a wrong page count is a promise the document breaks".
 *
 * **This surface does not claim to be the delivered result** (14.6). Only the
 * rendered `.pdf` may say that.
 */

afterEach(cleanup)

const FIGURE =
  '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/0/value" ' +
  'data-figure-path="b1:0.0.2.0">64.20%</span>'

const DOCUMENT = `<h2>Utilization</h2><p>CPU averaged ${FIGURE} across the window.</p>`

describe("Requirement 14.2 — the label is permanent", () => {
  test("it renders without any interaction", () => {
    const { container } = render(<PaperRender html={DOCUMENT} />)

    expect(container.querySelector("[data-slot='preview-label']")).toBeTruthy()
  })

  test("there is no control that dismisses it", () => {
    const { container } = render(<PaperRender html={DOCUMENT} />)
    const label = container.querySelector("[data-slot='preview-label']")!

    // No button, no close affordance, and no `hidden`/`details` wrapper — the
    // component takes no prop that could hide it either.
    expect(label.querySelector("button")).toBeNull()
    expect(label.closest("details")).toBeNull()
  })

  test("it names all three divergences in visible text", () => {
    // Requirement 14.4 — specifically these three, because they are exactly what
    // Word decides for itself and a browser cannot predict.
    const { container } = render(<PaperRender html={DOCUMENT} />)
    const text = container.querySelector("[data-slot='preview-label']")!.textContent!

    expect(text).toContain("pagination")
    expect(text).toContain("table column widths")
    expect(text).toContain("font metrics")
  })
})

describe("Requirement 14.3 — no page number, no page count", () => {
  test("nothing states a page position", () => {
    const { container } = render(<PaperRender html={DOCUMENT} />)
    const text = container.textContent ?? ""

    expect(text).not.toMatch(/page \d+/i)
    expect(text).not.toMatch(/\d+ of \d+ pages/i)
  })
})

describe("Requirement 14.6 — this surface is not the delivered result", () => {
  test("it points at the .pdf rather than claiming to be it", () => {
    const { container } = render(<PaperRender html={DOCUMENT} />)
    const text = container.querySelector("[data-slot='preview-label']")!.textContent!

    expect(text).toMatch(/delivered result is the/i)
    expect(text).toMatch(/\.pdf/)
  })
})

describe("Requirement 38.6 — figures are keyboard reachable in document order", () => {
  test("each figure is focusable", () => {
    const { container } = render(
      <PaperRender html={`${DOCUMENT}<p>and ${FIGURE}</p>`} />
    )

    const focusable = container.querySelectorAll("[aria-describedby][tabindex='0']")

    expect(focusable).toHaveLength(2)
  })

  test("the surrounding markup is preserved", () => {
    // The emitter's output, passed through — this component holds no layout
    // definition of its own (Requirement 38.1).
    const { container } = render(<PaperRender html={DOCUMENT} />)

    expect(container.querySelector("h2")?.textContent).toBe("Utilization")
  })
})
