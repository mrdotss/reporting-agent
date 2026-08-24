import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The property ledger: what ran, under which framework, and on what seed
 * (Requirements 45.7, 45.8).
 *
 * `test/property-hygiene.static.test.ts` proves things about the *source* of the
 * property modules — that none is skipped, that none lowers `numRuns`, that no
 * declared case was deleted. Every one of those reads a file, and none of them
 * can see whether a property that was written actually **ran**, how many
 * generated cases it accepted, or how much of its input `fc.pre` threw away.
 *
 * Requirements 45.7 and 45.8 are about that gap:
 *
 * - **45.7** — the set of properties *executed* must equal the set this spec
 *   *declares*. A property added to design.md and never registered fails, and so
 *   does one registered and never run. {@link SPEC_PROPERTIES} below is the
 *   declaration, keyed by design property number, so the two documents are
 *   compared rather than assumed equal.
 * - **45.8** — each property records its framework, its accepted-case count, its
 *   precondition rejection fraction and its seed **in the suite's own output**.
 *   Requirement 45.4's thresholds — 100 accepted, generation not exhausted, at
 *   most 20% rejected — are then observable rather than asserted about in a
 *   comment.
 *
 * **Why there is a file involved.** Vitest evaluates each test file in its own
 * module registry, so a ledger held in memory by `test/setup.ts` is per-file and
 * invisible to every other file, including the guard. Each file therefore writes
 * its own records to {@link LEDGER_DIRECTORY} as it finishes, one JSON document
 * per file so nothing races, and `test/property-ledger.global.ts` — the node
 * project's `globalSetup` — empties that directory before the run and reads the
 * whole of it after, which is the only vantage point in Vitest that sees every
 * file. The agent half is `agent/tests/property_ledger.py`; one requirement, two
 * languages, deliberately parallel.
 */

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

/** Git-ignored. Emptied at the start of every run by the global setup. */
export const LEDGER_DIRECTORY = path.join(
  projectRoot,
  ".vitest-property-ledger"
)

/** Requirement 45.1 — the framework this half runs its properties under. */
export const FAST_CHECK = "fast-check"

/** Requirement 45.1 — the floor, per design property. */
export const MINIMUM_ACCEPTED = 100

/** Requirement 45.4 — the ceiling on cases a precondition threw away. */
export const MAXIMUM_REJECTION_FRACTION = 0.2

export type PropertyDeclaration = {
  readonly label: string
  readonly title: string
  readonly modules: readonly string[]
}

/**
 * Requirement 45.7 — design.md's web-side set for this spec: Properties 8 to 12,
 * run with `fast-check`.
 *
 * Module-level rather than call-site level, because a design property is one
 * claim and each `fc.assert` in its module asserts part of it — Property 9 is
 * *"period resolution is correct at every offset and every edge"*, all six
 * `fc.assert` calls of it.
 */
export const SPEC_PROPERTIES: Readonly<Record<number, PropertyDeclaration>> = {
  8: {
    label: "Property 8",
    title: "Definition validation is total and reports every violation",
    modules: ["lib/templates/definition.property.test.ts"],
  },
  9: {
    label: "Property 9",
    title: "Period resolution is correct at every offset and every edge",
    modules: ["lib/templates/period.property.test.ts"],
  },
  10: {
    label: "Property 10",
    title: "The composer reducer is confined, announced and refusal-safe",
    modules: ["lib/templates/composer.property.test.ts"],
  },
  11: {
    label: "Property 11",
    title: "The definition digest is stable, sensitive and cross-language",
    modules: ["lib/templates/version.property.test.ts"],
  },
  12: {
    label: "Property 12",
    title: "Artifact-key authorization is an exact segment match",
    modules: ["lib/aws/s3.property.test.ts"],
  },
}

/**
 * The foundation spec's web-side properties. Declared for one reason: together
 * with {@link SPEC_PROPERTIES} they partition the property modules on disk, so a
 * module belonging to no property fails the guard instead of sitting outside
 * every gate.
 *
 * Only one of them is numbered. Property 5 is a single claim asserted across both
 * halves of the monorepo — the agent registers the secret *values* and scrubs
 * them, the app strips the *field names* structurally — so its web half is
 * numbered and its two companions are not: the foundation declared them as
 * properties of a named module rather than as entries in a numbered list.
 */
