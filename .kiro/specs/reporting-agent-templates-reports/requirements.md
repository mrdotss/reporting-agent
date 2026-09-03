# Requirements Document

## Introduction

This spec builds the **report** half of the Infrastructure Utilization Reporting Agent: the
seven-step **template wizard**, the **compiler** that turns a template definition plus a
snapshot into a typed document AST, the **renderer** that emits `.docx` and `.pdf` from that
AST, and the **verifier** that proves the delivered document against the snapshot it came
from.

It builds directly on the **completed** `reporting-agent-foundation` spec and **does not
restate it**. Authentication, sessions, Azure subscription onboarding, the `scope_verified`
preflight, secret handling, the metric catalog, the collector, the immutable
content-addressed snapshot, the raw archive, the `report_runs` state machine, the progress
callback, the reaper, the cosmetic SSE relay, the AgentCore invoke contract and the redaction
guard are **already specified and built there**. Where this spec extends one of those, the
criterion says so and names the foundation criterion it extends; where this spec depends on
one unchanged, it references it rather than duplicating it.

The product invariant this spec exists to enforce is **no LLM ever produces a number**. That
invariant is not a prompt and not a review item. It is enforced by two structures:

- **The document AST**, whose only numeric leaf is a **figure** carrying its own
  `snapshot_path`, so there is no representable way to put a number in a document without
  provenance; and
- **the verifier**, which reads the rendered document back and proves every numeric in it
  against the **figure ledger**. A report whose verification does not pass is **not
  delivered**. There is no path in this spec that presents a download beside a failed
  verification.

Because a gate that has never been observed to fail is not a gate, the six **negative tests**
in Section H are first-class requirements with their own acceptance criteria, not a testing
footnote.

### Scope boundary

| In scope | Out of scope |
|---|---|
| Template definition model, validation, immutable versioning | Template sharing between users, template import/export |
| The seven-step wizard, block composition, style presets, preview | Free-positioning canvas, nested rows, page-level layout control |
| `compile/` — scope resolution, block compilation, the AST, the figure ledger, formatting | A user-facing template language of any kind |
| `render/` — `.docx`, HTML, static chart images, `.pdf` via LibreOffice | Any second layout definition; independent PDF rendering from the ledger |
| `verify/` — table anchors, prose masking, ledger completeness, charts, replay, coverage, PDF fidelity | Re-querying Azure to re-verify a stored report |
| Advisory sampled drift and advisory LLM prose review | Automatic remediation of a drift or prose finding |
| Report list, report detail, in-app paper rendering, verification panel, presigned download | Scheduled runs, email delivery, multi-tenant client workspaces |
| `comparison_delta` compiled from two pinned snapshots | A standalone run-comparison screen outside a report |
| Additive schema growth: template tables, version pin, verification record | Any `DROP` of a foundation table or column |

`report_runs.status` already declares `compiling`, `rendering` and `verifying` as defined but
undriven values, and `lib/events.ts` / `events.py` already declare `delta`, `chart`,
`verification` and `report_file` as declared but unemitted event types. **This spec drives
those three statuses and emits those four event types. It adds no status and no event type**,
so the cross-language event mirror is unchanged.

---

## Glossary

Vocabulary is used identically to `product.md`, `structure.md` and the foundation spec. Terms
marked **(system)** are the actors that EARS criteria name in the `THE <system> SHALL`
position.

### Domain vocabulary carried forward unchanged

- **snapshot** — the immutable, content-addressed result of one collection run,
  RFC 8785 (JCS) canonicalized and SHA-256 hashed. `snapshot_id` **is** that hash. Produced
  by the foundation spec; consumed, never written, by this spec.
- **figure** — one numeric with its full provenance: `value` (a fixed-precision **decimal
  string**, never a JSON number), `formatted` (the exact string the renderer emits), `unit`,
  `snapshot_path`, `estimator`, `derived_from`, `formula`, `resource_id`, `metric`, `window`,
  `fidelity_tier`.
- **collection_log** — the typed, per-resource record of gaps from one collection run. A gap
  is recorded, never zero-filled. Its `gap_type` set is declared by the foundation spec and
  is not extended here.
- **fidelity_tier** — `baseline` (platform metrics only; exact avg/min/max, percentiles
  **estimated**) or `enhanced` (Azure Monitor Agent plus a Data Collection Rule; true
  percentiles, per-volume disk free space, guest-observed memory). Recorded per resource in
  the snapshot and propagated to every value derived from that resource.
- **estimator** — the identifier of how a statistic was produced, carried inside the value
  object alongside a pre-formatted label. A bare percentile key never exists.

### Domain vocabulary introduced by this spec

- **template definition** — a versioned JSON document declaring identity, scope **rules**,
  a relative period specification, metric selection, block composition and design settings. A
  definition holds **rules, never resource identifiers**, and is bound to **no** subscription,
  so one definition is reusable across every connected subscription.
- **template version** — one immutable row in `report_template_versions` carrying a
  definition and that definition's canonical digest. A run pins the exact version it
  rendered.
- **block** — one typed element of a template definition, carrying an `id`, a `type`, a
  `config` and an optional `scope_override`.
- **row block** — the one container block. It splits into 2 or 3 columns and holds child
  blocks. **One level of nesting only**: a row's columns refuse another row.
- **document AST** — the typed tree a compiled template becomes. Its **only** numeric leaf is
  a figure, so provenance is **structural** rather than procedural. Two emitters walk the same
  tree: `.docx` (the delivered artifact) and HTML (the in-app rendering).
- **figure ledger** — every figure the compiler emitted for one render, keyed by its **AST
  node path**. Not a parallel structure: **the ledger and the render context are the same
  object**, so they cannot drift out of agreement.
- **table anchor** — the triple `{table_id, row_key, col_key}` mapping to one `formatted`
  string, emitted by the renderer into the ledger. `table_id` is carried in the table's Alt
  Text (`w:tblPr/w:tblCaption`).
- **data table** — a table emitted from a data-bearing block. A data table **always** carries
  a `w:tblCaption` table id.
- **layout table** — the borderless table a `row` block is emitted as. A layout table
  **never** carries a `w:tblCaption`, which is how the table-verification pass excludes it by
  construction rather than by inspecting borders or cell counts.
- **static-text allowlist** — the set of numeric-bearing strings obtained by rendering one
  template version with a **null context**, i.e. with no snapshot data bound. Those strings
  are template chrome rather than measurements, so the prose mask allows them.
- **verification result** — pass or fail plus every finding: unmatched prose tokens with
  their locations, unrendered ledger entries, table-anchor findings, chart findings, the
  replay outcome, the coverage outcome, the PDF-fidelity outcome, and every advisory finding.
  Stored beside the report and surfaced in the interface. **A report without a passing
  verification is not a report.**
- **verification finding type** — the typed classification carried by each verification
  finding. The set this spec declares is:
  - Blocking: `unmatched_prose_token` · `table_anchor_missing` · `table_anchor_unexpected` ·
    `table_cell_mismatch` · `table_column_unresolved` · `table_row_unresolved` ·
    `duplicate_table_anchor` · `table_rows_absent` · `ledger_entry_unrendered` ·
    `chart_table_missing` ·
    `chart_hash_mismatch` · `replay_hash_mismatch` · `coverage_resource_absent` ·
    `pdf_figure_missing` · `scope_unverified` · `empty_scope`
  - Advisory: `archive_incomplete` · `drift_observed` · `prose_review_finding` ·
    `fidelity_not_comparable`
- **relative period specification** — the period expressed as a rule rather than as dates:
  one of `last_24h`, `last_7d`, `last_30d`, `last_full_month`, `mtd` or `custom`, resolved
  **fresh at each run** into local dates in the run's timezone.
- **style preset** — one of four curated themes — **Editorial · Corporate · Technical ·
  Minimal** — each a **styles-only** `.docx` in `agent/themes/` carrying Word paragraph,
  character and table styles and **no content**.
- **chart data hash** — the digest over a chart's plotted decimal strings, recorded on the
  chart specification and in the sidecar accompanying the embedded chart image, so that an
  image and the data it claims to depict cannot disagree silently.
- **drift sample** — the bounded resource sample a drift check re-queries, recorded as
  `{n, method, seed}` so that a disputed check is re-runnable identically.

### Error codes this spec adds

Added **additively** to `report_runs.error_code`, alongside the foundation's ten values.
All are terminal.

- `TEMPLATE_INVALID` — the pinned template version failed validation at compile time.
- `COMPILE_FAILED` — compilation of the definition against the snapshot failed.
- `RENDER_FAILED` — `.docx` emission failed, including a theme missing a referenced style.
- `PDF_CONVERSION_FAILED` — the `.docx` to `.pdf` conversion failed.
- `VERIFICATION_FAILED` — the rendered document and the snapshot disagree.
- `REPLAY_MISMATCH` — re-running the pure aggregation over the archived raw responses
  produced a snapshot digest differing from the stored one.

### Systems

Carried forward from the foundation spec and referenced unchanged: **Web_App**,
**Agent_Runtime**, **Run_State_Machine**, **Snapshot_Builder**, **Metric_Catalog**,
**Boundary_Guard**, **Projection_Guard**, **Enqueue_Action**, **Progress_Reporter**,
**Progress_Endpoint**, **Reaper**, **SSE_Relay**, **Crypto_Module**, **Env_Module**.

Introduced by this spec:

- **Template_Store (system)** — the `report_templates` table and its data layer.
- **Template_Version_Store (system)** — the `report_template_versions` table and its data
  layer.
- **Template_Validator (system)** — the definition schema and layout-grammar validator,
  expressed in `app/lib/templates/` and mirrored in
  `agent/src/reporting_agent/compile/definition.py`.
- **Template_Wizard (system)** — the seven-step authoring flow.
- **Block_Composer (system)** — the palette, canvas and inspector surface of the block
  composition step.
- **Style_Picker (system)** — the design step's preset grid and tuning controls.
- **Preview_Canvas (system)** — the in-wizard HTML paper preview.
- **Period_Resolver (system)** — `app/lib/templates/period.ts`: relative specification to
  local dates.
- **Scope_Resolver (system)** — `agent/.../compile/scope.py`.
- **Block_Compiler (system)** — `agent/.../compile/blocks/`.
- **AST_Model (system)** — `agent/.../compile/ast.py`.
- **Figure_Ledger (system)** — `agent/.../compile/figures.py`.
- **Formatter (system)** — `agent/.../compile/format.py`.
- **Estimator_Labeller (system)** — `agent/.../compile/estimators.py`.
- **Docx_Renderer (system)** — `agent/.../render/docx.py`.
- **Anchor_Writer (system)** — `agent/.../render/anchors.py`.
- **Html_Emitter (system)** — `agent/.../render/html.py`.
- **Chart_Renderer (system)** — `agent/.../render/charts.py`.
- **Pdf_Converter (system)** — `agent/.../render/pdf.py`.
- **Theme_Guard (system)** — the test that loads each theme document and asserts its style
  set.
- **Build_Pipeline (system)** — the container image build, which runs the Theme_Guard and the
  Mirror_Guard before publishing an image.
- **Token_Extractor (system)** — `agent/.../verify/tokens.py`.
- **Verifier (system)** — `agent/.../verify/verifier.py`.
- **Replay_Verifier (system)** — `agent/.../verify/replay.py`.
- **Drift_Sampler (system)** — `agent/.../verify/drift.py`.
- **Prose_Reviewer (system)** — the advisory LLM review of narrative prose.
- **Delta_Compiler (system)** — `agent/.../compare/delta.py`.
- **Verification_Store (system)** — the `report_verifications` table and its data layer.
- **Report_Detail_View (system)** — the report detail surface, including the in-app paper
  rendering.
- **Verification_Panel (system)** — the audit-certificate presentation of a verification
  result.
- **Mirror_Guard (system)** — the static guard comparing the block-type and block-config
  declarations across `app/lib/templates/blocks.ts` and
  `agent/.../compile/definition.py`.

---

## Requirements

### Section A — The template model

#### Requirement 1: A template is subscription-agnostic rules

**User Story:** As a consultant, I want one template to work for every customer I have
connected, so that onboarding a new customer does not mean re-authoring a report.

##### Acceptance Criteria

1. THE Template_Store SHALL define a `report_templates` table carrying `id`, `user_id`,
   `name`, `description`, `current_version_id`, `created_at` and `updated_at`, with `user_id`
   referencing `users.id`, `name` constrained to 1–120 characters, `description` constrained
   to 0–1000 characters, and `current_version_id` nullable only until the template's first
   version exists.
2. THE Template_Store SHALL define no column on `report_templates` and no field in a template
   definition that carries a `connected_subscription_id`, a subscription identifier, a tenant
   identifier, or an Azure resource identifier, and SHALL make a template definition's meaning
   independent of which connected subscription a run selects.
3. IF a submitted template definition carries, in any scope field, a fully qualified Azure
   resource identifier, a subscription identifier, or a tenant identifier, THEN THE
   Template_Validator SHALL reject the definition before any row is written, SHALL persist no
   new `report_template_versions` row, SHALL return a validation error naming the offending
   field's path within the definition, and SHALL state that a scope is expressed only as
   resource types, tag filters and resource groups rather than as named resources.
4. WHEN the Web_App lists, reads or writes a `report_templates` row or a
   `report_template_versions` row on behalf of a signed-in user, THE Template_Store SHALL
   restrict that operation to rows whose `user_id` equals that user's id.
5. IF a requested template row's `user_id` differs from the signed-in user's id, THEN THE
   Template_Store SHALL resolve that request as not found, SHALL apply no write, SHALL
   disclose no field of that row, and SHALL return a response indistinguishable from the
   response for an id that does not exist.
6. THE Template_Store SHALL accept the same template, at the same version and with an
   unchanged `definition_sha256`, for a run against any connected subscription whose `status`
   is `active`, and SHALL apply no per-subscription restriction to a template.
7. WHEN a run is enqueued referencing a template version, THE Template_Store SHALL apply no
   write to the referenced `report_templates` or `report_template_versions` row, so that one
   version stays reusable for an unlimited number of connected subscriptions and repeat runs.
8. IF the connected subscription selected for a run has a `status` other than `active`, or has
   `scope_verified` false, THEN THE Web_App SHALL reject the run with an error attributing the
   cause to that subscription, SHALL leave the template and its versions unchanged, and SHALL
   keep the template selectable for every other `active` subscription of the same user.
9. IF a request to list, read or write a template row carries no valid signed-in session, THEN
   THE Template_Store SHALL apply no write and SHALL disclose no field of any template or
   template version.

#### Requirement 2: The template definition schema

**User Story:** As a developer, I want a definition the wizard can save to be a definition the
compiler can compile, so that a save-time success is not a run-time failure minutes later.

##### Acceptance Criteria

1. THE Template_Validator SHALL define a definition schema requiring all seven of
   `schema_version`, `identity`, `scope`, `period`, `metrics`, `blocks` and `design`, SHALL
   treat each of those seven as mandatory rather than optional, and SHALL reject a definition
   that omits any of them or that carries a key the schema does not declare, naming each
   omitted key and each undeclared key.
2. THE Template_Validator SHALL parse every definition through a zod schema at the boundary of
   every route handler and every server action that accepts one, treating path parameters and
   search parameters as input, SHALL complete that parse before any write to the
   Template_Store and before any invoke of the Agent_Runtime, and SHALL reject a field whose
   type differs from the declared type rather than coercing that field.
3. IF a definition carries a block whose `type` is absent from the block-type set criterion
   6.1 declares, THEN THE Template_Validator SHALL reject that definition, SHALL name the
   rejected type and that block's position within the definition, SHALL persist no version
   row, and SHALL neither ignore nor drop that block.
4. THE Template_Validator SHALL define `schema_version` as an integer of 1 or greater, SHALL
   write it into every stored definition, and SHALL treat a stored definition's
   `schema_version` as immutable once its version row is written, so that a later reader
   identifies which schema a stored definition was authored against.
5. THE Template_Validator SHALL declare, between sentinel comments in
   `app/lib/templates/blocks.ts`, the block-type set and for each block type its config
   schema, including each config field name, whether that field is required, and the permitted
   values of each enumerated field; and THE Block_Compiler SHALL declare the same set and the
   same per-type config schema between matching sentinel comments in
   `agent/.../compile/definition.py`.
6. IF the block-type set, any block type's declared config field names, any field's required
   status, or any enumerated field's permitted values declared in
   `app/lib/templates/blocks.ts` differ from those declared in
   `agent/.../compile/definition.py`, or IF either sentinel-delimited declaration is absent or
   cannot be parsed, THEN THE Mirror_Guard SHALL fail the static check and SHALL name every
   differing block type and field, because a definition the Web_App can save and the
   Block_Compiler cannot compile converts a save-time validation error into a failed run
   minutes later.
7. IF a definition fails validation at save time, THEN THE Web_App SHALL reject the save,
   SHALL state every failing field path in one response rather than the first failing path
   alone, SHALL persist no version row, and SHALL leave the template's current version row
   unchanged.
8. IF a pinned template version fails validation at compile time, THEN THE Agent_Runtime SHALL
   report the terminal code `TEMPLATE_INVALID`, SHALL name every failing field path, SHALL
   render no document, SHALL write no report artifact, and SHALL record `TEMPLATE_INVALID` as
   that run's terminal error code on the run row, so that a client reading the row observes the
   failure without the event stream.
9. IF a definition's `schema_version` is absent, is not an integer, is below 1, or is above the
   highest schema version the reading half declares as supported, THEN THE Template_Validator
   SHALL reject that definition, SHALL state the observed value and the highest supported
   version, SHALL apply no default value, and SHALL persist no version row.
10. THE Template_Validator SHALL bound a definition at the block count criterion 6.3 declares,
    at a serialized size of no more than 262,144 bytes of UTF-8 in its RFC 8785 canonical
    form, at an identity name of 1 through 120 characters, and at an identity description of 0
    through 1,000 characters, and SHALL reject a definition exceeding any of those bounds,
    naming the exceeded bound and the observed value.
11. THE Mirror_Guard SHALL validate a shared corpus of at least 20 definition fixtures,
    covering every declared block type at least once and carrying both accepted and rejected
    fixtures, through both the Template_Validator and the Block_Compiler, and SHALL fail
    unless both reach the same accept-or-reject outcome for every fixture and name the same
    offending block `id` and field path for every rejected fixture.

#### Requirement 3: Scope rules, template default plus per-block override

**User Story:** As a consultant, I want one report to carry "Top 10 VMs by CPU" and "all
Storage Accounts by used capacity" side by side, so that a single document answers more than
one question.

##### Acceptance Criteria

1. THE Template_Validator SHALL define a scope specification carrying: zero to 20 fully
   qualified resource types; zero to 10 tag filters, each a key of 1 to 512 characters and a
   value of 0 to 256 characters; zero to 50 resource group names of 1 to 90 characters each; an
   optional top-N count that is an integer from 1 to 500 accompanied by the metric name and the
   statistic that ordering is taken from; and an optional sort direction that is one of
   `descending` or `ascending`.
2. THE Template_Validator SHALL accept a scope specification as the template default and SHALL
   accept a `scope_override` carrying that same specification on any block, and SHALL reject a
   definition in which any block carries more than one `scope_override`.
3. WHEN the Agent_Runtime requests collection for a run, THE Agent_Runtime SHALL request the
   **union** of the template default scope and every block `scope_override`, SHALL form that
   union as the set of resources matching any one of those scopes with duplicate resource ids
   collapsed to one entry, and SHALL ignore every top-N count and sort direction when forming
   it, so that one snapshot carries every resource any block needs including the candidates a
   top-N ordering discards.
4. WHEN the Scope_Resolver resolves a block's scope, THE Scope_Resolver SHALL resolve that
   scope against the snapshot alone, SHALL read no input other than the snapshot bytes and the
   block's scope specification, and SHALL issue zero Azure requests and zero network requests,
   so that a replay of the compile stage over the same snapshot stays clean.
5. FOR ALL blocks carrying no `scope_override`, THE Scope_Resolver SHALL resolve that block's
   scope to the template default scope resolved against the same snapshot.
6. WHEN the Scope_Resolver resolves a scope carrying a top-N count, THE Scope_Resolver SHALL
   order the matched resources by the named metric and statistic in the scope's sort direction,
   treating an absent sort direction as `descending`, SHALL break a tie by resource id
   ascending in Unicode code-point order, SHALL retain the first N resources of that order, and
   SHALL retain every matched resource when the matched count is less than N, so that two
   compilations over one snapshot resolve one identical ordered resource list.
7. IF a block's resolved scope contains zero resources, THEN THE Block_Compiler SHALL emit that
   block carrying exactly one explicit row stating that no resources matched that scope, SHALL
   retain that block's heading and position in the document order, SHALL emit that block
   carrying zero figures, and SHALL emit that block rather than omitting it, because a block
   that vanished is indistinguishable from a block that was never configured.
8. THE Agent_Runtime SHALL treat a block resolving to zero resources as an ordinary compile
   outcome, SHALL report no error code for it, SHALL record no `collection_log` gap for it, and
   SHALL let the run proceed to rendering and verification unchanged.
9. IF the union of the template default scope and every block `scope_override` resolves to zero
   resources, evaluated after inventory completes and before any snapshot is written, THEN THE
   Agent_Runtime SHALL report the terminal code `EMPTY_SCOPE` as the foundation spec's
   criterion 33.1 declares, SHALL report an error message indicating that no resources matched
   the run's combined scope, SHALL write no snapshot, SHALL compile no document, and SHALL
   write no report artifact.
10. IF a template default scope or a block `scope_override` violates any bound or enumeration
    of criterion 3.1, or carries a top-N count without a metric name or without a statistic,
    THEN THE Template_Validator SHALL reject that definition, SHALL report an error indicating
    the offending block and the offending field, SHALL persist no new template version, and
    SHALL leave the previously stored definition unchanged.
11. IF a resource matched by a scope carrying a top-N count has no value in the snapshot for
    the named metric and statistic, THEN THE Scope_Resolver SHALL exclude that resource from
    the ranked order and SHALL append every such resource after all ranked resources in
    resource id ascending Unicode code-point order before the first N are retained, so that a
    missing metric value never reorders the ranked resources.
12. WHEN the Scope_Resolver matches a resource against a scope specification, THE
    Scope_Resolver SHALL require the resource to satisfy every populated dimension of that
    specification, SHALL treat multiple entries within one dimension as satisfied by any one
    entry matching, SHALL treat an empty dimension as imposing no constraint, and SHALL compare
    resource types and tag keys ignoring case and tag values honouring case.

#### Requirement 4: The relative period specification

**User Story:** As a consultant, I want a template's period to mean "last full month" rather
than a fixed date range, so that next month's report needs no edit.

##### Acceptance Criteria

1. THE Template_Validator SHALL constrain a definition's period specification to exactly one of
   the six case-sensitive values `last_24h`, `last_7d`, `last_30d`, `last_full_month`, `mtd`
   and `custom`, SHALL treat the period specification as a required field, and SHALL reject a
   save whose period specification is absent or is any value outside that set.
2. WHERE a definition's period specification is `custom`, THE Template_Validator SHALL require
   an explicit local start date and an explicit local end date, each a valid Gregorian calendar
   date in `YYYY-MM-DD` form, SHALL treat both dates as inclusive local days, and SHALL require
   the start date to be at or before the end date and the inclusive span between them to be at
   least 1 and at most 31 local days.
3. WHEN a run is enqueued, THE Period_Resolver SHALL resolve the pinned template version's
   period specification into an inclusive local start date and an inclusive local end date in
   that run's timezone, using as `current local date` the date component of the enqueue instant
   expressed in that run's timezone, and SHALL record those two resolved local dates on the
   enqueued `report_runs` row, so that each run resolves the period afresh at its own enqueue
   instant.
4. WHEN the Period_Resolver resolves a period specification, THE Period_Resolver SHALL resolve
   `last_24h` to the single local day preceding the current local date, `last_7d` to the 7
   consecutive local days ending on the local day preceding the current local date, `last_30d`
   to the 30 consecutive local days ending on the local day preceding the current local date,
   `last_full_month` to the first through the last local day inclusive of the local calendar
   month preceding the current local month, `mtd` to the first local day of the current local
   month through the local day preceding the current local date inclusive, and `custom` to the
   definition's explicit local start and end dates, and SHALL treat both resolved endpoints as
   included in the period in every case.
