import fc from "fast-check"
import { describe, expect, test } from "vitest"

import { DEFAULT_RETURN_TO, safeReturnTo } from "@/lib/validation/return-to"

/**
 * `lib/validation/return-to.ts` — Requirement 7.9.
 *
 * An open-redirect guard, so the suite is written the way the guard is: as an
 * **allowlist**. Every rejection below is a form that a "does it start with a
 * slash" check lets through, and the property at the end closes the gap the
 * examples cannot — that no generated string escapes the two permitted
 * outcomes.
 *
 * The module is pure, so nothing here needs an environment, a clock or a
 * fixture.
 */

/**
 * Hard-coded, never imported into the expectation. Requirement 7.9 names the
 * authenticated dashboard as the fallback, so the constant is what is being
 * constrained — comparing `safeReturnTo("")` against `DEFAULT_RETURN_TO` alone
 * would keep passing if both moved to `/evil`.
 */
const DASHBOARD = "/dashboard"

/** Rejected, each for its own reason. */
const REJECTED = [
  // No target was supplied.
  { input: "", why: "the empty string carries no target" },
  { input: null, why: "an absent query parameter arrives as null" },
  { input: undefined, why: "an absent search param arrives as undefined" },

  // Relative to whatever the current URL happens to be.
  { input: "dashboard", why: "a bare path is not rooted" },
  { input: "reports/42", why: "a bare deep path is not rooted" },
  { input: "./reports", why: "a dot-relative path is not rooted" },
  { input: "../reports", why: "a parent-relative path is not rooted" },

  // Another origin, stated outright.
  { input: "https://evil.com", why: "absolute, another origin" },
  { input: "http://evil.com/reports", why: "absolute, another origin" },
  { input: "HTTPS://evil.com", why: "scheme comparison is case-insensitive" },
  { input: "javascript:alert(1)", why: "a scheme that is not navigation" },

  // Another origin, disguised. These are the ones a naive check passes.
  { input: "//evil.com", why: "protocol-relative: evil.com is the host" },
  { input: "//evil.com/reports", why: "protocol-relative with a path" },
  { input: "/\\evil.com", why: "the URL parser reads a backslash as a slash" },
  { input: "/\\/evil.com", why: "backslash then slash is still //" },

  // Stripped by the browser before the URL is parsed, so the second separator
  // is not adjacent to the first in the string that was tested.
  { input: "/\t/evil.com", why: "a tab is removed, leaving //evil.com" },
  { input: "/\n/evil.com", why: "a newline is removed, leaving //evil.com" },
  { input: "/\r/evil.com", why: "a return is removed, leaving //evil.com" },
  { input: "/ /evil.com", why: "a space is removed, leaving //evil.com" },
  { input: "/\u0000/evil.com", why: "a NUL is removed, leaving //evil.com" },
  { input: "/\u007f/evil.com", why: "DEL is removed, leaving //evil.com" },
] as const

/**
 * Titles carry an escaped rendition of the input, because several cases contain
 * a tab, a newline or a NUL — printed raw, those characters break the reporter's
 * own line layout, and the case whose title is a blank gap is the one hardest to
 * act on when it fails. `String(...)` covers `undefined`, which
 * `JSON.stringify` returns as a non-string.
 */
const REJECTED_CASES = REJECTED.map((rejected) => ({
  ...rejected,
  label: String(JSON.stringify(rejected.input)),
}))

/** Accepted, and returned verbatim. */
const ACCEPTED = [
  "/",
  "/dashboard",
  "/reports",
  "/reports/run-0001",
  "/subscriptions?connected=1",
  "/reports/run-0001?tab=verification&figure=fig_0412#figure-0412",
  "/report-profiles/tmpl-1/edit#block-3",
  "/reports/2026-07-01..2026-07-31",
] as const

describe("safeReturnTo — Requirement 7.9", () => {
  test("the fallback is the authenticated dashboard", () => {
    expect(DEFAULT_RETURN_TO).toBe(DASHBOARD)
  })

  test.each(REJECTED_CASES)(
    "$label resolves to the dashboard — $why",
    ({ input }) => {
      expect(safeReturnTo(input)).toBe(DASHBOARD)
    }
  )

  test.each(ACCEPTED)("%j is accepted and returned verbatim", (input) => {
    // Verbatim matters as much as accepted: a deep link with a query string and
    // a fragment has to survive sign-in intact, so the guard may not normalize,
    // re-encode or truncate what it lets through.
    expect(safeReturnTo(input)).toBe(input)
  })

  test("the two outcomes are the only outcomes, for any string", () => {
    // The examples above enumerate forms someone thought of. This closes the
    // set: whatever the input, the result is either the input unchanged or the
    // dashboard — never a third value, and never a mutation of the input.
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 64 }), (raw) => {
        const target = safeReturnTo(raw)

        expect(target === raw || target === DASHBOARD).toBe(true)
      })
    )
  })

  test("no accepted value can address another origin", () => {
    // The security property, stated over generated input rather than over a
    // list of known-bad prefixes: an accepted target begins with exactly one
    // `/`, and carries no character a browser strips before parsing — so it
    // cannot resolve to a host.
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 64 }), (raw) => {
        const target = safeReturnTo(raw)
        if (target === DASHBOARD) return

        expect(target.startsWith("/")).toBe(true)
        expect(target.startsWith("//")).toBe(false)
        expect(target.startsWith("/\\")).toBe(false)
        // Nothing a browser removes on its way to the URL parser, so the
        // string tested here is the string the browser will navigate.
        expect(target).not.toMatch(/[\u0000-\u0020\u007f]/)
      })
    )
  })

  test("a slash followed by any stripped character is rejected", () => {
    // The `"/\t/evil.com"` family, generated rather than enumerated: whatever
    // sits between the two slashes, if the browser removes it the target is
    // protocol-relative.
    const stripped = fc.integer({ min: 0, max: 0x20 }).map(String.fromCharCode)

    fc.assert(
      fc.property(stripped, (character) => {
        expect(safeReturnTo(`/${character}/evil.com`)).toBe(DASHBOARD)
      })
    )
    expect(safeReturnTo("/\u007f/evil.com")).toBe(DASHBOARD)
  })

  test("sanitizing is idempotent and depends on nothing but the argument", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 64 }), (raw) => {
        const once = safeReturnTo(raw)

        expect(safeReturnTo(raw)).toBe(once)
        expect(safeReturnTo(once)).toBe(once)
      })
    )
  })
})
