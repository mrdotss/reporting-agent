import { describe, expect, test } from "vitest"

import { ADDED_KINDS } from "@/components/builder/canvas/labels"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import { MAX_AGENT_BLOCKS } from "@/lib/templates/definition"

import { sectionEntry } from "./catalogue"
import { emptyDraftV4 } from "./draft"
import { BLOCK_INTENTS, blockFit, readsMetrics } from "./fit"
import { createBuilderStore } from "./store"

/**
 * Which blocks the gallery, the + and the / menu offer as fitting, and the reason given for
 * the rest. Every block is in exactly one of the gallery's groups.
 */

function store() {
  return createBuilderStore({ initial: emptyDraftV4("Test", "aws"), catalog: METRIC_CATALOG })
}

describe("BLOCK_INTENTS", () => {
  test("every added block is in exactly one group", () => {
    const placed = BLOCK_INTENTS.flatMap((intent) => intent.kinds)
    expect([...placed].sort()).toEqual([...ADDED_KINDS].sort())
    expect(new Set(placed).size).toBe(placed.length)
  })
})

describe("blockFit", () => {
  test("nothing fits without a section, and the reason says to choose one", () => {
    const s = store()
    for (const kind of ADDED_KINDS) {
      expect(blockFit(s.getState().definition, undefined, kind)).toEqual({
        ok: false,
        reason: "Choose a section to add it to.",
      })
    }
  })

  test("a section that reports metrics takes every block but the ones it lacks figures for", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    const definition = s.getState().definition
    const section = definition.sections.find((candidate) => candidate.id === id)!
    for (const kind of ADDED_KINDS) {
      const fit = blockFit(definition, section, kind)
      if (kind === "avg_vs_peak") expect(fit.ok).toBe(s.getState().addBlock(id, "avg_vs_peak") !== null)
      else expect(fit).toEqual({ ok: true })
    }
  })

  test("a section with no metrics greys every block that reads them, with the reason", () => {
    const s = store()
    const id = s.getState().addSection("backups")!
    const definition = s.getState().definition
    const section = definition.sections.find((candidate) => candidate.id === id)!
    expect(sectionEntry("aws", section.type)?.metricBearing).toBe(false)
    for (const kind of ADDED_KINDS) {
      const fit = blockFit(definition, section, kind)
      if (readsMetrics(kind)) expect(fit).toEqual({ ok: false, reason: "Reads metrics. This section reports none." })
      else expect(fit).toEqual({ ok: true })
    }
  })

  test("a bullet needs an average and a maximum of one metric, like average and peak", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    const definition = s.getState().definition
    const section = definition.sections.find((candidate) => candidate.id === id)!
    expect(blockFit(definition, section, "utilization_bullet")).toEqual({ ok: true })
    const avgOnly = { ...section, metrics: [{ metric: "CPUUtilization", statistic: "avg" }] }
    expect(blockFit(definition, avgOnly, "utilization_bullet")).toEqual({
      ok: false,
      reason: "Needs a metric this section collects as both an average and a maximum.",
    })
    expect(blockFit(definition, avgOnly, "bar_list")).toEqual({ ok: true })
  })

  test("a fleet mix fits sections of machines or databases, metrics or not", () => {
    const s = store()
    const ec2 = s.getState().addSection("ec2_utilization")!
    const backups = s.getState().addSection("backups")!
    const volumes = s.getState().addSection("ebs_activity")!
    const definition = s.getState().definition
    const section = (id: string) => definition.sections.find((candidate) => candidate.id === id)!
    expect(blockFit(definition, section(ec2), "fleet_mix")).toEqual({ ok: true })
    expect(blockFit(definition, section(backups), "fleet_mix")).toEqual({ ok: true })
    expect(blockFit(definition, section(volumes), "fleet_mix")).toEqual({
      ok: false,
      reason: "Counts machines and databases. This section holds neither.",
    })
  })

  test("agent paragraphs stop fitting at the limit", () => {
    const s = store()
    const id = s.getState().addSection("ec2_utilization")!
    for (let added = 0; added < MAX_AGENT_BLOCKS; added += 1) {
      const definition = s.getState().definition
      expect(blockFit(definition, definition.sections[0], "agent").ok).toBe(true)
      expect(s.getState().addBlock(id, "agent")).not.toBeNull()
    }
    const definition = s.getState().definition
    const fit = blockFit(definition, definition.sections[0], "agent")
    expect(fit.ok).toBe(false)
    expect(fit.ok === false && fit.reason).toContain(String(MAX_AGENT_BLOCKS))
  })
})
