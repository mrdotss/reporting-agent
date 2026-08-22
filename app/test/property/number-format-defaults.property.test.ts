import fc from "fast-check"
import { describe, expect, test } from "vitest"

import {
  LANGUAGES,
  MAX_DECIMAL_PLACES,
  MIN_DECIMAL_PLACES,
  NUMBER_FORMAT_KEYS,
  SEPARATOR_DEFAULTS,
  collectDefinitionIssues,
  resolveSeparators,
} from "@/lib/templates/definition"

/**
 * **Property 9: the number-format defaults are language-derived and never overwrite a
 * declaration.** Identifier `number_format_defaults`.
 *
 * **Validates: Requirements 16.2, 16.3, 16.10, 45.1, 45.3, 45.4**
 *
 * *For any* definition at either schema version, in either declared language or none, with
 * separators declared on neither field, one field or both: every **absent** field resolves to
 * its language's default, every **declared** field survives byte-identically, and the character
 * constraints are checked against the **resolved** pair rather than the declared one.
 *
 * ## The oracle, and why there is one
 *
 * The resolution is four lines long, so a property that recomputed it the same way would
 * assert nothing. The oracle here is {@link SEPARATOR_DEFAULTS} read **by language**, indexed
 * directly rather than through the function under test — which is what separates the three
 * failures this property exists to catch:
 *
 * - **A default applied over a declared value.** Silently rewrites a consultant's choice, and
 *   every validator assertion still passes because the substituted value is a legal separator.
 *   Only a comparison against the value the definition *declared* sees it.
 * - **`en`'s defaults applied to an `id` definition.** The failure Requirement 16 exists to
 *   close: `1.234,56` renders as `1,234.56` for an Indonesian customer. A property generating
 *   one language would not notice, and one that resolved through the same table the
 *   implementation reads would agree with it whichever table that was.
 * - **The constraints checked *before* the defaults.** Accepts a definition whose **resolved**
 *   pair is equal — `id` plus a declared decimal `.` collides with the grouping `.` the
 *   language supplies — and the document then renders `1.234.56`, where a reader cannot tell
 *   the grouping separator from the decimal point. This is the one case where "what the
 *   definition says" and "what the renderer will emit" differ, and it is the only case the
 *   whole resolved-pair design exists for.
 *
 * ## Why the validator is called and not only the resolver
 *
 * `resolveSeparators` is exported and pure, so three of the assertions below could read it
 * alone. They do not, because Requirement 16.2's constraints live in the **validator** and the
 * requirement is about the pair the validator checks. A property that only exercised the
 * resolver would pass against a validator that resolved separately, or not at all — which is
 * exactly the shape of the third failure above.
 */

type Language = (typeof LANGUAGES)[number]

/** A separator that is legal for both fields, so a pair drawn from it can only fail by being equal. */
const LEGAL_SEPARATORS = [".", ",", "'", "\u00b7", "\u066b", "_", "|"] as const

/**
 * Separators the constraints refuse, one per clause of Requirement 16.2: empty, more than one
 * character, a digit, a minus sign, and three spellings of whitespace.
 *
 * `\u00b2` — superscript two — is deliberately **absent**: it is a digit to Python's
 * `str.isdigit()` and not to `/[0-9]/u`, and both halves of the mirror accept it on purpose.
 * Generating it here as an offender would assert the opposite of what the mirror pins.
 */
const ILLEGAL_SEPARATORS = [
  "",
  "..",
  ",,",
  "5",
  "0",
  "-",
  " ",
  "\t",
  "\u00a0",
] as const

const NUMBER_FORMAT_KEY_COUNT = { 1: 2, 2: 4 } as const

/**
 * Three arrays of declared cases, one per property that carries them (Requirement 45.5).
 *
 * `numRuns` is raised by the number of cases each `fc.assert` is handed, because fast-check
 * yields declared examples from the **same** budget as generated ones — 100 generated cases
 * plus five declared ones is `numRuns: 105`, not 100. `test/property-hygiene.static.test.ts`
 * enforces that arithmetic.
 */
