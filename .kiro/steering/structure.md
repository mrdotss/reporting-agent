# Structure & conventions

This repo is a **monorepo** with two halves:
- `agent/` — the Python **Strands** agent on AgentCore Runtime (arm64 container).
  **Not yet created.** It owns every Azure call, the collector, the compiler, the
  renderer and the verifier. Nothing deterministic about a number lives in `app/`.
- `app/` — the Next.js 16 web app (App Router, TypeScript, pnpm). **Already
  scaffolded** — match the files that exist rather than recreating them.

The split is the product invariant expressed as a directory boundary: `app/`
orchestrates, authorizes and displays; `agent/` collects, computes, renders and
proves. If a figure is being calculated in `app/`, the layering is wrong.

## `agent/` layout (target)
```
agent/
  Dockerfile                      # arm64 (linux/arm64) — AgentCore requirement
  pyproject.toml                  # azure-monitor-query>=2 AND azure-monitor-querymetrics
  README.md                       # build + deploy
  AGENTCORE_INTEGRATION.md        # the authoritative invoke contract (app reads this)
  themes/                         # STYLES-ONLY .docx, no content — the four presets:
                                  #   editorial.docx  corporate.docx
                                  #   technical.docx  minimal.docx
  src/reporting_agent/
    main.py                       # BedrockAgentCoreApp entrypoint; prompt vs command routing
    agent.py                      # Strands agent + tool registration + system prompt
    events.py                     # the SSE event vocabulary, one place
    progress.py                   # fire-and-forget phase-transition POSTs to the app
    azure/
      credential.py               # ONE ClientSecretCredential, reused across all clients
      preflight.py                # permissions assertion -> scope_verified (hard gate)
      inventory.py                # Resource Graph paging (skip_token) + powerState projection
      definitions.py              # metric-definition probe, cached per (resource_type, region)
      skus.py                     # azure-mgmt-compute capacity, ALWAYS location-filtered
      metrics.py                  # batch query, points-budget batching, stream-reduce
      regions.py                  # regional data-plane endpoints + per-resource fallback
    collect/
      sketch.py                   # fixed histogram (percentages) + DDSketch (bytes/IOPS)
      accumulate.py               # count-weighted avg, exact min/max, sketch folding
      archive.py                  # raw batch responses -> S3 .json.gz, DURING stream-reduce
      buckets.py                  # local-day bucketing from PT1H (Asia/Jakarta)
      snapshot.py                 # immutable snapshot build + JCS canonicalize + hash
      log.py                      # typed collection_log gaps
    compile/
      definition.py               # template definition model + validation
      ast.py                      # typed document AST; Figure is the only numeric leaf
      blocks/                     # one module per block type: config + snapshot -> AST
      scope.py                    # template default + per-block override -> resources
      figures.py                  # AST walk -> figure ledger
      format.py                   # the ONLY place a figure becomes a display string
      estimators.py               # estimator labels ("p95 (estimated from hourly)")
    render/
      docx.py                     # AST -> python-docx against themes/<preset>.docx
      html.py                     # AST -> HTML preview (same AST, second emitter)
      pdf.py                      # DOCX -> PDF (LibreOffice; LANG=C.UTF-8, --norestore,
                                  #   profile pre-warmed at image build)
      charts.py                   # static chart images for embedding
      anchors.py                  # w:tblCaption ids + Figure character-style wrapping
    verify/
      tokens.py                   # numeric-token extraction from the rendered document
      verifier.py                 # soundness + completeness -> verification result
      replay.py                   # re-aggregate archived raw -> assert identical snapshot hash
      drift.py                    # PURE: choose the drift sample + compare; re-query via azure/
    compare/
      delta.py                    # snapshot-to-snapshot deltas
    tools/                        # @tool defs the model may call (prose + Q&A only)
  tests/
```

### `agent/` conventions
- **The model gets no arithmetic.** Tools exposed to the model return
  already-compiled figures and prose-safe summaries. There is no tool that returns
  raw series for the model to average, and no tool that accepts a number the model
  produced and writes it into a document.
- `compile/format.py` is the **single** place a figure becomes a string. The
  verifier compares document tokens against `formatted` values produced here; a
  second formatting path is a verification bug waiting to happen.
- **`Figure` is the only numeric leaf in `ast.py`.** Every numeric leaf is
  `Figure(value, unit, snapshot_path, formatted, estimator?)`. Provenance is
  therefore **structural**: there is no representable way to put a number in the
  document except as a Figure carrying its own `snapshot_path`. A bare `str` or
  `Decimal` in a text position is a type error, not a review comment.
