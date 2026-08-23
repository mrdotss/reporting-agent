import { BLOCK_CONFIG, type BlockType } from "@/lib/templates/blocks"
import {
  IMPLICIT_TABLE_COLUMNS,
  type LeafBlock,
  type MetricCatalogSnapshot,
  type MetricSelectionItem,
  type ScopeSpec,
  type TemplateDefinition,
} from "@/lib/templates/definition"

/**
 * What a block-config field may be set to — computed from the definition, never from a list
 * held in the app (Requirements 11.9, 12.2, 12.4, 12.9, 12.10).
 *
 * **Pure, and no I/O.** Every input arrives as an argument: the definition, the block, the
 * Metric_Catalog and the Fact_Declaration. Nothing here reads a file, a store, a clock or an
 * environment variable, which is what lets one function serve both the inspector (a client
 * component) and the load-time check (a server one).
 *
 * ## The two sources, and why they are not the same source
 *
 * A `metric_ref` field's options come from the **definition's own metric selection**, not from
 * the catalog. That is the whole point of the module:
 *
 * * The catalog declares what the *product* can collect. The selection declares what *this
 *   run* will collect. A block can display only a subset of what the run collects, so an
 *   option outside the selection guarantees a block carrying no figure at all — the metric was
 *   never requested, so no snapshot value exists for the compiler to resolve.
 * * Drawing from the catalog would therefore offer a consultant a choice that produces an
 *   empty cell, discoverable only in the delivered document. The catalog is still read, but
 *   only to *describe* a selected item — its statistics, its scale, whether a percentile is an
 *   estimate — which is presentation, not membership.
 *
 * A `column_list` field draws from **three distinctly presented groups**: those same metrics,
 * the resource attributes {@link COLUMN_ATTRIBUTES} declares, and the fact keys the
 * declaration declares for a resource type the block's resolved scope **can contain**. Three
 * groups rather than one flat list because they are three different things in the document — a
 * figure with provenance, a string the inventory carried, and a string an API answered — and a
 * picker that flattened them would let a consultant believe a fact key is a measurement.
 *
 * ## Scope resolution, and the one rule it follows
 *
 * A block's resolved scope is **its own override, or the template default** — the same
 * precedence `agent/.../compile/blocks/base.py::BlockContext.scope_for` applies, and the
 * reason `resolvedResourceTypes` exists rather than a second reading of it. An **empty**
 * `resource_types` is unconstrained, exactly as `lib/templates/scope-union.ts` treats it, so a
 * block that narrows nothing can contain every type the definition selects metrics for.
 *
 * ## `undeclaredReferences` returns issues and performs no write
 *
 * That is criterion 12.10's "no load path edits a definition on its own" **as a signature**
 * rather than as a discipline: the function takes no store, returns a value, and the value is
 * a list of problems. A load path that pruned a reference it could not resolve would silently
 * edit a rule a consultant wrote — and the edit would be invisible, because the thing it
 * removed is the thing that would have shown the mistake.
 */

// --- The mirrored attribute vocabulary --------------------------------------

// --- BEGIN COLUMN ATTRIBUTES (mirrored in agent/src/reporting_agent/compile/blocks/tables.py) ---
export const COLUMN_ATTRIBUTES = [
  "resource_name",
  "resource_group",
  "resource_type",
  "location",
  "sku_name",
  "power_state",
  "fidelity_tier",
] as const
// --- END COLUMN ATTRIBUTES ---

/**
 * The resource attributes a data table can emit as a column, and nothing else.
 *
 * Mirrored **by value** from `compile/blocks/tables.py`, where
 * `resource_attribute_text` is total over exactly this tuple, and compared by
 * `app/test/mirror.static.test.ts`. A name here that the compiler cannot emit is a column a
 * consultant selects, saves, and then finds missing from a delivered document; a name there
 * and not here is an emittable column the builder never offers.
 *
 * An attribute is a **string the inventory already carried**, so it emits as text and carries
 * no figure, no unit and no statistic. That is why it is a separate group from the metrics
 * rather than a member of one list.
 */
