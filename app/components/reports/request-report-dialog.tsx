"use client"

import { useState } from "react"
import { PlayIcon } from "@phosphor-icons/react/ssr"

import { RunForm } from "@/components/reports/run-form"
import { Button } from "@/components/ui/button"
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
