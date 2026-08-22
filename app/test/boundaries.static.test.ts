import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"
import { describe, expect, test } from "vitest"

import {
  ARTIFACT_SEGMENT_REPORTS,
  ARTIFACT_SEGMENT_SNAPSHOTS,
  DOWNLOADABLE_SEGMENTS,
  parseArtifactKey,
} from "@/lib/aws/s3"
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

describe("Requirement 9.2 — every write to a subscription moves updated_at", () => {
  const STORE = path.join("lib", "subscriptions", "store.ts")

  /**
   * The `.set({ … })` body of every `.update(connectedSubscriptions)` in the store.
   *
   * A text scan rather than an assertion against a database, because the claim is
   * about *which writers exist in the source*, and the integration suite can only
   * check the writers it happens to call. A writer added tomorrow that forgets
   * `updatedAt` would leave the inventory cache serving that row's previous listing
   * for five minutes — and every test of that writer would pass, because nothing it
   * asserts is about a column it does not set.
   */
  /** The text between the brace at `openIndex` and its match. */
  function bracedBody(source: string, openIndex: number): string {
    let depth = 0

    for (let index = openIndex; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1
      if (source[index] === "}") {
        depth -= 1
        if (depth === 0) return source.slice(openIndex + 1, index)
      }
    }

    return source.slice(openIndex + 1)
  }

  function updateSetBodies(source: string): readonly string[] {
    const bodies: string[] = []
    const marker = ".update(connectedSubscriptions)"

    for (
      let at = source.indexOf(marker);
      at !== -1;
      at = source.indexOf(marker, at + marker.length)
    ) {
      const setAt = source.indexOf(".set({", at)
      expect(
        setAt,
        `an .update(connectedSubscriptions) at index ${at} in ${STORE} has no ` +
          `.set({ … }) after it, so this scan cannot see what it writes`
      ).toBeGreaterThan(at)

      bodies.push(bracedBody(source, source.indexOf("{", setAt)))
    }

    return bodies
  }

  test("the scan finds every update in the store", () => {
    // Requirement 6.11 — a scan that found nothing would pass while proving nothing.
    // Two writers exist today: the secret rotation and the Azure-rejected disable.
    const bodies = updateSetBodies(readProjectFile(STORE))

    expect(bodies.length).toBeGreaterThanOrEqual(2)
  })

  test("every one of them sets updatedAt", () => {
    const offenders = updateSetBodies(readProjectFile(STORE)).filter(
      (body) => !body.includes("updatedAt")
    )

    expect(
      offenders,
      `these writes to connected_subscriptions do not move updated_at, so the ` +
        `inventory cache would go on serving the listing the previous row state ` +
        `produced (Requirement 9.2). A column that only ever holds its default is ` +
        `invalidation that never fires.`
    ).toEqual([])
  })

  test("the detector is not satisfied by a nearby mention", () => {
    // The scan reads the `.set` body, not the whole file, so a comment three
    // functions away naming the column does not acquit a writer that omits it.
    const withColumn =
      `x.update(connectedSubscriptions).set({ status: "disabled", ` +
      `updatedAt: new Date() }).where(y)`
    const without =
      `// updatedAt matters\n` +
      `x.update(connectedSubscriptions).set({ status: "disabled" }).where(y)`

    expect(updateSetBodies(withColumn)[0]).toContain("updatedAt")
    expect(updateSetBodies(without)[0]).not.toContain("updatedAt")
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
  const MARKED_BY_DECISION = [
    path.join("lib", "subscriptions", "preflight.ts"),
    // Same reasoning as `preflight.ts`: it reaches the runtime through
    // `lib/aws/agentcore.ts`, and it takes the customer's decrypted client secret as
    // an argument to put into an invoke payload.
    path.join("lib", "subscriptions", "inventory.ts"),
    // No credential and no SDK — a module-level `Map` of four string lists per row.
    // Marked because a client component must not be able to name it at all: the map
    // is one server process's memory, so an import from a client leaf would either
    // bundle a cache that can never hit or fail at build, and the second of those is
    // the failure worth having.
    path.join("lib", "subscriptions", "inventory-cache.ts"),
  ]

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

// --- Requirement 11.6 — no document upload exists in this product ----------

/**
 * The wizard directory, swept whole rather than by named file, so a component
 * added tomorrow is covered without an edit here.
 */
const TEMPLATE_COMPONENT_DIRECTORY = "components/templates"

/**
 * A file input, in the three spellings JSX can produce: the lowercase intrinsic
 * element, a `type` prop set to `"file"`, and the `accept` attribute that only
 * ever appears on one.
 *
 * Matched as source text rather than by rendering, deliberately. A render test
 * asserts what one component tree produced for one set of props; this asserts
 * that the *capability* is absent from the directory, which is the claim
 * Requirement 11.6 actually makes — "no control that uploads a document"
 * includes one behind a feature flag, one on a branch of a conditional, and one
 * a future prop would reveal.
 */
const FILE_INPUT_PATTERNS: readonly RegExp[] = [
  /type\s*=\s*["'{]?\s*["']file["']/,
  /<input[^>]*\btype\s*=\s*{?\s*["']file["']/,
  /\baccept\s*=\s*["'{]/,
]

/**
 * The document MIME types a template upload would name.
 *
 * `.docx`'s full type is spelled by joining, so this constant does not itself
 * contain the literal a scan would flag — the same trick `RUNTIME_ARN_LITERAL`
 * uses above, and for the same reason: a guard that contains the thing it
 * forbids cannot be grepped for cleanly.
 *
 * **Bare extensions are deliberately not here.** `.docx` and `.pdf` appear
 * throughout this codebase as prose — the renderer emits a `.docx`, the
 * delivered artifact is a `.pdf` — and a scan that flagged them would fail on a
 * docstring explaining why there is no upload. The extension case is covered
 * anyway and covered better: {@link FILE_INPUT_PATTERNS} forbids the `accept`
 * attribute outright, and an extension filter has nowhere else to live.
 */
const DOCUMENT_MIME_FRAGMENTS: readonly string[] = [
  [
    "application/vnd.openxmlformats-officedocument",
    "wordprocessingml.document",
  ].join("."),
  "application/msword",
]

describe("Requirement 11.6 — the wizard offers no document upload", () => {
  test("the template component directory is not empty", () => {
    // Requirement 6.11's discipline applied here: a sweep that passes because it
    // swept nothing is not a passing sweep. This whole describe is worthless the
    // day the directory is renamed and nobody notices.
    expect(
      listSourceFiles(TEMPLATE_COMPONENT_DIRECTORY).length
    ).toBeGreaterThan(0)
  })

  test.each(listSourceFiles(TEMPLATE_COMPONENT_DIRECTORY))(
    "%s renders no file input",
    (relativePath) => {
      const source = readFileSync(path.join(projectRoot, relativePath), "utf8")

      for (const pattern of FILE_INPUT_PATTERNS) {
        expect(
          pattern.test(source),
          `${relativePath} matches ${pattern} — a template is a composed ` +
            `definition, and there is no document-upload path in this product`
        ).toBe(false)
      }
    }
  )

  test.each(listSourceFiles(TEMPLATE_COMPONENT_DIRECTORY))(
    "%s names no document MIME type or extension",
    (relativePath) => {
      const source = readFileSync(path.join(projectRoot, relativePath), "utf8")

      for (const fragment of DOCUMENT_MIME_FRAGMENTS) {
        expect(
          source.includes(fragment),
          `${relativePath} names ${fragment}`
        ).toBe(false)
      }
    }
  )

  test("no route accepts a document body", () => {
    // The other half of the same claim. A wizard with no file input and a route
    // that would accept a `.docx` is one `curl` away from being an upload path,
    // and the requirement is about the product rather than about the UI.
    for (const relativePath of listSourceFiles("app/api")) {
      const source = readFileSync(path.join(projectRoot, relativePath), "utf8")

      for (const fragment of DOCUMENT_MIME_FRAGMENTS) {
        expect(
          source.includes(fragment),
          `${relativePath} names ${fragment}`
        ).toBe(false)
      }

      expect(
        /formData\s*\(/.test(source),
        `${relativePath} reads a multipart body; every route in this product ` +
          `takes JSON parsed by a named zod schema`
      ).toBe(false)
    }
  })
})

// ===========================================================================
// Task 15.1 — the remaining boundary rules
//
// Four groups, plus the completeness rule that covers every sweep in this file:
//
//   A  the two new data-layer stores carry the server-only marker (Req 6.1)
//   B  every handler this spec added declares the Node runtime (Req 6.7)
//   C  the artifact-key predicate admits exactly two segments (Req 43.2, 43.3)
//   D  no templating library and no figure arithmetic in `app/` (Req 11.6, 18.2,
//      20.2, 31.7)
//   E  every directory any sweep in this file walks exists and is non-empty
//      (Req 6.11)
//
// Group D is the only one that parses rather than greps. Everything above uses
// source text, which is right for a rule about an import specifier or a marker
// line, and wrong for "is this expression arithmetic": `.value / 2` and
// `.value // a comment` are one character apart in text and unrelated in a
// syntax tree. `typescript` is already a dev dependency and
// `property-hygiene.static.test.ts` already parses with it, so this adds
// nothing to the toolchain.
// ===========================================================================

// --- Group A: the new stores ------------------------------------------------

/**
 * Requirement 6.1 for this spec's two data-layer modules.
 *
 * Neither is reached by the Requirement 6.2 rule on its own merits: both go to
 * Postgres through `@/lib/db`, so they import no `@aws-sdk/*` package and no
 * `@/lib/crypto`, and {@link opensConnection} does not fire on them either —
 * `lib/db/index.ts` is the module that constructs the pool. They carry the
 * marker by **decision**, and this group is what makes that decision a failing
 * test rather than a comment.
 *
 * `lib/templates/` and `lib/verifications/` are classified module by module for
 * the same reason `lib/subscriptions/` is: a blanket sweep would mark the pure
 * modules that client leaves legitimately import. `definition.ts`, `blocks.ts`,
 * `composer.ts`, `period.ts` and `wizard.ts` are rendered by the wizard's client
 * components, and `lib/verifications/result.ts` is the artifact schema the
 * verification panel reads. Marking any of them would make the wizard
 * unbuildable.
 *
 * The union is asserted **exhaustive**, so a module added to either directory
 * has to be classified before this suite passes.
 */
const TEMPLATE_STORE = path.join("lib", "templates", "store.ts")
const VERIFICATION_STORE = path.join("lib", "verifications", "store.ts")

/** Marked because they open a DB connection through `@/lib/db` or reach S3. */
const SPEC_SERVER_ONLY_MODULES = [
  TEMPLATE_STORE,
  VERIFICATION_STORE,
  path.join("lib", "templates", "catalog.ts"),
  path.join("lib", "templates", "preview.ts"),
  path.join("lib", "templates", "seed.ts"),
  path.join("lib", "templates", "theme-thumbnails.ts"),
] as const

/** Pure: schemas, reducers and formatters, all imported by client components. */
const SPEC_PURE_MODULES = [
  path.join("lib", "templates", "blocks.ts"),
  path.join("lib", "templates", "canonical-json.ts"),
  path.join("lib", "templates", "composer.ts"),
  path.join("lib", "templates", "definition.ts"),
  path.join("lib", "templates", "draft.ts"),
  path.join("lib", "templates", "input.ts"),
  path.join("lib", "templates", "period.ts"),
  path.join("lib", "templates", "scope-union.ts"),
  path.join("lib", "templates", "starters.ts"),
  path.join("lib", "templates", "version.ts"),
  path.join("lib", "templates", "wizard.ts"),
  path.join("lib", "verifications", "result.ts"),
] as const

describe("Requirement 6.1 — the template and verification stores are server-only", () => {
  test.each([TEMPLATE_STORE, VERIFICATION_STORE])(
    "%s begins with the marker",
    (modulePath) => {
      expect(firstCodeLine(modulePath)).toBe(SERVER_ONLY_MARKER)
    }
  )

  test.each(SPEC_SERVER_ONLY_MODULES)(
    "%s begins with the marker",
    (modulePath) => {
      expect(firstCodeLine(modulePath)).toBe(SERVER_ONLY_MARKER)
    }
  )

  test.each([TEMPLATE_STORE, VERIFICATION_STORE])(
    "%s is marked by decision — no rule forces it",
    (modulePath) => {
      // The half worth asserting. If either grew a direct `@aws-sdk/*` or
      // `@/lib/crypto` import it would be reached by Requirement 6.2 and belong
      // in that group instead, and this failure is what says so rather than
      // leaving two groups quietly overlapping.
      const source = readProjectFile(modulePath)

      expect(requiresServerOnly(source)).toBe(false)
      expect(opensConnection(source)).toBe(false)
      // It does reach the database, through the one module that opens the pool.
      expect(source).toContain('from "@/lib/db"')
    }
  )

  test("both directories are classified exhaustively", () => {
    // Requirement 6.11 in the form it takes for a hand-written list: the listing
    // is asserted against the modules that exist, in both directions, so a module
    // added here fails until it is classified and a classification naming a
    // deleted module fails too.
    const found = [
      ...listSourceFiles(path.join("lib", "templates")),
      ...listSourceFiles(path.join("lib", "verifications")),
    ].sort()

    expect(found.length).toBeGreaterThan(0)
    expect(found).toEqual(
      [...SPEC_SERVER_ONLY_MODULES, ...SPEC_PURE_MODULES].sort()
    )
  })

  test.each(SPEC_PURE_MODULES)(
    "%s is pure and deliberately unmarked",
    (modulePath) => {
      const source = readProjectFile(modulePath)

      expect(hasServerOnlyMarker(modulePath)).toBe(false)
      expect(requiresServerOnly(source)).toBe(false)
      expect(opensConnection(source)).toBe(false)
    }
  )

  test("neither directory is in the blanket sweep", () => {
    expect([...SERVER_ONLY_DIRECTORIES]).not.toContain("lib/templates")
    expect([...SERVER_ONLY_DIRECTORIES]).not.toContain("lib/verifications")
  })
})

// --- Group B: the handlers this spec added ---------------------------------

/**
 * Requirement 6.7 for the four handlers this spec adds.
 *
 * The rule above already asserts the declaration for **every** `app/**\/route.ts`,
 * which covers these by construction — so this group is not a second rule, it is
 * the anchor for that one. "Every handler declares it" is also what a listing
 * that stopped finding these four would report, and each of them is long-running
 * in a way that makes the edge runtime specifically wrong: the preview handler
 * drives a real `.docx` → `.pdf` render, the verification callback writes run
 * state, and the two template handlers open a Postgres connection.
 */
const SPEC_ROUTE_HANDLERS = [
  path.join("app", "api", "templates", "route.ts"),
  path.join("app", "api", "templates", "[id]", "route.ts"),
  path.join("app", "api", "templates", "[id]", "preview", "route.ts"),
  path.join("app", "api", "templates", "catalog", "route.ts"),
  path.join(
    "app",
    "api",
    "internal",
    "runs",
    "[runId]",
    "verification",
    "route.ts"
  ),
] as const

describe("Requirement 6.7 — this spec's handlers run on the Node runtime", () => {
  test("the route listing reaches every one of them", () => {
    const handlers = listRouteHandlers()

    for (const handler of SPEC_ROUTE_HANDLERS) {
      expect(
        handlers,
        `${handler} is not seen by listRouteHandlers()`
      ).toContain(handler)
    }
  })

  test.each(SPEC_ROUTE_HANDLERS)("%s declares it", (handler) => {
    expect(declaresNodeRuntime(readProjectFile(handler))).toBe(true)
  })
})

// --- Group C: the artifact-key predicate -----------------------------------

/**
 * Requirements 43.2 and 43.3 — the closed set of downloadable key segments,
 * asserted here as a **boundary** rather than as a unit of `parseArtifactKey`.
 *
 * `lib/aws/s3.test.ts` already pins the set and the parser's behaviour. What this
 * adds is the structural claim: the set is the only gate, so a preview is
 * unreachable through the report download path **however** the caller asks, and a
 * third segment cannot be admitted by editing a route. Asserted by importing the
 * constant rather than by re-listing it, so this file cannot pass while holding a
 * stale second copy of the answer.
 */
const EXPECTED_DOWNLOADABLE_SEGMENTS = ["reports", "snapshots"] as const

describe("Requirements 43.2, 43.3 — exactly two artifact-key segments", () => {
  test("the predicate admits `snapshots` and `reports` and nothing else", () => {
    expect([...DOWNLOADABLE_SEGMENTS].sort()).toEqual([
      ...EXPECTED_DOWNLOADABLE_SEGMENTS,
    ])
  })

  test("the set is frozen, so no caller can widen it at run time", () => {
    // A `ReadonlySet` type is erased. `Object.freeze` is what makes the closed set
    // closed in a running process, and a route that called `.add("previews")` would
    // otherwise widen the gate for every other route in the same process.
    expect(Object.isFrozen(DOWNLOADABLE_SEGMENTS)).toBe(true)
  })

  test.each(EXPECTED_DOWNLOADABLE_SEGMENTS)("a %s key parses", (segment) => {
    expect(parseArtifactKey(`alice/${segment}/run-1/artifact.bin`)).toEqual({
      actorId: "alice",
      kind: segment,
      runId: "run-1",
      rest: "artifact.bin",
    })
  })

  test.each([
    "previews",
    "Snapshots",
    "SNAPSHOTS",
    "reports2",
    "report",
    "raw",
    "",
  ])("a %s key does not", (segment) => {
    // `previews` is the one that matters: a preview is written under
    // `<actor>/previews/<previewId>/preview.pdf` and served inline by a route with
    // its own key template, so the download path is structurally unable to serve
    // one. The case variants are here because S3 keys are byte strings and
    // case-folding here would authorize against a key the writer never wrote.
    expect(parseArtifactKey(`alice/${segment}/run-1/artifact.bin`)).toBeNull()
  })

  test("the source declares the set from the two named constants", () => {
    // The static half. The values above could be satisfied by a literal pair
    // inlined at the call site; this pins the single declaration the parser reads,
    // so a second gate somewhere else is a visible edit rather than a quiet one.
    const source = readProjectFile(path.join("lib", "aws", "s3.ts"))

    expect(source).toContain("export const DOWNLOADABLE_SEGMENTS")
    expect(source).toContain(
      "new Set([ARTIFACT_SEGMENT_SNAPSHOTS, ARTIFACT_SEGMENT_REPORTS])"
    )
    expect(ARTIFACT_SEGMENT_SNAPSHOTS).toBe("snapshots")
    expect(ARTIFACT_SEGMENT_REPORTS).toBe("reports")
  })
})

// --- Group D: no templating, and no figure arithmetic ----------------------

/**
 * The JS equivalents of `docxtpl`, as **quoted module specifiers**.
 *
 * Two families, banned for one reason each:
 *
 * - **Document templaters** — `docxtemplater`, `docx-templates`,
 *   `easy-template-x`, and `docx` itself. A template here is a versioned JSON
 *   definition compiled to a typed AST, and a figure is the AST's only numeric
 *   leaf. A document templater reintroduces exactly the hole that closes: an
 *   expression in a document produces a number with no `snapshot_path`, which the
 *   verifier cannot trace and therefore cannot prove.
 * - **General text templaters** — `handlebars`, `mustache`, `nunjucks`, `ejs`,
 *   `liquidjs`, `pug`, `eta`, `dot`. Banned in the same rule because the
 *   requirement is about a *user-facing template language*, and reaching one of
 *   these is how a placeholder syntax gets introduced without anybody deciding to
 *   introduce one.
 *
 * Matched as a quoted specifier so prose naming a package is not a hit — this
 * file's own comment above names most of them.
 */
const TEMPLATING_PACKAGES = [
  "docxtemplater",
  "docx-templates",
  "easy-template-x",
  "docx",
  "handlebars",
  "mustache",
  "nunjucks",
  "ejs",
  "liquidjs",
  "pug",
  "eta",
  "dot",
] as const

/**
 * Arbitrary-precision arithmetic libraries.
 *
 * `app/` computes no figure: every number a consultant reads was quantized,
 * rounded and formatted by `agent/src/reporting_agent/compile/format.py`, and the
 * app renders the resulting `formatted` string verbatim. So there is nothing here
 * for a decimal library to do, and reaching for one is the signature of the
 * mistake — a second rounding path, on the browser side of the boundary, that no
 * verification covers.
 */
const DECIMAL_PACKAGES = [
  "decimal.js",
  "decimal.js-light",
  "big.js",
  "bignumber.js",
] as const

/**
 * `import … from "pkg"`, `import "pkg"`, `import("pkg")`, `require("pkg")` —
 * subpaths included.
 *
 * Anchored on the **import position**, not on the quoted string alone. A bare
 * quoted-string match is what this rule was written as first, and it failed on two
 * files that import nothing of the kind: the preview route has a
 * `PreviewStage = "compilation" | "docx" | "pdf"` union, and `components/ui/chart.tsx`
 * takes an `indicator?: "line" | "dot" | "dashed"` prop. Both are ordinary string
 * literals that happen to spell a package name, and short package names like `dot`
 * and `eta` make that collision likely rather than exotic.
 */
function importsPackage(source: string, packageName: string): boolean {
  const escaped = packageName.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `(?:\\bfrom|\\bimport|\\brequire)\\s*\\(?\\s*["']${escaped}(/[^"']*)?["']`
  ).test(source)
}

// --- Group D, the parsed half ----------------------------------------------

/** Parsed with position info, so a failure can name a line. */
function parseTsModule(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readProjectFile(relativePath),
    ts.ScriptTarget.Latest,
    true
  )
}

function parseTsSource(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "synthetic.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
}

function walkTs(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walkTs(child, visit))
}

/**
 * The property names a figure's numeric content arrives under.
 *
 * `value` is the snapshot's fixed-precision decimal string and `formatted` is the
 * display string the renderer emitted. Both are strings, and both are things this
 * half of the product may only pass through.
 */
const FIGURE_PROPERTY_NAMES = new Set(["value", "formatted"])

/**
 * Receivers whose `.value` is a DOM control's value, not a figure's.
 *
 * `event.target.value` is a `<select>`'s selected id in `run-form.tsx`, and
 * `React.ChangeEvent` exposes it under exactly these two names. Coercing one with
 * `Number()` would be ordinary form handling and is not what this rule is about,
 * so the two are distinguished **structurally** — by the receiver — rather than by
 * a path exemption.
 *
 * This is a closed set taken from React's own typings rather than an open-ended
 * escape hatch, which is the distinction that matters: widening it means naming a
 * third DOM property that carries a value, and there isn't one.
 */
const DOM_EVENT_RECEIVERS = new Set(["target", "currentTarget"])

/**
 * The unambiguously arithmetic operators: one figure operand is enough.
 *
 * A figure's `value` and `formatted` are both **strings**, so `-`, `*`, `/`, `%`
 * and `**` cannot mean anything but "coerce this to a number and compute with
 * it" — which is the thing being banned, whatever the other operand is.
 */
const ARITHMETIC_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
])

/**
 * `+`, which needs **both** operands to be figure reads before it is an offence.
 *
 * `+` is the one operator that is arithmetic or concatenation depending on its
 * operands, and the split falls out of that rather than out of taste:
 *
 * - `a.value + b.value` — two figures. Either it sums them, or it welds two
 *   display strings into one token the ledger never recorded. Both are this half
 *   of the product computing a figure, so it is an offence.
 * - `"CPU " + figure.formatted` — one figure and a literal. That is prose composed
 *   around a figure whose string is passed through untouched, which is exactly
 *   what a report component is for, and it is the same operation as
 *   `` `CPU ${figure.formatted}` ``. Banning one spelling and permitting the other
 *   would teach the code which spelling evades the guard.
 *
 * A `+` that decorates a `formatted` string with a caveat of its own is forbidden
 * too, by Requirement 18.2 — but that is a rule about *what* is appended, not
 * about the operator, so it is not this guard's to make. Pretending otherwise here
 * would mean failing every component that puts a figure in a sentence.
 */
const CONCATENATION_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.PlusEqualsToken,
])

/** The numeric coercions. `Number`, `parseFloat`, `parseInt`, and unary `+`/`-`. */
const NUMERIC_COERCIONS = new Set([
  "Number",
  "parseFloat",
  "parseInt",
  "BigInt",
])

/** Is this expression a read of a figure's `value` or `formatted`? */
function readsFigureProperty(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false
  if (!FIGURE_PROPERTY_NAMES.has(node.name.text)) return false

  const receiver = node.expression
  if (
    ts.isPropertyAccessExpression(receiver) &&
    DOM_EVENT_RECEIVERS.has(receiver.name.text)
  ) {
    return false
  }

  return true
}

type Offender = {
  readonly file: string
  readonly line: number
  readonly what: string
}

/**
 * Every computation over a figure property in one parsed module.
 *
 * Four shapes: a binary arithmetic expression with a figure read (either side for
 * {@link ARITHMETIC_OPERATORS}, both sides for {@link CONCATENATION_OPERATORS}), a
 * unary `+`/`-` applied to one, a `Number(…)`-family call taking one, and an
 * increment or decrement of one.
 *
 * Takes a parsed `SourceFile` rather than a path so the detector self-tests below
 * run **this** function over synthetic sources instead of a second copy of the
 * walk. A guard whose self-test reimplements the rule tests the copy.
 */
function figureComputationOffenders(
  source: ts.SourceFile,
  label: string
): readonly Offender[] {
  const found: Offender[] = []

  const at = (node: ts.Node, what: string): void => {
    found.push({
      file: label,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      what,
    })
  }

  walkTs(source, (node) => {
    if (ts.isBinaryExpression(node)) {
      const left = readsFigureProperty(node.left)
      const right = readsFigureProperty(node.right)

      if (
        ARITHMETIC_OPERATORS.has(node.operatorToken.kind) &&
        (left || right)
      ) {
        at(node, "arithmetic on a figure property")
        return
      }
      if (
        CONCATENATION_OPERATORS.has(node.operatorToken.kind) &&
        left &&
        right
      ) {
        at(node, "two figure properties combined with +")
        return
      }
      return
    }

    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      readsFigureProperty(node.operand)
    ) {
      at(node, "unary arithmetic on a figure property")
      return
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      NUMERIC_COERCIONS.has(node.expression.text) &&
      node.arguments.some(readsFigureProperty)
    ) {
      at(node, `${node.expression.text}() over a figure property`)
    }
  })

  return found
}

