# reporting-agent

Collects Azure utilization metrics, renders a Word and PDF report from a
user-designed profile, and **proves every figure in the document traces back to
collected source data**.

The proof is the product. Anyone can generate a document full of numbers; this one
carries a verification record stating which figures were checked, how, and against
what — and refuses to deliver the document if any check fails.

---

## The invariant

**No LLM ever produces a number.**

A deterministic pipeline collects into an immutable snapshot. A compiler emits
figures from that snapshot and nothing else. A verifier proves the document and the
snapshot agree. The model writes prose and answers questions — that is its whole job.

This is structural, not a rule anyone has to remember. The only numeric leaf in the
document AST is a `Figure(value, unit, snapshot_path, formatted, estimator?)`, so
there is no way to put a number in the document except as one, and the figure ledger
*is* the render context — they cannot drift because they are the same object.

Prose that mentions a number is checked the other way round: every numeric token in
every paragraph is masked against the ledger, the document's own static chrome and a
short allowlist, and **anything still carrying a digit is a blocking finding**. A
sentence the model invented a figure for does not ship.

---

## Topology

```
                          ┌──────────────────────────── your infrastructure ──┐
  Browser                 │                                                    │
    │                     │   ┌────────────────────┐        ┌──────────────┐   │
    │  session cookie     │   │  Next.js 16        │        │  Postgres    │   │
    ├────────────────────────▶│  (Node server,     │◀──────▶│  10 tables   │   │
    │                     │   │   not serverless)  │        │  report_runs │   │
    │  GET /reports/[id]  │   │                    │        │  = the state │   │
    │◀────────────────────────┤  22 API routes     │        │    machine   │   │
    │  SSE (cosmetic)     │   │  13 pages          │        └──────────────┘   │
    └─────────────────────│───┤                    │                           │
                          │   └─────────┬──────────┘                           │
                          └─────────────│──────────────────────────────────────┘
      EventBridge ──▶ /api/cron/tick    │  InvokeAgentRuntime
      (at-least-once; the unique        │  6 commands · payload + context
       dedupe_key is what makes         │  (incl. the decrypted client secret)
       it safe)                         ▼
  ┌──────────────────────────── AWS ─────────────────────────────────────────────┐
  │   ┌───────────────────────────────────────────┐                              │
  │   │  Bedrock AgentCore Runtime                │   POST /api/internal/runs/   │
  │   │  reporting_agent-FxyQJPEWDO   (arm64)     │   [id]/progress              │
  │   │  VPC · 1 subnet · 1 security group        │──────────────────────────────┼──▶ back
  │   │  requireMMDSV2 · idle 900s · max 8h       │   [id]/verification          │   to the
  │   │                                           │   short HMAC-signed calls    │   app
  │   │  python -m reporting_agent.main           │   — these are AUTHORITATIVE  │
  │   │    collect → compile → render → verify    │                              │
  │   └───┬───────────────────────────────┬───────┘                              │
  │       │ boto3                         │ Converse (prose only, ≤13 calls)     │
  │       ▼                               ▼                                      │
  │   ┌──────────────────┐          ┌──────────────┐                             │
  │   │  S3  mr-harness  │          │  Bedrock     │                             │
  │   │  snapshots ·     │          │  zai.glm-5   │                             │
  │   │  raw · reports   │          └──────────────┘                             │
  │   └──────────────────┘                                                       │
  │                                                                              │
  │   CodeBuild ──▶ ECR (reporting-agent:latest) ──▶ update-agent-runtime        │
  │   clones GitHub main; pin with --source-version <sha>                        │
  └──────────────────────────────────────────────────────────────────────────────┘
                                      │  ClientSecretCredential
                                      ▼  (the customer's own app registration)
  ┌──────────────────────────── Azure ───────────────────────────────────────────┐
  │  Resource Graph          inventory; one query per scope + a union query for  │
  │                          child types (subnets, NSG rules)                    │
  │  Monitor · batch         /metrics:getBatch, per region, PT1H grain           │
  │  Monitor · ARM fallback  per-resource, when a region answers 403/404         │
  │  Resource SKUs           vCPU and memory capacity, for derived percentages   │
  │  Log Analytics           enhanced tier · AzureMetrics beyond the 93-day wall │
  │  ── facts, not metrics ──────────────────────────────────────────────────────│
  │  advisor                 recommendations — one row per finding               │
  │  recovery_services       backup protection + replication health (2 APIs)     │
  │  capacity                reservations                                        │
  └──────────────────────────────────────────────────────────────────────────────┘
```

