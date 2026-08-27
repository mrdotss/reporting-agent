"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  FloppyDiskIcon,
} from "@phosphor-icons/react"

import {
  StepIdentity,
  type IdentitySaveResult,
} from "@/components/templates/step-identity"
import { StepMetrics } from "@/components/templates/step-metrics"
import { StepPeriod } from "@/components/templates/step-period"
import { StepPreview } from "@/components/templates/step-preview"
import {
  StepSections,
  type SectionCatalogueEntry,
} from "@/components/templates/step-sections"
import { Button } from "@/components/ui/button"
import type { TemplateView } from "@/lib/db/views"
import type {
  MetricCatalogSnapshot,
  TemplateDefinition,
} from "@/lib/templates/definition"
import type { ThemeThumbnail } from "@/lib/templates/theme-thumbnails"
import { EMPTY_DRAFT } from "@/lib/templates/draft"
import {
  canAdvance,
  canReturnTo,
  completionProblems,
  issuesByStep,
  nextStep as stepAfter,
  openingStep,
  previousStep as stepBefore,
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
  type WizardStep,
} from "@/lib/profiles/wizard"

/**
 * The seven-step wizard, and the **only** `"use client"` boundary on this screen
 * (Requirement 11).
 *
 * Every step below is a child of this component rather than an island of its own,
 * which is what makes "retain every value entered on every one of the seven
 * steps" (Requirement 11.2) structural: there is one draft object, held here, and
 * a step cannot reset a field it does not own because it does not own the state.
 *
 * ## Navigation, and the asymmetry that is the whole rule
 *
 * **Forward** is gated on the current step alone (Requirement 11.3): the wizard
 * stays put, names each failing field path, and presents no later step.
 *
 * **Backward** is never gated (Requirement 11.2). A consultant returning to step
 * 2 to fix step 2 must not be refused entry to step 2 because step 2 is wrong,
 * and `highestReached` only ever grows — so a step once reached stays reachable
 * even after an edit breaks an earlier one.
 *
 * ## Saving
 *
 * A step transition and the explicit save both persist the **draft**, and neither
 * inserts a version (Requirement 11.4). The draft is written unvalidated, on
 * purpose: a wizard that could only persist a valid draft would discard the
 * consultant's work every time they left a step mid-edit.
 *
 * A failed persist states that the draft was not saved and **changes nothing
 * else** (Requirement 11.9) — every entered value stays in the form, so the retry
 * is a button press rather than a re-entry.
 *
 * Completion is the only path that inserts a version, and only when every step
 * passes and the definition carries at least one block (Requirements 11.5,
 * 11.10).
 *
 * ## There is no upload control here, and that is asserted elsewhere
 *
 * Requirement 11.6 forbids one, and a comment is not an enforcement mechanism:
 * `test/boundaries.static.test.ts` asserts that no component under
 * `components/templates/` renders a file input for a document MIME type.
 */

type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly at: number }
  | { readonly kind: "failed"; readonly message: string }

type PublishState =
  | { readonly kind: "idle" }
  | { readonly kind: "publishing" }
  | {
      readonly kind: "published"
      readonly version: number
      readonly created: boolean
    }
  | { readonly kind: "refused"; readonly message: string }

type PatchResponse = { readonly error?: { readonly message?: string } }

type PublishResponse = {
  readonly version?: { readonly version: number }
  readonly created?: boolean
  readonly error?: {
    readonly message?: string
    readonly fields?: readonly {
      readonly path: string
      readonly message: string
    }[]
  }
}

