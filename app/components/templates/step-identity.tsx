"use client"

import { useId } from "react"
import { ArrowClockwiseIcon } from "@phosphor-icons/react"

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import type { TemplateDefinition } from "@/lib/templates/definition"
import {
  TEMPLATE_NAME_MAX_LENGTH,
  TEMPLATE_NAME_MIN_LENGTH,
  TEMPLATE_NAME_MESSAGE,
} from "@/lib/templates/input"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IdentitySaveResult =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "draft_saved_rename_failed"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }

type NameDivergence = {
  readonly storedName: string
  readonly draftName: string
}

/** The two document languages a v2+ definition declares (Requirement 15.1). */
const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "id", label: "Bahasa Indonesia" },
] as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Step 1 — identity (Requirement 11.1, 23.1–23.12).
 *
 * `name` is what the preset is called in the list; `report_title` is what is printed on
 * the cover of the document. They are separate fields and not one, because they answer
 * to different readers. The preset name and the customer sit on one row because they are
 * the two a consultant scans for; the language is a segmented choice because there are
 * exactly two and both should be visible at once.
 *
 * ## The rename contract (Requirement 23)
 *
 * On save, this step writes the submitted name to the draft definition's
 * `identity.name` AND invokes `renameTemplate` against `report_templates.name`,
 * in that order, as two separate writes. This is what keeps the preset list in
 * sync with the identity step.
 */
export function StepIdentity({
  definition,
  onChange,
  templateId: _templateId,
  storedName,
  saveState,
  onSave: _onSave,
  onRetryRename,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
  /** The template's id, for the rename call. */
  templateId: string
  /** The current `report_templates.name`, to detect divergence and skip no-ops. */
  storedName: string
  /** The current save state, controlled by the shell. */
  saveState: IdentitySaveResult
  /** Save the identity step: draft write + rename. Called by this component. */
  onSave: () => void
  /** Retry a failed rename. */
  onRetryRename: () => void
}>) {
  const nameId = useId()
  const titleId = useId()
  const customerId = useId()
  const descriptionId = useId()
  const languageId = useId()

  // --- Validation --------------------------------------------------------

  const trimmedName = definition.identity.name.trim()
  const nameValid =
    trimmedName.length >= TEMPLATE_NAME_MIN_LENGTH &&
    trimmedName.length <= TEMPLATE_NAME_MAX_LENGTH
  const nameError = !nameValid && definition.identity.name.length > 0

  // --- Divergence detection (Requirement 23.7) ---------------------------

  const divergence: NameDivergence | null =
    storedName !== definition.identity.name &&
    storedName !== "" &&
    definition.identity.name !== ""
      ? { storedName, draftName: definition.identity.name }
      : null

  const showDivergence =
    divergence !== null &&
    saveState.kind === "idle" &&
    storedName !== trimmedName

  const identity = definition.identity as TemplateDefinition["identity"] & {
    readonly language?: string
  }
  const language = identity.language === "id" ? "id" : "en"

  const set = (patch: Record<string, unknown>) => {
    onChange({
      ...definition,
      identity: { ...definition.identity, ...patch },
    } as TemplateDefinition)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field className="gap-1.5">
          <FieldLabel htmlFor={nameId}>Preset name</FieldLabel>
          <Input
            id={nameId}
            value={definition.identity.name}
            onChange={(event) => set({ name: event.target.value })}
            aria-invalid={nameError || undefined}
          />
          <FieldDescription className="text-xs">
            Only you see this. Not printed.
          </FieldDescription>
          {nameError ? (
            <p
              data-slot="identity-name-error"
              className="text-sm text-destructive"
              role="alert"
            >
              {TEMPLATE_NAME_MESSAGE}
            </p>
          ) : null}
        </Field>

        <Field className="gap-1.5">
          <FieldLabel htmlFor={customerId}>Customer name</FieldLabel>
          <Input
            id={customerId}
            value={definition.identity.customer_name ?? ""}
            onChange={(event) => set({ customer_name: event.target.value })}
          />
          {/*
            Requirement 12.2 — authored here rather than asked for per run, and a run is
            refused without one, so the description says both.
          */}
          <FieldDescription className="text-xs">
            Printed on the cover. Required to request a run.
          </FieldDescription>
        </Field>
      </div>

      {showDivergence ? (
        <div
          data-slot="identity-name-divergence"
          className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground"
          role="status"
        >
          <p>
            The list shows{" "}
            <span className="font-medium text-foreground">
              &ldquo;{divergence!.storedName}&rdquo;
            </span>{" "}
            but the draft says{" "}
            <span className="font-medium text-foreground">
              &ldquo;{divergence!.draftName}&rdquo;
            </span>
            . Saving will set both to the submitted value.
          </p>
        </div>
      ) : null}

      <Field className="gap-1.5">
        <FieldLabel htmlFor={titleId}>Report title</FieldLabel>
        <Input
          id={titleId}
          value={definition.identity.report_title ?? ""}
          onChange={(event) => set({ report_title: event.target.value })}
        />
        <FieldDescription className="text-xs">
          The cover headline and the running header.
        </FieldDescription>
      </Field>

      <div className="flex flex-col gap-1.5">
        <span id={languageId} className="text-sm font-medium">
          Document language
        </span>
        <div
          role="radiogroup"
          aria-labelledby={languageId}
          className="inline-flex w-fit gap-0.5 rounded-[9px] bg-muted p-[3px]"
        >
          {LANGUAGES.map(({ value, label }) => {
            const checked = language === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                onClick={() => set({ language: value })}
                onKeyDown={(event) => {
                  if (!event.key.startsWith("Arrow")) return
                  event.preventDefault()
                  const next = language === "en" ? "id" : "en"
                  set({ language: next })
                  const group = event.currentTarget.parentElement
                  requestAnimationFrame(() =>
                    group
                      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
                      ?.focus()
                  )
                }}
                className={cn(
                  "h-7.5 rounded-md px-3 text-meta font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30",
                  checked
                    ? "bg-card text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.05)]"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Headings, labels and dates in the delivered document.
        </p>
      </div>

      <Field className="gap-1.5">
        <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
        <textarea
          id={descriptionId}
          rows={2}
          value={definition.identity.description ?? ""}
          onChange={(event) => set({ description: event.target.value })}
          placeholder="Optional — a line that tells this preset apart from a similar one"
          className="min-h-16 w-full resize-y rounded-lg border border-input bg-muted px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      </Field>

      {saveState.kind === "draft_saved_rename_failed" ? (
        <div
          data-slot="identity-rename-failed"
          className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2"
          role="alert"
        >
          <p className="text-sm text-muted-foreground">
            The draft was saved, but{" "}
            <span className="font-medium text-foreground">
              the preset name was not updated
            </span>
            . The list may still show the previous name.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetryRename}
            data-slot="retry-rename"
          >
            <ArrowClockwiseIcon aria-hidden="true" />
            Retry rename
          </Button>
        </div>
      ) : null}
    </div>
  )
}
