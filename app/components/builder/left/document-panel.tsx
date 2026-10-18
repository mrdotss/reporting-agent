"use client"

import { useId } from "react"

import { useBuilder } from "@/components/builder/context"
import { Field, Segmented } from "@/components/builder/left/theme-panel"
import { StepDocument } from "@/components/templates/step-document"
import { StepPeriod } from "@/components/templates/step-period"
import type { DefinitionV4 } from "@/lib/builder/model"
import type { TemplateDefinition } from "@/lib/templates/definition"

/**
 * What the document is and who it is for: names, language, period and the front matter.
 *
 * The period and front matter controls are the ones the wizard used, unchanged — they
 * already write the right shape, so they are reused rather than rebuilt for a narrower
 * column.
 */

const INPUT =
  "h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function DocumentPanel() {
  const definition = useBuilder((state) => state.definition)
  const edit = useBuilder((state) => state.edit)
  const ids = { name: useId(), title: useId(), customer: useId(), description: useId() }
  const identity = definition.identity

  const setIdentity = (key: keyof DefinitionV4["identity"], value: string) =>
    edit((draft) => {
      ;(draft.identity as Record<string, string>)[key] = value
    })

  // The reused controls take and return a whole definition; only their part is kept.
  const replace = (next: TemplateDefinition) => {
    const value = next as unknown as DefinitionV4
    edit((draft) => {
      draft.period = value.period as typeof draft.period
      draft.front_matter = value.front_matter as typeof draft.front_matter
    })
  }

  return (
    <div className="flex flex-col gap-5 pb-4">
      <div className="flex flex-col gap-3">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Details</span>
        <Field label="Preset name">
          <input id={ids.name} aria-label="Preset name" className={INPUT} value={identity.name} maxLength={120} onChange={(e) => setIdentity("name", e.target.value)} />
        </Field>
        <Field label="Report title" hint="Printed on the cover. The preset name when empty.">
          <input id={ids.title} aria-label="Report title" className={INPUT} value={identity.report_title ?? ""} maxLength={200} onChange={(e) => setIdentity("report_title", e.target.value)} />
        </Field>
        <Field label="Customer" hint="Required before publishing: a run needs to know who the report is for.">
          <input id={ids.customer} aria-label="Customer" className={INPUT} value={identity.customer_name ?? ""} maxLength={200} onChange={(e) => setIdentity("customer_name", e.target.value)} />
        </Field>
        <Field label="Report language" hint="What the document prints in. Added text needs a version in this language.">
          <Segmented
            label="Report language"
            value={identity.language}
            options={[
              { value: "en", label: "English" },
              { value: "id", label: "Indonesian" },
            ]}
            onChange={(value) => setIdentity("language", value)}
          />
        </Field>
        <Field label="Description">
          <textarea
            id={ids.description}
            aria-label="Description"
            className="min-h-[64px] w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={identity.description ?? ""}
            maxLength={1000}
            onChange={(e) => setIdentity("description", e.target.value)}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Period</span>
        <StepPeriod definition={definition as unknown as TemplateDefinition} onChange={replace} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Front matter</span>
        <StepDocument definition={definition as unknown as TemplateDefinition} onChange={replace} />
      </div>
    </div>
  )
}
