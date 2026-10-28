import { beforeEach, describe, expect, test, vi } from "vitest"

import { emptyDraftV4 } from "@/lib/builder/draft"
import { createBuilderStore } from "@/lib/builder/store"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

/**
 * `POST /api/report-profiles/ask-block` — Ask on a block. Faked: the session and the model
 * call. What is left is what the route accepts and how it answers.
 */

const state = vi.hoisted(() => ({
  user: { id: "user-1", email: "user@example.test" } as { id: string; email: string } | null,
  reply: "" as string | Error,
}))

vi.mock("@/lib/auth/guard", () => ({ requireSessionForApi: async () => state.user }))
vi.mock("@/lib/presets/converse", () => ({
  converse: async () => {
    if (state.reply instanceof Error) throw state.reply
    return state.reply
  },
}))

const { POST } = await import("@/app/api/report-profiles/ask-block/route")

function body(overrides: Record<string, unknown> = {}) {
  const s = createBuilderStore({ initial: emptyDraftV4("Test", "aws"), catalog: METRIC_CATALOG })
  const sectionId = s.getState().addSection("ec2_utilization")!
  return {
    definition: s.getState().definition,
    sectionId,
    ref: { kind: "slot", slot: "chart", inEach: true },
    request: "make it taller",
    ...overrides,
  }
}

function post(payload: unknown) {
  return POST(new Request("http://localhost/api/report-profiles/ask-block", { method: "POST", body: JSON.stringify(payload) }))
}

beforeEach(() => {
  state.user = { id: "user-1", email: "user@example.test" }
  state.reply = JSON.stringify({ set: { "style.height": "tall" }, summary: "Taller.", not_applied: [] })
})

describe("POST /api/report-profiles/ask-block", () => {
  test("answers with the settings to change", async () => {
    const response = await post(body())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ set: { "style.height": "tall" }, summary: "Taller.", notApplied: [] })
  })

  test("needs a session", async () => {
    state.user = null
    expect((await post(body())).status).toBe(401)
  })

  test.each([
    ["an empty wish", { request: "   " }],
    ["a wish that is too long", { request: "x".repeat(501) }],
    ["an older preset format", { definition: { ...body().definition, schema_version: 3 } }],
    ["an unknown block shape", { ref: { kind: "row" } }],
  ])("refuses %s", async (_, overrides) => {
    expect((await post(body(overrides))).status).toBe(400)
  })

  test("a block that is gone is unprocessable", async () => {
    expect((await post(body({ ref: { kind: "added", id: "gone" } }))).status).toBe(422)
  })

  test("a model that cannot answer is unavailable", async () => {
    state.reply = new Error("throttled")
    const response = await post(body())
    expect(response.status).toBe(503)
  })
})
