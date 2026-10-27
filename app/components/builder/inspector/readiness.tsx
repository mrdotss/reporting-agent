"use client"

import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react"

import { useBuilder, useIssues } from "@/components/builder/context"
import type { BuilderIssue } from "@/lib/builder/issues"
import { cn } from "@/lib/utils"

/**
 * "Before you publish": what is left to fix, always in view at the top of the right rail.
 *
 * The same issues Publish refuses on (`builderIssues`), so the rail and the button cannot
 * disagree. Three named checks first, the ones every preset meets the same way, then each
 * remaining issue as a row that opens the section, block or panel that fixes it.
 */

/** Opens what fixes an issue: a section or block on the page, or a left panel. */
export function useGoToIssue(): (issue: BuilderIssue) => void {
  const setMode = useBuilder((state) => state.setMode)
  const setLeftTab = useBuilder((state) => state.setLeftTab)
  const select = useBuilder((state) => state.select)
  return (issue) => {
    setMode("edit")
    if ("tab" in issue.target) setLeftTab(issue.target.tab)
    else {
      setLeftTab("outline")
      select(issue.target.selection)
    }
  }
}

type Check = { readonly label: string; readonly issues: readonly BuilderIssue[] }

function isCustomer(issue: BuilderIssue): boolean {
  return issue.path[0] === "identity" && issue.path[1] === "customer_name"
}

function isNoSections(issue: BuilderIssue): boolean {
  return issue.path.length === 1 && issue.path[0] === "sections"
}

function isMissingMetrics(issue: BuilderIssue): boolean {
  return issue.path[0] === "sections" && issue.path[2] === "metrics" && issue.path.length === 3
}

export function Readiness() {
  const issues = useIssues()
  const go = useGoToIssue()

  const checks: Check[] = [
    { label: "Customer named", issues: issues.filter(isCustomer) },
    { label: "At least one section", issues: issues.filter(isNoSections) },
    { label: "Metrics chosen where a section reports them", issues: issues.filter(isMissingMetrics) },
  ]
  const rest = issues.filter((issue) => !isCustomer(issue) && !isNoSections(issue) && !isMissingMetrics(issue))
  checks.push({ label: "Everything else the run checks", issues: rest })

  return (
    <section
      aria-label="Before you publish"
      data-slot="readiness"
      className={cn(
        "mb-3.5 flex flex-col gap-2 rounded-xl border p-3",
        issues.length === 0
          ? "border-border bg-card"
          : "border-[color-mix(in_oklab,var(--status-attention)_35%,transparent)] bg-[var(--status-attention-soft)]"
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Before you publish</h2>
        <span
          role="status"
          className={cn(
            "text-xs font-medium",
            issues.length === 0 ? "text-[var(--status-verified)]" : "text-[var(--status-attention)]"
          )}
        >
          {issues.length === 0 ? "Ready" : `${issues.length} left`}
        </span>
      </div>

      <ul className="flex flex-col gap-1">
        {checks.map((check) => (
          <li key={check.label} className="flex items-start gap-1.5 text-[12.5px]">
            {check.issues.length === 0 ? (
              <CheckCircleIcon aria-hidden weight="fill" className="mt-px size-4 shrink-0 text-[var(--status-verified)]" />
            ) : (
              <WarningCircleIcon aria-hidden weight="fill" className="mt-px size-4 shrink-0 text-[var(--status-attention)]" />
            )}
            <span className="flex-1">
              <span className="sr-only">{check.issues.length === 0 ? "Done: " : "To fix: "}</span>
              {check.label}
            </span>
            {check.issues.length > 1 && (
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{check.issues.length}</span>
            )}
          </li>
        ))}
      </ul>

      {issues.length > 0 && (
        <ul className="flex max-h-56 flex-col gap-0.5 overflow-auto border-t border-[color-mix(in_oklab,var(--status-attention)_25%,transparent)] pt-1.5">
          {issues.map((issue, index) => (
            <li key={`${issue.path.join(".")}-${index}`}>
              <button
                type="button"
                onClick={() => go(issue)}
                className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-card/70"
              >
                <span className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{issue.label}</span>
                <span className="text-[12.5px] leading-snug">{issue.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
