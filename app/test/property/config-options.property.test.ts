import fc from "fast-check"
import { describe, expect, test } from "vitest"

import {
  BLOCK_CONFIG,
  BLOCK_TYPES,
  type BlockType,
} from "@/lib/templates/blocks"
import type {
  MetricCatalogSnapshot,
  MetricSelectionItem,
  ScopeSpec,
} from "@/lib/templates/definition"
import {
  COLUMN_ATTRIBUTES,
  fieldKind,
  metricOptionKey,
  optionsFor,
  resolvedResourceTypes,
  undeclaredReferences,
  type FactDeclarationSnapshot,
  type OptionGroups,
} from "@/lib/templates/options"

/**
 * **Property 8: Block-config options are drawn from the selection and the declaration.**
 * Identifier `config_option_sources`.
 *
 * **Validates: Requirements 11.9, 12.2, 12.4, 12.9, 12.10, 45.1, 45.3, 45.4**
 *
 * *For any* definition of 1–7 resource types and 1–40 metric-selection entries, and any block
 * whose `scope_override` narrows, widens or disjoins from the template default: every metric
 * option offered is one the definition **selected** for a type the block's resolved scope can
 * contain; the column options partition into exactly three groups with no member in two; and
 * `undeclaredReferences` reports every stored reference outside the options, none inside them,
 * and writes nothing.
 *
 * ## Why the catalog is generated to disagree with the selection
 *
 * The catalog always carries entries the definition does **not** select, and the fact
 * declaration always carries keys for types the block's scope cannot contain. Both are
 * deliberate: a resolver reading the catalog instead of the selection would pass every
 * assertion against a catalog that happened to equal it. The generated disagreement is the
 * whole discriminating power of the property, and it is why the three killed implementations
 * are killed:
 *
 * - **drawing metric options from the catalog** offers a metric the run does not collect, so
 *   the block renders an empty cell — caught by every offered option being in the selection;
 * - **offering every declared fact key** offers a key for a resource type this block cannot
 *   contain, so the column is empty for every row — caught by the scope assertion;
 * - **a load path that removes an undeclared reference** rather than reporting it silently
 *   edits a rule a consultant wrote — caught by the purity assertion, which compares the
 *   definition before and after and requires the issues rather than an edit.
 *
 * ## The scope cases are constructed, not filtered
 *
 * `narrow`, `widen` and `disjoin` are three generated relationships to the default rather than
 * a random override plus a precondition. A precondition would throw away most cases and the
 * interesting one — an override naming a type the definition selects **no** metrics for — is
 * the rarest of the three.
 */

// --- The vocabulary the generators draw from --------------------------------

const RESOURCE_TYPES = [
  "Microsoft.Compute/virtualMachines",
  "Microsoft.Storage/storageAccounts",
  "Microsoft.Compute/disks",
  "Microsoft.Web/sites",
  "Microsoft.Sql/servers/databases",
  "Microsoft.Sql/managedInstances",
  "Microsoft.DBforPostgreSQL/flexibleServers",
] as const

const METRIC_NAMES = [
  "Percentage CPU",
  "Available Memory Bytes",
  "Disk Read Bytes",
  "Network In Total",
  "Used capacity",
] as const

const STATISTICS = ["avg", "min", "max", "p95"] as const

/** Fact keys the declaration may carry. Lower-cased, like the agent's own key pattern. */
const FACT_KEYS = [
  "os_type",
  "vm_size",
  "provisioning_state",
  "data_disk_count",
  "last_backup_status",
] as const

/** Every block type that declares at least one reference-valued field. */
const REFERENCE_BLOCK_TYPES = BLOCK_TYPES.filter((type) =>
  [...BLOCK_CONFIG[type].required, ...BLOCK_CONFIG[type].optional].some(
    (field) => {
      const kind = fieldKind(type, field)
      return (
        kind === "metric_ref" ||
        kind === "metric_ref_list" ||
        kind === "column_list"
      )
    }
  )
)

/** How a block's `scope_override` stands to the template default. */
type ScopeRelation = "narrow" | "widen" | "disjoin"

/**
 * The three relationships, retained as declared cases.
 *
 * Declared as a mutable tuple array and handed to `examples:` **directly**, because the
 * hygiene guard resolves a case count off the AST: an identifier naming a module-scope array
 * literal is readable, and `SCOPE_RELATION_EXAMPLES.map(…)` is not — it would fail rule 3 as
 * "declares examples the guard cannot read" rather than being counted.
 *
 * Each carries the smallest selection that makes its relation meaningful: `narrow` needs two
 * selected types so a strict subset exists, and `disjoin` needs at least one type left over
 * for the override to name.
 */
