import type { ConnectedSubscriptionView, ScanView } from "@/lib/db/views"
import { groupScanTypes, type ScanGroup } from "@/lib/scans/grouping"
import {
  countsAreReported,
  readStringList,
  readTypeCounts,
  scanGate,
} from "@/lib/scans/view"
import { cn } from "@/lib/utils"

/**
 * What the selected connector can see: its latest scan, read once and drawn as the
 * detail's Overview and Resources tabs.
 *
 * The same reads as the scan page — the counts, the regions, the resource groups, and
 * the types grouped by what a report can do with them — so the two cannot disagree. A
 * connector that has never been scanned, or whose scan did not complete, says so rather
 * than printing zeros.
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

export type Inventory = ReturnType<typeof readInventory>

export function readInventory(subscription: ConnectedSubscriptionView, scan: ScanView | null) {
  const counts = scan === null ? {} : readTypeCounts(scan.typeCounts)
  const childCounts = scan === null ? {} : readTypeCounts(scan.childTypeCounts)
  const regions = scan === null ? [] : readStringList(scan.regions)
  const resourceGroups = scan === null ? [] : readStringList(scan.resourceGroups)
  const gate =
    scan === null
      ? null
      : scanGate({ status: scan.status, resourceCount: scan.resourceCount, errorCode: scan.errorCode })
  const grouped = groupScanTypes(counts, [...Object.keys(counts), ...Object.keys(childCounts)])
  return {
    scan,
    reported: countsAreReported(scan),
    failed: gate?.kind === "failed",
    grouped,
    total: grouped.reduce((sum, bucket) => sum + bucket.total, 0),
    typeCount: Object.keys(counts).length,
    figures: [
      [scan?.resourceCount, "Resources"],
      [Object.keys(counts).length, "Types"],
      [regions.length, "Regions"],
      // AWS has no resource groups; its fourth figure is the subnets, the one
      // sub-record its scan counts.
      subscription.provider === "aws"
        ? [childCounts["AWS::EC2::Subnet"] ?? 0, "Subnets"]
        : [resourceGroups.length, "Resource groups"],
    ] as const,
    scannedLine:
      scan === null
        ? "Not scanned yet."
        : `Last scanned ${scannedAt.format(new Date(scan.createdAt))} WIB · ${
            subscription.fidelityTier === "enhanced" ? "Enhanced" : "Baseline"
          } fidelity`,
  }
}

/** Said in place of the figures when there are none to show. */
export function InventoryUnavailable({ inventory }: Readonly<{ inventory: Inventory }>) {
  return (
    <p className="px-4 py-6 text-meta text-muted-foreground md:px-5">
      {inventory.scan === null
        ? "Scan this connector to see the resources it can read, grouped by what a report can do with them."
        : inventory.failed
          ? "The last scan did not complete, so there are no counts to show. Scan again."
          : "The scan is still running. Its counts appear here when it finishes."}
    </p>
  )
}

function Composition({ inventory }: Readonly<{ inventory: Inventory }>) {
  if (inventory.total === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={inventory.grouped.map((bucket) => `${GROUP_LABEL[bucket.group]} ${bucket.total}`).join(", ")}
        className="flex h-2.5 gap-0.5 overflow-hidden rounded-[3px]"
      >
        {inventory.grouped.map((bucket) => (
          <span key={bucket.group} className={GROUP_COLOR[bucket.group]} style={{ flex: bucket.total }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {inventory.grouped.map((bucket) => (
          <li key={bucket.group} className="flex items-center gap-1.5">
            <i aria-hidden="true" className={`size-2 rounded-[2px] ${GROUP_COLOR[bucket.group]}`} />
            {GROUP_LABEL[bucket.group]}
            <span className="font-mono text-foreground tabular-nums">{bucket.total}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The figures, what they are made of, and the largest types. */
export function InventoryOverview({ inventory }: Readonly<{ inventory: Inventory }>) {
  const largest = inventory.grouped
    .flatMap((bucket) => bucket.types)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 rounded-lg border border-border sm:grid-cols-4">
        {inventory.figures.map(([value, label], index) => (
          <div
            key={label}
            className={cn(
              "flex flex-col gap-0.5 px-3.5 py-2.5",
              index > 0 && "border-l border-border/60 max-sm:nth-[3]:border-l-0",
              index > 1 && "max-sm:border-t max-sm:border-border/60"
            )}
          >
            <dd className="text-figure-sm font-mono tabular-nums">{value ?? "—"}</dd>
            <dt className="order-first sr-only">{label}</dt>
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              {label}
            </span>
          </div>
        ))}
      </dl>
      <Composition inventory={inventory} />
      {largest.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <h3 className="text-meta font-medium">Largest types</h3>
          <ul>
            {largest.map((type) => (
              <li key={type.resourceType} className="flex justify-between gap-3 font-mono text-[12.5px] leading-7">
                <span
                  className={type.greyed ? "min-w-0 truncate text-muted-foreground" : "min-w-0 truncate"}
                  title={type.resourceType}
                >
                  {type.resourceType}
                </span>
                <span className="tabular-nums">{type.count}</span>
              </li>
            ))}
          </ul>
          {inventory.typeCount > largest.length ? (
            <p className="text-xs text-muted-foreground">All {inventory.typeCount} types are under Resources.</p>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** Every type, grouped by what a report can do with it. Each group folds. */
export function InventoryResources({ inventory }: Readonly<{ inventory: Inventory }>) {
  return (
    <div className="flex flex-col">
      {inventory.grouped.map((bucket) => (
        <details key={bucket.group} open className="group border-b border-border/60 px-4 py-2.5 md:px-5">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-meta font-medium [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="text-muted-foreground transition-transform group-open:rotate-90"
            >
              ›
            </span>
            <i aria-hidden="true" className={`size-2 rounded-[2px] ${GROUP_COLOR[bucket.group]}`} />
            {GROUP_LABEL[bucket.group]}
            <span className="ml-auto font-mono font-normal text-muted-foreground tabular-nums">{bucket.total}</span>
          </summary>
          <ul className="mt-1 pl-5">
            {bucket.types.map((type) => (
              <li key={type.resourceType} className="flex justify-between gap-3 font-mono text-[12.5px] leading-7">
                <span
                  className={type.greyed ? "min-w-0 truncate text-muted-foreground" : "min-w-0 truncate"}
                  title={type.resourceType}
                >
                  {type.resourceType}
                </span>
                <span className="tabular-nums">{type.count}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
      <p className="px-4 py-3 text-xs text-muted-foreground md:px-5">
        Greyed types are collected for completeness but carry no metrics a section can use.
      </p>
    </div>
  )
}
