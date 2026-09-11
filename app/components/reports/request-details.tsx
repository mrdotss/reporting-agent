import { Card, CardContent } from "@/components/ui/card"
import type { RunView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import { periodLine } from "@/lib/runs/presentation"

/**
 * What was asked for, beside what is happening about it.
 *
 * Every value is read off the run row. Nothing here is derived, defaulted or inferred —
 * a request summary that quietly filled in a timezone or a version would be describing a
 * run nobody submitted, on the one screen a consultant checks when a figure looks wrong.
 *
 * `templateName` and `templateVersion` are nullable for a foundation-era row that pins no
 * version, so both say so rather than printing a confident blank.
 */
export function RequestDetails({
  run,
  subscriptionLabel,
}: Readonly<{
  run: RunView
  /** The connection's display name. Server-supplied; never an unmasked id. */
  subscriptionLabel: string
}>) {
  // Direct calls rather than a `t()` helper: `messageText` is typed on the id union, so
  // a helper taking `string` both loses that check and hides the ids from the guard that
  // looks for them.
  const rows: readonly (readonly [string, string])[] = [
    [
      messageText("ui.request_details.connection", "en") ?? "",
      subscriptionLabel,
    ],
    [
      messageText("ui.request_details.profile", "en") ?? "",
      run.templateName === null
        ? (messageText("ui.request_details.not_pinned", "en") ?? "")
        : run.templateVersion === null
          ? run.templateName
          : `${run.templateName} · ${messageText("ui.request_details.version", "en")} ${run.templateVersion}`,
    ],
    [messageText("ui.request_details.period", "en") ?? "", periodLine(run)],
    [messageText("ui.request_details.timezone", "en") ?? "", run.timezone],
    // Both are produced for every delivered run, and the download card below offers
    // whichever the verification allowed.
    [
      messageText("ui.request_details.output", "en") ?? "",
      messageText("ui.request_details.output_value", "en") ?? "",
    ],
  ]

  return (
    <Card data-slot="request-details">
      <CardContent className="flex flex-col gap-0 p-5">
        <h2 className="mb-1 font-heading text-sm font-medium tracking-tight">
          {messageText("ui.request_details.heading", "en")}
        </h2>

        <dl className="flex flex-col">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0"
            >
              <dt className="shrink-0 text-sm text-muted-foreground">
                {label}
              </dt>
              <dd className="text-right text-sm font-medium break-words">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}
