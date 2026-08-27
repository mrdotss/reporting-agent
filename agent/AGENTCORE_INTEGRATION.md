# The invoke contract

The authoritative description of what the web app sends the runtime and what comes back.
`.kiro/steering/agentcore-integration.md` includes this file, so the two cannot drift.

Everything below is what the runtime *does*, not what it should do. Where a field is
declared and unread, or a command declared and unrouted, it says so — an omission a reader
has to infer is an omission somebody re-implements.

---

## The `context`, unchanged

Twelve fields, identical for every command. The web app builds it; the runtime never
constructs one.

| Field | Notes |
|---|---|
| `actor_id` | The signed-in user. **The first segment of every artifact key**, which is what makes download authorization an exact segment comparison. |
| `run_id` | The `report_runs` row this invocation drives. |
| `subscription_id` | The Azure subscription. |
| `tenant_id`, `client_id` | Not secrets. |
| `client_secret` | 🔒 Registered with the redaction guard at parse; never in a log, an event or a callback body. |
| `timezone` | IANA name. `Asia/Jakarta` in practice; the base grain is `PT1H` so local-day bucketing happens client-side. |
| `fidelity_tier` | `baseline` or `enhanced`, decided by the preflight. |
| `log_analytics_workspace_id` | `null` on `baseline`. |
| `progress_url` | Where phase callbacks go. |
| `progress_token` | 🔒 Run-scoped HMAC. Presented in `X-Rpt-Progress-Token`, never in a body. |
| `scope_verified` | The preflight's recorded verdict. `false` is a hard verification failure. |

---

## Commands

| Command | Routed | Deterministic |
|---|---|---|
| `generate_report` | yes | yes |
| `preflight` | yes | yes |
| `verify_report` | yes | yes |
| `render_preview` | yes | yes |
| `list_inventory` | yes | yes |
| `compare_runs` | **no — declared and unrouted** | — |

Every routed command is deterministic: a `prompt` alongside the payload is **ignored**.
The only model calls in the runtime are the two in `narrate/`, and neither is reachable
from a payload field.

`compare_runs` is named here and refused at the router. A comparison is a
`comparison_delta` block compiled *inside* a run, not a standalone invocation, and a
standalone comparison screen is out of scope. Recording it as declared-and-unrouted is
what stops the next reader treating its absence as an oversight and adding it.

### `generate_report`

```jsonc
{
  "command": "generate_report",
  "template_version_id": "tv_01HQZX…",     // pinned; the run is checked against this and no other
  "definition": { /* the pinned version's definition, inline */ },
  "period":  { "start": "2026-07-01", "end": "2026-07-31" },
  "scope":   {                              // the UNION of the template default and every
    "resource_types":  ["Microsoft.Compute/virtualMachines"],   // block override, with
    "resource_groups": [],                  // duplicates collapsed and every top-N count
    "tag_filters":     {}                   // and sort direction dropped
  },
  // Present exactly when the pinned definition declares `front_matter` (schema_version
  // >= 2). Absent for a v1-pinned run, which has no front matter to receive them, and
  // absent for the snapshot-only shape below, which pins no definition at all.
  // `enqueueRun` on the app side already required `customer_name` present for a
  // v2-pinned request (Req 13.14), so by the time these reach here they are read
  // straight through — `report_pipeline.py::_resolve_run_facts` is the one and only
  // reader (Req 13.7).
  "customer_name": "Contoso Indonesia",
  // Already formatted, in the definition's `identity.language` — not derived here.
  // `_resolve_run_facts` falls back to `strftime("%B %Y")` off `period.start` alone when
  // this is absent, which is English-only and blind to `period.end`; that fallback
  // exists for the snapshot-only shape and for a caller that predates this field, not as
  // a formatter the app should lean on when it already holds the period and the
  // language.
  "period_display": "Juli 2026",
  // The revision-history row for the document-control page. Every key required when
  // present — `_resolve_run_facts` reads `revision`, `note` and `author` from it.
  "revision_history_row": { "revision": "1.0", "note": "Initial report", "author": "Report Author" },
  // Present exactly when the pinned version is schema_version 3 AND the app holds at
  // least one `report_profile_authored_matches` row for it (task 3.10) — absent for a
  // v1/v2-pinned run (no `sections`, nothing to compare drift against) and absent for a
  // v3-pinned run that has never had a scan authored against it. Keyed by the definition's
  // own `sections[].id`; `resource_ids` is the FULL matched set recorded at that publish,
  // not a count. `compile/blocks/__init__.py::compile_document` reads this to compute
  // drift for the coverage appendix (Req 19.1-19.7) — see `compile/sections.py`'s
  // `AuthoredMatch` and `compute_section_drift`.
  "authored_matches": {
    "sec_vm_util": { "resource_ids": ["/subscriptions/…/vm-01", "/subscriptions/…/vm-02"] }
  },
  // The prior runs the app offers as historical points, present exactly when the pinned
  // definition declares a `historical_trend` block. The app selects the candidates
  // because only it can see `report_runs` and `report_verifications`; the runtime picks
  // among them and never queries for more. `_parse_historical_candidates` treats an
  // absent field as an empty list, which is the normal case for a definition declaring
  // no trend block and for the snapshot-only shape below.
  //
  // `verification_status` is the field that decides admissibility: a candidate whose
  // source run did not pass is dropped rather than plotted with a caveat, which is why
  // the verification columns travel with the candidate instead of being re-derived.
  "historical_candidates": [
    {
      "id": "run_01HQ…", "period_start": "2026-06-01", "period_end": "2026-06-30",
      "timezone": "Asia/Jakarta", "status": "completed",
      "verification_id": "ver_01HQ…", "verification_status": "pass",
      "verification_created_at": "2026-07-01T02:14:11Z",
      "verification_snapshot_sha256": "a41f8e6c…"
    }
  ],
  "context": { /* the twelve fields above */ }
}
```