export type ColumnAttribute = (typeof COLUMN_ATTRIBUTES)[number]

/**
 * The two attributes `resource_table` and `top_n_table` already emit implicitly.
 *
 * `resource_name` is always the first column (`tables.py`'s `_RESOURCE_COLUMN`), and
 * `fidelity_tier` is emitted when `show_fidelity` is set (`_TIER_COLUMN`). Naming either as an
 * explicit column would make `(row_key, column_key)` address two cells — which is the pair the
 * verifier resolves an anchor by, so the second one would be unreachable.
 */
export const IMPLICIT_COLUMN_ATTRIBUTES =
  IMPLICIT_TABLE_COLUMNS satisfies readonly ColumnAttribute[]

// --- Field kinds ------------------------------------------------------------

/**
 * What kind of value a block-config field holds.
 *
 * `other` is the honest default rather than a gap: `caption`, `text`, `level`, `run_a` and
 * `show_fidelity` are not references to anything, and the inspector keeps its raw control for
 * exactly those. Requirement 12.6's "no free-text control at all" applies to the four
 * reference kinds; widening it to every field would leave no way to type a caption.
 */
export type ConfigFieldKind =
  "metric_ref" | "metric_ref_list" | "column_list" | "enum" | "other"

/**
 * The five metric-valued fields, by block type — the set Requirement 12.6 removes every
 * free-text control from.
 *
 * Declared as data rather than as a chain of conditions, and keyed by block type because the
 * same field name means different things on different blocks: `columns` is a column list on a
 * table and does not exist on a chart, while `metrics` is a metric list on a chart and does not
 * exist on a table.
 */
const FIELD_KINDS: Readonly<
  Partial<Record<BlockType, Readonly<Record<string, ConfigFieldKind>>>>
> = {
  kpi_row: { metrics: "metric_ref_list" },
  timeseries_chart: { metrics: "metric_ref_list" },
  distribution_chart: { metrics: "metric_ref_list" },
  resource_table: { columns: "column_list" },
  top_n_table: { columns: "column_list", order_by: "metric_ref" },
  // `capacity_metric` is a **SKU-capability** ref (`{sku_capability: "MemoryGB"}`), not a
  // metric ref, and the compiler reads it with a different reader (`read_capacity_ref`). It is
  // `other` here rather than `metric_ref`, because offering it the selection's metrics would
  // offer values the capacity reader refuses — its options come from the catalog's
  // `declaredSkuCapabilities`, which is task 12.6's control rather than this function's.
  capacity_vs_usage: { usage_metric: "metric_ref" },
}

/**
 * The kind of `field` on `blockType`.
 *
 * A field the block's schema does not declare at all is `other`, not an error: this is a
 * presentation question, and the validator is what refuses an undeclared config field. Two
 * answers for one wrong field would be two places to keep in step.
 *
 * An enum-declared field is `enum` regardless of the table above, so `order_by_direction` is a
 * control over its declared values rather than a text box — `BLOCK_CONFIG`'s own `enums` is
 * the source, so a value added there needs no edit here.
 */
export function fieldKind(
  blockType: BlockType,
  field: string
): ConfigFieldKind {
  const schema = BLOCK_CONFIG[blockType]
  if (field in schema.enums) return "enum"
  return FIELD_KINDS[blockType]?.[field] ?? "other"
}

// --- The option shapes ------------------------------------------------------

/**
 * One selectable metric or derived statistic, as the selection declares it.
 *
 * `resourceType` is carried because the same metric name can be selected for two resource
 * types with different statistics, and a picker that dropped it would present one option for
 * two different collections. `estimated` is membership in the catalog's `percentiles` rather
 * than a second boolean the catalog would also have to declare.
 */
