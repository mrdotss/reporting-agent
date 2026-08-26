# Design Document

## Overview

The requirements ask for one change of kind — **selection instead of composition** — and that change
lands almost entirely *above* the pipeline. This design's central claim is that it can be built
without touching the AST's meaning, the figure ledger, the verifier or replay, because of one fact
established by reading the code:

> **An anchor id is derived from a leaf block's own `block.id` and nothing else.**
> `figure_path(block_id, *ordinals)` → `table_id(path)` = `"tbl:<block_id>:<ordinals>"` →
> the `w:tblCaption` value. `BlockContext.cursor(block)` roots every cursor at `block.id`, and
> `_compile_child` gives a nested block its **own** cursor rather than a parent-prefixed one.
> No path segment encodes a container.

So a section is a **grouping and ordering concern above blocks**, and the pipeline below it cannot
tell the difference. The design exploits that deliberately: sections are stored as the authored
model, expanded to an ordered `BlockSpec` sequence by a pure function, and compiled by the block
compilers that already exist. `compile/__init__.py`'s three-phase loop, `assert_ledger_matches_tree`,
`verify/`'s gates and `verify/replay.py` are untouched.

Four things genuinely are new capability and are designed as such: a scan that reports counts, a
`Brand` entity, split-scale chart panels, and four Azure collectors.

### Shape of the change in one paragraph

`schema_version` 3 adds `provider` and `sections` to the definition and keeps `design` as a
**resolved copy** of the referencing Brand rather than an authored field. A code-owned
`catalog/sections.v1.json` — read by **both** halves from one file, the way
`catalog/metrics.v1.json` already is — declares every section, its canonical number, the resource
types and fact sources it needs, and the block sequence it expands to. `compile/sections.py`
expands `sections` to `BlockSpec`s with derived stable ids; `compile_document` branches on schema
version and everything downstream is unchanged. A scan is a persisted row plus an extended
`list_inventory` outcome; the wizard drops to five steps; the four missing collectors add
**synthetic child resources** (a subnet, a security rule) carrying real ARM resource ids, so
one-to-many document shapes are expressed by the `resource_table` compiler that already exists
rather than by a new block type. Charts gain a `panels` grouping the verifier is blind to.

---

## Architecture

```
┌──────────────────────────── app/ ────────────────────────────┐
│  /subscriptions/[id]/scan          Scan screen               │
│      │  POST /api/subscriptions/[id]/scan                    │
│      │      → list_inventory (extended outcome)              │
│      └──→ subscription_scans row  (counts · regions · probes)│
│                    │                                         │
│  /report-profiles/[id]/edit    5-step wizard                 │
│    1 Identity  2 Sections  3 Period  4 Document  5 Preview   │
│      │            │                                          │
│      │            ├── section catalogue (shared JSON) ───────┼──┐
│      │            └── emit estimator (pure, scan-fed)        │  │
│      │                                                       │  │
│  /brand         Brand editor  ──→ brands row                 │  │
│      │                                                       │  │
│  publish: resolve Brand → definition.design                  │  │
│           insertVersion (immutable, sha256-deduped)          │  │
│           write report_profile_authored_matches              │  │
└──────────────────────────────────────────────────────────────┘  │
                            │ InvokeAgentRuntime                  │
                            ▼                                     │
┌──────────────────────── agent/ ──────────────────────────────┐  │
│  catalog/sections.v1.json  ←── one file, both halves ────────┼──┘
│  compile/sections.py   expand_sections() → (BlockSpec, …)    │
│           │                                                   │
│  compile/__init__.py   v3 → expand_sections                  │
│                        v1/v2 → _block_specs   (unchanged)    │
│           │                                                   │
│  BLOCK_COMPILERS (unchanged dispatch, +2 entries)            │
│           ▼                                                   │
│  AST → ledger → docx/html → pdf → verify → replay            │
│           (all unchanged; anchors keyed by block.id)         │
└──────────────────────────────────────────────────────────────┘
```

---

## 1. Data model

### 1.1 `schema_version` 3

Additive to version 2. Three top-level changes:

| Key | Version 3 | Note |
|---|---|---|
| `provider` | **new, required** | `"azure"` \| `"aws"` \| `"onprem"`; only `azure` accepted (Req 3.4) |
| `sections` | **new, required** | ordered array; replaces `blocks` as the authored model |
| `blocks` | **absent** | forbidden at v3; `_block_specs` still reads it at v1/v2 |
| `design` | present, **resolved** | written by the publish path from the Brand, not by a wizard step |
| `front_matter` | present, extended | gains approver `company` and `signature_key`, `distribution` becomes rows |
| `metrics` | **absent** | metric selection moves inside each section |
| `scope` | **absent** | selection moves inside each section |

A section entry:

```jsonc
{
  "id": "sec_vm_util",              // stable, 1–64 chars, the id anchors derive from
  "type": "vm_utilization",          // a catalogue entry key
  "position": 8,                     // authored order; fixed entries ignore it (Req 8.4)
  "selection": {                     // ScopeRules-shaped; never a resource id
    "resource_types": ["Microsoft.Compute/virtualMachines"],
    "resource_groups": [],
    "tag_filters": [],
    "top_n": null,
    "sort": null
  },
  "metrics": [                       // only where the catalogue marks the entry metric-bearing
    { "metric": "Percentage CPU", "statistic": "avg" },
    { "metric": "Percentage CPU", "statistic": "max" }
  ],
  "presentation": "chart_and_table"  // chart_and_table | chart_only | table_only
}
```

`selection` reuses the existing `ScopeSpec`/`ScopeRules` shape **exactly**, including
`validateScopeSpec`'s existing rejection of GUIDs and `/subscriptions/...` paths — which is what
implements Req 9.2 with no new validator rule.

`metrics` reuses `MetricSelectionItem` (`metric` xor `derived`, `statistic`, plus `estimator` and
`fidelity_tier` for percentiles), so Req 10.7 is the existing catalogue-copy rule unchanged.

