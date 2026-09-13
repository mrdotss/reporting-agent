import { StatusBadge, type CloseState } from "@/components/ui/status-mark"
import type { RunStatus } from "@/lib/db/schema"
import { RUN_STATUS_PRESENTATION, type RunTone } from "@/lib/runs/presentation"

/**
 * A run's status, as a status mark and its word.
 *
 * Presentational and free of parsing: it takes a status and renders it. The label and
 * the tone come from `lib/runs/presentation.ts`, so the board, the report list and the
 * report page all say the same word for the same row rather than each mapping the enum
 * themselves.
 *
 * `completed` reads **Verified** and `failed` reads **Not delivered**, because those are
 * the facts a consultant needs: whether a proven document was handed over. The in-flight
 * phases keep their own verbs — they genuinely describe what the machine is doing now.
 */

/** The presentation layer's tones, mapped onto the close states the marks draw. */
const STATE: Readonly<Record<RunTone, CloseState>> = Object.freeze({
  neutral: "queued",
  accent: "running",
  positive: "delivered",
  destructive: "undelivered",
})

const TERMINAL_WORD: Readonly<Partial<Record<RunStatus, string>>> = Object.freeze({
  completed: "Verified",
  failed: "Not delivered",
})

export function RunStatusBadge({
  status,
  className,
}: Readonly<{ status: RunStatus; className?: string }>) {
  const presentation = RUN_STATUS_PRESENTATION[status]

  return (
    <StatusBadge
      data-slot="run-status-badge"
      data-status={status}
      state={STATE[presentation.tone]}
      label={TERMINAL_WORD[status] ?? presentation.label}
      className={className}
    />
  )
}
