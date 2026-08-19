"use client"

import { ColumnsIcon } from "@phosphor-icons/react"

import type { RowBlock } from "@/lib/templates/definition"

/**
 * The row's column-count control (Requirement 12.9, `design-system.md`).
 *
 * ## Splitting is a control, not a gesture
 *
 * `design-system.md` is explicit: "splitting is an **explicit control on the
 * row**, not a drag gesture to discover". A gesture that exists but is not shown
 * is a feature only the person who built it knows about, and the cost of getting
 * this wrong is not a missing feature — it is a consultant concluding that
 * two-column layouts are impossible.
 *
 * Two buttons rather than a stepper or a select: the whole domain is `{2, 3}`
 * (Requirement 6.2), so a control that could express `1` or `7` would be
 * offering values the reducer refuses with `invalid_column_count`.
 *
 * ## Narrowing can be refused, and the button says so before it is pressed
 *
 * The reducer refuses `column_not_empty` when narrowing a row would drop a
 * column that still holds blocks. That refusal is correct — the alternative is
 * silently deleting the consultant's work — but a button that fails when pressed
 * is worse than one that is disabled with a reason, so the count is checked here
 * and the reason is on the control.
 *
 * This does **not** duplicate the rule: the reducer still refuses, and this only
 * decides whether to offer the press. A disabled button that the reducer would
 * have accepted is a missing feature; an enabled one it refuses is an error
 * message. Both are visible, neither is silent.
 */
export function RowSplitter({
  row,
  onSplit,
}: Readonly<{
  row: RowBlock
  onSplit: (columns: 2 | 3) => void
}>) {
  const current = row.columns.length

  /** Whether narrowing to `columns` would drop a column that still holds blocks. */
  const wouldDrop = (columns: 2 | 3): boolean =>
    row.columns.slice(columns).some((column) => column.length > 0)

  return (
    <div
      data-slot="row-splitter"
      role="group"
      aria-label="Row columns"
      className="flex items-center gap-2"
    >
      <ColumnsIcon
        aria-hidden="true"
        className="size-3.5 text-muted-foreground"
      />

      <span className="text-xs text-muted-foreground">Columns</span>

      {([2, 3] as const).map((columns) => {
        const blocked = columns < current && wouldDrop(columns)
        const isCurrent = columns === current

        return (
          <button
            key={columns}
            type="button"
            data-slot="row-splitter-option"
            data-columns={columns}
            aria-pressed={isCurrent}
            disabled={blocked}
            title={
              blocked
                ? `Column ${columns + 1} still holds blocks. Move them out first.`
                : undefined
            }
            onClick={() => {
              if (!isCurrent && !blocked) onSplit(columns)
            }}
            className={[
              "rounded-md border px-2 py-0.5 font-mono text-xs tabular-nums focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none",
              isCurrent ? "border-primary" : "border-border",
              blocked ? "opacity-50" : "",
            ].join(" ")}
          >
            {columns}
          </button>
        )
      })}

      {/*
        The reason, in text rather than only in a `title`. A tooltip is not
        reachable by a keyboard user on a disabled control, and this is exactly
        the sentence they need in order to know what to do next.
      */}
      {wouldDrop(2) && current === 3 ? (
        <span className="text-xs text-muted-foreground">
          Third column holds blocks — move them out to narrow this row.
        </span>
      ) : null}
    </div>
  )
}
