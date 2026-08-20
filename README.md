# reporting-agent

Collects Azure utilization metrics, renders a Word and PDF report from a
user-designed template, and **proves every figure in the document traces back to
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

---

## The two halves

```
Browser ──POST /api/reports──▶ Next.js ──InvokeAgentRuntime──▶ AgentCore Runtime
   │                            │ inserts report_runs row              │
   │                            │ returns {runId} immediately          │ ClientSecretCredential
   └── GET .../stream ──────────┘                                      ▼
        (cosmetic view over run state)              Resource Graph · Azure Monitor
                                  ▲                                    │
                    POST /api/internal/runs/[id]/progress               │
                    (short HMAC-signed calls from the agent)            │
                                        snapshot + raw/*.json.gz + docx + pdf ──▶ S3
```

| | |
|---|---|
| [`app/`](app/) | Next.js 16 — auth, subscriptions, the template wizard, report pages, the run state machine |
| [`agent/`](agent/) | Python on Bedrock AgentCore Runtime (arm64) — collect, compile, render, verify |

**Postgres `report_runs` is the state machine.** The agent writes its own terminal
state through short HMAC-signed progress callbacks. The SSE relay is *cosmetic* — if
the browser drops, nothing is lost, because it was never the source of truth. That
is the one design decision most worth understanding before changing anything: making
a `finally` block on a long-held HTTP stream authoritative is exactly the fragility
that breaks under a scheduled run.

---

## The pipeline

**Collect** → an immutable snapshot, every value a fixed-precision decimal string,
canonicalized RFC 8785 and hashed. Raw responses are archived to S3 in the same pass.

**Compile** → the snapshot plus the pinned template version become a typed document
AST. Every figure records the snapshot path it came from.

**Render** → `python-docx` against a styles-only theme, then LibreOffice to PDF.

**Verify** → anchored cell equality on tables, ordered masking on prose, bidirectional
ledger completeness, chart data hashes, PDF extractability, and a **deterministic
replay** that re-runs the aggregation over the archived raw responses and asserts a
bit-identical snapshot. Any blocking finding withholds the document.

**Narrate** → two single-shot Bedrock calls, prose only.

---

## Quickstart

Both halves have their own README with the real detail; start there.

```bash
cd app   && pnpm install && pnpm db:migrate && pnpm dev
cd agent && uv venv && uv pip sync requirements-dev.lock && pytest
```

- **[`app/README.md`](app/README.md)** — environment, database, running locally, tests
- **[`agent/README.md`](agent/README.md)** — Python setup, dependency locking, building
  the arm64 image, deploying to AgentCore Runtime, troubleshooting

## Tests

```bash
cd agent && pytest          # ~2980
cd app   && pnpm vitest run # ~2200
```

Property tests use hypothesis (agent) and fast-check (web). The
[`agent/tests/fixtures/definitions/`](agent/tests/fixtures/definitions/) corpus is
read by **both** languages so the two template validators are compared head to head
rather than each against itself.

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
alone changes nothing running. See
[`agent/README.md`](agent/README.md#deploying-to-agentcore-runtime), particularly the
warning that `update-agent-runtime` is a full replace.

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
