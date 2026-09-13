import type { RunStatus } from "@/lib/db/schema"
import { messageText } from "@/lib/messages/catalog"
import { RUN_STATUS_PRESENTATION, runPhases } from "@/lib/runs/presentation"
import { cn } from "@/lib/utils"

/**
 * The whole path a run takes, as a horizontal track, with the phase it is in marked.
 *
 * `ActivityTimeline` below this shows what the agent has *reported* — it starts empty
 * and grows as events arrive. This is the path those reports sit along: the same six
 * phases for every run, known before the run starts, from `runStatus`'s declared order.
 *
 * **Nothing here is a percentage.** A run spends most of its time in `collecting`, so a
 * bar drawn from "2 of 6 phases" would read as a third done and be wrong for most of the
 * run. Each phase is its own segment, filled when done, hatched while current and empty
 * while pending — position is honest; duration would not be.
 */
export function RunPhases({
  status,
}: Readonly<{
  status: RunStatus
}>) {
  const phases = runPhases(status)
  const failed = status === "failed"

  return (
    <ol
      data-slot="run-phases"
      aria-label={messageText("ui.run_phases.label", "en") ?? undefined}
      className="grid grid-cols-2 gap-x-1.5 gap-y-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      {phases.map(({ status: phase, standing }) => {
        const presentation = RUN_STATUS_PRESENTATION[phase]
        const stoppedHere = failed && standing === "current"
        return (
          <li
            key={phase}
            data-slot="run-phase"
            data-phase={phase}
            data-standing={standing}
            className="flex min-w-0 flex-col gap-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                "block h-1.5 rounded-full",
                standing === "done" && "bg-(--status-verified)",
                standing === "current" &&
                  !stoppedHere &&
                  "animate-pulse bg-[repeating-linear-gradient(135deg,var(--status-inflight)_0_4px,color-mix(in_oklab,var(--status-inflight)_45%,transparent)_4px_8px)] motion-reduce:animate-none",
                stoppedHere && "bg-(--status-failed)",
                standing === "pending" && "bg-muted"
              )}
            />
            <span className="flex items-baseline justify-between gap-1.5">
              <span
                className={cn(
                  "truncate text-meta font-medium",
                  standing === "pending" && "text-muted-foreground",
                  stoppedHere && "text-(--status-failed)"
                )}
              >
                {presentation.label}
              </span>
              <span
                className={cn(
                  "shrink-0 text-xs text-muted-foreground",
                  standing === "current" && !stoppedHere && "text-(--status-inflight)"
                )}
              >
                {standing === "done"
                  ? messageText("ui.run_phases.complete", "en")
                  : standing === "current"
                    ? messageText("ui.run_phases.in_progress", "en")
                    : messageText("ui.run_phases.pending", "en")}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
