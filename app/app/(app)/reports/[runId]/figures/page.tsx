import { PageBody } from "@/components/app-shell/page-body"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon } from "@phosphor-icons/react/ssr"

import { PaperRender } from "@/components/reports/paper-render"
import { Badge } from "@/components/ui/badge"
import { requireSession } from "@/lib/auth/guard"
import { toRunView } from "@/lib/db/views"
import { loadRunDocumentHtml, resolveRunExtras } from "@/lib/runs/detail"
import { periodLine } from "@/lib/runs/presentation"
import { findOwnedRun } from "@/lib/runs/state"

/**
 * `/reports/[runId]/figures` — trace any number back to the snapshot it came from.
 *
 * ## Why this has a page of its own
 *
 * It used to be a disclosure at the foot of the run detail page, and it was the longest
 * thing on it by an order of magnitude: the whole document, rendered. Closed, it was a
 * row nobody opened; open, it buried the downloads and the verification under a page of
 * report.
 *
 * The capability itself is not optional. Hovering a figure and seeing its
 * `snapshot_path` and estimator is the product's own claim made checkable, and it
 * exists in exactly one component. So the section left the run page and the component
 * did not: it is a route now, linked from beside the downloads, and it opens on a reader
 * who came here to read.
 *
 * ## One S3 read, and it cannot fail the page into a 500
 *
 * `loadRunDocumentHtml` returns `null` for a non-terminal run without making a request
 * and swallows a read failure. A completed run whose document cannot be read still has
 * downloads and a verification on the page this one links back to, so an unreadable
 * artifact resolves to `notFound()` rather than an error.
 */

type FiguresPageProps = Readonly<{ params: Promise<{ runId: string }> }>

export const metadata: Metadata = {
  title: "Figures",
  description:
    "Every figure in one report, each traceable to the snapshot path and " +
    "estimator it was derived from.",
}

export default async function FiguresPage({ params }: FiguresPageProps) {
  const user = await requireSession()
  const { runId } = await params

  // Scoped by `user_id` inside the statement: another user's run matches no row.
  const run = await findOwnedRun(user.id, runId)
  if (run === undefined) notFound()

  const html = await loadRunDocumentHtml(run)
  if (html === null) notFound()

  const view = toRunView(run, await resolveRunExtras(run))

  return (
    <PageBody kind="reading">
      <header className="flex flex-col gap-3">
        <Link
          href={`/reports/${runId}`}
          className="flex w-fit items-center gap-1.5 rounded-lg text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          Back to this report
        </Link>

        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-title">
              Figures
            </h1>
            <p className="max-w-prose text-sm text-muted-foreground">
              Every number below carries the snapshot path and estimator it was
              derived from. Select one to see them.
            </p>
          </div>

          <Badge variant="secondary" className="font-mono tabular-nums">
            {periodLine(view)}
          </Badge>
        </div>
      </header>

      <PaperRender html={html} />
    </PageBody>
  )
}
