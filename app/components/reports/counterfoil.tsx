import { Seal } from "@/components/ui/seal"
import { RunStatusBadge } from "@/components/reports/run-status-badge"
import type { RunView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import type { Language } from "@/lib/messages/language"
import { periodLine } from "@/lib/runs/presentation"

/**
 * The counterfoil: the stub you keep to prove the other half is genuine.
 *
 * ## What it is
 *
 * A record in this product is a certificate. The seal on it is a content-addressed
 * digest — the snapshot id *is* the hash of the snapshot's bytes — and the whole
 * argument of the product is that a figure in the delivered document traces back to
 * it. So the record's identity and its verdict are lifted out of the body and set in
 * a narrow column behind a perforation, the way a counterfoil is torn from a receipt
 * and retained.
 *
 * This is the one thing on the page a consultant has to read to decide whether to
 * trust what is beside it: which record, sealed with what, over which window, in which
 * zone, at which grain, and whether it was proven.
 *
 * ## Why the zone is never dropped
 *
 * "July 2026" means July in Asia/Jakarta, not July in UTC. The base grain is `PT1H`
 * precisely because `P1D` buckets are UTC-aligned and the customer is not, so a period
 * printed without its zone is a figure whose window the reader cannot reconstruct.
 * The zone travels with the dates on every surface that names a period, and this is the
 * surface that names it most load-bearingly.
 *
 * ## The perforation is a real edge, not decoration
 *
 * It is drawn as a dashed hairline down the column's trailing edge on wide viewports
 * and across its bottom when the layout stacks — the same mark either way, so the
 * relationship it states ("this stub belongs to that body") survives the breakpoint.
 */
export function Counterfoil({
  run,
  snapshotSha256,
  recordNumber,
  proven,
  language = "en",
}: Readonly<{
  run: RunView
  /** The snapshot digest, when one has been recorded. */
  snapshotSha256?: string | null
  /** The record's number in the register, when the run has been numbered. */
  recordNumber?: string | null
  /** `false` strikes the seal's leading edge in vermilion. */
  proven: boolean
  language?: Language
}>) {
  return (
    <aside
      data-slot="counterfoil"
      aria-label={messageText("ui.counterfoil.aria", language) ?? undefined}
      className={[
        "flex shrink-0 flex-col gap-6",
        // The perforation: trailing edge when beside the body, bottom edge when above.
        "border-b border-dashed border-border pb-6",
        "lg:w-64 lg:border-r lg:border-b-0 lg:pr-6 lg:pb-0",
      ].join(" ")}
    >
      {recordNumber ? (
        <div className="flex flex-col gap-1">
          <span className="text-micro text-muted-foreground uppercase">
            {messageText("ui.counterfoil.record", language)}
          </span>
          <span className="font-mono text-base font-semibold tabular-nums">
            {recordNumber}
          </span>
        </div>
      ) : null}

      {snapshotSha256 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-micro text-muted-foreground uppercase">
            {messageText("ui.counterfoil.seal", language)}
          </span>
          <Seal
            value={snapshotSha256}
            label="snapshot digest"
            tone={proven ? "verified" : "unproven"}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="text-micro text-muted-foreground uppercase">
          {messageText("ui.counterfoil.window", language)}
        </span>
        <span className="font-mono text-meta tabular-nums">
          {periodLine(run)}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-micro text-muted-foreground uppercase">{messageText("ui.counterfoil.state", language)}</span>
        <span>
          <RunStatusBadge status={run.status} />
        </span>
      </div>
    </aside>
  )
}
