import { z } from "zod"

/**
 * The zod schema for the verification-result artifact (Requirements 36.1,
 * 36.2, 36.3, 36.5, 36.6, 36.7, 36.8).
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no clock, no
 * environment: a parsed value in, a validated value out. This is the shape
 * `verify/verifier.py` writes to `reports/<runId>/verification-<attemptId>.json`
 * (see `agentcore-integration.md` steering and `design.md`'s "The verification
 * result document"), and it is read back at the app boundary in exactly one
 * place: the internal callback route (`POST
 * /api/internal/runs/[runId]/verification`, task 11.5) parses the artifact the
 * callback body points at, with **this** schema, before `lib/verifications/store.ts`
 * inserts a row from it. Everywhere else in `app/` that touches a verification
 * result reads the already-inserted, already-typed row — this module is the one
 * seam where the agent's Python output becomes a value TypeScript trusts.
 *
 * ## One shape, three consumers, and why this schema follows the wire shape
 * rather than the table
 *
 * The design document is explicit that one shape serves three consumers: the
 * artifact under `reports/<runId>/`, the `verification` SSE event's payload, and
 * — after this schema parses it — the `report_verifications` row. The
 * `report_verifications` table (task 2.2, `lib/db/schema.ts`) carries **three**
 * digest columns — `snapshot_sha256`, `docx_sha256`, `pdf_sha256` — not four. The
 * artifact itself carries a **fourth**, `ledger_sha256` (design.md's worked
 * example under "The verification result document"): the SHA-256 of the
 * serialized Figure_Ledger the render used, recorded so a later re-verification
 * can confirm it is reading the same ledger. That digest has no dedicated
 * column on `report_verifications` — the table's own comment block explains why
 * only three digests are named there (Requirement 36.6 spells out exactly
 * `snapshot_sha256`, `docx_sha256` and `pdf_sha256`) and gives `ledger_sha256` no
 * fourth slot.
 *
 * This schema validates the artifact as the agent actually writes it, digest
 * and all four, because rejecting a field the artifact legitimately carries
 * would make every real verification result fail to parse. `lib/verifications/store.ts`
 * is where the reconciliation happens: it reads `parsed.ledgerSha256` and simply
 * does not pass it to the insert, because there is no column for it to land in.
 * Validate-the-artifact-in-full and persist-the-three-columns-the-table-has are
 * two different jobs, and splitting them across `result.ts` and `store.ts`
 * keeps neither one silently dropping a field the other module owns.
 *
 * ## The `findings` list, and why `type` is a string rather than an enum
 *
 * Every finding carries its own `severity` — `"blocking" | "advisory"` — rather
 * than the reader deriving it from `type`. That is what lets an older app build
 * meet a finding type introduced by a newer agent build and still classify and
 * count it correctly: the answer to "is this blocking" travels with the finding
 * instead of living in a lookup table this module would have to keep in sync
 * with `verify/findings.py`'s glossary by hand.
 *
 * The same forward-compatibility reasoning is why `type` is validated as a
 * non-empty string and **not** a closed `z.enum([...])` of the twenty
 * currently-declared types (sixteen blocking, four advisory — see
 * `verify/findings.py`). A closed enum would make this schema itself the thing
 * that breaks compatibility: the day the agent's finding vocabulary gains a
 * twenty-first type, every verification result carrying one would fail to
 * parse at the app boundary, turning a routine agent-side addition into an
 * app-side outage. `findingSchema` is `z.looseObject(...)` for the identical
 * reason at the whole-object level — a finding may carry a locating field this
 * schema has not been taught about yet (a new blocking type is free to invent
 * its own locating shape), and an unrecognized field must not make the finding,
 * and therefore the whole result, unparseable.
 */

// --- Shared shapes ------------------------------------------------------

/**
 * A SHA-256 digest, lowercase hex.
 *
 * The same shape `report_runs.snapshot_id` and the progress callback's
 * `snapshot_id` field are validated against elsewhere in this codebase
 * (`lib/runs/progress.ts`) — one digest shape, reused rather than restated.
 */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/)

/** Requirement 36.1 — the two values a verification result may carry, never a third. */
export const verificationResultStatusValues = ["pass", "fail"] as const
export type VerificationResultStatus =
  (typeof verificationResultStatusValues)[number]

/** Requirement 25.6 — severity travels on the finding, not derived by the reader. */
export const findingSeverityValues = ["blocking", "advisory"] as const
export type FindingSeverity = (typeof findingSeverityValues)[number]

/**
 * The sixteen blocking and four advisory finding types `verify/findings.py`
 * currently declares (`design.md`, Req 44.1's enumeration).
 *
 * Exported as **documentation and a typed convenience**, never as the bound
 * `findingSchema.type` validates against — see the module docstring. A caller
 * that wants to switch on a known type can narrow against this array; a
 * `findingSchema` parse never rejects a string absent from it.
 */
