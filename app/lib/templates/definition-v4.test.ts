import { describe, expect, test } from "vitest"

import {
  SECTION_SLOTS_BY_PROVIDER,
  collectDefinitionIssues,
  containsNumeral,
} from "@/lib/templates/definition"

/**
 * Schema v4 on the web half: a section's own layout. The shared corpus in
 * `agent/tests/fixtures/definitions/` holds both validators to one verdict per fixture;
 * these pin what the builder leans on directly — the slot table, the numeral rule, and
 * that every fault in a layout is named at its own path.
 */

function v4(sections: unknown[], language: "en" | "id" = "en") {
  return {
    schema_version: 4,
    identity: { name: "Test", language },
    provider: "aws",
    sections,
    period: { kind: "last_full_month" },
    design: {
      preset: "editorial",
      accent_color: "#2f3c7e",
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
    front_matter: { cover: {}, document_control: {}, toc: {} },
  }
}

const ec2 = (extra: Record<string, unknown> = {}) => ({
  id: "sec_ec2",
  type: "ec2_utilization",
  position: 0,
  metrics: [{ metric: "CPUUtilization", statistic: "avg" }],
  ...extra,
})

const paths = (definition: unknown) =>
  collectDefinitionIssues(definition).map((issue) => issue.path.join("."))

describe("the slot table", () => {
  test("names every expansion of both providers, with the per-resource run marked", () => {
    const aws = SECTION_SLOTS_BY_PROVIDER.aws.ec2_utilization
    expect(aws.map((shape) => shape.slot)).toEqual([
      "title",
      "name",
      "details",
      "chart",
      "summary",
      "narrative",
      "fleet",
    ])
    expect(aws.filter((shape) => shape.per === "resource").map((s) => s.slot)).toEqual([
      "name",
      "details",
      "chart",
      "summary",
      "narrative",
    ])
    expect(SECTION_SLOTS_BY_PROVIDER.azure.vm_utilization.map((s) => s.slot)).toContain("chart")
  })

  test("AWS and Azure keep their own sections", () => {
    expect(SECTION_SLOTS_BY_PROVIDER.aws.rightsizing).toBeDefined()
    expect(SECTION_SLOTS_BY_PROVIDER.azure.rightsizing).toBeUndefined()
    expect(SECTION_SLOTS_BY_PROVIDER.azure.recommendations).toBeDefined()
  })

  test("a section title is required and renamable; a table carries its columns", () => {
    const [title, , details] = SECTION_SLOTS_BY_PROVIDER.aws.ec2_utilization
    expect(title).toMatchObject({ titled: true, required: true })
    expect(details.columns).toEqual([
      "instance_type",
      "platform",
      "private_ip",
      "location",
      "power_state",
    ])
  })
})

describe("typed text carries no numbers", () => {
  test.each(["Top 5", "٣ servers", "Phase Ⅱ", "½ the fleet"])("%s is refused", (text) => {
    expect(containsNumeral(text)).toBe(true)
  })

  test("words pass", () => {
    expect(containsNumeral("Each instance has its own chart.")).toBe(false)
  })
})

describe("a v4 layout", () => {
  test("a full layout is accepted", () => {
    const definition = v4([
      ec2({
        blocks: [
          { slot: "title", title: { en: "Instance use" } },
          { kind: "text", id: "u_note", text: { en: "Read this first." } },
          {
            slot: "each",
            blocks: [
              { slot: "chart" },
              { slot: "details", columns: ["power_state"] },
              { slot: "narrative", hidden: true },
            ],
          },
          { slot: "fleet", hidden: true },
        ],
      }),
    ])
    expect(paths(definition)).toEqual([])
  })

  test("every fault is named at its own path", () => {
    const definition = v4([
      ec2({
        presentation: "chart_only",
        blocks: [
          { slot: "title", hidden: true },
          { kind: "text", id: "note", text: { en: "Top 5" } },
          { slot: "chart" },
          { slot: "each", blocks: [{ slot: "details", columns: ["vm_size"] }] },
        ],
      }),
    ])
    expect(paths(definition)).toEqual(
      expect.arrayContaining([
        "sections.0.presentation",
        "sections.0.blocks.0.hidden",
        "sections.0.blocks.1.id",
        "sections.0.blocks.1.text.en",
        "sections.0.blocks.2.slot",
        "sections.0.blocks.3.blocks.0.columns.0",
      ])
    )
  })

  test("added text needs the report's language", () => {
    const definition = v4(
      [ec2({ blocks: [{ kind: "text", id: "u_a", text: { en: "English only." } }] })],
      "id"
    )
    expect(paths(definition)).toContain("sections.0.blocks.0.text.id")
  })

  test("a position is required, and the location filter is v4 only", () => {
    const { position: _drop, ...noPosition } = ec2()
    void _drop
    expect(paths(v4([noPosition]))).toContain("sections.0.position")

    const located = ec2({
      selection: {
        resource_types: [],
        resource_groups: [],
        tag_filters: [],
        top_n: null,
        sort: null,
        locations: ["ap-southeast-1"],
      },
    })
    expect(paths(v4([located]))).toEqual([])
    expect(paths({ ...v4([located]), schema_version: 3 })).toContain(
      "sections.0.selection.locations"
    )
  })
})