**A payload carrying no `definition` is a snapshot-only run.** That shape is still legal —
the state machine keeps `collecting → completed` for it — and the runtime delegates it to
the collection pipeline unchanged rather than treating it as a malformed report request.

The scope is the **union**, and it is the app's job to form it. Sending one request per
block override would re-query overlapping resource sets; sending the narrowest would make
a block's own override unsatisfiable. Top-N counts and sort directions are dropped when
forming it because a ranking is resolved against the snapshot, not against the request.

**The metric narrowing is the runtime's job, not the app's**, and `scope` carries no metric
list for that reason. The runtime reads the inline `definition`'s `metrics` selection,
expands each `derived` item to the source metrics the catalog declares for it, folds in every
top-N ranking metric, and intersects the result with what the provider can collect — so a run
requests exactly what the pinned version selected and nothing outside it (Req 5.4). The app
sending a metric list would be a second place the same union is computed, and the two would
eventually disagree about a derived statistic's sources.

### `verify_report`

```jsonc
{ "command": "verify_report", "attempt_id": "att_…",
  "definition": { /* the PINNED version, not the template's current one */ },
  "context": { /* … */ } }
```

Reads the stored `.docx`, `.pdf`, ledger and prose bundle and the snapshot the run names.
Fetches no fresh snapshot, runs no collection, and asks no model — the prose bundle is
replayed, because a re-verification whose recompiled ledger depended on a model producing
the same words twice would not be a check at all.

Recompiles the **pinned** version and asserts the recompiled ledger is byte-identical to
the stored one. An absent, unreadable or digest-mismatched input fails *this attempt*
naming that input, reconstructs nothing, and modifies no earlier row.

### `render_preview`

```jsonc
{ "command": "render_preview", "preview_id": "pv_…",
  "snapshot_run_id": "run_…",               // a COMPLETED run the actor owns
  "definition": { /* carried INLINE — a draft, not a stored version id */ },
  "context": { /* … */ } }
```

Writes `previews/<previewId>/preview.pdf` and emits **no `report_file`**. The preview key
prefix is one the report download predicate is structurally unable to serve, so "a preview
is not a report" is a property of the key space rather than a rule a route has to remember.

The `.docx` carries a per-page notice in each theme's `PreviewNotice` style, so the
artifact says what it is after it leaves the app. The verifier runs and its status is
reported as **information** — it does not gate. A draft template must be previewable for
layout before its figures verify, and a wizard that refused to show a page until every
number was provable would be unusable at exactly the moment a consultant needs the page.

### `list_inventory`

```jsonc
{ "command": "list_inventory",
  "context": { /* … — `subscription_id` and the three Azure credential fields are what
                     this command reads; it needs no run id and writes no row */ } }
```

Answers the template wizard's three pickers: the **distinct resource types, resource groups,
tag keys and tag values** present across the whole subscription scope, each ordered ascending
in Unicode code-point order, at most **2000** values per dimension, each dimension declaring
whether that bound truncated it.

**One Resource Graph query**, aggregated in the service. It projects the four dimensions and
nothing else — no resource id, no subscription id, no tenant or client id — so the exclusion
of every identifier is a property of the projection rather than a filter applied afterwards.

**The result rides on `done`, and no event type was added for it.** Four keys are merged into
the terminal event, exactly as `preflight` merges `scope_verified` and `fidelity_tier`:

