import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, test } from "vitest"
import fc from "fast-check"

import {
  MAX_PERIOD_LOCAL_DAYS,
  MIN_PERIOD_LOCAL_DAYS,
  PERIOD_KINDS,
  addLocalDays,
  daysInMonth,
  formatUtcOffset,
  inclusiveLocalDaySpan,
  isRealCalendarDate,
  localDateIn,
  resolvePeriod,
  type PeriodSpec,
  type ResolvedPeriod,
} from "@/lib/templates/period"

/**
 * **Property 9: period resolution is correct at every offset and every edge.**
 *
 * **Validates: Requirements 4.2, 4.4, 4.5, 4.6, 4.8, 45.1, 45.3, 45.4**
 *
 * *For any* period specification, instant and IANA timezone, the Period_Resolver
 * resolves an inclusive local range whose end is at or before the local day
 * preceding the current local date, whose day count is 1–31 or which is rejected,
 * identically for any two instants within the same local day, and independently
 * of the host process timezone.
 *
 * ## The oracle, and why there is one
 *
 * A resolver can be perfectly self-consistent and wrong: read the current local
 * date with `getUTCDate()` and every one of the six rules still produces an
 * inclusive 1–31-day window ending yesterday — just yesterday **in UTC**, which
 * for a customer at UTC+07:00 is the wrong day for seven hours out of every
 * twenty-four. So the expected local date is computed here by a mechanism the
 * implementation does not use.
 *
 * Six of the eight generated zones are **DST-free**, which is what makes an exact
 * arithmetic oracle possible: `UTC` (+00:00), `Asia/Jakarta` (+07:00),
 * `Asia/Kathmandu` (+05:45), `Australia/Eucla` (+08:45), `Pacific/Kiritimati`
 * (+14:00) and `Pacific/Midway` (−11:00) each hold one fixed offset for every
 * instant in the generated range, so shifting the instant by that offset and
 * reading the **UTC** date off it — `toISOString().slice(0, 10)`, no `Intl` at
 * all — is the local date by definition. Three of the six carry a non-whole-hour
 * or beyond-±12 offset on purpose: `+05:45` and `+08:45` break an implementation
 * that reasons in whole hours, and `+14:00` and `−11:00` put the local date a
 * whole day either side of UTC's.
 *
 * The two DST zones — `America/New_York` (whole-hour shift) and
 * `Australia/Lord_Howe` (a **30-minute** shift, from +10:30 to +11:00) — have no
 * fixed-offset oracle, so their expected local date comes from a second `Intl`
 * surface (`Date.prototype.toLocaleDateString` with `en-CA`, rather than the
 * module's `formatToParts` with `en-US`). That is a weaker independence claim,
 * which is why the DST correctness is *also* pinned by declared cases and by the
 * same-local-day property below, and why the generator deliberately concentrates
 * instants in the March/April and October/November transition windows at UTC
 * hours 00:00–08:59 — the window that contains local midnight for both zones.
 *
 * ## The case that kills a UTC clock, stated as a case
 *
 * `2026-07-01T16:30Z` in `Asia/Jakarta` is `2026-07-01T23:30+07:00`. The current
 * local date is 1 July, so `last_24h` is **30 June**. A resolver reading
 * `getUTCDate()` also says "1 July" for the current date and also resolves
 * `last_24h` to 30 June — it agrees here. The instant that separates them is the
 * one *before* local midnight where UTC has not yet ticked over, which is why the
 * declared cases carry both directions: `Pacific/Midway` at `2026-07-01T05:00Z`
 * is `2026-06-30T18:00−11:00`, so `last_24h` is **29 June** where a UTC clock
 * would say 30 June, and `Pacific/Kiritimati` at `2026-07-01T11:00Z` is
 * `2026-07-02T01:00+14:00`, so `last_24h` is **1 July** where a UTC clock would
 * say 30 June. The Jakarta case is kept exactly as the task states it because it
 * is the one the requirement names, and the two date-line cases are what make the
 * *class* of defect unmissable.
 *
 * ## `process.env.TZ` invariance is a real check here, not a decorative one
 *
 * Reassigning `process.env.TZ` mid-process **does** take effect on this runtime:
 * `new Date("2026-07-01T16:30:00Z").getDate()` reads 1 under `TZ=UTC` and 2 under
 * `TZ=Pacific/Kiritimati`, on an *already-constructed* `Date`. That is asserted
 * directly, before the invariance property runs, so the property cannot pass by
 * changing nothing — which is the failure mode the task warns about and the reason
 * a child process was not needed. If a future Node stops honouring the
 * reassignment, the mechanism assertion fails and says so rather than leaving the
 * invariance property silently vacuous.
 *
 * That is paired with a source-level guard: the module contains no host-zone
 * `Date` getter, no `Date.UTC`, no `process.env`, and exactly one
 * `Intl.DateTimeFormat` construction, which passes an explicit `timeZone`. The
 * behavioural check proves the current implementation is invariant; the source
 * check proves it is invariant *by construction* rather than by luck.
 *
 * ## Declared cases
 *
 * Three arrays, one per property (Requirement 45.5). `numRuns` is raised to
 * `100 + <array>.length` on each site: fast-check draws declared cases from the
 * same budget as generated ones, so the floor of 100 **generated** cases
 * (Requirement 45.1) has to be asked for explicitly.
 */

