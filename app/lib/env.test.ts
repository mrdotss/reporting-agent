import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  getEnv,
  MissingEnvError,
  REQUIRED_ENV_VARS,
  requireEnv,
  type RequiredEnvVar,
} from "@/lib/env"

/**
 * `lib/env.ts` — Requirements 5.2, 5.3, 5.8 and 5.9.
 *
 * Every test here mutates `process.env`, so the file snapshots the environment
 * before each test and restores it after: the node project runs files in
 * parallel and reuses a worker across files, and a leaked `DATABASE_URL` is the
 * kind of state that makes an unrelated suite pass or fail for no visible
 * reason.
 *
 * Nothing here reads a real `.env`. Vitest does not load one into
 * `process.env`, and depending on that either way would make these tests a
 * property of the developer's machine.
 */

/**
 * Every required variable set to a value nothing would mistake for a real
 * credential, and distinctive enough to search a message for
 * (Requirement 5.3).
 *
 * Typed as `Record<RequiredEnvVar, string>` rather than restated as a list, so
 * adding a variable to `REQUIRED_ENV_VARS` fails the typecheck here instead of
 * silently leaving it uncovered.
 */
const PRESENT_VALUES: Record<RequiredEnvVar, string> = {
  DATABASE_URL: "postgres://fake-user:fake-pass@localhost:5432/fake-db",
  APP_ENCRYPTION_KEY: "fake-encryption-key-8fbc41",
  AWS_REGION: "fake-region-3d90ab",
  RPT_RUNTIME_ARN: "fake-runtime-arn-77e1c2",
  RPT_ARTIFACT_BUCKET: "fake-artifact-bucket-9ac0d5",
  RPT_HISTORY_TABLE: "fake-history-table-1be7f4",
  RPT_TITLE_MODEL_ID: "fake-title-model-6da238",
  RPT_CRON_SECRET: "fake-cron-secret-0c53e9",
  RPT_APP_BASE_URL: "https://fake-app-host-4f21ba.invalid",
}

/**
 * A whitespace-only value that is still recognisable in a haystack. Every
 * character is trimmable, so `requireEnv` must reject it (Requirement 5.2),
 * while the run of em and en spaces appears in no error message this module
 * composes — which is what makes "the sentinel is absent" a real assertion
 * rather than a coincidence (Requirement 5.3).
 */
const WHITESPACE_SENTINEL = "\u2003\u2002\u2003\u2002\u2003"

/** Requirement 5.2 — none of these is a usable value. */
const BLANK_VALUES = [
  "",
  " ",
  "\t",
  "\n",
  "\r\n",
  "\t\t",
  "\n\n",
  " \t\r\n ",
  WHITESPACE_SENTINEL,
] as const

const FLAVOURS = ["absent", "blank"] as const

type Flavour = (typeof FLAVOURS)[number]

/**
 * Pairs of positions in `REQUIRED_ENV_VARS` whose declared order disagrees
 * with every plausible `process.env` key order — insertion order, because
 * `applyRequiredEnv` inserts in reverse, and case-insensitive alphabetical,
 * because that is what Windows reports. `APP_ENCRYPTION_KEY` sorts before
 * `DATABASE_URL` and `RPT_CRON_SECRET` before `RPT_RUNTIME_ARN`, while both are
 * declared the other way round.
 *
 * So an implementation that walked the environment's own keys instead of the
 * declared tuple would name the wrong variable here (Requirement 5.8), rather
 * than passing because the two orders happened to agree.
 */
const MISSING_PAIRS = [
  [0, 1],
  [3, 7],
] as const

const ORDER_CASES = MISSING_PAIRS.flatMap(([earlierIndex, laterIndex]) =>
  FLAVOURS.map((flavour) => ({
    earlier: REQUIRED_ENV_VARS[earlierIndex],
    later: REQUIRED_ENV_VARS[laterIndex],
    flavour,
  }))
)

const BLANK_ORDER_CASES = ORDER_CASES.filter(
  ({ flavour }) => flavour === "blank"
)

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function clearRequiredEnv(): void {
  for (const name of REQUIRED_ENV_VARS) delete process.env[name]
}

/**
 * Populate the required set, leaving `missing` either absent or blank.
 *
 * Assigns in **reverse** declared order so the environment's own key order
 * disagrees with the declared one on Linux too, where `Object.keys(process.env)`
 * follows insertion.
 */
function applyRequiredEnv(
  missing: readonly RequiredEnvVar[] = [],
  flavour: Flavour = "absent"
): void {
  clearRequiredEnv()

  for (const name of [...REQUIRED_ENV_VARS].reverse()) {
    if (missing.includes(name)) {
      if (flavour === "blank") process.env[name] = WHITESPACE_SENTINEL
      continue
    }
    process.env[name] = PRESENT_VALUES[name]
  }
}

/** The required variables in the order the environment itself reports them. */
function requiredKeysInEnvOrder(): readonly string[] {
  const required: readonly string[] = REQUIRED_ENV_VARS
  return Object.keys(process.env).filter((key) => required.includes(key))
}

/**
 * Run `call`, assert it threw `MissingEnvError`, and hand the error back for
 * assertions on its name, its field and its message.
 */
function missingEnvErrorFrom(call: () => unknown): MissingEnvError {
  try {
    call()
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(MissingEnvError)
    if (thrown instanceof MissingEnvError) return thrown
    throw thrown
  }

  throw new Error("expected MissingEnvError, but the call returned")
}

