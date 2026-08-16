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
 * touches (Requirement 43.9), plus {@link FindingView} as the shape one
 * `VerificationView` field is made of rather than a table projection of its own.
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
 * Requirement 37.5 — exactly these fourteen keys, and the set is **closed**.
 *
 * `report_runs` carries twenty-three columns. Thirteen pass through, one
 * (`artifactKeys`) is computed, and **ten are dropped**: seven that Requirement
 * 37.6 names — `progress_token_hash`, `claimed_by`, `dedupe_key`, `scope`,
 * `progress_current`, `progress_total`, `progress_label` — plus `claimed_at`,
 * `phase_deadline` and `user_id`.
 *
 * `progress_token_hash` is dropped as a **credential**, not as noise. The token
 * it hashes authorizes writes to the run state machine, so disclosing it lets
 * someone mark a run `completed` — it gets the session-token treatment.
 *
 * **The three in-flight progress columns are dropped on purpose, and the key set
 * stays at fourteen because of it.** `progress_current`, `progress_total` and
 * `progress_label` exist so a determinate bar has a source, but the **relay** is
 * that source's delivery path: it reads the row each poll and emits a
 * `progress` event. A reconnecting client therefore recovers the bar on the
 * relay's next 2-second poll rather than from a projected field, so adding the
 * three columns to `report_runs` changed neither this shape nor its guard.
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
}

/**
 * Project a `report_runs` row to the shape the browser may see (Requirements
 * 37.5, 37.6).
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
 * `artifactKeys` is **computed, not stored**, and keyed on `status` alone: a
 * `completed` run names its snapshot, every other status names nothing. It is
 * derived from the two ids rather than from `snapshot_id` because the key is
 * positional — the object lives at that path whatever its content hash turns out
 * to be.
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
 */
export function toRunView(row: ReportRun): RunView {
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
        ? [snapshotArtifactKey(row.userId, row.id)]
        : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
