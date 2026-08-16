# Implementation Plan: reporting-agent-foundation

## Overview

Build the foundation in the order the design's dependencies force: the already-scaffolded
`app/` gains dependencies, a test harness, env/crypto, the Postgres schema and auth; the
`agent/` package is created from scratch and reaches a working `preflight` command **before**
the onboarding wizard's accept path, because the permissions assertion runs inside the runtime
and the app holds no Azure token; the agent's pure collect modules and their four property
tests land before any Azure client, so the load-bearing arithmetic is proven without a
subscription; the collector then runs against recorded responses through faked ports; and run
orchestration — state machine, progress callback and reaper together — closes the loop.

The spec ends when `generate_report` writes one immutable, content-addressed snapshot and the
run row reaches `completed`. There is no template model, compiler, figure ledger, renderer,
document verifier, replay execution, drift sampling, run comparison, chat history or chart in
this plan; `compile/`, `render/`, `verify/`, `compare/` and `tools/` are not created.

`app/` is already scaffolded. No task re-runs `shadcn init`, and no task recreates
`app/app/layout.tsx`, `app/app/globals.css` token values, `app/components.json`,
`app/components/ui/button.tsx`, `app/components/theme-provider.tsx`, `app/lib/utils.ts` or
`app/package.json` — they are extended in place.

## Tasks

- [x] 1. Web app foundation — dependencies, test harness, environment and crypto
  - [x] 1.1 Add app dependencies and package scripts
    - From `app/`, `pnpm add` the exact pins in the design's dependency block: `drizzle-orm@0.45.2`, `pg@8.22.0`, `zod@4.4.3`, `argon2@0.45.0`, `@aws-sdk/client-bedrock-agentcore@3.1090.0`, `@aws-sdk/client-s3@3.1090.0`, `@aws-sdk/s3-request-presigner@3.1090.0`, `@aws-sdk/client-dynamodb@3.1092.0`, `@aws-sdk/lib-dynamodb@3.1092.0`, `@aws-sdk/client-bedrock-runtime@3.1092.0`, `server-only@0.0.1`
    - `pnpm add -D drizzle-kit@0.31.10`, `@types/pg@8.20.0`, `vitest@4.1.10`, `@vitejs/plugin-react@6.0.3`, `jsdom@29.1.1`, `fast-check@4.9.0`, `@testing-library/react@16.3.2`, `@testing-library/dom@10.4.1`, `@testing-library/jest-dom@6.9.1`, `@testing-library/user-event@14.6.1` — Vitest is not currently a dependency and every property task depends on it
    - Add `db:generate`, `db:migrate`, `db:push`, `test` (`vitest run`) and `test:watch` to the existing `scripts`; leave `dev`, `build`, `start`, `lint`, `format`, `typecheck` as they are
    - Keep `shadcn` in `dependencies` — `app/app/globals.css` does `@import "shadcn/tailwind.css"`; do not run `shadcn init` and do not touch `components.json`
    - _Requirements: 6.8, 6.9, 42.1_

  - [x] 1.2 Create the Vitest and fast-check harness
    - `app/vitest.config.ts` with the React plugin, `jsdom` environment for component tests, node environment for lib tests, and a `server-only` alias to `test/server-only-stub.ts` so `import "server-only"` modules are importable under test
    - `app/test/setup.ts` calling `fc.configureGlobal({ numRuns: 100, verbose: 1 })` so every web property runs at least 100 generated cases and prints the shrunk counterexample with its seed
    - _Requirements: 42.1, 42.3, 42.7_

  - [x] 1.3 Implement `lib/env.ts` with `.env.example` and the `.gitignore` negation
    - `app/lib/env.ts` starting `import "server-only"`, exporting `REQUIRED_ENV_VARS` as a `const` tuple in declared order (`DATABASE_URL`, `APP_ENCRYPTION_KEY`, `AWS_REGION`, `RPT_RUNTIME_ARN`, `RPT_ARTIFACT_BUCKET`, `RPT_HISTORY_TABLE`, `RPT_TITLE_MODEL_ID`, `RPT_CRON_SECRET`, `RPT_APP_BASE_URL`), plus `MissingEnvError` carrying `variableName`, `requireEnv` reading `process.env` per call and rejecting absent/empty/whitespace-only, and `getEnv()`; no `AUTH_SECRET`
    - `app/.env.example` declaring exactly that key set with non-empty placeholders containing an angle-bracketed token or the word `generate`, including `RPT_HISTORY_TABLE` and `RPT_TITLE_MODEL_ID`, which this spec validates but does not use
    - In the **same task**, add `!.env.example` immediately after the existing `.env*` rule in `app/.gitignore`, because the boundary guard asserts both the ignore rule and the negation
    - Create `app/test/boundaries.static.test.ts` with its first rules: `.env.example`'s key set equals the exported `REQUIRED_ENV_VARS` (never a duplicated list), every placeholder is non-empty and well-formed, `.env` is ignored, `.env.example` is negated, and `lib/env.ts` and `lib/crypto.ts` begin with `import "server-only"`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 6.1, 6.6_

  - [x] 1.4 Implement `lib/crypto.ts`
    - AES-256-GCM with a 12-byte IV from `crypto.randomBytes` and a 16-byte tag; `encryptSecret` returns one base64 string encoding IV, then tag, then ciphertext
    - Two distinct error types — `EncryptionKeyError` for an `APP_ENCRYPTION_KEY` that does not resolve to 32 bytes and `CiphertextError` for a short or tag-failing input — so a rotated key is distinguishable from a tampered value; no message carries plaintext, ciphertext or key material
    - Export `resolveEncryptionKey()` accepting base64-of-32 or 32 raw bytes, because `lib/runs/progress-token.ts` keys its HMAC from the same bytes
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11_

  - [x] 1.5 Implement `lib/session-id.ts`
    - `sessionIdForThread` and `sessionIdForRun` as SHA-256 hex over namespace-prefixed input (`rpt:session:thread:v1:` / `rpt:session:run:v1:`), so the 33–128 bound holds by construction at 64 chars and a thread id and a run id carrying the same string derive different ids
    - `newSessionId()` as `base64url(randomBytes(48))`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 1.6 Unit tests for env resolution and session ids
    - `requireEnv` on absent, empty and whitespace-only values; the error names the variable and excludes its value; the first-in-declared-order rule when several are missing; a value changed between calls resolves to the new value
    - Session id length, lowercase-hex alphabet, determinism, namespace separation, and distinctness across distinct thread ids
    - _Requirements: 5.2, 5.3, 5.8, 5.9, 8.1, 8.2, 8.3, 8.6, 8.7_

  - [x] 1.7 Property test for the crypto round trip
    - `fast-check` over arbitrary UTF-8 strings including the empty string and strings of at least 4096 characters: `decryptSecret(encryptSecret(s)) === s`
    - Assert two encryptions of one plaintext differ (fresh IV), a flipped tag byte raises `CiphertextError`, and an input shorter than 28 bytes after base64 decode raises naming the input as too short
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 42.1_

  - [x] 1.8 Provision the integration-test database
    - A docker compose service running **Postgres 17**, which must track whatever major version the deployment runs: `FOR UPDATE SKIP LOCKED` claim semantics and the `error_code` CHECK behaviour are exactly what task 13.7 asserts, so a version skew there is a test that passes against the wrong engine
    - A `test:db:up` / `test:db:down` script pair in `app/package.json`, alongside the existing `test` and `test:watch`
    - `TEST_DATABASE_URL`, read **only** by the test harness. It is **not** added to `REQUIRED_ENV_VARS` in `lib/env.ts` — it is not a runtime variable and nothing in `app/` reads it outside the harness — and it is therefore **not** added to `app/.env.example` either, because task 1.3's Boundary_Guard asserts that `.env.example`'s key set **equals** `REQUIRED_ENV_VARS` exactly and putting it there would fail that guard. Document it in the compose file and the harness, or in a separate `.env.test.example` the guard does not read
    - A scratch-schema helper: for each test file create a uniquely named schema, apply `lib/db/migrations` into it, run that file's tests against it with `search_path` set to that schema, and drop it afterwards, so tests share no state, depend on no ordering, and a failure leaves no residue for the next run
    - A real connection **pool**, not a single client: task 13.7 needs two simultaneous transactions to prove `SKIP LOCKED` claims disjoint sets, and a single connection cannot race itself — it would serialize the two transactions and the test would pass without ever exercising the lock
    - Skip with a loud message when `TEST_DATABASE_URL` is unset, naming the variable and the `test:db:up` script, and make that skip visible in the runner's output rather than silent, so a developer without docker gets a clear reason instead of a confusing connection failure
    - Ordering: the helper applies `lib/db/migrations`, and **task 2.1 is what generates the first migration**. So this task writes the harness only — compose service, scripts, pool, and a scratch-schema helper that resolves the migrations directory **at run time** — and that harness is first exercised by 2.1's generated migration. The migrations directory does not exist yet at this point, and that is expected rather than an ordering error
    - _Requirements: 9.4, 9.5, 36.4, 36.6, 39.5_

