import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, test } from "vitest"

import {
  ALWAYS_SECTION,
  AZURE_SECTIONS,
  FIXED_SECTIONS,
  SECTION_CATALOGUE_VERSION,
  SECTION_NUMBERS,
} from "@/lib/profiles/sections"

/**
 * The app half of Requirement 22.4's cross-half agreement.
 *
 * `catalog/sections.v1.json` is ONE file, imported by both halves, so the data itself
 * cannot drift — that is why the design chose a shared file over sentinel-mirrored
 * declarations. What can still drift is the two LOADERS: each half derives its own views
 * over the same bytes (`FIXED_SECTIONS` here, `fixed_entries` there), and a filter that
 * quietly stops matching produces a wrong view of a right file.
 *
 * `agent/tests/test_section_catalogue.py::TestCrossHalfAgreement` pins the agent's
 * derivations against the raw JSON and asserts the app imports the same path. This is the
 * other side of that claim: the app's own exports, against the same bytes. Neither test
 * alone proves the halves agree — the agent's could pass while `sections.ts` derived
 * something different from the file it correctly located.
 */

const SECTIONS_JSON = path.join(
  __dirname,
  "..",
  "..",
  "agent",
  "src",
  "reporting_agent",
  "catalog",
  "sections.v1.json"
)

type RawEntry = {
  readonly key: string
  readonly number: number
  readonly position?: string
  readonly needs_resource_types?: readonly string[]
  readonly needs_fact_sources?: readonly string[]
}

const raw = JSON.parse(readFileSync(SECTIONS_JSON, "utf8")) as {
  readonly catalogue_version: string
  readonly providers: { readonly azure: { readonly sections: readonly RawEntry[] } }
}
const rawSections = raw.providers.azure.sections

describe("Requirement 22.4 — the app's section catalogue views match the shared file", () => {
  test("the fixture is real: the file parses and carries entries", () => {
    // Without this, every assertion below would compare two empty lists and pass.
    expect(rawSections.length).toBeGreaterThan(0)
    expect(AZURE_SECTIONS.length).toBeGreaterThan(0)
  })

  test("catalogue version agrees", () => {
    expect(SECTION_CATALOGUE_VERSION).toBe(raw.catalogue_version)
  })

  test("entry set and order agree", () => {
    expect(AZURE_SECTIONS.map((entry) => entry.key)).toEqual(
      rawSections.map((entry) => entry.key)
    )
  })

  test("canonical numbers agree", () => {
    expect([...SECTION_NUMBERS]).toEqual(rawSections.map((entry) => entry.number))
  })

  test("fixed positions agree, in declared order", () => {
    expect(FIXED_SECTIONS.map((entry) => entry.key)).toEqual(
      rawSections.filter((entry) => entry.position === "fixed").map((entry) => entry.key)
    )
  })

  test("exactly one always-present entry, and it is the one the file declares", () => {
    const always = rawSections.filter((entry) => entry.position === "always")
    expect(always).toHaveLength(1)
    expect(ALWAYS_SECTION?.key).toBe(always[0].key)
  })

  test("declared resource types and fact sources agree, entry by entry", () => {
    for (const rawEntry of rawSections) {
      const appEntry = AZURE_SECTIONS.find((entry) => entry.key === rawEntry.key)
      expect(appEntry, `${rawEntry.key} is in the file but not in AZURE_SECTIONS`).toBeDefined()
      expect([...(appEntry?.needs_resource_types ?? [])], rawEntry.key).toEqual([
        ...(rawEntry.needs_resource_types ?? []),
      ])
      expect([...(appEntry?.needs_fact_sources ?? [])], rawEntry.key).toEqual([
        ...(rawEntry.needs_fact_sources ?? []),
      ])
    }
  })
})
