/**
 * The `Template_Validator` — the zod definition schema (Requirements 1.3,
 * 2.1, 2.2, 2.4, 2.7, 2.9, 2.10, 3.1, 3.2, 3.10, 4.1, 4.2, 4.12, 5.1, 5.2, 5.3,
 * 5.5, 5.7, 5.8, 5.9, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 7.1, 7.2,
 * 7.8).
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no clock, no
 * database: a definition value in, a list of violations out. The wizard
 * previews this same validator client-side before submitting (Requirement
 * 11.3), and a route handler runs the identical check server-side before any
 * write — one schema, not a client approximation of a server rule.
 *
 * ## Why this is hand-written validation wrapped in `z.custom`, not
 * `z.object().strict()` composed with `.superRefine()`
 *
 * A first attempt at this schema used the obvious shape — `z.strictObject`
 * for every level, `z.enum` for closed value sets, `z.literal("row")` to
 * discriminate a block from its siblings — with a `.superRefine()` at the
 * top doing the cross-field checks (duplicate ids, row-nesting depth, the
 * Azure-identifier scan). That shape is wrong, and it is wrong in a way that
 * only shows up on an input carrying **two or more** simultaneous defects,
 * which is exactly the case Requirement 2.7 and 6.11 exist to cover.
 *
 * zod v4's built-in structural checks — `invalid_type`, `unrecognized_keys`
 * (from `.strict()`), and the enum/literal mismatch a `z.enum` or
 * `z.literal` produces — are declared with `abort: true` internally. An
 * `abort: true` issue anywhere in a schema tree marks that parse's payload
 * as aborted, and **a `.superRefine()` attached to an ancestor of the
 * aborted node does not run at all** — not "runs and reports fewer things",
 * but does not execute, so any issue it would have added is silently
 * missing from `error.issues`. This was verified empirically against the
 * zod `4.4.3` installed here (see the scratch checks this task ran before
 * writing a line of the real module): a `z.enum` mismatch three levels deep
 * suppresses a `.superRefine()` on the outermost object, even though a
 * `.min()` / `.max()` / `.regex()` failure at the same depth does not — those
 * default to `abort: false` and coexist with an ancestor's custom checks
 * exactly as expected.
 *
 * Concretely: a definition carrying both an undeclared block type (which a
 * `z.enum` would reject as `invalid_value`, an abort-true issue) **and** a
 * duplicate block `id` elsewhere in the tree (which only a `.superRefine()`
 * can detect) would report the first defect and silently drop the second —
 * the exact failure mode Requirement 6.11 names and Property 8
 * (task 3.3) is designed to kill. There is no parameter on `z.enum` or
 * `.strict()` that changes this; the abort behaviour is a property of the
 * check, not something a caller opts out of per call site.
 *
 * The fix is to never give zod's own type system anything to abort on.
 * Every structural fact this module checks — is this an object, is this key
 * present, is this value one of an enumerated set, is this array within
 * bounds — is checked by hand, with `typeof` / `Array.isArray` / `in`, and
 * every violation is reported through `ctx.addIssue(...)` with `code:
 * "custom"`, which **never** aborts. The whole validator is one recursive
 * walk collecting a flat list of {@link FieldIssue}s, and the exported
 * `z.custom(...)` schema's only job is to run that walk and hand every
 * collected issue to zod once. That is what makes "one pass reporting every
 * violation" (Requirements 2.7, 6.11) a property of the architecture rather
 * than something a reviewer has to keep re-verifying by hand after the next
 * edit adds a new `z.enum`.
 *
 * `z.custom<TemplateDefinition>(...)` rather than `z.unknown()` so the
 * schema's inferred output type is the real {@link TemplateDefinition} shape
 * for a caller that reaches `.parse()` / `.safeParse().data` — zod does not
 * narrow the type from the validator function itself (it cannot; the
 * function only reports issues), so the exported schema is deliberately
 * typed as `z.ZodType<TemplateDefinition>` rather than inferred.
 *
 * ## What "type mismatch rejected rather than coerced" means concretely
 *
 * This module contains no `z.coerce.*`, no `Number(value)`, no `String(value)`,
 * and no truthy/falsy narrowing that would treat `"0"` as falsy or `0` as
 * present-but-empty. Every value check is `typeof value === "..."` or an
 * explicit `Number.isInteger` / `Number.isFinite` test. A `schema_version` of
 * `"1"` (a string) is rejected as a type mismatch, not parsed into the
 * integer `1` — Requirement 2.2 is explicit that a type mismatch is a
 * rejection, and a coercion is a decoder, not a validator.
 *
 * ## Layering: this module validates SHAPE. Metric_Catalog membership is a
 * separate, explicitly-composed check
 *
 * Requirements 5.2, 5.3, 5.5, 5.7, 5.8 and 5.9 require rejecting a metric
 * selection entry that the Metric_Catalog does not declare for that resource
 * type, and a derived statistic whose source metrics or SKU capabilities the
 * catalog does not declare. The catalog those criteria refer to
 * (`agent/src/reporting_agent/catalog/loader.py` + `catalog/metrics.v1.json`)
 * is a Python-side, in-memory structure built by the foundation spec; there
 * is **no TypeScript-side catalog module anywhere in `app/` yet** — this
 * task's own dependency search confirmed that `GET /api/templates/catalog`
 * (design.md's route for serving the catalog's selectable items to step 4 of
 * the wizard) is task 13.1, not this one, and no interim catalog data exists
 * to import.
 *
 * `zod` schemas are synchronous, and a catalog lookup that will eventually be
 * served over HTTP is not something this module should fabricate a fake copy
 * of just to close the gap early. The base schema below therefore validates
 * every SHAPE-level fact a metric selection can be checked against with zero
 * external data: entries are objects rather than bare strings (so a
 * percentile entry has somewhere to carry its estimator and fidelity tier),
 * every declared bound (≤25 resource-type entries, 1–40 items each), and the
 * structural rule that a percentile-shaped statistic (`p` followed by digits,
 * the same pattern `collect/snapshot.py`'s `_PERCENTILE_KEY_PATTERN` forbids
 * as a bare key) never appears without both `estimator` and `fidelity_tier`
 * present (Requirements 5.7, 5.8).
 *
 * Requirement 5.9 — every resource type a scope can contain has a metric
 * selection — is checked in the shape walk too, by
 * {@link validateEveryScopedTypeIsSelected}, and **only half of it can be**.
 * When the scope names resource types it is a pure cross-field comparison
 * between `scope`/`scope_override` and `metrics`, needing no catalog, so it
 * belongs here where the both-halves-agree guarantee is free. What stays
 * outside any validator is a scope naming **no** resource types: an empty
 * dimension is unconstrained (Requirements 3.1, 3.12), so which types it can
 * contain is a fact about the subscription rather than the definition, and no
 * save-time or enqueue-time check can see it. The collector records that case
 * as a `metric_not_selected` gap instead.
 *
 * The catalog-*membership* checks — is this metric/derived statistic
 * actually declared for this resource type, does a derived statistic's
 * formula have every source metric and SKU capability it needs — are
 * exposed as a **separately callable, explicitly catalog-parameterized**
 * function, {@link validateMetricSelectionAgainstCatalog}. It is not run by
 * the exported `templateDefinitionSchema` automatically, and it is not
 * wired to a real catalog anywhere in this task. A later caller — the route
 * or server action that already has the loaded catalog to hand (task 13.1,
 * or a `lib/templates/catalog.ts` module that task creates) composes it
 * explicitly:
 *
 * ```ts
 * const shapeIssues = safeParseDefinitionIssues(candidate)
 * const catalogIssues = shapeIssues.length === 0
 *   ? validateMetricSelectionAgainstCatalog(candidate as TemplateDefinition, catalog)
 *   : []
 * ```
 *
 * {@link MetricCatalogSnapshot} declares the minimal shape that function
 * needs — per resource type, the declared metric and derived-statistic
 * names, which statistics are percentiles and what estimator/fidelity tier
 * each declares, and what a derived statistic's formula requires — modelled
 * directly on `catalog/loader.py`'s `LoadedCatalog` / `ResourceTypeCatalog`
 * dataclasses so a future `lib/templates/catalog.ts` has an obvious shape to
 * produce rather than inventing its own. No catalog data is fabricated here;
 * this is an interface, not a stand-in dataset.
 *
 * ## The RFC 8785 byte-size bound reuses `canonical-json.ts`, not
 * `JSON.stringify`
 *
 * Requirement 2.10 bounds a definition at 262,144 bytes of UTF-8 **in its
 * RFC 8785 canonical form**, not in whatever byte count `JSON.stringify`
 * happens to produce (key order, whitespace and escaping all differ between
 * the two). `lib/templates/version.ts` (task 3.4) will need the identical
 * canonicalization to compute `definition_sha256`, so
 * `lib/templates/canonical-json.ts` was written as its own module in this
 * task rather than inlining a throwaway canonicalizer here — task 3.4 is
 * expected to depend on that module rather than duplicate it, so the byte
 * count this schema enforces and the digest that module computes are
 * guaranteed to agree on what "canonical form" means.
 */

