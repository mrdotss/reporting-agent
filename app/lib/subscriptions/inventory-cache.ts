import "server-only"

/**
 * The inventory cache: one listing per connected subscription, for 300 seconds
 * (Requirement 9.2).
 *
 * A module-level `Map` in the server process, and nothing more. It exists because
 * the listing behind it costs a container invocation and an Azure Resource Graph
 * query, and the template wizard's three pickers ask for it on every step change —
 * so the same question arrives several times a minute while its answer cannot have
 * moved.
 *
 * ## Keyed on the row id alone
 *
 * Not on the row id plus the user id, and not on the Azure subscription GUID. The
 * row id is already unique per user — `connected_subscriptions.id` is the primary
 * key — so adding the user id to the key would protect nothing, and the ownership
 * check happens **before** this cache is consulted anyway (Requirement 9.2). The
 * Azure GUID would be worse than redundant: two consultants may legitimately
 * connect the same customer subscription with their own service principals, and
 * their principals may hold different scopes, so one key would serve one
 * consultant the list the other's role assignment produced.
 *
 * ## Two independent reasons an entry stops being a hit
 *
 * **Age.** The entry records the instant its query *completed*, and is a hit for
 * {@link INVENTORY_CACHE_TTL_MS} after that instant. Not the instant the request
 * arrived: a listing that took twenty seconds is twenty seconds stale the moment it
 * is stored, and starting the clock at the request would hand out an entry for
 * longer than the requirement allows.
 *
 * **A write to the row.** The entry also records the row's `updated_at` as it was
 * when the listing was stored, and a current value differing from it is a miss.
 * That is what makes a rotated credential or a changed status list the subscription
 * again rather than serve the answer the previous credential produced — and it is a
 * comparison against a column the handler has already loaded, rather than a
 * publish/subscribe problem between the request that writes and the one that
 * cached.
 *
 * Both directions of the comparison are a miss, not just "newer". A row whose
 * `updated_at` moved *backwards* is a row this process cannot explain, and serving
 * a listing against it would be trusting an explanation nobody has.
 *
 * ## What this module deliberately is not
 *
 * It is not shared between processes, and it does not need to be. A second server
 * process holds its own map, asks its own question and gets its own answer; the
 * only cost of a cold map is one extra invocation. Nothing here is authoritative —
 * every entry is reconstructible from the runtime — so there is no consistency
 * problem to solve, which is exactly why a `Map` is the right size of mechanism.
 *
 * It also holds **no credential and no identifier**. The payload is the four lists
 * of distinct strings the pickers present; the key is a row id. A memory dump of
 * this map names no subscription GUID, no tenant, no client and no secret.
 */

// --- The payload ------------------------------------------------------------

/**
 * One dimension of an inventory listing.
 *
 * `truncated` travels **with** the values rather than as a flag beside them,
 * because a truncated list and a complete one look identical: 2000 resource groups
 * with `truncated: false` is a subscription with 2000 resource groups, and the same
 * array with `truncated: true` is a subscription with an unknown number more. A
 * picker that could not tell them apart would present "these are the options" for a
 * list that is not.
 */
export type InventoryDimension = {
  readonly values: readonly string[]
  readonly truncated: boolean
}

/**
 * The four dimensions one listing answers with.
 *
 * Snake-cased because these are the keys the runtime merges into its `done` event,
 * and this type is that wire shape after parsing. Renaming them to camel case here
 * would mean two spellings of one contract and a translation layer whose only job
 * is to keep them in step.
 *
 * All four are required. A listing that did not answer carries **no dimension key
 * at all** — the runtime's contract is explicit about that, and it is the reason
 * this type has no optional members: four empty dimensions is the claim that the
 * subscription holds nothing, which is precisely the answer the endpoint must never
 * present as a result.
 */
export type InventoryDimensions = {
  readonly resource_types: InventoryDimension
  readonly resource_groups: InventoryDimension
  readonly tag_keys: InventoryDimension
  readonly tag_values: InventoryDimension
}

