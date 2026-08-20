# Azure integration (how the agent collects utilization)

Everything here runs **inside the agent container**, under `agent/src/reporting_agent/azure/`.
No Azure SDK is ever imported by `app/`.

> **These are verified findings, not suggestions.** Every constraint below was
> established against the real APIs and SDKs. Do not re-derive them, do not soften
> them into "consider…", and do not let a plausible-looking simplification quietly
> undo one. Several of them are the difference between a correct report and a report
> that is confidently wrong — which, for this product, is the only failure that
> actually matters.

There is no `cold-agent` equivalent to this document. Its AWS integration is a
cross-account role that never expires, against a billing API that returns
pre-aggregated totals. Almost none of that intuition transfers.

---

## 1. Authorization — the gate

### Required role: **Reader at subscription scope**
- **`Monitoring Reader` alone is not enough.** It does not grant Resource Graph
  inventory. Without inventory there is nothing to collect metrics *for*.
- Customers **push back on Reader**, legitimately: it exposes resource
  configuration, not just metrics. The onboarding UI must therefore state **which
  role and why** — Reader is needed to enumerate resources and read their SKU and
  power state; metrics access follows from it. Do not bury this; a surprised
  customer revokes access mid-engagement.

### `scope_verified` — a preflight, not a hope
**Coverage checks cannot detect what RBAC hides.** The inventory query is *itself*
RBAC-filtered, so a service principal holding Reader on a single resource group
returns only that group's resources — and the pipeline then reports **100% coverage
on a report that is 90% incomplete**. Every downstream metric succeeds. Every figure
verifies. The document is wrong and nothing in the data says so.

The only defence is to check the scope directly, before trusting the inventory:

```
GET /subscriptions/{subscriptionId}/providers/Microsoft.Authorization/permissions
```

Call it with the **caller's own token**, assert read at **subscription** scope, and
store the result as `scope_verified` on the connection.

**`scope_verified == false` is a hard failure.** Not a warning, not a badge — the
run does not start and the connection is not accepted.

### Client secrets expire
Azure service-principal secrets have a **maximum lifetime of 24 months**, and are
commonly issued for **6–12**. This is the **single most common operational failure
of service-principal integrations**, and it has no analogue in the sibling project:
an AWS role ARN never expires, so nothing in `cold-agent` prepares you for it.

- Track **`secret_expires_at`** on the connection.
- Warn well ahead, escalating as the date approaches (see `design-system.md`).
- Give expiry its own terminal state, **`AUTH_EXPIRED`**, distinct from any other
  auth error.

**Why this is the most dangerous failure in the system:** an expired secret yields
zero resources. Zero resources means zero figures. Zero figures means **zero
unverifiable figures** — so the run sails through collection, compilation,
rendering *and verification*, and delivers a clean, fully-verified, **empty**
report. Every gate passes. The artifact is worthless.

Therefore: **an empty in-scope result is a hard failure** (`EMPTY_SCOPE`), always.
A subscription with no VMs is a configuration error to be surfaced, not a report to
be rendered.

### What "in-scope" counts over
**The union of all block scopes for the run** — not any single block's scope. Blocks
carry per-block scope overrides (see `structure.md`), and the collector fetches the
union once into one snapshot, so the union is the only definition that matches what
was actually collected.

| what resolved to zero | meaning | outcome |
|---|---|---|
| **the run's union** | nothing at all was collectable | **`EMPTY_SCOPE`, hard failure** |
| **one block's scope** | that block's filter matched nothing | **not a failure** — the block renders an explicit "No resources matched this scope" row |

A single block matching nothing is ordinary: a report can legitimately ask for
"Storage Accounts tagged `env=prod`" in a subscription that has none. That block must
still render its row and **never silently vanish** — a disappeared block is
indistinguishable from one that was never configured, so the reader cannot tell an
empty result from a missing section.

**This narrows what the gate counts, not the gate.** An expired secret, a revoked
role or an over-narrow assignment still collapses the union to zero, and that is
still a hard failure — precisely because it would otherwise produce a clean,
fully-verified, **empty** report that passes every other check. Do not let
"per-block zero is fine" erode into "zero is fine".

