import {
  collectDefinitionIssues,
  type FieldIssue,
} from "@/lib/templates/definition"

/**
 * The wizard's step model for v3 Report Profiles (Requirements 3.2, 3.6, 7.2, 7.3).
 *
 * **Pure, and deliberately not `server-only`.** The shell is a client component
 * and needs every function here; nothing below reads a clock, a database or an
 * environment.
 *
 * ## Five steps, adapted from the six-step v1/v2 wizard
 *
 * v3 definitions carry `provider` and `sections` instead of `scope`, `metrics`
 * and `blocks`. The wizard collapses around that:
 *   identity (1) → sections (2) → period (3) → document (4) → preview (5)
 *
 * Step 4 ("Document") collects `front_matter` and `design` — the two top-level
 * keys that control the document's appearance and metadata rather than its data
 * content.
 *
 * ## Why the mapping lives here rather than in the shell
 *
 * Three criteria require "which step owns this field path": blocking on the
 * current step and naming each failing field path on it, opening the
 * lowest-numbered failing step when a draft is reopened, and naming each failing
 * step on a refused completion. All three need one answer to "which step owns
 * this field path", and a shell that computed it inline would compute it three
 * times.
 *
 * The mapping is by **first path segment**, and that works because the
 * definition's seven v3 top-level fields map cleanly onto five steps.
 * {@link STEP_FOR_FIELD} is exhaustive over `REQUIRED_TOP_LEVEL_KEYS[3]` and
 * `wizard.test.ts` asserts it stays that way.
 */

export const WIZARD_STEP_COUNT = 5

export type WizardStepId =
  "identity" | "sections" | "period" | "document" | "preview"

export type WizardStep = {
  readonly id: WizardStepId
  /** 1-based, and displayed. */
  readonly number: number
  readonly title: string
  /** One line describing what the consultant decides here. */
  readonly summary: string
}

/**
 * The five steps, in a fixed order.
 *
 * The order is a constant rather than a configuration. Sections reference metrics
 * and resource types, so they must be selected before the period (which references
 * nothing). The document step collects presentation that does not affect data.
 */
export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: "identity",
    number: 1,
    title: "Identity",
    summary: "What this report profile is called, and the provider it targets.",
  },
  {
    id: "sections",
    number: 2,
    title: "Sections",
    summary:
      "Which sections the report contains, each with its own scope and metrics.",
  },
  {
    id: "period",
    number: 3,
    title: "Period",
    summary: "A rule resolved fresh at each run, not a fixed pair of dates.",
  },
  {
    id: "document",
    number: 4,
    title: "Document",
    summary: "Front matter, approvers, distribution, and document appearance.",
  },
  {
    id: "preview",
    number: 5,
    title: "Preview",
    summary: "What the document will look like, and saving the version.",
  },
]

/**
 * Which step owns each top-level field of a v3 definition.
 *
 * `schema_version` belongs to step 1 not because a consultant sets it — nothing in
 * the wizard does — but because a problem with it has to surface *somewhere*, and
 * the first step is where a consultant is already looking at what the profile
 * fundamentally is. An unmapped field would be a refusal with no step to open.
 *
 * `provider` belongs to step 1: it is the fundamental identity of the profile and
 * is collected there as part of the profile's core metadata.
 */
export const STEP_FOR_FIELD: Readonly<Record<string, WizardStepId>> = {
  schema_version: "identity",
  provider: "identity",
  identity: "identity",
  sections: "sections",
  period: "period",
  front_matter: "document",
  design: "document",
}

/**
 * The step a field issue belongs to, or `"preview"`.
 *
 * `"preview"` is the fallback rather than a throw, and it is the right one: the
 * last step is where completion is confirmed, so an issue this mapping does not
 * recognize still reaches a consultant on the step whose whole job is "can this be
 * saved?". The alternative — dropping it — would refuse a save and show nothing.
 *
 * A path with **no** segments maps there too. `collectDefinitionIssues` produces
 * one for a definition that is not an object at all, which is a problem with the
 * whole draft rather than with any one step.
 */
export function stepForIssue(issue: FieldIssue): WizardStepId {
  const head = issue.path[0]
  if (typeof head !== "string") return "preview"

  return STEP_FOR_FIELD[head] ?? "preview"
}

export type StepIssues = Readonly<Record<WizardStepId, readonly FieldIssue[]>>

const NO_ISSUES: StepIssues = Object.freeze({
  identity: [],
  sections: [],
  period: [],
  document: [],
  preview: [],
})

