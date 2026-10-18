import fc from "fast-check"
import { describe, expect, test } from "vitest"

import { collectDefinitionIssues } from "@/lib/templates/definition"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

import { catalogueFor, type Provider } from "./catalogue"
import { emptyDraftV4 } from "./draft"
import { orderedSections, sectionLayout, visibleLayout } from "./model"
import { createBuilderStore, type BlockRef } from "./store"

function store(provider: Provider = "aws") {
  return createBuilderStore({ initial: emptyDraftV4("Test", provider), catalog: METRIC_CATALOG })
}

const definitionOf = (s: ReturnType<typeof store>) => s.getState().definition

describe("sections", () => {
  test("a section added to an empty draft is selected and seeded from its catalogue entry", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    const section = definitionOf(s).sections[0]!
    expect(section.id).toBe(id)
    expect(section.id.length).toBeLessThanOrEqual(24)
    expect(section.selection?.resource_types).toEqual(["AWS::EC2::Instance"])
    expect(section.metrics?.length).toBeGreaterThan(0)
    expect(s.getState().selection).toEqual({ kind: "section", sectionId: id })
  })

  test("a section lands at the end of its own group, whatever was selected", () => {
    const s = store()
    const util = s.getState().addSection("ec2_utilization")!
    const backups = s.getState().addSection("backups")!
    const inventory = s.getState().addSection("ec2_instances", backups)!
    const order = orderedSections(definitionOf(s)).map((section) => section.id)
    expect(order).toEqual([inventory, util, backups])
  })

  test("moving a section rewrites positions so the runtime prints it where it was dropped", () => {
    const s = store("azure")
    const a = s.getState().addSection("azure_subscription")!
    const b = s.getState().addSection("virtual_machines")!
    const c = s.getState().addSection("public_ip_addresses")!
    s.getState().moveSectionTo(c, a)
    expect(orderedSections(definitionOf(s)).map((x) => x.id)).toEqual([c, a, b])
  })

  test("a section does not move across groups, and a fixed one does not move at all", () => {
    const s = store()
    const util = s.getState().addSection("ec2_utilization")!
    const backups = s.getState().addSection("backups")!
    const before = definitionOf(s)
    s.getState().moveSectionTo(util, backups)
    s.getState().moveSectionTo(backups, util)
    expect(definitionOf(s)).toBe(before)
  })

  test("free closing sections print after the fixed ones", () => {
    const s = store()
    const housekeeping = s.getState().addSection("housekeeping")!
    const backups = s.getState().addSection("backups")!
    const rightsizing = s.getState().addSection("rightsizing")!
    expect(orderedSections(definitionOf(s)).map((x) => x.id)).toEqual([backups, rightsizing, housekeeping])
  })
})

