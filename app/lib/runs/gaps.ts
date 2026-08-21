import "server-only"

import { z } from "zod"

import { getSnapshotJson } from "@/lib/aws/s3"
import type { ReportRun } from "@/lib/db/schema"
import { snapshotArtifactKey } from "@/lib/db/views"
import { isTerminalStatus } from "@/lib/runs/state"

/**
 * The gap list, and the run's snapshot provenance, read from the snapshot object
 * (Requirements 36.7, 40.4, 40.5).
 *
 * ## Why the snapshot object is the store
 *
 * `report_runs` carries `gap_count` but not the gaps, and the terminal progress
 * callback carries only counts (Requirement 38.12). The gaps themselves live in
 * the snapshot, which is where the collector wrote them and which is immutable and
 * content-addressed — so reading them from there needs **neither a column nor a
 * table**, and there is no second copy that could disagree with the artifact a
 * customer was handed.
 *
 * It also keeps Requirement 40.5 true: the relay may emit only what is
 * reconstructible from the `report_runs` row and the stored gap list, and the
 * snapshot *is* that stored gap list.
 *
 * ## Read once, on a terminal row only
 *
 * The relay polls the row every two seconds; it must not poll S3. Every function
 * here returns an empty result for a non-terminal run without making a request,
 * so the read happens once, at the moment the row goes terminal, and never on the
 * polling path.
 *
 * ## Nothing here throws for a missing or malformed snapshot
 *
 * A gap list is *supporting* information beside a run's outcome, not the outcome
 * itself. A `completed` row whose snapshot object cannot be read or parsed is
 * still a completed run, and failing the run detail page — or worse, the relay —
 * because a gap list could not be fetched would turn a cosmetic problem into an
 * apparent run failure. So every failure resolves as "no gaps known", logged, with
 * the key excluded from the log line.
 *
 * The parse is a zod parse rather than a cast. The snapshot is the agent's
 * document, produced in another language by another process, so it is external
 * input and gets a boundary schema like a request body does (Requirement 7.7's
 * rule, one boundary over).
 */

// --- The gap ----------------------------------------------------------------

/**
 * One `collection_log` entry, as the snapshot carries it.
 *
 * Five of the six fields the agent's `collect/log.py` writes. The sixth, `source`, is
 * the named source a **fact** gap queried, and it is deliberately not read here: this
 * app groups by `(resourceId, metric)` and `source` is not part of that key, so reading
 * it would add a field with no consumer. It is in the snapshot when a consumer wants it.
 *
 * `gap_type` is
 * a **plain string** rather than a union of the agent's declared values:
 * this app groups by it and displays it, and a build of the app that met an
 * undeclared type must render it rather than reject the whole list. The agent is
 * where the value set is closed — it raises on an undeclared `gap_type` before a
 * snapshot exists — so re-closing it here would only add a way for the two halves
 * to disagree about a document that has already been written.
 *
 * `metric` is `null` for a resource-level gap, which is a genuine absence: a
 * permission denial is about the resource, not about one of its metrics.
 *
 * `intervalStart` is `null` for every gap that is not about one interval, and
 * carries the interval's own start instant for the two that are —
 * `interval_counts_missing` and `interval_malformed`. It is what makes a
 * contiguous stretch of gaps visible as one stretch: a VM emitting nothing for
 * 64 hours across eight metrics records ~512 entries, and grouping them into a
 * time range rather than a list of 512 is only possible if each one says when.
 */
export type RunGap = {
  readonly gapType: string
  readonly resourceId: string
  readonly metric: string | null
  readonly message: string
  readonly intervalStart: string | null
}

