import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { REQUIRED_ENV_VARS } from "@/lib/env"

/**
 * Static boundary guards (Requirement 6). These read the repository from disk
 * and assert its shape, so a boundary is structural rather than remembered.
 *
 * Each rule group is one `describe` over a shared set of readers below. The
 * final group of rules — the Auth.js literal scan, the SSE `runtime = "nodejs"`
 * rule and the preset-identity pins — was appended without restructuring what
 * came before it.
 *
 * Paths resolve from this file, not from the working directory, so the suite
 * reads the same repository however Vitest was invoked.
 */

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

function readProjectFile(relativePath: string): string {
  const absolutePath = path.join(projectRoot, relativePath)
  expect(
    existsSync(absolutePath),
    `${relativePath} is missing from ${projectRoot}`
  ).toBe(true)
  return readFileSync(absolutePath, "utf8")
}

// --- `.env.example` ---------------------------------------------------------

const ENV_EXAMPLE = ".env.example"

/** `KEY=value`, upper snake case, nothing before the key on the line. */
const DECLARATION_PATTERN = /^([A-Z][A-Z0-9_]*)=(.*)$/

/** Requirement 5.6 — a placeholder is angle-bracketed … */
const ANGLE_BRACKETED_TOKEN = /<[^<>]+>/

/** … or says how to generate the value. */
const GENERATE_KEYWORD = /generate/i

type EnvDeclaration = {
  readonly key: string
  readonly value: string
  readonly lineNumber: number
}

type ParsedEnvExample = {
  readonly declarations: readonly EnvDeclaration[]
  /** Lines that are neither blank, nor a comment, nor a declaration. */
  readonly malformed: readonly string[]
}

function parseEnvExample(): ParsedEnvExample {
  const declarations: EnvDeclaration[] = []
  const malformed: string[] = []

  readProjectFile(ENV_EXAMPLE)
    .split("\n")
    .forEach((rawLine, index) => {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith("#")) return

      const matched = DECLARATION_PATTERN.exec(line)
      if (matched === null) {
        malformed.push(`line ${index + 1}: ${line}`)
        return
      }

      declarations.push({
        key: matched[1],
        value: matched[2],
        lineNumber: index + 1,
      })
    })

  return { declarations, malformed }
}

// --- `.gitignore` ----------------------------------------------------------

/** The rule lines, in order, with comments and blanks dropped as git does. */
function gitignoreRules(): readonly string[] {
  return readProjectFile(".gitignore")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

/**
 * Does one rule match a file name at the repository root?
 *
 * Handles the pattern forms this `.gitignore` uses — a literal name, a `*`
 * wildcard, an optional leading `/`, a trailing `/` for directories — which
 * covers both names asserted below. Deliberately not a general gitignore
 * implementation: `git check-ignore` is that, and the value here is an
 * in-process assertion that needs no subprocess and no repository.
 */
function ruleMatchesFileName(rule: string, fileName: string): boolean {
  const pattern = rule.startsWith("!") ? rule.slice(1) : rule
  if (pattern.endsWith("/")) return false

  const bare = pattern.startsWith("/") ? pattern.slice(1) : pattern
  if (bare.includes("/")) return false

  const source = bare
    .split("*")
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*")

  return new RegExp(`^${source}$`).test(fileName)
}

/** Git's last-matching-rule-wins, over the root-level names asserted below. */
function isIgnored(rules: readonly string[], fileName: string): boolean {
  let ignored = false
  for (const rule of rules) {
    if (ruleMatchesFileName(rule, fileName)) ignored = !rule.startsWith("!")
  }
  return ignored
}

// --- Source files ----------------------------------------------------------

/**
 * Requirement 6.10 — what counts as a source file: a `.ts` or `.tsx` outside
 * `node_modules` and `.next` whose name carries neither `.test.` nor `.spec.`.
 *
 * The definition is shared rather than restated per rule, so a future scan
 * cannot accidentally apply a narrower one and skip a file the others check.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const

const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".next"])

const TEST_FILE_INFIXES = [".test.", ".spec."] as const

function isSourceFileName(fileName: string): boolean {
  if (!SOURCE_EXTENSIONS.some((extension) => fileName.endsWith(extension))) {
    return false
  }

  return !TEST_FILE_INFIXES.some((infix) => fileName.includes(infix))
}

/**
 * Every source file under one repository-relative directory, recursively, as
 * repository-relative paths in sorted order.
 *
 * Returns `[]` for an absent directory rather than throwing, so the emptiness
 * check that Requirement 6.11 demands is one assertion covering both failures:
 * a directory that does not exist and a directory holding no source file are
 * the same hole — a sweep that passes because it swept nothing.
 *
 * Sorted so `test.each` names files in a stable order across machines.
 */
function listSourceFiles(relativeDirectory: string): readonly string[] {
  const absoluteDirectory = path.join(projectRoot, relativeDirectory)
  if (!existsSync(absoluteDirectory)) return []

  const found: string[] = []

  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(projectRoot, relative), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
        walk(path.join(relative, entry.name))
        continue
      }

      if (entry.isFile() && isSourceFileName(entry.name)) {
        found.push(path.join(relative, entry.name))
      }
    }
  }

  walk(relativeDirectory)

  return found.sort()
}

// --- Modules that must carry the server-only marker ------------------------

/**
 * Requirement 6.1, the named modules. The directory sweeps below cover
 * `lib/auth/`, `lib/aws/` and the connection-opening modules under `lib/db/`.
 */
const SERVER_ONLY_MODULES = ["lib/env.ts", "lib/crypto.ts"] as const

const SERVER_ONLY_MARKER = 'import "server-only"'

/**
 * Directories where **every** source file must carry the marker
 * (Requirement 6.1).
 *
 * A swept directory rather than a hand-maintained file list, because the list is
 * the thing that goes stale: `lib/auth/guard.ts` was the fourth module added to
 * `lib/auth/`, and a list would have had to be edited to notice it. Now adding a
 * module to `lib/auth/` without the marker fails this suite by default.
 */
const SERVER_ONLY_DIRECTORIES = ["lib/auth", "lib/aws"] as const

