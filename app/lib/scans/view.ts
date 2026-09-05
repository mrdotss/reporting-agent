import { z } from "zod"

/**
 * Reading a scan's `jsonb` columns back, and deciding whether the author may proceed.
 *
 * ## Why these are parsed rather than cast
 *
 * `ScanView` types `typeCounts`, `childTypeCounts` and `resourceGroups` as `unknown`, and
 * that is correct rather than lazy: a `jsonb` column is whatever some writer put there, and
 * the writer may be an older or newer deploy than the reader. `as` would make the shape a
 * promise; a parse makes it a fact. This follows `lib/runs/gaps.ts`, which parses stored
 * snapshot gaps with `.catch()` for the same stated reason — "the app reads a document a
 * newer or an older agent wrote".
 *
 * Each parser is **lenient about the container and strict about the values**: a malformed
 * column reads as empty rather than throwing, because a scan screen that renders nothing is
 * recoverable and one that crashes is not. What it must never do is invent a number — an
 * unreadable count is absent, not zero.
 */

/**
 * A per-type count map. Values must be non-negative integers; anything else is dropped.
 *
 * Mirrors the agent's own `read_counts`, which skips a row whose count is absent, negative
 * or not an integer rather than zero-filling it. A type present with an unreadable count is
 * not a type with no resources, and the two must not render identically.
 */
export const typeCountsSchema = z
  .record(z.string().min(1), z.number().int().nonnegative())
  .catch({})

/** A list of distinct strings — resource groups, regions. Non-strings are dropped. */
export const stringListSchema = z.array(z.string().min(1)).catch([])

export function readTypeCounts(value: unknown): Readonly<Record<string, number>> {
  const parsed = typeCountsSchema.safeParse(value)
  if (!parsed.success) return {}
  // A key whose value failed the element schema is absent from `parsed.data` already;
  // `.catch({})` covers only a wholly unusable column.
  return parsed.data
}

/**
 * The per-region resource count. Same schema as `typeCounts` — keys are region names,
 * values are non-negative integers. An unreadable count stays absent, never zero-filled.
 */
export function readRegionCounts(value: unknown): Readonly<Record<string, number>> {
  const parsed = typeCountsSchema.safeParse(value)
  if (!parsed.success) return {}
  return parsed.data
}

export function readStringList(value: unknown): readonly string[] {
  const parsed = stringListSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

/**
 * The verdicts the agent's probe records, mirroring `VERDICT_*` in
 * `agent/.../azure/regions.py`.
 *
 * `unknown` is not a third kind of failure — it means the probe could not complete, so
 * nothing was observed. Requirement 5.5 is explicit that this must not be recorded as a
 * refusal by omission, and the screen must not present it as one.
 */
export const PROBE_VERDICTS = ["reachable", "refused", "unknown"] as const

export type ProbeVerdict = (typeof PROBE_VERDICTS)[number]

export type RegionProbe = {
  readonly region: string
  /** `null` when the probe could not complete, or when a DNS failure meant no server answered. */
  readonly statusCode: number | null
  readonly verdict: ProbeVerdict
  readonly probedAt: string
}

const regionProbeSchema = z.object({
  region: z.string().min(1),
  status_code: z.number().int().nullable().catch(null),
  verdict: z.enum(PROBE_VERDICTS),
  probed_at: z.string().min(1),
})

/**
 * The scan's recorded region probes. Pure.
 *
 * A row whose `verdict` is not one the agent declares is **dropped**, not coerced to
 * `unknown`: an unrecognised verdict means this reader and that writer disagree about the
 * vocabulary, and inventing a verdict on the reader's side would present a guess as an
 * observation. Dropping it means the region simply is not mentioned, which is the honest
 * outcome for a row nobody here can interpret.
 */
export function readRegionProbes(value: unknown): readonly RegionProbe[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    const parsed = regionProbeSchema.safeParse(row)
    if (!parsed.success) return []
    return [
      {
        region: parsed.data.region,
        statusCode: parsed.data.status_code,
        verdict: parsed.data.verdict,
        probedAt: parsed.data.probed_at,
      },
    ]
  })
}

