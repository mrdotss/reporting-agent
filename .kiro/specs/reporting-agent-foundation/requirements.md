# Requirements Document

## Introduction

This spec builds the **foundation** of the Infrastructure Utilization Reporting Agent: the
authenticated web app, Azure subscription onboarding with a hard authorization gate, the
Python AgentCore runtime skeleton, and the deterministic Azure metrics collector that
produces one **immutable, content-addressed snapshot** per run.

The product invariant — *no LLM ever produces a number* — is enforced structurally rather
than requested. This spec lays the half of that invariant that must exist before any
document can be produced: a snapshot whose every value is a fixed-precision decimal string,
whose id **is** the hash of its RFC 8785 canonical form, and whose every gap is recorded
rather than zero-filled.

The web app is already scaffolded (Next.js 16, React 19, Tailwind v4, shadcn Base UI "Luma"
preset). This spec extends the existing files. The agent half does not exist and is created
here.

### Scope boundary

The run pipeline is exercised end to end for exactly one command — `generate_report` — and
that command **stops at the snapshot**. The spec is complete when a run reaches `completed`
with a snapshot object in S3.

| In scope | Out of scope (downstream specs) |
|---|---|
| Authentication, sessions, registration, login | — |
| Azure subscription onboarding + `scope_verified` preflight | — |
| Agent runtime skeleton, redaction guard, heartbeat | Model-facing tools, chat Q&A over a report |
| Provider protocol, inventory, SKU capacity, metric definitions, batch metrics | Non-Azure providers (AWS, VMware) — protocol only, no implementation |
| Aggregation, sketches, local-day bucketing, gaps, raw archive | — |
| Immutable snapshot + `content_hash` | — |
| `report_runs` state machine, progress callback, reaper, SSE relay | Scheduled runs, email delivery |
| — | The report document, the template builder, the template AST and compiler |
| — | `.docx` / `.pdf` rendering, theme documents, figure ledger, `formatted` production |
| — | Document verification (soundness/completeness), replay execution, drift sampling |
| — | Run comparison, delta tables |

`report_runs.status` carries `compiling`, `rendering` and `verifying` in its enum because the
state machine is a single design that must not be migrated twice. This spec drives only
`queued → claimed → collecting → completed | failed`.

## Glossary

Vocabulary is used identically to `product.md`. Terms marked **(system)** are the actors that
EARS requirements below name in the `THE <system> SHALL` position.

### Domain vocabulary

- **snapshot** — the immutable, content-addressed result of one collection run. Canonicalized
  with RFC 8785 (JCS) and hashed; `snapshot_id` *is* that hash. Never mutated, never partially
  rewritten. Re-running collection produces a new snapshot.
- **content_hash** — the SHA-256 digest of the snapshot's JCS canonical form computed with the
  hash field itself excluded. `snapshot_id` equals `content_hash`.
- **figure** — one numeric with its full provenance: `value` (a fixed-precision decimal string,
  never a JSON number), `unit`, `estimator`, `derived_from`, `formula`, `resource_id`, `metric`,
  `window`, `fidelity_tier`. This spec produces the snapshot rows a figure is later derived
  from; the figure ledger itself is downstream.
- **collection_log** — the typed, per-resource record of gaps and errors from one collection
  run. Every entry carries a `gap_type`, the affected `resource_id`, the `metric` where
  applicable, and a message. A gap is recorded, never zero-filled. The `gap_type` values this
  spec defines are:
  - `deallocated` · `power_state_unknown` · `duplicate_inventory_row` · `metric_not_emitted` ·
    `permission_denied` · `metric_error` · `resource_absent_from_response` ·
    `interval_counts_missing` · `interval_malformed` · `no_samples` · `sku_unknown` ·
    `sku_capability_missing` · `definitions_unavailable` · `percentile_unsupported_unit` ·
    `response_too_large` · `region_unreachable` · `archive_write_failed` ·
    `catalog_entry_invalid` · `instance_name_collapsed` · `metric_not_selected`
- **gap** — one typed `collection_log` entry. Neutral information, not a failure.
- **error code** — the value carried in `report_runs.error_code` and in an `error` event's
  `code`. The codes this spec defines are:
  - Terminal: `AUTH_EXPIRED` · `AUTH_FAILED` · `SCOPE_UNVERIFIED` · `SECRET_UNREADABLE` ·
    `EMPTY_SCOPE` · `CATALOG_UNUSABLE` · `NO_STATISTICS` · `TIMEOUT`
  - Non-terminal: `THROTTLED` (retryable) · `PARTIAL_COVERAGE` · `REGION_UNREACHABLE`
  - `TIMEOUT` is written only by the Reaper, because a timed-out run's container may already
    be gone.
- **fidelity_tier** — `baseline` (Azure platform metrics only; exact avg/min/max, percentiles
  estimated) or `enhanced` (customer opted into Azure Monitor Agent plus a Data Collection
  Rule; true percentiles, per-volume disk free space, guest-observed memory). Recorded per
  resource and propagated to every value derived from that resource.
- **scope_verified** — a boolean on a connected subscription, set only by a preflight that
  asserts read permission at **subscription** scope against
  `GET /subscriptions/{id}/providers/Microsoft.Authorization/permissions`. Never inferred from
  a successful inventory query.
- **estimator** — the identifier of how a statistic was produced (for example
  `histogram_sketch_pt1h`, `ddsketch_pt1h`), carried inside the value object alongside a
  pre-formatted label.
- **run** — one row in `report_runs`, the authoritative state of one collection attempt.
- **phase deadline** — the instant recorded in `report_runs.phase_deadline` after which the
  Reaper fails a non-terminal run as `TIMEOUT`. Budgets are 900 seconds for `queued`, 300 for
  `claimed` and 1800 for `collecting`.
- **points budget** — the target maximum number of metric data points a single batch metrics
  request may return, used to size batches instead of a resource count.
- **grain** — the metric time interval requested from Azure Monitor (`PT1H` base, `PT15M`
  fallback).
- **local day** — a calendar day in the customer's IANA timezone (default `Asia/Jakarta`,
  UTC+07:00), computed by the collector from hourly data.

### Systems

- **Web_App (system)** — the Next.js 16 application in `app/`.
- **Auth_Service (system)** — `app/lib/auth/*`: password hashing, session lifecycle, guard.
- **Lockout_Service (system)** — `app/lib/auth/lockout.ts`: failed-attempt counting.
- **Crypto_Module (system)** — `app/lib/crypto.ts`: AES-256-GCM encrypt/decrypt at rest.
- **Env_Module (system)** — `app/lib/env.ts`: call-time required-variable resolution.
- **Session_Id_Module (system)** — `app/lib/session-id.ts`: AgentCore runtime session ids.
- **Boundary_Guard (system)** — `app/test/boundaries.static.test.ts`: static source guards.
- **Projection_Guard (system)** — the guard test over each browser-safe projection.
- **Subscription_Store (system)** — the `connected_subscriptions` table and its data layer.
- **Onboarding_Wizard (system)** — the connect-a-subscription UI flow.
- **Preflight_Service (system)** — `POST /api/subscriptions/test` and its agent-side command.
- **Agent_Runtime (system)** — the `BedrockAgentCoreApp` entrypoint in `agent/`.
- **Redaction_Guard (system)** — the agent's process-wide secret scrubber.
- **Heartbeat_Emitter (system)** — `agent/src/reporting_agent/heartbeat.py`.
- **Provider_Protocol (system)** — `agent/src/reporting_agent/providers/base.py`.
- **Credential_Factory (system)** — `agent/.../azure/credential.py`.
- **Inventory_Collector (system)** — `agent/.../azure/inventory.py`.
- **SKU_Catalog (system)** — `agent/.../azure/skus.py`.
- **Definition_Probe (system)** — `agent/.../azure/definitions.py`.
- **Metrics_Collector (system)** — `agent/.../azure/metrics.py`.
- **Region_Resolver (system)** — `agent/.../azure/regions.py`.
- **Metric_Catalog (system)** — the declarative resource-type → metric definition catalog.
- **Bucketer (system)** — `agent/.../collect/buckets.py`: local-day bucketing.
- **Accumulator (system)** — `agent/.../collect/accumulate.py`: count-weighted avg, exact
  min/max, sketch folding.
- **Sketch (system)** — `agent/.../collect/sketch.py`: fixed histogram and DDSketch.
- **Archive_Writer (system)** — `agent/.../collect/archive.py`: raw responses to S3.
- **Snapshot_Builder (system)** — `agent/.../collect/snapshot.py`.
- **Run_State_Machine (system)** — the `report_runs` table plus `app/lib/runs/state.ts`.
- **Enqueue_Action (system)** — `app/lib/actions/runs.ts`.
- **Progress_Endpoint (system)** — `app/app/api/internal/runs/[runId]/progress/route.ts`.
- **Progress_Reporter (system)** — `agent/src/reporting_agent/progress.py`.
- **Reaper (system)** — `app/app/api/cron/tick/route.ts`.
- **SSE_Relay (system)** — `app/app/api/runs/[runId]/stream/route.ts`.

---

## Requirements

### Section A — Web app foundation

Ported from `../cold-agent/app`, keeping the proven logic and adapting names and environment
variables to this project's conventions. The reference implementation is a source of logic,
not of visual guidance, and three of its artifacts are explicitly **not** ported: the
`next-auth` dependency, the `@auth/drizzle-adapter` dependency, and the `AUTH_SECRET`
convention.

#### Requirement 1: Password storage and verification

**User Story:** As a consultant, I want my password stored so that a database disclosure does
not reveal it, so that my account survives a breach of the reporting service.

##### Acceptance Criteria

1. WHEN a user registers with a password, THE Auth_Service SHALL store an argon2id hash of
   that password, computed over the password exactly as submitted including any leading or
   trailing whitespace, in `users.password_hash`, and SHALL store no other representation of
   that password.
2. THE Auth_Service SHALL use the argon2id variant for every hash operation.
3. THE Auth_Service SHALL accept a password whose length, measured in Unicode code points, is
   at least 12 and at most 256.
4. IF a submitted password's length in Unicode code points is below 12 or above 256, THEN THE
   Auth_Service SHALL reject the registration and SHALL state the accepted length range.
5. WHEN the Auth_Service verifies a submitted password against a stored hash, THE
   Auth_Service SHALL return a boolean result.
6. IF a stored hash is malformed, THEN THE Auth_Service SHALL return a verification result of
   `false` and SHALL complete without raising an exception to the caller.
7. IF a submitted email matches no user, THEN THE Auth_Service SHALL return the generic
   invalid-credentials outcome.
8. IF a submitted password does not verify against the stored hash, THEN THE Auth_Service SHALL
   return the generic invalid-credentials outcome, identical to the outcome returned for an
   unmatched email.
9. WHEN a user changes a password, THE Auth_Service SHALL delete every `sessions` row bound to
   that user's id, including the row backing the request that changed the password.
10. THE Auth_Service SHALL configure argon2id with a memory cost of at least 19456 KiB, a time
    cost of at least 2 iterations, and a parallelism of at least 1.
11. IF a submitted email matches no user, THEN THE Auth_Service SHALL perform one argon2id
    verification against a fixed decoy hash before returning the generic invalid-credentials
    outcome, so that the unmatched-email path and the failed-verification path are
    indistinguishable by elapsed time.
12. THE Auth_Service SHALL exclude every submitted password value and every stored
    `users.password_hash` value from every log line, every error message, and every value
    returned to a caller.
13. WHEN a user changes a password, THE Auth_Service SHALL write the new hash and delete that
    user's `sessions` rows within one database transaction, so that a failed change retains
    both the previous `users.password_hash` value and every previous `sessions` row for that
    user.

#### Requirement 2: Database-backed session lifecycle

**User Story:** As a consultant, I want sign-out and expiry to actually end my session
server-side, so that a stolen cookie stops working.

##### Acceptance Criteria

1. WHEN the Auth_Service creates a session, THE Auth_Service SHALL generate the session token
   from `crypto.randomBytes(32)`.
2. WHEN the Auth_Service creates a session, THE Auth_Service SHALL store the SHA-256 hash of
   the session token in `sessions.session_token_hash` and SHALL store no column containing the
   token itself.
3. WHEN the Auth_Service creates a session, THE Auth_Service SHALL set the session cookie with
   `httpOnly` true, `sameSite` `lax` and `path` `/`.
4. WHERE `process.env.NODE_ENV` equals `production`, THE Auth_Service SHALL set the session
   cookie with `secure` true.
5. WHEN the Auth_Service resolves a session token to a stored row, THE Auth_Service SHALL
   compare the hashed token using a constant-time comparison.
6. WHEN the Auth_Service creates a session, THE Auth_Service SHALL set
   `sessions.absolute_expires_at` to the creation instant plus 30 days.
7. WHEN the Auth_Service reads a valid session, THE Auth_Service SHALL set
   `sessions.idle_expires_at` to the read instant plus 7 days by updating that `sessions` row,
   SHALL leave `sessions.absolute_expires_at` unchanged, and SHALL write no cookie.
8. IF the current instant is at or after `sessions.absolute_expires_at`, THEN THE Auth_Service
   SHALL resolve the request as unauthenticated.
9. IF the current instant is at or after `sessions.idle_expires_at`, THEN THE Auth_Service
   SHALL resolve the request as unauthenticated.
10. WHEN the Auth_Service resolves a request as unauthenticated because of an expiry, THE
    Auth_Service SHALL delete the corresponding `sessions` row.
11. IF the deletion of an expired `sessions` row fails, THEN THE Auth_Service SHALL resolve the
    request as unauthenticated and SHALL surface no error to the caller.
12. WHEN a user signs out, THE Auth_Service SHALL delete the matching `sessions` row and SHALL
    clear the session cookie.
13. WHEN a user signs out with no session cookie present, THE Auth_Service SHALL complete
    without raising an exception.
14. WHEN the Auth_Service resolves a session during a server-component render, THE
    Auth_Service SHALL read the cookie without writing a cookie.
15. WHEN the Auth_Service creates a session, THE Auth_Service SHALL name the session cookie
    `rpt_session` and SHALL set that cookie's `maxAge` to 2592000 seconds, matching the 30-day
    absolute expiry.
16. WHEN the Auth_Service places a session token in the session cookie, THE Auth_Service SHALL
    encode the 32 random bytes as base64url, producing a 43-character token drawn only from
    the base64url alphabet.
17. WHEN the Auth_Service creates a session, THE Auth_Service SHALL set
    `sessions.idle_expires_at` to the creation instant plus 7 days.
18. IF a request presents no session cookie, or presents a token that matches no `sessions`
    row, THEN THE Auth_Service SHALL resolve the request as unauthenticated and SHALL perform
    no database write.

#### Requirement 3: Login lockout

**User Story:** As a consultant, I want repeated failed sign-ins to be throttled, so that an
attacker cannot brute-force my password.

##### Acceptance Criteria

1. WHEN a login attempt completes, THE Lockout_Service SHALL insert a row into
   `login_attempts` recording the normalized email, a success flag, and a timestamp.
2. WHILE at least 5 failed attempts for a normalized email fall within the inclusive trailing
   window bounded by the current instant minus 15 minutes and the current instant, THE
   Lockout_Service SHALL report that normalized email as locked out.
3. WHEN a normalized email is locked out, THE Auth_Service SHALL reject the sign-in attempt
   without invoking password verification.
4. THE Lockout_Service SHALL determine lockout state solely from the trailing 15-minute window
   of failed attempts, excluding every successful attempt from that count, so that a locked
   email becomes usable again 15 minutes after the most recent qualifying failure without any
   stored lock record.
5. THE Lockout_Service SHALL expose the window predicate as a function of a list of failure
   timestamps and a current instant, containing no input or output operation.
6. WHEN the Auth_Service rejects a sign-in attempt because the normalized email is locked out,
   THE Auth_Service SHALL return the generic invalid-credentials outcome, identical to the
   outcome returned for an unmatched email, so that the lockout state discloses no registration
   status.
7. WHILE a normalized email is locked out, THE Lockout_Service SHALL record each rejected
   sign-in attempt in `login_attempts` with a success flag of false, so that the trailing
   window is measured from the most recent attempt.
8. IF the Lockout_Service cannot read `login_attempts`, THEN THE Auth_Service SHALL reject the
   sign-in attempt without invoking password verification and SHALL return the generic
   invalid-credentials outcome.

#### Requirement 4: Secrets encrypted at rest

**User Story:** As a consultant, I want the customer's Azure client secret encrypted in the
database, so that a database disclosure is not a customer credential disclosure.

##### Acceptance Criteria

1. THE Crypto_Module SHALL encrypt with AES-256-GCM using a 12-byte initialization vector and
   a 16-byte authentication tag.
2. WHEN the Crypto_Module encrypts a plaintext, THE Crypto_Module SHALL return a single base64
   string encoding the initialization vector, then the authentication tag, then the
   ciphertext.
3. WHEN the Crypto_Module encrypts the same plaintext twice, THE Crypto_Module SHALL generate a
   fresh random initialization vector for each call and SHALL therefore produce two different
   outputs.
4. FOR ALL UTF-8 strings, including the empty string and strings of at least 4096 characters,
   THE Crypto_Module SHALL yield the original string when decrypting the result of encrypting
   that string (round-trip property).
5. IF the Crypto_Module is given a ciphertext whose authentication tag does not verify, THEN
   THE Crypto_Module SHALL raise an error and SHALL return no plaintext.
6. IF the Crypto_Module is given a ciphertext shorter than 28 bytes after base64 decoding,
   THEN THE Crypto_Module SHALL raise an error naming the input as too short.
7. THE Crypto_Module SHALL resolve the key from `APP_ENCRYPTION_KEY` at call time, accepting
   either a base64 encoding of 32 bytes or exactly 32 raw bytes.
8. IF `APP_ENCRYPTION_KEY` does not resolve to exactly 32 bytes, THEN THE Crypto_Module SHALL
   raise an error naming the variable and SHALL exclude the variable's value from that error.
9. THE Crypto_Module SHALL draw every initialization vector from `crypto.randomBytes`.
10. WHEN the Crypto_Module raises an error, THE Crypto_Module SHALL exclude the plaintext, the
    ciphertext and the key material from that error's message.
11. IF an authentication tag fails to verify, THEN THE Crypto_Module SHALL raise an error whose
    type is distinguishable from the error raised for an unresolvable `APP_ENCRYPTION_KEY`, so
    that a rotated key is distinguishable from a tampered value.

#### Requirement 5: Environment variable resolution

**User Story:** As an operator, I want a missing configuration variable to fail with the
variable's name, so that I can fix a deployment without reading a stack trace.

##### Acceptance Criteria

1. THE Env_Module SHALL read each variable from `process.env` at call time rather than at
   module load time.
