import "server-only"

// A stand-in for a real server module (`lib/env.ts`, `lib/crypto.ts`, anything
// under `lib/aws/`): it opens with the `server-only` marker, so it is only
// importable under test because `vitest.config.ts` aliases that package to
// `test/server-only-stub.ts`. Without the alias, importing this file throws.
export const SERVER_ONLY_MODULE_LOADED = true
