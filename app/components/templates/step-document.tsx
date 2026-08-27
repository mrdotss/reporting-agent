"use client"

import {
  FrontMatterForm,
  type ApproverConfig,
  type CoverFormValues,
  type DistributionRow,
  type DocumentControlFormValues,
  type FrontMatterFormValues,
  type TocFormValues,
} from "@/components/templates/front-matter-form"
import type { TemplateDefinition } from "@/lib/templates/definition"

/**
 * Step 4 — Document: the front matter's cover, document control and table of
 * contents (Requirements 12.1, 13.1-13.9, 14.1-14.4).
 *
 * ## `front_matter` reads defensively, because its type does not exist yet
 *
 * `TemplateDefinition.front_matter` is typed `unknown` — deliberately, per that
 * field's own doc comment, since the type declaration was deferred while the
 * validator's real field set (`FRONT_MATTER_KEYS`, `DOCUMENT_CONTROL_ALLOWED_KEYS`,
 * the v3 approver/distribution shapes) is what actually governs a v3 profile. This
 * step is the first real UI consumer of that field, so it reads every value
 * defensively (`readCover`/`readDocumentControl`/`readToc` below) rather than
 * trusting a cast — the same discipline `step-period.tsx` already applies to
 * `definition.period`.
 *
 * ## `confidentiality_notice_id` has no control here, on purpose
 *
 * Requirement 12.7: at `schema_version` 3 the confidentiality notice is inherited
 * from the Brand and resolved at publish (`resolveDesignFromBrand`'s own
 * pattern) — the validator rejects the key on a v3 profile outright. This step
 * therefore never writes it, and `FrontMatterForm`'s own type keeps the field only
 * so a v1/v2 stored value would round-trip unchanged if this step were ever
 * reused there, which it is not today (this wizard is v3-only).
 */

function readCover(frontMatter: unknown): CoverFormValues {
  const cover = isPlainObject(frontMatter)
    ? (frontMatter as Record<string, unknown>).cover
    : undefined
  const c = isPlainObject(cover) ? (cover as Record<string, unknown>) : {}
  return {
    logo: typeof c.logo === "string" ? c.logo : null,
    contact_block: typeof c.contact_block === "string" ? c.contact_block : null,
    subtitle: typeof c.subtitle === "string" ? c.subtitle : null,
  }
}

function readApprovers(raw: unknown): readonly ApproverConfig[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): ApproverConfig[] => {
    if (!isPlainObject(entry)) return []
    const e = entry as Record<string, unknown>
    if (typeof e.role !== "string") return []
    return [
      {
        role: e.role,
        name: typeof e.name === "string" ? e.name : "",
        title: typeof e.title === "string" ? e.title : "",
        company: typeof e.company === "string" ? e.company : "",
        signatureKey:
          typeof e.signature_key === "string" ? e.signature_key : null,
      },
    ]
  })
}

function readDistribution(raw: unknown): readonly DistributionRow[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): DistributionRow[] => {
    if (!isPlainObject(entry)) return []
    const e = entry as Record<string, unknown>
    return [
      {
        recipient: typeof e.recipient === "string" ? e.recipient : "",
        company: typeof e.company === "string" ? e.company : "",
        note: typeof e.note === "string" ? e.note : "",
      },
    ]
  })
}

function readDocumentControl(frontMatter: unknown): DocumentControlFormValues {
  const control = isPlainObject(frontMatter)
    ? (frontMatter as Record<string, unknown>).document_control
    : undefined
  const c = isPlainObject(control) ? (control as Record<string, unknown>) : {}
  return {
    document_name: typeof c.document_name === "string" ? c.document_name : null,
    document_number_pattern:
      typeof c.document_number_pattern === "string"
        ? c.document_number_pattern
        : null,
    confidentiality_notice_id:
      typeof c.confidentiality_notice_id === "string"
        ? c.confidentiality_notice_id
        : null,
    distribution: readDistribution(c.distribution),
    approvers: readApprovers(c.approvers),
  }
}

function readToc(frontMatter: unknown): TocFormValues {
  const toc = isPlainObject(frontMatter)
    ? (frontMatter as Record<string, unknown>).toc
    : undefined
  const t = isPlainObject(toc) ? (toc as Record<string, unknown>) : {}
  return {
    enabled: typeof t.enabled === "boolean" ? t.enabled : true,
    max_level: typeof t.max_level === "number" ? t.max_level : 3,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `FrontMatterFormValues` -> the wire shape the validator accepts, dropping
 * every field the consultant left untouched rather than writing an explicit
 * `null`/`[]` for it — matching `step-period.tsx`'s "write only what was
 * asked for" convention, and keeping a draft's `front_matter` free of noise a
 * consultant never set. */
function toWire(values: FrontMatterFormValues): Record<string, unknown> {
  const cover: Record<string, unknown> = {}
  if (values.cover.logo) cover.logo = values.cover.logo
  if (values.cover.contact_block)
    cover.contact_block = values.cover.contact_block
  if (values.cover.subtitle) cover.subtitle = values.cover.subtitle

  const documentControl: Record<string, unknown> = {}
  if (values.document_control.document_name) {
    documentControl.document_name = values.document_control.document_name
  }
  if (values.document_control.document_number_pattern) {
    documentControl.document_number_pattern =
      values.document_control.document_number_pattern
  }
  // confidentiality_notice_id is deliberately never written here (see module
  // docstring) — a v3 profile does not carry it at all.
  if (values.document_control.distribution.length > 0) {
    documentControl.distribution = values.document_control.distribution.map(
      (row) => ({
        recipient: row.recipient,
        company: row.company,
        note: row.note,
      })
    )
  }
  if (values.document_control.approvers.length > 0) {
    documentControl.approvers = values.document_control.approvers.map(
      (approver) => ({
        role: approver.role,
        name: approver.name,
        title: approver.title,
        company: approver.company,
        signature_key: approver.signatureKey,
      })
    )
  }

  return {
    cover,
    document_control: documentControl,
    toc: { enabled: values.toc.enabled, max_level: values.toc.max_level },
  }
}

export function StepDocument({
  definition,
  onChange,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
}>) {
  const values: FrontMatterFormValues = {
    cover: readCover(definition.front_matter),
    document_control: readDocumentControl(definition.front_matter),
    toc: readToc(definition.front_matter),
  }

  return (
    <FrontMatterForm
      values={values}
      onChange={(next) =>
        onChange({
          ...definition,
          front_matter: toWire(next),
        })
      }
    />
  )
}
