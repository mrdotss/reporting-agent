import type { RunErrorCode } from "@/lib/db/schema"
import type { ConnectedSubscriptionView } from "@/lib/db/views"

/**
 * The **single** place a connected subscription's displayed state is computed
 * (Requirements 9.8, 13.2, 13.3, 13.9), and the same predicate the enqueue and
 * reaper gates reject from (Requirements 12.6, 13.4).
 *
 * **Pure, and deliberately not `server-only`.** No database, no clock, no
 * environment, no secret: a browser-safe {@link ConnectedSubscriptionView} and
 * an injected `now` in, a state out. The subscriptions screen, the expiry banner
 * and the run screens are the callers that matter most, and some of them are
 * client leaves — so this module has to be importable from one. `lib/db/schema`
 * and `lib/db/views` come in through `import type` only, erased at build time, so
 * naming this module drags neither `drizzle-orm/pg-core` nor a connection into a
 * client bundle.
 *
 * **`now` is a parameter, never `Date.now()`.** Three callers have to agree about
 * the same instant — the banner, the enqueue gate and the reaper — and a function
 * that reads the clock itself cannot be handed the boundary instants that
 * Requirement 13.2's 30-day window is defined by. It is also what makes the
 * precedence table below testable at each step rather than only in the middle.
 *
 * ## Why the expired state has two inputs
 *
 * Requirement 9.6 derives expiry from `secret_expires_at`; Requirement 13.3 also
 * reads `status = 'disabled'` as expired. Both are intentional, and neither is
 * redundant: `secret_expires_at` is **consultant-entered** and can lie, which is
 * exactly why Requirement 13.9 sets `status = 'disabled'` when Azure rejects a
 * credential whose recorded expiry is still in the future. Evidence from Azure
 * outranks a typed-in date, so `disabled` is checked first.
 *
 * That is the whole reason this is one function. Two places computing "is this
 * expired" is how a banner and a gate come to disagree about the same row —
 * a screen offering a rotate button for a subscription the enqueue still accepts,
 * or worse, the reverse.
 */

// --- The warning window -----------------------------------------------------

/**
 * How far ahead of `secret_expires_at` the expiry warning appears
 * (Requirement 13.2).
 *
 * Long enough that a consultant can get a customer to issue a new secret before
 * the current one lapses, which is a conversation with someone else's change
 * process rather than a five-minute task.
 */
export const EXPIRY_WARNING_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

const EXPIRY_WARNING_MS = EXPIRY_WARNING_DAYS * MS_PER_DAY

// --- The state --------------------------------------------------------------

/**
 * The five states, **in precedence order** (see {@link resolveSubscriptionState}).
 *
 * Exported as an ordered tuple because the order *is* the specification: a test
 * walks it, and a reader can see that `disabled` outranks a recorded date
 * without reconstructing the branch order from the function body.
 */
export const SUBSCRIPTION_STATE_KINDS = [
  "disabled",
  "expired",
  "expiring",
  "pending",
  "active",
] as const

export type SubscriptionStateKind = (typeof SUBSCRIPTION_STATE_KINDS)[number]

/**
 * A resolved state.
 *
 * A discriminated union rather than a bare string, because exactly one state
 * carries a number — the whole days remaining that Requirement 13.2's warning
 * must name. Carrying it in the state means a caller cannot render the banner
 * without the count, and cannot compute a count for a state that has none.
 */
export type SubscriptionState =
  /** `status = 'disabled'`: Azure rejected the credential (Requirement 13.9). */
  | { readonly kind: "disabled" }
  /** At or after the recorded `secret_expires_at` (Requirements 9.6, 13.3). */
  | { readonly kind: "expired" }
  /** Inside the 30-day window (Requirement 13.2). */
  | {
      readonly kind: "expiring"
      /** Whole days remaining, `0 … EXPIRY_WARNING_DAYS`. */
      readonly wholeDaysRemaining: number
    }
  /** The preflight never recorded `scope_verified: true` (Requirement 9.6). */
  | { readonly kind: "pending" }
  /** Connected, verified, and not near expiry. */
  | { readonly kind: "active" }

