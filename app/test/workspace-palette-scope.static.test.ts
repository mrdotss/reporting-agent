import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const projectRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
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
    const inner = [
      "components/workspaces/workspace-shell.tsx",
      "app/invitations/accept/page.tsx",
    ].filter((file) => /className="[^"]*workspace-design/.test(read(file)))
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
      expect(
        scope,
        `${token} is undeclared, so the rail's contents fall back`
      ).toContain(`${token}:`)
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

/**
 * The document preview persists across steps.
 *
 * It used to be mounted inside the Review step, which meant it unmounted on every step
 * change. A real preview is a `python-docx` render, a LibreOffice conversion and an
 * upload — measured in seconds, not milliseconds — so a preview thrown away on
 * navigation was only ever useful on the step that paid for it, and the consultant chose
 * sections and appearance without ever seeing the page they affect.
 *
 * Mounting it in the shell is what makes it survive. That is a structural property, not a
 * visual one: a rendering test of any single step passes either way.
 */
describe("the document preview outlives the step that rendered it", () => {
  test("the wizard mounts it, not a step", () => {
    const shell = read("components/templates/wizard-shell.tsx")
    expect(shell).toMatch(/<RealPreviewPanel/)
    expect(read("components/templates/step-preview.tsx")).not.toMatch(
      /<RealPreviewPanel/
    )
  })

  test("it is mounted outside the step switch, so navigating keeps it alive", () => {
    // `renderStep` is the switch. Anything mounted inside it is remounted per step.
    const shell = read("components/templates/wizard-shell.tsx")
    const switchStart = shell.indexOf("function renderStep(")
    expect(switchStart).toBeGreaterThan(-1)
    expect(shell.slice(switchStart)).not.toMatch(/<RealPreviewPanel/)
  })

  test("Identity is the one step without it", () => {
    // A name and a customer describe no page yet, so there is nothing to show.
    expect(read("components/templates/wizard-shell.tsx")).toMatch(
      /showsPreview = step\.id !== "identity"/
    )
  })

  test("the retired live specimens are gone, not merely unmounted", () => {
    const design = read("components/templates/step-design.tsx")
    expect(design).not.toMatch(/LiveThemePreview/)
    expect(() => read("components/templates/live-theme-preview.tsx")).toThrow()
  })
})