**Why `design` stays in the definition.** Req 2.6 requires a saved version to be self-contained
against later Brand edits. Resolving the Brand into `definition.design` at publish time achieves
that *and* leaves `DesignSettings`, `render/themes.py`, `compile/format.py` and the
`SCHEMA VERSIONS` mirror region untouched — the renderer never learns that Brands exist. The
alternative, a `brand_id` the runtime dereferences, would put a mutable row on the render path and
break the "delivered reports keep rendering as delivered" invariant.

### 1.2 New tables

Three additive migrations, following the `report_templates` pattern verbatim (text `id` primary key
generated in the store with `randomUUID()`, the local `instant()` helper for timestamps,
`pgEnum` at module top, constraints returned from the third argument, `snake_case` columns,
`_idx`/`_uq`/`_ck` constraint suffixes).

**`brands`** — owned by `user_id`, because no account/org entity exists and inventing one is out of
scope (Req 2.1).

```
id · user_id → users(cascade) · name
theme_preset(enum) · accent_color · logo_key · density(enum) · table_style(enum)
page_size(enum) · number_format(jsonb) · cover_page(bool)
default_approver_names(jsonb)      -- {author, reviewer, approver, recipient}
confidentiality_notice_id
created_at · updated_at
index(user_id) · check(length(name) 1..120)
```

**`subscription_scans`** — one row per scan (Req 4.4).

```
id · user_id → users(cascade) · connected_subscription_id → connected_subscriptions
status(enum: queued|running|complete|failed)
catalog_version · sections_catalogue_version
resource_count · type_counts(jsonb) · resource_groups(jsonb) · regions(jsonb)
region_probes(jsonb)               -- [{region, status_code|null, verdict, probed_at}]
truncated(bool)                    -- DISTINCT_VALUE_LIMIT was hit
error_code · error_message
completed_at · created_at · updated_at
index(user_id) · index(connected_subscription_id, created_at)
```

**`report_profile_authored_matches`** — the authored match record (Req 9.5).

```
id · template_version_id → report_template_versions · scan_id → subscription_scans
section_id · matched_count · matched_resource_ids(jsonb)
created_at
unique(template_version_id, section_id) · index(template_version_id)
```

**Why the match record is a table and not a definition field.** `definition_sha256` is compared
head-to-head across both validators and pinned per fixture in
`agent/tests/fixtures/definitions/manifest.json`. Putting customer resource ids inside the hashed
definition would make the digest a function of the estate rather than of authored content, so two
identical profiles authored against different subscriptions would produce different digests and
`insertVersion`'s sha256 dedupe would stop meaning what it means. It also keeps resource ids out of
a payload that is validated, mirrored and fixture-compared.

### 1.3 Browser-safe projections

Two additions to `app/lib/db/views.ts`, each with a projection guard test asserting no secret
survives (Req 22.7):

- `BrandView` — every column except `user_id`; `logo_key` is a **key**, never a presigned URL.
- `ScanView` — everything except `user_id`; `error_message` passes through already-scrubbed.

`report_profile_authored_matches` is **not** projected to the browser. The wizard displays the count
it just computed; the drift comparison happens agent-side.

---

## 2. The section catalogue

### 2.1 One file, both halves

`agent/src/reporting_agent/catalog/sections.v1.json`, imported directly by
`app/lib/profiles/sections.ts` — the mechanism `app/lib/templates/catalog.ts` already uses to read
`catalog/metrics.v1.json` from the agent tree.

This is chosen **over** a sentinel-mirrored declaration. `mirror.static.test.ts`'s
`sentinelBody()` + `declaredRecord()` extractors read quoted strings, flat lists, scalars and
`{version: [members]}` records; a catalogue entry is a nested object with per-preset metric sets, so
mirroring it through sentinels would mean either flattening it into something unreadable or
extending the extractor. One shared file makes drift **structurally impossible** rather than
test-detected, which is strictly stronger. Req 22.4's mirror obligation is then satisfied by
asserting *behaviour* over the shared file: both halves load it, and both agree on entry set,
offerability and expansion.

### 2.2 Entry shape

```jsonc
{
  "catalogue_version": "1.0.0",
  "providers": {
    "azure": {
      "sections": [
        {
          "key": "vm_utilization",
          "number": 8,
          "title_id": "doc.section.vm_utilization",
          "group": "utilisation",              // inventory | utilisation | closing
          "position": "free",                  // free | fixed | always
          "repeatable": false,
          "needs_resource_types": ["Microsoft.Compute/virtualMachines"],
          "needs_fact_sources": [],
          "metric_bearing": true,
          "presets": {
            "standard_utilization": [
              { "metric": "Percentage CPU", "statistic": "avg" },
              { "metric": "Percentage CPU", "statistic": "max" },
              { "metric": "Available Memory Bytes", "statistic": "avg" }
            ],
            "capacity_planning": [ /* … */ ],
            "everything": "*"
          },
          "expands_to": [
            { "block": "heading", "config": { "level": 2 }, "per": "resource" },
            { "block": "timeseries_chart", "per": "resource",
              "when_presentation": ["chart_and_table", "chart_only"] },
            { "block": "resource_table", "per": "resource",
              "when_presentation": ["chart_and_table", "table_only"] },
            { "block": "top_n_table", "per": "section", "config": { "caption_id": "doc.section.fleet_summary" } }
          ]
        }
      ]
    }
  }
}
```

`expands_to` is what makes a section a **selection** rather than a composition: the block sequence is
declared in reviewed code, not assembled by the author.

### 2.3 The fourteen entries and how each is fed

| № | key | position | fed by | today |
|---|---|---|---|---|
| 1 | `azure_subscription` | free | inventory (**headline counts exclude child types**) | new expansion over existing blocks |
| 2 | `resource_groups` | free | inventory (**per-group counts exclude child types**) | new expansion |
| 3 | `virtual_network` | free | `resource_graph` child resources | **needs collector** |
| 4 | `virtual_machines` | free | inventory + facts | 4.1/4.2/4.3 sub-sections |
| 5 | `public_ip_addresses` | free | `resource_graph` | **needs collector** |
| 6 | `network_security_groups` | free | `resource_graph` child resources | **needs collector** |
| 7 | `reservations` | free | `capacity` | existing fact source |
| 8 | `vm_utilization` | free | metrics | existing |
| 9 | `historical_vm_utilization` | free | prior verified runs | existing `historical_trend` |
| 10 | `database_utilization` | free | metrics + facts | existing |
| 11 | `app_service_and_storage` | free | metrics + facts | existing |
| 12 | `backup_report` | **fixed** | `recovery_services` | existing fact source |
| 13 | `incident_report` | **fixed** | author | new expansion (blank rows) |
| 14 | `recommendations` | **fixed** | `advisor` | **needs collector** |
| — | `coverage_and_verification` | **always** | ledger + verification | existing blocks |