import { z } from "zod"

import { BLOCK_CONFIG, BLOCK_TYPES, type BlockType } from "@/lib/templates/blocks"
import { canonicalJsonByteLength, type CanonicalizableValue } from "@/lib/templates/canonical-json"
import {
  MAX_PERIOD_LOCAL_DAYS,
  MIN_PERIOD_LOCAL_DAYS,
  PERIOD_KINDS,
  inclusiveLocalDaySpan,
  isRealCalendarDate,
  type PeriodKind,
  type PeriodSpec,
} from "@/lib/templates/period"

/**
 * The period vocabulary is **declared** in `lib/templates/period.ts` and
 * re-exported here under its original names, so every existing importer of
 * `PERIOD_KINDS` / `PeriodKind` / `PeriodSpec` is unaffected by the move.
 *
 * The direction is forced rather than chosen: the Period_Resolver needs
 * `PERIOD_KINDS` as a *value* (Requirement 4.11 — an unrecognized pinned kind is
 * a runtime membership test) and this module needs the resolver's local-day
 * arithmetic, so one of the two imports has to be type-only or the modules form
 * a runtime cycle. Putting the vocabulary beside the arithmetic that consumes it
 * leaves this module importing values in one direction only.
 */
export { PERIOD_KINDS, type PeriodKind, type PeriodSpec }

// --- Bounds (Requirements 2.10, 3.1, 4.2, 5.1, 6.2, 6.3, 7.2) ----------------

export const NAME_MIN_LENGTH = 1
export const NAME_MAX_LENGTH = 120
export const DESCRIPTION_MAX_LENGTH = 1000
/** Not bounded by any single criterion; kept in the same range as `name`. */
export const REPORT_TITLE_MAX_LENGTH = 200

/** Requirement 2.9 — the highest `schema_version` this reader accepts. */
export const MIN_SCHEMA_VERSION = 1
export const MAX_SUPPORTED_SCHEMA_VERSION = 1

/** Requirement 2.10 — 262,144 bytes of UTF-8 in RFC 8785 canonical form. */
export const MAX_DEFINITION_CANONICAL_BYTES = 262_144

/** Requirement 3.1. */
export const MAX_RESOURCE_TYPES = 20
export const RESOURCE_TYPE_MAX_LENGTH = 300
export const MAX_TAG_FILTERS = 10
export const TAG_KEY_MIN_LENGTH = 1
export const TAG_KEY_MAX_LENGTH = 512
export const TAG_VALUE_MAX_LENGTH = 256
export const MAX_RESOURCE_GROUPS = 50
export const RESOURCE_GROUP_MIN_LENGTH = 1
export const RESOURCE_GROUP_MAX_LENGTH = 90
export const TOP_N_MIN_COUNT = 1
export const TOP_N_MAX_COUNT = 500

/** Requirement 5.1. */
export const MAX_METRIC_RESOURCE_TYPE_ENTRIES = 25
export const MIN_METRIC_ITEMS_PER_ENTRY = 1
export const MAX_METRIC_ITEMS_PER_ENTRY = 40

/** Requirement 6.2, 6.3. */
export const BLOCK_ID_MIN_LENGTH = 1
export const BLOCK_ID_MAX_LENGTH = 64
export const MAX_BLOCKS_TOTAL = 200
export const MIN_ROW_COLUMNS = 2
export const MAX_ROW_COLUMNS = 3
export const MAX_CHILDREN_PER_COLUMN = 8

/** Requirement 7.2. */
export const ACCENT_COLOR_MAX_LENGTH = 64
export const LOGO_MAX_LENGTH = 512
export const MIN_DECIMAL_PLACES = 0
export const MAX_DECIMAL_PLACES = 3

// --- Closed value sets --------------------------------------------------

/** Requirement 3.1. */
export const SORT_DIRECTIONS = ["descending", "ascending"] as const
export type SortDirection = (typeof SORT_DIRECTIONS)[number]

/** Requirement 7.1 — exactly four, case-sensitive. */
export const DESIGN_PRESETS = ["editorial", "corporate", "technical", "minimal"] as const
export type DesignPreset = (typeof DESIGN_PRESETS)[number]

/** Requirement 7.2. */
export const DENSITY_VALUES = ["compact", "normal", "relaxed"] as const
export type Density = (typeof DENSITY_VALUES)[number]

export const TABLE_STYLE_VALUES = ["hairline", "banded", "bordered"] as const
export type TableStyle = (typeof TABLE_STYLE_VALUES)[number]

export const PAGE_SIZE_VALUES = ["A4", "Letter"] as const
export type PageSize = (typeof PAGE_SIZE_VALUES)[number]

/**
 * A block type that may appear as a `row`'s child (Requirement 6.4) — every
 * declared type except `row` itself. Declared here as a value (not just a
 * type) so the row-nesting check and the "known type" check share one source
 * of truth with {@link BLOCK_TYPES} rather than a second hand-copied list.
 */
export const NON_ROW_BLOCK_TYPES = BLOCK_TYPES.filter(
  (type): type is Exclude<BlockType, "row"> => type !== "row"
)

// --- The exported value shapes ------------------------------------------

export type TagFilter = { readonly key: string; readonly value: string }

export type TopNSpec = {
  readonly count: number
  readonly metric: string
  readonly statistic: string
}

export type ScopeSpec = {
  readonly resource_types: readonly string[]
  readonly tag_filters: readonly TagFilter[]
  readonly resource_groups: readonly string[]
  readonly top_n: TopNSpec | null
  readonly sort: SortDirection | null
}

/**
 * One metric-selection item (Requirement 5.1). An **object**, never a bare
 * string (design.md's worked example), so a percentile entry has a place to
 * carry the catalog's estimator label and fidelity tier (Requirement 5.7).
 *
 * Exactly one of `metric` (a platform metric name) or `derived` (a derived
 * statistic id) is present — never both, never neither.
 */
export type MetricSelectionItem = {
  readonly metric?: string
  readonly derived?: string
  readonly statistic: string
  readonly estimator?: string
  readonly fidelity_tier?: string
}

export type MetricSelection = Readonly<Record<string, readonly MetricSelectionItem[]>>

/** A non-`row` block (Requirement 6.2). */
export type LeafBlock = {
  readonly id: string
  readonly type: Exclude<BlockType, "row">
  readonly config: Readonly<Record<string, unknown>>
  readonly scope_override?: ScopeSpec
}

/**
 * A `row` block — `columns` is a **list of lists** (Requirement 6.2), so "2
 * or 3 columns" is that array's own length and no separate count field can
 * disagree with the children it actually holds.
 */
export type RowBlock = {
  readonly id: string
  readonly type: "row"
  readonly columns: readonly (readonly LeafBlock[])[]
}

export type TemplateBlock = LeafBlock | RowBlock

export type NumberFormat = {
  readonly decimal_places: number
  readonly group_thousands: boolean
}

export type DesignSpec = {
  readonly preset: DesignPreset
  readonly accent_color: string
  readonly density: Density
  readonly table_style: TableStyle
  readonly number_format: NumberFormat
  readonly cover_page: boolean
  readonly logo: string | null
  readonly page_size: PageSize
}

export type TemplateIdentity = {
  readonly name: string
  readonly description?: string
  readonly report_title?: string
}

/**
 * The seven required top-level keys, and nothing else (Requirement 2.1).
 */
export type TemplateDefinition = {
  readonly schema_version: number
  readonly identity: TemplateIdentity
  readonly scope: ScopeSpec
  readonly period: PeriodSpec
  readonly metrics: MetricSelection
  readonly blocks: readonly TemplateBlock[]
  readonly design: DesignSpec
}

// --- Issue collection -----------------------------------------------------

/**
 * One violation, located by field path (Requirements 2.7, 6.11). `path`
 * mirrors the segments zod itself would produce — string keys and numeric
 * array indices — so a caller rendering "every failing field path in one
 * response" (Requirement 2.7) can join them the same way zod's own
 * `error.issues[].path` is joined elsewhere in this codebase.
 */
