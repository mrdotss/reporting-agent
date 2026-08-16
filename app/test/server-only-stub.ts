/**
 * Inert stand-in for the `server-only` package, wired up by the `server-only`
 * alias in `vitest.config.ts`.
 *
 * The real package's default entry throws the moment it is imported: that is how
 * `import "server-only"` turns a client import of a server module into a build
 * error. Under test there is no server/client boundary to enforce, so the throw
 * would only make every server module unimportable.
 *
 * This module must stay empty and side-effect free. Anything exported or
 * executed here would be behaviour no production build ever runs — Next resolves
 * the real package through the `react-server` condition to its own empty module.
 */
export {}
