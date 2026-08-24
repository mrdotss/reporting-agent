import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, screen, fireEvent } from "@testing-library/react"

import type { RunGap } from "@/lib/runs/gaps"

import { GapList, MAX_EXPANDED_ENTRIES } from "./gap-list"

/**
 * The gap list (Requirements 20.5–20.10, 20.13, 20.14, 15.9).
 *
 * ## The assertion this file exists for
 *
 * **No `--destructive` anywhere.** A gap is *recorded information* about what could not be
 * read — never silently zero-filled — which is the honest half of a report that completed.
 *
 * ## The 512-entry shape
 *
 * The defect this replaces emitted 512 paragraphs for a run whose entries largely named
 * the same resource. This test suite explicitly exercises that shape and asserts the
 * grouping collapses it to a bounded expansion.
 */

function gap(over: Partial<RunGap> = {}): RunGap {
  return {
    gapType: "deallocated",
    resourceId: "/subscriptions/x/virtualMachines/prod-batch-02",
    metric: null,
    message: "PowerState/deallocated",
    intervalStart: null,
    ...over,
  }
}

/** Every class name in the rendered tree, joined. */
function allClassNames(container: HTMLElement): string {
  return [...container.querySelectorAll("*")]
    .map((element) => element.className)
    .filter((value): value is string => typeof value === "string")
    .join(" ")
}

afterEach(cleanup)

// ---------------------------------------------------------------------------

describe("Requirement 20.7 — a gap is neutral information, not an error", () => {
  test("no rendered element carries the destructive token", () => {
    const { container } = render(
      <GapList
        gaps={[
          gap(),
          gap({ gapType: "permission_denied", message: "403" }),
          gap({ gapType: "metric_not_emitted", metric: "Percentage CPU" }),
        ]}
      />
    )

    expect(allClassNames(container)).not.toMatch(/destructive/)
  })

  test("it uses the mist neutral tokens instead", () => {
    const { container } = render(<GapList gaps={[gap()]} />)

    const classes = allClassNames(container)

    expect(classes).toMatch(/border-border/)
    expect(classes).toMatch(/text-muted-foreground/)
  })

  test("the empty state is neutral too", () => {
    const { container } = render(<GapList gaps={[]} />)

    expect(allClassNames(container)).not.toMatch(/destructive/)
    expect(screen.getByText(/No gaps recorded/)).toBeTruthy()
  })
})

