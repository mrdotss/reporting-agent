"use client"

import {
  CheckIcon,
  SealIcon,
  SealWarningIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react"

import { Card, CardContent } from "@/components/ui/card"
import { CopyDigest } from "@/components/reports/copy-digest"
import { FindingList } from "@/components/reports/finding-list"
import type { VerificationView } from "@/lib/db/views"
import { messageText, type MessageId } from "@/lib/messages/catalog"
import type { Language } from "@/lib/messages/language"
import { cn } from "@/lib/utils"

/**
 * The verification, presented as the report's verdict (Requirement 39).
 *
 * ## Success is quiet; failure is loud and specific
 *
 * A pass is a verdict line — the figure count and the snapshot it traced to — with the
 * three digests in wells and each check on one line beneath. A fail is a count, every
 * blocking finding with its locating fields, and a plain statement that the report was
 * not delivered. When a consultant sees red in this product it means *this document
 * could not be proven*, and nothing else (Requirement 39.6).
 *
 * ## Every value comes from the stored row
 *
 * Requirement 39.9 — never from a received event alone. This component takes a
 * {@link VerificationView} projected from `report_verifications` and has no event
 * subscription at all.
 */

/** `1480` → `1,480`. Grouped for readability; the value itself is unchanged. */
function grouped(count: number): string {
  return count.toLocaleString("en-US")
}

const FAIL_NOUN_SINGULAR: MessageId = "ui.verification.fail_noun_singular"
const FAIL_NOUN_PLURAL: MessageId = "ui.verification.fail_noun_plural"

/** One check on one line: a tick, what was checked, what it recorded. */
function Check({
  slot,
  heading,
  children,
}: Readonly<{ slot: string; heading: string | undefined; children: React.ReactNode }>) {
  return (
    <div data-slot={slot} className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-2">
      <CheckIcon
        aria-hidden="true"
        weight="bold"
        className="mt-0.5 size-3.5 text-(--status-verified)"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-meta font-medium">{heading}</p>
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}

/** One digest in a well: what it names, the value, and a copy control. */
function DigestWell({
  label,
  value,
  copyLabel,
}: Readonly<{ label: string | undefined; value: string; copyLabel: string }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">
        <CopyDigest value={value} label={copyLabel} />
      </dd>
    </div>
  )
}

export function VerificationPanel({
  verification,
  delivered = true,
  language = "en",
}: Readonly<{
  /** The stored row, or `null` when the run carries none (Requirement 39.8). */
  verification: VerificationView | null
  /**
   * Whether the run actually handed over a document. A verification can pass and the
   * run still deliver nothing — the reaper fails a run that exceeds its phase deadline
   * after the verifier has checked every figure — so the panel states that in the same
   * breath rather than leaving the reader to reconcile two opposite words.
   */
  delivered?: boolean
  language?: Language
}>) {
  // Requirement 39.8 — no verification, or a status that is neither pass nor fail,
  // presents "not verified" in neutral ink. An unverified report is not a failed one.
  if (
    verification === null ||
    (verification.status !== "pass" && verification.status !== "fail")
  ) {
    return (
      <Card
        data-slot="verification-panel"
        data-status={verification?.status ?? "absent"}
        aria-labelledby="verification-heading"
        role="region"
      >
        <CardContent className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <SealIcon aria-hidden="true" className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <h2 id="verification-heading" className="text-section">
              {messageText("ui.verification.failed", language ?? "en")}
            </h2>
            <p className="max-w-prose text-meta text-muted-foreground">
              {messageText("ui.verification.absent_description", language ?? "en")}
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const passed = verification.status === "pass"
  const blockingCount = verification.blockingFindings.length
  const failNoun = messageText(blockingCount === 1 ? FAIL_NOUN_SINGULAR : FAIL_NOUN_PLURAL, language ?? "en") ?? ""

  return (
    <Card
      data-slot="verification-panel"
      data-status={verification.status}
      aria-labelledby="verification-heading"
      className={passed ? undefined : "border-destructive/40 ring-2 ring-destructive/25"}
      role="region"
    >
      <CardContent className="flex flex-col gap-5">
        {/* Requirement 39.7 — one polite region, one sentence. */}
        <p data-slot="verification-announcement" aria-live="polite" className="sr-only">
          {passed
            ? messageText("ui.verification.pass_aria", language ?? "en", {
                count: grouped(verification.figureCount),
              })
            : messageText("ui.verification.fail_aria", language ?? "en", {
                count: grouped(blockingCount),
                noun: failNoun,
              })}
        </p>

        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-3.5">
          <span
            className={cn(
              "grid size-10 place-items-center rounded-lg",
              passed
                ? "bg-(--status-verified-soft) text-(--status-verified)"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {passed ? (
              <ShieldCheckIcon aria-hidden="true" className="size-5" />
            ) : (
              <SealWarningIcon aria-hidden="true" className="size-5" />
            )}
          </span>

          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="verification-heading" className="text-section">
              {passed
                ? messageText("ui.verification.passed", language ?? "en")
                : messageText("ui.verification.not_delivered_heading", language ?? "en")}
            </h2>

            {passed ? (
              // Requirement 39.2 — the count and the snapshot digest as one statement.
              <>
                <p className="font-mono text-meta text-muted-foreground tabular-nums">
                  {messageText("ui.verification.pass_summary", language ?? "en", {
                    count: grouped(verification.figureCount),
                    digest: verification.snapshotSha256.slice(0, 12),
                  })}
                </p>
                {delivered ? null : (
                  <p className="max-w-prose text-meta text-(--status-failed)">
                    {messageText("ui.verification.passed_not_delivered", language ?? "en")}
                  </p>
                )}
              </>
            ) : (
              // Requirement 39.3 — the count, and the plain statement.
              <p className="max-w-prose text-meta text-destructive">
                {messageText("ui.verification.fail_summary", language ?? "en", {
                  count: grouped(blockingCount),
                  noun: failNoun,
                })}
              </p>
            )}
          </div>
        </div>

        {/* Requirement 39.1 — all three digests, mono, each with a copy, each in a well. */}
        <dl
          data-slot="verification-digests"
          className="grid grid-cols-1 gap-2 sm:grid-cols-3"
        >
          <DigestWell
            label={messageText("ui.verification.digest_snapshot", language ?? "en")}
            value={verification.snapshotSha256}
            copyLabel="snapshot digest"
          />
          <DigestWell
            label={messageText("ui.verification.digest_docx", language ?? "en")}
            value={verification.docxSha256}
            copyLabel="docx digest"
          />
          <DigestWell
            label={messageText("ui.verification.digest_pdf", language ?? "en")}
            value={verification.pdfSha256}
            copyLabel="pdf digest"
          />
        </dl>

        {/* Requirement 39.4 — replay and drift, each with what it actually recorded. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Check
            slot="replay-outcome"
            heading={messageText("ui.verification.replay_heading", language ?? "en")}
          >
            {!verification.replay.possible ? (
              // "Replay was not possible" is a third outcome, not a pass or a failure.
              <p>{messageText("ui.verification.replay_not_possible", language ?? "en")}</p>
            ) : (
              <>
                <p>
                  {messageText("ui.verification.replay_folded", language ?? "en", {
                    folded: grouped(verification.replay.objectsFolded),
                    named: grouped(verification.replay.objectsNamed),
                  })}
                </p>
                {verification.replay.recomputedSha256 === undefined ? null : (
                  <p className="flex flex-wrap items-center gap-1.5">
                    {messageText("ui.verification.replay_recomputed_label", language ?? "en")}{" "}
                    <CopyDigest
                      value={verification.replay.recomputedSha256}
                      label="recomputed snapshot digest"
                    />
                    {verification.replay.storedSha256 === undefined ? null : (
                      <>
                        {" "}
                        {messageText("ui.verification.replay_stored_label", language ?? "en")}{" "}
                        <CopyDigest
                          value={verification.replay.storedSha256}
                          label="stored snapshot digest"
                        />
                      </>
                    )}
                  </p>
                )}
              </>
            )}
          </Check>

          <Check
            slot="drift-sample"
            heading={messageText("ui.verification.drift_heading", language ?? "en")}
          >
            {verification.driftSample.n === 0 && !verification.driftSample.seed ? (
              <p>{messageText("ui.verification.drift_empty", language ?? "en")}</p>
            ) : (
              <>
                <p className="flex flex-wrap items-center gap-1.5">
                  {messageText("ui.verification.drift_summary", language ?? "en", {
                    n: grouped(verification.driftSample.n),
                    method: verification.driftSample.method,
                  })}{" "}
                  {verification.driftSample.seed ? (
                    <CopyDigest
                      value={verification.driftSample.seed}
                      label="drift sample seed"
                    />
                  ) : (
                    <span>{messageText("ui.verification.drift_no_seed", language ?? "en")}</span>
                  )}
                </p>
                {verification.driftSample.notRequeried.length === 0 ? null : (
                  <p>
                    {messageText("ui.verification.drift_not_requeried", language ?? "en", {
                      count: grouped(verification.driftSample.notRequeried.length),
                    })}
                  </p>
                )}
              </>
            )}
          </Check>
        </div>

        {/* Requirement 39.3 — every blocking finding, with its locating fields. */}
        {passed ? null : (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-destructive">
              {messageText("ui.finding.blocking_heading", language ?? "en")}
            </h3>
            <FindingList
              findings={verification.blockingFindings}
              blocking
              emptyText={messageText("ui.finding.blocking_empty", language ?? "en") ?? ""}
            />
          </div>
        )}

        {/*
          Requirement 39.5 — a separate labelled region, no `--destructive`, and never
          presented as a cause of the status.
        */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-4">
          <h3 className="text-meta font-medium">
            {messageText("ui.finding.advisory_heading", language ?? "en")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {messageText("ui.finding.advisory_note", language ?? "en")}
          </p>
          <FindingList
            findings={verification.advisoryFindings}
            blocking={false}
            emptyText={messageText("ui.finding.empty_advisory", language ?? "en") ?? ""}
          />
        </div>
      </CardContent>
    </Card>
  )
}