/** {@link figureComputationOffenders} over a module read from disk. */
function figureArithmeticOffenders(relativePath: string): readonly Offender[] {
  return figureComputationOffenders(parseTsModule(relativePath), relativePath)
}

const REPORT_COMPONENT_DIRECTORY = path.join("components", "reports")

describe("Requirements 18.2, 20.2 — app/ computes no figure", () => {
  test("the report component directory is not empty", () => {
    // Requirement 6.11. The rules below are the ones most prone to passing over
    // nothing, because a clean tree and an empty scan produce the same `[]`.
    expect(
      listSourceFiles(REPORT_COMPONENT_DIRECTORY).length,
      `${REPORT_COMPONENT_DIRECTORY} is absent or holds no source file`
    ).toBeGreaterThan(0)
  })

  test("no component under components/reports/ computes over a figure", () => {
    const offenders = listSourceFiles(REPORT_COMPONENT_DIRECTORY).flatMap(
      (file) => figureArithmeticOffenders(file)
    )

    expect(
      offenders.map(({ file, line, what }) => `${file}:${line} ${what}`),
      `every number a consultant reads was quantized and formatted by the ` +
        `agent's compile/format.py; this half renders the ledger's formatted ` +
        `string verbatim (Requirement 18.2)`
    ).toEqual([])
  })

  test("no source file in app/ imports an arbitrary-precision decimal library", () => {
    for (const packageName of DECIMAL_PACKAGES) {
      expect(
        [...declaredDependencyNames()],
        `${packageName} is declared; app/ computes no figure`
      ).not.toContain(packageName)

      const offenders = allSourceFiles().filter((file) =>
        importsPackage(readProjectFile(file), packageName)
      )

      expect(offenders, `these files import ${packageName}`).toEqual([])
    }
  })

  test("the DOM carve-out is exercised and is a receiver rule, not a path one", () => {
    // Asserting the carve-out is *used* is what stops it being dead weight that
    // could be widened unnoticed: `run-form.tsx` reads `event.target.value`, so a
    // rule without it would fail on ordinary form handling, and a rule that
    // exempted the file instead would stop covering a real figure read in it.
    const runForm = readProjectFile(
      path.join("components", "reports", "run-form.tsx")
    )

    expect(runForm).toContain("event.target.value")
    expect(
      figureArithmeticOffenders(
        path.join("components", "reports", "run-form.tsx")
      )
    ).toEqual([])
  })
})

