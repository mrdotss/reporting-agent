import { describe, expect, test } from "vitest"

import {
  completionProblems,
  customerNameMissing,
  metricBearingSectionsWithoutMetrics,
} from "@/lib/profiles/wizard"
import { resolveCustomerName } from "@/lib/actions/runs"

/**
 * `identity.customer_name` — the wizard's completion gate, and the enqueue gate's
 * agreement with it.
 *
 * The field was added to step 1, but nothing told the consultant a RUN needs it:
 * `REQUIRED_IDENTITY_KEYS[3]` deliberately omits it so a half-authored draft can
 * be saved, so `collectDefinitionIssues` raised nothing, so step 5 said "Every
 * step passes" and published a version. Every run pinning that version was then
 * refused on the Reports page — a screen away from the field that fixes it, with
 * an immutable version already created that can never produce a report.
 *
 * This is the same split the `no_sections` check already uses: legal in a draft,
 * refused at publish.
 */

function v3(identity: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 3,
    provider: "azure",
    identity: { name: "Enesis", language: "en", ...identity },
    sections: [{ id: "s1", type: "azure_subscription" }],
    period: { kind: "last_full_month" },
    design: {
      preset: "editorial",
      density: "normal",
      table_style: "hairline",
      number_format: "id-ID",
      cover_page: true,
      page_size: "A4",
    },
    front_matter: { cover: {}, document_control: {}, toc: {} },
  }
}

describe("customerNameMissing", () => {
  test("a v3 definition with no customer_name is missing one", () => {
    const issue = customerNameMissing(v3({}))
    expect(issue).not.toBeNull()
    expect(issue!.path).toStrictEqual(["identity", "customer_name"])
  })

  test("a named customer satisfies it", () => {
    expect(
      customerNameMissing(v3({ customer_name: "Enesis Group" }))
    ).toBeNull()
  })

  test("an empty or whitespace-only name does NOT satisfy it", () => {
    // It would otherwise pass the enqueue gate's `typeof === "string"` test and
    // print an empty customer on the cover — a run that succeeds and delivers a
    // wrong document, which is worse than the refusal.
    expect(customerNameMissing(v3({ customer_name: "" }))).not.toBeNull()
    expect(customerNameMissing(v3({ customer_name: "   " }))).not.toBeNull()
    expect(customerNameMissing(v3({ customer_name: "\t\n" }))).not.toBeNull()
  })

  test("below v3 it is not this definition's concern", () => {
    // At v1/v2 the value is a per-run form field, so its absence from the profile
    // is correct rather than a defect.
    expect(
      customerNameMissing({ schema_version: 2, identity: { name: "Legacy" } })
    ).toBeNull()
    expect(
      customerNameMissing({ schema_version: 1, identity: { name: "Legacy" } })
    ).toBeNull()
  })

  test("does not throw on junk", () => {
    expect(customerNameMissing(undefined)).toBeNull()
    expect(customerNameMissing(null)).toBeNull()
    expect(customerNameMissing({ schema_version: 3 })).not.toBeNull()
    expect(
      customerNameMissing({ schema_version: 3, identity: null })
    ).not.toBeNull()
  })
})

describe("completionProblems refuses to publish a version that could never run", () => {
  test("a v3 profile with no customer name is refused, naming step 1", () => {
    const problems = completionProblems(v3({}))

    const identityProblem = problems.find(
      (p) => p.kind === "step" && p.step.id === "identity"
    )
    expect(identityProblem).toBeDefined()
    expect(
      identityProblem!.kind === "step" &&
        identityProblem!.issues.some(
          (i) => i.path.join(".") === "identity.customer_name"
        )
    ).toBe(true)
  })

  test("the same profile WITH a customer name has no identity problem", () => {
    const problems = completionProblems(v3({ customer_name: "Enesis Group" }))

    expect(
      problems.some((p) => p.kind === "step" && p.step.id === "identity")
    ).toBe(false)
  })

  test("a blank customer name is refused too", () => {
    const problems = completionProblems(v3({ customer_name: "  " }))
    expect(
      problems.some((p) => p.kind === "step" && p.step.id === "identity")
    ).toBe(true)
  })
})

