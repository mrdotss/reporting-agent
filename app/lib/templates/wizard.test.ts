import { describe, expect, test } from "vitest"

import type { TemplateDefinition } from "@/lib/templates/definition"
import { STARTER_TEMPLATES } from "@/lib/templates/starters"
import {
  canAdvance,
  canReturnTo,
  completionProblems,
  hasAnyIssue,
  issuesByStep,
  nextStep,
  openingStep,
  previousStep,
  stepById,
  stepForIssue,
  STEP_FOR_FIELD,
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
} from "@/lib/templates/wizard"

/**
 * The wizard's step model (Requirement 11).
 *
 * The interesting tests here are the two that are easy to get subtly wrong:
 *
 *  - **every top-level definition field maps to a step.** A field with no step is
 *    a validation error the wizard reports nowhere, which reaches the consultant
 *    as a completion that refuses with no field to fix.
 *  - **a draft is validated as a draft.** Validating in `run` mode while authoring
 *    marks step 5 as failing from the moment the wizard opens, before the
 *    consultant has had a chance to add a block.
 */

const VALID = STARTER_TEMPLATES[0]!.definition

function withoutField(field: keyof TemplateDefinition): unknown {
  const copy = { ...(VALID as Record<string, unknown>) }
  delete copy[field]
  return copy
}

describe("Requirement 11.1 — seven steps in a fixed order", () => {
  test("there are exactly seven, numbered 1 to 7", () => {
    expect(WIZARD_STEPS).toHaveLength(WIZARD_STEP_COUNT)
    expect(WIZARD_STEPS.map((step) => step.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ])
  })

  test("the order is identity, scope, period, metrics, blocks, design, preview", () => {
    expect(WIZARD_STEPS.map((step) => step.id)).toEqual([
      "identity",
      "scope",
      "period",
      "metrics",
      "blocks",
      "design",
      "preview",
    ])
  })

  test("metric selection comes after scope", () => {
    // Not a restatement of the order test. The metric selection is *per resource
    // type*, so a wizard that asked for it first would be asking which metrics to
    // collect for a set of resource types the consultant has not chosen yet.
    const scope = WIZARD_STEPS.findIndex((step) => step.id === "scope")
    const metrics = WIZARD_STEPS.findIndex((step) => step.id === "metrics")

    expect(metrics).toBeGreaterThan(scope)
  })
})

describe("every definition field has a step to show it on", () => {
  test("the mapping is exhaustive over the definition's top-level keys", () => {
    // The guard that matters. A field added to `TemplateDefinition` with no entry
    // here validates fine and then, when it fails, produces an issue that
    // `stepForIssue` sends to step 7 — a refusal with no field to fix and no step
    // to open. This fails at that moment instead.
    expect(Object.keys(STEP_FOR_FIELD).sort()).toEqual(
      Object.keys(VALID).sort()
    )
  })

  test("each mapped step id is one of the seven", () => {
    const known = new Set(WIZARD_STEPS.map((step) => step.id))

    for (const stepId of Object.values(STEP_FOR_FIELD)) {
      expect(known.has(stepId)).toBe(true)
    }
  })

  test.each([
    ["identity", "identity"],
    ["scope", "scope"],
    ["period", "period"],
    ["metrics", "metrics"],
    ["blocks", "blocks"],
    ["design", "design"],
  ] as const)("a %s issue belongs to the %s step", (field, expected) => {
    expect(stepForIssue({ path: [field, "nested"], message: "x" })).toBe(
      expected
    )
  })

  test("an unrecognized or empty path falls back to the preview step", () => {
    // Step 7 is where completion is confirmed, so an unrecognized issue still
    // reaches the consultant on the step whose whole job is "can this be saved?".
    // Dropping it would refuse a save and show nothing.
    expect(stepForIssue({ path: ["invented_field"], message: "x" })).toBe(
      "preview"
    )
    expect(stepForIssue({ path: [], message: "x" })).toBe("preview")
    expect(stepForIssue({ path: [0], message: "x" })).toBe("preview")
  })
})

