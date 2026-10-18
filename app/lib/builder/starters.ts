import type { MetricCatalogSnapshot } from "@/lib/templates/definition"
import type { DesignPreset } from "@/lib/templates/definition"
import { expandPreset } from "@/lib/profiles/presets"

import { sectionEntry, type Provider } from "./catalogue"
import { emptyDraftV4, newSection, settled } from "./draft"
import { themeAccent } from "./theme"
import type { DefinitionV4, SectionV4 } from "./model"

/**
 * The Start screen's gallery: seven starting points per provider.
 *
 * Each names the sections it starts with **per provider**, because the providers do not
 * share them: AWS's rightsizing comes from Compute Optimizer and its backups from AWS
 * Backup; Azure's from Advisor and Recovery Services. A starter is a starting draft, not a
 * stored template — choosing one writes its sections into a new preset, which is then the
 * author's to change.
 *
 * Quarterly review reports the last full month, with a three-month trend: a report period
 * is at most 31 days, so "quarterly" is the trend's depth, not the period's.
 */

export const STARTER_KEYS_V4 = [
  "monthly_utilization",
  "executive_brief",
  "capacity_planning",
  "backup_exposure",
  "rightsizing_review",
  "quarterly_review",
  "blank",
] as const

export type StarterKey = (typeof STARTER_KEYS_V4)[number]

type StarterSection = { readonly type: string; readonly preset?: string; readonly lookback?: number }

export type Starter = {
  readonly key: StarterKey
  readonly name: string
  readonly blurb: string
  readonly theme: DesignPreset
  readonly period: "last_full_month" | "last_30d"
  readonly sections: Readonly<Record<Provider, readonly StarterSection[]>>
  /** Shown as new in the gallery: the starters this redesign added. */
  readonly isNew: boolean
}

const COVERAGE: StarterSection = { type: "coverage_and_verification" }

export const STARTERS: readonly Starter[] = [
  {
    key: "monthly_utilization",
    name: "Monthly utilisation",
    blurb: "Inventory, how each machine ran, and backups, for the month just closed.",
    theme: "corporate",
    period: "last_full_month",
    isNew: false,
    sections: {
      aws: [{ type: "at_a_glance" }, { type: "aws_account" }, { type: "ec2_instances" }, { type: "ec2_utilization" }, { type: "rds_utilization" }, { type: "backups" }, COVERAGE],
      azure: [{ type: "at_a_glance" }, { type: "azure_subscription" }, { type: "resource_groups" }, { type: "virtual_machines" }, { type: "vm_utilization" }, { type: "backup_report" }, COVERAGE],
    },
  },
  {
    key: "executive_brief",
    name: "Executive brief",
    blurb: "One page of headline counts and decisions, then what needs tidying and who owns it.",
    theme: "corporate",
    period: "last_full_month",
    isNew: true,
    sections: {
      aws: [{ type: "at_a_glance" }, { type: "aws_account" }, { type: "housekeeping" }, { type: "action_register" }, COVERAGE],
      azure: [{ type: "at_a_glance" }, { type: "azure_subscription" }, { type: "housekeeping" }, { type: "action_register" }, COVERAGE],
    },
  },
  {
    key: "capacity_planning",
    name: "Capacity planning",
    blurb: "Peaks, P95 and six months of trend, for a right-sizing conversation.",
    theme: "technical",
    period: "last_30d",
    isNew: false,
    sections: {
      aws: [{ type: "ec2_utilization", preset: "capacity_planning" }, { type: "historical_ec2_utilization", lookback: 6 }, { type: "rds_utilization", preset: "capacity_planning" }, { type: "ebs_activity" }, COVERAGE],
      azure: [{ type: "vm_utilization", preset: "capacity_planning" }, { type: "historical_vm_utilization", lookback: 6 }, { type: "database_utilization", preset: "capacity_planning" }, { type: "app_service_and_storage" }, COVERAGE],
    },
  },
  {
    key: "backup_exposure",
    name: "Backup & exposure",
    blurb: "What has no backup, what faces the internet, and what bills without working.",
    theme: "minimal",
    period: "last_full_month",
    isNew: true,
    sections: {
      aws: [{ type: "at_a_glance" }, { type: "backups" }, { type: "elastic_ips" }, { type: "security_groups" }, { type: "housekeeping" }, COVERAGE],
      azure: [{ type: "at_a_glance" }, { type: "backup_report" }, { type: "public_ip_addresses" }, { type: "network_security_groups" }, { type: "housekeeping" }, COVERAGE],
    },
  },
  {
    key: "rightsizing_review",
    name: "Rightsizing review",
    blurb: "How machines ran beside the provider's own sizing advice, with owners for each change.",
    theme: "technical",
    period: "last_full_month",
    isNew: true,
    sections: {
      aws: [{ type: "ec2_utilization" }, { type: "rightsizing" }, { type: "housekeeping" }, { type: "action_register" }, COVERAGE],
      azure: [{ type: "vm_utilization" }, { type: "recommendations" }, { type: "housekeeping" }, { type: "action_register" }, COVERAGE],
    },
  },
  {
    key: "quarterly_review",
    name: "Quarterly review",
    blurb: "The month just closed with three months of trend behind it, for a business review.",
    theme: "editorial",
    period: "last_full_month",
    isNew: true,
    sections: {
      aws: [{ type: "at_a_glance" }, { type: "aws_account" }, { type: "ec2_utilization" }, { type: "historical_ec2_utilization", lookback: 3 }, { type: "rds_utilization" }, { type: "backups" }, { type: "rightsizing" }, { type: "action_register" }, COVERAGE],
      azure: [{ type: "at_a_glance" }, { type: "azure_subscription" }, { type: "vm_utilization" }, { type: "historical_vm_utilization", lookback: 3 }, { type: "database_utilization" }, { type: "backup_report" }, { type: "recommendations" }, { type: "action_register" }, COVERAGE],
    },
  },
  {
    key: "blank",
    name: "Blank",
    blurb: "Only the verification appendix. Add sections from the catalogue.",
    theme: "minimal",
    period: "last_full_month",
    isNew: false,
    sections: { aws: [COVERAGE], azure: [COVERAGE] },
  },
]

export function starterFor(key: string): Starter | undefined {
  return STARTERS.find((starter) => starter.key === key)
}

/** A new v4 draft from a starter, for one provider, in one theme. */
export function starterDraft(
  starter: Starter,
  provider: Provider,
  name: string,
  theme: DesignPreset,
  catalog: MetricCatalogSnapshot
): DefinitionV4 {
  const base = emptyDraftV4(name, provider)
  const sections: SectionV4[] = starter.sections[provider].map((item) => {
    const section = newSection(provider, item.type, catalog)
    const entry = sectionEntry(provider, item.type)
    const metrics =
      item.preset && entry
        ? expandPreset(
            { key: entry.key, needs_resource_types: entry.needsResourceTypes, presets: entry.presets },
            item.preset,
            catalog
          )
        : section.metrics
    return {
      ...section,
      // A preset a section's catalogue entry does not declare expands to nothing; the
      // standard set the section was seeded with stays.
      metrics: [...(metrics && metrics.length > 0 ? metrics : (section.metrics ?? []))],
      ...(item.lookback ? { lookback: item.lookback } : {}),
    }
  })
  return {
    ...base,
    identity: { ...base.identity, report_title: name, description: starter.blurb },
    period: { kind: starter.period },
    design: { ...base.design, preset: theme, accent_color: themeAccent(theme) },
    sections: settled(provider, sections),
  }
}
