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

import {
  BLOCK_CONFIG,
  BLOCK_TYPES,
  type BlockType,
} from "@/lib/templates/blocks"
import rawSectionsCatalogue from "../../../agent/src/reporting_agent/catalog/sections.v1.json"
import {
  canonicalJsonByteLength,
  type CanonicalizableValue,
} from "@/lib/templates/canonical-json"
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

/**
 * Requirement 12.2 — `identity.customer_name` at v3. Matches
 * `MAX_CUSTOMER_NAME_LENGTH` in `lib/runs/input.ts`, the bound the run form
 * validated the same field against before it moved onto the profile —
 * keeping the number identical is what makes the move invisible to a value
 * that already fit.
 */
export const CUSTOMER_NAME_MAX_LENGTH = 200

// --- BEGIN SCHEMA VERSIONS (mirrored in agent/src/reporting_agent/compile/definition.py) ---
/**
 * Requirement 2.9, 13.10 — `MIN_SCHEMA_VERSION` stays `1`, and `2` is the highest this
 * reader accepts. What raises the version is exactly three things: `front_matter`,
 * `identity.language`, and the two `number_format` separators.
 */
export const MIN_SCHEMA_VERSION = 1
export const MAX_SUPPORTED_SCHEMA_VERSION = 3

/**
 * The version-conditional key sets, **declared as data rather than as two validators**.
 *
 * `collectDefinitionIssues` reads the record for the resolved version, so no branch is
 * written twice and the Mirror_Guard stays a set comparison with no parser on either side.
 * Two validators would be two places for a key to be admitted at one version and not the
 * other, and the divergence would present as a definition the wizard saves and the compiler
 * refuses — minutes into a run, after the collection has been spent.
 *
 * Three behaviours follow from these tables with no rule anybody writes:
 *
 * - a v1 definition carrying `front_matter` is rejected as an **undeclared top-level key**
 *   by the existing strict check, because it is absent from version 1's list;
 * - a v1 definition carrying `identity.language` is rejected the same way, one level down;
 * - a v1 definition carrying either separator is rejected as an unrecognized
 *   `number_format` field.
 *
 * Requirement 13.13 makes `front_matter` **required** at version 2, not merely permitted, so
 * it belongs in this list rather than in a separate optional set — the same reasoning
 * `validateScopeSpec` records for requiring presence over defaulting: one shape, never a
 * shape plus a set of implicit defaults a second reader has to reproduce exactly.
 */
export const REQUIRED_TOP_LEVEL_KEYS = {
  1: [
    "schema_version",
    "identity",
    "scope",
    "period",
    "metrics",
    "blocks",
    "design",
  ],
  2: [
    "schema_version",
    "identity",
    "scope",
    "period",
    "metrics",
    "blocks",
    "design",
    "front_matter",
  ],
  3: [
    "schema_version",
    "identity",
    "provider",
    "sections",
    "period",
    "design",
    "front_matter",
  ],
} as const

/** Requirement 16.1 — two keys at v1, four at v2+. */
export const NUMBER_FORMAT_KEYS = {
  1: ["decimal_places", "group_thousands"],
  2: [
    "decimal_places",
    "group_thousands",
    "decimal_separator",
    "grouping_separator",
  ],
  3: [
    "decimal_places",
    "group_thousands",
    "decimal_separator",
    "grouping_separator",
  ],
} as const

/** Requirement 15.1 — `identity.language` exists at v2+ and nowhere else. */
export const IDENTITY_KEYS = {
  1: ["name", "description", "report_title"],
  2: ["name", "description", "report_title", "language"],
  // Requirement 12.2 — `customer_name` moves from a run-time form field onto
  // the profile at v3, additive alongside `report_title` (its nearest
  // existing analog: both are per-document identity strings, and
  // Requirement 12.1 lists them side by side in the wizard's own collection
  // order). `report_pipeline.py::_resolve_run_facts` still reads
  // `payload.get("customer_name")` unchanged — the value now travels from
  // the pinned version instead of the run form, but the wire key and the
  // store-to-send mirror guard's mechanism are untouched (task 4.4).
  3: ["name", "description", "report_title", "language", "customer_name"],
} as const

export const REQUIRED_IDENTITY_KEYS = {
  1: ["name"],
  2: ["name", "language"],
  // `customer_name` is deliberately NOT required here even though every v3
  // run needs one to reach `_resolve_run_facts` successfully: the wizard's
  // draft mode must allow an author to save a profile before naming a
  // customer, exactly as `report_title` is optional at every version despite
  // being needed by the time a document renders. The **run-time** gate
  // belongs to `enqueueRun` (the same place that already gates a v2
  // template's front-matter completeness), not to draft-mode validation.
  3: ["name", "language"],
} as const

/**
 * Requirement 15.1 — the two declared languages, matched **case-sensitively**. `EN` is not a
 * spelling of `en`: the value keys a message catalog whose ids are lowercase ASCII by pattern,
 * and admitting a second spelling would mean a template could pin a language the resolver
 * cannot find while looking valid.
 */
export const LANGUAGES = ["en", "id"] as const

/** Requirement 13.1 — the three sections of the front matter. */
export const FRONT_MATTER_KEYS = ["cover", "document_control", "toc"] as const

/**
 * Requirement 13.2 — block types the front matter owns at v2 and above, so they may not also
 * appear in `blocks`.
 *
 * Only `cover`. `document_control` and `toc` are **not block types and never were**, so there
 * is nothing to forbid for them — a definition naming either in `blocks` is already rejected
 * as an undeclared block type.
 *
 * `cover` **stays** in `BLOCK_TYPES` rather than being removed, because Requirement 13.11
 * requires a stored v1 definition carrying one to keep compiling, and `lib/templates/
 * starters.ts` carries one per starter template. Removing the type would invalidate every
 * stored v1 definition, which is precisely the immutable-row rewrite this whole section
 * exists to avoid.
 */
export const FRONT_MATTER_FORBIDDEN_BLOCK_TYPES = ["cover"] as const

/**
 * Requirement 3.4 — the closed set of providers. Only `azure` is accepted until
 * a catalogue and collector exist for the others; `aws` and `onprem` are declared
 * but rejected by the validator.
 */
export const PROVIDERS = ["azure", "aws", "onprem"] as const

/**
 * The single provider this reader has a section catalogue for. Everything else in
 * `PROVIDERS` is rejected until a catalogue is shipped.
 */
export const SUPPORTED_PROVIDERS = ["azure"] as const

/**
 * Requirement 7.8 — the closed presentation set for a section entry.
 */
export const SECTION_PRESENTATIONS = [
  "chart_and_table",
  "chart_only",
  "table_only",
] as const

/**
 * Section id bounds — 1 to 64 characters, the same as `BLOCK_ID_MIN_LENGTH` /
 * `BLOCK_ID_MAX_LENGTH` (they will share anchors), deliberately the same limits.
 */
export const SECTION_ID_MIN_LENGTH = 1
export const SECTION_ID_MAX_LENGTH = 64

/** Maximum sections a v3 definition may carry. */
export const MAX_SECTIONS = 200

/**
 * Section catalogue keys by provider, derived from `catalog/sections.v1.json` at
 * build time. Used by the validator to reject an unknown `type`. One file, both
 * halves — the Python half reads the same JSON in `catalog/loader.py`.
 */
export const SECTION_KEYS_BY_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  azure: (
    rawSectionsCatalogue as { providers: { azure: { sections: { key: string }[] } } }
  ).providers.azure.sections.map((s) => s.key),
}

/**
 * Non-repeatable section keys by provider (for duplicate-type rejection).
 */
/**
 * Each azure section's declared resource types, by section key.
 *
 * Read by the catalogue pass to know which types a section's metrics are checked
 * against when the section itself declares no narrowing.
 */
export const SECTION_RESOURCE_TYPES_BY_KEY: Readonly<
  Record<string, readonly string[]>
> = Object.fromEntries(
  (
    rawSectionsCatalogue as {
      providers: {
        azure: { sections: { key: string; needs_resource_types?: string[] }[] }
      }
    }
  ).providers.azure.sections.map((s) => [s.key, s.needs_resource_types ?? []])
)

export const NON_REPEATABLE_SECTION_KEYS_BY_PROVIDER: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  azure: new Set(
    (
      rawSectionsCatalogue as {
        providers: { azure: { sections: { key: string; repeatable: boolean }[] } }
      }
    ).providers.azure.sections
      .filter((s) => !s.repeatable)
      .map((s) => s.key)
  ),
}

/**
 * Fixed-position section keys by provider, in declared order.
 */
export const FIXED_SECTION_KEYS_BY_PROVIDER: Readonly<
  Record<string, readonly string[]>
> = {
  azure: (
    rawSectionsCatalogue as {
      providers: {
        azure: { sections: { key: string; position: string }[] }
      }
    }
  ).providers.azure.sections
    .filter((s) => s.position === "fixed")
    .map((s) => s.key),
}

/**
 * Always-position section key by provider (at most one).
 */
export const ALWAYS_SECTION_KEY_BY_PROVIDER: Readonly<
  Record<string, string | undefined>
