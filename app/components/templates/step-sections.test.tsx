import { StrictMode } from "react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { StepSections, type SectionCatalogueEntry } from "./step-sections"

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOGUE: SectionCatalogueEntry[] = [
  {
    key: "azure_subscription",
    number: 1,
    title_id: "doc.section.azure_subscription",
    group: "inventory",
    position: "free",
    repeatable: false,
    needs_resource_types: [],
    needs_fact_sources: [],
    metric_bearing: false,
  },
  {
    key: "vm_utilization",
    number: 4,
    title_id: "doc.section.vm_utilization",
    group: "utilisation",
    position: "free",
    repeatable: false,
    needs_resource_types: ["Microsoft.Compute/virtualMachines"],
    needs_fact_sources: [],
    metric_bearing: true,
  },
  {
    key: "fleet_summary",
    number: 3,
    title_id: "doc.section.fleet_summary",
    group: "inventory",
    position: "free",
    repeatable: false,
    needs_resource_types: [],
    needs_fact_sources: [],
    metric_bearing: false,
  },
  {
    key: "backup_report",
    number: 12,
    title_id: "doc.section.backup_report",
    group: "closing",
    position: "fixed",
    repeatable: false,
    needs_resource_types: [],
    needs_fact_sources: ["recovery_services"],
    metric_bearing: false,
  },
  {
    key: "coverage_and_verification",
    number: 15,
    title_id: "doc.section.coverage_and_verification",
    group: "closing",
    position: "always",
    repeatable: false,
    needs_resource_types: [],
    needs_fact_sources: [],
    metric_bearing: false,
  },
  {
    key: "app_service_and_storage",
    number: 6,
    title_id: "doc.section.app_service_and_storage",
    group: "utilisation",
    position: "free",
    repeatable: true,
    needs_resource_types: ["Microsoft.Web/sites"],
    needs_fact_sources: [],
    metric_bearing: true,
  },
]

function makeDefinition(sections: unknown[] = []): unknown {
  return {
    schema_version: 3,
    identity: { name: "Test", language: "en" },
    provider: "azure",
    sections,
    period: { kind: "last_full_month" },
    design: { preset: "corporate" },
    front_matter: {},
  }
}

function makeSection(
  type: string,
  id: string = `sec_${type}`
): {
  id: string
  type: string
  selection: object
  metrics: unknown[]
  presentation: string
} {
  return {
    id,
    type,
    selection: {
      resource_types: [],
      resource_groups: [],
      tag_filters: [],
      top_n: null,
      sort: null,
    },
    metrics: [],
    presentation: "chart_and_table",
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StepSections grouping", () => {
  test("groups authored sections by their catalogue group", () => {
    const sections = [
      makeSection("azure_subscription"),
      makeSection("vm_utilization"),
      makeSection("backup_report"),
    ]
    const definition = makeDefinition(sections)

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={() => {}}
          sectionCatalogue={CATALOGUE}
        />
      </StrictMode>
    )

    const inventoryList = screen.getByLabelText("Inventory sections")
    const utilisationList = screen.getByLabelText("Utilisation sections")
    const closingList = screen.getByLabelText("Closing sections")

    expect(inventoryList.querySelectorAll("li")).toHaveLength(1)
    expect(utilisationList.querySelectorAll("li")).toHaveLength(1)
    expect(closingList.querySelectorAll("li")).toHaveLength(1)
  })
})

describe("StepSections fixed position", () => {
  test("fixed/always sections show no reorder buttons", () => {
    const sections = [
      makeSection("vm_utilization"),
      makeSection("backup_report"),
      makeSection("coverage_and_verification"),
    ]
    const definition = makeDefinition(sections)

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={() => {}}
          sectionCatalogue={CATALOGUE}
        />
      </StrictMode>
    )

    // Fixed sections get "Fixed" text instead of arrow buttons
    const fixedLabels = screen.getAllByText("Fixed")
    expect(fixedLabels).toHaveLength(2) // backup_report + coverage_and_verification

    // Free section has arrow buttons
    expect(screen.getByLabelText(/Move .* up/)).toBeInTheDocument()
  })
})

describe("StepSections keyboard reorder", () => {
  test("up/down buttons reorder free sections", () => {
    const sections = [
      makeSection("azure_subscription", "sec_a"),
      makeSection("fleet_summary", "sec_b"),
    ]
    const definition = makeDefinition(sections)
    const onChange = vi.fn()

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={onChange}
          sectionCatalogue={CATALOGUE}
        />
      </StrictMode>
    )

    // Move the first section down
    const downButtons = screen.getAllByLabelText(/Move .* down/)
    fireEvent.click(downButtons[0]!)

    expect(onChange).toHaveBeenCalledTimes(1)
    const updated = onChange.mock.calls[0]![0] as { sections: { id: string }[] }
    expect(updated.sections[0]!.id).toBe("sec_b")
    expect(updated.sections[1]!.id).toBe("sec_a")
  })

  test("move up at position 0 does nothing", () => {
    const sections = [
      makeSection("azure_subscription", "sec_a"),
      makeSection("fleet_summary", "sec_b"),
    ]
    const definition = makeDefinition(sections)
    const onChange = vi.fn()

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={onChange}
          sectionCatalogue={CATALOGUE}
        />
      </StrictMode>
    )

    // Move the first section up — should be no-op
    const upButtons = screen.getAllByLabelText(/Move .* up/)
    fireEvent.click(upButtons[0]!)

    expect(onChange).not.toHaveBeenCalled()
  })
})