// --- Zones -----------------------------------------------------------------

/**
 * DST-free zones and their fixed offsets in minutes, for the arithmetic oracle.
 *
 * Every one of these holds a single offset across 2024–2030. Asserted rather than
 * trusted by {@link describe} "the oracle's premise", below: a zone that started
 * observing DST would silently turn the oracle into a source of false failures.
 */
const FIXED_OFFSET_ZONES: Readonly<Record<string, number>> = {
  UTC: 0,
  "Asia/Jakarta": 7 * 60,
  "Asia/Kathmandu": 5 * 60 + 45,
  "Australia/Eucla": 8 * 60 + 45,
  "Pacific/Kiritimati": 14 * 60,
  "Pacific/Midway": -11 * 60,
}

/**
 * Zones that shift. `America/New_York` is the whole-hour case design.md names;
 * `Australia/Lord_Howe` is the extra one, and it earns its place by shifting
 * **30 minutes** rather than 60 — an implementation that special-cases DST as
 * "an hour" is wrong there in a way it is not wrong in New York.
 */
const DST_ZONES = ["America/New_York", "Australia/Lord_Howe"] as const

const ZONES: readonly string[] = [
  ...Object.keys(FIXED_OFFSET_ZONES),
  ...DST_ZONES,
]

const JAKARTA = "Asia/Jakarta"

// --- Date helpers, all `Date`-based so they share no code with the module ----

const MS_PER_DAY = 86_400_000

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** `YYYY-MM-DD` for a count of days since the epoch, via `Date`'s own UTC frame. */
function isoFromEpochDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/** Days since the epoch for a `YYYY-MM-DD`, via `Date.parse`. */
function epochDayOf(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY)
}

/** `date` shifted by `days`, computed through `Date` rather than civil arithmetic. */
function shiftIso(date: string, days: number): string {
  return isoFromEpochDay(epochDayOf(date) + days)
}

/** The inclusive day count between two dates, computed through `Date`. */
function oracleSpan(start: string, end: string): number {
  return epochDayOf(end) - epochDayOf(start) + 1
}

/** The first of `date`'s month. */
function firstOfMonth(date: string): string {
  return `${date.slice(0, 8)}01`
}

/**
 * The zone's offset in minutes at `at`, read from `timeZoneName: "longOffset"`.
 *
 * A third `Intl` surface, used only to build the same-local-day instants below.
 * `GMT` with no numeric suffix is how some ICU builds spell a zero offset.
 */
function oracleOffsetMinutes(timeZone: string, at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")
  if (name === undefined) throw new Error(`no offset for ${timeZone}`)
  const matched = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name.value)
  if (matched === null) throw new Error(`unreadable offset ${name.value}`)
  if (matched[1] === undefined) return 0
  const magnitude = Number(matched[2]) * 60 + Number(matched[3])
  return matched[1] === "-" ? -magnitude : magnitude
}

/**
 * The expected local date of `at` in `timeZone`.
 *
 * Pure offset arithmetic with **no `Intl`** for the six DST-free zones — the
 * genuinely independent oracle — and a second `Intl` surface for the two that
 * shift.
 */
