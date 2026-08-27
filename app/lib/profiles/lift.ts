/**
 * The migration lifter (task 3.12, Requirements 20.1-20.6).
 *
 * `liftDefinition(stored)` → `{draft, brand, unmapped}`. **Pure, app-side only.**
 * A lift produces a wizard draft the consultant edits before saving; the runtime
 * never sees one, and mirroring this in Python would guard a code path that
 * does not exist on that side at all.
 *
 * ## What this actually proves, verified against the real catalogue and block
 * schemas rather than assumed from the task's own description
 *
 * Reading `catalog/sections.v1.json` directly (not inferring from its
 * requirements text) shows the shipped catalogue's `expands_to` never declares
 * `cover`, `executive_summary`, `kpi_row`, `capacity_vs_usage`,
 * `distribution_chart` or `appendix_methodology` at all — not even as one of
 * the "unmapped by design" types the original task text named
 * (`heading`, `rich_text`, `page_break`, `row`, `comparison_delta`). That list
 * was incomplete. The real unmapped set is larger, and this module states it
 * as data (`UNMAPPED_BLOCK_TYPES`) rather than silently under-reporting drops.
 *
 * `cover` is the one exception with a real v3 destination that is NOT a
 * section: its only field, `subtitle`, has a byte-identical home at
 * `front_matter.cover.subtitle` (confirmed against a real v3 fixture). It
 * lifts there directly rather than being reported unmapped.
 *
 * `executive_summary` and `kpi_row` genuinely have no v3 destination at all —
 * sections are catalogue-declared, and nothing in the shipped catalogue
 * narrates prose or emits a bare KPI row. `capacity_vs_usage`,
 * `distribution_chart` and `appendix_methodology` are declared block types
 * with config schemas but appear in zero catalogue entries — the catalogue
 * was shipped (task 3.1) without ever building a section that uses them. All
 * five report as unmapped, honestly, rather than guessing at a destination
 * the catalogue does not offer.
 *
 * ## The mapping heuristic for everything else
 *
 * `resource_table`, `top_n_table`, `timeseries_chart`, `historical_trend` and
 * `blank_rows_table` each map onto the catalogue entry whose `expands_to`
 * contains that block type AND whose `needs_resource_types` intersects the
 * block's own effective scope (`scope_override` if the block carries one, else
 * the template's own default `scope`) — the same "closest AST" resolution the
 * task text asks for, computed from real catalogue data rather than a
 * hardcoded block-type-to-section-key table that could silently drift from the
 * catalogue's own declarations.
 *
 * `gaps_and_coverage` and `verification_record` map to
 * `coverage_and_verification` unconditionally — it is the only entry using
 * either, and it needs no resource-type intersection because it carries none.
 *
 * A block whose effective scope matches MORE than one candidate entry (e.g. a
 * `resource_table` scoped to a type that appears in two entries'
 * `needs_resource_types`) is reported unmapped rather than guessed at — Req
 * 20.4 requires the wizard to ask the author, and an ambiguous automatic
 * choice would be exactly the silent drop that requirement forbids in a
 * different disguise.
 */

import { AZURE_SECTIONS, type SectionEntry } from "@/lib/profiles/sections"
import type {
  ScopeSpec,
  TemplateBlock,
  TemplateDefinition,
} from "@/lib/templates/definition"

/** Block types with no v3 catalogue destination at all — see the module
 * docstring for why each one lacks one. `cover` is deliberately absent from
 * this set: it has a real destination (`front_matter.cover.subtitle`), just
 * not a section. */
export const UNMAPPED_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "heading",
  "rich_text",
  "page_break",
  "row",
  "comparison_delta",
  "executive_summary",
  "kpi_row",
  "capacity_vs_usage",
  "distribution_chart",
  "appendix_methodology",
])

export type UnmappedBlock = {
  readonly id: string
  readonly type: string
  /** Why it could not be mapped, for the wizard to present alongside it. */
  readonly reason:
    "no_catalogue_destination" | "ambiguous_catalogue_destination"
}

