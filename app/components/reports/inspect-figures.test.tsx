import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { InspectFigures } from "./inspect-figures"

afterEach(cleanup)

vi.mock("@/components/reports/paper-render", () => ({
  PaperRender: ({ html }: { html: string }) => (
    <div data-testid="paper">{html}</div>
  ),
}))

/**
 * The paper rendering behind a disclosure (task 2.5).
 *
 * The point of the change is that the rendering is *reachable* but not *in the
 * way* — so both halves need asserting, and so does the mount, because walking a
 * whole document for a panel nobody opened is work done for no reader.
 */

describe("the disclosure", () => {
  test("does not mount the rendering until it is opened", () => {
    render(<InspectFigures html="<p>the document</p>" />)

    expect(screen.queryByTestId("paper")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /inspect figures/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })

  test("opening it reveals the rendering", () => {
    render(<InspectFigures html="<p>the document</p>" />)

    fireEvent.click(screen.getByRole("button", { name: /inspect figures/i }))

    expect(screen.getByTestId("paper")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /inspect figures/i })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
  })

  test("the control names what it is for, not just what it is", () => {
    // "Inspect figures" alone does not tell a consultant why they would.
    render(<InspectFigures html="<p/>" />)
    expect(screen.getByText(/trace any number back to the snapshot/i)).toBeInTheDocument()
  })
})
