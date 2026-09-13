import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * The state of a customer's report, as a shape.
 *
 * Shape carries state before hue does, so no two states differ by colour alone and a
 * board of marks still reads in greyscale or under a colour-vision deficiency:
 *
 *   delivered    filled circle
 *   running      half-filled circle, turning
 *   queued       dashed ring
 *   due          hollow ring — nothing requested yet
 *   undelivered  diamond
 *   attention    triangle
 *   none         dash — not a customer in that month
 */
export type CloseState =
  | "delivered"
  | "running"
  | "queued"
  | "due"
  | "undelivered"
  | "attention"
  | "none"

export const CLOSE_STATE_LABEL: Readonly<Record<CloseState, string>> = {
  delivered: "Verified",
  running: "In flight",
  queued: "Queued",
  due: "Not requested",
  undelivered: "Not delivered",
  attention: "Needs attention",
  none: "Not a customer yet",
}

const markVariants = cva("inline-block shrink-0 align-middle", {
  variants: {
    state: {
      delivered: "size-2.5 rounded-full bg-(--status-verified)",
      running:
        "size-2.5 animate-spin rounded-full border-[1.5px] border-(--status-inflight) bg-[conic-gradient(var(--status-inflight)_0_50%,transparent_50%_100%)] [animation-duration:1.4s] motion-reduce:animate-none",
      queued:
        "size-2.5 rounded-full border-[1.5px] border-dashed border-muted-foreground",
      due: "size-2.5 rounded-full border-[1.5px] border-muted-foreground/60",
      undelivered:
        "size-2.5 scale-[0.76] rotate-45 rounded-[1.5px] bg-(--status-failed)",
      attention:
        "size-2.5 bg-(--status-attention) [clip-path:polygon(50%_6%,97%_92%,3%_92%)]",
      none: "h-[1.5px] w-3 rounded-full bg-muted-foreground/60",
    },
  },
})

export function StatusMark({
  state,
  className,
  ...props
}: Readonly<{ state: CloseState }> & React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="status-mark"
      data-state={state}
      className={cn(markVariants({ state }), className)}
      {...props}
    />
  )
}

const badgeVariants = cva(
  "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-xs font-medium",
  {
    variants: {
      state: {
        delivered:
          "border-transparent bg-(--status-verified-soft) text-(--status-verified)",
        running:
          "border-transparent bg-(--status-inflight-soft) text-(--status-inflight)",
        queued:
          "border-transparent bg-(--status-inflight-soft) text-(--status-inflight)",
        due: "border-border bg-card text-muted-foreground",
        undelivered:
          "border-transparent bg-(--status-failed-soft) text-(--status-failed)",
        attention:
          "border-transparent bg-(--status-attention-soft) text-(--status-attention)",
        none: "border-border bg-card text-muted-foreground",
      },
    },
  }
)

/** A mark and its word. The word is never dropped: the mark resolves at a glance, the word confirms it. */
export function StatusBadge({
  state,
  label,
  className,
  ...props
}: Readonly<{ state: CloseState; label?: string }> &
  React.ComponentProps<"span">) {
  return (
    <span
      data-slot="status-badge"
      data-state={state}
      className={cn(badgeVariants({ state }), className)}
      {...props}
    >
      <StatusMark state={state} className="size-2" />
      {label ?? CLOSE_STATE_LABEL[state]}
    </span>
  )
}
