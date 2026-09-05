/**
 * Task 1.7 — reading a scan's `jsonb` columns, and the authoring-time `EMPTY_SCOPE` gate.
 *
 * The assertions that carry weight are the ones separating "absent" from "zero", in both
 * the counts and the gate. Those two are the same mistake at two scales, and the second
 * scale is the one that ships a clean, fully verified, empty report.
 */

import { describe, expect, test } from "vitest"

import {
  countsAreReported,
  mayContinue,
  readStringList,
  readRegionProbes,
  readTypeCounts,
  refusedRegions,
  scanGate,
} from "@/lib/scans/view"

const complete = (resourceCount: number | null) => ({
  status: "complete",
  resourceCount,
  errorCode: null,
})

describe("readTypeCounts", () => {
  test("reads a well-formed count map", () => {
    expect(readTypeCounts({ "microsoft.compute/virtualmachines": 3 })).toEqual({
      "microsoft.compute/virtualmachines": 3,
    })
  })

  test.each([
    ["a negative count", { vms: -1 }],
    ["a fractional count", { vms: 1.5 }],
    ["a string count", { vms: "3" }],
    ["a null count", { vms: null }],
    ["a boolean count", { vms: true }],
  ])("drops %s rather than reading it as a number", (_label, value) => {
    // An unreadable count is ABSENT, not zero. The agent's own `read_counts` skips such a
    // row for the same reason: a type present with an unreadable count is not a type with
    // no resources, and rendering them identically would state something the data does not.
    expect(readTypeCounts(value)).toEqual({})
  })

  test.each([null, undefined, 42, "counts", []])(
    "a wholly unusable column (%o) reads as empty rather than throwing",
    (value) => {
      expect(readTypeCounts(value)).toEqual({})
    }
  )

  test("zero is a legitimate count and is kept", () => {
    // Distinct from the cases above: zero is a NUMBER the writer chose, not an unreadable
    // value. Dropping it would erase a type the scan deliberately reported as empty.
    expect(readTypeCounts({ vms: 0 })).toEqual({ vms: 0 })
  })
})

describe("readStringList", () => {
  test("reads a list of strings", () => {
    expect(readStringList(["southeastasia", "indonesiacentral"])).toEqual([
      "southeastasia",
      "indonesiacentral",
    ])
  })

  test.each([null, undefined, {}, "southeastasia", [1, 2]])(
    "an unusable column (%o) reads as empty",
    (value) => {
      expect(readStringList(value)).toEqual([])
    }
  )
})

describe("countsAreReported — whether any figure is a statement", () => {
  test("reports the counts of a completed scan", () => {
    expect(countsAreReported({ status: "complete" })).toBe(true)
  })

  test("reports nothing when no scan has been taken", () => {
    expect(countsAreReported(null)).toBe(false)
  })

  test("reports nothing for a failed scan", () => {
    // The defect: a failed scan stores a row with no counts, and the page rendered those
    // empty defaults as "0 types, 0 regions, 0 resource groups" — a claim about the
    // subscription that no scan supports. A Resource Graph 400 produced exactly that, and
    // it read as an empty estate.
    expect(countsAreReported({ status: "failed" })).toBe(false)
  })

  test("reports nothing for a scan still in flight", () => {
    for (const status of ["queued", "running", "pending", ""]) {
      expect(countsAreReported({ status })).toBe(false)
    }
  })

  test("agrees with the gate: only a scan the gate can call ready or empty reports", () => {
    // The two answer different questions, so they may disagree — but not about whether the
    // scan finished. A `running` or `failed` gate must never sit beside reported counts.
    for (const scan of [
      { status: "complete", resourceCount: 23, errorCode: null },
      { status: "complete", resourceCount: 0, errorCode: null },
      { status: "complete", resourceCount: null, errorCode: null },
      { status: "failed", resourceCount: null, errorCode: "SCOPE_UNVERIFIED" },
      { status: "running", resourceCount: null, errorCode: null },
    ]) {
      const gate = scanGate(scan)
      if (gate.kind === "ready" || gate.kind === "empty") {
        expect(countsAreReported(scan)).toBe(true)
      }
      if (gate.kind === "failed") expect(countsAreReported(scan)).toBe(false)
    }
  })
})

