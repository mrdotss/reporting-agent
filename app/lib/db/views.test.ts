import fc from "fast-check"
import { describe, expect, test } from "vitest"

import {
  SNAPSHOT_ARTIFACT_FILENAME,
  SUBSCRIPTION_ID_MASK_CHAR,
  SUBSCRIPTION_ID_VISIBLE_CHARS,
  maskSubscriptionId,
  snapshotArtifactKey,
  toConnectedSubscriptionView,
  toRunView,
} from "@/lib/db/views"
import type {
  ConnectedSubscription,
  ReportRun,
  RunStatus,
} from "@/lib/db/schema"

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

/** Requirement 37.5 — the fourteen keys, sorted, spelled out. */
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
  "timezone",
  "updatedAt",
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

describe("toRunView — Requirements 37.5, 37.6", () => {
  test("carries the fourteen values the browser is allowed to see", () => {
    const view = toRunView(reportRunRow())

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
    })
  })

  test("carries a completed run's counts, snapshot id and artifact key", () => {
    const view = toRunView(completedReportRunRow())

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
      artifactKeys: [EXPECTED_SNAPSHOT_KEY],
      createdAt: "2026-08-01T03:00:00.000Z",
      updatedAt: "2026-08-01T03:07:30.000Z",
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
      })
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
      reportRunRow({ periodStart: "2026-07-01", periodEnd: "2026-07-31" })
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
    const view = toRunView(reportRunRow())

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
        )
      )

      expect(view.status).toBe(status)
    }
  })
})

// --- artifactKeys -----------------------------------------------------------

describe("artifactKeys — Requirement 37.5", () => {
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
      )
    )

    expect(view.artifactKeys).toEqual([])
  })

  test("completed names exactly the snapshot key, computed from the two ids", () => {
    const view = toRunView(completedReportRunRow())

    expect(view.artifactKeys).toEqual([EXPECTED_SNAPSHOT_KEY])
    expect(view.artifactKeys[0]).toBe(snapshotArtifactKey(RUN_USER_ID, RUN_ID))
  })

  test("the key's first segment is the actor id and its second is snapshots", () => {
    // What download authorization compares against: an exact first-segment
    // match, not a `startsWith`, so the layout has to hold segment by segment.
    const segments = toRunView(completedReportRunRow()).artifactKeys[0].split(
      "/"
    )

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
    for (const key of toRunView(completedReportRunRow()).artifactKeys) {
      expect(key).not.toContain("://")
      expect(key).not.toContain("?")
      expect(key).not.toContain("X-Amz-")
      expect(key.startsWith("/")).toBe(false)
    }
  })

  test("the key is derived from the ids, not from snapshot_id", () => {
    // The object lives at that path whatever its content hash turns out to be,
    // so the key must not vary with `snapshot_id`.
    const withHash = toRunView(completedReportRunRow())
    const withoutHash = toRunView(completedReportRunRow({ snapshotId: null }))

    expect(withoutHash.artifactKeys).toEqual(withHash.artifactKeys)
    expect(withHash.artifactKeys[0]).not.toContain(SNAPSHOT_ID)
  })
})

// --- The guard --------------------------------------------------------------

describe("Projection_Guard — Requirements 37.5, 37.6, 37.7, 37.11", () => {
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

  test("the projected key set is exactly the fourteen reviewed keys", () => {
    // Requirement 37.11. Hard-coded above, so a newly added `report_runs` column
    // cannot reach the browser without an explicit change to that list.
    expect(Object.keys(toRunView(reportRunRow())).sort()).toEqual(RUN_VIEW_KEYS)
  })

  test("the key set is closed across every status, terminal or not", () => {
    // A completed row carries three fewer values and one more artifact key. The
    // shape does not move.
    for (const view of [
      toRunView(reportRunRow()),
      toRunView(completedReportRunRow()),
      toRunView(
        reportRunRow({
          status: "failed",
          errorCode: "AUTH_EXPIRED",
          errorMessage: "The client secret expired.",
        })
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
        const view = toRunView(row)

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
        expect(JSON.stringify(toRunView(row))).not.toContain(value)
      }
    }
  )

  test("user_id reaches the serialization only inside artifactKeys", () => {
    // The deliberate exposure, asserted precisely rather than waved at.
    //
    // `userId` is not a key of the view, but the snapshot key's **first segment
    // is the actor id** — that is what download authorization compares against,
    // so stripping it would leave a key that authorizes against nothing. It
    // discloses nothing to its recipient either: every `report_runs` read is
    // scoped by `user_id`, so the only browser holding this view is already that
    // user. What must hold is the narrow fact: nowhere else.
    const completed = toRunView(completedReportRunRow())

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
        )
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
        (status, userId, id, resourceCount, gapCount) => {
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
            })
          )
          const serialized = JSON.stringify(view)

          // The shape is closed whatever the row holds.
          expect(Object.keys(view).sort()).toEqual(RUN_VIEW_KEYS)

          // Requirement 37.7, over generated rows rather than the one fixture.
          expect(serialized).not.toContain(PROGRESS_TOKEN_HASH)
          expect(serialized).not.toContain(CLAIMED_BY)
          expect(serialized).not.toContain(DEDUPE_KEY)
          expect(serialized).not.toContain(SCOPE_MARKER)
          expect(serialized).not.toContain(PROGRESS_LABEL)

          // `artifactKeys` names the snapshot exactly when the run completed,
          // and names a key rather than a URL. The template is spelled out here
          // rather than imported, for the same reason the key set is.
          expect(view.artifactKeys).toEqual(
            status === "completed"
              ? [`${userId}/snapshots/${id}/snapshot.json`]
              : []
          )
          for (const key of view.artifactKeys) {
            expect(key).not.toContain("://")
            expect(key).not.toContain("?")
          }
        }
      )
    )
  })
})
