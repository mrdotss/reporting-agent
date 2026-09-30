import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { DownloadSimpleIcon, SealCheckIcon } from "@phosphor-icons/react/ssr"

import { buttonVariants } from "@/components/ui/button"
import { openDelivery } from "@/lib/delivery/store"
import { periodName } from "@/lib/delivery/email"

/**
 * `/r/<token>` — public: the page a customer's email links to. The token is the only
 * credential, it expires, and each visit is counted as an open.
 *
 * At a glance is shown as the report printed it (`glance.json`), so this page states no
 * figure the verified document does not.
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

  const downloads = [
    ...(report.designedPdf ? [{ kind: "styled", label: "Designed PDF" }] : []),
    { kind: "pdf", label: report.designedPdf ? "Plain PDF" : "PDF" },
    { kind: "docx", label: "Word" },
  ]

  return (
    <main className="min-h-screen bg-background px-4 py-16">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-micro text-muted-foreground uppercase">{report.customer}</p>
          <h1 className="text-title">Your {periodName(report.periodStart)} cloud report</h1>
          <p className="flex items-start gap-2 text-meta text-muted-foreground">
            <SealCheckIcon aria-hidden="true" weight="fill" className="mt-0.5 size-4 shrink-0 text-(--status-verified)" />
            <span>
              Every one of its {report.figureCount.toLocaleString("en-US")} figures was checked against the data collected
              for it. This link works until {day.format(new Date(report.linkExpiresAt))}.
            </span>
          </p>
        </header>

        {report.glance === null ? null : (
          <section aria-labelledby="glance-title" className="flex flex-col gap-4">
            <h2 id="glance-title" className="text-section">
              At a glance
            </h2>
            <dl className="grid grid-cols-2 gap-3">
              {report.glance.figures.map((figure) => (
                <div key={figure.label} className="flex flex-col-reverse gap-1 rounded-xl border border-border bg-card px-4 py-3">
                  <dt className="text-sm text-muted-foreground">{figure.label}</dt>
                  <dd className="font-mono text-2xl font-semibold tabular-nums">{figure.value}</dd>
                </div>
              ))}
            </dl>
            {report.glance.decisions.length === 0 ? null : (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{report.glance.decisionsTitle}</h3>
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed">
                  {report.glance.decisions.map((decision) => (
                    <li key={decision}>{decision}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <section aria-labelledby="download-title" className="flex flex-col gap-3">
          <h2 id="download-title" className="text-section">
            Download the report
          </h2>
          <div className="flex flex-wrap gap-2">
            {downloads.map((file, index) => (
              <a
                key={file.kind}
                href={`/r/${token}/download?kind=${file.kind}`}
                className={buttonVariants({ variant: index === 0 ? "default" : "outline" })}
              >
                <DownloadSimpleIcon aria-hidden="true" />
                {file.label}
              </a>
            ))}
          </div>
        </section>

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
