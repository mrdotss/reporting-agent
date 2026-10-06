"use client"

import {
  type AnswerFigure,
  type FigureTally,
  tallyLine,
} from "@/lib/chat/figures"
import { sourceLine } from "@/lib/chat/trace"
import { cn } from "@/lib/utils"

/**
 * "Figures in this answer": every number the answer quotes, in the order it meets them, with
 * the source each was read from. Choosing a row opens the same trace as choosing the figure
 * in the text — it is the way to reach a figure that sits inside a table cell or a long
 * paragraph, and the one place the whole answer's provenance reads at a glance.
 */
export function FigureLedger({
  figures,
  tally,
  selectedId,
  onSelect,
}: Readonly<{
  figures: readonly AnswerFigure[]
  tally: FigureTally
  selectedId: string | null
  onSelect: (factId: string) => void
}>) {
  if (figures.length === 0) return null

  return (
    <section
      aria-label="Figures in this answer"
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/50 px-3 py-2">
        <h3 className="text-micro text-muted-foreground uppercase">
          Figures in this answer
        </h3>
        <span className="text-xs text-muted-foreground">
          {tallyLine(tally)}
        </span>
      </div>
      <ol className="flex flex-col p-1">
        {figures.map((figure) => {
          const live = figure.citation?.source === "live"
          const selected = figure.factId === selectedId
          return (
            <li key={figure.factId}>
              <button
                type="button"
                onClick={() => onSelect(figure.factId)}
                aria-pressed={selected}
                aria-label={`Figure ${figure.number}: ${figure.text}. Show where it came from.`}
                className={cn(
                  "grid w-full grid-cols-[1.25rem_minmax(5rem,7rem)_minmax(0,1fr)] items-baseline gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 sm:grid-cols-[1.25rem_7rem_minmax(0,1fr)]",
                  selected && "bg-primary/[0.07] hover:bg-primary/[0.07]"
                )}
              >
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {figure.number}
                </span>
                <span
                  className={cn(
                    "truncate font-mono text-sm font-medium tabular-nums",
                    live || figure.citation === undefined
                      ? "text-foreground"
                      : "text-(--status-verified)"
                  )}
                >
                  {live ? (
                    <span className="mr-1 font-sans text-[0.6875rem] text-muted-foreground uppercase">
                      Live
                    </span>
                  ) : null}
                  {figure.text}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-meta">
                    {figure.citation?.label ?? "Source not recorded"}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {sourceLine(figure.citation)}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
