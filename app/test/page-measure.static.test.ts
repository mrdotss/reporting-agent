import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const projectRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

/**
 * One decision about how wide a page is, per kind of page.
 *
 * Nine top-level containers declared three different widths — `max-w-3xl`, `max-w-5xl`,
 * `max-w-6xl` — and `globals.css` cancelled every one of them with
 * `#app-content>div{max-width:100%}`. So the app had three opinions about page width,
 * none of them in effect, and every page ran to the shell's full 1500px whatever it
 * said. The pages were not under-designed; their composition was switched off.
 *
 * `PageBody` replaces all nine. This test is what stops a tenth appearing: a page that
 * declares its own outer measure is back to having a private opinion, and the next
 * global override to "fix" the inconsistency cancels the lot again.
 *
 * The rule is about a page's OUTER container. A `max-w-prose` on a paragraph or a
 * `max-w-lg` on an empty state is a measure for one element, which is exactly what
 * those utilities are for.
 */

/**
 * A page container fills, then caps — `mx-auto`, `w-full` and a `max-w-*` together.
 * An element measure caps without filling (`mx-auto max-w-lg` on an empty state), which
 * is what `max-w-*` is for and is not what this rule is about.
 */
const OUTER_MEASURE =
  /className="(?=[^"]*\bmx-auto\b)(?=[^"]*\bw-full\b)[^"]*\bmax-w-(?!none)[\w[\]./-]+/

function pageFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(path.join(projectRoot, dir))) {
    const rel = path.posix.join(dir, entry)
    if (statSync(path.join(projectRoot, rel)).isDirectory()) {
      found.push(...pageFiles(rel))
    } else if (entry === "page.tsx") {
      found.push(rel)
    }
  }
  return found
}

describe("page width is decided once per kind", () => {
  test("no page declares its own outer measure", () => {
    const offenders: string[] = []

    for (const rel of pageFiles("app")) {
      const source = readFileSync(path.join(projectRoot, rel), "utf8")
      for (const [match] of source.matchAll(new RegExp(OUTER_MEASURE, "g"))) {
        offenders.push(`${rel}: ${match.replace('className="', "")}`)
      }
    }

    expect(offenders).toEqual([])
  })

  test("nothing re-cancels the measure from the stylesheet", () => {
    // The rule that started this. A selector reaching into the shell to reset the
    // width of whatever a page happens to render is how nine declared containers
    // became zero effective ones.
    const css = readFileSync(path.join(projectRoot, "app", "globals.css"), "utf8")
    expect(css).not.toMatch(/#app-content\s*>/)
  })

  test("both kinds are declared, and they differ", () => {
    // Two names for one behaviour would be structure pretending to be information.
    const source = readFileSync(
      path.join(projectRoot, "components", "app-shell", "page-body.tsx"),
      "utf8"
    )
    const widths = [...source.matchAll(/^\s+(reading|wide):\s*"([^"]+)"/gm)].map(
      ([, kind, width]) => [kind, width] as const
    )

    expect(widths).toHaveLength(2)
    expect(widths[0][1]).not.toEqual(widths[1][1])
  })
})