export type LiftResult = {
  /** An unvalidated wizard draft — goes through the existing `saveDraft` path,
   * which is what that column is for (Requirement 20.5). Never written to
   * `report_template_versions` directly. */
  readonly draft: Record<string, unknown>
  /** The lifted `design` values, ready to become a Brand at the point the
   * caller creates one — this module does not write to the database, so it
   * returns the values rather than a Brand row. */
  readonly brand: {
    readonly themePreset: string
    readonly accentColor: string
    readonly density: string
    readonly tableStyle: string
    readonly numberFormat: unknown
    readonly coverPage: boolean
    readonly logoKey: string | null
    readonly pageSize: string
    /** Lifted from the v1/v2 definition's own `document_control
     * .confidentiality_notice_id`, if it carried one — Requirement 12.7 makes
     * this Brand-owned at v3, so a lifted definition's per-profile value
     * becomes the Brand's value rather than being silently dropped. `null`
     * when the source carried none, matching the Brand column's own
     * nullability. */
    readonly confidentialityNoticeId: string | null
  }
  /** Every block that could not be mapped onto a section, with its id, type
   * and why — the wizard presents this and requires the author to choose
   * sections rather than dropping the content (Requirement 20.4). */
  readonly unmapped: readonly UnmappedBlock[]
}

let sectionIdCounter = 0

/** v3's `design` at draft-mode's own bar — every field draft mode requires
 * present, mirroring `EMPTY_DRAFT`'s v1 defaults (`lib/templates/draft.ts`)
 * field for field where v3 and v1 share a design schema. A stored
 * definition's own `design` values override these per-key, so a fixture that
 * declares some subset still lifts with the rest filled honestly rather than
 * failing validation on the ones it never mentioned. */
const DEFAULT_DESIGN: Readonly<Record<string, unknown>> = {
  preset: "editorial",
  accent_color: "#1f6f78",
  density: "normal",
  table_style: "hairline",
  number_format: { decimal_places: 2, group_thousands: true },
  cover_page: true,
  logo: null,
  page_size: "A4",
}

/** v3's `front_matter` at draft-mode's own bar. Required at v3 for every
 * definition regardless of `schema_version` at v1/v2 (which may have carried
 * none, or a v2 subset) — filled with the minimum the validator's `draft`
 * mode accepts, per the real accept fixture at `accept-schema-version-3-
 * minimal.json`, not guessed at. */
const DEFAULT_FRONT_MATTER: Readonly<Record<string, unknown>> = {
  cover: {},
  document_control: {
    document_name: "",
    document_number_pattern: "RPT-{year}{month}-{run}",
    approvers: [
      { role: "author", name: "" },
      { role: "reviewer", name: "" },
      { role: "approver", name: "" },
      { role: "recipient", name: "" },
    ],
  },
  toc: { enabled: true, max_level: 3 },
}

/** A stable-enough id for a lifted section — collision-free within one lift
 * call, which is all a draft needs before the author edits it further. */
function nextSectionId(): string {
  sectionIdCounter += 1
  return `lifted_${sectionIdCounter}`
}

/** Every catalogue entry whose `expands_to` declares `blockType` at all. */
function candidatesForBlockType(blockType: string): readonly SectionEntry[] {
  return AZURE_SECTIONS.filter((entry) =>
    entry.expands_to.some((expansion) => expansion.block === blockType)
  )
}

/** The effective scope a block resolves against: its own `scope_override`,
 * or the template's default `scope` when it has none — the same fallback
 * `compile/scope.py#scope_for` applies at compile time. */
function effectiveScope(
  block: TemplateBlock,
  templateScope: ScopeSpec
): ScopeSpec {
  if (block.type === "row") return templateScope
  return block.scope_override ?? templateScope
}

/** Whether `entry`'s `needs_resource_types` intersects `scope`'s
 * `resource_types` — case-insensitively, the same fold `azure/inventory.py`
 * applies when matching a scan's Resource-Graph-cased types against the
 * catalogue's canonical casing (see `emit.ts`'s own note on the same rule).
 * An entry with an EMPTY `needs_resource_types` (e.g. `azure_subscription`)
 * matches any scope, since it declares no resource-type dimension to
 * disagree with. */
function scopeMatchesEntry(scope: ScopeSpec, entry: SectionEntry): boolean {
  if (entry.needs_resource_types.length === 0) return true
  if (scope.resource_types.length === 0) {
    // An unconstrained block scope matches every type-scoped entry — Req
    // 3.12's "an empty dimension imposes no constraint" rule, applied here
    // the same way it is applied at compile time.
    return true
  }
  const wanted = new Set(scope.resource_types.map((t) => t.toLowerCase()))
  return entry.needs_resource_types.some((t) => wanted.has(t.toLowerCase()))
}