const SCOPE_RELATION_EXAMPLES: [
  Record<string, readonly MetricSelectionItem[]>,
  ScopeRelation,
][] = [
  [
    {
      "Microsoft.Compute/virtualMachines": [
        { metric: "Percentage CPU", statistic: "avg" },
      ],
      "Microsoft.Storage/storageAccounts": [
        { metric: "Used capacity", statistic: "max" },
      ],
    },
    "narrow",
  ],
  [
    {
      "Microsoft.Compute/virtualMachines": [
        { metric: "Percentage CPU", statistic: "avg" },
      ],
    },
    "widen",
  ],
  [
    {
      "Microsoft.Compute/virtualMachines": [
        { metric: "Percentage CPU", statistic: "avg" },
      ],
    },
    "disjoin",
  ],
]

// --- Generators -------------------------------------------------------------

function emptyScope(resourceTypes: readonly string[]): ScopeSpec {
  return {
    resource_types: [...resourceTypes],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  }
}

const selectionItem = (): fc.Arbitrary<MetricSelectionItem> =>
  fc
    .tuple(fc.constantFrom(...METRIC_NAMES), fc.constantFrom(...STATISTICS))
    .map(([metric, statistic]) =>
      statistic === "p95"
        ? {
            metric,
            statistic,
            estimator: "histogram_sketch_pt1h_interval_average",
            fidelity_tier: "baseline",
          }
        : { metric, statistic }
    )

/**
 * A metric selection over 1–7 resource types, each with 1–40 entries.
 *
 * De-duplicated per type on `<metric>:<statistic>`, because two identical entries would make
 * "every offered option is selected" hold while the option count silently doubled — and a
 * picker showing one metric twice is a defect this property should be able to see.
 */
const metricSelection = (): fc.Arbitrary<
  Readonly<Record<string, readonly MetricSelectionItem[]>>
> =>
  fc
    .uniqueArray(fc.constantFrom(...RESOURCE_TYPES), {
      minLength: 1,
      maxLength: 7,
    })
    .chain((types) =>
      fc
        .tuple(
          ...types.map(() =>
            fc.array(selectionItem(), { minLength: 1, maxLength: 40 })
          )
        )
        .map((perType) => {
          const selection: Record<string, readonly MetricSelectionItem[]> = {}
          types.forEach((type, index) => {
            const seen = new Set<string>()
            selection[type] = (perType[index] ?? []).filter((item) => {
              const key = metricOptionKey(item)
              if (seen.has(key)) return false
              seen.add(key)
              return true
            })
          })
          return selection
        })
    )

/**
 * A catalog that always declares **more** than the selection.
 *
 * Every resource type, every metric, every statistic — so a resolver reading the catalog
 * rather than the selection offers strictly more options than it should, which is exactly the
 * first killed implementation.
 */
function catalogDeclaringEverything(): MetricCatalogSnapshot {
  return RESOURCE_TYPES.map((resourceType) => ({
    resourceType,
    declaredSkuCapabilities: ["vCPUsAvailable", "MemoryGB"],
    entries: METRIC_NAMES.map((name) => ({
      kind: "metric" as const,
      name,
      statistics: [...STATISTICS],
      percentiles: {
        p95: {
          estimator: "histogram_sketch_pt1h_interval_average",
          fidelityTier: "baseline",
        },
      },
      unit: "percent",
      scale: 2,
    })),
  }))
}

/** A declaration covering **every** resource type, including ones no block can contain. */
function declarationForEveryType(): FactDeclarationSnapshot {
  return RESOURCE_TYPES.flatMap((resourceType) =>
    FACT_KEYS.map((key) => ({
      resourceType,
      key,
      valueKind: "text" as const,
      source: "resource_graph",
    }))
  )
}

const CATALOG = catalogDeclaringEverything()
const DECLARATION = declarationForEveryType()

/**
 * A `scope_override` standing in one of three relationships to the default.
 *
 * `narrow` keeps a strict subset of the selected types (or all of them where only one is
 * selected); `widen` empties the dimension, which is the "no narrowing" spelling
 * `scope-union.ts` and `compile/scope.py` both use; `disjoin` names only types the selection
 * carries no metrics for.
 */
