import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * `POST /api/admin/ask-access` (roles-and-ask-access Req 7).
 *
 * ## Claims tested
 *
 * 1. **Only a platform admin reaches it** — anyone else, and everyone while the variable is
 *    unset, gets a 404 and nothing is written.
 * 2. **A cross-site request is refused** like the workspace mutations.
 * 3. **The grant is made as the signed-in admin**, for the account the body names.
 */

const { state } = vi.hoisted(() => ({
  state: {
    user: undefined as { id: string; email: string } | undefined,
    refuse: false,
    calls: [] as unknown[],
  },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => state.user ?? null,
}))

vi.mock("@/lib/admin/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/admin/platform")>()
  const { WorkspaceAccessError } = await import("@/lib/workspaces/access")
  return {
    ...original,
    setAskAccess: async (input: unknown) => {
      if (state.refuse) throw new WorkspaceAccessError()
      state.calls.push(input)
      return "2026-09-15T12:00:00.000Z"
    },
  }
})

import { POST } from "@/app/api/admin/ask-access/route"

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://reporting.test/api/admin/ask-access", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  )
}

beforeEach(() => {
  vi.stubEnv("RPT_PLATFORM_ADMIN_EMAILS", " Admin@Example.test , other-admin@example.test")
  state.user = { id: "admin_1", email: "admin@example.test" }
  state.refuse = false
  state.calls = []
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("POST /api/admin/ask-access", () => {
  test("401 without a session", async () => {
    state.user = undefined
    expect((await post({ userId: "user_3", enabled: true })).status).toBe(401)
  })

  test("404 for an account that is not a platform admin, and nothing is written", async () => {
    state.user = { id: "user_2", email: "consultant@example.test" }
    expect((await post({ userId: "user_3", enabled: true })).status).toBe(404)
    expect(state.calls).toHaveLength(0)
  })

  test("404 for everyone while the variable is unset", async () => {
    vi.stubEnv("RPT_PLATFORM_ADMIN_EMAILS", "")
    expect((await post({ userId: "user_3", enabled: true })).status).toBe(404)
    expect(state.calls).toHaveLength(0)
  })

  test("404 for a cross-site request", async () => {
    const response = await post({ userId: "user_3", enabled: true }, { "sec-fetch-site": "cross-site" })
    expect(response.status).toBe(404)
    expect(state.calls).toHaveLength(0)
  })

  test("400 for a body missing a field or carrying another", async () => {
    expect((await post({ userId: "user_3" })).status).toBe(400)
    expect((await post({ userId: "user_3", enabled: true, role: "owner" })).status).toBe(400)
  })

  test("grants Ask as the signed-in admin", async () => {
    const response = await post({ userId: "user_3", enabled: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId: "user_3", grantedAt: "2026-09-15T12:00:00.000Z" })
    expect(state.calls).toEqual([
      { admin: { id: "admin_1", email: "admin@example.test" }, userId: "user_3", enabled: true },
    ])
  })

  test("404 when the account cannot be granted", async () => {
    state.refuse = true
    expect((await post({ userId: "admin_2", enabled: true })).status).toBe(404)
  })
})
