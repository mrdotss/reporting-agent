"use client"

import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react"

import { PaperPreview } from "@/components/templates/paper-preview"
import { RealPreviewPanel } from "@/components/templates/real-preview-panel"
import type { TemplateDefinition } from "@/lib/templates/definition"
import { sectionCount, type CompletionProblem } from "@/lib/profiles/wizard"

/**
 * Step 7 — preview and completion (Requirements 11.1, 11.5, 11.10).
 *
 * ## Three things, in this order
 *
 * The **completion summary** first, because a consultant arriving here wants one
 * question answered: can I save this? Then the **paper canvas** with its
 * permanent label, then the **real preview**.
 *
 * The order is deliberate. The canvas approximates and says so; the real preview
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
  templateId,
  previewHtml,
  selectedSubscriptionId,
  hasCompletedRun,
}: Readonly<{
  definition: TemplateDefinition
  problems: readonly CompletionProblem[]
  templateId: string
  /**
   * The `Html_Emitter`'s output for the last real preview of this template, or
   * `null`.
   *
   * Emitted by the agent (Requirement 14.1) rather than composed here, so no
   * third layout definition exists. `null` until a real preview has been
   * rendered at least once — the canvas then says what it is waiting for rather
   * than inventing a page.
   */
  previewHtml: string | null
  selectedSubscriptionId: string | null
  hasCompletedRun: boolean
}>) {
  const sections = sectionCount(definition)
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

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Sections</dt>
          <dd className="font-mono tabular-nums">{sections}</dd>
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

      <PaperPreview
        html={previewHtml}
        emptyReason={
          sections === 0
            ? "Nothing to preview yet. Add at least one section on step 2."
            : "Render a real preview below and the composed page appears here."
        }
      />

      <RealPreviewPanel
        templateId={templateId}
        definition={definition}
        selectedSubscriptionId={selectedSubscriptionId}
        hasCompletedRun={hasCompletedRun}
      />
    </div>
  )
}
