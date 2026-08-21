import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

import {
  MESSAGE_CATALOG,
  MESSAGE_ID_PATTERN,
  isMessageId,
  messageText,
} from "@/lib/messages/catalog"
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  isLanguage,
} from "@/lib/messages/language"

/**
 * The message-catalog mirror guard (Requirements 15.2, 15.5, 15.10).
 *
 * One catalog, two languages, two halves. `app/lib/messages/catalog.ts` and
 * `agent/src/reporting_agent/messages/catalog.v1.json` each declare the same map,
 * and this reads both and compares them.
 *
 * ## Why the comparison goes further than the event mirror's
 *
 * The event mirror compares two **id sets** and stops, because an event type is
 * only ever a name. A message id has a *value*, and two halves agreeing about the
 * ids while disagreeing about one string is the failure that actually costs
 * something: the document would carry one heading and the interface another, for
 * the same run, with nothing red anywhere. So this asserts **value equality for
 * every shared id** as well.
 *
 * ## It parses neither language
 *
 * The agent's half is JSON, so it is read and `JSON.parse`d — data, not source.
 * The app's half is *imported*, which yields the real object with the real values
 * and needs no TypeScript parser. Between them there is no third grammar for a
 * guard to get wrong, which is the same reasoning the event mirror records for
 * its sentinel-delimited literal scan.
 *
 * The sentinels are still asserted, for a different reason: they mark which block
 * is mirrored, and {@link test:every id is declared inside the mirrored block}
 * fails if an id is added to the module outside it. Without that, the map could
 * grow a second declaration site that the sentinel convention says is not
 * mirrored and the guard would still pass.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
/** The monorepo root — `agent/` is a sibling of `app/`. */
const repoRoot = path.resolve(appRoot, "..")

const TS_DECLARATION = path.join(appRoot, "lib", "messages", "catalog.ts")
const JSON_DECLARATION = path.join(
  repoRoot,
  "agent",
  "src",
  "reporting_agent",
  "messages",
  "catalog.v1.json"
)
const PY_LANGUAGES = path.join(
  repoRoot,
  "agent",
  "src",
  "reporting_agent",
  "messages",
  "__init__.py"
)

const BEGIN_SENTINEL = "--- BEGIN MESSAGE CATALOG"
const END_SENTINEL = "--- END MESSAGE CATALOG"

function read(absolutePath: string): string {
  expect(
    existsSync(absolutePath),
    `${path.relative(repoRoot, absolutePath)} is missing`
  ).toBe(true)
  return readFileSync(absolutePath, "utf8")
}

type LanguageMap = Record<string, Record<string, string>>

/** The agent's declaration, read from disk as data. */
function agentCatalog(): LanguageMap {
  const parsed = JSON.parse(read(JSON_DECLARATION)) as {
    schema_version?: string
    messages?: LanguageMap
  }
  expect(
    parsed.schema_version,
    "the agent's catalog declares no schema_version"
  ).toBeTruthy()
  const messages = parsed.messages ?? {}
  expect(
    Object.keys(messages).length,
    "the agent's catalog declares no message, so every comparison below is vacuous"
  ).toBeGreaterThan(0)
  return messages
}

/** The lines of the app's declaration between the two sentinels. */
function mirroredBlock(): string {
  const where = path.relative(repoRoot, TS_DECLARATION)
  const lines = read(TS_DECLARATION).split("\n")
  const begin = lines.findIndex((line) => line.includes(BEGIN_SENTINEL))
  const end = lines.findIndex((line) => line.includes(END_SENTINEL))

  expect(
    begin,
    `${where} carries no ${BEGIN_SENTINEL} sentinel`
  ).toBeGreaterThan(-1)
  expect(end, `${where} carries no ${END_SENTINEL} sentinel`).toBeGreaterThan(
    -1
  )
  expect(end, `${where}'s sentinels are out of order`).toBeGreaterThan(begin)
  const block = lines.slice(begin + 1, end)
  expect(
    block.length,
    `${where}'s mirrored block is empty, so this guard would pass by finding nothing`
  ).toBeGreaterThan(0)
  return block.join("\n")
}