export type FieldIssue = {
  readonly path: readonly (string | number)[]
  readonly message: string
}

/** Mutates `issues` — every validator function below takes the same sink. */
type IssueSink = FieldIssue[]

function addIssue(sink: IssueSink, path: readonly (string | number)[], message: string): void {
  sink.push({ path, message })
}

// --- Low-level type guards ------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function stringLengthInRange(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max
}

// --- Azure identifier detection (Requirement 1.3) -------------------------

/**
 * A bare GUID, canonically hyphenated — the shape of an Azure subscription id
 * or tenant id on its own, with no surrounding path.
 */
const AZURE_GUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Every fully qualified Azure resource id, of every provider-path shape,
 * contains this literal segment — `/subscriptions/{guid}/...` — so matching
 * on it (case-insensitively; Azure resource ids are case-insensitive) is
 * sufficient without parsing the rest of the path, which varies by provider.
 */
const AZURE_RESOURCE_ID_SEGMENT_PATTERN = /\/subscriptions\//i

/**
 * Whether `value` has the shape of a fully qualified Azure resource
 * identifier, a bare subscription id, or a bare tenant id (Requirement 1.3).
 *
 * A scope is expressed as resource *types*, tag filters and resource
 * *groups* — categories, never named resources — so anything shaped like an
 * actual identifier in one of those fields is exactly the hole this check
 * closes. Exported for the property test (task 3.3) and for direct unit
 * testing.
 */
export function looksLikeAzureIdentifier(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (AZURE_GUID_PATTERN.test(trimmed)) return true
  if (AZURE_RESOURCE_ID_SEGMENT_PATTERN.test(trimmed)) return true
  return false
}

/** Requirement 1.3's rejection message, shared by every scope-field check. */
function azureIdentifierMessage(path: readonly (string | number)[]): string {
  return (
    `The value at "${path.join(".")}" looks like a fully qualified Azure resource ` +
    "identifier, a subscription identifier, or a tenant identifier. A scope is " +
    "expressed as resource types, tag filters and resource groups — never as " +
    "named resources."
  )
}

// --- Forbidden positioning fields (Requirement 6.5) -----------------------

/**
 * Field-name patterns that name an absolute position, a coordinate, an
 * offset, an absolute width or height, or an explicit page assignment
 * (Requirement 6.5). Matched against every key on a block object itself and
 * every key inside a block's `config`, case-insensitively, because Word is a
 * reflowing paginated medium and any of these fields is exactly the free
 * positioning that breaks pagination.
 *
 * None of these names appear in any `BLOCK_CONFIG` entry `blocks.ts`
 * declares (task 3.1) — they would already be caught as an "unrecognized
 * config field" by the generic check below. This list exists so the
 * rejection **names the forbidden concept explicitly** ("this is a
 * positioning field", not merely "this field is not declared") the way
 * Requirement 6.5 asks for, and so the generic unrecognized-field check does
 * not also fire a second, less specific issue for the same key.
 */
const FORBIDDEN_POSITIONING_FIELD_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /position/i, label: "an absolute position" },
  { pattern: /coordinate/i, label: "a coordinate" },
  { pattern: /^offset/i, label: "an offset" },
  { pattern: /^(x|y)$/i, label: "a coordinate" },
  { pattern: /absolute.*width|width.*absolute/i, label: "an absolute width" },
  { pattern: /absolute.*height|height.*absolute/i, label: "an absolute height" },
  { pattern: /page_?assignment/i, label: "an explicit page assignment" },
  { pattern: /page_?number/i, label: "an explicit page assignment" },
] as const

/** The forbidden-positioning label for `key`, or `null` if it names nothing forbidden. */
function forbiddenPositioningLabel(key: string): string | null {
  for (const { pattern, label } of FORBIDDEN_POSITIONING_FIELD_PATTERNS) {
    if (pattern.test(key)) return label
  }
  return null
}

// --- Percentile statistics (Requirements 5.7, 5.8) ------------------------

/**
 * `p` followed only by digits — the same shape
 * `collect/snapshot.py`'s `_PERCENTILE_KEY_PATTERN` forbids as a bare object
 * key, matched here to decide whether a metric-selection entry names a
 * percentile and therefore requires an estimator label and a fidelity tier.
 * Lowercase `p` only, matching the agent's own pattern exactly — `P95` is not
 * a spelling the catalog or the collector ever produces.
 */
const PERCENTILE_STATISTIC_PATTERN = /^p[0-9]+$/

// --- Identity (Requirement 2.10) -------------------------------------------

const IDENTITY_ALLOWED_KEYS = new Set(["name", "description", "report_title"])

function validateIdentity(
  identity: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!isPlainObject(identity)) {
    addIssue(issues, path, "identity must be an object.")
    return
  }

  for (const key of Object.keys(identity)) {
    if (!IDENTITY_ALLOWED_KEYS.has(key)) {
      addIssue(issues, [...path, key], `Unrecognized identity field "${key}".`)
    }
  }

  const { name, description, report_title: reportTitle } = identity

  if (!isNonEmptyString(name) || !stringLengthInRange(name, NAME_MIN_LENGTH, NAME_MAX_LENGTH)) {
    addIssue(
      issues,
      [...path, "name"],
      `identity.name must be a string of ${NAME_MIN_LENGTH} to ${NAME_MAX_LENGTH} characters.`
    )
  }

  if (description !== undefined) {
    if (typeof description !== "string" || description.length > DESCRIPTION_MAX_LENGTH) {
      addIssue(
        issues,
        [...path, "description"],
        `identity.description must be a string of at most ${DESCRIPTION_MAX_LENGTH} characters.`
      )
    }
  }

  if (reportTitle !== undefined) {
    if (typeof reportTitle !== "string" || reportTitle.length > REPORT_TITLE_MAX_LENGTH) {
      addIssue(
        issues,
        [...path, "report_title"],
        `identity.report_title must be a string of at most ${REPORT_TITLE_MAX_LENGTH} characters.`
      )
    }
  }
}

// --- Scope (Requirements 1.3, 3.1, 3.2, 3.10) -------------------------------

const SCOPE_ALLOWED_KEYS = new Set([
  "resource_types",
  "tag_filters",
  "resource_groups",
  "top_n",
  "sort",
])

/**
 * Validates a `ScopeSpec` — the template default at `scope`, or a block's
 * `scope_override` (Requirement 3.2) — at `path`.
 *
 * Every one of `resource_types`, `tag_filters`, `resource_groups`, `top_n`
 * and `sort` is required to be *present* (an empty array or `null`, never an
 * absent key), matching the shape design.md's worked example carries for
 * both the template default and a block override. Requiring presence rather
 * than defaulting means the mirrored Python validator never meets a scope
 * object with a key missing that this schema silently filled in — there is
 * one shape, not a shape plus a set of implicit defaults a second reader
 * would have to reproduce exactly.
 */
function validateScopeSpec(
  scope: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!isPlainObject(scope)) {
    addIssue(issues, path, "A scope specification must be an object.")
    return
  }

  for (const key of Object.keys(scope)) {
    if (!SCOPE_ALLOWED_KEYS.has(key)) {
      addIssue(issues, [...path, key], `Unrecognized scope field "${key}".`)
    }
  }

  validateResourceTypes(scope.resource_types, [...path, "resource_types"], issues)
  validateTagFilters(scope.tag_filters, [...path, "tag_filters"], issues)
  validateResourceGroups(scope.resource_groups, [...path, "resource_groups"], issues)
  validateTopN(scope.top_n, [...path, "top_n"], issues)
  validateSort(scope.sort, [...path, "sort"], issues)
}

function validateResourceTypes(
  value: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "resource_types must be an array.")
    return
  }

  if (value.length > MAX_RESOURCE_TYPES) {
    addIssue(issues, path, `resource_types accepts at most ${MAX_RESOURCE_TYPES} entries.`)
  }

  value.forEach((entry, index) => {
    const entryPath = [...path, index]
    if (
      !isNonEmptyString(entry) ||
      !stringLengthInRange(entry, 1, RESOURCE_TYPE_MAX_LENGTH)
    ) {
      addIssue(
        issues,
        entryPath,
        `Each resource type must be a string of 1 to ${RESOURCE_TYPE_MAX_LENGTH} characters.`
      )
      return
    }
    if (looksLikeAzureIdentifier(entry)) {
      addIssue(issues, entryPath, azureIdentifierMessage(entryPath))
    }
  })
}

