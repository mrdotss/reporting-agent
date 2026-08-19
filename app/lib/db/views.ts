import type {
  ConnectedSubscription,
  FidelityTier,
  ReportRun,
  ReportTemplate,
  ReportTemplateVersion,
  ReportVerification,
  RunErrorCode,
  RunStatus,
  SubscriptionStatus,
  VerificationStatus,
} from "@/lib/db/schema"
import { maskSubscriptionId } from "@/lib/validation/mask"
import type {
  DriftSample,
  Finding,
  FindingSeverity,
  ReplayOutcome,
  VerificationCounts,
} from "@/lib/verifications/result"

/**
 * The browser-safe projections — the **only** shapes allowed to cross to the
 * client (Requirements 10.1, 10.2, 10.8, 43.9).
 *
 * Five projections live here: {@link ConnectedSubscriptionView}, {@link RunView},
 * {@link TemplateView}, {@link TemplateVersionView} and {@link VerificationView}
 * — one per secret-bearing or otherwise-not-fully-browser-safe table this spec
 * touches (Requirement 43.9), plus {@link FindingView}, {@link ReplayView} and
 * {@link DriftSampleView} as the shapes `VerificationView`'s own fields are made
 * of rather than table projections of their own.
 *
 * Two deliberate absences, both load-bearing:
 *
 * **No `import "server-only"`.** Every other module that touches the database
 * carries it, and this one must not. It opens no connection, reads no
 * environment variable and holds no secret — it is a pure function over a plain
 * row object — while its *output* is the thing designed to reach the browser.
 * Marking it server-only would make the module that defines the browser-safe
 * shape the one module the browser may not name. It is also the boundary the
 * guard draws: `test/boundaries.static.test.ts` sweeps every
 * **connection-opening** module under `lib/db/` (Requirement 6.1), so `views.ts`
 * sits outside that set on purpose rather than by omission.
 *
 * **No runtime import of `lib/db/schema.ts`.** The row types come in through
 * `import type`, so they are erased at build time and a client component naming
 * `ConnectedSubscriptionView` does not drag `drizzle-orm/pg-core` into its
 * bundle. Erased or not, they are *inferred* from the table — never restated —
 * because a hand-written row type is how a column that was added to the table
 * quietly fails to appear in the projection guard's key set.
 */

// --- Masking ----------------------------------------------------------------

/**
 * Masking lives in `lib/validation/mask.ts` and is re-exported here.
 *
 * It moved there when `lib/validation/*` landed, and the re-export is not
 * politeness: this module is where a reader looks for the rule that keeps a
 * subscription id out of the browser, and every existing importer of
 * `@/lib/db/views` keeps working. What matters is that there is exactly **one**
 * implementation — a second one is how "all but the last 4" comes to mean two
 * different things in the projection and in a component that formats an id.
 */
export {
  SUBSCRIPTION_ID_MASK_CHAR,
  SUBSCRIPTION_ID_VISIBLE_CHARS,
  maskSubscriptionId,
} from "@/lib/validation/mask"

// --- ConnectedSubscriptionView ----------------------------------------------

/**
 * Requirement 10.1 — exactly these seven keys, and the set is **closed**.
 *
 * `connected_subscriptions` carries thirteen columns, and seven of them reach
 * this shape — `subscription_id` only through the mask. The other six are
 * dropped by construction rather than by filtering: three are secrets
 * (`tenant_id`, `client_id`, `client_secret_enc`), one is
 * `log_analytics_workspace_id` (Requirement 10.3), and `user_id` and
 * `created_at` are simply not the browser's business — the signed-in user
 * already knows who they are, and echoing their id back gives a client-side
 * ownership check something to get wrong.
 *
 * `fidelityTier` and `status` are the schema's enum unions, imported rather than
 * spelled out, so a value added to a Postgres enum widens this type instead of
 * silently disagreeing with it.
 */
export type ConnectedSubscriptionView = {
  id: string
  displayName: string
  maskedSubscriptionId: string
  scopeVerified: boolean
  /** ISO 8601, UTC — see {@link toConnectedSubscriptionView}. */
  secretExpiresAt: string
  fidelityTier: FidelityTier
  status: SubscriptionStatus
}