/**
 * What makes a module under `lib/db/` connection-opening (Requirement 6.1).
 *
 * Requirement 6.1 marks the connection-opening modules under `lib/db/`, not
 * every module there — `lib/db/schema.ts` is table definitions and
 * `lib/db/views.ts` is the projection whose *output* is designed to reach the
 * browser, so marking it would make the module that defines the browser-safe
 * shape the one module the browser may not name.
 *
 * "Opens a connection" is therefore decided from the source rather than from a
 * list: the Postgres driver, the node-postgres Drizzle entry, a `Pool`
 * construction, or a mention of `DATABASE_URL`. Deliberately broader than
 * strictly necessary — a module that merely *names* the connection string is
 * one that has business with a connection, and the cost of a false positive is
 * a `server-only` line on a module that does not strictly need it.
 *
 * `drizzle-orm/pg-core` does not match: `schema.ts` imports it to declare
 * tables, and declaring a table opens nothing.
 */
const CONNECTION_MARKERS = [
  'from "pg"',
  "drizzle-orm/node-postgres",
  "new Pool(",
  "DATABASE_URL",
] as const

function opensConnection(source: string): boolean {
  return CONNECTION_MARKERS.some((marker) => source.includes(marker))
}

/** The first non-blank line of a module, trimmed. */
function firstCodeLine(relativePath: string): string | undefined {
  return readProjectFile(relativePath)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
}

/** Does this module carry the marker as its first line of code? */
function hasServerOnlyMarker(relativePath: string): boolean {
  return firstCodeLine(relativePath) === SERVER_ONLY_MARKER
}

// --- The whole-repository source sweep -------------------------------------

/**
 * Every directory Requirement 6.3 names, which is also the scope of the
 * `@aws-sdk/*` / `@/lib/crypto` rule below (Requirement 6.2).
 *
 * `hooks/` is included and is currently empty. That is why the emptiness check
 * for these two rules is made over the **union** rather than per directory: a
 * directory holding no hook yet is not the hole Requirement 6.11 is about — a
 * *sweep* that asserts nothing is — and the union plus the named anchors below
 * close that hole without failing on a directory that has not been populated.
 */
const SOURCE_DIRECTORIES = ["lib", "app", "components", "hooks"] as const

/** Every source file under every scanned directory, deduplicated and sorted. */
function allSourceFiles(): readonly string[] {
  return [
    ...new Set(SOURCE_DIRECTORIES.flatMap((dir) => listSourceFiles(dir))),
  ].sort()
}

// --- Rule: an SDK or crypto import requires the marker (Requirement 6.2) ----

/**
 * Module specifiers whose import obliges a module to be server-only.
 *
 * `@aws-sdk/` matches every package in the family, so a client added later —
 * `@aws-sdk/client-dynamodb`, `@aws-sdk/client-bedrock-runtime` — is covered
 * without editing this list.
 *
 * `@/lib/crypto` is matched with its closing quote, so `@/lib/crypto` is a hit
 * and a hypothetical `@/lib/crypto-utils` is not. A prefix match there would
 * make the rule fire on a module that shares a name and holds no key.
 */