---

## 2. Inventory — Resource Graph

- Page with **`skip_token`** until exhausted.
- Honour the **`x-ms-user-quota-remaining`** and **`x-ms-user-quota-resets-after`**
  response headers rather than guessing at a backoff. The service tells you your
  remaining budget; read it.
- **Project `properties.extended.instanceView.powerState.code`.** This is not
  optional metadata. Without power state, three completely different outcomes
  collapse into the same "0% coverage" number:

  | Reality | Meaning | Correct handling |
  |---|---|---|
  | VM is **deallocated** | expected — a stopped VM emits nothing | **fine**; note it, exclude from averages |
  | Metric **not emitted for this SKU** | a genuine gap | **gap** in `collection_log` |
  | **403** on the resource | a permission failure | **failure** in `collection_log` |

  A **403 from the batch metrics endpoint itself** is a different thing entirely —
  see "The data plane can refuse every caller" below. Do not classify it here.

  Reporting "0% CPU" for a deallocated VM as though it were measured idle is a
  factual error in a document someone may resize infrastructure from.

---

## 3. Metrics availability

### Baseline — platform metrics, no agent required, `PT1M` grain
Available for `Microsoft.Compute/virtualMachines` with nothing installed in the
guest:

- `Percentage CPU`
- `Available Memory Bytes`
- `Available Memory Percentage`
- `Disk Read Bytes`, `Disk Write Bytes`
- `Disk Read Operations/Sec`, `Disk Write Operations/Sec`
- OS Disk and Data Disk equivalents of the above
- `Network In Total`, `Network Out Total`
- `VmAvailabilityMetric`

### There is **no platform metric for disk free space inside a VM**
Free space on a logical volume is a guest-observed quantity. Getting it requires:

1. **Azure Monitor Agent (AMA)** installed, plus
2. a **Data Collection Rule (DCR)** gathering the performance counter, plus
3. **Log Analytics**, queried with KQL:

```kusto
Perf
| where ObjectName == "LogicalDisk" and CounterName == "% Free Space"
```

> **Known AMA regression:** per-drive `InstanceName` can collapse to `"_Total"`,
> so the individual volumes are indistinguishable in the returned rows. When that
> happens, **record a gap** — do not report one volume's free space as the whole
> VM's. A single mis-attributed disk figure is exactly the kind of error that
> survives review because it looks reasonable.

### Two-tier fidelity — store it per resource
`fidelity_tier` is a field on every resource in the snapshot, and it propagates
into every figure derived from that resource.

| tier | requires | gives |
|---|---|---|
| **`baseline`** | nothing (platform metrics) | exact **avg / min / max**; percentiles are **estimates** |
| **`enhanced`** | customer opt-in: **AMA + DCR** (+ Log Analytics) | true **p95 / p99**, **per-volume disk free space**, **guest-observed memory** |

The tier is a product-visible fact, not an implementation detail — see
`product.md` and `design-system.md`. A `baseline` percentile is labelled as
estimated **everywhere it appears**, including inside the delivered document.

---

## 4. Derived metrics — and labelling them honestly

### Memory utilization percentage
**There is no "% memory used" metric.** Derive it:

```
memory_used_pct = (sku_memory_bytes - available_memory_bytes) / sku_memory_bytes * 100
```

SKU capacity comes from `azure-mgmt-compute` (see §6). Two consequences that must
be recorded on the figure, not assumed:

- The result is **host-observed** and typically runs **1–3% below what the guest
  reports** (the host cannot see guest-internal caching and reclaim behaviour).
  Label it as host-observed wherever it appears.
- Every derived figure carries **`derived_from`** (the source metric keys and the
  SKU capacity used) and **`formula`** (the expression above). A derived number
  without its derivation is an assertion, not a measurement.

### Network is not egress
`Network In Total` / `Network Out Total` are **NIC-level byte counters**. They are
**not billable egress** — billable egress lives in Cost Management's **Bandwidth**
meters and differs by zone, peering, intra-region exemptions and free tiers.

