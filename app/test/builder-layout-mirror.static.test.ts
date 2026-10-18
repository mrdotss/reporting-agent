import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { sectionEntry, type Provider } from "@/lib/builder/catalogue"
import { orderedSections, rankingOf, visibleLayout, type SectionV4 } from "@/lib/builder/model"

/**
 * The builder lays a v4 section out on the canvas with `lib/builder/model.ts`; the runtime
 * prints it with `compile/sections.py`'s `_v4_layout`. Both read the same cases from
 * `agent/tests/fixtures/layouts.json`, and this holds them to one answer per case.
 *
 * It runs the agent's own code rather than comparing against a stored expectation, for the
 * reason `mirror.static.test.ts` gives: two halves drifting the same way would pass a
 * manifest comparison. It fails rather than skipping when the agent environment is absent.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const agentRoot = path.resolve(appRoot, "..", "agent")
const python = path.join(agentRoot, ".venv", "bin", "python")
const script = path.join(agentRoot, "tests", "layout_corpus.py")
const casesPath = path.join(agentRoot, "tests", "fixtures", "layouts.json")

type LayoutCase = { name: string; provider: Provider; section: SectionV4 }
type OrderCase = { name: string; provider: Provider; sections: SectionV4[] }

const document = JSON.parse(readFileSync(casesPath, "utf8")) as {
  cases: LayoutCase[]
  orders: OrderCase[]
  rankings: LayoutCase[]
}
const cases = document.cases

type Readings = {
  layouts: Record<string, unknown>
  orders: Record<string, unknown>
  rankings: Record<string, unknown>
}

function runtimeReadings(): Readings {
  expect(existsSync(python), "agent/.venv is missing — from agent/: uv sync").toBe(true)
  const result = spawnSync(python, [script], {
    cwd: agentRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: path.join(agentRoot, "src") },
  })
  expect(result.status, `layout_corpus.py exited ${result.status}:\n${result.stderr}`).toBe(0)
  return JSON.parse(result.stdout) as Readings
}

const runtime = runtimeReadings()

describe("the canvas lays a section out exactly as the runtime prints it", () => {
  test("there are cases for both providers", () => {
    expect(new Set(cases.map((c) => c.provider))).toEqual(new Set(["aws", "azure"]))
  })

  test.each(cases.map((c) => [c.name, c] as const))("%s", (name, layoutCase) => {
    const entry = sectionEntry(layoutCase.provider, layoutCase.section.type)
    expect(entry, `${layoutCase.section.type} is not in the ${layoutCase.provider} catalogue`).toBeDefined()
    expect(visibleLayout(layoutCase.section, entry!)).toEqual(runtime.layouts[name])
  })
})

describe("the outline orders sections exactly as the report prints them", () => {
  test.each(document.orders.map((c) => [c.name, c] as const))("%s", (name, orderCase) => {
    const ids = orderedSections({ provider: orderCase.provider, sections: orderCase.sections }).map(
      (section) => section.id
    )
    expect(ids).toEqual(runtime.orders[name])
  })
})

describe("added metric blocks rank by what the runtime ranks by", () => {
  test.each(document.rankings.map((c) => [c.name, c] as const))("%s", (name, rankingCase) => {
    const found = rankingOf(rankingCase.section, sectionEntry(rankingCase.provider, rankingCase.section.type))
    expect(found === null ? null : [found.metric, found.statistic]).toEqual(runtime.rankings[name])
  })
})
