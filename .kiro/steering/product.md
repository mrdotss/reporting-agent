# Product — Infrastructure Utilization Reporting Agent

> Steering for the **whole monorepo**: the Python AgentCore runtime in `agent/`
> and the Next.js web app in `app/`. Unlike the sibling `cold-agent` project, the
> agent here is **not yet built** — both halves are being written together, so
> product decisions bind both sides.

## What it is
A web app where a consultant signs in, connects a customer's **Azure subscription
read-only**, and produces a **verified infrastructure utilization report**: CPU,
memory, disk and network for every VM in scope, over a chosen period. The report
itself is **composed in-app from typed, professionally designed blocks**, on one of
four curated style presets, and delivered as **Word and PDF**. Reports are
archived, comparable run-to-run, and answerable — the user can chat with a report
("why did prod-sql-01 change?") and get an answer grounded in the stored data.

The chat is *agentic*: it streams prose and shows a live timeline of what the
system is doing (enumerating resources, pulling metrics, compiling figures,
rendering, **verifying**, uploading).

## Who it's for
Consultants and managed-service providers who deliver periodic utilization and
right-sizing reports to clients, and who are **accountable for the numbers** in a
document that a client may act on — resizing, decommissioning, renewing a
contract. Secondary: internal platform teams doing the same review for themselves.

Their pain is not "generate a report." It is "generate a report I can sign."

## The invariant — no LLM ever produces a number

**Non-negotiable, and the reason this product exists.** Every numeric that reaches
a delivered document traces to a row in an immutable snapshot, through code that
contains no model call.

| Stage | Who runs it | Produces | Model involved? |
|---|---|---|---|
| **Collect** | deterministic pipeline | an immutable **snapshot** | no |
| **Compile** | deterministic compiler | a **figure ledger** from that snapshot | no |
| **Render** | AST emitters | `.docx` + `.pdf` | no |
| **Verify** | deterministic verifier | a **verification result** proving document ≡ snapshot | no |
| **Narrate** | the model | prose, headings, commentary, Q&A | **yes — prose only** |

The rule is **enforced, not requested**. Prompting a model to avoid inventing
figures is not a control. The verifier is the control:

- **Soundness** — every numeric token in the rendered document must match a
  `formatted` string in the figure ledger. An unmatched numeric is a **hard
  failure**; the report is not delivered. This is what catches a model that wrote
  a number into its prose.
- **Completeness** — every ledger figure should appear at least once. An unused
  figure is a **warning** (a template legitimately may not use everything).

So the model may write *"CPU headroom is substantial on the database tier"*. It may
not write *"CPU averaged 12%"* — that sentence can only exist if the compiler put
`12%` there from the snapshot, and the verifier will delete the report if it did
not.

### Vocabulary (used identically across all six steering docs)
- **snapshot** — the immutable, content-addressed result of one collection run.
  Canonicalized with RFC 8785 (JCS) and hashed; `snapshot_id` *is* that hash.
  Never mutated, never partially rewritten. Re-running collection makes a new one.
- **figure** — one numeric with its full provenance: `value` (a fixed-precision
  **decimal string**, never a JSON number), `formatted` (the exact string the
  renderer must emit), `unit`, `estimator`, `derived_from`, `formula`,
  `resource_id`, `metric`, `window`, `fidelity_tier`.
- **document AST** — the typed tree a compiled template becomes. Its **only**
  numeric leaf is a **figure**, so a number cannot appear in a document without
  provenance — the guarantee is structural, not procedural. Two emitters walk the
  same tree: `.docx` (the delivered artifact) and HTML (the in-app preview).
- **figure ledger** — every figure the compiler emitted for one render, keyed by its
  **AST node path**. Not a parallel structure: the ledger **and the render context
  are the same object**, so they cannot drift out of agreement. The verifier's
  source of truth.
- **verification result** — pass/fail plus every unmatched token and unused
  figure. Stored beside the report; surfaced in the UI. A report without a passing
  verification is not a report.
- **collection_log** — typed, per-resource gaps and errors from the collection
  run (permission denied, metric not emitted, VM deallocated, region unreachable).
  A gap is *recorded*, never silently zero-filled.

## MVP scope
- **Auth** — email/password, custom DB-backed sessions (see `tech.md`).
- **Connect an Azure subscription (wizard)** — a service principal with **Reader
  at subscription scope**, client credentials stored encrypted. The wizard states
  which role and **why**, because customers push back on Reader. Preflight proves
  subscription-scope read before the connection is accepted.
