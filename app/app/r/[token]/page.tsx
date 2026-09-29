import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { DownloadSimpleIcon } from "@phosphor-icons/react/ssr"

import { buttonVariants } from "@/components/ui/button"
import { openDelivery } from "@/lib/delivery/store"
import { periodName } from "@/lib/delivery/email"

/**
 * `/r/<token>` — public: the page a customer's email links to. The token is the only
 * credential, it expires, and each visit is counted as an open.
 */

export const metadata: Metadata = {
  title: "Your cloud report",
  robots: { index: false, follow: false },
}

export const dynamic = "force-dynamic"

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" })

export default async function DeliveredReportPage({ params }: Readonly<{ params: Promise<{ token: string }> }>) {
  const { token } = await params
  const report = await openDelivery(token)
  if (report === null) notFound()

  return (
    <main className="min-h-screen bg-background px-4 py-16">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        <header className="flex flex-col gap-1">
          <p className="text-micro text-muted-foreground uppercase">{report.customer}</p>
          <h1 className="text-title">Your {periodName(report.periodStart)} cloud report</h1>
          <p className="text-meta text-muted-foreground">
            Every one of its {report.figureCount.toLocaleString("en-US")} figures was checked against the data collected for it.
            This link works until {day.format(new Date(report.linkExpiresAt))}.
          </p>
        </header>
        <div className="flex flex-wrap gap-2">
          <a href={`/r/${token}/download?kind=pdf`} className={buttonVariants()}>
            <DownloadSimpleIcon aria-hidden="true" />
            Download PDF
          </a>
          <a href={`/r/${token}/download?kind=docx`} className={buttonVariants({ variant: "outline" })}>
            <DownloadSimpleIcon aria-hidden="true" />
            Download Word
          </a>
        </div>
        <p className="text-sm text-muted-foreground">
          Forwarding it? Anyone can check a copy is genuine at{" "}
          <Link href={`/v/${report.runId}`} className="text-primary underline underline-offset-3">
            its verification page
          </Link>
          .
        </p>
      </div>
    </main>
  )
}