/**
 * Every validation issue in `definition`, grouped by the step that owns it.
 *
 * `mode: "draft"` deliberately. A draft is validated as a draft while it is being
 * authored — persisting whether or not the definition yet satisfies the
 * at-least-one-section rule — and validating in `run` mode here would mark step 2
 * as failing from the moment the wizard opens, before the consultant has had a
 * chance to add anything. The at-least-one-section rule is checked at completion
 * instead, by {@link completionProblems}.
 */
export function issuesByStep(definition: unknown): StepIssues {
  const grouped: Record<WizardStepId, FieldIssue[]> = {
    identity: [],
    sections: [],
    period: [],
    document: [],
    preview: [],
  }

  for (const issue of collectDefinitionIssues(definition, { mode: "draft" })) {
    grouped[stepForIssue(issue)].push(issue)
  }

  return grouped
}

/** Whether any step carries an issue. */
export function hasAnyIssue(issues: StepIssues): boolean {
  return WIZARD_STEPS.some((step) => issues[step.id].length > 0)
}

/**
 * The step a reopened profile should open on.
 *
 * The lowest-numbered failing step, or the last step when every step passes — "so
 * that authoring resumes rather than restarting". Opening on step 1
 * unconditionally would make reopening a nearly-finished profile a walk back
 * through five steps the consultant already completed.
 */
export function openingStep(definition: unknown): WizardStep {
  const issues = issuesByStep(definition)

  return (
    WIZARD_STEPS.find((step) => issues[step.id].length > 0) ??
    WIZARD_STEPS[WIZARD_STEP_COUNT - 1]!
  )
}

/** The step before `step`, or `step` itself when it is the first. */
export function previousStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.max(0, step.number - 2)] ?? step
}

/** The step after `step`, or `step` itself when it is the last. */
export function nextStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.min(WIZARD_STEP_COUNT - 1, step.number)] ?? step
}

export function stepById(id: WizardStepId): WizardStep {
  return WIZARD_STEPS.find((step) => step.id === id) ?? WIZARD_STEPS[0]!
}

/**
 * Whether the consultant may leave `step` for a later one.
 *
 * Only this step's own issues block forward navigation. A later step's problems
 * do not — the consultant has not reached it yet — and an earlier step's do not
 * either, because they were what stopped them leaving *that* step, and blocking
 * again here would make an earlier mistake unfixable from where they now are.
 */
export function canAdvance(step: WizardStep, issues: StepIssues): boolean {
  return issues[step.id].length === 0
}

/**
 * Backward navigation, which is always allowed.
 *
 * A function rather than a bare `true`, so the rule is nameable at the call site
 * and the next person to add a guard has to delete something that says why there
 * is none.
 */
export function canReturnTo(
  target: WizardStep,
  highestReached: number
): boolean {
  return target.number <= highestReached
}

// --- Completion ---------------------------------------------------------------

export type CompletionProblem =
  | {
      readonly kind: "step"
      readonly step: WizardStep
      readonly issues: readonly FieldIssue[]
    }
  | { readonly kind: "no_sections" }

/**
 * Why the wizard cannot be completed, or an empty list.
 *
 * Two kinds, because they read differently to a consultant: a failing step is
 * "go here and fix these fields", and an empty profile is "a report needs at
 * least one section" — a sentence, not a field path.
 *
 * Validated in `run` mode here, unlike {@link issuesByStep}. Completion is the
 * moment the draft becomes a version a run will pin, so it is judged by the rules
 * a run applies rather than the looser ones a half-authored draft is allowed.
 *
 * ## Why the `no_sections` check is here rather than in `collectDefinitionIssues`
 *
 * `validateSections` validates section *entries* structurally (ids, types,
 * ordering) but does NOT reject an empty array in `mode: "run"` — it has no
 * `mode` parameter at all. This mirrors how v1/v2 handled `blocks`: the validator
 * allows an empty array during draft authoring, and the wizard's
 * `completionProblems` catches the zero-count case at publish time. We replicate
 * that same split here: a v3 definition with zero sections is a valid draft (can
 * be saved mid-authoring) but is refused at completion.
 */
