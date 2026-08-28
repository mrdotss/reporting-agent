import { describe, expect, test } from "vitest"

import { declaredScopes, unionScope } from "./scope-union"

/**
 * `declaredScopes` / `unionScope` at schema_version 3.
 *
 * They read `definition.blocks` unconditionally. A v3 definition has no
 * top-level `scope` and no `blocks` at all — each section carries its own
 * `selection` — so every v3 enqueue threw
 * `TypeError: e.blocks is not iterable`, surfaced as a bare 500 on the Reports
 * page, and made a saved v3 profile impossible to run.
 *
 * ## The agreement with the agent is the point
 *
 * The result of `unionScope` is written to `report_runs.scope`, and that column
 * is what the collector actually collects. `_requested_metric_union_v3` in
 * `agent/src/reporting_agent/report_pipeline.py` appends
 * `scope_rules_from_plain(selection)` for EVERY section — including sections with
 * no `selection`, which yield empty (unconstrained) rules. These tests pin that
 * behaviour, because a union narrower than the agent's would collect data the
 * agent cannot then find, and a wider one would collect a whole subscription
 * nobody asked for.
 */

const VM = "Microsoft.Compute/virtualMachines"
const STORAGE = "Microsoft.Storage/storageAccounts"

function v3(sections: readonly Record<string, unknown>[]) {
  return { schema_version: 3, provider: "azure", sections }
}

describe("v3 definitions no longer throw", () => {
  test("a v3 definition with no blocks key does not throw", () => {
    // The regression, stated directly.
    expect(() =>
      unionScope(v3([{ id: "s1", type: "azure_subscription" }]))
    ).not.toThrow()
  })

  test("declaredScopes reads one scope per section, not a top-level default", () => {
    const scopes = declaredScopes(
      v3([
        { id: "s1", type: "a" },
        { id: "s2", type: "b" },
      ])
    )
    // Two sections, two scopes — no seeded template default, because v3 has none.
    expect(scopes).toHaveLength(2)
  })
})

describe("a section's selection narrows the union", () => {
  test("selections union across sections", () => {
    const result = unionScope(
      v3([
        {
          id: "s1",
          type: "vm_utilization",
          selection: {
            resource_types: [VM],
            resource_groups: ["rg-a"],
            tag_filters: [],
          },
        },
        {
          id: "s2",
          type: "storage",
          selection: {
            resource_types: [STORAGE],
            resource_groups: ["rg-b"],
            tag_filters: [],
          },
        },
      ])
    )

    expect(result.resource_types).toStrictEqual([VM, STORAGE].sort())
    expect(result.resource_groups).toStrictEqual(["rg-a", "rg-b"])
  })

  test("a section with NO selection makes the dimension unconstrained", () => {
    // The behaviour that mirrors the agent, and the one most worth pinning: an
    // absent selection is unconstrained, so it widens the union to everything
    // rather than being skipped and letting the narrow sections decide.
    const result = unionScope(
      v3([
        {
          id: "s1",
          type: "vm_utilization",
          selection: {
            resource_types: [VM],
            resource_groups: [],
            tag_filters: [],
          },
        },
        { id: "s2", type: "azure_subscription" },
      ])
    )

    expect(result.resource_types).toStrictEqual([])
  })

  test("every section narrowing to the same type keeps the union at that type", () => {
    const result = unionScope(
      v3([
        {
          id: "s1",
          type: "vm_utilization",
          selection: {
            resource_types: [VM],
            resource_groups: [],
            tag_filters: [],
          },
        },
        {
          id: "s2",
          type: "vm_inventory",
          selection: {
            resource_types: [VM],
            resource_groups: [],
            tag_filters: [],
          },
        },
      ])
    )

    expect(result.resource_types).toStrictEqual([VM])
  })

  test("a malformed selection is unconstrained rather than a throw", () => {
    expect(() =>
      unionScope(
        v3([
          { id: "s1", type: "a", selection: "nope" },
          { id: "s2", type: "b", selection: { resource_types: "nope" } },
        ])
      )
    ).not.toThrow()

    expect(
      unionScope(v3([{ id: "s1", type: "a", selection: null }])).resource_types
    ).toStrictEqual([])
  })

  test("non-string entries in a selection are dropped, not passed through", () => {
    const result = unionScope(
      v3([
        {
          id: "s1",
          type: "a",
          selection: {
            resource_types: [VM, 7, null],
            resource_groups: [],
            tag_filters: [],
          },
        },
      ])
    )
    expect(result.resource_types).toStrictEqual([VM])
  })
})

describe("v1/v2 definitions are unaffected", () => {
  test("the top-level default plus a block override still union", () => {
    const legacy = {
      schema_version: 2,
      scope: {
        resource_types: [VM],
        resource_groups: ["rg-a"],
        tag_filters: [],
        top_n: null,
        sort: null,
      },
      blocks: [
        {
          id: "b1",
          type: "resource_table",
          config: {},
          scope_override: {
            resource_types: [STORAGE],
            resource_groups: ["rg-b"],
            tag_filters: [],
            top_n: null,
            sort: null,
          },
        },
      ],
    }

    const result = unionScope(legacy)
    expect(result.resource_types).toStrictEqual([VM, STORAGE].sort())
    expect(result.resource_groups).toStrictEqual(["rg-a", "rg-b"])
  })

  test("a v1/v2 definition with no blocks returns its default unchanged", () => {
    const legacy = {
      schema_version: 1,
      scope: {
        resource_types: [VM],
        resource_groups: [],
        tag_filters: [],
        top_n: null,
        sort: null,
      },
      blocks: [],
    }

    expect(unionScope(legacy).resource_types).toStrictEqual([VM])
  })
})
