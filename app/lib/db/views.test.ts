import fc from "fast-check"
import { describe, expect, test } from "vitest"

import {
  SNAPSHOT_ARTIFACT_FILENAME,
  SUBSCRIPTION_ID_MASK_CHAR,
  SUBSCRIPTION_ID_VISIBLE_CHARS,
  maskSubscriptionId,
  reportArtifactKey,
  snapshotArtifactKey,
  toConnectedSubscriptionView,
  toFindingView,
  toRunView,
  toTemplateVersionView,
  toTemplateView,
  toVerificationView,
  type RunViewExtras,
  type TemplateViewCurrentVersion,
} from "@/lib/db/views"
import type {
  ConnectedSubscription,
  ReportRun,
  ReportTemplate,
  ReportTemplateVersion,
  ReportVerification,
  RunStatus,
} from "@/lib/db/schema"
import type { Finding } from "@/lib/verifications/result"

/**
 * The Projection_Guard for `ConnectedSubscriptionView` (Requirements 10.1
 * through 10.9).
 *
 * This suite is the enforcement of "a secret cannot leak through a convenience
 * field", so its own failure mode matters more than usual: a guard that passes
 * over an **absent** value proves nothing. Requirement 10.7 is the answer — the
 * row fixture assigns a distinct non-empty value to every secret-bearing column,
 * and each is asserted individually, so a fixture that stopped populating one
 * would fail rather than fall silent.
 *
 * The key-set expectation below is **hard-coded, never imported** from
 * `views.ts`. That is the opposite of the `.env.example` guard, which imports
 * `REQUIRED_ENV_VARS` because it compares a module against a *different*
 * artifact. Here the module under test is the thing being constrained, so a
 * shared list would update itself alongside a new key and the guard would pass
 * while lying — exactly what Requirement 10.6 exists to prevent.
 */

// --- Fixture ----------------------------------------------------------------

/**
 * Requirement 10.7 — distinct, non-empty, and recognisable in a diff. Each is
 * asserted absent from the serialization on its own, so no assertion can pass
 * because a value happened to be empty or undefined.
 */
const TENANT_ID = "fixture-tenant-11111111-1111-1111-1111-111111111111"
const CLIENT_ID = "fixture-client-22222222-2222-2222-2222-222222222222"
const CLIENT_SECRET_ENC = "fixture-client-secret-envelope-3333333333333333"
const WORKSPACE_ID = "fixture-workspace-44444444-4444-4444-4444-444444444444"

/**
 * The subscription id for the strict per-character check (Requirement 10.9),
 * and it is shaped for that check rather than for realism.
 *
 * Requirement 10.9 forbids **any character** of the id other than its final 4
 * from appearing in the serialization — and the serialization is a whole JSON
 * document, not one field. A realistic GUID's leading portion is drawn from
 * `[0-9a-f-]`, and `a`, `d`, `e`, `f`, the digits and `-` all legitimately occur
 * in the key names, in `"baseline"`, and in an ISO 8601 instant. Against a GUID
 * the requirement is therefore unsatisfiable for reasons that have nothing to do
 * with a leak.
 *
 * So the masked portion here uses only `g h j q w z`, which appear in **no** key
 * name and in none of the other fixture values, and the revealed final four are
 * digits. The forbidden set is then genuinely disjoint from everything the
 * document may legitimately contain, the assertion can run over the entire
 * serialization, and it catches a leak through *any* field rather than only
 * through `maskedSubscriptionId`. `REALISTIC_SUBSCRIPTION_ID` below covers the
 * GUID case separately.
 */
const SUBSCRIPTION_ID = "ghjqwzghjqwzghjqwzghjqwzghjqwzgh6789"

/** A real Azure subscription GUID: 36 characters, 32 of them masked. */
const REALISTIC_SUBSCRIPTION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"

/**
 * Typed as the inferred row, so adding a column to `connected_subscriptions`
 * breaks this fixture at `pnpm typecheck` and forces the reviewed decision
 * Requirement 10.6 is after — rather than letting the new column arrive with no
 * verdict on whether it may reach the browser.
 *
 * `id` and `displayName` deliberately avoid `g h j q w z` too; see
 * {@link SUBSCRIPTION_ID}.
 */
function connectedSubscriptionRow(
  overrides: Partial<ConnectedSubscription> = {}
): ConnectedSubscription {
  return {
    id: "sub-0001",
    userId: "user-0001",
    displayName: "Test Customer Subscription",
    subscriptionId: SUBSCRIPTION_ID,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecretEnc: CLIENT_SECRET_ENC,
    scopeVerified: true,
    fidelityTier: "baseline",
    secretExpiresAt: new Date("2027-01-15T08:30:00.000Z"),
    status: "active",
    logAnalyticsWorkspaceId: WORKSPACE_ID,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    // The reviewed decision this fixture's typing exists to force: `updated_at` is
    // the inventory cache's invalidation signal (Requirement 9.2) and is read
    // server-side only. It is **not** projected — the browser has no use for it, and
    // a field in the projection is a field the guard below has to keep proving is
    // safe. Distinct from `createdAt` so a projection that confused the two fails.
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  }
}

/** Requirement 10.1 — the seven keys, sorted, spelled out. */
const CONNECTED_SUBSCRIPTION_VIEW_KEYS = [
  "displayName",
  "fidelityTier",
  "id",
  "maskedSubscriptionId",
  "scopeVerified",
  "secretExpiresAt",
  "status",
]

/**
 * Requirement 10.3 — omitted under **both** spellings. The column names matter
 * as much as the camel-case ones: a projection assembled by spreading a raw
 * query result would carry whichever the driver produced.
 */
const FORBIDDEN_KEYS = [
  "subscription_id",
  "subscriptionId",
  "tenant_id",
  "tenantId",
  "client_id",
  "clientId",
  "client_secret_enc",
  "clientSecretEnc",
  "log_analytics_workspace_id",
  "logAnalyticsWorkspaceId",
  "user_id",
  "userId",
]

/** Code points, so a surrogate pair counts once. */
function characters(value: string): string[] {
  return Array.from(value)
}

/**
 * Arbitrary ids longer than the revealed window, excluding the mask character
 * itself. Without that exclusion `"*abcd"` masks to `"*abcd"` — a genuine fixed
 * point that says nothing about masking and would fail a "never the raw id"
 * assertion for entirely the wrong reason.
 */
const maskableSubscriptionId = fc.string({
  unit: fc
    .string({ unit: "binary", minLength: 1, maxLength: 1 })
    .filter((character) => character !== SUBSCRIPTION_ID_MASK_CHAR),
  minLength: SUBSCRIPTION_ID_VISIBLE_CHARS + 1,
  maxLength: 64,
})

/** The characters Requirement 10.9 forbids: those of `id`, less its final 4. */
function forbiddenCharacters(id: string): string[] {
  const all = characters(id)
  const revealed = new Set(all.slice(-SUBSCRIPTION_ID_VISIBLE_CHARS))

  return [...new Set(all)].filter((character) => !revealed.has(character))
}

// --- maskSubscriptionId -----------------------------------------------------

