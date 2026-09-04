import {
  LANGUAGES,
  MAX_SUPPORTED_SCHEMA_VERSION,
  MIN_SCHEMA_VERSION,
  SEPARATOR_DEFAULTS,
} from "@/lib/templates/definition"

/**
 * Bringing a stored `schema_version` 1 definition up to 2 (Requirement 13.12).
 *
 * **Pure.** {@link toSchemaVersion2} takes a definition and returns a definition. It takes no
 * store, performs no write, reads no clock and reads no environment — which is what lets the
 * wizard apply it on **open**, before anything has been saved, and lets the save path stay
 * exactly what it was.
 *
 * ## One direction, app-only, and that asymmetry is the design
 *
 * There is no `toSchemaVersion1`, and the agent has no migration at all. Both follow from one
 * rule the templates spec already made: **a template version is immutable once used**
 * (criterion 9.3), and an archived report stays reproducible from its pinned version plus its
 * snapshot. So:
 *
 * * **The agent must go on compiling version 1 for ever** (Requirement 13.11). It is handed a
 *   pinned definition and emits the document that definition described —
 *   `lib/templates/starters.ts` alone carries five `cover` blocks in stored version-1
 *   definitions, and every report ever rendered from one has to keep rendering the same way.
 *   Migrating on the agent's side would rewrite history at render time.
 * * **The app migrates on open, never in place.** Nothing here touches the stored row. The
 *   consultant sees a version-2 draft, and a *save* writes a **new** version row
 *   (`lib/templates/store.ts::insertVersion` only ever inserts) — so the earlier version, and
 *   every report pinned to it, is left exactly as delivered.
 *
 * Read together: the app moves forward and the agent never moves at all. A downgrade would be
 * the one operation that could make a pinned version render differently, so it does not exist.
 *
 * ## What raises the version, and therefore what this function does
 *
 * Exactly three things separate version 1 from version 2 (`definition.ts`'s schema-version
 * tables): `front_matter`, `identity.language`, and the two `number_format` separators. So the
 * migration is exactly four edits, and there is nothing else to decide:
 *
 * 1. lift the `cover` block's config into `front_matter.cover`, and **remove that block**;
 * 2. set `identity.language` to `en`;
 * 3. write the two separators `en` resolves to;
 * 4. set `schema_version` to `2`.
 *
 * Each of the four is checked by the validator afterwards, and none of them is a default this
 * module invents: `en` is `LANGUAGES[0]`, and the separators come from `SEPARATOR_DEFAULTS`.
 */

/** The version this module migrates from, and the one it migrates to.
 *
 * The target is 2 (not MAX_SUPPORTED_SCHEMA_VERSION) because no automatic
 * v2→v3 lift exists yet — the sections restructure is an author-driven step
 * in the wizard, not a code migration. A `lib/profiles/lift.ts` explored one and
 * was deleted unused: nothing in the app ever called it.
 */
export const MIGRATION_SOURCE_VERSION = MIN_SCHEMA_VERSION
export const MIGRATION_TARGET_VERSION = 2 as const

/**
 * The language a migrated definition declares.
 *
 * `LANGUAGES[0]`, read rather than written, because it is also the language whose separators a
 * definition declaring none resolves to (`resolveSeparators`). A migrated v1 definition
 * therefore renders with the pair it has always rendered with — which is the whole point of
 * choosing it rather than the customer's locale. Guessing `id` here would silently reformat
 * every number in every existing template.
 */
export const MIGRATION_LANGUAGE = LANGUAGES[0]

/** The block type whose config becomes `front_matter.cover`. */
const COVER_BLOCK_TYPE = "cover"

/**
 * The cover fields `front_matter.cover` admits, mirrored from `definition.ts`'s own
 * `COVER_ALLOWED_KEYS` by value.
 *
 * Declared here rather than imported because that constant is module-private in
 * `definition.ts` and exporting it would widen that module's surface for one caller. The
 * agreement is asserted in `migrate.test.ts` against the validator's behaviour rather than
 * against the constant — a migrated definition the validator rejects is the failure that
 * matters, and it catches a drift in either direction.
 */
const COVER_FIELDS = ["logo", "contact_block", "subtitle"] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Whether `definition` **declares** the source version, as a literal.
 *
 * Deliberately not `definition.ts`'s `resolveSchemaVersion`, which is module-private and, more
 * to the point, *coerces*: an absent or unusable `schema_version` resolves to
 * {@link MIGRATION_SOURCE_VERSION} there, because a validator reading an unusable version has
 * to pick the narrower key set in order to report the rest of the definition's problems
 * against something.
 *
 * That is right for a validator and wrong for a rewriter. Coercing here would mean a row
 * carrying `schema_version: "two"`, or none at all, gets silently rewritten into a v2
 * definition — a migration of something nobody has established is a v1 definition. So this
 * migrates what says it is version 1 and leaves everything else to the validator, which names
 * the field.
 */
function declaresSourceVersion(definition: Record<string, unknown>): boolean {
  return definition.schema_version === MIGRATION_SOURCE_VERSION
}

/** A shallow copy, or an empty object for anything that is not one. */
function objectAt(
  source: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = source[key]
  return isPlainObject(value) ? { ...value } : {}
}

function isCoverBlock(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && value.type === COVER_BLOCK_TYPE
}

/**
 * Every block in document order, **descending one level into a row**.
 *
 * A `row` block holds its children in `columns`, as an array of arrays, and nesting is one
 * level deep by the layout grammar — so this walk is two loops rather than a recursion.
 *
 * Descending is not optional. A `cover` block **inside a row** is accepted at version 1 and
 * rejected at version 2 like any other, so a migration that only looked at the top level would
 * hand the wizard a definition the validator refuses at `blocks.0.columns.0.0.type` — the
 * consultant opens a template and cannot save it. The shipped starters happen to put their
 * covers at the top level, which is exactly why this was worth finding with a hand-built case
 * rather than trusting the corpus.
 */
