import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"

import { THREAD } from "@/components/chat/ask-fixtures"
import { ThreadList, sourceCount } from "@/components/chat/thread-list"

afterEach(cleanup)

describe("sourceCount", () => {
  test("counts reports, connectors and live pulls", () => {
    expect(sourceCount(THREAD)).toBe("2 sources")
    expect(sourceCount({ ...THREAD, attachments: { runIds: ["a"], connectorIds: [], liveIds: [] } })).toBe("1 source")
    expect(sourceCount({ ...THREAD, attachments: { runIds: [], connectorIds: [], liveIds: [] } })).toBe("No sources")
    expect(sourceCount({ ...THREAD, attachments: { runIds: [], connectorIds: [] } })).toBe("No sources")
  })
})

describe("ThreadList", () => {
  const props = {
    threads: [THREAD],
    activeId: "t1",
    currentUserId: "u1",
    onSelect: () => {},
    unavailable: false,
  }

  test("shows the customer and what each conversation rests on", () => {
    render(<ThreadList {...props} customerOf={() => "FATechID"} />)
    const row = screen.getByRole("button", { name: /Over-provisioned VMs/ })
    expect(row.textContent).toContain("FATechID")
    expect(row.textContent).toContain("2 sources")
    expect(row.getAttribute("aria-current")).toBe("true")
  })

  test("marks the conversation that is being answered", () => {
    render(<ThreadList {...props} busyId="t1" />)
    expect(screen.getByRole("img", { name: "Answering" })).toBeTruthy()
    cleanup()
    render(<ThreadList {...props} busyId="other" />)
    expect(screen.queryByRole("img", { name: "Answering" })).toBeNull()
  })

  test("offers New only to someone who can ask", () => {
    render(<ThreadList {...props} onNew={() => {}} />)
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy()
    cleanup()
    render(<ThreadList {...props} />)
    expect(screen.queryByRole("button", { name: "New" })).toBeNull()
  })
})
