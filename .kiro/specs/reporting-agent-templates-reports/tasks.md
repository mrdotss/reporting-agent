# Implementation Plan: reporting-agent-templates-reports

## Overview

Build the report half in the order the design's dependencies force: four **foundation
touch-ups first**, because a guard this spec adds fails on day one without one of them and a
phase this spec drives cannot compose the collector without another; then the schema, the stores
and the browser-safe projections; then the definition model, declared **twice** with its mirror
guard, and the pure app-side modules the wizard rests on; then the agent's compile stage in the
one order its aliasing allows — `snapshot_view.py` → `ast.py` + `figures.py` + `format.py` →
`scope.py` → `blocks/` — with the AST numeric-leaf guard shipping in the same task as the
declarations it guards; then the four theme documents and the container image, because
`render/pdf.py` cannot be exercised without LibreOffice, its fonts and a pre-warmed profile;
then the two emitters over the one tree; then the verifier, pass by pass, with the
replay-purity guard shipping with `verify/replay.py`; then the pipeline, the commands, the
events and the extended state machine; then the wizard, the composer and the report surfaces;
then the **six mandatory negative tests as their own tasks**, each asserting a failure; and
finally the guards, the property hygiene, the regression gate and one end-to-end run.

The spec ends when a composed template version, pinned to a run, compiles against an immutable
snapshot, renders to `.docx` and `.pdf`, passes a verification that has been observed failing on
sixteen deliberately broken documents, and presents exactly two download controls that exist for
no unproven run.

Everything the foundation delivers is referenced and re-built nowhere. No task re-runs
`shadcn init`, regenerates `app/components.json`, or replaces any existing token value in
`app/app/globals.css` — the only edit to that file is the **additive** `--cat-*` block. No task
recreates `lib/auth/*`, `lib/crypto.ts`, `lib/env.ts`, `collect/*`, `azure/*`, `storage/*`,
`events.py` / `lib/events.ts` (the vocabulary is unchanged at ten types) or any foundation
migration.

## Tasks

- [x] 1. Foundation touch-ups and the two unpinned dependency families
  - [x] 1.1 Move `OWNER_TAG_KEY` and `owner_tags` into the pure storage base
    - Move `OWNER_TAG_KEY` and `owner_tags` from `agent/src/reporting_agent/storage/s3.py` into `storage/base.py`, which imports no cloud SDK, and re-export both from `storage/s3.py` so every existing caller and every existing test keeps its import path
    - Change `collect/snapshot.py`'s import (currently `from reporting_agent.storage.s3 import owner_tags` at line 166) to read from `storage/base.py`
    - This is a **prerequisite, not a tidy-up**: `verify/replay.py` must import `collect/snapshot.py` for `build_snapshot`, `canonical_bytes` and `content_hash`, so `collect/snapshot.py` sits on replay's transitive import closure — and today that closure reaches `boto3` through this one symbol, which the replay-purity guard of task 9.9 fails on before it has a chance to pass
    - Assert behaviour is unchanged: `.venv/bin/pytest` and `.venv/bin/ruff check .` clean, with `tests/test_storage_s3.py` and `tests/test_snapshot.py` untouched
    - _Requirements: 31.2, 31.7_

  - [x] 1.2 Extract `run_collection(...)` from `collect/pipeline.py`, keeping the existing entry point as a wrapper
    - Add `run_collection(...)` yielding the same events it yields today and **returning** a `CollectionOutcome` — snapshot document, `snapshot_id`, resource count, gap count, gap list, `partial: bool` and the raw-archive completeness flag — instead of raising `PartialCoverageError`
    - Keep `run_generate_report(...)` as a thin wrapper that consumes `run_collection` and raises `PartialCoverageError` at the end, so a snapshot-only invocation behaves exactly as it does today and every foundation test in `tests/test_collect_pipeline.py` and `tests/test_run_wiring.py` still passes unmodified
    - The report pipeline needs the raise **deferred**: a run carrying gaps still completes, and its non-terminal `PARTIAL_COVERAGE` event must arrive before `done` rather than before compilation
    - _Requirements: 41.1, 41.4_

  - [x] 1.3 Add the six terminal error codes to both halves
    - `agent/src/reporting_agent/errors.py`: six `AgentError` subclasses with `default_terminal = True` for `TEMPLATE_INVALID`, `COMPILE_FAILED`, `RENDER_FAILED`, `PDF_CONVERSION_FAILED`, `VERIFICATION_FAILED` and `REPLAY_MISMATCH`; `TIMEOUT` and `SECRET_UNREADABLE` stay app-written and unraisable here
    - `app/lib/db/schema.ts`: append the same six values to the `run_error_code` enum with `ALTER TYPE … ADD VALUE`, removing nothing, and generate the migration with drizzle-kit
    - `app/lib/runs/state.ts`: add the six to the terminal error-code set. **Leave `DRIVEN` and `PHASE_DEADLINE_SECONDS` alone** — the three phases become driven in task 11.5, because `verifying → completed` carries a precondition on a `report_verifications` row that does not exist yet, and driving the transition before that row exists would open a window in which a run reports success with no stored proof
    - Assert `app/test/migrations.static.test.ts` still passes: the change is additive and drops nothing
    - _Requirements: 41.2, 41.6, 9.10, 2.8, 25.2, 31.3_

  - [x] 1.4 Add `RPT_PROSE_MODEL_ID` to the agent's config and create `agent/.env.example`
    - Add `RPT_PROSE_MODEL_ID` to `agent/src/reporting_agent/config.py`'s `REQUIRED_ENV_VARS` tuple and to the frozen `Config`, resolved through the existing `_require` so an absent or whitespace-only value raises `MissingConfigError` naming the variable and excluding its value
    - Create `agent/.env.example` declaring `AWS_REGION`, `RPT_ARTIFACT_BUCKET` and `RPT_PROSE_MODEL_ID` with non-empty placeholders
    - It must **not** go in `app/.env.example`: the foundation's Boundary_Guard asserts that file's key set **equals** the app's `REQUIRED_ENV_VARS`, and an agent-only variable there fails that guard. Extend `tests/test_config.py`'s declared-order assertion to cover the third variable
    - _Requirements: 19.1, 19.2_

  - [x] 1.5 Resolve, pin and smoke-test the two front-end dependency families
    - From `app/`, `pnpm add` `@dnd-kit/react` on `@dnd-kit/dom` and `recharts`, resolving the exact versions **at install time** against `react@19.2.4` and `next@16.2.6` and writing those exact pins back into `package.json` — no caret, no range, matching every other pin in this repo. dnd-kit ships two lines (`@dnd-kit/core` + `@dnd-kit/sortable`, and the newer `@dnd-kit/react` on `@dnd-kit/dom`); pick the newer line and record the resolved versions in the commit message
    - `pnpm dlx shadcn@latest add chart` for the Chart components, plus the Base UI registry primitives the wizard and the report surfaces need: `select`, `checkbox`, `radio-group`, `switch`, `tabs`, `popover`, `table`, `tooltip`, `progress`, `scroll-area`. Adding registry components is safe; `init` is not, and `components.json` is not touched
    - Add `app/components/templates/block-canvas.smoke.test.tsx` mounting an empty canvas under **React 19 StrictMode**, because a strict-mode double-invoke regression in a drag library presents as an intermittent reorder rather than as an error
    - `pnpm lint` and `pnpm typecheck` clean
    - _Requirements: 12.13, 42.10_

  - [x] 1.6 Pin the three agent dependencies and lock them
    - `agent/pyproject.toml`: add `python-docx==1.2.0` (the DOCX emitter, whose only content source is the AST), `pypdf==6.16.1` (PDF text extraction for the fidelity gate — pure Python `py3-none-any`, so nothing arm64-specific can go wrong) and `matplotlib==3.11.1` (static chart images, Agg only; it ships a cp312 manylinux aarch64 wheel so the image builds without a toolchain)
    - Regenerate `agent/requirements.lock` fully pinned with hashes, and add the adjacent comment recording the three deliberate absences: **no `docxtpl`** (there is no template document and no placeholder to substitute), **no `pandas`** (it is float-backed, and a float on the path from a snapshot value to a `formatted` string is exactly what is forbidden), and **no `strands-agents`** (there is no tool registry in this spec)
    - Extend `tests/test_dependency_pins.py`: `docx`, `pypdf` and `matplotlib` import; `matplotlib.get_backend()` is `Agg`; an AST scan fails the suite if any module under `src/reporting_agent/` imports `docxtpl` or `pandas`
    - _Requirements: 20.1, 20.2, 22.14, 33.5, 18.5_

- [x] 2. Postgres schema, the three stores and the browser-safe projections
  - [x] 2.1 Define `report_templates` and `report_template_versions`
    - Extend `app/lib/db/schema.ts` with `report_templates` (`id` PK, `user_id` FK → `users.id` `ON DELETE CASCADE` with an index, `name` CHECK length 1–120, `description` NOT NULL default `''` CHECK length ≤ 1000, `current_version_id` nullable FK → `report_template_versions.id`, `draft_definition jsonb` nullable, `seeded_starter_key text` nullable with UNIQUE `(user_id, seeded_starter_key)`, `created_at`, `updated_at` with `$onUpdate`)
    - `report_template_versions` (`id` PK, `template_id` FK with an index, `version integer`, `definition jsonb`, `definition_sha256 text`, `created_at`) with **every column NOT NULL**, UNIQUE `(template_id, version)`, and deliberately **no `updated_at`** — there is no update path
    - Carry **no `connected_subscription_id`, no subscription id, no tenant id and no Azure resource id** on either table: a template is rules, so one definition runs against every connected subscription the user has
    - `draft_definition` is a column rather than a version row because a draft must not consume a version number, and it is on the template because there is exactly one draft per template and no history to keep
    - Generate the migration with drizzle-kit and never hand-edit it; `app/test/migrations.static.test.ts` passes unchanged
    - _Requirements: 1.1, 1.2, 9.1, 9.10, 10.2, 11.4, 41.6_

  - [x] 2.2 Define `report_verifications` and add `template_version_id` to `report_runs`
    - `report_verifications` (`id` PK, `run_id` FK → `report_runs.id` with an index and **no UNIQUE**, `attempt_id text` with UNIQUE `(run_id, attempt_id)`, `template_version_id` FK, `status` new enum `verification_status` restricted to `pass` and `fail`, `figure_count integer` CHECK ≥ 0, `snapshot_sha256`, `docx_sha256`, `pdf_sha256`, `replay jsonb`, `drift_sample jsonb`, `findings jsonb`, `counts jsonb`, `artifact_key text`, `created_at`), every column NOT NULL
    - `run_id` carries no UNIQUE because a re-verification **appends**; `attempt_id` carries the UNIQUE instead, which is what makes a retried callback idempotent without forbidding the append — without it the reporter's single retry inserts a second identical row and inflates the count the panel shows
    - Add `report_runs.template_version_id text REFERENCES report_template_versions(id)` **nullable**, with `CHECK (created_at < '<migration instant>'::timestamptz OR template_version_id IS NOT NULL)`. Making it `NOT NULL` would require backfilling foundation-era rows that produced no document, writing a false statement into the exact rows that exist to be an audit trail; the partial CHECK enforces the invariant for every row this spec's code can create and leaves the pre-document runs truthfully unpinned
    - Add **no artifact-key columns** for the `.docx`, `.pdf`, ledger, AST or prose bundle: every report artifact key is positional and computed in `lib/db/views.ts` from the user id and the run id, the way `snapshotArtifactKey` already is, because one path template in one place cannot drift from itself
    - _Requirements: 36.1, 36.2, 9.6, 9.10, 41.6_

  - [x] 2.3 Implement `lib/templates/store.ts`
    - `import "server-only"` first line. Every read and write scoped to the signed-in user's id; a row whose `user_id` differs resolves as **not found** with no write and no field disclosed, byte-identical to the response for an id that exists for no row
    - Expose `insertVersion` and `readVersion` and **no operation that modifies or deletes** a `report_template_versions` row; an attempted modification through any exposed operation is rejected with an error stating that template versions are immutable
    - `insertVersion` computes `version` as the highest existing `version` for that `template_id` plus exactly 1, issues no `UPDATE` and no `DELETE` against an existing version row, and returns the existing highest version without inserting when the submitted canonical digest equals its `definition_sha256`
    - On a `(template_id, version)` UNIQUE violation, re-resolve the highest existing `version` and retry at most 3 times before returning an error indicating the save could not be sequenced — the database settles the race, so there is no pre-check to lose
    - `saveDraft` writes `draft_definition` and inserts no version row; a run enqueue against a template applies **no write** to its template or version rows, so one version stays reusable for an unlimited number of subscriptions and repeat runs
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 1.9, 9.2, 9.3, 9.5, 9.11, 9.12, 10.7, 11.4_

  - [x] 2.4 Implement `lib/verifications/store.ts` and `lib/verifications/result.ts`
    - `result.ts`: the zod `verificationResultSchema` for the verification-result artifact — `schema_version`, `attempt_id`, `run_id`, `template_version_id`, `status`, `figure_count`, the four digests, `counts`, `replay`, `drift_sample` and the ordered `findings` list where each finding carries its **`severity` on the finding itself** rather than derived by the reader, so an older client meeting a newer finding type still classifies and counts it
    - `store.ts`: `import "server-only"`; insert and read only, with **no update and no delete**, so a written verification is immutable for the life of the run it records; `latestForRun` returns the row with the greatest `created_at` plus the count of rows for that run
    - `readLatestVerificationStatus(runId)` used by the download gate and by the `verifying → completed` precondition
    - _Requirements: 36.1, 36.2, 36.3, 36.5, 36.6, 36.7, 36.8_

  - [x] 2.5 Add the two new projections, extend `RunView`, and assert every key set in the same task
    - `app/lib/db/views.ts`: `TemplateView` (8 keys), `TemplateVersionView` (4 keys: `id`, `version`, `definitionSha256`, `createdAt`, excluding every field of a connected subscription), `VerificationView` (12 keys), and `RunView` extended from fourteen to **seventeen** keys with `templateName`, `templateVersion` and `verificationStatus`
    - `toRunView(row, extras)` takes the verification status and includes the report artifact keys **only** when it is `pass`, so no shape exists in which a browser holds a document key for an unproven run; that is the download gate implemented in the projection rather than in a component
    - Each `FindingView` carries no unbounded text: the agent truncates every quoted excerpt to 200 characters before writing, so the projection has nothing to truncate and cannot be where the truncation is forgotten
    - In the **same task**, extend `app/lib/db/views.test.ts` with the Projection_Guard assertions: the **exact sorted key set** for each of the four projections as a set equality rather than a containment check; both `RunView` branches; and, over fixtures assigning distinct non-empty values, that no serialization contains a `progress_token_hash`, a `claimed_by`, a `dedupe_key`, a client-secret ciphertext or an unmasked subscription id
    - _Requirements: 43.4, 43.5, 43.6, 43.9, 40.4, 37.1_

  - [x] 2.6 Integration tests for versioning, verification append and the partial CHECK
    - Against the foundation's scratch-schema harness and real Postgres: `version` = `max + 1`; an unchanged canonical digest inserting nothing and returning the existing version; a modification attempt rejected with every existing row byte-identical; two **concurrent transactions** both computing the same next `version` resolving to one committed row with a bounded retry on the loser
    - `report_verifications` insert-only; a re-verification appending a row with a distinct `id` and its own `created_at` while every earlier row is retained; `(run_id, attempt_id)` making a retried callback idempotent
    - The partial CHECK on `report_runs.template_version_id` accepting a foundation-era row with a null and rejecting a newly created row with one
    - Editing a template that a **completed** run pinned leaves that run's `docx_sha256`, `pdf_sha256`, `snapshot_sha256` and `template_version_id` unchanged, and the run continues to resolve against its pinned version rather than the newest one
    - _Requirements: 9.2, 9.3, 9.5, 9.6, 9.8, 9.11, 36.2, 36.7_

