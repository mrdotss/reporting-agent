"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"

/**
 * Copy one generated artifact to the clipboard (Requirement 11.6's surface).
 *
 * The smallest client leaf in the wizard, and the only reason `az-script-step`
 * and `arm-template-step` need the browser at all. It holds no data of its own:
 * the `value` it copies is the artifact string the caller already renders in a
 * `<pre>`, so what lands on the clipboard is character-for-character what the
 * consultant can read on screen. Copying a *second* rendering of the artifact —
 * regenerating it here, or trimming it — is how a customer runs a script that
 * differs from the one that was reviewed.
 *
 * ## Why the result is announced rather than only shown
 *
 * A copy is invisible: nothing on the page changes except this control's own
 * glyph, and a screen-reader user has no way to know the click did anything. The
 * outcome therefore goes through an `aria-live="polite"` region — success and
 * failure both — and the failure case says what to do instead, because a browser
 * can refuse `writeText` for reasons the visitor cannot fix (an insecure origin,
 * a denied permission) and "nothing happened" is the worst possible answer to
 * that.
 *
 * The confirmation reverts after {@link COPIED_RESET_MS} so a stale "Copied"
 * cannot be read as a fresh one, and the timer is cleared on unmount — the
 * wizard swaps steps out from under this component, and a `setState` after that
 * is a React warning at best.
 */

/** How long the confirmation stands before the control returns to rest. */
export const COPIED_RESET_MS = 2_000

/** What the control is currently saying. */
type CopyStatus = "idle" | "copied" | "failed"

type CopyButtonProps = Readonly<{
  /** The exact text to place on the clipboard. */
  value: string
  /**
   * The control's accessible name — "Copy the az CLI script", not "Copy".
   *
   * Required rather than defaulted, because this component is used more than
   * once on the same step and two controls named "Copy" are indistinguishable in
   * a list of links and buttons.
   */
  label: string
}>

export function CopyButton({ value, label }: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("idle")

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback(async () => {
    if (timer.current !== undefined) clearTimeout(timer.current)

    try {
      // Read through `navigator` rather than destructured at module scope: the
      // API is absent on an insecure origin and in some embedded webviews, and a
      // destructured `undefined` would throw a TypeError instead of reaching the
      // failure branch that tells the visitor to select the text by hand.
      await navigator.clipboard.writeText(value)
      setStatus("copied")
    } catch {
      setStatus("failed")
      return
    }

    timer.current = setTimeout(() => setStatus("idle"), COPIED_RESET_MS)
  }, [value])

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void copy()
        }}
      >
        {status === "copied" ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}

        {label}
      </Button>

      {/*
        The region exists before it has content, so the announcement is made on
        an element the assistive technology is already observing. `role="status"`
        rather than `alert` for both outcomes: a failed copy is recoverable by
        selecting the text, and it does not warrant interrupting.
      */}
      <p
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground"
      >
        {status === "copied" ? "Copied to the clipboard." : null}
        {status === "failed"
          ? "The clipboard is not available in this browser. Select the text above and copy it."
          : null}
      </p>
    </div>
  )
}