describe("maskSubscriptionId — Requirement 10.4", () => {
  test.each([
    { length: 0, id: "", expected: "" },
    { length: 1, id: "7", expected: "*" },
    { length: 4, id: "3301", expected: "****" },
    { length: 5, id: "a3301", expected: "*3301" },
    {
      length: 36,
      id: REALISTIC_SUBSCRIPTION_ID,
      expected: `${"*".repeat(32)}3301`,
    },
  ])("length $length masks to $expected", ({ id, expected }) => {
    expect(maskSubscriptionId(id)).toBe(expected)
  })

  test.each(["", "7", "ab", "abc", "3301"])(
    "%j is masked in full because its length is at most 4",
    (id) => {
      // The clause an "all but the last 4" implementation gets wrong: a
      // 4-character id would be published whole, and a 1-character id too.
      const masked = maskSubscriptionId(id)

      expect(masked).toBe(SUBSCRIPTION_ID_MASK_CHAR.repeat(id.length))
      for (const character of characters(id)) {
        expect(masked).not.toContain(character)
      }
    }
  )

  test("a surrogate pair is masked as one character, never split", () => {
    // Slicing by UTF-16 code unit would emit a lone surrogate here — half a
    // character, corresponding to no part of the input, which `JSON.stringify`
    // then carries to the browser as a bare `\udXXX` escape.
    // Eight code points: two astral, then `a b 6 7 8 9`. Four are masked.
    const masked = maskSubscriptionId("\u{1f9ea}\u{1d11e}ab6789")

    expect(masked).toBe("****6789")
    expect(masked).not.toContain("\ud83e")
    expect(masked).not.toContain("\ud834")
  })

  test("every generated id reveals at most its final four code points", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 64 }), (id) => {
        const source = characters(id)
        const masked = characters(maskSubscriptionId(id))

        // Length is preserved, so the masked form does not disclose a shorter
        // or longer id than the real one.
        expect(masked.length).toBe(source.length)

        // The two branches are asserted separately rather than through one
        // `length - 4` expression, because Requirement 10.4's short-id clause is
        // not the general rule with a smaller window — it is the opposite rule.
        // At 4 code points or fewer *nothing* is revealed, so a shared
        // "the trailing four equal the source's trailing four" assertion would
        // be wrong precisely where the requirement is strictest.
        if (source.length <= SUBSCRIPTION_ID_VISIBLE_CHARS) {
          expect(masked.every((c) => c === SUBSCRIPTION_ID_MASK_CHAR)).toBe(
            true
          )
        } else {
          const maskedCount = source.length - SUBSCRIPTION_ID_VISIBLE_CHARS

          expect(
            masked
              .slice(0, maskedCount)
              .every((c) => c === SUBSCRIPTION_ID_MASK_CHAR)
          ).toBe(true)
          expect(masked.slice(maskedCount)).toEqual(source.slice(maskedCount))
        }

        // The security property, stated directly: at most four code points of
        // the input survive into the output.
        expect(
          masked.filter((c) => c !== SUBSCRIPTION_ID_MASK_CHAR).length
        ).toBeLessThanOrEqual(SUBSCRIPTION_ID_VISIBLE_CHARS)
      })
    )
  })

  test("masking is deterministic and takes no input but the id", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 64 }), (id) => {
        expect(maskSubscriptionId(id)).toBe(maskSubscriptionId(id))
      })
    )
  })
})

// --- The projection ---------------------------------------------------------

describe("toConnectedSubscriptionView — Requirements 10.1, 10.2, 10.4", () => {
  test("carries the seven values the browser is allowed to see", () => {
    const view = toConnectedSubscriptionView(connectedSubscriptionRow())

    expect(view).toEqual({
      id: "sub-0001",
      displayName: "Test Customer Subscription",
      maskedSubscriptionId: `${"*".repeat(32)}6789`,
      scopeVerified: true,
      secretExpiresAt: "2027-01-15T08:30:00.000Z",
      fidelityTier: "baseline",
      status: "active",
    })
  })

  test("serializes secretExpiresAt as an ISO 8601 instant in UTC", () => {
    // A string on both delivery paths. Left as a `Date`, the field would survive
    // a server component's props intact and arrive as a string through a route
    // handler's `JSON.stringify`, so the declared type would be right on one
    // path and wrong on the other.
    const view = toConnectedSubscriptionView(connectedSubscriptionRow())

    expect(typeof view.secretExpiresAt).toBe("string")
    expect(view.secretExpiresAt).toBe("2027-01-15T08:30:00.000Z")
    expect(new Date(view.secretExpiresAt).getTime()).toBe(
      new Date("2027-01-15T08:30:00.000Z").getTime()
    )
  })

  test("masks a realistic 36-character subscription GUID to its final four", () => {
    const view = toConnectedSubscriptionView(
      connectedSubscriptionRow({ subscriptionId: REALISTIC_SUBSCRIPTION_ID })
    )

    expect(view.maskedSubscriptionId).toBe(`${"*".repeat(32)}3301`)
    expect(view.maskedSubscriptionId).not.toBe(REALISTIC_SUBSCRIPTION_ID)
  })

  test("projects every fidelity tier and status without narrowing them", () => {
    for (const fidelityTier of ["baseline", "enhanced"] as const) {
      for (const status of ["pending", "active", "disabled"] as const) {
        const view = toConnectedSubscriptionView(
          connectedSubscriptionRow({ fidelityTier, status })
        )

        expect(view.fidelityTier).toBe(fidelityTier)
        expect(view.status).toBe(status)
      }
    }
  })
})

// --- The guard --------------------------------------------------------------

describe("Projection_Guard — Requirements 10.5, 10.6, 10.7, 10.8, 10.9", () => {
  test("the fixture assigns a distinct non-empty value to every secret column", () => {
    // Requirement 10.7, asserted before anything relies on it. Every check
    // below is "this value is absent from the projection", and a check like that
    // passes trivially over an empty or duplicated value.
    const row = connectedSubscriptionRow()
    const secrets = [
      row.subscriptionId,
      row.tenantId,
      row.clientId,
      row.clientSecretEnc,
      row.logAnalyticsWorkspaceId,
    ]

    for (const secret of secrets) {
      expect(secret).toBeTruthy()
      expect(typeof secret).toBe("string")
    }
    expect(new Set(secrets).size).toBe(secrets.length)
  })

  test("the projected key set is exactly the seven reviewed keys", () => {
    // Requirement 10.6. Hard-coded above, so a newly added column cannot reach
    // the browser without an explicit change to this line.
    const view = toConnectedSubscriptionView(connectedSubscriptionRow())

    expect(Object.keys(view).sort()).toEqual(CONNECTED_SUBSCRIPTION_VIEW_KEYS)
  })

  test.each(FORBIDDEN_KEYS)(
    "%s appears in neither the key set nor the serialization",
    (key) => {
      // Requirement 10.3 — under the column name and the camel-case row name
      // alike. Quoted in the serialization check so `"subscriptionId"` is not
      // matched by the legitimate `"maskedSubscriptionId"`.
      const view = toConnectedSubscriptionView(connectedSubscriptionRow())

      expect(Object.keys(view)).not.toContain(key)
      expect(JSON.stringify(view)).not.toContain(`"${key}"`)
    }
  )

  test.each([
    { field: "tenant_id", value: TENANT_ID },
    { field: "client_id", value: CLIENT_ID },
    { field: "client_secret_enc", value: CLIENT_SECRET_ENC },
    { field: "log_analytics_workspace_id", value: WORKSPACE_ID },
  ])("the serialization contains no $field value", ({ value }) => {
    // Requirement 10.5.
    const serialized = JSON.stringify(
      toConnectedSubscriptionView(connectedSubscriptionRow())
    )

    expect(serialized).not.toContain(value)
  })

  test("the serialization contains no character of subscription_id beyond its final four", () => {
    // Requirement 10.9, over the whole document rather than one field — see
    // SUBSCRIPTION_ID for why the fixture's masked portion uses characters that
    // occur nowhere else in the projection.
    const row = connectedSubscriptionRow()
    const serialized = JSON.stringify(toConnectedSubscriptionView(row))
    const forbidden = forbiddenCharacters(row.subscriptionId)

    // Non-vacuity: an id whose every character is among its final four would
    // make the loop below assert nothing.
    expect(forbidden.length).toBeGreaterThan(0)

    for (const character of forbidden) {
      expect(
        serialized.includes(character),
        `${JSON.stringify(character)} of subscription_id reached the projection`
      ).toBe(false)
    }
  })

  test("a realistic GUID's masked portion survives nowhere in the serialization", () => {
    // The GUID complement to the check above. Its leading 32 characters share
    // `a d e f`, digits and `-` with the key names and the ISO instant, so the
    // per-character rule is asserted over `maskedSubscriptionId` and the
    // substring rule over the whole document.
    const row = connectedSubscriptionRow({
      subscriptionId: REALISTIC_SUBSCRIPTION_ID,
    })
    const view = toConnectedSubscriptionView(row)
    const serialized = JSON.stringify(view)

    const masked = characters(REALISTIC_SUBSCRIPTION_ID).slice(0, -4).join("")
    expect(masked).toHaveLength(32)
    expect(serialized).not.toContain(masked)
    expect(serialized).not.toContain(REALISTIC_SUBSCRIPTION_ID)

    const permitted = new Set([
      SUBSCRIPTION_ID_MASK_CHAR,
      ...characters(REALISTIC_SUBSCRIPTION_ID).slice(
        -SUBSCRIPTION_ID_VISIBLE_CHARS
      ),
    ])
    for (const character of characters(view.maskedSubscriptionId)) {
      expect(permitted.has(character)).toBe(true)
    }
  })

  test("no generated subscription id reaches the projection unmasked", () => {
    // Requirement 10.8 as far as this module can enforce it: whatever the id,
    // the projection never carries it whole.
    fc.assert(
      fc.property(maskableSubscriptionId, (subscriptionId) => {
        const view = toConnectedSubscriptionView(
          connectedSubscriptionRow({ subscriptionId })
        )
        const serialized = JSON.stringify(view)
        const revealed = characters(view.maskedSubscriptionId).filter(
          (character) => character !== SUBSCRIPTION_ID_MASK_CHAR
        )

        expect(view.maskedSubscriptionId).not.toBe(subscriptionId)
        expect(revealed.length).toBeLessThanOrEqual(
          SUBSCRIPTION_ID_VISIBLE_CHARS
        )
        expect(serialized).not.toContain(TENANT_ID)
        expect(serialized).not.toContain(CLIENT_ID)
        expect(serialized).not.toContain(CLIENT_SECRET_ENC)
        expect(serialized).not.toContain(WORKSPACE_ID)
        expect(Object.keys(view).sort()).toEqual(
          CONNECTED_SUBSCRIPTION_VIEW_KEYS
        )
      })
    )
  })
})

