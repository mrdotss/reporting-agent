import { createHash } from "node:crypto"

import {
  canonicalJsonString,
  type CanonicalizableValue,
} from "@/lib/templates/canonical-json"
import type { TemplateDefinition } from "@/lib/templates/definition"

/**
 * `definition_sha256` — the content address of a template definition
 * (Requirement 9.4).
 *
 * One construction, stated once: **RFC 8785 (JCS) canonical form → UTF-8 bytes
 * → SHA-256 → 64 lowercase hexadecimal characters.** The same construction the
 * snapshot uses for `snapshot_id`, for the same reason: two machines that agree
 * on the definition must agree on its id, so the id cannot depend on key
 * insertion order, on whitespace, or on which of two JSON serializers ran.
 *
 * ## Why this module owns the digest and not the canonicalization
 *
 * `lib/templates/canonical-json.ts` stays its own module rather than being
 * absorbed here, and that is a layering decision rather than inertia.
 * `definition.ts` already depends on it for Requirement 2.10's byte-size bound
 * — the bound is expressed *in the canonical form*, so the schema has to be
 * able to measure that form. Absorbing the canonicalizer into this module would
 * invert the dependency into `definition.ts → version.ts`, which is backwards:
 * a digest is computed over a definition that has already validated, so
 * `version.ts` depending on `definition.ts` (for the type alone, below) is the
 * direction that matches the pipeline. Keeping canonicalization in a third,
 * leaf module lets both depend on it and neither depend on the other.
 *
 * The practical consequence is the one that matters for the Mirror_Guard (task
 * 5.2): the bytes `definition.ts` counts and the bytes this module hashes come
 * out of the *same* function call, so a definition that passes the 262,144-byte
 * bound is a definition whose canonical form was actually measured, and a
 * canonicalization disagreement with the agent shows up as a digest mismatch on
 * every fixture rather than as a size bound that quietly disagrees at the
 * boundary.
 *
 * ## Synchronous, via `node:crypto` — and what that costs
 *
 * There are two ways to hash here and they are not equivalent:
 *
 *   * **`node:crypto`'s `createHash`** — synchronous, Node-only. Matches the
 *     two existing SHA-256 sites in this codebase byte for byte in style
 *     (`lib/auth/session.ts`'s session-token hash, `lib/session-id.ts`'s
 *     namespaced derivation), both of which are `createHash("sha256")
 *     .update(…, "utf8").digest("hex")`.
 *   * **Web Crypto's `crypto.subtle.digest`** — asynchronous, universal, so the
 *     digest would also be computable in the browser.
 *
 * This module takes the synchronous one, because nothing in this spec asks for
 * a client-side digest and a synchronous value is strictly more usable in the
 * places that do ask for one:
 *
 *   * Requirement 9.4 assigns the computation to the Template_Version_Store,
 *     and Requirement 9.5's "digest equals the highest existing version's"
 *     comparison happens there too — `POST /api/templates/[id]`, server-side,
 *     with the row already in hand. `lib/templates/store.ts`'s
 *     `insertVersion` takes `definitionSha256` as an **already-computed
 *     input**, so the caller is a route handler either way.
 *   * Requirement 9.9's display of a pinned `definition_sha256` reads a stored
 *     column; it does not recompute one.
 *   * Requirement 11.3's client-side validation preview runs the
 *     `Template_Validator`, not the digest — and `definition.ts` is
 *     deliberately not `server-only` precisely so that preview works. This
 *     module is not in that path.
 *   * The Mirror_Guard compares the app's digest against the agent's for every
 *     fixture in the shared corpus. A synchronous expression keeps that a plain
 *     per-fixture comparison rather than an awaited one.
 *
 * The cost is honest and bounded: importing `node:crypto` makes this module
 * unusable from a client component. If a client-side digest is ever needed, the
 * part that is hard to get right and that the Mirror_Guard actually protects —
 * the canonicalization — is **already** universal (`canonical-json.ts` uses
 * `TextEncoder`, not `Buffer`), so a Web Crypto twin would be a three-line
 * `crypto.subtle.digest` over `canonicalJsonString`'s output and would agree
 * with this function by construction.
 *
 * ## No `import "server-only"`
 *
 * Deliberate, and consistent with `lib/session-id.ts`, which also hashes with
 * `node:crypto` and also declines the marker. This module opens no connection,
 * reads no environment variable and holds no secret — it is a pure function
 * from a value to a hex string. In this codebase the marker means "this module
 * has business with a secret or a connection" (`lib/crypto.ts`, `lib/db/*`,
 * `lib/auth/*`, `lib/aws/*`), and `test/boundaries.static.test.ts` obliges it
 * for exactly the imports that imply one. Applying it here would overstate what
 * the module is. The `node:crypto` import already makes a client import a build
 * error, so the protective effect is present without the false claim.
 *
 * ## Two things this module must never do
 *
 * **It mutates nothing.** The canonicalizer reads; it never sorts a caller's
 * array or reassigns a key. A digest function that reordered the object it was
 * handed would leave the caller holding a different value than it passed in,
 * and Property 11 asserts the input is deep-equal to a pre-call clone.
 *
 * **It applies no Unicode normalization.** There is no `.normalize()` anywhere
 * in this module or in `canonical-json.ts`, and there must not be. RFC 8785 is
 * explicit that JCS does not normalize, and it matters here beyond
 * standards-compliance: `"é"` as U+00E9 and as `"e" + U+0301` are two different
 * strings, and a definition carrying one is a different definition from one
 * carrying the other. Normalizing would make two genuinely distinct
 * definitions share an id — the same content-address collapsed onto one row —
 * and would put this implementation into disagreement with the agent's, which
 * does not normalize either.
 */