describe("the two halves declare one catalog", () => {
  test("neither half is empty", () => {
    expect(Object.keys(MESSAGE_CATALOG).length).toBeGreaterThan(0)
    expect(Object.keys(agentCatalog()).length).toBeGreaterThan(0)
  })

  test("the id sets are equal, naming every id present in one half only", () => {
    const app = new Set(Object.keys(MESSAGE_CATALOG))
    const agent = new Set(Object.keys(agentCatalog()))

    const appOnly = [...app].filter((id) => !agent.has(id)).sort()
    const agentOnly = [...agent].filter((id) => !app.has(id)).sort()

    expect(
      appOnly,
      "these ids are declared in app/lib/messages/catalog.ts and not in the agent's " +
        "catalog, so the agent would fail to resolve them"
    ).toEqual([])
    expect(
      agentOnly,
      "these ids are declared in the agent's catalog and not in " +
        "app/lib/messages/catalog.ts, so the app cannot present them"
    ).toEqual([])
  })

  test("every shared id carries identical copy in both halves", () => {
    const agent = agentCatalog()
    const divergent: string[] = []

    for (const [id, values] of Object.entries(MESSAGE_CATALOG)) {
      const other = agent[id]
      if (other === undefined) continue
      for (const language of LANGUAGES) {
        if (values[language] !== other[language]) {
          divergent.push(
            `${id}[${language}]: app ${JSON.stringify(values[language])} vs ` +
              `agent ${JSON.stringify(other[language])}`
          )
        }
      }
    }

    expect(
      divergent,
      "a diverging value puts one string in the delivered document and a different " +
        "one in the interface presenting that same run, with nothing red anywhere"
    ).toEqual([])
  })

  test("every id carries a non-empty value in every declared language", () => {
    const missing: string[] = []
    for (const [id, values] of Object.entries(MESSAGE_CATALOG)) {
      for (const language of LANGUAGES) {
        if (!values[language]?.trim()) missing.push(`${id}[${language}]`)
      }
    }

    expect(missing).toEqual([])
  })

  test("every id is declared inside the mirrored block", () => {
    const block = mirroredBlock()
    const outside = Object.keys(MESSAGE_CATALOG).filter(
      (id) => !block.includes(`"${id}"`)
    )

    expect(
      outside,
      "these ids are exported but declared outside the sentinel block, so the " +
        "convention that says which region is mirrored no longer holds for them"
    ).toEqual([])
  })
})

describe("the id namespace", () => {
  test("every declared id is in the namespace", () => {
    const offenders = Object.keys(MESSAGE_CATALOG).filter(
      (id) => !MESSAGE_ID_PATTERN.test(id)
    )

    expect(offenders).toEqual([])
  })

  test("the pattern mirrors the agent's, character for character", () => {
    // The agent declares it as a string so both halves can compile the identical
    // source. Compared here rather than assumed, because a namespace that differed
    // between the halves would admit an id in one and reject it in the other.
    const declared = read(PY_LANGUAGES)
    const match = declared.match(
      /MESSAGE_ID_PATTERN: Final\[str\] = r"([^"]+)"/
    )

    expect(match, "the agent declares no MESSAGE_ID_PATTERN").not.toBeNull()
    expect(MESSAGE_ID_PATTERN.source).toBe(match?.[1])
  })

  test("only the three declared prefixes are used", () => {
    const prefixes = new Set(
      Object.keys(MESSAGE_CATALOG).map((id) => id.split(".")[0])
    )

    expect([...prefixes].sort()).toEqual(["chart", "doc", "ui"])
  })

  test("both halves resolve the ui prefix and the agent resolves doc and chart", () => {
    // Not an assertion about ownership — both halves declare everything. It is an
    // assertion that the app actually has `ui.` ids to resolve, so a catalog that
    // lost them all would fail here rather than presenting an interface of blanks.
    const ids = Object.keys(MESSAGE_CATALOG)

    expect(ids.filter((id) => id.startsWith("ui.")).length).toBeGreaterThan(0)
    expect(ids.filter((id) => id.startsWith("doc.")).length).toBeGreaterThan(0)
    expect(ids.filter((id) => id.startsWith("chart.")).length).toBeGreaterThan(
      0
    )
  })
})

describe("the languages mirror", () => {
  test("the declared languages match the agent's", () => {
    const declared = read(PY_LANGUAGES)
    const match = declared.match(
      /DECLARED_LANGUAGES: Final\[tuple\[str, \.\.\.\]\] = \(([^)]*)\)/
    )
    expect(match, "the agent declares no DECLARED_LANGUAGES").not.toBeNull()

    const agentLanguages = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (found) => found[1]
    )

    expect(agentLanguages).toEqual([...LANGUAGES])
  })

  test("the default language matches the agent's", () => {
    const declared = read(PY_LANGUAGES)
    const match = declared.match(/DEFAULT_LANGUAGE: Final\[str\] = "([^"]+)"/)

    expect(match?.[1]).toBe(DEFAULT_LANGUAGE)
  })

  test("isLanguage narrows to the declared set only", () => {
    expect(isLanguage("en")).toBe(true)
    expect(isLanguage("id")).toBe(true)
    expect(isLanguage("fr")).toBe(false)
    expect(isLanguage(undefined)).toBe(false)
  })
})

describe("resolution", () => {
  test("a declared id resolves in both languages", () => {
    expect(messageText("ui.download.pdf", "en")).toBe("Download PDF")
    expect(messageText("ui.download.pdf", "id")).toBe("Unduh PDF")
  })

  test("the two languages are different copy for a translated id", () => {
    expect(messageText("ui.download.pdf", "en")).not.toBe(
      messageText("ui.download.pdf", "id")
    )
  })

  test("the template placeholder task 12.7 needs is declared", () => {
    // Added in this task rather than in 12.7, because the template list presents it
    // wherever `report_templates.name` is absent or empty and the mirror has to carry
    // it before that list can resolve it.
    expect(messageText("ui.template.untitled_placeholder", "en")).toBe(
      "Untitled template"
    )
    expect(messageText("ui.template.untitled_placeholder", "id")).toBeTruthy()
  })

  test("isMessageId rejects an undeclared id", () => {
    expect(isMessageId("ui.download.pdf")).toBe(true)
    expect(isMessageId("ui.download.absent")).toBe(false)
    expect(isMessageId(42)).toBe(false)
  })
})
