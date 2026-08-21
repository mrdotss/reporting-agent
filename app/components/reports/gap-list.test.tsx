import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import type { RunGap } from "@/lib/runs/gaps"

import { GapList } from "./gap-list"

/**
 * The gap list (Requirements 36.7, 13.6's rule applied to gaps).
 *
 * ## The assertion this file exists for
 *
 * **No `--destructive` anywhere.** A gap is *recorded information* about what could not be
 * read — never silently zero-filled — which is the honest half of a report that completed.
 * In this product red means *this document could not be proven*, so styling a gap as a
 * failure would push a consultant to treat the useful case as the broken one. The
 * assertion is a scan of every rendered class name, so it holds for a nested element
 * somebody adds later rather than only for the root.
 *
 * The grouping is asserted too, because the types are not interchangeable: a deallocated
 * VM emitting nothing is *expected*, a metric a SKU does not emit is a genuine gap, and a
 * 403 is a permission failure. Collapsing them would put the one that needs action next to
 * the one that does not.
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

describe("Requirement 13.6 — a gap is neutral information, not an error", () => {
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

    // The whole tree, not just the root: the rule is about the component, and a nested
    // element added later must not be able to slip a red border in.
    expect(allClassNames(container)).not.toMatch(/destructive/)
  })

  test("it uses the mist neutral tokens instead", () => {
    // Asserted positively as well as negatively, so a component that rendered *no*
    // styling at all would not pass the rule above by accident.
    const { container } = render(<GapList gaps={[gap()]} />)

    const classes = allClassNames(container)

    expect(classes).toMatch(/border-border/)
    expect(classes).toMatch(/text-muted-foreground/)
  })

  test("the empty state is neutral too", () => {
    const { container } = render(<GapList gaps={[]} />)

    expect(allClassNames(container)).not.toMatch(/destructive/)
    expect(screen.getByText(/No gaps were recorded/)).toBeTruthy()
  })
})

describe("gaps are grouped by gap_type", () => {
  test("one group per type, each carrying its own count", () => {
    render(
      <GapList
        gaps={[
          gap({ resourceId: "/vm/a" }),
          gap({ resourceId: "/vm/b" }),
          gap({
            gapType: "permission_denied",
            resourceId: "/vm/c",
            message: "403 Forbidden",
          }),
        ]}
      />
    )

    const groups = document.querySelectorAll('[data-slot="gap-group"]')

    expect(groups).toHaveLength(2)
    expect(groups[0].getAttribute("data-gap-type")).toBe("deallocated")
    expect(groups[1].getAttribute("data-gap-type")).toBe("permission_denied")

    // The count per group, in mono tabular like every figure.
    expect(groups[0].textContent).toContain("2")
    expect(groups[1].textContent).toContain("1")
  })

  test("a deallocated group explains why it is not zero utilization", () => {
    // The single most important note in this component: reporting 0% CPU for a
    // deallocated VM as though it were measured idle is a factual error in a document
    // somebody may resize infrastructure from.
    render(<GapList gaps={[gap()]} />)

    const group = document.querySelector('[data-slot="gap-group"]')

    expect(group?.textContent).toMatch(/excluded from averages/)
    expect(group?.textContent).toMatch(/emits no metrics/)
  })

  test("a metric_not_selected group is labelled and says what to change", () => {
    // Without an entry in the presentation map this group renders with the raw
    // `metric_not_selected` string as its heading and no note at all — and this is the
    // one gap type whose cause is a decision the consultant made, so it is the one where
    // an explanation actually leads to a fix. Every other type points at the
    // subscription, the SKU or the guest.
    render(
      <GapList
        gaps={[
          gap({
            gapType: "metric_not_selected",
            resourceId:
              "/subscriptions/s/providers/Microsoft.Sql/servers/sql-01",
            metric: null,
            message:
              "no metric was requested for resource type 'Microsoft.Sql/servers'",
          }),
        ]}
      />
    )

    const group = document.querySelector('[data-slot="gap-group"]')

    expect(group?.getAttribute("data-gap-type")).toBe("metric_not_selected")
    expect(group?.textContent).toContain("No metric selected")
    expect(group?.textContent).not.toContain("metric_not_selected")
    expect(group?.textContent).toMatch(/Add a metric for that resource type/)
  })

  test("each gap names its resource, and its metric when it has one", () => {
    render(
      <GapList
        gaps={[
          gap({
            gapType: "metric_not_emitted",
            resourceId: "/vm/prod-web-01",
            metric: "Available Memory Bytes",
            message: "not published for this SKU",
          }),
        ]}
      />
    )

    expect(screen.getByText(/\/vm\/prod-web-01/)).toBeTruthy()
    expect(screen.getByText(/Available Memory Bytes/)).toBeTruthy()
    expect(screen.getByText("not published for this SKU")).toBeTruthy()
  })

  test("a resource-level gap renders no metric", () => {
    // `metric` is `null` for a resource-level gap, which is a genuine absence: a
    // permission denial is about the resource, not about one of its metrics.
    render(<GapList gaps={[gap({ resourceId: "/vm/only" })]} />)

    const entry = document.querySelector('[data-slot="gap-group"] li')

    expect(entry?.textContent).toContain("/vm/only")
    expect(entry?.textContent).not.toContain(" · ")
  })

  test("an unrecognised gap_type still renders its entries", () => {
    // The agent closes the `gap_type` set — it raises on an undeclared value before a
    // snapshot exists — so re-closing it here would only add a way for the two halves to
    // disagree about a document already written. A build of the app meeting a twentieth
    // type must render it rather than reject the whole list.
    render(
      <GapList
        gaps={[
          gap({
            gapType: "some_future_type",
            resourceId: "/vm/future",
            message: "recorded by a newer agent",
          }),
        ]}
      />
    )

    expect(screen.getByText("some_future_type")).toBeTruthy()
    expect(screen.getByText("recorded by a newer agent")).toBeTruthy()
  })

  test("the snapshot's order within a group is preserved", () => {
    // The agent already sorted by `gap_type` then `resource_id` then `metric`. Re-sorting
    // would be a second opinion about an ordering the immutable document fixed.
    render(
      <GapList
        gaps={[
          gap({ resourceId: "/vm/zebra" }),
          gap({ resourceId: "/vm/alpha" }),
        ]}
      />
    )

    const entries = [
      ...document.querySelectorAll('[data-slot="gap-group"] li'),
    ].map((element) => element.textContent ?? "")

    expect(entries[0]).toContain("/vm/zebra")
    expect(entries[1]).toContain("/vm/alpha")
  })

  test("two gaps for one resource on different metrics both render", () => {
    // A legitimate shape, and the reason the list key includes the metric and the index.
    render(
      <GapList
        gaps={[
          gap({
            gapType: "metric_error",
            resourceId: "/vm/same",
            metric: "Percentage CPU",
            message: "429",
          }),
          gap({
            gapType: "metric_error",
            resourceId: "/vm/same",
            metric: "Network In Total",
            message: "429",
          }),
        ]}
      />
    )

    expect(
      document.querySelectorAll('[data-slot="gap-group"] li')
    ).toHaveLength(2)
  })
})