export type MetricOption = {
  readonly kind: "metric"
  readonly resourceType: string
  /** Exactly one of these is set, mirroring `MetricSelectionItem`. */
  readonly metric?: string
  readonly derived?: string
  readonly statistic: string
  /** `<name>:<statistic>` — the same key `MetricRef.key` builds on the agent's side. */
  readonly key: string
  readonly label: string
  /** Whether the catalog declares this statistic as an estimate rather than exact. */
  readonly estimated: boolean
  /** From the catalog, for presentation only. `undefined` when the catalog declares none. */
  readonly unit?: string
  readonly scale?: number
  readonly estimatorLabel?: string
  readonly fidelityTier?: string
}

/** One selectable resource attribute. Carries no unit and no statistic — it is a string. */
export type AttributeOption = {
  readonly kind: "attribute"
  readonly attribute: ColumnAttribute
  readonly key: ColumnAttribute
  readonly label: string
  /**
   * Whether the table already emits this attribute without being asked. Presented rather than
   * hidden, so a consultant sees *why* it cannot be selected instead of wondering where it
   * went — and selecting it anyway is the validation error Requirement 12.3 names.
   */
  readonly implicit: boolean
}

/** One selectable fact key, for a resource type the block's scope can contain. */
export type FactOption = {
  readonly kind: "fact"
  readonly resourceType: string
  readonly factKey: string
  readonly key: string
  readonly label: string
  readonly valueKind: "numeric" | "text"
  readonly source: string
  readonly unit?: string
}

export type ConfigOption = MetricOption | AttributeOption | FactOption

/**
 * The three groups a `column_list` presents, each rendered as its own labelled group.
 *
 * Three arrays rather than one array with a `kind` discriminator, because "distinctly
 * presented" is a requirement about the interface and a flat list makes it a rendering
 * convention a component could forget. A member of two groups is not representable.
 */
export type OptionGroups = {
  readonly metrics: readonly MetricOption[]
  readonly attributes: readonly AttributeOption[]
  readonly facts: readonly FactOption[]
}

const NO_OPTIONS: OptionGroups = Object.freeze({
  metrics: Object.freeze([]),
  attributes: Object.freeze([]),
  facts: Object.freeze([]),
})

// --- The fact declaration, as the app receives it ---------------------------

/**
 * One declared fact, projected for the app.
 *
 * **Injected, never imported.** `agent/.../catalog/facts.v1.json` is the agent's file, and
 * this module stays pure by taking the declaration as an argument — the same shape
 * `optionsFor` takes the catalog in. Reading the JSON here would make a client-importable
 * module depend on a path outside `app/`, which is the coupling `lib/templates/catalog.ts`
 * confines to one `server-only` module.
 */
export type FactDeclarationEntry = {
  readonly resourceType: string
  readonly key: string
  readonly valueKind: "numeric" | "text"
  readonly source: string
  readonly unit?: string
}

export type FactDeclarationSnapshot = readonly FactDeclarationEntry[]

// --- Scope resolution -------------------------------------------------------

/**
 * The resource types `block`'s resolved scope can contain.
 *
 * Its own `scope_override`, or the template default — `BlockContext.scope_for`'s precedence,
 * and the only rule there is. An **empty** `resource_types` is unconstrained, so it resolves to
 * every type the definition selects metrics for rather than to none: emptiness means "no
 * narrowing", and returning none would hide every option from a block that narrows nothing,
 * which is the common case.
 *
 * Case-folded against the selection's keys, because the catalog lookups fold too
 * (`findCatalogResourceType`) and Azure type strings arrive lower-cased from Resource Graph. A
 * scope naming `Microsoft.Compute/virtualMachines` and a selection keyed
 * `microsoft.compute/virtualmachines` are one type.
 */
export function resolvedResourceTypes(
  definition: Pick<TemplateDefinition, "scope" | "metrics">,
  block: Pick<LeafBlock, "scope_override">
): readonly string[] {
  const selected = Object.keys(definition.metrics)
  const scope: Pick<ScopeSpec, "resource_types"> =
    block.scope_override ?? definition.scope
  const narrowed = scope.resource_types

  if (narrowed.length === 0) return selected

  const wanted = new Set(narrowed.map((type) => type.toLowerCase()))
  return selected.filter((type) => wanted.has(type.toLowerCase()))
}