const SERVER_ONLY_IMPORT_PATTERNS = [
  /["']@aws-sdk\//,
  /["']@\/lib\/crypto["']/,
] as const

/**
 * Does this source text import one of those specifiers?
 *
 * A textual match rather than an AST walk, and it deliberately does **not**
 * exempt `import type`. Requirement 6.2 says "imports an `@aws-sdk/*` package",
 * and while a type-only import is erased and bundles nothing, a module that
 * names an AWS client's types is a module doing server work. The cost of the
 * stricter reading is one `server-only` line; the cost of the looser one is a
 * rule with an exemption for the exact syntax a mistake is easiest to make in.
 */
function requiresServerOnly(source: string): boolean {
  return SERVER_ONLY_IMPORT_PATTERNS.some((pattern) => pattern.test(source))
}

// --- Rule: no hardcoded runtime ARN (Requirement 6.3) ----------------------

/**
 * The literal Requirement 6.3 forbids, **assembled rather than written**.
 *
 * Written out, it would make this module the one file that contains it, and the
 * rule would then need an exemption for its own guard — which is the shape of
 * exemption that later gets widened. Assembling it means the scan can cover this
 * file too, and `THE_GUARD_ITSELF_IS_CLEAN` below asserts exactly that.
 */
const RUNTIME_ARN_LITERAL = ["arn", "aws", "bedrock-agentcore", ""].join(":")

// ---------------------------------------------------------------------------

describe("Requirements 5.4, 5.6, 6.6 — .env.example declares the required set", () => {
  test("every non-comment line is a KEY=value declaration", () => {
    expect(parseEnvExample().malformed).toEqual([])
  })

  test("no key is declared twice", () => {
    const keys = parseEnvExample().declarations.map(({ key }) => key)
    expect(keys).toEqual([...new Set(keys)])
  })

  test("the key set equals REQUIRED_ENV_VARS exactly", () => {
    // Imported, never restated. A guard holding a second copy of the list
    // passes while lying (Requirement 5.10).
    const declared = parseEnvExample()
      .declarations.map(({ key }) => key)
      .sort()

    expect(declared).toEqual([...REQUIRED_ENV_VARS].sort())
  })

  test("every value is a non-empty, recognisable placeholder", () => {
    // The proxy for "no real credential value in this file": a value that is
    // angle-bracketed or tells the operator to generate it is not a secret
    // somebody pasted.
    for (const { key, value, lineNumber } of parseEnvExample().declarations) {
      const where = `${ENV_EXAMPLE}:${lineNumber} (${key})`

      expect(value.trim(), `${where} has an empty placeholder`).not.toBe("")
      expect(
        ANGLE_BRACKETED_TOKEN.test(value) || GENERATE_KEYWORD.test(value),
        `${where} needs an angle-bracketed token or the word "generate"`
      ).toBe(true)
    }
  })
})

describe("Requirement 5.7 — .env is ignored, .env.example is tracked", () => {
  test(".env is excluded from version control", () => {
    expect(isIgnored(gitignoreRules(), ".env")).toBe(true)
  })

  test(".env.example survives that rule by an explicit negation", () => {
    const rules = gitignoreRules()

    expect(isIgnored(rules, ".env.example")).toBe(false)
    expect(rules).toContain("!.env.example")
  })

  test("the negation is the rule immediately after the rule that ignores .env", () => {
    // Order is load-bearing — git takes the last matching rule — and adjacency
    // keeps the pair readable as one decision. Comments and blank lines between
    // them are fine; another rule between them is not.
    const rules = gitignoreRules()
    const ignoreIndex = rules.findIndex((rule) =>
      ruleMatchesFileName(rule, ".env")
    )

    expect(ignoreIndex, "no rule in .gitignore ignores .env").toBeGreaterThan(
      -1
    )
    expect(rules[ignoreIndex + 1]).toBe("!.env.example")
  })
})

describe("Requirement 6.1 — server modules begin with the server-only marker", () => {
  test("the scanned set is not empty", () => {
    // A guard that passes by checking nothing is the failure mode these tests
    // are most prone to.
    expect(SERVER_ONLY_MODULES.length).toBeGreaterThan(0)
  })

  test.each(SERVER_ONLY_MODULES)("%s starts with the marker", (modulePath) => {
    expect(firstCodeLine(modulePath)).toBe(SERVER_ONLY_MARKER)
  })
})

describe("Requirements 6.1, 6.10, 6.11 — the server-only directory sweeps", () => {
  test.each(SERVER_ONLY_DIRECTORIES)(
    "%s exists and yields at least one source file",
    (directory) => {
      // Requirement 6.11. Both failures land here: an absent directory and one
      // holding no source file are the same hole, and the rule below would pass
      // vacuously through either of them.
      expect(
        listSourceFiles(directory).length,
        `${directory} is absent or holds no source file, so the sweep below ` +
          `would assert nothing`
      ).toBeGreaterThan(0)
    }
  )

  test.each(SERVER_ONLY_DIRECTORIES)(
    "every source file under %s starts with the marker",
    (directory) => {
      const files = listSourceFiles(directory)
      expect(files.length).toBeGreaterThan(0)

      for (const file of files) {
        expect(
          firstCodeLine(file),
          `${file} must begin with ${SERVER_ONLY_MARKER}`
        ).toBe(SERVER_ONLY_MARKER)
      }
    }
  )

  test("the sweep sees every module in the directory", () => {
    // The sweep is only as good as its listing, so the listing is asserted
    // against the modules that exist rather than trusted. `guard.ts` is named
    // because it is the module this rule was extended for.
    expect(listSourceFiles("lib/auth")).toContain(
      path.join("lib", "auth", "guard.ts")
    )
  })
})

describe("Requirement 6.10 — what the sweeps treat as a source file", () => {
  test.each([
    ["guard.ts", true],
    ["page.tsx", true],
    ["guard.test.ts", false],
    ["views.spec.ts", false],
    ["harness.dom.test.tsx", false],
    ["schema.sql", false],
    ["0000_low_ogun.sql", false],
    ["README.md", false],
  ] as const)("%s → %s", (fileName, expected) => {
    // The classifier every sweep above shares. A narrower rule here silently
    // narrows all of them, and a wider one drags test files into a marker
    // assertion they would all fail.
    expect(isSourceFileName(fileName)).toBe(expected)
  })

  test("node_modules and .next are never descended into", () => {
    expect([...EXCLUDED_DIRECTORIES].sort()).toEqual([".next", "node_modules"])
  })
})

describe("Requirements 6.1, 6.10, 6.11 — the lib/db/ connection sweep", () => {
  const DB_DIRECTORY = "lib/db"

  test("lib/db exists and yields source files", () => {
    // Requirement 6.11 again, and it bites harder here than for lib/auth/:
    // this sweep filters, so an empty directory *and* a classifier that matches
    // nothing both produce an empty set.
    expect(listSourceFiles(DB_DIRECTORY).length).toBeGreaterThan(0)
  })

  test("at least one module under lib/db opens a connection", () => {
    const opening = listSourceFiles(DB_DIRECTORY).filter((file) =>
      opensConnection(readProjectFile(file))
    )

    expect(
      opening.length,
      `no module under ${DB_DIRECTORY} matched the connection markers, so the ` +
        `rule below would assert nothing`
    ).toBeGreaterThan(0)
  })

  test("lib/db/index.ts is classified as connection-opening", () => {
    // The anchor for the classifier itself. "At least one match" above stays
    // true if the markers drift onto some other file; this names the module
    // that actually constructs the pool, so a marker set that stops matching it
    // fails here instead of passing quietly.
    expect(opensConnection(readProjectFile("lib/db/index.ts"))).toBe(true)
  })

  test("every connection-opening module under lib/db starts with the marker", () => {
    const files = listSourceFiles(DB_DIRECTORY)
    const opening = files.filter((file) =>
      opensConnection(readProjectFile(file))
    )

    expect(opening.length).toBeGreaterThan(0)

    for (const file of opening) {
      expect(
        firstCodeLine(file),
        `${file} opens a connection and must begin with ${SERVER_ONLY_MARKER}`
      ).toBe(SERVER_ONLY_MARKER)
    }
  })
})

describe("Requirements 6.2, 6.10, 6.11 — an SDK or crypto import requires the marker", () => {
  test("the union of scanned directories is not empty", () => {
    // Requirement 6.11. The union rather than each directory: `hooks/` holds no
    // hook yet, and an unpopulated directory is not the hole this rule closes.
    expect(
      allSourceFiles().length,
      `none of ${SOURCE_DIRECTORIES.join(", ")} yielded a source file, so the ` +
        `rules below would assert nothing`
    ).toBeGreaterThan(0)
  })

  test("at least one scanned module imports an @aws-sdk/* package", () => {
    // The anchor. "No violations found" is also what a scan that matches nothing
    // reports, so the detector is pinned against a file that must match.
    const importing = allSourceFiles().filter((file) =>
      /["']@aws-sdk\//.test(readProjectFile(file))
    )

    expect(
      importing.length,
      `no scanned module imports an @aws-sdk/* package, so the rule below ` +
        `would pass vacuously`
    ).toBeGreaterThan(0)
  })

  test("lib/aws/agentcore.ts and lib/aws/s3.ts are both seen by the sweep", () => {
    // Named because they are the modules this rule was extended for: the SDK
    // enters the app here, and a listing that stopped reaching them would leave
    // the rule green while checking neither.
    const files = allSourceFiles()

    expect(files).toContain(path.join("lib", "aws", "agentcore.ts"))
    expect(files).toContain(path.join("lib", "aws", "s3.ts"))
  })

  test("every module importing @aws-sdk/* or @/lib/crypto starts with the marker", () => {
    const offenders = allSourceFiles()
      .filter((file) => requiresServerOnly(readProjectFile(file)))
      .filter((file) => !hasServerOnlyMarker(file))

    expect(
      offenders,
      `these modules import an AWS SDK package or @/lib/crypto and must begin ` +
        `with ${SERVER_ONLY_MARKER}`
    ).toEqual([])
  })

  test("the detector fires on both specifier forms and on neither near-miss", () => {
    // The classifier itself, so a regex edited into uselessness fails here rather
    // than turning the rule above into a no-op.
    expect(
      requiresServerOnly('import { S3Client } from "@aws-sdk/client-s3"')
    ).toBe(true)
    expect(
      requiresServerOnly('import type { Foo } from "@aws-sdk/client-s3"')
    ).toBe(true)
    expect(
      requiresServerOnly('import { encryptSecret } from "@/lib/crypto"')
    ).toBe(true)
    expect(requiresServerOnly("const x = 1")).toBe(false)
    // A prefix match here would fire on a module that shares a name and holds no
    // key material.
    expect(requiresServerOnly('import { x } from "@/lib/crypto-utils"')).toBe(
      false
    )
    // Prose mentioning the package is not an import.
    expect(requiresServerOnly("// see the aws-sdk docs")).toBe(false)
  })
})

describe("Requirement 6.1 — lib/subscriptions is split, not swept", () => {
  const SUBSCRIPTIONS = "lib/subscriptions"

  /**
   * Every module in this directory, classified into three groups.
   *
   * `lib/subscriptions` is deliberately **absent** from
   * {@link SERVER_ONLY_DIRECTORIES}: two of its modules open a connection or reach
   * the runtime with a customer credential, while three are pure and are rendered
   * by client leaves — the expiry banner, the wizard's copy button and the
   * wizard's own field validation. A directory sweep here would make those three
   * unimportable from the components that exist to display them.
   *
   * The split is asserted rather than assumed, and the union below is asserted to
   * be **exhaustive**, so a module added to this directory has to be classified
   * before the suite passes. That is the property a blanket sweep would have given
   * for free and a hand-maintained list normally loses.
   */

  /**
   * Carries the marker **and** is reached by the Requirement 6.2 rule on its own
   * merits: it imports `@/lib/crypto`, so deleting this whole group would not make
   * the marker optional for it.
   */
  const REACHED_BY_RULE = [path.join("lib", "subscriptions", "store.ts")]

  /**
   * Carries the marker by **decision**, not by rule.
   *
   * `preflight.ts` imports neither an AWS SDK package nor `@/lib/crypto` — it goes
   * through `lib/aws/agentcore.ts`, which is marked — so Requirement 6.2 does not
   * fire on it. It is marked anyway because it takes the customer's **plaintext**
   * client secret as an argument and puts it into an invoke payload, which is
   * precisely the kind of module a client component must not be able to name. This
   * group exists so that intent is a failing test rather than a comment.
   */
  const MARKED_BY_DECISION = [path.join("lib", "subscriptions", "preflight.ts")]

  const PURE_HERE = [
    path.join("lib", "subscriptions", "state.ts"),
    path.join("lib", "subscriptions", "azure-artifacts.ts"),
    path.join("lib", "subscriptions", "input.ts"),
  ]

  const SERVER_ONLY_HERE = [...REACHED_BY_RULE, ...MARKED_BY_DECISION]

  test("the directory is not in the blanket sweep", () => {
    expect([...SERVER_ONLY_DIRECTORIES]).not.toContain(SUBSCRIPTIONS)
  })

  test("every module in the directory is classified, and only those exist", () => {
    // Requirement 6.11 — the listing is asserted rather than trusted, so no rule
    // below can pass by checking nothing. Exhaustive in both directions: a module
    // added here without a classification fails, and a classification naming a
    // module that was deleted or renamed fails too.
    const files = listSourceFiles(SUBSCRIPTIONS)

    expect(files.length).toBeGreaterThan(0)
    expect([...files].sort()).toEqual(
      [...SERVER_ONLY_HERE, ...PURE_HERE].sort()
    )
  })

  test.each(SERVER_ONLY_HERE)("%s carries the marker", (modulePath) => {
    expect(firstCodeLine(modulePath)).toBe(SERVER_ONLY_MARKER)
  })

  test.each(REACHED_BY_RULE)(
    "%s is reached by the Requirement 6.2 rule too",
    (modulePath) => {
      expect(requiresServerOnly(readProjectFile(modulePath))).toBe(true)
    }
  )

  test.each(MARKED_BY_DECISION)(
    "%s is marked by decision — no rule forces it",
    (modulePath) => {
      // Asserting the *absence* is the half worth keeping: if this module grew a
      // direct `@aws-sdk/*` or `@/lib/crypto` import it would move into
      // REACHED_BY_RULE, and this failure is what says so rather than leaving two
      // groups quietly overlapping.
      expect(requiresServerOnly(readProjectFile(modulePath))).toBe(false)
    }
  )

  test.each(PURE_HERE)("%s is pure and deliberately unmarked", (modulePath) => {
    const source = readProjectFile(modulePath)

    expect(hasServerOnlyMarker(modulePath)).toBe(false)

    // Unmarked *because* it is pure, which is the half worth asserting: a module
    // that grew a crypto import or a connection would need the marker, and this
    // is what turns that into a failure instead of a leak.
    expect(requiresServerOnly(source)).toBe(false)
    expect(opensConnection(source)).toBe(false)
  })
})

describe("Requirement 6.3 — no source file hardcodes a runtime ARN", () => {
  test("the forbidden literal is the one .env.example carries", () => {
    // Assembling the literal is what lets this file be scanned like any other,
    // but it also means a typo would silently make the scan search for nothing.
    // `.env.example` holds the real placeholder, so it is the fixture that pins
    // the spelling.
    expect(RUNTIME_ARN_LITERAL.startsWith("arn:aws:")).toBe(true)
    expect(RUNTIME_ARN_LITERAL.endsWith(":")).toBe(true)
    expect(readProjectFile(ENV_EXAMPLE)).toContain(RUNTIME_ARN_LITERAL)
  })

  test("no scanned source file contains it", () => {
    const offenders = allSourceFiles().filter((file) =>
      readProjectFile(file).includes(RUNTIME_ARN_LITERAL)
    )

    expect(
      offenders,
      `a runtime ARN belongs in RPT_RUNTIME_ARN and is read from process.env ` +
        `at call time (Requirement 41.1); these files hardcode one`
    ).toEqual([])
  })

  test("the guard's own module is clean too", () => {
    // THE_GUARD_ITSELF_IS_CLEAN. Requirement 6.3 exempts the Boundary_Guard's own
    // module, and this rule needs no exemption: the literal is assembled, so the
    // file does not contain it and the scan could include this directory without
    // a special case.
    expect(
      readProjectFile(path.join("test", "boundaries.static.test.ts"))
    ).not.toContain(RUNTIME_ARN_LITERAL)
  })
})
// ===========================================================================
// Task 14.1 — the remaining rules
//
// Three groups, each closing a hole a review would otherwise have to remember:
// the Auth.js scan (Requirements 6.4, 6.5, 6.12, 6.13), the SSE runtime rule
// (Requirement 6.7), and the preset-identity pins (Requirements 6.8, 6.9).
// ===========================================================================

// --- Every file under `app/`, not only every source file -------------------

/**
 * Requirement 6.12 says "a file under `app/`", which is deliberately wider than
 * {@link isSourceFileName}: the references this rule exists to catch are stale
 * `vi.mock(…)` calls in **test** files, and a source-file sweep skips exactly
 * those by design.
 *
 * So this walker classifies almost nothing out. What it does skip:
 *
 * - `node_modules`, `.next` and `.git`, for the reason every sweep does;
 * - binary payloads, where a `utf8` read yields mojibake rather than text;
 * - `.env`, which is git-ignored, machine-local and secret-bearing. It declares
 *   values, imports no module, and is not a place the literal could mean
 *   anything. `.env.example` is tracked and **is** scanned, which is the copy
 *   that could carry an `AUTH_SECRET`-shaped convention;
 * - `tsconfig.tsbuildinfo`, a generated artifact. A stale build output turning
 *   this suite red says nothing about the tree under review.
 */
const BINARY_EXTENSIONS = new Set([
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".docx",
  ".zip",
  ".gz",
])

const UNSCANNED_FILE_NAMES = new Set([".env", "tsconfig.tsbuildinfo"])

const ALL_FILES_EXCLUDED_DIRECTORIES = new Set([
  ...EXCLUDED_DIRECTORIES,
  ".git",
])

/** Every scannable file under `app/`, as repository-relative sorted paths. */
function listAllFiles(): readonly string[] {
  const found: string[] = []

  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(projectRoot, relative), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        if (ALL_FILES_EXCLUDED_DIRECTORIES.has(entry.name)) continue
        walk(path.join(relative, entry.name))
        continue
      }

      if (!entry.isFile()) continue
      if (UNSCANNED_FILE_NAMES.has(entry.name)) continue
      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        continue

      found.push(path.join(relative, entry.name))
    }
  }

  walk("")

  return found.sort()
}