- [x] 2. Postgres schema, browser-safe projections and their guards
  - [x] 2.1 Define the Drizzle schema and generate migrations
    - One `app/lib/db/schema.ts` with real Postgres enums (`subscription_status`, `fidelity_tier`, `run_status` carrying the full eight values including the undriven `compiling`/`rendering`/`verifying`, `run_error_code` carrying the ten codes and deliberately **not** `PARTIAL_COVERAGE`) and the five tables from the design's data model: `users`, `sessions`, `login_attempts`, `connected_subscriptions`, `report_runs`
    - Carry every column the design tables list, including `report_runs.scope jsonb`, the UNIQUE constraints on `users.email_normalized`, `sessions.session_token_hash`, `connected_subscriptions (user_id, subscription_id)` and `report_runs.dedupe_key`, the indexes on `sessions.user_id`, `login_attempts (email_normalized, created_at DESC)`, `report_runs (status, created_at)` and `report_runs.phase_deadline`, and the `report_runs_error_code_ck` CHECK
    - Carry the three in-flight progress columns on `report_runs` — `progress_current integer NULL`, `progress_total integer NULL` and `progress_label text NULL` — which hold the count a phase is currently at and are cleared when the row goes terminal; all three are **additive and nullable**, so the additive-migration guard of task 2.2 is unaffected and no existing column changes type or nullability
    - `app/lib/db/index.ts` opening the `pg` pool, starting `import "server-only"`; `app/drizzle.config.ts`; generate SQL into `app/lib/db/migrations/` with drizzle-kit and never hand-edit it
    - _Requirements: 1.1, 2.2, 2.6, 3.1, 7.3, 9.1, 9.4, 9.6, 36.1, 36.3, 36.4, 36.6, 36.8, 36.12_

  - [x] 2.2 Migration additive guard test
    - `app/test/migrations.static.test.ts` parses every file in `lib/db/migrations/` and fails on any `DROP` of a table or column a previously committed migration created; ships with task 2.1's schema, not after it
    - _Requirements: 9.5, 36.8_

  - [x] 2.3 Implement `ConnectedSubscriptionView` with its projection guard
    - `app/lib/db/views.ts` with the closed seven-key `ConnectedSubscriptionView`, `toConnectedSubscriptionView` and the pure `maskSubscriptionId` masking all but the final 4 characters and masking **every** character of an id of length ≤4
    - In the same task, the guard test: a fixture assigning a distinct non-empty value to `subscription_id`, `tenant_id`, `client_id` and `client_secret_enc`; assert the exact sorted key set; `JSON.stringify` the projection and assert none of those values appear and no character of `subscription_id` other than its final four appears
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9_

  - [x] 2.4 Implement `RunView` with its projection guard
    - Extend `app/lib/db/views.ts` with the closed fourteen-key `RunView` and `toRunView`, dropping `progress_token_hash`, `claimed_by`, `dedupe_key`, `scope`, `progress_current`, `progress_total` and `progress_label`, and computing `artifactKeys` as `[]` or `[<userId>/snapshots/<runId>/snapshot.json]` — keys only, never a presigned URL
    - `RunView` stays closed at **fourteen keys** even though `report_runs` carries three more columns, because the **relay** is the delivery path for in-flight progress: a reconnecting client recovers the determinate bar on the relay's next 2-second poll rather than from a projected field, so the closed key set and its guard assertion are unchanged
    - In the same task, the guard test: a `report_runs` fixture with distinct non-empty `progress_token_hash`, `claimed_by` and `dedupe_key`; assert the exact sorted key set and that the serialization contains none of them
    - _Requirements: 37.5, 37.6, 37.7, 37.11_

- [x] 3. Authentication, sessions and the authenticated shell
  - [x] 3.1 Implement `lib/auth/password.ts`
    - argon2id at `memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`; hash the password **exactly as submitted**, including surrounding whitespace; length measured in Unicode code points with `PASSWORD_MIN = 12`, `PASSWORD_MAX = 256`
    - `verifyPassword` returns `false` for a malformed stored hash rather than throwing; `burnDecoyVerification` runs one real argon2id verification against a fixed `DECOY_HASH` carrying the same parameters so the unmatched-email path matches the failed-verification path in elapsed time
    - Exclude every password value and every stored hash from logs, errors and return values
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.10, 1.11, 1.12_

  - [x] 3.2 Implement `lib/auth/session.ts`
    - Token from `randomBytes(32)` encoded base64url (43 chars); store only `sha256(token)` hex in `sessions.session_token_hash`; find by hash equality then decide with `timingSafeEqual` over the decoded digests
    - Cookie `rpt_session`: `httpOnly`, `sameSite: "lax"`, `path: "/"`, `maxAge: 2592000`, `secure` only when `NODE_ENV === "production"`; `await cookies()` — Next 16 removed synchronous access
    - `createSession` writes `absolute_expires_at = now + 30d` and `idle_expires_at = now + 7d`; `readSession` on a valid row rolls `idle_expires_at` to `now + 7d` as a **DB write with no cookie write** (Next 16 forbids setting a cookie during a Server Component render); either expiry resolves unauthenticated and best-effort deletes the row, swallowing a delete failure; no cookie or an unmatched token performs no write at all
    - `destroySession` deletes the row and clears the cookie, no-op without a cookie; `revokeAllSessionsForUser(userId, tx)` for the password-change path
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 2.15, 2.16, 2.17, 2.18_

  - [x] 3.3 Implement `lib/auth/lockout.ts`
    - The pure `isLockedOutFromFailures(failures, now)` predicate with `FAILED_THRESHOLD = 5` and `WINDOW_MINUTES = 15`, containing no I/O, so lockout is defined only by the trailing inclusive window over failures and no lock row is stored
    - `recordLoginAttempt` writes every completed attempt including a rejected one, so the window measures from the most recent attempt; `isLockedOut` **fails closed** — an unreadable `login_attempts` rejects the sign-in without invoking verification
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.7, 3.8_

  - [x] 3.4 Implement `lib/validation/*` and `lib/auth/guard.ts`
    - `lib/validation/{email,password,return-to,mask,index}.ts`: email trimmed and lower-cased with a ≤254 length and format check, the code-point password policy, and the pure `safeReturnTo` accepting only a value beginning with exactly one `/` and returning `/dashboard` otherwise
    - `lib/auth/guard.ts` with `requireSession` (redirect on miss) and `requireSessionForApi`; the guard is a server-side DB check in the `(app)` layout and per handler — **no `proxy.ts`**, since Next 16 renamed and deprecated middleware and an optimistic cookie peek is not authoritative
    - Extend `app/test/boundaries.static.test.ts` with the `server-only` rules for every module under `lib/auth/` and every connection-opening module under `lib/db/`
    - _Requirements: 6.1, 7.6, 7.7, 7.9_

  - [x] 3.5 Unit tests for password, session, lockout and return-to
    - Password boundaries at 11/12/256/257 code points, an emoji passphrase, a whitespace-bearing password preserved, a malformed stored hash returning `false`
    - Session absolute and idle expiry against a fake clock, the idle roll leaving `absolute_expires_at` untouched, and the no-cookie/unmatched-token no-write invariant
    - Lockout at 4 and 5 failures, at the 15-minute window edge, and with successes excluded; `safeReturnTo` rejecting `//evil.com`, `/\evil.com` and `https://…`; `maskSubscriptionId` at lengths 0/1/4/5/36
    - _Requirements: 1.3, 1.4, 1.6, 2.6, 2.7, 2.8, 2.9, 2.18, 3.2, 3.4, 7.9, 10.4_

  - [x] 3.6 Implement `lib/actions/auth.ts`
    - `registerAction`, `loginAction`, `logoutAction`, `changePasswordAction`, each parsing input with a named zod schema at the boundary — no `as SomeType` on a body
    - Register: normalize the email, reject a duplicate with the email-unavailable message creating neither user nor session, and handle the UNIQUE violation as that same rejection; login: lockout, unmatched email and failed verification all return one generic outcome, and an authenticating login while a cookie is present creates a new session and deletes the presented row
    - `changePasswordAction` writes the new hash and deletes every `sessions` row for that user **in one transaction**, so a failed change retains both the old hash and the old rows
    - _Requirements: 1.7, 1.8, 1.9, 1.13, 3.3, 3.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 7.10, 7.11, 7.12_

  - [x] 3.7 Build the login and register pages
    - `app/app/(auth)/layout.tsx` plus `login/page.tsx` and `register/page.tsx`, with `components/auth/{login-form,register-form}.tsx` as the only `"use client"` leaves
    - A centered `Card` at `rounded-xl`, `Field` + `Input` from the shadcn Base UI registry, one pill submit reusing the existing `components/ui/button.tsx`, and a single generic error naming neither field; Phosphor icons imported from `@phosphor-icons/react/ssr` in server components
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.8_

  - [x] 3.8 Build the authenticated shell, the root redirect and the one additive CSS line
    - `app/app/(app)/layout.tsx` calling `requireSession()`, with `components/app-shell/{sidebar,user-menu,theme-toggle}.tsx` on the `--sidebar` surface; update the existing `app/app/page.tsx` to redirect to `/dashboard` or `/login`
    - Add exactly one line, `--font-mono: var(--font-mono);`, inside the **existing** `@theme inline` block of `app/app/globals.css` next to `--font-sans` and `--font-heading`; change no existing token value and do not add the `--cat-*` palette, which belongs to the spec that introduces charts
    - Set Phosphor defaults once via `IconContext.Provider`; controls stay pills, surfaces stay 10–14px
    - _Requirements: 6.9, 7.6, 7.8_

  - [x] 3.9 Tests for the auth actions and pages
    - Register/login/logout happy paths and rejections against the scratch-schema harness from task 1.8; the generic-outcome assertion that the unmatched-email, wrong-password and locked-out responses are byte-identical
    - RTL assertions that the login page renders one error naming neither field and that an unauthenticated request to an `(app)` route redirects to `/login`
    - _Requirements: 1.7, 1.8, 3.6, 7.1, 7.2, 7.4, 7.5, 7.6, 7.12_

