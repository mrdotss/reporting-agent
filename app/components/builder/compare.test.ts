import { describe, expect, test } from "vitest"

import { emptyDraftV4 } from "@/lib/builder/draft"
import { createBuilderStore } from "@/lib/builder/store"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

import { compareToLive } from "./compare"

/**
 * Compare to the live version: the draft's outline changes, one line each, and nothing for
 * what a save adds on its own.
 */

function published() {
  const s = createBuilderStore({ initial: emptyDraftV4("Test", "aws"), catalog: METRIC_CATALOG })
  s.getState().addSection("ec2_instances")
  const util = s.getState().addSection("ec2_utilization")!
  const backups = s.getState().addSection("backups")!
  return { s, live: s.getState().definition, util, backups }
}

describe("compareToLive", () => {
  test("an unchanged draft has no changes", () => {
    const { live } = published()
    expect(compareToLive(live, structuredClone(live))).toEqual([])
  })

  test("the pinned number format and stored cover keys are not changes", () => {
    const { live } = published()
    const draft = structuredClone(live) as { -readonly [K in keyof typeof live]: (typeof live)[K] }
    const design = draft.design as Record<string, unknown>
    const format = (design.number_format ?? {}) as Record<string, unknown>
    design.number_format = { ...format, trim_trailing_zeros: true, bytes_as_gib: true }
    draft.front_matter = { ...draft.front_matter, cover: { ...(draft.front_matter.cover as object), logo_key: "logos/a.png" } }
    expect(compareToLive(live, draft)).toEqual([])
  })

  test("a document detail is one document-wide change", () => {
    const { s, live } = published()
    s.getState().edit((draft) => {
      draft.identity.customer_name = "Contoso"
    })
    expect(compareToLive(live, s.getState().definition)).toEqual([{ kind: "changed", text: "Document details changed" }])
  })

  test("an added section links to it, a removed one does not", () => {
    const { s, live, backups } = published()
    s.getState().removeSection(backups)
    const added = s.getState().addSection("ec2_utilization")!
    const changes = compareToLive(live, s.getState().definition)
    expect(changes.find((change) => change.kind === "added")?.sectionId).toBe(added)
    const removed = changes.find((change) => change.kind === "removed")
    expect(removed).toBeDefined()
    expect(removed?.sectionId).toBeUndefined()
  })

  test("moving one section reports that section only", () => {
    const azure = createBuilderStore({ initial: emptyDraftV4("Test", "azure"), catalog: METRIC_CATALOG })
    const a = azure.getState().addSection("azure_subscription")!
    azure.getState().addSection("virtual_machines")
    const c = azure.getState().addSection("public_ip_addresses")!
    const before = azure.getState().definition
    azure.getState().moveSectionTo(c, a)
    const changes = compareToLive(before, azure.getState().definition)
    expect(changes.filter((change) => change.kind === "moved").map((change) => change.sectionId)).toEqual([c])
    expect(changes.map((change) => change.kind)).toEqual(["moved"])
  })

  test("an added block and a hidden block are changes in their section", () => {
    const { s, live, util } = published()
    s.getState().addBlock(util, "text")
    const ref = { kind: "slot" as const, slot: "fleet", inEach: false }
    s.getState().toggleHidden(util, ref)
    const changes = compareToLive(live, s.getState().definition)
    expect(changes.every((change) => change.sectionId === util)).toBe(true)
    expect(changes.some((change) => change.kind === "added" && change.text.endsWith("added"))).toBe(true)
    expect(changes.some((change) => change.kind === "changed" && change.text.endsWith("hidden"))).toBe(true)
  })
})