function overrideFor(
  relation: ScopeRelation,
  selected: readonly string[]
): ScopeSpec {
  if (relation === "widen") return emptyScope([])
  if (relation === "narrow") {
    return emptyScope(selected.slice(0, Math.max(1, selected.length - 1)))
  }
  const unselected = RESOURCE_TYPES.filter((type) => !selected.includes(type))
  return emptyScope(unselected.length > 0 ? unselected : [])
}

type Case = {
  readonly definition: {
    readonly scope: ScopeSpec
    readonly metrics: Readonly<Record<string, readonly MetricSelectionItem[]>>
    readonly blocks: readonly {
      readonly id: string
      readonly type: Exclude<BlockType, "row">
      readonly config: Readonly<Record<string, unknown>>
      readonly scope_override?: ScopeSpec
    }[]
  }
  readonly blockType: Exclude<BlockType, "row">
  readonly relation: ScopeRelation
}

/**
 * One case, built from its four independent choices.
 *
 * Extracted from the generator so a declared `(selection, relation)` pair can build the same
 * shape the generator builds. A second construction for the declared cases would let the two
 * drift, and the declared cases are the ones a reader trusts.
 */
function caseFrom(
  metrics: Readonly<Record<string, readonly MetricSelectionItem[]>>,
  blockType: Exclude<BlockType, "row">,
  relation: ScopeRelation,
  withOverride: boolean
): Case {
  const selected = Object.keys(metrics)
  const block = {
    id: "blk-0001",
    type: blockType,
    config: {} as Readonly<Record<string, unknown>>,
    ...(withOverride
      ? { scope_override: overrideFor(relation, selected) }
      : {}),
  }
  return {
    definition: { scope: emptyScope(selected), metrics, blocks: [block] },
    blockType,
    relation,
  }
}

const oneCase = (): fc.Arbitrary<Case> =>
  fc
    .tuple(
      metricSelection(),
      fc.constantFrom(...REFERENCE_BLOCK_TYPES),
      fc.constantFrom<ScopeRelation>("narrow", "widen", "disjoin"),
      fc.boolean()
    )
    .map(([metrics, blockType, relation, withOverride]) =>
      caseFrom(
        metrics,
        blockType as Exclude<BlockType, "row">,
        relation,
        withOverride
      )
    )

function groupsFor(subject: Case, field: string): OptionGroups {
  return optionsFor(field, {
    definition: subject.definition,
    block: subject.definition.blocks[0]!,
    catalog: CATALOG,
    factDeclaration: DECLARATION,
  })
}

/** Every reference-valued field the generated block type declares. */
function referenceFields(blockType: BlockType): readonly string[] {
  return [
    ...BLOCK_CONFIG[blockType].required,
    ...BLOCK_CONFIG[blockType].optional,
  ].filter((field) => {
    const kind = fieldKind(blockType, field)
    return (
      kind === "metric_ref" ||
      kind === "metric_ref_list" ||
      kind === "column_list"
    )
  })
}

// --- The properties ---------------------------------------------------------

