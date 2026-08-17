/**
 * The `Period_Resolver` — a period specification plus an instant plus a zone in,
 * an inclusive local window out (Requirements 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.8,
 * 4.9, 4.11, 4.12).
 *
 * **Pure, and deliberately not `server-only`.** No clock, no environment, no
 * I/O. `at` and `timeZone` are parameters, which is the whole point of the
 * signature: the resolution derives from the run's timezone and the current
 * instant and from **no host or process time-zone setting** (Requirement 4.8),
 * so two enqueue instants in the same local day resolve identically and a test
 * can pin any boundary at an instant and a zone it picks. The wizard's step 3
 * shows what a rule resolves to at the current instant (Requirement 11.7) from a
 * client component, so this module has to be importable from the browser as well
 * as from the enqueue.
 *
 * ## Why this module owns the period vocabulary and the calendar arithmetic
 *
 * `lib/templates/definition.ts` carried a private `isRealCalendarDate` and a
 * private `inclusiveLocalDaySpan` for Requirement 4.2's custom-period
 * constraints, and this module needs the identical arithmetic for every one of
 * the six rules. Two copies of local-day arithmetic is exactly the thing that
 * drifts — one gets a leap-year fix and the other does not, and then the wizard
 * accepts a definition the enqueue refuses — so both helpers moved **here** and
 * `definition.ts` imports them.
 *
 * That decided the direction of the dependency. `PERIOD_KINDS`, `PeriodKind` and
 * `PeriodSpec` moved here too, because the resolver needs `PERIOD_KINDS` as a
 * *value* (Requirement 4.11 — a pinned version whose kind is not one of the six
 * is a rejection, which is a runtime membership test) and importing it from
 * `definition.ts` while `definition.ts` imports the arithmetic from here would be
 * a genuine runtime import cycle. `definition.ts` re-exports all three under
 * their original names, so every existing importer is unaffected.
 *
 * `lib/runs/input.ts` (foundation spec) keeps its own `checkPeriod` **policy** —
 * foundation Requirement 37.10 permits a period ending *today*, and Requirement
 * 4.5 here does not, so folding the two policies together would conflate two
 * different rules — but its calendar and zone *primitives* now delegate to this
 * module, so there is one implementation of "what local day is it" and "how many
 * local days is that" in the app.
 *
 * ## No `Date` arithmetic anywhere near a calendar
 *
 * Two traps are avoided structurally rather than by care:
 *
 * 1. **A local calendar date is never read off a `Date`.** `getFullYear` /
 *    `getMonth` / `getDate` answer in the *host* zone and `getUTCFullYear` and
 *    friends answer in UTC — both wrong for a customer at UTC+07:00, and the
 *    second is wrong in a way that looks right for seven hours of every day. The
 *    only way an instant becomes a civil date here is
 *    {@link localCivilDateIn}, which asks `Intl.DateTimeFormat` with an
 *    explicit `timeZone` and reads `formatToParts` by part type rather than
 *    parsing a locale's format string.
 * 2. **A day is never 86,400,000 milliseconds.** Adding a day's worth of
 *    milliseconds to an *instant* and re-reading it in a DST-observing zone
 *    lands on the wrong local date for any wall time within the transition's
 *    shift of midnight — `America/New_York` at 00:30 local on the day after a
 *    spring-forward resolves "yesterday" to the day before yesterday. All
 *    day arithmetic here runs on the **civil date** through
 *    {@link daysFromCivil} / {@link civilFromDays}, Howard Hinnant's
 *    `days_from_civil` / `civil_from_days` pair, which is exact proleptic
 *    Gregorian integer arithmetic with no `Date` and therefore no zone, no DST
 *    and no two-digit-year mapping (`Date.UTC(50, 0, 1)` is 1950, which is why
 *    the previous round-trip check refused every year below 0100).
 *
 * ## Rejection is a returned value, not a thrown error
 *
 * {@link resolvePeriod} returns a discriminated union, matching how
 * `definition.ts` returns issues rather than throwing. Requirement 4.6 requires
 * the enqueue to *state* that the period contains no complete local day **and**
 * to retain the consultant's subscription, template and period selections for
 * correction; Requirement 4.7 requires it to name which bound was violated.
 * Both are things the caller does with the answer, so the answer has to be a
 * value it handles rather than an exception it catches.
 *
 * ## Requirement 4.5's "never past yesterday" is checked here, once
 *
 * Requirement 4.7 assigns the bound checks to the Enqueue_Action, and Requirement
 * 4.5 assigns the never-past-yesterday rule to the Period_Resolver. Since
 * `resolvePeriod` already has both the instant and the zone in hand, it applies
 * **both** — a `custom` window ending today or later is a rejection from here,
 * not from a second check the enqueue would have to remember to make. One place
 * decides, and the enqueue's job is to turn the rejection into a response. Note
 * this is strictly stronger than Requirement 4.2, which the Template_Validator
 * enforces at save time: a `custom` window that was entirely in the past when it
 * was saved becomes a rejection the day it stops being so, and that is correct —
 * the definition is still valid, this particular run of it is not.
 */

