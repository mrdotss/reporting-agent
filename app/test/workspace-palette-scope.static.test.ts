import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string) => readFileSync(path.join(projectRoot, rel), "utf8")

/**
 * The workspace palette is scoped above the portal root, and the rail is themed.
 *
 * Two failures that a rendering test cannot see, because both produce a page that
 * mounts, passes every assertion, and looks wrong.
 *
 * **The scope has to sit on `<body>`.** Radix portals every `Select`, `Dialog` and
 * `Popover` to `document.body`. A scope opened inside the shell therefore covered the
 * trigger and not the menu it opens: the control took the workspace palette while its
 * own options kept the base one, and the pair drifted apart differently in light and in
 * dark. Nothing throws; the colours are simply from two different designs.
 *
 * **The rail has to use tokens.** It is a fixed dark surface in both themes, and it was
 * written with literal hexes. Anything dropped into it that colours itself from
 * `--sidebar-foreground` — `components/app-shell/user-menu.tsx` does — then resolved
 * against the *light* theme's near-black. The signed-in address and "Sign out" rendered
 * at about 1.5:1 against the navy: present in the DOM, readable by no one.
 */
describe("the workspace palette covers what it has to cover", () => {
  test("the scope is applied on <body>, above every portal", () => {
    expect(read("app/layout.tsx")).toMatch(/<body[^>]*workspace-design/)
  })

  test("no component re-opens the scope further down", () => {
    // A second, inner scope is not additive — it is a smaller scope that looks like the
    // fix while leaving portalled content outside it.
    const inner = ["components/workspaces/workspace-shell.tsx", "app/invitations/accept/page.tsx"]
      .filter((file) => /className="[^"]*workspace-design/.test(read(file)))
    expect(inner).toEqual([])
  })

  test("the scope declares the sidebar tokens the rail and its guests read", () => {
    const css = read("app/globals.css")
    const scope = css.slice(css.indexOf(".workspace-design,"))
    for (const token of [
      "--sidebar",
      "--sidebar-foreground",
      "--sidebar-accent",
      "--sidebar-accent-foreground",
      "--sidebar-border",
    ]) {
      expect(scope, `${token} is undeclared, so the rail's contents fall back`).toContain(
        `${token}:`
      )
    }
  })

  test("the rail carries no literal colour of its own", () => {
    // Every one of these was a hex or a palette class before, which is why the rail and
    // the components inside it could disagree about what colour they were sitting on.
    const shell = read("components/workspaces/workspace-shell.tsx")
    expect(shell).not.toMatch(/#[0-9a-fA-F]{6}/)
    expect(shell).not.toMatch(/text-slate-\d|text-emerald-\d/)
    expect(shell).toMatch(/bg-sidebar\b/)
    expect(shell).toMatch(/text-sidebar-foreground/)
  })
})
