import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, ArrowUpRightIcon } from "@phosphor-icons/react/ssr"

import { DownloadCard } from "@/components/reports/download-card"
import { RequestDetails } from "@/components/reports/request-details"
import { RunProgress } from "@/components/reports/run-progress"
import { SnapshotProvenance } from "@/components/reports/snapshot-provenance"
import { VerificationPanel } from "@/components/reports/verification-panel"
import { SecretExpiryBanner } from "@/components/subscriptions/secret-expiry-banner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { requireSession } from "@/lib/auth/guard"
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
 * `/reports/[runId]` — one run's detail (Requirements 36.7, 36.10, 36.11, 40.4).
 *
 * A **server** component with exactly one client leaf below it: `RunProgress`, which owns
 * the stream. Everything the first paint needs is read here and passed down, so the page
 * is correct before any connection opens — and a terminal run opens no connection at all.
 *
 * ## What the heading says, and why it changed
 *
 * It used to be `displayName — ****…95a4`: a masked subscription id, 28 asterisks wide,
 * set as an `h1`. It named the connection rather than the report, so every run against
 * one customer had an identical, unreadable title. The heading is now the report — its
 * profile and its period — and the connection moved into the request rail, where an id
 * nobody reads left to right belongs.
 *
 * ## Terminal state is read from the row
 *
 * Requirement 36.7, and this page is where it bites hardest. `TIMEOUT` is written by the
 * reaper when the run's container may already be gone, so it arrives with **no event to
 * carry it** — a page that rendered only what the stream said would show a timed-out run
 * as still collecting, indefinitely. The row is read here and handed to the client leaf as
 * `initialRun`, so the failure notice renders on a page that received no events.
 *
 * ## Two S3 reads, both on a terminal row only, and neither able to fail the page
 *
 * `loadRunGaps` and `loadRunProvenance` each return an empty result for a non-terminal run
 * **without making a request**, and both swallow a read failure. A completed run whose
 * snapshot object cannot be read is still a completed run; failing this page because a gap
 * list was unavailable would turn a cosmetic problem into an apparent run failure.
 *
 * ## The figures live on their own route
 *
 * `loadRunDocumentHtml` is read here only to decide whether to *offer* the link. The
 * rendering itself — the whole document, every figure carrying its snapshot path — was
 * the longest thing on this page by an order of magnitude, and it sat behind a disclosure
 * nobody opened. `/reports/[runId]/figures` is that rendering, on a page whose reader
 * came for it.
 *
 * ## The expiry banner appears here too
 *
 * Requirement 13.2 puts the approaching-expiry warning on the run screens for that
 * subscription, not only on the subscriptions screen — because this is where a consultant
 * looks when they are about to request another one. It renders in **mist neutrals**: an
 * approaching expiry is information, and `--destructive` is reserved for a run that
 * failed.
 */

/**
 * The awaited-params shape Next 16 requires for a dynamic page: `params` is a
 * **Promise**, and synchronous access was removed
 * (`02-guides/upgrading/version-16.md`).
 */
type RunPageProps = Readonly<{ params: Promise<{ runId: string }> }>

