"use client"

import type { FindingView } from "@/lib/db/views"

/**
 * The findings a verification recorded — blocking or advisory (Requirements
 * 39.3, 39.5, 39.10).
 *
 * ## An unrecognized type is presented, not dropped
 *
 * Requirement 39.10 is the one that shapes this component. A finding type this
 * build has never heard of — because the agent shipped a new blocking check —
 * must still appear, under the classification the **result** recorded, with its
 * type string and its locating fields, and must be counted.
 *
 * So there is no `switch` over known types here and no lookup table that could
 * return `undefined`. Every field is rendered if present and omitted if not, and
 * the type string is printed verbatim. A panel that recognized types would
 * silently under-report the day the agent learned a new one, and the
 * under-reported number is the count a consultant reads as "how much is wrong".
 *
 * ## Why the locating fields are a definition list
 *
 * Requirement 39.3 wants "the AST path, the table identity with its row key and
 * column key, the surviving substring with its paragraph location, and the
 * expected and observed strings". Those are labelled values, and a paragraph of
 * prose would make a consultant parse them out. The label is what makes
 * `expected` and `observed` legible — two bare strings side by side are a puzzle.
 */

/** The locating fields, in the order a reader needs them. */
const LOCATORS: readonly {
  readonly key: keyof FindingView
  readonly label: string
  readonly mono?: boolean
}[] = [
  { key: "astPath", label: "AST path", mono: true },
  { key: "blockId", label: "Block", mono: true },
  { key: "tableId", label: "Table", mono: true },
  { key: "rowKey", label: "Row", mono: true },
  { key: "columnKey", label: "Column", mono: true },
  { key: "expected", label: "Expected", mono: true },
  { key: "observed", label: "Observed", mono: true },
  { key: "formatted", label: "Formatted", mono: true },
  { key: "substring", label: "Surviving text", mono: true },
  { key: "region", label: "Region" },
  { key: "paragraphOrdinal", label: "Paragraph" },
  { key: "matchCount", label: "Matches" },
  { key: "resourceId", label: "Resource", mono: true },
  { key: "snapshotPath", label: "Snapshot path", mono: true },
]

function Finding({
  finding,
  blocking,
}: Readonly<{ finding: FindingView; blocking: boolean }>) {
  const located = LOCATORS.filter(
    (locator) => finding[locator.key] !== undefined
  )

  return (
    <li
      data-slot="finding"
      data-finding-type={finding.type}
      data-severity={finding.severity}
      className={[
        "flex flex-col gap-1.5 rounded-lg border px-3 py-2",
        // Requirement 39.6 — `--destructive` on the failure state, and on
        // nothing else. An advisory finding is information; styling it the same
        // as a blocking one would make the token mean "something is written
        // here" rather than "this document could not be proven".
        blocking ? "border-destructive/40" : "border-border",
      ].join(" ")}
    >
      <p
        className={[
          "font-mono text-xs",
          blocking ? "text-destructive" : "text-muted-foreground",
        ].join(" ")}
      >
        {/* Requirement 39.10 — the recorded type string, verbatim. */}
        {finding.type}
      </p>

      {finding.message === undefined ? null : (
        <p className="max-w-prose text-sm">{finding.message}</p>
      )}

      {located.length === 0 ? null : (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
          {located.map((locator) => (
            <div key={String(locator.key)} className="flex gap-2">
              <dt className="shrink-0 text-muted-foreground">{locator.label}</dt>
              <dd
                className={[
                  "min-w-0 break-all",
                  locator.mono ? "font-mono" : "",
                ].join(" ")}
              >
                {String(finding[locator.key])}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

export function FindingList({
  findings,
  blocking,
  emptyText,
}: Readonly<{
  findings: readonly FindingView[]
  /** Whether these are the findings that caused the failure. */
  blocking: boolean
  emptyText: string
}>) {
  if (findings.length === 0) {
    return (
      <p
        data-slot="finding-list-empty"
        className="text-sm text-muted-foreground"
      >
        {emptyText}
      </p>
    )
  }

  return (
    <ul
      data-slot={blocking ? "blocking-findings" : "advisory-findings"}
      className="flex flex-col gap-2"
    >
      {findings.map((finding, index) => (
        <Finding
          key={`${finding.type}-${index}`}
          finding={finding}
          blocking={blocking}
        />
      ))}
    </ul>
  )
}
