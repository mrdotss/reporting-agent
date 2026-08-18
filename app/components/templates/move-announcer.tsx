"use client"

/**
 * The composer's **single** `aria-live="polite"` region (Requirements 12.5,
 * 12.12, 12.14).
 *
 * ## One region, and why that is load-bearing rather than tidy
 *
 * Requirement 12.5 requires **exactly one announcement per completed move**. A
 * screen reader announces the content of every live region that changes, so two
 * regions that both update on a move produce two announcements — and the second
 * one, arriving while the first is still being spoken, is the thing that makes a
 * screen reader user turn the feature off. Keeping one region in one component
 * makes "exactly one" a fact about the tree rather than a rule three components
 * have to keep.
 *
 * The same region carries the **refusals** (Requirements 12.12, 12.14): a nudge
 * at the first position, and a keyboard move that would nest a row in a row.
 * That is deliberate — a refusal is the outcome of an attempted move, and
 * routing it to a different region would mean a keyboard user hears successes
 * from one place and silences from another. Requirement 12.14 exists precisely
 * because the pointer user *sees* that refusal and the keyboard user must be
 * *told* it.
 *
 * ## `polite`, never `assertive`
 *
 * Both requirements name `polite`, and it is the right level: a reorder is the
 * consultant's own action completing, not an interruption. `assertive` would cut
 * off whatever the reader was mid-way through — which, during a run of arrow
 * presses, is the announcement of the previous move.
 *
 * ## Why the message is rendered rather than composed here
 *
 * `lib/templates/composer.ts` produces both the success `announcement` and the
 * `Refusal.message`, and this component prints what it is given. A composer that
 * built its own sentence would be a second place where "position 2 of 4" is
 * phrased, and the reducer's own tests would stop covering what the user hears.
 *
 * ## The empty render
 *
 * The region is always in the DOM and starts empty. A live region added to the
 * page at the moment it has something to say is frequently not announced at all
 * — the assistive technology has to be observing it *before* the change — which
 * is the most common way a correct-looking implementation of this requirement
 * announces nothing.
 */
export function MoveAnnouncer({
  message,
}: Readonly<{
  /** The reducer's `announcement`, or a `Refusal.message`. `""` when idle. */
  message: string
}>) {
  return (
    <div
      data-slot="move-announcer"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      // Visually hidden rather than `display: none`: a hidden region is not
      // announced, and this text is for the reader alone — the pointer user
      // already sees the block move.
      className="sr-only"
    >
      {message}
    </div>
  )
}