export function completionProblems(
  definition: unknown,
  /**
   * The catalogue keys of the section types that BEAR metrics, threaded from the
   * server because `lib/profiles/sections.ts` is `server-only`.
   *
   * Omitted means "no catalogue to check against", and the metrics check is then
   * skipped rather than guessed — a wizard with no catalogue must not refuse every
   * profile.
   */
  metricBearingKeys?: ReadonlySet<string>
): readonly CompletionProblem[] {
  const problems: CompletionProblem[] = []

  const grouped: Record<WizardStepId, FieldIssue[]> = {
    identity: [],
    sections: [],
    period: [],
    document: [],
    preview: [],
  }

  for (const issue of collectDefinitionIssues(definition, { mode: "run" })) {
    grouped[stepForIssue(issue)].push(issue)
  }

  // Requirement 12.2 — `identity.customer_name` at v3, checked HERE rather than in
  // the validator, for exactly the reason `no_sections` is checked here: a draft
  // must be saveable before a customer is named (`REQUIRED_IDENTITY_KEYS[3]`
  // deliberately omits it), but a published VERSION without one is useless. Every
  // run pinning it is refused by `enqueueRun` with
  // `front_matter_values_missing`, and the consultant discovers that on the
  // Reports page — a screen away from the field that would fix it, with a version
  // already created that can never produce a report.
  //
  // A blank or whitespace-only value counts as absent. It would otherwise satisfy
  // the enqueue gate's `typeof === "string"` test and print an empty customer on
  // the cover, which is worse than the refusal: the run succeeds and the document
  // is wrong.
  const missingCustomerName = customerNameMissing(definition)
  if (missingCustomerName !== null) {
    grouped.identity.push(missingCustomerName)
  }

  // A metric-bearing section carrying NO metrics, checked here for the same reason
  // `no_sections` and `customer_name` are: legal in a draft, refused at publish.
  //
  // This is the failure that cost the most to diagnose. The validator accepts an
  // empty `metrics[]` (it is optional), so the wizard said "Every step passes" and
  // published a version. The collector then requested nothing for that section's
  // resource types, produced no statistic, and the run died `NO_STATISTICS` — whose
  // copy points at deallocated machines and resource types that emit nothing, i.e.
  // at the customer's estate, for what is entirely a fact about the profile. Seeding
  // metrics in `addSection` fixes new sections; it cannot fix a section that already
  // exists, which is exactly the case that kept reaching a run.
  for (const empty of metricBearingSectionsWithoutMetrics(
    definition,
    metricBearingKeys
  )) {
    grouped.sections.push(empty)
  }

  for (const step of WIZARD_STEPS) {
    const issues = grouped[step.id]
    if (issues.length > 0) problems.push({ kind: "step", step, issues })
  }

  if (sectionCount(definition) === 0) problems.push({ kind: "no_sections" })

  return problems
}

/**
 * The issue to raise when a v3 definition names no customer, or `null`.
 *
 * Exported so the same rule can be asserted directly, and so nothing else has to
 * re-derive "what counts as naming a customer" — the answer (a non-blank string
 * at `schema_version` >= 3) has to agree with `resolveCustomerName`'s own gate in
 * `lib/actions/runs.ts`, and two copies of it would drift.
 *
 * Returns `null` below v3: there the value is a per-run form field, not a
 * property of the profile, so its absence here is not a defect.
 */
export function customerNameMissing(definition: unknown): FieldIssue | null {
  if (typeof definition !== "object" || definition === null) return null

  const record = definition as Record<string, unknown>
  const schemaVersion =
    typeof record.schema_version === "number" ? record.schema_version : 1
  if (schemaVersion < 3) return null

  const identity = record.identity
  const value =
    typeof identity === "object" && identity !== null
      ? (identity as Record<string, unknown>).customer_name
      : undefined

  if (typeof value === "string" && value.trim() !== "") return null

  return {
    path: ["identity", "customer_name"],
    message:
      "Name the customer this report is for. A run cannot be requested " +
      "without one.",
  }
}

/**
 * One issue per metric-bearing section that selects no metric.
 *
 * A section whose type bears metrics but whose `metrics[]` is empty requests
 * nothing at collection time, so every resource its rule matches is recorded as a
 * `metric_not_selected` gap and the run reports `NO_STATISTICS` if no other section
 * collected anything. The message names the section index, which is what the rail
 * needs to send the author to the right row.
 *
 * Exported so the rule can be asserted directly rather than only through the
 * wizard's own render.
 */
export function metricBearingSectionsWithoutMetrics(
  definition: unknown,
  metricBearingKeys?: ReadonlySet<string>
): readonly FieldIssue[] {
  if (metricBearingKeys === undefined || metricBearingKeys.size === 0) return []
  if (typeof definition !== "object" || definition === null) return []

  const sections = (definition as { readonly sections?: unknown }).sections
  if (!Array.isArray(sections)) return []

  const issues: FieldIssue[] = []

  sections.forEach((section, index) => {
    if (typeof section !== "object" || section === null) return
    const entry = section as Record<string, unknown>
    if (typeof entry.type !== "string") return
    if (!metricBearingKeys.has(entry.type)) return

    const metrics = entry.metrics
    if (Array.isArray(metrics) && metrics.length > 0) return

    issues.push({
      path: ["sections", index, "metrics"],
      message:
        `Section "${entry.type}" reports metrics but none are selected, so the ` +
        `run would collect nothing for it. Choose a set in the section's Metrics ` +
        `row.`,
    })
  })

  return issues
}

