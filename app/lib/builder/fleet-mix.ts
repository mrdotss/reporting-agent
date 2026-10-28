import type { Provider } from "./catalogue"
import type { SampleResource } from "./sample"

/**
 * How the canvas splits a section's machines or databases for a fleet mix: the runtime's own
 * rule (`compile/snapshot_view.py::fleet_mix_segment`), so a drawing over real figures splits
 * the way the report will. The report counts every resource of the type it collected; the
 * canvas counts the resources it holds.
 */

export const FLEET_MIX_SEGMENTS = [
  "general",
  "compute",
  "memory",
  "burstable",
  "storage",
  "accelerated",
  "other",
  "stopped",
] as const

export type FleetMixSegment = (typeof FLEET_MIX_SEGMENTS)[number]

export const FLEET_MIX_TYPES: ReadonlySet<string> = new Set([
  "aws::ec2::instance",
  "aws::rds::dbinstance",
  "microsoft.compute/virtualmachines",
])

const STOPPED_STATES = new Set(["stopped", "stopping", "deallocated", "deallocating"])

// Longer prefixes first, so `inf2` is accelerated and not `i` storage.
const AWS_FAMILIES: readonly (readonly [string, FleetMixSegment])[] = [
  ["mac", "general"], ["inf", "accelerated"], ["trn", "accelerated"], ["dl", "accelerated"],
  ["vt", "accelerated"], ["im", "storage"], ["is", "storage"], ["hpc", "compute"],
  ["t", "burstable"], ["m", "general"], ["a", "general"], ["c", "compute"], ["r", "memory"],
  ["x", "memory"], ["z", "memory"], ["u", "memory"], ["i", "storage"], ["d", "storage"],
  ["h", "storage"], ["p", "accelerated"], ["g", "accelerated"], ["f", "accelerated"],
]

const AZURE_FAMILIES: Readonly<Record<string, FleetMixSegment>> = {
  b: "burstable", a: "general", d: "general", f: "compute", h: "compute",
  e: "memory", m: "memory", g: "memory", l: "storage", n: "accelerated",
}

export function fleetMixSegment(resourceType: string, skuName: string, powerState: string): FleetMixSegment {
  if (STOPPED_STATES.has(powerState.toLowerCase())) return "stopped"
  let name = skuName.trim().toLowerCase()
  if (resourceType.toLowerCase().startsWith("microsoft.")) {
    for (const prefix of ["standard_", "basic_"]) if (name.startsWith(prefix)) name = name.slice(prefix.length)
    return (name && AZURE_FAMILIES[name[0]!]) || "other"
  }
  if (name.startsWith("db.")) name = name.slice(3)
  const letters = /^[a-z]+/.exec(name.split(".")[0] ?? "")?.[0]
  if (!letters) return "other"
  return AWS_FAMILIES.find(([prefix]) => letters.startsWith(prefix))?.[1] ?? "other"
}

/** The type a resource on the canvas has: its own on real figures, the section's on the sample's. */
function typeOf(resource: SampleResource, provider: Provider): string {
  return resource.type ?? (provider === "aws" ? "AWS::EC2::Instance" : "Microsoft.Compute/virtualMachines")
}

export type FleetMixRow = { readonly type: string; readonly counts: Readonly<Partial<Record<FleetMixSegment, number>>> }

/** One row per fleet-mix type among `resources`, each segment's count, segments in drawing order. */
export function fleetMix(resources: readonly SampleResource[], provider: Provider): readonly FleetMixRow[] {
  const rows = new Map<string, Partial<Record<FleetMixSegment, number>>>()
  for (const resource of resources) {
    const type = typeOf(resource, provider)
    if (!FLEET_MIX_TYPES.has(type.toLowerCase())) continue
    const sku = resource.cells.instance_type || resource.cells.instance_class || resource.cells.vm_size || ""
    const segment = fleetMixSegment(type, sku, resource.cells.power_state ?? "")
    const counts = rows.get(type) ?? {}
    counts[segment] = (counts[segment] ?? 0) + 1
    rows.set(type, counts)
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(([type, counts]) => ({ type, counts }))
}
