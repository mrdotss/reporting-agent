# Requirements Document

## Introduction

This spec replaces **composition with selection**. Today a consultant reaches one fixed
deliverable — cover, document control, contents, inventory sections, utilization sections,
then backup, incident and recommendations — by assembling it out of generic primitives
(`heading`, `row`, `kpi_row`, `timeseries_chart`) in a seven-step wizard, choosing metrics
from a catalogue that shows resource types the subscription does not contain, and editing
list-valued block config as raw JSON. Every one of those choices is made **blind**: nothing in
the authoring flow knows what is actually in the subscription, so an empty section is
discovered in the delivered PDF and a refused metrics region is discovered when a run finishes.

The new flow is **scan-first**: *connect a subscription → scan it → author a Report Profile in
five steps → run*. The scan is what makes selection possible, because a section can only be
offered once something knows the types are there.

It builds on three **completed** specs — `reporting-agent-foundation`,
`reporting-agent-templates-reports` and `reporting-agent-breadth-and-document` — and **does not
restate them**. Authentication, Azure onboarding, the `scope_verified` preflight, the collector,
the immutable content-addressed snapshot, the raw archive, the `report_runs` state machine, the
progress callback, the reaper, the SSE relay, the redaction guard, the metric and fact catalogues,
the document AST, the figure ledger, the two emitters, `front_matter`, the verifier and its
blocking finding types are **already specified and built**. Where a criterion below extends one
of those it names the spec and criterion it extends; where it depends on one unchanged it
references rather than duplicates.

The design mockups in `/home/mrdotss/workplace/reporting-agent/design` (`Main.dc.html`,
`Scan.dc.html`, `ScanFull.dc.html`, `Sections.dc.html`, `Document.dc.html`, `Brand.dc.html`,
`Charts.dc.html`, and the two delivered-report mockups `ReportA.dc.html` / `ReportB.dc.html`)
are the visual statement of this spec's intent. Where a criterion below describes a surface,
that mockup is the shape being described.

### The invariant does not move

**No LLM ever produces a number.** Nothing in this spec touches the verification model.
Three consequences are load-bearing rather than restated for emphasis:

- A **section is a compiler input, not a document primitive.** A section resolves to the same
  typed AST nodes blocks resolve to today, so every numeric leaf is still a `Figure` carrying
  its own `snapshot_path`, the figure ledger is still the render context, and anchored cell
  equality, ordered prose masking, bidirectional ledger completeness, chart data hashes, PDF
  extractability and deterministic replay all still run **unchanged**.
- **Selection by rule is already how the compiler works.** `compile/scope.py`'s `resolve`
  filters `view.resources` by `matches(scope, resource)` over resource type, resource group and
  tag filters, and `union_scope` widens those dimensions for the collector. This spec removes the
  *possibility* of a frozen id list from the authoring surface and adds a **record** of what each
  rule matched at authoring time; it does not change how resolution works.
- **A chart stays a view of verified figures.** Panelling a chart changes how a figure is drawn,
  never where it came from. Every plotted point is still a ledger `Figure`, and the chart data
  hash still describes the same plotted set as the image and the companion table.

### What is wrong today, precisely

Every row is verified against the implementation, and each is cited by the criterion that
corrects it.

| Observed | Where |
|---|---|
| Seven wizard steps, of which `Scope`, `Metrics`, `Blocks` and `Design` all exist to reach one fixed document shape | `app/lib/templates/wizard.ts`, `WIZARD_STEPS` |
| The metric picker renders **every** catalogue resource type, merely partitioned into `In scope` and `Other resource types` — so a subscription holding two of the seven declared types still scrolls past all seven | `app/components/templates/metric-picker.tsx`, `buildPartitions` |
| Seventeen block types are offered as authoring primitives, each with a `required`/`optional` config contract the author must satisfy by hand | `app/lib/templates/blocks.ts`, `BLOCK_TYPES` / `BLOCK_CONFIG` |
| A block's list-valued config is edited as raw JSON text, parsed on blur | `app/components/templates/block-inspector.tsx`, `fieldValue` / `parseFieldValue` |
| Branding (`preset`, `accent_color`, `density`, `table_style`, `page_size`, `number_format`, `cover_page`, `logo`) is stored **per template**, so it is re-picked for every customer | `app/lib/templates/definition.ts`, `DesignSpec`; `app/components/templates/step-design.tsx` |
| There is no account-level entity of any kind. `report_templates.user_id` is the only ownership column, and no `accounts`, `organizations`, `brands` or `settings` table exists | `app/lib/db/schema.ts`; migrations `0000`–`0006` |
| Nothing in the app knows how many resources of each type exist. `list_inventory` returns **distinct values only** — `resource_types`, `resource_groups`, `tag_keys`, `tag_values`, each `{values, truncated}` capped at `DISTINCT_VALUE_LIMIT` 2000 — and carries no count | `agent/.../azure/inventory.py`, `InventoryDimensions`; `app/app/api/subscriptions/[id]/inventory/route.ts` |
| A region whose batch metrics endpoint refuses every caller is rerouted correctly at run time and recorded in `collection_log`, but there is no authoring-time surface on which it appears | `agent/.../azure/regions.py`; `.kiro/steering/azure-integration.md` § "The data plane can refuse every caller" |
| `customer_name`, `revision`, `note` and `author` are collected on the **run** screen and re-typed for every report | `app/components/reports/run-form.tsx`; `agent/.../report_pipeline.py`, `_resolve_run_facts` |
| No approver signature image is stored anywhere. `ApproverConfig` is `{role, name, title}`, and the signature cell is **unconditionally** empty | `app/lib/templates/definition.ts`, `APPROVER_ROLES`; `agent/.../render/front_matter.py`, `_emit_approvers_table` |
| A chart is one matplotlib subplot with one y-axis auto-scaled over the union of every series' range, so a series spanning 0.13 points renders as a flat line beside one peaking at 18.32 | `agent/.../render/charts.py`, `figure.add_subplot(111)` |
| Every point of a series of 24 points or fewer is value-labelled, so a monthly chart carries a printed number at every vertex as well as in the table beside it | `agent/.../render/charts.py`, `label_indices` / `_LABEL_THRESHOLD` |
| There is no `provider` field. Azure is assumed structurally, so a second provider has nowhere to attach | `app/lib/templates/definition.ts`, top-level keys |

Two of these are **already half-built** and the criteria below extend rather than replace:
selection by rule is what `compile/scope.py` already does, and a live inventory endpoint already
exists at `app/app/api/subscriptions/[id]/inventory/route.ts` — it simply cannot report counts,
because the command behind it does not compute them.

### Scope boundary