/**
 * The gap shape inside a snapshot.
 *
 * `.catch(null)` on `metric` rather than `.optional()`: the agent always writes
 * the key and writes `null` for a resource-level gap, and a value that is neither
 * a string nor `null` should not discard the entry's other four fields.
 *
 * `interval_start` gets the same `.catch(null)` for a different reason, and the
 * difference is worth stating because it is the one field here the agent
 * **omits** rather than writing as `null`: it omits it so that adding the field
 * did not change the canonical bytes — and therefore the `content_hash` — of
 * every snapshot whose gaps predate it. `.catch(null)` covers the absent key, the
 * explicit `null` and a non-string alike, all three collapsing to the same `null`,
 * which is the right answer for all three: this app reads a document a newer or
 * an older agent wrote, and "no interval is named" is one fact however it is
 * spelled. `.optional()` would instead make `intervalStart` `string | undefined`
 * at every consumer for no gain.
 */
const snapshotGapSchema = z.object({
  gap_type: z.string().min(1),
  resource_id: z.string().min(1),
  metric: z.string().min(1).nullable().catch(null),
  message: z.string(),
  interval_start: z.string().min(1).nullable().catch(null),
})

/**
 * The half of the snapshot document this module reads.
 *
 * Every field is optional and unknown keys are ignored, because this is a *view*
 * of somebody else's document: a snapshot written by a newer agent carrying fields
 * this build has never heard of must still yield its gap list.
 *
 * `gaps` uses an element-wise catch rather than `z.array(...).catch([])`: one
 * malformed entry should cost that entry, not the other two hundred. The `null`s
 * are filtered out below.
 */
