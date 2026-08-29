"use client"

import type { ReactNode } from "react"

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

export type SourceKind = "azure" | "aws" | "onprem"

type Source = {
  readonly kind: SourceKind
  readonly name: string
  readonly credential: string
  readonly available: boolean
  readonly mark: ReactNode
}

const AzureMark = (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M9.6 3.4h5.1L9.4 18.9l-6.9.1L9.6 3.4Z" fill="#3B9EDB" />
    <path d="M11.5 3.4h3.2l6.8 17.2h-6.3l-4.3-8.6 2.5-4.4-1.9-4.2Z" fill="#1D6FA8" />
  </svg>
)

const AwsMark = (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M7 11.2c0 .3 0 .6.1.8l.5 1c0 .1.1.2.1.3 0 .1-.1.3-.3.4l-.7.5h-.3c-.1 0-.2 0-.3-.2l-.5-.5-.4-.6c-.5.6-1.2 1-2 1-.6 0-1-.2-1.4-.5-.3-.4-.5-.8-.5-1.4 0-.6.2-1.1.7-1.4.4-.4 1-.6 1.8-.6l1.3.2v-.5c0-.5-.1-.9-.3-1.1-.2-.2-.6-.3-1.2-.3l-.7.1-.8.2h-.2l-.2-.1v-.4l.1-.2.2-.2.9-.3 1-.1c.8 0 1.4.2 1.8.6.4.4.6.9.6 1.7v2.1Zm-2.7 1 .6-.1c.3-.1.5-.3.6-.5l.2-.4v-.6l-1-.1c-.4 0-.7 0-.9.2-.2.2-.3.4-.3.7 0 .3.1.5.2.6l.6.2Z"
      fill="#98A5B1"
    />
    <path
      d="M19.3 16.9c-2.3 1.7-5.7 2.6-8.6 2.6-4.1 0-7.8-1.5-10.6-4-.2-.2 0-.5.2-.3 3 1.7 6.7 2.8 10.5 2.8 2.6 0 5.4-.6 8-1.7.4-.2.7.3.5.6Zm1-1.1c-.3-.4-2-.2-2.7-.1-.2 0-.3-.2-.1-.3 1.3-.9 3.5-.7 3.8-.4.3.4-.1 2.5-1.3 3.5-.2.2-.4.1-.3-.1.3-.8.9-2.2.6-2.6Z"
      fill="#E8993B"
    />
  </svg>
)

const OnPremMark = (
  <svg
    width="30"
    height="30"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#98A5B1"
    strokeWidth="1.6"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="5" rx="1.2" />
    <rect x="3" y="11" width="18" height="5" rx="1.2" />
    <path d="M6.5 6.5h.01M6.5 13.5h.01M9.5 6.5h3M9.5 13.5h3" />
    <path d="M8 18v2M16 18v2M5 20h14" strokeLinecap="round" />
  </svg>
)

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