```jsonc
{ "type": "done", "run_id": null, "status": "completed",
  "resource_types":  { "values": ["Microsoft.Compute/virtualMachines"], "truncated": false },
  "resource_groups": { "values": ["rg-prod"], "truncated": false },
  "tag_keys":        { "values": ["env", "owner"], "truncated": false },
  "tag_values":      { "values": ["dev", "prod"], "truncated": false } }
```

**A listing that did not answer carries no dimension key at all** — not four empty ones. Four
empty dimensions is a claim that the subscription holds nothing, which is the reading the
endpoint must not present; the caller's test is "are the four keys on `done`", with no need to
correlate an `error` event against a terminal one. The `error` code names what happened:
`THROTTLED` for a rate-limited query, `AUTH_FAILED` for a rejected credential or a missing
role assignment, and `INTERNAL_ERROR` for a status that names no actionable cause — a `400` is
a defect in the runtime's own query and a `5xx` is Azure's, and neither is an expired secret.

The caller bounds its own wait at 30 seconds and writes no cache entry for a listing that
did not answer. Neither bound is enforced here: this command has no run row, so there is no
reaper behind it and the timeout belongs to the endpoint.

---

## Events

Ten declared types, mirrored in `app/lib/events.ts` and compared by a static guard. This
runtime emits **all ten**; the foundation emitted six and the document phases added the
other four. No type was added, so the mirror never had to be renegotiated.

| Event | Carries |
|---|---|
| `tool` | step start/end. Six steps: `collect_inventory`, `collect_metrics`, `compile_figures`, `render_document`, `verify_document`, `upload_artifact` |
| `progress` | `{id, done, total, unit}` against an **open** step |
| `heartbeat` | every 15s ±5 |
| `snapshot_ready` | `{snapshot_id, resource_count, window, grain, gaps}` — exactly one |
| `delta` | model-authored prose only, no numeral absent from the ledger and the allowlist |
| `chart` | the plotted spec, each value a decimal string, `encoding` from the block's declaration rather than the series count, plus the data hash and a ledger path per point |
| `verification` | exactly one, carrying **the values written to the store** |
| `report_file` | `{key, bucket, kind, bytes}` — **no presigned URL and no content** |
| `error` | `{code, message, terminal}` |
| `done` | last, always, once |

### The two orderings the runtime guarantees

**`snapshot_ready` precedes any `verification`, and `done` is last with nothing after it.**

**A `report_file` is emitted only after a `verification` carrying `pass` in the same
invocation.** Enforced at the router — the one point every event passes through — rather
than trusted from the pipeline. The client is separately required to discard a
`report_file` it saw no passing verification for, and the two are not redundant: the
client-side rule protects one client, this protects the contract.

A URL never travels in an event. The app mints a presigned one server-side, per request,
gated on the run's verification having passed.

### Silence

Consecutive events are no more than 30 seconds apart while the status is `compiling`,
`rendering` or `verifying`. A 600-second verification with nothing to say would otherwise
sit inside the relay's 120-second inactivity window and be killed for being slow rather
than for being wrong.

---

## Phase callbacks

`POST <progress_url>` with `X-Rpt-Progress-Token`, fire-and-forget, abandoned after 5
seconds, continuing the phase whatever the outcome. **No run fails because a transition
did not land** — the Reaper's deadline sweep is the backstop.

Phases the agent may present: `collecting`, `compiling`, `rendering`, `verifying`,
`completed`, `failed`.

`queued` and `claimed` are the app's — an agent presenting `claimed` is claiming to have
done the claiming. `TIMEOUT` is likewise the app's, and the endpoint refuses a presented
one: the agent may already be gone when a deadline elapses.

`POST <progress_url>/../verification` carries a **pointer** — attempt id, status, figure
count, the three digests and the **artifact key** — not the result. A 1,000-finding list
with 200-character excerpts would make a several-hundred-kilobyte fire-and-forget POST, and
the artifact is the record anyway.

---

## Artifacts

```
<actor_id>/snapshots/<runId>/snapshot.json
<actor_id>/snapshots/<runId>/raw/<seq>-<location>-<type>.json.gz
<actor_id>/reports/<runId>/report.docx · report.pdf · ledger.json · ast.json
<actor_id>/reports/<runId>/prose.json · verification-<attemptId>.json
<actor_id>/reports/<runId>/charts/<chartId>.png + .sidecar.json
<actor_id>/previews/<previewId>/preview.pdf
```

Every object private, tagged with the owning actor id, read only through a server-minted
presigned URL. The download predicate admits a second segment of exactly `snapshots` or
exactly `reports` and nothing else — `previews` is deliberately outside it.

**The artifacts are written after the verification passes**, so there is no window in which
a `report_file` could name an object sitting beside a failure. The one exception is
`verification-<attemptId>.json`, written on both paths, because the panel must present
every finding for a run whose document was withheld.
