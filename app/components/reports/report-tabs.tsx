"use client"

import { useState } from "react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GapList, gapTypeLabel } from "@/components/reports/gap-list"
import { messageText } from "@/lib/messages/catalog"
import type { RunGap } from "@/lib/runs/gaps"
import { cn } from "@/lib/utils"

/**
 * A finished report's detail, as three tabs instead of a stack of cards.
 *
 * **Overview** is what a reader scans: the busiest machines, and the gaps as one bar by
 * reason. **Proof** is the verification's checks and fingerprints and the snapshot they
 * rest on. **Gaps** is the full grouped list. A reason in the Overview bar opens the Gaps
 * tab with that reason already expanded.
 *
 * The Overview machines and the Proof panel are rendered on the server and passed in;
 * the gaps are passed as data because both the summary and the list are drawn here.
 */

const TAB_TRIGGER =
  "h-10 flex-none rounded-none px-0.5 text-meta data-active:font-semibold group-data-horizontal/tabs:after:bottom-[-1px] after:bg-primary"

/** Gap reasons from most to fewest, each with its share of the bar. */
const TONES = ["bg-primary", "bg-primary/65", "bg-primary/40", "bg-primary/20"] as const

type Reason = { gapType: string; label: string; count: number; tone: string }

function reasonsOf(gaps: readonly RunGap[]): Reason[] {
  const counts = new Map<string, number>()
  for (const gap of gaps) counts.set(gap.gapType, (counts.get(gap.gapType) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([gapType, count], index) => ({
      gapType,
      label: gapTypeLabel(gapType),
      count,
      tone: TONES[index] ?? "bg-muted-foreground/25",
    }))
}

function GapSummary({
  reasons,
  onPick,
}: Readonly<{ reasons: readonly Reason[]; onPick: (gapType: string) => void }>) {
  return (
    <section aria-labelledby="gap-summary-title" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h3 id="gap-summary-title" className="text-sm font-semibold">
          {messageText("ui.gap_list.summary_heading", "en")}
        </h3>
        <p className="text-meta text-muted-foreground">
          {messageText("ui.gap_list.summary_description", "en")}
        </p>
      </div>

      {reasons.length === 0 ? (
        <p className="text-sm text-muted-foreground">{messageText("ui.gap_list.empty", "en")}</p>
      ) : (
        <>
          <div aria-hidden="true" className="flex h-2.5 gap-[3px]">
            {reasons.map((reason) => (
              <span
                key={reason.gapType}
                className={cn("min-w-1.5 rounded-[3px]", reason.tone)}
                style={{ flex: `${reason.count} 1 0px` }}
              />
            ))}
          </div>
          <ul className="-mx-2 flex flex-col">
            {reasons.map((reason) => (
              <li key={reason.gapType}>
                <button
                  type="button"
                  onClick={() => onPick(reason.gapType)}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", reason.tone)} />
                  <span className="min-w-0 flex-1 truncate">{reason.label}</span>
                  <span className="font-mono text-[13px] tabular-nums">{reason.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export function ReportTabs({
  gaps,
  machines,
  proof,
}: Readonly<{
  gaps: readonly RunGap[]
  /** The busiest machines, or `null` when the snapshot has none. */
  machines: React.ReactNode | null
  proof: React.ReactNode
}>) {
  const [tab, setTab] = useState("overview")
  const [openType, setOpenType] = useState<string | null>(null)
  const reasons = reasonsOf(gaps)

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(String(value))}
      data-slot="report-tabs"
      className="min-w-0 gap-0 rounded-xl border border-border bg-card"
    >
      <TabsList
        variant="line"
        className="h-auto w-full justify-start gap-5 overflow-x-auto rounded-none border-b border-border px-4 md:px-5"
      >
        <TabsTrigger value="overview" className={TAB_TRIGGER}>
          {messageText("ui.report_tabs.overview", "en")}
        </TabsTrigger>
        <TabsTrigger value="proof" className={TAB_TRIGGER}>
          {messageText("ui.report_tabs.proof", "en")}
        </TabsTrigger>
        <TabsTrigger value="gaps" className={TAB_TRIGGER}>
          {messageText("ui.report_tabs.gaps", "en")}
          <span className="rounded-[5px] bg-muted px-1.5 font-mono text-xs leading-[18px] font-normal text-muted-foreground tabular-nums">
            {gaps.length}
          </span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        <div
          className={cn(
            "grid gap-8 px-4 py-5 md:px-5",
            machines !== null && "md:grid-cols-2"
          )}
        >
          {machines}
          <GapSummary
            reasons={reasons}
            onPick={(gapType) => {
              setOpenType(gapType)
              setTab("gaps")
            }}
          />
        </div>
      </TabsContent>

      <TabsContent value="proof">
        <div className="px-4 py-5 md:px-5">{proof}</div>
      </TabsContent>

      <TabsContent value="gaps">
        <p className="border-b border-border px-4 py-3 text-meta text-muted-foreground md:px-5">
          {messageText("ui.gap_list.description", "en")}
        </p>
        {gaps.length === 0 ? (
          <div className="px-4 py-4 md:px-5">
            <GapList gaps={gaps} />
          </div>
        ) : (
          <GapList key={openType ?? "none"} gaps={gaps} openType={openType} />
        )}
      </TabsContent>
    </Tabs>
  )
}
