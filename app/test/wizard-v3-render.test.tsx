import { render } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"

import { StepDocument } from "@/components/templates/step-document"
import { StepPreview } from "@/components/templates/step-preview"
import {
  collectDefinitionIssues,
  validateMetricSelectionAgainstCatalog,
  type TemplateDefinition,
} from "@/lib/templates/definition"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import { EMPTY_DRAFT } from "@/lib/templates/draft"
import {
  metricEntryCount,
  openingStep,
  resourceTypeCount,
} from "@/lib/profiles/wizard"

/**
 * The v3 wizard's later steps, rendered against a v3 definition.
 *
 * These are the assertions whose absence let a crash reach production. Every existing
 * wizard test drives a step in isolation with a hand-built fixture; none rendered the
 * LAST steps against what `EMPTY_DRAFT` actually returns. So `step-preview.tsx` went on
 * reading `definition.scope.resource_types` — a key v3 does not have — and step 4 went on
 * rendering `StepMetrics`, which reads the same key.
 *
 * What made it invisible is worth recording. `openingStep` returns the first FAILING
 * step, or the LAST step when nothing fails. While `EMPTY_DRAFT` was still v1 the draft
 * was invalid the moment step 2 wrote `sections` into it, so a new profile opened on step
 * 2 and never reached Preview at all. Making the draft valid is what routed it there —
 * the fix did not cause the crash, it removed the thing that was hiding it.
 */

const v3 = () => EMPTY_DRAFT("Enesis v2") as unknown as TemplateDefinition

describe("the v3 wizard's later steps render against a v3 definition", () => {
  test("a valid new profile opens on the LAST step, which is why Preview must render", () => {
    // Pins the routing that made this reachable. If this ever stops being the last
    // step, the Preview render below stops being the case that matters.
    expect(openingStep(v3()).id).toBe("preview")
  })

  test("StepPreview renders a v3 definition without reading a v1 scope", () => {
    expect(() =>
      render(
        <StepPreview
          definition={v3()}
          problems={[]}
          templateId="t1"
          previewHtml={null}
          selectedSubscriptionId={null}
          hasCompletedRun={false}
        />
      )
    ).not.toThrow()
  })

  test("StepDocument renders a v3 definition", () => {
    expect(() =>
      render(<StepDocument definition={v3()} onChange={vi.fn()} />)
    ).not.toThrow()
  })

  test("the preview's counts read the v3 shape, not the absent v1 one", () => {
    // Both are 0 for a fresh draft, but they must be 0 by READING sections rather than
    // by throwing on a missing `scope` — so assert against a definition that has one.
    const withSelection = {
      ...v3(),
      sections: [
        {
          id: "s1",
          type: "vm_utilization",
          position: 0,
          selection: { resource_types: ["Microsoft.Compute/virtualMachines"] },
          metrics: ["Percentage CPU", "Available Memory Bytes"],
          presentation: "chart_and_table",
        },
      ],
    }

    expect(resourceTypeCount(withSelection)).toBe(1)
    expect(metricEntryCount(withSelection)).toBe(2)
  })

  test("the helpers still read a v1 definition, which the preview also renders", () => {
    const v1 = {
      schema_version: 1,
      scope: { resource_types: ["Microsoft.Compute/virtualMachines"] },
      metrics: { "Microsoft.Compute/virtualMachines": ["Percentage CPU"] },
    }

    expect(resourceTypeCount(v1)).toBe(1)
    expect(metricEntryCount(v1)).toBe(1)
  })
})

/**
 * The save path, which is a different validator pair from the wizard's.
 *
 * `publishTemplateVersion` runs `collectDefinitionIssues(…, { mode: "run" })` and then
 * `validateMetricSelectionAgainstCatalog`. The second one read `definition.metrics`
 * unconditionally, so on a v3 profile -- which has no such key -- it threw
 * "Cannot convert undefined or null to object" AFTER run-mode validation had passed.
 * The wizard therefore said "Every step passes" and Save answered "The request could not
 * be completed", with no issue to point at because the failure was a throw rather than a
 * finding.
 *
 * The catalogue guarantee is preserved rather than skipped for v3: a section's metric
 * items are the same shape v1's were, so each is still checked against the catalogue --
 * against the resource types that section covers instead of a map key.
 */
describe("the save path accepts a v3 profile and still rejects a bad metric", () => {
  const v3WithMetrics = (metric: string) =>
    ({
      ...v3(),
      sections: [
        {
          id: "s1",
          type: "vm_utilization",
          position: 0,
          selection: {
            resource_types: ["Microsoft.Compute/virtualMachines"],
            resource_groups: [],
            tag_filters: [],
            top_n: null,
            sort: null,
          },
          metrics: [{ metric, statistic: "Maximum" }],
          presentation: "chart_and_table",
        },
      ],
    }) as unknown as Record<string, unknown>

  test("a v3 profile with no metrics passes both save-path validators", () => {
    const def = v3() as unknown as Record<string, unknown>

    expect(collectDefinitionIssues(def, { mode: "run" })).toEqual([])
    // The regression: this threw rather than returning issues.
    expect(
      validateMetricSelectionAgainstCatalog(def as never, METRIC_CATALOG)
    ).toEqual([])
  })

  test("a section metric the catalogue declares is accepted", () => {
    expect(
      validateMetricSelectionAgainstCatalog(
        v3WithMetrics("Percentage CPU") as never,
        METRIC_CATALOG
      )
    ).toEqual([])
  })

  test("a section metric the catalogue does NOT declare is rejected, not thrown", () => {
    // Without this, "make it stop throwing" could have been satisfied by skipping v3
    // entirely -- which would let an unknown metric reach a run.
    const issues = validateMetricSelectionAgainstCatalog(
      v3WithMetrics("Nonexistent Metric") as never,
      METRIC_CATALOG
    )

    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]?.path).toEqual(["sections", 0, "metrics", 0])
  })

  test("the v1 map-shaped path still validates", () => {
    const v1 = {
      schema_version: 1,
      metrics: {
        "Microsoft.Compute/virtualMachines": [
          { metric: "Nonexistent Metric", statistic: "Maximum" },
        ],
      },
    }

    expect(
      validateMetricSelectionAgainstCatalog(v1 as never, METRIC_CATALOG).length
    ).toBeGreaterThan(0)
  })
})
