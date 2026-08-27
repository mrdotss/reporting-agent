/**
 * The three starter profile definitions, versioned in the repository and
 * reviewed as code (Requirements 10.1, 10.3, 10.5, 10.8, 20.9).
 *
 * **Pure, and deliberately not `server-only`.** These are plain values: no
 * clock, no connection, no secret. `lib/templates/seed.ts` writes them at
 * account creation, `app/test/starters.static.test.ts` validates them at build
 * time, and the wizard may render one as a preview without pulling a server
 * module into a client bundle.
 *
 * ## v3, not v1 (task 3.12/3.13)
 *
 * These were three `blocks`-array definitions before this task. They are now
 * `sections`-array v3 profiles, each `type` a real key from
 * `catalog/sections.v1.json` — not invented here, cross-checked against the
 * shipped catalogue by `starters.static.test.ts` so a future catalogue rename
 * fails the build rather than shipping a starter that references a section
 * type that no longer exists.
 *
 * **Existing seeded accounts are unaffected.** `lib/templates/seed.ts` reads
 * this array live, at account-creation time — an account seeded before this
 * change already has its v1 definitions permanently stored in
 * `report_template_versions`, which is immutable, and nothing in this file's
 * change touches a stored row. The v1 validator path this repository already
 * carries is what keeps those existing definitions openable in the wizard, and
 * this file changing what a *new* account seeds does not need to, and does
 * not, do anything to preserve that.
 *
 * ## Why they are code rather than seed SQL
 *
 * Requirement 10.8 is the reason: a starter definition that fails the
 * `Template_Validator` must fail the **build**, naming that starter and each
 * failing field path, rather than being discovered by the first user whose
 * account was created with it. A definition living in a migration or a JSON
 * fixture is data nobody validates until it is written; a definition living
 * here is validated by `starters.static.test.ts` on every run of `pnpm test`,
 * through the same `collectDefinitionIssues` the wizard and every route handler
 * use — in **`mode: "run"`**, not `"draft"`, because a starter that saves but
 * cannot be run is not a working example.
 *
 * ## What every starter carries, and why
 *
 * Requirement 10.3 — the period is one of the five **relative**
 * specifications and never `custom`, so a starter that shipped in July still
 * resolves to a meaningful window in November with no edit.
 *
 * The v3 analog of Requirement 10.5's "provenance chain end to end" is: at
 * least one section from {@link STARTER_DATA_SECTION_TYPES} (a section that
 * emits real figures or facts from the snapshot) and exactly one
 * `coverage_and_verification` — the section that states the snapshot those
 * figures came from. `executive_summary`/`kpi_row`-style narrative has no v3
 * section equivalent at all (see `lib/profiles/lift.ts`'s own note on the same
 * finding, from task 3.12) — a v3 starter demonstrates the data-to-record
 * chain, not a narrative layer the catalogue does not yet offer.
 *
 * ## They are three genuinely different profiles
 *
 * | starter | period | shape |
 * |---|---|---|
 * | **Monthly utilization** | `last_full_month` | broad and periodic — subscription overview, resource groups, the full VM inventory, VM utilization, coverage |
 * | **Capacity planning** | `last_30d` | narrower — VM utilization only, scoped tighter, over a rolling window, coverage |
 * | **Executive summary** | `last_full_month` | the smallest legitimate profile — one inventory section and coverage, for a reader who wants the fewest pages |
 *
 * ## `seededStarterKey` is a persisted identifier
 *
 * The three keys are the `report_templates.seeded_starter_key` values, and
 * they are the idempotency key of `UNIQUE (user_id, seeded_starter_key)`. They
 * are **stable forever**: renaming one would make an existing user's seeded
 * row invisible to the seeder and re-insert a duplicate under the new
 * spelling. Unchanged by this task.
 */

import type { TemplateDefinition } from "@/lib/templates/definition"

// --- The composition rule, v3 (Requirement 10.5, applied to sections) -------

/**
 * Section types that emit real figures or facts from the snapshot.
 * Requirement 10.5's "provenance chain" requires at least one per starter.
 *
 * Declared as a value rather than restated in the guard, so the rule and the
 * assertion share one source — the same convention
 * `STARTER_DATA_BLOCK_TYPES` used at v1.
 */
export const STARTER_DATA_SECTION_TYPES = [
  "azure_subscription",
  "resource_groups",
  "virtual_network",
  "virtual_machines",
  "public_ip_addresses",
  "network_security_groups",
  "reservations",
  "vm_utilization",
  "historical_vm_utilization",
  "database_utilization",
  "app_service_and_storage",
  "backup_report",
  "incident_report",
  "recommendations",
] as const

/** Exactly one per starter — the section that names the snapshot behind the
 * figures. The v3 successor to `STARTER_RECORD_BLOCK_TYPE`. */
export const STARTER_RECORD_SECTION_TYPE = "coverage_and_verification"

// --- The one resource type these starters scope to --------------------------

