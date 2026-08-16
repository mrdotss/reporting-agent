"use client"

import { ActivityTimeline } from "@/components/reports/activity-timeline"
import { GapList } from "@/components/reports/gap-list"
import { RunFailureNotice } from "@/components/reports/run-failure-notice"
import { RunStatusBadge } from "@/components/reports/run-status-badge"
import type { RunView } from "@/lib/db/views"
import type { RunGap } from "@/lib/runs/gaps"
import { RUN_STATUS_PRESENTATION } from "@/lib/runs/presentation"
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
}: Readonly<{
  initialRun: RunView
  initialGaps: readonly RunGap[]
  /** The connection's display name. Server-supplied; never an unmasked id. */
  subscriptionLabel: string
}>) {
  const { run, gaps, steps, finished, connected } = useRunStream({
    initialRun,
    initialGaps,
  })

  const presentation = RUN_STATUS_PRESENTATION[run.status]

  return (
    <div data-slot="run-progress" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <RunStatusBadge status={run.status} />

        {presentation.inFlight && !connected ? (
          // Said plainly rather than hidden. The relay closes every two idle minutes on
          // purpose and the client reopens within a couple of seconds, so this is the
          // ordinary state during a long run — but a reader watching a static screen
          // deserves to know the difference between "nothing is happening" and "the
          // live view is between connections; the run is unaffected".
          <span
            data-slot="relay-reconnecting"
            className="text-xs text-muted-foreground"
          >
            Reconnecting the live view. The run continues either way — its state
            is recorded, not streamed.
          </span>
        ) : null}
      </div>

      {/*
        Requirement 40.8's accessibility half. `aria-live="polite"` so the status is
        announced without interrupting, and the region exists in the DOM from first paint
        so a later change is announced rather than treated as new content.
      */}
      <p
        data-slot="run-status-live"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        {finished
          ? run.status === "completed"
            ? `This run completed. ${run.resourceCount ?? 0} resources collected, ${run.gapCount ?? 0} gaps recorded.`
            : "This run failed."
          : `${presentation.label}. This usually takes 8 to 12 minutes.`}
      </p>

      {run.status === "failed" ? (
        <RunFailureNotice run={run} subscriptionLabel={subscriptionLabel} />
      ) : null}

      <ActivityTimeline steps={steps} />

      {finished ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-heading text-sm font-medium tracking-tight">
            Collection gaps
          </h2>

          {/*
            Mist neutrals, next to a possibly-red failure notice. A gap is *recorded*
            information about what could not be read — never silently zero-filled — and
            styling it as an error would push a consultant to treat the honest case as
            the broken one.
          */}
          <GapList gaps={gaps} />
        </section>
      ) : null}
    </div>
  )
}
