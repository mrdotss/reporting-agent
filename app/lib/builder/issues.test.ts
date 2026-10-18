import { describe, expect, test } from "vitest"

import { METRIC_CATALOG } from "@/lib/templates/catalog"

import { emptyDraftV4, newSection } from "./draft"
import { builderIssues } from "./issues"
import type { DefinitionV4 } from "./model"

/**
 * What the "N to fix" list holds beyond the validator — the three checks a draft may fail
 * and a version may not — and where each one sends the author.
 */

function draft(): DefinitionV4 {
  const base = emptyDraftV4("Test", "aws")
  return {
    ...base,
    identity: { ...base.identity, customer_name: "Contoso" },
    sections: [{ ...newSection("aws", "ec2_utilization", METRIC_CATALOG), position: 10 }],
  }
}

describe("builderIssues", () => {
  test("a complete draft has nothing to fix", () => {
    expect(builderIssues(draft())).toEqual([])
  })

  test.each(["", "   "])("a customer name of %j is missing, and sends the author to Document", (customer) => {
    const definition = { ...draft(), identity: { ...draft().identity, customer_name: customer } }
    const issues = builderIssues(definition)
    expect(issues.map((issue) => issue.path.join("."))).toEqual(["identity.customer_name"])
    expect(issues[0]!.target).toEqual({ tab: "document" })
  })

  test("a section that reports metrics but chose none goes to that section", () => {
    const base = draft()
    const section = { ...base.sections[0]!, metrics: [] }
    const issues = builderIssues({ ...base, sections: [section] })
    expect(issues.map((issue) => issue.path.join("."))).toEqual(["sections.0.metrics"])
    expect(issues[0]!.target).toEqual({ selection: { kind: "section", sectionId: section.id } })
  })

  test("a block fault goes to that block", () => {
    const base = draft()
    const section = {
      ...base.sections[0]!,
      blocks: [{ kind: "text" as const, id: "u_a", text: { en: "Top 5" } }],
    }
    const issues = builderIssues({ ...base, sections: [section] })
    expect(issues[0]!.target).toEqual({
      selection: { kind: "block", sectionId: section.id, ref: { kind: "text", id: "u_a" } },
    })
  })

  test("a preset with no sections cannot be published", () => {
    expect(builderIssues({ ...draft(), sections: [] }).map((issue) => issue.message)).toContain(
      "Add at least one section."
    )
  })
})
