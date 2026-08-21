# Implementation Plan: reporting-agent-breadth-and-document

## Overview

Build in the order the design's own dependencies force: the **six foundation and templates
touch-ups first**, because later work fails without every one of them — `_as_decimal` must
become `collect/numeric.decimal_leaf` before the one-reader guard can pass or replay's import
closure can widen, `GapRecord` must gain `interval_start` before criterion 20.4's contiguity
test has any observable at all, `DECLARED_GAP_TYPES` must reach 24 before a fact gap can be
recorded, `NumberFormat.__post_init__` must reject a whitespace separator before the mirror can
require both halves to reject one set, `REQUIRED_GATES` must reach 11 and `REQUIRED_STYLE_NAMES`
must carry the front-matter styles, and `inventory_query` must take `fact_projections` before a
projected fact exists.

Then the **table-of-contents evaluation**, before any front-matter work depends on a table of
contents existing: the design's risk 1 says so and gives the reason, which is that adopting the
two-pass candidate moves the `rendering` phase budget from 600s to 900s and that edit lands with
the adoption or not at all. The evaluation, the harness, the committed evidence record and its
guard are therefore an early task, and every front-matter task after it **reads**
`ADOPTED_APPROACH` rather than assuming a value.

Then the catalog and its evidence fixtures **before** the facts that reference the fact
declaration, because `facts.v1.json` loads through the same `catalog/loader.py` under the same
`catalog_version` and the Catalog_Evidence_Guard runs in the image build. Then
`collect/numeric.py` and `collect/factfold.py` **before** `azure/facts.py`, because the fold is
the one derivation both collection and replay call: the fold exists first and the collector calls
it, never the reverse. The archive's two new object kinds and replay's fact re-derivation ship
**together with the behavioural seam test**, because the whole argument for one fold is that the
seam is proven by calling it from both sides with a counting wrapper.

Then `compile/ast.py`'s `TextFact` and `TextFactCell` **in the same task as the extended AST
guard**, following the templates spec's precedent that a declaration and the guard over it land
together. Then `compile/messages.py` and the message catalog **before anything that resolves a
string id** — the front matter, the table of contents, the charts, the historical-trend
statements and the gap explanations, which is most of the rest. Then `schema_version` 2 in both
halves with its mirror guard, **before** the front-matter renderer and before the app's
migration, with `test_schema_version_1.py` landing beside it because every shipped starter
compiling as stored is the positive proof criterion 24.17 names as exempt from the enumeration
meta-test. Then front matter, the number format, the charts and the historical trend, whose four
parts go in one order — the app query, the payload field, the pure selector, the verify gate.
Then the app's pure modules before the components that use them, then the report page. Then the
**eighteen negative tests as their own tasks**, each asserting a failure. Then the nine
properties, the six mirrors, the hygiene guards, the regression gate and one end-to-end run.

The spec ends when a `schema_version` 2 template covering seven resource types runs against a
subscription, collects facts beside statistics, compiles a document that opens with a cover, a
document control page and either a page-number-correct table of contents or none at all, renders
every fixed string in the template's declared language with the declared number separators,
plots a historical trend from prior verified runs, passes a verification whose three new gates
have each been observed failing, and presents a grouped gap list and a verification panel that
fit a 360-pixel viewport.

Everything the two completed specs deliver is referenced and rebuilt nowhere. No task re-runs
`shadcn init`, regenerates `app/components.json`, or replaces, reorders or reformats any existing
token value in `app/app/globals.css` — the only edits to that file are **appended** `rpt-` rules.
No task adds an SSE event type, so `agent/.../events.py` and `app/lib/events.ts` are not edited
and `app/test/event-mirror.static.test.ts` is untouched. No task adds an environment variable, so
`app/.env.example` and `agent/.env.example` are unchanged and the Boundary_Guard's key-set
equality assertion continues to hold with no edit. No task drops a Postgres table, column or
enum value; `app/test/migrations.static.test.ts` passes unchanged. No task creates a migration
path in the agent, no task adds a `.docx` upload, and no task introduces a template language.

## Tasks

- [ ] 1. The six foundation and templates touch-ups
  - Each is additive, none changes behaviour for an existing input, and every one is required by
    a gate or a surface a later task adds. Every sub-task leaves `.venv/bin/pytest` and
    `.venv/bin/ruff check .` clean in `agent/`, and `pnpm lint` + `pnpm typecheck` + `pnpm test`
    clean in `app/` where it touches the web half.

  - [x] 1.1 Move `_as_decimal` to `collect/numeric.py::decimal_leaf` and add the one-reader guard
    - Create `agent/src/reporting_agent/collect/numeric.py` holding `decimal_leaf` — `azure/metrics.py`'s `_as_decimal` (line 287) moved **verbatim, docstring included**, keeping the paragraph that records the month the archive was write-only because the reader refused a `str`, and keeping its acceptance of an `int`, a `float`, a `Decimal` and a decimal **string** with `None` for a string that does not parse
    - In `azure/metrics.py`, re-export as `_as_decimal = decimal_leaf` so its four call sites (lines 540, 541, 558, 559) and every existing test in `tests/test_azure_metrics.py` are untouched
    - Extend `agent/tests/test_boundaries.py` with the **one-numeric-leaf-reader** static guard: no module under `collect/`, `azure/` or `verify/` other than `collect/numeric.py` may construct a `Decimal` from a value read out of a response mapping, asserted by an `ast` walk; and the scan **fails if it finds zero source files**, so it can never pass by scanning nothing
    - This is a prerequisite rather than a tidy-up: `verify/replay.py`'s transitive first-party closure widens to `collect/factfold.py` in task 4.4, which imports this module, and the guard of task 16.1 asserts that closure reaches no `azure.*`, `boto3`, `httpx` or `storage.s3`
    - _Requirements: 7.7, 7.9_

  - [ ] 1.2 `GapRecord` gains `interval_start`, end to end through both halves
    - `agent/.../providers/base.py`: add `interval_start: str | None` to the `GapRecord` `TypedDict` (line 155), documented the way `metric` is — `None` is the honest answer for a gap that is not about an interval
    - `agent/.../collect/log.py`: `record_gap(gap_type, resource_id, metric, message, interval_start=None)` accepting it and rejecting an **empty string** exactly as it already rejects an empty `metric` (line 194), so there is one validation style and not two
    - `agent/.../collect/snapshot.py`: emit `interval_start` in a gap object **when present and omit it when `None`**, following the omit-when-absent convention that module already documents, so every existing snapshot digest stays byte-identical — assert that with a fixture comparison rather than asserting it in prose
    - `agent/.../azure/metrics.py`: populate it at the two interval-level call sites, `interval_counts_missing` and `interval_malformed`, which are the 512-entry shape a live run produced
    - `app/lib/runs/gaps.ts`: `RunGap` gains `intervalStart: string | null` and `snapshotGapSchema` gains `interval_start: z.string().min(1).nullable().catch(null)`, matching the `.catch(null)` reasoning already recorded there for `metric` — the app reads a document a newer or an older agent wrote
    - Without this criterion 20.4 and Property 4.6 have no observable at all: contiguity is a statement about interval starts
    - _Requirements: 20.4_

  - [ ] 1.3 `DECLARED_GAP_TYPES` from 20 to 24, and a `source` field on the four new types
    - `agent/.../collect/log.py`: add `GAP_TYPE_BACKUP_NOT_CONFIGURED`, `GAP_TYPE_NO_RESERVATIONS`, `GAP_TYPE_REPLICATION_NOT_ENABLED` and `GAP_TYPE_FACT_UNAVAILABLE` as four more `Final[str]` constants beside the existing twenty, add all four to `__all__` and to `DECLARED_GAP_TYPES`, and raise the `assert len(DECLARED_GAP_TYPES) == 20` at line 137 to `== 24`
    - `record_gap` gains `source: str | None = None`, rejecting an empty string, and `collect/snapshot.py` emits `source` on a gap **when present and omits it when `None`** — present on every gap of the four new types, absent on the twenty existing ones, so no existing snapshot digest changes
    - Update the module comment at line 68 that reads "20 values" so the count in the prose and the count in the assertion cannot disagree
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.10_

  - [x] 1.4 `NumberFormat` rejects a whitespace separator, in both halves
    - `agent/.../compile/format.py`: extend `NumberFormat.__post_init__`'s separator loop (line 162) with the whitespace clause beside the existing digit-and-minus-sign clause at line 171 and the existing equality clause, raising `CompileFailedError` naming the offending field
    - Update that class's docstring, which today records the divergence that "the definition schema declares only those first two fields" — task 7.1 closes that divergence, so the comment must say the separators are supplied by the definition at `schema_version` 2 and defaulted from the language at `schema_version` 1
    - The mirror is why this is a touch-up and not part of task 7: `app/lib/templates/definition.ts` must reject the identical set, and Property 2.7 generates the rejections against both
    - _Requirements: 16.2_

  - [x] 1.5 `REQUIRED_GATES` from 8 to 11, and the front-matter theme styles
    - `agent/.../verify/verifier.py`: add `"facts"`, `"toc"` and `"historical"` to `REQUIRED_GATES` (line 73) with their requirement numbers in the comment column, so a gate wired into this spec and not into `verify()` fails **every** verification naming itself rather than silently narrowing the gate
    - `agent/.../render/themes.py`: add `Cover Title`, `Cover Meta`, `Document Control` and `Toc Entry` to `REQUIRED_PARAGRAPH_STYLES` and `Table Signature` to `REQUIRED_TABLE_STYLES`, so `REQUIRED_STYLE_NAMES` grows by five; add each to `_STYLE_IDS` so the two asserts at lines 1102–1105 still hold, and rebuild all four `agent/themes/*.docx` through `write_theme_documents` so a theme missing a referenced style is a **build** failure rather than an unstyled delivered page
    - The three gates are stubbed to return an empty finding tuple in this task and are wired to real passes in tasks 5.5, 8.3 and 11.4; `REQUIRED_GATES` is raised here because a partially wired verifier must fail loudly during the intervening tasks rather than quietly pass
    - `agent/tests/test_themes.py` and `tests/test_verify_verifier.py` extended in the same task, and `tests/test_image_build.py`'s `--assert-build` path still passes
    - _Requirements: 6.4, 13.5, 13.6, 14.6, 18.11_

  - [ ] 1.6 `inventory_query` takes `fact_projections`, and `discover` archives each page
    - `agent/.../azure/clients.py`: `inventory_query(resource_types, *, subscription_id, fact_projections: Sequence[tuple[str, str]])` appending one `fact_<key> = <projection>` term per pair to the existing `project` clause (line 328), ordered by key so two runs build one identical query, under `FACT_FIELD_PREFIX: Final[str] = "fact_"` so a fact key can never collide with `id`, `name`, `type`, `location`, `resourceGroup`, `tags`, `sku` or `powerState`
    - `agent/.../azure/inventory.py`: `discover(...)` hands each Resource Graph page to the `ArchiveWriter` as it arrives, because a projected fact makes the inventory response a **fact-producing response** and criterion 7.1 requires it archived in the pass that folds it
    - `agent/.../collect/archive.py`: add the `kind` dispatch field and the `"inventory"` object shape — `schema_version`, `kind`, `sequence`, `source`, `request_target`, `page_index`, `skip_token_present`, `received_at`, `catalog_version`, `raw_response` — dispatching on the **declared `kind` field** rather than on the shape of the body, so an existing metric object carrying no `kind` still means `metrics` and no committed object changes
    - Every existing caller passes `fact_projections=()` until task 3.5 supplies the declaration; assert `tests/test_azure_inventory.py` and `tests/test_collect_archive.py` pass with the empty tuple producing the query byte-identical to today's
    - _Requirements: 4.7, 7.1, 7.2_

- [ ] 2. The table-of-contents evaluation, before anything depends on a TOC existing
  - The design's risk 1 makes this the second task for a reason: adopting the two-pass candidate
    moves the `rendering` phase budget, and that edit lands with the adoption or not at all.
    No task after this one assumes a table of contents exists — each reads `ADOPTED_APPROACH`.

  - [ ] 2.1 Declare the setting and the candidate set in `render/toc.py`
    - Create `agent/src/reporting_agent/render/toc.py` declaring `TOC_APPROACH_LIBREOFFICE_INDEX`, `TOC_APPROACH_TWO_PASS`, `TOC_APPROACH_CONVERSION_MACRO`, `TOC_APPROACH_NONE`, the `TOC_APPROACHES` tuple over exactly those four, and `ADOPTED_APPROACH: Final[str] = TOC_APPROACH_NONE`
    - A **module constant, not an environment variable**, and the docstring must say why: a table of contents whose correctness was proven in the image build must not be switchable at run time by a deployment that never ran the proof. `.env.example` gains nothing in this task or any other
    - Nothing else in the codebase may declare a TOC approach string; extend `tests/test_boundaries.py` to fail on any of the four literals appearing outside this module
    - _Requirements: 14.10_

  - [ ] 2.2 Build the fixture, `verify/tokens.pdf_page_texts` and the one measurement harness
    - `agent/tests/fixtures/toc/long_report.definition.json` and `long_report.snapshot.json`: a compiled report of **at least 8 pages carrying at least 6 section headings distributed across at least 4 pages**, produced by the same `compile → render/docx.py → render/pdf.py` path a delivered report uses — no hand-built document anywhere
    - `agent/.../verify/tokens.py`: add `pdf_page_texts(path) -> tuple[str, ...]` beside the existing `read_pdf_text` and `normalize_pdf_text`, returning per-page text so a heading can be located to a page
    - `agent/tests/toc_harness.py`: `TocMeasurement(docx_bytes, pdf_bytes, pdf_sha256, observed_pages, named_pages)` and `async def measure(definition, snapshot, *, approach)`, rendering through `render/docx.py`, converting through `render/pdf.py` and reading pages through `pdf_page_texts`. `observed_pages` takes the page carrying a heading's **first rendered character**, so a heading spanning a page boundary resolves to exactly one page
    - One function used by both the evaluation and the proof test, so neither can measure something the other does not
    - _Requirements: 14.2, 14.11_

  - [ ] 2.3 Run the three candidates and commit the evaluation record
    - Evaluate in order A, B, C — cheapest first: **A** inserts a `TOC \o "1-3" \h \z \u` field with **no cached result** and leaves the `render/pdf.py` conversion filter unchanged; **B** emits the TOC section at full size with no numbers, converts, measures, then re-emits with the measured numbers as literal text and converts again; **C** invokes a Basic macro through `soffice`'s scripting URL calling `updateIndexes()` before export
    - Commit `agent/evidence/toc/evaluation.json` and `agent/evidence/toc/<candidate>/{named,observed}.json`: `schema_version`, the `fixture` block carrying its path, `pages`, `headings` and `distinct_heading_pages`, the `soffice --version` string from the image, and one entry per candidate carrying `verdict` from `{correct, incorrect, unavailable}`, `evaluated_at`, `docx_sha256`, `pdf_sha256`, `named_pages`, `observed_pages` and a `note`
    - **All three verdicts are recorded regardless of which is adopted**, because criterion 14.1 asks for the record and not for the winner. Reject A if the PDF carries the field's cached text or names any other page, or if it works only with a filter option needing a profile beyond the pre-warmed one; reject B if any heading's observed page differs between its two passes, because then there is no fixed point; reject C if it needs a writable macro library, a scripting-enabled profile the image does not build, or a **second** `soffice` invocation contending on the one pre-warmed profile
    - Set `ADOPTED_APPROACH` to the first candidate whose verdict is `correct`, or leave it `TOC_APPROACH_NONE`. If it stays `none` the document is cover → document control → content, `front_matter.toc` is retained in the definition exactly as criterion 13.9 retains a disabled cover, and `verification.counts.toc_entries_checked` is `0`
    - _Requirements: 14.1, 14.3_

  - [ ] 2.4 The evidence guard and the proof test that never skips
    - `agent/tests/test_toc_evidence.py`: the record names **exactly** the three candidates and no more; every candidate carries a verdict from the declared set; a `correct` verdict's `named_pages` equals its own `observed_pages`, because a `correct` verdict that disagrees with its own numbers is the recollection criterion 14.1 refuses; `ADOPTED_APPROACH` is `none` or a candidate whose verdict is `correct`; and the fixture the record names is the fixture the proof test uses, compared **by path and by content digest**
    - `agent/tests/test_toc_proof.py` reading `ADOPTED_APPROACH`: an adopted candidate ⇒ `measure(...)` over the fixture, `named_pages == observed_pages` for every heading, `pages >= 8`, `headings >= 6`, `distinct_heading_pages >= 4`; `none` ⇒ the produced `.docx` carries no TOC section, no `w:fldChar` of type `TOC`, and no page-number position anywhere in the front matter
    - Neither branch is `skipif`, `xfail` or a bare `pass`, so there is no configuration in which nothing executes. Extend `agent/tests/test_property_hygiene.py`'s scan to fail on a skip or expected-failure marker **in this module by name**, which is how criterion 14.2's "SHALL fail IF that test is absent, is skipped or is marked as an expected failure" becomes an assertion rather than a convention
    - _Requirements: 14.2, 14.10_

  - [ ] 2.5 If and only if `two_pass_measure` is adopted, move the rendering budget
    - `app/lib/runs/state.ts`: raise `PHASE_DEADLINE_SECONDS.rendering` from `600` to `900`, because B doubles the LibreOffice conversion and each conversion is bounded at 300s
    - Add the integration assertion that the two conversions are **serialized**, because they contend on the single pre-warmed profile in the image
    - Only pass 2's `.docx` and `.pdf` are artifacts; pass 1's are held in memory and never written, so `docx_sha256` and `pdf_sha256` name pass 2's bytes and the templates spec's fidelity gate is unaffected — assert that no object exists at any pass-1 key
    - Skip this sub-task entirely if the adopted approach is `libreoffice_index_update`, `conversion_macro` or `none`, and record in the commit message which verdict made it unnecessary
    - _Requirements: 14.2_