| In scope | Out of scope |
|---|---|
| The user-facing noun `Report Profile`, its routes, and its message-catalogue copy | Renaming the `report_templates` / `report_template_versions` tables, or any wire field naming a template version |
| A `Brand` entity owned by the signed-in user, referenced by every profile | Teams, organizations, or any multi-user ownership model |
| `provider` as a first-class profile field, with `azure` as the only live value | AWS and on-prem section catalogues, collectors or metric entries |
| A scan that reports counts by type, groups, regions, offerable sections and authoring-time collection problems | A continuous or scheduled scan; a scan that mutates a profile |
| A five-step wizard whose step 2 is an ordered section list with an inspector | A page-level layout editor; free positioning; live multi-user editing |
| Selection rules only, plus a record of what each rule matched when authored | A resource picker that stores resource ids |
| Document details on the profile, including per-role signature images | A signature-drawing surface; digital (cryptographic) signatures |
| Split-scale panelled charts, three-cue series identity, last-value-only labels | A charting DSL; user-authored chart styling |
| Four new Azure collectors — VNet, public IP, NSG rules, Advisor — phased after the UI | Any collector for a section the catalogue does not declare |
| Lifting existing `schema_version` 2 definitions into the new model | Rewriting any stored template version; any change to the verification model |

**Two constraints on how this spec may grow the schema.** A template version is immutable
(templates spec criterion 9.3) and `MAX_SUPPORTED_SCHEMA_VERSION` is `2` in both halves today
(`app/lib/templates/definition.ts`, `agent/.../compile/definition.py`), so introducing `sections`,
`provider` and `brand_id` raises it to `3` and **both halves must keep accepting 1 and 2** — the
59-fixture corpus at `agent/tests/fixtures/definitions/` holds 44 fixtures at `schema_version` 1,
10 at `schema_version` 2 and 5 that are deliberately invalid (`schema_version` absent, `"1"` as a
string, `0`, `7`, `99`), and all three starters in `app/lib/templates/starters.ts` are stored at
version 1. Version 2 is therefore **already exercised in both directions** — the accepting
fixtures plus seven `reject-schema-version-2-*` fixtures guarding its rejection paths — so this
spec **adds version-3 fixtures rather than backfilling version-2 ones**.

Raising the maximum is safe for the five deliberately-invalid fixtures for a reason worth
recording rather than rediscovering: `agent/tests/fixtures/definitions/manifest.json` pins, per
fixture, a `verdict`, a `definition_sha256` and a list of **offender paths** — it does not pin
error message text, and no fixture asserts the maximum's literal value. So after the bump `99`,
`7`, `0`, `"1"`-as-a-string and absent all still reject at path `["schema_version"]`. The
corollary is a check on the work: because each fixture's `definition_sha256` is pinned, **editing**
an existing fixture forces the manifest to be regenerated — and since this spec's schema growth is
additive, no existing fixture should need editing, so a task that proposes editing one is a signal
that the change is not as additive as it was assumed to be.

And every migration this spec adds is
**additive**: `app/test/migrations.static.test.ts` fails the suite on any `DROP TABLE`,
`DROP COLUMN` or `DROP TYPE` of an object an earlier migration created, which is precisely why
the rename is a rename of the **noun**, not of the tables.

---

## Glossary

Vocabulary is used identically to `product.md`, `structure.md`, `design-system.md` and the three
completed specs. Terms marked **(system)** are the actors EARS criteria name in the
`THE <system> SHALL` position.

### Carried forward unchanged

- **snapshot** — the immutable, content-addressed result of one collection run, RFC 8785 (JCS)
  canonicalized and SHA-256 hashed. `snapshot_id` **is** that hash.
- **figure** — one numeric with its full provenance: `value` as a fixed-precision decimal string,
  `formatted`, `unit`, `snapshot_path`, `estimator`, `derived_from`, `formula`, `resource_id`,
  `metric`, `window`, `fidelity_tier`.
- **figure ledger** — every figure of one compiled AST, keyed by AST node path. The ledger and
  the render context are **the same object**.
- **fact** / **fact source** — one point-in-time datum about a resource, and the API it came
  from, drawn from `resource_graph`, `arm`, `recovery_services` and `capacity`
  (`DECLARED_FACT_SOURCES`, `agent/.../catalog/loader.py`).
- **collection_log** — the typed, per-resource record of gaps. A gap is recorded, never
  zero-filled.
- **verification result** — pass or fail plus every finding. A report without a passing
  verification is not a report.
- **template version** — an immutable row in `report_template_versions` carrying a `definition`
  and its `definition_sha256`. A run pins exactly one.

### Introduced or redefined by this spec

- **Report Profile** — the user-facing name for what is stored as a row in `report_templates`.
  It is a **per-customer engagement**: that customer's name, their subscription, their sections,
  their document numbering. It is not a reusable design, which is why it is no longer called a
  template.
- **Brand (system)** — the account-owned entity carrying the consultancy's own presentation
  decisions: theme preset, accent colour, logo, density, table style, page size, number format,
  default approver names per role, and confidentiality-notice text. One brand is referenced by
  many profiles.
- **provider** — the profile field naming which cloud the profile reports on (`azure` today;
  `aws` and `onprem` declared as planned and not selectable). The provider **selects the section
  catalogue**.
- **Section_Catalogue (system)** — the per-provider, code-owned declaration of every section a
  profile may contain. Each entry declares the section's canonical number, the resource types it
  needs, the fact sources it needs, whether it is metric-bearing, whether its position is fixed,
  and the AST it emits. It is code, reviewed like code — not user content.
- **section** — one selected entry of the section catalogue, carrying its selection rule, its
  metric selection where the entry is metric-bearing, its presentation choice, and its position.
  A section is the unit the author manipulates; blocks are no longer an authoring concept.
- **selection rule** — the stored expression of which resources a section covers: a resource
  type, optionally narrowed by resource group and tag filter. Structurally it is the
  `ScopeRules` the compiler already resolves. It **never** contains a resource id.
- **authored match record** — the count and resource-id set each section's selection rule
  matched **at the moment the profile version was saved**, stored on that version. It is what
  makes run-time drift reportable rather than invisible.
- **Scan (system)** — one authoring-time inventory of a connected subscription: counts by
  resource type, distinct resource groups, distinct regions, per-type metric and fact
  availability, and any collection problem observable without collecting metrics. A scan is
  **persisted** and referenced by the profile that was authored against it.
- **offerable** — a section catalogue entry all of whose declared resource types are present in
  the scan and all of whose declared fact sources are collected today. A section that is not
  offerable is **shown and disabled**, never hidden.
- **not-reportable type** — a resource type present in the scan for which no catalogue entry
  exists. It is listed and greyed so its absence from the report is visible.
- **emit summary** — the counts a section inspector states before any run: headings, charts,
  tables and figures the section will produce, computed from the scan and the section's own
  configuration.
- **panel** — one of the stacked plot areas of a split-scale chart. Panels share an x-axis and
  each carries its own independent y-scale.
- **Migration_Lifter (system)** — the pure function that reads a stored `schema_version` 1 or 2
  definition and produces a version-3 profile draft plus a **report of what it could not map**.

---

## Requirements

### Section A — The noun, the routes, and what must not be renamed

#### Requirement 1: A template becomes a Report Profile everywhere a user can see

**User Story:** As a consultant, I want the thing I author to be called what it is — a profile
for one customer's engagement — so that I do not treat it as a reusable design and re-pick that
customer's details every month.

##### Acceptance Criteria

1. THE Web_App SHALL present the noun **Report Profile** on every user-visible surface that
   today says "template", including the navigation entry, list page, wizard heading, run screen
   selector, report detail page and every empty state.