function oracleLocalDate(timeZone: string, at: Date): string {
  const fixed = FIXED_OFFSET_ZONES[timeZone]
  if (fixed !== undefined) {
    return new Date(at.getTime() + fixed * 60_000).toISOString().slice(0, 10)
  }
  return at.toLocaleDateString("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
}

/**
 * The instant of a wall-clock time in a zone, or `null` when that wall time does
 * not exist (a spring-forward gap) or lands on a different local date.
 *
 * Guess with the wall time read as UTC, correct by the offset the guess lands
 * in, correct once more. Used only to build two instants inside one local day.
 */
function wallTimeInstant(
  timeZone: string,
  date: string,
  hour: number,
  minute: number
): Date | null {
  const wallAsUtc = Date.parse(`${date}T${pad2(hour)}:${pad2(minute)}:00Z`)
  const firstOffset = oracleOffsetMinutes(timeZone, new Date(wallAsUtc))
  const corrected = new Date(wallAsUtc - firstOffset * 60_000)
  const secondOffset = oracleOffsetMinutes(timeZone, corrected)
  const at = new Date(wallAsUtc - secondOffset * 60_000)
  return oracleLocalDate(timeZone, at) === date ? at : null
}

// --- The expected resolution, derived from the oracle -----------------------

type Expectation =
  | { readonly ok: true; readonly start: string; readonly end: string }
  | { readonly ok: false; readonly code: string }

/**
 * What Requirement 4.4's rules say the answer is, written against the oracle's
 * local date rather than the module's.
 *
 * The order of the three bound checks matches the module's — zero days, then the
 * 31-day ceiling, then the never-past-yesterday rule — because a 40-day inverted
 * window violates two bounds at once and the requirement asks for *which* bound,
 * singular. Both orders being written out independently and asserted equal is the
 * point.
 */
function expectedResolution(
  spec: PeriodSpec,
  currentLocalDate: string
): Expectation {
  const yesterday = shiftIso(currentLocalDate, -1)

  let start: string
  let end: string

  switch (spec.kind) {
    case "last_24h":
      start = yesterday
      end = yesterday
      break
    case "last_7d":
      end = yesterday
      start = shiftIso(yesterday, -6)
      break
    case "last_30d":
      end = yesterday
      start = shiftIso(yesterday, -29)
      break
    case "last_full_month":
      end = shiftIso(firstOfMonth(currentLocalDate), -1)
      start = firstOfMonth(end)
      break
    case "mtd":
      start = firstOfMonth(currentLocalDate)
      end = yesterday
      break
    case "custom":
      start = spec.start
      end = spec.end
      break
  }

  const days = oracleSpan(start, end)
  if (days < MIN_PERIOD_LOCAL_DAYS) {
    return { ok: false, code: "no_complete_local_day" }
  }
  if (days > MAX_PERIOD_LOCAL_DAYS) {
    return { ok: false, code: "exceeds_maximum_days" }
  }
  if (end > yesterday) return { ok: false, code: "ends_after_yesterday" }
  return { ok: true, start, end }
}

// --- Generators -------------------------------------------------------------

const RANGE_FIRST_DAY = epochDayOf("2024-01-01")
const RANGE_LAST_DAY = epochDayOf("2030-12-31")

const zoneArb = fc.constantFrom(...ZONES)

/** Every hour and every minute of the range, uniformly. */
const uniformInstantArb = fc
  .tuple(
    fc.integer({ min: RANGE_FIRST_DAY, max: RANGE_LAST_DAY }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 })
  )
  .map(
    ([day, hour, minute]) =>
      new Date(day * MS_PER_DAY + hour * 3_600_000 + minute * 60_000)
  )

/**
 * Month edges, where `last_full_month` and `mtd` change answer.
 *
 * Uniform generation reaches a first-of-month roughly one time in thirty, which
 * is enough to *find* the `mtd`-on-the-first rejection but not enough to explore
 * it at every offset. Days 1–2 and 27–31 get their own branch.
 */
const monthEdgeInstantArb = fc
  .tuple(
    fc.integer({ min: 2024, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.constantFrom(1, 2, 27, 28, 29, 30, 31),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 })
  )
  .map(([year, month, day, hour, minute]) => {
    const clamped = Math.min(day, daysInMonthOracle(year, month))
    return new Date(Date.UTC(year, month - 1, clamped, hour, minute))
  })

