"use client"

import { useSyncExternalStore } from "react"
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react"

import { ActivityTimeline } from "@/components/reports/activity-timeline"
import { GapList } from "@/components/reports/gap-list"
import { RunFailureNotice } from "@/components/reports/run-failure-notice"
import { RunDocumentPreview } from "@/components/reports/run-document-preview"
import { RunPhases } from "@/components/reports/run-phases"
import type { RunView } from "@/lib/db/views"
import type { RunGap } from "@/lib/runs/gaps"
import { RUN_STATUS_PRESENTATION, runPhases } from "@/lib/runs/presentation"
import { cn } from "@/lib/utils"
import { messageText } from "@/lib/messages/catalog"
import { useRunStream } from "@/hooks/useRunStream"

/**
 * The live half of the run detail screen (Requirements 40.4, 40.8, 40.11, 36.7).
 *
 * The **only** `"use client"` leaf on that page, and it is one because a stream needs a
 * browser. Everything above it stays a server component: the page reads the row scoped by
 * `user_id`, reads the provenance from the snapshot object, and hands both down as props.
 *
 * All parsing happens in `useRunStream` (Requirement 40.8). This component maps state to
 * markup and the two children below it — the timeline and the gap list — are
 * presentational, which is what lets each of them be asserted without a stream.
 *
 * ## It is seeded from the row, and re-seeded on every reconnect
 *
 * `initialRun` is the server-rendered row, so the first paint is correct before any
 * connection opens — and a completed or failed run opens **no** stream at all
 * (Requirement 40.12). On a reconnect the hook re-fetches the row before rendering
 * (Requirements 40.4, 40.11), which is why a relay that closes every two idle minutes
 * costs the reader nothing.
 *
 * Terminal state is read from `run.status` / `run.errorCode` / `run.errorMessage`, not
 * only from events (Requirement 36.7). `TIMEOUT` is written by the reaper when the run's
 * container may already be gone, so it arrives with **no event to carry it** — a
 * component that trusted the stream alone would show a timed-out run as still collecting,
 * forever.
 *
 * ## `aria-live`
 *
 * One polite region, carrying the status sentence and nothing else. One region rather
 * than per-step announcements, because a screen reader reading out every progress tick of
 * a twelve-minute run is worse than silence. The count itself is in the timeline's own
 * `aria-valuetext`, reachable on demand.
 */
export function RunProgress({
  initialRun,
  initialGaps,
  subscriptionLabel,
  heading = null,
  sections = [],
  coverTitle = "",
  coverKicker = "",
  phaseTimings = null,
}: Readonly<{
  initialRun: RunView
  initialGaps: readonly RunGap[]
  /** The connection's display name. Server-supplied; never an unmasked id. */
  subscriptionLabel: string
  /** The report's heading, drawn at the top of the rail while the run is in flight. */
  heading?: React.ReactNode
  /** The pinned preset's section titles, for the document preview. */
  sections?: readonly string[]
  coverTitle?: string
  coverKicker?: string
  /**
   * When the run entered each status, from `report_runs.phase_timings`. The page is
   * re-rendered on every status change (see `useRunStream`), so this stays current
   * without the stream carrying it.
   */
  phaseTimings?: Readonly<Record<string, string>> | null
}>) {
  const { run, gaps, steps, finished, connected } = useRunStream({
    initialRun,
    initialGaps,
  })

  const presentation = RUN_STATUS_PRESENTATION[run.status]

  // The status sentence. One polite region, carrying the status sentence and nothing
  // else: a screen reader reading out every progress tick of a twelve-minute run is
  // worse than silence.
  const statusLine = finished
    ? run.status === "completed"
      ? `This run completed. ${run.resourceCount ?? 0} resources collected, ${run.gapCount ?? 0} gaps recorded.`
      : "This run failed."
    : `${presentation.label}. This usually takes 8 to 12 minutes.`

  if (!finished) {
    return (
      <div
        data-slot="run-progress"
        className="grid overflow-hidden rounded-2xl border border-border bg-card lg:grid-cols-[22rem_minmax(0,1fr)]"
      >
        <aside className="flex flex-col gap-6 border-b border-border p-6 lg:border-r lg:border-b-0">
          {heading}

          <RunClock createdAt={run.createdAt} label={presentation.label} />

          <p data-slot="run-status-live" aria-live="polite" className="sr-only">
            {statusLine}
          </p>

          {presentation.inFlight && !connected ? (
            // Said plainly rather than hidden. The relay closes every two idle minutes on
            // purpose and the client reopens within a couple of seconds, so this is the
            // ordinary state during a long run — but a reader watching a static screen
            // deserves to know the difference between "nothing is happening" and "the
            // live view is between connections; the run is unaffected".
            <span data-slot="relay-reconnecting" className="text-xs text-muted-foreground">
              {messageText("ui.run_progress.reconnecting", "en")}
            </span>
          ) : null}

          <RunStages status={run.status} createdAt={run.createdAt} phaseTimings={phaseTimings} />

          {steps.length === 0 ? null : (
            <section aria-labelledby="run-activity-title" className="flex flex-col gap-3 border-t border-border pt-5">
              <h2 id="run-activity-title" className="text-sm font-semibold">
                {messageText("ui.run_progress.activity_heading", "en")}
              </h2>
              <ActivityTimeline steps={steps} />
            </section>
          )}

          <p className="mt-auto text-xs text-muted-foreground">
            {messageText("ui.run_progress.leave_hint", "en")}
          </p>
        </aside>

        <div className="bg-muted/40 bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[18px_18px] p-6 md:p-8">
          <RunDocumentPreview
            status={run.status}
            sections={sections}
            coverTitle={coverTitle}
            coverKicker={coverKicker}
          />
        </div>
      </div>
    )
  }

  // Finished while open. The page refreshes into the delivered (or failed) layout a
  // moment later; until it does, this says what happened and keeps the path behind a
  // summary — seven rows all reading "Complete" is the least informative thing on the
  // page.
  return (
    <section
      data-slot="run-progress"
      className="flex flex-col gap-6 rounded-xl border border-border bg-card p-4 md:p-5"
    >
      <p
        data-slot="run-status-live"
        aria-live="polite"
        className={
          run.status === "failed"
            ? "sr-only"
            : "max-w-prose text-sm text-muted-foreground"
        }
      >
        {statusLine}
      </p>

      {run.status === "failed" ? (
        <RunFailureNotice run={run} subscriptionLabel={subscriptionLabel} />
      ) : null}

      <details data-slot="run-path" className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground">
          <CaretRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          />
          {messageText("ui.run_progress.path", "en")}
        </summary>

        <div className="mt-2">
          <RunPhases status={run.status} />
        </div>
      </details>

      <section className="flex flex-col gap-3">
        <h2 className="text-section">
          {messageText("ui.run_progress.collection_gaps", "en")}
        </h2>

        {/*
          Mist neutrals, next to a possibly-red failure notice. A gap is *recorded*
          information about what could not be read — never silently zero-filled — and
          styling it as an error would push a consultant to treat the honest case as
          the broken one.
        */}
        <GapList gaps={gaps} />
      </section>
    </section>
  )
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

/** Subscribes a store reader to a one-second tick. */
function subscribeToSeconds(onTick: () => void): () => void {
  const timer = window.setInterval(onTick, 1000)
  return () => window.clearInterval(timer)
}

/**
 * The current second, ticking; `null` on the server pass so it and hydration agree.
 * Whole seconds, so the snapshot is stable between reads within one tick.
 */
function useNow(): number | null {
  return useSyncExternalStore(
    subscribeToSeconds,
    () => Math.floor(Date.now() / 1000) * 1000,
    () => null
  )
}

/**
 * How long the run has been going, as a clock. Elapsed time only: the run gives no
 * honest way to say how much is left, so nothing here estimates it.
 */
function RunClock({ createdAt, label }: Readonly<{ createdAt: string; label: string }>) {
  const now = useNow()
  const started = Date.parse(createdAt)
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-background px-4 py-3.5">
      <span aria-hidden="true" className="relative flex size-3 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-(--status-inflight) opacity-60 motion-reduce:animate-none" />
        <span className="relative size-3 rounded-full bg-(--status-inflight)" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold text-(--status-inflight)">{label}</span>
        <span className="text-xs text-muted-foreground">
          {messageText("ui.run_progress.elapsed", "en")}
        </span>
      </span>
      <span className="font-mono text-2xl font-medium tabular-nums">
        {now === null || !Number.isFinite(started) ? "–:––" : clock(now - started)}
      </span>
    </div>
  )
}

