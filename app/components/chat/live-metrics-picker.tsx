"use client"

import { useEffect, useMemo, useState } from "react"
import { CircleNotchIcon, LightningIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AttachableConnector, AttachableLive } from "@/lib/chat/sources"
import type { LiveMetricPullView } from "@/lib/db/views"
import {
  MAX_LIVE_RESOURCES,
  PRESET_LABEL,
  presetWindow,
  windowLabel,
  windowProblem,
  type LivePreset,
  type LiveWindow,
} from "@/lib/live-metrics/window"
import { cn } from "@/lib/utils"

/**
 * Collect live metrics for machines a user picks (ask-chat Req 8).
 *
 * Three choices — a connector, its machines, a window of whole Jakarta days — and one
 * action. The collection runs in the request and takes tens of seconds, so the button
 * shows that it is working and the rest of the dialog stays usable. A finished pull is
 * handed back and attached; its figures are cited as live and unverified.
 *
 * The machine listing is keyed by the connector it was read for, so switching connectors
 * shows the loading state for the new one without resetting state inside an effect.
 */

type Resource = {
  readonly resourceId: string
  readonly name: string
  readonly location: string
  readonly skuName: string
  readonly powerState: string
}

type Listing = {
  readonly connectorId: string
  readonly resources: readonly Resource[]
  readonly error: string
}

type WindowChoice = LivePreset | "custom"
const PRESETS: readonly LivePreset[] = ["yesterday", "last_7_days", "month_to_date"]

