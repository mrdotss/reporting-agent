"use client"

import { useId, useState } from "react"
import { CaretRightIcon } from "@phosphor-icons/react/ssr"

import { PaperRender } from "@/components/reports/paper-render"
import { messageText } from "@/lib/messages/catalog"
import type { Language } from "@/lib/messages/language"

/**
 * The paper rendering, behind a disclosure (task 2.5).
 *
 * ## Why it collapsed rather than went away
 *
 * Requirement 38 is eight criteria long and its user story is the product's own
 * claim made usable: *hover a number and see where it came from, without leaving
 * the report*. `FigureProvenance` — the reveal carrying a figure's `snapshot_path`,
 * its estimator label, keyboard reachability and the accessible description —
 * exists nowhere else in the app. Deleting this section would have left a
 * consultant no way to ask where a number came from.
 *
 * What was actually wrong with it is that it opened expanded, so every visit to a
 * run began with a long scroll past an approximation of a page — one whose own
 * banner admits its pagination, column widths and font metrics differ from the
 * delivered file. That is a lot of screen for something nobody arrived to read.
 *
 * So it is presented, as 38.1 requires, and closed. The downloads and the
 * verification sit above it; a consultant who wants to trace a figure opens it.
 * The rendering is only mounted once opened — it walks the whole document, and
 * paying for that on a page nobody expanded is work done for no reader.
 */
export function InspectFigures({
  html,
  language = "en",
}: Readonly<{ html: string; language?: Language }>) {
  const [open, setOpen] = useState(false)
  const panelId = useId()

  // Copy comes from the catalogue, as everything under `components/reports/`
  // does — `message-literals.static.test.ts` refuses an English string in a
  // text-emitting position here, because one that never reaches the catalogue
  // renders English in an Indonesian document.
  const heading = messageText("ui.inspect.heading", language) ?? ""
  const hint = messageText("ui.inspect.hint", language) ?? ""

  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-2 self-start rounded-lg px-1 py-1 text-left focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
      >
        <CaretRightIcon
          aria-hidden="true"
          className={`size-4 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="font-heading text-sm font-medium tracking-tight">
          {heading}
        </span>
        <span className="text-sm text-muted-foreground">{hint}</span>
      </button>

      {open ? (
        <div id={panelId}>
          <PaperRender html={html} />
        </div>
      ) : null}
    </section>
  )
}
