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
 * The rejection message (Requirement 1.4), carrying the accepted range and
 * nothing drawn from the submitted value — not its content and not its length
 * (Requirement 1.12).
 *
 * A constant rather than a template built at each call site, because
 * `lib/auth/password.ts` raises it as a `PasswordPolicyError` and the register
 * form displays it: two surfaces stating one policy.
 */
export const PASSWORD_POLICY_MESSAGE =
  `A password must be at least ${PASSWORD_MIN} and at most ` +
  `${PASSWORD_MAX} characters. Its value and length are excluded from ` +
  `this message.`

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
 * exists to avoid, so the policy is applied through the predicate instead — one
 * implementation, used by the schema, by the hasher and by any hint the form
 * renders. Trimming would change the credential rather than validate it.
 *
 * Parsing `unknown` rather than `string`, because that is what a `FormData`
 * entry or a JSON body actually is at the boundary.
 */
export const passwordSchema = z
  .string({ error: PASSWORD_POLICY_MESSAGE })
  .refine(isPasswordWithinPolicy, { error: PASSWORD_POLICY_MESSAGE })
