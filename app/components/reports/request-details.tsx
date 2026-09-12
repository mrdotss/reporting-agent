import { Identifier } from "@/components/identifier"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
 *
 * ## Why the values sit under their labels rather than beside them
 *
 * They used to be a label-left / value-right row. In a 20rem rail that works for
 * `Asia/Jakarta` and breaks for everything else: a connection reading
 * `mrdotss-MSDN — ****…95a4` wrapped onto three ragged right-aligned lines, and the
 * masked id — 28 asterisks — wrapped mid-mask. Stacking gives every value the full
 * column width and one predictable left edge, and it costs a row of height that the rail
 * has to spare.
 *
 * The connection is the one value split in two, because it *is* two facts: a name
 * somebody chose and an id nobody reads left to right. The id gets its own mono line,
 * where a 28-character mask is a texture rather than a wrapping hazard.
 */
export function RequestDetails({
  run,
  subscriptionName,
  subscriptionMaskedId,
}: Readonly<{
  run: RunView
  /** The connection's display name. Server-supplied; never an unmasked id. */
  subscriptionName: string
  /** The masked subscription id, or `null` when the connection is gone. */
  subscriptionMaskedId: string | null
}>) {
  // Direct calls rather than a `t()` helper: `messageText` is typed on the id union, so
  // a helper taking `string` both loses that check and hides the ids from the guard that
  // looks for them.
  const rows: readonly {
    readonly label: string
    readonly value: string
    readonly mono?: string
    /** Rendered through `Identifier` rather than printed. */
    readonly identifier?: string
  }[] = [
    {
      label: messageText("ui.request_details.connection", "en") ?? "",
      value: subscriptionName,
      identifier: subscriptionMaskedId ?? undefined,
    },
    {
      label: messageText("ui.request_details.profile", "en") ?? "",
      value:
        run.templateName === null
          ? (messageText("ui.request_details.not_pinned", "en") ?? "")
          : run.templateName,
      mono:
        run.templateName === null || run.templateVersion === null
          ? undefined
          : `${messageText("ui.request_details.version", "en")} ${run.templateVersion}`,
    },
    {
      label: messageText("ui.request_details.period", "en") ?? "",
      value: periodLine(run),
    },
    {
      label: messageText("ui.request_details.timezone", "en") ?? "",
      value: run.timezone,
    },
    // Both are produced for every delivered run, and the download card offers whichever
    // the verification allowed.
    {
      label: messageText("ui.request_details.output", "en") ?? "",
      value: messageText("ui.request_details.output_value", "en") ?? "",
    },
  ]

  return (
    <Card data-slot="request-details">
      <CardHeader>
        <CardTitle className="font-heading text-sm font-medium tracking-tight">
          {messageText("ui.request_details.heading", "en")}
        </CardTitle>
      </CardHeader>

      <CardContent>
        <dl className="flex flex-col gap-3.5">
          {rows.map(({ label, value, mono, identifier }) => (
            <div key={label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-[11px] tracking-wider text-muted-foreground uppercase">
                {label}
              </dt>

              <dd className="text-sm leading-snug font-medium break-words">
                {value}
              </dd>

              {identifier === undefined ? null : (
                <dd>
                  <Identifier
                    value={identifier}
                    kind="mask"
                    label="Subscription"
                    className="text-muted-foreground"
                  />
                </dd>
              )}

              {mono === undefined ? null : (
                <dd className="font-mono text-xs text-muted-foreground tabular-nums">
                  {mono}
                </dd>
              )}
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}