5. THE Period_Resolver SHALL resolve every period specification to a local end date at or
   before the local day preceding the current local date, because the current local day is
   incomplete and a partial trailing local day would understate every daily figure derived
   from it.
6. IF a resolved period contains zero local days, including `mtd` resolved on the first local
   day of a local month, THEN THE Enqueue_Action SHALL reject the submission, SHALL insert no
   `report_runs` row, SHALL invoke no runtime, SHALL retain the consultant's subscription,
   template and period selections for correction, and SHALL return an error indicating that the
   requested period contains no complete local day.
7. IF a resolved period's inclusive local day count is below 1 or above 31, or its resolved
   local end date is after the local day preceding the current local date in that run's
   timezone, THEN THE Enqueue_Action SHALL reject the submission before inserting any
   `report_runs` row, as the foundation spec's criterion 37.10 declares, and SHALL return an
   error indicating which bound the resolved period violated.
8. WHEN the Period_Resolver resolves a period, THE Period_Resolver SHALL derive that resolution
   solely from the run's timezone and the current instant, SHALL derive it from no host or
   process time-zone setting, and SHALL resolve any two enqueue instants that fall within the
   same local day of that timezone to identical local start and end dates.
9. WHEN the Snapshot_Builder records a run's window, THE Web_App SHALL display that window's
   local start date, local end date and resolved UTC offset alongside the period
   specification the pinned template version declared, so that a reader distinguishes the rule
   from the dates that rule resolved to.
10. WHILE a run is in any non-terminal state after enqueue, THE Agent_Runtime SHALL use the
    local start date and local end date recorded on that run's row and SHALL re-resolve the
    period specification at no later phase, so that a run whose phases span local midnight
    collects, compiles, renders and verifies over one unchanged window.
11. IF a pinned template version's period specification is absent or is not one of the six
    values named in criterion 4.1, THEN THE Enqueue_Action SHALL reject the submission, SHALL
    insert no `report_runs` row, and SHALL return an error indicating that the pinned template
    version declares an unrecognized period specification.
12. IF a `custom` period specification fails any constraint named in criterion 4.2, THEN THE
    Template_Validator SHALL reject the save, SHALL write no new template version, and SHALL
    return an error indicating which of the date form, the date validity, the date ordering or
    the 1-to-31-local-day span was violated.

#### Requirement 5: Metric selection per resource type

**User Story:** As a consultant, I want to choose which metrics a template collects, so that a
report is not padded with figures nobody asked for.

##### Acceptance Criteria

1. THE Template_Validator SHALL accept a metric selection expressed as one entry per resource
   type, each entry naming between 1 and 40 items drawn from the metrics and derived statistics
   the Metric_Catalog declares for that resource type, across at most 25 resource-type entries
   per definition.
2. IF a definition's metric selection names a metric or a derived statistic absent from the
   Metric_Catalog entry for that resource type, THEN THE Template_Validator SHALL reject the
   save, SHALL return an error identifying the rejected metric or derived statistic and the
   resource type, SHALL persist no version row, and SHALL leave the previously saved definition
   unchanged.
3. IF a block's config references a metric or derived statistic absent from that definition's
   metric selection for any resource type that block's resolved scope can contain, THEN THE
   Template_Validator SHALL reject the save, SHALL return an error identifying that block and
   that metric or derived statistic, and SHALL persist no version row, so that a savable
   definition is a compilable definition.
4. WHEN the Agent_Runtime requests collection for a run, THE Agent_Runtime SHALL request, per
   resource type present in the union scope, exactly the union of the pinned template version's
   metric selections for that resource type, and SHALL request no metric outside that union.
5. IF a definition's metric selection names a derived statistic for which the Metric_Catalog
   does not declare, for that resource type, every source metric and every SKU capability that
   derived statistic's formula consumes, THEN THE Template_Validator SHALL reject the save,
   SHALL return an error identifying the derived statistic and each missing source metric or
   SKU capability, and SHALL persist no version row.
6. WHEN the Template_Wizard opens metric selection for a resource type, THE Template_Wizard
   SHALL present the selectable items from the Metric_Catalog entry for that resource type
   rather than from a list held in the Web_App, and SHALL show for each item whether the catalog
   declares its statistics exact or estimated and the catalog's fractional-digit scale, so that
   one catalog governs both halves.
7. WHEN the Template_Validator accepts a metric selection entry naming a percentile statistic,
   THE Template_Validator SHALL persist that entry carrying the estimator label and the
   fidelity tier the Metric_Catalog declares for that statistic and resource type.
8. IF a metric selection entry names a percentile statistic without the estimator label the
   Metric_Catalog declares for that statistic and resource type, THEN THE Template_Validator
   SHALL reject the save, SHALL return an error identifying that entry, and SHALL persist no
   version row.
9. IF a definition's metric selection contains no metric and no derived statistic for a resource
   type that the definition's default scope or any block `scope_override` can contain, THEN THE
   Template_Validator SHALL reject the save, SHALL return an error identifying that resource
   type, and SHALL persist no version row.

#### Requirement 6: The block palette and the layout grammar

**User Story:** As a consultant, I want to compose a report from vetted blocks, so that every
report I produce looks professional and every figure in it keeps its provenance.

##### Acceptance Criteria

1. THE Template_Validator SHALL declare exactly these sixteen block types and no others:
   `cover`, `executive_summary`, `kpi_row`, `resource_table`, `top_n_table`,
   `timeseries_chart`, `distribution_chart`, `capacity_vs_usage`, `gaps_and_coverage`,
   `comparison_delta`, `verification_record`, `appendix_methodology`, `row`, `page_break`,
   `heading` and `rich_text`.
2. THE Template_Validator SHALL define a block as an object carrying a required `id` of 1 to 64
   characters, a required `type` drawn from the sixteen declared types, a required `config`
   object, and an optional `scope_override`; and SHALL define a `row` block as an object
   carrying `id`, the type `row`, a column count of exactly 2 or 3, and a list of child blocks
   holding 0 to 8 children per column.
3. THE Template_Validator SHALL accept blocks arranged as a single vertical sequence in which
   the list order of the definition is the document order from first to last, a `row` block
   holds child blocks in its columns in list order from first column to last, and no other
   ordering, ranking or index field is read; and SHALL accept at most 200 blocks in one
   definition, counting `row` blocks and their children.
4. IF a definition nests a `row` block inside another `row` block at any depth, THEN THE
   Template_Validator SHALL reject the save, SHALL identify the offending child block by its
   `id`, and SHALL return an error indicating that a row holds no row, because one level of
   nesting is what makes every arrangement the composer can express paginate correctly.
5. THE Template_Validator SHALL define no absolute position, no coordinate pair, no offset, no
   explicit width or height in absolute units and no explicit page assignment on any block, and
   SHALL reject a definition carrying any such field with an error naming the rejected field,
   because Word is a reflowing paginated medium and a freely positioned layout cannot survive a
   page break honestly.
6. IF a `rich_text` block's `config` binds a metric, a statistic, a resource id, a scope or a
   snapshot path, THEN THE Template_Validator SHALL reject the definition and SHALL return an
   error indicating that `rich_text` carries static prose and no figure, naming the block `id`
   and the bound field.
7. IF two blocks in one definition carry the same `id`, counting top-level blocks and every
   `row` child together, THEN THE Template_Validator SHALL reject the definition and SHALL
   return an error naming the duplicated `id`.
8. WHILE a definition carries zero blocks, THE Template_Validator SHALL accept it as a draft,
   where a draft is a stored definition that no report run pins, and SHALL reject a run request
   against a pinned version carrying zero blocks with an error indicating that a report needs at
   least one block, leaving the stored definition unchanged.
9. IF a definition carries a block whose `type` is not one of the sixteen declared types, or a
   `config` field the declared schema for that type does not define, THEN THE Template_Validator
   SHALL reject the definition and SHALL return an error naming the unknown type or field, and
   SHALL NOT accept the definition with the unknown element ignored or dropped.
10. THE Template_Validator SHALL validate a definition's `schema_version` as criteria 2.4 and
    2.9 declare, and SHALL reject a definition whose block composition is expressed against a
    schema version those criteria do not declare as supported.
11. WHEN THE Template_Validator rejects a definition, THE Template_Validator SHALL report every
    violation found in that definition rather than only the first, SHALL identify each violation
    by the offending block `id` and the offending field, SHALL write no new immutable version,
    and SHALL leave the previously stored definition and every existing version byte-identical.

#### Requirement 7: Style presets and design tuning

**User Story:** As a consultant, I want to pick a look for the document, so that the report
matches the engagement rather than looking like a tool's default output.

##### Acceptance Criteria

1. THE Template_Validator SHALL constrain a definition's style preset to exactly one of
   `editorial`, `corporate`, `technical` and `minimal`, matched case-sensitively, and SHALL
   treat every other value, including an absent value, as invalid.
2. THE Template_Validator SHALL accept design settings carrying an accent colour expressed as
   one opaque colour value, a density of exactly one of `compact`, `normal` or `relaxed`, a
   table style of exactly one of `hairline`, `banded` or `bordered`, a number format specifying
   a decimal-place count in the range 0 to 3 inclusive and a thousands-grouping flag, a
   cover-page flag of true or false, an optional logo reference of at most 512 characters, and a
   page size of exactly one of A4 and Letter.
3. WHEN the Formatter produces a `formatted` string, THE Formatter SHALL apply the number format
   carried by the pinned template version's design settings, SHALL be the only component that
   converts a figure value into a display string, and SHALL produce byte-identical `formatted`
   strings across repeated compiles of the same figure value, unit, estimator and number format,
   so that the number format changes the ledger rather than introducing a second formatting
   path.
4. THE Docx_Renderer SHALL emit each block against the paragraph, character and table styles
   that the selected preset's styles-only theme document in `agent/themes/` declares, and SHALL
   apply no inline paragraph, character or table formatting for any style that theme document
   already declares.
5. WHERE a definition's cover-page flag is false, THE Docx_Renderer SHALL emit no `cover` block
   content and no leading blank page, SHALL emit the remaining blocks in their declared order,
   and SHALL leave the `cover` block and its configuration present in the definition so that
   re-enabling the flag restores it unchanged.
6. WHERE a definition carries a logo reference, THE Docx_Renderer SHALL embed that logo on the
   cover block, and IF that logo reference is unresolvable — absent from the artifact store,
   unreadable as an image, larger than 5 MB, or not retrieved within 10 seconds — THEN THE
   Docx_Renderer SHALL emit the cover block without the logo, SHALL record one advisory finding
   identifying the cover block and the reason the logo was not embedded, and SHALL complete the
   render as a success.
7. WHEN the Docx_Renderer loads a theme document in `agent/themes/`, THE Docx_Renderer SHALL
   assert that it declares the `Figure` character style and every paragraph, character and table
   style the compiled AST references, and IF any referenced style is absent, THEN THE
   Docx_Renderer SHALL report the terminal code `RENDER_FAILED` identifying the theme and the
   offending style and SHALL emit no document.
8. IF a definition's style preset, accent colour, density, table style, number format,
   cover-page flag or page size is absent or outside the values permitted by criteria 7.1 and
   7.2, THEN THE Template_Validator SHALL reject the save with an error identifying the
   offending field and its permitted values, and SHALL persist no new template version.
9. THE Docx_Renderer and THE Html_Emitter SHALL emit each figure's `formatted` string from the
   Figure_Ledger verbatim, SHALL apply no number formatting, rounding or separator substitution
   of their own, and IF a numeric leaf reaches either emitter without a `formatted` string, THEN
   that emitter SHALL fail the render with an error identifying the AST node path and SHALL
   produce no artifact.

#### Requirement 8: Theme documents carry styles and no content

**User Story:** As a reviewer, I want a theme missing a style to break the build, so that a
customer never receives a document with unstyled figures.

##### Acceptance Criteria

1. THE Agent_Runtime SHALL ship exactly four theme documents — `editorial.docx`,
   `corporate.docx`, `technical.docx` and `minimal.docx` — in `agent/themes/` inside the arm64
   container image, tracked in the repository as source files and changed only through the same
   review path as code, and SHALL resolve a template's style preset only to one of those four
   names.
2. THE Theme_Guard SHALL assert, for each of the four theme documents, that the document
   declares a character style named `Figure`, because the Docx_Renderer wraps every figure in
   that style and the Token_Extractor depends on that wrapping to locate figures without
   re-parsing prose.
3. THE Theme_Guard SHALL compute the union of the paragraph style names and table style names
   declared as referenced by the declared block types, and SHALL assert that each of the four
   theme documents declares every style name in that union.
4. IF any of the four theme documents is missing `Figure` or any style name in the union
   criterion 8.3 declares, THEN THE Theme_Guard SHALL fail the test suite with a non-zero result
   that names every theme document and style name pair found missing across all four documents
   in a single run rather than only the first, so that the failure occurs at build time rather
   than as a silently unstyled delivered document.
5. THE Theme_Guard SHALL assert that each theme document contains zero non-whitespace text
   characters in its body, headers and footers, so that a theme is a stylesheet that happens to
   be a `.docx` rather than a document with placeholder prose in it.
6. IF a theme document named by the pinned template version is absent from the image at run
   time, or is missing a style the compiled AST references, THEN THE Agent_Runtime SHALL
   terminate the run with the terminal code `RENDER_FAILED` and an error message naming the theme
   document and every missing style name, SHALL write and upload no report artifact, and SHALL
   leave the already-written snapshot unmodified.
7. WHEN the container image is built, THE Build_Pipeline SHALL run the Theme_Guard as part of
   that build, and IF the Theme_Guard fails, THEN that build SHALL abort without publishing an
   image, so that no image containing a theme missing a referenced style can reach a run.
8. IF a file in `agent/themes/` cannot be opened as a readable document package, or the
   directory contains other than exactly the four required file names, THEN THE Theme_Guard SHALL
   fail the test suite with a non-zero result naming the offending file, reported as distinct
   from a missing-style failure.
9. WHEN a report run is claimed, THE Agent_Runtime SHALL assert before any Azure collection call
   that the theme document named by the pinned template version's style preset is present in the
   image and declares the `Figure` character style, and IF that assertion does not hold, THEN THE
   Agent_Runtime SHALL terminate the run with `RENDER_FAILED` naming the theme document, so that
   the failure surfaces before minutes of collection work are spent.

#### Requirement 9: Templates are immutably versioned and runs pin a version

**User Story:** As a consultant, I want editing a template to leave last month's report
exactly as delivered, so that an archived report stays an audit artifact.

##### Acceptance Criteria

1. THE Template_Version_Store SHALL define a `report_template_versions` table carrying `id`,
   `template_id`, `version`, `definition` as `jsonb`, `definition_sha256` and `created_at`, with
   `template_id` referencing `report_templates.id`, with every one of those columns `NOT NULL`,
   with `version` an integer starting at 1 for a template's first version, and with a UNIQUE
   constraint over the pair (`template_id`, `version`).
2. WHEN a consultant saves a template edit whose definition passes validation, THE
   Template_Version_Store SHALL insert a new `report_template_versions` row whose `version`
   equals the highest existing `version` for that `template_id` plus exactly 1, and SHALL issue
   no `UPDATE` and no `DELETE` against any existing `report_template_versions` row.
3. THE Template_Version_Store SHALL expose no operation that modifies a
   `report_template_versions` row and no operation that deletes one, and IF a modification or
   deletion of such a row is attempted through any exposed operation, THEN THE
   Template_Version_Store SHALL reject it with an error indicating that template versions are
   immutable and SHALL leave every existing version row byte-identical.
4. WHEN the Template_Version_Store computes `definition_sha256`, THE Template_Version_Store
   SHALL canonicalize the definition with RFC 8785 (JCS) and SHALL take the SHA-256 digest of
   the UTF-8 encoded bytes of that canonical form, rendered as 64 lowercase hexadecimal
   characters.
5. IF a submitted definition's canonical digest equals the `definition_sha256` of the
   highest-numbered existing version for that `template_id`, THEN THE Template_Version_Store
   SHALL insert no new version row and SHALL return that existing version, so that a save that
   changed nothing creates no version.
6. THE Run_State_Machine SHALL add a `NOT NULL` `template_version_id` column to `report_runs`
   referencing `report_template_versions.id`, additively, and SHALL set that column on every run
   inserted by the Enqueue_Action to the highest-numbered version of the selected template as of
   insertion; IF no version row can be resolved for the selected template, THEN THE
   Enqueue_Action SHALL insert no run row and SHALL return an error indicating the template has
   no saved version.
7. WHEN the Agent_Runtime compiles a report for a run, THE Agent_Runtime SHALL compile the
   definition carried by that run's pinned `template_version_id`, and SHALL read no other
   version of that template; IF that pinned version row cannot be read, THEN THE Agent_Runtime
   SHALL fail the run terminally with an error indicating the pinned template version is
   unavailable and SHALL substitute no other version.
8. WHEN a consultant edits a template that a completed run pinned, THE Web_App SHALL leave that
   run's `docx_sha256`, `pdf_sha256` and `snapshot_sha256` unchanged, SHALL leave that run's
   `template_version_id` unchanged, and SHALL continue to present that run against its pinned
   version rather than the newest version.
9. THE Web_App SHALL display, on a report's detail surface, the template name, the pinned version
   number and the pinned `definition_sha256` the report was rendered from, and SHALL display the
   pinned version number even when a higher-numbered version of that template exists.
10. IF a generated migration contains a `DROP` of a table or of a column that a previously
    committed migration created, THEN THE Boundary_Guard SHALL fail, as the foundation spec's
    criterion 9.5 declares.
11. IF two saves of the same template are committed concurrently and both compute the same next
    `version`, THEN THE Template_Version_Store SHALL let exactly one row commit, SHALL reject the
    other on the (`template_id`, `version`) UNIQUE constraint, and SHALL re-resolve the highest
    existing `version` and retry the rejected save at most 3 times before returning an error
    indicating the save could not be sequenced.
12. IF a submitted definition declares a block type the block-config schemas do not define,
    nests a `row` block inside another `row` block, omits its `schema_version`, or exceeds the
    serialized size bound criterion 2.10 declares, THEN THE Template_Version_Store SHALL insert
    no `report_template_versions` row, SHALL return an error identifying the rejected block or
    the violated bound, and SHALL leave the template's existing versions unchanged.
13. WHEN a consultant re-verifies an archived report, THE Agent_Runtime SHALL recompile that
    run's pinned `template_version_id` against that run's pinned `snapshot_sha256`, SHALL assert
    the recompiled Figure_Ledger is byte-identical to the ledger stored for that run, and IF the
    two differ, THEN THE Agent_Runtime SHALL report the re-verification as failed and SHALL leave
    the stored artifacts and the stored verification result unchanged.

#### Requirement 10: Three starter templates ship

**User Story:** As a first-time user, I want templates already there, so that the composer is
not a blank page I have to guess at.

##### Acceptance Criteria

1. THE Template_Store SHALL declare exactly three starter template definitions, named
   **Monthly utilization**, **Capacity planning** and **Executive summary**, versioned in the
   repository and reviewed as code.
2. WHEN a user account is created, THE Template_Store SHALL insert one `report_templates` row
   per starter template carrying that user's `user_id`, SHALL insert for each of those rows one
   `report_template_versions` row carrying `version` 1 and the `definition_sha256` criterion
   9.4 declares, SHALL set each `report_templates` row's `current_version_id` to that version,
   and SHALL insert no further starter row for that user on any later request, so that a
   signed-in user holds exactly three editable starter templates and a repeated request
   creates no duplicate.
3. THE Template_Store SHALL define each starter template as a definition the
   Template_Validator accepts, carrying a period specification that is one of `last_24h`,
   `last_7d`, `last_30d`, `last_full_month` and `mtd` rather than `custom`, so that a starter
   template is a working example that needs no edit to run in a later month rather than a
   placeholder.
4. WHEN a consultant edits a starter template, THE Template_Version_Store SHALL insert a new
   version as criterion 9.2 declares, and SHALL leave that starter's `version` 1 row, that
   row's `definition` and that row's `definition_sha256` unchanged and readable.
5. THE Template_Store SHALL compose each starter template from at least one block whose `type`
   is one of `kpi_row`, `resource_table`, `top_n_table`, `timeseries_chart`,
   `distribution_chart` and `capacity_vs_usage`, at least one block whose `type` is one of
   `executive_summary` and `rich_text`, and one `verification_record` block, so that a starter
   template demonstrates the provenance chain end to end.
6. IF the insertion of a user's starter templates fails after inserting fewer than three
   templates, THEN THE Template_Store SHALL retain no partially inserted starter template or
   starter version row, SHALL leave that user able to author a template through the
   Template_Wizard, and SHALL state that the starter templates could not be initialized.
7. WHEN a consultant renames or deletes a seeded starter template, THE Template_Store SHALL
   apply that rename or deletion as it does for any other template of that user, and SHALL
   insert no replacement starter template for that user.
8. IF a starter template definition fails Template_Validator validation, THEN THE
   Build_Pipeline SHALL fail, naming that starter template and each failing field path, so
   that a broken starter definition is caught at build time rather than by a first-time user.

---

### Section B — The wizard

#### Requirement 11: The seven-step wizard

**User Story:** As a consultant, I want authoring a template to be a guided flow, so that I
finish with a report I can run rather than a half-configured draft.

##### Acceptance Criteria

1. THE Template_Wizard SHALL present exactly seven steps, in the fixed order identity as step
   1, scope rules as step 2, period as step 3, metric selection as step 4, block composition as
   step 5, design as step 6 and preview as step 7, and SHALL display the current step's position
   and the total of seven on every step.
2. WHEN a consultant navigates to a step whose number is at or below the highest step reached
   in that wizard session, THE Template_Wizard SHALL present that step and SHALL retain every
   value entered on every one of the seven steps, applying no reset to a step the consultant
   navigated away from.
3. IF a consultant requests the next step while any input on the current step fails the
   Template_Validator, THEN THE Template_Wizard SHALL remain on that step, SHALL state each
   failing field path on that step, SHALL present no later step, and SHALL retain every value
   entered on that step and on every other step.
4. WHEN a consultant completes a step transition or activates the save-draft action, THE
   Template_Wizard SHALL persist the draft definition against the signed-in user's template
   row, SHALL persist it whether or not step 7 has been reached, SHALL persist it whether or
   not the definition yet satisfies the at-least-one-block rule criterion 6.8 declares, and
   SHALL insert no `report_template_versions` row for that draft.
5. WHEN a consultant confirms completion of the wizard and every one of the seven steps' inputs
   passes the Template_Validator and the definition carries at least one block, THE
   Template_Version_Store SHALL insert the version as criterion 9.2 declares, and SHALL return
   the existing version without inserting a row where the canonical digest is unchanged as
   criterion 9.5 declares.
6. THE Template_Wizard SHALL offer no control that uploads a document, because a template is a
   composed definition and no document-upload path exists in this product.
7. THE Template_Wizard SHALL present the period step as exactly the six relative
   specifications criterion 4.1 declares, SHALL require the two explicit local dates criterion
   4.2 declares where the selected specification is `custom`, SHALL display the local start date
   and local end date that the Period_Resolver resolves the selected specification to at the
   current instant in the timezone a run of that template would use, SHALL label those dates as
   an illustration resolved fresh at each run, and SHALL persist no resolved date in the
   definition.
8. WHEN a consultant reopens a template carrying a persisted draft, THE Template_Wizard SHALL
   restore every persisted value of that draft and SHALL open the lowest-numbered step whose
   inputs fail the Template_Validator, or step 7 where every step's inputs pass, so that
   authoring resumes rather than restarting.
9. IF persisting a draft fails, THEN THE Template_Wizard SHALL state that the draft was not
   saved, SHALL retain every entered value in the wizard, SHALL insert no
   `report_template_versions` row, and SHALL leave the previously persisted draft unchanged.
10. IF a consultant confirms completion while any step's inputs fail the Template_Validator or
    while the definition carries zero blocks, THEN THE Template_Wizard SHALL reject that
    completion, SHALL name each failing step and each failing field path, SHALL state that a
    report needs at least one block where the block count is zero, and THE
    Template_Version_Store SHALL insert no version row.