2. THE Web_App SHALL serve the profile surfaces at routes naming the profile — `/report-profiles`
   for the list and `/report-profiles/[id]/edit` for the wizard — replacing
   `/templates` and `/templates/[id]/edit`.
3. THE Web_App SHALL respond to a request for a former route with a redirect to the corresponding
   new route, so that a bookmark or an open tab from before this change resolves rather than 404s.
4. THE Message_Catalog SHALL carry the profile noun as catalogue ids in both `en` and `id`, and
   THE Web_App SHALL resolve every profile string through `messageText`, so that
   `app/test/message-literals.static.test.ts` reports zero offenders for the profile surfaces on
   the same terms it already reports zero for `app/components/reports/**`.
5. THE Web_App SHALL rename the profile API routes to `/api/report-profiles` and
   `/api/report-profiles/[id]`, and SHALL keep their request and response **shapes** unchanged
   except where a later requirement in this spec changes them.
6. THE Database_Schema SHALL keep the table names `report_templates` and
   `report_template_versions`, and THE Run_Payload SHALL keep the field name
   `template_version_id`, because a run's verification is anchored to that pinned version and
   `app/test/migrations.static.test.ts` forbids the `DROP` a table rename requires — the noun is
   what changes, not the audit trail.
7. WHERE a stored column, wire field or internal symbol keeps the word "template", THE
   Web_App SHALL NOT surface that name to the user, so that the storage-versus-noun split is
   invisible outside the code.

---

### Section B — Brand

#### Requirement 2: Branding is an account-level entity, not a per-customer choice

**User Story:** As a consultant, I want my consultancy's presentation decided once, so that
twelve customer profiles do not carry twelve slightly different accent colours and page sizes.

##### Acceptance Criteria

1. THE Database_Schema SHALL add a `brands` table owned by `user_id` referencing `users.id`,
   carrying the presentation fields named in criterion 2.2, and SHALL add a nullable `brand_id`
   column to `report_templates` referencing it — both as **additive** migrations, adding no
   `DROP` of any kind.
2. THE Brand SHALL carry `theme_preset` (`editorial` | `corporate` | `technical` | `minimal`),
   `accent_color`, `logo`, `density` (`compact` | `normal` | `relaxed`), `table_style`
   (`hairline` | `banded` | `bordered`), `page_size` (`A4` | `Letter`), `number_format`
   (`decimal_places`, `group_thousands`, `decimal_separator`, `grouping_separator`),
   `cover_page`, a **default approver name per role** for the roles requirement 12 declares, and
   `confidentiality_notice_id` — which is the set `DesignSpec` and
   `front_matter.document_control` carry per template today.
3. THE Web_App SHALL create one default Brand for a user the first time that user needs one, and
   SHALL populate it from the values the existing `DesignSpec` defaults declare, so that a new
   account is never asked to design a brand before it can author a profile.
4. THE Brand_Editor SHALL live outside the wizard, at its own route, and THE Profile_Wizard SHALL
   NOT collect any field criterion 2.2 names.
5. THE Brand_Editor SHALL present the four theme presets as **rendered page images** in a
   selectable grid, not as names in a select, and SHALL mark the selected card with a `--ring` and
   a `--primary` check, as `design-system.md` § "Style preset picker — real thumbnails" requires.
6. WHEN a profile version is saved, THE Profile_Store SHALL resolve the referencing Brand's field
   values into that version's stored definition, so that the version remains **self-contained**
   and a later Brand edit cannot alter what an already-saved version renders.
7. WHEN a Brand is edited, THE Web_App SHALL apply the new values to profile versions saved
   **after** that edit only, SHALL leave every delivered report byte-identical to what was
   delivered, and SHALL state that scoping on the Brand editor itself.
8. IF a profile's `brand_id` is null — which is every profile lifted from `schema_version` 1 or
   2 — THEN THE Migration_Lifter SHALL attach that profile to a Brand carrying the values its own
   `design` block held, as requirement 20 declares, so that no lifted profile silently adopts a
   different appearance.

---

### Section C — Provider

#### Requirement 3: The provider is a first-class field that selects the section catalogue

**User Story:** As a consultant, I want the wizard to offer Azure sections for an Azure profile,
so that adding AWS later is a new catalogue rather than a second wizard.

##### Acceptance Criteria

1. THE Profile_Definition SHALL declare a required top-level `provider` field at
   `schema_version` 3, drawn from the closed set `azure`, `aws`, `onprem`.
2. THE Profile_Wizard SHALL collect `provider` on step 1, SHALL offer `azure` as selectable, and
   SHALL present `aws` and `onprem` as **declared and not selectable**, so that the roadmap is
   visible without being usable.
3. THE Section_Catalogue SHALL be keyed by provider, and THE Profile_Wizard SHALL offer only the
   sections the profile's own provider declares.
4. THE Definition_Validator SHALL reject a profile whose `provider` is not `azure`, in both
   halves and with the same offending field path, until a catalogue for that provider exists.
5. THE Definition_Validator SHALL reject a profile carrying a section whose catalogue entry
   belongs to a different provider than the profile's own.
6. THE Profile_Wizard SHALL NOT permit `provider` to change after a version has been saved for
   that profile, because the sections, rules and metric selections of a saved version are all
   expressed in that provider's vocabulary.

---

### Section D — Scan

#### Requirement 4: The scan reports what is actually in the subscription

**User Story:** As a consultant, I want to see the estate before I choose sections, so that
every choice I make is informed rather than a guess I discover was wrong in the delivered PDF.

##### Acceptance Criteria

1. THE Inventory_Scanner SHALL extend the existing `list_inventory` command to report, in
   addition to the distinct-value dimensions `InventoryDimensions` carries today, a **count of
   resources per resource type**, the distinct set of **regions**, and the total resource count.
2. THE Inventory_Scanner SHALL compute those counts in the same Resource Graph paging pass the
   command already performs, honouring `x-ms-user-quota-remaining` and
   `x-ms-user-quota-resets-after` as `azure-integration.md` § 2 requires, and SHALL query **no
   metric values** — a scan is inventory, not collection. The region route probe requirement 5
   declares is **not** a metric query and is not forbidden here: it reads a status code and
   discards every body, so it collects nothing and produces no statistic, no figure and no gap.
3. THE Inventory_Scanner SHALL project `properties.extended.instanceView.powerState.code` for
   virtual machines, as `azure-integration.md` § 2 already requires of every inventory query, and
   SHALL report deallocated machines as **present and deallocated** rather than absent.
4. THE Scan SHALL be persisted with the subscription it scanned, its completion instant, and the
   `catalog_version` in force when it ran, and THE Profile_Version SHALL record the id of the
   scan it was authored against.
5. THE Scan_Surface SHALL present the counts as a summary bar — subscription, total resources,
   type count, region count, resource-group count, the scan's age, and a **Re-scan** control — as
   `design/Scan.dc.html` shows.
6. THE Scan_Surface SHALL group every resource type it found into `Compute`, `Networking`,
   `Data` or `Not reportable`, and SHALL show each type's name and count.
7. THE Scan_Surface SHALL list every type for which no catalogue entry exists, **greyed and
   present**, and SHALL state that a greyed type is why no section can use it — so that a type's
   absence from the report is visible rather than silent.
