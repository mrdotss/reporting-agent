import "server-only"

import {
  argon2id,
  hash as argon2Hash,
  verify as argon2Verify,
  type HashOptions,
} from "argon2"

import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  PASSWORD_POLICY_MESSAGE,
  isPasswordWithinPolicy,
} from "@/lib/validation/password"

/**
 * Password storage and verification (Requirement 1).
 *
 * Three operations, and the third exists only for its cost: hash a new
 * password, verify a submitted one against a stored hash, and burn one
 * verification's worth of work when there is no stored hash to verify against.
 *
 * Nothing here logs, returns or embeds a submitted password or a stored hash —
 * not in a success path, not in an error message (Requirement 1.12). The one
 * error this module raises carries the accepted length range and nothing drawn
 * from the value that violated it.
 */

/**
 * argon2id, at a memory cost of 19456 KiB (19 MiB), 2 iterations and a
 * parallelism of 1 (Requirements 1.2, 1.10). `hashLength` and the salt are the
 * library's defaults: 32 bytes each, a fresh random salt per hash.
 *
 * The annotation is load-bearing. Without it TypeScript widens `type` to
 * `number`, which `HashOptions` does not accept.
 */
const ARGON2: HashOptions = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
}

/**
 * A fixed, valid argon2id hash carrying exactly the {@link ARGON2} parameters,
 * for {@link burnDecoyVerification} to verify against (Requirement 1.11).
 *
 * Generated once with this same package over 32 random bytes that were never
 * recorded, so no password verifies against it and there is no preimage to
 * leak. It is a literal rather than a value computed at module load: computing
 * it would cost a hash on every cold start, and a decoy whose parameters drift
 * from `ARGON2` reintroduces as a cost difference the timing difference it
 * exists to hide.
 *
 * The parameter order here is `m,p,t` because that is the order this library
 * emits and re-parses; `design.md` writes the same three parameters as
 * `m=19456,t=2,p=1`. Both parse, and the values are identical.
 */
const DECOY_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$Hc4TaNSqED+3/gBs5a7oRQ$m2ddX68xpid8909VDAvsSOmPK9aAK99AKpvCoqy0crI"

/**
 * The accepted password length, in **Unicode code points** (Requirement 1.3),
 * declared in `lib/validation/password.ts` and re-exported here.
 *
 * The policy lives in the pure module because the register form and every
 * boundary schema need it and neither may import this one — this module is
 * `server-only`. Re-exporting keeps `PASSWORD_MIN` and `PASSWORD_MAX` available
 * from `@/lib/auth/password`, where a caller reaching for the hasher expects
 * them, while there is only one place the numbers are written down.
 */
export { PASSWORD_MAX, PASSWORD_MIN }

/** A submitted password falls outside the accepted length range. */
export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PasswordPolicyError"
  }
}

/**
 * Hash a password for storage in `users.password_hash`.
 *
 * The password is hashed **exactly as submitted**, including any leading or
 * trailing whitespace (Requirement 1.1). Trimming here would silently change
 * the credential: the user would register one secret and authenticate with
 * another, and the difference would only surface on a client that submits
 * whitespace differently.
 *
 * Throws {@link PasswordPolicyError} outside the accepted length range,
 * stating that range (Requirement 1.4). The message never carries the
 * submitted value or its length (Requirement 1.12).
 */
export async function hashPassword(plaintext: string): Promise<string> {
  // The same predicate and the same message the boundary schema applies, so a
  // submission the form accepted cannot be one the hasher refuses.
  if (!isPasswordWithinPolicy(plaintext)) {
    throw new PasswordPolicyError(PASSWORD_POLICY_MESSAGE)
  }

  const encoded: string = await argon2Hash(plaintext, ARGON2)
  return encoded
}

/**
 * Verify a submitted password against a stored hash, returning a boolean
 * (Requirement 1.5).
 *
 * A malformed stored hash resolves to `false` rather than raising
 * (Requirement 1.6). The library throws on an unparseable digest, and letting
 * that reach the caller would turn one corrupted row into a 500 that is
 * distinguishable — to anyone watching — from an ordinary wrong password. A
 * hash that cannot be parsed cannot be matched, so `false` is both the safe
 * answer and the honest one.
 *
 * The caught error is discarded rather than logged: it embeds the digest
 * (Requirement 1.12). The caller's own generic invalid-credentials outcome is
 * what surfaces.
 */
export async function verifyPassword(
  hash: string,
  plaintext: string
): Promise<boolean> {
  try {
    return await argon2Verify(hash, plaintext)
  } catch {
    return false
  }
}

/**
 * Spend one argon2id verification against {@link DECOY_HASH} and discard the
 * result (Requirement 1.11).
 *
 * Called on the unmatched-email path, where there is no stored hash to verify
 * against. Without it, "no such user" returns in microseconds while "wrong
 * password" costs a full argon2 verification, and the difference is an oracle
 * for which emails are registered — the generic outcome required by
 * Requirements 1.7 and 1.8 would be undone by the clock.
 *
 * It routes through {@link verifyPassword} deliberately: the unmatched-email
 * path and the failed-verification path are then the *same code*, not two paths
 * tuned to cost the same. It resolves rather than throwing, for the same
 * reason — a raised error on one path and a returned `false` on the other is
 * the distinction this function exists to erase.
 */
export async function burnDecoyVerification(plaintext: string): Promise<void> {
  await verifyPassword(DECOY_HASH, plaintext)
}
