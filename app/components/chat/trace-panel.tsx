"use client"

import Link from "next/link"
import {
  ArrowUpRightIcon,
  LightningIcon,
  SealCheckIcon,
  XIcon,
} from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import type { FigureTally } from "@/lib/chat/figures"
import { traceFor, type TraceRun, type TraceStep } from "@/lib/chat/trace"
import { cn } from "@/lib/utils"

/**
 * Where one figure came from, laid out as the steps between the number on the screen and the
 * data behind it.
 *
 * This is the product's claim made visible: Ask quotes figures a verifier already checked,
 * and each one can be followed back. A figure that is live and unverified is drawn the same
 * way as in the answer — dashed, no seal — and one with no recorded source says so rather
 * than borrowing the look of a verified one.
 */

export type TracedFigure = {
  readonly number: number
  readonly text: string
  readonly citation: Parameters<typeof traceFor>[0]
}

export function TracePanel({
  figure,
  runs,
  totals,
  onClose,
}: Readonly<{
  figure: TracedFigure | null
  runs: readonly TraceRun[]
  totals: FigureTally
  onClose?: () => void
}>) {
  return (
    <div
      data-slot="trace-panel"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4"
    >
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-micro text-muted-foreground uppercase">
          {figure === null ? "Figure trace" : `Figure ${figure.number} · trace`}
        </h2>
        {figure !== null && onClose ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close figure trace"
          >
            <XIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {figure === null ? (
        <NothingSelected totals={totals} />
      ) : (
        <Selected figure={figure} runs={runs} />
      )}
    </div>
  )
}

function Selected({
  figure,
  runs,
}: Readonly<{ figure: TracedFigure; runs: readonly TraceRun[] }>) {
  const trace = traceFor(figure.citation, runs)
  const live = trace.kind === "live"

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <p
          className={cn(
            "font-mono text-3xl leading-none font-medium tracking-tight tabular-nums",
            live || trace.kind === "unsourced"
              ? "text-foreground"
              : "text-(--status-verified)"
          )}
        >
          {figure.text}
        </p>
        {figure.citation ? (
          <p className="text-sm font-medium">{figure.citation.label}</p>
        ) : null}
        <span
          className={cn(
            "mt-0.5 inline-flex h-6 w-fit items-center gap-1.5 rounded-md px-2 text-xs font-medium",
            trace.kind === "verified" &&
              "bg-(--status-verified-soft) text-(--status-verified)",
            live && "border border-dashed border-input text-muted-foreground",
            trace.kind === "unsourced" &&
              "bg-(--status-attention-soft) text-(--status-attention)"
          )}
        >
          {trace.kind === "verified" ? (
            <SealCheckIcon
              aria-hidden="true"
              weight="bold"
              className="size-3.5"
            />
          ) : null}
          {live ? (
            <LightningIcon aria-hidden="true" className="size-3.5" />
          ) : null}
          {trace.badge}
        </span>
      </div>

      {trace.steps.length > 0 ? (
        <Steps steps={trace.steps} dashed={live} />
      ) : null}

      <p className="text-meta leading-relaxed text-muted-foreground">
        {trace.note}
      </p>

      {trace.href ? (
        <Link
          href={trace.href}
          className="mt-auto flex h-9 items-center justify-center gap-1.5 rounded-lg border border-input text-sm font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {trace.hrefLabel}
          <ArrowUpRightIcon aria-hidden="true" className="size-4" />
        </Link>
      ) : null}
    </>
  )
}

/** A vertical rule with a node per step; the last node is filled, the rule stops there. */
function Steps({
  steps,
  dashed,
}: Readonly<{ steps: readonly TraceStep[]; dashed: boolean }>) {
  return (
    <ol aria-label="Where it came from" className="flex flex-col">
      {steps.map((step, index) => {
        const last = index === steps.length - 1
        return (
          <li
            key={step.title}
            className="grid grid-cols-[0.875rem_minmax(0,1fr)] gap-3"
          >
            <span aria-hidden="true" className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1.5 size-2.5 shrink-0 rounded-full border-[1.5px] bg-card",
                  dashed
                    ? "border-muted-foreground"
                    : "border-(--status-verified)",
                  last && !dashed && "bg-(--status-verified)"
                )}
              />
              {last ? null : <span className="my-1 w-px flex-1 bg-border" />}
            </span>
            <span
              className={cn(
                "flex min-w-0 flex-col gap-px",
                last ? "pb-0" : "pb-3.5"
              )}
            >
              <span className="text-sm font-semibold">{step.title}</span>
              <span className="text-meta text-muted-foreground">
                {step.detail}
              </span>
              {step.mono ? (
                <span className="font-mono text-xs break-words text-muted-foreground">
                  {step.mono}
                </span>
              ) : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function NothingSelected({ totals }: Readonly<{ totals: FigureTally }>) {
  return (
    <>
      <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-input p-4">
        <span
          aria-hidden="true"
          className="w-fit rounded-[4px] bg-(--status-verified-soft) px-1.5 font-mono text-sm font-medium text-(--status-verified)"
        >
          8.9%
          <sup className="ml-0.5 font-sans text-[0.62em] font-semibold opacity-70">
            1
          </sup>
        </span>
        <p className="text-meta leading-relaxed text-muted-foreground">
          Select a numbered figure in an answer to see where it came from: the
          report, the line in its ledger, and the snapshot it was compiled from.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-micro text-muted-foreground uppercase">
          In this conversation
        </h3>
        <dl className="flex flex-col gap-1.5 text-meta">
          <Row label="Figures traced" value={totals.traced} />
          <Row label="Live, not verified" value={totals.live} />
          <Row label="Estimates" value={totals.estimates} />
          {totals.unsourced > 0 ? (
            <Row label="Without a source" value={totals.unsourced} />
          ) : null}
        </dl>
      </div>
    </>
  )
}

function Row({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  )
}
