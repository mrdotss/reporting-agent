import { RescanButton } from "@/components/scan/rescan-button"
import type { ConnectedSubscriptionView } from "@/lib/db/views"
import { groupScanTypes, type ScanGroup } from "@/lib/scans/grouping"
import type { ScanView } from "@/lib/db/views"
import {
  countsAreReported,
  readStringList,
  readTypeCounts,
  scanGate,
} from "@/lib/scans/view"

/**
 * What the selected connector can see: its latest scan, beside the list.
 *
 * The same reads as the scan page — the counts, the regions, the resource groups, and
 * the types grouped by what a report can do with them — so the two cannot disagree. A
 * connector that has never been scanned, or whose scan did not complete, says so and
 * offers the scan rather than printing zeros.
 */

const GROUP_LABEL: Readonly<Record<ScanGroup, string>> = {
  compute: "Compute",
  networking: "Networking",
  data: "Data",
  not_reportable: "Not reportable",
}

const GROUP_COLOR: Readonly<Record<ScanGroup, string>> = {
  compute: "bg-primary",
  networking: "bg-(--soga)",
  data: "bg-cat-3",
  not_reportable: "bg-muted-foreground/40",
}

const scannedAt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Jakarta",
})

export function ConnectorInventory({
  subscription,
  scan,
  canScan,
}: Readonly<{
  subscription: ConnectedSubscriptionView
  scan: ScanView | null
  /** Whether `POST .../scan` would accept this connector. */
  canScan: boolean
}>) {
  const counts = scan === null ? {} : readTypeCounts(scan.typeCounts)
  const childCounts = scan === null ? {} : readTypeCounts(scan.childTypeCounts)
  const regions = scan === null ? [] : readStringList(scan.regions)
  const groups = scan === null ? [] : readStringList(scan.resourceGroups)
  const reported = countsAreReported(scan)
  const gate =
    scan === null
      ? null
      : scanGate({
          status: scan.status,
          resourceCount: scan.resourceCount,
          errorCode: scan.errorCode,
        })
  const grouped = groupScanTypes(counts, [
    ...Object.keys(counts),
    ...Object.keys(childCounts),
  ])
  const total = grouped.reduce((sum, bucket) => sum + bucket.total, 0)

  return (
    <section
      aria-labelledby="connector-inventory-title"
      data-slot="connector-inventory"
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card lg:sticky lg:top-20"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-4 pb-3 md:px-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="connector-inventory-title" className="text-section">
            What&rsquo;s in <span className="font-mono">{subscription.displayName}</span>
          </h2>
          <p className="text-meta text-muted-foreground">
            {scan === null
              ? "Not scanned yet."
              : `Last scanned ${scannedAt.format(new Date(scan.createdAt))} WIB · ${
                  subscription.fidelityTier === "enhanced" ? "Enhanced" : "Baseline"
                } fidelity`}
          </p>
        </div>
        {canScan ? <RescanButton subscriptionId={subscription.id} language="en" /> : null}
      </div>

      {scan === null || !reported ? (
        <p className="border-t border-border px-4 py-6 text-meta text-muted-foreground md:px-5">
          {scan === null
            ? "Scan this connector to see the resources it can read, grouped by what a report can do with them."
            : gate?.kind === "failed"
              ? "The last scan did not complete, so there are no counts to show. Scan again."
              : "The scan is still running. Its counts appear here when it finishes."}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 border-y border-border sm:grid-cols-4">
            {(
              [
                [scan.resourceCount, "Resources"],
                [Object.keys(counts).length, "Types"],
                [regions.length, "Regions"],
                [groups.length, "Resource groups"],
              ] as const
            ).map(([value, label], index) => (
              <div
                key={label}
                className={
                  index === 0
                    ? "flex flex-col gap-0.5 px-4 py-3 md:px-5"
                    : "flex flex-col gap-0.5 border-l border-border/60 px-4 py-3 max-sm:nth-[3]:border-l-0 md:px-5"
                }
              >
                <dd className="text-figure-sm font-mono tabular-nums">{value ?? "—"}</dd>
                <dt className="order-first sr-only">{label}</dt>
                <span aria-hidden="true" className="text-xs text-muted-foreground">
                  {label}
                </span>
              </div>
            ))}
          </dl>

          {total > 0 ? (
            <>
              <div
                role="img"
                aria-label={grouped
                  .map((bucket) => `${GROUP_LABEL[bucket.group]} ${bucket.total}`)
                  .join(", ")}
                className="mx-4 mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-[3px] md:mx-5"
              >
                {grouped.map((bucket) => (
                  <span
                    key={bucket.group}
                    className={GROUP_COLOR[bucket.group]}
                    style={{ flex: bucket.total }}
                  />
                ))}
              </div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-2 pb-3 text-xs text-muted-foreground md:px-5">
                {grouped.map((bucket) => (
                  <li key={bucket.group} className="flex items-center gap-1.5">
                    <i aria-hidden="true" className={`size-2 rounded-[2px] ${GROUP_COLOR[bucket.group]}`} />
                    {GROUP_LABEL[bucket.group]}
                    <span className="font-mono text-foreground tabular-nums">{bucket.total}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {grouped.map((bucket) => (
            <div
              key={bucket.group}
              className="border-t border-border/60 px-4 py-3 md:px-5"
            >
              <div className="mb-1 flex justify-between text-meta font-medium">
                <span>{GROUP_LABEL[bucket.group]}</span>
                <span className="font-mono text-muted-foreground tabular-nums">{bucket.total}</span>
              </div>
              <ul>
                {bucket.types.map((type) => (
                  <li
                    key={type.resourceType}
                    className="flex justify-between gap-3 font-mono text-[12.5px] leading-7"
                  >
                    <span
                      className={
                        type.greyed ? "min-w-0 truncate text-muted-foreground" : "min-w-0 truncate"
                      }
                      title={type.resourceType}
                    >
                      {type.resourceType}
                    </span>
                    <span className="tabular-nums">{type.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground md:px-5">
            Greyed types are collected for completeness but carry no metrics a section
            can use.
          </p>
        </>
      )}
    </section>
  )
}