function validateTagFilters(
  value: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "tag_filters must be an array.")
    return
  }

  if (value.length > MAX_TAG_FILTERS) {
    addIssue(issues, path, `tag_filters accepts at most ${MAX_TAG_FILTERS} entries.`)
  }

  value.forEach((entry, index) => {
    const entryPath = [...path, index]
    if (!isPlainObject(entry)) {
      addIssue(issues, entryPath, "Each tag filter must be an object of `key` and `value`.")
      return
    }

    for (const key of Object.keys(entry)) {
      if (key !== "key" && key !== "value") {
        addIssue(issues, [...entryPath, key], `Unrecognized tag filter field "${key}".`)
      }
    }

    const { key: tagKey, value: tagValue } = entry

    if (
      !isNonEmptyString(tagKey) ||
      !stringLengthInRange(tagKey, TAG_KEY_MIN_LENGTH, TAG_KEY_MAX_LENGTH)
    ) {
      addIssue(
        issues,
        [...entryPath, "key"],
        `A tag filter key must be a string of ${TAG_KEY_MIN_LENGTH} to ${TAG_KEY_MAX_LENGTH} characters.`
      )
    } else if (looksLikeAzureIdentifier(tagKey)) {
      addIssue(issues, [...entryPath, "key"], azureIdentifierMessage([...entryPath, "key"]))
    }

    if (typeof tagValue !== "string" || tagValue.length > TAG_VALUE_MAX_LENGTH) {
      addIssue(
        issues,
        [...entryPath, "value"],
        `A tag filter value must be a string of at most ${TAG_VALUE_MAX_LENGTH} characters.`
      )
    } else if (looksLikeAzureIdentifier(tagValue)) {
      addIssue(issues, [...entryPath, "value"], azureIdentifierMessage([...entryPath, "value"]))
    }
  })
}

function validateResourceGroups(
  value: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "resource_groups must be an array.")
    return
  }

  if (value.length > MAX_RESOURCE_GROUPS) {
    addIssue(issues, path, `resource_groups accepts at most ${MAX_RESOURCE_GROUPS} entries.`)
  }

  value.forEach((entry, index) => {
    const entryPath = [...path, index]
    if (
      !isNonEmptyString(entry) ||
      !stringLengthInRange(entry, RESOURCE_GROUP_MIN_LENGTH, RESOURCE_GROUP_MAX_LENGTH)
    ) {
      addIssue(
        issues,
        entryPath,
        `Each resource group name must be a string of ${RESOURCE_GROUP_MIN_LENGTH} to ` +
          `${RESOURCE_GROUP_MAX_LENGTH} characters.`
      )
      return
    }
    if (looksLikeAzureIdentifier(entry)) {
      addIssue(issues, entryPath, azureIdentifierMessage(entryPath))
    }
  })
}

function validateTopN(
  value: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (value === null) return
  if (!isPlainObject(value)) {
    addIssue(issues, path, "top_n must be an object or null.")
    return
  }

  const allowedKeys = new Set(["count", "metric", "statistic"])
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addIssue(issues, [...path, key], `Unrecognized top_n field "${key}".`)
    }
  }

  const { count, metric, statistic } = value

  if (
    !isFiniteInteger(count) ||
    count < TOP_N_MIN_COUNT ||
    count > TOP_N_MAX_COUNT
  ) {
    addIssue(
      issues,
      [...path, "count"],
      `top_n.count must be an integer from ${TOP_N_MIN_COUNT} to ${TOP_N_MAX_COUNT}.`
    )
  }

  // Requirement 3.10 — a top-N without a metric name or without a statistic
  // is rejected; both are required together, whether or not `count` itself
  // is valid.
  if (!isNonEmptyString(metric)) {
    addIssue(issues, [...path, "metric"], "top_n requires a metric name.")
  }
  if (!isNonEmptyString(statistic)) {
    addIssue(issues, [...path, "statistic"], "top_n requires a statistic.")
  }
}

function validateSort(
  value: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (value === null) return
  if (typeof value !== "string" || !SORT_DIRECTIONS.includes(value as SortDirection)) {
    addIssue(
      issues,
      path,
      `sort must be null or one of: ${SORT_DIRECTIONS.join(", ")}.`
    )
  }
}

// --- Period (Requirement 4.1, 4.2) ------------------------------------------
//
// `isRealCalendarDate`, `inclusiveLocalDaySpan` and the span bounds all live in
// `lib/templates/period.ts` (task 3.5) and are imported at the top of this
// module. They used to be private here, and the Period_Resolver needs the
// identical arithmetic for all six of Requirement 4.4's rules — two copies of
// local-day arithmetic is precisely the pair that drifts, one growing a
// leap-year fix the other does not, until the wizard accepts a definition the
// enqueue refuses.

function validatePeriod(
  period: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!isPlainObject(period)) {
    addIssue(issues, path, "period must be an object.")
    return
  }

  const { kind } = period
  if (typeof kind !== "string" || !PERIOD_KINDS.includes(kind as PeriodKind)) {
    addIssue(
      issues,
      [...path, "kind"],
      `period.kind must be one of: ${PERIOD_KINDS.join(", ")}.`
    )
    return
  }

  if (kind !== "custom") {
    const extraKeys = Object.keys(period).filter((key) => key !== "kind")
    for (const key of extraKeys) {
      addIssue(
        issues,
        [...path, key],
        `period.kind "${kind}" carries no field named "${key}".`
      )
    }
    return
  }

  // kind === "custom" (Requirement 4.2).
  const allowedKeys = new Set(["kind", "start", "end"])
  for (const key of Object.keys(period)) {
    if (!allowedKeys.has(key)) {
      addIssue(issues, [...path, key], `Unrecognized period field "${key}".`)
    }
  }

  const { start, end } = period
  const startIsValid = typeof start === "string" && isRealCalendarDate(start)
  const endIsValid = typeof end === "string" && isRealCalendarDate(end)

  if (!startIsValid) {
    addIssue(issues, [...path, "start"], "period.start must be a valid YYYY-MM-DD local date.")
  }
  if (!endIsValid) {
    addIssue(issues, [...path, "end"], "period.end must be a valid YYYY-MM-DD local date.")
  }

  if (startIsValid && endIsValid) {
    const span = inclusiveLocalDaySpan(start, end)
    if (span < MIN_PERIOD_LOCAL_DAYS) {
      addIssue(
        issues,
        path,
        "period.start must be at or before period.end."
      )
    } else if (span > MAX_PERIOD_LOCAL_DAYS) {
      addIssue(
        issues,
        path,
        `A custom period spans at most ${MAX_PERIOD_LOCAL_DAYS} local days; this one spans ${span}.`
      )
    }
  }
}

// --- Metrics (Requirements 5.1, 5.7, 5.8) -----------------------------------

const METRIC_ITEM_ALLOWED_KEYS = new Set([
  "metric",
  "derived",
  "statistic",
  "estimator",
  "fidelity_tier",
])

function validateMetricItem(
  item: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!isPlainObject(item)) {
    addIssue(
      issues,
      path,
      "A metric selection item must be an object, not a bare string — an object " +
        "carries a percentile's estimator label and fidelity tier."
    )
    return
  }

  for (const key of Object.keys(item)) {
    if (!METRIC_ITEM_ALLOWED_KEYS.has(key)) {
      addIssue(issues, [...path, key], `Unrecognized metric selection field "${key}".`)
    }
  }

  const { metric, derived, statistic, estimator, fidelity_tier: fidelityTier } = item

  const hasMetric = metric !== undefined
  const hasDerived = derived !== undefined

  if (hasMetric && hasDerived) {
    addIssue(
      issues,
      path,
      "A metric selection item names exactly one of `metric` or `derived`, not both."
    )
  } else if (!hasMetric && !hasDerived) {
    addIssue(
      issues,
      path,
      "A metric selection item must name exactly one of `metric` or `derived`."
    )
  }

  if (hasMetric && !isNonEmptyString(metric)) {
    addIssue(issues, [...path, "metric"], "metric must be a non-empty string.")
  }
  if (hasDerived && !isNonEmptyString(derived)) {
    addIssue(issues, [...path, "derived"], "derived must be a non-empty string.")
  }

  if (!isNonEmptyString(statistic)) {
    addIssue(issues, [...path, "statistic"], "statistic must be a non-empty string.")
    return
  }

  // Requirements 5.7, 5.8 — a percentile-shaped statistic requires both an
  // estimator label and a fidelity tier; naming a percentile without them is
  // a rejection.
  if (PERCENTILE_STATISTIC_PATTERN.test(statistic)) {
    if (!isNonEmptyString(estimator)) {
      addIssue(
        issues,
        [...path, "estimator"],
        `A percentile statistic ("${statistic}") requires the catalog's estimator label.`
      )
    }
    if (!isNonEmptyString(fidelityTier)) {
      addIssue(
        issues,
        [...path, "fidelity_tier"],
        `A percentile statistic ("${statistic}") requires its fidelity tier.`
      )
    }
  } else {
    if (estimator !== undefined && !isNonEmptyString(estimator)) {
      addIssue(issues, [...path, "estimator"], "estimator must be a non-empty string when present.")
    }
    if (fidelityTier !== undefined && !isNonEmptyString(fidelityTier)) {
      addIssue(
        issues,
        [...path, "fidelity_tier"],
        "fidelity_tier must be a non-empty string when present."
      )
    }
  }
}