/** Days in a month, computed here so the generator does not lean on the module. */
function daysInMonthOracle(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * The DST window, at the UTC hours that contain local midnight for both DST
 * zones.
 *
 * This is the branch that kills the millisecond-arithmetic resolver, and it has
 * to be deliberate: the failing window is roughly the hour after local midnight
 * on the day *following* a transition, so a uniform draw over seven years finds
 * it about one time in fifty thousand. March/April and October/November days 1–14
 * cover every transition date for `America/New_York` (second Sunday March, first
 * Sunday November) and `Australia/Lord_Howe` (first Sunday April, first Sunday
 * October) across the range, and UTC hours 00:00–08:59 straddle local midnight
 * for a zone at −04:00/−05:00 as well as one at +10:30/+11:00.
 */
const dstEdgeInstantArb = fc
  .tuple(
    fc.integer({ min: 2024, max: 2030 }),
    fc.constantFrom(3, 4, 10, 11),
    fc.integer({ min: 1, max: 14 }),
    fc.integer({ min: 0, max: 8 }),
    fc.integer({ min: 0, max: 59 })
  )
  .map(
    ([year, month, day, hour, minute]) =>
      new Date(Date.UTC(year, month - 1, day, hour, minute))
  )

const instantArb = fc.oneof(
  uniformInstantArb,
  monthEdgeInstantArb,
  dstEdgeInstantArb
)

const relativeSpecArb: fc.Arbitrary<PeriodSpec> = fc
  .constantFrom(...PERIOD_KINDS.filter((kind) => kind !== "custom"))
  .map((kind) => ({ kind }) as PeriodSpec)

/**
 * `custom` windows of −9 to 40 days, so inverted ranges, zero-length ranges, the
 * 31-day ceiling and the 32-day rejection are all reachable, and drawn from the
 * same date range as the instants so roughly half of them end in the future
 * relative to the instant they are resolved at.
 */
const customSpecArb: fc.Arbitrary<PeriodSpec> = fc
  .tuple(
    fc.integer({ min: RANGE_FIRST_DAY - 40, max: RANGE_LAST_DAY + 40 }),
    fc.integer({ min: -9, max: 40 })
  )
  .map(([day, span]) => ({
    kind: "custom" as const,
    start: isoFromEpochDay(day),
    end: isoFromEpochDay(day + span),
  }))

const specArb = fc.oneof(relativeSpecArb, customSpecArb)

// --- Declared cases ---------------------------------------------------------

/**
 * Thirteen, and each one is a fact rather than a sample. In order: the three the
 * task text names as cases, the DST killer, the two date-line directions that
 * make a UTC clock unmissable, the two non-whole-hour offsets, and the four bound
 * edges.
 */
const PERIOD_EXAMPLES: [PeriodSpec, Date, string][] = [
  // 1. `mtd` on the first local day of a month ⇒ rejection (Requirement 4.6).
  //    2026-07-01T05:00Z is 12:00 local in Jakarta, so the current local date is
  //    the 1st and "the first through yesterday" is empty.
  [{ kind: "mtd" }, new Date("2026-07-01T05:00:00Z"), JAKARTA],
  // 2. `last_full_month` resolved on 1 January ⇒ the whole of the previous
  //    December, which is the case that catches a month decrement that forgets
  //    to decrement the year.
  [{ kind: "last_full_month" }, new Date("2027-01-01T05:00:00Z"), JAKARTA],
  // 3. THE case. 2026-07-01T16:30Z is 2026-07-01T23:30+07:00, so `last_24h` is
  //    30 June and not 1 July.
  [{ kind: "last_24h" }, new Date("2026-07-01T16:30:00Z"), JAKARTA],
  // 4. The DST killer. 2026-03-09T04:30Z is 00:30 EDT on the day after the
  //    spring-forward, so yesterday is 2026-03-08. A resolver subtracting
  //    86,400,000 ms from the instant lands at 2026-03-08T04:30Z, which is still
  //    EST, which is 2026-03-07T23:30 local — the day before yesterday.
  [{ kind: "last_24h" }, new Date("2026-03-09T04:30:00Z"), "America/New_York"],
  // 5. West of the date line. 2026-07-01T05:00Z is 2026-06-30T18:00−11:00, so
  //    `last_24h` is 29 June where a UTC clock says 30 June.
  [{ kind: "last_24h" }, new Date("2026-07-01T05:00:00Z"), "Pacific/Midway"],
  // 6. East of it, at +14:00. 2026-07-01T11:00Z is 2026-07-02T01:00, so
  //    `last_24h` is 1 July where a UTC clock says 30 June.
  [
    { kind: "last_24h" },
    new Date("2026-07-01T11:00:00Z"),
    "Pacific/Kiritimati",
  ],
  // 7. +05:45. 18:20Z + 5:45 crosses midnight to 00:05 the next day.
  [{ kind: "last_7d" }, new Date("2026-07-01T18:20:00Z"), "Asia/Kathmandu"],
  // 8. +08:45. 15:20Z + 8:45 does the same.
  [{ kind: "last_30d" }, new Date("2026-07-01T15:20:00Z"), "Australia/Eucla"],
  // 9. `last_full_month` on 1 March of a leap year ⇒ 1–29 February.
  [{ kind: "last_full_month" }, new Date("2028-03-01T05:00:00Z"), JAKARTA],
  // 10. `mtd` on the 2nd ⇒ exactly one day, the 1st. The smallest non-empty
  //     `mtd`, one day away from the rejection in case 1.
  [{ kind: "mtd" }, new Date("2026-07-02T05:00:00Z"), JAKARTA],
  // 11. A `custom` window ending on the current local day ⇒ rejection
  //     (Requirements 4.5, 4.7). Valid under Requirement 4.2 alone, which is
  //     exactly why the resolver has to be the one to refuse it.
  [
    { kind: "custom", start: "2026-06-25", end: "2026-07-01" },
    new Date("2026-07-01T05:00:00Z"),
    JAKARTA,
  ],
  // 12. An inverted `custom` window ⇒ zero local days.
  [
    { kind: "custom", start: "2026-07-10", end: "2026-07-01" },
    new Date("2026-08-01T05:00:00Z"),
    JAKARTA,
  ],
  // 13. A 32-day `custom` window ⇒ the ceiling, named.
  [
    { kind: "custom", start: "2026-06-01", end: "2026-07-02" },
    new Date("2026-08-01T05:00:00Z"),
    JAKARTA,
  ],
]

const PERIOD_NUM_RUNS = 100 + PERIOD_EXAMPLES.length

/** Two wall times in one local day, per zone. Arity: zone, date, h1, m1, h2, m2, spec. */
const SAME_DAY_EXAMPLES: [
  string,
  string,
  number,
  number,
  number,
  number,
  PeriodSpec,
][] = [
  // Local midnight and the last minute of the same local day, at +07:00. These
  // two instants are 23h59m apart and sit on opposite sides of UTC midnight,
  // which is what a UTC-clock resolver disagrees about.
  [JAKARTA, "2026-07-01", 0, 0, 23, 59, { kind: "last_24h" }],
  // The same, on the first of a month, where the answer is a rejection — so the
  // identity has to hold for rejections too, not only for windows.
  [JAKARTA, "2026-08-01", 0, 0, 23, 59, { kind: "mtd" }],
  // Across a spring-forward: 01:00 is before the shift and 12:00 after, so the
  // zone's offset differs between the two instants of one local day. An offset
  // read at `at` rather than at the window's start date breaks here.
  ["America/New_York", "2026-03-08", 1, 0, 12, 0, { kind: "last_full_month" }],
  // And across the 30-minute autumn shift in Lord Howe.
  ["Australia/Lord_Howe", "2026-04-05", 1, 0, 13, 0, { kind: "last_7d" }],
]

const SAME_DAY_NUM_RUNS = 100 + SAME_DAY_EXAMPLES.length

const TZ_EXAMPLES: [PeriodSpec, Date, string][] = [
  // The Jakarta case again, because it is the one where a host-zone read is
  // hardest to spot: the host that runs this suite may itself be at +07:00.
  [{ kind: "last_24h" }, new Date("2026-07-01T16:30:00Z"), JAKARTA],
  [{ kind: "mtd" }, new Date("2026-07-01T05:00:00Z"), JAKARTA],
  [
    { kind: "last_full_month" },
    new Date("2026-03-09T04:30:00Z"),
    "America/New_York",
  ],
]

const TZ_NUM_RUNS = 100 + TZ_EXAMPLES.length

// --- The oracle's own premises ---------------------------------------------

describe("the oracle is worth trusting", () => {
  test("every fixed-offset zone really is DST-free across 2024–2030", () => {
    // If one of these started shifting, the arithmetic oracle would report false
    // failures and the property would be worse than useless.
    for (const [timeZone, offset] of Object.entries(FIXED_OFFSET_ZONES)) {
      for (let day = RANGE_FIRST_DAY; day <= RANGE_LAST_DAY; day += 7) {
        const at = new Date(day * MS_PER_DAY)
        expect(
          oracleOffsetMinutes(timeZone, at),
          `${timeZone} shifted at ${at.toISOString()}`
        ).toBe(offset)
      }
    }
  })

  test("both DST zones really do shift, and one by half an hour", () => {
    // The DST branch has to be a DST branch. Lord Howe's 30-minute shift is the
    // reason it is here rather than a second whole-hour zone.
    const newYork = new Set(
      ["2026-01-15T12:00:00Z", "2026-07-15T12:00:00Z"].map((iso) =>
        oracleOffsetMinutes("America/New_York", new Date(iso))
      )
    )
    expect([...newYork].sort((a, b) => a - b)).toEqual([-300, -240])

    const lordHowe = new Set(
      ["2026-01-15T12:00:00Z", "2026-07-15T12:00:00Z"].map((iso) =>
        oracleOffsetMinutes("Australia/Lord_Howe", new Date(iso))
      )
    )
    expect([...lordHowe].sort((a, b) => a - b)).toEqual([630, 660])
  })

  test("the arithmetic oracle and the module agree on the Jakarta case", () => {
    const at = new Date("2026-07-01T16:30:00Z")
    expect(oracleLocalDate(JAKARTA, at)).toBe("2026-07-01")
    expect(localDateIn(JAKARTA, at)).toBe("2026-07-01")
    // And the two answers a UTC clock would give, so the case is pinned from
    // both sides.
    expect(at.toISOString().slice(0, 10)).toBe("2026-07-01")
    expect(oracleLocalDate("Pacific/Midway", at)).toBe("2026-07-01")
  })

  test("the generators reach the edges they exist for", () => {
    // A generator that never produces a first-of-month never tests Requirement
    // 4.6, and one that never lands just after local midnight in a DST zone
    // never tests the millisecond bug. Counted rather than assumed.
    const firstsOfMonth: string[] = []
    const dstMidnights: string[] = []

    fc.assert(
      fc.property(instantArb, zoneArb, (at, timeZone) => {
        const local = oracleLocalDate(timeZone, at)
        if (local.slice(8, 10) === "01") firstsOfMonth.push(local)
        if (
          (DST_ZONES as readonly string[]).includes(timeZone) &&
          Number(
            at.toLocaleString("en-US", {
              timeZone,
              hour: "2-digit",
              hourCycle: "h23",
            })
          ) === 0
        ) {
          dstMidnights.push(local)
        }
        return true
      }),
      { numRuns: 4_000 }
    )

    expect(firstsOfMonth.length).toBeGreaterThan(20)
    expect(dstMidnights.length).toBeGreaterThan(5)
  })
})

// --- Civil arithmetic against a `Date` oracle -------------------------------

describe("Requirement 4.2 — local-day arithmetic is exact", () => {
  test("the inclusive span and the day shift agree with Date", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: RANGE_FIRST_DAY - 400, max: RANGE_LAST_DAY + 400 }),
        fc.integer({ min: -400, max: 400 }),
        (day, shift) => {
          const start = isoFromEpochDay(day)
          const moved = addLocalDays(start, shift)

          expect(moved).toBe(shiftIso(start, shift))
          expect(isRealCalendarDate(moved)).toBe(true)
          expect(inclusiveLocalDaySpan(start, moved)).toBe(shift + 1)
          expect(inclusiveLocalDaySpan(start, moved)).toBe(
            oracleSpan(start, moved)
          )
        }
      )
    )
  })

  test("month lengths match Date's, leap years included", () => {
    for (let year = 1900; year <= 2400; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        expect(daysInMonth(year, month), `${year}-${month}`).toBe(
          daysInMonthOracle(year, month)
        )
      }
    }
  })

  test.each([
    [0, "+00:00"],
    [7 * 60, "+07:00"],
    [5 * 60 + 45, "+05:45"],
    [8 * 60 + 45, "+08:45"],
    [14 * 60, "+14:00"],
    [-11 * 60, "-11:00"],
    [-(9 * 60 + 30), "-09:30"],
  ])("formatUtcOffset(%i) is %s", (minutes, expected) => {
    expect(formatUtcOffset(minutes)).toBe(expected)
  })
})

