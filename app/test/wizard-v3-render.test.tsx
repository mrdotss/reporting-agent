import { render } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"

import { StepDocument } from "@/components/templates/step-document"
import { StepPreview } from "@/components/templates/step-preview"
import type { TemplateDefinition } from "@/lib/templates/definition"
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