/**
 * Project a `connected_subscriptions` row to the shape the browser may see
 * (Requirements 10.2, 10.3, 10.4).
 *
 * `secretExpiresAt` is serialized here, as **ISO 8601 in UTC**, rather than
 * passed through as the row's `Date`. The two delivery paths disagree about
 * `Date`: a server component's props carry one across intact, while a route
 * handler's `JSON.stringify` turns it into a string. A `Date`-typed field would
 * therefore be accurate on one path and a lie on the other. Choosing the string
 * up front makes both paths agree, and `toISOString()` is the one serialization
 * that is unambiguous about its offset.
 */
export function toConnectedSubscriptionView(
  row: ConnectedSubscription
): ConnectedSubscriptionView {
  return {
    id: row.id,
    displayName: row.displayName,
    maskedSubscriptionId: maskSubscriptionId(row.subscriptionId),
    scopeVerified: row.scopeVerified,
    secretExpiresAt: row.secretExpiresAt.toISOString(),
    fidelityTier: row.fidelityTier,
    status: row.status,
  }
}

// --- RunView ----------------------------------------------------------------

/**
 * The one artifact this spec's pipeline produces, and the only object
 * `artifactKeys` can name.
 */
export const SNAPSHOT_ARTIFACT_FILENAME = "snapshot.json"

/**
 * The S3 key of a run's snapshot: `<actor_id>/snapshots/<runId>/snapshot.json`,
 * where `actor_id` **is** `report_runs.user_id`.
 *
 * A named function rather than a template literal inlined into
 * {@link toRunView}, because this layout is load-bearing in three places that
 * must agree character for character — the Snapshot_Builder writes it, the gap
 * list reads it, and download authorization compares its **first segment**
 * against the signed-in user's id. Three copies of a path template is how the
 * authorization check ends up guarding a key nothing writes.
 *
 * Pure, and a key: no bucket, no scheme, no query string, no signature.
 */
export function snapshotArtifactKey(userId: string, runId: string): string {
  return `${userId}/snapshots/${runId}/${SNAPSHOT_ARTIFACT_FILENAME}`
}

/**
 * The two artifacts a consultant may download, as `agent/.../artifacts.py` names
 * them (Requirement 43.1).
 *
 * The ledger, the AST, the prose bundle and the emitted HTML are written under the
 * same prefix and are deliberately **absent**: they exist for re-verification and for
 * the in-app reading view, no `report_file` event names them, and no download control
 * should reach them.
 */
export const DOWNLOADABLE_LEAF_NAMES = ["report.docx", "report.pdf"] as const

export type DownloadableLeafName = (typeof DOWNLOADABLE_LEAF_NAMES)[number]

/**
 * The S3 key of one of a run's report artifacts:
 * `<actor_id>/reports/<runId>/<leaf>` (Requirement 43.1).
 *
 * Beside {@link snapshotArtifactKey} for the reason that function records: this layout
 * has to agree character for character across the three places that touch it — the
 * runtime writes it, this projection names it, and download authorization compares
 * its **first two segments**. `lib/runs/artifacts.ts` re-exports this rather than
 * declaring a second copy, so there is one template rather than a template and a
 * lookalike.
 */
export function reportArtifactKey(
  userId: string,
  runId: string,
  leaf: DownloadableLeafName
): string {
  return `${userId}/reports/${runId}/${leaf}`
}

