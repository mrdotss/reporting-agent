import type { ChatCitation } from "@/lib/chat/views"

/**
 * Where one figure came from, as the steps the trace panel lays out.
 *
 * Built from the citation the message stores, plus the attached report's own record when the
 * citation names one. Nothing here is computed or invented: a step appears only when the
 * citation (or the report row) holds what it would say, and the sentences about what
 * verification does are the product's standing rule, not a claim about this one figure.
 */

export type TraceKind = "verified" | "live" | "unsourced"

export type TraceStep = {
  readonly title: string
  readonly detail: string
  /** An identifier, path or timestamp, set in the mono face. */
  readonly mono?: string
}

export type TraceRun = {
  readonly runId: string
  readonly digest: string
  readonly verifiedAt: string
}

export type FigureTrace = {
  readonly kind: TraceKind
  /** The badge under the figure. */
  readonly badge: string
  readonly steps: readonly TraceStep[]
  readonly note: string
  /** Where the report behind a report figure can be opened, when the citation names one. */
  readonly href?: string
  readonly hrefLabel?: string
}

const WHEN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** `30 Sep, 00:23 WIB`, or `""` for a value that is not a date. */
export function whenWib(iso: string | undefined): string {
  if (!iso) return ""
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "" : `${WHEN.format(date)} WIB`
}

function utcMinute(iso: string | undefined): string | undefined {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : undefined
}

function join(
  parts: readonly (string | undefined)[],
  separator = " · "
): string {
  return parts.filter((part): part is string => Boolean(part)).join(separator)
}

export function traceFor(
  citation: ChatCitation | undefined,
  runs: readonly TraceRun[]
): FigureTrace {
  if (citation === undefined) {
    return {
      kind: "unsourced",
      badge: "No source recorded",
      steps: [],
      note: "This answer quotes the figure but the conversation holds no record of where it came from. Treat it as unchecked.",
    }
  }

  if (citation.source === "report") {
    const run = runs.find((candidate) => candidate.runId === citation.run_id)
    const verified = whenWib(run?.verifiedAt)
    return {
      kind: "verified",
      badge: "Verified report",
      steps: [
        {
          title: "Verified report",
          detail:
            join([citation.customer_name, citation.period_display]) ||
            "A verified report",
          mono: verified ? `verified ${verified}` : undefined,
        },
        {
          title: "Where in the report",
          detail: citation.label,
          mono: citation.snapshot_path,
        },
        {
          title: "Snapshot",
          detail: "The data collected for the report",
          mono: run?.digest,
        },
        {
          title: "Re-derived before delivery",
          detail:
            "The verifier recomputes every figure in a report from its snapshot.",
        },
      ],
      note: "This number is in the delivered report. Ask quotes it; it does not compute it.",
      href: citation.run_id
        ? `/reports/${encodeURIComponent(citation.run_id)}/figures`
        : undefined,
      hrefLabel: "Trace it in the report",
    }
  }

  if (citation.source === "live") {
    return {
      kind: "live",
      badge: "Live · not verified",
      steps: [
        {
          title: "Live pull",
          detail:
            join([citation.connector_label, citation.period_display]) ||
            "Collected on request",
          mono: utcMinute(citation.collected_at)
            ? `collected ${utcMinute(citation.collected_at)}`
            : undefined,
        },
        { title: "Figure", detail: citation.label },
        {
          title: "Not verified",
          detail: "No report compiled or checked this figure.",
        },
      ],
      note: "Collected on request for this conversation. It is real data, but nothing has checked it the way a report figure is checked.",
    }
  }

  if (citation.source === "scan") {
    return {
      kind: "verified",
      badge: "Saved scan",
      steps: [
        {
          title: "Saved scan",
          detail: "A connector's inventory, read when it was last scanned",
          mono: citation.collected_at
            ? `scanned ${citation.collected_at.slice(0, 10)}`
            : undefined,
        },
        { title: "Figure", detail: citation.label },
      ],
      note: "A count read from the saved scan. It is as current as that scan.",
    }
  }

  if (citation.source === "price") {
    return {
      kind: "verified",
      badge: "List price",
      steps: [
        {
          title: "Price list",
          detail: join([
            citation.price_source ?? "Azure Retail Prices",
            citation.currency,
            "list price, pay-as-you-go",
          ]),
        },
        {
          title: "Item",
          detail:
            join([citation.sku, citation.operating_system, citation.region]) ||
            citation.label,
          mono: citation.unit_of_measure,
        },
        ...(citation.effective_start
          ? [
              {
                title: "Effective",
                detail: `From ${citation.effective_start.slice(0, 10)}`,
              },
            ]
          : []),
      ],
      note: "A list price, looked up when the question was asked. Costs built from it are arithmetic, so they are marked as estimates.",
    }
  }

  return {
    kind: "unsourced",
    badge: "Unknown source",
    steps: [{ title: "Figure", detail: citation.label }],
    note: "This figure names a kind of source this page does not know how to describe.",
  }
}

/** The one line under a figure in "Figures in this answer": which source it was read from. */
export function sourceLine(citation: ChatCitation | undefined): string {
  if (citation === undefined) return "No source recorded"
  switch (citation.source) {
    case "report":
      return (
        join([citation.customer_name, citation.period_display]) ||
        "Verified report"
      )
    case "live":
      return join(["Live pull", citation.connector_label, "not verified"])
    case "scan":
      return join(["Saved scan", citation.collected_at?.slice(0, 10)])
    case "price":
      return join([
        citation.price_source ?? "Azure Retail Prices",
        citation.currency,
        "list price",
      ])
    default:
      return "Unknown source"
  }
}
