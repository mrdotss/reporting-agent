import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleIcon,
} from "@phosphor-icons/react/ssr"

import type { RunStatus } from "@/lib/db/schema"
import { messageText } from "@/lib/messages/catalog"
import { RUN_STATUS_PRESENTATION, runPhases } from "@/lib/runs/presentation"
import { cn } from "@/lib/utils"

/**
 * The whole path a run takes, with the one it is in marked.
 *
 * `ActivityTimeline` beside this shows what the agent has *reported* — it starts empty
 * and grows as events arrive, so for the first minute of a twelve-minute run it says
 * "Waiting for a worker to pick this run up" and nothing else. True, and it leaves the
 * reader unable to tell a run that is starting from one that is stuck, because there is
 * no visible path for it to be somewhere along.
 *
 * So this is the path, and the timeline is the detail within it. The path comes from
 * `runStatus`'s declared order, not from events: it is the same six phases for every run
 * and it is known before the run starts.
 *
 * **Nothing here is a percentage.** A run spends most of its time in `collecting`, so a
 * bar drawn from "2 of 6 phases" would read as a third done and be wrong for most of the
 * run. Position is honest; duration would not be. The counts that *are* real — resources
 * fetched, of how many — arrive from the agent and the timeline shows them.
 */
export function RunPhases({
  status,
}: Readonly<{
  status: RunStatus
}>) {
  const phases = runPhases(status)

  return (
    <ol
      data-slot="run-phases"
      aria-label={messageText("ui.run_phases.label", "en") ?? undefined}
      className="flex flex-col"
    >
      {phases.map(({ status: phase, standing }) => {
        const presentation = RUN_STATUS_PRESENTATION[phase]
        return (
          <li
            key={phase}
            data-slot="run-phase"
            data-phase={phase}
            data-standing={standing}
            className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0"
          >
            <span className="flex items-center gap-2.5">
              {standing === "done" ? (
                <CheckCircleIcon
                  aria-hidden="true"
                  weight="fill"
                  className="size-4 shrink-0 text-primary"
                />
              ) : standing === "current" ? (
                <CircleDashedIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                />
              ) : (
                <CircleIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground/45"
                />
              )}

              <span
                className={cn(
                  "text-sm",
                  standing === "pending" && "text-muted-foreground"
                )}
              >
                {presentation.label}
              </span>
            </span>

            <span className="text-xs text-muted-foreground">
              {standing === "done"
                ? messageText("ui.run_phases.complete", "en")
                : standing === "current"
                  ? messageText("ui.run_phases.in_progress", "en")
                  : messageText("ui.run_phases.pending", "en")}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