// --- The Auth.js names, assembled rather than written ----------------------

/**
 * The literal Requirement 6.12 forbids anywhere under `app/`, **assembled** for
 * the same reason {@link RUNTIME_ARN_LITERAL} is.
 *
 * Requirement 6.12 exempts the Boundary_Guard's own module, and assembling the
 * name means the exemption is never used: this file does not contain the
 * literal, so the scan can cover `test/` — including itself — with no special
 * case. `THE_GUARD_ITSELF_IS_CLEAN` below asserts that.
 *
 * Exemptions are the part of a guard that later gets widened. Not needing one is
 * worth two lines of indirection.
 */
const NEXT_AUTH_LITERAL = ["next", "auth"].join("-")

/**
 * Requirement 6.13's forbidden path segment, derived from the name above so the
 * spelling has one source. Note it carries **no** hyphen — a catch-all route
 * segment for that package is `[...nextauth]` — so it is a genuinely separate
 * string that the literal scan above would not catch.
 */
const NEXTAUTH_ROUTE_SEGMENT = `[...${NEXT_AUTH_LITERAL.replace("-", "")}]`

/** The adapter Requirement 6.4 names alongside it. It carries no hyphen pair. */
const AUTH_ADAPTER_PACKAGE = "@auth/drizzle-adapter"

