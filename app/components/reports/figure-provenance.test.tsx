import { afterEach, describe, expect, test } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { FigureProvenance } from "./figure-provenance"

/**
 * The provenance reveal (Requirement 38).
 *
 * ## The assertions this file exists for
 *
 * **Hover and focus reveal the same thing** (38.4). Two code paths that build
 * the same tooltip is how they come to show different things — usually because
 * the focus path was added later and tested less.
 *
 * **The reveal is the figure's accessible description** (38.7), so an assistive
 * technology announces provenance "without a pointer event". A tooltip that is
 * only *visible* on hover satisfies a screenshot and fails a screen reader.
 *
 * **Escape dismisses without moving focus** (38.4). A keyboard reader closing
 * the reveal must not lose the position they navigated to.
 */

afterEach(cleanup)

const PROVENANCE = {
  snapshotPath: "/resources/0/statistics/0/value",
  estimator: null,
}

const ESTIMATED = {
  snapshotPath: "/resources/0/statistics/3/value",
  estimator: "p95 (hourly means)",
}

/**
 * The focusable figure element.
 *
 * Queried by slot rather than by role, because it deliberately **has** no role:
 * Requirement 38.6 wants it reachable by sequential keyboard navigation, which
 * `tabIndex={0}` gives it, and `role="button"` would promise an activation
 * behaviour it does not have. A focusable element with an accessible description
 * is announced as its text plus its description, which is exactly the reveal.
 */
function figure(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[aria-describedby]")!
}

describe("Requirement 38.1 — the formatted string is presented unchanged", () => {
  test("the ledger's string is what is rendered", () => {
    render(<FigureProvenance formatted="64.20%" provenance={PROVENANCE} />)

    // Not "64.2". The scale is the Formatter's and the verifier matched it
    // character for character.
    expect(screen.getByText("64.20%")).toBeTruthy()
  })
})

describe("Requirement 38.7 — the reveal is the accessible description", () => {
  test("the figure is described by an element carrying the snapshot path", () => {
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={PROVENANCE} />
    )

    const described = container.querySelector("[aria-describedby]")
    const id = described?.getAttribute("aria-describedby")

    expect(id).toBeTruthy()
    expect(container.querySelector(`#${id}`)?.textContent).toContain(
      PROVENANCE.snapshotPath
    )
  })

  test("the description is in the tree before any interaction", () => {
    // The one that catches `display: none` or conditional mounting: an
    // `aria-describedby` target that is not in the accessibility tree is not
    // announced, and the visual requirement would still look satisfied.
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={PROVENANCE} />
    )

    const reveal = container.querySelector("[data-slot='figure-provenance']")

    expect(reveal).toBeTruthy()
    expect(reveal?.textContent).toContain(PROVENANCE.snapshotPath)
  })
})

describe("Requirement 38.4 — hover and focus reveal identically", () => {
  test("focus opens the reveal", () => {
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={PROVENANCE} />
    )

    fireEvent.focus(figure(container))

    expect(
      container.querySelector("[data-slot='figure-provenance']")?.getAttribute("data-open")
    ).toBe("true")
  })

  test("pointer entry opens the reveal, and leaving closes it", () => {
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={PROVENANCE} />
    )
    const reveal = () =>
      container.querySelector("[data-slot='figure-provenance']")

    fireEvent.pointerEnter(container.querySelector("[data-slot='figure']")!)
    expect(reveal()?.getAttribute("data-open")).toBe("true")

    fireEvent.pointerLeave(container.querySelector("[data-slot='figure']")!)
    expect(reveal()?.getAttribute("data-open")).toBe("false")
  })

  test("both paths reveal the same content", () => {
    const { container } = render(
      <FigureProvenance formatted="88.10%" provenance={ESTIMATED} />
    )
    const reveal = () =>
      container.querySelector("[data-slot='figure-provenance']")?.textContent

    fireEvent.focus(figure(container))
    const byFocus = reveal()

    fireEvent.blur(figure(container))
    fireEvent.pointerEnter(container.querySelector("[data-slot='figure']")!)

    expect(reveal()).toBe(byFocus)
  })

  test("blur dismisses", () => {
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={PROVENANCE} />
    )

    fireEvent.focus(figure(container))
    fireEvent.blur(figure(container))

    expect(
      container.querySelector("[data-slot='figure-provenance']")?.getAttribute("data-open")
    ).toBe("false")
  })

  test("Escape dismisses and leaves focus where it was", () => {
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={PROVENANCE} />
    )
    const target = figure(container)

    target.focus()
    fireEvent.focus(target)
    fireEvent.keyDown(document, { key: "Escape" })

    expect(
      container.querySelector("[data-slot='figure-provenance']")?.getAttribute("data-open")
    ).toBe("false")
    // The point of Escape being separate from blur: a keyboard reader closing
    // the reveal must not lose the position they navigated to.
    expect(document.activeElement).toBe(target)
  })
})

describe("Requirement 38.3 — the estimator label is never composed", () => {
  test("an estimated figure shows the ledger's label character-for-character", () => {
    const { container } = render(
      <FigureProvenance formatted="88.10%" provenance={ESTIMATED} />
    )

    fireEvent.focus(figure(container))

    // Not "p95", not "p95 (estimated)". A percentile over hourly buckets is not
    // a p95 of the minute samples, and only the collector knows which it was.
    expect(container.textContent).toContain("p95 (hourly means)")
  })

  test("an exact figure shows no caveat at all", () => {
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={PROVENANCE} />
    )

    fireEvent.focus(figure(container))

    expect(container.textContent).not.toMatch(/p\d|estimat/i)
  })
})

describe("Requirement 38.8 — absent provenance is stated, never invented", () => {
  test("it says provenance is unavailable and shows the figure unchanged", () => {
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={null} />
    )

    expect(container.textContent).toContain("Provenance unavailable")
    expect(screen.getByText("64.20%")).toBeTruthy()
  })

  test("it composes no snapshot path", () => {
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={null} />
    )

    expect(container.textContent).not.toContain("/resources/")
  })
})

describe("Requirement 38.6 — every figure is keyboard reachable", () => {
  test("the figure is in the tab order", () => {
    const { container } = render(
      <FigureProvenance formatted="64.20%" provenance={PROVENANCE} />
    )

    expect(figure(container).getAttribute("tabindex")).toBe("0")
  })
})
