"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/components/workspaces/workspace-shell"
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
export function RequestSummary({
  connectionId,
  templateId,
  timezone,
  disabled,
  submitting,
  blockedReason,
}: {
  connectionId: string
  templateId: string
  timezone: string
  disabled: boolean
  submitting: boolean
  /** Why the control is disabled, when it is. */
  blockedReason?: string
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
    <aside className="h-fit space-y-5 rounded-xl border bg-card p-6 lg:sticky lg:top-24">
      <div>
        <p className="text-micro text-muted-foreground uppercase">
          {messageText("ui.request_summary.heading", "en")}
        </p>
        <h2 className="text-section mt-3">
          {workspace?.projectName ?? "Your report"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {messageText("ui.request_summary.subheading", "en")}
        </p>
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
            ["Timezone", summary.timezone],
            ["Theme", summary.theme],
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
      <div className="flex flex-col gap-2">
        <Button
          className="w-full"
          type="submit"
          disabled={disabled || !summary || !!error}
        >
          {submitting ? "Submitting…" : "Generate report →"}
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