export const FOUNDATION_PROPERTIES: readonly PropertyDeclaration[] = [
  {
    label: "foundation Property 5 (web half)",
    title: "No secret-named field survives the relay projection",
    modules: ["lib/aws/redact.property.test.ts"],
  },
  {
    label: "foundation — lib/crypto.ts",
    title:
      "Envelope encryption round-trips and rejects every tampered ciphertext",
    modules: ["lib/crypto.property.test.ts"],
  },
  {
    label: "foundation — lib/subscriptions/azure-artifacts.ts",
    title: "The generated onboarding artifacts grant Reader and nothing else",
    modules: ["lib/subscriptions/azure-artifacts.property.test.ts"],
  },
]

/**
 * The **breadth-and-document** spec's web-side properties, keyed by *its* property numbers.
 *
 * A third record rather than more entries in {@link SPEC_PROPERTIES}, because the two specs
 * number their properties independently and both reach 9: the templates spec's Property 9 is
 * period resolution and this one's is the number-format defaults. Merging them would need one
 * of the two renumbered, which would make every cross-reference in the other spec's design
 * document wrong — and a key collision in an object literal loses one silently, which is the
 * worse of the two outcomes by far.
 *
 * `declaredProperties()` folds all three together, so the completeness gates read one set and
 * a module belonging to no property still fails whichever spec introduced it.
 */
export const BREADTH_PROPERTIES: Readonly<Record<number, PropertyDeclaration>> =
  {
    4: {
      label: "breadth Property 4",
      title: "Gap grouping is lossless",
      modules: ["test/property/gap-groups.property.test.ts"],
    },
    7: {
      label: "breadth Property 7",
      title: "A picked scope stays a rule",
      modules: ["test/property/scope-picker.property.test.ts"],
    },
    8: {
      label: "breadth Property 8",
      title:
        "Block-config options are drawn from the metric selection and the fact declaration",
      modules: ["test/property/config-options.property.test.ts"],
    },
    9: {
      label: "breadth Property 9",
      title:
        "The number-format defaults are language-derived and never overwrite a declaration",
      modules: ["test/property/number-format-defaults.property.test.ts"],
    },
  }

export function declaredProperties(): readonly PropertyDeclaration[] {
  return [
    ...Object.values(SPEC_PROPERTIES),
    ...Object.values(BREADTH_PROPERTIES),
    ...FOUNDATION_PROPERTIES,
  ]
}

/**
 * Requirement 45.7 — how many `fc.assert` executions each declared module
 * produces today, as a **ratchet**. The count may grow; it may not shrink.
 *
 * This is the half of "registered and never run" that a per-execution threshold
 * cannot see: eight of nine properties running leaves every recorded number
 * healthy and one claim unasserted. The counts are executions rather than call
 * sites because a `test.each` block is one `fc.assert` run many times —
 * `azure-artifacts` has nine sites and nineteen executions — and executions are
 * what the ledger can count without guessing which site produced which record.
 *
 * `test/property-hygiene.static.test.ts` ties each entry to the source: it fails
 * unless the entry is at least the number of `fc.assert` calls the module
 * contains, so adding a property forces the ratchet up rather than leaving it
 * behind.
 */
export const MINIMUM_EXECUTIONS: Readonly<Record<string, number>> = {
  "lib/aws/redact.property.test.ts": 5,
  "lib/aws/s3.property.test.ts": 9,
  "lib/crypto.property.test.ts": 5,
  "lib/subscriptions/azure-artifacts.property.test.ts": 19,
  "lib/templates/composer.property.test.ts": 4,
  "lib/templates/definition.property.test.ts": 5,
  "lib/templates/period.property.test.ts": 6,
  "lib/templates/version.property.test.ts": 6,
  "test/property/config-options.property.test.ts": 12,
  "test/property/gap-groups.property.test.ts": 5,
  "test/property/scope-picker.property.test.ts": 8,
  "test/property/number-format-defaults.property.test.ts": 9,
}

/** The declared property that claims this module, if any claims it. */
export function declarationFor(
  modulePath: string
): PropertyDeclaration | undefined {
  return declaredProperties().find((declaration) =>
    declaration.modules.includes(modulePath)
  )
}

