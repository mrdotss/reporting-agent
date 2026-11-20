"use client"

import { useId, useState } from "react"
import { CalendarCheckIcon, WarningIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  MAX_SCHEDULE_DAY,
  MIN_SCHEDULE_DAY,
  WEEKLY_DEFAULT,
  ordinalDay,
  weekdayName,
  type ScheduleCadence,
} from "@/lib/schedules/due"
import type { ScheduleView } from "@/lib/schedules/view"

/**
 * "Every month" or "Every week" on the run form: save the chosen connector and preset as
 * this customer's monthly or weekly schedule, change when it runs, or stop it. The form
 * shows one panel of each; a customer can have both.
 *
 * Independent of the request button — saving a schedule starts nothing now. The first run
 * is the next slot still ahead, and each one reports the preset's period at that moment,
 * exactly as a request by hand would.
 */

const DAYS = Array.from({ length: MAX_SCHEDULE_DAY - MIN_SCHEDULE_DAY + 1 }, (_, i) => MIN_SCHEDULE_DAY + i)
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]
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
  cadence = "monthly",
  openByDefault,
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
  cadence?: ScheduleCadence
  /**
   * Whether the form shows when there is no schedule yet. Monthly does by default; a
   * weekly panel without a schedule waits behind a button unless the preset is a weekly one.
   */
  openByDefault?: boolean
}>) {
  const weekly = cadence === "weekly"
  const [saved, setSaved] = useState<ScheduleView | null>(schedule)
  const [editing, setEditing] = useState(schedule === null && (openByDefault ?? !weekly))
  const [day, setDay] = useState(
    weekly ? (schedule?.dayOfWeek ?? WEEKLY_DEFAULT.dayOfWeek) : (schedule?.dayOfMonth ?? 1)
  )
  const [hour, setHour] = useState(schedule?.hour ?? (weekly ? WEEKLY_DEFAULT.hour : 2))
  // A weekly report is one the customer reads in their inbox, so it sends by default.
  const [autoSend, setAutoSend] = useState(schedule?.autoSend ?? weekly)
  const autoSendId = useId()
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
            ? { workspaceId, projectId, ...(weekly ? { cadence } : {}) }
            : {
                workspaceId,
                projectId,
                connectedSubscriptionId,
                templateId,
                ...(weekly ? { cadence, dayOfWeek: day } : { dayOfMonth: day }),
                hour,
                ...(autoSend ? { autoSend: true } : {}),
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
      setEditing(body.schedule == null && !weekly)
    } catch {
      setError("The schedule could not be saved. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset data-slot="run-form-schedule" className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 pt-3.5 pb-4">
      <legend className="float-left mb-1 w-full text-sm font-semibold">{weekly ? "Every week" : "Every month"}</legend>

      {saved === null ? null : (
        <div className="flex flex-col gap-2">
          <p className="flex items-start gap-2.5 text-sm">
            <CalendarCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              Runs automatically {saved.cadence}:{" "}
              <span className="font-medium">{nameOfTemplate(saved.templateId) ?? "a preset"}</span> on{" "}
              <span className="font-medium">{nameOfConnector(saved.connectedSubscriptionId) ?? "a connector"}</span>. Next run{" "}
              <span className="font-mono tabular-nums">{saved.next}</span> WIB.
              {saved.autoSend ? " Each report is emailed to this customer's contacts once it passes verification." : null}
            </span>
          </p>
          {saved.lastError === null ? null : (
            <p className="flex items-start gap-2.5 rounded-md bg-(--status-attention-soft) px-2.5 py-2 text-xs text-(--status-attention)">
              <WarningIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>The last scheduled run did not start: {saved.lastError}</span>
            </p>
          )}
          {saved.lastSendError === null ? null : (
            <p className="flex items-start gap-2.5 rounded-md bg-(--status-attention-soft) px-2.5 py-2 text-xs text-(--status-attention)">
              <WarningIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>The last scheduled report was not emailed: {saved.lastSendError}</span>
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

      {saved === null && !editing ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Send this report every week, for the Monday-to-Sunday week just ended.
          </p>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setEditing(true)}>
            Set up a weekly schedule
          </Button>
        </div>
      ) : null}

      {editing ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {saved !== null && !samePairing
              ? "Saving replaces this customer's schedule with the connector and preset chosen above."
              : weekly
                ? "Run the connector and preset chosen above every week. Each run reports the preset's period at that moment, so a Last 7 days preset run on Monday covers Monday to Sunday of the week just ended."
                : "Run the connector and preset chosen above every month. Each run reports the preset's period at that moment, the same as a request by hand, and shows on the Close Board."}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor={dayId} className="flex flex-col gap-1 text-xs font-medium">
              Day
              <Select value={String(day)} onValueChange={(value) => value && setDay(Number(value))}>
                <SelectTrigger id={dayId} className={weekly ? "w-36" : "w-28"} aria-label={weekly ? "Day of the week" : "Day of the month"}>
                  <SelectValue>{(value) => (value ? (weekly ? weekdayName : ordinalDay)(Number(value)) : "")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(weekly ? WEEKDAYS : DAYS).map((d) => (
                    <SelectItem key={d} value={String(d)} label={(weekly ? weekdayName : ordinalDay)(d)}>
                      {(weekly ? weekdayName : ordinalDay)(d)}
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
            <label htmlFor={autoSendId} className="flex items-center gap-2 pb-2 text-xs font-medium">
              <Checkbox id={autoSendId} checked={autoSend} onCheckedChange={(checked) => setAutoSend(checked === true)} />
              Email it to the customer&apos;s contacts when it passes verification
            </label>
            <Button type="button" size="sm" disabled={busy || !canSave} onClick={() => void send("PUT")}>
              {busy ? "Saving…" : weekly ? "Save weekly schedule" : "Save schedule"}
            </Button>
            {saved === null && !weekly ? null : (
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