/**
 * A definition, or any value the canonicalizer can represent.
 *
 * The union is needed because {@link TemplateDefinition} is **not** structurally
 * assignable to {@link CanonicalizableValue}: a block's `config` is typed
 * `Readonly<Record<string, unknown>>` (the per-type config schemas live in
 * `blocks.ts`, so `definition.ts` deliberately does not restate them in the
 * top-level type), and `unknown` admits values with no canonical form. The
 * static type therefore cannot promise canonicalizability, and the honest
 * control is the runtime one: `canonicalJsonString` raises
 * `NotCanonicalizableError` for anything it cannot represent rather than
 * approximating it.
 */
export type DigestibleDefinition = TemplateDefinition | CanonicalizableValue

/**
 * The RFC 8785 canonical form of `definition`, as a string.
 *
 * Re-exported through this module — rather than leaving every caller to reach
 * into `canonical-json.ts` — so "the form the digest is taken over" has one
 * name at the layer that owns the digest. A caller writing a fixture, a
 * Mirror_Guard comparison, or a debugging log wants the exact bytes this
 * module hashes, and getting them from anywhere else is how two canonical
 * forms come to exist.
 */
export function canonicalDefinitionJson(
  definition: DigestibleDefinition
): string {
  return canonicalJsonString(definition as CanonicalizableValue)
}

/**
 * `definition_sha256` — SHA-256 over the UTF-8 bytes of `definition`'s RFC 8785
 * canonical form, as exactly 64 lowercase hexadecimal characters (Requirement
 * 9.4).
 *
 * Pure: no mutation of `definition`, no clock, no I/O, no normalization.
 * Deterministic for equal content regardless of key insertion order, and
 * different for any difference in any key spelling or any value — including a
 * difference that is only a Unicode normalization form.
 *
 * Raises `NotCanonicalizableError` (from `canonical-json.ts`) for a value with
 * no canonical form. That is deliberate: a definition reaching this function
 * has already passed the `Template_Validator`, so an unrepresentable value here
 * means the two disagree, and returning a plausible-looking digest for it would
 * mint a content address over bytes nothing else in the system would reproduce.
 *
 * `digest("hex")` is lowercase hex by definition in Node, and the length is
 * fixed by SHA-256's 32-byte output. Both facts are asserted by Property 11
 * rather than assumed, because they are what Requirement 9.4 states and what
 * the `definition_sha256` column's shape depends on.
 */
export function definitionSha256(definition: DigestibleDefinition): string {
  return createHash("sha256")
    .update(canonicalDefinitionJson(definition), "utf8")
    .digest("hex")
}
