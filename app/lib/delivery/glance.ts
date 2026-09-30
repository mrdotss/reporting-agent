import "server-only"

import { z } from "zod"

import { getSnapshotJson } from "@/lib/aws/s3"

/**
 * At a glance as the report printed it (`glance.json`, written by the runtime beside the
 * report), for the email and the customer's page. Every value is the verified figure's own
 * printed string and every decision the sentence on the page, so the email quotes nothing
 * the document does not say. `null` when the report has no At a glance section, or the file
 * cannot be read: the email then goes without it rather than not at all.
 */

const glanceSchema = z.object({
  decisions_title: z.string(),
  figures: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })).max(8),
  decisions: z.array(z.string()).max(5),
})

export type Glance = {
  readonly decisionsTitle: string
  readonly figures: readonly { readonly label: string; readonly value: string }[]
  readonly decisions: readonly string[]
}

export function parseGlance(raw: unknown): Glance | null {
  const parsed = glanceSchema.safeParse(raw)
  if (!parsed.success || parsed.data.figures.length === 0) return null
  return {
    decisionsTitle: parsed.data.decisions_title,
    figures: parsed.data.figures.map(({ label, value }) => ({ label, value })),
    decisions: parsed.data.decisions,
  }
}

export async function readGlance(userId: string, runId: string): Promise<Glance | null> {
  try {
    return parseGlance(await getSnapshotJson(`${userId}/reports/${runId}/glance.json`))
  } catch {
    return null
  }
}