// --- The period vocabulary (Requirement 4.1) --------------------------------

/** Requirement 4.1 — exactly six case-sensitive values. */
export const PERIOD_KINDS = [
  "last_24h",
  "last_7d",
  "last_30d",
  "last_full_month",
  "mtd",
  "custom",
] as const
export type PeriodKind = (typeof PERIOD_KINDS)[number]

export type PeriodSpec =
  | { readonly kind: Exclude<PeriodKind, "custom"> }
  | { readonly kind: "custom"; readonly start: string; readonly end: string }

/**
 * Requirement 4.2 / 4.7 — the inclusive local-day span a period may carry.
 *
 * 31 is the longest calendar month, which is the unit this product is about and
 * the point the collector's scaling was measured at (200 resources × 6 metrics ×
 * 31 days at `PT1H`). 1 is a single-day spot check. A span below 1 is exactly a
 * window whose start is after its end, which is why there is no separate
 * "inverted" bound.
 */
export const MIN_PERIOD_LOCAL_DAYS = 1
export const MAX_PERIOD_LOCAL_DAYS = 31

// --- Civil dates -----------------------------------------------------------

/** A calendar date with no zone and no instant. `month` is 1–12. */
export type CivilDate = {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** `YYYY-MM-DD`, and nothing looser. */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0")
}

/** Proleptic Gregorian leap rule. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** Days in `month` (1–12) of `year`. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return MONTH_LENGTHS[month - 1]
}

/**
 * Days from the Unix epoch (`1970-01-01`) to `date`.
 *
 * Hinnant's `days_from_civil`: shift the year to start in March so the leap day
 * lands last, then count eras of 400 years. Exact for every proleptic Gregorian
 * date, with no `Date` and therefore no zone, no DST and no year-below-100
 * surprise.
 */
export function daysFromCivil(date: CivilDate): number {
  const shiftedYear = date.month <= 2 ? date.year - 1 : date.year
  const era = Math.floor(shiftedYear / 400)
  const yearOfEra = shiftedYear - era * 400
  const marchIndexedMonth = (date.month + 9) % 12
  const dayOfYear = Math.floor((153 * marchIndexedMonth + 2) / 5) + date.day - 1
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear
  return era * 146_097 + dayOfEra - 719_468
}

/** The inverse of {@link daysFromCivil} — Hinnant's `civil_from_days`. */
export function civilFromDays(days: number): CivilDate {
  const shifted = days + 719_468
  const era = Math.floor(shifted / 146_097)
  const dayOfEra = shifted - era * 146_097
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365
  )
  const shiftedYear = yearOfEra + era * 400
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const marchIndexedMonth = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * marchIndexedMonth + 2) / 5) + 1
  const month =
    marchIndexedMonth < 10 ? marchIndexedMonth + 3 : marchIndexedMonth - 9
  return { year: month <= 2 ? shiftedYear + 1 : shiftedYear, month, day }
}

