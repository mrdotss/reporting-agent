import type { SourceKind } from "@/components/subscriptions/provider-mark"
import { sectionEntry, type SectionGroup } from "@/lib/builder/catalogue"
import { messageText } from "@/lib/messages/catalog"
import { cn } from "@/lib/utils"

/**
 * A preset's first pages as a layout sketch, drawn from its section outline.
 *
 * Not a render, and it says so. A real first-page thumbnail needs the runtime to keep a
 * page image with each report, which it does not do yet; until it does, the card draws
 * the shape of what the preset holds (tiles for a summary, rows for an inventory, bars
 * for utilisation, lines for the closing sections) and labels it "Layout sketch", so
 * nobody reads it as their customer's numbers. The bar heights are a fixed pattern,
 * not data.
 */

const FIRST_PAGE = 3
const SECOND_PAGE = 2
const BARS = [60, 85, 45, 70, 35] as const

function groupOf(provider: SourceKind, type: string): SectionGroup {
  if (provider === "onprem") return "inventory"
  return sectionEntry(provider, type)?.group ?? "inventory"
}

function Block({ group }: Readonly<{ group: SectionGroup }>) {
  if (group === "summary") {
    return (
      <span className="grid grid-cols-3 gap-[3px]">
        <span className="h-3.5 rounded-[2px] bg-primary/12" />
        <span className="h-3.5 rounded-[2px] bg-primary/12" />
        <span className="h-3.5 rounded-[2px] bg-primary/12" />
      </span>
    )
  }
  if (group === "utilisation") {
    return (
      <span className="flex h-6 items-end gap-[3px] rounded-[2px] border border-primary/15 bg-primary/5 px-1 pb-[3px]">
        {BARS.map((height, index) => (
          <span key={index} className="flex-1 rounded-t-[1px] bg-primary/35" style={{ height: `${height}%` }} />
        ))}
      </span>
    )
  }
  if (group === "closing") {
    return (
      <span className="flex flex-col gap-[3px]">
        <span className="h-1 w-[90%] rounded-full bg-border" />
        <span className="h-1 w-[70%] rounded-full bg-border" />
      </span>
    )
  }
  return (
    <span className="flex flex-col gap-[2px]">
      <span className="h-1.5 rounded-[1px] bg-primary/15" />
      <span className="h-1.5 rounded-[1px] bg-muted" />
      <span className="h-1.5 rounded-[1px] bg-muted" />
    </span>
  )
}

function Page({ groups, tall }: Readonly<{ groups: readonly SectionGroup[]; tall?: boolean }>) {
  return (
    <span
      className={cn(
        "flex w-24 flex-col gap-[5px] overflow-hidden rounded-t-[3px] bg-card p-2.5 shadow-[0_2px_8px_rgb(20_30_40/0.1)]",
        tall ? "h-28" : "h-[100px]"
      )}
    >
      <span className="h-[5px] w-3/5 rounded-[2px] bg-primary" />
      {groups.map((group, index) => (
        <Block key={index} group={group} />
      ))}
    </span>
  )
}

export function PresetSketch({
  name,
  provider,
  types,
}: Readonly<{ name: string; provider: SourceKind; types: readonly string[] }>) {
  if (types.length === 0) {
    return (
      <div className="flex h-40 items-end justify-center bg-muted px-5">
        <span className="grid h-28 w-28 place-items-center rounded-t-[3px] border border-b-0 border-dashed border-muted-foreground/40 bg-card p-2 text-center text-[11px] text-muted-foreground">
          {messageText("ui.presets.no_sections", "en")}
        </span>
      </div>
    )
  }

  const groups = types.map((type) => groupOf(provider, type))
  const first = groups.slice(0, FIRST_PAGE)
  const second = groups.slice(FIRST_PAGE, FIRST_PAGE + SECOND_PAGE)

  return (
    <div
      role="img"
      aria-label={messageText("ui.presets.sketch_label", "en", { name })}
      className="relative flex h-40 items-end justify-center gap-2 bg-muted px-5"
    >
      <Page groups={first} tall />
      {second.length > 0 ? <Page groups={second} /> : null}
      <span aria-hidden="true" className="absolute right-2 bottom-2 rounded-md bg-card/90 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border">
        {messageText("ui.presets.sketch", "en")}
      </span>
    </div>
  )
}
