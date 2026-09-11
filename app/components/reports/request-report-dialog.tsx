"use client"
import Link from "next/link"
import { useWorkspace } from "@/components/workspaces/workspace-shell"
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
 * The form occupied the whole first screen of `/reports` and pushed the run
 * history below the fold — on a page a consultant opens mostly to *read* that
 * history. Requesting a report is the rarer act of the two, so it is the one
 * behind a control.
 *
 * `RunForm` is unchanged and unaware of the dialog. It owns its own submission,
 * its own validation and its own error surface; this only decides when it is on
 * screen, which is why the two can be reasoned about separately.
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
    // A link when it can be followed, a real disabled button when it cannot.
    //
    // Not one control with a `disabled` prop: `disabled` has no meaning on an anchor, so
    // the "disabled" form would still be focusable and still navigate. And routing a
    // navigation through Base UI's button sets `role="button"` on the anchor, which tells
    // a screen reader this activates something when what it does is go somewhere.
    // `buttonVariants` gives the same appearance with the element each case actually
    // wants; `data-slot="button"` is what the workspace stylesheet keys its radius on.
    const blocked =
      !workspace.projectId || workspace.archived || !can(workspace.role, "edit")
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
