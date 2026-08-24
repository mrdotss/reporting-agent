import { CheckCircleIcon, CircleDashedIcon } from "@phosphor-icons/react/ssr"

import { messageText } from "@/lib/messages/catalog"
import type { RunStep } from "@/hooks/useRunStream"

/**
 * The live activity timeline — the signature agentic element (Requirement 40.8).
 *
 * **Purely presentational.** It receives {@link RunStep}s and renders them; every
 * event is parsed in `useRunStream`, which is Requirement 40.8 and also what makes this
 * component assertable without a stream.
 *
 * ## The determinate bar is the point
 *
 * A report run is **8 to 12 minutes** at a few hundred resources. An indeterminate
 * spinner turning for four minutes reads as a hang, so a step showing
 * `142 / 200 resources` is not decoration — it is the difference between a product that
 * looks alive and one that looks stuck.
 *
 * The bar renders **only** when the step carries counts. That chain is deliberate end to
 * end: the agent posts `current`/`total` only for a phase with a countable unit of work,
 * the row stores them nullable, the relay emits **no** `progress` event while either is
 * absent (Requirement 40.14), and this component renders no bar without one. A phase
 * that is genuinely not counting anything shows its status phrase and a spinner, which
 * is honest, rather than a bar at zero, which is not.
 *
 * Worth knowing about the freshness: the bar is up to roughly **7 seconds stale** worst
 * case — the reporter's 5-second throttle plus the relay's 2-second poll — on a run that
 * lasts 8 to 12 minutes. That is a persisted source rather than an aspirational one, and
 * 7 seconds out of 600 is not a number a reader can perceive.
 *
 * ## Accessibility
 *
 * The list is a real `<ol>` in the order the steps opened, so reading order matches
 * visual order. Each bar is a `progressbar` with its `aria-valuenow`/`max`, and the
 * count is also rendered as text — a bar whose only representation is a width is a bar a
 * screen reader cannot report. Status changes are announced by the `aria-live` region in
 * `run-progress.tsx`, once, rather than by every step announcing itself.
 *
 * **Streaming numerals do not animate.** No count-up, no transition on the number. In a
 * product whose thesis is that the numbers are trustworthy, a numeral that animates is
 * decoration pretending to be data.
 */

export function ActivityTimeline({
  steps,
}: Readonly<{ steps: readonly RunStep[] }>) {
  if (steps.length === 0) return null

  return (
    <ol
      data-slot="activity-timeline"
      aria-label={messageText("ui.activity.label", "en") ?? "Run activity"}
      className="flex flex-col gap-3"
    >
      {steps.map((step) => (
        <li
          key={step.id}
          data-slot="activity-step"
          data-step-id={step.id}
          data-complete={step.complete ? "true" : "false"}
          className="flex items-start gap-3"
        >
          {step.complete ? (
            // `fill` marks a settled state, and it is the one place this component uses
            // a weight other than `regular`.
            <CheckCircleIcon
              aria-hidden="true"
              weight="fill"
              className="mt-0.5 size-4 shrink-0 text-primary dark:text-sidebar-primary"
            />
          ) : (
            <CircleDashedIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            />
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{step.status}</span>

              <span className="rounded-3xl border border-border px-2 py-0.5 text-xs text-muted-foreground">
                {step.label}
              </span>
            </div>

            {step.progress === null ? null : (
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                  {/*
                    Mono tabular, so the numerals do not shift as they count up, and no
                    transition on them: this is data, not an animation.
                  */}
                  <span
                    data-slot="progress-count"
                    className="font-mono text-foreground tabular-nums"
                  >
                    {step.progress.done} / {step.progress.total}
                  </span>

                  <span>{step.progress.unit}</span>

                  {step.progress.label === null ? null : (
                    <span>· {step.progress.label}</span>
                  )}
                </div>

                <div
                  data-slot="progress-bar"
                  role="progressbar"
                  aria-valuenow={step.progress.done}
                  aria-valuemin={0}
                  aria-valuemax={step.progress.total}
                  aria-valuetext={`${step.progress.done} of ${step.progress.total} ${step.progress.unit}`}
                  className="h-1 w-full overflow-hidden rounded-3xl bg-muted"
                >
                  <div
                    className="h-full rounded-3xl bg-primary"
                    style={{
                      // Clamped, so a total that shrank between callbacks cannot render
                      // a bar wider than its track.
                      width: `${Math.min(100, Math.max(0, (step.progress.done / step.progress.total) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}