// --- Building the options ---------------------------------------------------

function catalogEntryFor(
  catalog: MetricCatalogSnapshot,
  resourceType: string,
  item: MetricSelectionItem
) {
  const folded = resourceType.toLowerCase()
  const forType = catalog.find(
    (entry) => entry.resourceType.toLowerCase() === folded
  )
  if (forType === undefined) return undefined
  if (item.metric !== undefined) {
    return forType.entries.find(
      (entry) => entry.kind === "metric" && entry.name === item.metric
    )
  }
  if (item.derived !== undefined) {
    return forType.entries.find(
      (entry) => entry.kind === "derived" && entry.name === item.derived
    )
  }
  return undefined
}

/** `<name>:<statistic>`, the key `MetricRef.key` builds on the agent's side. */
export function metricOptionKey(item: MetricSelectionItem): string {
  return `${item.metric ?? item.derived ?? ""}:${item.statistic}`
}

function metricOptionsFor(
  definition: Pick<TemplateDefinition, "scope" | "metrics">,
  block: Pick<LeafBlock, "scope_override">,
  catalog: MetricCatalogSnapshot
): readonly MetricOption[] {
  const options: MetricOption[] = []

  for (const resourceType of resolvedResourceTypes(definition, block)) {
    for (const item of definition.metrics[resourceType] ?? []) {
      const name = item.metric ?? item.derived
      if (name === undefined) continue

      const entry = catalogEntryFor(catalog, resourceType, item)
      const percentile = entry?.percentiles[item.statistic]

      options.push({
        kind: "metric",
        resourceType,
        ...(item.metric === undefined ? {} : { metric: item.metric }),
        ...(item.derived === undefined ? {} : { derived: item.derived }),
        statistic: item.statistic,
        key: metricOptionKey(item),
        label: `${name} (${item.statistic})`,
        // Membership in the catalog's `percentiles`, not a second boolean: a statistic keyed
        // there came from a bounded sketch and is an estimate, and every other statistic the
        // entry declares rolls up exactly.
        estimated: percentile !== undefined,
        ...(entry?.unit === undefined ? {} : { unit: entry.unit }),
        ...(entry?.scale === undefined ? {} : { scale: entry.scale }),
        // The catalog's label, never composed here — the same rule the renderer follows.
        ...(percentile === undefined
          ? {}
          : {
              estimatorLabel: percentile.estimator,
              fidelityTier: percentile.fidelityTier,
            }),
      })
    }
  }

  return options
}

function attributeOptions(implicitApply: boolean): readonly AttributeOption[] {
  const implicit = new Set<string>(IMPLICIT_COLUMN_ATTRIBUTES)
  return COLUMN_ATTRIBUTES.map((attribute) => ({
    kind: "attribute" as const,
    attribute,
    key: attribute,
    label: attribute,
    implicit: implicitApply && implicit.has(attribute),
  }))
}

function factOptionsFor(
  definition: Pick<TemplateDefinition, "scope" | "metrics">,
  block: Pick<LeafBlock, "scope_override">,
  factDeclaration: FactDeclarationSnapshot
): readonly FactOption[] {
  const inScope = new Set(
    resolvedResourceTypes(definition, block).map((type) => type.toLowerCase())
  )

  return factDeclaration
    .filter((entry) => inScope.has(entry.resourceType.toLowerCase()))
    .map((entry) => ({
      kind: "fact" as const,
      resourceType: entry.resourceType,
      factKey: entry.key,
      key: entry.key,
      label: entry.key,
      valueKind: entry.valueKind,
      source: entry.source,
      ...(entry.unit === undefined ? {} : { unit: entry.unit }),
    }))
}

