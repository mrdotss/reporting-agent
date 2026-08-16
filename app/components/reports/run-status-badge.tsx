import { Badge } from "@/components/ui/badge"
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
 * `--destructive` appears for `failed` and nowhere else. That token means *this document
 * could not be proven*, so a queued run is mist neutral and a collecting one carries the
 * teal accent — spending red on "still working" would dilute the one meaning it has.
 */

const TONE_VARIANT: Readonly<
  Record<RunTone, "secondary" | "outline" | "destructive" | "default">
> = Object.freeze({
  neutral: "outline",
  accent: "default",
  positive: "secondary",
  destructive: "destructive",
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
      variant={TONE_VARIANT[presentation.tone]}
      className={className}
    >
      {presentation.label}
    </Badge>
  )
}
