# AgentCore integration (how the web app talks to the agent)

The **reporting runtime** in `agent/` is the app's backend brain and the only place
Azure is ever touched. Its authoritative contract — request/response shapes,
reference route handlers, onboarding — belongs in `agent/AGENTCORE_INTEGRATION.md`.

> `agent/` does not exist yet. When it is created, add
> `#[[file:agent/AGENTCORE_INTEGRATION.md]]` to this doc so the contract is pulled
> into context automatically, the way `cold-agent` does it. Until then, this file is
> the contract, and the two must be reconciled the moment the agent lands.

## Invocation
- Call **`InvokeAgentRuntime`** (`@aws-sdk/client-bedrock-agentcore`) from the
  **server only** — the browser has no AWS credentials and must never hold an Azure
  secret.
- ARN comes from **`process.env.RPT_RUNTIME_ARN`** (never hardcode).
- `runtimeSessionId`: **33–128 chars**, **stable per chat thread** — persist a
  `threadId → sessionId` mapping so memory is continuous; a new thread gets a new
  id. `lib/session-id.ts` owns generation and the length invariant.
- `accept: text/event-stream`; relay the SSE through a **Node-runtime** route
  (`export const runtime = "nodejs"`), buffering disabled.
- The container is **arm64**. A local `docker build` on x86 without
  `--platform linux/arm64` produces an image the runtime will not start.

### Deployment and proxy timeouts
**p99 for a report run is 8–12 minutes.** That number decides where this can run:

- **Deploy Next.js on a Node server, not a serverless platform.** Vercel's **300s**
  function cap is already past for a typical run, and a hard platform ceiling is not
  something the reaper or the progress callback can engineer around.
- **Raise the proxy timeouts.** **CloudFront** defaults to a **30s**
  origin-response timeout (**60s** maximum) and **ALB** to a **60s** idle timeout.
  **These kill SSE far more often than app-level limits do** — the app looks
  healthy, the run is genuinely still going, and the connection is simply gone.
- Because the relay is cosmetic (below), a proxy killing a stream is survivable
  rather than fatal. Still fix it: a stream that dies every 30s makes the live
  activity timeline useless, which is most of the product's perceived responsiveness.

## Payload `context`
```jsonc
{
  "actor_id": "<app user id>",              // REQUIRED — drives memory + artifact prefix
  "subscription_id": "<azure subscription>",
  "tenant_id": "<secret>",                  // server-resolved, never from the browser
  "client_id": "<secret>",                  // server-resolved
  "client_secret": "<secret>",              // server-resolved, decrypted at invoke time
  "timezone": "Asia/Jakarta",               // default; drives local-day bucketing
  "display_name": "<customer label>",
  "fidelity_tier": "baseline",              // "baseline" | "enhanced"
  "log_analytics_workspace_id": null,       // enhanced tier only

  "run_id": "<runId>",
  "progress_url": "https://<app>/api/internal/runs/<runId>/progress",
  "progress_token": "<secret>"              // run-scoped HMAC — SECRET, never echoed
}
```
- `actor_id` is **required** — it scopes memory and the S3 artifact prefix.
- `tenant_id` / `client_id` / `client_secret` are **secrets**: looked up
  **server-side** for the selected subscription, decrypted with
  `APP_ENCRYPTION_KEY` at invoke time, never accepted from or exposed to the
  browser, never logged, never echoed in an event.
- **`progress_token` is a secret too, and gets exactly the `client_secret`
  treatment**: registered with the runtime's **redaction guard** and added to the
  app's **SSE redaction key list**. It must never appear in an event, a log line,
  or a persisted message. It is **run-scoped** — one token per run, minted at
  enqueue, useless once the run reaches a terminal state.
  > Easy to under-rate because it is "only" an internal callback credential. It
  > authorizes writes to the run state machine, so a leaked token lets someone
  > mark a run `completed`. Treat it as a credential, not as a correlation id.
- `progress_url` / `run_id` are what let the agent advance its own state — see
  **Run orchestration** below.
- `timezone` defaults to `Asia/Jakarta`. It is not cosmetic — it determines day
  bucketing and therefore every daily figure. See `azure-integration.md`.

## Deterministic commands (no model in the loop)
**Report generation is a `command`, not a `prompt`.** The product invariant means
the deterministic pipeline must be reachable without the model deciding to call a
tool. The UI's "Generate report" button sends a command; the runtime skips the model
entirely and drives collector → compiler → renderer → verifier → upload, emitting
the same event stream.

```jsonc
// Generate a report
{ "command": "generate_report",
  "period": { "start": "2026-07-01", "end": "2026-07-31" },  // local dates, in `timezone`
  "template_id": "<template>",
  "scope": { "resource_groups": [], "resource_types": ["Microsoft.Compute/virtualMachines"] },
  "context": { /* … */ } }

// Compare two completed runs (reads two snapshots; no Azure calls)
{ "command": "compare_runs", "run_a": "<runId>", "run_b": "<runId>", "context": { /* … */ } }

// Re-verify a stored document against its stored snapshot
{ "command": "verify_report", "run_id": "<runId>", "context": { /* … */ } }

// Preflight a connection: assert subscription-scope read, probe fidelity
{ "command": "preflight", "context": { /* … */ } }
```