const LANGUAGE_EXAMPLES: [Language | undefined][] = [
  // The two languages, and an absent one — every version-1 definition is the third.
  ["en"],
  ["id"],
  [undefined],
]

const RESOLUTION_EXAMPLES: [
  Language | undefined,
  string | undefined,
  string | undefined,
][] = [
  // The two languages with nothing declared: the pair that must differ per language.
  ["en", undefined, undefined],
  ["id", undefined, undefined],
  // An absent language, which resolves from `en` — every version-1 definition.
  [undefined, undefined, undefined],
  // A declared value **equal** to the language default. Indistinguishable from a defaulted one
  // in the resolved pair, which is why the byte-identity assertion reads the definition.
  ["id", ",", undefined],
  // A declared value deliberately different from the language default, on each field alone.
  ["id", ".", undefined],
  ["en", undefined, "."],
]

const COLLISION_EXAMPLES: [Language, string | undefined, string | undefined][] =
  [
    // The case only the resolved pair catches: `id` supplies `.` as the grouping separator, so a
    // declared decimal `.` collides with a value the definition never states.
    ["id", ".", undefined],
    // Its mirror image on the other field, under the other language.
    ["en", undefined, "."],
    // Both declared and equal — the one shape a declared-pair check would also have caught.
    ["en", "'", "'"],
  ]

const VERSION_ONE_EXAMPLES: [string | undefined][] = [
  // A version-1 definition declares no language and no separator, and must resolve to the pair
  // it has always rendered with. `undefined` is the ordinary shape; the two spellings of a
  // *declared* separator are the ones Requirement 16.10 forbids at this version.
  [undefined],
  ["."],
  [","],
]

// --- generators -------------------------------------------------------------

const language = (): fc.Arbitrary<Language | undefined> =>
  fc.constantFrom<Language | undefined>(...LANGUAGES, undefined)

const separator = (): fc.Arbitrary<string | undefined> =>
  fc.oneof(
    fc.constant(undefined),
    fc.constantFrom(...LEGAL_SEPARATORS),
    fc.constantFrom(...ILLEGAL_SEPARATORS)
  )

const legalSeparator = (): fc.Arbitrary<string | undefined> =>
  fc.oneof(fc.constant(undefined), fc.constantFrom(...LEGAL_SEPARATORS))

/**
 * Two **different** legal separators, constructed rather than filtered.
 *
 * `fc.pre(decimal !== grouping)` over a pool of seven would throw away one case in seven,
 * which is a rejection fraction of about 14% — under Requirement 45.4's 20% ceiling on
 * average and over it often enough that the ledger gate failed on some runs and not others.
 * A property that fails for a reason unrelated to the code is worse than no property, so the
 * pair is generated by offsetting an index instead: every ordered distinct pair is reachable
 * and nothing is discarded.
 */
const distinctLegalPair = (): fc.Arbitrary<[string, string]> =>
  fc
    .tuple(
      fc.integer({ min: 0, max: LEGAL_SEPARATORS.length - 1 }),
      fc.integer({ min: 1, max: LEGAL_SEPARATORS.length - 1 })
    )
    .map(([index, offset]) => [
      LEGAL_SEPARATORS[index],
      LEGAL_SEPARATORS[(index + offset) % LEGAL_SEPARATORS.length],
    ])

const decimalPlaces = (): fc.Arbitrary<number> =>
  fc.integer({ min: MIN_DECIMAL_PLACES, max: MAX_DECIMAL_PLACES })

// --- the definition under test ----------------------------------------------

/**
 * A definition at `version`, in `lang`, declaring `decimal` and `grouping` where they are not
 * `undefined`.
 *
 * `undefined` is how "absent" is spelled, not `null`: `JSON.parse` never produces `undefined`,
 * so `key in object` and `object[key] === undefined` agree for a stored definition, and
 * `resolveSeparators` defaults on `=== undefined` alone. A `null` here would be a *declared*
 * value the validator refuses, which is a different case and has its own assertion below.
 */
