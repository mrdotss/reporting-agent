import "server-only"

import { z } from "zod"

import { getSnapshotJson } from "@/lib/aws/s3"
import type { ReportRun } from "@/lib/db/schema"

/**
 * What became of each agent paragraph in one report (`agent.json`, written by the runtime
 * beside the report). A paragraph the agent could not write never stops a delivery: the
 * preset's note stands in for it, or nothing does — and this is how the report's page says
 * which ones, and why, so the consultant knows before the customer reads it.
 *
 * `null` when the report has no agent paragraphs, did not complete, or the file cannot be
 * read: the page then shows nothing rather than a guess.
 */

const OUTCOMES = ["written", "note", "omitted"] as const

const agentSchema = z.object({
  schema_version: z.literal(1),
  paragraphs: z
    .array(
      z.object({
        block_id: z.string(),
        section_id: z.string(),
        section_title: z.string(),
        outcome: z.enum(OUTCOMES),
        reason: z.string(),
      })
    )
    .max(64),
})

export type AgentParagraphOutcome = {
  readonly blockId: string
  readonly sectionTitle: string
  readonly outcome: (typeof OUTCOMES)[number]
  readonly reason: string
}

export function parseAgentOutcomes(raw: unknown): readonly AgentParagraphOutcome[] | null {
  const parsed = agentSchema.safeParse(raw)
  if (!parsed.success || parsed.data.paragraphs.length === 0) return null
  return parsed.data.paragraphs.map((paragraph) => ({
    blockId: paragraph.block_id,
    sectionTitle: paragraph.section_title,
    outcome: paragraph.outcome,
    reason: paragraph.reason,
  }))
}

export async function loadAgentOutcomes(run: Pick<ReportRun, "id" | "userId" | "status">): Promise<readonly AgentParagraphOutcome[] | null> {
  if (run.status !== "completed") return null
  try {
    return parseAgentOutcomes(await getSnapshotJson(`${run.userId}/reports/${run.id}/agent.json`))
  } catch {
    return null
  }
}