- [ ] 3. The catalog: seven resource types, its evidence, and the fact declaration
  - [x] 3.1 Record one Metric Definitions fixture per resource type
    - `agent/tests/fixtures/metric_definitions/<type>.json`, exactly one recorded `MonitorManagementClient.metric_definitions.list` response per declared resource type, capturing each metric's name, its unit and its supported aggregations
    - Each fixture records its subscription-independent provenance beside it: the resource type, the region, and the capture instant as a UTC RFC 3339 instant with a `Z` designator and whole-second precision
    - **Exclude every subscription identifier, tenant identifier, fully qualified resource identifier and credential value** from every fixture — the guard of task 3.3 asserts that exclusion rather than trusting it
    - Seven files: `Microsoft.Compute/virtualMachines`, `Microsoft.Sql/servers/databases`, `Microsoft.Sql/managedInstances`, `Microsoft.DBforPostgreSQL/flexibleServers`, `Microsoft.Storage/storageAccounts`, `Microsoft.Compute/disks`, `Microsoft.Web/sites`
    - _Requirements: 2.1, 2.5_

  - [ ] 3.2 Extend `catalog/metrics.v1.json` to the seven resource types
    - Add six entries beside the existing `Microsoft.Compute/virtualMachines` one, each declaring that type's `metric_namespace` and at least one metric, and each metric declaring the name, unit, unit family, requested aggregations and fractional-digit count the foundation's criterion 32.1 requires
    - Every metric for which an average is emitted requests **both `Total` and `Count`** among its aggregations, drawn from `DECLARED_AGGREGATIONS` in `catalog/loader.py`, because that average is the sum of totals over the sum of counts and a metric requesting neither cannot produce one
    - Raise `catalog_version` from `"1.0.0"` to `"1.1.0"` — one version covering both catalog files, compared component-wise as dotted decimal integers; `collect/snapshot.py` already records it on every snapshot and needs no edit
    - Derive every metric name, unit and aggregation from that type's fixture from task 3.1 rather than from portal display names, which differ from API metric names by exactly the case, whitespace and separator substitutions the near-miss rule of task 3.3 rejects
    - _Requirements: 1.1, 1.2, 1.3, 1.9_

  - [ ] 3.3 Implement `catalog/evidence.py` and the Catalog_Evidence_Guard
    - `agent/src/reporting_agent/catalog/evidence.py` holding the guard function, **imported** by `agent/tests/test_catalog_evidence.py` so Property 5 of task 3.4 tests the implementation rather than the test
    - Declare the unit mapping associating each unit name a fixture reports (`Percent`, `Bytes`, `BytesPerSecond`, `CountPerSecond`, `Count`, `Seconds`, `Unspecified`) with exactly one term of `DECLARED_UNITS` in `catalog/loader.py`, because the Metric Definitions API reports its own vocabulary and comparing the two as equal strings would fail every correct entry; a reported unit the mapping has no term for **fails** naming the type, the metric and the unit
    - For every metric every entry declares: the name present in that type's fixture compared as **exact strings**; the catalog's unit equal to the mapping's term for the fixture's unit; every requested aggregation among the fixture's supported set, compared as exact strings. A resource type with no fixture fails naming the type
    - The **near-miss rule**: after case folding, trimming leading and trailing whitespace, and replacing each space, underscore, hyphen, forward slash and period with one sentinel character, equal normalized forms with unequal exact strings **fail**, naming the type, the declared name and the fixture name
    - A fixture carrying a subscription id, tenant id, fully qualified resource id or credential-shaped value fails naming the fixture and the field
    - Invoke the guard from `agent/Dockerfile` beside `--assert-build`, because `.dockerignore` excludes `tests/` and a guard that only ran in the suite could not stop an image carrying a catalog entry contradicted by the evidence committed beside it; extend `tests/test_image_build.py` to assert that invocation is present
    - _Requirements: 1.6, 2.2, 2.3, 2.4, 2.6, 2.7, 2.9, 2.10, 2.11_

  - [ ] 3.4 Property test — every catalog entry is evidenced
    - **Property 5: Every catalog entry is evidenced**, identifier `catalog_evidence`
    - **Validates: Requirements 1.6, 2.2, 2.3, 2.4, 2.7, 2.9, 2.10**
    - `hypothesis` over `catalog/evidence.py`'s guard function: fixtures of 1–7 resource types × 1–30 metrics with units from the Metric Definitions vocabulary and 1–4 supported aggregations each; entries drawn from those fixtures then mutated by {none, rename, case-fold, pad with whitespace, substitute a separator, change the unit, add an unsupported aggregation, remove the fixture}
    - Assert a faithful entry is accepted; each of the three disagreements is rejected naming the type, the metric and the disagreeing field; every near-miss form is rejected; a missing fixture is rejected naming the type; and the verdict is identical on every call for one pair of catalog and fixture set
    - Declared examples: `Percentage Cpu`, ` Percentage CPU`, `Percentage_CPU` and `Percentage-CPU` against a fixture's `Percentage CPU`, each asserting **rejection**; and a fixture unit of `BytesPerSecond` asserting the mapping's `count_per_second` term is **not** substituted for `bytes`
    - Kills: a guard comparing metric names case-insensitively, which accepts `Percentage Cpu`; one comparing only names and not units, which accepts a metric declared in the wrong unit family and therefore sketched into the wrong structure; one comparing the catalog's unit to the fixture's unit as equal strings, which fails every correct entry; one that passes when a fixture is missing, which makes the whole guard vacuous for a newly added type
    - _Requirements: 1.6, 2.2, 2.3, 2.4, 2.7, 2.9, 2.10, 25.1, 25.3, 25.4, 25.5, 25.8, 25.10_

  - [ ] 3.5 Declare the facts in `catalog/facts.v1.json` and load them through `catalog/loader.py`
    - `agent/src/reporting_agent/catalog/facts.v1.json`: a `resource_types` map, one `facts` list per declared type, each entry carrying `key`, `value_kind`, `source`, `projectable`, plus `projection` **iff** projectable, `absent_gap_type` **iff not** projectable, and `unit` for a `numeric` fact alone. **No `catalog_version` key of its own** — declaring one is itself a validation failure, so the two files cannot be raised apart
    - `catalog/loader.py`: `DECLARED_FACT_UNITS = {"bytes", "count", "percent", "days"}` — deliberately **not** `DECLARED_UNITS`, because a metric's unit selects a sketch and a fact is never sketched — plus `DECLARED_FACT_SOURCES`, `DECLARED_FACT_VALUE_KINDS`, `DECLARED_ABSENT_GAP_TYPES`, `DEFAULT_FACTS_PATH`, the frozen `FactDeclarationEntry` and `FactDeclaration` with `for_resource_type` (case-folded, matching `LoadedCatalog.for_resource_type`, because Resource Graph lowercases `type` in its response body), `projectable()` and `by_source(source)`
    - `load_catalog(path=None, *, facts_path=None)` keeps its signature for existing callers; `LoadedCatalog` gains `facts: FactDeclaration`. Per-entry validation degrades rather than raises exactly as a metric entry does: `key` 1–120 characters matching `^[a-z][a-z0-9_]*$`, no repeated key within one type, and a failing entry becomes one more `InvalidEntry` carrying `gap_type` `catalog_entry_invalid` with the run continuing
    - Widen the whole-catalog gate by one term: zero valid metric, derived, enhanced **and fact** entries across every resource type in scope is `CATALOG_UNUSABLE`, no snapshot object and no `snapshot_ready`
    - `compile/format.py`'s `UNIT_PRESENTATION` gains the suffixes for `count`, `days` and any fact unit it lacks, so a numeric fact's `formatted` string comes out of the one formatting path with no special case
    - Wire task 1.6's `fact_projections` to `declaration.projectable()` at the `collect/pipeline.py` call site, ordered by key
    - _Requirements: 1.4, 1.7, 1.8, 4.7, 4.11_

- [ ] 4. The one fold, the fact collector, the archive and replay
  - [ ] 4.1 Implement `collect/factfold.py` — the one derivation
    - `agent/src/reporting_agent/collect/factfold.py`: `fold_fact_response(body, *, kind, source, resource_ids, declaration, resource_types, received_at) -> tuple[tuple[FactRecord, ...], tuple[GapRecord, ...]]`, **pure** — no clock, no network, no object store, with `received_at` **supplied**
    - `kind` selects the reader: `"inventory"` walks `data` rows for `fact_<key>` columns, `"facts"` walks the source's own item list. Every numeric leaf goes through `collect/numeric.decimal_leaf`, so a value that does not parse classifies as **absent** and records `fact_unavailable` rather than raising mid-fold
    - `projected_facts_from_row(row, *, declaration, received_at)`: the loop is over the declaration for **that row's resource type**, which is what makes criterion 5.9 structural — a key the type does not declare is never visited, so it can produce neither a fact nor a gap, and no storage account collects a `no_reservations` gap
    - One gap per absent `(resource, key)` pair: where the response answered successfully and named nothing, record that key's `absent_gap_type` and record **no** `fact_unavailable` for the same key, so the displayed count is the count of absences and not twice it
    - Record no `Fact` whose `value` is the empty string, and none for a key the response carried no value for
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.8, 5.9, 5.10, 7.7, 7.8, 7.11_

  - [ ] 4.2 `collect/snapshot.py` — `FactEntry` and `facts[]` inside the canonical form
    - `FactEntry(key, value, value_kind, source, collected_at, formatted, unit=None)` frozen with `sort_key` returning `key`; `NUMERIC_FACT_GRAMMAR = re.compile(r"^-?[0-9]+(\.[0-9]+)?$")` **anchored end to end** — no exponent, no grouping separator, no leading plus, no surrounding whitespace
    - `__post_init__` refuses an absent or undeclared `source`, an absent `collected_at`, an absent or undeclared `value_kind`, and a `numeric` value the grammar does not match, naming the resource id and the key and writing **no snapshot object**
    - `ResourceSnapshot` gains `facts: tuple[FactEntry, ...]` and `to_plain_data` emits `"facts": [...]` **always, including as an empty array**, ordered by `key` ascending in Unicode code-point order, **inside** the RFC 8785 canonical form the `content_hash` is computed over. Every `value` is a JSON **string**, including a numeric fact's
    - `build_snapshot` refuses two facts for one resource sharing a key, and refuses a `collected_at` outside `[invocation_started_at, snapshot_written_at]`, naming the resource id and the key in both cases. That lower bound is the design's **narrowing** of criterion 4.13: the runtime cannot observe `claimed_at` because the invoke `context` is closed at twelve fields with a guard, and the invocation instant is `>= claimed_at`, so the bound is strictly tighter and rejects no correct run — record that in the docstring
    - Record a `Fact` for a resource whose statistics are absent, including one carrying a `deallocated` or `permission_denied` gap, so a stopped resource still contributes its configuration
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.10, 4.11, 4.12, 4.13_

  - [ ] 4.3 Implement `azure/facts.py` and the fact pass between inventory and metrics
    - `agent/.../azure/ports.py`: `FactsPort` protocol with `list_backup_protected_items(subscription_id)`, `list_replication_protected_items(vault_id)` and `list_reservations()`, so the whole Azure surface is fakeable and the entire fact suite runs without a subscription
    - `agent/.../azure/clients.py`: the three ARM ports behind it — Backup as one paged `backupProtectedItems` list filtered `backupManagementType eq 'AzureIaasVM'`, Site Recovery as one `replicationProtectedItems` list **per Recovery Services vault** taken from the inventory the run already has, Reservations as `reservationOrders` then `reservations` per order. **One subscription-scoped list per source, never one request per resource**: three to six requests for a subscription of any size
    - `agent/src/reporting_agent/azure/facts.py`: `MAX_FACT_KEY_LENGTH = 120`, `MAX_FACT_VALUE_LENGTH = 512`, the plain-data `FactRecord`, and `FactCollector(port, archive, *, declaration, semaphore, clock)` whose `collect(*, resources, inventory_pages)` takes projected facts from the pages the caller already has and the rest from the three sources, through the **same semaphore keyed by subscription id** `azure/metrics.py` uses so the cap of 8 in flight is honoured
    - Run the pass **between inventory and metrics** in `collect/pipeline.py`, so the semaphore is uncontended and the pass costs seconds rather than extending the critical path of an 8-to-12 minute run
    - `agent/tests/test_facts_reservations.py` asserting **both** branches from the two response shapes: a rejected `Microsoft.Capacity` request is `fact_unavailable` naming the source, and a successful response covering a resource no reservation covers is `no_reservations`. Reader at subscription scope does not grant `Microsoft.Capacity/reservationOrders/read`, so the rejection is the common case, and collapsing the two would print "no reservations" on a document for a subscription that has plenty
    - Contain no code path that converts a fact-collection failure into a value, and extend `tests/test_boundaries.py` with the guard that no module from a fact response to the Snapshot_Builder declares an `except` handler whose body neither records a typed gap nor re-raises
    - _Requirements: 4.8, 4.9, 5.4, 5.6, 5.7, 7.6_

  - [ ] 4.4 The `facts` archive kind and replay's fact re-derivation
    - `collect/archive.py`: the `"facts"` object kind — `schema_version`, `kind`, `sequence`, `source`, `request_target`, `resource_ids`, `received_at`, `catalog_version`, `raw_response` — written **during the same pass that folds** the response and **completing before the next fact-producing request is issued**, which is observable as the call order a recording object-store double records rather than as an intention in a comment
    - `verify/replay.py`: `_fold_object` dispatches on `kind` — `"metrics"` or absent is today's path unchanged; `"facts"` and `"inventory"` call `fold_fact_response` with `received_at` taken **from the archived object**, because a `collected_at` stamped at the replay instant enters the canonical form and produces `REPLAY_MISMATCH` on every run however correct the collection was
    - Re-derived facts enter the recomputed snapshot in the canonical order of task 4.2 and the digest is compared byte for byte; a fact folded with no archived object produces a differing digest and `replay_hash_mismatch`; an absent, undecompressable or unparseable object is the **advisory** `archive_incomplete` naming the sequence ordinal with replay recorded as not possible and no exception mid-fold
    - `value_kind`, `unit` and `formatted` are **derived on replay** from the archived `catalog_version`'s declaration rather than stored, because storing them would put a value in the archive that the declaration also carries and the two could disagree; `formatted` is recomputed through `compile/format.py`
    - Replay continues to take each resource's inventory **record** from `ReplayPlan` built from the stored snapshot — it proves the fact derivation and the aggregation, not the inventory query, which is the boundary it already has for metrics. Deriving the facts from the plan instead would be reading a fact out of the snapshot and putting it back
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.10, 7.11, 7.12_

  - [ ] 4.5 The behavioural seam test and the two static guards over it
    - `agent/tests/test_fact_reader_seam.py`: install a **counting wrapper** over `collect.numeric.decimal_leaf` and assert a live collection pass **and** a replay both route every numeric fact through it, with equal counts. This is the lesson `tech.md` records as "an injected seam is an untested seam" — a static assertion that both modules import the symbol would pass against a module that imported it and then parsed inline
    - Extend `tests/test_boundaries.py`: neither `collect/factfold.py` nor `verify/replay.py` may contain the tokens `datetime.now`, `time.time` or `utcnow`; and `verify/replay.py`'s transitive first-party import closure — now including `collect/factfold.py`, `collect/numeric.py` and `catalog/loader.py` — reaches no `azure.*`, `boto3`, `httpx` or `storage.s3`
    - Extend the SDK boundary scan to cover `collect/factfold.py` and `collect/numeric.py`, and assert the scan fails on a directory that yields zero source files
    - _Requirements: 7.7, 7.9, 7.11_

  - [ ] 4.6 Property test — a fact round-trips through the archive
    - **Property 1: A fact round-trips through the archive**, identifier `facts_archive_round_trip`, in `agent/tests/property/test_facts_property.py`
    - **Validates: Requirements 4.1, 4.5, 4.6, 4.11, 4.12, 7.3, 7.7, 7.8, 7.11**
    - `hypothesis` over 1–40 resources across 1–7 declared types; 0–12 facts each drawn from that type's declaration, keys including a pair differing only by case and one non-ASCII key; text values including `Succeeded`, `Standard_D4s_v3`, `10.0.0.0/16` and a 512-character value; **numeric values as `Decimal` carrying at least one non-zero fractional digit**; 1–8 archived objects per source across the `inventory` and `facts` kinds; mutations from {none, alter one value, drop one object, corrupt one object's gzip, replace one value with an unparseable string}
    - Assert the recomputed digest equals the original; `int`/`float`/`Decimal`/`str` of one value all yield one equal `Decimal`; **any** single-value mutation differs; a fold counter shows each object folded exactly once and a network double fails the property on any attempted call; an unparseable string classifies as absent with a typed gap and no exception mid-fold; every fact `value` in the canonical form is a JSON **string** with no number token; the fact array is ordered by key ascending; a duplicate key raises; and `received_at` is read from the object rather than a clock
    - Declared examples: the numeric values `0.1`, `462.81`, `0.30000000000000004` and one carrying 17 significant digits; a storage account whose declaration names no reservation key, asserting **zero** reservation gaps; a resource with zero facts, asserting `"facts": []` rather than an absent key
    - Kills: a reader accepting `int`, `float` and `Decimal` but not a decimal `str`, which classifies every archived fact as absent and produces `REPLAY_MISMATCH` on every subscription whose facts carry a fractional value; a fixture using whole numbers only, which passes against that same reader because a whole number stays a JSON integer through the archive; a collection path that folds a fact and writes no archive object; a replay that stamps `collected_at` at the replay instant; an ordering that inherits the response's key order
    - _Requirements: 4.1, 4.5, 4.6, 4.11, 4.12, 7.3, 7.7, 7.8, 7.11, 25.1, 25.3, 25.4, 25.5, 25.8, 25.10_

