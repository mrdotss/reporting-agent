import { describe, expect, test } from "vitest"

import { AZURE_SECTIONS } from "@/lib/profiles/sections"
import {
  COLLECTED_FACT_SOURCES,
  missingInputs,
  offerable,
} from "@/lib/profiles/facts"
import {
  missingInputs as pureMissingInputs,
  offerable as pureOfferable,
} from "@/lib/profiles/offerability"

/**
 * Section offerability against a scan's collected inventory (task 6.5, Req 15.9,
 * 16.1-16.3).
 *
 * `offerable` keys on `COLLECTED_FACT_SOURCES` — which sources `facts.v1.json` actually
 * carries an entry for — rather than on the wider `DECLARED_FACT_SOURCES` vocabulary. `arm`
 * is declared and used by nothing; a section keying on the declared set would read `Ready`
 * for a source the catalogue does not actually collect, which is the exact "a green gate
 * says nothing was checked" failure this module exists to avoid.
 */

describe("COLLECTED_FACT_SOURCES", () => {
  test("includes arm for PostgreSQL firewall collection", () => {
    // The agent-side pytest `test_collected_sources_is_declared_minus_arm_and_matches_the
    // _used_set` asserts the identical claim against `catalog/loader.py`'s
    // `FactDeclaration.collected_sources` — both derive from the same `facts.v1.json`, so
    // the two assertions can never quietly diverge from each other.
    expect(COLLECTED_FACT_SOURCES.has("advisor")).toBe(true)
    expect(COLLECTED_FACT_SOURCES.has("recovery_services")).toBe(true)
    expect(COLLECTED_FACT_SOURCES.has("capacity")).toBe(true)
    expect(COLLECTED_FACT_SOURCES.has("resource_graph")).toBe(true)
    expect(COLLECTED_FACT_SOURCES.has("arm")).toBe(true)
  })
})

describe("offerable (bound to the real catalogue)", () => {
  const vnetEntry = AZURE_SECTIONS.find((s) => s.key === "virtual_network")!
  const advisorEntry = AZURE_SECTIONS.find((s) => s.key === "recommendations")!
  const alwaysEntry = AZURE_SECTIONS.find(
    (s) => s.key === "azure_subscription"
  )!

  test("a section needing a resource type not in the scan is not offerable", () => {
    expect(offerable(vnetEntry, {})).toBe(false)
    expect(
      offerable(vnetEntry, { "Microsoft.Compute/virtualMachines": 3 })
    ).toBe(false)
  })

  test("a section needing a resource type the scan collected is offerable", () => {
    expect(
      offerable(vnetEntry, { "Microsoft.Network/virtualNetworks": 1 })
    ).toBe(true)
  })

  test("section 14 (advisor) needs no resource type, and is offerable regardless of the scan's inventory", () => {
    expect(advisorEntry.needs_resource_types).toEqual([])
    expect(offerable(advisorEntry, {})).toBe(true)
    expect(
      offerable(advisorEntry, { "Microsoft.Compute/virtualMachines": 500 })
    ).toBe(true)
  })

  test("an entry declaring neither is unconditionally offerable -- both clauses are vacuously true", () => {
    expect(alwaysEntry.needs_resource_types).toEqual([])
    expect(offerable(alwaysEntry, {})).toBe(true)
  })

  test("matches the spelling Azure Resource Graph actually answers with", () => {
    // The defect: Resource Graph answers its `type` column lowercased and the section
    // catalogue declares Azure's documented casing, so a case-sensitive comparison matched
    // neither against the other. A subscription holding three virtual machines offered no
    // metric-bearing section at all — each one disabled with "needs
    // Microsoft.Compute/virtualMachines", naming as missing precisely the type the scan had
    // just counted three of.
    //
    // Every test above used the catalogue's own casing, which is why it never showed.
    expect(
      offerable(vnetEntry, { "microsoft.network/virtualnetworks": 1 })
    ).toBe(true)
  })

  test("matches whatever casing either side is written in", () => {
    // An ARM type id is case-insensitive, so no spelling of it is the wrong one.
    for (const spelling of [
      "microsoft.network/virtualnetworks",
      "Microsoft.Network/virtualNetworks",
      "MICROSOFT.NETWORK/VIRTUALNETWORKS",
      "microsoft.Network/VirtualNetworks",
    ]) {
      expect(offerable(vnetEntry, { [spelling]: 1 })).toBe(true)
    }
  })

  test("a type the scan really does not hold is still not offerable", () => {
    // Guard the guard: case-folding must not make everything match.
    expect(
      offerable(vnetEntry, { "microsoft.compute/virtualmachines": 3 })
    ).toBe(false)
  })

  test("the missing type is named in the catalogue's spelling, not the scan's", () => {
    // The consultant is being told which resource type the section needs, and
    // `Microsoft.Network/virtualNetworks` is the spelling Azure's documentation uses.
    // Only the comparison is case-folded.
    expect(missingInputs(vnetEntry, {})).toEqual([
      "Microsoft.Network/virtualNetworks",
    ])
  })

  test("reachability is not an input: no permission-probe parameter exists on the signature at all", () => {
    expect(offerable.length).toBe(2)
  })
})

