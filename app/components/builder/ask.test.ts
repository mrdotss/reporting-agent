import { describe, expect, test } from "vitest"

import { builderIssues } from "@/lib/builder/issues"
import { emptyDraftV4 } from "@/lib/builder/draft"
import { createBuilderStore, type BlockRef } from "@/lib/builder/store"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

import { applyAsk, askBlock, askChanges, cleanAsk } from "./ask"

/**
 * Ask on a block: which settings each kind of block offers, what an answer may set, and
 * that applying one is the edit the inspector would have made.
 */

function draft() {
  const s = createBuilderStore({ initial: emptyDraftV4("Test", "aws"), catalog: METRIC_CATALOG })
  s.getState().edit((d) => {
    d.identity.customer_name = "Contoso"
  })
  const util = s.getState().addSection("ec2_utilization")!
  return { s, util }
}

const chart: BlockRef = { kind: "slot", slot: "chart", inEach: true }
const fleet: BlockRef = { kind: "slot", slot: "fleet", inEach: false }
const keys = (block: ReturnType<typeof askBlock>) => block?.fields.map((field) => field.key)

describe("askBlock", () => {
  test("a chart offers its look and the section's ranking, and says what they are now", () => {
    const { s, util } = draft()
    const block = askBlock(s.getState().definition, util, chart)!
    expect(block.cloud).toBe("AWS")
    expect(keys(block)).toEqual(expect.arrayContaining(["hidden", "style.look", "style.height", "style.values", "style.threshold", "section.sort"]))
    expect(block.values["style.height"]).toBeNull()
    expect(block.values.hidden).toBe(false)
  })

  test("a table offers rows and header but no chart look", () => {
    const { s, util } = draft()
    const block = askBlock(s.getState().definition, util, fleet)!
    expect(keys(block)).toEqual(expect.arrayContaining(["style.rows", "style.header", "style.mark_at_or_above"]))
    expect(keys(block)).not.toContain("style.look")
  })

  test("a callout offers its words, condition, tone and threshold", () => {
    const { s, util } = draft()
    const id = s.getState().addBlock(util, "callout")!
    const block = askBlock(s.getState().definition, util, { kind: "added", id })!
    expect(keys(block)).toEqual(expect.arrayContaining(["text.en", "text.id", "when", "tone", "threshold"]))
  })

  test("a block that is gone has nothing to ask", () => {
    const { s, util } = draft()
    expect(askBlock(s.getState().definition, util, { kind: "added", id: "nope" })).toBeNull()
    expect(askBlock(s.getState().definition, "nope", chart)).toBeNull()
  })
})

describe("cleanAsk", () => {
  test("keeps listed fields at allowed values, drops the rest, and skips what is unchanged", () => {
    const { s, util } = draft()
    const block = askBlock(s.getState().definition, util, chart)!
    const { set, dropped } = cleanAsk(block, {
      "style.height": "tall",
      "style.look": "rainbow",
      "style.threshold": 500,
      "style.values": null,
      colour: "red",
      hidden: false,
    })
    expect(set).toEqual({ "style.height": "tall" })
    expect([...dropped].sort()).toEqual(["colour", "style.look", "style.threshold"])
  })

  test("an answer that is not an object sets nothing", () => {
    const { s, util } = draft()
    const block = askBlock(s.getState().definition, util, chart)!
    expect(cleanAsk(block, ["style.height"])).toEqual({ set: {}, dropped: [] })
  })
})

describe("applyAsk", () => {
  test("applies through the store's actions, as the inspector would", () => {
    const { s, util } = draft()
    const before = s.getState().definition
    const after = applyAsk(before, METRIC_CATALOG, util, chart, { "style.height": "tall", "style.threshold": 80, hidden: true })
    s.getState().setSlotStyle(util, chart, { height: "tall", threshold: 80 })
    s.getState().toggleHidden(util, chart)
    expect(after).toEqual(s.getState().definition)
    expect(before).not.toEqual(after)
  })

  test("callout words and condition, and the section's order", () => {
    const { s, util } = draft()
    const id = s.getState().addBlock(util, "callout")!
    const ref: BlockRef = { kind: "added", id }
    const after = applyAsk(s.getState().definition, METRIC_CATALOG, util, ref, {
      "text.en": "Machines that ran hot",
      when: "peak_at_or_above",
      tone: "attention",
      "section.sort": "ascending",
    })
    const block = askBlock(after, util, ref)!
    expect(block.values).toMatchObject({ "text.en": "Machines that ran hot", when: "peak_at_or_above", tone: "attention", threshold: 80 })
    expect(after.sections.find((section) => section.id === util)?.selection?.sort).toBe("ascending")
    expect(builderIssues(after)).toEqual([])
  })
})

describe("askChanges", () => {
  test("reads as before and after in the inspector's words", () => {
    const { s, util } = draft()
    const block = askBlock(s.getState().definition, util, chart)!
    expect(askChanges(block, { "style.height": "tall", hidden: true })).toEqual([
      { key: "hidden", label: "Hidden", before: "No", after: "Yes" },
      { key: "style.height", label: "Chart height", before: "Normal", after: "Tall" },
    ])
  })
})
