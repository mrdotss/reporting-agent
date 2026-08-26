# Implementation Plan: restructure-the-template-to-report-flow-around

## Overview

Build in the order the design's dependencies force, which is **not** the order the feature reads in.

**The scan comes first**, before any wizard work, because step 2 of the new wizard is a view over
counts and `list_inventory` reports none today — it returns distinct values only. A wizard built
against a stubbed scan would be a wizard whose central surface has never seen real data.

**Two child-type guards are written before the collectors that make them observable** (tasks 1.2).
Both follow from one property — a child type is declared by the fact catalogue and never by the
metric catalogue — and both catch a defect that is invisible until Phase 5 and then permanent:
phantom `metric_not_selected` gaps, and sub-records inflating "Total Resources" so an unchanged
subscription appears to grow between two reports. Writing them against a synthetic snapshot costs
an afternoon; writing them after three collectors are built on the opposite assumption costs the
collectors.

**Brand comes before the sections restructure**, because the publish path resolves a Brand into
`definition.design` and the Design step cannot be removed from the wizard until something else owns
those values.

**Then the sections restructure**, which is the largest phase and the only one where the change is
visible to a user. Inside it the order is: the catalogue and its loader validation, then
`schema_version` 3 with its mirror and corpus fixtures, then the expander with its determinism
guards, then the one-line `compile_document` branch, then the two new block compilers, then the
wizard, then the lifter. The expander lands **before** the wizard because the wizard's emit
estimator is asserted against the expander's own expansion through a shared fixture.

**Then the document step, then charts, then the four collectors** — charts and collectors are
independent of everything above them and of each other, so charts can ship any time after Phase 0
and each collector is its own increment.

Deployment order within every phase is the repo rule: **migration → app → runtime**, because the
runtime is the only component that can present a value the database must already accept.

The spec ends when a consultant connects a subscription, scans it, authors a Report Profile from
sections the scan says are available, sees a computed emit summary before running anything, requests
a report giving only a period and a revision note, receives a `.docx` and `.pdf` whose charts split
two orders of magnitude across two panels and whose coverage appendix names the two VMs deployed
since the profile was authored — with every figure verified, every gate green and replay
bit-identical.

### What no task in this spec does

- **No task drops a Postgres table, column or enum value.** Every migration is additive and
  `app/test/migrations.static.test.ts` passes unchanged. The rename is a rename of the **noun**:
  `report_templates` and `report_template_versions` keep their names, and so does the
  `template_version_id` wire field.
- **No task adds an SSE event type.** `agent/.../events.py` and `app/lib/events.ts` are not edited
  and `app/test/event-mirror.static.test.ts` is untouched — the scan rides `list_inventory`'s
  existing `done` outcome.
- **No task adds an environment variable.** `app/.env.example` and `agent/.env.example` are
  unchanged.
- **No task changes the verification model.** No gate is added, removed or weakened; no finding type
  changes meaning. `verify/replay.py`'s import closure stays pure.
- **No task re-runs `shadcn init`**, regenerates `app/components.json`, or replaces, reorders or
  reformats any existing token value in `app/app/globals.css`.
- **No task edits an existing fixture in `agent/tests/fixtures/definitions/`.** Its
  `definition_sha256` is pinned, so an edit forces a manifest regeneration — and since this spec's
  schema growth is additive, needing to edit one is the signal that a change is not as additive as
  it was assumed to be.

Every task leaves the **files it touches** clean under `.venv/bin/ruff check <paths>` in `agent/`
and `pnpm lint` + `pnpm typecheck` in `app/`, leaves the full `agent/` and `app/` suites green, and
does **not increase** the repository's lint finding count.

> **The tree-wide lint gate is not clean today and this spec does not adopt it.** A baseline
> `.venv/bin/ruff check .` in `agent/` reports **223** findings — 101 `F401` (largely re-export
> imports), 40 `I001`, 36 `E402`, 22 `RUF059` — across roughly thirty files in both `src/` and
> `tests/`. Measured on `0af6e84`, before any task in this spec. So "leaves `ruff check .` clean"
> is not a bar any task here can meet, and adopting it would drag thirty files this spec does not
> own into its diff. The bar is the one above: touched files clean, suites green, count not
> increased. Reducing the pre-existing debt is legitimate work and is **not** this spec's.

## Tasks