- [ ] 5. `TextFact` in the AST, the ledger, the anchors and the verifier
  - [ ] 5.1 Declare `TextFact`, `TextFactCell` and the extended fields, with the AST guard in the same task
    - `agent/.../compile/ast.py`: `TextFact(path, key, value, snapshot_path, source, collected_at, formatted)` frozen with slots, declaring **no field admitting an `int`, a `float`, a `Decimal` or a `DecimalString`**, immutable after construction through a `__setattr__` override, with `__post_init__` requiring every field non-empty, `FIGURE_PATH_PATTERN` on `path`, `formatted == value` character for character, and a `_assert_provenance_resolves` re-resolving `snapshot_path` against the installed resolver's text side with the same three failures `Figure` distinguishes
    - `TextFactCell(path, fact)` mirroring `FigureCell`, refusing a non-`TextFact` `fact`, and `type Cell = FigureCell | TextCell | EmptyCell | TextFactCell`. `TextFactCell.fact` is the **only** field annotated `TextFact` and `TextFactCell` is a member of `Cell` and of nothing else, so "every `TextFact` position admits the `TextFact` node type alone" is a type declaration and "only into a data-table cell" is a consequence of union membership rather than a run-time rule
    - `Figure` gains `source_run_id: str | None = None` and `source_snapshot_sha256: str | None = None`, with `__post_init__` asserting that a `snapshot_path` under `/prior_runs/<id>` carries a matching `source_run_id` and that a `source_run_id` is accompanied by a `source_snapshot_sha256`. Both `str | None`, so the numeric-annotation scan is unaffected
    - `Chart` gains `x_axis_label_id: str`, `y_axis_label_id: str` and `period_label: str` — three `str` fields, no numeric field. `compiling_against` is extended to install a resolver exposing both `resolve_all` and `resolve_text_all`, so `SnapshotView` grows one method and the context variable's protocol grows one member
    - **In the same task**, extend `agent/tests/test_ast_guard.py`: `TEXT_FACT_ADMITTING_ANNOTATIONS = frozenset({"TextFact"})`, `_EXPECTED_UNION_MEMBERS` carrying `("Cell", ("FigureCell", "TextCell", "EmptyCell", "TextFactCell"))`, and `REQUIRED_NODE_NAMES` gaining `"TextFact"` and `"TextFactCell"`. `NUMERIC_ANNOTATION_NAMES` is **unchanged and `TextFact` is not exempted from it**, which is the point: a future edit adding a `count: int` to `TextFact` fails the guard. The existing guard-the-guard cases need no change
    - _Requirements: 6.2, 6.3, 6.8, 17.1, 18.9_

  - [ ] 5.2 `compile/figures.py` — two dictionaries, one walk, byte-identical serialization
    - `FigureLedger` gains `_text_facts: dict[FigurePath, TextFact]` and `_text_fact_anchors: dict[FigurePath, TableAnchor]` beside `_entries`, `_anchors` and `_tables` — **two dictionaries rather than one dictionary of a union**, because masking stage 1 must not see the text facts and `formatted_values()` reading `_entries` is what makes that exclusion structural rather than a filter at every call site. Assert the key sets are **disjoint**, so "one ledger keyed by AST path" is still true of the pair
    - `insert_text_fact` mirroring `insert`, `record_text_fact_anchor` mirroring `record_anchor`, the `text_facts` and `text_fact_anchors` mappings, and `entry_paths()` returning every ledger entry path of both kinds in document order — read by the completeness assertion and by nothing else
    - `BlockCursor.text_fact(fact_value: FactTextValue) -> TextFact` as the **only** factory, mirroring `.figure(...)` deliberately so the ledger entry is created during the traversal that creates the node and there is no `build_text_fact_ledger(ast)` anywhere
    - `walk_figures` becomes `walk_ledger_nodes` yielding `(ordinals, Figure | TextFact)` with `walk_figures` retained as a filtering wrapper so existing callers and the foundation's tests are untouched; `assert_ledger_matches_tree` compares against `entry_paths()`
    - `serialize()` gains `text_facts` and `text_fact_anchors` keys **omitted when empty**, following the omit-when-`None` convention `_figure_to_plain` already documents. Add a guard test asserting a document with no text facts serializes **byte-identically** to today and every committed `ledger_sha256` fixture is unchanged — "additive" is a claim about bytes here, not a description
    - _Requirements: 6.2, 6.9, 6.10, 18.9_

  - [ ] 5.3 `compile/format.py::format_text_fact`, and the guard that formatting cannot translate
    - `format_text_fact(value: str, *, at: str) -> str` returning `value` character for character: no case folding, no truncation, no separator substitution, and **no resolution against the Message_Catalog**. A function rather than an inline pass-through so `formatted` is still assigned in exactly one module and the existing single-formatting-path guard covers both entry kinds
    - `Succeeded` therefore reaches an Indonesian document as the string the API returned, because a fact's value is collected data and not fixed copy
    - Extend `tests/test_boundaries.py`: `compile/format.py` neither imports `compile/messages.py` nor names any string id, so the module that produces every `formatted` string **structurally cannot** translate one
    - _Requirements: 6.12, 6.13_

  - [ ] 5.4 One anchor mechanism, one run per cell, and the HTML attributes
    - `agent/.../render/anchors.py`: `_LEDGER_BEARING_CELLS = (FigureCell, TextFactCell)` and `record_cell_anchor(ledger, node, row, cell, *, column_key)` building the triple `{table_id(node.path), row.key, column_key}` **once** and routing it by the cell's type to `record_anchor` or `record_text_fact_anchor`, so a change to how an anchor is formed cannot apply to one kind and not the other
    - `render/docx.py` emits a `TextFact` as **exactly one run in exactly one paragraph** of that cell, in the theme's `Figure` character style — the same style a figure takes, because what the style marks is "this text is a checked value" and it is what lets the token extractor find it without re-parsing prose
    - `render/html.py` emits a fact's `source` and `collected_at` as attributes of the emitted element, so the provenance reveal presents a fact's source and instant as it presents a figure's `snapshot_path`
    - A `TextFact` reaching `write_layout_table` records **no** anchor, because a layout table writes no `w:tblCaption` — that path stays reachable on purpose and is what negative test 15.11 drives
    - _Requirements: 6.4, 6.9, 8.4_

  - [ ] 5.5 Implement `verify/facts.py` and wire the `facts` gate
    - `agent/src/reporting_agent/verify/facts.py`: `TextFactPass(findings, entries_checked, entries_resolved)` and `check_text_facts(ledger, grids) -> TextFactPass`, reading the ledger's `text_facts` and `text_fact_anchors` and the `.docx` grids and **not** the figure entries — `verify/pdf.py` does not read the text-fact entries either, so the two passes have disjoint inputs
    - `text_fact_mismatch` where an anchor resolves to exactly one cell whose runs concatenated in document order **with no character inserted between runs** differ from `formatted` — no trimming, no whitespace normalization, no case folding, no re-parsing of either string — naming the table identity, the row key, the column key, the fact key and both strings verbatim; `text_fact_anchor_missing` where an anchor **was** recorded and resolves to no cell; `text_fact_unanchored` where a `TextFact` entry has **no anchor recorded at all**
    - `verify/findings.py`: add the seven blocking types this spec declares, taking `BLOCKING_FINDING_TYPES` to **twenty-three** — `text_fact_mismatch`, `text_fact_anchor_missing`, `text_fact_unanchored`, `historical_point_unverified`, `historical_point_overlapping`, `toc_page_mismatch`, `fact_source_missing` — each with `SEVERITY_BLOCKING`
    - `verify/verifier.py`: wire the `"facts"` gate from task 1.5 to `check_text_facts`; add `text_fact_count` to the verification result as a field **distinct from `figure_count`**, counted in neither `figure_count` nor the unused-figure warning count; and have the bidirectional completeness assertion read `entry_paths()`, so an unrendered `TextFact` is `ledger_entry_unrendered` exactly as an unrendered figure is
    - `verify/masking.py`: unchanged in mechanism, and assert it — the exclusion of every `TextFact` string is a consequence of `formatted_values()` reading `_entries`, so add the test that a document whose only ledger entries are text facts produces an empty `ledger_strings` set
    - Raise `COMPILE_FAILED` with `fact_source_missing` naming the resource id and the key where a `Fact` reaches the compiler with no `source` or no `collected_at`, writing no report artifact
    - _Requirements: 6.1, 6.5, 6.6, 6.7, 6.10, 6.11, 6.15_

  - [ ] 5.6 Property test — a text fact's check catches what numeric masking cannot
    - **Property 6: A text fact's check catches what numeric masking cannot**, identifier `text_fact_exact_string`, in `agent/tests/property/test_text_fact_property.py`
    - **Validates: Requirements 6.2, 6.4, 6.5, 6.6, 6.8, 6.10, 6.13**
    - `hypothesis` over 1–60 text facts per document across 1–8 data tables, values 1–512 characters from three pools — digit-free words, identifier-shaped tokens matching `[A-Za-z_][\w.\-]*[0-9][\w.\-]*`, and dotted or slashed addresses; mutations from {none, one character substituted, one deleted, one inserted, the whole value replaced, the rendered text removed, the table's caption altered}; and documents including one text fact emitted through the layout-table path
    - Assert: unmutated ⇒ zero findings; any single-character mutation ⇒ `text_fact_mismatch` naming the anchor and both strings verbatim; a **digit-free** value's mutation ⇒ **zero** `unmatched_prose_token`; an identifier-shaped value's mutation ⇒ zero `unmatched_prose_token` **and** a `text_fact_mismatch`, because masking stage 2 consumes that token as an identifier; an unanchored text fact ⇒ `text_fact_unanchored`; removed rendered text ⇒ `ledger_entry_unrendered`; `formatted == value` character for character across every generated value and both languages; and `text_fact_count` disjoint from `figure_count`
    - Declared examples: `Succeeded`, `Failed`, `Standard_D4s_v3`, `10.0.0.4`, `Windows Server 2022`, `10.0.0.0/16`, and the mutation `Succeeded` → `Failed`
    - Kills: an implementation routing text facts through numeric masking, which records **nothing** for `Succeeded` becoming `Failed` because that token carries no digit and is never extracted; one routing them through masking stage 1 as a `formatted` value, which masks the mutated token by accident and reports a clean pass; one emitting text facts as plain `TextCell` content, which is not a ledger entry and therefore not checked at all; a formatter that resolves a text fact's value against the message catalog
    - _Requirements: 6.2, 6.4, 6.5, 6.6, 6.8, 6.10, 6.13, 25.1, 25.3, 25.4, 25.5, 25.8, 25.10_

- [ ] 6. The message catalog and `identity.language`
  - Everything after this task resolves a string id: the front matter, the table of contents, the
    charts, the historical-trend statements and the gap explanations. It therefore lands before
    all of them.

  - [ ] 6.1 Declare the agent's catalog and `compile/messages.py`
    - `agent/src/reporting_agent/messages/__init__.py` and `messages/catalog.v1.json`: `schema_version` plus a `messages` map from string id to `{ "en": …, "id": … }`, covering the block labels, the table headers, the methodology appendix, the gap explanations, the verification record and the front matter, with a value declared for **every** id in **both** languages
    - The id namespace is `^(doc|chart|ui)\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` — a closed prefix set, lowercase ASCII, dotted. `doc.` and `chart.` ids are resolved by the agent and `ui.` by the app, but **both halves declare every id**, because the id sets must be equal and the interface has to present an archived run's fixed copy in its pinned language
    - `agent/src/reporting_agent/compile/messages.py`: `MissingMessageError(RenderFailedError)` and the frozen `Messages(language, _table)` with `text(string_id) -> str` returning the declared value or raising `RENDER_FAILED` naming the id **and** the language — never a fallback to the other language, which is the failure this exists to prevent
    - `compile/blocks/base.py`: `BlockContext` gains `messages: Messages`, keeping the no-client, no-clock, no-network discipline that dataclass already documents
    - `agent/tests/test_messages.py` asserting the `en` id set equals the `id` id set and naming every id present in one and absent from the other
    - _Requirements: 15.2, 15.4, 15.5_

  - [ ] 6.2 Declare the app's catalog and extend the Mirror_Guard
    - `app/lib/messages/catalog.ts` declaring the identical map **between sentinel comments**, following the same mechanism as the event vocabulary and the block types rather than inventing a third: no guard needs a parser, and the app does not import the agent's JSON across the monorepo path
    - `app/test/message-catalog.static.test.ts`: the **id sets** are equal, naming every id present in one half and absent from the other, and — more strongly — the **values** for every shared id are equal, because a diverging value would put different copy in the document and the interface
    - Add `ui.template.untitled_placeholder` in this task, because task 12.7's template list presents it where `report_templates.name` is absent or empty
    - _Requirements: 15.2, 15.5, 15.10_

  - [ ] 6.3 Resolve every fixed string from the catalog, in the four places the literals actually are
    - `agent/.../compile/blocks/base.py`: `EMPTY_SCOPE_TEXT` (line 178) and `NO_DATA_TEXT` (line 179) become string ids resolved through `context.messages`, and every `Column(header=…)` and `Table(caption=…)` across `compile/blocks/*` resolves its own id — the catalog is resolved **at compile time and the AST carries resolved strings**, because these strings have a compile-time node to carry them
    - `render/front_matter.py`, `render/toc.py` and `render/charts.py` resolve their own chrome directly, because their strings have no compile-time node
    - `narrate/summary.py` instructs the narrator **in Indonesian** where the pinned definition's `identity.language` is `id`, supplying the narrator the context the templates spec permits and nothing further
    - `verify/allowlist.py`: `derive_allowlist` renders the pinned template with a null context resolving every string id in **that pinned definition's declared language, and in that language alone**, so Indonesian template chrome is admitted rather than surviving the masking stages as an unmatched token and English chrome is **not** admitted into an `id` document
    - Resolve every id in the run's **pinned** template version's language, applying no later edit of the template's language to an archived run; a pinned `schema_version` 1 version carries no `identity.language`, so resolve in `en` and report no error code for that absent field
    - _Requirements: 15.3, 15.7, 15.8, 15.11, 15.12_

  - [ ] 6.4 The Python literal guard, and the guard that guards itself
    - `agent/tests/test_message_literals.py` walking each module with the standard `ast` module: a **declared** set of text-emitting sites as `(callable_name, parameter)` pairs — `(Text, "text")`, `(TextCell, "text")`, `(Column, "header")`, `(Table, "caption")`, `(Series, "label")`, `(Chart, "title")`, plus `(add_paragraph, 0)`, `(add_run, 0)` and an assignment to `.text` on a `python-docx` run. `(Paragraph, "style")` is **excluded**: a Word style id is not copy
    - Every `str` `ast.Constant` at a declared site, or assigned to a module-level `Final[str]` whose name matches `_(TEXT|LABEL|HEADER|CAPTION|NOTICE|TITLE)$`, must be a declared string id — or `""`
    - Excluded: element names, attribute names, class names, `data-` values; **Word style names**; and a `TextFact`'s `formatted`, which is collected data
    - Scanned: `agent/.../render/**` **and** `agent/.../compile/blocks/**`. That extension is the design's recorded **narrowing** of criterion 15.6 and it is additive: scanning only the stated set would leave `EMPTY_SCOPE_TEXT` and every `Column(header=…)` untouched by the guard that exists to catch them — record that in the module docstring
    - **The guard guards itself**: additionally assert that every dataclass in `compile/ast.py` carrying a `str` field named `text`, `header`, `caption`, `label` or `title` appears in the declared emitting set, so a new emitting site added without registering it fails the suite
    - Invoke it from `agent/Dockerfile` beside `--assert-build`, because `.dockerignore` excludes `tests/` and a guard that only ran in the suite could not stop an image carrying English copy in an Indonesian document
    - _Requirements: 15.2, 15.6_

  - [ ] 6.5 The TypeScript literal guard
    - `app/test/message-literals.static.test.ts` using the `typescript` package's own `ts.createSourceFile` — already a dev dependency since `pnpm typecheck` runs `tsc`, so no new dependency — over `app/components/reports/**`, parsed with position info so `getText` works
    - Flag every `ts.JsxText` node with non-whitespace content; every string literal inside a `ts.JsxExpression` that is a **child** rather than an attribute value; and every string literal assigned to `aria-label`, `title`, `alt` or `placeholder` — those **are** user-facing copy, so this is deliberately stricter than criterion 15.6's "excluding attribute names"
    - Do not flag `className`, `data-*`, element or attribute names. An offender is any flagged literal that is not a declared string id
    - Record in the module docstring what neither guard can do: a literal reaching a text position through a variable defined in another module escapes both. It is a lint with a closure property, not a proof — the closure being that within the scanned modules the catalog resolver is the only way to obtain a string for those positions, and that task 6.4's self-guard stops the declared site set from silently shrinking
    - _Requirements: 15.6, 15.9_

- [ ] 7. `schema_version` 2 in both halves, without rewriting an immutable row
  - [ ] 7.1 Declare the version-conditional key sets in `app/lib/templates/definition.ts`
    - Between `// --- BEGIN SCHEMA VERSIONS ---` / `// --- END SCHEMA VERSIONS ---` sentinels: `MIN_SCHEMA_VERSION = 1`, `MAX_SUPPORTED_SCHEMA_VERSION = 2`, and the per-version records `REQUIRED_TOP_LEVEL_KEYS`, `NUMBER_FORMAT_KEYS`, `IDENTITY_KEYS`, `REQUIRED_IDENTITY_KEYS`, plus `LANGUAGES = ["en", "id"]`, `FRONT_MATTER_KEYS = ["cover", "document_control", "toc"]` and `FRONT_MATTER_FORBIDDEN_BLOCK_TYPES = ["cover"]`
    - **Declared as data, not as two validators**: `validateDefinition` reads the record for the resolved version, so no branch is written twice and the Mirror_Guard stays a set comparison
    - Behaviour that follows with no new rule: a v1 definition carrying `front_matter` is rejected as an **undeclared key** by the existing strict check; a v2 definition placing a `cover` block in `blocks` is rejected naming the block id; `document_control` and `toc` are **not** block types and never were, so there is nothing to forbid for them; and `cover` **stays** a block type, because a stored v1 definition carrying one must compile and `app/lib/templates/starters.ts` alone carries five
    - `identity.language` required at v2, constrained case-sensitively to `en` or `id`, rejecting every other value including an absent one; absent at v1
    - `design.number_format` permits two keys at v1 and four at v2, extending the `allowedKeys` that today permits exactly `decimal_places` and `group_thousands`. The character constraints apply to the **resolved** pair after the language-derived defaults — exactly one character, not a digit, not a minus sign, **not whitespace**, and the two not equal — mirroring the `NumberFormat.__post_init__` clauses of task 1.4
    - Language-derived defaults: `id` → decimal `,` grouping `.`; `en` → decimal `.` grouping `,`. A **declared** value is persisted unchanged with no default applied to it
    - `historical_trend` is declared in `app/lib/templates/blocks.ts` in task 11.3; this task declares the version key sets alone
    - _Requirements: 13.1, 13.2, 13.10, 13.13, 15.1, 16.1, 16.2, 16.3_

  - [ ] 7.2 Mirror the declarations in `agent/.../compile/definition.py` and dispatch on the version
    - The identical declarations between matching sentinels, and `validate_definition(raw)` resolving `version = _schema_version(raw)` once and then reading `REQUIRED_TOP_LEVEL_KEYS[version]`, `NUMBER_FORMAT_KEYS[version]`, `IDENTITY_KEYS[version]` and `REQUIRED_IDENTITY_KEYS[version]` — one dispatch, in one place
    - Declare the `front_matter` section's fields and bounds: the cover's logo, contact block and subtitle; the document control's `document_name`, `document_number_pattern`, `confidentiality_notice_id`, `distribution` and four-role `approvers` list; and `toc`'s `enabled` and `max_level`. A v2 definition omitting `front_matter`, carrying an undeclared `front_matter` key, or violating one of those bounds is rejected naming **every** failing field path with no version row persisted
    - Constrain the document-number pattern to 1–120 characters of literal characters and the closed placeholder set `{template}`, `{year}`, `{month}`, `{run}`; reject a pattern naming an undeclared placeholder, and reject one naming no placeholder whose value differs between two runs of one template and one resolved period
    - In the compiler proper: a v1 definition compiles its `cover` block through `compile/blocks/structure.compile_cover` exactly as today; a v2 definition compiles no `cover` block and `render/front_matter.py` emits the cover from `front_matter.cover` instead. The two paths meet at the same `Paragraph` and `Table` nodes, so there is one renderer and one set of theme styles
    - **No migration in the agent, and none is needed.** A stored v1 row is compiled as v1 for as long as it exists, which is what makes an archived report reproducible from its pinned version; a migration here would mean a two-year-old report rendered through today's reading of its definition
    - _Requirements: 13.1, 13.2, 13.10, 13.11, 13.13, 13.16, 15.1, 16.1_

  - [ ] 7.3 Extend the Mirror_Guard and the shared fixture corpus
    - `app/test/mirror.static.test.ts`: extend the sentinel extraction to `MIN_SCHEMA_VERSION`, `MAX_SUPPORTED_SCHEMA_VERSION`, `REQUIRED_TOP_LEVEL_KEYS`, `NUMBER_FORMAT_KEYS`, `IDENTITY_KEYS`, `REQUIRED_IDENTITY_KEYS`, `LANGUAGES`, `FRONT_MATTER_KEYS` and `FRONT_MATTER_FORBIDDEN_BLOCK_TYPES`, failing naming every differing key
    - `agent/tests/fixtures/definitions/` gains `schema_version` 1 and 2 cases — **accepted and rejected** — run through both the `Template_Validator` and the `Block_Compiler` with matching verdicts and matching offender paths, which is the Mirror_Guard's behavioural half
    - `app/test/event-mirror.static.test.ts` is **not** touched: no event type is added, so the cross-language event vocabulary is unchanged
    - _Requirements: 13.10, 15.10_

  - [ ] 7.4 Prove every shipped starter compiles as stored
    - `agent/tests/test_schema_version_1.py` compiling **every** definition in `app/lib/templates/starters.ts` **as stored** — five `cover` blocks in the `blocks` list, exactly two `number_format` keys, no `identity.language` — and asserting a rendered document, a passing verification, every string id resolved in `en`, and the separators resolved to `.` and `,`
    - This is the **positive** outcome criterion 24.17 names as exempt from the enumeration meta-test: it is proven by a compile test rather than by a gate that can fail, so the exemption is declared in task 15.16 and justified here
    - Assert no stored version row is written, updated or rewritten by this path — raising the schema version rewrites nothing
    - _Requirements: 13.11, 15.12, 16.10, 24.17_

  - [ ] 7.5 Implement `app/lib/templates/migrate.ts` and the save that writes v2
    - `toSchemaVersion2(definition)`, **pure**: lift a v1 `cover` block's config into `front_matter.cover`, remove that block from `blocks`, set `identity.language` to `en`, resolve the two separators from `en`, and set `schema_version` to `2`. Takes no store and performs no write
    - The wizard applies it when **opening** a v1 draft; the **save** writes a new `report_template_versions` row declaring v2 carrying the `front_matter` section and applies **no** write to the existing version row, leaving every report pinned to that earlier version rendering exactly as delivered
    - Migration is app-only and one-directional. That asymmetry with the agent is the design, not an omission
    - _Requirements: 13.12_

  - [ ] 7.6 Property test — the number-format defaults are language-derived and never overwrite a declaration
    - **Property 9: The number-format defaults are language-derived and never overwrite a declaration**, identifier `number_format_defaults`, in `app/test/property/number-format-defaults.property.test.ts`
    - **Validates: Requirements 16.2, 16.3, 16.10**
    - `fast-check` over `schema_version` 1 and 2 definitions; languages `en`, `id` and absent; separators present on neither, one or both fields; declared separators including ones equal to the language default and ones deliberately different
    - Assert every absent field resolves to its language default; every declared field is byte-identical after validation; a `schema_version` 1 definition is accepted with exactly two `number_format` keys and resolves the `en` defaults; and the character constraints are checked **after** the defaults are applied
    - Kills: a resolver applying a default over a declared value, which silently rewrites a consultant's choice; one applying the `en` defaults to an `id` definition, which is the failure requirement 16 exists to close; one validating the constraints **before** the defaults, which accepts a definition whose resolved pair is equal
    - _Requirements: 16.2, 16.3, 16.10, 25.1, 25.3, 25.4, 25.5, 25.8, 25.10_

- [ ] 8. Front matter, the table of contents and the per-run values
  - [ ] 8.1 Implement `render/front_matter.py`
    - `emit_front_matter(document, *, front_matter, run, messages, cursor, ledger)` emitting **cover, then document control, then the table of contents, in that order, before every content block**. Not composable, not reorderable, no block accepted inside it
    - The cover carries the logo, the report title, the customer name, the period and the contact block. Where the definition's cover-page flag is false, emit **no cover content and no leading blank page**, retain the cover configuration in the definition, and emit the document control page and the table of contents unchanged — disabling the cover does not disable the front matter
    - The document control page carries the document title, the customer, the document name, the document number, the approvers table, the revision history table, the distribution list and the confidentiality notice, every fixed string resolved by id through `messages`
    - The approvers table emits one row per role — author, quality control, reviewer, customer — each with company, name and signature cell. A supplied signature image goes in that role's signature cell; where none is supplied, emit an **empty ruled signature box** at the height the theme declares, and emphatically **not** that role's typed name, because a typed name in a signature position presents an approval nobody gave
    - `document_number(pattern, *, run)` applying the closed placeholder grammar of task 7.2, emitting an **identical** number on the cover and the document control page and resolving an identical number on every render of one run; two runs of one template and one resolved period resolve the **same** number and are distinguished by the revision history row, because a re-run of one period is a revision of one document rather than a second document
    - A per-run value that is absent is `RENDER_FAILED` **naming that value**, with no report artifact and **no substituted placeholder** in its position: a cover carrying invented copy is a document that cannot be signed
    - Add `agent/tests/test_document_number.py` asserting two renders of one run resolve one identical number and that the two-runs-one-period case is distinguished as criterion 13.16 declares — criterion 25.9 declares this a test rather than a property
    - _Requirements: 13.4, 13.5, 13.6, 13.8, 13.9, 13.15, 13.16, 15.3, 25.9_

  - [ ] 8.2 Build the table of contents from the adopted approach, and verify its page numbers
    - `render/toc.py`: emit a table of contents **only** where `ADOPTED_APPROACH` names a candidate the evaluation recorded `correct`; where it is `none`, emit **no table of contents at all** and no page-number position anywhere. Emit no entry whose page number the builder did not determine, and no placeholder page number, no zero and no instruction to the reader in a page-number position
    - One entry per heading block at levels 1 through 3 and none deeper, in document order, each naming that heading's text and the page carrying that heading's **first rendered character**
    - `render/html.py` emits the table of contents as a **list of headings carrying no page number and no page count**, because the HTML emitter determines no pagination
    - `agent/src/reporting_agent/verify/toc.py`: read the produced `.pdf` — the one whose SHA-256 equals the recorded `pdf_sha256`, never an independently rendered document — through `verify/tokens.pdf_page_texts`, locate each heading's first character, and record `toc_page_mismatch` naming the heading text, the page named and the page observed on a disagreement. Wire it as the `"toc"` gate from task 1.5
    - The gate returns `proven_toc_numerals: Mapping[int, frozenset[str]]` **keyed by paragraph ordinal**, and runs **before** the prose gate; `masking.scan_paragraphs` takes it as an additive keyword defaulting to `{}` and admits a numeral **only in the paragraph whose comparison produced it**. That is the design's recorded **narrowing** of criterion 14.9's stated mechanism: an allowlist entry admits its string anywhere in the document, so a stray `7` in prose would pass and criterion 14.12 would be unimplementable. A numeral in a page-number position the Toc_Verifier compared to nothing stays `unmatched_prose_token` — record the narrowing in the module docstring
    - _Requirements: 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.11, 14.12_

  - [ ] 8.3 The two additive Postgres columns, the enqueue rejection and the two extended projections
    - `app/lib/db/schema.ts`: `ALTER TABLE report_runs ADD COLUMN customer_name text` and `ADD COLUMN revision_history_row jsonb`, both **nullable**, generated with drizzle-kit and never hand-edited. Nullable for the reason `template_version_id` records: a run pinned to a `schema_version` 1 version legitimately carries neither, and `NOT NULL` would require writing a value into rows that never had one
    - The invariant is enforced at the boundary rather than by a CHECK — a CHECK constrained on the pinned version's schema version would need a join a CHECK cannot perform. `app/lib/runs/input.ts` gains `MAX_CUSTOMER_NAME_LENGTH = 200`, `MAX_REVISION_NOTE_LENGTH = 500`, the strict `revisionHistoryRowSchema` over `revision`/`note`/`author`, and `customerName` and `revisionHistoryRow` as **optional** in `runCreateInputSchema`; `lib/actions/runs.ts` **rejects** a request pinning a v2 version and carrying either absent, naming every absent value and **inserting no `report_runs` row**. Optional in the schema and required in the action, because the version is resolved at insert and the schema cannot know it yet
    - `app/lib/db/views.ts`: `RunView` gains `customerName: string | null` and `revisionHistoryRow: RevisionHistoryRowView | null`, taking its key count from seventeen to **nineteen**; `VerificationView` gains `textFactCount: number` and `historicalPoints: readonly { runId: string; snapshotSha256: string }[]`, taking it from twelve to **fourteen**
    - **In the same task**, update the Projection_Guard's **exact sorted key set** assertions in `app/lib/db/views.test.ts` for both projections, keeping the serialization assertion unchanged in mechanism: distinct non-empty fixture values for `progress_token_hash`, `claimed_by`, `dedupe_key`, the client-secret ciphertext and the unmasked subscription id, none of which may appear
    - `report_verifications` gains **no column**: `text_fact_count` and the historical points travel inside the existing `counts` and `findings` jsonb and the verification artifact, which is where every other per-pass count already lives — six columns holding six counts could drift from the artifact and one jsonb read from one artifact cannot
    - `app/test/migrations.static.test.ts` passes unchanged: nothing is dropped, no column changes type or nullability, and no enum value is added
    - _Requirements: 13.7, 13.14, 6.15, 19.9_

  - [ ] 8.4 Build the fixed front-matter section of the builder
    - `app/components/templates/front-matter-form.tsx`: the cover, document-control and table-of-contents configuration as a **fixed section** the canvas shows above the content, never a reorderable item
    - `components/templates/block-palette.tsx`: the palette's first entry is a **content** block, and there is **no palette entry** for the cover, the document control page or the table of contents
    - Present the signature slots as per-role uploads with the explicit statement that an unsupplied signature renders a ruled box and never the typed name; present the document-number pattern with its closed placeholder set enumerated, and validate it on the step rather than at save
    - Where `ADOPTED_APPROACH` is `none`, present the table-of-contents configuration as **retained and not emitted** rather than hiding it, so a later adoption needs no edit to a stored definition
    - _Requirements: 13.1, 13.2, 13.3, 13.9, 13.16_

- [ ] 9. The declared number format, end to end through render and verify
  - [ ] 9.1 Supply the declared separators to the Formatter and the fidelity gate
    - `agent/.../compile/format.py`: build `NumberFormat` from the **pinned** definition's `design.number_format`, so this task supplies the declared values rather than introducing the capability — the structure already accepts both separators and defaults them to `.` and `,`
    - Grouping: where `group_thousands` is true, insert the declared `grouping_separator` between each group of three digits of the integer part counted **rightward from the decimal separator**, insert none where that integer part carries three digits or fewer, and insert none in the fractional part; where it is false, insert none
    - `agent/.../verify/pdf.py`: bound a located occurrence with the two separators the **pinned** definition declares — the module already reads both from the number format rather than assuming a period — and count an occurrence written with any other separator as **no** located occurrence for that ledger entry, so `pdf_figure_missing` is recorded per entry whose declared-format string has none
    - Treat a comma decimal separator as **correct** where the pinned definition declares a comma and a period as **incorrect** in that same case: the check is a comparison against the declaration and never an assumption about which character a decimal separator is
    - Re-verification reads the `number_format` from the run's **pinned** template version rather than the template's current definition, so a later edit of a separator leaves an archived report verifying exactly as delivered
    - `render/charts.py` and `app/components/reports/*` emit every numeral from a ledger entry's `formatted` string **verbatim**, applying no locale-dependent formatting of their own
    - _Requirements: 16.4, 16.5, 16.6, 16.7, 16.8, 16.11, 16.12_

  - [ ] 9.2 Present the separators in the design step, and property-test the agreement
    - `app/components/templates/step-design.tsx`: present the declared separators as controls and a **sample figure formatted in the declared format**, so a consultant sees `462,81 GB` before a run rather than after one
    - **Property 2: Formatting and verification agree on the declared format**, identifier `number_format_agreement`, in `agent/tests/property/test_number_format_property.py`
    - **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.11**
    - `hypothesis` over `Decimal` values with 0–9 fractional digits from 0 to 10¹⁵ including negatives and exact zero; declared formats over decimal places 0–3 × grouping on/off × a decimal separator from `.` `,` `’` × a grouping separator from `,` `.` ` ` `’`; languages `en` and `id`; and rejected formats where the two are equal, one is empty, or one contains a digit, a minus sign or whitespace
    - Assert: located under the same format; `pdf_figure_missing` in **both** directions across a differing decimal separator; the `formatted` string contains the declared separators and neither separator of any other format; identical output per (value, format, language) triple; a `float` guard on the path raises; every rejected format is rejected naming the field; and grouping is inserted rightward in the integer part and never in the fractional part
    - Declared examples: the format pairs `{decimal ".", grouping ","}` and `{decimal ",", grouping "."}` and the values `0.58`, `462.81`, `1234567.5`, so `0,58%` and `462,81 GB` are covered as **correct outputs** rather than as failures; plus a `schema_version` 1 definition asserting the `en` defaults resolve to `.` and `,`
    - Kills: a verifier that treats a period as the decimal separator, which fails every correct Indonesian document; one that treats any separator as acceptable, which passes a document disagreeing with its own declaration and thereby fails to detect a real corruption; a formatter that hard-codes either separator; a validator that rejects a whitespace separator on one side of the mirror and not the other
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.9, 16.11, 25.1, 25.3, 25.4, 25.5, 25.8, 25.10_

- [ ] 10. Chart appearance, without touching verification
  - [ ] 10.1 Extend `render/charts.py` and keep the hash input closed
    - Axis titles and units for every plotted axis resolved from the Message_Catalog and the Metric_Catalog, emitting **no** axis carrying neither a title nor a unit; gridlines from the `--border` and `--muted-foreground` tokens, never competing with a plotted mark; a legend naming every series where a chart carries more than one, **in addition to** the direct label every series already carries; a chart title; and the period as the run's resolved local start and end dates with the resolved UTC offset shown
    - `label_indices(points) -> frozenset[int]`, **pure and total**: 24 or fewer points ⇒ every one; otherwise exactly four — first, last, series maximum, series minimum — selecting the **earlier point by period start** where two carry one equal extreme. Every emitted label is that point's ledger entry `formatted` string **verbatim**
    - The companion data table records **every** plotted point whether or not it carries a direct label, so thinning removes a label and never a figure — and the table is what the anchored pass checks, so a thinned label costs no verification coverage
    - `chart_data_hash(node)` is unchanged and its docstring is extended to enumerate what is **absent** from its input: each contribution is `(series.key, point.x, point.y.value)` — the ledger's decimal string, not its `formatted` string, not its label, colour, marker, axis title, legend, period, or whether the point carries a label. Appearance is absent by construction, which is why "appearance changes and verification does not" is a fact about this function's signature
    - Titles in the theme's heading face, every numeral in its monospace face with tabular figures, the accent colour from the pinned design settings; palette from the chart node's declared `encoding` and never from the series count; categorical colour by stable key; `--destructive` on no series, no delta, no gridline and no band
    - An absent axis-title string id or an absent unit for a plotted axis is `RENDER_FAILED` naming the axis, the string id and the metric, with no report artifact — an untitled unitless axis is a refusal rather than a blank label
    - Assert byte-identical image content across two renders of one chart node against one style preset: `render/chartstyle.py`'s frozen `rcParams`, its explicitly named in-image font and its suppressed PNG metadata cover the new elements, and none of them derives from a clock, a locale, an environment value or a hash-ordered container
    - `period_label` comes from the Formatter, and the `Docx_Renderer`, the `Html_Emitter` and the `Report_Detail_View` present that **identical** string for one run
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.11, 17.12_

  - [ ] 10.2 Make the contrast floors a standing gate
    - Extend `agent/tests/test_chartstyle.py`, which already reads `app/app/globals.css`, `app/components/charts/palette.ts` and `agent/.../render/chartstyle.py` and asserts the three agree, with the WCAG 2.1 relative-luminance computation
    - Assert **3:1** for every plotted mark and **4.5:1** for every inline value label, against **both** `--background` and `--card`, in **both** the light and the dark theme, failing naming the series, the surface and the theme
    - A standing gate rather than a pre-flight step somebody remembers — the same posture `app/test/palette.static.test.ts` already takes for the colour-vision-deficiency margins, which is unchanged
    - _Requirements: 17.10_

- [ ] 11. The historical trend — the app query, the payload field, the pure selector, the verify gate
  - The four parts go in that order, and the selector is **pure with the snapshots supplied**:
    `report_runs` and `report_verifications` are in Postgres and the agent reaches no database.

  - [ ] 11.1 Implement `app/lib/runs/historical.ts` — the candidate query
    - `import "server-only"` first line. One query joining `report_runs` to `report_template_versions` with a `LEFT JOIN LATERAL … ORDER BY rv.created_at DESC, rv.id DESC LIMIT 1` for each run's **latest** verification, which is criterion 18.6's tie-break expressed in the query rather than re-derived in the selector — `report_verifications` deliberately carries no `UNIQUE (run_id)` because a re-verification appends, so "the latest" is a real question with a real answer
    - Filter on `tv.template_id`, **not** `r.template_version_id`: a template version is immutable and editing a template writes a new version, so keying on the identical version id would **empty every trend on the next edit**. The cost — two points may have been compiled from different definitions — is what the exclusions of task 11.2 catch wherever that difference reaches a plotted value
    - `r.user_id = $1`, the connected subscription id, `r.id <> $4`, and `r.period_end < $5` for the compiling period's start; `ORDER BY r.period_end DESC, v.created_at DESC, r.id DESC` and **`LIMIT 200`, not `LIMIT $lookback`**, because the eligibility filters run after the bound and bounding at the lookback would let an ineligible newer run displace an eligible older one. Record the residual in a comment with its number: 200 leaves room for 176 ineligible candidates at `lookback <= 24`, so a template with more than 200 prior runs against one subscription of which at least 177 of the newest 200 are ineligible loses an eligible run to the bound — sixteen years at one run a month, seven months at one a day
    - `lib/actions/runs.ts` carries the candidate list in the **invoke payload**, not the `context`, which stays closed at twelve fields with its guard
    - Integration test against real Postgres: the lateral join returning each run's latest verification across runs carrying one, several and none
    - _Requirements: 18.4, 18.5, 18.6_

  - [ ] 11.2 Implement `compile/historical.py` — the pure selector
    - `PriorRunCandidate(run_id, period_start, period_end, timezone, status, verification_status, verification_created_at, verification_id, snapshot_sha256)`, `EXCLUSION_REASONS` over exactly the six declared values, `Exclusion(run_id, reason)` and `Selection(selected, exclusions)` with `selected` ordered by period start **ascending**
    - `select(candidates, *, compiling_period_start, lookback, metric, statistic, compiling_fidelity_tier, snapshot_for)` — **pure**: no clock, no network, no object store, with `snapshot_for` supplied and consulted only for a candidate the first four filters admitted
    - Filter order, declared because "exactly one typed reason per excluded candidate" needs a precedence and because the order bounds the snapshot loads: `status_not_completed` → `verification_not_passed` → `period_overlapping` → `beyond_lookback` → `metric_absent_in_snapshot` → `fidelity_tier_differs`. Steps 5 and 6 are last because they are the only two that read a snapshot, so at most `lookback` snapshots are ever loaded
    - Overlap: two periods overlap when the later's start is at or before the earlier's end; retain the run whose period end is later, on equal ends the one whose latest passing verification has the greater creation instant, and on equal instants the one whose id compares greater in code-point order — so two runs of one identical period resolve to exactly one retained run on every call
    - `selected + exclusions == candidates` as a set: a selector that silently drops a candidate leaves criterion 19.2's statement with no reason to name
    - `report_pipeline.py` loads at most `lookback` prior snapshots and hands them to the selector, the same shape `verify/replay.py` already has where the caller fetches and the pure module folds
    - _Requirements: 18.4, 18.5, 18.6, 18.7, 18.10, 18.13, 18.14, 18.15_

  - [ ] 11.3 Compile the `historical_trend` block and its two provenance fields
    - `app/lib/templates/blocks.ts` and `agent/.../compile/definition.py`: add `historical_trend` between the block-type sentinels, taking `BLOCK_TYPES` from sixteen to **seventeen** and adding nothing else, with a config schema over a metric, a statistic and a `lookback` integer from **2 to 24 inclusive**; reject a config naming a metric or statistic absent from the definition's metric selection
    - `PRIOR_RUN_NAMESPACE = "prior_runs"` and `HistoricalResolver` installed for the duration of the block through `compiling_against`, resolving the compiling snapshot's own pointers **plus** a prior run's under `/prior_runs/<run_id>` — a superset for that block alone, the same shape `compile/blocks/comparison.py`'s `DeltaResolver` already takes, so the rest of the document is unaffected
    - A historical point is a `Figure` whose `snapshot_path` is `/prior_runs/<run_id>/resources/<i>/statistics/<j>/value` carrying `source_run_id` and `source_snapshot_sha256` from task 5.1, **redundant with the pointer prefix by construction and deliberately so**: `__post_init__` requires them to agree, so the disagreement negative test 15.8 injects is caught two ways, and construction **succeeds** for a point sourced from a failed run so that the injection is expressible and the gate can be observed failing at all
    - `compile/blocks/charts.py`: one plotted point per selected period ordered by period start ascending; **no Azure request**, every value from a stored snapshot; no interpolation, no carry-forward, no plotted point for a period no selected run covers; exactly one axis category per plotted point and none for a period carrying no point, so the axis is neither padded toward the lookback nor shortened below what was plotted
    - The block is emitted rather than omitted when short or empty, with exactly **one** statement resolved from the Message_Catalog naming the count plotted, the count requested and the typed exclusion reasons; and exactly **one** statement, also resolved by id, that each historical point was verified against its own run's verification record and that this run's replay re-verified this run's snapshot alone
    - Criterion 19.10 as a mechanism: assert the emitted plotted count equals the number of points that block emitted and the emitted requested count equals the declared lookback, and raise `COMPILE_FAILED` naming the block's AST path on a disagreement. Those two numerals reach the document as prose and are admitted through the static-text allowlist, which is sound because the null-context render emits the same statement with the same counts
    - No error code and no `collection_log` gap for a short trend: an absent prior run is an ordinary compile outcome
    - `verify/replay.py` re-verifies the snapshot of the run being compiled **alone** and reads no prior run's snapshot and no prior run's archive — assert it
    - _Requirements: 18.1, 18.2, 18.3, 18.8, 18.9, 18.10, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.10, 19.11_

  - [ ] 11.4 Implement `verify/historical.py` and wire the `historical` gate
    - `agent/src/reporting_agent/verify/historical.py`, pure, reading `VerifyInputs.historical` — a mapping from source run id to `{verification_status, period_start, period_end}` supplied by the app in the invoke payload alongside the candidates
    - `historical_point_unverified` for every ledger entry carrying a `source_run_id` whose supplied verification status is not `pass`, naming that run id and the entry's AST path; `historical_point_overlapping` for any two distinct `source_run_id`s among the entries whose supplied periods overlap, naming both run ids and both periods
    - Record on the verification result, for every historical point the document carries, its source run id and that run's snapshot hash, so a reader can trace each plotted period to the verification that proved it — this is what `VerificationView.historicalPoints` from task 8.3 projects
    - Wire it as the `"historical"` gate from task 1.5
    - _Requirements: 18.11, 18.12, 19.9_

  - [ ] 11.5 Property test — historical run selection is newest-N, non-overlapping and verified
    - **Property 3: Historical run selection is newest-N, non-overlapping and verified**, identifier `historical_selection`, in `agent/tests/property/test_historical_property.py`
    - **Validates: Requirements 18.4, 18.5, 18.6, 18.7, 18.10, 18.13, 18.14, 18.15, 19.1, 19.3, 19.4**
    - `hypothesis` over prior-run counts 0–40; lookbacks 2–24; statuses including `completed` and `failed`; verification outcomes including `pass`, `fail` and **absent**, with 1–3 verifications per run at equal and differing creation instants; periods including exactly adjacent pairs, one-day-overlapping pairs and identical pairs; snapshots including some carrying no value for the declared `(metric, statistic)` and some carrying a differing `fidelity_tier`; and other template rows and other subscription ids mixed in
    - Assert `<= lookback`; no non-`completed` and no non-`pass`; no overlap; newest-first with no eligible run excluded while a later-ending run was admitted; one point per run ordered by period start ascending; identical selection per (set, lookback) **and under any permutation of the input order**; every eligible run selected and nothing padded when fewer than the lookback exist; only this template row and this subscription; a network double proving purity; `selected + exclusions == candidates` with exactly one reason each; and `metric_absent_in_snapshot` and `fidelity_tier_differs` excluding with no plotted point
    - Declared examples: two runs of one identical period whose latest passing verifications carry equal creation instants, asserting the id tie-break; a candidate whose latest verification is `fail` while an earlier one passed, asserting exclusion; and a run of the same subscription under a **different template version of the same template row**, asserting **inclusion**
    - Kills: a selector filtering on `status` alone, which admits a completed run whose verification failed; one taking the newest N **before** filtering, which returns fewer than N eligible while eligible older runs exist; one admitting overlapping periods, which plots one interval twice as two periods; one padding to the lookback, which fabricates a period; one whose order depends on the query's row order; one keyed on the identical `template_version_id`, which empties every trend on the next template edit; one that silently drops an ineligible candidate without recording why
    - _Requirements: 18.4, 18.5, 18.6, 18.7, 18.10, 18.13, 18.14, 18.15, 19.1, 19.3, 19.4, 25.1, 25.3, 25.4, 25.5, 25.8, 25.10_

- [ ] 12. The inventory endpoint and the three pickers
  - The app's **pure** modules land before the components that use them: `lib/templates/options.ts`,
    `lib/subscriptions/inventory-cache.ts`, `lib/templates/migrate.ts` (task 7.5).

  - [ ] 12.1 Add `distinct_dimensions` and the `list_inventory` command
    - `agent/.../azure/inventory.py`: `distinct_dimensions(...)` issuing **one** Resource Graph query per call with a `summarize`/`distinct` projection over the whole subscription scope, each dimension ordered ascending in Unicode code-point order, at most **2000** values per dimension with a per-dimension `truncated` flag
    - The query projects the four dimensions **and nothing else**, so the exclusion of every fully qualified resource identifier, subscription id, tenant id and client id is a property of the projection rather than a filter applied afterwards
    - `agent/.../main.py`: add `list_inventory` to `COMMANDS` and route it deterministically, reporting its whole result on `done`'s `outcome` mapping — `_done_event` already merges an `Invocation.outcome` mapping and `preflight` already reports its whole result that way. **No SSE event type is added**, so `events.py` and `lib/events.ts` are not edited and the cross-language event mirror stays untouched
    - Extend `tests/test_main.py` and `tests/test_report_events.py`: the four dimension keys reach `done`, the invocation-level error codes stay disjoint, and nothing follows `done`
    - _Requirements: 9.1, 9.3, 9.5_

  - [ ] 12.2 Implement the cache and the endpoint, in the order the criteria force
    - `app/lib/subscriptions/inventory-cache.ts`, `import "server-only"`: a module-level `Map<string, { at: number; rowUpdatedAt: string; payload: InventoryDimensions }>` keyed on the connected subscription's **row id alone**, a hit for **300 seconds** after the query completed, a miss thereafter, and a miss once that row has been written after that instant — invalidation-on-write is then a comparison of the row's `updated_at` the handler already loaded, not a publish/subscribe problem
    - `app/app/api/subscriptions/[id]/inventory/route.ts`, `GET`, `export const runtime = "nodejs"`, `Cache-Control: no-store`, with **named** zod schemas at the boundary: `inventoryParamsSchema` over `id` and `inventoryQuerySchema` as `z.object({}).strict()` — no search parameters, and saying so
    - The order is three criteria: **ownership first** — a `user_id` differing from the signed-in user's resolves as **not found** with no Azure query and no field of that row disclosed, byte-identical to the response for an id that exists for no row; **then status** — a `status` other than `active` resolves as unavailable naming that status and disclosing nothing else, which drives the free-entry fallback rather than an empty option list a consultant would read as an empty subscription; **then the cache**
    - Bound the wait on the runtime at **30 seconds**, resolving as unavailable naming which of unreachable / rejected / no-response occurred, writing **no** cache entry and issuing **no** automatic retry
    - Invoke the runtime with the `list_inventory` **command** carrying the server-resolved Azure credentials in its `context` — never a prompt, and the app issues no Azure request and holds no Azure access token
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.8, 9.9_

  - [ ] 12.3 Implement `lib/templates/options.ts` and its property
    - **Pure, no I/O**, shared by the inspector and by the load-time check: `ConfigFieldKind` over `metric_ref` | `metric_ref_list` | `column_list` | `enum` | `other`, `fieldKind(blockType, field)`, `MetricOption` / `AttributeOption` / `FactOption`, `OptionGroups` and `optionsFor(field, { definition, block, catalog, factDeclaration })`
    - `metric_ref` and `metric_ref_list` draw options from the **definition's metric selection alone**, not from the catalog: a block can display only a subset of what the run collects, and an option outside the selection guarantees a block carrying no figure. `column_list` draws from **three distinctly presented groups** — those same metrics, the resource attributes, and the fact keys the declaration declares for a resource type the block's resolved scope **can contain**
    - `COLUMN_ATTRIBUTES` as a new **mirrored** sentinel-delimited constant in `app/lib/templates/options.ts` and `agent/.../compile/blocks/tables.py`, drawn from what that module can actually emit today: `resource_name`, `resource_group`, `resource_type`, `location`, `sku_name`, `power_state`, `fidelity_tier`. `resource_table`'s implicit name column and its `show_fidelity` flag are **unchanged**, and naming `resource_name` or `fidelity_tier` as an explicit column while it is already implicit is a validation error naming the field, because a duplicate column key would make `(row_key, column_key)` address two cells
    - `undeclaredReferences(definition, catalog, factDeclaration) -> readonly ConfigReferenceIssue[]` with `reason` over `metric_not_selected` | `fact_key_undeclared` | `attribute_unknown`. **The load path calls a pure function that returns issues and performs no write** — that is criterion 12.10's "no load path edits a definition on its own" as a signature rather than as a discipline: it returns a value and takes no store
    - **Property 8: Block-config options are drawn from the selection and the declaration**, identifier `config_option_sources`, in `app/test/property/config-options.property.test.ts`. **Validates: Requirements 11.9, 12.2, 12.4, 12.9, 12.10.** `fast-check` over definitions of 1–7 resource types × 1–40 metric selection entries; blocks of every type carrying `scope_override`s that narrow, widen and disjoin from the default; catalogs and fact declarations including entries the definition does not select and keys no in-scope type declares. Assert every offered metric option is in the selection; no option for a type the block's resolved scope cannot contain; column options partition into exactly three groups with no member in two; `undeclaredReferences` returns an issue for every stored reference outside the options and for none inside them; and the function is pure — called twice on one input it returns equal issues and the definition is referentially unchanged
    - Kills: a resolver drawing metric options from the catalog rather than the selection, which offers a metric the run does not collect; one offering every declared fact key regardless of scope; a load path that removes an undeclared reference instead of reporting it
    - _Requirements: 11.9, 12.2, 12.4, 12.9, 12.10, 25.1, 25.3, 25.4, 25.5, 25.8, 25.10_

  - [ ] 12.4 Build the scope picker and its property
    - `app/components/templates/scope-picker.tsx` replacing the comma-separated text controls `app/components/templates/step-scope.tsx` presents today through `parseList` (line 40) and `parseTagFilters` (line 60), presenting the resource types, resource groups and tag keys and values the endpoint returned as selectable options
    - Four option kinds, four stored shapes: a resource type stores that string in `scope.resource_types`; a resource group that string in `scope.resource_groups`; a **tag key alone** stores `{ key, value: "" }`, because a zero-length value is already the rule "carries this tag" — the alternative, inventing a wildcard token, would be a value no inventory response carried and a second spelling of a rule the schema already has; a tag key with a value stores both
    - Record **nothing** identifying the subscription whose inventory was listed, and do not relax the `Template_Validator`'s existing rejection of a resource id, subscription id or tenant id in any scope field
    - Free entry survives beside the picker with the **same** bounds and validation, a rule **character-identical** to the one a selected option of the same string would store, one entry rather than two on a duplicate, and the error on the step rather than at save
    - **The picker never writes.** It renders the definition's stored values as selected whether or not the response contains them, marks the ones the response does not contain as *not present in this subscription*, and removes a value only on an explicit removal — so opening a template against a second subscription's inventory **edits no rule**
    - Case folding follows the resolver: resource types and tag **keys** differing only by case present as **one** option; tag **values** differing by case present as **distinct** options, because `compile/scope.py` compares the first two case-insensitively and the third case-sensitively
    - State for each dimension that an empty dimension imposes no constraint and therefore collects **every** value of it; offer no control that selects a named resource; and state that a template stores rules so one template serves every connected subscription. Every option keyboard-reachable with a visible `--ring` focus indicator, and selections and removals announced through an `aria-live="polite"` region
    - Where the endpoint is unavailable or exceeds its bound, and where no subscription is selected, present the free-entry control with the statement of why, retain every stored value, and block neither the step nor the save
    - **Property 7: A picked scope stays a rule**, identifier `scope_stays_a_rule`, in `app/test/property/scope-picker.property.test.ts`. **Validates: Requirements 9.5, 10.2, 10.3, 10.4, 10.5, 10.6, 10.10, 10.11.** `fast-check` over inventories of 0–2000 values per dimension with names including GUID-shaped and `/subscriptions/…`-shaped substrings, pairs differing only by case, and values at the length bounds; selections of 0–60 options per dimension; directly entered values including duplicates, values absent from the inventory, and values over the bounds. Assert the stored definition carries no identifier of the three kinds; the validator accepts it; one identical stored value from two inventories; the endpoint's response carries none of the four identifier kinds; a directly entered value gets the same bounds and validation and stores a character-identical rule; a tag key picked alone stores `{key, value: ""}`; a stored value absent from the response presents as selected and is retained; and the case-folding rule holds per dimension. Declared examples: an inventory whose resource group name contains a subscription-like identifier substring, asserting the stored value is that group name and the definition still passes the resource-identifier rejection; and a definition carrying a resource type the response does not list, asserting it is still selected and still stored after render
    - Kills: a picker that stores the selected resource's id alongside its type; one storing a subscription-qualified group path; an endpoint returning full resource ids; one that prunes a stored value the current inventory does not list, which silently edits a rule on load
    - _Requirements: 9.5, 9.6, 9.7, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 25.1, 25.3, 25.4, 25.5, 25.8, 25.10_

  - [ ] 12.5 Build the metric picker over every catalog type
    - `app/components/templates/metric-picker.tsx` extending the selection grid `step-metrics.tsx` presents today: one group per resource type the Metric_Catalog declares, sourced through the existing `GET /api/templates/catalog` and never from a list held in the app
    - **Two partitions in a fixed order** — first the groups for the resource types the definition's scope declares, then the groups for **every other type the catalog declares, present rather than hidden**, because a block `scope_override` may narrow to a type the template default does not name; and exactly **one** partition carrying every group where the scope declares no resource type. Groups ordered by resource type name and options by option name, both ascending in code-point order, so two renders of one catalog and one definition present one identical order
    - Present per option whether the catalog declares its statistics exact or estimated, the fractional-digit count it declares, and for a percentile the estimator label it declares; the `Template_Validator`'s existing persistence of the estimator label and fidelity tier for a percentile entry is unchanged
    - Two refusal states, both retaining the stored selection and **refusing step completion** rather than saving something the validator would reject minutes later: an unavailable catalog presents a statement and no option; and a stored entry the current catalog no longer declares presents as selected **and as no longer declared** and is retained until the consultant removes it — which a `catalog_version` raised in task 3.2 can produce with no edit at all
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9_

  - [ ] 12.6 Build the block-config picker and change the `columns` shape
    - `app/components/templates/config-picker.tsx` for `metrics`, `columns`, `capacity_metric`, `usage_metric` and `order_by` — every metric-valued config field `app/lib/templates/blocks.ts` declares — replacing the raw-JSON control `block-inspector.tsx` presents today through `fieldValue` (line 54) and `parseFieldValue` (line 79), with options from `optionsFor`
    - **Close the hole structurally**: for those five fields there is **no free-text control at all**, so a mistyped metric is not something the interface can express. `fieldValue`/`parseFieldValue` are retained **only** for fields whose kind is `other`, and the copy at line 209 — "decides whether the value is acceptable — this pane does not guess" — is narrowed to those fields alone
    - `columns` entries become **objects carrying a `kind`** of `metric`, `attribute` or `fact` rather than bare strings, because a bare string could not distinguish a fact key from an attribute key from a metric key without inferring from its spelling — the exact inference `value_kind` exists to avoid one layer down. **A v1 definition's bare-string `columns` continue to parse as metric refs**, so no stored row changes meaning; the kinds are mirrored in `blocks.ts` and `definition.py` as an enumerated value of the `columns` field, and the shared fixture corpus carries both spellings
    - A `fact` column emits **two** columns at compile time — `<key>` and `<key>.observed_at`, the second carrying that fact's `collected_at` as a `TextFact` with its own anchor — so two facts with differing instants produce two instant columns and **no** table-level instant. The inspector **states the column count a fact selection produces**, so a consultant learns in the builder rather than in the rendered PDF that four fact keys are eight columns wider
    - Present `order_by`'s direction as a control over the `order_by_direction` enum's declared values, being `descending` and `ascending` alone, and a metric-valued option's statistic as a control over the statistics the catalog declares for that metric
    - A reference removed from step 4 while a block config names it presents as invalid **on the inspector for that block and on step 4**, naming the block, the field and the removed value in both places, retaining the stored reference and refusing completion until it is removed or the metric reselected; the same on **load** through `undeclaredReferences`, with the `Template_Validator` independently rejecting a save carrying it unchanged
    - Every option keyboard-reachable with a visible `--ring` focus indicator and selections and removals announced through an `aria-live="polite"` region
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 8.1, 8.7, 8.8_

  - [ ] 12.7 Make saving the identity step name the template
    - `app/components/templates/step-identity.tsx` writes the submitted value to the draft definition's `identity.name` and **then** invokes `renameTemplate` against `report_templates.name` — **two separate writes in that order**, not one atomic write — and reports the step as saved only where both succeeded. Today the component writes `definition.identity.name` alone (line 37) while its field is labelled `Template name` (line 44) and the list reads `report_templates.name`, so nothing calls `lib/actions/templates.renameTemplate` and every template reads `Untitled template` forever
    - Invoke the rename only where the submitted value differs **character for character** from the stored `report_templates.name`; where it is equal, invoke none and report the step as saved
    - Apply the 1–120-character bound after trimming leading and trailing whitespace **before** either write: out of bounds presents a validation error on that step, writes no draft, invokes no rename, and does not defer to completion. A failed draft write invokes no rename and leaves both stores unchanged
    - Where the draft write succeeded and the rename failed: present that **the template name was not updated**, retain the entered value, leave `report_templates.name` unchanged, present a control that re-invokes the rename, report the step as **not saved**, and report **no** error against the draft write that succeeded — a consultant reads which of the two did not land rather than one undifferentiated failure
    - Where the stored name and the draft's `identity.name` diverge on open, present that divergence **naming both values**, and set both to the submitted value on the next successful save, so the divergence a failed rename leaves behind is repairable on a live template
    - The template list presents `report_templates.name`, or the `ui.template.untitled_placeholder` string id from task 6.2 where it is absent or empty; an **archived** report presents the pinned definition's `identity.name`, and a difference between the two is presented without being treated as an error, because the pinned value is a historical fact
    - `app/test/identity-rename.dom.test.tsx`: save with a name differing from the stored one, assert the rename operation was invoked **exactly once**, and assert the list then presents that submitted name and **no placeholder** for that template — so the shipped defect fails the suite rather than a delivered list
    - `lib/templates/store.ts`'s existing rename is unchanged: it is already scoped to the signed-in user's row, resolves another user's row as not found, and writes no `report_template_versions` row — assert both
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12_

- [ ] 13. The report page — grouping, the panel, and the paper stylesheet
  - [ ] 13.1 Implement `lib/runs/gap-groups.ts` and its property
    - `app/lib/runs/gap-groups.ts`, **no `import "server-only"`** — deliberately, and it is the one module in this spec where that is the right call: the expansion control is a client component and the grouping must run where the entries are rendered. It touches no SDK and no secret, so the boundary rule is satisfied by what it does not import
    - `NO_METRIC_KEY = "\u0000no-metric"` and `UNATTRIBUTED_RESOURCE_KEY = "\u0000unattributed"`. The `\u0000` spelling is the reason both work: a NUL cannot appear in an Azure metric name or resource id so neither key can collide, and NUL sorts before every printable character in code-point order, so "the no-metric key sorting before every metric" is a **consequence of the sentinel's spelling** rather than a special case in the comparator
    - `GapRange`, `GapInnerGroup`, `GapTypeGroup` and `groupGaps(gaps, { grain, utcOffset })` — group first by `gapType`, then within each type by `(resourceId, metric)`, taking a fact gap's fact key as occupying the metric position. Totality is the point: `RunGap.metric` is `string | null` and `record_gap` accepts `str | None`, so a `region_unreachable`, a `permission_denied` and every fact gap carries no metric and a key without the sentinel is **undefined** for them
    - Per-group counts on both levels, summing across every group to **exactly** the supplied entry count, counting an entry identical in all four fields as a separate entry rather than as one, and discarding nothing
    - Contiguity: the starts sorted ascending, each after the earliest equal to the preceding advanced by **exactly one step of the run's resolved grain** — 3600 seconds for `PT1H`, 900 for `PT15M` — rather than merely close in wall-clock time. The range is the earliest start to the latest start advanced by one step; a group with exactly one start records the range spanning that one interval; a group whose starts are not contiguous, **or any of whose entries carries no start**, records **no range** rather than one implying contiguity. Formatted **arithmetically from the recorded UTC offset** rather than through `Intl.DateTimeFormat`, which keeps the function pure and ICU-independent so two machines format one range identically — record the bounded residual in a comment: a single offset is wrong for a window containing a DST transition, and the customer zone is DST-free at +07:00 with `collect/buckets.choose_grain` already dropping to `PT15M` for a non-whole-hour offset
    - The representative is the entry sorting first by `resourceId`, then metric (sentinel first), then interval start (absent first), then message, each ascending in code-point order, so two renders of one collection log present one identical representative
    - **No input or output operation**, and the grouping derived from the supplied entries alone
    - **Property 4: Gap grouping is lossless**, identifier `gap_grouping_lossless`, in `app/test/property/gap-groups.property.test.ts`. **Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.5, 20.11, 20.12.** `fast-check` over 0–800 entries across 1–24 `gapType` values; 1–50 resource ids **including one empty string**; metrics including `null`, `""` and 1–10 names; interval starts including absent, contiguous runs at `PT1H` and at `PT15M`, off-by-one-minute runs, duplicated starts, and runs with one hole; messages including duplicates; and entries identical in all four fields. Assert the counts sum to the input count; every entry in exactly one group; the type set equals the input's; the inner keys equal the distinct keys under the total keying; identical grouping **and** identical representative on every call; a contiguous group's range exactly earliest → latest + one step and a non-contiguous or start-less group's range **absent**; no I/O; and no undefined key. Declared cases: **512 entries across 8 metrics of 1 resource of one `gapType`** — the shape a live run produced — asserting at most 9 rows before expansion while the counts still sum to 512; an entry carrying a `null` metric; an entry carrying an empty `resourceId`; and a group whose starts are one grain step apart except for one hole, asserting **no** range
    - Kills: a grouper that de-duplicates entries rather than counting them, which presents a total below the recorded gap count; one grouping by `gapType` alone, which is the present behaviour and leaves 512 rows in one group; one whose representative depends on `Map` iteration order; one recording a range across non-contiguous intervals; one keyed on `(resourceId, metric)` alone, which produces an undefined key for every gap carrying no metric and drops rows the sum must account for
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.11, 20.12, 25.1, 25.3, 25.4, 25.5, 25.8, 25.10_

  - [ ] 13.2 Rebuild `gap-list.tsx` over the grouping
    - Replace the one-list-item-per-entry presentation `components/reports/gap-list.tsx` renders today — which emitted 512 paragraphs for a run whose entries largely named the same resource — with type groups carrying counts, expanding to inner groups carrying counts, one **representative** message per group rather than one message per entry
    - `MAX_EXPANDED_ENTRIES = 200`: an expanded group presents at most 200 entries and, where it contains more, an explicit statement naming the count presented and the count contained, so the 512-entry group expands to a bounded list rather than restoring what this replaced
    - `GAP_TYPE_COPY` (line 29) carries copy for eight of the twenty declared types today. A type with **no** copy presents its `gapType` value, its entry count and its representative message and is **presented rather than omitted**, which is what the four gap types task 1.3 adds would otherwise fall through to
    - The `metric_not_selected` group carries the statement that the cause is that the template selected no metric for those resources' types and that the fix is a **template edit**, plus a link to the pinned template's metric selection step. Where those entries carry a resource type, present the distinct resource types and the count of distinct resources of each ordered ascending in code-point order rather than a list of resource identifiers; where they carry none, present the count of distinct resources affected with the statement that the types were not recorded — and present the statement and the link in **both** branches
    - A collection log carrying zero entries presents an explicit statement that the collection recorded no gap, and the gap section is never omitted
    - Expansion keyboard-reachable with a visible `--ring` focus indicator and an accessible name naming the group and its entry count; every group in mist neutral tokens with `--destructive` applied to no gap group, because a gap is neutral information
    - Present a run's gap copy in the **pinned** definition's language, resolved by string id
    - _Requirements: 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.13, 20.14, 15.9_

  - [ ] 13.3 Make the verification panel fit its box, and assert it by presented text
    - `components/reports/verification-panel.tsx`: present the drift sample seed through `components/reports/copy-digest.tsx` rather than the bare `<span className="font-mono">` at line 264, so every hash and every seed the panel displays goes through the **same** truncating copy control
    - Take the truncation length from `copy-digest.tsx`'s single declared `TRUNCATE_TO = 12` (line 29) rather than declaring a second constant; the control places the **complete untruncated recorded string** on the clipboard, and a value of 12 characters or fewer presents complete with that same complete string copied
    - Present every hash, seed and finding locating field either truncated through the control or with line breaking permitted at any character, and present no such value as an unbroken run of more than 12 characters that line breaking cannot divide, so its container requires no horizontal scrolling at a viewport width of **360 CSS pixels**. Truncate no locating field to the point that a finding ceases to identify where the disagreement is
    - Where the stored row records no drift sample, or one carrying no seed, present an explicit statement that no drift sample seed was recorded — neither an empty value nor a zero in that position. A refused clipboard write keeps the complete string reachable through the control's accessible name, presents no error state and applies `--destructive` to no part of the panel, exactly as `copy-digest.tsx` already behaves
    - Every value derived from the stored `report_verifications` row rather than from a received event alone — unchanged, and asserted
    - `app/test/verification-panel.dom.test.tsx`: render the panel carrying a 64-character seed and three 64-character digests and assert each of those four values presents **at most 12 characters of text** and that its complete recorded string is reachable through its copy control's accessible name. **Assert no element width**, because the app test environment performs no layout and reports every width as zero — a width assertion there reports a **pass** for a panel presenting all 64 characters, which is exactly the shipped presentation
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.9, 21.10_

  - [ ] 13.4 The declared class collection, the additive `globals.css` edit and its guard
    - `agent/.../render/html.py`: declare `EMITTED_CLASS_NAMES` over the thirteen names once — `rpt-document`, `rpt-block`, `rpt-break`, `rpt-table`, `rpt-row`, `rpt-notice`, `rpt-chart`, `rpt-series-set`, `rpt-series`, `rpt-point`, `rpt-figure`, `rpt-column`, `rpt-layout-row` — and have every emit site take its class from the declaration rather than from an inline literal, replacing the literals at lines 71, 78, 226, 238, 270, 276, 330, 336, 343, 350, 374, 380 and 432
    - Join consecutive `rpt-point` elements with `" · "` instead of `""` in `series` (line 340), so three consecutive percentages render as `0.20% · 0.22% · 0.20%` rather than `0.20%0.22%0.20%`. The separator is a text node **inside `rpt-series` and outside every `rpt-figure`**, so each figure's own text stays that ledger entry's `formatted` string character for character; a middle dot rather than a space because the design system already uses `·` as its statement separator and a bare space between two percentages reads as one number broken in half
    - `agent/tests/test_html_classes.py`: a **runtime** check rather than a source scan — emit a fixture document exercising every node type, parse every `class` attribute out of the produced markup, and assert the set is a subset of `EMITTED_CLASS_NAMES`, because a runtime check cannot be fooled by an interpolated class name. Add a source scan beside it asserting no `class="rpt-` literal appears outside the declaration
    - `app/components/reports/paper-classes.ts`: the sentinel-delimited mirror of the Python tuple, compared by `app/test/mirror.static.test.ts`
    - `app/app/globals.css`: **append** one block of `rpt-` rules and reformat, reorder and replace nothing — `.rpt-table { border-collapse: collapse }` with `.rpt-table td, .rpt-table th { border: 1px solid var(--border) }` for the hairline on each side adjacent to another cell; `.rpt-notice { color: var(--muted-foreground) }` in mist neutrals; `.rpt-figure` in `var(--font-mono)` with `font-variant-numeric: tabular-nums`; `.rpt-figure + .rpt-figure { margin-inline-start: 0.5ch }` for adjacent siblings **and no separation between a figure and the prose characters surrounding it inside one paragraph**, because the emitter joins a paragraph's inline nodes with no inserted character deliberately and a separator there would alter the sentence; and a rule for each remaining declared name. **`--destructive` appears in no `rpt-` rule.** `rpt-paper`, which `paper-render.tsx` emits as its own wrapper, is deliberately **not** in the collection: the collection is what the emitter writes, an extra stylesheet rule is never a failure and a missing one is
    - `--font-mono: var(--font-mono);` is **already present** inside the existing `@theme inline` block at line 79 — assert that it is, and add nothing. `.rpt-figure`'s mono requirement depends on it resolving deterministically rather than by stylesheet order
    - `app/test/paper-stylesheet.static.test.ts`: read `app/app/globals.css`, extract its selectors, and assert a rule exists for each of the thirteen read from `paper-classes.ts`, failing **naming the class name** — one declared list against one stylesheet, never a TypeScript test parsing Python from another package
    - `app/test/globals-preset.static.test.ts`: parse `globals.css`, extract every `--*` custom property declared in `:root` and `.dark` that the preset shipped, and compare each against a **committed fixture of its current value**, failing on a changed value, a removed declaration or a reordered block and naming the token; additionally assert the file still contains `@import "shadcn/tailwind.css"`, because pruning it breaks the build, and that no appended `rpt-` rule mentions `destructive`. **No task re-runs `shadcn init` and no task regenerates `app/components.json`**
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.7, 22.11, 22.12_

  - [ ] 13.5 Decide the paper rendering's claim with an executing assertion
    - `app/lib/reports/paper-claim.ts`: `export const PAPER_CLAIM: "approximation" | "text_extract" = "approximation"`, because a component cannot observe a test result and criterion 22.8 makes the view's claim conditional on one passing
    - `components/reports/paper-render.tsx` reads it: `approximation` renders the permanent preview label plus "an approximation of the delivered page"; `text_extract` renders "a text extract", makes **no** claim about approximating the page, and presents the presigned `.pdf` as the delivered result. Both branches present the permanent preview label and **no page number and no page count**, and both present the presigned `.pdf` as the delivered result
    - `app/test/paper-render.dom.test.tsx` is the deciding test: render a paper rendering carrying a data table and a **three-point** chart series; assert each of that table's cells presents in its own `<td>` carrying its own `data-column-key`; assert the three figures present as **three separated text values** rather than as `0.20%0.22%0.20%`; assert `PAPER_CLAIM === "approximation"`; and assert **no element width**, because the environment performs no layout and a width assertion would report a pass for a rendering that concatenated everything. Asserting the claim and the rendering against each other in one run is what "decided by an executing assertion" means mechanically — setting the claim to `approximation` while the rendering is broken becomes impossible, while setting it to `text_extract` while the test passes stays permitted, because a more conservative claim is always allowed
    - `app/test/property-hygiene.static.test.ts` fails if that test is absent, skipped or marked as an expected failure, so the fallback is entered on a proven condition rather than on a test nobody ran
    - Every figure's text presented as that ledger entry's `formatted` string character for character; every figure and every numeric fact in the monospace face with tabular figures and **no numeral animated**; and a `Fact`'s `snapshot_path`, `source` and `collected_at` revealed within 200 milliseconds on hover **and** on keyboard focus, through the same reveal and dismissal behaviour a figure already uses, with `collected_at` presented as the **identical** string the `Docx_Renderer` emits, taken from the Formatter
    - _Requirements: 22.6, 22.8, 22.9, 22.10, 22.11, 8.2, 8.5, 8.6, 8.9_

  - [ ] 13.6 Settle the reservation-facts decision in the declaration, rather than shipping the gap silently
    - Reader at subscription scope does **not** grant `Microsoft.Capacity/reservationOrders/read`, so on most connections the reservation request is rejected and a consultant sees a `fact_unavailable` gap for `reservation_term` and `reservation_expires_at` on every resource. Both branches are already correct and tested in task 4.3; what is undecided is whether the two keys ship at all
    - Take one of exactly two options and record which in the commit message: **(a)** keep the two keys in `catalog/facts.v1.json` and add the onboarding copy that names the additional role assignment which removes the gap — a string id in the catalog plus a line in `app/components/subscriptions/reader-role-explainer.tsx`; or **(b)** remove the two entries from the declaration for this release, which is a **one-line data edit and changes no code**
    - Whichever is taken, add the test that fixes it: for (a) that the explainer names the role and that the two keys are declared; for (b) that the declaration names no `capacity` source and that no `no_reservations` or reservation-keyed `fact_unavailable` gap can be produced
    - This exists as a task because the alternative is shipping a gap a consultant sees on most connections with nobody having chosen it
    - _Requirements: 5.2, 5.4, 5.9_

- [ ] 14. Checkpoint — collection, compilation, rendering and the surfaces
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. The eighteen mandatory negative tests — every gate this spec adds, observed failing
  - Three preconditions apply to **every** sub-task in this section and are what stop a test passing
    for the wrong reason. **The unmutated fixture is asserted to pass first**, with zero blocking
    findings, before the mutation is applied — without it a broken fixture makes every one of these
    tests pass while proving nothing. **The recorded blocking finding types are asserted equal** to
    the set that test declares, failing if a blocking finding of an undeclared type is recorded,
    which is also what makes the zero-`unmatched_prose_token` assertion of 15.2 *entailed* by the
    equality rather than a second assertion standing beside it. And **zero download, observed at the
    interface**: zero `report_file` events for that run, no presigned URL minted for any artifact
    key of that run, and a request to the Web_App for a presigned URL for any artifact key of that
    run resolved as **not found** — the absence observed where a consultant would look rather than
    inferred from a missing event. None may be skipped or marked as an expected failure, and all of
    them run before a change in this spec is committed.

  - [ ] 15.1 A numeric fact's rendered value changed
    - Mutation: one digit of exactly one **numeric fact**'s rendered value changed so the mutated string equals no ledger `formatted` value, leaving the ledger, the anchor set and every other rendered character unchanged
    - Expected blocking set `{table_cell_mismatch}`, naming the table identity, the row key, the column key and the expected and observed strings; `report_runs.status` `failed` carrying `error_code` `VERIFICATION_FAILED`; and no download control
    - Proves a numeric fact is proven exactly as a metric figure is — there is no second numeric path
    - _Requirements: 24.1, 24.2, 24.3, 24.4_

  - [ ] 15.2 A text fact's rendered value changed from `Succeeded` to `Failed`
    - Mutation: that value alone, leaving the ledger and every other rendered character unchanged
    - Expected blocking set `{text_fact_mismatch}`, naming the table identity, the row key, the column key, the fact key and both strings verbatim
    - **And additionally**: assert the numeric masking stages record **zero** `unmatched_prose_token` findings for that mutation, so the test **fails** against an implementation relying on numeric masking to catch it and thereby demonstrates why `TextFact` exists at all
    - _Requirements: 24.1, 24.2, 24.3, 24.5_

  - [ ] 15.3 A fact-producing response removed from the archive
    - Mutation: remove one fact-producing response from a stored run's archive, leaving the stored `snapshot_id`, the archive sequence and every other archived object unchanged
    - Expected blocking set `{replay_hash_mismatch}` carrying the recomputed digest and the stored digest, with the terminal code `REPLAY_MISMATCH`
    - Proves a fact silently omitted from the archive fails replay rather than producing a snapshot that quietly omits it
    - _Requirements: 24.1, 24.2, 24.3, 24.6_

  - [ ] 15.4 An `id` document declaring a comma, converted with a period
    - Fixture: a document whose pinned definition declares `identity.language` `id` and a comma `decimal_separator`; convert such that its figures are written with a **period** decimal separator
    - Expected blocking set `{pdf_figure_missing}`, naming at least one ledger entry whose declared-format `formatted` string carries a **comma**, together with that entry's AST path
    - _Requirements: 24.1, 24.2, 24.3, 24.7_

  - [ ] 15.5 An `en` document declaring a period, converted with a comma
    - Fixture: a document whose pinned definition declares `identity.language` `en` and a period `decimal_separator`; convert such that its figures are written with a **comma**
    - Expected blocking set `{pdf_figure_missing}`, naming at least one ledger entry whose declared-format `formatted` string carries a **period**
    - The second direction is what makes 15.4 an **agreement** check rather than a comma rule
    - _Requirements: 24.1, 24.2, 24.3, 24.8_

  - [ ] 15.6 Retire the one-directional N5 and keep the locale companion in force
    - **Delete** `test_n5_a_comma_decimal_conversion_fails_the_fidelity_gate` in `agent/tests/test_negative_gates.py` (line 406), which asserts `pdf_figure_missing` and that the offending `formatted` string contains a period, and replace it with the pair above — so the assertion becomes *the document's separator disagrees with the definition's* rather than *commas are wrong*
    - **Retain** `test_the_conversion_locale_alone_rewrites_nothing_in_this_renderers_output` (line 446) and extend it to **both** declared formats, because it is what records that this renderer emits every figure as a literal text run and that a locale therefore has nothing to reformat
    - Assert the replaced test name appears nowhere in the suite, so the retirement is complete rather than leaving two tests asserting contradictory rules
    - _Requirements: 24.9, 24.10_

  - [ ] 15.7 A short trend is a labelled normal outcome — the one test that asserts a pass
    - Fixture: a `historical_trend` block declaring a lookback of **6** against a subscription and template for which exactly **2** completed and verification-passed prior runs exist. **No mutation**
    - Expected blocking set **`{}`** with status `pass`: exactly **2** plotted points, the explicit statement naming **2 plotted and 6 requested**, and no third point
    - Asserted on the same unmutated fixture every other test in this section observes passing first, so a short trend is a labelled normal outcome rather than a failure and never a fabricated six
    - _Requirements: 24.1, 24.11_

  - [ ] 15.8 A historical point injected from a run whose verification failed
    - Two halves: the **resolver** selects no point from a candidate run whose latest verification status is `fail`; and a point sourced from such a run **injected** into the compiled document records `historical_point_unverified` naming that run id and the entry's AST path
    - Expected blocking set `{historical_point_unverified}`. The injection is expressible because `Figure.__post_init__` accepts a `/prior_runs/<id>` pointer with a matching `source_run_id` — if construction refused it the negative test could not exist and the gate would never have been observed failing
    - _Requirements: 24.1, 24.2, 24.3, 24.12_

  - [ ] 15.9 Historical points injected from two runs whose periods overlap
    - Two halves: the **resolver** selects at most one of two candidates whose resolved local periods overlap; and points sourced from **both** injected into the compiled document record `historical_point_overlapping` naming both run ids and both periods
    - Expected blocking set `{historical_point_overlapping}`
    - _Requirements: 24.1, 24.2, 24.3, 24.13_

  - [ ] 15.10 A table of contents naming the wrong page
    - Fixture: a document of at least 8 pages whose table of contents names, for at least one entry, a page other than the page that entry's heading appears on
    - Expected blocking set `{toc_page_mismatch}`, naming that entry's heading text, the page named and the page observed
    - Where `ADOPTED_APPROACH` is `none` no table of contents is emitted, so this test constructs its document by writing the entries directly against the harness of task 2.2 rather than through the builder, and asserts the verifier's behaviour independently of which candidate was adopted
    - _Requirements: 24.1, 24.2, 24.3, 24.14_

  - [ ] 15.11 A `TextFact` emitted outside a data-table cell
    - Mutation: drive a purpose-built emitter down `write_layout_table` with a `TextFactCell` in the tree, so no `w:tblCaption` is written and `AnchorRecorder` records nothing
    - Expected blocking set `{text_fact_unanchored}`, naming that entry's AST path
    - Proves the type system stops a `TextFact` occupying a non-cell **AST** position and does not stop a **renderer** emitting one down the layout path — which is a renderer defect of exactly the class this finding exists to catch
    - _Requirements: 24.1, 24.2, 24.3, 24.15_

  - [ ] 15.12 A `Fact` compiled with no `source` or no `collected_at`
    - Fixture: a snapshot carrying such a `Fact`, compiled
    - Expected blocking set `{fact_source_missing}` naming that fact's resource id and key, with the terminal code `COMPILE_FAILED` and **no report artifact written**
    - Proves a fact whose provenance is absent is an assertion rather than an observation
    - _Requirements: 24.1, 24.2, 24.3, 24.16_

  - [ ] 15.13 A table identity altered so a `TextFact`'s anchor resolves to no cell
    - Mutation: alter the table identity in the caption of a rendered data table carrying exactly one ledger entry — a `TextFact` — leaving the ledger and every other rendered character unchanged
    - Expected blocking set `{text_fact_anchor_missing}` naming that entry's AST path **and its anchor**
    - Exists so the blocking type criterion 6.7 declares carries a test that observes it rather than failing the enumeration meta-test of 15.16
    - _Requirements: 24.1, 24.2, 24.3, 24.19_

  - [ ] 15.14 A `schema_version` 2 run missing one per-run front-matter value
    - Fixture: a run whose pinned version declares `schema_version` 2 and for which one per-run value is absent
    - Terminal `RENDER_FAILED` **naming that value**, with no report artifact and **no substituted placeholder** in that value's position
    - **And additionally**: assert **no object exists** at that run's `.docx` and `.pdf` artifact keys, so an absent cover value is observed as a refusal rather than as invented copy
    - _Requirements: 24.1, 24.2, 24.3, 24.20_

  - [ ] 15.15 An `id` run for which the catalog declares no `id` value
    - Fixture: a run whose pinned version declares `identity.language` `id` and for which the Message_Catalog declares no `id` value for one string id that render resolves
    - Terminal `RENDER_FAILED` naming that string id **and** that language, with no report artifact
    - **And additionally**: assert **no `en` value for that string id reached any rendered output**, so the fallback criterion 15.4 exists to prevent is observed **absent** rather than assumed absent
    - _Requirements: 24.1, 24.2, 24.3, 24.21_

  - [ ] 15.16 Extend the enumeration meta-test and assert nothing in this section is skipped
    - Extend `agent/tests/test_negative_enumeration.py` to the **twenty-three** blocking finding types and to the new terminal branches — `COMPILE_FAILED` for an absent fact source, `RENDER_FAILED` for an absent per-run front-matter value and for an absent message-catalog value — collecting the types every negative test declares as expected and **failing if any covered type or code is asserted by zero tests**
    - Declare **exactly two exemptions and name both**: the compilation of a `schema_version` 1 definition, which is a **positive** outcome proven by `test_schema_version_1.py` from task 7.4 rather than a gate that can fail; and the scope-rule invariant, which Property 7 proves across generated inputs
    - Assert that no negative test in this section is skipped, marked as an expected failure, or excluded from the suite that runs before a change in this spec is committed, because a gate whose negative test does not run is a gate that has never been observed failing
    - _Requirements: 24.17, 24.18_

- [ ] 16. Guards, mirrors, hygiene, the regression gate and one end-to-end run
  - [ ] 16.1 Complete and assert the static guards in both halves
    - `agent/tests/test_boundaries.py`, consolidated: the SDK boundary scan extended to `collect/factfold.py`, `collect/numeric.py`, `compile/historical.py`, `compile/messages.py`, `verify/facts.py`, `verify/toc.py`, `verify/historical.py`, `render/front_matter.py` and `render/toc.py`; the **replay-purity closure** walk now including `collect/factfold.py`, `collect/numeric.py` and `catalog/loader.py` and still reaching no `azure.*`, `boto3`, `httpx` or `storage.s3`; the **no-clock-on-the-replay-path** guard over `collect/factfold.py` and `verify/replay.py`; the **one-numeric-leaf-reader** guard from task 1.1; the **no-bare-suppression-on-the-fact-path** guard from task 4.3; and `compile/format.py` importing no message catalog from task 5.3
    - `agent/tests/test_ast_guard.py`: `TextFact` and `TextFactCell` declared, `Cell` a union over exactly four members, `TextFact` declaring no numeric annotation and **not** exempted from the scan
    - `app/test/boundaries.static.test.ts`: `lib/runs/historical.ts` and `lib/subscriptions/inventory-cache.ts` begin with `import "server-only"`; `lib/runs/gap-groups.ts`, `lib/templates/options.ts`, `lib/templates/migrate.ts` and `lib/reports/paper-claim.ts` deliberately **do not** and import no SDK and no secret-bearing module; the inventory route exports `runtime = "nodejs"`; and no arithmetic over a ledger `value` appears under `components/reports/`
    - Every guard asserts **its own completeness**: a scanned directory that is absent or yields zero source files **fails**, so it can never pass by scanning nothing
    - Assert unchanged and passing without edit: `app/test/migrations.static.test.ts` over two additive nullable columns and no enum value; `app/test/event-mirror.static.test.ts`, because no event type is added; and the Boundary_Guard's `.env.example` key-set equality, because **no environment variable is added** — `ADOPTED_APPROACH` is a module constant by decision
    - _Requirements: 5.7, 6.3, 7.9, 7.11, 9.3, 20.11_

  - [ ] 16.2 Assert the six mirrors through the one mechanism
    - `app/test/mirror.static.test.ts` compares, all sentinel-delimited on both sides so no guard needs a parser: the **seventeen** block types; the per-type config including `historical_trend` and the `columns` `kind` enum; the schema-version declarations of task 7.3; `COLUMN_ATTRIBUTES`; the message-catalog **id sets and the values for every shared id**; and `EMITTED_CLASS_NAMES` against `paper-classes.ts`
    - Fail naming **every** differing key, and name either declaration as absent or unparseable
    - Record the design's note in the module docstring: three cross-language mirrors have become six, all six use one mechanism, and **if a seventh appears the right move is a generated schema rather than a seventh hand-written mirror**
    - _Requirements: 12.9, 13.10, 15.10, 18.1, 22.7_

  - [ ] 16.3 Extend the property-hygiene guards and run the regression gate
    - Add three assertions to each of `agent/tests/test_property_hygiene.py` and `app/test/property-hygiene.static.test.ts`: the **set** of property identifiers collected equals the set this spec declares — `facts_archive_round_trip`, `number_format_agreement`, `historical_selection`, `catalog_evidence`, `text_fact_exact_string` on the agent side and `gap_grouping_lossless`, `scope_stays_a_rule`, `config_option_sources`, `number_format_defaults` on the web side — so a property added here and never registered, or registered and never run, fails the suite; every **declared example** must appear in the examples that property executed; and two executions carrying one identical seed must reach an identical verdict, with a clock, network or ambient-environment read on a property's path failing the suite naming the identifier
    - Keep the existing assertions in force: nothing skipped, nothing marked expected-failure, nothing declaring fewer than 100 runs or examples, `HealthCheck.filter_too_much` and `HealthCheck.data_too_large` never suppressed, no generation exhausted before 100 accepted, and no property rejecting more than 20 percent of generated cases through a precondition. A fixed counterexample is retained as an `@example` or declared case running **in addition to** the 100 rather than counting toward it
    - Extend the scan to fail on a skip or expected-failure marker in `test_toc_proof.py` (task 2.4) and `paper-render.dom.test.tsx` (task 13.5) **by name**
    - **The regression gate**: run the foundation's **Property 1** (count-weighted averaging and exact min/max roll-up), the foundation's **Property 2** (JCS canonicalization and content addressing) and the templates spec's **Property 4** (replay's bit-identical snapshot digest) in this spec's suite at ≥100 accepted examples each with their generators, assertions and declared examples **unmodified** — `facts` is now inside the canonical form and inside replay, so a canonicalization regression changes every snapshot id and an aggregation regression produces a document that verifies perfectly against a wrong number. If any is absent, does not execute, or fails, fail this spec's suite and report which one
    - Declare in the same place that this spec deliberately carries **no** property for the table of contents, the document number or message-catalog completeness, because each has one observable outcome per run rather than a generated input space, and each is proven instead by task 2.4's proof test with task 15.10, task 8.1's document-number test, and tasks 6.1 and 6.2's id-set assertions
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10_

  - [ ] 16.4 Wire and verify one full run end to end
    - Drive one `generate_report` for a `schema_version` 2 template covering all seven resource types through the faked Azure ports plus the new `FactsPort`, the in-memory object store, a real Postgres schema and a real LibreOffice in the built image: enqueue rejects a v2 run carrying no customer name or no revision history row and **inserts no row**; an accepted run pins its version, records both per-run values, is claimed by a tick, collects inventory with the fact projections, runs the fact pass between inventory and metrics under the 8-in-flight cap, archives every `inventory`, `facts` and `metrics` object in the pass that folds it, writes the snapshot once with key-ordered `facts` on every resource, compiles the front matter, the content and the historical trend, renders `.docx` then `.pdf`, verifies **all eleven gates**, uploads after the pass, and advances `collecting → compiling → rendering → verifying → completed`
    - Assert the event ordering contract at the source: `snapshot_ready` before any `verification`; every `report_file` after a `verification` carrying `pass`; nothing after `done`; and **no new event type emitted**, so a client built against the ten declared types sees exactly what it saw before
    - Assert the breadth composition unchanged: grouping by `(subscription, location, resource_type)` with one `metric_namespace` per batch; metric definitions probed once per `(resource_type, region)` and served from cache thereafter; the points budget of 20000 with adaptive halving; the resolved grain restricted to `PT1H` or `PT15M`; an endpoint-level `401`/`403`/`404` marking that location fallback-only, re-issuing against the ARM per-resource path and recording **no gap**; a per-resource error inside a `200` recording a typed gap with no statistic and no zero while every other resource of that batch is collected; a location answering through neither route recording `region_unreachable` per resource and `REGION_UNREACHABLE` as non-terminal unless every location fails; and **no `metric_not_selected` gap** for a resource whose type the catalog now declares and for which the pinned version selected a metric
    - Assert a run carrying at least one gap of a type this spec adds reaches `completed` with a non-terminal `PARTIAL_COVERAGE` `error` event before `done`
    - Assert from the browser's side: exactly two download controls for the `completed` + `pass` run, each minting a fresh short-lived URL at activation; the grouped gap list's displayed total equalling the recorded gap count; the verification panel presenting nineteen-key `RunView` and fourteen-key `VerificationView` data with every hash and seed truncated; and the report's fixed copy in the **pinned** language
    - Assert no `client_secret`, `progress_token`, `tenant_id` or `client_id` value appears in any event, log line, finding message or persisted row
    - Confirm `pnpm lint`, `pnpm typecheck` and `pnpm test` clean in `app/`, and `.venv/bin/pytest` and `.venv/bin/ruff check .` clean in `agent/`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.9, 5.6, 6.14, 7.1, 13.7, 13.14, 15.11, 20.3, 25.7_

