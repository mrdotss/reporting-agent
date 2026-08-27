import { describe, expect, test } from "vitest"

import rawSections from "../../agent/src/reporting_agent/catalog/sections.v1.json"
import {
  AZURE_SECTIONS,
  SECTION_CATALOGUE_VERSION,
} from "@/lib/profiles/sections"

/**
 * Both halves load `catalog/sections.v1.json` and agree on entry set, canonical numbers,
 * declared resource types, declared fact sources, fixed positions and preset metric sets
 * (task 7.1, Req 22.4) — the behavioural form: one shared file makes a structural mirror
 * unnecessary in principle, and this test is what makes that claim checked rather than
 * merely believed. The agent side's equivalent coverage lives in
 * `agent/tests/test_section_catalogue.py` (fifteen entries, unique keys, unique canonical
 * numbers, declared groups/positions, the fixed-entry order, the one `always` entry).
 *
 * The comparison is against the **raw JSON**, not against a second, independently-written
 * TS literal — a second literal is exactly the drift risk one shared file exists to close.
 * `AZURE_SECTIONS` is `sections.ts`'s typed view of the same bytes `catalog/loader.py`
 * reads, so asserting it against the raw parse proves the TS loader drops or renames
 * nothing on the way to the type, which is the only way this file's own load path could
 * silently disagree with the Python one despite sharing a source.
 */

type RawSectionsFile = {
  readonly catalogue_version: string
  readonly providers: {
    readonly azure: { readonly sections: readonly RawEntry[] }
  }
}

type RawEntry = {
  readonly key: string
  readonly number: number
  readonly group: string
  readonly position: string
  readonly needs_resource_types: readonly string[]
  readonly needs_fact_sources: readonly string[]
  readonly presets: Readonly<Record<string, unknown>>
}

const RAW = rawSections as unknown as RawSectionsFile
const RAW_ENTRIES = RAW.providers.azure.sections

describe("section catalogue cross-language agreement (task 7.1, Req 22.4)", () => {
  test("the catalogue_version TS reads is the raw file's own value", () => {
    expect(SECTION_CATALOGUE_VERSION).toBe(RAW.catalogue_version)
  })

  test("fifteen entries -- the same count agent/tests/test_section_catalogue.py pins", () => {
    expect(AZURE_SECTIONS.length).toBe(15)
    expect(RAW_ENTRIES.length).toBe(15)
  })

  test("the entry set (by key) is identical between the raw parse and the typed view", () => {
    const rawKeys = RAW_ENTRIES.map((e) => e.key).sort()
    const typedKeys = AZURE_SECTIONS.map((e) => e.key).sort()
    expect(typedKeys).toEqual(rawKeys)
    expect(new Set(typedKeys).size).toBe(typedKeys.length)
  })

  test("canonical numbers are 1..15 with no duplicate, in both the raw parse and the typed view", () => {
    const expected = Array.from({ length: 15 }, (_, i) => i + 1)
    expect(
      [...AZURE_SECTIONS.map((e) => e.number)].sort((a, b) => a - b)
    ).toEqual(expected)
    expect([...RAW_ENTRIES.map((e) => e.number)].sort((a, b) => a - b)).toEqual(
      expected
    )
  })

  test("every entry's needs_resource_types and needs_fact_sources survive the typed view unchanged", () => {
    const rawByKey = new Map(RAW_ENTRIES.map((e) => [e.key, e]))
    for (const entry of AZURE_SECTIONS) {
      const raw = rawByKey.get(entry.key)
      expect(raw, `no raw entry for ${entry.key}`).toBeDefined()
      expect(entry.needs_resource_types).toEqual(raw!.needs_resource_types)
      expect(entry.needs_fact_sources).toEqual(raw!.needs_fact_sources)
    }
  })

  test("the four Phase 5 sections declare the same inputs on both sides (tasks 6.1-6.4)", () => {
    const vnet = AZURE_SECTIONS.find((e) => e.key === "virtual_network")!
    const pip = AZURE_SECTIONS.find((e) => e.key === "public_ip_addresses")!
    const nsg = AZURE_SECTIONS.find((e) => e.key === "network_security_groups")!
    const recs = AZURE_SECTIONS.find((e) => e.key === "recommendations")!

    expect(vnet.needs_resource_types).toContain(
      "Microsoft.Network/virtualNetworks"
    )
    expect(pip.needs_resource_types).toContain(
      "Microsoft.Network/publicIPAddresses"
    )
    expect(nsg.needs_resource_types).toContain(
      "Microsoft.Network/networkSecurityGroups"
    )
    expect(recs.needs_fact_sources).toContain("advisor")
  })

  test("fixed positions and the always position match the raw file", () => {
    const fixedKeys = AZURE_SECTIONS.filter((e) => e.position === "fixed").map(
      (e) => e.key
    )
    const rawFixedKeys = RAW_ENTRIES.filter((e) => e.position === "fixed").map(
      (e) => e.key
    )
    expect(fixedKeys).toEqual(rawFixedKeys)

    const alwaysEntries = AZURE_SECTIONS.filter((e) => e.position === "always")
    expect(alwaysEntries).toHaveLength(1)
    expect(alwaysEntries[0]!.key).toBe("coverage_and_verification")
  })

  test("preset metric sets survive the typed view unchanged", () => {
    const rawByKey = new Map(RAW_ENTRIES.map((e) => [e.key, e]))
    for (const entry of AZURE_SECTIONS) {
      const raw = rawByKey.get(entry.key)!
      expect(entry.presets).toEqual(raw.presets)
    }
  })
})
