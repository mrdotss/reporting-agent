import { beforeEach, describe, expect, test, vi } from "vitest"

import type { ChatMessageView, ChatThreadView } from "@/lib/chat/views"

/**
 * `POST /api/chat/threads/[threadId]/messages` (ask-chat Req 1, 7).
 *
 * ## Claims tested
 *
 * 1. **Auth, membership, body and rate limit are checked before anything is stored.**
 * 2. **No readable attachment, no turn** — a 422, and the question is not stored.
 * 3. **The stream relays steps and text, then the stored answer** — with citations and a
 *    proposal resolved from the target id this turn offered.
 * 4. **A failed turn is still stored**, marked failed, with the question kept.
 */

const THREAD: ChatThreadView = {
  id: "0000000000123456789abcdef0",
  workspaceId: "ws_1",
  title: "New conversation",
  createdBy: "user_1",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  messageCount: 0,
  attachments: { runIds: ["run_1"], connectorIds: [] },
}

const { state } = vi.hoisted(() => ({
  state: {
    user: undefined as { id: string; email: string } | undefined,
    threadMissing: false,
    allow: true,
    attachedRuns: 1,
    events: [] as unknown[],
    appended: [] as { message: ChatMessageView; title?: string }[],
  },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => state.user ?? null,
}))

vi.mock("@/lib/chat/rate-limit", () => ({
  chatLimiter: () => ({ allow: () => state.allow }),
}))

vi.mock("@/lib/chat/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/chat/store")>()
  return {
    ...original,
    readThread: async () => {
      if (state.threadMissing) throw new original.ChatThreadNotFoundError()
      return THREAD
    },
    listMessages: async () => [],
    appendMessage: async (
      thread: ChatThreadView,
      message: Omit<ChatMessageView, "id" | "threadId" | "createdAt">,
      options: { title?: string } = {}
    ) => {
      const saved = {
        ...message,
        id: `m${state.appended.length}`,
        threadId: thread.id,
        createdAt: "2026-09-15T01:00:00.000Z",
      } as ChatMessageView
      state.appended.push({ message: saved, title: options.title })
      return {
        message: saved,
        thread: { ...thread, title: options.title ?? thread.title, messageCount: thread.messageCount + 1 },
      }
    },
  }
})

vi.mock("@/lib/chat/sources", () => ({
  buildChatTurn: async () => ({
    command: {
      command: "chat",
      prompt: "q",
      history: [],
      attachments: { runs: [], scans: [] },
      request_targets: [],
    },
    targets: new Map([
      [
        "t1",
        {
          workspaceId: "ws_1",
          projectId: "proj_1",
          connectedSubscriptionId: "sub_1",
          customerName: "Satu Data Labs",
          connectorLabel: "satu-prod",
          provider: "azure",
        },
      ],
    ]),
    attachedRuns: state.attachedRuns,
    attachedScans: 0,
    attachedLive: 0,
  }),
}))

vi.mock("@/lib/chat/stream", () => ({
  streamChatTurn: async function* () {
    for (const event of state.events) yield event
  },
}))

vi.mock("@/lib/chat/title", () => ({
  generateTitle: async () => "Right-sizing Satu",
  fallbackTitle: (prompt: string) => `fallback: ${prompt}`,
}))

import { POST } from "@/app/api/chat/threads/[threadId]/messages/route"

function call(body: unknown) {
  return POST(
    new Request(`http://test/api/chat/threads/${THREAD.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ threadId: THREAD.id }) }
  )
}

async function events(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text()
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
}

beforeEach(() => {
  state.user = { id: "user_1", email: "consultant@example.test" }
  state.threadMissing = false
  state.allow = true
  state.attachedRuns = 1
  state.events = []
  state.appended = []
})

describe("refusals before anything is stored", () => {
  test("401 without a session", async () => {
    state.user = undefined
    expect((await call({ prompt: "hi" })).status).toBe(401)
  })

  test("404 for a thread outside the user's workspaces", async () => {
    state.threadMissing = true
    expect((await call({ prompt: "hi" })).status).toBe(404)
  })

  test("400 for a blank question or an extra key", async () => {
    expect((await call({ prompt: "   " })).status).toBe(400)
    expect((await call({ prompt: "hi", model: "other" })).status).toBe(400)
  })

  test("429 when the user is over the rate limit", async () => {
    state.allow = false
    expect((await call({ prompt: "hi" })).status).toBe(429)
    expect(state.appended).toHaveLength(0)
  })

  test("422 when nothing attached can be read, and the question is not stored", async () => {
    state.attachedRuns = 0
    const response = await call({ prompt: "hi" })
    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "NO_READABLE_ATTACHMENTS"
    )
    expect(state.appended).toHaveLength(0)
  })
})

describe("a completed turn", () => {
  test("relays steps and text, then stores the answer with citations and a resolved proposal", async () => {
    state.events = [
      { type: "tool", phase: "start", name: "compose_answer", label: "Answer", status: "Writing the answer" },
      { type: "delta", text: "CPU averaged ⟦fig:f1⟧8.06%⟦/fig⟧." },
      { type: "tool", phase: "end", name: "compose_answer", label: "Answer", status: "" },
      {
        type: "done",
        status: "completed",
        outcome: {
          citations: { f1: { fact_id: "f1", source: "report", label: "vm · cpu · avg", formatted: "8.06%" } },
          proposal: { target_id: "t1", period: "2026-09" },
        },
      },
    ]

    const response = await call({ prompt: "Which VMs look over-provisioned?" })
    expect(response.headers.get("Content-Type")).toContain("text/event-stream")
    const relayed = await events(response)

    expect(relayed.map((event) => event.type)).toEqual([
      "user_message",
      "step",
      "delta",
      "step",
      "message",
    ])

    const [question, answer] = state.appended
    expect(question.message).toMatchObject({ role: "user", text: "Which VMs look over-provisioned?" })
    expect(answer.message).toMatchObject({
      role: "assistant",
      text: "CPU averaged ⟦fig:f1⟧8.06%⟦/fig⟧.",
      steps: [{ name: "compose_answer", label: "Answer", status: "Writing the answer" }],
      proposal: { customerName: "Satu Data Labs", connectedSubscriptionId: "sub_1", state: "open" },
    })
    expect(Object.keys(answer.message.citations)).toEqual(["f1"])
    expect(answer.message.failed).toBeUndefined()
    expect(answer.title).toBe("Right-sizing Satu")
  })

  test("a proposal for a target this turn did not offer is not stored", async () => {
    state.events = [
      { type: "delta", text: "Sure." },
      { type: "done", status: "completed", outcome: { proposal: { target_id: "t9", period: "2026-09" } } },
    ]
    await events(await call({ prompt: "request a report" }))
    expect(state.appended[1].message.proposal).toBeUndefined()
  })
})

describe("a failed turn", () => {
  test("is stored as failed, keeps the question, and takes the fallback title", async () => {
    state.events = [{ type: "error", code: "INTERNAL_ERROR", message: "boom" }]
    const relayed = await events(await call({ prompt: "Why?" }))

    expect(relayed.at(-1)?.type).toBe("message")
    const [question, answer] = state.appended
    expect(question.message.text).toBe("Why?")
    expect(answer.message).toMatchObject({ role: "assistant", failed: true, citations: {} })
    expect(answer.message.text).toMatch(/could not answer/)
    expect(answer.title).toBe("fallback: Why?")
  })
})
