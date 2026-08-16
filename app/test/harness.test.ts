import { expect, test } from "vitest"
import fc from "fast-check"

import { SERVER_ONLY_MODULE_LOADED } from "@/test/fixtures/server-only-module"

// Self-tests for the harness itself: each of these fails if the mechanism the
// property suites depend on stops resolving. They are the node half; the jsdom
// half is `harness.dom.test.tsx`.

test("node project runs without a document", () => {
  expect(typeof document).toBe("undefined")
})

test("fast-check global configuration is the floor Req 42.1 and 42.7 require", () => {
  const configured = fc.readConfigureGlobal()
  expect(configured.numRuns).toBe(100)
  expect(configured.verbose).toBe(1)
  expect(configured.maxSkipsPerRun).toBe(0.25)
})

test("a property with no parameters of its own runs 100 generated cases", () => {
  let cases = 0
  fc.assert(
    fc.property(fc.integer(), () => {
      cases += 1
      return true
    })
  )
  expect(cases).toBe(100)
})

test("the server-only alias makes a server module importable", () => {
  expect(SERVER_ONLY_MODULE_LOADED).toBe(true)
})
