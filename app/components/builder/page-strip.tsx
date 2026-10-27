"use client"

import { useBuilder } from "@/components/builder/context"
import { FiguresSwitch } from "@/components/builder/figures-switch"
import type { PageRun } from "@/lib/builder/store"
import { cn } from "@/lib/utils"

/**
 * The document's pages as a strip under the top bar, from the canvas's measured page runs.
 *
 * One small page per printed page, grouped by what starts it (the cover, the front matter, a
 * section, a page break), with the estimated total. Clicking a section's pages selects that
 * section and brings it into view. The count is an estimate and says so: it measures the page as
 * drawn, with each repeated group counted once per resource drawn. At the end, the switch
 * between sample and real figures.
 */

const MAX_TILES = 48

type Row = { readonly run: PageRun; readonly first: number; readonly last: number; readonly tiles: number }

/** Each run's page numbers and how many of its pages still get a tile under the cap. */
export function layoutTiles(runs: readonly PageRun[]): Row[] {
  const rows: Row[] = []
  let page = 0
  let shown = 0
  for (const run of runs) {
    const tiles = Math.max(0, Math.min(run.pages, MAX_TILES - shown))
    rows.push({ run, first: page + 1, last: page + run.pages, tiles })
    page += run.pages
    shown += tiles
  }
  return rows
}

export function PageStrip() {
  const runs = useBuilder((state) => state.pageRuns)
  const selection = useBuilder((state) => state.selection)
  const select = useBuilder((state) => state.select)
  const setMode = useBuilder((state) => state.setMode)
  if (runs === null) return null

  const total = runs.reduce((sum, run) => sum + run.pages, 0)
  const selectedSectionId = selection !== null && "sectionId" in selection ? selection.sectionId : null
  const rows = layoutTiles(runs)
  const shown = rows.reduce((sum, row) => sum + row.tiles, 0)

  return (
    <nav
      aria-label="Pages"
      data-slot="page-strip"
      className="flex min-h-11 items-center gap-3 overflow-x-auto border-b border-border bg-muted/30 px-3 py-1.5"
    >
      <span
        title="Estimated from the page as drawn, with the sample data's resources"
        className="shrink-0 text-xs font-medium whitespace-nowrap text-muted-foreground"
      >
        About {total} {total === 1 ? "page" : "pages"}
      </span>
      <ol className="flex items-end gap-1.5">
        {rows.map(({ run, first, last, tiles }) => {
          if (tiles === 0) return null
          const current = run.sectionId !== undefined && run.sectionId === selectedSectionId
          const label = `${run.label}: ${run.pages === 1 ? `page ${first}` : `pages ${first} to ${last}`}`
          return (
            <li key={run.key}>
              <button
                type="button"
                title={label}
                aria-label={label}
                aria-current={current ? "true" : undefined}
                disabled={run.sectionId === undefined}
                onClick={() => {
                  if (run.sectionId === undefined) return
                  setMode("edit")
                  select({ kind: "section", sectionId: run.sectionId })
                }}
                className="flex items-end gap-0.5 rounded-sm p-0.5 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
              >
                {Array.from({ length: tiles }, (_, index) => (
                  <span
                    key={index}
                    aria-hidden
                    className={cn(
                      "grid h-7 w-5 place-items-end justify-center rounded-[2px] border bg-white pb-px font-mono text-[8px] leading-none text-muted-foreground tabular-nums",
                      current ? "border-primary ring-1 ring-primary" : "border-border"
                    )}
                  >
                    {first + index}
                  </span>
                ))}
              </button>
            </li>
          )
        })}
      </ol>
      {total > shown && <span className="shrink-0 text-xs text-muted-foreground">+{total - shown}</span>}
      <FiguresSwitch />
    </nav>
  )
}
