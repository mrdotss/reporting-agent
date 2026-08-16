import { z } from "zod"

/**
 * Email normalization and the boundary schema (Requirements 7.3, 7.7, 7.11).
 *
 * **Pure, and deliberately not `server-only`.** The same rule has to hold in a
 * server action, in a route handler and in a client-side field hint, and a
 * policy the browser cannot name is a policy the form re-implements slightly
 * differently.
 */

/**
 * The maximum length of a normalized address, from RFC 5321's 254-character
 * bound on a forward path (Requirement 7.11).
 *
 * Measured on the **normalized** form, so surrounding whitespace does not count
 * toward it — `"  a@b.co  "` is a 10-character address, not a 14-character one.
 */
export const EMAIL_MAX_LENGTH = 254

/**
 * The rejection message. States the accepted **format and length** as
 * Requirement 7.11 demands, and carries nothing drawn from the value that
 * violated it — an email is personal data, and a validation message is a thing
 * that ends up in a log line.
 *
 * One message for both the format failure and the length failure, on purpose:
 * they are the same answer to the visitor ("this is not an address we can
 * store"), and a length-specific message on a 300-character submission tells an
 * enumerator which of the two gates they hit.
 */
export const EMAIL_POLICY_MESSAGE =
  `Enter an email address in the form name@example.com, ` +
  `at most ${EMAIL_MAX_LENGTH} characters.`

/**
 * Trim surrounding whitespace and lower-case (Requirement 7.3).
 *
 * This is the form stored in `users.email_normalized` under its UNIQUE
 * constraint, and the form every lookup and every `login_attempts` row keys on.
 * `users.email` keeps the submission as entered; only this side is normalized,
 * which is what makes `"Ada@Example.com "` and `"ada@example.com"` one account.
 *
 * `toLowerCase`, never `toLocaleLowerCase`: the locale-sensitive form maps
 * `"I"` to a dotless `"ı"` under a Turkish locale, so the same address would
 * normalize to two different strings depending on the server's locale — and one
 * of them would not match the row that was written by the other.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * The boundary schema (Requirement 7.7): normalize first, then check format and
 * length on the normalized form.
 *
 * The order is the requirement. Validating before trimming would reject
 * `"  ada@example.com"` for its format, and measuring length before trimming
 * would measure whitespace the stored value will not contain — so the schema
 * transforms and only then pipes into the checks, and its **output** is the
 * value that is safe to store.
 *
 * `z.email()` rather than a hand-written pattern: an email regex is a famous
 * way to reject a valid address, and Requirement 7.11 names the schema's own
 * format check as the gate. Both checks carry {@link EMAIL_POLICY_MESSAGE}, so
 * the caller surfaces one message without inspecting which issue fired.
 *
 * Parsing `unknown` rather than `string`, because that is what a `FormData`
 * entry or a JSON body actually is at the boundary — a non-string arrives here
 * as an ordinary rejection instead of an `as string` that typechecks and lies.
 */
export const emailSchema = z
  .string({ error: EMAIL_POLICY_MESSAGE })
  .transform(normalizeEmail)
  .pipe(
    z
      .email({ error: EMAIL_POLICY_MESSAGE })
      .max(EMAIL_MAX_LENGTH, { error: EMAIL_POLICY_MESSAGE })
  )
