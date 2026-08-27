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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Step 1 — identity (Requirement 11.1, 23.1–23.12).
 *
 * `name` is what the template is called in the list; `report_title` is what is
 * printed on the cover of the document. They are separate fields and not one,
 * because they answer to different readers.
 *
 * ## The rename contract (Requirement 23)
 *
 * On save, this step writes the submitted name to the draft definition's
 * `identity.name` AND invokes `renameTemplate` against `report_templates.name`,
 * in that order, as two separate writes. This is what keeps the template list in
 * sync with the identity step.
 *
 * The six failure modes are implemented distinctly — see the task description.
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
  const descriptionId = useId()

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

  // Show divergence only when the stored name differs from the draft name AND
  // the save state is idle (not just-failed-rename, which has its own message).
  const showDivergence =
    divergence !== null && saveState.kind === "idle" && storedName !== trimmedName

  const set = (identity: Partial<TemplateDefinition["identity"]>) => {
    onChange({
      ...definition,
      identity: { ...definition.identity, ...identity },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor={nameId}>Report profile name</FieldLabel>
        <Input
          id={nameId}
          value={definition.identity.name}
          onChange={(event) => set({ name: event.target.value })}
          aria-invalid={nameError || undefined}
        />
        <FieldDescription>
          What this template is called in your list. Not printed on the report.
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

      <Field>
        <FieldLabel htmlFor={titleId}>Report title</FieldLabel>
        <Input
          id={titleId}
          value={definition.identity.report_title ?? ""}
          onChange={(event) => set({ report_title: event.target.value })}
        />
        <FieldDescription>
          Printed on the document&rsquo;s cover page and in its header.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
        <Input
          id={descriptionId}
          value={definition.identity.description ?? ""}
          onChange={(event) => set({ description: event.target.value })}
        />
        <FieldDescription>
          Optional. A line to tell this template apart from a similar one.
        </FieldDescription>
      </Field>

      {/* Save state feedback */}
      {saveState.kind === "draft_saved_rename_failed" ? (
        <div
          data-slot="identity-rename-failed"
          className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2"
          role="alert"
        >
          <p className="text-sm text-muted-foreground">
            The draft was saved, but{" "}
            <span className="font-medium text-foreground">
              the template name was not updated
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
