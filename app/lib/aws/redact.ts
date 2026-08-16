import "server-only"

/**
 * The browser-facing redaction pass (Requirement 15.6).
 *
 * Every event the app relays to a browser goes through `redactForBrowser`,
 * which **removes** — not masks — every field named `client_secret`,
 * `progress_token`, `tenant_id` or `client_id`, in either snake_case or
 * camelCase, compared case-insensitively, at every depth of objects and arrays.
 *
 * Two decisions worth stating, because a plausible implementation gets both
 * wrong:
 *
 * **Removed, not masked.** A masked field still tells the browser the field was
 * there and still has to be carried through every cache and every log along the
 * way. The browser has no use for any of these four values — the customer's
 * credentials are resolved server-side at invoke time, and `progress_token`
 * authorizes writes to the run state machine, so a leak lets someone mark a run
 * `completed`. It is a credential, not a correlation id.
 *
 * **At every depth, by name, on both casings.** The agent already scrubs secret
 * *values* through its own egress, so this pass is the app's independent,
 * structural half: it does not need to know what a secret looks like, only what
 * it is called. A top-level, snake_case-only filter passes a hand-written test
 * and leaks `{ context: { clientSecret } }`.
 *
 * `server-only` because this is part of the relay's server boundary — the point
 * is that redaction happens *before* anything crosses to the client, so the
 * module that performs it must not itself be importable from a client
 * component.
 */

/**
 * The redacted field names, lowercased, in both casings (Requirement 15.6).
 *
 * Lowercasing the candidate key and looking it up here is the whole comparison,
 * so `Client_Secret`, `CLIENTSECRET` and `progressToken` all match. Matching is
 * on the **whole** name: a field genuinely called `client_id_hash` is not a
 * credential and is not silently dropped.
 */
const REDACTED_FIELD_NAMES: ReadonlySet<string> = new Set([
  "client_secret",
  "clientsecret",
  "progress_token",
  "progresstoken",
  "tenant_id",
  "tenantid",
  "client_id",
  "clientid",
])

/** Does this field name name one of the four redacted fields? */
export function isRedactedFieldName(name: string): boolean {
  return REDACTED_FIELD_NAMES.has(name.toLowerCase())
}

/**
 * A plain object — one whose prototype is `Object.prototype` or `null`.
 *
 * Only arrays and plain objects are descended into. A `Date`, a `Map` or a class
 * instance is passed through untouched, because rebuilding one field-by-field
 * would quietly turn it into `{}`. Events arrive from `JSON.parse`, so plain
 * objects and arrays are the only containers that occur in practice; this keeps
 * the pass honest if one day something else is handed to it.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/**
 * A copy of `value` with every redacted field removed at every depth.
 *
 * The input is never mutated: the caller may still need the unredacted event
 * for a server-side log line that its own redaction handles.
 *
 * `seen` maps each container already visited to its redacted copy, so a shared
 * or cyclic reference is redacted once and cannot recurse forever.
 */
function redact(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) {
    const cached = seen.get(value)
    if (cached !== undefined) return cached

    const copy: unknown[] = []
    seen.set(value, copy)
    for (const element of value) copy.push(redact(element, seen))
    return copy
  }

  if (isPlainObject(value)) {
    const cached = seen.get(value)
    if (cached !== undefined) return cached

    const copy: Record<string, unknown> = {}
    seen.set(value, copy)
    for (const [key, nested] of Object.entries(value)) {
      if (isRedactedFieldName(key)) continue
      copy[key] = redact(nested, seen)
    }
    return copy
  }

  return value
}

/**
 * Strip every `client_secret`, `progress_token`, `tenant_id` and `client_id`
 * field, in either casing, at every depth, before an event reaches the browser
 * (Requirement 15.6).
 */
export function redactForBrowser(value: unknown): unknown {
  return redact(value, new WeakMap<object, unknown>())
}
