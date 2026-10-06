import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ANSWER_TEXT, CITATIONS } from "@/components/chat/ask-fixtures"
import { FigureLedger } from "@/components/chat/figure-ledger"
import { answerFigures, estimateCount, tallyFigures } from "@/lib/chat/figures"

afterEach(cleanup)

const figures = answerFigures(ANSWER_TEXT, CITATIONS)
const tally = tallyFigures(figures, estimateCount(ANSWER_TEXT))

describe("FigureLedger", () => {
  test("lists every figure in order with its source and the tally", () => {
    render(<FigureLedger figures={figures} tally={tally} selectedId={null} onSelect={vi.fn()} />)
    expect(screen.getByText("2 traced · 1 live · 1 estimate")).toBeTruthy()
    const rows = screen.getAllByRole("button")
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain("6.2%")
    expect(rows[0]!.textContent).toContain("FATechID · August 2026")
    expect(rows[1]!.textContent).toContain("Live")
    expect(rows[1]!.textContent).toContain("Live pull · hinsandbox · not verified")
    expect(rows[2]!.textContent).toContain("AWS Price List · USD · list price")
  })

  test("choosing a row opens that figure, and the open one is marked", () => {
    const onSelect = vi.fn()
    render(<FigureLedger figures={figures} tally={tally} selectedId="f2" onSelect={onSelect} />)
    const rows = screen.getAllByRole("button")
    expect(rows[1]!.getAttribute("aria-pressed")).toBe("true")
    expect(rows[0]!.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(rows[0]!)
    expect(onSelect).toHaveBeenCalledWith("f1")
  })

  test("an answer with no figures draws nothing", () => {
    const { container } = render(<FigureLedger figures={[]} tally={tally} selectedId={null} onSelect={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
})
