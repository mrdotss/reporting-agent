"use client"

import { useCallback, useState } from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"

/**
 * A digest, truncated for the line, with a control that copies the **complete**
 * recorded string (Requirements 38.2, 39.1).
 *
 * ## Truncated on screen, complete on the clipboard
 *
 * A 64-character hex string is unreadable in a table row and unmistakable at
 * twelve characters, so the line shows twelve. But a consultant copying a digest
 * is copying it in order to compare it with something, and a truncated
 * comparison is worse than none — it matches on a prefix and reads as a pass.
 * So the button copies `value`, always, whatever the line shows.
 *
 * The full string is also in `title` and in the button's accessible name, so a
 * reader who cannot use the clipboard can still get at it.
 *
 * ## Mono with tabular figures
 *
 * Requirement 39.1 asks for both. `tabular-nums` matters here in a way it does
 * not for prose: three digests stacked in a panel line up digit for digit, and a
 * mismatch shows as a break in the column rather than as something the reader
 * has to compare character by character.
 */

const TRUNCATE_TO = 12

export function CopyDigest({
  value,
  label,
  truncate = true,
}: Readonly<{
  value: string
  /** What this digest is, for the copy control's accessible name. */
  label: string
  truncate?: boolean
}>) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      // A denied clipboard permission is not worth an error state: the full
      // string is in `title` and in the accessible name, so the value is still
      // reachable. Failing loudly here would put a red message beside a digest
      // that is perfectly readable.
    }
  }, [value])

  const shown =
    truncate && value.length > TRUNCATE_TO ? value.slice(0, TRUNCATE_TO) : value

  return (
    <span data-slot="copy-digest" className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs tabular-nums" title={value}>
        {shown}
      </span>

      <button
        type="button"
        onClick={() => void copy()}
        // The complete string in the accessible name, so a screen-reader user
        // hears what they are about to copy rather than "copy button".
        aria-label={`Copy the ${label}: ${value}`}
        className="rounded-md p-0.5 text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
      >
        {copied ? (
          <CheckIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <CopyIcon aria-hidden="true" className="size-3.5" />
        )}
      </button>

      {/* Announced on copy, so the icon swap is not the only feedback. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copied` : ""}
      </span>
    </span>
  )
}
