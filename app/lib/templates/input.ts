import { z } from "zod"

/**
 * Every input the template routes parse — bodies, path parameters and search
 * parameters alike (Requirement 7.7).
 *
 * Named schemas in one module rather than inline literals in six handlers, for
 * the reason `lib/runs/input.ts` gives: a schema declared at its use site is a
 * schema the next handler writes a slightly different version of, and the bound
 * that matters here (a template name is 1–120 characters) is a CHECK constraint
 * in Postgres that a second, looser copy would let a request reach.
 *
 * **Pure, and deliberately not `server-only`.** These schemas describe the wire
 * format, and the wizard is entitled to validate a field against the same bound
 * the route will apply rather than discover it from a 400.
 *
 * ## `definition` is `z.unknown()`, on purpose
 *
 * A template definition is not parsed here. `collectDefinitionIssues` is the
 * validator, it is mirrored in `agent/src/reporting_agent/compile/definition.py`,
 * and Requirement 2.6 makes the two halves' agreement a tested property. A zod
 * schema for the definition in this file would be a **third** declaration of the
 * same rules, drifting from both, and the first thing it would break is the
 * mirror guard's claim that there are exactly two.
 *
 * So the boundary's job for a definition is to establish that a JSON value
 * arrived at all, and the action's job is to decide whether it is a definition.
 */

/**
 * A bound on a path id, so a pathological URL is refused before it reaches a
 * query.
 *
 * A bounded non-empty string, deliberately not `z.uuid()`, matching
 * `runIdParamSchema`'s reasoning: `report_templates.id` is a `text` primary key,
 * and a boundary asserting more than the column does starts rejecting valid rows
 * the day an id is minted any other way.
 */
export const TEMPLATE_ID_PARAM_MAX_LENGTH = 200

export const TEMPLATE_ID_PARAM_MESSAGE =
  "The template id is missing from the request path."

export const templateIdParamSchema = z
  .object({
    id: z
      .string({ error: TEMPLATE_ID_PARAM_MESSAGE })
      .trim()
      .min(1, { error: TEMPLATE_ID_PARAM_MESSAGE })
      .max(TEMPLATE_ID_PARAM_MAX_LENGTH, { error: TEMPLATE_ID_PARAM_MESSAGE }),
  })
  .strict()

export type TemplateIdParam = z.output<typeof templateIdParamSchema>

// --- Name and description ----------------------------------------------------

/** `report_templates_name_ck` — 1 to 120 characters. */
export const TEMPLATE_NAME_MIN_LENGTH = 1
export const TEMPLATE_NAME_MAX_LENGTH = 120

/** `report_templates_description_ck` — at most 1000 characters. */
export const TEMPLATE_DESCRIPTION_MAX_LENGTH = 1000

export const TEMPLATE_NAME_MESSAGE =
  `Give the template a name of ${TEMPLATE_NAME_MIN_LENGTH} to ` +
  `${TEMPLATE_NAME_MAX_LENGTH} characters.`

/**
 * Trimmed **before** the bounds are applied, so a name of 120 spaces is a name
 * of zero characters and is refused here rather than by the CHECK constraint —
 * which would surface as a 500 rather than a field error the wizard can point at.
 */
const templateNameSchema = z
  .string({ error: TEMPLATE_NAME_MESSAGE })
  .trim()
  .min(TEMPLATE_NAME_MIN_LENGTH, { error: TEMPLATE_NAME_MESSAGE })
  .max(TEMPLATE_NAME_MAX_LENGTH, { error: TEMPLATE_NAME_MESSAGE })

const templateDescriptionSchema = z
  .string()
  .trim()
  .max(TEMPLATE_DESCRIPTION_MAX_LENGTH, {
    error: `A description is at most ${TEMPLATE_DESCRIPTION_MAX_LENGTH} characters.`,
  })

// --- The bodies ---------------------------------------------------------------

/**
 * `POST /api/templates` — create a template, and optionally its first version.
 *
 * `definition` is optional because the two ways a template begins are different
 * shapes. The wizard's "New template" creates a named row with no version and no
 * draft, then writes a draft per step; a template created from a definition
 * already in hand — a duplicate, a fixture, a future import — arrives complete
 * and gets `version` 1 in the same request.
 */
export const templateCreateInputSchema = z
  .object({
    name: templateNameSchema,
    description: templateDescriptionSchema.optional(),
    definition: z.unknown().optional(),
  })
  .strict()

