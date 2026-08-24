/**
 * Lossless gap grouping for the report detail view (Requirements 20.1–20.5,
 * 20.11, 20.12).
 *
 * **No `import "server-only"`** — deliberately: the expansion control is a client
 * component and the grouping must run where the entries are rendered. This module
 * touches no SDK and no secret, so the boundary rule is satisfied by what it does
 * not import.
 *
 * ## The sentinel spelling
 *
 * `\u0000` cannot appear in an Azure metric name or resource id, and NUL sorts
 * before every printable character in Unicode code-point order. So "the no-metric
 * key sorts before every metric" is a **consequence** of the spelling — there is
 * no special case in the comparator.
 *
 * ## Contiguity
 *
 * A contiguous group is one whose starts, sorted ascending, each after the
 * earliest equals the preceding start advanced by **exactly** one grain step —
 * 3600s for PT1H, 900s for PT15M. A gap in the sequence (or any absent start)
 * means NO range is recorded. The range is formatted **arithmetically** from the
 * UTC offset, never through `Intl.DateTimeFormat`, so the function stays pure and
 * ICU-independent. Two machines format one range identically.
 *
 * ## Bounded residual of the arithmetic approach
 *
 * A single UTC offset is wrong for a window containing a DST transition. The
 * customer zone is Asia/Jakarta at +07:00, which is DST-free, and
 * `collect/buckets.choose_grain` already drops to PT15M for a non-whole-hour
 * offset. So the residual is bounded to zero for the stated customer and bounded
 * to one hour for any zone with a standard one-hour DST shift — no transition can
 * move the offset by more than the grain it is applied to.
 */

import type { RunGap } from "./gaps"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The key for entries whose metric is null or empty. NUL sorts before every
 * printable character so "no-metric" groups sort first with no comparator case.
 */
export const NO_METRIC_KEY = "\u0000no-metric"

/**
 * The key for entries whose resourceId is empty. Same NUL rationale as above.
 */
export const UNATTRIBUTED_RESOURCE_KEY = "\u0000unattributed"

