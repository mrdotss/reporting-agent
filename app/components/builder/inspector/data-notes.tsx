"use client"

import { ShieldCheckIcon } from "@phosphor-icons/react"

import {
  expansionFor,
  type CatalogueSection,
  type Provider,
} from "@/lib/builder/catalogue"
import type { BlockRef } from "@/lib/builder/store"

/**
 * Where a block's figures come from, per provider — the Data tab.
 *
 * AWS and Azure answer the same question from different places, and a consultant choosing a
 * metric or a lookback needs to know which: CloudWatch keeps detailed metrics for about
 * three months and has no memory metric for EC2 without its agent; Azure Monitor keeps 93
 * days and goes further only through Log Analytics.
 */

const METRIC_SOURCE: Readonly<Record<Provider, string>> = {
  aws: "CloudWatch, read with GetMetricData at hourly points. EC2 reports no memory figure without the CloudWatch agent.",
  azure: "Azure Monitor metrics at hourly points. Memory comes from the guest counters where the machine sends them.",
}

const FACT_SOURCES: Readonly<Record<string, string>> = {
  aws: "AWS describe calls in each region",
  aws_backup: "AWS Backup",
  compute_optimizer: "AWS Compute Optimizer",
  resource_graph: "Azure Resource Graph",
  arm: "Azure Resource Manager",
  recovery_services: "Azure Backup (Recovery Services)",
  capacity: "Azure capacity data",
  advisor: "Azure Advisor",
}

function sourcesOf(entry: CatalogueSection): string {
  const named = entry.needsFactSources.map((source) => FACT_SOURCES[source] ?? source)
  return named.length > 0 ? named.join(", ") : "the inventory scan"
}

export function DataNote({
  kind,
  provider,
  entry,
  ref_,
}: Readonly<{ kind: "section" | "block"; provider: Provider; entry: CatalogueSection; ref_?: BlockRef }>) {
  const lines: string[] = []
  if (kind === "section") {
    lines.push(`Selects ${entry.needsResourceTypes.join(", ") || "the whole estate"} from the snapshot.`)
    if (entry.needsFactSources.length > 0) lines.push(`Facts from ${sourcesOf(entry)}.`)
    if (entry.metricBearing) lines.push(METRIC_SOURCE[provider])
    if (entry.drawsFromPriorRuns) lines.push("Earlier months come from this preset's earlier verified reports.")
  } else if (ref_?.kind === "text") {
    lines.push("Words you typed. Numbers are refused here, so every number in the report stays traceable to the snapshot.")
  } else if (ref_?.kind === "each") {
    lines.push(`One repetition per resource the section selects, in the snapshot's order or ranked by its top-N rule.`)
  } else if (ref_?.kind === "slot") {
    const block = expansionFor(entry, ref_.slot)?.block
    switch (block) {
      case "timeseries_chart":
      case "metric_summary":
      case "top_n_table":
        lines.push(METRIC_SOURCE[provider])
        lines.push("Each plotted value and each cell is a figure in the report's ledger, traced to its snapshot path.")
        break
      case "historical_trend":
        lines.push("One point per month from earlier verified reports of this preset; a month with none reads as not measured.")
        break
      case "resource_narrative":
      case "trend_narrative":
        lines.push("Written when the report runs, from figures already in the ledger. A number that matches no traced figure fails verification.")
        break
      case "resource_table":
        lines.push(`Facts from ${sourcesOf(entry)}, each with the instant it was observed.`)
        break
      case "heading":
        lines.push("A heading carries no figure.")
        break
      default:
        lines.push("Computed from the snapshot when the report runs.")
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
      <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
        <ShieldCheckIcon aria-hidden className="size-3.5 text-primary" />
        {provider === "aws" ? "AWS" : "Azure"} · where this comes from
      </span>
      {lines.map((line) => (
        <p key={line} className="text-muted-foreground">{line}</p>
      ))}
    </div>
  )
}