#### Requirement 12: Block composition is keyboard-operable

**User Story:** As a consultant who does not use a mouse, I want to reorder blocks from the
keyboard, so that the composer is usable rather than nominally accessible.

##### Acceptance Criteria

1. THE Block_Composer SHALL present three panes — a block palette, a canvas carrying the
   composed blocks, and an inspector for the selected block — and SHALL make each pane
   reachable from the keyboard in the order palette, canvas, inspector, with a visible `--ring`
   focus indicator on the focused element and no pane that traps focus.
2. THE Block_Composer SHALL present each palette entry with a Phosphor icon and one line
   describing what that block emits rather than what that block is named, and SHALL make every
   palette entry keyboard-focusable.
3. WHEN a consultant focuses a palette entry and presses Enter or Space, THE Block_Composer
   SHALL append the corresponding block to the end of the canvas's top-level sequence, SHALL
   make that appended block the selected block, and SHALL move keyboard focus to that appended
   block, so that a keyboard user's next reorder acts on the block just inserted.
4. WHEN a consultant selects a block on the canvas and presses a modifier key with ArrowUp or
   ArrowDown, THE Block_Composer SHALL move that block exactly one position toward the start of
   its container for ArrowUp and exactly one position toward the end of its container for
   ArrowDown, SHALL confine that move to the container the block currently occupies — the
   top-level sequence, or the one row column it sits in — and SHALL retain both keyboard focus
   and selection on that block after the move.
5. WHEN the Block_Composer completes a block move, THE Block_Composer SHALL announce, within 1
   second of that move and through an `aria-live` region set to `polite`, one message carrying
   the moved block's type label, its 1-based new position within its container and that
   container's total block count, and SHALL emit exactly one announcement per completed move.
6. THE Block_Composer SHALL render the canvas as a list whose DOM order equals the order the
   document emits, with each row block's child blocks in column order from first column to last,
   so that reading order matches the order the document will emit.
7. THE Block_Composer SHALL give every drop target an accessible name carrying that target's
   1-based insertion position, its container's total position count, and, for a target inside a
   row block, that row's 1-based column number and column count, rather than a name that states
   only that the target accepts a drop.
8. WHEN a consultant drags a block over a valid insertion point, THE Block_Composer SHALL
   display a 2-pixel `--primary` rule at that insertion point, SHALL shift no surrounding block
   to represent the pending insertion, and SHALL remove that rule when the pointer leaves that
   insertion point.
9. WHEN a consultant drags a `row` block, whether from the palette or from the canvas, over a
   `row` block's column, THE Block_Composer SHALL display a blocked-state cursor on that column,
   SHALL display a hint stating that a row holds no row, SHALL display no insertion rule on that
   column, and SHALL leave the composed block order unchanged if that drag is released there,
   because a drag that silently does nothing reads as a defect and invites repetition.
10. WHEN a consultant selects a block on the canvas, THE Block_Composer SHALL indicate that
    selection with a `--ring` outline and SHALL apply no colour fill and no background change to
    that block, so that the canvas keeps resembling the document it previews.
11. THE Block_Composer SHALL present the selected block's `scope_override` controls in the
    inspector, and SHALL display the inherited template default above the override in
    `--muted-foreground`, so that inheriting and narrowed are visually distinct states rather
    than the same empty field.
12. IF a keyboard move would place a block before the first position or after the last position
    of its container, THEN THE Block_Composer SHALL apply no move, SHALL retain keyboard focus
    and selection on that block, SHALL leave the composed block order unchanged, and SHALL
    announce through the `polite` `aria-live` region that the block already occupies the first or
    last position of its container.
13. THE Block_Composer SHALL provide a keyboard-only path for every canvas operation it provides
    by pointer drag — inserting a block from the palette, reordering a block within its
    container, moving a block between a row column and the top-level sequence, and removing a
    block — and SHALL be composed on no drag-and-drop primitive that lacks such a path, because
    keyboard-operable reordering is a condition of this requirement passing rather than a later
    addition.
14. IF a consultant attempts a keyboard move that would place a `row` block inside a `row`
    block's column, THEN THE Block_Composer SHALL apply no move, SHALL leave the composed block
    order unchanged, SHALL retain keyboard focus and selection on that block, and SHALL announce
    through the `polite` `aria-live` region that a row holds no row, so that the refusal
    criterion 12.9 shows a pointer user is stated to a keyboard user as well.

#### Requirement 13: The style preset picker shows real thumbnails

**User Story:** As a consultant, I want to see what a theme looks like, so that choosing one is
a visual decision rather than a guess at a word.

##### Acceptance Criteria

1. THE Style_Picker SHALL present the four style presets `editorial`, `corporate`, `technical`
   and `minimal` as a 2-by-2 grid of selectable cards, each card carrying that preset's name and
   a rendered page image of that theme presented at the rendered page's own aspect ratio and at
   a rendered width of at least 240 CSS pixels, and SHALL hold exactly one preset selected at
   every instant the grid is presented.
2. THE Style_Picker SHALL derive each thumbnail from a page the Docx_Renderer emitted against
   that preset's theme document and the Pdf_Converter converted, rendered with a null context
   carrying no snapshot data, SHALL require that sample page to exercise a heading style, body
   prose and a data table of that theme, SHALL record alongside each produced image the digest
   of the theme document that image derives from, and SHALL present an image regenerated through
   that same path whenever a theme document's digest differs from the digest recorded alongside
   that theme's image, so that a thumbnail is evidence of the theme the Docx_Renderer emits
   against rather than decoration, and carries no figure a snapshot did not produce.
3. THE Style_Picker SHALL offer no control that selects a preset from names alone in place of
   the grid, because a theme is a visual decision and a name gives a consultant nothing to
   decide with.
4. WHEN a consultant selects a preset card, THE Style_Picker SHALL indicate that selection with
   a `--ring` outline and a `--primary` check on that card, SHALL expose that card's selected
   state programmatically to assistive technology, and SHALL convey that selection through no
   colour difference alone.
5. THE Style_Picker SHALL present the design tuning controls criterion 7.2 declares below the
   preset grid.
6. WHEN a consultant presses an arrow key with focus inside the preset grid, THE Style_Picker
   SHALL move focus to the adjacent card in the pressed direction, SHALL indicate the focused
   card with a visible `--ring` focus outline, and SHALL treat a keyboard confirmation on the
   focused card as a selection of that preset, so that a preset is choosable without a pointer.
7. THE Style_Picker SHALL give each thumbnail image a text alternative naming that preset and
   describing that theme's heading typography, table treatment and density in words, so that a
   consultant who cannot see the image chooses a preset from the description rather than from
   the preset's name.
8. IF a preset's page image is absent, or the digest recorded alongside that image differs from
   the digest of the theme document currently shipped, THEN THE Style_Picker SHALL treat that
   image as unavailable, SHALL present that card carrying the preset name, that preset's text
   alternative and a statement that the page image is unavailable, SHALL keep that card
   selectable, and SHALL substitute no name-only control for the grid.

#### Requirement 14: The HTML preview is honest about what it is

**User Story:** As a consultant, I want to know which preview I can trust, so that I do not
promise a client a document that paginates differently.

##### Acceptance Criteria

1. THE Preview_Canvas SHALL emit its preview from the same document AST the Docx_Renderer emits
   from for the same template version, through the Html_Emitter, and SHALL hold no layout
   definition of its own, so that no third layout definition exists.
2. THE Preview_Canvas SHALL display a label identifying the canvas as a preview on every render
   of that canvas, SHALL keep that label visible whenever any part of the canvas is visible,
   SHALL require no pointer hover, no focus and no expansion to reveal that label, SHALL offer
   no control that dismisses it, and SHALL retain it across scrolling and across every
   re-render.
3. THE Preview_Canvas SHALL display no page number, no page count, no indicator stating a page
   position within a total, and no marker asserting where a page break falls, except a marker
   representing a `page_break` block the definition declares, which SHALL carry no page number
   and no page count — because the Html_Emitter determines no pagination and a wrong page count
   is a promise the document breaks.
4. THE Preview_Canvas SHALL state, in text visible without hover, focus or expansion, that the
   preview approximates pagination, table column widths and font metrics, naming all three, and
   that the rendered `.pdf` is the delivered result.
5. WHEN a consultant activates the render-real-preview action, THE Web_App SHALL compile the
   definition currently composed in the wizard against the most recent snapshot of a completed
   run owned by the signed-in user for the selected connected subscription whose `status` is
   `active`, SHALL run the Docx_Renderer and then the Pdf_Converter over that compilation, and
   SHALL present the resulting `.pdf` inline.
6. THE Web_App SHALL present the rendered `.pdf` of criterion 14.5 as the only surface
   permitted to state that the result is what the consultant will receive, and SHALL present no
   statement on the Preview_Canvas, the Template_Wizard or the Report_Detail_View that an HTML
   rendering is what the consultant will receive.
7. IF no snapshot exists for the selected connected subscription, THEN THE Web_App SHALL state
   that a completed run is required before a real preview can be rendered, SHALL present the
   render-real-preview action in a disabled state carrying that reason, SHALL start no render,
   and SHALL render no preview from fabricated or placeholder data.
8. WHILE a render-real-preview run is in progress, THE Web_App SHALL indicate that the run is
   in progress, SHALL keep the Preview_Canvas and the label of criterion 14.2 displayed, and
   SHALL ignore every further activation of the render-real-preview action until that run
   reaches a result.
9. IF a render-real-preview run fails, or does not present a `.pdf` within 180 seconds of
   activation, THEN THE Web_App SHALL state that the real preview was not produced and name the
   stage that failed as compilation, `.docx` rendering or `.pdf` conversion, SHALL present no
   `.pdf`, and SHALL leave the Preview_Canvas and its label displayed and unchanged.
10. WHEN the Web_App presents the rendered `.pdf` of criterion 14.5, THE Web_App SHALL present
    alongside it the `snapshot_id` of the snapshot it rendered from, that snapshot's collection
    window with its UTC offset, and the template version it compiled, and SHALL state that the
    figures shown are those of that completed run and that the delivered result it demonstrates
    is pagination, table column widths and font metrics.
---

### Section C — Compilation, the AST and the figure ledger

This section is where the product invariant becomes structural. Every criterion below exists
so that **no numeric can reach a document without provenance**, enforced by the shape of the
data rather than by a rule a reviewer has to remember.

#### Requirement 15: The document AST, whose only numeric leaf is a figure

**User Story:** As a reviewer, I want a number without provenance to be impossible to
represent, so that provenance is a property of the type rather than a convention.

##### Acceptance Criteria

1. THE AST_Model SHALL define a closed set of node types, being the block types criterion 6.1
   declares together with the inline node types those block types emit, and IF a compiled tree
   carries a node whose type is absent from that set, THEN THE Block_Compiler SHALL raise an
   error naming that node's path and that type, and SHALL emit no document AST.
2. THE AST_Model SHALL define a figure node carrying `value` as a fixed-precision decimal
   string, `unit`, `snapshot_path`, `formatted`, `fidelity_tier`, `estimator` where the value the
   figure carries is an estimate, and `derived_from` together with `formula` where the value the
   figure carries is computed from more than one collected value; and SHALL constrain `value` to
   an optional leading `-`, one or more decimal digits, and at most one `.` followed by one or
   more decimal digits, admitting no exponent notation, no leading `+`, no thousands separator,
   no surrounding whitespace, no empty string, and no non-finite designation.
3. THE AST_Model SHALL define the figure node as the only node type declaring a field that
   carries a numeric quantity, SHALL declare every figure position as admitting the figure node
   type alone, and SHALL declare no other node type field admitting an `int`, a `float`, a
   `Decimal` or a decimal string, so that a bare string or a `Decimal` in a figure position is
   rejected by the declaration rather than by review.
4. IF a compiled tree carries an `int`, a `float`, a `Decimal`, a bare string, or any value that
   is not a figure node in a position the AST_Model declares as a figure position, THEN THE
   Block_Compiler SHALL raise an error at that node's construction naming that node's path in
   the tree and the offending type, SHALL emit no document AST and no partial document AST, SHALL
   record no Figure_Ledger entry, and THE Agent_Runtime SHALL report the terminal code
   `COMPILE_FAILED` and SHALL write no report artifact.
5. THE AST_Model SHALL define every figure node's `snapshot_path` as a non-empty path addressing
   exactly one value within the snapshot the compilation ran against, and SHALL require that
   path to be derived from that value's position in the snapshot rather than supplied
   independently of it.
6. THE AST_Model SHALL define a text node as carrying literal characters and no figure, and
   SHALL define a paragraph node as carrying an ordered sequence of text nodes and figure
   nodes, so that a sentence mixing prose and figures is representable without a figure losing
   provenance.
7. THE Block_Compiler SHALL assign every AST node a path derived solely from that node's
   structural position, being the enclosing block `id` and the zero-based ordinal of the node
   within each enclosing node's declared child order, so that every path is unique within one
   compiled tree and identical across two compilations of one template version against one
   snapshot.
8. THE Block_Compiler SHALL accept as a figure node's `value` only the snapshot value that
   figure's `snapshot_path` addresses, and SHALL contain no operation that accepts a numeric
   value produced by a language model, a value supplied in a template definition, or a value
   computed from model-authored text, and places that value in a figure position.
9. THE AST_Model SHALL define a table node as carrying a table identity, an ordered list of
   column headers each carrying a column key, and an ordered list of rows each carrying a row
   key and an ordered list of cells, SHALL require each column key to be unique within one table
   node and each row key to be unique within one table node, so that a cell is addressable by
   exactly one instance of the triple criterion 21.3 declares.
10. WHEN the Block_Compiler compiles a template version against a snapshot, THE Block_Compiler
    SHALL emit a document AST whose canonical digest, computed by canonicalizing the tree with
    RFC 8785 (JCS) and taking the SHA-256 digest of the UTF-8 encoded bytes of that canonical
    form rendered as 64 lowercase hexadecimal characters, is equal for two compilations over
    that same pair, so that the compile stage is replayable.
11. IF a figure node's `snapshot_path` addresses no value in the snapshot the compilation ran
    against, addresses more than one value, or addresses a value whose fixed-precision decimal
    string differs from that figure node's `value`, THEN THE Block_Compiler SHALL raise an error
    naming that node's path and that `snapshot_path`, SHALL emit no document AST, and THE
    Agent_Runtime SHALL report the terminal code `COMPILE_FAILED` and SHALL write no report
    artifact, so that a declared provenance that does not resolve is a failure rather than an
    unchecked claim.
12. IF a static guard over the AST_Model declarations finds a node type other than the figure
    node declaring a field that admits an `int`, a `float`, a `Decimal` or a decimal string, or
    finds a figure position admitting any type other than the figure node type, THEN THE
    Build_Pipeline SHALL fail naming that node type and that field, so that the
    only-numeric-leaf claim is asserted at build time rather than by inspection of one
    compilation.
13. THE AST_Model SHALL define every figure node field as immutable after that node's
    construction, and IF an assignment to a constructed figure node's field is attempted, THEN
    THE AST_Model SHALL raise an error naming that node's path and that field, and THE
    Docx_Renderer, THE Html_Emitter and THE Chart_Renderer SHALL construct no figure node, so
    that no stage after compilation substitutes a value into a figure position.

#### Requirement 16: Block compilation

**User Story:** As a consultant, I want each block to emit what the palette said it emits, so
that a composed report is predictable before running it.

##### Acceptance Criteria

1. WHEN the Block_Compiler compiles a `kpi_row`, a `resource_table`, a `top_n_table`, a
   `capacity_vs_usage`, a `timeseries_chart`, a `distribution_chart` or a `comparison_delta`
   block, THE Block_Compiler SHALL emit every numeric quantity in that block as a figure node,
   and SHALL emit no numeric quantity in that block as a text node.
2. WHEN the Block_Compiler compiles a `resource_table` or a `top_n_table` block, THE
   Block_Compiler SHALL emit one row per resource in that block's resolved scope, ordered as
   criterion 3.6 declares, up to a maximum of 500 rows, and SHALL emit a final row stating as a
   figure node the count of resources that maximum omitted, so that a truncated table states its
   own truncation rather than presenting a partial list as a complete one.
3. WHEN the Block_Compiler compiles a `gaps_and_coverage` block, THE Block_Compiler SHALL emit
   the `collection_log` entries of the snapshot grouped by `gap_type`, ordered by `gap_type`
   ascending in Unicode code-point order and within each group by resource id ascending in
   Unicode code-point order, each group naming the affected resources and stating that group's
   entry count as a figure node, SHALL emit those entries as recorded rather than as an absence
   of data, and WHERE that snapshot's `collection_log` carries zero entries, THE Block_Compiler
   SHALL emit an explicit row stating that no gaps were recorded.
4. WHEN the Block_Compiler compiles a `verification_record` block, THE Block_Compiler SHALL
   emit the snapshot provenance and the collection record available before rendering, being the
   `snapshot_id`, the collection window with the resolved UTC offset, the grain, the resource
   count, the gap count, the count of resources carrying each `fidelity_tier` value present in
   that snapshot and the raw-archive completeness flag, and SHALL emit the resource count, the
   gap count and each `fidelity_tier` count as figure nodes.
5. THE Block_Compiler SHALL emit, inside a `verification_record` block, no verification status,
   no verified-figure count, no finding count and no other claim of the rendered document's own
   verification outcome, because that outcome is computed from the rendered document and
   therefore does not exist at compile time.
6. WHEN the Block_Compiler compiles an `appendix_methodology` block, THE Block_Compiler SHALL
   emit the period specification the pinned template version declared, the grain requested, the
   grain the snapshot records, the aggregation method for each statistic that report carries, the
   estimator label for each estimated statistic read from the Figure_Ledger, and the meaning of
   each `fidelity_tier` present in that snapshot, and SHALL compose no estimator label of its
   own.
7. WHEN the Block_Compiler compiles a `comparison_delta` block, THE Block_Compiler SHALL
   compile that block from the snapshots pinned by the two completed runs that block's config
   names, SHALL emit each delta as a figure node whose value is the later run's value minus the
   earlier run's value, SHALL emit both `snapshot_id` values in that block, and SHALL make no
   Azure call.
8. WHERE a resource's `fidelity_tier` in one snapshot of a `comparison_delta` block differs
   from that resource's `fidelity_tier` in the other snapshot, THE Delta_Compiler SHALL emit
   that row marked as not comparable, SHALL emit no delta figure for that row, and SHALL record
   the advisory finding `fidelity_not_comparable`.
9. WHEN the Block_Compiler compiles a `page_break` block, THE Block_Compiler SHALL emit a page
   break node carrying no figure, and WHEN the Block_Compiler compiles a `heading` or
   `rich_text` block, THE Block_Compiler SHALL emit text nodes carrying no figure.
10. WHEN the Block_Compiler compiles a `row` block, THE Block_Compiler SHALL emit a layout
    container node carrying that row's declared column count and each column's compiled child
    blocks in declared order.
11. WHERE a block's resolved scope contains zero resources, THE Block_Compiler SHALL emit that
    block carrying the explicit row criterion 3.7 declares, SHALL emit zero figure nodes for
    that block, and SHALL report no error code for that block as criterion 3.8 declares, so that
    a block whose filter matched nothing is present in the document rather than absent from it.
12. IF the Block_Compiler cannot compile a block whose resolved scope contains at least one
    resource, THEN THE Agent_Runtime SHALL report the terminal code `COMPILE_FAILED` naming
    that block's `id` and `type`, SHALL emit no partial document AST, and SHALL write no report
    artifact.
13. WHERE a definition's cover-page flag is true, WHEN the Block_Compiler compiles a `cover`
    block, THE Block_Compiler SHALL emit the pinned template version's report title, the
    connected subscription's display name, and that run's resolved local start date, local end
    date and resolved UTC offset, and SHALL emit no metric value in that block.
14. WHEN the Block_Compiler compiles a `timeseries_chart` or a `distribution_chart` block, THE
    Block_Compiler SHALL emit a chart node carrying that chart's type, its title, its unit, an
    `encoding` value of `categorical` where that chart's series are peers and `sequential` where
    that chart encodes one ordered quantity, and an ordered list of series each carrying a stable
    series key and its plotted values as figure nodes, so that no consumer infers the encoding
    from the series count.
15. WHERE a resource in a `comparison_delta` block's resolved scope is present in one of that
    block's two snapshots and absent from the other, THE Delta_Compiler SHALL emit that row
    stating the snapshot the resource is absent from, SHALL emit no delta figure for that row,
    and SHALL emit that row rather than omitting it.

#### Requirement 17: The figure ledger is the render context

**User Story:** As a reviewer, I want the ledger and the document to be incapable of
disagreeing, so that verification compares a document against the thing that produced it.

##### Acceptance Criteria

1. THE Figure_Ledger SHALL record every figure node of exactly one compiled document AST, keyed
   by that node's AST path as criterion 15.7 declares, and SHALL hold an entry count equal to
   that tree's figure node count.
2. THE Figure_Ledger SHALL hold, for each key, a reference to the same figure node object the
   document AST holds at that path, and THE Docx_Renderer, THE Html_Emitter and THE
   Chart_Renderer SHALL read each figure through that referenced object, so that the ledger and
   the render context are one object rather than two structures that can drift.
3. THE Figure_Ledger SHALL contain no entry whose key names a path absent from the document AST,
   THE document AST SHALL contain no figure node whose path is absent from the Figure_Ledger,
   and THE Figure_Ledger SHALL contain no figure originating in another compilation or another
   snapshot.
4. WHEN the Figure_Ledger records a figure, THE Figure_Ledger SHALL expose `value`, `unit`,
   `snapshot_path`, `formatted`, `estimator` where present, `resource_id` where the figure
   describes one resource, `metric` where the figure describes one metric, the statistic name,
   the collection window and `fidelity_tier` as the fields of the referenced figure node, and
   SHALL store no second copy of any of those values.
5. THE Figure_Ledger SHALL record, for every figure emitted into a table cell, the table anchor
   criterion 21.3 declares on that figure's existing entry keyed by its AST path, and SHALL
   record that anchor in no separate collection.
6. WHEN the Agent_Runtime completes a render, THE Agent_Runtime SHALL serialize the Figure_Ledger
   once with its entries ordered by AST path and canonicalized as RFC 8785 (JCS) declares, SHALL
   write that serialization as an artifact alongside the rendered document, and SHALL record that
   artifact's SHA-256 digest on the verification result, so that a later re-verification reads
   the same ledger the render used.
7. FOR ALL compilations of one template version against one snapshot, THE Figure_Ledger SHALL
   record an identical set of entries carrying identical keys, identical field values and
   identical `formatted` values, and SHALL produce an identical serialization and an identical
   digest, so that ledger identity depends on neither traversal order nor iteration order.
8. THE Figure_Ledger SHALL create each entry during the single traversal in which the
   Block_Compiler creates that figure node, and SHALL create no entry by copying a figure node,
   deep-copying a subtree, serializing and reparsing a figure, re-formatting a value or
   re-reading the snapshot for a figure node the document AST already holds, because a parallel
   walk is a second structure and two structures can disagree.
9. WHEN the agent test suite replaces one figure node's `formatted` value through the document
   AST at a given path, THE Figure_Ledger SHALL report that replaced value at that key, and WHEN
   the agent test suite replaces one entry's `formatted` value through the Figure_Ledger, THE
   document AST SHALL report that replaced value at that path, so that the one-object identity
   of criterion 17.2 is demonstrated rather than asserted and a copied ledger fails the test.
10. IF the Figure_Ledger's key set differs from the set of figure node paths in the compiled
    document AST, or if two figure nodes of one compiled document AST resolve to one key, THEN
    THE Agent_Runtime SHALL report the terminal code `COMPILE_FAILED` naming each differing or
    colliding path, and SHALL write no report artifact.
11. WHILE a render of one compilation is in progress, THE Docx_Renderer, THE Html_Emitter and
    THE Chart_Renderer SHALL read every figure from that compilation's in-memory Figure_Ledger
    object, and SHALL read no figure from a written ledger artifact, from a deserialized ledger
    or from a ledger rebuilt for that render.