/**
 * Frozen singletons for the four states that carry no data, so a caller cannot
 * mutate a state object and change every later resolution.
 */
const DISABLED: SubscriptionState = Object.freeze({ kind: "disabled" as const })
const EXPIRED: SubscriptionState = Object.freeze({ kind: "expired" as const })
const PENDING: SubscriptionState = Object.freeze({ kind: "pending" as const })
const ACTIVE: SubscriptionState = Object.freeze({ kind: "active" as const })

/**
 * What {@link resolveSubscriptionState} reads: the status and the recorded
 * expiry, and nothing else.
 *
 * A `Pick` rather than the whole view, so the function's inputs are its
 * signature. A full {@link ConnectedSubscriptionView} satisfies it, which is how
 * every UI caller passes one.
 */
export type SubscriptionExpiryFields = Pick<
  ConnectedSubscriptionView,
  "status" | "secretExpiresAt"
>

/**
 * `secretExpiresAt` in epoch milliseconds, or `NaN` if it does not parse.
 *
 * The view's field is an ISO 8601 string produced by `toISOString()` from a
 * `NOT NULL timestamptz`, so in practice it always parses. It is parsed
 * defensively anyway because the failure is handled **closed**: an expiry that
 * cannot be read resolves as expired rather than as usable, so a malformed value
 * blocks a run instead of licensing one. That is the same direction Requirement
 * 13.1's NOT NULL takes — an unknown expiry is indistinguishable from one that
 * has passed, and a passed one produces a clean, fully-verified, empty report.
 */
function expiryMs(view: SubscriptionExpiryFields): number {
  return Date.parse(view.secretExpiresAt)
}

/**
 * The whole days between `now` and an expiry instant, floored, never negative.
 *
 * Floored because Requirement 13.2 says **whole** days remaining: with 29 hours
 * left the honest statement is "1 day", not "2". Rounding up would tell a
 * consultant they have a day they do not have, on the one screen whose job is to
 * prevent exactly that surprise.
 */
export function wholeDaysUntil(expiresAtMs: number, now: Date): number {
  const remaining = expiresAtMs - now.getTime()

  return remaining <= 0 ? 0 : Math.floor(remaining / MS_PER_DAY)
}

/**
 * Resolve the state one subscription is displayed in, at instant `now`.
 *
 * The precedence, which is the design's table read top to bottom and **must not
 * be reordered**:
 *
 * | # | Condition | State |
 * |---|---|---|
 * | 1 | `status === 'disabled'` | `disabled` — Azure's evidence beats a typed-in date |
 * | 2 | `status === 'active'` and `now >= secretExpiresAt` | `expired` |
 * | 3 | `status === 'active'` and `secretExpiresAt - 30d <= now < secretExpiresAt` | `expiring` |
 * | 4 | `status === 'pending'` | `pending` |
 * | 5 | otherwise | `active` |
 *
 * Step 1 comes first because it is the case the recorded date gets wrong: a
 * `disabled` row whose `secret_expires_at` is still months away is precisely
 * what Requirement 13.9 writes, and any ordering that checked the date first
 * would show it as healthy.
 *
 * Steps 2 and 3 are guarded on `status === 'active'` rather than applied to every
 * row, so a `pending` row with a lapsed date reads as `pending` — never
 * preflighted is the more useful thing to say about it, and it is blocked either
 * way.
 *
 * Both comparisons are **at or after**, not after: a row whose expiry equals
 * `now` is expired, and a row exactly 30 days out is already warning.
 */
export function resolveSubscriptionState(
  view: SubscriptionExpiryFields,
  now: Date
): SubscriptionState {
  // 1 — Azure rejected this credential. Highest precedence.
  if (view.status === "disabled") return DISABLED

  if (view.status === "active") {
    const expiresAt = expiryMs(view)
    const nowMs = now.getTime()

    // 2 — at or after the recorded expiry. An unparseable expiry lands here
    //     too, by failing closed: `NaN` comparisons are false, so it is caught
    //     explicitly rather than falling through to `active`.
    if (Number.isNaN(expiresAt) || nowMs >= expiresAt) return EXPIRED

    // 3 — inside the 30-day window.
    if (nowMs >= expiresAt - EXPIRY_WARNING_MS) {
      return Object.freeze({
        kind: "expiring" as const,
        wholeDaysRemaining: wholeDaysUntil(expiresAt, now),
      })
    }
  }

  // 4 — the preflight never passed.
  if (view.status === "pending") return PENDING

  // 5 — connected, verified, not near expiry.
  return ACTIVE
}