/**
 * Requirements 37.5, 43.4 — exactly these **seventeen** keys (was fourteen),
 * and the set is **closed**.
 *
 * `report_runs` carries twenty-three columns. Eleven pass through unchanged,
 * one (`artifactKeys`) is computed from two of them, three
 * (`templateName`, `templateVersion`, `verificationStatus`) are resolved by
 * the caller from other tables and passed in as {@link RunViewExtras} rather
 * than read from this row, and **ten are dropped**: seven that Requirement
 * 37.6 names — `progress_token_hash`, `claimed_by`, `dedupe_key`, `scope`,
 * `progress_current`, `progress_total`, `progress_label` — plus `claimed_at`,
 * `phase_deadline` and `user_id`.
 *
 * `progress_token_hash` is dropped as a **credential**, not as noise. The token
 * it hashes authorizes writes to the run state machine, so disclosing it lets
 * someone mark a run `completed` — it gets the session-token treatment.
 *
 * **The three in-flight progress columns are dropped on purpose, and the key set
 * grew by three for an unrelated reason.** `progress_current`, `progress_total`
 * and `progress_label` exist so a determinate bar has a source, but the
 * **relay** is that source's delivery path: it reads the row each poll and
 * emits a `progress` event. A reconnecting client therefore recovers the bar on
 * the relay's next 2-second poll rather than from a projected field, so adding
 * the three columns to `report_runs` changed neither this shape nor its guard.
 *
 * **The three added keys are not columns on this row at all.** `templateName`
 * and `templateVersion` describe the `report_template_versions` /
 * `report_templates` rows `report_runs.template_version_id` points at, and
 * `verificationStatus` describes the latest `report_verifications` row for
 * this run — a different table this row carries no column for. All three
 * therefore arrive as {@link RunViewExtras}, resolved by whichever caller
 * already holds (or can cheaply read) that context, rather than by this
 * function reaching across tables itself: {@link toRunView} stays a pure
 * projection over one row plus the values its caller supplies, the same shape
 * every other function in this module has.
 *
 * **Why `templateName` is `string | null` rather than the `string` a first
 * reading of the design might suggest.** `report_runs.template_version_id`
 * is nullable (see `lib/db/schema.ts`'s `report_runs_template_version_id_ck`):
 * a foundation-era row created before template pinning existed carries no
 * pinned version and therefore names no template. `null` is the honest answer
 * for that row — inventing a placeholder name would be exactly the kind of
 * fictitious pin the partial CHECK's own design note refuses to allow. A row
 * created after template pinning lands (task 13.1) always carries a
 * `template_version_id` and its resolved `templateName` is a real,
 * non-empty string; the type stays nullable because both rows share this one
 * shape.
 *
 * `status` and `errorCode` are the schema's enum unions, imported rather than
 * spelled out, so a value added to a Postgres enum widens this type instead of
 * silently disagreeing with it.
 */
export type RunView = {
  id: string
  connectedSubscriptionId: string
  status: RunStatus
  /** Non-null exactly when `status` is `failed` — see `report_runs_error_code_ck`. */
  errorCode: RunErrorCode | null
  errorMessage: string | null
  /** `YYYY-MM-DD`, a **local** calendar date in `timezone`, never an instant. */
  periodStart: string
  periodEnd: string
  /** IANA zone name; decides local-day bucketing, so it is not cosmetic. */
  timezone: string
  resourceCount: number | null
  gapCount: number | null
  snapshotId: string | null
  /** S3 object **keys** only (Requirement 37.5) — never a presigned URL. */
  artifactKeys: string[]
  /** ISO 8601, UTC — see {@link toRunView}. */
  createdAt: string
  updatedAt: string
  /**
   * The pinned template's name, or `null` for a foundation-era row that pins
   * no version — see {@link toRunView}'s docstring.
   */
  templateName: string | null
  /** The pinned `report_template_versions.version`, or `null` for the same reason. */
  templateVersion: number | null
  /**
   * The latest `report_verifications.status` for this run, or `null` when the
   * run carries no verification result yet (Requirement 43.4). Never
   * collapsed into a boolean: "not yet verified" and "verified and failed"
   * are both real, distinct answers a caller must be able to tell apart —
   * see `lib/verifications/store.ts#readLatestVerificationStatus`, which this
   * field mirrors.
   */
  verificationStatus: VerificationStatus | null
}

/**
 * What {@link toRunView} needs that is not a column of the `report_runs` row
 * itself — resolved by the caller from `report_templates` /
 * `report_template_versions` (the pinned template) and from
 * `report_verifications` (the latest attempt), because this module reaches no
 * table other than the one each function is projecting.
 *
 * Every field is independently nullable, and for a different reason each:
 * `templateName` / `templateVersion` are `null` for a foundation-era row with
 * no `template_version_id` to resolve (see {@link RunView}), while
 * `verificationStatus` is `null` for **every** row today — no code path in
 * this spec's foundation drives a run as far as `verifying`, so no caller can
 * honestly supply anything but `null` for it yet. That is expected, not a
 * gap this task leaves open: task 13.1 teaches the enqueue path to resolve a
 * `template_version_id`, and task 11.5 teaches the pipeline to reach
 * `verifying`, and only then does a caller have a non-null value to resolve
 * either field from. Passing `null` here today is the honest answer, not a
 * placeholder standing in for one.
 */