8. WHERE the scanned subscription's `scope_verified` is false or its secret has expired, THE
   Scan_Service SHALL refuse to scan and SHALL state the reason, because an inventory query is
   RBAC-filtered and a scan taken through a narrowed role would present a partial estate as the
   whole one — the failure `azure-integration.md` § 1 exists to prevent.
9. IF the scan's in-scope result is zero resources, THEN THE Scan_Surface SHALL state that as a
   hard problem to fix before authoring and SHALL NOT offer to continue to step 2, which is the
   authoring-time form of the `EMPTY_SCOPE` gate.

#### Requirement 5: The scan surfaces collection problems at authoring time

**User Story:** As a consultant, I want to learn that a region refuses batch metrics while I am
still authoring, so that I am not told after a run that finished four minutes later.

##### Acceptance Criteria

1. THE Scan_Service SHALL probe, per distinct region the scan found, whether that region's
   metrics data plane answers, by issuing **one minimal request** and reading **only its status
   code** — discarding any response body unread — and SHALL record that status on the scan. The
   probe is a **route check**: it asks whether the road exists, never what is on it, which is why
   criterion 4.2's prohibition on metric queries does not reach it.
2. WHERE a region's data plane answers `401`, `403` or `404`, or fails DNS resolution, THE
   Scan_Service SHALL record that region as **fallback-only** and SHALL state that metrics there
   are collected one resource at a time through the ARM per-resource path, exactly as
   `azure-integration.md` § 6 requires of a run, and SHALL record **no gap** — a refused data
   plane is a route decision, not a permission problem.
3. THE Scan_Surface SHALL present each recorded collection problem as its own statement naming
   the region and the consequence, in mist neutrals rather than `--destructive`, because a
   fallback route is information and `--destructive` means the document could not be proven.
4. WHERE a region is recorded fallback-only, THE Scan_Surface SHALL state the **count of scanned
   resources in that region** and SHALL state that those resources may return no samples and
   would then appear as recorded gaps — a stated risk, phrased as one. THE Scan_Surface SHALL NOT
   claim that any specific resource returned nothing: criterion 5.5 bounds the probe to one
   request per region, so a per-resource outcome is not something a scan can have observed, and
   presenting an inference as an observation is the exact dishonesty this product exists to
   remove.
5. THE Scan_Service SHALL bound the probe: at most one probe per distinct region per scan,
   honouring `Retry-After` on `429`, and SHALL record a probe that could not complete as
   **unknown** rather than as either success or failure.
6. THE Scan_Surface SHALL state the scan's own limits plainly — that a scan is a point-in-time
   observation, that a run re-resolves every rule against its own snapshot, and that a section's
   emit summary is therefore an estimate — so that no surface implies the scan is the truth the
   report is proven against.

#### Requirement 6: The scan says which sections it unlocks

**User Story:** As a consultant, I want the scan to tell me which sections are available and
which are not, so that I select from a real menu rather than a catalogue of everything.

##### Acceptance Criteria

1. THE Scan_Surface SHALL present every catalogue entry for the profile's provider with a status
   of `Ready`, `Manual` or `Unavailable`, computed from the scan.
2. THE Scan_Surface SHALL mark an entry `Ready` when every resource type it declares is present
   in the scan and every fact source it declares is collected today.
3. THE Scan_Surface SHALL mark an entry `Manual` when the catalogue declares it as filled by the
   author and never populated by the agent — the incident report being the only such entry.
4. THE Scan_Surface SHALL mark an entry `Unavailable` when a resource type or fact source it
   declares is not collected today, SHALL name **which** one is missing, and SHALL show the entry
   **disabled rather than hidden**.
5. THE Scan_Surface SHALL state, for each entry, what feeds it — inventory, a named fact source,
   or a metric count against a resource count — as `design/ScanFull.dc.html` shows.
6. THE Scan_Surface SHALL state the offerable count against the catalogue total, so that "9 of
   13 available" is a visible fact rather than something the author infers from scrolling.
7. THE Scan_Surface SHALL pre-select the entries it marked `Ready`, and SHALL leave every
   selection editable on step 2 — a pre-selection is a starting point, not a decision taken for
   the author.

---

### Section E — Sections replace composition

#### Requirement 7: A profile is an ordered list of sections

**User Story:** As a consultant, I want to choose sections in the order they will print, so
that I stop assembling a fixed document out of primitives.

##### Acceptance Criteria

1. THE Profile_Definition SHALL declare, at `schema_version` 3, a top-level `sections` array
   whose entries each carry a stable `id`, a catalogue `type`, a `selection` rule, an optional
   `metrics` selection, a `presentation` choice, and a `position`.
2. THE Profile_Wizard SHALL present five steps in this order: `1 Identity`, `2 Sections`,
   `3 Period`, `4 Document`, `5 Preview`, replacing the seven `WIZARD_STEPS` declares today.
3. THE Profile_Wizard SHALL NOT present a `Scope` step, a `Metrics` step, a `Blocks` step or a
   `Design` step, because scope and metrics are per-section, blocks are no longer an authoring
   concept, and design belongs to the Brand.
4. THE Section_List SHALL number each section as it will appear in the delivered document, and
   SHALL show the front-matter group (cover, document control, contents) as **present and not
   reorderable**, pointing at step 4 as where it is configured.
5. THE Section_List SHALL group its entries under `Inventory`, `Utilisation` and `Closing`
   headings, as `design/Sections.dc.html` shows.
6. THE Section_List SHALL make every non-fixed section reorderable by drag **and** by keyboard —
   select, move with modifier plus arrow keys, confirm — and SHALL announce each move through an
   `aria-live="polite"` region naming the new position, as `design-system.md`
   § "Accessibility — the part drag/drop usually fails" requires.
7. THE Section_List SHALL show the drop position as a 2px `--primary` rule at the insertion
   point rather than a shifting ghost layout.
8. THE Definition_Validator SHALL reject a `sections` array containing two entries of the same
   catalogue type unless that entry declares itself repeatable, and SHALL reject an entry whose
   catalogue type is unknown — explicitly, rather than by ignoring it, so that a profile the app
   can save is a profile the compiler can compile.

#### Requirement 8: The three closing sections have fixed positions

**User Story:** As a consultant, I want the deliverable's closing shape to be part of the
product, so that a report I hand a customer does not put recommendations before the backup
report because somebody dragged a card.

##### Acceptance Criteria

1. THE Section_Catalogue SHALL declare `backup_report`, `incident_report` and `recommendations`
   as **fixed-position** entries, in that order, immediately before the coverage-and-verification
   appendix.
2. THE Section_List SHALL render a fixed-position section with **no drag handle** and SHALL
   exclude it from keyboard reordering.
3. THE Section_List SHALL state why those three do not move — their order is part of the
   deliverable's shape rather than a preference — as `design/Sections.dc.html` does.
4. THE Section_Compiler SHALL emit fixed-position sections in their declared order regardless of
   the `position` values stored on them.
5. THE Section_Catalogue SHALL declare the coverage-and-verification appendix as always present
   and never deselectable, because it is the record the document's own claims rest on.
6. THE Definition_Validator SHALL reject a profile whose stored `sections` order places a
   fixed-position section anywhere but its declared position, in both halves and with the same
   offending path.

