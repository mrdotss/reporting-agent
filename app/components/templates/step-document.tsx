"use client"

import {
  FrontMatterForm,
  type ApproverConfig,
  type FrontMatterFormValues,
} from "@/components/templates/front-matter-form"
import type { TemplateDefinition } from "@/lib/templates/definition"

/**
 * Step 4 — the cover, document control and contents configuration.
 *
 * `FrontMatterForm` was built and fully tested by task 4.1 and rendered nowhere: the
 * step switch fell through to `StepMetrics`, which is both the wrong surface and a
 * crashing one, since the metric picker reads `definition.scope.resource_types` and a
 * v3 profile has no top-level `scope`.
 *
 * This component is the missing adapter, and it is only an adapter: the form owns every
 * field, its validation and its copy. All that happens here is the mapping between the
 * form's nullable value shape and the definition's `front_matter` section, which is a
 * superset relationship rather than a transformation -- so a field the definition omits
 * arrives as `null` and a field the form clears is written back as omitted rather than
 * as an empty string the validator would then have to interpret.
 */
export function StepDocument({
  definition,
  onChange,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
}>) {
  const stored = ((definition as unknown as Record<string, unknown>)
    .front_matter ?? {}) as {
    cover?: Record<string, unknown>
    document_control?: Record<string, unknown>
    toc?: Record<string, unknown>
  }

  const text = (value: unknown): string | null =>
    typeof value === "string" ? value : null

  const approvers: readonly ApproverConfig[] = Array.isArray(
    stored.document_control?.approvers
  )
    ? (stored.document_control.approvers as readonly Record<string, unknown>[]).map(
        (entry) => ({
          role: typeof entry.role === "string" ? entry.role : "",
          name: typeof entry.name === "string" ? entry.name : "",
          // The definition stores `title` only where one was given; the form always
          // renders the field, so an absent title is an empty string here and is
          // written back as one rather than as `undefined`.
          title: typeof entry.title === "string" ? entry.title : "",
        })
      )
    : []

  const values: FrontMatterFormValues = {
    cover: {
      logo: text(stored.cover?.logo),
      contact_block: text(stored.cover?.contact_block),
      subtitle: text(stored.cover?.subtitle),
    },
    document_control: {
      document_name: text(stored.document_control?.document_name),
      document_number_pattern: text(
        stored.document_control?.document_number_pattern
      ),
      confidentiality_notice_id: text(
        stored.document_control?.confidentiality_notice_id
      ),
      distribution: text(stored.document_control?.distribution),
      approvers,
    },
    toc: {
      enabled:
        typeof stored.toc?.enabled === "boolean" ? stored.toc.enabled : true,
      max_level:
        typeof stored.toc?.max_level === "number" ? stored.toc.max_level : 3,
    },
  }

  /** Drop `null` and `""` rather than storing them: the validator reads an absent
   * optional field as unset, and an empty string as a value somebody chose. */
  const present = (entries: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(entries).filter(
        ([, value]) => value !== null && value !== ""
      )
    )

  return (
    <FrontMatterForm
      values={values}
      onChange={(next) =>
        onChange({
          ...definition,
          front_matter: {
            cover: present({ ...next.cover }),
            document_control: {
              ...present({
                document_name: next.document_control.document_name,
                document_number_pattern:
                  next.document_control.document_number_pattern,
                confidentiality_notice_id:
                  next.document_control.confidentiality_notice_id,
                distribution: next.document_control.distribution,
              }),
              approvers: next.document_control.approvers,
            },
            toc: { ...next.toc },
          },
        } as unknown as TemplateDefinition)
      }
    />
  )
}
