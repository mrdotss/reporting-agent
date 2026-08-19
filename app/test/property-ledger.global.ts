import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  declaredModules,
  formatLedger,
  gateLedger,
  readLedger,
  resetLedger,
} from "./property-ledger"

/**
 * The node project's `globalSetup`: the one vantage point in Vitest that sees the
 * whole run (Requirements 45.7, 45.8).
 *
 * Vitest evaluates every test file in its own module registry and runs files in
 * parallel, so no test can observe what another test recorded. Two jobs follow
 * from that:
 *
 * - **`setup` empties the ledger directory.** Without it, a property deleted today
 *   would still be "recorded" by yesterday's file, and every check downstream
 *   would pass over a run that never happened.
 * - **`teardown` prints the whole-run roll-up** — Requirement 45.8's four values
 *   per property, aggregated per declared property, after every file has reported.
 *
 * **What this file deliberately does not do is enforce.** Vitest catches an error
 * thrown from a `globalSetup` teardown, logs it as `error during close`, and
 * **still exits zero** — measured, not assumed. A gate here would therefore be a
 * gate that cannot fail a run, which is worse than no gate because it reads like
 * one. Enforcement is `gateModule` called from `test/setup.ts`'s `afterAll`, where
 * a throw fails the file and the file fails the run.
 *
 * So the offenders below are *printed*, loudly, as a diagnostic for the one case a
 * per-file check structurally cannot see — a declared module that never ran at
 * all, because a file that does not run has no `afterAll` to fail in. That case is
 * closed statically instead: `test/property-hygiene.static.test.ts` asserts every
 * declared module exists on disk and matches this project's `include` patterns, so
 * a module Vitest would skip fails there rather than here.
 *
 * The agent half is `agent/tests/conftest.py`'s terminal summary, where pytest's
 * single process makes the same job a hook rather than a file.
 */

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

/**
 * Enough of Vitest's project object to ask it which files ran.
 *
 * Structural, and every field optional on purpose: neither read is part of
 * Vitest's documented API, and a roll-up that throws because an internal moved
 * would be noise. Failing to read either widens the report to every declared
 * property, which is the direction to fail in.
 */
type ProjectHandle = {
  readonly testFilesList?: readonly string[]
  readonly vitest?: {
    readonly state?: {
      readonly getFiles?: () => readonly { readonly filepath?: string }[]
    }
  }
}

/**
 * `teardown` receives no arguments, so the project is captured at `setup`.
 *
 * Which files ran matters because a filtered invocation — `pnpm vitest run
 * lib/templates/period.property.test.ts`, while working on one property — is not
 * "this spec's suite", and reporting it as a suite in which eleven properties
 * failed to run would train everyone to ignore this output.
 */
let project: ProjectHandle | undefined

export function setup(handle: ProjectHandle): void {
  resetLedger()
  project = handle
}

/** Repository-relative paths of the test files this invocation ran. */
function filesInThisRun(): readonly string[] | undefined {
  const relative = (file: string): string => path.relative(projectRoot, file)

  const ran = project?.vitest?.state?.getFiles?.() ?? []
  const fromState = ran
    .map((file) => file.filepath)
    .filter((file): file is string => typeof file === "string")
  if (fromState.length > 0) return fromState.map(relative)

  const listed = project?.testFilesList
  if (listed !== undefined && listed.length > 0) return listed.map(relative)

  return undefined
}

export function teardown(): void {
  const ledger = readLedger()

  // Requirement 45.8 — the four values per property, in the suite's own output.
  // Printed unconditionally, including on a clean run: a threshold nobody can read
  // is a threshold nobody is checking.
  for (const line of formatLedger(ledger)) console.log(line)

  const ran = filesInThisRun()
  const inThisRun =
    ran === undefined
      ? undefined
      : new Set(ran.filter((file) => declaredModules().has(file)))

  const offenders = gateLedger(ledger, inThisRun)
  if (offenders.length > 0) {
    console.error(
      `Requirement 45 — the whole-run roll-up found ${offenders.length} problems ` +
        `across ${declaredModules().size} declared modules and ${ledger.length} ` +
        `recorded executions:\n  ${offenders.join("\n  ")}`
    )
  }
}
