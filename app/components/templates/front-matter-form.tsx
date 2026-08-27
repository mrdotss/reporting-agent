"use client"

import { useState } from "react"
import {
  CaretDown,
  CaretRight,
  Image as ImageIcon,
  Info,
  Signature,
  ListNumbers,
  FileText,
} from "@phosphor-icons/react"

import {
  APPROVER_ROLES,
  CONTACT_BLOCK_MAX_LENGTH,
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_NUMBER_PATTERN_MAX_LENGTH,
  DOCUMENT_NUMBER_PATTERN_MIN_LENGTH,
  DOCUMENT_NUMBER_PLACEHOLDERS,
  DOCUMENT_NUMBER_VARYING_PLACEHOLDERS,
  DISTRIBUTION_MAX_LENGTH,
  SUBTITLE_MAX_LENGTH,
  APPROVER_NAME_MAX_LENGTH,
  APPROVER_TITLE_MAX_LENGTH,
  LOGO_MAX_LENGTH,
} from "@/lib/templates/definition"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApproverConfig = {
  readonly role: string
  readonly name: string
  readonly title: string
}

export type CoverFormValues = {
  readonly logo: string | null
  readonly contact_block: string | null
  readonly subtitle: string | null
}

export type DocumentControlFormValues = {
  readonly document_name: string | null
  readonly document_number_pattern: string | null
  readonly confidentiality_notice_id: string | null
  readonly distribution: string | null
  readonly approvers: readonly ApproverConfig[]
}

export type TocFormValues = {
  readonly enabled: boolean
  readonly max_level: number
}

