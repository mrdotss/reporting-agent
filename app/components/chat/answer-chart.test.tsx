import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import { AnswerChart } from "@/components/chat/answer-chart"
import { MessageText } from "@/components/chat/message-text"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ChatChart } from "@/lib/chat/views"

/**
 * Charts in answers (ask-chat Req 9): drawn from the runtime's chart specs, labelled with the
 * facts' own formatted strings, and honest about where the numbers came from.
 */

const COMPARE: ChatChart = {
  id: "c1",
  kind: "compare",
  title: "Average CPU by machine",
  unit: "percent",
  source: "live",
  bars: [
    { fact_id: "f1", label: "cpn-app", value: "0.21", formatted: "0.21%" },
    { fact_id: "f2", label: "cpn-mcp", value: "25.79", formatted: "25.79%" },
  ],
}

const DAILY: ChatChart = {
  id: "c2",
  kind: "daily",
  title: "Daily average CPU — cpn-app",
  unit: "percent",
  source: "verified",
  series_label: "cpn-app · Percentage CPU · avg",
  points: [
    { day: "2026-09-08", value: "0.21", formatted: "0.21%" },
    { day: "2026-09-09", value: "0.30", formatted: "0.30%" },
    { day: "2026-09-10", value: "0.25", formatted: "0.25%" },
  ],
}

describe("AnswerChart", () => {
  test("a comparison labels each bar with its machine and its formatted figure", () => {
    const { container } = render(<AnswerChart chart={COMPARE} />)
    expect(screen.getByText("Average CPU by machine")).toBeTruthy()
    expect(screen.getByText("cpn-app")).toBeTruthy()
    expect(screen.getByText("25.79%")).toBeTruthy()
    expect(container.querySelector('[data-source="live"]')).not.toBeNull()
    expect(screen.getByText("Live · not verified")).toBeTruthy()
  })

  test("a daily chart draws the report's themed chart and lists the daily figures", () => {
    const { container } = render(<AnswerChart chart={DAILY} />)
    expect(container.querySelector('[data-slot="themed-chart"]')).not.toBeNull()
    expect(screen.getByText("Verified figures")).toBeTruthy()
    expect(screen.getByText(/peak 0\.30% on 2026-09-09/)).toBeTruthy()
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3)
  })
})

describe("MessageText with charts", () => {
  const text = "CPU was low all week.\n\n⟦chart:c2⟧\n\nNo spikes above one percent."

  test("a chart marker renders its chart between paragraphs", () => {
    const { container } = render(
      <TooltipProvider>
        <MessageText text={text} citations={{}} charts={[DAILY]} />
      </TooltipProvider>
    )
    expect(container.querySelectorAll("p")).toHaveLength(2)
    expect(container.querySelector('[data-slot="answer-chart"]')).not.toBeNull()
    expect(container.textContent).not.toContain("⟦chart")
  })

  test("while streaming, a marker whose chart has not arrived holds a placeholder", () => {
    const { container } = render(
      <TooltipProvider>
        <MessageText text={text} citations={{}} streaming />
      </TooltipProvider>
    )
    expect(container.querySelector('[data-slot="answer-chart-pending"]')).not.toBeNull()
  })

  test("a stored answer whose chart is missing renders no marker text", () => {
    const { container } = render(
      <TooltipProvider>
        <MessageText text={text} citations={{}} />
      </TooltipProvider>
    )
    expect(container.querySelector('[data-slot="answer-chart"]')).toBeNull()
    expect(container.textContent).not.toContain("⟦chart")
  })
})
