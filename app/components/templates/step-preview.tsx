"use client"

import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react"

import type { TemplateDefinition } from "@/lib/templates/definition"
import { blockCount, type CompletionProblem } from "@/lib/templates/wizard"

/**
 * Step 7 — preview and completion (Requirements 11.1, 11.5, 11.10).
 *
 * ## What is here and what is task 13.5's
 *
 * The **paper preview** — the HTML emitter running over the same AST the `.docx`
 * emitter uses, with its permanent preview label and the three named divergences
 * — is Requirement 14 and task 13.5's. So is the real-preview path that runs the
 * true `python-docx → LibreOffice → PDF` pipeline against a completed run's
 * snapshot.
 *
 * What this step owns, and owns now, is **completion**: Requirement 11.10's
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
  const blocks = blockCount(definition)
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
            problem.kind === "no_blocks" ? (
              <li
                key="no-blocks"
                className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive"
              >
                {/*
                  Requirement 11.10 — stated as a sentence, not as a field path.
                  "blocks — array must contain at least 1 element" is true and
                  tells a consultant nothing about what a report is.
                */}
                A report needs at least one block. Add one on step 5.
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

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Blocks</dt>
          <dd className="font-mono tabular-nums">{blocks}</dd>
        </div>

        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Resource types</dt>
          <dd className="font-mono tabular-nums">
            {definition.scope.resource_types.length === 0
              ? "all"
              : definition.scope.resource_types.length}
          </dd>
        </div>

        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Metric entries</dt>
          <dd className="font-mono tabular-nums">
            {Object.values(definition.metrics).reduce(
              (total, items) => total + items.length,
              0
            )}
          </dd>
        </div>

        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Preset</dt>
          <dd className="capitalize">{definition.design.preset}</dd>
        </div>
      </dl>

      <p className="max-w-prose text-xs text-muted-foreground">
        A paper preview of the composed document appears here once the HTML
        emitter is wired to this step. It will be an approximation: pagination,
        table column widths and font metrics are decided by Word, and the
        rendered <code>.pdf</code> is the delivered result.
      </p>
    </div>
  )
}