- [ ] 1. Phase 0 — the scan's foundations
  - Everything the wizard's step 2 reads. Ships independently: the scan screen is useful before any
    wizard change exists, and it is what makes the wizard buildable.

  - [x] 1.1 Extract `is_data_plane_refusal` as the one reading of a data-plane response
    - Today the classification is split and side-effecting: `_DATA_PLANE_REFUSED_STATUSES = frozenset({401, 403, 404})` lives in `agent/.../azure/metrics.py`, DNS failure is caught as `DnsResolutionError` in `agent/.../azure/regions.py`, and both call the mutating `RegionResolver.mark_fallback_only(location)`
    - Move the status set to `agent/.../azure/regions.py` as `DATA_PLANE_REFUSED_STATUSES` and add the pure predicate `is_data_plane_refusal(status: int | None, *, dns_failed: bool) -> bool`
    - `azure/metrics.py` calls the predicate instead of testing the frozenset inline; `RegionResolver` calls it in the `DnsResolutionError` branch. `mark_fallback_only` and `is_fallback_only` keep their signatures, so no caller outside these two modules changes
    - Add a **call-site** test, not a mirror: assert both the metrics collection path and the scan probe (task 1.6) reach `is_data_plane_refusal`, by patching it with a counting wrapper and asserting both paths increment it. Two independent readings of the same status codes would let a scan promise a route the run then declines
    - Extend `agent/tests/test_boundaries.py` so the four literals `401`, `403`, `404` do not appear as a refusal test anywhere outside `azure/regions.py`
    - _Requirements: 5.1, 5.2_

  - [x] 1.2 `is_child_type` and its guard, before any collector can make it observable
    - Add `is_child_type(resource_type, *, catalog: LoadedCatalog) -> bool` to `agent/.../catalog/loader.py`: true when the fact catalogue declares the type and the metric catalogue does not. This is the **formal test** for a child type — there is no second list anywhere, in either half. Takes the whole `LoadedCatalog` rather than the two halves separately, because they are one document version and a split signature would let a caller pair a fact declaration with a mismatched metric catalogue — the drift the function exists to prevent. Add `child_type_names(catalog)` as its list form, so the scan's count filter (task 1.3) is derived rather than hand-maintained
    - "Declared by metrics" means the type **appears** in the metric catalogue, valid entries or not: an all-invalid metric entry is a catalogue bug, and reading it as "not declared" would demote a real resource to a sub-record and drop it out of every headline count while the catalogue fix was pending
    - Guard A — **no phantom gaps**: `_metric_not_selected_gaps` in `collect/pipeline.py` skips a child type. Asserted with a child resource and an ordinary unselected type **in one call**, so the test cannot pass by suppressing the gap altogether. Plus a guard-the-guard proving the noise is real (six subnets, six gaps, without the rule) and a tripwire asserting the shipped catalogues declare **no** child type yet, so the first one is a deliberate edit
    - Written before the collectors because it **constrains their design**, and cheap against a synthetic snapshot
    - _Requirements: 4.1, 16.9_
    - _Design: §3.3, §12_

  - [x] 1.3 Extend the inventory pass: regions on the dimensions query, counts as a second query
    - **The design's single-query sketch is not implementable and was replaced.** `distinct_dimensions_query` projects **no `id`** — that is what makes Req 9.5's exclusion of resource identifiers structural rather than a filter someone must remember — and it aggregates with **no `by` clause**, which is what makes "one row, no continuation" a property of its shape. `count_distinct(id)` would reintroduce `id` into the projection, and `by type` would break the single-row shape. So: **regions ride the existing query** (`make_set_if(location, …)` adds no `by` and no `id`), and **counts are a second query** with its own port method
    - `agent/.../azure/clients.py`: `resource_counts_query` = `Resources | where subscriptionId == … | summarize resource_count = count() by type | order by type asc`. **One** `count()` expression, so the trap cannot occur: three textually identical expressions differing only by comment return the same number three times. No `count_distinct`/`count_distinctif` (Azure Data Explorer functions whose presence in Resource Graph's subset could not be verified here) and no `make_bag` (same reason) — the query does not `mv-expand`, so `count()` is already exact
    - `query_resource_counts` on `InventoryPort`, `ArmInventoryPort` and `FakeInventoryPort`; the fake shares **one** response queue with the other two methods so a test asserting "exactly two queries" can notice a third
    - `agent/.../azure/inventory.py`: `DIMENSION_REGIONS` as a fifth dimension (`InventoryDimensions.regions`, defaulted so every existing construction site is unchanged); `TYPE_COLUMN`/`COUNT_COLUMN` declared once for the same anti-drift reason as `INVENTORY_DIMENSIONS`; `ResourceCounts` + `read_counts(rows, *, child_types)`; `InventoryCollector.resource_counts(...)` as a **separate** method, because `distinct_dimensions`'s docstring states "one call to the port and no loop" and Req 9.2's "one query per cache miss" as properties of its shape
    - The partition happens in `read_counts` from `child_type_names(catalog)`, **not** in query text: no type list to keep in step with the declarations by hand. Case-folded, because Resource Graph lower-cases `type` while the catalogues declare Azure's casing — an exact comparison would put every sub-record in the headline family and the partition would silently do nothing
    - An unreadable count is **skipped, not zero-filled**; `bool` excluded explicitly, since `isinstance(True, int)` is `True`
    - `main.handle_list_inventory` calls both and merges both onto `done`. No new command, no new event type
    - Guard B — **headline count invariance**: one estate of fourteen ARM ids (2 VMs, 1 VNet, 1 NSG, 4 subnets, 6 rules) counted twice, before and after the child types are declared. `resource_count` stays 4 and `type_counts` identical while `child_type_counts` moves; a third assertion proves no row is dropped by the partition. Mutation-checked — collapsing the partition to one family fails it
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 1.4 `subscription_scans`, its migration, `ScanView` and the projection guard
    - `app/lib/db/schema.ts`: add `subscriptionScans` following the `reportTemplates` pattern verbatim — `text("id").primaryKey()`, `user_id` → `users` with `onDelete: "cascade"`, `connected_subscription_id` → `connectedSubscriptions`, a `pgEnum` for `status` (`queued`/`running`/`complete`/`failed`), the local `instant()` helper for timestamps, constraints returned from the third argument, `_idx`/`_ck` suffixes
    - Columns: `status`, `catalog_version`, `sections_catalogue_version`, `resource_count`, `type_counts` jsonb, `child_type_counts` jsonb, `resource_groups` jsonb, `regions` jsonb, `region_probes` jsonb, `truncated` boolean, `error_code`, `error_message`, `completed_at`
    - Generate the migration with drizzle-kit; never hand-edit. Additive only
    - `app/lib/db/views.ts`: `ScanView` dropping `user_id`; add the projection guard test asserting no secret and no presigned URL survives, in the **same change** as the table
    - _Requirements: 4.4, 22.7_

  - [x] 1.5 The scan routes
    - `app/app/api/subscriptions/[id]/scan/route.ts`: `POST` to start a scan, `GET` for the latest `ScanView`. Follow the existing inventory-route pattern exactly — `export const runtime = "nodejs"`, `requireSessionForApi()`, zod `.strict()` schemas for path params and body in a non-`server-only` `input.ts`, the `json`/`unauthorized`/`invalidInput`/`unprocessable` helpers from `@/lib/api/response`, ownership scoped by `user_id`
    - Refuse **before** invoking when the subscription's `scope_verified` is false or `secret_expires_at` has passed: `unprocessable` naming which of the two it is, not a generic failure. An inventory query is RBAC-filtered, so a scan through a narrowed role would present a partial estate as the whole one
    - A scan deliberately does **not** join the `report_runs` state machine: it produces no snapshot, ledger or artifact, so the reaper and phase deadlines would protect nothing. The row carries `status` and the screen polls `GET`; a dead `running` row is superseded by the next scan
    - _Requirements: 4.4, 4.8_

  - [x] 1.6 The region route probe
    - `probe_regions` in `agent/.../azure/regions.py`, one request per distinct region, recording `{region, status_code, verdict, probed_at}` with the verdict derived from the shared `is_data_plane_refusal` and `"unknown"` for a probe that could not complete. Wired into `list_inventory` after the counts, riding `invocation.outcome` as `region_probes`. No new command, no new event type
    - **"Discards the body unread" is a property of the type, not of a test.** The port returns `ProbeResult(status: int, retry_after: str | None)` — the status plus the one header a 429 needs, and nothing else — so the probe has no body to read. `regions.py` contains zero `.body` references. Two review rounds got here: the first implementation took a whole `RawHttpResponse` and was *trusted* not to look, and its body-access test only failed because the downstream verdict came out wrong, so it could not tell "read the body" from "failed for any other reason"
    - **One reading of `Retry-After`.** The first implementation added a private `_parse_retry_after(value)` while `azure/metrics.py` already exported a tested `parse_retry_after(value, *, now)`. That was a second reading of one header in the very change that removed a second reading of a status — and a correctness bug besides: `Retry-After` may be an HTTP-date, which is why the existing signature takes a clock, so the clockless version silently classified every date-form header as unparseable and would not have waited. Resolved with a function-scope import (module scope would be circular, since `metrics.py` imports `regions.py`) plus a test asserting the date form
    - **A programming error is not an unreachable region.** The blanket `except Exception → unknown` was narrowed to `DnsResolutionError` and `(AzureTransportError, OSError, TimeoutError)`, so an `AssertionError` or `TypeError` in this module propagates instead of presenting as a region that merely did not answer for the rest of the run
    - 17 probe tests. Agent suite 4557 passed / 0 failed on a clean run
    - _Requirements: 4.2, 5.1, 5.2, 5.5_

  - [x] 1.7 The scan screen
    - **Landed:** `app/lib/scans/grouping.ts` (26 tests) — the four groups, with **group and greyed as independent facts** because `design/Scan.dc.html` shows greyed types inside Compute and Networking as well as in Not-reportable, and greying derived from the catalogues so adding a type stops greying it with no edit here. `app/lib/scans/view.ts` (37 tests) — the jsonb parsers and the authoring-time `EMPTY_SCOPE` gate, keeping **absent distinct from zero** at both scales. `app/app/(app)/subscriptions/[id]/scan/page.tsx` — the summary bar, grouped types, greying, the empty-scope refusal and the limits note. `app/components/scan/collection-problems.tsx`. The Scan entry point on the subscription row, gated on the **same** preconditions the route enforces (4 tests, mutation-checked). 15 `ui.scan.*` ids in both catalogues
    - **`Microsoft.Web/sites` groups under `compute`, as a decision.** The mockups declare four groups and App Service is metric-bearing, so letting it fall through to `not_reportable` would put a supported type in the bucket labelled unsupported. Guarded by an invariant over every catalogue-declared type, not just that one
    - **DONE — the collection-problems panel is wired with real per-region counts.** The agent side produces them (`count() by type, location`, `ResourceCounts.region_counts`, non-child types only, mutation-checked), task 1.8 writes them onto the row through the new additive `region_counts` column, and the page passes them to the panel. The "NOT RENDERED YET" comment is gone. No fabricated count ever reached the screen
    - **DONE — the literal-copy guard now covers `app/components/scan/**`.** Both scans got the new root, not one: the id-resolution scan catches an id-shaped constant used raw, the AST scan catches raw English in a text position, and omitting either would leave a gap for the next file added under `scan/`. Each carries the same non-vacuous `"no .tsx files found under app/components/scan/"` assertion, so neither can pass by scanning nothing. Zero offenders; mutation-checked with an injected `<p>` literal the guard caught at file and line
    - _Requirements: 4.5, 4.6, 4.7, 4.9, 5.3, 5.4, 5.6, 22.5, 22.6_

  - [x] 1.8 Complete a scan — the step Phase 0 is missing
    - **Found by execution, absent from the plan.** Task 1.5's brief said the POST persists a `queued` row and does **not** invoke AgentCore, to keep that task bounded. No later Phase 0 task picks the invocation up, and task 1.7 was written assuming a completed scan existed to render. The result: `createScan` writes `queued`, nothing ever writes a result column or moves the status, so `scanGate` answers `running` for every scan forever, the screen shows em dashes permanently and **Continue never appears**. Phase 0's claim to ship independently is false without this
    - Invoke the runtime's existing `list_inventory` command with the subscription's decrypted credentials, server-side only, and write the `done` outcome onto the scan row: `resource_count`, `type_counts`, `child_type_counts`, `region_counts`, `resource_groups`, `regions`, `region_probes`, `truncated`, `catalog_version`, `sections_catalogue_version`, `completed_at`, and `status = 'complete'`
    - A scan is shorter than a report run but not instant, so decide deliberately where the invocation lives. It must **not** join the `report_runs` state machine (design §4.3: a scan produces no snapshot, ledger or artifact, so the reaper and phase deadlines would protect nothing), and it must not be a request the browser holds open. The row carries `status`, so a short-lived server-side invocation that writes the row and returns is the shape; the screen polls `GET`
    - A failure writes `status = 'failed'` with `error_code` and a scrubbed `error_message`, and never leaves a row in `running`. `scanGate` already presents `failed` with its code so the screen can say what to fix
    - Add the additive `region_counts` column and its `ScanView` field here, since this is the task that first writes it
    - Then wire `CollectionProblems` in the page and delete its "NOT RENDERED YET" comment, closing 1.7
    - **Implemented in `app/lib/scans/execute.ts`**, called from the POST: it transitions `queued → running`, invokes `list_inventory`, reads the SSE stream to its `done` frame, parses the outcome and writes `complete` with every column — or `failed` with a code and a scrubbed message. Migration `0008_add-region-counts-to-subscription-scans.sql`, a single additive `ADD COLUMN`
    - **Rejected, as recorded at the module:** the `report_runs` state machine (design §4.3 — a scan produces no snapshot, ledger or artifact, so the reaper and phase deadlines would protect nothing), and a fire-and-forget background write that could not report failure to the caller
    - **KNOWN LIMITATION, documented at the module and verified recoverable:** the invocation is synchronous under a 55s cap (inside ALB's 60s idle default), so a request killed by a proxy strands the row in `running`. That is acceptable *only because the recovery is real rather than theoretical*: the Re-scan control is ungated so it stays visible in that state, `readLatestScan` orders by `createdAt desc`, and a new scan supersedes the stranded row. It is a clearable intermediate state, not the permanent dead end this task existed to fix — but it is the same failure shape, so a scan reaper is the obvious follow-up if scans ever grow slower
    - 7 new tests including the gate flipping to `ready` so Continue appears — the behaviour that did not exist before this task. Failure path mutation-checked (`failed` → `running` turns both failure tests red). App suite 2915 passed / 247 skipped / 0 failed
    - _Requirements: 4.4, 4.8, 5.3, 5.4_
    - `app/app/(app)/subscriptions/[id]/scan/page.tsx` plus leaf client components under `app/components/scan/`. Server component by default; `"use client"` only at the polling leaf
    - Summary bar: subscription, total resources, type count, region count, resource-group count, the scan's age, **Re-scan** — matching `design/Scan.dc.html`
    - Types grouped `Compute` / `Networking` / `Data` / `Not reportable`, each with its name and count; a type with no catalogue entry is **listed and greyed**, with the statement that a greyed type is why no section can use it
    - Collection problems as their own statements naming the region and the consequence, in **mist neutrals, never `--destructive`** — a fallback route is information, and `--destructive` means the document could not be proven
    - For a fallback-only region, state the **count of scanned resources in that region** and that those resources may return no samples. Never name a specific resource as having returned nothing: the probe is one request per region and cannot have observed a per-resource outcome
    - A zero-resource scan states the problem and does **not** offer to continue — the authoring-time form of the `EMPTY_SCOPE` gate
    - Every string through `messageText` in both languages; the literal-copy guard extended to `app/components/scan/**`
    - Add the entry point that makes Phase 0 shippable: a per-subscription **Scan** action on `app/app/(app)/subscriptions/page.tsx` linking to the scan route. No `subscriptions/[id]/page.tsx` exists, so the list is where it hangs. Without this, "ships independently" is not true of Phase 0 — the screen is reachable only by typing a URL. Do **not** add a subscription detail page; this spec does not need one
    - **Match that page's existing convention, which is literals.** Verified: `app/app/(app)/subscriptions/page.tsx` contains zero `messageText` calls, and `app/test/message-literals.static.test.ts` scans only `app/components/reports/**`, so the page is outside the guard's scope. An earlier draft of this bullet said the label should resolve "through `messageText` like every other string on that page" — that was wrong about the page, and following it would make the Scan link the single catalogued string on a page of literals while adding ids to a mirrored catalogue no guard is checking. The new components under `app/components/scan/**` **do** use `messageText` and **do** get the guard extended to them; this one link matches its siblings, and the page's strings are catalogued as a set when task 3.14 extends the guard to the profile, scan and brand surfaces
    - _Requirements: 4.5, 4.6, 4.7, 4.9, 5.3, 5.4, 5.6, 22.5, 22.6_

- [ ] 2. Phase 1 — Brand
  - Must precede the sections restructure: the publish path resolves a Brand into
    `definition.design`, and the wizard's Design step cannot be removed until something else owns
    those values.

  - [x] 2.1 `brands`, its migration, `BrandView`, and `ensureBrand`
    - `app/lib/db/schema.ts`: add `brands` owned by `user_id` — there is no account or organization entity and inventing one is out of scope. Columns: `name`, `theme_preset`, `accent_color`, `logo_key`, `density`, `table_style`, `page_size`, `number_format` jsonb, `cover_page`, `default_approver_names` jsonb keyed by the four stored role ids, `confidentiality_notice_id`
    - Add nullable `brand_id` on `report_templates` referencing it. Both additive; migration generated with drizzle-kit
    - `app/lib/brands/store.ts`: `ensureBrand(userId)` creating the default on first need, populated from the existing `DesignSpec` defaults so a new account is never asked to design a brand before authoring
    - `BrandView` in `app/lib/db/views.ts` dropping `user_id`; `logo_key` is a **key**, never a presigned URL. Projection guard in the same change
    - _Requirements: 2.1, 2.2, 2.3, 22.7_

  - [x] 2.2 The Brand editor
    - `app/app/(app)/brand/page.tsx` plus `app/components/brand/`. Four theme presets as **rendered page images** in a selectable grid, selected card taking a `--ring` and a `--primary` check — consuming the same `ThemeThumbnail[]` source the current `step-design.tsx` already receives, not a new one
    - Accent colour, logo, density, table style, page size, number format, cover page, the four default approver names, and the confidentiality notice
    - Logo upload to a private S3 object under the owner's prefix, presigned per request, never stored. `logo_key` holds the key
    - State the scoping in the UI: a Brand edit applies to the next report, never retroactively
    - _Requirements: 2.4, 2.5, 2.7_

  - [x] 2.3 Resolve the Brand into the definition at publish
    - `publishTemplateVersion` resolves the Brand's values into `definition.design` between validation and `insertVersion`, so the renderer never learns Brands exist and nothing under `agent/` changed
    - **The tests shipped with it were tautologies and were rewritten.** The original asserted `definitionSha256(x) === definitionSha256(x)` — one object hashed twice — under the name "the version's design cannot be changed by editing the Brand after save", with a comment claiming to simulate a Brand edit while touching no Brand. `f(x) === f(x)` is true because hashing is deterministic, so it would have passed unchanged if resolve-at-publish were replaced by the runtime dereference it exists to forbid. A test whose name asserts a property it never exercises is worse than none: it makes a reviewer believe the property is guarded
    - **Tested at the mechanism, deliberately.** `resolveDesignFromBrand` is exported for test because the publish path around it is only reachable with a real Postgres — this repo's store tests are integration tests that skip without a database — so a test driving the whole path would not run in ordinary development. Six tests assert the Brand's values land INLINE, the incoming definition's own design is overwritten rather than merged, no `brand_id` reference key survives, everything else passes through, and a later Brand edit leaves an already-resolved definition alone while a fresh resolve picks the new values up — which together are what "frozen at publish, applies to the next report" means
    - Mutation-checked against the forbidden path itself: replacing the resolve with `{...def, brand_id: brand.id}` fails 4 of the 6
    - One assertion was too broad on its first run and the test caught it: `logo` is legitimately `brands/<id>/logo.png`, an object-storage path embedding the brand id, which is not a dereference. Narrowed to reference KEYS, with the reasoning recorded so it is not re-broadened
    - _Requirements: 2.6, 2.7, 23.2_
    - `app/lib/actions/templates.ts`: in `publishTemplateVersion`, between validation and `insertVersion`, write the referencing Brand's values into `definition.design`
    - This is what makes a saved version self-contained: `DesignSettings`, `render/themes.py`, `compile/format.py` and the `SCHEMA VERSIONS` mirror region are all untouched, and the renderer never learns Brands exist
    - Assert it directly: save a version, edit the Brand, re-render the saved version, and assert the output is byte-identical to the first render. That is Req 2.7 as a test rather than as a rule
    - _Requirements: 2.6, 2.7, 23.2_

  - [x] 2.4 Remove the Design step from the existing wizard
    - Drop `design` from `WIZARD_STEPS` and delete `step-design.tsx`'s route into the shell; `STEP_FOR_FIELD` maps `design` to the step that will own its issues
    - Lands here rather than in Phase 2 so Brand ships complete: the moment Brand exists, re-picking those values per customer stops
    - _Requirements: 2.4_

- [ ] 3. Phase 2 — sections
  - The largest phase and the only one a user sees as the restructure. Order inside it is forced:
    catalogue → schema → expander → compile branch → block compilers → wizard → lifter.

  - [x] 3.1 `catalog/sections.v1.json` and its loader validation
    - Create `agent/src/reporting_agent/catalog/sections.v1.json` declaring `catalogue_version`, `providers.azure.sections`, and the fifteen entries of design §2.3 — each with `key`, `number`, `title_id`, `group`, `position` (`free`/`fixed`/`always`), `repeatable`, `needs_resource_types`, `needs_fact_sources`, `metric_bearing`, `presets` and `expands_to`
    - `app/lib/profiles/sections.ts` imports that file **directly from the agent tree**, the way `app/lib/templates/catalog.ts` already imports `catalog/metrics.v1.json`. One file, both halves — drift is structurally impossible rather than test-detected
    - Because the catalogue is **data** rather than sentinel-mirrored code, it needs the loader validation a sentinel mirror would have given for free. Extend `agent/.../catalog/loader.py`: reject an `expands_to` naming a block key absent from `BLOCK_TYPES`, a `needs_resource_types` naming a type no catalogue declares, a preset naming a metric the metric catalogue does not declare for that type, a duplicate `number`, a `position: "fixed"` entry out of its declared order, and more than one `position: "always"` entry. A malformed entry fails **loudly at load**, never expands to a wrong block sequence
    - Declare the three closing entries `backup_report`, `incident_report`, `recommendations` as `fixed` in that order, and `coverage_and_verification` as `always`
    - Section 4's three sub-sections are three `expands_to` groups within one entry, so 4.1/4.2/4.3 cannot be selected apart
    - Sections 3, 5, 6 and 14 declare inputs no collector supplies yet, so offerability computes `Unavailable` until Phase 5 — no separate flag
    - **Landed:** `catalog/sections.v1.json` with all 15 entries (12/13/14 `fixed` in declared order, 15 `always`), `app/lib/profiles/sections.ts` importing it directly, and six loader rejections in `catalog/loader.py` each naming the offending entry
    - **`blank_rows_table` was pulled forward from task 3.5, and that was forced rather than drift.** The loader rejects an `expands_to` naming a block key absent from `BLOCK_TYPES`; section 13 prints an author-filled table of ruled EMPTY rows, which `resource_table` cannot emit. So the catalogue could not validate against its own rule without the block type existing. `subscription_facts` was NOT needed — section 1 is expressed with existing blocks
    - The agent timed out during its final verification, so the blast radius of an eighteenth block type went unseen and I fixed it: a missing entry in `BLOCK_LABELS` (a `Record<BlockType, string>`, so this was a type error), two hardcoded counts in `mirror.static.test.ts`, one in `composer.test.ts` (now made count-free so the next type does not re-break it), and a missing `rows` value in the property generator. Suites: agent 4596/0, app 2932 passed / 247 skipped / 0
    - Also fixed here, and it was mine: `lastReturning: undefined as unknown` in task 1.8's test fake makes every `{ ...db.lastReturning }` a TS2698. Spreading `unknown` is always an error, so it was latent from the moment that file landed — I misread the typecheck after 1.8 and committed it in c0d6003
    - _Requirements: 3.3, 8.1, 8.5, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 16.1, 22.4_

  - [x] 3.2 `schema_version` 3 in both halves, with the mirror and new corpus fixtures
    - `MAX_SUPPORTED_SCHEMA_VERSION` raised to 3 in both halves, inside the existing `SCHEMA VERSIONS` sentinel region. `REQUIRED_TOP_LEVEL_KEYS[3]` adds `provider` and `sections`, drops `blocks`/`scope`/`metrics`. `provider` closed to `azure`/`aws`/`onprem` with everything but `azure` rejected. Section entries validated: `id` unique 1–64 chars, `type` a known catalogue key, `selection` through the existing `validateScopeSpec` (no second GUID/path rule written), `metrics` through the existing `MetricSelectionItem` validation, `presentation` from its closed set, plus explicit rejection of an unknown type, a duplicate non-repeatable type, and a fixed section out of place
    - Six new reject fixtures plus one accept fixture, none of the 60 pre-existing fixtures touched. Verified directly: digests recomputed and matched, `mirror.static.test.ts`'s head-to-head corpus comparison passes at 315/315 (it subprocess-invokes the Python validator and compares verdict, offender set and digest for all 68 fixtures), and every new rejection reports `block_id: None` with a top-level `sections[n].<field>` path — sections are not blocks, so both halves agree there is no enclosing block, confirmed by the same passing mirror test rather than asserted
    - `test_schema_version_1.py` stays green — stored v1 starters still compile
    - **The agent timed out during its own full-suite run and never saw the result: it broke four pre-existing tests.** `test_schema_version_2.py` used `schema_version=3` as its canonical example of an *unusable* version, written when `MAX_SUPPORTED_SCHEMA_VERSION` was 2. The moment this task made 3 legitimate, those four tests started asserting the resolver was broken on the day it started working. Moved the unusable-version example to `99` in three of them, with the reasoning recorded so `99` is not later mistaken for an arbitrary choice. The fourth (`test_the_version_tables_are_keyed_by_exactly_the_supported_versions`) had a latent bug independent of this task — it asserted `{MIN, MAX}` as a two-element set rather than the full range every version tests, which only passed because MIN and MAX happened to be adjacent (1, 2); fixed to assert the real range
    - Suites verified by me on a clean run, once each, sequentially per the process rule: agent 4628 passed / 0 failed, app 2970 passed / 247 skipped / 0 failed. Typecheck and lint at their pre-existing baselines only
    - _Requirements: 3.1, 3.4, 3.5, 7.1, 7.8, 8.6, 9.2, 20.7, 20.8, 22.3_
    - Raise `MAX_SUPPORTED_SCHEMA_VERSION` to `3` in `app/lib/templates/definition.ts` and `agent/.../compile/definition.py`, inside the existing `SCHEMA VERSIONS` sentinel region so the mirror guard compares it
    - Version-3 key tables: `REQUIRED_TOP_LEVEL_KEYS[3]` adds `provider` and `sections` and drops `blocks`, `scope` and `metrics`; `provider` validated against the closed set `azure`/`aws`/`onprem` with everything but `azure` **rejected** until a catalogue exists
    - Validate a section entry: `id` 1–64 chars and unique, `type` a known catalogue key for the profile's provider, `selection` through the existing `validateScopeSpec` (which already rejects GUIDs and `/subscriptions/...` paths — this is Req 9.2 with no new rule), `metrics` through the existing `MetricSelectionItem` validation, `presentation` from the closed set. Reject an unknown `type` **explicitly**, reject a duplicate non-repeatable type, reject a fixed-position section out of place
    - Offender paths must be the identical tuple of string keys and integer indices in both halves — the contract `offenderKey(blockId, fieldPath)` compares
    - Add v3 accept and reject fixtures to `agent/tests/fixtures/definitions/` with manifest entries carrying `verdict`, `definition_sha256` and `offenders`. **Edit no existing fixture.** The five deliberately-invalid ones still reject at path `["schema_version"]` after the bump because the manifest pins paths and digests, not message text, and no fixture asserts the maximum's literal value
    - Keep accepting 1 and 2 in both halves; `test_schema_version_1.py`'s stored-starter compilation stays green
    - _Requirements: 3.1, 3.4, 3.5, 7.1, 7.8, 8.6, 9.2, 20.7, 20.8, 22.3_

  - [x] 3.3 `compile/sections.py::expand_sections` with its determinism guards
    - `expand_sections(definition, *, catalogue, view) -> tuple[BlockSpec, ...]`, pure: no Azure, no ledger, no I/O. Three-tuple sort key `(group_rank, position_rank, catalogue_number)` — group order inventory/utilisation/closing, then authored `position` for `free` entries, catalogue-declared order for `fixed` entries via `LoadedSectionCatalogue.fixed_entries` (ignoring stored position entirely), `always` sorted last within its group, catalogue number as tiebreaker
    - Derived ids: `<section.id>__<expansion_index>` for `per: "section"`; `<section.id>__<expansion_index>__<n>` for `per: "resource"`, where `n` is the index in `compile/scope.py::resolve`'s returned `tuple[ResourceView, ...]` — confirmed by reading the signature, not assumed. A resource ordinal travels in `config["_resource_ordinal"]`, never a resource id in the definition
    - Two determinism guards, both mutation-checked by me: anchor-id-set stability across two expansions, and full `BlockSpec` tuple equality across ten iterations (catches dict/set iteration-order nondeterminism a single repeat could miss). Breaking the sort key fails exactly the two ordering tests that name the property, not a downstream symptom
    - Verified independently: 17 targeted tests pass, ruff clean, full agent suite run by me from a clean state — 4645 passed / 0 failed, matching the agent's own reported number
    - _Requirements: 7.1, 8.4, 9.1, 9.7, 21.5_
    - Create `agent/src/reporting_agent/compile/sections.py` with `expand_sections(definition, *, catalogue, view) -> tuple[BlockSpec, ...]` — **pure**: no Azure, no ledger, no I/O
    - Ordering: `group` order (`inventory`, `utilisation`, `closing`), then authored `position` within a group, then catalogue order for `fixed` entries, then the `always` appendix last. Fixed entries ignore their stored `position` entirely
    - Derived block ids: `<section.id>__<expansion_index>` for `per: "section"`, `<section.id>__<expansion_index>__<n>` for `per: "resource"` where `n` indexes the resolved order from `compile/scope.py::resolve` — already deterministic (declaration order, then top-N ranking, unranked appended last)
    - A `per: "resource"` block carries the section's `selection` as its `scope_override` plus a resource **ordinal**; it never stores a resource id, because the definition holds only rules
    - Guard — **anchor stability**: compile one profile twice and assert identical anchor id sets. An expander whose ids depend on iteration order rather than resolved order breaks replay's bit-identical-ledger assertion, and does so intermittently
    - Guard — **determinism** over a fixed snapshot: two expansions produce identical `BlockSpec` tuples
    - _Requirements: 7.1, 8.4, 9.1, 9.7, 21.5_

  - [x] 3.4 The `compile_document` branch
    - `if schema_version >= 3: specs = expand_sections(...) else: specs = _block_specs(definition)`, with `catalogue` and `authored_matches` added as keyword parameters both defaulting to `None`. `catalogue=None` at v3 raises `CompileFailedError` naming the requirement, rather than falling through to `_block_specs` and failing on the unrelated missing `blocks` key. The import is deferred inside the branch — a top-level import would be circular: `compile/sections.py` imports `BlockSpec` from `compile/blocks/base`, which this package's `__init__.py` must finish initializing before that submodule is reachable
    - **Found while writing the byte-identical test, not by reading: two real defects in work already committed at `7b10162`.** (1) `expand_sections` does not resolve a catalogue entry's `title_id` into a `heading` block's required `text` field, and every one of the 15 shipped catalogue entries opens with a `heading` — so no catalogue-declared section can compile today. (2) Independently, every `resource_table` entry in `catalog/sections.v1.json` declares its `columns` as bare strings (`["type", "count"]`), but `read_column_entries` requires objects with a `kind` discriminator — task 3.1's own tests checked the catalogue's structure (entries, positions, rejections) but never round-tripped a declared entry through the compiler, so nothing caught it. Both are pre-existing defects surfaced by this task's own verification bar, not introduced by it
    - **Neither is fixed here — both are out of scope for "wire the branch".** The byte-identical test isolates the mechanism this task owns from both gaps with a synthetic single-entry catalogue carrying a `resource_table` with correctly-shaped columns and no heading, so the test proves what 3.4 is responsible for without silently absorbing a content fix that belongs to whichever task actually emits section titles and to a follow-up correcting `sections.v1.json`'s column config across all twelve `resource_table` entries
    - Mutation-checked: corrupting the derived block-id format fails the byte-identical test naming the anchor mismatch, not a downstream symptom
    - Suite: 4648 passed / 0 failed (was 4645), run once by me from a clean state
    - _Requirements: 7.1, 21.1, 21.2, 21.3_

  - [x] 3.5a Title resolution, the catalogue's column-shape fix, and a real `blank_rows_table` bug — `subscription_facts` deferred, see 3.5b
    - **Title resolution** (the gap 3.4 found): `expand_sections` now takes a `messages: Messages` keyword parameter — still pure, since a `Messages` lookup is an in-memory read, not I/O — and resolves a `heading` expansion's `text` from `config.title_id` when the expansion declares one (the `virtual_machines` entry's three subsection headings), else from the section's own catalogue `title_id` (every other entry). 19 new `doc.section.*` message ids added to both the JSON catalogue and its TS mirror, verified against `message-catalog.static.test.ts`
    - **The catalogue's column-shape fix**: all 12 `resource_table` entries' bare-string `columns` converted to typed `ColumnEntry` objects (`{"kind": "attribute", ...}` for the 7 in `COLUMN_ATTRIBUTES`, `{"kind": "fact", "fact_key": ...}` for everything else) — done by a subagent, verified directly against the diff
    - **Found and fixed while verifying the above, not part of either fix**: `compile_blank_rows_table` (task 3.1's own work, never exercised end to end until now) called `cursor.child("rows", row_idx, col_idx)` with 3 positional arguments against a method that takes exactly one field name and one ordinal — `BlockCursor.child` composes by chaining, not by flattening. Fixed to `cursor.child("rows", row_idx).child("cells", col_idx)`. The delegated subagent's transformation had also (incorrectly) applied the `resource_table` column-object shape to `blank_rows_table`'s `columns`, which wants plain header strings — a different, simpler schema; reverted that one entry
    - Two new tests in `test_blocks.py` drive `compile_blank_rows_table` directly with more than one row and more than one column — the shape the existing corpus-only fixture never exercised. Mutation-checked: reintroducing the 3-argument call fails both, restoring passes both
    - Comprehensive regression test in `test_expand_sections.py`: every catalogue entry whose expansion needs only a title and static columns now compiles end to end through the real (not synthetic) catalogue, including the `title_id`-override branch via `virtual_machines`'s three subsection headings
    - Suite: agent 4653 passed / 0 failed (was 4648), app 2970 passed / 247 skipped / 0 failed (unchanged) — both run once by me from a clean state
    - _Requirements: 15.6, 15.8, 22.3_

  - [ ] 3.5b `subscription_facts` — blocked on a design decision, not implementation effort
    - **Genuinely undesigned, found while implementing 3.5a — not a mechanical fix like the other three gaps found this task.** `subscription_facts` needs to emit `TextFactCell`s minted via `BlockCursor.text_fact(FactTextValue)`, and `FactTextValue` requires a `resource_id` field (Req 6.2/6.3's provenance contract) — but a subscription-level fact belongs to no resource. `SnapshotView._facts_by_pointer` has no separate index for a fact scoped to the subscription rather than a resource; there is no existing snapshot shape anywhere in `azure/`, `collect/` or a fixture that represents one
    - Needs a decision before implementation can start: does `FactTextValue.resource_id` become optional (and every existing reader of that field re-audited for what "no resource" means to it), or does the subscription's own id fill that field (and then what makes a subscription-level fact structurally distinct from a resource-level one at all), or does the snapshot gain a new top-level `subscription_facts` collection with its own value type. This is a snapshot-schema decision — `structure.md`'s `snapshot.py` "writes once, no update path" and immutability guarantees mean it should be settled once, not iterated on after collectors exist
    - The shipped catalogue does not currently reference `subscription_facts` in any `expands_to` (confirmed by inspection: `azure_subscription` uses `heading` + `resource_table` today), so nothing blocks on this for the sections already catalogued — it blocks only a future catalogue entry that needs it
    - _Requirements: 15.6, 15.8, 22.3_

  - [ ] 3.6 The five-step wizard shell
    - `app/lib/profiles/wizard.ts` (moved from `app/lib/templates/wizard.ts`, same exports): `WizardStepId` becomes `"identity" | "sections" | "period" | "document" | "preview"`, `WIZARD_STEPS` five entries, `STEP_FOR_FIELD` mapping `schema_version`/`provider`/`identity` → identity, `sections` → sections, `period` → period, `front_matter`/`design` → document
    - Reuse unchanged: `issuesByStep` grouping `collectDefinitionIssues(definition, { mode: "draft" })` by first path segment, `canAdvance` blocking only on the current step, `canReturnTo`, `openingStep`, `completionProblems` in `run` mode
    - Draft persistence unchanged: fire-and-forget `PATCH` with `draftDefinition` on every step transition, `POST` on **Save version**
    - `provider` collected on step 1, `azure` selectable, `aws` and `onprem` declared and not selectable, and not changeable once a version exists
    - _Requirements: 3.2, 3.6, 7.2, 7.3_

  - [ ] 3.7 Step 2 — the section list and the inspector
    - Left: the ordered list, numbered as it will print, grouped under `Inventory` / `Utilisation` / `Closing`, with the front-matter group shown present and not reorderable pointing at step 4
    - Fixed-position sections render with **no drag handle** and are excluded from keyboard reordering, with the reason stated
    - **Keyboard reordering is mandatory and decides the drag-and-drop library**, not a follow-up: the canvas is a real DOM list in render order, each item focusable, modifier+arrow moves it, and every move announces through one `aria-live="polite"` region naming the new position. Evaluate candidate libraries against this first. Drop indicator is a 2px `--primary` rule at the insertion point, never a shifting ghost layout
    - Right: the inspector. Resource **chips drawn from the scan**; clicking one narrows the **rule** by resource group or tag. Where the desired subset is not expressible as `type × resource_groups × tag_filters`, say so and offer the dimensions that would express it — there is no field in which to store ids
    - Metric picker: only metrics the catalogue declares for the types this section's rule matches **in the scan**, replacing `buildPartitions`, which renders every catalogue type in one of two partitions. State how many apply and why the others are absent. Preset row (`Standard utilization` / `Capacity planning` / `Everything` / `Custom`) switching to `Custom` when the selection stops matching a preset; per-metric chips; statistic multi-select over Average/Maximum/Minimum requiring at least one
    - **No typed metric names, no typed statistics, no JSON** — the raw-JSON path `fieldValue`/`parseFieldValue` provides in `block-inspector.tsx` has no successor
    - A percentile statistic copies `estimator` and `fidelity_tier` from the catalogue; a stored metric the catalogue no longer declares is marked and blocks saving, as `findUndeclaredEntries` already does
    - Presentation choice `Chart + table` / `Chart only` / `Table only`
    - _Requirements: 7.4, 7.5, 7.6, 7.7, 8.2, 8.3, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9_

  - [ ] 3.8 The emit estimator and its cross-language fixture
    - `app/lib/profiles/emit.ts`: `estimateEmit(section, scan, catalogue)` → `{headings, charts, tables, figures}`. Pure — no fetch, no db. Walks the same `expands_to` the expander walks, over the scan's `type_counts` instead of a snapshot. Figures are `statistics × metrics × matched_resources` plus declared fact columns, which is the arithmetic the compiler performs
    - The inspector shows the summary and states it is counted from the scan before anything runs. A section matching zero resources says so in **mist neutrals**, stays selected, and is not an error
    - Step 5 states the profile's total estimated figure count and how many sections are estimated to emit nothing
    - **The estimator and the expander cannot be compared by a static mirror** — one is TypeScript, one is Python. Create a shared expectation fixture of `(catalogue entry, synthetic scan, expected counts)` cases, read by a vitest test against `estimateEmit` **and** by a pytest test compiling over a synthetic snapshot built from the same counts. A change to the expansion that moves the counts then fails on both sides or neither
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.6, 11.7_

  - [ ] 3.9 Zero-resource sections at compile time
    - `expand_sections` emits, for a section whose rule resolves to zero resources, the explicit "No resources matched this scope" row. The section never vanishes: a disappeared section is indistinguishable from one never configured, in the builder and in the delivered document alike
    - Assert it for a v3 section, and assert the existing zero-resource block behaviour is unchanged for v1/v2
    - _Requirements: 11.5_

  - [ ] 3.10 Authored matches: the table and the write
    - `app/lib/db/schema.ts`: `report_profile_authored_matches` with `template_version_id` → `report_template_versions`, `scan_id` → `subscription_scans`, `section_id`, `matched_count`, `matched_resource_ids` jsonb, `unique(template_version_id, section_id)`
    - Written by the publish path **after** `insertVersion` returns. `insertVersion` may return an **existing** version when the digest is unchanged, in which case the rows already exist — hence the unique pair and an upsert, not an insert
    - Kept out of the definition deliberately: `definition_sha256` is compared head-to-head across both validators and pinned per fixture, so putting customer resource ids inside the hashed definition would make the digest a function of the estate and break `insertVersion`'s dedupe. Assert that: two profiles with identical sections authored against different scans produce the **same** digest
    - Not projected to the browser
    - _Requirements: 9.5_

  - [ ] 3.11 Drift in the coverage appendix
    - `agent/.../compile/blocks/record.py`: the coverage appendix compares `authored_matches` against what each section's rule resolved to in the snapshot, naming resources **added** and **no longer matching**
    - **The counts are numbers in a delivered document, so they cannot be bare strings.** Extend `DERIVED_COUNT_KINDS` with `scope_added_count` and `scope_removed_count`, reusing the `DerivedCount` mechanism task 11.7 built and the verifier's existing independent re-derivation from the ledger. Assert the re-derivation for both new kinds
    - Every matched resource is included and announced — never withheld pending confirmation, never excluded silently
    - Styling in mist neutrals, never `--destructive`: a newly matched resource is the rule working
    - State the count of resources scanned, carrying statistics, recorded as gaps, and changed in scope; name the scan the version was authored against and the snapshot the run collected
    - `authored_matches` joins the `generate_report` payload: documented in `agent/AGENTCORE_INTEGRATION.md` in **this** commit, with the static mirror guard extended to it
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 22.1, 22.2_

  - [ ] 3.12 The migration lifter
    - `app/lib/profiles/lift.ts`: `liftDefinition(stored)` → `{draft, brand, unmapped}`. Pure, app-side only — a lift produces a wizard draft and the runtime never sees one, so mirroring it would guard a path that does not exist
    - Lift `design` into a Brand carrying exactly those values and reference it. Carry a v2 `front_matter` through **unchanged**
    - Map each block onto the section emitting the closest AST, carrying its `scope_override` — or the template default scope where it has none — onto that section's selection rule. `heading`, `rich_text`, `page_break`, `row` and `comparison_delta` are **unmapped by design**: they are composition primitives or a run pairing, and section titles now come from the catalogue
    - Report every unmapped block with its type and id; the wizard presents the report and requires the author to choose sections. Never drop content silently
    - Writes nothing to `report_template_versions`; the draft goes through the existing unvalidated `saveDraft` path, which is what that column is for
    - Test over the shared corpus, which supplies **both** stored versions — 44 fixtures at `schema_version` 1 and 10 at 2. For every accepting fixture, assert the produced draft is accepted by `collectDefinitionIssues(draft, { mode: "draft" })`
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6_

  - [ ] 3.13 Version-3 starter profiles
    - Replace the three starters in `app/lib/templates/starters.ts` with v3 profiles, keeping the existing v1 starters valid so accounts seeded before this change still open
    - `app/test/starters.static.test.ts` validates each in `mode: "run"` through the same `collectDefinitionIssues` every route handler uses
    - _Requirements: 20.9_

  - [ ] 3.14 The rename
    - UI routes `/report-profiles` and `/report-profiles/[id]/edit`; API routes `/api/report-profiles` and `/api/report-profiles/[id]`, shapes unchanged except where this spec changed them
    - Redirects from the former routes, so a bookmark or an open tab resolves rather than 404s
    - The noun **Report Profile** on every user-visible surface — navigation, list, wizard heading, run screen selector, report detail, every empty state — resolved through `messageText` in both languages
    - `report_templates`, `report_template_versions` and the `template_version_id` wire field keep their names. Where a stored column, wire field or internal symbol keeps the word "template", it is not surfaced
    - Extend the literal-copy guard to the profile, section and brand surfaces; zero offenders
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 22.5, 22.6_

- [ ] 4. Phase 3 — the Document step
  - Independent of charts and collectors. Ships after Phase 2 because the fields live on a v3 profile.

  - [ ] 4.1 `front_matter` at version 3
    - `approvers` entries gain `company` and `signature_key`; `distribution` becomes ordered rows of `{recipient, company, note}`. Additive at v3 only — the v2 string form keeps validating, so a lifted v2 profile keeps its front matter until the author edits it
    - The four roles keep the stored ids `("author", "reviewer", "approver", "recipient")`, relabelled **positionally** to `Author` / `Quality Control` / `Reviewed By` / `Customer` through the message catalogue in both languages. No fixture, no mirror region and no validator rule changes to relabel a row. The set stays closed at four — a fifth role is rejected, because the signature table's row height is a theme style
    - Step 4 collects, in the order they print: customer name, report title, document name, document number pattern, four approver rows, distribution list, and the confidentiality notice **inherited from the Brand and not editable per profile**, naming the Brand as where it is edited
    - Approver names default from the Brand with a per-profile override
    - An empty distribution list prints its header only
    - The document number pattern is shown **resolved** against the profile's current period, with the consequence stated beside the field: a pattern naming no `{run}` resolves two runs of one period to the same number. `document_number(pattern, *, run)` and the existing rejection of a pattern with no varying placeholder are unchanged
    - _Requirements: 12.1, 12.3, 12.4, 12.5, 12.6, 12.7, 14.1, 14.2, 14.3, 14.4_

  - [ ] 4.2 Signature images
    - Upload to a private S3 object under the owner's prefix, presigned per request, never stored. Reject anything that is not a recognised raster image or exceeds a declared byte ceiling, stating the reason
    - Resolved to **bytes server-side in the app** and passed inline in the invoke payload. The runtime holds no session and must not fetch content from the app; the bytes are excluded from every log line by the existing payload-logging rules
    - _Requirements: 13.5, 13.6_

  - [ ] 4.3 The signature cell, with the unsigned box as the fallback
    - `agent/.../render/front_matter.py::_emit_approvers_table`: keep `row_cells[3].text = ""` unconditionally, then place the image when one exists, then call `_set_row_height(row, SIGNATURE_BOX_HEIGHT_TWIPS)` **after** either path. `w:hRule="atLeast"` plus an image scaled to fit within that height is what makes a signed row and an unsigned row occupy the same space, so pagination does not depend on who signed
    - The name still prints in the name column: the row states who was to sign while stating that they did not
    - Extend `agent/tests/test_front_matter.py::TestSignatureBox`: an unsigned cell is empty; a signed cell contains the image and **still no text**; a signed row's height equals an unsigned row's. Mutation-check both directions — reintroduce the typed name and watch it go red
    - A signature is presentation: no ledger entry, no numeric gate, and its absence is not a finding
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.7_

  - [ ] 4.4 Run-time shrinkage
    - `app/components/reports/run-form.tsx`: drop `customerName`; keep `revision`, `revisionNote`, `revisionAuthor`; add the incident rows. Nothing that identifies the customer is asked at run time
    - `customer_name` stays **on the wire**, sourced from the pinned version instead of a form field, so `report_pipeline.py::_resolve_run_facts` keeps its `payload.get("customer_name")` read and the existing store-to-send mirror guard keeps applying with no change to its mechanism
    - `period_display` continues to be computed in the app with `Intl.DateTimeFormat` against `identity.language`
    - Revision history rows print in the order recorded, so the control page reads as a history
    - _Requirements: 12.2, 12.8, 12.9, 14.5, 14.6, 22.2_

- [ ] 5. Phase 4 — charts
  - Independent of every phase above; ships any time after Phase 0.

  - [ ] 5.1 `panels` on the `Chart` node, and the grouping rule
    - `agent/.../compile/ast.py`: `Chart` gains `panels: tuple[tuple[str, ...], ...] = ()`. Empty means one panel with every series, so every existing construction and test stays valid
    - `panel_groups(series) -> tuple[tuple[str, ...], ...]` — pure, deterministic: series whose max absolute value differ by an order of magnitude or more split panels, ordered by descending panel maximum so the larger-magnitude panel sits on top, as `design/Charts.dc.html` shows
    - The **compiler** assigns panels, not the renderer: a renderer inferring panels from units would make a data decision the ledger cannot show, and the in-app chart would have to infer it identically by accident
    - Mirror the thresholds into `app/components/charts/` and extend the existing `test_chartstyle.py` mirror pattern — which already reads `palette.ts` and asserts value equality — to cover them
    - _Requirements: 17.1, 17.2_

  - [ ] 5.2 The renderer draws N stacked panels
    - `agent/.../render/charts.py`: replace `figure.add_subplot(111)` with `figure.subplots(panel_count, 1, sharex=True, squeeze=False)`, calling `_draw` once per panel with that panel's series. Each panel scales to its own data; **no** 0–100 range is imposed on a percentage unit, which is already true and must stay true
    - Title each panel with the statistic it carries, so a reader knows which is the maximum without a legend
    - `_draw` keeps its signature; `_bar_offsets` now counts series **within a panel**
    - `chartstyle.py` gains `CHART_PANEL_HEIGHT_INCHES`, `CHART_PANEL_GAP_INCHES` and `chart_size_inches(panels)`; `frozen_rc_params()` keeps pinning dpi, pad and `figure.autolayout: False`, which is what keeps the PNG byte-reproducible
    - `docx.py::emit_chart` unchanged: `_CHART_WIDTH_INCHES = 6.0` still matches the figure width, so a taller PNG embeds without resampling
    - _Requirements: 17.3, 17.4, 17.5, 18.8_

  - [ ] 5.3 One value label per series, and the tests that assert the old contract
    - `label_indices` becomes the last point only; delete `_LABEL_THRESHOLD`
    - **Rewrite the assertions in `agent/tests/test_charts_10_1.py` that pin the ≤24-labels-all contract in this same change.** A test asserting the superseded behaviour is otherwise the reason this change gets reverted by whoever next runs the suite
    - The direct label at each series' line end stays and becomes load-bearing: it is now the only thing naming a series near its data. The companion table carries every value, so removing labels removes redundancy rather than information
    - Keep marker shape and dash pattern keyed by stable series key, never by array index; keep gridlines from `--border`, axis labels and ticks from `--muted-foreground`, value labels through `chartstyle.value_label_color(theme)`, and `--destructive` on nothing
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.9_

  - [ ] 5.4 The in-app chart renders the same panelling
    - `app/components/charts/themed-chart.tsx`: `HEIGHT` becomes per-panel × panel count, with one `yFor` per panel and a shared x-axis. Same spec, same panelling — the chart in the app and the chart in the document differ in medium, not in content
    - _Requirements: 17.6_

  - [ ] 5.5 The invariants panelling must not move
    - `chart_data_hash` unchanged by panel assignment, panel titles and axis titles — **mutation-checked**: add a panel field to the hash input and watch verification fail on a correct report, then revert. The hash is over `(series.key, point.x, str(point.y.value))` and `verify/charts.py` recomputes it from the AST, which is why panelling is invisible to the verifier
    - The companion table carries every plotted point of **every** panel, unthinned, on the same terms `test_charts.py` already asserts for one panel
    - One PNG per `Chart` node, one sidecar, one `cht:<path>` alt-text identity — the pairing contract the verifier matches on
    - `plotted_series`'s five-series cap and aggregate apply to the chart, not per panel
    - Every categorical series above 3:1 against `--background` and `--card` in both themes, every pair above the 0.06 CVD ΔE floor — `app/test/palette.static.test.ts` and `agent/tests/test_chartstyle.py` unchanged and still green
    - _Requirements: 17.7, 17.8, 18.8, 18.9, 21.3_

- [ ] 6. Phase 5 — the four collectors
  - Four independent increments. Each flips one section from `Unavailable` to `Ready` by adding to
    the catalogues; none blocks another.

  - [ ] 6.1 Virtual network — subnets, CIDR, available IPs, peering
    - Resource Graph projection in the existing inventory pass, `mv-expand`ing subnets into **synthetic child resources** with real ARM ids (`…/virtualNetworks/vnet-a/subnets/app-tier`), each an ordinary `ResourceRecord` of type `Microsoft.Network/virtualNetworks/subnets` with scalar facts `address_prefix`, `available_ips`, `peering_state`
    - Declared in `catalog/facts.v1.json` and **never** in `catalog/metrics.v1.json` — the property `is_child_type` tests and the reason task 1.2's two guards exist
    - Numeric facts as fixed-precision decimal strings, text facts as exact strings; every response archived in the same pass so replay reproduces the snapshot
    - Section 3's document shape is `resource_table` with fact columns — no new block type
    - _Requirements: 16.4, 16.8, 16.9, 16.10_

  - [ ] 6.2 Public IP addresses — address, allocation method, SKU, association target
    - Resource Graph projection; `Microsoft.Network/publicIPAddresses` is a first-class resource, not a child type, so it **does** count toward headline totals
    - _Requirements: 16.5, 16.8, 16.9, 16.10_

  - [ ] 6.3 Network security groups — inbound and outbound rules
    - Resource Graph projection `mv-expand`ing rules into child resources (`…/networkSecurityGroups/nsg-web/securityRules/allow-https`) with scalar facts `priority`, `direction`, `protocol`, `source`, `destination`, `port`, `action`
    - **Omit Azure's own defaults at priority 65000 and above**, so the section reports the rules an operator wrote
    - _Requirements: 15.4, 16.6, 16.8, 16.9, 16.10_

  - [ ] 6.4 Azure Advisor as a fifth fact source
    - `DECLARED_FACT_SOURCES` in `agent/.../catalog/loader.py` gains `"advisor"` — this single edit is what flips section 14's offerability, because `COLLECTED_FACT_SOURCES` derives from it
    - `DECLARED_ABSENT_GAP_TYPES` gains `"advisor_not_available"`, with the constant in `collect/log.py`
    - Entries in `catalog/facts.v1.json` with `source: "advisor"`, `projectable: false`, carrying priority and category
    - A port method in `azure/ports.py` implemented in `azure/clients.py`; `_collect_advisor` in `azure/facts.py` following `_collect_backup`'s shape — semaphore, request-target constant, value paths, `narrowed_to_gap_type(...)`, added to the `asyncio.gather`
    - `self._archive(...)` **before** folding, the write-then-fold order every other source uses
    - A permissions failure records `fact_unavailable`, **never** the absent-gap type — the distinction the reservations source already draws, and the one that turns a role problem into a data problem if it is got wrong
    - _Requirements: 16.7, 16.8, 16.9, 16.10_

  - [ ] 6.5 Flip the four sections, and prove no headline count moved
    - With the collectors in place, sections 3, 5, 6 and 14 compute `Ready` from the catalogues with no separate flag; remove nothing, because offerability was always derived
    - Re-run task 1.2's Guard B against the real catalogues: **the same synthetic estate reports the identical `resource_count` and `type_counts` before and after**. This is the property that makes this phase safe to ship to a customer mid-engagement — without it an untouched subscription reports 47 resources one month and 71 the next, and the report claims growth that never happened
    - Where a genuine cross-catalogue-version count change ever occurs, `subscription_scans.sections_catalogue_version` is what attributes it to the catalogue rather than the estate. No new column
    - Render every one of the fifteen catalogue entries through the `.docx`, HTML and PDF emitters in at least one guard: a section no guard has ever rendered is a section whose emitter has never run
    - _Requirements: 15.9, 16.1, 16.2, 16.3_

- [ ] 7. Closing — the contract, and one end-to-end run
  - [ ] 7.1 The invoke contract and its mirrors
    - `agent/AGENTCORE_INTEGRATION.md` documents every payload field this spec added, in the commit that added it — a field on the wire that is not in that file is a field nobody can verify
    - The static mirror guard extracts the keys the runtime actually reads and asserts the app sends exactly those, for the new fields as for the old
    - Assert both halves load `catalog/sections.v1.json` and agree on entry set, canonical numbers, declared resource types, declared fact sources, fixed positions and preset metric sets — the behavioural form of Req 22.4, since one shared file makes a structural mirror unnecessary
    - Confirm no new environment variable, no new SSE event type, no dropped column: `app/.env.example`, the event mirror and `app/test/migrations.static.test.ts` all pass unedited
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.8, 22.9_

  - [ ] 7.2 Delivered reports stay frozen
    - Assert every existing `report_template_versions` row is byte-identical after this spec, that a run pinned to a `schema_version` 1 version renders exactly as delivered, that `insertVersion`'s same-digest-no-new-version rule still holds, and that a report's `snapshot_sha256` / `docx_sha256` / `pdf_sha256` still support re-verification against the exact snapshot it came from
    - _Requirements: 23.1, 23.3, 23.4, 23.5, 21.1, 21.7_

  - [ ] 7.3 One closing end-to-end run
    - Connect a subscription, scan it, author a v3 profile from offerable sections, see an emit summary, request a report with only a period and a revision note, and assert: front matter with an empty ruled box for the unsigned customer row, a two-panel CPU chart with one value label per series, a coverage appendix naming rule drift through `DerivedCount`, a passing verification, and a bit-identical replay
    - Assert the same run through a lifted v2 profile, so the migration path is exercised end to end and not only in the lifter's unit tests
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7_
