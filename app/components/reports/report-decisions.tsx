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
      className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 md:px-6 md:py-5"
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
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed marker:text-muted-foreground">
        {glance.decisions.map((decision) => (
          <li key={decision}>{decision}</li>
        ))}
      </ul>
    </section>
  )
}