#### Requirement 9: A section selects resources by rule and never by a frozen id list

**User Story:** As a consultant, I want a VM deployed next week to appear in next month's report
without editing the profile, and I want to be told that it appeared.

##### Acceptance Criteria

1. THE Section_Selection SHALL be expressed as a resource type, optionally narrowed by resource
   groups and tag filters, structurally identical to the `ScopeRules` `compile/scope.py` already
   resolves.
2. THE Profile_Definition SHALL NOT admit a resource id in any selection field, and THE
   Definition_Validator SHALL reject an Azure resource identifier or GUID appearing in one — the
   check `validateScopeSpec` already performs for scope fields.
3. THE Section_Inspector SHALL present the resources a rule currently matches as **chips drawn
   from the scan**, and SHALL make selecting or deselecting a chip narrow the **rule** — by
   resource group or tag — rather than store the chip's id.
4. WHERE the author's chip selection cannot be expressed as a rule over resource type, resource
   group and tag, THE Section_Inspector SHALL say so and SHALL offer the narrowing dimensions
   that can express it, rather than silently storing a list.
5. WHEN a profile version is saved, THE Profile_Store SHALL record on that version, per section,
   the **authored match record**: the count and the resource-id set the rule matched against the
   scan at that moment.
6. THE Collector SHALL fetch the union of every section's rule once into one snapshot, as
   `union_scope` already computes it, so that adding sections does not add collection passes.
7. THE Section_Compiler SHALL resolve every rule against the **snapshot only**, never against
   Azure, so that replay re-runs compilation over the same snapshot and produces a bit-identical
   ledger.

#### Requirement 10: Metrics are chosen from what the present types declare, in three tiers

**User Story:** As a consultant, I want to pick metrics for the types I actually have, so that
I am not shown metrics for four resource types this subscription does not contain.

##### Acceptance Criteria

1. THE Metric_Picker SHALL offer, for a section, only the metrics the metric catalogue declares
   for the resource types that section's rule matches **in the scan** — replacing
   `buildPartitions`, which renders every catalogue type in one of two partitions.
2. THE Metric_Picker SHALL state how many metrics apply and why the others are absent — that
   they belong to types this subscription does not have — so that a shorter list reads as
   correct rather than as missing.
3. THE Metric_Picker SHALL offer a preset row of `Standard utilization`, `Capacity planning`,
   `Everything` and `Custom`, and THE Section_Catalogue SHALL declare each preset's metric set
   per resource type, so that a preset is a reviewed decision rather than a UI convenience.
4. THE Metric_Picker SHALL offer per-metric chips below the preset row, and SHALL switch the
   preset row to `Custom` when the author's chip selection stops matching any declared preset.
5. THE Metric_Picker SHALL offer statistic selection as a multi-select over `Average`, `Maximum`
   and `Minimum`, and SHALL require at least one.
6. THE Metric_Picker SHALL NOT accept typed metric names, typed statistic names, or any
   free-text or JSON entry, replacing the raw-JSON path `fieldValue` / `parseFieldValue` provides
   in `block-inspector.tsx`.
7. WHERE a selected statistic is a percentile, THE Metric_Picker SHALL copy that entry's
   `estimator` and `fidelity_tier` from the catalogue rather than composing them, as the
   templates spec already requires, so that no surface can produce a bare `p95`.
8. THE Section_Inspector SHALL offer a `presentation` choice of `Chart + table`, `Chart only` or
   `Table only`, and THE Section_Compiler SHALL emit accordingly.
9. IF a stored section names a metric the current catalogue no longer declares for that resource
   type, THEN THE Profile_Wizard SHALL mark that entry as no longer declared and SHALL block
   saving until it is resolved — the behaviour `findUndeclaredEntries` already implements for
   metric selections.

#### Requirement 11: The inspector states what the section will emit, before anything runs

**User Story:** As a consultant, I want to know a section will be empty while I am authoring it,
so that I do not find out from the delivered document.

##### Acceptance Criteria

1. THE Section_Inspector SHALL present an emit summary stating the number of headings, charts,
   tables and figures the section will produce, computed from the scan and the section's own
   configuration, as `design/Sections.dc.html` shows.
2. THE Emit_Estimator SHALL be a **pure function** of the scan, the section configuration and
   the section catalogue, so that it is unit-testable without a subscription and cannot reach
   Azure.
3. THE Section_Inspector SHALL state that the summary is counted from the scan before anything
   runs, so that it is not read as a promise about the delivered document.
4. WHERE a section's rule matches zero resources in the scan, THE Section_Inspector SHALL state
   that plainly, in mist neutrals rather than `--destructive`, and SHALL keep the section
   selected — an empty section is information, not an error.
5. THE Section_Compiler SHALL emit, for a section whose rule resolves to zero resources at run
   time, an explicit "No resources matched this scope" row, and SHALL NOT let the section vanish
   — the rule the compiler already applies to a zero-resource block, restated because a
   disappeared section is indistinguishable from one never configured.
6. THE Emit_Estimator SHALL count a figure the same way the compiler does — one per statistic per
   metric per matched resource, plus the section's declared fact columns — so that the estimate
   and the ledger disagree only where the snapshot disagrees with the scan.
7. THE Profile_Wizard SHALL state, on step 5, the profile's total estimated figure count and the
   number of sections estimated to emit nothing, so that an empty report is visible before the
   first run.

---

### Section F — The Document step

#### Requirement 12: Document details live on the profile, not on the run

**User Story:** As a consultant, I want the customer's name, document number and approvers held
on the profile, so that requesting a report asks me for a period and nothing that identifies the
customer.

##### Acceptance Criteria

1. THE Profile_Wizard SHALL collect on step 4, in the order they print: customer name, report
   title, document name, document number pattern, four approver rows, distribution list, and the
   confidentiality notice inherited from the Brand.
2. THE Profile_Definition SHALL store `customer_name` on the profile, and THE Run_Payload SHALL
   carry it from the pinned version rather than from a run-time field — replacing the
   `customerName` input on `run-form.tsx` and the `payload.get("customer_name")` read in
   `_resolve_run_facts` with a version-sourced value.
3. THE Profile_Wizard SHALL present the four approver roles in fixed order with the labels
   `Author`, `Quality Control`, `Reviewed By` and `Customer`, mapped positionally onto the four
   stored role ids `author`, `reviewer`, `approver`, `recipient` that `APPROVER_ROLES` declares
   in both halves, so that no stored id, fixture or mirror region changes to relabel a row.
4. THE Profile_Wizard SHALL collect per approver row a company, a name and an optional signature
   image, and SHALL default the name from the Brand's default for that role while allowing a
   per-profile override.
5. THE Profile_Definition SHALL NOT admit a fifth approver role, because the signature table's
   row height is a theme style and the closed four-role set is what both validators already
   enforce.
6. THE Profile_Wizard SHALL collect a distribution list as ordered rows of recipient, company
   and delivery note, and THE Renderer SHALL print an empty list as its header only.
7. THE Profile_Wizard SHALL present the confidentiality notice as inherited from the Brand and
   **not editable per profile**, naming the Brand as where it is edited.