### Inside the runtime

```
main.py                 invoke router · 6 commands · StepTracker · heartbeat · redaction
  └─ report_pipeline.py phase driver · progress callbacks · artifact upload
      │
      ├─ providers/  ports — the only seam Azure is allowed through (3 modules)
      │    └─ azure/     resource_graph · monitor batch · ARM fallback · skus
      │                  log_analytics · facts · inventory · clients      (12)
      │
      ├─ collect/    buckets     window + grain geometry, trend months (≤24)
      │              accumulate  count-weighted avg, min/max, sample counts
      │              sketch      FixedHistogram → percentiles, never bare
      │              archive     raw responses → S3, gzipped, sequenced
      │              snapshot    decimals → RFC 8785 → sha256 = snapshot_id   (12)
      │
      ├─ catalog/    metrics.v1.json · facts.v1.json · sections.v1.json
      │              7 metric types · 14 fact types (4 sources) · 3 child types
      │              15 sections
      │
      ├─ compile/    definition     schema v1–v3 validator, 22 block types
      │              sections       catalogue expansion, per: section | resource
      │              snapshot_view  one indexing walk, pointers + cardinalities
      │              figures        the ledger — figure ⇄ snapshot_path
      │              blocks/        21 compilers                              (12)
      │
      ├─ render/     docx · pdf (LibreOffice) · html · printcss (WeasyPrint)
      │              charts · chartstyle · tablefit · themes · toc
      │              front_matter · anchors · thumbnails                      (14)
      │
      ├─ verify/     12 gates + replay · masking · allowlist · findings       (17)
      │
      ├─ narrate/    the ONLY Bedrock client in the tree                       (3)
      └─ storage/    S3 object store                                           (3)
```

### Inside the app

```
app/
  (app)/  dashboard · subscriptions[/new /[id]/scan] · report-profiles[/[id]/edit]
          reports[/[runId]] · templates[/[id]/edit]                    13 pages
  (auth)/ login · register
  api/    runs · runs/[runId][/stream] · runs/reusable · artifact-url
          subscriptions[/test /[id]/scan /[id]/inventory /[id]/secret]
          report-profiles[/catalog /[id][/preview] /signature]
          internal/runs/[runId]/progress · /verification  ← HMAC, agent-only
          cron/tick                                       ← EventBridge
                                                                       22 routes
lib/
  runs/          state machine, enqueue, reaper, relay, progress schema    (23)
  templates/     definition schema, versions, store, composer, lift        (36)
  profiles/      offerability, estimates, wizard state                     (15)
  subscriptions/ connection, encrypted secret, scope verification          (14)
  scans/         inventory view, dimension counts, reportability            (8)
  aws/           AgentCore invoke, SigV4, streaming                        (11)
  auth/          sessions, lockout, password                                (7)
  validation/ · messages/ · actions/ · api/ · db/ · reports/ · verifications
```

### The invoke contract

| command | what it does | writes |
|---|---|---|
| `generate_report` | the full pipeline | snapshot, 3 artifacts, ledger, verification |
| `preflight` | credential + scope check before a connection is saved | nothing |
| `list_inventory` | Resource Graph counts for the scan page | scan row |
| `render_preview` | compile + render a draft definition, ungated | `previews/<id>/` |
| `verify_report` | recompile a stored run and re-verify it | a verification attempt |
| `compare_runs` | **declared, unrouted** — a comparison is a block, not an invocation | — |

### Data stores

```
Postgres   users · sessions · login_attempts · connected_subscriptions
           report_runs · report_templates · report_template_versions
           report_verifications · subscription_scans
           report_profile_authored_matches                        16 migrations

S3         <actorId>/snapshots/<runId>/snapshot.json      the immutable record
           <actorId>/snapshots/<runId>/raw/*.json.gz      what replay re-aggregates
           <actorId>/reports/<runId>/report.docx          the deliverable
                                    /report.pdf           LibreOffice — gated
                                    /report-styled.pdf    reading copy — non-blocking
                                    /document.html  /ast.json  /ledger.json
                                    /prose.json     /charts/*.sidecar.json
                                    /verification-<runId>-<n>.json
           <actorId>/logos/<uuid>.png      <actorId>/signatures/<uuid>.png
```

**The actor id is the first segment of every key**, and download authorization is an
exact match on it — `alice-evil` does not match `alice`. That is the whole mechanism;
there is no second check to forget.

### Who owns what