#### Requirement 18: The Formatter is the only path from a value to a display string

**User Story:** As a consultant, I want the number in the document and the number the verifier
checks to come from one function, so that verification cannot fail on a report that is correct.

##### Acceptance Criteria

1. THE Formatter SHALL be the only operation in the Agent_Runtime that produces a `formatted`
   string for a figure, and THE Agent_Runtime SHALL contain no other operation that converts a
   figure's `value` into a display string, because the Verifier matches document tokens against
   `formatted` values and a second formatting path fails verification on a report that is
   correct.
2. THE Docx_Renderer, THE Html_Emitter, THE Chart_Renderer and THE Web_App SHALL emit each
   figure's display string by reading that figure's `formatted` value from the Figure_Ledger
   unchanged, SHALL compose no display string from a figure's `value`, and SHALL apply to that
   string no rounding, no truncation, no separator substitution and no unit, sign or caveat
   decoration of their own.
3. WHEN the Formatter formats a value, THE Formatter SHALL take the fractional-digit count from
   the Metric_Catalog entry for that value and the thousands separator and the decimal separator
   from the pinned template version's number format, SHALL quantize that value to that
   fractional-digit count rounding half away from zero, and SHALL apply that one rounding mode to
   every value, every unit and every number format.
4. THE Formatter SHALL produce an identical `formatted` string for every call carrying one
   value, one unit, one Metric_Catalog fractional-digit count, one estimator label and one
   number format, in any process and on any machine, so that a `formatted` string recorded at
   render time is reproducible when that stored document is re-verified later.
5. THE Formatter SHALL perform every arithmetic, quantization and rounding operation on
   `Decimal` values, SHALL contain no `float` on the path from a snapshot value to a `formatted`
   string, and SHALL construct no intermediate binary floating-point number while parsing a
   value or while composing a `formatted` string.
6. WHEN the Formatter formats a statistic whose `estimator` marks the value as estimated, THE
   Estimator_Labeller SHALL produce one label naming the statistic, the estimator and the source
   grain, THE Formatter SHALL include that label in the `formatted` string, and THE Figure_Ledger
   SHALL record that label on that figure alongside that figure's `estimator`, so that every
   consumer displays a label it read rather than a label it composed.
7. THE Formatter SHALL produce, for a figure whose `estimator` marks the value as estimated, no
   `formatted` string carrying a bare percentile designation, being a percentile designation
   unaccompanied by the estimator label criterion 18.6 declares, in the form of the letter `p` in
   either case followed only by digits and an optional fractional part, or the word `percentile`
   standing alone.
8. THE Web_App SHALL render an estimator caveat by displaying the ledger's `formatted` string
   or the ledger's recorded estimator label verbatim, SHALL compose no estimator label and no
   percentile designation of its own, and SHALL apply no locale-dependent numeric formatting to
   a figure's `value` or to a `formatted` string.
9. IF the Formatter is given a value whose type is neither a `Decimal` nor a fixed-precision
   decimal string, THEN THE Formatter SHALL produce no `formatted` string, SHALL raise an error
   naming the offending figure's AST path and the rejected type, and THE Agent_Runtime SHALL
   report the terminal code `COMPILE_FAILED` naming that AST path and SHALL write no report
   artifact.
10. WHEN the Formatter formats a value carrying a unit, THE Formatter SHALL include that unit's
    presentation as the Metric_Catalog declares it within the `formatted` string, so that a
    consumer appending a unit of its own would break the exact-equality comparison requirement
    27 declares.
11. IF the Metric_Catalog declares no fractional-digit count for a value's metric or derived
    statistic, THEN THE Formatter SHALL produce no `formatted` string, SHALL apply no default
    fractional-digit count, SHALL raise an error naming that metric, that resource type and the
    offending figure's AST path, and THE Agent_Runtime SHALL report the terminal code
    `COMPILE_FAILED` and SHALL write no report artifact.

#### Requirement 19: Narrative prose carries no number the compiler did not place

**User Story:** As a consultant accountable for the numbers, I want the model to write the
commentary and none of the measurements, so that a sentence I sign traces to the snapshot.

##### Acceptance Criteria

1. WHEN the Agent_Runtime compiles an `executive_summary` block, THE Agent_Runtime SHALL supply
   the language model with, and with only, the following material drawn from that report: each
   figure of the Figure_Ledger carried as its `formatted` string together with that figure's
   `unit`, statistic name, `resource_id` where present, collection window, `fidelity_tier` and
   estimator label where present; the report's compiled aggregate table; and the
   `collection_log` gap counts grouped by `gap_type`.
2. THE Agent_Runtime SHALL supply no raw metric series to a language model, SHALL expose no
   operation to a language model that returns a raw metric series, and SHALL expose no operation
   to a language model that accepts a numeric value from that language model and writes that
   value into a document, into a figure position, into a `formatted` string or into a snapshot,
   where a raw metric series is an ordered sequence of per-timestamp metric values or any set of
   numeric values absent from the Figure_Ledger.
3. WHEN the Block_Compiler places model-authored prose in the document AST, THE Block_Compiler
   SHALL place that prose as text nodes carrying the model's returned characters unaltered,
   SHALL place every numeric the document states as a measurement as a figure node drawn from
   the Figure_Ledger, and SHALL apply no rewriting, stripping, rounding or substitution of a
   numeric string the model returned, so that a numeric the compiler did not place reaches the
   Verifier rather than being silently removed.
4. IF model-authored prose contains a numeric string that is absent from the Figure_Ledger's
   `formatted` values and absent from the static-text allowlist, THEN THE Verifier SHALL record
   the blocking finding `unmatched_prose_token` naming that string and the location of the
   paragraph carrying it, THE Verifier SHALL fail the verification, THE Agent_Runtime SHALL
   report the terminal code `VERIFICATION_FAILED`, THE Agent_Runtime SHALL emit no `report_file`
   event for that run, and THE Web_App SHALL present no download control for that run.
5. THE Agent_Runtime SHALL treat the Verifier as the enforcement of criterion 19.4, and SHALL
   treat no instruction, system prompt, tool description or model configuration given to a
   language model as that enforcement, so that a report is withheld by a check on the rendered
   document rather than by a request made of the model.
6. WHEN the Agent_Runtime renders a document, THE Verifier SHALL apply the prose masking stages
   requirement 28 declares to every paragraph of that document irrespective of which block
   authored it, and SHALL complete that pass before the Agent_Runtime emits any `report_file`
   event for that run.
7. WHEN the agent test suite enumerates every operation the Agent_Runtime exposes to a language
   model, THE Agent_Runtime SHALL expose zero operation whose return value carries a
   per-timestamp metric value or a numeric value absent from the Figure_Ledger, and zero
   operation declaring a parameter whose value reaches a figure position, a `formatted` string
   or a snapshot.
8. THE Agent_Runtime SHALL provide no configuration value, template setting, run parameter,
   prompt instruction or interface control that disables the prose masking pass, that downgrades
   an `unmatched_prose_token` finding to advisory, or that permits delivery of a document whose
   verification status is fail.

---

### Section D — Rendering

#### Requirement 20: DOCX emission against a styles-only theme

**User Story:** As a consultant, I want the delivered document to be a properly styled Word
file, so that a client reads a report rather than a data dump.

##### Acceptance Criteria

1. WHEN the Agent_Runtime enters the rendering phase of a run, THE Docx_Renderer SHALL emit the
   `.docx` by walking the compiled document AST once with `python-docx` against the theme
   document the pinned template version's style preset names, and SHALL read the document AST as
   its only source of content.
2. THE Docx_Renderer SHALL construct the `.docx` from the document AST, SHALL use no
   document-templating library that substitutes placeholders into a document, including
   `docxtpl`, THE Agent_Runtime SHALL accept no user-supplied `.docx` as a template, and THE
   Web_App SHALL expose no operation that accepts an uploaded `.docx` as a template.
3. WHEN the Docx_Renderer emits a figure node, THE Docx_Renderer SHALL write that figure's
   `formatted` string in full and unaltered as exactly one run carrying the theme's `Figure`
   character style, SHALL write no other character inside that run, and SHALL apply that
   wrapping at every position the document AST places a figure node, including a prose
   paragraph, a heading, a data table cell, a cover field and a chart companion table cell, so
   that the Token_Extractor locates every figure without re-parsing prose.
4. THE Docx_Renderer SHALL emit each paragraph and each table against a style the theme document
   declares, SHALL apply each such style by the name the theme declares, and SHALL define no
   inline character, paragraph or table formatting that duplicates a style the theme document
   already declares.
5. IF the theme document does not declare a style the compiled AST references, THEN THE
   Docx_Renderer SHALL report the terminal code `RENDER_FAILED` naming the theme and every
   missing style rather than only the first, SHALL write no report artifact, and SHALL leave no
   partial artifact object.
6. WHEN the Docx_Renderer emits a `row` block, THE Docx_Renderer SHALL emit that row as one
   layout table carrying exactly the row's declared column count of 2 or 3, one cell per column,
   no visible border on any edge, and each child block emitted into the column that child
   declares in the order the document AST declares.
7. THE Docx_Renderer SHALL emit the blocks, the child blocks of each `row` block and the page
   breaks in the order the document AST declares, and SHALL apply no reordering derived from
   block type, block content length or figure count.
8. WHEN the Docx_Renderer emits one document AST twice against one theme document, THE
   Docx_Renderer SHALL produce two `.docx` files whose digests are identical after excluding the
   document's created and last-modified timestamps, and SHALL derive no emitted content from
   wall-clock time, host locale, hostname, environment variable values or filesystem enumeration
   order.
9. IF `.docx` emission fails for a reason other than a missing style, THEN THE Agent_Runtime
   SHALL report the terminal code `RENDER_FAILED` carrying failure text scrubbed of every Azure
   credential value and every run-scoped progress token, SHALL attempt emission no more than
   once for that run, SHALL write no report artifact, and SHALL leave no partial artifact object.
10. THE Docx_Renderer SHALL write every numeric-bearing string it emits from a Figure_Ledger
    entry's `formatted` value or from the pinned template version's static text, and SHALL
    compose, round, re-scale, re-unit or otherwise reformat no numeric value, so that the
    Formatter remains the only place a figure becomes a string.
11. WHEN the Docx_Renderer has emitted every block the document AST declares, THE Docx_Renderer
    SHALL write that completed document as one report artifact object, so that a partially
    emitted document is never written as a report artifact.
12. IF the document AST presents a value in a text position that carries a numeric quantity and
    is not a figure node, THEN THE Docx_Renderer SHALL report the terminal code `RENDER_FAILED`
    naming that node's AST path, SHALL write no report artifact, and SHALL emit that value into
    no document.

#### Requirement 21: Table identity and the anchor contract

**User Story:** As a reviewer, I want the verifier to know which tables carry data, so that the
table check excludes layout by construction rather than by guessing.

##### Acceptance Criteria

1. WHEN the Anchor_Writer emits a data table, THE Anchor_Writer SHALL write that table's identity
   into the table's Alt Text at `w:tblPr/w:tblCaption` exactly once, as a non-empty string of at
   most 255 characters equal to the table identity the Anchor_Writer records in the Figure_Ledger
   for that table.
2. WHEN the Anchor_Writer emits a layout table for a `row` block, THE Anchor_Writer SHALL write
   no `w:tblCaption`, no header row and no row key on that table, so that the table-verification
   pass excludes every layout table by construction rather than by inspecting borders or counting
   cells.
3. WHEN the Anchor_Writer emits a figure into a data table cell, THE Anchor_Writer SHALL record
   in the Figure_Ledger the anchor triple carrying that table's identity, that row's row key and
   that column's column key, mapped to that figure's `formatted` string, and SHALL record exactly
   one anchor for that triple.
4. THE Anchor_Writer SHALL emit each data table's header row as that table's first row, carrying
   for each column a non-empty header text of at most 255 characters that is unique within that
   table and exactly equal to the string that column's column key resolves by, so that the
   Verifier resolves a column by header text rather than by column position.
5. THE Anchor_Writer SHALL emit each data table's row key as the concatenated text of that row's
   cell in one designated key column, identified by that column's header text and occupying the
   same column in every data row of that table, as a non-empty string of at most 255 characters
   that is unique within that table, so that the Verifier resolves a row by row key rather than
   by row position.
6. THE Anchor_Writer SHALL emit a table identity that is unique within one rendered document.
7. IF two data tables in one rendered document carry the same table identity, THEN THE Verifier
   SHALL record the blocking finding `duplicate_table_anchor` naming that identity, and SHALL
   fail the verification.
8. THE Anchor_Writer SHALL record an anchor in the Figure_Ledger for every figure emitted into a
   data table cell, and SHALL record no anchor for a value emitted outside a data table,
   including a value emitted in a layout table cell, a heading, a paragraph, a header or a
   footer.
9. THE Anchor_Writer SHALL derive each table identity from that table node's AST node path alone,
   so that two renders of one document AST against one theme document carry identical table
   identities, and SHALL derive no table identity from emission order, elapsed time or any value
   that differs between two renders of that AST.
10. WHEN the Anchor_Writer emits a data table inside a cell of a layout table, THE Anchor_Writer
    SHALL write that data table's own identity into that data table's `w:tblPr/w:tblCaption`, so
    that a data-bearing child of a `row` block is checked while its enclosing layout table
    remains excluded.
11. WHEN the Anchor_Writer emits a data table carrying zero figures, THE Anchor_Writer SHALL
    record that table's identity in the Figure_Ledger carrying zero anchors, so that the Verifier
    resolves that table's identity against the Figure_Ledger and reports no unexpected-table
    finding for a data table the compiler emitted without a figure.

#### Requirement 22: Charts in the document carry their data

**User Story:** As a consultant, I want a chart in the document to be checkable, so that an image
cannot quietly disagree with the numbers beside it.

##### Acceptance Criteria

1. WHEN the Chart_Renderer emits a chart into the `.docx`, THE Chart_Renderer SHALL emit exactly
   one static chart image and exactly one companion data table, and SHALL emit every plotted point
   of every plotted series into that table as a figure whose cell text is that point's
   `formatted` string as the Figure_Ledger carries it, applying no sampling, no thinning and no
   re-rounding of the plotted set.
2. THE Chart_Renderer SHALL emit the companion data table as a data table carrying a
   `w:tblCaption` identity derived deterministically from that chart node's AST path, SHALL emit
   that table in body order immediately after its chart image with no other block between them,
   and SHALL write that same identity into the chart image's alternative text, so that the
   Verifier pairs an image with its table by identity rather than by proximity and so that the
   companion table is checked by the anchored-equality pass of requirement 27.
3. WHEN the Chart_Renderer emits a chart image, THE Chart_Renderer SHALL compute that chart's
   chart data hash as the SHA-256 digest over the ordered sequence of its plotted points, each
   point contributing its series stable key, its x key and its plotted decimal string exactly as
   the Figure_Ledger carries it, in plotted order, and SHALL record that digest both on the chart
   node and in the sidecar accompanying the embedded image, so that one plotted set yields one
   digest in every render and on every machine.
4. IF an embedded chart image's sidecar chart data hash differs from the chart data hash recorded
   on that chart's node, THEN THE Verifier SHALL record the blocking finding `chart_hash_mismatch`
   and SHALL fail the verification.
5. IF a chart node in the document AST has no companion data table in the rendered document, THEN
   THE Verifier SHALL record the blocking finding `chart_table_missing` and SHALL fail the
   verification.
6. THE Chart_Renderer SHALL plot every value from the Figure_Ledger, SHALL compute no plotted
   value from a snapshot value a second time, and SHALL apply to a plotted decimal string no
   arithmetic other than the layout scaling that positions a mark, which is neither hashed nor
   emitted as text.
7. THE Chart_Renderer SHALL select each chart's palette from that chart node's declared encoding,
   SHALL colour a chart whose series are peers from the categorical tokens `--cat-1` through
   `--cat-5`, SHALL colour a chart encoding one ordered quantity from the sequential preset ramp
   `--chart-1` through `--chart-5`, SHALL colour no chart whose series are peers from that ramp
   because the ramp varies in lightness alone and so asserts an order peer series do not carry,
   and SHALL derive the palette choice from neither the series count nor the chart type.
8. THE Chart_Renderer SHALL assign a categorical colour by a stable key that is the metric key for
   a metric series and the resource identifier for a resource series, SHALL derive no colour from
   a series' index in an array, and SHALL assign one stable key the same token in every chart and
   every delta table of one report, so that one metric and one resource carry one colour across
   every chart of one report.
9. WHERE a chart would carry more than 5 categorical series, THE Chart_Renderer SHALL plot the 4
   largest series by that chart node's declared ordering statistic, SHALL break a tie on that
   statistic by ascending stable key, SHALL aggregate every remaining series into one series
   labelled as other and coloured from `--cat-other`, and SHALL emit into the companion data table
   exactly the series it plotted including that aggregated series, so that the image, the table
   and the chart data hash describe one plotted set.
10. THE Chart_Renderer SHALL emit a direct label for every plotted series at that series' line end
    or on that series' bar, SHALL additionally distinguish every line series by marker shape and
    by dash pattern, SHALL additionally distinguish every bar, column and heatmap series by a
    direct value label, and SHALL distinguish no series by colour alone.
11. WHEN the Chart_Renderer emits a delta, THE Chart_Renderer SHALL emit a direction glyph
    together with the magnitude carrying an explicit sign, and SHALL apply one colour token to a
    delta of either direction, so that direction is encoded by neither hue nor lightness.
12. THE Chart_Renderer SHALL apply the `--destructive` token to no chart series, no delta, no
    gridline and no utilization band, and SHALL apply no palette token that encodes a plotted
    value as good or as bad, because that token is reserved for verification failure and hard
    errors.
13. IF a chart node's plotted set contains zero values, THEN THE Chart_Renderer SHALL emit that
    chart node carrying an explicit indication that the chart carries no plotted values, SHALL
    emit its companion data table carrying the no-resources-matched row criterion 3.7 declares,
    and SHALL omit neither the chart node nor its companion data table, because a chart that
    vanished is indistinguishable in the delivered document from a chart the author never
    configured.
14. THE Chart_Renderer SHALL emit byte-identical image content for two renders of one chart node
    against one style preset, so that the chart data hash is stable across renders and the
    `.docx` byte-equality criterion 20.8 declares holds.
15. THE Chart_Renderer SHALL emit every plotted mark at a contrast ratio of at least 3:1 against
    the surface it is drawn on, SHALL exclude from strokes and from marks 2 device pixels wide or
    narrower whichever end of the sequential ramp is nearest that surface, and SHALL keep every
    pair of adjacent categorical tokens distinguishable under simulated deuteranopia, protanopia
    and tritanopia.

#### Requirement 23: PDF conversion from the produced DOCX

**User Story:** As a consultant, I want the Word file and the PDF to be the same document, so
that a client reading one and a colleague reading the other see identical numbers.

##### Acceptance Criteria

1. WHEN the Pdf_Converter produces `report.pdf`, THE Pdf_Converter SHALL convert the exact byte
   content of the `.docx` the Docx_Renderer produced for that run, and SHALL produce that `.pdf`
   from no other source — not from the document AST, not from the Figure_Ledger, not from the
   Html_Emitter's output and not from the snapshot — so that the delivered `.docx` and the
   delivered `.pdf` cannot disagree.

   This binds `report.pdf` and the Pdf_Converter, and nothing else. Criterion 23.11 admits a
   **separately named** reading copy produced by a different renderer from the Html_Emitter's
   output; that copy is never `report.pdf`, never replaces it, and is subject to 23.13's own
   check. The user story above is about the numbers a client and a colleague each read, and
   23.13 is what holds it for the third artifact — not identical pagination, which two layout
   engines cannot give and which nothing here has ever required.
2. THE Pdf_Converter SHALL perform every conversion by invoking, in headless mode, the LibreOffice
   installed in the Agent_Runtime's `linux/arm64` container image, and SHALL perform no conversion
   through a network conversion service and no conversion outside that container.
3. THE Agent_Runtime SHALL set the environment variable `LANG` to the value `C.UTF-8` for every
   conversion invocation, so that the decimal separator of the converted document is the separator
   the Formatter emitted.
4. THE Pdf_Converter SHALL pass `--norestore` on every conversion invocation.
5. THE Build_Pipeline SHALL pre-warm the LibreOffice user profile at container image build time,
   and THE Pdf_Converter SHALL use that pre-warmed profile as the user profile of every conversion
   invocation and SHALL create no user profile at run time, so that the first conversion of a
   container's life is subject to the same time limit and the same failure handling as every later
   conversion rather than reading as a flaky render.
6. IF a conversion invocation exits with a failure status, exceeds the time limit of criterion
   23.9, produces no output file, or produces an output file of zero bytes or one from which no
   page can be read, THEN THE Agent_Runtime SHALL report the terminal code
   `PDF_CONVERSION_FAILED` carrying the scrubbed failure text, and SHALL present neither a `.docx`
   download nor a `.pdf` download for that run, because a delivered pair whose halves can disagree
   is the failure this criterion prevents.
7. THE Agent_Runtime SHALL record the SHA-256 digest of the produced `.docx` and the SHA-256
   digest of the produced `.pdf` on the verification result, each digest computed over the byte
   content of the artifact stored for that run, and SHALL record both digests before presenting
   any download for that run.
8. IF the environment variable `LANG` resolves to a value other than `C.UTF-8` at the moment of a
   conversion invocation, THEN THE Agent_Runtime SHALL start no conversion invocation, SHALL report
   the terminal code `PDF_CONVERSION_FAILED` stating that the required `LANG` value was not in
   effect, and SHALL present no download for that run.
9. THE Pdf_Converter SHALL terminate any conversion invocation that has not produced an output file
   within 300 seconds of invocation, SHALL perform at most one conversion invocation per produced
   `.docx`, and SHALL apply that same limit and that same invocation count to the first conversion
   of a container's life.
10. IF the container image build finds LibreOffice absent, finds the image architecture to be other
    than `linux/arm64`, or finds the pre-warmed LibreOffice user profile absent, THEN THE
    Build_Pipeline SHALL fail that image build and SHALL publish no image, so that a cold profile
    is detected at build time rather than as a failed run.
11. THE Agent_Runtime MAY additionally produce a **styled reading copy** as a third artifact,
    rendered by the Print_Renderer from the Html_Emitter's output over the same document AST and
    the same Figure_Ledger. Criterion 23.1 continues to govern the delivered `.docx` and `.pdf`
    pair without exception: that `.pdf` SHALL remain the conversion of that `.docx`, and the
    reading copy SHALL NOT replace it, SHALL be stored under a distinct name, and SHALL be
    presented as a distinct artifact. The two PDFs are not required to paginate alike — they are
    laid out by different engines — and are required to carry identical numbers, which criterion
    23.13 is what checks.
12. THE Print_Renderer SHALL embed each chart as the vector serialisation of the **same figure**
    the Docx_Renderer embedded as a raster for that run, and SHALL draw no chart of its own, so
    that the Word file and the reading copy cannot show different charts. THE Print_Renderer SHALL
    emit **no** chart companion table, and SHALL name the figure paths it thereby omitted so that
    criterion 23.13 can exempt them.

    This criterion previously required the companion table, "so that no plotted point present in
    the `.docx` is absent from the reading copy". That reasoning applied the delivered pair's
    standard to an artifact that is not the delivered pair. Criterion 22.1 governs the `.docx`
    without exception — exactly one companion table per chart, every plotted point, no sampling
    and no thinning — and the `.docx` remains the record a figure is proven against. The reading
    copy is what a person reads: a month of daily points is thirty-one rows per resource, and a
    three-machine estate turned one readable page into four pages of a table nobody reads, in the
    one artifact whose entire purpose is that somebody reads it.

    The omitted paths are named by the Print_Renderer rather than re-derived by the Verifier,
    because the Print_Renderer is what dropped them: a Verifier inferring which figures were
    probably inside a companion table would hold a second opinion about a decision already made,
    and the two would part company the first time a chart changed shape.
