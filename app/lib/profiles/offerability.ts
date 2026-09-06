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
 *
 * ## Resource types are compared case-folded
 *
 * An ARM resource type id is **case-insensitive**, and the two sides of this comparison are
 * two strings written at different times by different authors. Azure Resource Graph answers
 * its `type` column lowercased — `microsoft.compute/virtualmachines` — while the section
 * catalogue declares `Microsoft.Compute/virtualMachines`, which is the spelling Azure's own
 * documentation uses. A case-sensitive `has` matches neither against the other.
 *
 * The defect that produced this: a subscription holding three virtual machines offered
 * **no** metric-bearing section, every one of them disabled with "Not yet available: needs
 * Microsoft.Compute/virtualMachines" — naming, as the missing input, precisely the type the
 * scan had just counted three of. It stayed invisible while the scan itself was broken,
 * because a scan with no types at all makes every section unavailable for the honest
 * reason, and the two failures look identical from the wizard.
 */
export function offerable(
  entry: SectionOfferabilityInput,
  scanTypeCounts: TypeCounts,
  collectedFactSources: ReadonlySet<string>
): boolean {
  const collectedTypes = collectedTypeSet(scanTypeCounts)
  return (
    entry.needs_resource_types.every((rt) => collectedTypes.has(rt.toLowerCase())) &&
    entry.needs_fact_sources.every((source) => collectedFactSources.has(source))
  )
}

/**
 * The scan's counted resource types, case-folded for comparison.
 *
 * A fact source is **not** folded alongside them: those are a closed vocabulary this
 * codebase writes on both sides (`advisor`, `recovery_services`, …), so a case difference
 * there would be a spelling mistake to fix rather than two valid spellings of one id.
 */
function collectedTypeSet(scanTypeCounts: TypeCounts): ReadonlySet<string> {
  return new Set(Object.keys(scanTypeCounts).map((type) => type.toLowerCase()))
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
  const collectedTypes = collectedTypeSet(scanTypeCounts)
  // Reported in the catalogue's own spelling, not the scan's: the consultant is being told
  // which resource type the section needs, and `Microsoft.Compute/virtualMachines` is the
  // spelling Azure's documentation uses. Only the comparison is case-folded.
  const missingTypes = entry.needs_resource_types.filter(
    (rt) => !collectedTypes.has(rt.toLowerCase())
  )
  const missingSources = entry.needs_fact_sources.filter(
    (source) => !collectedFactSources.has(source)
  )
  return [...missingTypes, ...missingSources]
}
