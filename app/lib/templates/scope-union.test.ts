import { describe, expect, test } from "vitest"

import type {
  LeafBlock,
  ScopeSpec,
  TemplateBlock,
  TemplateDefinition,
} from "@/lib/templates/definition"
import { declaredScopes, unionScope } from "@/lib/templates/scope-union"

/**
 * The union scope (Requirement 3.3).
 *
 * The rule under test is one sentence — **an empty dimension wins** — and every
 * case below is a way of getting it wrong. The direction matters more than the
 * rule: over-collecting costs minutes, and under-collecting fails the coverage
 * gate on a run that was entirely correct, so every ambiguous case here widens.
 *
 * The mirror of these rules lives in
 * `agent/src/reporting_agent/compile/scope.py#union_scope`, between the same
 * sentinel comments.
 */

const VM = "Microsoft.Compute/virtualMachines"
const STORAGE = "Microsoft.Storage/storageAccounts"

function scope(overrides: Partial<ScopeSpec> = {}): ScopeSpec {
  return {
    resource_types: [],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
    ...overrides,
  }
}

function definition(
  templateScope: ScopeSpec,
  blocks: readonly TemplateBlock[] = []
): Pick<TemplateDefinition, "scope" | "blocks"> {
  return { scope: templateScope, blocks }
}

function leaf(id: string, scopeOverride?: ScopeSpec): LeafBlock {
  return {
    id,
    type: "kpi_row",
    config: {},
    ...(scopeOverride === undefined ? {} : { scope_override: scopeOverride }),
  }
}

describe("resource types and resource groups — an empty dimension wins", () => {
  test("a definition with no overrides is its own default", () => {
    expect(unionScope(definition(scope({ resource_types: [VM] })))).toEqual({
      resource_types: [VM],
      resource_groups: [],
      tag_filters: {},
    })
  })

  test("two populated dimensions union and sort", () => {
    const union = unionScope(
      definition(scope({ resource_types: [STORAGE] }), [
        leaf("b1", scope({ resource_types: [VM] })),
      ])
    )

    expect(union.resource_types).toEqual([VM, STORAGE].sort())
  })

  test("one unconstrained scope makes the union unconstrained", () => {
    // The template default names a type; a block override names none, so that
    // block matches every type. Intersecting — or taking only the default —
    // would leave the block's resources out of the snapshot, and the coverage
    // gate would then fail a run that was entirely correct.
    const union = unionScope(
      definition(scope({ resource_types: [VM] }), [
        leaf("b1", scope({ resource_types: [] })),
      ])
    )

    expect(union.resource_types).toEqual([])
  })

  test("resource groups widen by the same rule", () => {
    expect(
      unionScope(
        definition(scope({ resource_groups: ["rg-a"] }), [
          leaf("b1", scope({ resource_groups: ["rg-b"] })),
        ])
      ).resource_groups
    ).toEqual(["rg-a", "rg-b"])

    expect(
      unionScope(
        definition(scope({ resource_groups: ["rg-a"] }), [
          leaf("b1", scope({ resource_groups: [] })),
        ])
      ).resource_groups
    ).toEqual([])
  })

  test("duplicates across scopes collapse to one entry", () => {
    expect(
      unionScope(
        definition(scope({ resource_types: [VM] }), [
          leaf("b1", scope({ resource_types: [VM] })),
        ])
      ).resource_types
    ).toEqual([VM])
  })
})

