"use client"
import { useEffect, useState } from "react"
import { ArrowRightIcon } from "@phosphor-icons/react"
import { ReportCover } from "@/components/reports/report-cover"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/components/workspaces/workspace-context"
import { messageText } from "@/lib/messages/catalog"
type Summary = {
  connection: string
  version: number
  periodStart: string
  periodEnd: string
  timezone: string
  theme: string
  sections: number | null
}
/** How many section names the summary lists before "+N more". */
const SECTIONS_SHOWN = 5

export function RequestSummary({
  connectionId,
  templateId,
  timezone,
  disabled,
  submitting,
  blockedReason,
  regions,
  cover = null,
  sectionTitles = [],
}: {
  connectionId: string
  templateId: string
  timezone: string
  disabled: boolean
  submitting: boolean
  /** Why the control is disabled, when it is. */
  blockedReason?: string
  /** The AWS regions the run covers, as a line; absent when the connector offers no choice. */
  regions?: string
  /** The cover picture's lines, or `null` before a preset is chosen. */
  cover?: { title: string; customer: string | null; kicker: string } | null
  /** The chosen preset's sections, in order, for the chips under the summary. */
  sectionTitles?: readonly string[]
}) {
  const workspace = useWorkspace()
  const [summary, setSummary] = useState<Summary | null>(null),
    [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    if (!connectionId || !templateId) return
    const q = new URLSearchParams({
      connectedSubscriptionId: connectionId,
      templateId,
      timezone,
    })
    fetch(`/api/runs/summary?${q}`, { signal: controller.signal })
      .then(async (r) => {
        const b = await r.json()
        if (!r.ok)
          throw new Error(
            b.error?.message ?? "The request summary is unavailable."
          )
        if (!controller.signal.aborted) setSummary(b)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message)
      })
    return () => controller.abort()
  }, [connectionId, templateId, timezone])
  return (
    <aside
      data-slot="request-summary"
      className="h-fit space-y-5 overflow-hidden rounded-2xl border bg-card p-5 lg:sticky lg:top-24"
    >
      <div className="flex flex-col gap-3">
        <p className="font-mono text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
          {messageText("ui.request_summary.heading", "en")}
        </p>
        {/*
          The cover, as the report will open. Drawn from the choices on the left, so it
          changes as they do — the one place on the page that shows what is being made
          rather than what it is made from.
        */}
        {cover === null ? null : (
          <ReportCover title={cover.title} customer={cover.customer} kicker={cover.kicker} />
        )}
        <div>
          <h2 className="text-section">
            {workspace?.projectName ?? "Your report"}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {messageText("ui.request_summary.subheading", "en")}
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !summary ? (
        <p role="status" className="text-sm text-muted-foreground">
          {connectionId && templateId
            ? "Resolving profile settings…"
            : "Select a connection and saved profile."}
        </p>
      ) : (
        <dl className="text-sm">
          {[
            ["Connection", summary.connection],
            ["Profile version", String(summary.version)],
            ["Period", `${summary.periodStart} – ${summary.periodEnd}`],
            ...(regions === undefined ? [] : [["Regions", regions]]),
            [
              "Sections",
              summary.sections === null
                ? "Profile-defined"
                : String(summary.sections),
            ],
            ["Output", "PDF and Word"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-6 border-t py-3">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="max-w-[65%] text-right font-medium break-words">
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {error || !summary || sectionTitles.length === 0 ? null : (
        <ul
          data-slot="request-summary-sections"
          aria-label={messageText("ui.request_summary.sections_label", "en") ?? undefined}
          className="flex flex-wrap gap-1.5"
        >
          {sectionTitles.slice(0, SECTIONS_SHOWN).map((title, index) => (
            <li key={`${title}-${index}`} className="rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
              {title}
            </li>
          ))}
          {sectionTitles.length > SECTIONS_SHOWN ? (
            <li className="rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-primary">
              {messageText("ui.request_summary.sections_more", "en", { count: String(sectionTitles.length - SECTIONS_SHOWN) })}
            </li>
          ) : null}
        </ul>
      )}
      {error || !summary ? null : (
        /* What a reviewer rarely needs to check, folded beneath the rest. */
        <details data-slot="request-summary-details" className="border-t pt-3 text-sm">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30">
            {messageText("ui.request_summary.details", "en")}
          </summary>
          <dl className="mt-2 flex flex-col gap-2">
            {[
              ["Timezone", summary.timezone],
              ["Theme", summary.theme],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-6">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right font-medium break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <div className="flex flex-col gap-2">
        <Button
          className="h-12 w-full rounded-xl text-[15px]"
          type="submit"
          disabled={disabled || !summary || !!error}
        >
          {submitting ? "Submitting…" : messageText("ui.request_summary.generate", "en")}
          {submitting ? null : <ArrowRightIcon aria-hidden="true" />}
        </Button>

        {/*
          Why it is disabled, beside it.
          The reason used to be four lines up the other column, under the fields it
          refers to, so the control a consultant was actually looking at just refused.
          `aria-live` because the button going from enabled to disabled is otherwise a
          silent change.
        */}
        {blockedReason === undefined ? null : (
          <p
            data-slot="request-summary-blocked"
            aria-live="polite"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {blockedReason}
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {messageText("ui.request_summary.period_hint", "en")}
      </p>
    </aside>
  )
}
