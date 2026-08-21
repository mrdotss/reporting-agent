# Requirements Document

## Introduction

This spec turns the report from a proof of concept into a **deliverable document**. Two things
are wrong today and both are visible in a real run: the report covers exactly one resource
type, and it does not look like a document a consultant would hand a customer.

It builds on two **completed** specs — `reporting-agent-foundation` and
`reporting-agent-templates-reports` — and **does not restate them**. Authentication, Azure
onboarding, the `scope_verified` preflight, the collector, the immutable content-addressed
snapshot, the raw archive, the `report_runs` state machine, the progress callback, the reaper,
the SSE relay, the redaction guard, the template definition model, the seven-step wizard, the
document AST, the figure ledger, the two emitters, the verifier and its sixteen blocking
finding types are **already specified and built**. Where this spec extends one of those, the
criterion names the spec and criterion it extends. Where it depends on one unchanged, it
references rather than duplicates.

`.kiro/steering/azure-integration.md` is **binding**. Its findings — the data-plane
`401`/`403`/`404` reroute to the ARM per-resource path, the archive's `Decimal` → digit-string
→ `str` reader obligation, and intervals carrying a timestamp and nothing else — are facts
established against the real APIs. Every criterion below **composes with** them and none
weakens one.

### The invariant does not move

**No LLM ever produces a number.** Everything this spec adds passes the same gates as
everything already there. Three consequences are load-bearing rather than restated for
emphasis:

- A **numeric fact** is a `Figure` like any other. It carries a `snapshot_path`, it lands in
  the figure ledger, it is checked by anchored cell equality, and it is present in replay.
- A **text fact** is the one genuinely new verification surface, and it exists because the
  numeric path **structurally cannot** catch it. `verify/masking.py`'s stage 2 masks
  `[A-Za-z_][\w.\-]*[0-9][\w.\-]*`, so `Standard_D4s_v3` is masked as an identifier, and
  `Succeeded` carries no digit so it is never a numeric token at all. A text fact therefore
  gets its own ledger entry and its own exact-string anchored check.
- **Every response that produces a fact is archived.** A fact-producing response absent from
  the archive means replay cannot reproduce the snapshot, which means `REPLAY_MISMATCH` on
  every run.

### What is wrong today, precisely

Each item is verified against the implementation rather than assumed, and each is cited in the
criterion that corrects it.

| Observed | Where |
|---|---|
| The catalog declares exactly one resource type, so every other type reports `metric_not_selected` — 20 of 23 resources on a live run | `agent/src/reporting_agent/catalog/metrics.v1.json`, `catalog_version` `1.0.0` |
| Scope is three comma-separated free-text fields | `app/components/templates/step-scope.tsx`, `parseList` / `parseTagFilters` |
| A block's list-valued config is edited as raw JSON, and the pane says it does not guess | `app/components/templates/block-inspector.tsx`, `fieldValue` / `parseFieldValue` |
| The template name is written to `definition.identity.name` only; nothing calls `renameTemplate`, so the list shows `Untitled template` forever | `app/components/templates/step-identity.tsx` |
| The gap list renders one paragraph per entry — 512 entries on a live run, most naming the same resource | `app/components/reports/gap-list.tsx` |
| The drift seed is 64 hexadecimal characters in a bare `<span className="font-mono">` while every hash beside it uses `CopyDigest` | `app/components/reports/verification-panel.tsx` |
| `render/html.py` emits `.rpt-table`, `.rpt-point` and `.rpt-figure` class names; `app/app/globals.css` contains **zero** `rpt-` rules, and consecutive chart points are joined with no separator | `render/html.py`, `app/app/globals.css` |
| The definition's `number_format` declares exactly `decimal_places` and `group_thousands`; no `language` field exists in either half | `app/lib/templates/definition.ts`, `agent/.../compile/definition.py` |

Two of those are **already half-built**, and the criteria below extend rather than replace:
`compile/format.py`'s `NumberFormat` already carries `decimal_separator` and
`grouping_separator` with `.` and `,` defaults, and `verify/pdf.py` already reads both from the
number format rather than hard-coding them. The gap is that the **definition schema** declares
neither. Likewise the snapshot already records `catalog_version`, so a report already stays
readable against the catalog that produced it.

### Scope boundary

| In scope | Out of scope |
|---|---|
| Six additional resource types in the metric catalog, each entry verified against the Metric Definitions API | Non-Azure providers; resource types beyond the seven named |
| `facts` on every snapshot resource, with `Fact` and `TextFact` verification | Facts a customer must install an agent to expose |
| A live inventory endpoint and pickers for scope, metrics and block config | A resource picker that stores a named resource |
| `front_matter`: cover, document control, table of contents | A page-level layout editor; free positioning |
| `identity.language` (`en`, `id`) and a message catalog | A third language; user-authored translations |
| Declared `number_format` separators, end to end through render and verify | A locale library; per-figure format overrides |
| Chart appearance: axis titles, units, gridlines, legend, value labels, title, period | A charting DSL; user-authored chart styling |
| `historical_trend` compiled from prior verified runs | Forecasting, interpolation, trend-line fitting |
| Gap grouping, panel overflow, paper-render styling | A new verification surface for the in-app rendering |
| Additive schema growth; `schema_version` 2 | Any `DROP`; any rewrite of a stored template version |

**Two constraints on how this spec may grow the schema.** A template version is immutable
(templates criterion 9.3) and `MAX_SUPPORTED_SCHEMA_VERSION` is `1` in both halves today, so
introducing `front_matter` and `language` raises it to `2` and the compiler **must keep
accepting `schema_version` 1** — an archived report stays reproducible from its pinned version,
and `app/lib/templates/starters.ts` alone carries five `cover` blocks in stored version 1 rows.
And this spec **adds no SSE event type**, so the cross-language event mirror the foundation's
criterion 40.13 guards stays unchanged.

---

## Glossary

Vocabulary is used identically to `product.md`, `structure.md`, the foundation spec and the
templates spec. Terms marked **(system)** are the actors EARS criteria name in the
`THE <system> SHALL` position.

### Carried forward unchanged

- **snapshot** — the immutable, content-addressed result of one collection run, RFC 8785 (JCS)
  canonicalized and SHA-256 hashed. `snapshot_id` **is** that hash.
- **figure** — one numeric with its full provenance: `value` as a fixed-precision decimal
  string, `formatted`, `unit`, `snapshot_path`, `estimator`, `derived_from`, `formula`,
  `resource_id`, `metric`, `window`, `fidelity_tier`.
- **figure ledger** — every figure of one compiled AST, keyed by AST node path. The ledger and
  the render context are **the same object**.
- **table anchor** — the triple `{table_id, row_key, col_key}` mapping to one exact string.
  `table_id` lives in the table's Alt Text at `w:tblPr/w:tblCaption`.
- **collection_log** — the typed, per-resource record of gaps. A gap is recorded, never
  zero-filled.
- **verification result** — pass or fail plus every finding. A report without a passing
  verification is not a report.

### Introduced by this spec

- **Fact** — one point-in-time datum about a resource, carried in the snapshot parallel to a
  statistic: `Fact(key, value, unit?, source, collected_at, formatted)`. A fact answers *what
  is this resource* rather than *how much did it do*.
- **`value_kind`** — the `Fact` field declaring whether that fact's value is `numeric` or `text`,
  recorded from the fact declaration for that key rather than inferred from the characters of the
  value. Inference cannot work: `2022` is an operating-system version that satisfies a decimal
  grammar, while `10.0.0.4` and `10.0.0.0/16` fail it. A router reading the characters formats a
  version with a grouping separator; a router reading the declaration does not.
- **fact declaration** — the per-resource-type statement of which facts that type has, each fact's
  `value_kind`, and whether Azure Resource Graph can project it. It is what makes an absent fact
  distinguishable from a fact the type never had.
- **fact source** — the value of a `Fact`'s `source` field, naming the API the value came from,
  drawn from `resource_graph`, `arm`, `recovery_services` and `capacity`. A fact's
  trustworthiness is a fact about where it came from, so the source travels with the value
  rather than being inferred from the key.
- **`collected_at`** — the **instant** a `Fact` was observed, in RFC 3339 form with a `Z`
  designator and whole-second precision. It is an instant and **not** the collection period,
  because a fact is true at a moment and presenting `last backup: Success` as characterising a
  whole month is the same class of error as reporting 0% CPU for a deallocated virtual machine.
- **numeric fact** — a `Fact` whose `value` is a fixed-precision decimal string. It compiles to
  a `Figure` and is verified as any other figure is.
- **TextFact** — the AST node a non-numeric `Fact` compiles to, carrying `path`, `key`,
  `value`, `snapshot_path`, `source`, `collected_at` and `formatted`. It is a **ledger entry**
  and is verified by **exact string equality at its anchor**. It exists because numeric masking
  cannot catch it.
- **text-fact anchor** — the triple a `TextFact` records in the ledger, identical in shape to a
  table anchor and resolved the same way.
- **`front_matter`** — the section of a template definition declaring the cover, the document
  control page and the table of contents. It is **not composable and not reorderable**: every
  report opens the same way and the block palette starts at the content.
- **document control** — the front-matter page carrying the document title, customer, document
  name, document number, an approvers table, a revision history table, a distribution list and
  a confidentiality notice.
- **approvers table** — the document-control table carrying one row per approval role — author,
  quality control, reviewer, customer — each with company, name and signature.
- **document number** — the identifier printed on the cover and the document-control page,
  produced by applying the template's document-number pattern to one run.
- **table of contents** — the front-matter section listing each section heading against the
  **page the heading is on**. A table of contents whose page numbers are wrong is worse than no
  table of contents.
- **`identity.language`** — the template setting selecting the language of every piece of fixed
  copy, one of `en` and `id`.
- **message catalog** — the keyed store of every fixed string the document and the interface
  emit, resolved by string id and language. No literal user-facing copy is emitted from a
  renderer or a component.
- **`number_format`** — the definition's declaration of how a figure is written:
  `decimal_places`, `group_thousands`, `decimal_separator` and `grouping_separator`. The
  **declared** format is what the renderer writes and what the verifier checks against.
- **declared separator** — the `decimal_separator` or `grouping_separator` a definition
  declares. Under `id` the decimal separator is a comma and that is **correct**, so the
  verifier's question is never *is this a comma* but *does this match what was declared*.
- **`historical_trend`** — the block type plotting one point per prior period, resolved from the
  stored snapshots of prior **completed and verification-passed** runs of the same template and
  subscription whose periods do not overlap.
- **historical point** — one plotted point of a `historical_trend`, carrying the run id and the
  snapshot hash it came from.
- **lookback** — the count of prior periods a `historical_trend` requests. Fewer available
  prior runs than requested is **normal**, especially on a first report.
- **typed exclusion reason** — the declared reason a candidate prior run was excluded from a
  `historical_trend`, drawn from `status_not_completed`, `verification_not_passed`,
  `period_overlapping`, `metric_absent_in_snapshot`, `fidelity_tier_differs` and
  `beyond_lookback`. It exists so the statement naming the absent periods resolves a declared
  value rather than composing prose.
- **no-metric key** — the declared key occupying the metric position when a `collection_log`
  entry carries no metric. `RunGap`'s `metric` is a string or `null` and `record_gap` accepts
  `metric` as `str | None`, so a `(resource_id, metric)` grouping key is not total without it.
- **`catalog_version`** — the metric catalog's declared version, already recorded on every
  snapshot by `collect/snapshot.py`, so a report stays readable against the catalog that
  produced it.
- **gap group** — one row of the grouped gap list: a `gap_type`, or a `(resource, metric)`
  pair within a type, carrying a count, one representative message and, where the underlying
  intervals are contiguous, a time range.

### Gap types this spec adds

Added to the foundation's declared `gap_type` set in `agent/.../collect/log.py`, which today
declares twenty. Each is neutral information, never an empty string and never a zero.

- `backup_not_configured` — the resource has no backup configured, so there is no last-backup
  status and no restore point to report.
- `no_reservations` — no reservation covers this resource, so there is no term and no expiry.
- `replication_not_enabled` — Site Recovery is not enabled for this resource, so there is no
  replication health to report.
- `fact_unavailable` — a fact-producing request failed, was rejected, or returned no value for
  a resource whose type declares that fact.

### Verification finding types this spec adds

Added to the templates spec's sixteen blocking types. Every one is **blocking**, and the
enumeration meta-test that spec's criterion 44.1 declares grows to cover them, so a type
declared here without a negative test fails the suite.

- `text_fact_mismatch` — a `TextFact`'s resolved cell text differs from the ledger's exact
  string.
- `text_fact_anchor_missing` — a `TextFact` ledger entry's anchor resolves to no cell.
- `text_fact_unanchored` — a `TextFact` reached the document outside a data-table cell, so it
  cannot be anchored and therefore cannot be checked.
- `historical_point_unverified` — a historical point was sourced from a run whose verification
  did not pass.
- `historical_point_overlapping` — two historical points were sourced from runs whose periods
  overlap.
- `toc_page_mismatch` — a table-of-contents entry names a page other than the page its heading
  is on.
- `fact_source_missing` — a `Fact` reached the compiler carrying no `source` or no
  `collected_at`.

### Systems

Carried forward and referenced unchanged: **Web_App**, **Agent_Runtime**, **Run_State_Machine**,
**Snapshot_Builder**, **Metric_Catalog**, **Boundary_Guard**, **Projection_Guard**,
**Enqueue_Action**, **Progress_Reporter**, **Progress_Endpoint**, **Reaper**, **SSE_Relay**,
**Crypto_Module**, **Env_Module**, **Template_Store**, **Template_Version_Store**,
**Template_Validator**, **Template_Wizard**, **Block_Composer**, **Style_Picker**,
**Preview_Canvas**, **Period_Resolver**, **Scope_Resolver**, **Block_Compiler**, **AST_Model**,
**Figure_Ledger**, **Formatter**, **Estimator_Labeller**, **Docx_Renderer**, **Anchor_Writer**,
**Html_Emitter**, **Chart_Renderer**, **Pdf_Converter**, **Theme_Guard**, **Build_Pipeline**,
**Token_Extractor**, **Verifier**, **Replay_Verifier**, **Drift_Sampler**, **Prose_Reviewer**,
**Delta_Compiler**, **Verification_Store**, **Report_Detail_View**, **Verification_Panel**,
**Mirror_Guard**, **Inventory_Collector**, **Metrics_Collector**, **Definition_Probe**,
**Archive_Writer**, **Accumulator**.

Introduced by this spec:

- **Catalog_Evidence_Guard (system)** — the test comparing every catalog entry against a
  recorded Metric Definitions API response for that resource type.
- **Fact_Collector (system)** — `agent/.../azure/facts.py`: the fact collection pass.
- **Fact_Compiler (system)** — the compile path turning a snapshot `Fact` into a `Figure` or a
  `TextFact`.
- **Text_Fact_Verifier (system)** — `agent/.../verify/facts.py`: the exact-string anchored
  check over every `TextFact` ledger entry.
- **Inventory_Endpoint (system)** — `app/app/api/subscriptions/[id]/inventory/route.ts`: the
  live distinct-values endpoint backing every picker.
- **Scope_Picker (system)** — the wizard step 2 picker over resource types, resource groups and
  tag keys and values.
- **Metric_Picker (system)** — the wizard step 4 selection grid, grouped by resource type.
- **Block_Config_Picker (system)** — the inspector's picker for a block's metric-valued config
  fields.
- **Front_Matter_Renderer (system)** — `agent/.../render/front_matter.py`.
- **Toc_Builder (system)** — `agent/.../render/toc.py`: the table of contents and its page
  numbers.
- **Toc_Verifier (system)** — the check that each table-of-contents entry names the page its
  heading is on.
- **Message_Catalog (system)** — the keyed fixed-copy store, mirrored across both halves.
- **Historical_Resolver (system)** — `agent/.../compile/historical.py`: prior-run selection.
- **Gap_Grouper (system)** — `app/lib/runs/gap-groups.ts`: the lossless grouping of a
  collection log.
- **Paper_Stylesheet (system)** — the `rpt-` rules rendering the in-app paper view.

---

## Requirements

### Section A — The catalog beyond virtual machines

#### Requirement 1: The catalog covers the resource types a real subscription contains

**User Story:** As a consultant, I want the report to cover the whole estate I connected, so
that a subscription of twenty-three resources does not produce a document about three of them.

##### Acceptance Criteria

1. THE Metric_Catalog SHALL declare an entry for each of `Microsoft.Compute/virtualMachines`,
   `Microsoft.Sql/servers/databases`, `Microsoft.Sql/managedInstances`,
   `Microsoft.DBforPostgreSQL/flexibleServers`, `Microsoft.Storage/storageAccounts`,
   `Microsoft.Compute/disks` and `Microsoft.Web/sites`, extending the single
   `Microsoft.Compute/virtualMachines` entry `agent/.../catalog/metrics.v1.json` declares
   today.
2. THE Metric_Catalog SHALL declare, for each entry it adds, that resource type's
   `metric_namespace` and at least one metric, and SHALL declare for every metric the fields
   the foundation's criterion 32.1 requires: the metric name, its unit, the unit family that
   selects its sketch, the aggregations requested for it and its fractional-digit count.
3. THE Metric_Catalog SHALL declare a `catalog_version` that compares greater than the `1.0.0`
   the current catalog declares when the two are compared component-wise as dotted decimal
   integers, and THE Snapshot_Builder SHALL record that version on every snapshot as it already
   does, so that a report rendered from an earlier snapshot stays readable against the catalog
   that produced it.
4. WHEN the Agent_Runtime loads the Metric_Catalog, THE Agent_Runtime SHALL validate every
   added entry through the same per-entry validation the foundation's criterion 32.3 declares.
5. WHERE a resource type's entry declares a derived statistic, THE Metric_Catalog SHALL declare
   that statistic's identifier, its unit, the unit family that selects its sketch, its
   fractional-digit count, its source metrics with the statistic taken from each, the SKU
   capabilities it consumes, its observation marker and its fixed formula string, and SHALL name
   in that formula only identifiers present in that entry's declared metrics or SKU
   capabilities.
6. THE Metric_Catalog SHALL declare no metric absent from that resource type's recorded
   Metric Definitions API fixture criterion 2.1 declares, and SHALL declare for each metric no
   unit and no aggregation that fixture does not report for that metric, so that the
   Metric Definitions API's report is the observable the declaration is testable against.
7. IF an added entry fails the validation criterion 1.4 declares, THEN THE Agent_Runtime SHALL
   record a `catalog_entry_invalid` gap carrying that entry's resource type and metric name,
   SHALL skip that entry, SHALL emit no statistic for that entry and SHALL continue the run, as
   the foundation's criterion 32.4 declares, so that a wrong catalog entry degrades a run rather
   than ending it — which is why a mistake here is silent and why the Catalog_Evidence_Guard
   requirement 2 declares is the control.