/**
 * Does this source text import the package or one of its subpaths
 * (Requirement 6.5)?
 *
 * Matched as a **quoted module specifier**, so `import … from "…"`,
 * `require("…")`, `await import("…")` and `vi.mock("…/jwt")` all hit while prose
 * naming the package does not. Requirement 6.12's literal scan is the wider net;
 * this one exists because it names the actual defect, so a failure reads as
 * "this file imports it" rather than "this file mentions it somewhere".
 */
function importsNextAuth(source: string): boolean {
  return new RegExp(`["']${NEXT_AUTH_LITERAL}(/[^"']*)?["']`).test(source)
}

// --- `package.json` --------------------------------------------------------

type PackageJson = {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

function readPackageJson(): PackageJson {
  return JSON.parse(readProjectFile("package.json")) as PackageJson
}

/** Both dependency lists as one set of package names (Requirement 6.4). */
function declaredDependencyNames(): ReadonlySet<string> {
  const manifest = readPackageJson()
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])
}

// --- Route handlers --------------------------------------------------------

/** Requirement 6.7 — a route handler is an `app/**\/route.ts`. */
function listRouteHandlers(): readonly string[] {
  return listSourceFiles("app").filter(
    (file) => path.basename(file) === "route.ts"
  )
}

const EVENT_STREAM_CONTENT_TYPE = "text/event-stream"

/**
 * Requirement 6.7's declaration, matched as a **statement at column zero**
 * rather than as a substring.
 *
 * Every route in this app documents the declaration in its header comment before
 * making it, so a substring search is satisfied by the prose — this rule was
 * written that way first, and it passed against a handler edited to
 * `runtime = "edge"` because the comment above it still said `"nodejs"`. A guard
 * that a comment can satisfy is worse than no guard, because it reports green.
 *
 * A comment line begins with whitespace and `*`, so anchoring to the start of a
 * line with no leading whitespace admits only the export itself.
 */
const NODE_RUNTIME_EXPORT = /^export const runtime = "nodejs"$/m

function declaresNodeRuntime(source: string): boolean {
  return NODE_RUNTIME_EXPORT.test(source)
}

// --- `app/globals.css` — the preset's token blocks --------------------------

const GLOBALS_CSS = path.join("app", "globals.css")

/**
 * The custom-property declarations of the **first** block with this selector.
 *
 * "First" is the load-bearing word. Requirement 6.9 permits **appended** blocks,
 * and the chart palette a later spec adds arrives as a second `:root` block. So
 * an exact-map assertion over *every* `:root` declaration would forbid the one
 * change the requirement allows, while an assertion over the preset's own block
 * fails on precisely what it forbids: an edited token value.
 *
 * `:root` and `.dark` carry only flat declarations, so the first `}` closes the
 * block and no brace matching is needed.
 */
