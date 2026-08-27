import { describe, expect, test } from "vitest"

import { collectDefinitionIssues } from "@/lib/templates/definition"

/**
 * Task 4.1 — `front_matter` at schema_version 3 (Requirements 12.1, 12.3, 12.4,
 * 12.5, 12.6, 12.7, 14.1-14.4).
 *
 * `definition.test.ts` predates schema_version 3 entirely and has no v3 builder of
 * its own — v3 acceptance is otherwise proven only by the shared JSON fixture
 * corpus (`agent/tests/fixtures/definitions/accept-schema-version-3-minimal.json`,
 * read by both languages). That fixture is deliberately minimal — no
 * `distribution`, no `confidentiality_notice_id` — so it does not exercise any of
 * the branches this task adds. This file builds its own minimal valid v3
 * definition and targets exactly the new branches: `distribution` as rows,
 * `confidentiality_notice_id` becoming Brand-only, and the approver `company` /
 * `signature_key` fields.
 */

function validV3Definition(): Record<string, unknown> {
  return {
    schema_version: 3,
    identity: { name: "Test v3", language: "en" },
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
}

function pathsOf(issues: readonly { path: readonly (string | number)[] }[]) {
  return issues.map((issue) => issue.path.join("."))
}

describe("the minimal v3 fixture itself validates", () => {
  test("no issues", () => {
    expect(collectDefinitionIssues(validV3Definition())).toEqual([])
  })
})

describe("Requirement 12.6 — distribution becomes rows at v3, stays a string at v1/v2", () => {
  test("a v3 definition accepts distribution as {recipient, company, note} rows", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.distribution = [
      { recipient: "Ops team", company: "Contoso", note: "cc finance" },
      { recipient: "CTO" },
    ]
    expect(collectDefinitionIssues(definition)).toEqual([])
  })

  test("a v3 definition rejects a string distribution — the v1/v2 shape", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.distribution = "Ops team, CTO"

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain("front_matter.document_control.distribution")
  })

  test("a v3 distribution row requires a non-empty recipient", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.distribution = [{ company: "Contoso", note: "no recipient" }]

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain(
      "front_matter.document_control.distribution.0.recipient"
    )
  })

  test("a v3 distribution row rejects an unrecognized field", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.distribution = [{ recipient: "Ops", phone: "555-0100" }]

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain(
      "front_matter.document_control.distribution.0.phone"
    )
  })

  test("more than 50 distribution rows is rejected", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.distribution = Array.from({ length: 51 }, (_, i) => ({
      recipient: `Recipient ${i}`,
    }))

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain(
      "front_matter.document_control.distribution"
    )
  })

  test("an empty distribution array is accepted (Requirement 12.6's 'header only')", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.distribution = []
    expect(collectDefinitionIssues(definition)).toEqual([])
  })

  test("a v2 definition still accepts the free-text string form, unchanged", () => {
    const definition: Record<string, unknown> = {
      schema_version: 2,
      identity: {
        name: "Monthly utilization",
        description: "",
        report_title: "Monthly report",
        language: "en",
      },
      scope: {
        resource_types: ["Microsoft.Compute/virtualMachines"],
        tag_filters: [],
        resource_groups: [],
        top_n: null,
        sort: null,
      },
      period: { kind: "last_full_month" },
      metrics: {},
      blocks: [],
      design: {
        preset: "editorial",
        accent_color: "oklch(0.52 0.105 223)",
        density: "normal",
        table_style: "hairline",
        page_size: "A4",
        number_format: { decimal_places: 1, group_thousands: true },
        cover_page: true,
        logo: null,
      },
      front_matter: {
        cover: {},
        document_control: { distribution: "Ops team, CTO" },
        toc: {},
      },
    }
    expect(collectDefinitionIssues(definition)).toEqual([])
  })
})