describe("Requirement 5.2 — absent, empty and whitespace-only all fail", () => {
  test("an absent variable is rejected", () => {
    applyRequiredEnv([REQUIRED_ENV_VARS[0]])

    const error = missingEnvErrorFrom(() => requireEnv(REQUIRED_ENV_VARS[0]))

    expect(error.variableName).toBe(REQUIRED_ENV_VARS[0])
  })

  test.each(BLANK_VALUES)("%j is rejected", (blank) => {
    // Tabs and newlines are the interesting ones: a `.env` line with nothing
    // after the `=`, and a value that is a stray whitespace run, are the same
    // deployment mistake as an unset variable, and none of the three is a
    // usable connection string or key.
    applyRequiredEnv()
    process.env[REQUIRED_ENV_VARS[0]] = blank

    const error = missingEnvErrorFrom(() => requireEnv(REQUIRED_ENV_VARS[0]))

    expect(error.variableName).toBe(REQUIRED_ENV_VARS[0])
  })

  test("a value carrying whitespace around real content is returned verbatim", () => {
    // The reject is a validity gate, not a normalization step: the boundary is
    // "trims to nothing", and a value with content survives untouched.
    applyRequiredEnv()
    process.env[REQUIRED_ENV_VARS[0]] = "  padded-value-5f1c  "

    expect(requireEnv(REQUIRED_ENV_VARS[0])).toBe("  padded-value-5f1c  ")
  })
})

describe("Requirement 5.3 — the error names the variable, never its value", () => {
  test("it is a MissingEnvError carrying the variable name", () => {
    const name = REQUIRED_ENV_VARS[2]
    applyRequiredEnv([name], "blank")

    const error = missingEnvErrorFrom(() => requireEnv(name))

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("MissingEnvError")
    expect(error.variableName).toBe(name)
    expect(error.message).toContain(name)
  })

  test.each(REQUIRED_ENV_VARS)(
    "%s's own value is absent from the message",
    (name) => {
      applyRequiredEnv([name], "blank")

      const error = missingEnvErrorFrom(() => requireEnv(name))
      const rendered = `${error.message}\n${String(error)}`

      expect(rendered).toContain(name)
      expect(rendered).not.toContain(WHITESPACE_SENTINEL)
      for (const character of new Set(WHITESPACE_SENTINEL)) {
        expect(rendered).not.toContain(character)
      }
    }
  )

  test("no other required variable's value reaches the message either", () => {
    // Half of this set is a credential, so the assertion is over the whole
    // environment the call could see, not only the variable that failed.
    const missing = REQUIRED_ENV_VARS[1]
    applyRequiredEnv([missing], "blank")

    const error = missingEnvErrorFrom(() => getEnv())
    const rendered = `${error.message}\n${String(error)}`

    for (const name of REQUIRED_ENV_VARS) {
      if (name === missing) continue
      expect(rendered).not.toContain(PRESENT_VALUES[name])
    }
  })
})

describe("Requirement 5.8 — the first missing variable in declared order", () => {
  test.each(ORDER_CASES)(
    "$flavour: getEnv names $earlier, not $later",
    ({ earlier, later, flavour }) => {
      applyRequiredEnv([earlier, later], flavour)

      const error = missingEnvErrorFrom(() => getEnv())

      expect(error.variableName).toBe(earlier)
      expect(error.message).toContain(earlier)
      expect(error.message).not.toContain(later)
    }
  )

  test.each(BLANK_ORDER_CASES)(
    "the environment reports $later before $earlier, so declared order is what passed",
    ({ earlier, later }) => {
      // Without this the previous test would also pass against an
      // implementation that walked `Object.keys(process.env)` and happened to
      // meet the declared order.
      applyRequiredEnv([earlier, later], "blank")

      const order = requiredKeysInEnvOrder()

      expect(order).toContain(earlier)
      expect(order).toContain(later)
      expect(order.indexOf(later)).toBeLessThan(order.indexOf(earlier))
    }
  )
})

describe("getEnv resolves the whole required set", () => {
  test("its keys are exactly REQUIRED_ENV_VARS, with the resolved values", () => {
    applyRequiredEnv()

    const resolved = getEnv()

    expect(Object.keys(resolved).sort()).toEqual([...REQUIRED_ENV_VARS].sort())
    expect(resolved).toEqual(PRESENT_VALUES)
  })
})

describe("Requirement 5.9 — nothing is retained between calls", () => {
  test("requireEnv resolves a changed value on the next call", () => {
    const name = REQUIRED_ENV_VARS[0]
    applyRequiredEnv()

    process.env[name] = "first-value-2ac7"
    expect(requireEnv(name)).toBe("first-value-2ac7")

    process.env[name] = "second-value-91de"
    expect(requireEnv(name)).toBe("second-value-91de")
  })

  test("getEnv resolves a changed value on the next call", () => {
    const name = REQUIRED_ENV_VARS[4]
    applyRequiredEnv()

    process.env[name] = "first-value-2ac7"
    expect(getEnv()[name]).toBe("first-value-2ac7")

    process.env[name] = "second-value-91de"
    expect(getEnv()[name]).toBe("second-value-91de")
  })

  test("a variable resolved once and then removed fails the next call", () => {
    // The other direction of the same rule, and the one a memo hides: a cached
    // value would keep answering after the variable is gone.
    const name = REQUIRED_ENV_VARS[8]
    applyRequiredEnv()

    expect(requireEnv(name)).toBe(PRESENT_VALUES[name])

    delete process.env[name]

    expect(missingEnvErrorFrom(() => requireEnv(name)).variableName).toBe(name)
  })

  test("a value set after the module was imported resolves, proving a call-time read", () => {
    // This module was imported before any of these tests ran, so a
    // module-load snapshot would hold nothing at all here.
    clearRequiredEnv()
    const name = REQUIRED_ENV_VARS[3]

    missingEnvErrorFrom(() => requireEnv(name))
    process.env[name] = PRESENT_VALUES[name]

    expect(requireEnv(name)).toBe(PRESENT_VALUES[name])
  })
})