- **The figure ledger and the render context are the same object.** `figures.py`
  walks the AST that `docx.py` emits — it does not build a parallel structure. They
  cannot drift because there is only one of them.
- **No template language means no lint.** There is nothing to validate at render
  time because there is no user-authored expression to evaluate — no `{{ a / b }}`,
  no `|round`, no `|sum`. A user-authored expression would produce a figure with no
  `snapshot_path`, which is exactly the hole the AST closes.
- `render/anchors.py` owns two structural contracts the verifier depends on:
  **data tables always carry a `w:tblCaption` id; layout tables never do.** A `row`
  block is emitted as a **borderless layout table**, so the table-verification pass
  excludes it **by construction** rather than by guessing from borders or cell
  count. Every figure is wrapped in the theme's **`Figure` character style**, which
  is what lets token extraction find figures without re-parsing prose.
- **Every theme in `themes/` must define the `Figure` character style**, plus the
  paragraph and table styles the blocks reference. A theme missing a referenced
  style is a **build-time failure**, not a silently unstyled run — add a test that
  loads each theme and asserts the full style set is present.
- `scope.py` resolves scopes **against the snapshot only**, never against Azure. The
  snapshot holds the **union** of all block scopes and knows nothing about blocks,
  which is what keeps replay clean: replay re-runs `compile/` over the same snapshot
  and must produce a **bit-identical ledger**.
- A block whose scope resolves to **zero resources** emits an explicit
  "No resources matched this scope" row. It must **never** silently vanish — a
  disappearing block is indistinguishable from one that was never configured, and
  the reader cannot tell the difference. `EMPTY_SCOPE` stays a hard failure only
  when the **whole run** resolves to zero resources, not when one block does.
- Every metric value is a **fixed-precision decimal string** end to end. No
  `float` survives into a snapshot, a ledger or a hash input.
- `snapshot.py` writes once. There is no update path.
- Every Azure failure becomes a **typed entry in `collection_log`** — never a zero,
  never a silent skip, never a bare `except: pass`.
- `azure/` is the only package allowed to import an Azure SDK. `collect/`,
  `compile/`, `render/`, `verify/` and `compare/` operate on plain data so they are
  unit-testable without a subscription.
- `archive.py` writes **in the same pass** as `accumulate.py`, not in a second pass.
  There is no point at which the collector re-reads Azure to build the archive.
- `progress.py` is **fire-and-forget**: a failed phase callback logs and moves on. It
  must **never** fail the run — the reaper is the backstop for a callback that never
  landed, and a run that dies because it could not report its own progress is the
  worst of both designs.
- `verify/replay.py` may import **only** pure modules. If replay can reach the
  network, it is no longer proving determinism — it is re-collecting.
- Pure modules (`accumulate.py`, `sketch.py`, `format.py`, `buckets.py`,
  `verify/tokens.py`, `verify/replay.py`, `verify/drift.py`) are property-tested.
  Count-weighted averaging, exact min/max roll-up, and local-day bucketing across a
  DST-free +07:00 offset each get a test that fails on the naive implementation.
  Replay gets a test asserting the snapshot hash is **byte-identical** across two
  runs of the aggregation over the same archived input.

