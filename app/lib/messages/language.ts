/**
 * The two declared languages, mirroring the agent's `DECLARED_LANGUAGES`
 * (Requirements 15.2, 15.10).
 *
 * Separate from `catalog.ts` on purpose: that file's declaration sits between
 * sentinel comments and the mirror guard reads the block between them, so
 * anything else living there would either be inside the mirrored region — where
 * the guard would compare it against the agent's message ids and fail — or force
 * the guard to skip lines, which is how a sentinel block stops being a reliable
 * delimiter.
 *
 * A language is a **template setting**, pinned on the template version a run
 * rendered, so an archived report presents the copy it was delivered with rather
 * than whatever is current. That is why this is a closed set and not a string:
 * adding a third language is a decision with a cost — every id in both halves
 * needs a value in it before the mirror guard can pass — and a partially
 * translated third language is exactly the state the no-fallback rule refuses to
 * paper over.
 */

// --- BEGIN LANGUAGES (mirrored in agent/src/reporting_agent/messages/__init__.py) ---
export const LANGUAGES = ["en", "id"] as const
// --- END LANGUAGES ---

/** One of the two declared languages. */
export type Language = (typeof LANGUAGES)[number]

/**
 * The language a template pins when it declares none.
 *
 * `en`, matching the agent's `DEFAULT_LANGUAGE`. A `schema_version` 1 definition
 * carries no `identity.language`, and every one of those was authored and
 * reviewed in English — so this is what those templates were always rendering,
 * stated rather than implied.
 */
export const DEFAULT_LANGUAGE = "en" satisfies Language

const DECLARED: ReadonlySet<string> = new Set<string>(LANGUAGES)

/** Is this one of the two declared languages? */
export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && DECLARED.has(value)
}