- [x] 3. The definition model, its mirror, and the pure web-side modules
  - [x] 3.1 Declare the block-type set and the per-type config schemas, and guard the declarations
    - `app/lib/templates/blocks.ts` declaring, **between `// --- BEGIN BLOCK TYPES ---` / `// --- END BLOCK TYPES ---` and `// --- BEGIN BLOCK CONFIG ---` / `// --- END BLOCK CONFIG ---` sentinels**, exactly the sixteen block types — `cover`, `executive_summary`, `kpi_row`, `resource_table`, `top_n_table`, `timeseries_chart`, `distribution_chart`, `capacity_vs_usage`, `gaps_and_coverage`, `comparison_delta`, `verification_record`, `appendix_methodology`, `row`, `page_break`, `heading`, `rich_text` — and for each type its config field names, each field's required status, and each enumerated field's permitted values
    - Mirror the identical declarations between matching sentinels in `agent/src/reporting_agent/compile/definition.py`, creating the `compile/` package
    - `app/test/mirror.static.test.ts` — the Mirror_Guard's **declaration half**: extract both sentinel-delimited regions, compare the block-type sets, every type's field names, every field's required status and every enumerated field's permitted values, and fail naming **every** differing type and field, or naming either declaration as absent or unparseable. Sentinels rather than a parser for the same reason the event vocabulary uses them: the guard then needs neither a TypeScript nor a Python parser and cannot itself drift
    - _Requirements: 2.5, 2.6, 6.1, 6.2_

  - [x] 3.2 Implement `lib/templates/definition.ts` — the zod definition schema
    - The seven **required** top-level keys `schema_version`, `identity`, `scope`, `period`, `metrics`, `blocks`, `design`, with unknown keys **rejected by name** rather than stripped, and a type mismatch rejected rather than coerced
    - `scopeSpecSchema`: 0–20 fully qualified resource types, 0–10 tag filters (key 1–512, value 0–256), 0–50 resource groups (1–90), optional top-N (count 1–500 **with** a metric name and a statistic), optional sort `descending` | `ascending`; accepted both as the template default and as a per-block `scope_override`, with more than one override on a block rejected
    - **Reject a fully qualified Azure resource identifier, a subscription identifier or a tenant identifier in any scope field**, naming the offending field's path and stating that a scope is expressed as resource types, tag filters and resource groups rather than as named resources
    - `periodSchema` over exactly the six case-sensitive values, with `custom` requiring two valid inclusive `YYYY-MM-DD` local dates, start at or before end, span 1–31 local days
    - `metricSelectionSchema`: ≤25 resource-type entries, 1–40 items each, entries as **objects** (not bare strings) so a percentile entry carries the catalog's estimator label and fidelity tier, and an entry naming a percentile without it is rejected; every item validated against the Metric_Catalog for that resource type, including a derived statistic whose every source metric and SKU capability the catalog must declare
    - `blocksSchema`: a block is `{id 1–64, type, config, scope_override?}`; a `row` is `{id, type:"row", columns: [[block]] }` with a **list of lists** so "2 or 3 columns" is a length and no count can disagree with the children, 0–8 children per column; ≤200 blocks counting rows and children; list order **is** document order and no other ordering or index field is read
    - Reject: a `row` nested in a `row` at **any** depth naming the offending child; a duplicate block `id` counting row children; a `rich_text` config binding a metric, statistic, resource id, scope or snapshot path, naming the bound field; **any** absolute position, coordinate, offset, absolute width or height, or explicit page assignment, naming the rejected field
    - `designSchema`: preset one of four case-sensitive; accent colour as one opaque value; density, table style, number format (`decimal_places` 0–3 plus a grouping flag), cover-page flag, optional logo ≤512 chars, page size `A4` | `Letter`
    - Bounds: name 1–120, description 0–1000, ≤262,144 UTF-8 bytes in RFC 8785 canonical form, `schema_version` an integer ≥ 1 and ≤ the highest supported, with no default applied
    - Validation is **one pass reporting every violation**, each identified by the offending block `id` and field path, writing no version row and leaving every existing version byte-identical; a definition carrying zero blocks is a valid **draft** and an invalid **run**
    - An accepted percentile entry is **persisted carrying the estimator label and the fidelity tier the Metric_Catalog declares** for that statistic and resource type, so a stored definition already names how its percentiles are produced
    - _Requirements: 1.3, 2.1, 2.2, 2.4, 2.7, 2.9, 2.10, 3.1, 3.2, 3.10, 4.1, 4.2, 4.12, 5.1, 5.2, 5.3, 5.5, 5.7, 5.8, 5.9, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 7.1, 7.2, 7.8_

  - [x] 3.3 Property test — definition validation is total and reports every violation
    - **Property 8: Definition validation is total and reports every violation**
    - **Validates: Requirements 2.1, 2.3, 2.7, 2.9, 2.10, 6.3, 6.4, 6.6, 6.7, 6.9, 6.11, 3.1, 3.2, 3.10, 5.1, 5.2, 5.3, 5.5, 5.8, 5.9, 7.1, 7.2, 7.8, 1.3, 45.1**
    - `fast-check` over valid definitions with 1–6 injected defects drawn from: an undeclared top-level key; a missing required key; an undeclared block type; a `row` nested at depth 1–3; a duplicate `id` planted **at top level and inside a row column**; a `rich_text` config binding a metric; an absolute-position field; a `schema_version` of `0`, `"1"` and `99`; a name of 0 and 121 characters; a body above 262,144 bytes; 201 blocks; a scope dimension over its bound; a top-N without a metric; a metric absent from the catalog; a percentile without its estimator label; and **a fully qualified resource id, subscription id or tenant id injected into a randomly chosen scope dimension**
    - Assert every injected defect appears in one response identified by block `id` and field path, none is silently accepted or stripped, no version row is written, and the previously stored definition is byte-identical afterwards
    - Kills: a zod schema left at its default strip-unknown-keys behaviour, which accepts an undeclared key and drops it, turning a save-time error into a failed run minutes later; a validator returning only the first error, which hides five of six defects; a nesting check that looks one level down; a duplicate-id check scanning only top-level ids; a resource-id check scanning only `resource_types`
    - _Requirements: 2.1, 2.3, 2.7, 2.9, 2.10, 3.1, 3.2, 3.10, 5.1, 5.2, 5.3, 5.5, 5.8, 5.9, 6.3, 6.4, 6.6, 6.7, 6.9, 6.11, 7.1, 7.2, 7.8, 1.3, 45.1, 45.3, 45.4_

  - [x] 3.4 Implement `lib/templates/version.ts` and its digest property
    - RFC 8785 (JCS) canonicalization of a definition in TypeScript, then SHA-256 over the UTF-8 bytes rendered as 64 lowercase hexadecimal characters, mutating no input and applying **no Unicode normalization**
    - **Property 11: The definition digest is stable, sensitive and cross-language**
    - **Validates: Requirements 9.4, 9.5, 2.11, 45.1**
    - `fast-check` over valid definitions with ≥10 key-order permutations each; keys and string values drawn from ASCII, one astral-plane character, a pair differing only by letter case, a pair differing only by NFC/NFD, and a string requiring JSON escaping; nesting ≥4 deep; one empty object and one empty array
    - Assert permutation invariance; any value or key change yields a different digest; NFC and NFD spellings yield **different** digests. The cross-language half — the app's digest equals the agent's for every fixture in the shared corpus — is asserted in task 5.2, because it needs the agent's implementation
    - Kills: a digest over `JSON.stringify` with sorted keys, which sorts by UTF-16 code unit inconsistently with a Python code-point sort and produces two ids for one definition; one that normalizes, making two genuinely different keys hash alike
    - _Requirements: 9.4, 9.5, 2.11, 45.1, 45.3, 45.4_

  - [x] 3.5 Implement `lib/templates/period.ts` — the Period_Resolver — and its property
    - `resolvePeriod(spec, at: Date, timeZone: string): ResolvedPeriod`, **pure**: `at` and `timeZone` are parameters, so the resolution derives from the run's timezone and the current instant and from no host or process time-zone setting
    - `last_24h` → the single local day preceding the current local date; `last_7d` / `last_30d` → the 7 or 30 consecutive local days ending on the day preceding it; `last_full_month` → the whole preceding local calendar month; `mtd` → the first local day of the current local month through the day preceding it; `custom` → the two declared dates. Both endpoints inclusive in every case, and every resolution ends **at or before the local day preceding the current local date**, because today is incomplete and a partial trailing day would understate every daily figure derived from it
    - A resolution of zero local days — including `mtd` on the first of a month — is an **enqueue rejection** stating that the period contains no complete local day, not a silent empty run
    - **Property 9: Period resolution is correct at every offset and every edge**
    - **Validates: Requirements 4.2, 4.4, 4.5, 4.6, 4.8, 45.1**
    - `fast-check` over the six specifications; instants across 2024–2030 at every hour and minute; timezones including `Asia/Jakarta`, `UTC`, `Pacific/Kiritimati`, `America/New_York`, `Pacific/Midway`, `Asia/Kathmandu`, `Australia/Eucla`; `custom` ranges of 0–40 days including inverted ones
    - Declared examples: `mtd` on the first local day of a month ⇒ rejection; `last_full_month` on 1 January ⇒ the whole of the previous December; an instant of `2026-07-01T16:30Z` at `Asia/Jakarta`, which is `2026-07-01T23:30+07:00`, so `last_24h` is **30 June and not 1 July** — which kills a resolver computing from a UTC clock; and the result unchanged when the process `TZ` is set to three different zones
    - _Requirements: 4.2, 4.4, 4.5, 4.6, 4.8, 45.1, 45.3, 45.4_

  - [x] 3.6 Ship the three starter templates and seed them at account creation
    - `app/lib/templates/starters.ts` declaring exactly three definitions — **Monthly utilization**, **Capacity planning**, **Executive summary** — versioned in the repository and reviewed as code, each accepted by the Template_Validator, each carrying a **relative** period specification rather than `custom` so a starter runs unedited in a later month, and each composed from at least one of `kpi_row` / `resource_table` / `top_n_table` / `timeseries_chart` / `distribution_chart` / `capacity_vs_usage`, at least one of `executive_summary` / `rich_text`, and one `verification_record`, so a starter demonstrates the provenance chain end to end
    - Seed at **user creation only**: one `report_templates` row per starter carrying that user's id, one `report_template_versions` row at `version` 1 with its canonical digest, `current_version_id` set, inserted with `ON CONFLICT (user_id, seeded_starter_key) DO NOTHING` so a retried registration creates no duplicate and a deleted starter is never resurrected
    - A failure after fewer than three inserts retains **no** partially inserted starter or version row, leaves the user able to author a template, and states that the starters could not be initialized
    - `app/test/starters.static.test.ts` validates all three through `definition.ts` and **fails the build** naming each failing field path, so a broken starter is caught at build time rather than by a first-time user
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

  - [x] 3.7 Implement `lib/templates/composer.ts` — the pure reducer — and its property
    - `ComposerAction` = `insert` | `move` | `nudge` | `remove` | `select` | `splitRow` | `patchConfig`; `reduce(state, action): ComposerResult` returning either `{ok:true, state, announcement}` or `{ok:false, state, refusal}` **with the same state object by reference identity** on refusal; plus `refusalFor(action, state)` so the pointer path can paint a blocked state **during** a drag
    - No React, no DOM, no dnd-kit types in this module. `announcement` is produced by the **reducer**, so the `aria-live` message is a pure function of the move and unit-testable without a DOM: `"KPI row moved to position 3 of 7"`, and inside a row `"Resource table moved to position 2 of 4 in column 1 of 2"` — exactly one announcement per completed move, because the reducer returns exactly one string
    - `nudge` resolves the container from the block id and is **confined** to it — the top-level sequence, or the one row column the block sits in — refusing at a boundary with the first/last announcement rather than overflowing
    - A refusal is a **value**, rendered two ways for one cause: a blocked cursor plus a "rows can't nest" hint for the pointer, and the same sentence through the `polite` region for the keyboard
    - **Property 10: The composer reducer is confined, announced and refusal-safe**
    - **Validates: Requirements 12.4, 12.5, 12.12, 12.14, 12.6, 6.3, 45.1**
    - `fast-check` over states of 0–200 blocks with 0–20 rows of 2–3 columns and 0–8 children, and action sequences of 1–50 with block ids sampled from the state and, 10% of the time, from outside it. Assert a nudge changes exactly one block's index by exactly one **within its own container** and changes no other block's container; a refusal returns `state` by reference identity with an unchanged order; exactly one announcement per completed move whose 1-based position and container total match the resulting tree; no reachable state nests a row in a row; the canvas's DOM order always equals the definition's document order
    - Declared examples: a nudge on the first and last block of the top-level sequence and of a row column; a `move` of a `row` into a row column; a nudge on the only block in a column
    - Kills: a nudge computed against a **flattened index**, which teleports a block out of its row column into the top-level sequence — the single most likely implementation and the one a keyboard user hits within a minute; a boundary that silently clamps; a refusal implemented as a silent no-op; an announcer firing on both paths for one move
    - _Requirements: 12.4, 12.5, 12.6, 12.12, 12.13, 12.14, 6.3, 45.1, 45.3, 45.4_