- [ ] 17. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- **Every task in this plan is required. None is marked `*`.** The nine properties, the eighteen
  negative tests, the enumeration meta-test, the six mirrors, the TOC evidence guard and proof, the
  catalog evidence guard, the two presented-text app tests and the identity-rename test all gate
  completion. This spec's claim is that a fact in a delivered document is an observation with a
  recorded source and a recorded instant, checked against the snapshot it came from — including
  when it is not a number — so a gate that has never been observed failing is not a gate.
- **The dependency graph is ordered by dependency *and* by write-disjointness.** A wave's tasks are
  safe to dispatch concurrently because no two of them write one file — which is why 1.1, 1.2 and
  1.3 occupy three consecutive waves despite having no logical dependency between the second and
  the third: they overlap on `azure/metrics.py`, `collect/log.py` and `collect/snapshot.py`. A task
  that only *reads* a file another task in its wave writes is not a conflict, and three such pairs
  are deliberate: 3.2 names `collect/snapshot.py` as needing no edit, 4.4 names `compile/format.py`
  as the path a `formatted` string is recomputed through, and 10.2 names `app/app/globals.css` as a
  file `test_chartstyle.py` already reads. **If a later edit adds a file to a task, check its wave
  before assuming the wave is still safe to parallelize.**
- Ordering that is not negotiable, and why:
  - **The six touch-ups come first.** `_as_decimal` must be `collect/numeric.decimal_leaf` before
    the one-reader guard can pass or replay's closure can widen; `GapRecord` must carry
    `interval_start` before criterion 20.4's contiguity test has any observable; the gap-type set
    must reach 24 before a fact gap can be recorded; `NumberFormat` must reject a whitespace
    separator before the mirror can require both halves to reject one set; `REQUIRED_GATES` must
    reach 11 and `REQUIRED_STYLE_NAMES` must carry the front-matter styles; and `inventory_query`
    must take `fact_projections` before a projected fact exists.
  - **The TOC evaluation runs before any front-matter work depends on a TOC existing**, because
    adopting the two-pass candidate moves the `rendering` budget from 600s to 900s and that edit
    lands with the adoption or not at all. Every later task reads `ADOPTED_APPROACH`.
  - **The catalog and its evidence fixtures precede the facts**, because `facts.v1.json` loads
    through the same `catalog/loader.py` under the same `catalog_version` and the evidence guard
    runs in the image build.
  - **`collect/numeric.py` and `collect/factfold.py` precede `azure/facts.py`.** The fold is the
    one derivation both collection and replay call, so the fold exists first and the collector
    calls it, never the reverse — and the archive's two new kinds, replay's re-derivation and the
    behavioural seam test ship together, because the whole argument for one fold is that the seam
    is proven by calling it from both sides with a counting wrapper.
  - **Every declaration ships in the same task as the guard over it.** `TextFact` with the extended
    AST guard; the class collection with both directions of its check; `EMITTED_CLASS_NAMES` with
    `paper-classes.ts`; each extended projection with its exact-sorted-key-set assertion; the
    evaluation record with `test_toc_evidence.py`.
  - **The message catalog precedes everything that resolves a string id** — the front matter, the
    table of contents, the charts, the historical-trend statements and the gap explanations.
  - **`schema_version` 2 precedes the front-matter renderer and the app's migration**, and
    `test_schema_version_1.py` lands with it because every shipped starter compiling as stored is
    the positive proof the enumeration meta-test names as exempt.
  - **The app's pure modules precede the components that use them**: `lib/templates/options.ts`,
    `lib/runs/gap-groups.ts`, `lib/reports/paper-claim.ts`, `lib/templates/migrate.ts`,
    `lib/subscriptions/inventory-cache.ts`, `lib/runs/historical.ts`.
  - **The negative tests come after the surfaces they assert against**, because each asserts not
    only a verification failure but the absence of a download control and of any route that would
    mint a URL.