- **Report builder** — an in-app **drag/drop builder** over a palette of **typed,
  professionally designed blocks** (KPI row, resource table, top-N table,
  time-series chart, capacity vs usage, gaps and coverage, verification record,
  methodology appendix, …), arranged as vertical flow plus 2–3 column rows, on one of
  **four curated style presets**. Each block carries its own data scope, so a single
  report can hold "Top 10 VMs by CPU" and "all Storage Accounts by used capacity"
  side by side. Templates are **versioned and immutable once used**, and three
  starter templates ship so the builder is never a blank page.

  **Why composing beats authoring.** Because the user assembles vetted blocks rather
  than writing a document, **every template produces a professional artifact *and*
  every figure keeps its provenance**. Those are two separate promises bought with
  one decision:
  - A user-authored `.docx` makes output quality a function of the author's Word
    skills. "The tables and charts look professional" is a **product requirement**
    here, not a nice-to-have, and it cannot be delegated to the customer.
  - Any expression in a user-authored template — `{{ a / b }}`, `|round`, `|sum` —
    produces a figure with **no provenance**, which defeats the entire verification
    premise. The verifier could not trace it, so it could not prove it.

  So: **no `.docx` upload, no `docxtpl`, no user-facing template language.** A
  template is a versioned JSON definition compiled to a typed AST.
- **Report run** — pick subscription + period + template → deterministic pipeline
  → `.docx` + `.pdf` in S3 → download card. Watch the live activity timeline.
- **Verification surface** — every report shows its verification result: figure
  count, coverage, fidelity tier per resource, and every recorded gap. Verification
  is a first-class UI object, not a log line.
- **Run comparison** — pick two runs of the same subscription → per-resource,
  per-metric deltas, computed from the two snapshots.
- **Ask a report** — chat scoped to one stored report/snapshot. The model reads the
  snapshot and answers; it quotes figures **from the ledger**, never from arithmetic
  it performed itself.
- **Multiple subscriptions**, **multiple templates**, **multiple chat threads**.

## Report period semantics
The customer is **Asia/Jakarta (UTC+7)**. A "July 2026" report means July in
*local* time, not UTC. Collection is therefore bucketed to local days from an
hourly grain — see `azure-integration.md`, which explains why `P1D` is unusable
and `PT1H` is the base grain.

## Two-tier fidelity (a product concept, not just a technical one)
Azure platform metrics give exact averages, minima and maxima with no agent
installed. They do **not** give true percentiles, per-volume disk free space, or
guest-observed memory. Rather than pretend otherwise, every resource carries a
`fidelity_tier`:

- **baseline** — platform metrics only. Exact avg/min/max. Percentiles are
  *estimates* and are labelled as such, everywhere, including inside the document.
- **enhanced** — the customer opted into Azure Monitor Agent + a Data Collection
  Rule. True percentiles, per-volume disk free space, guest-observed memory.

The report says which tier each resource is in. A right-sizing recommendation
built on an estimated percentile is honest about that.

## Future (explicitly out of MVP)
Scheduled monthly runs + email delivery · non-VM resource types (App Service,
AKS node pools, SQL DB DTU) · AWS/GCP collectors behind the same snapshot
contract · cost joined to utilization · multi-tenant client workspaces ·
recommendation engine with commitment modelling.

## Non-negotiables
- **No LLM ever produces a number.** Restated because it is the product.
- The agent is **only** ever invoked from the server.
- Azure `tenant_id` / `client_id` / `client_secret` are **secrets**: encrypted at
  rest, resolved server-side per subscription, **never** sent to or held by the
  browser. The browser sees a masked, secret-free projection.
- **Read-only** to customer subscriptions. Reader at subscription scope, nothing
  that can write, and no customer credential ever leaves the server boundary.
- A snapshot is **immutable**. Corrections make a new snapshot with a new id; the
  old one and any report built from it remain exactly as delivered.
- **No template language, ever.** No `.docx` upload, no `docxtpl`, no user-authored
  expressions. Every numeric leaf in the document AST is a figure carrying its own
  `snapshot_path`, which is what makes provenance structural instead of a rule
  someone has to remember. A template language would reopen the hole.
- A template version is **immutable once used**, and a run pins the exact version it
  rendered. An archived report stays reproducible from its pinned version plus its
  snapshot — a report is an audit artifact, so *every* input gets pinned, not just
  the data.
- **An empty in-scope result is a hard failure, not an empty report.** Zero
  resources means zero figures, which means zero unverifiable figures — a clean
  pass on every other gate. This is precisely what an **expired client secret**
  produces. See `azure-integration.md`; it is the single most likely way this
  product ships a confidently wrong artifact.
- Every figure in a delivered document is verified, or the document is not
  delivered. There is no "verification failed but here it is anyway" path.
