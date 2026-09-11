import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const projectRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

/**
 * The sidebar tokens belong to the navigation rail, and nowhere else.
 *
 * `--sidebar` is **a dark navy in both themes** — that is the design, stated twice in
 * `globals.css` on purpose. It follows that `bg-sidebar` on a content surface is a dark
 * slab dropped into a light page, and it does not announce itself: the element renders,
 * the tests pass, the layout is right, and the panel is simply the wrong colour with its
 * `text-muted-foreground` labels sitting on it at roughly 2:1.
 *
 * That is exactly what step 4's front matter panel did (`bg-sidebar/50`) and what the
 * block palette did (`bg-sidebar`). Neither was visible in the dark theme, where a dark
 * panel on a dark page looks deliberate — so it shipped.
 *
 * A content surface takes `bg-card`, `bg-muted` or `bg-background`. The rail takes the
 * sidebar set. This test is the boundary between the two.
 *
 * **What stays allowed anywhere:** `dark:text-sidebar-primary`. It is dark-scoped and
 * foreground-only — the mint accent against the dark theme's own ground — so it never
 * puts rail chrome on a light page.
 */

const RAIL_FILES = new Set([
  "components/app-shell/sidebar.tsx",
  "components/app-shell/user-menu.tsx",
  "components/app-shell/theme-toggle.tsx",
  "components/workspaces/workspace-shell.tsx",
])

/** Every sidebar utility, with whatever variant chain precedes it. */
const RAIL_TOKEN = /(?:[a-z0-9-]+:)*(?:bg|text|border|ring|from|to)-sidebar[\w/-]*/g

/** Line and block comments — this file's own prose names the tokens it forbids. */
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g

/**
 * Whether a matched utility is one a content component may carry.
 *
 * Exactly one shape is: a `dark:`-scoped foreground. `dark:text-sidebar-primary` is the
 * mint accent read against the dark theme's own ground, which is a colour choice rather
 * than a piece of rail chrome. A background or a border is never allowed, dark-scoped or
 * not, because `--sidebar` is the same dark navy in both themes.
 */
function permittedOutsideRail(token: string): boolean {
  const utility = token.slice(token.lastIndexOf(":") + 1)
  return token.includes("dark:") && utility.startsWith("text-sidebar")
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(path.join(projectRoot, dir))) {
    if (entry === "node_modules" || entry === ".next") continue
    const rel = path.posix.join(dir, entry)
    if (statSync(path.join(projectRoot, rel)).isDirectory()) {
      found.push(...sourceFiles(rel))
    } else if (entry.endsWith(".tsx") && !entry.includes(".test.")) {
      found.push(rel)
    }
  }
  return found
}

describe("rail tokens stay on the rail", () => {
  test("no content component paints itself with the sidebar palette", () => {
    const offenders: string[] = []

    for (const rel of [...sourceFiles("components"), ...sourceFiles("app")]) {
      if (RAIL_FILES.has(rel)) continue
      const source = readFileSync(path.join(projectRoot, rel), "utf8").replace(
        COMMENTS,
        ""
      )
      for (const [token] of source.matchAll(RAIL_TOKEN)) {
        if (permittedOutsideRail(token)) continue
        offenders.push(`${rel}: ${token}`)
      }
    }

    expect(offenders).toEqual([])
  })

  test("the rail files this test exempts all still exist", () => {
    // An allowlist entry for a deleted file is an exemption nobody can see is dead.
    for (const rel of RAIL_FILES) {
      expect(() => statSync(path.join(projectRoot, rel))).not.toThrow()
    }
  })
})
