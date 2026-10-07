import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { AnswerChart } from "@/components/chat/answer-chart"
import { FigureTraceProvider } from "@/components/chat/figure-trace"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ChatChart, ChatCitation } from "@/lib/chat/views"

afterEach(cleanup)

const days = (values: string[]) =>
  values.map((value, index) => ({
    day: `2026-08-${String(index + 1).padStart(2, "0")}`,
    value,
    formatted: `${value}%`,
  }))

const TREND: ChatChart = {
  id: "c1",
  kind: "trend",
  title: "Daily average CPU",
  unit: "percent",
  source: "mixed",
  series: [
    {
      fact_id: "f1",
      label: "jenkins-ci",
      source: "verified",
      points: days(["4.1", "6.2", "5.0"]),
    },
    {
      fact_id: "f2",
      label: "project-api",
      source: "live",
      points: days(["3.3", "3.1", "3.6"]),
    },
  ],
}

const SPREAD: ChatChart = {
  id: "c2",
  kind: "spread",
  title: "CPU headroom",
  unit: "percent",
  source: "verified",
  rows: [
    {
      label: "jenkins-ci",
      source: "verified",
      stats: [
        { fact_id: "f3", statistic: "avg", value: "5.2", formatted: "5.20%" },
        { fact_id: "f4", statistic: "p95", value: "6.2", formatted: "6.20%" },
        { fact_id: "f5", statistic: "max", value: "27.4", formatted: "27.40%" },
      ],
    },
  ],
}

const STATS: ChatChart = {
  id: "c3",
  kind: "stats",
  title: "",
  source: "mixed",
  tiles: [
    {
      fact_id: "f6",
      label: "EC2 instances",
      formatted: "10",
      source: "verified",
      points: [],
    },
    {
      fact_id: "f7",
      label: "CPU now",
      formatted: "4.1%",
      source: "live",
      points: days(["4", "4.2"]),
    },
  ],
}

const COMPARE: ChatChart = {
  id: "c4",
  kind: "compare",
  title: "CPU p95 by machine",
  unit: "percent",
  source: "mixed",
  bars: [
    {
      fact_id: "f8",
      label: "bastion",
      value: "1.3",
      formatted: "1.30%",
      source: "verified",
    },
    {
      fact_id: "f9",
      label: "db-replica",
      value: "31.7",
      formatted: "31.70%",
      source: "verified",
    },
    {
      fact_id: "f10",
      label: "project-api",
      value: "4.1",
      formatted: "4.10%",
      source: "live",
    },
  ],
}

const CITATIONS: Record<string, ChatCitation> = {
  f1: {
    fact_id: "f1",
    source: "report",
    label: "jenkins-ci · CPU · avg",
    formatted: "5.10%",
  },
  f2: {
    fact_id: "f2",
    source: "live",
    label: "project-api · CPU · avg",
    formatted: "3.30%",
  },
}

function renderWithTrace(
  chart: ChatChart,
  onSelect = vi.fn(),
  selectedId: string | null = null
) {
  const numbers = new Map(
    ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"].map(
      (id, index) => [id, index + 1]
    )
  )
  render(
    <TooltipProvider>
      <FigureTraceProvider value={{ numbers, selectedId, onSelect }}>
        <AnswerChart chart={chart} citations={CITATIONS} />
      </FigureTraceProvider>
    </TooltipProvider>
  )
  return onSelect
}