// ---------------------------------------------------------------------------
// RunView
// ---------------------------------------------------------------------------

/**
 * The Projection_Guard for `RunView` (Requirements 37.5, 37.6, 37.7, 37.11).
 *
 * Appended to this file rather than split into a sibling, because it is the same
 * module's guard under the same two conventions established above — the key set
 * is hard-coded, never imported, and the fixture's secret values are asserted
 * non-empty and distinct before anything relies on their absence. Keeping both
 * projections here also keeps "these are the only two shapes that cross to the
 * browser" readable in one place.
 */

// --- Fixture ----------------------------------------------------------------

/**
 * Requirement 37.11 — the three the criterion names, distinct, non-empty and
 * recognisable in a diff. Each is asserted absent from the serialization on its
 * own, so no assertion can pass because a value happened to be empty.
 *
 * `progress_token_hash` is the one that is a **credential**: the token it hashes
 * authorizes writes to the run state machine, so a disclosure lets someone mark
 * a run `completed`.
 */
const PROGRESS_TOKEN_HASH = "fixture-progress-token-hash-5555555555555555"
const CLAIMED_BY = "fixture-claimed-by-66666666-6666-6666-6666-666666666666"
const DEDUPE_KEY = "fixture-dedupe-key-7777777777777777"

/**
 * Markers for the other four columns Requirement 37.6 drops. `scope` and
 * `progress_label` carry recognisable strings; `progress_current` and
 * `progress_total` are integers, so they get digit runs that occur nowhere else
 * in the projection — not in an id, not in a period, not in an ISO instant.
 */
const SCOPE_MARKER = "rg-fixture-scope-marker-8888"
const PROGRESS_LABEL = "fixture-progress-label-Metrics"
const PROGRESS_CURRENT = 4242
const PROGRESS_TOTAL = 9191

/** Reaches the serialization only inside `artifactKeys`, and only when completed. */
const RUN_USER_ID = "user-b2d7"
const RUN_ID = "run-0001"

/** A snapshot `content_hash`: 64 lowercase hex. */
const SNAPSHOT_ID = "c" + "0".repeat(62) + "e"

/**
 * The `RunViewExtras` fixtures (Requirement 43.4): one for a run whose pinned
 * template resolved and whose latest verification passed, one for the same
 * template pin with a failing verification, and one for a run with neither —
 * the honest shape of every run this spec's own callers produce today (see
 * `app/api/runs/route.ts`), and also the honest shape of a foundation-era row
 * that pins no template version at all.
 */
const TEMPLATE_NAME = "Monthly utilization"
const TEMPLATE_VERSION = 3

const RUN_VIEW_EXTRAS_PASS: RunViewExtras = {
  templateName: TEMPLATE_NAME,
  templateVersion: TEMPLATE_VERSION,
  verificationStatus: "pass",
}

const RUN_VIEW_EXTRAS_FAIL: RunViewExtras = {
  templateName: TEMPLATE_NAME,
  templateVersion: TEMPLATE_VERSION,
  verificationStatus: "fail",
}

const RUN_VIEW_EXTRAS_UNRESOLVED: RunViewExtras = {
  templateName: null,
  templateVersion: null,
  verificationStatus: null,
}

/**
 * Typed as the inferred row, so adding a column to `report_runs` breaks this
 * fixture at `pnpm typecheck` and forces the reviewed decision Requirement 37.11
 * is after — rather than letting the new column arrive with no verdict on
 * whether it may reach the browser.
 *
 * Defaults to a mid-flight `collecting` row: non-terminal, so all three
 * in-flight progress columns carry values and `artifactKeys` is empty. The
 * terminal shapes are overridden per test.
 */
function reportRunRow(overrides: Partial<ReportRun> = {}): ReportRun {
  return {
    id: RUN_ID,
    userId: RUN_USER_ID,
    connectedSubscriptionId: "sub-0001",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    timezone: "Asia/Jakarta",
    scope: {
      resource_types: ["Microsoft.Compute/virtualMachines"],
      resource_groups: [SCOPE_MARKER],
      tag_filters: { env: "prod" },
    },
    status: "collecting",
    dedupeKey: DEDUPE_KEY,
    claimedAt: new Date("2026-08-01T03:00:05.000Z"),
    claimedBy: CLAIMED_BY,
    updatedAt: new Date("2026-08-01T03:07:30.000Z"),
    phaseDeadline: new Date("2026-08-01T03:30:00.000Z"),
    errorCode: null,
    errorMessage: null,
    progressTokenHash: PROGRESS_TOKEN_HASH,
    progressCurrent: PROGRESS_CURRENT,
    progressTotal: PROGRESS_TOTAL,
    progressLabel: PROGRESS_LABEL,
    snapshotId: null,
    resourceCount: null,
    gapCount: null,
    templateVersionId: null,
    createdAt: new Date("2026-08-01T03:00:00.000Z"),
    ...overrides,
  }
}

/** A `completed` row: terminal, so the three progress columns are cleared. */
function completedReportRunRow(overrides: Partial<ReportRun> = {}): ReportRun {
  return reportRunRow({
    status: "completed",
    claimedAt: new Date("2026-08-01T03:00:05.000Z"),
    phaseDeadline: null,
    errorCode: null,
    errorMessage: null,
    progressCurrent: null,
    progressTotal: null,
    progressLabel: null,
    snapshotId: SNAPSHOT_ID,
    resourceCount: 200,
    gapCount: 3,
    ...overrides,
  })
}

/** Requirements 37.5, 43.4 — the seventeen keys (was fourteen), sorted, spelled out. */
const RUN_VIEW_KEYS = [
  "artifactKeys",
  "connectedSubscriptionId",
  "createdAt",
  "errorCode",
  "errorMessage",
  "gapCount",
  "id",
  "periodEnd",
  "periodStart",
  "resourceCount",
  "snapshotId",
  "status",
  "templateName",
  "templateVersion",
  "timezone",
  "updatedAt",
  "verificationStatus",
]

/**
 * Requirement 37.6 — omitted under **both** spellings, for the same reason the
 * subscription guard checks both: a projection assembled by spreading a raw
 * query result would carry whichever the driver produced.
 *
 * Wider than the seven the criterion enumerates. `claimed_at` and
 * `phase_deadline` are the state machine's internals and no more the browser's
 * business than `claimed_by` is, and `user_id` is dropped **as a key** even
 * though its value reaches the serialization inside `artifactKeys` — asserted
 * precisely, below.
 */
const RUN_FORBIDDEN_KEYS = [
  "progress_token_hash",
  "progressTokenHash",
  "claimed_by",
  "claimedBy",
  "dedupe_key",
  "dedupeKey",
  "scope",
  "progress_current",
  "progressCurrent",
  "progress_total",
  "progressTotal",
  "progress_label",
  "progressLabel",
  "claimed_at",
  "claimedAt",
  "phase_deadline",
  "phaseDeadline",
  "user_id",
  "userId",
]

/** Every value Requirement 37.6's dropped columns carry in the fixture. */
const RUN_FORBIDDEN_VALUES = [
  { column: "progress_token_hash", value: PROGRESS_TOKEN_HASH },
  { column: "claimed_by", value: CLAIMED_BY },
  { column: "dedupe_key", value: DEDUPE_KEY },
  { column: "scope", value: SCOPE_MARKER },
  { column: "progress_label", value: PROGRESS_LABEL },
  { column: "progress_current", value: String(PROGRESS_CURRENT) },
  { column: "progress_total", value: String(PROGRESS_TOTAL) },
]

/**
 * Every `run_status` value, including the undriven `compiling`, `rendering` and
 * `verifying`.
 *
 * Spelled as a `Record<RunStatus, true>` rather than an array, because that is
 * the one form TypeScript checks **exhaustively**: a value added to the
 * `run_status` enum makes this literal incomplete and fails `pnpm typecheck`,
 * instead of silently leaving a status uncovered by the `artifactKeys` sweep
 * below. An array of the same strings would type-check either way.
 */
