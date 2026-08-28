import { describe, expect, test } from "vitest"

import { REQUIRED_TOP_LEVEL_KEYS } from "@/lib/templates/definition"
import {
  canAdvance,
  canReturnTo,
  completionProblems,
  hasAnyIssue,
  issuesByStep,
  nextStep,
  openingStep,
  previousStep,
  sectionCount,
  stepById,
  stepForIssue,
  STEP_FOR_FIELD,
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
} from "@/lib/profiles/wizard"

/**
 * The v3 wizard's step model (Requirements 3.2, 3.6, 7.2, 7.3).
 *
 * The key tests:
 *  - **every v3 top-level definition field maps to a step.** A field with no step
 *    is a validation error the wizard reports nowhere.
 *  - **a draft is validated as a draft.** Validating in `run` mode while authoring
 *    marks step 2 as failing from the moment the wizard opens.
 */

/**
 * A valid v3 definition — mirrors the accept-schema-version-3-minimal fixture,
 * plus `identity.customer_name`.
 *
 * The corpus fixture omits `customer_name` correctly: the VALIDATOR does not
 * require it, so a half-authored draft can be saved without one. This fixture is
 * used to assert PUBLISH-readiness, which is a stricter bar —
 * `completionProblems` refuses a version with no customer because every run
 * pinning it would be refused by `enqueueRun`. So the field belongs here even
 * though it does not belong in the validator's minimal fixture.
 */
const VALID_V3 = {
  schema_version: 3,
  identity: {
    name: "Test v3",
    language: "en",
    customer_name: "Test Customer",
  },
  provider: "azure",
  sections: [
    {
      id: "sec_vm",
      type: "vm_utilization",
      selection: {
        resource_types: ["Microsoft.Compute/virtualMachines"],
        resource_groups: [],
        tag_filters: [],
        top_n: null,
        sort: null,
      },
      metrics: [{ metric: "Percentage CPU", statistic: "avg" }],
      presentation: "chart_and_table",
    },
  ],
  period: { kind: "last_full_month" },
  design: {
    preset: "editorial",
    accent_color: "oklch(0.52 0.105 223)",
    density: "normal",
    table_style: "hairline",
    page_size: "A4",
    number_format: {
      decimal_places: 1,
      group_thousands: true,
      decimal_separator: ".",
      grouping_separator: ",",
    },
    cover_page: true,
    logo: null,
  },
  front_matter: {
    cover: { subtitle: "Test" },
    document_control: {
      document_name: "Test",
      document_number_pattern: "RPT-{year}{month}-{run}",
      approvers: [
        { role: "author", name: "A" },
        { role: "reviewer", name: "B" },
        { role: "approver", name: "C" },
        { role: "recipient", name: "D" },
      ],
    },
    toc: { enabled: true, max_level: 3 },
  },
}

function withoutField(field: string): unknown {
  const copy = { ...(VALID_V3 as Record<string, unknown>) }
  delete copy[field]
  return copy
}

describe("five steps in a fixed order", () => {
  test("there are exactly five, numbered 1 to 5", () => {
    expect(WIZARD_STEPS).toHaveLength(WIZARD_STEP_COUNT)
    expect(WIZARD_STEPS.map((step) => step.number)).toEqual([1, 2, 3, 4, 5])
  })

  test("the order is identity, sections, period, document, preview", () => {
    expect(WIZARD_STEPS.map((step) => step.id)).toEqual([
      "identity",
      "sections",
      "period",
      "document",
      "preview",
    ])
  })
})

describe("every v3 definition field has a step to show it on", () => {
  test("the mapping is exhaustive over REQUIRED_TOP_LEVEL_KEYS[3]", () => {
    // The guard that matters. A field added to v3's top-level keys with no entry
    // in STEP_FOR_FIELD would produce an issue that stepForIssue sends to
    // "preview" — a refusal with no step to open.
    const v3Keys = [...REQUIRED_TOP_LEVEL_KEYS[3]].sort()
    expect(Object.keys(STEP_FOR_FIELD).sort()).toEqual(v3Keys)
  })

  test("each mapped step id is one of the five", () => {
    const known = new Set(WIZARD_STEPS.map((step) => step.id))

    for (const stepId of Object.values(STEP_FOR_FIELD)) {
      expect(known.has(stepId)).toBe(true)
    }
  })

  test.each([
    ["schema_version", "identity"],
    ["provider", "identity"],
    ["identity", "identity"],
    ["sections", "sections"],
    ["period", "period"],
    ["front_matter", "document"],
    ["design", "document"],
  ] as const)("a %s issue belongs to the %s step", (field, expected) => {
    expect(stepForIssue({ path: [field, "nested"], message: "x" })).toBe(
      expected
    )
  })

  test("an unrecognized or empty path falls back to the preview step", () => {
    expect(stepForIssue({ path: ["invented_field"], message: "x" })).toBe(
      "preview"
    )
    expect(stepForIssue({ path: [], message: "x" })).toBe("preview")
    expect(stepForIssue({ path: [0], message: "x" })).toBe("preview")
  })
})

