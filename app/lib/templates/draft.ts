import type { TemplateDefinition } from "@/lib/templates/definition"

/**
 * The definition a brand-new template opens the wizard on.
 *
 * **Pure, and deliberately not `server-only`.** The wizard shell is a client
 * component and constructs one when a template has neither a draft nor a version.
 *
 * ## Why it is a complete object rather than `{}`
 *
 * Requirement 2.1 requires all seven top-level keys, and the mirrored validator
 * reports a missing key as an issue on the step that owns it. A wizard that
 * opened on `{}` would therefore show seven simultaneous errors on step 1 before
 * the consultant had touched anything — every one of them true, and none of them
 * useful.
 *
 * So every key is present and every dimension is at its **widest empty** value:
 * no resource types (which Requirement 3.12 reads as unconstrained), no metrics
 * and no blocks. That is an honest starting point rather than a guess about what
 * the consultant wants, and it is a shape the validator accepts in `draft` mode
 * while still refusing at completion — a template with no blocks is not a report
 * (Requirement 11.10).
 *
 * ## The one opinionated default
 *
 * `period` starts at `last_full_month`. Not `custom`: a starting draft carrying
 * two fixed dates would be a template that silently stops being correct next
 * month, which is the exact failure the relative specification exists to prevent
 * (Requirement 10.3 forbids `custom` in the shipped starters for the same
 * reason). `last_full_month` is the unit this product is actually about.
 *
 * The design defaults match `editorial` because a preset has to be one of the
 * four and step 6 shows all four as rendered thumbnails — the default only
 * decides which card is selected when that step first opens.
 */
export function EMPTY_DRAFT(name: string): TemplateDefinition {
  return {
    schema_version: 1,
    identity: { name, description: "", report_title: name },
    scope: {
      resource_types: [],
      tag_filters: [],
      resource_groups: [],
      top_n: null,
      sort: null,
    },
    period: { kind: "last_full_month" },
    metrics: {},
    blocks: [],
    design: {
      preset: "editorial",
      accent_color: "#1f6f78",
      density: "normal",
      table_style: "hairline",
      number_format: { decimal_places: 2, group_thousands: true },
      cover_page: true,
      logo: null,
      page_size: "A4",
    },
  }
}