describe("a metric-bearing section selecting no metric is refused at publish", () => {
  // The failure that cost seven diagnostic rounds. The validator accepts an empty
  // `metrics[]`, so step 5 said "Every step passes", the version published, and the
  // collector then requested nothing — reporting NO_STATISTICS with copy that points
  // at deallocated machines and non-emitting resource types, i.e. at the customer's
  // estate, for what was entirely a fact about the profile. Seeding on add cannot fix
  // a section that already exists, which is the case that kept reaching a run.
  const METRIC_BEARING = new Set([
    "vm_utilization",
    "historical_vm_utilization",
  ])

  function withSections(sections: readonly Record<string, unknown>[]) {
    return {
      ...v3({ customer_name: "Enesis Group" }),
      sections,
    }
  }

  test("an empty metrics array on a metric-bearing section is a sections problem", () => {
    const problems = completionProblems(
      withSections([{ id: "s1", type: "vm_utilization", metrics: [] }]),
      METRIC_BEARING
    )

    const sectionProblem = problems.find(
      (p) => p.kind === "step" && p.step.id === "sections"
    )
    expect(sectionProblem).toBeDefined()
    expect(
      sectionProblem!.kind === "step" &&
        sectionProblem!.issues.some(
          (i) => i.path.join(".") === "sections.0.metrics"
        )
    ).toBe(true)
  })

  test("an absent metrics key is refused the same way", () => {
    expect(
      metricBearingSectionsWithoutMetrics(
        withSections([{ id: "s1", type: "vm_utilization" }]),
        METRIC_BEARING
      )
    ).toHaveLength(1)
  })

  test("a populated selection passes", () => {
    expect(
      metricBearingSectionsWithoutMetrics(
        withSections([
          {
            id: "s1",
            type: "vm_utilization",
            metrics: [{ metric: "Percentage CPU", statistic: "avg" }],
          },
        ]),
        METRIC_BEARING
      )
    ).toStrictEqual([])
  })

  test("a NON-metric-bearing section with no metrics is fine", () => {
    // `azure_subscription` is inventory; requiring metrics there would refuse every
    // profile that carries it, which is all of them.
    expect(
      metricBearingSectionsWithoutMetrics(
        withSections([{ id: "s1", type: "azure_subscription", metrics: [] }]),
        METRIC_BEARING
      )
    ).toStrictEqual([])
  })

  test("each offending section is named by its own index", () => {
    const issues = metricBearingSectionsWithoutMetrics(
      withSections([
        { id: "s0", type: "azure_subscription" },
        { id: "s1", type: "vm_utilization", metrics: [] },
        { id: "s2", type: "historical_vm_utilization", metrics: [] },
      ]),
      METRIC_BEARING
    )

    expect(issues.map((i) => i.path.join("."))).toStrictEqual([
      "sections.1.metrics",
      "sections.2.metrics",
    ])
  })

  test("no catalogue supplied means the check is skipped, not guessed", () => {
    expect(
      metricBearingSectionsWithoutMetrics(
        withSections([{ id: "s1", type: "vm_utilization", metrics: [] }]),
        undefined
      )
    ).toStrictEqual([])
  })
})

describe("resolveCustomerName agrees with the wizard's rule", () => {
  test("a named customer resolves", () => {
    const result = resolveCustomerName(
      { schema_version: 3, identity: { customer_name: "Enesis Group" } },
      undefined
    )
    expect(result.customerName).toBe("Enesis Group")
    expect(result.missingCustomerNameField).toBeNull()
  })

  test("an absent customer_name is reported as missing", () => {
    const result = resolveCustomerName(
      { schema_version: 3, identity: {} },
      undefined
    )
    expect(result.customerName).toBeNull()
    expect(result.missingCustomerNameField).toBe("identity.customer_name")
  })

  test("a blank customer_name is ABSENT, not present-and-empty", () => {
    for (const blank of ["", "   ", "\t"]) {
      const result = resolveCustomerName(
        { schema_version: 3, identity: { customer_name: blank } },
        undefined
      )
      expect(result.customerName).toBeNull()
      expect(result.missingCustomerNameField).toBe("identity.customer_name")
    }
  })

  test("v2 still reads the submitted form field", () => {
    const result = resolveCustomerName(
      { schema_version: 2, identity: {} },
      "From The Form"
    )
    expect(result.customerName).toBe("From The Form")
    expect(result.missingCustomerNameField).toBeNull()
  })
})
