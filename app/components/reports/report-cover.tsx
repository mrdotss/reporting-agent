import { messageText } from "@/lib/messages/catalog"
import { cn } from "@/lib/utils"

/**
 * A small picture of a report's cover: the preset's name, who it is for, and a line of
 * context above. Used on the request page's summary, before the run exists, and on a
 * delivered report's hero.
 *
 * Decorative, and hidden from a screen reader: every fact it shows is printed as text
 * beside it (the summary's rows, the report's heading), so reading it out would say the
 * same thing twice. The bars are a fixed pattern, not data, for the same reason the
 * preset sketch's are.
 *
 * The ground is the sign-in panel's navy, which stays navy in both themes, so the cover
 * reads as the document's own colour rather than as a piece of the app's surface.
 */

const BARS = [40, 75, 55, 95, 30, 65, 85] as const

export function ReportCover({
  title,
  customer,
  kicker,
  shape = "landscape",
  className,
}: Readonly<{
  /** The preset's name, the cover's title. */
  title: string
  /** The customer the report is prepared for, or `null` when there is none. */
  customer: string | null
  /** One short line above the title: the source and connection, or the month. */
  kicker: string
  /** `landscape` for a summary card; `portrait` for a page standing on its own. */
  shape?: "landscape" | "portrait"
  className?: string
}>) {
  const preparedFor =
    customer === null ? null : messageText("ui.report_cover.prepared_for", "en", { customer })

  const bars = (
    <span className="flex h-5 items-end gap-[3px]">
      {BARS.map((height, index) => (
        <span
          key={index}
          className="flex-1 rounded-[1px] bg-(--auth-panel-accent)"
          style={{ height: `${height}%` }}
        />
      ))}
    </span>
  )

  if (shape === "portrait") {
    return (
      <div
        data-slot="report-cover"
        data-shape="portrait"
        aria-hidden="true"
        className={cn(
          "flex aspect-[1/1.414] flex-col overflow-hidden rounded-md bg-(--auth-panel-foreground) shadow-[0_24px_48px_-20px_rgb(0_0_0/0.55)]",
          className
        )}
      >
        <div className="flex h-[48%] flex-col justify-end gap-1 bg-(--auth-panel) p-4 text-(--auth-panel-foreground)">
          <span className="truncate font-mono text-[9px] tracking-[0.1em] text-(--auth-panel-muted) uppercase">
            {kicker}
          </span>
          <span className="line-clamp-2 text-lg leading-tight font-semibold">{title}</span>
          {preparedFor === null ? null : (
            <span className="truncate text-[10px] text-(--auth-panel-muted)">{preparedFor}</span>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-4">
          <span className="h-[3px] w-full rounded-full bg-(--auth-panel-muted)/50" />
          <span className="h-[3px] w-4/5 rounded-full bg-(--auth-panel-muted)/50" />
          <span className="h-[3px] w-[90%] rounded-full bg-(--auth-panel-muted)/50" />
          <span className="h-[3px] w-3/5 rounded-full bg-(--auth-panel-muted)/50" />
          <span className="mt-auto">{bars}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      data-slot="report-cover"
      data-shape="landscape"
      aria-hidden="true"
      className={cn(
        "flex aspect-[1.414/1] flex-col justify-between rounded-lg bg-(--auth-panel) p-4 text-(--auth-panel-foreground)",
        className
      )}
    >
      <span className="truncate font-mono text-[10px] tracking-[0.1em] text-(--auth-panel-muted) uppercase">
        {kicker}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="line-clamp-2 text-xl leading-tight font-semibold">{title}</span>
        {preparedFor === null ? null : (
          <span className="truncate text-xs text-(--auth-panel-muted)">{preparedFor}</span>
        )}
      </span>
      {bars}
    </div>
  )
}