- Three criteria are implemented as the design **narrowed** them, and each task says so in the
  code as well as here: the TOC page numerals are admitted **per paragraph** through
  `proven_toc_numerals` rather than by a static-text allowlist entry, because an allowlist admits
  its string anywhere in the document and would make criterion 14.12 unimplementable; a `Fact`'s
  `collected_at` is bounded below by the runtime's **invocation instant** rather than by
  `claimed_at`, because reaching `claimed_at` needs a thirteenth invoke `context` field the
  foundation closed with a guard, and the invocation instant is `>= claimed_at` so the bound is
  strictly tighter and rejects no correct run; and the literal guard scans
  `agent/.../compile/blocks/` **as well as** the stated set, because that is where
  `EMPTY_SCOPE_TEXT` and every `Column(header=…)` actually live.
- Two criteria are satisfied **conditionally** and the condition is named rather than assumed. If
  all three TOC verdicts are `incorrect` or `unavailable`, `ADOPTED_APPROACH` stays `none`, the
  proof test asserts the **absence** of a table of contents, and criteria 14.5, 14.6, 14.7 and
  14.11 describe a section the document does not carry — which is criterion 14.3's stated outcome
  and not a gap. And criterion 20.4's time range is reachable only because task 1.2 adds
  `interval_start`.
