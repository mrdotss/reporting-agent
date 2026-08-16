import { describe, expect, test } from "vitest"

import { isAcceptedExpiry, localDateTimeToIso } from "./secret-expiry-field"
import { maxSecretExpiry } from "@/lib/subscriptions/input"

/**
 * The expiry field's two pure helpers (Requirements 11.7, 11.9).
 *
 * These are the whole correctness of the field. `<input type="datetime-local">`
 * yields `YYYY-MM-DDTHH:mm` with **no offset**, and `secretExpiresAtSchema` requires
 * an ISO 8601 instant *with* one — so something has to decide which instant a wall
 * clock reading names. Getting that wrong makes a secret appear to expire seven
 * hours from when it does, in a product whose customer sits at `+07:00`.
 *
 * Deliberately not tested through the rendered control: `datetime-local` has a
 * segmented editor that `userEvent` drives inconsistently, and the claim being made
 * here is arithmetic rather than markup. The field's *copy* — the 24-month maximum
 * and the 6-to-12-month norm — is asserted where it is read, in
 * `app/(app)/subscriptions/new/page.test.tsx`.
 */

/** A `Date` as the `datetime-local` value that would produce it locally. */
function toLocalInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0")

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

const NOW = new Date("2026-07-01T00:00:00.000Z")

const MS_PER_DAY = 24 * 60 * 60 * 1000

describe("localDateTimeToIso — a wall clock reading becomes one instant", () => {
  test("the value is read as local time, not as UTC", () => {
    // The claim that matters, and it holds in any zone the suite runs in: the
    // control means "09:30 where the consultant is", which is what
    // `new Date(y, m, d, h, min)` constructs. Reading the same string as UTC would
    // be the seven-hour error.
    expect(localDateTimeToIso("2027-03-01T09:30")).toBe(
      new Date(2027, 2, 1, 9, 30, 0, 0).toISOString()
    )
  })

  test("the result is an ISO 8601 instant carrying an explicit offset", () => {
    const iso = localDateTimeToIso("2027-03-01T09:30")

    // `secretExpiresAtSchema` accepts `…Z` and `…+07:00` and refuses a local
    // datetime, so an output with no offset would be rejected at the boundary.
    expect(iso).toMatch(/Z$/)
  })

  test("an empty or unparseable value names no instant", () => {
    // `null` rather than an `Invalid Date`, so a caller cannot forward the string
    // "Invalid Date" into a request body.
    expect(localDateTimeToIso("")).toBeNull()
    expect(localDateTimeToIso("   ")).toBeNull()
    expect(localDateTimeToIso("not a date")).toBeNull()
    expect(localDateTimeToIso("2027-13-01T09:30")).toBeNull()

    // Worth recording what is *not* refused: `new Date` rolls an out-of-range day
    // forward, so "2027-02-30T09:30" resolves to 2 March rather than to `NaN`. The
    // date control cannot emit it, and the accepted-window check below is what
    // actually guards the value, so this is not worth defending against here.
    expect(localDateTimeToIso("2027-02-30T09:30")).not.toBeNull()
  })
})

describe("isAcceptedExpiry — Requirement 11.9's window, at the boundaries", () => {
  test("an absent or unparseable value is refused", () => {
    // Failing closed is the right direction here: the field exists to make an
    // expired credential visible before it produces a clean, fully-verified, empty
    // report.
    expect(isAcceptedExpiry("", NOW)).toBe(false)
    expect(isAcceptedExpiry("whenever", NOW)).toBe(false)
  })

  test("an expiry at or before the current instant is refused", () => {
    expect(isAcceptedExpiry(toLocalInput(NOW), NOW)).toBe(false)
    expect(
      isAcceptedExpiry(toLocalInput(new Date(NOW.getTime() - MS_PER_DAY)), NOW)
    ).toBe(false)
  })

  test("an expiry inside the window is accepted", () => {
    // The common case: a secret issued for six months.
    expect(
      isAcceptedExpiry(
        toLocalInput(new Date(NOW.getTime() + 182 * MS_PER_DAY)),
        NOW
      )
    ).toBe(true)
  })

  test("an expiry at the 24-month bound is accepted, and past it is refused", () => {
    const bound = maxSecretExpiry(NOW)

    // A secret issued for Azure's maximum lifetime is exactly what this looks
    // like, so rejecting the bound would reject the commonest legitimate maximum.
    // The control's minute granularity truncates towards the past, which keeps the
    // value inside the bound rather than stepping over it.
    expect(isAcceptedExpiry(toLocalInput(bound), NOW)).toBe(true)

    // Two days past it — beyond any rounding the minute granularity could explain.
    expect(
      isAcceptedExpiry(
        toLocalInput(new Date(bound.getTime() + 2 * MS_PER_DAY)),
        NOW
      )
    ).toBe(false)
  })

  test("the window moves with the instant it is asked about", () => {
    const twoYearsOut = toLocalInput(new Date(NOW.getTime() + 700 * MS_PER_DAY))

    // The same value, judged at two instants: acceptable now, and already past the
    // bound when asked about a year earlier. This is why `now` is a parameter — the
    // route reads its own clock at parse time and this helper must agree with
    // whatever instant it is given.
    expect(isAcceptedExpiry(twoYearsOut, NOW)).toBe(true)
    expect(
      isAcceptedExpiry(twoYearsOut, new Date(NOW.getTime() - 400 * MS_PER_DAY))
    ).toBe(false)
  })
})