## `app/` layout (App Router)
> Existing files: `app/{layout,page,globals.css}.tsx|css`,
> `components/theme-provider.tsx`, `components/ui/button.tsx`, `lib/utils.ts`,
> `components.json`. Extend around them.
```
app/
  app/
    (auth)/login/  register/                      # public auth pages
    (app)/                                        # authenticated shell (guarded)
      dashboard/                                  # recent runs, subscription health, secret expiry
      subscriptions/                              # connect / manage Azure subscriptions (wizard)
      templates/                                  # template list + the three starter templates
      templates/[id]/edit/                        # drag/drop block builder (palette/canvas/inspector)
      reports/                                    # run list
      reports/[runId]/                            # report detail: download, verification, gaps
      reports/compare/                            # two-run delta view
      chat/[threadId]/                            # agentic chat (scoped to a report or free)
    api/
      chat/route.ts                               # SSE relay -> AgentCore (Node runtime)
      runs/route.ts                               # POST enqueue a run (deterministic command)
      runs/[runId]/route.ts                       # GET status + verification
      runs/[runId]/stream/route.ts                # cosmetic live view over run state
      internal/runs/[runId]/progress/route.ts     # HMAC-authorized agent callback
      cron/tick/route.ts                          # claim + invoke + reap; returns in seconds
      artifact-url/route.ts                       # presign an S3 artifact key (download)
      subscriptions/route.ts                      # create/list
      subscriptions/preflight/route.ts            # scope_verified check before accepting
      templates/route.ts  templates/[id]/route.ts # CRUD; every edit writes an immutable version
      templates/[id]/preview/route.ts             # "Render real preview" -> true docx -> PDF pipeline
      conversations/route.ts                      # GET list + POST create
      conversations/[id]/route.ts                 # GET messages + PATCH rename + DELETE
      conversations/[id]/title/route.ts           # POST AI title from the first prompt
  components/
    ui/                                           # shadcn (Base UI) generated primitives
    chat/                                         # message-list, activity-timeline, artifact-card,
                                                  #   chart-inline, composer, suggestions, agent-intro
    subscriptions/                                # wizard steps, role-explainer, preflight-result
    reports/                                      # run-progress, verification-panel, gap-list,
                                                  #   fidelity-badge, delta-table
    templates/                                    # block-palette, block-canvas, block-inspector,
                                                  #   row-splitter, style-preset-picker,
                                                  #   paper-preview, scope-editor
    charts/                                       # themed Recharts wrappers (categorical + sequential)
  lib/
    auth/ password.ts  session.ts  guard.ts       # argon2, session rows + cookie, route guard
    actions/                                      # server actions: subscriptions, templates, runs
    runs/ state.ts  claim.ts  progress-token.ts   # transitions, SKIP LOCKED claim, run-scoped HMAC
    templates/ definition.ts  blocks.ts  version.ts  # zod definition, block config schemas, sha256
    db/ index.ts  schema.ts  views.ts  migrations/  # Drizzle + Postgres
    history/ conversations.ts  messages.ts        # DynamoDB data layer (chat history)
    aws/ agentcore.ts  s3.ts  dynamo.ts  bedrock.ts
    crypto.ts                                     # encrypt/decrypt Azure client_secret at rest
    session-id.ts                                 # stable 33-128 char runtime session ids
    events.ts                                     # SSE event types, mirroring agent/events.py
  drizzle.config.ts
  .env.example                                    # committed (placeholders)
  .env                                            # git-ignored (real values)
```

## `app/` conventions
- **Server-only** modules for anything touching a cloud SDK or a secret: every
  file under `lib/aws/`, plus `lib/crypto.ts`, `lib/db/*` and `lib/auth/*`, starts
  with `import "server-only"`. Never import them into a client component. The
  `server-only` package turning a leak into a build error is the point — do not
  work around it by re-exporting through a neutral barrel.
- **Validate every route input with zod.** Every route handler and every server
  action parses its input at the boundary and returns typed errors. No
  `as SomeType` on a request body, ever. Path params and search params count as
  input.
- Route handlers that stream must run on the **Node runtime**
  (`export const runtime = "nodejs"`), not edge — the AWS SDK and long-lived SSE
  both require it.
- **`rsc: true`** — components are server components by default. Add `"use client"`
  deliberately, at the leaf that actually needs interactivity, not at the page.
- One Drizzle `schema.ts`; generate SQL migrations with drizzle-kit and never
  hand-edit the DB. **Migrations are additive** — a guard test fails on any `DROP`
  of a retained table or column. Report runs, snapshots and verification results
  are audit artifacts; the schema may only grow around them.
- **One browser-safe projection type per secret-bearing table**, defined in
  `lib/db/views.ts`, and it is the *only* shape allowed to cross to the client:
  - `connected_subscriptions` → `SubscriptionView`: masked subscription id, display
    name, `scopeVerified`, `fidelityTier`, `secretExpiresAt`, `status`. Drops
    `tenant_id`, `client_id`, `client_secret_enc` entirely.
  - `report_runs` → `RunView`: ids, period, status, counts, verification summary,
    artifact keys (keys only — never presigned URLs at rest). Drops
    `progress_token_hash`, `claimed_by` and `dedupe_key`.
  A guard test asserts no secret field survives each projection. Add the test with
  the table, not after.
- Presigned URLs are minted **per request**, short-lived, and authorized against
  the signed-in user's ownership of the run. Never store one; never put one in a
  server-rendered payload that gets cached.
- Keep chat and run-progress components **pure/presentational**. Parse SSE in a
  hook (`useAgentStream`) that maps events to UI state; `lib/events.ts` and
  `agent/src/reporting_agent/events.py` must stay in sync — one event vocabulary,
  two languages.
- **Two schemas are mirrored across languages and both are load-bearing:**
  `lib/events.ts` ↔ `agent/.../events.py` (the event vocabulary), and
  `lib/templates/blocks.ts` ↔ `agent/.../compile/definition.py` (the block config
  schemas). The builder writes a definition the compiler has to accept, so a config
  the app can **save** but the agent cannot **compile** turns a save-time validation
  error into a failed run minutes later. Reject unknown block types explicitly
  rather than ignoring them, and carry a schema version in the definition.
