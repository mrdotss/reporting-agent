import { describe, expect, test } from "vitest"

import { assistantMessageFrom, citationsFrom, proposalFrom } from "@/lib/chat/outcome"
import { SlidingWindowLimiter } from "@/lib/chat/rate-limit"
import type { ProposalTarget } from "@/lib/chat/sources"

const TARGET: ProposalTarget = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  connectedSubscriptionId: "sub_1",
  customerName: "Satu Data Labs",
  connectorLabel: "satu-prod",
  provider: "azure",
}
const TARGETS = new Map([["t1", TARGET]])

describe("citationsFrom — the runtime's citations, trusted by shape only", () => {
  test("keeps well-formed entries and their string fields", () => {
    expect(
      citationsFrom({
        f1: { fact_id: "f1", source: "report", label: "vm · cpu · avg", formatted: "8.06%", depth: 3 },
      })
    ).toEqual({ f1: { fact_id: "f1", source: "report", label: "vm · cpu · avg", formatted: "8.06%" } })
  })

  test("drops malformed ids and entries without a label or string", () => {
    expect(
      citationsFrom({
        "__proto__x": { label: "a", formatted: "1" },
        f2: { label: "a" },
        f3: "8.06%",
      })
    ).toEqual({})
    expect(citationsFrom(null)).toEqual({})
  })
})

describe("proposalFrom — only for a target this turn offered", () => {
  test("resolves the opaque id to the customer and connector", () => {
    expect(proposalFrom({ target_id: "t1", period: "2026-09" }, TARGETS)).toEqual({
      ...TARGET,
      period: "2026-09",
      state: "open",
    })
  })

  test.each([
    [{ target_id: "t9", period: "2026-09" }],
    [{ target_id: "t1", period: "September" }],
    [{ period: "2026-09" }],
    ["t1"],
  ])("refuses %j", (value) => {
    expect(proposalFrom(value, TARGETS)).toBeUndefined()
  })
})

describe("assistantMessageFrom", () => {
  test("a completed turn keeps its citations, proposal and flags", () => {
    const message = assistantMessageFrom({
      authorId: "user_1",
      text: "CPU ⟦fig:f1⟧8.06%⟦/fig⟧.",
      steps: [{ name: "compose_answer", label: "Answer", status: "Writing" }],
      outcome: {
        citations: { f1: { label: "cpu", formatted: "8.06%" } },
        proposal: { target_id: "t1", period: "2026-09" },
        unavailable_runs: [{ run_id: "r", reason: "x" }],
        prices_unavailable: ["Standard_D4s_v5 (eastus)"],
      },
      failure: undefined,
      targets: TARGETS,
    })
    expect(message.failed).toBeUndefined()
    expect(Object.keys(message.citations)).toEqual(["f1"])
    expect(message.proposal?.customerName).toBe("Satu Data Labs")
    expect(message.unavailableRuns).toBe(1)
    expect(message.pricesUnavailable).toBe(true)
  })

  test("a turn with no outcome is stored as failed, with no citation or proposal", () => {
    const message = assistantMessageFrom({
      authorId: "user_1",
      text: "",
      steps: [],
      outcome: undefined,
      failure: "The assistant could not be reached.",
      targets: TARGETS,
    })
    expect(message).toMatchObject({ failed: true, text: "The assistant could not be reached.", citations: {} })
    expect(message.proposal).toBeUndefined()
  })
})

describe("SlidingWindowLimiter", () => {
  test("allows up to the limit inside the window, then refuses until it slides", () => {
    const limiter = new SlidingWindowLimiter(2, 1000)
    expect(limiter.allow("u", 0)).toBe(true)
    expect(limiter.allow("u", 10)).toBe(true)
    expect(limiter.allow("u", 20)).toBe(false)
    expect(limiter.allow("other", 20)).toBe(true)
    expect(limiter.allow("u", 1001)).toBe(true)
  })
})
