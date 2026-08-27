"use client"

import { useCallback, useState } from "react"
import {
  CaretDown,
  CaretRight,
  Image as ImageIcon,
  Info,
  Signature,
  ListNumbers,
  FileText,
  Plus,
  Trash,
  SpinnerGap,
} from "@phosphor-icons/react"

import {
  APPROVER_ROLES,
  CONTACT_BLOCK_MAX_LENGTH,
  DISTRIBUTION_NOTE_MAX_LENGTH,
  DISTRIBUTION_RECIPIENT_MAX_LENGTH,
  DISTRIBUTION_ROW_COMPANY_MAX_LENGTH,
  DISTRIBUTION_ROWS_MAX_ENTRIES,
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_NUMBER_PATTERN_MAX_LENGTH,
  DOCUMENT_NUMBER_PATTERN_MIN_LENGTH,
  DOCUMENT_NUMBER_PLACEHOLDERS,
  DOCUMENT_NUMBER_VARYING_PLACEHOLDERS,
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
  /** What the shipped renderer maps to the document's "Company" table column
   * today. Kept exactly as it was at v1/v2 (`definition.ts`'s own note: "a
   * future task decides whether the renderer prefers `company` over `title`
   * once one exists" — that task has not landed, so this form still writes
   * `title` alongside the new `company` field below rather than replacing it). */
  readonly title: string
  /** The v3-only field schema_version 3 additionally accepts on an approver
   * entry (Requirement 13's own additive design) — not yet read by the
   * renderer, but legal to store. */
  readonly company: string
  /** An S3 object key under the signed-in user's prefix, or `null` when unsigned.
   * Never the image bytes and never a presigned URL — the same "a key, not the
   * content" rule every other stored artifact reference in this app follows. */
  readonly signatureKey: string | null
}

export type DistributionRow = {
  readonly recipient: string
  readonly company: string
  readonly note: string
}

export type CoverFormValues = {
  readonly logo: string | null
  readonly contact_block: string | null
  readonly subtitle: string | null
}