function validateMetrics(
  metrics: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!isPlainObject(metrics)) {
    addIssue(issues, path, "metrics must be an object keyed by resource type.")
    return
  }

  const resourceTypeKeys = Object.keys(metrics)
  if (resourceTypeKeys.length > MAX_METRIC_RESOURCE_TYPE_ENTRIES) {
    addIssue(
      issues,
      path,
      `metrics accepts at most ${MAX_METRIC_RESOURCE_TYPE_ENTRIES} resource-type entries.`
    )
  }

  for (const resourceType of resourceTypeKeys) {
    const entryPath = [...path, resourceType]
    const items = metrics[resourceType]

    if (!Array.isArray(items)) {
      addIssue(issues, entryPath, `metrics["${resourceType}"] must be an array.`)
      continue
    }

    if (
      items.length < MIN_METRIC_ITEMS_PER_ENTRY ||
      items.length > MAX_METRIC_ITEMS_PER_ENTRY
    ) {
      addIssue(
        issues,
        entryPath,
        `metrics["${resourceType}"] must name ${MIN_METRIC_ITEMS_PER_ENTRY} to ` +
          `${MAX_METRIC_ITEMS_PER_ENTRY} items.`
      )
    }

    items.forEach((item, index) => {
      validateMetricItem(item, [...entryPath, index], issues)
    })
  }
}

// --- Blocks (Requirements 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.9) -----------------

const NON_ROW_BLOCK_TYPE_SET = new Set<string>(NON_ROW_BLOCK_TYPES)
const LEAF_BLOCK_ALLOWED_KEYS = new Set(["id", "type", "config", "scope_override"])
const ROW_BLOCK_ALLOWED_KEYS = new Set(["id", "type", "columns"])

/**
 * Fields Requirement 6.6 names by name: a `rich_text` config binding a
 * metric, a statistic, a resource id, a scope or a snapshot path. Every one
 * of these is already absent from `rich_text`'s declared config schema
 * (`blocks.ts`'s `BLOCK_CONFIG.rich_text` allows only `text`), so the generic
 * unrecognized-config-field check below would catch any of them anyway —
 * this list exists purely so the rejection **names the specific rule** Req
 * 6.6 states, the same reasoning as
 * {@link FORBIDDEN_POSITIONING_FIELD_PATTERNS}.
 */
const RICH_TEXT_FORBIDDEN_BINDING_FIELDS = new Set([
  "metric",
  "statistic",
  "resource_id",
  "scope",
  "snapshot_path",
])

/**
 * Shared mutable state threaded through one recursive block walk: every
 * declared `id` (for the duplicate check, Requirement 6.7), and a running
 * count of every block visited including row children (Requirement 6.3).
 */
type BlockWalkState = {
  readonly idOccurrences: Map<string, (readonly (string | number)[])[]>
  totalBlockCount: number
}

function validateBlockConfig(
  blockType: Exclude<BlockType, "row">,
  config: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!isPlainObject(config)) {
    addIssue(issues, path, "config must be an object.")
    return
  }

  const schema = BLOCK_CONFIG[blockType]
  const allowedFieldNames = new Set<string>([
    ...schema.required,
    ...schema.optional,
    ...Object.keys(schema.enums),
  ])

  for (const fieldName of schema.required) {
    if (!(fieldName in config)) {
      addIssue(
        issues,
        [...path, fieldName],
        `"${blockType}" requires the config field "${fieldName}".`
      )
    }
  }

  for (const key of Object.keys(config)) {
    const positioningLabel = forbiddenPositioningLabel(key)
    if (positioningLabel !== null) {
      addIssue(
        issues,
        [...path, key],
        `The config field "${key}" names ${positioningLabel}. No block may carry ` +
          "an absolute position, coordinate, offset, absolute width or height, or " +
          "an explicit page assignment — Word is a reflowing paginated medium."
      )
      continue
    }

    if (blockType === "rich_text" && RICH_TEXT_FORBIDDEN_BINDING_FIELDS.has(key)) {
      addIssue(
        issues,
        [...path, key],
        `rich_text carries static prose and no figure; it may not bind "${key}".`
      )
      continue
    }

    if (!allowedFieldNames.has(key)) {
      addIssue(
        issues,
        [...path, key],
        `"${blockType}" declares no config field named "${key}".`
      )
      continue
    }

    const enumValues = (schema.enums as Readonly<Record<string, readonly string[]>>)[key]
    if (enumValues !== undefined) {
      const value = config[key]
      if (typeof value !== "string" || !enumValues.includes(value)) {
        addIssue(
          issues,
          [...path, key],
          `"${key}" must be one of: ${enumValues.join(", ")}.`
        )
      }
    }
  }
}

function validateLeafBlock(
  block: Record<string, unknown>,
  blockType: string,
  path: readonly (string | number)[],
  state: BlockWalkState,
  issues: IssueSink,
  scopeOverrideAlreadySeen: boolean
): void {
  for (const key of Object.keys(block)) {
    const positioningLabel = forbiddenPositioningLabel(key)
    if (positioningLabel !== null) {
      addIssue(
        issues,
        [...path, key],
        `The block field "${key}" names ${positioningLabel}. No block may carry ` +
          "an absolute position, coordinate, offset, absolute width or height, or " +
          "an explicit page assignment — Word is a reflowing paginated medium."
      )
      continue
    }
    if (!LEAF_BLOCK_ALLOWED_KEYS.has(key)) {
      addIssue(issues, [...path, key], `Unrecognized block field "${key}".`)
    }
  }

  if (!NON_ROW_BLOCK_TYPE_SET.has(blockType)) {
    addIssue(
      issues,
      [...path, "type"],
      `"${blockType}" is not a declared block type. Declared types are: ` +
        `${BLOCK_TYPES.join(", ")}.`
    )
    // No declared config schema exists for an unknown type — still validate
    // `config`'s basic shape (object-ness) so a caller sees that issue too,
    // but skip the field-name/enum checks that need `BLOCK_CONFIG[type]`.
    if (block.config !== undefined && !isPlainObject(block.config)) {
      addIssue(issues, [...path, "config"], "config must be an object.")
    }
  } else {
    validateBlockConfig(
      blockType as Exclude<BlockType, "row">,
      block.config,
      [...path, "config"],
      issues
    )
  }

  if (block.scope_override !== undefined) {
    // Requirement 3.2 — the JSON shape admits only one `scope_override` key
    // per block, so "more than one override on a block" is structurally
    // impossible to express; `scopeOverrideAlreadySeen` exists only in case
    // a future caller passes an object with a duplicate key collapsed by
    // `JSON.parse` (which itself keeps only the last occurrence) — there is
    // nothing further to check here, but the parameter documents that this
    // was considered rather than silently assumed.
    void scopeOverrideAlreadySeen
    validateScopeSpec(block.scope_override, [...path, "scope_override"], issues)
  }
}

/**
 * Validates one block at `path` and recurses into a `row`'s children.
 *
 * `insideRow` is `true` only for a direct child of a `row`'s column — Word's
 * one-level-of-nesting rule (Requirement 6.4) means a grandchild can never
 * be reached through a valid tree, but this function is written to detect a
 * `row`-typed block at *any* depth regardless, because the input is
 * untrusted `unknown` and a caller cannot assume the shape already holds.
 */