/** Every declared module, mapped to the label of the property that claims it. */
export function declaredModules(): ReadonlyMap<string, string> {
  const owners = new Map<string, string>()
  for (const declaration of declaredProperties()) {
    for (const modulePath of declaration.modules) {
      owners.set(modulePath, declaration.label)
    }
  }
  return owners
}

// --- Records ---------------------------------------------------------------

/**
 * One `fc.assert` execution, as fast-check's own `RunDetails` reported it.
 *
 * `accepted` is `numRuns`, which fast-check sets to the number of cases that
 * actually ran the property body, and `rejected` is `numSkips`, the cases
 * `fc.pre` discarded. The two are kept apart because Requirement 45.4 bounds the
 * second as a fraction of their sum.
 *
 * `declaredCases` is how many cases this `fc.assert` was handed as declared
 * examples. fast-check yields them from the **same** budget as generated ones, so
 * a property with five declared cases at `numRuns: 100` runs 95 generated cases —
 * which is why the static guard already requires `numRuns >= 100 + cases` and why
 * {@link acceptedGenerated} takes them back out before any threshold reads the
 * number. That subtraction is Requirement 45.5's "in addition to the 100-case
 * minimum" as arithmetic rather than as a convention.
 *
 * It is a count of *runs*, not of distinct counterexamples: three properties
 * sharing one six-case array record six each. `MINIMUM_DECLARED_CASES` in the
 * static guard is the one that counts them distinctly, because that is the
 * question retention asks.
 */
export type Execution = {
  readonly modulePath: string
  readonly testName: string
  readonly framework: string
  readonly accepted: number
  readonly rejected: number
  readonly declaredCases: number
  readonly seed: number
  readonly failed: boolean
}

export function rejectionFraction(execution: Execution): number {
  const generated = execution.accepted + execution.rejected
  return generated === 0 ? 0 : execution.rejected / generated
}

/** Accepted cases excluding the declared ones, which run in addition (45.5). */
export function acceptedGenerated(execution: Execution): number {
  return Math.max(0, execution.accepted - execution.declaredCases)
}

// --- The ledger on disk ----------------------------------------------------

export function resetLedger(): void {
  rmSync(LEDGER_DIRECTORY, { recursive: true, force: true })
  mkdirSync(LEDGER_DIRECTORY, { recursive: true })
}

/** A stable, filesystem-safe name for one test file's records. */
export function ledgerFileFor(modulePath: string): string {
  // The empty path is the case where Vitest reported no `testPath`; naming it after
  // the worker keeps two such files from clobbering each other.
  const name = modulePath === "" ? `unattributed-${process.pid}` : modulePath
  return path.join(LEDGER_DIRECTORY, `${name.replace(/[^\w.-]+/g, "_")}.json`)
}

export function readLedger(): readonly Execution[] {
  if (!existsSync(LEDGER_DIRECTORY)) return []

  const records: Execution[] = []
  for (const entry of readdirSync(LEDGER_DIRECTORY)) {
    if (!entry.endsWith(".json")) continue
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(LEDGER_DIRECTORY, entry), "utf8")
    )
    if (Array.isArray(parsed)) records.push(...(parsed as Execution[]))
  }
  return records.sort((a, b) =>
    `${a.modulePath}${a.testName}`.localeCompare(`${b.modulePath}${b.testName}`)
  )
}

// --- Classification --------------------------------------------------------

const PROPERTY_MODULE_SUFFIX = ".property.test.ts"

// Mirrors `PROPERTY_SEARCH_DIRECTORIES` in `test/property-hygiene.static.test.ts`. The two
// walks are deliberately independent — this one classifies, that one scans — but a directory
// present in only one of them splits the guarantee: a module under `test/property/` would be
// scanned for hygiene and yet counted as "declared but absent from disk" here, or the reverse.
export const SEARCH_DIRECTORIES = [
  "lib",
  "app",
  "components",
  "hooks",
  "test",
] as const

const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".next"])

/** Every property module on disk, as repository-relative sorted paths. */
export function propertyModules(): readonly string[] {
  const found: string[] = []

  const descend = (relative: string): void => {
    const absolute = path.join(projectRoot, relative)
    if (!existsSync(absolute)) return

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
        descend(path.posix.join(relative, entry.name))
        continue
      }
      if (entry.isFile() && entry.name.endsWith(PROPERTY_MODULE_SUFFIX)) {
        found.push(path.posix.join(relative, entry.name))
      }
    }
  }

  for (const directory of SEARCH_DIRECTORIES) descend(directory)

  return found.sort()
}