export type OptionsInput = {
  readonly definition: Pick<TemplateDefinition, "scope" | "metrics">
  readonly block: Pick<LeafBlock, "type" | "scope_override">
  readonly catalog: MetricCatalogSnapshot
  readonly factDeclaration: FactDeclarationSnapshot
}

/**
 * The options `field` may be set to on `input.block` (Requirements 12.2, 12.4).
 *
 * A field whose kind is `enum` or `other` yields **no** options, and that is not an omission:
 * an enum's values come from `BLOCK_CONFIG.enums` and a caption's from the consultant, so
 * returning a group for either would invite a picker to present the wrong control.
 *
 * A `metric_ref` and a `metric_ref_list` yield the metrics group alone. Both attributes and
 * facts are meaningless there — a chart plots a series over time and an attribute is a
 * constant string — so the two groups are empty rather than filtered by the caller.
 */
export function optionsFor(field: string, input: OptionsInput): OptionGroups {
  const kind = fieldKind(input.block.type, field)

  if (kind === "enum" || kind === "other") return NO_OPTIONS

  const metrics = metricOptionsFor(input.definition, input.block, input.catalog)

  if (kind === "metric_ref" || kind === "metric_ref_list") {
    return { metrics, attributes: [], facts: [] }
  }

  return {
    metrics,
    // The implicit pair applies to the two table blocks, which are the only blocks with a
    // `column_list` — so `implicit` is computed rather than hardcoded true, and a third block
    // gaining a column list would present them as ordinarily selectable until this says
    // otherwise.
    attributes: attributeOptions(
      input.block.type === "resource_table" ||
        input.block.type === "top_n_table"
    ),
    facts: factOptionsFor(input.definition, input.block, input.factDeclaration),
  }
}

// --- Undeclared references --------------------------------------------------

/** Why a stored reference could not be resolved against the definition. */
export type ConfigReferenceReason =
  "metric_not_selected" | "fact_key_undeclared" | "attribute_unknown"

export type ConfigReferenceIssue = {
  /** The definition path of the offending entry, e.g. `blocks.2.config.columns.0`. */
  readonly path: readonly (string | number)[]
  readonly reason: ConfigReferenceReason
  readonly blockId: string
  readonly field: string
  /** What the definition stored there, as a display string. */
  readonly reference: string
  readonly message: string
}

/** Every leaf block, with its definition path — descending one level into a row. */
function leafBlocksWithPaths(
  definition: Pick<TemplateDefinition, "blocks">
): readonly {
  readonly block: LeafBlock
  readonly path: (string | number)[]
}[] {
  const found: { block: LeafBlock; path: (string | number)[] }[] = []

  definition.blocks.forEach((block, index) => {
    if (block.type === "row") {
      block.columns.forEach((column, columnIndex) => {
        column.forEach((child, childIndex) => {
          found.push({
            block: child,
            path: ["blocks", index, "columns", columnIndex, childIndex],
          })
        })
      })
      return
    }
    found.push({ block, path: ["blocks", index] })
  })

  return found
}

/**
 * The reference a stored `columns`/`metrics` entry names, as a display string.
 *
 * A metric ref is stored as an object and an attribute or fact key as a bare string, so this
 * is what a message can quote either way. `JSON.stringify` for the object case rather than a
 * hand-built rendering, because the point is to show the consultant what is actually stored.
 */
function referenceLabel(entry: unknown): string {
  if (typeof entry === "string") return entry
  if (entry !== null && typeof entry === "object") {
    const record = entry as Record<string, unknown>
    const name = record.metric ?? record.derived
    if (typeof name === "string" && typeof record.statistic === "string") {
      return `${name}:${record.statistic}`
    }
  }
  return JSON.stringify(entry) ?? String(entry)
}

function metricKeyOf(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined
  const record = entry as Record<string, unknown>
  const name = record.metric ?? record.derived
  if (typeof name !== "string" || typeof record.statistic !== "string") {
    return undefined
  }
  return `${name}:${record.statistic}`
}