export type RunViewExtras = {
  readonly templateName: string | null
  readonly templateVersion: number | null
  readonly verificationStatus: VerificationStatus | null
}

/**
 * All three fields absent — the honest answer for a run that genuinely has none.
 *
 * This constant used to be `NO_RUN_VIEW_EXTRAS`, passed by **every**
 * caller because none could resolve any of the three: `template_version_id` was
 * null until task 13.1 and nothing reached `verifying` until task 11.5. Both
 * landed, `lib/runs/detail.ts` performs the join, and every caller now passes a
 * resolved value.
 *
 * What is left is the fallback: a foundation-era run pinned to no version, or a
 * row whose extras the batch resolver did not return. Renamed rather than
 * deleted, because `?? NO_RUN_VIEW_EXTRAS` at a call site says "this row has none" where
 * `?? UNRESOLVED_...` would say "nobody has taught this page to look yet",
 * which stopped being true.
 */
export const NO_RUN_VIEW_EXTRAS: RunViewExtras = Object.freeze({
  templateName: null,
  templateVersion: null,
  verificationStatus: null,
})

/**
 * Project a `report_runs` row, plus the template and verification context its
 * caller resolved, to the shape the browser may see (Requirements 37.5, 37.6,
 * 43.4, 40.4).
 *
 * `periodStart` and `periodEnd` pass straight through: the column is `date` in
 * `mode: "string"`, so it is already a plain `YYYY-MM-DD` on both sides of the
 * driver. `createdAt` and `updatedAt` are serialized to **ISO 8601 in UTC**, the
 * same decision {@link toConnectedSubscriptionView} makes for `secretExpiresAt`
 * and for the same reason: a `Date` survives a server component's props intact
 * and becomes a string through a route handler's `JSON.stringify`, so a
 * `Date`-typed field would be accurate on one delivery path and a lie on the
 * other.
 *
 * **`userId` is not a key of this view, yet it reaches the serialization inside
 * `artifactKeys` on a completed run.** That is the design's intent, not a leak
 * that slipped through: the key's first segment *is* the actor id, and download
 * authorization is an exact first-segment comparison against the signed-in
 * user's id. Stripping it would leave a key that authorizes against nothing.
 * It discloses nothing to its recipient either — every `report_runs` read is
 * scoped by `user_id`, so the only browser that can hold this view is already
 * the user whose id it carries. The projection guard asserts the narrower fact
 * that matters: `userId` appears **only** within `artifactKeys`, and only there.
 *
 * ## `artifactKeys` — one gate that stays as it was, and one that is not built yet
 *
 * `artifactKeys` carries **two logically distinct gates that happen to write
 * into the same array**, and this task changes only one of their inputs:
 *
 *   * **The snapshot key's gate is `row.status === "completed"`, unchanged.**
 *     The snapshot is written during collection — well before a document
 *     exists to verify — so gating it on `extras.verificationStatus` would be
 *     wrong on its own terms: a `completed` snapshot-only run (the shape the
 *     foundation spec's own tests still exercise) would then show no artifact
 *     at all despite having one, for a document that was never going to be
 *     rendered in the first place. Requirement 40.4's download gate is about
 *     the **report** artifacts (the `.docx` and `.pdf`), not the snapshot.
 *   * **The report artifacts' gate is `extras.verificationStatus === "pass"`,
 *     and it composes with the snapshot gate rather than replacing it** — this
 *     is Requirement 40.4 implemented in the projection rather than in a
 *     component, so no shape exists in which a browser holds a `.docx` or
 *     `.pdf` key for a run whose document was never proven. The two keys come
 *     from {@link reportArtifactKey}, declared beside
 *     {@link snapshotArtifactKey} for the reason that function records: the
 *     layout has to agree character for character with the runtime that writes
 *     it and the predicate that authorizes it.
 *
 * A note worth keeping, because it explains why this is one expression rather
 * than a prop some component honours: `DownloadCard` renders one control per
 * downloadable key it is handed, so a run whose verification failed hands it
 * none and it renders nothing. The gate is therefore not something a component
 * can forget — and `app/api/artifact-url/route.ts` re-checks the stored status
 * anyway, because a control that is not rendered is not a control that cannot
 * be reached.
 */