`position: "always"` is the appendix: present, never deselectable (Req 8.5). `position: "fixed"`
means no drag handle and compiler-forced order (Req 8.1–8.4). Section 4's three sub-sections are
three `expands_to` groups within one entry, so 4.1/4.2/4.3 cannot be selected apart — the shape
`design/ReportA.dc.html` delivers.

**Sections 1 and 2 count only non-child types.** Section 1's "Total Resources" reads
`resource_count` and section 2's per-resource-group figures read `type_counts`, both of which exclude
child types by construction (§4.1). Where a section wants a sub-record count — section 3 stating that
a VNet has four subnets, section 6 stating an NSG's rule count — it reads `child_type_counts`, or the
resolved row count of its own selection, which is the same number arrived at from the section's own
rule. No section composes a total from both families.

### 2.4 Offerability

A pure function shared in spirit by both halves (each implements it over the same JSON):

```
offerability(entry, scan) =
  "manual"      if entry.position == "fixed" and entry.needs_fact_sources == [] and entry.author_filled
  "unavailable" if any(t not in scan.resource_types for t in entry.needs_resource_types)
                or any(s not in COLLECTED_FACT_SOURCES for s in entry.needs_fact_sources)
  "ready"       otherwise
```

Presence is tested against `scan.resource_types` — the full type set, which carries child types — and
not against `type_counts`, which is partitioned and would leave sections 3 and 6 permanently
unavailable however many subnets the scan found. Presence and counting are separate questions and are
answered from separate fields.

`COLLECTED_FACT_SOURCES` is derived from `DECLARED_FACT_SOURCES` in
`agent/src/reporting_agent/catalog/loader.py`, which is why adding `advisor` there is what flips
section 14 from `Unavailable` to `Ready` — one edit, not two.

---

## 3. Section → AST

### 3.1 The expander

```python
# agent/src/reporting_agent/compile/sections.py

def expand_sections(
    definition: Mapping[str, object],
    *,
    catalogue: SectionCatalogue,
    view: SnapshotView,
) -> tuple[BlockSpec, ...]:
    """Pure. Ordered document-order BlockSpecs. No Azure, no ledger, no I/O."""
```

Ordering: `group` order (`inventory`, `utilisation`, `closing`) then authored `position` within a
group, then catalogue-declared order for `fixed` entries, then the `always` appendix last.

**Derived block ids.** A `per: "resource"` expansion emits one block per matched resource, so ids
must be stable and unique:

```
<section.id>__<expansion_index>            # per: "section"
<section.id>__<expansion_index>__<n>       # per: "resource", n = index in the resolved order
```

Stability matters because the id is the anchor. Resource **order** comes from
`compile/scope.py::resolve`, which is already deterministic (declaration order, then top-N ranking,
unranked appended last), so two runs over one snapshot produce identical ids — which is what keeps
replay's bit-identical-ledger assertion true.

`BlockSpec.scope_override` is set to the section's `selection` for every emitted block. A
`per: "resource"` block additionally carries a single-resource narrowing expressed **as a rule** —
resource type plus that resource's resource group — plus a `resource_id` *ordinal* the compiler uses
to pick one of the resolved set. It never stores the resource id in the definition; the definition
holds only the section's rule, and the expansion happens at compile time against the snapshot.

### 3.2 The one-line change in `compile_document`

```python
if schema_version >= 3:
    specs = sections.expand_sections(definition, catalogue=catalogue, view=view)
else:
    specs = _block_specs(definition)          # unchanged v1/v2 path
```

Everything after this line — `_phase_one`, the prose deferral, `Document` assembly,
`assert_ledger_matches_tree(nodes_by_block, ledger, factory_calls=…)` — is untouched, because it
consumes `Sequence[BlockSpec]` and does not care where the sequence came from.

`compile_document` gains two keyword parameters: `catalogue` (the loaded section catalogue) and
`authored_matches` (§9). Both default to `None` so every existing caller and test compiles.

### 3.3 One-to-many shapes: synthetic child resources

Sections 3, 5 and 6 present **many rows per resource** — subnets of a VNet, security rules of an
NSG. Two ways to express that, and the choice is load-bearing.

**Chosen: each sub-record is a snapshot resource with a real ARM id.**

```
/subscriptions/…/virtualNetworks/vnet-a/subnets/app-tier
/subscriptions/…/networkSecurityGroups/nsg-web/securityRules/allow-https
```

Resource Graph projects them with `mv-expand` in the same inventory pass. Each becomes an ordinary
`ResourceRecord` with a `resource_type` of `Microsoft.Network/virtualNetworks/subnets` and scalar
facts (`address_prefix`, `available_ips`, `priority`, `protocol`, `source`, `action`). The document
shape is then `resource_table` with fact columns — the compiler task 12.8 already built — and
scope rules, facts, anchors, the ledger and every verification gate work unchanged.

**Rejected: a list-valued fact plus a new `subrecord_table` block type.** It breaks the fact model
(`value_kind` is `numeric` \| `text`, and `collect/factfold.py` folds scalars), needs a new AST
shape, a new verification path for nested values, and a new block compiler — four new surfaces to
express something the resource model already expresses. A subnet *is* an addressable Azure resource;
modelling it as one is the honest option as well as the cheap one.

**The constraint this creates.** A child type appears in `catalog/facts.v1.json` and **never** in
`catalog/metrics.v1.json`. That property is the **formal test for a child type** — there is no second
list to maintain:

```python
def is_child_type(resource_type: str, *, facts: FactDeclaration, metrics: MetricCatalog) -> bool:
    """A type the fact catalogue declares and the metric catalogue does not."""
    return facts.declares(resource_type) and not metrics.declares(resource_type)
```

