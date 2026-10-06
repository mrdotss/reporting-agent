"use client"

import { Fragment, useMemo } from "react"
import { LightbulbIcon } from "@phosphor-icons/react"

import { AnswerChart, AnswerChartPending } from "@/components/chat/answer-chart"
import { useFigureTrace } from "@/components/chat/figure-trace"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { parseInline, parseMarkdown, type MarkdownAlign } from "@/lib/chat/markdown"
import {
  parseAnswer,
  type AnswerSegment,
  type ChatChart,
  type ChatCitation,
} from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * An answer's text, with its figures as chips onto their provenance and its charts between
 * paragraphs (ask-chat Req 3, 8, 9).
 *
 * Built from {@link parseAnswer}'s segments as React nodes. There is no HTML injection
 * anywhere on this path: text a model wrote renders as text, whatever it contains.
 *
 * - A **figure** is a chip. Green when it was read from a verified report, a saved scan or
 *   a list price; **grey with "Live"** when it came from a live metrics pull, which was
 *   collected on request and never verified. Hovering or focusing it shows where it came
 *   from.
 * - An **estimate** is reasoning over figures: an amber dotted underline and a label, so
 *   it is never mistaken for a number a report proves.
 * - A **chart** marker (`⟦chart:c1⟧`, always its own paragraph) renders the chart the
 *   runtime built; while the answer is still streaming its data has not arrived, so a
 *   placeholder holds its place.
 *
 * The answer's Markdown — headings, tables, lists, emphasis, code — is parsed into blocks
 * first (`lib/chat/markdown.ts`), because models write it and it used to reach the page as
 * literal pipes and asterisks. Figures keep working inside a table cell or a bold run.
 */

export function MessageText({
  text,
  citations,
  charts = [],
  streaming = false,
}: Readonly<{
  text: string
  citations: Readonly<Record<string, ChatCitation>>
  charts?: readonly ChatChart[]
  streaming?: boolean
}>) {
  const blocks = useMemo(() => parseMarkdown(text), [text])

  return (
    <div data-slot="message-text" className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed">
      {blocks.map((block, index) => {
        const caret =
          streaming && index === blocks.length - 1 ? <Caret key="caret" /> : null

        switch (block.kind) {
          case "chart": {
            const chart = charts.find((candidate) => candidate.id === block.id)
            if (chart !== undefined) return <AnswerChart key={index} chart={chart} />
            return streaming ? <AnswerChartPending key={index} /> : null
          }
          case "heading": {
            const size =
              block.level <= 2 ? "text-base" : block.level === 3 ? "text-[0.9375rem]" : "text-sm"
            return (
              <p key={index} className={cn("font-semibold text-foreground", size)}>
                <Inline text={block.text} citations={citations} />
                {caret}
              </p>
            )
          }
          case "list":
            return (
              <ol
                key={index}
                className={cn(
                  "flex list-outside flex-col gap-1 pl-5",
                  block.ordered ? "list-decimal" : "list-disc"
                )}
              >
                {block.items.map((item, position) => (
                  <li key={position} className="marker:text-muted-foreground">
                    <Inline text={item} citations={citations} />
                    {position === block.items.length - 1 ? caret : null}
                  </li>
                ))}
              </ol>
            )
          case "table":
            return (
              <div key={index} className="-mx-1 overflow-x-auto px-1">
                <table className="w-full min-w-fit border-collapse text-meta">
                  <thead>
                    <tr className="border-b border-border">
                      {block.header.map((cell, column) => (
                        <th
                          key={column}
                          scope="col"
                          className={cn(
                            "px-2.5 py-1.5 font-medium whitespace-nowrap text-muted-foreground",
                            alignmentClass(block.align[column])
                          )}
                        >
                          <Inline text={cell} citations={citations} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, position) => (
                      <tr key={position} className="border-b border-border/60 last:border-0">
                        {row.map((cell, column) => (
                          <td
                            key={column}
                            className={cn(
                              "px-2.5 py-1.5 align-top tabular-nums",
                              alignmentClass(block.align[column])
                            )}
                          >
                            <Inline text={cell} citations={citations} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case "quote":
            return (
              <p
                key={index}
                className="border-l-2 border-border pl-3 whitespace-pre-wrap text-muted-foreground"
              >
                <Inline text={block.text} citations={citations} />
                {caret}
              </p>
            )
          case "code":
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-meta"
              >
                {block.text}
              </pre>
            )
          case "rule":
            return <hr key={index} className="border-border" />
          default:
            return (
              <p key={index} className="max-w-[78ch] whitespace-pre-wrap">
                <Inline text={block.text} citations={citations} />
                {caret}
              </p>
            )
        }
      })}
    </div>
  )
}

function alignmentClass(align: MarkdownAlign | undefined): string {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
}

function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] bg-primary motion-reduce:animate-none"
    />
  )
}

/** One run of an answer: its figure chips and estimates, with Markdown emphasis inside. */
function Inline({
  text,
  citations,
}: Readonly<{ text: string; citations: Readonly<Record<string, ChatCitation>> }>) {
  return <Segments segments={parseAnswer(text)} citations={citations} />
}

function Emphasis({ text }: Readonly<{ text: string }>) {
  return (
    <>
      {parseInline(text).map((span, index) => {
        if (span.kind === "strong") {
          return (
            <strong key={index} className="font-semibold">
              {span.text}
            </strong>
          )
        }
        if (span.kind === "emphasis") return <em key={index}>{span.text}</em>
        if (span.kind === "code") {
          return (
            <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
              {span.text}
            </code>
          )
        }
        return <Fragment key={index}>{span.text}</Fragment>
      })}
    </>
  )
}

function Segments({
  segments,
  citations,
}: Readonly<{
  segments: readonly AnswerSegment[]
  citations: Readonly<Record<string, ChatCitation>>
}>) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <Emphasis key={index} text={segment.text} />
        if (segment.kind === "figure") {
          return (
            <FigureChip
              key={index}
              text={segment.text}
              citation={citations[segment.factId]}
              factId={segment.factId}
            />
          )
        }
        return (
          <span
            key={index}
            data-slot="estimate"
            className="rounded-sm decoration-(--status-attention) decoration-dotted decoration-[1.5px] underline-offset-4 [text-decoration-line:underline]"
          >
            <span className="mr-1 inline-flex translate-y-px items-center gap-0.5 rounded bg-(--status-attention-soft) px-1 align-baseline text-micro text-(--status-attention) normal-case tracking-normal">
              <LightbulbIcon aria-hidden="true" className="size-3" />
              Estimate
            </span>
            <Segments segments={segment.children} citations={citations} />
          </span>
        )
      })}
    </>
  )
}