8. IF validation leaves zero valid metric, derived and enhanced-counter entries for every
   resource type present in the run's scope, THEN THE Agent_Runtime SHALL report the terminal
   code `CATALOG_UNUSABLE`, SHALL write no snapshot object and SHALL emit no `snapshot_ready`
   event, as the foundation's criterion 32.7 declares, so that skipping every entry is a proven
   failure rather than a run that continues with nothing to collect.
9. WHERE an added entry declares a metric for which the Metrics_Collector is to emit an average,
   THE Metric_Catalog SHALL request both `Total` and `Count` among that metric's aggregations,
   drawn from the declared aggregation set `Total`, `Count`, `Minimum` and `Maximum` that
   `DECLARED_AGGREGATIONS` in `agent/.../catalog/loader.py` declares, because that average is
   count-weighted as the sum of totals over the sum of counts and a metric requesting neither
   cannot produce one.

#### Requirement 2: Every catalog entry is verified against the Metric Definitions API

**User Story:** As a developer, I want a wrong catalog entry to fail the suite, so that a
guessed metric name does not make a metric permanently uncollectable with nothing failing.

##### Acceptance Criteria

1. THE Build_Pipeline SHALL carry exactly one recorded
   `MonitorManagementClient.metric_definitions.list` response per resource type the
   Metric_Catalog declares, committed to the repository as a fixture, capturing that response's
   metric names, each metric's unit and each metric's supported aggregations.
2. THE Catalog_Evidence_Guard SHALL assert, for every metric every Metric_Catalog entry
   declares, that a metric of that exact name is present in that resource type's recorded
   fixture compared as exact strings, that the unit the catalog declares is the term the unit
   mapping criterion 2.9 declares for the unit that fixture reports for that metric, and that
   every aggregation the catalog requests is among the aggregations that fixture reports as
   supported, compared as exact strings.
3. IF a Metric_Catalog entry declares a metric absent from that resource type's recorded
   fixture, declares a unit other than the term criterion 2.9's mapping declares for the unit
   that fixture reports for that metric, or requests an aggregation the fixture does not report
   as supported, THEN THE Catalog_Evidence_Guard SHALL fail the test suite naming the resource
   type, the metric name and the disagreeing field.
4. IF a Metric_Catalog entry declares a resource type for which no recorded fixture exists,
   THEN THE Catalog_Evidence_Guard SHALL fail the test suite naming that resource type, so that
   an entry cannot be added without the evidence it was derived from.
5. THE Catalog_Evidence_Guard SHALL record, alongside each fixture, the subscription-independent
   provenance of that capture, being the resource type, the region and the capture instant
   expressed as a UTC instant in RFC 3339 form with a `Z` designator and whole-second precision,
   and SHALL exclude from every fixture every subscription identifier, tenant identifier,
   resource identifier and credential value.
6. THE Catalog_Evidence_Guard SHALL run in the test suite and in the container image build, so
   that an image cannot carry a catalog entry contradicted by the evidence committed beside it.
7. THE Catalog_Evidence_Guard SHALL assert that no metric name a Metric_Catalog entry declares
   differs from its fixture's name only by letter case, by surrounding whitespace or by a
   substituted separator character, comparing the two after case folding, after trimming leading
   and trailing whitespace and after replacing each space, underscore, hyphen, forward slash and
   period with one single sentinel character, and SHALL fail the test suite naming the resource
   type, the declared name and the fixture name WHERE those normalized forms are equal while the
   exact strings are unequal, because a portal display name and an API metric name differ in
   exactly those ways and a near-miss is the failure this guard exists to catch.
8. IF a Metric_Catalog entry's declared unit family selects neither the fixed 0-to-100 histogram
   nor the DDSketch, THEN THE Metrics_Collector SHALL record a `percentile_unsupported_unit` gap
   for that metric, SHALL emit no percentile for it and SHALL continue collecting its average,
   minimum and maximum, as the foundation's criterion 32.6 declares.
9. THE Catalog_Evidence_Guard SHALL declare a mapping associating each unit name a recorded
   fixture reports with exactly one term of the declared unit set `percent`, `bytes` and
   `count_per_second` that `DECLARED_UNITS` in `agent/.../catalog/loader.py` declares, because
   the Metric Definitions API reports its own unit vocabulary while the foundation's criterion
   32.3 constrains a catalog entry's unit to that declared set, and comparing the two as equal
   strings would fail every correct entry.
10. IF a recorded fixture reports, for a metric a Metric_Catalog entry declares, a unit name the
    mapping criterion 2.9 declares no term for, THEN THE Catalog_Evidence_Guard SHALL fail the
    test suite naming that resource type, that metric name and that unit name, so that an
    unrecognised unit is an explicit mapping decision rather than a silently accepted entry.
11. IF a recorded fixture carries a subscription identifier, a tenant identifier, a fully
    qualified resource identifier or a credential value, THEN THE Catalog_Evidence_Guard SHALL
    fail the test suite naming that fixture and the offending field, so that the exclusion
    criterion 2.5 declares is enforced rather than assumed.

#### Requirement 3: Breadth composes with the collector's existing behaviour

**User Story:** As an operator, I want seven resource types collected under the same batching,
regional and throttling rules as one, so that breadth does not become a second collector.

##### Acceptance Criteria

1. WHEN the Metrics_Collector groups resources of an added resource type, THE Metrics_Collector
   SHALL group by the key `(subscription, location, resource_type)` and SHALL send exactly one
   `metric_namespace` per batch request, as the foundation's criteria 23.1 and 23.10 declare.
2. WHEN the Definition_Probe needs metric definitions for an added resource type, THE
   Definition_Probe SHALL probe once per `(resource_type, region)` pair and SHALL serve every
   later request for that pair from its cache, as the foundation's criteria 22.1 and 22.2
   declare.
3. IF the batch metrics endpoint itself answers `401`, `403` or `404` for a location, being the
   response to the batch request rather than a per-resource error inside a response answered
   `200`, THEN THE Metrics_Collector SHALL mark that location fallback-only for the remainder of
   the run, as the foundation's criterion 24.6 declares, SHALL re-issue that location's requests
   against the ARM per-resource path, and SHALL record no gap for that reroute, because that
   response is a property of the data plane rather than of the caller and classifying it as a
   permission gap turns a fully collectable subscription into `NO_STATISTICS` while a working
   route sits unused.
4. WHERE a resource of an added resource type carries no value, or a zero value, for a SKU
   capability the Metric_Catalog declares for its type, THE Accumulator SHALL emit no derived
   value for every derived statistic consuming that capability and THE SKU_Catalog SHALL record
   a `sku_capability_missing` gap naming that resource and that capability, as the foundation's
   criterion 21.10 declares.
5. WHEN the Metrics_Collector requests values for a resource of an added resource type, THE
   Metrics_Collector SHALL apply the grain the run resolved, restricted to `PT1H` or `PT15M`, and
   SHALL apply the points budget of 20000 with adaptive halving, as the foundation's criteria
   25.8 and 23.2 declare.
6. WHILE a run's scope contains a resource whose type the Metric_Catalog declares and for whose
   type the pinned template version selected at least one metric, THE Metrics_Collector SHALL
   record no `metric_not_selected` gap for that resource, so that adding a resource type to the
   catalog and selecting a metric for it removes that resource from the `metric_not_selected`
   group rather than leaving it there.
7. THE Metrics_Collector SHALL record a `metric_not_selected` gap for a resource whose type the
   pinned template version selected no metric for, as the foundation's criterion 23.15 declares,
   so that breadth in the catalog does not silently collect a type the template did not ask for.
8. IF a batch response the batch metrics endpoint answered `200` carries a per-resource error
   for a resource of an added resource type, THEN THE Metrics_Collector SHALL record a typed
   `collection_log` gap naming that resource and that metric, SHALL record no statistic and no
   zero value for it, and SHALL continue collecting every other resource of that batch, because
   a per-resource error inside a successful response is a fact about that resource rather than
   the endpoint-level refusal criterion 3.3 declares.
9. IF a location answers through neither the batch metrics endpoint nor the ARM per-resource
   path criterion 3.3 reroutes to, for any resource of an added resource type requested for it,
   THEN THE Metrics_Collector SHALL record a `region_unreachable` gap for each of those
   resources, SHALL record no statistic and no zero value for them, and SHALL report
   `REGION_UNREACHABLE` as non-terminal unless every location the run requested is unreachable,
   as the foundation's criteria 24.4 and 24.5 declare, so that a silently dropped region is
   never a silently incomplete report.

---

### Section B — Resource facts

Half the target document is not time series. It is tables of point-in-time facts: virtual
machine size, operating system, private address, virtual network address space, network security
group rules, reservation term and expiry, last backup status and restore point, replication
health. A fact is a second kind of collected datum, and it is verified rather than trusted.

#### Requirement 4: Facts are collected and recorded beside statistics

**User Story:** As a consultant, I want the document's configuration tables to come from the
snapshot, so that a value in a table I signed traces to a recorded observation.

##### Acceptance Criteria

1. THE Snapshot_Builder SHALL record, for every resource in a snapshot, a `facts` collection
   parallel to that resource's `statistics`, each entry carrying `key`, `value`, `value_kind`, an
   optional `unit`, `source`, `collected_at` and `formatted`, with `key` being 1 through 120
   characters and `value` being 1 through 512 characters.
2. THE Snapshot_Builder SHALL constrain a `Fact`'s `source` to exactly one of `resource_graph`,
   `arm`, `recovery_services` and `capacity`, and SHALL record that value from the request that
   produced the fact rather than deriving it from the fact's `key`.
3. THE Snapshot_Builder SHALL record every `Fact`'s `collected_at` as a UTC instant in RFC 3339
   form with a `Z` designator and whole-second precision, and SHALL record that instant as the
   moment the value was observed rather than as the run's collection window.
4. IF a `Fact` reaches the Snapshot_Builder carrying no `source`, carrying a `source` outside the
   set criterion 4.2 declares, or carrying no `collected_at`, THEN THE Snapshot_Builder SHALL
   raise an error naming that fact's resource id and key and SHALL write no snapshot object,
   because a fact whose provenance is absent is an assertion rather than an observation.
5. THE Snapshot_Builder SHALL order each resource's `facts` collection by `key` ascending in
   Unicode code-point order, and SHALL include that collection in the RFC 8785 canonical form
   the `content_hash` is computed over, so that two collections over identical input produce one
   identical snapshot digest.
6. THE Snapshot_Builder SHALL record a `Fact` whose `value_kind` is `numeric` with a `value`
   matching the anchored fixed-precision decimal grammar criterion 4.11 declares, and SHALL record
   no `Fact` value as a JSON number, as the foundation's criterion 34.2 declares for every metric
   value.
7. WHERE the fact declaration marks a fact as projectable from Azure Resource Graph, THE
   Fact_Collector SHALL collect that fact in the same pass as inventory, extending the projection
   the Inventory_Collector already issues, so that a fact available from the inventory query costs
   no additional request.
8. THE Fact_Collector SHALL issue a request of its own only for a fact the fact declaration marks
   as not projectable from Azure Resource Graph, being the Backup, Site Recovery and Reservations
   facts, and SHALL issue no per-resource request for a fact the inventory projection already
   returned.
9. WHEN the Fact_Collector collects facts, THE Fact_Collector SHALL apply the concurrency cap of
   8 in-flight requests per subscription the foundation's criterion 23.7 declares, counting fact
   requests against the same limit as metric requests.
10. THE Snapshot_Builder SHALL record a `Fact` for a resource whose statistics are absent,
    including a resource carrying a `deallocated` or `permission_denied` gap, so that a stopped
    resource still contributes its configuration to the document.
11. THE Snapshot_Builder SHALL constrain a `Fact`'s `value_kind` to exactly one of `numeric` and
    `text`, THE Fact_Collector SHALL record that value from the fact declaration for that key
    rather than deriving it from the characters of the value, THE Snapshot_Builder SHALL accept a
    `numeric` value only where the whole value matches, end to end, an optional minus sign followed
    by one or more decimal digits optionally followed by a period and one or more decimal digits,
    carrying no exponent, no grouping separator, no leading plus sign and no surrounding
    whitespace, and IF a `Fact` reaches the Snapshot_Builder carrying no `value_kind`, carrying a
    `value_kind` outside that set, or carrying `value_kind` `numeric` and a value that grammar does
    not match, THEN THE Snapshot_Builder SHALL raise an error naming that fact's resource id and
    key and SHALL write no snapshot object, because the value's characters decide nothing on their
    own — `2022` satisfies that grammar as an operating-system version while `10.0.0.4` and
    `10.0.0.0/16` fail it, so a router reading the characters formats a version with a grouping
    separator and a router reading the declaration does not.
12. THE Snapshot_Builder SHALL record a `facts` collection for every resource in a snapshot,
    including a collection carrying zero entries, SHALL record at most one `Fact` per `key` per
    resource, and IF two `Fact` entries for one resource carry one identical `key`, THEN THE
    Snapshot_Builder SHALL raise an error naming that resource id and that key and SHALL write no
    snapshot object, because the ordering criterion 4.5 declares is a total order only where keys
    are unique and an absent collection and an empty collection are two different canonical forms
    of one observation.
13. THE Snapshot_Builder SHALL record every `Fact`'s `collected_at` as the instant at which the
    response carrying that value was received by the Fact_Collector, truncated toward the past to
    whole seconds, and IF a `Fact`'s `collected_at` is earlier than that run's `claimed_at` instant
    or later than the instant the snapshot object is written, THEN THE Snapshot_Builder SHALL raise
    an error naming that fact's resource id and key and SHALL write no snapshot object, because a
    `collected_at` outside the run's own lifetime is a period boundary or a clock default rather
    than an observation, and presenting `last backup: Success` as characterising a whole month is
    the same class of error as reporting 0% CPU for a deallocated virtual machine.

#### Requirement 5: A fact a subscription does not expose is a gap

**User Story:** As a consultant, I want an absent backup to say so, so that a blank cell is
never mistaken for a configured backup with nothing to report.

##### Acceptance Criteria

1. IF the source the fact declaration names for the backup facts answers a request covering a
   resource successfully and that response names no backup-protected item for that resource, THEN
   THE Fact_Collector SHALL record a `backup_not_configured` gap for that resource, SHALL record no
   last-backup-status fact and no restore-point fact for that resource, and SHALL record neither an
   empty string nor a zero for either.
2. IF the source the fact declaration names for the reservation facts answers a request covering a
   resource successfully and that response names no reservation covering that resource, THEN THE
   Fact_Collector SHALL record a `no_reservations` gap for that resource, and SHALL record no
   reservation-term fact and no reservation-expiry fact for that resource.
3. IF the source the fact declaration names for the replication-health fact answers a request
   covering a resource successfully and that response names no replication-protected item for that
   resource, THEN THE Fact_Collector SHALL record a `replication_not_enabled` gap for that resource,
   and SHALL record no replication-health fact for that resource.
4. IF a fact-producing request fails, is rejected, is answered with no value for a key the
   resource's type declares, or is answered with a value longer than the bound criterion 4.1
   declares, THEN THE Fact_Collector SHALL record a `fact_unavailable` gap naming that resource,
   that fact's key and the source that was queried, and SHALL record no fact for that key, so that
   a request that could not be answered is distinguishable from a response that answered that
   nothing is configured.
5. THE Fact_Collector SHALL record a `Fact` for a key only WHERE the response that produced it
   carried a value for that key, and SHALL record no `Fact` whose `value` is the empty string, so
   that every absence is a typed gap rather than a value and no value is substituted for one the
   response did not carry.
6. WHEN a run completes carrying at least one gap of a type this spec adds, THE Run_State_Machine
   SHALL set that run's `status` to `completed` and THE Agent_Runtime SHALL emit an `error` event
   carrying `PARTIAL_COVERAGE` with `terminal` false before `done`, as the foundation's criterion
   29.5 declares, so that a subscription without backups produces an honest report rather than a
   failed run.
7. THE Fact_Collector SHALL record every fact-collection failure as a typed gap and SHALL contain
   no code path that converts a fact-collection failure into a value, and THE Build_Pipeline SHALL
   fail IF a module on the path from a fact response to the Snapshot_Builder declares an exception
   handler whose body records no typed gap and re-raises no exception, so that the absence of bare
   exception suppression is asserted rather than reviewed.
8. THE Fact_Collector SHALL record exactly one gap per pair of resource and fact key that is
   absent, and WHERE the condition criterion 5.1, 5.2 or 5.3 declares holds for a fact key, THE
   Fact_Collector SHALL record that criterion's gap type for that key and SHALL record no
   `fact_unavailable` gap for the same key, so that one absence is one row of the grouped gap list
   rather than two and the displayed count is the count of absences.
9. WHERE a resource's type declares no fact of a given key, THE Fact_Collector SHALL record no gap
   of any type for that resource and that key, so that a gap states that a fact the type declares is
   absent rather than that a fact the type never had is absent — without which every storage account
   in a subscription collects a `no_reservations` gap.
10. THE Fact_Collector SHALL record on every gap of a type this spec adds the resource id, the fact
    keys that gap stands in for and the source that was queried, and SHALL record no empty string
    and no zero in any of those positions, so that the `(resource_id, metric)` grouping requirement
    20 declares is defined for a fact gap.

#### Requirement 6: A numeric fact is a figure, and a text fact is a TextFact

**User Story:** As a reviewer, I want a mutated `Succeeded` to fail verification, so that the
half of the document that is not numbers is proven too.

##### Acceptance Criteria

1. WHEN the Fact_Compiler compiles a `Fact` whose `value_kind` is `numeric`, THE Fact_Compiler
   SHALL emit a `Figure` carrying that fact's `snapshot_path`, and THE Figure_Ledger SHALL record
   that figure as it records every other figure, so that a numeric fact is checked by the anchored
   cell equality the templates spec's criterion 27.2 declares.
2. WHEN the Fact_Compiler compiles a `Fact` whose `value_kind` is `text`, THE Fact_Compiler SHALL
   emit a `TextFact` node carrying `path`, `key`, `value`, `snapshot_path`, `source`,
   `collected_at` and `formatted`, and THE Figure_Ledger SHALL record that node as a ledger entry
   keyed by its AST path.
3. THE AST_Model SHALL declare `TextFact` as a node carrying no field admitting an `int`, a
   `float`, a `Decimal` or a `DecimalString`, SHALL declare every `TextFact` position as
   admitting the `TextFact` node type alone, and SHALL declare `TextFact` as immutable after
   construction, so that the numeric-leaf invariant the templates spec's criterion 15.12 guards
   holds unchanged with `TextFact` added.
