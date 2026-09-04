import "server-only"

import { resolveLogoIntoDefinition } from "@/lib/templates/logo"

import {
  collectDefinitionIssues,
  validateMetricSelectionAgainstCatalog,
  type FieldIssue,
} from "@/lib/templates/definition"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import { sectionByKey } from "@/lib/profiles/sections"
import * as store from "@/lib/templates/store"
import { definitionSha256 } from "@/lib/templates/version"
import { ensureBrand } from "@/lib/brands/store"

import type {
  ReportTemplate,
  ReportTemplateVersion,
  Brand,
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

export async function deleteTemplate(
  userId: string,
  id: string
): Promise<void> {
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

// --- Provider immutability (Requirement 3.6) ---------------------------------

/**
 * Whether `incoming`'s `provider` conflicts with `existingDefinition`'s, and if so,
 * the `FieldIssue` to refuse the publish with. `null` when there is no conflict.
 *
 * **Pure**, like {@link resolveDesignFromBrand}, and for the same reason: the
 * publish path around it (`publishTemplateVersion` → `store.readLatestVersion`) only
 * runs against a real Postgres, so a test driving the whole path would not run in
 * ordinary development. This function is the actual decision; the caller only reads
 * the existing version and calls it.
 *
 * Enforced only when BOTH sides declare a `provider` — v1/v2 definitions have no
 * such field, so a v1/v2 template (or a v3 template with no version yet) never
 * trips this check. `existingDefinition` is `null` for a template with no version
 * yet, which is also never a conflict: there is nothing to have locked in.
 */
export function checkProviderImmutable(
  existingDefinition: unknown,
  incoming: unknown
): FieldIssue | null {
  if (typeof existingDefinition !== "object" || existingDefinition === null) {
    return null
  }
  if (typeof incoming !== "object" || incoming === null) return null

  const existingProvider = (existingDefinition as Record<string, unknown>)
    .provider
  const incomingProvider = (incoming as Record<string, unknown>).provider

  if (existingProvider === undefined || incomingProvider === undefined) {
    return null
  }
  if (existingProvider === incomingProvider) return null

  return {
    path: ["provider"],
    message:
      `Provider cannot be changed once a version exists. ` +
      `This profile's provider is locked to "${String(existingProvider)}".`,
  }
}

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
  //
  // The resolver is what makes this work at v3, where the selection lives on each
  // section instead of in one top-level `metrics` object: a section that does not
  // narrow its own scope applies its metrics to the section catalogue's declared
  // resource types. Without it a v3 section's metrics would silently go
  // unchecked against the Metric_Catalog.
  const catalogIssues = validateMetricSelectionAgainstCatalog(
    definition as Parameters<typeof validateMetricSelectionAgainstCatalog>[0],
    METRIC_CATALOG,
    (sectionType) => sectionByKey(sectionType)?.needs_resource_types ?? []
  )
  if (catalogIssues.length > 0) throw new TemplateInvalidError(catalogIssues)

  // --- Provider immutability (Requirement 3.6) ------------------------------
  // A profile's provider determines which catalogues (metrics, facts, sections)
  // apply to it and which subscription connections are eligible. Changing it after
  // a version exists would make the stored version's sections reference a different
  // provider's catalogue, breaking the contract that a pinned version plus its
  // snapshot reproduces the delivered document. So: once a version exists, the
  // provider field is locked to whatever the first version declared.
  const existingVersion = await store.readLatestVersion(userId, templateId)
  const providerIssue = checkProviderImmutable(
    existingVersion?.definition ?? null,
    definition
  )
  if (providerIssue !== null) throw new TemplateInvalidError([providerIssue])

  // --- Resolve Brand into definition.design (Requirement 2.6, 2.7) ---------
  // A saved version must be SELF-CONTAINED against later Brand edits: the Brand
  // is resolved here, between validation and insertion, so the renderer never
  // learns Brands exist. The version carries the full DesignSpec inline, and a
  // Brand edit applies to the NEXT version, never retroactively.
  const brand = await ensureBrand(userId)
  const withBrand = resolveNoticeFromBrand(
    resolveDesignFromBrand(definition, brand),
    brand
  )

  // --- Resolve the cover logo into stored bytes ------------------------------
  // Same seam and the same reason: a saved version must be self-contained. The
  // logo is a URL a profile author typed, and fetching it while rendering would
  // mean the runtime requesting an address chosen by the person whose report it
  // is, from inside the VPC. It is fetched once here, validated by its own magic
  // number, and stored; the version carries the key. A logo that changes at that
  // URL afterwards does not change a report already delivered.
  //
  // The previous version's URL and key are passed so an unchanged logo is not
  // re-fetched and re-stored on every save.
  const previousCover = coverOf(existingVersion?.definition ?? null)
  const resolvedDefinition = await resolveLogoIntoDefinition(
    withBrand as Record<string, unknown>,
    userId,
    previousCover
  )

  return await store.insertVersion(userId, templateId, {
    definition: resolvedDefinition,
    definitionSha256: definitionSha256(
      resolvedDefinition as Parameters<typeof definitionSha256>[0]
    ),
  })
}


/** The previous version's logo URL and resolved key, for the reuse check. */
function coverOf(definition: unknown): {
  readonly logo?: string | null
  readonly logoKey?: string | null
} {
  if (definition === null || typeof definition !== "object") return {}
  const front = (definition as Record<string, unknown>)["front_matter"]
  if (front === null || typeof front !== "object") return {}
  const cover = (front as Record<string, unknown>)["cover"]
  if (cover === null || typeof cover !== "object") return {}
  const record = cover as Record<string, unknown>
  return {
    logo: typeof record["logo"] === "string" ? record["logo"] : null,
    logoKey: typeof record["logo_key"] === "string" ? record["logo_key"] : null,
  }
}

// --- Brand resolution --------------------------------------------------------

/**
 * Write the Brand's design values into `definition.design`, producing a
 * self-contained definition that is immune to later Brand edits.
 *
 * This is the mechanism that implements Requirement 2.7: a report is an audit
 * artifact, so the design values are frozen at publish time rather than
 * dereferenced at render time. The renderer never learns that Brands exist.
 *
 * **Exported for test.** The publish path itself is only reachable with a real
 * Postgres (its store tests are integration tests, which skip without a database),
 * so a test driving `publishTemplateVersion` end to end would not run in ordinary
 * development and would protect nothing day to day. This function is where the
 * frozen-at-publish guarantee actually lives, so this is the seam the guard needs.
 */
/**
 * The Brand's number format, with `trim_trailing_zeros` pinned on for v3.
 *
 * `23.00` for a count of twenty-three resources reads as though something was measured to
 * two decimals; the estate has twenty-three. So a fraction that is all zeros is dropped
 * and a trailing zero inside one removed — `23.00` → `23`, `23.10` → `23.1`, `23.15`
 * unchanged.
 *
 * Written **into the version** rather than switched on in the renderer, and that is the
 * whole point. `run_verify_report` recompiles a stored report and requires a
 * byte-identical figure ledger, `formatted` strings included, so a formatter that changed
 * behaviour globally would fail re-verification for every report already delivered — on
 * documents nothing is wrong with. A version that does not declare the key renders the way
 * it always did; one saved from here declares it and says so.
 *
 * v3 only, because that is the only schema version whose `number_format` admits the key.
 * A v1 or v2 definition keeps the Brand's format unchanged rather than being handed a
 * field its own validator would reject.
 */
function numberFormatFor(
  definition: Record<string, unknown>,
  brand: Brand
): Record<string, unknown> {
  const format = (brand.numberFormat ?? {}) as Record<string, unknown>
  if (definition["schema_version"] !== 3) return format
  return { ...format, trim_trailing_zeros: true }
}

export function resolveDesignFromBrand(
  definition: unknown,
  brand: Brand
): unknown {
  if (typeof definition !== "object" || definition === null) return definition

  const def = definition as Record<string, unknown>

  return {
    ...def,
    design: {
      preset: brand.themePreset,
      accent_color: brand.accentColor,
      density: brand.density,
      table_style: brand.tableStyle,
      number_format: numberFormatFor(def, brand),
      cover_page: brand.coverPage,
      logo: brand.logoKey,
      page_size: brand.pageSize,
    },
  }
}

/**
 * The definition with the Brand's confidentiality notice written into
 * `front_matter.document_control.confidentiality_notice`.
 *
 * Requirement 12.7 makes the notice Brand-owned and not editable per profile, and names
 * the Brand as where it is edited. Something still has to do the inheriting, and this is
 * it — the same seam and the same reason as {@link resolveDesignFromBrand}: a saved
 * version carries the notice inline, so editing the Brand tomorrow does not change the
 * wording on a report somebody signed today.
 *
 * **The profile wins.** The notice began Brand-owned, on Requirement 12.7's reading that
 * one consultancy issues one notice; a profile is a per-customer engagement and the
 * wording is negotiated per engagement, so the wizard authors it now and this resolve is
 * a **fallback**: it fills in the Brand's notice only for a profile that declares none.
 * That is what keeps a notice already typed on the Brand working after the move, without
 * making it override the one a profile author wrote.
 *
 * A profile and a Brand that both declare nothing leave the key absent rather than an
 * empty string, so the document control page prints no confidentiality section at all.
 * An empty heading over nothing is worse than no heading.
 */
export function resolveNoticeFromBrand(
  definition: unknown,
  brand: Brand
): unknown {
  if (typeof definition !== "object" || definition === null) return definition

  const def = definition as Record<string, unknown>
  const front = def["front_matter"]
  const frontMatter = (
    front !== null && typeof front === "object" ? front : {}
  ) as Record<string, unknown>
  const control = frontMatter["document_control"]
  const documentControl = (
    control !== null && typeof control === "object" ? control : {}
  ) as Record<string, unknown>

  const authored = documentControl["confidentiality_notice"]
  const notice =
    typeof authored === "string" && authored.trim() !== ""
      ? authored
      : brand.confidentialityNotice

  const resolved = { ...documentControl }
  if (typeof notice === "string" && notice.trim() !== "") {
    resolved["confidentiality_notice"] = notice
  } else {
    delete resolved["confidentiality_notice"]
  }

  return {
    ...def,
    front_matter: { ...frontMatter, document_control: resolved },
  }
}
