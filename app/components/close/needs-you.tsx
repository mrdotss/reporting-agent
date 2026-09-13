import Link from "next/link"

import { RequestButton } from "@/components/close/request-button"
import { buttonVariants } from "@/components/ui/button"
import { StatusMark } from "@/components/ui/status-mark"
import type { AttentionItem } from "@/lib/close/attention"
import type { Board } from "@/lib/close/board"

/**
 * What stands between the open month and done, each with the one action that clears it,
 * and underneath, the tally of what the close has already proven.
 */
export function NeedsYou({
  items,
  board,
  workspaceId,
  canRequest,
}: Readonly<{
  items: readonly AttentionItem[]
  board: Board
  workspaceId: string
  canRequest: boolean
}>) {
  return (
    <section
      aria-labelledby="needs-you-title"
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card"
    >
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="needs-you-title" className="text-section">
            Needs you
          </h2>
          <p className="text-meta text-muted-foreground">
            What stands between this period and done.
          </p>
        </div>
        <span className="inline-flex h-[22px] items-center rounded-md border border-border px-2 font-mono text-xs tabular-nums">
          {items.length}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="border-t border-border/60 px-4 py-5 text-meta text-muted-foreground">
          Nothing is blocking the close.
        </p>
      ) : (
        <ul>
          {items.map((item) => (
            <li
              key={item.key}
              className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-border/60 px-4 py-3"
            >
              <span className="grid place-items-center pt-1">
                <StatusMark state={item.state} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="text-meta text-muted-foreground">{item.body}</p>
              </div>
              {item.action.kind === "request" ? (
                canRequest ? (
                  <RequestButton
                    workspaceId={workspaceId}
                    projectId={item.action.projectId}
                    customerName={item.title}
                    label={item.action.label}
                  />
                ) : null
              ) : (
                <Link
                  href={item.action.href}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {item.action.label}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-auto grid grid-cols-3 border-t border-border">
        {[
          [board.figuresProven.toLocaleString("en-US"), "figures proven"],
          [String(board.counts.delivered), "delivered"],
          [String(board.counts.undelivered), "not delivered"],
        ].map(([value, label], index) => (
          <div
            key={label}
            className={
              index === 0
                ? "flex flex-col gap-0.5 px-4 py-3"
                : "flex flex-col gap-0.5 border-l border-border/60 px-4 py-3"
            }
          >
            <dd className="text-figure-sm font-mono tabular-nums">{value}</dd>
            <dt className="order-first sr-only">{label}</dt>
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              {label}
            </span>
          </div>
        ))}
      </dl>
    </section>
  )
}
