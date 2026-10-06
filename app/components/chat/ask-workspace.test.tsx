import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

import { ANSWER, QUESTION, SOURCES, THREAD } from "@/components/chat/ask-fixtures"
import { AskWorkspace, suggestionsFor } from "@/components/chat/ask-workspace"
import { TooltipProvider } from "@/components/ui/tooltip"

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderAsk(overrides: Partial<Parameters<typeof AskWorkspace>[0]> = {}) {
  return render(
    <TooltipProvider>
      <AskWorkspace
        workspaceName="Utilize Space"
        currentUserId="u1"
        threads={[THREAD]}
        sources={SOURCES}
        initialThread={THREAD}
        initialMessages={[QUESTION, ANSWER]}
        canChat
        canRequest
        historyUnavailable={false}
        {...overrides}
      />
    </TooltipProvider>
  )
}

describe("AskWorkspace, an open conversation", () => {
  test("puts what it rests on under the title, not in a side panel", () => {
    renderAsk()
    expect(screen.getByRole("heading", { level: 1, name: "Over-provisioned VMs" })).toBeTruthy()
    expect(screen.getByText(/Started by you · 30 Sept · 1 question/)).toBeTruthy()
    const docket = document.querySelector("[data-slot='source-docket']")!
    expect(within(docket as HTMLElement).getByText("FATechID")).toBeTruthy()
    expect(within(docket as HTMLElement).getByText("project-api, jenkins-ci")).toBeTruthy()
    expect(screen.queryByRole("complementary", { name: "Grounded in" })).toBeNull()
  })

  test("choosing a figure opens its trace, and the trace closes", async () => {
    renderAsk()
    fireEvent.click(screen.getByRole("button", { name: /6\.2%, figure 1/ }))

    const trace = await screen.findByRole("dialog")
    expect(within(trace).getByRole("heading", { name: "Figure 1 · trace" })).toBeTruthy()
    expect(within(trace).getByText("resources/3/statistics/0")).toBeTruthy()
    // The report's digest comes from the attached report, not from the answer.
    expect(within(trace).getByText("48e4a65a138a1111")).toBeTruthy()

    fireEvent.click(within(trace).getByRole("button", { name: "Close figure trace" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.getByRole("button", { name: /6\.2%, figure 1/ }).getAttribute("aria-pressed")).toBe("false")
  })

  test("detaching a source saves the conversation's attachments", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ thread: { ...THREAD, attachments: { runIds: [], connectorIds: [], liveIds: ["l1"] } } }),
    })
    vi.stubGlobal("fetch", fetchMock)
    renderAsk()
    fireEvent.click(screen.getByRole("button", { name: "Detach FATechID August 2026" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("/api/chat/threads/t1")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body)).toEqual({ attachments: { runIds: [], connectorIds: [], liveIds: ["l1"] } })
  })
})

describe("AskWorkspace, a new question", () => {
  test("starts from choosing sources, with no conversation made yet", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderAsk({ initialThread: null, initialMessages: [] })

    expect(screen.getByRole("heading", { level: 1, name: "New question" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "What should the answer rest on?" })).toBeTruthy()
    expect(document.querySelector("[data-slot='source-docket']")).toBeNull()
    expect(screen.getByLabelText("Ask about the attached usage").getAttribute("placeholder")).toBe(
      "Choose at least one source to start"
    )

    fireEvent.click(screen.getAllByRole("checkbox")[0]!)
    // Choosing a source before asking is a draft: nothing is saved until a question is sent.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await screen.findByRole("button", { name: "Which VMs look over-provisioned?" })).toBeTruthy()
    expect(screen.getByLabelText("Ask about the attached usage").getAttribute("placeholder")).toMatch(/Ask about the attached usage/)
  })

  test("suggestions follow what is attached", () => {
    expect(suggestionsFor(0, 0, 0)).toEqual([])
    expect(suggestionsFor(1, 0, 0)).toContain("Which VMs look over-provisioned?")
    expect(suggestionsFor(2, 0, 0)).toContain("How did usage change between the attached reports?")
    expect(suggestionsFor(0, 0, 1)).toContain("How busy was CPU on these machines over the window?")
  })
})

describe("AskWorkspace, a reader who cannot ask", () => {
  test("reads the conversation with nothing that changes it", () => {
    renderAsk({ canChat: false, canRequest: false })
    expect(screen.getByText(/You can read this workspace’s conversations/)).toBeTruthy()
    expect(screen.queryByLabelText("Ask about the attached usage")).toBeNull()
    expect(screen.queryByRole("button", { name: /Add source/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Detach/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "New" })).toBeNull()
  })
})