describe("blocks", () => {
  const each = (slot: string): BlockRef => ({ kind: "slot", slot, inEach: true })

  test("hiding a block writes the section's layout out in full, with that block hidden", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    s.getState().toggleHidden(id, each("narrative"))
    const section = definitionOf(s).sections[0]!
    expect(section.blocks?.map((b) => ("slot" in b ? b.slot : b.id))).toEqual(["title", "each", "fleet"])
    const entry = catalogueFor("aws").find((e) => e.key === "ec2_utilization")!
    expect(visibleLayout(section, entry)).toEqual(["title", ["name", "details", "chart", "summary"], "fleet"])
    s.getState().toggleHidden(id, each("narrative"))
    expect(visibleLayout(definitionOf(s).sections[0]!, entry)[1]).toContain("narrative")
  })

  test("a block moves within its own list only", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    s.getState().moveBlock(id, each("chart"), -1)
    s.getState().moveBlock(id, each("chart"), -1)
    s.getState().moveBlock(id, each("chart"), -1) // already first: no-op
    const entry = catalogueFor("aws").find((e) => e.key === "ec2_utilization")!
    expect(visibleLayout(definitionOf(s).sections[0]!, entry)[1]).toEqual([
      "chart",
      "name",
      "details",
      "summary",
      "narrative",
    ])
  })

  test("added text goes after the block it was added at, and after the group from inside it", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    const first = s.getState().addBlock(id, "text", { kind: "slot", slot: "title", inEach: false })!
    const second = s.getState().addBlock(id, "text", each("chart"))!
    const entry = catalogueFor("aws").find((e) => e.key === "ec2_utilization")!
    const layout = sectionLayout(definitionOf(s).sections[0]!, entry).map((item) =>
      item.kind === "added" ? item.id : item.kind === "each" ? "each" : item.slot
    )
    expect(layout).toEqual(["title", first, "each", second, "fleet"])
    expect(s.getState().selection).toEqual({ kind: "block", sectionId: id, ref: { kind: "added", id: second } })
  })

  test("a renamed title and narrowed columns are what the validator accepts", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    s.getState().setTitle(id, "title", "en", "Instance use")
    s.getState().setColumns(id, each("details"), ["power_state", "instance_type"])
    const text = s.getState().addBlock(id, "text")!
    s.getState().setText(id, text, "en", "Read the chart first.")
    const definition = definitionOf(s)
    const blocks = definition.sections[0]!.blocks!
    expect(blocks[0]).toEqual({ slot: "title", title: { en: "Instance use" } })
    expect(collectDefinitionIssues(definition).map((i) => i.path.join("."))).toEqual([])
  })

  test("clearing a renamed title restores the catalogue title", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    s.getState().setTitle(id, "title", "en", "Instance use")
    s.getState().setTitle(id, "title", "en", "")
    expect(definitionOf(s).sections[0]!.blocks![0]).toEqual({ slot: "title" })
  })
})

describe("undo", () => {
  test("undo and redo move the draft, not the selection", async () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    await new Promise((resolve) => setTimeout(resolve, 650))
    s.getState().toggleHidden(id, { kind: "slot", slot: "fleet", inEach: false })
    const hidden = definitionOf(s)
    s.temporal.getState().undo()
    expect(definitionOf(s)).not.toBe(hidden)
    expect(s.getState().selection).toEqual({ kind: "section", sectionId: id })
    s.temporal.getState().redo()
    expect(definitionOf(s)).toEqual(hidden)
  })
})

