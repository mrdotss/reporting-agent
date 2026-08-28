import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { StepIdentity } from "@/components/templates/step-identity"
import { StepSections } from "@/components/templates/step-sections"
import {
  HISTORICAL_LOOKBACK_MAX,
  HISTORICAL_LOOKBACK_MIN,
  collectDefinitionIssues,
} from "@/lib/templates/definition"

afterEach(cleanup)

/**
 * Two wizard dead-ends: a value the validator or the enqueue gate REQUIRES that
 * no control anywhere could set. Both were reachable in production —
 * `identity.customer_name` made every v3 run fail with
 * `front_matter_values_missing`, and a missing `lookback` made any profile
 * containing section 9 unsaveable — and both were invisible to the suite because
 * every test built its definition object literally rather than through the UI.
 *
 * These tests drive the real components, so deleting either control fails here.
 */

describe("step 1 collects identity.customer_name (enqueue requires it)", () => {
  function renderIdentity(
    definition: Record<string, unknown>,
    onChange = vi.fn()
  ) {
    render(
      <StepIdentity
        definition={definition as never}
        onChange={onChange}
        templateId="tpl-1"
        storedName=""
        saveState={{ kind: "idle" }}
        onSave={() => {}}
        onRetryRename={() => {}}
      />
    )
    return onChange
  }

  test("renders a Customer name input", () => {
    renderIdentity({
      schema_version: 3,
      identity: { name: "Enesis", language: "en" },
    })

    expect(screen.getByLabelText("Customer name")).toBeInTheDocument()
  })

  test("typing a customer name writes identity.customer_name", () => {
    const onChange = renderIdentity({
      schema_version: 3,
      identity: { name: "Enesis", language: "en" },
    })

    fireEvent.change(screen.getByLabelText("Customer name"), {
      target: { value: "Enesis Group" },
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as {
      identity: { customer_name?: string; name: string }
    }
    expect(next.identity.customer_name).toBe("Enesis Group")
    // Must not clobber its siblings.
    expect(next.identity.name).toBe("Enesis")
  })

  test("shows an already-stored customer name", () => {
    renderIdentity({
      schema_version: 3,
      identity: { name: "Enesis", language: "en", customer_name: "Acme Ltd" },
    })

    expect(screen.getByDisplayValue("Acme Ltd")).toBeInTheDocument()
  })

  test("a customer name is accepted by the v3 validator on identity", () => {
    // The write above has to survive validation, not merely reach state.
    const issues = collectDefinitionIssues(
      {
        schema_version: 3,
        provider: "azure",
        identity: {
          name: "Enesis",
          language: "en",
          description: "",
          report_title: "Enesis",
          customer_name: "Enesis Group",
        },
        sections: [],
        period: { kind: "last_full_month" },
        design: {
          preset: "corporate",
          density: "normal",
          table_style: "hairline",
          number_format: "id-ID",
          cover_page: true,
          page_size: "A4",
        },
        front_matter: { cover: {}, document_control: {}, toc: {} },
      },
      { mode: "draft" }
    )

    expect(
      issues.filter((i) => i.path.includes("customer_name"))
    ).toStrictEqual([])
  })
})

describe("step 2's inspector sets a section's lookback", () => {
  const HISTORICAL = "historical_vm_utilization"

  const CATALOGUE = [
    {
      key: HISTORICAL,
      number: 9,
      title_id: "doc.section.historical_vm_utilization",
      group: "utilisation" as const,
      position: "free" as const,
      repeatable: false,
      needs_resource_types: ["Microsoft.Compute/virtualMachines"],
      needs_fact_sources: [],
      metric_bearing: true,
    },
    {
      key: "azure_subscription",
      number: 1,
      title_id: "doc.section.azure_subscription",
      group: "inventory" as const,
      position: "always" as const,
      repeatable: false,
      needs_resource_types: [],
      needs_fact_sources: [],
      metric_bearing: false,
    },
  ]

  function renderSections(
    sections: readonly Record<string, unknown>[],
    onChange = vi.fn()
  ) {
    render(
      <StepSections
        definition={{ schema_version: 3, sections }}
        onChange={onChange}
        sectionCatalogue={CATALOGUE}
      />
    )
    return onChange
  }

  /**
   * Click a section's own row button.
   *
   * Scoped to the group list rather than matched globally, because the reorder
   * arrows carry the section's title in their accessible names too — a bare
   * `getByRole("button", {name: /Historical/})` matches three elements.
   */
  function selectSection(listLabel: string) {
    const list = screen.getByLabelText(listLabel)
    const row = list.querySelector("li button")
    if (!(row instanceof HTMLElement)) {
      throw new Error(`no section row found in "${listLabel}"`)
    }
    fireEvent.click(row)
  }

  test("selecting the historical section reveals a Lookback input", () => {
    // `azure_subscription` first, because the component auto-selects
    // `sections[0]` on mount — so this starts on a section that reads no
    // lookback, and the input appearing is genuinely the result of selecting the
    // one that does.
    renderSections([
      { id: "s0", type: "azure_subscription" },
      { id: "s1", type: HISTORICAL },
    ])

    expect(screen.queryByLabelText(/Lookback/i)).not.toBeInTheDocument()

    selectSection("Utilisation sections")

    const input = screen.getByLabelText(/Lookback/i)
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute("min", String(HISTORICAL_LOOKBACK_MIN))
    expect(input).toHaveAttribute("max", String(HISTORICAL_LOOKBACK_MAX))
  })

  test("a section type that does not read lookback gets no input", () => {
    renderSections([{ id: "s1", type: "azure_subscription" }])

    selectSection("Inventory sections")

    expect(screen.queryByLabelText(/Lookback/i)).not.toBeInTheDocument()
  })

  test("entering a lookback writes it onto that section only", () => {
    const onChange = renderSections([
      { id: "s1", type: HISTORICAL },
      { id: "s2", type: "azure_subscription" },
    ])

    selectSection("Utilisation sections")
    fireEvent.change(screen.getByLabelText(/Lookback/i), {
      target: { value: "6" },
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as {
      sections: readonly Record<string, unknown>[]
    }
    expect(next.sections[0]).toMatchObject({ id: "s1", lookback: 6 })
    // The untouched section must not gain the key.
    expect(next.sections[1]).not.toHaveProperty("lookback")
  })

  test("clearing the field DELETES the key rather than writing undefined", () => {
    // The validator branches on `"lookback" in entry`; a present-but-undefined
    // key would report "must be an integer" for a field simply not filled in yet,
    // instead of the "requires lookback" message that says what to do.
    const onChange = renderSections([
      { id: "s1", type: HISTORICAL, lookback: 6 },
    ])

    selectSection("Utilisation sections")
    fireEvent.change(screen.getByLabelText(/Lookback/i), {
      target: { value: "" },
    })

    const next = onChange.mock.calls[0]![0] as {
      sections: readonly Record<string, unknown>[]
    }
    expect(Object.keys(next.sections[0]!)).not.toContain("lookback")
  })

  test("the written lookback satisfies the validator that demanded it", () => {
    const base = {
      schema_version: 3,
      provider: "azure",
      identity: {
        name: "Enesis",
        language: "en",
        description: "",
        report_title: "Enesis",
      },
      period: { kind: "last_full_month" },
      design: {
        preset: "corporate",
        density: "normal",
        table_style: "hairline",
        number_format: "id-ID",
        cover_page: true,
        page_size: "A4",
      },
      front_matter: { cover: {}, document_control: {}, toc: {} },
    }

    const without = collectDefinitionIssues(
      { ...base, sections: [{ id: "s1", type: HISTORICAL }] },
      { mode: "draft" }
    )
    expect(
      without.some(
        (i) =>
          i.path.includes("lookback") && /requires lookback/.test(i.message)
      )
    ).toBe(true)

    const withLookback = collectDefinitionIssues(
      { ...base, sections: [{ id: "s1", type: HISTORICAL, lookback: 6 }] },
      { mode: "draft" }
    )
    expect(
      withLookback.filter((i) => i.path.includes("lookback"))
    ).toStrictEqual([])
  })
})
