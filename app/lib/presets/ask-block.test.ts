import { beforeEach, describe, expect, test, vi } from "vitest"

import { emptyDraftV4 } from "@/lib/builder/draft"
import { createBuilderStore, type BlockRef } from "@/lib/builder/store"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

/**
 * Ask on a block, with the model faked: what reaches the model, and what of its answer
 * survives the field list and the validator.
 */

const model = vi.hoisted(() => ({ reply: "" as string | Error, calls: [] as { system: string; user: string }[] }))

vi.mock("@/lib/presets/converse", () => ({
  converse: async (system: string, user: string) => {
    model.calls.push({ system, user })
    if (model.reply instanceof Error) throw model.reply
    return model.reply
  },
}))

const { askOnBlock, AskBlockGoneError, AskUnavailableError } = await import("./ask-block")

function draft() {
  const s = createBuilderStore({ initial: emptyDraftV4("Test", "aws"), catalog: METRIC_CATALOG })
  s.getState().edit((d) => {
    d.identity.customer_name = "Contoso"
  })
  const util = s.getState().addSection("ec2_utilization")!
  const id = s.getState().addBlock(util, "text")!
  s.getState().setText(util, id, "en", "Busy machines")
  return { definition: s.getState().definition, util, id }
}

const chart: BlockRef = { kind: "slot", slot: "chart", inEach: true }

beforeEach(() => {
  model.reply = ""
  model.calls = []
})

describe("askOnBlock", () => {
  test("tells the model the block's fields and values, and returns the before and after", async () => {
    const { definition, util } = draft()
    model.reply = 'Sure: {"set": {"style.height": "tall"}, "summary": "Makes the chart taller.", "not_applied": []}'
    const answer = await askOnBlock(definition, util, chart, "make it taller")
    expect(model.calls[0]!.system).toContain('"style.height"')
    expect(model.calls[0]!.system).toContain("AWS")
    expect(model.calls[0]!.user).toContain("make it taller")
    expect(answer.set).toEqual({ "style.height": "tall" })
    expect(answer.changes).toEqual([{ key: "style.height", label: "Chart height", before: "Normal", after: "Tall" }])
    expect(answer.summary).toBe("Makes the chart taller.")
  })

  test("drops fields the block does not have and says so", async () => {
    const { definition, util } = draft()
    model.reply = JSON.stringify({ set: { "style.height": "tall", colour: "red" }, summary: "", not_applied: ["No colour setting."] })
    const answer = await askOnBlock(definition, util, chart, "taller and red")
    expect(answer.set).toEqual({ "style.height": "tall" })
    expect(answer.notApplied[0]).toBe("No colour setting.")
    expect(answer.notApplied).toHaveLength(2)
  })

  test("drops a change the validator refuses, with its reason, and keeps the rest", async () => {
    const { definition, util, id } = draft()
    model.reply = JSON.stringify({ set: { "text.en": "Top 5 busy machines" }, summary: "", not_applied: [] })
    const answer = await askOnBlock(definition, util, { kind: "added", id }, "say top 5")
    expect(answer.set).toEqual({})
    expect(answer.notApplied.join(" ")).toMatch(/^Words \(English\): /)
  })

  test("a model that cannot be reached, or answers no JSON, changes nothing", async () => {
    const { definition, util } = draft()
    model.reply = new Error("throttled")
    await expect(askOnBlock(definition, util, chart, "taller")).rejects.toBeInstanceOf(AskUnavailableError)
    model.reply = "I cannot help with that."
    await expect(askOnBlock(definition, util, chart, "taller")).rejects.toBeInstanceOf(AskUnavailableError)
  })

  test("a block that is gone is refused before the model is asked", async () => {
    const { definition, util } = draft()
    await expect(askOnBlock(definition, util, { kind: "added", id: "nope" }, "taller")).rejects.toBeInstanceOf(AskBlockGoneError)
    expect(model.calls).toHaveLength(0)
  })
})
