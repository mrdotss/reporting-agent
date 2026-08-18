"use client"

import { useCallback, useRef, useState } from "react"
import { FilePdfIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import type { TemplateDefinition } from "@/lib/templates/definition"
import { PREVIEW_BUDGET_MS } from "@/lib/templates/input"

/**
 * The real preview — the true `python-docx → LibreOffice → PDF` path
 * (Requirements 14.5 to 14.10).
 *
 * ## The only surface allowed to say "this is what you will receive"
 *
 * Requirement 14.6, and it is the reason this component exists as something
 * separate from the canvas rather than as a button on it. The HTML canvas
 * approximates; this `.pdf` **is** the renderer's output. Every other surface —
 * the canvas, the wizard, the report detail view — is forbidden from making that
 * claim, so the claim lives in exactly one file and is easy to audit.
 *
 * ## What is presented beside the `.pdf`, and why each
 *
 * Requirement 14.10 names four things, and each answers a question a consultant
 * would otherwise get wrong:
 *
 * - the **`snapshot_id`**, because the figures on the page are a real run's and
 *   the reader needs to know which;
 * - the **window with its UTC offset**, because "July" means July in the
 *   customer's zone and a reader in another one would assume otherwise;
 * - the **template version compiled**, which for a wizard preview is the draft
 *   rather than a saved version, and saying so stops it being mistaken for one;
 * - the statement that what this **demonstrates** is pagination, column widths
 *   and font metrics — because the figures are last month's, and a consultant
 *   showing this to a customer needs to know it is a layout proof and not a
 *   report.
 *
 * ## One activation at a time
 *
 * Requirement 14.8 ignores every further activation while a run is in progress.
 * A ref rather than the `inFlight` state, because two clicks in one React batch
 * both read the same pre-update state and both pass a state check — the ref is
 * written synchronously and is what actually holds the line.
 */

type PreviewResult = {
  readonly url: string
  readonly snapshotId: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly timezone: string
  readonly previewId: string
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "ready"; readonly result: PreviewResult }
  | { readonly kind: "failed"; readonly message: string }

type PreviewResponse = {
  readonly url?: string
  readonly snapshotId?: string
  readonly periodStart?: string
  readonly periodEnd?: string
  readonly timezone?: string
  readonly error?: { readonly message?: string; readonly code?: string }
}

export function RealPreviewPanel({
  templateId,
  definition,
  selectedSubscriptionId,
  hasCompletedRun,
}: Readonly<{
  templateId: string
  definition: TemplateDefinition
  selectedSubscriptionId: string | null
  /**
   * Whether a completed run exists for the selected subscription
   * (Requirement 14.7).
   *
   * Resolved on the server rather than discovered by activating and failing: the
   * requirement wants the action "in a disabled state carrying that reason",
   * which means knowing before the consultant presses it.
   */
  hasCompletedRun: boolean
}>) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const inFlight = useRef(false)
  const lastPreviewId = useRef<string | null>(null)

  const disabledReason =
    selectedSubscriptionId === null
      ? "Choose a connected subscription to preview against."
      : !hasCompletedRun
        ? "A completed run is required before a real preview can be rendered. " +
          "Run a report against that subscription first — the preview uses that " +
          "run's snapshot, and nothing here is rendered from placeholder data."
        : null

  const render = useCallback(async () => {
    // Requirement 14.8 — every further activation is ignored until this one
    // reaches a result.
    if (inFlight.current) return
    if (disabledReason !== null || selectedSubscriptionId === null) return

    inFlight.current = true
    setPhase({ kind: "running" })

    try {
      const response = await fetch(`/api/templates/${templateId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectedSubscriptionId: selectedSubscriptionId,
          definition,
          // The object this render replaces. Sent so the server can delete it
          // after responding rather than before rendering — deleting first
          // would remove the previous preview at the moment the new one might
          // fail, leaving this panel with nothing to show.
          ...(lastPreviewId.current === null
            ? {}
            : { supersedes: lastPreviewId.current }),
        }),
      })

      const body = (await response.json()) as PreviewResponse

      if (!response.ok || body.url === undefined) {
        // Requirement 14.9 — the message names the stage, and it is the
        // server's sentence rather than one composed here: only the runtime
        // knows whether compilation, the `.docx` or the conversion failed.
        setPhase({
          kind: "failed",
          message:
            body.error?.message ??
            "The real preview was not produced. The composed definition is unchanged.",
        })
        return
      }

      const previewId = new URL(body.url).pathname.split("/").at(-2) ?? null
      lastPreviewId.current = previewId

      setPhase({
        kind: "ready",
        result: {
          url: body.url,
          snapshotId: body.snapshotId ?? "",
          periodStart: body.periodStart ?? "",
          periodEnd: body.periodEnd ?? "",
          timezone: body.timezone ?? "",
          previewId: previewId ?? "",
        },
      })
    } catch {
      setPhase({
        kind: "failed",
        message:
          "The real preview was not produced — the server could not be reached. " +
          "The composed definition is unchanged.",
      })
    } finally {
      inFlight.current = false
    }
  }, [definition, disabledReason, selectedSubscriptionId, templateId])

  return (
    <section
      data-slot="real-preview-panel"
      className="flex flex-col gap-3 rounded-xl border border-border px-4 py-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-sm font-medium tracking-tight">
          Render a real preview
        </h3>

        <p className="max-w-prose text-sm text-muted-foreground">
          Runs the true rendering path — <code className="font-mono">python-docx</code>{" "}
          to LibreOffice to <code className="font-mono">.pdf</code> — against the
          most recent completed run&rsquo;s snapshot. This is the only place that
          shows you what the delivered document actually looks like.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() => void render()}
          disabled={disabledReason !== null || phase.kind === "running"}
        >
          <FilePdfIcon aria-hidden="true" />
          {phase.kind === "running"
            ? "Rendering…"
            : phase.kind === "ready"
              ? "Render again"
              : "Render real preview"}
        </Button>

        {/*
          Requirement 14.7 — the reason is beside the disabled control, in text.
          A disabled button with no explanation is a control a consultant presses
          repeatedly.
        */}
        {disabledReason === null ? null : (
          <p
            data-slot="real-preview-disabled-reason"
            className="max-w-prose text-xs text-muted-foreground"
          >
            {disabledReason}
          </p>
        )}
      </div>

      {phase.kind === "running" ? (
        <p
          data-slot="real-preview-progress"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          {/* Requirement 14.8 — in progress, said out loud, with the budget named. */}
          Compiling, rendering and converting. This takes up to{" "}
          {PREVIEW_BUDGET_MS / 1000} seconds; the preview above stays as it is.
        </p>
      ) : null}

      {phase.kind === "failed" ? (
        <p
          data-slot="real-preview-error"
          aria-live="polite"
          className="max-w-prose text-sm text-destructive"
        >
          {phase.message}
        </p>
      ) : null}

      {phase.kind === "ready" ? (
        <div className="flex flex-col gap-2">
          {/*
            Requirement 14.10 — the four facts, above the document rather than
            below it, so a consultant who screenshots the page captures them.
          */}
          <dl
            data-slot="real-preview-provenance"
            className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3"
          >
            <div className="flex flex-col">
              <dt className="text-muted-foreground">Snapshot</dt>
              <dd className="font-mono">
                {phase.result.snapshotId.slice(0, 12)}
              </dd>
            </div>

            <div className="flex flex-col">
              <dt className="text-muted-foreground">Window</dt>
              <dd className="font-mono tabular-nums">
                {phase.result.periodStart} to {phase.result.periodEnd} (
                {phase.result.timezone})
              </dd>
            </div>

            <div className="flex flex-col">
              <dt className="text-muted-foreground">Version compiled</dt>
              <dd>the draft on screen, unsaved</dd>
            </div>
          </dl>

          <p className="max-w-prose text-xs text-muted-foreground">
            The figures shown are that completed run&rsquo;s. What this
            demonstrates about the delivered result is{" "}
            <strong>pagination, table column widths and font metrics</strong>.
          </p>

          {/*
            Inline (Requirement 14.5), and there is deliberately **no download
            control**: a preview is not a report, and the key it lives under is
            one the report download predicate cannot parse.
          */}
          <iframe
            data-slot="real-preview-pdf"
            src={phase.result.url}
            title="Rendered preview"
            className="h-[42rem] w-full rounded-lg border border-border bg-white"
          />
        </div>
      ) : null}
    </section>
  )
}
