import { messageText, type MessageId } from "@/lib/messages/catalog"
import type { Language } from "@/lib/messages/language"

/**
 * A metric as a chart names it, "Peak CPU" for `CPUUtilization (max)`, so the canvas titles a
 * chart the way the runtime does (`compile/blocks/base.py::friendly_label`). The two maps are
 * the same list; a metric missing from either keeps its catalogue name there.
 */

export const FRIENDLY_METRICS: Readonly<Record<string, string>> = {
  CPUUtilization: "cpu",
  "Percentage CPU": "cpu",
  cpu_percent: "cpu",
  avg_cpu_percent: "cpu",
  memory_percent: "memory",
  memory_usage_percent: "memory",
  FreeableMemory: "free_memory",
  "Available Memory Bytes": "free_memory",
  NetworkIn: "network_in",
  "Network In Total": "network_in",
  NetworkOut: "network_out",
  "Network Out Total": "network_out",
  ReadIOPS: "read_iops",
  WriteIOPS: "write_iops",
  FreeStorageSpace: "free_storage",
  storage_percent: "storage",
  dtu_consumption_percent: "dtu",
  EBSReadBytes: "disk_read",
  EBSWriteBytes: "disk_write",
  VolumeReadBytes: "disk_read",
  VolumeWriteBytes: "disk_write",
  "Disk Read Bytes": "disk_read",
  "Disk Write Bytes": "disk_write",
  Availability: "availability",
  availability: "availability",
}

const FRIENDLY_STATISTICS = new Set(["max", "avg", "min", "sum"])

function capitalised(words: string): string {
  return words.slice(0, 1).toUpperCase() + words.slice(1)
}

/** "Peak CPU", or `name (statistic)` for a metric or statistic with no words. */
export function friendlyLabel(name: string, statistic: string, language: Language): string {
  const metric = FRIENDLY_METRICS[name]
  const fallback = `${name} (${statistic})`
  if (metric === undefined || !FRIENDLY_STATISTICS.has(statistic)) return fallback
  const words = messageText("doc.metric.friendly", language, {
    metric: messageText(`doc.metric.${metric}` as MessageId, language) ?? name,
    statistic: messageText(`doc.statistic.${statistic}` as MessageId, language) ?? statistic,
  })
  return words ? capitalised(words) : fallback
}

/** "CPU": the metric alone, for a chart that draws several of its statistics. */
export function friendlyMetric(name: string, language: Language): string {
  const metric = FRIENDLY_METRICS[name]
  const words = metric === undefined ? undefined : messageText(`doc.metric.${metric}` as MessageId, language)
  return words ? capitalised(words) : name
}
