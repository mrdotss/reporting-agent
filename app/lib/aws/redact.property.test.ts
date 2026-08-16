import { describe, expect, test } from "vitest"
import fc from "fast-check"

import { redactForBrowser } from "@/lib/aws/redact"

/**
 * Property 5, web half — the relay carries no `client_secret`, `progress_token`,
 * `tenant_id` or `client_id` field, in any casing, at any depth.
 *
 * **Validates: Requirements 15.6, 42.1**
 * (The agent half — the secret *value* registry, the logging filter and the
 * exception scrub — is `agent/tests/property/test_redaction_property.py`.)
 *
 * This is the app's independent, structural half of the guard. It does not know
 * what a secret looks like, only what one is called, which is why the generated
 * input space is spellings and depths rather than values. Two implementations
 * pass a hand-written test and fail here:
 *
 * - **A top-level filter.** `delete event.client_secret` leaves
 *   `{ context: { client_secret } }` intact, and every event that carries a
 *   credential carries it nested inside `context`.
 * - **A snake_case-only filter.** The four names are declared in snake_case in
 *   the invoke payload, so a `Set` of exactly those four strings looks complete.
 *   Anything that has been through a camelCase mapper — or a hand-written object
 *   literal — spells it `clientSecret`, and `Set.has` says no.
 *
 * **The oracle is a second construction, not a re-implementation.** Each case
 * generates a *spec*, and the spec builds both the event to relay and the event
 * that must come back. Asserting `toEqual` between them states the whole
 * requirement at once: the named field is gone, and nothing else moved.
 */

/** Requirement 15.6 names exactly these four, in snake_case. */
const BASE_NAMES = [
  "client_secret",
  "progress_token",
  "tenant_id",
  "client_id",
] as const

/**
 * Field names that are *not* credentials and must survive at every level.
 * `client_id_hash` and `progress_total` are the near misses: a filter matching
 * on `startsWith` or `includes` rather than on the whole name drops both.
 */
const KEEPER_NAMES = [
  "client_id_hash",
  "progress_total",
  "subscription_id",
] as const

type Container = "object" | "array"

interface Spec {
  /** The redacted field's name, in the casing under test. */
  readonly fieldName: string
  /** A secret-shaped value, long enough that finding it later is not coincidence. */
  readonly value: string
  /** One entry per nesting level, outermost first. Length 1–4 (Requirement 15.6). */
  readonly containers: readonly Container[]
}

function toCamelCase(snakeCase: string): string {
  return snakeCase.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase()
  )
}

/**
 * One of the four names, spelled snake_case or camelCase, then with each letter
 * independently upper- or lower-cased.
 *
 * The per-character mask is what produces the "any mixture of upper-case and
 * lower-case letters" of Requirement 15.6 — `Client_Secret`, `CLIENTSECRET`,
 * `pRoGrEsStOkEn`. `toUpperCase` on `_` is `_`, so the underscore survives the
 * mask and the two spellings stay distinct.
 */
const fieldNameArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...BASE_NAMES),
    fc.boolean(),
    fc.array(fc.boolean(), { minLength: 16, maxLength: 16 })
  )
  .map(([baseName, useCamelCase, mask]) => {
    const spelling = useCamelCase ? toCamelCase(baseName) : baseName
    return Array.from(spelling, (character, index) =>
      mask[index % mask.length]
        ? character.toUpperCase()
        : character.toLowerCase()
    ).join("")
  })

const specArbitrary: fc.Arbitrary<Spec> = fc.record({
  fieldName: fieldNameArbitrary,
  value: fc.string({ minLength: 8, maxLength: 64 }),
  containers: fc.array(fc.constantFrom<Container>("object", "array"), {
    minLength: 1,
    maxLength: 4,
  }),
})

/**
 * Build the nest from the inside out.
 *
 * Every level carries the redacted field, so a pass that descends one level and
 * stops fails as surely as one that never descends. An array level carries it
 * inside a single-key element object, because an array has no field names of its
 * own — that element is the "field inside an array" case, and `redacted` decides
 * whether it comes back as `{}` or as `{ [fieldName]: value }`.
 *
 * `redacted: false` builds the event to relay; `redacted: true` builds what must
 * come back.
 */
function buildNest(spec: Spec, redacted: boolean): unknown {
  let node: unknown = { note: "innermost", keep_depth: 0 }

  const levels = [...spec.containers].reverse()
  levels.forEach((container, index) => {
    const level = index + 1

    if (container === "object") {
      node = {
        [`keep_${level}`]: level,
        ...(redacted ? {} : { [spec.fieldName]: spec.value }),
        nested: node,
      }
      return
    }

    node = [
      `keep-${level}`,
      redacted ? {} : { [spec.fieldName]: spec.value },
      node,
    ]
  })

  return node
}

function buildEvent(spec: Spec, redacted: boolean): Record<string, unknown> {
  return {
    type: "error",
    run_id: "run-1",
    terminal: true,
    retry_after: null,
    ...(redacted ? {} : { [spec.fieldName]: spec.value }),
    ...Object.fromEntries(KEEPER_NAMES.map((name) => [name, `${name}-value`])),
    context: buildNest(spec, redacted),
  }
}

