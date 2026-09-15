import { z } from "zod"

/**
 * The password policy (Requirements 1.3, 1.4, 7.7).
 *
 * **This module owns the policy, and `lib/auth/password.ts` imports it.** The
 * direction matters: the hashing module is `server-only` because it holds
 * argon2 and a decoy digest, so a pure boundary schema cannot import from it,
 * and the register form cannot name it at all. Declaring the bounds here and
 * re-exporting them there leaves exactly one definition of "12 to 256" —
 * the alternative is two constants that agree until one of them is edited.
 */

/**
 * The accepted password length, in **Unicode code points** (Requirement 1.3).
 *
 * Code points, not UTF-16 code units. `"👍".length` is 2, so a 12-emoji
 * passphrase measured by `.length` counts as 24 characters — and, worse, an
 * 11-emoji one counts as 22 and passes a `>= 12` check it should fail.
 */
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 256

/**
 * The rejection a sign-up form shows, one per bound (Requirement 1.4;
 * roles-and-ask-access Req 8).
 *
 * Split by bound, because a single "at least 12 and at most 256" sentence
 * answered a short password with a limit it had not broken, and the sign-up
 * form was reported as asking for hundreds of characters. Each message says
 * what to change and carries nothing drawn from the submitted value — not its
 * content and not its length (Requirement 1.12).
 */
export const PASSWORD_TOO_SHORT_MESSAGE = `Use at least ${PASSWORD_MIN} characters.`
export const PASSWORD_TOO_LONG_MESSAGE = `Use at most ${PASSWORD_MAX} characters.`

/**
 * The policy as a whole, for a caller that is not answering a form —
 * `lib/auth/password.ts` raises it as a `PasswordPolicyError`.
 */
export const PASSWORD_POLICY_MESSAGE =
  `Use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`

/**
 * Length in Unicode code points. The spread iterates the string by code point,
 * where `.length` counts UTF-16 units.
 */
export function passwordCodePointLength(value: string): number {
  return [...value].length
}

/**
 * Whether a submitted password is within the accepted length range
 * (Requirement 1.3).
 *
 * Measures the value **exactly as submitted**, with no trimming: a password is
 * hashed as submitted (Requirement 1.1), so a policy that measured a trimmed
 * form would accept a credential the hasher then refuses — or, worse, silently
 * change which secret was registered.
 *
 * Pure and total: no I/O, no clock, and defined for every string including the
 * empty one.
 */
export function isPasswordWithinPolicy(value: string): boolean {
  const length = passwordCodePointLength(value)

  return length >= PASSWORD_MIN && length <= PASSWORD_MAX
}

/**
 * The boundary schema (Requirement 7.7).
 *
 * **No `.min()` / `.max()`, and no `.trim()`.** Zod's string length checks count
 * UTF-16 units, which is the exact miscount {@link passwordCodePointLength}
 * exists to avoid, so each bound is its own refinement over code points. The two
 * cannot both fail, so a rejected password carries exactly one message — the
 * bound it broke. Trimming would change the credential rather than validate it.
 *
 * Parsing `unknown` rather than `string`, because that is what a `FormData`
 * entry or a JSON body actually is at the boundary; a missing field is answered
 * as a short password.
 */
export const passwordSchema = z
  .string({ error: PASSWORD_TOO_SHORT_MESSAGE })
  .refine((value) => passwordCodePointLength(value) >= PASSWORD_MIN, {
    error: PASSWORD_TOO_SHORT_MESSAGE,
  })
  .refine((value) => passwordCodePointLength(value) <= PASSWORD_MAX, {
    error: PASSWORD_TOO_LONG_MESSAGE,
  })
