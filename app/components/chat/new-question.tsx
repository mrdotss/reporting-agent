"use client"

import { useState } from "react"
import { LightningIcon, PlugsIcon, SealCheckIcon } from "@phosphor-icons/react"
import Link from "next/link"

import {
  MAX_CONNECTORS,
  MAX_LIVE,
  MAX_RUNS,
} from "@/components/chat/attach-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ChatSources } from "@/lib/chat/sources"
import type { ChatAttachments } from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * What a new question is asked of. It used to be an empty page with one button that opened
 * a dialog; the choice is the whole first step of using Ask, so it is the page.
 *
 * The three kinds of source are tabs, as in the attach dialog, and tick the same draft
 * attachments. The dialog stays for what does not fit here: searching a long list, and
 * collecting new live metrics.
 */

const SHOWN_AT_FIRST = 5
const DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "short",
})

export function NewQuestion({
  canChat,
  sources,
  attachments,
  onChange,
  onOpenDialog,
  suggestions,
  onAsk,
}: Readonly<{
  canChat: boolean
  sources: ChatSources
  attachments: ChatAttachments
  onChange: (next: ChatAttachments) => void
  onOpenDialog: (tab: "reports" | "connectors" | "live") => void
  suggestions: readonly string[]
  onAsk: (question: string) => void
}>) {
  const [showAll, setShowAll] = useState(false)
  const liveIds = attachments.liveIds ?? []
  const chosen =
    attachments.runIds.length + attachments.connectorIds.length + liveIds.length

  if (!canChat) {
    return (
      <div className="flex flex-col gap-2 pt-8">
        <h2 className="text-title">
          Read this workspace&rsquo;s conversations
        </h2>
        <p className="max-w-[56ch] text-sm leading-relaxed text-muted-foreground">
          Open a conversation to read its answers and the figures they cite.
          Editors, admins and the owner can ask new questions.
        </p>
      </div>
    )
  }

  const toggleRun = (id: string, on: boolean) =>
    onChange({
      ...attachments,
      runIds: on
        ? [...attachments.runIds, id].slice(0, MAX_RUNS)
        : attachments.runIds.filter((x) => x !== id),
    })
  const toggleConnector = (id: string, on: boolean) =>
    onChange({
      ...attachments,
      connectorIds: on
        ? [...attachments.connectorIds, id].slice(0, MAX_CONNECTORS)
        : attachments.connectorIds.filter((x) => x !== id),
    })
  const toggleLive = (id: string, on: boolean) =>
    onChange({
      ...attachments,
      liveIds: on
        ? [...liveIds, id].slice(0, MAX_LIVE)
        : liveIds.filter((x) => x !== id),
    })

  const runs = showAll ? sources.runs : sources.runs.slice(0, SHOWN_AT_FIRST)

  return (
    <div className="flex flex-col gap-7 pt-4 md:pt-8">
      <div className="flex flex-col gap-2">
        <h2 className="text-title text-balance">
          What should the answer rest on?
        </h2>
        <p className="max-w-[60ch] text-[0.9375rem] leading-relaxed text-muted-foreground">
          Ask quotes figures only from what you choose here, and shows where
          each one came from. Anything it works out on top, like a monthly cost,
          is marked as an estimate.
        </p>
      </div>

      <Tabs
        defaultValue="reports"
        className="gap-0 overflow-hidden rounded-xl border border-border"
      >
        <TabsList
          variant="line"
          className="h-auto w-full justify-start gap-5 border-b border-border px-4 py-0"
        >
          <TabsTrigger value="reports" className="h-11 flex-none px-0">
            <SealCheckIcon
              aria-hidden="true"
              className="text-(--status-verified)"
            />
            Verified reports
            <Count n={attachments.runIds.length} />
          </TabsTrigger>
          <TabsTrigger value="live" className="h-11 flex-none px-0">
            <LightningIcon aria-hidden="true" />
            Live metrics
            <Count n={liveIds.length} />
          </TabsTrigger>
          <TabsTrigger value="connectors" className="h-11 flex-none px-0">
            <PlugsIcon aria-hidden="true" />
            Connector inventory
            <Count n={attachments.connectorIds.length} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="reports" className="flex flex-col">
          {sources.runs.length === 0 ? (
            <Empty>
              No verified report in this workspace yet.{" "}
              <Link
                href="/reports"
                className="text-primary underline underline-offset-3"
              >
                Run one
              </Link>
              , or ask about a live pull.
            </Empty>
          ) : (
            <ul className="flex flex-col p-1.5">
              {runs.map((run) => {
                const on = attachments.runIds.includes(run.runId)
                return (
                  <Row
                    key={run.runId}
                    id={`pick-run-${run.runId}`}
                    checked={on}
                    disabled={!on && attachments.runIds.length >= MAX_RUNS}
                    onChange={(value) => toggleRun(run.runId, value)}
                    title={
                      <>
                        <span className="font-semibold">
                          {run.customerName}
                        </span>
                        <span className="text-meta text-muted-foreground">
                          {run.periodLabel}
                        </span>
                        {run.presetName ? (
                          <span className="text-meta text-muted-foreground">
                            {run.presetName}
                          </span>
                        ) : null}
                      </>
                    }
                    facts={[
                      `${run.figureCount.toLocaleString("en-US")} figures`,
                      run.resourceCount === null
                        ? null
                        : `${run.resourceCount.toLocaleString("en-US")} resources`,
                      run.gapCount === null
                        ? null
                        : `${run.gapCount.toLocaleString("en-US")} gaps recorded`,
                    ]}
                    aside={
                      <>
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-(--status-verified)">
                          <SealCheckIcon
                            aria-hidden="true"
                            className="size-3.5"
                          />
                          Verified {DAY.format(new Date(run.verifiedAt))}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {run.digest.slice(0, 12)}
                        </span>
                      </>
                    }
                  />
                )
              })}
            </ul>
          )}
          <Footnote>
            <span>
              Only reports whose latest verification passed are listed.
            </span>
            {sources.runs.length > SHOWN_AT_FIRST ? (
              <Button
                variant="link"
                size="sm"
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll ? "Show fewer" : `Show all ${sources.runs.length}`}
              </Button>
            ) : null}
          </Footnote>
        </TabsContent>

        <TabsContent value="live" className="flex flex-col">
          {sources.live.length === 0 ? (
            <Empty>
              No live pull yet. Collect metrics for a few machines and ask about
              them.
            </Empty>
          ) : (
            <ul className="flex flex-col p-1.5">
              {sources.live.map((pull) => {
                const on = liveIds.includes(pull.id)
                return (
                  <Row
                    key={pull.id}
                    id={`pick-live-${pull.id}`}
                    dashed
                    checked={on}
                    disabled={!on && liveIds.length >= MAX_LIVE}
                    onChange={(value) => toggleLive(pull.id, value)}
                    title={
                      <>
                        <span className="font-mono text-sm font-medium">
                          {pull.resourceNames.join(", ")}
                        </span>
                        <span className="text-meta text-muted-foreground">
                          {pull.windowLabel}
                        </span>
                      </>
                    }
                    facts={[pull.connectorLabel, pull.customerName]}
                    aside={
                      <>
                        <span className="text-xs font-medium text-muted-foreground uppercase">
                          Live · not verified
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {pull.collectedAt.slice(0, 16).replace("T", " ")} UTC
                        </span>
                      </>
                    }
                  />
                )
              })}
            </ul>
          )}
          <Footnote>
            <span>
              Collected on request. Real data, but not checked the way a report
              is.
            </span>
            <Button
              variant="link"
              size="sm"
              onClick={() => onOpenDialog("live")}
            >
              Collect new live metrics
            </Button>
          </Footnote>
        </TabsContent>

        <TabsContent value="connectors" className="flex flex-col">
          {sources.connectors.length === 0 ? (
            <Empty>No connector in this workspace yet.</Empty>
          ) : (
            <ul className="flex flex-col p-1.5">
              {sources.connectors.map((connector) => {
                const on = attachments.connectorIds.includes(connector.id)
                const scanned = connector.scan !== null
                return (
                  <Row
                    key={connector.id}
                    id={`pick-connector-${connector.id}`}
                    checked={on}
                    disabled={
                      !scanned ||
                      (!on && attachments.connectorIds.length >= MAX_CONNECTORS)
                    }
                    onChange={(value) => toggleConnector(connector.id, value)}
                    title={
                      <span className="font-mono text-sm font-medium">
                        {connector.label}
                      </span>
                    }
                    facts={[
                      connector.customerName ?? "No customer",
                      scanned
                        ? `scanned ${connector.scan?.collectedAt.slice(0, 10)}`
                        : "not scanned yet",
                    ]}
                    aside={
                      scanned ? (
                        <span className="text-xs text-muted-foreground">
                          Latest scan
                        </span>
                      ) : (
                        <Link
                          href={`/subscriptions?c=${encodeURIComponent(connector.id)}`}
                          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                        >
                          Scan first
                        </Link>
                      )
                    }
                  />
                )
              })}
            </ul>
          )}
          <Footnote>
            <span>A connector answers from its latest scan.</span>
          </Footnote>
        </TabsContent>
      </Tabs>

      {chosen > 0 && suggestions.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <span className="text-micro text-muted-foreground uppercase">
            Start with
          </span>
          <ul className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  onClick={() => onAsk(suggestion)}
                  className="h-9 rounded-lg border border-input bg-card px-3.5 text-sm text-foreground transition-colors outline-none hover:border-ring/60 hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function Count({ n }: Readonly<{ n: number }>) {
  return n > 0 ? (
    <span className="font-mono text-xs font-normal text-muted-foreground">
      {n}
    </span>
  ) : null
}

function Empty({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <p className="px-4 py-8 text-center text-meta text-muted-foreground">
      {children}
    </p>
  )
}

function Footnote({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 border-t border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

/** One source: a checkbox, what it is, a line of facts and a mark on the right. */
function Row({
  id,
  checked,
  disabled,
  dashed = false,
  onChange,
  title,
  facts,
  aside,
}: Readonly<{
  id: string
  checked: boolean
  disabled: boolean
  dashed?: boolean
  onChange: (checked: boolean) => void
  title: React.ReactNode
  facts: readonly (string | null | undefined)[]
  aside: React.ReactNode
}>) {
  return (
    <li>
      <label
        htmlFor={id}
        className={cn(
          "grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-muted/70 has-disabled:cursor-not-allowed has-disabled:opacity-60 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]",
          checked && "bg-primary/[0.06] hover:bg-primary/[0.06]",
          dashed && "border border-dashed border-transparent",
          dashed && checked && "border-input"
        )}
      >
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onChange(value === true)}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
            {title}
          </span>
          <span className="truncate text-meta text-muted-foreground">
            {facts.filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="col-start-2 flex flex-col gap-0.5 sm:col-start-auto sm:items-end">
          {aside}
        </span>
      </label>
    </li>
  )
}