/**
 * The four keys, as a value, so "are all four present" is one loop rather than four
 * hand-written checks that can fall out of step with the type above.
 */
export const INVENTORY_DIMENSION_KEYS = [
  "resource_types",
  "resource_groups",
  "tag_keys",
  "tag_values",
] as const satisfies readonly (keyof InventoryDimensions)[]

// --- The cache --------------------------------------------------------------

/** Requirement 9.2 — 300 seconds from the instant the query completed. */
export const INVENTORY_CACHE_TTL_MS = 300_000

type CacheEntry = {
  /** `Date.now()` when the listing **completed**. */
  readonly at: number
  /** The row's `updated_at`, ISO 8601 UTC, as observed when this was stored. */
  readonly rowUpdatedAt: string
  readonly payload: InventoryDimensions
}

const entries = new Map<string, CacheEntry>()

/**
 * The cached listing for `rowId`, or `undefined` for a miss.
 *
 * `now` is a parameter rather than a `Date.now()` call inside, so the boundary is
 * testable at the millisecond instead of by waiting five minutes. Every caller in
 * production passes `Date.now()`.
 *
 * The age comparison is inclusive at the bound: an entry exactly
 * {@link INVENTORY_CACHE_TTL_MS} old is still a hit, and one millisecond older is
 * not. The requirement says a hit *for* 300 seconds and a miss *thereafter*, and
 * this is that sentence read literally — the choice is stated because the
 * alternative is equally defensible and a reader should not have to guess which one
 * the code took.
 */
export function readInventoryCache(
  rowId: string,
  rowUpdatedAt: string,
  now: number
): InventoryDimensions | undefined {
  const entry = entries.get(rowId)
  if (entry === undefined) return undefined

  const age = now - entry.at
  if (age < 0 || age > INVENTORY_CACHE_TTL_MS) return undefined

  // Requirement 9.2 — the row has been written since this listing was stored, so
  // the credential or the status behind it may not be the one that produced it.
  if (entry.rowUpdatedAt !== rowUpdatedAt) return undefined

  return entry.payload
}

/**
 * Store one completed listing.
 *
 * `now` is the instant the listing **completed**, which is what the age bound is
 * measured from. Callers hold a single `Date.now()` for the write so the stored
 * instant and the row's observed `updated_at` describe the same moment.
 *
 * The payload and its four arrays are frozen. A caller that later mutated the
 * object it handed over would be editing what every subsequent request receives,
 * and a frozen structure makes that a `TypeError` at the mutation rather than a
 * wrong list three requests later. The route builds this object from the runtime's
 * answer and keeps no reference to it, so freezing takes nothing away.
 *
 * There is no eviction and no size bound, deliberately: an entry is at most four
 * arrays of 2000 short strings, keyed by a row id, and the set of keys is bounded
 * by the connected subscriptions this process has actually been asked about. An LRU
 * here would be a second policy to reason about in exchange for nothing.
 */
export function writeInventoryCache(
  rowId: string,
  rowUpdatedAt: string,
  payload: InventoryDimensions,
  now: number
): void {
  for (const key of INVENTORY_DIMENSION_KEYS) {
    Object.freeze(payload[key].values)
    Object.freeze(payload[key])
  }

  entries.set(rowId, {
    at: now,
    rowUpdatedAt,
    payload: Object.freeze(payload),
  })
}

/**
 * Drop every entry.
 *
 * For tests, which share one module instance across a file: an entry written by one
 * case would otherwise be a hit in the next, and the case that asserts a miss would
 * pass or fail depending on which order Vitest ran them in.
 */
export function clearInventoryCache(): void {
  entries.clear()
}

/**
 * How many entries the map holds.
 *
 * The only way to assert that a failed listing wrote **no** entry
 * (Requirement 9.8). Asserting through {@link readInventoryCache} could not
 * distinguish "nothing was stored" from "something was stored and is already a
 * miss", and those are different bugs.
 */
export function inventoryCacheEntryCount(): number {
  return entries.size
}
