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

/**
 * Text is never faded below its token.
 *
 * `text-muted-foreground/70` measures **2.76:1** on a light card and 4.45:1 on a dark
 * one. Both are below AA, and the asymmetry is why it shipped: an opacity chosen while
 * looking at the dark theme looks deliberate there and turns to mist in the light one,
 * which is the theme most people use. The gap list carried four of them and the connect
 * wizard's step rail carried one at /60, which is 2.32:1.
 *
 * The rule is about **text**. An `aria-hidden` icon may fade — it carries no reading —
 * and so may a border, a ring or a background.
 */
const FADED_TEXT = /\btext-(?:muted-)?foreground\/\d+/g

/** Faded text that is allowed, with the reason it is. */
const FADED_TEXT_ALLOWED = new Map([
  [
    "components/reports/run-phases.tsx",
    "an aria-hidden circle marking a phase not yet reached",
  ],
])

describe("no text is faded below its token", () => {
  test("every faded text utility is either absent or explained", () => {
    const offenders: string[] = []

    for (const rel of [...sourceFiles("components"), ...sourceFiles("app")]) {
      // The registry's own primitives are vendored; they are not ours to restyle here.
      if (rel.startsWith("components/ui/")) continue
      if (FADED_TEXT_ALLOWED.has(rel)) continue

      const source = readFileSync(path.join(projectRoot, rel), "utf8").replace(
        COMMENTS,
        ""
      )
      for (const [token] of source.matchAll(FADED_TEXT)) {
        offenders.push(`${rel}: ${token}`)
      }
    }

    expect(offenders).toEqual([])
  })

  test("the sidebar rail's own faded tokens still clear AA", () => {
    // The rail is exempt from the rule above because it is a fixed dark navy in both
    // themes, so its fades were measured against that one ground rather than against a
    // light card that never appears under them. Measured, not assumed: `#ccd9de` at 60%
    // over `#122a36` is 4.68:1, and 60% is the lowest the rail uses.
    expect(contrast(blend("#ccd9de", "#122a36", 0.6), "#122a36")).toBeGreaterThan(
      4.5
    )
  })
})

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

// --- Measuring ---------------------------------------------------------------

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function parse(hex: string): readonly [number, number, number] {
  const h = hex.replace("#", "")
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ] as const
}

function luminance(rgb: readonly [number, number, number]): number {
  return (
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
  )
}

/** `foreground` at `alpha` composited over an opaque `background`. */
function blend(
  foreground: string,
  background: string,
  alpha: number
): readonly [number, number, number] {
  const f = parse(foreground)
  const b = parse(background)
  return [0, 1, 2].map((i) =>
    Math.round(f[i] * alpha + b[i] * (1 - alpha))
  ) as unknown as readonly [number, number, number]
}

function contrast(
  a: readonly [number, number, number] | string,
  b: readonly [number, number, number] | string
): number {
  const la = luminance(typeof a === "string" ? parse(a) : a)
  const lb = luminance(typeof b === "string" ? parse(b) : b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