// --- Property 9, part 1: the six rules, the bounds and the ceiling ----------

describe("Requirements 4.4, 4.5, 4.6, 4.7 — each rule resolves exactly", () => {
  test("every specification, instant and zone resolves as the requirement states", () => {
    fc.assert(
      fc.property(specArb, instantArb, zoneArb, (spec, at, timeZone) => {
        const result = resolvePeriod(spec, at, timeZone)

        // The current local date, from the oracle rather than from the module.
        // This single assertion is what a `getUTC*` resolver fails.
        const currentLocalDate = oracleLocalDate(timeZone, at)
        const yesterday = shiftIso(currentLocalDate, -1)

        expect(result.currentLocalDate).toBe(currentLocalDate)
        expect(result.latestAllowedEnd).toBe(yesterday)
        expect(result.kind).toBe(spec.kind)

        const expected = expectedResolution(spec, currentLocalDate)

        if (!expected.ok) {
          expect(
            result.ok,
            `expected a ${expected.code} rejection for ${spec.kind} at ` +
              `${at.toISOString()} in ${timeZone}`
          ).toBe(false)
          if (result.ok) return
          expect(result.code).toBe(expected.code)
          // Requirements 4.6, 4.7 — the message states the bound rather than
          // being a generic failure.
          expect(result.message.length).toBeGreaterThan(20)
          return
        }

        expect(
          result.ok,
          `expected ${expected.start}..${expected.end} for ${spec.kind} at ` +
            `${at.toISOString()} in ${timeZone}, got a rejection`
        ).toBe(true)
        if (!result.ok) return

        // Requirement 4.4 — the exact window, both endpoints inclusive.
        expect(result.start).toBe(expected.start)
        expect(result.end).toBe(expected.end)

        // Inclusive, well-formed, and in range.
        expect(isRealCalendarDate(result.start)).toBe(true)
        expect(isRealCalendarDate(result.end)).toBe(true)
        expect(result.start <= result.end).toBe(true)
        expect(result.days).toBe(oracleSpan(result.start, result.end))
        expect(result.days).toBeGreaterThanOrEqual(MIN_PERIOD_LOCAL_DAYS)
        expect(result.days).toBeLessThanOrEqual(MAX_PERIOD_LOCAL_DAYS)

        // Requirement 4.5 — never past yesterday, in the run's own zone.
        expect(result.end <= yesterday).toBe(true)

        // Requirement 4.9 — the resolved offset, displayable.
        expect(result.timeZone).toBe(timeZone)
        expect(result.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/)
        expect(result.utcOffset).toBe(formatUtcOffset(result.utcOffsetMinutes))
        const fixed = FIXED_OFFSET_ZONES[timeZone]
        if (fixed !== undefined) expect(result.utcOffsetMinutes).toBe(fixed)
        else {
          // For a DST zone, the offset is the one in effect on the window's
          // start date — not the one at the enqueue instant, which is what keeps
          // Requirement 4.8 true across a transition.
          expect(result.utcOffsetMinutes).toBe(
            oracleOffsetMinutes(
              timeZone,
              wallTimeInstant(timeZone, result.start, 12, 0) ??
                new Date(Date.parse(`${result.start}T12:00:00Z`))
            )
          )
        }
      }),
      { numRuns: PERIOD_NUM_RUNS, examples: PERIOD_EXAMPLES }
    )
  })

  test("the five relative rules are refused only by mtd on the first", () => {
    // The narrow claim that makes the rejection set meaningful: of the six rules,
    // only `custom` and `mtd` can fail at all, and `mtd` only on day 1.
    fc.assert(
      fc.property(
        relativeSpecArb,
        instantArb,
        zoneArb,
        (spec, at, timeZone) => {
          const result = resolvePeriod(spec, at, timeZone)
          const firstOfLocalMonth =
            oracleLocalDate(timeZone, at).slice(8, 10) === "01"

          if (spec.kind === "mtd" && firstOfLocalMonth) {
            expect(result.ok).toBe(false)
            if (!result.ok) expect(result.code).toBe("no_complete_local_day")
            return
          }
          expect(result.ok).toBe(true)
        }
      )
    )
  })
})

