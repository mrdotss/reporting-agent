"use client"

import { Fragment } from "react"
import { LightbulbIcon } from "@phosphor-icons/react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { parseAnswer, type AnswerSegment, type ChatCitation } from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * An answer's text, with its figures as chips onto their provenance (ask-chat Req 3).
 *
 * Built from {@link parseAnswer}'s segments as React nodes. There is no HTML injection
 * anywhere on this path: text a model wrote renders as text, whatever it contains.
 *
 * - A **figure** is a green chip. Hovering or focusing it shows where the string came
 *   from — the report, period and snapshot path, the scan, or the list price's SKU,
 *   region and source.
 * - An **estimate** is reasoning over figures: an amber dotted underline and a label, so
 *   it is never mistaken for a number a report proves.
 */

export function MessageText({
  text,
  citations,
  streaming = false,
}: Readonly<{
  text: string
  citations: Readonly<Record<string, ChatCitation>>
  streaming?: boolean
}>) {
  const paragraphs = text.split(/\n{2,}/)
  return (
    <div data-slot="message-text" className="flex flex-col gap-2.5 text-[0.9375rem] leading-relaxed">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="max-w-[68ch] whitespace-pre-wrap">
          <Segments segments={parseAnswer(paragraph)} citations={citations} />
          {streaming && index === paragraphs.length - 1 ? (
            <span
              aria-hidden="true"
              className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] bg-primary motion-reduce:animate-none"
            />
          ) : null}
        </p>
      ))}
    </div>
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
        if (segment.kind === "text") return <Fragment key={index}>{segment.text}</Fragment>
        if (segment.kind === "figure") {
          return (
            <FigureChip key={index} text={segment.text} citation={citations[segment.factId]} />
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
}: Readonly<{ text: string; citation: ChatCitation | undefined }>) {
  const chip = (
    <span
      data-slot="figure-chip"
      className={cn(
        "mx-px inline-flex items-baseline rounded-[5px] bg-(--status-verified-soft) px-1.5 font-mono text-[0.84em] font-medium text-(--status-verified) tabular-nums",
        citation !== undefined && "cursor-help outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      )}
    >
      {text}
    </span>
  )

  if (citation === undefined) return chip

  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} />}>{chip}</TooltipTrigger>
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
