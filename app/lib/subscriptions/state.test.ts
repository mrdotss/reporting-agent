import { describe, expect, test } from "vitest"

import type { ConnectedSubscriptionView } from "@/lib/db/views"
import {
  EXPIRY_WARNING_DAYS,
  expiryWarningText,
  resolveSubscriptionState,
  SUBSCRIPTION_STATE_KINDS,
  subscriptionRunBlocker,
  wholeDaysUntil,
  type SubscriptionStateKind,
} from "@/lib/subscriptions/state"

/**
 * `lib/subscriptions/state.ts` — the precedence table, the 30-day boundary, the
 * injected clock, the day arithmetic and the gate the enqueue and the reaper share
 * (Requirements 12.6, 13.2, 13.3, 13.4, 13.9).
 *
 * **How this file is split, because it was written by two tasks.** Everything down
 * to the gate describe is task 8.2's: that the function reads **no** clock of its
 * own, that the day count floors rather than rounds, and that
 * `subscriptionRunBlocker` maps every state to the terminal code the gates are
 * required to fail with rather than deriving expiry a second time. The final two
 * describes are task 8.8's, and they cover what 8.2 left: the precedence table one
 * case per step — including a `disabled` row whose recorded expiry is still in the
 * future — the 30-day boundary, and the whole-days-remaining sentence read off the
 * resolved state.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** A fixed instant, so every assertion below is expressed relative to one now. */
const NOW = new Date("2026-07-15T09:00:00.000Z")

/**
 * A view carrying only what the state functions read. Built from
 * `ConnectedSubscriptionView` so a field renamed in the projection breaks this
 * file at compile time rather than at assertion time.
 */
function view(
  overrides: Partial<ConnectedSubscriptionView> = {}
): ConnectedSubscriptionView {
  return {
    id: "sub-1",
    displayName: "Northwind production",
    maskedSubscriptionId: "********-****-****-****-********3301",
    scopeVerified: true,
    secretExpiresAt: new Date(NOW.getTime() + 365 * DAY_MS).toISOString(),
    fidelityTier: "baseline",
    status: "active",
    ...overrides,
  }
}

/** An `active` row whose secret expires `days` from {@link NOW}. */
function expiringIn(days: number): ConnectedSubscriptionView {
  return view({
    status: "active",
    secretExpiresAt: new Date(NOW.getTime() + days * DAY_MS).toISOString(),
  })
}

describe("resolveSubscriptionState reads only the injected now", () => {
  test("one row resolves differently at two instants", () => {
    // The claim that makes this function usable by three callers at once: the
    // banner, the enqueue gate and the reaper each hand it their own instant, and
    // a `Date.now()` inside would make the row's state a fact about when it was
    // asked rather than about the instant asked for.
    const row = view({
      status: "active",
      secretExpiresAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
    })

    // 17 days out — inside the 30-day window.
    expect(resolveSubscriptionState(row, NOW).kind).toBe("expiring")

    // 47 days earlier, so the same row is comfortably in date.
    expect(
      resolveSubscriptionState(row, new Date("2026-05-29T00:00:00.000Z")).kind
    ).toBe("active")

    // A minute after the recorded expiry.
    expect(
      resolveSubscriptionState(row, new Date("2026-08-01T00:01:00.000Z")).kind
    ).toBe("expired")
  })

  test("the same arguments resolve identically however often they are asked", () => {
    const row = expiringIn(9)

    expect(resolveSubscriptionState(row, NOW)).toStrictEqual(
      resolveSubscriptionState(row, NOW)
    )
  })

  test("the returned state cannot be mutated into another row's answer", () => {
    // The no-data states are shared frozen singletons, so a caller that assigned
    // to one would change every later resolution in the process.
    const first = resolveSubscriptionState(view({ status: "pending" }), NOW)

    expect(Object.isFrozen(first)).toBe(true)
    expect(() => {
      // @ts-expect-error — the union's `kind` is readonly; this asserts the
      // runtime freeze, not the type.
      first.kind = "active"
    }).toThrow(TypeError)

    expect(
      resolveSubscriptionState(view({ status: "pending" }), NOW).kind
    ).toBe("pending")
  })

  test("an unparseable recorded expiry fails closed", () => {
    // The projection always produces `toISOString()` output, so this is defensive
    // — but the direction is the assertion. An expiry that cannot be read must
    // block a run, not license one: an unknown expiry is indistinguishable from
    // one that has passed, and a passed one produces a clean, fully verified,
    // empty report.
    const row = view({ status: "active", secretExpiresAt: "not-a-date" })

    expect(resolveSubscriptionState(row, NOW).kind).toBe("expired")
    expect(subscriptionRunBlocker(row, NOW)).toBe("AUTH_EXPIRED")
  })
})