// --- Property 9, part 2: two instants in one local day ---------------------

describe("Requirement 4.8 — two instants in one local day resolve identically", () => {
  test("the resolution is a function of the local day, not of the instant", () => {
    fc.assert(
      fc.property(
        zoneArb,
        fc
          .integer({ min: RANGE_FIRST_DAY, max: RANGE_LAST_DAY })
          .map(isoFromEpochDay),
        fc.oneof(
          fc.constantFrom(0, 1, 2, 3, 22, 23),
          fc.integer({ min: 0, max: 23 })
        ),
        fc.oneof(fc.constantFrom(0, 30, 59), fc.integer({ min: 0, max: 59 })),
        fc.oneof(
          fc.constantFrom(0, 1, 2, 3, 22, 23),
          fc.integer({ min: 0, max: 23 })
        ),
        fc.oneof(fc.constantFrom(0, 30, 59), fc.integer({ min: 0, max: 59 })),
        specArb,
        (
          timeZone,
          date,
          firstHour,
          firstMinute,
          secondHour,
          secondMinute,
          spec
        ) => {
          const first = wallTimeInstant(timeZone, date, firstHour, firstMinute)
          const second = wallTimeInstant(
            timeZone,
            date,
            secondHour,
            secondMinute
          )

          // A spring-forward gap: that wall time does not exist. Rare enough to
          // stay well inside the global skip budget.
          fc.pre(first !== null && second !== null)

          // Non-vacuity: both instants really are in the generated local day, and
          // they really are the day the resolver reads.
          expect(oracleLocalDate(timeZone, first!)).toBe(date)
          expect(oracleLocalDate(timeZone, second!)).toBe(date)

          expect(resolvePeriod(spec, first!, timeZone)).toEqual(
            resolvePeriod(spec, second!, timeZone)
          )
        }
      ),
      { numRuns: SAME_DAY_NUM_RUNS, examples: SAME_DAY_EXAMPLES }
    )
  })

  test("the two instants are genuinely different points in time", () => {
    // Without this the property above would pass on a generator that produced
    // the same instant twice.
    const first = wallTimeInstant(JAKARTA, "2026-07-01", 0, 0)!
    const last = wallTimeInstant(JAKARTA, "2026-07-01", 23, 59)!

    expect(last.getTime() - first.getTime()).toBe(23 * 3_600_000 + 59 * 60_000)
    // And they sit on opposite sides of UTC midnight, which is the disagreement a
    // UTC-clock resolver has with a local one.
    expect(first.toISOString().slice(0, 10)).toBe("2026-06-30")
    expect(last.toISOString().slice(0, 10)).toBe("2026-07-01")
  })
})