Report the NIC counters, label them plainly as NIC throughput, and never let a
document or a chart title imply they are transfer costs.

---

## 5. Aggregation correctness

This section is where a plausible implementation is silently wrong.

### `avg` must be **count-weighted**
```
avg = sum(total_across_intervals) / sum(count_across_intervals)
```
**Never take the mean of the interval averages.** Buckets do not carry equal sample
counts — a partial hour at the window edge, or a VM that starts mid-window, has
fewer samples than a full bucket. Averaging averages weights a 3-sample bucket the
same as a 60-sample one. The result is wrong in exactly the cases nobody checks:
month boundaries and recently-created VMs.

### `min` and `max` roll up exactly
The `Minimum` / `Maximum` aggregations preserve the raw extremes across intervals,
so the minimum of the per-interval minima **is** the true minimum. These are exact
at any grain — no caveat needed, and none should be added.

### Percentiles do **not** roll up
Azure Monitor stores `{min, max, sum, count}` per interval. **There is no
percentile aggregation**, and a percentile is not reconstructible from those four
moments.

Computing a "p95" from hourly buckets produces a value that runs **20–40 points
below** the true p95 of the underlying minute samples. That is not a rounding
difference. It is **precisely the error that makes an over-provisioned VM look
right-sized** — a spiky workload's hourly averages hide every spike, the estimated
p95 lands near the mean, and the report recommends downsizing a machine that
actually saturates daily.

Two binding rules follow:

**(a) Never emit a bare `p95` key.** The estimator travels *inside* the value
object, together with a **pre-formatted label the renderer is required to consume**,
so the document is structurally incapable of saying "p95 CPU" unqualified:

```jsonc
{
  "metric": "Percentage CPU",
  "statistic": "p95",
  "value": "68.40",
  "estimator": "histogram_sketch_pt1m",     // or "estimated_from_pt1h"
  "formatted": "68.4% (p95, est. from hourly)",
  "fidelity_tier": "baseline",
  "unit": "percent"
}
```
The renderer prints `formatted`. It never composes its own percentile label, and
`compile/format.py` is the only place `formatted` is produced (see `structure.md`).

**(b) Compute percentiles from a bounded sketch folded during collection.**
Fold each response's raw points into the sketch as they arrive, then discard them:

| metric family | sketch |
|---|---|
| percentages (CPU, memory %, % free space) | **fixed 0–100 histogram, bin width 0.5** |
| bytes / IOPS / throughput | **log-spaced DDSketch, `gamma = 1.02`** |

Both are roughly **1–2 KB per series regardless of window length** — a month at
`PT1M` costs the same memory as a day. This is what makes true-grain percentiles
affordable at all, and it is why the sketch must be folded *during* collection
rather than reconstructed afterwards from stored points that no longer exist.

---

## 6. Scale, grain and batching

### Grain is the scaling limit — not resource count
200 resources × 6 metrics × 31 days:

| grain | points per resource | payload | outcome |
|---|---|---|---|
| `PT1M` | ~268,000 | **~6 GB** of JSON | **OOM** |
| `PT1H` | ~4,500 | **~110 MB** | fine |

Adding resources scales linearly and predictably. Dropping the grain by 60× does
not. Every scaling decision should look at the grain first.

### Base grain is `PT1H` — **not** `P1D`
`P1D` buckets are **UTC-aligned**. The customer is **Asia/Jakarta (UTC+7)**, so a
"July 2026" report built from daily buckets would be **offset by 7 hours from every
bucket boundary** — each reported "day" would span 07:00 to 07:00 local, silently.
Peak-hour analysis becomes meaningless and month edges include or exclude the wrong
data.

`PT1H` allows correct **local-day bucketing client-side**, inside the collector.

> **Non-whole-hour offsets:** zones like `+05:45` (Asia/Kathmandu) cannot be
> bucketed from hourly data. **Flag them and drop to `PT15M`.** Detect this from
> the offset, not from a hardcoded zone list.