describe("a trend", () => {
  test("pins a day and reads every series on it from the runtime's strings", () => {
    renderWithTrace(TREND)
    const plot = screen.getByRole("group", { name: /arrow keys/ })
    fireEvent.keyDown(plot, { key: "ArrowRight" })
    const readout = screen.getByRole("status")
    expect(readout.textContent).toContain("Sat, 1 Aug 2026")
    expect(readout.textContent).toContain("4.1%")
    expect(readout.textContent).toContain("3.3%")
    fireEvent.keyDown(plot, { key: "ArrowRight" })
    expect(screen.getByRole("status").textContent).toContain("6.2%")
    fireEvent.keyDown(plot, { key: "Escape" })
    expect(screen.queryByRole("status")).toBeNull()
  })

  test("hides a series from its legend, but never the last one", () => {
    renderWithTrace(TREND)
    const [first, second] = screen.getAllByRole("button", { pressed: true })
    fireEvent.click(second!)
    expect(second!.getAttribute("aria-pressed")).toBe("false")
    expect(document.querySelector('[data-series="project-api"]')).toBeNull()
    fireEvent.click(first!)
    expect(first!.getAttribute("aria-pressed")).toBe("true")
  })

  test("a series' own figure in the legend opens its trace, and a live series says so", () => {
    const onSelect = renderWithTrace(TREND)
    fireEvent.click(screen.getByRole("button", { name: /5\.10%, figure 1/ }))
    expect(onSelect).toHaveBeenCalledWith("f1")
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0)
    expect(screen.getByText("Verified and live")).toBeTruthy()
  })

  test("shows its figures as a table", () => {
    renderWithTrace(TREND)
    fireEvent.click(screen.getByRole("radio", { name: "Table" }))
    const table = screen.getByRole("table")
    expect(within(table).getAllByRole("row")).toHaveLength(4)
    expect(table.textContent).toContain("6.2%")
  })

  test("downloads its figures as CSV", () => {
    const createObjectURL = vi.fn(() => "blob:chart")
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {})
    renderWithTrace(TREND)
    fireEvent.click(
      screen.getByRole("button", { name: "Download the figures as CSV" })
    )
    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    click.mockRestore()
  })
})

describe("a spread", () => {
  test("draws a mark per statistic, and a mark opens its figure's trace", () => {
    const onSelect = renderWithTrace(SPREAD)
    const marks = document.querySelectorAll('[data-slot="spread-mark"]')
    expect(marks).toHaveLength(3)
    fireEvent.click(
      screen.getByRole("button", { name: /jenkins-ci max 27\.40%/ })
    )
    expect(onSelect).toHaveBeenCalledWith("f5")
    expect(screen.getByText("27.40%")).toBeTruthy()
  })
})

describe("a stat strip", () => {
  test("is one tile per figure, live marked, each opening its trace", () => {
    const onSelect = renderWithTrace(STATS)
    const tiles = document.querySelectorAll('[data-slot="stat-tile"]')
    expect(tiles).toHaveLength(2)
    expect(tiles[1]!.textContent).toContain("Live · not verified")
    fireEvent.click(tiles[0]!)
    expect(onSelect).toHaveBeenCalledWith("f6")
  })
})

describe("a comparison", () => {
  test("sorts by value or as asked, and a bar opens its trace", () => {
    const onSelect = renderWithTrace(COMPARE)
    const order = () =>
      [...document.querySelectorAll('[data-slot="compare-bar"]')].map(
        (bar) => bar.textContent
      )
    expect(order()[0]).toContain("db-replica")
    fireEvent.click(screen.getByRole("radio", { name: "As asked" }))
    expect(order()[0]).toContain("bastion")
    fireEvent.click(
      screen.getByRole("button", {
        name: /project-api: 4\.10%, live, not verified/,
      })
    )
    expect(onSelect).toHaveBeenCalledWith("f10")
  })

  test("marks the open figure", () => {
    renderWithTrace(COMPARE, vi.fn(), "f9")
    expect(
      screen
        .getByRole("button", { name: /db-replica/ })
        .getAttribute("aria-pressed")
    ).toBe("true")
  })
})

describe("without a trace", () => {
  test("marks are drawn but not offered as buttons that do nothing", () => {
    render(<AnswerChart chart={COMPARE} />)
    for (const bar of document.querySelectorAll('[data-slot="compare-bar"]')) {
      expect((bar as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
