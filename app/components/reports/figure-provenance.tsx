"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"

import { CopyDigest } from "@/components/reports/copy-digest"

/**
 * The provenance reveal — hover **or** focus, identical content (Requirement 38).
 *
 * ## The two paths must not diverge, so there is only one
 *
 * Requirement 38.4 requires the same `snapshot_path` and the same estimator
 * label "for a keyboard focus as for a pointer hover". The cheapest way to hold
 * that is for both events to set the same piece of state and for the reveal to
 * be rendered once — which is what this does. A tooltip library with a separate
 * focus path is how the two come to show different things, usually because the
 * focus path was added later and tested less.
 *
 * ## The reveal is the figure's accessible description, not only a popup
 *
 * Requirement 38.7: an assistive technology must announce the provenance
 * "without a pointer event". A visually-positioned tooltip does not do that on
 * its own — a screen reader reading the document flow would encounter the
 * number and move on. So the reveal's content is wired to the figure through
 * `aria-describedby`, and it is in the DOM whether or not it is visible.
 *
 * That is why the hidden state is `sr-only` rather than `display: none`:
 * `aria-describedby` pointing at a `display: none` element is not announced by
 * several readers, so hiding it that way would satisfy the visual requirement
 * and silently fail the one that matters here.
 *
 * ## Escape dismisses, and that is not the same as blur
 *
 * Requirement 38.4 names three dismissals: pointer-out, blur, and Escape. Escape
 * is separate because a keyboard user reading the provenance wants to dismiss it
 * **without losing their place** — blurring the figure to close the reveal would
 * cost them the position they navigated to. So Escape hides the reveal and
 * leaves focus where it is.
 *
 * ## Nothing here composes a label
 *
 * Requirement 38.3: the estimator label is rendered "character-for-character",
 * this component composes "no percentile label and no estimator label of its
 * own", and displays "no bare percentile designation". So `estimator` is printed
 * exactly as the ledger recorded it, and there is no branch that builds a string
 * like `p95 (hourly)` — the agent already built it, and the reason it did is
 * that a percentile over hourly buckets is not a p95 of the minute samples and
 * only the collector knows which it was.
 */

export type FigureProvenance = {
  readonly snapshotPath: string
  /**
   * The ledger's own label, or `null` where the figure is exact.
   *
   * `null` rather than an empty string, because Requirement 38.3 forbids
   * displaying a caveat for a value that is not an estimate — and `""` is a
   * value a careless `?` would render as an empty caveat block.
   */
  readonly estimator: string | null
}

export function FigureProvenance({
  formatted,
  provenance,
}: Readonly<{
  /** The ledger's `formatted` string, presented unchanged (Requirements 38.1, 38.8). */
  formatted: string
  /**
   * The resolved provenance, or `null` when the ledger entry is absent or an
   * estimated figure carries no label (Requirement 38.8).
   */
  provenance: FigureProvenance | null
}>) {
  const [revealed, setRevealed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const describedById = useId()
  const ref = useRef<HTMLSpanElement>(null)

  const show = useCallback(() => {
    setDismissed(false)
    setRevealed(true)
  }, [])

  const hide = useCallback(() => setRevealed(false), [])

  // Escape hides the reveal and **keeps focus**, so a keyboard reader does not
  // lose the position they navigated to (Requirement 38.4).
  useEffect(() => {
    if (!revealed) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setRevealed(false)
      setDismissed(true)
    }

    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [revealed])

  const open = revealed && !dismissed

  return (
    <span
      data-slot="figure"
      className="relative inline-block"
      onPointerEnter={show}
      onPointerLeave={hide}
    >
      <span
        ref={ref}
        // Requirement 38.6 — every figure reachable by sequential keyboard
        // navigation, in the emitter's document order, with a visible `--ring`.
        tabIndex={0}
        // Requirement 38.7 — the provenance is this figure's accessible
        // description, so it is announced with no pointer event involved.
        aria-describedby={describedById}
        onFocus={show}
        onBlur={hide}
        // Requirement 38.1 — the ledger's `formatted` string, unchanged, in the
        // mono face with tabular numerals. No `toLocaleString` anywhere near it:
        // the verifier compares the string that was printed, and a locale that
        // regrouped it would make a correct document unverifiable.
        className="rpt-figure rounded-sm font-mono tabular-nums focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
      >
        {formatted}
      </span>

      <span
        id={describedById}
        data-slot="figure-provenance"
        data-open={open ? "true" : "false"}
        // `sr-only` when closed rather than unmounted or `display: none`: an
        // `aria-describedby` target that is not in the accessibility tree is not
        // announced, which would satisfy the visual requirement and fail 38.7.
        className={
          open
            ? "absolute top-full left-0 z-20 mt-1 flex w-max max-w-xs flex-col gap-1 rounded-lg border border-border bg-background px-2.5 py-2 shadow-md"
            : "sr-only"
        }
      >
        {provenance === null ? (
          // Requirement 38.8 — an indication that provenance is unavailable,
          // with nothing composed to fill the gap. The figure above still shows
          // its `formatted` string unchanged.
          <span className="text-xs text-muted-foreground">
            Provenance unavailable for this figure.
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Snapshot path</span>
              <CopyDigest
                value={provenance.snapshotPath}
                label="snapshot path"
                truncate={false}
              />
            </span>

            {/*
              Requirement 38.3 — shown only where the figure is estimated, and
              printed character-for-character. No branch here builds a label.
            */}
            {provenance.estimator === null ? null : (
              <span className="text-xs text-muted-foreground">
                <span className="font-mono">{provenance.estimator}</span>
              </span>
            )}
          </>
        )}
      </span>
    </span>
  )
}