### Batch by a **points budget**, not a resource count
Target **~20,000 points per call**. When a response comes back too large, **halve
the batch adaptively** and retry.

The documented **50-resource cap is almost never the binding constraint** — 50
resources × 6 metrics × 720 hourly points is 216,000 points, an order of magnitude
past what a single response should carry. Sizing by resource count produces
sporadic oversized-response failures that look random and are not.

### Stream-reduce — never materialize a series
Fold each response into the accumulators (`sum`, `count`, `min`, `max`) and the
sketches, then **discard the raw points**. At no point should a full series for a
resource exist in memory. This is what keeps a 200-resource month inside a
container's memory budget, and it is not an optimization to add later — retrofitting
it means rewriting the collector.

### Batch grouping key: `(subscription, location, resource_type)`
- The batch endpoint takes **one `metric_namespace` per call**, which makes it
  implicitly **one resource type per call**.
- A **regional endpoint** is required — the data plane is regional, and
  `location` is therefore part of the key, not an afterthought.
- **There is no paging** on the batch metrics endpoint. Response size is controlled
  entirely by how you batch, which is why the points budget above is the only
  control that exists.

### Not every region has a metrics data-plane host
Some regions have no regional metrics endpoint, and the failure presents as **DNS
resolution failure**. **Fall back to per-resource
`MonitorManagementClient.metrics.list`** (`azure-mgmt-monitor`) for that region —
slower, but complete. That fallback works precisely because it is the ARM
**control-plane** API on `management.azure.com`, which has no regional endpoint, and
the single `ClientSecretCredential` already serves that audience — **no new token
scope**. **Do not drop the region**; a silently missing region is a silently
incomplete report.

### The data plane can refuse every caller, and that is not your permissions

**Observed in production, `indonesiacentral`, 2026-08:** the batch metrics endpoint
answered **403 for a service principal holding Reader and for a subscription owner
alike**, while the ARM per-resource path served the same metrics for the same window
without complaint.

The cause is not the caller. Azure's own first-party **`Metrics Monitor API`**
principal performs a `Microsoft.Authorization/checkAccess` to authorize a batch
request, and where *that* is denied the endpoint answers 403 for everyone in the
subscription. No role assignment on your side fixes it, and no support case is
needed — a working route already exists.

So **treat a data-plane `401`, `403` or `404` exactly as the DNS failure above**:
mark the location fallback-only for the rest of the run, re-issue against ARM, and
record no gap. Classifying it as a permission gap instead turns a fully collectable
subscription into `NO_STATISTICS` while a working route sits unused — which is what
it did before this was understood.

Note the asymmetry: a 403 on **one resource inside** an otherwise-successful batch
response is still a per-resource permission failure (§ the power-state table above).
It is only the 403 on the **endpoint** that means "use the other road".

---

## 7. SDK traps

### `azure-monitor-query >= 2.0.0` removed **both** metrics clients — it is logs-only
`MetricsClient` **and** `MetricsQueryClient` are both gone at 2.0.0. Its `__all__` is
logs only: `LogsBatchQuery`, `LogsQueryClient`, `LogsQueryError`,
`LogsQueryPartialResult`, `LogsQueryResult`, `LogsQueryStatus`, `LogsTable`,
`LogsTableRow`, `MonitorQueryLogsClient`. The metrics surface therefore lives in two
other packages, so you need **all three**:

| package | provides | used for |
|---|---|---|
| **`azure-monitor-querymetrics`** | `MetricsClient.query_resources` | batch metric values, regional data plane |
| **`azure-mgmt-monitor`** | `metric_definitions.list(resource_uri)` | metric definitions |
| **`azure-mgmt-monitor`** | `metrics.list(resource_uri, …)` | per-resource values — the regional fallback |
| **`azure-monitor-query`** | `LogsQueryClient` | enhanced tier **ONLY** |

Installing only a subset produces an `ImportError` that reads like a version-pin problem
and is not. Pin all three in `pyproject.toml`, together, with a comment saying why.

