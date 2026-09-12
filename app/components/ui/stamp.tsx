import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * A struck stamp: the state of a record, as an inspection mark.
 *
 * ## Why this is not a badge
 *
 * A pill badge says "tag" — it is the same shape a product uses for a category, a
 * count, a label. This product's states are not tags. A run is *verified* or it is
 * *not delivered*, and that verdict is the whole reason the screen exists. So it is
 * drawn the way a verdict is drawn on paper: small caps, tracked, ruled on all four
 * sides, in the state's own ink, on a wash of the same hue.
 *
 * ## Colour is never the only channel
 *
 * About one reader in twelve cannot separate these hues, and a table of records is
 * scanned rather than read. So every stamp carries a filled dot in the state's colour
 * *and* the word, and the word is never abbreviated to a glyph. The dot resolves at a
 * glance and at any zoom; the word confirms it.
 *
 * ## The tones are the status scale, not the accent
 *
 * `--status-*` is four measured steps that exist only to mean state. Verdigris means
 * "this product" and is spent on primary actions; it is deliberately absent here, or
 * a verified stamp and a primary button would be the same signal. `--status-failed`
 * is vermilion, and it means exactly one thing: this document could not be proven.
 */
const stampVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[1px] border px-1.5 pt-[3px] pb-[2px] font-sans text-micro uppercase leading-[1.35]",
  {
    variants: {
      tone: {
        neutral:
          "border-border bg-transparent text-muted-foreground [--dot:var(--muted-foreground)]",
        working:
          "border-(--status-inflight) bg-(--status-inflight-soft) text-(--status-inflight) [--dot:var(--status-inflight)]",
        verified:
          "border-(--status-verified) bg-(--status-verified-soft) text-(--status-verified) [--dot:var(--status-verified)]",
        attention:
          "border-(--status-attention) bg-(--status-attention-soft) text-(--status-attention) [--dot:var(--status-attention)]",
        unproven:
          "border-(--status-failed) bg-(--status-failed-soft) text-(--status-failed) [--dot:var(--status-failed)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
)

export type StampTone = NonNullable<VariantProps<typeof stampVariants>["tone"]>

export function Stamp({
  tone,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof stampVariants>) {
  return (
    <span
      data-slot="stamp"
      data-tone={tone ?? "neutral"}
      className={cn(stampVariants({ tone }), className)}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="stamp-dot"
        className="size-1 shrink-0 rounded-full bg-(--dot)"
      />
      {children}
    </span>
  )
}

export { stampVariants }