Two consequences follow from that one property, and they are stated together because they are the
same decision seen twice:

1. **No metric is ever requested for a child type**, so the design requires a test asserting a
   fact-only resource type produces **no** `metric_not_selected` gap — because if it does, one VNet
   with six subnets manufactures six phantom gaps per metric and the gap list becomes noise.
2. **A child type contributes to no headline count.** A sub-record is addressable but is not a
   deployed thing in the sense a reader takes from "47 resources", so it is excluded from every
   count a reader will read as *how much is deployed here* — the scan summary bar (§4.1), section 1's
   total and section 2's per-resource-group counts (§2.3) — and counted separately where a section
   genuinely needs the number, as a virtual-network section does when it states that a VNet has four
   subnets.

The second is not a rounding concern. Phase 5 flips sections 3 and 6 to offerable, so under uniform
counting an untouched subscription would report 47 resources one month and 71 the next with nothing
deployed, and a customer comparing two consecutive reports would see infrastructure growth that did
not happen. It is correct arithmetic producing a misleading number, which is the hardest kind to
catch and precisely the failure this product exists to prevent.

Both tests are written **before** the collectors, since both constrain their design.

### 3.4 New block compilers

Only two, and both because no existing block expresses the shape:

| type | why | emits |
|---|---|---|
| `blank_rows_table` | section 13 prints an author-filled table with ruled empty rows; `resource_table` cannot emit a row with no resource | `Table` of `EmptyCell` rows |
| `subscription_facts` | section 1 states subscription-level facts that belong to no resource | `Table` of `TextFactCell` |

Each needs: an entry in `BLOCK_TYPES` (both halves, inside the `BLOCK TYPES` sentinel region), an
entry in `BLOCK_CONFIG` (both halves, `BLOCK CONFIG` region), an entry in `BLOCK_COMPILERS` — the
import-time `assert set(BLOCK_COMPILERS) | {_ROW_TYPE} == set(BLOCK_TYPES)` makes a half-done
addition fail at import — plus a corpus fixture, since the corpus guard asserts every declared block
type appears in it.

`blank_rows_table` needs one deliberate verifier consideration: an `EmptyCell` carries no figure and
no text, so the anchored pass has nothing to compare and ledger completeness is unaffected. That is
the correct behaviour (an empty cell is not a zero), and it is asserted rather than assumed.

---

## 4. The scan

### 4.1 Extending `list_inventory`

No new command and **no new event type** (Req: the event vocabulary is unchanged). The existing
handler already merges its result onto `done` via `invocation.outcome.update(...)`, so the extension
is to the aggregate KQL and to `InventoryDimensions`.

The current query summarises four `make_set_if(...)` sets. It gains a region set and **two separate
count families** — headline counts over non-child types, and child counts kept apart (§3.3):

```kql
| extend isChild = type in~ (<child types, from the catalogues at query-build time>)
| summarize resource_types    = make_set_if(type, isnotempty(type), 2001),
            resource_groups   = make_set_if(resourceGroup, isnotempty(resourceGroup), 2001),
            tag_keys          = make_set_if(tagKey, isnotempty(tagKey), 2001),
            tag_values        = make_set_if(tagValue, isnotempty(tagValue), 2001),
            regions           = make_set_if(location, isnotempty(location), 2001),
            type_counts       = make_bag(pack(type, count_distinct(id))),          // non-child only
            child_type_counts = make_bag(pack(type, count_distinct(id))),          // child only
            resource_count    = count_distinct(id)                                 // non-child only
```

The three count expressions are each computed over their own filtered arm — `resource_count` and
`type_counts` over `isChild == false`, `child_type_counts` over `isChild == true` — so a sub-record
never reaches a headline number. `resource_types` still carries **every** type including child ones,
because the scan screen lists what is there; it is the *counts* that are partitioned, not the
inventory.

The child-type list is built from the two catalogues by `is_child_type` (§3.3) at query-build time,
so there is no hand-maintained list in the KQL and adding a child type to `facts.v1.json` is the only
edit needed.

`InventoryDimensions` gains `regions: DimensionValues`, `type_counts: Mapping[str, int]`,
`child_type_counts: Mapping[str, int]` and `resource_count: int`; `to_plain_data()` carries them, and
they arrive on the `done` outcome exactly as the existing dimensions do. The `mv-expand` over tag
keys means `id` must be counted with `count_distinct` rather than `count` in **all three** count
expressions, or a resource with three tags is counted three times — the kind of arithmetic error that
produces a plausible number, so the design names it here and the test uses a fixture with multi-tag
resources.

`powerState` (Req 4.3) rides the same projection, reported as a count of deallocated machines rather
than as their absence.

### 4.2 The region route probe

Requirements 5.1 and 4.2 draw a hard line: one minimal request per region, **status code only**,
body discarded unread. The design's concern is that the scan and the run must agree on what a
status code means.

Today the classification is **split across two modules and is not a single predicate**:
`_DATA_PLANE_REFUSED_STATUSES = frozenset({401, 403, 404})` lives in `azure/metrics.py`, while
DNS failure is caught as `DnsResolutionError` in `azure/regions.py`, and both funnel into the
side-effecting `RegionResolver.mark_fallback_only(location)`.

The design extracts the predicate:

```python
# agent/src/reporting_agent/azure/regions.py
def is_data_plane_refusal(status: int | None, *, dns_failed: bool) -> bool:
    """Pure. The ONE reading of a data-plane response shared by the run and the scan."""
    return dns_failed or (status is not None and status in DATA_PLANE_REFUSED_STATUSES)
```

`azure/metrics.py` calls it instead of testing the frozenset inline; the scan probe calls the same
function. Two independent readings of the same status codes would let a scan promise a route the run
then declines, which is a lie the product cannot afford; one pure predicate makes that
unrepresentable. A probe that neither answers nor fails records `verdict: "unknown"` (Req 5.5).

### 4.3 Persistence and the route