/** `YYYY-MM-DD`, zero-padded, as the `date` columns persist it. */
export function formatCivilDate(date: CivilDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`
}

/**
 * `YYYY-MM-DD` to a {@link CivilDate}, or `null` if the string does not name a
 * calendar date that exists.
 *
 * `2026-02-31` matches the pattern and names no day; the check is against the
 * month's real length rather than a `Date` round trip, which is what keeps it
 * exact for a year below 0100 as well.
 */
export function parseCivilDate(value: string): CivilDate | null {
  if (!LOCAL_DATE_PATTERN.test(value)) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

/** Is this a `YYYY-MM-DD` calendar date that exists? */
export function isRealCalendarDate(value: string): boolean {
  return parseCivilDate(value) !== null
}

/**
 * `date` shifted by `days` local days, as `YYYY-MM-DD`.
 *
 * Civil arithmetic, so a DST-observing zone is irrelevant: shifting a *date* has
 * nothing to do with how many hours that date happened to contain.
 */
export function addLocalDays(date: string, days: number): string {
  const civil = parseCivilDate(date)
  if (civil === null) {
    throw new RangeError(`addLocalDays received a non-date: ${date}`)
  }
  return formatCivilDate(civilFromDays(daysFromCivil(civil) + days))
}

/**
 * The count of local days from `start` to `end` inclusive, negative-or-zero when
 * `end` precedes `start`.
 *
 * Returns `0` for either endpoint that is not a real date, which no caller here
 * reaches: `definition.ts` checks both endpoints first, and
 * {@link resolvePeriod} rejects a malformed `custom` window before it measures
 * one. Returning a number rather than throwing keeps it usable from a validator
 * that is collecting every violation rather than stopping at the first.
 */
export function inclusiveLocalDaySpan(start: string, end: string): number {
  const startCivil = parseCivilDate(start)
  const endCivil = parseCivilDate(end)
  if (startCivil === null || endCivil === null) return 0
  return daysFromCivil(endCivil) - daysFromCivil(startCivil) + 1
}

// --- Instants to local dates ------------------------------------------------

/**
 * One `Intl.DateTimeFormat` per zone, reused.
 *
 * Constructing a formatter is the expensive part of this module by an order of
 * magnitude, and the property test asks for several thousand resolutions.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * `hourCycle: "h23"` so midnight is `00` rather than `24` or `12 AM`, and every
 * part is read **by type** from `formatToParts` rather than by parsing the
 * locale's assembled string. `en-US` is a Gregorian-calendar locale; the format
 * it would produce is never used.
 */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  zoneFormatters.set(timeZone, formatter)
  return formatter
}

type WallClock = CivilDate & {
  readonly hour: number
  readonly minute: number
  readonly second: number
}

function wallClockIn(timeZone: string, at: Date): WallClock {
  const parts = zoneFormatter(timeZone).formatToParts(at)
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)
    if (part === undefined) {
      throw new RangeError(`Intl produced no ${type} part for ${timeZone}`)
    }
    return Number(part.value)
  }
  // `hourCycle: "h23"` is asked for above; some ICU builds still answer `24`
  // for midnight, which is the same instant expressed as the previous day's
  // hour 24. Normalizing to 0 is safe because the date parts already name the
  // day the wall clock belongs to.
  const hour = read("hour")
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: hour === 24 ? 0 : hour,
    minute: read("minute"),
    second: read("second"),
  }
}

/**
 * Is `timeZone` a zone this runtime can resolve?
 *
 * `Intl.DateTimeFormat` throws a `RangeError` for a zone its tzdata does not
 * carry, which is the platform telling us it cannot bucket local days there. A
 * zone that cannot be resolved must not become a silent UTC.
 */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    zoneFormatter(timeZone).format(new Date(0))
    return true
  } catch {
    return false
  }
}

/** The calendar date `at` falls on, in `timeZone`. */
export function localCivilDateIn(timeZone: string, at: Date): CivilDate {
  const wall = wallClockIn(timeZone, at)
  return { year: wall.year, month: wall.month, day: wall.day }
}

/**
 * The calendar date `at` falls on in `timeZone`, as `YYYY-MM-DD`.
 *
 * The argument order matches `lib/runs/input.ts`'s long-standing export, which
 * now delegates here.
 */
export function localDateIn(timeZone: string, at: Date): string {
  return formatCivilDate(localCivilDateIn(timeZone, at))
}

/**
 * The zone's offset from UTC, in minutes, at the instant `at`.
 *
 * Read as the difference between the wall clock the zone shows and the wall
 * clock UTC shows, which is the definition of the offset and needs no offset
 * table. `+05:45` and `+08:45` fall out of it as naturally as `+07:00`.
 */
export function utcOffsetMinutesAt(timeZone: string, at: Date): number {
  const wall = wallClockIn(timeZone, at)
  const wallAsIfUtc =
    daysFromCivil(wall) * MS_PER_DAY +
    (wall.hour * 3_600 + wall.minute * 60 + wall.second) * 1_000
  return Math.round((wallAsIfUtc - at.getTime()) / MS_PER_MINUTE)
}

/**
 * The zone's offset in effect on the local date `date`, in minutes.
 *
 * Probed at **local noon**, which is the part that matters: an offset probed at
 * local midnight sits on top of every DST transition there is, and noon is
 * twelve hours from either edge of the day in every zone that has ever shifted
 * its clocks. Finding the instant of local noon needs one round trip — guess
 * with UTC noon, correct by the offset that guess lands in, correct once more —
 * which converges for every real zone because the correction is at most a day
 * and the offset is constant across noon.
 *
 * Probing from the resolved window's **start date** rather than from `at` is
 * what keeps Requirement 4.8 true: two instants in the same local day can sit
 * on opposite sides of a DST transition (a transition happens at about 02:00
 * local), so an offset read at `at` would make two same-day instants resolve to
 * two different answers.
 */
export function utcOffsetMinutesOn(timeZone: string, date: string): number {
  const civil = parseCivilDate(date)
  if (civil === null) {
    throw new RangeError(`utcOffsetMinutesOn received a non-date: ${date}`)
  }
  const wallNoon = daysFromCivil(civil) * MS_PER_DAY + 12 * 3_600 * 1_000
  const firstGuess = new Date(wallNoon)
  const firstOffset = utcOffsetMinutesAt(timeZone, firstGuess)
  const corrected = new Date(wallNoon - firstOffset * MS_PER_MINUTE)
  const secondOffset = utcOffsetMinutesAt(timeZone, corrected)
  return utcOffsetMinutesAt(
    timeZone,
    new Date(wallNoon - secondOffset * MS_PER_MINUTE)
  )
}

/** `+07:00`, `-11:00`, `+05:45`, `+00:00` — Requirement 4.9's display form. */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  const absolute = Math.abs(minutes)
  return `${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`
}

// --- The resolution ---------------------------------------------------------

/**
 * Why a period could not be resolved into a collectable window.
 *
 * Each member is one of the rejections Requirements 4.6, 4.7, 4.11 and 4.12
 * name, kept distinct because they are different mistakes with different
 * corrections: a template whose kind the reader does not recognize is a pinned
 * version problem, a window ending today is a rule problem, and a 40-day custom
 * window is a selection problem.
 */
export type PeriodRejectionCode =
  /** Requirement 4.11 — the kind is absent or outside the six. */
  | "unrecognized_period"
  /** The zone is one this runtime cannot resolve, or `at` is not an instant. */
  | "unresolvable_timezone"
  /** Requirement 4.12 — a `custom` endpoint is missing or names no real day. */
  | "invalid_custom_dates"
  /** Requirement 4.6 — zero local days, including `mtd` on the first. */
  | "no_complete_local_day"
  /** Requirement 4.7 — above {@link MAX_PERIOD_LOCAL_DAYS}. */
  | "exceeds_maximum_days"
  /** Requirements 4.5, 4.7 — the end is after the local day preceding today. */
  | "ends_after_yesterday"

export type ResolvedPeriodWindow = {
  readonly ok: true
  readonly kind: PeriodKind
  /** Inclusive local start, `YYYY-MM-DD`, as `report_runs.period_start` holds it. */
  readonly start: string
  /** Inclusive local end, `YYYY-MM-DD`, as `report_runs.period_end` holds it. */
  readonly end: string
  /** Inclusive local day count, 1 to {@link MAX_PERIOD_LOCAL_DAYS}. */
  readonly days: number
  readonly timeZone: string
  /** Requirement 4.9 — the offset in effect on {@link start}, e.g. `+07:00`. */
  readonly utcOffset: string
  readonly utcOffsetMinutes: number
  /** The date component of `at` in `timeZone` — Requirement 4.3's `current local date`. */
  readonly currentLocalDate: string
  /** {@link currentLocalDate} minus one day — Requirement 4.5's ceiling. */
  readonly latestAllowedEnd: string
}

export type PeriodRejection = {
  readonly ok: false
  readonly code: PeriodRejectionCode
  /** Requirements 4.6, 4.7 — states the bound, for the consultant to correct. */
  readonly message: string
  /** The kind that was asked for, or `null` when it was not recognizable. */
  readonly kind: PeriodKind | null
  /** `null` only when the zone could not be resolved, so no local date exists. */
  readonly currentLocalDate: string | null
  readonly latestAllowedEnd: string | null
}

export type ResolvedPeriod = ResolvedPeriodWindow | PeriodRejection

export const NO_COMPLETE_LOCAL_DAY_MESSAGE =
  "The requested period contains no complete local day. The current local day " +
  "is still in progress and a partial day would understate every daily figure, " +
  "so a period ends on the local day before today at the latest."

/**
 * Resolve `spec` against the instant `at`, in `timeZone`.
 *
 * Pure. Call it at enqueue, record `start` and `end` on the row, and never
 * resolve again (Requirements 4.3, 4.10) — a run whose phases span local
 * midnight collects, compiles, renders and verifies over one unchanged window.
 */
export function resolvePeriod(
  spec: PeriodSpec,
  at: Date,
  timeZone: string
): ResolvedPeriod {
  // A single widening view, so an unrecognized or absent `kind` arriving from a
  // stored `jsonb` definition is a rejection rather than a crash. Requirement
  // 4.11 is explicitly about a *pinned* version, which is data read back out of
  // Postgres, so the type on the parameter is a promise the database cannot keep.
  const raw = spec as
    | {
        readonly kind?: unknown
        readonly start?: unknown
        readonly end?: unknown
      }
    | null
    | undefined

  const kind: PeriodKind | null =
    raw !== null &&
    raw !== undefined &&
    typeof raw.kind === "string" &&
    (PERIOD_KINDS as readonly string[]).includes(raw.kind)
      ? (raw.kind as PeriodKind)
      : null

  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    return {
      ok: false,
      code: "unresolvable_timezone",
      message:
        "The enqueue instant is not a valid point in time, so no local date " +
        "can be derived from it.",
      kind,
      currentLocalDate: null,
      latestAllowedEnd: null,
    }
  }

  if (!isSupportedTimeZone(timeZone)) {
    return {
      ok: false,
      code: "unresolvable_timezone",
      message:
        `"${timeZone}" is not a timezone this runtime can resolve, so local ` +
        "days cannot be bucketed in it.",
      kind,
      currentLocalDate: null,
      latestAllowedEnd: null,
    }
  }

  const currentCivil = localCivilDateIn(timeZone, at)
  const currentLocalDate = formatCivilDate(currentCivil)
  // Requirement 4.5 — the ceiling on every resolution, in every branch below.
  const latestAllowedEnd = formatCivilDate(
    civilFromDays(daysFromCivil(currentCivil) - 1)
  )

  if (kind === null) {
    return {
      ok: false,
      code: "unrecognized_period",
      message:
        "The pinned template version declares an unrecognized period " +
        `specification. Expected one of: ${PERIOD_KINDS.join(", ")}.`,
      kind: null,
      currentLocalDate,
      latestAllowedEnd,
    }
  }

  const reject = (
    code: PeriodRejectionCode,
    message: string
  ): PeriodRejection => ({
    ok: false,
    code,
    message,
    kind,
    currentLocalDate,
    latestAllowedEnd,
  })

  // Requirement 4.4 — the six rules, each stated once.
  let start: string
  let end: string

  switch (kind) {
    case "last_24h": {
      start = latestAllowedEnd
      end = latestAllowedEnd
      break
    }
    case "last_7d": {
      end = latestAllowedEnd
      start = addLocalDays(end, -6)
      break
    }
    case "last_30d": {
      end = latestAllowedEnd
      start = addLocalDays(end, -29)
      break
    }
    case "last_full_month": {
      // The whole local calendar month preceding the current local month. Taken
      // as "the day before the first of this month", so month lengths and leap
      // years come from the calendar rather than from a table here.
      const firstOfCurrentMonth: CivilDate = {
        year: currentCivil.year,
        month: currentCivil.month,
        day: 1,
      }
      const lastOfPreviousMonth = civilFromDays(
        daysFromCivil(firstOfCurrentMonth) - 1
      )
      start = formatCivilDate({
        year: lastOfPreviousMonth.year,
        month: lastOfPreviousMonth.month,
        day: 1,
      })
      end = formatCivilDate(lastOfPreviousMonth)
      break
    }
    case "mtd": {
      start = formatCivilDate({
        year: currentCivil.year,
        month: currentCivil.month,
        day: 1,
      })
      end = latestAllowedEnd
      break
    }
    case "custom": {
      const declaredStart = typeof raw?.start === "string" ? raw.start : null
      const declaredEnd = typeof raw?.end === "string" ? raw.end : null
      if (
        declaredStart === null ||
        declaredEnd === null ||
        !isRealCalendarDate(declaredStart) ||
        !isRealCalendarDate(declaredEnd)
      ) {
        return reject(
          "invalid_custom_dates",
          "A custom period declares an inclusive local start date and an " +
            "inclusive local end date, each a real calendar date in YYYY-MM-DD form."
        )
      }
      start = declaredStart
      end = declaredEnd
      break
    }
  }

  const days = inclusiveLocalDaySpan(start, end)

  // Requirement 4.6 — zero (or inverted) local days, `mtd` on the first
  // included. Checked before the ceiling, because an empty window has no
  // meaningful end to compare.
  if (days < MIN_PERIOD_LOCAL_DAYS) {
    return reject("no_complete_local_day", NO_COMPLETE_LOCAL_DAY_MESSAGE)
  }

  // Requirement 4.7 — the upper bound, named.
  if (days > MAX_PERIOD_LOCAL_DAYS) {
    return reject(
      "exceeds_maximum_days",
      `A period spans at most ${MAX_PERIOD_LOCAL_DAYS} local days; this one ` +
        `spans ${days}.`
    )
  }

  // Requirements 4.5, 4.7. String comparison is correct for `YYYY-MM-DD`: the
  // format is fixed-width and big-endian, so lexical order is chronological.
  if (end > latestAllowedEnd) {
    return reject(
      "ends_after_yesterday",
      `A period ends on ${latestAllowedEnd} at the latest — the local day ` +
        `preceding ${currentLocalDate} in ${timeZone}. The current local day is ` +
        "still in progress, and a partial trailing day would understate every " +
        "daily figure derived from it."
    )
  }

  const utcOffsetMinutes = utcOffsetMinutesOn(timeZone, start)

  return {
    ok: true,
    kind,
    start,
    end,
    days,
    timeZone,
    utcOffset: formatUtcOffset(utcOffsetMinutes),
    utcOffsetMinutes,
    currentLocalDate,
    latestAllowedEnd,
  }
}
