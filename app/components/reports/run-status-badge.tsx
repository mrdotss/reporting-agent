import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { RunStatus } from "@/lib/db/schema"
import { RUN_STATUS_PRESENTATION, type RunTone } from "@/lib/runs/presentation"

/**
 * A run's status, as one badge.
 *
 * Presentational and free of parsing: it takes a status and renders it. The label and
 * the tone come from `lib/runs/presentation.ts`, so the run list, the run detail screen
 * and the dashboard all say the same word for the same row rather than each mapping the
 * enum themselves.
 *
 * ## Status has its own scale, and it is not the accent
 *
 * The `positive` tone used to render `secondary` and `accent` rendered `default` — the
 * teal. So a completed run and a primary button were the same colour, and "verified"
 * and "this product" were the same signal. `--status-*` is four measured steps that
 * exist only to mean state, and `--destructive` keeps its one job: a run whose document
 * could not be proven. A queued run is mist; a collecting one is the in-flight blue.
 *
 * ## The dot carries the state before the word does
 *
 * A table of runs is scanned, not read. A filled dot in the state's own colour resolves
 * at a glance and at any zoom; the word confirms it. Both are present because colour
 * alone is not a signal — about one reader in twelve cannot separate these hues.
 */

const TONE_STYLE: Readonly<Record<RunTone, string>> = Object.freeze({
  neutral:
    "border-border bg-transparent text-muted-foreground [--dot:var(--muted-foreground)]",
  accent:
    "border-transparent bg-(--status-inflight-soft) text-(--status-inflight) [--dot:var(--status-inflight)]",
  positive:
    "border-transparent bg-(--status-verified-soft) text-(--status-verified) [--dot:var(--status-verified)]",
  destructive:
    "border-transparent bg-(--status-failed-soft) text-(--status-failed) [--dot:var(--status-failed)]",
})

export function RunStatusBadge({
  status,
  className,
}: Readonly<{ status: RunStatus; className?: string }>) {
  const presentation = RUN_STATUS_PRESENTATION[status]

  return (
    <Badge
      data-slot="run-status-badge"
      data-status={status}
      data-tone={presentation.tone}
      variant="outline"
      className={cn(TONE_STYLE[presentation.tone], className)}
    >
      <span
        aria-hidden="true"
        data-slot="run-status-dot"
        className="size-1.5 shrink-0 rounded-full bg-(--dot)"
      />
      {presentation.label}
    </Badge>
  )
}
