"use client"

import { useId } from "react"

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { TemplateDefinition } from "@/lib/templates/definition"

/**
 * Step 1 — identity (Requirement 11.1).
 *
 * `name` is what the template is called in the list; `report_title` is what is
 * printed on the cover of the document. They are separate fields and not one,
 * because they answer to different readers: *"Monthly utilization"* is a good
 * name in a list of six templates and a poor title on a document sent to a
 * customer, where *"Contoso — infrastructure utilization"* is the other way
 * round.
 *
 * Both are edited through the same immutable-update shape every step uses: the
 * component holds no state of its own and calls `onChange` with a whole new
 * definition, so the shell stays the one place a draft lives.
 */
export function StepIdentity({
  definition,
  onChange,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
}>) {
  const nameId = useId()
  const titleId = useId()
  const descriptionId = useId()

  const set = (identity: Partial<TemplateDefinition["identity"]>) => {
    onChange({
      ...definition,
      identity: { ...definition.identity, ...identity },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor={nameId}>Template name</FieldLabel>
        <Input
          id={nameId}
          value={definition.identity.name}
          onChange={(event) => set({ name: event.target.value })}
        />
        <FieldDescription>
          What this template is called in your list. Not printed on the report.
        </FieldDescription>
      </Field>

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
    </div>
  )
}
