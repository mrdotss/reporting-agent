import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render } from "@testing-library/react"

import type { TemplateDefinition } from "@/lib/templates/definition"

import { BlockComposer } from "./block-composer"

/**
 * The composer's keyboard model and its announcements (Requirement 12).
 *
 * ## What these are placed to catch
 *
 * **Exactly one announcement per move** (12.5), and a **refusal announced too**
 * (12.12, 12.14). The second is the one an implementation forgets: a nudge at
 * the first position that changes nothing and says nothing is indistinguishable
 * from a key that did not register, and a keyboard user will press it again.
 *
 * **Focus follows the block** (12.3, 12.4). Without it a consultant who adds
 * three blocks and presses `Mod`+ArrowUp reorders whatever was selected before
 * they started.
 *
 * **Selection is a ring, never a fill** (12.10), so the canvas keeps resembling
 * the document it previews.
 */

afterEach(cleanup)

/**
 * A definition carrying one block per named type.
 *
 * A `row` is built with its `columns` rather than with a `config`, because that
 * is what a row **is** (Requirement 6.2): the columns live on the block, and
 * `row-splitter.tsx` reads `row.columns.length`. A fixture that gave a row a
 * `config` instead would be a definition the validator rejects, and the crash it
 * produced in this file was the component correctly refusing to guess.
 */
/**
 * A v1 base, declared here rather than borrowed from `EMPTY_DRAFT`.
 *
 * `BlockComposer` is the v1/v2 blocks surface, kept for editing stored legacy
 * definitions -- v3 has no `blocks` key at all. This fixture used to spread
 * `EMPTY_DRAFT`, which was a v1 definition until the draft factory moved to v3
 * with the five-step wizard; the composer then received a definition with no
 * `blocks` to compose. Borrowing the NEW-template factory to fixture the OLD
 * format was the coupling, so the fixture now owns its own shape and cannot be
 * broken again by a change to what a new template starts as.
 */
const V1_BASE = {
  schema_version: 1,
  identity: { name: "Fixture", description: "", report_title: "Fixture" },
  scope: {
    resource_types: [],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  },
  period: { kind: "last_full_month" },
  metrics: {},
  blocks: [],
  design: {
    preset: "editorial",
    accent_color: "#1f6f78",
    density: "normal",
    table_style: "hairline",
    number_format: { decimal_places: 2, group_thousands: true },
    cover_page: true,
    logo: null,
    page_size: "A4",
  },
} as const

function definitionWith(types: readonly string[]): TemplateDefinition {
  return {
    ...V1_BASE,
    blocks: types.map((type, index) =>
      type === "row"
        ? { id: `b${index + 1}`, type: "row", columns: [[], []] }
        : { id: `b${index + 1}`, type, config: {} }
    ),
  } as TemplateDefinition
}

/** Render the composer over a definition, capturing every change it emits. */
function mount(types: readonly string[]) {
  const onChange = vi.fn()
  const result = render(
    <BlockComposer definition={definitionWith(types)} onChange={onChange} />
  )

  return { ...result, onChange }
}

function announcement(container: HTMLElement): string {
  return (
    container.querySelector("[data-slot='move-announcer']")?.textContent ?? ""
  )
}

