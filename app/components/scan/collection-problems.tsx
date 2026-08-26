import { messageText } from "@/lib/messages/catalog"
import type { RegionProbe } from "@/lib/scans/view"

/**
 * The collection problems a scan observed, stated at authoring time (Requirements 5.3, 5.4).
 *
 * ## Why this exists at all
 *
 * A region whose batch metrics endpoint refuses every caller is rerouted correctly by the
 * collector and recorded in `collection_log` — but until this panel, it was only ever
 * discovered when a run *finished*, minutes later. `azure-integration.md` records the real
 * case: `indonesiacentral` answered `403` for a service principal holding Reader and for a
 * subscription owner alike, while the ARM per-resource path served the same metrics without
 * complaint. Surfacing it during authoring is the whole point.
 *
 * ## Mist neutrals, never `--destructive`
 *
 * A fallback route is **information**, not a failure: the metrics are still collected, one
 * resource at a time. `design-system.md` reserves `--destructive` for a document that could
 * not be proven, and diluting that meaning here would cost it everywhere it matters.
 *
 * ## What it may and may not claim
 *
 * The copy states the region, the consequence, and the **count of resources in that region**
 * — and that those resources *may* return no samples. It does not name a resource as having
 * returned nothing, because the probe is one request per region and has observed no
 * per-resource outcome. Requirement 5.4 is explicit that this is a stated risk phrased as
 * one, and `refusedRegions` excludes `unknown` verdicts for the same reason: a probe that
 * could not complete found no problem to report.
 */
export function CollectionProblems({
  refused,
  resourcesByRegion,
}: {
  readonly refused: readonly RegionProbe[]
  /** Scanned resource count per region, for the risk each statement quantifies. */
  readonly resourcesByRegion: Readonly<Record<string, number>>
}) {
  if (refused.length === 0) return null

  return (
    <section data-slot="collection-problems" className="space-y-2">
      {refused.map((probe) => (
        <p
          key={probe.region}
          data-slot="collection-problem"
          className="rounded-lg border border-border px-5 py-4 text-sm text-muted-foreground"
        >
          {messageText("ui.scan.fallback_region", "en", {
            region: probe.region,
            count: resourcesByRegion[probe.region] ?? 0,
          })}
        </p>
      ))}
    </section>
  )
}