- [x] 4. Checkpoint — the definition model and the schema
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. The compile stage — provenance made structural
  - [x] 5.1 Implement `compile/definition.py` — the mirrored validator
    - The definition model and validation on the agent side, holding the sentinel-delimited declarations task 3.1 created, and reaching the **same verdict** as `lib/templates/definition.ts` for every rule: the seven required keys, undeclared keys and block types rejected by name, the layout grammar, one level of nesting, duplicate ids across row children, `rich_text` binding nothing, the absence of any positioning field, the size and count bounds, and `schema_version` bounds with no default applied
    - Reject a block whose `type` is absent from the declared set, naming the rejected type and that block's position, and **neither ignore nor drop it**
    - Report **every** violation with the offending block `id` and field path; a pinned version failing validation at compile time raises the terminal `TEMPLATE_INVALID` naming every failing path, renders no document and writes no artifact
    - _Requirements: 2.3, 2.5, 2.6, 2.8, 2.9, 2.10, 3.10, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11_

  - [x] 5.2 Ship the shared fixture corpus and the Mirror_Guard's behavioural half
    - `agent/tests/fixtures/definitions/` holding **at least 20 fixtures** covering every declared block type at least once, with both accepted and rejected cases, plus a manifest declaring each fixture's expected verdict and, for a rejection, the expected offending block `id` and field path. Rejected fixtures include one carrying a fully qualified Azure resource id in a scope field, one nesting a row in a row, one with a duplicate id inside a row column, and one omitting `schema_version`
    - Extend `app/test/mirror.static.test.ts` to run **every fixture through both** the Template_Validator and the Block_Compiler and fail unless both reach the same accept-or-reject outcome and name the same offending block `id` and field path, plus a corpus size and coverage check (≥20 fixtures, every declared block type present, both verdicts present)
    - Assert in the same test that the app's `definition_sha256` equals the agent's canonical digest for every fixture, closing Property 11's cross-language half
    - One corpus directory read by both halves across the monorepo path, **never a copy**, because two copies is how the guard comes to compare each half against itself. Declaration equality is necessary and not sufficient: a definition the app can save and the compiler cannot compile turns a save-time validation error into a failed run minutes later, after inventory and metrics have already been spent
    - _Requirements: 2.6, 2.11, 1.3, 9.4_

  - [x] 5.3 Implement `compile/snapshot_view.py` — the only source of a value
    - `SnapshotValue` as a frozen slotted dataclass carrying `value: Decimal`, `unit`, `statistic`, `estimator`, `fidelity_tier`, `scale`, `metric`, `resource_id`, `window`, `pointer`, `estimated`, `derived_from` and `formula`
    - `SnapshotView` built by walking the snapshot document **once** and recording, for every statistic object, the RFC 6901 JSON Pointer of its `value` field — so `pointer` is **derived from the value's position** and there is no constructor accepting a pointer from outside the walk
    - `resources()`, `stat()`, `day_stat()`, `count(CountKind)` for resource / gap / per-tier counts, and `resolve(pointer)` for the AST's re-resolution check
    - Parse every `value` from the snapshot's decimal **string** into `Decimal`; construct no float anywhere. Array indices are stable because the snapshot's arrays are deterministically sorted by the Snapshot_Builder and the document is immutable, so a pointer minted today resolves identically in a re-verification a year later
    - Unit tests: a pointer resolving to exactly one value whose decimal string equals the parsed value; a `stat()` miss returning `None` rather than raising; the view rejecting mutation
    - _Requirements: 15.5, 15.11, 16.4, 18.5_

  - [x] 5.4 Implement `compile/ast.py` and ship the AST numeric-leaf guard with it
    - `DecimalString` as a `NewType` over `str` — a `NewType` rather than a bare `str` so the static guard can tell a quantity from prose by the annotation alone — constrained to an optional leading `-`, digits, at most one `.` followed by digits, admitting no exponent, no leading `+`, no thousands separator, no surrounding whitespace, no empty string and no non-finite designation
    - `Figure` as the **only** node declaring a field that carries a quantity: `path`, `value`, `unit`, `snapshot_path`, `formatted`, `fidelity_tier`, `statistic`, `metric?`, `resource_id?`, `window?`, `estimator?`, `estimator_label?`, `derived_from`, `formula?`. `__post_init__` validates every field naming that node's `path`; `__setattr__` raises `FigureImmutableError`
    - `Text`, `Inline = Text | Figure`, `FigureCell` / `TextCell` / `EmptyCell`, `Cell` as their union, `Table` (identity, ordered column headers each with a column key, ordered rows each with a row key and ordered cells, keys unique within the table), `Paragraph` over `Inline`, `Chart`, `LayoutRow`, `PageBreak` — every node `frozen=True, slots=True`
    - **No cardinality is a number**: `LayoutRow` carries `columns: tuple[Column, ...]` with a validator requiring two or three, not `columns: int`; `Table` carries header and row tuples, not counts; `PageBreak` carries nothing. Consequently `Figure` is the only dataclass in the module whose annotations mention a numeric type at all
    - `__post_init__` **re-resolves** `snapshot_path` against the compiling snapshot and asserts the addressed value's decimal string equals `value`, so a declared provenance that does not resolve is a failure rather than an unchecked claim; a non-`Figure` in a figure position raises naming the node path and the offending type
    - `agent/tests/test_ast_guard.py` in the **same task**: for every dataclass other than `Figure`, no annotation may mention `int`, `float`, `Decimal`, `DecimalString`, `complex` or `Fraction`; every `Figure`-admitting annotation must be exactly one of `Figure`, `tuple[Figure, ...]`, `Inline`, `tuple[Inline, ...]`, `Cell`, `tuple[Cell, ...]`; `Inline` and `Cell` must be unions over exactly the declared members; every node must be `frozen=True, slots=True`. It runs in the suite **and** in the image build, so an image cannot carry an AST that admits a bare number
    - `FigurePath` as `<block_id>:<ordinal>[.<ordinal>]*` where each ordinal is the zero-based index within its parent's **declared child order** — the concatenation, in dataclass field-declaration order, of every child-bearing field — plus `table_id(path) = f"tbl:{path}"` and `chart_id(path) = f"cht:{path}"`, both asserted ≤255 characters
    - Unit tests: a `Decimal`, an `int`, a bare `str` and a `float` in a figure position each raising with the node path and offending type; an assignment to a constructed `Figure` field raising; a `snapshot_path` resolving to nothing, to two values, and to a value whose decimal string differs
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.9, 15.10, 15.11, 15.12, 15.13, 21.9, 22.2_

  - [x] 5.5 Implement `compile/figures.py` — the ledger and the cursor, in one task with the AST
    - `FigureLedger` as `_entries: dict[FigurePath, Figure]` whose values **are** the objects the AST holds, plus `_anchors: dict[FigurePath, TableAnchor]` recorded onto the existing entry rather than into a separate collection; `__getitem__`, `formatted_values()` ordered longest-first for masking stage 1, `anchors()`, `serialize()` (entries by path, RFC 8785) and `digest()`
    - `BlockCursor` minting paths via `child(field, ordinal)` and exposing `figure(snapshot_value, *, number_format)` as **the only figure factory**: it mints the path, calls `format.format_figure(...)`, constructs the `Figure`, and inserts it into the ledger **in one step**, so the entry is created during the traversal that creates the node and the ledger's value is that same object
    - The factory takes a `SnapshotValue` — which carries its own JSON Pointer — and nothing else, which is what makes a `Figure` unconstructible from a number that did not come out of `SnapshotView`; there is consequently **no operation anywhere in the package** that accepts a numeric produced by a language model, supplied in a template definition, or computed from model-authored text, and places it in a figure position
    - There is **no `build_ledger(ast)` function** anywhere in the package and there cannot be one without deleting this method: a parallel walk is a second structure, and two structures can disagree
    - `compile()` asserts the closing invariant before returning: the ledger's key set equals the figure paths found by an **assertion-only** walk of the finished tree, and no two figure nodes resolve to one key; a mismatch is `COMPILE_FAILED` naming every differing or colliding path
    - Serialize the ledger once per render as an artifact alongside the document and record its SHA-256 on the verification result, so a later re-verification reads the same ledger the render used; the renderers read the **in-memory** object, never a written or deserialized one
    - **The ledger identity test** — the single test that distinguishes this design from one keeping two structures in agreement: compile a fixture, `object.__setattr__(figure, "formatted", "MUTATED")` through the **AST** at a path, assert the **ledger** reports the mutated value at that key, then do it in reverse. It reaches past `Figure.__setattr__` deliberately: production code cannot mutate a figure, the test can, and a copied or re-walked ledger fails both directions
    - **The figure-factory call count**: a counter on `BlockCursor.figure` asserts the count equals the ledger's entry count and the AST's figure-node count, so a second-pass implementation shows up as a count mismatch rather than as a code review
    - _Requirements: 15.8, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11_

  - [x] 5.6 Implement `compile/format.py` and `compile/estimators.py`, with Property 1
    - `format_figure(value, *, unit, catalog_scale, number_format, estimator_label, path) -> str` as **the only operation in the runtime** that turns a figure's value into a display string
    - Display scale is `max(number_format.decimal_places, catalog_scale)` — the catalog scale is a **floor** a style preference may not cut into, because precision is a property of the measurement rather than of a template's taste; the setting adds zeros where it asks for more and is ignored where it asks for less, while the grouping flag and both separators apply unconditionally
    - `Decimal` throughout with **no float** constructed anywhere on the path; quantization half away from zero, one rounding mode for every value, unit and number format; separators from the template's number format; the unit's presentation from the catalog inside the string, so a consumer appending its own unit would break the exact-equality comparison the verifier performs
    - `estimators.py` composes the estimator label **without a numeral** — `p95, est. from hourly averages` — from the snapshot value's `estimator` and `statistic`, and deliberately does **not** consume the snapshot's own pre-formatted `label`, which already embeds a numeral at the collector's scale and separators and would put a second formatter's output inside the string the verifier matches. A table test asserts every estimator string the collector can emit has an entry here, so a new estimator fails the suite rather than producing an unlabelled figure
    - Assert no bare percentile designation survives in a `formatted` string; a value that is neither `Decimal` nor a fixed-precision decimal string, or a metric for which the catalog declares no fractional-digit count, produces **no string at all** and fails the run with the AST path named, applying no default scale
    - **Property 1: Formatting is total, deterministic and the single display path**
    - **Validates: Requirements 18.3, 18.4, 18.5, 18.6, 18.7, 7.3, 7.9, 45.1**
    - `hypothesis` over `Decimal` values with 0–9 fractional digits (0–100 for a percentage unit, 0–10^15 for a magnitude unit, including negatives and exact zero); catalog units; scales 0–9; number formats over decimal places 0–3 × grouping on/off × a decimal separator of `.` or `,` × a grouping separator of `,`, `.` or thin space; every estimator the collector can emit
    - Assert idempotence per input tuple; the digits round-trip to the value quantized at the **catalog** scale; an estimated value's string contains the label and no bare `p\d+` or standalone `percentile` outside it; a float guard on the path raises; two values differing after quantization format differently
    - Declared examples: `0`, `0.000001`, `-0.5`, `9007199254740993`, `0.1`, `0.30000000000000004`, and a number format whose decimal separator is `,` and grouping separator is `.` — which kills a formatter round-tripping through a binary float and one hard-coding separators, either of which would fail verification on a report that is correct
    - _Requirements: 7.3, 7.9, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.9, 18.10, 18.11, 45.1, 45.3, 45.4_

  - [x] 5.7 Implement `compile/scope.py` — the Scope_Resolver — with Property 7
    - `resolve(scope: ScopeRules, view: SnapshotView) -> tuple[ResourceView, ...]` whose whole signature is the requirement: a snapshot view and a scope specification, **no client, no network, no clock**
    - Matching requires every populated dimension satisfied, treats multiple entries within a dimension as any-of, treats an empty dimension as unconstrained, and compares resource types and tag **keys** case-insensitively while comparing tag **values** case-sensitively — an Azure tag value is user data, and folding its case would silently merge `env=Prod` with `env=prod`
    - Top-N in four explicit steps: partition matched resources into those the snapshot has a value for at the named `(metric, statistic)` and those it does not; sort the first by that value in the scope's direction defaulting to `descending`, breaking ties by resource id ascending in **Unicode code-point order**; append the second ordered by resource id **after** every ranked resource, so a missing metric value can never reorder the ranked ones; take the first N, retaining everything when the matched count is below N
    - A resolved scope of zero resources returns an empty tuple and raises nothing — the empty-block row is the compiler's job and the union gate is the pipeline's
    - **Property 7: Scope resolution is deterministic and snapshot-only**
    - **Validates: Requirements 3.3, 3.4, 3.5, 3.6, 3.11, 3.12, 5.4, 45.1**
    - `hypothesis` over snapshots of 0–500 resources with tags whose keys and values differ only by case, resource groups, types and per-metric statistics, plus resources **missing** the top-N metric; scope specs across every bound of criterion 3.1 with both sort directions; and whole definitions whose block overrides differ from the default
    - Assert idempotence per pair; invariance under permutation of the snapshot's resource array order; at most N ordered as declared with ties by ascending id and missing-value resources appended after every ranked one; a network double proving purity; zero matches returning an empty list without raising; and the requested collection scope equalling the **union** of the template default and every block override, with the requested metrics equalling the union per resource type
    - Declared examples: a top-N metric missing for half the matched resources; tag filters differing from the resource's tags only by the value's case (no match) and only by the key's case (match)
    - Kills: a resolver whose output depends on response arrival order; one treating a missing metric value as zero, which sorts those resources into the ranked order and silently changes which ten appear in a "Top 10 by CPU" table; one folding tag-value case; one raising on an empty match, which would turn an ordinary empty block into a failed run; a pipeline requesting only the template default, whose override resources are then absent from the snapshot and fail the coverage gate on a correct run
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.11, 3.12, 5.4, 45.1, 45.3, 45.4_

  - [x] 5.8 Implement `compile/blocks/` — one module per declared block type
    - Every numeric quantity in a `kpi_row`, `resource_table`, `top_n_table`, `capacity_vs_usage`, `timeseries_chart`, `distribution_chart` or `comparison_delta` emitted as a **figure node**, and no numeric quantity in those blocks emitted as a text node
    - `resource_table` / `top_n_table`: one row per resource in resolved-scope order up to 500, plus a final row stating the omitted count **as a figure**, so a truncated table states its own truncation rather than presenting a partial list as complete
    - `gaps_and_coverage`: `collection_log` entries grouped by `gap_type` ascending in code-point order and within each group by resource id ascending, each group naming affected resources with its count as a figure, emitted as recorded rather than as an absence of data, and an explicit "no gaps recorded" row where the log is empty
    - `verification_record`: `snapshot_id`, the window with its resolved UTC offset, the grain, the resource count, the gap count, the per-`fidelity_tier` counts and the raw-archive completeness flag, with the counts as figures — and **no verification status, verified-figure count or finding count**, because that outcome is computed from the rendered document and does not exist at compile time
    - `appendix_methodology`: the declared period specification, the requested grain, the snapshot's grain, the aggregation method per statistic, each estimated statistic's label **read from the ledger**, and the meaning of each present tier, composing no label of its own
    - `cover` (only where the cover-page flag is true): report title, subscription display name, resolved local start and end dates and UTC offset, and **no metric value**; `heading` / `rich_text` emit text nodes carrying no figure; `page_break` emits a break carrying no figure; `row` emits a layout container carrying its declared column count and each column's compiled children in declared order
    - `timeseries_chart` / `distribution_chart`: a chart node carrying type, title, unit, an `encoding` of `categorical` where the series are peers and `sequential` where the chart encodes one ordered quantity, and ordered series each with a **stable series key** and plotted values as figures — so no consumer infers the encoding from the series count
    - `executive_summary`: compiler-placed figures drawn from the ledger plus model prose inserted as `Text` nodes **unaltered**, with compilation two-phase — every block's compiler-placed figures compile first producing the complete ledger, the model is then asked, and the final tree is assembled **once** from parts with no node mutated
    - A block whose resolved scope contains zero resources emits exactly one explicit "No resources matched this scope" row, retains its heading and document position, emits **zero** figures, and is **never omitted** — a block that vanished is indistinguishable from one that was never configured; it reports no error code and records no gap
    - A block with a non-empty scope that cannot compile raises `COMPILE_FAILED` naming its `id` and `type`, emitting no partial AST and writing no artifact
    - _Requirements: 3.7, 3.8, 7.5, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.9, 16.10, 16.11, 16.12, 16.13, 16.14, 19.1, 19.3_

  - [x] 5.9 Implement `compare/delta.py` — the Delta_Compiler
    - `comparison_delta` compiled from the snapshots pinned by the two completed runs its config names, each delta emitted as a figure whose value is the later run's minus the earlier run's, both `snapshot_id` values emitted in the block, and **no Azure call**
    - A resource whose `fidelity_tier` differs between the two snapshots emits a row marked **not comparable** with no delta figure and records the advisory `fidelity_not_comparable`; a resource present in one snapshot and absent from the other emits a row naming the snapshot it is absent from, with no delta figure, and is **not omitted**
    - _Requirements: 16.7, 16.8, 16.15_

  - [x] 5.10 Unit tests for block compilation and the compile refusals
    - A `resource_table` at 501 resources asserting the 500-row cap plus the omitted-count figure; a `gaps_and_coverage` over an empty log asserting the explicit no-gaps row; a `verification_record` asserting it carries no status, count or finding; a `comparison_delta` whose resource has differing tiers across the two snapshots asserting `fidelity_not_comparable` and no delta figure; and one whose resource is present in one snapshot only
    - Formatter refusals surfacing as `COMPILE_FAILED` with the AST path: a metric with no catalog scale, and a value that is neither `Decimal` nor a decimal string
    - A definition whose every block's scope matches nothing while the union matches one resource, asserting **every** block is present in the tree with its explicit row and zero figures
    - `.venv/bin/pytest` and `.venv/bin/ruff check .` clean
    - _Requirements: 15.4, 16.2, 16.3, 16.5, 16.8, 16.11, 16.15, 18.9, 18.11_