describe("scanGate — the authoring-time EMPTY_SCOPE gate", () => {
  test("a complete scan with resources is ready", () => {
    expect(scanGate(complete(23))).toEqual({ kind: "ready" })
    expect(mayContinue(scanGate(complete(23)))).toBe(true)
  })

  test("a complete scan with zero resources refuses to continue", () => {
    // The whole point. `azure-integration.md`: zero resources means zero figures, which
    // means zero UNVERIFIABLE figures, so the run passes collection, compilation, rendering
    // AND verification and delivers a clean, fully verified, empty report. Requirement 4.9
    // moves that refusal forward to authoring, where the cause — wrong subscription, a role
    // assignment too narrow — is still in front of the person who can fix it.
    expect(scanGate(complete(0))).toEqual({ kind: "empty" })
    expect(mayContinue(scanGate(complete(0)))).toBe(false)
  })

  test("an ABSENT count is running, not empty", () => {
    // The distinction that decides whether an in-flight scan is refused. `null` means the
    // scan has not answered yet; treating it as zero would refuse to continue from a scan
    // that is merely slow, and would train the author to ignore the refusal.
    expect(scanGate(complete(null))).toEqual({ kind: "running" })
    expect(mayContinue(scanGate(complete(null)))).toBe(false)
  })

  test.each(["queued", "running"])("a %s scan is not yet a verdict", (status) => {
    expect(scanGate({ status, resourceCount: null, errorCode: null })).toEqual({
      kind: "running",
    })
  })

  test("a failed scan carries its code so the screen can say what to fix", () => {
    expect(
      scanGate({ status: "failed", resourceCount: null, errorCode: "SCOPE_UNVERIFIED" })
    ).toEqual({ kind: "failed", code: "SCOPE_UNVERIFIED" })
  })

  test("a failed scan with resources counted is still failed", () => {
    // Order matters: a scan that collected something and then failed must not present as
    // ready just because a count survived. The failure is the more important fact.
    expect(
      scanGate({ status: "failed", resourceCount: 12, errorCode: "THROTTLED" })
    ).toEqual({ kind: "failed", code: "THROTTLED" })
  })

  test("a negative count is refused rather than read as resources present", () => {
    expect(scanGate(complete(-1))).toEqual({ kind: "empty" })
  })

  test("only 'ready' permits continuing", () => {
    const gates = [
      scanGate(complete(0)),
      scanGate(complete(null)),
      scanGate({ status: "failed", resourceCount: null, errorCode: null }),
      scanGate({ status: "queued", resourceCount: null, errorCode: null }),
    ]

    expect(gates.filter(mayContinue)).toEqual([])
  })
})

describe("readRegionProbes / refusedRegions", () => {
  const probe = (over: Record<string, unknown> = {}) => ({
    region: "southeastasia",
    status_code: 200,
    verdict: "reachable",
    probed_at: "2026-08-26T00:00:00Z",
    ...over,
  })

  test("reads the agent's recorded shape", () => {
    expect(readRegionProbes([probe()])).toEqual([
      {
        region: "southeastasia",
        statusCode: 200,
        verdict: "reachable",
        probedAt: "2026-08-26T00:00:00Z",
      },
    ])
  })

  test("a null status code is kept — a DNS failure has no server to answer", () => {
    expect(readRegionProbes([probe({ status_code: null, verdict: "refused" })])[0]).toEqual({
      region: "southeastasia",
      statusCode: null,
      verdict: "refused",
      probedAt: "2026-08-26T00:00:00Z",
    })
  })

  test("an unrecognised verdict is dropped rather than coerced to unknown", () => {
    // Coercing would present a guess as an observation. An unrecognised verdict means this
    // reader and the writer disagree about the vocabulary; the honest outcome is that the
    // region is not mentioned.
    expect(readRegionProbes([probe({ verdict: "probably_fine" })])).toEqual([])
  })

  test.each([null, undefined, {}, "probes", [null], [{}]])(
    "an unusable column (%o) reads as no probes",
    (value) => {
      expect(readRegionProbes(value)).toEqual([])
    }
  )

  test("only refused regions are surfaced as problems — never 'unknown'", () => {
    // Requirement 5.4 lets the screen state a risk for a region recorded fallback-only. A
    // probe that could not complete recorded no such thing, and listing it beside genuine
    // refusals would turn "we did not find out" into "we found a problem".
    const probes = readRegionProbes([
      probe({ region: "southeastasia", verdict: "reachable" }),
      probe({ region: "indonesiacentral", verdict: "refused", status_code: 403 }),
      probe({ region: "australiaeast", verdict: "unknown", status_code: null }),
    ])

    expect(refusedRegions(probes).map((p) => p.region)).toEqual(["indonesiacentral"])
  })
})