export const KNOWN_BLOCKING_FINDING_TYPES = [
  "unmatched_prose_token",
  "table_anchor_missing",
  "table_anchor_unexpected",
  "table_cell_mismatch",
  "table_column_unresolved",
  "table_row_unresolved",
  "duplicate_table_anchor",
  "table_rows_absent",
  "ledger_entry_unrendered",
  "chart_table_missing",
  "chart_hash_mismatch",
  "replay_hash_mismatch",
  "coverage_resource_absent",
  "pdf_figure_missing",
  "scope_unverified",
  "empty_scope",
] as const

export const KNOWN_ADVISORY_FINDING_TYPES = [
  "archive_incomplete",
  "drift_observed",
  "prose_review_finding",
  "fidelity_not_comparable",
] as const

/**
 * One finding — blocking or advisory — carrying its own `severity` plus
 * whichever locating fields the criterion that recorded it declares: an AST
 * path and block id, a table identity with its row and column key, a
 * surviving substring with its paragraph location, or an expected/observed
 * string pair verbatim (design.md's finding-vocabulary passage; Requirements
 * 25.5, 25.6, 25.8, 36.3).
 *
 * `z.looseObject` rather than `z.object`, and deliberately: the locating shape
 * differs by `type` (a `table_cell_mismatch` carries `table_id` / `row_key` /
 * `column_key` / `expected` / `observed`; an `unmatched_prose_token` carries
 * `substring` and a paragraph location; a `coverage_resource_absent` carries
 * `resource_id`), and the fields below are every locating field any
 * currently-declared type uses, offered as optional rather than as a
 * discriminated union keyed on `type` — a union keyed on an open string is not
 * exhaustive, so it would have to carry a catch-all branch anyway, and that
 * branch is exactly what `looseObject` already is. A future finding type that
 * invents a locating field this schema has not named yet still validates: the
 * unknown field passes through rather than being rejected.
 *
 * Every quoted string here is bounded loosely (not the agent's 200-character
 * excerpt truncation restated) — the truncation is the writer's discipline
 * (Requirement 36.3's redaction-and-truncation pass in `verify/verifier.py`),
 * and re-deriving that exact bound here would make this schema start
 * rejecting a correctly-written result the day the agent's constant changes
 * for an unrelated reason. This schema's job is shape, not the agent's own
 * invariant.
 */
export const findingSchema = z.looseObject({
  /** Non-empty and open — see the module docstring for why this is not an enum. */
  type: z.string().min(1),
  severity: z.enum(findingSeverityValues),

  /** A human-readable description, where the recording criterion supplies one. */
  message: z.string().max(2000).optional(),

  /** The AST path a `Figure` or a container node resolves to. */
  ast_path: z.string().min(1).optional(),
  /** The block `id` the finding is attributed to. */
  block_id: z.string().min(1).optional(),

  /** A data table's `w:tblCaption` identity. */
  table_id: z.string().min(1).optional(),
  /** The resolved row's key, within `table_id`. */
  row_key: z.string().optional(),
  /** The resolved column's header text, within `table_id`. */
  column_key: z.string().optional(),
  /** How many columns or rows a key resolved to, when that count is itself the defect. */
  match_count: z.number().int().nonnegative().optional(),

  /** A ledger entry's exact display string. */
  formatted: z.string().optional(),
  /** The string the ledger expected at a resolved position. */
  expected: z.string().optional(),
  /** The string actually found at that position. */
  observed: z.string().optional(),

  /** The surviving substring an `unmatched_prose_token` finding names. */
  substring: z.string().optional(),
  /** `body` | `header` | `footer`, for a paragraph belonging to no block. */
  region: z.string().optional(),
  /** 1-based ordinal within `block_id`, or within `region` when `block_id` is absent. */
  paragraph_ordinal: z.number().int().nonnegative().optional(),

  /** A resource identifier, for a coverage or fidelity-comparison finding. */
  resource_id: z.string().optional(),
  /** A `Figure`'s recorded snapshot pointer, for provenance-carrying findings. */
  snapshot_path: z.string().optional(),
})

export type Finding = z.infer<typeof findingSchema>

/**
 * The replay outcome (Requirement 31.6): the recomputed and stored snapshot
 * digests, the fold count, and whether replay was possible at all.
 *
 * `recomputed_sha256` and `stored_sha256` are optional because a known-
 * incomplete archive — the recorded case is `possible: false` — means replay
 * was never attempted, so there is no recomputed digest to report (Req 31.5,
 * 31.8). `objects_folded` and `objects_named` are still required: they are
 * meaningful even when replay did not run to completion, and a verifier that
 * folded zero objects before finding the archive incomplete still reports
 * that zero honestly rather than omitting the field.
 */
export const replayOutcomeSchema = z.object({
  possible: z.boolean(),
  recomputed_sha256: sha256HexSchema.optional(),
  stored_sha256: sha256HexSchema.optional(),
  objects_folded: z.number().int().nonnegative(),
  objects_named: z.number().int().nonnegative(),
})

export type ReplayOutcome = z.infer<typeof replayOutcomeSchema>