8. THE Run_Form SHALL collect exactly the period, the revision-history row and the incident-table
   rows, and SHALL collect nothing that identifies the customer — retiring the `customerName`
   field it collects today and keeping `revision`, `revisionNote` and `revisionAuthor`.
9. THE Run_Payload SHALL keep carrying `customer_name`, `period_display` and
   `revision_history_row` on the wire, sourced from the pinned version for the first and from the
   run for the third, so that `_resolve_run_facts` keeps its payload contract and the store-to-send
   mirror guard keeps applying.

#### Requirement 13: A signature position is never a typed name

**User Story:** As a quality reviewer, I want an unsigned approval row to be visibly unsigned,
because a typed name in a signature position presents an approval nobody gave.

##### Acceptance Criteria

1. THE Renderer SHALL print, for an approver role with no signature image, an **empty ruled box**
   at the theme's declared signature row height and SHALL NOT print the typed name in the
   signature cell — the behaviour `_emit_approvers_table` implements today by setting
   `row_cells[3].text = ""` and calling `_set_row_height(...)` with
   `SIGNATURE_BOX_HEIGHT_TWIPS`.
2. THE Renderer SHALL print the approver's name in the name column, unchanged, so that the row
   states who was to sign while stating that they did not.
3. WHERE an approver row carries a signature image, THE Renderer SHALL place that image inside the
   signature cell, scaled to fit within the declared row height without changing it, so that a
   signed row and an unsigned row occupy the same space and the table's pagination does not depend
   on who signed.
4. THE Test_Suite SHALL keep the guard that asserts an unsigned signature cell is empty
   (`agent/tests/test_front_matter.py`, `TestSignatureBox`), SHALL extend it to assert the
   signature cell of a row **carrying** an image contains that image and still no text, and SHALL
   assert both by mutation — reintroducing the typed name and watching the assertion go red.
5. THE Web_App SHALL store a signature image as a private artifact under the owner's prefix and
   SHALL mint a presigned URL per request, never storing one, so that a signature is not a
   publicly addressable object.
6. THE Web_App SHALL reject a signature upload that is not a recognised raster image or exceeds a
   declared byte ceiling, and SHALL state the reason.
7. THE Renderer SHALL treat a signature image as **presentation**, never as a figure: it enters no
   ledger, is checked by no numeric gate, and its absence is not a verification finding.

#### Requirement 14: One document number per period, so a re-run is a revision

**User Story:** As a consultant, I want a second run of July to be revision 1.1 of one document,
not a second document, so that the customer's filing has one number for one period.

##### Acceptance Criteria

1. THE Profile_Wizard SHALL collect the document number as a **pattern** and SHALL show the
   pattern resolved against the profile's current period, so that the author sees the number the
   document will carry.
2. THE Document_Numberer SHALL resolve a pattern over the closed placeholder set
   `{template}`, `{year}`, `{month}`, `{run}` that `document_number(pattern, *, run)` already
   declares, extended by a sequence placeholder resolving to the profile's own per-period
   sequence.
3. THE Document_Numberer SHALL resolve two runs of one profile and one period to the **same**
   document number when the pattern names no `{run}` placeholder, which is the existing
   behaviour, and THE Profile_Wizard SHALL state that consequence beside the field.
4. THE Definition_Validator SHALL keep rejecting a pattern that names no varying placeholder, in
   both halves, so that two periods cannot collide on one number.
5. THE Run_Screen SHALL present the revision-history row as the per-run field it is — revision,
   note, and the run's own date — and SHALL state that a re-run of one period **appends** a row
   rather than replacing the document.
6. THE Renderer SHALL print the revision history rows in the order they were recorded, so that
   the document control page reads as a history rather than a latest state.

---

### Section G — The Azure section catalogue

#### Requirement 15: The catalogue declares the deliverable, section by section

**User Story:** As a consultant, I want the section list to be the report I actually deliver, so
that the product's shape and my deliverable's shape are the same thing.

##### Acceptance Criteria

1. THE Section_Catalogue SHALL declare, for `azure`, these entries with these canonical numbers:
   1 Azure subscription · 2 Resource groups · 3 Virtual network · 4 Virtual machines · 5 Public IP
   addresses · 6 Network security groups · 7 Azure reservations · 8 VM utilization · 9 Historical
   VM utilization · 10 Database utilization · 11 App Service & Storage · 12 Backup report ·
   13 Incident report · 14 Recommendations, plus the coverage-and-verification appendix.
2. THE Section_Catalogue SHALL declare section 4 as three sub-sections — 4.1 machine inventory
   including OS build, 4.2 network addressing including NIC, subnet, private IP, public IP and
   NSG, 4.3 attached disks — because that is the shape `design/ReportA.dc.html` delivers.
3. THE Section_Catalogue SHALL declare, per entry: the resource types it needs, the fact sources
   it needs, whether it is metric-bearing, whether its position is fixed, whether it is
   repeatable, and the AST it emits.
4. THE Section_Catalogue SHALL declare section 6 as omitting Azure's own default rules at
   priority 65000 and above, so that an NSG section reports the rules an operator wrote rather
   than the platform's defaults.
5. THE Section_Catalogue SHALL declare section 9 as **optional** and as drawing only on prior
   runs that passed verification, and THE Section_Compiler SHALL omit a historical point whose
   source run did not pass rather than showing it with a footnote — the rule
   `design/ReportB.dc.html` states.
6. THE Section_Catalogue SHALL declare section 13 as author-filled and never agent-populated, and
   THE Section_Compiler SHALL emit its declared blank rows so the printed table can be completed
   by hand.
7. THE Section_Catalogue SHALL declare section 7 as an active reservation list plus a utilisation
   summary, fed by the existing `capacity` fact source, and SHALL declare the tenant-level role
   its facts require so that a permissions failure records `fact_unavailable` rather than
   `no_reservations`.
8. THE Section_Compiler SHALL emit every section's AST through the existing typed AST node types,
   adding a node type only where an existing one cannot express the section, so that the
   verification surface grows only where the document genuinely does.
9. THE Test_Suite SHALL render **every** catalogue entry through the `.docx`, HTML and PDF
   emitters in at least one guard, because a section no guard has ever rendered is a section
   whose emitter has never run.

#### Requirement 16: The nine already-collectable sections ship before the four that need collectors

**User Story:** As a consultant, I want the restructured wizard working on the sections the
collector already supports, so that the UI change is not blocked behind four new Azure APIs.

##### Acceptance Criteria

1. THE Section_Catalogue SHALL declare sections 3, 5, 6 and 14 as `Unavailable` until their
   collectors exist, and THE Scan_Surface SHALL show them disabled with the missing input named,
   per requirement 6.4.
2. THE Profile_Wizard SHALL be complete and usable against the sections that are offerable
   today, so that the restructure delivers value before any new collector lands.
3. THE Definition_Validator SHALL reject a profile selecting a section the catalogue marks
   unavailable, in both halves, so that an unavailable section cannot be saved and then fail at
   run time.
4. THE Inventory_Collector SHALL collect, for section 3, each virtual network's subnets, their
   CIDR ranges, their available address counts and each peering's state, as a Resource Graph
   projection in the existing inventory pass.
5. THE Inventory_Collector SHALL collect, for section 5, each public IP's address, allocation
   method, SKU and association target, as a Resource Graph projection.
