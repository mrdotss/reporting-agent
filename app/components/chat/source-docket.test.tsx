import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { CONNECTOR, LIVE, RUN } from "@/components/chat/ask-fixtures"
import { SourceDocket } from "@/components/chat/source-docket"

afterEach(cleanup)

describe("SourceDocket", () => {
  test("names each source, and detaches the one asked", () => {
    const onRemove = vi.fn()
    render(<SourceDocket runs={[RUN]} connectors={[CONNECTOR]} live={[LIVE]} onAdd={vi.fn()} onRemove={onRemove} />)

    expect(screen.getByText("FATechID")).toBeTruthy()
    expect(screen.getByText("409 figures")).toBeTruthy()
    expect(screen.getByText("project-api, jenkins-ci")).toBeTruthy()
    expect(screen.getByText(/7 days · not verified/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Detach FATechID August 2026" }))
    expect(onRemove).toHaveBeenCalledWith("run", "run-1")
    fireEvent.click(screen.getByRole("button", { name: /Detach live metrics for project-api/ }))
    expect(onRemove).toHaveBeenCalledWith("live", "l1")
    fireEvent.click(screen.getByRole("button", { name: "Detach hinsandbox" }))
    expect(onRemove).toHaveBeenCalledWith("connector", "c1")
  })

  test("a live pull is ruled dashed and a report is not", () => {
    const { container } = render(<SourceDocket runs={[RUN]} connectors={[]} live={[LIVE]} />)
    const chips = [...container.querySelectorAll("[data-slot='source-docket'] > span.rounded-lg")]
    expect(chips).toHaveLength(2)
    expect(chips[0]!.className).not.toMatch(/border-dashed/)
    expect(chips[1]!.className).toMatch(/border-dashed/)
  })

  test("a reader who cannot change the conversation gets no detach and no add", () => {
    render(<SourceDocket runs={[RUN]} connectors={[]} live={[]} />)
    expect(screen.queryByRole("button")).toBeNull()
  })

  test("says when nothing is attached, and when a source has gone", () => {
    const { rerender } = render(<SourceDocket runs={[]} connectors={[]} live={[]} onAdd={vi.fn()} />)
    expect(screen.getByText("Nothing attached")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Add source/ })).toBeTruthy()
    rerender(<SourceDocket runs={[RUN]} connectors={[]} live={[]} unavailable={2} />)
    expect(screen.getByText("2 no longer available")).toBeTruthy()
  })
})