describe("Requirement 12.2 — metric options come from the selection, not the catalog", () => {
  test("every offered metric option is one the definition selected", () => {
    fc.assert(
      fc.property(oneCase(), (subject) => {
        const selectedKeys = new Set(
          Object.values(subject.definition.metrics).flatMap((items) =>
            items.map(metricOptionKey)
          )
        )

        for (const field of referenceFields(subject.blockType)) {
          for (const option of groupsFor(subject, field).metrics) {
            // The catalog declares strictly more than the selection, so an implementation
            // reading it offers keys this set does not hold. That is the first killed
            // implementation, and this is the assertion that kills it.
            expect(selectedKeys.has(option.key)).toBe(true)
          }
        }
      }),
      { numRuns: 100 }
    )
  })

  test("no option names a resource type the block's resolved scope cannot contain", () => {
    // The relation is a separate argument rather than a choice inside `oneCase`, so the three
    // relationships can be *declared* cases: the interesting one — an override naming only
    // types the selection carries no metrics for — is the rarest of the three, and a random
    // override reaches it by luck.
    fc.assert(
      fc.property(
        metricSelection(),
        fc.constantFrom<ScopeRelation>("narrow", "widen", "disjoin"),
        (metrics, relation) => {
          const subject = caseFrom(metrics, "resource_table", relation, true)
          const inScope = new Set(
            resolvedResourceTypes(
              subject.definition,
              subject.definition.blocks[0]!
            )
          )

          for (const field of referenceFields(subject.blockType)) {
            const groups = groupsFor(subject, field)
            for (const option of groups.metrics) {
              expect(inScope.has(option.resourceType)).toBe(true)
            }
            // The declaration covers every resource type, so an implementation offering all of
            // its keys regardless of scope offers a column that is empty for every row. That
            // is the second killed implementation.
            for (const option of groups.facts) {
              expect(inScope.has(option.resourceType)).toBe(true)
            }
          }
        }
      ),
      {
        numRuns: 100 + SCOPE_RELATION_EXAMPLES.length,
        examples: SCOPE_RELATION_EXAMPLES,
      }
    )
  })

  test("a disjoint override offers no metric and no fact", () => {
    // The case a random override reaches rarely and a precondition would discard: the block's
    // scope names only types the selection carries nothing for, so both groups are empty while
    // the catalog and the declaration are both full.
    fc.assert(
      fc.property(metricSelection(), (metrics) => {
        const selected = Object.keys(metrics)
        const unselected = RESOURCE_TYPES.filter(
          (type) => !selected.includes(type)
        )
        fc.pre(unselected.length > 0)

        const groups = optionsFor("columns", {
          definition: { scope: emptyScope(selected), metrics },
          block: {
            type: "resource_table",
            scope_override: emptyScope(unselected),
          },
          catalog: CATALOG,
          factDeclaration: DECLARATION,
        })

        expect(groups.metrics).toEqual([])
        expect(groups.facts).toEqual([])
        // The attributes are unconditional: they are properties of a resource row rather than
        // of a selection, so a block that can contain nothing still offers them.
        expect(groups.attributes.length).toBe(COLUMN_ATTRIBUTES.length)
      }),
      { numRuns: 100 }
    )
  })

  test("an empty override widens to every selected type rather than to none", () => {
    fc.assert(
      fc.property(metricSelection(), (metrics) => {
        const selected = Object.keys(metrics)

        const resolved = resolvedResourceTypes(
          { scope: emptyScope(selected.slice(0, 1)), metrics },
          { scope_override: emptyScope([]) }
        )

        // Emptiness means "no narrowing", so it resolves to everything the definition selects —
        // not to nothing. The opposite reading hides every option from the common case.
        expect([...resolved].sort()).toEqual([...selected].sort())
      }),
      { numRuns: 100 }
    )
  })
})

describe("Requirement 12.4 — the column options partition into three groups", () => {
  test("no member of one group appears in another", () => {
    fc.assert(
      fc.property(oneCase(), (subject) => {
        const groups = groupsFor(subject, "columns")

        const metricKeys = new Set<string>(
          groups.metrics.map((option) => option.key)
        )
        const attributeKeys = new Set<string>(
          groups.attributes.map((option) => option.key)
        )
        const factKeys = new Set<string>(
          groups.facts.map((option) => option.key)
        )

        for (const key of metricKeys) {
          expect(attributeKeys.has(key)).toBe(false)
          expect(factKeys.has(key)).toBe(false)
        }
        for (const key of attributeKeys) expect(factKeys.has(key)).toBe(false)
      }),
      { numRuns: 100 }
    )
  })

  test("a metric-valued field offers the metrics alone", () => {
    fc.assert(
      fc.property(oneCase(), (subject) => {
        for (const field of referenceFields(subject.blockType)) {
          const kind = fieldKind(subject.blockType, field)
          if (kind === "column_list") continue

          const groups = groupsFor(subject, field)
          // A chart plots a series over time and an attribute is a constant string, so the
          // two other groups are empty rather than filtered by the caller.
          expect(groups.attributes).toEqual([])
          expect(groups.facts).toEqual([])
        }
      }),
      { numRuns: 100 }
    )
  })

  test("an enum or plain field offers nothing at all", () => {
    fc.assert(
      fc.property(oneCase(), (subject) => {
        const groups = groupsFor(subject, "caption")

        expect(groups).toEqual({ metrics: [], attributes: [], facts: [] })
      }),
      { numRuns: 100 }
    )
  })
})

