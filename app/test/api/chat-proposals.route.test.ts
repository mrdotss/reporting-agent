import { beforeEach, describe, expect, test, vi } from "vitest"

import type { ChatMessageView, ChatProposal, ChatThreadView } from "@/lib/chat/views"

/**
 * `GET|POST /api/chat/threads/[threadId]/proposals/[messageId]` (ask-chat Req 6).
 *
 * ## Claims tested
 *
 * 1. **A proposal enqueues nothing by itself** — only `request` calls `enqueueRun`, with the
 *    proposal's own workspace, customer and connector, never ids from the body.
 * 2. **It closes once** — an already closed proposal, or one closed by a teammate in the same
 *    moment, is a 409.
 * 3. **Dismissing needs edit access** and creates no run.
 * 4. **The preset list is the proposal's** — scoped to its customer and connector source.
 */

const THREAD: ChatThreadView = {
  id: "0000000000123456789abcdef0",
  workspaceId: "ws_1",
  title: "Right-sizing Satu",
  createdBy: "user_1",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  messageCount: 2,
  attachments: { runIds: ["run_1"], connectorIds: [] },
}

const OPEN: ChatProposal = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  connectedSubscriptionId: "sub_1",
  customerName: "Satu Data Labs",
  connectorLabel: "satu-prod",
  provider: "azure",
  period: "2026-09",
  state: "open",
}

const { state } = vi.hoisted(() => ({
  state: {
    user: undefined as { id: string; email: string } | undefined,
    proposal: undefined as ChatProposal | undefined,
    closeThrows: false,
    closed: [] as { state: string; runId?: string }[],
    enqueued: [] as unknown[],
    presetScope: undefined as unknown,
    editDenied: false,
  },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => state.user ?? null,
}))

vi.mock("@/lib/workspaces/access", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/workspaces/access")>()
  return {
    ...original,
    requireWorkspace: async () => {
      if (state.editDenied) throw new original.WorkspaceAccessError()
      return "editor"
    },
  }
})

vi.mock("@/lib/chat/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/chat/store")>()
  return {
    ...original,
    readThread: async () => THREAD,
    readMessage: async (): Promise<ChatMessageView | undefined> =>
      state.proposal === undefined
        ? undefined
        : {
            id: "m1",
            threadId: THREAD.id,
            role: "assistant",
            text: "Proposing.",
            authorId: "user_1",
            createdAt: "2026-09-15T01:00:00.000Z",
            citations: {},
            steps: [],
            proposal: state.proposal,
          },
    closeProposal: async (_thread: unknown, _id: string, next: string, runId?: string) => {
      if (state.closeThrows) throw new original.ChatProposalClosedError()
      state.closed.push({ state: next, runId })
    },
  }
})

vi.mock("@/lib/chat/sources", () => ({
  listProposalPresets: async (_user: string, scope: unknown, provider: string) => {
    state.presetScope = { scope, provider }
    return [{ id: "tpl_1", name: "Monthly Utilization", provider: "azure", currentVersion: 6 }]
  },
}))

vi.mock("@/lib/actions/runs", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/actions/runs")>()
  return {
    ...original,
    enqueueRun: async (_user: string, input: unknown) => {
      state.enqueued.push(input)
      return { run: { id: "run_9" }, deduplicated: false }
    },
  }
})

import { GET, POST } from "@/app/api/chat/threads/[threadId]/proposals/[messageId]/route"

const CONTEXT = { params: Promise.resolve({ threadId: THREAD.id, messageId: "m1" }) }

function post(body: unknown) {
  return POST(
    new Request("http://test/api/chat/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ threadId: THREAD.id, messageId: "m1" }) }
  )
}

beforeEach(() => {
  state.user = { id: "user_1", email: "consultant@example.test" }
  state.proposal = OPEN
  state.closeThrows = false
  state.closed = []
  state.enqueued = []
  state.presetScope = undefined
  state.editDenied = false
})

describe("GET", () => {
  test("lists presets for the proposal's customer and connector source", async () => {
    const response = await GET(new Request("http://test"), CONTEXT)
    expect(response.status).toBe(200)
    expect(state.presetScope).toEqual({
      scope: { workspaceId: "ws_1", projectId: "proj_1" },
      provider: "azure",
    })
  })

  test("404 for a message with no proposal", async () => {
    state.proposal = undefined
    expect((await GET(new Request("http://test"), CONTEXT)).status).toBe(404)
  })
})

describe("POST request", () => {
  test("enqueues with the proposal's own scope and closes it with the run id", async () => {
    const response = await post({ action: "request", templateId: "tpl_1" })
    expect(response.status).toBe(201)
    expect(state.enqueued).toEqual([
      expect.objectContaining({
        workspaceId: "ws_1",
        projectId: "proj_1",
        connectedSubscriptionId: "sub_1",
        templateId: "tpl_1",
        customerName: "Satu Data Labs",
      }),
    ])
    expect(state.closed).toEqual([{ state: "requested", runId: "run_9" }])
    const body = (await response.json()) as { proposal: ChatProposal }
    expect(body.proposal).toMatchObject({ state: "requested", runId: "run_9" })
  })

  test("a body naming another connector is refused, not honoured", async () => {
    const response = await post({ action: "request", templateId: "tpl_1", connectedSubscriptionId: "sub_other" })
    expect(response.status).toBe(400)
    expect(state.enqueued).toHaveLength(0)
  })

  test("409 when the proposal is already closed", async () => {
    state.proposal = { ...OPEN, state: "dismissed" }
    expect((await post({ action: "request", templateId: "tpl_1" })).status).toBe(409)
    expect(state.enqueued).toHaveLength(0)
  })

  test("409 when a teammate closed it in the same moment", async () => {
    state.closeThrows = true
    expect((await post({ action: "request", templateId: "tpl_1" })).status).toBe(409)
  })

  test("401 without a session", async () => {
    state.user = undefined
    expect((await post({ action: "request", templateId: "tpl_1" })).status).toBe(401)
  })
})

describe("POST dismiss", () => {
  test("closes the proposal without a run", async () => {
    const response = await post({ action: "dismiss" })
    expect(response.status).toBe(200)
    expect(state.closed).toEqual([{ state: "dismissed", runId: undefined }])
    expect(state.enqueued).toHaveLength(0)
  })

  test("a viewer without edit access gets a 404 and nothing closes", async () => {
    state.editDenied = true
    expect((await post({ action: "dismiss" })).status).toBe(404)
    expect(state.closed).toHaveLength(0)
  })
})