// --- The rendered warning ---------------------------------------------------

/**
 * The expiry warning's sentence, named here rather than composed per surface.
 *
 * Requirement 13.2 requires the warning on the subscriptions screen **and** on
 * the run screens for that subscription, and it must name the whole days
 * remaining. Two components composing their own sentence is two places for the
 * count to be phrased — or floored — differently, on screens a consultant reads
 * as one product.
 *
 * "less than a day" for `0`, because "expires in 0 days" reads as a bug, and
 * "expires today" would be a claim about a calendar day this function has no
 * timezone to resolve.
 */
export function expiryWarningText(wholeDaysRemaining: number): string {
  if (wholeDaysRemaining <= 0) {
    return "This client secret expires in less than a day."
  }

  const unit = wholeDaysRemaining === 1 ? "day" : "days"

  return `This client secret expires in ${wholeDaysRemaining} ${unit}.`
}

// --- The gate ---------------------------------------------------------------

/**
 * The two terminal codes a subscription can block a run with.
 *
 * `Extract` from the schema's enum union rather than two loose string literals,
 * so a value renamed in the Postgres enum fails to compile here instead of
 * producing an `error_code` the CHECK constraint rejects at write time.
 */
export type SubscriptionRunBlocker = Extract<
  RunErrorCode,
  "AUTH_EXPIRED" | "SCOPE_UNVERIFIED"
>

/** What {@link subscriptionRunBlocker} reads. */
export type SubscriptionGateFields = SubscriptionExpiryFields &
  Pick<ConnectedSubscriptionView, "scopeVerified">

/**
 * Why this subscription may not start a run at `now`, or `null` if it may
 * (Requirements 12.6, 13.4, 37.9, 39.10).
 *
 * **The gates reuse this rather than re-deriving it**, which is the point: the
 * enqueue rejects before any insert, the reaper rejects at claim, and both
 * decide from the same {@link resolveSubscriptionState} the banner renders from.
 * A gate with its own expiry arithmetic is how a screen warns about a secret the
 * enqueue happily invokes with.
 *
 * The mapping, and why each code:
 *
 *   * `disabled` → `AUTH_EXPIRED`. That status is *written* when Azure rejects
 *     the credential as expired (Requirement 13.9), so the code names the fact
 *     rather than inventing a second one for it.
 *   * `expired` → `AUTH_EXPIRED` (Requirement 13.4).
 *   * `pending` → `SCOPE_UNVERIFIED`. The preflight is the only writer of
 *     `scope_verified: true` (Requirement 12.14), so a row that never left
 *     `pending` never had subscription-scope read proved for it.
 *   * `active` / `expiring` → `SCOPE_UNVERIFIED` if `scopeVerified` is false,
 *     otherwise `null`.
 *
 * **`expiring` is allowed through.** A secret with 3 days left is a working
 * secret, and refusing the run would turn a warning into an outage 30 days early.
 * The banner's job is to make sure the rotation happens before it stops being
 * true.
 *
 * `scopeVerified` is checked last and separately, because it is a different
 * failure with a different remedy: an unverified scope is a role problem the
 * customer fixes, an expired secret is a credential the consultant rotates.
 * Collapsing them would leave the UI unable to say which.
 */
export function subscriptionRunBlocker(
  view: SubscriptionGateFields,
  now: Date
): SubscriptionRunBlocker | null {
  const state = resolveSubscriptionState(view, now)

  switch (state.kind) {
    case "disabled":
    case "expired":
      return "AUTH_EXPIRED"
    case "pending":
      return "SCOPE_UNVERIFIED"
    case "active":
    case "expiring":
      return view.scopeVerified ? null : "SCOPE_UNVERIFIED"
  }
}
