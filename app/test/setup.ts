// Registers the jest-dom matchers on Vitest's `expect`. The module only calls
// `expect.extend`, so it is safe to load in the node project too; the matchers
// are only meaningful in the jsdom one. Both projects share this file.
import "@testing-library/jest-dom/vitest"

import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import fc from "fast-check"
import { afterAll, expect } from "vitest"

import {
  FAST_CHECK,
  type Execution,
  formatLedger,
  gateModule,
  ledgerFileFor,
} from "./property-ledger"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

/**
 * Requirement 45.8 — one record per `fc.assert`, from fast-check's own numbers.
 *
 * Per module registry rather than per run: Vitest evaluates each test file in its
 * own registry, so this array only ever holds the current file's records and the
 * `afterAll` below hands them to `test/property-ledger.global.ts` through a file.
 * See that module's header for why the vantage point has to be the global
 * teardown.
 */
const records: Execution[] = []

fc.configureGlobal({
  // Req 42.1 — every web property runs at least 100 generated cases. Declared as
  // a floor so a property that passes no parameters of its own still gets 100.
  numRuns: 100,
  // Req 42.3 — fast-check's failure message already carries the shrunk
  // counterexample with the seed and path that reproduce it; level 1 adds every
  // failure met while shrinking, so a report names the cases rather than a count.
  verbose: 1,
  // Req 42.7 — maxSkips = maxSkipsPerRun * numRuns = 25, so a property that
  // rejects more than 20% of its generated cases through `fc.pre` (26 rejected
  // against 100 accepted) fails instead of quietly passing on a filtered subset.
  maxSkipsPerRun: 0.25,
  /**
   * Requirement 45.8 — record the framework, the accepted-case count, the
   * precondition rejection fraction and the seed of every property that runs.
   *
   * A `reporter` is called by `fc.assert` on **every** run rather than only on a
   * failure, which is what makes it the observation point. It also *replaces*
   * fast-check's own throw-on-failure, so the throw below is not optional
   * decoration: without it a failing property would report its counterexample
   * into this array and the test would pass. `fc.defaultReportMessage` is the
   * same message `fc.assert` would have raised, and the `cause` is what
   * fast-check attaches so the original error keeps its stack.
   */
  reporter: (out) => {
    const testPath = expect.getState().testPath ?? ""
    records.push({
      modulePath: testPath === "" ? "" : path.relative(projectRoot, testPath),
      testName: expect.getState().currentTestName ?? "(outside a test)",
      framework: FAST_CHECK,
      accepted: out.numRuns,
      rejected: out.numSkips,
      declaredCases: out.runConfiguration.examples?.length ?? 0,
      seed: out.seed,
      failed: out.failed,
    })

    if (out.failed) {
      throw new Error(fc.defaultReportMessage(out), {
        cause: out.errorInstance ?? undefined,
      })
    }
  },
})

afterAll(() => {
  if (records.length === 0) return

  const modulePath = records[0].modulePath

  // One document per test file, so parallel workers never write the same path.
  writeFileSync(
    ledgerFileFor(modulePath),
    JSON.stringify(records, null, 2),
    "utf8"
  )

  // Requirement 45.8's "in the suite's own output". The global teardown prints the
  // whole-run roll-up; this is the same four values beside the file that produced
  // them, which is where a reader looking at one failing module wants them.
  for (const line of formatLedger(records)) console.log(line)

  /**
   * Requirements 45.1, 45.4 and 45.7 — enforced here, and here for a reason.
   *
   * Vitest **logs** an error thrown from a `globalSetup` teardown and still exits
   * zero, so the only vantage point that sees the whole run can report and cannot
   * fail it. An `afterAll` fails its test file, and a failed file fails the run.
   * So the gate reads one module's records in the file that produced them, and
   * `test/property-ledger.global.ts` is left to print the roll-up and to catch
   * what a per-file check structurally cannot.
   *
   * A module no declared property claims is not gated: several tests here reach
   * for fast-check for one assertion without being properties of this spec.
   */
  const offenders = gateModule(modulePath, records)
  if (offenders.length > 0) {
    throw new Error(
      `${modulePath} does not meet Requirement 45's contract:\n  ` +
        offenders.join("\n  ")
    )
  }
})

// --- `ResizeObserver` in jsdom ---------------------------------------------
//
// jsdom implements no `ResizeObserver`, and `@dnd-kit/dom` *subclasses* it at module
// evaluation time — so the reference is needed before the first `import` of any module
// that reaches the drag primitive, not merely before a render. Vitest evaluates this
// setup file ahead of the test module's imports, which is why the stub belongs here
// rather than in a `beforeEach`.
//
// This is a jsdom gap rather than a product problem: `ResizeObserver` is available in
// every browser the app targets. The stub therefore records nothing and fires no
// callback — a layout-measurement API cannot mean anything in a DOM with no layout, and
// a stub that invented sizes would let a test assert a geometry the browser never
// produces. A test that needs resize behaviour should install its own spy.
//
// Guarded on `window` because `test/setup.ts` is shared with the node project, which has
// no business carrying a DOM global.
if (typeof window !== "undefined" && !("ResizeObserver" in globalThis)) {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  globalThis.ResizeObserver = ResizeObserverStub
}
