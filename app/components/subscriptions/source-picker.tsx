"use client"

import type { ReactNode } from "react"

import {
  AwsMark,
  AzureMark,
  OnPremMark,
  type SourceKind,
} from "@/components/subscriptions/provider-mark"
import { Badge } from "@/components/ui/badge"

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

      {/*
        One row, not a three-across grid. A grid gives the two sources nobody can pick
        the same weight as the one they came for, and at this width each card's second
        line wrapped to three. Stacked, the available source reads first and the other
        two are visibly a roadmap.
      */}
      <ul className="flex flex-col gap-2.5">
        {SOURCES.map((source) => (
          <li key={source.kind}>
            <button
              type="button"
              disabled={!source.available}
              onClick={() => onSelect(source.kind)}
              aria-describedby={`source-${source.kind}-state`}
              className="flex w-full items-center gap-4 rounded-xl border border-border px-4 py-3.5 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none enabled:hover:border-primary/55 enabled:hover:bg-primary/3 disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="shrink-0">{source.mark}</span>

              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-heading text-sm font-medium tracking-tight">
                  {source.name}
                </span>
                <span className="text-sm text-muted-foreground">
                  {source.credential}
                </span>
              </span>

              <Badge
                id={`source-${source.kind}-state`}
                variant={source.available ? "secondary" : "outline"}
                className="ml-auto shrink-0"
              >
                {source.available ? "Available" : "Coming soon"}
              </Badge>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