const RUN_STATUS_COVERAGE: Record<RunStatus, true> = {
  queued: true,
  claimed: true,
  collecting: true,
  compiling: true,
  rendering: true,
  verifying: true,
  completed: true,
  failed: true,
}

const ALL_RUN_STATUSES = Object.keys(RUN_STATUS_COVERAGE) as RunStatus[]

const NON_COMPLETED_RUN_STATUSES = ALL_RUN_STATUSES.filter(
  (status) => status !== "completed"
)

/** The expected key, hard-coded — the module under test is what it constrains. */
const EXPECTED_SNAPSHOT_KEY = `${RUN_USER_ID}/snapshots/${RUN_ID}/snapshot.json`

/** Ids from a realistic opaque-token alphabet, never containing a fixture value. */
const idLike = fc.string({
  unit: fc.constantFrom("a", "b", "z", "0", "7", "-"),
  minLength: 1,
  maxLength: 24,
})

// --- The projection ---------------------------------------------------------

describe("toRunView — Requirements 37.5, 37.6, 43.4", () => {
  test("carries the seventeen values the browser is allowed to see", () => {
    const view = toRunView(reportRunRow(), RUN_VIEW_EXTRAS_UNRESOLVED)

    expect(view).toEqual({
      id: RUN_ID,
      connectedSubscriptionId: "sub-0001",
      status: "collecting",
      errorCode: null,
      errorMessage: null,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      timezone: "Asia/Jakarta",
      resourceCount: null,
      gapCount: null,
      snapshotId: null,
      artifactKeys: [],
      createdAt: "2026-08-01T03:00:00.000Z",
      updatedAt: "2026-08-01T03:07:30.000Z",
      templateName: null,
      templateVersion: null,
      verificationStatus: null,
    })
  })

  test("carries a completed run's counts, snapshot id and artifact key", () => {
    const view = toRunView(completedReportRunRow(), RUN_VIEW_EXTRAS_PASS)

    expect(view).toEqual({
      id: RUN_ID,
      connectedSubscriptionId: "sub-0001",
      status: "completed",
      errorCode: null,
      errorMessage: null,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      timezone: "Asia/Jakarta",
      resourceCount: 200,
      gapCount: 3,
      snapshotId: SNAPSHOT_ID,
      // The snapshot key plus the two report keys, because this run's stored
      // verification passed — see the `artifactKeys` block below for the gate.
      artifactKeys: [
        EXPECTED_SNAPSHOT_KEY,
        reportArtifactKey(RUN_USER_ID, RUN_ID, "report.docx"),
        reportArtifactKey(RUN_USER_ID, RUN_ID, "report.pdf"),
      ],
      createdAt: "2026-08-01T03:00:00.000Z",
      updatedAt: "2026-08-01T03:07:30.000Z",
      templateName: TEMPLATE_NAME,
      templateVersion: TEMPLATE_VERSION,
      verificationStatus: "pass",
    })
  })

  test("carries a failed run's error code and message", () => {
    // `report_runs_error_code_ck` makes these two non-null exactly when the
    // status is `failed`, so both polarities are real rows rather than
    // hypotheticals.
    const view = toRunView(
      reportRunRow({
        status: "failed",
        errorCode: "EMPTY_SCOPE",
        errorMessage: "The run's union of all block scopes resolved to zero.",
        phaseDeadline: null,
        progressCurrent: null,
        progressTotal: null,
        progressLabel: null,
      }),
      RUN_VIEW_EXTRAS_UNRESOLVED
    )

    expect(view.status).toBe("failed")
    expect(view.errorCode).toBe("EMPTY_SCOPE")
    expect(view.errorMessage).toBe(
      "The run's union of all block scopes resolved to zero."
    )
    expect(view.artifactKeys).toEqual([])
  })

  test("passes the local period dates through as YYYY-MM-DD strings", () => {
    // `date` in `mode: "string"`, so there is no instant to convert. A `Date` at
    // UTC midnight would render the previous day the first time it was formatted
    // in a westward zone.
    const view = toRunView(
      reportRunRow({ periodStart: "2026-07-01", periodEnd: "2026-07-31" }),
      RUN_VIEW_EXTRAS_UNRESOLVED
    )

    expect(view.periodStart).toBe("2026-07-01")
    expect(view.periodEnd).toBe("2026-07-31")
    expect(view.timezone).toBe("Asia/Jakarta")
  })

  test("serializes createdAt and updatedAt as ISO 8601 instants in UTC", () => {
    // The same decision `secretExpiresAt` makes, for the same reason: a `Date`
    // survives a server component's props intact and becomes a string through a
    // route handler's `JSON.stringify`, so the declared type would be right on
    // one path and wrong on the other.
    const view = toRunView(reportRunRow(), RUN_VIEW_EXTRAS_UNRESOLVED)

    for (const value of [view.createdAt, view.updatedAt]) {
      expect(typeof value).toBe("string")
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    expect(new Date(view.createdAt).getTime()).toBe(
      new Date("2026-08-01T03:00:00.000Z").getTime()
    )
    expect(new Date(view.updatedAt).getTime()).toBe(
      new Date("2026-08-01T03:07:30.000Z").getTime()
    )
  })

  test("projects every run status without narrowing it", () => {
    for (const status of ALL_RUN_STATUSES) {
      const view = toRunView(
        reportRunRow(
          status === "failed"
            ? { status, errorCode: "TIMEOUT", errorMessage: "reaped" }
            : { status }
        ),
        RUN_VIEW_EXTRAS_UNRESOLVED
      )

      expect(view.status).toBe(status)
    }
  })

  test("carries a failed run's template pin and verification status independently of its own status", () => {
    // `templateName`, `templateVersion` and `verificationStatus` describe a
    // different row (or two) than `report_runs` itself, so they are not tied
    // to this row's own `status` the way `artifactKeys`' snapshot half is —
    // a `failed` run can still name the template it was pinned to and the
    // verification attempt that failed it.
    const view = toRunView(
      reportRunRow({
        status: "failed",
        errorCode: "VERIFICATION_FAILED",
        errorMessage: "The rendered document did not match the snapshot.",
      }),
      RUN_VIEW_EXTRAS_FAIL
    )

    expect(view.templateName).toBe(TEMPLATE_NAME)
    expect(view.templateVersion).toBe(TEMPLATE_VERSION)
    expect(view.verificationStatus).toBe("fail")
  })
})

// --- artifactKeys -----------------------------------------------------------

describe("artifactKeys — Requirements 37.5, 40.4", () => {
  test("the status sweep covers all eight run_status values", () => {
    // Non-vacuity for the two sweeps below.
    expect(ALL_RUN_STATUSES).toHaveLength(8)
    expect(NON_COMPLETED_RUN_STATUSES).toHaveLength(7)
    expect(ALL_RUN_STATUSES).toContain("compiling")
    expect(ALL_RUN_STATUSES).toContain("rendering")
    expect(ALL_RUN_STATUSES).toContain("verifying")
  })

  test.each(NON_COMPLETED_RUN_STATUSES)("%s names no artifact", (status) => {
    const view = toRunView(
      reportRunRow(
        status === "failed"
          ? { status, errorCode: "TIMEOUT", errorMessage: "reaped" }
          : { status }
      ),
      RUN_VIEW_EXTRAS_PASS
    )

    expect(view.artifactKeys).toEqual([])
  })

  test("completed names exactly the snapshot key, computed from the two ids", () => {
    const view = toRunView(completedReportRunRow(), RUN_VIEW_EXTRAS_UNRESOLVED)

    expect(view.artifactKeys).toEqual([EXPECTED_SNAPSHOT_KEY])
    expect(view.artifactKeys[0]).toBe(snapshotArtifactKey(RUN_USER_ID, RUN_ID))
  })

  test("the key's first segment is the actor id and its second is snapshots", () => {
    // What download authorization compares against: an exact first-segment
    // match, not a `startsWith`, so the layout has to hold segment by segment.
    const segments = toRunView(
      completedReportRunRow(),
      RUN_VIEW_EXTRAS_UNRESOLVED
    ).artifactKeys[0].split("/")

    expect(segments).toEqual([
      RUN_USER_ID,
      "snapshots",
      RUN_ID,
      SNAPSHOT_ARTIFACT_FILENAME,
    ])
  })

  test("every key is a bare S3 key, never a presigned URL", () => {
    // Requirement 37.5 — keys only. A presigned URL is short-lived and minted
    // per request, so one embedded here would be a stored credential and a stale
    // one by the time it was used.
    for (const key of toRunView(completedReportRunRow(), RUN_VIEW_EXTRAS_PASS)
      .artifactKeys) {
      expect(key).not.toContain("://")
      expect(key).not.toContain("?")
      expect(key).not.toContain("X-Amz-")
      expect(key.startsWith("/")).toBe(false)
    }
  })

  test("the key is derived from the ids, not from snapshot_id", () => {
    // The object lives at that path whatever its content hash turns out to be,
    // so the key must not vary with `snapshot_id`.
    const withHash = toRunView(
      completedReportRunRow(),
      RUN_VIEW_EXTRAS_UNRESOLVED
    )
    const withoutHash = toRunView(
      completedReportRunRow({ snapshotId: null }),
      RUN_VIEW_EXTRAS_UNRESOLVED
    )

    expect(withoutHash.artifactKeys).toEqual(withHash.artifactKeys)
    expect(withHash.artifactKeys[0]).not.toContain(SNAPSHOT_ID)
  })

  test("Requirement 40.4 — the snapshot key names an object regardless of verification status", () => {
    // The snapshot is written during collection, well before a document
    // exists to verify — see `toRunView`'s docstring on why the snapshot half
    // of this gate stays keyed on `row.status` alone, never on
    // `verificationStatus`. A `completed` snapshot-only run still names its
    // snapshot whether its verification passed, failed, or does not exist.
    for (const extras of [
      RUN_VIEW_EXTRAS_PASS,
      RUN_VIEW_EXTRAS_FAIL,
      RUN_VIEW_EXTRAS_UNRESOLVED,
    ]) {
      const view = toRunView(completedReportRunRow(), extras)

      expect(view.artifactKeys[0]).toBe(EXPECTED_SNAPSHOT_KEY)
    }
  })

  test("Requirement 40.4 — the two report keys appear only behind a passing verification", () => {
    // The composed half of the gate, implemented in the projection rather than in a
    // component: there is no shape in which a browser holds a `.docx` or `.pdf` key
    // for a run whose document was never proven, so `DownloadCard` cannot render a
    // control for one however that component is written.
    expect(
      toRunView(completedReportRunRow(), RUN_VIEW_EXTRAS_PASS).artifactKeys
    ).toEqual([
      EXPECTED_SNAPSHOT_KEY,
      reportArtifactKey(RUN_USER_ID, RUN_ID, "report.docx"),
      reportArtifactKey(RUN_USER_ID, RUN_ID, "report.pdf"),
    ])

    // A failing verification and an absent one are different facts, and neither is a
    // download. Both yield the snapshot key alone.
    for (const extras of [RUN_VIEW_EXTRAS_FAIL, RUN_VIEW_EXTRAS_UNRESOLVED]) {
      expect(toRunView(completedReportRunRow(), extras).artifactKeys).toEqual([
        EXPECTED_SNAPSHOT_KEY,
      ])
    }

    // And a passing verification on a run that is not `completed` names nothing at
    // all: the upload happens after the pass, so the objects do not exist yet.
    for (const status of ["verifying", "rendering", "failed"] as const) {
      expect(
        toRunView(reportRunRow({ status }), RUN_VIEW_EXTRAS_PASS).artifactKeys
      ).toEqual([])
    }
  })
})

// --- The guard --------------------------------------------------------------

describe("Projection_Guard — Requirements 37.5, 37.6, 37.7, 37.11, 43.4, 43.6", () => {
  test("the fixture assigns a distinct non-empty value to the three named columns", () => {
    // Requirement 37.11, asserted before anything relies on it. Every check
    // below is "this value is absent from the projection", and a check like that
    // passes trivially over an empty or duplicated value.
    const row = reportRunRow()
    const secrets = [row.progressTokenHash, row.claimedBy, row.dedupeKey]

    for (const secret of secrets) {
      expect(secret).toBeTruthy()
      expect(typeof secret).toBe("string")
    }
    expect(new Set(secrets).size).toBe(secrets.length)

    // And the remaining dropped columns carry values worth asserting absent.
    expect(row.scope.resource_groups).toContain(SCOPE_MARKER)
    expect(row.progressLabel).toBe(PROGRESS_LABEL)
    expect(row.progressCurrent).toBe(PROGRESS_CURRENT)
    expect(row.progressTotal).toBe(PROGRESS_TOTAL)
  })

  test("the projected key set is exactly the seventeen reviewed keys, as a set equality", () => {
    // Requirements 37.11, 43.4. Hard-coded above, so a newly added
    // `report_runs` column — or a newly added `RunViewExtras` field — cannot
    // reach the browser without an explicit change to that list. A set
    // equality rather than a containment check, per Requirement 43.4: `.sort()`
    // plus `toEqual` fails on an extra key exactly as it fails on a missing one.
    expect(
      Object.keys(toRunView(reportRunRow(), RUN_VIEW_EXTRAS_PASS)).sort()
    ).toEqual(RUN_VIEW_KEYS)
  })

  test("the key set is closed across every status, terminal or not, and both extras branches", () => {
    // A completed row carries three fewer values and one more artifact key. The
    // shape does not move, and neither does it move between a resolved and an
    // unresolved `RunViewExtras` (Requirement 43.4's set-equality assertion,
    // repeated over both `RunView` branches this task adds).
    for (const view of [
      toRunView(reportRunRow(), RUN_VIEW_EXTRAS_UNRESOLVED),
      toRunView(completedReportRunRow(), RUN_VIEW_EXTRAS_PASS),
      toRunView(completedReportRunRow(), RUN_VIEW_EXTRAS_FAIL),
      toRunView(
        reportRunRow({
          status: "failed",
          errorCode: "AUTH_EXPIRED",
          errorMessage: "The client secret expired.",
        }),
        RUN_VIEW_EXTRAS_UNRESOLVED
      ),
    ]) {
      expect(Object.keys(view).sort()).toEqual(RUN_VIEW_KEYS)
    }
  })

  test.each(RUN_FORBIDDEN_KEYS)(
    "%s appears in neither the key set nor the serialization",
    (key) => {
      // Requirement 37.6 — under the column name and the camel-case row name
      // alike, on a non-terminal row (where all three progress columns carry
      // values) and on a completed one.
      for (const row of [reportRunRow(), completedReportRunRow()]) {
        const view = toRunView(row, RUN_VIEW_EXTRAS_PASS)

        expect(Object.keys(view)).not.toContain(key)
        expect(JSON.stringify(view)).not.toContain(`"${key}"`)
      }
    }
  )

  test.each(RUN_FORBIDDEN_VALUES)(
    "the serialization contains no $column value",
    ({ value }) => {
      // Requirement 37.7 for `progress_token_hash`, and the same check for every
      // other column Requirement 37.6 drops.
      for (const row of [reportRunRow(), completedReportRunRow()]) {
        expect(
          JSON.stringify(toRunView(row, RUN_VIEW_EXTRAS_PASS))
        ).not.toContain(value)
      }
    }
  )

  test("Requirement 43.4 — no progress_token_hash, claimed_by or dedupe_key value on either branch", () => {
    // Requirement 43.4's own three named values, restated as a serialization
    // check independent of the key-name check above: a projection built by
    // spreading the row and then deleting keys would fail this even while
    // passing the key-name check, if a value leaked through some other field.
    for (const row of [reportRunRow(), completedReportRunRow()]) {
      for (const extras of [
        RUN_VIEW_EXTRAS_PASS,
        RUN_VIEW_EXTRAS_FAIL,
        RUN_VIEW_EXTRAS_UNRESOLVED,
      ]) {
        const serialized = JSON.stringify(toRunView(row, extras))

        expect(serialized).not.toContain(PROGRESS_TOKEN_HASH)
        expect(serialized).not.toContain(CLAIMED_BY)
        expect(serialized).not.toContain(DEDUPE_KEY)
      }
    }
  })

  test("user_id reaches the serialization only inside artifactKeys", () => {
    // The deliberate exposure, asserted precisely rather than waved at.
    //
    // `userId` is not a key of the view, but the snapshot key's **first segment
    // is the actor id** — that is what download authorization compares against,
    // so stripping it would leave a key that authorizes against nothing. It
    // discloses nothing to its recipient either: every `report_runs` read is
    // scoped by `user_id`, so the only browser holding this view is already that
    // user. What must hold is the narrow fact: nowhere else.
    const completed = toRunView(completedReportRunRow(), RUN_VIEW_EXTRAS_PASS)

    expect(JSON.stringify(completed)).toContain(RUN_USER_ID)
    expect(completed.artifactKeys[0]).toContain(RUN_USER_ID)

    // Field by field, so a failure names the key that leaked rather than only
    // reporting that the document contained the id somewhere.
    const otherFields = Object.entries(completed).filter(
      ([key]) => key !== "artifactKeys"
    )

    expect(otherFields).toHaveLength(RUN_VIEW_KEYS.length - 1)
    for (const [key, value] of otherFields) {
      expect(
        JSON.stringify(value).includes(RUN_USER_ID),
        `user_id reached the projection through ${key}`
      ).toBe(false)
    }

    // And on every other status it does not appear at all.
    for (const status of NON_COMPLETED_RUN_STATUSES) {
      const view = toRunView(
        reportRunRow(
          status === "failed"
            ? { status, errorCode: "TIMEOUT", errorMessage: "reaped" }
            : { status }
        ),
        RUN_VIEW_EXTRAS_PASS
      )

      expect(JSON.stringify(view)).not.toContain(RUN_USER_ID)
    }
  })

  test("no generated run reaches the browser with a wider shape or a secret", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_RUN_STATUSES),
        idLike,
        idLike,
        fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
        fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
        fc.constantFrom<RunViewExtras>(
          RUN_VIEW_EXTRAS_PASS,
          RUN_VIEW_EXTRAS_FAIL,
          RUN_VIEW_EXTRAS_UNRESOLVED
        ),
        (status, userId, id, resourceCount, gapCount, extras) => {
          const failed = status === "failed"
          const view = toRunView(
            reportRunRow({
              status,
              userId,
              id,
              resourceCount,
              gapCount,
              errorCode: failed ? "THROTTLED" : null,
              errorMessage: failed ? "Azure rate limits exhausted." : null,
            }),
            extras
          )
          const serialized = JSON.stringify(view)

          // The shape is closed whatever the row holds and whatever extras
          // this run resolved (Requirement 43.4).
          expect(Object.keys(view).sort()).toEqual(RUN_VIEW_KEYS)

          // Requirement 37.7, over generated rows rather than the one fixture.
          expect(serialized).not.toContain(PROGRESS_TOKEN_HASH)
          expect(serialized).not.toContain(CLAIMED_BY)
          expect(serialized).not.toContain(DEDUPE_KEY)
          expect(serialized).not.toContain(SCOPE_MARKER)
          expect(serialized).not.toContain(PROGRESS_LABEL)

          // `artifactKeys` names the snapshot exactly when the run completed,
          // regardless of `extras.verificationStatus` — see the docstring on
          // `toRunView` for why the snapshot half of this gate stays keyed on
          // `status` alone. The two **report** keys carry the second gate and
          // appear only where the stored verification passed (Requirement 40.4).
          // The templates are spelled out here rather than imported, for the same
          // reason the key set is.
          expect(view.artifactKeys).toEqual(
            status !== "completed"
              ? []
              : extras.verificationStatus === "pass"
                ? [
                    `${userId}/snapshots/${id}/snapshot.json`,
                    `${userId}/reports/${id}/report.docx`,
                    `${userId}/reports/${id}/report.pdf`,
                  ]
                : [`${userId}/snapshots/${id}/snapshot.json`]
          )
          for (const key of view.artifactKeys) {
            expect(key).not.toContain("://")
            expect(key).not.toContain("?")
          }

          // Extras pass straight through: this function does not narrow or
          // re-derive them, and the guard treats them as browser-safe by
          // construction (they name no secret column of any table).
          expect(view.templateName).toBe(extras.templateName)
          expect(view.templateVersion).toBe(extras.templateVersion)
          expect(view.verificationStatus).toBe(extras.verificationStatus)
        }
      )
    )
  })
})

