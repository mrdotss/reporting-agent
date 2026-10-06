import { describe, expect, test } from "vitest"

import { sourceLine, traceFor, whenWib } from "@/lib/chat/trace"
import type { ChatCitation } from "@/lib/chat/views"

const base: ChatCitation = {
  fact_id: "f1",
  source: "report",
  label: "jenkins-ci · CPU p95",
  formatted: "6.2%",
}

describe("traceFor a report figure", () => {
  const citation: ChatCitation = {
    ...base,
    run_id: "run-1",
    customer_name: "FATechID",
    period_display: "August 2026",
    snapshot_path: "resources/3/statistics/0",
  }

  test("names the report, the line in it and the snapshot", () => {
    const trace = traceFor(citation, [
      {
        runId: "run-1",
        digest: "48e4a65a138a",
        verifiedAt: "2026-09-29T17:23:00Z",
      },
    ])
    expect(trace.kind).toBe("verified")
    expect(trace.badge).toBe("Verified report")
    expect(trace.steps.map((s) => s.title)).toEqual([
      "Verified report",
      "Where in the report",
      "Snapshot",
      "Re-derived before delivery",
    ])
    expect(trace.steps[0]).toMatchObject({
      detail: "FATechID · August 2026",
      mono: "verified 30 Sept, 00:23 WIB",
    })
    expect(trace.steps[1]).toMatchObject({
      detail: "jenkins-ci · CPU p95",
      mono: "resources/3/statistics/0",
    })
    expect(trace.steps[2]?.mono).toBe("48e4a65a138a")
    expect(trace.href).toBe("/reports/run-1/figures")
  })

  test("a report that is no longer attached still traces, without its digest or date", () => {
    const trace = traceFor(citation, [])
    expect(trace.steps[0]?.mono).toBeUndefined()
    expect(trace.steps[2]?.mono).toBeUndefined()
    expect(trace.href).toBe("/reports/run-1/figures")
  })

  test("with no run id there is nowhere to link", () => {
    expect(
      traceFor({ ...citation, run_id: undefined }, []).href
    ).toBeUndefined()
  })
})

describe("traceFor the other sources", () => {
  test("a live figure says it is not verified", () => {
    const trace = traceFor(
      {
        ...base,
        source: "live",
        connector_label: "hinsandbox",
        period_display: "23–30 Sep",
        collected_at: "2026-09-30T09:14:55Z",
      },
      []
    )
    expect(trace.kind).toBe("live")
    expect(trace.badge).toBe("Live · not verified")
    expect(trace.steps[0]).toMatchObject({
      detail: "hinsandbox · 23–30 Sep",
      mono: "collected 2026-09-30 09:14 UTC",
    })
    expect(trace.steps.at(-1)?.title).toBe("Not verified")
    expect(trace.href).toBeUndefined()
  })

  test("a price names its list, item and start date", () => {
    const trace = traceFor(
      {
        ...base,
        source: "price",
        price_source: "AWS Price List",
        currency: "USD",
        sku: "m5.xlarge",
        operating_system: "Linux",
        region: "us-east-1",
        unit_of_measure: "1 Hrs",
        effective_start: "2026-09-01T00:00:00Z",
      },
      []
    )
    expect(trace.badge).toBe("List price")
    expect(trace.steps[0]?.detail).toBe(
      "AWS Price List · USD · list price, pay-as-you-go"
    )
    expect(trace.steps[1]).toMatchObject({
      detail: "m5.xlarge · Linux · us-east-1",
      mono: "1 Hrs",
    })
    expect(trace.steps[2]?.detail).toBe("From 2026-09-01")
  })

  test("a saved scan names when it was scanned", () => {
    const trace = traceFor(
      { ...base, source: "scan", collected_at: "2026-09-16T04:00:00Z" },
      []
    )
    expect(trace.badge).toBe("Saved scan")
    expect(trace.steps[0]?.mono).toBe("scanned 2026-09-16")
  })

  test("no citation is unchecked, and says so", () => {
    const trace = traceFor(undefined, [])
    expect(trace.kind).toBe("unsourced")
    expect(trace.steps).toEqual([])
    expect(trace.note).toMatch(/unchecked/)
  })

  test("a source kind this page does not know is not described as verified", () => {
    expect(traceFor({ ...base, source: "mystery" }, []).kind).toBe("unsourced")
  })
})

describe("whenWib", () => {
  test("formats in Jakarta time and tolerates nothing", () => {
    expect(whenWib("2026-09-29T17:23:00Z")).toBe("30 Sept, 00:23 WIB")
    expect(whenWib(undefined)).toBe("")
    expect(whenWib("not a date")).toBe("")
  })
})

describe("sourceLine", () => {
  test("names the source in a few words", () => {
    expect(
      sourceLine({
        ...base,
        customer_name: "FATechID",
        period_display: "August 2026",
      })
    ).toBe("FATechID · August 2026")
    expect(
      sourceLine({ ...base, source: "live", connector_label: "hinsandbox" })
    ).toBe("Live pull · hinsandbox · not verified")
    expect(
      sourceLine({
        ...base,
        source: "scan",
        collected_at: "2026-09-16T04:00:00Z",
      })
    ).toBe("Saved scan · 2026-09-16")
    expect(
      sourceLine({
        ...base,
        source: "price",
        price_source: "AWS Price List",
        currency: "USD",
      })
    ).toBe("AWS Price List · USD · list price")
    expect(sourceLine(undefined)).toBe("No source recorded")
    expect(sourceLine({ ...base, source: "mystery" })).toBe("Unknown source")
  })
})
