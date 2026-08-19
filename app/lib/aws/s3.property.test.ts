import fc from "fast-check"
import { describe, expect, test } from "vitest"

import {
  ARTIFACT_SEGMENT_PREVIEWS,
  DOWNLOADABLE_SEGMENTS,
  keyBelongsToActor,
  parseArtifactKey,
  previewBelongsToActor,
} from "@/lib/aws/s3"

/**
 * **Property 12: Artifact-key authorization is an exact segment match**
 *
 * Validates: Requirements 43.2, 43.3, 40.5, 40.6, 45.1
 *
 * ## What this is placed to kill
 *
 * Three plausible implementations, each of which passes a hand-written test
 * suite and each of which is a real authorization bypass:
 *
 * - **`key.startsWith(actorId)`** authorizes `alice-evil/reports/r/x` for
 *   `alice`. This is the one that is easiest to write and hardest to notice: it
 *   is correct for every key an honest client sends.
 * - **`key.startsWith(actorId + "/")`** fixes that and still admits any second
 *   segment, so `alice/previews/…` and `alice/anything/…` become downloadable
 *   through the report path.
 * - **a case-folding comparison** admits `alice/Reports/r/x`, and S3 keys are
 *   case-sensitive — so that is a different object, which may be one nobody
 *   authorized.
 *
 * The generators below are shaped around those three. The actor alphabet
 * includes `-`, `_` and `.` because those are the characters that make one id a
 * proper prefix of another, and the id pairs are generated *so that* one is a
 * prefix of the other rather than hoping a random draw produces the case.
 *
 * ## Declared examples
 *
 * Carried as fast-check `examples` on the properties themselves rather than as
 * separate `test()` blocks, which is what makes them **run inside** the property
 * — unshrunk, first, on every execution — and what
 * `test/property-hygiene.static.test.ts`'s ratchet counts.
 *
 * Four of them: the three the task names, plus `Alice/reports/…`. That fourth
 * one exists because mutation-testing found the other three do not kill a
 * case-folding **actor** comparison — each differs in the segment or in the
 * prefix rather than in the id's case alone, so the mutant survived all of them.
 */

/** Requirement 42.8's committed cases for the prefix property. */
const PREFIX_EXAMPLES: [readonly [string, string], string, string, string][] = [
  // `startsWith(actorId)` authorizes this. Exact segment equality does not.
  [["alice", "alice-evil"], "reports", "r", "x"],
]

/** The case-folding cases, including the one the declared three miss. */
const CASE_EXAMPLES: [string, string, string][] = [
  ["alice", "reports", "r"],
  ["Alice", "reports", "r"],
]

/** Segment and arity cases. */
const SEGMENT_EXAMPLES: [string, string, string][] = [
  // A second segment outside the two.
  ["alice", "Reports", "r"],
]

/** `-`, `_` and `.` are what make one id a proper prefix of another. */
const actorId = fc
  .stringMatching(/^[A-Za-z0-9_.-]{1,24}$/)
  .filter((value) => value.length > 0)

/** A pair where the first is a **proper prefix** of the second. */
const prefixPair = fc
  .tuple(actorId, fc.stringMatching(/^[A-Za-z0-9_.-]{1,8}$/))
  .filter(([, suffix]) => suffix.length > 0)
  .map(([base, suffix]) => [base, `${base}${suffix}`] as const)

const segment = fc.stringMatching(/^[A-Za-z0-9_.-]{0,12}$/)