describe("Requirement 11.3 — a failing step blocks only itself", () => {
  test("a valid definition advances from every step", () => {
    const issues = issuesByStep(VALID)

    expect(hasAnyIssue(issues)).toBe(false)

    for (const step of WIZARD_STEPS) {
      expect(canAdvance(step, issues)).toBe(true)
    }
  })

  test("a broken identity blocks step 1 and no other step", () => {
    const issues = issuesByStep(withoutField("identity"))

    expect(canAdvance(stepById("identity"), issues)).toBe(false)

    // A later step's problems do not block this one — the consultant has not
    // reached it — and an earlier step's do not either, because blocking again
    // here would make an earlier mistake unfixable from where they now are.
    for (const step of WIZARD_STEPS.filter((s) => s.id !== "identity")) {
      expect(canAdvance(step, issues)).toBe(true)
    }
  })

  test("issues are grouped onto the step that owns them", () => {
    const issues = issuesByStep(withoutField("design"))

    expect(issues.design.length).toBeGreaterThan(0)
    expect(issues.identity).toEqual([])
    expect(issues.scope).toEqual([])
  })
})

describe("Requirement 11.2 — backward navigation is always allowed", () => {
  test("any step at or below the highest reached is reachable", () => {
    expect(canReturnTo(stepById("identity"), 5)).toBe(true)
    expect(canReturnTo(stepById("blocks"), 5)).toBe(true)
  })

  test("a step above the highest reached is not", () => {
    expect(canReturnTo(stepById("design"), 5)).toBe(false)
  })

  test("navigating back is permitted even while that step fails", () => {
    // The point of the rule: a consultant returning to fix step 2 must not be
    // refused entry to step 2 because step 2 is wrong.
    const broken = withoutField("scope")
    const issues = issuesByStep(broken)

    expect(issues.scope.length).toBeGreaterThan(0)
    expect(canReturnTo(stepById("scope"), 4)).toBe(true)
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
    expect(nextStep(stepById("scope")).id).toBe("period")
    expect(previousStep(stepById("scope")).id).toBe("identity")
  })
})

describe("Requirement 11.8 — reopening resumes rather than restarts", () => {
  test("a complete draft opens on step 7", () => {
    expect(openingStep(VALID).number).toBe(7)
  })

  test("a draft failing step 3 opens on step 3", () => {
    const broken = {
      ...(VALID as Record<string, unknown>),
      period: { kind: "nope" },
    }

    expect(openingStep(broken).id).toBe("period")
  })

  test("a draft failing two steps opens on the lower-numbered one", () => {
    const broken = {
      ...(VALID as Record<string, unknown>),
      period: { kind: "nope" },
      design: null,
    }

    // Not step 6, and not step 1 either: authoring resumes at the earliest thing
    // that needs attention.
    expect(openingStep(broken).id).toBe("period")
  })

  test("an empty draft opens on step 1", () => {
    expect(openingStep({}).number).toBe(1)
  })
})

describe("Requirement 11.4 — a draft is validated as a draft", () => {
  test("a definition with zero blocks does not fail the blocks step while authoring", () => {
    // Requirement 11.4 persists a draft "whether or not the definition yet
    // satisfies the at-least-one-block rule". Validating in `run` mode here would
    // mark step 5 as failing from the moment a new wizard opens, which is a red
    // error on a step the consultant has not visited.
    const empty = { ...(VALID as Record<string, unknown>), blocks: [] }

    expect(issuesByStep(empty).blocks).toEqual([])
  })

  test("the same definition is refused at completion", () => {
    // The rule is not abandoned, only deferred to where Requirement 11.10 puts
    // it — which is what makes the draft/complete distinction real rather than a
    // hole.
    const empty = { ...(VALID as Record<string, unknown>), blocks: [] }

    expect(completionProblems(empty)).toContainEqual({ kind: "no_blocks" })
  })
})

describe("Requirement 11.10 — completion names each failing step", () => {
  test("a valid definition with blocks has no completion problem", () => {
    expect(completionProblems(VALID)).toEqual([])
  })

  test("each failing step is reported with its own issues", () => {
    const broken = {
      ...(VALID as Record<string, unknown>),
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
      ...(VALID as Record<string, unknown>),
      design: null,
      period: { kind: "nope" },
      identity: null,
    }

    const order = completionProblems(broken)
      .filter((problem) => problem.kind === "step")
      .map((problem) => (problem as { step: { number: number } }).step.number)

    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test("an empty document reports both its failing steps and the block rule", () => {
    const broken = {
      ...(VALID as Record<string, unknown>),
      blocks: [],
      identity: null,
    }

    const problems = completionProblems(broken)

    expect(problems.some((problem) => problem.kind === "no_blocks")).toBe(true)
    expect(
      problems.some(
        (problem) =>
          problem.kind === "step" &&
          (problem as { step: { id: string } }).step.id === "identity"
      )
    ).toBe(true)
  })
})