// ---------------------------------------------------------------------------
// TemplateView
// ---------------------------------------------------------------------------

/**
 * The Projection_Guard for `TemplateView` (Requirements 43.4, 43.6, 43.9).
 *
 * `report_templates` carries no secret of its own, so this guard's job is
 * narrower than the two above: it closes the *shape* (Requirement 43.9's "one
 * browser-safe projection per table, no other shape") rather than keeping a
 * credential out. The one exception is `userId`, dropped here for the same
 * "the signed-in user already knows who they are" reason `RunView` drops it
 * as a key — and, unlike `RunView`, `TemplateView` has no positional key that
 * needs it, so it is absent from the serialization entirely rather than
 * appearing in one narrow, deliberate place.
 */

// --- Fixture ----------------------------------------------------------------

const TEMPLATE_USER_ID = "user-tmpl-3c91"
const TEMPLATE_ID = "tmpl-0001"
const TEMPLATE_VERSION_ID = "tmplver-0001"

/** A definition digest: 64 lowercase hex, distinct from every other fixture digest. */
const TEMPLATE_VERSION_SHA = "1" + "0".repeat(62) + "9"

/**
 * Typed as the inferred row, so adding a column to `report_templates` breaks
 * this fixture at `pnpm typecheck` and forces the reviewed decision
 * Requirement 43.9 is after.
 *
 * Defaults to a template with a current version and no draft. The
 * no-version and has-draft shapes are overridden per test.
 */
