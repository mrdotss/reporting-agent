import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  CLIENT_SECRET_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  SECRET_MAX_LIFETIME_MONTHS,
  maxSecretExpiry,
  rotateSecretInputSchema,
  secretExpiresAtSchema,
  subscriptionCreateInputSchema,
  subscriptionIdParamSchema,
  subscriptionListQuerySchema,
  subscriptionTestInputSchema,
  withinSecretLifetime,
} from "@/lib/subscriptions/input"

/**
 * The boundary schemas (Requirements 7.7, 11.9).
 *
 * Two claims here are worth machine-checking, and both are the kind a plausible
 * implementation gets wrong at exactly one point:
 *
 *  1. **The expiry window's two edges.** "After now" and "at most 24 months out"
 *     are inclusive on one side and exclusive on the other, and the interesting
 *     cases are the instants *on* the boundaries — an expiry equal to `now` is
 *     already expired, and an expiry exactly 24 months out is what a
 *     maximum-lifetime secret looks like. A test using "a year from now" and "ten
 *     years from now" passes against an implementation that has both comparisons
 *     the wrong way round.
 *  2. **`.strict()` rejects `scopeVerified`.** Requirement 12.14 reserves writing
 *     that flag to the Preflight_Service, and the schema is where a browser is
 *     denied a field to put it in. Silently dropping an unknown key would make a
 *     client that tried it look like it had succeeded.
 *
 * The clock is faked for the window cases so both edges can be named exactly.
 * `maxSecretExpiry` and `withinSecretLifetime` are pure and take their instant, so
 * the arithmetic itself is asserted without a clock at all.
 */

const SUBSCRIPTION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const TENANT_ID = "11111111-2222-3333-4444-555555555555"
const CLIENT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa"
const WORKSPACE_ID = "abcdabcd-1234-5678-9abc-abcdefabcdef"

/** A `connected_subscriptions.id`, which is a `text` primary key, not a `uuid`. */
const SUBSCRIPTION_ROW_ID = "8f14e45f-ceea-467a-9d9f-b8a4c8e6f1c2"

/**
 * Distinctive enough that a scan of a whole serialized rejection cannot match it
 * by accident — which is the point of the assertion it appears in.
 */
const PLAINTEXT_SECRET = "azure-client-secret-DO-NOT-DISCLOSE-9f13c7"

/** A fixed instant, so "24 months from now" is a value a test can write down. */
const NOW = new Date("2026-07-15T09:30:00.000Z")

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Northwind production",
    subscriptionId: SUBSCRIPTION_ID,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: PLAINTEXT_SECRET,
    secretExpiresAt: "2027-07-15T09:30:00.000Z",
    logAnalyticsWorkspaceId: null,
    ...overrides,
  }
}

/** Every issue message from a rejection, joined — what a caller would surface. */
function messages(body: Record<string, unknown>): string {
  const parsed = subscriptionCreateInputSchema.safeParse(body)
  expect(parsed.success).toBe(false)

  return parsed.success
    ? ""
    : parsed.error.issues.map((issue) => issue.message).join(" | ")
}

// --- The pure expiry arithmetic --------------------------------------------

describe("Requirement 11.9 — maxSecretExpiry is 24 calendar months, clamped", () => {
  test("the bound is 24 months out at the same time of day", () => {
    expect(maxSecretExpiry(new Date("2026-07-15T09:30:00.000Z"))).toEqual(
      new Date("2028-07-15T09:30:00.000Z")
    )
  })

  test("a month index past December rolls the year rather than overflowing", () => {
    // December is month index 11, so +24 is index 35 — `Date.UTC` normalizes it.
    expect(maxSecretExpiry(new Date("2026-12-31T23:59:59.999Z"))).toEqual(
      new Date("2028-12-31T23:59:59.999Z")
    )
  })

  test("29 February clamps to the last day of the target month", () => {
    // The case a naive `setUTCMonth` gets wrong: 2028-02-29 exists, 2026-02-29
    // does not, and rolling forward into 1 March would make the bound depend on
    // which leap year the request landed in rather than on the calendar.
    expect(maxSecretExpiry(new Date("2028-02-29T00:00:00.000Z"))).toEqual(
      new Date("2030-02-28T00:00:00.000Z")
    )
  })

  test("the constant is Azure's documented cap", () => {
    expect(SECRET_MAX_LIFETIME_MONTHS).toBe(24)
  })
})