export type FrontMatterFormValues = {
  readonly cover: CoverFormValues
  readonly document_control: DocumentControlFormValues
  readonly toc: TocFormValues
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The TOC adopted approach. When `none`, the TOC section is presented as
 * "retained and not emitted" — a later adoption needs no edit to a stored
 * definition (Req 14.3, 14.10).
 *
 * This value mirrors `agent/.../render/toc.py`'s `ADOPTED_APPROACH`. The
 * component reads it to decide what label the TOC section shows.
 */
export const TOC_ADOPTED_APPROACH: "none" | "two_pass_measure" =
  "two_pass_measure"

const PLACEHOLDER_DESCRIPTIONS: Record<string, string> = {
  "{template}": "Report profile identifier",
  "{year}": "Period start year (4-digit)",
  "{month}": "Period start month (2-digit)",
  "{run}": "Run identifier (unique per run)",
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type PatternIssue = { message: string }

function validateDocumentNumberPattern(pattern: string): PatternIssue | null {
  if (
    pattern.length < DOCUMENT_NUMBER_PATTERN_MIN_LENGTH ||
    pattern.length > DOCUMENT_NUMBER_PATTERN_MAX_LENGTH
  ) {
    return {
      message: `Pattern must be ${DOCUMENT_NUMBER_PATTERN_MIN_LENGTH}–${DOCUMENT_NUMBER_PATTERN_MAX_LENGTH} characters.`,
    }
  }

  const found = [...pattern.matchAll(/\{[^{}]*\}/g)].map((m) => m[0])
  const undeclared = found.filter(
    (token) =>
      !(DOCUMENT_NUMBER_PLACEHOLDERS as readonly string[]).includes(token)
  )
  if (undeclared.length > 0) {
    return {
      message: `Undeclared placeholder(s): ${undeclared.join(", ")}. Declared: ${DOCUMENT_NUMBER_PLACEHOLDERS.join(", ")}.`,
    }
  }

  const varying: readonly string[] = DOCUMENT_NUMBER_VARYING_PLACEHOLDERS
  if (!found.some((token) => varying.includes(token))) {
    return {
      message: `Pattern must include at least one of ${varying.join(", ")} to distinguish re-runs of the same period.`,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Signature slot component
// ---------------------------------------------------------------------------

function SignatureSlot({
  role,
  approver,
  onChange,
}: Readonly<{
  role: string
  approver: ApproverConfig | undefined
  onChange: (updated: ApproverConfig) => void
}>) {
  const name = approver?.name ?? ""
  const title = approver?.title ?? ""

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Signature aria-hidden className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium capitalize">{role}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <input
          type="text"
          placeholder="Name"
          value={name}
          maxLength={APPROVER_NAME_MAX_LENGTH}
          aria-label={`${role} name`}
          onChange={(e) =>
            onChange({ role, name: e.target.value, title })
          }
          className="h-8 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
        />
        <input
          type="text"
          placeholder="Company / title"
          value={title}
          maxLength={APPROVER_TITLE_MAX_LENGTH}
          aria-label={`${role} company`}
          onChange={(e) =>
            onChange({ role, name, title: e.target.value })
          }
          className="h-8 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
        />
      </div>

      <p className="text-xs text-muted-foreground">
        An unsupplied signature renders a ruled box — never the typed name.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

function Section({
  title,
  icon: Icon,
  defaultOpen = true,
  badge,
  children,
}: Readonly<{
  title: string
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  defaultOpen?: boolean
  badge?: string
  children: React.ReactNode
}>) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-medium hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
      >
        {open ? (
          <CaretDown aria-hidden className="size-3.5 text-muted-foreground" />
        ) : (
          <CaretRight aria-hidden className="size-3.5 text-muted-foreground" />
        )}
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <span>{title}</span>
        {badge && (
          <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {badge}
          </span>
        )}
      </button>

      {open && <div className="flex flex-col gap-3 pl-6">{children}</div>}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * The fixed front-matter section of the template builder (Req 13.1, 13.2, 13.3).
 *
 * Presents the cover, document control and table-of-contents configuration as a
 * **fixed section** the canvas shows above the content, never a reorderable item.
 *
 * ## Design decisions
 *
 * - Signature slots are per-role uploads with the explicit statement that an
 *   unsupplied signature renders a ruled box and never the typed name.
 * - The document-number pattern shows its closed placeholder set enumerated,
 *   and validates on the step rather than at save.
 * - Where `ADOPTED_APPROACH` is `none`, the TOC configuration is presented
 *   as **retained and not emitted** rather than hidden, so a later adoption
 *   needs no edit to a stored definition.
 */
export function FrontMatterForm({
  values,
  onChange,
}: Readonly<{
  values: FrontMatterFormValues
  onChange: (next: FrontMatterFormValues) => void
}>) {
  const patternIssue = values.document_control.document_number_pattern
    ? validateDocumentNumberPattern(
        values.document_control.document_number_pattern
      )
    : null

  return (
    <div
      data-slot="front-matter-form"
      role="region"
      aria-label="Front matter configuration"
      className="flex flex-col gap-4 rounded-xl border border-border bg-sidebar/50 px-4 py-4"
    >
      <div className="flex items-center gap-2">
        <FileText aria-hidden className="size-4 text-primary" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Front Matter
        </h2>
        <span className="ml-auto text-xs text-muted-foreground">Fixed</span>
      </div>

      {/* ---- Cover ---- */}
      <Section title="Cover" icon={ImageIcon}>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Logo URL</span>
          <input
            type="text"
            value={values.cover.logo ?? ""}
            maxLength={LOGO_MAX_LENGTH}
            placeholder="https://..."
            onChange={(e) =>
              onChange({
                ...values,
                cover: {
                  ...values.cover,
                  logo: e.target.value || null,
                },
              })
            }
            className="h-8 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Subtitle</span>
          <input
            type="text"
            value={values.cover.subtitle ?? ""}
            maxLength={SUBTITLE_MAX_LENGTH}
            placeholder="Optional subtitle"
            onChange={(e) =>
              onChange({
                ...values,
                cover: {
                  ...values.cover,
                  subtitle: e.target.value || null,
                },
              })
            }
            className="h-8 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Contact block</span>
          <textarea
            value={values.cover.contact_block ?? ""}
            maxLength={CONTACT_BLOCK_MAX_LENGTH}
            placeholder="Name, email, phone"
            rows={2}
            onChange={(e) =>
              onChange({
                ...values,
                cover: {
                  ...values.cover,
                  contact_block: e.target.value || null,
                },
              })
            }
            className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          />
        </label>
      </Section>

      {/* ---- Document Control ---- */}
      <Section title="Document Control" icon={FileText}>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Document name</span>
          <input
            type="text"
            value={values.document_control.document_name ?? ""}
            maxLength={DOCUMENT_NAME_MAX_LENGTH}
            placeholder="e.g. Monthly Infrastructure Report"
            onChange={(e) =>
              onChange({
                ...values,
                document_control: {
                  ...values.document_control,
                  document_name: e.target.value || null,
                },
              })
            }
            className="h-8 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          />
        </label>

        {/* Document number pattern */}
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              Document number pattern
            </span>
            <input
              type="text"
              value={values.document_control.document_number_pattern ?? ""}
              maxLength={DOCUMENT_NUMBER_PATTERN_MAX_LENGTH}
              placeholder="e.g. RPT/{template}/{year}{month}/{run}"
              aria-invalid={patternIssue !== null}
              aria-describedby="doc-number-desc"
              onChange={(e) => {
                onChange({
                  ...values,
                  document_control: {
                    ...values.document_control,
                    document_number_pattern: e.target.value || null,
                  },
                })
              }}
              className="h-8 rounded-md border border-input bg-background px-2.5 font-mono text-sm placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none aria-[invalid=true]:border-destructive"
            />
          </label>

          {patternIssue && (
            <p className="text-xs text-destructive" role="alert">
              {patternIssue.message}
            </p>
          )}

          <div id="doc-number-desc" className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">
              Placeholders (closed set):
            </p>
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {DOCUMENT_NUMBER_PLACEHOLDERS.map((ph) => (
                <li
                  key={ph}
                  className="text-xs"
                >
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                    {ph}
                  </code>
                  <span className="ml-1 text-muted-foreground">
                    {PLACEHOLDER_DESCRIPTIONS[ph]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Distribution */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Distribution</span>
          <input
            type="text"
            value={values.document_control.distribution ?? ""}
            maxLength={DISTRIBUTION_MAX_LENGTH}
            placeholder="Internal / Customer"
            onChange={(e) =>
              onChange({
                ...values,
                document_control: {
                  ...values.document_control,
                  distribution: e.target.value || null,
                },
              })
            }
            className="h-8 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          />
        </label>

        {/* Approvers / signature slots */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Signature slots
          </span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {APPROVER_ROLES.map((role) => (
              <SignatureSlot
                key={role}
                role={role}
                approver={values.document_control.approvers.find(
                  (a) => a.role === role
                )}
                onChange={(updated) => {
                  const next = values.document_control.approvers.filter(
                    (a) => a.role !== role
                  )
                  // Only store if name or title is non-empty
                  if (updated.name || updated.title) {
                    next.push(updated)
                  }
                  onChange({
                    ...values,
                    document_control: {
                      ...values.document_control,
                      approvers: next,
                    },
                  })
                }}
              />
            ))}
          </div>
        </div>
      </Section>

      {/* ---- Table of Contents ---- */}
      <Section
        title="Table of Contents"
        icon={ListNumbers}
        badge={
          TOC_ADOPTED_APPROACH === "none" ? "retained, not emitted" : undefined
        }
      >
        {TOC_ADOPTED_APPROACH === "none" && (
          <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
            <Info
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">
              The table of contents approach is not yet adopted. This
              configuration is retained so a later adoption needs no edit to a
              stored definition.
            </p>
          </div>
        )}

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={values.toc.enabled}
            onChange={(e) =>
              onChange({
                ...values,
                toc: { ...values.toc, enabled: e.target.checked },
              })
            }
            className="size-4 rounded border-border text-primary accent-primary focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <span className="text-sm">
            Include table of contents
            {TOC_ADOPTED_APPROACH === "none" && " (when available)"}
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Maximum heading level (1–4)
          </span>
          <input
            type="number"
            min={1}
            max={4}
            value={values.toc.max_level}
            onChange={(e) =>
              onChange({
                ...values,
                toc: {
                  ...values.toc,
                  max_level: Math.max(1, Math.min(4, Number(e.target.value) || 3)),
                },
              })
            }
            className="h-8 w-20 rounded-md border border-input bg-background px-2.5 text-sm focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          />
        </label>
      </Section>
    </div>
  )
}