describe("wholeDaysUntil floors", () => {
  test.each([
    ["exactly one day", DAY_MS, 1],
    ["one day and 23 hours", DAY_MS + 23 * 60 * 60 * 1000, 1],
    ["two days less a second", 2 * DAY_MS - 1000, 1],
    ["under a day", 60 * 1000, 0],
    ["the expiry instant itself", 0, 0],
    ["already past", -5 * DAY_MS, 0],
  ] as const)("%s → %i", (_label, offsetMs, expected) => {
    // Floored, because "whole days remaining" is what Requirement 13.2 says.
    // Rounding up tells a consultant they have a day they do not have, on the one
    // screen whose whole job is to prevent that surprise.
    expect(wholeDaysUntil(NOW.getTime() + offsetMs, NOW)).toBe(expected)
  })
})

describe("expiryWarningText", () => {
  test("singular, plural, and less than a day", () => {
    // One sentence, named once: Requirement 13.2 puts this warning on the
    // subscriptions screen and on every run screen for the subscription, and two
    // components composing their own phrasing is two places for the count to be
    // worded — or floored — differently.
    expect(expiryWarningText(1)).toContain("1 day.")
    expect(expiryWarningText(EXPIRY_WARNING_DAYS)).toContain(
      `${EXPIRY_WARNING_DAYS} days.`
    )
    expect(expiryWarningText(0)).toContain("less than a day")
    expect(expiryWarningText(-3)).toBe(expiryWarningText(0))
  })
})

describe("subscriptionRunBlocker — the gate the enqueue and the reaper share", () => {
  test("Requirement 13.9 — a disabled row is AUTH_EXPIRED even with a future expiry", () => {
    // The case that decides the mapping: Azure rejected this credential, and the
    // recorded date — consultant-entered, and able to lie — still says a year.
    const row = view({ status: "disabled", scopeVerified: true })

    expect(resolveSubscriptionState(row, NOW).kind).toBe("disabled")
    expect(subscriptionRunBlocker(row, NOW)).toBe("AUTH_EXPIRED")
  })

  test("Requirement 13.4 — a lapsed recorded expiry is AUTH_EXPIRED", () => {
    expect(subscriptionRunBlocker(expiringIn(-1), NOW)).toBe("AUTH_EXPIRED")

    // At the instant itself, not merely after it.
    expect(subscriptionRunBlocker(expiringIn(0), NOW)).toBe("AUTH_EXPIRED")
  })

  test("Requirement 12.6 — a pending row is SCOPE_UNVERIFIED", () => {
    // The preflight is the only writer of `scope_verified: true`, so a row that
    // never left `pending` never had subscription-scope read proved for it — a
    // different failure from an expired secret, with a different remedy.
    expect(
      subscriptionRunBlocker(
        view({ status: "pending", scopeVerified: false }),
        NOW
      )
    ).toBe("SCOPE_UNVERIFIED")
  })

  test("Requirement 12.6 — an active row with scopeVerified false is SCOPE_UNVERIFIED", () => {
    // The store cannot produce this combination — `status` is derived from the
    // preflight result — so this is the belt for a row written by anything else.
    expect(
      subscriptionRunBlocker(
        view({ status: "active", scopeVerified: false }),
        NOW
      )
    ).toBe("SCOPE_UNVERIFIED")
  })

  test("an expiring secret is still a working secret", () => {
    // Refusing a run 30 days early would turn the warning into an outage. The
    // banner's job is to get the rotation done while this is still true.
    const row = expiringIn(3)

    expect(resolveSubscriptionState(row, NOW).kind).toBe("expiring")
    expect(subscriptionRunBlocker(row, NOW)).toBeNull()
  })

  test("a verified, in-date subscription is not blocked", () => {
    expect(subscriptionRunBlocker(view(), NOW)).toBeNull()
  })

  test("the gate agrees with the state it is derived from", () => {
    // The reuse claim, asserted rather than assumed: every row the gate lets
    // through resolves to a state the UI renders as usable, and every row it
    // blocks resolves to one the UI renders with a rotate or a reconnect CTA. A
    // gate with its own expiry arithmetic is how a screen warns about a secret
    // the enqueue happily invokes with.
    const rows: readonly ConnectedSubscriptionView[] = [
      view({ status: "disabled" }),
      expiringIn(-10),
      expiringIn(0),
      expiringIn(1),
      expiringIn(EXPIRY_WARNING_DAYS),
      expiringIn(EXPIRY_WARNING_DAYS + 1),
      view({ status: "pending", scopeVerified: false }),
      view({ status: "active", scopeVerified: false }),
    ]

    for (const row of rows) {
      const state = resolveSubscriptionState(row, NOW)
      const usable =
        (state.kind === "active" || state.kind === "expiring") &&
        row.scopeVerified

      expect(subscriptionRunBlocker(row, NOW) === null, state.kind).toBe(usable)
    }
  })
})