describe("a failing step blocks only itself", () => {
  test("a valid definition advances from every step", () => {
    const issues = issuesByStep(VALID_V3)

    expect(hasAnyIssue(issues)).toBe(false)

    for (const step of WIZARD_STEPS) {
      expect(canAdvance(step, issues)).toBe(true)
    }
  })

  test("a broken identity blocks step 1 and no other step", () => {
    const issues = issuesByStep(withoutField("identity"))

    expect(canAdvance(stepById("identity"), issues)).toBe(false)

    for (const step of WIZARD_STEPS.filter((s) => s.id !== "identity")) {
      expect(canAdvance(step, issues)).toBe(true)
    }
  })

  test("issues are grouped onto the step that owns them", () => {
    const issues = issuesByStep(withoutField("design"))

    expect(issues.document.length).toBeGreaterThan(0)
    expect(issues.identity).toEqual([])
    expect(issues.sections).toEqual([])
  })
})

describe("backward navigation is always allowed", () => {
  test("any step at or below the highest reached is reachable", () => {
    expect(canReturnTo(stepById("identity"), 4)).toBe(true)
    expect(canReturnTo(stepById("document"), 4)).toBe(true)
  })

  test("a step above the highest reached is not", () => {
    expect(canReturnTo(stepById("preview"), 4)).toBe(false)
  })

  test("navigating back is permitted even while that step fails", () => {
    const broken = withoutField("sections")
    const issues = issuesByStep(broken)

    expect(issues.sections.length).toBeGreaterThan(0)
    expect(canReturnTo(stepById("sections"), 3)).toBe(true)
  })
})

describe("step movement clamps at both ends", () => {
  test("previous from the first step stays there", () => {
    expect(previousStep(stepById("identity")).id).toBe("identity")
  })

  test("next from the last step stays there", () => {
    expect(nextStep(stepById("preview")).id).toBe("preview")
  })

  test("movement is one step at a time", () => {
    expect(nextStep(stepById("sections")).id).toBe("period")
    expect(previousStep(stepById("sections")).id).toBe("identity")
  })
})

describe("reopening resumes rather than restarts", () => {
  test("a complete draft opens on step 5", () => {
    expect(openingStep(VALID_V3).number).toBe(5)
  })

  test("a draft failing the period opens on step 3", () => {
    const broken = {
      ...(VALID_V3 as Record<string, unknown>),
      period: { kind: "nope" },
    }

    expect(openingStep(broken).id).toBe("period")
  })

  test("a draft failing two steps opens on the lower-numbered one", () => {
    const broken = {
      ...(VALID_V3 as Record<string, unknown>),
      period: { kind: "nope" },
      design: null,
    }

    expect(openingStep(broken).id).toBe("period")
  })

  test("an empty draft opens on step 1", () => {
    expect(openingStep({}).number).toBe(1)
  })
})

describe("a draft is validated as a draft", () => {
  test("a definition with zero sections does not fail the sections step while authoring", () => {
    const empty = { ...(VALID_V3 as Record<string, unknown>), sections: [] }

    expect(issuesByStep(empty).sections).toEqual([])
  })

  test("the same definition is refused at completion", () => {
    const empty = { ...(VALID_V3 as Record<string, unknown>), sections: [] }

    expect(completionProblems(empty)).toContainEqual({
      kind: "no_sections",
    })
  })
})

describe("completion names each failing step", () => {
  test("a valid definition with sections has no completion problem", () => {
    expect(completionProblems(VALID_V3)).toEqual([])
  })

  test("each failing step is reported with its own issues", () => {
    const broken = {
      ...(VALID_V3 as Record<string, unknown>),
      period: { kind: "nope" },
    }

    const problems = completionProblems(broken)
    const stepProblems = problems.filter((problem) => problem.kind === "step")

    expect(stepProblems).toHaveLength(1)
    expect(stepProblems[0]).toMatchObject({ step: { id: "period" } })
    expect(
      (stepProblems[0] as { issues: readonly unknown[] }).issues.length
    ).toBeGreaterThan(0)
  })

  test("failing steps are reported in step order", () => {
    const broken = {
      ...(VALID_V3 as Record<string, unknown>),
      design: null,
      period: { kind: "nope" },
      identity: null,
    }

    const order = completionProblems(broken)
      .filter((problem) => problem.kind === "step")
      .map((problem) => (problem as { step: { number: number } }).step.number)

    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test("an empty profile reports both its failing steps and the section rule", () => {
    const broken = {
      ...(VALID_V3 as Record<string, unknown>),
      sections: [],
      identity: null,
    }

    const problems = completionProblems(broken)

    expect(problems.some((problem) => problem.kind === "no_sections")).toBe(
      true
    )
    expect(
      problems.some(
        (problem) =>
          problem.kind === "step" &&
          (problem as { step: { id: string } }).step.id === "identity"
      )
    ).toBe(true)
  })
})

describe("sectionCount", () => {
  test("counts sections from a valid definition", () => {
    expect(sectionCount(VALID_V3)).toBe(1)
  })

  test("returns 0 for missing or non-array sections", () => {
    expect(sectionCount({})).toBe(0)
    expect(sectionCount(null)).toBe(0)
    expect(sectionCount({ sections: "not_array" })).toBe(0)
  })
})
