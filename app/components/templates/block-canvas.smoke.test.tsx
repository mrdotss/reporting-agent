import { StrictMode } from "react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { BlockCanvas } from "./block-canvas"

/**
 * The drag primitive under React 19 StrictMode (Requirements 12.13, 42.10).
 *
 * ## Why a smoke test guards a dependency pin
 *
 * A StrictMode incompatibility in a drag library does not announce itself. StrictMode
 * double-invokes effects — mount, unmount, mount — so a manager that registers document
 * listeners on setup and does not fully release them on teardown ends up with two live
 * registrations. The symptom is **an intermittent reorder**: a drop occasionally applies
 * twice, or applies to a stale element list. That reads as a flaky UI weeks later, in a
 * component whose own logic is correct, and it is close to unattributable by then.
 *
 * So the assertion is made at the point the version is pinned, against the smallest thing
 * that can carry it: an empty canvas. No blocks, no selection, no reorder — just the
 * provider's lifecycle run twice by StrictMode.
 *
 * ## What each assertion is actually for
 *
 * - **Mounts at all.** `DragDropProvider` constructing its manager twice must not throw.
 * - **Exactly one list, zero items.** A duplicated subscription or a leaked manager
 *   surfaces as duplicated DOM. One `<ol>` with no `<li>` is the whole contract of an
 *   empty canvas (Requirement 12.6 — the canvas is a real list in document order).
 * - **A clean console.** React reports StrictMode-visible violations — a setState in an
 *   unsafe lifecycle, a mutated ref during render — through `console.error` while
 *   *passing* the render. Without this spy the suite would go green on precisely the
 *   class of defect it was written to catch.
 * - **Remount is clean.** Unmounting and mounting again runs teardown for real, not just
 *   StrictMode's simulated one, so a listener released only on the simulated pass shows
 *   up here as a second list or a console error rather than in production.
 */

afterEach(cleanup)

/** Fails the calling test if React wrote anything to `console.error`/`warn`. */
function expectQuietConsole(run: () => void): void {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

  try {
    run()
    // The received calls are surfaced rather than a bare count, so a failure names the
    // violation instead of saying that one occurred.
    expect(error.mock.calls, "React wrote to console.error").toEqual([])
    expect(warn.mock.calls, "React wrote to console.warn").toEqual([])
  } finally {
    error.mockRestore()
    warn.mockRestore()
  }
}

// ---------------------------------------------------------------------------

describe("Requirement 12.13 — the drag primitive survives StrictMode", () => {
  test("an empty canvas mounts under StrictMode as one list with no items", () => {
    let container!: HTMLElement

    expectQuietConsole(() => {
      container = render(
        <StrictMode>
          <BlockCanvas blocks={[]} />
        </StrictMode>
      ).container
    })

    const lists = container.querySelectorAll("ol[data-slot='block-canvas']")
    expect(lists).toHaveLength(1)
    expect(lists[0].querySelectorAll("li")).toHaveLength(0)
  })

  test("blocks render in the order given, one list item each", () => {
    // Requirement 12.6 — DOM order *is* document order, so the assertion is on the
    // sequence rather than on presence. A canvas that renders the right blocks in the
    // wrong order is a document that emits them in the wrong order.
    const { container } = render(
      <StrictMode>
        <BlockCanvas
          blocks={[
            { id: "b1", type: "cover" },
            { id: "b2", type: "kpi_row" },
            { id: "b3", type: "resource_table" },
          ]}
        />
      </StrictMode>
    )

    const items = [
      ...container.querySelectorAll("ol[data-slot='block-canvas'] > li"),
    ]
    expect(items.map((item) => item.getAttribute("data-block-id"))).toEqual([
      "b1",
      "b2",
      "b3",
    ])
  })

  test("a real unmount and remount leaves no duplicate registration behind", () => {
    expectQuietConsole(() => {
      const first = render(
        <StrictMode>
          <BlockCanvas blocks={[]} />
        </StrictMode>
      )
      first.unmount()

      const second = render(
        <StrictMode>
          <BlockCanvas blocks={[]} />
        </StrictMode>
      )
      expect(
        second.container.querySelectorAll("ol[data-slot='block-canvas']")
      ).toHaveLength(1)
    })
  })
})
