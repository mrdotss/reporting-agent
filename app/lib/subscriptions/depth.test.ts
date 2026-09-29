import { describe, expect, test } from "vitest"

import { depthChecklist, type DepthGap } from "@/lib/subscriptions/depth"

const ACCOUNT = "123456789012"
const instance = (id: string) => `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/${id}`

const gap = (gapType: string, resourceId: string): DepthGap => ({ gapType, resourceId })

const byKey = (list: ReturnType<typeof depthChecklist>) =>
  Object.fromEntries(list.items.map((item) => [item.key, item]))

describe("the data-depth coach", () => {
  test("an AWS connector's gaps become counted items, one resource counted once", () => {
    const list = depthChecklist({
      provider: "aws",
      scopeVerified: true,
      metricsHistorySince: null,
      gaps: [
        gap("optimizer_not_available", instance("i-01")),
        gap("optimizer_not_available", instance("i-02")),
        // Two facts per resource, as the snapshot records them: still one resource.
        gap("backup_not_configured", instance("i-01")),
        gap("backup_not_configured", instance("i-01")),
        gap("no_samples", instance("i-02")),
      ],
    })

    expect(list.items.map((item) => item.key)).toEqual(["access", "compute_optimizer", "aws_backup", "access_errors"])
    const items = byKey(list)
    expect(items.compute_optimizer).toMatchObject({ state: "open", affected: 2 })
    expect(items.aws_backup).toMatchObject({ state: "open", affected: 1 })
    expect(items.access_errors).toMatchObject({ state: "done", affected: 0 })
    expect(list).toMatchObject({ done: 2, total: 4 })
    expect(items.compute_optimizer!.steps.join(" ")).toContain("update-enrollment-status --status Active")
  })

  test("before any completed run, gap checks say so rather than claiming done", () => {
    const list = depthChecklist({ provider: "aws", scopeVerified: true, metricsHistorySince: null, gaps: null })
    const items = byKey(list)
    expect(items.compute_optimizer).toMatchObject({ state: "unknown", affected: null, steps: [] })
    expect(items.access_errors!.state).toBe("unknown")
    expect(list.done).toBe(1)
  })

  test("Azure asks for exported history until the connector has some, and counts access errors", () => {
    const without = byKey(
      depthChecklist({
        provider: "azure",
        scopeVerified: false,
        metricsHistorySince: null,
        gaps: [gap("permission_denied", "/subscriptions/s/vm-a"), gap("region_unreachable", "/subscriptions/s/region")],
      })
    )
    expect(without.access!.state).toBe("open")
    expect(without.metric_history).toMatchObject({ state: "open", title: "Keep metrics longer than 93 days" })
    expect(without.azure_backup!.state).toBe("done")
    expect(without.access_errors).toMatchObject({ state: "open", affected: 2 })
    expect(without.compute_optimizer).toBeUndefined()

    const withHistory = byKey(
      depthChecklist({ provider: "azure", scopeVerified: true, metricsHistorySince: "2026-02-14T03:11:00.000Z", gaps: [] })
    )
    expect(withHistory.metric_history).toMatchObject({ state: "done", detail: "Exported metrics reach back to 14 Feb 2026." })
  })
})
