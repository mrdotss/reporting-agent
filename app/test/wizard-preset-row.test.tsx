import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { StepSections } from "@/components/templates/step-sections"
import { expandPreset, DEFAULT_PRESET_NAME } from "@/lib/profiles/presets"
import { sectionByKey } from "@/lib/profiles/sections"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

afterEach(cleanup)

/**
 * The wizard's preset row (Requirement 10.3), and the seeding it does on add.
 *
 * `addSection` hardcoded `metrics: []` and the inspector rendered
 * `Metric-bearing: Yes` as read-only text — so a consultant could add a
 * metric-bearing section, see it confirm that it carries metrics, and publish a
 * profile that requested none. The run then failed `NO_STATISTICS` with an empty
 * `collection_log`, blaming the estate for the wizard's omission.
 *
 * Driven against the REAL catalogues, because the point is that what the wizard
 * writes is what the collector can request.
 */

const VM_UTILIZATION = "vm_utilization"

/** The real catalogue entries the wizard is given, as the page passes them. */
const CATALOGUE = [
  sectionByKey(VM_UTILIZATION)!,
  sectionByKey("azure_subscription")!,
]

function renderStep(
  sections: readonly Record<string, unknown>[],
  onChange = vi.fn()
) {
  render(
    <StepSections
      definition={{ schema_version: 3, sections }}
      onChange={onChange}
      sectionCatalogue={CATALOGUE}
      catalog={METRIC_CATALOG}
    />
  )
  return onChange
}

describe("adding a metric-bearing section seeds the default preset", () => {
  test("addSection writes concrete metrics, not an empty array", () => {
    const onChange = renderStep([])

    fireEvent.click(screen.getByRole("button", { name: /Add section/i }))
    fireEvent.click(
      screen.getByRole("button", { name: /Virtual Machine Utilization/i })
    )

    expect(onChange).toHaveBeenCalled()
    const next = onChange.mock.calls.at(-1)![0] as {
      sections: readonly Record<string, unknown>[]
    }
    const added = next.sections.at(-1)!
    const metrics = added.metrics as readonly unknown[]

    expect(Array.isArray(metrics)).toBe(true)
    expect(metrics.length).toBeGreaterThan(0)
    expect(metrics).toStrictEqual(
      expandPreset(
        sectionByKey(VM_UTILIZATION)!,
        DEFAULT_PRESET_NAME,
        METRIC_CATALOG
      )
    )
  })

  test("a non-metric-bearing section is still added with no metrics", () => {
    // `azure_subscription` needs no resource type, so it expands to nothing and
    // must not be given a fabricated selection.
    const onChange = renderStep([])

    fireEvent.click(screen.getByRole("button", { name: /Add section/i }))
    fireEvent.click(screen.getByRole("button", { name: /Azure Subscription/i }))

    const next = onChange.mock.calls.at(-1)![0] as {
      sections: readonly Record<string, unknown>[]
    }
    expect(next.sections.at(-1)!.metrics).toStrictEqual([])
  })
})

describe("the preset row", () => {
  const seeded = expandPreset(
    sectionByKey(VM_UTILIZATION)!,
    DEFAULT_PRESET_NAME,
    METRIC_CATALOG
  )

  test("shows the catalogue's tiers plus Custom, with the seeded one selected", () => {
    renderStep([{ id: "s1", type: VM_UTILIZATION, metrics: seeded }])

    expect(
      screen.getByRole("radio", { name: /Standard utilization/i })
    ).toBeChecked()
    expect(
      screen.getByRole("radio", { name: /Capacity planning/i })
    ).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Custom/i })).not.toBeChecked()
  })

  test("choosing another tier rewrites the section's metrics", () => {
    const onChange = renderStep([
      { id: "s1", type: VM_UTILIZATION, metrics: seeded },
    ])

    fireEvent.click(screen.getByRole("radio", { name: /Capacity planning/i }))

    const next = onChange.mock.calls.at(-1)![0] as {
      sections: readonly Record<string, unknown>[]
    }
    expect(next.sections[0]!.metrics).toStrictEqual(
      expandPreset(
        sectionByKey(VM_UTILIZATION)!,
        "capacity_planning",
        METRIC_CATALOG
      )
    )
  })

  test("a selection matching no tier reads as Custom", () => {
    renderStep([{ id: "s1", type: VM_UTILIZATION, metrics: seeded.slice(1) }])

    expect(screen.getByRole("radio", { name: /Custom/i })).toBeChecked()
  })

  test("no preset row when no catalog is supplied", () => {
    // The prop is optional so existing tests keep working; without it the step
    // must not crash or render a half-built row.
    render(
      <StepSections
        definition={{
          schema_version: 3,
          sections: [{ id: "s1", type: VM_UTILIZATION, metrics: [] }],
        }}
        onChange={() => {}}
        sectionCatalogue={CATALOGUE}
      />
    )

    expect(
      screen.queryByRole("radio", { name: /Standard utilization/i })
    ).not.toBeInTheDocument()
  })
})
