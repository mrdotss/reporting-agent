import {
  CLOSE_STATE_LABEL,
  StatusMark,
  type CloseState,
} from "@/components/ui/status-mark"
import type { Board } from "@/lib/close/board"
import { cn } from "@/lib/utils"

/** The order the bar fills in: done first, then what is moving, then what is stuck. */
const ORDER: readonly CloseState[] = [
  "delivered",
  "running",
  "queued",
  "undelivered",
  "due",
]

const SEGMENT: Readonly<Partial<Record<CloseState, string>>> = {
  delivered: "bg-(--status-verified)",
  running:
    "bg-[repeating-linear-gradient(135deg,var(--status-inflight)_0_4px,color-mix(in_oklab,var(--status-inflight)_40%,transparent)_4px_8px)]",
  queued:
    "bg-[repeating-linear-gradient(135deg,var(--status-inflight)_0_4px,color-mix(in_oklab,var(--status-inflight)_40%,transparent)_4px_8px)]",
  undelivered: "bg-(--status-failed)",
  due: "shadow-[inset_0_0_0_1.5px_var(--muted-foreground)]",
}

/**
 * The close as one bar: a segment per customer, sorted by state.
 *
 * Counted in customers, not runs, because a customer is what gets delivered. Segments
 * are shaped as well as coloured — hatched while in flight, hollow while unrequested —
 * so the bar reads without its legend.
 */
export function CloseProgress({ board }: Readonly<{ board: Board }>) {
  const sorted = [...board.rows].sort(
    (a, b) => ORDER.indexOf(a.current.state) - ORDER.indexOf(b.current.state)
  )
  const present = ORDER.filter((state) => board.counts[state] > 0)
  const summary = present
    .map((state) => `${board.counts[state]} ${CLOSE_STATE_LABEL[state].toLowerCase()}`)
    .join(", ")

  return (
    <div data-slot="close-progress" className="flex flex-col gap-2.5">
      <div
        role="img"
        aria-label={`Close progress: ${summary}`}
        className="grid h-2.5 gap-1"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, sorted.length)}, minmax(0, 1fr))`,
        }}
      >
        {sorted.map((row) => (
          <span
            key={row.project.id}
            title={`${row.project.name} — ${CLOSE_STATE_LABEL[row.current.state]}`}
            className={cn("rounded-[3px]", SEGMENT[row.current.state])}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-meta text-muted-foreground">
        {present.map((state) => (
          <li key={state} className="flex items-center gap-1.5">
            <StatusMark state={state} />
            <span className="font-mono font-medium text-foreground tabular-nums">
              {board.counts[state]}
            </span>
            {CLOSE_STATE_LABEL[state]}
          </li>
        ))}
      </ul>
    </div>
  )
}