function everyBlock(blocks: readonly unknown[]): readonly unknown[] {
  const found: unknown[] = []
  for (const block of blocks) {
    found.push(block)
    if (!isPlainObject(block) || !Array.isArray(block.columns)) continue
    for (const column of block.columns) {
      if (Array.isArray(column)) found.push(...column)
    }
  }
  return found
}

/**
 * The first `cover` block anywhere in `blocks`, or `undefined`.
 *
 * The **first** in document order. The validator's own rules make a second one unlikely in a
 * definition that ever validated, but this runs against stored rows, so "first" is a stated
 * choice rather than an assumption — and every cover is removed either way, so a definition
 * with two lifts the first and drops both. That is the same cover the renderer already emitted
 * for it, since the front matter emits one.
 */
function findCoverBlock(
  blocks: readonly unknown[]
): Record<string, unknown> | undefined {
  return everyBlock(blocks).find(isCoverBlock)
}

/** `blocks` with every `cover` block removed, at the top level and inside every row. */
function withoutCoverBlocks(blocks: readonly unknown[]): unknown[] {
  return blocks
    .filter((block) => !isCoverBlock(block))
    .map((block) => {
      if (!isPlainObject(block) || !Array.isArray(block.columns)) return block
      return {
        ...block,
        columns: block.columns.map((column) =>
          Array.isArray(column)
            ? column.filter((child) => !isCoverBlock(child))
            : column
        ),
      }
    })
}

/**
 * `front_matter.cover` from a `cover` block's config.
 *
 * Only the fields the front-matter cover admits, so a config field the block schema allowed
 * and the section does not is **dropped rather than carried**: carrying it would produce a
 * definition the validator rejects as an unrecognized cover field, which would turn opening a
 * v1 template into an unsaveable draft. The block's `subtitle` is the one field the two
 * shapes share today.
 *
 * `undefined` values are omitted rather than written, so "absent" stays absent — the same rule
 * `resolveSeparators` relies on, one level up.
 */
function coverSectionFrom(
  block: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (block === undefined) return {}

  const config = isPlainObject(block.config) ? block.config : {}
  const section: Record<string, unknown> = {}
  for (const field of COVER_FIELDS) {
    if (config[field] !== undefined) section[field] = config[field]
  }
  return section
}

/**
 * `definition` as a `schema_version` 2 definition (Requirement 13.12).
 *
 * Returns a **new** object and mutates nothing reachable from the argument, so a caller can
 * hand it a stored row and keep using that row afterwards. That is not a nicety: the edit page
 * resolves the draft and the latest version's definition together, and a migration that
 * mutated in place would edit the object the page also renders the template's *stored* state
 * from.
 *
 * A definition that is **already** version 2 or above is returned unchanged, by identity. A
 * caller cannot always tell — the wizard opens whatever the row holds — and re-running the
 * migration over a v2 definition would overwrite a declared `identity.language` with `en`,
 * which is the one edit that would silently change how an Indonesian template formats every
 * number in it.
 *
 * Anything that is not an object is returned unchanged too. This module does not validate;
 * `collectDefinitionIssues` does, immediately afterwards, and a migration that threw on a
 * malformed row would replace a list of field paths a consultant can act on with a stack
 * trace.
 */
export function toSchemaVersion2<T>(definition: T): T {
  if (!isPlainObject(definition)) return definition
  if (!declaresSourceVersion(definition)) return definition

  const blocks = Array.isArray(definition.blocks) ? definition.blocks : []
  const cover = findCoverBlock(blocks)

  const frontMatter = objectAt(definition, "front_matter")
  // The three sections are required at version 2, and every field *inside* each is optional —
  // so three objects, two of them empty, is a complete front matter rather than a placeholder.
  const migratedFrontMatter: Record<string, unknown> = {
    cover: { ...coverSectionFrom(cover), ...objectAt(frontMatter, "cover") },
    document_control: objectAt(frontMatter, "document_control"),
    toc: objectAt(frontMatter, "toc"),
  }

  const design = objectAt(definition, "design")
  const numberFormat = objectAt(design, "number_format")
  const separators = SEPARATOR_DEFAULTS[MIGRATION_LANGUAGE]

  return {
    ...definition,
    schema_version: MIGRATION_TARGET_VERSION,
    identity: {
      ...objectAt(definition, "identity"),
      language: MIGRATION_LANGUAGE,
    },
    // The cover block is **gone**, not merely ignored, and gone from inside a row too.
    // Requirement 13.2 rejects a definition placing a `cover` block in `blocks` at version 2
    // or above, and leaving one would also emit the cover twice — once from the section and
    // once from the block.
    blocks: withoutCoverBlocks(blocks),
    front_matter: migratedFrontMatter,
    design: {
      ...design,
      number_format: {
        ...numberFormat,
        // Written explicitly rather than left absent. Both spellings resolve to the same pair
        // today, and only the declared one survives a later edit to `SEPARATOR_DEFAULTS` — a
        // migrated template should keep rendering as it did, not follow a default that moved.
        decimal_separator: separators.decimal_separator,
        grouping_separator: separators.grouping_separator,
      },
    },
  } as unknown as T
}

/**
 * Whether `definition` is a version-1 definition this module would change.
 *
 * Exported for the wizard, which shows the consultant that opening this template will raise
 * its version — and for tests, which need to assert the migration is a no-op on a v2
 * definition without inferring that from the output.
 */
export function needsSchemaVersion2Migration(definition: unknown): boolean {
  return isPlainObject(definition) && declaresSourceVersion(definition)
}