13. WHEN a styled reading copy is produced, THE Verifier SHALL locate every Figure_Ledger
    `formatted` string **except those criterion 23.12 names as omitted** in that copy's extracted
    text on the same terms criterion 33.5 applies to the converted `.pdf`, and SHALL record a
    finding of type `styled_pdf_figure_missing` for each that is not located. The exemption is
    what keeps this criterion meaningful rather than absolute: without it every plotted point
    would be reported missing, and since one finding suppresses the whole copy, no reading copy
    would ever be presented. A figure that is neither omitted nor located is still a finding,
    which is the case this exists for — a numeral that wrapped, a column narrower than its
    content, a table that never reached the markup. Those findings SHALL be **advisory**: THE Agent_Runtime SHALL present no
    reading copy for a run that produced any of them, and SHALL deliver the `.docx` and `.pdf`
    pair for that run unchanged, because a document whose every figure traced and whose every gate
    passed is not withheld over the layout of a reading copy.
14. IF the styled reading copy cannot be rendered — the rendering libraries absent from the image,
    the stylesheet unable to lay the document out, or the run carrying no front matter — THEN THE
    Agent_Runtime SHALL complete that run normally, SHALL present the `.docx` and `.pdf` pair, and
    SHALL present no reading copy, so that a third artifact can never withhold the first two.
15. THE Build_Pipeline SHALL fail the image build IF the Print_Renderer cannot render a document,
    IF it executes JavaScript, or IF it cannot embed inline SVG. The second is asserted because
    the image is sized on it: a renderer with no JavaScript engine is what rules out the browser
    a chart library would require, and therefore what makes the reading copy affordable at all.

#### Requirement 24: The HTML emitter walks the same AST

**User Story:** As a consultant, I want the in-app rendering to come from the document, so that
what I read on screen is what the document says.

##### Acceptance Criteria

1. THE Html_Emitter SHALL emit its output by walking the same document AST instance the
   Docx_Renderer emits from — the tree the Block_Compiler compiled from that run's pinned
   template version and that run's snapshot — SHALL compile no second AST, SHALL emit the blocks
   in the order that AST declares, and SHALL hold no block ordering rule, no column arrangement
   rule and no layout definition of its own, so that no third layout definition exists in the
   product.
2. WHEN the Html_Emitter emits a figure, THE Html_Emitter SHALL emit that figure's `formatted`
   string exactly as the Formatter produced it, applying no rounding, no locale substitution and
   no unit transformation, together with that figure's `snapshot_path` and, where that figure's
   `estimator` marks the value as estimated, the Figure_Ledger's estimator label, as attributes of
   the emitted element; THE Html_Emitter SHALL compose no estimator label of its own and SHALL
   emit no figure lacking those attributes, so that the provenance reveal criterion 38.2 declares
   reads those attributes rather than deriving them.
3. THE Html_Emitter SHALL emit every figure in the monospace face with tabular fixed-advance
   numerals, and SHALL emit no numeral animation and no count-up transition, so that a column of
   numbers aligns and a value that changes during a stream reflows no row.
4. THE Html_Emitter SHALL emit no page number, no page count and no total-page indicator, as
   criterion 14.3 declares, because the Html_Emitter determines no pagination and a wrong page
   count is a promise the document breaks.
5. THE Html_Emitter SHALL emit each block's data table carrying the same column header text, the
   same row keys and the same cell `formatted` strings the Docx_Renderer emits for that block, in
   the same column order and the same row order, so that a reader comparing the two surfaces
   compares like with like.
6. IF a block's resolved scope contains zero resources, THEN THE Html_Emitter SHALL emit that block
   carrying the explicit no-resources-matched row criterion 3.7 declares, SHALL emit zero figure
   elements for that block, and SHALL emit that block rather than omitting it, so that a block
   matching nothing is not indistinguishable from a block that was never configured.
7. WHEN the Html_Emitter emits a `row` block, THE Html_Emitter SHALL emit that row as a container
   carrying that row's declared column count and each column's child blocks in the order the
   document AST declares, and SHALL emit no table identity and no anchor triple for that container,
   so that a layout container is not presented as a data table.
8. IF the document AST carries a node type the Html_Emitter declares no emission for, THEN THE
   Html_Emitter SHALL emit no partial rendering for that document, SHALL report an error naming
   that node type, THE Web_App SHALL present an error indicating that the in-app rendering is
   unavailable while continuing to present the verified `.pdf` as the delivered result, and THE
   Verifier SHALL record no verification finding for that failure and SHALL leave that run's
   verification status unchanged, because the Verifier reads the `.docx` alone and the in-app
   rendering is never a verification input.

---

### Section E — Verification

The verifier is the enforcement of the product invariant. Every criterion in this section is a
gate, and requirement 44 requires each blocking gate to have been observed failing.

#### Requirement 25: Verification is the delivery gate

**User Story:** As a consultant accountable for the numbers, I want an unproven document withheld,
so that the report I hand a client is one the system proved.

##### Acceptance Criteria

1. WHEN the Agent_Runtime completes a render, THE Verifier SHALL verify the rendered `.docx` whose
   digest criterion 23.7 records against the Figure_Ledger and against the snapshot the run's
   `snapshot_id` names, evaluating every gate requirements 26 through 33 declare, before the
   Agent_Runtime emits any `report_file` event for that run.
2. IF the verification result's status is fail, THEN THE Agent_Runtime SHALL emit zero
   `report_file` events for that run, THE Run_State_Machine SHALL set that run's `status` to
   `failed` with `error_code` `VERIFICATION_FAILED`, and THE Web_App SHALL present no download
   control and no artifact key for that run.
3. THE Web_App SHALL expose no route, no action and no control that returns a presigned URL for a
   rendered document belonging to a run whose verification result's status is fail or whose
   verification result is absent, and SHALL make no artifact storage call for such a run.
4. IF the Web_App receives a `report_file` event for a run for which no `verification` event
   carrying a status of pass was received earlier in that stream, THEN THE Web_App SHALL discard
   that event, SHALL present no download control, SHALL request no presigned URL for the artifact
   key that event names, and SHALL present a state indicating that the event stream violated the
   declared ordering.
5. IF the Verifier records at least one blocking finding, THEN THE Verifier SHALL set that
   verification result's status to fail, and THE Verifier SHALL set a verification result's status
   to pass only where every gate requirements 26 through 33 declare has been evaluated and zero
   blocking findings are recorded.
6. THE Verifier SHALL record every advisory finding on the verification result, each carrying a
   finding type drawn from the advisory set the Glossary declares, and SHALL derive the
   verification result's status from no advisory finding.
7. THE Verifier SHALL make no Azure API call while verifying a rendered document, other than the
   bounded drift sample of at most 25 resources requirement 34 declares.
8. THE Verifier SHALL record every blocking finding observed rather than stopping at the first,
   recording at least the first 1,000 blocking findings in document order together with the total
   observed count, so that one verification run reports every disagreement between the document
   and the snapshot.
9. THE Agent_Runtime SHALL emit `snapshot_ready` before any `verification` event, SHALL emit every
   `report_file` event after a `verification` event carrying a status of pass, and SHALL emit
   `done` as the final event of that invocation, so that the ordering criterion 25.4 relies on is
   guaranteed at the source.
10. WHEN the Verifier sets a verification result's status to fail, THE Agent_Runtime SHALL persist
    that verification result carrying every recorded blocking finding and every recorded advisory
    finding through the Verification_Store before the Agent_Runtime emits the terminal `error`
    event carrying `VERIFICATION_FAILED`, so that the Verification_Panel presents every finding
    for a run whose document was withheld.
11. IF the Verifier terminates before evaluating every gate requirements 26 through 33 declare,
    THEN THE Verifier SHALL treat that verification result's status as fail, THE Run_State_Machine
    SHALL set that run's `status` to `failed` with `error_code` `VERIFICATION_FAILED`, and THE
    Agent_Runtime SHALL emit zero `report_file` events for that run, so that an incomplete
    verification is never a delivered report.

#### Requirement 26: Numeric extraction from the rendered document

**User Story:** As a developer, I want extraction to read the document the way Word stores it, so
that a figure split across three runs is one number rather than three fragments.

##### Acceptance Criteria

1. WHEN the Token_Extractor reads a rendered `.docx`, THE Token_Extractor SHALL iterate the
   document body element and SHALL join the text of every descendant `w:t` node in document order,
   at every depth of nesting and irrespective of the element type each `w:t` node is nested inside.
2. THE Token_Extractor SHALL read the document through the body element iteration criterion 26.1
   declares, and SHALL read the document through neither the paragraph collection nor the table
   collection the document object exposes, because those collections omit content nested in
   structures those collections do not enumerate, including a nested table, a content control and
   a text box.
3. WHEN the Token_Extractor tokenizes prose, THE Token_Extractor SHALL tokenize the concatenated
   text of one paragraph, and SHALL tokenize the text of no individual run, because a single
   formatted number is routinely stored as three consecutive runs and per-run tokenization splits
   that number into fragments that match nothing.
4. WHEN the Token_Extractor extracts a data table, THE Token_Extractor SHALL extract that table's
   identity from the table's Alt Text at `w:tblPr/w:tblCaption`, SHALL extract each cell's
   concatenated text, and SHALL record each extracted identity together with that table's ordinal
   position in the document, so that two data tables carrying equal identities are distinguishable
   to the Verifier.
5. THE Token_Extractor SHALL exclude from the table-verification pass every table carrying no
   `w:tblCaption`, so that a layout table is excluded by construction, and SHALL treat a table
   whose `w:tblCaption` is present but empty or contains only whitespace as carrying no
   `w:tblCaption`.
6. THE Token_Extractor SHALL extract the concatenated text of every paragraph of the document body
   and of every header part and every footer part of the document, including paragraphs inside data
   tables and layout tables, each read through the iteration criterion 26.1 declares, and SHALL
   record for each extracted paragraph which part that paragraph was read from.
7. FOR ALL rendered documents containing up to 5,000 paragraphs and up to 500 data tables, THE
   Token_Extractor SHALL extract a figure whose `formatted` string the Docx_Renderer emitted across
   more than one run as one token equal character for character to that `formatted` string, and
   SHALL extract the same tokens in the same order on every extraction of the same document, so
   that the exact equality requirement 27 asserts is reproducible.
8. WHEN the Token_Extractor joins the text of a paragraph or of a table cell, THE Token_Extractor
   SHALL insert no character between two adjacent `w:t` nodes, SHALL preserve every space character
   a `w:t` node carries, SHALL represent a tab element and a line-break element as one space
   character each, SHALL remove leading and trailing whitespace from the joined string, and SHALL
   alter no other character, so that the joined string carries the characters the Formatter
   produced.
9. THE Token_Extractor SHALL treat as one numeric token each maximal substring of a joined
   paragraph string that contains at least one digit character and is bounded by a whitespace
   character or by the start or the end of that string, SHALL treat a paragraph boundary as
   terminating a token so that no token spans two paragraphs, and SHALL record with each token the
   part, the block identifier and the paragraph ordinal within that block that the token was read
   from, so that a finding is reportable at the location criterion 28.10 declares.
10. IF the Token_Extractor cannot open the rendered `.docx`, or the opened document carries no body
    element, THEN THE Verifier SHALL set the verification result's status to fail, THE
    Run_State_Machine SHALL set that run's `status` to `failed` with `error_code`
    `VERIFICATION_FAILED`, THE Agent_Runtime SHALL emit no `report_file` event, and THE
    Agent_Runtime SHALL leave the stored `.docx` and `.pdf` objects unchanged, so that an
    unreadable document is a proven failure rather than an empty token set that passes every
    subsequent pass.

#### Requirement 27: Table figures are checked by anchored cell equality

**User Story:** As a reviewer, I want a transposed column to fail, so that a document whose numbers
are all present but attached to the wrong things is not called verified.

##### Acceptance Criteria

1. WHEN the Verifier checks a table figure, THE Verifier SHALL resolve that figure's anchor in the
   order table, then column, then row, by locating the one data table whose `w:tblCaption` identity
   is character-for-character equal to the anchor's table identity, then resolving within that table
   the one column whose header text is character-for-character equal to the anchor's column key,
   then resolving within that table the one row whose row key is character-for-character equal to
   the anchor's row key, and SHALL resolve the cell as the intersection of that resolved column and
   that resolved row.
2. WHEN the Verifier has resolved a cell, THE Verifier SHALL assert that the cell's concatenated
   text, being the concatenation criterion 26.4 declares, is character-for-character equal to the
   anchor's `formatted` string, applying no trimming of leading or trailing whitespace, no
   whitespace normalization, no case folding, no unit stripping and no re-parsing of either string
   as a number.
3. THE Verifier SHALL assert exact equality of the resolved cell as criterion 27.2 declares, and
   SHALL assert no containment of a figure's string anywhere in the document, in the resolved table
   or in the resolved cell, because a containment check passes on a document whose two columns are
   transposed and on a cell holding the anchor's string alongside further text.
4. IF a data table carrying an anchor's table identity is absent from the rendered document, THEN
   THE Verifier SHALL record the blocking finding `table_anchor_missing` naming that anchor.
5. IF the rendered document carries a data table whose identity matches no anchor in the
   Figure_Ledger, THEN THE Verifier SHALL record the blocking finding `table_anchor_unexpected`
   naming that table identity.
6. IF a column whose header text an anchor's column key names is absent from the resolved table, or
   is matched by more than one column of that table, THEN THE Verifier SHALL record the blocking
   finding `table_column_unresolved` naming that anchor, that column key and the number of columns
   matched, because a column key resolving to two columns has no single cell to compare.
7. IF a row whose row key an anchor's row key names is absent from the resolved table, or is matched
   by more than one row of that table, THEN THE Verifier SHALL record the blocking finding
   `table_row_unresolved` naming that anchor, that row key and the number of rows matched.
8. IF a resolved cell's concatenated text differs from the anchor's `formatted` string, THEN THE
   Verifier SHALL record the blocking finding `table_cell_mismatch` naming the table identity, the
   row key, the column key, the expected string verbatim and the observed string verbatim.
9. THE Verifier SHALL resolve a column by exact equality of header text and a row by exact equality
   of row key, and SHALL resolve neither by ordinal position, by prefix match, by case-insensitive
   match nor by any similarity measure, so that a reordered column or a reordered row is resolved
   correctly and a transposed value is detected.
10. IF a data table carrying an anchor's table identity contains zero data rows, a data row being
    any row of that table other than its header row, while that block's resolved scope contains at
    least one resource, THEN THE Verifier SHALL record the blocking finding `table_rows_absent`
    naming that table identity, the count of resources in that block's resolved scope and the count
    of data rows observed, because a block that silently rendered nothing is indistinguishable in
    the delivered document from a block that was never configured.
11. IF a data table carries the explicit no-resources-matched row criterion 3.7 declares as its one
    and only data row and carries zero table anchors in the Figure_Ledger, THEN THE Verifier SHALL
    record no finding for that table's absence of data rows, so that a legitimately empty scope is
    distinguished from a block that failed to render its rows.
12. IF the table-verification pass recorded one or more blocking findings, THEN THE Verifier SHALL
    set the verification status to fail, and SHALL record every blocking finding the pass produced
    rather than stopping at the first, so that a reviewer sees every mis-anchored cell in one
    verification result.
13. THE Verifier SHALL check every table anchor recorded in the Figure_Ledger, and SHALL record on
    the verification result the count of table anchors checked and the count of data tables
    resolved, so that a pass produced by checking no anchor is distinguishable from a pass produced
    by checking every anchor.
14. THE Verifier SHALL order the table findings it records by table identity, then by row key, then
    by column key, so that two verifications of the same rendered document against the same
    Figure_Ledger produce identical verification results.

#### Requirement 28: Prose figures are checked by ordered masking

**User Story:** As a reviewer, I want any number in the prose that the compiler did not place to
survive masking and fail the report, so that a model cannot narrate a figure into a document.

##### Acceptance Criteria

1. WHEN the Verifier checks prose, THE Verifier SHALL apply the five masking stages criteria 28.2
   through 28.6 declare, in that order, to the concatenated text of each prose paragraph, being every
   paragraph the Token_Extractor extracted under criterion 26.6 including paragraphs inside data
   tables, layout tables, headers and footers, SHALL apply each stage to the text the preceding stage
   produced, and SHALL treat as a survivor every maximal whitespace-delimited token remaining in the
   fifth stage's output that carries at least one character in the decimal digit range 0 through 9.
2. THE Verifier SHALL apply as the first masking stage every occurrence of every Figure_Ledger
   entry's `formatted` string, matched by exact string equality and ordered longest first by
   character count, and, for two `formatted` strings of equal character count, ordered ascending by
   code point sequence, so that a shorter string that is a substring of a longer one does not mask
   part of that longer figure and leave a fragment behind, and so that the stage's ordering is
   identical on every run over the same ledger.
3. THE Verifier SHALL apply as the second masking stage a pattern matching an identifier, being a
   token beginning with a letter or an underscore and containing at least one digit, expressed as
   `[A-Za-z_][\w.\-]*[0-9][\w.\-]*`, masking the leftmost-longest non-overlapping matches of that
   pattern, because a figure never begins with a letter and an identifier containing a digit is a
   name rather than a measurement.
4. THE Verifier SHALL apply as the third masking stage patterns matching a globally unique identifier
   in its canonical hyphenated form, an Azure resource identifier, an internet protocol address in
   both its version 4 and its version 6 form, and a classless inter-domain routing suffix, masking
   the leftmost-longest non-overlapping matches of those patterns.
5. THE Verifier SHALL apply as the fourth masking stage patterns matching a calendar date, a
   timestamp carrying both a date and a time, and an ISO 8601 duration, so that a grain of `PT1H` and
   a window date are not read as measurements.
6. THE Verifier SHALL apply as the fifth masking stage the static-text allowlist, being the
   numeric-bearing strings obtained by rendering the pinned template version and the design settings
   the run rendered with a null context carrying no snapshot data, masking every occurrence of every
   allowlist string by exact string equality and ordered longest first by character count.
7. THE Verifier SHALL derive the static-text allowlist afresh on each verification run by rendering
   the pinned template version with a null context, and SHALL derive that allowlist from no
   hand-maintained list, so that template chrome added later is allowed without an accompanying edit
   to the verifier.
8. IF a numeric-bearing substring survives every masking stage, THEN THE Verifier SHALL record one
   blocking finding `unmatched_prose_token` for each such survivor rather than for the first survivor
   only, naming the surviving substring and the location of the paragraph the substring survived in,
   and SHALL fail the verification.
9. THE Verifier SHALL apply the masking stages to the concatenated paragraph text criterion 26.3
   declares, and SHALL apply those stages to no individual run, so that a `formatted` string the
   Docx_Renderer emitted across more than one run is masked as one string.
10. WHEN the Verifier records a finding for a survivor whose paragraph belongs to a block, THE
    Verifier SHALL record that survivor's location as that block's identifier and that paragraph's
    ordinal counted from 1 in document order within that block, so that a finding is actionable in
    the composer.
11. WHEN a masking stage matches a span of the paragraph text, THE Verifier SHALL replace that span
    with a placeholder carrying no decimal digit, and SHALL apply every later masking stage to no
    span an earlier stage already replaced, so that a later stage neither re-reads nor re-matches
    text an earlier stage consumed and the five stages produce one identical output for one input
    paragraph.
12. IF rendering the pinned template version with a null context fails, THEN THE Verifier SHALL
    derive no static-text allowlist, SHALL check no prose paragraph, and SHALL fail the verification
    carrying the error code `VERIFICATION_FAILED`, so that an allowlist that could not be derived
    never lets prose pass unchecked.
13. WHEN the Verifier records a finding for a survivor whose paragraph belongs to no block, THE
    Verifier SHALL record that survivor's location as the document region the paragraph occurs in,
    being the body, a header or a footer, and that paragraph's ordinal counted from 1 in document
    order within that region.

#### Requirement 29: Ledger completeness is bidirectional

**User Story:** As a reviewer, I want a figure that never made it into the document to be reported,
so that a silently dropped section is not called verified.

##### Acceptance Criteria

1. THE Verifier SHALL assert that every numeric token the Token_Extractor extracted from the rendered
   document resolves, where a token resolves only IF that token is a data-table cell resolved to a
   Figure_Ledger table anchor by the anchored-equality pass of requirement 27 or a numeric-bearing
   prose substring consumed by a masking stage of requirement 28, and SHALL check every extracted
   token through one of those two passes, so that no extracted token is excluded from both.
2. THE Verifier SHALL assert that every Figure_Ledger entry appears in the rendered document, where a
   table-figure entry appears only IF the cell its anchor resolves to under requirement 27 carries
   concatenated text exactly equal to that entry's `formatted` string, a chart-figure entry appears
   only IF the corresponding cell of that chart's companion data table resolves that way, and a
   prose-figure entry appears only IF that entry's `formatted` string occurs at least once in the
   concatenated paragraph text of a paragraph belonging to the block its AST path names.
3. IF a Figure_Ledger entry does not appear in the rendered document as criterion 29.2 defines
   appearance, THEN THE Verifier SHALL record the blocking finding `ledger_entry_unrendered` carrying
   that entry's AST path, that entry's `formatted` string and the identifier of the block that AST
   path names, SHALL record that finding exactly once per unrendered entry, and SHALL fail the
   verification.
4. THE Verifier SHALL classify the unrendered-entry finding of criterion 29.3 as blocking, SHALL
   classify that finding as advisory in no case, and SHALL set the verification result's status to
   fail on that finding alone when zero other blocking findings are recorded, because in this product
   a template compiles the figures the composed blocks declared and an entry that is compiled and not
   rendered is a rendering defect rather than an unused option.
5. THE Verifier SHALL record on the verification result the count of Figure_Ledger entries checked,
   the count of those entries resolved as appearing, the count of `ledger_entry_unrendered` findings
   recorded and the count of numeric tokens the Token_Extractor extracted, SHALL record those four
   counts as non-negative integers whether the verification result's status is pass or fail, and SHALL
   record an entries-checked count equal to the total number of entries the Figure_Ledger holds for
   that render.
6. THE Verifier SHALL set the verification result's status to pass only IF zero numeric-bearing
   substrings survive the masking stages of requirement 28, zero table anchors are unresolved or
   mismatched under requirement 27, and zero Figure_Ledger entries are unrendered, so that
   completeness is proven in both directions rather than in one.
7. WHERE two or more prose-figure entries whose AST paths name one block carry an identical
   `formatted` string, THE Verifier SHALL require at least that many occurrences of that string in
   that block's concatenated paragraph text, and SHALL resolve no two of those entries to the same
   occurrence.
8. IF a table-figure entry is unrendered because requirement 27 already recorded
   `table_anchor_missing`, `table_column_unresolved`, `table_row_unresolved` or `table_cell_mismatch`
   for that entry's anchor, THEN THE Verifier SHALL record no additional `ledger_entry_unrendered`
   finding for that entry, so that one rendering defect yields one finding and the counts of criterion
   29.5 are unambiguous.

#### Requirement 30: Chart verification

**User Story:** As a reviewer, I want a chart image to be tied to the numbers it depicts, so that a
stale image cannot survive a re-render.

##### Acceptance Criteria

1. WHEN the Verifier checks a chart, THE Verifier SHALL pair that chart's embedded image with that
   chart's companion data table by the chart identity derived from the chart node's AST path, being
   the identity requirement 22 writes into the embedded image's Alt Text and into the companion data
   table's `w:tblCaption`, and SHALL check that companion data table through the anchored-equality
   pass of requirement 27.
2. THE Verifier SHALL recompute each chart's chart data hash as the SHA-256 digest over that chart's
   ordered contributions, one contribution per plotted point carrying that point's series stable key,
   that point's x key and that point's decimal string as the Figure_Ledger records it, ordered by
   plotted series order and by plotted point order within each series, SHALL assert that the
   recomputed digest is exactly equal to the chart data hash recorded in that chart's embedded
   image's sidecar, and SHALL derive no contribution of the recomputed digest from that sidecar or
   from that embedded image, because a digest recomputed from the artifact it checks proves nothing.
3. IF a recomputed chart data hash differs from the chart data hash recorded in that chart's embedded
   image's sidecar, THEN THE Verifier SHALL record the blocking finding `chart_hash_mismatch` naming
   the chart node's AST path, the recomputed digest and the sidecar's digest, and SHALL fail the
   verification.
