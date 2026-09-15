"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { workspaceMutation } from "@/components/workspaces/workspace-context"

/**
 * The day each period's reports are due.
 *
 * One number, and it moves the deadline everywhere at once — the sidebar's period chip,
 * the close board's hero and its "days left". Capped at 28 so every month can honour it.
 */
export function CloseDayForm({
  workspaceId,
  closeDay,
  canEdit,
}: Readonly<{
  workspaceId: string
  closeDay: number
  /** Only the owner moves the close day (roles-and-ask-access Req 3); an admin sees it. */
  canEdit: boolean
}>) {
  const router = useRouter()
  const [value, setValue] = useState(String(closeDay))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")

  if (!canEdit) {
    return (
      <div className="flex max-w-md flex-col gap-1.5">
        <p className="text-sm">
          Reports are due on day{" "}
          <span className="font-mono font-medium tabular-nums">{closeDay}</span> of each
          month.
        </p>
        <p className="text-meta text-muted-foreground">
          Only the workspace owner can change the close day.
        </p>
      </div>
    )
  }

  const parsed = Number(value)
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 28

  return (
    <form
      className="flex max-w-md flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault()
        if (!valid) return
        setBusy(true)
        setMessage("")
        try {
          await workspaceMutation({
            action: "close_day",
            workspaceId,
            closeDay: parsed,
          })
          setMessage(`Reports are now due on day ${parsed} of each month.`)
          router.refresh()
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "The close day wasn’t saved."
          )
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="close-day" className="text-sm font-medium">
          Close day
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="close-day"
            type="number"
            inputMode="numeric"
            min={1}
            max={28}
            required
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-describedby="close-day-hint"
            className="w-24 font-mono tabular-nums"
          />
          <span className="text-sm text-muted-foreground">of each month</span>
        </div>
        <p id="close-day-hint" className="text-meta text-muted-foreground">
          Last month’s reports are due by this day. Any day from 1 to 28, so every
          month has one.
        </p>
      </div>

      <Button
        type="submit"
        disabled={busy || !valid || parsed === closeDay}
        className="w-fit"
      >
        {busy ? "Saving…" : "Save close day"}
      </Button>

      <p aria-live="polite" className="text-meta text-muted-foreground empty:hidden">
        {message}
      </p>
    </form>
  )
}