export function toRunView(row: ReportRun, extras: RunViewExtras): RunView {
  return {
    id: row.id,
    connectedSubscriptionId: row.connectedSubscriptionId,
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    timezone: row.timezone,
    resourceCount: row.resourceCount,
    gapCount: row.gapCount,
    snapshotId: row.snapshotId,
    artifactKeys:
      row.status === "completed"
        ? [
            snapshotArtifactKey(row.userId, row.id),
            // Requirement 40.4 implemented in the projection rather than in a
            // component: the two report keys appear only for a run whose stored
            // verification **passed**, so no shape exists in which a browser holds a
            // `.docx` or `.pdf` key for a document that was never proven. The two
            // gates compose — a `completed` snapshot-only run still shows its
            // snapshot, because the snapshot is written during collection, long
            // before there is a document to verify.
            ...(extras.verificationStatus === "pass"
              ? DOWNLOADABLE_LEAF_NAMES.map((leaf) =>
                  reportArtifactKey(row.userId, row.id, leaf)
                )
              : []),
          ]
        : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    templateName: extras.templateName,
    templateVersion: extras.templateVersion,
    verificationStatus: extras.verificationStatus,
  }
}

// --- TemplateView ------------------------------------------------------------

/**
 * Requirement 43.9 — exactly these eight keys, and the set is **closed**.
 *
 * `report_templates` carries eight columns of its own, and this projection is
 * not a straight pass-through of them: `current_version_id` — an internal FK,
 * meaningless to a browser on its own — is replaced by the two facts a
 * templates-list screen actually wants from it, `currentVersion` (the version
 * *number*) and `currentVersionSha256` (its digest), both resolved by the
 * caller from the `report_template_versions` row that id names. `user_id` is
 * dropped for the same reason {@link RunView} drops it as a key: the
 * signed-in user already knows who they are.
 *
 * **`draftDefinition` becomes `hasDraft: boolean`, never the draft itself.**
 * A template's draft is a full block-tree definition — arbitrarily large, and
 * not yet validated (`saveDraft` persists it whether or not it satisfies the
 * at-least-one-block rule). The list screen this view serves (Requirement
 * 43.9's "no other shape") needs only "does this template have unsaved wizard
 * progress", never the tree itself; a template's `/templates/[id]/edit` route
 * reads the full draft directly from `getTemplate`, server-side, rather than
 * through this projection.
 *
 * Templates carry no secret of their own — no tenant id, no client id, no
 * Azure resource id anywhere in a definition (Requirement 43.9's "one
 * browser-safe projection per secret-bearing table" still applies to this
 * table structurally, even though nothing on it is a credential) — so this
 * projection's job is narrower than {@link ConnectedSubscriptionView}'s: it
 * exists to keep the *shape* closed and reviewed, not to keep a value out.
 */
export type TemplateView = {
  id: string
  name: string
  description: string
  /** The pinned version number of `currentVersionId`, or `null` before step 7 of the wizard. */
  currentVersion: number | null
  /** That same version's `definitionSha256`, or `null` for the same reason. */
  currentVersionSha256: string | null
  /** Whether `draft_definition` is non-null — never the draft's own content. */
  hasDraft: boolean
  createdAt: string
  updatedAt: string
}

/**
 * What {@link toTemplateView} needs beyond the `report_templates` row: the
 * `report_template_versions` row `currentVersionId` names, or `null` when a
 * template has no version yet.
 *
 * A `Pick` rather than the full row, so a caller reading only these two
 * columns (rather than the version's `definition` jsonb blob, which this view
 * never needs) is not made to look like it forgot to select the rest.
 */
export type TemplateViewCurrentVersion = Pick<
  ReportTemplateVersion,
  "version" | "definitionSha256"
>

/**
 * Project a `report_templates` row, plus its current version's number and
 * digest, to the shape the browser may see (Requirement 43.9).
 *
 * `currentVersion` is the caller's responsibility to resolve consistently
 * with `row.currentVersionId` — passing `null` while `currentVersionId` is
 * set (or the reverse) is a caller bug this pure function cannot detect,
 * exactly as {@link toRunView} trusts its own `extras` to have been resolved
 * against the row it describes.
 */