### Probe metric definitions **once** per `(resource_type, region)` and cache
Definitions are identical across resources of the same type in the same region.
Probing per resource is **hundreds of wasted calls** per run, burns the request
quota that the actual metric queries need, and adds minutes to a run for no
information.

### SKU capacity — `azure-mgmt-compute`, with two mandatory details
- **Always filter by `location`.** An unfiltered `resource_skus.list()` returns an
  **enormous** set (every SKU in every region); it is slow, memory-hungry, and
  entirely avoidable.
- **Use `vCPUsAvailable`, not `vCPUs`.** **Constrained-core** SKUs report the
  parent's core count: `Standard_E32-8s_v5` advertises **32 vCPUs but exposes 8**.
  Using `vCPUs` overstates capacity by 4× and every derived per-core figure is
  wrong.
- **`MemoryGB` is a decimal string, in GiB.** Parse it as a decimal (never a
  float — see §8) and be explicit about GiB vs GB when converting to bytes.

### Batch responses carry **per-resource errors at HTTP 200**
The call succeeds; individual resources inside the response can still have failed.
**Iterating without checking each resource's error field turns a permission denial
into a silent zero** — which then averages into the report as measured idleness.

Check every resource's error field on every response. **Every per-resource error
lands in `collection_log` as a typed gap.** There is no path where an error becomes
a zero.

### Concurrency and throttling
- Cap metrics concurrency at **8 per subscription**.
- Limits are **per-subscription**, so **parallelizing across customers is free** —
  scale out by subscription, never by hammering one.
- **Honour `Retry-After` on 429.** Honour Resource Graph's quota headers (§2).

### One credential, two audiences
Construct **one `ClientSecretCredential`** and reuse it across every client, so
tokens are cached and refreshed once. Constructing per-client credentials
re-authenticates constantly and can itself trigger throttling.

Two token audiences are involved:
- **`management.azure.com`** — ARM, Resource Graph, and `azure-mgmt-monitor` (metric
  definitions and the per-resource fallback).
- the **regional metrics data plane** — batch metric queries.

Both come from the same credential; the SDK requests the right scope per client.

---

## 8. Determinism — the snapshot must hash identically

- **Store every metric value as a fixed-precision decimal string. Never a JSON
  number.** `json.dumps` serializes floats via `float.__repr__`, and
  cross-platform, cross-version float equality is **not something to bet an audit
  artifact on**. A snapshot that hashes differently on two machines is not immutable
  in any useful sense.
- **Canonicalize with RFC 8785 (JCS)** and hash *that*. `snapshot_id` is the hash.
  Same inputs → same bytes → same id, on any machine, in any Python build.
- Decimal strings are also what make the rendered **`formatted`** string
  deterministic — and the **verification ledger depends on that**. The verifier
  matches document tokens against `formatted` values; if formatting drifts by one
  digit because a float round-tripped differently, verification fails on a report
  that is actually correct. Determinism here is not tidiness, it is the foundation
  the whole verification stage stands on.
- Use `Decimal` throughout the accumulate → compile → format path. The only place a
  float is acceptable is inside chart *layout* geometry, which is never hashed and
  never rendered as a figure.

### The decimal-string rule applies to the raw archive too — and it bites both ways

The rule above is about what you **write**. It has a mirror obligation about what you
**read**, and missing it made the raw archive **write-only** for a month.

The chain: the Azure SDK deserializes `total`, `minimum` and `maximum` as **`Decimal`**
(`azure/monitor/querymetrics/_utils/model_base.py` does this deliberately). The
archive serializes that Decimal to its **exact digit string**, correctly, so no
precision is lost to a float. `json.loads` on replay hands it back as a **`str`**.

If the numeric-leaf reader accepts `int`, `float` and `Decimal` but **not `str`**,
every value the archive preserved perfectly comes back classified as *absent*:

- the interval is recorded as an `interval_counts_missing` gap that never happened,
- its samples vanish from the count,
- `max` collapses to nothing,
- and the recomputed digest cannot match — `REPLAY_MISMATCH` on **every subscription
  whose metrics carry a fractional value**, which is all of them.

