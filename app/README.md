# `app/` — the web application

Next.js 16 (App Router, React 19). Owns identity, the customer's Azure credentials,
the profile wizard, artifact download authorization, and — most importantly — **the
run state machine**.

It does not talk to Azure. It never renders a document. It never computes a figure.
It invokes the runtime and records what came back.

See the [project README](../README.md) for the product, the invariant and the
topology.

---

## Requirements

- Node 20+ and **pnpm**
- Postgres 12+ (12 is the floor: migration `0004` uses `ALTER TYPE … ADD VALUE`)
- AWS credentials with access to the runtime, the artifact bucket and the history table

## Local development

```bash
pnpm install
cp .env.example .env        # then fill it in — see below
pnpm db:migrate
pnpm dev
```

### Environment

Every variable in `.env.example` is required; `lib/env.ts` reads them **at call
time** and throws by name, so a missing one fails the request that needed it rather
than the build.

| variable | what it is |
|---|---|
| `DATABASE_URL` | Postgres. Strip node-driver-only params like `uselibpqcompat` before using it with `psql`. |
| `APP_ENCRYPTION_KEY` | AES-256-GCM key for `client_secret_enc`. Rotating it makes stored secrets unrecoverable — re-entering is the repair. |
| `AWS_REGION` · `RPT_RUNTIME_ARN` | which runtime to invoke |
| `RPT_ARTIFACT_BUCKET` | a **bucket name**, not a bucket and prefix. It is passed straight into `Bucket=`, so `my-bucket/my-prefix` fails every S3 call. Keys are already namespaced `<actorId>/…`. |
| `RPT_HISTORY_TABLE` · `RPT_TITLE_MODEL_ID` | chat history and thread titling |
| `RPT_CRON_SECRET` | bearer secret for `/api/cron/tick` |
| `RPT_APP_BASE_URL` | HTTPS base the runtime calls back on. Behind a private CA, the **runtime** needs `RPT_CA_BUNDLE` — see `agent/README.md`. |

Add every new variable to `.env.example` in the same change; a boundary test asserts
the file's key set matches what the code requires.

---

## What this half actually decides

Four things, and it is worth being precise about them because the rest is plumbing.

### 1. The run state machine

`lib/runs/` and the `report_runs` table. A run is enqueued by inserting a row, not by
starting work — the row *is* the run. `/api/cron/tick` then claims due work with
`FOR UPDATE SKIP LOCKED`, invokes the runtime, and returns in seconds. **It never
waits for a report.** p99 for a run is 8–12 minutes; a tick that awaited one would
hold a connection open for the whole of it and lose the run when it didn't.

The same tick runs the reaper, which fails any non-terminal row past its phase
deadline. Without it, one crashed container leaves rows in `collecting` forever.

EventBridge is at-least-once, so correctness rests on the unique `dedupe_key`, not on
the scheduler firing once.

State arrives back by **HMAC-signed progress callback**
(`/api/internal/runs/[runId]/progress`), which is authoritative. The SSE relay at
`/api/runs/[runId]/stream` is a live view for a browser that happens to be watching.
Never put anything in the stream path that the run's correctness depends on.

`RUNTIME_START_TIMEOUT_MS` in `lib/runs/invoke.ts` is 30s against measured cold starts
of 10.2–22.7s. The comment there records the measurements; the headroom is seven
seconds, not seventeen.

### 2. What a profile *is*, and when it freezes

A profile (`report_templates`) is a per-customer engagement, not a reusable design.
Each save inserts a new immutable **version** (`report_template_versions`), and a run
pins one. `lib/actions/templates.ts` is the seam where a version stops referring to
things and starts carrying them:

```
draft definition
   │  validateDefinition            shape, then catalogue
   │  checkProviderImmutable        the provider is locked once a version exists
   ├─ resolveDesignFromBrand        theme, accent, density, number format → inline
   ├─ resolveNoticeFromBrand        the confidentiality notice → inline
   ├─ resolveLogoIntoDefinition     the cover logo URL → fetched, stored, keyed
   │  numberFormatFor               trim_trailing_zeros pinned at v3
   ▼
insertVersion  →  definitionSha256 over the *resolved* definition
```

Everything above the digest line is why **a Brand edit changes the next report and
never one already delivered**. It is also why a deploy alone does not change a
report: the profile has to be re-saved for a new resolution to happen.

The logo is worth calling out. `front_matter.cover.logo` is a URL a profile author
typed. Fetching it at render time would mean the runtime issuing a request to an
address chosen by the person whose report it is, from inside the VPC. So the app
fetches it once, here — http(s) only, inside the signature upload's byte ceiling,
sniffing the bytes' own magic number rather than believing the response's
`Content-Type` — and stores it under `<actorId>/logos/<uuid>.png`. The runtime reads
its own bucket. A URL that is unreachable, oversized or not an image leaves the
version without a key and the save proceeds; losing a profile edit because an image
host was down would be a far worse trade than a cover that draws nothing.

### 3. Who may download an artifact

`/api/artifact-url` presigns **at click, never earlier**, and authorization is an
exact match on the key's first segment against the session's user id. `alice-evil`
does not match `alice`. There is no second check to forget, because there is no
second check.

### 4. The wizard's estimate