function reportTemplateRow(
  overrides: Partial<ReportTemplate> = {}
): ReportTemplate {
  return {
    id: TEMPLATE_ID,
    userId: TEMPLATE_USER_ID,
    name: "Monthly utilization",
    description: "CPU, memory, disk and network for every VM in scope.",
    currentVersionId: TEMPLATE_VERSION_ID,
    draftDefinition: null,
    seededStarterKey: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-02T00:00:00.000Z"),
    ...overrides,
  }
}

const TEMPLATE_CURRENT_VERSION: TemplateViewCurrentVersion = {
  version: 3,
  definitionSha256: TEMPLATE_VERSION_SHA,
}

/** Requirement 43.9 — the eight keys, sorted, spelled out. */
const TEMPLATE_VIEW_KEYS = [
  "createdAt",
  "currentVersion",
  "currentVersionSha256",
  "description",
  "hasDraft",
  "id",
  "name",
  "updatedAt",
]

/** Omitted under both spellings, matching the convention above. */
const TEMPLATE_FORBIDDEN_KEYS = [
  "user_id",
  "userId",
  "current_version_id",
  "currentVersionId",
  "draft_definition",
  "draftDefinition",
  "seeded_starter_key",
  "seededStarterKey",
]

// --- The projection ---------------------------------------------------------