describe("tag filters — an all-of map that must accept every any-of match", () => {
  test("one pair required identically by every scope survives", () => {
    const filters = [{ key: "env", value: "prod" }]

    expect(
      unionScope(
        definition(scope({ tag_filters: filters }), [
          leaf("b1", scope({ tag_filters: filters })),
        ])
      ).tag_filters
    ).toEqual({ env: "prod" })
  })

  test("different keys produce no filter", () => {
    // `{env: prod, tier: web}` demands *both*, so it would miss a resource
    // carrying only `env=prod` — which the first scope matches. Pushing down no
    // filter over-collects, which is the safe direction.
    expect(
      unionScope(
        definition(scope({ tag_filters: [{ key: "env", value: "prod" }] }), [
          leaf("b1", scope({ tag_filters: [{ key: "tier", value: "web" }] })),
        ])
      ).tag_filters
    ).toEqual({})
  })

  test("different values for one key produce no filter", () => {
    expect(
      unionScope(
        definition(scope({ tag_filters: [{ key: "env", value: "prod" }] }), [
          leaf(
            "b1",
            scope({ tag_filters: [{ key: "env", value: "staging" }] })
          ),
        ])
      ).tag_filters
    ).toEqual({})
  })

  test("more than one filter in a scope produces no filter", () => {
    // Two any-of filters cannot be expressed as one all-of pair.
    const two = [
      { key: "env", value: "prod" },
      { key: "tier", value: "web" },
    ]

    expect(
      unionScope(
        definition(scope({ tag_filters: two }), [
          leaf("b1", scope({ tag_filters: two })),
        ])
      ).tag_filters
    ).toEqual({})
  })

  test("one scope with no tag filter makes the union unfiltered", () => {
    expect(
      unionScope(
        definition(scope({ tag_filters: [{ key: "env", value: "prod" }] }), [
          leaf("b1", scope({ tag_filters: [] })),
        ])
      ).tag_filters
    ).toEqual({})
  })

  test("keys fold case; values do not (Requirement 3.12)", () => {
    // `{env: prod}` and `{ENV: prod}` are the same requirement written twice,
    // and treating them as two keys would demand a tag equal to two different
    // strings at once. The emitted spelling is the first in sorted order —
    // arbitrary but deterministic, and harmless because keys fold anyway.
    const union = unionScope(
      definition(scope({ tag_filters: [{ key: "ENV", value: "prod" }] }), [
        leaf("b1", scope({ tag_filters: [{ key: "env", value: "prod" }] })),
      ])
    )

    expect(Object.keys(union.tag_filters)).toHaveLength(1)
    expect(Object.values(union.tag_filters)).toEqual(["prod"])

    // The *value* honours case, so these are two different requirements.
    expect(
      unionScope(
        definition(scope({ tag_filters: [{ key: "env", value: "Prod" }] }), [
          leaf("b1", scope({ tag_filters: [{ key: "env", value: "prod" }] })),
        ])
      ).tag_filters
    ).toEqual({})
  })
})

describe("the walk reaches every override", () => {
  test("a block inside a row column contributes its override", () => {
    // The failure this catches is silent: a row's columns hold the blocks that
    // carry overrides, and a walk that stopped at the row would drop every one
    // of them — so a two-column layout would collect less than the same two
    // blocks laid out flat.
    const row: TemplateBlock = {
      id: "row-1",
      type: "row",
      columns: [
        [leaf("b1", scope({ resource_types: [STORAGE] }))],
        [leaf("b2", scope({ resource_types: [VM] }))],
      ],
    }

    expect(
      unionScope(definition(scope({ resource_types: [VM] }), [row]))
        .resource_types
    ).toEqual([VM, STORAGE].sort())
  })

  test("a block with no override contributes nothing", () => {
    // It inherits the template default (Requirement 3.5), which is already in
    // the union — contributing an *empty* scope for it would make the union
    // unconstrained and collect the whole subscription.
    expect(
      unionScope(
        definition(scope({ resource_types: [VM] }), [leaf("b1"), leaf("b2")])
      ).resource_types
    ).toEqual([VM])
  })

  test("declaredScopes lists the default first, then each override", () => {
    const override = scope({ resource_types: [STORAGE] })

    expect(
      declaredScopes(
        definition(scope({ resource_types: [VM] }), [leaf("b1", override)])
      )
    ).toEqual([scope({ resource_types: [VM] }), override])
  })
})

describe("top_n and sort are absent from the result", () => {
  test("a ranking narrows no dimension of the union", () => {
    // Requirement 3.3 — the union ignores every top-N count and sort direction,
    // "so that one snapshot carries every resource any block needs including the
    // candidates a top-N ordering discards". A snapshot narrowed to one block's
    // top 10 could not resolve a different block's top 20.
    const union = unionScope(
      definition(
        scope({
          resource_types: [VM],
          top_n: { count: 10, metric: "Percentage CPU", statistic: "avg" },
          sort: "descending",
        })
      )
    )

    expect(union).toEqual({
      resource_types: [VM],
      resource_groups: [],
      tag_filters: {},
    })
    expect("top_n" in union).toBe(false)
    expect("sort" in union).toBe(false)
  })
})
