import { expandPreset, DEFAULT_PRESET_NAME } from "@/lib/profiles/presets"
import {
  MAX_METRIC_ITEMS_PER_ENTRY,
  type MetricCatalogSnapshot,
} from "@/lib/templates/definition"

import { sectionEntry, type CatalogueSection, type Provider } from "./catalogue"
import { orderedSections, type DefinitionV4, type ScopeSelection, type SectionV4 } from "./model"

/**
 * Making new things in a v4 draft: the empty preset, a section added from the catalogue,
 * and the ids both carry.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

function randomToken(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("")
}

/**
 * A section id: short, because every block id is built from it (24 characters at most at
 * v4), and never with a double underscore, which separates the parts of a block id.
 */
export function newSectionId(): string {
  return `sec_${Date.now().toString(36)}${randomToken(4)}`
}

/** An added block's id: `u_` and eight lowercase letters or digits. */
export function newUserBlockId(): string {
  return `u_${randomToken(8)}`
}

export function emptyDraftV4(name: string, provider: Provider): DefinitionV4 {
  return {
    schema_version: 4,
    provider,
    identity: { name, description: "", report_title: name, language: "en" },
    sections: [],
    period: { kind: "last_full_month" },
    design: {
      preset: "editorial",
      accent_color: "#1f6f78",
      density: "normal",
      table_style: "hairline",
      number_format: {
        decimal_places: 2,
        group_thousands: true,
        bytes_as_gib: true,
        trim_trailing_zeros: true,
      },
      cover_page: true,
      logo: null,
      page_size: "A4",
    },
    front_matter: { cover: {}, document_control: {}, toc: {} },
  }
}

/** The selection a new section starts with: the resource types its catalogue entry needs. */
export function defaultSelection(entry: CatalogueSection): ScopeSelection {
  return {
    resource_types: [...entry.needsResourceTypes],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  }
}

/**
 * A section of `type`, seeded the way the old wizard's `addSection` seeded one: the
 * resource types its entry needs, the standard metric preset where it bears metrics, and a
 * three-month trend where it draws one.
 */
export function newSection(
  provider: Provider,
  type: string,
  catalog: MetricCatalogSnapshot
): SectionV4 {
  const entry = sectionEntry(provider, type)
  if (entry === undefined) throw new Error(`${type} is not in the ${provider} catalogue`)
  const bearing = {
    key: entry.key,
    needs_resource_types: entry.needsResourceTypes,
    presets: entry.presets,
  }
  // The standard set where it expands to something. App Service and Storage metrics declare
  // only a minimum and a maximum, so a standard set of averages expands to nothing for them,
  // and the section would publish collecting nothing; everything the catalogue declares for
  // them is the honest start there.
  const standard = entry.metricBearing ? expandPreset(bearing, DEFAULT_PRESET_NAME, catalog) : []
  const everything =
    entry.metricBearing && standard.length === 0 ? expandPreset(bearing, "everything", catalog) : []
  const metrics = standard.length > 0 ? standard : everything.slice(0, MAX_METRIC_ITEMS_PER_ENTRY)
  return {
    id: newSectionId(),
    type,
    position: 0,
    selection: defaultSelection(entry),
    metrics: [...metrics],
    ...(entry.drawsFromPriorRuns ? { lookback: 3 } : {}),
  }
}

/** The first position a free section takes, past the fixed sections' catalogue ranks. */
export const FIRST_FREE_POSITION = 10

/**
 * Positions rewritten from an order: each section's index past {@link FIRST_FREE_POSITION}.
 *
 * Why past ten: the runtime ranks a fixed closing section by its catalogue order (0, 1, 2)
 * and a free one by its position, in one sort. Starting free positions at ten keeps every
 * free closing section after the fixed ones — Housekeeping after Backups, never between
 * Backups and Incidents — however the author orders the free ones among themselves.
 */
export function withPositions(sections: readonly SectionV4[]): SectionV4[] {
  return sections.map((section, index) => ({ ...section, position: FIRST_FREE_POSITION + index }))
}

/**
 * Sections settled after an edit: positioned from the author's intended order, then stored
 * in the order they print and renumbered.
 *
 * Stored in print order because the validator holds fixed sections to their catalogue order
 * in the array itself, and because a stored order that differed from the printed one is
 * exactly the confusion v4 removes. A fixed section added after a free one in its group
 * lands where the catalogue puts it, not where it was appended.
 */
export function settled(
  provider: DefinitionV4["provider"],
  intended: readonly SectionV4[]
): SectionV4[] {
  return withPositions(orderedSections({ provider, sections: withPositions(intended) }))
}
