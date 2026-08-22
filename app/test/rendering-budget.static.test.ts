import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { PHASE_DEADLINE_SECONDS } from "@/lib/runs/state"

/**
 * Requirement 14.2 — the `rendering` phase budget is tied to the table-of-contents
 * approach the agent actually ships, not set to a number somebody chose once.
 *
 * The two-pass approach performs **two** LibreOffice conversions, each bounded at 300
 * seconds by `render/pdf.py`'s `CONVERT_TIMEOUT_S`, and they are serialized because they
 * contend on the single profile the image pre-warms. So the worst case is additive, and a
 * 600-second budget — the two ceilings exactly, with nothing left for the two emits and
 * the measurement between them — would reap a rendering phase that was behaving correctly.
 *
 * A `TIMEOUT` written over a run that was working is the worst shape of failure here: it is
 * specific enough to be believed and it points at the wrong thing, so an operator reads a
 * deadline breach for a document that was mid-render.
 *
 * ## Why this reads the agent's source from disk
 *
 * `ADOPTED_APPROACH` is a Python module constant, deliberately — see `render/toc.py` on why
 * it is not an environment variable — so the app cannot import it. The alternative to reading
 * it is asserting `rendering === 900` on its own, which passes just as happily after the
 * adoption is reverted to a single-conversion candidate and leaves the budget 300 seconds too
 * generous with nothing to say so.
 *
 * This is the same mechanism `test/message-catalog.static.test.ts` uses for the agent's
 * catalog: read the one file that declares the fact, match the one declaration, and fail
 * loudly if the file or the declaration is not where it was.
 */

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

const TOC_MODULE = path.join(
  projectRoot,
  "..",
  "agent",
  "src",
  "reporting_agent",
  "render",
  "toc.py"
)

/** Seconds one LibreOffice conversion is bounded at — `render/pdf.py`'s `CONVERT_TIMEOUT_S`. */
const CONVERSION_CEILING_SECONDS = 300

/** How many conversions each approach performs. */
const CONVERSIONS_PER_APPROACH: Readonly<Record<string, number>> = {
  libreoffice_index_update: 1,
  two_pass_measure: 2,
  conversion_macro: 1,
  none: 1,
}

function adoptedApproach(): string {
  const source = readFileSync(TOC_MODULE, "utf8")

  // The assignment, not a mention: the module's docstring names every candidate, and matching
  // a bare literal would find whichever one the prose discussed last.
  const assignment = source.match(
    /^ADOPTED_APPROACH:\s*Final\[str\]\s*=\s*(TOC_APPROACH_[A-Z_]+)\s*$/m
  )
  expect(
    assignment,
    `no ADOPTED_APPROACH assignment found in ${TOC_MODULE}`
  ).not.toBeNull()

  const constant = assignment![1]
  const declaration = source.match(
    new RegExp(`^${constant}:\\s*Final\\[str\\]\\s*=\\s*"([a-z_]+)"\\s*$`, "m")
  )
  expect(
    declaration,
    `${constant} is assigned to ADOPTED_APPROACH and declared nowhere in ${TOC_MODULE}`
  ).not.toBeNull()

  return declaration![1]
}

describe("Requirement 14.2 — the rendering budget matches the adopted TOC approach", () => {
  test("the agent module is where this test thinks it is", () => {
    // Without this, a moved or renamed module makes every rule below pass on an empty read.
    expect(() => readFileSync(TOC_MODULE, "utf8")).not.toThrow()
    expect(readFileSync(TOC_MODULE, "utf8")).toContain("ADOPTED_APPROACH")
  })

  test("the adopted approach is one this table accounts for", () => {
    const adopted = adoptedApproach()

    expect(Object.keys(CONVERSIONS_PER_APPROACH)).toContain(adopted)
  })

  test("the budget covers every conversion the adopted approach performs", () => {
    const adopted = adoptedApproach()
    const conversions = CONVERSIONS_PER_APPROACH[adopted]
    const ceiling = conversions * CONVERSION_CEILING_SECONDS

    expect(PHASE_DEADLINE_SECONDS.rendering).toBeGreaterThan(ceiling)
  })

  test("two conversions means 900 and one means 600", () => {
    // The specific numbers, so a budget that merely exceeds the ceiling by a second does not
    // satisfy the rule above. The headroom is for the emits and, at two passes, for the
    // measurement between them.
    const adopted = adoptedApproach()
    const expected =
      CONVERSIONS_PER_APPROACH[adopted] === 2
        ? 2 * CONVERSION_CEILING_SECONDS + CONVERSION_CEILING_SECONDS
        : CONVERSION_CEILING_SECONDS + CONVERSION_CEILING_SECONDS

    expect(PHASE_DEADLINE_SECONDS.rendering).toBe(expected)
  })

  test("the adopted approach today is the two-pass one, and the budget is 900", () => {
    // Pinned rather than derived, so reverting the adoption without revisiting the budget
    // fails here and names both facts. `agent/evidence/toc/evaluation.json` carries the
    // measurement that chose it, and `agent/tests/test_toc_evidence.py` guards that record.
    expect(adoptedApproach()).toBe("two_pass_measure")
    expect(PHASE_DEADLINE_SECONDS.rendering).toBe(900)
  })

  test("no other phase budget moved", () => {
    // The two-pass adoption is a claim about rendering alone. A budget that drifted elsewhere
    // in the same edit would be an unrelated change riding along inside a justified one.
    expect(PHASE_DEADLINE_SECONDS).toEqual({
      queued: 900,
      claimed: 300,
      collecting: 1800,
      compiling: 300,
      rendering: 900,
      verifying: 600,
    })
  })
})
