import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * `GET /api/report-profiles/[id]/canvas-data` — Real figures for the builder's canvas.
 * Faked: the session, the preset and connection reads, the snapshot lookup and the reader.
 * What is left is who may draw which connection's figures, and how a missing report is said.
 */

const state = vi.hoisted(() => ({
  user: { id: "user-1", email: "user@example.test" } as { id: string; email: string } | null,
  template: { id: "tmpl-1", provider: "aws", workspaceId: "ws-1", projectId: "pr-1" } as Record<string, unknown> | null,
  source: { id: "conn-1", provider: "aws", status: "active", workspaceId: "ws-1", projectId: "pr-1", displayName: "Sandbox" } as Record<string, unknown> | null,
  run: { actorId: "user-1", runId: "run-9" } as Record<string, unknown> | null,
  loads: [] as unknown[][],
  unreadable: false,
}))

vi.mock("@/lib/auth/guard", () => ({ requireSessionForApi: async () => state.user }))

vi.mock("@/lib/templates/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/templates/store")>()
  return {
    ...original,
    getTemplate: async () => {
      if (state.template === null) throw new original.TemplateNotFoundError()
      return state.template
    },
  }
})

vi.mock("@/lib/subscriptions/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/subscriptions/store")>()
  return {
    ...original,
    getConnectedSubscription: async () => {
      if (state.source === null) throw new original.SubscriptionNotFoundError()
      return state.source
    },
  }
})

vi.mock("@/lib/templates/preview", () => ({ mostRecentSnapshotRun: async () => state.run }))

vi.mock("@/lib/templates/canvas-data", () => {
  class CanvasDataUnreadableError extends Error {}
  return {
    CanvasDataUnreadableError,
    loadCanvasData: async (...args: unknown[]) => {
      state.loads.push(args)
      if (state.unreadable) throw new CanvasDataUnreadableError("That report's figures could not be read.")
      return { kind: "real", resources: [], counts: { resources: 0, stopped: 0, unprotected: null } }
    },
  }
})

const { GET } = await import("@/app/api/report-profiles/[id]/canvas-data/route")

function get(query = "?connection=conn-1") {
  return GET(new Request(`http://localhost/api/report-profiles/tmpl-1/canvas-data${query}`), {
    params: Promise.resolve({ id: "tmpl-1" }),
  })
}

beforeEach(() => {
  state.user = { id: "user-1", email: "user@example.test" }
  state.template = { id: "tmpl-1", provider: "aws", workspaceId: "ws-1", projectId: "pr-1" }
  state.source = { id: "conn-1", provider: "aws", status: "active", workspaceId: "ws-1", projectId: "pr-1", displayName: "Sandbox" }
  state.run = { actorId: "user-1", runId: "run-9" }
  state.loads = []
  state.unreadable = false
})

describe("GET /api/report-profiles/[id]/canvas-data", () => {
  test("draws the connection's latest report", async () => {
    const response = await get()
    expect(response.status).toBe(200)
    expect((await response.json()).kind).toBe("real")
    expect(state.loads[0]).toEqual([state.run, { name: "Sandbox", provider: "aws" }])
  })

  test("needs a session and a connection", async () => {
    state.user = null
    expect((await get()).status).toBe(401)
    state.user = { id: "user-1", email: "user@example.test" }
    expect((await get("")).status).toBe(400)
  })

  test("another project's connection, or an unknown one, is not found", async () => {
    state.source = { ...state.source, projectId: "pr-2" }
    expect((await get()).status).toBe(404)
    state.source = null
    expect((await get()).status).toBe(404)
  })

  test.each([
    ["another provider", () => (state.source = { ...state.source, provider: "azure" }), "PROVIDER_MISMATCH"],
    ["an inactive connection", () => (state.source = { ...state.source, status: "disabled" }), "CONNECTION_INACTIVE"],
    ["no completed report", () => (state.run = null), "NO_SNAPSHOT"],
    ["an unreadable snapshot", () => (state.unreadable = true), "SNAPSHOT_UNREADABLE"],
  ])("refuses %s", async (_, arrange, code) => {
    arrange()
    const response = await get()
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe(code)
  })
})
