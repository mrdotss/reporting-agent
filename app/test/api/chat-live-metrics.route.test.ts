import { beforeEach, describe, expect, test, vi } from "vitest"

import type { LiveMetricPull } from "@/lib/db/schema"

/**
 * `POST /api/chat/live-metrics` (ask-chat Req 8).
 *
 * ## Claims tested
 *
 * 1. **The window is refused before anything is read** — after today, or past retention.
 * 2. **A connector that could not collect is refused before any invocation.**
 * 3. **A body cannot name a machine the connector does not see.**
 * 4. **A finished pull is returned as its browser-safe view**, and a failed one as a 502
 *    carrying the pull and a message.
 */

const PULL: LiveMetricPull = {
  id: "pull_1",
  workspaceId: "ws_1",
  projectId: "proj_1",
  userId: "user_1",
  connectedSubscriptionId: "sub_1",
  resourceIds: ["/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/cpn-app"],
  resourceNames: ["cpn-app"],
  periodStart: "2026-09-01",
  periodEnd: "2026-09-07",
  timezone: "Asia/Jakarta",
  status: "complete",
  resourceCount: 1,
  gapCount: 0,
  errorCode: null,
  errorMessage: null,
  completedAt: new Date("2026-09-15T09:30:00Z"),
  createdAt: new Date("2026-09-15T09:29:00Z"),
  updatedAt: new Date("2026-09-15T09:30:00Z"),
}

const { state } = vi.hoisted(() => ({
  state: {
    user: undefined as { id: string; email: string } | undefined,
    askLevel: "chat" as "chat" | "read" | "none",
    scopeVerified: true,
    secretExpiresAt: "2099-01-01T00:00:00.000Z",
    connectorMissing: false,
    listingAvailable: true,
    finished: undefined as unknown,
    created: [] as unknown[],
    executed: 0,
  },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => state.user ?? null,
}))

vi.mock("@/lib/chat/access", async () => {
  const { WorkspaceAccessError } = await import("@/lib/workspaces/access")
  return {
    requireAskLevel: async (_user: string, _workspace: string, need: "read" | "chat") => {
      if (state.askLevel === "none" || (need === "chat" && state.askLevel !== "chat")) {
        throw new WorkspaceAccessError()
      }
      return state.askLevel
    },
  }
})

vi.mock("@/lib/workspaces/context", () => ({
  selectedContext: async () => ({
    workspace: { id: "ws_1", name: "Delivery", role: "editor", closeDay: 15 },
    workspaces: [],
    projects: [],
    project: undefined,
  }),
}))

vi.mock("@/lib/subscriptions/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/subscriptions/store")>()
  return {
    ...original,
    getConnectedSubscription: async () => {
      if (state.connectorMissing) throw new original.SubscriptionNotFoundError()
      return {
        id: "sub_1",
        displayName: "mrdotss-MSDN",
        scopeVerified: state.scopeVerified,
        secretExpiresAt: state.secretExpiresAt,
        provider: "azure",
      }
    },
    resolveSubscriptionCredentials: async () => ({ subscriptionId: "s", tenantId: "t", clientId: "c", clientSecret: "x" }),
  }
})

vi.mock("@/lib/subscriptions/resources", () => ({
  listConnectorResources: async () =>
    state.listingAvailable
      ? {
          available: true,
          truncated: false,
          resources: [
            {
              resourceId: PULL.resourceIds[0],
              name: "cpn-app",
              resourceType: "Microsoft.Compute/virtualMachines",
              location: "southeastasia",
              resourceGroup: "rg",
              skuName: "Standard_B2als_v2",
              powerState: "running",
            },
          ],
        }
      : { available: false, message: "The machine list couldn’t be loaded." },
}))

vi.mock("@/lib/live-metrics/execute", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/live-metrics/execute")>()
  return {
    ...original,
    createLivePull: async (input: unknown) => {
      state.created.push(input)
      return { ...PULL, status: "queued" }
    },
    executeLivePull: async () => {
      state.executed += 1
      return state.finished
    },
    listLivePulls: async () => [PULL],
  }
})

import { POST } from "@/app/api/chat/live-metrics/route"

function post(body: unknown) {
  return POST(
    new Request("http://test/api/chat/live-metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    connectedSubscriptionId: "sub_1",
    resourceIds: [PULL.resourceIds[0].toUpperCase()],
    window: { start: "2026-09-01", end: "2026-09-07" },
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-15T09:00:00Z"))
  state.user = { id: "user_1", email: "consultant@example.test" }
  state.askLevel = "chat"
  state.scopeVerified = true
  state.secretExpiresAt = "2099-01-01T00:00:00.000Z"
  state.connectorMissing = false
  state.listingAvailable = true
  state.finished = PULL
  state.created = []
  state.executed = 0
})

describe("refusals before anything runs", () => {
  test("401 without a session", async () => {
    state.user = undefined
    expect((await post(body())).status).toBe(401)
  })

  test("400 for no machines or an extra key", async () => {
    expect((await post(body({ resourceIds: [] }))).status).toBe(400)
    expect((await post(body({ runId: "x" }))).status).toBe(400)
  })

  test.each([
    [{ start: "2026-09-10", end: "2026-09-16" }, /after today/],
    [{ start: "2026-05-01", end: "2026-05-07" }, /93 days/],
  ])("422 for the window %j", async (window, message) => {
    const response = await post(body({ window }))
    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(message)
    expect(state.created).toHaveLength(0)
  })

  test("404 where Ask is read-only, before the connector is read", async () => {
    state.askLevel = "read"
    expect((await post(body())).status).toBe(404)
    expect(state.created).toHaveLength(0)
  })

  test("404 for a connector the user cannot read", async () => {
    state.connectorMissing = true
    expect((await post(body())).status).toBe(404)
  })

  test("422 for an unverified scope or an expired secret", async () => {
    state.scopeVerified = false
    expect((await post(body())).status).toBe(422)
    state.scopeVerified = true
    state.secretExpiresAt = "2026-01-01T00:00:00.000Z"
    expect((await post(body())).status).toBe(422)
    expect(state.executed).toBe(0)
  })

  test("422 for a machine the connector does not see", async () => {
    const response = await post(body({ resourceIds: ["/subscriptions/x/other-vm"] }))
    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "RESOURCE_NOT_VISIBLE"
    )
    expect(state.created).toHaveLength(0)
  })
})

describe("a pull", () => {
  test("201 with the browser-safe view, using the listing's own ids and names", async () => {
    const response = await post(body())
    expect(response.status).toBe(201)
    const { pull } = (await response.json()) as { pull: Record<string, unknown> }
    expect(pull).toMatchObject({ id: "pull_1", status: "complete", resourceNames: ["cpn-app"] })
    expect(pull).not.toHaveProperty("userId")
    expect(state.created).toEqual([
      expect.objectContaining({
        resourceIds: [PULL.resourceIds[0]],
        resourceNames: ["cpn-app"],
        window: { start: "2026-09-01", end: "2026-09-07" },
      }),
    ])
  })

  test("a failed collection is a 502 carrying its message", async () => {
    state.finished = { ...PULL, status: "failed", errorCode: "TIMEOUT", errorMessage: "The collection took too long." }
    const response = await post(body())
    expect(response.status).toBe(502)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("TIMEOUT")
  })
})
