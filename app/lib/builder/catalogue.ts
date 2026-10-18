import rawSections from "../../../agent/src/reporting_agent/catalog/sections.v1.json"

import { messageText, type MessageId } from "@/lib/messages/catalog"
import {
  SECTION_SLOTS_BY_PROVIDER,
  type SlotShape,
} from "@/lib/templates/definition"

/**
 * The section catalogue as the builder reads it — one provider's sections, each with its
 * slots and the block config the canvas draws from.
 *
 * The same shared JSON file both validators and the runtime read
 * (`agent/.../catalog/sections.v1.json`). `definition.ts` already brings it into the client
 * bundle for the validator's key sets, so reading it here adds nothing to what ships.
 *
 * ## AWS and Azure are different catalogues
 *
 * Not one list with a provider flag: each provider has its own sections (AWS `rightsizing`
 * from Compute Optimizer, Azure `recommendations` from Advisor), its own fixed closing order
 * and its own metrics. A preset belongs to one provider, fixed at creation, and every
 * reader here takes that provider rather than defaulting one.
 */

export type Provider = "aws" | "azure"
export type Language = "en" | "id"

export const GROUP_ORDER = ["summary", "inventory", "utilisation", "closing"] as const
export type SectionGroup = (typeof GROUP_ORDER)[number]

export type CatalogueColumn = {
  readonly kind: "fact" | "attribute" | "metric"
  readonly id: string
}

export type CatalogueExpansion = {
  readonly slot: string
  readonly block: string
  readonly per: "section" | "resource"
  readonly config: Readonly<Record<string, unknown>>
}

export type CatalogueSection = {
  readonly key: string
  readonly number: number
  readonly titleId: string
  readonly group: SectionGroup
  readonly position: "free" | "fixed" | "always"
  readonly repeatable: boolean
  readonly needsResourceTypes: readonly string[]
  readonly needsFactSources: readonly string[]
  readonly metricBearing: boolean
  readonly optional: boolean
  readonly authorFilled: boolean
  readonly drawsFromPriorRuns: boolean
  readonly presets: Readonly<
    Record<string, readonly { readonly metric: string; readonly statistic: string }[] | "*">
  >
  readonly expansions: readonly CatalogueExpansion[]
  readonly slots: readonly SlotShape[]
  readonly notes?: string
}

type RawSection = {
  readonly key: string
  readonly number: number
  readonly title_id: string
  readonly group: SectionGroup
  readonly position: "free" | "fixed" | "always"
  readonly repeatable?: boolean
  readonly needs_resource_types?: readonly string[]
  readonly needs_fact_sources?: readonly string[]
  readonly metric_bearing?: boolean
  readonly optional?: boolean
  readonly author_filled?: boolean
  readonly draws_from_prior_verified_runs?: boolean
  readonly presets?: CatalogueSection["presets"]
  readonly notes?: string
  readonly expands_to: readonly {
    readonly slot: string
    readonly block: string
    readonly per: "section" | "resource"
    readonly config?: Readonly<Record<string, unknown>>
  }[]
}

const RAW = rawSections as unknown as {
  readonly providers: Readonly<Record<Provider, { readonly sections: readonly RawSection[] }>>
}

function build(provider: Provider): readonly CatalogueSection[] {
  return RAW.providers[provider].sections.map((raw) => ({
    key: raw.key,
    number: raw.number,
    titleId: raw.title_id,
    group: raw.group,
    position: raw.position,
    repeatable: raw.repeatable ?? false,
    needsResourceTypes: raw.needs_resource_types ?? [],
    needsFactSources: raw.needs_fact_sources ?? [],
    metricBearing: raw.metric_bearing ?? false,
    optional: raw.optional ?? false,
    authorFilled: raw.author_filled ?? false,
    drawsFromPriorRuns: raw.draws_from_prior_verified_runs ?? false,
    presets: raw.presets ?? {},
    notes: raw.notes,
    expansions: raw.expands_to.map((expansion) => ({
      slot: expansion.slot,
      block: expansion.block,
      per: expansion.per,
      config: expansion.config ?? {},
    })),
    slots: SECTION_SLOTS_BY_PROVIDER[provider]?.[raw.key] ?? [],
  }))
}

const CATALOGUES: Readonly<Record<Provider, readonly CatalogueSection[]>> = {
  aws: build("aws"),
  azure: build("azure"),
}

export function catalogueFor(provider: Provider): readonly CatalogueSection[] {
  return CATALOGUES[provider]
}

export function sectionEntry(
  provider: Provider,
  key: string
): CatalogueSection | undefined {
  return CATALOGUES[provider].find((entry) => entry.key === key)
}

export function expansionFor(
  entry: CatalogueSection,
  slot: string
): CatalogueExpansion | undefined {
  return entry.expansions.find((expansion) => expansion.slot === slot)
}

/** A section's catalogue title in the report's language. */
export function sectionTitle(entry: CatalogueSection | undefined, language: Language): string {
  if (entry === undefined) return "Unknown section"
  return messageText(entry.titleId as MessageId, language) ?? entry.key
}

/** The columns a `resource_table` expansion declares, in catalogue order. */
export function declaredColumns(expansion: CatalogueExpansion | undefined): CatalogueColumn[] {
  const columns = expansion?.config.columns
  if (!Array.isArray(columns)) return []
  return columns.flatMap((column: unknown): CatalogueColumn[] => {
    if (typeof column !== "object" || column === null) return []
    const record = column as Record<string, unknown>
    if (typeof record.fact_key === "string") return [{ kind: "fact", id: record.fact_key }]
    if (typeof record.attribute === "string")
      return [{ kind: "attribute", id: record.attribute }]
    return []
  })
}

const FACT_INITIALISMS: Readonly<Record<string, string>> = {
  ip: "IP",
  os: "OS",
  nic: "NIC",
  nsg: "NSG",
  gb: "GB",
  gib: "GiB",
  fqdn: "FQDN",
  iops: "IOPS",
  id: "ID",
  sku: "SKU",
  cpu: "CPU",
  vm: "VM",
  dns: "DNS",
  vpc: "VPC",
  vcpus: "vCPUs",
  az: "AZ",
  cidr: "CIDR",
  ips: "IPs",
}

/**
 * A column's header as the report prints it.
 *
 * An attribute takes its catalogue message (`doc.table.attr.*`). A fact is its key
 * humanised — `private_ip` reads "Private IP" — which is `compile/blocks/tables.py`'s
 * `_fact_header`, ported rather than approximated so the canvas and the document agree.
 */
export function columnLabel(column: CatalogueColumn, language: Language): string {
  if (column.kind === "attribute") {
    const id = column.id === "fidelity_tier" ? "doc.table.fidelity" : `doc.table.attr.${column.id}`
    return messageText(id as MessageId, language) ?? column.id
  }
  const words = column.id.replace(/^pg_/, "").split("_").filter(Boolean)
  if (words.length === 0) return column.id
  return words
    .map(
      (word, index) =>
        FACT_INITIALISMS[word] ??
        (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)
    )
    .join(" ")
}

/** The resource noun a provider's per-resource group repeats over, for the canvas label. */
export function resourceNoun(entry: CatalogueSection): string {
  const type = entry.needsResourceTypes[0] ?? ""
  if (type.includes("EC2::Instance")) return "instance"
  if (type.includes("virtualMachines")) return "machine"
  if (type.includes("DBforPostgreSQL")) return "server"
  if (type.includes("VPC") || type.includes("virtualNetworks")) return "network"
  if (type.includes("SecurityGroup") || type.includes("networkSecurityGroups")) return "group"
  return "resource"
}
