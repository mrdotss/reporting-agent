import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { FigureTraceProvider } from "@/components/chat/figure-trace"
import { MessageText } from "@/components/chat/message-text"
import { TooltipProvider } from "@/components/ui/tooltip"

/**
 * An answer renders as React nodes, never as HTML (ask-chat Req 3).
 *
 * The runtime's markers become a figure chip and an estimate label; everything else a
 * model wrote — including text shaped like markup — is text.
 */

function renderAnswer(text: string) {
  return render(
    <TooltipProvider>
      <MessageText
        text={text}
        citations={{
          f1: {
            fact_id: "f1",
            source: "report",
            label: "vm-mcp-prod-01 · Percentage CPU · avg",
            formatted: "8.06%",
            customer_name: "Satu Data Labs",
            period_display: "August 2026",
            snapshot_path: "resources/0/statistics/0",
          },
        }}
      />
    </TooltipProvider>
  )
}

describe("MessageText", () => {
  test("a figure marker renders as a chip carrying the verified string", () => {
    const { container } = renderAnswer("CPU averaged ⟦fig:f1⟧8.06%⟦/fig⟧ in August.")
    const chip = container.querySelector('[data-slot="figure-chip"]')
    expect(chip?.textContent).toBe("8.06%")
    expect(container.textContent).toBe("CPU averaged 8.06% in August.")
  })

  test("an estimate is labelled as one", () => {
    const { container } = renderAnswer("⟦est⟧About half of ⟦fig:f1⟧8.06%⟦/fig⟧.⟦/est⟧")
    expect(container.querySelector('[data-slot="estimate"]')).not.toBeNull()
    expect(screen.getByText("Estimate")).toBeTruthy()
  })

  test("markup-looking text from a model stays text", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>steal()</script>'
    const { container } = renderAnswer(hostile)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("script")).toBeNull()
    expect(container.textContent).toBe(hostile)
  })

  test("paragraphs split on blank lines", () => {
    const { container } = renderAnswer("First.\n\nSecond.")
    expect(container.querySelectorAll("p")).toHaveLength(2)
  })
})

describe("a figure chip in a conversation that can trace it", () => {
  afterEach(cleanup)

  function renderTraceable(onSelect: (factId: string) => void, selectedId: string | null = null) {
    return render(
      <TooltipProvider>
        <FigureTraceProvider value={{ numbers: new Map([["f1", 2]]), selectedId, onSelect }}>
          <MessageText
            text="CPU averaged ⟦fig:f1⟧8.06%⟦/fig⟧."
            citations={{
              f1: { fact_id: "f1", source: "report", label: "vm · CPU", formatted: "8.06%" },
            }}
          />
        </FigureTraceProvider>
      </TooltipProvider>
    )
  }

  test("is a button that carries its number and opens its own trace", () => {
    const onSelect = vi.fn()
    renderTraceable(onSelect)
    const chip = screen.getByRole("button", { name: /8\.06%, figure 2/ })
    expect(chip.getAttribute("aria-pressed")).toBe("false")
    expect(chip.textContent).toBe("8.06%2")
    fireEvent.click(chip)
    expect(onSelect).toHaveBeenCalledWith("f1")
  })

  test("shows which figure is open", () => {
    renderTraceable(vi.fn(), "f1")
    expect(screen.getByRole("button", { name: /figure 2/ }).getAttribute("aria-pressed")).toBe("true")
  })

  test("a live figure is announced as not verified", () => {
    render(
      <TooltipProvider>
        <FigureTraceProvider value={{ numbers: new Map([["f9", 1]]), selectedId: null, onSelect: vi.fn() }}>
          <MessageText
            text="⟦fig:f9⟧4.1%⟦/fig⟧"
            citations={{ f9: { fact_id: "f9", source: "live", label: "live", formatted: "4.1%" } }}
          />
        </FigureTraceProvider>
      </TooltipProvider>
    )
    expect(screen.getByRole("button", { name: /live, not verified/ })).toBeTruthy()
  })

  test("a figure with no recorded source is not offered for tracing", () => {
    render(
      <TooltipProvider>
        <FigureTraceProvider value={{ numbers: new Map([["f1", 1]]), selectedId: null, onSelect: vi.fn() }}>
          <MessageText text="⟦fig:f1⟧8.06%⟦/fig⟧" citations={{}} />
        </FigureTraceProvider>
      </TooltipProvider>
    )
    expect(screen.queryByRole("button")).toBeNull()
  })
})
