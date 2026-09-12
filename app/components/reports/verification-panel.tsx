"use client"

import { SealCheckIcon, SealWarningIcon, SealIcon } from "@phosphor-icons/react"

import { Card, CardContent } from "@/components/ui/card"
import { CopyDigest } from "@/components/reports/copy-digest"
import { FindingList } from "@/components/reports/finding-list"
import type { VerificationView } from "@/lib/db/views"
import { messageText, type MessageId } from "@/lib/messages/catalog"
import type { Language } from "@/lib/messages/language"

/**
 * The verification, presented as an audit certificate (Requirement 39).
 *
 * ## Success is quiet; failure is loud and specific
 *
 * `design-system.md` states it in those words and Requirements 39.2 and 39.3
 * make it testable. A pass is **one sentence** in mist neutrals — *"1,480 figures
 * · every figure traced to snapshot `9f2c…` · verified"* — with no
 * `--destructive` and no assertive alert. A fail is a count, every blocking
 * finding with its locating fields, and a plain statement that the report was
 * not delivered.
 *
 * The asymmetry is the design. A pass that shouted would train a consultant to
 * ignore the panel, and the panel's whole value is that when it does shout,
 * something is actually wrong.
 *
 * ## `--destructive` means exactly one thing
 *
 * Requirement 39.6 reserves the token for the verification-failure state and
 * hard errors, and forbids it on gaps, advisory findings, fidelity badges,
 * utilization values and negative deltas. That is why the advisory region below
 * is styled like ordinary content and why `finding-list.tsx` takes a `blocking`
 * flag rather than reading severity for colour. When a consultant sees red in
 * this product it means *this document could not be proven*, and nothing else.
 *
 * ## Every value comes from the stored row
 *
 * Requirement 39.9 — never from a received event alone, "so that a reconnecting
 * client presents the same status, the same digests and the same finding list
 * rather than a subset of them". This component takes a {@link VerificationView}
 * projected from `report_verifications` and has no event subscription at all,
 * which is that requirement expressed as a prop type: there is no stream here to
 * accidentally prefer.
 */

/** `1480` → `1,480`. Grouped for readability; the value itself is unchanged. */
function grouped(count: number): string {
  return count.toLocaleString("en-US")
}

const FAIL_NOUN_SINGULAR: MessageId = "ui.verification.fail_noun_singular"
const FAIL_NOUN_PLURAL: MessageId = "ui.verification.fail_noun_plural"