describe("toTemplateView — Requirement 43.9", () => {
  test("carries the eight values the browser is allowed to see, with a current version", () => {
    const view = toTemplateView(reportTemplateRow(), TEMPLATE_CURRENT_VERSION)

    expect(view).toEqual({
      id: TEMPLATE_ID,
      name: "Monthly utilization",
      description: "CPU, memory, disk and network for every VM in scope.",
      currentVersion: 3,
      currentVersionSha256: TEMPLATE_VERSION_SHA,
      hasDraft: false,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    })
  })

  test("a template with no version yet carries null for both version fields", () => {
    // Before step 7 of the wizard completes: `currentVersionId` is null on the
    // row, and the caller correspondingly resolves no version to pass in.
    const view = toTemplateView(
      reportTemplateRow({ currentVersionId: null }),
      null
    )

    expect(view.currentVersion).toBeNull()
    expect(view.currentVersionSha256).toBeNull()
  })

  test("hasDraft reflects only whether draft_definition is non-null, never its content", () => {
    const withDraft = toTemplateView(
      reportTemplateRow({ draftDefinition: { blocks: ["kpi_row"] } }),
      TEMPLATE_CURRENT_VERSION
    )
    const withoutDraft = toTemplateView(
      reportTemplateRow({ draftDefinition: null }),
      TEMPLATE_CURRENT_VERSION
    )

    expect(withDraft.hasDraft).toBe(true)
    expect(withoutDraft.hasDraft).toBe(false)
    expect(JSON.stringify(withDraft)).not.toContain("kpi_row")
  })

  test("serializes createdAt and updatedAt as ISO 8601 instants in UTC", () => {
    const view = toTemplateView(reportTemplateRow(), TEMPLATE_CURRENT_VERSION)

    for (const value of [view.createdAt, view.updatedAt]) {
      expect(typeof value).toBe("string")
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })
})

// --- The guard --------------------------------------------------------------

describe("Projection_Guard — TemplateView, Requirements 43.4, 43.6, 43.9", () => {
  test("the projected key set is exactly the eight reviewed keys, as a set equality", () => {
    expect(
      Object.keys(
        toTemplateView(reportTemplateRow(), TEMPLATE_CURRENT_VERSION)
      ).sort()
    ).toEqual(TEMPLATE_VIEW_KEYS)
  })

  test("the key set is closed whether or not a version or a draft exists", () => {
    for (const view of [
      toTemplateView(reportTemplateRow(), TEMPLATE_CURRENT_VERSION),
      toTemplateView(reportTemplateRow({ currentVersionId: null }), null),
      toTemplateView(
        reportTemplateRow({ draftDefinition: { blocks: [] } }),
        TEMPLATE_CURRENT_VERSION
      ),
    ]) {
      expect(Object.keys(view).sort()).toEqual(TEMPLATE_VIEW_KEYS)
    }
  })

  test.each(TEMPLATE_FORBIDDEN_KEYS)(
    "%s appears in neither the key set nor the serialization",
    (key) => {
      const view = toTemplateView(reportTemplateRow(), TEMPLATE_CURRENT_VERSION)

      expect(Object.keys(view)).not.toContain(key)
      expect(JSON.stringify(view)).not.toContain(`"${key}"`)
    }
  )

  test("the serialization contains no user_id value and no unmasked subscription id", () => {
    // Requirement 43.6, restated for this projection: `report_templates`
    // carries a `user_id` and nothing else this spec treats as secret, so the
    // narrow claim here is that neither `TEMPLATE_USER_ID` nor the reused
    // `REALISTIC_SUBSCRIPTION_ID` fixture (a value this table has no column
    // for at all) ever appears — a template row and a subscription row share
    // no field, and this test is what makes that structural fact explicit.
    const serialized = JSON.stringify(
      toTemplateView(reportTemplateRow(), TEMPLATE_CURRENT_VERSION)
    )

    expect(serialized).not.toContain(TEMPLATE_USER_ID)
    expect(serialized).not.toContain(REALISTIC_SUBSCRIPTION_ID)
  })
})

// ---------------------------------------------------------------------------
// TemplateVersionView
// ---------------------------------------------------------------------------

/**
 * The Projection_Guard for `TemplateVersionView` (Requirement 43.5).
 */

// --- Fixture ----------------------------------------------------------------

/** A definition jsonb blob distinctive enough to prove absence rather than truncation. */
const TEMPLATE_VERSION_DEFINITION_MARKER =
  "fixture-definition-marker-block-tree"

function reportTemplateVersionRow(
  overrides: Partial<ReportTemplateVersion> = {}
): ReportTemplateVersion {
  return {
    id: TEMPLATE_VERSION_ID,
    templateId: TEMPLATE_ID,
    version: 3,
    definition: { marker: TEMPLATE_VERSION_DEFINITION_MARKER, blocks: [] },
    definitionSha256: TEMPLATE_VERSION_SHA,
    createdAt: new Date("2026-06-15T09:00:00.000Z"),
    ...overrides,
  }
}

/** Requirement 43.5 — the four keys, sorted, spelled out. */
const TEMPLATE_VERSION_VIEW_KEYS = [
  "createdAt",
  "definitionSha256",
  "id",
  "version",
]

/**
 * Requirement 43.5's "excluding every field of a connected subscription" —
 * every `ConnectedSubscriptionView`-relevant column name, under both
 * spellings, reused rather than restated so the two guards cannot silently
 * diverge on what "a connected subscription's field" means.
 */
const TEMPLATE_VERSION_FORBIDDEN_KEYS = [
  "template_id",
  "templateId",
  "definition",
  ...FORBIDDEN_KEYS,
]

// --- The projection ---------------------------------------------------------

describe("toTemplateVersionView — Requirement 43.5", () => {
  test("carries the four values the browser is allowed to see", () => {
    const view = toTemplateVersionView(reportTemplateVersionRow())

    expect(view).toEqual({
      id: TEMPLATE_VERSION_ID,
      version: 3,
      definitionSha256: TEMPLATE_VERSION_SHA,
      createdAt: "2026-06-15T09:00:00.000Z",
    })
  })

  test("serializes createdAt as an ISO 8601 instant in UTC", () => {
    const view = toTemplateVersionView(reportTemplateVersionRow())

    expect(typeof view.createdAt).toBe("string")
    expect(view.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    )
  })
})

// --- The guard --------------------------------------------------------------

describe("Projection_Guard — TemplateVersionView, Requirements 43.4, 43.5, 43.6", () => {
  test("the projected key set is exactly the four reviewed keys, as a set equality", () => {
    expect(
      Object.keys(toTemplateVersionView(reportTemplateVersionRow())).sort()
    ).toEqual(TEMPLATE_VERSION_VIEW_KEYS)
  })

  test.each(TEMPLATE_VERSION_FORBIDDEN_KEYS)(
    "%s appears in neither the key set nor the serialization",
    (key) => {
      const view = toTemplateVersionView(reportTemplateVersionRow())

      expect(Object.keys(view)).not.toContain(key)
      expect(JSON.stringify(view)).not.toContain(`"${key}"`)
    }
  )

  test("carries no field of a connected subscription, and the definition blob does not survive", () => {
    // Requirement 43.5, stated positively: a version row has no relationship
    // to a subscription at all, so every secret fixture this file defines for
    // `connected_subscriptions` is asserted absent — trivially true, and
    // asserted anyway because the interesting claim is about the shape this
    // projection is *capable* of carrying, not about today's data. The
    // definition marker proves the jsonb blob itself is dropped rather than
    // merely unlabelled.
    const serialized = JSON.stringify(
      toTemplateVersionView(reportTemplateVersionRow())
    )

    expect(serialized).not.toContain(TENANT_ID)
    expect(serialized).not.toContain(CLIENT_ID)
    expect(serialized).not.toContain(CLIENT_SECRET_ENC)
    expect(serialized).not.toContain(WORKSPACE_ID)
    expect(serialized).not.toContain(REALISTIC_SUBSCRIPTION_ID)
    expect(serialized).not.toContain(TEMPLATE_VERSION_DEFINITION_MARKER)
  })
})

// ---------------------------------------------------------------------------
// FindingView / ReplayView / DriftSampleView / VerificationView
// ---------------------------------------------------------------------------

/**
 * The Projection_Guard for `VerificationView` (Requirements 36.1, 43.4, 43.6,
 * 43.9).
 */

// --- Fixture ----------------------------------------------------------------

const VERIFICATION_ID = "verif-0001"
const VERIFICATION_RUN_ID = "run-verif-0001"
const VERIFICATION_ATTEMPT_ID = "ver_attempt_0001"
const VERIFICATION_TEMPLATE_VERSION_ID = "tmplver-verif-0001"
const VERIFICATION_ARTIFACT_KEY =
  "user-verif-0001/reports/run-verif-0001/verification-ver_attempt_0001.json"

const SNAPSHOT_SHA = "2" + "0".repeat(62) + "a"
const DOCX_SHA = "3" + "0".repeat(62) + "b"
const PDF_SHA = "4" + "0".repeat(62) + "c"

const BLOCKING_FINDING: Finding = {
  type: "table_cell_mismatch",
  severity: "blocking",
  table_id: "tbl-vm-utilization",
  row_key: "prod-web-01",
  column_key: "Average CPU",
  expected: "68.4%",
  observed: "68.5%",
}

const ADVISORY_FINDING: Finding = {
  type: "drift_observed",
  severity: "advisory",
  resource_id: "prod-web-01",
  message: "A bounded drift sample observed a changed value.",
}

function reportVerificationRow(
  overrides: Partial<ReportVerification> = {}
): ReportVerification {
  return {
    id: VERIFICATION_ID,
    runId: VERIFICATION_RUN_ID,
    attemptId: VERIFICATION_ATTEMPT_ID,
    templateVersionId: VERIFICATION_TEMPLATE_VERSION_ID,
    status: "fail",
    figureCount: 1480,
    snapshotSha256: SNAPSHOT_SHA,
    docxSha256: DOCX_SHA,
    pdfSha256: PDF_SHA,
    replay: {
      possible: true,
      recomputed_sha256: SNAPSHOT_SHA,
      stored_sha256: SNAPSHOT_SHA,
      objects_folded: 87,
      objects_named: 87,
    },
    driftSample: {
      n: 25,
      method: "document_named+top10_max+10pct",
      seed: "a3f9",
      not_requeried: [],
    },
    findings: [BLOCKING_FINDING, ADVISORY_FINDING],
    counts: { ledger_entries_checked: 1480, ledger_entries_unrendered: 1 },
    artifactKey: VERIFICATION_ARTIFACT_KEY,
    createdAt: new Date("2026-08-01T04:00:00.000Z"),
    ...overrides,
  }
}

/** Requirement 43.9 — the twelve keys, sorted, spelled out. */
const VERIFICATION_VIEW_KEYS = [
  "advisoryFindings",
  "blockingFindings",
  "counts",
  "createdAt",
  "docxSha256",
  "driftSample",
  "figureCount",
  "id",
  "pdfSha256",
  "replay",
  "snapshotSha256",
  "status",
]

/** Omitted under both spellings — see `toVerificationView`'s docstring for why each. */
const VERIFICATION_FORBIDDEN_KEYS = [
  "run_id",
  "runId",
  "attempt_id",
  "attemptId",
  "template_version_id",
  "templateVersionId",
  "artifact_key",
  "artifactKey",
  "findings",
]

// --- toFindingView -----------------------------------------------------------

describe("toFindingView — Requirement 43.9", () => {
  test("carries a blocking finding's type, severity and every locating field it declares", () => {
    const view = toFindingView(BLOCKING_FINDING)

    expect(view).toEqual({
      type: "table_cell_mismatch",
      severity: "blocking",
      tableId: "tbl-vm-utilization",
      rowKey: "prod-web-01",
      columnKey: "Average CPU",
      expected: "68.4%",
      observed: "68.5%",
    })
  })

  test("carries an advisory finding's type, severity and message, and no unset field", () => {
    const view = toFindingView(ADVISORY_FINDING)

    expect(view).toEqual({
      type: "drift_observed",
      severity: "advisory",
      resourceId: "prod-web-01",
      message: "A bounded drift sample observed a changed value.",
    })
    expect(view).not.toHaveProperty("tableId")
    expect(view).not.toHaveProperty("astPath")
  })

  test("presents a finding type the view has never been taught about, under its recorded classification", () => {
    // Requirement 39.10's forward-compatibility rule, at the shape level:
    // `findingSchema` already validates `type` as an open string (see
    // `lib/verifications/result.ts`), and this mirror must not narrow it back
    // to a closed set on the way to the browser.
    const unknownFinding: Finding = {
      type: "a_type_this_module_has_never_seen",
      severity: "blocking",
      block_id: "blk-9",
    }

    const view = toFindingView(unknownFinding)

    expect(view.type).toBe("a_type_this_module_has_never_seen")
    expect(view.severity).toBe("blocking")
    expect(view.blockId).toBe("blk-9")
  })
})

// --- toVerificationView -------------------------------------------------------

describe("toVerificationView — Requirements 36.1, 43.9", () => {
  test("carries the twelve values the browser is allowed to see", () => {
    const view = toVerificationView(reportVerificationRow())

    expect(view).toEqual({
      id: VERIFICATION_ID,
      status: "fail",
      figureCount: 1480,
      snapshotSha256: SNAPSHOT_SHA,
      docxSha256: DOCX_SHA,
      pdfSha256: PDF_SHA,
      replay: {
        possible: true,
        recomputedSha256: SNAPSHOT_SHA,
        storedSha256: SNAPSHOT_SHA,
        objectsFolded: 87,
        objectsNamed: 87,
      },
      driftSample: {
        n: 25,
        method: "document_named+top10_max+10pct",
        seed: "a3f9",
        notRequeried: [],
      },
      blockingFindings: [toFindingView(BLOCKING_FINDING)],
      advisoryFindings: [toFindingView(ADVISORY_FINDING)],
      counts: { ledger_entries_checked: 1480, ledger_entries_unrendered: 1 },
      createdAt: "2026-08-01T04:00:00.000Z",
    })
  })

  test("partitions findings by severity rather than passing one mixed list through", () => {
    const view = toVerificationView(
      reportVerificationRow({
        findings: [
          BLOCKING_FINDING,
          ADVISORY_FINDING,
          { ...BLOCKING_FINDING, table_id: "tbl-second" },
        ],
      })
    )

    expect(view.blockingFindings).toHaveLength(2)
    expect(view.advisoryFindings).toHaveLength(1)
    expect(view.advisoryFindings[0].type).toBe("drift_observed")
  })

  test("presents replay-not-possible without inventing a digest", () => {
    const view = toVerificationView(
      reportVerificationRow({
        replay: { possible: false, objects_folded: 0, objects_named: 12 },
      })
    )

    expect(view.replay.possible).toBe(false)
    expect(view.replay).not.toHaveProperty("recomputedSha256")
    expect(view.replay).not.toHaveProperty("storedSha256")
  })

  test("projects both verification statuses without narrowing them", () => {
    for (const status of ["pass", "fail"] as const) {
      const view = toVerificationView(reportVerificationRow({ status }))

      expect(view.status).toBe(status)
    }
  })

  test("serializes createdAt as an ISO 8601 instant in UTC", () => {
    const view = toVerificationView(reportVerificationRow())

    expect(typeof view.createdAt).toBe("string")
    expect(view.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    )
  })
})

// --- The guard --------------------------------------------------------------

describe("Projection_Guard — VerificationView, Requirements 36.1, 43.4, 43.6, 43.9", () => {
  test("the fixture assigns a distinct non-empty value to every dropped identifier", () => {
    // The same non-vacuity discipline as every guard above: these four values
    // are asserted absent below, so they must first be real and distinct.
    const row = reportVerificationRow()
    const dropped = [
      row.runId,
      row.attemptId,
      row.templateVersionId,
      row.artifactKey,
    ]

    for (const value of dropped) {
      expect(value).toBeTruthy()
      expect(typeof value).toBe("string")
    }
    expect(new Set(dropped).size).toBe(dropped.length)
  })

  test("the projected key set is exactly the twelve reviewed keys, as a set equality", () => {
    expect(
      Object.keys(toVerificationView(reportVerificationRow())).sort()
    ).toEqual(VERIFICATION_VIEW_KEYS)
  })

  test("the key set is closed across both statuses and a replay-not-possible row", () => {
    for (const view of [
      toVerificationView(reportVerificationRow({ status: "pass" })),
      toVerificationView(reportVerificationRow({ status: "fail" })),
      toVerificationView(
        reportVerificationRow({
          replay: { possible: false, objects_folded: 0, objects_named: 0 },
          findings: [],
        })
      ),
    ]) {
      expect(Object.keys(view).sort()).toEqual(VERIFICATION_VIEW_KEYS)
    }
  })

  test.each(VERIFICATION_FORBIDDEN_KEYS)(
    "%s appears in neither the key set nor the serialization",
    (key) => {
      const view = toVerificationView(reportVerificationRow())

      expect(Object.keys(view)).not.toContain(key)
      expect(JSON.stringify(view)).not.toContain(`"${key}"`)
    }
  )

  test.each([
    { column: "run_id", value: VERIFICATION_RUN_ID },
    { column: "attempt_id", value: VERIFICATION_ATTEMPT_ID },
    { column: "template_version_id", value: VERIFICATION_TEMPLATE_VERSION_ID },
    { column: "artifact_key", value: VERIFICATION_ARTIFACT_KEY },
  ])("the serialization contains no $column value", ({ value }) => {
    expect(
      JSON.stringify(toVerificationView(reportVerificationRow()))
    ).not.toContain(value)
  })

  test("Requirement 43.6 — the serialization carries no progress_token_hash, client-secret ciphertext or unmasked subscription id", () => {
    // `report_verifications` has no relationship to `connected_subscriptions`
    // or `report_runs`' progress machinery at all, so — as with
    // `TemplateVersionView` above — this is the structural claim made
    // explicit: every secret fixture this file defines for those two tables
    // is asserted absent from a verification-result projection too.
    const serialized = JSON.stringify(
      toVerificationView(reportVerificationRow())
    )

    expect(serialized).not.toContain(PROGRESS_TOKEN_HASH)
    expect(serialized).not.toContain(TENANT_ID)
    expect(serialized).not.toContain(CLIENT_ID)
    expect(serialized).not.toContain(CLIENT_SECRET_ENC)
    expect(serialized).not.toContain(REALISTIC_SUBSCRIPTION_ID)
  })

  test("no unbounded excerpt survives past truncation the agent already performed", () => {
    // Requirement 43.7 puts the 200-character truncation on the agent, before
    // the artifact is ever written — this projection has nothing to truncate.
    // What this guard can assert is narrower and still real: a finding
    // message at the agent's own declared bound passes through character for
    // character, unmodified by this module.
    const boundedMessage = "x".repeat(200)
    const view = toVerificationView(
      reportVerificationRow({
        findings: [
          {
            type: "prose_review_finding",
            severity: "advisory",
            message: boundedMessage,
          },
        ],
      })
    )

    expect(view.advisoryFindings[0].message).toBe(boundedMessage)
    expect(view.advisoryFindings[0].message).toHaveLength(200)
  })
})