| | |
|---|---|
| [`app/`](app/) | Next.js 16 — identity, the customer's Azure credentials, the profile wizard, the run state machine, artifact download authorization. **Talks to Azure never; renders a document never.** |
| [`agent/`](agent/) | Python on AgentCore Runtime — every Azure call, the snapshot, the compiler, both renderers, the verifier. **Reaches Postgres never.** |

The two halves share no code. They share three *declarations*, each held together by a
test that fails when they drift:

| declaration | agent | app | guard |
|---|---|---|---|
| message catalogue | `messages/catalog.v1.json` | `lib/messages/catalog.ts` | id set **and** value equality |
| emitted CSS classes | `render/html.py::EMITTED_CLASS_NAMES` | `components/reports/paper-classes.ts` | positional — append only |
| profile definition schema | `compile/definition.py` | `lib/templates/definition.ts` | one corpus, both validators, verdicts compared |

### The state machine is Postgres, not the stream

`report_runs` is the source of truth. The agent writes its own terminal state through
short HMAC-signed progress callbacks. The SSE relay is *cosmetic* — if the browser
drops, nothing is lost, because it was never authoritative.

```
queued ──▶ claimed ──▶ collecting ──▶ compiling ──▶ rendering ──▶ verifying ──▶ completed
   │          │            │              │             │             │
   └──────────┴────────────┴──────────────┴─────────────┴─────────────┴──────▶ failed
                           └──▶ completed          (a snapshot-only run has no document)
```

Three writers move a run: the enqueue inserts `queued`, the reaper takes
`queued → claimed`, the agent's callbacks drive the rest. `verifying → completed`
carries a precondition no table can express — the endpoint reads a `report_verifications`
row with status `pass` **in the same transaction**, so no ordering exists in which a run
reports success before its proof is stored.

**15 error codes**, one per failure mode a caller can act on. `PARTIAL_COVERAGE` is the
only non-terminal one: a report with recorded, visible gaps is useful and honest, and
filing it as a failure would hide it.

---

## The pipeline

**Collect** → an immutable snapshot: every value a fixed-precision decimal string,
canonicalized RFC 8785 and hashed. Raw responses are archived to S3 in the same pass,
which is what makes replay possible later.

**Compile** → the snapshot plus the pinned profile version become a typed document
AST. Sections expand through a declarative catalogue (15 Azure sections, 22 block
types); every figure records the snapshot path it came from.

**Render** → three artifacts from one AST: `python-docx` against a styles-only theme,
LibreOffice to PDF, and a styled HTML reading copy. Two emitters over one AST rather
than two layouts, because two statements of one layout is one layout and one latent
bug.

**Verify** → twelve gates, all of which must be recorded or the verification fails for
being incomplete:

| gate | what it proves |
|---|---|
| `extraction` | the `.docx` yields text at all |
| `tables` | each ledger figure equals the text of the cell it is anchored to |
| `prose` | no numeric token survives masking — the anti-hallucination gate |
| `completeness` | the ledger and the document cover each other, both directions |
| `charts` | each chart's data hash matches its plotted series |
| `replay` | re-aggregating the archived raw responses reproduces a bit-identical snapshot |
| `coverage` | every declared-but-uncollected value is a recorded gap |
| `pdf` | every `formatted` string is present, *bounded*, in the converted PDF |
| `facts` | every text fact equals its cell, character for character |
| `toc` | the contents' page numbers were measured, not guessed |
| `historical` | a plotted prior-period point came from a run that itself passed |
| `derived_counts` | every compile-derived integer re-derives from the ledger |

Any blocking finding withholds the document.

**Narrate** → single-shot Converse calls, prose only. Three narrations are declared —
`executive_summary`, `trend`, `resource` — and the shipped catalogue places two of them:
one trend commentary, and one review per machine, capped at 12. Every one is bounded, and
an answer quoting a figure it was not shown is **refused whole** before it enters the
document, so a narrator that invents costs a paragraph rather than the report.

### What a run leaves behind

