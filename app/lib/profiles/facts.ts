import "server-only"

import rawFacts from "../../../agent/src/reporting_agent/catalog/facts.v1.json"
import type { TypeCounts } from "./emit"
import {
  missingInputs as pureMissingInputs,
  offerable as pureOfferable,
  type SectionOfferabilityInput,
} from "./offerability"

/**
 * The Fact_Declaration, loaded from the shared JSON file both halves read (task 6.5,
 * Req 15.9, 16.1-16.3).
 *
 * ## One file, both halves
 *
 * `agent/src/reporting_agent/catalog/facts.v1.json` is the catalogue, and this module
 * imports **that file** — the same bytes `catalog/loader.py` reads at runtime, resolved
 * across the monorepo at build time. Follows `lib/profiles/sections.ts`'s exact pattern for
 * `sections.v1.json`, for the same reason: one file makes drift structurally impossible
 * rather than test-detected.
 *
 * ## `import "server-only"`, and why the decision logic lives elsewhere
 *
 * The catalogue carries implementation detail (Resource Graph projections, absent-gap
 * types) the browser has no reason to carry — same reasoning as `sections.ts`. But
 * `offerable`/`missingInputs` **themselves** are pure decision functions with no file
 * access, so they live in `./offerability` (no `server-only`) instead of here, letting the
 * wizard's client-side section list call them directly against a `collectedFactSources` set
 * threaded down as a prop. This module re-exports thin wrappers bound to the real,
 * server-loaded `COLLECTED_FACT_SOURCES`, for server call sites that want the catalogue
 * default without threading the set themselves.
 */

type RawFactEntry = {
  readonly key: string
  readonly value_kind: string
  readonly source: string
  readonly projectable: boolean
  readonly child_of?: string
}

type RawFactsFile = {
  readonly resource_types: Readonly<
    Record<string, { readonly facts: readonly RawFactEntry[] }>
  >
}

const FACTS_FILE: RawFactsFile = rawFacts as unknown as RawFactsFile

/**
 * Every fact entry across every resource type, in file order.
 *
 * Mirrors `catalog/loader.py`'s `FactDeclaration.entries` — the same flattening, the same
 * "one file, both halves" guarantee.
 */
export const FACT_ENTRIES: readonly RawFactEntry[] = Object.values(
  FACTS_FILE.resource_types
).flatMap((declared) => declared.facts)

/**
 * Which fact sources at least one real entry in `facts.v1.json` actually names (task 6.5).
 *
 * **Not the declared vocabulary.** `catalog/loader.py`'s `DECLARED_FACT_SOURCES` fixes the
 * legal spelling a `source` field may use — five values today, including `arm`, which zero
 * entries use, deliberately (`test_arm_is_declared_as_a_source_and_deliberately_not_yet_used`
 * asserts exactly that absence). "Declared" answers *is this a legal source name*;
 * "collected" answers *would a run against this catalogue actually go and fetch this
 * source*. Section offerability must key on the latter — keying on the former marks a
 * section `Ready` that would render with an empty resource_table the moment nothing in the
 * catalogue backs it, which is the exact failure the zero-resource-section rule and Req
 * 15.9 exist to prevent.
 *
 * Computed from `FACT_ENTRIES` at module load, mirroring `catalog/loader.py`'s
 * `FactDeclaration.collected_sources` property exactly — both derive from the same file, so
 * they cannot drift into two different answers for the same catalogue.
 */
export const COLLECTED_FACT_SOURCES: ReadonlySet<string> = new Set(
  FACT_ENTRIES.map((entry) => entry.source)
)

/**
 * `offerable` bound to the real, catalogue-derived `COLLECTED_FACT_SOURCES` — for a server
 * call site that wants the catalogue default without threading the set itself. The decision
 * logic itself lives in `./offerability`; see this module's own docstring for why.
 */
export function offerable(
  entry: SectionOfferabilityInput,
  scanTypeCounts: TypeCounts
): boolean {
  return pureOfferable(entry, scanTypeCounts, COLLECTED_FACT_SOURCES)
}

/**
 * `missingInputs` bound to the real, catalogue-derived `COLLECTED_FACT_SOURCES`. See
 * `offerable` above and `./offerability`'s own docstring.
 */
export function missingInputs(
  entry: SectionOfferabilityInput,
  scanTypeCounts: TypeCounts
): readonly string[] {
  return pureMissingInputs(entry, scanTypeCounts, COLLECTED_FACT_SOURCES)
}