> = {
  azure: (
    rawSectionsCatalogue as {
      providers: {
        azure: { sections: { key: string; position: string }[] }
      }
    }
  ).providers.azure.sections.find((s) => s.position === "always")?.key,
}
// --- END SCHEMA VERSIONS ---

/** A `schema_version` this reader has a key set for. */
export type SchemaVersion = keyof typeof REQUIRED_TOP_LEVEL_KEYS

/**
 * Requirement 16.3 — the separators each language implies when the definition declares none.
 *
 * Applied at **validation** time only to decide whether the resolved pair is legal, and at
 * **format** time to decide what a figure looks like. Never written back into the definition:
 * a declared value is persisted unchanged, and an undeclared one stays undeclared, so a
 * stored v1 row is never rewritten and a v1 definition renders byte-identically to the way it
 * always did (Requirement 16.10).
 */
export const SEPARATOR_DEFAULTS = {
  en: { decimal_separator: ".", grouping_separator: "," },
  id: { decimal_separator: ",", grouping_separator: "." },
} as const satisfies Record<
  (typeof LANGUAGES)[number],
  { readonly decimal_separator: string; readonly grouping_separator: string }
>

/**
 * A separator character the verifier could not tell from the number around it, or from the
 * other separator (Requirement 16.2). Returns the reason, or `null` if the character is legal.
 *
 * Mirrors `compile/format.NumberFormat.__post_init__` clause for clause, with one deliberate
 * asymmetry: that constructor accepts a **non-empty** string of any length, and this rejects
 * anything but exactly one code point. The asymmetry errs the safe way — the app refuses a
 * two-character separator the agent would have accepted, so it never reaches a run — which is
 * the same direction the Python side records for `\ufeff`.
 *
 * The whitespace class is `/[\s\x1c-\x1f\x85]/u` and **not** bare `/\s/u`, and that is not
 * fussiness: `str.isspace()` is true for `\x1c`-`\x1f` and `\x85`, which JavaScript's `\s`
 * misses. Bare `\s` would let the app save a separator the compiler then refuses — a save-time
 * error turned into a failed run, which is the exact divergence the mirror exists to prevent.
 *
 * Why whitespace at all: `verify/tokens.numeric_tokens` splits a paragraph on whitespace, so a
 * whitespace-separated numeral reaches the verifier as several tokens none of which equals the
 * ledger's formatted string, and `normalize_pdf_text` collapses every whitespace run to one
 * space — so neither pass can locate it, and the run is withheld for a number that was right.
 */
function separatorProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "must be a non-empty string"
  }
  // Code points, not UTF-16 code units, so a non-BMP character counts as one.
  if ([...value].length !== 1) {
    return "must be exactly one character"
  }
  if (/[0-9]/u.test(value)) {
    return "must not be a digit — a separator that reads as part of the number makes the verifier's token extraction ambiguous"
  }
  if (value === "-") {
    return "must not be a minus sign — a separator that reads as part of the number makes the verifier's token extraction ambiguous"
  }
  if (/[\s\x1c-\x1f\x85]/u.test(value)) {
    return "must not be whitespace — the verifier splits a paragraph on whitespace, so a whitespace-separated numeral reaches it as several tokens and the run would be withheld for a correct number"
  }
  return null
}

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
export const DESIGN_PRESETS = [
  "editorial",
  "corporate",
  "technical",
  "minimal",
] as const
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

export type MetricSelection = Readonly<
  Record<string, readonly MetricSelectionItem[]>
>

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
  /**
   * Declarable at `schema_version` 2 and above only (Requirement 16.1). Optional rather than
   * required even there, because Requirement 16.3 resolves an undeclared separator from
   * `identity.language` and a **declared** value is persisted unchanged — so "absent" and
   * "equal to the language default" are two different stored definitions, and collapsing them
   * would rewrite a row. Use {@link resolveSeparators} to read the pair a definition renders
   * with.
   */
  readonly decimal_separator?: string
  readonly grouping_separator?: string
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
  /**
   * Required at `schema_version` 2, absent at 1 (Requirement 15.1, 15.12). Optional in the type
   * because one type serves both versions; which versions require it is
   * {@link REQUIRED_IDENTITY_KEYS}, and a v1 definition carrying it is rejected as an
   * unrecognized identity field.
   */
  readonly language?: (typeof LANGUAGES)[number]
  /**
   * Permitted at `schema_version` 3 only (Requirement 12.2), where the customer name
   * moved from a run-form field onto the profile itself. Optional in the type for the
   * same reason `language` is -- one type serves every version -- and deliberately not
   * in {@link REQUIRED_IDENTITY_KEYS}, because draft mode must let an author save a
   * profile before naming a customer. `enqueueRun` is the gate that requires it, at the
   * point a run actually needs it.
   */
  readonly customer_name?: string
}

/**
 * The required top-level keys, and nothing else (Requirement 2.1) — seven at
 * `schema_version` 1 and eight at 2. {@link REQUIRED_TOP_LEVEL_KEYS} is which, per version;
 * this type is the union of both, so `front_matter` is optional here and required by the
 * validator at the version that declares it.
 */