// ---------------------------------------------------------------------------
// Task 8.8 — the precedence table, the boundary, and the sentence
// ---------------------------------------------------------------------------

/** An ISO instant `offsetMs` from {@link NOW}, for a row's recorded expiry. */
function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString()
}

/** One row per branch of the design's table, in the order the branches run. */
type PrecedenceStep = {
  readonly step: number
  readonly kind: SubscriptionStateKind
  readonly condition: string
  readonly row: ConnectedSubscriptionView
}

const PRECEDENCE_STEPS: readonly PrecedenceStep[] = [
  {
    step: 1,
    kind: "disabled",
    condition: "status is disabled and the recorded expiry is a year out",
    row: view({ status: "disabled", secretExpiresAt: iso(365 * DAY_MS) }),
  },
  {
    step: 2,
    kind: "expired",
    condition: "active, and now is at the recorded expiry",
    row: view({ status: "active", secretExpiresAt: iso(0) }),
  },
  {
    step: 3,
    kind: "expiring",
    condition: "active, and inside the 30-day window",
    row: view({ status: "active", secretExpiresAt: iso(9 * DAY_MS) }),
  },
  {
    step: 4,
    kind: "pending",
    condition: "pending, whatever the recorded date says",
    row: view({
      status: "pending",
      scopeVerified: false,
      secretExpiresAt: iso(-30 * DAY_MS),
    }),
  },
  {
    step: 5,
    kind: "active",
    condition: "active, verified, and beyond the window",
    row: view({
      status: "active",
      secretExpiresAt: iso((EXPIRY_WARNING_DAYS + 1) * DAY_MS),
    }),
  },
] as const

describe("resolveSubscriptionState — the precedence table, one case per step", () => {
  test.each(
    PRECEDENCE_STEPS.map(
      (entry) => [entry.step, entry.condition, entry.kind, entry.row] as const
    )
  )("step %i — %s → %s", (_step, _condition, kind, row) => {
    expect(resolveSubscriptionState(row, NOW).kind).toBe(kind)
  })

  test("every state in the exported tuple is reachable, in the tuple's order", () => {
    // The ordered tuple *is* the specification — a reader is supposed to be able to
    // see that `disabled` outranks a recorded date without reconstructing the branch
    // order from the function body. This asserts the tuple and the branches agree,
    // so reordering one without the other fails here rather than silently making the
    // documentation wrong.
    expect(
      PRECEDENCE_STEPS.map(
        (entry) => resolveSubscriptionState(entry.row, NOW).kind
      )
    ).toEqual([...SUBSCRIPTION_STATE_KINDS])
  })

  test("only the expiring state carries a count", () => {
    // The union is discriminated for one reason: exactly one state has a number that
    // Requirement 13.2's warning must name, so a caller can neither render the banner
    // without the count nor invent a count for a state that has none.
    for (const { kind, row } of PRECEDENCE_STEPS) {
      const state = resolveSubscriptionState(row, NOW)

      expect("wholeDaysRemaining" in state, kind).toBe(kind === "expiring")
    }
  })
})

