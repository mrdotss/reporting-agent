import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * `POST /api/report-profiles/[id]/agent-try` — the builder's Try it on an agent paragraph.
 *
 * Faked: the session, the preset and connection reads, the snapshot lookup and the runtime.
 * What is left is what the route decides — who may try what against which connection, what
 * it sends the runtime, and how the paragraph the runtime's `done` carries is answered.
 */

const state = vi.hoisted(() => ({
  user: { id: "user-1", email: "user@example.test" } as { id: string; email: string } | null,
  template: { id: "tmpl-1", provider: "aws", workspaceId: "ws-1", projectId: "pr-1" } as Record<string, unknown> | null,
  source: { id: "conn-1", provider: "aws", status: "active", workspaceId: "ws-1", projectId: "pr-1" } as Record<string, unknown> | null,
  snapshot: {
    actorId: "user-1",
    runId: "run-9",
    snapshotId: "snap-9",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    timezone: "Asia/Jakarta",
  } as Record<string, unknown> | null,
  frames: [] as Record<string, unknown>[],
  invocations: [] as Record<string, unknown>[],
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

vi.mock("@/lib/templates/preview", () => ({
  mostRecentSnapshotRun: async () => state.snapshot,
  newPreviewId: () => "pv-try",
}))

vi.mock("@/lib/aws/agentcore", () => ({
  COMMAND_TRY_AGENT: "try_agent",
  invokeAgentRuntime: async (request: Record<string, unknown>) => {
    state.invocations.push(request)
    const encoder = new TextEncoder()
    // Split mid-frame, as the network does.
    const text = state.frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
    const half = Math.floor(text.length / 2)
    return (async function* () {
      yield encoder.encode(text.slice(0, half))
      yield encoder.encode(text.slice(half))
    })()
  },
}))

const { POST } = await import("@/app/api/report-profiles/[id]/agent-try/route")

const DRAFT = { schema_version: 4, provider: "aws", identity: { name: "Draft" }, sections: [] }

function call(body: Record<string, unknown> = { connectedSubscriptionId: "conn-1", definition: DRAFT, blockId: "sec_a__u_ag1" }) {
  return POST(
    new Request("http://localhost/api/report-profiles/tmpl-1/agent-try", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "tmpl-1" }) }
  )
}

beforeEach(() => {
  state.user = { id: "user-1", email: "user@example.test" }
  state.template = { id: "tmpl-1", provider: "aws", workspaceId: "ws-1", projectId: "pr-1" }
  state.source = { id: "conn-1", provider: "aws", status: "active", workspaceId: "ws-1", projectId: "pr-1" }
  state.snapshot = {
    actorId: "user-1",
    runId: "run-9",
    snapshotId: "snap-9",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    timezone: "Asia/Jakarta",
  }
  state.frames = [
    { type: "step", status: "done" },
    {
      type: "done",
      status: "completed",
      agent: { block_id: "sec_a__u_ag1", outcome: "written", reason: "written", text: "web peaked at 97.2%.", figures: 6 },
    },
  ]
  state.invocations = []
})

describe("who may try what", () => {
  test("a request with no session is refused before anything is read", async () => {
    state.user = null
    expect((await call()).status).toBe(401)
    expect(state.invocations).toEqual([])
  })

  test("another user's preset or connection, or another project's, is not found", async () => {
    state.template = null
    expect((await call()).status).toBe(404)
    state.template = { id: "tmpl-1", provider: "aws", workspaceId: "ws-1", projectId: "pr-1" }
    state.source = { id: "conn-1", provider: "aws", status: "active", workspaceId: "ws-1", projectId: "pr-2" }
    expect((await call()).status).toBe(404)
    expect(state.invocations).toEqual([])
  })

  test("an AWS preset is not tried against an Azure connection", async () => {
    state.source = { id: "conn-1", provider: "azure", status: "active", workspaceId: "ws-1", projectId: "pr-1" }
    const response = await call()
    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("PROVIDER_MISMATCH")
  })

  test("a connection with no completed report says so", async () => {
    state.snapshot = null
    expect(((await (await call()).json()) as { error: { code: string } }).error.code).toBe("NO_SNAPSHOT")
    expect(state.invocations).toEqual([])
  })

  test("a block id that is not an agent paragraph's is refused by the schema", async () => {
    const response = await call({ connectedSubscriptionId: "conn-1", definition: DRAFT, blockId: "../reports" })
    expect(response.status).toBe(400)
    expect(state.invocations).toEqual([])
  })
})

describe("the try", () => {
  test("sends the draft inline against the latest run and answers with the paragraph", async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      outcome: "written",
      reason: "written",
      text: "web peaked at 97.2%.",
      figures: 6,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
    })
    expect(state.invocations[0]!.command).toMatchObject({
      command: "try_agent",
      snapshot_run_id: "run-9",
      block_id: "sec_a__u_ag1",
      definition: { schema_version: 4, provider: "aws" },
    })
  })

  test("a refused paragraph is an answer, not an error", async () => {
    state.frames = [
      { type: "done", status: "completed", agent: { block_id: "sec_a__u_ag1", outcome: "note", reason: "unprovable_figures", text: "", figures: 6 } },
    ]
    const body = (await (await call()).json()) as { outcome: string; reason: string }
    expect(body).toMatchObject({ outcome: "note", reason: "unprovable_figures" })
  })

  test("a draft the runtime cannot compile reads as a failed try", async () => {
    state.frames = [{ type: "error", code: "COMPILE_FAILED" }, { type: "done", status: "failed" }]
    const response = await call()
    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("AGENT_TRY_FAILED")
  })
})