/** Resolve one leaf block onto a target catalogue entry (with the scope that
 * entry's section should carry), or report why it could not be. */
function liftLeafBlock(
  block: TemplateBlock,
  templateScope: ScopeSpec
):
  | {
      readonly target: {
        readonly entry: SectionEntry
        readonly scope: ScopeSpec
      }
    }
  | { readonly unmapped: UnmappedBlock } {
  if (block.type === "row") {
    return {
      unmapped: {
        id: block.id,
        type: block.type,
        reason: "no_catalogue_destination",
      },
    }
  }

  if (UNMAPPED_BLOCK_TYPES.has(block.type)) {
    return {
      unmapped: {
        id: block.id,
        type: block.type,
        reason: "no_catalogue_destination",
      },
    }
  }

  const candidates = candidatesForBlockType(block.type)
  if (candidates.length === 0) {
    return {
      unmapped: {
        id: block.id,
        type: block.type,
        reason: "no_catalogue_destination",
      },
    }
  }

  // gaps_and_coverage / verification_record: the only two block types whose
  // catalogue entry carries no resource-type dimension to match against —
  // resolved unconditionally rather than through scopeMatchesEntry, which
  // would otherwise vacuously "match" every candidate for a reason that has
  // nothing to do with why they are actually the right destination.
  if (
    candidates.length === 1 &&
    candidates[0]!.needs_resource_types.length === 0
  ) {
    return {
      target: {
        entry: candidates[0]!,
        scope: effectiveScope(block, templateScope),
      },
    }
  }

  const scope = effectiveScope(block, templateScope)
  const matching = candidates.filter((entry) => scopeMatchesEntry(scope, entry))

  if (matching.length === 0) {
    return {
      unmapped: {
        id: block.id,
        type: block.type,
        reason: "no_catalogue_destination",
      },
    }
  }
  if (matching.length > 1) {
    return {
      unmapped: {
        id: block.id,
        type: block.type,
        reason: "ambiguous_catalogue_destination",
      },
    }
  }

  return { target: { entry: matching[0]!, scope } }
}

function liftedSection(
  entry: SectionEntry,
  scope: ScopeSpec,
  block: TemplateBlock
): Record<string, unknown> {
  return {
    id: nextSectionId(),
    type: entry.key,
    position: entry.position === "free" ? 0 : undefined,
    selection: {
      resource_types: scope.resource_types,
      resource_groups: scope.resource_groups,
      tag_filters: scope.tag_filters,
      top_n: scope.top_n,
      sort: scope.sort,
    },
    // The section's own metric selection carries the source block's own
    // config forward where the two shapes agree directly — `timeseries_chart`
    // already carries `metrics` in exactly the shape a section wants, and
    // `historical_trend` carries `metric`/`statistic`/`lookback` (task 7.3:
    // `historical_vm_utilization`'s section REQUIRES `lookback`, since
    // `agent/.../compile/sections.py`'s `_thread_metric_config` threads it
    // into `historical_trend`'s own config, and that block fails to compile
    // without it — a lift that dropped it would produce a draft that cannot
    // validate). Every other source block type maps onto a section whose
    // `expand_sections` binding reads the CATALOGUE's own `order_by`/
    // `trend_metric` rather than a per-block value (task 7.3's own design:
    // a document-design decision belonging to the section type, not an
    // interaction artifact of which metric chip was clicked first), so
    // there is nothing else here to carry across.
    metrics: liftedMetrics(block),
    ...liftedLookback(block),
    presentation: "chart_and_table",
  }
}

/** The section's `metrics` field, carried from the source block's own config where
 * the shapes agree (`timeseries_chart.metrics`), and empty otherwise — the sections
 * whose compiler binding reads the catalogue's own declaration
 * (`top_n_table`'s columns, `historical_trend`'s metric+statistic) have nothing to
 * read from a per-block metric list in the first place. */
function liftedMetrics(block: TemplateBlock): unknown[] {
  if (block.type === "timeseries_chart") {
    const metrics = (block.config as Record<string, unknown>).metrics
    return Array.isArray(metrics) ? metrics : []
  }
  return []
}

/** `{ lookback: n }` when the source block carries one (`historical_trend`), or `{}`
 * otherwise — spread into the lifted section rather than always set, so a section
 * type that never reads `lookback` does not gain a stray field. */
