"use client"

import {
  LightningIcon,
  PlugsIcon,
  PlusIcon,
  SealCheckIcon,
  XIcon,
} from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import type {
  AttachableConnector,
  AttachableLive,
  AttachableRun,
} from "@/lib/chat/sources"
import { cn } from "@/lib/utils"

export type AttachmentKind = "run" | "connector" | "live"

/**
 * What the open conversation rests on, one chip per source, directly under its title.
 *
 * It used to be a panel at the bottom of a side column. It is the first thing a reader
 * should know about an answer — which report, and whether it is verified — so it leads, and
 * the chip's edge says the verified/unverified difference before any word does: a report is
 * ruled solid with the seal, a live pull is dashed.
 */
export function SourceDocket({
  runs,
  connectors,
  live,
  unavailable = 0,
  onAdd,
  onRemove,
}: Readonly<{
  runs: readonly AttachableRun[]
  connectors: readonly AttachableConnector[]
  live: readonly AttachableLive[]
  /** Sources the conversation names that can no longer be read. */
  unavailable?: number
  onAdd?: () => void
  onRemove?: (kind: AttachmentKind, id: string) => void
}>) {
  const empty =
    runs.length === 0 && connectors.length === 0 && live.length === 0

  return (
    <div
      data-slot="source-docket"
      className="flex flex-wrap items-center gap-2"
    >
      <span className="mr-0.5 text-micro text-muted-foreground uppercase">
        Grounded in
      </span>

      {empty ? (
        <span className="text-meta text-muted-foreground">
          Nothing attached
        </span>
      ) : null}

      {runs.map((run) => (
        <Chip
          key={run.runId}
          icon={
            <SealCheckIcon
              aria-hidden="true"
              className="size-4 text-(--status-verified)"
            />
          }
          lead={
            <span className="truncate font-semibold">{run.customerName}</span>
          }
          detail={run.periodLabel}
          mono={`${run.figureCount.toLocaleString("en-US")} figures`}
          label={`${run.customerName} ${run.periodLabel}`}
          onRemove={onRemove ? () => onRemove("run", run.runId) : undefined}
        />
      ))}

      {live.map((pull) => (
        <Chip
          key={pull.id}
          dashed
          icon={
            <LightningIcon
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
            />
          }
          lead={
            <>
              <span className="shrink-0 font-semibold">Live pull</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {pull.resourceNames.join(", ")}
              </span>
            </>
          }
          detail={`${pull.windowLabel} · not verified`}
          label={`live metrics for ${pull.resourceNames.join(", ")}`}
          onRemove={onRemove ? () => onRemove("live", pull.id) : undefined}
        />
      ))}

      {connectors.map((connector) => (
        <Chip
          key={connector.id}
          icon={
            <PlugsIcon
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
            />
          }
          lead={
            <span className="truncate font-mono text-xs font-medium">
              {connector.label}
            </span>
          }
          detail={connector.scan === null ? "not scanned yet" : "inventory"}
          label={connector.label}
          onRemove={
            onRemove ? () => onRemove("connector", connector.id) : undefined
          }
        />
      ))}

      {unavailable > 0 ? (
        <span className="text-meta text-(--status-attention)">
          {unavailable} no longer available
        </span>
      ) : null}

      {onAdd ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onAdd}
          className="text-primary hover:text-primary"
        >
          <PlusIcon aria-hidden="true" />
          Add source
        </Button>
      ) : null}
    </div>
  )
}

function Chip({
  icon,
  lead,
  detail,
  mono,
  label,
  dashed = false,
  onRemove,
}: Readonly<{
  icon: React.ReactNode
  lead: React.ReactNode
  detail: string
  mono?: string
  label: string
  dashed?: boolean
  onRemove?: () => void
}>) {
  return (
    <span
      className={cn(
        "inline-flex h-8 max-w-full items-center gap-2 rounded-lg border bg-card pl-2.5 text-sm",
        dashed ? "border-dashed border-input" : "border-border",
        onRemove ? "pr-1" : "pr-2.5"
      )}
    >
      {icon}
      {lead}
      <span className="hidden shrink-0 text-meta text-muted-foreground sm:inline">
        {detail}
      </span>
      {mono ? (
        <span className="hidden shrink-0 font-mono text-xs text-muted-foreground md:inline">
          {mono}
        </span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Detach ${label}`}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <XIcon aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </span>
  )
}