function definitionWith(
  version: 1 | 2,
  lang: Language | undefined,
  decimal: string | undefined,
  grouping: string | undefined,
  places = 2
): Record<string, unknown> {
  const numberFormat: Record<string, unknown> = {
    decimal_places: places,
    group_thousands: true,
  }
  if (decimal !== undefined) numberFormat.decimal_separator = decimal
  if (grouping !== undefined) numberFormat.grouping_separator = grouping

  const identity: Record<string, unknown> = {
    name: "Number format property",
    report_title: "Number format property",
  }
  if (lang !== undefined) identity.language = lang

  const body: Record<string, unknown> = {
    schema_version: version,
    identity,
    scope: {
      resource_types: ["Microsoft.Compute/virtualMachines"],
      tag_filters: [],
      resource_groups: [],
      top_n: null,
      sort: null,
    },
    period: { kind: "last_full_month" },
    metrics: {
      "Microsoft.Compute/virtualMachines": [
        { metric: "Percentage CPU", statistic: "avg" },
      ],
    },
    blocks: [{ id: "h", type: "heading", config: { level: 1, text: "x" } }],
    design: {
      preset: "editorial",
      accent_color: "#1f6f78",
      density: "normal",
      table_style: "hairline",
      number_format: numberFormat,
      cover_page: true,
      logo: null,
      page_size: "A4",
    },
  }
  if (version === 2) {
    body.front_matter = { cover: {}, document_control: {}, toc: {} }
  }
  return body
}

const NUMBER_FORMAT_PATH = "design.number_format"

function pathsOf(definition: Record<string, unknown>): readonly string[] {
  return collectDefinitionIssues(definition, { mode: "run" })
    .map((issue) => issue.path.join("."))
    .sort()
}

/** Only the issues about the two separators, so an unrelated defect cannot mask one. */
function separatorPaths(
  definition: Record<string, unknown>
): readonly string[] {
  return pathsOf(definition).filter((issue) =>
    issue.startsWith(`${NUMBER_FORMAT_PATH}.`)
  )
}

/** The oracle: the pair `lang` implies, read from the table by language. */
function expectedDefaults(lang: Language | undefined): {
  readonly decimal_separator: string
  readonly grouping_separator: string
} {
  return SEPARATOR_DEFAULTS[lang ?? LANGUAGES[0]]
}

function declaredNumberFormat(
  definition: Record<string, unknown>
): Record<string, unknown> {
  const design = definition.design as Record<string, unknown>
  return design.number_format as Record<string, unknown>
}

// --- the properties ---------------------------------------------------------

