import "server-only"

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

import { resolveEncryptionKey } from "@/lib/crypto"

/**
 * The run-scoped `progress_token` — derived, not minted (Requirements 37.3,
 * 38.5).
 *
 * `import "server-only"` is the first line: this module keys an HMAC from
 * `APP_ENCRYPTION_KEY`, so it is as much a key-handling module as `lib/crypto.ts`
 * is, and the boundary guard's Requirement 6.2 rule fires on the `@/lib/crypto`
 * import above whether or not anybody remembers to list this file.
 *
 * ## The token is a credential, not a correlation id
 *
 * It authorizes writes to the run state machine, so a leaked token lets someone
 * mark a run `completed` — a run that never collected anything would then present
 * as delivered. It therefore gets the session-token treatment throughout: only
 * `sha256(token)` is stored (Requirement 37.3), it travels in a **header** and
 * never in a URL or a body (Requirement 38.2), it is absent from `RunView`
 * (Requirements 37.6, 37.7), and it appears in no event and no log line
 * (Requirement 38.9). `lib/aws/redact.ts` strips it on the way to the browser and
 * the agent registers it with its own redaction guard.
 *
 * ## Why derived rather than randomly minted
 *
 * The process that invokes the runtime is the cron tick — a **different, later
 * HTTP request** than the enqueue that created the run. A random token would have
 * to be recoverable at invoke time, and the only stored form is a hash, which is
 * one-way by design. So the alternatives were:
 *
 *   * **store the token in plaintext** — a database disclosure becomes a
 *     run-hijack, which is exactly what storing a hash exists to prevent;
 *   * **store it encrypted** — a second secret-at-rest path, and the same
 *     disclosure plus the key gives the same hijack, so it buys a module and no
 *     security;
 *   * **mint a fresh token at claim time** — then the token is not
 *     run-scoped-stable, and a retried tick invalidates a callback that is already
 *     in flight from the first invocation.
 *
 * Deriving it means the token is **recomputable from the run id by anybody holding
 * `APP_ENCRYPTION_KEY`** — that is, by the server — and by nobody else. The stored
 * hash is still what authorization compares against, so the database alone yields
 * nothing.
 *
 * The fixed label domain-separates this HMAC from any other use of the same key,
 * so a future `HMAC(key, runId)` for an unrelated purpose cannot produce a value
 * that validates here.
 */

/** The domain-separation label (Requirement 37.3). */
const LABEL = "progress-token"

/** Where the token is presented, and the only place it appears on the wire. */
export const PROGRESS_TOKEN_HEADER = "X-Rpt-Progress-Token"

/**
 * The token for one run: `base64url(HMAC-SHA256(key, "progress-token" || runId))`
 * (Requirement 37.3).
 *
 * The key is resolved **at call time** through `resolveEncryptionKey`, so the same
 * 32 bytes that encrypt the Azure client secret key this HMAC and a key rotated in
 * the environment takes effect without a module reload.
 *
 * One consequence of that sharing worth naming: rotating `APP_ENCRYPTION_KEY`
 * invalidates the tokens of runs already in flight, because their stored hashes
 * were taken over a digest under the old key. Those runs' callbacks are refused
 * and the reaper fails them as `TIMEOUT` — which is the correct outcome for a run
 * whose credentials also just became undecryptable, and is why the two are keyed
 * from the same material rather than from two independently rotatable ones.
 *
 * base64url so the value is safe in a header without quoting, and unpadded so
 * there is no `=` for an intermediary to normalize.
 */
export function deriveProgressToken(runId: string): string {
  return createHmac("sha256", resolveEncryptionKey())
    .update(LABEL + runId, "utf8")
    .digest("base64url")
}

/**
 * `sha256(token)` as lowercase hex — the **only** persisted form
 * (Requirement 37.3).
 *
 * A plain SHA-256 rather than a password hash, for the reason session tokens get
 * the same treatment: the input is 32 bytes of HMAC output, so there is no
 * dictionary to attack and a work factor would buy nothing but latency on a path
 * the agent hits four or five times per run.
 */
export function progressTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/**
 * Does `token` hash to `storedHash` (Requirement 38.5)?
 *
 * Constant-time over the two **digests**, not over the presented strings. Two
 * decisions inside that:
 *
 *   * Comparing digests rather than raw values means the buffers are always 32
 *     bytes, so `timingSafeEqual` can be called at all — it throws on unequal
 *     lengths, and a throw for a wrong-length input is itself a length oracle.
 *   * The stored hash is decoded from hex and its length checked first. A stored
 *     value that is not 64 hex characters cannot be the hash of anything this
 *     module produced, and returning `false` for it fails **closed**: a row whose
 *     `progress_token_hash` was somehow corrupted rejects every callback rather
 *     than accepting one.
 *
 * Returns `false` rather than throwing on every rejection path, because the caller
 * answers a bad token and an unknown run with **one identical response**
 * (Requirement 38.6) and a thrown error would give the two different shapes.
 */
export function validateProgressToken(
  token: string,
  storedHash: string
): boolean {
  if (typeof token !== "string" || token.length === 0) return false
  if (typeof storedHash !== "string") return false

  const stored = Buffer.from(storedHash, "hex")

  // `Buffer.from(_, "hex")` is lenient: it stops at the first non-hex character
  // and silently returns a short buffer. Checking the decoded length is what
  // makes a truncated or non-hex stored value a rejection rather than a
  // comparison against a prefix.
  if (stored.length !== 32) return false

  return timingSafeEqual(Buffer.from(progressTokenHash(token), "hex"), stored)
}
