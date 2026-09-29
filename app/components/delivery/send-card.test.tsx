import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { SendCard } from "@/components/delivery/send-card"

let calls: { url: string; method: string }[] = []

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method) })
      return {
        ok: true,
        json: async () => ({
          delivery: {
            id: "d-1",
            status: "sent",
            approvedAt: "2026-09-03T02:12:00.000Z",
            recipients: [{ name: "Budi", email: "budi@customer.co.id", ok: true }],
            linkExpiresAt: "2026-10-03T02:12:00.000Z",
            firstOpenedAt: null,
            openCount: 0,
          },
        }),
      } as unknown as Response
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const props = {
  runId: "run-1",
  workspaceId: "ws-1",
  projectId: "prj-1",
  customer: "Nusantara Logistik",
  contacts: [{ id: "c-1", name: "Budi", email: "budi@customer.co.id" }],
  delivery: null,
  canEdit: true,
  canSend: true,
  mailIssue: null,
}

describe("SendCard", () => {
  test("sending asks first, in the card, then records what was sent", async () => {
    render(<SendCard {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }))
    expect(calls).toHaveLength(0)
    expect(screen.getByText("Send this verified report to 1 contact?")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(calls).toEqual([{ url: "/api/runs/run-1/deliver", method: "POST" }]))
    expect(await screen.findByText(/to 1 of 1 contact/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Send again" })).toBeInTheDocument()
  })

  test("an Editor can manage contacts but not send, and nothing sends without email set up", () => {
    render(<SendCard {...props} canSend={false} />)
    expect(screen.getByText("Only an Owner or Admin can approve and send a report.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument()
    cleanup()
    render(<SendCard {...props} mailIssue="RPT_MAIL_FROM is not set in the running service." />)
    expect(screen.getByText(/Email is not set up on this server/)).toHaveTextContent("RPT_MAIL_FROM is not set")
    expect(screen.queryByRole("button", { name: "Approve and send" })).toBeNull()
  })
})