describe("Requirement 16.3 — an absent separator resolves from the language", () => {
  test("every absent field takes its language's default and every declared field survives", () => {
    fc.assert(
      fc.property(
        language(),
        legalSeparator(),
        legalSeparator(),
        (lang, decimal, grouping) => {
          const definition = definitionWith(2, lang, decimal, grouping)
          const numberFormat = declaredNumberFormat(definition)
          const resolved = resolveSeparators(numberFormat, lang ?? null)
          const defaults = expectedDefaults(lang)

          // Absent → the language's default, from the table read by language rather than
          // through the function under test.
          if (decimal === undefined) {
            expect(resolved.decimal_separator).toBe(defaults.decimal_separator)
          }
          if (grouping === undefined) {
            expect(resolved.grouping_separator).toBe(
              defaults.grouping_separator
            )
          }

          // Declared → byte-identical, whether or not it equals the default. This is the
          // assertion a resolver applying a default *over* a declaration fails, and it fails
          // only for the pairs where the two differ — which is why both are generated.
          if (decimal !== undefined) {
            expect(resolved.decimal_separator).toBe(decimal)
          }
          if (grouping !== undefined) {
            expect(resolved.grouping_separator).toBe(grouping)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  test("the two languages resolve different pairs, and neither borrows the other's", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Language | undefined>(...LANGUAGES, undefined),
        (lang) => {
          const definition = definitionWith(2, lang, undefined, undefined)
          const resolved = resolveSeparators(
            declaredNumberFormat(definition),
            lang ?? null
          )
          const defaults = expectedDefaults(lang)

          expect(resolved).toEqual({ ...defaults })
          // The pair a language implies is never the other language's pair. Without this an
          // implementation reading `SEPARATOR_DEFAULTS.en` unconditionally would satisfy the
          // equality above for `en` and for an absent language — two of the three cases.
          expect(resolved.decimal_separator).not.toBe(
            resolved.grouping_separator
          )
          const other: Language = lang === "id" ? "en" : "id"
          if (lang === "id") {
            expect(resolved).not.toEqual({ ...SEPARATOR_DEFAULTS[other] })
          }
        }
      ),
      { numRuns: 100 + LANGUAGE_EXAMPLES.length, examples: LANGUAGE_EXAMPLES }
    )
  })

  test("a declared separator is stored unchanged — the definition is not rewritten", () => {
    fc.assert(
      fc.property(
        language(),
        // `separator()` rather than `legalSeparator()`: an **unusable** declared value must
        // survive validation just as an acceptable one does. A validator that repaired what it
        // rejected would report an issue and store a definition the issue no longer describes,
        // which is the one shape of rewriting that looks correct from the issue list alone.
        separator(),
        separator(),
        (lang, decimal, grouping) => {
          const definition = definitionWith(2, lang, decimal, grouping)
          const before = structuredClone(definition)

          collectDefinitionIssues(definition, { mode: "run" })

          // Requirement 16.10 — validation resolves and reports; it never writes. A validator
          // that filled the defaults in would make "absent" and "equal to the default" one
          // stored definition, and migrating one would then rewrite an immutable row.
          expect(definition).toEqual(before)
          const numberFormat = declaredNumberFormat(definition)
          expect("decimal_separator" in numberFormat).toBe(
            decimal !== undefined
          )
          expect("grouping_separator" in numberFormat).toBe(
            grouping !== undefined
          )
        }
      ),
      {
        numRuns: 100 + RESOLUTION_EXAMPLES.length,
        examples: RESOLUTION_EXAMPLES,
      }
    )
  })
})

describe("Requirement 16.2 — the constraints are checked on the resolved pair", () => {
  test("a resolved pair that collides is rejected however few fields were declared", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Language>(...LANGUAGES),
        legalSeparator(),
        legalSeparator(),
        (lang, decimal, grouping) => {
          const definition = definitionWith(2, lang, decimal, grouping)
          const resolved = resolveSeparators(
            declaredNumberFormat(definition),
            lang
          )
          const collides =
            resolved.decimal_separator === resolved.grouping_separator

          // The whole point of resolving before checking. Only one of these two fields may be
          // declared and the pair can still collide, so a validator reading the declared pair
          // accepts it — and the rendered document then carries `1.234.56`.
          expect(
            separatorPaths(definition).length > 0,
            `language=${lang} decimal=${String(decimal)} grouping=${String(grouping)} ` +
              `resolves to ${JSON.stringify(resolved)}`
          ).toBe(collides)
          if (collides) {
            // Reported at a **fixed** field. The collision is one fault about a pair, so there
            // is no single field to blame; a state-dependent location is what the two halves
            // of the mirror would eventually disagree about.
            expect(separatorPaths(definition)).toEqual([
              `${NUMBER_FORMAT_PATH}.decimal_separator`,
            ])
          }
        }
      ),
      { numRuns: 100 + COLLISION_EXAMPLES.length, examples: COLLISION_EXAMPLES }
    )
  })

  test("an unusable declared separator is reported at its own field and never defaulted", () => {
    fc.assert(
      fc.property(
        language(),
        fc.constantFrom(...ILLEGAL_SEPARATORS),
        fc.boolean(),
        (lang, offender, onDecimal) => {
          const definition = onDecimal
            ? definitionWith(2, lang, offender, undefined)
            : definitionWith(2, lang, undefined, offender)
          const field = onDecimal ? "decimal_separator" : "grouping_separator"

          // The key being **present** is what makes a value declared, so an unusable
          // declaration is reported rather than quietly replaced by the language default —
          // which would accept a definition that says one thing and render a document that
          // says another.
          expect(separatorPaths(definition)).toContain(
            `${NUMBER_FORMAT_PATH}.${field}`
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  test("a legal, non-colliding pair is accepted at both versions", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Language>(...LANGUAGES),
        distinctLegalPair(),
        decimalPlaces(),
        fc.constantFrom<1 | 2>(1, 2),
        (lang, [decimal, grouping], places, version) => {
          // Both versions, because the phrase means different things at each: at version 2 the
          // legal non-colliding pair is the **declared** one, and at version 1 neither field is
          // declarable, so it is the pair the absent language resolves to. A version-1
          // definition must go on validating exactly as it always has (Requirement 16.10).
          const definition =
            version === 1
              ? definitionWith(1, undefined, undefined, undefined, places)
              : definitionWith(2, lang, decimal, grouping, places)

          // The positive control every rejection assertion above needs: without it a validator
          // rejecting *every* declared pair would satisfy all of them.
          expect(pathsOf(definition)).toEqual([])
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe("Requirement 16.10 — a version-1 definition renders as it always did", () => {
  test("two number_format keys, no language, and the en pair resolved", () => {
    fc.assert(
      fc.property(decimalPlaces(), fc.boolean(), (places, grouped) => {
        const definition = definitionWith(
          1,
          undefined,
          undefined,
          undefined,
          places
        )
        const numberFormat = declaredNumberFormat(definition)
        numberFormat.group_thousands = grouped

        expect(Object.keys(numberFormat).sort()).toEqual(
          [...NUMBER_FORMAT_KEYS[1]].sort()
        )
        expect(Object.keys(numberFormat)).toHaveLength(
          NUMBER_FORMAT_KEY_COUNT[1]
        )
        expect(pathsOf(definition)).toEqual([])

        // `en`'s pair is the one every stored version-1 definition has always rendered with,
        // and it is reached with no `identity.language` anywhere in the document.
        expect(resolveSeparators(numberFormat, null)).toEqual({
          ...SEPARATOR_DEFAULTS[LANGUAGES[0]],
        })
        expect("language" in (definition.identity as object)).toBe(false)
      }),
      { numRuns: 100 }
    )
  })

  test("a version-1 definition declaring a separator is rejected as an undeclared key", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<string | undefined>(...LEGAL_SEPARATORS, undefined),
        (declared) => {
          const definition = definitionWith(1, undefined, declared, undefined)

          // Requirement 16.1 — two keys at version 1. The refusal is the existing strict
          // undeclared-key check rather than a rule about separators, which is why the path is
          // the field itself and why there is no second message about its characters.
          expect(separatorPaths(definition)).toEqual(
            declared === undefined
              ? []
              : [`${NUMBER_FORMAT_PATH}.decimal_separator`]
          )
        }
      ),
      {
        numRuns: 100 + VERSION_ONE_EXAMPLES.length,
        examples: VERSION_ONE_EXAMPLES,
      }
    )
  })

  test("the version-2 key set is the version-1 set plus exactly the two separators", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const one = new Set<string>(NUMBER_FORMAT_KEYS[1])
        const two = new Set<string>(NUMBER_FORMAT_KEYS[2])

        expect(one.size).toBe(NUMBER_FORMAT_KEY_COUNT[1])
        expect(two.size).toBe(NUMBER_FORMAT_KEY_COUNT[2])
        for (const key of one) expect(two.has(key)).toBe(true)
        expect([...two].filter((key) => !one.has(key)).sort()).toEqual([
          "decimal_separator",
          "grouping_separator",
        ])
      }),
      { numRuns: 100 }
    )
  })
})
