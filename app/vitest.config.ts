import path from "node:path"
import { fileURLToPath } from "node:url"

import react from "@vitejs/plugin-react"
import { defaultExclude, defineConfig } from "vitest/config"

const rootDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * `server-only`'s default entry is a bare `throw` — importing it outside a React
 * Server Component fails on purpose. Every server module here starts with
 * `import "server-only"` so a client import becomes a build error, which would
 * otherwise make all of them unimportable from a test file. Aliasing the package
 * to an inert stub keeps the marker in the source, where the boundary guard
 * reads it, and keeps the module testable. `@` mirrors the `paths` entry in
 * `tsconfig.json` so tests import `@/lib/...` exactly as the app does.
 */
const alias = {
  "server-only": path.resolve(rootDir, "test/server-only-stub.ts"),
  "@": rootDir,
}

const setupFiles = ["./test/setup.ts"]

/**
 * Vitest 4 has no `environmentMatchGlobs`; a per-file environment is expressed
 * as one project per environment under `test.projects`. Each project runs its
 * own Vite server, so the alias, the setup file and the plugins are declared on
 * both projects rather than inherited from this root config.
 *
 * The split, and the reason a new top-level directory has to be classified here
 * rather than picked up implicitly: a `.tsx` test renders JSX and needs a
 * document; `lib/` and `test/` are pure modules, property tests and static
 * guards that read the repository from disk.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: [
            "**/*.test.tsx",
            "app/**/*.test.ts",
            "components/**/*.test.ts",
            "hooks/**/*.test.ts",
          ],
          exclude: [...defaultExclude, "**/.next/**"],
          setupFiles,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          include: ["lib/**/*.test.ts", "test/**/*.test.ts"],
          setupFiles,
          /**
           * Requirements 45.7, 45.8, 45.9 — the property ledger's whole-run
           * vantage point. `setup` empties the ledger directory before any file
           * runs; `teardown` prints every property's framework, accepted-case
           * count, precondition rejection fraction and seed, and fails the run if
           * a declared property did not execute or missed a threshold.
           *
           * On this project rather than at the root: every `.property.test.ts`
           * module lives under `lib/`, so the node project is the one that runs
           * them, and a `globalSetup` declared here runs exactly once for exactly
           * that set. Declaring it on both projects would empty the directory
           * twice, and the second `setup` would delete the first project's
           * records.
           */
          globalSetup: ["./test/property-ledger.global.ts"],
        },
      },
    ],
  },
})