4. THE Text_Fact_Verifier SHALL assert, for every `TextFact` ledger entry, that the text of the cell
   its anchor resolves to — being that cell's runs concatenated in document order with no character
   inserted between runs — is equal character for character to that entry's `formatted` string,
   applying no whitespace normalization, no case folding, no trimming and no re-parsing of either
   string, and THE Anchor_Writer SHALL emit a `TextFact` as exactly one run in exactly one paragraph
   of that cell, so that the concatenation the check compares is the run the renderer wrote rather
   than a normalization either side chose.
5. THE Text_Fact_Verifier SHALL apply the exact-string check criterion 6.4 declares rather than
   passing a `TextFact` through the numeric masking stages requirement 28 of the templates spec
   declares, because `verify/masking.py`'s stage 2 masks a token matching
   `[A-Za-z_][\w.\-]*[0-9][\w.\-]*` — which masks `Standard_D4s_v3` — and a value such as
   `Succeeded` carries no digit and is therefore never extracted as a numeric token at all.
6. IF a resolved cell's concatenated text differs from a `TextFact` entry's `formatted` string,
   THEN THE Verifier SHALL record the blocking finding `text_fact_mismatch` naming the table
   identity, the row key, the column key, the fact key, the expected string verbatim and the
   observed string verbatim, and SHALL set the verification status to fail.
7. IF a `TextFact` entry's anchor resolves to no cell, THEN THE Verifier SHALL record the
   blocking finding `text_fact_anchor_missing` naming that entry's AST path and its anchor, and
   SHALL set the verification status to fail.
8. THE Fact_Compiler SHALL emit a `TextFact` only into a data-table cell, and IF a `TextFact`
   reaches the rendered document at a position that is not a data-table cell, THEN THE Verifier
   SHALL record the blocking finding `text_fact_unanchored` naming that entry's AST path and
   SHALL set the verification status to fail, because a `TextFact` outside a data table carries
   no anchor and therefore cannot be checked.
9. WHEN the Anchor_Writer emits a `TextFact` into a data-table cell, THE Anchor_Writer SHALL
   record that entry's anchor triple in the Figure_Ledger exactly once, in the same way it
   records a figure's anchor, so that the table-verification pass resolves both kinds through one
   mechanism.
10. THE Verifier SHALL exclude every `TextFact` entry's `formatted` string from the numeric
    masking stage the templates spec's criterion 28.2 declares, and SHALL count every `TextFact`
    entry in the bidirectional ledger completeness assertion that spec's criteria 29.1 and 29.2
    declare, so that a `TextFact` that did not render is `ledger_entry_unrendered` as any other
    unrendered entry is.
11. IF a `Fact` reaches the Fact_Compiler carrying no `source` or no `collected_at`, THEN THE
    Agent_Runtime SHALL report the terminal code `COMPILE_FAILED` and record the blocking finding
    `fact_source_missing` naming that fact's resource id and key, and SHALL write no report
    artifact.
12. THE Fact_Compiler SHALL take a `TextFact`'s `formatted` string from the Formatter, and THE
    Docx_Renderer, THE Html_Emitter and THE Report_Detail_View SHALL emit that string verbatim,
    composing no display string of their own, so that the single formatting path the templates
    spec's criterion 18.1 declares covers both kinds of ledger entry.
13. THE Formatter SHALL produce a `TextFact`'s `formatted` string as that fact's `value` character
    for character, applying no case folding, no truncation, no separator substitution and no
    resolution against the Message_Catalog, so that an observed value such as `Succeeded` reaches an
    Indonesian document as the string the API returned rather than as a translation of it, because a
    fact's value is collected data and not fixed copy.
14. THE Fact_Compiler SHALL populate a numeric fact's `Figure` with that fact's `key` in the `metric`
    position, that fact's `collected_at` in the `window` position, that fact's `source` among that
    figure's `derived_from` entries and no `estimator`, and SHALL populate no numeric fact's `Figure`
    with a `window` spanning the run's collection period, because a fact is true at an instant and a
    figure carrying the period as its window presents a moment's observation as an aggregate over the
    window.
15. THE Verifier SHALL record on the verification result the count of `TextFact` ledger entries as a
    field distinct from `figure_count`, and SHALL include every `TextFact` entry in neither
    `figure_count` nor the unused-figure warning count, so that the figure count the
    Verification_Panel presents stays the count of figures while the completeness assertion criterion
    6.10 declares still covers every `TextFact`.

#### Requirement 7: Every fact-producing response is archived and replayed

**User Story:** As an auditor, I want a fact to be reproducible from the archive, so that
determinism covers the whole snapshot rather than its metric half.

##### Acceptance Criteria

1. WHEN the Fact_Collector receives a response that produces a `Fact`, THE Archive_Writer SHALL
   write that response to `s3://<RPT_ARTIFACT_BUCKET>/<actor_id>/snapshots/<runId>/raw/` as a
   gzip-compressed JSON object during the same pass that folds it, as the foundation's criterion
   26.3 declares for a metric response, and SHALL complete that write before the Fact_Collector
   issues its next fact-producing request, so that the ordering is observable as the call order a
   recording object store double records rather than as an intention.
2. WHEN the Archive_Writer writes a fact-producing response, THE Archive_Writer SHALL include in
   that object the source that was queried, the request target, the resources that response covers,
   that response's body as received, that object's sequence ordinal and the receipt instant
   criterion 4.13 declares, so that the fact collection can be replayed from the archive alone.
3. WHEN the Replay_Verifier re-runs the aggregation, THE Replay_Verifier SHALL re-derive every
   `Fact` from the archived fact-producing responses, SHALL include those facts in the recomputed
   snapshot, and SHALL assert a byte-for-byte equal `snapshot_id`, making zero network requests.
4. IF a fact-producing response the archive sequence names is absent from the objects supplied to
   the Replay_Verifier, THEN THE Replay_Verifier SHALL record the advisory finding
   `archive_incomplete` naming that object's sequence ordinal and SHALL record that replay was not
   possible, as the foundation's criterion 26.12 and the templates spec's criterion 31.8 declare.
5. IF a fact-producing response is folded into the snapshot and no object is written for it, THEN
   THE Replay_Verifier SHALL recompute a snapshot digest differing from the stored `snapshot_id`
   and THE Verifier SHALL record the blocking finding `replay_hash_mismatch`, so that a fact
   silently omitted from the archive is a proven failure rather than an unnoticed omission.
6. THE Fact_Collector SHALL re-read no Azure data to build the archive, so that the fact archive
   costs no additional Azure request, as the foundation's criterion 26.5 declares.
7. WHEN the Replay_Verifier parses a numeric leaf from an archived fact-producing response, THE
   Replay_Verifier SHALL parse that leaf through the same reader it uses for a live response, and
   THAT reader SHALL accept an `int`, a `float`, a `Decimal` and a decimal **string**, because the
   Azure SDK deserializes a numeric as a `Decimal`, the archive serializes it to its exact digit
   string, and `json.loads` returns it as a `str` — a reader rejecting the string form classifies
   every archived value as absent and produces `REPLAY_MISMATCH` on every subscription whose facts
   carry a fractional value.
8. IF an archived fact value does not parse through the reader criterion 7.7 declares, THEN THE
   Replay_Verifier SHALL classify that value as absent and record a `fact_unavailable` gap naming
   that resource, that fact's key and the source recorded on that object, and SHALL raise no
   exception mid-fold.
9. THE Replay_Verifier SHALL import only modules that make no network request and SHALL receive
   every archived object from its caller, as the templates spec's criterion 31.2 declares, and THE
   Boundary_Guard SHALL fail IF any module in the Replay_Verifier's transitive first-party import
   closure imports an Azure SDK, `boto3`, `httpx` or the object store's cloud implementation.
10. THE Archive_Writer SHALL write, for every fact-producing response, every input the
    Snapshot_Builder derives that response's facts from, being each fact's `key`, `value`,
    `value_kind`, `unit`, `source`, `collected_at` and `formatted`, or the fields those are derived
    from, so that replay reproduces the canonical form criterion 4.5 hashes without re-querying Azure
    and without re-deriving a value the archive did not carry.
11. THE Replay_Verifier SHALL read no clock and SHALL derive every replayed `Fact`'s `collected_at`
    from the archived object alone, because a `collected_at` stamped at the replay instant enters the
    canonical form and produces `REPLAY_MISMATCH` on every run however correct the collection was.
12. IF an archived object supplied to the Replay_Verifier cannot be decompressed or cannot be parsed
    as JSON, THEN THE Replay_Verifier SHALL record the advisory finding `archive_incomplete` naming
    that object's sequence ordinal, SHALL record that replay was not possible, and SHALL raise no
    exception mid-fold, as criterion 7.4 declares for an object that is absent.

#### Requirement 8: A fact is presented with the instant it was observed

**User Story:** As a consultant, I want a backup status to carry its timestamp, so that a
document never implies a moment's observation described the whole month.

##### Acceptance Criteria

1. WHEN the Docx_Renderer emits a `Fact`, THE Docx_Renderer SHALL emit that fact's `collected_at`
   instant in a cell of the same table row as that fact's value, and SHALL emit no `Fact` whose
   `collected_at` instant is absent from that row.
2. WHEN the Docx_Renderer emits a `Fact`'s `collected_at`, THE Docx_Renderer SHALL express that
   instant in RFC 3339 form in the run's resolved timezone, carrying the resolved UTC offset and
   whole-second precision, so that a reader reads a local moment rather than a UTC instant the
   reader must convert and so that one instant produces one identical rendered string on every
   render.
3. THE Docx_Renderer SHALL emit, for every table of facts, the statement that the values are
   point-in-time observations at the instants shown rather than aggregates over the period, resolved
   from the Message_Catalog by string id, and THE Build_Pipeline SHALL fail IF a table of facts is
   emitted carrying no occurrence of that string id, so that the absence of copy characterising a
   fact as describing the collection period is asserted rather than reviewed.
4. WHEN the Html_Emitter emits a `Fact`, THE Html_Emitter SHALL emit that fact's `source` and
   `collected_at` as attributes of the emitted element, so that the provenance reveal the
   templates spec's criterion 38.2 declares presents a fact's source and instant as it presents
   a figure's `snapshot_path`.
5. WHEN a consultant places the pointer over a `Fact` in the in-app paper rendering, or WHEN a
   `Fact` in that rendering receives keyboard focus, THE Report_Detail_View SHALL reveal that
   fact's `snapshot_path`, its `source` and its `collected_at` within 200 milliseconds, through
   the same reveal and the same dismissal behaviour the templates spec's criterion 38.2 declares
   for a figure.
6. THE Report_Detail_View SHALL render every `Fact`'s `collected_at` and every numeric `Fact`
   in the monospace face with tabular figures, and SHALL animate no numeral, as the templates
   spec's criterion 37.5 declares.
7. WHEN the Docx_Renderer emits a `Fact`'s `collected_at` into a data-table cell, THE Fact_Compiler
   SHALL emit that instant as a `TextFact` carrying that fact's `snapshot_path` and its own anchor,
   so that the rendered instant is a ledger entry checked by the exact-string check criterion 6.4
   declares rather than a string of digits the numeric masking stages meet as an unmatched prose
   token.
8. WHERE one table carries two facts whose `collected_at` instants differ, THE Docx_Renderer SHALL
   emit each fact's own instant against that fact's row, and SHALL emit no single table-level instant
   standing for every fact in that table, because one caption over instants that differ states an
   observation none of the facts carries.
9. THE Html_Emitter and THE Report_Detail_View SHALL express a `Fact`'s `collected_at` as the
   identical string the Docx_Renderer emits for that instant, taking it from the Formatter and
   composing no display string of their own, so that the document, the paper rendering and the
   interface cannot disagree about when a fact was observed.

---

### Section C — Selection is a picker, not a text field

Three places accept free text today, and each turns a typo into an undiagnosable failure. The
common correction is structural: what a consultant chooses from is what the run can actually
collect, so a value that guarantees an empty block becomes unselectable rather than merely
invalid.

#### Requirement 9: A live inventory endpoint backs every picker

**User Story:** As a consultant, I want to choose from what is actually in the subscription, so
that a mistyped resource type is not something I can express.

##### Acceptance Criteria

1. THE Inventory_Endpoint SHALL return, for a connected subscription whose `user_id` equals the
   signed-in user's id and whose `status` is `active`, the distinct resource types, the distinct
   resource groups, the distinct tag keys and the distinct tag values present in that
   subscription's inventory across the whole subscription scope, SHALL order each dimension
   ascending in Unicode code-point order, SHALL return at most 2000 distinct values per dimension,
   and SHALL declare on each dimension whether that bound truncated it.
2. THE Inventory_Endpoint SHALL derive that response from exactly one Azure Resource Graph query
   per cache miss, SHALL key its cache on the connected subscription's row id alone, SHALL consult
   that cache only after the ownership check criterion 9.4 declares, SHALL treat a cached entry as
   a hit for 300 seconds after the instant its query completed and as a miss thereafter, and SHALL
   treat that entry as a miss once that subscription's row has been written after that instant, so
   that a rotated credential or a changed status lists the subscription again rather than serving a
   stale list.
3. THE Inventory_Endpoint SHALL declare `export const runtime = "nodejs"`, SHALL parse its path
   parameters and search parameters with a named zod schema at the boundary, and SHALL obtain every
   distinct value by invoking the Agent_Runtime with a deterministic command carrying the
   server-resolved Azure credentials in its `context` rather than with a prompt, so that the
   Web_App issues no Azure request of its own and holds no Azure access token, as the foundation's
   criterion 12.11 declares.
4. IF the requested subscription's `user_id` differs from the signed-in user's id, THEN THE
   Inventory_Endpoint SHALL resolve that request as not found, SHALL issue no Azure query, and
   SHALL disclose no field of that row.
5. THE Inventory_Endpoint SHALL exclude from its response every fully qualified resource
   identifier, every subscription identifier, every tenant identifier and every client
   identifier, returning only the distinct type, group, tag key and tag value strings the pickers
   present.
6. IF the Inventory_Endpoint resolves as unavailable under criterion 9.8, or answers the
   Scope_Picker with no dimension within the 30 seconds criterion 9.8 bounds it at, THEN THE
   Scope_Picker SHALL present the free-entry control criterion 10.5 declares together with a
   statement that the subscription's inventory could not be listed, SHALL retain every scope value
   the definition already carries, and SHALL block neither the step nor the save.
7. WHILE no connected subscription is selected, THE Scope_Picker SHALL present the free-entry
   control and SHALL state that selecting a subscription lists what is present in it, so that a
   template can be authored before a subscription is connected.
8. THE Inventory_Endpoint SHALL bound its own wait on the Agent_Runtime at 30 seconds, and IF the
   Agent_Runtime is unreachable, rejects the invocation, or returns no response within that bound,
   THEN THE Inventory_Endpoint SHALL resolve that request as unavailable naming which of those three
   occurred, SHALL write no entry to the cache criterion 9.2 declares, and SHALL issue no automatic
   retry, so that the bound is a property of the endpoint rather than of a caller.
9. IF the requested subscription's `status` is a value other than `active`, THEN THE
   Inventory_Endpoint SHALL resolve that request as unavailable naming that status, SHALL issue no
   Azure query, and SHALL disclose no field of that row other than that status, so that a suspended
   or expired-secret subscription drives the free-entry fallback criterion 9.6 declares rather than
   an empty option list a consultant would read as an empty subscription.

#### Requirement 10: The scope picker offers an affordance and stores a rule

**User Story:** As a consultant, I want picking from one customer's inventory to produce a
template that still runs for every other customer, so that convenience does not cost me
portability.

##### Acceptance Criteria

1. THE Scope_Picker SHALL present the resource types, resource groups and tag keys and values the
   Inventory_Endpoint returned as selectable options, replacing the comma-separated text controls
   `app/components/templates/step-scope.tsx` presents today through its `parseList` and
   `parseTagFilters` functions.
2. WHEN a consultant selects an option in the Scope_Picker, THE Template_Validator SHALL store
   that selection as the **rule** it represents, being a plain resource type name for a
   resource-type option, a plain resource group name for a resource-group option, the tag key
   paired with a zero-length value for an option that is a tag key alone, and that same tag key
   paired with the selected value for an option that is a tag value, and SHALL store no
   subscription identifier, no tenant identifier and no resource identifier alongside it, so that a
   tag key picked alone stores the rule "carries this tag" that a zero-length tag value expresses
   under the templates spec's criterion 3.1 rather than a value no inventory response carried.
3. THE Scope_Picker SHALL record nothing in the definition that identifies the subscription whose
   inventory the options were listed from, so that a definition composed against one
   subscription's inventory runs unedited against every other connected subscription, as the
   templates spec's criteria 1.2 and 1.6 declare.
4. IF a stored definition carries, in any scope field, a fully qualified Azure resource
   identifier, a subscription identifier or a tenant identifier, THEN THE Template_Validator SHALL
   reject that definition naming the offending field's path, as the templates spec's criterion 1.3
   declares, and the Scope_Picker's presence SHALL relax that rejection in no way.
5. THE Scope_Picker SHALL accept a value entered directly alongside the presented options, including
   a value absent from the selected subscription's inventory and a value a dimension's bound
   truncated under criterion 9.1, so that a resource type absent from the selected subscription's
   inventory today is selectable for a template intended to cover it later.
6. WHEN a consultant enters a value directly, THE Scope_Picker SHALL apply the same bounds and the
   same validation the templates spec's criterion 3.1 declares to that value as to a selected
   option, SHALL store for that value a rule character-identical to the rule criterion 10.2 stores
   for a selected option carrying that same string, SHALL store one entry rather than two where that
   value duplicates an entry the definition already carries, and SHALL present a validation error on
   that step rather than at save.
7. THE Scope_Picker SHALL state, for each of the three dimensions, that an empty dimension imposes
   no constraint and therefore collects every value of that dimension, as the current step already
   states, because a consultant reading an empty dimension as collecting nothing would build a
   template the consultant believed was narrow and receive a report over the whole subscription.
8. THE Scope_Picker SHALL offer no control that selects a named resource, and SHALL state that a
   template stores rules so that one template serves every connected subscription.
9. THE Scope_Picker SHALL make every option reachable and selectable from the keyboard, SHALL
   present a visible `--ring` focus indicator on the focused option, and SHALL announce a
   selection and a removal through an `aria-live` region set to `polite`.
10. WHERE the definition already carries a scope value absent from the Inventory_Endpoint's response
    for the selected subscription, THE Scope_Picker SHALL present that value as selected, SHALL
    retain it in the definition, and SHALL remove it only on an explicit removal by the consultant,
    so that opening a template against a second subscription's inventory edits no rule and one
    template runs unedited against every connected subscription.