`POST /api/subscriptions/[id]/scan` follows the existing route pattern exactly:
`export const runtime = "nodejs"`, `requireSessionForApi()`, zod `.strict()` schemas for path params
and body in a non-`server-only` `input.ts`, `json`/`unauthorized`/`invalidInput`/`unprocessable`
response helpers, ownership scoped by `user_id`.

It refuses before invoking when `scope_verified` is false or the secret has expired (Req 4.8) —
`unprocessable` with the reason, not a generic failure. `GET /api/subscriptions/[id]/scan` returns
the latest `ScanView`.

A scan is minutes-shorter than a report run but is not instant, so the row carries
`status` and the screen polls the `GET`. It deliberately does **not** join the `report_runs` state
machine: a scan produces no snapshot, no ledger and no artifact, so giving it the reaper, the
progress callback and the phase deadlines would be machinery with nothing to protect. A scan that
dies leaves a `running` row that the next scan supersedes, and the screen offers **Re-scan**.

---

## 5. The wizard

### 5.1 Five steps

`app/lib/profiles/wizard.ts` (moved from `app/lib/templates/wizard.ts`, same exports):

```ts
type WizardStepId = "identity" | "sections" | "period" | "document" | "preview"

WIZARD_STEPS = [
  { id: "identity", number: 1, title: "Identity",  summary: … },
  { id: "sections", number: 2, title: "Sections",  summary: … },
  { id: "period",   number: 3, title: "Period",    summary: … },
  { id: "document", number: 4, title: "Document",  summary: … },
  { id: "preview",  number: 5, title: "Preview",   summary: … },
]

STEP_FOR_FIELD = {
  schema_version: "identity", provider: "identity", identity: "identity",
  sections: "sections",
  period: "period",
  front_matter: "document",
  design: "document",          // resolved from Brand; an issue surfaces here, not in a Design step
}
```

Everything else in that module is reused unchanged: `issuesByStep` still groups
`collectDefinitionIssues(definition, { mode: "draft" })` by first path segment, `canAdvance` still
blocks forward navigation only on the current step's issues, `canReturnTo` still allows going back,
`openingStep` still opens the lowest failing step, `completionProblems` still validates in
`run` mode.

Each new step component satisfies the existing minimal contract
`{ definition, onChange }`, with additions where a step needs more:

| step | extra props |
|---|---|
| `StepSections` | `scan: ScanView`, `catalogue: SectionCatalogue` |
| `StepDocument` | `brand: BrandView`, `signatureUploadUrl` |
| `StepPreview` | unchanged from today (`problems`, `previewHtml`, …) |

Draft persistence is unchanged: fire-and-forget `PATCH /api/report-profiles/[id]` with
`draftDefinition` on every step transition (unvalidated, no version row), and
`POST /api/report-profiles/[id]` on **Save version** which validates in `run` mode, checks the
catalogue, and calls `insertVersion` with its sha256 dedupe.

The publish path gains two steps between validation and `insertVersion`:

1. resolve the referencing Brand into `definition.design` (§1.1);
2. after `insertVersion` returns, write `report_profile_authored_matches` for each section from the
   scan the wizard was working against.

Ordering matters: the match record references `template_version_id`, and `insertVersion` may return
an **existing** version when the digest is unchanged. In that case the match rows already exist and
the write is a no-op upsert on `(template_version_id, section_id)` — which is why that pair is the
unique constraint.

### 5.2 The section inspector

Left pane is the ordered list; right pane the inspector. Both are `"use client"` leaves under a
server-rendered page, per the `rsc: true` default.

Reordering must be keyboard-reachable (Req 7.6), which **decides the drag-and-drop library** rather
than being retrofitted: the canvas is a real DOM list in render order, each item is focusable, and
modifier+arrow moves it. The drop indicator is a 2px `--primary` rule at the insertion point. Moves
announce through one `aria-live="polite"` region naming the new position. Libraries that cannot do
keyboard reordering are excluded at selection time.

Resource chips (Req 9.3–9.4) are the subtle part. Clicking a chip must narrow the **rule**, so the
inspector computes, from the scan, whether the desired subset is expressible as
`type × resource_groups × tag_filters`. When it is, the rule is rewritten. When it is not, the
inspector says so and offers the dimensions that would express it — it never falls back to storing
ids, because there is no field to store them in.

### 5.3 The emit estimator

```ts
// app/lib/profiles/emit.ts  — pure, no fetch, no db
function estimateEmit(
  section: SectionSpec,
  scan: ScanView,
  catalogue: SectionCatalogue
): { headings: number; charts: number; tables: number; figures: number }
```

It walks the same `expands_to` the agent's expander walks, over the scan's `type_counts` instead of a
snapshot. Figure count is `statistics × metrics × matched_resources` plus declared fact columns —
the same arithmetic the compiler performs (Req 11.6).

The estimator and the expander must not drift, and a TypeScript function cannot be compared to a
Python one by a static test. The design's answer is a **shared expectation fixture**: a set of
`(catalogue entry, synthetic scan, expected counts)` cases in JSON, asserted by a vitest test
against `estimateEmit` and by a pytest test against a compile over a synthetic snapshot built from
the same counts. Both read one file, so a change to the expansion that moves the counts fails on
both sides or neither.

---

## 6. Brand

`app/lib/brands/store.ts` + `/brand` route. `ensureBrand(userId)` creates the default on first need
from the existing `DesignSpec` defaults (Req 2.3), so no account is asked to design a brand before
authoring.

The theme picker renders **real page images** (Req 2.5). Those thumbnails already exist — the
current `step-design.tsx` receives `thumbnails: readonly ThemeThumbnail[]` — so the Brand editor
consumes the same source rather than adding one.

The logo and signature images share one artifact path: private S3 objects under the owner's prefix,
presigned per request, never stored (Req 13.5). `logo_key` and `signature_key` are **keys**, and the
projection guard asserts no presigned URL survives into `BrandView`.

Req 2.7's scoping is stated in the editor UI and enforced by §1.1's resolve-at-publish: there is no
code path by which a Brand edit reaches an existing version.

---

## 7. The Document step and signatures

### 7.1 Front matter extensions

`front_matter.document_control` gains, additively:

