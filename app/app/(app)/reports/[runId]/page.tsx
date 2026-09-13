import { PageBody } from "@/components/app-shell/page-body"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, ArrowUpRightIcon } from "@phosphor-icons/react/ssr"

import { Identifier } from "@/components/identifier"
import { DownloadCard } from "@/components/reports/download-card"
import { RunProgress } from "@/components/reports/run-progress"
import { RunStatusBadge } from "@/components/reports/run-status-badge"
import { SnapshotProvenance } from "@/components/reports/snapshot-provenance"
import { VerificationPanel } from "@/components/reports/verification-panel"
import { SecretExpiryBanner } from "@/components/subscriptions/secret-expiry-banner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { requireSession } from "@/lib/auth/guard"
import { monthName } from "@/lib/close/period"
import { toRunView, toVerificationView } from "@/lib/db/views"
import {
  loadRunDocumentHtml,
  readPinnedVersion,
  resolveRunExtras,
} from "@/lib/runs/detail"
import { loadRunGaps, loadRunProvenance } from "@/lib/runs/gaps"
import { periodLine } from "@/lib/runs/presentation"
import { findOwnedRun } from "@/lib/runs/state"
import { resolveSubscriptionState } from "@/lib/subscriptions/state"
import { getConnectedSubscription } from "@/lib/subscriptions/store"
import { latestForRun } from "@/lib/verifications/store"

/**
 * `/reports/[runId]` — one report (Requirements 36.7, 36.10, 36.11, 40.4).
 *
 * A **server** component with one live client leaf below it: `RunProgress`, which owns
 * the stream. Everything the first paint needs is read here and passed down, so the page
 * is correct before any connection opens — and a terminal run opens no connection at all.
 *
 * ## The order is the order a reader asks in
 *
 * Which report, for which period, and did it go out — the header answers all three, with
 * the status mark beside the title. Then, on a delivered run, the verdict and the
 * snapshot it rests on, then the downloads it licenses; then how the run went. On a run
 * still in flight there is no verdict yet, so the phase track sits directly under the
 * header, where the reader is looking.
 *
 * ## Terminal state is read from the row
 *
 * Requirement 36.7. `TIMEOUT` is written by the reaper when the run's container may
 * already be gone, so it arrives with **no event to carry it** — the row is read here and
 * handed to the client leaf as `initialRun`, so the failure notice renders on a page that
 * received no events.
 *
 * ## Two S3 reads, both on a terminal row only, and neither able to fail the page
 *
 * `loadRunGaps` and `loadRunProvenance` each return an empty result for a non-terminal run
 * **without making a request**, and both swallow a read failure. A completed run whose
 * snapshot object cannot be read is still a completed run.
 *
 * ## The expiry banner appears here too
 *
 * Requirement 13.2 puts the approaching-expiry warning on the run screens for that
 * subscription — because this is where a consultant looks when they are about to request
 * another one.
 */

type RunPageProps = Readonly<{ params: Promise<{ runId: string }> }>

export const metadata: Metadata = {
  title: "Report",
  description:
    "One report: its verdict, its snapshot provenance, its downloads and how the " +
    "run went.",
}