6. THE Inventory_Collector SHALL collect, for section 6, each NSG's inbound and outbound rule
   sets with priority, port, protocol, source, destination and action, as a Resource Graph
   projection.
7. THE Fact_Collector SHALL add `advisor` as a fact source alongside `resource_graph`, `arm`,
   `recovery_services` and `capacity`, collecting Azure Advisor recommendations with their
   priority and category, and SHALL declare it in `DECLARED_FACT_SOURCES` in both halves.
8. THE Fact_Collector SHALL record every failure of a new source as a **typed** entry in
   `collection_log`, distinguishing a permission failure from a source that returned nothing,
   and SHALL never let a failure become a zero.
9. THE Snapshot_Builder SHALL carry every new fact as a fixed-precision decimal string where its
   `value_kind` is numeric and as an exact string where it is text, so that a new collector
   changes nothing about determinism or the snapshot hash's stability.
10. THE Archive SHALL write every response a new collector reads, in the same pass, so that
    replay can reproduce the snapshot without re-collecting.

---

### Section H — Charts

#### Requirement 17: Two series an order of magnitude apart get two panels

**User Story:** As a consultant, I want a chart of CPU average against CPU maximum to show me
both, so that a 0.13-point average range is legible instead of a flat line on the axis.

##### Acceptance Criteria

1. THE Chart_AST SHALL express a chart as one or more **panels**, each carrying its own series
   set, its own unit and its own independent y-scale, with every panel sharing one x-axis —
   replacing the single `series` tuple and single `unit` the `Chart` node carries today.
2. THE Chart_Compiler SHALL place series in separate panels when their value ranges differ by an
   order of magnitude or more, and SHALL place them in one panel otherwise, by a **declared and
   deterministic** rule so that the same figures always produce the same panelling.
3. THE Chart_Renderer SHALL render panels stacked vertically sharing an x-axis, each with its own
   y-scale — replacing the single `figure.add_subplot(111)` in `render/charts.py`.
4. THE Chart_Renderer SHALL scale each panel's y-axis to that panel's own data and SHALL NOT
   impose a 0–100 range on a percentage unit, which is already true today and must stay true.
5. THE Chart_Renderer SHALL title each panel with the statistic it carries, so that a reader
   knows which panel is the maximum without consulting a legend.
6. THE In_App_Chart SHALL render the same panelling from the same spec, so that the chart in the
   app and the chart in the document differ in medium and not in content.
7. THE Chart_Data_Hash SHALL cover every plotted point across every panel, and SHALL stay
   invariant under panel titles, axis titles and panel assignment, so that panelling changes the
   drawing and not the proof.
8. THE Test_Suite SHALL assert that a panelled chart's companion table carries every plotted
   point of every panel with no thinning, on the same terms `test_charts.py` already asserts for
   a single-panel chart.

#### Requirement 18: Colour is never the only cue, and only the last value is printed

**User Story:** As a reader printing the report in greyscale, I want to tell two series apart,
and I want the chart to be a shape rather than a list of numbers.

##### Acceptance Criteria

1. THE Chart_Renderer SHALL pair every series' colour with a marker shape and a dash pattern,
   which `style.marker_for_key` and `style.dash_for_key` already provide, and SHALL keep the
   assignment keyed by stable series key rather than by array index.
2. THE Chart_Renderer SHALL print a **direct label at each series' line end** and SHALL NOT rely
   on a legend, extending the `axes.annotate` call already present so that the legend is a
   fallback rather than the mechanism.
3. THE Chart_Renderer SHALL print exactly one value label per series — the **last** point's
   value — replacing `label_indices`, which labels every point of a series of 24 or fewer, and
   THE Test_Suite SHALL update the assertions in `test_charts_10_1.py` that assert the old
   contract in the same change.
4. THE Chart_Renderer SHALL render every value label in `--foreground` through
   `chartstyle.value_label_color(theme)`, which is already the case and is what keeps inline
   value text above the 4.5:1 text floor.
5. THE Companion_Table SHALL carry every plotted value, so that removing value labels removes
   redundancy rather than information.
6. THE Chart_Renderer SHALL draw gridlines from `--border` and axis labels and ticks from
   `--muted-foreground`, and SHALL use `--destructive` for no series, gridline or label — already
   asserted by `test_destructive_appears_on_no_series_gridline_or_label` and restated because
   panelling adds new drawing code.
7. THE Chart_Renderer SHALL NOT encode good or bad in hue for any utilization value, and SHALL
   state direction with a glyph and magnitude where a direction is stated at all.
8. THE Chart_Renderer SHALL keep producing byte-identical output for identical input, so that
   panelling does not weaken the determinism the render guards assert.
9. THE Chart_Renderer SHALL keep every categorical series above 3:1 against both `--background`
   and `--card` in both themes and every pair above the 0.06 CVD ΔE floor, which
   `app/test/palette.static.test.ts` and `agent/tests/test_chartstyle.py` already enforce and
   which no panelling change may move.

---

### Section I — Coverage and drift

#### Requirement 19: A rule's drift is reported, never hidden

**User Story:** As a consultant, I want to be told that this month's report covers two machines
the profile did not know about, so that a growing estate is announced rather than absorbed.

##### Acceptance Criteria

1. THE Run SHALL resolve every section's rule against its own snapshot and SHALL record, per
   section, the resource-id set the rule matched at run time.
2. THE Coverage_Appendix SHALL state, per section whose run-time match differs from the version's
   authored match record, the resources **added** and the resources **no longer matching**, each
   named.
3. THE Coverage_Appendix SHALL state a difference as neutral information in mist neutrals, not as
   an error and not in `--destructive`, because a matched new resource is the rule working.
4. THE Run SHALL include every resource its rules matched, and SHALL NOT withhold a newly
   matched resource pending an author's confirmation — included and announced, never included
   and hidden, and never excluded silently.
5. THE Coverage_Appendix SHALL state the count of resources scanned, the count carrying
   statistics, the count of recorded gaps, and the count of scope changes, as
   `design/ReportB.dc.html` shows.
6. THE Verification SHALL keep asserting that every resource in the run's union is present in the
   snapshot, unchanged, so that coverage remains a proof rather than a narrative.
7. THE Coverage_Appendix SHALL name the scan the profile version was authored against and the
   snapshot the run was collected into, so that a reader can see both ends of the comparison.

---

### Section J — Migration

#### Requirement 20: Every stored template opens in the new wizard

**User Story:** As an existing user, I want the profile I authored last month to open, so that a
restructure is not a re-authoring exercise.

##### Acceptance Criteria

1. THE Migration_Lifter SHALL be a **pure function** of a stored definition, producing a
   version-3 profile draft and a mapping report, so that it is testable over the 59-fixture
   corpus at `agent/tests/fixtures/definitions/` without a database — a corpus that supplies both
   stored versions the lifter must handle, 44 fixtures at `schema_version` 1 and 10 at
   `schema_version` 2.
2. THE Migration_Lifter SHALL lift a definition's `design` block into a Brand carrying exactly
   those values, and SHALL reference that Brand from the produced draft.
3. THE Migration_Lifter SHALL carry a version-2 definition's `front_matter` section through
   **unchanged**, so that a document control page a customer has already seen keeps its shape.