function validateBlock(
  block: unknown,
  path: readonly (string | number)[],
  state: BlockWalkState,
  issues: IssueSink,
  insideRow: boolean
): void {
  state.totalBlockCount += 1

  if (!isPlainObject(block)) {
    addIssue(issues, path, "A block must be an object.")
    return
  }

  const { id } = block
  if (isNonEmptyString(id) && stringLengthInRange(id, BLOCK_ID_MIN_LENGTH, BLOCK_ID_MAX_LENGTH)) {
    const occurrences = state.idOccurrences.get(id) ?? []
    if (occurrences.length > 0) {
      addIssue(
        issues,
        [...path, "id"],
        `Duplicate block id "${id}" — a block id must be unique across the whole ` +
          "definition, counting every row's children."
      )
    }
    occurrences.push(path)
    state.idOccurrences.set(id, occurrences)
  } else {
    addIssue(
      issues,
      [...path, "id"],
      `A block id must be a string of ${BLOCK_ID_MIN_LENGTH} to ${BLOCK_ID_MAX_LENGTH} characters.`
    )
  }

  const { type } = block
  if (typeof type !== "string") {
    addIssue(issues, [...path, "type"], "A block's type must be a string.")
    return
  }

  if (type === "row") {
    if (insideRow) {
      addIssue(
        issues,
        [...path, "type"],
        `Block "${typeof id === "string" ? id : String(path[path.length - 1])}" is a ` +
          "row nested inside a row. One level of nesting only — a row's columns " +
          "hold no row."
      )
    }
    validateRowBlock(block, path, state, issues)
    return
  }

  validateLeafBlock(block, type, path, state, issues, false)
}

function validateRowBlock(
  block: Record<string, unknown>,
  path: readonly (string | number)[],
  state: BlockWalkState,
  issues: IssueSink
): void {
  for (const key of Object.keys(block)) {
    if (!ROW_BLOCK_ALLOWED_KEYS.has(key)) {
      addIssue(issues, [...path, key], `Unrecognized row field "${key}".`)
    }
  }

  const { columns } = block
  if (!Array.isArray(columns)) {
    addIssue(issues, [...path, "columns"], "A row's columns must be an array of arrays.")
    return
  }

  if (columns.length < MIN_ROW_COLUMNS || columns.length > MAX_ROW_COLUMNS) {
    addIssue(
      issues,
      [...path, "columns"],
      `A row must declare ${MIN_ROW_COLUMNS} or ${MAX_ROW_COLUMNS} columns; found ${columns.length}.`
    )
  }

  columns.forEach((column, columnIndex) => {
    const columnPath = [...path, "columns", columnIndex]
    if (!Array.isArray(column)) {
      addIssue(issues, columnPath, "Each column must be an array of blocks.")
      return
    }
    if (column.length > MAX_CHILDREN_PER_COLUMN) {
      addIssue(
        issues,
        columnPath,
        `A column accepts at most ${MAX_CHILDREN_PER_COLUMN} children; found ${column.length}.`
      )
    }
    column.forEach((child, childIndex) => {
      validateBlock(child, [...columnPath, childIndex], state, issues, true)
    })
  })
}

function validateBlocks(
  blocks: unknown,
  path: readonly (string | number)[],
  issues: IssueSink,
  mode: "draft" | "run"
): void {
  if (!Array.isArray(blocks)) {
    addIssue(issues, path, "blocks must be an array.")
    return
  }

  if (mode === "run" && blocks.length === 0) {
    addIssue(
      issues,
      path,
      "A report run needs at least one block; this definition carries zero. " +
        "(A definition with zero blocks is a valid draft, but not a runnable version.)"
    )
  }

  const state: BlockWalkState = { idOccurrences: new Map(), totalBlockCount: 0 }

  blocks.forEach((block, index) => {
    validateBlock(block, [...path, index], state, issues, false)
  })

  if (state.totalBlockCount > MAX_BLOCKS_TOTAL) {
    addIssue(
      issues,
      path,
      `A definition accepts at most ${MAX_BLOCKS_TOTAL} blocks, counting rows and their ` +
        `children; this one carries ${state.totalBlockCount}.`
    )
  }
}

// --- Design (Requirements 7.1, 7.2) -----------------------------------------

const DESIGN_ALLOWED_KEYS = new Set([
  "preset",
  "accent_color",
  "density",
  "table_style",
  "number_format",
  "cover_page",
  "logo",
  "page_size",
])

function validateNumberFormat(
  value: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!isPlainObject(value)) {
    addIssue(issues, path, "number_format must be an object.")
    return
  }

  const allowedKeys = new Set(["decimal_places", "group_thousands"])
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addIssue(issues, [...path, key], `Unrecognized number_format field "${key}".`)
    }
  }

  const { decimal_places: decimalPlaces, group_thousands: groupThousands } = value

  if (
    !isFiniteInteger(decimalPlaces) ||
    decimalPlaces < MIN_DECIMAL_PLACES ||
    decimalPlaces > MAX_DECIMAL_PLACES
  ) {
    addIssue(
      issues,
      [...path, "decimal_places"],
      `decimal_places must be an integer from ${MIN_DECIMAL_PLACES} to ${MAX_DECIMAL_PLACES}.`
    )
  }

  if (!isBoolean(groupThousands)) {
    addIssue(issues, [...path, "group_thousands"], "group_thousands must be a boolean.")
  }
}

function validateDesign(
  design: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!isPlainObject(design)) {
    addIssue(issues, path, "design must be an object.")
    return
  }

  for (const key of Object.keys(design)) {
    if (!DESIGN_ALLOWED_KEYS.has(key)) {
      addIssue(issues, [...path, key], `Unrecognized design field "${key}".`)
    }
  }

  const {
    preset,
    accent_color: accentColor,
    density,
    table_style: tableStyle,
    number_format: numberFormat,
    cover_page: coverPage,
    logo,
    page_size: pageSize,
  } = design

  if (typeof preset !== "string" || !DESIGN_PRESETS.includes(preset as DesignPreset)) {
    addIssue(issues, [...path, "preset"], `preset must be one of: ${DESIGN_PRESETS.join(", ")}.`)
  }

  if (
    !isNonEmptyString(accentColor) ||
    accentColor.length > ACCENT_COLOR_MAX_LENGTH
  ) {
    addIssue(
      issues,
      [...path, "accent_color"],
      `accent_color must be a non-empty string of at most ${ACCENT_COLOR_MAX_LENGTH} characters.`
    )
  }

  if (typeof density !== "string" || !DENSITY_VALUES.includes(density as Density)) {
    addIssue(issues, [...path, "density"], `density must be one of: ${DENSITY_VALUES.join(", ")}.`)
  }

  if (
    typeof tableStyle !== "string" ||
    !TABLE_STYLE_VALUES.includes(tableStyle as TableStyle)
  ) {
    addIssue(
      issues,
      [...path, "table_style"],
      `table_style must be one of: ${TABLE_STYLE_VALUES.join(", ")}.`
    )
  }

  validateNumberFormat(numberFormat, [...path, "number_format"], issues)

  if (!isBoolean(coverPage)) {
    addIssue(issues, [...path, "cover_page"], "cover_page must be a boolean.")
  }

  if (logo !== undefined && logo !== null) {
    if (typeof logo !== "string" || logo.length > LOGO_MAX_LENGTH) {
      addIssue(
        issues,
        [...path, "logo"],
        `logo must be null or a string of at most ${LOGO_MAX_LENGTH} characters.`
      )
    }
  }

  if (typeof pageSize !== "string" || !PAGE_SIZE_VALUES.includes(pageSize as PageSize)) {
    addIssue(issues, [...path, "page_size"], `page_size must be one of: ${PAGE_SIZE_VALUES.join(", ")}.`)
  }
}

// --- Top level (Requirements 2.1, 2.2, 2.4, 2.9, 2.10) ----------------------

const TOP_LEVEL_REQUIRED_KEYS = [
  "schema_version",
  "identity",
  "scope",
  "period",
  "metrics",
  "blocks",
  "design",
] as const

function validateSchemaVersion(value: unknown, issues: IssueSink): void {
  if (!isFiniteInteger(value)) {
    addIssue(issues, ["schema_version"], "schema_version must be an integer.")
    return
  }
  if (value < MIN_SCHEMA_VERSION || value > MAX_SUPPORTED_SCHEMA_VERSION) {
    addIssue(
      issues,
      ["schema_version"],
      `schema_version must be between ${MIN_SCHEMA_VERSION} and ${MAX_SUPPORTED_SCHEMA_VERSION} ` +
        `(highest supported); found ${value}.`
    )
  }
}

