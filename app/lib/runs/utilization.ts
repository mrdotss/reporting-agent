import "server-only"
import { z } from "zod"

import { getSnapshotJson } from "@/lib/aws/s3"
import type { ReportRun } from "@/lib/db/schema"
import { snapshotArtifactKey } from "@/lib/db/views"

/**
 * The three busiest virtual machines in a completed run, read from its snapshot.
 *
 * The snapshot is the source every figure in the document was compiled from, so these
 * numbers are the same numbers the report prints — nothing is recomputed here. Each
 * resource carries a flat `statistics` array of `{ metric, statistic, value, unit }`
 * objects (the agent's `collect/snapshot.py` explains why it is flat); this reads the
 * `avg` of `Percentage CPU` and, where the agent derived it, the `avg` of
 * `memory_used_pct`.
 *
 * Returns `[]` for a run that has no snapshot, a snapshot that cannot be read, or an
 * estate with no virtual machine that reported CPU — the card then does not render.
 */

export type VmUtilization = {
  readonly resourceId: string
  readonly name: string
  /** Average CPU over the period, percent, as the snapshot stores it. */
  readonly cpuAvg: number
  readonly cpuText: string
  /** Average memory in use, percent, when the agent derived it. */
  readonly memoryAvg: number | null
  readonly memoryText: string | null
}

const VM_TYPE = "microsoft.compute/virtualmachines"
const CPU_METRIC = "percentage cpu"
const MEMORY_METRIC = "memory_used_pct"

/** Under this average CPU a machine is flagged as idle all period. */
export const IDLE_CPU_PERCENT = 10

const statisticSchema = z.object({
  metric: z.string(),
  statistic: z.string(),
  value: z.union([z.string(), z.number()]),
})

const snapshotSchema = z.object({
  resources: z
    .array(
      z
        .object({
          resource_id: z.string().min(1),
          name: z.string().optional().catch(undefined),
          resource_type: z.string().optional().catch(undefined),
          statistics: z
            .array(statisticSchema.nullable().catch(null))
            .optional()
            .catch(undefined),
        })
        .nullable()
        .catch(null)
    )
    .optional()
    .catch(undefined),
})

function readAvg(
  statistics: readonly (z.output<typeof statisticSchema> | null)[] | undefined,
  metric: string
): { value: number; text: string } | null {
  const hit = statistics?.find(
    (entry) =>
      entry !== null &&
      entry.metric.trim().toLowerCase() === metric &&
      entry.statistic.toLowerCase() === "avg"
  )
  if (!hit) return null
  const value = Number(hit.value)
  return Number.isFinite(value) ? { value, text: String(hit.value) } : null
}

export async function loadTopUtilization(
  run: ReportRun,
  count = 3
): Promise<readonly VmUtilization[]> {
  if (run.status !== "completed" || run.snapshotId === null) return []

  try {
    const parsed = snapshotSchema.safeParse(
      await getSnapshotJson(snapshotArtifactKey(run.userId, run.id))
    )
    if (!parsed.success) return []

    const machines: VmUtilization[] = []
    for (const resource of parsed.data.resources ?? []) {
      if (resource === null) continue
      if (resource.resource_type?.toLowerCase() !== VM_TYPE) continue
      const cpu = readAvg(resource.statistics, CPU_METRIC)
      if (cpu === null) continue
      const memory = readAvg(resource.statistics, MEMORY_METRIC)
      machines.push({
        resourceId: resource.resource_id,
        name: resource.name ?? resource.resource_id.split("/").at(-1) ?? resource.resource_id,
        cpuAvg: cpu.value,
        cpuText: cpu.text,
        memoryAvg: memory?.value ?? null,
        memoryText: memory?.text ?? null,
      })
    }

    return machines.sort((a, b) => b.cpuAvg - a.cpuAvg).slice(0, count)
  } catch (thrown) {
    // A cosmetic panel must never fail the report page. The key is left out of the log
    // because it carries the actor id.
    console.error(
      `[runs/utilization] the snapshot for run ${run.id} could not be read: ` +
        `${thrown instanceof Error ? thrown.name : typeof thrown}`
    )
    return []
  }
}