function presetTokenBlock(selector: string): ReadonlyMap<string, string> {
  const source = readProjectFile(GLOBALS_CSS)
  const opening = source.indexOf(`${selector} {`)

  expect(
    opening,
    `${GLOBALS_CSS} declares no ${selector} block`
  ).toBeGreaterThan(-1)

  const closing = source.indexOf("}", opening)
  expect(
    closing,
    `${selector} block in ${GLOBALS_CSS} is unterminated`
  ).toBeGreaterThan(opening)

  const declarations = new Map<string, string>()

  for (const line of source.slice(opening, closing).split("\n")) {
    const matched = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*;\s*$/.exec(line)
    if (matched !== null) declarations.set(matched[1], matched[2])
  }

  return declarations
}

/** The Luma light tokens, transcribed from the generated file. */
const PRESET_ROOT_TOKENS: Readonly<Record<string, string>> = {
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.148 0.004 228.8)",
  "--card": "oklch(1 0 0)",
  "--card-foreground": "oklch(0.148 0.004 228.8)",
  "--popover": "oklch(1 0 0)",
  "--popover-foreground": "oklch(0.148 0.004 228.8)",
  "--primary": "oklch(0.52 0.105 223.128)",
  "--primary-foreground": "oklch(0.984 0.019 200.873)",
  "--secondary": "oklch(0.967 0.001 286.375)",
  "--secondary-foreground": "oklch(0.21 0.006 285.885)",
  "--muted": "oklch(0.963 0.002 197.1)",
  "--muted-foreground": "oklch(0.56 0.021 213.5)",
  "--accent": "oklch(0.963 0.002 197.1)",
  "--accent-foreground": "oklch(0.218 0.008 223.9)",
  "--destructive": "oklch(0.577 0.245 27.325)",
  "--border": "oklch(0.925 0.005 214.3)",
  "--input": "oklch(0.925 0.005 214.3)",
  "--ring": "oklch(0.723 0.014 214.4)",
  "--chart-1": "oklch(0.872 0.007 219.6)",
  "--chart-2": "oklch(0.56 0.021 213.5)",
  "--chart-3": "oklch(0.45 0.017 213.2)",
  "--chart-4": "oklch(0.378 0.015 216)",
  "--chart-5": "oklch(0.275 0.011 216.9)",
  "--radius": "0.625rem",
  "--sidebar": "oklch(0.987 0.002 197.1)",
  "--sidebar-foreground": "oklch(0.148 0.004 228.8)",
  "--sidebar-primary": "oklch(0.609 0.126 221.723)",
  "--sidebar-primary-foreground": "oklch(0.984 0.019 200.873)",
  "--sidebar-accent": "oklch(0.963 0.002 197.1)",
  "--sidebar-accent-foreground": "oklch(0.218 0.008 223.9)",
  "--sidebar-border": "oklch(0.925 0.005 214.3)",
  "--sidebar-ring": "oklch(0.723 0.014 214.4)",
}

/** The Luma dark tokens. `--radius` is declared once, in `:root`. */
const PRESET_DARK_TOKENS: Readonly<Record<string, string>> = {
  "--background": "oklch(0.148 0.004 228.8)",
  "--foreground": "oklch(0.987 0.002 197.1)",
  "--card": "oklch(0.218 0.008 223.9)",
  "--card-foreground": "oklch(0.987 0.002 197.1)",
  "--popover": "oklch(0.218 0.008 223.9)",
  "--popover-foreground": "oklch(0.987 0.002 197.1)",
  "--primary": "oklch(0.45 0.085 224.283)",
  "--primary-foreground": "oklch(0.984 0.019 200.873)",
  "--secondary": "oklch(0.274 0.006 286.033)",
  "--secondary-foreground": "oklch(0.985 0 0)",
  "--muted": "oklch(0.275 0.011 216.9)",
  "--muted-foreground": "oklch(0.723 0.014 214.4)",
  "--accent": "oklch(0.275 0.011 216.9)",
  "--accent-foreground": "oklch(0.987 0.002 197.1)",
  "--destructive": "oklch(0.704 0.191 22.216)",
  "--border": "oklch(1 0 0 / 10%)",
  "--input": "oklch(1 0 0 / 15%)",
  "--ring": "oklch(0.56 0.021 213.5)",
  "--chart-1": "oklch(0.872 0.007 219.6)",
  "--chart-2": "oklch(0.56 0.021 213.5)",
  "--chart-3": "oklch(0.45 0.017 213.2)",
  "--chart-4": "oklch(0.378 0.015 216)",
  "--chart-5": "oklch(0.275 0.011 216.9)",
  "--sidebar": "oklch(0.218 0.008 223.9)",
  "--sidebar-foreground": "oklch(0.987 0.002 197.1)",
  "--sidebar-primary": "oklch(0.715 0.143 215.221)",
  "--sidebar-primary-foreground": "oklch(0.302 0.056 229.695)",
  "--sidebar-accent": "oklch(0.275 0.011 216.9)",
  "--sidebar-accent-foreground": "oklch(0.987 0.002 197.1)",
  "--sidebar-border": "oklch(1 0 0 / 10%)",
  "--sidebar-ring": "oklch(0.56 0.021 213.5)",
}