export function toTemplateView(
  row: ReportTemplate,
  currentVersion: TemplateViewCurrentVersion | null
): TemplateView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    currentVersion: currentVersion?.version ?? null,
    currentVersionSha256: currentVersion?.definitionSha256 ?? null,
    hasDraft: row.draftDefinition !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// --- TemplateVersionView ------------------------------------------------------

/**
 * Requirement 43.5 — exactly these four keys, and the set is **closed**.
 *
 * `report_template_versions` carries five columns; this drops **two**:
 * `templateId`, because it is redundant rather than sensitive — a caller
 * listing a template's versions already knows which template it asked for,
 * so restating the id on every entry would be noise, not information — and
 * `definition`, the full jsonb block tree, because a version list is
 * rendered as "version 3 · `a1b2…` · 2 hours ago" (see `templates/page.tsx`,
 * task 13.2), never as the tree itself; a caller that actually needs the
 * definition reads it through `readVersion`, server-side, one version at a
 * time.
 *
 * Carries **no field of `connected_subscriptions`**, which is trivially true
 * — a template version has no relationship to a subscription at all — and is
 * asserted anyway in the Projection_Guard (Requirement 43.5), because the
 * interesting claim is about the *shape* this projection is capable of
 * carrying, not about what today's row happens to contain.
 */
export type TemplateVersionView = {
  id: string
  version: number
  definitionSha256: string
  createdAt: string
}

/** Project a `report_template_versions` row (Requirement 43.5). */
export function toTemplateVersionView(
  row: ReportTemplateVersion
): TemplateVersionView {
  return {
    id: row.id,
    version: row.version,
    definitionSha256: row.definitionSha256,
    createdAt: row.createdAt.toISOString(),
  }
}

// --- VerificationView ---------------------------------------------------------

/**
 * The browser-safe mirror of one {@link Finding} (Requirement 43.9).
 *
 * `Finding` is validated at the app boundary as `z.looseObject` — see
 * `lib/verifications/result.ts`'s docstring — specifically so a finding type
 * introduced by a newer agent build still parses at an older app's boundary.
 * This view mirrors every locating field `findingSchema` currently declares,
 * camelCased to match every other projection in this module rather than left
 * in the artifact's own snake_case, and drops none of them: there is nothing
 * on `Finding` that is secret or unbounded (Requirement 43.9's "browser-safe"
 * is about *shape*, not truncation — see the paragraph below). A field a
 * *future* finding type invents that `findingSchema` has not been taught
 * about yet does not survive this mirror; teaching the Verifier_Panel task
 * (13.7) to recognize a genuinely new locating field is that task's problem
 * to solve when a new blocking type actually needs one, not a reason to make
 * this projection an open bag today.
 *
 * **This view carries no unbounded text, and it is not this projection's job
 * to enforce that.** Requirement 43.7 puts the 200-character excerpt
 * truncation on the *agent*, before the verification-result artifact is ever
 * written — `message`, `substring`, `formatted`, `expected` and `observed`
 * arrive here already bounded. A truncation step in this function would be
 * redundant at best and, at worst, would let a future caller believe *this*
 * is where the bound is enforced and relax the agent-side guarantee.
 */
export type FindingView = {
  type: string
  severity: FindingSeverity
  message?: string
  astPath?: string
  blockId?: string
  tableId?: string
  rowKey?: string
  columnKey?: string
  matchCount?: number
  formatted?: string
  expected?: string
  observed?: string
  substring?: string
  region?: string
  paragraphOrdinal?: number
  resourceId?: string
  snapshotPath?: string
}

