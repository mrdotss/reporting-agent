import path from "node:path"
import { fileURLToPath } from "node:url"

import type { NextConfig } from "next"

const appRoot = path.dirname(fileURLToPath(import.meta.url))

/** The monorepo root — `agent/` is a sibling of `app/`. */
const repoRoot = path.resolve(appRoot, "..")

const nextConfig: NextConfig = {
  /**
   * Resolve modules from the monorepo root, not from `app/`.
   *
   * `lib/templates/catalog.ts` imports
   * `agent/src/reporting_agent/catalog/metrics.v1.json` — **the** Metric_Catalog,
   * the same file the collector validates on every run. Requirement 5.6 asks the
   * wizard to present the catalog's items "rather than from a list held in the
   * Web_App, so that one catalog governs both halves", and importing the file is
   * the only way to satisfy that without a second copy for a build step to keep
   * in step.
   *
   * Turbopack's default root is the directory holding this config, so a specifier
   * that climbs above `app/` resolves under `tsc` (whose program is the whole
   * checkout) and fails at build. Naming the monorepo root here makes the two
   * agree.
   *
   * **This is a deployment constraint, not only a build setting.** A Docker build
   * for `app/` must have the repository root as its context, or `agent/` is
   * absent and this import fails at image build rather than at runtime — which is
   * the right place for it to fail, but only if someone reads this first.
   */
  turbopack: {
    root: repoRoot,
  },

  /**
   * The same root for the standalone output's file trace, so the tracer follows
   * the JSON import out of `app/` instead of stopping at its own boundary and
   * emitting a bundle that resolves nothing.
   */
  outputFileTracingRoot: repoRoot,
}

export default nextConfig