describe("Requirement 20.10 — zero entries explicit statement", () => {
  test("zero entries presents a statement that no gaps were recorded", () => {
    render(<GapList gaps={[]} />)

    const empty = document.querySelector('[data-slot="gap-list-empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toMatch(/No gaps recorded/)
  })

  test("zero entries presents in Indonesian when language=id", () => {
    render(<GapList gaps={[]} language="id" />)

    expect(screen.getByText(/Tidak ada celah tercatat/)).toBeTruthy()
  })
})

describe("Requirement 20.5 — one representative message per group", () => {
  test("a group shows one representative rather than one message per entry", () => {
    render(
      <GapList
        gaps={[
          gap({ resourceId: "/vm/a", message: "PowerState/deallocated" }),
          gap({ resourceId: "/vm/b", message: "PowerState/deallocated" }),
          gap({ resourceId: "/vm/c", message: "PowerState/deallocated" }),
        ]}
      />
    )

    // Before expanding, the group header shows with count but no list of entries
    const groups = document.querySelectorAll('[data-slot="gap-group"]')
    expect(groups).toHaveLength(1)
    expect(groups[0].textContent).toContain("3")
  })
})

describe("Requirement 20.6 — expansion with keyboard and focus indicator", () => {
  test("expansion is reachable via button with accessible name", () => {
    render(
      <GapList
        gaps={[
          gap({ resourceId: "/vm/a" }),
          gap({ resourceId: "/vm/b" }),
        ]}
      />
    )

    const button = document.querySelector(
      '[data-slot="gap-group"] button'
    ) as HTMLElement
    expect(button).not.toBeNull()

    // Accessible name includes group name and entry count
    const ariaLabel = button.getAttribute("aria-label")
    expect(ariaLabel).toContain("2")

    // Initially collapsed
    expect(button.getAttribute("aria-expanded")).toBe("false")

    // Expand via click (keyboard triggers click on buttons)
    fireEvent.click(button)
    expect(button.getAttribute("aria-expanded")).toBe("true")
  })

  test("expansion button has visible focus-visible ring", () => {
    render(<GapList gaps={[gap()]} />)

    const button = document.querySelector(
      '[data-slot="gap-group"] button'
    ) as HTMLElement
    expect(button.className).toMatch(/focus-visible:ring/)
  })
})

describe("Requirement 20.13 — unrecognized gap type still presented", () => {
  test("a type with no copy presents its gapType value, count, and representative message", () => {
    render(
      <GapList
        gaps={[
          gap({
            gapType: "backup_not_configured",
            resourceId: "/vm/a",
            message: "no backup configured for this resource",
          }),
          gap({
            gapType: "backup_not_configured",
            resourceId: "/vm/b",
            message: "no backup configured for this resource",
          }),
        ]}
      />
    )

    const group = document.querySelector(
      '[data-gap-type="backup_not_configured"]'
    )
    expect(group).not.toBeNull()

    // Presents the gapType value
    expect(group?.textContent).toContain("backup_not_configured")
    // Presents entry count
    expect(group?.textContent).toContain("2")
    // Presents the representative message
    expect(group?.textContent).toContain(
      "no backup configured for this resource"
    )
  })

  test("the four gap types from task 1.3 are presented rather than omitted", () => {
    const newTypes = [
      "backup_not_configured",
      "no_reservations",
      "replication_not_enabled",
      "fact_unavailable",
    ]

    render(
      <GapList
        gaps={newTypes.map((gapType) =>
          gap({
            gapType,
            resourceId: "/vm/test",
            message: `gap of type ${gapType}`,
          })
        )}
      />
    )

    const groups = document.querySelectorAll('[data-slot="gap-group"]')
    expect(groups.length).toBe(4)

    for (const type of newTypes) {
      const group = document.querySelector(`[data-gap-type="${type}"]`)
      expect(group).not.toBeNull()
      expect(group?.textContent).toContain(type)
    }
  })
})

describe("Requirement 20.14 — bounded expansion", () => {
  test("MAX_EXPANDED_ENTRIES is 200", () => {
    expect(MAX_EXPANDED_ENTRIES).toBe(200)
  })

  test("the 512-entry / 8-group shape: all groups shown, no overflow", () => {
    // Build 512 entries: 1 resource × 8 metrics × 64 intervals each.
    // This is the exact shape from the defect report. The grouper produces 8
    // inner groups (one per metric), so the list renders 8 rows — well below
    // MAX_EXPANDED_ENTRIES. There must be NO overflow statement.
    const metrics = [
      "Percentage CPU",
      "Available Memory Bytes",
      "Disk Read Bytes",
      "Disk Write Bytes",
      "Disk Read Operations/Sec",
      "Disk Write Operations/Sec",
      "Network In Total",
      "Network Out Total",
    ]
    const gaps512: RunGap[] = []
    for (const metric of metrics) {
      for (let i = 0; i < 64; i++) {
        gaps512.push(
          gap({
            gapType: "interval_counts_missing",
            resourceId: "/subscriptions/x/virtualMachines/prod-web-01",
            metric,
            message: "total or count missing",
            intervalStart: `2026-07-01T${String(i % 24).padStart(2, "0")}:00:00Z`,
          })
        )
      }
    }
    expect(gaps512).toHaveLength(512)

    render(
      <GapList
        gaps={gaps512}
        groupOptions={{ grain: "PT1H", utcOffset: "+07:00" }}
      />
    )

    // One type group with total entry count 512
    const groups = document.querySelectorAll('[data-slot="gap-group"]')
    expect(groups).toHaveLength(1)
    expect(groups[0].textContent).toContain("512")

    // Expand
    const button = groups[0].querySelector("button") as HTMLElement
    fireEvent.click(button)

    // 8 inner groups rendered (one per metric)
    const items = groups[0].querySelectorAll("li")
    expect(items).toHaveLength(8)

    // NO overflow statement — 8 groups is far below the 200-group cap
    const overflow = document.querySelector('[data-slot="gap-overflow"]')
    expect(overflow).toBeNull()
  })

  test("overflow triggers at >200 inner groups and states computed counts", () => {
    // Build 250 inner groups (250 distinct resources × 1 metric × 1 entry each = 250 entries).
    const gaps250: RunGap[] = []
    for (let i = 0; i < 250; i++) {
      gaps250.push(
        gap({
          gapType: "interval_counts_missing",
          resourceId: `/subscriptions/x/virtualMachines/vm-${String(i).padStart(3, "0")}`,
          metric: "Percentage CPU",
          message: "total or count missing",
          intervalStart: "2026-07-01T00:00:00Z",
        })
      )
    }

    render(
      <GapList
        gaps={gaps250}
        groupOptions={{ grain: "PT1H", utcOffset: "+07:00" }}
      />
    )

    // Expand
    const button = document.querySelector(
      '[data-slot="gap-group"] button'
    ) as HTMLElement
    fireEvent.click(button)

    // At most 200 list items rendered
    const items = document.querySelectorAll('[data-slot="gap-group"] li')
    expect(items).toHaveLength(200)

    // Overflow statement present with computed numbers (not hardcoded)
    const overflow = document.querySelector('[data-slot="gap-overflow"]')
    expect(overflow).not.toBeNull()
    const text = overflow!.textContent!
    // "Showing 200 of 250 groups (200 of 250 entries)."
    expect(text).toContain("200")
    expect(text).toContain("250")
    expect(text).toMatch(/groups/)
    expect(text).toMatch(/entries/)
  })

  test("a group with fewer than 200 entries shows all without overflow", () => {
    const gaps10: RunGap[] = Array.from({ length: 10 }, (_, i) =>
      gap({
        gapType: "metric_error",
        resourceId: `/vm/host-${i}`,
        metric: "Percentage CPU",
        message: "429 Too Many Requests",
      })
    )

    render(
      <GapList
        gaps={gaps10}
        groupOptions={{ grain: "PT1H", utcOffset: "+07:00" }}
      />
    )

    // Expand
    const button = document.querySelector(
      '[data-slot="gap-group"] button'
    ) as HTMLElement
    fireEvent.click(button)

    // No overflow
    expect(document.querySelector('[data-slot="gap-overflow"]')).toBeNull()
  })

  test("overflow statement numbers match what the DOM actually contains", () => {
    // 300 distinct inner groups, each with 2 entries = 600 total entries.
    // Cap at 200 groups → 200 rendered rows accounting for 400 of 600 entries.
    const gapsMulti: RunGap[] = []
    for (let i = 0; i < 300; i++) {
      // Two entries per (resource, metric) pair → one inner group with count=2
      gapsMulti.push(
        gap({
          gapType: "interval_counts_missing",
          resourceId: `/subscriptions/x/virtualMachines/vm-${String(i).padStart(3, "0")}`,
          metric: "Percentage CPU",
          message: "total or count missing",
          intervalStart: "2026-07-01T00:00:00Z",
        })
      )
      gapsMulti.push(
        gap({
          gapType: "interval_counts_missing",
          resourceId: `/subscriptions/x/virtualMachines/vm-${String(i).padStart(3, "0")}`,
          metric: "Percentage CPU",
          message: "total or count missing",
          intervalStart: "2026-07-01T01:00:00Z",
        })
      )
    }
    expect(gapsMulti).toHaveLength(600)

    render(
      <GapList
        gaps={gapsMulti}
        groupOptions={{ grain: "PT1H", utcOffset: "+07:00" }}
      />
    )

    const button = document.querySelector(
      '[data-slot="gap-group"] button'
    ) as HTMLElement
    fireEvent.click(button)

    const items = document.querySelectorAll('[data-slot="gap-group"] li')
    expect(items).toHaveLength(200)

    const overflow = document.querySelector('[data-slot="gap-overflow"]')
    expect(overflow).not.toBeNull()
    const text = overflow!.textContent!

    // Extract numeric values from the statement and verify against DOM
    const numbers = text.match(/\d+/g)!.map(Number)
    // Statement: "Showing 200 of 300 groups (400 of 600 entries)."
    const [shownGroups, totalGroups, shownEntries, totalEntries] = numbers

    // The shown group count MUST equal the actual DOM item count
    expect(shownGroups).toBe(items.length)
    // The total group count must equal the actual inner group count (300)
    expect(totalGroups).toBe(300)
    // Shown entries = 200 groups × 2 entries each = 400
    expect(shownEntries).toBe(400)
    // Total entries = 300 groups × 2 entries each = 600
    expect(totalEntries).toBe(600)
  })
})

describe("Requirement 20.8, 20.9 — metric_not_selected group", () => {
  test("metric_not_selected with resource types: presents distinct types and counts", () => {
    render(
      <GapList
        gaps={[
          gap({
            gapType: "metric_not_selected",
            resourceId:
              "/subscriptions/s/providers/Microsoft.Sql/servers/sql-01",
            metric: null,
            message: "no metric was requested",
          }),
          gap({
            gapType: "metric_not_selected",
            resourceId:
              "/subscriptions/s/providers/Microsoft.Sql/servers/sql-02",
            metric: null,
            message: "no metric was requested",
          }),
          gap({
            gapType: "metric_not_selected",
            resourceId:
              "/subscriptions/s/providers/Microsoft.Storage/storageAccounts/st-01",
            metric: null,
            message: "no metric was requested",
          }),
        ]}
        templateId="tmpl-123"
      />
    )

    const group = document.querySelector(
      '[data-gap-type="metric_not_selected"]'
    )
    expect(group).not.toBeNull()

    const text = group?.textContent ?? ""

    // Statement about the cause and fix
    expect(text).toMatch(/template.*no metric|template selected no metric/i)
    expect(text).toMatch(/edit.*template|edit the template/i)

    // Link to template metric selection
    const link = group?.querySelector("a")
    expect(link).not.toBeNull()
    expect(link?.getAttribute("href")).toBe("/templates/tmpl-123/edit")

    // Distinct resource types
    expect(text).toContain("Microsoft.Sql/servers")
    expect(text).toContain("Microsoft.Storage/storageAccounts")
    // Resource count per type
    expect(text).toContain("2") // 2 sql servers
    expect(text).toContain("1") // 1 storage account
  })

  test("metric_not_selected without resource types: presents count and statement", () => {
    render(
      <GapList
        gaps={[
          gap({
            gapType: "metric_not_selected",
            resourceId: "plainid-no-provider-pattern",
            metric: null,
            message: "no metric was requested",
          }),
          gap({
            gapType: "metric_not_selected",
            resourceId: "another-plain-id",
            metric: null,
            message: "no metric was requested",
          }),
        ]}
        templateId="tmpl-456"
      />
    )

    const group = document.querySelector(
      '[data-gap-type="metric_not_selected"]'
    )
    const text = group?.textContent ?? ""

    // Statement about resource types not being recorded
    expect(text).toMatch(/not recorded|tidak tercatat/i)
    // Count of distinct resources
    expect(text).toContain("2")

    // Still has the template link and statement about fix
    expect(text).toMatch(/template/i)
    const link = group?.querySelector("a")
    expect(link).not.toBeNull()
    expect(link?.getAttribute("href")).toBe("/templates/tmpl-456/edit")
  })

  test("metric_not_selected presents statement and link in BOTH branches", () => {
    // With types
    const { unmount } = render(
      <GapList
        gaps={[
          gap({
            gapType: "metric_not_selected",
            resourceId:
              "/subscriptions/s/providers/Microsoft.Compute/virtualMachines/vm1",
            metric: null,
            message: "no metric",
          }),
        ]}
        templateId="tmpl-x"
      />
    )

    let group = document.querySelector('[data-gap-type="metric_not_selected"]')
    let text = group?.textContent ?? ""
    expect(text).toMatch(/template/i)
    expect(group?.querySelector("a")).not.toBeNull()

    unmount()
    cleanup()

    // Without types
    render(
      <GapList
        gaps={[
          gap({
            gapType: "metric_not_selected",
            resourceId: "no-provider-pattern",
            metric: null,
            message: "no metric",
          }),
        ]}
        templateId="tmpl-y"
      />
    )

    group = document.querySelector('[data-gap-type="metric_not_selected"]')
    text = group?.textContent ?? ""
    expect(text).toMatch(/template/i)
    expect(group?.querySelector("a")).not.toBeNull()
  })
})

describe("Requirement 15.9 — copy in pinned definition's language", () => {
  test("resolves gap copy in Indonesian when language=id", () => {
    render(
      <GapList
        gaps={[gap({ gapType: "permission_denied", message: "403" })]}
        language="id"
      />
    )

    const group = document.querySelector(
      '[data-gap-type="permission_denied"]'
    )
    const text = group?.textContent ?? ""
    // The Indonesian copy from the catalog
    expect(text).toMatch(/ditolak|sumber daya/)
  })

  test("resolves gap copy in English when language=en", () => {
    render(
      <GapList
        gaps={[gap({ gapType: "permission_denied", message: "403" })]}
        language="en"
      />
    )

    const group = document.querySelector(
      '[data-gap-type="permission_denied"]'
    )
    const text = group?.textContent ?? ""
    expect(text).toMatch(/refused|could not read/)
  })
})

describe("integration with groupGaps from gap-groups.ts", () => {
  test("multiple entries for the same (resourceId, metric) group into one inner group", () => {
    render(
      <GapList
        gaps={[
          gap({
            gapType: "interval_counts_missing",
            resourceId: "/vm/a",
            metric: "Percentage CPU",
            message: "total missing",
            intervalStart: "2026-07-01T00:00:00Z",
          }),
          gap({
            gapType: "interval_counts_missing",
            resourceId: "/vm/a",
            metric: "Percentage CPU",
            message: "total missing",
            intervalStart: "2026-07-01T01:00:00Z",
          }),
          gap({
            gapType: "interval_counts_missing",
            resourceId: "/vm/a",
            metric: "Percentage CPU",
            message: "total missing",
            intervalStart: "2026-07-01T02:00:00Z",
          }),
        ]}
        groupOptions={{ grain: "PT1H", utcOffset: "+07:00" }}
      />
    )

    const groups = document.querySelectorAll('[data-slot="gap-group"]')
    expect(groups).toHaveLength(1)
    expect(groups[0].textContent).toContain("3")

    // Expand
    const button = groups[0].querySelector("button") as HTMLElement
    fireEvent.click(button)

    // Should show one inner group with count 3, not 3 separate entries
    const items = groups[0].querySelectorAll("li")
    expect(items).toHaveLength(1)
    // The inner group shows ×3
    expect(items[0].textContent).toContain("×3")
  })
})
