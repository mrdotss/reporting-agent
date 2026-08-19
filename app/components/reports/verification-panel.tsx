"use client"

import { SealCheckIcon, SealWarningIcon, SealIcon } from "@phosphor-icons/react"

import { CopyDigest } from "@/components/reports/copy-digest"
import { FindingList } from "@/components/reports/finding-list"
import type { VerificationView } from "@/lib/db/views"

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

export function VerificationPanel({
  verification,
}: Readonly<{
  /** The stored row, or `null` when the run carries none (Requirement 39.8). */
  verification: VerificationView | null
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
      <section
        data-slot="verification-panel"
        data-status={verification?.status ?? "absent"}
        aria-labelledby="verification-heading"
        className="flex flex-col gap-2 rounded-xl border border-border px-4 py-4"
      >
        <div className="flex items-center gap-2">
          <SealIcon
            aria-hidden="true"
            className="size-5 text-muted-foreground"
          />
          <h2
            id="verification-heading"
            className="font-heading text-sm font-medium tracking-tight"
          >
            Not verified
          </h2>
        </div>

        <p className="max-w-prose text-sm text-muted-foreground">
          This report carries no completed verification, so nothing here is
          presented as proven and no document is offered for download. A report
          is delivered only behind a passing verification.
        </p>
      </section>
    )
  }

  const passed = verification.status === "pass"
  const blockingCount = verification.blockingFindings.length

  return (
    <section
      data-slot="verification-panel"
      data-status={verification.status}
      aria-labelledby="verification-heading"
      className={[
        "flex flex-col gap-4 rounded-xl border px-4 py-4",
        passed ? "border-border" : "border-destructive/40",
      ].join(" ")}
    >
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
          ? `Verification passed. ${grouped(verification.figureCount)} figures traced to the snapshot.`
          : `Verification failed with ${grouped(blockingCount)} blocking ${
              blockingCount === 1 ? "finding" : "findings"
            }. The report was not delivered.`}
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
            className="font-heading text-sm font-medium tracking-tight"
          >
            {passed ? "Verified" : "Not delivered"}
          </h2>

          {passed ? (
            // Requirement 39.2 — the status word, the count and the snapshot
            // digest as **one statement**, in mist neutrals.
            <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <span className="font-mono tabular-nums">
                {grouped(verification.figureCount)}
              </span>{" "}
              figures · every figure traced to snapshot{" "}
              <CopyDigest
                value={verification.snapshotSha256}
                label="snapshot digest"
              />{" "}
              · verified
            </p>
          ) : (
            // Requirement 39.3 — the count, and the plain statement.
            <p className="max-w-prose text-sm text-destructive">
              <span className="font-mono tabular-nums">
                {grouped(blockingCount)}
              </span>{" "}
              blocking {blockingCount === 1 ? "finding" : "findings"}. The
              report was <strong>not delivered</strong> — no document is offered
              for download, because no document could be proven against the
              snapshot.
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
          <dt className="text-muted-foreground">Snapshot</dt>
          <dd>
            <CopyDigest
              value={verification.snapshotSha256}
              label="snapshot digest"
            />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Document (.docx)</dt>
          <dd>
            <CopyDigest value={verification.docxSha256} label="docx digest" />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Document (.pdf)</dt>
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
          <p className="text-xs font-medium">Deterministic replay</p>

          {!verification.replay.possible ? (
            // Requirement 39.4 — "replay was not possible" rather than a pass or
            // a failure. Those are three outcomes and reporting the first as
            // either of the others is a false claim about what was checked.
            <p className="text-xs text-muted-foreground">
              Not possible for this run — the archived responses it would have
              re-folded are unavailable, so neither a match nor a mismatch is
              reported.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                <span className="font-mono tabular-nums">
                  {grouped(verification.replay.objectsFolded)}
                </span>{" "}
                of{" "}
                <span className="font-mono tabular-nums">
                  {grouped(verification.replay.objectsNamed)}
                </span>{" "}
                archived objects re-folded.
              </p>

              {verification.replay.recomputedSha256 === undefined ? null : (
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  recomputed{" "}
                  <CopyDigest
                    value={verification.replay.recomputedSha256}
                    label="recomputed snapshot digest"
                  />
                  {verification.replay.storedSha256 === undefined ? null : (
                    <>
                      · stored{" "}
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
          <p className="text-xs font-medium">Sampled drift (advisory)</p>

          <p className="text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">
              {grouped(verification.driftSample.n)}
            </span>{" "}
            resources re-queried · method{" "}
            <span className="font-mono">{verification.driftSample.method}</span>{" "}
            · seed{" "}
            <span className="font-mono">{verification.driftSample.seed}</span>
          </p>

          {verification.driftSample.notRequeried.length === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">
                {grouped(verification.driftSample.notRequeried.length)}
              </span>{" "}
              selected resources answered nothing and are recorded as not
              re-queried rather than as agreeing.
            </p>
          )}
        </div>
      </div>

      {/* Requirement 39.3 — every blocking finding, with its locating fields. */}
      {passed ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-destructive">
            Blocking findings
          </h3>

          <FindingList
            findings={verification.blockingFindings}
            blocking
            emptyText="The verification failed but recorded no blocking finding, which is itself a defect worth reporting."
          />
        </div>
      )}

      {/*
        Requirement 39.5 — a separate labelled region, no `--destructive`, and
        never presented as a cause of the status. The heading says "advisory"
        rather than leaving the reader to infer it from the styling.
      */}
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium">Advisory findings</h3>

        <p className="text-xs text-muted-foreground">
          Recorded for review. None of these affected the verification status.
        </p>

        <FindingList
          findings={verification.advisoryFindings}
          blocking={false}
          emptyText="No advisory findings."
        />
      </div>
    </section>
  )
}
