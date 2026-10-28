"use client"

import { useBuilder } from "@/components/builder/context"
import { FiguresSwitch } from "@/components/builder/figures-switch"
import type { PageRun } from "@/lib/builder/store"
import { cn } from "@/lib/utils"

/**
 * The document's pages as a strip under the top bar, from the canvas's measured page runs.
 *
 * One small page per printed page, sketched as the cover, front matter, a section's first page
 * or its body, grouped by what starts it (the cover, the front matter, a section, a page break),
 * with the estimated total and reading time; the last page is marked as the end. Clicking a section's pages selects that
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

/** About how long the document takes to read: a page of tables and charts reads in about half a minute. */
export function readMinutes(pages: number): number {
  return Math.max(1, Math.round(pages * 0.55))
}

/** What a page looks like at strip size: the cover's band, front matter's lines, a section's heading and body. */
type Sketch = "cover" | "front" | "start" | "body"

function sketchOf(run: PageRun, index: number): Sketch {
  if (run.key === "cover") return "cover"
  if (run.sectionId === undefined) return "front"
  return index === 0 && run.key.endsWith(":0") ? "start" : "body"
}

function PageSketch({ sketch }: { sketch: Sketch }) {
  const line = "mx-auto block rounded-[2px]"
  if (sketch === "cover") {
    return (
      <>
        <span className="block h-4 w-full rounded-t-[3px] bg-primary/80" />
        <span className={cn(line, "mt-2.5 h-1 w-3/5 bg-muted-foreground/30")} />
        <span className={cn(line, "mt-1 h-[3px] w-2/5 bg-border")} />
      </>
    )
  }
  if (sketch === "front") {
    return (
      <>
        <span className={cn(line, "mt-1.5 h-1 w-3/5 bg-muted-foreground/30")} />
        <span className={cn(line, "mt-1 h-[3px] w-[70%] bg-border")} />
        <span className={cn(line, "mt-[3px] h-[3px] w-[70%] bg-border")} />
        <span className={cn(line, "mt-[3px] h-[3px] w-[70%] bg-border")} />
      </>
    )
  }
  return (
    <>
      <span className={cn(line, "mt-1.5 h-1 w-3/5", sketch === "start" ? "bg-muted-foreground/30" : "bg-border")} />
      <span className={cn(line, "mt-[3px] h-[3px] w-[70%] bg-border")} />
      <span className={cn(line, "mt-[3px] h-3 w-[70%] bg-primary/15")} />
    </>
  )
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
      className="flex items-center gap-3 border-b border-border bg-background px-5 py-2"
    >
      <span
        title="Estimated from the page as drawn, with the sample data's resources"
        className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
      >
        {total} {total === 1 ? "page" : "pages"}, about {readMinutes(total)} min read
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto py-0.5">
        <ol className="flex items-center gap-2.5">
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
                  className="group flex items-center gap-1.5 rounded-md focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:cursor-default"
                >
                  {Array.from({ length: tiles }, (_, index) => {
                    const page = first + index
                    return (
                      <span
                        key={index}
                        aria-hidden
                        className={cn(
                          "flex h-[58px] w-12 flex-none flex-col rounded-[4px] border bg-white transition-colors",
                          current
                            ? "border-primary ring-1 ring-primary"
                            : "border-border group-enabled:group-hover:border-muted-foreground/50"
                        )}
                      >
                        <PageSketch sketch={sketchOf(run, index)} />
                        <span className="mt-auto mb-1 block text-center text-[10px] leading-none whitespace-nowrap text-muted-foreground tabular-nums">
                          {page === total ? `${page} · end` : page}
                        </span>
                      </span>
                    )
                  })}
                </button>
              </li>
            )
          })}
        </ol>
        {total > shown && <span className="shrink-0 text-xs text-muted-foreground">+{total - shown}</span>}
      </div>
      <FiguresSwitch />
    </nav>
  )
}
