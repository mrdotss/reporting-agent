/**
 * Grouping the scan's resource types for presentation — `Compute` · `Networking` ·
 * `Data` · `Not reportable` — and, separately, deciding which of them are **greyed**.
 *
 * ## Two independent facts, deliberately
 *
 * `design/Scan.dc.html` shows greyed types *inside* Compute (VM extensions) and *inside*
 * Networking (network watchers), as well as a `Not reportable` group holding Cognitive
 * Services and Log Analytics. So a type's **group** and whether it is **greyed** are not
 * the same question and this module answers them separately:
 *
 * - **group** — which family the type's namespace belongs to. Presentation only.
 * - **greyed** — whether the catalogues declare the type at all. This is the load-bearing
 *   one: requirement 4.7 says a type with no catalogue entry is listed and greyed so that
 *   its absence from the report is *visible rather than silent*.
 *
 * Collapsing them would put every unsupported type into one bucket and lose the fact that
 * the subscription's VM extensions sit beside its virtual machines.
 *
 * ## Why greying is derived from the catalogues rather than listed
 *
 * `isDeclared` reads the same two catalogue files the agent reads. Add a type to
 * `metrics.v1.json` or `facts.v1.json` and it stops being greyed here with no edit to this
 * module — which is the property that keeps the scan screen honest as the catalogues grow.
 * A hand-maintained list of "supported types" would be a third declaration to drift.
 */

export const SCAN_GROUPS = ["compute", "networking", "data", "not_reportable"] as const

export type ScanGroup = (typeof SCAN_GROUPS)[number]

/**
 * The namespace families, in the order the scan screen presents them.
 *
 * `Microsoft.Web` sits under `compute`, and that is a decision rather than an oversight.
 * The mockups declare exactly four groups and App Service (`Microsoft.Web/sites`) is a
 * metric-bearing, catalogue-declared type, so leaving it to fall through to
 * `not_reportable` would put a **supported** type in the bucket labelled unsupported —
 * visibly wrong on the one screen whose job is to say what can be reported. App Service is
 * a compute workload, so it groups with compute. If a future catalogue makes that grouping
 * read oddly, the fix is a fifth group in the mockups and here, not a supported type in
 * `not_reportable`.
 */
const NAMESPACE_GROUPS: ReadonlyArray<readonly [string, ScanGroup]> = [
  ["microsoft.compute", "compute"],
  ["microsoft.web", "compute"],
  ["microsoft.network", "networking"],
  ["microsoft.sql", "data"],
  ["microsoft.dbforpostgresql", "data"],
  ["microsoft.dbformysql", "data"],
  ["microsoft.dbformariadb", "data"],
  ["microsoft.storage", "data"],
  ["microsoft.documentdb", "data"],
]

/**
 * The namespace of an Azure resource type — everything before the first `/`.
 *
 * Case-folded, because Resource Graph lower-cases `type` in its response body while the
 * catalogues declare Azure's own casing. Every comparison in this module folds for that
 * reason; an exact match would group nothing on real data.
 */
function namespaceOf(resourceType: string): string {
  const slash = resourceType.indexOf("/")
  const namespace = slash === -1 ? resourceType : resourceType.slice(0, slash)
  return namespace.trim().toLowerCase()
}

/** Which family a resource type presents under. Pure. */
export function groupFor(resourceType: string): ScanGroup {
  if (typeof resourceType !== "string" || resourceType.trim() === "") {
    return "not_reportable"
  }
  const namespace = namespaceOf(resourceType)
  for (const [prefix, group] of NAMESPACE_GROUPS) {
    if (namespace === prefix) return group
  }
  return "not_reportable"
}

/**
 * Whether either catalogue declares this resource type. Pure.
 *
 * `declaredTypes` is the union of the metric and fact catalogues' resource types, read from
 * the same files the agent reads. A type absent from both is greyed: no section can use it,
 * and requirement 4.7 requires that to be visible rather than silent.
 */
export function isDeclared(
  resourceType: string,
  declaredTypes: readonly string[]
): boolean {
  if (typeof resourceType !== "string" || resourceType.trim() === "") return false
  const folded = resourceType.trim().toLowerCase()
  return declaredTypes.some((declared) => declared.trim().toLowerCase() === folded)
}

export type GroupedType = {
  readonly resourceType: string
  readonly count: number
  /** True when neither catalogue declares the type, so no section can use it. */
  readonly greyed: boolean
}

export type GroupedTypes = {
  readonly group: ScanGroup
  readonly total: number
  readonly types: readonly GroupedType[]
}

/**
 * The scan's per-type counts, grouped for presentation. Pure.
 *
 * A group with no types is **omitted** rather than rendered empty — an empty `Data` heading
 * says nothing a reader needs. A group's `total` is the sum of its own types' counts, so it
 * never mixes the headline and child-count families: pass one map, get that map's grouping.
 *
 * Types are ordered by descending count and then by name, so the screen's order is stable
 * across renders and two scans of one unchanged subscription present identically.
 */
export function groupScanTypes(
  typeCounts: Readonly<Record<string, number>>,
  declaredTypes: readonly string[]
): readonly GroupedTypes[] {
  const buckets = new Map<ScanGroup, GroupedType[]>()

  for (const [resourceType, count] of Object.entries(typeCounts)) {
    const group = groupFor(resourceType)
    const entry: GroupedType = {
      resourceType,
      count,
      greyed: !isDeclared(resourceType, declaredTypes),
    }
    const bucket = buckets.get(group)
    if (bucket === undefined) buckets.set(group, [entry])
    else bucket.push(entry)
  }

  return SCAN_GROUPS.flatMap((group) => {
    const types = buckets.get(group)
    if (types === undefined || types.length === 0) return []
    const sorted = [...types].sort(
      (a, b) => b.count - a.count || a.resourceType.localeCompare(b.resourceType)
    )
    return [
      {
        group,
        total: sorted.reduce((sum, type) => sum + type.count, 0),
        types: sorted,
      },
    ]
  })
}