describe("StepSections add section", () => {
  test("repeatable:false entries not already authored are offered", () => {
    const sections = [makeSection("azure_subscription")]
    const definition = makeDefinition(sections)

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={() => {}}
          sectionCatalogue={CATALOGUE}
        />
      </StrictMode>
    )

    // Open the add menu
    fireEvent.click(screen.getByTestId("add-section-trigger"))

    // azure_subscription is already authored and not repeatable — not offered
    expect(screen.queryByTestId("add-section-azure_subscription")).toBeNull()

    // vm_utilization is not authored — offered
    expect(screen.getByTestId("add-section-vm_utilization")).toBeInTheDocument()
  })

  test("repeatable entries are always offered even when authored", () => {
    const sections = [makeSection("app_service_and_storage")]
    const definition = makeDefinition(sections)

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={() => {}}
          sectionCatalogue={CATALOGUE}
        />
      </StrictMode>
    )

    fireEvent.click(screen.getByTestId("add-section-trigger"))

    // app_service_and_storage is repeatable — still offered
    expect(
      screen.getByTestId("add-section-app_service_and_storage")
    ).toBeInTheDocument()
  })

  test("adding a section calls onChange with the new entry appended", () => {
    const sections = [makeSection("azure_subscription")]
    const definition = makeDefinition(sections)
    const onChange = vi.fn()

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={onChange}
          sectionCatalogue={CATALOGUE}
        />
      </StrictMode>
    )

    fireEvent.click(screen.getByTestId("add-section-trigger"))
    fireEvent.click(screen.getByTestId("add-section-vm_utilization"))

    expect(onChange).toHaveBeenCalledTimes(1)
    const updated = onChange.mock.calls[0]![0] as {
      sections: { type: string }[]
    }
    expect(updated.sections).toHaveLength(2)
    expect(updated.sections[1]!.type).toBe("vm_utilization")
  })
})

describe("StepSections offerability (task 6.5, Req 15.9, 16.1-16.3)", () => {
  test("with no scan props at all, every entry stays offerable -- a wizard opened before this task behaves unchanged", () => {
    const sections = [makeSection("azure_subscription")]
    const definition = makeDefinition(sections)

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={() => {}}
          sectionCatalogue={CATALOGUE}
        />
      </StrictMode>
    )

    fireEvent.click(screen.getByTestId("add-section-trigger"))
    const vmButton = screen.getByTestId("add-section-vm_utilization")
    expect(vmButton).not.toBeDisabled()
  })

  test("a section needing a resource type absent from the scan renders disabled and names the missing type", () => {
    const sections = [makeSection("azure_subscription")]
    const definition = makeDefinition(sections)

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={() => {}}
          sectionCatalogue={CATALOGUE}
          scanTypeCounts={{}}
          collectedFactSources={new Set(["resource_graph"])}
        />
      </StrictMode>
    )

    fireEvent.click(screen.getByTestId("add-section-trigger"))
    const vmButton = screen.getByTestId("add-section-vm_utilization")
    expect(vmButton).toBeDisabled()
    expect(vmButton.textContent).toContain("Microsoft.Compute/virtualMachines")
  })

  test("clicking a disabled entry does not call onChange", () => {
    const sections = [makeSection("azure_subscription")]
    const definition = makeDefinition(sections)
    const onChange = vi.fn()

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={onChange}
          sectionCatalogue={CATALOGUE}
          scanTypeCounts={{}}
          collectedFactSources={new Set(["resource_graph"])}
        />
      </StrictMode>
    )

    fireEvent.click(screen.getByTestId("add-section-trigger"))
    fireEvent.click(screen.getByTestId("add-section-vm_utilization"))

    expect(onChange).not.toHaveBeenCalled()
  })

  test("once the scan carries the needed resource type, the entry is offerable", () => {
    const sections = [makeSection("azure_subscription")]
    const definition = makeDefinition(sections)
    const onChange = vi.fn()

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={onChange}
          sectionCatalogue={CATALOGUE}
          scanTypeCounts={{ "Microsoft.Compute/virtualMachines": 3 }}
          collectedFactSources={new Set(["resource_graph"])}
        />
      </StrictMode>
    )

    fireEvent.click(screen.getByTestId("add-section-trigger"))
    const vmButton = screen.getByTestId("add-section-vm_utilization")
    expect(vmButton).not.toBeDisabled()
    fireEvent.click(vmButton)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test("a section needing a fact source not yet collected renders disabled and names the source", () => {
    const sections = [makeSection("azure_subscription")]
    const definition = makeDefinition(sections)

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={() => {}}
          sectionCatalogue={CATALOGUE}
          scanTypeCounts={{ "Microsoft.Compute/virtualMachines": 3 }}
          collectedFactSources={new Set()}
        />
      </StrictMode>
    )

    fireEvent.click(screen.getByTestId("add-section-trigger"))
    const backupButton = screen.getByTestId("add-section-backup_report")
    expect(backupButton).toBeDisabled()
    expect(backupButton.textContent).toContain("recovery_services")
  })

  test("an entry declaring neither stays offerable regardless of the scan", () => {
    const sections = [makeSection("vm_utilization")]
    const definition = makeDefinition(sections)

    render(
      <StrictMode>
        <StepSections
          definition={definition}
          onChange={() => {}}
          sectionCatalogue={CATALOGUE}
          scanTypeCounts={{}}
          collectedFactSources={new Set()}
        />
      </StrictMode>
    )

    fireEvent.click(screen.getByTestId("add-section-trigger"))
    // fleet_summary declares neither needs_resource_types nor needs_fact_sources
    expect(screen.getByTestId("add-section-fleet_summary")).not.toBeDisabled()
  })
})
