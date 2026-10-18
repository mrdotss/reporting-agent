import { describe, expect, test } from "vitest"

import { METRIC_CATALOG } from "@/lib/templates/catalog"
import { collectDefinitionIssues } from "@/lib/templates/definition"

import { catalogueFor, type Provider } from "./catalogue"
import { STARTERS, starterDraft } from "./starters"

/**
 * Every starter, for both providers, is a draft the validator accepts and names only
 * sections that provider's catalogue has.
 */
describe.each<Provider>(["aws", "azure"])("%s starters", (provider) => {
  test.each(STARTERS.map((starter) => [starter.key, starter] as const))("%s", (_key, starter) => {
    const keys = new Set(catalogueFor(provider).map((entry) => entry.key))
    for (const section of starter.sections[provider]) expect(keys.has(section.type), section.type).toBe(true)

    const draft = starterDraft(starter, provider, starter.name, starter.theme, METRIC_CATALOG)
    expect(draft.provider).toBe(provider)
    expect(collectDefinitionIssues(draft, { mode: "run" }).map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([])
    for (const section of draft.sections) {
      const entry = catalogueFor(provider).find((e) => e.key === section.type)!
      if (entry.metricBearing) expect(section.metrics?.length, section.type).toBeGreaterThan(0)
    }
  })
})

test("seven starters, four of them new", () => {
  expect(STARTERS).toHaveLength(7)
  expect(STARTERS.filter((starter) => starter.isNew)).toHaveLength(4)
})
