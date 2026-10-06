import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { SOURCES } from "@/components/chat/ask-fixtures"
import { NewQuestion } from "@/components/chat/new-question"
import type { ChatAttachments } from "@/lib/chat/views"

afterEach(cleanup)

const NONE: ChatAttachments = { runIds: [], connectorIds: [], liveIds: [] }

function renderPicker(overrides: Partial<Parameters<typeof NewQuestion>[0]> = {}) {
  const onChange = vi.fn()
  const onAsk = vi.fn()
  const onOpenDialog = vi.fn()
  render(
    <NewQuestion
      canChat
      sources={SOURCES}
      attachments={NONE}
      onChange={onChange}
      onOpenDialog={onOpenDialog}
      suggestions={["Which VMs look over-provisioned?"]}
      onAsk={onAsk}
      {...overrides}
    />
  )
  return { onChange, onAsk, onOpenDialog }
}

describe("NewQuestion", () => {
  test("asks what the answer should rest on and lists the verified reports", () => {
    renderPicker()
    expect(screen.getByRole("heading", { name: "What should the answer rest on?" })).toBeTruthy()
    expect(screen.getAllByText("FATechID")).toHaveLength(2)
    expect(screen.getByText("409 figures · 58 resources · 92 gaps recorded")).toBeTruthy()
    expect(screen.getByText("Only reports whose latest verification passed are listed.")).toBeTruthy()
  })

  test("ticking a report adds it to the attachments, unticking removes it", () => {
    const first = renderPicker()
    fireEvent.click(screen.getAllByRole("checkbox")[0]!)
    expect(first.onChange).toHaveBeenCalledWith({ runIds: ["run-1"], connectorIds: [], liveIds: [] })
    cleanup()

    const second = renderPicker({ attachments: { runIds: ["run-1"], connectorIds: [], liveIds: [] } })
    fireEvent.click(screen.getAllByRole("checkbox")[0]!)
    expect(second.onChange).toHaveBeenCalledWith({ runIds: [], connectorIds: [], liveIds: [] })
  })

  test("suggestions wait for a source, then ask the question as written", () => {
    renderPicker()
    expect(screen.queryByText("Which VMs look over-provisioned?")).toBeNull()
    cleanup()

    const { onAsk } = renderPicker({ attachments: { runIds: ["run-1"], connectorIds: [], liveIds: [] } })
    fireEvent.click(screen.getByRole("button", { name: "Which VMs look over-provisioned?" }))
    expect(onAsk).toHaveBeenCalledWith("Which VMs look over-provisioned?")
  })

  test("a connector with no scan cannot be ticked and points to scanning it", () => {
    renderPicker()
    fireEvent.click(screen.getByRole("tab", { name: /Connector inventory/ }))
    const unscanned = screen.getByRole("checkbox", { name: /hin-prod/ })
    expect(unscanned.hasAttribute("data-disabled") || unscanned.getAttribute("aria-disabled") === "true").toBe(true)
    expect(screen.getByRole("link", { name: "Scan first" }).getAttribute("href")).toBe("/subscriptions?c=c2")
  })

  test("the live tab lists earlier pulls and opens the dialog to collect a new one", () => {
    const { onOpenDialog } = renderPicker()
    fireEvent.click(screen.getByRole("tab", { name: /Live metrics/ }))
    expect(screen.getByText("project-api, jenkins-ci")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Collect new live metrics" }))
    expect(onOpenDialog).toHaveBeenCalledWith("live")
  })

  test("a reader who cannot ask sees why, and no sources to choose", () => {
    renderPicker({ canChat: false })
    expect(screen.getByRole("heading", { name: /Read this workspace/ })).toBeTruthy()
    expect(screen.queryByRole("checkbox")).toBeNull()
  })
})
