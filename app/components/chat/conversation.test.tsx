import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

import { ANSWER, QUESTION } from "@/components/chat/ask-fixtures"
import { Conversation } from "@/components/chat/conversation"
import { TooltipProvider } from "@/components/ui/tooltip"

beforeAll(() => {
  // jsdom has no layout, so no scrolling.
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

function renderConversation(
  overrides: Partial<Parameters<typeof Conversation>[0]> = {}
) {
  const onSelectFigure = vi.fn()
  render(
    <TooltipProvider>
      <Conversation
        threadId="t1"
        messages={[QUESTION, ANSWER]}
        live={null}
        currentUserId="u1"
        canRequest
        emptyState={<p>Nothing asked yet</p>}
        selectedFigure={null}
        onSelectFigure={onSelectFigure}
        onProposalChange={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  )
  return { onSelectFigure }
}

describe("Conversation", () => {
  test("sets the question apart from the answer and says how the answer was made", () => {
    renderConversation()
    expect(screen.getByText(/You asked/)).toBeTruthy()
    expect(screen.getByText("Which instances look over-provisioned?")).toBeTruthy()
    const answer = screen.getByRole("article", { name: "Answer" })
    expect(answer.textContent).toContain("Answer")
    expect(answer.textContent).toContain("Kimi K3")
    expect(answer.textContent).toContain("Thought for 18s")
  })

  test("a question from a teammate says so", () => {
    renderConversation({ messages: [{ ...QUESTION, authorId: "u2" }, ANSWER] })
    expect(screen.getByText(/A teammate asked/)).toBeTruthy()
  })

  test("numbers the figures in the text and lists them under the answer", () => {
    renderConversation()
    expect(screen.getByRole("button", { name: /6\.2%, figure 1/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /4\.1%, figure 2, live, not verified/ })).toBeTruthy()
    const ledger = screen.getByRole("region", { name: "Figures in this answer" })
    expect(ledger.textContent).toContain("2 traced · 1 live · 1 estimate")
  })

  test("choosing a figure in the text or the ledger opens it for this answer", () => {
    const { onSelectFigure } = renderConversation()
    fireEvent.click(screen.getByRole("button", { name: /6\.2%, figure 1/ }))
    expect(onSelectFigure).toHaveBeenLastCalledWith({ messageId: "m2", factId: "f1" })

    const ledger = screen.getByRole("region", { name: "Figures in this answer" })
    fireEvent.click(ledger.querySelectorAll("button")[2]!)
    expect(onSelectFigure).toHaveBeenLastCalledWith({ messageId: "m2", factId: "f3" })
  })

  test("choosing the open figure again closes it", () => {
    const { onSelectFigure } = renderConversation({ selectedFigure: { messageId: "m2", factId: "f1" } })
    expect(screen.getByRole("button", { name: /6\.2%, figure 1/ }).getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: /6\.2%, figure 1/ }))
    expect(onSelectFigure).toHaveBeenLastCalledWith(null)
  })

  test("a figure open in another answer is not marked here", () => {
    renderConversation({ selectedFigure: { messageId: "some-other-message", factId: "f1" } })
    expect(screen.getByRole("button", { name: /6\.2%, figure 1/ }).getAttribute("aria-pressed")).toBe("false")
  })

  test("a failed answer shows its message and no ledger", () => {
    renderConversation({ messages: [QUESTION, { ...ANSWER, failed: true, text: "The answer could not be written." }] })
    expect(screen.getByText("The answer could not be written.")).toBeTruthy()
    expect(screen.queryByRole("region", { name: "Figures in this answer" })).toBeNull()
  })

  test("an empty conversation shows what the caller gives it", () => {
    renderConversation({ messages: [] })
    expect(screen.getByText("Nothing asked yet")).toBeTruthy()
  })
})