4. IF the rendered document carries no data table whose `w:tblCaption` identity equals the chart
   identity derived from a chart node's AST path, THEN THE Verifier SHALL record the blocking finding
   `chart_table_missing` naming that chart node's AST path, and SHALL fail the verification.
5. THE Verifier SHALL record a chart as verified only IF the anchored-equality pass of requirement 27
   records zero blocking findings against that chart's companion data table and the recomputed chart
   data hash is equal to that chart's sidecar hash, because the table gate alone passes a document
   whose embedded image is stale and the hash gate alone passes a document whose companion table
   carries a value the Figure_Ledger never emitted.
6. IF a chart's embedded image carries no sidecar chart data hash, or carries a sidecar value the
   Verifier cannot read as a digest, THEN THE Verifier SHALL record the blocking finding
   `chart_hash_mismatch` naming that chart node's AST path, the recomputed digest and the absence of a
   readable sidecar digest, and SHALL fail the verification, so that a chart whose image cannot be
   tied to its data fails in the same way as a chart whose image disagrees with its data.
7. THE Verifier SHALL check every chart node of the document AST rather than stopping at the first
   chart carrying a blocking finding, and SHALL record on the verification result the count of chart
   nodes checked, the count of recomputed chart data hashes found equal to their sidecar hash, and the
   chart identity of every chart carrying a blocking finding.

#### Requirement 31: Deterministic replay proves the snapshot

**User Story:** As an auditor, I want the aggregation re-run over the stored raw responses to produce
the same snapshot, so that determinism is demonstrated rather than asserted.

##### Acceptance Criteria

1. WHEN the Verifier verifies a run, THE Replay_Verifier SHALL re-run the same pure aggregation the
   Snapshot_Builder ran over that run's archived raw responses, SHALL compute the recomputed snapshot
   digest by RFC 8785 canonicalizing the recomputed snapshot and hashing it with SHA-256 through the
   same code path the Snapshot_Builder used, and SHALL assert that the recomputed digest is
   byte-for-byte equal to the stored `snapshot_id`.
2. THE Replay_Verifier SHALL make zero Azure API calls and zero network requests of any kind, SHALL
   receive the archived raw objects as input from its caller rather than fetching any object itself,
   and SHALL import only modules that make no network request, so that a replay proves determinism
   rather than re-collecting.
3. IF the recomputed snapshot digest differs from the stored `snapshot_id`, THEN THE Replay_Verifier
   SHALL record the blocking finding `replay_hash_mismatch` carrying the recomputed digest, the stored
   `snapshot_id` and the count of archived objects folded, and THE Agent_Runtime SHALL report the
   terminal code `REPLAY_MISMATCH`.
4. THE Replay_Verifier SHALL fold each archived raw object exactly once, in the order the archive
   sequence records, SHALL derive every folded value from that object's raw points alone and from no
   accumulator, aggregated value or digest read out of the stored snapshot, and SHALL discard an
   object's decoded points once folded so that no more than one archived object's points are held at
   a time, so that a replay reproduces the aggregation rather than approximating it or restating it.
5. WHERE a run's snapshot records that the raw archive is incomplete, or records no raw archive for
   that run, THE Replay_Verifier SHALL record the advisory finding `archive_incomplete`, SHALL record
   no `replay_hash_mismatch` finding for that run, and SHALL record on the verification result that
   replay was not possible, so that a known-incomplete archive is reported as an inability to replay
   rather than as a proven mismatch.
6. THE Verifier SHALL record the replay outcome on the verification result, carrying the recomputed
   digest, the stored digest, the count of archived objects folded, the count of objects the archive
   sequence names and whether replay was possible.
7. IF a module reachable from the Replay_Verifier's import graph imports an Azure software development
   kit client, an object-store client or any other network client, THEN THE Boundary_Guard SHALL fail,
   so that replay's purity is enforced at build time rather than observed at run time.
8. IF an archived raw object the archive sequence names is absent from the objects supplied to the
   Replay_Verifier or cannot be decoded, THEN THE Replay_Verifier SHALL record the advisory finding
   `archive_incomplete` naming that object's sequence ordinal, SHALL record on the verification result
   that replay was not possible, and SHALL record no `replay_hash_mismatch` finding for that run.
9. IF the verification result carries a `replay_hash_mismatch` finding, THEN THE Verifier SHALL set
   the verification status to fail, so that no passing verification and no download control exists for
   that run.

#### Requirement 32: Scope and coverage gates

**User Story:** As a consultant, I want an empty report to fail loudly, so that an expired secret
never produces a clean, fully verified document containing nothing.

##### Acceptance Criteria

1. IF the snapshot's `scope_verified` value is false, absent, or not recorded, THEN THE Verifier SHALL
   record the blocking finding `scope_unverified` and SHALL set the verification status to fail,
   because subscription-scope read is unproven unless the preflight proved it, so the gate fails
   closed on a missing value rather than passing.
2. THE Verifier SHALL assert that every resource identifier of the run's union scope is present in the
   snapshot's resource set, and IF one or more of those identifiers is absent from that set, THEN THE
   Verifier SHALL record exactly one blocking finding `coverage_resource_absent` per absent identifier
   naming that identifier, and SHALL set the verification status to fail.
3. IF a run's in-scope result — the union of the pinned template version's default scope and every
   block `scope_override`, resolved for that run — contains zero resources, THEN THE Agent_Runtime
   SHALL report the terminal code `EMPTY_SCOPE`, SHALL compile no document, SHALL render no document,
   SHALL write no report artifact, and SHALL emit no `report_file` event, because an expired client
   secret or an over-narrow role assignment yields zero resources, zero resources yields zero figures,
   and zero figures yields zero unverifiable figures, so the run would otherwise pass collection,
   compilation, rendering AND verification and deliver a clean, fully verified, empty report in which
   every gate passes and the artifact is worthless.
4. IF a verification is attempted against a snapshot whose resource set contains zero resources, THEN
   THE Verifier SHALL record the blocking finding `empty_scope` and SHALL set the verification status
   to fail, so that a re-verification of a stored empty snapshot fails rather than passing.
5. THE Verifier SHALL derive the run's union scope resource set and the coverage assertion from the
   snapshot and the pinned template version alone, and SHALL issue no Azure query for that derivation,
   because the inventory query is itself role-based-access-control filtered and a coverage check
   therefore cannot detect what role-based access control hides.
6. THE Verifier SHALL record the resource count of the union scope, the resource count present in the
   snapshot, and the count of `collection_log` entries on the verification result as non-negative
   integers, and SHALL record those three counts whether the verification passes or fails.
7. IF one block's resolved scope contains zero resources WHILE the run's union scope contains one or
   more resources, THEN THE Verifier SHALL record no `empty_scope` finding and no
   `coverage_resource_absent` finding for that block, and THE Agent_Runtime SHALL report no terminal
   code for that block, because a single block matching nothing is ordinary compile output rather than
   a failure.
8. IF the Verifier cannot resolve the run's union scope resource set from the snapshot and the pinned
   template version, THEN THE Verifier SHALL record the blocking finding `coverage_resource_absent`
   naming the scope rule it could not resolve, and SHALL set the verification status to fail, so that
   an underivable coverage assertion fails closed rather than being reported as complete coverage.
9. WHEN a run terminates with the code `EMPTY_SCOPE`, or a verification records `scope_unverified` or
   `empty_scope`, THE Web_App SHALL present that run as failed naming the recorded terminal code and
   the recorded finding, SHALL present the expired client secret and the over-narrow role assignment
   as the causes to check, and SHALL present no download control and no passing verification for that
   run.

#### Requirement 33: PDF fidelity

**User Story:** As a consultant, I want the PDF checked as well as the Word file, so that a
conversion cannot silently change a number.

##### Acceptance Criteria

1. WHEN the Verifier checks the produced `.pdf`, THE Verifier SHALL assert, for every Figure_Ledger
   entry, that a located occurrence of that entry's `formatted` string is present in the normalized
   text criterion 33.5 declares, applying the match rule criterion 33.6 declares, because a conversion
   performed under a locale whose decimal separator differs from the separator the Formatter emitted
   alters every numeral and the ledger's strings cease to be locatable.
2. IF a Figure_Ledger entry's `formatted` string has no located occurrence in the normalized text of
   the produced `.pdf`, THEN THE Verifier SHALL record one blocking finding `pdf_figure_missing` naming
   that entry's AST path, that entry's `formatted` string and that entry's `snapshot_path`, SHALL
   record one such finding for every entry lacking a located occurrence rather than stopping at the
   first, and SHALL set the verification result's status to fail, so that no `.pdf` download and no
   `.docx` download is presented for that run.
3. THE Verifier SHALL perform the PDF-fidelity check against the `.pdf` the Pdf_Converter converted
   from the delivered `.docx`, identified by asserting that the SHA-256 digest of the checked `.pdf` is
   equal to the `pdf_sha256` value criterion 23.7 records, and SHALL perform that check against no
   independently rendered `.pdf`, against no `.pdf` emitted from the document AST and against no `.pdf`
   emitted from the Figure_Ledger.
4. THE Verifier SHALL record on the verification result the count of Figure_Ledger entries checked
   against the `.pdf`, the count of those entries whose `formatted` string was located, the count of
   `pdf_figure_missing` findings recorded, the count of pages the Token_Extractor read and the SHA-256
   digest of the `.pdf` checked.
5. WHEN the Token_Extractor reads a produced `.pdf`, THE Token_Extractor SHALL concatenate the text
   every text-show operator of a page's content stream yields, in content-stream order, SHALL
   concatenate the pages in ascending page order from page 1 to the last page with a single space
   between consecutive pages, SHALL replace every run of 1 or more whitespace characters, including
   every line break and every page break, with a single space, and SHALL trim leading and trailing
   whitespace, so that a `formatted` string a conversion split across 2 or more text-show operators,
   across 2 or more lines or across 2 consecutive pages is still one contiguous substring of the
   normalized text and no correspondence between one text-show operator and one figure is assumed.
6. WHEN the Verifier compares a Figure_Ledger entry's `formatted` string with the normalized text, THE
   Verifier SHALL apply to that `formatted` string the same whitespace normalization criterion 33.5
   declares, and SHALL treat an occurrence of the normalized string as located only where that
   occurrence is bounded at each end by the start of the normalized text, the end of the normalized
   text, or a character that is neither a digit, nor the decimal separator, nor the grouping separator,
   so that a `formatted` string appearing only as a fragment of a longer numeral is treated as absent
   rather than as located.
7. IF the Token_Extractor extracts 0 text characters from the produced `.pdf` while the Figure_Ledger
   carries 1 or more entries, THEN THE Agent_Runtime SHALL report the terminal code
   `PDF_CONVERSION_FAILED`, SHALL present no `.pdf` download and no `.docx` download for that run, and
   SHALL retain the stored snapshot, the stored Figure_Ledger and the stored `.docx` unmodified,
   because a `.pdf` carrying no extractable text is a conversion that failed without failing rather
   than a document missing every figure.

#### Requirement 34: Sampled drift is advisory and bounded

**User Story:** As an auditor, I want a bounded spot check against Azure, so that a disputed figure
has a re-runnable check without doubling the length of every run.

##### Acceptance Criteria

1. WHEN the Drift_Sampler selects a drift sample, THE Drift_Sampler SHALL admit candidates from three
   tiers in this precedence order — first every resource the rendered document names that the snapshot
   carries, second the 10 resources of the snapshot carrying the highest recorded maximum for the
   report's primary metric, third 10 percent of the snapshot's resources rounded up to the next whole
   resource and drawn pseudo-randomly from the recorded seed — SHALL admit each resource at most once,
   SHALL stop admitting candidates once the sample holds 25 distinct resources, SHALL select at most 25
   distinct resources, and SHALL select no resource absent from the snapshot; and THE Drift_Sampler
   SHALL take the report's primary metric to be the metric the pinned template version's metric
   selection names first for the resource type carrying the most resources in the snapshot's union
   scope.
2. THE Drift_Sampler SHALL re-query no resource absent from the selected drift sample and SHALL perform
   no full re-query of the snapshot's resources, because a full re-query nearly doubles the critical
   path while mostly testing an aggregation a unit test proves better.
3. WHEN the Drift_Sampler records a drift sample, THE Drift_Sampler SHALL record on the verification
   result the count of distinct resources selected, the identifier of the selection rule criterion 34.1
   declares, and the seed the pseudo-random draw consumed, SHALL record that descriptor before issuing
   the first re-query, and SHALL record that descriptor whether or not a `drift_observed` finding is
   recorded, so that a disputed check is re-runnable identically.
4. FOR ALL seeds and ALL snapshots, THE Drift_Sampler SHALL select an identical set of resources for
   one triple of snapshot, rendered document and seed on every call, SHALL order the candidates within
   each tier of criterion 34.1 by ascending resource identifier, SHALL resolve a tie in the recorded
   maximum by ascending resource identifier, and SHALL resolve a tie in resource count between two
   resource types by ascending resource type identifier, so that truncation at the 25-resource cap is
   deterministic.
5. IF a re-queried value differs from the snapshot's value for that resource and that metric at the
   precision the snapshot records that value, THEN THE Drift_Sampler SHALL record the advisory finding
   `drift_observed` naming the resource, the metric, the window, the snapshot value and the re-queried
   value.
6. THE Verifier SHALL derive the verification result's status from no `drift_observed` finding, and
   SHALL record every `drift_observed` finding on the verification result as advisory, because a
   re-queried value legitimately differs from a value collected earlier.
7. THE Drift_Sampler SHALL separate the sample selection from the re-query, expressing the selection
   as a pure operation over the snapshot, the resources the rendered document names and the seed,
   making no network request and importing no Azure client, so that the selection is testable without a
   subscription.
8. WHEN the Drift_Sampler re-queries a sampled resource, THE Drift_Sampler SHALL re-query the report's
   primary metric for that resource over the run's collection window at the run's collection grain, and
   SHALL compare the re-queried value against the snapshot's value for that same resource, metric and
   window.
9. IF a re-query of a sampled resource does not return a value, THEN THE Drift_Sampler SHALL record
   that resource as not re-queried on the verification result, SHALL record no `drift_observed` finding
   and no blocking finding for that resource, SHALL leave the snapshot unmodified, and SHALL complete
   the remaining re-queries of the drift sample.
10. THE Agent_Runtime SHALL derive the run's status and the run's terminal error code from no
    `drift_observed` finding and from no resource recorded as not re-queried, and SHALL withhold no
    report artifact on account of either.

#### Requirement 35: The prose review is advisory and reads no raw data

**User Story:** As a consultant, I want a second opinion on the wording, so that the commentary reads
well without the model getting anywhere near a measurement.

##### Acceptance Criteria

1. WHEN the Prose_Reviewer reviews a report, THE Prose_Reviewer SHALL receive exactly two inputs — the
   model-authored prose text nodes of the document AST, and the report's aggregate table, defined as the
   `formatted` strings the Figure_Ledger entries rendered into the document's data tables — and SHALL
   receive no raw metric series, no per-resource point series, no `collection_log` entry and no archived
   raw collection response, so that the review is verifiable by inspecting the review input alone.
2. WHEN the Prose_Reviewer records an observation, THE Prose_Reviewer SHALL record it as one advisory
   finding of type `prose_review_finding` carrying the AST path of the reviewed prose node and the
   observation text, SHALL record no numeric string that is absent from both the Figure_Ledger's
   `formatted` values and the static-text allowlist, and SHALL record at most 25 such findings for one
   report.
3. THE Verifier SHALL derive the verification result's status from no `prose_review_finding` and from no
   prose review outcome, so that the status of one verification is identical whether the review
   completed, produced findings, or did not run.
4. THE Agent_Runtime SHALL apply no `prose_review_finding` to the document automatically, SHALL expose
   no code path that writes a finding's text into the document AST, the produced `.docx`, the produced
   `.pdf` or the Figure_Ledger, and SHALL present each such finding in the Verification_Panel for a
   consultant to act on by an explicit action.
5. THE Agent_Runtime SHALL treat the Prose_Reviewer as no part of the enforcement of the product
   invariant, because the enforcement is the Verifier, and SHALL treat no instruction given to the
   Prose_Reviewer as that enforcement.
6. IF the prose review does not complete within 60 seconds of being started, or fails for any reason,
   THEN THE Agent_Runtime SHALL record the review outcome as not completed on the verification result,
   SHALL record no blocking finding and no advisory finding of any other declared type, SHALL make no
   further review attempt for that report, and SHALL leave the verification result's status and the
   run's status unchanged.
7. THE Prose_Reviewer SHALL write no snapshot, no Figure_Ledger, no document AST, no `.docx` and no
   `.pdf`, so that a review cannot alter the artifact it reviewed.
8. THE Agent_Runtime SHALL derive the run's status and the run's terminal code from no prose review
   outcome, and SHALL withhold no report artifact pending a prose review, because the review is advisory
   and a report run is minutes long already.

#### Requirement 36: The verification record and its artifacts

**User Story:** As an auditor, I want the verification stored beside the report, so that a report
delivered a year ago can be re-checked against the snapshot it came from.

##### Acceptance Criteria

1. THE Verification_Store SHALL define a `report_verifications` table carrying `id`, `run_id`,
   `template_version_id`, `status` restricted to the two values pass and fail, `figure_count`,
   `snapshot_sha256`, `docx_sha256`, `pdf_sha256`, the replay outcome, the drift sample descriptor, the
   finding list and `created_at`, with `run_id` referencing `report_runs.id` and `template_version_id`
   referencing `report_template_versions.id`, and SHALL apply no unique constraint to `run_id`, because
   a re-verification of one run appends a further row for that run.
2. THE Verification_Store SHALL expose no operation that modifies a `report_verifications` row and no
   operation that deletes one, and SHALL expose the insertion of a new row as its only write operation,
   so that a written verification result is immutable for the lifetime of the run it records.
3. WHEN the Agent_Runtime completes a verification, THE Agent_Runtime SHALL apply the redaction scrub to
   that verification result and to every finding message it carries as criterion 43.7 declares, SHALL
   then write that scrubbed result as an artifact alongside the rendered document and the Figure_Ledger,
   and SHALL write no unscrubbed result and emit no unscrubbed result, because a finding message can
   quote document text or a service error.
4. WHEN a consultant requests a re-verification of a stored report, THE Verifier SHALL verify the stored
   `.docx` and the stored `.pdf` against the stored Figure_Ledger and the snapshot the run's
   `snapshot_id` names, SHALL fetch no fresh snapshot, SHALL run no collection, and SHALL make no Azure
   API call other than the re-queries of the drift sample that criterion 34.1 bounds at 25 resources.
5. THE Verification_Store SHALL record the pinned `template_version_id` and the pinned `snapshot_sha256`
   on each verification result, and THE Verifier SHALL read the definition a re-verification compiles
   against from that pinned `template_version_id` rather than from the template's `current_version_id`,
   so that a stored report is re-verifiable from the pinned version and the pinned snapshot alone.
6. THE Verifier SHALL derive `snapshot_sha256` as the run's `snapshot_id`, `docx_sha256` as the SHA-256
   digest of the bytes of the delivered `.docx`, and `pdf_sha256` as the SHA-256 digest of the bytes of
   the `.pdf` converted from that same delivered `.docx`, so that a later re-verification recomputes
   each digest over the same bytes the original verification hashed.
7. WHEN a re-verification of a run completes, THE Verification_Store SHALL append a new
   `report_verifications` row carrying a distinct `id`, that run's `run_id` and its own `created_at`,
   SHALL retain every earlier row for that run unchanged, and THE Verification_Panel SHALL present the
   row carrying the latest `created_at` for that run together with the count of stored verification rows
   for that run.
8. IF a stored input a re-verification requires — the stored `.docx`, the stored `.pdf`, the stored
   Figure_Ledger, or the snapshot the run's `snapshot_id` names — is absent, is unreadable, or carries a
   recomputed digest differing from the digest that run's stored verification row records, THEN THE
   Verifier SHALL set the status of the verification result it writes for that attempt to fail, SHALL
   report the terminal code `VERIFICATION_FAILED` with an error indication naming the affected stored
   input, SHALL run no collection to reconstruct that input, and SHALL modify no earlier
   `report_verifications` row.

---

### Section F — The report surfaces

#### Requirement 37: The reports list and the report detail surface

**User Story:** As a consultant, I want to find a delivered report and see what it was built from,
so that answering a client question does not mean re-running anything.

##### Acceptance Criteria

1. THE Web_App SHALL present a reports list carrying, for each run, `report_runs.status`, the template
   name, the pinned template version number, the connected subscription's masked identifier, the
   resolved period as that run's local start and end dates in that run's timezone, and the verification
   status as exactly one of pass, fail or absent, and SHALL source every connected subscription field in
   that list solely from the browser-safe connected-subscription projection, so that no tenant
   identifier, no client identifier and no client-secret ciphertext reaches the browser.
2. THE Report_Detail_View SHALL present the snapshot provenance carrying the `snapshot_id` truncated to
   its leading 12 characters beside a copy control that places the complete untruncated digest on the
   clipboard, the collection window's start and end instants expressed in the run's timezone with that
   timezone's resolved UTC offset displayed alongside them, the grain, the resource count and the
   `collection_log` gap count, with the digest, the offset and every count rendered in the monospace
   face.
3. THE Report_Detail_View SHALL present the `collection_log` entries grouped by `gap_type`, each group
   carrying that group's entry count and naming every affected resource, styled in mist neutral tokens
   rather than the `--destructive` token, because a gap is neutral information rather than an error
   state.
4. THE Report_Detail_View SHALL present each resource's `fidelity_tier` as a badge carrying an
   explanation stating that `baseline` supplies exact average, minimum and maximum values with estimated
   percentiles, and that `enhanced` supplies true percentiles, per-volume disk free space and
   guest-observed memory, SHALL present that badge per resource where resources of one run carry
   differing tiers rather than presenting one run-level tier, and SHALL style the `baseline` badge in
   mist neutral tokens rather than the `--destructive` token, because a tier is neutral information
   rather than an error state.
5. THE Report_Detail_View SHALL render every figure in the monospace face with tabular figures, and
   SHALL animate no numeral and apply no transition that interpolates a numeral's displayed value over
   time, including while the run is still in progress, because a count-up on a verified figure is
   decoration presented as data.
6. THE Report_Detail_View SHALL present the run's terminal state by reading `report_runs.status`,
   `report_runs.error_code` and `report_runs.error_message` in addition to reading events, as the
   foundation spec's criterion 36.7 declares, SHALL derive that terminal state from those three columns
   alone when no event stream is open, and IF the row and the received events disagree on the run's
   state, THEN THE Report_Detail_View SHALL present the row's state, because a `TIMEOUT` arrives with no
   event and the row is the record.
7. THE Web_App SHALL restrict every read of a run, a template, a template version and a verification
   result to rows whose owning user's identifier equals the signed-in user's identifier, evaluating that
   comparison before presenting any field of that row, and IF an owning identifier differs, THEN THE
   Web_App SHALL resolve that request as not found, SHALL disclose no field of that row, and SHALL make
   that outcome indistinguishable from a request naming an identifier that exists for no row.
8. THE Web_App SHALL order the reports list by each run's creation instant with the most recent run
   first, SHALL present at most 50 runs per page, and SHALL present a control reaching the following
   page while unpresented runs remain.
9. IF a run carries no verification result, THEN THE Report_Detail_View SHALL present that run's
   `report_runs.status`, `report_runs.error_code` and `report_runs.error_message`, and SHALL present no
   statement that any figure traced to a snapshot.
10. IF a run's `collection_log` holds zero entries, THEN THE Report_Detail_View SHALL present an
    explicit statement that the collection recorded no gap, styled in mist neutral tokens rather than
    the `--destructive` token, and SHALL omit no gap section, because an absent section is
    indistinguishable from a gap list that failed to load.

#### Requirement 38: The in-app paper rendering reveals provenance

**User Story:** As a consultant, I want to hover a number and see where it came from, so that I can
answer "where did this come from" without leaving the report.

##### Acceptance Criteria

