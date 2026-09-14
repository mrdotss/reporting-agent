import { PageBody } from "@/components/app-shell/page-body"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, ArrowUpRightIcon } from "@phosphor-icons/react/ssr"

import { Identifier } from "@/components/identifier"
import { DownloadCard } from "@/components/reports/download-card"
import { GapList } from "@/components/reports/gap-list"
import { RunFailureNotice } from "@/components/reports/run-failure-notice"
import { RunProgress } from "@/components/reports/run-progress"
import { RunReplay } from "@/components/reports/run-replay"
import { RunStatusBadge } from "@/components/reports/run-status-badge"
import { SnapshotProvenance } from "@/components/reports/snapshot-provenance"
import { UtilizationCard } from "@/components/reports/utilization-card"
import { VerificationPanel } from "@/components/reports/verification-panel"
import { SecretExpiryBanner } from "@/components/subscriptions/secret-expiry-banner"
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
import { loadTopUtilization } from "@/lib/runs/utilization"
import { resolveSubscriptionState } from "@/lib/subscriptions/state"
import { getConnectedSubscription } from "@/lib/subscriptions/store"
import { latestForRun } from "@/lib/verifications/store"

/**
 * `/reports/[runId]` — one report (Requirements 36.7, 36.10, 36.11, 40.4).
 *
 * ## The order is the order a reader asks in
 *
 * Which report, for which period, did it go out — and the download, beside the title.
 * Then, on a finished run: the verdict and the snapshot it rests on, the three busiest
 * machines, what could not be read, and the run itself with a way to watch it again. On a
 * run still in flight there is no verdict yet, so the live phase track sits directly
 * under the header.
 *
 * ## Terminal state is read from the row
 *
 * Requirement 36.7. `TIMEOUT` is written by the reaper with **no event to carry it**, so
 * the row is read here; a live leaf is mounted only while the run is in flight, and it
 * refreshes this page the moment the run goes terminal.
 *
 * ## The S3 reads cannot fail the page
 *
 * `loadRunGaps`, `loadRunProvenance` and `loadTopUtilization` each return an empty result
 * for a non-terminal run without a request, and swallow a read failure: a completed run
 * whose snapshot cannot be read is still a completed run.
 */

type RunPageProps = Readonly<{ params: Promise<{ runId: string }> }>

export const metadata: Metadata = {
  title: "Report",
  description:
    "One report: its verdict, its snapshot, its busiest machines, its gaps and how " +
    "the run went.",
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export default async function RunPage({ params }: RunPageProps) {
  const user = await requireSession()
  const { runId } = await params

  // Scoped by `user_id` inside the statement; another user's run is not found rather
  // than forbidden, because confirming it exists would itself be a fact about somebody
  // else's customer.
  const run = await findOwnedRun(user.id, runId)
  if (run === undefined) notFound()

  const view = toRunView(run, await resolveRunExtras(run))

  const [gaps, provenance, documentHtml, verification, pinned, machines] =
    await Promise.all([
      loadRunGaps(run),
      loadRunProvenance(run),
      loadRunDocumentHtml(run),
      latestForRun(run.id),
      run.templateVersionId === null
        ? Promise.resolve(null)
        : readPinnedVersion(run.templateVersionId),
      loadTopUtilization(run),
    ])

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
    subscription === null ? null : resolveSubscriptionState(subscription, new Date())

  const verificationView =
    verification.latest === undefined ? null : toVerificationView(verification.latest)

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

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
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
        </div>

        {/*
          Requirement 40.1 — one control per recorded artifact, and only while the run is
          `completed` **and** its stored verification passed. The gate is this expression.
        */}
        {delivered ? <DownloadCard artifactKeys={view.artifactKeys} /> : null}
      </header>

      {subscriptionState?.kind === "expiring" ? (
        <SecretExpiryBanner state={subscriptionState} />
      ) : null}

      {terminal ? (
        <>
          {/*
            A short reveal: these arrive on the refresh that follows the run going
            terminal, on a page somebody is already looking at.
          */}
          <div
            className={
              run.status === "completed"
                ? "grid items-start gap-5 duration-200 animate-in fade-in-0 slide-in-from-bottom-2 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
                : "grid items-start gap-5 duration-200 animate-in fade-in-0 slide-in-from-bottom-2"
            }
          >
            {/* Requirement 39 — rendered for every terminal run, verified or not. */}
            <VerificationPanel verification={verificationView} delivered={delivered} />

            {run.status === "completed" ? (
              <section
                aria-labelledby="snapshot-title"
                data-slot="snapshot-card"
                className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 md:p-5"
              >
                <div className="flex flex-col gap-0.5">
                  <h2 id="snapshot-title" className="text-section">
                    Snapshot
                  </h2>
                  <p className="text-meta text-muted-foreground">
                    Content-addressed: its id is the hash of its bytes.
                  </p>
                </div>

                <SnapshotProvenance run={view} provenance={provenance} />

                {pinned === null ? null : (
                  <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-xs text-muted-foreground">Rendered from</dt>
                      <dd className="text-sm font-medium">
                        {pinned.templateName}{" "}
                        <span className="font-mono tabular-nums">v{pinned.version}</span>
                      </dd>
                    </div>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <dt className="text-xs text-muted-foreground">Definition digest</dt>
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
              </section>
            ) : null}
          </div>

          {run.status === "failed" ? (
            <RunFailureNotice run={view} subscriptionLabel={subscriptionLabel} />
          ) : null}

          <UtilizationCard machines={machines} />

          <RunReplay
            status={run.status}
            createdAt={view.createdAt}
            claimedAt={iso(run.claimedAt)}
            finishedAt={view.updatedAt}
            phaseTimings={run.phaseTimings ?? null}
          />

          <section
            aria-labelledby="gaps-title"
            data-slot="collection-gaps"
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex flex-col gap-0.5 p-4 pb-3 md:px-5">
              <h2 id="gaps-title" className="text-section">
                Collection gaps
              </h2>
              <p className="text-meta text-muted-foreground">
                What could not be read, recorded instead of filled with zeros. A gap is
                information, not a failure.
              </p>
            </div>
            <div className="border-t border-border">
              {gaps.length === 0 ? (
                <div className="px-4 py-4 md:px-5">
                  <GapList gaps={gaps} />
                </div>
              ) : (
                <GapList gaps={gaps} />
              )}
            </div>
          </section>
        </>
      ) : (
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
      )}
    </PageBody>
  )
}