// --- Property 9, part 3: no host or process time-zone setting -------------

const TZ_PROBES = ["UTC", "America/New_York", "Pacific/Kiritimati"] as const

/**
 * Block and line comments removed, so the source scan below reads code.
 *
 * Adequate for this one module by inspection: it contains no string or regular
 * expression literal holding `//` or `/*`, so the naive strip cannot eat code. A
 * scan over more files would want a real tokenizer.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[^\n]*?\/\/[^\n]*$/gm, (line) =>
      line.slice(0, line.indexOf("//"))
    )
}

const originalTz = process.env.TZ

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

describe("Requirement 4.8 — the resolution ignores the process timezone", () => {
  test("reassigning process.env.TZ really does change host-zone reads", () => {
    // The mechanism assertion, first. An invariance test that runs under an
    // unchanged effective zone proves nothing, and it would report green — which
    // is worse than not having it. If a future runtime stops honouring the
    // reassignment, this fails and says which assumption broke.
    const at = new Date("2026-07-01T16:30:00Z")
    const readings = TZ_PROBES.map((probe) => {
      process.env.TZ = probe
      return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()} ${at.getHours()}`
    })

    expect(new Set(readings).size).toBe(TZ_PROBES.length)
    // Named, so the failure says what the host zone was doing.
    expect(readings).toEqual(["2026-7-1 16", "2026-7-1 12", "2026-7-2 6"])
  })

  test("the resolution is identical under three process timezones", () => {
    fc.assert(
      fc.property(specArb, instantArb, zoneArb, (spec, at, timeZone) => {
        const baseline = resolvePeriod(spec, at, timeZone)
        try {
          for (const probe of TZ_PROBES) {
            process.env.TZ = probe
            expect(resolvePeriod(spec, at, timeZone)).toEqual(baseline)
          }
        } finally {
          if (originalTz === undefined) delete process.env.TZ
          else process.env.TZ = originalTz
        }
      }),
      { numRuns: TZ_NUM_RUNS, examples: TZ_EXAMPLES }
    )
  })

  test("the module reads no host zone by construction", () => {
    // The behavioural check above proves this implementation is invariant. This
    // one proves the next edit cannot quietly stop being — the whole class of
    // defect is a `Date` getter away.
    // Comments stripped first, for the reason `property-hygiene.static.test.ts`
    // gives about its own AST reads: the module *explains* why `Date.UTC` and the
    // host-zone getters are wrong here, so a scan over raw text would fail on
    // exactly the file that documents the rule best.
    const source = stripComments(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "period.ts"),
        "utf8"
      )
    )

    // Host-zone getters. `getUTC*` would not match — and is absent anyway,
    // because a UTC read is the *other* half of the same bug.
    expect(
      source.match(
        /\.get(?:FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds|TimezoneOffset)\(/g
      )
    ).toBeNull()
    expect(source.match(/\.getUTC[A-Za-z]+\(/g)).toBeNull()
    // `Date.UTC` is absent too: it maps a year below 100 onto 1900 plus that
    // year, which is what made the previous round-trip date check refuse the
    // first century.
    expect(source.includes("Date.UTC(")).toBe(false)
    expect(source.includes("process.env")).toBe(false)
    expect(source.includes("Date.now(")).toBe(false)

    // Exactly one formatter construction, and it passes an explicit zone.
    const constructions = source.match(/new Intl\.DateTimeFormat\(/g) ?? []
    expect(constructions.length).toBe(1)
    const start = source.indexOf("new Intl.DateTimeFormat(")
    expect(source.slice(start, start + 200)).toContain("timeZone,")
  })
})

// --- Rejections a typed generator cannot express ---------------------------

describe("Requirements 4.11, 4.12 — unresolvable inputs are rejections", () => {
  test.each([
    [{ kind: "last_month" }, "unrecognized_period"],
    [{ kind: "LAST_24H" }, "unrecognized_period"],
    [{}, "unrecognized_period"],
    [null, "unrecognized_period"],
    [
      { kind: "custom", start: "2026-02-31", end: "2026-03-01" },
      "invalid_custom_dates",
    ],
    [
      { kind: "custom", start: "2026-7-1", end: "2026-07-05" },
      "invalid_custom_dates",
    ],
    [{ kind: "custom", start: "2026-07-01" }, "invalid_custom_dates"],
  ])("%o is refused as %s", (spec, code) => {
    // These arrive from a stored `jsonb` definition, so the parameter's type is a
    // promise Postgres cannot keep — hence the cast, and hence the runtime guard
    // in the module.
    const result = resolvePeriod(
      spec as unknown as PeriodSpec,
      new Date("2026-08-15T05:00:00Z"),
      JAKARTA
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(code)
  })

  test("an unresolvable zone is refused, with no local date invented", () => {
    const result: ResolvedPeriod = resolvePeriod(
      { kind: "last_24h" },
      new Date("2026-08-15T05:00:00Z"),
      "Mars/Olympus_Mons"
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("unresolvable_timezone")
    // A zone the runtime cannot resolve must not silently become UTC.
    expect(result.currentLocalDate).toBeNull()
    expect(result.latestAllowedEnd).toBeNull()
  })

  test("an invalid instant is refused", () => {
    const result = resolvePeriod(
      { kind: "last_24h" },
      new Date("not a date"),
      JAKARTA
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("unresolvable_timezone")
  })
})

// --- The declared cases, also stated as readable facts ---------------------

describe("Requirement 4.4 — the declared cases, spelled out", () => {
  test("mtd on the first local day of a month is a rejection", () => {
    const result = resolvePeriod(
      { kind: "mtd" },
      new Date("2026-07-01T05:00:00Z"),
      JAKARTA
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("no_complete_local_day")
    expect(result.currentLocalDate).toBe("2026-07-01")
    expect(result.message).toContain("no complete local day")
  })

  test("last_full_month on 1 January is the whole of the previous December", () => {
    const result = resolvePeriod(
      { kind: "last_full_month" },
      new Date("2027-01-01T05:00:00Z"),
      JAKARTA
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.start).toBe("2026-12-01")
    expect(result.end).toBe("2026-12-31")
    expect(result.days).toBe(31)
  })

  test("2026-07-01T16:30Z in Asia/Jakarta resolves last_24h to 30 June", () => {
    // 23:30+07:00 on 1 July. The current local date is the 1st, so the single
    // complete local day before it is 30 June — and a resolver that read the
    // instant's own date, or UTC's, would say 1 July.
    const result = resolvePeriod(
      { kind: "last_24h" },
      new Date("2026-07-01T16:30:00Z"),
      JAKARTA
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.currentLocalDate).toBe("2026-07-01")
    expect(result.start).toBe("2026-06-30")
    expect(result.end).toBe("2026-06-30")
    expect(result.days).toBe(1)
    expect(result.utcOffset).toBe("+07:00")
    expect(result.end).not.toBe("2026-07-01")
  })

  test("the same instant one minute later, past local midnight, moves the window", () => {
    // 2026-07-01T17:00Z is 2026-07-02T00:00+07:00 — a new local day, so
    // `last_24h` becomes 1 July. The pair pins the boundary from both sides.
    const before = resolvePeriod(
      { kind: "last_24h" },
      new Date("2026-07-01T16:59:00Z"),
      JAKARTA
    )
    const after = resolvePeriod(
      { kind: "last_24h" },
      new Date("2026-07-01T17:00:00Z"),
      JAKARTA
    )
    expect(before.ok && before.end).toBe("2026-06-30")
    expect(after.ok && after.end).toBe("2026-07-01")
  })

  test("the resolution survives the process TZ being set to three zones", () => {
    const at = new Date("2026-07-01T16:30:00Z")
    const answers = TZ_PROBES.map((probe) => {
      process.env.TZ = probe
      const result = resolvePeriod({ kind: "last_24h" }, at, JAKARTA)
      return result.ok ? `${result.start}..${result.end}` : `!${result.code}`
    })

    expect(answers).toEqual([
      "2026-06-30..2026-06-30",
      "2026-06-30..2026-06-30",
      "2026-06-30..2026-06-30",
    ])
  })
})