- Authorize every DynamoDB read/write by the signed-in user's id. Chat history is
  in DynamoDB; everything relational is in Postgres. Do not blur that.
- Env files: add every new var to **`.env.example`** in the same change; real
  values live only in the git-ignored `.env`.

---

## The report template model
A template is a **versioned JSON definition** authored in an **in-app drag/drop
builder**, compiled to a **typed document AST**, and emitted by `python-docx`.

> **There is no `.docx` upload, no `docxtpl`, and no user-facing template language
> anywhere in this product.** If a design proposes one, it is reintroducing both
> problems the AST exists to solve — output quality bounded by the user's Word
> skills, and figures with no provenance.

### Layout grammar — vertical flow plus column rows
```
block  := { id, type, config, scope_override? }
row    := { id, type: "row", columns: 2|3, children: [block] }
```
Blocks stack top to bottom and are drag-reorderable. A `row` splits into 2 or 3
columns and holds child blocks.

- **One level of nesting only.** No rows inside rows.
- **No absolute positioning.** Word is a reflowing, paginated medium; this
  constraint is precisely what makes **every arrangement the builder can express
  paginate correctly**. A canvas with free positioning would let the user build
  layouts that cannot survive a page break, and there would be no honest preview.
- In DOCX a `row` becomes a **borderless layout table**. See the `anchors.py`
  convention above — layout tables carry no `w:tblCaption`, data tables always do.

### Block palette
Typed, each professionally designed, each with a config schema:

`cover` · `executive_summary` (LLM prose) · `kpi_row` · `resource_table` ·
`top_n_table` · `timeseries_chart` · `distribution_chart` · `capacity_vs_usage` ·
`gaps_and_coverage` · `comparison_delta` · `verification_record` ·
`appendix_methodology` · `row` · `page_break` · `heading` · `rich_text` (static
prose, **no figures**)

### Style presets
Four curated themes — **Editorial · Corporate · Technical · Minimal** — each an
`agent/themes/<name>.docx` containing **Word paragraph, character and table styles
only, no content**.

Tunable per template: accent colour, density (`compact`/`normal`/`relaxed`), table
style (`hairline`/`banded`/`bordered`), number format, cover page on/off, logo,
page size.

### Data binding — template default plus per-block override
The template sets a default scope; **any block may narrow it** (resource types, tag
filters, resource groups, top-N by a metric, sort). One report can therefore carry
"Top 10 VMs by CPU", "all Storage Accounts by used capacity" and "tag `env=prod`"
as three separate blocks.

- The collector fetches the **union of all block scopes, once**, into **one
  snapshot**. The snapshot is **scope-agnostic** — it holds the union and nothing
  about blocks.
- `compile/scope.py` resolves each block's scope against that snapshot
  deterministically. No Azure calls, so **replay stays clean**.
- **Coverage verification asserts every resource in the union is present.**
- Zero-resource blocks and `EMPTY_SCOPE` behave as described in the `agent/`
  conventions above.

### Versioning — templates are immutable once used
| table | holds |
|---|---|
| `report_templates` | current definition + metadata |
| `report_template_versions` | `id`, `template_id`, `version`, `definition` jsonb, `definition_sha256`, `created_at` — **immutable** |
| `report_runs.template_version_id` | pins the **exact** version used for that run |

Editing a template **creates a new version** and never invalidates an existing
report. An archived report stays reproducible from **its pinned version + its
snapshot** — which is the same reasoning as `snapshot_sha256` below: a report is an
audit artifact, so every input to it has to be pinned, not just the data.

Ship **three starter templates** so the builder is never a blank page:
**Monthly utilization**, **Capacity planning**, **Executive summary**.

---

## Run orchestration — Postgres is the state machine
Spans both halves, so it lives here rather than in either layout. The wire-level
detail is in `agentcore-integration.md`; this is the structural rule.

**`report_runs.status` is authoritative:**
```
queued → claimed → collecting → compiling → rendering → verifying
       → completed | failed
```
The schema must carry the columns the machine needs, or it is not a state machine:
**`dedupe_key` (UNIQUE)**, `claimed_at`, `claimed_by`, `updated_at`,
`phase_deadline`, `error_code`, `error_message`. `dedupe_key` is the idempotency
guard — a double-submitted form or a retried cron tick must not produce two runs.

- **The agent advances its own state.** At every phase transition the runtime fires
  a short **fire-and-forget POST** to `api/internal/runs/[runId]/progress`,
  authorized by the run-scoped HMAC `progress_token` from the invoke context. Four
  or five tiny independent requests per run — **none long-lived, none able to time
  out the way a stream can**. `lib/runs/progress-token.ts` mints and validates;
  `agent/src/reporting_agent/progress.py` sends.
