"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowClockwiseIcon, PlayIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { workspaceMutation } from "@/components/workspaces/workspace-context"

/**
 * Request (or retry) one customer's report straight from the close.
 *
 * The request form is scoped to the selected customer — its connectors and presets are
 * that customer's — so the button selects the customer first and then opens the form.
 * `refresh` after `push` because the shell's layout survives navigation, and the rail
 * has to learn the new scope too.
 */
export function RequestButton({
  workspaceId,
  projectId,
  customerName,
  label,
  size = "sm",
}: Readonly<{
  workspaceId: string
  projectId: string
  customerName: string
  label: "Request" | "Retry"
  size?: "xs" | "sm"
}>) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={busy}
      aria-label={`${label} ${customerName}’s report`}
      onClick={async () => {
        setBusy(true)
        try {
          await workspaceMutation({ action: "select", workspaceId, projectId })
          router.push("/reports/new")
          router.refresh()
        } finally {
          setBusy(false)
        }
      }}
    >
      {label === "Retry" ? (
        <ArrowClockwiseIcon aria-hidden="true" />
      ) : (
        <PlayIcon aria-hidden="true" />
      )}
      {label}
    </Button>
  )
}