describe("Requirement 11.9 — withinSecretLifetime's two edges", () => {
  test.each([
    ["one millisecond before now", -1, false],
    ["exactly now", 0, false],
    ["one millisecond after now", 1, true],
  ] as const)("%s → %s", (_label, offsetMs, expected) => {
    // "At or before the current instant" is a rejection, so the accepted side
    // starts one millisecond later. An expiry equal to `now` would create a
    // connection `subscriptionRunBlocker` refuses on its first run.
    expect(withinSecretLifetime(new Date(NOW.getTime() + offsetMs), NOW)).toBe(
      expected
    )
  })

  test("exactly 24 months out is accepted and one millisecond later is not", () => {
    const bound = maxSecretExpiry(NOW)

    // Inclusive at the top, because a secret issued for the maximum lifetime lands
    // exactly here — an exclusive bound would reject the commonest legitimate
    // maximum.
    expect(withinSecretLifetime(bound, NOW)).toBe(true)
    expect(withinSecretLifetime(new Date(bound.getTime() + 1), NOW)).toBe(false)
  })

  test("an unparseable date fails closed", () => {
    // `NaN` fails both comparisons, and that is the direction to fail in: an expiry
    // that cannot be read is indistinguishable from one that has passed, and a
    // passed one produces a clean, fully-verified, empty report.
    expect(withinSecretLifetime(new Date("not a date"), NOW)).toBe(false)
  })
})

// --- The schema's expiry field ---------------------------------------------

describe("Requirement 11.9 — secretExpiresAtSchema", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["not a date", "next Tuesday"],
    ["a local datetime with no offset", "2027-07-15T09:30:00"],
    ["a date with no time", "2027-07-15"],
    ["a number of milliseconds", 1_800_000_000_000],
  ] as const)("rejects %s", (_label, value) => {
    // A local datetime names no instant, and guessing an offset for it is how a
    // secret appears to expire seven hours from when it does.
    expect(secretExpiresAtSchema.safeParse(value).success).toBe(false)
  })

  test.each([
    ["a UTC instant", "2027-07-15T09:30:00.000Z"],
    ["an offset instant", "2027-07-15T16:30:00+07:00"],
  ] as const)("accepts %s and yields a Date", (_label, value) => {
    const parsed = secretExpiresAtSchema.safeParse(value)

    expect(parsed.success).toBe(true)
    expect(parsed.data).toBeInstanceOf(Date)
  })

  test("an offset instant resolves to the instant it names", () => {
    // Asia/Jakarta is +07:00 and the customer is there, so this is the form a
    // consultant is most likely to paste out of the portal.
    const parsed = secretExpiresAtSchema.safeParse("2027-07-15T16:30:00+07:00")

    expect(parsed.success && parsed.data.toISOString()).toBe(
      "2027-07-15T09:30:00.000Z"
    )
  })

  test("the window is applied at parse time, against the request's own instant", () => {
    const beyond = new Date(maxSecretExpiry(NOW).getTime() + 1).toISOString()

    expect(secretExpiresAtSchema.safeParse(beyond).success).toBe(false)

    // Advance the clock past the point where that same value is inside the window,
    // and it is accepted — the schema read the clock, not a captured constant.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    expect(secretExpiresAtSchema.safeParse(beyond).success).toBe(true)
  })

  test("the rejection states the accepted range", () => {
    // Requirement 11.9 names what the message must say: after the current instant,
    // and at most 24 months after it.
    const message = messages(validBody({ secretExpiresAt: undefined }))

    expect(message).toContain("after now")
    expect(message).toContain(`${SECRET_MAX_LIFETIME_MONTHS} months`)
  })
})

// --- The submitted credential ---------------------------------------------

