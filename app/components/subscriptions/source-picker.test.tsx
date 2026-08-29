import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { SourcePicker } from "./source-picker"

afterEach(cleanup)

/**
 * Step one of connecting (task 2.4).
 *
 * The unbuilt sources are the interesting half: they are visible so a consultant
 * can see the product intends to reach them, and unclickable so nothing promises
 * a flow that does not exist.
 */

describe("the source picker", () => {
  test("Azure is selectable and reports which source was chosen", () => {
    const onSelect = vi.fn()
    render(<SourcePicker onSelect={onSelect} />)

    fireEvent.click(screen.getByRole("button", { name: /Microsoft Azure/ }))

    expect(onSelect).toHaveBeenCalledWith("azure")
  })

  test("the unbuilt sources are shown, disabled, and say so", () => {
    const onSelect = vi.fn()
    render(<SourcePicker onSelect={onSelect} />)

    for (const name of [/Amazon Web Services/, /On-premises/]) {
      const card = screen.getByRole("button", { name })
      expect(card).toBeDisabled()
      fireEvent.click(card)
    }

    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getAllByText("Coming soon")).toHaveLength(2)
  })

  test("each card names the credential that source needs", () => {
    // The card is what tells a consultant whether they have what the next step
    // will ask for, before they commit to it.
    render(<SourcePicker onSelect={vi.fn()} />)

    expect(screen.getByText(/Reader role/)).toBeInTheDocument()
    expect(screen.getByText(/external id/)).toBeInTheDocument()
    expect(screen.getByText(/collector agent/)).toBeInTheDocument()
  })
})