/** Project one {@link Finding} to its browser-safe mirror — see {@link FindingView}. */
export function toFindingView(finding: Finding): FindingView {
  const view: FindingView = {
    type: finding.type,
    severity: finding.severity,
  }

  if (finding.message !== undefined) view.message = finding.message
  if (finding.ast_path !== undefined) view.astPath = finding.ast_path
  if (finding.block_id !== undefined) view.blockId = finding.block_id
  if (finding.table_id !== undefined) view.tableId = finding.table_id
  if (finding.row_key !== undefined) view.rowKey = finding.row_key
  if (finding.column_key !== undefined) view.columnKey = finding.column_key
  if (finding.match_count !== undefined) view.matchCount = finding.match_count
  if (finding.formatted !== undefined) view.formatted = finding.formatted
  if (finding.expected !== undefined) view.expected = finding.expected
  if (finding.observed !== undefined) view.observed = finding.observed
  if (finding.substring !== undefined) view.substring = finding.substring
  if (finding.region !== undefined) view.region = finding.region
  if (finding.paragraph_ordinal !== undefined) {
    view.paragraphOrdinal = finding.paragraph_ordinal
  }
  if (finding.resource_id !== undefined) view.resourceId = finding.resource_id
  if (finding.snapshot_path !== undefined) {
    view.snapshotPath = finding.snapshot_path
  }

  return view
}

/** The browser-safe mirror of {@link ReplayOutcome}, camelCased. */
export type ReplayView = {
  possible: boolean
  recomputedSha256?: string
  storedSha256?: string
  objectsFolded: number
  objectsNamed: number
}

function toReplayView(replay: ReplayOutcome): ReplayView {
  const view: ReplayView = {
    possible: replay.possible,
    objectsFolded: replay.objects_folded,
    objectsNamed: replay.objects_named,
  }

  if (replay.recomputed_sha256 !== undefined) {
    view.recomputedSha256 = replay.recomputed_sha256
  }
  if (replay.stored_sha256 !== undefined) {
    view.storedSha256 = replay.stored_sha256
  }

  return view
}

/** The browser-safe mirror of {@link DriftSample}, camelCased. */
export type DriftSampleView = {
  n: number
  method: string
  seed: string
  notRequeried: string[]
}

function toDriftSampleView(driftSample: DriftSample): DriftSampleView {
  return {
    n: driftSample.n,
    method: driftSample.method,
    seed: driftSample.seed,
    notRequeried: driftSample.not_requeried,
  }
}

/**
 * Requirement 43.9 — exactly these twelve keys, and the set is **closed**.
 *
 * `report_verifications` carries thirteen columns; this drops **`run_id`**
 * (the caller already knows which run's verification it read),
 * **`template_version_id`** (already surfaced on `RunView.templateVersion` —
 * restating it here would be the same fact reachable through two projections
 * that could silently disagree), **`attempt_id`** (an internal identifier the
 * Verification_Panel has no use for: "this is attempt 3" is presented from
 * `latestForRun`'s row *count*, not from the winning attempt's own id — see
 * `lib/verifications/store.ts`), and **`artifact_key`** (the S3 pointer to
 * this row's own source artifact; nothing in this spec's design ever
 * presents that artifact to a browser or mints a URL for it — the browser
 * sees the report's `.docx` and `.pdf` through `RunView.artifactKeys`
 * instead, a completely different pair of objects).
 *
 * `findings` is split into `blockingFindings` and `advisoryFindings` rather
 * than passed through as one ordered array with a `severity` tag per entry.
 * Requirement 39.3 and 39.5 present them in **separate regions** — blocking
 * findings drive the fail state, advisory findings never do — so the
 * partition this view performs once is the partition the panel would
 * otherwise have to recompute on every render.
 */
export type VerificationView = {
  id: string
  status: VerificationStatus
  figureCount: number
  snapshotSha256: string
  docxSha256: string
  pdfSha256: string
  replay: ReplayView
  driftSample: DriftSampleView
  blockingFindings: FindingView[]
  advisoryFindings: FindingView[]
  counts: VerificationCounts
  createdAt: string
}

/** Project a `report_verifications` row (Requirements 36.1, 43.9). */
export function toVerificationView(row: ReportVerification): VerificationView {
  return {
    id: row.id,
    status: row.status,
    figureCount: row.figureCount,
    snapshotSha256: row.snapshotSha256,
    docxSha256: row.docxSha256,
    pdfSha256: row.pdfSha256,
    replay: toReplayView(row.replay),
    driftSample: toDriftSampleView(row.driftSample),
    blockingFindings: row.findings
      .filter((finding) => finding.severity === "blocking")
      .map(toFindingView),
    advisoryFindings: row.findings
      .filter((finding) => finding.severity === "advisory")
      .map(toFindingView),
    counts: row.counts,
    createdAt: row.createdAt.toISOString(),
  }
}