/**
 * The regions whose data plane refused, which are the ones worth telling the author about.
 *
 * `unknown` is deliberately **excluded**. Requirement 5.4 lets the screen state a risk for a
 * region recorded fallback-only; a probe that could not complete has recorded no such thing,
 * and listing it beside genuine refusals would turn "we did not find out" into "we found a
 * problem" — which is the inference-as-observation this product exists to remove.
 */
export function refusedRegions(probes: readonly RegionProbe[]): readonly RegionProbe[] {
  return probes.filter((probe) => probe.verdict === "refused")
}

export type ScanGate =
  | { readonly kind: "ready" }
  | { readonly kind: "running" }
  | { readonly kind: "failed"; readonly code: string | null }
  | { readonly kind: "empty" }

/**
 * Whether the author may continue from the scan to step 2 — and if not, why.
 *
 * `empty` is the **authoring-time form of the `EMPTY_SCOPE` gate**, and it is the reason
 * this function exists rather than an inline `resourceCount > 0` at the call site.
 * `azure-integration.md` records why that gate is load-bearing: zero resources means zero
 * figures, which means zero *unverifiable* figures, so a run over an empty scope passes
 * collection, compilation, rendering **and verification** and delivers a clean, fully
 * verified, empty report. Every gate is green and the artifact is worthless. Requirement 4.9
 * moves that refusal forward to authoring, where the fix — a wrong subscription, a role
 * assignment that is too narrow — is still in front of the person who can make it.
 *
 * A count that is **absent** (`null`) is not zero: it is a scan that has not answered yet,
 * which is `running`. Conflating the two would refuse to continue from a scan that is
 * merely in flight, and — worse in the other direction — would let a `null` read as a
 * non-zero count if the comparison were written the other way round.
 *
 * `childTypeCounts` is deliberately **not** consulted. A subscription holding only
 * sub-records cannot occur (a subnet implies a virtual network), but if it somehow did, the
 * honest answer is still that there is nothing reportable to author against — which is what
 * the headline count already says. Counting sub-records here would be the same category
 * error as counting them in "Total Resources".
 */
export function scanGate(scan: {
  readonly status: string
  readonly resourceCount: number | null
  readonly errorCode: string | null
}): ScanGate {
  if (scan.status === "failed") return { kind: "failed", code: scan.errorCode }
  if (scan.status !== "complete") return { kind: "running" }
  if (scan.resourceCount === null) return { kind: "running" }
  if (scan.resourceCount <= 0) return { kind: "empty" }
  return { kind: "ready" }
}

/**
 * Whether the scan's own counts may be shown as figures.
 *
 * The defect this exists for: the scan page rendered "Types", "Regions" and "Resource
 * groups" as `Object.keys(counts).length` and two `array.length`s, over empty defaults that
 * are there to keep the lists below renderable. A scan that failed — a Resource Graph 400,
 * in the case that surfaced it — stores a row with no counts, so the page answered **0
 * types, 0 regions, 0 resource groups** for a subscription it had learned nothing about, and
 * a consultant read that as an empty estate. It is the same misreading Requirement 9.9 names
 * and that `distinct_dimensions` raises rather than commit, undone one layer up in the
 * presentation.
 *
 * `resourceCount` was already honest, because a scan that did not complete stores it as
 * `null` and the figure renders an em dash. This gives the other three the same footing:
 * "not answered" and "none" are different facts and must not share a glyph.
 *
 * Not folded into {@link scanGate}: that answers whether authoring may continue, and a
 * `ready` scan and an `empty` one both have counts worth showing. This is the narrower
 * question of whether any number here is a statement about the subscription.
 */
export function countsAreReported(
  scan: { readonly status: string } | null
): boolean {
  return scan !== null && scan.status === "complete"
}

/** Whether the "Continue" control is offered at all. */
export function mayContinue(gate: ScanGate): boolean {
  return gate.kind === "ready"
}