1. THE Report_Detail_View SHALL present the report as a paper-like rendering emitted by the Html_Emitter
   by walking the same document AST the Docx_Renderer emitted for that run, resolved from that run's
   pinned `template_version_id` and that run's `snapshot_id`, SHALL hold no layout definition of its own,
   and SHALL present every figure as the `formatted` string the Figure_Ledger entry for that figure's AST
   node path carries, composing no numeric string of its own.
2. WHEN a consultant places the pointer over a figure in the paper-like rendering, or WHEN a figure in
   the paper-like rendering receives keyboard focus, THE Report_Detail_View SHALL reveal, within 200
   milliseconds of that hover or that focus and without navigating away from the report detail surface,
   that figure's `snapshot_path` rendered in the monospace face with a copy control, and THE
   Report_Detail_View SHALL reveal that figure's estimator label in addition WHERE that figure's
   `estimator` marks the value as estimated.
3. THE Report_Detail_View SHALL display the estimator caveat by rendering the Figure_Ledger entry's label
   character-for-character, SHALL compose no percentile label and no estimator label of its own, SHALL
   display no bare percentile designation, and WHERE a figure's `estimator` marks the value as not
   estimated, THE Report_Detail_View SHALL display no estimator caveat for that figure.
4. THE Report_Detail_View SHALL make the provenance reveal of criterion 38.2 reachable from the keyboard,
   so that provenance is available without a pointing device, SHALL reveal the same `snapshot_path` and
   the same estimator label for a keyboard focus as for a pointer hover, SHALL keep that reveal visible
   while the pointer remains over the figure or while the figure retains focus, and SHALL dismiss that
   reveal when the pointer leaves the figure, when focus leaves the figure, or when the Escape key is
   pressed.
5. THE Report_Detail_View SHALL present the paper-like rendering with the permanent preview label
   criterion 14.2 declares, on every render of that rendering and outside a tooltip and outside a
   first-run hint, SHALL display no page number and no page count as criterion 14.3 declares, and SHALL
   present the presigned `.pdf` of requirement 40 as the delivered result.
6. THE Report_Detail_View SHALL make every figure in the paper-like rendering reachable by sequential
   keyboard navigation, in the document order the Html_Emitter emits, and SHALL present a visible focus
   indicator on the focused figure using the `--ring` token.
7. WHEN a figure in the paper-like rendering receives keyboard focus, THE Report_Detail_View SHALL
   associate the revealed `snapshot_path` and the revealed estimator label with that figure as that
   figure's accessible description, so that an assistive technology announces the provenance without a
   pointer event.
8. IF the Figure_Ledger entry naming a figure's AST node path is absent, or that entry carries no
   estimator label while that figure's `estimator` marks the value as estimated, THEN THE
   Report_Detail_View SHALL reveal an indication that provenance is unavailable for that figure, SHALL
   compose no `snapshot_path` and no estimator label of its own, and SHALL present that figure's
   `formatted` string unchanged.

#### Requirement 39: The verification panel is an audit certificate

**User Story:** As a consultant, I want the verification to look like a certificate, so that handing a
client the report comes with something that states what was proven.

##### Acceptance Criteria

1. THE Verification_Panel SHALL present the verification status, the `figure_count`, the
   `snapshot_sha256`, the `docx_sha256` and the `pdf_sha256` the verification result records, with every
   digest rendered in the monospace face with tabular figures and accompanied by a copy control that
   yields that digest's complete recorded string.
2. WHEN the verification status is pass, THE Verification_Panel SHALL present the status word, the
   `figure_count` and the `snapshot_sha256` as the statement that every counted figure traced to the
   named snapshot, and SHALL present that statement styled in mist neutral tokens without the
   `--destructive` token and without an assertive alert presentation.
3. WHEN the verification status is fail, THE Verification_Panel SHALL present the count of blocking
   findings and SHALL list every blocking finding the verification result records, each carrying its
   declared blocking finding type and the locating fields the criterion recording that finding type
   declares, including the AST path, the table identity with its row key and column key, the surviving
   substring with its paragraph location, and the expected and observed strings where the recording
   criterion declares them; THE Verification_Panel SHALL state that the report was not delivered, and
   SHALL apply the `--destructive` token to that state.
4. THE Verification_Panel SHALL present the replay outcome carrying the recomputed digest, the stored
   digest and the count of archived objects folded, and the drift sample descriptor carrying the sample
   size, the selection method and the seed; and WHERE the verification result records that replay was not
   possible, THE Verification_Panel SHALL present that replay was not possible rather than presenting a
   replay pass or a replay failure.
5. THE Verification_Panel SHALL present each advisory finding in a region separate from the blocking
   findings, labelled as advisory, styled without the `--destructive` token, and SHALL present no
   advisory finding as a cause of the verification status.
6. THE Verification_Panel SHALL apply the `--destructive` token to the verification-failure state and to
   a hard error only, and SHALL apply that token to no `collection_log` gap, no advisory finding, no
   `fidelity_tier` badge, no utilization value and no negative delta value, so that the appearance of
   that token carries the single meaning that the document could not be proven.
7. WHEN the verification status resolves to pass or to fail, THE Verification_Panel SHALL announce that
   status through an `aria-live` region set to `polite`, and WHEN that status is fail, THE
   Verification_Panel SHALL announce the count of blocking findings in that same announcement.
8. IF a run carries no verification result, or carries a verification result whose status is neither pass
   nor fail, THEN THE Verification_Panel SHALL present that the report is not verified, SHALL present no
   pass statement and no digest as proven, SHALL present that state in mist neutral tokens rather than
   the `--destructive` token, and THE Web_App SHALL present no download control for that run as criterion
   40.4 declares.
9. THE Verification_Panel SHALL derive every value it presents from the stored `report_verifications` row
   the Verification_Store holds for that run, and SHALL derive no presented value from a received event
   alone, so that a reconnecting client presents the same status, the same digests and the same finding
   list rather than a subset of them.
10. IF the verification result records a finding whose type the Verification_Panel does not recognize,
    THEN THE Verification_Panel SHALL present that finding using the blocking or advisory classification
    the verification result records for it, SHALL present its recorded type string and its recorded
    locating fields, and SHALL omit no recorded finding from the presented lists or from the count
    criterion 39.3 declares.

#### Requirement 40: Download is gated on a passing verification

**User Story:** As a consultant, I want the download to exist only for a proven report, so that I
cannot accidentally send a client an unverified document.

##### Acceptance Criteria

1. WHILE a run's verification result status is pass and that run's `status` is `completed`, WHEN a
   consultant opens that run's detail surface, THE Web_App SHALL present exactly one download control for
   that run's recorded `.docx` artifact key and exactly one download control for that run's recorded
   `.pdf` artifact key, and SHALL mint each control's presigned URL server-side only at the moment that
   control is activated rather than at surface render.
2. WHEN a consultant activates a download control for a report artifact, THE Web_App SHALL, before making
   any storage call, assert that the run's owning user identifier equals the signed-in user's identifier,
   that the artifact key's actor prefix equals that same identifier, and that the run's verification
   result status recorded in the Verification_Store is pass, as the foundation spec's criterion 37.8
   declares.
3. THE Web_App SHALL mint every presigned URL for a report artifact with an expiry of at most 300 seconds,
   SHALL mint a fresh presigned URL on each download-control activation rather than reusing a previously
   minted one, SHALL persist no presigned URL in any table, event, log line or message, and SHALL place
   no presigned URL in a cacheable payload, in a server-rendered payload, or in any browser-safe
   projection of a run.
4. IF a run's verification result status is fail, or no verification result exists for that run, or that
   run's `status` is any value other than `completed`, THEN THE Web_App SHALL present no download control
   for that run, SHALL mint no presigned URL for that run's rendered document, and SHALL expose no route
   and no action that returns one, as criterion 25.3 declares.
5. IF a download request names an artifact key that is not one of the artifact keys recorded on that
   run's row, THEN THE Web_App SHALL resolve that request as not found, SHALL make no storage call, and
   SHALL disclose no field of that run and no indication of whether the named key exists.
6. IF any assertion criterion 40.2 declares does not hold, THEN THE Web_App SHALL resolve that download
   request as not found, SHALL mint no presigned URL, SHALL make no storage call, and SHALL disclose no
   indication of whether the named artifact exists.
7. IF an authorized mint attempt fails or the storage call reports the named object absent, THEN THE
   Web_App SHALL present an error indication stating that the artifact is unavailable for download, SHALL
   leave that run's row and that run's verification result unchanged, and SHALL keep the download control
   available for a further activation.

---

### Section G — Orchestration, events and schema growth

#### Requirement 41: The run pipeline drives the document phases

**User Story:** As an operator, I want the document phases to advance the same state machine, so that a
crashed render is a recoverable row rather than a permanent one.

##### Acceptance Criteria

1. THE Run_State_Machine SHALL drive exactly the transitions `collecting → compiling`,
   `compiling → rendering`, `rendering → verifying`, `verifying → completed`,
   `compiling → failed`, `rendering → failed` and `verifying → failed`, extending the
   transitions the foundation spec's criterion 36.2 declares driven, SHALL treat `completed`
   and `failed` as terminal with no outgoing transition, and SHALL write `completed` only once
   the Verification_Store holds a verification result for that run whose status is pass.
2. THE Run_State_Machine SHALL add exactly the six values `TEMPLATE_INVALID`, `COMPILE_FAILED`,
   `RENDER_FAILED`, `PDF_CONVERSION_FAILED`, `VERIFICATION_FAILED` and `REPLAY_MISMATCH` to the
   `report_runs.error_code` constraint additively, SHALL treat each of those six as terminal,
   and SHALL remove no value that constraint already declares.
3. WHEN the Run_State_Machine writes a `status` of `compiling`, `rendering` or `verifying`, THE
   Run_State_Machine SHALL set that row's `phase_deadline` to the write instant plus that
   phase's declared budget — 300 seconds for `compiling`, 600 seconds for `rendering` and 600
   seconds for `verifying` — SHALL replace any `phase_deadline` value the row already carried,
   and SHALL set `updated_at` to that same write instant, as the foundation spec's criterion
   36.9 declares for the phases it drives.
4. WHEN the Agent_Runtime enters the compile, render or verify phase, THE Progress_Reporter
   SHALL send the phase transition to the Progress_Endpoint as the foundation spec's
   requirement 38 declares, SHALL abandon that send after at most 5 seconds without awaiting a
   response beyond that bound, SHALL continue the phase it entered whatever that send's
   outcome, and SHALL fail no run because a transition did not land; and THE Progress_Endpoint
   SHALL accept those transitions under the extended transition table criterion 41.1 declares.
5. THE Reaper SHALL fail a row past its `phase_deadline` in the `compiling`, `rendering` or
   `verifying` status as `failed` with an `error_code` of `TIMEOUT`, extending the sweep the
   foundation spec's criterion 39.7 declares, SHALL preserve the `status` value that row held
   when the deadline elapsed as the recorded failing phase, and THE Agent_Runtime SHALL send
   `TIMEOUT` in no transition, because the Agent_Runtime may already be absent when a deadline
   elapses.
6. THE Run_State_Machine SHALL add `template_version_id` to `report_runs` as criterion 9.6
   declares, and SHALL express every schema change this spec requires as a migration that adds
   columns and constraint values only, containing no `DROP` naming a table or a column a
   previously committed migration created, because these rows are the audit trail for delivered
   documents.
7. WHEN the Agent_Runtime fails in the compile, render, PDF-conversion or verify phase, THE
   Agent_Runtime SHALL send one terminal transition to `failed` carrying that phase's error
   code from the six criterion 41.2 declares, and SHALL send a `PDF_CONVERSION_FAILED`
   transition from the `rendering` status, adding no `status` value for PDF conversion, so that
   the run row records which phase failed.
8. IF the Progress_Endpoint receives a transition for a row whose `status` is already
   `completed` or `failed`, THEN THE Progress_Endpoint SHALL apply no change to that row's
   `status`, `error_code` or artifact fields, and SHALL record no artifact for that run; and IF
   the Progress_Endpoint receives a transition naming the `status` that row already carries, or
   a transition absent from the table criterion 41.1 declares, THEN THE Progress_Endpoint SHALL
   apply no change to that row and SHALL return an outcome indicating the transition was not
   applied.
9. WHILE a `report_runs` row is non-terminal and past its `phase_deadline`, THE Reaper SHALL
   apply the `TIMEOUT` transition criterion 41.5 declares no later than 120 seconds after that
   `phase_deadline` elapsed, so that a crashed container leaves no row non-terminal beyond that
   bound.
10. WHILE no client is connected to the SSE_Relay for a run, THE Run_State_Machine SHALL
    advance that run's `status` through the transitions criterion 41.1 declares from the
    Progress_Endpoint writes alone, and SHALL derive no `status`, `error_code` or
    `phase_deadline` value from the SSE_Relay.

#### Requirement 42: The event contract for the document phases

**User Story:** As a consultant watching a run, I want the document phases to stream like the collection
phases, so that a twelve-minute run shows progress rather than silence.

##### Acceptance Criteria

1. THE Agent_Runtime SHALL emit `tool` events for the phases this spec drives, using the step
   names `compile_figures`, `render_document`, `verify_document` and `upload_artifact`,
   emitting for each step one event with `phase` `start` carrying `id`, `name`, `label` and
   `status` and one event with `phase` `end` carrying that same `id` and that same `name`, as
   the foundation spec's criterion 14.7 declares, and SHALL emit that matching `phase` `end`
   event before `done` even for a phase that ended by raising, so that no document-phase step
   is left open.
2. WHEN the Verifier has produced a verification result, THE Agent_Runtime SHALL emit exactly
   one `verification` event for that invocation carrying the status as pass or fail, the figure
   count as a non-negative integer, every blocking finding, every advisory finding, each
   finding carrying its finding type and its location, the `snapshot_id`, the replay outcome
   carrying both compared digests, and the drift sample descriptor carrying the sample size,
   the selection method and the seed, and SHALL carry in that event the same values written to
   the Verification_Store for that run, so that a client that received no event renders the
   identical panel from the stored result.
3. WHEN the Agent_Runtime has completed the write of a report artifact, THE Agent_Runtime SHALL
   emit one `report_file` event for that artifact carrying the artifact key, the bucket, the
   kind as `docx` or `pdf`, and the byte count as a non-negative integer, and SHALL carry no
   presigned URL and no artifact content in that event.
4. THE Agent_Runtime SHALL emit every `report_file` event after a `verification` event carrying
   a status of pass emitted earlier in that same invocation, SHALL emit no `report_file` event
   for a verification whose status is fail, and SHALL emit no `report_file` event for an
   invocation in which it emitted no `verification` event.
5. THE Agent_Runtime SHALL emit `snapshot_ready` exactly once per invocation and before any
   `verification` event, SHALL emit `done` carrying `run_id` and `status` as the final event of
   every invocation, and SHALL emit no event of any type after that `done`, as the foundation
   spec's criteria 14.9 and 14.10 declare.
6. THE Agent_Runtime SHALL emit the `chart` event carrying the structured chart specification
   with each plotted value as a fixed-precision decimal string, the `encoding` as `categorical`
   or `sequential`, the chart data hash, and the ledger reference of every plotted figure, and
   SHALL set `encoding` from the emitting block's declared encoding rather than from the series
   count, so that no client infers a palette from the shape of the data.
7. THE Agent_Runtime SHALL emit the `delta` event for model-authored prose only, and SHALL emit
   no numeric string in a `delta` event that is absent from both the Figure_Ledger's
   `formatted` values and the static-text allowlist.
8. THE Agent_Runtime SHALL emit only event types the declared event vocabulary carries, and
   SHALL add no event type for the document phases, so that the cross-language event mirror the
   foundation spec's criterion 40.13 guards stays unchanged and a client that ignores an
   unrecognized type under the foundation spec's criterion 40.6 degrades rather than fails.
9. WHILE that run's stored verification status is pass, WHEN the Web_App receives a
   `report_file` event, THE Web_App SHALL present a download control for that artifact only
   once the presigned URL for that artifact key is available, and SHALL present no download
   control on receipt of the event alone, as criteria 40.1 and 40.4 declare.
10. WHEN the Web_App receives a `chart` event, THE Web_App SHALL render that chart client-side
    from the structured specification, SHALL parse each decimal string value for layout
    geometry only, SHALL take each displayed value label from the `formatted` value that the
    specification's ledger reference resolves to, and SHALL request no image and no presigned
    URL for that chart.
11. WHILE a run's `status` is `compiling`, `rendering` or `verifying`, THE Agent_Runtime SHALL
    emit consecutive events no more than 30 seconds apart, counting a `heartbeat` event as such
    an event and emitting `heartbeat` at an interval of 15 seconds with a tolerance of plus or
    minus 5 seconds, as the foundation spec's criteria 16.1 and 16.2 declare for the collection
    phases, so that a document phase producing no other event stays inside the SSE_Relay's
    120-second inactivity window.
12. IF 120 consecutive seconds elapse in which the Web_App receives no event of any type for a
    run whose `status` is non-terminal, THEN THE Web_App SHALL treat that elapsed window rather
    than a slow response as the disconnect signal, SHALL open a new stream for that run within
    5 seconds, SHALL reconstruct the displayed compile, render and verify state from that run's
    `report_runs` row together with that run's stored verification result before rendering, and
    SHALL request no event replay from the Agent_Runtime.
13. THE SSE_Relay SHALL carry no document-phase state that cannot be reconstructed from that
    run's `report_runs` row together with the stored verification result, and SHALL cause no
    change to a run's outcome when its stream closes during the compile, render or verify
    phase, because the relay is a view of the run row rather than the record of it.

#### Requirement 43: Artifacts, keys and browser-safe projections

**User Story:** As a security reviewer, I want the new artifacts to inherit the existing authorization
rule, so that adding a document does not widen who can read one.

##### Acceptance Criteria

1. THE Agent_Runtime SHALL write each report artifact of a run as a private object whose key
   carries the run's actor identifier as its first segment, `reports` as its second segment and
   the run identifier as its third segment, SHALL write for that run the rendered `.docx`, the
   rendered `.pdf`, the Figure_Ledger and the verification result, SHALL tag each of those
   objects with the owning actor identifier, and SHALL grant no public read on any of them, so
   that every read passes through a presigned URL minted server-side.
2. THE Web_App SHALL extend the artifact-key authorization predicate to accept a second key
   segment whose value is exactly `reports` in addition to a second key segment whose value is
   exactly `snapshots`, SHALL continue to compare the first key segment to the signed-in user's
   identifier by exact, case-sensitive segment equality, SHALL reject a second segment carrying
   any other value, and SHALL reject a key carrying fewer than the three segments criterion
   43.1 declares.
3. THE Web_App SHALL compare key segments by exact equality as criterion 43.2 declares, SHALL
   compare a key by no prefix test, no substring test and no pattern test, and SHALL reject a
   key whose first segment equals the signed-in user's identifier followed by one or more
   further characters, because a prefix test authorizes a key whose first segment merely begins
   with the signed-in user's identifier.
4. WHEN the Web_App extends `RunView` with the template name, the pinned version and the
   verification status, THE Projection_Guard SHALL assert the extended sorted key set as an
   exact set equality rather than as a containment check in the same change, and SHALL assert
   that `RunView` carries no `progress_token_hash` value, no `claimed_by` value and no
   `dedupe_key` value, so that a newly added column reaches the browser only through an
   explicit reviewed test change.
5. THE Web_App SHALL define a browser-safe projection for a template version carrying the
   version number, the definition digest and the created instant, SHALL exclude every field of
   a connected subscription from that projection, and THE Projection_Guard SHALL assert that
   projection's exact sorted key set.
6. THE Projection_Guard SHALL assert that the serialization of a verification-result
   projection, and of every other browser-safe projection this spec defines, contains no
   `progress_token_hash` value, no client secret ciphertext and no unmasked subscription
   identifier, and SHALL fail on a projection whose serialization carries any of those three
   values.
7. THE Agent_Runtime SHALL apply the redaction scrub to the verification result and to every
   finding message before writing that result and before emitting that result in an event,
   SHALL apply that scrub to every quoted service error message a finding carries, and SHALL
   truncate each quoted document excerpt a finding message carries to at most 200 characters,
   because a finding message can quote document text or a service error.
8. IF the artifact-key authorization predicate rejects a requested key, THEN THE Web_App SHALL
   make no storage call, SHALL mint no presigned URL, SHALL resolve that request as not found,
   and SHALL disclose neither whether an object exists at that key nor any segment of that key.
9. THE Web_App SHALL define exactly one browser-safe projection per secret-bearing table, SHALL
   pass to a client component, to a server-rendered payload and to a route-handler response
   only the browser-safe projection declared for the table the data was read from, and SHALL
   pass a row read from `connected_subscriptions`, `report_runs`, `report_verifications`,
   `report_templates` or `report_template_versions` in no other shape.
10. IF the redaction scrub finds a registered secret value within a verification result, within
    a finding message or within a quoted service error, THEN THE Agent_Runtime SHALL replace
    that value with a fixed redaction marker, SHALL retain that finding carrying the remainder
    of its message, and SHALL write and emit no unredacted copy of that result.

---

### Section H — Mandatory negative tests

A gate that has never been observed to fail is not a gate. The criteria in this section are
requirements rather than a testing footnote, and each one asserts a **failure**: the test passes
only when the verification fails for the stated reason and no artifact is delivered.

#### Requirement 44: Every blocking gate is observed failing

**User Story:** As a reviewer, I want each gate demonstrated failing on a deliberately broken
document, so that a green suite means the gates work rather than that nothing tried them.

##### Acceptance Criteria

1. THE Verifier SHALL have at least one test per blocking verification finding type that
   constructs an input producing that finding and asserts the verification result's status is
   fail, so that no blocking finding type is declared and never observed; and THE Agent_Runtime
   SHALL enumerate in its test suite the 16 blocking finding types the Glossary declares and
   SHALL fail IF any of those 16 types is asserted by zero tests, so that a blocking finding
   type added later without a test fails the suite rather than being declared and never
   exercised.
2. WHEN the agent test suite replaces exactly one digit character of exactly one figure's
   `formatted` string in a rendered `.docx` with a different digit character, such that the
   mutated string equals no `formatted` string in the Figure_Ledger, while leaving the
   Figure_Ledger, the anchor set and every other rendered character unchanged, THE Verifier
   SHALL set the verification result's status to fail, SHALL record `table_cell_mismatch`
   naming the table identity, the row key, the column key, the expected string and the observed
   string where the mutated figure is a table figure, SHALL record `unmatched_prose_token`
   naming the surviving mutated substring together with its block identifier and paragraph
   ordinal where the mutated figure is a prose figure, THE Run_State_Machine SHALL set that
   run's `status` to `failed` carrying `error_code` `VERIFICATION_FAILED`, and THE Web_App
   SHALL present no download control for that run.
3. WHEN the agent test suite transposes the cell text of two columns of one data table in a
   rendered `.docx` across every data row of that table, that table carrying at least 2 columns
   and at least 2 data rows whose transposed values differ pairwise, while leaving the
   Figure_Ledger unchanged and leaving every transposed value present somewhere in that
   document, THE Verifier SHALL set the verification result's status to fail and SHALL record
   one `table_cell_mismatch` finding for each anchor whose resolved cell text changed; and that
   test SHALL additionally assert that a containment check asserting each `formatted` string
   appears somewhere in that same document records zero discrepancies, so that the test fails
   against a verifier checking token containment rather than anchored cell equality.
4. WHEN the agent test suite renders a data block whose resolved scope contains at least one
   resource and whose emitted data table carries a `w:tblCaption` identity, zero data rows and
   no no-resources-matched row, THE Verifier SHALL set the verification result's status to
   fail, SHALL record `table_rows_absent` naming that table identity, THE Run_State_Machine
   SHALL set that run's `status` to `failed` carrying `error_code` `VERIFICATION_FAILED`, and
   THE Web_App SHALL present no download control for that run.
5. WHEN the agent test suite renders a block whose resolved scope contains zero resources while
   every other block of that pinned template version renders at least one data row, THE
   Verifier SHALL set the verification result's status to pass, THE rendered document SHALL
   carry the explicit no-resources-matched row criterion 3.7 declares, THE Verifier SHALL
   record zero `table_rows_absent` findings and zero blocking findings, and THE Agent_Runtime
   SHALL emit a `report_file` event for that run, so that the suite proves the distinction
   between a legitimately empty scope and a block that failed to render its rows rather than
   conflating the two with criterion 44.4.