/**
 * Declared cases, retained per Requirement 42.8 and chosen for what each kills.
 *
 * fast-check draws declared examples from the same budget as generated ones — the
 * examples are yielded first and at most `numRuns` values are taken — so every
 * property below declares `numRuns: 100 + EXAMPLES.length` to keep at least 100
 * *generated* cases (Requirement 42.1) with the declared ones on top.
 */
const EXAMPLES: [Spec][] = [
  // camelCase at depth 4, all objects: the spelling and the depth that a
  // top-level snake_case filter misses together.
  [
    {
      fieldName: "clientSecret",
      value: "not-a-real-secret-value",
      containers: ["object", "object", "object", "object"],
    },
  ],
  // snake_case at depth 4, all arrays: a pass that walks objects but not arrays
  // relays the field untouched.
  [
    {
      fieldName: "progress_token",
      value: "not-a-real-progress-token",
      containers: ["array", "array", "array", "array"],
    },
  ],
  // Depth 1, upper-case snake: the shallowest case, and the one a
  // case-sensitive comparison misses.
  [
    {
      fieldName: "TENANT_ID",
      value: "11111111-1111-1111-1111-111111111111",
      containers: ["object"],
    },
  ],
  // A mixture of casings across an alternating nest.
  [
    {
      fieldName: "CliEnT_Id",
      value: "22222222-2222-2222-2222-222222222222",
      containers: ["object", "array", "object", "array"],
    },
  ],
  // camelCase with no underscore left to match on, inside arrays only.
  [
    {
      fieldName: "TenantId",
      value: "33333333-3333-3333-3333-333333333333",
      containers: ["array", "object"],
    },
  ],
]

const NUM_RUNS = 100 + EXAMPLES.length

/** Every key at every depth, so an assertion can be made about all of them. */
function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const element of value) collectKeys(element, into)
    return into
  }

  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      into.push(key)
      collectKeys(nested, into)
    }
  }

  return into
}

describe("Requirement 15.6 — no redacted field survives the relay", () => {
  test("the relayed event equals the same event built without that field", () => {
    fc.assert(
      fc.property(specArbitrary, (spec) => {
        const event = buildEvent(spec, false)

        expect(redactForBrowser(event)).toEqual(buildEvent(spec, true))
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })

  test("no key anywhere in the relayed event names one of the four", () => {
    fc.assert(
      fc.property(specArbitrary, (spec) => {
        const relayed = redactForBrowser(buildEvent(spec, false))

        // Independent of the module's own predicate: normalize away casing and
        // underscores and compare against the four names. Sound here because the
        // generator only produces spellings Requirement 15.6 covers — snake_case,
        // camelCase and case mixtures of either.
        const normalized = new Set(
          BASE_NAMES.map((name) => name.replaceAll("_", ""))
        )

        for (const key of collectKeys(relayed)) {
          expect(normalized.has(key.toLowerCase().replaceAll("_", ""))).toBe(
            false
          )
        }
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })

  test("the value the field carried appears nowhere in the relayed event", () => {
    fc.assert(
      fc.property(specArbitrary, (spec) => {
        const relayed = redactForBrowser(buildEvent(spec, false))

        // The field is *removed*, not masked, so the value is gone from the
        // serialized payload too — nothing downstream can log or cache it.
        expect(JSON.stringify(relayed)).not.toContain(
          JSON.stringify(spec.value)
        )
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })

  test("every field that is not one of the four survives at every depth", () => {
    fc.assert(
      fc.property(specArbitrary, (spec) => {
        const relayed = redactForBrowser(buildEvent(spec, false))
        const keys = collectKeys(relayed)

        // The near misses: `client_id_hash` and `progress_total` are dropped by a
        // filter that matches on a prefix or a substring instead of a whole name.
        for (const name of KEEPER_NAMES) {
          expect(keys).toContain(name)
        }

        // One `keep_n` or `keep-n` marker per object level, so the walk reached
        // every level rather than stopping at the first.
        const objectLevels = spec.containers.filter(
          (container) => container === "object"
        ).length
        for (let level = 1; level <= spec.containers.length; level += 1) {
          const isObjectLevel =
            [...spec.containers].reverse()[level - 1] === "object"
          if (isObjectLevel) expect(keys).toContain(`keep_${level}`)
        }
        expect(keys.filter((key) => key.startsWith("keep_")).length).toBe(
          objectLevels + 1 // + the innermost node's own keep_depth
        )
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })

  test("the event handed in is not mutated", () => {
    fc.assert(
      fc.property(specArbitrary, (spec) => {
        const event = buildEvent(spec, false)

        redactForBrowser(event)

        // The unredacted event is still needed on the server: the relay logs
        // through the agent's own scrub, which reads the original.
        expect(event).toEqual(buildEvent(spec, false))
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })
})
