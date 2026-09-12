"use client"

import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react"

import type { TemplateDefinition } from "@/lib/templates/definition"
import {
  designPreset,
  metricItemCount,
  scopedResourceTypeCount,
  sectionCount,
  type CompletionProblem,
} from "@/lib/profiles/wizard"


/** One fact on the review sheet. */
type SummaryRow = {
  readonly label: string
  readonly value: string
  /** Identifiers and figures are mono; prose and names are not. */
  readonly mono?: boolean
}

/** An optional that is genuinely unset, drawn so it cannot be mistaken for empty. */
const UNSET = "—"

function text(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : UNSET
}

function record(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

/**
 * The period rule, in the words the wizard used to set it.
 *
 * `last_full_month` and a pair of dates are different facts — the first resolves when
 * the run is enqueued and the second does not — so the rule is shown rather than the
 * dates it happens to resolve to today.
 */
function periodLabel(definition: TemplateDefinition): string {
  const period = record(definition, "period")
  const kind = record(period, "kind")
  if (typeof kind !== "string") return UNSET

  const start = record(period, "start")
  const end = record(period, "end")
  if (typeof start === "string" && typeof end === "string") {
    return `${start} to ${end}`
  }

  return kind.replace(/_/g, " ")
}

/**
 * The review sheet, grouped by the step each fact was set on.
 *
 * Grouped rather than flat because the point of the sheet is to be checked: a reader
 * who disagrees with a value needs to know which step to go back to, and the grouping
 * is that answer without a link per row.
 */
const SUMMARY_GROUPS: readonly {
  readonly title: string
  readonly rows: (definition: TemplateDefinition) => readonly SummaryRow[]
}[] = [
  {
    title: "Identity",
    rows: (definition) => {
      const identity = record(definition, "identity")
      return [
        { label: "Profile name", value: text(record(identity, "name")) },
        { label: "Report title", value: text(record(identity, "report_title")) },
        { label: "Customer", value: text(record(identity, "customer_name")) },
        { label: "Language", value: text(record(identity, "language")), mono: true },
      ]
    },
  },
  {
    title: "Content",
    rows: (definition) => [
      { label: "Sections", value: String(sectionCount(definition)), mono: true },
      {
        label: "Resource types in scope",
        value:
          scopedResourceTypeCount(definition) === 0
            ? "all"
            : String(scopedResourceTypeCount(definition)),
        mono: true,
      },
      {
        label: "Metric entries",
        value: String(metricItemCount(definition)),
        mono: true,
      },
      { label: "Period", value: periodLabel(definition), mono: true },
    ],
  },
  {
    title: "Document",
    rows: (definition) => {
      const design = record(definition, "design")
      const front = record(definition, "front_matter")
      const cover = record(front, "cover")
      return [
        { label: "Theme", value: text(designPreset(definition)) },
        { label: "Page size", value: text(record(design, "page_size")), mono: true },
        { label: "Density", value: text(record(design, "density")) },
        { label: "Table style", value: text(record(design, "table_style")) },
        {
          label: "Cover page",
          value: record(design, "cover_page") === false ? "off" : "on",
        },
        { label: "Cover logo", value: record(cover, "logo_key") ? "set" : UNSET },
      ]
    },
  },
]

/**
 * Step 6 — review and completion (Requirements 11.1, 11.5, 11.10).
 *
 * ## Three things, in this order
 *
 * The **completion summary** first, because a consultant arriving here wants one
 * question answered: can I save this? Then the **paper canvas** with its
 * permanent label.
 *
 * **The document preview moved out of this step.** It is mounted by `wizard-shell` in a
 * column that persists from Sections onward, because a real preview costs a `python-docx`
 * render, a LibreOffice conversion and an upload — and mounting it inside a step threw
 * that away on every step change. What remains here is the completion summary.
 *
 * The order was deliberate. The canvas approximated and said so; the real preview
 * is the only surface permitted to state that its output is what the consultant
 * will receive (Requirement 14.6). Putting the approximation first and the truth
 * second means a consultant who stops reading half way has seen the caveat.
 *
 * The part with a wrong answer that costs something is **completion**: Requirement 11.10's
 * refusal, naming each failing step and each failing field path, and stating the
 * block rule where the count is zero. That is the part with a wrong answer that
 * costs something — a wizard that refused a save without saying which of seven
 * steps to open is a wizard a consultant cannot finish.
 *
 * ## Why the summary is a checklist rather than prose
 *
 * A consultant arriving here has filled in six steps and wants one question
 * answered: *can I save this?* A list with one line per step answers it at a
 * glance and, when the answer is no, doubles as the navigation — each failing
 * step is named, so the rail above has somewhere to be clicked.
 */
export function StepPreview({
  definition,
  problems,
}: Readonly<{
  definition: TemplateDefinition
  problems: readonly CompletionProblem[]
}>) {
  const ready = problems.length === 0

  return (
    <div className="flex flex-col gap-4">
      <div
        data-slot="completion-summary"
        className="flex items-start gap-2 rounded-lg border border-border px-3 py-2"
      >
        {ready ? (
          <CheckCircleIcon aria-hidden="true" className="mt-0.5 size-4" />
        ) : (
          <WarningCircleIcon
            aria-hidden="true"
            className="mt-0.5 size-4 text-destructive"
          />
        )}

        <div className="flex flex-col gap-1">
          <p className="text-sm">
            {ready
              ? "Every step passes. Saving creates the next version."
              : "This cannot be saved as a version yet."}
          </p>

          <p className="text-xs text-muted-foreground">
            {/*
              Requirement 9.5 — a save that changed nothing creates no version.
              Said here rather than discovered afterwards, so pressing save on an
              unchanged template is not mistaken for a failure.
            */}
            Saving compares the definition&rsquo;s canonical digest against the
            current version. If nothing changed, no version is created and the
            existing one is returned.
          </p>
        </div>
      </div>

      {ready ? null : (
        <ul data-slot="completion-problems" className="flex flex-col gap-2">
          {problems.map((problem, index) =>
            problem.kind === "no_sections" ? (
              <li
                key="no-content"
                className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive"
              >
                A report needs at least one section. Add one on step 2.
              </li>
            ) : (
              <li
                key={`${problem.step.id}-${index}`}
                className="flex flex-col gap-1 rounded-lg border border-destructive/40 px-3 py-2"
              >
                <p className="text-sm text-destructive">
                  Step{" "}
                  <span className="font-mono tabular-nums">
                    {problem.step.number}
                  </span>{" "}
                  · {problem.step.title}
                </p>

                {problem.issues.map((issue, issueIndex) => (
                  <p
                    key={`${issue.path.join(".")}-${issueIndex}`}
                    className="text-xs text-destructive"
                  >
                    <span className="font-mono">
                      {issue.path.join(".") || "definition"}
                    </span>{" "}
                    — {issue.message}
                  </p>
                ))}
              </li>
            )
          )}
        </ul>
      )}

      {/*
        What this preset declares, end to end.

        This was four counts — sections, resource types, metric entries, preset — which
        answered "is it filled in" and not "is it right". The step is called Review, and
        a reader on it is about to cut a version that a delivered report will be pinned
        to: they need to see the decisions, not a tally of them.

        Grouped by the step each fact came from, so a wrong one is one click from where
        it is changed. Values are mono where they are identifiers or figures, and every
        absent optional reads as an em dash rather than as blank — "not set" and "set to
        nothing" are different facts, and this is the screen that must not blur them.
      */}
      <div className="flex flex-col divide-y divide-border border-y border-border">
        {SUMMARY_GROUPS.map((group) => (
          <div
            key={group.title}
            className="grid gap-x-8 gap-y-3 py-4 sm:grid-cols-[10rem_1fr]"
          >
            <h3 className="text-micro text-muted-foreground uppercase">
              {group.title}
            </h3>

            <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
              {group.rows(definition).map((row) => (
                <div key={row.label} className="flex flex-col gap-0.5">
                  <dt className="text-meta text-muted-foreground">
                    {row.label}
                  </dt>
                  <dd
                    className={
                      row.mono
                        ? "font-mono text-sm tabular-nums"
                        : "text-sm"
                    }
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  )
}
