"use client"

import {
  ArticleIcon,
  BookOpenIcon,
  CardsIcon,
  ChartBarIcon,
  ChartLineIcon,
  ColumnsIcon,
  FileDashedIcon,
  GaugeIcon,
  type Icon,
  ListChecksIcon,
  ScalesIcon,
  SealCheckIcon,
  StackIcon,
  TableIcon,
  TextHOneIcon,
  TrendUpIcon,
  WarningDiamondIcon,
} from "@phosphor-icons/react"

import type { BlockType } from "@/lib/templates/blocks"
import { BLOCK_TYPE_LABELS } from "@/lib/templates/composer"

/**
 * The palette — every block a consultant can add (Requirements 12.1, 12.2,
 * 12.3).
 *
 * ## Each entry says what the block *emits*
 *
 * Requirement 12.2 asks for "one line describing what that block emits rather
 * than what that block is named", and the difference is the whole value of the
 * palette. "KPI row" tells a consultant nothing they could not read off the
 * label; *"Three or four headline figures across the page"* tells them whether
 * it is the thing they want. The names below are the labels; the sentences are
 * the content.
 *
 * ## Enter and Space both append, and focus follows the block
 *
 * Requirement 12.3 is specific and the last clause is the one that is easy to
 * miss: the appended block becomes selected **and takes keyboard focus**, "so
 * that a keyboard user's next reorder acts on the block just inserted". Without
 * the focus move, a consultant who adds three blocks and then presses
 * `Mod`+ArrowUp reorders whatever was selected before they started — which is
 * the palette's own last entry, or nothing.
 *
 * The focus move itself is the canvas's to perform, because the canvas owns the
 * element that receives it; this component's job is to report the insert and let
 * the composer sequence the two.
 *
 * ## Buttons, not draggables with a role
 *
 * Each entry is a real `<button>`. `Enter` and `Space` activate it for free,
 * it is in the tab order without a `tabIndex`, and it announces as a button. A
 * `div` carrying `role="button"` and a key handler is the same thing with three
 * more ways to get it wrong, and Requirement 12.13 forbids composing this on a
 * primitive without a keyboard path — starting from a control that already has
 * one is the cheapest way to hold that line.
 */

type PaletteEntry = {
  readonly type: BlockType
  readonly icon: Icon
  /** What it emits. Not what it is called — that is {@link BLOCK_TYPE_LABELS}. */
  readonly emits: string
}

type PaletteGroup = {
  readonly name: string
  readonly entries: readonly PaletteEntry[]
}

/**
 * The four groups `design-system.md` names: Structure · Data · Narrative ·
 * Record.
 *
 * Grouped rather than listed flat because sixteen entries is past the count a
 * consultant scans; and grouped *this* way because the groups answer different
 * questions — "how is the page laid out", "what figures does it carry", "what
 * does it say", "what proves it".
 */
export const PALETTE_GROUPS: readonly PaletteGroup[] = [
  {
    name: "Structure",
    entries: [
      {
        type: "cover",
        icon: FileDashedIcon,
        emits:
          "A title page carrying the report title, the customer and the window.",
      },
      {
        type: "heading",
        icon: TextHOneIcon,
        emits: "A section heading in the theme's own heading style.",
      },
      {
        type: "row",
        icon: ColumnsIcon,
        emits: "Two or three columns side by side. Holds blocks; holds no row.",
      },
      {
        type: "page_break",
        icon: StackIcon,
        emits: "A forced page break. Emits nothing visible.",
      },
    ],
  },
  {
    name: "Data",
    entries: [
      {
        type: "kpi_row",
        icon: GaugeIcon,
        emits: "Three or four headline figures across the page.",
      },
      {
        type: "resource_table",
        icon: TableIcon,
        emits: "One row per resource, one column per statistic you picked.",
      },
      {
        type: "top_n_table",
        icon: TrendUpIcon,
        emits: "The busiest N resources, ranked by one metric.",
      },
      {
        type: "timeseries_chart",
        icon: ChartLineIcon,
        emits: "A line over the window, with the figures beside it as a table.",
      },
      {
        type: "distribution_chart",
        icon: ChartBarIcon,
        emits:
          "How values spread across the window, from the collected sketch.",
      },
      {
        type: "capacity_vs_usage",
        icon: ScalesIcon,
        emits:
          "What each resource has against what it used — headroom, in one view.",
      },
      {
        type: "comparison_delta",
        icon: CardsIcon,
        emits: "This run against a previous one, per resource and metric.",
      },
    ],
  },
  {
    name: "Narrative",
    entries: [
      {
        type: "executive_summary",
        icon: ArticleIcon,
        emits:
          "Written prose about the figures. The model writes this and no number in it.",
      },
      {
        type: "rich_text",
        icon: BookOpenIcon,
        emits: "Your own paragraphs, printed as written.",
      },
    ],
  },
  {
    name: "Record",
    entries: [
      {
        type: "gaps_and_coverage",
        icon: WarningDiamondIcon,
        emits:
          "What could not be collected, grouped by cause, and what that leaves out.",
      },
      {
        type: "verification_record",
        icon: SealCheckIcon,
        emits:
          "The digests and the figure count that prove the document against the snapshot.",
      },
      {
        type: "appendix_methodology",
        icon: ListChecksIcon,
        emits:
          "How each figure was produced — the grain, the aggregation, the estimators.",
      },
    ],
  },
]

export function BlockPalette({
  onInsert,
}: Readonly<{
  /** Append `type` to the end of the top-level sequence (Requirement 12.3). */
  onInsert: (type: BlockType) => void
}>) {
  return (
    <div
      data-slot="block-palette"
      // A landmark, so the three panes are reachable as regions rather than by
      // tabbing through every control in the one before (Requirement 12.1).
      role="region"
      aria-label="Block palette"
      className="flex flex-col gap-4 rounded-xl bg-sidebar px-3 py-3"
    >
      {PALETTE_GROUPS.map((group) => (
        <section key={group.name} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {group.name}
          </h3>

          <ul className="flex flex-col gap-1.5">
            {group.entries.map((entry) => {
              const EntryIcon = entry.icon

              return (
                <li key={entry.type}>
                  <button
                    type="button"
                    data-slot="palette-entry"
                    data-block-type={entry.type}
                    // Enter and Space are a button's own activation keys, so
                    // Requirement 12.3's two keys need no handler of their own.
                    onClick={() => onInsert(entry.type)}
                    className="flex w-full items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-left focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
                  >
                    <EntryIcon
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />

                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm">
                        {BLOCK_TYPE_LABELS[entry.type]}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {entry.emits}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
