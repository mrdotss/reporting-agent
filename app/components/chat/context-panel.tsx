"use client"

import {
  FileTextIcon,
  LightbulbIcon,
  LockSimpleIcon,
  PlugsIcon,
  PlusIcon,
  SealCheckIcon,
  XIcon,
} from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import type { AttachableConnector, AttachableRun } from "@/lib/chat/sources"

/**
 * What the conversation is grounded in, and the three rules that make its answers
 * checkable (ask-chat Req 2, 3).
 */

const COUNT = new Intl.NumberFormat("en-US")

export function ContextPanel({
  runs,
  connectors,
  onAdd,
  onRemove,
}: Readonly<{
  runs: readonly AttachableRun[]
  connectors: readonly AttachableConnector[]
  onAdd: () => void
  onRemove: (kind: "run" | "connector", id: string) => void
}>) {
  const empty = runs.length === 0 && connectors.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-micro uppercase text-muted-foreground">Grounded in</span>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <PlusIcon aria-hidden="true" />
          Add
        </Button>
      </div>

      {empty ? (
        <p className="text-meta text-muted-foreground">
          Nothing attached. Attach a verified report or a scanned connector and answers can
          cite its figures.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {runs.map((run) => (
            <li key={run.runId} className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3">
              <div className="flex items-start gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <FileTextIcon aria-hidden="true" className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{run.customerName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {run.periodLabel}
                    {run.presetName ? ` · ${run.presetName}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onRemove("run", run.runId)}
                  aria-label={`Detach ${run.customerName} ${run.periodLabel}`}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
              <dl className="grid grid-cols-3 gap-1.5">
                <Fact label="figures" value={COUNT.format(run.figureCount)} />
                <Fact label="resources" value={run.resourceCount === null ? "—" : COUNT.format(run.resourceCount)} />
                <Fact label="gaps" value={run.gapCount === null ? "—" : COUNT.format(run.gapCount)} />
              </dl>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1 text-(--status-verified)">
                  <SealCheckIcon aria-hidden="true" className="size-3.5" />
                  Verified
                </span>
                <span className="font-mono text-muted-foreground">{run.digest}</span>
              </div>
            </li>
          ))}
          {connectors.map((connector) => (
            <li key={connector.id} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
              <div className="flex items-start gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <PlugsIcon aria-hidden="true" className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-semibold">{connector.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {connector.customerName ?? "No customer"} · live inventory
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onRemove("connector", connector.id)}
                  aria-label={`Detach ${connector.label}`}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {connector.scan === null
                  ? "Not scanned yet — scan it on Connectors to use it here."
                  : `Scanned ${connector.scan.collectedAt.slice(0, 10)} · ${
                      connector.scan.resourceCount === null
                        ? "resources uncounted"
                        : `${COUNT.format(connector.scan.resourceCount)} resources`
                    }`}
              </p>
            </li>
          ))}
        </ul>
      )}

      <ul aria-label="How answers are grounded" className="flex flex-col gap-2 rounded-xl bg-muted p-3">
        <Rule icon={<SealCheckIcon className="size-3.5" />}>
          A <span className="font-medium text-(--status-verified)">green figure</span> is read from an
          attached artifact. Hover it to see where.
        </Rule>
        <Rule icon={<LightbulbIcon className="size-3.5" />}>
          An <span className="font-medium text-(--status-attention)">estimate</span> is reasoning or
          arithmetic, including list-price costs. It is not a figure the report proves.
        </Rule>
        <Rule icon={<LockSimpleIcon className="size-3.5" />}>
          Only verified reports can be attached, and answers stay on reports, connectors and
          pricing.
        </Rule>
      </ul>

      <p className="text-xs text-muted-foreground">
        Answers run on Amazon Bedrock AgentCore. Conversations are shared with this workspace.
      </p>
    </div>
  )
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg bg-muted px-2 py-1.5">
      <dd className="font-mono text-sm font-medium tabular-nums">{value}</dd>
      <dt className="text-[0.6875rem] text-muted-foreground">{label}</dt>
    </div>
  )
}

function Rule({ icon, children }: Readonly<{ icon: React.ReactNode; children: React.ReactNode }>) {
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 text-xs leading-relaxed">
      <span aria-hidden="true" className="mt-0.5 text-muted-foreground">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  )
}
