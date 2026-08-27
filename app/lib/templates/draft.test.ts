import { describe, expect, test } from "vitest"

import { collectDefinitionIssues } from "@/lib/templates/definition"
import { EMPTY_DRAFT, EMPTY_DRAFT_V3 } from "@/lib/templates/draft"

/**
 * `EMPTY_DRAFT` (v1) and `EMPTY_DRAFT_V3` (v3) each validate cleanly in draft mode
 * the moment a new template opens the wizard.
 *
 * This is the exact bug a real "Standard" template hit in production: the current
 * `sections`-based wizard (`wizard-shell.tsx`) called the v1 `EMPTY_DRAFT`, so the
 * moment `StepSections` wrote a `sections` array onto it the definition became
 * `{schema_version: 1, sections: [...], ...}` — `sections` is not a legal key at
 * `schema_version` 1, so the wizard's step 2 permanently showed "Unrecognized
 * top-level key sections" and the run form's "Request a report" failed with no
 * further detail. No test caught it because no test ever validated what a brand
 * new template's OWN empty draft produces.
 */

describe("EMPTY_DRAFT (v1) validates with no issues in draft mode", () => {
  test("a fresh v1 draft is clean", () => {
    const issues = collectDefinitionIssues(EMPTY_DRAFT("Fixture"), {
      mode: "draft",
    })
    expect(issues).toEqual([])
  })

  test("carries no v3-only key", () => {
    const draft = EMPTY_DRAFT("Fixture") as unknown as Record<string, unknown>
    expect(draft).not.toHaveProperty("sections")
    expect(draft).not.toHaveProperty("provider")
    expect(draft.schema_version).toBe(1)
  })
})

describe("EMPTY_DRAFT_V3 validates with no issues in draft mode", () => {
  test("a fresh v3 draft is clean -- the exact scenario the bug report showed", () => {
    const issues = collectDefinitionIssues(EMPTY_DRAFT_V3("Standard"), {
      mode: "draft",
    })
    expect(issues).toEqual([])
  })

  test("carries every v3-required top-level key and no v1/v2-only key", () => {
    const draft = EMPTY_DRAFT_V3("Fixture") as unknown as Record<
      string,
      unknown
    >
    expect(draft.schema_version).toBe(3)
    expect(draft).toHaveProperty("provider")
    expect(draft).toHaveProperty("sections")
    expect(draft).toHaveProperty("front_matter")
    expect(draft).not.toHaveProperty("scope")
    expect(draft).not.toHaveProperty("metrics")
    expect(draft).not.toHaveProperty("blocks")
  })

  test("sections starts empty -- draft mode must not require one yet", () => {
    const draft = EMPTY_DRAFT_V3("Fixture") as unknown as {
      sections: readonly unknown[]
    }
    expect(draft.sections).toEqual([])
  })

  test("adding a real section to the v3 draft keeps it draft-valid", () => {
    // Reproduces StepSections's own addSection shape (components/templates/
    // step-sections.tsx) -- the exact write that turned a v1 EMPTY_DRAFT into
    // an invalid hybrid before this fix.
    const draft = EMPTY_DRAFT_V3("Fixture") as unknown as Record<
      string,
      unknown
    >
    const withSection = {
      ...draft,
      sections: [
        {
          id: "sec_1",
          type: "azure_subscription",
          selection: {
            resource_types: [],
            resource_groups: [],
            tag_filters: [],
            top_n: null,
            sort: null,
          },
          metrics: [],
          presentation: "chart_and_table",
        },
      ],
    }
    const issues = collectDefinitionIssues(withSection, { mode: "draft" })
    expect(issues).toEqual([])
  })
})
