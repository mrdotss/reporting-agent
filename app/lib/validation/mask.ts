/**
 * Masking for values that reach the browser (Requirement 10.4).
 *
 * **Pure, and deliberately not `server-only`.** `lib/db/views.ts` imports this
 * and re-exports {@link maskSubscriptionId} so the projection's public surface
 * is unchanged, and so there is exactly **one** masking implementation: a
 * second one is how "all but the last 4" ends up meaning two different things
 * in the projection and in a component that formats an id for display.
 */

/**
 * Never a character an Azure subscription GUID can contain, so a masked
 * position is unambiguous, and never `-`, which a GUID *does* contain and which
 * would therefore read as a revealed separator.
 */
export const SUBSCRIPTION_ID_MASK_CHAR = "*"

/** How many trailing characters a masked subscription id may reveal. */
export const SUBSCRIPTION_ID_VISIBLE_CHARS = 4

/**
 * Mask every character of a subscription id other than its final 4, and mask
 * **every** character of an id of length 4 or fewer (Requirement 10.4).
 *
 * The second clause is the whole reason this is a function rather than a
 * `slice`: an "all but the last 4" rule publishes a 4-character id whole, and a
 * 1-character id whole. The short-id case is the one an off-by-one gets wrong,
 * and it is the one where getting it wrong discloses everything.
 *
 * Length is counted in **code points**, not UTF-16 code units, so a surrogate
 * pair is masked or revealed as one character. Slicing by code unit could cut a
 * pair in half and emit a lone surrogate — a mangled string that no longer
 * corresponds to any part of the input.
 *
 * Pure: no I/O, no clock, no environment. The output's code-point length always
 * equals the input's.
 */
export function maskSubscriptionId(id: string): string {
  const characters = Array.from(id)

  if (characters.length <= SUBSCRIPTION_ID_VISIBLE_CHARS) {
    return SUBSCRIPTION_ID_MASK_CHAR.repeat(characters.length)
  }

  const maskedCount = characters.length - SUBSCRIPTION_ID_VISIBLE_CHARS

  return (
    SUBSCRIPTION_ID_MASK_CHAR.repeat(maskedCount) +
    characters.slice(maskedCount).join("")
  )
}