- Absent by design, and asserted absent rather than merely not done: **no SSE event type**, so
  `agent/.../events.py` and `app/lib/events.ts` are not edited and the event mirror is untouched —
  `list_inventory` reports its whole result on `done`'s `outcome` mapping exactly as `preflight`
  already does. **No environment variable**, so `app/.env.example` and `agent/.env.example` are
  unchanged and the key-set equality guard needs no edit. **No `DROP`** — two additive nullable
  columns and nothing else, with the per-run invariant enforced by the enqueue rejection rather
  than by a CHECK, because a CHECK constrained on the pinned version's schema version would need a
  join a CHECK cannot perform. **No regeneration of `app/components.json`** and no replacement,
  reordering or reformatting of any preset token in `app/app/globals.css`. **No migration in the
  agent**, because a stored v1 row is compiled as v1 for as long as it exists. **No template
  language, no `.docx` upload and no `docxtpl`.** **No resource picker that stores a named
  resource.** **No third language.**
- Two costs are accepted rather than traded away, and both are stated where a consultant meets
  them: `columns` entries change shape from bare strings to objects carrying a `kind`, so the
  wizard, the compiler and the shared corpus read both spellings — the alternative, inferring a
  column's kind from its spelling, is the exact inference `value_kind` exists to avoid one layer
  down; and a fact column doubles into two columns, so a `resource_table` naming four fact keys is
  eight columns wider, which is why task 12.6 makes the inspector state the column count.