export function FigureChip({
  text,
  citation,
  factId,
}: Readonly<{ text: string; citation: ChatCitation | undefined; factId?: string }>) {
  const trace = useFigureTrace()
  const live = citation?.source === "live"
  const number = factId === undefined ? undefined : trace?.numbers.get(factId)
  const selected = trace !== null && factId !== undefined && trace.selectedId === factId

  const className = cn(
    "mx-px inline-flex items-baseline gap-1 rounded-[5px] px-1.5 font-mono text-[0.84em] font-medium tabular-nums",
    live
      ? "border border-dashed border-input bg-muted text-foreground"
      : "bg-(--status-verified-soft) text-(--status-verified)",
    citation !== undefined && "cursor-help outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
    selected && "ring-2 ring-primary ring-offset-1 ring-offset-background"
  )
  const content = (
    <>
      {live ? (
        <span className="font-sans text-[0.72em] font-semibold tracking-wide text-muted-foreground uppercase">
          Live
        </span>
      ) : null}
      {text}
      {number === undefined ? null : (
        <sup aria-hidden="true" className="-ml-0.5 font-sans text-[0.62em] font-semibold opacity-70">
          {number}
        </sup>
      )}
    </>
  )

  // Without a source there is nothing to trace, and without a provider nowhere to show it:
  // the chip is then just a chip.
  if (citation === undefined) {
    return (
      <span data-slot="figure-chip" className={className}>
        {content}
      </span>
    )
  }

  if (trace !== null && factId !== undefined && number !== undefined) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-slot="figure-chip"
              data-source={citation.source}
              data-selected={selected ? "" : undefined}
              aria-pressed={selected}
              aria-label={`${text}, figure ${number}${live ? ", live, not verified" : ""}. Show where it came from.`}
              onClick={() => trace.onSelect(factId)}
              className={cn(className, "cursor-pointer")}
            />
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipContent className="max-w-80">
          <CitationDetail citation={citation} />
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} />}>
        <span data-slot="figure-chip" data-source={citation.source} className={className}>
          {content}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <CitationDetail citation={citation} />
      </TooltipContent>
    </Tooltip>
  )
}

export function CitationDetail({ citation }: Readonly<{ citation: ChatCitation }>) {
  const lines: string[] = []
  if (citation.source === "report") {
    lines.push([citation.customer_name, citation.period_display].filter(Boolean).join(" · "))
    if (citation.snapshot_path) lines.push(`snapshot › ${citation.snapshot_path}`)
  } else if (citation.source === "live") {
    lines.push("Live metrics · not verified")
    lines.push([citation.connector_label, citation.period_display].filter(Boolean).join(" · "))
    if (citation.collected_at) lines.push(`collected ${citation.collected_at.slice(0, 16).replace("T", " ")} UTC`)
  } else if (citation.source === "scan") {
    lines.push(`Saved scan${citation.collected_at ? ` · ${citation.collected_at.slice(0, 10)}` : ""}`)
  } else if (citation.source === "price") {
    lines.push(
      [citation.price_source ?? "Azure Retail Prices", citation.currency, "list price, pay-as-you-go"]
        .filter(Boolean)
        .join(" · ")
    )
    if (citation.effective_start) lines.push(`effective ${citation.effective_start.slice(0, 10)}`)
  }

  return (
    <span className="flex flex-col gap-0.5 text-left">
      <span className="font-medium">{citation.label}</span>
      {lines.filter(Boolean).map((line) => (
        <span key={line} className="font-mono text-[0.72rem] opacity-80">
          {line}
        </span>
      ))}
    </span>
  )
}
