import { CopyButton } from "@/components/subscriptions/copy-button"
import { FidelityBadge } from "@/components/reports/fidelity-badge"
import type { RunView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import type { Language } from "@/lib/messages/language"
import type { RunProvenance } from "@/lib/runs/gaps"

/**
 * Where a completed run's numbers came from.
 *
 * A report is an **audit artifact**, so its inputs have to be pinned and visible: the
 * snapshot id that content-addresses the collected data, the window in the customer's
 * zone **with the offset shown**, the grain the collection ran at, and the resource
 * counts by fidelity tier.
 *
 * ## Why the offset is shown and not just the zone
 *
 * The customer is Asia/Jakarta, UTC+07:00, and a "July 2026" report means July in *local*
 * time. A reader checking a figure against their own records has to know which seven
 * hours were included at each edge — so the panel names the zone, its resolved offset,
 * and the half-open UTC instants the collector actually queried. Naming only the local
 * dates would let two people compute different totals from the same document and both be
 * right about what they thought they were reading.
 *
 * ## Where these values come from
 *
 * The snapshot id, the resource count and the gap count are on the `report_runs` row. The
 * grain, the resolved offset and the UTC instants are in the **snapshot document**, read
 * server-side by `lib/runs/gaps.ts#loadRunProvenance`. That is why they are not on the
 * relay's `snapshot_ready` event: Requirement 40.5 restricts the relay to the row and the
 * gap list, and a stated grain that was not the collector's would be worse than an
 * omitted one. This panel is a server render, so it can read the object directly.
 *
 * Every field is independently optional, so a snapshot missing one — an older agent, a
 * newer schema — omits that line rather than failing the page.
 *
 * Every value is mono tabular. The snapshot id is truncated with a copy control beside
 * it: 64 hex characters is unreadable inline, and it is precisely the value somebody
 * quotes when they dispute a figure.
 */

/** How much of the 64-character digest is shown inline. */
const SNAPSHOT_ID_VISIBLE = 12

function Row({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs tracking-widest text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="flex flex-wrap items-center gap-1.5 font-mono text-sm tabular-nums">
        {children}
      </dd>
    </div>
  )
}

export function SnapshotProvenance({
  run,
  provenance,
  language = "en",
}: Readonly<{
  run: RunView
  /** `null` when the run produced no snapshot, or when its object was unreadable. */
  provenance: RunProvenance | null
  language?: Language
}>) {
  if (run.snapshotId === null) {
    return (
      <p
        data-slot="snapshot-provenance-absent"
        className="text-sm text-muted-foreground"
      >
        {messageText("ui.snapshot.no_snapshot", language ?? "en")}
      </p>
    )
  }

  const tiers = Object.entries(provenance?.fidelityTiers ?? {})

  return (
    <dl
      data-slot="snapshot-provenance"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
    >
      <Row label={messageText("ui.snapshot.label_snapshot", language ?? "en") ?? "Snapshot"}>
        <span
          data-slot="snapshot-id"
          // The full digest in `title`, so a reader can see it without copying, and the
          // copy control so they do not have to select 64 characters by hand.
          title={run.snapshotId}
          className="break-all"
        >
          {run.snapshotId.slice(0, SNAPSHOT_ID_VISIBLE)}…
        </span>

        <CopyButton value={run.snapshotId} label={messageText("ui.snapshot.copy_snapshot_id", language ?? "en") ?? "Copy the snapshot id"} />
      </Row>

      {provenance?.grain === undefined || provenance.grain === null ? null : (
        <Row label={messageText("ui.snapshot.label_grain", language ?? "en") ?? "Grain"}>
          <span data-slot="snapshot-grain">{provenance.grain}</span>
        </Row>
      )}

      <Row label={messageText("ui.snapshot.label_window", language ?? "en") ?? "Window"}>
        <span data-slot="snapshot-window">
          {provenance?.localStart ?? run.periodStart} {messageText("ui.snapshot.range_to", language ?? "en")}{" "}
          {provenance?.localEnd ?? run.periodEnd}
        </span>
      </Row>

      <Row label={messageText("ui.snapshot.label_timezone", language ?? "en") ?? "Timezone"}>
        <span data-slot="snapshot-timezone">
          {provenance?.timezone ?? run.timezone}
          {provenance?.utcOffset === undefined ||
          provenance.utcOffset === null ? null : (
            <>
              {" "}
              {/* The resolved offset, which is the half a reader needs to reconcile
                  this window with a UTC-based record. */}
              <span className="text-muted-foreground">
                ({provenance.utcOffset})
              </span>
            </>
          )}
        </span>
      </Row>

      {provenance?.startUtc === undefined ||
      provenance.startUtc === null ||
      provenance.endUtc === null ? null : (
        <Row label={messageText("ui.snapshot.label_collected_utc", language ?? "en") ?? "Collected (UTC)"}>
          {/*
            Half-open on the UTC side: `endUtc` is midnight of the local day *after*
            the last one, and is excluded. Stated so nobody reads it as an extra day.
          */}
          <span data-slot="snapshot-window-utc" className="break-all">
            {provenance.startUtc} {messageText("ui.snapshot.range_to", language ?? "en")} {provenance.endUtc}
          </span>
        </Row>
      )}

      <Row label={messageText("ui.snapshot.label_resources", language ?? "en") ?? "Resources"}>
        <span data-slot="snapshot-resource-count">
          {run.resourceCount ?? "—"}
        </span>
      </Row>

      <Row label={messageText("ui.snapshot.label_gaps_recorded", language ?? "en") ?? "Gaps recorded"}>
        <span data-slot="snapshot-gap-count">{run.gapCount ?? "—"}</span>
      </Row>

      {tiers.length === 0 ? null : (
        <Row label={messageText("ui.snapshot.label_fidelity", language ?? "en") ?? "Fidelity"}>
          <span className="flex flex-wrap items-center gap-1.5">
            {tiers.map(([tier, count]) => (
              <FidelityBadge key={tier} tier={tier} count={count} />
            ))}
          </span>
        </Row>
      )}
    </dl>
  )
}
