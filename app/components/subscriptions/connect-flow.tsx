"use client"

import { useState, type ReactNode } from "react"
import { ArrowLeftIcon } from "@phosphor-icons/react/ssr"

import { ConnectWizard } from "@/components/subscriptions/connect-wizard"
import {
  SourcePicker,
  type SourceKind,
} from "@/components/subscriptions/source-picker"
import { Button } from "@/components/ui/button"

/**
 * The connect flow: pick a source, then fill in that source's wizard (task 2.4).
 *
 * A thin shell. It holds one piece of state — which source was chosen — and does
 * nothing else; `ConnectWizard` is untouched and still owns the whole Azure path,
 * including the preflight, the encryption call and its own error surface.
 *
 * That separation is the point. When the AWS path exists it becomes a sibling
 * wizard selected here, rather than a set of branches threaded through the Azure
 * one — which is the shape that would make an Azure change able to break AWS.
 *
 * `explainer` stays a prop rather than an import for the reason the page's own
 * docstring gives: it is compliance copy a consultant forwards to a customer, so
 * it is server-rendered into the initial HTML.
 */
export function ConnectFlow({
  explainer,
  nowIso,
}: Readonly<{ explainer: ReactNode; nowIso: string }>) {
  const [source, setSource] = useState<SourceKind | null>(null)

  if (source === null) {
    return <SourcePicker onSelect={setSource} />
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-heading text-sm font-medium tracking-tight">
            Microsoft Azure
          </span>
          <span className="text-sm text-muted-foreground">
            Service principal, Reader at subscription scope
          </span>
        </div>

        <Button variant="outline" size="sm" onClick={() => setSource(null)}>
          <ArrowLeftIcon aria-hidden="true" />
          Change source
        </Button>
      </div>

      <ConnectWizard explainer={explainer} nowIso={nowIso} />
    </div>
  )
}