describe("property: any sequence of edits leaves a draft the validator accepts", () => {
  const providers: Provider[] = ["aws", "azure"]

  test.each(providers)("%s", (provider) => {
    const free = catalogueFor(provider).filter(
      (entry) => entry.position !== "always" && !entry.authorFilled
    )
    const action = fc.oneof(
      fc.record({ op: fc.constant("add"), type: fc.constantFrom(...free.map((e) => e.key)) }),
      fc.record({ op: fc.constant("hide"), pick: fc.nat(), slot: fc.nat() }),
      fc.record({ op: fc.constant("move"), pick: fc.nat(), slot: fc.nat(), up: fc.boolean() }),
      fc.record({ op: fc.constant("text"), pick: fc.nat() }),
      fc.record({
        op: fc.constant("place"),
        pick: fc.nat(),
        kind: fc.constantFrom(
          "key_figures",
          "top_list",
          "month_vs_month",
          "coverage",
          "page_break",
          "callout",
          "heatmap",
          "sparklines" as const
        ),
      }),
      fc.record({ op: fc.constant("swap"), pick: fc.nat(), other: fc.nat() }),
      fc.record({ op: fc.constant("remove"), pick: fc.nat() })
    )

    fc.assert(
      fc.property(fc.array(action, { maxLength: 25 }), (actions) => {
        const s = store(provider)
        for (const a of actions) {
          const sections = definitionOf(s).sections
          const section = sections.length ? sections[("pick" in a ? a.pick : 0) % sections.length] : undefined
          const entry = section ? catalogueFor(provider).find((e) => e.key === section.type) : undefined
          const slots = entry?.slots.filter((shape) => !shape.required) ?? []
          const shape = slots.length ? slots[("slot" in a ? a.slot : 0) % slots.length] : undefined
          const ref: BlockRef | undefined = shape
            ? { kind: "slot", slot: shape.slot, inEach: shape.per === "resource" }
            : undefined
          switch (a.op) {
            case "add":
              if (!sections.some((x) => x.type === a.type) || free.find((e) => e.key === a.type)?.repeatable)
                s.getState().addSection(a.type)
              break
            case "hide":
              if (section && ref) s.getState().toggleHidden(section.id, ref)
              break
            case "move":
              if (section && ref) s.getState().moveBlock(section.id, ref, a.up ? -1 : 1)
              break
            case "text": {
              if (!section) break
              const id = s.getState().addBlock(section.id, "text")
              if (id) s.getState().setText(section.id, id, "en", "Words only.")
              break
            }
            case "place": {
              // The Add panel offers metric blocks only to sections that report metrics.
              if (!section) break
              const needsMetrics = !["coverage", "page_break", "callout"].includes(a.kind)
              if (needsMetrics && !entry?.metricBearing) break
              const added = s.getState().addBlock(section.id, a.kind)
              if (added && a.kind === "callout") {
                s.getState().setText(section.id, added, "en", "Some resources have no backup: {count}.")
                s.getState().setCallout(section.id, added, { when: "without_backup" })
              }
              break
            }
            case "swap": {
              const other = sections.length ? sections[a.other % sections.length] : undefined
              if (section && other) s.getState().moveSectionTo(section.id, other.id)
              break
            }
            case "remove":
              if (section) s.getState().removeSection(section.id)
              break
          }
        }
        const issues = collectDefinitionIssues(definitionOf(s))
        expect(issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([])
      }),
      { numRuns: 150 }
    )
  })
})


describe("added blocks", () => {
  test("a placed block is a kind and an id, and the validator accepts it in a metric section", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    for (const kind of ["key_figures", "top_list", "month_vs_month", "coverage", "page_break"] as const) {
      s.getState().addBlock(id, kind)
    }
    const kinds = definitionOf(s).sections[0]!.blocks!.flatMap((block) => ("kind" in block ? [block.kind] : []))
    expect(kinds).toEqual(["key_figures", "top_list", "month_vs_month", "coverage", "page_break"])
    expect(collectDefinitionIssues(definitionOf(s))).toEqual([])
  })

  test("a metric block in a section without metrics is refused by the validator", () => {
    const s = store()
    const id = s.getState().addSection("backups")!
    s.getState().addBlock(id, "key_figures")
    expect(collectDefinitionIssues(definitionOf(s)).map((issue) => issue.path.at(-1))).toEqual(["kind"])
  })

  test("removing an added block selects its section", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    const added = s.getState().addBlock(id, "page_break")!
    s.getState().removeAdded(id, added)
    expect(definitionOf(s).sections[0]!.blocks!.some((block) => "kind" in block)).toBe(false)
    expect(s.getState().selection).toEqual({ kind: "section", sectionId: id })
  })
})


describe("callouts", () => {
  test("a peak condition brings a threshold; another takes it away", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    const callout = s.getState().addBlock(id, "callout")!
    s.getState().setText(id, callout, "en", "{resource} ran hot.")
    s.getState().setCallout(id, callout, { when: "peak_at_or_above" })
    const read = () => definitionOf(s).sections[0]!.blocks!.find((b) => "kind" in b && b.id === callout)!
    expect(read()).toMatchObject({ when: "peak_at_or_above", threshold: 80 })
    expect(collectDefinitionIssues(definitionOf(s))).toEqual([])
    s.getState().setCallout(id, callout, { when: "stopped" })
    expect(read()).not.toHaveProperty("threshold")
    // {resource} is not something a stopped-machines count can fill.
    expect(collectDefinitionIssues(definitionOf(s)).map((issue) => issue.path.at(-1))).toEqual(["en"])
  })
})
