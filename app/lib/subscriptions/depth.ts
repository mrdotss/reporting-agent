/**
 * The data-depth coach: what a connector could read better, as a checklist.
 *
 * **Pure**, and deliberately not `server-only`, so the panel and its tests read the
 * same rules. Every item is derived from something already recorded — the connector's
 * own Verify, the depth its metrics history was measured at, and the gaps its latest
 * completed run wrote into its snapshot. Nothing here adds a figure to a report; it
 * turns a gap that recurs every month into one thing somebody can do about it.
 *
 * An item that depends on a run reads `unknown` until the connector has one. Saying
 * "done" there would claim a check that never happened.
 */

export type DepthState = "done" | "open" | "unknown"

export type DepthItem = {
  readonly key: DepthItemKey
  readonly title: string
  /** One sentence on what it changes in the report, or what is left to do. */
  readonly detail: string
  readonly state: DepthState
  /** Distinct resources (or regions) the last run recorded this for; `null` when not counted. */
  readonly affected: number | null
  /** How to close it, in order. Empty for an item that is done. */
  readonly steps: readonly string[]
}

export type DepthItemKey =
  | "access"
  | "access_errors"
  | "compute_optimizer"
  | "aws_backup"
  | "metric_history"
  | "azure_backup"

export type DepthGap = { readonly gapType: string; readonly resourceId: string }

export type DepthInput = {
  readonly provider: string
  readonly scopeVerified: boolean
  /** Azure: the oldest exported metric the connector's Verify found, or `null` for none. */
  readonly metricsHistorySince: string | null
  /** The latest completed run's gaps, or `null` when the connector has no completed run. */
  readonly gaps: readonly DepthGap[] | null
}

export type DepthChecklist = {
  readonly items: readonly DepthItem[]
  readonly done: number
  readonly total: number
}

/** The gaps that mean the connector's access fell short, rather than the estate. */
const ACCESS_GAP_TYPES: ReadonlySet<string> = new Set([
  "permission_denied",
  "region_unreachable",
  "fact_unavailable",
])

function affected(gaps: readonly DepthGap[], types: ReadonlySet<string>): number {
  return new Set(gaps.filter((gap) => types.has(gap.gapType)).map((gap) => gap.resourceId)).size
}

const monthYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** The checklist for one connector. **Pure.** */
export function depthChecklist(input: DepthInput): DepthChecklist {
  const items: DepthItem[] = []
  const gaps = input.gaps
  const aws = input.provider === "aws"

  items.push(
    input.scopeVerified
      ? {
          key: "access",
          title: aws ? "Read-only role verified" : "Read-only access verified",
          detail: "The connector's last Verify passed.",
          state: "done",
          affected: null,
          steps: [],
        }
      : {
          key: "access",
          title: aws ? "Verify the read-only role" : "Verify read-only access",
          detail: "Nothing can be collected until the connector's Verify passes.",
          state: "open",
          affected: null,
          steps: [aws ? "Open Role setup and run Verify." : "Open the connector and run Verify."],
        }
  )

  // A gap-derived item: `unknown` before any run, `done` when the run recorded none.
  const fromGaps = (
    key: DepthItemKey,
    types: ReadonlySet<string>,
    copy: {
      readonly openTitle: string
      readonly doneTitle: string
      readonly openDetail: (count: number) => string
      readonly doneDetail: string
      readonly steps: readonly string[]
    }
  ): DepthItem => {
    if (gaps === null) {
      return {
        key,
        title: copy.openTitle,
        detail: "Checked after this connector's first completed report.",
        state: "unknown",
        affected: null,
        steps: [],
      }
    }
    const count = affected(gaps, types)
    return count === 0
      ? { key, title: copy.doneTitle, detail: copy.doneDetail, state: "done", affected: 0, steps: [] }
      : { key, title: copy.openTitle, detail: copy.openDetail(count), state: "open", affected: count, steps: copy.steps }
  }

  if (aws) {
    items.push(
      fromGaps("compute_optimizer", new Set(["optimizer_not_available"]), {
        openTitle: "Enroll AWS Compute Optimizer",
        doneTitle: "Compute Optimizer answers",
        openDetail: (count) =>
          `${plural(count, "instance")} had no rightsizing finding, so the Rightsizing section has nothing to say about them.`,
        doneDetail: "Every instance in the last report had a rightsizing finding.",
        steps: [
          "In the customer's account, open AWS Compute Optimizer and choose Get started, or run: aws compute-optimizer update-enrollment-status --status Active",
          "Findings appear once an instance has about 30 hours of metrics, so the next monthly report carries them.",
          "Optional: publish memory with the CloudWatch agent, so Compute Optimizer sizes on memory as well as CPU.",
        ],
      }),
      fromGaps("aws_backup", new Set(["backup_not_configured"]), {
        openTitle: "Protect resources with AWS Backup",
        doneTitle: "Every resource has a backup",
        openDetail: (count) =>
          `${plural(count, "instance, volume or database", "instances, volumes or databases")} had no backup, so the Backups section reports none.`,
        doneDetail: "Every instance, volume and database in the last report was protected by AWS Backup.",
        steps: [
          "In AWS Backup, create a backup plan with the retention the customer needs.",
          "Assign the resources to it, by tag or by resource ID.",
          "The next report shows each one's last backup and vault.",
        ],
      })
    )
  } else {
    items.push(
      input.metricsHistorySince === null
        ? {
            key: "metric_history",
            title: "Keep metrics longer than 93 days",
            detail:
              "Azure keeps platform metrics for 93 days, so a trend reaches back about three months unless metrics are exported.",
            state: "open",
            affected: null,
            steps: [
              "Add a diagnostic setting that sends AllMetrics from each VM to a Log Analytics workspace, one by one or with Azure Policy.",
              "Give the connector's service principal Log Analytics Reader on that workspace.",
              "Verify the connector again, so it measures how far back the history reaches.",
            ],
          }
        : {
            key: "metric_history",
            title: "Metrics kept in Log Analytics",
            detail: `Exported metrics reach back to ${monthYear.format(new Date(input.metricsHistorySince))}.`,
            state: "done",
            affected: null,
            steps: [],
          },
      fromGaps("azure_backup", new Set(["backup_not_configured"]), {
        openTitle: "Protect VMs with Azure Backup",
        doneTitle: "Every VM has a backup",
        openDetail: (count) =>
          `${plural(count, "resource")} had no backup, so the Backup report section lists none for them.`,
        doneDetail: "Every VM in the last report was protected by a Recovery Services vault.",
        steps: [
          "Create or pick a Recovery Services vault in the VM's region.",
          "Enable backup for each VM with a backup policy.",
          "The next report shows each one's last backup.",
        ],
      })
    )
  }

  items.push(
    fromGaps("access_errors", ACCESS_GAP_TYPES, {
      openTitle: "Fix access errors",
      doneTitle: "No access errors",
      openDetail: (count) =>
        `The last report could not read ${plural(count, "resource or region", "resources or regions")}: a permission was refused or a service did not answer.`,
      doneDetail: "Every read in the last report was allowed.",
      steps: [
        "Open the last report's Recorded gaps and look under Permission denied, Region unreachable and Fact unavailable.",
        aws
          ? "Re-run the role setup script, which grants every permission the reader needs, then Verify."
          : "Grant the missing role on the subscription, then Verify.",
      ],
    })
  )

  const done = items.filter((item) => item.state === "done").length
  return { items, done, total: items.length }
}