```jsonc
"approvers": [
  { "role": "author", "company": "…", "name": "…", "title": "…", "signature_key": "…" | null }
],
"distribution": [ { "recipient": "…", "company": "…", "note": "…" } ]
```

`distribution` changes from a string to rows. At v3 only — the v2 string form keeps validating, so
Req 20.3's "carry `front_matter` through unchanged" stays true for a lifted v2 profile until the
author edits it.

The four roles keep the stored ids `("author", "reviewer", "approver", "recipient")` that
`APPROVER_ROLES` declares in both halves, relabelled positionally to
`Author / Quality Control / Reviewed By / Customer` through the message catalogue (the decision
recorded in requirements 12.3). No fixture, no mirror region and no validator rule changes to
relabel a row. The set stays closed at four (Req 12.5).

### 7.2 The signature cell

`render/front_matter.py::_emit_approvers_table` today sets `row_cells[3].text = ""` unconditionally
and calls `_set_row_height(row, SIGNATURE_BOX_HEIGHT_TWIPS)` with `w:hRule="atLeast"`. The change is
narrow and keeps the unsigned behaviour as the **fallback**:

```python
row_cells[3].text = ""                        # unchanged: never the typed name
if approver.signature_image is not None:      # new
    _place_signature(row_cells[3], approver.signature_image,
                     max_height_twips=SIGNATURE_BOX_HEIGHT_TWIPS)
_set_row_height(table.rows[i + 1], SIGNATURE_BOX_HEIGHT_TWIPS)   # unchanged, after either path
```

Setting the row height **after** placement, with `atLeast` and an image scaled to fit within it, is
what makes a signed row and an unsigned row occupy the same space (Req 13.3) — so pagination does
not depend on who signed.

The image bytes reach the runtime as part of the invoke payload's front-matter resolution, not as a
URL the container fetches: the runtime holds no session and must not make outbound calls to the app
for content. `signature_key` is resolved server-side in the app to bytes and passed inline, and the
key is registered with no redaction guard because it is not a secret — but the bytes are excluded
from every log line by the existing payload-logging rules.

A signature is presentation only (Req 13.7): no ledger entry, no numeric gate, and its absence is
not a finding.

### 7.3 Run-time shrinkage

`run-form.tsx` loses `customerName`; `revision`, `revisionNote` and `revisionAuthor` stay, and the
incident rows join them. `report_pipeline.py::_resolve_run_facts` keeps reading
`payload.get("customer_name")` — the field stays on the wire, sourced from the pinned version
instead of a form field (Req 12.9). That deliberately keeps the existing store-to-send mirror guard
(which extracts `payload.get(...)` keys from `_resolve_run_facts` and asserts the app sends exactly
those) applicable with no change to its mechanism.

`period_display` continues to be computed in the app with `Intl.DateTimeFormat`, since the runtime
has no locale library and the definition now carries `identity.language`.

---

## 8. Charts

### 8.1 Panels in the AST

`Chart` gains one field:

```python
panels: tuple[tuple[str, ...], ...] = ()     # series keys per panel, in panel order
```

Empty means one panel with every series — so every existing `Chart` construction and every existing
test is valid unchanged.

The grouping is computed by the **compiler**, not the renderer, by a declared deterministic rule
(Req 17.2):

```python
def panel_groups(series: tuple[Series, ...]) -> tuple[tuple[str, ...], ...]:
    """Pure. Series whose max |value| differ by >= one order of magnitude split panels."""
```

Ordering is by descending panel maximum, so the larger-magnitude panel is on top —
`design/Charts.dc.html` shows Maximum above Average. The same rule is implemented in
`app/components/charts/` over the parsed spec, and the two are compared by the existing
`chartstyle` mirror pattern (`test_chartstyle.py` already reads `palette.ts` and asserts value
equality with the Python side) extended to the panel thresholds.

### 8.2 The renderer

`render_chart` builds N subplots instead of one:

```python
figure = MplFigure(figsize=style.chart_size_inches(panel_count), dpi=style.CHART_DPI)
axes_list = figure.subplots(panel_count, 1, sharex=True, squeeze=False)[:, 0]
for axes, keys in zip(axes_list, groups, strict=True):
    _draw(axes, node, tuple(s for s in series_set if s.key in keys), theme=theme, messages=messages)
```

`_draw` keeps its signature and its body except `_bar_offsets`, which now counts series **within a
panel**. `chartstyle.py` gains `CHART_PANEL_HEIGHT_INCHES` and `CHART_PANEL_GAP_INCHES` and a
`chart_size_inches(panels)` helper; `frozen_rc_params()` keeps pinning dpi, pad and
`figure.autolayout: False`, which is what keeps the PNG byte-reproducible (Req 18.8).

`docx.py::emit_chart` is unchanged: `_CHART_WIDTH_INCHES = 6.0` still matches the figure width, so a
taller PNG embeds without resampling.

### 8.3 What must stay invariant, and why verification does not move

`verify/charts.py::check_charts` recomputes `chart_data_hash(node, messages=...)` from the AST and
compares it against the sidecar digest. The hash is over `(series.key, point.x, str(point.y.value))`
and includes no axis range, no geometry and no panel assignment — so **panelling is invisible to the
verifier**. Four things must stay true and each gets an assertion:

1. one PNG per `Chart` node, one sidecar, one `cht:<path>` alt-text identity — the pairing contract;
2. the companion table lists every plotted point of every panel, unthinned (Req 17.8);
3. `chart_data_hash` unchanged by panel assignment (Req 17.7);
4. `plotted_series`'s five-series cap and aggregate behaviour applies to the chart, not per panel.

### 8.4 Value labels

`label_indices` changes from "every point when ≤ 24, else four" to the last point only:

```python
def label_indices(points: tuple[ChartPoint, ...]) -> frozenset[int]:
    return frozenset() if not points else frozenset({len(points) - 1})
```

`_LABEL_THRESHOLD` is deleted. The assertions in `test_charts_10_1.py` that pin the old contract are
rewritten in the same change (Req 18.3) — a test asserting the superseded behaviour would otherwise
be the reason the change gets reverted by whoever runs the suite next.

The direct series label at the line end stays and becomes load-bearing rather than supplementary,
since it is now the only thing naming a series near its data.