export default async function RunPage({ params }: RunPageProps) {
  const user = await requireSession()

  const { runId } = await params

  // Requirements 36.10, 36.11 — scoped by `user_id` inside the statement, so another
  // user's run matches no row and no field of it is read. `notFound()` rather than a
  // "forbidden" page: confirming the run exists would itself be a fact about somebody
  // else's customer.
  const run = await findOwnedRun(user.id, runId)
  if (run === undefined) notFound()

  const view = toRunView(run, await resolveRunExtras(run))

  const [gaps, provenance, documentHtml, verification, pinned] =
    await Promise.all([
      loadRunGaps(run),
      loadRunProvenance(run),
      loadRunDocumentHtml(run),
      latestForRun(run.id),
      run.templateVersionId === null
        ? Promise.resolve(null)
        : readPinnedVersion(run.templateVersionId),
    ])

  // The subscription may have been removed since the run — `report_runs` rows are audit
  // artifacts and outlive the connection they targeted — so this read is allowed to come
  // back empty and the page still renders.
  const subscription = await getConnectedSubscription(
    user.id,
    run.connectedSubscriptionId
  ).catch(() => null)

  const subscriptionName = subscription?.displayName ?? "Connector removed"
  const subscriptionMaskedId = subscription?.maskedSubscriptionId ?? null
  const subscriptionLabel =
    subscriptionMaskedId === null
      ? subscriptionName
      : `${subscriptionName} — ${subscriptionMaskedId}`

  const subscriptionState =
    subscription === null
      ? null
      : resolveSubscriptionState(subscription, new Date())

  const verificationView =
    verification.latest === undefined
      ? null
      : toVerificationView(verification.latest)

  const verified = verification.latest?.status === "pass"
  const delivered = run.status === "completed" && verified
  const terminal = run.status === "completed" || run.status === "failed"

  return (
    <PageBody kind="wide">
      <Link
        href="/reports"
        className="flex w-fit items-center gap-1.5 rounded-sm text-meta text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
        Reports
      </Link>

      <header className="flex min-w-0 flex-col gap-1.5">
        <p className="text-micro text-muted-foreground uppercase">
          {monthName(view.periodStart.slice(0, 7))}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-title text-balance">
            {view.templateName ?? subscriptionName}
          </h1>
          <RunStatusBadge status={view.status} />
        </div>
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta text-muted-foreground">
          <span>{subscriptionName}</span>
          {subscriptionMaskedId === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <Identifier
                value={subscriptionMaskedId}
                kind="mask"
                label="Subscription"
                className="text-muted-foreground"
              />
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="font-mono text-xs tabular-nums">{periodLine(view)}</span>
        </p>
      </header>

      {subscriptionState?.kind === "expiring" ? (
        <SecretExpiryBanner state={subscriptionState} />
      ) : null}

      {/*
        The verdict leads a finished run. A short reveal, because these arrive mid-read:
        they appear on the `router.refresh()` that follows the run going terminal, on a
        page somebody is already looking at. `prefers-reduced-motion` keeps the result
        and drops the movement.

        Two columns only when there are two things to put in them — the snapshot card
        renders for a `completed` run alone.
      */}
      {terminal ? (
        <div
          className={
            run.status === "completed"
              ? "grid items-start gap-5 duration-200 animate-in fade-in-0 slide-in-from-bottom-2 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
              : "grid items-start gap-5 duration-200 animate-in fade-in-0 slide-in-from-bottom-2"
          }
        >
          {/*
            Requirement 39 — rendered for every terminal run, including one with no
            verification: an absent section is indistinguishable from one that failed to
            load.
          */}
          <VerificationPanel
            verification={verificationView}
            delivered={delivered}
          />

          {run.status === "completed" ? (
            <Card data-slot="snapshot-card">
              <CardHeader>
                <CardTitle>Snapshot</CardTitle>
              </CardHeader>

              <CardContent className="flex flex-col gap-4">
                <p className="max-w-prose text-meta text-muted-foreground">
                  Content-addressed: its id is the hash of its bytes, so a figure
                  quoted from this report traces to exactly the data it came from.
                </p>

                <SnapshotProvenance run={view} provenance={provenance} />

                {/*
                  Requirements 4.9, 9.9 — the pinned version and its digest, so the rule
                  ("last full month") and the dates it resolved to stay distinct facts.
                */}
                {pinned === null ? null : (
                  <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-xs text-muted-foreground">
                        Rendered from
                      </dt>
                      <dd className="text-sm font-medium">
                        {pinned.templateName}{" "}
                        <span className="font-mono tabular-nums">
                          v{pinned.version}
                        </span>
                      </dd>
                    </div>

                    <div className="flex min-w-0 flex-col gap-0.5">
                      <dt className="text-xs text-muted-foreground">
                        Definition digest
                      </dt>
                      <dd>
                        <Identifier
                          value={pinned.definitionSha256}
                          kind="digest"
                          label="Definition digest"
                          className="text-muted-foreground"
                        />
                      </dd>
                    </div>
                  </dl>
                )}

                {documentHtml === null ? null : (
                  <Link
                    href={`/reports/${runId}/figures`}
                    className="flex w-fit items-center gap-1.5 rounded-lg text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    Trace every figure
                    <ArrowUpRightIcon aria-hidden="true" className="size-4" />
                  </Link>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/*
        Requirement 40.1 — one control per recorded artifact, and only while the run is
        `completed` **and** its stored verification passed. The gate is this one
        expression rather than a prop the card has to honour.
      */}
      {delivered ? (
        <div className="duration-200 animate-in fade-in-0 slide-in-from-bottom-2">
          <DownloadCard artifactKeys={view.artifactKeys} />
        </div>
      ) : null}

      <section
        aria-label="Run"
        className="rounded-xl border border-border bg-card p-4 md:p-5"
      >
        <RunProgress
          initialRun={view}
          initialGaps={gaps}
          subscriptionLabel={subscriptionLabel}
        />
      </section>
    </PageBody>
  )
}