- [x] 6. Checkpoint — a snapshot compiles to an AST and a ledger
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Themes, the container image, and the two emitters over one tree
  - [x] 7.1 Author the four theme documents, `render/themes.py` and the Theme_Guard
    - `agent/themes/editorial.docx`, `corporate.docx`, `technical.docx`, `minimal.docx` — **styles-only** Word packages carrying paragraph, character and table styles and **no content** — committed to the repository as source files and reviewed like code, each defining the `Figure` character style, the `PreviewNotice` paragraph style, and every paragraph and table style the declared block types reference
    - `render/themes.py` loading a theme by preset name, asserting the referenced style union is present, and exposing `--assert-build` as a module entry point
    - `agent/tests/test_themes.py` — the Theme_Guard, shipping **with** the documents: each of the four declares `Figure`; each declares every name in the union of paragraph and table style names referenced by the declared block types; each contains **zero non-whitespace text characters** in body, headers and footers; the directory contains exactly the four required file names and every file opens as a readable document package, reported as **distinct** from a missing-style failure
    - Report **every** `(theme, style)` pair found missing across all four documents in one run rather than only the first, so one fix pass clears the build
    - A theme document missing a referenced style at run time is the terminal `RENDER_FAILED` naming the theme and every missing style, writing no artifact and leaving the snapshot unmodified
    - _Requirements: 7.4, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.8, 20.5_

  - [x] 7.2 Extend the Dockerfile — LibreOffice, arm64 fonts, a pre-warmed profile and the build assertions
    - `apt-get install --no-install-recommends libreoffice-writer libreoffice-core` plus arm64 builds of the fonts the four themes reference (`fonts-dejavu-core`, `fonts-liberation2`), cleaning the apt lists
    - `ENV LANG=C.UTF-8 LO_PROFILE=/opt/libreoffice-profile`, then **pre-warm the profile at build time** with one real headless conversion using `--norestore` and `-env:UserInstallation=file://$LO_PROFILE`, asserting a non-empty output and cleaning the scratch files, and chown the profile to the runtime user so LibreOffice can take its lock files. A cold profile makes the first conversion of a container's life slow and occasionally fail outright, which reads as a flaky render rather than as a cold start
    - Build-time assertions that abort the build and publish nothing: `python -m reporting_agent.render.themes --assert-build`; `test "$(uname -m)" = "aarch64"`; the profile directory present and non-empty; and the AST numeric-leaf guard from task 5.4, so an image cannot carry an AST that admits a bare number
    - Every image build line in `agent/README.md` names `--platform linux/arm64`
    - _Requirements: 8.7, 23.2, 23.5, 23.10_

  - [x] 7.3 Append the categorical palette and add the shared palette module
    - Append the `--cat-1` … `--cat-5` and `--cat-other` block plus the `@theme inline` colour mappings and the `.dark` overrides — **including the reversal of the preset's sequential `--chart-*` ramp for dark surfaces** — to the end of `app/app/globals.css`. Additive only: change no existing token value and reformat nothing, because those values carry the preset's identity
    - `app/components/charts/palette.ts` exporting the categorical tokens keyed by **stable key** (metric key for a metric series, resource id for a resource series) with **no index-based assignment**, the five-series cap with a `--cat-other` aggregate, and the encoding → palette selection; `agent/src/reporting_agent/render/chartstyle.py` holds the same values so the document and the app agree
    - A test over the palette asserting every categorical token reaches ≥3:1 against both `--background` and `--card` in light and dark, that adjacent categorical tokens stay distinguishable under simulated deuteranopia, protanopia and tritanopia, and that `--destructive` appears in neither the categorical nor the sequential set. `--cat-4` ochre against `--cat-5` green is the pair most at risk; if it fails, separate them by lightness rather than adding a sixth hue
    - _Requirements: 22.7, 22.8, 22.12, 22.15_

  - [x] 7.4 Implement `render/docx.py` — the DOCX emitter
    - Walk the compiled AST **once** with `python-docx` against the theme the pinned version's preset names, reading the AST as its only source of content; use no document-templating library and accept no user-supplied `.docx`
    - Emit **every figure as exactly one run carrying the theme's `Figure` character style**, holding that figure's `formatted` string in full and unaltered and **no other character**, at every position the AST places one — prose paragraph, heading, data-table cell, cover field and chart companion cell — which is what lets token extraction locate every figure without re-parsing prose
    - Apply each paragraph and table style by the name the theme declares and define **no inline formatting** that duplicates a style the theme already declares; a missing style is `RENDER_FAILED` naming the theme and **every** missing style rather than the first, with no partial artifact object
    - Emit a `row` block as one layout table of exactly its declared 2 or 3 columns, one cell per column, **no visible border on any edge**, each child in its declared column and order; emit blocks, row children and page breaks in AST order with no reordering derived from type, content length or figure count
    - Where the cover-page flag is false, emit no `cover` content and no leading blank page while leaving the block and its config present in the definition; where a logo reference is present, embed it, and where it is unresolvable — absent, unreadable, above 5 MB, or not retrieved within 10 seconds — emit the cover without it, record **one advisory finding** naming the cover block and the reason, and complete the render as a success
    - Write every numeric-bearing string from a ledger entry's `formatted` value or from the pinned version's static text, composing, rounding, re-scaling and re-uniting nothing; a numeric quantity reaching a text position as a non-`Figure` is `RENDER_FAILED` naming the AST path
    - **Determinism**: two emissions of one AST against one theme produce identical digests once `docProps/core.xml`'s created and last-modified timestamps are excluded — set both to a fixed sentinel and exclude that part explicitly in the byte-equality test rather than hoping; derive nothing from wall-clock time, host locale, hostname, environment values or filesystem enumeration order
    - Write the completed document as **one** artifact object after every block is emitted, with at most one emission attempt per run, so a partially emitted document is never an artifact
    - _Requirements: 7.4, 7.5, 7.6, 7.9, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.11, 20.12_

  - [x] 7.5 Implement `render/anchors.py` — the two structural contracts the verifier depends on
    - `write_data_table_caption(table, identity)` writing `w:tblPr/w:tblCaption` **exactly once** as a non-empty string of ≤255 characters equal to the identity recorded in the ledger for that table; `write_layout_table(table)` writing **no caption, no header row and no row key**
    - The asymmetry is the design: the table-verification pass enumerates tables **carrying a caption**, so a layout table is excluded by construction rather than by inspecting borders or counting cells
    - A data table nested inside a layout cell still carries **its own** caption, so a data-bearing child of a `row` block is checked while its container is skipped; a data table carrying zero figures still records its identity in the ledger with **zero anchors**, so the verifier resolves it and reports no unexpected-table finding
    - Record, for every figure emitted into a data-table cell, the anchor triple `{table_id, row_key, col_key}` mapped to that figure's `formatted` string, **exactly one anchor per triple**, on that figure's existing ledger entry — and record **no** anchor for a value emitted outside a data table, including a layout cell, a heading, a paragraph, a header or a footer
    - Header text: each column's header is that table's first row, non-empty, ≤255 characters, unique within the table, and exactly equal to the string its column key resolves by. Row key: the concatenated text of one designated key column identified by its header text, occupying the same column in every data row, non-empty, ≤255, unique. Both exist because the verifier resolves by them rather than by position
    - Derive every table identity from that table node's **AST path alone**, never from emission order or elapsed time, and assert uniqueness within one rendered document
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.8, 21.9, 21.10, 21.11_

  - [x] 7.6 Implement `render/charts.py` and `render/chartstyle.py`
    - For every chart node emit **exactly one** static image and **exactly one** companion data table carrying every plotted point of every plotted series as a figure whose cell text is the ledger's `formatted` string, applying **no sampling, no thinning and no re-rounding** of the plotted set
    - Emit the companion table as a data table whose `w:tblCaption` is the `cht:<path>` identity, in body order **immediately after** its image with no other block between them, and write that same identity into the image's alternative text, so the verifier pairs image with table **by identity rather than by proximity** and the table is checked by the anchored-equality pass
    - Compute the chart data hash as SHA-256 over the ordered plotted contributions — series stable key, x key, and the ledger's decimal string, in plotted order — and record it both on the chart node and in the sidecar beside the embedded image
    - Plot every value **from the ledger**, computing no plotted value from a snapshot value a second time, and apply no arithmetic to a plotted decimal string other than the layout scaling that positions a mark, which is neither hashed nor emitted as text
    - Palette from the node's declared `encoding` and never from series count or chart type: peers from `--cat-1…5`, one ordered quantity from the preset ramp `--chart-1…5`, and a peer chart **never** from the ramp, because a lightness ramp asserts an order peer series do not carry. Colour assigned by stable key, never by array index, so one metric and one resource keep one colour across every chart and delta table of one report
    - Above five peers, plot the four largest by the node's declared ordering statistic with ties broken by ascending stable key, aggregate the rest into one `--cat-other` series, and emit into the companion table **exactly the series plotted including that aggregate**, so image, table and hash describe one plotted set
    - Direct label for every series at its line end or on its bar; lines additionally distinguished by marker shape and dash pattern; bars, columns and heatmap cells by a direct value label; **nothing distinguished by colour alone**. A delta is a direction glyph plus a signed magnitude in **one** colour. `--destructive` on no series, delta, gridline or band
    - A chart whose plotted set is empty emits the chart node carrying an explicit no-values indication **and** its companion table carrying the no-resources-matched row, omitting neither
    - `chartstyle.py`: Agg backend, one frozen `rcParams` block, a font shipped in the image and named explicitly rather than resolved by fallback, PNG metadata suppressed, fixed dpi and figure size — with a byte-equality test over two renders of one chart node, which is what keeps determinism honest across a dependency bump
    - _Requirements: 22.1, 22.2, 22.3, 22.6, 22.7, 22.8, 22.9, 22.10, 22.11, 22.12, 22.13, 22.14, 22.15_

  - [x] 7.7 Implement `render/pdf.py` — conversion from the produced DOCX only
    - Convert the **exact byte content** of the `.docx` rendered for that run; render no `.pdf` from the AST, the ledger, the HTML emitter's output or the snapshot, so the delivered pair cannot disagree
    - `soffice --headless --norestore -env:UserInstallation=file://<pre-warmed profile> --convert-to pdf --outdir …`, using the **build-time profile as-is** and creating none at run time, in the container only and through no network conversion service
    - Assert `LANG == "C.UTF-8"` **before** the process starts and refuse otherwise with `PDF_CONVERSION_FAILED` stating the required value was not in effect — a comma-decimal locale rewrites every numeral and the ledger's strings stop being locatable
    - `CONVERT_TIMEOUT_S = 300.0`, **at most one** invocation per produced `.docx`, that same limit and count applied to the first conversion of a container's life; a non-zero exit, the limit, no output, a zero-byte output or an unreadable page is `PDF_CONVERSION_FAILED` with scrubbed failure text and **neither** download presented
    - Serialize conversions within one invocation under a process-wide lock, with a comment stating why: the profile is used rather than copied, so two concurrent conversions would contend on its lock files
    - Record the SHA-256 of the produced `.docx` and of the produced `.pdf` on the verification result **before** any download is presented
    - Unit tests against a faked subprocess: `LANG` refused before the process starts, `--norestore` present, the pre-warmed profile path used, exactly one attempt, the limit applied to the first conversion. Plus **one real conversion in the built image**, once per suite, asserting a readable page count and extractable text, because a faked subprocess cannot tell us LibreOffice works
    - _Requirements: 23.1, 23.3, 23.4, 23.6, 23.7, 23.8, 23.9_

  - [x] 7.8 Implement `render/html.py` — the second emitter over the same tree
    - Emit by walking the **same AST instance** the DOCX emitter walks, compiling no second AST, emitting blocks in that AST's order, and holding **no** block ordering rule, column arrangement rule or layout definition of its own, so no third layout definition exists in the product
    - Emit each figure's `formatted` string exactly as the Formatter produced it — no rounding, no locale substitution, no unit transformation — together with `data-snapshot-path` and, for an estimate, `data-estimator-label` as attributes, composing no estimator label and emitting no figure lacking those attributes, so the provenance reveal **reads** them rather than deriving them
    - Every figure in the monospace face with tabular fixed-advance numerals, and **no numeral animation and no count-up**
    - Emit **no page number, no page count and no total-page indicator**; emit the same column header text, row keys and cell strings in the same column and row order the DOCX emits; emit a `row` as a container carrying its declared column count with no table identity and no anchor triple, so a layout container is never presented as a data table
    - A block whose resolved scope is empty emits the explicit no-resources-matched row with zero figure elements and is not omitted
    - A node type it cannot emit produces **no partial rendering**, reports an error naming that node type, and records **no verification finding** and leaves the run's verification status unchanged — the verifier reads the `.docx` alone and the in-app rendering is never a verification input
    - _Requirements: 14.1, 14.3, 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8_