function blockItem(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[data-slot='block-canvas-item'][data-block-id='${id}']`
  )!
}

describe("Requirement 12.1 — three panes, in tab order", () => {
  test("the palette, the canvas and the inspector are all regions", () => {
    const { container } = mount(["cover"])

    const labels = [...container.querySelectorAll("[role='region']")].map(
      (node) => node.getAttribute("aria-label")
    )

    // The order in the DOM is the tab order, and it is the order the requirement
    // names — so no `tabIndex` is needed anywhere to achieve it.
    expect(labels).toEqual([
      "Block palette",
      "Composed document",
      "Block inspector",
    ])
  })
})

describe("Requirement 12.2 — a palette entry says what its block emits", () => {
  test("the description is not the block's name restated", () => {
    const { container } = mount([])
    const entry = container.querySelector(
      "[data-slot='palette-entry'][data-block-type='kpi_row']"
    )

    expect(entry?.textContent).toContain("KPI row")
    // The line that earns the palette its place: "KPI row" tells a consultant
    // nothing they could not read off the label.
    expect(entry?.textContent).toMatch(/headline figures/i)
  })
})

describe("Requirement 12.3 — Enter appends, selects and focuses", () => {
  test("activating a palette entry appends that block", () => {
    const { container, onChange } = mount([])

    fireEvent.click(
      container.querySelector(
        "[data-slot='palette-entry'][data-block-type='heading']"
      )!
    )

    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]![0] as TemplateDefinition
    expect(next.blocks.map((block) => block.type)).toEqual(["heading"])
  })

  test("the insert is announced", () => {
    const { container } = mount([])

    fireEvent.click(
      container.querySelector(
        "[data-slot='palette-entry'][data-block-type='heading']"
      )!
    )

    expect(announcement(container)).not.toBe("")
  })
})

describe("Requirements 12.5, 12.12 — one announcement per move, refusals included", () => {
  test("a nudge is announced with the block, its position and the total", () => {
    const { container } = mount(["cover", "kpi_row"])

    const second = blockItem(container, "b2")
    fireEvent.focus(second)
    fireEvent.keyDown(second, { key: "ArrowUp", ctrlKey: true })

    const said = announcement(container)
    expect(said).toMatch(/KPI row/i)
    expect(said).toMatch(/1/)
    expect(said).toMatch(/2/)
  })

  test("a nudge at the first position is refused and says so", () => {
    // The one an implementation forgets. Silence here is indistinguishable from
    // a key that did not register, and a keyboard user will press it again.
    const { container, onChange } = mount(["cover", "kpi_row"])

    const first = blockItem(container, "b1")
    fireEvent.focus(first)
    fireEvent.keyDown(first, { key: "ArrowUp", ctrlKey: true })

    expect(onChange).not.toHaveBeenCalled()
    expect(announcement(container)).toMatch(/first/i)
  })

  test("there is exactly one live region", () => {
    // Two regions announce a move twice, and the second arrives while the first
    // is still being spoken — which is what makes a screen-reader user turn the
    // feature off.
    const { container } = mount(["cover", "kpi_row"])

    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1)
    expect(
      container.querySelector("[aria-live]")?.getAttribute("aria-live")
    ).toBe("polite")
  })
})

describe("Requirement 12.14 — a row is refused inside a row, to the keyboard too", () => {
  test("demoting a row into a row column is refused and announced", () => {
    // Requirement 12.9 shows a pointer user this refusal; 12.14 exists so a
    // keyboard user is told it rather than left with a key that did nothing.
    const { container, onChange } = mount(["row", "row"])

    const first = blockItem(container, "b1")
    fireEvent.focus(first)
    fireEvent.keyDown(first, { key: "ArrowRight", ctrlKey: true })

    expect(onChange).not.toHaveBeenCalled()
    expect(announcement(container)).toMatch(/row/i)
  })
})

describe("Requirement 12.6 — the list order is the document order", () => {
  test("the canvas list holds one item per block, in order", () => {
    const { container } = mount(["cover", "kpi_row", "resource_table"])

    const items = [
      ...container.querySelectorAll("ol[data-slot='block-canvas'] > li"),
    ]

    expect(items.map((item) => item.getAttribute("data-block-id"))).toEqual([
      "b1",
      "b2",
      "b3",
    ])
  })
})

describe("Requirement 12.7 — a drop target names where it would insert", () => {
  test("its accessible name carries the position and the total", () => {
    const { container } = mount(["cover", "kpi_row"])

    const labels = [
      ...container.querySelectorAll("[data-slot='drop-target']"),
    ].map((node) => node.getAttribute("aria-label"))

    // "Drop zone" repeated down a document is a wall of identical strings to a
    // screen reader.
    for (const label of labels) {
      expect(label).toMatch(/Insert at position \d+ of \d+/)
    }
  })
})

describe("Requirement 12.10 — selection is a ring, never a fill", () => {
  test("a selected block gains a ring and no background", () => {
    const { container } = mount(["cover"])

    const block = blockItem(container, "b1")
    fireEvent.focus(block)

    expect(block.getAttribute("data-selected")).toBe("true")
    expect(block.className).toContain("ring")
    // A selected block that turned blue would make the preview stop previewing
    // at the moment the consultant is looking hardest at it.
    expect(block.className).not.toMatch(/\bbg-(?!transparent)/)
  })
})

describe("Requirement 12.11 — inheriting and narrowed are distinct states", () => {
  test("an unselected canvas prompts for a selection", () => {
    const { container } = mount(["cover"])

    expect(
      container.querySelector("[data-slot='block-inspector']")?.textContent
    ).toMatch(/select a block/i)
  })

  test("a selected block shows the inherited default above its override", () => {
    const { container } = mount(["kpi_row"])

    fireEvent.focus(blockItem(container, "b1"))

    const inspector = container.querySelector("[data-slot='block-inspector']")
    expect(inspector?.textContent).toMatch(/inheriting the template default/i)
  })
})
