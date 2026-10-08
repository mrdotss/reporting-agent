"use client"

import { useId, useState } from "react"
import {
  ArrowsOutSimpleIcon,
  DownloadSimpleIcon,
  LightningIcon,
  SealCheckIcon,
} from "@phosphor-icons/react"
import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { chartCsv, csvName } from "@/lib/chat/chart-data"
import type { ChatChart, ChatChartSource } from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * The frame every answer chart sits in: its title and what it is drawn from, a badge saying
 * whether its figures are verified, and the same three controls on every chart — the chart
 * or its figures as a table, the figures as a CSV, and the chart at full size.
 */

const SOURCE_BADGE: Readonly<
  Record<
    ChatChartSource,
    { readonly label: string; readonly verified: boolean }
  >
> = {
  verified: { label: "Verified figures", verified: true },
  live: { label: "Live · not verified", verified: false },
  mixed: { label: "Verified and live", verified: false },
}

export function SourceBadge({ source }: Readonly<{ source: ChatChartSource }>) {
  const badge = SOURCE_BADGE[source]
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium",
        badge.verified
          ? "bg-(--status-verified-soft) text-(--status-verified)"
          : "border border-dashed border-input text-muted-foreground"
      )}
    >
      {badge.verified ? (
        <SealCheckIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <LightningIcon aria-hidden="true" className="size-3.5" />
      )}
      {badge.label}
    </span>
  )
}

/** A small segmented choice: the same radio group the model picker uses. */
export function ChartToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string
  value: T
  options: readonly { readonly value: T; readonly label: string }[]
  onChange: (value: T) => void
}>) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as T)}
      aria-label={label}
      className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className="inline-flex h-6 cursor-pointer items-center rounded-md px-2 text-xs whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 data-checked:bg-card data-checked:font-medium data-checked:text-foreground data-checked:ring-1 data-checked:ring-border"
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}

export type ChartView = "chart" | "table"

export function ChartFrame({
  chart,
  meta,
  controls,
  table,
  expanded = false,
  renderExpanded,
  children,
}: Readonly<{
  chart: ChatChart
  /** One line under the title: what the chart holds. */
  meta: string
  /** The chart's own choices — range, sort — beside the shared ones. */
  controls?: React.ReactNode
  /** The figures as a table. A chart with none offers no table view. */
  table?: React.ReactNode
  /** Drawn inside the full-size dialog: no second dialog from there. */
  expanded?: boolean
  renderExpanded?: () => React.ReactNode
  children: React.ReactNode
}>) {
  const headingId = useId()
  const [view, setView] = useState<ChartView>("chart")
  const [open, setOpen] = useState(false)
  const csv = chartCsv(chart)

  function download() {
    if (csv === null) return
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" })
    )
    const link = document.createElement("a")
    link.href = url
    link.download = csvName(chart.title)
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <figure
      data-slot="answer-chart"
      data-kind={chart.kind}
      data-source={chart.source}
      aria-labelledby={headingId}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden",
        !expanded && "rounded-xl border border-border bg-card"
      )}
    >
      <figcaption
        className={cn(
          "flex flex-col gap-2",
          expanded ? "pr-10 pb-3" : "px-3.5 pt-3 pb-2"
        )}
      >
        {/* The title has the full width to itself; the controls sit on the line below. */}
        <span className="flex items-start gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              id={headingId}
              className="text-sm font-semibold text-balance break-words"
            >
              {chart.title}
            </span>
            <span className="text-xs text-muted-foreground">{meta}</span>
          </span>
          <span className="-mt-1 -mr-1.5 flex shrink-0 items-center">
            {csv !== null ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={download}
                aria-label="Download the figures as CSV"
                title="Download CSV"
              >
                <DownloadSimpleIcon aria-hidden="true" />
              </Button>
            ) : null}
            {!expanded && renderExpanded ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setOpen(true)}
                aria-label="Open the chart full size"
                title="Full size"
              >
                <ArrowsOutSimpleIcon aria-hidden="true" />
              </Button>
            ) : null}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <SourceBadge source={chart.source} />
          {controls || table ? (
            <span className="ml-auto flex flex-wrap items-center gap-2">
              {controls}
              {table ? (
                <ChartToggle
                  label="Show as"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "chart", label: "Chart" },
                    { value: "table", label: "Table" },
                  ]}
                />
              ) : null}
            </span>
          ) : null}
        </span>
      </figcaption>

      <div className={cn(expanded ? "" : "px-3.5 pb-3.5")}>
        {view === "table" && table ? table : children}
      </div>

      {!expanded && renderExpanded ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-5xl">
            <DialogHeader className="sr-only">
              <DialogTitle>{chart.title}</DialogTitle>
              <DialogDescription>{meta}</DialogDescription>
            </DialogHeader>
            {open ? renderExpanded() : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </figure>
  )
}

/** A plain figures table, for the Table view. */
export function FiguresTable({
  head,
  rows,
}: Readonly<{
  head: readonly string[]
  rows: readonly (readonly string[])[]
}>) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-meta tabular-nums">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th
                key={`${cell}-${index}`}
                scope="col"
                className={cn(
                  "sticky top-0 bg-muted px-2.5 py-1.5 font-medium whitespace-nowrap text-muted-foreground",
                  index === 0 ? "text-left" : "text-right font-mono"
                )}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-border/60">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    "px-2.5 py-1 font-mono text-xs",
                    index === 0
                      ? "text-left text-muted-foreground"
                      : "text-right"
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