11. THE Scope_Picker SHALL present resource types that differ only by letter case as exactly one
    option, SHALL present tag keys that differ only by letter case as exactly one option, and SHALL
    present tag values that differ by letter case as distinct options, because the templates spec's
    criterion 3.12 compares resource types and tag keys ignoring case and tag values honouring case,
    and two options one resolver cannot distinguish are one rule.

#### Requirement 11: The metric picker covers every catalog type

**User Story:** As a consultant, I want to select metrics for a SQL database as easily as for a
virtual machine, so that breadth in the catalog reaches the template.

##### Acceptance Criteria

1. THE Metric_Picker SHALL present the selectable metrics and derived statistics grouped by
   resource type, presenting one group per resource type the Metric_Catalog declares, extending
   the selection grid wizard step 4 presents today.
2. THE Metric_Picker SHALL source every presented option from the Metric_Catalog, obtained through
   the Agent_Runtime as criterion 9.3 declares for the Inventory_Endpoint, rather than from a list
   held in the Web_App, as the templates spec's criterion 5.6 declares.
3. THE Metric_Picker SHALL present, for each option, whether the Metric_Catalog declares its
   statistics exact or estimated and the fractional-digit count that catalog declares, and WHERE
   an option is a percentile statistic THE Metric_Picker SHALL present the estimator label that
   catalog declares for it.
4. WHEN the Template_Validator accepts a metric selection entry naming a percentile statistic, THE
   Template_Validator SHALL persist that entry carrying the estimator label and the fidelity tier
   the Metric_Catalog declares, as the templates spec's criterion 5.7 declares, and this
   requirement SHALL change that behaviour in no way.
5. THE Metric_Picker SHALL present the resource-type groups within each partition criterion 11.6
   declares in ascending Unicode code-point order of resource type name, and SHALL present the
   options within each group in ascending Unicode code-point order of option name, so that two
   renders of one catalog and one definition present one identical order.
6. WHERE the definition's scope declares one or more resource types, THE Metric_Picker SHALL
   present its groups as exactly two partitions in this order — first the groups for the resource
   types that scope declares, then the groups for every other resource type the Metric_Catalog
   declares — SHALL present every other type's group rather than hiding it, and SHALL order the
   groups inside each partition as criterion 11.5 declares, because a block scope override may
   narrow to a type the template default does not name; and WHERE that scope declares no resource
   type, THE Metric_Picker SHALL present exactly one partition carrying every group.
7. IF a definition's metric selection contains no metric and no derived statistic for a resource
   type the definition's default scope or any block `scope_override` can contain, THEN THE
   Template_Validator SHALL reject the save naming that resource type, as the templates spec's
   criterion 5.9 declares.
8. IF the Metric_Catalog cannot be retrieved, is rejected, or returns no response within 30 seconds,
   THEN THE Metric_Picker SHALL present a statement that the catalog could not be listed, SHALL
   present no option, SHALL retain the definition's stored metric selection unchanged, and SHALL
   refuse completion of that step, so that an unavailable catalog is not read as a catalog declaring
   no metric and no definition is saved carrying the empty selection the templates spec's criterion
   5.9 rejects.
9. WHERE the definition's stored metric selection names a metric or a derived statistic the current
   Metric_Catalog no longer declares for that resource type, THE Metric_Picker SHALL present that
   entry as selected and as no longer declared, SHALL retain that entry until the consultant removes
   it, and SHALL refuse completion of that step until it is removed, because a `catalog_version`
   raised under criterion 1.3 can make a stored entry undeclared without any edit and the save would
   be rejected minutes later instead.

#### Requirement 12: A block's metric-valued config is picked, not typed

**User Story:** As a consultant, I want a block to offer the metrics my template collects, so
that a typo does not become `COMPILE_FAILED` four minutes into a run.

##### Acceptance Criteria

1. THE Block_Config_Picker SHALL present, for a selected block's `metrics`, `columns`,
   `capacity_metric`, `usage_metric` and `order_by` config fields, being every metric-valued config
   field `app/lib/templates/blocks.ts` declares, a picker whose options criteria 12.2 and 12.9
   declare, replacing the raw-JSON text control
   `app/components/templates/block-inspector.tsx` presents today through its `fieldValue`
   and `parseFieldValue` functions.
2. THE Block_Config_Picker SHALL offer, for a `metrics`, `capacity_metric`, `usage_metric` or
   `order_by` field, as options exactly the metrics and derived statistics the definition's metric
   selection declares and no other value, because a block can display only a subset of what the run
   collects and an option outside that selection guarantees a block carrying no figure.
3. THE Block_Config_Picker SHALL close the mistyped-value hole **structurally**, by making an
   unselectable value unexpressible in every field criterion 12.1 names, rather than by validating a
   typed value, so that the inspector's present statement that "the validator decides whether the
   value is acceptable — this pane does not guess" ceases to describe those fields.
4. WHERE a block carries a `scope_override` declaring one or more resource types, THE
   Block_Config_Picker SHALL present the options for those resource types and SHALL present an
   option for another resource type only where that block's resolved scope can contain that type.
5. WHEN a consultant removes a metric from the definition's metric selection on step 4 while a
   block's config references that metric, THE Template_Wizard SHALL present that reference as
   invalid on the Block_Config_Picker for that block and on step 4, SHALL name the block, the field
   and the removed value in both places, SHALL retain that stored reference rather than removing it,
   and SHALL refuse completion until that reference is removed or the metric is reselected, as the
   templates spec's criterion 5.3 declares for the save.
6. THE Block_Config_Picker SHALL present the ordering direction of an `order_by` field as a
   control over the values the `order_by_direction` enum `app/lib/templates/blocks.ts` declares,
   being `descending` and `ascending` alone, and SHALL present the statistic of a metric-valued
   option as a control over the statistics the Metric_Catalog declares for that metric.
7. THE Block_Config_Picker SHALL make every option reachable and selectable from the keyboard,
   SHALL present a visible `--ring` focus indicator on the focused option, and SHALL announce a
   selection and a removal through an `aria-live` region set to `polite`.
8. WHERE a block config field is neither metric-valued nor enumerated, THE Block_Config_Picker
   SHALL present the control the inspector presents today, and SHALL retain the statement that the
   validator decides acceptability for those fields alone.
9. THE Block_Config_Picker SHALL offer, for a `columns` field, options drawn from exactly three
   distinctly presented groups — the metrics and derived statistics the definition's metric
   selection declares, the resource attributes the block config schema declares as permitted
   columns, and the fact keys the fact declaration declares for a resource type that block's
   resolved scope can contain — SHALL offer as a column option no metric and no derived statistic
   absent from that metric selection, SHALL offer as a column option no fact key no such resource
   type declares, and SHALL store a selected fact-key column as that fact key alone, so that a
   `resource_table` carries a resource name, a resource group, a SKU and a fact column beside its
   metric columns while the exclusion criterion 12.2 declares still binds the metric ones and the
   stored value stays a rule rather than a named resource.
10. WHEN the Template_Wizard opens a stored definition whose block config references a metric, a
    derived statistic or a fact key the options criteria 12.2 and 12.9 declare do not contain, THE
    Template_Wizard SHALL present that reference as invalid on the Block_Config_Picker naming the
    block, the field and that value, SHALL retain that stored value, SHALL refuse completion until
    that reference is removed or the referenced item is reselected, and THE Template_Validator SHALL
    reject a save carrying that reference unchanged, so that a stored reference is surfaced on load
    rather than only at the next save and no load path edits a definition on its own.

---

### Section D — The document

#### Requirement 13: Front matter is fixed, not composed

**User Story:** As a consultant, I want every report to open the same way, so that the document
looks like one my firm issues rather than one whose author chose where the cover went.

##### Acceptance Criteria

1. THE Template_Validator SHALL declare a `front_matter` section of the definition carrying the
   cover configuration, the document control configuration and the table of contents
   configuration, and SHALL treat that section as a required key of a definition whose
   `schema_version` is 2 or above.
2. THE Template_Validator SHALL declare `front_matter` as neither composable nor reorderable,
   SHALL accept no block inside it, SHALL accept no ordering field on it, and SHALL reject a
   definition placing a `cover` block, a document-control block or a table-of-contents block in
   the `blocks` list of a definition whose `schema_version` is 2 or above.
3. THE Block_Composer SHALL present a palette whose first entry is a content block, SHALL present
   no palette entry for the cover, the document control page or the table of contents, and SHALL
   present the front matter as a fixed section of the document the canvas shows above the content
   rather than as a reorderable item.
4. THE Front_Matter_Renderer SHALL emit the cover carrying the logo, the report title, the
   customer name, the period and the contact block, and SHALL emit that cover before every
   content block.
5. THE Front_Matter_Renderer SHALL emit the document control page carrying the document title, the
   customer, the document name, the document number, the approvers table, the revision history
   table, the distribution list and the confidentiality notice.
6. THE Front_Matter_Renderer SHALL emit the approvers table carrying one row per approval role,
   being author, quality control, reviewer and customer, each row carrying that role's company,
   name and signature cell; WHERE the definition's template configuration supplies a signature
   image for a role, THE Front_Matter_Renderer SHALL emit that image in that role's signature cell;
   and WHERE it supplies none, THE Front_Matter_Renderer SHALL emit an empty ruled signature box at
   the height the theme declares for that cell, emitting neither a blank cell nor that role's typed
   name in the signature cell, because a typed name in a signature position presents an approval
   nobody gave.
7. THE Template_Validator SHALL accept as **template** configuration, supplied once and stored on
   the definition, the signature images, the logo, the company details and the document-number
   pattern, and SHALL accept as **per-run** values the customer name, the period, the revision
   history row and the document number; THE Enqueue_Action SHALL record the customer name and the
   revision history row on the run at enqueue, THE Period_Resolver SHALL supply the period, and THE
   Front_Matter_Renderer SHALL derive the document number under criterion 13.8 rather than accepting
   it as an entered value.
8. WHEN the Front_Matter_Renderer emits a document number, THE Front_Matter_Renderer SHALL derive
   that number by applying the definition's document-number pattern to that run, SHALL emit an
   identical document number on the cover and on the document control page, and SHALL derive an
   identical number on every render of one run.
9. WHERE the definition's cover-page flag is false, THE Front_Matter_Renderer SHALL emit no cover
   content and no leading blank page, SHALL retain the cover configuration in the definition, and
   SHALL emit the document control page and the table of contents unchanged, so that disabling
   the cover does not disable the front matter.
10. THE Template_Validator SHALL raise `MAX_SUPPORTED_SCHEMA_VERSION` to 2 in both
    `app/lib/templates/definition.ts` and `agent/.../compile/definition.py`, which declare 1
    today, and THE Mirror_Guard SHALL fail IF the two declare different values.
11. THE Block_Compiler SHALL compile a stored definition whose `schema_version` is 1, including a
    definition carrying a `cover` block in its `blocks` list, and SHALL emit for such a definition
    the document that definition described, because a template version is immutable under the
    templates spec's criterion 9.3 and an archived report stays reproducible from its pinned
    version — `app/lib/templates/starters.ts` alone carries five `cover` blocks in stored version 1
    definitions.
12. WHEN a consultant saves a template whose stored definition declares `schema_version` 1, THE
    Template_Version_Store SHALL write a new version declaring `schema_version` 2 carrying the
    `front_matter` section, SHALL apply no write to the existing version row, and SHALL leave every
    report pinned to that earlier version rendering exactly as delivered.
13. IF a definition whose `schema_version` is 2 or above omits `front_matter`, carries a
    `front_matter` key the schema does not declare, or violates a bound of the cover, document
    control or table of contents configuration, THEN THE Template_Validator SHALL reject that
    definition naming every failing field path and SHALL persist no version row.
14. IF the Enqueue_Action receives a run request pinning a template version whose `schema_version`
    is 2 or above and carrying no customer name or no revision history row, THEN THE Enqueue_Action
    SHALL reject that request naming every absent value and SHALL insert no `report_runs` row.
15. IF a per-run value criterion 13.7 declares is absent when the Front_Matter_Renderer emits the
    front matter, THEN THE Agent_Runtime SHALL report the terminal code `RENDER_FAILED` naming that
    value, SHALL write no report artifact, and SHALL emit no substituted placeholder in that value's
    position, because a cover carrying invented copy is a document that cannot be signed.
16. THE Template_Validator SHALL constrain the document-number pattern to 1 through 120 characters
    composed of literal characters and declared placeholders naming the template identity, the run's
    resolved period start year, the run's resolved period start month and the run identifier, SHALL
    reject a pattern naming an undeclared placeholder, SHALL reject a pattern naming no placeholder
    whose value differs between two runs of one template and one resolved period, and WHERE two runs
    of one template and one resolved period resolve one identical document number, THE
    Front_Matter_Renderer SHALL emit that number on both and SHALL distinguish them by the revision
    history row, because a re-run of one period is a revision of one document rather than a second
    document.

#### Requirement 14: The table of contents carries real page numbers or is not shipped

**User Story:** As a consultant, I want the contents page to name the page each section is on, so
that I am not handing a customer a document whose first page says "Right-click to update".

##### Acceptance Criteria

1. THE Build_Pipeline SHALL carry a committed evaluation record naming each of exactly three
   candidate table-of-contents approaches — LibreOffice updating document indexes during
   `--convert-to pdf`; a two-pass render that measures the rendered document and then writes the
   entries; and a macro invoked at conversion — and recording for each whether it produced correct
   page numbers end to end, so that the adoption decision is an artifact rather than a recollection.
2. THE Build_Pipeline SHALL prove the adopted approach on every execution of the test suite,
   through a test that renders a document of at least 8 pages carrying at least 6 section headings
   distributed across at least 4 pages by the same `python-docx` emission and the same headless
   LibreOffice conversion a delivered report uses rather than a hand-built document, and that asserts
   each heading's named page equals its observed page in the produced `.pdf`, and SHALL fail IF that
   test is absent, is skipped or is marked as an expected failure.
3. THE Toc_Builder SHALL emit a table of contents only where the approach criterion 14.1 names has
   been proven under criterion 14.2, and IF no approach has been proven, THEN THE Toc_Builder SHALL
   emit no table of contents at all, because `python-docx` can insert a table-of-contents field and
   cannot compute page numbers, and an un-updated field renders as instructions to the reader.
4. THE Toc_Builder SHALL emit no table-of-contents entry whose page number it did not determine,
   and SHALL emit no placeholder page number, no zero and no instruction to the reader in a page
   number position.
5. WHEN the Toc_Builder emits a table of contents, THE Toc_Builder SHALL emit one entry per section
   heading of the compiled document, in document order, each entry naming that heading's text and
   the page that heading is on in the produced `.pdf`.
6. THE Toc_Verifier SHALL assert, for every table-of-contents entry in the produced `.pdf`, that
   the page the entry names is the page its heading appears on, and IF an entry names any other
   page, THEN THE Verifier SHALL record the blocking finding `toc_page_mismatch` naming that entry's
   heading text, the page named and the page observed, and SHALL set the verification status to
   fail.
7. THE Toc_Verifier SHALL derive the page a heading appears on from the produced `.pdf` whose
   SHA-256 digest equals the recorded `pdf_sha256`, as the templates spec's criterion 33.3 declares
   for the fidelity gate, and SHALL derive it from no independently rendered document.
8. THE Toc_Builder SHALL emit no page number and no page count into the in-app paper rendering, and
   THE Html_Emitter SHALL emit the table of contents as a list of headings carrying no page number,
   as the templates spec's criterion 14.3 declares, because the HTML emitter determines no
   pagination.
9. WHERE a numeric the document states occupies a table-of-contents entry's page-number position,
   THE Verifier SHALL admit that numeric through the static-text allowlist the templates spec's
   criterion 28.6 declares rather than treating it as an unmatched prose token, and THE Toc_Verifier
   SHALL be the check that proves that numeric, because the null-context render the allowlist is
   derived from carries no page number.
10. THE Toc_Builder SHALL read the adopted approach from a declared setting whose permitted values
    are exactly the three candidates criterion 14.1 names and the value naming no approach, THE
    Toc_Builder SHALL emit no table of contents WHERE that setting names no approach, and THE
    Build_Pipeline SHALL fail IF that setting names an approach for which the proof test criterion
    14.2 declares is absent or does not execute.
11. THE Toc_Builder SHALL emit one entry per heading block of the compiled document at heading levels
    1 through 3 and no entry for a heading at a deeper level, and THE Toc_Builder and THE
    Toc_Verifier SHALL take the page a heading is on to be the page carrying that heading's first
    rendered character, so that a heading whose text spans a page boundary resolves to exactly one
    page.
12. IF a numeric occupying a table-of-contents entry's page-number position is one for which the
    Toc_Verifier recorded no comparison against that entry's heading's observed page, THEN THE
    Verifier SHALL record `unmatched_prose_token` naming that numeric and its location, so that the
    admission criterion 14.9 declares covers a proven page number alone.

#### Requirement 15: Language is a template setting and no English string reaches an Indonesian document

**User Story:** As a consultant serving an Indonesian customer, I want the whole document in
Indonesian, so that I am not hand-editing headings after every run.

##### Acceptance Criteria

1. THE Template_Validator SHALL declare `identity.language` as a required field of a definition
   whose `schema_version` is 2 or above, constrained to exactly one of `en` and `id`, matched
   case-sensitively, and SHALL reject every other value including an absent value.
2. THE Message_Catalog SHALL declare every piece of fixed copy the document emits keyed by string
   id, covering the block labels, the table headers, the methodology appendix, the gap
   explanations, the verification record and the front matter, and SHALL declare a value for every
   declared string id in both `en` and `id`.
3. THE Docx_Renderer, THE Html_Emitter, THE Front_Matter_Renderer and THE Chart_Renderer SHALL
   emit every piece of fixed copy by resolving a string id against the Message_Catalog in the
   pinned definition's `identity.language`, and SHALL emit no literal user-facing copy of their
   own.
4. IF the Message_Catalog declares no value for a string id in the pinned definition's language,
   THEN THE Agent_Runtime SHALL report the terminal code `RENDER_FAILED` naming that string id and
   that language, and SHALL write no report artifact, because emitting the other language's value
   in its place is the failure this criterion exists to prevent.
5. THE Build_Pipeline SHALL fail IF the set of string ids the Message_Catalog declares in `en`
   differs from the set it declares in `id`, naming every string id present in one and absent
   from the other.
6. THE Build_Pipeline SHALL fail IF a module under `agent/.../render/` or a component under
   `app/components/reports/` supplies a string literal in a user-facing text position, being an
   argument to a text-emitting call or a rendered text child, other than a string id the
   Message_Catalog declares, excluding element names, attribute names, class names and `data-`
   attribute values, naming that module and that literal.