2. IF a required variable is absent, is the empty string, or contains only whitespace
   characters, THEN THE Env_Module SHALL raise a typed error carrying the variable name.
3. WHEN the Env_Module raises a missing-variable error, THE Env_Module SHALL include the
   variable name in the message and SHALL exclude the variable's value.
4. THE Env_Module SHALL declare `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `AWS_REGION`,
   `RPT_RUNTIME_ARN`, `RPT_ARTIFACT_BUCKET`, `RPT_HISTORY_TABLE`, `RPT_TITLE_MODEL_ID`,
   `RPT_CRON_SECRET` and `RPT_APP_BASE_URL` as the required set.
5. THE Env_Module SHALL exclude `AUTH_SECRET` from the required set.
6. THE Web_App SHALL declare every variable in the required set in `app/.env.example` with a
   non-empty placeholder value that contains either an angle-bracketed token or the word
   `generate`, and SHALL exclude every real credential value from that file.
7. THE Web_App SHALL exclude `.env` from version control and SHALL keep `.env.example`
   tracked.
8. IF more than one required variable is absent or empty, THEN THE Env_Module SHALL raise the
   error naming the first such variable in the declared order of the required set.
9. THE Env_Module SHALL retain no resolved value between calls, so that a variable changed
   after an earlier call resolves to the changed value on the next call.
10. THE Env_Module SHALL export the required set as a readable value, so that the
    Boundary_Guard compares `app/.env.example` against that exported value rather than against
    a duplicated list.

#### Requirement 6: Server boundary and dependency guards

**User Story:** As a reviewer, I want a leak of a secret into the client bundle to be a build
or test failure, so that the boundary is not maintained by memory.

##### Acceptance Criteria

1. THE Web_App SHALL begin every module under `app/lib/aws/`, plus `app/lib/crypto.ts`,
   `app/lib/env.ts`, every module under `app/lib/db/` that opens a connection, and every
   module under `app/lib/auth/`, with `import "server-only"`.
2. IF a source module imports an `@aws-sdk/*` package or `@/lib/crypto` and omits
   `import "server-only"`, THEN THE Boundary_Guard SHALL fail.
3. IF a source file under `app/lib`, `app/app`, `app/components` or `app/hooks`, other than the
   Boundary_Guard's own module, contains the literal `arn:aws:bedrock-agentcore:`, THEN THE
   Boundary_Guard SHALL fail.
4. IF `app/package.json` lists `next-auth` or `@auth/drizzle-adapter` in `dependencies` or
   `devDependencies`, THEN THE Boundary_Guard SHALL fail.
5. IF a source file imports from `next-auth` or from a `next-auth/*` subpath, THEN THE
   Boundary_Guard SHALL fail.
6. IF the set of keys declared in `app/.env.example` differs from the Env_Module's required
   set, THEN THE Boundary_Guard SHALL fail.
7. IF a route handler that returns a `text/event-stream` response omits
   `export const runtime = "nodejs"`, THEN THE Boundary_Guard SHALL fail.
8. THE Web_App SHALL keep `shadcn` in `dependencies`, because `app/app/globals.css` imports
   `shadcn/tailwind.css`.
9. THE Web_App SHALL preserve the existing token values in `app/app/globals.css` and the
   existing contents of `app/components.json`, restricting changes to `app/app/globals.css` to
   appended blocks.
10. THE Boundary_Guard SHALL treat as a source file every `.ts` and `.tsx` file outside
    `node_modules` and `.next` whose file name excludes the infixes `.test.` and `.spec.`.
11. IF a directory the Boundary_Guard scans is absent or yields zero source files, THEN THE
    Boundary_Guard SHALL fail, so that a guard cannot pass by scanning nothing.
12. IF a file under `app/`, other than the Boundary_Guard's own module, contains the literal
    `next-auth`, THEN THE Boundary_Guard SHALL fail, so that a stale test double for a module
    no production module imports fails the suite.
13. IF a route file exists under a path segment named `[...nextauth]`, THEN THE Boundary_Guard
    SHALL fail, because session handling is database-backed and no such route exists.

#### Requirement 7: Registration and login pages

**User Story:** As a consultant, I want to create an account and sign in, so that I can connect
a subscription.

##### Acceptance Criteria

1. WHEN a visitor submits the registration form with an email that is not yet registered and a
   password meeting the declared policy, THE Web_App SHALL create the user, create a session,
   and redirect the visitor to the authenticated dashboard.
2. IF a visitor submits the registration form with an email whose normalized form already
   exists, THEN THE Web_App SHALL reject the submission and SHALL display a message stating
   that the email is unavailable.
3. WHEN the Web_App normalizes an email, THE Web_App SHALL trim surrounding whitespace and
   convert the email to lower case, and SHALL store the normalized form in
   `users.email_normalized` under a UNIQUE constraint.
4. WHEN a visitor submits valid credentials on the login form, THE Web_App SHALL create a
   session and redirect the visitor to the authenticated dashboard.
5. IF a visitor submits credentials that do not authenticate, THEN THE Web_App SHALL display a
   single message that identifies neither the email nor the password as the failing field.
6. WHEN an unauthenticated request reaches a route under the authenticated shell, THE
   Auth_Service SHALL redirect that request to the login page.
7. THE Web_App SHALL parse the input of every route handler and every server action with a zod
   schema at the boundary, treating path parameters and search parameters as input.
8. THE Web_App SHALL render the login and registration pages using the existing Luma preset
   tokens, `@phosphor-icons/react` for icons, and the existing `components/ui/button.tsx`.
9. IF a post-login return target is absent, or resolves to a target other than a path beginning
   with a single `/` on the Web_App's own origin, THEN THE Web_App SHALL redirect the visitor to
   the authenticated dashboard.
10. WHEN a visitor submits credentials that authenticate while a session cookie is already
    present, THE Auth_Service SHALL create a new session and SHALL delete the `sessions` row
    matching the presented cookie.
11. IF a submitted email's normalized form exceeds 254 characters or fails the boundary zod
    schema's email-format check, THEN THE Web_App SHALL reject the submission and SHALL state
    the accepted email format and length.
12. IF the insert of a new user violates the `users.email_normalized` UNIQUE constraint, THEN
    THE Web_App SHALL reject the submission with the email-unavailable message, SHALL create no
    session, and SHALL create no user row.

#### Requirement 8: AgentCore runtime session ids

**User Story:** As a consultant, I want a conversation's agent memory to stay continuous, so
that follow-up questions land in the same context.

##### Acceptance Criteria

1. FOR ALL thread ids, THE Session_Id_Module SHALL produce a session id whose length is
   between 33 and 128 characters inclusive.
2. FOR ALL thread ids, THE Session_Id_Module SHALL produce the same session id on every call
   for the same thread id (deterministic derivation).
3. WHEN the Session_Id_Module derives a session id from a thread id, THE Session_Id_Module
   SHALL emit only characters from the lowercase hexadecimal alphabet.
4. WHEN the Session_Id_Module generates a new random session id, THE Session_Id_Module SHALL
   emit only characters from the base64url alphabet and SHALL draw at least 48 random bytes.
5. WHEN the Web_App invokes the runtime for a run, THE Session_Id_Module SHALL derive that run's
   session id from that run's id, so that a retried invocation of the same run presents the same
   session id.
6. WHEN the Session_Id_Module derives a session id, THE Session_Id_Module SHALL include a
   namespace prefix identifying the derivation kind in the hashed input, so that a thread id and
   a run id carrying the same string value derive different session ids.
7. FOR ALL pairs of distinct thread ids, THE Session_Id_Module SHALL produce distinct session
   ids.

---

### Section B — Azure subscription onboarding

#### Requirement 9: Connected subscription storage

**User Story:** As a consultant, I want to connect a customer's Azure subscription, so that I
can collect utilization from it.

##### Acceptance Criteria

1. THE Subscription_Store SHALL define a `connected_subscriptions` table carrying `id`,
   `user_id`, `display_name`, `subscription_id`, `tenant_id`, `client_id`,
   `client_secret_enc`, `scope_verified`, `fidelity_tier`, `secret_expires_at`, `status`,
   `log_analytics_workspace_id` and `created_at`, with `user_id` referencing `users.id`, with
   `log_analytics_workspace_id` as the only nullable column, with `scope_verified` defaulting
   to false, and with a UNIQUE constraint over the pair (`user_id`, `subscription_id`).
2. WHEN the Subscription_Store persists an Azure client secret, THE Subscription_Store SHALL
   store only the Crypto_Module's ciphertext in `client_secret_enc`.
3. THE Subscription_Store SHALL resolve `tenant_id`, `client_id` and the decrypted client
   secret server-side only, at invoke time.
4. THE Web_App SHALL generate SQL migrations with drizzle-kit from a single `schema.ts`.
5. IF a generated migration contains a `DROP` of a table or of a column that a previously
   committed migration created, THEN THE Boundary_Guard SHALL fail.
6. THE Subscription_Store SHALL constrain `status` to the values `pending`, `active` and
   `disabled`, SHALL constrain `fidelity_tier` to the values `baseline` and `enhanced`, SHALL
   treat `active` as the only accepted state, and SHALL derive the expired state from
   `secret_expires_at` rather than storing an expired value in `status`.
7. WHEN the Web_App reads or writes a `connected_subscriptions` row, THE Subscription_Store
   SHALL restrict that operation to rows whose `user_id` equals the signed-in user's id.
8. IF a requested `connected_subscriptions` row's `user_id` differs from the signed-in user's
   id, THEN THE Subscription_Store SHALL resolve that request as not found, SHALL apply no
   write, and SHALL disclose no field of that row.
9. THE Subscription_Store SHALL exclude the submitted plaintext client secret from every log
   line, from every column other than `client_secret_enc`, and from every value returned to a
   caller.
10. IF an insert would violate the (`user_id`, `subscription_id`) UNIQUE constraint, THEN THE
    Web_App SHALL reject the submission, SHALL state that the subscription is already
    connected, and SHALL insert no second row.

#### Requirement 10: Browser-safe subscription projection

**User Story:** As a security reviewer, I want one audited shape to be the only subscription
data reaching the browser, so that a secret cannot leak through a convenience field.

##### Acceptance Criteria

1. THE Subscription_Store SHALL define `ConnectedSubscriptionView` carrying `id`,
   `displayName`, `maskedSubscriptionId`, `scopeVerified`, `fidelityTier`, `secretExpiresAt`
   and `status`.
2. THE Web_App SHALL send a connected subscription to the browser only as a
   `ConnectedSubscriptionView`.
3. WHEN the Subscription_Store projects a `connected_subscriptions` row to a
   `ConnectedSubscriptionView`, THE Subscription_Store SHALL omit `tenant_id`, `client_id`,
   `client_secret_enc`, `log_analytics_workspace_id` and the unmasked `subscription_id`, under
   both the column name and the camel-case row name.
4. WHEN the Subscription_Store projects a `connected_subscriptions` row, THE
   Subscription_Store SHALL mask every character of `subscription_id` other than its final 4
   characters, and SHALL mask every character of a `subscription_id` whose length is 4
   characters or fewer.
5. IF the JSON serialization of a projected view contains the test fixture's `tenant_id`,
   `client_id` or `client_secret_enc` value, THEN THE Projection_Guard SHALL fail.
6. WHEN the Projection_Guard runs, THE Projection_Guard SHALL assert the exact sorted key set
   of the projected view, so that a newly added `connected_subscriptions` column cannot reach
   the browser without an explicit test change.
7. WHEN the Projection_Guard builds its `connected_subscriptions` row fixture, THE
   Projection_Guard SHALL assign a distinct non-empty value to `subscription_id`, `tenant_id`,
   `client_id` and `client_secret_enc`, so that no assertion passes over an absent value.
8. THE Web_App SHALL exclude the unmasked `subscription_id`, the `tenant_id`, the `client_id`,
   the `client_secret_enc` ciphertext and every decrypted client secret from every payload
   reaching the browser, including route-handler response bodies, server-component props and
   server-action return values.
9. IF the JSON serialization of a projected view contains any character of the test fixture's
   `subscription_id` other than that id's final 4 characters, THEN THE Projection_Guard SHALL
   fail.

#### Requirement 11: The onboarding wizard explains the Reader role

**User Story:** As a consultant, I want the wizard to give me a script my customer will run and
an explanation my customer will accept, so that the engagement is not blocked by a role
argument.

##### Acceptance Criteria

1. WHEN a consultant supplies a subscription id in the onboarding wizard, THE
   Onboarding_Wizard SHALL generate an `az` CLI script that creates an app registration and
   assigns the **Reader** role at **subscription** scope for that supplied subscription id.
2. WHEN a consultant supplies a subscription id in the onboarding wizard, THE
   Onboarding_Wizard SHALL generate an ARM template that assigns the **Reader** role at
   **subscription** scope for that supplied subscription id.
3. THE Onboarding_Wizard SHALL state that `Monitoring Reader` alone does not grant Azure
   Resource Graph inventory, and SHALL state that inventory is required to identify the
   resources metrics are collected for.
4. THE Onboarding_Wizard SHALL state that the Reader role exposes resource configuration in
   addition to metrics.
5. THE Onboarding_Wizard SHALL state that the connection is read-only and that no role
   permitting a write is requested.
6. WHEN the Onboarding_Wizard displays the generated script, THE Onboarding_Wizard SHALL
   include the subscription id the script targets and SHALL exclude any client secret value.
7. THE Onboarding_Wizard SHALL prompt for `secret_expires_at` and SHALL state that Azure
   service-principal secrets carry a maximum lifetime of 24 months and are commonly issued
   for 6 to 12 months.
8. FOR ALL generated `az` CLI scripts and ALL generated ARM templates, THE Onboarding_Wizard
   SHALL emit exactly one role assignment, whose role is **Reader** and whose scope is the
   supplied subscription's scope path, and SHALL emit no role assignment carrying a write
   action.
9. IF a supplied `secret_expires_at` is absent, is at or before the current instant, or is
   more than 24 months after the current instant, THEN THE Onboarding_Wizard SHALL reject the
   submission and SHALL state the accepted range as after the current instant and at most 24
   months after the current instant.
10. THE Onboarding_Wizard SHALL reach an accepted connection only through a Preflight_Service
    result recording `scope_verified` true, and SHALL offer no control that saves a connection
    without that result.

#### Requirement 12: The preflight authorization gate

**User Story:** As a consultant, I want the app to prove subscription-scope read before it
accepts a connection, so that I never deliver a report that is silently missing 90% of the
estate.

##### Acceptance Criteria

1. WHEN a consultant submits a connection for testing, THE Preflight_Service SHALL call
   `GET /subscriptions/{subscriptionId}/providers/Microsoft.Authorization/permissions` using
   the submitted service principal's own token.
2. IF the permissions response returned for the subscription path contains at least one entry
   whose `actions` include a pattern matching the resource read action and whose `notActions`
   exclude every pattern matching that same read action, THEN THE Preflight_Service SHALL set
   `scope_verified` to true.
3. IF the permissions response returned for the subscription path contains no entry whose
   `actions` match the read action with that action left undenied by `notActions`, including
   the case of an empty entry list, THEN THE Preflight_Service SHALL set `scope_verified` to
   false, because a service principal assigned Reader only at a resource-group scope returns no
   subscription-scope read permission while its inventory query still succeeds.
4. THE Preflight_Service SHALL derive `scope_verified` solely from the permissions response,
   and SHALL exclude the result of any inventory query from that derivation.
5. IF `scope_verified` resolves to false, THEN THE Preflight_Service SHALL reject the
   connection, SHALL persist no `connected_subscriptions` row whose `status` is `active`, SHALL
   retain no plaintext of the submitted client secret once the response is returned, and SHALL
   report the terminal code `SCOPE_UNVERIFIED`.
6. IF a run is requested against a subscription whose `scope_verified` is false, THEN THE
   Run_State_Machine SHALL fail that run with `error_code` `SCOPE_UNVERIFIED` and SHALL make
   no AgentCore invocation.
7. WHEN the Preflight_Service reports `SCOPE_UNVERIFIED`, THE Web_App SHALL display the
   subscription-scope Reader requirement and the reason a resource-group-scoped assignment is
   rejected.
8. WHERE a Log Analytics workspace id is supplied, IF a query for the logical-disk free-space
   performance counter against that workspace returns at least one row within the trailing 24
   hours, THEN THE Preflight_Service SHALL record `fidelity_tier` as `enhanced`.
9. IF no Log Analytics workspace id is supplied, THEN THE Preflight_Service SHALL record
   `fidelity_tier` as `baseline`.
10. WHERE a Log Analytics workspace id is supplied, IF the query for the logical-disk
    free-space performance counter fails, is rejected, or returns zero rows within the trailing
    24 hours, THEN THE Preflight_Service SHALL record `fidelity_tier` as `baseline`.
11. THE Preflight_Service SHALL issue the permissions request from its agent-side `preflight`
    command, so that the Web_App makes no Azure API call and holds no Azure access token.
12. IF the permissions request fails to complete, returns a status other than success, or does
    not complete within 30 seconds, THEN THE Preflight_Service SHALL leave `scope_verified`
    false, SHALL reject the connection, and SHALL report the terminal code
    `SCOPE_UNVERIFIED`.
13. IF Azure rejects the submitted client secret as expired during the preflight, THEN THE
    Preflight_Service SHALL report the terminal code `AUTH_EXPIRED`, distinct from
    `SCOPE_UNVERIFIED`, and SHALL reject the connection.
14. THE Preflight_Service SHALL be the only writer of a `scope_verified` value of true, so that
    no later code path sets that flag from an inventory result.

#### Requirement 13: Client secret expiry

**User Story:** As a consultant, I want to be warned before a client secret expires, so that a
report run does not silently return nothing.

##### Acceptance Criteria

1. THE Subscription_Store SHALL record `secret_expires_at` on every connected subscription.
2. WHILE the current instant is at or after a subscription's `secret_expires_at` minus 30 days
   and before that `secret_expires_at`, THE Web_App SHALL display an expiry warning naming the
   number of whole days remaining, on every render of the subscriptions screen and of the run
   screens for that subscription, and SHALL offer no control that dismisses that warning.
3. WHILE the current instant is at or after a subscription's `secret_expires_at`, or that
   subscription's `status` is `disabled`, THE Web_App SHALL display an expired state for that
   subscription and SHALL offer a secret-rotation action.
4. IF, at enqueue or at claim, the current instant is at or after a subscription's
   `secret_expires_at`, THEN THE Run_State_Machine SHALL fail that run with `error_code`
   `AUTH_EXPIRED` and SHALL make no AgentCore invocation.
5. IF Azure rejects the credential as expired during a run, THEN THE Agent_Runtime SHALL
   report the terminal code `AUTH_EXPIRED`, distinct from every other authorization code.
6. WHEN the Web_App styles an expiry state, THE Web_App SHALL use the `--destructive` token
   only for the expired state of criterion 13.3, and SHALL use mist neutral tokens for the
   approaching-expiry state of criterion 13.2.
7. WHEN a consultant submits a rotated client secret for a connected subscription, THE
   Subscription_Store SHALL replace `client_secret_enc` with the Crypto_Module's ciphertext of
   the submitted secret, SHALL record the submitted `secret_expires_at`, and SHALL retain no
   earlier ciphertext for that subscription.
8. WHEN a consultant submits a rotated client secret for a connected subscription, THE
   Preflight_Service SHALL re-run the permissions assertion with the rotated secret and SHALL
   set `scope_verified` from that result.
9. IF the Agent_Runtime reports `AUTH_EXPIRED` for a subscription whose recorded
   `secret_expires_at` is after the current instant, THEN THE Subscription_Store SHALL set that
   subscription's `status` to `disabled`, because the recorded expiry date is
   consultant-entered and can present a rejected credential as usable.

---

### Section C — Agent runtime skeleton

#### Requirement 14: The AgentCore entrypoint

**User Story:** As a developer, I want the runtime to route a deterministic command without
consulting the model, so that report generation is reproducible run to run.

##### Acceptance Criteria

1. THE Agent_Runtime SHALL expose a `BedrockAgentCoreApp` entrypoint that yields SSE event
   dictionaries from an async generator.
2. WHEN the Agent_Runtime receives a payload carrying a `command` field, THE Agent_Runtime
   SHALL execute the corresponding deterministic pipeline, SHALL ignore any `prompt` field
   present in that same payload, and SHALL make no model invocation for that payload.
3. THE Agent_Runtime SHALL accept the commands `generate_report` and `preflight`.
4. IF a payload carries a `command` value the Agent_Runtime does not recognize, THEN THE
   Agent_Runtime SHALL emit an `error` event carrying `terminal` true and carrying a `code`
   distinct from every collection-phase error code, SHALL make no model invocation, and SHALL
   emit `done` as the next and final event of that invocation.
5. WHEN the Agent_Runtime parses an invocation, THE Agent_Runtime SHALL resolve `actor_id` from
   the payload `context`, treating an absent value, a value that is not a string, the empty
   string, and a value containing only whitespace characters each as absent, and IF `actor_id`
   resolves as absent, THEN THE Agent_Runtime SHALL emit an `error` event carrying `terminal`
   true, SHALL make no model invocation, SHALL start no collection, and SHALL emit `done` as
   the next and final event of that invocation.
6. WHEN the Agent_Runtime resolves the runtime session id, THE Agent_Runtime SHALL take that
   id from `context.session_id` when present, otherwise from the request context's
   `session_id`, and IF neither source supplies a value whose length is between 33 and 128
   characters inclusive, THEN THE Agent_Runtime SHALL derive a session id of at least 33
   characters from the resolved `actor_id` and SHALL continue the invocation.
7. THE Agent_Runtime SHALL emit `tool` events with `phase` `start` carrying `id`, `name`,
   `label` and `status`, and with `phase` `end` carrying the same `id` and the same `name`,
   using the names `collect_inventory` and `collect_metrics` for the phases this spec drives.
8. THE Agent_Runtime SHALL emit `progress` events carrying `id`, `done`, `total`, `unit` and
   `label`, SHALL set `id` to the `id` of a `tool` step for which a `phase` `start` event was
   emitted and no `phase` `end` event has been emitted, SHALL keep `done` at or below `total`,
   and SHALL keep successive `done` values for one `id` non-decreasing.
9. WHEN the Snapshot_Builder has finished writing a snapshot, THE Agent_Runtime SHALL emit
   exactly one `snapshot_ready` event for that invocation, carrying `snapshot_id`,
   `resource_count`, `window`, `grain` and `gaps`, before it emits `done`.
10. THE Agent_Runtime SHALL emit `done` carrying `run_id` and `status` as the final event of
    every invocation, and SHALL emit no event of any type after that `done`.
11. THE Agent_Runtime SHALL emit no `verification` event and no `report_file` event, because
    document rendering and verification are out of scope for this spec.
12. THE Agent_Runtime SHALL read configuration from environment variables through a single
    configuration object built once at process start, SHALL re-read no environment variable
    after that point, and SHALL reject every attempted mutation of that object by raising an
    error.
13. IF a payload carries no `command` field, THEN THE Agent_Runtime SHALL emit an `error` event
    carrying `terminal` true, SHALL make no model invocation, and SHALL emit `done` as the next
    and final event, because model-facing chat is out of this spec's scope.
14. IF a phase for which the Agent_Runtime emitted a `tool` event with `phase` `start` ends
    without a matching `phase` `end` event, including a phase that ended by raising an
    exception, THEN THE Agent_Runtime SHALL emit that matching `phase` `end` event before it
    emits `done`, so that no activity step is left open.
15. THE Agent_Runtime SHALL carry a `type` field on every emitted event, and SHALL emit only
    event types declared in `agent/src/reporting_agent/events.py`.
16. IF a required environment variable is absent or empty when the Agent_Runtime builds its
    configuration object at process start, THEN THE Agent_Runtime SHALL raise an error naming
    that variable and SHALL exclude that variable's value from that error.

#### Requirement 15: The redaction guard

**User Story:** As a security reviewer, I want a secret to be structurally unable to reach an
event or a log line, so that an unexpected error message is not a credential disclosure.

##### Acceptance Criteria

1. WHEN the Agent_Runtime parses an invocation `context`, THE Redaction_Guard SHALL register
   the `client_secret` value and the `progress_token` value as secrets, and SHALL treat those
   two values as carrying identical sensitivity, because the `progress_token` authorizes writes
   to the run state machine.
2. WHEN the Agent_Runtime installs the logging filter, THE Redaction_Guard SHALL attach that
   filter to the root logger and to every root logger handler, SHALL attach at most one such
   filter to each of them however many times the installation runs, and SHALL run that
   installation both at process start and again after the invocation `context` is parsed, so
   that a handler added after process start is filtered.
3. WHEN the Agent_Runtime yields an event, THE Redaction_Guard SHALL replace every registered
   secret substring with a fixed placeholder in every string value of that event at every depth
   of nesting, including strings inside nested objects and inside arrays, before that event
   leaves the process.
4. WHEN the Agent_Runtime formats a runtime context for logging, THE Redaction_Guard SHALL
   render each secret as a presence-only marker that reveals no character of the secret.
5. WHEN the Agent_Runtime catches an exception, THE Redaction_Guard SHALL scrub the formatted
   text of that exception and of every chained cause and chained context exception before that
   text reaches an `error` event or a log line.
6. WHEN the Web_App relays an event to the browser, THE Web_App SHALL apply a redaction pass
   that removes every field whose name matches `client_secret`, `progress_token`, `tenant_id`
   or `client_id` in either snake_case or camelCase, compared case-insensitively, at every
   depth of that event.
7. THE Agent_Runtime SHALL exclude the `progress_token` value from every event, every log line,
   every persisted message, and every request target it constructs, so that no intermediary log
   can capture the token from a URL.
8. WHEN the Agent_Runtime emits an event, THE Redaction_Guard SHALL apply the scrub through one
   egress function that every emitted event passes through, so that a newly added emission site
   cannot bypass redaction.
9. IF a value offered for registration as a secret is absent, is not a string, or is shorter
   than 8 characters, THEN THE Redaction_Guard SHALL register no pattern for that value, so
   that an empty pattern cannot insert the placeholder between every character of the output
   and a one-character pattern cannot redact ordinary text.
10. WHEN an invocation emits its terminal event, THE Redaction_Guard SHALL discard the secrets
    registered for that invocation, so that the registry stays bounded and one invocation's
    secrets do not scrub another invocation's output.

#### Requirement 16: The heartbeat

**User Story:** As a consultant watching a run, I want the stream to stay alive during the
collector's quiet phases, so that a healthy run does not look like a hang.

##### Acceptance Criteria

1. WHILE an invocation has been accepted and has emitted no `done` event, THE
   Heartbeat_Emitter SHALL emit a `heartbeat` event carrying a timestamp at an interval of 15
   seconds with a tolerance of plus or minus 5 seconds, and SHALL emit its first `heartbeat`
   within 20 seconds of the invocation being accepted rather than at the first phase
   transition.
2. WHILE an invocation is in progress, THE Agent_Runtime SHALL emit consecutive events no more
   than 30 seconds apart, counting events of every type, so that the largest gap stays below
   the SSE_Relay's 120-second inactivity window by a factor of at least four.
3. WHEN an invocation emits its `done` event or its terminal `error` event, THE
   Heartbeat_Emitter SHALL stop emitting and SHALL emit no `heartbeat` event after that event,
   so that `done` remains the final event of the invocation.
4. WHEN the Web_App receives a `heartbeat` event, THE Web_App SHALL reset a client idle timer
   of 120 seconds, SHALL treat the elapsing of that timer rather than a slow response as the
   disconnect signal, and SHALL render no visible element for that event.
5. IF the Heartbeat_Emitter raises an exception or stops emitting before the invocation reaches
   its terminal event, THEN THE Agent_Runtime SHALL continue that invocation to its terminal
   event, SHALL record the failure in a log line, and SHALL record no `collection_log` gap for
   it, because a heartbeat failure is not a collection gap.
6. THE Heartbeat_Emitter SHALL include only a timestamp in a `heartbeat` event, and SHALL
   include no phase label, no resource count and no run identifier, so that no client can treat
   a heartbeat as run state.
7. FOR ALL pairs of consecutive `heartbeat` events within one invocation, THE Heartbeat_Emitter
   SHALL emit timestamps that do not decrease.
8. WHEN the agent test suite runs, THE Agent_Runtime SHALL include a test that drives a phase
   emitting no other event for at least 45 seconds of simulated time and asserts that at least
   two `heartbeat` events were emitted, so that an emitter that never starts fails the suite
   rather than a deployed run.

#### Requirement 17: Container and dependency pinning

**User Story:** As an operator, I want the image to start on AgentCore and the Azure SDK
imports to resolve, so that a deploy is not a debugging session.

##### Acceptance Criteria

1. THE Agent_Runtime SHALL ship as a container image whose manifest declares the platform
   `linux/arm64`, and SHALL name `--platform linux/arm64` explicitly in every image build
   command in its build recipe and its README, because a build on an x86 host that omits that
   flag produces an image the AgentCore runtime does not start.
2. THE Agent_Runtime SHALL pin `azure-monitor-query` in `pyproject.toml` to a range whose lower
   bound is version 2 and whose upper bound excludes the next major version, because version 2
   exports logs clients only and that package serves `LogsQueryClient` for the enhanced tier
   alone.
3. THE Agent_Runtime SHALL pin `azure-monitor-querymetrics` in `pyproject.toml` to a range
   carrying both a lower bound and an upper bound that excludes the next major version.
4. WHEN `pyproject.toml` pins the three Azure Monitor packages, THE Agent_Runtime SHALL carry an
   adjacent comment stating that `azure-monitor-query` version 2 removed both `MetricsClient`
   and `MetricsQueryClient`, that batch metric values therefore require
   `azure-monitor-querymetrics`, that metric definitions and the per-resource fallback therefore
   require `azure-mgmt-monitor`, and that the three packages are pinned together, because
   installing a subset of the three fails at import in a way that reads like a version-pin
   problem and is not.
5. THE Agent_Runtime SHALL import `MetricsClient` from `azure-monitor-querymetrics`, SHALL
   import `MonitorManagementClient` from `azure-mgmt-monitor`, and SHALL import
   `LogsQueryClient` from `azure-monitor-query`.
6. WHEN the agent test suite runs, THE Agent_Runtime SHALL include a test that imports
   `MetricsClient` from `azure-monitor-querymetrics`, imports `MonitorManagementClient` from
   `azure-mgmt-monitor`, imports `LogsQueryClient` from `azure-monitor-query`, and asserts that
   both `MetricsClient` and `MetricsQueryClient` are absent from `azure-monitor-query`, so that
   pinning only a subset of the three packages fails the suite rather than a deployed run.
7. IF a source module under `agent/src/reporting_agent/` imports `MetricsClient` from
   `azure-monitor-query`, or imports `MetricsQueryClient` from any package, THEN THE
   Agent_Runtime SHALL fail its test suite, because `azure-monitor-query` version 2 exports no
   `MetricsClient` and no pinned package exports `MetricsQueryClient` at all.
8. THE Agent_Runtime SHALL install its Python dependencies into the image from a committed,
   fully pinned dependency set, so that two builds of one commit resolve identical package
   versions.
9. THE Agent_Runtime SHALL pin the Python version its image is built on, because Property 2.4
   requires one snapshot to hash identically across two operating-system processes.
10. THE Agent_Runtime SHALL pin `azure-mgmt-monitor` in `pyproject.toml` to exactly version
    7.0.0, because that package is the only pinned package providing both
    `MonitorManagementClient.metric_definitions.list` and
    `MonitorManagementClient.metrics.list`.

---

### Section D — The Azure collector

Every criterion in this section corresponds to a verified finding in `azure-integration.md`.
The traceability table at the end of this document maps that document's guardrails checklist
onto these criteria.

#### Requirement 18: The provider protocol

**User Story:** As a developer, I want a second cloud to be addable without touching the
collector's callers, so that the AWS and VMware work does not become a rewrite.

##### Acceptance Criteria

1. THE Provider_Protocol SHALL define the operations `discover`, `collect` and `capabilities`.
2. THE Provider_Protocol SHALL define `discover` as returning a resource inventory and a
   collection_log, and SHALL define `collect` as returning accumulated per-resource statistics
   and a collection_log.
3. THE Provider_Protocol SHALL express every operation's input and output as structures built
   only from strings, booleans, integers, `Decimal` values, null, lists and dictionaries of
   those types, and SHALL contain no value whose type is defined by a cloud provider SDK.
4. THE Agent_Runtime SHALL reach a provider only through the Provider_Protocol, so that adding
   a provider changes no caller.
5. THE Agent_Runtime SHALL import an Azure SDK only from modules under
   `agent/src/reporting_agent/azure/`.
6. THE Provider_Protocol SHALL define `capabilities` as returning the resource types the
   provider collects, the metric names available per resource type, the grains the provider
   supports, and the fidelity tiers the provider can report.
7. WHEN the agent test suite runs, THE Agent_Runtime SHALL include a test that fails IF a
   module outside `agent/src/reporting_agent/azure/` imports a package whose name begins with
   `azure`, so that `collect/`, `compile/`, `render/` and `verify/` stay unit-testable without
   a subscription.
8. IF a call through the Provider_Protocol raises an exception, THEN THE Agent_Runtime SHALL
   emit an `error` event carrying the scrubbed exception text with `terminal` true, and SHALL
   emit `done` as the final event of that invocation.
9. FOR ALL inventories returned through the Provider_Protocol, THE Provider_Protocol SHALL
   order resources by resource id ascending in Unicode code-point order, so that two
   collections over identical input present identical array order to the Snapshot_Builder.

#### Requirement 19: One credential, reused

**User Story:** As an operator, I want the agent to authenticate once per run, so that token
acquisition does not itself trigger throttling.

##### Acceptance Criteria

1. WHEN the Credential_Factory builds a credential for a run, THE Credential_Factory SHALL
   construct exactly one `ClientSecretCredential` from the `tenant_id`, `client_id` and
   `client_secret` values carried in that invocation's `context`, and SHALL reuse that single
   instance for every Azure client used by that run.
2. THE Credential_Factory SHALL provide the same credential instance for the
   `management.azure.com` audience and for the regional metrics data-plane audience.
3. WHEN the agent test suite runs, THE Agent_Runtime SHALL include a test asserting that one
   collection over a fixture holding at least 2 resource types across at least 2 locations
   constructs `ClientSecretCredential` exactly once, and that the construction happens before
   the first Azure client is constructed.
4. WHEN a second invocation begins in the same process, THE Credential_Factory SHALL construct
   a new `ClientSecretCredential` for that invocation and SHALL reuse no credential instance
   built for an earlier invocation, so that one customer's credential is never presented
   against another customer's subscription.
5. WHILE more than one Azure request for a run is in flight, THE Credential_Factory SHALL serve
   the same credential instance to every in-flight client and SHALL perform at most 1 token
   acquisition per audience at a time.
6. IF token acquisition through the credential fails for an authorization reason other than an
   expired client secret, THEN THE Agent_Runtime SHALL report the terminal code `AUTH_FAILED`,
   distinct from `AUTH_EXPIRED`, so that a rejected client id is distinguishable from an
   expired secret.
7. THE Credential_Factory SHALL construct the credential only from the values carried in the
   invocation `context`, and SHALL read no credential value from an environment variable and no
   ambient credential source, so that a run never authenticates as the container's own
   identity.

#### Requirement 20: Inventory via Azure Resource Graph

**User Story:** As a consultant, I want a complete resource inventory including power state, so
that a stopped VM is not reported as measured idle.

##### Acceptance Criteria

1. WHEN the Inventory_Collector queries Azure Resource Graph, THE Inventory_Collector SHALL
   project `properties.extended.instanceView.powerState.code` for every resource.
2. WHILE a Resource Graph response carries a `skip_token`, THE Inventory_Collector SHALL issue
   a further request using that token, until a response carries no `skip_token`.
3. IF a Resource Graph response carries an `x-ms-user-quota-remaining` value of 1 or greater,
   THEN THE Inventory_Collector SHALL issue the next paged request immediately, with no
   interposed wait.
4. IF a Resource Graph response carries an `x-ms-user-quota-remaining` value of 0, THEN THE
   Inventory_Collector SHALL wait for the duration carried in that response's
   `x-ms-user-quota-resets-after` header before issuing the next request, and SHALL apply no
   locally chosen backoff duration in place of that header value.
5. WHEN the Inventory_Collector records a resource whose projected `powerState.code` equals
   `PowerState/deallocated` or `PowerState/stopped`, THE Inventory_Collector SHALL record a
   `deallocated` gap carrying that resource's id and the exact projected code value.
6. WHERE a resource carries a `deallocated` gap, THE Accumulator SHALL exclude that resource
   from every average and SHALL emit no zero-valued statistic for that resource, so that a
   stopped virtual machine is reported as stopped rather than as measured idle.
7. WHEN a metric is absent from the metric definitions for a resource's type and region, THE
   Metrics_Collector SHALL record a `metric_not_emitted` gap distinct from a `deallocated` gap.
8. IF Azure returns HTTP 403 for a resource, THEN THE Metrics_Collector SHALL record a
   `permission_denied` gap distinct from a `deallocated` gap and from a `metric_not_emitted`
   gap.
9. THE Inventory_Collector SHALL record `fidelity_tier` and `power_state` on every resource in
   the inventory.
10. WHERE a resource carries a `deallocated` gap, THE Inventory_Collector SHALL retain that
    resource in the inventory carrying its resource id, resource type, location, resource
    group, tags and `power_state`, so that a stopped resource is present and labelled rather
    than absent.
11. WHEN the Inventory_Collector queries Azure Resource Graph, THE Inventory_Collector SHALL
    scope that query to the run's `subscription_id` and SHALL project the resource id, name,
    type, location, resource group, tags, the resource's SKU or size identifier, and
    `properties.extended.instanceView.powerState.code`.
12. IF two paged Resource Graph responses in one collection carry the same resource id, THEN
    THE Inventory_Collector SHALL retain exactly one entry for that resource id and SHALL
    record a `duplicate_inventory_row` gap, so that a page boundary changes neither the
    resource count nor the snapshot content.
13. IF a resource whose type is `Microsoft.Compute/virtualMachines` carries an absent or empty
    projected `powerState.code`, THEN THE Inventory_Collector SHALL record a
    `power_state_unknown` gap and THE Accumulator SHALL exclude that resource from every
    average, so that an unknown power state is distinguishable from a measured value.
14. IF `x-ms-user-quota-remaining` is 0 and `x-ms-user-quota-resets-after` is absent or is not
    parseable as a duration, THEN THE Inventory_Collector SHALL wait 5 seconds before issuing
    the next request and SHALL apply that wait at most 3 consecutive times, and IF a 4th
    consecutive wait would be required, THEN THE Agent_Runtime SHALL report the retryable code
    `THROTTLED`.

#### Requirement 21: SKU capacity

**User Story:** As a consultant, I want derived per-core and memory figures computed from the
capacity the VM actually exposes, so that a constrained-core SKU is not overstated by four
times.

##### Acceptance Criteria

1. WHEN the SKU_Catalog lists resource SKUs, THE SKU_Catalog SHALL pass the resource's
   `location` as a filter parameter on the listing request so that the service returns only
   that location's SKUs, and SHALL issue no listing request that omits a `location` filter.
2. THE SKU_Catalog SHALL read vCPU capacity from the capability named `vCPUsAvailable` and
   SHALL parse that capability's value as a `Decimal`.
3. THE SKU_Catalog SHALL exclude the `vCPUs` capability from every capacity computation,
   because a constrained-core SKU reports the parent SKU's core count there — for example
   `Standard_E32-8s_v5` advertises 32 while exposing 8.
4. WHEN the SKU_Catalog reads the `MemoryGB` capability, THE SKU_Catalog SHALL parse that
   value as a `Decimal` and SHALL treat the unit as GiB.
5. WHEN the SKU_Catalog converts `MemoryGB` to bytes, THE SKU_Catalog SHALL multiply the parsed
   `Decimal` by exactly 1073741824 using decimal arithmetic, SHALL record the unit as bytes,
   and SHALL emit the result as an integer-valued decimal string.
6. WHEN the SKU_Catalog resolves a SKU for a location already present in the SKU_Catalog's
   cache, THE SKU_Catalog SHALL serve that SKU from the cache and SHALL issue no further
   listing call.
7. IF a SKU is absent from the listing for a resource's location, THEN THE SKU_Catalog SHALL
   record a `sku_unknown` gap.
8. WHERE a resource carries a `sku_unknown` gap, THE Accumulator SHALL emit no derived value
   that depends on that resource's SKU capacity.
9. IF the capability named `vCPUsAvailable` is absent from a resolved SKU or its value fails to
   parse as a `Decimal`, THEN THE SKU_Catalog SHALL record a `sku_capability_missing` gap
   carrying the SKU name and the capability name, and SHALL read no vCPU capacity from the
   `vCPUs` capability in its place.
10. IF the capability named `MemoryGB` is absent from a resolved SKU or its value fails to parse
    as a `Decimal`, THEN THE SKU_Catalog SHALL record a `sku_capability_missing` gap carrying
    the SKU name and the capability name, and THE Accumulator SHALL emit no memory utilization
    percentage for every resource carrying that SKU.
11. THE SKU_Catalog SHALL key its cache on the pair `(subscription, location)` and SHALL discard
    that cache when the run ends, because SKU restrictions are subscription-scoped and one
    subscription's restrictions are not another's.
12. THE SKU_Catalog SHALL contain no `float` value on the path from a SKU capability value to a
    snapshot value.

#### Requirement 22: Metric definitions, probed once and cached

**User Story:** As an operator, I want a run to spend its request quota on metric values, so
that a few hundred resources do not add minutes of probing for no information.

##### Acceptance Criteria

1. WHEN the Definition_Probe needs metric definitions for a resource, THE Definition_Probe
   SHALL probe `MonitorManagementClient.metric_definitions.list` once per
   `(resource_type, region)` pair.
2. WHEN the Definition_Probe has already probed a `(resource_type, region)` pair during a run,
   THE Definition_Probe SHALL serve the definitions from its cache and SHALL issue no further
   probe.
3. WHEN the agent test suite runs, THE Agent_Runtime SHALL include a test asserting that a
   collection over at least 50 resources sharing one `(resource_type, region)` pair issues
   exactly 1 definition probe, and that a collection over resources of one resource type spread
   across 2 regions issues exactly 2 definition probes.
4. WHEN the Definition_Probe selects the resource to probe for a `(resource_type, region)` pair,
   THE Definition_Probe SHALL select the resource whose id sorts first in Unicode code-point
   order among that pair's resources, and IF that probe fails, THEN THE Definition_Probe SHALL
   retry against at most 2 further distinct resources of that pair.
5. IF every probe attempt for a `(resource_type, region)` pair fails, THEN THE Definition_Probe
   SHALL record a `definitions_unavailable` gap carrying the resource type and the region, and
   THE Metrics_Collector SHALL request the Metric_Catalog's declared metric set for that pair
   rather than skipping that pair's resources.
6. IF a probe for a `(resource_type, region)` pair fails, THEN THE Definition_Probe SHALL store
   no definition set for that pair in its cache, and THE Metrics_Collector SHALL record no
   `metric_not_emitted` gap derived from a failed probe, so that an unanswered probe is
   distinguishable from a metric the platform does not emit.
7. THE Definition_Probe SHALL key its cache on the pair `(resource_type, region)` and SHALL
   discard that cache when the run ends.

#### Requirement 23: Batch metrics collection

**User Story:** As an operator, I want batch sizing to be governed by response size rather than
resource count, so that oversized-response failures stop looking random.

##### Acceptance Criteria

1. WHEN the Metrics_Collector groups resources for a batch request, THE Metrics_Collector
   SHALL group by the key `(subscription, location, resource_type)`.
2. WHEN the Metrics_Collector sizes a batch, THE Metrics_Collector SHALL compute the expected
   points per metric as the count of grain intervals in that batch's requested time window,
   SHALL compute the batch's estimated point count as resource count multiplied by metric count
   multiplied by that interval count, and SHALL size that batch so that the estimated point
   count is at most the points budget of 20000.
3. IF a batch request fails with a response-too-large indication, THEN THE Metrics_Collector
   SHALL halve that batch's resource count by integer division, SHALL retry, and SHALL repeat
   that halving until the request succeeds or the batch contains exactly 1 resource.
4. THE Metrics_Collector SHALL size batches by the points budget rather than by the documented
   50-resource cap, because 50 resources at 6 metrics and 720 hourly points is 216000 points.
5. THE Metrics_Collector SHALL request batch metric values through
   `MetricsClient.query_resources`.
6. THE Metrics_Collector SHALL treat batch sizing as the only control over response size,
   because the batch metrics endpoint provides no paging.
7. WHEN the Metrics_Collector issues metric requests for one subscription, THE
   Metrics_Collector SHALL limit concurrent in-flight requests for that subscription to 8,
   counting batch requests and per-resource fallback requests against the same limit, keyed by
   subscription id so that requests for a different subscription are limited independently.
8. IF Azure returns HTTP 429 carrying a `Retry-After` header, THEN THE Metrics_Collector SHALL
   wait for the duration that header specifies, accepting either a count of seconds or an
   HTTP-date, before retrying that request.
9. IF Azure returns HTTP 429 on 5 consecutive attempts for one request, each attempt having
   honoured the wait derived from the preceding response, THEN THE Agent_Runtime SHALL report
   the retryable code `THROTTLED`.
10. WHEN the Metrics_Collector issues a batch metrics request, THE Metrics_Collector SHALL send
    exactly 1 `metric_namespace` value, SHALL include only resources whose resource type that
    namespace names, and SHALL request one identical time window and one identical grain for
    every resource in that request.
11. WHEN the Metrics_Collector requests aggregations for a metric, THE Metrics_Collector SHALL
    request `Total`, `Count`, `Minimum` and `Maximum`, so that the Accumulator computes a
    count-weighted average and exact extremes from the response alone.
12. WHEN the Metrics_Collector reads a batch response, THE Metrics_Collector SHALL associate
    every returned series with a requested resource by resource id rather than by position in
    the request, and IF a requested resource is absent from that response, THEN THE
    Metrics_Collector SHALL record a `resource_absent_from_response` gap carrying that
    resource's id.
13. IF an interval in a response omits its `count` value or its `total` value, THEN THE
    Metrics_Collector SHALL record an `interval_counts_missing` gap carrying the resource id and
    the metric, and THE Accumulator SHALL exclude that interval from the average.
14. IF a batch containing exactly 1 resource fails with a response-too-large indication, THEN
    THE Metrics_Collector SHALL split that request by metric name, and IF a single-metric
    request also fails with a response-too-large indication, THEN THE Metrics_Collector SHALL
    record a `response_too_large` gap and SHALL record no zero value for that resource.
15. IF a resource in the inventory has a resource type for which the caller requested no metric
    at all, THEN THE Metrics_Collector SHALL record a `metric_not_selected` gap carrying that
    resource's id and its resource type, SHALL issue no metrics request for that resource, and
    SHALL record no zero value for it.
16. THE Metrics_Collector SHALL record a `metric_not_selected` gap distinct from a
    `metric_not_emitted` gap and from a `no_samples` gap, because the three name three
    different causes: nothing was asked for, Azure emits nothing for this SKU, and the samples
    came back empty. Only the first is a decision the caller made.

    Without this gap the case leaves **no trace at all**. An unrequested metric builds no
    accumulator, so it produces no `no_samples` gap, no per-resource error and no absent-from-
    response gap — the resource is simply present in the snapshot carrying no statistics. The
    coverage gate asserts presence and passes, `assert_some_statistic` is satisfied by any
    other resource that did collect, and the run completes as a fully verified report holding
    resources with no figures and nothing anywhere saying why.

#### Requirement 24: Regional data-plane endpoints

**User Story:** As a consultant, I want a region without a metrics data-plane host to be
collected the slow way, so that a report is never silently missing a region.

##### Acceptance Criteria

1. WHEN the Region_Resolver selects an endpoint for a batch metrics request, THE
   Region_Resolver SHALL select the regional metrics data-plane endpoint for the `location`
   component of that batch's `(subscription, location, resource_type)` grouping key.
2. IF the regional metrics endpoint for a location fails to resolve in DNS, THEN THE
   Metrics_Collector SHALL collect every resource in that location through per-resource
   `MonitorManagementClient.metrics.list` requests, because that operation is the ARM
   control-plane API on `management.azure.com`, which has no regional endpoint and requires no
   token scope beyond the one the run's single credential already serves.
3. FOR ALL distinct locations present in a run's inventory, THE Metrics_Collector SHALL issue at
   least one metric request against that location, so that no location is dropped from a run.
4. IF the per-resource fallback for a location also fails, THEN THE Metrics_Collector SHALL
   record a `region_unreachable` gap for every resource in that location, SHALL record no
   statistic value and no zero value for those resources, and THE Agent_Runtime SHALL report
   `REGION_UNREACHABLE` as a non-terminal code.
5. IF every distinct location in a run resolves to `region_unreachable`, THEN THE
   Run_State_Machine SHALL set the run `status` to `failed` and `error_code` to
   `REGION_UNREACHABLE`.
6. WHEN the Region_Resolver observes a DNS resolution failure for a location's regional metrics
   endpoint, THE Region_Resolver SHALL record that location as fallback-only for the remainder
   of the run, and THE Metrics_Collector SHALL route every subsequent request for that location
   to the per-resource `MonitorManagementClient.metrics.list` path with no further DNS
   resolution attempt.
7. WHEN the Metrics_Collector collects a location through the per-resource fallback, THE
   Metrics_Collector SHALL request the same grain, the same time window, the same metric names
   and the same aggregations it would have requested through the batch path.
8. WHEN the Metrics_Collector receives a per-resource fallback response, THE Archive_Writer
   SHALL write that response to
   `s3://<RPT_ARTIFACT_BUCKET>/<actor_id>/snapshots/<runId>/raw/` as a gzip-compressed JSON
   object during the same pass that folds it, so that a fallback location is replayable from
   the archive alone.

#### Requirement 25: Grain and local-day bucketing

**User Story:** As a consultant, I want a July report to mean July in the customer's timezone,
so that a reported day is a real day and peak-hour analysis means something.

##### Acceptance Criteria

1. WHERE every UTC offset in effect during a run's collection window is a whole number of hours,
   THE Metrics_Collector SHALL request the grain `PT1H` for every metric request in that run.
2. THE Metrics_Collector SHALL exclude the `P1D` grain from every request, because `P1D`
   buckets are UTC-aligned and a UTC+07:00 customer's reported day would span 07:00 to 07:00
   local.
3. WHEN the Bucketer assigns an hourly data point to a day, THE Bucketer SHALL assign that
   point to the local day that contains the start instant of that point's interval, computed in
   the run's configured timezone.
4. IF an invocation's `context` omits `timezone` or carries an empty `timezone`, THEN THE
   Bucketer SHALL use `Asia/Jakarta` at UTC+07:00 as the run timezone.
5. IF the run timezone's UTC offset at the collection window's start instant, at the collection
   window's end instant, or at any offset transition falling between them is not a whole number
   of hours, THEN THE Metrics_Collector SHALL request the grain `PT15M` for every metric request
   in that run.
6. WHEN the Metrics_Collector determines whether a run requires the `PT15M` grain, THE
   Metrics_Collector SHALL derive that determination from the UTC offsets it evaluated across
   that run's collection window and SHALL consult no hardcoded list of zone names.
7. WHEN the Bucketer computes the collection window from a local start date and a local end
   date, THE Bucketer SHALL resolve the window start to 00:00:00 on the local start date and the
   window end to 00:00:00 on the local day following the local end date, SHALL convert both to
   UTC instants before requesting metrics, and SHALL treat the window as including the start
   instant and excluding the end instant.
8. THE Metrics_Collector SHALL restrict every metric request in a run to the grain `PT1H` or the
   grain `PT15M`, and SHALL request the grain `PT1M` and the grain `P1D` in no request, because
   200 resources at 6 metrics over 31 days is approximately 268000 points per resource and
   approximately 6 GB of JSON at `PT1M` against approximately 4500 points and approximately
   110 MB at `PT1H`.
9. IF an invocation's `context` carries a `timezone` value that resolves to no IANA time zone,
   THEN THE Agent_Runtime SHALL emit an `error` event with `terminal` true, SHALL make no metric
   request, and SHALL write no snapshot, because an unresolvable zone would silently change
   every local-day value.
10. WHEN the Bucketer assigns a data point to a local day, THE Bucketer SHALL interpret that
    point's timestamp as UTC and SHALL derive the local day solely from the run's configured
    timezone, so that the assignment is identical under every host and process time zone
    setting.
11. WHERE a local day at either edge of the collection window contains fewer hourly slots than a
    full local day, THE Bucketer SHALL retain that local day as a bucket and SHALL record the
    count of slots that contributed to it.
12. WHEN a run's grain is `PT15M`, THE Metrics_Collector SHALL derive expected points per metric
    from the count of `PT15M` intervals in the collection window when applying the 20000-point
    budget.

#### Requirement 26: Stream-reduce and the raw archive

**User Story:** As an operator, I want a 200-resource month to fit in the container's memory,
and I want the raw responses kept, so that a disputed figure has evidence behind it.

##### Acceptance Criteria

1. WHEN the Metrics_Collector receives a batch response, THE Metrics_Collector SHALL fold that
   response's data points into the Accumulator and the Sketch, and SHALL then discard those
   data points.
2. THE Metrics_Collector SHALL retain, for each (resource, metric) pair, only that pair's
   accumulated sum, accumulated count, minimum and maximum together with that pair's Sketch, and
   SHALL hold no complete series for any resource in memory at any point, because 200 resources
   at 6 metrics over 31 days at `PT1M` is approximately 268000 points per resource and
   approximately 6 GB of JSON.
3. WHEN the Metrics_Collector receives a batch response, THE Archive_Writer SHALL write that
   response to `s3://<RPT_ARTIFACT_BUCKET>/<actor_id>/snapshots/<runId>/raw/` under the run's
   `actor_id` prefix, as a gzip-compressed JSON object whose key ends in `.json.gz`, during
   the same pass that folds that response.
4. WHEN the Archive_Writer receives a raw response to write, THE Archive_Writer SHALL either
   complete that write or record an `archive_write_failed` gap before the Metrics_Collector
   discards that response's data points.
5. THE Metrics_Collector SHALL re-read no Azure data to build the archive, so that the archive
   costs no additional Azure request.
6. WHEN the Archive_Writer writes a raw response, THE Archive_Writer SHALL include the
   grouping key, the requested grain, the requested time window and the requested metric
   names in that object, so that the aggregation can be replayed from the archive alone.
7. IF the Archive_Writer fails to write a raw response, THEN THE Metrics_Collector SHALL record
   an `archive_write_failed` gap for every resource in that response's grouping key, SHALL fold
   that response into the Accumulator and the Sketch, and SHALL continue the collection.
8. WHEN the Archive_Writer writes a raw response, THE Archive_Writer SHALL derive that object's
   key from the run id, that response's grouping key and a per-run sequence number, so that no
   raw object overwrites another and a run's raw objects are enumerable in the order they were
   folded.
9. WHEN the Metrics_Collector folds a batch response into the Accumulator, THE Archive_Writer
   SHALL write exactly one object for that response.
10. IF the service rejects a batch request, THEN THE Archive_Writer SHALL write no object for
    that rejected request, so that folding the archived objects once each reproduces the
    aggregation exactly.
11. FOR ALL counts of data points folded for one (resource, metric) pair, THE Metrics_Collector
    SHALL keep the state it retains for that pair below a fixed declared bound that does not
    vary with that count.
12. WHEN a run records at least one `archive_write_failed` gap, THE Snapshot_Builder SHALL record
    on that run's snapshot that the raw archive is incomplete, so that a run whose aggregation
    can be replayed from the archive is distinguishable from one whose aggregation cannot.

#### Requirement 27: Aggregation correctness

**User Story:** As a consultant, I want the average to be the real average, so that a month
boundary or a recently created VM does not silently skew a figure I signed.

##### Acceptance Criteria

1. WHEN the Accumulator computes an average over intervals, THE Accumulator SHALL compute
   `sum(total across intervals) / sum(count across intervals)`.
2. THE Accumulator SHALL contain no code path that computes an average as the arithmetic mean
   of per-interval averages, because that weights a 3-sample interval equally with a
   60-sample interval.
3. WHEN the Accumulator rolls up a minimum across intervals, THE Accumulator SHALL take the
   minimum of the per-interval minima.
4. WHEN the Accumulator rolls up a maximum across intervals, THE Accumulator SHALL take the
   maximum of the per-interval maxima.
5. THE Accumulator SHALL perform every arithmetic operation on `Decimal` values.
6. THE Accumulator SHALL contain no `float` value on the path from a folded response to a
   snapshot value.
7. WHEN the Accumulator folds an interval carrying a count of zero, THE Accumulator SHALL leave
   that (resource, metric) pair's accumulated sum, accumulated count, minimum and maximum
   unchanged.
8. WHEN the Metrics_Collector requests values for a metric whose Metric_Catalog entry declares an
   average, THE Metrics_Collector SHALL request the `Total` aggregation and the `Count`
   aggregation for that metric, so that the Accumulator can weight by sample count.
9. IF the summed count across every folded interval for a (resource, metric) pair is zero, THEN
   THE Accumulator SHALL emit no average, no minimum and no maximum for that pair and THE
   Metrics_Collector SHALL record a `no_samples` gap naming that resource and that metric.
10. IF a folded interval omits its count, omits its total, or carries a value that is not a
    decimal in either, THEN THE Metrics_Collector SHALL record an `interval_malformed` gap naming
    that resource and that metric and THE Accumulator SHALL leave that pair's accumulated sum,
    accumulated count, minimum and maximum unchanged.
11. WHEN the Accumulator divides an accumulated total by an accumulated count, THE Accumulator
    SHALL carry out that division at a working precision of at least 28 significant decimal
    digits and SHALL quantize the result to exactly 6 decimal places, rounding half to even.
12. FOR ALL orders in which a set of intervals for one (resource, metric) pair is folded, THE
    Accumulator SHALL emit an identical average, an identical minimum and an identical maximum
    for that pair.

#### Requirement 28: Percentiles from bounded sketches

**User Story:** As a consultant, I want a percentile to be labelled with how it was produced,
so that I never recommend downsizing a machine that saturates daily.

##### Acceptance Criteria

1. WHEN the Metrics_Collector folds a data point for a metric whose Metric_Catalog entry declares
   a percentage unit, THE Sketch SHALL fold that point into a fixed histogram spanning 0 to 100
   with a bin width of 0.5.
2. WHEN the Metrics_Collector folds a data point for a metric whose Metric_Catalog entry declares
   a byte, IOPS or throughput unit, THE Sketch SHALL fold that point into a log-spaced DDSketch
   with a `gamma` of 1.02.
3. FOR ALL counts of data points folded into one series, THE Sketch SHALL retain at most 200 bins
   for a fixed histogram and at most 2048 buckets for a DDSketch, so that a month at `PT1H`
   occupies the same bounded state as a day at `PT1H`.
4. THE Snapshot_Builder SHALL emit no object key named `p95`, no object key named `p99`, and no
   object key consisting of the letter `p` followed only by digits, at any level of the
   snapshot.
5. WHEN the Snapshot_Builder emits a percentile, THE Snapshot_Builder SHALL emit an object
   carrying `metric`, `statistic`, `value`, `estimator`, `fidelity_tier` and `unit`.
6. WHEN the Snapshot_Builder emits a percentile derived from a grain coarser than `PT1M`, THE
   Snapshot_Builder SHALL set `estimator` to a value identifying that source grain.
7. WHERE a resource's `fidelity_tier` is `baseline`, THE Snapshot_Builder SHALL mark every
   percentile for that resource as an estimate.
8. THE Snapshot_Builder SHALL derive every percentile from a Sketch folded during collection,
   and SHALL derive no percentile from data points read a second time.
9. WHEN the Sketch selects which sketch kind to fold a metric's points into, THE Sketch SHALL
   select that kind from the unit the Metric_Catalog declares for that metric and SHALL derive
   that selection from no metric name substring.
10. IF a value folded into a fixed histogram falls below 0 or above 100, THEN THE Sketch SHALL
    fold that value into the nearest boundary bin and SHALL retain the exact observed minimum and
    maximum alongside the bins, so that the estimated 0 quantile is at most the observed minimum
    and the estimated 1 quantile is at least the observed maximum.
11. WHEN the Sketch folds a value of exactly 0 into a log-spaced DDSketch, THE Sketch SHALL count
    that value in a dedicated zero bucket, so that a series of idle intervals yields a defined
    quantile.
12. WHEN the Sketch folds a data point taken from an interval coarser than `PT1M`, THE Sketch
    SHALL fold the value obtained by dividing that interval's total by that interval's count, and
    THE Snapshot_Builder SHALL set that percentile's `estimator` to a value naming both that
    source grain and the interval statistic folded.
13. IF a metric's Metric_Catalog-declared unit belongs to neither the percentage family nor the
    byte, IOPS and throughput family, THEN THE Snapshot_Builder SHALL emit no percentile for that
    metric and THE Metrics_Collector SHALL record a `percentile_unsupported_unit` gap naming that
    metric.

#### Requirement 29: Per-resource errors inside successful responses

**User Story:** As a consultant, I want a permission denial recorded as a gap, so that it never
averages into my report as measured idleness.

##### Acceptance Criteria

1. WHEN the Metrics_Collector receives a batch response with HTTP status 200, THE
   Metrics_Collector SHALL inspect the error field of every resource entry in that response.
2. WHEN a resource entry in a successful batch response carries an error, THE
   Metrics_Collector SHALL record a collection_log entry carrying a `gap_type`, that resource's
   id, the affected metric and a message describing that error.
3. THE Metrics_Collector SHALL contain no code path that converts a per-resource error into a
   value of zero.
4. THE Metrics_Collector SHALL contain no bare exception suppression on the path from a batch
   response to the Accumulator.
5. WHEN a run completes with at least one gap recorded, THE Run_State_Machine SHALL set that
   run's `status` to `completed` and THE Agent_Runtime SHALL emit an `error` event carrying the
   code `PARTIAL_COVERAGE` with `terminal` false before the `done` event.
6. IF a resource the Metrics_Collector requested is absent from that batch response, THEN THE
   Metrics_Collector SHALL record a `resource_absent_from_response` gap naming that resource and
   SHALL fold no value for that resource from that response.
7. IF a per-resource error in a successful batch response carries no recognized classification,
   THEN THE Metrics_Collector SHALL record that gap with the `gap_type` `metric_error` rather
   than omitting the entry, so that every per-resource error is typed.
8. WHEN the Metrics_Collector records a per-resource gap for a metric, THE Snapshot_Builder SHALL
   retain that resource in the snapshot and SHALL emit no value for the affected metric, so that
   an unreadable resource is visible rather than absent.
9. WHEN the Snapshot_Builder writes a snapshot, THE Snapshot_Builder SHALL include every
   collection_log entry recorded during that run in that snapshot's gap list, so that the gap
   count carried by `snapshot_ready` equals the count recorded during collection.

#### Requirement 30: Derived metrics and honest labels

**User Story:** As a consultant, I want a derived figure to carry its derivation, so that a
client asking "where did this come from" gets an answer rather than an assertion.

##### Acceptance Criteria

1. WHEN the Accumulator derives a memory utilization percentage for a resource, THE
   Accumulator SHALL compute
   `(sku_memory_bytes - available_memory_bytes) / sku_memory_bytes * 100` over `Decimal`
   values, SHALL take `sku_memory_bytes` from the byte capacity the SKU_Catalog resolved for
   that resource, SHALL derive the average utilization from the count-weighted average of
   `Available Memory Bytes`, SHALL derive the maximum utilization from the **minimum** of
   `Available Memory Bytes`, and SHALL derive the minimum utilization from the **maximum** of
   `Available Memory Bytes`, because the expression inverts the direction of the source
   metric.
2. WHEN the Snapshot_Builder emits a derived value, THE Snapshot_Builder SHALL include
   `derived_from` as an ordered list in which each entry names either one source metric name
   together with the statistic taken from that metric, or one SKU capability name together
   with the capacity resolved for it as a decimal string with its unit, and SHALL order that
   list identically for every value of the same derived statistic, so that the canonical form
   does not depend on the order responses arrived in.
3. WHEN the Snapshot_Builder emits a derived value, THE Snapshot_Builder SHALL include
   `formula` carrying the expression string the Metric_Catalog declares for that derived
   statistic, SHALL emit that identical string for every value of that derived statistic in
   every run, and SHALL name in that expression only identifiers that appear in that value's
   `derived_from`.
4. WHEN the Snapshot_Builder emits a memory utilization percentage, THE Snapshot_Builder SHALL
   carry on that value object a machine-readable observation marker whose value is
   `host_observed`, together with a fixed note stating that a host-observed memory percentage
   typically reads 1 to 3 percentage points below the guest-reported value because the host
   cannot observe guest-internal caching and reclaim, and SHALL carry both on that value
   object rather than at the snapshot's top level, so that every consumer of the value
   receives them.
5. WHEN the Snapshot_Builder emits a value derived from `Network In Total` or
   `Network Out Total`, THE Snapshot_Builder SHALL label that value as a NIC-level counter,
   SHALL record the unit as bytes, and SHALL record the length of the interval the total
   covers, because a total without its interval is not a rate.
6. THE Snapshot_Builder SHALL exclude the terms egress, transfer cost, bandwidth charge and
   billable from every string field of every value derived from `Network In Total` or
   `Network Out Total`, compared case-insensitively, including that value's label, `unit`,
   `statistic`, `formula` and `derived_from` entries, because the NIC counters are not
   billable egress and billable egress differs by zone, peering, intra-region exemption and
   free tier.
7. IF the SKU memory capacity resolved for a resource is absent or equal to zero, THEN THE
   Accumulator SHALL record a `sku_capability_missing` gap carrying that resource's id and the
   capability name, and SHALL emit no memory utilization percentage for that resource.
8. IF a computed memory utilization percentage falls below 0 or above 100, THEN THE
   Accumulator SHALL record a `metric_error` gap carrying that resource's id, the source
   metric name and the statistic, and SHALL emit no memory utilization value for that
   statistic, so that an available-memory reading inconsistent with the SKU capacity is
   recorded rather than clamped or zero-filled.
9. WHEN the Snapshot_Builder emits a value whose computation consumed a quantity other than
   that metric's own samples, THE Snapshot_Builder SHALL populate both `derived_from` and
   `formula` on that value, and SHALL emit no such value carrying either field absent or
   empty, because a derived number without its derivation is an assertion rather than a
   measurement.

#### Requirement 31: Two-tier fidelity

**User Story:** As a consultant, I want the report data to say which resources have true
percentiles, so that a right-sizing recommendation is honest about its basis.

##### Acceptance Criteria

1. THE Snapshot_Builder SHALL record `fidelity_tier` on every resource in the snapshot,
   constrained to the values `baseline` and `enhanced`, and SHALL set that value from the
   evidence collected for that resource during this run, taking the connected subscription's
   `fidelity_tier` as the ceiling, so that no resource is recorded as `enhanced` on the
   strength of the connection alone.
2. WHEN the Snapshot_Builder emits a statistic or a derived value computed from a resource's
   samples or from that resource's SKU capacity, THE Snapshot_Builder SHALL set that value's
   `fidelity_tier` equal to the `fidelity_tier` recorded on that resource, and SHALL emit no
   value whose `fidelity_tier` differs from the tier recorded on its resource.
3. WHERE a resource's `fidelity_tier` is `baseline`, THE Metrics_Collector SHALL collect avg,
   min and max for that resource from Azure platform metrics, SHALL record those three
   statistics as exact rather than estimated, and SHALL issue no Log Analytics query and
   request no guest-observed metric for that resource.
4. WHERE a resource's `fidelity_tier` is `enhanced`, THE Metrics_Collector SHALL query Log
   Analytics for exactly the guest-observed counters the Metric_Catalog declares for the
   enhanced tier, SHALL bound that query to the run's collection window, and SHALL record on
   every resulting value the counter name and the workspace identifier the value came from.
5. THE Metrics_Collector SHALL request no platform metric for in-guest disk free space, because
   no such platform metric exists.
6. IF a Log Analytics logical-disk row carries an `InstanceName` of `_Total`, or carries an
   `InstanceName` that is absent or empty, where per-volume rows were requested, THEN THE
   Metrics_Collector SHALL record an `instance_name_collapsed` gap carrying that resource's id
   and the counter name, SHALL emit no per-volume free-space value for that resource, and SHALL
   emit no resource-level free-space value derived from that row, because attributing one
   volume's free space to a named volume or to the whole virtual machine is an error that
   survives review by looking reasonable.
7. IF a resource's connected subscription records `fidelity_tier` `enhanced` and the
   guest-observed query for that resource fails, is rejected, or returns zero rows within the
   collection window, THEN THE Metrics_Collector SHALL record that resource's `fidelity_tier`
   as `baseline`, SHALL record a `no_samples` gap for a zero-row result and a `metric_error`
   gap for a failed or rejected query, and SHALL continue the run.
8. WHEN the Snapshot_Builder sets a percentile's `estimator`, THE Snapshot_Builder SHALL derive
   that value from the sketch and the source grain the value was folded from, and SHALL derive
   it from no resource's `fidelity_tier`, so that an `enhanced` resource whose percentile came
   from hourly platform samples is still marked as estimated.
9. WHERE a resource's `fidelity_tier` is `baseline`, THE Snapshot_Builder SHALL emit no
   per-volume disk free-space value, no guest-observed memory value, and no percentile marked
   as measured for that resource.

#### Requirement 32: The declarative metric catalog

**User Story:** As a developer, I want the metric set expressed as data, so that adding a
resource type is a catalog entry rather than a code change.

##### Acceptance Criteria

1. THE Metric_Catalog SHALL declare, per resource type, each metric's name, its unit, the unit
   family that selects its sketch, the aggregations requested for it, the number of fractional
   digits its values serialize with, and, for each derived statistic, that statistic's
   identifier, its source metric names with the statistic taken from each, the SKU capability
   names it consumes, its observation marker and its fixed formula string.
2. THE Metric_Catalog SHALL declare `Percentage CPU`, `Available Memory Bytes`,
   `Disk Read Bytes`, `Disk Write Bytes`, `Disk Read Operations/Sec`,
   `Disk Write Operations/Sec`, `Network In Total` and `Network Out Total` for
   `Microsoft.Compute/virtualMachines`, SHALL declare memory utilization percentage only as a
   derived statistic over `Available Memory Bytes` and the SKU memory capacity, and SHALL
   declare no platform metric expressing memory used as a percentage, because Azure emits no
   such metric.
3. WHEN the Agent_Runtime loads the Metric_Catalog, THE Agent_Runtime SHALL validate every
   entry against a declared schema requiring a non-empty metric name, a unit drawn from the
   declared unit set, a unit family drawn from the declared families, at least one aggregation
   drawn from the declared aggregation set, a fractional-digit count between 0 and 9 inclusive,
   no metric name repeated within one resource type, and every identifier named by a derived
   statistic's formula present in that entry's declared metrics or SKU capabilities.
4. IF a Metric_Catalog entry fails validation, THEN THE Agent_Runtime SHALL record a
   `catalog_entry_invalid` gap carrying that entry's resource type and metric name, SHALL skip
   that entry, SHALL emit no statistic for that entry, and SHALL continue the run.
5. THE Agent_Runtime SHALL raise no unhandled exception from Metric_Catalog validation, so
   that an invalid entry degrades a run rather than ending it.
6. IF a Metric_Catalog entry declares a unit family that selects neither the fixed 0-to-100
   histogram nor the DDSketch, THEN THE Metrics_Collector SHALL record a
   `percentile_unsupported_unit` gap for that metric, SHALL emit no percentile for that metric,
   and SHALL continue collecting that metric's avg, min and max.
7. IF validation leaves zero valid metric entries for every resource type present in the run's
   scope, THEN THE Agent_Runtime SHALL emit an `error` event carrying `terminal` true and the
   code `CATALOG_UNUSABLE`, and SHALL write no snapshot, because a snapshot carrying resources
   and no statistics is indistinguishable downstream from a measured one.
8. WHEN the Agent_Runtime starts, THE Agent_Runtime SHALL load the Metric_Catalog exactly once
   from data shipped in the container image, SHALL reject every attempted mutation of the loaded
   catalog by raising an error, and SHALL expose that catalog's declared version as a readable
   value.

#### Requirement 33: The empty-scope gate

**User Story:** As a consultant, I want a run that found nothing to fail, so that the product
cannot deliver a clean, fully verified, empty artifact.

##### Acceptance Criteria

1. IF the union of all scopes for a run resolves to zero resources, THEN THE Agent_Runtime
   SHALL report the terminal code `EMPTY_SCOPE`, SHALL write no snapshot object, SHALL emit no
   `snapshot_ready` event, and SHALL apply that outcome whatever the cause of the zero result,
   including an expired client secret and a Reader assignment made below subscription scope.
2. THE Agent_Runtime SHALL apply the empty-scope gate to the union of all scopes for the run,
   which for this spec is the run's single requested scope, and SHALL express that outcome as a
   terminal failure rather than as a warning or as a `collection_log` gap.
3. WHEN the Agent_Runtime reports `EMPTY_SCOPE`, THE Run_State_Machine SHALL set the run
   `status` to `failed` and `error_code` to `EMPTY_SCOPE`.
4. WHEN the Web_App displays a run that failed with `EMPTY_SCOPE`, THE Web_App SHALL state that
   zero resources were found, SHALL name the subscription and the requested period, SHALL state
   that no report artifact was produced, and SHALL list an expired client secret and a role
   assignment made below subscription scope as the causes to check.
5. WHEN the Inventory_Collector has finished paging every scope for a run, THE Agent_Runtime
   SHALL evaluate the empty-scope gate before it issues the first metrics request, before the
   Archive_Writer writes any raw object, and before the Snapshot_Builder writes any snapshot
   object.
6. WHEN the Agent_Runtime counts resources for the empty-scope gate, THE Agent_Runtime SHALL
   count distinct resource ids remaining after `duplicate_inventory_row` de-duplication, and
   SHALL include in that count every resource carrying a `deallocated`, `power_state_unknown` or
   `permission_denied` gap, so that a subscription whose virtual machines are all stopped is not
   reported as `EMPTY_SCOPE`.
7. IF at least one resource resolved in the run's scope and the collection produced zero metric
   statistics across every resource and every metric, THEN THE Agent_Runtime SHALL report the
   terminal code `NO_STATISTICS`, distinct from `EMPTY_SCOPE` and from `PARTIAL_COVERAGE`, and
   SHALL write no snapshot, because a snapshot carrying resources and no statistics reaches the
   same worthless artifact the empty-scope gate exists to prevent.

---

### Section E — The snapshot

#### Requirement 34: Determinism and content addressing

**User Story:** As a consultant, I want the snapshot to hash identically on any machine, so
that "immutable" means something an auditor can check.

##### Acceptance Criteria

1. THE Snapshot_Builder SHALL serialize every metric value as a decimal string carrying exactly
   the number of fractional digits the Metric_Catalog declares for that value's unit, rounded
   half to even, written in plain notation carrying no exponent, retaining trailing zeros to
   that scale, and carrying at most one leading minus sign.
2. THE Snapshot_Builder SHALL serialize no metric value as a JSON number, because
   `json.dumps` renders a float through `float.__repr__` and float equality across platforms
   and interpreter builds is not a basis for an audit artifact.
3. WHEN the Snapshot_Builder computes `content_hash`, THE Snapshot_Builder SHALL canonicalize
   the snapshot with RFC 8785 (JCS) and SHALL take the SHA-256 digest of the UTF-8 encoded
   bytes of that canonical form, rendered as 64 lowercase hexadecimal characters carrying no
   prefix.
4. WHEN the Snapshot_Builder canonicalizes a snapshot for hashing, THE Snapshot_Builder SHALL
   exclude both the `content_hash` field and the `snapshot_id` field from the canonicalized
   input, because `snapshot_id` equals that digest and including either field would make the
   computation circular.
5. THE Snapshot_Builder SHALL set `snapshot_id` equal to `content_hash` character for
   character, and SHALL emit no other identifier in the `snapshot_id` position.
6. THE Snapshot_Builder SHALL write each snapshot exactly once, SHALL expose no operation that
   modifies, partially rewrites or deletes a written snapshot, and SHALL expose no update path.
7. WHEN a collection is re-run, THE Snapshot_Builder SHALL write a new snapshot carrying a new
   `snapshot_id`, and SHALL leave every previously written snapshot object byte-identical at
   its own key.
8. WHEN the Snapshot_Builder serializes a snapshot, THE Snapshot_Builder SHALL order the
   resource list by resource id, each resource's statistics by metric name then statistic name,
   and the `gaps` list by `gap_type` then `resource_id` then `metric`, so that the canonical
   form does not depend on the order in which responses arrived.
9. IF an object already exists at the run's snapshot key, THEN THE Snapshot_Builder SHALL leave
   that object's bytes unchanged, SHALL write no second object at that key, and SHALL record
   that attempt in a log line.
10. IF a value offered for serialization into a snapshot is a `float`, THEN THE Snapshot_Builder
    SHALL raise an error naming the offending field path and SHALL write no snapshot object.

#### Requirement 35: Snapshot contents

**User Story:** As a consultant, I want the snapshot to carry its own provenance, so that a
report built from it is reproducible without the run that made it.

##### Acceptance Criteria

1. THE Snapshot_Builder SHALL include `snapshot_id`, `content_hash`, `run_id`,
   `subscription_id`, `collected_at` as a UTC instant in RFC 3339 form with a `Z` designator
   and whole-second precision, `timezone` as the IANA zone name, that zone's resolved UTC
   offset, `grain`, and the collection `window` as local start and end dates in `YYYY-MM-DD`
   form together with the UTC instants they resolved to in that same RFC 3339 form.
2. THE Snapshot_Builder SHALL include `scope_verified` as recorded on the connected
   subscription at invoke time.
3. THE Snapshot_Builder SHALL include, for every resource, the resource id, resource type,
   location, resource group, tags, `power_state` as both the `powerState.code` value the
   inventory projected and a normalized value drawn from a declared set that includes an
   unknown value, `fidelity_tier`, and the SKU capacity used as the SKU name, the
   `vCPUsAvailable` count and the memory capacity in bytes as a decimal string.
4. THE Snapshot_Builder SHALL include every collection_log entry as a typed `gaps` list, each
   entry carrying a `gap_type` drawn from the declared gap-type set, `resource_id`, `metric`
   where applicable, and a message, and SHALL exclude every registered secret value from every
   such message by applying the Redaction_Guard scrub to the snapshot before writing it.
5. THE Snapshot_Builder SHALL include the per-resource, per-metric statistics, each carrying the
   `statistic` name, the `value` as a decimal string, `unit`, `estimator`, `fidelity_tier`, and
   the number of samples that value was computed over.
6. WHEN the Snapshot_Builder writes a snapshot, THE Snapshot_Builder SHALL write that snapshot
   as a private object at
   `s3://<RPT_ARTIFACT_BUCKET>/<actor_id>/snapshots/<runId>/snapshot.json` using the run's
   `actor_id`, and SHALL tag that object with the owning actor id.
7. WHEN the Snapshot_Builder finishes writing, THE Agent_Runtime SHALL emit `snapshot_ready`
   carrying a `snapshot_id` equal to the written snapshot's `content_hash`, a resource count
   equal to the number of resources in that snapshot, the window, the grain and the gap list
   that snapshot carries.
8. THE Snapshot_Builder SHALL include a `schema_version` for the snapshot shape, the
   Agent_Runtime version that produced the snapshot, and the Metric_Catalog version the
   collection ran against, so that a later reader can tell which producer wrote the snapshot
   without consulting the run.
9. THE Snapshot_Builder SHALL include the run's requested scope as resolved, carrying the
   requested resource types, resource groups and tag filters, together with the metric names
   requested per resource type.
10. IF a per-resource, per-metric statistic was computed over zero samples, THEN THE
    Snapshot_Builder SHALL emit no value for that statistic and SHALL record a `no_samples` gap
    carrying that resource's id and the metric, so that an absent measurement is never
    serialized as zero.

---

### Section F — Run orchestration

#### Requirement 36: Postgres is the state machine

**User Story:** As an operator, I want the run row to be authoritative, so that a crashed
container is a recoverable state rather than a permanent one.

##### Acceptance Criteria

1. THE Run_State_Machine SHALL define `report_runs.status` with the values `queued`,
   `claimed`, `collecting`, `compiling`, `rendering`, `verifying`, `completed` and `failed`.
2. THE Run_State_Machine SHALL drive only the transitions `queued → claimed`,
   `claimed → collecting`, `collecting → completed`, `collecting → failed`, `queued → failed`
   and `claimed → failed` in this spec, SHALL restrict the three failure edges to the terminal
   codes criterion 36.6 declares, and SHALL leave `compiling`, `rendering` and `verifying`
   defined, undriven, and unreachable from every driven transition.
3. THE Run_State_Machine SHALL define the columns `id`, `user_id`, `connected_subscription_id`,
   `period_start`, `period_end`, `timezone`, `status`, `dedupe_key`, `claimed_at`, `claimed_by`,
   `updated_at`, `phase_deadline`, `error_code`, `error_message`, `progress_token_hash`,
   `progress_current`, `progress_total`, `progress_label`, `snapshot_id`, `resource_count`,
   `gap_count` and `created_at`, with `user_id` referencing `users.id` and
   `connected_subscription_id` referencing `connected_subscriptions.id`, and SHALL set
   `updated_at` to the write instant on every write that changes any other column of that row.
4. THE Run_State_Machine SHALL constrain `dedupe_key` to be UNIQUE and to carry a non-empty
   value on every `report_runs` row.
5. IF an enqueue is attempted with a `dedupe_key` that already exists, including the case of two
   concurrent inserts of one derived key where the database rejects the second, THEN THE
   Enqueue_Action SHALL return the existing run, SHALL insert no second row, and SHALL mint no
   second `progress_token`.
6. THE Run_State_Machine SHALL treat `report_runs` as the authoritative record of run state,
   SHALL constrain `error_code` on a row whose `status` is `failed` to a non-empty value drawn
   from `AUTH_EXPIRED`, `AUTH_FAILED`, `SCOPE_UNVERIFIED`, `SECRET_UNREADABLE`, `EMPTY_SCOPE`,
   `CATALOG_UNUSABLE`, `NO_STATISTICS`, `REGION_UNREACHABLE`, `THROTTLED` and `TIMEOUT`, and
   SHALL leave `error_code` empty on a row whose `status` is `completed`, so that a client
   reconstructs run state from that row rather than from a replayed event stream.
7. THE Web_App SHALL read a run's terminal state from `report_runs.status`,
   `report_runs.error_code` and `report_runs.error_message` in addition to reading events,
   because the `TIMEOUT` code is written by the Reaper with no event to carry it.
8. THE Run_State_Machine SHALL only add columns to `report_runs` in subsequent migrations,
   because these rows are the audit trail for delivered documents.
9. WHEN the Run_State_Machine writes a `status` of `queued`, `claimed` or `collecting` to a row,
   THE Run_State_Machine SHALL set that row's `phase_deadline` to the write instant plus 900
   seconds for `queued`, plus 300 seconds for `claimed`, and plus 1800 seconds for `collecting`,
   so that the `collecting` budget exceeds the 8-to-12-minute 99th-percentile run duration by at
   least 900 seconds.
10. WHEN the Web_App reads or writes a `report_runs` row on behalf of a signed-in user, THE
    Run_State_Machine SHALL restrict that operation to rows whose `user_id` equals that user's
    id.
11. IF a requested `report_runs` row's `user_id` differs from the signed-in user's id, THEN THE
    Run_State_Machine SHALL resolve that request as not found, SHALL apply no write, and SHALL
    disclose no field of that row, including its `status` and its `error_code`.
12. THE Run_State_Machine SHALL define `progress_current` and `progress_total` as nullable
    integers and `progress_label` as nullable text, and SHALL record no value in any of those
    three columns on a row whose `status` is `completed` or `failed`, so that a terminal row
    carries no stale in-flight count and the three columns are additive under criterion 36.8.

#### Requirement 37: Enqueue and return

**User Story:** As a consultant, I want submitting a run to return immediately, so that closing
the tab does not affect the run.

##### Acceptance Criteria

1. WHEN a consultant submits a run, THE Enqueue_Action SHALL insert a `report_runs` row carrying
   `status` `queued`, the signed-in user's id, the selected `connected_subscription_id`, the
   requested `period_start`, `period_end` and `timezone`, and a `dedupe_key` derived
   deterministically from those values together with the requested scope's sorted resource
   types, the requested scope's sorted resource groups and the enqueue instant truncated to a
   60-second boundary, drawing no random value into that derivation, and SHALL return.
2. THE Enqueue_Action SHALL hold no stream open, SHALL make no AgentCore invocation, SHALL make
   no Azure API call, SHALL await no operation other than its own input validation and its
   `report_runs` write, and SHALL return within 2 seconds of receiving a submission.
3. WHEN the Enqueue_Action inserts a run, THE Enqueue_Action SHALL derive that run's
   `progress_token` as the base64url encoding of an HMAC-SHA-256 computed over the fixed
   namespace label `progress-token` concatenated with that run's `id`, keyed by
   `APP_ENCRYPTION_KEY`, SHALL store the SHA-256 hash of that token in `progress_token_hash`,
   and SHALL store no column carrying the token itself, so that the process that later invokes
   the runtime recomputes the token rather than reading a stored plaintext.
4. THE Web_App SHALL route form-triggered and chat-triggered runs through the Enqueue_Action,
   so that every trigger shares one orchestration path.
5. THE Web_App SHALL define `RunView` as the only run shape crossing to the browser, carrying
   exactly `id`, `connectedSubscriptionId`, `status`, `errorCode`, `errorMessage`,
   `periodStart`, `periodEnd`, `timezone`, `resourceCount`, `gapCount`, `snapshotId`,
   `artifactKeys`, `createdAt` and `updatedAt`, with `artifactKeys` carrying S3 object keys
   only.
6. WHEN the projection function maps a run row, THE projection SHALL omit
   `progress_token_hash`, `claimed_by` and `dedupe_key`.
7. IF the JSON serialization of a `RunView` contains the test fixture's `progress_token_hash`
   value, THEN THE Projection_Guard SHALL fail.
8. WHEN the Web_App receives an artifact download request whose key's `actor_id` prefix equals
   the signed-in user's id and whose run's `user_id` equals that same id, THE Web_App SHALL mint
   a presigned URL whose expiry is at most 300 seconds, SHALL store no presigned URL, and SHALL
   exclude every presigned URL from every cacheable payload and from every server-rendered
   payload.
9. IF a submitted run's selected `connected_subscriptions` row carries a `user_id` other than the
   signed-in user's id, or carries a `status` other than `active`, THEN THE Enqueue_Action SHALL
   reject the submission, SHALL insert no `report_runs` row, and SHALL mint no `progress_token`.
10. IF a submitted run's `period_start` is after its `period_end`, the count of local days from
    `period_start` to `period_end` inclusive is below 1 or above 31, or `period_end` is after the
    current local date in that run's `timezone`, THEN THE Enqueue_Action SHALL reject the
    submission, SHALL insert no `report_runs` row, and SHALL state the accepted range as 1 to 31
    local days ending at or before the current local date.
11. WHEN the Projection_Guard runs, THE Projection_Guard SHALL assert the exact sorted key set of
    a projected `RunView` and SHALL assign a distinct non-empty value to `progress_token_hash`,
    `claimed_by` and `dedupe_key` in its `report_runs` fixture, so that a newly added
    `report_runs` column cannot reach the browser without an explicit test change.
12. IF an artifact download request's key `actor_id` prefix differs from the signed-in user's id,
    or that run's `user_id` differs from that id, THEN THE Web_App SHALL resolve the request as
    not found and SHALL mint no presigned URL.

> **Rejected design, recorded so it is not reinvented.** An earlier design had the enqueue
> action consume the `generate_report` SSE stream server-side so the run would survive the
> user closing the tab. Surviving a closed tab is not the hard case. That consumer still dies
> on a Next.js restart, a deploy roll or a request timeout, and the row then sits in
> `collecting` forever because nothing sweeps it. Making a long-held HTTP stream the source of
> truth is the fragility, not the fix.

#### Requirement 38: The agent advances its own state

**User Story:** As an operator, I want each phase transition persisted by a short request, so
that run state does not depend on a stream staying open for twelve minutes.

##### Acceptance Criteria

1. WHEN the Agent_Runtime enters a new phase, THE Progress_Reporter SHALL send a POST to the
   `progress_url` supplied in the invoke context, carrying the run id, the entered phase name,
   the terminal fields criterion 38.12 declares for a terminal phase, and, where the entered
   phase carries a countable unit of work, that phase's current progress count, that phase's
   progress total and that phase's progress label.
2. WHEN the Progress_Reporter sends a phase transition, THE Progress_Reporter SHALL present the
   run-scoped `progress_token` from the invoke context in a request header, and SHALL exclude
   that token from the request target and from the request body.
3. IF a Progress_Reporter request fails to complete within 5 seconds, returns a status other
   than success, or raises, THEN THE Progress_Reporter SHALL retry that request at most once,
   SHALL record that failure in a log line with the token excluded, and SHALL allow the run to
   continue.
4. THE Progress_Reporter SHALL raise no exception that ends a run, because the Reaper is the
   backstop for a callback that never arrived.
5. WHEN the Progress_Endpoint receives a transition, THE Progress_Endpoint SHALL validate the
   presented token against the stored `progress_token_hash` for that run using a constant-time
   comparison.
6. IF a presented progress token does not validate, or the named run id matches no `report_runs`
   row, THEN THE Progress_Endpoint SHALL reject the request with one response identical for both
   cases, SHALL apply no transition, and SHALL disclose no field of any row.
7. WHEN the Progress_Endpoint applies a valid transition, THE Progress_Endpoint SHALL update
   `status` and `updated_at`, SHALL set `phase_deadline` to the entered phase's budget declared
   in criterion 36.9, SHALL write each of `progress_current`, `progress_total` and
   `progress_label` the request presents where the entered status is non-terminal, and SHALL
   return within 2 seconds without awaiting an AgentCore call, an S3 request or an Azure
   request.
8. WHEN a run reaches a terminal state, THE Progress_Endpoint SHALL reject every subsequent
   transition for that run, including a repeat of the terminal status that run already carries,
   and SHALL apply no write to that row.
9. THE Web_App SHALL exclude the `progress_token` value from every event, log line, persisted
   message and projection.
10. IF a presented target phase is neither the row's current `status` nor a status reachable from
    that `status` under the transitions criterion 36.2 declares driven, THEN THE
    Progress_Endpoint SHALL reject the request with the response criterion 38.6 declares, SHALL
    apply no write to that row, and SHALL disclose no field of that row, so that a replayed or
    out-of-order callback cannot move a run backwards.
11. IF a transition presents the `error_code` `TIMEOUT`, or targets `failed` while presenting an
    `error_code` absent from the set criterion 36.6 declares, THEN THE Progress_Endpoint SHALL
    reject the request and SHALL apply no write, because the Reaper is the only writer of
    `TIMEOUT`.
12. WHEN the Progress_Endpoint applies a valid transition to a terminal status, THE
    Progress_Endpoint SHALL record that transition's terminal fields, being `error_code` and
    `error_message` for `failed` and `snapshot_id`, `resource_count` and `gap_count` for
    `completed`, SHALL clear `phase_deadline`, `progress_current`, `progress_total` and
    `progress_label`, and SHALL exclude the presented `progress_token` from every column it
    writes.
13. WHERE a presented target phase equals the row's current `status` and that `status` is
    non-terminal, THE Progress_Endpoint SHALL apply no `status` change, SHALL write each of
    `progress_current`, `progress_total` and `progress_label` the request presents, SHALL set
    `updated_at` to the write instant, and SHALL set `phase_deadline` to that phase's budget
    declared in criterion 36.9, so that a progress refresh inside one phase is persisted rather
    than discarded as a repeated transition.
14. IF a presented current progress count is below the `progress_current` value already stored
    for that run while that row's `status` equals the presented target phase, THEN THE
    Progress_Endpoint SHALL leave `progress_current`, `progress_total` and `progress_label`
    unchanged and SHALL apply the remainder of that request as criterion 38.13 declares, because
    criterion 14.8 requires successive progress values for one step to be non-decreasing and a
    retried callback can arrive out of order.
15. WHILE a phase carrying a countable unit of work is in progress, THE Progress_Reporter SHALL
    send at most 1 progress callback per 5 seconds for that phase, SHALL send every phase
    transition callback at the instant that transition occurs irrespective of that limit, and
    SHALL send the callback for a terminal phase irrespective of that limit, so that a run over a
    few hundred resources issues a bounded count of short requests rather than one request per
    folded batch.

#### Requirement 39: The reaper

**User Story:** As an operator, I want a crashed container's run to be failed automatically, so
that a stuck row does not page me at three in the morning.

##### Acceptance Criteria

1. WHEN the Reaper receives a request, THE Reaper SHALL compare the presented bearer secret
   against `RPT_CRON_SECRET` using a comparison over equal-length digests of the two values
   whose duration is independent of the number of leading characters that match, so that the
   comparison discloses neither a matching prefix nor the secret's length.
2. IF `RPT_CRON_SECRET` is unset or empty, THEN THE Reaper SHALL reject every request.
3. IF a presented bearer secret is absent, is empty, is malformed, or does not match, THEN THE
   Reaper SHALL reject the request, SHALL claim no work, and SHALL apply no write to any
   `report_runs` row, including no `TIMEOUT` write.
4. WHEN the Reaper claims due work, THE Reaper SHALL select `queued` rows with
   `FOR UPDATE SKIP LOCKED`, ordered by `created_at` ascending, limited to 10 rows, and SHALL set
   those rows to `claimed` with `claimed_at`, `claimed_by`, `updated_at` and `phase_deadline` in
   the same statement, setting `claimed_by` to an identifier unique to that one Reaper request.
5. WHEN two Reaper requests overlap, THE Reaper SHALL claim disjoint sets of rows.
6. WHEN the Reaper has claimed a row, THE Reaper SHALL initiate the AgentCore invocation for that
   row, SHALL leave the returned event stream unread and release it, and SHALL return without
   waiting for that run to finish.
7. WHEN the Reaper runs, THE Reaper SHALL set every row whose `status` is `queued`, `claimed` or
   `collecting` and whose `phase_deadline` is before the current instant to `status` `failed`
   with `error_code` `TIMEOUT` and an `error_message` naming the phase that expired, limited to
   100 rows per request.
8. THE Reaper SHALL be the only writer of the `TIMEOUT` code, because a timed-out run's
   container may already be gone.
9. WHEN the Reaper completes a request, THE Reaper SHALL return a response within 10 seconds of
   receiving that request and SHALL await no run's completion.
10. WHEN the Reaper claims a row whose `connected_subscriptions` row carries `scope_verified`
    false or carries a `secret_expires_at` at or before the current instant, THE Reaper SHALL set
    that run to `status` `failed` with `error_code` `SCOPE_UNVERIFIED` for the unverified case and
    `AUTH_EXPIRED` for the expired case, and SHALL make no AgentCore invocation for that run.
11. WHEN the Reaper receives an authorized request, THE Reaper SHALL apply the `phase_deadline`
    sweep of criterion 39.7 before it claims `queued` rows, within that same request, and SHALL
    exclude every row that sweep set to `failed` from that request's claim.
12. WHILE the Web_App is deployed, THE Web_App SHALL schedule a Reaper request at an interval of
    at most 60 seconds, so that the 900-second `queued` budget of criterion 36.9 tolerates at
    least 14 consecutive missed requests before a queued run is failed as `TIMEOUT`.
13. IF an invocation fails to start or returns no response stream within 10 seconds, THEN THE
    Reaper SHALL record that failure in a log line excluding every secret, SHALL leave that row
    at `claimed` for the deadline sweep, and SHALL continue initiating the invocations for the
    remaining claimed rows.

#### Requirement 40: The SSE relay is cosmetic

**User Story:** As a consultant watching a run, I want a dropped connection to cost me nothing,
so that a proxy timeout is an inconvenience rather than a lost run.

##### Acceptance Criteria

1. THE SSE_Relay SHALL declare `export const runtime = "nodejs"`.
2. WHEN the SSE_Relay responds, THE SSE_Relay SHALL set `Content-Type` to `text/event-stream`,
   `Cache-Control` to `no-cache, no-transform`, and `X-Accel-Buffering` to `no`.
3. IF 120 consecutive seconds elapse in which the SSE_Relay emits no event other than a
   `heartbeat`, THEN THE SSE_Relay SHALL close the stream, because the relay is a live view whose
   loss costs nothing and a shorter-lived intermediary window is survivable by reconnection.
4. WHEN a client reconnects to the SSE_Relay, THE Web_App SHALL reconstruct the displayed run
   state from that run's `report_runs` row `status`, `error_code`, `error_message`,
   `resource_count`, `gap_count` and `snapshot_id`, together with the stored gap list, and SHALL
   request no event replay from the Agent_Runtime.
5. THE SSE_Relay SHALL carry no state that cannot be reconstructed from the `report_runs` row and
   the stored gap list, and SHALL emit no event whose payload draws on a value absent from those
   two sources.
6. IF the Web_App receives an event whose type is absent from the declared event vocabulary,
   THEN THE Web_App SHALL ignore that event, SHALL apply no state change for it, and SHALL
   continue processing the stream.
7. THE Web_App SHALL mirror the event vocabulary between `app/lib/events.ts` and
   `agent/src/reporting_agent/events.py`, so that one vocabulary is expressed in two
   languages.
8. THE Web_App SHALL parse the event stream in a hook that maps events to UI state, keeping the
   presentation components free of parsing.
9. IF a request to the SSE_Relay presents no valid session, or names a run whose `report_runs`
   row's `user_id` differs from the signed-in user's id, THEN THE SSE_Relay SHALL resolve that
   request as not found, SHALL open no stream, and SHALL disclose no field of that row.
10. WHEN the SSE_Relay streams a run, THE SSE_Relay SHALL derive every event it emits from that
    run's `report_runs` row and stored gap list, polling that row at an interval of 2 seconds,
    SHALL emit a `heartbeat` event at an interval of 15 seconds while that row is non-terminal,
    SHALL emit a `progress` event whose `done` field takes its value from that row's
    `progress_current`, whose `total` field takes its value from that row's `progress_total` and
    whose `label` field takes its value from that row's `progress_label` while that row is
    non-terminal and both `progress_current` and `progress_total` carry a value, and SHALL make no
    AgentCore invocation, because the invocation was initiated by the Reaper in a separate request
    that has already returned.
11. WHEN the SSE_Relay closes a stream while that run's `status` is non-terminal, THE Web_App
    SHALL open a new stream for that run within 5 seconds and SHALL reconstruct the displayed
    state from the row before rendering.
12. WHEN a run's `status` is terminal, THE SSE_Relay SHALL emit that terminal state, SHALL close
    the stream, and THE Web_App SHALL open no further stream for that run.
13. IF the declared event-type set in `app/lib/events.ts` differs from the declared event-type set
    in `agent/src/reporting_agent/events.py`, THEN THE Boundary_Guard SHALL fail.
14. IF a polled `report_runs` row's `progress_current` carries no value, or that row's
    `progress_total` carries no value, THEN THE SSE_Relay SHALL emit no `progress` event for that
    poll, so that a phase carrying no countable work produces no determinate progress bar.
15. WHEN the SSE_Relay emits a `progress` event, THE SSE_Relay SHALL carry exactly the field names
    `id`, `done`, `total`, `unit` and `label` that criterion 14.8 declares, SHALL set `id` from
    that row's `status`, SHALL set `unit` from the unit that phase declares in `app/lib/events.ts`
    as a per-phase constant rather than as run state, and SHALL keep successive `done` values for
    one `id` non-decreasing, so that the relay renames no field of the declared event vocabulary,
    adds none, and stays reconstructible from the row as criterion 40.5 requires.

#### Requirement 41: Invocation contract and secret resolution

**User Story:** As a security reviewer, I want the customer's credentials resolved server-side
at invoke time, so that no browser ever holds one.

##### Acceptance Criteria

1. WHEN the Web_App invokes the runtime, THE Web_App SHALL read the runtime ARN from
   `process.env.RPT_RUNTIME_ARN` at call time.
2. IF `RPT_RUNTIME_ARN` is unset or empty, THEN THE Web_App SHALL raise a typed configuration
   error and SHALL make no SDK call.
3. WHEN the Web_App builds an invoke payload, THE Web_App SHALL resolve `tenant_id`,
   `client_id` and the decrypted client secret from the `connected_subscriptions` row on the
   server.
4. THE Web_App SHALL accept no value for `tenant_id`, `client_id` or `client_secret` from a
   browser request.
5. WHEN the Web_App builds an invoke payload, THE Web_App SHALL include `actor_id`,
   `subscription_id`, `tenant_id`, `client_id`, `client_secret`, `timezone`, `display_name`,
   `fidelity_tier`, `log_analytics_workspace_id`, `run_id`, `progress_url` and `progress_token`
   in the `context`, SHALL read each of those values from that run's `report_runs` row or from
   its `connected_subscriptions` row, SHALL default `timezone` to `Asia/Jakarta`, and SHALL
   include no further field in that `context`.
6. WHEN the Web_App builds `progress_url`, THE Web_App SHALL derive that URL from
   `RPT_APP_BASE_URL`.
7. WHEN the Web_App invokes the runtime, THE Web_App SHALL send `accept` as
   `text/event-stream`, SHALL pass the `runtimeSessionId` the Session_Id_Module derives from
   that run's id, and SHALL treat an invocation that returns no response stream within 10
   seconds as a failure to start.
8. WHEN the Web_App invokes the runtime for a run, THE Web_App SHALL send a payload carrying
   `command` `generate_report`, `period` as that run's local `period_start` and `period_end`
   dates, and `scope` as that run's requested resource types and resource groups, and SHALL
   include no `prompt` field, so that the deterministic pipeline is reachable without a model
   decision.
9. IF a run's `report_runs` row carries a `status` other than `claimed` when the Web_App builds
   an invoke payload for that run, THEN THE Web_App SHALL make no SDK call for that run, so that
   a retried tick cannot invoke one run twice.
10. IF the decryption of a subscription's `client_secret_enc` fails while the Web_App builds an
    invoke payload, THEN THE Web_App SHALL make no SDK call, SHALL set that run to `status`
    `failed` with `error_code` `SECRET_UNREADABLE`, and SHALL exclude the ciphertext and the key
    material from that run's `error_message`.
11. WHEN the Web_App builds an invoke payload, THE Web_App SHALL set `actor_id` to the `user_id`
    of that run's `report_runs` row, so that the artifact prefix the runtime writes under is the
    prefix the download authorization of criterion 37.8 compares against.

---

### Correctness Properties

Executable, falsifiable properties. Web properties use **fast-check** under Vitest; agent
properties use **hypothesis** under pytest. Every property below runs at **100 or more
generated cases minimum**, and each is written so that it **fails on the naive implementation**
it exists to rule out.

#### Requirement 42: Property-based verification

**User Story:** As a reviewer, I want the collector's correctness claims to be machine-checked
across generated inputs, so that the properties this product depends on are not maintained by
review alone.

##### Acceptance Criteria

1. THE Web_App SHALL execute every web-side property in this section with `fast-check` at a
   minimum of 100 generated cases per property, in the test suite that runs before a change in
   this spec is committed.
2. THE Agent_Runtime SHALL execute every agent-side property in this section with `hypothesis`
   at a minimum of 100 generated examples per property, in the test suite that runs before a
   change in this spec is committed.
3. IF a web-side property fails, THEN THE Web_App SHALL report the shrunk counterexample
   `fast-check` returns for that failure together with the seed that reproduces that failure, so
   that the failure is re-runnable without regenerating cases.
4. IF an agent-side property fails, THEN THE Agent_Runtime SHALL report the shrunk
   counterexample `hypothesis` returns for that failure together with the seed that reproduces
   that failure, so that the failure is re-runnable without regenerating examples.
5. THE Web_App SHALL keep `pnpm lint` and `pnpm typecheck` clean, and THE Agent_Runtime SHALL
   keep its linter clean, before any change in this spec is committed.
6. IF an agent-side property in this section is skipped, is marked as an expected failure,
   declares fewer than 100 generated examples, has its example generation reported as exhausted
   before 100 examples are accepted, or rejects more than 20 percent of its generated examples
   through a precondition, THEN THE Agent_Runtime SHALL fail its test suite, so that a property
   whose preconditions discard nearly every generated input cannot pass by testing almost
   nothing.
7. IF a web-side property in this section is skipped, is marked as an expected failure, declares
   fewer than 100 generated cases, has its case generation reported as exhausted before 100
   cases are accepted, or rejects more than 20 percent of its generated cases through a
   precondition, THEN THE Web_App SHALL fail its test suite.
8. WHEN a defect exposed by a failing property in this section is fixed, THE Agent_Runtime SHALL
   retain that failure's shrunk counterexample as an explicitly declared example that runs on
   every subsequent execution of that agent-side property, and THE Web_App SHALL retain that
   failure's shrunk counterexample as an explicitly declared case that runs on every subsequent
   execution of that web-side property.

#### Property 1 — Count-weighted aggregation (agent, hypothesis)

*Invariant / model-based.* Generate a list of sample values and an arbitrary partition of that
list into buckets of unequal size, then fold each bucket's `{sum, count, min, max}` through the
Accumulator.

##### Acceptance Criteria

1. FOR ALL non-empty generated sample lists and ALL partitions of those lists into buckets, THE
   Accumulator SHALL produce an average equal to the arithmetic mean of the underlying samples
   computed at the working precision of criterion 27.11 and quantized to exactly 6 decimal
   places with rounding half to even.
2. FOR ALL non-empty sample lists and ALL partitions, the Accumulator's minimum SHALL equal the
   minimum of the underlying samples exactly, and the Accumulator's maximum SHALL equal the
   maximum of the underlying samples exactly.
3. WHEN the agent test suite runs, THE Agent_Runtime SHALL include an explicitly declared case in
   which one bucket carries 3 samples and another bucket carries 60 samples and the arithmetic
   mean of the per-bucket averages differs from the count-weighted mean by at least 0.001, and an
   explicitly declared case of 744 buckets in which the first 700 buckets carry a count of 0 and
   the remaining 44 carry 60 samples each, so that the property fails against an implementation
   that averages the per-interval averages at a month boundary and for a recently created
   virtual machine.
4. FOR ALL partitions of one generated sample list and ALL orders of folding the buckets of that
   partition, THE Accumulator SHALL produce identical average, minimum and maximum values, and
   FOR ALL pairs of distinct partitions of the same generated sample list, THE Accumulator SHALL
   produce identical average, minimum and maximum values, so that the result depends on the
   samples rather than on how those samples were bucketed.
5. WHEN the agent test suite generates a case for this property, THE Agent_Runtime SHALL draw
   each sample as a `Decimal` carrying at most 6 decimal places from the inclusive range 0 to 100
   for a percentage metric and from the inclusive range 0 to 1000000000000000 for a byte, IOPS or
   throughput metric, SHALL draw each bucket's sample count from the inclusive range 0 to 60, and
   SHALL draw the bucket count from the inclusive range 1 to 744, being the hourly slot count of
   a 31-day window.
6. FOR ALL generated partitions containing at least one bucket whose count is 0, THE Accumulator
   SHALL produce the same average, minimum and maximum as the same partition with every
   zero-count bucket removed, so that the property fails against an implementation that divides
   the summed totals by the number of buckets rather than by the summed counts.
7. IF every bucket in a generated partition carries a count of 0, THEN THE Accumulator SHALL
   produce no average, no minimum and no maximum for that series, so that the property fails
   against an implementation that reports 0 for a series carrying no samples.

#### Property 2 — JCS canonicalization stability (agent, hypothesis)

*Invariant / round-trip.* Generate a snapshot structure, then generate permutations of its key
insertion order and equivalent nesting orders.

##### Acceptance Criteria

1. FOR ALL generated snapshot structures and ALL of at least 10 generated permutations of the key
   insertion order of each object in those structures, THE Snapshot_Builder SHALL produce a
   byte-identical JCS canonical form.
2. FOR ALL pairs of generated snapshot structures that are equal under a comparison ignoring
   object key order, THE Snapshot_Builder SHALL produce identical `content_hash` values.
3. FOR ALL snapshot structures, the `content_hash` SHALL be unchanged by the presence or
   absence of the `content_hash` field in the input, because that field is excluded from the
   canonicalized input.
4. FOR ALL generated snapshot structures, THE Agent_Runtime SHALL produce the same `content_hash`
   digest when computing that digest in two separate operating-system processes started from the
   same commit with different interpreter hash-randomization seeds, so that the property fails
   against an implementation whose ordering depends on in-process hash randomization.
5. FOR ALL generated snapshot structures, THE Snapshot_Builder SHALL produce a canonical form in
   which every JSON number token is an integer token containing no `.`, no `e` and no `E`, so
   that the property fails against an implementation that serializes a metric value as a
   `float`.
6. WHEN the agent test suite generates a snapshot structure for this property, THE Agent_Runtime
   SHALL draw object keys and string values from an alphabet including ASCII characters, at least
   one character outside the Basic Multilingual Plane, at least one pair of keys differing only
   by letter case, and at least one string requiring JSON escaping, SHALL nest objects and arrays
   to a depth of at least 4, and SHALL include one empty object and one empty array, so that the
   property fails against an implementation that orders keys by Unicode code point rather than by
   UTF-16 code unit.
7. WHEN the agent test suite generates a snapshot structure for this property, THE Agent_Runtime
   SHALL include the metric value decimal strings `9007199254740993`, `0.1`,
   `0.30000000000000004` and one value carrying 17 significant digits, so that the property fails
   against an implementation that round-trips a metric value through a binary floating-point
   number.
8. FOR ALL pairs of generated snapshot structures differing in any value, in any key spelling
   including two spellings differing only by Unicode normalization form, or in the presence of a
   field named `content_hash` nested below the top level, THE Snapshot_Builder SHALL produce
   `content_hash` values that differ, so that the property fails against an implementation that
   applies Unicode normalization or removes every field named `content_hash` at every depth.

#### Property 3 — Sketch quantile error bounds (agent, hypothesis)

*Metamorphic.* Generate sample streams, fold them into the Sketch, and compare each estimated
quantile against the quantile computed exactly from the retained samples.

##### Acceptance Criteria

1. FOR ALL generated sample streams of `Decimal` values carrying at most 6 decimal places drawn
   from the inclusive range 0 to 100, and ALL quantiles drawn from the inclusive range 0 to 1
   together with the declared quantiles 0.5, 0.9, 0.95, 0.99 and 1, THE Sketch SHALL return a
   fixed-histogram estimate differing from the exact quantile by at most 0.5 percentage points
   absolute, where the exact quantile for a quantile q over n ascending sorted samples is the
   sample at the 1-based rank equal to the ceiling of q multiplied by n, and the exact quantile
   for a q of 0 is the first sample of that sorted order.
2. FOR ALL generated sample streams of `Decimal` values drawn from the inclusive range 0 to
   1000000000000000, including streams containing exact zeros, and ALL quantiles drawn from the
   inclusive range 0 to 1, THE Sketch SHALL return a DDSketch estimate differing from the exact
   quantile defined in criterion 3.1 by at most 1 percent relative where that exact quantile is
   greater than 0, and differing by exactly 0 where that exact quantile is 0.
3. FOR ALL generated sample streams, THE Sketch SHALL hold at most the 200 fixed-histogram bins
   and at most the 2048 DDSketch buckets that criterion 28.3 declares, and SHALL produce a
   serialized size that does not vary with the number of samples folded.
4. FOR ALL pairs of generated sample streams, THE Sketch SHALL produce identical bin counts,
   identical bucket counts, an identical retained minimum and an identical retained maximum when
   stream A is folded before stream B and when stream B is folded before stream A, and SHALL
   therefore produce a byte-identical serialized form under both orders (confluence).
5. FOR ALL generated sample streams, THE Sketch SHALL return an estimate for a quantile of 0
   equal to the exact observed minimum and an estimate for a quantile of 1 equal to the exact
   observed maximum that criterion 28.10 requires it to retain, and FOR ALL pairs of quantiles q1
   and q2 where q1 is at most q2, THE Sketch SHALL return an estimate for q1 at most the estimate
   for q2.
6. WHEN the agent test suite runs, THE Agent_Runtime SHALL include an explicitly declared sample
   stream in which 90 percent of the samples equal 5 and 10 percent equal 95, whose arithmetic
   mean is 14 and whose exact quantile at 0.95 is 95, and SHALL assert that the fixed histogram's
   estimate at a quantile of 0.95 is at least 94.5, so that the property fails against an
   implementation that estimates a percentile from an interval mean.
7. WHEN the agent test suite runs, THE Agent_Runtime SHALL include an explicitly declared sample
   stream of at least 44640 samples, being the `PT1M` sample count of a 31-day window, and SHALL
   assert the bin count, the bucket count and the serialized size bounds of criterion 3.3 over
   that stream, so that the property fails against an implementation that retains the folded
   samples.
8. FOR ALL generated sample streams containing at least one exact zero, THE Sketch SHALL route
   every exact zero to the dedicated zero bucket that criterion 28.11 declares and SHALL include
   those zeros in the rank underlying every quantile estimate, and FOR a generated stream whose
   every sample is an exact zero, THE Sketch SHALL return an estimate of exactly 0 for every
   quantile in the inclusive range 0 to 1.

#### Property 4 — Points-budget batch sizing (agent, hypothesis)

*Invariant / metamorphic.* Generate resource sets with varying metric counts and expected
points per metric, then run the batch planner and the adaptive-halving loop.

##### Acceptance Criteria

1. FOR ALL generated resource sets, THE Metrics_Collector SHALL emit batches whose estimated
   point count is at most the points budget of 20000 that criterion 23.2 declares, except for a
   batch containing exactly one resource, and SHALL emit no batch containing zero resources.
2. FOR ALL generated resource sets, THE Metrics_Collector SHALL emit batches whose union equals
   the input resource set exactly, containing no duplicate resource and omitting no resource, and
   SHALL emit the same batches in the same order for two planning passes over the same input.
3. FOR ALL generated resource sets and ALL generated sequences of oversized-response rejections,
   THE Metrics_Collector SHALL complete the adaptive-halving loop within a request count at most
   the ceiling of the base-2 logarithm of the initial batch size plus 1, and SHALL keep every
   retried batch at a size of at least one resource.
4. FOR ALL generated resource sets, THE Metrics_Collector SHALL emit batches each of whose
   resources share a single `(subscription, location, resource_type)` key.
5. FOR ALL generated resource sets whose total estimated point count exceeds 20000, THE
   Metrics_Collector SHALL emit more than one batch, and for the declared case of 50 resources
   carrying 6 metrics at 720 hourly points each, being 216000 points, THE Metrics_Collector SHALL
   emit at least 11 batches, so that the property fails against an implementation that sizes a
   batch by the documented 50-resource cap.
6. WHEN the agent test suite generates a resource set for this property, THE Agent_Runtime SHALL
   draw the resource count from the inclusive range 1 to 500, the metric count per resource from
   the inclusive range 1 to 8, the expected points per metric from the inclusive range 1 to 2976,
   being the slot count of a 31-day window at a grain drawn only from `PT1H` and `PT15M` as
   criterion 25.8 restricts, the distinct location count from the inclusive range 1 to 10, and the
   distinct resource-type count from the inclusive range 1 to 3.
7. FOR ALL generated resource sets containing a resource whose own metric count multiplied by its
   expected points per metric exceeds 20000, THE Metrics_Collector SHALL emit that resource in a
   batch containing exactly that one resource, so that the property fails against an
   implementation that discards a resource it cannot fit inside the points budget.
8. IF a generated rejection sequence rejects a batch containing exactly one resource, THEN THE
   Metrics_Collector SHALL stop halving that batch, SHALL record a typed collection_log gap for
   that resource, and SHALL issue no further request for that batch, so that the property fails
   against an implementation whose halving reaches a batch size of zero.

#### Property 5 — The redaction guard (agent hypothesis, web fast-check)

*Invariant.* Generate secret values, then generate events, log records and persisted messages
that embed those secrets in nested structures, formatted strings and exception text.

##### Acceptance Criteria

1. FOR ALL generated `client_secret` values and ALL generated event structures embedding those
   values, THE Redaction_Guard SHALL replace every occurrence of that `client_secret` value with
   the fixed placeholder before that event leaves the process.
2. FOR ALL generated `progress_token` values and ALL generated event structures embedding those
   values, THE Redaction_Guard SHALL replace every occurrence of that `progress_token` value with
   the fixed placeholder before that event leaves the process.
3. FOR ALL generated secret values embedded in an object nested at a depth of at least 3 and in
   an array nested at a depth of at least 3, THE Redaction_Guard SHALL replace every occurrence
   of that value at every depth, so that the property fails against an implementation that scrubs
   only the top level of an event.
4. FOR ALL generated secret values embedded in exception text, THE Redaction_Guard SHALL place
   the fixed placeholder rather than the secret in the text reaching an `error` event.
5. FOR ALL generated secret values, THE Redaction_Guard SHALL produce a presence-only logging
   representation of that secret containing no character of that secret.
6. FOR ALL generated secret values and ALL generated log records embedding those values, THE
   Redaction_Guard SHALL emit the record through the installed logging filter carrying the fixed
   placeholder rather than the secret.
7. FOR ALL generated texts containing no registered secret value, THE Redaction_Guard SHALL leave
   that text unchanged, and FOR ALL secret values registered for an earlier invocation whose
   terminal event has been emitted, THE Redaction_Guard SHALL leave a later invocation's text
   containing that earlier value unchanged, as criterion 15.10 requires.
8. WHEN the agent test suite generates a secret value for this property, THE Agent_Runtime SHALL
   draw that value from the inclusive length range 8 to 128 characters over an alphabet including
   the regular-expression metacharacters `.`, `*`, `+`, `?`, `(`, `)`, `[`, `]`, `{`, `}`, `|`,
   `^`, `$` and `\`, and SHALL include one 40-character value shaped like an Azure client secret
   and one 43-character base64url value, so that the property fails against an implementation
   that interpolates a secret into a pattern without escaping that secret.
9. FOR ALL generated values whose length is in the inclusive range 0 to 7, THE Redaction_Guard
   SHALL register no pattern for that value as criterion 15.9 requires, SHALL leave the
   surrounding text of every emitted event and every log record unchanged, and SHALL insert no
   placeholder into that text, so that the property fails against an implementation whose empty or
   one-character pattern inserts the placeholder between the characters of ordinary output.
10. FOR ALL generated event structures carrying a field named `client_secret`, `progress_token`,
    `tenant_id` or `client_id` in snake_case, in camelCase, or in any mixture of upper-case and
    lower-case letters, at a nesting depth drawn from the inclusive range 1 to 4 inside objects
    and arrays, THE Web_App SHALL relay an event from which that field is absent, so that the
    property fails against an implementation matching only the snake_case spelling at the top
    level of the event.

#### Property 6 — Local-day bucketing at UTC+07:00 (agent, hypothesis)

*Invariant.* Generate hourly timestamps spanning month boundaries and assign them to local
days at the DST-free `Asia/Jakarta` offset.

##### Acceptance Criteria

1. FOR ALL generated hourly instants and ALL generated local date ranges, THE Bucketer SHALL
   assign each instant to the local day containing that instant at the run timezone's UTC offset.
2. WHEN the agent test suite runs, THE Agent_Runtime SHALL include generated instants in each of
   the UTC hours 17:00 through 23:59 for a run at the `Asia/Jakarta` offset of UTC+07:00, for
   which the local day is the UTC day plus one, and generated instants in each of the UTC hours
   00:00 through 04:59 for a run at an offset of UTC−05:00, for which the local day is the UTC day
   minus one, so that the property fails against an implementation that buckets by the UTC day.
3. FOR ALL generated local date ranges, THE Bucketer SHALL assign every instant in the half-open
   window that criterion 25.7 declares, being the start instant included and the end instant
   excluded, to exactly one local-day bucket, SHALL assign the start instant to a bucket, and
   SHALL assign the end instant to no bucket, so that the property fails against an
   implementation that includes the end instant.
4. FOR ALL generated local date ranges, THE Bucketer SHALL emit exactly 24 hourly slots for every
   full local day at the `PT1H` grain and exactly 96 slots for every full local day at the `PT15M`
   grain, and SHALL retain every partial edge day as a bucket whose contributing slot count
   required by criterion 25.11 equals the number of slots folded into that bucket, being in the
   inclusive range 1 to 23 at `PT1H` and 1 to 95 at `PT15M`, so that the property fails against an
   implementation that discards a partial edge day.
5. FOR ALL generated timezones whose UTC offset is not a whole number of hours, THE
   Metrics_Collector SHALL select the grain `PT15M`, FOR ALL generated timezones whose UTC offset
   is a whole number of hours THE Metrics_Collector SHALL select the grain `PT1H`, and FOR ALL
   generated timezones THE Metrics_Collector SHALL select a grain drawn only from `PT1H` and
   `PT15M` as criterion 25.8 restricts, so that the property fails against a selector that returns
   `P1D` or `PT1M`.
6. FOR ALL generated local date ranges, THE Bucketer SHALL yield the original local date when
   converting a local start date to its UTC instant and that UTC instant back to a local date, and
   SHALL resolve that range's exclusive end instant to the start instant of the local day
   following that range's last local day.
7. WHEN the agent test suite generates a case for this property, THE Agent_Runtime SHALL draw the
   run timezone from a declared set of fixed-offset zones including the whole-hour offsets
   UTC+07:00, UTC+00:00, UTC+14:00, UTC−05:00 and UTC−11:00 and the non-whole-hour offsets
   UTC+05:45, UTC+05:30, UTC+08:45 and UTC−09:30, and SHALL draw the local date range from the
   inclusive range 1 to 31 local days including the range 2026-07-01 through 2026-07-31 and a
   range spanning 2028-02-28 through 2028-03-01, so that the property fails against an
   implementation that adds a positive offset and mishandles a negative one.
8. FOR ALL generated local date ranges, THE Bucketer SHALL emit a bucket count equal to the number
   of local days in that range, being exactly 31 for the range 2026-07-01 through 2026-07-31 and
   exactly 1 for a range of one local day, so that the property fails against an implementation
   whose exclusive end instant adds a further bucket.
9. FOR the declared case of the local date range 2026-07-01 through 2026-07-31 at the UTC+07:00
   offset, THE Bucketer SHALL resolve the requested UTC window to the start instant
   2026-06-30T17:00Z included and the end instant 2026-07-31T17:00Z excluded, so that the property
   fails against an implementation that requests 2026-07-01T00:00Z through 2026-07-31T23:59Z.

---

## Traceability — `azure-integration.md` guardrails checklist

Every item in that document's closing checklist that this spec touches, mapped to the
acceptance criteria that make it testable.

| Guardrail | Criteria |
|---|---|
| `scope_verified` asserted by preflight; `false` blocks the run | 12.1, 12.2, 12.3, 12.4, 12.5, 12.6 |
| A run whose union of scopes resolves to zero raises `EMPTY_SCOPE`; never renders | 33.1, 33.2, 33.3 |
| A single block resolving to zero is not a failure | Out of scope — no blocks in this spec; the union gate is scoped in 33.2 |
| `secret_expires_at` tracked and surfaced; expiry is `AUTH_EXPIRED` | 11.7, 13.1, 13.2, 13.3, 13.4, 13.5 |
| `powerState.code` projected in the inventory query | 20.1, 20.5, 20.6, 20.7, 20.8 |
| `avg` is count-weighted; no path averages interval averages | 27.1, 27.2, Property 1 |
| No bare `p95` key; every percentile carries `estimator` and a label | 28.4, 28.5, 28.6, 28.7 |
| Percentiles from sketches folded during collection | 28.1, 28.2, 28.8, Property 3 |
| Base grain `PT1H`; non-whole-hour offsets drop to `PT15M`; local-day buckets | 25.1, 25.2, 25.3, 25.5, 25.6, Property 6 |
| Batching by points budget with adaptive halving; grouping key | 23.1, 23.2, 23.3, 23.4, Property 4 |
| Raw points discarded after folding; no full series materialized | 26.1, 26.2 |
| Every per-resource error in a 200 response lands in `collection_log` | 29.1, 29.2, 29.3, 29.4 |
| `vCPUsAvailable` not `vCPUs`; `resource_skus.list()` location-filtered | 21.1, 21.2, 21.3 |
| All three of `azure-monitor-querymetrics`, `azure-mgmt-monitor` and `azure-monitor-query>=2` installed | 17.2, 17.3, 17.4, 17.5, 17.6, 17.10 |
| Metric definitions cached per `(resource_type, region)` | 22.1, 22.2, 22.3 |
| One `ClientSecretCredential`, reused | 19.1, 19.2, 19.3 |
| Every value a decimal string; snapshot JCS-canonicalized and hashed | 34.1, 34.2, 34.3, 34.4, 34.5, Property 2 |
| Every derived figure carries `derived_from` and `formula` | 30.2, 30.3 |
| Memory % labelled host-observed; network labelled NIC-level, not egress | 30.4, 30.5, 30.6 |
| Resource Graph paged with `skip_token`; quota headers honoured | 20.2, 20.3, 20.4 |
| No metrics data-plane host falls back per-resource; region never dropped | 24.2, 24.3, 24.4 |
| Concurrency capped at 8; `Retry-After` honoured on 429 | 23.7, 23.8, 23.9 |
| Raw archive written during the same stream-reduce pass | 26.3, 26.4, 26.5, 26.6 |
| No platform metric for in-guest disk free space; `_Total` collapse is a gap | 31.5, 31.6 |
| `fidelity_tier` per resource, propagated to derived values | 20.9, 31.1, 31.2, 31.3, 31.4 |
| Terminal states `AUTH_EXPIRED` / `SCOPE_UNVERIFIED` / `EMPTY_SCOPE` / `THROTTLED` / `PARTIAL_COVERAGE` / `REGION_UNREACHABLE` | 13.5, 12.5, 33.1, 23.9, 29.5, 24.4 |
| One credential per invocation, never reused across invocations | 19.4, 19.5, 19.7 |
| Inventory retains a deallocated resource rather than dropping it | 20.10, 20.11, 20.12, 20.13 |
| `vCPUsAvailable` absent falls back to no capacity, never to `vCPUs` | 21.9, 21.10, 21.11, 21.12 |
| A failed definition probe is distinguishable from a metric not emitted | 22.4, 22.5, 22.6, 22.7 |
| One `metric_namespace` per call; `Total` and `Count` requested; series matched by resource id | 23.10, 23.11, 23.12, 23.13, 23.14 |
| Fallback responses are archived, so a fallback region stays replayable | 24.6, 24.7, 24.8 |
| Half-open local window; partial edge day retained; grain restricted to `PT1H` / `PT15M` | 25.7, 25.8, 25.9, 25.10, 25.11, 25.12 |
| Raw archive keys never collide; a rejected request writes no object | 26.8, 26.9, 26.10, 26.11, 26.12 |
| Decimal working precision and quantization pinned; fold order irrelevant | 27.8, 27.9, 27.10, 27.11, 27.12 |
| Sketch kind selected from the declared unit, not a metric-name substring | 28.9, 28.10, 28.11, 28.12, 28.13 |
| A resource absent from a 200 response is a gap, not a silent omission | 29.6, 29.7, 29.8, 29.9 |
| Memory utilization inverts direction: max utilization from min available memory | 30.1, 30.7, 30.8, 30.9 |
| `fidelity_tier` derived from collected evidence, capped by the connection | 31.7, 31.8, 31.9 |
| Metric catalog validated, loaded once, immutable; `CATALOG_UNUSABLE` on total failure | 32.6, 32.7, 32.8 |
| The empty-scope gate runs before any artifact write; stopped resources still count | 33.5, 33.6, 33.7 |
| `snapshot_id` excluded from its own hash input; array order normalized; write-once by key | 34.4, 34.8, 34.9, 34.10 |
| Snapshot carries its own schema version, producer and requested scope | 35.8, 35.9, 35.10 |
| `phase_deadline` budgets declared; run rows scoped to their owner | 36.9, 36.10, 36.11 |
| `progress_token` derived, stored hashed, recomputed at invoke; `RunView` key set asserted | 37.3, 37.11, 37.12 |
| Out-of-order and replayed progress callbacks rejected; agent may not write `TIMEOUT` | 38.10, 38.11, 38.12 |
| Reaper sweeps before it claims, initiates without reading the stream, runs at most 60s apart | 39.11, 39.12, 39.13 |
| The relay derives events from the row, authorizes the reader, and reconnects | 40.9, 40.10, 40.11, 40.12, 40.13 |
| Invocation restricted to a `claimed` row; `SECRET_UNREADABLE` on decryption failure | 41.9, 41.10, 41.11 |
| Properties are falsifiable, seeded, and cannot pass by discarding inputs | 42.6, 42.7, 42.8 |
| In-flight progress is persisted on the run row as three nullable columns | 36.3, 36.12, 38.1, 38.7 |
| A same-phase callback refreshes progress; an out-of-order count is ignored | 38.13, 38.14 |
| Progress callbacks are throttled without delaying a transition or a terminal callback | 38.15 |
| A terminal transition clears the in-flight progress columns | 36.12, 38.12 |
| The relay emits a determinate `progress` event from the row, and none where the row has no count | 40.10, 40.14, 40.15 |
