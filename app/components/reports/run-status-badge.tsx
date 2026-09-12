import { Stamp, type StampTone } from "@/components/ui/stamp"
import { cn } from "@/lib/utils"
import type { RunStatus } from "@/lib/db/schema"
import { RUN_STATUS_PRESENTATION, type RunTone } from "@/lib/runs/presentation"

/**
 * A run's status, as a struck stamp.
 *
 * Presentational and free of parsing: it takes a status and renders it. The label and
 * the tone come from `lib/runs/presentation.ts`, so the register, the certificate and
 * the overview all say the same word for the same row rather than each mapping the
 * enum themselves.
 *
 * ## The words changed with the drawing
 *
 * `completed` reads **Verified** and `failed` reads **Not delivered**, because those
 * are the facts a consultant needs. "Completed" describes the pipeline's state; a run
 * that completed and failed verification is not something anyone should call complete.
 * "Failed" describes the machine; what the reader needs to know is that no document
 * was handed over. The in-flight phases keep their own verbs — they are genuinely
 * describing what the machine is doing right now.
 *
 * ## Status has its own scale, and it is not the accent
 *
 * Verdigris means "this product" and is spent on primary actions. `--status-*` is four
 * measured steps that exist only to mean state, and `--status-failed` — vermilion —
 * keeps its one job: a document that could not be proven.
 */

/** The presentation layer's tones, mapped onto the stamp's. */
const TONE: Readonly<Record<RunTone, StampTone>> = Object.freeze({
  neutral: "neutral",
  accent: "working",
  positive: "verified",
  destructive: "unproven",
})

/**
 * Where the stamp's word differs from the pipeline's word. Only the two terminal
 * states differ, and both differ for the same reason: the reader is asking about the
 * document, not about the job.
 */
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
    <Stamp
      data-slot="run-status-badge"
      data-status={status}
      tone={TONE[presentation.tone]}
      className={cn(className)}
    >
      {TERMINAL_WORD[status] ?? presentation.label}
    </Stamp>
  )
}