export type TemplateDefinition = {
  readonly schema_version: number
  readonly identity: TemplateIdentity
  readonly scope: ScopeSpec
  readonly period: PeriodSpec
  readonly metrics: MetricSelection
  readonly blocks: readonly TemplateBlock[]
  readonly design: DesignSpec
  /**
   * The front matter's cover, document control and table of contents (Requirement 13.1).
   * Required at `schema_version` 2 and undeclared at 1. Typed as `unknown` until task 7.4
   * declares its fields and bounds — deliberately, rather than as a hopeful shape nothing
   * validates, so a caller reading it has to narrow it and cannot mistake the type for a
   * guarantee.
   */
  readonly front_matter?: unknown
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

function addIssue(
  sink: IssueSink,
  path: readonly (string | number)[],
  message: string
): void {
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
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value)
  )
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
const FORBIDDEN_POSITIONING_FIELD_PATTERNS: readonly {
  readonly pattern: RegExp
  readonly label: string
}[] = [
  { pattern: /position/i, label: "an absolute position" },
  { pattern: /coordinate/i, label: "a coordinate" },
  { pattern: /^offset/i, label: "an offset" },
  { pattern: /^(x|y)$/i, label: "a coordinate" },
  { pattern: /absolute.*width|width.*absolute/i, label: "an absolute width" },
  {
    pattern: /absolute.*height|height.*absolute/i,
    label: "an absolute height",
  },
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

function validateIdentity(
  identity: unknown,
  path: readonly (string | number)[],
  issues: IssueSink,
  version: SchemaVersion
): void {
  if (!isPlainObject(identity)) {
    addIssue(issues, path, "identity must be an object.")
    return
  }

  const allowedKeys: readonly string[] = IDENTITY_KEYS[version]
  for (const key of Object.keys(identity)) {
    if (!allowedKeys.includes(key)) {
      addIssue(issues, [...path, key], `Unrecognized identity field "${key}".`)
    }
  }

  // Requirement 15.1 — required at v2, and the absence is reported here rather than left to
  // the value check below, so that "you forgot it" and "that is not a language" are two
  // different messages.
  for (const key of REQUIRED_IDENTITY_KEYS[version]) {
    if (!(key in identity)) {
      addIssue(
        issues,
        [...path, key],
        `identity.${key} is required at schema_version ${version}.`
      )
    }
  }

  if (allowedKeys.includes("language") && identity.language !== undefined) {
    // Case-sensitive: `EN` is not a spelling of `en`. See LANGUAGES.
    if (!LANGUAGES.includes(identity.language as (typeof LANGUAGES)[number])) {
      addIssue(
        issues,
        [...path, "language"],
        `identity.language must be exactly one of: ${LANGUAGES.join(", ")} ` +
          "(case-sensitive)."
      )
    }
  }

  const { name, description, report_title: reportTitle } = identity

  if (
    !isNonEmptyString(name) ||
    !stringLengthInRange(name, NAME_MIN_LENGTH, NAME_MAX_LENGTH)
  ) {
    addIssue(
      issues,
      [...path, "name"],
      `identity.name must be a string of ${NAME_MIN_LENGTH} to ${NAME_MAX_LENGTH} characters.`
    )
  }

  if (description !== undefined) {
    if (
      typeof description !== "string" ||
      description.length > DESCRIPTION_MAX_LENGTH
    ) {
      addIssue(
        issues,
        [...path, "description"],
        `identity.description must be a string of at most ${DESCRIPTION_MAX_LENGTH} characters.`
      )
    }
  }

  if (reportTitle !== undefined) {
    if (
      typeof reportTitle !== "string" ||
      reportTitle.length > REPORT_TITLE_MAX_LENGTH
    ) {
      addIssue(
        issues,
        [...path, "report_title"],
        `identity.report_title must be a string of at most ${REPORT_TITLE_MAX_LENGTH} characters.`
      )
    }
  }

  if (allowedKeys.includes("customer_name") && identity.customer_name !== undefined) {
    const customerName = identity.customer_name
    if (
      typeof customerName !== "string" ||
      customerName.length > CUSTOMER_NAME_MAX_LENGTH
    ) {
      addIssue(
        issues,
        [...path, "customer_name"],
        `identity.customer_name must be a string of at most ${CUSTOMER_NAME_MAX_LENGTH} characters.`
      )
    }
  }
}

// --- front_matter (Requirements 13.1, 13.4, 13.5, 13.6, 13.9, 13.13, 13.16) --

export const DOCUMENT_NUMBER_PATTERN_MIN_LENGTH = 1
export const DOCUMENT_NUMBER_PATTERN_MAX_LENGTH = 120

export const DOCUMENT_NUMBER_PLACEHOLDERS = [
  "{template}",
  "{year}",
  "{month}",
  "{run}",
] as const
/**
 * Requirement 13.16's closed placeholder set for
 * `document_control.document_number_pattern`.
 *
 * Closed rather than open, and that is the no-template-language rule applied one field down:
 * a pattern is literal characters plus substitutions from **this** list, so there is no
 * expression to evaluate and nothing that could yield a number without provenance.
 */

export const DOCUMENT_NUMBER_VARYING_PLACEHOLDERS = ["{run}"] as const
/**
 * The placeholders whose value can differ between **two runs of one template over one
 * resolved period**.
 *
 * `{template}` is fixed per template; `{year}` and `{month}` come from the resolved period, so
 * two runs over July 2026 substitute the same values for all three. Only `{run}`
 * distinguishes them — a pattern naming none of these gives both runs the *same* document
 * number, which makes a document number that is not a number for the document.
 */

/** Any `{...}` token, so an **undeclared** placeholder is reported by name. */
const PLACEHOLDER_TOKEN_PATTERN = /\{[^{}]*\}/g

const TOC_MIN_LEVEL = 1
const TOC_MAX_LEVEL = 4
/**
 * `toc.max_level`'s bound — the four heading levels the themes declare styles for. A table of
 * contents asking for level 5 would collect headings no theme can style.
 */

export const APPROVER_ROLES = [
  "author",
  "reviewer",
  "approver",
  "recipient",
] as const
/**
 * Requirement 13.6's four roles, in the order the signature table presents them.
 *
 * A closed list rather than free text, so the approvers list is four declared slots and not a
 * list a template can grow — the signature table's row height is a theme style, and a fifth
 * role would have nowhere to be laid out.
 */

export const CONTACT_BLOCK_MAX_LENGTH = 500
export const DOCUMENT_NAME_MAX_LENGTH = 200
export const DISTRIBUTION_MAX_LENGTH = 500
export const SUBTITLE_MAX_LENGTH = 200
export const APPROVER_NAME_MAX_LENGTH = 120
export const APPROVER_TITLE_MAX_LENGTH = 120

const COVER_ALLOWED_KEYS = ["logo", "contact_block", "subtitle"] as const
const DOCUMENT_CONTROL_ALLOWED_KEYS = [
  "document_name",
  "document_number_pattern",
  "confidentiality_notice_id",
  "distribution",
  "approvers",
] as const
const TOC_ALLOWED_KEYS = ["enabled", "max_level"] as const
const APPROVER_ALLOWED_KEYS = ["role", "name", "title"] as const
/**
 * The additive fields schema_version 3 accepts on an approver entry, on top of
 * {@link APPROVER_ALLOWED_KEYS} (task 4.1, design.md §7.1).
 *
 * `company` and `signature_key` are new; `title` stays exactly as it is at v1/v2 rather than
 * being renamed to `company` — the shipped renderer already maps `title` to the rendered
 * "Company" table column, and a v3 profile keeps that field while additionally being able to
 * carry the real `company` value and an optional signature. A future task decides whether the
 * renderer prefers `company` over `title` once one exists; this task only makes the field
 * legal to store.
 */
const APPROVER_ALLOWED_KEYS_V3 = [
  ...APPROVER_ALLOWED_KEYS,
  "company",
  "signature_key",
] as const

export const APPROVER_COMPANY_MAX_LENGTH = 120
/** Matches {@link APPROVER_TITLE_MAX_LENGTH} — same column, same theme cell width. */

export const SIGNATURE_KEY_MAX_LENGTH = 512
/** An S3 object key under the owner's prefix (Requirement 13.5), not the image bytes. */

const DISTRIBUTION_ROW_ALLOWED_KEYS = ["recipient", "company", "note"] as const
export const DISTRIBUTION_RECIPIENT_MAX_LENGTH = 200
export const DISTRIBUTION_ROW_COMPANY_MAX_LENGTH = 120
export const DISTRIBUTION_NOTE_MAX_LENGTH = 200
export const DISTRIBUTION_ROWS_MAX_ENTRIES = 50
/**
 * Requirement 12.6 — at schema_version 3, `distribution` becomes ordered rows of
 * `{recipient, company, note}` instead of the v1/v2 free-text block (design.md §7.1).
 *
 * The v2 string form keeps validating **at v2** — this is additive at v3 only, so a v2
 * profile lifted into a v3 draft keeps its string `distribution` until the author actually
 * edits the field (Requirement 20.3's "carry `front_matter` through unchanged").
 */

const CONFIDENTIALITY_NOTICE_PREFIX = "doc."

/**
 * One optional string field with a length bound, measured in UTF-16 code units.
 *
 * Absent is fine; present-and-wrong is reported. Code units and not code points, matching
 * `agent/.../compile/definition.py`'s `_utf16_length`: a bound checked against code points is
 * a rule the browser and that compiler would enforce differently, and an astral character is
 * one code point and two code units.
 */
function optionalBoundedString(
  holder: Record<string, unknown>,
  key: string,
  path: readonly (string | number)[],
  issues: IssueSink,
  maximum: number
): void {
  if (!(key in holder)) return
  const value = holder[key]
  if (value === null || value === undefined) return
  if (typeof value !== "string" || value.length > maximum) {
    addIssue(
      issues,
      [...path, key],
      `${key} must be null or a string of at most ${maximum} characters.`
    )
  }
}

/**
 * The `front_matter` section's three subsections and their bounds (Requirements 13.1, 13.13).
 *
 * Reached only when the resolved version declares `front_matter` — the caller checks that — so
 * a version-1 definition carrying the key is reported once, as an undeclared top-level key,
 * rather than twice.
 *
 * Nothing here writes. A version-2 definition omitting the section, carrying an undeclared
 * key, or violating a bound is rejected with **no version row persisted**, which is a property
 * of this function performing no I/O rather than a rule the caller has to honour.
 */
function validateFrontMatter(
  frontMatter: unknown,
  path: readonly (string | number)[],
  issues: IssueSink,
  version: SchemaVersion
): void {
  if (!isPlainObject(frontMatter)) {
    addIssue(issues, path, "front_matter must be an object.")
    return
  }

  for (const key of Object.keys(frontMatter)) {
    if (!(FRONT_MATTER_KEYS as readonly string[]).includes(key)) {
      addIssue(
        issues,
        [...path, key],
        `Unrecognized front_matter field "${key}".`
      )
    }
  }

  for (const section of FRONT_MATTER_KEYS) {
    if (!(section in frontMatter)) {
      addIssue(
        issues,
        [...path, section],
        `front_matter.${section} is required at schema_version ${version}.`
      )
    }
  }

  validateCover(frontMatter.cover, [...path, "cover"], issues)
  validateDocumentControl(
    frontMatter.document_control,
    [...path, "document_control"],
    issues,
    version
  )
  validateToc(frontMatter.toc, [...path, "toc"], issues)
}

/**
 * Requirement 13.4 — the cover's logo, contact block and subtitle.
 *
 * Every field optional: a cover with none of them still emits the report title, the
 * subscription's display name and the resolved period, which the compiler derives on its own.
 * There is nothing here a consultant must fill in.
 */
function validateCover(
  cover: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (cover === undefined || cover === null) return
  if (!isPlainObject(cover)) {
    addIssue(issues, path, "front_matter.cover must be an object.")
    return
  }

  for (const key of Object.keys(cover)) {
    if (!(COVER_ALLOWED_KEYS as readonly string[]).includes(key)) {
      addIssue(issues, [...path, key], `Unrecognized cover field "${key}".`)
    }
  }

  optionalBoundedString(cover, "logo", path, issues, LOGO_MAX_LENGTH)
  optionalBoundedString(
    cover,
    "contact_block",
    path,
    issues,
    CONTACT_BLOCK_MAX_LENGTH
  )
  optionalBoundedString(cover, "subtitle", path, issues, SUBTITLE_MAX_LENGTH)
}

/** Requirements 13.5, 13.6, 13.16 — the document control page. */
function validateDocumentControl(
  control: unknown,
  path: readonly (string | number)[],
  issues: IssueSink,
  version: SchemaVersion
): void {
  if (control === undefined || control === null) return
  if (!isPlainObject(control)) {
    addIssue(issues, path, "front_matter.document_control must be an object.")
    return
  }

  for (const key of Object.keys(control)) {
    if (!(DOCUMENT_CONTROL_ALLOWED_KEYS as readonly string[]).includes(key)) {
      addIssue(
        issues,
        [...path, key],
        `Unrecognized document_control field "${key}".`
      )
    }
  }

  optionalBoundedString(
    control,
    "document_name",
    path,
    issues,
    DOCUMENT_NAME_MAX_LENGTH
  )

  // Requirement 12.7 — at schema_version 3 the confidentiality notice is inherited from the
  // Brand and is not an author-editable field on the profile at all: `publishTemplateVersion`
  // resolves it at publish time, following the exact `resolveDesignFromBrand` pattern
  // `definition.design` already uses, so the renderer never learns Brands exist. A v3 draft
  // therefore never carries this key itself — it is rejected here, the same way an
  // undeclared field would be, rather than silently accepted and then overwritten, which
  // would make a wizard field that visibly does nothing.
  if (version >= 3 && "confidentiality_notice_id" in control) {
    addIssue(
      issues,
      [...path, "confidentiality_notice_id"],
      "document_control.confidentiality_notice_id is inherited from the Brand at " +
        "schema_version 3 and is not set on the profile; edit it on the Brand instead."
    )
  } else if (version < 3 && "confidentiality_notice_id" in control) {
    // A **string id**, resolved from the message catalog rather than carried as copy, so the
    // notice appears in the pinned language like every other fixed string. A literal here
    // would be English in an Indonesian document.
    const notice = control.confidentiality_notice_id
    if (
      !isNonEmptyString(notice) ||
      !notice.startsWith(CONFIDENTIALITY_NOTICE_PREFIX)
    ) {
      addIssue(
        issues,
        [...path, "confidentiality_notice_id"],
        "document_control.confidentiality_notice_id must be a `doc.` message " +
          "catalog string id, not literal copy."
      )
    }
  }

  if ("distribution" in control) {
    validateDistribution(
      control.distribution,
      [...path, "distribution"],
      issues,
      version
    )
  }

  if ("document_number_pattern" in control) {
    validateDocumentNumberPattern(
      control.document_number_pattern,
      [...path, "document_number_pattern"],
      issues
    )
  }

  if ("approvers" in control) {
    validateApprovers(
      control.approvers,
      [...path, "approvers"],
      issues,
      version
    )
  }
}

/**
 * Requirement 12.6 — `distribution` at schema_version 1/2 is the free-text block it has always
 * been; at schema_version 3 it becomes ordered rows of `{recipient, company, note}`.
 *
 * Branching on shape rather than trying to accept both forms at every version: a v3 profile
 * that somehow carried a string here would silently print nothing (the renderer's v3 path
 * reads rows), so rejecting the wrong shape at validation time is what keeps a save-time error
 * from becoming a quietly empty distribution section in a delivered document.
 */
function validateDistribution(
  distribution: unknown,
  path: readonly (string | number)[],
  issues: IssueSink,
  version: SchemaVersion
): void {
  if (version < 3) {
    if (
      distribution !== null &&
      distribution !== undefined &&
      (typeof distribution !== "string" ||
        distribution.length > DISTRIBUTION_MAX_LENGTH)
    ) {
      addIssue(
        issues,
        path,
        `distribution must be null or a string of at most ` +
          `${DISTRIBUTION_MAX_LENGTH} characters.`
      )
    }
    return
  }

  if (!Array.isArray(distribution)) {
    addIssue(
      issues,
      path,
      "document_control.distribution must be an array of " +
        "{recipient, company, note} rows at schema_version 3."
    )
    return
  }

  if (distribution.length > DISTRIBUTION_ROWS_MAX_ENTRIES) {
    addIssue(
      issues,
      path,
      `document_control.distribution accepts at most ` +
        `${DISTRIBUTION_ROWS_MAX_ENTRIES} rows; found ${distribution.length}.`
    )
  }

  distribution.forEach((entry, index) => {
    const at = [...path, index]
    if (!isPlainObject(entry)) {
      addIssue(issues, at, "Each distribution row must be an object.")
      return
    }

    for (const key of Object.keys(entry)) {
      if (!(DISTRIBUTION_ROW_ALLOWED_KEYS as readonly string[]).includes(key)) {
        addIssue(
          issues,
          [...at, key],
          `Unrecognized distribution row field "${key}".`
        )
      }
    }

    if (!isNonEmptyString(entry.recipient)) {
      addIssue(
        issues,
        [...at, "recipient"],
        "distribution row.recipient is required and must be a non-empty string."
      )
    } else if (entry.recipient.length > DISTRIBUTION_RECIPIENT_MAX_LENGTH) {
      addIssue(
        issues,
        [...at, "recipient"],
        `distribution row.recipient must be at most ` +
          `${DISTRIBUTION_RECIPIENT_MAX_LENGTH} characters.`
      )
    }

    optionalBoundedString(
      entry,
      "company",
      at,
      issues,
      DISTRIBUTION_ROW_COMPANY_MAX_LENGTH
    )
    optionalBoundedString(entry, "note", at, issues, DISTRIBUTION_NOTE_MAX_LENGTH)
  })
}

/**
 * Requirement 13.16 — literal characters plus the four declared placeholders, and at least one
 * that varies between runs.
 *
 * Three refusals, and the third is the one worth explaining:
 *
 * - not a string of 1 to 120 characters;
 * - naming a `{...}` token outside {@link DOCUMENT_NUMBER_PLACEHOLDERS} — reported **by
 *   name**, because a validator that only looked for the declared four would accept
 *   `{quarter}` as literal text and emit it verbatim into a delivered document;
 * - naming **no** placeholder whose value differs between two runs of one template over one
 *   resolved period, so both runs would carry the same document number.
 */
function validateDocumentNumberPattern(
  value: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (
    typeof value !== "string" ||
    value.length < DOCUMENT_NUMBER_PATTERN_MIN_LENGTH ||
    value.length > DOCUMENT_NUMBER_PATTERN_MAX_LENGTH
  ) {
    addIssue(
      issues,
      path,
      `document_number_pattern must be a string of ` +
        `${DOCUMENT_NUMBER_PATTERN_MIN_LENGTH} to ` +
        `${DOCUMENT_NUMBER_PATTERN_MAX_LENGTH} characters.`
    )
    return
  }

  const found = [...value.matchAll(PLACEHOLDER_TOKEN_PATTERN)].map(
    (match) => match[0]
  )
  const undeclared = [
    ...new Set(
      found.filter(
        (token) =>
          !(DOCUMENT_NUMBER_PLACEHOLDERS as readonly string[]).includes(token)
      )
    ),
  ].sort()
  if (undeclared.length > 0) {
    addIssue(
      issues,
      path,
      `document_number_pattern names undeclared placeholder(s) ` +
        `${undeclared.join(", ")}; the declared set is ` +
        `${DOCUMENT_NUMBER_PLACEHOLDERS.join(", ")}.`
    )
  }

  const varying: readonly string[] = DOCUMENT_NUMBER_VARYING_PLACEHOLDERS
  if (!found.some((token) => varying.includes(token))) {
    addIssue(
      issues,
      path,
      "document_number_pattern names no placeholder whose value differs between two " +
        "runs of one template over one resolved period, so both runs would carry the " +
        `same document number. Include one of: ${[...varying].sort().join(", ")}.`
    )
  }
}

/**
 * Requirement 13.6 — the four-role approvers list.
 *
 * At most one entry per role and no undeclared role. A repeated role would put two names in
 * one signature row, and the row height is a theme style rather than something that grows.
 */
function validateApprovers(
  approvers: unknown,
  path: readonly (string | number)[],
  issues: IssueSink,
  version: SchemaVersion
): void {
  if (!Array.isArray(approvers)) {
    addIssue(issues, path, "document_control.approvers must be an array.")
    return
  }

  if (approvers.length > APPROVER_ROLES.length) {
    addIssue(
      issues,
      path,
      `document_control.approvers accepts at most ${APPROVER_ROLES.length} entries, ` +
        `one per declared role; found ${approvers.length}.`
    )
  }

  const allowedKeys: readonly string[] =
    version >= 3 ? APPROVER_ALLOWED_KEYS_V3 : APPROVER_ALLOWED_KEYS

  const seen = new Set<string>()
  approvers.forEach((entry, index) => {
    const at = [...path, index]
    if (!isPlainObject(entry)) {
      addIssue(issues, at, "Each approver must be an object.")
      return
    }

    for (const key of Object.keys(entry)) {
      if (!allowedKeys.includes(key)) {
        addIssue(issues, [...at, key], `Unrecognized approver field "${key}".`)
      }
    }

    const role = entry.role
    if (
      typeof role !== "string" ||
      !(APPROVER_ROLES as readonly string[]).includes(role)
    ) {
      addIssue(
        issues,
        [...at, "role"],
        `approver.role must be one of: ${APPROVER_ROLES.join(", ")}.`
      )
    } else if (seen.has(role)) {
      addIssue(issues, [...at, "role"], `Duplicate approver role "${role}".`)
    } else {
      seen.add(role)
    }

    optionalBoundedString(entry, "name", at, issues, APPROVER_NAME_MAX_LENGTH)
    optionalBoundedString(entry, "title", at, issues, APPROVER_TITLE_MAX_LENGTH)

    if (version >= 3) {
      optionalBoundedString(
        entry,
        "company",
        at,
        issues,
        APPROVER_COMPANY_MAX_LENGTH
      )
      // `signature_key` is an S3 object key (Requirement 13.5), not the image bytes — never a
      // presigned URL, never the image content itself, so a definition never carries anything
      // that has to be redacted from a log line.
      if ("signature_key" in entry && entry.signature_key !== null) {
        const key = entry.signature_key
        if (!isNonEmptyString(key) || key.length > SIGNATURE_KEY_MAX_LENGTH) {
          addIssue(
            issues,
            [...at, "signature_key"],
            `approver.signature_key must be null or a non-empty string of at ` +
              `most ${SIGNATURE_KEY_MAX_LENGTH} characters.`
          )
        }
      }
    }
  })
}

/**
 * Requirement 13.9 — `enabled` and `max_level`.
 *
 * `front_matter.toc` is retained in the definition even where the image ships no table of
 * contents, exactly as a disabled cover is retained: the definition records what the author
 * asked for, and what the renderer can deliver is a property of the image rather than of the
 * template.
 */
function validateToc(
  toc: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (toc === undefined || toc === null) return
  if (!isPlainObject(toc)) {
    addIssue(issues, path, "front_matter.toc must be an object.")
    return
  }

  for (const key of Object.keys(toc)) {
    if (!(TOC_ALLOWED_KEYS as readonly string[]).includes(key)) {
      addIssue(issues, [...path, key], `Unrecognized toc field "${key}".`)
    }
  }

  if ("enabled" in toc && !isBoolean(toc.enabled)) {
    addIssue(issues, [...path, "enabled"], "toc.enabled must be a boolean.")
  }

  if ("max_level" in toc) {
    const level = toc.max_level
    if (
      !isFiniteInteger(level) ||
      level < TOC_MIN_LEVEL ||
      level > TOC_MAX_LEVEL
    ) {
      addIssue(
        issues,
        [...path, "max_level"],
        `toc.max_level must be an integer from ${TOC_MIN_LEVEL} to ${TOC_MAX_LEVEL}.`
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

  validateResourceTypes(
    scope.resource_types,
    [...path, "resource_types"],
    issues
  )
  validateTagFilters(scope.tag_filters, [...path, "tag_filters"], issues)
  validateResourceGroups(
    scope.resource_groups,
    [...path, "resource_groups"],
    issues
  )
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
    addIssue(
      issues,
      path,
      `resource_types accepts at most ${MAX_RESOURCE_TYPES} entries.`
    )
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
    addIssue(
      issues,
      path,
      `tag_filters accepts at most ${MAX_TAG_FILTERS} entries.`
    )
  }

  value.forEach((entry, index) => {
    const entryPath = [...path, index]
    if (!isPlainObject(entry)) {
      addIssue(
        issues,
        entryPath,
        "Each tag filter must be an object of `key` and `value`."
      )
      return
    }

    for (const key of Object.keys(entry)) {
      if (key !== "key" && key !== "value") {
        addIssue(
          issues,
          [...entryPath, key],
          `Unrecognized tag filter field "${key}".`
        )
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
      addIssue(
        issues,
        [...entryPath, "key"],
        azureIdentifierMessage([...entryPath, "key"])
      )
    }

    if (
      typeof tagValue !== "string" ||
      tagValue.length > TAG_VALUE_MAX_LENGTH
    ) {
      addIssue(
        issues,
        [...entryPath, "value"],
        `A tag filter value must be a string of at most ${TAG_VALUE_MAX_LENGTH} characters.`
      )
    } else if (looksLikeAzureIdentifier(tagValue)) {
      addIssue(
        issues,
        [...entryPath, "value"],
        azureIdentifierMessage([...entryPath, "value"])
      )
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
    addIssue(
      issues,
      path,
      `resource_groups accepts at most ${MAX_RESOURCE_GROUPS} entries.`
    )
  }

  value.forEach((entry, index) => {
    const entryPath = [...path, index]
    if (
      !isNonEmptyString(entry) ||
      !stringLengthInRange(
        entry,
        RESOURCE_GROUP_MIN_LENGTH,
        RESOURCE_GROUP_MAX_LENGTH
      )
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
  if (
    typeof value !== "string" ||
    !SORT_DIRECTIONS.includes(value as SortDirection)
  ) {
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
    addIssue(
      issues,
      [...path, "start"],
      "period.start must be a valid YYYY-MM-DD local date."
    )
  }
  if (!endIsValid) {
    addIssue(
      issues,
      [...path, "end"],
      "period.end must be a valid YYYY-MM-DD local date."
    )
  }

  if (startIsValid && endIsValid) {
    const span = inclusiveLocalDaySpan(start, end)
    if (span < MIN_PERIOD_LOCAL_DAYS) {
      addIssue(issues, path, "period.start must be at or before period.end.")
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
      addIssue(
        issues,
        [...path, key],
        `Unrecognized metric selection field "${key}".`
      )
    }
  }

  const {
    metric,
    derived,
    statistic,
    estimator,
    fidelity_tier: fidelityTier,
  } = item

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
    addIssue(
      issues,
      [...path, "derived"],
      "derived must be a non-empty string."
    )
  }

  if (!isNonEmptyString(statistic)) {
    addIssue(
      issues,
      [...path, "statistic"],
      "statistic must be a non-empty string."
    )
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
      addIssue(
        issues,
        [...path, "estimator"],
        "estimator must be a non-empty string when present."
      )
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
      addIssue(
        issues,
        entryPath,
        `metrics["${resourceType}"] must be an array.`
      )
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
const LEAF_BLOCK_ALLOWED_KEYS = new Set([
  "id",
  "type",
  "config",
  "scope_override",
])
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
  /**
   * The resolved `schema_version`, carried on the walk state rather than added to
   * `validateBlock`, `validateLeafBlock` and `validateRowBlock`'s four signatures. The state
   * already exists for exactly this — a fact true of the whole walk that one block's check
   * needs — and threading a fifth parameter through the recursion would put the version in
   * three places it is only forwarded from.
   */
  readonly version: SchemaVersion
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

    if (
      blockType === "rich_text" &&
      RICH_TEXT_FORBIDDEN_BINDING_FIELDS.has(key)
    ) {
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

    const enumValues = (
      schema.enums as Readonly<Record<string, readonly string[]>>
    )[key]
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

/**
 * The two column attributes a table already emits without being asked (Requirement 12.3).
 *
 * `resource_name` is always the first column (`tables.py`'s `_RESOURCE_COLUMN`) and
 * `fidelity_tier` is emitted when `show_fidelity` is set (`_TIER_COLUMN`). Naming either
 * explicitly would put **two** columns with one key in the emitted grid, and the verifier
 * resolves a cell by `(row_key, column_key)` — so the second would be unreachable and every
 * anchor into it would fail on a document that looks right.
 *
 * Declared here rather than in `lib/templates/options.ts` because the *rule* is the
 * validator's: `options.ts` imports this to mark the pair as implicit in the picker, and the
 * import goes that way round because a validator that imported the option builder would be a
 * cycle. `COLUMN_ATTRIBUTES` itself lives in `options.ts`, mirrored from the compiler.
 */
export const IMPLICIT_TABLE_COLUMNS = [
  "resource_name",
  "fidelity_tier",
] as const

/** The two block types that carry a `columns` config field. */
const COLUMN_LIST_BLOCK_TYPES = new Set(["resource_table", "top_n_table"])

/**
 * Requirement 12.3 — an explicit column naming what the table already emits.
 *
 * `resource_name` is always implicit, so naming it is always an error. `fidelity_tier` is
 * implicit **only** when `show_fidelity` is set, so it is an error only then — a table that
 * does not show the tier may legitimately name it as an ordinary column.
 *
 * Reported at the entry's own path, so the message names the offending column rather than the
 * field that contains it.
 */
function validateImplicitColumns(
  blockType: string,
  config: Record<string, unknown>,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (!COLUMN_LIST_BLOCK_TYPES.has(blockType)) return

  const columns = config.columns
  if (!Array.isArray(columns)) return

  const showsFidelity = Boolean(config.show_fidelity)

  columns.forEach((entry, index) => {
    if (typeof entry !== "string") return
    if (!(IMPLICIT_TABLE_COLUMNS as readonly string[]).includes(entry)) return
    if (entry === "fidelity_tier" && !showsFidelity) return

    const because =
      entry === "resource_name"
        ? "every resource row already leads with the resource name"
        : 'this block sets "show_fidelity", so the fidelity tier is already a column'

    addIssue(
      issues,
      [...path, "columns", index],
      `"${blockType}" already emits "${entry}" implicitly — ${because}. Naming it as an ` +
        `explicit column would put two columns with one key in the table, and a cell is ` +
        `resolved by (row key, column key), so the second would be unreachable.`
    )
  })
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

  // Requirement 13.2 — at v2 and above the front matter owns the cover, so a `cover` block in
  // `blocks` would emit it twice: once from `front_matter.cover` and once from the block.
  //
  // Rejected rather than ignored, and **named by block id**, because the author put it there
  // deliberately: a silently dropped block is indistinguishable from one that was never
  // configured, and `lib/templates/migrate.ts` is what lifts a v1 cover into the front matter
  // rather than the validator quietly discarding it. (This comment named `version.ts` before
  // that module existed — the migration was specified before it was written.)
  //
  // `cover` stays a declared type, so this check is about *placement at this version* and not
  // about the type existing. That is why it is here and not a change to `BLOCK_TYPES`.
  if (
    state.version >= 2 &&
    (FRONT_MATTER_FORBIDDEN_BLOCK_TYPES as readonly string[]).includes(
      blockType
    )
  ) {
    const id =
      typeof block.id === "string" ? block.id : String(path[path.length - 1])
    addIssue(
      issues,
      [...path, "type"],
      `Block "${id}" is a "${blockType}" block, which the front matter owns at ` +
        `schema_version ${state.version}. Declare it under front_matter.${blockType} ` +
        `instead of in blocks.`
    )
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
    // Requirement 12.3 — after the field-name pass, because it reads two fields together:
    // whether `columns` names an implicit attribute depends on `show_fidelity`.
    if (isPlainObject(block.config)) {
      validateImplicitColumns(
        blockType,
        block.config,
        [...path, "config"],
        issues
      )
    }
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
  if (
    isNonEmptyString(id) &&
    stringLengthInRange(id, BLOCK_ID_MIN_LENGTH, BLOCK_ID_MAX_LENGTH)
  ) {
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
    addIssue(
      issues,
      [...path, "columns"],
      "A row's columns must be an array of arrays."
    )
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
  mode: "draft" | "run",
  version: SchemaVersion
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

  const state: BlockWalkState = {
    idOccurrences: new Map(),
    totalBlockCount: 0,
    version,
  }

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
  issues: IssueSink,
  version: SchemaVersion,
  language: (typeof LANGUAGES)[number] | null
): void {
  if (!isPlainObject(value)) {
    addIssue(issues, path, "number_format must be an object.")
    return
  }

  const allowedKeys: readonly string[] = NUMBER_FORMAT_KEYS[version]
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      addIssue(
        issues,
        [...path, key],
        `Unrecognized number_format field "${key}".`
      )
    }
  }

  // Requirement 16.2 — checked on the **resolved** pair, not on the declared one.
  //
  // Resolved, because the constraint is about what the renderer will emit: a definition
  // declaring only a decimal separator still renders a grouping one, and a pair that
  // collides after defaulting collides in the document. At v1 nothing is declarable and the
  // resolution is `en`'s `.` and `,`, which passes every clause — so this adds no failure
  // to any stored v1 definition.
  const resolved = resolveSeparators(value, language)
  for (const key of ["decimal_separator", "grouping_separator"] as const) {
    // Only report on a key this version admits: at v1 an undeclared separator resolves to a
    // legal default, and a *declared* one has already been reported as unrecognized above —
    // a second issue about its characters would be noise about a field that may not exist.
    if (!allowedKeys.includes(key)) continue
    const problem = separatorProblem(resolved[key])
    if (problem !== null) {
      addIssue(issues, [...path, key], `number_format.${key} ${problem}.`)
    }
  }
  if (
    resolved.decimal_separator === resolved.grouping_separator &&
    allowedKeys.includes("decimal_separator")
  ) {
    addIssue(
      issues,
      [...path, "decimal_separator"],
      `number_format's decimal and grouping separators are both ` +
        `"${resolved.decimal_separator}"; a reader could not tell one from the other.`
    )
  }

  const { decimal_places: decimalPlaces, group_thousands: groupThousands } =
    value

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
    addIssue(
      issues,
      [...path, "group_thousands"],
      "group_thousands must be a boolean."
    )
  }
}

function validateDesign(
  design: unknown,
  path: readonly (string | number)[],
  issues: IssueSink,
  version: SchemaVersion,
  language: (typeof LANGUAGES)[number] | null
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

  if (
    typeof preset !== "string" ||
    !DESIGN_PRESETS.includes(preset as DesignPreset)
  ) {
    addIssue(
      issues,
      [...path, "preset"],
      `preset must be one of: ${DESIGN_PRESETS.join(", ")}.`
    )
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

  if (
    typeof density !== "string" ||
    !DENSITY_VALUES.includes(density as Density)
  ) {
    addIssue(
      issues,
      [...path, "density"],
      `density must be one of: ${DENSITY_VALUES.join(", ")}.`
    )
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

  validateNumberFormat(
    numberFormat,
    [...path, "number_format"],
    issues,
    version,
    language
  )

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

  if (
    typeof pageSize !== "string" ||
    !PAGE_SIZE_VALUES.includes(pageSize as PageSize)
  ) {
    addIssue(
      issues,
      [...path, "page_size"],
      `page_size must be one of: ${PAGE_SIZE_VALUES.join(", ")}.`
    )
  }
}

// --- Top level (Requirements 2.1, 2.2, 2.4, 2.9, 2.10) ----------------------

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
 * Which key sets the rest of the walk reads, for a definition whose `schema_version` may not be
 * usable.
 *
 * **This applies no default to the definition.** `validateSchemaVersion` has already reported
 * an issue at `schema_version` for an absent, non-integer or out-of-range value, and that issue
 * stands; this function only decides which of two key tables the *remaining* checks consult, so
 * that a definition with a broken version still reports every other violation in the same pass
 * (Requirement 2.7) instead of returning one issue and stopping.
 *
 * `MIN_SCHEMA_VERSION` is the choice, and it is the conservative one: the version 1 tables are
 * the narrower of the two, so an unusable version is validated against the smaller key set and
 * a `front_matter` or a `language` alongside it is *also* reported rather than silently
 * admitted on the strength of a version nobody could read.
 */
function resolveSchemaVersion(value: unknown): SchemaVersion {
  if (isFiniteInteger(value) && value in REQUIRED_TOP_LEVEL_KEYS) {
    return value as SchemaVersion
  }
  return MIN_SCHEMA_VERSION
}

/**
 * The `schema_version` a definition **already in memory** declares, conservatively.
 *
 * The exported reader for callers that hold a parsed definition and need only this
 * one number off it — the template routes and the edit page, which have just saved
 * or read a version row and would otherwise each re-implement the extraction. It
 * delegates to {@link resolveSchemaVersion}, so "which version does this definition
 * claim" has one answer in this module rather than one per caller.
 *
 * **Not the reader for a list query.** A caller that does not already hold the
 * definition should project `definition->>'schema_version'` in SQL instead — see
 * `lib/templates/store.ts#readLatestVersionForView`. Selecting a whole block tree
 * to reach one integer is the cost this function must not be used to hide.
 */
export function declaredSchemaVersion(definition: unknown): SchemaVersion {
  return resolveSchemaVersion(
    typeof definition === "object" && definition !== null
      ? (definition as { readonly schema_version?: unknown }).schema_version
      : undefined
  )
}

/**
 * The `identity.language` a definition pins, or `null` when it declares none — which is every
 * v1 definition, where every string id resolves in `en` (Requirement 15.12).
 *
 * Read for two reasons and written for none: to resolve the separator defaults below, and to
 * pick the message catalog's language at compile time.
 */
export function declaredLanguage(
  raw: unknown
): (typeof LANGUAGES)[number] | null {
  if (!isPlainObject(raw)) return null
  const identity = raw.identity
  if (!isPlainObject(identity)) return null
  const language = identity.language
  return LANGUAGES.includes(language as (typeof LANGUAGES)[number])
    ? (language as (typeof LANGUAGES)[number])
    : null
}

/**
 * The `{decimal_separator, grouping_separator}` pair a definition **resolves to**: whatever it
 * declares, with anything undeclared filled from the language (Requirement 16.3).
 *
 * Exported because the resolution has to happen in exactly one place and three callers need
 * it — this module's own separator validation, the version-2 migration in
 * `lib/templates/version.ts`, and whatever presents a number in the browser. A second
 * resolution would eventually disagree with this one about one definition, and the two
 * would then format the same figure two ways.
 *
 * `language` defaults to the first declared language, which is `en`, which is also
 * `compile/format.DEFAULT_NUMBER_FORMAT` — so a v1 definition, which declares no language and
 * no separators, resolves to exactly the pair it has always rendered with.
 */
export function resolveSeparators(
  numberFormat: unknown,
  language: (typeof LANGUAGES)[number] | null
): { readonly decimal_separator: string; readonly grouping_separator: string } {
  const defaults = SEPARATOR_DEFAULTS[language ?? LANGUAGES[0]]
  if (!isPlainObject(numberFormat)) return defaults
  const declared = (key: keyof typeof defaults): string =>
    numberFormat[key] === undefined
      ? defaults[key]
      : (numberFormat[key] as string)
  return {
    decimal_separator: declared("decimal_separator"),
    grouping_separator: declared("grouping_separator"),
  }
}

// --- Provider and Sections validation (schema_version 3, Requirements 3.4, 7.1, 7.8) ------

const PROVIDERS_SET = new Set<string>(PROVIDERS)
const SUPPORTED_PROVIDERS_SET = new Set<string>(SUPPORTED_PROVIDERS)
const SECTION_PRESENTATIONS_SET = new Set<string>(SECTION_PRESENTATIONS)

function validateProvider(
  provider: unknown,
  path: readonly (string | number)[],
  issues: IssueSink
): void {
  if (typeof provider !== "string") {
    addIssue(issues, path, "provider must be a string.")
    return
  }
  if (!PROVIDERS_SET.has(provider)) {
    addIssue(
      issues,
      path,
      `Unrecognized provider "${provider}". Accepted: ${PROVIDERS.join(", ")}.`
    )
    return
  }
  if (!SUPPORTED_PROVIDERS_SET.has(provider)) {
    addIssue(
      issues,
      path,
      `Provider "${provider}" is declared but not yet supported — no section catalogue exists.`
    )
  }
}

function validateSections(
  sections: unknown,
  path: readonly (string | number)[],
  issues: IssueSink,
  provider: unknown
): void {
  if (!Array.isArray(sections)) {
    addIssue(issues, path, "sections must be an array.")
    return
  }
  if (sections.length > MAX_SECTIONS) {
    addIssue(
      issues,
      path,
      `sections accepts at most ${MAX_SECTIONS} entries.`
    )
  }

  // Resolve the provider's catalogue keys — unknown or unsupported providers
  // already have their own issues, but we still validate section entries
  // structurally.
  const resolvedProvider =
    typeof provider === "string" && SUPPORTED_PROVIDERS_SET.has(provider)
      ? provider
      : undefined
  const knownKeys: ReadonlySet<string> | undefined = resolvedProvider
    ? new Set(SECTION_KEYS_BY_PROVIDER[resolvedProvider])
    : undefined
  const nonRepeatableKeys: ReadonlySet<string> | undefined = resolvedProvider
    ? NON_REPEATABLE_SECTION_KEYS_BY_PROVIDER[resolvedProvider]
    : undefined
  const fixedKeys: readonly string[] | undefined = resolvedProvider
    ? FIXED_SECTION_KEYS_BY_PROVIDER[resolvedProvider]
    : undefined

  const seenIds = new Set<string>()
  const seenNonRepeatableTypes = new Set<string>()
  let lastFixedIndex = -1

  sections.forEach((entry: unknown, index: number) => {
    const entryPath = [...path, index]

    if (!isPlainObject(entry)) {
      addIssue(issues, entryPath, "A section entry must be an object.")
      return
    }

    // --- id ---
    const id = entry.id
    if (typeof id !== "string") {
      addIssue(issues, [...entryPath, "id"], "Section id must be a string.")
    } else if (
      id.length < SECTION_ID_MIN_LENGTH ||
      id.length > SECTION_ID_MAX_LENGTH
    ) {
      addIssue(
        issues,
        [...entryPath, "id"],
        `Section id must be ${SECTION_ID_MIN_LENGTH} to ${SECTION_ID_MAX_LENGTH} characters.`
      )
    } else if (seenIds.has(id)) {
      addIssue(
        issues,
        [...entryPath, "id"],
        `Duplicate section id "${id}".`
      )
    } else {
      seenIds.add(id)
    }

    // --- type ---
    const type = entry.type
    if (typeof type !== "string") {
      addIssue(issues, [...entryPath, "type"], "Section type must be a string.")
    } else if (knownKeys && !knownKeys.has(type)) {
      addIssue(
        issues,
        [...entryPath, "type"],
        `Unknown section type "${type}" for provider "${resolvedProvider}".`
      )
    } else if (typeof type === "string" && nonRepeatableKeys?.has(type)) {
      if (seenNonRepeatableTypes.has(type)) {
        addIssue(
          issues,
          [...entryPath, "type"],
          `Section type "${type}" is not repeatable and already appears earlier.`
        )
      } else {
        seenNonRepeatableTypes.add(type)
      }
    }

    // --- fixed-position ordering ---
    if (typeof type === "string" && fixedKeys) {
      const fixedIdx = fixedKeys.indexOf(type)
      if (fixedIdx !== -1) {
        if (fixedIdx <= lastFixedIndex) {
          addIssue(
            issues,
            [...entryPath, "type"],
            `Fixed-position section "${type}" is out of its declared order.`
          )
        } else {
          lastFixedIndex = fixedIdx
        }
      }
    }

    // --- selection (through existing validateScopeSpec) ---
    if ("selection" in entry) {
      validateScopeSpec(entry.selection, [...entryPath, "selection"], issues)
    }

    // --- metrics (through the existing validateMetricItem loop) ---
    if ("metrics" in entry) {
      const metrics = entry.metrics
      const metricsPath = [...entryPath, "metrics"]
      if (!Array.isArray(metrics)) {
        addIssue(issues, metricsPath, "Section metrics must be an array.")
      } else {
        if (metrics.length > MAX_METRIC_ITEMS_PER_ENTRY) {
          addIssue(
            issues,
            metricsPath,
            `Section metrics accepts at most ${MAX_METRIC_ITEMS_PER_ENTRY} items.`
          )
        }
        metrics.forEach((item: unknown, itemIndex: number) => {
          validateMetricItem(item, [...metricsPath, itemIndex], issues)
        })
      }
    }

    // --- presentation ---
    if ("presentation" in entry) {
      const pres = entry.presentation
      if (typeof pres !== "string" || !SECTION_PRESENTATIONS_SET.has(pres)) {
        addIssue(
          issues,
          [...entryPath, "presentation"],
          `presentation must be one of: ${SECTION_PRESENTATIONS.join(", ")}.`
        )
      }
    }
  })
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

  const addScope = (
    scope: unknown,
    path: readonly (string | number)[]
  ): void => {
    if (!isPlainObject(scope)) return
    const types = scope.resource_types
    if (!Array.isArray(types)) return
    types.forEach((entry, index) => {
      if (isNonEmptyString(entry)) {
        found.push({
          path: [...path, "resource_types", index],
          resourceType: entry,
        })
      }
    })
  }

  const walkBlocks = (
    blocks: unknown,
    path: readonly (string | number)[]
  ): void => {
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

type EmptyRequiredField = {
  readonly path: readonly (string | number)[]
  readonly blockType: string
  readonly fieldName: string
}

/**
 * A required config field that is present but carries nothing (Requirement 2.8).
 *
 * `BLOCK_CONFIG[type].required` is checked for **presence** by
 * `validateBlockConfig`, and presence is all a draft can be held to. But a
 * `"metrics": []` is present, so it satisfies that check, saves cleanly, survives
 * the pre-collection gate in the agent — and then fails in the block compiler after
 * the run has already spent four minutes on inventory and metrics. The compiler
 * stops at the first bad block, so a template with three unfilled blocks costs three
 * full collections to diagnose, one block per run.
 *
 * ## Only in `run` mode, which is the requirement rather than a relaxation
 *
 * The same reasoning as `validateEveryScopedTypeIsSelected` above. The composer
 * inserts a block with its config placeholders empty — a `top_n_table` arrives as
 * `{ columns: [], order_by: "" }` — because the author has not opened the inspector
 * yet. Enforcing this against a draft would refuse to save in the gap between
 * dropping a block on the canvas and configuring it, which is every template that was
 * ever authored. Publishing a version is where the definition has to be complete.
 *
 * Mirrors `_validate_required_config_is_filled` in the agent's
 * `compile/definition.py`, which Requirement 2.6 obliges to reach the same verdict.
 */
function validateRequiredConfigIsFilled(
  raw: Record<string, unknown>,
  issues: IssueSink,
  mode: "draft" | "run"
): void {
  if (mode !== "run") return

  for (const { path, blockType, fieldName } of emptyRequiredConfigFields(raw)) {
    addIssue(
      issues,
      path,
      `"${blockType}" requires the config field "${fieldName}" to carry a value; ` +
        "it is present but empty. A block with no metric has nothing to show, and " +
        "an empty table reads as an empty scope, which means something else " +
        "entirely to a reader."
    )
  }
}

/**
 * Whether a present config value is a **collection** that selected nothing.
 *
 * An empty array is an unfilled multi-select and an empty object is a reference
 * whose sub-fields were never chosen. Both mean the same thing in every block that
 * has one — nothing was picked — which is what lets this be decided without knowing
 * which block is asking.
 *
 * ## Strings are deliberately excluded, and that is the whole boundary
 *
 * An empty string's meaning is a fact about the individual field, not about
 * emptiness. `heading.text: ""` is a legitimately blank heading and the definition
 * generators emit it as a *valid* case; `comparison_delta.run_a: ""` is genuinely
 * unfinished. Telling those apart needs per-field knowledge, and encoding per-field
 * knowledge here would make this a third authority on block configuration to drift
 * from `BLOCK_CONFIG` and from the block compilers — the exact defect the caller
 * exists to close. So this refuses only what is unambiguous.
 *
 * **Where the per-field knowledge actually lives.** `BLOCK_CONFIG`'s `non_empty` names
 * the required string fields whose compilers demand content, and the caller consults it
 * through {@link nonEmptyFields} alongside this function. That keeps this rule's
 * boundary exactly where this comment puts it while still catching
 * `rich_text.text: ""` — which used to save cleanly and fail the run in the agent's
 * `compile_rich_text`, minutes later, with the author long gone. `heading.text: ""` is
 * in no `non_empty` list and is still accepted, which the shared corpus pins as a
 * fixture rather than leaving to this comment.
 *
 * `0` and `false` are not empty either: they are values, and a numeric config field
 * legitimately holding zero must not be refused.
 *
 * Mirrors `_is_empty_container` in the agent's `compile/definition.py`.
 */
/**
 * The required string fields of one block type whose compilers demand content.
 *
 * Reads `BLOCK_CONFIG`'s optional `non_empty` key, defaulting to an empty list so a
 * type that declares none behaves identically whether it omits the key or spells out
 * `[]`. The narrowing lives here rather than at the call site for the reason
 * `_config_schema` gives on the Python side: the table is deliberately a plain literal
 * the Mirror_Guard can read as text, so exactly one place should widen it.
 */
function nonEmptyFields(
  blockType: Exclude<BlockType, "row">
): readonly string[] {
  const schema = BLOCK_CONFIG[blockType] as {
    readonly non_empty?: readonly string[]
  }

  return schema.non_empty ?? []
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

/**
 * Every present-but-empty required config field, with its path and block type.
 *
 * Reads defensively at every level and contributes nothing for a malformed block:
 * the shape validators above have already reported it. An undeclared block type has
 * no config schema to read, so it is skipped here and reported by the block walk.
 */
function emptyRequiredConfigFields(
  raw: Record<string, unknown>
): EmptyRequiredField[] {
  const found: EmptyRequiredField[] = []

  const walkBlocks = (
    blocks: unknown,
    path: readonly (string | number)[]
  ): void => {
    if (!Array.isArray(blocks)) return
    blocks.forEach((block, index) => {
      if (!isPlainObject(block)) return
      const blockPath = [...path, index]

      const blockType = block.type
      if (
        typeof blockType === "string" &&
        blockType !== "row" &&
        blockType in BLOCK_CONFIG
      ) {
        const { config } = block
        if (isPlainObject(config)) {
          for (const fieldName of BLOCK_CONFIG[
            blockType as Exclude<BlockType, "row">
          ].required) {
            if (!(fieldName in config)) continue
            const value = config[fieldName]
            // Two kinds of empty, deliberately kept apart. A container that selected
            // nothing is unambiguous in every block that has one. A blank string is
            // only empty where `BLOCK_CONFIG` says the field's compiler demands
            // content — `heading.text: ""` is a valid blank heading and stays
            // accepted. Read through the helper so a type that declares no
            // `non_empty` key behaves as an empty list rather than throwing.
            if (
              isEmptyContainer(value) ||
              (nonEmptyFields(blockType as Exclude<BlockType, "row">).includes(
                fieldName
              ) &&
                value === "")
            ) {
              found.push({
                path: [...blockPath, "config", fieldName],
                blockType,
                fieldName,
              })
            }
          }
        }
      }

      const { columns } = block
      if (Array.isArray(columns)) {
        columns.forEach((column, columnIndex) => {
          walkBlocks(column, [...blockPath, "columns", columnIndex])
        })
      }
    })
  }

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

  // Resolved once and read by every check below. See `resolveSchemaVersion` on why an
  // unusable version resolves to the narrower key set rather than stopping the walk.
  const version = resolveSchemaVersion(raw.schema_version)
  const language = declaredLanguage(raw)
  const requiredKeys: readonly string[] = REQUIRED_TOP_LEVEL_KEYS[version]

  for (const key of requiredKeys) {
    if (!(key in raw)) {
      addIssue(issues, [key], `Missing required top-level key "${key}".`)
    }
  }

  for (const key of Object.keys(raw)) {
    if (!requiredKeys.includes(key)) {
      addIssue(issues, [key], `Unrecognized top-level key "${key}".`)
    }
  }

  validateSchemaVersion(raw.schema_version, issues)
  validateIdentity(raw.identity, ["identity"], issues, version)
  // v1/v2: scope, metrics, blocks; v3: provider, sections
  if (version <= 2) {
    validateScopeSpec(raw.scope, ["scope"], issues)
    validatePeriod(raw.period, ["period"], issues)
    validateMetrics(raw.metrics, ["metrics"], issues)
    validateBlocks(raw.blocks, ["blocks"], issues, mode, version)
  } else {
    validateProvider(raw.provider, ["provider"], issues)
    validatePeriod(raw.period, ["period"], issues)
    validateSections(raw.sections, ["sections"], issues, raw.provider)
  }
  validateDesign(raw.design, ["design"], issues, version, language)
  // Requirement 13.13 — `front_matter` is validated only where the resolved version declares
  // it, so a version-1 definition carrying the key is reported once, as an undeclared
  // top-level key by the strict check above, rather than twice.
  if (requiredKeys.includes("front_matter")) {
    validateFrontMatter(raw.front_matter, ["front_matter"], issues, version)
  }
  validateCanonicalByteSize(raw, issues)
  if (version <= 2) {
    validateEveryScopedTypeIsSelected(raw, issues, mode)
    validateRequiredConfigIsFilled(raw, issues, mode)
  }

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
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: [...issue.path],
      })
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
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: [...issue.path],
      })
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
  readonly percentiles: Readonly<
    Record<
      string,
      { readonly estimator: string; readonly fidelityTier: string }
    >
  >
  /**
   * For `kind: "derived"` only — every source metric name and every SKU
   * capability name the formula consumes (Requirement 5.5). Absent for
   * `kind: "metric"`.
   */
  readonly requiredSourceMetrics?: readonly string[]
  readonly requiredSkuCapabilities?: readonly string[]

  // --- Presentation facts (Requirement 5.6) ---------------------------------
  //
  // Optional, and validation reads none of them: they exist so the wizard can
  // present what the catalog declares about an item rather than a list held in
  // the Web_App. `lib/templates/catalog.ts` populates every one; a fixture in a
  // validator test populates none, which is why they are optional rather than
  // required.
  //
  // **Whether a statistic is exact or estimated is not a field here.** It is
  // membership in `percentiles`: a statistic keyed there came from a bounded
  // sketch and is an estimate, and every other statistic this entry declares
  // rolls up exactly. A separate boolean would be a second place to say the same
  // thing, and the two would eventually disagree about `p95`.

  /** The catalog's fractional-digit scale for this item's values. */
  readonly scale?: number
  /** e.g. `percent`, `bytes`, `count_per_second`. */
  readonly unit?: string
  /** `percentage` or `magnitude` — which sketch a percentile of this item folds into. */
  readonly unitFamily?: string
  /**
   * `baseline` for a platform metric or a statistic derived from one;
   * `enhanced` for an item needing Azure Monitor Agent, a Data Collection Rule
   * and Log Analytics. The wizard offers an `enhanced` item disabled, with the
   * reason, rather than omitting it.
   */
  readonly fidelityTier?: string
  /** A short qualifier the catalog attaches, e.g. `NIC-level bytes`. */
  readonly label?: string
  /** `host_observed` for a derived statistic the host computes about a guest. */
  readonly observation?: string
  /** The catalog's own prose caveat for a derived statistic. */
  readonly note?: string
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

  // --- v3: metrics live per section, not in one template-wide `metrics` map ----
  //
  // A v3 profile has no `definition.metrics` at all, so the loop below threw
  // "Cannot convert undefined or null to object" -- after run-mode validation had
  // already passed -- and every attempt to save a v3 version failed with an
  // unexplained "The request could not be completed".
  //
  // The guarantee is preserved rather than skipped: a section's metric items use the
  // SAME shape `validateMetricItem` accepts for v1, so each is checked against the
  // catalogue for the resource types that section actually covers. A section's own
  // `selection.resource_types` wins where it narrows; where it is empty the section
  // is unconstrained and the catalogue entry's declared types are what it will cover.
  const sections = (definition as unknown as { readonly sections?: unknown })
    .sections
  if (Array.isArray(sections)) {
    sections.forEach((section, sectionIndex) => {
      const entry = section as {
        type?: unknown
        selection?: { resource_types?: unknown }
        metrics?: unknown
      }
      const items = entry.metrics
      if (!Array.isArray(items) || items.length === 0) return

      const declared = entry.selection?.resource_types
      const narrowed =
        Array.isArray(declared) && declared.length > 0
          ? (declared as string[])
          : SECTION_RESOURCE_TYPES_BY_KEY[String(entry.type ?? "")] ?? []

      items.forEach((item: MetricSelectionItem, itemIndex: number) => {
        const path: readonly (string | number)[] = [
          "sections",
          sectionIndex,
          "metrics",
          itemIndex,
        ]
        const name = item?.metric ?? item?.derived ?? "<unnamed>"

        // Valid where ANY covered type declares it: one section can cover several
        // types, and a metric only has to exist on the type it will be read from.
        const declaredSomewhere = narrowed.some((resourceType) => {
          const resourceTypeCatalog = findCatalogResourceType(catalog, resourceType)
          return (
            resourceTypeCatalog !== undefined &&
            findCatalogEntry(resourceTypeCatalog, item) !== undefined
          )
        })

        if (!declaredSomewhere) {
          addIssue(
            issues,
            path,
            `The Metric_Catalog declares no "${name}" entry for any resource type this ` +
              `section covers${narrowed.length > 0 ? ` (${narrowed.join(", ")})` : ""}.`
          )
        }
      })
    })

    return issues
  }

  for (const [resourceType, items] of Object.entries(definition.metrics ?? {})) {
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
          items
            .filter((other) => other.metric !== undefined)
            .map((other) => other.metric)
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

        for (const skuCapability of catalogEntry.requiredSkuCapabilities ??
          []) {
          if (
            !resourceTypeCatalog.declaredSkuCapabilities.includes(skuCapability)
          ) {
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