- Full WCAG conformance is not claimed. The pickers' keyboard paths, the `aria-live`
  announcements, the focus indicators, the gap-group expansion's accessible names and the chart
  contrast floors are designed and tested here; genuine conformance still requires manual testing
  with assistive technologies and expert accessibility review, and these automated checks
  substitute for neither.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.4", "1.5", "3.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.2"] },
    { "id": 2, "tasks": ["1.3", "1.6", "2.2", "3.3", "6.1"] },
    { "id": 3, "tasks": ["2.3", "3.4", "3.5", "6.2"] },
    { "id": 4, "tasks": ["2.4", "4.1", "6.4", "6.5", "7.1"] },
    { "id": 5, "tasks": ["2.5", "4.2", "5.1", "7.2", "12.1"] },
    { "id": 6, "tasks": ["4.3", "5.2", "7.3", "7.6", "12.2"] },
    { "id": 7, "tasks": ["4.4", "5.3", "5.4", "7.5", "12.3"] },
    { "id": 8, "tasks": ["4.5", "5.5", "6.3", "7.4", "11.1", "12.4"] },
    { "id": 9, "tasks": ["4.6", "5.6", "8.1", "9.1", "11.2", "12.5"] },
    { "id": 10, "tasks": ["8.2", "9.2", "10.1", "11.3", "13.1"] },
    { "id": 11, "tasks": ["8.3", "10.2", "11.4", "12.6", "12.7", "13.2", "13.4"] },
    { "id": 12, "tasks": ["8.4", "11.5", "13.3", "13.5", "13.6"] },
    { "id": 13, "tasks": ["15.1", "15.2", "15.3", "15.4", "15.5", "15.7", "15.8"] },
    { "id": 14, "tasks": ["15.6", "15.9", "15.10", "15.11", "15.12", "15.13", "15.14", "15.15"] },
    { "id": 15, "tasks": ["15.16", "16.1", "16.2", "16.3"] },
    { "id": 16, "tasks": ["16.4"] }
  ]
}
```