/**
 * Every stored block-config reference that resolves to no option (Requirements 12.9, 12.10).
 *
 * **Returns issues and takes no store.** The load path calls this, presents what it returns,
 * and writes nothing — which is criterion 12.10 as a signature rather than as a rule somebody
 * has to remember. A load path that removed an undeclared reference would silently edit a rule
 * a consultant wrote, and the edit would be invisible precisely because it deleted the evidence.
 *
 * The three reasons are not interchangeable and each points somewhere different: a metric
 * absent from the selection is fixed on step 4, an undeclared fact key is a resource type the
 * declaration says nothing about, and an unknown attribute is a name no renderer can emit.
 *
 * A **bare string** in a metric-valued field is read as an attribute or a fact key, because
 * that is what the version-1 wire shape allows and what task 12.6 replaces with a typed
 * object. So a v1 `columns: ["Percentage CPU:avg"]` reports `attribute_unknown` rather than
 * being silently accepted — it names neither a declared attribute nor a declared fact key.
 */
export function undeclaredReferences(
  definition: Pick<TemplateDefinition, "scope" | "metrics" | "blocks">,
  catalog: MetricCatalogSnapshot,
  factDeclaration: FactDeclarationSnapshot
): readonly ConfigReferenceIssue[] {
  const issues: ConfigReferenceIssue[] = []
  const attributes = new Set<string>(COLUMN_ATTRIBUTES)

  for (const { block, path } of leafBlocksWithPaths(definition)) {
    const groups = {
      metrics: new Set(
        metricOptionsFor(definition, block, catalog).map((option) => option.key)
      ),
      facts: new Set(
        factOptionsFor(definition, block, factDeclaration).map(
          (option) => option.factKey
        )
      ),
    }

    for (const field of Object.keys(block.config)) {
      const kind = fieldKind(block.type, field)
      if (kind === "enum" || kind === "other") continue

      const value = block.config[field]
      const entries = kind === "metric_ref" ? [value] : value
      if (!Array.isArray(entries)) continue

      entries.forEach((entry, index) => {
        const entryPath =
          kind === "metric_ref"
            ? [...path, "config", field]
            : [...path, "config", field, index]
        const reference = referenceLabel(entry)
        const metricKey = metricKeyOf(entry)

        if (metricKey !== undefined) {
          if (!groups.metrics.has(metricKey)) {
            issues.push({
              path: entryPath,
              reason: "metric_not_selected",
              blockId: block.id,
              field,
              reference,
              message:
                `Block "${block.id}" names the metric "${reference}" in "${field}", ` +
                `which this template's metric selection does not carry for any resource ` +
                `type the block's scope can contain. A block can display only what the ` +
                `run collects.`,
            })
          }
          return
        }

        if (typeof entry !== "string") return

        if (kind === "column_list" && attributes.has(entry)) return
        if (kind === "column_list" && groups.facts.has(entry)) return

        issues.push({
          path: entryPath,
          reason:
            kind === "column_list" && looksLikeFactKey(entry)
              ? "fact_key_undeclared"
              : "attribute_unknown",
          blockId: block.id,
          field,
          reference,
          message:
            `Block "${block.id}" names "${reference}" in "${field}", which is neither ` +
            `a declared resource attribute nor a fact key the declaration declares for a ` +
            `resource type the block's scope can contain.`,
        })
      })
    }
  }

  return issues
}

/**
 * Whether `entry` is shaped like a fact key rather than like anything else.
 *
 * `^[a-z][a-z0-9_]*$` — the agent's own `_FACT_KEY_PATTERN`, mirrored by value. Used **only**
 * to choose which of two reasons to report, never to accept anything: a name matching this and
 * absent from the declaration is still an issue. The distinction earns its keep because the
 * two reasons point at different screens — an undeclared fact key is a resource type the
 * declaration says nothing about, and an unknown attribute is a name no renderer can emit.
 */
function looksLikeFactKey(entry: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(entry)
}