/** Modules on disk that no declared property claims (Requirement 45.7). */
export function unclassifiedModules(): readonly string[] {
  const owners = declaredModules()
  return propertyModules().filter((modulePath) => !owners.has(modulePath))
}

/** Declared modules absent from disk — a rename that lost its property. */
export function undeclaredModules(): readonly string[] {
  const present = new Set(propertyModules())
  return [...declaredModules().keys()]
    .filter((modulePath) => !present.has(modulePath))
    .sort()
}

// --- The gates -------------------------------------------------------------

/** Requirements 45.4 and 45.8, per `fc.assert` call. Empty means clean. */
export function gateExecution(execution: Execution): readonly string[] {
  const offenders: string[] = []
  const where = `${execution.modulePath} › ${execution.testName}`

  if (execution.framework !== FAST_CHECK) {
    offenders.push(
      `${where} recorded framework ${execution.framework}; every web-side property ` +
        `runs under ${FAST_CHECK} (Requirement 45.1)`
    )
  }
  if (!Number.isInteger(execution.seed)) {
    offenders.push(
      `${where} recorded no seed, so its execution cannot be reproduced ` +
        `(Requirements 45.3, 45.8)`
    )
  }
  if (execution.failed) {
    offenders.push(`${where} failed`)
  }

  const generated = acceptedGenerated(execution)
  if (generated < MINIMUM_ACCEPTED) {
    offenders.push(
      `${where} accepted ${generated} generated cases beyond its ` +
        `${execution.declaredCases} declared ones, below the floor of ` +
        `${MINIMUM_ACCEPTED} (Requirements 45.1, 45.4, 45.5)`
    )
  }

  const fraction = rejectionFraction(execution)
  if (fraction > MAXIMUM_REJECTION_FRACTION) {
    offenders.push(
      `${where} rejected ${execution.rejected} of ` +
        `${execution.accepted + execution.rejected} generated cases through a ` +
        `precondition (${(fraction * 100).toFixed(1)}%), above the ceiling of ` +
        `${MAXIMUM_REJECTION_FRACTION * 100}% (Requirement 45.4)`
    )
  }

  return offenders
}

/**
 * Requirements 45.1, 45.4 and 45.7 for one module's records — **the gate that
 * actually fails the run.**
 *
 * It is called from `test/setup.ts`'s `afterAll`, which is a deliberate choice
 * rather than a convenience. Vitest logs an error thrown from a `globalSetup`
 * teardown and *still exits zero*, so the whole-run vantage point can report but
 * cannot enforce. An `afterAll` in a setup file fails its test file, and that
 * fails the run — so the gate lives beside the file it judges.
 *
 * A module no declared property claims is not gated. `lib/session-id.test.ts` and
 * `lib/db/views.test.ts` reach for fast-check as the right tool for one assertion
 * without being properties of this spec, and holding them to a property's contract
 * would make the contract about the tool rather than about the claim.
 */
export function gateModule(
  modulePath: string,
  records: readonly Execution[]
): readonly string[] {
  const declaration = declarationFor(modulePath)
  if (declaration === undefined) return []

  const offenders: string[] = []
  const mine = records.filter(
    (execution) => execution.modulePath === modulePath
  )

  const minimum = MINIMUM_EXECUTIONS[modulePath]
  if (minimum === undefined) {
    return [
      `${modulePath} is declared as ${declaration.label} and carries no entry in ` +
        `MINIMUM_EXECUTIONS, so nothing would notice one of its properties going ` +
        `inert (Requirement 45.7)`,
    ]
  }
  if (mine.length < minimum) {
    offenders.push(
      `${modulePath} recorded ${mine.length} property executions, down from ` +
        `${minimum}; a property that was registered and did not run reports green ` +
        `(Requirement 45.7). Raise the entry when you add one, never lower it`
    )
  }

  for (const execution of mine) offenders.push(...gateExecution(execution))

  const accepted = mine.reduce((sum, e) => sum + acceptedGenerated(e), 0)
  if (accepted < MINIMUM_ACCEPTED) {
    offenders.push(
      `${declaration.label} accepted ${accepted} generated cases across ` +
        `${mine.length} properties in ${modulePath}, below the floor of ` +
        `${MINIMUM_ACCEPTED} (Requirement 45.1)`
    )
  }

  return offenders
}