export function WizardShell({
  template,
  initialDefinition,
  catalog,
  thumbnails: _thumbnails,
  sectionCatalogue,
  previewSubscriptionId,
  hasCompletedRun,
}: Readonly<{
  template: TemplateView
  /** The persisted draft, or the latest version's definition, or `null`. */
  initialDefinition: unknown
  catalog: MetricCatalogSnapshot
  /** Resolved on the server — see `StepDesign`'s own note. */
  thumbnails: readonly ThemeThumbnail[]
  /** The section catalogue, resolved server-side (sections.ts is server-only). */
  sectionCatalogue: readonly SectionCatalogueEntry[]
  /**
   * The subscription a real preview renders against, and whether one can be
   * rendered at all (Requirements 14.5, 14.7).
   *
   * Both resolved on the server: "is there a completed run for this
   * subscription" is a query, and Requirement 14.7 wants the action disabled
   * with the reason *before* a consultant presses it rather than after it fails.
   */
  previewSubscriptionId: string | null
  hasCompletedRun: boolean
}>) {
  const router = useRouter()

  const [definition, setDefinition] = useState<TemplateDefinition>(() =>
    initialDefinition === null
      ? EMPTY_DRAFT(template.name)
      : (initialDefinition as TemplateDefinition)
  )

  // Requirement 11.8 — the lowest-numbered failing step, or step 7 when every
  // step passes, computed **once** from the definition as it arrived. Recomputing
  // it as the consultant types would drag them backwards the moment an edit
  // briefly invalidated an earlier step.
  const [step, setStep] = useState<WizardStep>(() =>
    openingStep(initialDefinition ?? EMPTY_DRAFT(template.name))
  )

  const [highestReached, setHighestReached] = useState(step.number)
  const [save, setSave] = useState<SaveState>({ kind: "idle" })
  const [publish, setPublish] = useState<PublishState>({ kind: "idle" })

  // Requirement 23 — track the stored `report_templates.name` for rename logic.
  const [storedName, setStoredName] = useState(template.name)
  const [identitySave, setIdentitySave] = useState<IdentitySaveResult>({
    kind: "idle",
  })

  const issues = useMemo(() => issuesByStep(definition), [definition])
  const problems = useMemo(() => completionProblems(definition), [definition])

  /** The latest draft, for a persist that must not capture a stale closure. */
  const latest = useRef(definition)
  useEffect(() => {
    latest.current = definition
  }, [definition])

  const persistDraft = useCallback(async (): Promise<boolean> => {
    setSave({ kind: "saving" })

    try {
      const response = await fetch(`/api/report-profiles/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftDefinition: latest.current }),
      })

      if (!response.ok) {
        const body = (await response.json()) as PatchResponse
        // Requirement 11.9 — say the draft was not saved, and change nothing
        // else. No value is cleared and no step moves.
        setSave({
          kind: "failed",
          message:
            body.error?.message ??
            "The draft was not saved. Nothing you have entered was lost.",
        })
        return false
      }

      setSave({ kind: "saved", at: Date.now() })
      return true
    } catch {
      setSave({
        kind: "failed",
        message:
          "The draft was not saved — the server could not be reached. " +
          "Nothing you have entered was lost.",
      })
      return false
    }
  }, [template.id])

  // --- Requirement 23: identity step save with rename ----------------------

  const renameIfNeeded = useCallback(
    async (name: string): Promise<boolean> => {
      const trimmed = name.trim()
      // Skip rename when name matches stored name character for character.
      if (trimmed === storedName) return true

      try {
        const response = await fetch(`/api/report-profiles/${template.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        })
        if (!response.ok) return false
        setStoredName(trimmed)
        return true
      } catch {
        return false
      }
    },
    [storedName, template.id]
  )

  const saveIdentityStep = useCallback(async () => {
    const trimmed = latest.current.identity.name.trim()

    // Validation: 1-120 chars after trim. Refuse both writes.
    if (trimmed.length < 1 || trimmed.length > 120) {
      setIdentitySave({ kind: "idle" })
      return
    }

    setIdentitySave({ kind: "saving" })

    // 1. Write the draft definition
    const draftOk = await persistDraft()
    if (!draftOk) {
      setIdentitySave({
        kind: "failed",
        message:
          "The draft was not saved. Nothing you have entered was lost.",
      })
      return
    }

    // 2. Invoke rename (only if different)
    const renameOk = await renameIfNeeded(trimmed)
    if (!renameOk) {
      setIdentitySave({
        kind: "draft_saved_rename_failed",
        message:
          "The draft was saved, but the template name was not updated.",
      })
      return
    }

    setIdentitySave({ kind: "saved" })
  }, [persistDraft, renameIfNeeded])

  const retryRename = useCallback(async () => {
    const trimmed = latest.current.identity.name.trim()
    if (trimmed.length < 1 || trimmed.length > 120) return

    setIdentitySave({ kind: "saving" })
    const ok = await renameIfNeeded(trimmed)
    if (ok) {
      setIdentitySave({ kind: "saved" })
    } else {
      setIdentitySave({
        kind: "draft_saved_rename_failed",
        message:
          "The draft was saved, but the template name was not updated.",
      })
    }
  }, [renameIfNeeded])

  const goTo = useCallback(
    async (target: WizardStep) => {
      // Requirement 11.4 — a step transition persists the draft. Deliberately
      // **not** awaited before moving: a slow save must not make the wizard feel
      // stuck, and a failed one is reported in place while the consultant carries
      // on. Nothing is lost either way, because the draft lives in this
      // component until it is persisted.
      //
      // Requirement 23 — when leaving the identity step, also invoke the rename
      // so the template list stays in sync.
      if (step.id === "identity") {
        void saveIdentityStep()
      } else {
        void persistDraft()
      }

      setStep(target)
      setHighestReached((reached) => Math.max(reached, target.number))
    },
    [persistDraft, saveIdentityStep, step.id]
  )

  const advance = useCallback(() => {
    // Requirement 11.3 — refused on this step, with every failing path named.
    if (!canAdvance(step, issues)) return

    void goTo(stepAfter(step))
  }, [goTo, issues, step])

  const complete = useCallback(async () => {
    if (publish.kind === "publishing") return

    // Requirement 11.10 — refused, naming each failing step and each field path,
    // and stating the block rule where the count is zero. Checked here as well as
    // server-side so the consultant is told which step to open rather than shown
    // a bare 400.
    if (problems.length > 0) {
      setPublish({
        kind: "refused",
        message: "Some steps still need attention before this can be saved.",
      })
      return
    }

    setPublish({ kind: "publishing" })

    try {
      const response = await fetch(`/api/report-profiles/${template.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: latest.current }),
      })

      const body = (await response.json()) as PublishResponse

      if (!response.ok || body.version === undefined) {
        setPublish({
          kind: "refused",
          message:
            body.error?.message ?? "The template version could not be saved.",
        })
        return
      }

      setPublish({
        kind: "published",
        version: body.version.version,
        created: body.created ?? true,
      })

      router.refresh()
    } catch {
      setPublish({
        kind: "refused",
        message:
          "The template version could not be saved — the server could not be " +
          "reached.",
      })
    }
  }, [problems, publish.kind, router, template.id])

  // eslint-disable-next-line react-hooks/refs
  const stepBody = renderStep({
    step,
    definition,
    setDefinition,
    catalog,
    sectionCatalogue,
    problems,
    templateId: template.id,
    previewSubscriptionId,
    hasCompletedRun,
    storedName,
    identitySave,
    saveIdentityStep,
    retryRename,
  })

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-medium tracking-tight">
          {template.name}
        </h1>

        {/*
          Requirement 11.1 — the current step's position and the total of seven,
          on **every** step. In the header rather than inside a step body, so
          there is one place it is rendered and no step can omit it.
        */}
        <p
          data-slot="wizard-position"
          className="text-sm text-muted-foreground"
        >
          Step <span className="font-mono tabular-nums">{step.number}</span> of{" "}
          <span className="font-mono tabular-nums">{WIZARD_STEP_COUNT}</span> ·{" "}
          {step.title}
        </p>
      </header>

      <StepRail
        current={step}
        highestReached={highestReached}
        issues={issues}
        onSelect={(target) => void goTo(target)}
      />

      <section
        aria-labelledby="wizard-step-title"
        className="flex flex-col gap-4 rounded-xl border border-border px-4 py-4"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="wizard-step-title"
            className="font-heading text-sm font-medium tracking-tight"
          >
            {step.title}
          </h2>
          <p className="text-sm text-muted-foreground">{step.summary}</p>
        </div>

        {stepBody}

        {issues[step.id].length === 0 ? null : (
          <div
            data-slot="wizard-step-issues"
            // Requirement 11.3 — each failing field path, on this step.
            className="flex flex-col gap-1 rounded-lg border border-destructive/40 px-3 py-2"
          >
            {issues[step.id].map((issue, index) => (
              <p
                key={`${issue.path.join(".")}-${index}`}
                className="text-sm text-destructive"
              >
                <span className="font-mono">
                  {issue.path.join(".") || "definition"}
                </span>{" "}
                — {issue.message}
              </p>
            ))}
          </div>
        )}
      </section>

      <SaveNotice state={save} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={step.number === 1}
          onClick={() => void goTo(stepBefore(step))}
        >
          <ArrowLeftIcon aria-hidden="true" />
          Back
        </Button>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void (step.id === "identity"
                ? saveIdentityStep()
                : persistDraft())
            }
            disabled={
              save.kind === "saving" || identitySave.kind === "saving"
            }
          >
            <FloppyDiskIcon aria-hidden="true" />
            {save.kind === "saving" || identitySave.kind === "saving"
              ? "Saving…"
              : "Save draft"}
          </Button>

          {step.number === WIZARD_STEP_COUNT ? (
            <Button
              type="button"
              onClick={() => void complete()}
              disabled={publish.kind === "publishing"}
            >
              <CheckCircleIcon aria-hidden="true" />
              {publish.kind === "publishing" ? "Saving…" : "Save version"}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={advance}
              disabled={!canAdvance(step, issues)}
            >
              Next
              <ArrowRightIcon aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      <PublishNotice state={publish} />
    </div>
  )
}

/**
 * The seven-step rail.
 *
 * A `nav` of buttons rather than links: navigating a step is state in this
 * component, not a route, and a link would put the wizard's position in the URL
 * where a reload would restore a step rather than the step Requirement 11.8
 * derives from the draft.
 *
 * A step above `highestReached` is disabled rather than hidden — a consultant can
 * see there are seven and how far along they are, which is what Requirement 11.1's
 * "position and the total" is for.
 */
function StepRail({
  current,
  highestReached,
  issues,
  onSelect,
}: Readonly<{
  current: WizardStep
  highestReached: number
  issues: ReturnType<typeof issuesByStep>
  onSelect: (step: WizardStep) => void
}>) {
  return (
    <nav aria-label="Wizard steps" data-slot="wizard-rail">
      <ol className="flex flex-wrap gap-2">
        {WIZARD_STEPS.map((step) => {
          const reachable = canReturnTo(step, highestReached)
          const failing = issues[step.id].length > 0
          const isCurrent = step.id === current.id

          return (
            <li key={step.id}>
              <button
                type="button"
                disabled={!reachable}
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => onSelect(step)}
                className={[
                  "rounded-lg border px-3 py-1.5 text-xs focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none",
                  isCurrent
                    ? "border-primary text-foreground"
                    : "border-border text-muted-foreground",
                  reachable ? "" : "opacity-50",
                ].join(" ")}
              >
                <span className="font-mono tabular-nums">{step.number}</span>{" "}
                {step.title}
                {/*
                  A word, not only a colour: "needs attention" is readable to
                  somebody who cannot distinguish the border tint, and this rail
                  is the one place a consultant scans to find what is wrong.
                */}
                {failing ? (
                  <span className="text-destructive"> · needs attention</span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function SaveNotice({ state }: Readonly<{ state: SaveState }>) {
  if (state.kind === "idle") return null

  return (
    <p
      data-slot="wizard-save-state"
      // Announced: a draft save has no other visible effect, so a screen-reader
      // user would otherwise have no way to know whether it happened.
      aria-live="polite"
      className={
        state.kind === "failed"
          ? "text-sm text-destructive"
          : "text-sm text-muted-foreground"
      }
    >
      {state.kind === "saving"
        ? "Saving the draft…"
        : state.kind === "saved"
          ? "Draft saved. No version was created — a version is saved on the last step."
          : state.message}
    </p>
  )
}

function PublishNotice({ state }: Readonly<{ state: PublishState }>) {
  if (state.kind === "idle") return null

  return (
    <p
      data-slot="wizard-publish-state"
      aria-live="polite"
      className={
        state.kind === "refused"
          ? "text-sm text-destructive"
          : "text-sm text-muted-foreground"
      }
    >
      {state.kind === "publishing"
        ? "Saving the version…"
        : state.kind === "published"
          ? state.created
            ? `Saved as version ${state.version}.`
            : // Requirement 9.5 — a save that changed nothing creates no version,
              // and saying so is better than reporting a version number that is
              // not new.
              `No changes to save — this is still version ${state.version}.`
          : state.message}
    </p>
  )
}

function renderStep({
  step,
  definition,
  setDefinition,
  catalog,
  sectionCatalogue,
  problems,
  templateId,
  previewSubscriptionId,
  hasCompletedRun,
  storedName,
  identitySave,
  saveIdentityStep,
  retryRename,
}: Readonly<{
  step: WizardStep
  definition: TemplateDefinition
  setDefinition: (next: TemplateDefinition) => void
  catalog: MetricCatalogSnapshot
  sectionCatalogue: readonly SectionCatalogueEntry[]
  problems: ReturnType<typeof completionProblems>
  templateId: string
  previewSubscriptionId: string | null
  hasCompletedRun: boolean
  storedName: string
  identitySave: IdentitySaveResult
  saveIdentityStep: () => void
  retryRename: () => void
}>) {
  switch (step.id) {
    case "identity":
      return (
        <StepIdentity
          definition={definition}
          onChange={setDefinition}
          templateId={templateId}
          storedName={storedName}
          saveState={identitySave}
          onSave={saveIdentityStep}
          onRetryRename={retryRename}
        />
      )
    case "sections":
      return (
        <StepSections
          definition={definition}
          onChange={(next) => setDefinition(next as TemplateDefinition)}
          sectionCatalogue={sectionCatalogue}
        />
      )
    case "period":
      return <StepPeriod definition={definition} onChange={setDefinition} />
    case "document":
      return (
        <StepMetrics
          definition={definition}
          onChange={setDefinition}
          catalog={catalog}
        />
      )
    case "preview":
      return (
        <StepPreview
          definition={definition}
          problems={problems}
          templateId={templateId}
          // Requirement 14.1 — the canvas shows the `Html_Emitter`'s output, and
          // that output exists only once a real preview has produced it. `null`
          // until then, and the canvas says what it is waiting for rather than
          // rendering a page this component composed.
          previewHtml={null}
          selectedSubscriptionId={previewSubscriptionId}
          hasCompletedRun={hasCompletedRun}
        />
      )
  }
}
