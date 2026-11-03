import { ListChecksIcon } from "@phosphor-icons/react/ssr"

import type { Glance } from "@/lib/delivery/glance"
import { messageText } from "@/lib/messages/catalog"

/**
 * The report's own decisions, above the detail tabs.
 *
 * These are the sentences At a glance printed, read back from `glance.json`, so the page
 * says exactly what the document says and nothing a model wrote afterwards. A consultant
 * opening a verified report usually wants these first: they are what the customer will be
 * asked to act on. Nothing renders when the report has no At a glance section or no
 * decisions in it.
 */
export function ReportDecisions({ glance }: Readonly<{ glance: Glance | null }>) {
  if (glance === null || glance.decisions.length === 0) return null

  return (
    <section
      aria-labelledby="report-decisions-title"
      data-slot="report-decisions"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 md:px-6 md:py-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <ListChecksIcon aria-hidden="true" className="size-4 shrink-0 self-center text-primary" />
        <h2 id="report-decisions-title" className="text-[15px] font-semibold">
          {glance.decisionsTitle}
        </h2>
        <p className="text-meta text-muted-foreground">
          {messageText("ui.report_decisions.source", "en")}
        </p>
      </div>
      <ol className="flex flex-col gap-2">
        {glance.decisions.map((decision, index) => (
          <li
            key={decision}
            className="flex gap-3.5 rounded-lg bg-muted/50 px-3.5 py-2.5 text-sm leading-relaxed"
          >
            <span aria-hidden="true" className="pt-px font-mono text-xs text-primary tabular-nums">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="min-w-0">{decision}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
