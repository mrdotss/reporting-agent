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
    ├────────────────────────▶│  (Node server,     │◀──────▶│  report_runs │   │
    │                     │   │   not serverless)  │        │  = the state │   │
    │  GET /reports/[id]  │   │                    │        │    machine   │   │
    │◀────────────────────────┤  lib/runs/         │        └──────────────┘   │
    │  SSE (cosmetic)     │   │  lib/templates/    │                           │
    └─────────────────────│───┤  lib/aws/          │                           │
                          │   └─────────┬──────────┘                           │
                          └─────────────│──────────────────────────────────────┘
      EventBridge ──▶ /api/cron/tick    │  InvokeAgentRuntime
      (at-least-once; the unique        │  (payload: command + context,
       dedupe_key is what makes         │   incl. the decrypted client secret)
       it safe)                         ▼
  ┌──────────────────────────── AWS ─────────────────────────────────────────────┐
  │                                                                              │
  │   ┌───────────────────────────────────────────┐                              │
  │   │  Bedrock AgentCore Runtime                │   POST /api/internal/runs/   │
  │   │  reporting_agent-FxyQJPEWDO   (arm64)     │   [id]/progress              │
  │   │  VPC · 1 subnet · 1 security group        │──────────────────────────────┼──▶ back
  │   │  requireMMDSV2 · idle 900s · max 8h       │   short HMAC-signed calls    │   to the
  │   │                                           │   — these are AUTHORITATIVE  │   app
  │   │  python -m reporting_agent.main           │                              │
  │   │    collect → compile → render → verify    │                              │
  │   └───┬───────────────┬───────────────┬───────┘                              │
  │       │               │               │                                      │
  │       │ boto3         │ boto3         │ Converse (prose only)                │
  │       ▼               ▼               ▼                                      │
  │   ┌────────┐    ┌───────────┐   ┌──────────────┐                             │
  │   │  S3    │    │ DynamoDB  │   │  Bedrock     │                             │
  │   │ mr-    │    │ chat      │   │  zai.glm-5   │                             │
  │   │ harness│    │ history   │   └──────────────┘                             │
  │   └────────┘    └───────────┘                                                │
  │                                                                              │
  │   CodeBuild ──▶ ECR (reporting-agent:latest) ──▶ update-agent-runtime        │
  │   clones GitHub main; pin with --source-version <sha>                        │
  └──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ ClientSecretCredential
                                      │ (the customer's own app registration)
                                      ▼
  ┌──────────────────────────── Azure ───────────────────────────────────────────┐
  │  Resource Graph          inventory, one query per scope + one union query    │
  │                          for child types (subnets, NSG rules)                │
  │  Monitor · batch         /metrics:getBatch, per region, PT1H grain           │
  │  Monitor · ARM fallback  per-resource, when a region answers 403/404         │
  │  Resource SKUs           vCPU and memory capacity, for derived percentages   │
  │  Log Analytics           enhanced tier only                                  │
  └──────────────────────────────────────────────────────────────────────────────┘
```

### Who owns what

| | |
|---|---|
| [`app/`](app/) | Next.js 16 — identity, the customer's Azure credentials, the profile wizard, the run state machine, artifact download authorization. **Talks to Azure never; renders a document never.** |
| [`agent/`](agent/) | Python on AgentCore Runtime — every Azure call, the snapshot, the compiler, both renderers, the verifier. **Reaches Postgres never.** |

The two halves share no code. They share three *declarations*, and each pair is held
together by a test that fails when they drift:

| declaration | agent | app | guard |
|---|---|---|---|
| message catalogue | `messages/catalog.v1.json` | `lib/messages/catalog.ts` | id set **and** value equality |
| emitted CSS classes | `render/html.py::EMITTED_CLASS_NAMES` | `components/reports/paper-classes.ts` | positional — append only |
| profile definition schema | `compile/definition.py` | `lib/templates/definition.ts` | one corpus, both validators, verdicts compared |

### The state machine is Postgres, not the stream

`report_runs` is the source of truth. The agent writes its own terminal state through
short HMAC-signed progress callbacks. The SSE relay is *cosmetic* — if the browser
drops, nothing is lost, because it was never authoritative. That is the one design
decision most worth understanding before changing anything: making a `finally` block
on a long-held HTTP stream authoritative is exactly the fragility that breaks under a
scheduled run.

```
queued → claimed → collecting → compiling → rendering → verifying → completed
                                                                  ↘ failed
```

Seventeen terminal error codes, six of them one per document phase. `PARTIAL_COVERAGE` is
deliberately **not** one: a report with recorded, visible gaps is useful and honest,
and filing it as a failure would hide it.

---

## The pipeline

**Collect** → an immutable snapshot: every value a fixed-precision decimal string,
canonicalized RFC 8785 and hashed. Raw responses are archived to S3 in the same pass,
which is what makes replay possible later.

**Compile** → the snapshot plus the pinned profile version become a typed document
AST. Sections expand through a declarative catalogue (15 Azure sections, 19 block
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

**Narrate** → two single-shot Bedrock calls, prose only.

### What a run leaves behind

```
<actorId>/snapshots/<runId>/snapshot.json      the immutable record; everything traces here
<actorId>/snapshots/<runId>/raw/*.json.gz      the archived responses replay re-aggregates
<actorId>/reports/<runId>/report.docx          the deliverable
<actorId>/reports/<runId>/report.pdf           LibreOffice's conversion of it — gated
<actorId>/reports/<runId>/report-styled.pdf    the styled reading copy — gated, non-blocking
<actorId>/reports/<runId>/document.html        the reading copy's markup
<actorId>/reports/<runId>/ast.json             the compiled document
<actorId>/reports/<runId>/ledger.json          every figure and where it came from
<actorId>/reports/<runId>/prose.json           what the model wrote
<actorId>/reports/<runId>/charts/*.sidecar.json
<actorId>/reports/<runId>/verification-<runId>-<n>.json
<actorId>/logos/<uuid>.png                     a profile's cover logo, fetched at save
<actorId>/signatures/<uuid>.png                an approver's uploaded signature
```

**The actor id is the first segment of every key**, and download authorization is an
exact match on it — `alice-evil` does not match `alice`. That is the whole mechanism;
there is no second check to forget.

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
cd agent && LANG=C.UTF-8 .venv/bin/pytest   # 5044, ~9 minutes
cd app   && pnpm vitest run                 # 3336
```

`LANG=C.UTF-8` is not optional for the agent suite: the end-to-end tests drive real
LibreOffice, which refuses a locale it cannot resolve.

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
migration  →  app  →  runtime
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