7. WHERE the pinned definition's `identity.language` is `id`, THE Agent_Runtime SHALL instruct the
   narrator in Indonesian and SHALL supply the narrator the context the templates spec's criterion
   19.1 permits and nothing further.
8. THE Verifier SHALL derive the static-text allowlist the templates spec's criterion 28.6 declares
   by rendering the pinned template version with a null context resolving every string id against
   the Message_Catalog in that pinned definition's declared language, and SHALL derive it in that
   language alone, so that Indonesian template chrome is allowed rather than surviving the masking
   stages as an unmatched token and English chrome is not admitted into an `id` document by the
   allowlist.
9. THE Report_Detail_View SHALL present a run's fixed copy in the pinned definition's language, and
   SHALL present the verification panel and the gap list in that language, so that the interface
   and the document agree.
10. THE Mirror_Guard SHALL fail IF the set of string ids the Message_Catalog declares in the agent
    half differs from the set it declares in the web half, naming every string id present in one half
    and absent from the other, so that the document and the interface resolve one identical id set.
11. WHEN the Agent_Runtime compiles and renders a run, THE Agent_Runtime SHALL resolve every string
    id in the `identity.language` that run's **pinned** template version declares, and THE
    Report_Detail_View SHALL present an archived run's fixed copy in that pinned language, applying
    no later edit of the template's language to an archived run.
12. WHERE a run's pinned template version declares `schema_version` 1 and therefore carries no
    `identity.language`, THE Agent_Runtime SHALL resolve every string id in `en`, SHALL report no
    error code for that absent field, and THE Template_Validator SHALL accept that stored definition
    unchanged, so that criterion 15.1 binds `schema_version` 2 and above alone and the version-1
    definitions criterion 13.11 compiles stay renderable.

#### Requirement 16: The declared number format is what is written and what is checked

**User Story:** As a consultant delivering in Indonesian, I want `0,58%` to be correct rather than
a verification failure, so that the separator my customer expects is the separator the gate
enforces.

##### Acceptance Criteria

1. THE Template_Validator SHALL declare `design.number_format` as carrying `decimal_places`,
   `group_thousands`, `decimal_separator` and `grouping_separator`, extending the two keys
   `app/lib/templates/definition.ts` permits today, which allows exactly `decimal_places` and
   `group_thousands`.
2. THE Template_Validator SHALL constrain each of `decimal_separator` and `grouping_separator` to
   exactly one character that is neither a decimal digit, nor a minus sign, nor a whitespace
   character, and SHALL reject a `number_format` whose `decimal_separator` equals its
   `grouping_separator`, naming the offending field, so that a reader cannot mistake a separator for
   part of a numeral.
3. WHERE a definition declares no `decimal_separator`, THE Template_Validator SHALL default that
   field to a comma where `identity.language` is `id` and to a period where it is `en`; WHERE a
   definition declares no `grouping_separator`, THE Template_Validator SHALL default that field to a
   period where `identity.language` is `id` and to a comma where it is `en`; WHERE a definition
   declares either field, THE Template_Validator SHALL persist that declared value unchanged and
   SHALL apply no language-derived default to it; and THE Template_Validator SHALL apply the
   constraint criterion 16.2 declares to the resolved pair after those defaults are applied.
4. WHEN the Formatter formats a figure, THE Formatter SHALL apply the `decimal_separator` and the
   `grouping_separator` the pinned definition declares, which the `NumberFormat` structure in
   `agent/.../compile/format.py` already accepts and defaults to a period and a comma, so that
   this requirement supplies the declared values rather than introducing the capability.
5. WHEN the Verifier checks the produced `.pdf`, THE Verifier SHALL bound a located occurrence with
   the two separators the pinned definition declares, which `agent/.../verify/pdf.py` already reads
   from the number format rather than assuming a period, and SHALL count an occurrence written with a
   separator other than the declared one as no located occurrence for that ledger entry, this
   criterion declaring how an occurrence is located and criterion 16.6 declaring the finding recorded
   where none is located.
6. IF the produced document writes a figure with a decimal separator differing from the
   `decimal_separator` the pinned definition declares, THEN THE Verifier SHALL record the blocking
   finding `pdf_figure_missing` for every ledger entry whose declared-format string has no located
   occurrence, and SHALL set the verification status to fail.
7. THE Verifier SHALL treat a comma decimal separator as correct WHERE the pinned definition
   declares a comma, and SHALL treat a period decimal separator as incorrect in that same case, so
   that the check is a comparison against the declaration rather than an assumption about which
   character a decimal separator is.
8. THE Chart_Renderer and THE Report_Detail_View SHALL emit every numeral from a ledger entry's
   `formatted` string verbatim, applying no locale-dependent formatting of their own, so that one
   declared format reaches the document, the chart and the interface.
9. WHEN the Template_Wizard presents the design step, THE Style_Picker SHALL present the declared
   separators as controls and SHALL present a sample figure formatted in the declared format, so
   that a consultant sees `462,81 GB` before a run rather than after one.
10. WHERE a run's pinned template version declares `schema_version` 1 and its `number_format`
    therefore declares exactly `decimal_places` and `group_thousands`, being the `allowedKeys`
    `app/lib/templates/definition.ts` permits today, THE Formatter SHALL apply the separators
    criterion 16.3's defaults resolve for that definition's language, and THE Template_Validator SHALL
    accept that stored definition unchanged, so that raising the schema version rewrites no stored
    version row.
11. WHERE `group_thousands` is true, THE Formatter SHALL insert the declared `grouping_separator`
    between each group of three digits of a figure's integer part counted rightward from the decimal
    separator, SHALL insert none where that integer part carries three digits or fewer, and SHALL
    insert none in the fractional part; and WHERE `group_thousands` is false, THE Formatter SHALL
    insert no grouping separator.
12. WHEN the Verifier re-verifies a stored report, THE Verifier SHALL read the `number_format` from
    that run's pinned template version rather than from the template's current definition, so that a
    later edit of a separator leaves an archived report verifying exactly as delivered.

#### Requirement 17: Charts look like a client deliverable

**User Story:** As a consultant, I want a chart I can put in front of a customer, so that the
document does not look like a debugging output.

##### Acceptance Criteria

1. WHEN the Chart_Renderer emits a chart, THE Chart_Renderer SHALL emit an axis title and the unit
   for each plotted axis, resolved from the Message_Catalog and the Metric_Catalog, and SHALL emit
   no axis carrying neither a title nor a unit.
2. THE Chart_Renderer SHALL emit gridlines drawn from the `--border` and `--muted-foreground`
   tokens, and SHALL emit no gridline that competes with a plotted mark for prominence.
3. WHERE a chart carries more than one plotted series, THE Chart_Renderer SHALL emit a legend
   naming every plotted series, and SHALL emit that legend in addition to the direct label every
   series already carries under the templates spec's criterion 22.10 rather than in place of it.
4. THE Chart_Renderer SHALL emit a direct value label on every plotted point of a line series and
   on every bar, column and heatmap cell WHERE that series carries 24 or fewer plotted points;
   WHERE a series carries more than 24 plotted points, THE Chart_Renderer SHALL emit a direct value
   label on the first point, the last point, the point carrying the series maximum and the point
   carrying the series minimum alone, selecting the earlier point by period start where two points
   carry one equal extreme value; THE Chart_Renderer SHALL take every emitted label from that point's
   ledger entry `formatted` string verbatim; and THE Chart_Renderer SHALL record every plotted point
   in that chart's companion data table under criterion 17.7 whether or not that point carries a
   direct label, so that thinning removes a label rather than a figure.
5. THE Chart_Renderer SHALL emit a chart title and the period the chart covers, expressing that
   period as the run's resolved local start and end dates with the resolved UTC offset shown.
6. THE Chart_Renderer SHALL emit every chart title in the theme's heading face and every numeral in
   the theme's monospace face with tabular figures, and SHALL emit the accent colour the pinned
   definition's design settings declare.
7. THE Chart_Renderer SHALL emit exactly one companion data table per chart carrying every plotted
   point as a ledger entry, and SHALL record that chart's `chart_data_hash` on the chart node and
   in the sidecar accompanying the embedded image, as the templates spec's criteria 22.1 and 22.3
   declare, so that appearance changes and verification does not.
8. THE Chart_Renderer SHALL select each chart's palette from that chart node's declared `encoding`
   rather than from its series count, SHALL assign a categorical colour by stable key, and SHALL
   apply the `--destructive` token to no series, no delta, no gridline and no band, as the templates
   spec's criteria 22.7, 22.8 and 22.12 declare.
9. THE Chart_Renderer SHALL emit byte-identical image content for two renders of one chart node
   against one style preset, as the templates spec's criterion 22.14 declares, so that the
   appearance changes this requirement makes remain deterministic.
10. THE Chart_Renderer SHALL emit every plotted mark at a contrast ratio of at least 3:1 and every
    inline value label at a contrast ratio of at least 4.5:1 against the surface it is drawn on, each
    ratio computed by the WCAG 2.1 relative-luminance formula against both the `--background` and the
    `--card` token in both the light and the dark theme, and THE Build_Pipeline SHALL fail naming the
    series, the surface and the theme IF a computed ratio falls below its floor.
11. IF the Message_Catalog declares no value for an axis title's string id in the pinned definition's
    language, or the Metric_Catalog declares no unit for a plotted axis's metric, THEN THE
    Agent_Runtime SHALL report the terminal code `RENDER_FAILED` naming that axis, that string id and
    that metric, and SHALL write no report artifact, because an untitled unitless axis is the
    presentation criterion 17.1 exists to prevent.
12. THE Chart_Renderer SHALL take the period string criterion 17.5 declares from the Formatter, and
    THE Docx_Renderer, THE Html_Emitter and THE Report_Detail_View SHALL present that identical string
    for one run, composing no period string of their own, so that a chart and the document surrounding
    it cannot disagree about the period plotted.

---

### Section E — Historical trend

#### Requirement 18: A historical trend is resolved from prior verified runs

**User Story:** As a consultant, I want month-over-month movement in the report, so that a
customer sees a direction rather than a single month's snapshot.

##### Acceptance Criteria

1. THE Template_Validator SHALL declare `historical_trend` as a block type, extending the sixteen
   block types the templates spec's criterion 6.1 declares to seventeen, and THE Mirror_Guard SHALL
   fail IF the block-type set declared in `app/lib/templates/blocks.ts` differs from the set declared
   in `agent/.../compile/definition.py`.
2. THE Template_Validator SHALL declare a `historical_trend` block's config as carrying a metric, a
   statistic and a lookback expressed as a count of periods, and SHALL constrain that lookback to an
   integer from 2 to 24 inclusive.
3. THE Template_Validator SHALL reject a `historical_trend` config naming a metric or a statistic
   absent from the definition's metric selection, as criterion 12.2 declares for every
   metric-valued config field.
4. WHEN the Historical_Resolver resolves a `historical_trend` block, THE Historical_Resolver SHALL
   select prior runs of the same `report_templates.id` as the run being compiled, being any pinned
   template version of that template row rather than the identical `template_version_id`, and of
   the same connected subscription id, SHALL treat as prior only a run whose resolved local period
   end is strictly earlier than the resolved local period start of the run being compiled, and
   SHALL order the eligible runs by resolved local period end descending, up to the lookback count
   the block declares; WHERE two eligible runs carry equal resolved local period ends, THE
   Historical_Resolver SHALL order first the run whose latest passing verification result carries
   the greater recorded creation instant and, where those instants are equal, the run whose id
   compares greater in Unicode code-point order, so that a re-run of one period is resolved to the
   later-verified run deterministically. Requiring the identical `template_version_id` is the
   rejected reading: a template version is immutable under the templates spec's criterion 9.3 and
   editing a template writes a new version, so that reading empties every trend on the next edit;
   the cost of the reading adopted is that two points may have been compiled from different
   definitions, which criteria 18.13 and 18.14 exclude wherever that difference reaches a plotted
   value.
5. THE Historical_Resolver SHALL select only a run whose `status` is `completed`, and SHALL select no
   run whose `status` is any other value.
6. THE Historical_Resolver SHALL select only a run for which the Verification_Store holds a
   verification result whose `status` is `pass`, being that run's latest verification result, which
   is the result carrying the greatest recorded creation instant and, where two results carry equal
   instants, the result whose id compares greater in Unicode code-point order, and SHALL select no
   run whose latest verification result's status is `fail` or absent, because a failed run's numbers
   were never proven and may not appear in a document claiming to be.
7. THE Historical_Resolver SHALL select no two runs whose resolved local periods overlap, two
   periods overlapping where the later period's start is at or before the earlier period's end, and
   WHERE two candidate runs' periods overlap THE Historical_Resolver SHALL retain the run whose
   resolved local period end is later; WHERE those two period ends are equal, THE
   Historical_Resolver SHALL retain the run whose latest passing verification result carries the
   greater recorded creation instant and, where those instants are equal, the run whose id compares
   greater in Unicode code-point order, and SHALL exclude the other, so that two runs covering one
   identical period resolve to exactly one retained run on every call.
8. WHEN the Historical_Resolver has selected the prior runs, THE Block_Compiler SHALL read each
   selected run's stored snapshot and SHALL emit exactly one plotted point per selected period,
   ordered by period start ascending.
9. THE Block_Compiler SHALL emit each historical point as a `Figure` whose value is read from that
   run's stored snapshot, and THE Figure_Ledger SHALL record on that point's ledger entry the source
   run id and that snapshot's recorded `snapshot_sha256`, as two fields distinct from the ledger
   entry's own `snapshot_path`, so that a historical point's provenance names the run it came from
   rather than the run being compiled and so that a point sourced from another run is expressible,
   and therefore injectable by the negative test criterion 24.12 declares.
10. THE Block_Compiler SHALL make no Azure request while compiling a `historical_trend` block, and
    SHALL derive every plotted value from a stored snapshot alone.
11. IF a historical point is sourced from a run whose latest verification result's status is not
    `pass`, THEN THE Verifier SHALL record the blocking finding `historical_point_unverified`
    naming that run id and that point's AST path, and SHALL set the verification status to fail.
12. IF two historical points are sourced from runs whose resolved local periods overlap, THEN THE
    Verifier SHALL record the blocking finding `historical_point_overlapping` naming both run ids
    and both periods, and SHALL set the verification status to fail.
13. IF a prior run the Historical_Resolver selected carries, in its stored snapshot, no value for the
    metric and statistic the `historical_trend` block declares, THEN THE Historical_Resolver SHALL
    exclude that run from the plotted points carrying the typed exclusion reason criterion 18.15
    declares, THE Block_Compiler SHALL emit no plotted point for that period, SHALL emit no zero, no
    empty value and no substituted statistic for it, and SHALL count that period among the absent
    periods the statement criterion 19.2 declares, because the metric selection may have differed in
    the version that run pinned and plotting a period the prior snapshot has no value for would
    state a measurement that snapshot does not carry.
14. IF a prior run the Historical_Resolver selected carries, for the metric and statistic the
    `historical_trend` block declares, a `fidelity_tier` differing from the `fidelity_tier` the run
    being compiled carries for that metric and statistic, THEN THE Historical_Resolver SHALL exclude
    that run from the plotted points carrying the typed exclusion reason criterion 18.15 declares,
    THE Block_Compiler SHALL emit no plotted point for that period and SHALL count that period among
    the absent periods the statement criterion 19.2 declares, so that a trend plots one comparable
    series rather than presenting a movement between an exact statistic and an estimated one as a
    measured change.
15. THE Historical_Resolver SHALL record, for every candidate prior run it excluded, that run id and
    exactly one typed exclusion reason drawn from the declared set `status_not_completed`,
    `verification_not_passed`, `period_overlapping`, `metric_absent_in_snapshot`,
    `fidelity_tier_differs` and `beyond_lookback`, and SHALL record no exclusion carrying an empty
    reason, so that the reason the statement criterion 19.2 declares is resolved from a declared
    value rather than composed by the renderer.

#### Requirement 19: Fewer prior runs than requested is normal and is labelled

**User Story:** As a consultant running a first report, I want the trend block to say it has one
period rather than inventing five, so that a document never implies data that does not exist.

##### Acceptance Criteria

1. WHERE fewer completed and verification-passed prior runs exist than the lookback the block
   declares, THE Block_Compiler SHALL emit exactly one plotted point per available period and SHALL
   emit that block rather than omitting it.
2. WHEN the Block_Compiler emits a `historical_trend` block carrying fewer plotted points than the
   lookback the block declares, THE Block_Compiler SHALL emit exactly one explicit statement
   resolved from the Message_Catalog by string id in the pinned definition's `identity.language`, as
   criterion 15.3 declares, naming the count of periods plotted, the count of periods requested and
   the typed exclusion reasons criterion 18.15 recorded for the absent periods.
3. THE Block_Compiler SHALL interpolate no historical point, SHALL carry no value forward from one
   period into another, and SHALL emit no plotted point for a period no selected run covers.
4. THE Chart_Renderer SHALL emit the axis of a `historical_trend` chart carrying exactly the periods
   plotted, and SHALL neither shorten nor extend that axis to make the chart appear full.
5. WHERE zero completed and verification-passed prior runs exist, THE Block_Compiler SHALL emit that
   block carrying zero figures and exactly one explicit statement, resolved from the Message_Catalog
   by string id in the pinned definition's `identity.language`, that no prior period is available,
   and SHALL emit that block rather than omitting it, because a block that vanished is
   indistinguishable from a block that was never configured.
6. THE Block_Compiler SHALL report no error code for a `historical_trend` block carrying fewer points
   than requested and SHALL record no `collection_log` gap for it, because an absent prior run is an
   ordinary compile outcome rather than a collection failure.
7. WHEN the Block_Compiler emits a `historical_trend` block, THE Block_Compiler SHALL emit exactly
   one statement, resolved from the Message_Catalog by string id in the pinned definition's
   `identity.language`, that each historical point was verified against its own run's verification
   record and that the replay of this run re-verified this run's snapshot alone, so that the document
   does not imply the historical values were re-checked here.
8. THE Replay_Verifier SHALL re-verify the snapshot of the run being compiled alone, and SHALL read
   no prior run's snapshot and no prior run's archive, as the templates spec's criterion 31.1
   declares.
9. THE Verifier SHALL record, on the verification result, the run id and the snapshot hash of every
   historical point the document carries, so that a reader can trace each plotted period to the
   verification that proved it.
10. WHERE the statement criterion 19.2 declares names a count of periods plotted or a count of
    periods requested, THE Verifier SHALL treat that numeric through the static-text allowlist the
    templates spec's criterion 28.6 declares rather than as an unmatched prose token, THE
    Block_Compiler SHALL emit that plotted count equal to the count of plotted points that block
    emitted and that requested count equal to the lookback the block declares, and IF either emitted
    count differs from the value it is declared equal to, THEN THE Agent_Runtime SHALL report the
    terminal code `COMPILE_FAILED` naming that block's AST path and SHALL write no report artifact,
    so that the stated counts are checkable against the block rather than trusted.