/**
 * Validates the canonical byte-size bound (Requirement 2.10), against the
 * exact same canonicalization {@link canonicalJsonByteLength} exposes to
 * `lib/templates/version.ts`.
 *
 * Wrapped defensively: `raw` at this point has already been walked by every
 * other check above, so a value this canonicalizer cannot represent (a
 * function, a `bigint`, `NaN`) would already have produced a type-mismatch
 * issue somewhere else in the walk. This check simply declines to add a
 * second, less informative issue about the same root cause.
 */
function validateCanonicalByteSize(raw: unknown, issues: IssueSink): void {
  try {
    const bytes = canonicalJsonByteLength(raw as CanonicalizableValue)
    if (bytes > MAX_DEFINITION_CANONICAL_BYTES) {
      addIssue(
        issues,
        [],
        `The definition's RFC 8785 canonical form is ${bytes} bytes, exceeding the ` +
          `${MAX_DEFINITION_CANONICAL_BYTES}-byte bound.`
      )
    }
  } catch {
    // Already reported elsewhere as a type-mismatch issue on the offending field.
  }
}

// --- Requirement 5.9: every scoped resource type carries a selection --------

/**
 * One resource type named by a scope, with the field path that named it.
 */
type ScopedType = {
  readonly path: readonly (string | number)[]
  readonly resourceType: string
}

/**
 * Requirement 5.9 — a resource type a scope can contain, with no metric
 * selected for it.
 *
 * A **cross-field** check on the definition alone: every resource type named
 * in the template default `scope` or in any block `scope_override` needs an
 * entry in `metrics`. No catalog, no snapshot, no subscription — which is why
 * it lives here, in the shape walk where Requirement 2.6's both-halves-agree
 * guarantee applies for free, rather than in
 * {@link validateMetricSelectionAgainstCatalog}, which is app-only and
 * catalog-dependent.
 *
 * Mirrors `_validate_every_scoped_type_is_selected` in
 * `agent/src/reporting_agent/compile/definition.py`, path for path.
 *
 * **Compared case-insensitively** (Requirement 3.12). Azure resource type
 * names are case-insensitive and Resource Graph lowercases `type` in its
 * response body, so a `metrics` key of `microsoft.compute/virtualmachines`
 * selects for a scope naming `Microsoft.Compute/virtualMachines`. An exact
 * comparison would reject a correct definition — and specifically the one any
 * inventory-seeded wizard affordance produces.
 *
 * ## Only in `run` mode, which is the requirement rather than a relaxation
 *
 * Requirement 5.9 rejects a save that **persists a version row**. A draft
 * persists none — it is written to `report_templates.draft_definition` — and
 * the wizard reaches scope (step 2) two steps before metrics (step 4), so
 * enforcing this against a draft would refuse to save the ordinary
 * half-authored template between those two steps. Publishing is where the
 * definition has to be complete, and that is `run` mode: the same mode that
 * rejects zero blocks, for the same reason.
 *
 * ## What no validator can see
 *
 * A scope naming **no** resource types is unconstrained (Requirement 3.1
 * permits zero, 3.12 makes an empty dimension match everything), so which
 * types it can contain is a fact about the subscription rather than about the
 * definition. That case is recorded at collection time as a
 * `metric_not_selected` gap instead — never a `TEMPLATE_INVALID`, because a
 * subscription-agnostic template (Requirement 1) meeting a type it did not
 * select is an ordinary pairing rather than a broken template.
 */
function validateEveryScopedTypeIsSelected(
  raw: Record<string, unknown>,
  issues: IssueSink,
  mode: "draft" | "run"
): void {
  if (mode !== "run") return

  const { metrics } = raw
  if (!isPlainObject(metrics)) {
    // Its shape is already an issue; a second one derived from it would be noise.
    return
  }

  const selected = new Set(
    Object.keys(metrics).map((resourceType) => resourceType.toLowerCase())
  )

  for (const { path, resourceType } of scopedResourceTypes(raw)) {
    if (selected.has(resourceType.toLowerCase())) continue
    addIssue(
      issues,
      path,
      `No metric or derived statistic is selected for "${resourceType}", which this ` +
        `scope can contain. Every resource type a scope names needs an entry in ` +
        `\`metrics\`, or the report would collect nothing for it.`
    )
  }
}

/**
 * Every resource type named by a scope, with its field path.
 *
 * Reads defensively at every level and contributes nothing for a malformed
 * scope: the shape validators above have already reported it, and inventing a
 * resource type out of a non-string would report a second issue about the
 * first one's symptom.
 */
function scopedResourceTypes(raw: Record<string, unknown>): ScopedType[] {
  const found: ScopedType[] = []

  const addScope = (scope: unknown, path: readonly (string | number)[]): void => {
    if (!isPlainObject(scope)) return
    const types = scope.resource_types
    if (!Array.isArray(types)) return
    types.forEach((entry, index) => {
      if (isNonEmptyString(entry)) {
        found.push({ path: [...path, "resource_types", index], resourceType: entry })
      }
    })
  }

  const walkBlocks = (blocks: unknown, path: readonly (string | number)[]): void => {
    if (!Array.isArray(blocks)) return
    blocks.forEach((block, index) => {
      if (!isPlainObject(block)) return
      const blockPath = [...path, index]
      if ("scope_override" in block) {
        addScope(block.scope_override, [...blockPath, "scope_override"])
      }
      const { columns } = block
      if (Array.isArray(columns)) {
        columns.forEach((column, columnIndex) => {
          walkBlocks(column, [...blockPath, "columns", columnIndex])
        })
      }
    })
  }

  addScope(raw.scope, ["scope"])
  walkBlocks(raw.blocks, ["blocks"])
  return found
}

/**
 * The full validation walk over an `unknown` candidate, in one pass
 * (Requirements 2.7, 6.11).
 *
 * `mode: "run"` additionally rejects a definition carrying zero blocks
 * (Requirement 6.8) — a draft save accepts one, since a template under
 * construction may not have reached the block-composition step yet.
 *
 * Exported directly so a caller that wants the raw issue list — for example
 * to layer {@link validateMetricSelectionAgainstCatalog}'s results onto the
 * same array, or to render every failing field path without going through
 * zod's `SafeParseError` shape — does not have to reconstruct it from
 * `error.issues`.
 */
export function collectDefinitionIssues(
  raw: unknown,
  options: { readonly mode?: "draft" | "run" } = {}
): FieldIssue[] {
  const issues: IssueSink = []
  const mode = options.mode ?? "draft"

  if (!isPlainObject(raw)) {
    addIssue(issues, [], "A template definition must be an object.")
    return issues
  }

  for (const key of TOP_LEVEL_REQUIRED_KEYS) {
    if (!(key in raw)) {
      addIssue(issues, [key], `Missing required top-level key "${key}".`)
    }
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_REQUIRED_KEYS.includes(key as (typeof TOP_LEVEL_REQUIRED_KEYS)[number])) {
      addIssue(issues, [key], `Unrecognized top-level key "${key}".`)
    }
  }

  validateSchemaVersion(raw.schema_version, issues)
  validateIdentity(raw.identity, ["identity"], issues)
  validateScopeSpec(raw.scope, ["scope"], issues)
  validatePeriod(raw.period, ["period"], issues)
  validateMetrics(raw.metrics, ["metrics"], issues)
  validateBlocks(raw.blocks, ["blocks"], issues, mode)
  validateDesign(raw.design, ["design"], issues)
  validateCanonicalByteSize(raw, issues)
  validateEveryScopedTypeIsSelected(raw, issues, mode)

  return issues
}

// --- The exported zod schemas -----------------------------------------------

/**
 * The `Template_Validator`, as a zod schema (Requirements 2.1 through 2.10,
 * and every requirement this module's docstring cites).
 *
 * `z.unknown().superRefine(...)` rather than `z.custom(...)`: `z.custom`'s
 * validator function receives only the value, not a `$RefinementCtx` — it
 * reports validity through a single truthy/falsy return (or a thrown
 * message), which cannot add more than one issue per call. `superRefine` is
 * the zod v4 primitive whose callback receives `ctx.addIssue(...)`, called
 * once per collected {@link FieldIssue} here, and — verified empirically,
 * see the module docstring — a `superRefine` attached directly to
 * `z.unknown()` (a schema with no structural check of its own to abort on)
 * always runs to completion regardless of what the walk finds.
 *
 * Accepts a definition carrying **zero blocks** as a valid draft
 * (Requirement 6.8). Use {@link templateDefinitionForRunSchema} at the point
 * a definition is about to be pinned to a run, where zero blocks is a
 * rejection.
 */