- [x] 4. Checkpoint — web foundation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Agent packaging and runtime skeleton
  - [x] 5.1 Create the agent package, dependency pins and the pytest/hypothesis profile
    - `agent/pyproject.toml` with `requires-python = "==3.12.*"` and the design's pinned dependencies, including **all three** Azure Monitor packages — `azure-monitor-query>=2,<3`, `azure-monitor-querymetrics>=1,<2` and `azure-mgmt-monitor==7.0.0` — with the adjacent comment stating that version 2 removed **both** `MetricsClient` and `MetricsQueryClient`, that batch metric values therefore need `azure-monitor-querymetrics`, that metric definitions and the per-resource fallback therefore need `azure-mgmt-monitor`, and that the three are pinned together
    - `agent/requirements.lock` fully pinned and committed, `agent/.python-version` pinning 3.12, and `agent/README.md` whose every image build line names `--platform linux/arm64`
    - `agent/tests/conftest.py` registering `@settings(max_examples=100, deadline=None, print_blob=True)` and **never** suppressing `HealthCheck.filter_too_much` or `HealthCheck.data_too_large`
    - Create the `src/reporting_agent/` package skeleton with `catalog/`, `providers/`, `azure/`, `collect/`, `storage/` and `tests/{fakes,property}/`; do **not** create `compile/`, `render/`, `verify/`, `compare/`, `tools/`, `agent.py` or `themes/`
    - _Requirements: 17.2, 17.3, 17.4, 17.8, 17.9, 17.10, 42.2, 42.4, 42.6_

  - [x] 5.2 Write the arm64 Dockerfile with the build-time Azure Monitor import assertion
    - `agent/Dockerfile` on `--platform=linux/arm64` with the pinned Python base, installing from `requirements.lock`, exposing 8080 and running `python -m reporting_agent.main`; LibreOffice, fonts and a warmed profile are **not** installed — they belong to the render spec
    - Include the `RUN python -c` step that imports `MetricsClient` from `azure.monitor.querymetrics`, imports `MonitorManagementClient` from `azure.mgmt.monitor`, imports `LogsQueryClient` from `azure.monitor.query`, and asserts **both** `MetricsClient` **and** `MetricsQueryClient` are **absent** from `azure.monitor.query`, so a wrong three-package pin fails the **build** rather than a deployed run
    - _Requirements: 17.1, 17.5, 17.6, 17.10_

  - [x] 5.3 Test the three-package Azure Monitor pin
    - `agent/tests/test_dependency_pins.py` importing `MetricsClient` from `azure.monitor.querymetrics`, `MonitorManagementClient` from `azure.mgmt.monitor` and `LogsQueryClient` from `azure.monitor.query`, and asserting **both** `MetricsClient` and `MetricsQueryClient` are absent from `azure.monitor.query`
    - Add an AST scan failing the suite if any module under `src/reporting_agent/` imports `MetricsClient` from `azure.monitor.query`, or imports `MetricsQueryClient` from **anywhere**, because that name exists in no pinned package
    - _Requirements: 17.5, 17.6, 17.7, 17.10_

  - [x] 5.4 Implement `config.py` and `errors.py`
    - `Config.from_env()` as a frozen dataclass built once at process start, raising on an absent or empty required variable while naming the variable and excluding its value, and rejecting every attempted mutation
    - `errors.py` declaring the terminal codes (`AUTH_EXPIRED`, `AUTH_FAILED`, `SCOPE_UNVERIFIED`, `EMPTY_SCOPE`, `CATALOG_UNUSABLE`, `NO_STATISTICS`), the non-terminal codes (`THROTTLED`, `PARTIAL_COVERAGE`, `REGION_UNREACHABLE`) and their typed exceptions; `TIMEOUT` and `SECRET_UNREADABLE` are app-written and must not be raisable here
    - _Requirements: 14.12, 14.16, 36.6_

  - [x] 5.5 Declare the event vocabulary in both languages with its mirror guard
    - `agent/src/reporting_agent/events.py` declaring the ten types between `# --- BEGIN EVENT TYPES ---` / `# --- END EVENT TYPES ---` sentinels plus `EMITTED_BY_FOUNDATION`, and `app/lib/events.ts` declaring the same set between matching sentinels
    - `app/lib/aws/redact.ts` with `redactForBrowser` removing every field named `client_secret`, `progress_token`, `tenant_id` or `client_id` in either casing, compared case-insensitively, at every depth of objects and arrays
    - `app/test/event-mirror.static.test.ts` extracting the quoted strings from both files and comparing the sets — the guard ships with the second of the two files, so the vocabulary can never drift
    - _Requirements: 14.15, 15.6, 40.6, 40.7, 40.13_

  - [x] 5.6 Implement `redaction.py`
    - A `ContextVar` registry of pre-`re.escape`d patterns rather than a module-level set, so one invocation's secrets cannot scrub another's output and the registry stays bounded; `discard_secrets` on the terminal event
    - `register_secrets` skipping non-strings and values shorter than 8 characters; `scrub`, `scrub_deep` at every nesting depth, `scrub_exception` walking `__cause__` and `__context__`, `presence_marker` revealing no character, and an idempotent `install_log_redaction` attached to the root logger and each of its handlers, run at process start and again after the context is parsed
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.8, 15.9, 15.10_

  - [x] 5.7 Property test — the redaction guard
    - **Property 5: Registered secrets cannot reach an event, a log record or an error**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.9, 15.10, 42.1, 42.2**
    - Agent half with `hypothesis`: secrets 8–128 characters over an alphabet including `.`, `*`, `+`, `?`, `(`, `)`, `[`, `]`, `{`, `}`, `|`, `^`, `$` and `\`, embedded in objects and arrays at depth 1–4, in exception text and in log records — a secret containing `.*` kills an unescaped `re.compile(secret)`
    - Declared examples: one 40-character Azure-secret-shaped value, one 43-character base64url value, and generated values of length **0–7** which must register no pattern and insert no placeholder, killing a registry with no minimum whose empty pattern otherwise lands between every character of the output
    - Web half with `fast-check`: an event carrying `client_secret`, `progress_token`, `tenant_id` or `client_id` in snake_case, camelCase or mixed case at depth 1–4 must be relayed with that field absent, killing a top-level snake_case-only filter
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.9, 15.10, 42.1, 42.2_

  - [x] 5.8 Implement `heartbeat.py`
    - `merge_with_heartbeat` running a pump and a ticker over one `asyncio.Queue`, with `clock` and `sleep` injected; `HEARTBEAT_INTERVAL_S = 15.0` and one shared `MAX_EVENT_GAP_S = 30.0` constant
    - The first heartbeat fires within 20 seconds of acceptance rather than at the first phase transition; the ticker is cancelled once the terminal event is forwarded so nothing follows `done`; a heartbeat carries only a timestamp — no phase, no counts, no run id — and timestamps never decrease
    - A raising ticker is logged and the invocation continues to its terminal event, recording **no** `collection_log` gap
    - _Requirements: 16.1, 16.2, 16.3, 16.5, 16.6, 16.7_

  - [x] 5.9 Test the heartbeat and the progress throttle over simulated time
    - Drive a phase that emits no other event for at least 45 seconds of simulated time through the injected clock and assert at least two `heartbeat` events, so an emitter that never starts fails the suite rather than a deployed run
    - Assert no heartbeat follows `done`, and that consecutive timestamps are non-decreasing
    - Against the same injected fake clock, assert the progress throttle admits at most one progress callback per 5 seconds per phase, and that neither a phase transition nor the terminal callback is ever delayed or suppressed by that limit
    - _Requirements: 16.1, 16.2, 16.3, 16.7, 16.8, 38.15_

  - [x] 5.10 Implement `main.py` — command routing, step tracking and the single egress
    - `BedrockAgentCoreApp` entrypoint yielding SSE dictionaries from an async generator, with `CONFIG` and the redaction filter installed at import and **one** `emit()` egress function every event passes through
    - Routing: `generate_report` and `preflight` run deterministically with any `prompt` ignored and no model invocation; an unrecognised `command`, a missing `command`, and an absent/non-string/blank `actor_id` each emit a terminal `error` then `done` as the final event; session id resolves from `context.session_id`, then the request context, then a ≥33-character derivation from `actor_id`, continuing either way
    - A `StepTracker` owning `tool` start/end pairs and `progress` invariants — `id` references an open step, `done <= total`, successive `done` non-decreasing — with `close_all()` in a `finally` so a phase that raised still closes its step; exactly one `snapshot_ready` before `done`; never a `verification` or `report_file` event
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.13, 14.15_

  - [x] 5.11 Unit tests for entrypoint event ordering
    - `snapshot_ready` precedes `done`; nothing is emitted after `done`; a `tool` step left open by a raising phase is closed before `done`; a `progress` event referencing a closed or unknown step is rejected; an unrecognised command emits exactly `error` then `done`
    - _Requirements: 14.4, 14.8, 14.9, 14.10, 14.13, 14.14_

  - [x] 5.12 Implement `progress.py`
    - `ProgressReporter.report` fire-and-forget and `report_terminal` awaited, both presenting the run-scoped token in the `X-Rpt-Progress-Token` **header** and never in the request target or body
    - A 5-second timeout with at most one retry, failures logged with the token excluded, and no exception that can end a run — the reaper is the backstop; the terminal callback is awaited because losing it costs a false `TIMEOUT` on a successful run
    - `report` carries the phase's current count, total and label where that phase has a countable unit of work, so the row can feed a determinate bar
    - Throttle in-phase progress with `PROGRESS_THROTTLE_S = 5.0` — at most **one progress callback per 5 seconds per phase** — with both guards stated positively: **every phase transition is sent at the instant it occurs** irrespective of the limit, and **the terminal callback is always sent** irrespective of the limit. A 200-resource run folds many batches, so posting per folded batch would turn the design's "four or five tiny requests per run" budget into hundreds of real HTTP requests against the app, for a counter the UI reads at a 2-second poll anyway
    - _Requirements: 15.7, 38.1, 38.2, 38.3, 38.4, 38.15_

  - [x] 5.13 Implement the provider protocol and the object store
    - `providers/base.py` with `ResourceRecord`, `GapRecord`, `DiscoverResult`, `CollectResult`, `Capabilities` and the `Provider` protocol (`discover`, `collect`, `capabilities`) expressed only over `str`, `bool`, `int`, `Decimal`, `None`, `list` and `dict` — no type defined by a cloud provider SDK — with inventories ordered by resource id ascending in Unicode code-point order
    - `providers/registry.py` mapping a provider id to a factory; `storage/base.py` with the `ObjectStore` protocol (`put_bytes`, `get_json`, conditional put) and `storage/s3.py` implementing it with boto3
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.6, 18.9_

  - [x] 5.14 Agent static boundary guard
    - `agent/tests/test_boundaries.py` with an `ast` scan failing on any import whose **first dotted segment is exactly `azure`** from a module outside `src/reporting_agent/azure/`, so `collect/` stays unit-testable without a subscription and no allowlist is needed
    - Fail if `DefaultAzureCredential` appears anywhere, and if `unicodedata.normalize` appears on the snapshot path
    - _Requirements: 18.5, 18.7, 19.7_

- [x] 6. The credential and the preflight command
  - [x] 6.1 Implement `azure/credential.py`
    - Exactly one `ClientSecretCredential` per invocation, built only from the `context` values, held on the invocation-scoped object and never a module global, serving both the `management.azure.com` audience and the regional metrics data plane
    - A per-scope `asyncio.Lock` so eight concurrent metric requests trigger at most one token acquisition per audience; read no credential from an environment variable and use no ambient source; a non-expiry authorization rejection raises `AUTH_FAILED`, distinct from `AUTH_EXPIRED`
    - _Requirements: 19.1, 19.2, 19.4, 19.5, 19.6, 19.7_

  - [x] 6.2 Implement `azure/preflight.py` and route the `preflight` command
    - Call `GET /subscriptions/{id}/providers/Microsoft.Authorization/permissions` with the submitted principal's own token and derive `scope_verified` **solely** from that response — never from a successful inventory query, because a resource-group-scoped Reader returns that group's resources while the report is 90% incomplete
    - `true` only when an entry's `actions` match the resource read action with `notActions` leaving it undenied; an empty entry list, a non-success status, a failure, or no completion within 30 seconds all leave it `false` and report `SCOPE_UNVERIFIED`; a secret Azure rejects as expired reports `AUTH_EXPIRED`
    - Probe fidelity: a supplied workspace id whose logical-disk free-space query returns ≥1 row in the trailing 24 hours records `enhanced`, and an absent id, a failure, a rejection or zero rows records `baseline`
    - Route the command in `main.py` and emit its result through the same egress and event vocabulary
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 14.3_

  - [x] 6.3 Integration tests for the credential and the preflight gate
    - A fixture holding at least 2 resource types across at least 2 locations constructs `ClientSecretCredential` exactly once, before the first Azure client; a second invocation in the same process constructs a new one
    - Recorded permissions responses: a subscription-scope read entry → `true`; a resource-group-only assignment and an empty entry list → `false` with `SCOPE_UNVERIFIED`; an expired-secret rejection → `AUTH_EXPIRED`; a 30-second non-completion → `SCOPE_UNVERIFIED`
    - _Requirements: 12.2, 12.3, 12.12, 12.13, 19.1, 19.3, 19.4, 19.6_

- [x] 7. Checkpoint — the runtime answers `preflight`
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Azure subscription onboarding
  - [x] 8.1 Implement `lib/aws/agentcore.ts` and `lib/aws/s3.ts`
    - `agentcore.ts` starting `import "server-only"`, with the **closed** twelve-field `AgentInvokeContext`, the `InvokeCommand` union (`generate_report` | `preflight`) carrying no `prompt` field, `MissingRuntimeConfigError`, and `invokeAgentRuntime` reading `process.env.RPT_RUNTIME_ARN` at call time with `accept: text/event-stream`
    - `s3.ts` with `MAX_PRESIGN_SECONDS = 300`, the pure `parseArtifactKey` and `keyBelongsToActor` doing an **exact segment match** (`segments[0] === actorId && segments[1] === "snapshots"`, never `startsWith`, which would authorize `alice-evil/...` for `alice`), `presignArtifact` and `getSnapshotJson`
    - Extend `app/test/boundaries.static.test.ts`: any module importing `@aws-sdk/*` or `@/lib/crypto` without `import "server-only"` fails, and no source file outside the guard contains the literal `arn:aws:bedrock-agentcore:`
    - _Requirements: 6.1, 6.2, 6.3, 41.1, 41.2, 41.5, 41.8, 37.8_

  - [x] 8.2 Implement `lib/subscriptions/store.ts` and `state.ts`
    - Every read and write scoped to the signed-in user's id, with another user's row resolving as **not found** with no write and no field disclosed; the plaintext secret stored only as `client_secret_enc` ciphertext and excluded from logs, other columns and return values; a UNIQUE violation on `(user_id, subscription_id)` rejected as already connected
    - `resolveSubscriptionState(view, now)` as the single place the displayed state is computed, in the design's precedence: `disabled` (Azure rejected) → expired by recorded date → expiring within 30 days → `pending` → active; the same predicate is reused by the enqueue and reaper gates
    - _Requirements: 9.2, 9.3, 9.7, 9.8, 9.9, 9.10, 13.1, 13.2, 13.3, 13.7, 13.9_

  - [x] 8.3 Implement `lib/subscriptions/azure-artifacts.ts`
    - A **pure** module returning both an `az` CLI script and an ARM template for a supplied subscription id, each emitting **exactly one** role assignment, role `Reader`, scope `/subscriptions/<id>`, and no write-capable action
    - The rendered output shows the target subscription id and never any client secret value
    - _Requirements: 11.1, 11.2, 11.6, 11.8_

  - [x] 8.4 Property test for the generated role assignment
    - `fast-check` over generated subscription ids: both artifacts contain exactly one role assignment, its role is `Reader`, its scope is that subscription's scope path, no emitted action grants a write, and no secret-shaped value appears
    - _Requirements: 11.1, 11.2, 11.6, 11.8, 42.1_

  - [x] 8.5 Implement the preflight route and the create route
    - `POST /api/subscriptions/test` on the Node runtime, parsing `subscriptionTestInputSchema`, invoking `command: "preflight"` through `invokeAgentRuntime` and consuming that short stream inline with a 30-second cap — **this route depends on task 6.2**, because the permissions request is issued by the agent so the app makes no Azure call and holds no Azure token
    - `POST /api/subscriptions` and `GET /api/subscriptions` parsing named zod schemas, inserting `status = 'active'` only on a `scope_verified: true` preflight result, retaining no plaintext secret after the response, and returning only `ConnectedSubscriptionView`
    - Reject a `secret_expires_at` that is absent, at or before now, or more than 24 months out, stating the accepted range; the Preflight_Service remains the only writer of `scope_verified: true`
    - _Requirements: 10.2, 11.9, 11.10, 12.5, 12.11, 12.12, 12.14, 7.7_

  - [x] 8.6 Implement the secret rotation route
    - `POST /api/subscriptions/[id]/secret` replacing `client_secret_enc` with fresh ciphertext, recording the submitted `secret_expires_at`, retaining no earlier ciphertext, and re-running the preflight to set `scope_verified` from the rotated secret
    - _Requirements: 13.7, 13.8, 9.2, 9.7_

  - [x] 8.7 Build the onboarding wizard and the subscriptions screen
    - `app/app/(app)/subscriptions/new/page.tsx` as the four-step wizard with `components/subscriptions/{connect-wizard,reader-role-explainer,az-script-step,arm-template-step,preflight-result,copy-button}.tsx`: the explainer states Reader at subscription scope, that `Monitoring Reader` alone does not grant Resource Graph inventory and inventory identifies the resources metrics are collected for, that Reader exposes resource configuration, and that the connection is read-only
    - The credentials step states the 24-month maximum and common 6–12 month issuance; there is **no control anywhere that saves a connection without a `scope_verified: true` result**; on `SCOPE_UNVERIFIED` the result step states the subscription-scope requirement and why a resource-group-scoped assignment is rejected
    - `app/app/(app)/subscriptions/page.tsx` with `subscription-list`, `secret-expiry-banner` (non-dismissible, whole days remaining, mist neutrals) and `rotate-secret-dialog` (`--destructive` reserved for the expired and disabled states); masked ids in `font-mono` tabular
    - _Requirements: 11.3, 11.4, 11.5, 11.7, 11.10, 12.7, 13.2, 13.3, 13.6, 10.2_

  - [x] 8.8 Tests for the onboarding routes and the expiry state
    - `resolveSubscriptionState` at each precedence step including a `disabled` row whose recorded expiry is still in the future; the 30-day boundary and the whole-days-remaining string
    - Route tests: a `scope_verified: false` preflight inserts no `active` row; another user's subscription id resolves as not found on read, rotate and list; a duplicate `(user_id, subscription_id)` is rejected without a second row
    - _Requirements: 9.8, 9.10, 12.5, 13.2, 13.3, 13.9_

- [x] 9. The metric catalog and the pure collect modules
  - [x] 9.1 Ship `catalog/metrics.v1.json` and `catalog/loader.py`
    - The catalog as **data in the image**, declaring for `Microsoft.Compute/virtualMachines` exactly the eight platform metrics with their unit, `unit_family`, aggregations and `scale`, the `memory_used_pct` derived statistic with its `formula`, `observation: host_observed`, note, and `sources` binding min available memory to `for_statistic: max`, and the enhanced-tier `LogicalDisk % Free Space` counter; no platform metric expressing memory used as a percentage
    - `loader.py` loading once, validating each entry (non-empty name, declared unit, declared family, ≥1 aggregation, `scale` 0–9, no repeated metric name in a resource type, every formula identifier resolvable), freezing the result and exposing `catalog_version`; a failing entry records `catalog_entry_invalid`, is skipped and the run continues with no unhandled exception; zero valid entries for every in-scope type is terminal `CATALOG_UNUSABLE` with no snapshot
    - _Requirements: 32.1, 32.2, 32.3, 32.4, 32.5, 32.6, 32.7, 32.8_

  - [x] 9.2 Unit tests for catalog validation
    - One valid catalog plus one fixture per invalid shape (empty name, unknown unit, unknown family, no aggregation, `scale` 10, duplicated metric name, a formula identifier absent from `sources`), each recording `catalog_entry_invalid` and continuing
    - A catalog whose every entry is invalid raises `CATALOG_UNUSABLE`; mutation of the loaded catalog raises
    - _Requirements: 32.3, 32.4, 32.5, 32.7, 32.8_

  - [x] 9.3 Implement `collect/log.py` and `collect/buckets.py`
    - `log.py` recording typed `collection_log` entries over the declared `gap_type` set, each carrying `gap_type`, `resource_id`, `metric` where applicable and a message
    - `buckets.py` with `resolve_window` (half-open: local start at 00:00:00 through 00:00:00 of the day after the local end date, both converted to UTC), `choose_grain` derived from the offsets evaluated across the window with **no hardcoded zone list**, `local_day` assigning a point by its interval **start** with the timestamp read as UTC, and `day_buckets` retaining partial edge days with their contributing slot count
    - `BASE_GRAIN = "PT1H"` and `FALLBACK_GRAIN = "PT15M"` are the only grains ever requested — never `P1D` (UTC-aligned, so a UTC+07:00 day would silently span 07:00 to 07:00 local) and never `PT1M` (~6 GB of JSON for a 200-resource month); default the timezone to `Asia/Jakarta`, and make an unresolvable zone a terminal error with no metric request and no snapshot
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10, 25.11, 25.12_

  - [x] 9.4 Property test — local-day bucketing at every offset and window edge
    - **Property 6: Local-day bucketing is correct at every offset and every window edge**
    - **Validates: Requirements 25.1, 25.3, 25.5, 25.6, 25.7, 25.8, 25.11, 42.2**
    - Generators: fixed-offset zones `+07:00`, `+00:00`, `+14:00`, `−05:00`, `−11:00`, `+05:45`, `+05:30`, `+08:45`, `−09:30`; local ranges of 1–31 days including `2026-07-01 → 2026-07-31` and `2028-02-28 → 2028-03-01`
    - Declared examples: UTC hours **17:00–23:59 at +07:00 must land on the next local day** and UTC hours **00:00–04:59 at −05:00 on the previous local day**, killing UTC-day bucketing in both offset directions; `2026-07-01 → 2026-07-31` at +07:00 must resolve to `2026-06-30T17:00Z` **inclusive** → `2026-07-31T17:00Z` **exclusive**, killing a `00:00Z…23:59Z` window, and must yield exactly **31** buckets, killing an inclusive end that adds a 32nd
    - Also assert: every instant in the half-open window falls in exactly one bucket with the end instant in none; 24 slots per full day at `PT1H` and 96 at `PT15M`; a partial edge day retained with a slot count of 1–23 (`PT1H`) or 1–95 (`PT15M`); whole-hour offsets select `PT1H`, others `PT15M`, and nothing else is ever selected
    - _Requirements: 25.1, 25.3, 25.5, 25.6, 25.7, 25.8, 25.11, 42.2, 42.4, 42.8_

  - [x] 9.5 Implement `collect/sketch.py`
    - A fixed histogram spanning 0–100 at bin width 0.5 (exactly 200 bins) for the `percentage` family, reporting a bin midpoint, folding out-of-range values into the nearest boundary bin and retaining the **exact observed minimum and maximum** alongside the bins
    - A log-spaced DDSketch at `gamma = 1.02` (≤2048 buckets) for the `magnitude` family, with a **dedicated zero bucket** because `log(0)` has no index and a series of idle intervals must still yield a defined quantile
    - Sketch kind selected from the catalog-declared `unit_family`, never from a metric-name substring; a family selecting neither structure yields no percentile and a `percentile_unsupported_unit` gap; state is bounded and does not vary with the number of points folded
    - _Requirements: 28.1, 28.2, 28.3, 28.9, 28.10, 28.11, 28.13, 26.11, 32.6_

  - [x] 9.6 Property test — sketch quantile error and bounded state
    - **Property 3: Sketch quantiles are bounded in error and in state**
    - **Validates: Requirements 28.1, 28.2, 28.3, 28.10, 28.11, 26.11, 42.2**
    - Generators: streams of `Decimal` values carrying at most 6 decimal places, drawn 0–100 for percentages and 0–10^15 for magnitudes including exact zeros; quantiles from 0–1 plus the declared 0.5, 0.9, 0.95, 0.99 and 1
    - Bounds: fixed histogram within **0.5 percentage points absolute**; DDSketch within **1% relative** (`γ = 1.02` ⇒ `α ≈ 0.0099`, so the bound holds with margin) and exactly 0 where the exact quantile is 0; ≤200 bins and ≤2048 buckets with a serialized size that does not vary with sample count; folding stream A before B and B before A yields a byte-identical serialized form; q=0 equals the observed minimum, q=1 the observed maximum, and estimates are monotone in q
    - Declared examples: a stream where **90% of samples equal 5 and 10% equal 95** — arithmetic mean 14, exact p95 **95** — asserting the estimate at 0.95 is **at least 94.5**, which kills estimating a percentile from an interval mean; and a **44,640-sample** stream (a 31-day month at `PT1M`) asserting the state and size bounds, which kills any implementation that retains the folded points
    - _Requirements: 28.1, 28.2, 28.3, 28.10, 28.11, 26.11, 42.2, 42.4, 42.8_

  - [x] 9.7 Implement `collect/accumulate.py`
    - `MetricAccumulator` holding `{total, count, minimum, maximum}` plus its sketch; the average is `sum(total) / sum(count)` with **no code path** computing a mean of per-interval averages; min/max roll up as the min of minima and max of maxima, exactly, at any grain
    - Every operation on `Decimal` with no `float` between a folded response and a snapshot value; division at ≥28 significant digits quantized to exactly 6 decimal places rounding half to even; a zero-count or malformed interval leaves the accumulator untouched and records `interval_malformed`; a pair whose summed count is zero emits no average, minimum or maximum and records `no_samples`; fold order is irrelevant
    - Derived `memory_used_pct` per the catalog's `for_statistic` bindings — avg utilization from the count-weighted avg of `Available Memory Bytes`, **max utilization from its minimum** and **min utilization from its maximum**, because the expression is monotonically decreasing in available memory; absent or zero SKU memory records `sku_capability_missing` and emits nothing; a result outside 0–100 records `metric_error` and emits nothing rather than clamping; exclude every resource carrying `deallocated`, `power_state_unknown` or `sku_unknown` from the values those gaps invalidate
    - _Requirements: 20.6, 20.13, 21.8, 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.9, 27.10, 27.11, 27.12, 30.1, 30.7, 30.8_

  - [x] 9.8 Property test — count-weighted aggregation
    - **Property 1: Count-weighted aggregation is exact and partition-independent**
    - **Validates: Requirements 27.1, 27.2, 27.3, 27.4, 27.9, 27.11, 27.12, 42.2**
    - Generators: samples as `Decimal` with at most 6 decimal places drawn 0–100 (percentage) or 0–10^15 (magnitude); per-bucket sample counts 0–60; bucket count 1–744, the hourly slot count of a 31-day window
    - Declared examples: **one bucket of 3 samples at 100 and one of 60 samples at 0** — count-weighted `300 / 63 = 4.761905` against a mean-of-means `50.000000`, a 45-point gap; and **744 buckets whose first 700 carry a count of 0 and whose remaining 44 carry 60 samples each**, which kills dividing by the bucket count and reproduces both the month boundary and the recently-created VM
    - Also assert: min and max equal the underlying samples' exact extremes; identical results under every fold order and across every partition of one sample list; a partition containing zero-count buckets equals the same partition with them removed; an all-zero-count partition emits no average, minimum or maximum
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 27.9, 27.11, 27.12, 42.2, 42.4, 42.8_

  - [x] 9.9 Implement `collect/snapshot.py`
    - `build_snapshot` emitting every field the design's snapshot document carries — `schema_version`, `producer`, `run_id`, `subscription_id`, `scope_verified`, `collected_at`, `timezone`, `utc_offset`, `grain`, the half-open `window`, `requested_scope`, `raw_archive.complete`, sorted `resources` with power state, fidelity tier and SKU capacity, per-metric statistics, `day_buckets`, and the full `gaps` list — with every metric value a decimal string at the catalog-declared scale in plain notation
    - `assert_no_floats` raising with the offending field path and writing nothing; `canonical_bytes` popping `content_hash` and `snapshot_id` at the **top level only** (a recursive strip would make two structures differing in a nested `content_hash` hash alike) and canonicalizing with `rfc8785`; `content_hash` as 64 lowercase hex; `snapshot_id` equal to it character for character
    - Produce every array order rather than inheriting it — resources by id, statistics by metric then statistic, gaps by `gap_type` then `resource_id` then `metric` — and iterate no `set` anywhere on the snapshot path; apply no Unicode normalization; `write_once` uses `PutObject` with `IfNoneMatch: "*"` to `<actor_id>/snapshots/<runId>/snapshot.json`, tagged with the owning actor id, logging a `412` and leaving the existing bytes untouched, with no update or delete path
    - No object key named `p95`, `p99` or `p` followed only by digits at any level; a percentile is an object carrying `metric`, `statistic`, `value`, `estimator`, `fidelity_tier` and `unit`, marked estimated for a `baseline` resource, with the estimator naming both the source grain and the interval statistic folded and derived from the sketch rather than the fidelity tier
    - _Requirements: 28.4, 28.5, 28.6, 28.7, 28.8, 28.12, 29.9, 30.2, 30.3, 30.4, 30.5, 30.6, 30.9, 31.8, 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.7, 34.8, 34.9, 34.10, 35.1, 35.2, 35.3, 35.4, 35.5, 35.6, 35.8, 35.9, 35.10_

  - [x] 9.10 Property test — JCS canonicalization and content addressing
    - **Property 2: JCS canonicalization and content addressing are stable**
    - **Validates: Requirements 34.1, 34.2, 34.3, 34.4, 34.5, 42.2**
    - Generators: nested objects and arrays at least 4 deep; keys and string values from ASCII plus at least one character outside the Basic Multilingual Plane, at least one pair of keys differing only by letter case, and at least one string requiring JSON escaping; one empty object and one empty array; at least 10 permutations of each object's key insertion order
    - Declared examples: the metric value decimal strings **`9007199254740993`**, **`0.1`**, **`0.30000000000000004`** and one 17-significant-digit value, any of which changes the digest if a value round-trips through a binary float; a **two-process** run of the same commit under differing `PYTHONHASHSEED`, which kills ordering that depends on in-process hash randomization; a key pair differing only by NFC/NFD, which kills a normalizing implementation; keys differing only by case, which kills a code-point sort where UTF-16 code-unit order is required; and a nested field named `content_hash`, which must change the digest
    - Also assert: byte-identical canonical form across key-order permutations; identical digests for structures equal ignoring key order; the digest unchanged by the presence or absence of the top-level `content_hash`; and every JSON number token in the canonical form an integer containing no `.`, `e` or `E`
    - _Requirements: 34.1, 34.2, 34.3, 34.4, 34.5, 42.2, 42.4, 42.8_

  - [x] 9.11 Unit tests for the snapshot builder and the derived inversion
    - `snapshot_id == content_hash`; `assert_no_floats` naming the field path; a second write to an existing key leaving the bytes unchanged; the `p`-followed-by-digits key assertion over a built document
    - A hand-built fixture asserting max memory utilization comes from the **minimum** of `Available Memory Bytes` and min utilization from its maximum, and that every derived value carries both `derived_from` and `formula`
    - A `Network In Total` value labelled NIC-level with its interval recorded, and no string field containing egress, transfer cost, bandwidth charge or billable in any casing
    - _Requirements: 28.4, 30.1, 30.5, 30.6, 30.9, 34.5, 34.9, 34.10_

- [x] 10. Checkpoint — the pure core is proven
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. The Azure collector
  - [x] 11.1 Define `azure/ports.py` and the recorded-response fakes
    - `InventoryPort`, `MetricsPort`, `SkuPort` and `DefinitionsPort`, so `collect/` imports nothing from `azure/` and the pipeline is exercisable without a subscription
    - `agent/tests/fakes/` replaying recorded JSON bodies for: `skip_token` pages including one resource id repeated across a page boundary, `x-ms-user-quota-remaining` at 1 and 0 with and without a parseable reset header, an HTTP 200 batch response carrying a per-resource 403, a requested resource absent from a response, an interval missing `count`, a response-too-large rejection, HTTP 429 with `Retry-After` as seconds and as an HTTP-date, a DNS resolution failure for one location, a SKU list with and without `vCPUsAvailable`, and a Log Analytics logical-disk row whose `InstanceName` collapsed to `_Total`
    - An in-memory `ObjectStore` fake recording conditional-put semantics
    - _Requirements: 18.3, 18.4, 18.7_

  - [x] 11.2 Implement `azure/inventory.py`
    - The Resource Graph query scoped to the run's `subscription_id`, projecting id, name, type, location, resource group, tags, the SKU or size identifier and `properties.extended.instanceView.powerState.code`, ordered by id ascending so `skip_token` paging is stable
    - Page until a response carries no `skip_token`; `x-ms-user-quota-remaining >= 1` issues the next request with no interposed wait, `0` waits exactly `x-ms-user-quota-resets-after` with no locally chosen backoff in its place, and an absent or unparseable reset header waits 5 seconds at most 3 consecutive times before reporting `THROTTLED`
    - Power state produces gaps, never omissions: `PowerState/deallocated` or `PowerState/stopped` records a `deallocated` gap carrying the exact code while the resource **stays in the inventory** with its id, type, location, group, tags and power state; an absent or empty code on a VM records `power_state_unknown`; a repeated resource id keeps one entry and records `duplicate_inventory_row`; record `fidelity_tier` and `power_state` on every resource
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.9, 20.10, 20.11, 20.12, 20.13, 20.14_

  - [x] 11.3 Implement `azure/skus.py`
    - `resource_skus.list` **always** location-filtered; vCPU capacity read from `vCPUsAvailable` parsed as `Decimal`, with `vCPUs` excluded from every capacity computation because a constrained-core SKU reports the parent's count (`Standard_E32-8s_v5` advertises 32 while exposing 8)
    - `MemoryGB` parsed as `Decimal` in GiB and multiplied by exactly `1073741824` with decimal arithmetic, emitted as an integer-valued decimal string with unit bytes; no `float` on the path from a capability to a snapshot value
    - Cache keyed `(subscription, location)` and discarded at run end; a SKU absent from the location's listing records `sku_unknown`; an absent or unparseable `vCPUsAvailable` or `MemoryGB` records `sku_capability_missing` naming the SKU and capability and **never** falls back to `vCPUs`
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.9, 21.10, 21.11, 21.12_

  - [x] 11.4 Implement `azure/definitions.py`
    - Probe `MonitorManagementClient.metric_definitions.list` once per `(resource_type, region)` and serve every later request for that pair from the cache, which is discarded at run end
    - Probe the lowest-sorting resource id in the pair, retrying against at most 2 further distinct resources; a pair whose every attempt fails stores nothing, records `definitions_unavailable`, and the collector requests the catalog's declared metric set for that pair rather than skipping its resources; never derive a `metric_not_emitted` gap from a failed probe
    - _Requirements: 22.1, 22.2, 22.4, 22.5, 22.6, 22.7, 20.7_

  - [x] 11.5 Implement `azure/regions.py`
    - Select `https://{location}.metrics.monitor.azure.com` for the `location` component of the batch grouping key; on DNS resolution failure memoise that location as fallback-only for the rest of the run and route every later request for it to per-resource `MonitorManagementClient.metrics.list` with no further DNS attempt
    - The fallback requests the same grain, window, metric names and aggregations as the batch path; every distinct location receives at least one metric request so no region is dropped; a location whose fallback also fails records `region_unreachable` for each of its resources with no statistic and no zero value and reports `REGION_UNREACHABLE` as non-terminal
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.6, 24.7_

  - [x] 11.6 Implement `azure/metrics.py` and `collect/archive.py` in one fold pass
    - `plan_batches` grouping by `(subscription, location, resource_type)` — one `metric_namespace` per call, and the data plane is regional — sizing by the **points budget of 20000** with `capacity = max(1, POINTS_BUDGET // (metric_count * interval_count))` rather than by the documented 50-resource cap, requesting `Total`, `Count`, `Minimum` and `Maximum`, and treating batch sizing as the only control over response size because the endpoint has no paging
    - Adaptive halving by integer division to a floor of one resource; a single-resource batch that still fails splits by metric name, and a failing single-metric request records `response_too_large` with no zero value; concurrency capped at 8 in-flight requests per subscription counting fallback requests against the same semaphore; 429 waits exactly `Retry-After` (seconds or HTTP-date) and 5 consecutive 429s report `THROTTLED`
    - Match every returned series to a requested resource **by resource id, never by position**; inspect the error field of **every** resource entry in an HTTP 200 response and record a typed gap for each, with an unrecognised classification recorded as `metric_error`; a requested resource absent records `resource_absent_from_response`; an interval missing `count` or `total` records `interval_counts_missing` and is excluded from the average; no code path turns a per-resource error into a zero and no bare exception suppression exists between a response and the accumulator
    - **`collect/archive.py` ships in this task, not as a follow-up.** Each response is gzip-written to `<actor_id>/snapshots/<runId>/raw/<seq>-<location>-<type>.json.gz` carrying the grouping key, grain, window and metric names, in the same pass that folds it and before its points are discarded — once the points are gone they are gone, so a retrofitted archive would have to re-collect against data that may have shifted. A rejected request writes no object; a failed write records `archive_write_failed`, folds anyway, continues, and marks the snapshot's archive incomplete; retain only `{total, count, min, max}` plus the sketch per (resource, metric) and materialize no full series
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12, 23.13, 23.14, 24.8, 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 26.11, 26.12, 27.8, 29.1, 29.2, 29.3, 29.4, 29.6, 29.7_

  - [x] 11.7 Property test — points-budget batch planning
    - **Property 4: Batch planning respects the points budget and loses nothing**
    - **Validates: Requirements 23.1, 23.2, 23.3, 23.4, 42.2**
    - Generators: resource count 1–500, metric count 1–8, expected points per metric 1–2976 (the slot count of a 31-day window at a grain drawn only from `PT1H` and `PT15M`), distinct locations 1–10, distinct resource types 1–3, plus generated sequences of oversized-response rejections
    - Declared example: **50 resources × 6 metrics × 720 hourly points = 216,000 points**, where `per_resource = 4320` gives `capacity = 4`, so the planner must emit **at least 11 batches** — an implementation sizing by the 50-resource cap emits 1 and fails here
    - Also assert: every batch at most 20000 estimated points except a single-resource batch and no empty batch; the batches' union equals the input exactly with no duplicate or omission; two passes over one input emit identical batches in identical order; every batch's resources share one grouping key; a resource exceeding the budget alone is emitted alone rather than dropped; the halving loop terminates within `ceil(log2(n)) + 1` requests and a rejected single-resource batch stops halving and records a typed gap rather than reaching size zero
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 42.2, 42.4, 42.8_

  - [x] 11.8 Implement `azure/provider.py`
    - Implement the `Provider` protocol inside `azure/` over the inventory, SKU, definitions, metrics and regions modules, returning `DiscoverResult` sorted by resource id and `CollectResult` plus gaps as plain data, and declaring `capabilities()` from the catalog
    - Register it in `providers/registry.py`; an exception crossing the protocol becomes a terminal `error` carrying the scrubbed text followed by `done`
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.8, 18.9_

  - [x] 11.9 Implement `collect/pipeline.py`
    - Orchestrate discover → gate → collect → snapshot, emitting `collect_inventory` and `collect_metrics` tool steps with determinate `progress` counts, firing the phase transitions through `progress.py`, and emitting exactly one `snapshot_ready` before `done`
    - Run the **empty-scope gate after inventory paging and before the first metrics request, the first archive write and any snapshot write**: count distinct resource ids after `duplicate_inventory_row` de-duplication and **include** resources carrying `deallocated`, `power_state_unknown` or `permission_denied` gaps, so a subscription whose VMs are all stopped is not `EMPTY_SCOPE`; zero resources is terminal `EMPTY_SCOPE` with no snapshot object and no `snapshot_ready`, whatever the cause; at least one resource but zero statistics is terminal `NO_STATISTICS`
    - Set `fidelity_tier` per resource from this run's evidence with the subscription's tier as a ceiling and propagate it to every value; a `baseline` resource issues no Log Analytics query and emits no per-volume free space, guest-observed memory or measured percentile; an `enhanced` resource queries exactly the catalog's declared counters bounded to the window and records the counter name and workspace id, downgrades to `baseline` on failure, rejection or zero rows, and records `instance_name_collapsed` with **no** per-volume or resource-level value for a `_Total`, absent or empty `InstanceName`; request no platform metric for in-guest disk free space
    - Complete a run carrying ≥1 gap as `completed` while emitting a non-terminal `PARTIAL_COVERAGE` error event before `done`; fail terminally only when **every** location is unreachable
    - _Requirements: 14.7, 14.8, 14.9, 24.5, 29.5, 29.8, 29.9, 31.1, 31.2, 31.3, 31.4, 31.5, 31.6, 31.7, 31.9, 33.1, 33.2, 33.5, 33.6, 33.7, 35.7_

  - [x] 11.10 Integration tests over the faked Azure ports
    - Inventory: `skip_token` paging, a resource id duplicated across a page boundary recording `duplicate_inventory_row` without changing the count, quota-header waits including the 4th-wait `THROTTLED`, and a deallocated VM retained and labelled
    - Metrics: a per-resource 403 inside an HTTP 200 response recorded as `permission_denied` with no zero folded; a requested resource absent recorded as `resource_absent_from_response`; an interval missing `count` excluded from the average; a response-too-large sequence halving to one resource then splitting by metric; `Retry-After` honoured as both seconds and HTTP-date
    - SKUs: `vCPUsAvailable` used and `vCPUs` ignored for a constrained-core SKU; a missing capability recorded as `sku_capability_missing` with no memory percentage emitted. Definitions: 50 resources sharing one `(resource_type, region)` issue exactly 1 probe, and one type across 2 regions issues exactly 2. Regions: a DNS failure routing to the per-resource fallback whose responses are archived
    - _Requirements: 20.3, 20.4, 20.12, 20.14, 21.3, 21.9, 21.10, 22.3, 23.3, 23.8, 23.12, 23.13, 23.14, 24.2, 24.8, 29.1, 29.2, 29.6, 31.6_

  - [x] 11.11 Tests for the pipeline gates
    - A subscription whose every VM is deallocated must **not** be `EMPTY_SCOPE`; a zero-resource union must be terminal `EMPTY_SCOPE` with no snapshot object and no `snapshot_ready`; resources with zero statistics must be terminal `NO_STATISTICS`; every location unreachable must fail with `REGION_UNREACHABLE` while one unreachable location must not
    - A run with gaps completes and emits `PARTIAL_COVERAGE` with `terminal: false` before `done`; the gap count carried by `snapshot_ready` equals the number of entries recorded during collection
    - _Requirements: 24.4, 24.5, 29.5, 29.9, 33.1, 33.5, 33.6, 33.7, 35.7_

- [x] 12. Checkpoint — a snapshot is produced against fakes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Run orchestration
  - [x] 13.1 Implement `lib/runs/state.ts` and `lib/runs/gaps.ts`
    - `state.ts` declaring the `DRIVEN` transition table (`queued → claimed|failed`, `claimed → collecting|failed`, `collecting → completed|failed`, with `compiling`, `rendering` and `verifying` present but empty and unreachable), the phase-deadline budgets of 900/300/1800 seconds, the terminal error-code set, and helpers that set `updated_at` on every write changing another column and scope every read and write to the signed-in user's id, resolving another user's row as not found
    - `gaps.ts#loadRunGaps(run)` reading `<actor_id>/snapshots/<runId>/snapshot.json` server-side once on a terminal row and projecting its `gaps` array, so the gap list needs neither a column nor a table
    - _Requirements: 36.1, 36.2, 36.3, 36.6, 36.7, 36.9, 36.10, 36.11_

  - [x] 13.2 Implement `lib/runs/dedupe.ts` and `lib/runs/progress-token.ts`
    - `deriveDedupeKey` as a pure SHA-256 over `v1`, user id, subscription id, period start and end, timezone, sorted resource types, sorted resource groups and the enqueue instant floored to a 60-second boundary, joined by a unit separator, drawing no random value
    - `deriveProgressToken(runId)` as `base64url(HMAC-SHA256(resolveEncryptionKey(), "progress-token" || runId))` with only `sha256(token)` stored, because the tick that invokes the runtime is a **later request** than the enqueue and the only persisted form is one-way; plus `progressTokenHash` and a `timingSafeEqual`-based `validateProgressToken`
    - _Requirements: 37.1, 37.3, 38.5_

  - [x] 13.3 Unit tests for dedupe, the progress token and key authorization
    - `deriveDedupeKey` stability within one 60-second bucket and change across the bucket edge; independence from resource-type and resource-group input order; no randomness
    - Token derivation determinism, hash storage, and constant-time validation rejecting a wrong token; `keyBelongsToActor` rejecting `alice-evil/snapshots/...` and `other/alice/snapshots/...` for `alice`
    - _Requirements: 37.1, 37.3, 37.8, 37.12, 38.5_

  - [x] 13.4 Implement the enqueue action and the run read routes
    - `lib/actions/runs.ts#enqueueRun` parsing `runCreateInputSchema` (with `runScopeSchema`), inserting one `queued` row with the derived `dedupe_key`, `progress_token_hash` and a 900-second `phase_deadline`, and **returning within 2 seconds** while awaiting nothing but its own validation and write — no stream, no AgentCore call, no Azure call
    - Reject before insert: a subscription that is not this user's or not `active`, and a period that is inverted, outside 1–31 local days, or ending after the current local date in the run's timezone; on a `dedupe_key` UNIQUE violation return the **existing** run, insert no second row and mint no second token
    - `POST /api/runs` as a thin wrapper and `GET /api/runs/[runId]` returning `RunView` plus the gap list, both on the Node runtime with `RouteContext`-typed awaited params; route form-triggered and chat-triggered runs through this one action
    - _Requirements: 37.1, 37.2, 37.4, 37.5, 37.9, 37.10, 36.5, 7.7_

  - [x] 13.5 Implement the progress callback endpoint
    - `POST /api/internal/runs/[runId]/progress` parsing `progressCallbackSchema`, reading the token from `X-Rpt-Progress-Token` and validating it against the stored hash with a constant-time compare; a bad token and an unknown run id return **one identical** `404` with a fixed body
    - `progressCallbackSchema` gains `current` (optional non-negative int), `total` (optional positive int) and `label` (optional, max 64 chars). The callback field is named **`current`** while the emitted SSE event field is named **`done`** — that is deliberate and renames nothing: the callback names a column, the event names a field of the declared vocabulary, and the relay maps `progress_current → done` when it emits
    - Accept only `{current} ∪ DRIVEN[current]`: every transition on a terminal row is rejected with no write including a repeat of its own terminal status, and a presented `TIMEOUT` or an out-of-set `failed` code is rejected because the reaper is the only `TIMEOUT` writer
    - A valid **non-terminal** transition persists `progress_current`, `progress_total` and `progress_label` from the request alongside `status`, `updated_at` and `phase_deadline`
    - A target **equal to the current status** applies no `status` change but **is not a no-op**: it writes the presented `progress_current`, `progress_total` and `progress_label`, refreshes `updated_at`, and refreshes `phase_deadline` to that phase's budget. It is idempotent **with respect to `status` only** — the progress columns are written on every such callback, so a progress refresh inside one phase is persisted rather than discarded as a repeated transition. Do not read "idempotent" as licence to skip that write
    - A presented `current` **below** the `progress_current` already stored for that run while the row's `status` equals the presented target leaves all three progress columns unchanged and applies the remainder of the request normally, so the row rather than the caller preserves Req 14.8's non-decreasing invariant against an out-of-order retry
    - A valid terminal transition records `error_code`/`error_message` or `snapshot_id`/`resource_count`/`gap_count`, clears `phase_deadline` **together with `progress_current`, `progress_total` and `progress_label`** so a terminal row carries no stale in-flight count, writes no column derived from the presented token, and returns within 2 seconds awaiting no AgentCore, S3 or Azure call
    - _Requirements: 38.5, 38.6, 38.7, 38.8, 38.9, 38.10, 38.11, 38.12, 38.13, 38.14, 36.9_

  - [x] 13.6 Implement the reaper
    - `POST /api/cron/tick` comparing the presented bearer against `RPT_CRON_SECRET` over equal-length SHA-256 digests with `timingSafeEqual`, **failing closed** when the variable is unset or empty, and claiming nothing and writing nothing — including no `TIMEOUT` — on rejection
    - In one request and in this order: the **deadline sweep** setting every `queued`/`claimed`/`collecting` row past `phase_deadline` to `failed`/`TIMEOUT` with an `error_message` naming the expired phase from the pre-update `status`, limited to 100 rows; then the atomic claim `UPDATE … SET status='claimed' … WHERE id IN (SELECT id … WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10)` with a `claimed_by` uuid minted once per request, so overlapping ticks claim disjoint sets and swept rows are excluded by construction
    - Per claimed row: fail `SCOPE_UNVERIFIED` for `scope_verified = false` and `AUTH_EXPIRED` for `secret_expires_at <= now` with no invocation; fail `SECRET_UNREADABLE` on a decryption failure with the ciphertext and key material excluded from `error_message`; re-read the row and skip the invoke unless it is still `claimed`; invoke with `sessionIdForRun(runId)`, the closed twelve-field context and a 10-second start budget, then release the response with a **detached drain** that parses no event and holds no state; log a failure to start without secrets, leave the row at `claimed` for the sweep, and continue with the remaining rows; respond within 10 seconds awaiting no run
    - The reaper is foundation, not deferrable — without it one crashed container leaves rows stuck forever
    - _Requirements: 39.1, 39.2, 39.3, 39.4, 39.5, 39.6, 39.7, 39.8, 39.9, 39.10, 39.11, 39.13, 41.3, 41.4, 41.5, 41.6, 41.7, 41.8, 41.9, 41.10, 41.11, 12.6, 13.4_

  - [x] 13.7 Postgres integration tests for claiming, sweeping and deduplication
    - Two concurrent transactions claim disjoint row sets under `FOR UPDATE SKIP LOCKED`; the sweep names the expired phase from the pre-update `status` and runs before the claim so a past-deadline `queued` row is failed rather than claimed
    - A `dedupe_key` race resolves to one row and one token; the `report_runs_error_code_ck` CHECK rejects a `failed` row with no code and a `completed` row with one; a rejected bearer writes nothing
    - _Requirements: 36.4, 36.5, 36.6, 39.3, 39.5, 39.7, 39.11_

  - [x] 13.8 Implement the cosmetic SSE relay and `useRunStream`
    - `GET /api/runs/[runId]/stream` with `export const runtime = "nodejs"`, `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, authorizing the session and the run's `user_id` and resolving a mismatch as not found with no stream opened
    - Derive every event **only** from the `report_runs` row and the stored gap list, polling every 2 seconds, emitting a `heartbeat` every 15 seconds while non-terminal, `snapshot_ready` then `done` on `completed`, `error` then `done` on `failed`, and closing after 120 consecutive seconds carrying nothing but heartbeats; make **no** AgentCore invocation — the invocation was started by the tick in a request that has already returned, so there is no upstream stream to attach to and attaching would re-run the collection
    - Emit `progress` from the row's `progress_current`, `progress_total` and `progress_label` while the row is non-terminal **and both counts carry a value**, mapping `progress_current → done`, taking `id` from the row's `status` so it matches the relay's own `tool` step ids, and taking `unit` from a per-phase constant in `app/lib/events.ts` rather than from run state; carry exactly the declared field names `id`, `done`, `total`, `unit` and `label`, renaming none and adding none, and keep successive `done` values for one `id` non-decreasing. While either count is absent emit **no** `progress` event at all, so a phase carrying no countable work produces no false determinate bar
    - `app/hooks/useRunStream.ts` parsing the stream into UI state, keeping presentation components free of parsing, ignoring any unknown event type, reopening within 5 seconds while the run is non-terminal, rebuilding state from the row before rendering, and opening no further stream once terminal
    - _Requirements: 40.1, 40.2, 40.3, 40.4, 40.5, 40.6, 40.8, 40.9, 40.10, 40.11, 40.12, 40.14, 40.15_

  - [x] 13.9 Implement the artifact presign route
    - `GET /api/artifact-url` parsing `artifactUrlQuerySchema`, authorizing that the key's first segment equals the signed-in user's id **and** that the run's `user_id` equals it before any AWS call, minting a presigned GET of at most 300 seconds, sending `Cache-Control: no-store`, storing no URL and placing none in a cacheable or server-rendered payload; a mismatch resolves as not found with no URL minted
    - _Requirements: 37.8, 37.12_

  - [x] 13.10 Build the reports and dashboard surfaces
    - `app/app/(app)/reports/page.tsx` with `run-list` and `run-form` (period, subscription, scope), and `reports/[runId]/page.tsx` with `run-progress`, `activity-timeline` showing determinate `142 / 200 resources` rather than an indeterminate spinner, `snapshot-provenance` (id truncated in mono with copy, window in Asia/Jakarta **with the offset shown**, grain, counts), `gap-list` grouped by `gap_type` in mist neutrals, and `fidelity-badge`
    - That determinate count is fed by the `progress` events task 13.8's relay derives from the row's `progress_current` / `progress_total` / `progress_label`, so the timeline's promise is backed by a persisted source rather than aspirational; the bar is up to ~7 seconds stale worst case (the reporter's 5-second throttle plus the relay's 2-second poll) on a run that lasts 8 to 12 minutes, and it renders no bar at all while the row carries no counts
    - `app/app/(app)/dashboard/page.tsx` with recent runs, subscription health and expiry banners; every figure in `font-mono` tabular with no count-up animation; run status announced through `aria-live="polite"`; terminal state read from `report_runs.status`, `error_code` and `error_message` as well as events, because `TIMEOUT` arrives with no event to carry it
    - An `EMPTY_SCOPE` failure states that zero resources were found, names the subscription and period, states that no artifact was produced, and lists an expired client secret and a below-subscription-scope Reader assignment as the causes to check
    - _Requirements: 33.4, 36.7, 40.4, 40.8, 12.7, 13.2, 13.3, 13.6_

  - [x] 13.11 Tests for the relay and the run surfaces
    - The relay makes no AgentCore call, closes after the 120-second heartbeat-only window, resolves another user's run as not found, and emits `snapshot_ready` then `done` on a completed row; `useRunStream` ignores an undeclared event type and rebuilds state from a fetched row after a reconnect
    - Progress emission: **no** `progress` event when either `progress_current` or `progress_total` is null, and `id`/`done`/`total`/`unit`/`label` emitted from the row and the per-phase unit constant when both carry a value
    - Callback persistence: a same-status callback writes all three progress columns while leaving `status` unchanged; an out-of-order lower `current` for the same phase leaves all three unchanged; a terminal transition clears all three alongside `phase_deadline`
    - RTL assertions for the `EMPTY_SCOPE` copy, a `TIMEOUT` row rendering terminal state with no event, and the gap list rendering in mist neutrals rather than `--destructive`
    - _Requirements: 33.4, 36.7, 38.12, 38.13, 38.14, 40.3, 40.6, 40.9, 40.10, 40.12, 40.14, 40.15_

- [x] 14. Final guards, wiring and verification
  - [x] 14.1 Complete the app boundary guard
    - Finish `app/test/boundaries.static.test.ts` with the remaining rules: every route handler returning `text/event-stream` exports `runtime = "nodejs"`; `next-auth` and `@auth/drizzle-adapter` appear in neither dependency list; no file imports `next-auth` or a `next-auth/*` subpath; **no file under `app/` contains the literal `next-auth` at all** (the sibling project's only surviving references are stale `vi.mock("next-auth/jwt")` no-ops); no route exists under a `[...nextauth]` segment; `shadcn` remains in `dependencies`; `components.json` and the existing `globals.css` token values are unchanged
    - Define a source file as every `.ts`/`.tsx` outside `node_modules` and `.next` whose name excludes `.test.` and `.spec.`, and assert the guard's own completeness — **a scanned directory that is absent or yields zero source files fails the guard**, so it can never pass by scanning nothing
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13_

  - [x] 14.2 Add the property-hygiene guards in both languages
    - `app/test/property-hygiene.static.test.ts` and `agent/tests/test_property_hygiene.py` parsing the property modules and failing if any property is skipped, marked as an expected failure, declares fewer than 100 runs or examples, or suppresses `HealthCheck.filter_too_much` or `HealthCheck.data_too_large`
    - Assert that each fixed counterexample from a resolved defect is retained as an explicitly declared `@example` or case, so it runs on every subsequent execution
    - _Requirements: 42.1, 42.2, 42.6, 42.7, 42.8_

  - [x] 14.3 Wire and verify the full run against faked Azure
    - Drive one `generate_report` end to end through the faked ports and the in-memory object store: enqueue inserts `queued`; a tick sweeps, claims with `SKIP LOCKED`, gates, recomputes the progress token and invokes; the runtime emits `tool`/`progress`/`heartbeat`, posts `collecting`, passes the empty-scope gate, folds and archives in one pass, writes the snapshot once, emits `snapshot_ready` then `done`, and posts the terminal transition; the row reaches `completed` carrying `snapshot_id`, `resource_count` and `gap_count`, and the relay reconstructs that state from the row alone
    - Assert in that same sequence that a mid-collection progress callback lands on the row's `progress_current` / `progress_total` / `progress_label` and that the relay's next poll renders a determinate count from it, and that all three columns are null once the row reaches `completed`
    - Assert the ordering contract holds — `snapshot_ready` precedes `done`, nothing follows `done`, and no `verification` or `report_file` event is ever emitted — and that no `client_secret`, `progress_token`, `tenant_id` or `client_id` value appears in any event, log line or persisted row
    - Confirm `pnpm lint`, `pnpm typecheck`, `pnpm test` and, in `agent/`, `.venv/bin/pytest` and `.venv/bin/ruff check .` are all clean
    - _Requirements: 14.9, 14.10, 14.11, 15.6, 15.7, 26.3, 34.9, 35.6, 35.7, 36.12, 38.1, 38.12, 38.13, 39.4, 39.6, 40.4, 42.5_

- [x] 15. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Every task in this plan is required. There are no optional tasks: the properties, the guards,
  and the breadth-covering unit, example and integration tests all gate completion. This is a
  product whose entire claim is that a figure in a document can be traced to its source, so an
  untested collector or an unverified boundary is not a faster MVP, it is an unproven one.
- Ordering that is not negotiable, and why: the dependency and harness tasks (1.1, 1.2) precede
  every test-bearing task; the `.gitignore` negation ships with `.env.example` (1.3) because the
  guard asserts both; `lib/env.ts` and `lib/crypto.ts` precede anything resolving a secret,
  since `resolveEncryptionKey` also keys the progress-token HMAC; the schema (2.1) precedes
  anything reading or writing a row; the agent entrypoint and `preflight` (5.10, 6.2) precede
  the wizard's accept path (8.5); the pure collect modules and their properties (9.3–9.10)
  precede every Azure client; the ports and fakes (11.1) precede the real clients; `archive.py`
  ships inside the metrics fold task (11.6); and the reaper ships with the state machine (13.6).
- Each property task names the generator strategy, the concrete bound and the specific declared
  example that fails the naive implementation, per the design's `Properties → implementation`
  table.
- Out of scope for every task above, and therefore absent by design: the template definition
  model and block config schemas, the document AST, the compiler, the figure ledger, `formatted`
  production, the `.docx`/`.pdf` renderer, theme documents, the document verifier, replay
  execution, drift sampling, run comparison, chat history, DynamoDB, AI conversation titles,
  charts and the `--cat-*` palette. `compile/`, `render/`, `verify/`, `compare/` and `tools/` are
  not created. `report_runs.status` carries `compiling`, `rendering` and `verifying` as defined
  but undriven values, and `events.py` / `lib/events.ts` declare the full ten-type vocabulary
  while this spec emits six.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "5.2", "5.4"] },
    { "id": 2, "tasks": ["1.8"] },
    { "id": 3, "tasks": ["1.4", "1.5", "2.1", "5.3", "5.5", "5.6", "5.13"] },
    { "id": 4, "tasks": ["1.6", "1.7", "2.2", "2.3", "3.1", "5.7", "5.8", "5.12", "9.1"] },
    { "id": 5, "tasks": ["2.4", "3.2", "3.3", "5.9", "5.10", "9.2", "9.3", "9.5"] },
    { "id": 6, "tasks": ["3.4", "5.11", "5.14", "6.1", "9.4", "9.6", "9.7"] },
    { "id": 7, "tasks": ["3.5", "3.6", "6.2", "8.1", "8.3", "9.8", "9.9", "11.1"] },
    { "id": 8, "tasks": ["3.7", "3.8", "6.3", "8.2", "8.4", "9.10", "9.11", "11.2", "11.3", "11.4", "11.5", "13.1", "13.2"] },
    { "id": 9, "tasks": ["3.9", "8.5", "11.6", "13.3", "13.4"] },
    { "id": 10, "tasks": ["8.6", "8.7", "11.7", "11.8", "13.5", "13.8", "13.9"] },
    { "id": 11, "tasks": ["8.8", "11.9", "11.10", "13.6", "13.10"] },
    { "id": 12, "tasks": ["11.11", "13.7", "13.11"] },
    { "id": 13, "tasks": ["14.1", "14.2"] },
    { "id": 14, "tasks": ["14.3"] }
  ]
}
```