/** Grain step in seconds: PT1H = 3600, PT15M = 900. */
export const GRAIN_STEPS: Readonly<Record<string, number>> = {
  PT1H: 3600,
  PT15M: 900,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A contiguous time range, formatted arithmetically from a UTC offset.
 * `from` is the start of the earliest interval; `to` is the start of the latest
 * interval advanced by one grain step.
 */
export type GapRange = {
  readonly from: string
  readonly to: string
}

/**
 * One inner group: a unique (resourceId, metric) pair within one gapType.
 */
export type GapInnerGroup = {
  readonly resourceId: string
  readonly metricKey: string
  readonly count: number
  readonly range: GapRange | null
  readonly representative: RunGap
}

/**
 * One top-level group: all entries sharing one gapType.
 */
export type GapTypeGroup = {
  readonly gapType: string
  readonly count: number
  readonly innerGroups: readonly GapInnerGroup[]
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build the metric key for an entry: fact key occupies the metric position if
 * present; otherwise the sentinel.
 */
function metricKeyOf(gap: RunGap): string {
  if (gap.metric === null || gap.metric === "") return NO_METRIC_KEY
  return gap.metric
}

/**
 * Build the resource key for an entry.
 */
function resourceKeyOf(gap: RunGap): string {
  if (gap.resourceId === "") return UNATTRIBUTED_RESOURCE_KEY
  return gap.resourceId
}

/**
 * Parse an ISO 8601 instant to a Unix timestamp in seconds.
 * Returns null if the value is not parseable.
 */
function parseInstant(iso: string): number | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return ms / 1000
}



/**
 * Format a Unix timestamp (seconds) arithmetically as an ISO 8601 datetime with
 * no timezone library, returning UTC (Z suffix).
 *
 * We format in UTC here; the caller can apply offset display when presenting.
 * However, the spec says "expressed in the run's timezone with the resolved UTC
 * offset shown" — so we format with the UTC offset applied arithmetically.
 */
function formatTimestampWithOffset(
  epochSeconds: number,
  utcOffsetSeconds: number
): string {
  // Apply offset arithmetically
  const adjusted = epochSeconds + utcOffsetSeconds
  // Format from adjusted epoch as if it were UTC (the offset is already applied)
  const ms = adjusted * 1000
  const d = new Date(ms)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  const hour = String(d.getUTCHours()).padStart(2, "0")
  const minute = String(d.getUTCMinutes()).padStart(2, "0")
  const second = String(d.getUTCSeconds()).padStart(2, "0")

  // Format the offset string
  const sign = utcOffsetSeconds >= 0 ? "+" : "-"
  const absOffset = Math.abs(utcOffsetSeconds)
  const offsetHours = String(Math.floor(absOffset / 3600)).padStart(2, "0")
  const offsetMinutes = String(
    Math.floor((absOffset % 3600) / 60)
  ).padStart(2, "0")

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHours}:${offsetMinutes}`
}

/**
 * Parse a UTC offset string like "+07:00" or "-05:30" into seconds.
 * Returns 0 if unparseable.
 */
export function parseUtcOffset(offset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset)
  if (!match) return 0
  const sign = match[1] === "+" ? 1 : -1
  const hours = Number(match[2])
  const minutes = Number(match[3])
  return sign * (hours * 3600 + minutes * 60)
}

/**
 * Compare two RunGap entries for representative selection.
 * Ascending by resourceId, then metric (sentinel first), then intervalStart
 * (absent first), then message. Each compared in code-point order.
 */
function compareForRepresentative(a: RunGap, b: RunGap): number {
  const aResource = resourceKeyOf(a)
  const bResource = resourceKeyOf(b)
  if (aResource < bResource) return -1
  if (aResource > bResource) return 1

  const aMetric = metricKeyOf(a)
  const bMetric = metricKeyOf(b)
  if (aMetric < bMetric) return -1
  if (aMetric > bMetric) return 1

  // Interval start: absent sorts first (less than any present value)
  const aStart = a.intervalStart ?? ""
  const bStart = b.intervalStart ?? ""
  if (aStart < bStart) return -1
  if (aStart > bStart) return 1

  if (a.message < b.message) return -1
  if (a.message > b.message) return 1

  return 0
}

/**
 * Select the representative: the entry sorting first by the defined comparison.
 * Does not depend on Map iteration order — sorts the entries explicitly.
 */
function selectRepresentative(entries: readonly RunGap[]): RunGap {
  // Copy and sort to avoid depending on insertion/iteration order.
  const sorted = [...entries].sort(compareForRepresentative)
  return sorted[0]
}

/**
 * Compute the range for a group with a known UTC offset, formatting
 * arithmetically.
 */
function computeRangeWithOffset(
  entries: readonly RunGap[],
  grainStep: number,
  utcOffsetSeconds: number
): GapRange | null {
  const starts: number[] = []
  for (const entry of entries) {
    if (entry.intervalStart === null) return null
    const ts = parseInstant(entry.intervalStart)
    if (ts === null) return null
    starts.push(ts)
  }

  if (starts.length === 0) return null

  starts.sort((a, b) => a - b)

  for (let i = 1; i < starts.length; i++) {
    if (starts[i] - starts[i - 1] !== grainStep) return null
  }

  const earliest = starts[0]
  const latest = starts[starts.length - 1]
  const rangeEnd = latest + grainStep

  return {
    from: formatTimestampWithOffset(earliest, utcOffsetSeconds),
    to: formatTimestampWithOffset(rangeEnd, utcOffsetSeconds),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type GroupGapsOptions = {
  /** The run's resolved grain, e.g. "PT1H" or "PT15M". */
  readonly grain: string
  /** The run's resolved UTC offset, e.g. "+07:00". */
  readonly utcOffset: string
}

/**
 * Group a run's collection_log entries losslessly (Requirements 20.1–20.5, 20.11, 20.12).
 *
 * - Groups first by `gapType`, then within each type by `(resourceId, metric)`.
 * - A fact gap's fact key occupies the metric position.
 * - Entries with null/empty metric use the NO_METRIC_KEY sentinel.
 * - Entries with empty resourceId use the UNATTRIBUTED_RESOURCE_KEY sentinel.
 * - Per-group counts sum to exactly the supplied entry count.
 * - Duplicate entries (identical in all four fields) are counted separately.
 * - No input or output operation; derived from supplied entries alone.
 */
export function groupGaps(
  gaps: readonly RunGap[],
  options: GroupGapsOptions
): readonly GapTypeGroup[] {
  const grainStep = GRAIN_STEPS[options.grain]
  const utcOffsetSeconds = parseUtcOffset(options.utcOffset)

  // Step 1: group by gapType
  const byType = new Map<string, RunGap[]>()
  for (const gap of gaps) {
    const existing = byType.get(gap.gapType)
    if (existing !== undefined) {
      existing.push(gap)
    } else {
      byType.set(gap.gapType, [gap])
    }
  }

  // Step 2: build the result, sorted by gapType in code-point order
  const typeKeys = [...byType.keys()].sort()
  const result: GapTypeGroup[] = []

  for (const gapType of typeKeys) {
    const entries = byType.get(gapType)!

    // Group within type by (resourceId, metricKey)
    const byInner = new Map<string, RunGap[]>()
    for (const entry of entries) {
      const rKey = resourceKeyOf(entry)
      const mKey = metricKeyOf(entry)
      const innerKey = `${rKey}\u0000${mKey}`
      const existing = byInner.get(innerKey)
      if (existing !== undefined) {
        existing.push(entry)
      } else {
        byInner.set(innerKey, [entry])
      }
    }

    // Build inner groups, sorted by (resourceKey, metricKey) ascending
    const innerKeys = [...byInner.keys()].sort()
    const innerGroups: GapInnerGroup[] = []

    for (const innerKey of innerKeys) {
      const innerEntries = byInner.get(innerKey)!
      const representative = selectRepresentative(innerEntries)
      const mKey = metricKeyOf(innerEntries[0])

      const range =
        grainStep !== undefined
          ? computeRangeWithOffset(innerEntries, grainStep, utcOffsetSeconds)
          : null

      innerGroups.push({
        resourceId: innerEntries[0].resourceId,
        metricKey: mKey,
        count: innerEntries.length,
        range,
        representative,
      })
    }

    result.push({
      gapType,
      count: entries.length,
      innerGroups,
    })
  }

  return result
}