`lib/profiles/emit.ts` predicts what a section will emit — how many headings, charts,
tables and figures — so the wizard can show it before a run costs anything. It is a
second implementation of the compiler's expansion arithmetic, in a second language,
and the only thing keeping the two honest is
[`agent/tests/fixtures/emit-estimate/cases.json`](../agent/tests/fixtures/emit-estimate/):
one corpus, read by this suite and by the agent's, so a change to the arithmetic
fails on both sides or neither.

---

## Tests

```bash
pnpm vitest run     # 3336
pnpm typecheck
pnpm lint
pnpm build          # the check that matters most — see below
```

`pnpm build` catches the class of bug no test does: a `server-only` import pulled into
a `"use client"` boundary type-checks, passes every unit test, and fails the build.
Run it before you believe a wizard change.

`pnpm format` runs `prettier-plugin-tailwindcss`, so class order is enforced — don't
fight it.

A few suites are worth knowing by name:

- **`test/boundaries.static.test.ts`** — anything importing an AWS SDK, an Azure SDK
  or `lib/crypto` must also import `server-only`. No hardcoded runtime ARN. It also
  classifies **every** module under `lib/templates` and `lib/subscriptions` as either
  server-only or deliberately pure, exhaustively in both directions: a new module
  there fails until it is classified, and a classification naming a deleted module
  fails too.
- **`test/mirror.static.test.ts`** — the message catalogue's id set **and** its values,
  across both halves. It parses the TypeScript half with a regex, so write a catalogue
  entry as one string literal; a `+`-concatenated one reads as truncated.
- **`test/paper-stylesheet.static.test.ts`** — every class the agent's HTML emitter can
  write has a rule in `app/globals.css`.
- **`lib/templates/composer.property.test.ts`** — no sequence of composer actions
  reaches a state the validator rejects. This has already caught a validator change
  that would have made every freshly-inserted block invalid.
- **`lib/profiles/emit.test.ts`** — the shared emit-estimate corpus.

Property tests use **fast-check** and are held to a floor of accepted cases; a
property that shrinks to a trivial space fails on that ground alone.

## Layout

```
app/
  app/
    (auth)/          login · register
    (app)/           dashboard · subscriptions · report-profiles · reports · brand
    api/
      runs · runs/[runId] · runs/[runId]/stream       enqueue, read, cosmetic SSE
      internal/runs/[runId]/progress                  HMAC callbacks — authoritative
      internal/runs/[runId]/verification              the audit record
      cron/tick                                       claim + reap; returns in seconds
      templates · templates/[id] · templates/catalog · templates/[id]/preview
      report-profiles/signature                       an approver's uploaded signature
      brand                                           theme, accent, confidentiality notice
      subscriptions · subscriptions/test · subscriptions/[id]/secret
      artifact-url                                    presign at click, never earlier
  components/        app-shell · auth · brand · charts · reports · subscriptions · templates · ui
  lib/
    actions/         the server actions — templates.ts is the resolve-at-save seam
    auth/            custom DB sessions (argon2 + sessions table + httpOnly cookie)
    brands/          the Brand store and signature-upload validation
    crypto.ts        AES-256-GCM
    db/              schema · migrations · browser-safe view projections
    messages/        the message catalogue, mirrored from the agent's
    profiles/        the section catalogue and the wizard's emit estimate
    runs/            state machine, claim, invoke, progress, presentation
    templates/       the definition validator, versioning, composer reducer, logo resolve
    verifications/   the verification store
    aws/             s3 · dynamo · bedrock · agentcore
  test/              static boundary and mirror guards
```

---

## Four things that will bite you

**Auth is a custom DB-session implementation, not Auth.js.** argon2, a `sessions`
table, an httpOnly cookie, and a 5-failures-in-15-minutes lockout. Neither the
Auth.js npm package nor its Drizzle adapter is a dependency here, and no module
imports either one. If you find a `vi.mock` of an Auth.js JWT subpath anywhere, it is
dead weight inherited from a sibling project — it mocks a module nothing imports.

The package name is deliberately not written out above. `test/boundaries.static.test.ts`
refuses **any** file under `app/` that contains it, prose included, because a stale
textual reference is exactly what reads as evidence the dependency is live — the
sibling project has two steering docs describing an Auth.js setup its code does not
have. The guard assembles the name at runtime so it can scan itself; documentation
just does without it.

**The SSE relay is cosmetic.** `api/runs/[runId]/stream` is a live view over run
state for a browser that happens to be watching. State arrives by progress callback,
not by stream.

**`/api/cron/tick` never waits.** Claim, invoke, return. The reaper rides the same
tick. EventBridge is at-least-once; the unique `dedupe_key` is what makes that safe.

**A page can exist and still be unreachable.** `/brand` shipped with no navigation
entry and could only be found by typing the URL, which is why the confidentiality
notice appeared to be missing when it was merely unreachable. `NAV_ITEMS` in
`components/app-shell/sidebar.tsx` is the whole navigation; a new page that is not in
it is a page nobody will find.

## Deployment

Run on a **Node server** — not a serverless platform. p99 for a report run is 8–12
minutes, well past Vercel's 300s cap.

```bash
pnpm install && pnpm build && sudo systemctl restart reporting-agent
```

`pnpm build` before the restart, always: `next start` without a build is a crash
loop, and the unit will happily report itself as `active (running)` while restarting.

Raise the origin-response timeout on anything in front of it. CloudFront's default
30s and ALB's default 60s both kill SSE long before a run finishes — that kills more
SSE deployments than application timeouts do.

Run `pnpm db:migrate` **before** restarting the app, and both before deploying a
runtime that depends on either. See the project README's deploy order.
