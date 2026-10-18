import { SAMPLE_AVG, SAMPLE_MAX } from "@/lib/profiles/preview-sample"

import type { Provider } from "./catalogue"

/**
 * The sample the canvas draws with — never a customer's figures.
 *
 * Every number on the canvas comes from here, and the page says "Sample data" where a
 * reader cannot miss it. A delivered report's figures come from its snapshot; these exist
 * so a block has something to show while it is being laid out.
 *
 * One set per provider, because the two read differently: AWS instances live in regions
 * and carry instance types; Azure machines live in locations and carry VM sizes.
 */

export type SampleResource = {
  readonly name: string
  readonly cells: Readonly<Record<string, string>>
  readonly avg: number
  readonly peak: number
}

const AWS_RESOURCES: readonly SampleResource[] = [
  {
    name: "app-web-01",
    avg: 61.4,
    peak: 97.2,
    cells: {
      instance_type: "t3.large", platform: "Linux", private_ip: "10.0.1.24", location: "ap-southeast-1",
      power_state: "running", vcpus: "2", memory: "8 GiB", vpc: "vpc-main", subnet: "subnet-app-a",
      public_ip: "13.212.4.18", security_groups: "web-sg", resource_name: "app-web-01",
    },
  },
  {
    name: "app-api-02",
    avg: 38.9,
    peak: 71.5,
    cells: {
      instance_type: "m6i.xlarge", platform: "Linux", private_ip: "10.0.2.31", location: "ap-southeast-1",
      power_state: "running", vcpus: "4", memory: "16 GiB", vpc: "vpc-main", subnet: "subnet-app-b",
      public_ip: "", security_groups: "api-sg", resource_name: "app-api-02",
    },
  },
  {
    name: "batch-worker-03",
    avg: 12.7,
    peak: 44.0,
    cells: {
      instance_type: "c6g.large", platform: "Linux", private_ip: "10.0.3.12", location: "ap-southeast-3",
      power_state: "stopped", vcpus: "2", memory: "4 GiB", vpc: "vpc-batch", subnet: "subnet-batch",
      public_ip: "", security_groups: "batch-sg", resource_name: "batch-worker-03",
    },
  },
]

const AZURE_RESOURCES: readonly SampleResource[] = [
  {
    name: "vm-app-prod-02",
    avg: 12.48,
    peak: 27.31,
    cells: {
      vm_size: "Standard_D4s_v5", os_type: "Linux", os_build: "Ubuntu 22.04", private_ip: "10.1.0.4",
      resource_group: "rg-app-prod", location: "southeastasia", power_state: "running",
      resource_name: "vm-app-prod-02", sku_name: "Premium_LRS",
    },
  },
  {
    name: "vm-sql-prod-01",
    avg: 31.92,
    peak: 68.15,
    cells: {
      vm_size: "Standard_E8s_v5", os_type: "Windows", os_build: "Server 2022", private_ip: "10.1.0.9",
      resource_group: "rg-data-prod", location: "southeastasia", power_state: "running",
      resource_name: "vm-sql-prod-01", sku_name: "Premium_LRS",
    },
  },
  {
    name: "vm-mcp-prod-01",
    avg: 8.06,
    peak: 19.74,
    cells: {
      vm_size: "Standard_B2ms", os_type: "Linux", os_build: "Ubuntu 22.04", private_ip: "10.1.0.12",
      resource_group: "rg-app-prod", location: "indonesiacentral", power_state: "deallocated",
      resource_name: "vm-mcp-prod-01", sku_name: "StandardSSD_LRS",
    },
  },
]

export function sampleResources(provider: Provider): readonly SampleResource[] {
  return provider === "aws" ? AWS_RESOURCES : AZURE_RESOURCES
}

/** A table cell for a column the sample has no value for: a word, never an invented number. */
export function sampleCell(resource: SampleResource, column: string): string {
  return resource.cells[column] ?? (column.includes("count") ? "" : "Sample")
}

export const SAMPLE_DAYS = SAMPLE_MAX.length

/** A daily series for one resource, scaled from the shared sample shape. */
export function sampleSeries(resource: SampleResource, statistic: string): number[] {
  const base = statistic === "max" || statistic === "maximum" ? SAMPLE_MAX : SAMPLE_AVG
  const top = Math.max(...base)
  const target = statistic === "max" || statistic === "maximum" ? resource.peak : resource.avg
  return base.map((value) => Number(((value / top) * target).toFixed(2)))
}

export const SAMPLE_COUNTS = {
  aws: { resources: 24, stopped: 3, unprotected: 5 },
  azure: { resources: 23, stopped: 2, unprotected: 4 },
} as const

export type SampleUnit = "percent" | "GiB" | "count"

/** The unit a metric reads in, from its name — the sample's guess, never the report's. */
export function sampleUnit(metric: string): SampleUnit {
  if (/memory|storage|space|bytes|disk/i.test(metric)) return "GiB"
  if (/network|packets|ops|iops|requests|connections|count|ingress|egress/i.test(metric)) return "count"
  return "percent"
}

/** One metric's daily series for one resource, in its own unit. */
export function sampleMetricSeries(resource: SampleResource, metric: string, statistic: string): number[] {
  const unit = sampleUnit(metric)
  const percent = sampleSeries(resource, statistic)
  if (unit === "percent") return percent
  const scale = unit === "GiB" ? 8 / 100 : 1200 / 100
  return percent.map((value) => Number((value * scale).toFixed(unit === "GiB" ? 2 : 0)))
}

/** Average, estimated P95 and peak of a series, for the summary tables. */
export function sampleSummary(values: readonly number[]): { avg: number; p95: number; peak: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const avg = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
  return { avg, p95, peak: sorted.at(-1) ?? 0 }
}

export function formatSample(value: number, unit: SampleUnit): string {
  if (unit === "percent") return `${value.toFixed(1)}%`
  if (unit === "GiB") return `${value.toFixed(2)} GiB`
  return Math.round(value).toLocaleString("en-US")
}