/**
 * An actor id carrying **at least one cased character**, by construction.
 *
 * The case property needs an id that recases to something different, and `1234`
 * recases to itself — asserting a refusal for that would be asserting that an
 * actor cannot reach its own key. The obvious spelling is `actorId` plus an
 * `fc.pre(recased !== id)`, and that is what this was.
 *
 * It flaked. `actorId` generates from 64 characters of which 12 are uncased, and
 * fast-check biases hard toward short strings, so the rejection rate sat at
 * roughly 20% — right on the tolerance, passing or aborting with "too many
 * pre-condition failures" depending on the seed. One run in eight failed.
 *
 * Constructing the guarantee instead of filtering for it takes the rejection
 * rate to zero, which is also what Requirement 42.6 wants of every property: a
 * precondition that discards a fifth of its inputs is a property testing rather
 * less than it claims to. The letter is placed at a generated position rather
 * than at the front so the cased character is not always the first one.
 */
const casedActorId = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9_.-]{0,11}$/),
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    fc.stringMatching(/^[A-Za-z0-9_.-]{0,12}$/)
  )
  .map(([head, letter, tail]) => `${head}${letter}${tail}`)

describe("Property 12 — the declared examples", () => {
  test("actor `alice` against `alice-evil/reports/r/x`", () => {
    // `startsWith(actorId)` returns true here. Exact segment equality does not.
    expect(keyBelongsToActor("alice", "alice-evil/reports/r/x")).toBe(false)
  })

  test("actor `alice` against `alice/Reports/r/x`", () => {
    // The *segment* is what is refused here — `Reports` is not one of the two
    // downloadable values. Worth keeping as its own case, and worth being clear
    // that it does **not** exercise the actor comparison: the case below does.
    expect(keyBelongsToActor("alice", "alice/Reports/r/x")).toBe(false)
  })

  test("actor `alice` against `Alice/reports/r/x`", () => {
    // The case that actually kills a case-folding **actor** comparison, and the
    // one the three declared examples miss. Mutation-testing found this gap:
    // replacing the comparison with `toLowerCase()` on both sides left the other
    // ten assertions green, because every one of them differed in the segment or
    // in the prefix rather than in the actor id's case alone.
    //
    // S3 keys are case-sensitive, so `Alice/…` is a different object under a
    // different prefix, and it may be one nobody authorized.
    expect(keyBelongsToActor("alice", "Alice/reports/r/x")).toBe(false)
    expect(keyBelongsToActor("Alice", "alice/reports/r/x")).toBe(false)
  })

  test("actor `alice` against `alice/reports`", () => {
    // Fewer than the declared segments. A key that names no run and no leaf is
    // not a key to an artifact.
    expect(keyBelongsToActor("alice", "alice/reports")).toBe(false)
  })
})

describe("Property 12 — no id admits a key under a different first segment", () => {
  test("a proper prefix of an actor id is never authorized for it", () => {
    fc.assert(
      fc.property(
        prefixPair,
        fc.constantFrom(...DOWNLOADABLE_SEGMENTS),
        segment,
        segment,
        ([shorter, longer], downloadable, runId, leaf) => {
          const key = `${longer}/${downloadable}/${runId}/${leaf}`

          // The shorter id must not reach the longer id's key. This is the
          // `startsWith` bug, generated rather than hoped for.
          expect(keyBelongsToActor(shorter, key)).toBe(false)
        }
      ),
      { numRuns: 200, examples: PREFIX_EXAMPLES }
    )
  })

  test("an actor id differing only in case is never authorized", () => {
    // The generated form of the declared example above, over `casedActorId` —
    // see its comment for why this does not filter.
    fc.assert(
      fc.property(
        casedActorId,
        fc.constantFrom(...DOWNLOADABLE_SEGMENTS),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
        (id, downloadable, runId) => {
          const recased =
            id === id.toLowerCase() ? id.toUpperCase() : id.toLowerCase()

          // The old precondition, as an assertion. If the generator ever stops
          // guaranteeing a cased character this fails loudly instead of quietly
          // skipping — which is the difference between a property that shrank
          // and a property that reported it.
          expect(recased).not.toBe(id)

          expect(
            keyBelongsToActor(id, `${recased}/${downloadable}/${runId}/leaf`)
          ).toBe(false)
        }
      ),
      { numRuns: 300, examples: CASE_EXAMPLES }
    )
  })

  test("an actor is authorized for its own well-formed key", () => {
    // The other direction, so the property above cannot be satisfied by a
    // function that returns `false` for everything.
    fc.assert(
      fc.property(
        actorId,
        fc.constantFrom(...DOWNLOADABLE_SEGMENTS),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
        fc.stringMatching(/^[A-Za-z0-9_.-]{1,16}$/),
        (id, downloadable, runId, leaf) => {
          expect(
            keyBelongsToActor(id, `${id}/${downloadable}/${runId}/${leaf}`)
          ).toBe(true)
        }
      ),
      { numRuns: 200 }
    )
  })
})

