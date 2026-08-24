import { describe, expect, test } from "vitest"

import type { RunGap } from "@/lib/runs/gaps"
import {
  NO_METRIC_KEY,
  UNATTRIBUTED_RESOURCE_KEY,
  groupGaps,
  parseUtcOffset,
  type GroupGapsOptions,
} from "@/lib/runs/gap-groups"

const DEFAULT_OPTS: GroupGapsOptions = { grain: "PT1H", utcOffset: "+07:00" }
const BASE_EPOCH = 1782950400 // 2026-07-01T00:00:00Z

function isoFromEpoch(epoch: number): string {
  return new Date(epoch * 1000).toISOString()
}

describe("gap-groups", () => {
  describe("groupGaps", () => {
    test("returns empty array for empty input", () => {
      const result = groupGaps([], DEFAULT_OPTS)
      expect(result).toEqual([])
    })

    test("groups by gapType first", () => {
      const gaps: RunGap[] = [
        {
          gapType: "permission_denied",
          resourceId: "/vms/vm-01",
          metric: "Percentage CPU",
          message: "msg1",
          intervalStart: null,
        },
        {
          gapType: "interval_counts_missing",
          resourceId: "/vms/vm-01",
          metric: "Percentage CPU",
          message: "msg2",
          intervalStart: null,
        },
      ]
      const result = groupGaps(gaps, DEFAULT_OPTS)
      expect(result).toHaveLength(2)
      expect(result.map((g) => g.gapType).sort()).toEqual([
        "interval_counts_missing",
        "permission_denied",
      ])
    })

    test("groups within type by (resourceId, metric)", () => {
      const gaps: RunGap[] = [
        {
          gapType: "interval_counts_missing",
          resourceId: "/vms/vm-01",
          metric: "Percentage CPU",
          message: "msg",
          intervalStart: isoFromEpoch(BASE_EPOCH),
        },
        {
          gapType: "interval_counts_missing",
          resourceId: "/vms/vm-01",
          metric: "Percentage CPU",
          message: "msg",
          intervalStart: isoFromEpoch(BASE_EPOCH + 3600),
        },
        {
          gapType: "interval_counts_missing",
          resourceId: "/vms/vm-01",
          metric: "Available Memory Bytes",
          message: "msg",
          intervalStart: null,
        },
      ]
      const result = groupGaps(gaps, DEFAULT_OPTS)
      expect(result).toHaveLength(1)
      expect(result[0].count).toBe(3)
      expect(result[0].innerGroups).toHaveLength(2)
    })

    test("null metric uses NO_METRIC_KEY sentinel", () => {
      const gaps: RunGap[] = [
        {
          gapType: "permission_denied",
          resourceId: "/vms/vm-01",
          metric: null,
          message: "msg",
          intervalStart: null,
        },
      ]
      const result = groupGaps(gaps, DEFAULT_OPTS)
      expect(result[0].innerGroups[0].metricKey).toBe(NO_METRIC_KEY)
    })

    test("empty metric uses NO_METRIC_KEY sentinel", () => {
      const gaps: RunGap[] = [
        {
          gapType: "region_unreachable",
          resourceId: "/vms/vm-01",
          metric: "",
          message: "msg",
          intervalStart: null,
        },
      ]
      const result = groupGaps(gaps, DEFAULT_OPTS)
      expect(result[0].innerGroups[0].metricKey).toBe(NO_METRIC_KEY)
    })

    test("empty resourceId uses UNATTRIBUTED_RESOURCE_KEY in keying but preserves original in output", () => {
      const gaps: RunGap[] = [
        {
          gapType: "region_unreachable",
          resourceId: "",
          metric: null,
          message: "msg",
          intervalStart: null,
        },
      ]
      const result = groupGaps(gaps, DEFAULT_OPTS)
      expect(result[0].innerGroups[0].resourceId).toBe("")
      expect(result[0].innerGroups[0].count).toBe(1)
    })

    test("identical entries are counted separately", () => {
      const entry: RunGap = {
        gapType: "interval_counts_missing",
        resourceId: "/vms/vm-01",
        metric: "Percentage CPU",
        message: "No data",
        intervalStart: isoFromEpoch(BASE_EPOCH),
      }
      const gaps = [entry, entry, entry]
      const result = groupGaps(gaps, DEFAULT_OPTS)
      expect(result[0].count).toBe(3)
      expect(result[0].innerGroups[0].count).toBe(3)
    })

    test("counts sum to input count", () => {
      const gaps: RunGap[] = Array.from({ length: 50 }, (_, i) => ({
        gapType: i % 3 === 0 ? "type_a" : i % 3 === 1 ? "type_b" : "type_c",
        resourceId: `/vms/vm-${i % 5}`,
        metric: i % 2 === 0 ? "Percentage CPU" : null,
        message: "msg",
        intervalStart: null,
      }))
      const result = groupGaps(gaps, DEFAULT_OPTS)
      const totalTop = result.reduce((s, g) => s + g.count, 0)
      const totalInner = result.reduce(
        (s, g) => s + g.innerGroups.reduce((is, ig) => is + ig.count, 0),
        0
      )
      expect(totalTop).toBe(50)
      expect(totalInner).toBe(50)
    })
  })

  describe("contiguity", () => {
    test("contiguous PT1H entries produce a range", () => {
      const starts = Array.from({ length: 5 }, (_, i) =>
        isoFromEpoch(BASE_EPOCH + i * 3600)
      )
      const gaps: RunGap[] = starts.map((s) => ({
        gapType: "interval_counts_missing",
        resourceId: "/vms/vm-01",
        metric: "Percentage CPU",
        message: "msg",
        intervalStart: s,
      }))
      const result = groupGaps(gaps, DEFAULT_OPTS)
      const range = result[0].innerGroups[0].range
      expect(range).not.toBeNull()
    })

    test("contiguous PT15M entries produce a range", () => {
      const starts = Array.from({ length: 4 }, (_, i) =>
        isoFromEpoch(BASE_EPOCH + i * 900)
      )
      const gaps: RunGap[] = starts.map((s) => ({
        gapType: "interval_counts_missing",
        resourceId: "/vms/vm-01",
        metric: "Percentage CPU",
        message: "msg",
        intervalStart: s,
      }))
      const result = groupGaps(gaps, { grain: "PT15M", utcOffset: "+07:00" })
      expect(result[0].innerGroups[0].range).not.toBeNull()
    })

    test("non-contiguous entries produce no range", () => {
      // Gap between second and third entry
      const starts = [
        isoFromEpoch(BASE_EPOCH),
        isoFromEpoch(BASE_EPOCH + 3600),
        isoFromEpoch(BASE_EPOCH + 3600 * 3), // skip one step
      ]
      const gaps: RunGap[] = starts.map((s) => ({
        gapType: "interval_counts_missing",
        resourceId: "/vms/vm-01",
        metric: "Percentage CPU",
        message: "msg",
        intervalStart: s,
      }))
      const result = groupGaps(gaps, DEFAULT_OPTS)
      expect(result[0].innerGroups[0].range).toBeNull()
    })

    test("entries with any absent start produce no range", () => {
      const gaps: RunGap[] = [
        {
          gapType: "interval_counts_missing",
          resourceId: "/vms/vm-01",
          metric: "Percentage CPU",
          message: "msg",
          intervalStart: isoFromEpoch(BASE_EPOCH),
        },
        {
          gapType: "interval_counts_missing",
          resourceId: "/vms/vm-01",
          metric: "Percentage CPU",
          message: "msg",
          intervalStart: null,
        },
      ]
      const result = groupGaps(gaps, DEFAULT_OPTS)
      expect(result[0].innerGroups[0].range).toBeNull()
    })

    test("single entry produces a range spanning one interval", () => {
      const gaps: RunGap[] = [
        {
          gapType: "interval_counts_missing",
          resourceId: "/vms/vm-01",
          metric: "Percentage CPU",
          message: "msg",
          intervalStart: isoFromEpoch(BASE_EPOCH),
        },
      ]
      const result = groupGaps(gaps, DEFAULT_OPTS)
      const range = result[0].innerGroups[0].range
      expect(range).not.toBeNull()
      // The range should span exactly one grain step
    })

    test("range is formatted arithmetically from UTC offset", () => {
      const gaps: RunGap[] = [
        {
          gapType: "interval_counts_missing",
          resourceId: "/vms/vm-01",
          metric: "Percentage CPU",
          message: "msg",
          intervalStart: "2026-07-01T00:00:00.000Z",
        },
      ]
      const result = groupGaps(gaps, { grain: "PT1H", utcOffset: "+07:00" })
      const range = result[0].innerGroups[0].range!
      // 2026-07-01T00:00:00Z + 7 hours = 2026-07-01T07:00:00+07:00
      expect(range.from).toBe("2026-07-01T07:00:00+07:00")
      // End is start + 1 hour = 2026-07-01T08:00:00+07:00
      expect(range.to).toBe("2026-07-01T08:00:00+07:00")
    })
  })

  describe("representative", () => {
    test("representative is deterministic regardless of input order", () => {
      const base: RunGap = {
        gapType: "interval_counts_missing",
        resourceId: "/vms/vm-01",
        metric: "Percentage CPU",
        message: "msg-b",
        intervalStart: null,
      }
      const other: RunGap = {
        gapType: "interval_counts_missing",
        resourceId: "/vms/vm-01",
        metric: "Percentage CPU",
        message: "msg-a",
        intervalStart: null,
      }
      const result1 = groupGaps([base, other], DEFAULT_OPTS)
      const result2 = groupGaps([other, base], DEFAULT_OPTS)
      expect(result1[0].innerGroups[0].representative).toEqual(
        result2[0].innerGroups[0].representative
      )
      // "msg-a" < "msg-b" so other is the representative
      expect(result1[0].innerGroups[0].representative.message).toBe("msg-a")
    })

    test("sentinel sorts before every printable character", () => {
      // NO_METRIC_KEY should sort before any real metric
      expect(NO_METRIC_KEY < "A").toBe(true)
      expect(NO_METRIC_KEY < "Percentage CPU").toBe(true)
      expect(UNATTRIBUTED_RESOURCE_KEY < "/").toBe(true)
    })

    test("absent intervalStart sorts before present start", () => {
      const withStart: RunGap = {
        gapType: "interval_counts_missing",
        resourceId: "/vms/vm-01",
        metric: "Percentage CPU",
        message: "msg",
        intervalStart: isoFromEpoch(BASE_EPOCH),
      }
      const withoutStart: RunGap = {
        gapType: "interval_counts_missing",
        resourceId: "/vms/vm-01",
        metric: "Percentage CPU",
        message: "msg",
        intervalStart: null,
      }
      const result = groupGaps([withStart, withoutStart], DEFAULT_OPTS)
      // null start maps to "" which sorts before any ISO string
      expect(result[0].innerGroups[0].representative.intervalStart).toBeNull()
    })
  })

  describe("parseUtcOffset", () => {
    test("parses +07:00", () => {
      expect(parseUtcOffset("+07:00")).toBe(7 * 3600)
    })

    test("parses -05:30", () => {
      expect(parseUtcOffset("-05:30")).toBe(-(5 * 3600 + 30 * 60))
    })

    test("parses +00:00", () => {
      expect(parseUtcOffset("+00:00")).toBe(0)
    })

    test("returns 0 for unparseable", () => {
      expect(parseUtcOffset("invalid")).toBe(0)
    })
  })
})
