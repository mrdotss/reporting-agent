"use client"

import { useId, useState } from "react"
import { useRouter } from "next/navigation"
import { PencilSimpleIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { workspaceMutation } from "@/components/workspaces/workspace-context"

/**
 * Rename the workspace, beside its name in Workspace settings (roles-and-ask-access
 * Req 10).
 *
 * Rendered for the owner only; everyone else reads the name in the header. Every account
 * starts with a default workspace called "My workspace", and this is where it gets a real
 * name. The sidebar's switcher reads the name from the layout, so the refresh after saving
 * updates it too.
 */
export function RenameWorkspace({
  workspaceId,
  name,
}: Readonly<{ workspaceId: string; name: string }>) {
  const router = useRouter()
  const inputId = useId()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const next = value.trim()
  const savable = next.length > 0 && next !== name

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setValue(name)
          setError("")
          setOpen(true)
        }}
      >
        <PencilSimpleIcon aria-hidden="true" />
        Rename
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Rename workspace</DialogTitle>
          <DialogDescription>
            Everyone in this workspace sees the new name in their workspace switcher.
          </DialogDescription>
          <form
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault()
              if (!savable) return
              setBusy(true)
              setError("")
              try {
                await workspaceMutation({
                  action: "rename_workspace",
                  workspaceId,
                  name: next,
                })
                setOpen(false)
                router.refresh()
              } catch (thrown) {
                setError(
                  thrown instanceof Error ? thrown.message : "The name wasn’t saved."
                )
              } finally {
                setBusy(false)
              }
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-sm font-medium">
                Workspace name
              </label>
              <Input
                id={inputId}
                required
                maxLength={120}
                autoComplete="off"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={busy || !savable} className="w-fit">
              {busy ? "Saving…" : "Save name"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
