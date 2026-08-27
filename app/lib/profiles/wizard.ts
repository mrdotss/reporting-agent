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
  | "identity"
  | "sections"
  | "period"
  | "document"
  | "preview"

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
    summary:
      "What this report profile is called, and the provider it targets.",
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
    summary:
      "Front matter, approvers, distribution, and document appearance.",
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
  definition: unknown
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

  for (const step of WIZARD_STEPS) {
    const issues = grouped[step.id]
    if (issues.length > 0) problems.push({ kind: "step", step, issues })
  }

  if (sectionCount(definition) === 0) problems.push({ kind: "no_sections" })

  return problems
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
 * Distinct resource types the definition constrains itself to; `0` means unconstrained.
 *
 * Version-aware and total, like {@link sectionCount}, because the preview step renders
 * for BOTH shapes: a v1/v2 definition keeps one template-wide `scope`, while a v3 profile
 * carries a selection rule per section and has no top-level `scope` at all. Reading
 * `definition.scope.resource_types` unconditionally is what crashed the wizard on a
 * brand-new v3 profile -- and only on a VALID one, because `openingStep` sends a
 * definition with no issues straight to the last step, so an invalid draft never reached
 * this render.
 */
export function resourceTypeCount(definition: unknown): number {
  if (typeof definition !== "object" || definition === null) return 0

  const sections = (definition as { readonly sections?: unknown }).sections
  if (Array.isArray(sections)) {
    const types = new Set<string>()
    for (const section of sections) {
      const selection = (section as { readonly selection?: unknown })?.selection
      const declared = (selection as { readonly resource_types?: unknown })
        ?.resource_types
      if (Array.isArray(declared)) {
        for (const type of declared) {
          if (typeof type === "string") types.add(type)
        }
      }
    }
    return types.size
  }

  const scope = (definition as { readonly scope?: unknown }).scope
  const declared = (scope as { readonly resource_types?: unknown })?.resource_types
  return Array.isArray(declared) ? declared.length : 0
}

/** Metric entries the definition selects, across sections at v3 or `metrics` at v1/v2. */
export function metricEntryCount(definition: unknown): number {
  if (typeof definition !== "object" || definition === null) return 0

  const sections = (definition as { readonly sections?: unknown }).sections
  if (Array.isArray(sections)) {
    return sections.reduce<number>((total, section) => {
      const metrics = (section as { readonly metrics?: unknown })?.metrics
      return total + (Array.isArray(metrics) ? metrics.length : 0)
    }, 0)
  }

  const metrics = (definition as { readonly metrics?: unknown }).metrics
  if (typeof metrics !== "object" || metrics === null) return 0

  return Object.values(metrics as Record<string, unknown>).reduce<number>(
    (total, items) => total + (Array.isArray(items) ? items.length : 0),
    0
  )
}

export { NO_ISSUES }
