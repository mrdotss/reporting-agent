import { describe, expect, test } from "vitest"

import {
  ALWAYS_SECTION_KEY_BY_PROVIDER,
  collectDefinitionIssues,
  MAX_SUPPORTED_SCHEMA_VERSION,
  REQUIRED_TOP_LEVEL_KEYS,
} from "@/lib/templates/definition"
import { EMPTY_DRAFT } from "@/lib/templates/draft"

/**
 * The draft factory's output must satisfy the validator the wizard runs against it.
 *
 * This is the assertion whose absence let a real defect ship: task 3.6 moved the wizard
 * to the five-step v3 model and left `EMPTY_DRAFT` returning `schema_version: 1`. Step 2
 * then wrote a `sections` array into a v1 document, and because
 * `REQUIRED_TOP_LEVEL_KEYS` serves as both the required set AND the allowed set, the
 * wizard reported `Unrecognized top-level key "sections"` and refused to advance. Every
 * starter had been migrated to v3 by task 3.13, so the failure was invisible unless you
 * began from a blank template -- which is to say, invisible to every test that started
 * from a fixture.
 *
 * No step-level test could have caught it. They all begin from an already-invalid
 * document, and a validator that is wrong about the FIRST state is wrong about every
 * state after it.
 */

const asRecord = (name: string): Record<string, unknown> =>
  EMPTY_DRAFT(name) as unknown as Record<string, unknown>

describe("EMPTY_DRAFT is a definition its own validator accepts", () => {
  test("a brand-new draft reports no issues at all", () => {
    expect(collectDefinitionIssues(asRecord("Untitled template"))).toEqual([])
  })

  test("it declares the current maximum schema version", () => {
    // Pinned to the constant rather than the literal 3, so raising the maximum without
    // moving the draft fails here instead of at step 2 of a consultant's wizard.
    expect(asRecord("x")["schema_version"]).toBe(MAX_SUPPORTED_SCHEMA_VERSION)
  })

  test("it carries exactly the top-level keys that version requires", () => {
    const keys = Object.keys(asRecord("x")).sort()
    const required = [...REQUIRED_TOP_LEVEL_KEYS[MAX_SUPPORTED_SCHEMA_VERSION]].sort()
    expect(keys).toEqual(required)
  })

  test("it opens on the always-present appendix, which the author cannot add back", () => {
    // `coverage_and_verification` is `position: "always"` in the section catalogue
    // (Req 8.5). A draft omitting it would open the wizard on a document already
    // missing a section no control can restore.
    const sections = asRecord("x")["sections"] as ReadonlyArray<{ type: string }>
    expect(sections.map((s) => s.type)).toContain(
      ALWAYS_SECTION_KEY_BY_PROVIDER.azure
    )
  })

  test("the reported defect is reproduced by the version alone", () => {
    // The mutation check: nothing else about the draft is changed, so this pins the
    // schema version as the cause rather than the shape of `sections`.
    const downgraded = { ...asRecord("x"), schema_version: 1 }
    const messages = collectDefinitionIssues(downgraded).map((issue) => issue.message)

    expect(messages).toContain('Unrecognized top-level key "sections".')
  })
})