export function VerificationPanel({
  verification,
  delivered = true,
  language = "en",
}: Readonly<{
  /** The stored row, or `null` when the run carries none (Requirement 39.8). */
  verification: VerificationView | null
  /**
   * Whether the run actually handed over a document.
   *
   * A verification can pass and the run still deliver nothing — the reaper fails a
   * run that exceeds its phase deadline, and that can land after the verifier has
   * already checked every figure it compiled. The stored row then says `pass` on a
   * run whose state is `failed`, and this panel read "verified" beside a counterfoil
   * stamped NOT DELIVERED: the page contradicted itself on the one question it
   * exists to answer.
   *
   * A passing check is still true and still worth showing — it says the figures that
   * were compiled traced to the snapshot. What it does not say is that anything was
   * delivered, so when this is false the panel states that in the same breath rather
   * than leaving the reader to reconcile two opposite words.
   */
  delivered?: boolean
  language?: Language
}>) {
  // Requirement 39.8 — no verification, or a status that is neither pass nor
  // fail, presents "not verified": no pass statement, no digest presented as
  // proven, and mist neutrals rather than `--destructive`. An unverified report
  // is not a failed one, and colouring it as one would make a run that is still
  // verifying look like a run that was refused.
  if (
    verification === null ||
    (verification.status !== "pass" && verification.status !== "fail")
  ) {
    return (
      <Card
        data-slot="verification-panel"
        data-status={verification?.status ?? "absent"}
        aria-labelledby="verification-heading"
        // A div with `aria-labelledby` is not a landmark; the role is what keeps this
      // announced as the labelled region Requirement 39 asks for.
      role="region"
      >
        <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <SealIcon
            aria-hidden="true"
            className="size-5 text-muted-foreground"
          />
          <h2
            id="verification-heading"
            className="text-section"
          >
            {messageText("ui.verification.failed", language ?? "en")}
          </h2>
        </div>

        <p className="max-w-prose text-sm text-muted-foreground">
          {messageText("ui.verification.absent_description", language ?? "en")}
        </p>
        </CardContent>
      </Card>
    )
  }

  const passed = verification.status === "pass"
  const blockingCount = verification.blockingFindings.length

  return (
    // A `Card`, so it sits level with the snapshot card beside it. The failure case
    // keeps its own border colour: a report that could not be proved is the one thing on
    // this page allowed to use `--destructive`.
    //
    // The width is not optional. This was `ring-destructive/40` alone, and a ring
    // *colour* with no ring *width* compiles to `--tw-ring-color` and no box-shadow —
    // so the failed panel was drawn identically to the passed one, and the only thing
    // distinguishing "this document could not be proven" was the text inside it.
    <Card
      data-slot="verification-panel"
      data-status={verification.status}
      aria-labelledby="verification-heading"
      className={passed ? undefined : "border-destructive/40 ring-2 ring-destructive/25"}
      // A div with `aria-labelledby` is not a landmark; the role is what keeps this
      // announced as the labelled region Requirement 39 asks for.
      role="region"
    >
      <CardContent className="flex flex-col gap-4">
      {/*
        Requirement 39.7 — the resolved status through a `polite` region, with
        the blocking count in the same announcement on a fail. One region, one
        sentence: two announcements for one outcome is how a screen-reader user
        ends up hearing the count without the status.
      */}
      <p
        data-slot="verification-announcement"
        aria-live="polite"
        className="sr-only"
      >
        {passed
          ? messageText("ui.verification.pass_aria", language ?? "en", { count: grouped(verification.figureCount) })
          : messageText("ui.verification.fail_aria", language ?? "en", { count: grouped(blockingCount), noun: messageText(blockingCount === 1 ? FAIL_NOUN_SINGULAR : FAIL_NOUN_PLURAL, language ?? "en") ?? "" })}
      </p>

      <div className="flex items-start gap-2">
        {passed ? (
          <SealCheckIcon aria-hidden="true" className="mt-0.5 size-5" />
        ) : (
          <SealWarningIcon
            aria-hidden="true"
            className="mt-0.5 size-5 text-destructive"
          />
        )}

        <div className="flex flex-col gap-1">
          <h2
            id="verification-heading"
            className="text-section"
          >
            {passed ? messageText("ui.verification.passed", language ?? "en") : messageText("ui.verification.not_delivered_heading", language ?? "en")}
          </h2>

          {passed ? (
            // Requirement 39.2 — the status word, the count and the snapshot
            // digest as **one statement**, in mist neutrals.
            <div className="flex flex-col gap-1.5">
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                <span className="font-mono tabular-nums">
                  {messageText("ui.verification.pass_summary", language ?? "en", { count: grouped(verification.figureCount), digest: verification.snapshotSha256.slice(0, 12) })}
                </span>
              </p>

              {delivered ? null : (
                <p className="max-w-prose text-sm text-(--status-failed)">
                  {messageText("ui.verification.passed_not_delivered", language ?? "en")}
                </p>
              )}
            </div>
          ) : (
            // Requirement 39.3 — the count, and the plain statement.
            <p className="max-w-prose text-sm text-destructive">
              {messageText("ui.verification.fail_summary", language ?? "en", { count: grouped(blockingCount), noun: messageText(blockingCount === 1 ? FAIL_NOUN_SINGULAR : FAIL_NOUN_PLURAL, language ?? "en") ?? "" })}
            </p>
          )}
        </div>
      </div>

      {/* Requirement 39.1 — all three digests, mono, tabular, each with a copy. */}
      <dl
        data-slot="verification-digests"
        className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3"
      >
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{messageText("ui.verification.digest_snapshot", language ?? "en")}</dt>
          <dd>
            <CopyDigest
              value={verification.snapshotSha256}
              label="snapshot digest"
            />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{messageText("ui.verification.digest_docx", language ?? "en")}</dt>
          <dd>
            <CopyDigest value={verification.docxSha256} label="docx digest" />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{messageText("ui.verification.digest_pdf", language ?? "en")}</dt>
          <dd>
            <CopyDigest value={verification.pdfSha256} label="pdf digest" />
          </dd>
        </div>
      </dl>

      {/* Requirement 39.4 — replay and drift, each with what it actually recorded. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div
          data-slot="replay-outcome"
          className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2"
        >
          <p className="text-xs font-medium">{messageText("ui.verification.replay_heading", language ?? "en")}</p>

          {!verification.replay.possible ? (
            // Requirement 39.4 — "replay was not possible" rather than a pass or
            // a failure. Those are three outcomes and reporting the first as
            // either of the others is a false claim about what was checked.
            <p className="text-xs text-muted-foreground">
              {messageText("ui.verification.replay_not_possible", language ?? "en")}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {messageText("ui.verification.replay_folded", language ?? "en", { folded: grouped(verification.replay.objectsFolded), named: grouped(verification.replay.objectsNamed) })}
              </p>

              {verification.replay.recomputedSha256 === undefined ? null : (
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {messageText("ui.verification.replay_recomputed_label", language ?? "en")}{" "}
                  <CopyDigest
                    value={verification.replay.recomputedSha256}
                    label="recomputed snapshot digest"
                  />
                  {verification.replay.storedSha256 === undefined ? null : (
                    <>
                      {" "}{messageText("ui.verification.replay_stored_label", language ?? "en")}{" "}
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
        </div>

        <div
          data-slot="drift-sample"
          className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2"
        >
          <p className="text-xs font-medium">{messageText("ui.verification.drift_heading", language ?? "en")}</p>

          {verification.driftSample.n === 0 && !verification.driftSample.seed ? (
            <p className="text-xs text-muted-foreground">
              {messageText("ui.verification.drift_empty", language ?? "en")}
            </p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {messageText("ui.verification.drift_summary", language ?? "en", { n: grouped(verification.driftSample.n), method: verification.driftSample.method })}{" "}
                {verification.driftSample.seed ? (
                  <CopyDigest
                    value={verification.driftSample.seed}
                    label="drift sample seed"
                  />
                ) : (
                  <span className="text-muted-foreground">
                    {messageText("ui.verification.drift_no_seed", language ?? "en")}
                  </span>
                )}
              </p>

              {verification.driftSample.notRequeried.length === 0 ? null : (
                <p className="text-xs text-muted-foreground">
                  {messageText("ui.verification.drift_not_requeried", language ?? "en", { count: grouped(verification.driftSample.notRequeried.length) })}
                </p>
              )}
            </>
          )}
        </div>
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
        Requirement 39.5 — a separate labelled region, no `--destructive`, and
        never presented as a cause of the status. The heading says "advisory"
        rather than leaving the reader to infer it from the styling.
      */}
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium">{messageText("ui.finding.advisory_heading", language ?? "en")}</h3>

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