11. WHEN the Chart_Renderer emits a `historical_trend` chart, THE Chart_Renderer SHALL emit exactly
    one axis category per plotted point, each labelled with that point's resolved local period, and
    SHALL emit no axis category for a period carrying no plotted point, including a period excluded
    under criterion 18.13 or 18.14 and a period beyond the available prior runs, so that the axis
    category count equals the plotted point count and the chart is neither padded toward the declared
    lookback nor shortened below what was plotted.

---

### Section F — The report page

#### Requirement 20: The gap list groups losslessly

**User Story:** As a consultant reading a run that recorded 512 gaps, I want to see what happened
rather than the same fact 512 times, so that the list tells me something.

##### Acceptance Criteria

1. THE Gap_Grouper SHALL group a run's `collection_log` first by `gap_type` and, within each type,
   by the pair `(resource_id, metric)` WHERE the entry carries a metric and by `resource_id` paired
   with one declared no-metric key WHERE the entry carries no metric or an empty metric, taking a
   fact gap's fact key as occupying the metric position, replacing the presentation
   `app/components/reports/gap-list.tsx` renders today, which emits one list item per entry and
   therefore emitted 512 paragraphs for a run whose entries largely named the same resource, because
   `RunGap`'s `metric` is a string or `null` and `record_gap` in `agent/.../collect/log.py` accepts
   `metric` as `str | None`, so a `region_unreachable`, a `permission_denied` and every fact gap
   requirement 5 declares carries no metric and a pair keyed on one is undefined for them.
2. THE Gap_Grouper SHALL record on each `gap_type` group the count of entries that group contains,
   and SHALL record on each `(resource_id, metric)` group within it the count of entries that
   inner group contains.
3. THE Gap_Grouper SHALL produce a grouping whose per-group entry counts sum, across every group, to
   exactly the count of entries supplied to it, SHALL count an entry carrying a `gap_type`, a
   `resource_id`, a metric and a message identical to another entry's as a separate entry rather
   than as one, and SHALL discard no supplied entry, so that grouping loses no row and the displayed
   total equals the recorded total.
4. WHERE every entry of a `(resource_id, metric)` group carries an interval start and those starts
   are contiguous, being that each start after the earliest equals the preceding start advanced by
   exactly one step of the grain the run resolved, restricted to `PT1H` or `PT15M`, rather than being
   merely close in wall-clock time, THE Gap_Grouper SHALL record the time range from the earliest
   interval start to the latest interval start advanced by one grain step, expressed in the run's
   timezone with the resolved UTC offset shown; WHERE such a group carries exactly one interval
   start, THE Gap_Grouper SHALL record the range spanning that one interval alone; and WHERE those
   starts are not contiguous, or WHERE any entry of that group carries no interval start, THE
   Gap_Grouper SHALL record no time range rather than a range implying contiguity.
5. THE Report_Detail_View SHALL present one representative message per group rather than one message
   per entry, and THE Gap_Grouper SHALL select as that representative the entry sorting first within
   the group by `resource_id`, then by metric taking the no-metric key criterion 20.1 declares as
   sorting before every metric, then by interval start taking an absent start as sorting before every
   start, then by message, each compared ascending in Unicode code-point order, so that two renders
   of one collection log present one identical representative.
6. WHEN a consultant activates a group, THE Report_Detail_View SHALL present every entry that group
   contains, and SHALL make that expansion reachable from the keyboard with a visible `--ring` focus
   indicator and an accessible name naming the group and its entry count.
7. THE Report_Detail_View SHALL present every gap group in mist neutral tokens and SHALL apply the
   `--destructive` token to no gap group, as the templates spec's criterion 37.3 declares, because a
   gap is neutral information rather than an error state.
8. WHERE a run's `collection_log` carries at least one `metric_not_selected` entry, THE
   Report_Detail_View SHALL present that group carrying a statement that the cause is that the
   template selected no metric for those resources' types and that the fix is a template edit, and
   SHALL present a link to the template's metric selection step for the pinned template.
9. WHERE the entries of the `metric_not_selected` group carry a resource type, THE Report_Detail_View
   SHALL present the distinct resource types those entries name and the count of distinct resources
   of each, ordered ascending in Unicode code-point order of resource type, rather than a list of
   resource identifiers; WHERE those entries carry no resource type, THE Report_Detail_View SHALL
   present the count of distinct resources affected together with a statement that the resource types
   were not recorded; and THE Report_Detail_View SHALL present in both cases the statement and the
   link criterion 20.8 declares, so that a consultant reads that the fix is a template edit whichever
   branch applies.
10. WHERE a run's `collection_log` carries zero entries, THE Report_Detail_View SHALL present an
    explicit statement that the collection recorded no gap and SHALL omit no gap section, as the
    templates spec's criterion 37.10 declares.
11. THE Gap_Grouper SHALL contain no input or output operation and SHALL derive its grouping from the
    supplied entries alone, so that the grouping is testable as a pure function.
12. WHERE an entry supplied to the Gap_Grouper carries no `resource_id` or an empty `resource_id`, THE
    Gap_Grouper SHALL place that entry in one declared unattributed group within its `gap_type` and
    SHALL count it there, so that the sum criterion 20.3 declares equals the supplied entry count for
    every input and no entry is dropped for want of a resource to attribute it to.
13. WHERE a `gap_type` group's type is one for which the Report_Detail_View carries no explanatory
    copy, THE Report_Detail_View SHALL present that group carrying its `gap_type` value, its entry
    count and its representative message, and SHALL present that group rather than omitting it,
    because `app/components/reports/gap-list.tsx` carries copy for eight of the twenty declared types
    today and the four gap types this spec adds would otherwise present as a bare identifier alone.
14. WHEN the Report_Detail_View presents the entries of an expanded group, THE Report_Detail_View
    SHALL present at most 200 entries, and WHERE that group contains more THE Report_Detail_View SHALL
    present an explicit statement naming the count presented and the count the group contains, so that
    expanding the 512-entry group a live run produced presents a bounded list rather than the
    presentation criterion 20.1 replaced.

#### Requirement 21: The verification panel fits its box

**User Story:** As a consultant, I want the panel readable in the column it is in, so that a seed
does not run out of the layout.

##### Acceptance Criteria

1. THE Verification_Panel SHALL present the drift sample seed truncated with a copy control that
   yields the complete recorded seed, replacing the presentation
   `app/components/reports/verification-panel.tsx` renders today, which emits that 64-character
   value in a bare monospace span while every hash beside it uses the truncating copy control.
2. THE Verification_Panel SHALL present every hash and every seed it displays through the same
   truncating copy control, and SHALL present every such value whose length exceeds that control's
   declared truncation length in its truncated form alone.
3. WHEN the Verification_Panel presents a truncated hash or seed, THE Verification_Panel SHALL
   present that value's leading characters up to the truncation length the copy control declares,
   being the 12 characters `app/components/reports/copy-digest.tsx` declares as `TRUNCATE_TO` today,
   SHALL take that length from that single declared constant rather than declaring a second one, and
   THE copy control SHALL place the complete untruncated recorded string on the clipboard.
4. THE Verification_Panel SHALL present every hash, every seed and every finding locating field
   either truncated through the copy control or with line breaking permitted at any character, and
   SHALL present no such value as an unbroken run of more than 12 characters that line breaking
   cannot divide, so that its container requires no horizontal scrolling at a viewport width of 360
   CSS pixels.
5. WHEN the app test suite runs, THE Web_App SHALL include a test rendering the Verification_Panel
   carrying a 64-character seed and three 64-character digests and asserting that each of those four
   values presents at most 12 characters of text and that its complete recorded string is reachable
   through its copy control's accessible name, and SHALL assert no element width, because the app
   test environment performs no layout and reports every element width as zero — a width assertion
   there reports a pass for a panel presenting all 64 characters.
6. THE Verification_Panel SHALL present every finding's locating fields the templates spec's
   criterion 39.3 declares, and SHALL truncate no locating field to the point that the finding ceases
   to identify where the disagreement is.
7. THE Verification_Panel SHALL derive every value it presents from the stored `report_verifications`
   row rather than from a received event alone, as the templates spec's criterion 39.9 declares, and
   this requirement SHALL change that in no way.
8. WHERE a hash or a seed the Verification_Panel presents carries 12 characters or fewer, THE
   Verification_Panel SHALL present that value complete, and THE copy control SHALL place that same
   complete string on the clipboard.
9. WHERE the stored `report_verifications` row records no drift sample, or records a drift sample
   carrying no seed, THE Verification_Panel SHALL present an explicit statement that no drift sample
   seed was recorded, and SHALL present neither an empty value nor a zero in that position.
10. IF the clipboard write a copy control attempts is refused, THEN THE Verification_Panel SHALL keep
    the complete recorded string reachable through that control's accessible name, SHALL present no
    error state, and SHALL apply the `--destructive` token to no part of the panel, as
    `app/components/reports/copy-digest.tsx` already behaves, because a refused clipboard permission
    leaves a perfectly readable digest on screen.

#### Requirement 22: The paper rendering is styled or it stops claiming to be a page

**User Story:** As a consultant, I want the reading view to look enough like the page that hovering
a figure is useful, so that the provenance reveal is worth using.

##### Acceptance Criteria

1. THE Paper_Stylesheet SHALL declare a rule for every class name the Html_Emitter emits, being
   `rpt-document`, `rpt-block`, `rpt-break`, `rpt-table`, `rpt-row`, `rpt-notice`, `rpt-chart`,
   `rpt-series-set`, `rpt-series`, `rpt-point`, `rpt-figure`, `rpt-column` and `rpt-layout-row` as
   `agent/.../render/html.py` emits them today, appended to `app/app/globals.css`, which contains
   **zero** rules matching `rpt-` today.
2. THE Paper_Stylesheet SHALL declare, for the rows and cells of `rpt-table`, a rule giving every cell
   a hairline boundary drawn from the `--border` token on each side adjacent to another cell, so that
   a table emitted with its real `<table>`, `<tr>` and `<td>` markup — which the Html_Emitter already
   emits, carrying `data-column-key` and `data-row-key` — reads as a table rather than as running
   text.
3. WHEN the Html_Emitter emits consecutive plotted points of a chart series, THE Html_Emitter SHALL
   emit at least one separating character between consecutive `rpt-point` elements and SHALL emit
   that separator outside every `rpt-figure` element, replacing the concatenation it performs today
   which joins consecutive `rpt-point` elements with no separating character and therefore renders
   three consecutive percentages as `0.20%0.22%0.20%`, so that the separation is visible while every
   figure's own text stays that ledger entry's `formatted` string character for character.
4. THE Paper_Stylesheet SHALL render consecutive `rpt-figure` elements with visible separation
   wherever those elements are adjacent siblings, and SHALL insert no separation between a figure and
   the prose characters surrounding it inside one paragraph, because the Html_Emitter joins a
   paragraph's inline nodes with no inserted character deliberately and a separator there would
   alter the sentence.
5. THE Paper_Stylesheet SHALL render every figure and every numeric fact in the monospace face with
   tabular figures, and SHALL animate no numeral, as the templates spec's criterion 24.3 declares.
6. THE Report_Detail_View SHALL present the permanent preview label the templates spec's criterion
   14.2 declares, SHALL present no page number and no page count, and SHALL present the presigned
   `.pdf` as the delivered result.
7. THE Html_Emitter SHALL draw every class name it emits from one declared collection in
   `agent/.../render/html.py`, THE Build_Pipeline SHALL fail naming that class name IF a class name in
   that collection has no rule in `app/app/globals.css`, and THE Build_Pipeline SHALL fail naming that
   class name IF a class attribute the Html_Emitter emits carries a name absent from that collection,
   so that the check is one declared list compared against one stylesheet rather than a search of
   Python source from another package.
8. WHERE the test criterion 22.9 declares passes, THE Report_Detail_View SHALL present the styled
   rendering as an approximation of the delivered page together with the permanent preview label the
   templates spec's criterion 14.2 declares; and WHERE that test does not pass, is absent or is
   skipped, THE Report_Detail_View SHALL present that rendering as a **text extract**, SHALL present
   no statement that it approximates the delivered page, and SHALL present the presigned `.pdf` as the
   delivered result, so that which of the two it claims to be is decided by an executing assertion
   rather than by judgement.
9. WHEN the app test suite runs, THE Web_App SHALL include a test rendering a paper rendering carrying
   a data table and a chart series of three points, asserting that each of that table's cells presents
   in its own `<td>` element carrying its own `data-column-key`, and asserting that those three
   consecutive figures present as three separated text values rather than as one concatenated string
   such as `0.20%0.22%0.20%`, and SHALL assert no element width, because the app test environment
   performs no layout.
10. IF the test criterion 22.9 declares is absent, is skipped or is marked as an expected failure,
    THEN THE Build_Pipeline SHALL fail naming that test, so that the text-extract fallback criterion
    22.8 declares is entered on a proven condition rather than on a test nobody ran.
11. THE Paper_Stylesheet and the separator criterion 22.3 declares SHALL leave every ledger entry's
    `formatted` string and every chart's `chart_data_hash` unchanged, and THE Report_Detail_View SHALL
    present every figure's text as that entry's `formatted` string character for character, so that
    styling the in-app rendering adds no verification surface.
12. WHERE the Html_Emitter emits a `rpt-notice` row, THE Paper_Stylesheet SHALL render that row in
    mist neutral tokens, and THE Paper_Stylesheet SHALL apply the `--destructive` token in no `rpt-`
    rule, as the templates spec's criterion 37.3 declares, because an explicit "No resources matched
    this scope" row is neutral information rather than an error state.

---

### Section G — The template name

#### Requirement 23: Saving the identity step names the template

**User Story:** As a consultant with six templates, I want the list to show their names, so that
they are not all called `Untitled template`.

##### Acceptance Criteria

1. WHEN a consultant saves the identity step, THE Template_Wizard SHALL write the submitted value to
   the draft definition's `identity.name` and SHALL then invoke the rename operation criterion 23.2
   declares against `report_templates.name`, being two separate writes applied in that order rather
   than one atomic write, and SHALL report that step as saved only WHERE both writes succeeded,
   correcting the present behaviour of `app/components/templates/step-identity.tsx`, which writes
   `definition.identity.name` alone and whose field is labelled `Template name` and described as
   "What this template is called in your list" while the list reads `report_templates.name`.
2. WHEN a consultant saves the identity step and the submitted value differs character for character
   from the stored `report_templates.name`, THE Template_Wizard SHALL invoke the rename operation on
   the Template_Store, and WHERE the submitted value equals that stored name character for character
   THE Template_Wizard SHALL invoke no rename and SHALL report that step as saved, because no code path
   in the wizard invokes that operation today and every template therefore retains the name it was
   created with.
3. WHEN the Web_App presents the template list, THE Web_App SHALL present each template's
   `report_templates.name`, and WHERE a template row's `report_templates.name` is absent or is the
   empty string, being a template whose identity step has never been saved, THE Web_App SHALL present
   in its place the placeholder string id the Message_Catalog declares, so that the list is checkable
   as the stored column or the declared placeholder rather than as the absence of a name no observation
   locates.
4. WHEN the Template_Store applies a rename, THE Template_Store SHALL restrict that write to a row
   whose `user_id` equals the signed-in user's id and SHALL resolve a request naming another user's
   row as not found, as the templates spec's criterion 1.4 declares.
5. THE Template_Store SHALL apply no write to any `report_template_versions` row when applying a
   rename, so that renaming a template alters no stored definition and no archived report.
6. WHERE a report is archived, THE Report_Detail_View SHALL present the template name the pinned
   definition's `identity.name` carries rather than the template's current
   `report_templates.name`, so that the document says what the template was called when it
   rendered.
7. THE Web_App SHALL permit the pinned definition's `identity.name` and the template's current
   `report_templates.name` to differ for an archived report, and SHALL present that difference
   without treating it as an error, because the pinned value is a historical fact and the current
   value is the live template's name.
8. WHEN the Template_Wizard saves the identity step, THE Template_Wizard SHALL apply the bounds the
   templates spec's criterion 2.10 declares to the submitted name, being 1 through 120 characters
   after leading and trailing whitespace is trimmed, and IF the submitted name falls outside those
   bounds, THEN THE Template_Wizard SHALL present a validation error on that step naming that bound,
   SHALL write no draft definition, SHALL invoke no rename, and SHALL present that error on that step
   rather than at completion.
9. IF the rename operation criterion 23.2 declares fails while the draft write criterion 23.1 declares
   succeeded, THEN THE Template_Wizard SHALL present that the template name was not updated, SHALL
   retain the entered value, SHALL leave the stored `report_templates.name` unchanged, SHALL present a
   control that re-invokes that rename, SHALL report that step as not saved, and SHALL report no error
   against the draft write that succeeded, so that a consultant reads which of the two writes did not
   land rather than one undifferentiated save failure.
10. WHEN the Template_Wizard opens the identity step for a template whose stored
    `report_templates.name` differs character for character from that template's current draft
    definition's `identity.name`, THE Template_Wizard SHALL present that divergence naming both values,
    and WHEN that step is next saved successfully THE Template_Wizard SHALL set both to the submitted
    value, so that the divergence criterion 23.9 can leave behind is repaired on the next save rather
    than persisting on a live template, which criterion 23.7 permits for an archived report alone.
11. IF the draft write criterion 23.1 declares fails, THEN THE Template_Wizard SHALL invoke no rename,
    SHALL leave both the stored definition and the stored `report_templates.name` unchanged, SHALL
    retain the entered value, and SHALL present that step as not saved.
12. WHEN the app test suite runs, THE Web_App SHALL include a test that saves the identity step carrying
    a name differing from the stored `report_templates.name`, asserts that the rename operation was
    invoked exactly once, and asserts that the template list then presents that submitted name and
    presents no placeholder for that template, so that the defect criterion 23.1 cites fails the suite
    rather than a delivered list.

---

### Section H — Mandatory negative tests

A gate that has never been observed to fail is not a gate. Each criterion below asserts a
**failure**: the test passes only when verification fails for the stated reason and no artifact is
delivered.

#### Requirement 24: Every gate this spec adds is observed failing

**User Story:** As a reviewer, I want each new gate demonstrated failing on a deliberately broken
document, so that a green suite means the gates work rather than that nothing tried them.

##### Acceptance Criteria

1. FOR ALL negative tests this requirement declares, THE Agent_Runtime SHALL assert that the
   unmutated fixture the test derives its input from produces a verification whose status is `pass`
   carrying zero blocking findings **before** that test applies its mutation, so that the recorded
   failure is attributable to the mutation rather than to a defect in the fixture.