/** The `L` of an `oklch(L …)` value, for the dark-primary assertion below. */
function oklchLightness(value: string): number {
  const matched = /^oklch\(([\d.]+)/.exec(value)
  expect(matched, `${value} is not an oklch() value`).not.toBeNull()
  return Number(matched![1])
}

// ---------------------------------------------------------------------------

describe("Requirements 6.4, 6.5, 6.12, 6.13 — there is no Auth.js here", () => {
  test("the scan covers more than the source sweep does", () => {
    // Requirement 6.11, and it matters more for this rule than for any other:
    // the references Requirement 6.12 exists to catch live in test files, which
    // every other sweep in this module deliberately skips. So the wider listing
    // is asserted to be wider — by naming a test file, a lockfile and a
    // stylesheet, none of which `isSourceFileName` admits.
    const files = listAllFiles()

    expect(files.length).toBeGreaterThan(0)
    expect(files).toContain(path.join("test", "boundaries.static.test.ts"))
    expect(files).toContain("pnpm-lock.yaml")
    expect(files).toContain("package.json")
    expect(files).toContain(GLOBALS_CSS)
    expect(files).toContain(ENV_EXAMPLE)

    // The listing is strictly wider than the source sweep, which is the whole
    // point of having a second one.
    expect(files.length).toBeGreaterThan(allSourceFiles().length)
  })

  test("neither dependency list declares it", () => {
    // Requirement 6.4. The sibling project lists both packages and imports
    // neither; here they are absent on purpose, and this is what keeps them so.
    const declared = declaredDependencyNames()

    expect(declared.size).toBeGreaterThan(0)
    expect([...declared]).not.toContain(NEXT_AUTH_LITERAL)
    expect([...declared]).not.toContain(AUTH_ADAPTER_PACKAGE)
  })

  test("the dependency reader sees both lists", () => {
    // The anchor for the reader itself: an empty or half-read manifest would
    // make the rule above pass while checking nothing.
    const declared = declaredDependencyNames()

    expect(declared).toContain("next")
    expect(declared).toContain("vitest")
  })

  test("no source file imports it or one of its subpaths", () => {
    // Requirement 6.5.
    const offenders = allSourceFiles().filter((file) =>
      importsNextAuth(readProjectFile(file))
    )

    expect(
      offenders,
      `session handling is database-backed (Requirement 2); these files import ` +
        `a package that is deliberately absent`
    ).toEqual([])
  })

  test("the import detector fires on every specifier form and on no near-miss", () => {
    // Every sample is interpolated from the assembled name, so this file still
    // does not contain the literal and the scan below can cover it.
    expect(importsNextAuth(`import Auth from "${NEXT_AUTH_LITERAL}"`)).toBe(
      true
    )
    expect(importsNextAuth(`from "${NEXT_AUTH_LITERAL}/jwt"`)).toBe(true)
    expect(importsNextAuth(`require("${NEXT_AUTH_LITERAL}")`)).toBe(true)
    expect(importsNextAuth(`await import("${NEXT_AUTH_LITERAL}")`)).toBe(true)
    // The stale double the sibling project still carries. It mocks a module
    // nothing imports — a no-op that reads like evidence the dependency is live.
    expect(importsNextAuth(`vi.mock("${NEXT_AUTH_LITERAL}/jwt")`)).toBe(true)
    // Prose is not an import, which is why Requirement 6.12's wider scan exists
    // rather than this rule being stretched to cover it.
    expect(importsNextAuth(`// we do not use ${NEXT_AUTH_LITERAL}`)).toBe(false)
    expect(importsNextAuth('import { auth } from "@/lib/auth/session"')).toBe(
      false
    )
  })

  test("no file under app/ contains the literal at all", () => {
    // Requirement 6.12 — wider than the import rule on purpose. An import check
    // passes on `vi.mock("…/jwt")` in a test file, and that is exactly the
    // artefact that misleads a reader into thinking the dependency is live.
    const offenders = listAllFiles().filter((file) =>
      readProjectFile(file).includes(NEXT_AUTH_LITERAL)
    )

    expect(
      offenders,
      `these files name a package this project does not use; a stale reference ` +
        `reads as evidence the dependency is live (Requirement 6.12)`
    ).toEqual([])
  })

  test("the guard's own module is clean too", () => {
    // THE_GUARD_ITSELF_IS_CLEAN. Requirement 6.12 exempts this module and the
    // exemption goes unused: the name is assembled, so the scan above included
    // this file and passed.
    expect(
      readProjectFile(path.join("test", "boundaries.static.test.ts"))
    ).not.toContain(NEXT_AUTH_LITERAL)

    // And the assembly is pinned, so a typo cannot turn the scan into a search
    // for a string nothing could ever contain.
    expect(NEXT_AUTH_LITERAL).toHaveLength(9)
    expect(NEXT_AUTH_LITERAL.split("-")).toHaveLength(2)
  })

  test("no route exists under a catch-all auth segment", () => {
    // Requirement 6.13. Checked against the path rather than the contents,
    // because the offending artefact is a *directory name*: the handler inside
    // it need not mention the package at all.
    const offenders = listAllFiles().filter((file) =>
      file.split(path.sep).includes(NEXTAUTH_ROUTE_SEGMENT)
    )

    expect(
      offenders,
      `there is no such route: sessions are rows in Postgres and the cookie is ` +
        `set by hand (Requirement 2)`
    ).toEqual([])
  })

  test("the segment is spelled the way the router would spell it", () => {
    // Derived from the package name, so the two cannot drift apart — and
    // asserted, because a derivation that produced the wrong string would make
    // the rule above scan for nothing.
    expect(NEXTAUTH_ROUTE_SEGMENT.startsWith("[...")).toBe(true)
    expect(NEXTAUTH_ROUTE_SEGMENT.endsWith("]")).toBe(true)
    expect(NEXTAUTH_ROUTE_SEGMENT).not.toContain("-")
    expect(NEXTAUTH_ROUTE_SEGMENT).toHaveLength(13)
  })
})

describe("Requirements 6.7, 6.10, 6.11 — an SSE route runs on the Node runtime", () => {
  test("route handlers are found at all", () => {
    // Requirement 6.11. This sweep filters twice — to `route.ts`, then to the
    // ones that stream — so an empty listing would look identical to a clean
    // pass.
    expect(
      listRouteHandlers().length,
      `no app/**/route.ts was found, so the rules below would assert nothing`
    ).toBeGreaterThan(0)
  })

  test("at least one route handler returns a text/event-stream response", () => {
    // The anchor. "No violations" is also what a detector that matches nothing
    // reports, so the rule is pinned against a handler that must match.
    const streaming = listRouteHandlers().filter((file) =>
      readProjectFile(file).includes(EVENT_STREAM_CONTENT_TYPE)
    )

    expect(
      streaming,
      `the cosmetic relay streams (Requirement 40.1), so at least one handler ` +
        `must match or this rule passes vacuously`
    ).toContain(
      path.join("app", "api", "runs", "[runId]", "stream", "route.ts")
    )
  })

  test("every route handler that streams exports the Node runtime", () => {
    const offenders = listRouteHandlers()
      .filter((file) =>
        readProjectFile(file).includes(EVENT_STREAM_CONTENT_TYPE)
      )
      .filter((file) => !declaresNodeRuntime(readProjectFile(file)))

    expect(
      offenders,
      `a long-lived SSE response and the AWS SDK both require the Node ` +
        `runtime; these handlers stream without declaring it`
    ).toEqual([])
  })

  test("every route handler declares it, streaming or not", () => {
    // Stricter than Requirement 6.7 and deliberately so: every handler in this
    // app opens a Postgres connection, reaches an AWS SDK, or both, so none of
    // them can run on edge. Asserting the whole set means a handler added later
    // is covered before it grows a stream.
    const offenders = listRouteHandlers().filter(
      (file) => !declaresNodeRuntime(readProjectFile(file))
    )

    expect(offenders).toEqual([])
  })

  test("the declaration detector is not satisfied by a comment", () => {
    // The case that actually happened while writing this rule. Every route here
    // explains the declaration in prose directly above it, so a substring search
    // reports green on a handler switched to edge.
    expect(declaresNodeRuntime('export const runtime = "nodejs"')).toBe(true)
    expect(
      declaresNodeRuntime(
        ' * `export const runtime = "nodejs"` is mandatory here.\n' +
          'export const runtime = "edge"\n'
      )
    ).toBe(false)
    expect(declaresNodeRuntime('export const runtime = "edge"')).toBe(false)
    expect(declaresNodeRuntime("// no runtime declared")).toBe(false)
  })
})

describe("Requirements 6.8, 6.9 — the preset's identity is unchanged", () => {
  test("shadcn stays in dependencies, not devDependencies", () => {
    // Requirement 6.8. `shadcn` is a runtime dependency here rather than a CLI:
    // the stylesheet imports from it, so pruning it to devDependencies breaks
    // the production build.
    const manifest = readPackageJson()

    expect(Object.keys(manifest.dependencies ?? {})).toContain("shadcn")
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("shadcn")
  })

  test("globals.css still imports the stylesheet that makes it a dependency", () => {
    // The other half of Requirement 6.8, and the reason for it. Asserting the
    // import alongside the dependency keeps the pair legible as one fact: if
    // this line ever goes away, the dependency rule above stops being justified
    // by anything.
    expect(readProjectFile(GLOBALS_CSS)).toContain(
      '@import "shadcn/tailwind.css"'
    )
  })

  test("components.json is exactly as generated", () => {
    // Requirement 6.9. Whole-object equality rather than spot checks: this file
    // carries the preset's identity, and regenerating it silently changes the
    // design system. `style`, `baseColor`, `iconLibrary` and `rsc` are the four
    // that decide, respectively, the component shapes, the neutral ramp, which
    // icon package every generated component expects, and whether server
    // components are the default.
    expect(JSON.parse(readProjectFile("components.json"))).toEqual({
      $schema: "https://ui.shadcn.com/schema.json",
      style: "base-luma",
      rsc: true,
      tsx: true,
      tailwind: {
        config: "",
        css: "app/globals.css",
        baseColor: "mist",
        cssVariables: true,
        prefix: "",
      },
      iconLibrary: "phosphor",
      rtl: false,
      aliases: {
        components: "@/components",
        utils: "@/lib/utils",
        ui: "@/components/ui",
        lib: "@/lib",
        hooks: "@/hooks",
      },
      menuColor: "default",
      menuAccent: "subtle",
      registries: {},
    })
  })

  test("the light token block is unchanged", () => {
    // Transcribed values rather than a file hash: a hash breaks on the appended
    // blocks Requirement 6.9 permits and reports a failure nobody can read,
    // while this names the token that moved.
    expect(Object.fromEntries(presetTokenBlock(":root"))).toEqual(
      PRESET_ROOT_TOKENS
    )
  })

  test("the dark token block is unchanged", () => {
    expect(Object.fromEntries(presetTokenBlock(".dark"))).toEqual(
      PRESET_DARK_TOKENS
    )
  })

  test("dark --primary is darker than light --primary, as the preset intends", () => {
    // Counter-intuitive enough to look like a bug and get "fixed". It is the
    // preset's decision: a filled primary button in dark mode leans on
    // `--primary-foreground` for contrast, and chromatic *text* on a dark
    // surface uses `--sidebar-primary`, which is lifted rather than lowered.
    expect(oklchLightness(PRESET_DARK_TOKENS["--primary"])).toBeLessThan(
      oklchLightness(PRESET_ROOT_TOKENS["--primary"])
    )
    expect(
      oklchLightness(PRESET_DARK_TOKENS["--sidebar-primary"])
    ).toBeGreaterThan(oklchLightness(PRESET_DARK_TOKENS["--primary"]))
  })

  test("the token parser reads the block it claims to", () => {
    // The anchor for the parser. An empty map compared against an expected map
    // would fail loudly, but a parser that silently read the *second* `:root`
    // block would not — so the count and one known value are pinned.
    const root = presetTokenBlock(":root")

    expect(root.size).toBe(Object.keys(PRESET_ROOT_TOKENS).length)
    expect(root.get("--primary")).toBe("oklch(0.52 0.105 223.128)")
    expect(root.get("--radius")).toBe("0.625rem")
    // `--radius` is declared once, in `:root`. A dark override would be a real
    // change to the preset rather than an appended block.
    expect(presetTokenBlock(".dark").has("--radius")).toBe(false)
  })

  test("the @theme inline block maps all three font faces", () => {
    // The one additive edit this spec made to the file: `--font-mono` was
    // missing from `@theme inline` even though `next/font` sets the variable, so
    // `font-mono` resolved by stylesheet order. Pinned here with its two
    // siblings, so the appended line reads as part of the set rather than as a
    // stray.
    const source = readProjectFile(GLOBALS_CSS)
    const opening = source.indexOf("@theme inline {")

    expect(opening).toBeGreaterThan(-1)

    const block = source.slice(opening, source.indexOf("\n}", opening))

    expect(block).toContain("--font-sans: var(--font-sans);")
    expect(block).toContain("--font-heading: var(--font-heading);")
    expect(block).toContain("--font-mono: var(--font-mono);")
  })

  test("the radius scale is still the preset's multiplicative one", () => {
    // Controls are pills and surfaces are 10–14px only because these factors
    // hold. Flattening them is the change that would make a data table look
    // like a button.
    const source = readProjectFile(GLOBALS_CSS)

    for (const [token, factor] of [
      ["--radius-sm", "0.6"],
      ["--radius-md", "0.8"],
      ["--radius-xl", "1.4"],
      ["--radius-2xl", "1.8"],
      ["--radius-3xl", "2.2"],
      ["--radius-4xl", "2.6"],
    ] as const) {
      expect(source).toContain(`${token}: calc(var(--radius) * ${factor});`)
    }

    expect(source).toContain("--radius-lg: var(--radius);")
  })
})