function liftedLookback(block: TemplateBlock): Record<string, unknown> {
  if (block.type === "historical_trend") {
    const lookback = (block.config as Record<string, unknown>).lookback
    if (typeof lookback === "number") {
      return { lookback }
    }
  }
  return {}
}

/** Every leaf block in `blocks`, flattening one level of `row` children —
 * `row` itself never maps (Requirement 6.2's "one level of nesting only"
 * means a `row`'s children are ordinary leaf blocks, individually liftable
 * even though the row that grouped them is not). */
function flattenBlocks(
  blocks: readonly TemplateBlock[]
): readonly TemplateBlock[] {
  const flat: TemplateBlock[] = []
  for (const block of blocks) {
    flat.push(block)
    if (block.type === "row") {
      for (const column of block.columns) {
        flat.push(...column)
      }
    }
  }
  return flat
}

/**
 * Lift a stored v1 or v2 definition into a v3 wizard draft.
 *
 * `stored` is read as `unknown` — a stored `definition` jsonb column, not a
 * value this module trusts to already be a valid `TemplateDefinition` — and a
 * shape too malformed to lift at all returns an empty draft with every block
 * unmapped, rather than throwing. A lift is a UI convenience, not a gate; the
 * wizard's own validator is what enforces correctness on the produced draft.
 */