2. FOR ALL negative tests this requirement declares, THE Agent_Runtime SHALL assert that the set of
   blocking finding types recorded is exactly the set that test declares as expected, SHALL declare as
   expected no blocking finding type that test's mutation does not cause, and SHALL fail IF a blocking
   finding of an undeclared type is recorded, so that a test cannot pass by failing for a reason other
   than the stated one and so that an assertion of absence such as the zero `unmatched_prose_token`
   assertion criterion 24.5 declares is entailed by that equality rather than standing outside it.
3. FOR ALL negative tests this requirement declares, THE Agent_Runtime SHALL assert that zero
   `report_file` events were emitted for that run, that no presigned URL was minted for any artifact
   key of that run, and that a request to the Web_App for a presigned URL for any artifact key of that
   run is resolved as not found, so that the absence of a download is observed at the interface a
   consultant would use rather than inferred from the absence of an event.
4. WHEN the agent test suite mutates a **numeric fact**'s rendered value in a rendered document such
   that the mutated string equals no ledger `formatted` value, while leaving the ledger, the anchor
   set and every other rendered character unchanged, THE Verifier SHALL set the verification status
   to `fail`, SHALL record `table_cell_mismatch` naming the table identity, the row key, the column
   key and the expected and observed strings, THE Run_State_Machine SHALL set that run's `status` to
   `failed` carrying `error_code` `VERIFICATION_FAILED`, and THE Web_App SHALL present no download
   control, so that a numeric fact is proven exactly as a metric figure is.
5. WHEN the agent test suite mutates a **text fact**'s rendered value in a rendered document from
   `Succeeded` to `Failed`, while leaving the ledger and every other rendered character unchanged,
   THE Verifier SHALL set the verification status to `fail` and SHALL record `text_fact_mismatch`
   naming the table identity, the row key, the column key, the fact key and the expected and
   observed strings; and that test SHALL additionally assert that the numeric masking stages record
   **zero** `unmatched_prose_token` findings for that mutation, so that the test fails against an
   implementation relying on numeric masking to catch it and thereby demonstrates why `TextFact`
   exists.
6. WHEN the agent test suite removes a fact-producing response from the archive of a stored run while
   leaving the stored `snapshot_id`, the archive sequence and every other archived object unchanged,
   THE Replay_Verifier SHALL record `replay_hash_mismatch` carrying the recomputed digest and the
   stored digest, THE Agent_Runtime SHALL report the terminal code `REPLAY_MISMATCH`, and THE
   Verifier SHALL set the verification status to `fail`, so that a fact-producing response absent
   from the archive fails replay rather than producing a snapshot that silently omits it.
7. WHEN the agent test suite renders a document whose pinned definition declares `identity.language`
   `id` and a comma `decimal_separator`, and converts that document such that its figures are written
   with a period decimal separator, THE Verifier SHALL set the verification status to `fail` and SHALL
   record `pdf_figure_missing` naming at least one ledger entry whose declared-format `formatted`
   string carries a comma decimal separator, together with that entry's AST path.
8. WHEN the agent test suite renders a document whose pinned definition declares `identity.language`
   `en` and a period `decimal_separator`, and converts that document such that its figures are
   written with a comma decimal separator, THE Verifier SHALL set the verification status to `fail`
   and SHALL record `pdf_figure_missing` naming at least one ledger entry whose declared-format
   `formatted` string carries a period decimal separator.
9. THE Agent_Runtime SHALL replace the existing negative test that asserts a comma-decimal conversion
   fails, being `test_n5_a_comma_decimal_conversion_fails_the_fidelity_gate` in
   `agent/tests/test_negative_gates.py`, which today asserts `pdf_figure_missing` and that the
   offending `formatted` string contains a period, with the two directions criteria 24.7 and 24.8
   declare, so that the assertion becomes *the document's separator disagrees with the definition's*
   rather than *commas are wrong*.
10. THE Agent_Runtime SHALL retain the companion assertion that the conversion locale alone rewrites
    nothing in this renderer's output, being
    `test_the_conversion_locale_alone_rewrites_nothing_in_this_renderers_output`, and SHALL keep that
    assertion in force for both declared formats, because that test is what records that this
    renderer emits every figure as a literal text run and that a locale therefore has nothing to
    reformat.
11. WHEN the agent test suite compiles a `historical_trend` block declaring a lookback of 6 periods
    against a subscription and template for which exactly 2 completed and verification-passed prior
    runs exist, THE Block_Compiler SHALL emit exactly 2 plotted points, SHALL emit the explicit
    statement criterion 19.2 declares naming 2 plotted and 6 requested, SHALL emit no third point,
    and THE Verifier SHALL set the verification status to `pass` carrying zero blocking findings, this
    test applying no mutation and asserting that outcome on the same unmutated fixture criterion 24.1
    requires every other test in this requirement to observe passing, so that a short trend is a
    labelled normal outcome rather than a failure and never a fabricated six.
12. WHEN the agent test suite compiles a `historical_trend` block for which a candidate prior run's
    latest verification result's status is `fail`, THE Historical_Resolver SHALL select no point from
    that run; and WHEN the agent test suite injects a historical point sourced from such a run into
    the compiled document, THE Verifier SHALL record `historical_point_unverified` naming that run id
    and SHALL set the verification status to `fail`.
13. WHEN the agent test suite compiles a `historical_trend` block for which two candidate prior runs
    carry overlapping resolved local periods, THE Historical_Resolver SHALL select at most one of
    those two runs; and WHEN the agent test suite injects points sourced from both into the compiled
    document,
    THE Verifier SHALL record `historical_point_overlapping` naming both run ids and SHALL set the
    verification status to `fail`.
14. WHEN the agent test suite renders a document of at least 8 pages whose table of contents names,
    for at least one entry, a page other than the page that entry's heading appears on, THE
    Toc_Verifier SHALL record `toc_page_mismatch` naming that entry's heading text, the page named
    and the page observed, and THE Verifier SHALL set the verification status to `fail`.
15. WHEN the agent test suite renders a document carrying a `TextFact` emitted at a position that is
    not a data-table cell, THE Verifier SHALL record `text_fact_unanchored` naming that entry's AST
    path and SHALL set the verification status to `fail`.
16. WHEN the agent test suite compiles a snapshot carrying a `Fact` with no `source` or no
    `collected_at`, THE Agent_Runtime SHALL report the terminal code `COMPILE_FAILED`, SHALL record
    `fact_source_missing` naming that fact's resource id and key, and SHALL write no report
    artifact.
17. THE Agent_Runtime SHALL extend the enumeration meta-test the templates spec's criterion 44.1
    declares to cover every blocking finding type this spec adds and every terminal code for which
    this spec declares a new failure branch, being `text_fact_mismatch`, `text_fact_anchor_missing`,
    `text_fact_unanchored`, `historical_point_unverified`, `historical_point_overlapping`,
    `toc_page_mismatch`, `fact_source_missing`, `COMPILE_FAILED` for an absent fact source, and
    `RENDER_FAILED` for an absent per-run front-matter value and for an absent message-catalog value,
    SHALL declare as exempt exactly the compilation of a `schema_version` 1 definition criterion 13.11
    declares, which is a positive outcome proven by a compile test rather than a gate that can fail,
    and the scope-rule invariant criterion 10.4 declares, which Property 7 proves across generated
    inputs, and SHALL fail IF any covered type or code is asserted by zero tests, so that a blocking
    type or terminal code declared here without a test that observes it fails the suite.
18. THE Agent_Runtime SHALL execute every negative test this requirement declares before a change in
    this spec is committed, and SHALL fail IF any negative test this requirement declares is skipped
    or is marked as an expected failure, because a gate whose negative test does not run is a gate
    that has never been observed failing.
19. WHEN the agent test suite mutates the table identity in the caption of a rendered data table
    carrying exactly one ledger entry, being a `TextFact`, such that that entry's anchor resolves to no
    cell, while leaving the ledger and every other rendered character unchanged, THE Verifier SHALL
    record `text_fact_anchor_missing` naming that entry's AST path and its anchor and SHALL set the
    verification status to `fail`, so that the blocking type criterion 6.7 declares carries a test that
    observes it rather than failing criterion 24.17's enumeration.
20. WHEN the agent test suite renders a run whose pinned template version declares `schema_version` 2
    and for which one per-run value criterion 13.7 declares is absent, THE Agent_Runtime SHALL report
    the terminal code `RENDER_FAILED` naming that value, SHALL write no report artifact, and SHALL emit
    no substituted placeholder in that value's position, and that test SHALL assert that no object
    exists at that run's `.docx` and `.pdf` artifact keys, so that an absent cover value is observed as
    a refusal rather than as invented copy.
21. WHEN the agent test suite renders a run whose pinned template version declares `identity.language`
    `id` and for which the Message_Catalog declares no value in `id` for one string id that render
    resolves, THE Agent_Runtime SHALL report the terminal code `RENDER_FAILED` naming that string id and
    that language and SHALL write no report artifact, and that test SHALL assert that no `en` value for
    that string id reached any rendered output, so that the fallback criterion 15.4 exists to prevent is
    observed absent rather than assumed absent.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a
system — essentially, a formal statement about what the system should do. Properties serve as the
bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The modules this spec adds are the kind where a plausible implementation is silently wrong across a
large input space: a fact archive reader, a formatter and a verifier that must agree on a declared
separator, a prior-run selector, and a grouping that must not lose a row. Each property below is
written so that it **fails on the naive implementation it exists to rule out**, and each names that
implementation.

#### Requirement 25: Property-based verification

**User Story:** As a reviewer, I want this spec's correctness claims machine-checked across
generated inputs, so that the properties the delivered document depends on are not maintained by
review alone.

##### Acceptance Criteria

1. THE Agent_Runtime SHALL execute every agent-side property this section declares with `hypothesis`
   at a minimum of 100 accepted generated examples per property, and THE Web_App SHALL execute every
   web-side property this section declares with `fast-check` at a minimum of 100 accepted generated
   cases per property, in the test suite that runs before a change in this spec is committed.
2. THE Agent_Runtime SHALL execute the foundation spec's Property 1 covering count-weighted
   averaging and exact minimum and maximum roll-up, the foundation spec's Property 2 covering JCS
   canonicalization and content addressing, and the templates spec's Property 4 covering replay's
   bit-identical snapshot digest, in that same suite, with their generators, assertions and declared
   examples unmodified, because facts now participate in the snapshot digest and in replay.
3. IF a property in this section or a property criterion 25.2 names fails, THEN THE Agent_Runtime
   SHALL report that property's declared identifier together with the shrunk counterexample
   `hypothesis` returns and the seed that reproduces it, and THE Web_App SHALL report that property's
   declared identifier together with the shrunk counterexample `fast-check` returns and the seed that
   reproduces it.
4. IF a property in this section is skipped, is marked as an expected failure, declares fewer than
   100 generated cases or examples, has its generation reported as exhausted before 100 are
   accepted, or rejects more than 20 percent of its generated cases or examples through a
   precondition, THEN THE Agent_Runtime SHALL fail its test suite for an agent-side property and THE
   Web_App SHALL fail its test suite for a web-side property.
5. WHEN a defect exposed by a failing property in this section is fixed, THE Agent_Runtime SHALL
   retain that failure's shrunk counterexample as an explicitly declared example running on every
   subsequent execution of that property, in addition to the 100-case minimum rather than counting
   toward it.
6. THE Agent_Runtime and THE Web_App SHALL each carry an enumeration of the declared identifiers of the
   properties this section declares for its half, and IF the set of property identifiers executed
   differs from that enumeration, or IF a property that enumeration names is collected and does not
   execute, THEN THE Agent_Runtime SHALL fail its test suite for an agent-side property and THE Web_App
   SHALL fail its test suite for a web-side property, naming every identifier present in one of those
   two sets and absent from the other.
7. THE Web_App SHALL keep `pnpm lint` and `pnpm typecheck` reporting zero errors, and THE
   Agent_Runtime SHALL keep its linter reporting zero errors, before any change in this spec is
   committed.
8. IF a declared example value or a declared example case a property in this section names is absent
   from the examples that property executed, THEN THE Agent_Runtime SHALL fail its test suite for an
   agent-side property and THE Web_App SHALL fail its test suite for a web-side property naming that
   property's identifier and that example, because a declared example is the case a generator is least
   likely to produce and is why it is declared rather than left to generation.
9. THE Agent_Runtime SHALL prove table-of-contents page-number correctness through the suite test
   criterion 14.2 declares together with the negative test criterion 24.14 declares, SHALL prove
   document-number determinism through a test asserting that two renders of one run resolve one
   identical document number and that two runs of one template and one resolved period are
   distinguished as criterion 13.16 declares, SHALL prove message-catalog completeness through the
   assertions criteria 15.5 and 15.10 declare, and SHALL declare no property in this section for any of
   those three, because each has one observable outcome per run rather than a generated input space
   across which a naive implementation could pass, and declaring that here keeps the enumeration
   criterion 25.6 compares against a closed set rather than an open question.
10. FOR ALL properties this section declares, THE Agent_Runtime SHALL reach an identical verdict on two
    executions carrying one identical seed, and IF a property reads a wall clock, issues a network
    request, or reads an ambient environment value such that two executions carrying one identical seed
    reach different verdicts, THEN THE Agent_Runtime SHALL fail its test suite for an agent-side property
    and THE Web_App SHALL fail its test suite for a web-side property naming that property's identifier,
    because the seed criterion 25.3 reports is a reproduction instruction and a property whose verdict
    depends on anything outside its seed cannot honour it.

### Property 1 — A fact round-trips through the archive (agent, hypothesis)

*Round-trip.* Generate facts, serialize them through the archive's own encoder, re-read them with a
plain JSON parse, re-derive the snapshot, and compare digests.

##### Acceptance Criteria

1. FOR ALL generated fact sets, THE Replay_Verifier SHALL recompute a snapshot digest equal to the
   digest the original collection produced, when every fact-producing response is written through
   the Archive_Writer's own encoder and read back with a plain JSON parse.
2. FOR ALL generated numeric facts, THE numeric-leaf reader SHALL accept that value in each of the
   forms either side can produce — an `int`, a `float`, a `Decimal` and a decimal **string** — and
   SHALL yield an equal `Decimal` for each form representing one value.
3. WHEN the agent test suite generates a fact for this property, THE Agent_Runtime SHALL draw every
   numeric fact value as a `Decimal` carrying **at least one non-zero fractional digit**, and SHALL
   include the declared values `0.1`, `462.81`, `0.30000000000000004` and one value carrying 17
   significant digits, because a whole number stays a JSON integer through the archive and therefore
   survives the exact bug this property exists to catch.
4. FOR ALL generated fact sets and ALL single-value mutations of one archived fact-producing
   response, THE Replay_Verifier SHALL recompute a digest differing from the stored digest.
5. FOR ALL generated fact sets, THE Replay_Verifier SHALL fold each archived object exactly once,
   asserted by a counter on the fake object store, and SHALL make zero network requests, asserted by
   a test double that fails the property IF any call is attempted.
6. FOR ALL generated fact sets in which one archived value is a decimal string the reader cannot
   parse, THE Replay_Verifier SHALL classify that value as absent, SHALL record a typed gap, and
   SHALL raise no exception mid-fold.
7. FOR ALL generated fact sets, THE Snapshot_Builder SHALL produce a canonical form in which every
   fact `value` is a JSON **string** and no fact `value` is a JSON number token.
**Kills:** a reader that accepts an `int`, a `float` and a `Decimal` but not a decimal `str`, which
   classifies every archived fact as absent and produces `REPLAY_MISMATCH` on every subscription
   whose facts carry a fractional value; a fixture using whole numbers only, which passes against
   that same reader; a collection path that folds a fact into the snapshot and writes no archive
   object, which criterion 1.4's mutation cannot distinguish from a correct run unless the digest is
   genuinely recomputed.

### Property 2 — Formatting and verification agree on the declared format (agent, hypothesis)

*Metamorphic / round-trip.* Generate values and declared number formats, format each value, then
verify the formatted string against the same declared format and against a different one.

##### Acceptance Criteria

1. FOR ALL generated values and ALL generated declared number formats, THE Verifier SHALL locate the
   `formatted` string the Formatter produced for that value under that same declared format in a
   document written with that format.
2. FOR ALL generated values and ALL pairs of declared number formats whose decimal separators
   differ, THE Verifier SHALL record `pdf_figure_missing` for a document written under one format
   and checked against the other, in **both** directions.
3. FOR ALL generated declared number formats, THE Formatter SHALL produce a `formatted` string
   containing the declared `decimal_separator` and containing the declared `grouping_separator`
   wherever grouping applies, and SHALL contain neither separator of any other format.
4. WHEN the agent test suite generates a case for this property, THE Agent_Runtime SHALL include the
   declared format pairs `{decimal ".", grouping ","}` and `{decimal ",", grouping "."}`, and the
   declared values `0.58`, `462.81` and `1234567.5`, so that the property covers `0,58%` and
   `462,81 GB` as correct outputs rather than as failures.
5. FOR ALL generated values, ALL declared formats and ALL languages drawn from `en` and `id`, THE
   Formatter SHALL produce an identical `formatted` string on every call for one such triple.
6. FOR ALL generated values, THE Formatter SHALL construct no binary floating-point number on the
   path from the value to the `formatted` string, asserted by a guard that raises on a `float`
   reaching that path.
7. FOR ALL generated declared formats whose `decimal_separator` equals the `grouping_separator`, and
   ALL formats whose separator is empty or contains a digit or a minus sign, THE Template_Validator
   SHALL reject that format naming the offending field.
**Kills:** a verifier that treats a period as the decimal separator, which fails every correct
   Indonesian document; a verifier that treats any separator as acceptable, which passes a document
   whose separator disagrees with its own declaration and thereby fails to detect a real corruption;
   a formatter that hard-codes either separator, which emits `0.58%` into a document that declared a
   comma.

### Property 3 — Historical run selection is newest-N, non-overlapping and verified (agent, hypothesis)

*Invariant.* Generate prior-run sets with statuses, verification outcomes and periods, then resolve
the historical selection.

##### Acceptance Criteria

1. FOR ALL generated prior-run sets and ALL lookbacks, THE Historical_Resolver SHALL select at most
   the lookback count of runs.
2. FOR ALL generated prior-run sets, THE Historical_Resolver SHALL select no run whose `status` is
   other than `completed` and no run whose latest verification result's status is other than `pass`.
3. FOR ALL generated prior-run sets, THE Historical_Resolver SHALL select no two runs whose resolved
   local periods overlap, where two periods overlap when the later period's start is at or before
   the earlier period's end.
