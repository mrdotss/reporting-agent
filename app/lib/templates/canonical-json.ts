/**
 * A minimal RFC 8785 (JCS) canonicalizer, scoped to the values a template
 * definition can actually contain.
 *
 * **Why this exists here, ahead of `lib/templates/version.ts` (task 3.4).**
 * `definition.ts`'s size bound (Requirement 2.10: "no more than 262,144 bytes
 * of UTF-8 in its RFC 8785 canonical form") cannot be checked against
 * `JSON.stringify` — that would measure a *different* form than the one the
 * bound names, and a definition sitting right at the boundary could pass this
 * schema's check and then fail `version.ts`'s canonicalization at save time
 * for a form the wizard was never actually measured against. Rather than
 * invent a second, throwaway canonicalizer inline in `definition.ts` and have
 * task 3.4 reconcile two implementations later, this module is the one
 * canonicalization primitive — task 3.4 is expected to depend on this file
 * (or absorb it) rather than duplicate it.
 *
 * **Deliberately narrower than a general JCS library.** A template definition,
 * after this schema parses it, contains only strings, finite integers,
 * booleans, `null`, plain objects and arrays — no key a definition ever
 * carries needs astral-plane sorting edge cases or ECMA-262's fractional
 * number-to-string algorithm, because `decimal_places`, `schema_version` and
 * every other numeric field in the definition schema is an integer. This
 * canonicalizer raises on a non-finite number, a `bigint`, a function, a
 * `Date`, `undefined` inside an array or any other value a definition cannot
 * legitimately contain, rather than silently approximating RFC 8785 for input
 * shapes this product never produces.
 *
 * **Object keys sort by Unicode code point, not by UTF-16 code unit** — the
 * detail RFC 8785 requires and a naive `Array.prototype.sort()` gets wrong
 * for astral-plane keys (a surrogate pair compares differently as two UTF-16
 * code units than as one code point above U+FFFF). No key any definition
 * declares is astral-plane, but the comparator is written to be correct
 * regardless, because "correct except for inputs we don't expect" is exactly
 * the kind of gap a digest-based bound should not carry.
 */

const MAX_SAFE_CANONICAL_INTEGER = Number.MAX_SAFE_INTEGER

/** Every value shape this canonicalizer accepts. */
export type CanonicalizableValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalizableValue[]
  | { readonly [key: string]: CanonicalizableValue }

/** Thrown by {@link canonicalJsonString} for a value this canonicalizer cannot represent. */
export class NotCanonicalizableError extends Error {
  constructor(reason: string, path: string) {
    super(`Cannot canonicalize the value at "${path || "$"}": ${reason}`)
    this.name = "NotCanonicalizableError"
  }
}

/**
 * Unicode-code-point comparison, so object keys sort the way RFC 8785
 * requires rather than the way `Array.prototype.sort()`'s default UTF-16
 * comparison would for a key above the Basic Multilingual Plane.
 */
function compareByCodePoint(a: string, b: string): number {
  const aPoints = Array.from(a, (char) => char.codePointAt(0) ?? 0)
  const bPoints = Array.from(b, (char) => char.codePointAt(0) ?? 0)
  const length = Math.min(aPoints.length, bPoints.length)

  for (let i = 0; i < length; i += 1) {
    const diff = (aPoints[i] ?? 0) - (bPoints[i] ?? 0)
    if (diff !== 0) return diff
  }

  return aPoints.length - bPoints.length
}

/**
 * A JSON string literal, escaped the way `JSON.stringify` already escapes a
 * plain string — control characters, `"` and `\` — which agrees with RFC
 * 8785 for every string a template definition can carry (no definition field
 * accepts a value requiring the standard's non-ASCII escaping rules, since
 * this canonicalizer never escapes a non-ASCII character, matching RFC 8785's
 * requirement that only the character actually present be escaped).
 */
function canonicalString(value: string): string {
  return JSON.stringify(value)
}

function canonicalize(value: CanonicalizableValue, path: string): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string") return canonicalString(value)

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new NotCanonicalizableError("a non-finite number has no canonical form", path)
    }
    if (!Number.isInteger(value)) {
      throw new NotCanonicalizableError(
        "a fractional number is outside the shapes a template definition carries",
        path
      )
    }
    if (Math.abs(value) > MAX_SAFE_CANONICAL_INTEGER) {
      throw new NotCanonicalizableError(
        "an integer outside the safe-integer range has no canonicalization this module implements",
        path
      )
    }
    return String(value)
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => {
      if (item === undefined) {
        throw new NotCanonicalizableError("an array may not contain `undefined`", `${path}[${index}]`)
      }
      return canonicalize(item as CanonicalizableValue, `${path}[${index}]`)
    })
    return `[${items.join(",")}]`
  }

  if (typeof value === "object") {
    const keys = Object.keys(value).sort(compareByCodePoint)
    const members = keys.map((key) => {
      const member = (value as Record<string, CanonicalizableValue>)[key]
      if (member === undefined) {
        throw new NotCanonicalizableError(
          `key "${key}" carries \`undefined\`, which JCS cannot represent`,
          path === "" ? key : `${path}.${key}`
        )
      }
      return `${canonicalString(key)}:${canonicalize(member, path === "" ? key : `${path}.${key}`)}`
    })
    return `{${members.join(",")}}`
  }

  throw new NotCanonicalizableError(`unsupported value type "${typeof value}"`, path)
}

/**
 * The RFC 8785 (JCS) canonical form of `value`, as a string.
 *
 * Pure: no mutation of `value`, no clock, no I/O. Throws
 * {@link NotCanonicalizableError} rather than approximating a value this
 * module was not written to represent — silently falling back to
 * `JSON.stringify` for an unsupported shape would produce a canonical-looking
 * string that is not actually canonical, which is worse than refusing.
 */
export function canonicalJsonString(value: CanonicalizableValue): string {
  return canonicalize(value, "")
}

/**
 * The UTF-8 byte length of {@link canonicalJsonString}'s output, for a bound
 * expressed in bytes (Requirement 2.10) rather than in characters.
 *
 * `TextEncoder` rather than `Buffer.byteLength`, so this module has no
 * Node-specific dependency and stays usable from a client-side check (the
 * wizard previews this same bound before submitting) as well as from a
 * server route.
 */
export function canonicalJsonByteLength(value: CanonicalizableValue): number {
  return new TextEncoder().encode(canonicalJsonString(value)).length
}
