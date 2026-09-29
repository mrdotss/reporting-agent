import Link from "next/link"
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react/ssr"

import type { DepthChecklist, DepthItem } from "@/lib/subscriptions/depth"

/**
 * The data-depth coach: what this connector could read better, as a checklist.
 *
 * Each open item names how many resources the last report recorded it for and how to
 * close it; the next completed report re-checks it. A server render with no client
 * script — the steps open with a native `<details>`.
 */

const periodName = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })

function Mark({ state }: Readonly<{ state: DepthItem["state"] }>) {
  if (state === "done") {
    return (
      <span className="grid size-4 place-items-center rounded-full bg-(--status-verified) text-card" aria-hidden="true">
        <CheckIcon weight="bold" className="size-2.5" />
      </span>
    )
  }
  return state === "open" ? (
    <span className="mt-0.5 size-3 rotate-45 rounded-[2px] bg-(--status-attention)" aria-hidden="true" />
  ) : (
    <span className="size-3.5 rounded-full border-[1.5px] border-dashed border-muted-foreground" aria-hidden="true" />
  )
}

const STATE_LABEL: Readonly<Record<DepthItem["state"], string>> = {
  done: "Done",
  open: "To do",
  unknown: "Not checked yet",
}

export function DepthCoach({
  checklist,
  runId,
  periodStart,
}: Readonly<{
  checklist: DepthChecklist
  /** The report the gaps were read from, or `null` before the first one. */
  runId: string | null
  periodStart: string | null
}>) {
  const source =
    runId === null || periodStart === null
      ? "Gap-based checks start after the first completed report."
      : `From the ${periodName.format(new Date(`${periodStart}T00:00:00Z`))} report.`

  return (
    <section
      aria-labelledby="depth-coach-title"
      data-slot="depth-coach"
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-4 pb-3 md:px-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="depth-coach-title" className="text-section">
            Data depth
          </h2>
          <p className="text-meta text-muted-foreground">
            {source}{" "}
            {runId === null ? null : (
              <Link href={`/reports/${runId}`} className="underline underline-offset-3">
                Open the report
              </Link>
            )}
          </p>
        </div>
        <p className="font-mono text-meta tabular-nums text-muted-foreground">
          <span className="text-foreground">{checklist.done}</span> of {checklist.total}
        </p>
      </div>

      <div
        role="img"
        aria-label={`${checklist.done} of ${checklist.total} done`}
        className="mx-4 mb-3 grid gap-0.5 md:mx-5"
        style={{ gridTemplateColumns: `repeat(${checklist.total}, minmax(0, 1fr))` }}
      >
        {checklist.items.map((item) => (
          <span
            key={item.key}
            className={item.state === "done" ? "h-1.5 rounded-[2px] bg-primary" : "h-1.5 rounded-[2px] bg-muted"}
          />
        ))}
      </div>

      <ul className="border-t border-border/60">
        {checklist.items.map((item) => (
          <li
            key={item.key}
            data-state={item.state}
            className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-border/60 px-4 py-3 last:border-b-0 md:px-5"
          >
            <span className="grid h-5 place-items-center">
              <Mark state={item.state} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className={item.state === "done" ? "text-sm text-muted-foreground" : "text-sm font-medium"}>
                {item.title}
                <span className="sr-only"> ({STATE_LABEL[item.state]})</span>
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
              {item.steps.length === 0 ? null : (
                <details className="group mt-1">
                  <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-primary [&::-webkit-details-marker]:hidden">
                    How to close it
                    <CaretDownIcon aria-hidden="true" className="size-3 transition-transform group-open:rotate-180" />
                  </summary>
                  <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-4 text-xs leading-relaxed text-muted-foreground marker:font-mono marker:text-foreground">
                    {item.steps.map((step) => (
                      <li key={step} className="break-words">
                        {step}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
            {item.affected === null || item.affected === 0 ? (
              <span />
            ) : (
              <span className="rounded-md bg-(--status-attention-soft) px-1.5 font-mono text-xs leading-5 text-(--status-attention) tabular-nums">
                {item.affected}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