4. FOR ALL generated prior-run sets, THE Historical_Resolver SHALL select the newest eligible runs by
   resolved period end descending, and SHALL select no eligible run whose period end is later than
   the period end of a run it excluded.
5. FOR ALL generated prior-run sets and ALL lookbacks, THE Historical_Resolver SHALL emit points
   ordered by period start ascending, and SHALL emit exactly one point per selected run.
6. FOR ALL generated prior-run sets, THE Historical_Resolver SHALL select an identical run set on
   every call for one pair of prior-run set and lookback, and SHALL select an identical set under any
   permutation of the input order, so that the selection depends on the runs rather than on the order
   the input presented those runs in.
7. FOR ALL generated prior-run sets containing fewer eligible runs than the lookback, THE
   Historical_Resolver SHALL select every eligible run, SHALL select no ineligible run to make up the
   count, and THE Block_Compiler SHALL emit a point count equal to the eligible count.
8. FOR ALL generated prior-run sets, THE Historical_Resolver SHALL select only runs of the same
   `report_templates.id` and the same connected subscription id as the run being compiled, being any
   pinned template version of that template row as criterion 18.4 declares, and SHALL select no run of
   another template row and no run of another subscription even where its period, status and
   verification outcome are eligible.
9. FOR ALL generated prior-run sets, THE Historical_Resolver SHALL make no network request, asserted
   by a test double that fails the property IF any call is attempted.
10. WHEN the agent test suite generates a case for this property, THE Agent_Runtime SHALL draw prior
    run counts from 0 to 40, lookbacks from 2 to 24, statuses including `completed` and `failed`,
    verification outcomes including `pass`, `fail` and absent, and periods including exactly adjacent
    pairs, one-day-overlapping pairs and identical pairs.
11. FOR ALL generated prior-run sets, THE Historical_Resolver SHALL record for every excluded candidate
    run exactly one typed exclusion reason drawn from the set criterion 18.15 declares, and SHALL record
    a reason for every candidate run it did not select, so that the count of selected runs plus the
    count of recorded exclusions equals the count of candidate runs supplied.
12. FOR ALL generated prior-run sets in which a candidate run's snapshot carries no value for the
    declared metric and statistic, and ALL sets in which a candidate run's `fidelity_tier` for that
    metric and statistic differs from the compiling run's, THE Historical_Resolver SHALL exclude that
    run carrying `metric_absent_in_snapshot` and `fidelity_tier_differs` respectively, and THE
    Block_Compiler SHALL emit no plotted point for that period, as criteria 18.13 and 18.14 declare.
**Kills:** a selector that filters on `status` alone, which admits a completed run whose verification
    failed; one that takes the newest N before filtering, which returns fewer than N eligible runs
    while eligible older runs exist; one that admits overlapping periods, which plots the same
    interval twice as two periods; one that pads to the lookback count, which fabricates a period;
    one whose order depends on the query's row order; one keyed on the identical `template_version_id`,
    which empties every trend on the next template edit; one that silently drops an ineligible
    candidate without recording why, which leaves the statement criterion 19.2 declares with no reason
    to name.

### Property 4 — Gap grouping is lossless (web, fast-check)

*Invariant.* Generate collection logs, group them, and compare the grouped counts against the
input.

##### Acceptance Criteria

1. FOR ALL generated collection logs, THE Gap_Grouper SHALL produce a grouping whose per-group entry
   counts sum, across every group, to exactly the count of entries in the input.
2. FOR ALL generated collection logs, THE Gap_Grouper SHALL place every input entry in exactly one
   group, and SHALL place no entry in two groups and no entry in none.
3. FOR ALL generated collection logs, THE Gap_Grouper SHALL produce a group set whose distinct
   `gap_type` values equal exactly the distinct `gap_type` values present in the input.
4. FOR ALL generated collection logs, THE Gap_Grouper SHALL produce, within each `gap_type` group,
   inner groups whose distinct keys equal exactly the distinct keys present among that type's entries
   under the total keying criterion 20.1 declares, taking the declared no-metric key for an entry
   carrying no metric and the declared unattributed group criterion 20.12 declares for an entry
   carrying no `resource_id`.
5. FOR ALL generated collection logs, THE Gap_Grouper SHALL produce an identical grouping on every
   call for one input, and SHALL select an identical representative message per group on every call.
6. FOR ALL generated collection logs whose entries for one inner group carry interval starts contiguous
   at the run's resolved grain, THE Gap_Grouper SHALL record a time range spanning exactly the earliest
   interval start and the latest interval start advanced by one grain step, as criterion 20.4 declares;
   and FOR ALL inner groups whose interval starts are not contiguous at that grain, or any of whose
   entries carries no interval start, THE Gap_Grouper SHALL record no time range.
7. WHEN the app test suite generates a case for this property, THE Web_App SHALL include the declared
   case of 512 entries across 8 metrics of 1 resource of one `gap_type`, which is the shape a live
   run produced, SHALL assert that grouping presents at most 9 rows before expansion while the counts
   still sum to 512, and SHALL include the declared cases of an entry carrying a `null` metric and an
   entry carrying an empty `resource_id`, so that the total keying criteria 20.1 and 20.12 declare is
   generated rather than assumed.
8. FOR ALL generated collection logs, THE Gap_Grouper SHALL perform no input or output operation.
9. FOR ALL generated collection logs, THE Gap_Grouper SHALL produce a grouping in which no inner group's
   key is undefined, and SHALL place no entry outside a group for want of a metric or a `resource_id`.
**Kills:** a grouper that de-duplicates entries rather than counting them, which loses rows and
   presents a total below the recorded gap count; one that groups by `gap_type` alone, which is the
   present behaviour and leaves 512 rows in one group; one whose representative depends on iteration
   order; one that records a time range across non-contiguous intervals, which asserts a continuous
   outage the data does not support; one keyed on `(resource_id, metric)` alone, which produces an
   undefined key for every `region_unreachable`, `permission_denied` and fact gap — each of which
   carries no metric — and therefore drops rows the sum criterion 20.3 declares must account for.

### Property 5 — Every catalog entry is evidenced (agent, hypothesis)

*Invariant / model-based.* Generate catalog entries against recorded fixtures and compare.

##### Acceptance Criteria

1. FOR ALL generated catalog entries drawn from a recorded fixture, THE Catalog_Evidence_Guard SHALL
   accept that entry.
2. FOR ALL generated catalog entries carrying a metric name absent from that resource type's
   fixture, a unit differing from the fixture's unit for that metric, or an aggregation the fixture
   does not report as supported, THE Catalog_Evidence_Guard SHALL reject that entry naming the
   resource type, the metric name and the disagreeing field.
3. FOR ALL generated catalog entries whose metric name differs from a fixture name only by letter
   case, by surrounding whitespace, or by a substituted separator character, THE
   Catalog_Evidence_Guard SHALL reject that entry, because a portal display name and an API metric
   name differ in exactly those ways.
4. FOR ALL generated catalog entries for a resource type carrying no recorded fixture, THE
   Catalog_Evidence_Guard SHALL reject that entry naming that resource type.
5. FOR ALL generated catalogs, THE Catalog_Evidence_Guard SHALL reach an identical verdict on every
   call for one pair of catalog and fixture set.
**Kills:** a guard comparing metric names case-insensitively, which accepts `Percentage Cpu`; one
   comparing only names and not units, which accepts a metric declared in the wrong unit family and
   therefore sketched into the wrong structure; one that passes when a fixture is missing, which
   makes the whole guard vacuous for a newly added type.

### Property 6 — A text fact's check catches what numeric masking cannot (agent, hypothesis)

*Metamorphic.* Generate text facts, render them, mutate them, and compare the two verification
paths.

##### Acceptance Criteria

1. FOR ALL generated text facts rendered into data-table cells, THE Text_Fact_Verifier SHALL record
   zero findings for the unmutated document.
2. FOR ALL generated text facts and ALL single-character mutations of one rendered text fact value,
   THE Text_Fact_Verifier SHALL record `text_fact_mismatch` naming that fact's anchor and the
   expected and observed strings.
3. FOR ALL generated text facts carrying no digit, ALL mutations of one such value, THE numeric
   masking stages SHALL record zero `unmatched_prose_token` findings, so that the property
   demonstrates that the numeric path cannot catch the mutation and the exact-string check is what
   does.
4. FOR ALL generated text facts matching the identifier pattern
   `[A-Za-z_][\w.\-]*[0-9][\w.\-]*`, ALL mutations of one such value, THE numeric masking stages
   SHALL record zero `unmatched_prose_token` findings, because stage 2 masks that token as an
   identifier, and THE Text_Fact_Verifier SHALL record `text_fact_mismatch`.
5. WHEN the agent test suite generates a case for this property, THE Agent_Runtime SHALL include the
   declared values `Succeeded`, `Failed`, `Standard_D4s_v3`, `10.0.0.4`, `Windows Server 2022` and
   `10.0.0.0/16`, and the declared mutation `Succeeded` to `Failed`.
6. FOR ALL generated documents in which one text fact is emitted outside a data-table cell, THE
   Verifier SHALL record `text_fact_unanchored` naming that entry's AST path.
7. FOR ALL generated documents in which one text fact's rendered text is removed while its ledger
   entry remains, THE Verifier SHALL record `ledger_entry_unrendered` naming that entry's AST path.
**Kills:** an implementation routing text facts through numeric masking, which records nothing for
   `Succeeded` becoming `Failed` because that token carries no digit and is never extracted; one
   routing them through masking stage 1 as a `formatted` value, which masks the mutated token by
   accident and reports a clean pass; one emitting text facts as plain `TextCell` content, which is
   not a ledger entry and therefore not checked at all.

### Property 7 — A picked scope stays a rule (web, fast-check)

*Invariant.* Generate subscription inventories and picker selections, then inspect the stored
definition.

##### Acceptance Criteria

1. FOR ALL generated inventories and ALL selections from them, THE Scope_Picker SHALL store a
   definition containing no subscription identifier, no tenant identifier and no fully qualified
   Azure resource identifier.
2. FOR ALL generated inventories and ALL selections, THE Template_Validator SHALL accept the stored
   definition, so that a selection cannot produce a definition the validator rejects.
3. FOR ALL pairs of generated inventories drawn from two different subscriptions that share a
   resource type, THE Scope_Picker SHALL store an identical scope value for a selection of that type
   from either inventory, so that the stored rule is independent of which subscription's inventory
   listed it.
4. FOR ALL generated inventories, THE Inventory_Endpoint SHALL return a response containing no fully
   qualified resource identifier, no subscription identifier, no tenant identifier and no client
   identifier.
5. FOR ALL generated directly entered values, THE Scope_Picker SHALL apply the same bounds and the
   same validation it applies to a selected option.
6. WHEN the app test suite generates a case for this property, THE Web_App SHALL include the declared
   case of an inventory whose resource group name contains a subscription-like identifier substring,
   asserting that the stored value is that group name and that the definition still passes the
   resource-identifier rejection.
**Kills:** a picker that stores the selected resource's id alongside its type, which binds the
   template to one subscription and breaks the property that one template serves every customer; one
   that stores a subscription-qualified group path; an endpoint that returns full resource ids,
   which puts a resource identifier one copy-paste away from a scope field.

---

## Traceability — the themes this spec exists to close

| Theme | Requirements |
|---|---|
| The catalog covers more than one resource type | 1.1, 1.2, 1.6, 3.6, 3.7 |
| Every catalog entry is verified against the Metric Definitions API, not guessed | 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, Property 5 |
| `catalog_version` bumped; a snapshot stays readable against its catalog | 1.3 |
| Breadth composes with the data-plane reroute, batching, grain and throttling | 3.1, 3.2, 3.3, 3.4, 3.5 |
| Facts are a second collected datum, recorded parallel to statistics | 4.1, 4.5, 4.10 |
| A fact's source is a fact about the fact | 4.2, 4.4, 8.4, 24.16 |
| `collected_at` is an instant and is shown wherever a fact appears | 4.3, 8.1, 8.2, 8.3, 8.5 |
| Facts collected in the inventory pass wherever Resource Graph can project them | 4.7, 4.8, 4.9 |
| A numeric fact is verified exactly as a metric figure is | 6.1, 24.4 |
| A text fact gets its own exact-string check because masking cannot catch it | 6.2, 6.4, 6.5, 6.6, 6.7, 24.5, Property 6 |
| A `TextFact` cannot carry a number and cannot escape its anchor | 6.3, 6.8, 6.9, 6.10 |
| Every fact-producing response is archived, or replay fails | 7.1, 7.2, 7.3, 7.5, 24.6 |
| The archive's `Decimal` → digit-string → `str` reader obligation | 7.7, 7.8, Property 1 |
| A fact a subscription does not expose is a typed gap, never a blank | 5.1, 5.2, 5.3, 5.4, 5.5, 5.7 |
| Selection is a picker sourced from live inventory | 9.1, 9.2, 10.1, 11.1, 12.1 |
| The picker is an affordance; what is stored is a rule | 10.2, 10.3, 10.4, 10.8, Property 7 |
| Free entry survives alongside the picker | 9.6, 9.7, 10.5, 10.6 |
| Block config is picked from step 4's selection, closing the JSON hole structurally | 12.2, 12.3, 12.4, 12.5 |
| Front matter is fixed, not composable | 13.1, 13.2, 13.3 |
| Cover, document control and approvers | 13.4, 13.5, 13.6 |
| Template-once configuration versus per-run values | 13.7, 13.8 |
| `schema_version` 2 without rewriting an immutable stored version | 13.10, 13.11, 13.12 |
| The TOC approach is proven before it is designed around | 14.1, 14.2 |
| No TOC is shipped whose page numbers are wrong | 14.3, 14.4, 14.6, 14.7, 24.14 |
| Language is a template setting and no English string reaches an `id` document | 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7 |
| The narrator is instructed in the template's language | 15.7 |
| The declared number format is written and checked, in both directions | 16.1, 16.4, 16.5, 16.6, 16.7, Property 2 |
| N5 rewritten: the separator disagrees with the declaration | 24.7, 24.8, 24.9, 24.10 |
| Charts look like a deliverable and verify unchanged | 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.9 |
| Historical points come from prior verified runs, never invented | 18.4, 18.5, 18.6, 18.9, 18.10, 24.12, Property 3 |
| Historical points do not overlap | 18.7, 24.13 |
| The block says historical points were verified elsewhere | 19.7, 19.8, 19.9 |
| Fewer prior runs than requested is normal, plotted and labelled | 19.1, 19.2, 19.3, 19.4, 19.5, 24.11 |
| Gap grouping is lossless and actionable | 20.1, 20.2, 20.3, 20.4, 20.5, 20.8, 20.9, Property 4 |
| The verification panel fits a narrow viewport | 21.1, 21.2, 21.3, 21.4, 21.5 |
| The paper rendering is styled or renamed | 22.1, 22.2, 22.3, 22.4, 22.7, 22.8, 22.9 |
| A live template shows its own name; an archived report shows its pinned name | 23.1, 23.2, 23.3, 23.6, 23.7 |
| Every gate this spec adds has been observed failing | 24.1, 24.2, 24.3, 24.17, 24.18 |
| The invariant is unmoved: nothing added bypasses a gate | 6.1, 6.10, 6.12, 17.7, 18.11, 19.8, 24.3 |
| A wrong catalog entry degrades the run; zero valid entries is terminal | 1.7, 1.8 |
| `value_kind` routes a fact, not the characters of its value | 4.1, 4.11, 6.1, 6.2 |
| A fact gap is one gap per absent key, and only for a fact the type declares | 5.8, 5.9, 5.10 |
| Replay reproduces a fact's canonical form from the archive alone, reading no clock | 7.2, 7.10, 7.11 |
| A rendered `collected_at` is itself an anchored ledger entry | 8.7 |
| A picked scope value survives being opened against another subscription's inventory | 10.10, 10.11 |
| A `columns` field admits resource attributes and fact keys, not metrics alone | 12.9 |
| A stored config reference is surfaced on load, not only at the next save | 11.9, 12.10 |
| Per-run front-matter values have a failure branch at enqueue and at render | 13.14, 13.15 |
| The document-number pattern has a grammar and a re-run is a revision | 13.16 |
| The TOC proof is a suite test, and an unadopted approach ships no TOC | 14.1, 14.2, 14.10 |
| `schema_version` 1 definitions stay renderable in `en` with default separators | 15.12, 16.10 |
| An archived report verifies against its pinned number format | 16.12 |
| A dense series thins labels, never figures | 17.4 |
| A trend spans template versions, and an incomparable prior period is a labelled exclusion | 18.4, 18.13, 18.14, 18.15 |
| Prior-run selection is total and deterministic across re-runs of one period | 18.6, 18.7 |
| The grouping key is total for a gap carrying no metric and no resource | 20.1, 20.12 |
| An expanded gap group is bounded rather than restoring 512 paragraphs | 20.14 |
| The panel is checked by presented text, because the test environment performs no layout | 21.4, 21.5, 22.9 |
| Which claim the paper rendering makes is decided by an executing assertion | 22.8, 22.10 |
| The two identity writes are non-atomic, and the divergence is repairable | 23.1, 23.9, 23.10, 23.11 |
| Every blocking type and new terminal code is observed failing, and the exemptions are named | 24.17, 24.19, 24.20, 24.21 |
| The property enumeration is a closed set, and declared examples must have run | 25.6, 25.8, 25.9 |

## Traceability — `azure-integration.md` guardrails this spec touches

| Guardrail | Criteria |
|---|---|
| A data-plane `401`, `403` or `404` reroutes to the ARM per-resource path and records no gap | 3.3 |
| One reader parses a numeric leaf from a live response and from the archive, accepting a decimal string | 7.7, 7.8, Property 1.2, Property 1.6 |
| A replay fixture carries fractional values, because whole numbers survive the bug | Property 1.3 |
| Metric definitions probed once per `(resource_type, region)` and cached | 3.2 |
| Batching by points budget with adaptive halving; one `metric_namespace` per call | 3.1, 3.5 |
| Base grain `PT1H`, `PT15M` for a non-whole-hour offset; never `P1D` or `PT1M` | 3.5 |
| Every per-resource error is a typed gap; no path converts one to a zero | 5.7, 3.7 |
| Every value a decimal string; the snapshot JCS-canonicalized and hashed | 4.5, 4.6, Property 1.7 |
| Concurrency capped at 8 per subscription | 4.9 |
| A gap is recorded, never zero-filled, never an empty string | 5.1, 5.2, 5.3, 5.4, 5.5 |
| An empty in-scope result stays a hard failure | referenced unchanged from the templates spec's criterion 32.3 |
| A per-resource error inside a 200 is a gap; an endpoint-level 401/403/404 is a reroute | 3.3, 3.8 |
| A region reachable by neither route is a recorded gap, terminal only if every region fails | 3.9 |
