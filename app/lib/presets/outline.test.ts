import { describe, expect, test } from "vitest"

import { catalogueFor, type Provider } from "@/lib/builder/catalogue"
import { starterDraft } from "@/lib/builder/starters"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import { collectDefinitionIssues } from "@/lib/templates/definition"

import {
  outlineStarter,
  parseModelJson,
  starterOutline,
  validSections,
  validateOutline,
} from "./outline"

describe("validSections", () => {
  test("drops keys the provider's catalogue does not hold, and repeats", () => {
    const kept = validSections("aws", [
      { key: "ec2_utilization", why: "how machines ran" },
      { key: "vm_utilization", why: "an Azure section" },
      { key: "made_up" },
      { key: "ec2_utilization" },
    ])
    expect(kept.map((section) => section.key)).toEqual(["ec2_utilization", "coverage_and_verification"])
  })

  test("keeps the verification appendix last, and orders by group", () => {
    const kept = validSections("azure", ["housekeeping", "coverage_and_verification", "at_a_glance", "virtual_machines"])
    expect(kept.map((section) => section.key)).toEqual([
      "at_a_glance",
      "virtual_machines",
      "housekeeping",
      "coverage_and_verification",
    ])
  })

  test("gives every trend section a depth the validator accepts", () => {
    const [missing] = validSections("aws", [{ key: "historical_ec2_utilization" }])
    expect(missing?.lookback).toBe(6)
    const [clamped] = validSections("azure", [{ key: "historical_vm_utilization", lookback: 99 }])
    expect(clamped?.lookback).toBe(24)
  })
})

describe("validateOutline", () => {
  const input = { provider: "azure", audience: "executive" } as const

  test("refuses an answer with nothing but the appendix", () => {
    expect(validateOutline({ sections: [] }, input)).toBeNull()
    expect(validateOutline(null, input)).toBeNull()
  })

  test("falls back to safe values and strips markup from notes", () => {
    const outline = validateOutline(
      {
        name: "Board <b>brief</b>",
        theme: "neon",
        period: "yearly",
        sections: [{ key: "at_a_glance", why: "one page" }],
        understood: ["one page", 4, ""],
        not_applied: ["Hide resource IDs"],
      },
      input
    )
    expect(outline).not.toBeNull()
    expect(outline!.name).not.toMatch(/[<>]/)
    expect(outline!.theme).toBe("brief")
    expect(outline!.period).toBe("last_full_month")
    expect(outline!.understood).toEqual(["one page"])
    expect(outline!.notApplied).toEqual(["Hide resource IDs"])
    expect(outline!.source).toBe("model")
  })
})

test("parseModelJson reads the object out of surrounding text", () => {
  expect(parseModelJson('Here you go:\n```json\n{"name": "x"}\n```')).toEqual({ name: "x" })
  expect(parseModelJson("no json")).toBeNull()
})

test("starterOutline matches a starter from the description", () => {
  const outline = starterOutline({ description: "What has no backup and what faces the internet", provider: "aws", audience: "mixed" })
  expect(outline.source).toBe("starter")
  expect(outline.starterKey).toBe("backup_exposure")
  expect(outline.sections.at(-1)?.key).toBe("coverage_and_verification")
})

test("outlineStarter carries the outline's sections for its provider only", () => {
  const starter = outlineStarter("aws", "Mine", "ledger", {
    sections: [{ type: "ec2_utilization" }, { type: "historical_ec2_utilization", lookback: 3 }],
    period: "last_30d",
    contents: false,
  })
  expect(starter.sections.azure).toEqual([])
  expect(starter.sections.aws).toEqual([
    { type: "ec2_utilization" },
    { type: "historical_ec2_utilization", lookback: 3 },
    { type: "coverage_and_verification" },
  ])
  expect(starter.period).toBe("last_30d")
  expect(starter.contents).toBe(false)
})

/**
 * Whatever sections an outline names, the draft the create route builds from it is one
 * the validator accepts: every catalogue section at once, for both providers.
 */
test.each<Provider>(["aws", "azure"])("an outline of every %s section builds a valid draft", (provider) => {
  const sections = validSections(provider, catalogueFor(provider).map((entry) => ({ key: entry.key })))
  const outline = {
    sections: sections.map((section) => ({ type: section.key, ...(section.lookback ? { lookback: section.lookback } : {}) })),
    period: "last_full_month" as const,
    contents: true,
    summary: "Everything",
  }
  const draft = starterDraft(outlineStarter(provider, "All", "corporate", outline), provider, "All", "corporate", METRIC_CATALOG)
  expect(draft.sections.map((section) => section.type).sort()).toEqual(sections.map((section) => section.key).sort())
  expect(collectDefinitionIssues(draft, { mode: "run" }).map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([])
})
