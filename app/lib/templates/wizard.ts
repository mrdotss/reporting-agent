import {
  collectDefinitionIssues,
  type FieldIssue,
} from "@/lib/templates/definition"

/**
 * The wizard's step model (Requirement 11).
 *
 * **Pure, and deliberately not `server-only`.** The shell is a client component
 * and needs every function here; nothing below reads a clock, a database or an
 * environment.
 *
 * ## Why the mapping lives here rather than in the shell
 *
 * Three of Requirement 11's criteria are about *which step* a problem belongs to:
 * 11.3 keeps the consultant on the current step and names each failing field path
 * on it, 11.8 opens the lowest-numbered failing step when a draft is reopened, and
 * 11.10 names each failing step on a refused completion. All three need one
 * answer to "which step owns this field path", and a shell that computed it inline
 * would compute it three times.
 *
 * The mapping is by **first path segment**, and that works because the definition's
 * seven top-level fields are exactly the wizard's first six steps plus
 * `schema_version`. That is not a coincidence to rely on quietly, so
 * {@link STEP_FOR_FIELD} is exhaustive over `TemplateDefinition`'s keys and
 * `wizard.test.ts` asserts it stays that way — a field added to the definition
 * with no step to show it in would otherwise be a validation error the wizard
 * reports on no step at all, leaving the consultant with a refusal and nowhere to
 * act on it.
 */

export const WIZARD_STEP_COUNT = 6

export type WizardStepId =
  "identity" | "scope" | "period" | "metrics" | "blocks" | "preview"

export type WizardStep = {
  readonly id: WizardStepId
  /** 1-based, and displayed — Requirement 11.1's "position and the total of seven". */
  readonly number: number
  readonly title: string
  /** One line describing what the consultant decides here. */
  readonly summary: string
}

/**
 * The seven steps, in the fixed order Requirement 11.1 declares.
 *
 * The order is a constant rather than a configuration. A wizard whose steps could
 * be reordered would have a `metrics` step reachable before `scope`, and the
 * metric selection is per resource type — so it would be asking which metrics to
 * collect for a set of resource types the consultant has not chosen yet.
 */
export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: "identity",
    number: 1,
    title: "Identity",
    summary: "What this report is called, and the title printed on it.",
  },
  {
    id: "scope",
    number: 2,
    title: "Scope rules",
    summary:
      "Which resources, as rules — resource types, tags, resource groups. Never named resources.",
  },
  {
    id: "period",
    number: 3,
    title: "Period",
    summary: "A rule resolved fresh at each run, not a fixed pair of dates.",
  },
  {
    id: "metrics",
    number: 4,
    title: "Metrics",
    summary: "Which figures to collect, per resource type, from the catalog.",
  },
  {
    id: "blocks",
    number: 5,
    title: "Blocks",
    summary: "The document itself — what it contains and in what order.",
  },
  {
    id: "preview",
    number: 6,
    title: "Preview",
    summary: "What the document will look like, and saving the version.",
  },
]

/**
 * Which step owns each top-level field of a definition.
 *
 * `schema_version` belongs to step 1 not because a consultant sets it — nothing in
 * the wizard does — but because a problem with it has to surface *somewhere*, and
 * the first step is where a consultant is already looking at what the template
 * fundamentally is. An unmapped field would be a refusal with no step to open.
 */
export const STEP_FOR_FIELD: Readonly<Record<string, WizardStepId>> = {
  schema_version: "identity",
  identity: "identity",
  scope: "scope",
  period: "period",
  metrics: "metrics",
  blocks: "blocks",
  design: "preview",
}

/**
 * The step a field issue belongs to, or `"preview"`.
 *
 * `"preview"` is the fallback rather than a throw, and it is the right one: step 7
 * is where completion is confirmed, so an issue this mapping does not recognize
 * still reaches a consultant on the step whose whole job is "can this be saved?".
 * The alternative — dropping it — would refuse a save and show nothing.
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
  scope: [],
  period: [],
  metrics: [],
  blocks: [],
  preview: [],
})

/**
 * Every validation issue in `definition`, grouped by the step that owns it.
 *
 * `mode: "draft"` deliberately. A draft is validated as a draft while it is being
 * authored — Requirement 11.4 persists it "whether or not the definition yet
 * satisfies the at-least-one-block rule" — and validating in `run` mode here would
 * mark step 5 as failing from the moment the wizard opens, before the consultant
 * has had a chance to add anything. The at-least-one-block rule is checked at
 * completion instead, by {@link completionProblems}, which is where Requirement
 * 11.10 puts it.
 */
export function issuesByStep(definition: unknown): StepIssues {
  const grouped: Record<WizardStepId, FieldIssue[]> = {
    identity: [],
    scope: [],
    period: [],
    metrics: [],
    blocks: [],
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
 * The step a reopened template should open on (Requirement 11.8).
 *
 * The lowest-numbered failing step, or step 7 when every step passes — "so that
 * authoring resumes rather than restarting". Opening on step 1 unconditionally
 * would make reopening a nearly-finished template a walk back through six steps
 * the consultant already completed.
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
 * Whether the consultant may leave `step` for a later one (Requirement 11.3).
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
 * Backward navigation, which is always allowed (Requirement 11.2).
 *
 * A function rather than a bare `true`, so the rule is nameable at the call site
 * and the next person to add a guard has to delete something that says why there
 * is none. Requirement 11.2 allows navigating to any step "at or below the highest
 * step reached", retaining every value — a wizard that validated on the way *back*
 * would trap a consultant on a step they were trying to leave in order to fix the
 * thing that was wrong.
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
  | { readonly kind: "no_blocks" }

/**
 * Why the wizard cannot be completed, or an empty list (Requirement 11.10).
 *
 * Two kinds, because they read differently to a consultant: a failing step is
 * "go here and fix these fields", and an empty document is "a report needs at
 * least one block" — a sentence, not a field path. Requirement 11.10 asks for both
 * to be stated, so neither is folded into the other.
 *
 * Validated in `run` mode here, unlike {@link issuesByStep}. Completion is the
 * moment the draft becomes a version a run will pin, so it is judged by the rules
 * a run applies rather than the looser ones a half-authored draft is allowed.
 */
export function completionProblems(
  definition: unknown
): readonly CompletionProblem[] {
  const problems: CompletionProblem[] = []

  const grouped: Record<WizardStepId, FieldIssue[]> = {
    identity: [],
    scope: [],
    period: [],
    metrics: [],
    blocks: [],
    preview: [],
  }

  for (const issue of collectDefinitionIssues(definition, { mode: "run" })) {
    grouped[stepForIssue(issue)].push(issue)
  }

  for (const step of WIZARD_STEPS) {
    const issues = grouped[step.id]
    if (issues.length > 0) problems.push({ kind: "step", step, issues })
  }

  if (blockCount(definition) === 0) problems.push({ kind: "no_blocks" })

  return problems
}

/**
 * The definition's top-level block count.
 *
 * Top-level, not recursive: Requirement 6.8's rule is that a report carries at
 * least one block, and a `row` holding two blocks is one block that carries two.
 * Reads defensively because a draft is `unknown` until it validates.
 */
export function blockCount(definition: unknown): number {
  if (typeof definition !== "object" || definition === null) return 0

  const blocks = (definition as { readonly blocks?: unknown }).blocks

  return Array.isArray(blocks) ? blocks.length : 0
}

export { NO_ISSUES }