describe("Requirement 12.7 — confidentiality is Brand-inherited at v3, not author-editable", () => {
  test("a v3 definition carrying confidentiality_notice_id is rejected", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.confidentiality_notice_id = "doc.confidentiality.default"

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain(
      "front_matter.document_control.confidentiality_notice_id"
    )
    expect(
      issues.some((issue) => issue.message.includes("inherited from the Brand"))
    ).toBe(true)
  })

  test("a v2 definition still accepts and validates confidentiality_notice_id, unchanged", () => {
    const definition: Record<string, unknown> = {
      schema_version: 2,
      identity: {
        name: "Monthly utilization",
        description: "",
        report_title: "Monthly report",
        language: "en",
      },
      scope: {
        resource_types: ["Microsoft.Compute/virtualMachines"],
        tag_filters: [],
        resource_groups: [],
        top_n: null,
        sort: null,
      },
      period: { kind: "last_full_month" },
      metrics: {},
      blocks: [],
      design: {
        preset: "editorial",
        accent_color: "oklch(0.52 0.105 223)",
        density: "normal",
        table_style: "hairline",
        page_size: "A4",
        number_format: { decimal_places: 1, group_thousands: true },
        cover_page: true,
        logo: null,
      },
      front_matter: {
        cover: {},
        document_control: { confidentiality_notice_id: "doc.confidentiality.default" },
        toc: {},
      },
    }
    expect(collectDefinitionIssues(definition)).toEqual([])

    const badDefinition = {
      ...definition,
      front_matter: {
        ...(definition.front_matter as Record<string, unknown>),
        document_control: { confidentiality_notice_id: "not-a-catalog-id" },
      },
    }
    const issues = collectDefinitionIssues(badDefinition)
    expect(pathsOf(issues)).toContain(
      "front_matter.document_control.confidentiality_notice_id"
    )
  })
})

describe("Requirement 12.4 — approver company and signature_key are additive at v3", () => {
  test("a v3 approver accepts company and signature_key alongside name and title", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.approvers = [
      {
        role: "author",
        name: "Alice",
        title: "Lead Consultant",
        company: "Contoso Consulting",
        signature_key: "signatures/u123/author.png",
      },
    ]
    expect(collectDefinitionIssues(definition)).toEqual([])
  })

  test("a v3 approver accepts a null signature_key (no signature yet)", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.approvers = [{ role: "author", name: "Alice", signature_key: null }]
    expect(collectDefinitionIssues(definition)).toEqual([])
  })

  test("a v2 approver rejects company and signature_key as unrecognized fields", () => {
    const definition: Record<string, unknown> = {
      schema_version: 2,
      identity: {
        name: "Monthly utilization",
        description: "",
        report_title: "Monthly report",
        language: "en",
      },
      scope: {
        resource_types: ["Microsoft.Compute/virtualMachines"],
        tag_filters: [],
        resource_groups: [],
        top_n: null,
        sort: null,
      },
      period: { kind: "last_full_month" },
      metrics: {},
      blocks: [],
      design: {
        preset: "editorial",
        accent_color: "oklch(0.52 0.105 223)",
        density: "normal",
        table_style: "hairline",
        page_size: "A4",
        number_format: { decimal_places: 1, group_thousands: true },
        cover_page: true,
        logo: null,
      },
      front_matter: {
        cover: {},
        document_control: {
          approvers: [{ role: "author", name: "Alice", company: "Contoso" }],
        },
        toc: {},
      },
    }

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain(
      "front_matter.document_control.approvers.0.company"
    )
  })

  test("company is bounded the same as title", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.approvers = [
      { role: "author", name: "Alice", company: "x".repeat(121) },
    ]

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain(
      "front_matter.document_control.approvers.0.company"
    )
  })

  test("an empty-string signature_key is rejected — null or a real key, nothing else", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.approvers = [{ role: "author", name: "Alice", signature_key: "" }]

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain(
      "front_matter.document_control.approvers.0.signature_key"
    )
  })

  test("a signature_key over the length ceiling is rejected", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.approvers = [
      { role: "author", name: "Alice", signature_key: "s".repeat(513) },
    ]

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain(
      "front_matter.document_control.approvers.0.signature_key"
    )
  })

  test("the closed four-role set is still enforced at v3 — a fifth role is rejected", () => {
    const definition = validV3Definition()
    const control = (definition.front_matter as Record<string, unknown>)
      .document_control as Record<string, unknown>
    control.approvers = [
      { role: "author", name: "A" },
      { role: "reviewer", name: "B" },
      { role: "approver", name: "C" },
      { role: "recipient", name: "D" },
      { role: "witness", name: "E" },
    ]

    const issues = collectDefinitionIssues(definition)
    expect(
      issues.some((issue) =>
        issue.path.join(".").startsWith("front_matter.document_control.approvers")
      )
    ).toBe(true)
  })
})
