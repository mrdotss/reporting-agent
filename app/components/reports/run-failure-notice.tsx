import { SealWarningIcon } from "@phosphor-icons/react/ssr"

import type { RunView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import type { Language } from "@/lib/messages/language"
import { periodLine, runFailurePresentation } from "@/lib/runs/presentation"

/**
 * A failed run, stated plainly (Requirements 33.4, 36.7).
 *
 * ## Why this component exists rather than a line of copy per code
 *
 * `EMPTY_SCOPE` is the failure this product is built around, and its message has four
 * jobs: say that **zero resources were found**, **name the subscription and the
 * period**, say that **no artifact was produced**, and list the two causes to check —
 * an expired client secret and a Reader assignment below subscription scope.
 *
 * The reason it needs all four is that the alternative outcome is worse than a failure.
 * An expired secret returns zero resources, zero resources produce zero figures, and
 * zero figures pass every verification gate — so the run would otherwise deliver a
 * clean, fully-verified, **empty** report, which is the single most likely way this
 * product could ship a confidently wrong artifact. A screen that only said "failed"
 * would leave the consultant with no way to tell that case from a transient one.
 *
 * The copy itself lives in `lib/runs/presentation.ts`, so the same sentence appears
 * wherever a failure is shown and a test asserts against the constant rather than a
 * paraphrase.
 *
 * ## `--destructive` is spent here, and this is one of the two places it may be
 *
 * A hard run failure is exactly what the token means: *this document could not be
 * proven*. The gap list beside this notice is mist neutral for the opposite reason — a
 * gap is recorded information about a report that completed.
 *
 * ## `TIMEOUT` arrives with no event to carry it
 *
 * The reaper writes that code when the run's container may already be gone, so there is
 * no stream left to send an `error` event. This component reads `status` and `errorCode`
 * from the **row**, which is why a timed-out run renders a full explanation on a page
 * that received no events at all (Requirement 36.7).
 */
export function RunFailureNotice({
  run,
  subscriptionLabel,
  language = "en",
}: Readonly<{
  run: RunView
  /**
   * The connection's display name, or its masked subscription id.
   *
   * Passed in rather than looked up, because this component is rendered inside a client
   * tree fed by `useRunStream` and `connected_subscriptions` is server-side. The
   * *masked* id is what a browser may hold.
   */
  subscriptionLabel: string
  language?: Language
}>) {
  const failure = runFailurePresentation(run)
  if (failure === null) return null

  return (
    <section
      data-slot="run-failure-notice"
      data-error-code={run.errorCode ?? "UNKNOWN"}
      aria-labelledby={`run-failure-${run.id}`}
      className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
    >
      <div className="flex items-start gap-2">
        <SealWarningIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-destructive"
        />

        <h2
          id={`run-failure-${run.id}`}
          className="font-heading text-sm font-medium tracking-tight text-destructive"
        >
          {failure.headline}
        </h2>
      </div>

      {/*
        The subscription and the period, named. A failure notice that did not say which
        subscription and which month it was about would be a sentence a consultant
        cannot act on — they run several a week.
      */}
      <dl className="flex flex-col gap-1 text-sm sm:flex-row sm:gap-8">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs tracking-widest text-muted-foreground uppercase">
            {messageText("ui.failure.subscription_label", language ?? "en")}
          </dt>
          <dd className="font-mono tabular-nums">{subscriptionLabel}</dd>
        </div>

        <div className="flex flex-col gap-0.5">
          <dt className="text-xs tracking-widest text-muted-foreground uppercase">
            {messageText("ui.failure.period_label", language ?? "en")}
          </dt>
          {/* The zone is named, because "July" means July there and not in UTC. */}
          <dd className="font-mono tabular-nums">{periodLine(run)}</dd>
        </div>
      </dl>

      {/*
        Stated rather than implied. A notice that only said "zero resources" would leave
        a consultant looking for a download link that is not coming.
      */}
      <p data-slot="no-artifact" className="text-sm">
        {failure.artifactProduced
          ? messageText("ui.failure.artifact_produced", language ?? "en")
          : messageText("ui.failure.no_artifact", language ?? "en")}
      </p>

      {failure.causes.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs tracking-widest text-muted-foreground uppercase">
            {messageText("ui.failure.what_to_check", language ?? "en")}
          </h3>

          <ul
            data-slot="failure-causes"
            className="flex list-disc flex-col gap-1.5 pl-5 text-sm"
          >
            {failure.causes.map((cause) => (
              <li key={cause} className="max-w-prose">
                {cause}
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.errorMessage === null ? null : (
        // The runtime's own words, as supporting detail rather than as the headline: it
        // is prose written for a log and it varies with the code path that produced it,
        // while the headline above is the same sentence every time for a given code.
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {messageText("ui.failure.runtime_reported", language ?? "en")}
          </summary>

          <p className="mt-1.5 max-w-prose text-muted-foreground">
            {run.errorMessage}
          </p>
        </details>
      )}
    </section>
  )
}
