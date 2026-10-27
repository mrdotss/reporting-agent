import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Real figures for the canvas, from a faked snapshot: what is picked out of it, how bytes
 * become GiB, and that an unreadable snapshot is refused rather than drawn half.
 */

const store = vi.hoisted(() => ({ snapshot: null as unknown, keys: [] as string[], fail: false }))

vi.mock("@/lib/aws/s3", () => ({
  getSnapshotJson: async (key: string) => {
    store.keys.push(key)
    if (store.fail) throw new Error("NoSuchKey")
    return store.snapshot
  },
}))

const { CanvasDataUnreadableError, loadCanvasData, MAX_PER_TYPE, MAX_RESOURCES } = await import("./canvas-data")

const run = {
  actorId: "user-1",
  runId: "run-1",
  snapshotId: "snap",
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  timezone: "Asia/Jakarta",
}

function stat(metric: string, statistic: string, value: string, unit = "percent") {
  return { metric, statistic, value, unit }
}

function vm(name: string, avg: string, max: string, extra: Record<string, unknown> = {}) {
  return {
    resource_id: `/subscriptions/x/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/${name}`,
    name,
    resource_type: "Microsoft.Compute/virtualMachines",
    location: "indonesiacentral",
    resource_group: "rg-a",
    power_state: "running",
    statistics: [
      stat("Percentage CPU", "avg", avg),
      stat("Percentage CPU", "max", max),
      stat("Percentage CPU", "p95", "40.00"),
      stat("Available Memory Bytes", "avg", String(2 * 1024 ** 3), "bytes"),
    ],
    day_buckets: [
      { local_day: "2026-09-01", statistics: [stat("Percentage CPU", "max", "50.00")] },
      { local_day: "2026-09-02", statistics: [stat("Percentage CPU", "max", "70.00")] },
    ],
    month_buckets: [{ local_month: "2026-08", statistics: [stat("Percentage CPU", "avg", "9.00")] }],
    facts: [{ key: "vm_size", value: "Standard_B2ts_v2", formatted: "Standard_B2ts_v2" }],
    ...extra,
  }
}

beforeEach(() => {
  store.keys = []
  store.fail = false
  store.snapshot = {
    subscription_id: "00000000-0000-0000-0000-0000000095a4",
    resources: [
      vm("quiet", "1.00", "20.00"),
      vm("busy", "30.00", "90.00"),
      vm("off", "0.10", "0.50", { power_state: "deallocated" }),
      { resource_id: "/x/disk", name: "disk-1", resource_type: "Microsoft.Compute/disks", resource_group: "rg-b", statistics: [] },
    ],
  }
})

describe("loadCanvasData", () => {
  test("reads the run's own snapshot and keeps what the canvas draws", async () => {
    const data = await loadCanvasData(run, { name: "MSDN", provider: "azure" })
    expect(store.keys).toEqual(["user-1/snapshots/run-1/snapshot.json"])
    expect(data.kind).toBe("real")
    expect(data.source).toEqual({ name: "MSDN", start: "2026-09-01", end: "2026-09-30" })
    expect(data.scope).toEqual({ idTail: "95a4", places: ["rg-a", "rg-b"] })
    expect(data.counts).toEqual({ resources: 4, stopped: 1, unprotected: null })

    const busy = data.resources[0]!
    expect(busy.name).toBe("busy")
    expect([busy.avg, busy.peak]).toEqual([30, 90])
    expect(busy.cells).toMatchObject({ vm_size: "Standard_B2ts_v2", location: "indonesiacentral", resource_group: "rg-a" })
    expect(busy.series).toEqual({ "percentage cpu|max": [50, 70] })
    expect(busy.months).toEqual({ "percentage cpu|avg": [{ month: "2026-08", value: 9 }] })
    expect(busy.stats).toMatchObject({ "percentage cpu|avg": 30, "percentage cpu|p95": 40, "available memory bytes|avg": 2 })
    expect(busy.type).toBe("Microsoft.Compute/virtualMachines")
  })

  test("keeps the busiest of each type when the estate is large", async () => {
    const rule = (index: number) => ({
      resource_id: `sgr-${index}`,
      name: `sgr-${index}`,
      resource_type: "AWS::EC2::SecurityGroupRule",
      location: "ap-southeast-1",
    })
    store.snapshot = {
      subscription_id: "123456789012",
      resources: [
        ...Array.from({ length: MAX_PER_TYPE + 5 }, (_, index) => rule(index)),
        ...Array.from({ length: MAX_PER_TYPE + 5 }, (_, index) => vm(`vm-${index}`, "1.00", `${index}.00`)),
        vm("stopped", "x", "x"),
      ],
    }
    const data = await loadCanvasData(run, { name: "acct", provider: "aws" })
    const ofType = (type: string) => data.resources.filter((resource) => resource.type === type)
    expect(ofType("Microsoft.Compute/virtualMachines")).toHaveLength(MAX_PER_TYPE)
    expect(ofType("AWS::EC2::SecurityGroupRule")).toHaveLength(MAX_PER_TYPE)
    expect(data.resources[0]!.name).toBe(`vm-${MAX_PER_TYPE + 4}`)
    expect(data.resources.some((resource) => resource.name === "stopped")).toBe(false)
    expect(data.resources.length).toBeLessThanOrEqual(MAX_RESOURCES)
    expect(data.counts.resources).toBe(2 * (MAX_PER_TYPE + 5) + 1)
    expect(data.scope).toEqual({ idTail: "9012", places: ["ap-southeast-1", "indonesiacentral"] })
  })

  test.each([
    ["a snapshot that cannot be read", () => (store.fail = true)],
    ["a snapshot with no resources", () => (store.snapshot = { resources: [] })],
    ["something that is not a snapshot", () => (store.snapshot = "nope")],
  ])("refuses %s", async (_, arrange) => {
    arrange()
    await expect(loadCanvasData(run, { name: "x", provider: "azure" })).rejects.toBeInstanceOf(CanvasDataUnreadableError)
  })
})
