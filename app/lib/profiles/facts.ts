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
}

type RawResourceType = {
  readonly facts: readonly RawFactEntry[]
  /**
   * The parent this type is a sub-record of, or absent for a first-class resource.
   *
   * On the **resource type**, not on a fact — it was declared on `RawFactEntry` here,
   * where the field never exists, so every read of it was `undefined` and the one thing
   * it is for could not be done. `catalog/loader.py`'s `is_child_type` reads it from the
   * type, and this is the same file.
   */
  readonly child_of?: string
}

type RawFactsFile = {
  readonly resource_types: Readonly<Record<string, RawResourceType>>
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
 * The types the catalogue declares as sub-records rather than deployed resources —
 * case-folded, because ARM type ids are case-insensitive and Resource Graph lower-cases
 * what the catalogue declares in camel case.
 *
 * A snapshot's `resources` list holds three kinds of row: a deployed resource, a
 * sub-record of one (a subnet, a security rule), and a finding about one
 * (`Microsoft.Advisor/recommendations`). Only the first is a resource, and counting all
 * three put "23 resources" and "80 baseline fidelity" in the same provenance panel.
 *
 * Mirrors `catalog/loader.py`'s `child_type_names` off the same file, so the two halves
 * cannot answer differently for one catalogue.
 */
export const CHILD_RESOURCE_TYPES: ReadonlySet<string> = new Set(
  Object.entries(FACTS_FILE.resource_types)
    .filter(([, declared]) => typeof declared.child_of === "string")
    .map(([name]) => name.toLowerCase())
)

/**
 * Which fact sources at least one real entry in `facts.v1.json` actually names (task 6.5).
 *
 * **Not the declared vocabulary.** `catalog/loader.py`'s `DECLARED_FACT_SOURCES` fixes the
 * legal spelling a `source` field may use. ARM is now collected for PostgreSQL
 * firewall rules. "Declared" answers *is this a legal source name*;
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