4. THE Migration_Lifter SHALL map each block onto the catalogue section that emits the closest
   AST, and SHALL carry that block's `scope_override` — or the template default scope where it
   has none — onto that section's selection rule.
5. THE Migration_Lifter SHALL report, per block it could not map, the block's type and id, and
   THE Profile_Wizard SHALL present that report and require the author to choose sections rather
   than dropping the content silently.
6. THE Migration_Lifter SHALL NOT write to `report_template_versions`, and THE Web_App SHALL
   store a lifted profile as a **draft** until the author saves it, so that lifting never mutates
   an immutable version.
7. THE Definition_Validator SHALL keep accepting `schema_version` 1 and 2 in both halves, and THE
   Compiler SHALL keep compiling and rendering them unchanged, so that a run pinned to an
   existing version reproduces exactly what it delivered.
8. THE Test_Suite SHALL assert, for every fixture in the shared corpus, that the two validators
   still agree on verdict, offending path and canonical digest — the head-to-head comparison
   `app/test/mirror.static.test.ts` and `agent/tests/definition_corpus.py` already run — and SHALL
   extend the corpus with version-3 accept and reject fixtures in the same change.
9. THE Web_App SHALL replace the three starter templates in `app/lib/templates/starters.ts` with
   version-3 starter profiles, and SHALL keep the existing version-1 starters valid so that
   accounts seeded before this change still open.

---

### Section K — What must not break

#### Requirement 21: The verification model is untouched

**User Story:** As a consultant accountable for the numbers, I want the proof to be exactly as
strong after this restructure as before it.

##### Acceptance Criteria

1. THE Run SHALL pin exactly one `template_version_id` and THE Verifier SHALL check the rendered
   document against that version and no other, unchanged.
2. THE Figure_Ledger SHALL remain the render context — the same object, not a parallel structure
   — so that sections cannot introduce a drift between what was rendered and what is proven.
3. THE Verifier SHALL keep running every gate it runs today: anchored cell equality on tables,
   ordered masking on prose, bidirectional ledger completeness, chart data hashes, PDF
   extractability, and deterministic replay against the archived raw responses.
4. THE Replay SHALL keep importing only pure modules, so that re-running compilation over a
   snapshot proves determinism rather than re-collecting.
5. THE Section_Compiler SHALL introduce no numeric leaf other than a `Figure`, so that provenance
   stays structural rather than procedural.
6. THE Renderer SHALL keep wrapping every figure in the theme's `Figure` character style and
   keep emitting a `w:tblCaption` id on every data table and none on a layout table, so that
   token extraction and the table pass keep working by construction.
7. THE Verifier SHALL withhold the document on any blocking finding, with no path that delivers
   an unproven report.

#### Requirement 22: The contract between the two halves stays mirrored and documented

**User Story:** As a developer, I want a field the app collects to be a field the runtime
receives, because we have already shipped a defect where it was not.

##### Acceptance Criteria

1. THE Invoke_Contract SHALL be documented in `agent/AGENTCORE_INTEGRATION.md` in the **same
   commit** that adds any payload field, because that file is authoritative and a field on the
   wire that is not in it is a field nobody can verify.
2. THE Test_Suite SHALL carry a static mirror guard for every new payload field, extracting the
   keys the runtime actually reads from its own source and asserting the app sends exactly those
   — the guard shape that would have caught the front-matter values the app collected and never
   put on the wire.
3. THE Definition_Validator SHALL stay mirrored across `app/lib/templates/definition.ts` and
   `agent/.../compile/definition.py`, including the new section, provider and brand keys, and
   THE Mirror_Guard SHALL compare the sentinel-delimited regions as it does today.
4. THE Section_Catalogue SHALL be mirrored across both halves — the app offers it, the agent
   compiles it — and THE Mirror_Guard SHALL assert the two declarations agree on entry set,
   canonical numbers, declared resource types, declared fact sources, fixed positions and preset
   metric sets.
5. THE Message_Catalog SHALL carry every new user-facing string in both `en` and `id`, under the
   existing `doc.` / `chart.` / `ui.` prefixes and the existing id grammar, and THE Catalog_Guard
   SHALL keep asserting set equality and value equality across both halves.
6. THE Web_App SHALL resolve every new string through `messageText` and SHALL introduce no
   literal copy in a component, so that `app/test/message-literals.static.test.ts` reports zero
   offenders across the profile, scan, section, brand and document surfaces.
7. THE Web_App SHALL add no secret-bearing field to any browser-safe projection in
   `app/lib/db/views.ts`, and THE Projection_Guard SHALL assert that a Brand's and a scan's
   projections carry nothing a browser must not hold.
8. THE Database_Migrations SHALL be additive only, and THE Migration_Guard
   (`app/test/migrations.static.test.ts`) SHALL keep failing the suite on any `DROP TABLE`,
   `DROP COLUMN` or `DROP TYPE` of an object an earlier migration created.
9. THE Environment_Example SHALL gain every new variable this spec introduces, in the same change
   that reads it.

#### Requirement 23: A delivered report is frozen

**User Story:** As a consultant, I want a report a customer has signed to keep rendering exactly
as delivered, so that an audit artifact stays an audit artifact.

##### Acceptance Criteria

1. THE Web_App SHALL leave every existing `report_template_versions` row byte-identical, and
   SHALL create a new version for every edit, as `insertVersion` already does.
2. THE Profile_Version SHALL be self-contained with respect to Brand values, per criterion 2.6,
   so that re-rendering an archived report cannot pick up a Brand edited since.
3. THE Web_App SHALL keep the version-identity rule `insertVersion` implements — an edit whose
   `definition_sha256` equals the current version's creates no new version — so that opening and
   saving a profile without changing it does not manufacture versions.
4. THE Run SHALL keep recording `snapshot_sha256`, `docx_sha256` and `pdf_sha256` on its
   verification, so that an archived report is re-verifiable against the exact snapshot it came
   from.
5. THE Web_App SHALL keep every delivered artifact reachable and unchanged after this
   restructure, including reports whose pinned version is `schema_version` 1.

---

## Traceability

Every requirement above corrects or extends something verified in the code, and each row of
§ "What is wrong today, precisely" is corrected by a named criterion.

| Observed problem | Corrected by |
|---|---|
| Seven wizard steps built around composition | 7.2, 7.3 |
| Metric picker renders every catalogue type | 10.1, 10.2 |
| Seventeen block types as authoring primitives | 7.1, 7.3, 15.8 |
| Raw-JSON block config editing | 10.6 |
| Branding stored per template | 2.1, 2.2, 2.4 |
| No account-level entity exists | 2.1, 2.3 |
| `list_inventory` reports no counts | 4.1, 4.2 |
| A refused metrics region is discovered only at run time | 5.1, 5.2, 5.3 |
| Customer name and revision re-typed per run | 12.1, 12.2, 12.8 |
| No signature image is stored; the box is unconditionally empty | 12.4, 13.1, 13.3 |
| One y-axis flattens a small-range series | 17.1, 17.2, 17.3 |
| Every point of a short series is value-labelled | 18.3, 18.5 |
| No `provider` field | 3.1, 3.2, 3.3 |