describe("Requirements 7.7, 12.14 — the credential schemas", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("a valid body parses, and the workspace id normalizes to null", () => {
    const parsed = subscriptionCreateInputSchema.safeParse(validBody())

    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({
      displayName: "Northwind production",
      subscriptionId: SUBSCRIPTION_ID,
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: PLAINTEXT_SECRET,
      logAnalyticsWorkspaceId: null,
    })
  })

  test("the two schemas accept the same body", () => {
    // Identical today and separately named on purpose, so a field that later
    // becomes creation-only can appear on one without widening the other. Asserted
    // rather than assumed, because a divergence would show up as a wizard whose
    // test step passes and whose save step rejects.
    expect(subscriptionTestInputSchema.safeParse(validBody()).success).toBe(
      true
    )
    expect(subscriptionCreateInputSchema.safeParse(validBody()).success).toBe(
      true
    )
  })

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["the empty string", ""],
  ] as const)(
    "a %s workspace id normalizes to null rather than reaching the column",
    (_label, value) => {
      // `""` in the column would read as "a workspace, whose id is nothing" and
      // send the fidelity probe after it.
      const parsed = subscriptionCreateInputSchema.safeParse(
        validBody({ logAnalyticsWorkspaceId: value })
      )

      expect(parsed.success && parsed.data.logAnalyticsWorkspaceId).toBeNull()
    }
  )

  test("a workspace id that is a GUID survives", () => {
    const parsed = subscriptionCreateInputSchema.safeParse(
      validBody({ logAnalyticsWorkspaceId: WORKSPACE_ID })
    )

    expect(parsed.success && parsed.data.logAnalyticsWorkspaceId).toBe(
      WORKSPACE_ID
    )
  })

  test.each([
    "subscriptionId",
    "tenantId",
    "clientId",
    "logAnalyticsWorkspaceId",
  ] as const)("%s must be a GUID", (field) => {
    for (const bad of [
      "not-a-guid",
      "3f2504e0-4f89-11d3-9a0c",
      "3f2504e04f8911d39a0c0305e82c3301",
      " 3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301; rm -rf /",
      12345,
    ]) {
      expect(
        subscriptionCreateInputSchema.safeParse(validBody({ [field]: bad }))
          .success,
        `${field} accepted ${JSON.stringify(bad)}`
      ).toBe(false)
    }
  })

  test("the display name is trimmed, and bounded at both ends", () => {
    const trimmed = subscriptionCreateInputSchema.safeParse(
      validBody({ displayName: "  Contoso  " })
    )
    expect(trimmed.success && trimmed.data.displayName).toBe("Contoso")

    for (const bad of ["", "   ", "x".repeat(DISPLAY_NAME_MAX_LENGTH + 1)]) {
      expect(
        subscriptionCreateInputSchema.safeParse(validBody({ displayName: bad }))
          .success
      ).toBe(false)
    }
  })

  test("the client secret is required and bounded", () => {
    for (const bad of [
      undefined,
      "",
      "x".repeat(CLIENT_SECRET_MAX_LENGTH + 1),
      42,
    ]) {
      expect(
        subscriptionCreateInputSchema.safeParse(
          validBody({ clientSecret: bad })
        ).success
      ).toBe(false)
    }
  })

  test("no rejection message quotes the submitted secret", () => {
    // A validation message is a thing that ends up in a log line, and this field's
    // value is a customer credential. The failing field here is the secret itself,
    // which is the case where an implementation is most tempted to quote it.
    const tooLong = "y".repeat(CLIENT_SECRET_MAX_LENGTH + 1)
    const parsed = subscriptionCreateInputSchema.safeParse(
      validBody({ clientSecret: tooLong })
    )

    expect(parsed.success).toBe(false)
    const serialized = parsed.success ? "" : JSON.stringify(parsed.error.issues)

    expect(serialized).not.toContain(tooLong)
    expect(serialized).not.toContain("yyyy")
  })

  test("Requirement 12.14 — a body carrying scopeVerified is rejected, not ignored", () => {
    // The structural half of "the Preflight_Service is the only writer of a
    // `scope_verified` value of true": there is no field for a browser to put it
    // in, and `.strict()` turns an attempt into a rejection rather than a
    // silently-dropped key that looks like it worked.
    for (const smuggled of [
      { scopeVerified: true },
      { scope_verified: true },
      { fidelityTier: "enhanced" },
      { status: "active" },
    ]) {
      const parsed = subscriptionCreateInputSchema.safeParse(
        validBody(smuggled)
      )

      expect(parsed.success, `${JSON.stringify(smuggled)} was accepted`).toBe(
        false
      )
    }
  })

  test.each([
    ["a string", "not an object"],
    ["null", null],
    ["an array", []],
  ] as const)("a body that is %s is rejected", (_label, body) => {
    expect(subscriptionCreateInputSchema.safeParse(body).success).toBe(false)
  })
})

// --- The list route's query ------------------------------------------------

describe("Requirement 7.7 — the list route's search parameters are parsed", () => {
  test("no parameters is the accepted set", () => {
    expect(subscriptionListQuerySchema.safeParse({}).success).toBe(true)
  })

  test("an unexpected parameter is rejected", () => {
    // `?userId=…` expresses an expectation this route does not honour — every read
    // is scoped to the signed-in user — and answering it with the caller's own
    // subscriptions would look like the filter had been applied.
    expect(
      subscriptionListQuerySchema.safeParse({ userId: "u1" }).success
    ).toBe(false)
  })
})

