import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { CITATIONS } from "@/components/chat/ask-fixtures"
import { TracePanel } from "@/components/chat/trace-panel"

afterEach(cleanup)

const RUNS = [{ runId: "run-1", digest: "48e4a65a138a1111", verifiedAt: "2026-09-29T17:23:00Z" }]
const TOTALS = { traced: 4, live: 1, unsourced: 0, estimates: 4 }

describe("TracePanel", () => {
  test("a report figure lays out where it came from and links to the report", () => {
    render(<TracePanel figure={{ number: 1, text: "6.2%", citation: CITATIONS.f1 }} runs={RUNS} totals={TOTALS} />)
    expect(screen.getByRole("heading", { name: "Figure 1 · trace" })).toBeTruthy()
    // The badge under the figure, and the first step of its trail.
    expect(screen.getAllByText("Verified report")).toHaveLength(2)
    expect(screen.getByText("resources/3/statistics/0")).toBeTruthy()
    expect(screen.getByText("48e4a65a138a1111")).toBeTruthy()
    expect(screen.getByRole("link", { name: /Trace it in the report/ }).getAttribute("href")).toBe("/reports/run-1/figures")
  })

  test("a live figure is marked not verified and offers no report", () => {
    render(<TracePanel figure={{ number: 2, text: "4.1%", citation: CITATIONS.f2 }} runs={RUNS} totals={TOTALS} />)
    expect(screen.getByText("Live · not verified")).toBeTruthy()
    expect(screen.getByText("Not verified", { selector: "span" })).toBeTruthy()
    expect(screen.queryByRole("link")).toBeNull()
  })

  test("a figure with no recorded source says it is unchecked", () => {
    render(<TracePanel figure={{ number: 3, text: "9", citation: undefined }} runs={[]} totals={TOTALS} />)
    expect(screen.getByText("No source recorded")).toBeTruthy()
    expect(screen.getByText(/Treat it as unchecked/)).toBeTruthy()
  })

  test("closes from its own button", () => {
    const onClose = vi.fn()
    render(<TracePanel figure={{ number: 1, text: "6.2%", citation: CITATIONS.f1 }} runs={RUNS} totals={TOTALS} onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: "Close figure trace" }))
    expect(onClose).toHaveBeenCalled()
  })

  test("with nothing selected it explains itself and counts the conversation", () => {
    render(<TracePanel figure={null} runs={RUNS} totals={TOTALS} />)
    expect(screen.getByText(/Select a numbered figure/)).toBeTruthy()
    expect(screen.getByText("Figures traced").nextSibling?.textContent).toBe("4")
    expect(screen.getByText("Live, not verified").nextSibling?.textContent).toBe("1")
    expect(screen.getByText("Estimates").nextSibling?.textContent).toBe("4")
    expect(screen.queryByText("Without a source")).toBeNull()
  })
})
