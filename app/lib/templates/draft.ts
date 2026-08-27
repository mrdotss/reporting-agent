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

/**
 * The definition a brand-new template opens the **current, `sections`-based**
 * wizard on (task 7.3's own bug report — `wizard-shell.tsx`'s step set has been
 * unconditionally v3 since the report-profile restructure, but it kept calling
 * the v1 {@link EMPTY_DRAFT} above for a template with neither a draft nor a
 * version, producing `{schema_version: 1, sections: [...], ...}` the moment
 * `StepSections` wrote a `sections` array into it — a shape `collectDefinitionIssues`
 * correctly rejects, since `sections` is not a legal key at `schema_version` 1).
 *
 * {@link EMPTY_DRAFT} itself is untouched and stays v1-shaped: `block-composer.tsx`
 * (a v1/v2 block-based builder still exercised by its own test) constructs one too,
 * and a v1/v2 authoring surface needs a v1/v2 empty draft. This is the v3 sibling,
 * not a replacement.
 *
 * Same reasoning as {@link EMPTY_DRAFT} for why every key is present at its widest
 * empty value rather than the object being `{}`: `sections: []`, `provider: "azure"`
 * (the only provider this catalogue declares), and a `front_matter` whose three
 * subsections are each present as `{}` — every one of their own fields is optional
 * in draft mode (Requirement 12's front-matter validators all accept an empty
 * object), so `{}` is the honest "nothing authored yet" rather than a guess.
 *
 * `design` is identical to {@link EMPTY_DRAFT}'s: `validateDesign` carries no
 * `schema_version`-specific branch, so the same starting preset is correct at
 * every version.
 */
export function EMPTY_DRAFT_V3(name: string): TemplateDefinition {
  return {
    schema_version: 3,
    provider: "azure",
    identity: { name, description: "", report_title: name, language: "en" },
    sections: [],
    period: { kind: "last_full_month" },
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
    front_matter: {
      cover: {},
      document_control: {},
      toc: {},
    },
  } as unknown as TemplateDefinition
}
