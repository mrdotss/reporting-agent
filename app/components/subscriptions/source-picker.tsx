"use client"

import type { ReactNode } from "react"

import {
  AwsMark,
  AzureMark,
  OnPremMark,
  type SourceKind,
} from "@/components/subscriptions/provider-mark"

export type { SourceKind }

/**
 * Step one of connecting: which kind of estate this is (task 2.4).
 *
 * ## Why a step rather than a field on the wizard
 *
 * The source decides what the rest of the form asks for. An Azure subscription
 * needs a tenant, a client id and a secret; an AWS account needs a role to assume
 * and an external id; an on-premises estate needs a collector installed inside the
 * network. Those are not the same form with different labels, so choosing between
 * them is not a field within one form — it is the thing that selects the form.
 *
 * ## The unbuilt sources are shown, disabled
 *
 * Offering one card and calling it a choice would be worse than no step at all,
 * and hiding the other two would leave a consultant wondering whether this product
 * does AWS. They are visible, marked, and unclickable — which answers the question
 * without promising a date.
 *
 * The marks are **drawn here**, not fetched: the artifact CSP admits no image host,
 * and a provider's real brand SVG should replace each one when someone with the
 * right to redistribute it drops the file in.
 */

type Source = {
  readonly kind: SourceKind
  readonly name: string
  readonly credential: string
  readonly available: boolean
  readonly mark: ReactNode
}

const SOURCES: readonly Source[] = [
  {
    kind: "azure",
    name: "Microsoft Azure",
    credential: "Subscription-scoped service principal with the Reader role.",
    available: true,
    mark: AzureMark,
  },
  {
    kind: "aws",
    name: "Amazon Web Services",
    credential: "Cross-account IAM role with an external id.",
    available: false,
    mark: AwsMark,
  },
  {
    kind: "onprem",
    name: "On-premises",
    credential: "A collector agent inside the network, polling outward.",
    available: false,
    mark: OnPremMark,
  },
]

export function SourcePicker({
  onSelect,
}: Readonly<{ onSelect: (kind: SourceKind) => void }>) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-sm font-medium tracking-tight">
          Where does the estate live?
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          The source decides what the next step asks for — a tenant and a secret,
          a role to assume, or a collector inside the network.
        </p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-3">
        {SOURCES.map((source) => (
          <li key={source.kind}>
            <button
              type="button"
              disabled={!source.available}
              onClick={() => onSelect(source.kind)}
              aria-describedby={`source-${source.kind}-state`}
              className="flex h-full w-full flex-col items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none enabled:hover:border-primary/55 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="flex w-full items-center justify-between">
                {source.mark}
                <span
                  id={`source-${source.kind}-state`}
                  className={
                    source.available
                      ? "text-xs font-medium text-cat-5"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {source.available ? "Available" : "Coming soon"}
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <span className="font-heading text-sm font-medium tracking-tight">
                  {source.name}
                </span>
                <span className="text-sm text-muted-foreground">
                  {source.credential}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