describe("Requirements 12.9, 12.10 — undeclared references are reported, never removed", () => {
  test("a reference inside the options produces no issue", () => {
    // Constructed rather than filtered: a `columns` field exists only on the two table blocks,
    // and a disjoint override offers no metric to reference — so a precondition over
    // `oneCase()` would throw away roughly three quarters of its input and assert over the
    // remainder. `narrow` and `widen` both keep at least one selected type, so the option this
    // reads is guaranteed to exist and is asserted rather than assumed.
    fc.assert(
      fc.property(
        metricSelection(),
        fc.constantFrom<ScopeRelation>("narrow", "widen"),
        fc.constantFrom<Exclude<BlockType, "row">>(
          "resource_table",
          "top_n_table"
        ),
        (metrics, relation, blockType) => {
          const subject = caseFrom(metrics, blockType, relation, true)
          const groups = groupsFor(subject, "columns")
          expect(groups.metrics.length).toBeGreaterThan(0)
          const option = groups.metrics[0]!

          const definition = {
            ...subject.definition,
            blocks: [
              {
                ...subject.definition.blocks[0]!,
                config: {
                  columns: [
                    {
                      ...(option.metric === undefined
                        ? { derived: option.derived }
                        : { metric: option.metric }),
                      statistic: option.statistic,
                    },
                  ],
                },
              },
            ],
          }

          expect(
            undeclaredReferences(definition, CATALOG, DECLARATION)
          ).toEqual([])
        }
      ),
      { numRuns: 100 }
    )
  })

  test("a reference outside the options produces exactly one issue naming it", () => {
    fc.assert(
      fc.property(
        oneCase(),
        fc.constantFrom(...METRIC_NAMES),
        (subject, name) => {
          const definition = {
            ...subject.definition,
            blocks: [
              {
                ...subject.definition.blocks[0]!,
                type: "resource_table" as const,
                config: {
                  // A statistic no selection carries, so the reference resolves to no option
                  // whatever the definition selected.
                  columns: [{ metric: name, statistic: "p999" }],
                },
              },
            ],
          }

          const issues = undeclaredReferences(definition, CATALOG, DECLARATION)

          expect(issues.length).toBe(1)
          expect(issues[0]!.reason).toBe("metric_not_selected")
          expect(issues[0]!.reference).toBe(`${name}:p999`)
          expect(issues[0]!.path).toEqual(["blocks", 0, "config", "columns", 0])
        }
      ),
      { numRuns: 100 }
    )
  })

  test("an unknown attribute and an undeclared fact key report different reasons", () => {
    // The two are not interchangeable and each points somewhere different: an undeclared fact
    // key is a resource type the declaration says nothing about, an unknown attribute is a name
    // no renderer can emit.
    fc.assert(
      fc.property(oneCase(), (subject) => {
        const definition = {
          ...subject.definition,
          blocks: [
            {
              ...subject.definition.blocks[0]!,
              type: "resource_table" as const,
              config: { columns: ["undeclared_fact_key", "Not An Attribute"] },
            },
          ],
        }

        const issues = undeclaredReferences(definition, CATALOG, DECLARATION)

        expect(issues.map((issue) => issue.reason)).toEqual([
          "fact_key_undeclared",
          "attribute_unknown",
        ])
      }),
      { numRuns: 100 }
    )
  })

  test("the function is pure: two calls agree and the definition is unchanged", () => {
    fc.assert(
      fc.property(oneCase(), (subject) => {
        const definition = {
          ...subject.definition,
          blocks: [
            {
              ...subject.definition.blocks[0]!,
              type: "resource_table" as const,
              config: { columns: ["Not An Attribute", "resource_group"] },
            },
          ],
        }
        const before = JSON.stringify(definition)

        const first = undeclaredReferences(definition, CATALOG, DECLARATION)
        const second = undeclaredReferences(definition, CATALOG, DECLARATION)

        expect(first).toEqual(second)
        // The third killed implementation: a load path that pruned the reference it could not
        // resolve would silently edit a rule a consultant wrote, and the edit would be
        // invisible because it deleted the evidence.
        expect(JSON.stringify(definition)).toBe(before)
        expect(first.length).toBe(1)
      }),
      { numRuns: 100 }
    )
  })

  test("a reference inside a row's column is reached and pathed correctly", () => {
    fc.assert(
      fc.property(oneCase(), (subject) => {
        const definition = {
          ...subject.definition,
          blocks: [
            {
              id: "r",
              type: "row" as const,
              columns: [
                [
                  {
                    id: "nested",
                    type: "resource_table" as const,
                    config: { columns: ["Not An Attribute"] },
                  },
                ],
              ],
            },
          ],
        }

        const issues = undeclaredReferences(
          definition as never,
          CATALOG,
          DECLARATION
        )

        expect(issues.length).toBe(1)
        expect(issues[0]!.blockId).toBe("nested")
        expect(issues[0]!.path).toEqual([
          "blocks",
          0,
          "columns",
          0,
          0,
          "config",
          "columns",
          0,
        ])
      }),
      { numRuns: 100 }
    )
  })
})
