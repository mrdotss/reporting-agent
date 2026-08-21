import { beforeEach, describe, expect, test, vi } from "vitest"

import type { ReportRun } from "@/lib/db/schema"

/**
 * `loadRunGaps`' boundary parse, and specifically the `intervalStart` mirror
 * (Requirement 20.4).
 *
 * ## Why this needs its own test rather than an integration assertion
 *
 * The snapshot is the agent's document, written in another language by another
 * process, so this module parses it like a request body. The interesting cases are
 * therefore all *shapes the agent might have written*, and only one of them is the
 * shape a happy-path integration test produces.
 *
 * `interval_start` is the one field the agent **omits** when it does not apply,
 * rather than writing as `null`. That is deliberate on its side — emitting `null`
 * on the twenty-odd gap types that are not about an interval would have changed the
 * canonical bytes, and therefore the `content_hash`, of every snapshot ever written.
 * The consequence here is that this app reads three spellings of the same fact —
 * key absent, key `null`, key present — and must collapse the first two to `null`
 * while carrying the third through. All three are asserted below, because a schema
 * using `.optional()` instead of `.catch(null)` would hand consumers
 * `string | undefined` for the absent case and quietly diverge from the declared
 * `RunGap` type.
 *
 * ## What is faked
 *
 * Only `getSnapshotJson`. What is left is the schema, the element-wise catch and the
 * snake-to-camel map — the whole of what this module actually decides.
 */

const { s3 } = vi.hoisted(() => ({
  s3: { body: undefined as unknown, calls: [] as string[] },
}))

vi.mock("@/lib/aws/s3", () => ({
  getSnapshotJson: async (key: string) => {
    s3.calls.push(key)
    if (s3.body === undefined) throw new Error("no such object")
    return s3.body
  },
}))

const { loadRunGaps } = await import("@/lib/runs/gaps")

const RESOURCE_ID = "/subscriptions/x/virtualMachines/prod-web-01"
const INTERVAL_START = "2026-07-01T03:00:00Z"

/** A `completed` run, which is the only status that reads the object at all. */
const RUN = {
  id: "run_01HQZY",
  userId: "user_01HQZX",
  status: "completed",
  snapshotId: "a3f9".repeat(16),
} as unknown as ReportRun

function snapshotWith(gaps: readonly unknown[]): unknown {
  return { gaps, resources: [] }
}

beforeEach(() => {
  s3.body = undefined
  s3.calls = []
})

describe("intervalStart", () => {
  test("an omitted interval_start reads as null", async () => {
    s3.body = snapshotWith([
      {
        gap_type: "permission_denied",
        resource_id: RESOURCE_ID,
        metric: null,
        message: "403 on the resource",
      },
    ])

    const gaps = await loadRunGaps(RUN)

    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.intervalStart).toBeNull()
    // Not `undefined`: the declared type is `string | null`, and a consumer
    // rendering a group header must not have to handle a third state.
    expect(Object.hasOwn(gaps[0]!, "intervalStart")).toBe(true)
  })

  test("an explicit null interval_start reads as null", async () => {
    s3.body = snapshotWith([
      {
        gap_type: "permission_denied",
        resource_id: RESOURCE_ID,
        metric: null,
        message: "403 on the resource",
        interval_start: null,
      },
    ])

    const gaps = await loadRunGaps(RUN)

    expect(gaps[0]!.intervalStart).toBeNull()
  })

  test("a present interval_start is carried through verbatim", async () => {
    s3.body = snapshotWith([
      {
        gap_type: "interval_counts_missing",
        resource_id: RESOURCE_ID,
        metric: "Percentage CPU",
        message: "omits its total or its count value",
        interval_start: INTERVAL_START,
      },
    ])

    const gaps = await loadRunGaps(RUN)

    expect(gaps[0]!.intervalStart).toBe(INTERVAL_START)
    expect(gaps[0]!.gapType).toBe("interval_counts_missing")
    expect(gaps[0]!.metric).toBe("Percentage CPU")
  })

  test("a malformed interval_start costs that field and not the entry", async () => {
    s3.body = snapshotWith([
      {
        gap_type: "interval_counts_missing",
        resource_id: RESOURCE_ID,
        metric: "Percentage CPU",
        message: "omits its total or its count value",
        interval_start: 1751337600,
      },
    ])

    const gaps = await loadRunGaps(RUN)

    // The same reasoning already recorded for `metric`: a value that is neither a
    // string nor `null` must not discard the entry's other four fields. A gap that
    // vanished would understate the recorded gap count the panel displays.
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.intervalStart).toBeNull()
    expect(gaps[0]!.message).toBe("omits its total or its count value")
  })

  test("a contiguous stretch keeps every interval it names", async () => {
    const starts = [
      "2026-07-01T00:00:00Z",
      "2026-07-01T01:00:00Z",
      "2026-07-01T02:00:00Z",
    ]
    s3.body = snapshotWith(
      starts.map((interval_start) => ({
        gap_type: "interval_counts_missing",
        resource_id: RESOURCE_ID,
        metric: "Percentage CPU",
        message: "omits its total or its count value",
        interval_start,
      }))
    )

    const gaps = await loadRunGaps(RUN)

    // The 64-hour stretch this field exists for, in miniature: three entries naming
    // three consecutive hours, and the app holding all three rather than
    // de-duplicating them into one. Grouping them into a range is a later,
    // presentational decision; losing one of them here would make that decision
    // wrong at the source.
    expect(gaps.map((gap) => gap.intervalStart)).toEqual(starts)
  })
})