export function LiveMetricsPicker({
  connectors,
  onCollected,
}: Readonly<{
  connectors: readonly AttachableConnector[]
  onCollected: (pull: AttachableLive) => void
}>) {
  const azure = connectors.filter((connector) => connector.provider === "azure")
  const [connectorId, setConnectorId] = useState(azure[0]?.id ?? "")
  const [listing, setListing] = useState<Listing | null>(null)
  const [picked, setPicked] = useState<readonly string[]>([])
  const [filter, setFilter] = useState("")
  const [choice, setChoice] = useState<WindowChoice>("last_7_days")
  const [custom, setCustom] = useState<LiveWindow>(() => presetWindow("last_7_days"))
  const [collecting, setCollecting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!connectorId) return
    let cancelled = false
    fetch(`/api/subscriptions/${encodeURIComponent(connectorId)}/resources`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { resources?: Resource[]; error?: { message?: string } }
          | null
        if (cancelled) return
        if (!response.ok || body?.resources === undefined) {
          setListing({
            connectorId,
            resources: [],
            error: body?.error?.message ?? "This connector’s machines couldn’t be listed.",
          })
          return
        }
        setListing({ connectorId, resources: body.resources, error: "" })
      })
      .catch(() => {
        if (!cancelled) {
          setListing({
            connectorId,
            resources: [],
            error: "This connector’s machines couldn’t be listed. Check your connection.",
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [connectorId])

  const current = listing?.connectorId === connectorId ? listing : null
  const resources = current?.resources ?? null
  const listError = current?.error ?? ""

  const window: LiveWindow = choice === "custom" ? custom : presetWindow(choice)
  const problem = windowProblem(window)
  const connector = azure.find((entry) => entry.id === connectorId)
  const needle = filter.trim().toLowerCase()
  const visible = useMemo(
    () =>
      (resources ?? []).filter((resource) =>
        needle ? `${resource.name} ${resource.location} ${resource.skuName}`.toLowerCase().includes(needle) : true
      ),
    [resources, needle]
  )

  function chooseConnector(value: string) {
    if (!value || value === connectorId) return
    setConnectorId(value)
    setPicked([])
    setError("")
  }

  async function collect() {
    if (!connector || picked.length === 0 || problem !== null) return
    setCollecting(true)
    setError("")
    try {
      const response = await fetch("/api/chat/live-metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectedSubscriptionId: connector.id, resourceIds: picked, window }),
      })
      const body = (await response.json().catch(() => null)) as
        | { pull?: LiveMetricPullView; error?: { message?: string } }
        | null
      if (!response.ok || body?.pull === undefined || body.pull.status !== "complete") {
        setError(body?.error?.message ?? "The metrics couldn’t be collected. Try again.")
        return
      }
      const pull = body.pull
      onCollected({
        id: pull.id,
        ownerId: "",
        connectorId: pull.connectedSubscriptionId,
        connectorLabel: connector.label,
        customerName: connector.customerName,
        resourceNames: pull.resourceNames,
        windowLabel: windowLabel({ start: pull.periodStart, end: pull.periodEnd }),
        periodStart: pull.periodStart,
        periodEnd: pull.periodEnd,
        resourceCount: pull.resourceCount,
        gapCount: pull.gapCount,
        collectedAt: pull.completedAt ?? pull.createdAt,
      })
      setPicked([])
    } catch {
      setError("The metrics couldn’t be collected. Check your connection.")
    } finally {
      setCollecting(false)
    }
  }

  if (azure.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-meta text-muted-foreground">
        Live metrics need an Azure connector in this workspace.
      </p>
    )
  }

  const full = picked.length >= MAX_LIVE_RESOURCES

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="live-connector" className="text-xs font-medium">
            Connector
          </label>
          <Select value={connectorId} onValueChange={(value) => value && chooseConnector(value)}>
            <SelectTrigger id="live-connector" className="w-full">
              <SelectValue>
                {(value) => azure.find((entry) => entry.id === value)?.label ?? ""}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {azure.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                  {entry.customerName ? ` · ${entry.customerName}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <span id="live-window-label" className="text-xs font-medium">
            Window <span className="font-normal text-muted-foreground">· Jakarta days</span>
          </span>
          <div role="radiogroup" aria-labelledby="live-window-label" className="flex flex-wrap gap-1">
            {[...PRESETS, "custom" as const].map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={choice === option}
                onClick={() => setChoice(option)}
                className={cn(
                  "h-8 rounded-lg border px-2.5 text-xs outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30",
                  choice === option
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "border-input bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {option === "custom" ? "Custom" : PRESET_LABEL[option]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {choice === "custom" ? (
        <div className="flex flex-wrap items-end gap-2">
          <DateField id="live-start" label="Start" value={custom.start} onChange={(start) => setCustom({ ...custom, start })} />
          <DateField id="live-end" label="End" value={custom.end} onChange={(end) => setCustom({ ...custom, end })} />
        </div>
      ) : null}

      <p className={cn("text-xs", problem ? "text-(--status-attention)" : "text-muted-foreground")}>
        {problem ?? `Collects ${windowLabel(window)}.`}
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">
            Machines <span className="font-mono font-normal text-muted-foreground">{picked.length}/{MAX_LIVE_RESOURCES}</span>
          </span>
          <input
            id="live-machine-filter"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter machines"
            aria-label="Filter machines"
            className="h-7 w-40 rounded-md border border-input bg-muted px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        </div>
        <div className="min-h-32 flex-1 overflow-y-auto rounded-lg border border-border">
          {resources === null ? (
            <p className="flex items-center gap-2 px-3 py-4 text-meta text-muted-foreground">
              <CircleNotchIcon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
              Listing this connector’s machines…
            </p>
          ) : listError ? (
            <p className="px-3 py-4 text-meta text-destructive">{listError}</p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-4 text-meta text-muted-foreground">
              {resources.length === 0 ? "This connector sees no virtual machines." : "No machine matches that."}
            </p>
          ) : (
            visible.map((resource) => {
              const checked = picked.includes(resource.resourceId)
              const id = `live-machine-${resource.resourceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`
              return (
                <label
                  key={resource.resourceId}
                  htmlFor={id}
                  className="grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-border/60 px-3 py-2 first:border-t-0 hover:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-60"
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={!checked && full}
                    onCheckedChange={(value) =>
                      setPicked((selection) =>
                        value === true
                          ? [...selection, resource.resourceId].slice(0, MAX_LIVE_RESOURCES)
                          : selection.filter((entry) => entry !== resource.resourceId)
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-sm font-medium">{resource.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {resource.skuName || "Unknown size"} · {resource.location}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{powerLabel(resource.powerState)}</span>
                </label>
              )
            })
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => void collect()}
          disabled={collecting || picked.length === 0 || problem !== null}
        >
          {collecting ? (
            <CircleNotchIcon aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          ) : (
            <LightningIcon aria-hidden="true" />
          )}
          {collecting ? "Collecting… about a minute" : "Collect and attach"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Live figures are collected now and aren’t verified like a report.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function powerLabel(state: string): string {
  switch (state) {
    case "running":
      return "Running"
    case "deallocated":
    case "stopped":
      return "Stopped"
    default:
      return state ? state.charAt(0).toUpperCase() + state.slice(1) : "—"
  }
}

function DateField({
  id,
  label,
  value,
  onChange,
}: Readonly<{ id: string; label: string; value: string; onChange: (value: string) => void }>) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[0.6875rem] text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-lg border border-input bg-card px-2.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      />
    </div>
  )
}
