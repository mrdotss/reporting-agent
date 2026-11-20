import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { SchedulePanel } from "@/components/schedules/schedule-panel"
import type { ScheduleView } from "@/lib/schedules/view"

const SAVED: ScheduleView = {
  id: "sch-1",
  connectedSubscriptionId: "sub-aws",
  templateId: "tmpl-aws",
  regions: [],
  kind: "monthly",
  dayOfMonth: 1,
  dayOfWeek: null,
  hour: 2,
  timezone: "Asia/Jakarta",
  enabled: true,
  cadence: "on the 1st at 02:00 WIB",
  next: "1 Nov, 02:00",
  lastRunId: null,
  lastError: null,
  autoSend: false,
  lastSendError: null,
}

let requests: { method: string; body: Record<string, unknown> }[] = []

beforeEach(() => {
  requests = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      requests.push({ method: String(init.method), body })
      return {
        ok: true,
        json: async () => ({ schedule: init.method === "DELETE" ? null : { ...SAVED, dayOfMonth: body.dayOfMonth } }),
      } as unknown as Response
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPanel(schedule: ScheduleView | null, overrides: Partial<Parameters<typeof SchedulePanel>[0]> = {}) {
  return render(
    <SchedulePanel
      workspaceId="ws-1"
      projectId="prj-1"
      connectedSubscriptionId="sub-aws"
      templateId="tmpl-aws"
      regions={["us-east-1"]}
      schedule={schedule}
      nameOfConnector={() => "hinsandbox"}
      nameOfTemplate={() => "AWS monthly"}
      canSave
      {...overrides}
    />
  )
}

describe("SchedulePanel", () => {
  test("saving sends the chosen pairing, time and regions for this customer", async () => {
    renderPanel(null)

    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }))
    await waitFor(() => expect(requests).toHaveLength(1))

    expect(requests[0]).toEqual({
      method: "PUT",
      body: {
        workspaceId: "ws-1",
        projectId: "prj-1",
        connectedSubscriptionId: "sub-aws",
        templateId: "tmpl-aws",
        dayOfMonth: 1,
        hour: 2,
        regions: ["us-east-1"],
      },
    })
    expect(await screen.findByText(/Runs automatically on the 1st at 02:00 WIB/)).toBeInTheDocument()
  })

  test("an existing schedule says when it runs next, and stopping it clears it", async () => {
    renderPanel({ ...SAVED, lastError: "That subscription is not ready to run." })

    expect(screen.getByText("1 Nov, 02:00")).toBeInTheDocument()
    expect(screen.getByText(/The last scheduled run did not start/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Stop schedule" }))
    await waitFor(() => expect(requests).toEqual([{ method: "DELETE", body: { workspaceId: "ws-1", projectId: "prj-1" } }]))
    expect(await screen.findByRole("button", { name: "Save schedule" })).toBeInTheDocument()
  })

  test("a weekly panel waits behind a button, defaults to Monday 08:00 and says so", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ method: String(init?.method), body })
      return {
        ok: true,
        json: async () => ({
          schedule: { ...SAVED, kind: "weekly", dayOfMonth: null, dayOfWeek: 1, hour: 8, cadence: "every Monday at 08:00 WIB" },
        }),
      } as unknown as Response
    })
    renderPanel(null, { cadence: "weekly" })

    expect(screen.queryByRole("button", { name: "Save weekly schedule" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Set up a weekly schedule" }))
    fireEvent.click(screen.getByRole("button", { name: "Save weekly schedule" }))
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]?.body).toMatchObject({ cadence: "weekly", dayOfWeek: 1, hour: 8, autoSend: true })
    expect(requests[0]?.body).not.toHaveProperty("dayOfMonth")
    expect(await screen.findByText(/Runs automatically every Monday at 08:00 WIB/)).toBeInTheDocument()
  })

  test("a weekly preset opens the weekly form at once", () => {
    renderPanel(null, { cadence: "weekly", openByDefault: true })
    expect(screen.getByRole("button", { name: "Save weekly schedule" })).toBeEnabled()
  })

  test("a pairing that cannot be requested cannot be scheduled", () => {
    renderPanel(null, { canSave: false })
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled()
  })
})