describe("Property 12 — the second segment is one of exactly two", () => {
  test("any second segment outside the downloadable set is refused", () => {
    fc.assert(
      fc.property(
        actorId,
        segment,
        fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
        (id, second, runId) => {
          fc.pre(!DOWNLOADABLE_SEGMENTS.has(second))

          expect(
            keyBelongsToActor(id, `${id}/${second}/${runId}/x`),
            second
          ).toBe(false)
          expect(
            parseArtifactKey(`${id}/${second}/${runId}/x`),
            second
          ).toBeNull()
        }
      ),
      { numRuns: 300, examples: SEGMENT_EXAMPLES }
    )
  })

  test("`previews` in particular is refused by the report path", () => {
    // Requirement 43.3 stated as its own case rather than left to the generator:
    // this is the segment the product actually writes, so it is the one a future
    // widening would plausibly add.
    fc.assert(
      fc.property(
        actorId,
        fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
        (id, pv) => {
          const key = `${id}/${ARTIFACT_SEGMENT_PREVIEWS}/${pv}/preview.pdf`

          expect(keyBelongsToActor(id, key)).toBe(false)
          expect(parseArtifactKey(key)).toBeNull()

          // And the preview predicate admits it, so the two key spaces are
          // genuinely disjoint rather than both closed.
          expect(previewBelongsToActor(id, key)).toBe(true)
        }
      ),
      { numRuns: 200 }
    )
  })
})

describe("Property 12 — malformed keys are refused rather than parsed", () => {
  test("a key with the wrong segment count never authorizes", () => {
    fc.assert(
      fc.property(
        actorId,
        fc.array(segment, { minLength: 0, maxLength: 8 }),
        (id, segments) => {
          const key = [id, ...segments].join("/")

          // Only the four-segment shape can be authorized, so anything else is
          // refused whatever it contains.
          if (segments.length === 3) return

          expect(keyBelongsToActor(id, key)).toBe(false)
        }
      ),
      // `alice/reports` — a key naming no run and no leaf.
      { numRuns: 300, examples: [["alice", ["reports"]] as [string, string[]]] }
    )
  })

  test("an empty segment anywhere refuses", () => {
    fc.assert(
      fc.property(
        actorId,
        fc.constantFrom(...DOWNLOADABLE_SEGMENTS),
        fc.nat({ max: 3 }),
        (id, downloadable, position) => {
          const segments = [id, downloadable, "run", "leaf"]
          segments[position] = ""

          expect(keyBelongsToActor(id, segments.join("/"))).toBe(false)
        }
      ),
      { numRuns: 200 }
    )
  })

  test("a leading or trailing slash refuses", () => {
    fc.assert(
      fc.property(
        actorId,
        fc.constantFrom(...DOWNLOADABLE_SEGMENTS),
        (id, downloadable) => {
          expect(keyBelongsToActor(id, `/${id}/${downloadable}/run/leaf`)).toBe(
            false
          )
          expect(keyBelongsToActor(id, `${id}/${downloadable}/run/leaf/`)).toBe(
            false
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  test("an empty actor id admits nothing", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (key) => {
        expect(keyBelongsToActor("", key)).toBe(false)
      }),
      { numRuns: 200 }
    )
  })
})