/**
 * The MVP's only collected resource type. Fully qualified, because Requirement
 * 3.1 bounds `resource_types` to fully qualified names and Requirement 1.3
 * rejects anything shaped like a *named resource* in a scope field.
 */
const VIRTUAL_MACHINES = "Microsoft.Compute/virtualMachines"

// --- Shared shapes ------------------------------------------------------------

/** Every field `designSchema` declares, present. Restrained defaults;
 * presets differ per starter below. */
function design(
  preset: TemplateDefinition["design"]["preset"],
  overrides: Partial<TemplateDefinition["design"]> = {}
): TemplateDefinition["design"] {
  return {
    preset,
    accent_color: "#1f6f78",
    density: "normal",
    table_style: "hairline",
    number_format: { decimal_places: 2, group_thousands: true },
    cover_page: true,
    logo: null,
    page_size: "A4",
    ...overrides,
  }
}

/** v3's `front_matter` at its own required minimum — every field the
 * validator requires present, filled honestly rather than guessed at
 * per-starter. */
function frontMatter(subtitle: string): Record<string, unknown> {
  return {
    cover: { subtitle },
    document_control: {
      document_name: subtitle,
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
}

/** Every VM the connected subscription exposes, unnarrowed — all five
 * dimensions present as the empty value `scopeSpecSchema` requires. */
function allVirtualMachines(): Record<string, unknown> {
  return {
    resource_types: [VIRTUAL_MACHINES],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  }
}

/** No resource-type constraint at all — the subscription-wide sections
 * (`azure_subscription`, `resource_groups`) declare no
 * `needs_resource_types`, so an unconstrained selection is what "match
 * everything relevant" means for them. */
function unconstrained(): Record<string, unknown> {
  return {
    resource_types: [],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  }
}

let sectionCounter = 0

/** One authored section entry. `position` is authored freshly per starter —
 * every entry below is `position: "free"` in the catalogue, so the number is
 * this starter's own ordering choice, not a catalogue-declared one. */
function section(
  type: string,
  position: number,
  selection: Record<string, unknown>
): Record<string, unknown> {
  sectionCounter += 1
  return {
    id: `sec_${sectionCounter}`,
    type,
    position,
    selection,
    metrics: [],
    presentation: "chart_and_table",
  }
}

// --- Starter 1 — Monthly utilization ----------------------------------------

/**
 * The broad periodic report: the subscription's own inventory, its resource
 * groups, every VM and its utilization, closed by coverage.
 */
const MONTHLY_UTILIZATION: TemplateDefinition = {
  schema_version: 3,
  provider: "azure",
  identity: {
    name: "Monthly utilization",
    description:
      "Subscription inventory, resource groups and virtual machine " +
      "utilization for the last full calendar month, closed with the " +
      "coverage and verification record.",
    report_title: "Infrastructure utilization — monthly review",
    language: "en",
  },
  sections: [
    section("azure_subscription", 0, unconstrained()),
    section("resource_groups", 1, unconstrained()),
    section("virtual_machines", 2, allVirtualMachines()),
    section("vm_utilization", 3, allVirtualMachines()),
    section("coverage_and_verification", 4, unconstrained()),
  ],
  // Requirement 10.3 — relative, so this starter runs unedited in any month.
  period: { kind: "last_full_month" },
  design: design("editorial"),
  front_matter: frontMatter("Monthly utilization review"),
} as unknown as TemplateDefinition

// --- Starter 2 — Capacity planning ------------------------------------------

/**
 * Narrower and rolling: only utilization, over 30 days rather than a
 * calendar month, for a right-sizing conversation rather than a periodic one.
 */
const CAPACITY_PLANNING: TemplateDefinition = {
  schema_version: 3,
  provider: "azure",
  identity: {
    name: "Capacity planning",
    description:
      "Virtual machine utilization over the last 30 local days, for a " +
      "right-sizing conversation, closed with the coverage and " +
      "verification record.",
    report_title: "Capacity and right-sizing review",
    language: "en",
  },
  sections: [
    section("vm_utilization", 0, allVirtualMachines()),
    section("coverage_and_verification", 1, unconstrained()),
  ],
  period: { kind: "last_30d" },
  design: design("technical", { table_style: "banded", density: "compact" }),
  front_matter: frontMatter("Capacity and right-sizing"),
} as unknown as TemplateDefinition

// --- Starter 3 — Executive summary ------------------------------------------

/**
 * The smallest legitimate profile: one inventory section and coverage, for a
 * reader who wants the fewest pages. No utilization section on purpose — this
 * starter demonstrates that a minimal profile is a legitimate shape, and
 * adding a utilization section would make it the monthly report with one
 * fewer inventory page.
 */
const EXECUTIVE_SUMMARY: TemplateDefinition = {
  schema_version: 3,
  provider: "azure",
  identity: {
    name: "Executive summary",
    description:
      "A subscription-level inventory summary for the last full calendar " +
      "month, closed with the coverage and verification record.",
    report_title: "Infrastructure utilization — executive summary",
    language: "en",
  },
  sections: [
    section("azure_subscription", 0, unconstrained()),
    section("coverage_and_verification", 1, unconstrained()),
  ],
  period: { kind: "last_full_month" },
  design: design("minimal", { table_style: "hairline", density: "relaxed" }),
  front_matter: frontMatter("Executive summary"),
} as unknown as TemplateDefinition

// --- The declared set -------------------------------------------------------

/**
 * One starter: its persisted `seeded_starter_key` and its definition.
 *
 * `name` and `description` are read off the definition's own `identity`
 * rather than being declared a second time, so the `report_templates` row
 * and the definition it pins cannot disagree about what the template is
 * called.
 */
export type StarterTemplate = {
  /**
   * The `report_templates.seeded_starter_key` value — the idempotency key of
   * `UNIQUE (user_id, seeded_starter_key)`. **Stable forever**: renaming one
   * hides an existing user's seeded row from the seeder.
   */
  readonly seededStarterKey: string
  readonly definition: TemplateDefinition
}

/**
 * Exactly three (Requirement 10.1), in the order they are seeded and listed.
 *
 * One array read by the seeder **and** by `starters.static.test.ts`, so a
 * fourth starter added here is seeded and validated in the same change — a
 * second list is how a starter comes to be written and never checked.
 */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  { seededStarterKey: "monthly_utilization", definition: MONTHLY_UTILIZATION },
  { seededStarterKey: "capacity_planning", definition: CAPACITY_PLANNING },
  { seededStarterKey: "executive_summary", definition: EXECUTIVE_SUMMARY },
] as const

/** The three keys, for a caller comparing against what a user actually holds. */
export const STARTER_KEYS: readonly string[] = STARTER_TEMPLATES.map(
  (starter) => starter.seededStarterKey
)

/** Requirement 10.1 — three, asserted as a value the guard can read. */
export const STARTER_TEMPLATE_COUNT = 3

/** Every section entry in a v3 starter's `sections` array — `TemplateDefinition`
 * types this as the v1/v2 `blocks` shape, so this reads it defensively as
 * `unknown` narrowed to the shape a v3 profile actually carries, the same
 * pattern `lib/profiles/wizard.ts` uses throughout. */
export function starterSections(
  definition: TemplateDefinition
): readonly { readonly id: string; readonly type: string }[] {
  const raw = (definition as unknown as { sections?: unknown }).sections
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (entry): entry is { id: string; type: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).id === "string" &&
        typeof (entry as Record<string, unknown>).type === "string"
    )
    .map((entry) => ({ id: entry.id, type: entry.type }))
}

