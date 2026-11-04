import { ShieldCheckIcon } from "@phosphor-icons/react/ssr"

import { ReportCover } from "@/components/reports/report-cover"
import { messageText } from "@/lib/messages/catalog"

/**
 * The top of a delivered report: a picture of its cover beside its name, what it covers,
 * the verdict in one sentence, and the actions a reader came for.
 *
 * Only for a report that completed **and** verified. A failed or unverified run keeps
 * the plain heading, because a cover would present as finished a document nobody should
 * send.
 */
export function RunHero({
  kicker,
  title,
  customer,
  coverKicker,
  badge,
  meta,
  finishedAt,
  verdictTitle,
  verdictDetail,
  actions,
}: Readonly<{
  /** The month the report covers, above the title. */
  kicker: string
  /** The preset's name: the report's title and the cover's. */
  title: string
  /** The customer it is for, printed on the cover; `null` when there is none. */
  customer: string | null
  /** The cover's own top line. */
  coverKicker: string
  /** The status badge beside the title. */
  badge: React.ReactNode
  /** The connection, masked id and period line. */
  meta: React.ReactNode
  /** When the run finished, already formatted. */
  finishedAt: string
  verdictTitle: string
  verdictDetail: string | null
  /** Download, replay. */
  actions: React.ReactNode
}>) {
  return (
    <section
      data-slot="run-hero"
      aria-labelledby="run-hero-title"
      className="grid items-center gap-6 rounded-2xl border border-border bg-card p-5 sm:grid-cols-[10rem_minmax(0,1fr)] md:gap-8 md:p-7 lg:grid-cols-[12.5rem_minmax(0,1fr)]"
    >
      <div className="mx-auto w-32 -rotate-2 sm:mx-0 sm:w-full">
        <ReportCover shape="portrait" title={title} customer={customer} kicker={coverKicker} />
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="font-mono text-xs tracking-[0.1em] text-primary uppercase">{kicker}</p>
          <p className="text-meta text-muted-foreground">
            {messageText("ui.run_hero.finished", "en", { when: finishedAt })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <h1 id="run-hero-title" className="text-title text-balance">
            {title}
          </h1>
          {badge}
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta text-muted-foreground">
          {meta}
        </div>

        <div className="flex items-start gap-2.5 text-sm">
          <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-[18px] shrink-0 text-(--status-verified)" />
          <p className="flex min-w-0 flex-col">
            <span className="font-medium">{verdictTitle}</span>
            {verdictDetail === null ? null : (
              <span className="text-meta text-muted-foreground">{verdictDetail}</span>
            )}
          </p>
        </div>

        <div className="mt-1 flex flex-wrap items-start gap-2">{actions}</div>
      </div>
    </section>
  )
}