See [Data stores](#data-stores) for the key layout. Every artifact but the three
deliverables exists so a later re-verification can read it back: the archive is what
`replay` re-aggregates, the ledger is what the recompile is compared against, and
`prose.json` is what a recompile narrates with rather than asking the model twice.

---

## Quickstart

Both halves have their own README with the real detail; start there.

```bash
cd app   && pnpm install && pnpm db:migrate && pnpm dev
cd agent && uv venv --python 3.12 .venv && uv pip install --require-hashes -r requirements-dev.lock && .venv/bin/pytest
```

- **[`app/README.md`](app/README.md)** — environment, database, the run state machine,
  the wizard, running locally, deployment
- **[`agent/README.md`](agent/README.md)** — Python setup, dependency locking, the
  catalogues, building the arm64 image, deploying to AgentCore Runtime, troubleshooting

## Tests

```bash
cd agent && LANG=C.UTF-8 .venv/bin/pytest   # 5242 in 148 files, ~9 minutes
cd app   && pnpm vitest run                 # 3343 in 160 files
cd app   && pnpm build                      # the check the tests cannot make
```

`LANG=C.UTF-8` is not optional for the agent suite: the end-to-end tests drive real
LibreOffice, which refuses a locale it cannot resolve.

`pnpm build` earns its line: a `server-only` import pulled across a `"use client"`
boundary passes every test and fails the build.

Five build assertions run **only inside the image**, because they need WeasyPrint and
LibreOffice — a green suite says nothing about them:

```bash
docker run --rm -v "$PWD/agent/src/reporting_agent:/app/reporting_agent:ro" <image> \
  sh -c 'for g in compile.ast render.themes catalog.evidence compile.literals \
                  render.printcss; do python -m reporting_agent.$g --assert-build; done'
```

Property tests use hypothesis (agent) and fast-check (web), both held to a floor of
accepted cases — a property that shrinks to a trivial space fails on that ground
alone. Two corpora are read by **both** languages so the halves are compared head to
head rather than each against itself:

- [`agent/tests/fixtures/definitions/`](agent/tests/fixtures/definitions/) — the
  profile definitions both validators must agree about
- [`agent/tests/fixtures/emit-estimate/cases.json`](agent/tests/fixtures/emit-estimate/)
  — what the wizard's estimate and the real compiler must both say a section emits

---

## Deploying a change

Order matters when a change spans both halves:

```
  migration ──▶ app ──▶ runtime

  git push ──▶ CodeBuild ──▶ ECR ──▶ update-agent-runtime ──▶ DEFAULT endpoint
   (main)      --source-      :latest    full replace          liveVersion
               version <sha>             + requireMMDSV2       auto-tracks
                                         − requireServiceS3Endpoint
```

The runtime is the only component that can present values the database must already
accept. Shipping it first means its callbacks are refused, which looks exactly like
the bug you were fixing.

Building the image is safe at any time — an AgentCore runtime resolves its `:latest`
container URI when a **version** is created, not when an image is pushed, so a build
alone changes nothing running.

CodeBuild clones GitHub `main`, so **push before building**, and pin the build with
`--source-version <sha>` rather than trusting whatever `main` happened to be. See
[`agent/README.md`](agent/README.md#deploying-to-agentcore-runtime), particularly the
warning that `update-agent-runtime` is a full replace: every field you do not pass is
deleted, and `requireServiceS3Endpoint` is returned by `get` and rejected by `update`.

### A profile change is not a deploy

Two things a new runtime version will **not** change on its own, because they live in
the stored profile version rather than in code:

- **The cover logo and the confidentiality notice** are resolved into a version when
  it is saved. Editing a Brand changes the *next* version, never a report already
  delivered — that is the guarantee, not an oversight.
- **Number formatting** is pinned the same way. `number_format.trim_trailing_zeros`
  defaults to `false`, so a report delivered before the key existed still re-verifies
  byte-identically; every version saved since declares it explicitly.

So: after a deploy that changes either, the profile has to be re-saved through the
wizard before a run reflects it.

---

## Where the design lives

`.kiro/steering/` holds the binding documents. They are not background reading;
several of them exist because getting the fact wrong cost a production run.

| file | what it governs |
|---|---|
| `product.md` | the product and the no-LLM-numbers invariant |
| `tech.md` | stack, guardrails, and what a green test suite does not prove |
| `structure.md` | directory layout and module boundaries |
| `design-system.md` | tokens, components, the report and verification surfaces |
| `agentcore-integration.md` | the invoke contract, run orchestration, deployment mechanics |
| `azure-integration.md` | verified Azure facts — aggregation correctness, batching, SDK traps |

`azure-integration.md` in particular records constraints that are **binding, not
advisory**: `avg` is count-weighted and never the mean of interval averages;
percentiles do not roll up and are never emitted bare; the base grain is `PT1H`
because `P1D` buckets are UTC-aligned and the customer is `Asia/Jakarta`.

`.kiro/specs/` holds the four requirement specs the code cites by number. A comment
saying `Req 18.4` means that document, and the requirement is usually the reason the
code looks the way it does rather than a simpler way.