A `prompt` payload is for **chat only** — prose and Q&A about an existing report.
When a prompt is scoped to a report, pass `run_id` alongside it; the model reads
that run's snapshot and ledger and quotes figures **from the ledger**.

## Run orchestration — Postgres is the state machine

A run is minutes long, so the orchestration question is not "how do we keep the
browser informed" but "what is authoritative when something dies mid-run."

> **Rejected design, recorded so it does not get reinvented:** having
> `lib/actions/runs.ts` consume the `generate_report` stream server-side, so the run
> survives the user closing the tab. **Surviving a closed tab is not the hard case.**
> That server-side consumer still dies on a Next.js restart, a deploy roll, or a
> request timeout — and the row then sits in `collecting` **forever**, because
> nothing sweeps it. **Making a long-held HTTP stream the source of truth is the
> fragility, not the fix.**

### `report_runs.status` is authoritative
```
queued → claimed → collecting → compiling → rendering → verifying
       → completed | failed
```
The columns the machine needs to actually work: **`dedupe_key` (UNIQUE)**,
`claimed_at`, `claimed_by`, `updated_at`, `phase_deadline`, `error_code`,
`error_message`.

### The agent writes its own state
At **every phase transition** the runtime fires a short, **fire-and-forget POST** to
`/api/internal/runs/[runId]/progress`. Four or five tiny independent requests per
run — **none long-lived, none able to time out the way a stream can**.

Authorized by the run-scoped HMAC **`progress_token`** passed in the invoke
`context` alongside the Azure credentials (above). The endpoint validates the token
against the run, applies the transition, and returns immediately.

Phase transitions therefore travel **two independent paths**, and the distinction
matters:

| path | purpose | if it fails |
|---|---|---|
| **progress callback → Postgres** | **authoritative persistence** | the reaper eventually times the run out |
| **SSE event → browser** | live view for whoever is watching | nothing is lost |

### The SSE relay is cosmetic
`api/runs/[runId]/stream` is a **live view over run state** for a browser that
happens to be watching. **If it drops, nothing is lost** — on reconnect the client
replays from the row.

Consequence worth designing for on purpose: form-triggered, chat-triggered and
schedule-triggered runs **share one code path** with different UI attached. If a
trigger grows its own orchestration, the design has drifted.

### A reaper is mandatory
`/api/cron/tick`, **bearer-secret authorized**:

1. **Claim due work atomically**, then invoke, then **return in seconds**. It never
   waits for a run.
   ```sql
   UPDATE report_runs SET status='claimed', claimed_at=now(), claimed_by=$1
   WHERE id IN (SELECT id FROM report_runs WHERE status='queued'
                ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10)
   RETURNING *;
   ```
   `FOR UPDATE SKIP LOCKED` is what makes concurrent ticks safe — two overlapping
   ticks claim disjoint sets instead of racing for the same rows.
2. **Fail any non-terminal row past its `phase_deadline`** as `failed` /
   `TIMEOUT`.

**Without the reaper, one crashed container leaves rows stuck forever.** This is
the part that pages you at 3am, so it is **not optional and not deferrable**. The
scheduling *feature* is later work; the **state machine, the progress callback and
the reaper are foundation** and land with the first spec.

`lib/actions/runs.ts` **enqueues** — it inserts a `queued` row with a `dedupe_key`
and returns. It does not hold a stream open, and it does not own run state.

## SSE events → UI
| Event | Payload | UI |
|---|---|---|
| `delta` | `{text}` | append to the assistant message (markdown, tables, code chips) |
| `tool` | `{phase:"start", id, name, label, status}` | add a step to the live activity timeline; show `status` + `label`, spinner |
| `tool` | `{phase:"end", id, name}` | mark that step complete (match `id`) |
| `progress` | `{id, done, total, unit, label}` | update the step's determinate progress bar — `142 / 200 resources` |
| `heartbeat` | `{ts}` | keep-alive during long silent stretches; reset the client idle timer, render nothing |
| `snapshot_ready` | `{snapshot_id, resource_count, window, grain, gaps}` | collection is done and immutable — show provenance + the gap list; the report is now reproducible |
| `chart` | `{spec}` | render **inline, client-side** from the structured spec — no image, no presign |
| `verification` | `{status, figure_count, unmatched, unused, snapshot_id, replay, drift_sample}` | render the verification panel; `status:"fail"` means **no artifact is coming** |
| `report_file` | `{key, bucket, kind:"docx"\|"pdf", bytes}` | presign `key` server-side → render the download card once the URL is ready |
| `error` | `{message, code, terminal}` | show the error (already redacted); `terminal:true` ends the run |
| `done` | `{run_id, status}` | end the turn; collapse the timeline into a summary |

Ordering guarantees the UI may rely on:
`snapshot_ready` precedes any `verification`; `verification` with `status:"pass"`
precedes every `report_file`; `done` is always last. **A `report_file` must never
arrive without a passing `verification` before it** — if the UI sees one, treat it
as a contract violation and refuse to present the download.

