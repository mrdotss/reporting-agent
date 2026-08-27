import type { TypeCounts } from "./emit"

/**
 * Section offerability against a scan's collected inventory (task 6.5, Req 15.9,
 * 16.1-16.3). **Pure, and deliberately not `server-only`** — unlike `lib/profiles/facts.ts`
 * (which loads `facts.v1.json` to compute *which* sources are collected),
 * this module only decides *given* that set, so the wizard's client-side section list
 * (`components/templates/step-sections.tsx`) can call it directly against a
 * `collectedFactSources` set threaded down as a prop, without pulling a server-only
 * catalogue loader into client code.
 */

export type SectionOfferabilityInput = {
  readonly needs_resource_types: readonly string[]
  readonly needs_fact_sources: readonly string[]
}

/**
 * `offerable(entry, scan, collectedFactSources) = needs_resource_types ⊆
 * scan.typeCounts.keys() AND needs_fact_sources ⊆ collectedFactSources`
 *
 * Both clauses are **vacuously true** for an entry declaring neither — sections 1, 2, 13 and
 * 15 fall out of this one rule unconditionally offerable, with no special case written for
 * them.
 *
 * **Reachability is deliberately not an input.** Whether Advisor (or Recovery Services, or
 * Capacity) actually answers for *this* subscription is a run-time fact, not an
 * authoring-time one — a missing role records `fact_unavailable` when the run tries, exactly
 * as `azure-integration.md` records a refused metrics data plane as a route decision rather
 * than as a reason to hide the section. A section that disappears from the wizard on a
 * transient 403 would be worse than one that renders with an honest, visible gap: the
 * consultant could no longer even author the section they need once the role is fixed,
 * without the wizard itself telling them why it vanished.
 *
 * `collectedFactSources` is "which sources at least one `facts.v1.json` entry actually
 * names" (`lib/profiles/facts.ts`'s `COLLECTED_FACT_SOURCES`) — **not** the wider declared
 * vocabulary (`arm` is declared and used by nothing). Keying on the declared set would mark
 * a section `Ready` that renders empty the moment nothing backs it.
 */
export function offerable(
  entry: SectionOfferabilityInput,
  scanTypeCounts: TypeCounts,
  collectedFactSources: ReadonlySet<string>
): boolean {
  const collectedTypes = new Set(Object.keys(scanTypeCounts))
  return (
    entry.needs_resource_types.every((rt) => collectedTypes.has(rt)) &&
    entry.needs_fact_sources.every((source) => collectedFactSources.has(source))
  )
}

/**
 * The resource type(s) or fact source(s) missing for an otherwise-offerable entry, for the
 * "disabled with the missing input named" surface Req 16.1 asks for.
 *
 * Returns `[]` when `offerable` would return `true` — callers should check `offerable` first
 * and only call this to explain a `false`.
 */
export function missingInputs(
  entry: SectionOfferabilityInput,
  scanTypeCounts: TypeCounts,
  collectedFactSources: ReadonlySet<string>
): readonly string[] {
  const collectedTypes = new Set(Object.keys(scanTypeCounts))
  const missingTypes = entry.needs_resource_types.filter(
    (rt) => !collectedTypes.has(rt)
  )
  const missingSources = entry.needs_fact_sources.filter(
    (source) => !collectedFactSources.has(source)
  )
  return [...missingTypes, ...missingSources]
}
