import "server-only"

import {
  collectDefinitionIssues,
  validateMetricSelectionAgainstCatalog,
  type FieldIssue,
} from "@/lib/templates/definition"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import * as store from "@/lib/templates/store"
import { definitionSha256 } from "@/lib/templates/version"

import type {
  ReportTemplate,
  ReportTemplateVersion,
} from "@/lib/db/schema"

/**
 * The template operations, as thin wrappers over `lib/templates/store.ts`
 * (Requirements 1.4, 1.5, 9.2, 9.5, 10.7, 11.4).
 *
 * ## `import "server-only"`, not `"use server"`
 *
 * The same security property `lib/actions/runs.ts` records, for the same reason.
 * Every function here takes the owning **user id as its first argument**. Under
 * `"use server"` each export becomes a browser-reachable endpoint, so those
 * signatures would be endpoints through which any caller could read, rewrite or
 * delete any user's template by passing somebody else's id. The wizard is a
 * `"use client"` leaf that `fetch`es the routes under `app/api/templates/`, and
 * each route resolves the session and passes the id it resolved.
 *
 * ## What "thin" excludes, and what it does not
 *
 * The store settles ownership scoping, version sequencing and immutability. This
 * module settles **validation**, and that split is deliberate: the store must not
 * be able to write an invalid definition, and the only way to guarantee that
 * without duplicating the validator into it is to make validation something a
 * caller cannot skip on the way in. {@link publishTemplateVersion} is the only
 * path to `insertVersion` in the application, and it validates first.
 *
 * Drafts are the exception, and Requirement 11.4 is explicit about it: a draft
 * persists "whether or not step 7 was reached and whether or not the definition
 * yet carries a block". A wizard that refused to save a half-finished draft
 * would lose the consultant's work every time they navigated away from a step
 * they had not finished — which is the failure the draft column exists to
 * prevent.
 */

// --- Rejections -------------------------------------------------------------

/**
 * A definition was refused, with **no version row inserted** (Requirement 2.7).
 *
 * `issues` carries every failing field path rather than the first, because
 * Requirement 11.5 has the wizard name "every failing field path" and stop on
 * the lowest-numbered failing step: a caller given one issue at a time cannot
 * decide which step to open, and a consultant fixing one field per round trip is
 * the experience that requirement exists to forbid.
 */
export class TemplateInvalidError extends Error {
  readonly issues: readonly FieldIssue[]

  constructor(issues: readonly FieldIssue[]) {
    super("That template definition is not one the compiler could compile.")
    this.name = "TemplateInvalidError"
    this.issues = issues
  }
}

// --- Create, rename, delete --------------------------------------------------

export async function createTemplate(
  userId: string,
  input: store.CreateTemplateInput
): Promise<ReportTemplate> {
  return await store.createTemplate(userId, input)
}

export async function renameTemplate(
  userId: string,
  id: string,
  name: string
): Promise<ReportTemplate> {
  return await store.renameTemplate(userId, id, name)
}

export async function deleteTemplate(userId: string, id: string): Promise<void> {
  await store.deleteTemplate(userId, id)
}

// --- The draft ---------------------------------------------------------------

/**
 * Persist the wizard's in-progress definition, unvalidated (Requirement 11.4).
 *
 * **No validation, on purpose.** See the module docstring: a draft that had to
 * be valid to be saved would discard a consultant's work every time they left a
 * step mid-edit. What a draft must not do is consume a version number, and it
 * cannot: the store writes one column on one table and reaches
 * `report_template_versions` through no path at all.
 */
export async function saveDraft(
  userId: string,
  id: string,
  draftDefinition: unknown
): Promise<ReportTemplate> {
  return await store.saveDraft(userId, id, draftDefinition)
}

// --- Publishing a version ----------------------------------------------------

/**
 * Validate, canonicalize, and insert the next immutable version — or return the
 * existing highest version when the digest is unchanged (Requirements 2.7, 9.2,
 * 9.4, 9.5).
 *
 * ## Both validation passes, in this order
 *
 * `collectDefinitionIssues` settles **shape**: the seven required top-level
 * fields, every bound, every enum, the block-config schemas, and the two
 * cross-field rules a definition can be checked against on its own — including
 * Requirement 5.9's "every scoped resource type carries a metric selection".
 * It is mirrored in `agent/src/reporting_agent/compile/definition.py`, so a
 * definition that passes here is a definition the compiler accepts.
 *
 * `validateMetricSelectionAgainstCatalog` settles **membership**: every selected
 * metric and derived statistic exists in the Metric_Catalog for its resource
 * type, every derived statistic's sources are present, and every percentile
 * carries the estimator label and fidelity tier the catalog declares
 * (Requirements 5.2, 5.5, 5.7, 5.8).
 *
 * Shape first, and the ordering is load-bearing rather than tidy: the catalog
 * pass walks the definition assuming the shape is well-formed and does not
 * repeat the structural checks, so running it against an unvalidated blob would
 * read fields that may not be there.
 *
 * ## The unchanged-digest case is not an error
 *
 * A consultant who opens the wizard, changes nothing and presses save has not
 * made a mistake, and Requirement 9.5 says the result is the existing version
 * rather than a second identical one. The store settles that by comparing the
 * canonical digest, so this function's contribution is only to compute the
 * digest the same way the snapshot path computes its own — RFC 8785 over the
 * definition, SHA-256 of the UTF-8 bytes, 64 lowercase hex characters.
 */
export async function publishTemplateVersion(
  userId: string,
  templateId: string,
  definition: unknown
): Promise<ReportTemplateVersion> {
  const shapeIssues = collectDefinitionIssues(definition, { mode: "run" })
  if (shapeIssues.length > 0) throw new TemplateInvalidError(shapeIssues)

  // Safe now, and only now: the shape pass returned no issue, so every field the
  // catalog pass reads is present and of the type it expects. The cast is what
  // the two-pass layering costs, and it is confined to this one line rather
  // than spread across the catalog validator's signature.
  const catalogIssues = validateMetricSelectionAgainstCatalog(
    definition as Parameters<typeof validateMetricSelectionAgainstCatalog>[0],
    METRIC_CATALOG
  )
  if (catalogIssues.length > 0) throw new TemplateInvalidError(catalogIssues)

  return await store.insertVersion(userId, templateId, {
    definition,
    definitionSha256: definitionSha256(
      definition as Parameters<typeof definitionSha256>[0]
    ),
  })
}