describe("Requirement 11.6 — no templating library reaches this product", () => {
  test.each(TEMPLATING_PACKAGES)(
    "%s is not a declared dependency",
    (packageName) => {
      expect([...declaredDependencyNames()]).not.toContain(packageName)
    }
  )

  test("no source file imports one", () => {
    const offenders = allSourceFiles().flatMap((file) => {
      const source = readProjectFile(file)
      return TEMPLATING_PACKAGES.filter((pkg) =>
        importsPackage(source, pkg)
      ).map((pkg) => `${file} imports ${pkg}`)
    })

    expect(
      offenders,
      `a template here is a versioned JSON definition compiled to a typed AST; ` +
        `a document templater reintroduces a figure with no snapshot_path`
    ).toEqual([])
  })

  test("the specifier detector matches an import and not prose", () => {
    // `dot` and `eta` are short enough to appear inside other names, and `docx`
    // is a substring of `docx-templates` — so the detector is pinned against
    // both the forms it must catch and the ones it must not.
    expect(
      importsPackage(
        'import Docxtemplater from "docxtemplater"',
        "docxtemplater"
      )
    ).toBe(true)
    expect(importsPackage('require("handlebars")', "handlebars")).toBe(true)
    expect(importsPackage('await import("nunjucks/browser")', "nunjucks")).toBe(
      true
    )
    expect(importsPackage('from "docx"', "docx")).toBe(true)
    // A different package whose name merely starts the same way.
    expect(importsPackage('from "docx-preview"', "docx")).toBe(false)
    expect(importsPackage('from "dotenv"', "dot")).toBe(false)
    expect(importsPackage('from "@types/eta-lang"', "eta")).toBe(false)
    // Prose naming the package is not an import, which is why this file may
    // discuss them a few lines above without failing its own rule.
    expect(importsPackage("// no docxtemplater here", "docxtemplater")).toBe(
      false
    )
    expect(importsPackage("a .docx is emitted by the agent", "docx")).toBe(
      false
    )
  })

  test.each([
    "const t = figure.value + other.value",
    "const t = a.formatted + b.formatted",
    "const t = entry.value * 100",
    "const t = a.formatted / 2",
    "const t = -figure.value",
    "const n = Number(figure.value)",
    "const n = parseFloat(entry.value)",
    "const n = parseInt(row.cells[0].value)",
    "const n = BigInt(figure.value)",
    "let x = 1; x -= figure.value",
    "const t = ledger[path].value % 7",
    "const t = figure.value ** 2",
  ])("the detector fires on %s", (source) => {
    // Guard the guard. `components/reports/` is clean, so a green rule above
    // proves nothing until the detector has been seen to go red. Run through the
    // same function the rule uses, so a self-test cannot pass against a copy.
    expect(
      figureComputationOffenders(parseTsSource(source), "synthetic.tsx")
    ).not.toEqual([])
  })

  test.each([
    // The sanctioned move: render the string the ledger carries.
    "const text = figure.formatted",
    "const node = <span>{figure.formatted}</span>",
    "const strings = ledger.map((f) => f.formatted)",
    // Prose composed around a figure. Both spellings, deliberately — see
    // CONCATENATION_OPERATORS for why one operand is not enough.
    'const label = "CPU " + figure.formatted',
    "const label = `${figure.formatted} in ${period}`",
    // Ordinary form handling. `event.target.value` is a selected id, not a figure.
    "const h = (event) => setId(event.target.value)",
    "const n = Number(event.target.value)",
    "const n = Number(event.currentTarget.value)",
    // Arithmetic on things that are not figures.
    "const next = index + 1",
    "const width = bounds.height / 2",
    // A comparison is not arithmetic.
    "const same = figure.formatted === recorded",
  ])("the detector permits %s", (source) => {
    expect(
      figureComputationOffenders(parseTsSource(source), "synthetic.tsx")
    ).toEqual([])
  })
})