**One reader, both directions.** The function that parses a numeric leaf from a live
response is the same function that parses it from the archive, and it must accept
every form either side can produce — `int`, `float`, `Decimal`, and a decimal
**string**. A string that does not parse is still absent; it must classify as a gap,
not raise mid-fold.

**Test the round trip, not the halves.** Whole numbers survive this bug — they stay
JSON integers through the archive — so a fixture using round values passes while
production fails. Any replay fixture must carry **fractional** values, or it is
testing the one shape that cannot break.

### Azure emits intervals with a timestamp and nothing else

A `data` point can be `{"timeStamp": "..."}` with no `total`, `count`, `minimum` or
`maximum` — observed as a **64-hour contiguous stretch** on a running VM, across all
eight of its metrics simultaneously. This is normal and it is not an error field.

Exclude those intervals from the average and **record each as a gap**. Do not treat
them as zero: 64 hours of zero CPU on a running machine is a factual claim the data
does not support. A month of hourly data for one VM legitimately producing ~512 gap
entries (64 × 8 metrics) is an honest snapshot, not a broken one.

---

## 9. Terminal states

| state | Trigger | Terminal? |
|---|---|---|
| `AUTH_EXPIRED` | client secret past `secret_expires_at`, or auth rejected as expired | **yes** |
| `SCOPE_UNVERIFIED` | the permissions preflight did not prove subscription-scope read | **yes** |
| `EMPTY_SCOPE` | the **run's union of all block scopes** resolved to zero resources | **yes** |
| `THROTTLED` | rate limits exhausted after honouring `Retry-After` | retryable |
| `PARTIAL_COVERAGE` | some resources unreadable; gaps recorded | **no** — the run completes with gaps |
| `REGION_UNREACHABLE` | no data-plane host **and** the per-resource fallback also failed | **no** — gap, unless it is every region |
| `INTERNAL_ERROR` | a defect in this runtime, not a fact about the subscription | **yes** — see `agentcore-integration.md` |

`PARTIAL_COVERAGE` completing is deliberate: a report with **recorded, visible
gaps** is useful and honest. A report with **hidden** gaps is the thing this whole
document exists to prevent.

---

## Guardrails checklist
Before any collector change ships, confirm all of the following still hold:

- [ ] `scope_verified` is asserted by preflight; `false` blocks the run.
- [ ] A run whose **union of all block scopes** resolves to zero raises
      `EMPTY_SCOPE`; it never renders a report.
- [ ] A **single block** resolving to zero renders "No resources matched this scope"
      and is **not** a failure — and never silently disappears.
- [ ] `secret_expires_at` is tracked and surfaced; expiry is `AUTH_EXPIRED`.
- [ ] `powerState.code` is projected in the inventory query.
- [ ] `avg` is count-weighted; no code path averages interval averages.
- [ ] No bare `p95` key exists anywhere; every percentile carries `estimator` and
      a pre-formatted label, and the renderer consumes `formatted`.
- [ ] Percentiles come from sketches folded during collection, not from re-read points.
- [ ] Base grain is `PT1H`; non-whole-hour offsets drop to `PT15M`; day buckets are
      built in the customer's local zone.
- [ ] Batching is by points budget with adaptive halving; grouping key is
      `(subscription, location, resource_type)`.
- [ ] Raw points are discarded after folding; no full series is materialized.
- [ ] Every per-resource error in a 200 response lands in `collection_log`.
- [ ] `vCPUsAvailable` (not `vCPUs`); `resource_skus.list()` is location-filtered.
- [ ] All three of `azure-monitor-querymetrics`, `azure-mgmt-monitor` and
      `azure-monitor-query>=2` are installed.
- [ ] Metric definitions are cached per `(resource_type, region)`.
- [ ] One `ClientSecretCredential`, reused.
- [ ] Every value is a decimal string; the snapshot is JCS-canonicalized and hashed.
- [ ] Every derived figure carries `derived_from` and `formula`.
- [ ] Memory % is labelled host-observed; network is labelled NIC-level, not egress.
