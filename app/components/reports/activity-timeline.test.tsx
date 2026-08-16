import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import type { RunStep } from "@/hooks/useRunStream"

import { ActivityTimeline } from "./activity-timeline"

/**
 * The activity timeline (Requirements 40.8, 40.14).
 *
 * Purely presentational, so every case here is a statement about what a given step list
 * renders — which is the point of parsing in `useRunStream` rather than here.
 *
 * ## The determinate bar, and the case that must render none
 *
 * A run is **8 to 12 minutes**, so an indeterminate spinner turning for four minutes reads
 * as a hang and `142 / 200 resources` is the difference between a product that looks alive
 * and one that looks stuck.
 *
 * The other half matters as much: a step with **no counts renders no bar**. That chain runs
 * end to end — the agent posts counts only for a phase with countable work, the row stores
 * them nullable, the relay emits no `progress` event while either is absent
 * (Requirement 40.14), and this component renders no bar without one. A bar at zero for a
 * phase that is not counting anything would be worse than a spinner, because it claims to
 * know something.
 */

function step(over: Partial<RunStep> = {}): RunStep {
  return {
    id: "collecting",
    name: "collect_metrics",
    label: "Collecting",
    status: "Enumerating resources and pulling metrics",
    complete: false,
    progress: null,
    ...over,
  }
}

afterEach(cleanup)

// ---------------------------------------------------------------------------

describe("Requirement 40.14 — no counts, no bar", () => {
  test("a step with no progress renders no progressbar", () => {
    render(<ActivityTimeline steps={[step()]} />)

    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(document.querySelector('[data-slot="progress-count"]')).toBeNull()
  })

  test("it still renders the step's status phrase", () => {
    // Honest rather than empty: the phase says what it is doing, with a spinner, and
    // claims no count.
    render(<ActivityTimeline steps={[step()]} />)

    expect(
      screen.getByText("Enumerating resources and pulling metrics")
    ).toBeTruthy()
    expect(screen.getByText("Collecting")).toBeTruthy()
  })

  test("an empty step list renders nothing at all", () => {
    const { container } = render(<ActivityTimeline steps={[]} />)

    expect(container.firstChild).toBeNull()
  })
})

describe("Requirement 40.8 — the determinate bar", () => {
  const withProgress = step({
    progress: { done: 142, total: 200, unit: "resources", label: "Metrics" },
  })

  test("it renders the count as text and as a progressbar", () => {
    render(<ActivityTimeline steps={[withProgress]} />)

    // Text, because a bar whose only representation is a width is a bar a screen reader
    // cannot report.
    expect(
      document.querySelector('[data-slot="progress-count"]')?.textContent
    ).toBe("142 / 200")
    expect(screen.getByText("resources")).toBeTruthy()

    const bar = screen.getByRole("progressbar")

    expect(bar.getAttribute("aria-valuenow")).toBe("142")
    expect(bar.getAttribute("aria-valuemin")).toBe("0")
    expect(bar.getAttribute("aria-valuemax")).toBe("200")
    expect(bar.getAttribute("aria-valuetext")).toBe("142 of 200 resources")
  })

  test("the count is mono tabular", () => {
    // In a product whose thesis is that the numbers are trustworthy, numerals that shift
    // as they stream undercut the argument — so the column is fixed-width.
    render(<ActivityTimeline steps={[withProgress]} />)

    const count = document.querySelector('[data-slot="progress-count"]')

    expect(count?.className).toMatch(/font-mono/)
    expect(count?.className).toMatch(/tabular-nums/)
  })

  test("no transition or animation is applied to the numerals", () => {
    // A count-up on a verified figure is decoration pretending to be data.
    render(<ActivityTimeline steps={[withProgress]} />)

    const count = document.querySelector('[data-slot="progress-count"]')

    expect(count?.className).not.toMatch(/transition/)
    expect(count?.className).not.toMatch(/animate/)
  })

  test("the label rides along when the row carried one", () => {
    render(<ActivityTimeline steps={[withProgress]} />)

    expect(screen.getByText("· Metrics")).toBeTruthy()
  })

  test("a null label renders no separator", () => {
    render(
      <ActivityTimeline
        steps={[
          step({
            progress: { done: 1, total: 2, unit: "resources", label: null },
          }),
        ]}
      />
    )

    expect(screen.queryByText(/·/)).toBeNull()
  })

  test("the bar's width is clamped to its track", () => {
    // A total that shrank between callbacks must not render a bar wider than the track.
    render(
      <ActivityTimeline
        steps={[
          step({
            progress: { done: 500, total: 200, unit: "resources", label: null },
          }),
        ]}
      />
    )

    const fill = screen.getByRole("progressbar").firstElementChild

    expect((fill as HTMLElement).style.width).toBe("100%")
  })

  test("a zero count renders a bar at zero rather than no bar", () => {
    // The ordinary state at the start of a phase, and `0` is falsy — a component testing
    // truthiness rather than nullness would drop it.
    render(
      <ActivityTimeline
        steps={[
          step({
            progress: { done: 0, total: 200, unit: "resources", label: null },
          }),
        ]}
      />
    )

    const bar = screen.getByRole("progressbar")

    expect(bar.getAttribute("aria-valuenow")).toBe("0")
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("0%")
  })
})

describe("step completion", () => {
  test("a complete step is marked, and an open one spins", () => {
    render(
      <ActivityTimeline
        steps={[
          step({ id: "claimed", label: "Starting", complete: true }),
          step({ id: "collecting", complete: false }),
        ]}
      />
    )

    const steps = document.querySelectorAll('[data-slot="activity-step"]')

    expect(steps[0].getAttribute("data-complete")).toBe("true")
    expect(steps[1].getAttribute("data-complete")).toBe("false")
  })

  test("the spinner respects prefers-reduced-motion", () => {
    render(<ActivityTimeline steps={[step()]} />)

    const spinner = document.querySelector('[data-slot="activity-step"] svg')

    expect(spinner?.getAttribute("class")).toMatch(/motion-reduce:animate-none/)
  })

  test("the list is a real ordered list in the order the steps opened", () => {
    // So reading order matches visual order, and a screen reader reports the timeline as
    // the sequence it is.
    render(
      <ActivityTimeline
        steps={[
          step({ id: "claimed", label: "Starting" }),
          step({ id: "collecting", label: "Collecting" }),
        ]}
      />
    )

    const list = screen.getByRole("list", { name: "Run activity" })
    const items = list.querySelectorAll("li")

    expect(list.tagName).toBe("OL")
    expect(items).toHaveLength(2)
    expect(items[0].getAttribute("data-step-id")).toBe("claimed")
    expect(items[1].getAttribute("data-step-id")).toBe("collecting")
  })
})