/**
 * Requirements 45.1, 45.4 and 45.7 at the grain design.md declares: the whole
 * property, across every module that realizes it.
 *
 * Used by the whole-run roll-up, which reports rather than enforces — see
 * {@link gateModule} for why enforcement is per file.
 */
export function gateProperty(
  declaration: PropertyDeclaration,
  ledger: readonly Execution[]
): readonly string[] {
  const mine = ledger.filter((execution) =>
    declaration.modules.includes(execution.modulePath)
  )

  if (mine.length === 0) {
    return [
      `${declaration.label} (${declaration.title}) executed no property at all; it is ` +
        `declared over ${declaration.modules.join(", ")} and nothing from there reached ` +
        `the ledger (Requirements 45.7, 45.9)`,
    ]
  }

  return declaration.modules.flatMap((modulePath) =>
    gateModule(modulePath, mine)
  )
}

/**
 * Every declared property, gated.
 *
 * `inThisRun`, when supplied, restricts the gate to the declared modules the
 * invocation actually selected — so a single-file run reports on that file rather
 * than on eleven properties it was never asked to execute. `undefined` gates
 * everything, which is what an unfiltered `pnpm test` gets and what an unreadable
 * file list falls back to.
 */
export function gateLedger(
  ledger: readonly Execution[],
  inThisRun?: ReadonlySet<string>
): readonly string[] {
  return declaredProperties()
    .filter(
      (declaration) =>
        inThisRun === undefined ||
        declaration.modules.some((modulePath) => inThisRun.has(modulePath))
    )
    .flatMap((declaration) => gateProperty(declaration, ledger))
}

// --- Requirement 45.8 — the output ----------------------------------------

/**
 * The four recorded values per property, plus the roll-up each threshold reads.
 *
 * Printed by the global teardown, which is what makes Requirement 45.4's
 * thresholds observable in the suite's own output rather than asserted about in
 * prose.
 */
export function formatLedger(ledger: readonly Execution[]): readonly string[] {
  const owners = declaredModules()
  const lines = [
    `Property ledger — ${ledger.length} executions (Requirement 45.8: framework, ` +
      `accepted cases, precondition rejection fraction, seed)`,
  ]

  const grouped = new Map<string, Execution[]>()
  for (const execution of ledger) {
    const label = owners.get(execution.modulePath) ?? "unregistered"
    const bucket = grouped.get(label)
    if (bucket === undefined) grouped.set(label, [execution])
    else bucket.push(execution)
  }

  for (const label of [...grouped.keys()].sort(compareLabels)) {
    const mine = grouped.get(label)!
    const accepted = mine.reduce((sum, e) => sum + acceptedGenerated(e), 0)
    const rejected = mine.reduce((sum, e) => sum + e.rejected, 0)
    const declared = mine.reduce((sum, e) => sum + e.declaredCases, 0)
    const generated = accepted + rejected
    const fraction = generated === 0 ? 0 : rejected / generated

    lines.push(
      `${label}: ${accepted} accepted, ${rejected} rejected by a precondition ` +
        `(${(fraction * 100).toFixed(1)}%), ${declared} declared-case runs in ` +
        `addition, across ${mine.length} properties`
    )
    for (const execution of mine) {
      lines.push(
        `    ${execution.framework.padEnd(10)} ` +
          `${String(acceptedGenerated(execution)).padStart(6)} accepted ` +
          `${String(execution.rejected).padStart(6)} rejected ` +
          `${(rejectionFraction(execution) * 100).toFixed(1).padStart(6)}%  ` +
          `seed=${execution.seed}  ` +
          `+${execution.declaredCases} declared  ` +
          `${execution.modulePath} › ${execution.testName}`
      )
    }
  }

  return lines
}

function compareLabels(a: string, b: string): number {
  const rank = (label: string): [number, number, string] => {
    const spec = /^Property (\d+)$/.exec(label)
    if (spec !== null) return [0, Number(spec[1]), label]
    if (label.startsWith("foundation")) return [1, 0, label]
    return [2, 0, label]
  }
  const [ax, ay, az] = rank(a)
  const [bx, by, bz] = rank(b)
  return ax - bx || ay - by || az.localeCompare(bz)
}