/**
 * The drift sample descriptor (Requirement 34.3): `{n, method, seed}` plus the
 * resources the sampler selected but could not re-query.
 *
 * `n` is capped at 25 — the Drift_Sampler's own bound (Req 34.1) — restated as
 * a schema check because a value above it could not have come from a
 * conforming sampler and is worth rejecting rather than silently trusting.
 * `seed` is recorded so a disputed check is re-runnable identically; it is
 * validated only as a non-empty string because its own shape (32-byte hex, per
 * the property test's generator) is the sampler's concern, not this
 * boundary's.
 */
export const driftSampleSchema = z.object({
  n: z.number().int().nonnegative().max(25),
  method: z.string().min(1),
  seed: z.string().min(1),
  not_requeried: z.array(z.string()).default([]),
})

export type DriftSample = z.infer<typeof driftSampleSchema>

/**
 * The pass-level counts every verification pass contributes (Requirements
 * 27.13, 29.5, 30.7, 32.6, 33.4) — the `counts` jsonb bag.
 *
 * `z.looseObject` with every currently-declared key **optional**: a given
 * result carries the counts the passes that ran actually produced (a result
 * that failed closed on `scope_unverified` before reaching the PDF fidelity
 * gate has no `pdf_entries_checked` to report), and a future pass's count
 * lands here without a schema edit, the same forward-compatibility reasoning
 * as `findingSchema`.
 */
export const verificationCountsSchema = z.looseObject({
  table_anchors_checked: z.number().int().nonnegative().optional(),
  data_tables_resolved: z.number().int().nonnegative().optional(),
  ledger_entries_checked: z.number().int().nonnegative().optional(),
  ledger_entries_rendered: z.number().int().nonnegative().optional(),
  ledger_entries_unrendered: z.number().int().nonnegative().optional(),
  numeric_tokens_extracted: z.number().int().nonnegative().optional(),
  chart_nodes_checked: z.number().int().nonnegative().optional(),
  chart_hashes_matched: z.number().int().nonnegative().optional(),
  union_scope_resources: z.number().int().nonnegative().optional(),
  snapshot_resources: z.number().int().nonnegative().optional(),
  collection_log_entries: z.number().int().nonnegative().optional(),
  pdf_entries_checked: z.number().int().nonnegative().optional(),
  pdf_entries_located: z.number().int().nonnegative().optional(),
  pdf_pages_read: z.number().int().nonnegative().optional(),
  blocking_findings_observed: z.number().int().nonnegative().optional(),
  advisory_findings_observed: z.number().int().nonnegative().optional(),
})

export type VerificationCounts = z.infer<typeof verificationCountsSchema>

// --- The verification-result artifact ---------------------------------

/**
 * The verification-result artifact `verify/verifier.py` writes, and the shape
 * the internal callback route parses the pointed-at S3 object with
 * (Requirements 36.1, 36.2, 36.3, 36.5, 36.6, 36.7, 36.8).
 *
 * `schema_version` is a plain integer rather than a fixed literal: this is the
 * agent's own artifact-schema version (distinct from a template definition's
 * `schema_version`), and pinning this schema to exactly `1` would make a
 * forward-compatible agent change into a parse failure at this boundary. The
 * bound below — an integer ≥ 1 — is the only invariant this reader can state
 * honestly without knowing the agent's own version ceiling.
 *
 * `findings` is validated as **an ordered array**, never re-sorted here: Req
 * 25.8 and 27.14 declare the finding order the agent already produced (up to
 * 1,000 blocking findings in document order plus the total observed count),
 * and re-ordering at the read boundary would silently disagree with the
 * artifact the panel is supposed to reflect exactly.
 */
export const verificationResultSchema = z.object({
  schema_version: z.number().int().min(1),
  attempt_id: z.string().min(1),
  run_id: z.string().min(1),
  template_version_id: z.string().min(1),
  status: z.enum(verificationResultStatusValues),
  figure_count: z.number().int().nonnegative(),

  snapshot_sha256: sha256HexSchema,
  docx_sha256: sha256HexSchema,
  pdf_sha256: sha256HexSchema,
  /**
   * The fourth digest the artifact carries with no dedicated table column —
   * see the module docstring's "one shape, three consumers" section.
   */
  ledger_sha256: sha256HexSchema,

  counts: verificationCountsSchema,
  replay: replayOutcomeSchema,
  drift_sample: driftSampleSchema,
  findings: z.array(findingSchema),
})

export type VerificationResult = z.infer<typeof verificationResultSchema>

/**
 * Every finding in a result whose `severity` is `"blocking"`.
 *
 * A thin, pure helper rather than a second schema: `severity` already carries
 * the classification (that is the whole point — see the module docstring), so
 * splitting blocking from advisory is a filter over the parsed array, not a
 * fact this module needs to re-derive.
 */
export function blockingFindings(result: VerificationResult): Finding[] {
  return result.findings.filter((finding) => finding.severity === "blocking")
}

/** Every finding in a result whose `severity` is `"advisory"`. */
export function advisoryFindings(result: VerificationResult): Finding[] {
  return result.findings.filter((finding) => finding.severity === "advisory")
}