6. WHEN the agent test suite alters the chart data hash recorded in an embedded chart image's
   sidecar to a value differing from the hash recomputed from that chart's plotted decimal
   strings in plotted order, while leaving those plotted decimal strings, the companion data
   table and the Figure_Ledger unchanged, THE Verifier SHALL set the verification result's
   status to fail, SHALL record `chart_hash_mismatch` naming that chart node's AST path, the
   expected hash and the observed hash, THE Run_State_Machine SHALL set that run's `status` to
   `failed` carrying `error_code` `VERIFICATION_FAILED`, and THE Web_App SHALL present no
   download control for that run.
7. WHEN the agent test suite converts a rendered `.docx` whose Figure_Ledger carries at least
   one figure with a nonzero count of fractional digits to `.pdf` with `LANG` set to a locale
   whose decimal separator is a comma rather than to the `C.UTF-8` value criterion 23.3 pins,
   THE Verifier SHALL set the verification result's status to fail, SHALL record
   `pdf_figure_missing` naming at least one Figure_Ledger entry whose `formatted` string
   carries a decimal separator together with that entry's AST path and that entry's `formatted`
   string, THE Run_State_Machine SHALL set that run's `status` to `failed` carrying
   `error_code` `VERIFICATION_FAILED` rather than `PDF_CONVERSION_FAILED`, and THE Web_App
   SHALL present no download control for that run, so that the pinned `LANG` value of criterion
   23.3 is demonstrated to be load-bearing rather than incidental.
8. WHEN the agent test suite runs a report against a connected subscription whose client secret
   is expired such that the run's union of the template default scope and every block
   `scope_override` resolves to zero resources, THE Agent_Runtime SHALL report a terminal code
   of `EMPTY_SCOPE` or `AUTH_EXPIRED`, SHALL write no snapshot, SHALL compile no document,
   SHALL render no document and SHALL write no report artifact, THE Run_State_Machine SHALL set
   that run's `status` to `failed` carrying that reported terminal code, and THE Web_App SHALL
   present no download control and no verification result carrying a status of pass for that
   run.
9. WHEN the agent test suite mutates exactly one decimal string of exactly one archived raw
   response of a stored run before a replay, while leaving the stored `snapshot_id`, the
   archive sequence and the count of archived objects unchanged, THE Replay_Verifier SHALL
   record `replay_hash_mismatch` carrying the recomputed digest and the stored digest, THE
   Verifier SHALL set the verification result's status to fail, and THE Agent_Runtime SHALL
   report the terminal code `REPLAY_MISMATCH`.
10. WHEN the agent test suite constructs a rendered document from which exactly one
    Figure_Ledger entry's rendered text is removed while that entry remains in the
    Figure_Ledger and every other entry remains rendered, THE Verifier SHALL set the
    verification result's status to fail and SHALL record `ledger_entry_unrendered` naming that
    entry's AST path.
11. WHEN the agent test suite constructs a snapshot containing at least one resource and whose
    `scope_verified` value is false, THE Verifier SHALL set the verification result's status to
    fail and SHALL record `scope_unverified`, and THE Verifier SHALL record no `empty_scope`
    finding for that snapshot, so that the recorded failure is attributable to the unverified
    scope rather than to a zero-resource snapshot.
12. FOR ALL negative tests in this section, THE Agent_Runtime SHALL assert that the count of
    `report_file` events emitted for that run is zero, that no presigned URL was minted for any
    artifact key of that run, and that every route, action and control of the Web_App returns
    no presigned URL for that run's rendered document.
13. FOR ALL negative tests in this section that mutate a rendered document, an embedded image
    sidecar, an archived raw response or a conversion environment, THE Agent_Runtime SHALL
    assert that the unmutated fixture that test derives its input from produces a verification
    result whose status is pass carrying zero blocking findings, before that test applies its
    mutation, so that the recorded failure is attributable to the mutation rather than to a
    defect in the fixture.
14. FOR ALL negative tests in this section, THE Agent_Runtime SHALL assert that the set of
    blocking finding types recorded on the verification result is exactly the set of blocking
    finding types that test declares as expected, and SHALL fail IF a blocking finding of an
    undeclared type is recorded, so that a test cannot pass by failing for a reason other than
    the stated one.
15. THE Agent_Runtime SHALL execute every negative test in this section before a change in this
    spec is committed, and SHALL fail IF a negative test in this section is skipped or is
    marked as an expected failure, because a gate whose negative test does not run is a gate
    that has never been observed failing.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a
system — essentially, a formal statement about what the system should do. Properties serve as the
bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The pure modules this spec adds are exactly the kind of code where a plausible implementation is
silently wrong across a large input space: a formatter, a tokenizer, a masking pipeline, a replay
aggregation and a sample selector. Each property below is written so that it **fails on the naive
implementation it exists to rule out**.

Three of the pure modules the workspace requires to be property-tested — count-weighted averaging,
exact minimum and maximum roll-up, and local-day bucketing at the `Asia/Jakarta` offset — are already
covered by the foundation spec's Property 1 and Property 6. This spec **re-runs those two properties
unchanged as a regression gate** rather than restating them, because the compile and verify stages
consume the values those properties protect.

#### Requirement 45: Property-based verification

**User Story:** As a reviewer, I want this spec's correctness claims machine-checked across generated
inputs, so that the properties the delivered document depends on are not maintained by review alone.

##### Acceptance Criteria

1. THE Agent_Runtime SHALL execute every agent-side property this section declares — Property 1
   through Property 7 — with `hypothesis` at a minimum of 100 accepted generated examples per
   property, and THE Web_App SHALL execute every web-side property this section declares with
   `fast-check` at a minimum of 100 accepted generated cases per property, in the test suite
   that runs before a change in this spec is committed.
2. THE Agent_Runtime SHALL execute the foundation spec's Property 1 covering count-weighted
   averaging and exact minimum and maximum roll-up, and the foundation spec's Property 6
   covering local-day bucketing at the `Asia/Jakarta` UTC+07:00 offset, in that same suite, at
   a minimum of 100 accepted generated examples each, with their generators, their assertions
   and their declared examples unmodified by this spec, so that a regression in the values the
   compile and verify stages consume fails this spec's suite.
3. IF a property in this section or either foundation property criterion 45.2 names fails, THEN
   THE Agent_Runtime SHALL report, for an agent-side property, the shrunk counterexample
   `hypothesis` returns together with the seed that reproduces that failure, and THE Web_App
   SHALL report, for a web-side property, the shrunk counterexample `fast-check` returns
   together with the seed that reproduces that failure, so that the failure is re-runnable
   without regenerating cases.
4. IF a property in this section or either foundation property criterion 45.2 names is skipped,
   is marked as an expected failure, declares fewer than 100 generated cases or examples, has
   its generation reported as exhausted before 100 cases or examples are accepted, or rejects
   more than 20 percent of its generated cases or examples through a precondition, THEN THE
   Agent_Runtime SHALL fail its test suite for an agent-side property and THE Web_App SHALL
   fail its test suite for a web-side property, and neither SHALL record that property as
   passed, as the foundation spec's criteria 42.6 and 42.7 declare.
5. WHEN a defect exposed by a failing property in this section is fixed, THE Agent_Runtime
   SHALL retain that failure's shrunk counterexample as an explicitly declared example that
   runs on every subsequent execution of that agent-side property, THE Web_App SHALL retain
   that failure's shrunk counterexample as an explicitly declared case that runs on every
   subsequent execution of that web-side property, and each retained example or case SHALL run
   in addition to the 100-case minimum criterion 45.1 declares rather than counting toward it.
6. THE Web_App SHALL keep `pnpm lint` and `pnpm typecheck` reporting zero errors, and THE
   Agent_Runtime SHALL keep its linter reporting zero errors, before any change in this spec is
   committed.
7. IF the set of properties executed for this section differs from the set of properties this
   section declares, or IF a property this section declares is collected and does not execute,
   THEN THE Agent_Runtime SHALL fail its test suite for an agent-side property and THE Web_App
   SHALL fail its test suite for a web-side property, so that a property added to this document
   and never registered, or registered and never run, fails the suite rather than passing
   silently.
8. WHEN the suite this requirement declares completes, THE Agent_Runtime SHALL record for each
   agent-side property the executing framework, the count of accepted generated examples, the
   fraction of generated examples a precondition rejected, and the seed that execution used,
   and THE Web_App SHALL record those same four values for each web-side property, so that the
   thresholds criterion 45.4 declares are observable in the suite's own output rather than
   assumed.
9. IF either foundation property criterion 45.2 names is absent from this spec's suite, does
   not execute, or fails, THEN THE Agent_Runtime SHALL fail this spec's suite, SHALL report
   which of those two properties was absent, unexecuted or failing, and SHALL record no passing
   result for this requirement, so that the regression gate cannot be satisfied by a suite in
   which the two protected properties never ran.

#### Property 1 — Formatting is total, deterministic and the single display path (agent, hypothesis)

*Invariant / round-trip.* Generate decimal values, units, catalog scales and number formats, then
format each value through the Formatter.

##### Acceptance Criteria

1. FOR ALL generated decimal values, ALL declared units and ALL declared number formats, THE Formatter
   SHALL produce an identical `formatted` string on every call for one such triple.
2. FOR ALL generated decimal values, THE Formatter SHALL produce a `formatted` string whose digits
   parse back to the value quantized to that value's catalog-declared fractional-digit count, so that
   a formatted string loses no digit the catalog declared significant.
3. FOR ALL generated values carrying an `estimator` marking the value as estimated, THE Formatter SHALL
   produce a `formatted` string containing the estimator label the Estimator_Labeller produced, and
   SHALL produce no `formatted` string carrying a bare percentile designation.
4. WHEN the agent test suite generates a case for this property, THE Agent_Runtime SHALL draw values
   including the decimal strings `0`, `0.000001`, `-0.5`, `9007199254740993`, `0.1` and
   `0.30000000000000004`, and SHALL draw number formats including one whose decimal separator is a
   comma and one whose thousands separator is a period, so that the property fails against an
   implementation that round-trips a value through a binary floating-point number or hard-codes a
   separator.
5. FOR ALL generated values, THE Formatter SHALL contain no `float` on the path from the value to the
   `formatted` string, asserted by a guard that raises on a `float` reaching that path.
6. FOR ALL pairs of generated values that differ, THE Formatter SHALL produce `formatted` strings that
   differ, unless both values quantize to the same value at that unit's declared scale.

#### Property 2 — Token extraction and prose masking (agent, hypothesis)

*Invariant.* Generate documents whose figures are split across runs and whose prose embeds
identifiers, dates, durations, resource identifiers and template chrome, then extract and mask.

##### Acceptance Criteria

1. FOR ALL generated figures and ALL splits of a figure's `formatted` string across 1 to 5 consecutive
   runs of one paragraph, THE Token_Extractor SHALL extract that figure as one token equal to that
   `formatted` string.
2. WHEN the agent test suite generates a case for this property, THE Agent_Runtime SHALL include the
   declared example of the string `1,234.56` split across the three runs `1,`, `234.` and `56`, so that
   the property fails against an implementation tokenizing each run separately.
3. FOR ALL generated paragraphs containing only figures from the Figure_Ledger, identifiers matching the
   pattern criterion 28.3 declares, globally unique identifiers, Azure resource identifiers, internet
   protocol addresses, classless inter-domain routing suffixes, calendar dates, timestamps, ISO 8601
   durations and static-text allowlist strings, THE Verifier SHALL record zero
   `unmatched_prose_token` findings.
4. FOR ALL generated paragraphs into which one numeric string absent from the Figure_Ledger and absent
   from the allowlist is inserted, THE Verifier SHALL record at least one `unmatched_prose_token`
   finding naming that inserted string.
5. FOR ALL generated Figure_Ledger sets containing one `formatted` string that is a proper substring of
   another `formatted` string, THE Verifier SHALL mask the longer string before the shorter one and
   SHALL record zero `unmatched_prose_token` findings for a paragraph containing only those two
   strings, so that the property fails against an implementation masking in ledger insertion order.
6. WHEN the agent test suite generates a case for this property, THE Agent_Runtime SHALL include the
   declared examples of a resource identifier containing digits, a grain of `PT1H`, a window date of
   `2026-07-01`, and an identifier beginning with a letter and containing a digit such as
   `prod-sql-01`, so that the property fails against a masking pipeline omitting a stage.
7. FOR ALL generated documents, THE Token_Extractor SHALL extract the concatenated text of every
   paragraph the document body carries, including paragraphs nested inside data tables and layout
   tables, so that the property fails against an implementation reading the paragraph collection the
   document object exposes.

#### Property 3 — Anchored cell equality detects transposition (agent, hypothesis)

*Metamorphic.* Generate data tables with anchors, then apply value-preserving mutations that a
containment check cannot detect.

##### Acceptance Criteria

1. FOR ALL generated data tables and their anchors, THE Verifier SHALL record zero findings for the
   unmutated rendered table.
2. FOR ALL generated data tables carrying at least 2 columns and at least 2 rows whose values differ,
   and ALL transpositions of two of those columns' values, THE Verifier SHALL record at least one
   `table_cell_mismatch` finding, so that the property fails against a verifier asserting containment
   of a figure's string anywhere in the document.
3. FOR ALL generated data tables and ALL permutations of that table's column order and row order that
   move each value with its header and its row key, THE Verifier SHALL record zero findings, so that
   the property fails against a verifier resolving a column or a row by ordinal position.
4. FOR ALL generated data tables and ALL single-cell mutations of one rendered value, THE Verifier SHALL
   record a `table_cell_mismatch` finding naming that cell's table identity, row key and column key.
5. FOR ALL generated rendered documents carrying a layout table containing numeric text, THE Verifier
   SHALL record no table finding for that layout table, because a layout table carries no
   `w:tblCaption`.
6. FOR ALL generated rendered documents in which one data table's `w:tblCaption` identity is removed,
   THE Verifier SHALL record a `table_anchor_missing` finding.

#### Property 4 — Replay produces a bit-identical snapshot digest (agent, hypothesis)

*Round-trip / model-based.* Generate archived raw response sets, aggregate them twice, and compare
digests.

##### Acceptance Criteria

1. FOR ALL generated archived raw response sets, THE Replay_Verifier SHALL produce a snapshot digest
   equal to the digest the original aggregation over that same set produced.
2. FOR ALL generated archived raw response sets, THE Replay_Verifier SHALL produce an identical digest
   when the aggregation runs in two separate operating-system processes started from one commit with
   differing interpreter hash-randomization seeds.
3. FOR ALL generated archived raw response sets, THE Replay_Verifier SHALL make zero network requests,
   asserted by a test double that fails the property IF any network call is attempted.
4. FOR ALL generated archived raw response sets and ALL single-value mutations of one archived response,
   THE Replay_Verifier SHALL produce a digest differing from the stored digest, so that the property
   fails against a replay that recomputes nothing and returns the stored digest.
5. FOR ALL generated archived raw response sets, THE Replay_Verifier SHALL fold each archived object
   exactly once, asserted by a counter on the fake object store, so that the property fails against a
   replay that double-folds or skips an object.

#### Property 5 — Drift sample selection is bounded and reproducible (agent, hypothesis)

*Invariant.* Generate snapshots, documents naming a subset of resources, and seeds, then select the
drift sample.

##### Acceptance Criteria

1. FOR ALL generated snapshots, documents and seeds, THE Drift_Sampler SHALL select a sample of at most
   25 resources.
2. FOR ALL generated snapshots, documents and seeds, THE Drift_Sampler SHALL select an identical sample
   for one triple of snapshot, document and seed on every call.
3. FOR ALL generated snapshots and documents whose named resources number at most 25, THE Drift_Sampler
   SHALL include every resource named in that document in the selected sample.
4. FOR ALL generated snapshots carrying at least 10 resources, THE Drift_Sampler SHALL include the 10
   resources carrying the highest maximum for the report's primary metric, subject to the 25-resource
   cap criterion 1 of this property declares.
5. FOR ALL generated snapshots, THE Drift_Sampler SHALL select every sampled resource from that
   snapshot's resources and SHALL select no resource absent from that snapshot.
6. FOR ALL generated snapshots carrying more than 250 resources, THE Drift_Sampler SHALL select exactly
   25 resources, so that the property fails against a selector that grows the sample with the snapshot.
7. FOR ALL pairs of distinct generated seeds over one snapshot carrying more than 25 resources, THE
   Drift_Sampler SHALL select samples that differ in at least one resource, so that the property fails
   against a selector ignoring the seed.
8. FOR ALL generated snapshots, THE Drift_Sampler SHALL express the selection as a pure operation making
   no network request.

#### Property 6 — The ledger and the document AST agree in both directions (agent, hypothesis)

*Invariant.* Generate template definitions and snapshots, compile them, then compare the ledger against
the AST and against the rendered document.

##### Acceptance Criteria

1. FOR ALL generated definition and snapshot pairs, THE Figure_Ledger SHALL record exactly one entry per
   figure node of the compiled document AST, keyed by that node's path.
2. FOR ALL generated definition and snapshot pairs, THE Figure_Ledger SHALL record no entry whose AST
   path addresses no node of that compiled tree.
3. FOR ALL generated definition and snapshot pairs, THE Block_Compiler SHALL emit an identical document
   AST and THE Figure_Ledger SHALL record an identical entry set carrying identical `formatted` values
   for two compilations over that pair.
4. FOR ALL generated definition and snapshot pairs, THE Verifier SHALL record zero
   `ledger_entry_unrendered` findings against the document the Docx_Renderer emitted from that
   compilation.
5. FOR ALL generated definition and snapshot pairs in which one block's resolved scope contains zero
   resources, THE Block_Compiler SHALL emit that block carrying the explicit no-resources-matched row
   and zero figure nodes, and THE compiled tree SHALL contain a node for that block, so that the
   property fails against a compiler that omits an empty block.
6. FOR ALL generated definition and snapshot pairs, THE AST_Model SHALL carry no numeric value outside a
   figure node, asserted by a walk that fails the property on a numeric value in any other position.

#### Property 7 — Scope resolution is deterministic and snapshot-only (agent, hypothesis)

*Invariant / confluence.* Generate snapshots and scope specifications including top-N ordering, then
resolve each specification.

##### Acceptance Criteria

1. FOR ALL generated snapshots and scope specifications, THE Scope_Resolver SHALL resolve an identical
   ordered resource list on every call for one such pair.
2. FOR ALL generated snapshots, ALL permutations of that snapshot's resource array order, and ALL scope
   specifications, THE Scope_Resolver SHALL resolve an identical ordered resource list, so that the
   property fails against a resolver whose output depends on the order responses arrived in.
3. FOR ALL generated scope specifications carrying a top-N count, THE Scope_Resolver SHALL resolve at
   most N resources, SHALL order those resources by the named metric and statistic descending, and SHALL
   break a tie by resource identifier ascending in Unicode code-point order.
4. FOR ALL generated snapshots and scope specifications, THE Scope_Resolver SHALL make no network
   request, asserted by a test double that fails the property IF any call is attempted.
5. FOR ALL generated snapshots and scope specifications resolving to zero resources, THE Scope_Resolver
   SHALL resolve an empty list and SHALL raise no error, because an empty block scope is an ordinary
   compile outcome.
6. FOR ALL generated definitions, THE Agent_Runtime SHALL request a collection scope equal to the union
   of the template default scope and every block `scope_override`, so that the property fails against an
   implementation requesting only the template default.

---

## Traceability — the mandated gates

Every gate and every negative test the request declares, mapped to the criteria that make it testable.

| Mandated item | Criteria |
|---|---|
| Template is subscription-agnostic rules, never resource identifiers | 1.2, 1.3, 1.6 |
| Seven wizard steps in order | 11.1 |
| Relative period resolved fresh at each run | 4.1, 4.3, 4.4, 4.5, 11.7 |
| Metric selection per resource type governed by the catalog | 5.1, 5.2, 5.4, 5.6 |
| The declared block palette and the layout grammar | 6.1, 6.2, 6.3, 6.4, 6.5 |
| One level of nesting; a row refuses a row, visibly | 6.4, 12.9 |
| Four styles-only themes; a missing style fails the build | 8.1, 8.2, 8.3, 8.4, 8.5, 8.6 |
| Presets as real rendered thumbnails, never names alone | 13.1, 13.2, 13.3, 13.8 |
| Immutable versioning; a run pins a version | 9.1, 9.2, 9.3, 9.4, 9.6, 9.7, 9.8 |
| Three starter templates | 10.1, 10.2, 10.3, 10.5 |
| Keyboard-accessible reordering with announcements | 12.3, 12.4, 12.5, 12.6, 12.7, 12.13, 12.14 |
| HTML preview is an approximation; the PDF is the truth | 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.10 |
| No document-templating library and no user-facing template language | 11.6, 20.2 |
| Figure is the only numeric leaf; provenance is structural | 15.2, 15.3, 15.4, 15.8, Property 6.6 |
| The ledger and the render context are the same object | 17.2, 17.3, 17.8, Property 6.1, 6.2 |
| One formatting path; estimator labels from the ledger; no bare percentile | 18.1, 18.2, 18.6, 18.7, 18.8, Property 1.3 |
| Scope resolved against the snapshot only; union collected once | 3.3, 3.4, Property 7.4, 7.6 |
| A zero-resource block renders an explicit row and never vanishes | 3.7, 3.8, 16.11, 27.11, 44.5 |
| Data tables always carry a caption; layout tables never do | 21.1, 21.2, 26.5, Property 3.5 |
| Anchored cell equality, not token containment | 27.1, 27.2, 27.3, 27.9, Property 3.2, 3.3 |
| Ordered prose masking with a derived static-text allowlist | 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7, 28.11 |
| Extraction walks the body and tokenizes concatenated paragraphs | 26.1, 26.2, 26.3, 26.6, Property 2.1, 2.2, 2.7 |
| Bidirectional ledger completeness | 29.1, 29.2, 29.3, 29.4 |
| Charts carry a companion data table and a matching data hash | 22.1, 22.2, 22.3, 30.1, 30.2, 30.3, 30.4 |
| Deterministic replay with zero Azure calls | 31.1, 31.2, 31.4, 31.7, Property 4.1, 4.2, 4.3 |
| `scope_verified` true and an empty in-scope result is a hard failure | 32.1, 32.3, 32.4 |
| PDF fidelity over every ledger string | 33.1, 33.2, 33.3, 33.5, 33.6 |
| Advisory sampled drift, bounded and seeded | 34.1, 34.2, 34.3, 34.4, 34.6, 34.7, Property 5 |
| Advisory prose review over narrative and the aggregate table only | 35.1, 35.2, 35.3, 35.5 |
| DOCX to PDF via LibreOffice with `LANG`, `--norestore` and a warmed profile | 23.1, 23.2, 23.3, 23.4, 23.5 |
| Verification is the delivery gate; no unverified download path | 25.1, 25.2, 25.3, 25.4, 40.1, 40.4, 42.4 |
| Negative test — one number mutated | 44.2 |
| Negative test — two table columns transposed | 44.3 |
| Negative test — a block that rendered zero rows | 44.4, 44.5, 44.13 |
| Negative test — a chart data hash mismatch | 44.6 |
| Negative test — a PDF converted under a comma-decimal locale | 44.7 |
| Negative test — an expired secret producing an empty scope | 44.8 |
| Every blocking finding type observed failing | 44.1, 44.12, 44.14, 44.15 |
| Report detail with hover provenance and an audit-certificate panel | 37.2, 38.1, 38.2, 38.3, 39.1, 39.2, 39.3 |
| Figures in monospace tabular; `--destructive` reserved; no animated numerals | 24.3, 37.3, 37.5, 39.6, 22.12 |
| Categorical palette by stable key, capped at five, never colour alone | 22.7, 22.8, 22.9, 22.10, 22.11 |
| Additive schema growth only | 9.10, 41.2, 41.6, 43.4 |
| Charts are legible without colour and in both themes | 22.10, 22.11, 22.12, 22.15 |
| Events are a view, not the record; heartbeat is mandatory | 42.11, 42.12, 42.13 |
