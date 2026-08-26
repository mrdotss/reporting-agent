import "server-only"

import rawSections from "../../../agent/src/reporting_agent/catalog/sections.v1.json"

/**
 * The Section_Catalogue, loaded from the shared JSON file both halves read.
 *
 * ## One file, both halves
 *
 * `agent/src/reporting_agent/catalog/sections.v1.json` is the catalogue, and this
 * module imports **that file** — the same bytes the compiler reads at runtime,
 * resolved across the monorepo at build time.
 *
 * This deliberately follows the pattern `app/lib/templates/catalog.ts` set for
 * `metrics.v1.json`: one file makes drift structurally impossible rather than
 * test-detected.
 *
 * ## `import "server-only"`
 *
 * The catalogue carries implementation detail (block sequences, fact source names)
 * the browser has no reason to carry. The wizard's section list fetches what it
 * needs through an API route, keeping the bundle size honest.
 */

// --- raw shape (structural typing over a build-time import) -----------------

export type SectionPresetMetric = {
  readonly metric: string
  readonly statistic: string
}

export type SectionExpansionBlock = {
  readonly block: string
  readonly per: "section" | "resource"
  readonly config?: Readonly<Record<string, unknown>>
  readonly when_presentation?: readonly string[]
}

export type SectionEntry = {
  readonly key: string
  readonly number: number
  readonly title_id: string
  readonly group: "inventory" | "utilisation" | "closing"
  readonly position: "free" | "fixed" | "always"
  readonly repeatable: boolean
  readonly needs_resource_types: readonly string[]
  readonly needs_fact_sources: readonly string[]
  readonly metric_bearing: boolean
  readonly presets: Readonly<
    Record<string, readonly SectionPresetMetric[] | "*">
  >
  readonly expands_to: readonly SectionExpansionBlock[]
  readonly optional?: boolean
  readonly author_filled?: boolean
  readonly draws_from_prior_verified_runs?: boolean
  readonly notes?: string
}

export type SectionCatalogue = {
  readonly catalogue_version: string
  readonly providers: {
    readonly azure: {
      readonly sections: readonly SectionEntry[]
    }
  }
}

// --- the catalogue, typed and frozen ----------------------------------------

export const SECTION_CATALOGUE: SectionCatalogue =
  rawSections as unknown as SectionCatalogue

export const SECTION_CATALOGUE_VERSION: string =
  SECTION_CATALOGUE.catalogue_version

/**
 * Azure sections, in catalogue-declared order.
 * This is the primary access path for wizard step 2.
 */
export const AZURE_SECTIONS: readonly SectionEntry[] =
  SECTION_CATALOGUE.providers.azure.sections

/**
 * Lookup a section entry by key. Returns undefined for unknown keys.
 */
export function sectionByKey(key: string): SectionEntry | undefined {
  return AZURE_SECTIONS.find((s) => s.key === key)
}

/**
 * The three fixed-position entries, in their declared order.
 */
export const FIXED_SECTIONS: readonly SectionEntry[] = AZURE_SECTIONS.filter(
  (s) => s.position === "fixed"
)

/**
 * The single always-present entry.
 */
export const ALWAYS_SECTION: SectionEntry | undefined = AZURE_SECTIONS.find(
  (s) => s.position === "always"
)

/**
 * All canonical section numbers, for validation.
 */
export const SECTION_NUMBERS: readonly number[] = AZURE_SECTIONS.map(
  (s) => s.number
)
