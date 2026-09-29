"use client"

import { useId, useState } from "react"
import { CalendarCheckIcon, WarningIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MAX_SCHEDULE_DAY, MIN_SCHEDULE_DAY, ordinalDay } from "@/lib/schedules/due"
import type { ScheduleView } from "@/lib/schedules/view"

/**
 * "Every month" on the run form: save the chosen connector and preset as this customer's
 * monthly schedule, change when it runs, or stop it.
 *
 * Independent of the request button — saving a schedule starts nothing now. The first run
 * is the next slot still ahead, and each one reports the preset's period at that moment,
 * exactly as a request by hand would.
 */

const DAYS = Array.from({ length: MAX_SCHEDULE_DAY - MIN_SCHEDULE_DAY + 1 }, (_, i) => MIN_SCHEDULE_DAY + i)
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`

export function SchedulePanel({
  workspaceId,
  projectId,
  connectedSubscriptionId,
  templateId,
  regions,
  schedule,
  nameOfConnector,
  nameOfTemplate,
  canSave,
}: Readonly<{
  workspaceId: string
  projectId: string
  connectedSubscriptionId: string
  templateId: string
  regions: readonly string[]
  schedule: ScheduleView | null
  nameOfConnector: (id: string) => string | undefined
  nameOfTemplate: (id: string) => string | undefined
  /** Whether the chosen connector and preset could be requested now. */
  canSave: boolean
}>) {
  const [saved, setSaved] = useState<ScheduleView | null>(schedule)
  const [editing, setEditing] = useState(schedule === null)
  const [day, setDay] = useState(schedule?.dayOfMonth ?? 1)
  const [hour, setHour] = useState(schedule?.hour ?? 2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dayId = useId()
  const hourId = useId()

  const samePairing =
    saved !== null && saved.connectedSubscriptionId === connectedSubscriptionId && saved.templateId === templateId

  async function send(method: "PUT" | "DELETE") {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/schedules", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          method === "DELETE"
            ? { workspaceId, projectId }
            : {
                workspaceId,
                projectId,
                connectedSubscriptionId,
                templateId,
                dayOfMonth: day,
                hour,
                ...(regions.length > 0 ? { regions: [...regions] } : {}),
              }
        ),
      })
      const body = (await response.json().catch(() => ({}))) as { schedule?: ScheduleView | null; error?: { message?: string } }
      if (!response.ok) {
        setError(body.error?.message ?? "The schedule could not be saved. Nothing changed.")
        return
      }
      setSaved(body.schedule ?? null)
      setEditing(body.schedule == null)
    } catch {
      setError("The schedule could not be saved. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset data-slot="run-form-schedule" className="flex flex-col gap-3 rounded-lg border border-border px-3 py-3">
      <legend className="px-1 font-heading text-sm font-medium tracking-tight">Every month</legend>

      {saved === null ? null : (
        <div className="flex flex-col gap-2">
          <p className="flex items-start gap-2.5 text-sm">
            <CalendarCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              Runs automatically {saved.cadence}:{" "}
              <span className="font-medium">{nameOfTemplate(saved.templateId) ?? "a preset"}</span> on{" "}
              <span className="font-medium">{nameOfConnector(saved.connectedSubscriptionId) ?? "a connector"}</span>. Next run{" "}
              <span className="font-mono tabular-nums">{saved.next}</span> WIB.
            </span>
          </p>
          {saved.lastError === null ? null : (
            <p className="flex items-start gap-2.5 rounded-md bg-(--status-attention-soft) px-2.5 py-2 text-xs text-(--status-attention)">
              <WarningIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>The last scheduled run did not start: {saved.lastError}</span>
            </p>
          )}
          {editing ? null : (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setEditing(true)}>
                Change
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send("DELETE")}>
                Stop schedule
              </Button>
            </div>
          )}
        </div>
      )}

      {editing ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {saved !== null && !samePairing
              ? "Saving replaces this customer's schedule with the connector and preset chosen above."
              : "Run the connector and preset chosen above every month. Each run reports the preset's period at that moment, the same as a request by hand, and shows on the Close Board."}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor={dayId} className="flex flex-col gap-1 text-xs font-medium">
              Day
              <Select value={String(day)} onValueChange={(value) => value && setDay(Number(value))}>
                <SelectTrigger id={dayId} className="w-28" aria-label="Day of the month">
                  <SelectValue>{(value) => (value ? ordinalDay(Number(value)) : "")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {DAYS.map((d) => (
                    <SelectItem key={d} value={String(d)} label={ordinalDay(d)}>
                      {ordinalDay(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label htmlFor={hourId} className="flex flex-col gap-1 text-xs font-medium">
              Time (WIB)
              <Select value={String(hour)} onValueChange={(value) => value && setHour(Number(value))}>
                <SelectTrigger id={hourId} className="w-28 font-mono" aria-label="Hour, WIB">
                  <SelectValue>{(value) => (value ? hh(Number(value)) : "")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)} label={hh(h)}>
                      <span className="font-mono">{hh(h)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Button type="button" size="sm" disabled={busy || !canSave} onClick={() => void send("PUT")}>
              {busy ? "Saving…" : "Save schedule"}
            </Button>
            {saved === null ? null : (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
          {canSave ? null : (
            <p className="text-xs text-muted-foreground">Choose a connector and a preset that can be requested first.</p>
          )}
        </div>
      ) : null}

      {error === null ? null : (
        <p aria-live="polite" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  )
}
