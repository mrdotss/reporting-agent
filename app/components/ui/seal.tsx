"use client"

import { useState } from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

/**
 * A seal: a content-addressed digest, drawn as the mark that proves a record.
 *
 * ## Why a digest is not a string here
 *
 * In this product the snapshot id *is* the hash of the snapshot's bytes, so a figure
 * quoted from a report traces to exactly the data it came from. That makes the digest
 * the single most load-bearing identifier on any screen — and it was being rendered
 * as 12 grey monospace characters with a copy icon beside it, which is how you draw
 * an incidental id, not a seal.
 *
 * So it is drawn as one: a well, ruled on all sides and struck on the leading edge in
 * verdigris, carrying the **head** — the first eight characters, at reading size, the
 * part a human actually quotes and compares — above the **tail** in full, small, so
 * nothing is hidden and the whole value is selectable and copyable.
 *
 * ## The head is eight characters because that is what people say out loud
 *
 * A consultant reading a verification statement aloud says "nine-eff-two-see", not
 * thirty-two hex digits. Eight is short enough to hold and long enough that a
 * collision inside one workspace is not a practical concern. The tail is present
 * because truncation that hides data is not something this product is allowed to do.
 */
export function Seal({
  value,
  label,
  tone = "verified",
  className,
}: Readonly<{
  /** The full digest. Never truncated in the DOM — only visually split. */
  value: string
  /** What this digest is of, for the copy control's accessible name. */
  label: string
  /** `unproven` strikes the leading edge in vermilion. */
  tone?: "verified" | "unproven" | "quiet"
  className?: string
}>) {
  const [copied, setCopied] = useState(false)

  const head = value.slice(0, 8)
  const tail = value.slice(8)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // A clipboard a browser refuses is not an error worth a dialog: the full value
      // is on screen and selectable, which is the fallback.
    }
  }

  return (
    <div
      data-slot="seal"
      data-tone={tone}
      className={cn(
        "flex items-start gap-2 rounded-sm border border-border bg-muted px-2.5 py-2",
        "border-l-2",
        tone === "verified" && "border-l-primary",
        tone === "unproven" && "border-l-destructive",
        tone === "quiet" && "border-l-border",
        className
      )}
    >
      <span className="flex min-w-0 flex-col gap-px">
        <span className="font-mono text-sm leading-tight font-semibold tracking-[0.02em] tabular-nums">
          {head}
        </span>
        <span className="font-mono text-micro leading-[1.45] break-all text-muted-foreground">
          {tail}
        </span>
      </span>

      <button
        type="button"
        onClick={() => void copy()}
        // The complete value in the accessible name — a screen-reader user hears what
        // they are about to copy, not "copy button".
        aria-label={`Copy the ${label}: ${value}`}
        // 20px glyph, 44px hit area, no layout cost: the pseudo-element carries the
        // target so the seal's own box stays the size the type sets.
        className={cn(
          "relative ml-auto grid size-5 shrink-0 place-items-center rounded-[2px] text-muted-foreground transition-colors",
          "before:absolute before:top-1/2 before:left-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
          "hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
        )}
      >
        {copied ? (
          <CheckIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <CopyIcon aria-hidden="true" className="size-3.5" />
        )}
      </button>

      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copied` : ""}
      </span>
    </div>
  )
}
