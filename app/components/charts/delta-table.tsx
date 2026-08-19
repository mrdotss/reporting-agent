"use client"

import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon } from "@phosphor-icons/react"

/**
 * The comparison delta table (Requirements 22.11, 22.13, 42.10).
 *
 * ## Direction is a glyph and a sign, never a hue
 *
 * `design-system.md` and Requirement 22.13 both land on this, and it is the
 * decision that shapes the component: **no red for "worse", no green for
 * "better"**. Two reasons, and the second is the stronger one.
 *
 * The first is accessibility — a red/green delta is invisible to the most common
 * colour-vision deficiency, and this table is nothing *but* deltas.
 *
 * The second is that the product cannot know which direction is good. CPU up 30%
 * is a capacity problem or a successful migration; memory down is right-sizing
 * or an outage. Colouring a delta asserts a judgement the data does not contain,
 * and `--destructive` in particular is reserved for one meaning: *this document
 * could not be proven*. A negative delta is not that.
 *
 * So direction is an **arrow glyph** plus a **signed magnitude**, both in the
 * foreground colour, and the reader decides what it means.
 *
 * ## A tier change is not comparable, and is not shown as a delta
 *
 * Requirement 22.11's last clause. A `baseline` percentile and an `enhanced` one
 * are estimates of different things — one from a sketch over hourly buckets, one
 * from the guest's own samples — so subtracting them produces a number that
 * looks like a change and is an artefact of the measurement changing. Those rows
 * say **not comparable** and print both values without a delta.
 *
 * ## Both snapshot ids in the header
 *
 * So a reader can tell which two runs produced the table, and check either
 * against the report it came from.
 */

export type DeltaRow = {
  readonly resourceId: string
  readonly resourceName: string
  readonly metricLabel: string
  /** The ledger's `formatted` string for the base run. Printed verbatim. */
  readonly baseFormatted: string
  readonly headFormatted: string
  /**
   * The signed change, already formatted by the compiler.
   *
   * `null` where the rows are not comparable. Formatted rather than computed
   * here for the reason every figure in this product is: a delta this component
   * subtracted would be a numeric with no `snapshot_path`, and the whole
   * verification chain rests on there being no such thing.
   */
  readonly deltaFormatted: string | null
  /** `-1`, `0` or `1`. `null` alongside a `null` delta. */
  readonly direction: -1 | 0 | 1 | null
  /** `true` where the two runs measured this at different fidelity tiers. */
  readonly notComparable: boolean
}

function DirectionGlyph({ direction }: Readonly<{ direction: -1 | 0 | 1 }>) {
  // `aria-hidden` because the signed magnitude beside it already carries the
  // direction to a reader — announcing "up arrow, plus 12.4%" is the same fact
  // twice.
  if (direction === 0) {
    return <ArrowRightIcon aria-hidden="true" className="inline size-3.5" />
  }

  return direction > 0 ? (
    <ArrowUpIcon aria-hidden="true" className="inline size-3.5" />
  ) : (
    <ArrowDownIcon aria-hidden="true" className="inline size-3.5" />
  )
}

export function DeltaTable({
  rows,
  baseSnapshotId,
  headSnapshotId,
}: Readonly<{
  rows: readonly DeltaRow[]
  baseSnapshotId: string
  headSnapshotId: string
}>) {
  if (rows.length === 0) {
    return (
      <p data-slot="delta-empty" className="text-sm text-muted-foreground">
        No resources are present in both runs, so there is nothing to compare.
      </p>
    )
  }

  return (
    <div data-slot="delta-table" className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="mb-2 text-left text-xs text-muted-foreground">
          Comparing snapshot{" "}
          <span className="font-mono">{baseSnapshotId.slice(0, 12)}</span> with{" "}
          <span className="font-mono">{headSnapshotId.slice(0, 12)}</span>. A
          change is shown as a direction and a signed magnitude; nothing here is
          coloured by whether a change is good.
        </caption>

        <thead>
          <tr className="border-b border-border text-left">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Resource
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Metric
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Base
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              This run
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Change
            </th>
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.resourceId}-${row.metricLabel}`}
              data-slot="delta-row"
              data-comparable={row.notComparable ? "false" : "true"}
              className="border-b border-border/50"
            >
              <td className="py-1.5 pr-3">{row.resourceName}</td>
              <td className="py-1.5 pr-3 text-muted-foreground">
                {row.metricLabel}
              </td>

              {/* Every figure mono and tabular, so the columns line up. */}
              <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                {row.baseFormatted}
              </td>
              <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                {row.headFormatted}
              </td>

              <td className="py-1.5 text-right">
                {row.notComparable || row.deltaFormatted === null ? (
                  // Requirement 22.11 — stated, not subtracted. In mist
                  // neutrals: a tier change is information about the
                  // measurement, not an error.
                  <span className="text-xs text-muted-foreground">
                    not comparable
                  </span>
                ) : (
                  <span className="font-mono tabular-nums">
                    {row.direction === null ? null : (
                      <DirectionGlyph direction={row.direction} />
                    )}{" "}
                    {row.deltaFormatted}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-xs text-muted-foreground">
        Rows whose two runs measured at different fidelity tiers are marked{" "}
        <em>not comparable</em> rather than shown as a change: a percentile from
        a sketch over hourly buckets and one from the guest&rsquo;s own samples
        estimate different things, so the difference between them would be an
        artefact of the measurement rather than a change in the resource.
      </p>
    </div>
  )
}
