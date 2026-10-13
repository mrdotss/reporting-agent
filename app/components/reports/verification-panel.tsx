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
 * A pass is one heading — how many figures traced to the snapshot — the three digests in
 * wells, and three checks, one line each. A fail is a count, every blocking finding with
 * its locating fields, and a plain statement that the report was not delivered. When a
 * consultant sees red in this product it means *this document could not be proven*, and
 * nothing else (Requirement 39.6).
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

/** One check: a tick, what was checked, and one line of what it recorded. */
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
        <p className="text-meta">{heading}</p>
        <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
          {children}
        </div>
      </div>
    </div>
  )
}

/** A check in the inline layout: a filled tick, the check, and what it recorded. */
function InlineCheck({
  slot,
  heading,
  children,
}: Readonly<{ slot: string; heading: string | undefined; children: React.ReactNode }>) {
  return (
    <div data-slot={slot} className="flex min-w-0 gap-3">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-(--status-verified-soft) text-(--status-verified)">
        <CheckIcon aria-hidden="true" weight="bold" className="size-3" />
      </span>
      <div className="flex min-w-0 flex-col">
        <p className="text-sm font-medium">{heading}</p>
        <p className="text-meta text-muted-foreground">{children}</p>
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

/** One fingerprint as a row: what it names on the left, the value and its copy on the right. */
function DigestRow({
  label,
  value,
  copyLabel,
}: Readonly<{ label: string | undefined; value: string; copyLabel: string }>) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-t border-border py-2 first:border-t-0">
      <dt className="text-meta text-muted-foreground">{label}</dt>
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
  layout = "card",
  definition = null,
}: Readonly<{
  /** The stored row, or `null` when the run carries none (Requirement 39.8). */
  verification: VerificationView | null
  /**
   * Whether the run actually handed over a document. A verification can pass and the
   * run still deliver nothing — the reaper fails a run that exceeds its phase deadline
   * after the verifier has checked every figure — so the panel says so in the same breath.
   */
  delivered?: boolean
  language?: Language
  /**
   * `inline` is the report page's Proof tab: a passed verification whose verdict is
   * already the page's summary, so it drops the card and the heading and lists the
   * checks and fingerprints. A failed or absent one always renders as the card.
   */
  layout?: "card" | "inline"
  /** The pinned definition, listed with the fingerprints in the inline layout. */
  definition?: Readonly<{ label: string; sha256: string }> | null
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
  const advisoryCount = verification.advisoryFindings.length

  if (layout === "inline" && passed) {
    const lang = language ?? "en"
    return (
      <div
        data-slot="verification-panel"
        data-status={verification.status}
        role="region"
        aria-labelledby="verification-checks-heading"
        className="grid min-w-0 gap-7 sm:grid-cols-2"
      >
        <p data-slot="verification-announcement" aria-live="polite" className="sr-only">
          {messageText("ui.verification.pass_aria", lang, { count: grouped(verification.figureCount) })}
        </p>

        <div className="flex min-w-0 flex-col gap-3.5">
          <h3 id="verification-checks-heading" className="text-sm font-semibold">
            {messageText("ui.verification.checks_heading", lang)}
          </h3>
          <InlineCheck slot="replay-outcome" heading={messageText("ui.verification.replay_heading", lang)}>
            {!verification.replay.possible
              ? messageText("ui.verification.replay_not_possible", lang)
              : messageText("ui.verification.replay_folded", lang, {
                  folded: grouped(verification.replay.objectsFolded),
                  named: grouped(verification.replay.objectsNamed),
                })}
          </InlineCheck>
          <InlineCheck slot="drift-sample" heading={messageText("ui.verification.drift_heading", lang)}>
            {verification.driftSample.n === 0 && !verification.driftSample.seed
              ? messageText("ui.verification.drift_empty", lang)
              : messageText("ui.verification.drift_short", lang, { n: grouped(verification.driftSample.n) })}
          </InlineCheck>
          <InlineCheck slot="advisory-findings" heading={messageText("ui.finding.advisory_heading", lang)}>
            {advisoryCount === 0
              ? messageText("ui.finding.empty_advisory", lang)
              : messageText("ui.finding.advisory_note", lang)}
          </InlineCheck>
          {advisoryCount === 0 ? null : (
            <FindingList
              findings={verification.advisoryFindings}
              blocking={false}
              emptyText={messageText("ui.finding.empty_advisory", lang) ?? ""}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-semibold">{messageText("ui.verification.fingerprints_heading", lang)}</h3>
          <dl data-slot="verification-digests" className="flex flex-col">
            <DigestRow
              label={messageText("ui.verification.digest_snapshot", lang)}
              value={verification.snapshotSha256}
              copyLabel="snapshot digest"
            />
            <DigestRow
              label={messageText("ui.verification.digest_docx", lang)}
              value={verification.docxSha256}
              copyLabel="docx digest"
            />
            <DigestRow
              label={messageText("ui.verification.digest_pdf", lang)}
              value={verification.pdfSha256}
              copyLabel="pdf digest"
            />
            {verification.replay.recomputedSha256 === undefined ? null : (
              <DigestRow
                label={messageText("ui.verification.digest_recomputed", lang)}
                value={verification.replay.recomputedSha256}
                copyLabel="recomputed snapshot digest"
              />
            )}
            {definition === null ? null : (
              <DigestRow label={definition.label} value={definition.sha256} copyLabel="definition digest" />
            )}
          </dl>
        </div>
      </div>
    )
  }

  return (
    <Card
      data-slot="verification-panel"
      data-status={verification.status}
      aria-labelledby="verification-heading"
      className={passed ? undefined : "border-destructive/40 ring-2 ring-destructive/25"}
      role="region"
    >
      <CardContent className="flex flex-col gap-4">
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
                ? messageText("ui.verification.traced_heading", language ?? "en", { count: grouped(verification.figureCount) })
                : messageText("ui.verification.not_delivered_heading", language ?? "en")}
            </h2>

            {passed ? (
              <>
                {/* Requirement 39.2 — the count and the snapshot digest as one statement. */}
                <p className="font-mono text-xs text-muted-foreground tabular-nums">
                  {messageText("ui.verification.pass_summary", language ?? "en", { count: grouped(verification.figureCount), digest: verification.snapshotSha256.slice(0, 12) })}
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
        <dl data-slot="verification-digests" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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

        {/* Requirements 39.4, 39.5 — what each check recorded, one line each. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
                  <p className="flex min-w-0 items-center gap-1">
                    {messageText("ui.verification.replay_recomputed_label", language ?? "en")}{" "}
                    <CopyDigest
                      value={verification.replay.recomputedSha256}
                      label="recomputed snapshot digest"
                    />
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
                <p>
                  {messageText("ui.verification.drift_short", language ?? "en", { n: grouped(verification.driftSample.n) })}
                </p>
                {/* Requirements 21.3, 21.9 — the seed, copyable, or a plain statement that none was recorded. */}
                <p className="flex min-w-0 items-center gap-1">
                  {verification.driftSample.seed ? (
                    <CopyDigest value={verification.driftSample.seed} label="drift sample seed" />
                  ) : (
                    messageText("ui.verification.drift_no_seed", language ?? "en")
                  )}
                </p>
              </>
            )}
          </Check>

          <Check
            slot="advisory-findings"
            heading={messageText("ui.finding.advisory_heading", language ?? "en")}
          >
            {advisoryCount === 0 ? (
              <p>{messageText("ui.finding.empty_advisory", language ?? "en")}</p>
            ) : (
              <p>{messageText("ui.finding.advisory_note", language ?? "en")}</p>
            )}
          </Check>
        </div>

        {/* Requirement 39.5 — the advisory findings themselves, when there are any. */}
        {advisoryCount === 0 ? null : (
          <FindingList
            findings={verification.advisoryFindings}
            blocking={false}
            emptyText={messageText("ui.finding.empty_advisory", language ?? "en") ?? ""}
          />
        )}

        {/* Requirement 39.3 — every blocking finding, with its locating fields. */}
        {passed ? null : (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
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
      </CardContent>
    </Card>
  )
}