Tool `name`s: `collect_inventory`, `collect_metrics`, `compile_figures`,
`render_document`, `verify_document`, `upload_artifact`, `compare_snapshots`.
Ignore unknown future event types gracefully — an older client must degrade, not
crash.

`verification.replay` and `verification.drift_sample` come from the replay check
against the archived raw responses — **zero Azure calls**, asserting a bit-identical
snapshot hash, with a bounded sampled drift check instead of a full re-query. The
mechanism and the sampling rule live in `structure.md`.

**Events are a view, not the record.** A client that missed events replays from
`report_runs` plus the stored `verification` result; it never asks the agent to
re-send. Any UI state that cannot be reconstructed from the row is UI state that
will be wrong after a reconnect.

### `heartbeat` is not optional
Inventory and metrics collection can run for minutes with nothing to say. Without a
heartbeat, intermediaries close an idle SSE connection and the run looks failed
while it is in fact still working. Emit on a fixed interval; the client treats a
missed heartbeat window, not a slow response, as the disconnect signal.

## Charts (inline, client-rendered)
The agent emits a `chart` event carrying **structured data**, not an image:
```json
{ "type": "chart",
  "spec": { "id": "c1", "chart_type": "bar|hbar|line|area|heatmap",
            "encoding": "categorical",
            "title": "Top 5 VMs by Average CPU — July 2026",
            "unit": "%", "series": [{ "key": "cpu", "label": "Percentage CPU",
                                      "points": [{ "x": "prod-web-01", "y": "12.4" }] }],
            "figure_refs": ["fig_0412", "fig_0413"] } }
```
- `encoding` (`"categorical"` | `"sequential"`) selects the palette — see
  `design-system.md`. The agent decides; the client must not guess from series count.
- `y` values are **decimal strings**, matching the snapshot. Parse for layout only;
  render the label from the ledger.
- `figure_refs` ties every plotted value back to the ledger, so an in-app chart is a
  view of verified figures rather than a second computation.
- Static chart images are generated **separately, server-side**, for embedding into
  the `.docx`/`.pdf`. In-app charts always use the spec.

## Artifacts
Snapshots, figure ledgers, verification results and documents are **private** S3
objects under an `actor_id` prefix, tagged with `owner-actor-id`. Mint a short-lived
presigned GET **server-side** (`@aws-sdk/s3-request-presigner`,
`RPT_ARTIFACT_BUCKET`) and authorize that the key's actor prefix matches the
signed-in user. Never store a presigned URL; never return one in a cacheable
payload.

## Failure modes the app must handle explicitly
`error` events carry a `code`. These are not interchangeable, and flattening them
into "something went wrong" removes the only signal the user can act on:

| `code` | Meaning | UI |
|---|---|---|
| `AUTH_EXPIRED` | the Azure client secret has expired | terminal; banner + "rotate the secret" CTA on the subscription |
| `SCOPE_UNVERIFIED` | subscription-scope read could not be asserted | terminal; block the run, explain the Reader requirement |
| `EMPTY_SCOPE` | the **run's union of all block scopes** resolved to zero resources | **terminal failure, never an empty report** |
| `VERIFICATION_FAILED` | document and snapshot disagree | terminal; show unmatched tokens, no download |
| `THROTTLED` | Azure rate limits exhausted after retries | retryable; surface the wait |
| `PARTIAL_COVERAGE` | some resources unreadable | **not** terminal; the run continues, gaps land in `collection_log` |
| `TIMEOUT` | the reaper found a non-terminal row past `phase_deadline` | terminal; **written by the app, never by the agent** — by definition the agent may already be gone |

`TIMEOUT` is the one code that arrives without an `error` event, because there is no
stream left to carry it. The UI must therefore read terminal state from
`report_runs.error_code`, not only from events — which is the same rule as above:
the row is the record.

`EMPTY_SCOPE` deserves the emphasis: an expired secret or an over-narrow role
produces zero resources, therefore zero figures, therefore zero unverifiable
figures — a **clean pass on every other gate**. Both the runtime and the app treat
an empty in-scope result as a hard failure. See `azure-integration.md`.

**"In-scope" means the run's union of all block scopes**, not any single block's.
Blocks carry per-block scope overrides, and the collector fetches the union once into
one snapshot, so the union is the only measure that matches what was collected.

- **Union resolves to zero → `EMPTY_SCOPE`**, terminal. Unchanged in force: this is
  the gate that stops a clean, fully-verified, empty report from shipping.
- **One block resolves to zero → not a failure.** That block renders an explicit
  "No resources matched this scope" row and the run continues normally. It must never
  silently vanish; a disappeared block looks identical to one that was never
  configured.

There is **no event** for a zero-resource block — it is ordinary compile output, not
an error, so it produces neither an `error` event nor a `collection_log` gap.

## Deployed values (git-ignored `.env`)
`RPT_RUNTIME_ARN=…:runtime/<RUNTIME_ID>` · `AWS_REGION=us-east-1` ·
`RPT_ARTIFACT_BUCKET=<ARTIFACT_BUCKET>` · `RPT_HISTORY_TABLE=rpt-chat-history`.
Commit only placeholders to `.env.example`.