---

## 9. Coverage and drift

`compile_document` gains `authored_matches: Mapping[str, AuthoredMatch] | None`, keyed by section id.
The coverage appendix's compiler compares it against what each section's rule resolved to in the
snapshot and emits added / no-longer-matching resources by name (Req 19.2).

**The counts in that comparison are numbers in a delivered document, so they cannot be bare
strings.** The existing mechanism for a count the compiler derives rather than reads from a metric
is `DerivedCount`, added by task 11.7 for `historical_points_emitted` and `historical_lookback`,
which the verifier re-derives independently from the ledger. `DERIVED_COUNT_KINDS` gains
`scope_added_count` and `scope_removed_count`, and the verifier's existing re-derivation path covers
them — reusing a proven pattern rather than inventing a second kind of unprovable number.

`authored_matches` travels in the `generate_report` payload, which means:
`agent/AGENTCORE_INTEGRATION.md` documents it in the same commit (Req 22.1), and the static mirror
guard covers it (Req 22.2). The payload carries the **authored** record only; the run-time set is
computed in-container from the snapshot, so no resource id list is round-tripped.

Styling is mist neutrals, never `--destructive` (Req 19.3): a newly matched resource is the rule
working correctly.

---

## 10. Migration

```ts
// app/lib/profiles/lift.ts — pure
function liftDefinition(stored: unknown): {
  draft: ProfileDefinitionV3
  brand: BrandDraft
  unmapped: readonly { blockId: string; blockType: string }[]
}
```

App-side only, because a lift produces a wizard **draft** and the runtime never sees one. It writes
nothing to `report_template_versions` (Req 20.6); the draft goes to `draft_definition` via the
existing unvalidated `saveDraft` path, which is exactly what that column is for.

Block → section mapping, by the AST each emits:

| stored block | section |
|---|---|
| `kpi_row`, `timeseries_chart`, `distribution_chart`, `capacity_vs_usage` | `vm_utilization` (or the type its scope names) |
| `resource_table`, `top_n_table` | `virtual_machines` or the section matching its `resource_types` |
| `historical_trend` | `historical_vm_utilization` |
| `gaps_and_coverage`, `verification_record`, `appendix_methodology` | `coverage_and_verification` |
| `executive_summary` | `azure_subscription` (its narrative slot) |
| `cover` | dropped — front matter owns it at v2+ |
| `heading`, `rich_text`, `page_break`, `row` | **unmapped** — reported, never silently dropped |
| `comparison_delta` | **unmapped** — comparison is a run pairing, not a profile section |

`heading` and `rich_text` being unmapped is correct rather than a gap: they are composition
primitives, and the whole point of the restructure is that section titles come from the catalogue.
Reporting them (Req 20.5) lets the author see what prose they will lose and choose.

Testing is over the shared corpus, which — per the corrected requirements — supplies both stored
versions: 44 fixtures at `schema_version` 1 and 10 at 2. The lifter is asserted to produce a draft
that `collectDefinitionIssues(draft, { mode: "draft" })` accepts for every accepting fixture.

Raising `MAX_SUPPORTED_SCHEMA_VERSION` to 3 is safe for the five deliberately-invalid fixtures
because `manifest.json` pins verdicts, digests and offender **paths**, not message text, and no
fixture asserts the maximum's literal value. New v3 accept and reject fixtures are added; **no
existing fixture is edited**, and a task that proposes editing one is the signal that the change is
less additive than assumed.

---

## 11. The four collectors (phase 2)

All three network sections are Resource Graph projections in the existing inventory pass, emitting
the synthetic child resources of §3.3. Advisor is a fifth fact source and follows the full checklist
the existing sources establish:

