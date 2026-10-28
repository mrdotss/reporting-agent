import "server-only"

import { z } from "zod"

import { getSnapshotJson } from "@/lib/aws/s3"
import { snapshotArtifactKey } from "@/lib/db/views"
import { sampleUnit, seriesKey, type CanvasData, type SampleResource } from "@/lib/builder/sample"
import type { SnapshotRun } from "@/lib/templates/preview"

/**
 * The builder's Real figures: one connection's latest completed report, read from its
 * snapshot and shaped as the canvas's resources.
 *
 * The snapshot is what that report was compiled from, so the canvas shows the same figures
 * the report printed — nothing is recomputed beyond picking series out of the day and month
 * buckets and putting byte figures into the GiB the canvas reads them in. It is read here, by
 * the app, the way `lib/runs/utilization.ts` reads it; the runtime is not involved.
 *
 * Only what the canvas draws leaves the server: names, the table cells the catalogue's
 * columns name, the statistics and their daily and monthly values. The account or
 * subscription id is cut to its last four characters. At most {@link MAX_PER_TYPE} resources
 * of each type are kept, the busiest first, and {@link MAX_RESOURCES} in all, so a large
 * estate does not make a large payload, and a section on one type (an AWS account's RDS
 * instances among its security group rules) still finds its resources.
 */

export const MAX_PER_TYPE = 30
export const MAX_RESOURCES = 200

const STATISTICS = new Set(["avg", "max", "min", "p95"])
const STOPPED = new Set(["stopped", "stopping", "deallocated", "deallocating"])
const GIB = 1024 ** 3

const statisticSchema = z
  .object({
    metric: z.string(),
    statistic: z.string(),
    value: z.union([z.string(), z.number()]),
    unit: z.string().nullable().optional().catch(undefined),
  })
  .nullable()
  .catch(null)

const statisticsSchema = z.array(statisticSchema).optional().catch(undefined)

const resourceSchema = z
  .object({
    resource_id: z.string().min(1),
    name: z.string().nullable().optional().catch(undefined),
    resource_type: z.string().nullable().optional().catch(undefined),
    location: z.string().nullable().optional().catch(undefined),
    resource_group: z.string().nullable().optional().catch(undefined),
    power_state: z.string().nullable().optional().catch(undefined),
    statistics: statisticsSchema,
    day_buckets: z
      .array(z.object({ local_day: z.string(), statistics: statisticsSchema }).nullable().catch(null))
      .optional()
      .catch(undefined),
    month_buckets: z
      .array(z.object({ local_month: z.string(), statistics: statisticsSchema }).nullable().catch(null))
      .optional()
      .catch(undefined),
    facts: z
      .array(
        z
          .object({
            key: z.string(),
            value: z.unknown().optional(),
            formatted: z.string().nullable().optional().catch(undefined),
          })
          .nullable()
          .catch(null)
      )
      .optional()
      .catch(undefined),
  })
  .nullable()
  .catch(null)

const weekSchema = z
  .object({
    buckets: z
      .array(
        z
          .object({
            resource_type: z.string(),
            weekday: z.number().int().min(1).max(7),
            hour: z.number().int().min(0).max(23),
            statistics: statisticsSchema,
          })
          .nullable()
          .catch(null)
      )
      .optional()
      .catch(undefined),
  })
  .nullable()
  .optional()
  .catch(undefined)

const snapshotSchema = z.object({
  subscription_id: z.string().nullable().optional().catch(undefined),
  resources: z.array(resourceSchema).optional().catch(undefined),
  week: weekSchema,
})

type Statistic = NonNullable<z.output<typeof statisticSchema>>

/** One statistic in the canvas's unit, or `null` when it is not a finite number. */
function canvasValue(entry: Statistic): number | null {
  const value = Number(entry.value)
  if (!Number.isFinite(value)) return null
  const bytes = /byte/i.test(entry.unit ?? "")
  return sampleUnit(entry.metric) === "GiB" && bytes ? Number((value / GIB).toFixed(2)) : value
}

function wanted(entry: Statistic | null): entry is Statistic {
  return entry !== null && STATISTICS.has(entry.statistic.toLowerCase())
}

function cellText(value: unknown, formatted: string | null | undefined): string {
  if (typeof formatted === "string" && formatted !== "") return formatted
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "string" || typeof value === "number") return String(value)
  return ""
}

/** The ranking figure: the first percent metric with both an average and a peak, CPU first. */
function rankingOf(statistics: readonly Statistic[]): { avg: number; peak: number } {
  const metrics = [...new Set(statistics.map((entry) => entry.metric))]
    .filter((metric) => sampleUnit(metric) === "percent")
    .sort((a, b) => Number(!/cpu/i.test(a)) - Number(!/cpu/i.test(b)))
  for (const metric of metrics) {
    const avg = statistics.find((entry) => entry.metric === metric && entry.statistic === "avg")
    const peak = statistics.find((entry) => entry.metric === metric && entry.statistic === "max")
    const a = avg ? canvasValue(avg) : null
    const p = peak ? canvasValue(peak) : null
    if (a !== null && p !== null) return { avg: a, peak: p }
  }
  return { avg: 0, peak: 0 }
}