// --- The rotation route's path parameter -----------------------------------

describe("Requirement 7.7 — the dynamic segment is parsed like a body", () => {
  test("a plain id parses, trimmed", () => {
    const parsed = subscriptionIdParamSchema.safeParse({
      id: `  ${SUBSCRIPTION_ROW_ID}  `,
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.id).toBe(SUBSCRIPTION_ROW_ID)
  })

  test.each([
    ["absent", {}],
    ["empty", { id: "" }],
    ["whitespace only", { id: "   " }],
    ["not a string", { id: 7 }],
    ["over the length bound", { id: "x".repeat(201) }],
  ] as const)("an id that is %s is rejected", (_label, params) => {
    expect(subscriptionIdParamSchema.safeParse(params).success).toBe(false)
  })

  test("an extra path field is rejected", () => {
    expect(
      subscriptionIdParamSchema.safeParse({
        id: SUBSCRIPTION_ROW_ID,
        userId: "someone-else",
      }).success
    ).toBe(false)
  })

  test("a non-UUID id is accepted, because the column is text", () => {
    // Deliberately permissive: `connected_subscriptions.id` is a `text` primary
    // key, and every id that is not this user's — junk included — has to resolve as
    // the one not-found answer Requirement 9.8 requires, decided by the scoped
    // statement rather than split across a 400 here and a 404 there.
    expect(
      subscriptionIdParamSchema.safeParse({ id: "sub-01HZX9" }).success
    ).toBe(true)
  })
})

// --- The rotation route's body ---------------------------------------------

describe("Requirements 13.7, 13.8 — rotateSecretInputSchema", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("the accepted body is the secret and its expiry, and the expiry becomes a Date", () => {
    const parsed = rotateSecretInputSchema.safeParse({
      clientSecret: PLAINTEXT_SECRET,
      secretExpiresAt: "2027-07-15T09:30:00.000Z",
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toStrictEqual({
      clientSecret: PLAINTEXT_SECRET,
      secretExpiresAt: new Date("2027-07-15T09:30:00.000Z"),
    })
  })

  test.each([
    ["scopeVerified", { scopeVerified: true }],
    ["fidelityTier", { fidelityTier: "enhanced" }],
    ["status", { status: "active" }],
    ["tenantId", { tenantId: TENANT_ID }],
    ["clientId", { clientId: CLIENT_ID }],
    ["subscriptionId", { subscriptionId: SUBSCRIPTION_ID }],
    ["displayName", { displayName: "Renamed" }],
    ["logAnalyticsWorkspaceId", { logAnalyticsWorkspaceId: WORKSPACE_ID }],
  ] as const)("a body smuggling %s is rejected", (_label, smuggled) => {
    // A rotation replaces the credential, not the connection: `rotateClientSecret`
    // has no argument that could write an identity field, so accepting one would
    // mean preflighting against an identity the row will still not have.
    expect(
      rotateSecretInputSchema.safeParse({
        clientSecret: PLAINTEXT_SECRET,
        secretExpiresAt: "2027-07-15T09:30:00.000Z",
        ...smuggled,
      }).success
    ).toBe(false)
  })

  test.each([
    ["absent", undefined],
    ["at the current instant", NOW.toISOString()],
    ["more than 24 months out", "2028-07-15T09:30:00.001Z"],
  ] as const)(
    "Requirement 11.9's range applies to a rotated expiry that is %s",
    (_label, secretExpiresAt) => {
      expect(
        rotateSecretInputSchema.safeParse({
          clientSecret: PLAINTEXT_SECRET,
          secretExpiresAt,
        }).success
      ).toBe(false)
    }
  )

  test(`exactly ${SECRET_MAX_LIFETIME_MONTHS} months out is accepted`, () => {
    // The boundary a maximum-lifetime rotated secret lands on, taken from the pure
    // bound rather than written out, so the two cannot drift apart.
    expect(
      rotateSecretInputSchema.safeParse({
        clientSecret: PLAINTEXT_SECRET,
        secretExpiresAt: maxSecretExpiry(NOW).toISOString(),
      }).success
    ).toBe(true)
  })

  test("a rejection never echoes the submitted secret", () => {
    const parsed = rotateSecretInputSchema.safeParse({
      clientSecret: PLAINTEXT_SECRET,
      secretExpiresAt: "2099-01-01T00:00:00.000Z",
    })

    expect(parsed.success).toBe(false)
    expect(
      parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ")
    ).not.toContain(PLAINTEXT_SECRET)
  })
})