export function liftDefinition(stored: unknown): LiftResult {
  sectionIdCounter = 0

  if (typeof stored !== "object" || stored === null) {
    return {
      draft: emptyDraft(),
      brand: defaultBrandValues(),
      unmapped: [],
    }
  }

  const definition = stored as Partial<TemplateDefinition> & {
    scope?: ScopeSpec
  }
  const templateScope: ScopeSpec = definition.scope ?? {
    resource_types: [],
    resource_groups: [],
    tag_filters: [],
    top_n: null,
    sort: null,
  }

  const blocks = Array.isArray(definition.blocks) ? definition.blocks : []
  const flat = flattenBlocks(blocks as readonly TemplateBlock[])

  // Blocks resolving to the same non-repeatable entry collapse into ONE
  // section rather than one each — `vm_utilization`'s own `expands_to`
  // legitimately produces a heading, a chart AND a table from one section,
  // so a v1 definition's separate `resource_table`/`top_n_table`/
  // `timeseries_chart` blocks (all scoped to the same resource type) map onto
  // exactly what one `vm_utilization` section already expresses. Creating one
  // section per block would violate the catalogue's own `repeatable: false`
  // the moment two blocks target the same entry — found by running this
  // lifter against the real `accept-every-block-type.json` fixture, not
  // assumed from the catalogue's declared field.
  const bySection = new Map<
    string,
    { entry: SectionEntry; scope: ScopeSpec; block: TemplateBlock }
  >()
  const unmapped: UnmappedBlock[] = []
  let liftedCoverSubtitle: string | undefined

  for (const block of flat) {
    if (block.type === "cover") {
      const subtitle = (block.config as { subtitle?: unknown } | undefined)
        ?.subtitle
      if (typeof subtitle === "string") liftedCoverSubtitle = subtitle
      continue
    }

    const result = liftLeafBlock(block, templateScope)
    if ("unmapped" in result) {
      unmapped.push(result.unmapped)
      continue
    }

    const { entry, scope } = result.target
    const dedupeKey = entry.repeatable
      ? `${entry.key}:${nextSectionId()}` // repeatable: never merges with another
      : entry.key
    if (!bySection.has(dedupeKey)) {
      bySection.set(dedupeKey, { entry, scope, block })
    }
    // A non-repeatable entry already recorded: this block's own scope is
    // discarded in favour of the first block's, matching Requirement 20.3's
    // "carrying its scope_override onto that section's selection rule" for
    // the block that established the section — a second block targeting the
    // same non-repeatable entry contributes no new section of its own to
    // carry a different scope onto, since there is only one section for both.
  }

  const sections: Record<string, unknown>[] = [...bySection.values()].map(
    ({ entry, scope, block }) => liftedSection(entry, scope, block)
  )

  const design = { ...DEFAULT_DESIGN, ...(definition.design ?? {}) } as Record<
    string,
    unknown
  >
  const frontMatter = (definition as { front_matter?: unknown }).front_matter
  const carriedFrontMatter: Record<string, unknown> = {
    ...DEFAULT_FRONT_MATTER,
    ...(typeof frontMatter === "object" && frontMatter !== null
      ? (frontMatter as Record<string, unknown>)
      : {}),
  }
  if (liftedCoverSubtitle !== undefined) {
    const existingCover =
      typeof carriedFrontMatter.cover === "object" &&
      carriedFrontMatter.cover !== null
        ? (carriedFrontMatter.cover as Record<string, unknown>)
        : {}
    carriedFrontMatter.cover = {
      ...existingCover,
      subtitle: liftedCoverSubtitle,
    }
  }

  // Requirement 12.6, 12.7 — `document_control` diverges at v3: `distribution`
  // becomes rows instead of free text, and `confidentiality_notice_id` moves
  // to the Brand instead of staying on the profile. A v1/v2 source's own
  // values for both are migrated rather than dropped, so lifting a definition
  // that had them does not silently discard what the author configured.
  let liftedConfidentialityNoticeId: string | null = null
  const existingDocumentControl =
    typeof carriedFrontMatter.document_control === "object" &&
    carriedFrontMatter.document_control !== null
      ? { ...(carriedFrontMatter.document_control as Record<string, unknown>) }
      : {}

  if (typeof existingDocumentControl.confidentiality_notice_id === "string") {
    liftedConfidentialityNoticeId =
      existingDocumentControl.confidentiality_notice_id
  }
  delete existingDocumentControl.confidentiality_notice_id

  if (typeof existingDocumentControl.distribution === "string") {
    const trimmed = existingDocumentControl.distribution.trim()
    // A v1/v2 `distribution` is one free-text field with no structured
    // recipient, so it has nothing to put in `recipient` — the whole string
    // becomes the row's `note` instead of being invented into a fake name,
    // and an empty string lifts to no rows at all (an empty distribution is
    // legitimately zero rows at v3, not one empty one).
    existingDocumentControl.distribution =
      trimmed.length > 0 ? [{ recipient: "Distribution", note: trimmed }] : []
  }

  carriedFrontMatter.document_control = existingDocumentControl

  const identity = (definition.identity ?? {
    name: "Untitled profile",
  }) as Record<string, unknown>

  const draft: Record<string, unknown> = {
    schema_version: 3,
    provider: "azure",
    identity: { language: "en", ...identity },
    sections,
    period: definition.period ?? { kind: "last_full_month" },
    design,
    front_matter: carriedFrontMatter,
  }

  return {
    draft,
    brand: {
      themePreset:
        typeof design.preset === "string" ? design.preset : "editorial",
      accentColor:
        typeof design.accent_color === "string"
          ? design.accent_color
          : "#000000",
      density: typeof design.density === "string" ? design.density : "normal",
      tableStyle:
        typeof design.table_style === "string"
          ? design.table_style
          : "hairline",
      numberFormat: design.number_format ?? {
        decimal_places: 1,
        group_thousands: true,
      },
      coverPage:
        typeof design.cover_page === "boolean" ? design.cover_page : true,
      logoKey: typeof design.logo === "string" ? design.logo : null,
      pageSize: typeof design.page_size === "string" ? design.page_size : "A4",
      confidentialityNoticeId: liftedConfidentialityNoticeId,
    },
    unmapped,
  }
}

function emptyDraft(): Record<string, unknown> {
  return {
    schema_version: 3,
    provider: "azure",
    identity: { name: "Untitled profile", language: "en" },
    sections: [],
    period: { kind: "last_full_month" },
    design: { ...DEFAULT_DESIGN },
    front_matter: { ...DEFAULT_FRONT_MATTER },
  }
}

function defaultBrandValues(): LiftResult["brand"] {
  return {
    themePreset: DEFAULT_DESIGN.preset as string,
    accentColor: DEFAULT_DESIGN.accent_color as string,
    density: DEFAULT_DESIGN.density as string,
    tableStyle: DEFAULT_DESIGN.table_style as string,
    numberFormat: DEFAULT_DESIGN.number_format,
    coverPage: DEFAULT_DESIGN.cover_page as boolean,
    logoKey: DEFAULT_DESIGN.logo as string | null,
    pageSize: DEFAULT_DESIGN.page_size as string,
    confidentialityNoticeId: null,
  }
}
