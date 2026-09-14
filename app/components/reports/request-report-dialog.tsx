"use client"
import Link from "next/link"
import { useWorkspace } from "@/components/workspaces/workspace-context"
import { can } from "@/lib/workspaces/policy"

import { useState } from "react"
import { PlayIcon } from "@phosphor-icons/react/ssr"

import { RunForm } from "@/components/reports/run-form"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import type { ConnectedSubscriptionView, TemplateView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"

/**
 * The request form, behind a button (task 2.2).
 *
 * In the workspace shell the button is a link to `/reports/new`. It is enabled whenever
 * the reader can edit, **including with All customers selected**: a report is requested
 * for one customer, so with no customer in scope the request page asks which one rather
 * than this button refusing without saying why. Only a reader who cannot edit, or an
 * archived customer, gets a disabled button.
 *
 * `RunForm` is unchanged and unaware of the dialog. It owns its own submission, its own
 * validation and its own error surface; this only decides when it is on screen.
 */
export function RequestReportDialog({
  subscriptions,
  templates,
  nowIso,
}: Readonly<{
  subscriptions: readonly ConnectedSubscriptionView[]
  templates: readonly TemplateView[]
  nowIso: string
}>) {
  const [open, setOpen] = useState(false)
  const workspace = useWorkspace()
  if (workspace) {
    // A link when it can be followed, a real disabled button when it cannot — `disabled`
    // has no meaning on an anchor, so the disabled form is a button.
    const blocked = workspace.archived || !can(workspace.role, "edit")
    const label = (
      <>
        <PlayIcon />
        {messageText("ui.run_table.request", "en")}
      </>
    )
    return blocked ? (
      <Button disabled>{label}</Button>
    ) : (
      <Link data-slot="button" href="/reports/new" className={buttonVariants()}>
        {label}
      </Link>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <PlayIcon aria-hidden="true" />
            {messageText("ui.run_table.request", "en")}
          </Button>
        }
      />

      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{messageText("ui.run_table.request", "en")}</DialogTitle>
          <DialogDescription>
            {messageText("ui.run_form.duration_hint", "en")}
          </DialogDescription>
        </DialogHeader>

        <RunForm
          subscriptions={subscriptions}
          templates={templates}
          nowIso={nowIso}
        />
      </DialogContent>
    </Dialog>
  )
}
