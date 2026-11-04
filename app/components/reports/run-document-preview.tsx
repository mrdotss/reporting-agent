import { ShieldCheckIcon } from "@phosphor-icons/react"

import type { RunStatus } from "@/lib/db/schema"
import { messageText } from "@/lib/messages/catalog"
import { cn } from "@/lib/utils"

/**
 * The document a run is making, as a grid of pages: the cover, then one page per
 * section of the pinned preset.
 *
 * ## What it shows, and what it does not claim
 *
 * Every page changes together, by **phase**, because phase is all the run reports:
 * waiting (dashed and quiet) until the data is in, outlined while the sections are
 * put together, drawn while the document renders, and settled while every figure is
 * checked. The runtime does not say which page it is drawing, so no page is ever shown
 * as "this one now" — a tile that lit up one by one would be a progress bar inventing
 * its own pace. The sketch inside each tile is a fixed pattern, not data.
 */

/** How many section tiles show before the rest fold into "+N". */
const TILES_SHOWN = 11

type Stage = "waiting" | "outlined" | "drawn" | "checking"

function stageOf(status: RunStatus): Stage {
  if (status === "compiling") return "outlined"
  if (status === "rendering") return "drawn"
  if (status === "verifying" || status === "completed") return "checking"
  return "waiting"
}

export function RunDocumentPreview({
  status,
  sections,
  coverTitle,
  coverKicker,
}: Readonly<{
  status: RunStatus
  /** The pinned preset's section titles, in order. Empty for a run that pins none. */
  sections: readonly string[]
  coverTitle: string
  coverKicker: string
}>) {
  const stage = stageOf(status)
  const shown = sections.slice(0, TILES_SHOWN)
  const rest = sections.length - shown.length

  const caption =
    stage === "outlined"
      ? messageText("ui.run_document.compiling", "en")
      : stage === "drawn"
        ? messageText("ui.run_document.rendering", "en")
        : stage === "checking"
          ? messageText("ui.run_document.verifying", "en")
          : messageText("ui.run_document.waiting", "en")

  return (
    <section
      aria-labelledby="run-document-title"
      data-slot="run-document-preview"
      data-stage={stage}
      className="flex flex-col gap-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="run-document-title" className="text-[15px] font-semibold">
          {messageText("ui.run_document.heading", "en")}
        </h2>
        <p className="text-sm text-muted-foreground">{caption}</p>
      </div>

      <ol
        aria-label={messageText("ui.run_document.pages_label", "en") ?? undefined}
        className="grid grid-cols-3 gap-4 sm:grid-cols-4 xl:grid-cols-6"
      >
        <li className="flex min-w-0 flex-col gap-1.5">
          <span
            aria-hidden="true"
            className="flex aspect-[1/1.414] flex-col justify-end gap-1 overflow-hidden rounded-[4px] bg-(--auth-panel) p-2.5 text-(--auth-panel-foreground) shadow-[0_12px_24px_-14px_rgb(0_0_0/0.6)]"
          >
            <span className="truncate font-mono text-[7px] tracking-[0.08em] text-(--auth-panel-muted) uppercase">
              {coverKicker}
            </span>
            <span className="line-clamp-2 text-[11px] leading-tight font-semibold">{coverTitle}</span>
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {messageText("ui.run_document.cover", "en")}
          </span>
        </li>

        {shown.map((title, index) => (
          <li key={`${title}-${index}`} className="flex min-w-0 flex-col gap-1.5">
            <PageTile stage={stage} index={index} />
            <span className="truncate text-[11px] text-muted-foreground">{title}</span>
          </li>
        ))}

        {rest > 0 ? (
          <li className="flex min-w-0 flex-col gap-1.5">
            <span className="grid aspect-[1/1.414] place-items-center rounded-[4px] border border-dashed border-border text-xs font-medium text-muted-foreground">
              {messageText("ui.run_document.more", "en", { count: String(rest) })}
            </span>
          </li>
        ) : null}
      </ol>

      <p className="flex items-start gap-2.5 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
        {messageText("ui.run_document.verify_note", "en")}
      </p>
    </section>
  )
}

/** Fixed sketch heights; a pattern, not data. */
const SKETCH = [
  [55, 85, 40, 70],
  [80, 45, 65, 30],
  [35, 70, 90, 50],
] as const

function PageTile({ stage, index }: Readonly<{ stage: Stage; index: number }>) {
  const bars = SKETCH[index % SKETCH.length]

  if (stage === "waiting") {
    return (
      <span
        aria-hidden="true"
        className="block aspect-[1/1.414] animate-pulse rounded-[4px] border border-dashed border-border motion-reduce:animate-none"
        style={{ animationDelay: `${(index % 6) * 160}ms` }}
      />
    )
  }

  const paper = stage !== "outlined"
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex aspect-[1/1.414] flex-col gap-1 overflow-hidden rounded-[4px] p-2 transition-colors duration-500",
        paper
          ? "bg-(--auth-panel-foreground) shadow-[0_12px_24px_-14px_rgb(0_0_0/0.6)]"
          : "border border-dashed border-input"
      )}
    >
      <span className={cn("h-1 w-1/2 rounded-full", paper ? "bg-(--auth-panel)" : "bg-muted-foreground/40")} />
      <span className={cn("h-[3px] w-full rounded-full", paper ? "bg-(--auth-panel-muted)/60" : "bg-muted")} />
      <span className={cn("h-[3px] w-4/5 rounded-full", paper ? "bg-(--auth-panel-muted)/60" : "bg-muted")} />
      {paper ? (
        <span className="mt-1 flex h-6 items-end gap-[2px]">
          {bars.map((height, bar) => (
            <span
              key={bar}
              className="flex-1 rounded-t-[1px] bg-(--auth-panel-accent)"
              style={{ height: `${height}%` }}
            />
          ))}
        </span>
      ) : (
        <span className="mt-1 h-6 rounded-[2px] bg-muted" />
      )}
    </span>
  )
}
