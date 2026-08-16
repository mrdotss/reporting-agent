// Registers the jest-dom matchers on Vitest's `expect`. The module only calls
// `expect.extend`, so it is safe to load in the node project too; the matchers
// are only meaningful in the jsdom one. Both projects share this file.
import "@testing-library/jest-dom/vitest"

import fc from "fast-check"

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
