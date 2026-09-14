import { FidelityBadge } from "@/components/reports/fidelity-badge"
import type { RunView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import type { Language } from "@/lib/messages/language"
import type { RunProvenance } from "@/lib/runs/gaps"

/**
 * Where a completed run's numbers came from, as six facts.
 *
 * The window in the customer's zone with its offset, the resources and gaps it recorded,
 * the grain it collected at, and the resources by fidelity tier. The snapshot id itself
 * is not repeated here: it is the first digest in the verdict beside this card, with its
 * copy control, and printing it twice made the two cards read as one long list.
 *
 * ## Why the offset is shown and not just the zone
 *
 * The customer is Asia/Jakarta, UTC+07:00, and an "August 2026" report means August in
 * *local* time. Naming the offset is what lets a reader reconcile the window with a
 * UTC-based record.
 *
 * ## Where these values come from
 *
 * The resource and gap counts are on the `report_runs` row. The grain, the offset and
 * the local window are in the **snapshot document**, read server-side by
 * `lib/runs/gaps.ts#loadRunProvenance`. Every field is independently optional, so a
 * snapshot missing one omits that line rather than failing the page.
 */

function Row({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-1.5 font-mono text-[13px] tabular-nums">
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
      <p data-slot="snapshot-provenance-absent" className="text-sm text-muted-foreground">
        {messageText("ui.snapshot.no_snapshot", language ?? "en")}
      </p>
    )
  }

  const tiers = Object.entries(provenance?.fidelityTiers ?? {})
  const start = provenance?.localStart ?? run.periodStart
  const end = provenance?.localEnd ?? run.periodEnd
  // `2026-08-01 → 08-31` when both ends share a year: the year is said once.
  const window = start.slice(0, 4) === end.slice(0, 4) ? `${start} → ${end.slice(5)}` : `${start} → ${end}`

  return (
    <dl data-slot="snapshot-provenance" className="grid grid-cols-2 gap-x-4 gap-y-3.5">
      <Row label={messageText("ui.snapshot.label_window", language ?? "en") ?? "Window"}>
        <span data-slot="snapshot-window">{window}</span>
      </Row>

      <Row label={messageText("ui.snapshot.label_timezone", language ?? "en") ?? "Timezone"}>
        <span data-slot="snapshot-timezone">
          {provenance?.timezone ?? run.timezone}
          {provenance?.utcOffset === undefined || provenance.utcOffset === null
            ? null
            : ` ${provenance.utcOffset}`}
        </span>
      </Row>

      <Row label={messageText("ui.snapshot.label_resources", language ?? "en") ?? "Resources"}>
        <span data-slot="snapshot-resource-count">{run.resourceCount ?? "—"}</span>
      </Row>

      <Row label={messageText("ui.snapshot.label_gaps_recorded", language ?? "en") ?? "Gaps recorded"}>
        <span data-slot="snapshot-gap-count">{run.gapCount ?? "—"}</span>
      </Row>

      {provenance?.grain === undefined || provenance.grain === null ? null : (
        <Row label={messageText("ui.snapshot.label_grain", language ?? "en") ?? "Grain"}>
          <span data-slot="snapshot-grain">{provenance.grain}</span>
        </Row>
      )}

      {tiers.length === 0 ? null : (
        <Row label={messageText("ui.snapshot.label_fidelity", language ?? "en") ?? "Fidelity"}>
          <span className="flex flex-wrap items-center gap-1.5 font-sans">
            {tiers.map(([tier, count]) => (
              <FidelityBadge key={tier} tier={tier} count={count} />
            ))}
          </span>
        </Row>
      )}
    </dl>
  )
}