/**
 * The definition's section count.
 *
 * Reads defensively because a draft is `unknown` until it validates.
 */
export function sectionCount(definition: unknown): number {
  if (typeof definition !== "object" || definition === null) return 0

  const sections = (definition as { readonly sections?: unknown }).sections

  return Array.isArray(sections) ? sections.length : 0
}

/**
 * The number of DISTINCT resource types the definition narrows its collection to,
 * or `0` meaning "not narrowed — all of them".
 *
 * Reads both shapes because the count means the same thing in each and the
 * summary that displays it must not crash on either:
 *
 * - at v1/v2 the narrowing is one top-level `scope.resource_types`;
 * - at v3 there is **no top-level scope at all** — each section carries its own
 *   `selection`, so the definition's narrowing is the UNION across sections.
 *
 * The union, specifically, and not a sum: two sections both scoped to
 * `virtualMachines` narrow the run to one resource type, and the collector
 * fetches the union of every section's scope exactly once (see
 * `azure-integration.md`). Summing would claim a breadth the run does not have.
 *
 * A v3 section with no `selection` inherits the catalogue entry's own
 * `needs_resource_types`, which this function cannot see (it has no catalogue).
 * Such a section therefore contributes nothing here, which is why the "0 means
 * all" reading is the honest one for a v3 profile: absent an explicit narrowing,
 * the run is bounded by the catalogue, not by the author.
 */
export function scopedResourceTypeCount(definition: unknown): number {
  if (typeof definition !== "object" || definition === null) return 0

  const record = definition as Record<string, unknown>

  // v1/v2 — one top-level scope.
  const scope = record.scope
  if (typeof scope === "object" && scope !== null) {
    const types = (scope as Record<string, unknown>).resource_types
    if (Array.isArray(types)) return new Set(types).size
  }

  // v3 — the union across every section's own selection.
  const sections = record.sections
  if (!Array.isArray(sections)) return 0

  const union = new Set<string>()
  for (const section of sections) {
    if (typeof section !== "object" || section === null) continue
    const selection = (section as Record<string, unknown>).selection
    if (typeof selection !== "object" || selection === null) continue
    const types = (selection as Record<string, unknown>).resource_types
    if (!Array.isArray(types)) continue
    for (const type of types) {
      if (typeof type === "string") union.add(type)
    }
  }
  return union.size
}

/**
 * How many metric-selection items the definition carries in total.
 *
 * A sum here rather than a union, unlike {@link scopedResourceTypeCount}: a
 * metric item is a request for one figure on one resource type, so the same
 * metric selected by two sections is two entries in the ledger and two figures
 * in the document. Counting it once would understate the work.
 *
 * v1/v2 keep `metrics` as an object keyed by resource type; v3 puts an array on
 * each section. Both are read defensively — a draft is `unknown` until it
 * validates.
 */
export function metricItemCount(definition: unknown): number {
  if (typeof definition !== "object" || definition === null) return 0

  const record = definition as Record<string, unknown>

  // v1/v2 — one top-level object keyed by resource type.
  const metrics = record.metrics
  if (
    typeof metrics === "object" &&
    metrics !== null &&
    !Array.isArray(metrics)
  ) {
    return Object.values(metrics as Record<string, unknown>).reduce(
      (total: number, items) =>
        total + (Array.isArray(items) ? items.length : 0),
      0
    )
  }

  // v3 — an array per section.
  const sections = record.sections
  if (!Array.isArray(sections)) return 0

  return sections.reduce((total: number, section) => {
    if (typeof section !== "object" || section === null) return total
    const items = (section as Record<string, unknown>).metrics
    return total + (Array.isArray(items) ? items.length : 0)
  }, 0)
}

/**
 * The definition's style preset, or `null` when it declares none.
 *
 * Defensive for the same reason as the counts above: `design` is absent on a
 * partially-authored draft, and the completion summary must render rather than
 * throw when it is.
 */
export function designPreset(definition: unknown): string | null {
  if (typeof definition !== "object" || definition === null) return null
  const design = (definition as Record<string, unknown>).design
  if (typeof design !== "object" || design === null) return null
  const preset = (design as Record<string, unknown>).preset
  return typeof preset === "string" ? preset : null
}

export { NO_ISSUES }