// --- Group E: the completeness rule over every sweep in this file ----------

/**
 * Requirement 6.11, consolidated.
 *
 * Every rule in this file is "list some files, assert no offender", and both
 * halves are true of the empty list. Individual rules assert their own scan is
 * non-empty where they can, but the *listings* are keyed on directory names, so a
 * renamed or moved directory turns a rule into a no-op **and removes the failure
 * that would say so**.
 *
 * So the directories are declared once, here, and asserted to exist and yield
 * source files. `hooks/` is the one deliberate omission and it is the reason this
 * is a declaration rather than a sweep of `SOURCE_DIRECTORIES`: it holds no hook
 * yet, and the Requirement 6.2 rule that walks it covers the union of four
 * directories, so an unpopulated one is not the hole this rule closes.
 */
const SWEPT_DIRECTORIES = [
  "lib",
  "lib/auth",
  "lib/aws",
  "lib/db",
  "lib/subscriptions",
  "lib/templates",
  "lib/verifications",
  "app",
  "app/api",
  "components",
  "components/reports",
  "components/templates",
  "components/charts",
] as const

describe("Requirement 6.11 — no sweep in this file may pass over nothing", () => {
  test.each(SWEPT_DIRECTORIES)(
    "%s exists and yields at least one source file",
    (directory) => {
      expect(
        listSourceFiles(directory).length,
        `${directory} is absent or holds no source file, so every rule scanning ` +
          `it asserts nothing`
      ).toBeGreaterThan(0)
    }
  )

  test("every directory the rules name is declared here", () => {
    // Ties the declaration to the rules that consume it rather than to the
    // filesystem: without this, the list above could agree with the tree
    // perfectly while a rule swept a name in neither — a sweep of
    // `components/report` would be a permanent no-op and nothing would fail.
    const named = new Set<string>([
      ...SOURCE_DIRECTORIES.filter((directory) => directory !== "hooks"),
      ...SERVER_ONLY_DIRECTORIES,
      "lib/db",
      "lib/subscriptions",
      TEMPLATE_COMPONENT_DIRECTORY,
      REPORT_COMPONENT_DIRECTORY.split(path.sep).join("/"),
      "app/api",
      path.dirname(TEMPLATE_STORE).split(path.sep).join("/"),
      path.dirname(VERIFICATION_STORE).split(path.sep).join("/"),
    ])

    const declared = new Set<string>(SWEPT_DIRECTORIES)

    expect([...named].filter((directory) => !declared.has(directory))).toEqual(
      []
    )
  })

  test("an absent directory yields nothing rather than throwing", () => {
    // The behaviour the rule above depends on, asserted rather than assumed: if
    // `listSourceFiles` threw on an absent directory the failure would still be
    // loud, but if it ever started returning a placeholder the rule would pass
    // over a directory that does not exist.
    expect(listSourceFiles("lib/does-not-exist")).toEqual([])
    expect(listSourceFiles("components/nope/nested")).toEqual([])
  })

  test("a directory holding only tests yields nothing, and that is a failure here", () => {
    // The subtler half of Requirement 6.11: `isSourceFileName` excludes test
    // files, so a directory holding nothing but `*.test.ts` is an empty scan even
    // though it is full of files. Pinned on the classifier rather than on a
    // fixture directory, because creating one would be creating the hole.
    expect(isSourceFileName("only.test.ts")).toBe(false)
    expect(isSourceFileName("only.test.tsx")).toBe(false)
    expect(isSourceFileName("real.ts")).toBe(true)
  })
})