export type TemplateCreateInput = z.output<typeof templateCreateInputSchema>

/**
 * `PATCH /api/templates/[id]` — write the draft, rename, or both.
 *
 * Both fields optional, and **at least one required**: a `PATCH` naming neither
 * is a request with no effect, and answering it `200` would tell the wizard a
 * save happened. The refinement is what turns that into a field error.
 *
 * `draftDefinition` accepts `null`, which is how the wizard discards a draft —
 * distinct from omitting the key, which leaves the stored draft alone. `z.unknown()`
 * cannot express "present and null" on its own, so the key is declared
 * `z.union([z.unknown(), z.null()])`-free by simply being unknown: `undefined`
 * means absent and every other value, `null` included, is written.
 */
export const templatePatchInputSchema = z
  .object({
    name: templateNameSchema.optional(),
    draftDefinition: z.unknown().optional(),
  })
  .strict()
  .refine(
    (body) => body.name !== undefined || "draftDefinition" in body,
    {
      error:
        "Send a name, a draft definition, or both — a patch with neither " +
        "changes nothing.",
    }
  )

export type TemplatePatchInput = z.output<typeof templatePatchInputSchema>

/**
 * `POST /api/templates/[id]` — validate, canonicalize and insert the next
 * version (Requirement 9.2).
 *
 * The definition is in the body rather than read from the stored draft, and the
 * difference matters at step 7 of the wizard: the consultant is looking at state
 * held in the browser, and publishing the *draft column* would publish whatever
 * the last successful autosave managed to write. Sending the definition makes
 * "what I am looking at" and "what gets versioned" the same object.
 */
export const templatePublishInputSchema = z
  .object({ definition: z.unknown() })
  .strict()

export type TemplatePublishInput = z.output<typeof templatePublishInputSchema>

/**
 * `GET /api/templates` and `GET /api/templates/catalog` accept no search
 * parameter, and say so.
 *
 * Stricter than `GET /api/runs`, which tolerates an unexpected parameter because
 * a polling `fetch` appending a cache-buster is ordinary there. These two are not
 * polled, so a parameter arriving here is an expectation being expressed — a
 * filter, a page, a resource-type narrowing — and answering the unfiltered list
 * to a caller that asked for a filtered one is worse than refusing.
 */
export const templateQuerySchema = z.object({}).strict()

/**
 * 180 seconds, from Requirement 14.9.
 *
 * Declared here rather than beside the route's other preview helpers because
 * **both halves read it**: the route enforces the deadline and the panel names
 * it while a render is in flight. `lib/templates/preview.ts` carries
 * `import "server-only"` — correctly, it opens a database connection — so a
 * client component importing the budget from there would be a build error.
 *
 * One constant, so a preview cannot time out at 180s in one place and 175s in
 * the other, which is the shape of bug where the UI says "still working" over a
 * request that was abandoned.
 */
export const PREVIEW_BUDGET_MS = 180_000

/**
 * `POST /api/templates/[id]/preview` — the real preview (Requirement 14.5).
 *
 * `definition` is the composed draft, inline and unvalidated here for the reason
 * the module docstring gives: the validator is mirrored in two places already,
 * and the runtime refuses a definition it cannot compile with a stage this route
 * reports. A third zod copy would be a third verdict.
 *
 * `supersedes` is the previous preview's id, sent by the panel so the app can
 * delete the object it replaced. Optional, because the first activation of a
 * session supersedes nothing — and bounded, because it becomes a path segment.
 */
export const previewRequestSchema = z
  .object({
    connectedSubscriptionId: z
      .string({ error: "Choose a connected subscription to preview against." })
      .trim()
      .min(1, { error: "Choose a connected subscription to preview against." })
      .max(TEMPLATE_ID_PARAM_MAX_LENGTH),
    definition: z.unknown(),
    supersedes: z
      .string()
      .trim()
      .min(1)
      .max(TEMPLATE_ID_PARAM_MAX_LENGTH)
      // A path segment, so anything that could climb out of the prefix is
      // refused here rather than trusted to `previewBelongsToActor` — which
      // would catch it, and should not be the only thing that does.
      .regex(/^[A-Za-z0-9_-]+$/, {
        error: "A preview id is letters, digits, hyphens and underscores.",
      })
      .optional(),
  })
  .strict()

export type PreviewRequest = z.output<typeof previewRequestSchema>