export type DocumentControlFormValues = {
  readonly document_name: string | null
  readonly document_number_pattern: string | null
  /**
   * `null` at v1/v2 (the profile carries no `confidentiality_notice_id` field at
   * all in the wizard's own draft-mode shape) — schema_version 3 never accepts
   * this key on the profile either way (Requirement 12.7: inherited from the
   * Brand, resolved at publish), so the form never renders a control for it.
   * Retained on the type only so a caller reading a v1/v2 stored value round-trips
   * it unchanged; this form never writes to it.
   */
  readonly confidentiality_notice_id: string | null
  /** Ordered `{recipient, company, note}` rows — schema_version 3's own shape
   * (Requirement 12.6). There is no v1/v2 caller of this form left to support the
   * free-text string distribution used to be; see the module docstring. */
  readonly distribution: readonly DistributionRow[]
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

/**
 * One approver's name, company and signature upload (Req 13.5, 13.6).
 *
 * The upload posts raw bytes to `/api/report-profiles/signature`, which sniffs
 * the content before writing — never a client-direct presigned `PUT`, since that
 * would skip the one check that matters ("is this actually a raster image").
 * The response's `key` is stored on the approver row; the preview `<img>` reads
 * a **separate** presigned GET, minted fresh on each render rather than cached,
 * matching every other artifact preview in this app.
 */
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
  const signatureKey = approver?.signatureKey ?? null
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploadState, setUploadState] = useState<
    "idle" | "uploading" | "error"
  >("idle")

  const emit = useCallback(
    (patch: Partial<ApproverConfig>) => {
      onChange({
        role,
        name,
        title,
        company: approver?.company ?? "",
        signatureKey,
        ...patch,
      })
    },
    [role, name, title, approver, signatureKey, onChange]
  )

  const loadPreview = useCallback((key: string) => {
    setPreviewUrl(null)
    fetch(`/api/report-profiles/signature?key=${encodeURIComponent(key)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { url: string } | null) => {
        if (body) setPreviewUrl(body.url)
      })
      .catch(() => setPreviewUrl(null))
  }, [])

  const handleFile = useCallback(
    (file: File) => {
      setUploadState("uploading")
      file
        .arrayBuffer()
        .then((buffer) =>
          fetch("/api/report-profiles/signature", {
            method: "POST",
            body: buffer,
          })
        )
        .then(async (res) => {
          if (!res.ok) throw new Error("upload rejected")
          const body: { key: string } = await res.json()
          setUploadState("idle")
          emit({ signatureKey: body.key })
          loadPreview(body.key)
        })
        .catch(() => setUploadState("error"))
    },
    [emit, loadPreview]
  )

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
          onChange={(e) => emit({ name: e.target.value })}
          className="h-8 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
        />
        <input
          type="text"
          placeholder="Company"
          value={title}
          maxLength={APPROVER_TITLE_MAX_LENGTH}
          aria-label={`${role} company`}
          onChange={(e) => emit({ title: e.target.value })}
          className="h-8 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
        />
      </div>

      <div className="flex items-center gap-2">
        {signatureKey ? (
          <>
            <div className="flex h-10 w-24 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt={`${role} signature`}
                  className="h-full w-full object-contain"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => loadPreview(signatureKey)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Show preview
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label={`Remove ${role} signature`}
              onClick={() => {
                emit({ signatureKey: null })
                setPreviewUrl(null)
              }}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              <Trash aria-hidden className="size-4" />
            </button>
          </>
        ) : (
          <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-input px-2.5 text-xs text-muted-foreground hover:bg-accent/50">
            {uploadState === "uploading" ? (
              <SpinnerGap aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <ImageIcon aria-hidden className="size-3.5" />
            )}
            Upload signature
            <input
              type="file"
              accept="image/png,image/jpeg"
              aria-label={`Upload ${role} signature`}
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
                e.target.value = ""
              }}
            />
          </label>
        )}
        {uploadState === "error" && (
          <span className="text-xs text-destructive" role="alert">
            Upload failed — try a PNG or JPEG under 2 MiB.
          </span>
        )}
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
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
                <li key={ph} className="text-xs">
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
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">Distribution</span>
          <div className="flex flex-col gap-2">
            {values.document_control.distribution.map((row, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={row.recipient}
                  maxLength={DISTRIBUTION_RECIPIENT_MAX_LENGTH}
                  placeholder="Recipient"
                  aria-label={`Distribution row ${index + 1} recipient`}
                  onChange={(e) => {
                    const next = [...values.document_control.distribution]
                    next[index] = { ...row, recipient: e.target.value }
                    onChange({
                      ...values,
                      document_control: {
                        ...values.document_control,
                        distribution: next,
                      },
                    })
                  }}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                />
                <input
                  type="text"
                  value={row.company}
                  maxLength={DISTRIBUTION_ROW_COMPANY_MAX_LENGTH}
                  placeholder="Company"
                  aria-label={`Distribution row ${index + 1} company`}
                  onChange={(e) => {
                    const next = [...values.document_control.distribution]
                    next[index] = { ...row, company: e.target.value }
                    onChange({
                      ...values,
                      document_control: {
                        ...values.document_control,
                        distribution: next,
                      },
                    })
                  }}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                />
                <input
                  type="text"
                  value={row.note}
                  maxLength={DISTRIBUTION_NOTE_MAX_LENGTH}
                  placeholder="Note"
                  aria-label={`Distribution row ${index + 1} note`}
                  onChange={(e) => {
                    const next = [...values.document_control.distribution]
                    next[index] = { ...row, note: e.target.value }
                    onChange({
                      ...values,
                      document_control: {
                        ...values.document_control,
                        distribution: next,
                      },
                    })
                  }}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                />
                <button
                  type="button"
                  aria-label={`Remove distribution row ${index + 1}`}
                  onClick={() => {
                    const next = values.document_control.distribution.filter(
                      (_, i) => i !== index
                    )
                    onChange({
                      ...values,
                      document_control: {
                        ...values.document_control,
                        distribution: next,
                      },
                    })
                  }}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                >
                  <Trash aria-hidden className="size-4" />
                </button>
              </div>
            ))}
          </div>
          {values.document_control.distribution.length <
            DISTRIBUTION_ROWS_MAX_ENTRIES && (
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...values,
                  document_control: {
                    ...values.document_control,
                    distribution: [
                      ...values.document_control.distribution,
                      { recipient: "", company: "", note: "" },
                    ],
                  },
                })
              }
              className="flex h-8 w-fit items-center gap-1.5 rounded-md border border-dashed border-input px-2.5 text-xs text-muted-foreground hover:bg-accent/50"
            >
              <Plus aria-hidden className="size-3.5" />
              Add recipient
            </button>
          )}
        </div>

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
                  // Only store the row once it carries something, so an approver
                  // slot nobody touched never round-trips as an empty entry.
                  if (updated.name || updated.company || updated.signatureKey) {
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
                  max_level: Math.max(
                    1,
                    Math.min(4, Number(e.target.value) || 3)
                  ),
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
