import { describe, expect, test } from "vitest"

import { collectDefinitionIssues } from "@/lib/templates/definition"

/**
 * `lookback` on a v3 section (task 7.3, Req 21.5).
 *
 * Author-set, with no catalogue default: `lookback` is a number the document
 * prints and `agent/.../verify/derived_counts.py` independently re-derives and
 * verifies as a `derived_count("historical_lookback", ...)`. A catalogue default
 * would make every profile print a history depth nobody chose, and the verifier
 * would confirm a claim no human made — so it is validated here as permitted-
 * not-required in general, and REQUIRED specifically for
 * `historical_vm_utilization`, the one section type that reads it
 * (`compile/sections.py`'s `_thread_metric_config` threads it into
 * `historical_trend`'s config).
 */

function validV3Definition(): Record<string, unknown> {
  return {
    schema_version: 3,
    identity: { name: "Test v3", language: "en" },
    provider: "azure",
    sections: [
      {
        id: "sec_hist",
        type: "historical_vm_utilization",
        selection: {
          resource_types: ["Microsoft.Compute/virtualMachines"],
          resource_groups: [],
          tag_filters: [],
          top_n: null,
          sort: null,
        },
        metrics: [{ metric: "Percentage CPU", statistic: "avg" }],
        presentation: "chart_and_table",
        lookback: 6,
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
}

function pathsOf(issues: readonly { path: readonly (string | number)[] }[]) {
  return issues.map((issue) => issue.path.join("."))
}

function withSection(
  definition: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const sections = definition.sections as Record<string, unknown>[]
  return {
    ...definition,
    sections: [{ ...sections[0], ...patch }],
  }
}

describe("the valid historical_vm_utilization fixture with lookback: 6", () => {
  test("no issues", () => {
    expect(collectDefinitionIssues(validV3Definition())).toEqual([])
  })
})

describe("historical_vm_utilization without lookback is rejected, naming the field", () => {
  test("absent lookback is an issue at sections.0.lookback", () => {
    const definition = validV3Definition()
    const sections = definition.sections as Record<string, unknown>[]
    delete sections[0]!.lookback

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain("sections.0.lookback")
  })
})

describe("lookback bounds (2-24 inclusive, mirroring HISTORICAL_LOOKBACK_MIN/MAX)", () => {
  test.each([2, 12, 24])("%s is accepted", (value) => {
    const definition = withSection(validV3Definition(), { lookback: value })
    expect(collectDefinitionIssues(definition)).toEqual([])
  })

  test.each([0, 1, 25, 100, -1])("%s is rejected", (value) => {
    const definition = withSection(validV3Definition(), { lookback: value })
    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain("sections.0.lookback")
  })

  test.each([6.5, "6", null, true, [6]])(
    "a non-integer value %s is rejected",
    (value) => {
      const definition = withSection(validV3Definition(), { lookback: value })
      const issues = collectDefinitionIssues(definition)
      expect(pathsOf(issues)).toContain("sections.0.lookback")
    }
  )
})

describe("lookback is permitted-not-required for a section type that does not read it", () => {
  test("vm_utilization accepts a definition with no lookback at all", () => {
    const definition = withSection(
      { ...validV3Definition(), sections: [{ type: "vm_utilization" }] },
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
      }
    )
    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).not.toContain("sections.0.lookback")
  })

  test("vm_utilization also accepts a definition that carries lookback anyway", () => {
    // Permitted-not-required: no section type is forbidden from carrying it,
    // only historical_vm_utilization requires it.
    const definition = withSection(validV3Definition(), {
      type: "vm_utilization",
      lookback: 6,
    })
    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).not.toContain("sections.0.lookback")
  })
})