- **`api/runs/[runId]/stream` is a cosmetic live view.** If it drops, nothing is
  lost — the client reconnects and replays from the row. Never put state there that
  cannot be reconstructed from `report_runs`.
- **`lib/actions/runs.ts` enqueues and returns.** It inserts a `queued` row with a
  `dedupe_key`. It does **not** hold a stream open and does **not** own run state.
  > A long-held server-side stream consumer looks like it solves this and does not:
  > it survives a closed tab but still dies on a restart, a deploy roll or a request
  > timeout, leaving the row in `collecting` forever because nothing sweeps it.
- **`api/cron/tick` is mandatory**, bearer-secret authorized. It claims due work
  atomically, invokes, and **returns in seconds** — it never waits for a run:
  ```sql
  UPDATE report_runs SET status='claimed', claimed_at=now(), claimed_by=$1
  WHERE id IN (SELECT id FROM report_runs WHERE status='queued'
               ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10)
  RETURNING *;
  ```
  `FOR UPDATE SKIP LOCKED` is what makes overlapping ticks safe — they claim
  disjoint sets instead of racing. The same tick **fails any non-terminal row past
  `phase_deadline`** as `TIMEOUT`. **Without the reaper, one crashed container
  leaves rows stuck forever.** Not optional, not deferrable — the scheduling
  *feature* is later work, but the state machine, the callback and the reaper are
  foundation.
- **One code path for every trigger.** Form-triggered, chat-triggered and
  schedule-triggered runs differ only in the UI attached to them. A trigger that
  grows its own orchestration means the design has drifted.
- `progress_token` is a **secret**. Store it **hashed** (`progress_token_hash`), the
  same reasoning as session tokens in `tech.md` — a DB leak should not be a
  run-hijack. It must never survive into `RunView` (§ browser-safe projections) or
  into any event, log line or persisted message; the projection guard test covers it.
- `report_runs` only ever gains columns — the additive-migration rule applies with
  full force here, because these rows are the audit trail for delivered documents.

**Two env vars this design requires** that are not yet in `tech.md`'s table — add
them there and to `.env.example` when the state machine is specced:

| Var | Purpose |
|---|---|
| `RPT_CRON_SECRET` | bearer secret authorizing `api/cron/tick` |
| `RPT_APP_BASE_URL` | the app's own public origin, used to build `progress_url` for the invoke context |

`api/cron/tick` is network-exposed and **its only protection is that bearer secret**
— it can claim and invoke runs, so an unauthenticated tick endpoint is a
denial-of-wallet hole. Compare in constant time and fail closed when the var is
unset, rather than defaulting to open.

## The raw archive and replay verification
`collect/archive.py` writes **each Azure batch response as it arrives** to:
```
s3://<RPT_ARTIFACT_BUCKET>/snapshots/<runId>/raw/*.json.gz
```
Write, fold into the accumulators and sketches, **discard the points** — the same
stream-reduce pass, one extra sink. Roughly **8 MB gzipped** for a 200-resource
month at `PT1H`.

> **This composes with stream-reduce and cannot be retrofitted.** Once the points
> are discarded they are gone, so a replay check added later would have to
> re-collect against data that may have shifted. It ships with the collector or it
> never ships. Treat it as a foundation decision, not an optimization.

What it buys:

1. **Replay verification** (`verify/replay.py`) — re-run the **pure** aggregation
   over the stored raw responses and assert a **bit-identical snapshot hash**.
   **Zero Azure calls.** This is the check that actually proves determinism, and it
   is why re-verification does not need to re-query Azure — doing so would nearly
   double the critical path while mostly testing your own aggregation, which a unit
   test proves better and for free.
2. **A bounded drift check** (`verify/drift.py`) replaces any full re-query. Sample:
   **every resource named in the document**, plus **top-10 by max**, plus **10%
   random**, **capped at 25**. Recorded on the verification as
   `drift_sample: {n, method, seed}` — the `seed` is what makes the sample itself
   reproducible, so a disputed check can be re-run identically.
3. **An evidence trail** for the day a customer disputes a figure. This is the whole
   point of an audit artifact: not "we believe the number", but "here is what Azure
   returned."

`report_verifications` records **`snapshot_sha256`**, **`docx_sha256`** and
**`pdf_sha256`**, so an archived report can be re-verified later against **the exact
snapshot it came from** rather than a fresh one. Run comparison needs the same
anchor — a delta between two runs only means something if both snapshots are pinned.