describe("missingInputs (bound to the real catalogue)", () => {
  const vnetEntry = AZURE_SECTIONS.find((s) => s.key === "virtual_network")!

  test("names the missing resource type when offerable is false", () => {
    expect(missingInputs(vnetEntry, {})).toEqual([
      "Microsoft.Network/virtualNetworks",
    ])
  })

  test("is empty exactly when offerable is true", () => {
    const scan = { "Microsoft.Network/virtualNetworks": 2 }
    expect(offerable(vnetEntry, scan)).toBe(true)
    expect(missingInputs(vnetEntry, scan)).toEqual([])
  })
})

describe("every AZURE_SECTIONS entry", () => {
  test("with empty needs_resource_types and empty needs_fact_sources is unconditionally offerable against an empty scan", () => {
    const unconditional = AZURE_SECTIONS.filter(
      (s) =>
        s.needs_resource_types.length === 0 && s.needs_fact_sources.length === 0
    )
    // Sections 1, 2, 13, 15 by the catalogue's own numbering (task 6.5's own text).
    expect(unconditional.length).toBeGreaterThanOrEqual(4)
    for (const entry of unconditional) {
      expect(offerable(entry, {})).toBe(true)
    }
  })
})

describe("the pure ./offerability module, called directly with an explicit set", () => {
  // Proves the client component can call this without a server-loaded catalogue: the
  // caller supplies collectedFactSources itself, exactly as step-sections.tsx will.
  const entry = { needs_resource_types: ["A"], needs_fact_sources: ["advisor"] }

  test("a missing source fails even when every resource type is present", () => {
    expect(pureOfferable(entry, { A: 1 }, new Set())).toBe(false)
    expect(pureMissingInputs(entry, { A: 1 }, new Set())).toEqual(["advisor"])
  })

  test("present resource type and present source together offer the section", () => {
    expect(pureOfferable(entry, { A: 1 }, new Set(["advisor"]))).toBe(true)
    expect(pureMissingInputs(entry, { A: 1 }, new Set(["advisor"]))).toEqual([])
  })

  test("facts.ts's bound offerable agrees with the pure function given the same set", () => {
    const vnetEntry = AZURE_SECTIONS.find((s) => s.key === "virtual_network")!
    const scan = { "Microsoft.Network/virtualNetworks": 1 }
    expect(offerable(vnetEntry, scan)).toBe(
      pureOfferable(vnetEntry, scan, COLLECTED_FACT_SOURCES)
    )
  })
})

test("PostgreSQL inventory is offerable for a discovered flexible server", () => {
  const entry = AZURE_SECTIONS.find((s) => s.key === "postgresql_flexible_inventory")!
  expect(entry.group).toBe("inventory")
  expect(offerable(entry, { "microsoft.dbforpostgresql/flexibleservers": 1 })).toBe(true)
  expect(offerable(entry, {})).toBe(false)
})