describe("Requirement 13.9 — step 1 outranks the recorded date", () => {
  test.each([
    ["a year in the future", 365 * DAY_MS],
    ["inside the 30-day window", 5 * DAY_MS],
    ["a day in the past", -1 * DAY_MS],
  ] as const)(
    "a disabled row whose recorded expiry is %s reads as disabled",
    (_label, offsetMs) => {
      // The case that *decides* the ordering. `secret_expires_at` is
      // consultant-entered and can lie, which is exactly why Requirement 13.9 writes
      // `status = 'disabled'` when Azure rejects a credential whose recorded expiry
      // is still in the future. Azure's evidence therefore beats the typed-in date:
      // an ordering that checked the date first would resolve the first row here as
      // `active` and offer the consultant no rotate action for a credential that
      // authenticates nothing.
      const row = view({
        status: "disabled",
        secretExpiresAt: iso(offsetMs),
      })

      expect(resolveSubscriptionState(row, NOW).kind).toBe("disabled")
    }
  )

  test("steps 2 and 3 are guarded on active, so a lapsed pending row stays pending", () => {
    // Never preflighted is the more useful thing to say about it, and it is blocked
    // either way — so the date is not allowed to relabel it.
    const row = view({
      status: "pending",
      scopeVerified: false,
      secretExpiresAt: iso(-1),
    })

    expect(resolveSubscriptionState(row, NOW).kind).toBe("pending")
    expect(subscriptionRunBlocker(row, NOW)).toBe("SCOPE_UNVERIFIED")
  })
})

describe("Requirements 13.2, 13.3 — the boundaries are at or after, not after", () => {
  // `[label, kind, offset]` rather than `[label, offset, kind]`, so the two `%s` in
  // the title name the case and the expected state — a title that reported the
  // millisecond offset instead of the state would say nothing about what failed.
  test.each([
    ["exactly 30 days out", "expiring", EXPIRY_WARNING_DAYS * DAY_MS],
    [
      "30 days out plus a millisecond",
      "active",
      EXPIRY_WARNING_DAYS * DAY_MS + 1,
    ],
    [
      "a millisecond inside 30 days",
      "expiring",
      EXPIRY_WARNING_DAYS * DAY_MS - 1,
    ],
    ["a millisecond before the expiry", "expiring", 1],
    ["exactly at the expiry", "expired", 0],
    ["a millisecond after the expiry", "expired", -1],
  ] as const)("%s → %s", (_label, kind, offsetMs) => {
    // Both edges are chosen rather than incidental. A row exactly 30 days out is
    // *already* warning (Requirement 13.2's window opens at `expiry - 30 days`), and
    // a row whose expiry equals `now` is *already* expired (Requirement 13.3's state
    // starts at the instant itself) — the alternative in each case leaves a
    // one-instant hole in a window whose whole purpose is that nothing falls through
    // it.
    const row = view({ status: "active", secretExpiresAt: iso(offsetMs) })

    expect(resolveSubscriptionState(row, NOW).kind).toBe(kind)
  })
})

describe("Requirement 13.2 — the whole days remaining the warning names", () => {
  // Title arguments first, offset last, for the reason the describe above states.
  test.each([
    ["exactly 30 days", 30, "30 days.", EXPIRY_WARNING_DAYS * DAY_MS],
    [
      "a millisecond inside 30 days",
      29,
      "29 days.",
      EXPIRY_WARNING_DAYS * DAY_MS - 1,
    ],
    ["two days less a millisecond", 1, "1 day.", 2 * DAY_MS - 1],
    ["exactly one day", 1, "1 day.", DAY_MS],
    ["a millisecond under a day", 0, "less than a day", DAY_MS - 1],
    ["a millisecond before the expiry", 0, "less than a day", 1],
  ] as const)(
    "%s remaining → %i whole days, rendered as %s",
    (_label, wholeDays, sentence, offsetMs) => {
      // Read off the resolved state rather than computed beside it: the banner has no
      // arithmetic of its own, which is what keeps the subscriptions screen and the
      // run screens — Requirement 13.2 requires the warning on both — from phrasing
      // or flooring the same instant differently.
      const state = resolveSubscriptionState(
        view({ status: "active", secretExpiresAt: iso(offsetMs) }),
        NOW
      )

      expect(state.kind).toBe("expiring")
      if (state.kind !== "expiring") return

      expect(state.wholeDaysRemaining).toBe(wholeDays)
      expect(expiryWarningText(state.wholeDaysRemaining)).toContain(sentence)
    }
  )
})