function toResource(raw: NonNullable<z.output<typeof resourceSchema>>): SampleResource {
  const name = raw.name ?? raw.resource_id.split("/").at(-1) ?? raw.resource_id
  const statistics = (raw.statistics ?? []).filter(wanted)
  const cells: Record<string, string> = {
    resource_name: name,
    location: raw.location ?? "",
    resource_group: raw.resource_group ?? "",
    power_state: raw.power_state ?? "",
    resource_type: raw.resource_type ?? "",
  }
  for (const fact of raw.facts ?? []) {
    if (fact !== null) cells[fact.key] = cellText(fact.value, fact.formatted)
  }

  const series: Record<string, number[]> = {}
  for (const day of raw.day_buckets ?? []) {
    for (const entry of (day?.statistics ?? []).filter(wanted)) {
      const value = canvasValue(entry)
      if (value === null) continue
      ;(series[seriesKey(entry.metric, entry.statistic.toLowerCase())] ??= []).push(value)
    }
  }
  const months: Record<string, { month: string; value: number }[]> = {}
  for (const month of raw.month_buckets ?? []) {
    if (month === null) continue
    for (const entry of (month.statistics ?? []).filter(wanted)) {
      const value = canvasValue(entry)
      if (value === null) continue
      ;(months[seriesKey(entry.metric, entry.statistic.toLowerCase())] ??= []).push({ month: month.local_month, value })
    }
  }

  const stats: Record<string, number> = {}
  for (const entry of statistics) {
    const value = canvasValue(entry)
    if (value !== null) stats[seriesKey(entry.metric, entry.statistic.toLowerCase())] = value
  }

  return { name, type: raw.resource_type ?? undefined, cells, ...rankingOf(statistics), stats, series, months }
}

/** The busiest {@link MAX_PER_TYPE} of each type, resources with figures ahead of those without. */
function kept(all: readonly SampleResource[]): SampleResource[] {
  const busiest = [...all].sort(
    (a, b) => Number(Object.keys(b.stats ?? {}).length > 0) - Number(Object.keys(a.stats ?? {}).length > 0) || b.peak - a.peak
  )
  const perType = new Map<string, number>()
  return busiest
    .filter((resource) => {
      const type = (resource.type ?? "").toLowerCase()
      const count = perType.get(type) ?? 0
      perType.set(type, count + 1)
      return count < MAX_PER_TYPE
    })
    .slice(0, MAX_RESOURCES)
}

/**
 * The fleet's hour-by-weekday cells (`week.buckets`, snapshot 1.4.0), as seven rows of 24
 * hours per `type|metric|statistic`, so the hour-of-week heatmap draws the report's own cells.
 * An hour nothing was folded in stays `null`.
 */
function weekGrids(week: z.output<typeof weekSchema>): Record<string, (number | null)[][]> {
  const grids: Record<string, (number | null)[][]> = {}
  for (const bucket of week?.buckets ?? []) {
    if (bucket === null) continue
    for (const entry of (bucket.statistics ?? []).filter(wanted)) {
      const value = canvasValue(entry)
      if (value === null) continue
      const key = `${bucket.resource_type.toLowerCase()}|${seriesKey(entry.metric, entry.statistic.toLowerCase())}`
      const grid = (grids[key] ??= Array.from({ length: 7 }, () => Array<number | null>(24).fill(null)))
      grid[bucket.weekday - 1]![bucket.hour] = value
    }
  }
  return grids
}

export class CanvasDataUnreadableError extends Error {
  constructor() {
    super("That report's figures could not be read. The page keeps the sample.")
    this.name = "CanvasDataUnreadableError"
  }
}

/**
 * The canvas's figures from one completed run.
 *
 * @throws CanvasDataUnreadableError when the snapshot cannot be read or holds no resource.
 */
export async function loadCanvasData(
  run: SnapshotRun,
  source: { readonly name: string; readonly provider: "aws" | "azure" }
): Promise<CanvasData> {
  let parsed: z.output<typeof snapshotSchema>
  try {
    const result = snapshotSchema.safeParse(await getSnapshotJson(snapshotArtifactKey(run.actorId, run.runId)))
    if (!result.success) throw new CanvasDataUnreadableError()
    parsed = result.data
  } catch (thrown) {
    // The key carries the actor id, so only the error's name is logged.
    console.error(
      `[templates/canvas-data] the snapshot for run ${run.runId} could not be read: ` +
        `${thrown instanceof Error ? thrown.name : typeof thrown}`
    )
    throw new CanvasDataUnreadableError()
  }

  const all = (parsed.resources ?? []).filter((resource) => resource !== null).map(toResource)
  if (all.length === 0) throw new CanvasDataUnreadableError()
  const raw = (parsed.resources ?? []).filter((resource) => resource !== null)
  const places = [
    ...new Set(raw.map((resource) => (source.provider === "aws" ? resource.location : resource.resource_group) ?? "").filter(Boolean)),
  ].slice(0, 4)

  return {
    kind: "real",
    resources: kept(all),
    counts: {
      resources: all.length,
      stopped: raw.filter((resource) => STOPPED.has((resource.power_state ?? "").toLowerCase())).length,
      unprotected: null,
    },
    scope: { idTail: (parsed.subscription_id ?? "").slice(-4), places },
    source: { name: source.name, start: run.periodStart, end: run.periodEnd },
    week: weekGrids(parsed.week),
  }
}
