import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { SealCheckIcon } from "@phosphor-icons/react/ssr"

import { FileCheck } from "@/components/proof/file-check"
import { readProof } from "@/lib/proof/read"

/**
 * `/v/<run id>` — public: anyone holding a report checks it is genuine. The link is printed
 * on the report's cover. It states only what proves the file, never whose report it is.
 */

export const metadata: Metadata = {
  title: "Verify a report",
  description: "Check that a cloud report is the one that was verified.",
  robots: { index: false, follow: false },
}

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
const instant = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Jakarta",
})

export default async function ProofPage({ params }: Readonly<{ params: Promise<{ runId: string }> }>) {
  const proof = await readProof((await params).runId)
  if (proof === null) notFound()

  const facts: [string, string][] = [
    ["Period", `${day.format(new Date(`${proof.periodStart}T00:00:00Z`))} – ${day.format(new Date(`${proof.periodEnd}T00:00:00Z`))} · ${proof.timezone}`],
    ["Verified", `${instant.format(new Date(proof.verifiedAt))} WIB`],
    ["Figures traced to the collected data", proof.figureCount.toLocaleString("en-US")],
    ["Snapshot", proof.snapshotSha256.slice(0, 12)],
  ]

  return (
    <main className="min-h-screen bg-background px-4 py-16">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        <header className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-(--status-verified-soft) text-(--status-verified)">
            <SealCheckIcon aria-hidden="true" weight="fill" className="size-6" />
          </span>
          <div className="flex flex-col gap-1">
            <h1 className="text-title">This report was verified</h1>
            <p className="text-meta text-muted-foreground">
              Every figure in it was traced to the data collected for it before it was delivered.
            </p>
          </div>
        </header>
        <dl className="overflow-hidden rounded-xl border border-border bg-card">
          {facts.map(([label, value]) => (
            <div key={label} className="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-border/60 px-4 py-3 first:border-t-0">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="font-mono text-sm tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <section aria-labelledby="check-title" className="flex flex-col gap-2">
          <h2 id="check-title" className="text-section">
            Check your copy
          </h2>
          <FileCheck pdfSha256={proof.pdfSha256} docxSha256={proof.docxSha256} styledPdfSha256={proof.styledPdfSha256} />
        </section>
      </div>
    </main>
  )
}
