"use client"

import { useEffect, useRef, useState } from "react"

import {
  REPLAY_STATE_EVENT,
  REPLAY_TOGGLE_EVENT,
} from "@/components/reports/watch-run-button"
import type { RunStatus } from "@/lib/db/schema"
import { messageText } from "@/lib/messages/catalog"
import { RUN_PHASE_ORDER, RUN_STATUS_PRESENTATION } from "@/lib/runs/presentation"
import { cn } from "@/lib/utils"

/**
 * A finished run's six phases, which the header's "Watch this run" replays.
 *
 * ## What "recorded" means here
 *
 * Every status write stamps the instant the run entered that status into
 * `report_runs.phase_timings`, so a run finished after that column existed replays each
 * phase at its own proportion of the real run — twelve minutes shown in about nine
 * seconds. A run finished before it has only three real instants: created, claimed and
 * last updated. Its replay says so, shows the real queue wait and total, and paces the
 * phases evenly rather than inventing a split nobody measured.
 *
 * Nothing here re-runs anything. It is a presentation of what the row already records.
 */

const PHASES = RUN_PHASE_ORDER.filter(
  (status) => status !== "completed" && status !== "failed"
)

/** How long the whole replay takes, whatever the run took. */
const REPLAY_MS = 9000

/** No phase flashes past faster than this, even a four-second one in a twelve-minute run. */
const MIN_PHASE_MS = 450

type PhaseTiming = { readonly status: RunStatus; readonly ms: number | null }

function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

function timingsFor(
  createdAt: string,
  claimedAt: string | null,
  finishedAt: string,
  phaseTimings: Readonly<Record<string, string>> | null
): { phases: readonly PhaseTiming[]; recorded: boolean; totalMs: number } {
  const at = (iso: string | null | undefined) =>
    iso === null || iso === undefined ? Number.NaN : Date.parse(iso)

  const start = at(createdAt)
  const end = at(phaseTimings?.completed ?? phaseTimings?.failed ?? finishedAt)
  const entry = (status: RunStatus): number =>
    status === "queued"
      ? start
      : status === "claimed"
        ? at(phaseTimings?.claimed ?? claimedAt)
        : at(phaseTimings?.[status])

  const entries = PHASES.map(entry)
  const recorded = entries.every((value) => Number.isFinite(value))

  const phases = PHASES.map((status, index) => {
    const from = entries[index]
    const to = index + 1 < entries.length ? entries[index + 1] : end
    const ms = Number.isFinite(from) && Number.isFinite(to) ? to - from : null
    return { status, ms: ms !== null && ms >= 0 ? ms : null }
  })

  return {
    phases,
    recorded,
    totalMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : 0,
  }
}

export function RunReplay({
  status,
  createdAt,
  claimedAt,
  finishedAt,
  phaseTimings,
}: Readonly<{
  status: RunStatus
  createdAt: string
  claimedAt: string | null
  finishedAt: string
  phaseTimings: Readonly<Record<string, string>> | null
}>) {
  const { phases, recorded, totalMs } = timingsFor(
    createdAt,
    claimedAt,
    finishedAt,
    phaseTimings
  )
  const failed = status === "failed"

  // `null` when idle; otherwise the index of the phase being replayed and when it began.
  const [playing, setPlaying] = useState<{ index: number; startedAt: number } | null>(null)
  const [progress, setProgress] = useState(0)
  const frame = useRef<number | null>(null)

  const known = phases.map((phase) => phase.ms ?? 0)
  const knownTotal = known.reduce((sum, ms) => sum + ms, 0)
  const durations = phases.map((phase) =>
    recorded && knownTotal > 0
      ? Math.max(MIN_PHASE_MS, (REPLAY_MS * (phase.ms ?? 0)) / knownTotal)
      : REPLAY_MS / phases.length
  )

  // The header button toggles the replay.
  useEffect(() => {
    const onToggle = () => {
      setProgress(0)
      setPlaying((current) =>
        current === null ? { index: 0, startedAt: performance.now() } : null
      )
    }
    window.addEventListener(REPLAY_TOGGLE_EVENT, onToggle)
    return () => window.removeEventListener(REPLAY_TOGGLE_EVENT, onToggle)
  }, [])

  // …and learns whether it is running, so it can say Stop.
  const replaying = playing !== null
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(REPLAY_STATE_EVENT, { detail: { playing: replaying } })
    )
  }, [replaying])

  useEffect(() => {
    if (playing === null) return
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const tick = (now: number) => {
      const duration = reduceMotion ? 250 : durations[playing.index]
      const elapsed = now - playing.startedAt
      if (elapsed >= duration) {
        setProgress(0)
        setPlaying(
          playing.index + 1 < phases.length
            ? { index: playing.index + 1, startedAt: now }
            : null
        )
        return
      }
      setProgress(elapsed / duration)
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
    // `durations` is derived from props that do not change while a replay runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, phases.length])

  return (
    <section
      aria-labelledby="run-replay-title"
      data-slot="run-replay"
      className="flex scroll-mt-20 flex-col gap-4 rounded-xl border border-border bg-card p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="run-replay-title" className="text-section">
            {messageText("ui.run_replay.heading", "en")}
          </h2>
          <p aria-live="polite" className="text-meta text-muted-foreground">
            {replaying
              ? `Replaying ${RUN_STATUS_PRESENTATION[phases[playing.index].status].label.toLowerCase()}…`
              : failed
                ? "Stopped before a document was delivered."
                : "Verified — every figure in the document traced to the snapshot."}
          </p>
        </div>
        <span className="flex items-baseline gap-1.5">
          <span className="font-mono text-[15px] tabular-nums">{clock(totalMs)}</span>
          <span className="text-xs text-muted-foreground">
            {messageText("ui.run_replay.elapsed", "en")}
          </span>
        </span>
      </div>

      <ol
        aria-label={messageText("ui.run_replay.phases_label", "en") ?? undefined}
        className="grid grid-cols-2 gap-x-1.5 gap-y-3 sm:grid-cols-3 lg:grid-cols-6"
      >
        {phases.map((phase, index) => {
          const done = replaying ? index < playing.index : true
          const current = replaying && index === playing.index
          // On a failed run, the last phase with a recorded entry is where it stopped.
          const stoppedHere =
            failed && !replaying && index === phases.findLastIndex((p) => p.ms !== null)
          const fill = current ? progress : done ? 1 : 0

          return (
            <li key={phase.status} className="flex min-w-0 flex-col gap-2">
              <span aria-hidden="true" className="relative block h-1.5 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    stoppedHere
                      ? "bg-(--status-failed)"
                      : current
                        ? "bg-(--status-inflight)"
                        : "bg-(--status-verified)"
                  )}
                  style={{ width: `${fill * 100}%` }}
                />
              </span>
              <span className="flex items-baseline justify-between gap-1.5">
                <span
                  className={cn(
                    "truncate text-meta font-medium",
                    replaying && !done && !current && "text-muted-foreground",
                    stoppedHere && "text-(--status-failed)"
                  )}
                >
                  {RUN_STATUS_PRESENTATION[phase.status].label}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                  {(recorded || phase.status === "queued") && phase.ms !== null
                    ? clock(phase.ms)
                    : "—"}
                </span>
              </span>
            </li>
          )
        })}
      </ol>

      {recorded ? null : (
        <p className="text-xs text-muted-foreground">
          {messageText("ui.run_replay.not_recorded", "en")}
        </p>
      )}
    </section>
  )
}
