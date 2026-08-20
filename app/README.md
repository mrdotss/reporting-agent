# `app/` — the web application

Next.js 16 (App Router, React 19). Owns identity, the customer's Azure credentials,
the template wizard, and — most importantly — **the run state machine**.

It does not talk to Azure. It never renders a document. It invokes the runtime and
records what came back.

See the [project README](../README.md) for the product and the invariant.

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
| `RPT_ARTIFACT_BUCKET` | a **bucket name**, not a bucket and prefix. It is passed straight into `Bucket=`, so `my-bucket/my-prefix` fails every S3 call. Keys are already namespaced `<actor_id>/…`. |
| `RPT_HISTORY_TABLE` · `RPT_TITLE_MODEL_ID` | chat history and thread titling |
| `RPT_CRON_SECRET` | bearer secret for `/api/cron/tick` |
| `RPT_APP_BASE_URL` | HTTPS base the runtime calls back on. Behind a private CA, the **runtime** needs `RPT_CA_BUNDLE` — see `agent/README.md`. |

Add every new variable to `.env.example` in the same change; a boundary test asserts
the file's key set matches what the code requires.

## Tests

```bash
pnpm vitest run     # ~2200
pnpm typecheck
pnpm lint
```

`pnpm format` runs `prettier-plugin-tailwindcss`, so class order is enforced — don't
fight it.

A few suites are worth knowing by name:

- **`test/boundaries.static.test.ts`** — anything importing an AWS SDK, an Azure SDK
  or `lib/crypto` must also import `server-only`. No hardcoded runtime ARN.
- **`test/mirror.static.test.ts`** — runs the shared definition corpus through *this*
  validator **and spawns the agent's** to compare verdicts head to head. One corpus,
  read across the monorepo path, never copied: two copies is how a mirror guard comes
  to compare each half against itself and pass while the halves disagree.
- **`lib/templates/composer.property.test.ts`** — no sequence of composer actions
  reaches a state the validator rejects. This one has already caught a validator
  change that would have made every freshly-inserted block invalid.

Property tests use **fast-check** and are held to a floor of accepted cases; a
property that shrinks to a trivial space fails on that ground alone.

## Layout

```
app/
  app/
    (auth)/          login · register
    (app)/           dashboard · subscriptions · templates · reports
    api/
      runs · runs/[runId] · runs/[runId]/stream       enqueue, read, cosmetic SSE
      internal/runs/[runId]/progress                  HMAC callbacks — authoritative
      internal/runs/[runId]/verification              the audit record
      cron/tick                                       claim + reap; returns in seconds
      templates · templates/[id] · templates/catalog · templates/[id]/preview
      subscriptions · subscriptions/test · subscriptions/[id]/secret
      artifact-url                                    presign at click, never earlier
  components/        app-shell · auth · charts · reports · subscriptions · templates · ui
  lib/
    auth/            custom DB sessions (argon2 + sessions table + httpOnly cookie)
    crypto.ts        AES-256-GCM
    db/              schema · migrations · browser-safe view projections
    runs/            state machine, claim, invoke, progress, presentation
    templates/       the definition validator, versioning, the composer reducer
    verifications/   the verification store
    aws/             s3 · dynamo · bedrock · agentcore
  test/              static boundary and mirror guards
```

---

## Three things that will bite you

**Auth is a custom DB-session implementation, not Auth.js.** argon2, a `sessions`
table, an httpOnly cookie, and a 5-failures-in-15-minutes lockout. `next-auth` is
*not* a dependency here. If you find a `vi.mock("next-auth/jwt")` anywhere, it is
dead weight inherited from a sibling project — it mocks a module nothing imports.

**The SSE relay is cosmetic.** `api/runs/[runId]/stream` is a live view over run
state for a browser that happens to be watching. State arrives by progress callback,
not by stream. Never put anything in the stream path that the run's correctness
depends on.

**`/api/cron/tick` never waits.** It claims due work with `FOR UPDATE SKIP LOCKED`,
invokes, and returns in seconds. The same tick runs the reaper, which fails any
non-terminal row past its phase deadline — without it, one crashed container leaves
rows in `collecting` forever. EventBridge is at-least-once, so correctness rests on
the unique `dedupe_key`, not on the scheduler firing once.

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
