import {
  BroomIcon,
  ChartBarIcon,
  ChartLineUpIcon,
  ClockCounterClockwiseIcon,
  CoinsIcon,
  CubeIcon,
  DatabaseIcon,
  GlobeIcon,
  HardDrivesIcon,
  LightbulbIcon,
  ListChecksIcon,
  LockIcon,
  SealCheckIcon,
  ShieldCheckIcon,
  SquaresFourIcon,
  TableIcon,
  TreeStructureIcon,
  WarningIcon,
  type Icon,
} from "@phosphor-icons/react"

import { sectionEntry, sectionTitle, type Provider } from "@/lib/builder/catalogue"
import { cn } from "@/lib/utils"

/**
 * A section as a small mark: one glyph per kind of section, so a preset's outline reads
 * at a glance in the list and in the Describe it outline.
 *
 * The glyph is chosen by the catalogue key where the key names something specific
 * (backups, housekeeping, coverage), and by the catalogue group otherwise. The section's
 * own title, from the catalogue, travels as the accessible name and the tooltip.
 */

const BY_KEY: Readonly<Record<string, Icon>> = {
  at_a_glance: SquaresFourIcon,
  aws_account: CubeIcon,
  azure_subscription: CubeIcon,
  regions: GlobeIcon,
  resource_groups: TreeStructureIcon,
  vpcs: TreeStructureIcon,
  virtual_network: TreeStructureIcon,
  security_groups: LockIcon,
  network_security_groups: LockIcon,
  ebs_volumes: HardDrivesIcon,
  rds_instances: DatabaseIcon,
  postgresql_flexible_inventory: DatabaseIcon,
  database_utilization: DatabaseIcon,
  rds_utilization: DatabaseIcon,
  reservations: CoinsIcon,
  historical_ec2_utilization: ClockCounterClockwiseIcon,
  historical_vm_utilization: ClockCounterClockwiseIcon,
  backups: ShieldCheckIcon,
  backup_report: ShieldCheckIcon,
  housekeeping: BroomIcon,
  incident_report: WarningIcon,
  rightsizing: LightbulbIcon,
  recommendations: LightbulbIcon,
  action_register: ListChecksIcon,
  coverage_and_verification: SealCheckIcon,
}

const BY_GROUP: Readonly<Record<string, Icon>> = {
  summary: SquaresFourIcon,
  inventory: TableIcon,
  utilisation: ChartBarIcon,
  closing: ChartLineUpIcon,
}

/** The glyph for one section type of one provider. */
export function sectionIcon(provider: Provider, type: string): Icon {
  return BY_KEY[type] ?? BY_GROUP[sectionEntry(provider, type)?.group ?? ""] ?? TableIcon
}

/** The glyph as an element. A plain function, so no component is created during render. */
function sectionGlyph(provider: Provider, type: string) {
  const Glyph = sectionIcon(provider, type)
  return <Glyph aria-hidden="true" className="size-3.5" />
}

/** One section as a square mark with its title as the name. */
export function SectionMark({
  provider,
  type,
  className,
}: Readonly<{ provider: Provider; type: string; className?: string }>) {
  const title = sectionTitle(sectionEntry(provider, type), "en")
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn(
        "inline-grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground",
        className
      )}
    >
      {sectionGlyph(provider, type)}
    </span>
  )
}

/** A preset's sections as a row of marks, the first few and a count of the rest. */
export function SectionMarks({
  provider,
  types,
  max = 5,
}: Readonly<{ provider: Provider; types: readonly string[]; max?: number }>) {
  const shown = types.slice(0, max)
  const rest = types.length - shown.length
  return (
    <span className="flex items-center gap-1">
      {shown.map((type, index) => (
        <SectionMark key={`${type}-${index}`} provider={provider} type={type} />
      ))}
      {rest > 0 ? (
        <span className="ms-1 font-mono text-xs text-muted-foreground tabular-nums">+{rest}</span>
      ) : null}
    </span>
  )
}