export const templateDefinitionSchema: z.ZodType<TemplateDefinition> = z
  .unknown()
  .superRefine((raw, ctx) => {
    for (const issue of collectDefinitionIssues(raw, { mode: "draft" })) {
      ctx.addIssue({ code: "custom", message: issue.message, path: [...issue.path] })
    }
  }) as unknown as z.ZodType<TemplateDefinition>

/**
 * The same validator, additionally rejecting a definition with zero blocks
 * (Requirement 6.8) — the check a run enqueue or a "publish this version"
 * action runs, as distinct from the draft-save path.
 */
export const templateDefinitionForRunSchema: z.ZodType<TemplateDefinition> = z
  .unknown()
  .superRefine((raw, ctx) => {
    for (const issue of collectDefinitionIssues(raw, { mode: "run" })) {
      ctx.addIssue({ code: "custom", message: issue.message, path: [...issue.path] })
    }
  }) as unknown as z.ZodType<TemplateDefinition>

// --- Metric_Catalog-dependent validation (Requirements 5.2, 5.3, 5.5, 5.9) --

/**
 * The minimal shape a Metric_Catalog snapshot must expose for
 * {@link validateMetricSelectionAgainstCatalog} — modelled on
 * `agent/src/reporting_agent/catalog/loader.py`'s `LoadedCatalog` /
 * `ResourceTypeCatalog` so a future `lib/templates/catalog.ts` (task 13.1 or
 * earlier) has an obvious target shape to produce from
 * `GET /api/templates/catalog` rather than inventing its own.
 *
 * Keyed by resource type (matched case-insensitively by the caller, the same
 * way `LoadedCatalog.for_resource_type` matches — Azure resource type names
 * are case-insensitive and Resource Graph lowercases them).
 */
export type MetricCatalogEntry = {
  /** A platform metric name (`kind: "metric"`) or a derived statistic id (`kind: "derived"`). */
  readonly kind: "metric" | "derived"
  readonly name: string
  /** Every statistic this entry declares, including any percentile keys (e.g. `"p95"`). */
  readonly statistics: readonly string[]
  /** For each percentile statistic this entry declares, its estimator label and fidelity tier. */
  readonly percentiles: Readonly<Record<string, { readonly estimator: string; readonly fidelityTier: string }>>
  /**
   * For `kind: "derived"` only — every source metric name and every SKU
   * capability name the formula consumes (Requirement 5.5). Absent for
   * `kind: "metric"`.
   */
  readonly requiredSourceMetrics?: readonly string[]
  readonly requiredSkuCapabilities?: readonly string[]
}

export type MetricCatalogResourceType = {
  readonly resourceType: string
  readonly entries: readonly MetricCatalogEntry[]
  /** Every SKU capability the catalog declares as available for this resource type. */
  readonly declaredSkuCapabilities: readonly string[]
}

export type MetricCatalogSnapshot = readonly MetricCatalogResourceType[]

function findCatalogResourceType(
  catalog: MetricCatalogSnapshot,
  resourceType: string
): MetricCatalogResourceType | undefined {
  const folded = resourceType.toLowerCase()
  return catalog.find((entry) => entry.resourceType.toLowerCase() === folded)
}

function findCatalogEntry(
  resourceTypeCatalog: MetricCatalogResourceType,
  item: MetricSelectionItem
): MetricCatalogEntry | undefined {
  if (item.metric !== undefined) {
    return resourceTypeCatalog.entries.find(
      (entry) => entry.kind === "metric" && entry.name === item.metric
    )
  }
  if (item.derived !== undefined) {
    return resourceTypeCatalog.entries.find(
      (entry) => entry.kind === "derived" && entry.name === item.derived
    )
  }
  return undefined
}

/**
 * Catalog-membership checks over an already-shape-valid definition
 * (Requirements 5.2, 5.3, 5.5, 5.9). **Not run automatically by
 * {@link templateDefinitionSchema}** — see the module docstring's "Layering"
 * section for why. Call this only after
 * {@link templateDefinitionSchema}`.safeParse` (or
 * {@link collectDefinitionIssues}) has already succeeded, since this
 * function assumes the shape it walks is well-formed and does not repeat
 * the structural checks above.
 *
 * Checks:
 * - every metric-selection item names a metric or derived statistic the
 *   catalog declares for that resource type (5.2);
 * - a block's config referencing a metric or statistic absent from that
 *   definition's own metric selection for a resource type its scope can
 *   contain (5.3) — **not implemented here**, because it requires resolving
 *   a block's resolved scope against a snapshot's resource types, which is
 *   `compile/scope.py` / `Scope_Resolver` territory (task 5.7) rather than a
 *   catalog lookup; left as a documented gap for that later composition
 *   point rather than approximated here;
 * - a derived statistic's every declared source metric and SKU capability is
 *   present — for the source metric, in this same resource type's own
 *   metric selection; for the SKU capability, in the catalog's own declared
 *   set for that resource type (5.5);
 * - a metric selection naming a resource type the catalog has no entry for
 *   at all (5.9's "contains no metric ... for a resource type the scope can
 *   contain" is the *opposite* direction — a scoped resource type with *no*
 *   selection — which again needs scope resolution and is left to the same
 *   later composition point as 5.3).
 */
export function validateMetricSelectionAgainstCatalog(
  definition: TemplateDefinition,
  catalog: MetricCatalogSnapshot
): FieldIssue[] {
  const issues: IssueSink = []

  for (const [resourceType, items] of Object.entries(definition.metrics)) {
    const resourceTypeCatalog = findCatalogResourceType(catalog, resourceType)
    const basePath: readonly (string | number)[] = ["metrics", resourceType]

    if (resourceTypeCatalog === undefined) {
      addIssue(
        issues,
        basePath,
        `The Metric_Catalog declares no entries for resource type "${resourceType}".`
      )
      continue
    }

    items.forEach((item, index) => {
      const itemPath = [...basePath, index]
      const catalogEntry = findCatalogEntry(resourceTypeCatalog, item)

      if (catalogEntry === undefined) {
        const name = item.metric ?? item.derived ?? "<unnamed>"
        addIssue(
          issues,
          itemPath,
          `The Metric_Catalog declares no "${name}" ${item.metric !== undefined ? "metric" : "derived statistic"} ` +
            `for resource type "${resourceType}".`
        )
        return
      }

      if (!catalogEntry.statistics.includes(item.statistic)) {
        addIssue(
          issues,
          [...itemPath, "statistic"],
          `The Metric_Catalog declares no "${item.statistic}" statistic for "${catalogEntry.name}" ` +
            `on resource type "${resourceType}".`
        )
      }

      const percentileDeclaration = catalogEntry.percentiles[item.statistic]
      if (percentileDeclaration !== undefined) {
        if (item.estimator !== percentileDeclaration.estimator) {
          addIssue(
            issues,
            [...itemPath, "estimator"],
            `The Metric_Catalog declares estimator "${percentileDeclaration.estimator}" for ` +
              `"${item.statistic}" on "${catalogEntry.name}"; this entry carries a different value.`
          )
        }
        if (item.fidelity_tier !== percentileDeclaration.fidelityTier) {
          addIssue(
            issues,
            [...itemPath, "fidelity_tier"],
            `The Metric_Catalog declares fidelity tier "${percentileDeclaration.fidelityTier}" for ` +
              `"${item.statistic}" on "${catalogEntry.name}"; this entry carries a different value.`
          )
        }
      }

      if (catalogEntry.kind === "derived") {
        const selectedMetricNames = new Set(
          items.filter((other) => other.metric !== undefined).map((other) => other.metric)
        )

        for (const sourceMetric of catalogEntry.requiredSourceMetrics ?? []) {
          if (!selectedMetricNames.has(sourceMetric)) {
            addIssue(
              issues,
              itemPath,
              `Derived statistic "${catalogEntry.name}" requires the source metric ` +
                `"${sourceMetric}" to also be selected for resource type "${resourceType}".`
            )
          }
        }

        for (const skuCapability of catalogEntry.requiredSkuCapabilities ?? []) {
          if (!resourceTypeCatalog.declaredSkuCapabilities.includes(skuCapability)) {
            addIssue(
              issues,
              itemPath,
              `Derived statistic "${catalogEntry.name}" requires the SKU capability ` +
                `"${skuCapability}", which the Metric_Catalog does not declare for resource ` +
                `type "${resourceType}".`
            )
          }
        }
      }
    })
  }

  return issues
}