1. `DECLARED_FACT_SOURCES` in `catalog/loader.py` gains `"advisor"` (this is also what flips
   section 14's offerability);
2. `DECLARED_ABSENT_GAP_TYPES` gains `"advisor_not_available"`, with the constant in `collect/log.py`;
3. entries in `catalog/facts.v1.json` with `source: "advisor"`, `projectable: false`;
4. a port method in `azure/ports.py`, implemented in `azure/clients.py`;
5. `_collect_advisor` in `azure/facts.py` following `_collect_backup`'s shape — semaphore, request
   target constant, value paths, `narrowed_to_gap_type(...)`, added to the `asyncio.gather`;
6. `self._archive(...)` **before** folding, the same write-then-fold order every other source uses,
   so replay can reproduce the snapshot;
7. a permissions failure records `fact_unavailable`, never the absent-gap type — the distinction
   the reservations source already draws and the one that turns a role problem into a data problem
   if it is got wrong.

Every new numeric fact is a fixed-precision decimal string and every text fact an exact string, so
determinism and the snapshot hash are unaffected (Req 16.9).

---

## 12. Testing strategy

Guided by `tech.md`'s "What a green suite does not prove": a test that cannot fail for the reason
the code can break is not a test. Each item below names the failure it must be able to catch.

| Guard | Catches |
|---|---|
| Anchor-stability test: compile one profile twice, assert identical anchor id sets | An expander whose derived ids depend on iteration order rather than resolved resource order |
| Expander determinism over a fixed snapshot | Non-deterministic ordering that would break replay's bit-identical ledger |
| Shared emit-expectation fixture, read by vitest **and** pytest | The estimator and the expander drifting — the one cross-language pair a static mirror cannot compare |
| Fact-only resource type produces **no** `metric_not_selected` gap | Six subnets manufacturing phantom gaps per metric |
| Headline resource count invariant across a catalogue version that adds child types — same synthetic estate, counted before and after sections 3 and 6 become offerable | Sub-records inflating "Total Resources" so an unchanged subscription appears to grow between reports |
| `count_distinct` scan-count test with multi-tag fixture resources | The `mv-expand` triple-count, which produces a plausible wrong number |
| `is_data_plane_refusal` called by **both** the run and the probe (call-site test, not a mirror) | The scan promising a route the run declines |
| Chart hash invariance under panel assignment, mutation-checked | A panel field leaking into the hash and failing verification on a correct report |
| Companion table completeness across panels | Panel-aware thinning |
| Signature-cell test asserting empty **and** image-bearing rows, mutation-checked both ways | The typed name returning to a signature position |
| Row-height equality between signed and unsigned rows | Pagination depending on who signed |
| `DerivedCount` re-derivation for the two new kinds | A drift count entering the document unprovable |
| Every catalogue entry rendered through docx, HTML and PDF (Req 15.9) | A section whose emitter has never run |
| Projection guards for `BrandView` and `ScanView` | A presigned URL or `user_id` reaching the browser |
| Corpus: new v3 accept + reject fixtures, no existing fixture edited | Divergent validators; a non-additive change disguised as additive |
| Literal-copy guard extended to the new surfaces | Hard-coded copy in the profile, scan, section, brand and document components |

---

## 13. Phasing and deployment order

Deployment order per the repo rule — **migration → app → runtime** — because the runtime is the only
component that can present values the database must already accept.

| Phase | Contents | Ships independently? |
|---|---|---|
| **0** | `is_data_plane_refusal` extraction; `list_inventory` count + region extension; `subscription_scans` table + route | Yes — the scan screen works before any wizard change |
| **1** | `brands` table, Brand editor, resolve-at-publish | Yes — the existing wizard's Design step can be removed the moment Brand exists |
| **2** | `sections.v1.json`, `compile/sections.py`, `schema_version` 3, the two new block compilers, 5-step wizard, emit estimator, migration lifter | The largest phase; the restructure is only visible here |
| **3** | Document step, signature images, distribution rows | Yes |
| **4** | Chart panels + last-value labels | Yes — independent of everything above |
| **5** | VNet, public IP, NSG collectors; `advisor` fact source; sections 3/5/6/14 flip to offerable | Yes, four times over — one collector per increment |

Phase 0 first is the ordering correction the investigation forced: step 2 of the wizard cannot be
built against a command that reports no counts.

**Phase 5 must not change any headline count for an unchanged subscription.** That is the property
that makes it safe to ship to a customer mid-engagement: sections 3 and 6 becoming offerable adds
subnets and security rules to the snapshot, and because child types are excluded from
`resource_count` and `type_counts` by construction (§3.3, §4.1), the scan summary bar, section 1's
total and section 2's per-group figures read identically before and after. The guard in §12 asserts
exactly that over one synthetic estate. Without it, an untouched subscription would report 47
resources one month and 71 the next, and the report would be claiming growth that never happened.

Should a future catalogue version ever change a headline count legitimately, the explanation is
already recorded: `subscription_scans.sections_catalogue_version` pins the catalogue each scan was
taken under, so two scans that disagree can be attributed to the catalogue rather than to the estate.

---

## Design decisions and rejected alternatives

| Decision | Rejected alternative | Why |
|---|---|---|
| Sections expand to `BlockSpec`s; block compilers unchanged | New section compilers emitting AST directly | Anchors, ledger, `assert_ledger_matches_tree` and every verification gate already work over `BlockSpec`; a parallel path would duplicate the one thing that must not drift |
| Section catalogue as one shared JSON file | Sentinel-mirrored declarations in both halves | The existing extractor reads quoted strings and flat records, not nested per-preset objects; one file makes drift impossible rather than detected |
| Brand resolved into `definition.design` at publish | Runtime dereferences `brand_id` | Puts a mutable row on the render path and breaks "delivered reports render as delivered" |
| Authored matches in their own table | A field inside the definition | Would make `definition_sha256` a function of the customer's estate, breaking version dedupe and the fixture-pinned digests |
| Sub-records as synthetic child resources with real ARM ids | List-valued facts + a `subrecord_table` block | Four new surfaces (fact model, AST, verification, compiler) to express what the resource model already expresses; a subnet is an addressable resource |
| Child types excluded from headline counts, counted separately | Counting every ARM id uniformly | A subnet is addressable but is not a deployed thing in the sense "47 resources" means to a reader; uniform counting makes a catalogue-version change look like infrastructure growth |
| Scan outside the `report_runs` state machine | Scan as a run status | A scan produces no snapshot, ledger or artifact — the reaper and phase deadlines would protect nothing |
| Panel grouping computed by the compiler, carried in the AST | Renderer infers panels from units | The renderer would make a data decision the ledger cannot show; and the in-app chart would have to infer it identically by accident |
| `panels` defaults to empty (one panel, all series) | Required field | Every existing `Chart` construction and test stays valid, so the change is additive |
| Lifter is app-side only | Mirrored in both halves | The runtime never sees a draft; mirroring it would guard a path that does not exist |

---

## Requirements traceability

| Requirement | Design section |
|---|---|
| 1 — the noun and routes | §5.1 (`app/lib/profiles/*`), §1.2 (tables keep their names) |
| 2 — Brand | §1.1, §1.2, §6 |
| 3 — provider | §1.1, §2.1, §2.2 |
| 4 — the scan reports the estate | §4.1, §4.3 |
| 5 — collection problems at authoring time | §4.2 |
| 6 — which sections it unlocks | §2.4 |
| 7 — a profile is an ordered list of sections | §1.1, §3.1, §5.1, §5.2 |
| 8 — fixed closing sections | §2.2 (`position`), §2.3, §3.1 |
| 9 — rules, never frozen ids | §1.1 (`selection`), §3.1, §5.2 |
| 10 — three-tier metric picker | §2.2 (`presets`), §5.2 |
| 11 — the emit summary | §5.3 |
| 12 — document details on the profile | §7.1, §7.3 |
| 13 — signature never a typed name | §7.2 |
| 14 — one number per period | §7.1 (unchanged `document_number`), §12 |
| 15 — the section catalogue | §2.2, §2.3, §3.3, §3.4 |
| 16 — nine first, four later | §2.4, §11, §13 |
| 17 — two panels | §8.1, §8.2, §8.3 |
| 18 — three cues, last value only | §8.4, §8.3 |
| 19 — drift reported | §9 |
| 20 — migration | §10 |
| 21 — verification untouched | §3.2, §8.3, §12 |
| 22 — mirrored and documented contract | §2.1, §9, §12 |
| 23 — delivered reports frozen | §1.1, §5.1 (publish path), §6 |