- [x] 8. Checkpoint — a document renders, in both emitters
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Verification — the delivery gate
  - [x] 9.1 Implement `verify/findings.py` — the finding vocabulary and the result document
    - The sixteen **blocking** finding types — `unmatched_prose_token`, `table_anchor_missing`, `table_anchor_unexpected`, `table_cell_mismatch`, `table_column_unresolved`, `table_row_unresolved`, `duplicate_table_anchor`, `table_rows_absent`, `ledger_entry_unrendered`, `chart_table_missing`, `chart_hash_mismatch`, `replay_hash_mismatch`, `coverage_resource_absent`, `pdf_figure_missing`, `scope_unverified`, `empty_scope` — and the four **advisory** types `archive_incomplete`, `drift_observed`, `prose_review_finding`, `fidelity_not_comparable`
    - Each finding carries its **`severity` on the finding itself** rather than derived by a reader, plus the locating fields the criterion recording it declares — AST path, block id, table identity with row and column key, surviving substring with its paragraph location, expected and observed strings verbatim
    - `VerificationResult` carrying `attempt_id`, `status` (pass | fail), `figure_count`, the four digests, the `counts` block every pass contributes to, the replay outcome, the drift descriptor and the ordered finding list; recording **every** blocking finding observed rather than stopping at the first, up to the first 1,000 in document order plus the total observed count
    - Truncate every quoted document excerpt to 200 characters and apply the foundation's redaction scrub to the result and to every finding message **before** it is written and before it is emitted, because a finding message can quote document text or a service error
    - Assert the Python result document parses cleanly against `app/lib/verifications/result.ts` over a fixture corpus, since Python writes it and zod reads it
    - _Requirements: 25.5, 25.6, 25.8, 36.3, 39.10, 43.7, 43.10_

  - [x] 9.2 Implement `verify/tokens.py` — reading the document the way Word stores it
    - `paragraph_texts(document)` iterating `document.element.body.iter(qn("w:p"))` at **every depth of nesting**, plus every header and footer part, recording for each extracted paragraph which part it came from
    - Read through that iteration and **never** through `document.paragraphs` or `document.tables`: both enumerate only direct children of the body, so a paragraph inside a table cell, a nested table, a text box or a content control is invisible to them — and a verifier that extracts nothing from a chart's companion table nested in a `row` block's layout table finds no unmatched token, records no finding, and **passes the document**. That failure is silent, total and indistinguishable from success
    - `data_tables(document)` returning every `w:tbl` carrying a **non-blank** `w:tblPr/w:tblCaption` with its document ordinal, treating a present-but-whitespace caption as absent so an empty caption can smuggle a table neither into nor out of the data pass
    - Join with **no inserted character**: adjacent `w:t` nodes concatenate directly, every space a `w:t` carries is preserved, `w:tab` and `w:br` each become one space, leading and trailing whitespace is stripped, nothing else is altered
    - Tokenize the **concatenated paragraph**, never an individual run: Word splits runs on spell-check state, revision marks and `rPr` changes, so `1,234.56` commonly arrives as `1,`, `234.` and `56`, and per-run tokenization produces three fragments that match nothing. A numeric token is each maximal whitespace-delimited substring carrying at least one digit, with a paragraph boundary terminating a token, recorded with its part, block identifier and paragraph ordinal
    - PDF normalization in the same module: concatenate what every text-show operator yields in content-stream order, join pages in ascending order with a single space, collapse every whitespace run to one space, trim — so a `formatted` string a conversion split across operators, lines or a page boundary is still one contiguous substring and no correspondence between one operator and one figure is assumed
    - An unopenable `.docx` or a document carrying no body element sets the status to fail with `VERIFICATION_FAILED`, emits no `report_file`, and leaves the stored artifacts unchanged, so an unreadable document is a proven failure rather than an empty token set that passes every later pass
    - Extend `agent/tests/test_boundaries.py`: **no module under `verify/` may reference `.paragraphs` or `.tables` on a `python-docx` document**
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 33.5_

  - [x] 9.3 Implement `verify/masking.py` and `verify/allowlist.py` — five ordered stages
    - The paragraph is a mutable character buffer and a matched span is **overwritten** with `MASK_CHAR = "\u0007"`, which carries no decimal digit and is not `\w`; every later stage runs against the overwritten buffer, so no stage re-reads or re-matches text an earlier stage consumed and the five stages produce one identical output for one input. Overwriting rather than deleting keeps offsets stable, so a finding's location still points at the right paragraph and a figure inside punctuation masks cleanly
    - Stage 1 — every occurrence of every ledger `formatted` string by exact equality, **longest first** by character count with ties broken by ascending code-point sequence, so a shorter figure that is a substring of a longer one cannot mask part of it and leave a digit-bearing fragment behind, and so the ordering is identical on every run over the same ledger
    - Stage 2 — identifiers, `[A-Za-z_][\w.\-]*[0-9][\w.\-]*`, leftmost-longest and non-overlapping, because a figure never begins with a letter
    - Stage 3 — GUIDs in canonical hyphenated form, Azure resource identifiers, IPv4, IPv6 and CIDR suffixes, leftmost-longest and non-overlapping
    - Stage 4 — calendar dates, timestamps carrying a date and a time, and ISO 8601 durations, so `PT1H` and `2026-07-01` are not read as measurements
    - Stage 5 — the **static-text allowlist**, exact equality, longest first
    - `allowlist.py` derives that allowlist **afresh on every verification run** by rendering the pinned template version and the run's design settings with a **null context** — no snapshot bound, no prose, no figures — and taking every numeric-bearing string in the output. There is no hand-maintained list to drift, so chrome added in a later version is allowed without an edit to the verifier. If the null-context render fails, derive no allowlist, check **no** prose paragraph, and **fail** the verification with `VERIFICATION_FAILED`
    - Every maximal whitespace-delimited token remaining after stage 5 that carries a digit is a survivor and yields **one `unmatched_prose_token` per survivor**, carrying the substring and its location: block identifier plus 1-based paragraph ordinal within that block, or, for a paragraph belonging to no block, the region (body, header, footer) plus its ordinal within that region
    - Apply the stages to every paragraph the extractor returned irrespective of which block authored it, including paragraphs inside data tables, layout tables, headers and footers
    - _Requirements: 19.4, 19.6, 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8, 28.9, 28.10, 28.11, 28.12, 28.13_

  - [x] 9.4 Property test — token extraction and prose masking
    - **Property 2: Token extraction and prose masking**
    - **Validates: Requirements 26.1, 26.3, 26.6, 26.7, 26.8, 26.9, 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.9, 28.11, 29.1, 19.3, 19.4, 33.5, 33.6, 45.1**
    - `hypothesis` over documents of 1–5,000 paragraphs and 0–500 data tables; each `formatted` string split across 1–5 consecutive `w:t` runs at random boundaries; paragraphs nested inside data tables, layout tables, headers and footers; prose seeded with stage-2 identifiers, GUIDs, Azure resource ids, IPv4/IPv6/CIDR, dates, timestamps, ISO 8601 durations and allowlist strings; a ledger containing one `formatted` string that is a **proper substring** of another; and, for the negative half, one injected numeric absent from both the ledger and the allowlist
    - Assert a split figure extracts as **one** token; zero survivors when every numeral is legitimate; an injected foreign numeral **always** produces a finding naming it; substring-shadowed strings mask longest-first leaving nothing; every body paragraph is extracted including nested ones; two extractions of one document produce identical tokens in identical order; and the five stages produce one identical output for one input paragraph
    - Declared examples: `1,234.56` split across the three runs `1,`, `234.` and `56`; a resource id containing digits; the grain `PT1H`; the window date `2026-07-01`; the identifier `prod-sql-01`; a ledger holding both `12.4%` and `112.4%`
    - Kills: per-run tokenization, which produces three spurious survivors; reading `document.paragraphs` / `document.tables`, which extracts nothing from a nested companion table and passes every document silently; masking in ledger insertion order, so `12.4%` consumes part of `112.4%` and the leftover `11` survives; a later stage re-reading a span an earlier stage consumed
    - _Requirements: 19.3, 19.4, 26.1, 26.3, 26.6, 26.7, 26.8, 26.9, 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.9, 28.11, 29.1, 33.5, 33.6, 45.1, 45.3, 45.4_

  - [x] 9.5 Implement `verify/anchors.py` — anchored cell equality — with Property 3
    - Resolve in the order **table, then column, then row**: the one data table whose caption identity is character-for-character equal to the anchor's table id; within it, the one column whose **header text** equals the anchor's column key; within it, the one row whose **row key** equals the anchor's row key; the cell is their intersection. Zero or more than one match at any step is its own finding — `table_anchor_missing`, `table_column_unresolved` (naming the match count), `table_row_unresolved` — because a column key resolving to two columns has no single cell to compare
    - Then assert the resolved cell's **concatenated** text equals the anchor's `formatted` string **character for character**, with no trimming beyond the extraction's own, no whitespace normalization, no case folding, no unit stripping and **no re-parsing of either side as a number**
    - Assert **exact equality of the resolved cell** and **never containment anywhere** in the document, the table or the cell: transpose two columns across every data row and every `formatted` string is still present — attached to the wrong things — so containment reports a clean pass on a report in which every VM's average and peak are swapped, which is exactly the class of error that survives review by looking reasonable
    - Resolve by exact equality only, never by ordinal position, prefix, case-insensitive match or any similarity measure, which is what makes a **reordered** column verify cleanly while a **transposed value** fails — the two cases a positional implementation gets backwards
    - A data table whose identity matches no ledger anchor is `table_anchor_unexpected`; two data tables sharing an identity is `duplicate_table_anchor`; a data table with zero data rows while its block's scope resolved to ≥1 resource is `table_rows_absent` naming the identity, the scope count and the observed row count; a table carrying the explicit no-resources-matched row as its **only** data row with zero anchors records **nothing**
    - Order findings by table identity, then row key, then column key, so two verifications of one document against one ledger produce identical results; record the count of anchors checked and data tables resolved, so a pass produced by checking zero anchors is distinguishable from a pass produced by checking all of them
    - **Property 3: Anchored cell equality detects transposition**
    - **Validates: Requirements 27.1, 27.2, 27.3, 27.9, 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.8, 21.9, 30.2, 45.1**
    - `hypothesis` over tables of 1–40 columns × 0–500 rows with unique headers and row keys, figure and text cells mixed, tables nested inside layout tables, and charts of 1–8 series × 1–744 points with their companion tables; mutations drawn from {none, transpose two columns' values, permute column order with headers, permute row order with keys, mutate one cell, remove one caption, duplicate one caption, alter one sidecar hash}
    - Assert unmutated ⇒ zero findings; transposition ⇒ ≥1 `table_cell_mismatch`; a header/key-carrying permutation ⇒ zero findings; a single-cell mutation names the table, row and column; a layout table carrying numeric text produces no table finding; a removed caption ⇒ `table_anchor_missing`; every data table in a generated AST carries a caption and every layout table carries none; every table identity is unique and path-derived; and a chart's recomputed hash draws no contribution from the sidecar
    - Declared example: a two-column table whose `Avg CPU` and `Max CPU` values are transposed across every row, asserting **both** that the anchored pass fails **and** that a containment check over the same document records zero discrepancies
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.9, 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9, 27.10, 27.11, 27.12, 27.13, 27.14, 45.1, 45.3, 45.4_

  - [x] 9.6 Implement `verify/charts.py` — an image tied to the numbers beside it
    - Pair each chart's embedded image with its companion data table by the `cht:<path>` identity — the identity written into the image's alternative text and the table's caption — **not by proximity** — and check that companion table through the anchored-equality pass
    - Recompute the chart data hash **from the ledger**, one contribution per plotted point carrying series stable key, x key and the ledger's decimal string, ordered by plotted series and plotted point order, and draw **no contribution** from the sidecar or the image, because a digest recomputed from the artifact it checks proves nothing
    - Both gates required: the table gate alone passes a document whose embedded image is stale, and the hash gate alone passes a document whose companion table carries a value the ledger never emitted
    - A missing companion table is `chart_table_missing`; a mismatch, an absent sidecar digest, or a sidecar value unreadable as a digest is `chart_hash_mismatch` naming the AST path, the recomputed digest and the observed one — a chart whose image cannot be tied to its data fails the same way as one that disagrees with it
    - Check **every** chart node rather than stopping at the first with a finding, and record the count of chart nodes checked, the count of hashes matched, and the identity of every chart carrying a blocking finding
    - _Requirements: 22.3, 22.4, 22.5, 30.1, 30.2, 30.3, 30.4, 30.5, 30.6, 30.7_

  - [x] 9.7 Implement `verify/coverage.py` — the gate that stops a clean empty report
    - `scope_verified` **false, absent or unrecorded** ⇒ `scope_unverified`, fail. The gate **fails closed on a missing value**: subscription-scope read is unproven unless the preflight proved it
    - Every resource id of the run's union scope must be present in the snapshot's resource set; each absence is one `coverage_resource_absent` naming that identifier. A union that cannot be resolved at all is **also** `coverage_resource_absent` naming the rule, failing closed rather than reporting complete coverage
    - A verification against a snapshot whose resource set is empty is `empty_scope`, fail, so re-verifying a stored empty snapshot fails rather than passing
    - Derive the union set and the coverage assertion from the snapshot and the pinned version **alone** with zero Azure queries, because the inventory query is itself RBAC-filtered and a coverage check therefore cannot detect what RBAC hides
    - Record the union resource count, the snapshot resource count and the `collection_log` entry count as non-negative integers whether the verification passes or fails
    - One block resolving to zero while the union is non-empty records **no** `empty_scope` and **no** `coverage_resource_absent` for that block, and reports no terminal code — that is ordinary compile output
    - Unit tests: `scope_verified` false, absent and unrecorded all three failing; an unresolvable union; a snapshot with zero resources
    - _Requirements: 32.1, 32.2, 32.4, 32.5, 32.6, 32.7, 32.8_

  - [x] 9.8 Implement `verify/pdf.py` — the fidelity gate
    - For every ledger entry, assert a **located** occurrence of that entry's `formatted` string in the normalized PDF text, where located means bounded at each end by the text's start, its end, or a character that is neither a digit, nor the decimal separator, nor the grouping separator — so `12.4` appearing only inside `112.45` counts as absent
    - Apply the same whitespace normalization to both sides; each absence is one `pdf_figure_missing` naming the AST path, the `formatted` string and the `snapshot_path`, recorded for **every** entry lacking an occurrence rather than stopping at the first
    - Identify the checked `.pdf` by asserting its SHA-256 equals the recorded `pdf_sha256`, so the gate cannot be satisfied by an independently rendered file, one emitted from the AST, or one emitted from the ledger
    - Record entries checked, entries located, `pdf_figure_missing` findings, pages read and the digest of the `.pdf` checked
    - A `.pdf` from which **zero** text characters extract while the ledger holds ≥1 entry is `PDF_CONVERSION_FAILED` with **both** downloads withheld and the snapshot, ledger and `.docx` left unmodified — a PDF carrying no extractable text is a conversion that failed without failing
    - _Requirements: 33.1, 33.2, 33.3, 33.4, 33.6, 33.7_

  - [x] 9.9 Implement `verify/replay.py`, its purity guard and Property 4
    - `replay(archived, *, plan) -> ReplayOutcome` re-running the **same pure aggregation** the Snapshot_Builder ran, canonicalizing and hashing the recomputed snapshot **through the same code path**, and asserting a byte-for-byte equal `snapshot_id`
    - Zero Azure API calls and **zero network requests of any kind**; the archived objects arrive **from the caller** as an iterable rather than being fetched, and only modules that make no network request are imported
    - Fold each archived object **exactly once** in the order the archive sequence records, derive every folded value from that object's raw points alone and from no accumulator, aggregate or digest read out of the stored snapshot, and discard each object's decoded points once folded so no more than one object's points are held at a time
    - A mismatch is `replay_hash_mismatch` carrying the recomputed digest, the stored `snapshot_id` and the fold count, and the run reports `REPLAY_MISMATCH`; the verification status is fail, so no download exists
    - A **known-incomplete** archive is an inability to replay, never a proven mismatch: the snapshot's archive flag being false, an object the sequence names being absent, or an object failing to decode records the **advisory** `archive_incomplete` naming the sequence ordinal, records that replay was not possible, and records **no** `replay_hash_mismatch` — reporting a mismatch there would accuse a run of non-determinism on the strength of a missing input
    - Record the replay outcome on the result: recomputed digest, stored digest, objects folded, objects named and whether replay was possible
    - Extend `agent/tests/test_boundaries.py` with the **replay-purity guard** in this same task: walk `verify/replay.py`'s transitive **first-party** import closure and fail if any module in it imports `azure.*`, `boto3`, `httpx` or `reporting_agent.storage.s3`. Task 1.1 is what makes this pass on the first run
    - **Property 4: Replay produces a bit-identical snapshot digest**
    - **Validates: Requirements 31.1, 31.2, 31.4, 9.13, 45.1**
    - `hypothesis` over 1–200 archived objects across 1–50 resources × 1–8 metrics × 1–744 intervals with per-interval `{min, max, total, count}` as decimal strings, including zero-count intervals, malformed intervals and per-resource errors at HTTP 200; mutations drawn from {none, alter one decimal string, drop one object, corrupt one object's gzip}
    - Assert the recomputed digest equals the original; identical across **two operating-system processes** started from one commit with differing `PYTHONHASHSEED`; a network double fails the property if any call is attempted; any single-value mutation produces a differing digest; and a fold counter shows each object folded exactly once
    - Kills: a replay that reads the stored `snapshot_id` and returns it — the mutation cannot change a digest that was never recomputed; one iterating a `set` on the path, which the two-process case exposes; one that double-folds or skips an object; one that fetches its own objects
    - _Requirements: 9.13, 31.1, 31.2, 31.3, 31.4, 31.5, 31.6, 31.7, 31.8, 31.9, 45.1, 45.3, 45.4_

  - [ ] 9.10 Implement `verify/drift.py`, `verify/ports.py` and Property 5
    - `ports.py` declaring `MetricRequeryPort`, because `verify/` may not import an Azure SDK and the bounded sample is the one place verification touches Azure at all — which is what lets the entire verification suite run without a subscription
    - Selection is **pure and separate** from the re-query: a function over the snapshot, the resource ids the document names, and the seed, making no network request and importing no Azure client
    - Three tiers in precedence order — every resource the document names that the snapshot carries; then the 10 resources with the highest recorded maximum for the report's primary metric; then 10% of the snapshot's resources rounded up, drawn pseudo-randomly from the seed — each resource admitted at most once, admission stopping at **25 distinct** resources, and no resource selected that is absent from the snapshot. The primary metric is the metric the pinned version's selection names first for the resource type carrying the most resources in the union scope
    - Order candidates within each tier by ascending resource id, break a tie in the recorded maximum by ascending resource id, and break a tie in resource count between two resource types by ascending resource type id, so **truncation at the cap is deterministic**
    - Record `{n, method, seed}` **before** the first re-query and whether or not a finding results, so a disputed check is re-runnable identically
    - Re-query only the sampled resources and never the full snapshot; re-query the primary metric over the run's window at the run's grain and compare against the snapshot's value for that same resource, metric and window; a differing value at the snapshot's recorded precision is the **advisory** `drift_observed`; a re-query returning nothing records the resource as not re-queried, records no finding, leaves the snapshot unmodified and continues the remaining re-queries
    - The verification status derives from **no** `drift_observed`, and the run's status, terminal code and artifacts derive from neither a difference nor a not-re-queried resource — because a value re-queried later legitimately differs from one collected earlier, and treating that as a failure would make every honest run fail eventually
    - **Property 5: Drift sample selection is bounded and reproducible**
    - **Validates: Requirements 34.1, 34.2, 34.4, 34.7, 45.1**
    - `hypothesis` over snapshots of 0–2,000 resources across 1–5 types; documents naming 0–60 of them; recorded maxima including exact ties; seeds as 32-byte hex; and a tie in resource count between two resource types. Assert `n ≤ 25`; identical selection per triple; every document-named resource included when ≤25; the top ten by maximum included subject to the cap; every selection drawn from the snapshot; **exactly 25** for a snapshot above 250 resources; two distinct seeds differing in ≥1 resource above the cap; and a network double proving purity
    - Declared examples: ten resources sharing one recorded maximum, asserting the tie breaks by ascending id; two resource types with equal counts, asserting the primary metric resolves by ascending resource type id
    - Kills: a selector whose sample grows with the snapshot; one ignoring the seed; one whose truncation depends on dictionary or set iteration order; one re-querying during selection
    - _Requirements: 25.7, 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.7, 34.8, 34.9, 34.10, 45.1, 45.3, 45.4_

  - [ ] 9.11 Implement `verify/verifier.py` — the orchestrator and bidirectional completeness
    - `verify(*, docx_bytes, pdf_bytes, ledger, ast, snapshot, pinned, run, archived, requery)` — `archived` is an iterable the **caller** already fetched, and `requery` is a port, both structural rather than convenient
    - Evaluate every gate of requirements 26 through 33 **before** any `report_file` event, against the rendered `.docx` whose digest was recorded and against the snapshot the run's `snapshot_id` names
    - **Forward completeness**: every extracted numeric token resolves, where resolving means it was a data-cell value the anchored pass matched or a numeric-bearing substring a masking stage consumed, and every extracted token goes through one of the two so none is excluded from both
    - **Backward completeness**: every ledger entry appears — a table entry only if its anchor's cell text equals its `formatted` string exactly, a chart entry only if the corresponding companion-table cell does, and a prose entry only if its string occurs in the concatenated paragraph text of a paragraph belonging to the block its AST path names; where two prose entries in one block carry an identical string, require at least that many occurrences and resolve no two entries to the same occurrence
    - An entry that does not appear is `ledger_entry_unrendered`, **blocking and blocking alone**, never downgraded to advisory — in this product a template compiles the figures the composed blocks declared, so there is no unused option to tolerate and a compiled figure that did not render is a rendering defect that silently dropped part of the report. An entry unrendered **because** the anchored pass already recorded a mismatch or an unresolved anchor for it records no second finding, so one defect yields one finding and the counts stay unambiguous
    - Record four counts whether the status is pass or fail — entries checked, entries resolved, `ledger_entry_unrendered` findings, numeric tokens extracted — with entries-checked equal to the ledger's total
    - `status` is `pass` only where **every** gate has been evaluated and zero blocking findings are recorded; a verification that terminated early is a **fail**, because an incomplete verification must never be a delivered report. Advisory findings never affect the status
    - Make no Azure call other than the bounded drift sample; record every blocking finding observed up to 1,000 in document order plus the total; persist the result through the store **before** the terminal `VERIFICATION_FAILED` event, so the panel presents every finding for a run whose document was withheld
    - `verify_report` re-verification reads the stored `.docx`, `.pdf` and ledger and the snapshot the run names, fetches no fresh snapshot, runs no collection, recompiles the **pinned** version rather than the template's current one, and asserts the recompiled ledger is byte-identical to the stored one; an absent, unreadable or digest-mismatched stored input sets that attempt's status to fail with `VERIFICATION_FAILED` naming the affected input, reconstructs nothing, and modifies no earlier row
    - _Requirements: 25.1, 25.2, 25.5, 25.6, 25.7, 25.8, 25.10, 25.11, 27.13, 29.1, 29.2, 29.3, 29.4, 29.5, 29.6, 29.7, 29.8, 30.7, 32.6, 33.4, 36.4, 36.5, 36.8, 9.13_

  - [ ] 9.12 Implement `narrate/summary.py` and `narrate/review.py`
    - `summary.py` generates `executive_summary` prose from exactly the permitted context: each ledger figure as its `formatted` string with that figure's unit, statistic, resource id, window, fidelity tier and estimator label; the compiled aggregate table; and the `collection_log` gap counts grouped by type. It receives **no raw metric series** — no per-timestamp value and no numeric absent from the ledger — through a single-shot Bedrock Converse call with **no tool list**
    - Persist the generated prose as `reports/<runId>/prose.json` and pass it **into** subsequent compilations of that run, so a compile is a pure function of (template version, snapshot, prose bundle): a model call inside the compile would make the AST digest non-identical across two compilations and would make a re-verification's byte-identical recompiled ledger depend on a model's determinism
    - `review.py` — the advisory Prose_Reviewer — receives exactly two inputs, the model-authored prose nodes and the aggregate table of rendered `formatted` strings, and no raw series, no `collection_log` entry and no archived response; records at most 25 advisory `prose_review_finding` entries carrying the reviewed node's AST path and the observation text, carrying no numeric absent from both the ledger and the allowlist; writes nothing; applies nothing automatically; is bounded at 60 seconds after which the outcome is recorded as not completed with no finding of any other type, no further attempt, and no change to either status
    - The verification status is identical whether the review completed, produced findings, or never ran, and no artifact is withheld pending it
    - Extend `agent/tests/test_boundaries.py`: **no module outside `narrate/` imports a Bedrock client**; the SDK boundary scan now also covers `compile/`, `render/`, `verify/`, `compare/` and `narrate/`; `formatted` is assigned in exactly one module and no module under `render/` or `verify/` performs arithmetic on a figure's `value`; and `unicodedata.normalize` appears nowhere on a hash path including the AST and ledger digests
    - Req 19.7's enumeration test asserts the runtime exposes **zero** operations to a model that return a per-timestamp value or accept a number reaching a figure position — an assertion over an **empty set**, which is the strongest form it can take, and the reason no tool registry exists here
    - _Requirements: 19.1, 19.2, 19.3, 19.5, 19.7, 19.8, 35.1, 35.2, 35.3, 35.4, 35.5, 35.6, 35.7, 35.8_

  - [ ] 9.13 Property test — the ledger and the AST agree in both directions
    - **Property 6: The ledger and the document AST agree in both directions**
    - **Validates: Requirements 17.1, 17.3, 17.7, 15.2, 15.4, 15.7, 15.10, 15.11, 16.1, 29.2, 29.6, 3.7, 45.1**
    - `hypothesis` over definitions across all sixteen block types, 1–200 blocks, rows at one level with 2–3 columns and 0–8 children, per-block overrides including some matching nothing and some carrying top-N; snapshots of 0–300 resources across 1–5 types with statistics, day buckets, derived values, percentiles carrying estimators and `collection_log` entries; number formats and design settings from Property 1's space
    - Assert exactly one entry per figure node keyed by that node's path; no entry addressing an absent node; two compilations over one pair producing an identical AST digest, an identical ledger digest and identical `formatted` values; zero `ledger_entry_unrendered` findings against the document the DOCX emitter produced from that compilation; an empty-scope block present in the tree with its explicit row and zero figures; a walk of the finished tree finding **no numeric value outside a `Figure`**; and every `snapshot_path` resolving to exactly one value whose decimal string equals the figure's `value`
    - Declared examples: a definition whose every block's scope matches nothing while the union matches one resource; and a definition with two figures emitting the identical `formatted` string in one block, asserting two entries and two occurrences
    - Kills: a compiler building the ledger by walking the finished tree, which fails the identity test and fails digest equality the moment the walk visits a hash-ordered container; one omitting an empty block; one deriving a path from emission order; one accepting a `Decimal` in a cell
    - _Requirements: 3.7, 15.2, 15.4, 15.7, 15.10, 15.11, 16.1, 17.1, 17.3, 17.7, 29.2, 29.6, 45.1, 45.3, 45.4_

- [ ] 10. Checkpoint — the verifier gates
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. The pipeline, the commands, the events and the extended state machine
  - [ ] 11.1 Implement `report_pipeline.py` — collect → compile → render → verify → upload
    - `run_generate_report(*, payload, context, steps, artifact_bucket, aws_region, progress)` composing over task 1.2's `run_collection(...)` rather than replacing it, one phase at a time, and deferring the `PARTIAL_COVERAGE` raise to the end of the whole run so a run with gaps still completes and its non-terminal event arrives before `done`
    - Phases and their steps: `collecting` → `collect_inventory` / `collect_metrics`; `compiling` → `compile_figures` emitting `progress` over blocks compiled plus `delta` and `chart`; `rendering` → `render_document` emitting `progress` over blocks emitted; `verifying` → `verify_document` emitting `verification`; then `upload_artifact` emitting two `report_file` events
    - Assert **before any Azure collection call**, at claim, that the theme document the pinned version's preset names is present in the image and declares `Figure`, failing with `RENDER_FAILED` naming the theme — so the failure surfaces before minutes of collection work are spent
    - Run the union-scope gate after inventory and **before any snapshot write**: a union of the template default and every block override resolving to zero resources is the terminal `EMPTY_SCOPE`, writing no snapshot, compiling nothing, rendering nothing and emitting no `report_file`. The reasoning bears restating: an expired secret or an over-narrow role yields zero resources → zero figures → zero *unverifiable* figures → a clean pass on every other gate → a fully verified, empty, worthless report
    - Request the **union** of every block scope with duplicates collapsed and every top-N count and sort direction ignored when forming it, and per resource type exactly the union of the pinned version's metric selections and nothing outside it
    - Upload the artifacts **after** a passing verification, so there is no window in which a `report_file` event could name an object that exists beside a failure
    - Open and close every step through the foundation's `StepTracker`, so `progress.id` still references an open step, `done` never decreases, and a phase that ends by raising still gets its `phase: "end"` before `done`
    - _Requirements: 3.3, 3.9, 5.4, 8.9, 25.1, 32.3, 41.1, 41.3, 41.4, 41.7, 42.1_

  - [ ] 11.2 Route `verify_report` and `render_preview`, and write the invoke contract
    - Add `COMMAND_VERIFY_REPORT` and `COMMAND_RENDER_PREVIEW` to `main.py`'s `COMMAND_HANDLERS`, both deterministic with any `prompt` ignored; leave `compare_runs` **declared and unrouted**, because comparison is a block compiled inside a run and a standalone comparison screen is out of scope
    - `verify_report` re-verifies a stored report from its pinned version and pinned snapshot; `render_preview` compiles a definition carried **inline** rather than a stored version id, renders it through the real `python-docx → LibreOffice → PDF` path, writes to `<actor_id>/previews/<previewId>/preview.pdf`, and emits **no** `report_file` event
    - The preview `.docx` carries a per-page notice emitted against each theme's `PreviewNotice` paragraph style, so the artifact says what it is even after it leaves the app; the verifier runs over a preview and its status is reported as information but **does not gate** it, because a draft template must be previewable for layout reasons before its figures verify
    - Create `agent/AGENTCORE_INTEGRATION.md` as the authoritative invoke contract: the unchanged twelve-field `context`, `generate_report` extended with `template_version_id` and the union `scope`, `verify_report`, `render_preview`, and `compare_runs` recorded as declared and unrouted; add the `#[[file:agent/AGENTCORE_INTEGRATION.md]]` inclusion to the workspace steering document in the same change so the two cannot drift
    - _Requirements: 14.5, 14.6, 36.4_

  - [ ] 11.3 Emit the four declared event types and assert the ordering contract
    - `verification` — **exactly one** per invocation, carrying the status, the figure count, every blocking and advisory finding with its type and location, the `snapshot_id`, the replay outcome with both digests, the drift descriptor and the counts, and carrying the **same values written to the store**, so a client that received no event renders the identical panel from the stored result
    - `report_file` — one per artifact carrying key, bucket, kind and byte count, and **no presigned URL and no content**; emitted only after a `verification` carrying `pass` earlier in that same invocation, never for a failing verification, and never in an invocation that emitted no `verification`
    - `chart` — the structured spec with each plotted value as a decimal string, the `encoding` taken **from the emitting block's declaration rather than the series count**, the chart data hash and a ledger reference per plotted figure
    - `delta` — model-authored prose only, carrying no numeric absent from both the ledger's `formatted` values and the static-text allowlist
    - **Add no event type**, so `lib/events.ts` and `events.py` need no edit and the cross-language mirror guard stays untouched; add a sibling constant naming the ten types this spec emits, outside the sentinels
    - Emit `snapshot_ready` before any `verification`, `done` last with nothing after it, and consecutive events no more than 30 seconds apart while the status is `compiling`, `rendering` or `verifying`, with `heartbeat` at 15 seconds ±5 — a 600-second rendering phase with nothing to say would otherwise sit inside the relay's 120-second window with no event at all
    - Unit tests with the foundation's fake clock: `snapshot_ready` before any `verification`; `report_file` only after a pass; nothing after `done`; a step left open by a raising render phase still closed before `done`; heartbeats at least every 30 seconds through a silent 600-second verify phase
    - _Requirements: 25.9, 42.1, 42.2, 42.3, 42.4, 42.5, 42.6, 42.7, 42.8, 42.11_

  - [ ] 11.4 Write the report artifacts under the actor prefix and scrub before writing
    - Write, per run, `reports/<runId>/report.docx`, `report.pdf`, `ledger.json`, `ast.json`, `prose.json`, `verification-<attemptId>.json` and `charts/<chartId>.png` with its `.sidecar.json`, every object **private**, tagged with the owning actor id, with the actor id as the **first** key segment and `reports` as the second, and no public read on any of them
    - Serialize the ledger once with entries ordered by AST path and RFC 8785-canonicalized, and record its digest on the verification result, so a later re-verification reads the same ledger the render used
    - Apply the redaction scrub to the verification result and to **every finding message**, including every quoted service error, before writing and before emitting, and truncate every quoted document excerpt to 200 characters; a registered secret found in a result, a finding message or a quoted error is replaced with the fixed marker while the finding is retained, and no unredacted copy is written or emitted
    - _Requirements: 17.6, 22.3, 36.3, 43.1, 43.7, 43.10_

  - [ ] 11.5 Drive the three phases, extend the reaper, and add the verification callback
    - `app/lib/runs/state.ts`: extend `DRIVEN` with `compiling → rendering|failed`, `rendering → verifying|failed`, `verifying → completed|failed`, keeping `collecting → completed` because a snapshot-only invocation is still a legal run shape and removing it would break foundation tests; add `PHASE_DEADLINE_SECONDS` of `compiling: 300`, `rendering: 600`, `verifying: 600`
    - `verifying → completed` carries a precondition beyond the table: the endpoint reads a `report_verifications` row for that run with `status` `pass` **in the same transaction** as the update, so no ordering exists in which a run reports success before its proof is stored
    - Extend `POST /api/internal/runs/[runId]/progress` to accept the new transitions, setting `phase_deadline` to the write instant plus that phase's budget and `updated_at` to that instant, rejecting a transition on a terminal row and a transition absent from the table; `PDF_CONVERSION_FAILED` arrives from the `rendering` status and **no status is added** for PDF conversion
    - New `POST /api/internal/runs/[runId]/verification` on the Node runtime, run-scoped HMAC authorized through the existing constant-time validator, parsing `verificationCallbackSchema` (attempt id, status, figure count, the three digests, the **artifact key**), reading and parsing that artifact with `verificationResultSchema`, and inserting the row. The callback carries a **pointer** rather than a copy: a 1,000-finding list with 200-character excerpts would make a several-hundred-kilobyte fire-and-forget POST, and the artifact is the record anyway. A bad token and an unknown run id return one identical `404`
    - Extend the Reaper's sweep predicate to `compiling`, `rendering` and `verifying`, failing a row past its `phase_deadline` as `failed` / `TIMEOUT`, **preserving the status the row held** as the recorded failing phase, within 120 seconds of the deadline elapsing; the agent sends `TIMEOUT` in no transition, because it may already be absent when a deadline elapses
    - The agent's `Progress_Reporter` sends the compile, render and verify transitions fire-and-forget, abandoning the send after 5 seconds, continuing the phase whatever the outcome, and failing no run because a transition did not land
    - _Requirements: 25.2, 36.1, 41.1, 41.2, 41.3, 41.4, 41.5, 41.6, 41.7, 41.8, 41.9, 41.10_

  - [ ] 11.6 Integration tests for the extended machine, the reaper and the relay's reconstruction
    - Against real Postgres: the extended transition table over **all** `(current, target)` pairs including every terminal row rejecting every target; `verifying → completed` refused when no passing verification row exists and accepted when one does; the sweep naming the expired phase from the pre-update `status` for each of the three new phases; `(run_id, attempt_id)` making a retried verification callback idempotent; a `PDF_CONVERSION_FAILED` transition arriving from `rendering` and adding no status value
    - The relay carries **no** document-phase state that cannot be reconstructed from the run row plus the stored verification result, and its stream closing during compile, render or verify causes no change to the run's outcome
    - After a 120-second event gap on a non-terminal run, the client opens a new stream within 5 seconds, reconstructs the compile / render / verify state from the row and the stored result **before** rendering, and requests no event replay
    - _Requirements: 41.1, 41.5, 41.8, 41.9, 42.12, 42.13, 36.7_

- [ ] 12. Checkpoint — a full run reaches `completed` behind a passing verification
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. The wizard, the composer and the report surfaces
  - [ ] 13.1 Implement the template routes and server actions
    - `POST /api/templates` (create + `version` 1), `GET /api/templates` (list, scoped by `user_id`), `GET /api/templates/[id]` (draft + current version, **not found** on another user's row), `PATCH /api/templates/[id]` (writes `draft_definition`, inserts no version row), `POST /api/templates/[id]` (validate, canonicalize, insert `max+1`, or return the existing version when the digest is unchanged), `DELETE /api/templates/[id]` (versions a run pinned survive by FK), and `GET /api/templates/catalog` serving the **Metric_Catalog's** selectable items so step 4 reads one catalog rather than a list held in `app/`
    - Every handler on the Node runtime, typing params as `RouteContext<'/api/templates/[id]'>` and **awaiting** them, and parsing every input — path params and search params included — with a **named zod schema** at the boundary; no `as SomeType` on a body, ever; `Cache-Control: no-store` on the handlers that must not be cached
    - `lib/actions/templates.ts`: `createTemplate`, `saveDraft`, `publishTemplateVersion`, `renameTemplate`, `deleteTemplate` as thin wrappers over the store; `lib/runs/input.ts` gains `templateId` and the enqueue resolves the **highest** version at insert, rejecting with "the template has no saved version" when none resolves and rejecting a subscription that is not `active` or whose `scope_verified` is false with an error attributing the cause to that subscription while leaving the template selectable for every other active subscription
    - Reject at enqueue, before inserting any row: a resolved period of zero local days, a span outside 1–31, an end after the local day preceding the current local date, and a pinned version whose period specification is unrecognized — retaining the consultant's selections for correction
    - _Requirements: 1.4, 1.5, 1.8, 1.9, 2.2, 4.3, 4.6, 4.7, 4.10, 4.11, 5.6, 9.2, 9.5, 9.6, 9.7, 10.7, 11.4_

  - [ ] 13.2 Build the wizard shell and the seven steps
    - `app/app/(app)/templates/page.tsx` listing `TemplateView` with the three starters present from account creation, version number and digest in mono, and a "New template" pill; `app/app/(app)/templates/[id]/edit/page.tsx` as a server component loading the draft and rendering `wizard-shell.tsx` as the **only** `"use client"` boundary owning state
    - Exactly seven steps in fixed order — identity, scope rules, period, metrics, blocks, design, preview — with the current position and the total of seven displayed on **every** step
    - Backward navigation to any already-reached step always allowed and resetting nothing; forward navigation past a failing step refused **on that step** with every failing field path named and every entered value on every step retained; a step transition or an explicit save writes the draft and inserts **no** version row, whether or not step 7 was reached and whether or not the definition yet carries a block
    - Reopening a template restores every persisted value and opens the lowest-numbered failing step, or step 7 when every step passes; a failed draft persist states that the draft was not saved, retains every entered value, inserts no version row and leaves the previous draft unchanged
    - Completion inserts the version only when every step passes **and** the definition carries at least one block, returning the existing version when the digest is unchanged, and otherwise names each failing step and field path and states that a report needs at least one block
    - Step 3 presents exactly the six relative specifications, requires the two local dates for `custom`, and **displays what the rule resolves to at the current instant** labelled as an illustration resolved fresh at each run, persisting no resolved date in the definition. Step 4 presents the catalog's selectable items with each item's exact-or-estimated status and fractional-digit scale
    - **No control anywhere in the wizard uploads a document.** Extend `app/test/boundaries.static.test.ts` in this task: no component under `components/templates/` renders an `input[type=file]` for a document MIME type, and no route accepts a `.docx` body
    - _Requirements: 4.1, 4.2, 5.6, 7.2, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10_

  - [ ] 13.3 Build the block composer — palette, canvas, inspector
    - `block-palette.tsx` grouping the blocks as Structure · Data · Narrative · Record, each a `rounded-lg` card with a Phosphor icon and one line describing **what that block emits** rather than what it is called, every entry keyboard-focusable; `Enter` or `Space` appends to the end of the top-level sequence, selects the appended block and **moves focus to it**, so a keyboard user's next reorder acts on what was just inserted
    - `block-canvas.tsx` rendering a **real DOM-ordered list** whose order equals the order the document emits, with each row's children in column order, so reading order matches document order; `block-canvas-item.tsx` is both a dnd-kit draggable/droppable **and** a keyboard command target, and both paths dispatch the identical action into `lib/templates/composer.ts`
    - Keyboard model, which is the primary path rather than a fallback: `Mod`+`ArrowUp`/`ArrowDown` nudges one position within the block's own container; `Mod`+`ArrowLeft`/`ArrowRight` promotes out of or demotes into the adjacent row column; `Delete`/`Backspace` removes the selected block; the row's explicit 2/3 control is focusable. **dnd-kit's keyboard sensor is not used** — Req 12.4 describes a one-position command rather than a lift-move-drop gesture with a pixel delta, and bare arrows during a lift are the pattern that breaks with a screen reader running, because the screen reader consumes them for its own navigation
    - `move-announcer.tsx` as the **single** `aria-live="polite"` region rendering the reducer's `announcement` within 1 second of a completed move, exactly once per move, naming the block's type label, its 1-based position and its container's total, and naming the row's column and column count inside a row
    - Drop indicator: a **2px `--primary` rule** at the insertion point that shifts **no** surrounding block, removed when the pointer leaves; selection is a `--ring` outline with **no colour fill and no background change**, so the canvas keeps resembling the document it previews
    - `row-splitter.tsx` presents splitting as an **explicit control on the row** rather than a gesture to discover, and a row's columns **refuse** another row visibly: a blocked cursor, a "rows can't nest" hint, no insertion rule, and an unchanged order on release — and the identical refusal announced through the `polite` region for a keyboard attempt, because a drag that silently does nothing reads as a defect and invites repetition
    - `scope-editor.tsx` presents the selected block's `scope_override` with the inherited template default shown **above** it in `--muted-foreground`, so inheriting and narrowed are visually distinct states rather than the same empty field; `block-inspector.tsx` renders that block's config schema as a form
    - Three panes reachable from the keyboard in the order palette, canvas, inspector, with a visible `--ring` on the focused element and no pane trapping focus; every drop target's accessible name carries its 1-based insertion position, its container's total, and, inside a row, that row's column number and column count
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 12.14_

  - [ ] 13.4 Build the style preset picker and its real thumbnails
    - A build-time step in the agent image producing `agent/themes/thumbnails/<preset>.png` plus `<preset>.json` carrying `{theme_sha256, generated_by}`, via the **real** render path over a fixed sample definition that exercises a heading style, body prose and a data table, rendered with a **null context** so the page carries no figure a snapshot did not produce; the images are committed beside the themes and served from `app/public/theme-thumbnails/`
    - `style-preset-picker.tsx` presents the four presets as a **2×2 grid of selectable cards**, each carrying its name and its rendered page image at the page's own aspect ratio and a rendered width of at least 240 CSS pixels, with exactly one preset selected at every instant, and offers **no name-only control in place of the grid** — a theme is a visual decision and a name gives a consultant nothing to decide with
    - Compare each image's recorded `theme_sha256` against the digest the app was built with; a mismatch or a missing image renders the card with its name, its text alternative and an explicit "page image unavailable" statement, still selectable, and substitutes no select
    - Each thumbnail's text alternative names the preset and **describes that theme's heading typography, table treatment and density in words**, so a consultant who cannot see the image chooses from the description — which makes the description content rather than an `alt` afterthought
    - Selection is a `--ring` plus a `--primary` check, exposed programmatically to assistive technology and conveyed through no colour difference alone; arrow keys move focus within the grid with a visible `--ring` and a keyboard confirmation selects; the design tuning controls sit **below** the grid
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

  - [ ] 13.5 Build the paper preview and the real-preview path
    - `paper-preview.tsx` emits from the **same AST** the DOCX emitter emits from, through the HTML emitter, holding no layout definition of its own
    - The preview label is **permanent**: rendered on every render, visible whenever any part of the canvas is, behind no hover, focus or disclosure, with **no dismiss control**, surviving scrolling and every re-render. Beside it, in visible text, the three divergences named explicitly — **pagination, table column widths and font metrics** — and the statement that the rendered `.pdf` is the delivered result
    - **No page number, no page count and no page-position indicator**, the only permitted page marker being one representing a `page_break` block the definition declares, carrying no number — implying pagination the HTML emitter cannot determine is worse than omitting it, because a wrong page count is a promise the document will break
    - `POST /api/templates/[id]/preview` on the Node runtime invoking `render_preview` against the most recent snapshot of a **completed** run owned by the signed-in user for the selected **active** subscription, with a 180-second budget, and `real-preview-panel.tsx` presenting the resulting `.pdf` **inline** with the `snapshot_id`, the window with its UTC offset and the compiled template version, stating that the figures are that completed run's and that what it demonstrates is pagination, column widths and font metrics
    - This is the **only** surface permitted to state that the result is what the consultant will receive; no such statement appears on the canvas, the wizard or the report detail surface. There is **no download control** for a preview and no `report_file` event; the preview key prefix is one the report download predicate cannot serve; schedule the superseded-preview cleanup with `after()` so a slow delete never widens the 180-second budget
    - No completed run for the selected subscription disables the action with that stated reason, starts no render and renders nothing from fabricated or placeholder data; every further activation while one is in flight is ignored; a failure or a 180-second lapse names the stage that failed as compilation, `.docx` rendering or `.pdf` conversion, presents no `.pdf`, and leaves the canvas and its label unchanged
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10_

  - [ ] 13.6 Build the reports list, the report detail surface and the provenance reveal
    - `/reports` carrying per run the `status`, template name, pinned version number, **masked** subscription id, the resolved period as that run's local start and end dates, and the verification status as exactly pass, fail or absent — every connected-subscription field sourced **solely** from the browser-safe projection, so no tenant id, client id or secret ciphertext reaches the browser; newest first, 50 per page, with a next-page control while unpresented runs remain
    - `/reports/[runId]`: snapshot provenance with the `snapshot_id` truncated to its leading 12 characters beside a copy control yielding the **complete** digest, the collection window's start and end in the run's timezone with the **resolved UTC offset displayed alongside**, the grain, the resource count and the gap count, with the digest, offset and counts in the monospace face
    - Gap list grouped by `gap_type` with per-group counts naming every affected resource, in **mist neutral tokens rather than `--destructive`**, because a gap is neutral information; a zero-gap run renders an explicit "no gaps recorded" row and **omits no section**, because an absent section is indistinguishable from a list that failed to load. Fidelity badges per resource where tiers differ, with the tooltip explaining what each tier does and does not support, `baseline` in mist neutrals
    - `paper-render.tsx` presents the report as a paper-like rendering from the same AST, resolved from the run's pinned version and `snapshot_id`, holding no layout definition of its own, presenting every figure as the ledger's `formatted` string and composing no numeric of its own — with the permanent preview label and no page number or count, and the presigned `.pdf` presented as the delivered result
    - `figure-provenance.tsx`: pointer hover **or keyboard focus** on a figure reveals, within 200ms and without navigating away, that figure's `snapshot_path` in mono with a copy control, plus the ledger's **estimator label rendered character-for-character** where the value is an estimate — composing no percentile label, displaying no bare percentile designation, and displaying no caveat for a value that is not an estimate. Both paths reveal identical content; the reveal persists while hovered or focused and dismisses on pointer-out, blur or `Escape`; every figure is reachable by sequential keyboard navigation in document order with a visible `--ring`; the revealed content is the figure's **accessible description**, so assistive technology announces provenance with no pointer event; a missing ledger entry reveals "provenance unavailable" and presents the `formatted` string unchanged
    - Every figure in mono with tabular numerals and **no numeral animation and no interpolating transition**, including while the run is in progress — a count-up on a verified figure is decoration presented as data
    - Read terminal state from `report_runs.status`, `error_code` and `error_message` in addition to events, derive it from those three columns alone when no stream is open, and present the **row's** state when the row and the received events disagree, because `TIMEOUT` arrives with no event; a run with no verification result presents those three columns and **no statement that any figure traced to a snapshot**
    - Present the template name, the **pinned** version number and the pinned `definition_sha256` the report was rendered from, showing the pinned number even where a higher-numbered version exists; and present the window's local start and end dates and resolved UTC offset **alongside the period specification the pinned version declared**, so a reader distinguishes the rule from the dates that rule resolved to
    - Render every estimator caveat by displaying the ledger's `formatted` string or its recorded estimator label **verbatim**, composing no label and no percentile designation and applying no locale-dependent numeric formatting to a `value` or a `formatted` string
    - A run that terminated with `EMPTY_SCOPE`, or whose verification recorded `scope_unverified` or `empty_scope`, is presented as **failed** naming the recorded terminal code and the recorded finding, with an **expired client secret** and an **over-narrow role assignment** named as the causes to check, and with no download control and no passing verification
    - Restrict every read of a run, template, version and verification result to the signed-in user's rows, comparing before presenting any field, and resolve a mismatch as not found indistinguishably from an id that exists for no row
    - _Requirements: 4.9, 9.8, 9.9, 18.8, 32.9, 37.1, 37.2, 37.3, 37.4, 37.5, 37.6, 37.7, 37.8, 37.9, 37.10, 38.1, 38.2, 38.3, 38.4, 38.5, 38.6, 38.7, 38.8_

  - [ ] 13.7 Build the verification panel as an audit certificate
    - `verification-panel.tsx` presents the status, the `figure_count` and the three digests, each digest in mono with tabular figures beside a copy control yielding its **complete recorded string**
    - A **pass** presents the status word, the figure count and the snapshot digest as one statement — *1,480 figures · every figure traced to snapshot `9f2c…` · verified* — styled in mist neutrals with no `--destructive` and no assertive alert presentation. Success is quiet
    - A **fail** presents the count of blocking findings and lists **every** one with its declared type and the locating fields the recording criterion declares — AST path, table identity with row and column key, surviving substring with its paragraph location, expected and observed strings verbatim — states plainly that the report was **not delivered**, and applies `--destructive` to that state. Failure is loud and specific
    - The replay outcome presents both digests and the fold count, or presents that **replay was not possible** rather than a pass or a failure; the drift descriptor presents the sample size, the selection method and the seed
    - `finding-list.tsx` presents advisory findings in a **separate labelled region** without `--destructive` and never as a cause of the status; a finding whose type the panel does not recognize is still presented under the classification the result recorded, with its type string and locating fields, and is omitted from neither the lists nor the count
    - `--destructive` appears on the verification-failure state and on hard errors and on **nothing else** — no gap, no advisory finding, no fidelity badge, no utilization value, no negative delta — so the token carries one meaning: *this document could not be proven*
    - Announce the resolved status through an `aria-live="polite"` region, including the blocking count in the same announcement on a fail; derive **every** presented value from the stored `report_verifications` row and none from a received event alone, so a reconnecting client renders the identical panel rather than a subset
    - A run with no verification result, or one whose status is neither pass nor fail, presents that the report is not verified with no pass statement and no digest presented as proven, in mist neutrals, and no download control
    - _Requirements: 39.1, 39.2, 39.3, 39.4, 39.5, 39.6, 39.7, 39.8, 39.9, 39.10_

  - [ ] 13.8 Gate the download, extend the artifact-key predicate, and add Property 12
    - `download-card.tsx` presents exactly one control for the recorded `.docx` key and one for the recorded `.pdf` key **only** while the run's `status` is `completed` and its stored verification status is `pass`, minting each presigned URL server-side **at activation** rather than at surface render, and presenting the control **only once that URL is available** rather than on receipt of a `report_file` event alone
    - On activation, and **before any storage call**, assert the run's owning user id equals the signed-in user's id, the key's actor prefix equals that same id, and the verification status recorded in the store is `pass`; any assertion failing resolves as not found with no URL minted, no storage call and no indication of whether the artifact exists
    - Expiry ≤300 seconds, a fresh URL per activation, **no** URL persisted in any table, event, log line or message and none placed in a cacheable, server-rendered or browser-safe payload; a key not among the run's recorded keys resolves as not found with no storage call and no field disclosed; a failed mint or an absent object states that the artifact is unavailable, changes neither the row nor the verification, and keeps the control available
    - A `fail`, an absent verification or a non-`completed` status presents **no** download control and exposes **no route, action or control** that returns a presigned URL for that run's document; a `report_file` event arriving with no preceding passing `verification` in that stream is **discarded**, presents no control, requests no URL, and surfaces a state saying the stream violated the declared ordering
    - Extend `lib/aws/s3.ts`'s predicate to admit a second segment of exactly `snapshots` or exactly `reports` and reject every other value, keeping the first-segment comparison an **exact, case-sensitive segment equality**, never a prefix, substring or pattern test, and rejecting a key with fewer than the declared segments. `previews` is deliberately **not** admitted here; the preview route mints through a separate function, so the report download path is structurally unable to serve a preview
    - **Property 12: Artifact-key authorization is an exact segment match**
    - **Validates: Requirements 43.2, 43.3, 40.5, 40.6, 45.1**
    - `fast-check` over actor ids drawn from an alphabet including `-`, `_` and `.` with pairs where one id is a proper prefix of another; keys with second segments from `snapshots`, `reports`, `Snapshots`, `previews`, `reports2`, `""`; 1–8 segments, empty segments, leading and trailing slashes. Declared examples: actor `alice` against `alice-evil/reports/r/x`, against `alice/Reports/r/x`, and against `alice/reports`
    - Kills: `key.startsWith(actorId)`, which authorizes `alice-evil/...` for `alice`; `key.startsWith(actorId + "/")`, which still admits any second segment; a case-folding comparison
    - _Requirements: 25.3, 25.4, 40.1, 40.2, 40.3, 40.4, 40.5, 40.6, 40.7, 42.9, 43.2, 43.3, 43.8, 45.1, 45.3, 45.4_

  - [ ] 13.9 Build the in-app charts and the delta table
    - `components/charts/themed-chart.tsx` with `categorical.ts`, `sequential.ts` over `palette.ts`: render a `chart` event **client-side from the structured spec**, parsing each decimal string **for layout geometry only**, taking every displayed value label from the `formatted` value its ledger reference resolves to, and requesting **no image and no presigned URL**
    - Select the palette from the spec's `encoding` and never from the series count; assign colour by stable key so one metric and one resource keep one colour across every chart and the delta table of one report; direct labels on every series, marker and dash on lines, value labels on bars and heatmap cells, nothing distinguished by colour alone; expose the underlying figures as a table as each chart's text alternative
    - `delta-table.tsx` for `comparison_delta`: the categorical palette, **direction glyphs plus a signed magnitude in one colour** rather than hue encoding good or bad, mono tabular numerals, both runs' snapshot ids in the header, and rows whose fidelity tiers differ between runs marked **not comparable** rather than shown as a delta
    - `--destructive` on no series, no delta, no gridline and no utilization band
    - _Requirements: 16.8, 22.7, 22.8, 22.10, 22.11, 22.12, 42.6, 42.10_

  - [ ] 13.10 RTL tests for the composer and the report surfaces
    - Composer: three panes in tab order with no focus trap; palette entries describing what a block **emits**; `Enter` on a palette entry appending, selecting and focusing; the drop indicator as a 2px rule that shifts nothing; a row column refusing a dragged row with a blocked cursor and a visible hint and an unchanged order; the same refusal announced for a keyboard attempt; selection as a `--ring` with no fill; the inherited default rendered above the override; the `aria-live` region announcing exactly once per move; and a boundary nudge announcing first-or-last with no move
    - Report surfaces: the permanent preview label surviving scroll and re-render and offering no dismiss; no page number for any document; the three named divergences in visible text; the provenance reveal on hover **and** on focus with identical content, dismissed by pointer-out, blur and `Escape`, and exposed as an accessible description; `--destructive` absent from the gap list, the fidelity badges, the advisory region and every delta; an unrecognized finding type still presented and counted; a discarded `report_file` arriving without a passing `verification` presenting no control and surfacing the ordering-violation state; and no numeral animating while a run is in progress
    - `pnpm lint`, `pnpm typecheck` and `pnpm test` clean
    - _Requirements: 12.1, 12.2, 12.3, 12.5, 12.8, 12.9, 12.10, 12.11, 12.12, 12.14, 14.2, 14.3, 14.4, 25.4, 37.5, 38.2, 38.4, 38.7, 39.6, 39.10_

- [ ] 14. The mandatory negative tests — every blocking gate observed failing
  - Two preconditions apply to **every** task in this section and are what stop a test passing for
    the wrong reason: the **unmutated fixture is asserted to pass first**, with zero blocking
    findings, before the mutation is applied — without it a broken fixture makes every one of these
    tests pass while proving nothing; and the recorded blocking finding types are asserted **equal**
    to the set that test declares, failing if a blocking finding of an undeclared type is recorded,
    so a test cannot pass by failing for a different reason than the one it is named after.
    Three assertions also apply to every one of them: zero `report_file` events emitted for that
    run, no presigned URL minted for any key of that run, and no route, action or control of the
    web app returning one. None may be skipped or marked as an expected failure.

  - [ ] 14.1 N1 — one digit changed
    - Fixture: a rendered `.docx` from a definition carrying at least one table figure **and** at least one prose figure, with its ledger and anchor set, asserted passing first
    - Mutation: replace exactly **one digit character** of exactly one figure's rendered `formatted` string with a different digit such that the mutated string equals no ledger `formatted` value, leaving the ledger, the anchor set and every other rendered character untouched. Run once for the table figure and once for the prose figure
    - Assert status `fail`; `table_cell_mismatch` naming the table identity, row key, column key and the expected and observed strings verbatim for the table figure; `unmatched_prose_token` naming the surviving mutated substring with its block identifier and paragraph ordinal for the prose figure; `report_runs.status` `failed` with `error_code` `VERIFICATION_FAILED`; and no download control
    - Proves the smallest possible corruption is caught, in **both** the anchored pass and the masking pass
    - _Requirements: 44.2, 44.12, 44.13, 44.14, 44.15_

  - [ ] 14.2 N2 — two table columns transposed
    - Fixture: a rendered `.docx` containing a data table of ≥2 columns and ≥2 data rows whose transposed values differ pairwise, asserted passing first
    - Mutation: swap the cell text of two columns across **every** data row, leaving the ledger unchanged and leaving every transposed value present somewhere in the document
    - Assert status `fail` with one `table_cell_mismatch` per anchor whose resolved cell text changed. **And additionally** assert that a containment check — each ledger `formatted` string appears somewhere in the same document — records **zero** discrepancies
    - That second assertion is the point of the test: it fails against a verifier checking token containment instead of anchored cell equality — the implementation that looks correct and passes a document in which every VM's average and peak are swapped
    - _Requirements: 44.3, 44.12, 44.13, 44.14, 44.15_

  - [ ] 14.3 N3 — a block that rendered zero rows, and its twin that must pass
    - Fixtures: two definitions over one snapshot. **(a)** a data block whose resolved scope contains ≥1 resource. **(b)** a block whose resolved scope contains **zero** resources while every other block of that pinned version renders ≥1 data row. Both asserted passing first
    - Mutation: in (a), emit that block's data table with its `w:tblCaption` identity, **zero data rows** and no no-resources-matched row. (b) is **not mutated** — it is rendered as the compiler emits it
    - Assert (a): status `fail` with `table_rows_absent` naming the table identity, the scope's resource count and the observed row count; `VERIFICATION_FAILED`; no download. Assert (b): status **`pass`**, zero `table_rows_absent`, zero blocking findings, the explicit no-resources-matched row present in the document, and a `report_file` event emitted
    - One test in two halves on purpose: without (b), a verifier could satisfy (a) by failing every empty table, and a legitimately empty scope would become an undeliverable report
    - _Requirements: 44.4, 44.5, 44.12, 44.13, 44.14, 44.15_

  - [ ] 14.4 N4 — a chart data hash mismatch
    - Fixture: a rendered `.docx` containing a chart with its embedded image, its sidecar, its companion data table and its ledger entries, asserted passing first
    - Mutation: alter the chart data hash recorded in the **sidecar** to a value differing from the hash recomputed from the plotted decimal strings in plotted order, leaving those strings, the companion table and the ledger unchanged
    - Assert status `fail` with `chart_hash_mismatch` naming the chart node's AST path, the recomputed hash and the observed hash; `VERIFICATION_FAILED`; no download
    - Proves the recomputation draws nothing from the artifact it checks — a verifier that read the sidecar and compared it to itself would pass this
    - _Requirements: 44.6, 44.12, 44.13, 44.14, 44.15_

  - [ ] 14.5 N5 — a PDF converted under a comma-decimal locale
    - Fixture: a rendered `.docx` whose ledger carries ≥1 figure with a non-zero fractional-digit count, asserted verifying passing first
    - Mutation: convert to `.pdf` with `LANG` set to a locale whose decimal separator is a comma, bypassing the `render/pdf.py` guard that would refuse it, so the conversion **succeeds** and rewrites every numeral
    - Assert status `fail` with `pdf_figure_missing` naming ≥1 ledger entry whose `formatted` string carries a decimal separator together with its AST path and its string; `report_runs.error_code` **`VERIFICATION_FAILED`, not `PDF_CONVERSION_FAILED`**; and no download control
    - The expected code is the subtle part: nothing about the conversion *failed*, so only the fidelity gate can catch it — which is what demonstrates that the pinned `LANG=C.UTF-8` is load-bearing rather than incidental
    - _Requirements: 44.7, 44.12, 44.13, 44.14, 44.15_

  - [ ] 14.6 N6 — an expired secret producing an empty scope
    - Fixture: a run against a connected subscription whose client secret is expired such that the union of the template default and every block `scope_override` resolves to zero resources. **No mutation — the expiry is the condition**
    - Assert a terminal code of `EMPTY_SCOPE` or `AUTH_EXPIRED`; **no snapshot written**, no document compiled, no document rendered, no report artifact written; `report_runs.status` `failed` carrying that code; no download control; and **no verification result carrying a status of pass** for that run
    - That last assertion is the important half. It proves the failure mode most likely to ship a wrong artifact: zero resources → zero figures → zero *unverifiable* figures → a clean pass on every other gate → a fully verified, empty, worthless report
    - _Requirements: 44.8, 44.12, 44.14, 44.15_

  - [ ] 14.7 The remaining blocking finding types, one test each
    - Constructed the same way, with the same two preconditions and the same three assertions:
      `replay_hash_mismatch` — mutate exactly one decimal string of exactly one archived raw response of a stored run, leaving the stored `snapshot_id`, the archive sequence and the object count unchanged, asserting both digests are reported and the run reports `REPLAY_MISMATCH`;
      `ledger_entry_unrendered` — remove exactly one entry's rendered text while that entry remains in the ledger and every other entry remains rendered, asserting the finding names its AST path;
      `scope_unverified` — a snapshot carrying ≥1 resource whose `scope_verified` is false, **additionally asserting no `empty_scope` finding**, so the failure is attributable to the unverified scope rather than to a zero-resource snapshot;
      plus `table_anchor_missing`, `table_anchor_unexpected`, `table_column_unresolved`, `table_row_unresolved`, `duplicate_table_anchor`, `chart_table_missing`, `coverage_resource_absent` and `empty_scope`
    - _Requirements: 44.1, 44.9, 44.10, 44.11, 44.12, 44.13, 44.14, 44.15_

  - [ ] 14.8 The enumeration meta-test over all sixteen blocking types
    - A meta-test enumerating the **sixteen** blocking finding types the glossary declares, collecting the types every negative test declares as expected, and **failing if any declared type is asserted by zero tests** — so a blocking type added in a later change fails the suite rather than being declared and never exercised
    - Assert additionally that no negative test in this section is skipped, marked as an expected failure, or excluded from the suite that runs before a change in this spec is committed, because a gate whose negative test does not run is a gate that has never been observed failing
    - _Requirements: 44.1, 44.12, 44.14, 44.15_

- [ ] 15. Final guards, property hygiene, the regression gate and end-to-end verification
  - [ ] 15.1 Complete the static boundary guards in both halves
    - `agent/tests/test_boundaries.py`, consolidated and asserted complete: the SDK boundary scan covering `compile/`, `render/`, `verify/`, `compare/` and `narrate/` — no module outside `azure/` imports a package whose **first dotted segment** is exactly `azure`; the replay-purity closure walk; no `.paragraphs` / `.tables` on a `python-docx` document under `verify/`; `formatted` assigned in exactly one module with `compile/format.py` the only importer of the quantization helper and no arithmetic on a figure's `value` under `render/` or `verify/`; no Bedrock client outside `narrate/`; and `unicodedata.normalize` on no hash path
    - `app/test/boundaries.static.test.ts`: `lib/templates/store.ts` and `lib/verifications/store.ts` begin with `import "server-only"`; every new streaming or long-running handler exports `runtime = "nodejs"`; the artifact-key predicate admits exactly `snapshots` and `reports`; no component under `components/templates/` renders a document file input and no route accepts a `.docx` body; no import of `docxtpl`-equivalent templating and no arithmetic over a ledger `value` under `components/reports/` — including no `decimal.js` import and no `Number()` over a ledger value, because `app/` computes no figure
    - Assert each guard's own completeness: a scanned directory that is absent or yields zero source files **fails** the guard, so it can never pass by scanning nothing
    - `app/test/migrations.static.test.ts` passes unchanged over this spec's three tables, one column and six appended enum values — which is the point of having written it in the foundation
    - _Requirements: 11.6, 18.1, 18.2, 19.2, 20.2, 26.2, 31.7, 35.5, 43.2, 43.3, 9.10, 41.6_

  - [ ] 15.2 Extend the property-hygiene guards and run the foundation regression gate
    - Extend `app/test/property-hygiene.static.test.ts` and `agent/tests/test_property_hygiene.py` with two assertions each: the **set of properties collected equals the set this spec declares** — Properties 1–7 agent-side under `hypothesis`, Properties 8–12 web-side under `fast-check` — so a property added to the design and never registered, or registered and never run, fails the suite; and each property **records** its framework, its accepted-example count, its precondition rejection fraction and its seed in the suite's own output, so the thresholds are observable rather than assumed
    - Keep the existing assertions in force: no property skipped, none marked as an expected failure, none declaring fewer than 100 runs or examples, none suppressing `HealthCheck.filter_too_much` or `HealthCheck.data_too_large`, none whose generation is exhausted before 100 accepted, and none rejecting more than 20% of generated cases through a precondition; every fixed counterexample retained as an explicitly declared `@example` or case running **in addition to** the 100-case minimum rather than counting toward it
    - **The regression gate**: run the foundation's **Property 1** (count-weighted averaging and exact min/max roll-up) and **Property 6** (local-day bucketing at the `Asia/Jakarta` UTC+07:00 offset) in this spec's suite at ≥100 accepted examples each, with their generators, assertions and declared examples **unmodified** — the compile and verify stages consume the values those two protect, so a regression there produces a document that verifies perfectly against a wrong number, or silently re-attributes every daily figure. If either is absent, does not execute, or fails, fail this spec's suite, report which one, and record no passing result for this requirement
    - _Requirements: 45.1, 45.2, 45.3, 45.4, 45.5, 45.6, 45.7, 45.8, 45.9_

  - [ ] 15.3 Wire and verify one full report run end to end
    - Drive one `generate_report` through the faked Azure ports, the in-memory object store, a real Postgres schema and a real LibreOffice in the built image: enqueue pins `template_version_id` and inserts `queued`; a tick sweeps, claims with `SKIP LOCKED`, gates on subscription state, and invokes; the runtime asserts the theme before any Azure call, collects, passes the union gate, writes the snapshot once, compiles the AST and the ledger, renders `.docx` then `.pdf`, verifies every gate, uploads four artifacts **after** the pass, emits `snapshot_ready` → `verification` → two `report_file` → `done`, and posts each phase transition plus the verification callback; the row advances `collecting → compiling → rendering → verifying → completed` and `completed` is written only with a stored passing verification
    - Assert the ordering contract at the source: `snapshot_ready` before any `verification`; every `report_file` after a `verification` carrying `pass`; nothing after `done`; a step left open by a raising phase closed before `done`; and consecutive events no more than 30 seconds apart through the document phases
    - Assert the delivery gate from the browser's side: exactly two download controls for the `completed` + `pass` run, each minting a fresh short-lived URL at activation, and no route, action or control returning one for a run whose verification is fail or absent
    - Assert no `client_secret`, `progress_token`, `tenant_id` or `client_id` value appears in any event, log line, finding message or persisted row, and that every quoted excerpt in a finding is ≤200 characters
    - Assert the relay reconstructs the compile, render and verify state from the run row plus the stored verification result alone, and that closing it mid-phase changes no outcome
    - Confirm `pnpm lint`, `pnpm typecheck`, `pnpm test` and, in `agent/`, `.venv/bin/pytest` and `.venv/bin/ruff check .` are all clean
    - _Requirements: 25.1, 25.2, 25.9, 41.1, 42.1, 42.3, 42.4, 42.5, 42.12, 42.13, 43.1, 43.7, 40.1, 40.4, 45.6_

- [ ] 16. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Every task in this plan is required. There are no optional tasks, and none is marked `*`: the
  twelve properties, the six negative tests, the nine remaining blocking-type tests, the
  enumeration meta-test and the five static guards all gate completion. This spec's entire claim
  is that a figure in a delivered document can be proven against the snapshot it came from, so a
  gate that has never been observed failing is not a gate, and an unproven verifier is not a
  faster MVP.
- Ordering that is not negotiable, and why:
  - **The four foundation touch-ups come first.** `owner_tags` must leave `storage/s3.py` before
    the replay-purity guard exists, because `collect/snapshot.py` sits on replay's import closure
    and reaches boto3 through that one symbol today. `run_collection(...)` must be extracted
    before the report pipeline can defer the partial-coverage raise. The six error codes must
    exist before any phase can fail with one. `RPT_PROSE_MODEL_ID` must go in the **agent's**
    `.env.example`, never the app's, because a foundation guard asserts that file's key set equals
    the app's own required vars.
  - **Every static guard ships with the code it guards, never after.** The AST numeric-leaf guard
    with `compile/ast.py`; the replay-purity guard with `verify/replay.py`; the Mirror_Guard's
    declaration half with the sentinel declarations and its behavioural half with the shared
    corpus; the Theme_Guard with the four theme documents; each projection's exact-key-set
    assertion in the same task as the projection.
  - **`compile/` before `render/` before `verify/`**, and within compile `snapshot_view.py` →
    `ast.py` + `figures.py` + `format.py` → `scope.py` → `blocks/`. The ledger and the cursor
    ship in one task with the AST because `BlockCursor.figure` is what makes the ledger the render
    context, and splitting them is an invitation to write the parallel walk the design exists to
    forbid.
  - **The theme documents and the image build precede any rendering task**, because LibreOffice,
    the arm64 fonts and the pre-warmed profile are what make `render/pdf.py` exercisable at all,
    and `--assert-build` is what stops an image shipping a theme missing a referenced style.
  - **The negative tests come after the surfaces they assert against**, because each one asserts
    not only a verification failure but the absence of a download control and of any route that
    would mint a URL.
  - The two front-end dependency families are **resolved and pinned in task 1.5**, not assumed:
    the versions are chosen at install time against `react@19.2.4` and `next@16.2.6` and written
    back into `package.json`.
- Each property task names its generator strategy, its concrete bound, and the specific declared
  example that fails the naive implementation it exists to rule out — a per-run tokenizer, a
  containment check, a flattened-index nudge, a UTC-clock period resolver, a float round-trip, a
  `startsWith` key predicate, a replay that returns the stored digest, a selector that ignores its
  seed.
- Deviations from requirements.md, both recorded in the design and implemented as written:
  `report_runs.template_version_id` is nullable with a partial CHECK rather than `NOT NULL`,
  because backfilling foundation-era rows that produced no document would write a false statement
  into the exact rows that exist to be an audit trail; and the Formatter's display scale is
  `max(design decimal places, catalog scale)`, so a template's number format can add zeros and
  cannot truncate a digit the catalog declared significant.
- Out of scope for every task above, and therefore absent by design: chat, Q&A over a report and
  any model tool registry — `agent/.../tools/` is not created and `strands-agents` is not added;
  a standalone run-comparison screen — `comparison_delta` is a block inside a report;
  scheduled runs and email delivery; template sharing, import or export; DynamoDB chat history
  and AI conversation titles; and the `compare_runs` command, which stays declared in the invoke
  contract and unrouted. The event vocabulary gains **no** new type, so the cross-language event
  mirror is untouched.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.4", "1.5", "1.6"] },
    { "id": 1, "tasks": ["1.3", "3.1"] },
    { "id": 2, "tasks": ["2.1", "3.2", "5.1"] },
    { "id": 3, "tasks": ["2.2", "3.3", "3.4", "3.5", "5.3"] },
    { "id": 4, "tasks": ["2.3", "2.4", "3.7", "5.4", "7.1"] },
    { "id": 5, "tasks": ["2.5", "3.6", "5.5", "5.6", "7.2"] },
    { "id": 6, "tasks": ["2.6", "5.2", "5.7", "7.3"] },
    { "id": 7, "tasks": ["5.8", "7.4"] },
    { "id": 8, "tasks": ["5.9", "5.10", "7.5", "7.8"] },
    { "id": 9, "tasks": ["7.6", "7.7", "9.1"] },
    { "id": 10, "tasks": ["9.2", "9.3", "9.9", "9.10"] },
    { "id": 11, "tasks": ["9.4", "9.5", "9.6", "9.7", "9.8", "9.12"] },
    { "id": 12, "tasks": ["9.11"] },
    { "id": 13, "tasks": ["9.13", "11.1", "11.2"] },
    { "id": 14, "tasks": ["11.3", "11.4", "11.5"] },
    { "id": 15, "tasks": ["11.6", "13.1"] },
    { "id": 16, "tasks": ["13.2", "13.3", "13.4", "13.9"] },
    { "id": 17, "tasks": ["13.5", "13.6", "13.7", "13.8"] },
    { "id": 18, "tasks": ["13.10", "14.1", "14.2", "14.3", "14.4", "14.5", "14.6", "14.7"] },
    { "id": 19, "tasks": ["14.8", "15.1", "15.2"] },
    { "id": 20, "tasks": ["15.3"] }
  ]
}
```
