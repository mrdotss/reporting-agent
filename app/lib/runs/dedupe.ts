import { createHash } from "node:crypto"

/**
 * `report_runs.dedupe_key` — derived, never random (Requirement 37.1).
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no clock, no environment,
 * no secret: the inputs go in as arguments, including the enqueue instant, and a
 * hex digest comes out. It reads the clock nowhere, which is what makes the
 * 60-second bucket's two boundaries assertable at instants a test picks rather
 * than only at "now".
 *
 * ## What the key is for
 *
 * `dedupe_key` is UNIQUE, so it is the idempotency guard: a double-submitted form
 * or a retried cron tick cannot produce two runs against one subscription and
 * period. The second insert is rejected by the database and the enqueue returns
 * the **existing** run (Requirement 37.5). That is why there is no random
 * component — a random suffix would make every key unique and the constraint
 * decorative — and why the derivation is a function rather than a value the caller
 * composes: two call sites joining the same fields in a different order is how a
 * resubmission stops being caught.
 *
 * ## The 60-second bucket
 *
 * The enqueue instant is floored to a 60-second boundary and folded in. Without
 * it the key would be a function of the *request* and every submission would be
 * distinct; with an unbounded window a deliberate re-run of the same month would
 * be impossible. Sixty seconds is the span in which two submissions are the same
 * intent — a double-clicked button, a retried tick, a browser replaying a POST —
 * and a minute later is long enough to mean it.
 *
 * The floor is applied to the instant, not to a formatted string, so a request at
 * `10:00:59.999` and one at `10:00:00.001` land in the same bucket and one at
 * `10:01:00.000` does not.
 *
 * ## The unit separator
 *
 * Fields are joined with `U+001F` (INFORMATION SEPARATOR ONE), which cannot occur
 * in an id, a date, an IANA zone name, an Azure resource type or a resource group
 * name. A comma or a colon could: two resource groups named `a` and `b,c` would
 * join to the same string as `a,b` and `c`, and the two submissions would collide
 * on a key that means different things. The separator is the only thing standing
 * between "distinct requests, distinct keys" and a silent aliasing bug, so it is
 * chosen to be unrepresentable in the inputs rather than merely unlikely.
 *
 * The resource type and resource group lists are joined internally with `,` after
 * being sorted, which is safe for the same reason at one level down only because
 * the outer separator is what delimits the *fields* — and it is why the lists are
 * sorted rather than deduplicated: two submissions differing only in the order
 * they listed the same types are one intent (Requirement 37.1), while a repeated
 * entry is a different request body and is allowed to derive a different key.
 */

/** `U+001F`, INFORMATION SEPARATOR ONE — see the module docstring. */
const UNIT_SEPARATOR = "\u001f"

/** The derivation's version label, so a future change is a new namespace. */
const VERSION = "v1"

/** The bucket width, in milliseconds (Requirement 37.1). */
export const DEDUPE_BUCKET_MS = 60_000

/** What one run's identity is derived from. */
export type DedupeKeyInput = {
  readonly userId: string
  readonly connectedSubscriptionId: string
  /** `YYYY-MM-DD`, a local calendar date in `timezone`. */
  readonly periodStart: string
  readonly periodEnd: string
  readonly timezone: string
  readonly resourceTypes: readonly string[]
  readonly resourceGroups: readonly string[]
  /** The enqueue instant, in epoch milliseconds. */
  readonly enqueuedAtMs: number
}

/**
 * The 60-second bucket an instant falls in, as whole seconds since the epoch.
 *
 * Exported for its own test: the bucket edge is the one boundary where a
 * plausible implementation is wrong in a way nothing else notices, and
 * `Math.floor` on a negative millisecond value — an instant before 1970, which a
 * test will generate even though a deployment will not — rounds *away* from zero,
 * which is the behaviour that keeps buckets contiguous rather than doubling the
 * one straddling the epoch.
 */
export function dedupeBucketSeconds(instantMs: number): number {
  return Math.floor(instantMs / DEDUPE_BUCKET_MS) * (DEDUPE_BUCKET_MS / 1000)
}

/**
 * The `dedupe_key` for one submission (Requirement 37.1).
 *
 * A SHA-256 hex digest rather than the joined string itself: the inputs include a
 * customer-chosen resource group name and an unbounded list of resource types, so
 * the joined form has no length bound, and `dedupe_key` is a UNIQUE indexed
 * column. Hashing also means the column discloses nothing about the scope to
 * anybody reading the table, which matters slightly less than the length but is
 * free.
 *
 * Deterministic and drawing no random value, so the same submission inside one
 * bucket derives the same key on any machine in any process.
 */
export function deriveDedupeKey(input: DedupeKeyInput): string {
  const fields = [
    VERSION,
    input.userId,
    input.connectedSubscriptionId,
    input.periodStart,
    input.periodEnd,
    input.timezone,
    [...input.resourceTypes].sort().join(","),
    [...input.resourceGroups].sort().join(","),
    String(dedupeBucketSeconds(input.enqueuedAtMs)),
  ]

  return createHash("sha256")
    .update(fields.join(UNIT_SEPARATOR), "utf8")
    .digest("hex")
}