// --- A v1 fixture, for tests that need one independent of what starters are -

/**
 * A self-contained, rich `schema_version` 1 definition — **not** one of the
 * three seeded starters, which are v3 as of task 3.13.
 *
 * Several integration tests (`test/db/run-form-enqueue-round-trip`,
 * `report-run-end-to-end`, `enqueue-pinning`, `run-wiring`) exercise the
 * v1/v2 enqueue-and-run path and need a real, complex v1 definition to do it
 * with — a need that has nothing to do with what the seeded starters
 * currently are, and coupling it to `STARTER_TEMPLATES[0]` is exactly what
 * broke when this task changed that entry to v3. This is the extracted,
 * dedicated fixture those tests import instead.
 */
export const V1_TEST_FIXTURE_DEFINITION: TemplateDefinition = {
  schema_version: 1,
  identity: {
    name: "V1 fixture profile",
    description: "A rich v1 definition for integration tests exercising the enqueue-and-run path.",
    report_title: "V1 fixture profile",
  },
  scope: {
    resource_types: [VIRTUAL_MACHINES],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  },
  period: { kind: "last_full_month" },
  metrics: {
    [VIRTUAL_MACHINES]: [
      { metric: "Percentage CPU", statistic: "avg" },
      { metric: "Percentage CPU", statistic: "max" },
      { metric: "Available Memory Bytes", statistic: "avg" },
    ],
  },
  blocks: [
    {
      id: "fixture-cover",
      type: "cover",
      config: { subtitle: "V1 fixture profile" },
    },
    {
      id: "fixture-heading",
      type: "heading",
      config: { level: 1, text: "Fixture" },
    },
    {
      id: "fixture-kpis",
      type: "kpi_row",
      config: {
        caption: "Fleet averages",
        show_fidelity: true,
        metrics: [
          { metric: "Percentage CPU", statistic: "avg" },
          { metric: "Available Memory Bytes", statistic: "avg" },
        ],
      },
    },
    {
      id: "fixture-table",
      type: "resource_table",
      config: {
        caption: "Per-machine utilization",
        show_fidelity: true,
        columns: [
          { metric: "Percentage CPU", statistic: "avg" },
          { metric: "Percentage CPU", statistic: "max" },
        ],
      },
    },
    {
      id: "fixture-gaps",
      type: "gaps_and_coverage",
      config: { caption: "What could not be collected" },
    },
    {
      id: "fixture-record",
      type: "verification_record",
      config: { caption: "Collection record" },
    },
  ],
  design: design("editorial"),
}
