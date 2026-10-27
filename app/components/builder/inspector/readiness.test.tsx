import { afterEach, describe, expect, test } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { BuilderProvider, useBuilder, type BuilderEnvironment } from "@/components/builder/context"
import { emptyDraftV4, newSection } from "@/lib/builder/draft"
import type { DefinitionV4 } from "@/lib/builder/model"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

import { Readiness } from "./readiness"

/** "Before you publish": the checks that are left, and each issue opening what fixes it. */

afterEach(cleanup)

const environment: BuilderEnvironment = {
  templateId: "tmpl-1",
  catalog: METRIC_CATALOG,
  collectedFactSources: [],
  metricsHistorySince: null,
  latestVersion: null,
  liveDefinition: null,
  previewSources: [],
}

function Where() {
  const tab = useBuilder((state) => state.leftTab)
  const selection = useBuilder((state) => state.selection)
  return <div data-testid="where">{JSON.stringify({ tab, selection })}</div>
}

function mount(initial: DefinitionV4) {
  render(
    <BuilderProvider initial={initial} environment={environment}>
      <Readiness />
      <Where />
    </BuilderProvider>
  )
}

describe("Readiness", () => {
  test("an empty draft lists what is left and opens the panel that fixes it", () => {
    mount(emptyDraftV4("Draft", "aws"))
    expect(screen.getByRole("status").textContent).toMatch(/\d+ left/)
    const checks = screen.getAllByRole("listitem").map((item) => item.textContent)
    expect(checks).toContain("To fix: Customer named")
    expect(checks).toContain("To fix: At least one section")
    fireEvent.click(screen.getByRole("button", { name: /customer/i }))
    expect(JSON.parse(screen.getByTestId("where").textContent!).tab).toBe("document")
  })

  test("a complete draft is ready", () => {
    const base = emptyDraftV4("Draft", "aws")
    mount({
      ...base,
      identity: { ...base.identity, customer_name: "Contoso" },
      sections: [{ ...newSection("aws", "ec2_utilization", METRIC_CATALOG), position: 10 }],
    })
    expect(screen.getByRole("status").textContent).toBe("Ready")
    expect(screen.queryAllByText("To fix: ")).toEqual([])
  })
})
