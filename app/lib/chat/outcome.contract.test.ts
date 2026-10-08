import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { CHART_KINDS } from "@/lib/chat/chart-data"
import { chartsFrom } from "@/lib/chat/outcome"

/**
 * The charts the runtime sends, kept whole by the app's parser.
 *
 * `agent/tests/fixtures/chat-charts/runtime-charts.json` is one chart of every kind exactly as
 * the runtime's `build_chart` emits it — `agent/tests/test_chat_charts_contract.py` fails when
 * the runtime stops producing it. This side fails when `chartsFrom` drops or reshapes any of
 * them, which is how trend, spread and stats charts were silently lost after PR #111.
 */

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
)
const FIXTURE = path.join(
  path.resolve(appRoot, ".."),
  "agent",
  "tests",
  "fixtures",
  "chat-charts",
  "runtime-charts.json"
)

const runtime = JSON.parse(readFileSync(FIXTURE, "utf8")) as readonly {
  readonly id: string
  readonly kind: string
}[]

describe("chartsFrom against the runtime's own charts", () => {
  test("the fixture holds every kind the app draws", () => {
    expect(new Set(runtime.map((chart) => chart.kind))).toEqual(
      new Set(CHART_KINDS)
    )
  })

  test.each(runtime.map((chart) => [chart.kind, chart.id, chart] as const))(
    "keeps a %s chart (%s) exactly as the runtime sent it",
    (_kind, _id, chart) => {
      expect(chartsFrom([chart])).toEqual([chart])
    }
  )
})