export const metadata: Metadata = {
  title: "Report run",
  description:
    "One report run: its activity, its snapshot provenance and its recorded " +
    "collection gaps.",
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

  // Requirements 9.9, 37.1 — the pinned template's name and version number, and
  // the stored verification's status. Resolved through `template_version_id`, so
  // an archived report is presented against the version it was rendered from
  // even where a higher-numbered one exists.
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

  const subscriptionName = subscription?.displayName ?? "Subscription removed"
  const subscriptionMaskedId = subscription?.maskedSubscriptionId ?? null
  const subscriptionLabel =
    subscriptionMaskedId === null
      ? subscriptionName
      : `${subscriptionName} — ${subscriptionMaskedId}`

  const subscriptionState =
    subscription === null
      ? null
      : resolveSubscriptionState(subscription, new Date())

  const verified = verification.latest?.status === "pass"
  const delivered = run.status === "completed" && verified
  const terminal = run.status === "completed" || run.status === "failed"

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 lg:max-w-6xl">
      <header className="flex flex-col gap-3">
        <Link
          href="/reports"
          className="flex w-fit items-center gap-1.5 rounded-lg text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          All reports
        </Link>

        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="font-heading text-2xl font-medium tracking-tight text-balance">
            {view.templateName ?? subscriptionName}
          </h1>

          {/* The zone travels with the dates, on every surface that names a period. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span className="font-mono tabular-nums">{periodLine(view)}</span>
            <span aria-hidden="true">·</span>
            <span>{subscriptionName}</span>
          </p>
        </div>
      </header>

      {/*
        Requirement 13.2 — the warning follows the subscription onto the run screens.
        Only the `expiring` state renders a banner here; `expired` and `disabled` are
        surfaced on the subscriptions screen with their rotate action, and a run against
        such a subscription fails with `AUTH_EXPIRED`, which the failure notice explains.
      */}
      {subscriptionState?.kind === "expiring" ? (
        <SecretExpiryBanner state={subscriptionState} />
      ) : null}

      {/*
        Requirement 40.1 — exactly one control per recorded artifact, and only while the
        run is `completed` **and** its stored verification passed. 40.4's "present no
        download control" is this condition being false, so the gate is one expression
        rather than a prop the card has to honour.

        Above the fold rather than four sections down: on a delivered run this is the
        only thing most readers came for.
      */}
      {delivered ? <DownloadCard artifactKeys={view.artifactKeys} /> : null}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <RunProgress
            initialRun={view}
            initialGaps={gaps}
            subscriptionLabel={subscriptionLabel}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-6 lg:w-80">
          <RequestDetails
            run={view}
            subscriptionName={subscriptionName}
            subscriptionMaskedId={subscriptionMaskedId}
          />

          {/*
            Requirement 39 — the audit certificate. Rendered for every terminal run,
            including one with no verification: 39.8 has the panel state that the report
            is not verified rather than the page omitting the section, because an absent
            section is indistinguishable from one that failed to load.
          */}
          {terminal ? (
            <VerificationPanel
              verification={
                verification.latest === undefined
                  ? null
                  : toVerificationView(verification.latest)
              }
            />
          ) : null}

          {run.status === "completed" ? (
            <Card data-slot="snapshot-card">
              <CardHeader>
                <CardTitle className="font-heading text-sm font-medium tracking-tight">
                  Snapshot
                </CardTitle>
              </CardHeader>

              <CardContent className="flex flex-col gap-4">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Immutable and content-addressed: the id <em>is</em> the hash
                  of its bytes, so a figure quoted from this report traces to
                  exactly the data it came from.
                </p>

                <SnapshotProvenance run={view} provenance={provenance} />

                {/*
                  Requirements 4.9, 9.9 — the pinned version and its digest. A reader
                  has to be able to tell the rule from the dates: "last full month" and
                  "2026-07-01 to 2026-07-31" are different facts, and showing only the
                  second makes a profile look like it stores a date range.
                */}
                {pinned === null ? null : (
                  <dl className="flex flex-col gap-3 border-t border-border pt-4">
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-[11px] tracking-wider text-muted-foreground uppercase">
                        Version rendered from
                      </dt>
                      <dd className="text-sm font-medium">
                        {pinned.templateName}{" "}
                        <span className="font-mono tabular-nums">
                          v{pinned.version}
                        </span>
                      </dd>
                    </div>

                    <div className="flex flex-col gap-0.5">
                      <dt className="text-[11px] tracking-wider text-muted-foreground uppercase">
                        Definition digest
                      </dt>
                      <dd className="font-mono text-xs break-all text-muted-foreground">
                        {pinned.definitionSha256.slice(0, 24)}
                      </dd>
                    </div>
                  </dl>
                )}

                {/*
                  Requirement 38 — provenance on every figure. It is a route now rather
                  than a disclosure at the foot of this page: the rendering is the whole
                  document, and it buried the downloads and the verification under it.
                  Offered only where the emitted document is actually readable.
                */}
                {documentHtml === null ? null : (
                  <Link
                    href={`/reports/${runId}/figures`}
                    className="flex items-center gap-1.5 rounded-lg text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    Trace every figure
                    <ArrowUpRightIcon aria-hidden="true" className="size-4" />
                  </Link>
                )}
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
