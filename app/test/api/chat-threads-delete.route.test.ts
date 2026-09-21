import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * `DELETE /api/chat/threads/[threadId]` — delete a conversation and its messages.
 *
 * ## Claims tested
 *
 * 1. **Only its author deletes it.** A conversation is shared with everyone who can use Ask
 *    in the workspace, so a teammate's delete is refused with 403, not silently obeyed.
 * 2. **A thread outside the user's workspaces is a 404**, the same as one that never existed,
 *    so the route tells nobody which ids are real.
 * 3. **Signing in is required**, and nothing is deleted for a caller without a session.
 */

const { state } = vi.hoisted(() => ({
  state: {
    user: undefined as { id: string; email: string } | undefined,
    thrown: undefined as Error | undefined,
    deleted: [] as { userId: string; threadId: string }[],
  },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => state.user ?? null,
}))

vi.mock("@/lib/chat/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/chat/store")>()
  return {
    ...original,
    deleteThread: async (userId: string, threadId: string) => {
      if (state.thrown !== undefined) throw state.thrown
      state.deleted.push({ userId, threadId })
    },
  }
})

const { DELETE } = await import("@/app/api/chat/threads/[threadId]/route")
const { ChatThreadNotFoundError, ChatThreadNotYoursError } = await import("@/lib/chat/store")

const THREAD_ID = "0000000000123456789abcdef0"

function call(): Promise<Response> {
  return DELETE(new Request(`http://localhost/api/chat/threads/${THREAD_ID}`, { method: "DELETE" }), {
    params: Promise.resolve({ threadId: THREAD_ID }),
  })
}

beforeEach(() => {
  state.user = { id: "user_1", email: "owner@example.com" }
  state.thrown = undefined
  state.deleted = []
})

describe("DELETE /api/chat/threads/[threadId]", () => {
  test("the author's delete goes through", async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(state.deleted).toEqual([{ userId: "user_1", threadId: THREAD_ID }])
  })

  test("a teammate is refused, and told why", async () => {
    state.thrown = new ChatThreadNotYoursError()
    const response = await call()
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "NOT_THREAD_AUTHOR"
    )
  })

  test("a conversation the user cannot read is a 404", async () => {
    state.thrown = new ChatThreadNotFoundError()
    expect((await call()).status).toBe(404)
  })

  test("no session deletes nothing", async () => {
    state.user = undefined
    expect((await call()).status).toBe(401)
    expect(state.deleted).toEqual([])
  })
})