const snapshotDocumentSchema = z.object({
  gaps: z.array(snapshotGapSchema.nullable().catch(null)).catch([]),
  grain: z.string().min(1).optional().catch(undefined),
  timezone: z.string().min(1).optional().catch(undefined),
  utc_offset: z.string().min(1).optional().catch(undefined),
  window: z
    .object({
      start: z.string().optional().catch(undefined),
      end: z.string().optional().catch(undefined),
      start_utc: z.string().optional().catch(undefined),
      end_utc: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  resources: z
    .array(
      z
        .object({ fidelity_tier: z.string().optional().catch(undefined) })
        .nullable()
        .catch(null)
    )
    .optional()
    .catch(undefined),
})

// --- The one read -----------------------------------------------------------

/**
 * The parsed snapshot for a terminal run, or `null`.
 *
 * Module-private, so there is exactly one place that builds the key, one place
 * that makes the request and one place that swallows a failure. Both exported
 * functions go through it, which means a page that wants gaps *and* provenance
 * costs two reads rather than one — an acceptable price for two independent
 * callers, and the object is small and immutable so the alternative would be a
 * cache with an invalidation question that has no answer worth having.
 *
 * The `status` gate is the important line: `snapshotArtifactKey` is *positional*,
 * so it names an object for a run that has not produced one, and a `GetObject`
 * against it would be a 404 per poll for every in-flight run.
 */
async function readSnapshot(
  run: ReportRun
): Promise<z.output<typeof snapshotDocumentSchema> | null> {
  // A run only has a snapshot once it completed. `failed` is terminal too, and a
  // failed run wrote none — `EMPTY_SCOPE` above all, which is the case where
  // there was nothing to write.
  if (run.status !== "completed") return null

  const key = snapshotArtifactKey(run.userId, run.id)

  try {
    const parsed = snapshotDocumentSchema.safeParse(await getSnapshotJson(key))

    if (!parsed.success) {
      // Unreachable in practice — every field carries a `.catch` — but a schema
      // edited later could make it reachable, and silently returning `null`
      // there would look like a run with no gaps.
      console.error(
        `[runs/gaps] the snapshot for run ${run.id} did not parse; ` +
          `no gap list is available for it`
      )
      return null
    }

    return parsed.data
  } catch (thrown) {
    // The key is excluded: it carries the actor id, and this line ends up in a
    // log aggregator. The run id is enough to find the object by hand.
    console.error(
      `[runs/gaps] the snapshot for run ${run.id} could not be read: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )
    return null
  }
}

// --- The gap list -----------------------------------------------------------

/**
 * Every `collection_log` entry this run recorded (Requirements 36.7, 40.4).
 *
 * `[]` for a non-terminal run, for a failed run, and for a completed run whose
 * snapshot could not be read — all three with no exception raised. A gap is
 * neutral information: the UI renders it in mist neutrals rather than
 * `--destructive`, and its absence is not an error state either.
 *
 * The returned array is in the snapshot's own order, which the agent sorted by
 * `gap_type` then `resource_id` then `metric`. Re-sorting here would be a second
 * opinion about an ordering the immutable document already fixed.
 */
export async function loadRunGaps(run: ReportRun): Promise<readonly RunGap[]> {
  if (!isTerminalStatus(run.status)) return []

  const snapshot = await readSnapshot(run)
  if (snapshot === null) return []

  return snapshot.gaps
    .filter((gap): gap is NonNullable<typeof gap> => gap !== null)
    .map((gap) => ({
      gapType: gap.gap_type,
      resourceId: gap.resource_id,
      metric: gap.metric,
      message: gap.message,
      intervalStart: gap.interval_start,
    }))
}

// --- Provenance -------------------------------------------------------------

/**
 * The collection window, the grain and the tier split — what the run detail
 * screen's provenance panel states.
 *
 * The zone **and** its resolved offset, both named, because that is the whole
 * point of the panel: "July 2026" means July in Asia/Jakarta, and a reader
 * checking a figure against their own records needs to know which seven hours
 * were included. `startUtc` and `endUtc` are the half-open instants the collector
 * actually queried, so the window is stated in both frames rather than left to be
 * inferred.
 */
export type RunProvenance = {
  readonly snapshotId: string
  readonly grain: string | null
  readonly timezone: string | null
  readonly utcOffset: string | null
  readonly localStart: string | null
  readonly localEnd: string | null
  readonly startUtc: string | null
  readonly endUtc: string | null
  /** Resource counts by `fidelity_tier`, as the snapshot recorded them. */
  readonly fidelityTiers: Readonly<Record<string, number>>
}

/**
 * The provenance of a completed run's snapshot, or `null`.
 *
 * Separate from {@link loadRunGaps} rather than bundled with it because the two
 * have different consumers: the relay needs the gap list and must never need
 * anything else, while the provenance panel is a server-rendered page. Keeping
 * them apart is what stops the relay's payload from growing a field that is not
 * reconstructible from the row and the gap list (Requirement 40.5).
 *
 * Every field is nullable independently, so a snapshot missing one — an older
 * agent, a newer schema — yields a panel that omits that line instead of a page
 * that fails.
 */
export async function loadRunProvenance(
  run: ReportRun
): Promise<RunProvenance | null> {
  if (run.status !== "completed" || run.snapshotId === null) return null

  const snapshot = await readSnapshot(run)
  if (snapshot === null) return null

  const fidelityTiers: Record<string, number> = {}
  for (const resource of snapshot.resources ?? []) {
    const tier = resource?.fidelity_tier
    if (tier === undefined) continue
    fidelityTiers[tier] = (fidelityTiers[tier] ?? 0) + 1
  }

  return {
    snapshotId: run.snapshotId,
    grain: snapshot.grain ?? null,
    // The row's `timezone` is the requested one and the snapshot's is the one
    // collection resolved against. They agree, and the snapshot's is preferred
    // here because this panel describes the artifact rather than the request.
    timezone: snapshot.timezone ?? run.timezone,
    utcOffset: snapshot.utc_offset ?? null,
    localStart: snapshot.window?.start ?? run.periodStart,
    localEnd: snapshot.window?.end ?? run.periodEnd,
    startUtc: snapshot.window?.start_utc ?? null,
    endUtc: snapshot.window?.end_utc ?? null,
    fidelityTiers: Object.freeze(fidelityTiers),
  }
}
