"use client"

import { useEffect, useRef, useState } from "react"
import { SealIcon, SealWarningIcon, ShieldCheckIcon } from "@phosphor-icons/react"

import {
  REPLAY_STATE_EVENT,
  REPLAY_TOGGLE_EVENT,
} from "@/components/reports/watch-run-button"
import type { RunStatus } from "@/lib/db/schema"
import { messageText } from "@/lib/messages/catalog"
import { RUN_PHASE_ORDER, RUN_STATUS_PRESENTATION } from "@/lib/runs/presentation"
import { cn } from "@/lib/utils"

/**
 * The summary at the top of a finished report: the verdict, the few numbers a reader
 * checks first, and the run's six phases as one bar, each phase as wide as the time it
 * took. The header's "Replay run" plays the bar back.
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

export type RunVerdict = Readonly<{
  tone: "verified" | "failed" | "neutral"
  title: string
  detail: string | null
}>

export type RunStat = Readonly<{ label: string; value: string }>

const VERDICT_ICON = {
  verified: ShieldCheckIcon,
  failed: SealWarningIcon,
  neutral: SealIcon,
} as const

export function RunReplay({
  status,
  createdAt,
  claimedAt,
  finishedAt,
  phaseTimings,
  verdict,
  stats = [],
}: Readonly<{
  status: RunStatus
  createdAt: string
  claimedAt: string | null
  finishedAt: string
  phaseTimings: Readonly<Record<string, string>> | null
  verdict: RunVerdict
  /** Shown beside the verdict, before the run time. */
  stats?: readonly RunStat[]
}>) {
  const { phases, recorded, totalMs } = timingsFor(
    createdAt,
    claimedAt,
    finishedAt,
    phaseTimings
  )
  const failed = status === "failed"
  // On a failed run, the last phase with a recorded entry is where it stopped.
  const stoppedAt = failed ? phases.findLastIndex((p) => p.ms !== null) : -1

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

  // The phase the caption talks about: the longest one, until the reader picks another.
  const longest = recorded && knownTotal > 0 ? known.indexOf(Math.max(...known)) : -1
  const [picked, setPicked] = useState<number>(longest)

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

  const Icon = VERDICT_ICON[verdict.tone]
  const label = (index: number) => RUN_STATUS_PRESENTATION[phases[index].status].label
  const time = (index: number) =>
    (recorded || phases[index].status === "queued") && phases[index].ms !== null
      ? clock(phases[index].ms ?? 0)
      : "—"

  const caption = replaying
    ? `Replaying ${label(playing.index).toLowerCase()}…`
    : failed && stoppedAt >= 0
      ? `Stopped while ${label(stoppedAt).toLowerCase()}`
      : picked >= 0 && recorded && knownTotal > 0
        ? `${label(picked)} took ${Math.round((100 * known[picked]) / knownTotal)}% of the run`
        : null

  return (
    <section
      aria-labelledby="run-replay-title"
      data-slot="run-replay"
      className="flex scroll-mt-20 flex-col gap-5 rounded-xl border border-border bg-card p-4 md:px-6 md:py-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-lg",
              verdict.tone === "verified" && "bg-(--status-verified-soft) text-(--status-verified)",
              verdict.tone === "failed" && "bg-(--status-failed-soft) text-(--status-failed)",
              verdict.tone === "neutral" && "bg-muted text-muted-foreground"
            )}
          >
            <Icon aria-hidden="true" className="size-[18px]" />
          </span>
          <div className="flex min-w-0 flex-col">
            <h2 id="run-replay-title" className="text-[15px] font-semibold text-balance">
              {verdict.title}
            </h2>
            {verdict.detail === null ? null : (
              <p className="text-meta text-muted-foreground">{verdict.detail}</p>
            )}
          </div>
        </div>

        <dl className="flex flex-wrap gap-y-3">
          {[...stats, { label: messageText("ui.run_replay.run_time", "en") ?? "run time", value: clock(totalMs) }].map(
            (stat) => (
              <div
                key={stat.label}
                className="flex flex-col-reverse border-l border-border px-4 first:border-l-0 first:pl-0 last:pr-0 md:px-5"
              >
                <dt className="text-meta text-muted-foreground">{stat.label}</dt>
                <dd className="font-mono text-2xl font-medium tracking-tight tabular-nums">{stat.value}</dd>
              </div>
            )
          )}
        </dl>
      </div>

      <div className="flex flex-col gap-2.5">
        <div
          role="group"
          aria-label={messageText("ui.run_replay.phases_label", "en") ?? undefined}
          className="flex gap-[3px]"
        >
          {phases.map((phase, index) => {
            const done = replaying ? index < playing.index : true
            const current = replaying && index === playing.index
            const fill = current ? progress : done ? 1 : 0
            const weight = recorded && knownTotal > 0 ? Math.max(1, phase.ms ?? 0) : 1
            const lost = failed && stoppedAt >= 0 && index > stoppedAt
            return (
              <button
                key={phase.status}
                type="button"
                aria-label={`${label(index)}, ${time(index)}`}
                aria-pressed={!replaying && picked === index}
                onClick={() => setPicked(index)}
                style={{ flex: `${weight} 1 0px` }}
                className="relative h-2.5 min-w-2 cursor-pointer overflow-hidden rounded-[3px] bg-primary/15 outline-none hover:bg-primary/25 focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-y-0 left-0",
                    index === stoppedAt
                      ? "bg-(--status-failed)"
                      : current
                        ? "bg-(--status-inflight)"
                        : !replaying && picked === index
                          ? "bg-primary"
                          : "bg-primary/35",
                    lost && "hidden"
                  )}
                  style={{ width: `${fill * 100}%` }}
                />
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
          {phases.map((phase, index) => (
            <button
              key={phase.status}
              type="button"
              onClick={() => setPicked(index)}
              className={cn(
                "flex cursor-pointer items-baseline gap-1.5 rounded-sm text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30",
                ((!replaying && picked === index) || (replaying && playing.index === index)) &&
                  "font-semibold text-foreground",
                index === stoppedAt && "text-(--status-failed)"
              )}
            >
              {label(index)}
              <span className="font-mono text-xs font-normal tabular-nums">{time(index)}</span>
            </button>
          ))}
          {caption === null ? null : (
            <span aria-live="polite" className="text-meta text-muted-foreground sm:ml-auto">
              {caption}
            </span>
          )}
        </div>
      </div>

      {recorded ? null : (
        <p className="text-xs text-muted-foreground">
          {messageText("ui.run_replay.not_recorded", "en")}
        </p>
      )}
    </section>
  )
}