/**
 * The run's stages, down the rail: done ones with the time they took, the current one
 * with its time so far, and the rest dashed. Times come from `phase_timings`; a stage
 * whose entry was not recorded shows none rather than a guess.
 */
function RunStages({
  status,
  createdAt,
  phaseTimings,
}: Readonly<{
  status: RunView["status"]
  createdAt: string
  phaseTimings: Readonly<Record<string, string>> | null
}>) {
  const now = useNow()
  const phases = runPhases(status).filter((phase) => phase.status !== "completed")
  const enteredAt = (phase: RunView["status"]) => {
    const value = phase === "queued" ? createdAt : phaseTimings?.[phase]
    const parsed = value === undefined ? Number.NaN : Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return (
    <ol
      data-slot="run-stages"
      aria-label={messageText("ui.run_phases.label", "en") ?? undefined}
      className="flex flex-col"
    >
      {phases.map((phase, index) => {
        const from = enteredAt(phase.status)
        const next = index + 1 < phases.length ? enteredAt(phases[index + 1].status) : null
        const ms =
          from === null
            ? null
            : phase.standing === "done"
              ? next === null
                ? null
                : next - from
              : phase.standing === "current" && now !== null
                ? now - from
                : null
        const last = index === phases.length - 1
        return (
          <li
            key={phase.status}
            data-slot="run-stage"
            data-phase={phase.status}
            data-standing={phase.standing}
            className={cn("relative flex gap-3.5", last ? "" : "pb-4")}
          >
            {last ? null : (
              <span aria-hidden="true" className="absolute top-7 bottom-0 left-[13px] w-px bg-border" />
            )}
            <span
              aria-hidden="true"
              className={cn(
                "relative grid size-7 shrink-0 place-items-center rounded-full",
                phase.standing === "done" && "bg-(--status-verified-soft) text-(--status-verified)",
                phase.standing === "current" && "bg-primary text-primary-foreground",
                phase.standing === "pending" && "border-[1.5px] border-dashed border-input bg-card"
              )}
            >
              {phase.standing === "done" ? <CheckIcon weight="bold" className="size-3.5" /> : null}
              {phase.standing === "current" ? (
                <span className="size-2 animate-pulse rounded-full bg-primary-foreground motion-reduce:animate-none" />
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3 pt-1">
              <span
                className={cn(
                  "text-sm",
                  phase.standing === "current" && "font-semibold",
                  phase.standing === "pending" && "text-muted-foreground"
                )}
              >
                {RUN_STATUS_PRESENTATION[phase.status].label}
              </span>
              {ms === null ? null : (
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{clock(ms)}</span>
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
