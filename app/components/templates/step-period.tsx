"use client"

import { useId, useMemo } from "react"

import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { TemplateDefinition } from "@/lib/templates/definition"
import { PERIOD_KINDS, resolvePeriod, type PeriodKind } from "@/lib/templates/period"

/**
 * Step 3 — the period (Requirements 4.1, 4.2, 11.7).
 *
 * ## The illustration is the point of this step
 *
 * Requirement 11.7 asks for the resolved dates to be *displayed*, "labelled as an
 * illustration resolved fresh at each run", with **no resolved date persisted in
 * the definition**. Both halves of that matter and they pull in opposite
 * directions:
 *
 * - Without the display, `last_full_month` is a phrase a consultant has to
 *   translate in their head, and the translation is where the off-by-one lives —
 *   does "last full month" include today's month, and what happens on the 1st?
 * - With the display but *without* the label, it reads as a stored date range,
 *   which is exactly the thing a relative specification exists not to be. A
 *   consultant who believed the dates were stored would re-edit the template
 *   every month.
 *
 * So the dates are shown and the sentence beside them says they are recomputed at
 * each run. What is written into the definition is only ever the `kind` (plus the
 * two dates for `custom`).
 *
 * ## The resolution runs in the browser, and that is safe here
 *
 * `resolvePeriod` is pure and derives everything from the instant and the zone —
 * no host time-zone setting, per Requirement 4.8. The browser's clock may be
 * wrong, which would make this illustration wrong; that is acceptable *because it
 * is an illustration*. The run's actual window is resolved server-side at enqueue,
 * from the server's instant, and nothing here is persisted for it to disagree with.
 */

/** The customer's zone, and the default a run of this template would use. */
const DEFAULT_TIMEZONE = "Asia/Jakarta"

const KIND_LABEL: Readonly<Record<PeriodKind, string>> = {
  last_24h: "Last full day",
  last_7d: "Last 7 days",
  last_30d: "Last 30 days",
  last_full_month: "Last full month",
  mtd: "Month to date",
  custom: "Fixed dates",
}

const KIND_SUMMARY: Readonly<Record<PeriodKind, string>> = {
  last_24h: "The single local day before today.",
  last_7d: "The 7 local days ending yesterday.",
  last_30d: "The 30 local days ending yesterday.",
  last_full_month: "The whole of the previous local calendar month.",
  mtd: "The 1st of this local month through yesterday.",
  custom: "Two dates you choose. This one does not move with the calendar.",
}

export function StepPeriod({
  definition,
  onChange,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
}>) {
  const startId = useId()
  const endId = useId()

  const period = definition.period as {
    readonly kind?: string
    readonly start?: string
    readonly end?: string
  }

  const kind = (period.kind ?? "last_full_month") as PeriodKind

  // Resolved at render against the browser's clock. Not memoized on a stable
  // instant on purpose: this is an illustration of "what would this mean if a run
  // started now", and freezing it would make it stale on a wizard left open.
  const resolved = useMemo(
    () => resolvePeriod(definition.period, new Date(), DEFAULT_TIMEZONE),
    [definition.period]
  )

  const setKind = (next: PeriodKind) => {
    onChange({
      ...definition,
      // Requirement 11.7 — no resolved date is persisted. Switching to `custom`
      // seeds the two fields the schema then requires (Requirement 4.2); every
      // other kind carries the `kind` alone, so a definition cannot keep a stale
      // pair of dates from a previous selection.
      period:
        next === "custom"
          ? { kind: "custom", start: period.start ?? "", end: period.end ?? "" }
          : { kind: next },
    })
  }

  const setCustom = (patch: { start?: string; end?: string }) => {
    onChange({
      ...definition,
      period: {
        kind: "custom",
        start: patch.start ?? period.start ?? "",
        end: patch.end ?? period.end ?? "",
      },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Period rule</legend>

        {/*
          Requirement 11.7 — exactly the six criterion 4.1 declares. A radio
          group rather than a select: six is few enough to show, and each one
          carries a sentence explaining what it resolves to, which a select's
          option text cannot.
        */}
        {PERIOD_KINDS.map((candidate) => (
          <label
            key={candidate}
            className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-focus-visible:ring-3 has-focus-visible:ring-ring/30"
          >
            <input
              type="radio"
              name="period-kind"
              value={candidate}
              checked={kind === candidate}
              onChange={() => setKind(candidate)}
              className="mt-1"
            />
            <span className="flex flex-col gap-0.5">
              <span>{KIND_LABEL[candidate]}</span>
              <span className="text-xs text-muted-foreground">
                {KIND_SUMMARY[candidate]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {kind !== "custom" ? null : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={startId}>First day</FieldLabel>
            <Input
              id={startId}
              type="date"
              value={period.start ?? ""}
              onChange={(event) => setCustom({ start: event.target.value })}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={endId}>Last day</FieldLabel>
            <Input
              id={endId}
              type="date"
              value={period.end ?? ""}
              onChange={(event) => setCustom({ end: event.target.value })}
            />
          </Field>
        </div>
      )}

      <div
        data-slot="period-illustration"
        className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2"
      >
        {resolved.ok ? (
          <p className="text-sm">
            Right now this resolves to{" "}
            <span className="font-mono tabular-nums">{resolved.start}</span> through{" "}
            <span className="font-mono tabular-nums">{resolved.end}</span> —{" "}
            <span className="font-mono tabular-nums">{resolved.days}</span> local
            {resolved.days === 1 ? " day" : " days"} in {resolved.timeZone} (
            <span className="font-mono">{resolved.utcOffset}</span>).
          </p>
        ) : (
          <p className="text-sm text-destructive">{resolved.message}</p>
        )}

        {/*
          Requirement 11.7's label, and it is not decoration. Without it the two
          dates above read as stored values, which is the one thing a relative
          specification must not be mistaken for.
        */}
        <p className="text-xs text-muted-foreground">
          An illustration, not a stored value. Every run resolves this rule again
          at the moment it is enqueued, so next month&rsquo;s report needs no
          edit. Nothing on this line is written into the template.
        </p>
      </div>
    </div>
  )
}
